"""Player extensions: Spotify match search and single-track server download."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import core.dependencies as deps
from api.compat.subsonic.parameters import SubsonicParameters
from api.compat.subsonic.router import _HANDLERS, Ctx
from services.native.download_service import ALREADY_IN_LIBRARY


def _ctx(params: dict[str, str], overrides: dict | None = None) -> Ctx:
    values = {k: [v] for k, v in params.items()}
    services = SimpleNamespace(
        preferences=SimpleNamespace(
            get_connect_apps_settings=lambda: SimpleNamespace(
                advertise_server_name="Test"
            )
        ),
        version=SimpleNamespace(
            get_current_version=lambda: SimpleNamespace(version="dev")
        ),
    )
    return Ctx(
        request=SimpleNamespace(  # type: ignore[arg-type]
            app=SimpleNamespace(dependency_overrides=overrides or {})
        ),
        endpoint_name="test",
        params=values,
        decoded=SubsonicParameters(values),
        user=SimpleNamespace(id="u1", role="user"),
        fmt="json",
        callback=None,
        services=services,  # type: ignore[arg-type]
    )


def _body(response) -> dict:
    return json.loads(response.body)["subsonic-response"]


@pytest.fixture
def spotify(monkeypatch):
    svc = SimpleNamespace(
        search_catalog_tracks=AsyncMock(
            return_value=[
                {
                    "id": "sp1",
                    "title": "Song",
                    "artist": "Artist",
                    "album": "Album",
                    "cover_url": "https://i.scdn.co/image/x",
                    "duration_ms": 201_400,
                }
            ]
        ),
        resolve_track_for_download=AsyncMock(
            return_value={
                "recording_mbid": "rec",
                "release_group_mbid": "rg",
                "artist_name": "Artist",
                "track_title": "Song",
                "album_title": "Album",
                "duration_seconds": 201,
            }
        ),
        get_catalog_track=AsyncMock(return_value={}),
    )
    acquisition = SimpleNamespace(request_track=AsyncMock(return_value="task-1"))
    quota = SimpleNamespace(check_request_quota=AsyncMock())
    monkeypatch.setattr(deps, "get_spotify_import_service", lambda: svc)
    monkeypatch.setattr(deps, "get_acquisition_dispatcher", lambda: acquisition)
    monkeypatch.setattr(deps, "get_quota_service", lambda: quota)
    return SimpleNamespace(svc=svc, acquisition=acquisition, quota=quota)


@pytest.mark.asyncio
async def test_search_spotify_tracks_returns_matches(spotify):
    response = await _HANDLERS["searchspotifytracks"](
        _ctx({"query": "Artist Song", "count": "5"})
    )
    body = _body(response)
    assert body["status"] == "ok"
    assert body["spotifyTracks"]["track"] == [
        {
            "id": "sp1",
            "title": "Song",
            "artist": "Artist",
            "album": "Album",
            "coverUrl": "https://i.scdn.co/image/x",
            "duration": 201,
        }
    ]
    spotify.svc.search_catalog_tracks.assert_awaited_once_with("Artist Song", limit=5)


@pytest.mark.asyncio
async def test_request_spotify_download_accepts_player_song_id(spotify):
    response = await _HANDLERS["requestspotifydownload"](_ctx({"id": "st-sp1"}))
    body = _body(response)
    assert body["spotifyDownload"] == {"status": "queued", "taskId": "task-1"}
    spotify.quota.check_request_quota.assert_awaited_once_with("u1", "user")
    spotify.svc.resolve_track_for_download.assert_awaited_once_with("sp1")
    kwargs = spotify.acquisition.request_track.await_args.kwargs
    assert kwargs["recording_mbid"] == "rec"
    assert kwargs["user_id"] == "u1"


@pytest.mark.asyncio
async def test_request_spotify_download_reports_already_in_library(spotify):
    spotify.acquisition.request_track.return_value = ALREADY_IN_LIBRARY
    response = await _HANDLERS["requestspotifydownload"](_ctx({"id": "sp1"}))
    assert _body(response)["spotifyDownload"] == {"status": "already_in_library"}


@pytest.mark.asyncio
async def test_request_spotify_download_uses_app_provider_overrides(spotify):
    """The target app overrides the legacy acquisition dispatcher; a direct call
    to the legacy getter would import into the wrong library."""
    target = SimpleNamespace(request_track=AsyncMock(return_value="task-target"))
    response = await _HANDLERS["requestspotifydownload"](
        _ctx(
            {"id": "sp1"},
            overrides={deps.get_acquisition_dispatcher: lambda: target},
        )
    )
    assert _body(response)["spotifyDownload"]["taskId"] == "task-target"
    spotify.acquisition.request_track.assert_not_awaited()


# ---- removeLibraryTrack / removeLibraryAlbum -----------------------------------


def _as(role: str, params: dict[str, str], overrides: dict) -> Ctx:
    ctx = _ctx(params, overrides)
    ctx.user = SimpleNamespace(id="u1", role=role)
    return ctx


@pytest.mark.asyncio
async def test_remove_library_track_requires_curator():
    from core.exceptions import SubsonicError

    with pytest.raises(SubsonicError) as exc:
        await _HANDLERS["removelibrarytrack"](_as("user", {"id": "tr-t1"}, {}))
    assert exc.value.code == 50


@pytest.mark.asyncio
async def test_remove_library_track_removes_through_writer():
    writer = SimpleNamespace(remove_track=AsyncMock(return_value=["t1"]))
    response = await _HANDLERS["removelibrarytrack"](
        _as(
            "trusted",
            {"id": "tr-t1"},
            {deps.get_target_catalog_writer_service: lambda: writer},
        )
    )
    assert _body(response)["libraryRemoval"] == {"removedSongId": ["tr-t1"]}
    writer.remove_track.assert_awaited_once_with(
        "t1", actor_user_id="u1", is_admin=False
    )


@pytest.mark.asyncio
async def test_remove_library_album_is_admin_only():
    from core.exceptions import SubsonicError

    with pytest.raises(SubsonicError) as exc:
        await _HANDLERS["removelibraryalbum"](_as("trusted", {"id": "al-a1"}, {}))
    assert exc.value.code == 50


@pytest.mark.asyncio
async def test_remove_library_album_deletes_files_and_settles_wanted():
    writer = SimpleNamespace(
        provider_release_group_id=AsyncMock(return_value="rg1"),
        remove_album=AsyncMock(return_value=["t1", "t2"]),
    )
    wanted = SimpleNamespace(
        stop_after_library_removal=AsyncMock(),
        continue_after_library_removal=AsyncMock(),
    )
    downloads = SimpleNamespace(purge_album_downloads=AsyncMock())
    response = await _HANDLERS["removelibraryalbum"](
        _as(
            "admin",
            {"id": "al-a1", "stopWanted": "false"},
            {
                deps.get_target_catalog_writer_service: lambda: writer,
                deps.get_wanted_watcher_service: lambda: wanted,
                deps.get_download_service: lambda: downloads,
            },
        )
    )
    assert _body(response)["libraryRemoval"] == {"removedSongId": ["tr-t1", "tr-t2"]}
    writer.remove_album.assert_awaited_once_with(
        "a1", actor_user_id="u1", delete_files=True
    )
    downloads.purge_album_downloads.assert_awaited_once_with("rg1")
    wanted.continue_after_library_removal.assert_awaited_once_with("rg1")
    wanted.stop_after_library_removal.assert_not_awaited()
