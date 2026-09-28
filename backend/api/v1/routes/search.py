import asyncio
import logging
import re

from fastapi import APIRouter, Query, Path, BackgroundTasks, Depends, Request
from core.exceptions import ClientDisconnectedError
from api.v1.schemas.search import (
    SearchResponse,
    SearchBucketResponse,
    EnrichmentResponse,
    EnrichmentBatchRequest,
    SuggestResponse,
    YTMusicTrackResult,
    YTMusicTracksResponse,
)
from core.dependencies import (
    get_search_service,
    get_coverart_repository,
    get_search_enrichment_service,
    get_ytmusic_stream_service,
)
from infrastructure.degradation import try_get_degradation_context
from infrastructure.msgspec_fastapi import MsgSpecBody, MsgSpecRoute

import msgspec.structs
from services.search_service import SearchService
from services.search_enrichment_service import SearchEnrichmentService
from repositories.coverart_repository import CoverArtRepository
from middleware import CurrentUserDep
from core.dependencies import get_per_user_client_factory
from services.per_user_client_factory import PerUserClientFactory
from services.spotify_catalog import (
    spotify_album_search_result,
    spotify_artist_search_result,
    spotify_suggestion,
    spotify_track_result,
)

router = APIRouter(route_class=MsgSpecRoute, prefix="/search", tags=["search"])
logger = logging.getLogger(__name__)


@router.get("", response_model=SearchResponse)
async def search(
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: CurrentUserDep,
    q: str = Query(..., min_length=1, description="Search term"),
    limit_per_bucket: int | None = Query(
        None,
        ge=1,
        le=100,
        description="Max items per bucket (deprecated, use limit_artists/limit_albums)",
    ),
    limit_artists: int = Query(10, ge=0, le=100, description="Max artists to return"),
    limit_albums: int = Query(10, ge=0, le=100, description="Max albums to return"),
    buckets: str | None = Query(
        None, description="Comma-separated subset: artists,albums"
    ),
    search_service: SearchService = Depends(get_search_service),
    coverart_repo: CoverArtRepository = Depends(get_coverart_repository),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    if await request.is_disconnected():
        raise ClientDisconnectedError("Client disconnected")

    buckets_list = [b.strip().lower() for b in buckets.split(",")] if buckets else None

    final_limit_artists = limit_per_bucket if limit_per_bucket else limit_artists
    final_limit_albums = limit_per_bucket if limit_per_bucket else limit_albums

    spotify = await client_factory.resolve_spotify_catalog()
    if spotify is not None:
        try:
            wants_artists = (not buckets_list or "artists" in buckets_list) and final_limit_artists > 0
            wants_albums = (not buckets_list or "albums" in buckets_list) and final_limit_albums > 0
            wants_tracks = not buckets_list or "tracks" in buckets_list
            artist_task = (
                spotify.search_artists(q, limit=final_limit_artists)
                if wants_artists
                else asyncio.sleep(0, result=([], False))
            )
            album_task = (
                spotify.search_albums(q, limit=final_limit_albums)
                if wants_albums
                else asyncio.sleep(0, result=([], False))
            )
            track_task = (
                spotify.search_tracks(q, limit=10)
                if wants_tracks
                else asyncio.sleep(0, result=([], False))
            )
            (raw_artists, _), (raw_albums, _), (raw_tracks, _) = await asyncio.gather(
                artist_task, album_task, track_task
            )
            artists = [
                spotify_artist_search_result(item, q)
                for item in raw_artists
                if item.get("id")
            ]
            albums = [
                spotify_album_search_result(item, q)
                for item in raw_albums
                if item.get("id")
            ]
            tracks = [spotify_track_result(item) for item in raw_tracks if item.get("id")]
            return SearchResponse(
                artists=artists,
                albums=albums,
                tracks=tracks,
                top_artist=artists[0] if artists else None,
                top_album=albums[0] if albums else None,
                bucket_status={
                    name: "ok"
                    for name, wanted in (("artists", wants_artists), ("albums", wants_albums))
                    if wanted
                },
            )
        except Exception:  # noqa: BLE001 - preserve MusicBrainz as an outage fallback
            logger.exception("Spotify catalog search failed; falling back to MusicBrainz")

    result = await search_service.search(
        query=q,
        limit_artists=final_limit_artists,
        limit_albums=final_limit_albums,
        buckets=buckets_list,
    )

    ctx = try_get_degradation_context()
    if ctx is not None and ctx.has_degradation():
        result = msgspec.structs.replace(result, service_status=ctx.degraded_summary())

    album_ids = search_service.schedule_cover_prefetch(result.albums)
    if album_ids:
        background_tasks.add_task(coverart_repo.batch_prefetch_covers, album_ids, "250")

    if current_user:
        spotify = await client_factory.resolve_spotify_catalog()
        if spotify:
            try:
                from api.v1.schemas.search import SpotifyTrackResult

                spotify_tracks, _ = await spotify.search_tracks(q, limit=10)
                seen_track_ids: set[str] = set()
                result = msgspec.structs.replace(
                    result,
                    tracks=[
                        SpotifyTrackResult(
                            title=t.get("name", ""),
                            artist=", ".join(
                                a.get("name", "") for a in t.get("artists", [])
                            ),
                            album=(t.get("album") or {}).get("name", ""),
                            spotify_id=t.get("id", ""),
                            spotify_album_id=(t.get("album") or {}).get("id"),
                            spotify_url=(t.get("external_urls") or {}).get("spotify"),
                            preview_url=t.get("preview_url"),
                            album_image_url=(
                                (t.get("album") or {}).get("images") or [{}]
                            )[0].get("url"),
                            duration_ms=t.get("duration_ms"),
                        )
                        for t in spotify_tracks
                        if t.get("id")
                        and not (
                            t.get("id") in seen_track_ids
                            or seen_track_ids.add(t.get("id"))
                        )
                    ],
                )
            except Exception:
                logger.exception("Spotify supplemental search failed")
    return result


@router.get("/suggest", response_model=SuggestResponse)
async def suggest(
    current_user: CurrentUserDep,
    q: str = Query(..., min_length=2, description="Search query"),
    limit: int = Query(5, ge=1, le=10, description="Max results"),
    search_service: SearchService = Depends(get_search_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
) -> SuggestResponse:
    stripped = q.strip()
    if len(stripped) < 2:
        return SuggestResponse()
    spotify = await client_factory.resolve_spotify_catalog()
    if spotify is None:
        return await search_service.suggest(query=stripped, limit=limit)
    try:
        (artists, _), (albums, _), (tracks, _) = await asyncio.gather(
            spotify.search_artists(stripped, limit=limit),
            spotify.search_albums(stripped, limit=limit),
            spotify.search_tracks(stripped, limit=limit),
        )
        suggestions = [
            *(spotify_suggestion(item, "artist", stripped) for item in artists if item.get("id")),
            *(spotify_suggestion(item, "album", stripped) for item in albums if item.get("id")),
        ]
        suggestions.sort(key=lambda item: (-item.score, item.type, item.title.casefold()))
        seen_track_ids: set[str] = set()
        return SuggestResponse(
            results=suggestions[:limit],
            tracks=[
                spotify_track_result(track)
                for track in tracks
                if (track_id := track.get("id"))
                and not (track_id in seen_track_ids or seen_track_ids.add(track_id))
            ],
            remote_status="ok",
        )
    except Exception:  # noqa: BLE001 - retain the legacy provider as an outage fallback
        logger.exception("Spotify suggest failed; falling back to MusicBrainz")
        return await search_service.suggest(query=stripped, limit=limit)


def _ytmusic_track_result(item: dict) -> YTMusicTrackResult:
    video_id = item["videoId"]
    artists = [
        a.get("name") if isinstance(a, dict) else a
        for a in item.get("artists") or []
        if (a.get("name") if isinstance(a, dict) else a)
    ]
    album = item.get("album") if isinstance(item.get("album"), dict) else {}
    thumbs = [t for t in item.get("thumbnails") or [] if isinstance(t, dict) and t.get("url")]
    image = max(thumbs, key=lambda t: t.get("width") or 0)["url"] if thumbs else None
    if image and "googleusercontent.com" in image:
        # Artwork URLs carry a =w120-h120 sizing suffix; ask for a sharp square.
        image = re.sub(r"=w\d+-h\d+", "=w544-h544", image)
    duration = item.get("duration_seconds")
    return YTMusicTrackResult(
        title=item.get("title") or "Unknown",
        artist=", ".join(artists) or "Unknown Artist",
        album=album.get("name") or "",
        video_id=video_id,
        url=f"https://music.youtube.com/watch?v={video_id}",
        album_image_url=image,
        duration_seconds=int(duration) if isinstance(duration, (int, float)) else None,
    )


@router.get("/ytmusic/tracks", response_model=YTMusicTracksResponse)
async def search_ytmusic_tracks(
    _current_user: CurrentUserDep,
    q: str = Query(..., min_length=1, description="Search term"),
    limit: int = Query(20, ge=1, le=50, description="Max tracks to return"),
    ytmusic=Depends(get_ytmusic_stream_service),
):
    """YouTube Music songs; the frontend downloads them through yt-dlp."""
    try:
        raw = await ytmusic.search_tracks(q.strip(), limit=limit)
    except Exception:  # noqa: BLE001 - an upstream outage is an empty result, not a 500
        logger.exception("YouTube Music track search failed")
        return YTMusicTracksResponse(tracks=[], status="error")
    return YTMusicTracksResponse(tracks=[_ytmusic_track_result(item) for item in raw])


@router.get("/{bucket}", response_model=SearchBucketResponse)
async def search_bucket(
    current_user: CurrentUserDep,
    bucket: str = Path(..., pattern="^(artists|albums)$"),
    q: str = Query(..., min_length=1, description="Search term"),
    limit: int = Query(50, ge=1, le=100, description="Page size"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    search_service: SearchService = Depends(get_search_service),
    client_factory: PerUserClientFactory = Depends(get_per_user_client_factory),
):
    spotify = await client_factory.resolve_spotify_catalog()
    if spotify is not None:
        try:
            if bucket == "artists":
                raw, _ = await spotify.search_artists(q.strip(), limit=limit, offset=offset)
                results = [
                    spotify_artist_search_result(item, q)
                    for item in raw
                    if item.get("id")
                ]
            else:
                raw, _ = await spotify.search_albums(q.strip(), limit=limit, offset=offset)
                results = [
                    spotify_album_search_result(item, q)
                    for item in raw
                    if item.get("id")
                ]
            return SearchBucketResponse(
                bucket=bucket,
                limit=limit,
                offset=offset,
                results=results,
                top_result=results[0] if offset == 0 and results else None,
                status="ok",
            )
        except Exception:  # noqa: BLE001 - preserve search during a Spotify outage
            logger.exception("Spotify %s search failed; falling back to MusicBrainz", bucket)
    results, top_result, status = await search_service.search_bucket(
        bucket=bucket, query=q, limit=limit, offset=offset
    )
    return SearchBucketResponse(
        bucket=bucket,
        limit=limit,
        offset=offset,
        results=results,
        top_result=top_result,
        status=status,
    )


@router.get("/enrich/batch", response_model=EnrichmentResponse)
async def enrich_search_results(
    artist_mbids: str = Query("", description="Comma-separated artist MBIDs"),
    album_mbids: str = Query("", description="Comma-separated album MBIDs"),
    enrichment_service: SearchEnrichmentService = Depends(
        get_search_enrichment_service
    ),
):
    artist_list = [m.strip() for m in artist_mbids.split(",") if m.strip()]
    album_list = [m.strip() for m in album_mbids.split(",") if m.strip()]

    return await enrichment_service.enrich(
        artist_mbids=artist_list,
        album_mbids=album_list,
    )


@router.post("/enrich/batch", response_model=EnrichmentResponse)
async def enrich_search_results_post(
    body: EnrichmentBatchRequest = MsgSpecBody(EnrichmentBatchRequest),
    enrichment_service: SearchEnrichmentService = Depends(
        get_search_enrichment_service
    ),
):
    return await enrichment_service.enrich_batch(body)
