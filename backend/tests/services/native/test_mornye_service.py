import asyncio
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from services.native.mornye_service import (
    MornyeService,
    mornye_client_options,
)


def _install_fake_mornye(monkeypatch, fake_client):  # noqa: ANN001 - pytest fixture
    package = ModuleType("mornye")
    package.AsyncMornye = fake_client
    monkeypatch.setitem(sys.modules, "mornye", package)


def test_low_quality_uses_lossy_youtube_extension():
    options = mornye_client_options("/downloads", "LOW")

    assert options == {
        "output_dir": "/downloads",
        "quality": "LOW",
        "services": ["ext:ytmusic-spotiflac"],
        "sync_extensions": True,
        "timeout_s": 150,
        "allow_fallback": False,
    }


def test_high_quality_uses_standard_provider_fallbacks():
    options = mornye_client_options("/downloads", "HIGH")

    assert options["services"] == [
        "ext:tidal-web",
        "ext:qobuz-web",
        "ext:deezer",
        "ext:amazon",
    ]


def test_lossless_quality_preserves_provider_output():
    options = mornye_client_options("/downloads", "LOSSLESS")

    assert options["services"] == [
        "ext:tidal-web",
        "ext:qobuz-web",
        "ext:deezer",
        "ext:amazon",
    ]


def test_is_ready_requires_writable_download_folder(monkeypatch, tmp_path):
    service = MornyeService(
        drop_import=AsyncMock(),
        preferences_service=SimpleNamespace(
            get_mornye_connection=lambda: SimpleNamespace(
                enabled=True, downloads_mount=str(tmp_path)
            )
        ),
        download_store=AsyncMock(),
        event_bus=AsyncMock(),
    )
    assert service.is_ready() is True

    monkeypatch.setattr("services.native.mornye_service.os.access", lambda *_: False)

    assert service.is_ready() is False


@pytest.mark.asyncio
async def test_download_reports_unwritable_download_folder(monkeypatch, tmp_path):
    def deny_mkdir(_self, *_args, **_kwargs):
        raise PermissionError(13, "Permission denied", str(_self))

    _install_fake_mornye(monkeypatch, AsyncMock())
    monkeypatch.setattr(Path, "mkdir", deny_mkdir)
    store = AsyncMock()
    service = MornyeService(
        drop_import=AsyncMock(),
        preferences_service=AsyncMock(),
        download_store=store,
        event_bus=AsyncMock(),
    )

    await service._download(
        "task-1",
        "user-1",
        "https://open.spotify.com/track/1",
        "LOSSLESS",
        tmp_path,
    )

    store.update_status.assert_awaited_once()
    args, kwargs = store.update_status.await_args
    assert args == ("task-1", "failed")
    assert "Cannot write to the Mornye download folder" in kwargs["error_message"]


@pytest.mark.asyncio
async def test_failed_provider_falls_through_to_next_extension(monkeypatch, tmp_path):
    attempted: list[str] = []

    class FakeMornye:
        def __init__(self, **options):
            self.output_dir = Path(options["output_dir"])
            self.provider = options["services"][0]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return None

        async def download_track(self, _url):
            attempted.append(self.provider)
            if self.provider == "ext:tidal-web":
                raise RuntimeError("provider unavailable")
            (self.output_dir / "track.m4a").write_bytes(b"audio")

    _install_fake_mornye(monkeypatch, FakeMornye)

    store = AsyncMock()
    store.get_task.return_value = SimpleNamespace(
        release_group_mbid=None,
        recording_mbid=None,
        artist_name="Artist",
        artist_mbid=None,
        album_title="Album",
        track_title="Track",
        cover_url=None,
    )
    drop_import = AsyncMock()
    event_bus = AsyncMock()
    service = MornyeService(
        drop_import=drop_import,
        preferences_service=AsyncMock(),
        download_store=store,
        event_bus=event_bus,
    )

    await service._download(
        "task-1",
        "user-1",
        "https://open.spotify.com/track/1",
        "LOSSLESS",
        tmp_path,
    )

    assert attempted == ["ext:tidal-web", "ext:qobuz-web"]
    store.update_status.assert_awaited_once_with(
        "task-1",
        "completed",
        files_total=1,
        files_completed=1,
        progress_percent=100,
    )


@pytest.mark.asyncio
async def test_download_skips_encrypted_audio_artifact(monkeypatch, tmp_path):
    class FakeMornye:
        def __init__(self, **options):
            self.output_dir = Path(options["output_dir"])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return None

        async def download_track(self, _url):
            (self.output_dir / " NHỨC TIỀM THỨC - Hà An Huy.flac").write_bytes(
                b"encrypted"
            )
            (self.output_dir / "NHỨC TIỀM THỨC - Hà An Huy.flac").write_bytes(
                b"valid"
            )

    _install_fake_mornye(monkeypatch, FakeMornye)

    store = AsyncMock()
    store.get_task.return_value = SimpleNamespace(
        release_group_mbid=None,
        recording_mbid=None,
        artist_name="Artist",
        artist_mbid=None,
        album_title="Album",
        track_title="Track",
        cover_url=None,
    )
    drop_import = AsyncMock()
    service = MornyeService(
        drop_import=drop_import,
        preferences_service=AsyncMock(),
        download_store=store,
        event_bus=AsyncMock(),
    )

    async def convert(path, _quality):
        if path.name.startswith(" "):
            raise RuntimeError("encrypted input")
        return path.with_suffix(".m4a")

    service._convert_to_m4a = convert

    await service._download(
        "task-1",
        "user-1",
        "https://open.spotify.com/track/1",
        "LOSSLESS",
        tmp_path,
    )

    drop_import.create_job.assert_awaited_once()
    assert [name for name, _path in drop_import.create_job.await_args.kwargs["uploads"]] == [
        "NHỨC TIỀM THỨC - Hà An Huy.m4a"
    ]
    assert store.update_status.await_args.kwargs["files_completed"] == 1


@pytest.mark.asyncio
async def test_non_lossless_quality_keeps_flac_without_conversion(tmp_path):
    service = MornyeService.__new__(MornyeService)
    source = tmp_path / "track.flac"
    source.write_bytes(b"fLaC")

    assert await service._convert_to_m4a(source, "HIGH") == source
    assert await service._convert_to_m4a(source, "LOW") == source


@pytest.mark.asyncio
async def test_track_request_preserves_spotify_local_album_identity():
    service = MornyeService.__new__(MornyeService)
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
    assert service._start.await_args.args[1] == "https://open.spotify.com/track/track-123"
    assert service._start.await_args.kwargs["release_group_mbid"] == "spotify:album:album-123"
    assert service._start.await_args.kwargs["cover_url"] == "https://i.scdn.co/image/album-cover"


@pytest.mark.asyncio
async def test_album_request_uses_spotify_album_id_without_search():
    service = MornyeService.__new__(MornyeService)
    service._start = AsyncMock(return_value="task-1")

    await service.request_album(
        user_id="user-1",
        artist_name="Spotify Artist",
        album_title="Spotify Album",
        release_group_mbid="spotify:album:album-123",
    )

    assert service._start.await_args.args[1] == "https://open.spotify.com/album/album-123"


@pytest.mark.asyncio
async def test_progress_watcher_reports_mornye_staging_bytes(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "services.native.mornye_service._MORNYE_PROGRESS_INTERVAL_SECONDS",
        0.001,
    )
    staging = tmp_path / ".droppedneedle-task-1"
    staging.mkdir()
    (staging / "track.flac").write_bytes(b"audio")

    store = AsyncMock()
    store.get_task.return_value = SimpleNamespace(
        download_type="track", track_count=None
    )
    service = MornyeService(
        drop_import=AsyncMock(),
        preferences_service=AsyncMock(),
        download_store=store,
        event_bus=AsyncMock(),
    )

    watcher = asyncio.create_task(service._watch_progress("task-1", staging))
    try:
        async with asyncio.timeout(1):
            while not store.update_status.await_args_list:
                await asyncio.sleep(0.001)
    finally:
        watcher.cancel()
        with pytest.raises(asyncio.CancelledError):
            await watcher

    assert store.update_status.await_args_list[0].kwargs == {
        "downloaded_bytes": 5,
        "files_total": 1,
        "files_completed": 1,
        "progress_percent": 99,
    }


@pytest.mark.asyncio
async def test_start_exposes_queued_task_before_mornye_search(monkeypatch, tmp_path):
    search_started = asyncio.Event()
    release_search = asyncio.Event()

    async def fake_search(_query, _result_kind):
        search_started.set()
        await release_search.wait()
        return None

    monkeypatch.setattr(
        "services.native.mornye_service._search_spotify_url", fake_search
    )

    store = AsyncMock()
    store.create_task.return_value = SimpleNamespace(id="task-1")
    preferences = SimpleNamespace(
        get_mornye_connection=lambda: SimpleNamespace(
            enabled=True,
            downloads_mount=str(tmp_path),
            quality="LOSSLESS",
        )
    )
    bus = AsyncMock()
    service = MornyeService(
        drop_import=AsyncMock(),
        preferences_service=preferences,
        download_store=store,
        event_bus=bus,
    )

    task_id = await service._start("user-1", "Artist Track", "tracks")
    assert task_id == "task-1"
    store.create_task.assert_awaited_once_with(
        user_id="user-1",
        source="mornye",
        download_client="mornye",
        status="queued",
    )

    await asyncio.wait_for(search_started.wait(), timeout=1)
    release_search.set()
    async with asyncio.timeout(1):
        while not store.update_status.await_args_list:
            await asyncio.sleep(0.001)

    assert store.update_status.await_args_list[0].args == ("task-1", "failed")
