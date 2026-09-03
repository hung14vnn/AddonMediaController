"""Compatibility mappers for exposing Spotify catalog data through provider APIs."""

from __future__ import annotations

from api.v1.schemas.album import AlbumBasicInfo, AlbumTracksInfo
from api.v1.schemas.discovery import TopAlbum, TopSong
from api.v1.schemas.search import SpotifyTrackResult, SuggestResult
from models.album import AlbumInfo, Track
from models.artist import ArtistInfo, ExternalLink, ReleaseItem
from models.search import SearchResult

SPOTIFY_ARTIST_PREFIX = "spotify:artist:"
SPOTIFY_ALBUM_PREFIX = "spotify:album:"


def spotify_artist_id(identifier: str) -> str | None:
    if identifier.startswith(SPOTIFY_ARTIST_PREFIX):
        value = identifier[len(SPOTIFY_ARTIST_PREFIX) :]
        return value or None
    return None


def spotify_album_id(identifier: str) -> str | None:
    if identifier.startswith(SPOTIFY_ALBUM_PREFIX):
        value = identifier[len(SPOTIFY_ALBUM_PREFIX) :]
        return value or None
    return None


def artist_provider_id(value: str) -> str:
    return f"{SPOTIFY_ARTIST_PREFIX}{value}"


def album_provider_id(value: str) -> str:
    return f"{SPOTIFY_ALBUM_PREFIX}{value}"


def _first_image(item: dict) -> str | None:
    images = item.get("images") or []
    return images[0].get("url") if images else None


def _year(release_date: str | None) -> int | None:
    if not release_date or len(release_date) < 4:
        return None
    try:
        return int(release_date[:4])
    except ValueError:
        return None


def _artist_names(item: dict) -> str:
    return ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))


def spotify_artist_search_result(item: dict, query: str = "") -> SearchResult:
    name = item.get("name", "")
    popularity = int(item.get("popularity") or 0)
    exact_bonus = 1000 if query and name.casefold() == query.strip().casefold() else 0
    return SearchResult(
        type="artist",
        title=name,
        musicbrainz_id=artist_provider_id(item.get("id", "")),
        thumb_url=_first_image(item),
        cover_url=_first_image(item),
        type_info="Artist",
        score=exact_bonus + popularity,
    )


def spotify_album_search_result(item: dict, query: str = "") -> SearchResult:
    title = item.get("name", "")
    release_date = item.get("release_date")
    image = _first_image(item)
    exact_bonus = 1000 if query and title.casefold() == query.strip().casefold() else 0
    return SearchResult(
        type="album",
        title=title,
        artist=_artist_names(item) or None,
        year=_year(release_date),
        musicbrainz_id=album_provider_id(item.get("id", "")),
        cover_url=image,
        album_thumb_url=image,
        type_info=(item.get("album_type") or "album").replace("_", " ").title(),
        score=exact_bonus + int(item.get("popularity") or 0),
    )


def spotify_suggestion(item: dict, kind: str, query: str = "") -> SuggestResult:
    mapped = (
        spotify_artist_search_result(item, query)
        if kind == "artist"
        else spotify_album_search_result(item, query)
    )
    return SuggestResult(
        type=kind,
        title=mapped.title,
        artist=mapped.artist,
        year=mapped.year,
        musicbrainz_id=mapped.musicbrainz_id,
        score=mapped.score,
        cover_url=mapped.thumb_url or mapped.album_thumb_url or mapped.cover_url,
    )


def spotify_artist_info(item: dict) -> ArtistInfo:
    provider_id = artist_provider_id(item.get("id", ""))
    spotify_url = (item.get("external_urls") or {}).get("spotify")
    links = (
        [ExternalLink(type="spotify", url=spotify_url, label="Spotify", category="music")]
        if spotify_url
        else []
    )
    return ArtistInfo(
        name=item.get("name", ""),
        musicbrainz_id=provider_id,
        type="Artist",
        image=_first_image(item),
        thumb_url=_first_image(item),
        tags=item.get("genres") or [],
        external_links=links,
    )


def spotify_release(item: dict) -> ReleaseItem:
    release_date = item.get("release_date")
    return ReleaseItem(
        id=album_provider_id(item.get("id", "")),
        title=item.get("name", ""),
        type=(item.get("album_group") or item.get("album_type") or "album").title(),
        first_release_date=release_date,
        year=_year(release_date),
        cover_url=_first_image(item),
    )


def spotify_track_result(item: dict) -> SpotifyTrackResult:
    album = item.get("album") or {}
    return SpotifyTrackResult(
        title=item.get("name", ""),
        artist=_artist_names(item),
        album=album.get("name", ""),
        spotify_id=item.get("id", ""),
        spotify_album_id=album.get("id"),
        spotify_url=(item.get("external_urls") or {}).get("spotify"),
        preview_url=item.get("preview_url"),
        album_image_url=_first_image(album),
        duration_ms=item.get("duration_ms"),
    )


def spotify_top_song(item: dict) -> TopSong:
    album = item.get("album") or {}
    return TopSong(
        title=item.get("name", ""),
        artist_name=_artist_names(item),
        recording_mbid=f"spotify:track:{item.get('id', '')}",
        release_group_mbid=album_provider_id(album.get("id", "")) if album.get("id") else None,
        release_name=album.get("name"),
        disc_number=item.get("disc_number"),
        track_number=item.get("track_number"),
        cover_url=_first_image(album),
    )


def spotify_top_album(item: dict) -> TopAlbum:
    release_date = item.get("release_date")
    return TopAlbum(
        title=item.get("name", ""),
        artist_name=_artist_names(item),
        release_group_mbid=album_provider_id(item.get("id", "")),
        year=_year(release_date),
        cover_url=_first_image(item),
    )


def spotify_album_basic(item: dict) -> AlbumBasicInfo:
    artists = item.get("artists") or []
    primary = artists[0] if artists else {}
    release_date = item.get("release_date")
    image = _first_image(item)
    return AlbumBasicInfo(
        title=item.get("name", ""),
        musicbrainz_id=album_provider_id(item.get("id", "")),
        artist_name=_artist_names(item),
        artist_id=artist_provider_id(primary.get("id", "")),
        release_date=release_date,
        year=_year(release_date),
        type=(item.get("album_type") or "album").title(),
        cover_url=image,
        album_thumb_url=image,
    )


def spotify_album_tracks(item: dict) -> AlbumTracksInfo:
    tracks = (item.get("tracks") or {}).get("items") or []
    mapped = [
        Track(
            position=int(track.get("track_number") or index + 1),
            disc_number=int(track.get("disc_number") or 1),
            title=track.get("name", ""),
            length=track.get("duration_ms"),
            recording_id=f"spotify:track:{track.get('id', '')}",
            release_track_id=track.get("id"),
        )
        for index, track in enumerate(tracks)
    ]
    return AlbumTracksInfo(
        tracks=mapped,
        total_tracks=int(item.get("total_tracks") or len(mapped)),
        total_length=sum(track.length or 0 for track in mapped) or None,
        label=item.get("label"),
        barcode=(item.get("external_ids") or {}).get("upc"),
    )


def spotify_album_info(item: dict) -> AlbumInfo:
    basic = spotify_album_basic(item)
    tracks = spotify_album_tracks(item)
    return AlbumInfo(
        title=basic.title,
        musicbrainz_id=basic.musicbrainz_id,
        artist_name=basic.artist_name,
        artist_id=basic.artist_id,
        release_date=basic.release_date,
        year=basic.year,
        type=basic.type,
        label=tracks.label,
        barcode=tracks.barcode,
        tracks=tracks.tracks,
        total_tracks=tracks.total_tracks,
        total_length=tracks.total_length,
        cover_url=basic.cover_url,
        album_thumb_url=basic.album_thumb_url,
    )
