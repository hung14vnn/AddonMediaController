"""Single-concurrency karaoke generation and bounded two-stem disk cache."""

from __future__ import annotations

import asyncio
import base64
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

from api.v1.schemas.karaoke import (
    KaraokeCacheEntriesResponse,
    KaraokeCacheEntry,
    KaraokeJobResponse,
)
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
    track_file_id: str = ""
    track_title: str | None = None
    artist_name: str | None = None
    album_name: str | None = None
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
                id=uuid.uuid4().hex,
                cache_key=cache_key,
                source_path=source_path,
                track_file_id=track_file_id,
                **self._display_metadata(
                    await self._get_track_metadata(track_file_id)
                ),
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

    async def list_entries(self) -> KaraokeCacheEntriesResponse:
        """List every durable karaoke folder, including pre-metadata folders.

        The current cache has two levels under ``objects`` while older builds
        may have placed entries directly below ``karaoke``. Discovery is based
        on artifact/leaf folders instead of metadata alone so old entries stay
        manageable.
        """
        track_rows = await self._get_track_rows()
        items = await asyncio.to_thread(self._list_entries_sync, track_rows)
        return KaraokeCacheEntriesResponse(items=items, total=len(items))

    async def delete_entry(self, entry_id: str) -> None:
        """Remove one entry previously returned by :meth:`list_entries`."""
        await asyncio.to_thread(self._delete_entry_sync, entry_id)

    def _list_entries_sync(
        self, track_rows: list[dict] | None = None
    ) -> list[KaraokeCacheEntry]:
        root = self._root.resolve()
        if not root.is_dir():
            return []

        track_map = self._track_metadata_by_cache_key(track_rows or [])
        entries: list[KaraokeCacheEntry] = []
        for directory in self._entry_directories_sync(root):
            try:
                relative = directory.relative_to(root).as_posix()
                files = {
                    child.name: child
                    for child in directory.iterdir()
                    if child.is_file()
                }
                metadata_path = files.get("metadata.json")
                try:
                    metadata = (
                        read_json(metadata_path, default={}) if metadata_path else {}
                    )
                except Exception:  # noqa: BLE001 - malformed legacy metadata is manageable
                    metadata = {}
                if not isinstance(metadata, dict):
                    metadata = {}

                instrumental = files.get("instrumental.m4a")
                vocals = files.get("vocals.m4a")
                has_instrumental = instrumental is not None
                has_vocals = vocals is not None
                has_metadata = metadata_path is not None
                if has_instrumental and has_vocals and has_metadata:
                    status = "ready"
                elif has_instrumental and has_vocals:
                    status = "legacy"
                elif has_instrumental or has_vocals or has_metadata:
                    status = "partial"
                else:
                    status = "legacy"

                cache_key = (
                    self._metadata_string(metadata, "cache_key") or directory.name
                )
                matched_track = track_map.get(cache_key, {})
                source_path = self._metadata_string(
                    metadata, "source_path"
                ) or self._metadata_string(matched_track, "file_path")
                track_title = self._metadata_string(
                    metadata, "track_title"
                ) or self._metadata_string(matched_track, "track_title")
                artist_name = self._metadata_string(
                    metadata, "artist_name"
                ) or self._metadata_string(
                    matched_track, "artist_name"
                ) or self._metadata_string(matched_track, "album_artist_name")
                album_name = self._metadata_string(
                    metadata, "album_name"
                ) or self._metadata_string(matched_track, "album_title")
                source_name = Path(source_path).stem if source_path else None
                display_name = track_title or source_name or directory.name

                sizes = [
                    child.stat().st_size
                    for child in files.values()
                    if child.name != "metadata.json"
                ]
                metadata_size = self._metadata_int(metadata, "size_bytes")
                entries.append(
                    KaraokeCacheEntry(
                        id=self._entry_id(relative),
                        name=display_name,
                        relative_path=relative,
                        status=status,
                        size_bytes=metadata_size if metadata_size is not None else sum(sizes),
                        instrumental_size_bytes=(
                            instrumental.stat().st_size if instrumental else 0
                        ),
                        vocals_size_bytes=vocals.stat().st_size if vocals else 0,
                        created_at=self._metadata_float(metadata, "created_at"),
                        last_accessed_at=self._metadata_float(
                            metadata, "last_accessed_at"
                        ),
                        track_file_id=(
                            self._metadata_string(metadata, "track_file_id")
                            or self._metadata_string(matched_track, "id")
                        ),
                        track_title=track_title,
                        artist_name=artist_name,
                        album_name=album_name,
                    )
                )
            except (OSError, ValueError, TypeError):
                # A cache entry can disappear during cleanup. It should not
                # make the whole administrator view fail.
                continue

        entries.sort(key=lambda item: item.relative_path.casefold())
        return entries

    def _delete_entry_sync(self, entry_id: str) -> None:
        root = self._root.resolve()
        candidates = {
            entry.id: entry.relative_path for entry in self._list_entries_sync()
        }
        relative = candidates.get(entry_id)
        if relative is None:
            raise ResourceNotFoundError("Karaoke cache entry not found")

        candidate = (root / Path(relative)).resolve()
        if (
            candidate == root
            or candidate == self._tmp.resolve()
            or candidate == self._objects.resolve()
            or not candidate.is_dir()
            or not candidate.is_relative_to(root)
        ):
            raise ResourceNotFoundError("Karaoke cache entry not found")
        shutil.rmtree(candidate)

    def _entry_directories_sync(self, root: Path) -> list[Path]:
        directories: list[Path] = []
        for directory in root.rglob("*"):
            if not directory.is_dir() or directory.is_symlink():
                continue
            try:
                relative = directory.relative_to(root)
                resolved = directory.resolve()
            except ValueError:
                continue
            if not relative.parts or relative.parts[0] == "tmp":
                continue
            if not resolved.is_relative_to(root):
                continue
            if resolved == self._objects.resolve():
                continue
            try:
                children = list(directory.iterdir())
            except OSError:
                continue
            has_karaoke_artifact = any(
                child.is_file()
                and child.name in {"instrumental.m4a", "vocals.m4a", "metadata.json"}
                for child in children
            )
            has_child_directory = any(child.is_dir() for child in children)
            # ``objects/<prefix>`` is only a sharding container in the current
            # layout. Once its last entry is deleted it must not appear as a
            # phantom legacy track.
            if (
                relative.parts[0] == "objects"
                and len(relative.parts) == 2
                and not has_karaoke_artifact
            ):
                continue
            # Current prefix folders have children but no artifacts. Leaf
            # folders are included even when malformed/empty so they can be
            # cleaned up from the same screen.
            if has_karaoke_artifact or not has_child_directory:
                directories.append(directory)
        return directories

    @staticmethod
    def _metadata_string(metadata: dict, key: str) -> str | None:
        value = metadata.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else None

    def _track_metadata_by_cache_key(self, rows: list[dict]) -> dict[str, dict]:
        matched: dict[str, dict] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            source = self._metadata_string(row, "file_path")
            if not source:
                continue
            try:
                source_path = Path(source).resolve()
                stat = source_path.stat()
                cache_key = self._cache_key_for_stat(
                    source_path, stat.st_size, stat.st_mtime_ns
                )
            except (OSError, ValueError):
                continue
            matched[cache_key] = row
        return matched

    async def _get_track_rows(self) -> list[dict]:
        getter = getattr(self._local_files, "get_karaoke_track_rows", None)
        if not callable(getter):
            return []
        try:
            rows = await getter()
        except Exception:  # noqa: BLE001 - cache listing should remain available
            logger.warning(
                "Could not load library tracks for karaoke cache labels",
                exc_info=True,
            )
            return []
        return rows if isinstance(rows, list) else []

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
    def _metadata_float(metadata: dict, key: str) -> float | None:
        value = metadata.get(key)
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _metadata_int(metadata: dict, key: str) -> int | None:
        value = metadata.get(key)
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _entry_id(relative_path: str) -> str:
        return (
            base64.urlsafe_b64encode(relative_path.encode("utf-8"))
            .decode("ascii")
            .rstrip("=")
        )

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
        cache_key = self._cache_key_for_stat(
            source_path, stat.st_size, stat.st_mtime_ns
        )
        return source_path, cache_key

    @staticmethod
    def _cache_key_for_stat(source_path: Path, size: int, mtime_ns: int) -> str:
        return hashlib.sha256(
            f"{source_path}\0{size}\0{mtime_ns}\0{_ENGINE_VERSION}".encode()
        ).hexdigest()

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
