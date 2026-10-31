"""Single-concurrency karaoke generation with in-memory stems and previews.

Nothing karaoke-related survives a release: stems live in RAM only while at
least one client session holds the track, and a quick center-cut preview is
built while the AI separator runs so singing can start immediately.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import shutil
import subprocess
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

from api.v1.schemas.karaoke import (
    KaraokeCacheEntriesResponse,
    KaraokeCacheEntry,
    KaraokeJobResponse,
    KaraokePreviewStatus,
)
from core.config import Settings
from core.exceptions import (
    ExternalServiceError,
    RangeNotSatisfiableError,
    ResourceNotFoundError,
)
from core.task_registry import TaskRegistry
from infrastructure.constants import STREAM_CHUNK_SIZE
from infrastructure.http.client import HttpClientFactory
from services.local_files_service import LocalFilesService

logger = logging.getLogger(__name__)

StreamName = Literal["instrumental", "vocals", "preview"]
_ENGINE_VERSION = "spleeter2-fp16-local-aac-256k-v7"
_MODEL = "sherpa-onnx-spleeter-2stems-fp16"
_PREVIEW_CONCURRENCY = 2
_PREVIEW_TIMEOUT_SECONDS = 180
_FINISHED_JOB_TTL_SECONDS = 3600


@dataclass
class _Job:
    id: str
    cache_key: str
    source_path: Path
    track_file_id: str = ""
    track_title: str | None = None
    artist_name: str | None = None
    album_name: str | None = None
    status: Literal["queued", "processing", "ready", "failed"] = "queued"
    error_message: str | None = None
    created_at: float = 0.0
    finished_at: float = 0.0
    cancelled: bool = False


@dataclass
class _Entry:
    cache_key: str
    instrumental: bytes
    vocals: bytes
    metadata: dict[str, object]
    created_at: float
    last_accessed_at: float


@dataclass
class _Preview:
    data: bytes
    created_at: float
    last_accessed_at: float


@dataclass
class _Session:
    id: str
    cache_key: str
    last_used_at: float


class KaraokeService:
    def __init__(self, settings: Settings, local_files: LocalFilesService) -> None:
        self._settings = settings
        self._local_files = local_files
        self._root = settings.cache_dir / "karaoke"
        self._tmp = self._root / "tmp"
        self._entries: dict[str, _Entry] = {}
        self._previews: dict[str, _Preview] = {}
        self._preview_unavailable: set[str] = set()
        self._preview_tasks: dict[str, asyncio.Task[None]] = {}
        self._preview_semaphore = asyncio.Semaphore(_PREVIEW_CONCURRENCY)
        self._sessions: dict[str, _Session] = {}
        self._sessions_by_key: dict[str, set[str]] = {}
        self._jobs: dict[str, _Job] = {}
        self._jobs_by_key: dict[str, _Job] = {}
        self._queue: asyncio.Queue[_Job] = asyncio.Queue()
        self._lock = asyncio.Lock()
        self._started = False

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._started:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._started = True
        self._tmp.mkdir(parents=True, exist_ok=True)
        registry = TaskRegistry.get_instance()
        if not registry.is_running("karaoke-legacy-purge"):
            registry.register(
                "karaoke-legacy-purge",
                asyncio.create_task(self._purge_legacy_disk_cache()),
            )
        if not registry.is_running("karaoke-job-worker"):
            registry.register(
                "karaoke-job-worker", asyncio.create_task(self._run_jobs())
            )
        if not registry.is_running("karaoke-memory-cleanup"):
            registry.register(
                "karaoke-memory-cleanup",
                asyncio.create_task(self._run_cleanup_periodically()),
            )

    async def _purge_legacy_disk_cache(self) -> None:
        """One-time wipe of karaoke folders written by builds that cached to disk."""
        await asyncio.to_thread(self._purge_legacy_disk_cache_sync)

    def _purge_legacy_disk_cache_sync(self) -> None:
        if not self._root.is_dir():
            return
        for child in self._root.iterdir():
            if child.name == "tmp":
                continue
            try:
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove legacy karaoke path %s", child)
        if self._tmp.is_dir():
            for child in self._tmp.iterdir():
                try:
                    if child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        child.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove karaoke temp path %s", child)

    # -- public API --------------------------------------------------------

    async def prepare(
        self, track_file_id: str, session_id: str | None = None
    ) -> KaraokeJobResponse:
        if not self._settings.karaoke_enabled:
            raise ExternalServiceError("Karaoke generation is disabled")

        source_path, cache_key = await self._source_and_cache_key(track_file_id)
        session_id = self._attach_session(cache_key, session_id)
        self.start()

        entry = self._entries.get(cache_key)
        if entry is not None:
            self._touch_sync(cache_key)
            return self._response_for_key(cache_key, cached=True, session_id=session_id)

        async with self._lock:
            existing = self._jobs_by_key.get(cache_key)
            if existing is not None and existing.status in {"queued", "processing"}:
                return self._response_for_job(existing, session_id=session_id)

            job = _Job(
                id=uuid.uuid4().hex,
                cache_key=cache_key,
                source_path=source_path,
                track_file_id=track_file_id,
                created_at=time.time(),
                **self._display_metadata(
                    await self._get_track_metadata(track_file_id)
                ),
            )
            self._jobs[job.id] = job
            self._jobs_by_key[cache_key] = job
            await self._queue.put(job)

        self._start_preview(cache_key, source_path)
        return self._response_for_job(job, session_id=session_id)

    async def status(self, track_file_id: str) -> KaraokeJobResponse:
        """Return a track's karaoke state without enqueueing a generation job."""
        if not self._settings.karaoke_enabled:
            return KaraokeJobResponse(
                cache_key="",
                status="failed",
                preview_status="unavailable",
                error_message="Karaoke generation is disabled",
            )

        _source_path, cache_key = await self._source_and_cache_key(track_file_id)
        if cache_key in self._entries:
            return self._response_for_key(cache_key, cached=True)

        job = self._jobs_by_key.get(cache_key)
        if job is not None and job.status in {"queued", "processing", "failed"}:
            return self._response_for_job(job)

        return KaraokeJobResponse(
            cache_key=cache_key,
            status="not_generated",
            preview_url=self._preview_url(cache_key),
            preview_status=self._preview_status(cache_key),
        )

    async def get_job(self, job_id: str) -> KaraokeJobResponse:
        job = self._jobs.get(job_id)
        if job is None:
            raise ResourceNotFoundError("Karaoke job not found")
        if job.status == "ready" and job.cache_key not in self._entries:
            job.status = "failed"
            job.error_message = "Karaoke files are no longer available"
            job.finished_at = time.time()
        return self._response_for_job(job)

    async def release(self, session_id: str) -> None:
        """Drop a client's claim; the last claim removes the in-memory stems."""
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        tokens = self._sessions_by_key.get(session.cache_key)
        if tokens is None:
            return
        tokens.discard(session_id)
        if not tokens:
            self._sessions_by_key.pop(session.cache_key, None)
            self._forget(session.cache_key)

    async def stream_stem(
        self, cache_key: str, stem: StreamName, range_header: str | None
    ) -> tuple[AsyncGenerator[bytes, None], dict[str, str], int]:
        data = self._stream_data(cache_key, stem)
        if data is None:
            raise ResourceNotFoundError("Karaoke stream not found")
        self._touch_sync(cache_key)
        return self._stream_response(data, range_header)

    async def stream_karaoke(
        self, cache_key: str, range_header: str | None
    ) -> tuple[AsyncGenerator[bytes, None], dict[str, str], int]:
        """Serve AI instrumental when ready, otherwise the center-cut preview."""
        entry = self._entries.get(cache_key)
        preview = self._previews.get(cache_key)
        data = entry.instrumental if entry is not None else preview.data if preview else None
        if data is None:
            raise ResourceNotFoundError("Karaoke stream not found")
        self._touch_sync(cache_key)
        return self._stream_response(data, range_header)

    # -- sessions ----------------------------------------------------------

    def _attach_session(self, cache_key: str, session_id: str | None) -> str:
        now = time.time()
        if session_id:
            session = self._sessions.get(session_id)
            if session is not None and session.cache_key == cache_key:
                session.last_used_at = now
                return session_id
        token = uuid.uuid4().hex
        self._sessions[token] = _Session(token, cache_key, now)
        self._sessions_by_key.setdefault(cache_key, set()).add(token)
        return token

    def _has_sessions(self, cache_key: str) -> bool:
        return bool(self._sessions_by_key.get(cache_key))

    def _touch_sync(self, cache_key: str) -> None:
        now = time.time()
        entry = self._entries.get(cache_key)
        if entry is not None:
            entry.last_accessed_at = now
        preview = self._previews.get(cache_key)
        if preview is not None:
            preview.last_accessed_at = now
        for token in self._sessions_by_key.get(cache_key, ()):
            session = self._sessions.get(token)
            if session is not None:
                session.last_used_at = now

    def _forget(self, cache_key: str) -> None:
        self._entries.pop(cache_key, None)
        self._previews.pop(cache_key, None)
        self._preview_unavailable.discard(cache_key)
        self._preview_tasks.pop(cache_key, None)
        job = self._jobs_by_key.get(cache_key)
        if job is None:
            return
        if job.status in {"ready", "failed"}:
            self._jobs.pop(job.id, None)
            self._jobs_by_key.pop(cache_key, None)
        elif job.status == "queued":
            job.cancelled = True

    def _release_key(self, cache_key: str) -> None:
        for token in list(self._sessions_by_key.pop(cache_key, ())):
            self._sessions.pop(token, None)
        self._forget(cache_key)

    # -- generation --------------------------------------------------------

    async def _run_jobs(self) -> None:
        while True:
            job = await self._queue.get()
            try:
                if job.cancelled or not self._has_sessions(job.cache_key):
                    job.status = "failed"
                    job.error_message = "Karaoke request was released"
                    job.finished_at = time.time()
                    if not self._has_sessions(job.cache_key):
                        self._jobs_by_key.pop(job.cache_key, None)
                    continue
                await self._generate(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolate each user job
                logger.exception("Karaoke generation failed for %s", job.cache_key[:12])
                job.status = "failed"
                job.error_message = self._safe_error(exc)
                job.finished_at = time.time()
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
            instrumental_bytes = await asyncio.to_thread(instrumental.read_bytes)
            vocals_bytes = await asyncio.to_thread(vocals.read_bytes)
            if not instrumental_bytes or not vocals_bytes:
                raise ExternalServiceError("Karaoke worker returned empty output")

            if not self._has_sessions(job.cache_key):
                job.status = "failed"
                job.error_message = "Karaoke request was released"
                return

            now = time.time()
            entry = _Entry(
                cache_key=job.cache_key,
                instrumental=instrumental_bytes,
                vocals=vocals_bytes,
                metadata={
                    "cache_key": job.cache_key,
                    "track_file_id": job.track_file_id,
                    "source_path": str(job.source_path),
                    "track_title": job.track_title,
                    "artist_name": job.artist_name,
                    "album_name": job.album_name,
                    "engine_version": _ENGINE_VERSION,
                    "provider": "local",
                    "model": _MODEL,
                    "quality": "standard",
                    "created_at": now,
                    "last_accessed_at": now,
                    "size_bytes": len(instrumental_bytes) + len(vocals_bytes),
                },
                created_at=now,
                last_accessed_at=now,
            )
            self._entries[job.cache_key] = entry
            self._previews.pop(job.cache_key, None)
            self._preview_unavailable.discard(job.cache_key)
            job.status = "ready"
            job.error_message = None
            job.finished_at = now
            self._cleanup_sync()
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

    # -- center-cut preview ------------------------------------------------

    def _start_preview(self, cache_key: str, source_path: Path) -> None:
        if not self._has_sessions(cache_key):
            return
        if cache_key in self._entries or cache_key in self._previews:
            return
        if cache_key in self._preview_unavailable:
            return
        task = self._preview_tasks.get(cache_key)
        if task is not None and not task.done():
            return
        task = asyncio.create_task(self._build_preview(cache_key, source_path))
        self._preview_tasks[cache_key] = task

        def _drop(done: asyncio.Task[None], key: str = cache_key) -> None:
            if self._preview_tasks.get(key) is done:
                self._preview_tasks.pop(key, None)

        task.add_done_callback(_drop)

    async def _build_preview(self, cache_key: str, source_path: Path) -> None:
        try:
            async with self._preview_semaphore:
                if not self._has_sessions(cache_key):
                    return
                data = await asyncio.to_thread(
                    self._render_preview_sync, cache_key, source_path
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the AI path still works without a preview
            logger.exception("Karaoke preview failed for %s", cache_key[:12])
            data = None

        if data is None:
            if self._has_sessions(cache_key) and cache_key not in self._entries:
                self._preview_unavailable.add(cache_key)
            return
        if not self._has_sessions(cache_key) or cache_key in self._entries:
            return
        now = time.time()
        self._previews[cache_key] = _Preview(data, now, now)

    def _render_preview_sync(self, cache_key: str, source_path: Path) -> bytes | None:
        output = self._tmp / f"preview-{uuid.uuid4().hex}.m4a"
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(source_path),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-map_metadata",
                    "-1",
                    "-af",
                    "pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c0-0.5*c1",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-movflags",
                    "+faststart",
                    str(output),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=_PREVIEW_TIMEOUT_SECONDS,
                check=False,
            )
            if result.returncode != 0:
                logger.info(
                    "Karaoke preview unavailable for %s: %.300s",
                    cache_key[:12],
                    result.stderr.decode("utf-8", "replace"),
                )
                return None
            if not output.is_file():
                return None
            data = output.read_bytes()
            return data or None
        except (OSError, subprocess.SubprocessError):
            logger.warning(
                "Karaoke preview could not be rendered for %s",
                cache_key[:12],
                exc_info=True,
            )
            return None
        finally:
            output.unlink(missing_ok=True)

    def _preview_status(self, cache_key: str) -> KaraokePreviewStatus:
        if cache_key in self._previews:
            return "ready"
        task = self._preview_tasks.get(cache_key)
        if task is not None and not task.done():
            return "generating"
        if cache_key in self._preview_unavailable:
            return "unavailable"
        return "pending"

    # -- memory cleanup ----------------------------------------------------

    async def cleanup(self) -> int:
        return self._cleanup_sync()

    def _cleanup_sync(self) -> int:
        now = time.time()
        removed = 0
        idle = max(5, self._settings.karaoke_memory_idle_minutes) * 60

        for token, session in list(self._sessions.items()):
            if now - session.last_used_at <= idle:
                continue
            self._sessions.pop(token, None)
            tokens = self._sessions_by_key.get(session.cache_key)
            if tokens is not None:
                tokens.discard(token)
                if not tokens:
                    self._sessions_by_key.pop(session.cache_key, None)

        for cache_key in [*self._entries, *self._previews]:
            if self._has_sessions(cache_key):
                continue
            self._forget(cache_key)
            removed += 1

        for job in list(self._jobs.values()):
            if job.status not in {"ready", "failed"}:
                continue
            finished = job.finished_at or job.created_at
            if now - finished <= _FINISHED_JOB_TTL_SECONDS:
                continue
            self._jobs.pop(job.id, None)
            if self._jobs_by_key.get(job.cache_key) is job:
                self._jobs_by_key.pop(job.cache_key, None)

        limit = max(64, self._settings.karaoke_memory_max_size_mb) * 1024 * 1024
        sizes: dict[str, int] = {}
        access: dict[str, float] = {}
        for cache_key, entry in self._entries.items():
            sizes[cache_key] = len(entry.instrumental) + len(entry.vocals)
            access[cache_key] = entry.last_accessed_at
        for cache_key, preview in self._previews.items():
            if cache_key in sizes:
                continue
            sizes[cache_key] = len(preview.data)
            access[cache_key] = preview.last_accessed_at
        total = sum(sizes.values())
        if total > limit:
            target = int(limit * 0.9)
            # No-session packages go first, then the least recently used ones.
            order = sorted(
                sizes,
                key=lambda key: (
                    key in self._sessions_by_key,
                    access.get(key, 0.0),
                ),
            )
            for cache_key in order:
                if total <= target:
                    break
                total -= sizes.get(cache_key, 0)
                self._forget(cache_key)
                removed += 1
        return removed

    async def _run_cleanup_periodically(self) -> None:
        while True:
            try:
                self._cleanup_sync()
            except Exception:  # noqa: BLE001
                logger.exception("Karaoke memory cleanup failed")
            await asyncio.sleep(
                max(60, self._settings.karaoke_cleanup_interval_seconds)
            )

    # -- administrator listing --------------------------------------------

    async def list_entries(self) -> KaraokeCacheEntriesResponse:
        items: list[KaraokeCacheEntry] = []
        for cache_key, entry in self._entries.items():
            items.append(
                self._entry_item(cache_key, entry.metadata, entry.last_accessed_at, "ready", len(entry.instrumental) + len(entry.vocals), len(entry.instrumental), len(entry.vocals), 0)
            )
        for cache_key, preview in self._previews.items():
            if cache_key in self._entries:
                continue
            job = self._jobs_by_key.get(cache_key)
            metadata = (
                {
                    "track_file_id": job.track_file_id,
                    "track_title": job.track_title,
                    "artist_name": job.artist_name,
                    "album_name": job.album_name,
                }
                if job is not None
                else {}
            )
            items.append(
                self._entry_item(cache_key, metadata, preview.last_accessed_at, "preview", len(preview.data), 0, 0, len(preview.data))
            )
        items.sort(key=lambda item: item.name.casefold())
        return KaraokeCacheEntriesResponse(items=items, total=len(items))

    def _entry_item(
        self,
        cache_key: str,
        metadata: dict[str, object],
        last_accessed_at: float,
        status: Literal["ready", "preview"],
        size_bytes: int,
        instrumental_size: int,
        vocals_size: int,
        preview_size: int,
    ) -> KaraokeCacheEntry:
        track_title = self._metadata_string(metadata, "track_title")
        source_path = self._metadata_string(metadata, "source_path")
        source_name = Path(source_path).stem if source_path else None
        return KaraokeCacheEntry(
            id=cache_key,
            name=track_title or source_name or cache_key[:12],
            relative_path=cache_key,
            status=status,
            size_bytes=size_bytes,
            instrumental_size_bytes=instrumental_size,
            vocals_size_bytes=vocals_size,
            preview_size_bytes=preview_size,
            created_at=self._metadata_float(metadata, "created_at"),
            last_accessed_at=last_accessed_at,
            track_file_id=self._metadata_string(metadata, "track_file_id"),
            track_title=track_title,
            artist_name=self._metadata_string(metadata, "artist_name"),
            album_name=self._metadata_string(metadata, "album_name"),
        )

    async def delete_entry(self, entry_id: str) -> None:
        cache_key = entry_id.strip()
        if (
            not self._valid_cache_key(cache_key)
            or cache_key not in self._entries
            and cache_key not in self._previews
        ):
            raise ResourceNotFoundError("Karaoke entry not found")
        self._release_key(cache_key)

    # -- responses and streaming ------------------------------------------

    @staticmethod
    def _valid_cache_key(cache_key: str) -> bool:
        return len(cache_key) == 64 and all(c in "0123456789abcdef" for c in cache_key)

    def _preview_url(self, cache_key: str) -> str:
        return f"/api/v1/karaoke/{cache_key}/preview"

    def _response_for_key(
        self, cache_key: str, *, cached: bool, session_id: str | None = None
    ) -> KaraokeJobResponse:
        base = f"/api/v1/karaoke/{cache_key}"
        return KaraokeJobResponse(
            cache_key=cache_key,
            status="ready",
            cached=cached,
            session_id=session_id,
            instrumental_url=f"{base}/instrumental",
            vocals_url=f"{base}/vocals",
            preview_url=self._preview_url(cache_key),
            preview_status=self._preview_status(cache_key),
        )

    def _response_for_job(
        self, job: _Job, *, session_id: str | None = None
    ) -> KaraokeJobResponse:
        if job.status == "ready":
            if job.cache_key in self._entries:
                response = self._response_for_key(
                    job.cache_key, cached=False, session_id=session_id
                )
                response.job_id = job.id
                return response
            job.status = "failed"
            job.error_message = "Karaoke files are no longer available"
        return KaraokeJobResponse(
            job_id=job.id,
            cache_key=job.cache_key,
            status=job.status,
            session_id=session_id,
            preview_url=self._preview_url(job.cache_key),
            preview_status=self._preview_status(job.cache_key),
            error_message=job.error_message,
        )

    def _stream_data(self, cache_key: str, stem: StreamName) -> bytes | None:
        if not self._valid_cache_key(cache_key):
            return None
        if stem == "preview":
            preview = self._previews.get(cache_key)
            return preview.data if preview is not None else None
        entry = self._entries.get(cache_key)
        if entry is None:
            return None
        return entry.instrumental if stem == "instrumental" else entry.vocals

    def _stream_response(
        self, data: bytes, range_header: str | None
    ) -> tuple[AsyncGenerator[bytes, None], dict[str, str], int]:
        size = len(data)
        start, end, status = 0, max(size - 1, 0), 200
        if range_header:
            start, end = self._parse_range(range_header, size)
            status = 206
        length = max(0, end - start + 1)
        headers = {
            "Content-Type": "audio/mp4",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
        }
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return self._iter_bytes(data, start, length), headers, status

    @staticmethod
    async def _iter_bytes(
        data: bytes, offset: int, length: int
    ) -> AsyncGenerator[bytes, None]:
        end = min(offset + length, len(data))
        position = offset
        while position < end:
            chunk_end = min(position + STREAM_CHUNK_SIZE, end)
            yield data[position:chunk_end]
            position = chunk_end

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

    # -- track metadata ----------------------------------------------------

    async def _source_and_cache_key(self, track_file_id: str) -> tuple[Path, str]:
        source_path = await self._local_files.resolve_validated_path(track_file_id)
        stat = await asyncio.to_thread(source_path.stat)
        cache_key = self._cache_key_for_stat(
            source_path, stat.st_size, stat.st_mtime_ns
        )
        return source_path, cache_key

    @staticmethod
    def _cache_key_for_stat(source_path: Path, size: int, mtime_ns: int) -> str:
        return hashlib.sha256(
            f"{source_path}\0{size}\0{mtime_ns}\0{_ENGINE_VERSION}".encode()
        ).hexdigest()

    async def _get_track_metadata(self, track_file_id: str) -> dict | None:
        getter = getattr(self._local_files, "get_karaoke_track_metadata", None)
        if not callable(getter):
            return None
        try:
            result = await getter(track_file_id)
        except Exception:  # noqa: BLE001 - labels are best-effort metadata
            return None
        return result if isinstance(result, dict) else None

    @staticmethod
    def _display_metadata(row: dict | None) -> dict[str, str | None]:
        if not row:
            return {}
        return {
            "track_title": KaraokeService._metadata_string(row, "track_title"),
            "artist_name": KaraokeService._metadata_string(row, "artist_name")
            or KaraokeService._metadata_string(row, "album_artist_name"),
            "album_name": KaraokeService._metadata_string(row, "album_title"),
        }

    @staticmethod
    def _metadata_string(metadata: dict, key: str) -> str | None:
        value = metadata.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else None

    @staticmethod
    def _metadata_float(metadata: dict, key: str) -> float | None:
        value = metadata.get(key)
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None
