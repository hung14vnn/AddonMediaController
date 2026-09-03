"""Single-concurrency karaoke generation and bounded two-stem disk cache."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import shutil
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import aiofiles
import httpx

from api.v1.schemas.karaoke import KaraokeJobResponse
from core.config import Settings
from core.exceptions import (
    ExternalServiceError,
    RangeNotSatisfiableError,
    ResourceNotFoundError,
)
from core.task_registry import TaskRegistry
from infrastructure.constants import STREAM_CHUNK_SIZE
from infrastructure.file_utils import atomic_write_json, read_json
from infrastructure.http.client import HttpClientFactory
from services.local_files_service import LocalFilesService

logger = logging.getLogger(__name__)

Stem = Literal["instrumental", "vocals"]
_ENGINE_VERSION = "uvr9482-local-aac-256k-v6"
_MODEL = "UVR_MDXNET_9482.onnx"
_ACCESS_WRITE_INTERVAL_SECONDS = 300


@dataclass
class _Job:
    id: str
    cache_key: str
    source_path: Path
    status: Literal["queued", "processing", "ready", "failed"] = "queued"
    error_message: str | None = None


class KaraokeService:
    def __init__(self, settings: Settings, local_files: LocalFilesService) -> None:
        self._settings = settings
        self._local_files = local_files
        self._root = settings.cache_dir / "karaoke"
        self._objects = self._root / "objects"
        self._tmp = self._root / "tmp"
        self._objects.mkdir(parents=True, exist_ok=True)
        self._tmp.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, _Job] = {}
        self._jobs_by_key: dict[str, _Job] = {}
        self._queue: asyncio.Queue[_Job] = asyncio.Queue()
        self._lock = asyncio.Lock()
        self._last_access_write: dict[str, float] = {}

    def start(self) -> None:
        registry = TaskRegistry.get_instance()
        if not registry.is_running("karaoke-job-worker"):
            registry.register(
                "karaoke-job-worker", asyncio.create_task(self._run_jobs())
            )
        if not registry.is_running("karaoke-cache-cleanup"):
            registry.register(
                "karaoke-cache-cleanup",
                asyncio.create_task(self._run_cleanup_periodically()),
            )

    async def prepare(self, track_file_id: str) -> KaraokeJobResponse:
        if not self._settings.karaoke_enabled:
            raise ExternalServiceError("Karaoke generation is disabled")

        source_path, cache_key = await self._source_and_cache_key(track_file_id)

        if self._entry_ready(cache_key):
            await self._touch(cache_key)
            return self._response_for_key(cache_key, cached=True)

        async with self._lock:
            existing = self._jobs_by_key.get(cache_key)
            if existing and existing.status in {"queued", "processing"}:
                return self._response_for_job(existing)

            job = _Job(
                id=uuid.uuid4().hex, cache_key=cache_key, source_path=source_path
            )
            self._jobs[job.id] = job
            self._jobs_by_key[cache_key] = job
            await self._queue.put(job)
            self.start()
            return self._response_for_job(job)

    async def status(self, track_file_id: str) -> KaraokeJobResponse:
        """Return a track's karaoke state without enqueueing a generation job."""
        if not self._settings.karaoke_enabled:
            return KaraokeJobResponse(
                cache_key="",
                status="failed",
                error_message="Karaoke generation is disabled",
            )

        _source_path, cache_key = await self._source_and_cache_key(track_file_id)
        if self._entry_ready(cache_key):
            await self._touch(cache_key)
            return self._response_for_key(cache_key, cached=True)

        async with self._lock:
            job = self._jobs_by_key.get(cache_key)
            if job is not None and job.status in {"queued", "processing", "failed"}:
                return self._response_for_job(job)

        return KaraokeJobResponse(cache_key=cache_key, status="not_generated")

    async def get_job(self, job_id: str) -> KaraokeJobResponse:
        job = self._jobs.get(job_id)
        if job is None:
            raise ResourceNotFoundError("Karaoke job not found")
        if job.status == "ready" and not self._entry_ready(job.cache_key):
            job.status = "failed"
            job.error_message = "Generated karaoke files are no longer available"
        return self._response_for_job(job)

    async def stream_stem(
        self, cache_key: str, stem: Stem, range_header: str | None
    ) -> tuple[AsyncGenerator[bytes, None], dict[str, str], int]:
        if len(cache_key) != 64 or any(c not in "0123456789abcdef" for c in cache_key):
            raise ResourceNotFoundError("Karaoke entry not found")
        file_path = self._entry_dir(cache_key) / f"{stem}.m4a"
        if not file_path.is_file():
            raise ResourceNotFoundError("Karaoke stem not found")
        await self._touch(cache_key)
        stat = await asyncio.to_thread(file_path.stat)
        file_size = stat.st_size
        start, end, status = 0, max(file_size - 1, 0), 200
        if range_header:
            start, end = self._parse_range(range_header, file_size)
            status = 206
        length = max(0, end - start + 1)
        headers = {
            "Content-Type": "audio/mp4",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
        }
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        return self._iter_file(file_path, start, length), headers, status

    async def _run_jobs(self) -> None:
        while True:
            job = await self._queue.get()
            try:
                await self._generate(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolate each user job
                logger.exception("Karaoke generation failed for %s", job.cache_key[:12])
                job.status = "failed"
                job.error_message = self._safe_error(exc)
            finally:
                self._queue.task_done()

    async def _generate(self, job: _Job) -> None:
        job.status = "processing"
        work_dir = self._tmp / job.id
        await asyncio.to_thread(work_dir.mkdir, parents=True, exist_ok=True)
        try:
            await self._request_separation(job, work_dir)

            instrumental = work_dir / "instrumental.m4a"
            vocals = work_dir / "vocals.m4a"
            if not instrumental.is_file() or not vocals.is_file():
                raise ExternalServiceError("Karaoke worker returned incomplete output")
            if instrumental.stat().st_size == 0 or vocals.stat().st_size == 0:
                raise ExternalServiceError("Karaoke worker returned empty output")

            entry_dir = self._entry_dir(job.cache_key)
            await asyncio.to_thread(entry_dir.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(
                instrumental.replace, entry_dir / "instrumental.m4a"
            )
            await asyncio.to_thread(vocals.replace, entry_dir / "vocals.m4a")
            now = time.time()
            sizes = [
                (entry_dir / "instrumental.m4a").stat().st_size,
                (entry_dir / "vocals.m4a").stat().st_size,
            ]
            await asyncio.to_thread(
                atomic_write_json,
                entry_dir / "metadata.json",
                {
                    "cache_key": job.cache_key,
                    "engine_version": _ENGINE_VERSION,
                    "provider": "local",
                    "model": _MODEL,
                    "quality": "standard",
                    "created_at": now,
                    "last_accessed_at": now,
                    "size_bytes": sum(sizes),
                },
            )
            job.status = "ready"
            job.error_message = None
            await self.cleanup()
        finally:
            await asyncio.to_thread(shutil.rmtree, work_dir, True)

    async def _request_separation(self, job: _Job, work_dir: Path) -> None:
        client = HttpClientFactory.get_client(
            name="karaoke-worker",
            timeout=float(self._settings.karaoke_job_timeout_seconds),
            connect_timeout=5.0,
            max_connections=1,
            max_keepalive=1,
            http2=False,
        )
        try:
            response = await client.post(
                f"{self._settings.karaoke_worker_url.rstrip('/')}/separate",
                json={"input_path": str(job.source_path), "output_dir": str(work_dir)},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "Karaoke worker rejected job %s with status %s: %.300s",
                job.id,
                exc.response.status_code,
                exc.response.text,
            )
            raise ExternalServiceError(
                "Karaoke worker could not separate this track"
            ) from exc
        except httpx.HTTPError as exc:
            raise ExternalServiceError("Karaoke worker is unavailable") from exc

    async def cleanup(self) -> int:
        return await asyncio.to_thread(self._cleanup_sync)

    def _cleanup_sync(self) -> int:
        now = time.time()
        ttl = max(1, self._settings.karaoke_cache_ttl_days) * 86400
        entries: list[tuple[float, int, Path]] = []
        total = 0
        removed = 0
        for meta_path in self._objects.glob("*/*/metadata.json"):
            entry_dir = meta_path.parent
            try:
                meta = read_json(meta_path, default={})
                last_access = float(
                    meta.get("last_accessed_at", meta.get("created_at", 0))
                )
                size = int(meta.get("size_bytes", 0))
            except Exception:  # noqa: BLE001
                continue
            if last_access + ttl < now:
                shutil.rmtree(entry_dir, ignore_errors=True)
                removed += 1
                continue
            total += size
            entries.append((last_access, size, entry_dir))

        limit = max(1, self._settings.karaoke_cache_max_size_mb) * 1024 * 1024
        target = int(limit * 0.9)
        if total > limit:
            for _, size, entry_dir in sorted(entries, key=lambda item: item[0]):
                shutil.rmtree(entry_dir, ignore_errors=True)
                total -= size
                removed += 1
                if total <= target:
                    break
        return removed

    async def _run_cleanup_periodically(self) -> None:
        while True:
            try:
                await self.cleanup()
            except Exception:  # noqa: BLE001
                logger.exception("Karaoke cache cleanup failed")
            await asyncio.sleep(
                max(60, self._settings.karaoke_cache_cleanup_interval_seconds)
            )

    async def _source_and_cache_key(self, track_file_id: str) -> tuple[Path, str]:
        source_path = await self._local_files.resolve_validated_path(track_file_id)
        stat = await asyncio.to_thread(source_path.stat)
        cache_key = hashlib.sha256(
            f"{source_path}\0{stat.st_size}\0{stat.st_mtime_ns}\0{_ENGINE_VERSION}".encode()
        ).hexdigest()
        return source_path, cache_key

    async def _touch(self, cache_key: str) -> None:
        now = time.time()
        if (
            now - self._last_access_write.get(cache_key, 0)
            < _ACCESS_WRITE_INTERVAL_SECONDS
        ):
            return
        self._last_access_write[cache_key] = now
        meta_path = self._entry_dir(cache_key) / "metadata.json"
        try:
            meta = await asyncio.to_thread(read_json, meta_path, {})
            meta["last_accessed_at"] = now
            await asyncio.to_thread(atomic_write_json, meta_path, meta)
        except Exception:  # noqa: BLE001 - playback must not fail for an access timestamp
            logger.debug("Could not update karaoke access time", exc_info=True)

    def _entry_dir(self, cache_key: str) -> Path:
        return self._objects / cache_key[:2] / cache_key

    def _entry_ready(self, cache_key: str) -> bool:
        entry = self._entry_dir(cache_key)
        return all(
            (entry / filename).is_file()
            for filename in ("instrumental.m4a", "vocals.m4a", "metadata.json")
        )

    def _response_for_key(self, cache_key: str, *, cached: bool) -> KaraokeJobResponse:
        base = f"/api/v1/karaoke/{cache_key}"
        return KaraokeJobResponse(
            cache_key=cache_key,
            status="ready",
            cached=cached,
            instrumental_url=f"{base}/instrumental",
            vocals_url=f"{base}/vocals",
        )

    def _response_for_job(self, job: _Job) -> KaraokeJobResponse:
        if job.status == "ready":
            response = self._response_for_key(job.cache_key, cached=False)
            response.job_id = job.id
            return response
        return KaraokeJobResponse(
            job_id=job.id,
            cache_key=job.cache_key,
            status=job.status,
            error_message=job.error_message,
        )

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        if isinstance(exc, ExternalServiceError):
            return str(exc)[:300]
        return "Karaoke generation failed"

    @staticmethod
    def _parse_range(header: str, file_size: int) -> tuple[int, int]:
        import re

        match = re.fullmatch(r"bytes=([0-9]*)-([0-9]*)", header)
        if match is None or not any(match.groups()) or file_size <= 0:
            raise RangeNotSatisfiableError(file_size)
        first, last = match.groups()
        if not first:
            suffix = int(last)
            if suffix <= 0:
                raise RangeNotSatisfiableError(file_size)
            start, end = max(0, file_size - suffix), file_size - 1
        else:
            start = int(first)
            end = min(int(last), file_size - 1) if last else file_size - 1
        if start < 0 or start > end or start >= file_size:
            raise RangeNotSatisfiableError(file_size)
        return start, end

    @staticmethod
    async def _iter_file(
        path: Path, offset: int, length: int
    ) -> AsyncGenerator[bytes, None]:
        remaining = length
        async with aiofiles.open(path, "rb") as handle:
            await handle.seek(offset)
            while remaining > 0:
                chunk = await handle.read(min(STREAM_CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
