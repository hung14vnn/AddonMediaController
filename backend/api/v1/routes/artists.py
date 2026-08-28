import logging
import unicodedata
from typing import Literal

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
from api.v1.schemas.get_it import ArtistPurchaseOptionsResponse
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
):
    if await request.is_disconnected():
        raise ClientDisconnectedError("Client disconnected")

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
):
    """The artist's own storefronts (Get it, phase 01). Lazy like the album
    variant: the artist page's load path never calls this."""
    if is_unknown_mbid(artist_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unknown artist ID: {artist_id}",
        )
    return await service.get_artist_purchase_options(artist_id, name)


@router.get("/{artist_id}/extended", response_model=ArtistExtendedInfo)
async def get_artist_extended(
    artist_id: str, artist_service: ArtistService = Depends(get_artist_service)
):
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
):
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
):
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
):
    if is_unknown_mbid(artist_id):
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
                fold(artist.get("name", "")) == requested
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
        results = [
            SpotifyTrackResult(
                title=t.get("name", ""),
                artist=", ".join(a.get("name", "") for a in t.get("artists", [])),
                album=(t.get("album") or {}).get("name", ""),
                spotify_id=t.get("id", ""),
                spotify_album_id=(t.get("album") or {}).get("id"),
                spotify_url=(t.get("external_urls") or {}).get("spotify"),
                preview_url=t.get("preview_url"),
                album_image_url=((t.get("album") or {}).get("images") or [{}])[0].get(
                    "url"
                ),
                duration_ms=t.get("duration_ms"),
            )
            for t in tracks
            if t.get("id")
        ]
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
