import asyncio
import contextlib
import logging
import shutil
from pathlib import Path

from core.exceptions import PermissionDeniedError, ResourceNotFoundError, ValidationError

logger = logging.getLogger(__name__)

_PROVIDER_FALLBACKS = ["ext:tidal-web", "ext:qobuz-web", "ext:deezer", "ext:amazon"]
_LOSSY_PROVIDERS = ["ext:ytmusic-spotiflac"]
_MORNYE_PROVIDER_TIMEOUT_SECONDS = 150
_MORNYE_PROGRESS_INTERVAL_SECONDS = 1.0

_AUDIO_EXTENSIONS = {
    ".flac",
    ".wav",
    ".m4a",
    ".mp3",
    ".aac",
    ".ogg",
    ".opus",
}


def mornye_client_options(output_dir: str, quality: str) -> dict[str, object]:
    """Build options supported by the pinned Mornye client."""
    options: dict[str, object] = {
        "output_dir": output_dir,
        "quality": quality,
        "services": _PROVIDER_FALLBACKS,
        "sync_extensions": True,
        "timeout_s": _MORNYE_PROVIDER_TIMEOUT_SECONDS,
    }

    if quality == "LOW":
        options.update(
            services=_LOSSY_PROVIDERS,
            allow_fallback=False,
        )

    return options


def _spotify_url_from_id(value: str | None) -> str | None:
    """Return a Spotify URL for ``spotify:track:…``/``spotify:album:…`` IDs."""
    if not value or not value.startswith("spotify:"):
        return None
    _, kind, item_id = value.split(":", 2)
    if kind not in {"track", "album"} or not item_id:
        return None
    return f"https://open.spotify.com/{kind}/{item_id}"


def _result_external_url(match) -> str | None:  # noqa: ANN001 - search result dict
    if isinstance(match, dict):
        external = match.get("external_urls") or {}
        return external.get("spotify") if isinstance(external, dict) else None
    return None


async def _search_spotify_url(query: str, result_kind: str) -> str | None:
    """Resolve a free-text query to a Spotify album or track URL.

    Uses the application's own public Spotify catalog client: Mornye's
    built-in Spotify metadata client is supplied by an optional utilities
    extension, while its ``spotify-web`` extension already handles the
    actual link resolution during the download.
    """
    from services.spotapi_client import SpotApiClient

    client = SpotApiClient()
    if result_kind == "albums":
        results, _ = await client.search_albums(query, limit=5)
    else:
        results, _ = await client.search_tracks(query, limit=5)

    match = next(iter(results or []), None)
    return _result_external_url(match)


class MornyeService:
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
        settings = self._prefs.get_mornye_connection()
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
            _spotify_url_from_id(release_group_mbid)
            or f"{artist_name} {album_title}",
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
        spotify_track_id = kwargs.get("spotify_track_id")
        spotify_url = (
            f"https://open.spotify.com/track/{spotify_track_id}"
            if spotify_track_id
            else _spotify_url_from_id(recording_mbid)
        )
        return await self._start(
            user_id,
            spotify_url or f"{artist_name} {track_title}",
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
        """Create a new Mornye task for an eligible failed task."""
        task = await self._store.get_task(task_id)

        if task is None:
            raise ResourceNotFoundError("Download task not found")

        if user_role != "admin" and task.user_id != user_id:
            raise PermissionDeniedError("Cannot retry another user's download")

        if task.source != "mornye":
            raise ValidationError("This is not a Mornye download")

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
        """Continue a failed non-Mornye task through Mornye."""
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
        """Retry this user's failed Mornye tasks through Mornye itself."""
        tasks = await self._store.list_tasks_by_status(
            user_id,
            user_role,
            ["failed"],
        )

        retried = 0

        for task in tasks:
            if task.source != "mornye":
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
                "Mornye is not enabled or its downloads mount is unavailable"
            )

        settings = self._prefs.get_mornye_connection()
        task = await self._store.create_task(
            user_id=user_id,
            source="mornye",
            download_client="mornye",
            status="queued",
            **task_fields,
        )

        await self._bus.publish(
            f"download:{task.id}",
            "status",
            {"status": "queued", "source": "mornye"},
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
            if query.startswith("https://open.spotify.com/"):
                url = query
            else:
                url = await _search_spotify_url(query, result_kind)
            if not url:
                raise ValidationError(
                    "Mornye could not find a Spotify match for this request"
                )

            task = await self._store.get_task(task_id)
            if task is not None and task.status == "cancelled":
                return

            await self._store.update_status(task_id, "downloading")
            await self._bus.publish(
                f"download:{task_id}",
                "status",
                {"status": "downloading", "source": "mornye"},
            )
            await self._download(task_id, user_id, url, quality, output)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface background lookup failures
            logger.exception("Mornye task %s lookup failed", task_id)
            err_msg = str(exc) or "Mornye task failed"
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

    async def _convert_to_m4a(self, source: Path, quality: str) -> Path:
        """Convert lossless audio to AAC 256 kbps M4A when requested."""
        # HIGH and LOW already request a lossy/smaller provider result.  A
        # second lossy conversion is unnecessary and can reject otherwise
        # valid FLAC artifacts produced by an extension, so preserve the
        # provider file as-is for every non-lossless quality.
        if quality != "LOSSLESS":
            return source

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
            # FFmpeg can leave a zero-byte or partial target behind when the
            # input is an encrypted/provider artifact.  Do not let that file
            # be mistaken for a successful conversion on a later retry.
            with contextlib.suppress(OSError):
                target.unlink()

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
        from mornye import AsyncMornye

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

            provider_errors: list[str] = []
            conversion_errors: list[str] = []
            files: list[Path] = []
            providers = _LOSSY_PROVIDERS if quality == "LOW" else _PROVIDER_FALLBACKS

            for provider in providers:
                await self._bus.publish(
                    f"download:{task_id}",
                    "status",
                    {
                        "status": "downloading",
                        "source": "mornye",
                        "provider": provider,
                    },
                )
                options = mornye_client_options(str(staging), quality)
                options.update(
                    services=[provider],
                    allow_fallback=False,
                )

                try:
                    async with AsyncMornye(**options) as client:
                        failed_tracks = await client.download_track(url)
                    if failed_tracks:
                        provider_errors.append(
                            f"{provider}: {len(failed_tracks)} track(s) failed"
                        )
                except Exception as exc:  # noqa: BLE001 - isolate third-party provider
                    error = str(exc) or type(exc).__name__
                    provider_errors.append(f"{provider}: {error}")
                    logger.warning(
                        "Mornye provider %s failed for task %s: %s",
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
                if not downloaded_files:
                    continue

                # A provider can report success while leaving only an
                # encrypted/provider artifact.  Validate immediately so that
                # the next provider gets a chance to supply a usable file.
                for path in sorted(downloaded_files):
                    if path.stem.casefold().endswith(".encrypted"):
                        error = "encrypted provider artifact"
                        conversion_errors.append(f"{path.name}: {error}")
                        logger.warning(
                            "Skipping unusable Mornye audio artifact %s for task %s: %s",
                            path.name,
                            task_id,
                            error,
                        )
                        with contextlib.suppress(OSError):
                            path.unlink()
                        continue
                    try:
                        converted = await self._convert_to_m4a(path, quality)
                    except Exception as exc:  # noqa: BLE001 - validate provider artifacts
                        error = str(exc) or type(exc).__name__
                        conversion_errors.append(f"{path.name}: {error}")
                        logger.warning(
                            "Skipping unusable Mornye audio artifact %s for task %s: %s",
                            path.name,
                            task_id,
                            error,
                        )
                        with contextlib.suppress(OSError):
                            path.unlink()
                        continue
                    files.append(converted)
                    if converted != path:
                        with contextlib.suppress(OSError):
                            path.unlink()

                if files:
                    break

            if not files:
                raise RuntimeError(
                    "Mornye did not produce a usable audio file"
                    + (
                        f" ({'; '.join(provider_errors + conversion_errors)})"
                        if provider_errors or conversion_errors
                        else ""
                    )
                )

            task = await self._store.get_task(task_id)

            await self._drop_import.create_job(
                user_id=user_id,
                user_name="Mornye",
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
                "Mornye task %s failed",
                task_id,
            )

            err_msg = str(e) or "Mornye task failed"

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
        previous: tuple[int, int] | None = None
        while True:
            await asyncio.sleep(_MORNYE_PROGRESS_INTERVAL_SECONDS)
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
                        "source": "mornye",
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
                    "Mornye progress probe failed for task %s",
                    task_id,
                    exc_info=True,
                )
