"""Player extensions: Spotify match search and single-track server download."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import core.dependencies as deps
from api.compat.subsonic.parameters import SubsonicParameters
from api.compat.subsonic.router import _HANDLERS, Ctx
from services.native.download_service import ALREADY_IN_LIBRARY


def _ctx(params: dict[str, str]) -> Ctx:
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
        request=None,  # type: ignore[arg-type]
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
