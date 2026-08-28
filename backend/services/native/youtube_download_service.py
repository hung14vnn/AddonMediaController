"""Direct YouTube audio downloads using yt-dlp."""

import asyncio
import hashlib
import logging
import shutil
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from core.exceptions import ValidationError

logger = logging.getLogger(__name__)

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
_AUDIO_SUFFIXES = {".flac", ".wav", ".m4a", ".mp3", ".aac", ".ogg", ".opus"}
_METADATA_TIMEOUT_SECONDS = 30
_M4A_FORMAT = "bestaudio[ext=m4a]"
_YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v={}"


def _validate_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _YOUTUBE_HOSTS:
        raise ValidationError("Enter a valid YouTube or youtu.be link")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    # A YouTube Mix is an endless, generated radio queue. Keep its selected
    # video, but discard generated queue parameters before the extractor sees them.
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
            logger.info("yt-dlp metadata lookup failed: %s", exc)
            raise ValidationError("Could not read YouTube metadata") from exc

    async def download(
        self,
        *,
        user_id: str,
        url: str,
        artist_name: str | None = None,
        track_title: str | None = None,
    ) -> str:
        url = _validate_url(url)
        info = await self.preview(url)
        release_group_mbid, recording_mbid = _youtube_local_ids(url)
        resolved_artist_name = (artist_name or "").strip() or str(
            info["uploader"] or "YouTube"
        )
        resolved_track_title = (track_title or "").strip() or str(info["title"])
        task = await self._store.create_task(
            user_id=user_id,
            source="youtube",
            download_client="yt-dlp",
            download_type="track",
            release_group_mbid=release_group_mbid,
            recording_mbid=recording_mbid,
            artist_name=resolved_artist_name,
            album_title=resolved_track_title,
            track_title=resolved_track_title,
            cover_url=str(info.get("thumbnail") or "") or None,
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
        return await self.download(
            user_id=task.user_id,
            url=task.search_query,
            artist_name=task.artist_name,
            track_title=task.track_title,
        )

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
                release_group_mbid=task.release_group_mbid if task else None,
                recording_mbid=task.recording_mbid if task else None,
                requested_artist_name=task.artist_name if task else None,
                requested_album_title=task.album_title if task else None,
                requested_track_title=task.track_title if task else None,
                requested_cover_url=task.cover_url if task else None,
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
            options = _ydl_options(
                noplaylist=True,
                format=_M4A_FORMAT,
                outtmpl=str(staging / "%(title).200B [%(id)s].%(ext)s"),
                progress_hooks=[
                    lambda progress: _schedule_progress(
                        loop,
                        self._publish_progress,
                        task_id,
                        progress,
                    )
                ],
            )
            try:
                with YoutubeDL(options) as ydl:
                    ydl.download([video_url])
            except DownloadError as exc:
                if "Requested format is not available" in str(exc):
                    raise RuntimeError(
                        "YouTube did not provide an M4A audio stream"
                    ) from exc
                raise

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
    with YoutubeDL(_ydl_options(noplaylist=True, skip_download=True)) as ydl:
        video = ydl.extract_info(video_url, download=False)
    if not isinstance(video, dict):
        raise RuntimeError("YouTube metadata was unavailable")
    return {
        "url": url,
        "title": str(video.get("title") or "Untitled"),
        "uploader": str(video.get("uploader") or video.get("channel") or ""),
        "duration_seconds": video.get("duration"),
        "thumbnail": str(video.get("thumbnail") or "") or None,
    }


def _video_urls(url: str) -> list[str]:
    query = dict(parse_qsl(urlparse(url).query, keep_blank_values=True))
    if query.get("list") and not query.get("v"):
        with YoutubeDL(
            _ydl_options(extract_flat=True, noplaylist=False, skip_download=True)
        ) as ydl:
            playlist = ydl.extract_info(url, download=False)
        entries = playlist.get("entries") if isinstance(playlist, dict) else None
        urls = [_entry_url(entry) for entry in entries or []]
        return [entry_url for entry_url in urls if entry_url]
    return [url]


def _entry_url(entry) -> str | None:  # noqa: ANN001
    if not isinstance(entry, dict):
        return None
    webpage_url = entry.get("webpage_url")
    if isinstance(webpage_url, str) and webpage_url.startswith(("http://", "https://")):
        return webpage_url
    video_id = entry.get("id")
    if isinstance(video_id, str) and video_id:
        return _YOUTUBE_WATCH_URL.format(video_id)
    entry_url = entry.get("url")
    return (
        entry_url
        if isinstance(entry_url, str) and entry_url.startswith("http")
        else None
    )


def _youtube_local_ids(url: str) -> tuple[str, str]:
    """Build stable library-only IDs without pretending they are MusicBrainz IDs."""
    parsed = urlparse(url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    video_id = query.get("v")
    if not video_id and parsed.hostname == "youtu.be":
        video_id = parsed.path.strip("/").split("/", 1)[0]
    identity = video_id or query.get("list")
    if not identity:
        identity = hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]
    return f"youtube:album:{identity}", f"youtube:track:{identity}"


def _ydl_options(**overrides) -> dict[str, object]:  # noqa: ANN003
    """Return quiet, server-safe yt-dlp Python API options."""
    options: dict[str, object] = {
        "quiet": True,
        "no_warnings": True,
        # The production image already includes Node for YouTube's JS challenges.
        "js_runtimes": {"node": {}},
    }
    options.update(overrides)
    return options


def _schedule_progress(
    loop, callback, task_id: str, progress: dict[str, object]
) -> None:  # noqa: ANN001
    if progress.get("status") != "downloading":
        return
    total_bytes = progress.get("total_bytes") or progress.get("total_bytes_estimate")
    downloaded_bytes = progress.get("downloaded_bytes")
    if not isinstance(total_bytes, (int, float)) or not isinstance(
        downloaded_bytes, (int, float)
    ):
        return
    asyncio.run_coroutine_threadsafe(
        callback(
            task_id, int(total_bytes), max(0, int(total_bytes - downloaded_bytes))
        ),
        loop,
    )
