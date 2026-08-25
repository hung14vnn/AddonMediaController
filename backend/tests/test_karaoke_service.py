import json
import time
from pathlib import Path

import pytest

from core.config import Settings
from services.karaoke_service import KaraokeService


class _LocalFiles:
    def __init__(self, path: Path) -> None:
        self.path = path

    async def resolve_validated_path(self, _file_id: str) -> Path:
        return self.path


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
        karaoke_cache_max_size_mb=128,
    )
    service = KaraokeService(settings, _LocalFiles(source))  # type: ignore[arg-type]
    service.start = lambda: None  # type: ignore[method-assign]
    return service, source


@pytest.mark.asyncio()
async def test_prepare_deduplicates_an_inflight_track(tmp_path: Path):
    service, _ = _service(tmp_path)

    first = await service.prepare("track-1")
    second = await service.prepare("track-1")

    assert first.status == "queued"
    assert second.job_id == first.job_id
    assert second.cache_key == first.cache_key
    assert service._queue.qsize() == 1


@pytest.mark.asyncio()
async def test_prepare_returns_both_stems_on_cache_hit(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    entry = service._entry_dir(queued.cache_key)
    entry.mkdir(parents=True)
    (entry / "instrumental.m4a").write_bytes(b"instrumental")
    (entry / "vocals.m4a").write_bytes(b"vocals")
    (entry / "metadata.json").write_text(
        json.dumps(
            {
                "created_at": time.time(),
                "last_accessed_at": time.time(),
                "size_bytes": 18,
            }
        )
    )

    result = await service.prepare("track-1")

    assert result.status == "ready"
    assert result.cached is True
    assert result.instrumental_url.endswith("/instrumental")
    assert result.vocals_url.endswith("/vocals")


@pytest.mark.asyncio()
async def test_stream_stem_supports_byte_ranges(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    entry = service._entry_dir(queued.cache_key)
    entry.mkdir(parents=True)
    (entry / "instrumental.m4a").write_bytes(b"0123456789")
    (entry / "vocals.m4a").write_bytes(b"v")
    (entry / "metadata.json").write_text(
        json.dumps(
            {
                "created_at": time.time(),
                "last_accessed_at": time.time(),
                "size_bytes": 11,
            }
        )
    )

    chunks, headers, status = await service.stream_stem(
        queued.cache_key, "instrumental", "bytes=2-5"
    )
    content = b"".join([chunk async for chunk in chunks])

    assert status == 206
    assert headers["Content-Range"] == "bytes 2-5/10"
    assert content == b"2345"


@pytest.mark.asyncio()
async def test_cleanup_removes_idle_expired_package(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    entry = service._entry_dir(queued.cache_key)
    entry.mkdir(parents=True)
    (entry / "instrumental.m4a").write_bytes(b"i")
    (entry / "vocals.m4a").write_bytes(b"v")
    (entry / "metadata.json").write_text(
        json.dumps({"created_at": 1, "last_accessed_at": 1, "size_bytes": 2})
    )

    removed = await service.cleanup()

    assert removed == 1
    assert not entry.exists()


@pytest.mark.asyncio()
async def test_local_generation_records_model_metadata(tmp_path: Path):
    service, _ = _service(tmp_path)
    queued = await service.prepare("track-1")
    job = service._jobs[queued.job_id]

    async def separate(_job, work_dir: Path) -> None:
        (work_dir / "instrumental.m4a").write_bytes(b"instrumental")
        (work_dir / "vocals.m4a").write_bytes(b"vocals")

    service._request_separation = separate  # type: ignore[method-assign]
    await service._generate(job)

    metadata = json.loads(
        (service._entry_dir(job.cache_key) / "metadata.json").read_text()
    )
    assert job.status == "ready"
    assert metadata["provider"] == "local"
    assert metadata["model"] == "UVR_MDXNET_9482.onnx"
    assert metadata["quality"] == "standard"
