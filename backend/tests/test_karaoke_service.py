import time
from pathlib import Path

import pytest

from core.config import Settings
from core.exceptions import ResourceNotFoundError
from services.karaoke_service import KaraokeService, _Entry


class _LocalFiles:
    def __init__(self, path: Path) -> None:
        self.path = path

    async def resolve_validated_path(self, _file_id: str) -> Path:
        return self.path

    async def get_karaoke_track_metadata(self, file_id: str) -> dict | None:
        return {
            "id": file_id,
            "track_title": "Test song",
            "artist_name": "Test artist",
            "album_title": "Test album",
        }


def _service(tmp_path: Path) -> tuple[KaraokeService, Path]:
    source = tmp_path / "music" / "song.flac"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"fake audio")
    settings = Settings(
        _env_file=None,
        debug=False,
        root_app_dir=tmp_path,
        cache_dir=tmp_path / "cache",
        library_db_path=tmp_path / "cache" / "library.db",
        config_file_path=tmp_path / "config" / "config.json",
        karaoke_memory_max_size_mb=128,
        karaoke_memory_idle_minutes=5,
    )
    service = KaraokeService(settings, _LocalFiles(source))  # type: ignore[arg-type]
    service.start = lambda: None  # type: ignore[method-assign]
    return service, source


@pytest.fixture(autouse=True)
def _instant_preview(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        KaraokeService,
        "_render_preview_sync",
        lambda _self, _key, _path: b"preview-audio",
    )


async def _settle_previews(service: KaraokeService) -> None:
    for task in list(service._preview_tasks.values()):
        await task


def _put_entry(service: KaraokeService, cache_key: str) -> None:
    now = time.time()
    service._entries[cache_key] = _Entry(
        cache_key=cache_key,
        instrumental=b"0123456789",
        vocals=b"vocals",
        metadata={
            "cache_key": cache_key,
            "track_title": "Test song",
            "artist_name": "Test artist",
            "album_name": "Test album",
            "created_at": now,
            "last_accessed_at": now,
        },
        created_at=now,
        last_accessed_at=now,
    )


@pytest.mark.asyncio()
async def test_prepare_deduplicates_an_inflight_track(tmp_path: Path):
    service, _ = _service(tmp_path)

    first = await service.prepare("track-1")
    second = await service.prepare("track-1")

    assert first.status == "queued"
    assert second.job_id == first.job_id
    assert second.cache_key == first.cache_key
    assert second.session_id != first.session_id
    assert service._queue.qsize() == 1
    assert len(service._sessions) == 2


@pytest.mark.asyncio()
async def test_prepare_reuses_a_session_passed_back(tmp_path: Path):
    service, _ = _service(tmp_path)

    first = await service.prepare("track-1")
    second = await service.prepare("track-1", session_id=first.session_id)

    assert second.session_id == first.session_id
    assert len(service._sessions) == 1


@pytest.mark.asyncio()
async def test_status_reports_unprepared_track_without_enqueueing(tmp_path: Path):
    service, _ = _service(tmp_path)

    result = await service.status("track-1")

    assert result.status == "not_generated"
    assert service._queue.qsize() == 0
    assert service._sessions == {}


@pytest.mark.asyncio()
async def test_prepare_builds_an_immediate_preview(tmp_path: Path):
    service, _ = _service(tmp_path)

    queued = await service.prepare("track-1")
    assert queued.preview_status in {"pending", "generating"}
    await _settle_previews(service)

    status = await service.status("track-1")
    assert status.preview_status == "ready"
    assert status.preview_url is not None
    chunks, headers, code = await service.stream_stem(
        status.cache_key, "preview", "bytes=0-6"
    )

    assert code == 206
    assert b"".join([chunk async for chunk in chunks]) == b"preview"
    assert headers["Cache-Control"] == "private, no-store"


@pytest.mark.asyncio()
async def test_prepare_returns_both_stems_from_memory_on_cache_hit(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    _put_entry(service, queued.cache_key)

    result = await service.prepare("track-1")
    status = await service.status("track-1")

    assert result.status == "ready"
    assert result.cached is True
    assert status.status == "ready"
    assert status.cached is True
    assert result.instrumental_url.endswith("/instrumental")
    assert result.vocals_url.endswith("/vocals")


@pytest.mark.asyncio()
async def test_stream_stem_supports_byte_ranges(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    _put_entry(service, queued.cache_key)

    chunks, headers, status = await service.stream_stem(
        queued.cache_key, "instrumental", "bytes=2-5"
    )
    content = b"".join([chunk async for chunk in chunks])

    assert status == 206
    assert headers["Content-Range"] == "bytes 2-5/10"
    assert content == b"2345"


@pytest.mark.asyncio()
async def test_release_keeps_stems_until_the_last_session_leaves(tmp_path: Path):
    service, _ = _service(tmp_path)
    first = await service.prepare("track-1")
    second = await service.prepare("track-1")
    _put_entry(service, first.cache_key)

    await service.release(first.session_id)
    assert first.cache_key in service._entries

    await service.release(second.session_id)
    assert first.cache_key not in service._entries
    assert first.cache_key not in service._previews

    with pytest.raises(ResourceNotFoundError):
        await service.stream_stem(first.cache_key, "instrumental", None)


@pytest.mark.asyncio()
async def test_cleanup_drops_idle_sessions_and_their_stems(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    _put_entry(service, queued.cache_key)
    service._sessions[queued.session_id].last_used_at = 1

    removed = await service.cleanup()

    assert removed >= 1
    assert queued.cache_key not in service._entries
    assert service._sessions == {}


@pytest.mark.asyncio()
async def test_local_generation_keeps_stems_in_memory(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    job = service._jobs[queued.job_id]

    async def separate(_job, work_dir: Path) -> None:
        (work_dir / "instrumental.m4a").write_bytes(b"instrumental")
        (work_dir / "vocals.m4a").write_bytes(b"vocals")

    service._request_separation = separate  # type: ignore[method-assign]
    await service._generate(job)

    entry = service._entries[job.cache_key]
    assert job.status == "ready"
    assert entry.instrumental == b"instrumental"
    assert entry.vocals == b"vocals"
    assert entry.metadata["provider"] == "local"
    assert entry.metadata["model"] == "sherpa-onnx-spleeter-2stems-fp16"
    assert entry.metadata["quality"] == "standard"
    assert entry.metadata["track_file_id"] == "track-1"
    assert not (service._tmp / job.id).exists()


@pytest.mark.asyncio()
async def test_generation_without_a_session_is_discarded(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    job = service._jobs[queued.job_id]
    await service.release(queued.session_id)

    async def separate(_job, work_dir: Path) -> None:
        (work_dir / "instrumental.m4a").write_bytes(b"instrumental")
        (work_dir / "vocals.m4a").write_bytes(b"vocals")

    service._request_separation = separate  # type: ignore[method-assign]
    await service._generate(job)

    assert job.status == "failed"
    assert job.cache_key not in service._entries


@pytest.mark.asyncio()
async def test_preview_is_skipped_when_ffmpeg_cannot_separate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        KaraokeService, "_render_preview_sync", lambda _self, _key, _path: None
    )
    service, _ = _service(tmp_path)

    await service.prepare("track-1")
    await _settle_previews(service)

    status = await service.status("track-1")
    assert status.preview_status == "unavailable"


@pytest.mark.asyncio()
async def test_list_entries_lists_ram_packages_and_deletes_them(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    _put_entry(service, queued.cache_key)
    await _settle_previews(service)

    response = await service.list_entries()

    assert response.total == 1
    item = response.items[0]
    assert item.id == queued.cache_key
    assert item.name == "Test song"
    assert item.artist_name == "Test artist"
    assert item.album_name == "Test album"
    assert item.size_bytes == 16
    assert item.instrumental_size_bytes == 10
    assert item.vocals_size_bytes == 6

    await service.delete_entry(item.id)
    assert service._entries == {}

    with pytest.raises(ResourceNotFoundError):
        await service.delete_entry("not-a-cache-key")


@pytest.mark.asyncio()
async def test_legacy_disk_cache_is_purged_on_start(tmp_path: Path):
    service, _ = _service(tmp_path)
    legacy = service._root / "objects" / "ab" / ("a" * 64)
    legacy.mkdir(parents=True)
    (legacy / "instrumental.m4a").write_bytes(b"old")
    old = service._root / "old-song"
    old.mkdir()
    (old / "vocals.m4a").write_bytes(b"old")
    service._tmp.mkdir(parents=True)
    (service._tmp / "stale").mkdir()

    service._purge_legacy_disk_cache_sync()

    assert not legacy.exists()
    assert not old.exists()
    assert service._tmp.is_dir()
    assert list(service._tmp.iterdir()) == []

