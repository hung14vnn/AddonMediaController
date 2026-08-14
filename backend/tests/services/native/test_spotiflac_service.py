from unittest.mock import AsyncMock

import pytest

from services.native.spotiflac_service import SpotiflacService, spotiflac_client_options


def test_low_quality_uses_lossy_youtube_provider():
    options = spotiflac_client_options("/downloads", "LOW")

    assert options == {
        "output_dir": "/downloads",
        "quality": "LOW",
        "services": ["youtube"],
        "allow_fallback": False,
        "use_extensions_fallback": False,
    }


def test_high_quality_uses_standard_provider_fallbacks():
    options = spotiflac_client_options("/downloads", "HIGH")

    assert options["services"] == ["tidal", "qobuz", "deezer", "amazon", "apple"]


def test_lossless_quality_preserves_provider_output():
    options = spotiflac_client_options("/downloads", "LOSSLESS")

    assert options["services"] == ["tidal", "qobuz", "deezer", "amazon", "apple"]


@pytest.mark.asyncio
async def test_track_request_preserves_spotify_local_album_identity():
    service = SpotiflacService.__new__(SpotiflacService)
    service._start = AsyncMock(return_value="task-1")

    task_id = await service.request_track(
        user_id="user-1",
        recording_mbid="spotify:track:track-123",
        release_group_mbid="spotify:album:album-123",
        artist_name="Spotify Artist",
        track_title="Spotify Track",
        album_title="Spotify Album",
        cover_url="https://i.scdn.co/image/album-cover",
    )

    assert task_id == "task-1"
    assert service._start.await_args.kwargs["release_group_mbid"] == "spotify:album:album-123"
    assert service._start.await_args.kwargs["cover_url"] == "https://i.scdn.co/image/album-cover"
