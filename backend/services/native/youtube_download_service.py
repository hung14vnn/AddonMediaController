"""Direct YouTube audio downloads.

The downloader deliberately does not transcode: yt-dlp writes the selected
audio stream exactly as provided by YouTube.  Completed files are then handed
to the normal drop-import pipeline so metadata can be reviewed and imported.
"""

import asyncio
import json
import logging
import os
import shutil
from collections import deque
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from core.exceptions import ValidationError

logger = logging.getLogger(__name__)

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
_AUDIO_SUFFIXES = {".flac", ".wav", ".m4a", ".mp3", ".aac", ".ogg", ".opus"}
_METADATA_TIMEOUT_SECONDS = 30
_YT_DLP_JS_RUNTIME = "deno:/usr/local/bin/deno"
_POT_PROVIDER_URL = os.environ.get("YOUTUBE_POT_PROVIDER_URL", "").rstrip("/")


def _validate_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _YOUTUBE_HOSTS:
        raise ValidationError("Enter a valid YouTube or youtu.be link")
    # A YouTube "Mix" is an endless, generated radio queue rather than a
    # user-created playlist.  Keep its selected video, but drop the generated
    # queue parameters so yt-dlp downloads one determinate audio file.  Normal
    # playlists (PL..., OL..., etc.) remain untouched and unrestricted.
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if query.get("v") and query.get("list", "").startswith("RD"):
        query.pop("list", None)
        query.pop("start_radio", None)
        return urlunparse(parsed._replace(query=urlencode(query)))
    return url


class YouTubeDownloadService:
    def __init__(self, *, drop_import, download_store, event_bus, staging_root: Path) -> None:  # noqa: ANN001
        self._drop_import = drop_import
        self._store = download_store
        self._bus = event_bus
        self._staging_root = staging_root

    async def preview(self, url: str) -> dict[str, object]:
        """Fetch public video metadata without downloading media."""
        url = _validate_url(url)
        process = await asyncio.create_subprocess_exec(
            # Previewing a playlist must not resolve metadata for every one of
            # its entries.  This leaves the later download unrestricted while
            # making the confirmation request respond promptly.
            "yt-dlp", "--js-runtimes", _YT_DLP_JS_RUNTIME,
            "--flat-playlist", "--dump-single-json", "--skip-download", url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=_METADATA_TIMEOUT_SECONDS
            )
        except TimeoutError as exc:
            await _stop_process(process)
            raise ValidationError(
                "YouTube metadata timed out. Check the server's internet connection and try again."
            ) from exc
        if process.returncode != 0:
            raise ValidationError(_safe_error(stderr, "Could not read YouTube metadata"))
        try:
            info = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ValidationError("yt-dlp returned invalid metadata") from exc
        return _preview(info, url)

    async def download(self, *, user_id: str, url: str) -> str:
        url = _validate_url(url)
        info = await self.preview(url)
        task = await self._store.create_task(
            user_id=user_id,
            source="youtube",
            download_client="yt-dlp",
            download_type="track",
            artist_name=str(info["uploader"] or "YouTube"),
            album_title=str(info["title"]),
            track_title=str(info["title"]),
            search_query=url,
            status="downloading",
        )
        await self._bus.publish(f"download:{task.id}", "status", {"status": "downloading"})
        asyncio.create_task(self._run(task.id, user_id, url))
        return task.id

    async def retry_task(self, task) -> str:  # noqa: ANN001
        if not task.search_query:
            raise ValidationError("The original YouTube link is unavailable for this task")
        return await self.download(user_id=task.user_id, url=task.search_query)

    async def _run(self, task_id: str, user_id: str, url: str) -> None:
        staging = self._staging_root / f"youtube-{task_id}"
        try:
            staging.mkdir(parents=True, exist_ok=True)
            # `bestaudio` chooses YouTube's best audio-only source.  `best` keeps
            # its native codec (for example AAC stays M4A and Opus stays Opus),
            # avoiding a lossy re-encode solely to satisfy a fixed output format.
            process = await asyncio.create_subprocess_exec(
                "yt-dlp", *_download_options(),
                "--format", "bestaudio", "--extract-audio", "--audio-format", "best", "--newline",
                "--output", str(staging / "%(title)s [%(id)s].%(ext)s"), url,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            assert process.stdout is not None
            output = deque[str](maxlen=20)
            async for raw in process.stdout:
                line = raw.decode(errors="replace")
                output.append(line.strip())
                await self._publish_progress(task_id, line)
            if await process.wait() != 0:
                detail = _safe_output_error(output)
                logger.error("yt-dlp failed for YouTube task %s: %s", task_id, detail)
                raise RuntimeError(detail)

            # The general download cancel action marks the task terminal. It
            # cannot reliably stop every remote transfer, but it must prevent a
            # finished subprocess from importing a cancelled file.
            current = await self._store.get_task(task_id)
            if current is not None and current.status == "cancelled":
                return

            files = [path for path in staging.rglob("*") if path.is_file() and path.suffix.lower() in _AUDIO_SUFFIXES]
            if not files:
                raise RuntimeError("YouTube did not provide an audio stream")
            task = await self._store.get_task(task_id)
            await self._drop_import.create_job(
                user_id=user_id, user_name="YouTube", uploads=[(path.name, path) for path in files],
                requested_artist_name=task.artist_name if task else None,
                requested_album_title=task.album_title if task else None,
                requested_track_title=task.track_title if task else None,
            )
            await self._store.update_status(task_id, "completed", files_total=len(files), files_completed=len(files), progress_percent=100)
            await self._bus.publish(f"download:{task_id}", "complete", {"status": "completed"})
        except Exception as exc:  # noqa: BLE001
            logger.exception("YouTube task %s failed", task_id)
            message = str(exc) or "YouTube download failed"
            await self._store.update_status(task_id, "failed", error_message=message)
            await self._bus.publish(f"download:{task_id}", "complete", {"status": "failed", "error": message})
        finally:
            await asyncio.to_thread(shutil.rmtree, staging, True)

    async def _publish_progress(self, task_id: str, line: str) -> None:
        # yt-dlp prints lines such as "[download]  42.1%".  Metadata has no
        # reliable total for every stream, so only publish the percent when known.
        import re
        match = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
        if not match:
            return
        percent = min(99, int(float(match.group(1))))
        await self._store.update_status(task_id, "downloading", progress_percent=percent)
        await self._bus.publish(f"download:{task_id}", "progress", {"progress_percent": percent})


def _preview(info: dict[str, object], url: str) -> dict[str, object]:
    return {
        "url": url,
        "title": str(info.get("title") or "Untitled"),
        "uploader": str(info.get("uploader") or info.get("channel") or ""),
        "duration_seconds": info.get("duration") if isinstance(info.get("duration"), (int, float)) else None,
        "thumbnail": str(info.get("thumbnail") or "") or None,
    }


def _safe_error(stderr: bytes, fallback: str) -> str:
    text = stderr.decode(errors="replace").strip().splitlines()
    return text[-1][:300] if text else fallback


def _download_options() -> list[str]:
    """Configure yt-dlp's current YouTube requirements.

    YouTube returns 403 for mweb media URLs without a per-video GVS Proof of
    Origin token. The provider is internal to the compose network and creates
    one automatically; a direct non-compose install retains yt-dlp defaults.
    """
    # Match a normal browser's TLS fingerprint as well as its YouTube PO token.
    # Some Google Video servers reject Python's default TLS client with 403.
    options = ["--js-runtimes", _YT_DLP_JS_RUNTIME, "--impersonate", "chrome"]
    if _POT_PROVIDER_URL:
        options.extend((
            "--extractor-args", "youtube:player_client=mweb",
            "--extractor-args", f"youtubepot-bgutilhttp:base_url={_POT_PROVIDER_URL}",
        ))
    return options


def _safe_output_error(output: deque[str]) -> str:
    """Return yt-dlp's actionable final line without exposing a full command log."""
    lines = [line for line in output if line]
    for line in reversed(lines):
        if "ERROR:" in line:
            return line.split("ERROR:", 1)[1].strip()[:300]
    return lines[-1][:300] if lines else "yt-dlp could not download this video"


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    """Reap a timed-out subprocess; Windows uses the same terminate API."""
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()
