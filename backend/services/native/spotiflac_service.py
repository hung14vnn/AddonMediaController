import asyncio
import logging
import shutil
from pathlib import Path

from core.exceptions import PermissionDeniedError, ResourceNotFoundError, ValidationError

logger = logging.getLogger(__name__)

_PROVIDER_FALLBACKS = ["tidal", "qobuz", "deezer", "amazon", "apple"]

_AUDIO_EXTENSIONS = {
    ".flac",
    ".wav",
    ".m4a",
    ".mp3",
    ".aac",
    ".ogg",
    ".opus",
}


def spotiflac_client_options(output_dir: str, quality: str) -> dict[str, object]:
    """Build options supported by the pinned SpotiFLAC client."""
    options: dict[str, object] = {
        "output_dir": output_dir,
        "quality": quality,
        "services": _PROVIDER_FALLBACKS,
    }

    if quality == "LOW":
        options.update(
            allow_fallback=False,
            use_extensions_fallback=False,
        )

    return options


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
            origin=kwargs.get("origin", "user"),
            retry_count=kwargs.get("retry_count", 0),
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
            artist_name=artist_name,
            artist_mbid=kwargs.get("artist_mbid"),
            album_title=kwargs.get("album_title") or "",
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
                artist_mbid=task.artist_mbid,
                **retry_fields,
            )

        return await self.request_album(
            user_id=user_id,
            release_group_mbid=task.release_group_mbid,
            artist_name=task.artist_name,
            album_title=task.album_title,
            artist_mbid=task.artist_mbid,
            **retry_fields,
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

        from SpotiFLAC.client import AsyncSpotiFLAC

        settings = self._prefs.get_spotiflac_connection()

        async with AsyncSpotiFLAC(
            **spotiflac_client_options(
                settings.downloads_mount,
                settings.quality,
            )
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

        task = await self._store.create_task(
            user_id=user_id,
            source="spotiflac",
            download_client="spotiflac",
            status="downloading",
            **task_fields,
        )

        await self._bus.publish(
            f"download:{task.id}",
            "status",
            {"status": "downloading"},
        )

        asyncio.create_task(
            self._download(
                task.id,
                user_id,
                url,
                settings.quality,
                Path(settings.downloads_mount),
            )
        )

        return task.id

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

        staging = output / f".droppedneedle-{task_id}"

        try:
            staging.mkdir(
                parents=True,
                exist_ok=True,
            )

            async with AsyncSpotiFLAC(
                **spotiflac_client_options(
                    str(staging),
                    quality,
                )
            ) as client:
                await client.download_track(url)

            downloaded_files = [
                path
                for path in staging.rglob("*")
                if path.is_file()
                and path.suffix.lower() in _AUDIO_EXTENSIONS
            ]

            if not downloaded_files:
                raise RuntimeError(
                    "No configured SpotiFLAC provider produced an audio file"
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
            await asyncio.to_thread(
                shutil.rmtree,
                staging,
                True,
            )