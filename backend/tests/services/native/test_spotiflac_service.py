import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from services.native.spotiflac_service import (
    SpotiflacService,
    _CrossLoopAsyncLock,
    _download_track_with_timeout,
    spotiflac_client_options,
)


def test_low_quality_uses_lossy_youtube_extension():
    options = spotiflac_client_options("/downloads", "LOW")

    assert options == {
        "output_dir": "/downloads",
        "quality": "LOW",
        "services": ["ext:ytmusic-spotiflac"],
        "sync_extensions": False,
        "allow_fallback": False,
        "use_extensions_fallback": True,
    }


def test_high_quality_uses_standard_provider_fallbacks():
    options = spotiflac_client_options("/downloads", "HIGH")

    assert options["services"] == [
        "ext:tidal-web",
        "ext:qobuz-web",
        "ext:deezer",
        "ext:amazon",
    ]


def test_lossless_quality_preserves_provider_output():
    options = spotiflac_client_options("/downloads", "LOSSLESS")

    assert options["services"] == [
        "ext:tidal-web",
        "ext:qobuz-web",
        "ext:deezer",
        "ext:amazon",
    ]


def test_cross_loop_lock_serializes_independent_event_loops():
    lock = _CrossLoopAsyncLock()
    start = threading.Barrier(2)
    state_guard = threading.Lock()
    active = 0
    peak_active = 0

    async def contender():
        nonlocal active, peak_active
        await asyncio.to_thread(start.wait)
        async with lock:
            with state_guard:
                active += 1
                peak_active = max(peak_active, active)
            await asyncio.sleep(0.03)
            with state_guard:
                active -= 1

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(asyncio.run, contender()) for _ in range(2)]
        for future in futures:
            future.result(timeout=2)

    assert peak_active == 1


@pytest.mark.asyncio
async def test_cancelled_cross_loop_waiter_does_not_strand_lock():
    lock = _CrossLoopAsyncLock()
    holder_entered = asyncio.Event()
    release_holder = asyncio.Event()

    async def holder():
        async with lock:
            holder_entered.set()
            await release_holder.wait()

    holder_task = asyncio.create_task(holder())
    await holder_entered.wait()

    cancelled_waiter = asyncio.create_task(lock.__aenter__())
    await asyncio.sleep(0.02)
    cancelled_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_waiter

    release_holder.set()
    await holder_task

    async with asyncio.timeout(0.2):
        async with lock:
            pass


@pytest.mark.asyncio
async def test_download_watchdog_stops_wedged_extension(monkeypatch):
    client = AsyncMock()

    async def wedged_download(_url):
        await asyncio.sleep(60)

    client.download_track.side_effect = wedged_download
    monkeypatch.setattr(
        "services.native.spotiflac_service._SPOTIFLAC_PROVIDER_TIMEOUT_SECONDS",
        0.01,
    )

    with pytest.raises(
        RuntimeError,
        match="provider ext:tidal-web timed out after 0.01 seconds",
    ):
        await _download_track_with_timeout(
            client,
            "https://open.spotify.com/track/1",
            "ext:tidal-web",
        )


@pytest.mark.asyncio
async def test_wedged_provider_falls_through_to_next_extension(monkeypatch, tmp_path):
    attempted: list[str] = []

    class FakeSpotiFLAC:
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
                await asyncio.sleep(60)
            (self.output_dir / "track.m4a").write_bytes(b"audio")

    spotiflac_package = ModuleType("SpotiFLAC")
    spotiflac_package.__path__ = []
    spotiflac_client = ModuleType("SpotiFLAC.client")
    spotiflac_client.AsyncSpotiFLAC = FakeSpotiFLAC
    monkeypatch.setitem(sys.modules, "SpotiFLAC", spotiflac_package)
    monkeypatch.setitem(sys.modules, "SpotiFLAC.client", spotiflac_client)
    monkeypatch.setattr(
        "services.native.spotiflac_service._SPOTIFLAC_PROVIDER_TIMEOUT_SECONDS",
        0.01,
    )
    monkeypatch.setattr(
        "services.native.spotiflac_service._patch_spotiflac_cross_loop_lock",
        lambda: None,
    )

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
    service = SpotiflacService(
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
