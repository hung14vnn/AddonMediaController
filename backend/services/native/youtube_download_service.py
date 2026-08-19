"""Direct YouTube audio downloads using pytubefix."""

import asyncio
import logging
import os
import shutil
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from pytubefix import Playlist, YouTube
from pytubefix.exceptions import SABRError

from core.exceptions import ValidationError

logger = logging.getLogger(__name__)

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
_AUDIO_SUFFIXES = {".flac", ".wav", ".m4a", ".mp3", ".aac", ".ogg", ".opus"}
_METADATA_TIMEOUT_SECONDS = 30
_PYTUBEFIX_CLIENT = "WEB"
_POT_PENDING_RETRY_SECONDS = 2
_YOUTUBE_USE_OAUTH = os.environ.get("YOUTUBE_USE_OAUTH", "").lower() in {
    "1",
    "true",
    "yes",
}
_YOUTUBE_OAUTH_TOKEN_FILE = os.environ.get(
    "YOUTUBE_OAUTH_TOKEN_FILE", "/app/cache/pytubefix-youtube-oauth.json"
)


def _validate_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _YOUTUBE_HOSTS:
        raise ValidationError("Enter a valid YouTube or youtu.be link")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    # A YouTube Mix is an endless, generated radio queue. Keep its selected
    # video, but discard generated queue parameters before pytubefix sees them.
    if query.get("v") and query.get("list", "").startswith("RD"):
        query.pop("list", None)
        query.pop("start_radio", None)
        return urlunparse(parsed._replace(query=urlencode(query)))
    return url


class YouTubeDownloadService:
    def __init__(
        self, *, drop_import, download_store, event_bus, staging_root: Path
    ) -> None:  # noqa: ANN001
        self._drop_import = drop_import
        self._store = download_store
        self._bus = event_bus
        self._staging_root = staging_root

    async def preview(self, url: str) -> dict[str, object]:
        """Fetch public metadata for the selected video without downloading it."""
        url = _validate_url(url)
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_preview_for_url, url),
                timeout=_METADATA_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise ValidationError(
                "YouTube metadata timed out. Check the server's internet connection and try again."
            ) from exc
        except Exception as exc:  # noqa: BLE001
            logger.info("pytubefix metadata lookup failed: %s", exc)
            raise ValidationError("Could not read YouTube metadata") from exc

    async def download(self, *, user_id: str, url: str) -> str:
        url = _validate_url(url)
        info = await self.preview(url)
        task = await self._store.create_task(
            user_id=user_id,
            source="youtube",
            download_client="pytubefix",
            download_type="track",
            artist_name=str(info["uploader"] or "YouTube"),
            album_title=str(info["title"]),
            track_title=str(info["title"]),
            search_query=url,
            status="downloading",
        )
        await self._bus.publish(
            f"download:{task.id}", "status", {"status": "downloading"}
        )
        asyncio.create_task(self._run(task.id, user_id, url))
        return task.id

    async def retry_task(self, task) -> str:  # noqa: ANN001
        if not task.search_query:
            raise ValidationError(
                "The original YouTube link is unavailable for this task"
            )
        return await self.download(user_id=task.user_id, url=task.search_query)

    async def _run(self, task_id: str, user_id: str, url: str) -> None:
        staging = self._staging_root / f"youtube-{task_id}"
        try:
            staging.mkdir(parents=True, exist_ok=True)
            loop = asyncio.get_running_loop()
            await asyncio.to_thread(self._download_audio, url, staging, task_id, loop)

            # A cancel cannot always halt an in-flight remote transfer, but it
            # must prevent a completed transfer from being imported afterward.
            current = await self._store.get_task(task_id)
            if current is not None and current.status == "cancelled":
                return

            files = [
                path
                for path in staging.rglob("*")
                if path.is_file() and path.suffix.lower() in _AUDIO_SUFFIXES
            ]
            if not files:
                raise RuntimeError("YouTube did not provide an M4A audio stream")
            task = await self._store.get_task(task_id)
            await self._drop_import.create_job(
                user_id=user_id,
                user_name="YouTube",
                uploads=[(path.name, path) for path in files],
                requested_artist_name=task.artist_name if task else None,
                requested_album_title=task.album_title if task else None,
                requested_track_title=task.track_title if task else None,
            )
            await self._store.update_status(
                task_id,
                "completed",
                files_total=len(files),
                files_completed=len(files),
                progress_percent=100,
            )
            await self._bus.publish(
                f"download:{task_id}", "complete", {"status": "completed"}
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("YouTube task %s failed", task_id)
            message = str(exc) or "YouTube download failed"
            await self._store.update_status(task_id, "failed", error_message=message)
            await self._bus.publish(
                f"download:{task_id}",
                "complete",
                {"status": "failed", "error": message},
            )
        finally:
            await asyncio.to_thread(shutil.rmtree, staging, True)

    def _download_audio(
        self, url: str, staging: Path, task_id: str, loop: asyncio.AbstractEventLoop
    ) -> None:
        for index, video_url in enumerate(_video_urls(url), start=1):
            filename = f"youtube-{index}.m4a"
            for attempt in range(2):
                video = _new_video(
                    video_url,
                    on_progress_callback=lambda stream,
                    _chunk,
                    remaining: _schedule_progress(
                        loop,
                        self._publish_progress,
                        task_id,
                        stream.filesize,
                        remaining,
                    ),
                )
                stream = (
                    video.streams.filter(only_audio=True, mime_type="audio/mp4")
                    .order_by("abr")
                    .desc()
                    .first()
                )
                if stream is None:
                    raise RuntimeError("YouTube did not provide an M4A audio stream")
                try:
                    # audio/mp4 is M4A-compatible; use .m4a so the importer
                    # recognizes the native stream without a lossy conversion.
                    stream.download(output_path=str(staging), filename=filename)
                    break
                except SABRError as exc:
                    if attempt or "PoToken PENDING" not in str(exc):
                        raise
                    # pytubefix can return a stream before its automatically
                    # generated PO token has propagated. Retry once with a
                    # fresh client/token rather than importing a partial file.
                    logger.info("PO token is pending; retrying YouTube stream once")
                    (staging / filename).unlink(missing_ok=True)
                    time.sleep(_POT_PENDING_RETRY_SECONDS)

    async def _publish_progress(
        self, task_id: str, total_bytes: int | None, bytes_remaining: int
    ) -> None:
        if not total_bytes:
            return
        percent = min(99, int((total_bytes - bytes_remaining) * 100 / total_bytes))
        await self._store.update_status(
            task_id, "downloading", progress_percent=percent
        )
        await self._bus.publish(
            f"download:{task_id}", "progress", {"progress_percent": percent}
        )


def _preview_for_url(url: str) -> dict[str, object]:
    video_url = next(iter(_video_urls(url)), url)
    video = _new_video(video_url)
    return {
        "url": url,
        "title": str(video.title or "Untitled"),
        "uploader": str(video.author or ""),
        "duration_seconds": video.length,
        "thumbnail": str(video.thumbnail_url or "") or None,
    }


def _video_urls(url: str) -> list[str]:
    query = dict(parse_qsl(urlparse(url).query, keep_blank_values=True))
    if query.get("list") and not query.get("v"):
        return list(Playlist(url).video_urls)
    return [url]


def _new_video(url: str, *, on_progress_callback=None):  # noqa: ANN001
    """Create a pytubefix client with an optional browser-issued PO token."""
    options = {"client": _PYTUBEFIX_CLIENT}
    if on_progress_callback is not None:
        options["on_progress_callback"] = on_progress_callback
    if _YOUTUBE_USE_OAUTH:
        options.update(
            use_oauth=True,
            allow_oauth_cache=True,
            token_file=_YOUTUBE_OAUTH_TOKEN_FILE,
        )
    return YouTube(url, **options)


def _schedule_progress(
    loop, callback, task_id: str, total_bytes: int | None, bytes_remaining: int
) -> None:  # noqa: ANN001
    asyncio.run_coroutine_threadsafe(
        callback(task_id, total_bytes, bytes_remaining), loop
    )
