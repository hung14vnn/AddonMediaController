"""Async adapter around SpotAPI's unauthenticated public catalog API.

SpotAPI is synchronous and returns Spotify's Pathfinder/GraphQL response shape.
The rest of the application already speaks in terms of Spotify Web API-shaped
objects, so this module keeps that boundary in one place and moves the blocking
library calls off the event loop.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, Callable


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, Mapping):
        return []
    raw = value.get("items") or []
    return [_mapping(item) for item in raw if isinstance(item, Mapping)]


def _id_from_uri(value: Any) -> str:
    text = str(value or "").strip()
    if ":" in text:
        return text.rsplit(":", 1)[-1]
    if "/" in text:
        return text.rstrip("/").rsplit("/", 1)[-1]
    return text


def _spotify_id(item: Mapping[str, Any], kind: str) -> str:
    return _id_from_uri(item.get("id") or item.get("uri") or item.get("link"))


def _unwrap_data(value: Any) -> dict[str, Any]:
    """Unwrap a Pathfinder search item or a playlist-style track wrapper."""
    current = _mapping(value)
    for key in ("item", "track", "album", "artist"):
        nested = current.get(key)
        if isinstance(nested, Mapping):
            current = _mapping(nested)
    if isinstance(current.get("data"), Mapping):
        current = _mapping(current["data"])
    return current


def _artist_items(value: Any) -> list[dict[str, Any]]:
    container = _mapping(value)
    result: list[dict[str, Any]] = []
    for raw in _items(container):
        item = _unwrap_data(raw)
        profile = _mapping(item.get("profile"))
        name = profile.get("name") or item.get("name") or ""
        artist_id = _spotify_id(item, "artist")
        if name or artist_id:
            result.append(
                {
                    "id": artist_id,
                    "name": str(name),
                    "external_urls": (
                        {"spotify": f"https://open.spotify.com/artist/{artist_id}"}
                        if artist_id
                        else {}
                    ),
                }
            )
    return result


def _images(value: Any) -> list[dict[str, Any]]:
    container = _mapping(value)
    sources = container.get("sources")
    if not isinstance(sources, list):
        nested = _mapping(container.get("image"))
        nested_data = _mapping(nested.get("data")) or _mapping(container.get("data"))
        sources = nested_data.get("sources")
    if not isinstance(sources, list):
        return []
    return [
        {
            "url": str(source.get("url")),
            "width": source.get("width") or source.get("maxWidth"),
            "height": source.get("height") or source.get("maxHeight"),
        }
        for source in sources
        if isinstance(source, Mapping) and source.get("url")
    ]


def _release_date(item: Mapping[str, Any]) -> str | None:
    date = _mapping(item.get("date") or item.get("releaseDate"))
    value = date.get("isoString") or date.get("isoDate") or date.get("date")
    if value:
        return str(value).split("T", 1)[0]
    year = date.get("year")
    month = date.get("month")
    day = date.get("day")
    if year:
        if month and day:
            return f"{year}-{int(month):02d}-{int(day):02d}"
        return str(year)
    value = item.get("release_date")
    return str(value) if value else None


def _external_ids(item: Mapping[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in _items(item.get("externalIds") or item.get("external_ids")):
        key = str(entry.get("type") or "").lower()
        value = str(entry.get("value") or "").strip()
        if key and value:
            result[key] = value
    return result


def _track_item(value: Any) -> dict[str, Any]:
    item = _unwrap_data(value)
    album = _mapping(item.get("albumOfTrack") or item.get("album"))
    artists = _artist_items(item.get("artists"))
    if not artists:
        artists = _artist_items(item.get("firstArtist")) + _artist_items(item.get("otherArtists"))
    if not artists:
        artists = _artist_items(album.get("artists"))

    duration = _mapping(item.get("duration") or item.get("trackDuration"))
    duration_ms = duration.get("totalMilliseconds") or item.get("duration_ms")
    album_id = _spotify_id(album, "album")
    album_date = _release_date(album)
    album_item = {
        "id": album_id,
        "name": album.get("name", ""),
        "artists": _artist_items(album.get("artists")) or artists,
        "images": _images(album.get("coverArt")),
        "release_date": album_date,
        "album_type": str(album.get("type") or album.get("albumType") or "album").lower(),
        "external_urls": (
            {"spotify": f"https://open.spotify.com/album/{album_id}"} if album_id else {}
        ),
    }
    track_id = _spotify_id(item, "track")
    return {
        "id": track_id,
        "name": item.get("name", ""),
        "artists": artists,
        "album": album_item,
        "duration_ms": int(duration_ms) if duration_ms is not None else None,
        "disc_number": int(item.get("discNumber") or 1),
        "track_number": int(item.get("trackNumber") or 0) or None,
        "explicit": str(_mapping(item.get("contentRating")).get("label", "")).upper()
        == "EXPLICIT",
        "external_ids": _external_ids(item),
        "external_urls": (
            {"spotify": f"https://open.spotify.com/track/{track_id}"} if track_id else {}
        ),
        "preview_url": None,
    }


def _album_item(value: Any, track_values: list[Any] | None = None) -> dict[str, Any]:
    item = _unwrap_data(value)
    tracks_data = _mapping(item.get("tracksV2") or item.get("tracks"))
    raw_tracks = track_values if track_values is not None else _items(tracks_data)
    tracks = [_track_item(track) for track in raw_tracks]
    album_id = _spotify_id(item, "album")
    return {
        "id": album_id,
        "name": item.get("name", ""),
        "album_type": str(item.get("type") or item.get("albumType") or "album").lower(),
        "release_date": _release_date(item),
        "images": _images(item.get("coverArt")),
        "artists": _artist_items(item.get("artists")),
        "tracks": {
            "items": tracks,
            "total": int(tracks_data.get("totalCount") or len(tracks)),
            "next": None,
        },
        "total_tracks": int(tracks_data.get("totalCount") or len(tracks)),
        "label": item.get("label"),
        "external_ids": _external_ids(item),
        "external_urls": (
            {"spotify": f"https://open.spotify.com/album/{album_id}"} if album_id else {}
        ),
    }


def _search_items(raw: Mapping[str, Any], kind: str) -> list[dict[str, Any]]:
    search = _mapping(_mapping(raw.get("data")).get("searchV2"))
    key = {"tracks": "tracksV2", "artists": "artists", "albums": "albumsV2"}[kind]
    return _items(search.get(key))


class SpotApiClient:
    """Expose the subset of the existing Spotify catalog client used by routes."""

    async def _run(self, function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(function, *args, **kwargs)

    @staticmethod
    def _song() -> Any:
        from spotapi import Song

        return Song()

    @staticmethod
    def _artist() -> Any:
        from spotapi import Artist

        return Artist()

    async def _search_raw(self, query: str, limit: int, offset: int) -> dict[str, Any]:
        return await self._run(
            self._song().query_songs,
            query,
            limit=max(10, min(limit, 100)),
            offset=offset,
        )

    async def search_tracks(
        self, query: str, limit: int = 10, offset: int = 0, market: str = "VN"
    ) -> tuple[list[dict[str, Any]], bool]:
        raw = await self._search_raw(query, limit, offset)
        items = [_track_item(item) for item in _search_items(raw, "tracks")]
        search = _mapping(_mapping(raw.get("data")).get("searchV2"))
        total = int(_mapping(search.get("tracksV2")).get("totalCount") or len(items))
        return items[:limit], offset + len(items) < total

    async def search_artists(
        self, query: str, limit: int = 10, offset: int = 0
    ) -> tuple[list[dict[str, Any]], bool]:
        raw = await self._run(
            self._artist().query_artists,
            query,
            limit=max(10, min(limit, 100)),
            offset=offset,
        )
        items = [_unwrap_data(item) for item in _search_items(raw, "artists")]
        result = [
            {
                "id": _spotify_id(item, "artist"),
                "name": _mapping(item.get("profile")).get("name") or item.get("name", ""),
                "images": _images(_mapping(item.get("visuals")).get("avatarImage")),
                "genres": [
                    str(g.get("name")) for g in _items(item.get("genres")) if g.get("name")
                ],
                "popularity": 0,
                "external_urls": {
                    "spotify": f"https://open.spotify.com/artist/{_spotify_id(item, 'artist')}"
                },
            }
            for item in items
            if _spotify_id(item, "artist")
        ]
        search = _mapping(_mapping(raw.get("data")).get("searchV2"))
        total = int(_mapping(search.get("artists")).get("totalCount") or len(result))
        return result[:limit], offset + len(result) < total

    async def search_albums(
        self, query: str, limit: int = 10, offset: int = 0, market: str = "VN"
    ) -> tuple[list[dict[str, Any]], bool]:
        raw = await self._search_raw(query, limit, offset)
        direct = [_unwrap_data(item) for item in _search_items(raw, "albums")]
        result = [_album_item(item) for item in direct]
        if not result:
            # Some Pathfinder revisions omit albumsV2 from searchDesktop. Track
            # results still carry albumOfTrack, which is a useful public fallback.
            seen: set[str] = set()
            for item in _search_items(raw, "tracks"):
                track = _track_item(item)
                album = track.get("album") or {}
                album_id = album.get("id")
                if album_id and album_id not in seen:
                    seen.add(album_id)
                    result.append(album)
        search = _mapping(_mapping(raw.get("data")).get("searchV2"))
        albums = _mapping(search.get("albumsV2"))
        total = int(albums.get("totalCount") or len(result))
        return result[:limit], offset + len(result) < total

    async def get_track(self, track_id: str) -> dict[str, Any]:
        raw = await self._run(self._song().get_track_info, track_id)
        return _track_item(_mapping(_mapping(raw.get("data")).get("trackUnion")))

    async def get_artist(self, artist_id: str) -> dict[str, Any]:
        raw = await self._run(self._artist().get_artist, artist_id)
        item = _mapping(_mapping(raw.get("data")).get("artistUnion"))
        artist = {
            "id": _spotify_id(item, "artist"),
            "name": _mapping(item.get("profile")).get("name") or item.get("name", ""),
            "images": _images(_mapping(item.get("visuals")).get("avatarImage"))
            or _images(item.get("headerImage")),
            "genres": [str(g.get("name")) for g in _items(item.get("genres")) if g.get("name")],
            "popularity": 0,
        }
        artist["external_urls"] = {
            "spotify": f"https://open.spotify.com/artist/{artist['id']}"
        }
        return artist

    async def get_artist_albums(
        self,
        artist_id: str,
        limit: int = 10,
        offset: int = 0,
        market: str = "VN",
    ) -> tuple[list[dict[str, Any]], bool, int | None]:
        raw = await self._run(
            self._artist().get_artist_discography,
            artist_id,
            section="all",
            offset=offset,
            limit=min(limit, 50),
        )
        discography = _mapping(
            _mapping(
                _mapping(_mapping(raw.get("data")).get("artistUnion")).get("discography")
            ).get("all")
        )
        result: list[dict[str, Any]] = []
        for entry in _items(discography):
            releases = _items(entry.get("releases"))
            album = releases[0] if releases else _mapping(entry.get("album"))
            if not album and (entry.get("uri") or entry.get("name")):
                album = entry
            if album:
                result.append(_album_item(album))
        total = int(discography.get("totalCount") or len(result))
        return result[:limit], offset + len(result) < total, total

    async def get_album(self, album_id: str, market: str = "VN") -> dict[str, Any]:
        from spotapi import PublicAlbum

        def fetch() -> dict[str, Any]:
            album = PublicAlbum(album_id)
            first = _mapping(album.get_album_info(limit=343))
            union = _mapping(_mapping(first.get("data")).get("albumUnion"))
            tracks_data = _mapping(union.get("tracksV2"))
            tracks = _items(tracks_data)
            total = int(tracks_data.get("totalCount") or len(tracks))
            offset = len(tracks)
            while offset < total:
                page = _mapping(album.get_album_info(limit=343, offset=offset))
                page_union = _mapping(_mapping(page.get("data")).get("albumUnion"))
                page_tracks = _items(_mapping(page_union.get("tracksV2")))
                if not page_tracks:
                    break
                tracks.extend(page_tracks)
                offset += len(page_tracks)
            return _album_item(union, tracks)

        return await self._run(fetch)
