"""YouTube Music audio streaming via yt-dlp.

Searches YouTube Music for a track by artist + title, extracts the direct
audio stream URL (without downloading) and proxies the audio bytes back to
the browser.

``title`` / ``artist`` on the returned :class:`StreamInfo` are always the
metadata the caller passed in.  YouTube's own title/uploader are kept in
``source_title`` / ``source_artist`` for logging and debugging only.

Extracted URLs are cached for ``_URL_TTL_SECONDS`` (YouTube playback URLs
usually expire after ~4-6 hours).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from typing import AsyncIterator, Callable, TypeVar

import httpx
from yt_dlp import YoutubeDL

logger = logging.getLogger(__name__)

T = TypeVar("T")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_CACHE_MAX_ENTRIES = 200
_URL_TTL_SECONDS = 2 * 3600
_EXTRACT_TIMEOUT_SECONDS = 30
_PROXY_CHUNK_SIZE = 64 * 1024  # 64 KiB

_UPSTREAM_RETRY_STATUSES = frozenset({401, 403, 410})
_STREAM_RESPONSE_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")
_HEAD_RESPONSE_HEADERS = ("Content-Type", "Content-Length", "Accept-Ranges")

_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)

_MV_WORDS = r"(official\s+)?(music\s+video|video|mv|m/v|visualizer|audio\s+video)"
_MV_REGEX = re.compile(
    rf"\b{_MV_WORDS}\b|[\[\(]\s*(official\s+)?(mv|m/v|music\s+video|video|visualizer)\s*[\]\)]",
    re.IGNORECASE,
)
_MV_WORDS_REGEX = re.compile(rf"\b{_MV_WORDS}\b", re.IGNORECASE)
_BRACKETS_REGEX = re.compile(r"[\(\[].*?[\)\]]")
_WHITESPACE_REGEX = re.compile(r"\s+")

_YDL_BASE_OPTIONS: dict[str, object] = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    # The production image already includes Node for YouTube's JS challenges.
    "js_runtimes": {"node": {}},
}
_YDL_FLAT_OPTIONS: dict[str, object] = {**_YDL_BASE_OPTIONS, "extract_flat": True}
_YDL_AUDIO_OPTIONS: dict[str, object] = {
    **_YDL_BASE_OPTIONS,
    "extract_flat": False,
    "skip_download": True,
    "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
}


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StreamInfo:
    """Resolved metadata + audio URL for one YouTube Music track."""

    video_id: str
    title: str  # caller-supplied (falls back to YouTube's title)
    artist: str  # caller-supplied (falls back to YouTube's uploader)
    duration_s: float | None
    thumbnail: str | None
    audio_url: str
    content_type: str
    http_headers: dict[str, str] = field(default_factory=dict)
    source_title: str = ""  # what YouTube calls the video
    source_artist: str = ""  # YouTube uploader / channel

    def with_metadata(self, title: str | None, artist: str | None) -> StreamInfo:
        """Return a copy whose title/artist are overridden when given."""
        title = (title or "").strip()
        artist = (artist or "").strip()
        if not title and not artist:
            return self
        return replace(self, title=title or self.title, artist=artist or self.artist)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


class _StreamCache:
    """LRU + TTL cache keyed by ``video_id`` with a secondary search-key index."""

    def __init__(self, max_entries: int, ttl_seconds: float) -> None:
        self._max = max_entries
        self._ttl = ttl_seconds
        self._entries: OrderedDict[str, tuple[StreamInfo, float]] = OrderedDict()
        self._search_to_vid: dict[str, str] = {}
        self._vid_to_searches: dict[str, set[str]] = {}

    @staticmethod
    def search_key(artist: str, track: str) -> str:
        return f"{artist.lower().strip()}|{track.lower().strip()}"

    def get_by_video_id(self, video_id: str) -> StreamInfo | None:
        item = self._entries.get(video_id)
        if item is None:
            return None
        info, created_at = item
        if time.monotonic() - created_at >= self._ttl:
            self.evict(video_id)
            return None
        self._entries.move_to_end(video_id)
        return info

    def get_by_search(self, key: str) -> StreamInfo | None:
        video_id = self._search_to_vid.get(key)
        return self.get_by_video_id(video_id) if video_id else None

    def put(self, info: StreamInfo, search_key: str | None = None) -> None:
        self._entries[info.video_id] = (info, time.monotonic())
        self._entries.move_to_end(info.video_id)
        if search_key:
            self._search_to_vid[search_key] = info.video_id
            self._vid_to_searches.setdefault(info.video_id, set()).add(search_key)
        while len(self._entries) > self._max:
            oldest, _ = self._entries.popitem(last=False)
            self._drop_search_keys(oldest)

    def evict(self, video_id: str) -> None:
        self._entries.pop(video_id, None)
        self._drop_search_keys(video_id)

    def _drop_search_keys(self, video_id: str) -> None:
        for key in self._vid_to_searches.pop(video_id, ()):
            self._search_to_vid.pop(key, None)


# ---------------------------------------------------------------------------
# yt-dlp backend (blocking; always run in a worker thread)
# ---------------------------------------------------------------------------


class _YtDlp:
    """Thin, synchronous wrapper around yt-dlp."""

    @staticmethod
    def _to_stream_info(info: dict, video_id: str) -> StreamInfo | None:
        audio_url = info.get("url")
        if not audio_url:
            return None
        source_title = str(info.get("title") or "Unknown")
        source_artist = str(info.get("uploader") or info.get("channel") or "Unknown")
        return StreamInfo(
            video_id=video_id,
            title=source_title,
            artist=source_artist,
            duration_s=info.get("duration"),
            thumbnail=str(info.get("thumbnail") or "") or None,
            audio_url=str(audio_url),
            content_type=str(info.get("audio_ext") or "webm"),
            http_headers=dict(info.get("http_headers") or {}),
            source_title=source_title,
            source_artist=source_artist,
        )

    @staticmethod
    def extract_video(video_id: str) -> StreamInfo | None:
        """Extract the audio URL for a known YouTube Music video."""
        url = f"https://music.youtube.com/watch?v={video_id}"
        with YoutubeDL(_YDL_AUDIO_OPTIONS) as ydl:
            info = ydl.extract_info(url, download=False)
        return _YtDlp._to_stream_info(info, video_id) if isinstance(info, dict) else None

    @staticmethod
    def _music_search_candidates(query: str) -> list[tuple[str, str]]:
        """Flat-search YouTube Music, return ``(video_id, title)`` candidates."""
        search_url = f"https://music.youtube.com/search?q={urllib.parse.quote(query)}"
        with YoutubeDL(_YDL_FLAT_OPTIONS) as ydl:
            try:
                info = ydl.extract_info(search_url, download=False)
            except Exception as exc:  # noqa: BLE001
                logger.warning("YouTube Music flat search failed for %r: %s", query, exc)
                return []

        entries = info.get("entries") if isinstance(info, dict) else None
        candidates: list[tuple[str, str]] = []
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            vid = entry.get("id")
            # Watch entries have 11-char IDs; skip browse/channel/playlist IDs.
            if isinstance(vid, str) and len(vid) == 11 and not vid.startswith(("UC", "VL", "MP")):
                candidates.append((vid, entry.get("title") or ""))
        return candidates

    @staticmethod
    def search(query: str) -> StreamInfo | None:
        """Find the best audio match for *query*.

        1. YouTube Music search, preferring titles without music-video keywords
           (studio audio, no video intros).
        2. Fallback: plain ``ytsearch1`` with an "audio" hint.
        """
        candidates = _YtDlp._music_search_candidates(query)
        if candidates:
            preferred = next((vid for vid, title in candidates if not _MV_REGEX.search(title)), None)
            video_id = preferred or candidates[0][0]
            result = _YtDlp.extract_video(video_id)
            if result is not None:
                return result

        fallback_query = f"{query} audio"
        with YoutubeDL({**_YDL_AUDIO_OPTIONS, "default_search": "ytsearch1"}) as ydl:
            try:
                info = ydl.extract_info(fallback_query, download=False)
            except Exception as exc:  # noqa: BLE001
                logger.warning("YouTube fallback search failed for %r: %s", fallback_query, exc)
                return None

        if not isinstance(info, dict):
            return None
        entries = info.get("entries")
        if isinstance(entries, list) and entries:
            info = entries[0]
        if not isinstance(info, dict) or not info.get("id"):
            return None
        return _YtDlp._to_stream_info(info, str(info["id"]))


def _clean_mv_title(title: str) -> str:
    """Strip '(Official MV)', 'Music Video', ... from a YouTube title."""
    cleaned = _BRACKETS_REGEX.sub("", title)
    cleaned = _MV_WORDS_REGEX.sub("", cleaned)
    return _WHITESPACE_REGEX.sub(" ", cleaned).strip()


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class YTMusicStreamService:
    """Search YouTube Music and proxy audio streams."""

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._http = http_client
        self._cache = _StreamCache(_CACHE_MAX_ENTRIES, _URL_TTL_SECONDS)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def search(self, artist: str, track: str) -> StreamInfo:
        """Find *track* by *artist* on YouTube Music and return stream info.

        The returned ``title``/``artist`` are exactly *track*/*artist* as
        passed in (YouTube's values live in ``source_title``/``source_artist``).

        Raises ``ValueError`` when no match is found.
        """
        key = _StreamCache.search_key(artist, track)
        cached = self._cache.get_by_search(key)
        if cached is not None:
            return cached

        query = f"{artist} {track}".strip()
        result = await self._run_blocking(_YtDlp.search, query, what="search")
        if result is None:
            label = f"'{artist} - {track}'" if artist else f"'{track}'"
            raise ValueError(f"No result found for {label}")

        info = result.with_metadata(title=track, artist=artist)
        self._cache.put(info, search_key=key)
        return info

    def evict_by_video_id(self, video_id: str) -> None:
        """Drop every cached entry for *video_id*."""
        self._cache.evict(video_id)

    async def proxy_stream(
        self,
        video_id: str,
        range_header: str | None = None,
        *,
        title: str | None = None,
        artist: str | None = None,
    ) -> tuple[AsyncIterator[bytes], dict[str, str], int]:
        """Proxy the audio bytes for *video_id*.

        Returns ``(chunks_iterator, response_headers, status_code)``; the
        caller wraps these in a ``StreamingResponse``.  Pass *title*/*artist*
        so the caller's metadata survives a cache miss (e.g. server restart).
        """
        info = await self._resolve(video_id, title, artist)
        upstream = await self._open_upstream("GET", info, range_header)

        resp_headers = _pick_headers(upstream.headers, _STREAM_RESPONSE_HEADERS)

        async def _chunks() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_bytes(_PROXY_CHUNK_SIZE):
                    yield chunk
            finally:
                await upstream.aclose()

        return _chunks(), resp_headers, upstream.status_code  # 200 or 206

    async def proxy_head(
        self,
        video_id: str,
        *,
        title: str | None = None,
        artist: str | None = None,
    ) -> dict[str, str]:
        """Return metadata headers for *video_id* without a body."""
        info = await self._resolve(video_id, title, artist)
        upstream = await self._open_upstream("HEAD", info)
        try:
            return _pick_headers(upstream.headers, _HEAD_RESPONSE_HEADERS)
        finally:
            await upstream.aclose()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _resolve(self, video_id: str, title: str | None, artist: str | None) -> StreamInfo:
        """Return cached info for *video_id*, extracting on a miss."""
        info = self._cache.get_by_video_id(video_id)
        if info is None:
            info = (await self._extract_by_video_id(video_id)).with_metadata(title, artist)
            self._cache.put(info)
            return info
        return info.with_metadata(title, artist)

    async def _open_upstream(
        self,
        method: str,
        info: StreamInfo,
        range_header: str | None = None,
    ) -> httpx.Response:
        """Open the upstream audio URL.

        On 401/403/410 (expired or invalidated URL) the cache entry is evicted,
        a fresh URL is extracted once and the request retried.  Any other
        4xx/5xx raises ``httpx.HTTPStatusError``.
        """
        for attempt in (1, 2):
            req = self._http.build_request(
                method, info.audio_url, headers=_upstream_headers(info, range_header)
            )
            upstream = await self._http.send(req, stream=True)

            if upstream.status_code in _UPSTREAM_RETRY_STATUSES and attempt == 1:
                await upstream.aclose()
                logger.warning(
                    "Upstream %s returned %s for cached audio URL (%s); re-extracting",
                    method,
                    upstream.status_code,
                    info.video_id,
                )
                self._cache.evict(info.video_id)
                fresh = await self._extract_by_video_id(info.video_id)
                info = fresh.with_metadata(info.title, info.artist)
                self._cache.put(info)
                continue

            if upstream.status_code >= 400:
                await upstream.aclose()
                self._cache.evict(info.video_id)
                raise httpx.HTTPStatusError(
                    f"Upstream returned {upstream.status_code}",
                    request=req,
                    response=upstream,
                )
            return upstream

        raise AssertionError("unreachable")  # pragma: no cover

    async def _extract_by_video_id(self, video_id: str) -> StreamInfo:
        """Extract the audio URL for *video_id*, upgrading MV videos to studio audio."""
        result = await self._run_blocking(_YtDlp.extract_video, video_id, what="extraction")
        if result is None:
            raise ValueError(f"Could not extract audio for video {video_id}")

        if _MV_REGEX.search(result.source_title):
            result = await self._upgrade_mv_to_audio(result)
        return result

    async def _upgrade_mv_to_audio(self, mv: StreamInfo) -> StreamInfo:
        """Try to swap an MV's audio URL for the matching studio track's."""
        clean_title = _clean_mv_title(mv.source_title)
        if mv.source_artist and mv.source_artist.lower() not in clean_title.lower():
            query = f"{mv.source_artist} {clean_title}".strip()
        else:
            query = clean_title

        try:
            clean = await self._run_blocking(_YtDlp.search, query, what="search")
        except Exception as exc:  # noqa: BLE001
            logger.debug("Failed to upgrade MV %s to clean audio: %s", mv.video_id, exc)
            return mv

        if clean is None or clean.video_id == mv.video_id:
            return mv

        logger.info(
            "Upgraded MV %s (%r) to studio audio %s (%r)",
            mv.video_id, mv.source_title, clean.video_id, clean.source_title,
        )
        # Keep the requested video_id so the caller's URL stays stable.
        return replace(
            clean,
            video_id=mv.video_id,
            thumbnail=clean.thumbnail or mv.thumbnail,
        )

    @staticmethod
    async def _run_blocking(fn: Callable[..., T], *args: object, what: str) -> T:
        """Run a blocking yt-dlp call in a worker thread with a timeout."""
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(fn, *args), timeout=_EXTRACT_TIMEOUT_SECONDS
            )
        except TimeoutError as exc:
            raise ValueError(f"YouTube Music {what} timed out") from exc


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _upstream_headers(info: StreamInfo, range_header: str | None = None) -> dict[str, str]:
    headers = {"User-Agent": info.http_headers.get("User-Agent") or _DEFAULT_USER_AGENT}
    if range_header:
        headers["Range"] = range_header
    return headers


def _pick_headers(source: httpx.Headers, keys: tuple[str, ...]) -> dict[str, str]:
    return {k: v for k in keys if (v := source.get(k))}