import asyncio
import contextlib
import logging
import shutil
import threading
from pathlib import Path

from core.exceptions import PermissionDeniedError, ResourceNotFoundError, ValidationError

logger = logging.getLogger(__name__)

_PROVIDER_FALLBACKS = ["ext:tidal-web", "ext:qobuz-web", "ext:deezer", "ext:amazon"]
_SPOTIFLAC_PROVIDER_TIMEOUT_SECONDS = 150
_SPOTIFLAC_PROGRESS_INTERVAL_SECONDS = 1.0

_AUDIO_EXTENSIONS = {
    ".flac",
    ".wav",
    ".m4a",
    ".mp3",
    ".aac",
    ".ogg",
    ".opus",
}


class _CrossLoopAsyncLock:
    """Serialize SpotiFLAC auth callbacks that run on independent event loops."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    async def __aenter__(self):  # noqa: ANN001 - context manager protocol
        # Do not use ``to_thread(self._lock.acquire)`` here.  Cancelling that
        # await abandons a worker which may later acquire the lock forever.
        while not self._lock.acquire(blocking=False):
            await asyncio.sleep(0.01)
        return self

    async def __aexit__(self, *_exc):  # noqa: ANN001 - context manager protocol
        self._lock.release()


_SPOTIFLAC_AUTH_LOCKS: dict[str, _CrossLoopAsyncLock] = {}
_SPOTIFLAC_AUTH_LOCKS_GUARD = threading.Lock()
_SPOTIFLAC_LOCK_PATCHED = False


def _patch_spotiflac_cross_loop_lock() -> None:
    """Correct SpotiFLAC 3.0.6's loop-bound signed-session auth lock.

    Its JavaScript runtime handles every signed-session callback with a fresh
    ``asyncio.run()`` loop, but the auth module caches one ``asyncio.Lock`` per
    namespace.  Concurrent callbacks therefore reuse a lock bound to another
    loop.  Authentication is process-wide, so a thread-backed async context
    manager matches the actual lifecycle.
    """
    global _SPOTIFLAC_LOCK_PATCHED

    with _SPOTIFLAC_AUTH_LOCKS_GUARD:
        if _SPOTIFLAC_LOCK_PATCHED:
            return

        from SpotiFLAC.core import signed_session_mobile

        def get_auth_lock(namespace: str) -> _CrossLoopAsyncLock:
            with _SPOTIFLAC_AUTH_LOCKS_GUARD:
                lock = _SPOTIFLAC_AUTH_LOCKS.get(namespace)
                if lock is None:
                    lock = _CrossLoopAsyncLock()
                    _SPOTIFLAC_AUTH_LOCKS[namespace] = lock
                return lock

        signed_session_mobile._get_auth_lock = get_auth_lock
        _SPOTIFLAC_LOCK_PATCHED = True


def spotiflac_client_options(output_dir: str, quality: str) -> dict[str, object]:
    """Build options supported by the pinned SpotiFLAC client."""
    options: dict[str, object] = {
        "output_dir": output_dir,
        "quality": quality,
        "services": _PROVIDER_FALLBACKS,
        "sync_extensions": False,
    }

    if quality == "LOW":
        options.update(
            services=["ext:ytmusic-spotiflac"],
            allow_fallback=False,
            use_extensions_fallback=True,
        )

    return options


async def _download_track_with_timeout(  # noqa: ANN001
    client,
    url: str,
    provider: str,
) -> None:
    """Bound one provider so a wedged callback cannot block the fallback chain."""
    try:
        async with asyncio.timeout(_SPOTIFLAC_PROVIDER_TIMEOUT_SECONDS):
            await client.download_track(url)
    except TimeoutError as exc:
        raise RuntimeError(
            f"SpotiFLAC provider {provider} timed out after "
            f"{_SPOTIFLAC_PROVIDER_TIMEOUT_SECONDS} seconds"
        ) from exc


class SpotiflacService:
    def __init__(
        self,
        *,
        drop_import,
        preferences_service,
        download_store,
        event_bus,
    ) -> None:  # noqa: ANN001
        self._drop_import = drop_import
        self._prefs = preferences_service
        self._store = download_store
        self._bus = event_bus

    def is_ready(self) -> bool:
        settings = self._prefs.get_spotiflac_connection()
        path = Path(settings.downloads_mount)

        return settings.enabled and path.is_dir() and path.exists()

    async def request_album(
        self,
        *,
        user_id: str,
        artist_name: str,
        album_title: str,
        release_group_mbid: str,
        **kwargs,
    ) -> str:  # noqa: ANN003
        return await self._start(
            user_id,
            f"{artist_name} {album_title}",
            "albums",
            download_type="album",
            release_group_mbid=release_group_mbid,
            artist_name=artist_name,
            artist_mbid=kwargs.get("artist_mbid"),
            album_title=album_title,
            cover_url=kwargs.get("cover_url"),
            origin=kwargs.get("origin", "user"),
            retry_count=kwargs.get("retry_count", 0),
            year=kwargs.get("year"),
            track_count=kwargs.get("track_count"),
        )

    async def request_track(
        self,
        *,
        user_id: str,
        artist_name: str,
        track_title: str,
        recording_mbid: str,
        **kwargs,
    ) -> str:  # noqa: ANN003
        return await self._start(
            user_id,
            f"{artist_name} {track_title}",
            "tracks",
            download_type="track",
            recording_mbid=recording_mbid,
            release_group_mbid=kwargs.get("release_group_mbid") or "",
            artist_name=artist_name,
            artist_mbid=kwargs.get("artist_mbid"),
            album_title=kwargs.get("album_title") or "",
            cover_url=kwargs.get("cover_url"),
            track_title=track_title,
            origin=kwargs.get("origin", "user"),
            retry_count=kwargs.get("retry_count", 0),
        )

    async def retry_task(
        self,
        task_id: str,
        user_id: str,
        user_role: str,
    ) -> str:
        """Create a new SpotiFLAC task for an eligible failed task."""
        task = await self._store.get_task(task_id)

        if task is None:
            raise ResourceNotFoundError("Download task not found")

        if user_role != "admin" and task.user_id != user_id:
            raise PermissionDeniedError("Cannot retry another user's download")

        if task.source != "spotiflac":
            raise ValidationError("This is not a SpotiFLAC download")

        if task.status not in ("failed", "cancelled", "partial"):
            raise ValidationError(
                "Only failed, cancelled or partial downloads can be retried"
            )

        retry_fields = {
            "origin": "retry",
            "retry_count": task.retry_count + 1,
        }

        if task.download_type == "track":
            return await self.request_track(
                user_id=user_id,
                recording_mbid=task.recording_mbid or "",
                artist_name=task.artist_name,
                track_title=task.track_title or task.album_title,
                album_title=task.album_title,
                release_group_mbid=task.release_group_mbid,
                artist_mbid=task.artist_mbid,
                cover_url=task.cover_url,
                **retry_fields,
            )

        return await self.request_album(
            user_id=user_id,
            release_group_mbid=task.release_group_mbid,
            artist_name=task.artist_name,
            album_title=task.album_title,
            artist_mbid=task.artist_mbid,
            cover_url=task.cover_url,
            **retry_fields,
        )

    async def retry_from_task(self, task) -> str:  # noqa: ANN001 - DownloadTask
        """Continue a failed non-SpotiFLAC task through SpotiFLAC."""
        if task.download_type == "track":
            return await self.request_track(
                user_id=task.user_id,
                recording_mbid=task.recording_mbid or "",
                artist_name=task.artist_name,
                track_title=task.track_title or task.album_title,
                album_title=task.album_title,
                release_group_mbid=task.release_group_mbid,
                artist_mbid=task.artist_mbid,
                cover_url=task.cover_url,
                origin="retry",
                retry_count=task.retry_count + 1,
            )
        return await self.request_album(
            user_id=task.user_id,
            release_group_mbid=task.release_group_mbid,
            artist_name=task.artist_name,
            album_title=task.album_title,
            artist_mbid=task.artist_mbid,
            cover_url=task.cover_url,
            origin="retry",
            retry_count=task.retry_count + 1,
        )

    async def retry_all_failed(
        self,
        user_id: str,
        user_role: str,
    ) -> int:
        """Retry this user's failed SpotiFLAC tasks through SpotiFLAC itself."""
        tasks = await self._store.list_tasks_by_status(
            user_id,
            user_role,
            ["failed"],
        )

        retried = 0

        for task in tasks:
            if task.source != "spotiflac":
                continue

            await self.retry_task(task.id, user_id, user_role)
            retried += 1

        return retried

    async def _start(
        self,
        user_id: str,
        query: str,
        result_kind: str,
        **task_fields,
    ) -> str:  # noqa: ANN003
        if not self.is_ready():
            raise ValidationError(
                "SpotiFLAC is not enabled or its downloads mount is unavailable"
            )

        settings = self._prefs.get_spotiflac_connection()
        task = await self._store.create_task(
            user_id=user_id,
            source="spotiflac",
            download_client="spotiflac",
            status="queued",
            **task_fields,
        )

        await self._bus.publish(
            f"download:{task.id}",
            "status",
            {"status": "queued", "source": "spotiflac"},
        )

        asyncio.create_task(
            self._resolve_and_download(
                task.id,
                user_id,
                query,
                result_kind,
                settings.quality,
                Path(settings.downloads_mount),
            )
        )

        return task.id

    async def _resolve_and_download(
        self,
        task_id: str,
        user_id: str,
        query: str,
        result_kind: str,
        quality: str,
        output: Path,
    ) -> None:
        """Resolve the Spotify URL after the task is visible in the queue."""
        try:
            from SpotiFLAC.client import AsyncSpotiFLAC

            _patch_spotiflac_cross_loop_lock()
            async with AsyncSpotiFLAC(
                **spotiflac_client_options(str(output), quality)
            ) as client:
                results = await client.search(query, limit=5)

            match = next(iter(results.get(result_kind) or []), None)
            if match is None:
                raise ValidationError(
                    "SpotiFLAC could not find a Spotify match for this request"
                )

            url = (
                match.external_url
                if result_kind == "tracks"
                else match.get("external_url")
            )
            if not url:
                raise ValidationError(
                    "SpotiFLAC returned a result without a Spotify URL"
                )

            task = await self._store.get_task(task_id)
            if task is not None and task.status == "cancelled":
                return

            await self._store.update_status(task_id, "downloading")
            await self._bus.publish(
                f"download:{task_id}",
                "status",
                {"status": "downloading", "source": "spotiflac"},
            )
            await self._download(task_id, user_id, url, quality, output)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface background lookup failures
            logger.exception("SpotiFLAC task %s lookup failed", task_id)
            err_msg = str(exc) or "SpotiFLAC task failed"
            await self._store.update_status(
                task_id,
                "failed",
                error_message=err_msg,
            )
            await self._bus.publish(
                f"download:{task_id}",
                "complete",
                {"status": "failed", "error": err_msg},
            )

    async def _convert_to_m4a(self, source: Path) -> Path:
        """Convert an audio file to AAC 256 kbps M4A."""
        extension = source.suffix.lower()

        # M4A is already in the desired container.
        if extension == ".m4a":
            return source

        # Keep MP3 as-is to avoid lossy -> lossy transcoding.
        if extension == ".mp3":
            return source

        target = source.with_suffix(".m4a")

        logger.info(
            "Converting %s to AAC 256 kbps M4A",
            source.name,
        )

        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-map_metadata",
            "0",
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
            str(target),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        _, stderr = await process.communicate()

        if process.returncode != 0:
            error = stderr.decode(errors="replace")

            raise RuntimeError(
                f"FFmpeg conversion failed for {source.name}: {error}"
            )

        if not target.exists() or target.stat().st_size == 0:
            raise RuntimeError(
                f"FFmpeg did not produce a valid output for {source.name}"
            )

        logger.info(
            "Converted %s -> %s (%.2f MB)",
            source.name,
            target.name,
            target.stat().st_size / 1024 / 1024,
        )

        return target

    async def _download(
        self,
        task_id: str,
        user_id: str,
        url: str,
        quality: str,
        output: Path,
    ) -> None:
        from SpotiFLAC.client import AsyncSpotiFLAC

        _patch_spotiflac_cross_loop_lock()

        staging = output / f".droppedneedle-{task_id}"
        progress_task: asyncio.Task | None = None

        try:
            staging.mkdir(
                parents=True,
                exist_ok=True,
            )
            progress_task = asyncio.create_task(
                self._watch_progress(task_id, staging)
            )

            downloaded_files: list[Path] = []
            provider_errors: list[str] = []

            # SpotiFLAC runs its own provider chain inside one call.  A wedged
            # signed-session callback prevents that call from ever advancing to
            # the next extension, so isolate each provider behind its own
            # deadline and client lifecycle.
            for provider in _PROVIDER_FALLBACKS:
                await self._bus.publish(
                    f"download:{task_id}",
                    "status",
                    {
                        "status": "downloading",
                        "source": "spotiflac",
                        "provider": provider,
                    },
                )
                options = spotiflac_client_options(str(staging), quality)
                options.update(
                    services=[provider],
                    allow_fallback=False,
                )

                try:
                    async with AsyncSpotiFLAC(**options) as client:
                        await _download_track_with_timeout(client, url, provider)
                except Exception as exc:  # noqa: BLE001 - isolate third-party provider
                    error = str(exc) or type(exc).__name__
                    provider_errors.append(f"{provider}: {error}")
                    logger.warning(
                        "SpotiFLAC provider %s failed for task %s: %s",
                        provider,
                        task_id,
                        error,
                    )

                downloaded_files = [
                    path
                    for path in staging.rglob("*")
                    if path.is_file()
                    and path.suffix.lower() in _AUDIO_EXTENSIONS
                ]
                if downloaded_files:
                    break

            if not downloaded_files:
                raise RuntimeError(
                    "No configured SpotiFLAC provider produced an audio file"
                    + (f" ({'; '.join(provider_errors)})" if provider_errors else "")
                )

            files: list[Path] = []

            for path in downloaded_files:
                converted = await self._convert_to_m4a(path)
                files.append(converted)

            if not files:
                raise RuntimeError(
                    "SpotiFLAC did not produce a supported audio file"
                )

            task = await self._store.get_task(task_id)

            await self._drop_import.create_job(
                user_id=user_id,
                user_name="SpotiFLAC",
                uploads=[
                    (path.name, path)
                    for path in files
                ],
                release_group_mbid=(
                    task.release_group_mbid
                    if task
                    else None
                ),
                recording_mbid=(
                    task.recording_mbid
                    if task
                    else None
                ),
                requested_artist_name=(
                    task.artist_name
                    if task
                    else None
                ),
                requested_artist_mbid=(
                    task.artist_mbid
                    if task
                    else None
                ),
                requested_album_title=(
                    task.album_title
                    if task
                    else None
                ),
                requested_track_title=(
                    task.track_title
                    if task
                    else None
                ),
                requested_cover_url=(
                    task.cover_url
                    if task
                    else None
                ),
            )

            await self._store.update_status(
                task_id,
                "completed",
                files_total=len(files),
                files_completed=len(files),
                progress_percent=100,
            )

            await self._bus.publish(
                f"download:{task_id}",
                "complete",
                {"status": "completed"},
            )

        except Exception as e:
            logger.exception(
                "SpotiFLAC task %s failed",
                task_id,
            )

            err_msg = str(e) or "SpotiFLAC task failed"

            await self._store.update_status(
                task_id,
                "failed",
                error_message=err_msg,
            )

            await self._bus.publish(
                f"download:{task_id}",
                "complete",
                {
                    "status": "failed",
                    "error": err_msg,
                },
            )

        finally:
            if progress_task is not None:
                progress_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await progress_task
            await asyncio.to_thread(
                shutil.rmtree,
                staging,
                True,
            )

    async def _watch_progress(self, task_id: str, staging: Path) -> None:
        """Report best-effort progress while SpotiFLAC writes its output.

        SpotiFLAC does not expose a callback through its async client. The staging
        directory is private to this task, so its file sizes provide a safe live
        byte counter even when the provider writes a temporary extension first.
        The total size is intentionally left unknown; the UI renders this as an
        indeterminate transfer until the import completes.
        """
        previous: tuple[int, int] | None = None
        while True:
            await asyncio.sleep(_SPOTIFLAC_PROGRESS_INTERVAL_SECONDS)
            try:
                files = [path for path in staging.rglob("*") if path.is_file()]
                bytes_downloaded = sum(path.stat().st_size for path in files)
                audio_files = [
                    path
                    for path in files
                    if path.suffix.lower() in _AUDIO_EXTENSIONS
                ]
                snapshot = (bytes_downloaded, len(audio_files))
                if snapshot == previous:
                    continue
                previous = snapshot

                task = await self._store.get_task(task_id)
                files_total = int(
                    getattr(task, "track_count", None)
                    or (1 if getattr(task, "download_type", None) == "track" else 0)
                )
                progress_percent = (
                    min(99, int(len(audio_files) * 100 / files_total))
                    if files_total
                    else 0
                )
                await self._store.update_status(
                    task_id,
                    "downloading",
                    downloaded_bytes=bytes_downloaded,
                    files_total=files_total,
                    files_completed=min(len(audio_files), files_total)
                    if files_total
                    else len(audio_files),
                    progress_percent=progress_percent,
                )
                await self._bus.publish(
                    f"download:{task_id}",
                    "progress",
                    {
                        "source": "spotiflac",
                        "bytes_downloaded": bytes_downloaded,
                        "bytes_total": 0,
                        "files_completed": len(audio_files),
                        "files_total": files_total,
                        "progress_percent": progress_percent,
                    },
                )
            except (FileNotFoundError, OSError):
                # A provider can replace a temporary file between the scan and
                # stat; the next tick will observe the new file.
                continue
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - progress must never stop the download
                logger.debug(
                    "SpotiFLAC progress probe failed for task %s",
                    task_id,
                    exc_info=True,
                )
