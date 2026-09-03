import logging
import unicodedata
from typing import Literal
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from core.exceptions import ClientDisconnectedError
from api.v1.schemas.artist import (
    ArtistInfo,
    ArtistExtendedInfo,
    ArtistReleases,
    LastFmArtistEnrichment,
    FollowRequest,
    AutoDownloadRequest,
    FollowStatusResponse,
)
from api.v1.schemas.discovery import (
    SimilarArtistsResponse,
    TopSongsResponse,
    TopAlbumsResponse,
)
from api.v1.schemas.search import SpotifyTrackResult, SpotifyTracksResponse
from api.v1.schemas.get_it import ArtistPurchaseOptionsResponse, PurchaseLink
from core.dependencies import (
    get_artist_service,
    get_artist_discovery_service,
    get_artist_enrichment_service,
    get_follow_service,
    get_get_it_service,
    get_per_user_client_factory,
)
from services.artist_service import ArtistService
from services.follow_service import FollowService, FollowError
from middleware import CurrentUserDep
from services.artist_discovery_service import ArtistDiscoveryService
from services.artist_enrichment_service import ArtistEnrichmentService
from services.per_user_client_factory import PerUserClientFactory
from services.spotify_catalog import (
    spotify_artist_id,
    spotify_artist_info,
    spotify_release,
    spotify_top_album,
    spotify_top_song,
    spotify_track_result,
)
from infrastructure.validators import is_unknown_mbid, validate_mbid
from infrastructure.msgspec_fastapi import MsgSpecBody, MsgSpecRoute
from infrastructure.degradation import try_get_degradation_context

import msgspec.structs

logger = logging.getLogger(__name__)

router = APIRouter(route_class=MsgSpecRoute, prefix="/artists", tags=["artist"])


@router.get("/{artist_id}", response_model=ArtistInfo)
async def get_artist(
    artist_id: str,
    request: Request,
    artist_service: ArtistService = Depends(get_artist_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    if await request.is_disconnected():
        raise ClientDisconnectedError("Client disconnected")

    spotify_id = spotify_artist_id(artist_id)
    if spotify_id:
        client = await client_factory.resolve_spotify_catalog()
        if client is None:
            raise HTTPException(status_code=503, detail="Spotify catalog is not configured")
        try:
            return spotify_artist_info(await client.get_artist(spotify_id))
        except Exception as exc:
            logger.exception("Spotify artist lookup failed")
            raise HTTPException(status_code=502, detail="Spotify artist lookup failed") from exc

    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )

    try:
        result = await artist_service.get_artist_info_basic(artist_id)
        ctx = try_get_degradation_context()
        if ctx and ctx.has_degradation():
            result = msgspec.structs.replace(
                result, service_status=ctx.degraded_summary()
            )
        return result
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid artist request"
        )


@router.get(
    "/{artist_id}/purchase-options", response_model=ArtistPurchaseOptionsResponse
)
async def get_artist_purchase_options(
    artist_id: str,
    name: str = Query("", description="Artist name, for the Bandcamp search fallback"),
    service=Depends(get_get_it_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    """The artist's own storefronts (Get it, phase 01). Lazy like the album
    variant: the artist page's load path never calls this."""
    spotify_id = spotify_artist_id(artist_id)
    if spotify_id:
        client = await client_factory.resolve_spotify_catalog()
        item = await client.get_artist(spotify_id) if client else {}
        artist_name = item.get("name") or name
        spotify_url = (item.get("external_urls") or {}).get("spotify")
        return ArtistPurchaseOptionsResponse(
            links=(
                [PurchaseLink(store="spotify", label="Spotify", url=spotify_url, kind="digital")]
                if spotify_url
                else []
            ),
            bandcamp_search_url=(
                f"https://bandcamp.com/search?q={quote_plus(artist_name.strip())}&item_type=b"
                if artist_name.strip()
                else ""
            ),
        )
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )
    return await service.get_artist_purchase_options(artist_id, name)


@router.get("/{artist_id}/extended", response_model=ArtistExtendedInfo)
async def get_artist_extended(
    artist_id: str,
    artist_service: ArtistService = Depends(get_artist_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    spotify_id = spotify_artist_id(artist_id)
    if spotify_id:
        client = await client_factory.resolve_spotify_catalog()
        if client is None:
            raise HTTPException(status_code=503, detail="Spotify catalog is not configured")
        item = await client.get_artist(spotify_id)
        return ArtistExtendedInfo(image=spotify_artist_info(item).image)
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )

    try:
        return await artist_service.get_artist_extended_info(artist_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid artist request"
        )


@router.get("/{artist_id}/releases", response_model=ArtistReleases)
async def get_artist_releases(
    artist_id: str,
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    artist_service: ArtistService = Depends(get_artist_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    spotify_id = spotify_artist_id(artist_id)
    if spotify_id:
        client = await client_factory.resolve_spotify_catalog()
        if client is None:
            raise HTTPException(status_code=503, detail="Spotify catalog is not configured")
        try:
            raw, has_more, total = await client.get_artist_albums(
                spotify_id, limit=limit, offset=offset
            )
            releases = [spotify_release(item) for item in raw if item.get("id")]
            albums = [r for r in releases if (r.type or "").casefold() not in {"single", "ep"}]
            singles = [r for r in releases if (r.type or "").casefold() == "single"]
            eps = [r for r in releases if (r.type or "").casefold() == "ep"]
            return ArtistReleases(
                albums=albums,
                singles=singles,
                eps=eps,
                offset=offset,
                limit=limit,
                returned_count=len(releases),
                next_offset=offset + len(raw) if has_more else None,
                has_more=has_more,
                source_total_count=total,
            )
        except Exception as exc:
            logger.exception("Spotify artist albums lookup failed")
            raise HTTPException(status_code=502, detail="Spotify artist albums lookup failed") from exc
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )

    try:
        result = await artist_service.get_artist_releases(
            artist_id,
            offset,
            limit,
            is_disconnected=request.is_disconnected,
        )
        ctx = try_get_degradation_context()
        if ctx is not None and ctx.has_degradation():
            result = msgspec.structs.replace(
                result, service_status=ctx.degraded_summary()
            )
        return result
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid artist request"
        )


@router.get("/{artist_id}/similar", response_model=SimilarArtistsResponse)
async def get_similar_artists(
    artist_id: str,
    current_user: CurrentUserDep,
    count: int = Query(default=15, ge=1, le=50),
    source: Literal["listenbrainz", "lastfm"] | None = Query(
        default=None, description="Data source: listenbrainz or lastfm"
    ),
    discovery_service: ArtistDiscoveryService = Depends(get_artist_discovery_service),
):
    if spotify_artist_id(artist_id):
        # Spotify no longer exposes related artists to development-mode apps.
        return SimilarArtistsResponse(similar_artists=[], source="spotify", configured=False)
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )
    return await discovery_service.get_similar_artists(
        artist_id, count, source=source, user_id=current_user.id
    )


@router.get("/{artist_id}/top-songs", response_model=TopSongsResponse)
async def get_top_songs(
    artist_id: str,
    current_user: CurrentUserDep,
    count: int = Query(default=10, ge=1, le=50),
    source: Literal["listenbrainz", "lastfm"] | None = Query(
        default=None, description="Data source: listenbrainz or lastfm"
    ),
    discovery_service: ArtistDiscoveryService = Depends(get_artist_discovery_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    spotify_id = spotify_artist_id(artist_id)
    if spotify_id:
        client = await client_factory.resolve_spotify_catalog()
        if client is None:
            return TopSongsResponse(source="spotify", configured=False)
        artist = await client.get_artist(spotify_id)
        raw, _ = await client.search_tracks(f'artist:"{artist.get("name", "")}"', limit=count)
        exact = [
            track
            for track in raw
            if any(a.get("id") == spotify_id for a in track.get("artists", []))
        ]
        return TopSongsResponse(
            songs=[spotify_top_song(track) for track in (exact or raw)[:count]],
            source="spotify",
        )
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )
    return await discovery_service.get_top_songs(
        artist_id, count, source=source, user_id=current_user.id
    )


@router.get("/{artist_id}/top-albums", response_model=TopAlbumsResponse)
async def get_top_albums(
    artist_id: str,
    current_user: CurrentUserDep,
    count: int = Query(default=10, ge=1, le=50),
    source: Literal["listenbrainz", "lastfm"] | None = Query(
        default=None, description="Data source: listenbrainz or lastfm"
    ),
    discovery_service: ArtistDiscoveryService = Depends(get_artist_discovery_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    spotify_id = spotify_artist_id(artist_id)
    if spotify_id:
        client = await client_factory.resolve_spotify_catalog()
        if client is None:
            return TopAlbumsResponse(source="spotify", configured=False)
        raw, _, _ = await client.get_artist_albums(spotify_id, limit=count)
        return TopAlbumsResponse(
            albums=[spotify_top_album(album) for album in raw[:count]],
            source="spotify",
        )
    if not spotify_artist_id(artist_id) and is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )
    return await discovery_service.get_top_albums(
        artist_id, count, source=source, user_id=current_user.id
    )


@router.get("/{artist_id}/lastfm", response_model=LastFmArtistEnrichment)
async def get_artist_lastfm_enrichment(
    artist_id: str,
    artist_name: str = Query(..., description="Artist name for Last.fm lookup"),
    enrichment_service: ArtistEnrichmentService = Depends(
        get_artist_enrichment_service
    ),
):
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )
    result = await enrichment_service.get_lastfm_enrichment(artist_id, artist_name)
    if result is None:
        return LastFmArtistEnrichment()
    return result


@router.get("/{artist_id}/spotify-tracks", response_model=SpotifyTracksResponse)
async def get_artist_spotify_tracks(
    artist_id: str,
    current_user: CurrentUserDep,
    artist_name: str = Query(..., min_length=1),
    offset: int = Query(0, ge=0),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
) -> SpotifyTracksResponse:
    """Supplement an artist page with Spotify's regional top tracks."""
    logger.warning("Spotify artist endpoint entered: artist_name=%r", artist_name)
    client = await client_factory.resolve_spotify_catalog()
    if not client:
        logger.warning("Spotify artist endpoint: catalog client unavailable")
        client = await client_factory.resolve_spotify(current_user.id)
    if not client:
        logger.warning("Spotify artist endpoint: user Spotify client unavailable")
        return SpotifyTracksResponse()
    try:
        provider_artist_id = spotify_artist_id(artist_id)
        matches, has_more = await client.search_tracks(
            f'artist:"{artist_name}"', limit=10, offset=offset
        )
        # Spotify's field-filtered search can return only a handful of tracks
        # for an artist despite a larger catalog. Supplement it with the
        # general query and retain only exact artist matches below.
        broad_matches, broad_has_more = await client.search_tracks(
            artist_name, limit=10, offset=offset
        )
        matches.extend(broad_matches)
        has_more = has_more or broad_has_more
        logger.info(
            "Spotify artist search %r returned %d tracks", artist_name, len(matches)
        )
        if not matches:
            return SpotifyTracksResponse()

        # Spotify removed /artists/{id}/top-tracks in February 2026. Use the
        # supported catalog search endpoint instead and keep only tracks whose
        # primary artist matches the requested artist.
        def fold(value: str) -> str:
            return "".join(
                char
                for char in unicodedata.normalize("NFKD", value.casefold())
                if not unicodedata.combining(char)
            ).strip()

        requested = fold(artist_name)
        tracks = [
            track
            for track in matches
            if any(
                (provider_artist_id and artist.get("id") == provider_artist_id)
                or fold(artist.get("name", "")) == requested
                for artist in track.get("artists", [])
            )
        ] or matches
        unique_tracks = []
        seen: set[str] = set()
        for track in tracks:
            track_key = str(track.get("id") or "").strip()
            if not track_key or track_key in seen:
                continue
            seen.add(track_key)
            unique_tracks.append(track)
        tracks = unique_tracks[:20]
        results = [spotify_track_result(t) for t in tracks if t.get("id")]
        return SpotifyTracksResponse(
            tracks=results,
            next_offset=offset + 10 if has_more else None,
            has_more=has_more,
        )
    except Exception:
        logger.exception("Spotify artist tracks lookup failed")
        return SpotifyTracksResponse()


def _follow_response(state) -> FollowStatusResponse:
    return FollowStatusResponse(
        followed=state.followed,
        auto_download=state.auto_download,
        auto_download_state=state.auto_download_state,
    )


def _validate_artist_mbid(artist_id: str) -> None:
    if spotify_artist_id(artist_id):
        return
    try:
        validate_mbid(artist_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid artist MBID format",
        )


@router.get("/{artist_id}/follow", response_model=FollowStatusResponse)
async def get_follow_status(
    artist_id: str,
    current_user: CurrentUserDep,
    follow_service: FollowService = Depends(get_follow_service),
):
    _validate_artist_mbid(artist_id)
    state = await follow_service.get_status(
        current_user.id, current_user.role, artist_id
    )
    return _follow_response(state)


@router.put("/{artist_id}/follow", response_model=FollowStatusResponse)
async def set_follow(
    artist_id: str,
    current_user: CurrentUserDep,
    body: FollowRequest = MsgSpecBody(FollowRequest),
    follow_service: FollowService = Depends(get_follow_service),
):
    _validate_artist_mbid(artist_id)
    state = await follow_service.set_followed(
        current_user.id, current_user.role, artist_id, body.followed
    )
    return _follow_response(state)


@router.put("/{artist_id}/auto-download", response_model=FollowStatusResponse)
async def set_auto_download(
    artist_id: str,
    current_user: CurrentUserDep,
    body: AutoDownloadRequest = MsgSpecBody(AutoDownloadRequest),
    follow_service: FollowService = Depends(get_follow_service),
):
    _validate_artist_mbid(artist_id)
    try:
        state = await follow_service.set_auto_download(
            current_user.id, current_user.role, artist_id, body.enabled
        )
    except FollowError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return _follow_response(state)
