import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

import pytest

from services.native.spotiflac_service import (
    SpotiflacService,
    _CrossLoopAsyncLock,
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
