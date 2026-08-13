"""On-demand, rate-limit-aware LRCLIB fallback for tracks without native lyrics."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict

import httpx

from infrastructure.http.client import HttpClientFactory

logger = logging.getLogger(__name__)
_LRC_TIMESTAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
_MAX_LYRICS_BYTES = 1_048_576
_FOUND_TTL_SECONDS = 7 * 24 * 60 * 60
_MISSING_TTL_SECONDS = 24 * 60 * 60
_REQUEST_GAP_SECONDS = 0.3
_REQUEST_FAILED = object()


class LrclibLyricsService:
    def __init__(self) -> None:
        self._cache: OrderedDict[tuple[str, str, str, int], tuple[float, dict | None]] = OrderedDict()
        self._request_lock = asyncio.Lock()
        self._next_request_at = 0.0

    async def get(self, *, artist: str, title: str, album: str, duration: float | None) -> dict | None:
        if not artist.strip() or not title.strip():
            return None
        key = (artist.casefold().strip(), title.casefold().strip(), album.casefold().strip(), round(duration or 0))
        cached = self._cache.get(key)
        if cached and cached[0] > time.monotonic():
            self._cache.move_to_end(key)
            return cached[1]
        result = await self._fetch(artist, title, album, duration)
        # A transient DNS, timeout, or rate-limit failure is not evidence that
        # lyrics are absent. Do not turn it into a 24-hour negative cache entry.
        if result is _REQUEST_FAILED:
            return None
        self._cache[key] = (time.monotonic() + (_FOUND_TTL_SECONDS if result else _MISSING_TTL_SECONDS), result)
        while len(self._cache) > 512:
            self._cache.popitem(last=False)
        return result

    async def _fetch(self, artist: str, title: str, album: str, duration: float | None) -> dict | None | object:
        async with self._request_lock:
            payload = None
            if album.strip() and duration and duration > 0:
                payload = await self._request("/get", {"artist_name": artist, "track_name": title, "album_name": album, "duration": round(duration)})
                if payload is _REQUEST_FAILED:
                    return _REQUEST_FAILED
            if payload is None:
                matches = await self._request("/search", {"artist_name": artist, "track_name": title})
                if matches is _REQUEST_FAILED:
                    return _REQUEST_FAILED
                payload = self._select_match(matches, artist, title, album, duration)
        return self._normalise(payload)

    async def _request(self, path: str, params: dict) -> dict | list | None | object:
        wait = self._next_request_at - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        client = HttpClientFactory.get_client(name="lrclib-lyrics", timeout=10.0, max_connections=1)
        try:
            response = await client.get(f"https://lrclib.net/api{path}", params=params)
            self._next_request_at = time.monotonic() + _REQUEST_GAP_SECONDS
            if response.status_code == 404:
                logger.info("LRCLIB returned no result for %s", path)
                return None
            if response.status_code == 429:
                try:
                    self._next_request_at = time.monotonic() + max(1, float(response.headers.get("Retry-After", "1")))
                except ValueError:
                    self._next_request_at = time.monotonic() + 1
                return None
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError):
            logger.warning("LRCLIB lyrics lookup failed for %s", path, exc_info=True)
            return _REQUEST_FAILED

    @staticmethod
    def _select_match(matches: dict | list | None, artist: str, title: str, album: str, duration: float | None) -> dict | None:
        if not isinstance(matches, list):
            return None
        def normalise(value: object) -> str:
            return re.sub(r"[^\w]", "", str(value).casefold())
        artist_key, title_key = normalise(artist), normalise(title)
        candidates = [item for item in matches if isinstance(item, dict) and normalise(item.get("artistName")) == artist_key and normalise(item.get("trackName")) == title_key]
        if album:
            album_key = normalise(album)
            candidates.sort(key=lambda item: normalise(item.get("albumName")) != album_key)
        if duration:
            candidates.sort(key=lambda item: abs(float(item.get("duration") or 0) - duration))
        return candidates[0] if candidates else None

    def _normalise(self, payload: dict | list | None) -> dict | None:
        if not isinstance(payload, dict):
            return None
        plain = str(payload.get("plainLyrics") or "")
        synced = str(payload.get("syncedLyrics") or "")
        if len((plain + synced).encode("utf-8")) > _MAX_LYRICS_BYTES:
            return None
        lines = self._parse_lrc(synced)
        if lines:
            return {"text": plain or "\n".join(x["text"] for x in lines), "is_synced": True, "lines": lines, "source": "lrclib"}
        if plain.strip():
            return {"text": plain, "is_synced": False, "lines": [], "source": "lrclib"}
        return None

    @staticmethod
    def _parse_lrc(value: str) -> list[dict]:
        lines: list[dict] = []
        for raw in value.splitlines()[:5000]:
            timestamps = list(_LRC_TIMESTAMP.finditer(raw))
            text = _LRC_TIMESTAMP.sub("", raw).strip()
            for timestamp in timestamps:
                fraction = (timestamp.group(3) or "0").ljust(3, "0")[:3]
                lines.append({"text": text, "start_seconds": int(timestamp.group(1)) * 60 + int(timestamp.group(2)) + int(fraction) / 1000})
        return sorted(lines, key=lambda item: item["start_seconds"])
