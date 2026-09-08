"""Route-level tests for the Spotify import background task (PR #108).

``_background_import`` runs fire-and-forget after the import POST returns; these
exercise it directly (no HTTP) and confirm it signals completion over SSE so the
frontend refreshes the imported playlist without a manual reload.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api.v1.routes import spotify as spotify_routes


@pytest.mark.asyncio
async def test_background_import_signals_completion_over_sse(monkeypatch):
    publisher = AsyncMock()
    monkeypatch.setattr(spotify_routes, "get_sse_publisher", lambda: publisher)
    playlist_service = AsyncMock()
    playlist_service.resolve_track_sources.return_value = {}
    local_service = AsyncMock()
    # The active catalog services are injected. Only external media sources retain
    # process-global getters because they are shared by both application entrypoints.
    for getter in (
        "get_jellyfin_library_service",
        "get_navidrome_library_service",
        "get_plex_library_service",
    ):
        monkeypatch.setattr(spotify_routes, getter, lambda: AsyncMock())
    folder_scope = AsyncMock()
    folder_scope.resolve.return_value = SimpleNamespace(
        scope=SimpleNamespace(mode="all", folder_ids=[])
    )
    monkeypatch.setattr(
        spotify_routes, "get_navidrome_folder_scope_service", lambda: folder_scope
    )

    svc = AsyncMock()
    await spotify_routes._background_import(
        svc,
        "user-1",
        "spot-1",
        "int-1",
        object(),
        playlist_service,
        local_service,
    )

    svc.populate_playlist.assert_awaited_once_with("user-1", "spot-1", "int-1")
    playlist_service.resolve_track_sources.assert_awaited_once()
    assert (
        playlist_service.resolve_track_sources.await_args.kwargs["local_service"]
        is local_service
    )
    publisher.publish.assert_awaited_once()
    channel, event, data = publisher.publish.await_args.args
    assert channel == "user:user-1"
    assert event == "playlist_imported"
    assert data["playlist_id"] == "int-1"
    assert data["event_id"]  # present so the client can de-dupe replays


@pytest.mark.asyncio
async def test_background_import_does_not_signal_when_populate_fails(monkeypatch):
    publisher = AsyncMock()
    monkeypatch.setattr(spotify_routes, "get_sse_publisher", lambda: publisher)

    svc = AsyncMock()
    svc.populate_playlist = AsyncMock(side_effect=RuntimeError("populate blew up"))

    # Must not raise (fire-and-forget task) and must not claim completion.
    await spotify_routes._background_import(
        svc,
        "user-1",
        "spot-1",
        "int-1",
        object(),
        AsyncMock(),
        AsyncMock(),
    )

    publisher.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_request_spotify_track_returns_duration_and_passes_it_to_acquisition():
    current_user = SimpleNamespace(id="user-1", role="user")
    svc = AsyncMock()
    svc.resolve_track_for_download.return_value = {
        "recording_mbid": "recording-1",
        "release_group_mbid": "release-group-1",
        "artist_name": "Artist",
        "track_title": "Track",
        "album_title": "Album",
        "duration_seconds": 213,
    }
    acquisition = AsyncMock()
    acquisition.request_track.return_value = "task-1"
    quota = AsyncMock()

    response = await spotify_routes.request_spotify_track(
        body=spotify_routes.SpotifyTrackRequest(spotify_id="spotify-1"),
        current_user=current_user,
        svc=svc,
        acquisition=acquisition,
        quota=quota,
    )

    assert response.status == "queued"
    assert response.task_id == "task-1"
    assert response.duration_seconds == 213
    assert acquisition.request_track.await_args.kwargs["duration_seconds"] == 213
