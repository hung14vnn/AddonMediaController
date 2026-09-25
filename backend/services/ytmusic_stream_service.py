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
from ytmusicapi import YTMusic

logger = logging.getLogger(__name__)

T = TypeVar("T")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_CACHE_MAX_ENTRIES = 200
_URL_TTL_SECONDS = 2 * 3600
_EXTRACT_TIMEOUT_SECONDS = 30
_PROXY_CHUNK_SIZE = 128 * 1024  # 128 KiB

_UPSTREAM_RETRY_STATUSES = frozenset({401, 403, 410})
_STREAM_RESPONSE_HEADERS = ("Content-Type", "Content-Range", "Accept-Ranges")
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
_YDL_OPUS_OPTIONS: dict[str, object] = {
    **_YDL_BASE_OPTIONS,
    "extract_flat": False,
    "skip_download": True,
    "format": "bestaudio/best",
    "format_sort": ["abr", "acodec:opus", "ext"],
}
# Callers ask for m4a because they advertise audio/mp4 (Subsonic song Child) or
# play on AVPlayer, which cannot decode WebM/Opus. Sorting by abr first let the
# higher-bitrate Opus stream win, so filter to m4a before ranking by bitrate.
_YDL_M4A_OPTIONS: dict[str, object] = {
    **_YDL_BASE_OPTIONS,
    "extract_flat": False,
    "skip_download": True,
    "format": "bestaudio[ext=m4a]/bestaudio/best",
    "format_sort": ["abr", "acodec:m4a", "ext"],
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
    def extract_video(video_id: str, fmt: str = "opus") -> StreamInfo | None:
        """Extract the audio URL for a known YouTube Music video."""
        url = f"https://music.youtube.com/watch?v={video_id}"
        options = _YDL_M4A_OPTIONS if fmt == "m4a" else _YDL_OPUS_OPTIONS
        with YoutubeDL(options) as ydl:
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
    def search(query: str, fmt: str = "opus") -> StreamInfo | None:
        """Find the best audio match for *query*.

        1. YouTube Music search, preferring titles without music-video keywords
           (studio audio, no video intros).
        2. Fallback: plain ``ytsearch1`` with an "audio" hint.
        """
        candidates = _YtDlp._music_search_candidates(query)
        if candidates:
            preferred = next((vid for vid, title in candidates if not _MV_REGEX.search(title)), None)
            video_id = preferred or candidates[0][0]
            result = _YtDlp.extract_video(video_id, fmt)
            if result is not None:
                return result

        fallback_query = f"{query} audio"
        options = {**(_YDL_M4A_OPTIONS if fmt == "m4a" else _YDL_OPUS_OPTIONS), "default_search": "ytsearch1"}
        with YoutubeDL(options) as ydl:
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

    async def search(self, artist: str, track: str, fmt: str = "opus") -> StreamInfo:
        """Find *track* by *artist* on YouTube Music and return stream info.

        The returned ``title``/``artist`` are exactly *track*/*artist* as
        passed in (YouTube's values live in ``source_title``/``source_artist``).

        Raises ``ValueError`` when no match is found.
        """
        key = _StreamCache.search_key(artist, track) + f":{fmt}"
        cached = self._cache.get_by_search(key)
        if cached is not None:
            return cached

        query = f"{artist} {track}".strip()
        result = await self._run_blocking(_YtDlp.search, query, fmt, what="search")
        if result is None:
            label = f"'{artist} - {track}'" if artist else f"'{track}'"
            raise ValueError(f"No result found for {label}")

        info = result.with_metadata(title=track, artist=artist)
        self._cache.put(info, search_key=key)
        return info

    async def _get_radio_for_video_cached(self, video_id: str, limit: int = 25) -> list[dict]:
        """Fetch Radio (mix) tracks for a video_id, using a short-lived in-memory cache."""
        if not hasattr(self, "_radio_cache"):
            self._radio_cache = OrderedDict()

        if video_id in self._radio_cache:
            entry, timestamp = self._radio_cache[video_id]
            if time.monotonic() - timestamp < 3600:
                self._radio_cache.move_to_end(video_id)
                return entry

        def _fetch():
            yt = getattr(self, "_yt_client", None) or YTMusic()
            return yt.get_watch_playlist(videoId=video_id, radio=True, limit=limit)

        try:
            wl = await self._run_blocking(_fetch, what="smart discover radio")
            if not isinstance(wl, dict) or not wl.get("tracks"):
                return []

            tracks = wl["tracks"]
            self._radio_cache[video_id] = (tracks, time.monotonic())
            while len(self._radio_cache) > 100:
                self._radio_cache.popitem(last=False)

            return tracks
        except Exception as e:
            logger.warning("YTMusic radio failed for video_id %r: %s", video_id, e)
            return []

    async def get_smart_discover(self, video_ids: list[str], limit: int = 15) -> list[dict]:
        """Fetch Radio tracks for multiple seeds and interleave them for diversity."""
        from collections import Counter

        seen = set(video_ids)
        seeds = video_ids[-5:]
        if not seeds:
            return []

        results = await asyncio.gather(*(self._get_radio_for_video_cached(vid, limit=25) for vid in seeds))

        score: Counter = Counter()
        info: dict[str, dict] = {}
        per_seed_lists: list[list[str]] = []

        for tracks in results:
            seed_vids = []
            for t in tracks:
                vid = t.get("videoId")
                if not vid or vid in seen:
                    continue
                score[vid] += 1
                info[vid] = t
                seed_vids.append(vid)
            per_seed_lists.append(seed_vids)

        # Within each seed's list, put higher-overlap tracks first
        for seed_vids in per_seed_lists:
            seed_vids.sort(key=lambda v: score[v], reverse=True)

        # Round-robin across seeds so no single seed dominates the result
        merged: list[dict] = []
        used: set[str] = set()
        idx = 0
        while len(merged) < limit and any(idx < len(lst) for lst in per_seed_lists):
            for seed_vids in per_seed_lists:
                if idx < len(seed_vids):
                    vid = seed_vids[idx]
                    if vid not in used:
                        used.add(vid)
                        merged.append(info[vid])
                        if len(merged) >= limit:
                            break
            idx += 1

        return merged

    async def get_artist_top_songs(self, artist_name: str, limit: int = 50) -> list[dict]:
        """Fetch top songs for an artist from YouTube Music."""
        def _fetch():
            yt = getattr(self, "_yt_client", None) or YTMusic()
            res = yt.search(artist_name, filter="artists", limit=1)
            if not res:
                return []
            artist_info = yt.get_artist(res[0]["browseId"])
            songs = artist_info.get("songs")
            if not songs:
                return []
            if songs.get("browseId") and limit > len(songs.get("results", [])):
                try:
                    full = yt.get_playlist(songs["browseId"], limit=limit)
                    return full.get("tracks", songs.get("results", []))
                except Exception:
                    return songs.get("results", [])
            return songs.get("results", [])

        try:
            tracks = await self._run_blocking(_fetch, what="artist top songs")
            return tracks[:limit] if tracks else []
        except Exception as e:
            logger.warning("YTMusic top songs failed for %r: %s", artist_name, e)
            return []

    async def get_chart_songs(self, country: str = "VN", limit: int = 20) -> list[dict]:
        """Tracks of the country's YouTube Music trending chart.

        Prefers the "Trending 20 <country>" playlist (only some regions have one),
        then the daily top music videos chart; unknown regions fall back to VN.
        """
        def _fetch():
            yt = getattr(self, "_yt_client", None) or YTMusic()
            charts = yt.get_charts(country) or {}
            playlists = charts.get("videos") or []
            if not playlists and country != "VN":
                playlists = (yt.get_charts("VN") or {}).get("videos") or []
            if not playlists:
                return []
            pick = next(
                (p for p in playlists if str(p.get("title", "")).lower().startswith("trending")),
                None,
            ) or next(
                (p for p in playlists if "daily" in str(p.get("title", "")).lower()),
                playlists[0],
            )
            return yt.get_playlist(pick["playlistId"], limit=limit).get("tracks") or []

        try:
            tracks = await self._run_blocking(_fetch, what="trending chart")
            return tracks[:limit] if tracks else []
        except Exception as e:
            logger.warning("YTMusic trending chart failed for %r: %s", country, e)
            return []

    async def get_chart_playlists(self, country: str = "VN", limit: int = 10) -> list[dict]:
        """Playlists of the country's YouTube Music trending chart."""
        def _fetch():
            yt = getattr(self, "_yt_client", None) or YTMusic()
            def get_vids(c):
                ch = yt.get_charts(c) or {}
                return ch.get("videos") or []

            playlists = get_vids(country)
            if country != "ZZ":
                playlists.extend(get_vids("ZZ"))
            if country != "US":
                playlists.extend(get_vids("US"))
            if country != "VN":
                playlists.extend(get_vids("VN"))

            seen = set()
            result = []
            for p in playlists:
                pid = p.get("playlistId")
                if pid and pid not in seen:
                    seen.add(pid)
                    result.append(p)
                    
            return result[:limit]

        try:
            return await self._run_blocking(_fetch, what="trending playlists")
        except Exception as e:
            logger.warning("YTMusic trending playlists failed for %r: %s", country, e)
            return []

    async def get_radio_playlists(self, limit: int = 15) -> list[dict]:
        """Fetch YouTube Music radio and mix playlists."""
        def _fetch():
            yt = getattr(self, "_yt_client", None) or YTMusic()
            # Searching for 'mix' or 'radio' returns YouTube Music's auto-generated mixes
            return yt.search("mix", filter="playlists", limit=limit) or []

        try:
            return await self._run_blocking(_fetch, what="radio playlists")
        except Exception as e:
            logger.warning("YTMusic radio playlists failed: %s", e)
            return []

    def evict_by_video_id(self, video_id: str) -> None:
        """Drop every cached entry for *video_id*."""
        self._cache.evict(f"{video_id}:opus")
        self._cache.evict(f"{video_id}:m4a")

    async def proxy_stream(
        self,
        video_id: str,
        range_header: str | None = None,
        *,
        title: str | None = None,
        artist: str | None = None,
        fmt: str = "opus",
    ) -> tuple[AsyncIterator[bytes], dict[str, str], int]:
        """Proxy the audio bytes for *video_id*.

        Returns ``(chunks_iterator, response_headers, status_code)``; the
        caller wraps these in a ``StreamingResponse``.  Pass *title*/*artist*
        so the caller's metadata survives a cache miss (e.g. server restart).
        """
        info = await self._resolve(video_id, title, artist, fmt)
        upstream = await self._open_upstream("GET", info, range_header, fmt)

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
        fmt: str = "opus",
    ) -> dict[str, str]:
        """Return metadata headers for *video_id* without a body."""
        info = await self._resolve(video_id, title, artist, fmt)
        upstream = await self._open_upstream("HEAD", info, None, fmt)
        try:
            return _pick_headers(upstream.headers, _HEAD_RESPONSE_HEADERS)
        finally:
            await upstream.aclose()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _resolve(self, video_id: str, title: str | None, artist: str | None, fmt: str) -> StreamInfo:
        """Return cached info for *video_id*, extracting on a miss."""
        cache_key = f"{video_id}:{fmt}"
        info = self._cache.get_by_video_id(cache_key)
        if info is None:
            info = (await self._extract_by_video_id(video_id, fmt)).with_metadata(title, artist)
            info = replace(info, video_id=cache_key) # Hack to store in cache correctly
            self._cache.put(info)
            return replace(info, video_id=video_id)
        return replace(info.with_metadata(title, artist), video_id=video_id)

    async def _open_upstream(
        self,
        method: str,
        info: StreamInfo,
        range_header: str | None = None,
        fmt: str = "opus",
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
            # googlevideo answers 302 to hand the request to another edge node.
            # httpx does not follow redirects by default, and a 3xx passes the
            # >= 400 check below, so the client would receive the redirect's
            # empty HTML body as "audio".
            upstream = await self._http.send(req, stream=True, follow_redirects=True)

            if upstream.status_code in _UPSTREAM_RETRY_STATUSES and attempt == 1:
                await upstream.aclose()
                logger.warning(
                    "Upstream %s returned %s for cached audio URL (%s); re-extracting",
                    method,
                    upstream.status_code,
                    info.video_id,
                )
                self._cache.evict(f"{info.video_id}:{fmt}")
                fresh = await self._extract_by_video_id(info.video_id, fmt)
                fresh_info = fresh.with_metadata(info.title, info.artist)
                self._cache.put(replace(fresh_info, video_id=f"{info.video_id}:{fmt}"))
                info = fresh_info
                continue

            if upstream.status_code >= 400:
                await upstream.aclose()
                self._cache.evict(f"{info.video_id}:{fmt}")
                raise httpx.HTTPStatusError(
                    f"Upstream returned {upstream.status_code}",
                    request=req,
                    response=upstream,
                )
            return upstream

        raise AssertionError("unreachable")  # pragma: no cover

    async def _extract_by_video_id(self, video_id: str, fmt: str) -> StreamInfo:
        """Extract the audio URL for *video_id*, upgrading MV videos to studio audio."""
        result = await self._run_blocking(_YtDlp.extract_video, video_id, fmt, what="extraction")
        if result is None:
            raise ValueError(f"Could not extract audio for video {video_id}")

        if _MV_REGEX.search(result.source_title):
            result = await self._upgrade_mv_to_audio(result, fmt)
        return result

    async def _upgrade_mv_to_audio(self, mv: StreamInfo, fmt: str) -> StreamInfo:
        """Try to swap an MV's audio URL for the matching studio track's."""
        clean_title = _clean_mv_title(mv.source_title)
        if mv.source_artist and mv.source_artist.lower() not in clean_title.lower():
            query = f"{mv.source_artist} {clean_title}".strip()
        else:
            query = clean_title

        try:
            clean = await self._run_blocking(_YtDlp.search, query, fmt, what="search")
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