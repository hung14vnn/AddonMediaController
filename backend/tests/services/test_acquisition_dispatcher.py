"""AcquisitionDispatcher: the one place that chooses a user's download client vs
Free Music. A configured builtin client wins; otherwise Free Music (D24) serves,
and after 2.0 it is the only path."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.acquisition_dispatcher import AcquisitionDispatcher
from core.exceptions import ProviderIdentityRequiredError


def _dispatcher(
    *,
    builtin_ready: bool,
    free_music_ready: bool = True,
    spotiflac_enabled: bool = False,
    spotiflac_ready: bool = True,
):
    download = MagicMock()
    download.request_album = AsyncMock(return_value="slskd-album")
    download.request_track = AsyncMock(return_value="slskd-track")
    free_music = MagicMock()
    free_music.is_ready = MagicMock(return_value=free_music_ready)
    free_music.request_album = AsyncMock(return_value="free-album")
    free_music.request_track = AsyncMock(return_value="free-track")
    prefs = SimpleNamespace(
        is_builtin_download_ready=lambda: builtin_ready,
        get_spotiflac_connection=lambda: SimpleNamespace(enabled=spotiflac_enabled),
    )
    spotiflac = MagicMock()
    spotiflac.is_ready = MagicMock(return_value=spotiflac_ready)
    spotiflac.request_album = AsyncMock(return_value="spotiflac-album")
    spotiflac.request_track = AsyncMock(return_value="spotiflac-track")

    dispatcher = AcquisitionDispatcher(
        get_download_service=lambda: download,
        get_free_music_service=lambda: free_music,
        get_spotiflac_service=lambda: spotiflac,
        preferences_service=prefs,
    )
    return dispatcher, download, free_music, spotiflac


@pytest.mark.asyncio
async def test_album_goes_to_free_music_when_no_client_is_configured():
    dispatcher, download, free_music, _spotiflac = _dispatcher(builtin_ready=False)

    task_id = await dispatcher.request_album(
        user_id="u1",
        release_group_mbid="rg",
        artist_name="A",
        album_title="B",
        year=1999,
    )

    assert task_id == "free-album"
    download.request_album.assert_not_awaited()
    # Free Music takes only the four it uses; the year is dropped, not forwarded
    kwargs = free_music.request_album.await_args.kwargs
    assert set(kwargs) == {
        "user_id",
        "release_group_mbid",
        "artist_name",
        "album_title",
        "track_count",
    }


@pytest.mark.asyncio
async def test_album_goes_to_the_client_when_one_is_configured():
    dispatcher, download, free_music, _spotiflac = _dispatcher(builtin_ready=True)

    task_id = await dispatcher.request_album(
        user_id="u1",
        release_group_mbid="rg",
        artist_name="A",
        album_title="B",
        origin="wanted",
    )

    assert task_id == "slskd-album"
    free_music.request_album.assert_not_awaited()
    assert download.request_album.await_args.kwargs["origin"] == "wanted"


@pytest.mark.asyncio
async def test_track_routes_the_same_way():
    dispatcher, download, free_music, _spotiflac = _dispatcher(builtin_ready=False)

    task_id = await dispatcher.request_track(
        user_id="u1",
        recording_mbid="rec",
        artist_name="A",
        track_title="T",
        album_title="Alb",
        duration_seconds=200,
    )

    assert task_id == "free-track"
    download.request_track.assert_not_awaited()
    kwargs = free_music.request_track.await_args.kwargs
    assert set(kwargs) == {"user_id", "recording_mbid", "artist_name", "track_title"}


@pytest.mark.asyncio
async def test_falls_back_to_the_client_when_free_music_is_disabled():
    dispatcher, download, free_music, _spotiflac = _dispatcher(
        builtin_ready=False, free_music_ready=False
    )

    await dispatcher.request_album(
        user_id="u1", release_group_mbid="rg", artist_name="A", album_title="B"
    )

    download.request_album.assert_awaited_once()
    free_music.request_album.assert_not_awaited()


@pytest.mark.asyncio
async def test_target_projection_rejects_local_only_track_before_free_music() -> None:
    dispatcher, download, free_music, _spotiflac = _dispatcher(builtin_ready=False)
    ownership = AsyncMock()
    ownership.provider_track_id.side_effect = ProviderIdentityRequiredError(
        "This track only has local metadata."
    )
    dispatcher._ownership = ownership

    with pytest.raises(ProviderIdentityRequiredError):
        await dispatcher.request_track(
            user_id="u1",
            recording_mbid="local-track-id",
            artist_name="Local Artist",
            track_title="Local Track",
        )

    download.request_track.assert_not_awaited()
    free_music.request_track.assert_not_awaited()


@pytest.mark.asyncio
async def test_enabled_spotiflac_wins_even_when_its_mount_is_not_ready():
    dispatcher, download, free_music, spotiflac = _dispatcher(
        builtin_ready=False, spotiflac_enabled=True, spotiflac_ready=False
    )

    task_id = await dispatcher.request_track(
        user_id="u1",
        recording_mbid="spotify:track:track-123",
        release_group_mbid="spotify:album:album-123",
        artist_name="A",
        track_title="T",
        cover_url="https://i.scdn.co/image/album-cover",
    )

    assert task_id == "spotiflac-track"
    spotiflac.request_track.assert_awaited_once()
    assert (
        spotiflac.request_track.await_args.kwargs["release_group_mbid"]
        == "spotify:album:album-123"
    )
    assert (
        spotiflac.request_track.await_args.kwargs["cover_url"]
        == "https://i.scdn.co/image/album-cover"
    )
    download.request_track.assert_not_awaited()
    free_music.request_track.assert_not_awaited()
