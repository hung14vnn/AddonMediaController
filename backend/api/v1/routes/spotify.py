"""Spotify playlist browsing and import endpoints."""

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException

from core.dependencies import (
    get_acquisition_dispatcher,
    get_jellyfin_library_service,
    get_local_files_service,
    get_navidrome_library_service,
    get_navidrome_folder_scope_service,
    get_plex_library_service,
    get_playlist_service,
    get_quota_service,
    get_spotify_import_service,
    get_sse_publisher,
)
from core.task_registry import TaskRegistry
from infrastructure.msgspec_fastapi import AppStruct, MsgSpecBody, MsgSpecRoute
from middleware import CurrentUserDep
from services.spotify_import_service import SpotifyImportService, SpotifyNotLinkedError
from services.local_files_service import LocalFilesService
from services.playlist_service import PlaylistService
from services.native.download_service import ALREADY_IN_LIBRARY

_LINK_SOURCE_PRIORITY = ["local", "jellyfin", "navidrome", "plex"]

logger = logging.getLogger(__name__)

router = APIRouter(route_class=MsgSpecRoute, prefix="/me/spotify", tags=["spotify"])


class SpotifyPlaylistItem(AppStruct):
    id: str
    name: str
    description: str
    track_count: int
    cover_url: str | None
    owner: str
    imported_playlist_id: str | None


class SpotifyPlaylistListResponse(AppStruct):
    playlists: list[SpotifyPlaylistItem]


class SpotifyImportRequest(AppStruct):
    name: str


class SpotifyImportResponse(AppStruct):
    playlist_id: str


class SpotifyTrackRequest(AppStruct):
    spotify_id: str


class SpotifyTrackRequestResponse(AppStruct):
    status: str
    task_id: str | None = None


async def _background_import(
    svc: SpotifyImportService,
    user_id: str,
    spotify_playlist_id: str,
    playlist_id: str,
    current_user: object,
    playlist_service: PlaylistService,
    local_service: LocalFilesService,
) -> None:
    try:
        await svc.populate_playlist(user_id, spotify_playlist_id, playlist_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            f"Background Spotify import failed for playlist {playlist_id}: {exc}"
        )
        return
    try:
        jf_service = get_jellyfin_library_service()
        nd_service = get_navidrome_library_service()
        folder_resolution = await get_navidrome_folder_scope_service().resolve(user_id)
        navidrome_folder_ids = (
            None
            if folder_resolution.scope.mode == "all"
            else folder_resolution.scope.folder_ids
        )
        plex_service = get_plex_library_service()
        sources_map = await playlist_service.resolve_track_sources(
            playlist_id,
            requesting=current_user,
            jf_service=jf_service,
            local_service=local_service,
            nd_service=nd_service,
            plex_service=plex_service,
            navidrome_folder_ids=navidrome_folder_ids,
        )
        for track_id, sources in sources_map.items():
            if not sources:
                continue
            best = next((s for s in _LINK_SOURCE_PRIORITY if s in sources), None)
            if best:
                try:
                    await playlist_service.update_track_source(
                        playlist_id,
                        current_user,
                        track_id,
                        source_type=best,
                        jf_service=jf_service,
                        local_service=local_service,
                        nd_service=nd_service,
                        plex_service=plex_service,
                        navidrome_folder_ids=navidrome_folder_ids,
                    )
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"Auto-link failed for playlist {playlist_id}: {exc}")

    # Tell the detail/list UI the import finished so the tracks appear without a manual
    # refresh. Fires whenever populate succeeded (auto-link above is best-effort). The
    # event_id lets the client de-dupe the SSEPublisher's replay-to-new-subscribers.
    try:
        await get_sse_publisher().publish(
            f"user:{user_id}",
            "playlist_imported",
            {"playlist_id": playlist_id, "event_id": uuid.uuid4().hex},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            f"Failed to signal Spotify import completion for {playlist_id}: {exc}"
        )


@router.get("/playlists", response_model=SpotifyPlaylistListResponse)
async def list_spotify_playlists(
    current_user: CurrentUserDep,
    svc: SpotifyImportService = Depends(get_spotify_import_service),
) -> SpotifyPlaylistListResponse:
    try:
        playlists = await svc.list_playlists(current_user.id)
    except SpotifyNotLinkedError:
        raise HTTPException(status_code=400, detail="Spotify account not linked")
    except Exception as exc:  # noqa: BLE001
        logger.error(f"Failed to list Spotify playlists for {current_user.id}: {exc}")
        raise HTTPException(
            status_code=502, detail="Failed to fetch playlists from Spotify"
        )
    return SpotifyPlaylistListResponse(
        playlists=[
            SpotifyPlaylistItem(
                id=p["id"],
                name=p["name"],
                description=p["description"],
                track_count=p["track_count"],
                cover_url=p["cover_url"],
                owner=p["owner"],
                imported_playlist_id=p["imported_playlist_id"],
            )
            for p in playlists
        ]
    )


@router.post("/tracks/request", response_model=SpotifyTrackRequestResponse)
async def request_spotify_track(
    body: SpotifyTrackRequest = MsgSpecBody(SpotifyTrackRequest),
    current_user: CurrentUserDep = None,
    svc: SpotifyImportService = Depends(get_spotify_import_service),
    acquisition=Depends(get_acquisition_dispatcher),
    quota=Depends(get_quota_service),
) -> SpotifyTrackRequestResponse:
    """Resolve a Spotify catalog result to MusicBrainz, then use native acquisition."""
    await quota.check_request_quota(current_user.id, current_user.role)
    try:
        resolved = await svc.resolve_track_for_download(
            current_user.id, body.spotify_id
        )
        task_id = await acquisition.request_track(
            user_id=current_user.id,
            recording_mbid=resolved["recording_mbid"],
            release_group_mbid=resolved["release_group_mbid"],
            artist_name=resolved["artist_name"],
            track_title=resolved["track_title"],
            album_title=resolved["album_title"],
            duration_seconds=resolved["duration_seconds"],
            artist_mbid=resolved.get("artist_mbid"),
            cover_url=resolved.get("cover_url"),
        )
    except SpotifyNotLinkedError:
        raise HTTPException(status_code=400, detail="Spotify account not linked")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if task_id == ALREADY_IN_LIBRARY:
        return SpotifyTrackRequestResponse(status="already_in_library")
    return SpotifyTrackRequestResponse(status="queued", task_id=task_id)


@router.post(
    "/playlists/{spotify_playlist_id}/import",
    response_model=SpotifyImportResponse,
)
async def import_spotify_playlist(
    spotify_playlist_id: str,
    body: SpotifyImportRequest = MsgSpecBody(SpotifyImportRequest),
    current_user: CurrentUserDep = None,
    svc: SpotifyImportService = Depends(get_spotify_import_service),
    playlist_service: PlaylistService = Depends(get_playlist_service),
    local_service: LocalFilesService = Depends(get_local_files_service),
) -> SpotifyImportResponse:
    try:
        playlist_id = await svc.ensure_playlist_record(
            current_user.id, spotify_playlist_id, body.name
        )
    except SpotifyNotLinkedError:
        raise HTTPException(status_code=400, detail="Spotify account not linked")
    except Exception as exc:  # noqa: BLE001
        logger.error(
            f"Spotify import setup failed for user {current_user.id} playlist {spotify_playlist_id}: {exc}"
        )
        raise HTTPException(status_code=502, detail="Failed to start playlist import")

    task_key = f"spotify:import:{current_user.id}:{spotify_playlist_id}"
    registry = TaskRegistry.get_instance()
    if not registry.is_running(task_key):
        task = asyncio.create_task(
            _background_import(
                svc,
                current_user.id,
                spotify_playlist_id,
                playlist_id,
                current_user,
                playlist_service,
                local_service,
            )
        )
        try:
            registry.register(task_key, task)
        except RuntimeError:
            pass

    return SpotifyImportResponse(playlist_id=playlist_id)
