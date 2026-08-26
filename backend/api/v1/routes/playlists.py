import asyncio
import logging
from difflib import SequenceMatcher
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from api.v1.schemas.common import StatusMessageResponse
from api.v1.schemas.playlists import (
    AddTracksRequest,
    AddTracksResponse,
    CheckTrackMembershipRequest,
    CheckTrackMembershipResponse,
    CoverUploadResponse,
    CreatePlaylistRequest,
    PlaylistDetailResponse,
    PlaylistListResponse,
    PlaylistSummaryResponse,
    PlaylistTrackResponse,
    RedactedPlaylist,
    RemoveTracksRequest,
    ReorderTrackRequest,
    ReorderTrackResponse,
    ResolveSourcesResponse,
    SetPlaylistPublicRequest,
    UpdatePlaylistRequest,
    UpdateTrackRequest,
)
from api.v1.schemas.request import BatchRequestResponse
from core.dependencies import (
    JellyfinLibraryServiceDep,
    LocalFilesServiceDep,
    NavidromeLibraryServiceDep,
    PlexLibraryServiceDep,
    PlaylistServiceDep,
    get_acquisition_dispatcher,
    get_target_local_files_service,
    get_musicbrainz_repository,
    get_navidrome_folder_scope_service,
    get_quota_service,
    get_spotify_import_service,
)
from core.dependencies.type_aliases import CurrentUserDep
from core.exceptions import PlaylistNotFoundError
from core.task_registry import TaskRegistry
from infrastructure.msgspec_fastapi import MsgSpecBody, MsgSpecRoute
from infrastructure.queue.priority_queue import RequestPriority
from services.playlist_service import (
    PlaylistSummaryView,
    RedactedDetailView,
    RedactedSummaryView,
)
from services.navidrome_folder_scope_service import NavidromeFolderScopeService
from services.native.download_service import ALREADY_IN_LIBRARY

router = APIRouter(
    route_class=MsgSpecRoute,
    prefix="/playlists",
    tags=["playlists"],
)

logger = logging.getLogger(__name__)


async def _get_user_navidrome_folder_ids(
    current_user: CurrentUserDep,
    scope_service: NavidromeFolderScopeService = Depends(
        get_navidrome_folder_scope_service
    ),
) -> tuple[str, ...] | None:
    resolution = await scope_service.resolve(current_user.id)
    return None if resolution.scope.mode == "all" else resolution.scope.folder_ids


UserNavidromeFolderIdsDep = Annotated[
    tuple[str, ...] | None, Depends(_get_user_navidrome_folder_ids)
]


def _normalize_cover_url(url: str | None) -> str | None:
    if url and url.startswith("/api/covers/"):
        return "/api/v1/covers/" + url[len("/api/covers/") :]
    return url


def _normalize_source_type(source_type: str) -> str:
    return source_type


def _normalize_available_sources(sources: list[str] | None) -> list[str] | None:
    if sources is None:
        return None
    return sources


def _custom_cover_url(playlist_id: str, cover_image_path: str | None) -> str | None:
    if cover_image_path:
        return f"/api/v1/playlists/{playlist_id}/cover"
    return None


def _track_to_response(t) -> PlaylistTrackResponse:
    return PlaylistTrackResponse(
        id=t.id,
        position=t.position,
        track_name=t.track_name,
        artist_name=t.artist_name,
        album_name=t.album_name,
        album_id=t.album_id,
        artist_id=t.artist_id,
        track_source_id=t.track_source_id,
        cover_url=_normalize_cover_url(t.cover_url),
        source_type=_normalize_source_type(t.source_type),
        available_sources=_normalize_available_sources(t.available_sources),
        format=t.format,
        track_number=t.track_number,
        disc_number=t.disc_number,
        duration=t.duration,
        created_at=t.created_at,
        plex_rating_key=getattr(t, "plex_rating_key", None),
    )


def _summary_view_to_response(
    view: PlaylistSummaryView | RedactedSummaryView,
) -> PlaylistSummaryResponse | RedactedPlaylist:
    if isinstance(view, RedactedSummaryView):
        return RedactedPlaylist(
            id=view.id,
            track_count=view.track_count,
            owner_name=view.owner_name,
        )
    s = view.record
    return PlaylistSummaryResponse(
        id=s.id,
        name=s.name,
        track_count=s.track_count,
        total_duration=s.total_duration,
        cover_urls=[_normalize_cover_url(u) for u in s.cover_urls]
        if s.cover_urls
        else [],
        custom_cover_url=_custom_cover_url(s.id, s.cover_image_path),
        source_ref=s.source_ref,
        created_at=s.created_at,
        updated_at=s.updated_at,
        is_public=s.is_public,
        is_owner=view.is_owner,
        owner_name=view.owner_name,
    )


def _detail_to_response(
    playlist,
    tracks,
    *,
    is_owner: bool,
    owner_name: str | None,
) -> PlaylistDetailResponse:
    track_responses = [_track_to_response(t) for t in tracks]
    cover_urls = list(
        dict.fromkeys(_normalize_cover_url(t.cover_url) for t in tracks if t.cover_url)
    )[:4]
    total_duration = sum(t.duration for t in tracks if t.duration)
    return PlaylistDetailResponse(
        id=playlist.id,
        name=playlist.name,
        cover_urls=cover_urls,
        custom_cover_url=_custom_cover_url(playlist.id, playlist.cover_image_path),
        source_ref=playlist.source_ref,
        tracks=track_responses,
        track_count=len(tracks),
        total_duration=total_duration or None,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
        is_public=playlist.is_public,
        is_owner=is_owner,
        owner_name=owner_name,
    )


@router.get("", response_model=PlaylistListResponse)
async def list_playlists(
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
) -> PlaylistListResponse:
    views = await service.get_all_playlists(current_user)
    return PlaylistListResponse(playlists=[_summary_view_to_response(v) for v in views])


@router.post("/check-tracks", response_model=CheckTrackMembershipResponse)
async def check_track_membership(
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: CheckTrackMembershipRequest = MsgSpecBody(CheckTrackMembershipRequest),
) -> CheckTrackMembershipResponse:
    tracks = [(t.track_name, t.artist_name, t.album_name) for t in body.tracks]
    membership = await service.check_track_membership(tracks, user_id=current_user.id)
    return CheckTrackMembershipResponse(membership=membership)


@router.post("", response_model=PlaylistDetailResponse, status_code=201)
async def create_playlist(
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: CreatePlaylistRequest = MsgSpecBody(CreatePlaylistRequest),
) -> PlaylistDetailResponse:
    playlist = await service.create_playlist(body.name, user_id=current_user.id)
    return _detail_to_response(playlist, [], is_owner=True, owner_name=None)


@router.get("/{playlist_id}", response_model=PlaylistDetailResponse | RedactedPlaylist)
async def get_playlist(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
) -> PlaylistDetailResponse | RedactedPlaylist:
    view = await service.get_playlist_with_tracks(playlist_id, current_user)
    if isinstance(view, RedactedDetailView):
        return RedactedPlaylist(
            id=view.id,
            track_count=view.track_count,
            owner_name=view.owner_name,
        )
    return _detail_to_response(
        view.record,
        view.tracks,
        is_owner=view.is_owner,
        owner_name=view.owner_name,
    )


@router.put("/{playlist_id}", response_model=PlaylistDetailResponse)
async def update_playlist(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: UpdatePlaylistRequest = MsgSpecBody(UpdatePlaylistRequest),
) -> PlaylistDetailResponse:
    playlist, tracks = await service.update_playlist_with_detail(
        playlist_id,
        current_user,
        name=body.name,
    )
    return _detail_to_response(playlist, tracks, is_owner=True, owner_name=None)


@router.delete("/{playlist_id}", response_model=StatusMessageResponse)
async def delete_playlist(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
) -> StatusMessageResponse:
    await service.delete_playlist(playlist_id, current_user)
    return StatusMessageResponse(status="ok", message="Playlist deleted")


@router.patch("/{playlist_id}/share", response_model=PlaylistSummaryResponse)
async def set_playlist_visibility(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: SetPlaylistPublicRequest = MsgSpecBody(SetPlaylistPublicRequest),
) -> PlaylistSummaryResponse:
    view = await service.set_public(playlist_id, current_user, body.is_public)
    return _summary_view_to_response(view)


@router.post(
    "/{playlist_id}/tracks",
    response_model=AddTracksResponse,
    status_code=201,
)
async def add_tracks(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: AddTracksRequest = MsgSpecBody(AddTracksRequest),
) -> AddTracksResponse:
    track_dicts = [
        {
            "track_name": t.track_name,
            "artist_name": t.artist_name,
            "album_name": t.album_name,
            "album_id": t.album_id,
            "artist_id": t.artist_id,
            "track_source_id": t.track_source_id,
            "cover_url": t.cover_url,
            "source_type": t.source_type,
            "available_sources": t.available_sources,
            "format": t.format,
            "track_number": t.track_number,
            "disc_number": t.disc_number,
            "duration": int(t.duration) if t.duration is not None else None,
            "plex_rating_key": t.plex_rating_key,
        }
        for t in body.tracks
    ]
    created = await service.add_tracks(
        playlist_id, current_user, track_dicts, body.position
    )
    return AddTracksResponse(tracks=[_track_to_response(t) for t in created])


@router.post(
    "/{playlist_id}/tracks/remove",
    response_model=StatusMessageResponse,
)
async def remove_tracks(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: RemoveTracksRequest = MsgSpecBody(RemoveTracksRequest),
) -> StatusMessageResponse:
    removed = await service.remove_tracks(playlist_id, current_user, body.track_ids)
    return StatusMessageResponse(status="ok", message=f"{removed} track(s) removed")


@router.delete(
    "/{playlist_id}/tracks/{track_id}",
    response_model=StatusMessageResponse,
)
async def remove_track(
    playlist_id: str,
    track_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
) -> StatusMessageResponse:
    await service.remove_track(playlist_id, current_user, track_id)
    return StatusMessageResponse(status="ok", message="Track removed")


# Reorder must be registered before the {track_id} PATCH to avoid
# "reorder" being captured as a track_id path parameter.
@router.patch(
    "/{playlist_id}/tracks/reorder",
    response_model=ReorderTrackResponse,
)
async def reorder_track(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    body: ReorderTrackRequest = MsgSpecBody(ReorderTrackRequest),
) -> ReorderTrackResponse:
    actual_position = await service.reorder_track(
        playlist_id,
        current_user,
        body.track_id,
        body.new_position,
    )
    return ReorderTrackResponse(
        status="ok",
        message="Track reordered",
        actual_position=actual_position,
    )


@router.patch(
    "/{playlist_id}/tracks/{track_id}",
    response_model=PlaylistTrackResponse,
)
async def update_track(
    playlist_id: str,
    track_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    navidrome_folder_ids: UserNavidromeFolderIdsDep,
    jf_service: JellyfinLibraryServiceDep,
    local_service: LocalFilesServiceDep,
    nd_service: NavidromeLibraryServiceDep,
    plex_service: PlexLibraryServiceDep,
    body: UpdateTrackRequest = MsgSpecBody(UpdateTrackRequest),
) -> PlaylistTrackResponse:
    result = await service.update_track_source(
        playlist_id,
        current_user,
        track_id,
        source_type=body.source_type,
        available_sources=body.available_sources,
        jf_service=jf_service,
        local_service=local_service,
        nd_service=nd_service,
        plex_service=plex_service,
        navidrome_folder_ids=navidrome_folder_ids,
    )
    return _track_to_response(result)


@router.post(
    "/{playlist_id}/resolve-sources",
    response_model=ResolveSourcesResponse,
)
async def resolve_sources(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    navidrome_folder_ids: UserNavidromeFolderIdsDep,
    jf_service: JellyfinLibraryServiceDep,
    local_service: LocalFilesServiceDep,
    nd_service: NavidromeLibraryServiceDep,
    plex_service: PlexLibraryServiceDep,
    target_local_service=Depends(get_target_local_files_service),
) -> ResolveSourcesResponse:
    sources = await service.resolve_track_sources(
        playlist_id,
        requesting=current_user,
        jf_service=jf_service,
        local_service=local_service,
        additional_local_service=target_local_service,
        nd_service=nd_service,
        plex_service=plex_service,
        navidrome_folder_ids=navidrome_folder_ids,
    )
    return ResolveSourcesResponse(sources=sources)


@router.post("/{playlist_id}/cover", response_model=CoverUploadResponse)
async def upload_cover(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    cover_image: UploadFile = File(...),
) -> CoverUploadResponse:
    max_size = 2 * 1024 * 1024
    chunk_size = 8192
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await cover_image.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_size:
            from core.exceptions import InvalidPlaylistDataError

            raise InvalidPlaylistDataError("Image too large. Maximum size is 2 MB")
        chunks.append(chunk)
    data = b"".join(chunks)
    cover_url = await service.upload_cover(
        playlist_id,
        current_user,
        data,
        cover_image.content_type or "",
    )
    return CoverUploadResponse(cover_url=cover_url)


@router.get("/{playlist_id}/cover")
async def get_cover(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
):
    path = await service.get_cover_path(playlist_id, current_user)
    if path is None:
        raise PlaylistNotFoundError("No cover found")

    media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")

    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.delete(
    "/{playlist_id}/cover",
    response_model=StatusMessageResponse,
)
async def remove_cover(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
) -> StatusMessageResponse:
    await service.remove_cover(playlist_id, current_user)
    return StatusMessageResponse(status="ok", message="Cover removed")


@router.post(
    "/{playlist_id}/request-missing",
    response_model=BatchRequestResponse,
    status_code=202,
)
async def request_missing_tracks(
    playlist_id: str,
    service: PlaylistServiceDep,
    current_user: CurrentUserDep,
    acquisition=Depends(get_acquisition_dispatcher),
    quota=Depends(get_quota_service),
    musicbrainz=Depends(get_musicbrainz_repository),
    spotify=Depends(get_spotify_import_service),
) -> BatchRequestResponse:
    result = await service.get_playlist_with_tracks(playlist_id, current_user)
    if isinstance(result, RedactedDetailView):
        raise HTTPException(status_code=403, detail="Access denied")

    # Playlist rows hold a release-group MBID, not a recording MBID. Resolve the
    # recording first and require it to belong to that exact release group, so this
    # action can request only the playlist track without risking a same-name track
    # from a different album.
    candidates: list[tuple[object, str]] = []
    seen_tracks: set[tuple[str, str, str]] = set()
    for track in result.tracks:
        release_group_mbid = track.album_id
        if not release_group_mbid:
            continue
        if track.available_sources and len(track.available_sources) > 0:
            continue
        key = (
            release_group_mbid.casefold(),
            (track.artist_name or "").casefold(),
            (track.track_name or "").casefold(),
        )
        if key not in seen_tracks:
            seen_tracks.add(key)
            candidates.append((track, release_group_mbid))

    if not candidates:
        return BatchRequestResponse(
            success=True,
            message="No missing tracks found, all tracks already have a source",
        )

    # Reserve the maximum possible number of requests before starting the worker.
    # The worker only submits matched recordings, so this can be conservative when
    # playlist metadata is incomplete, but never allows a batch to bypass quota.
    await quota.check_request_quota(current_user.id, current_user.role, len(candidates))

    task_name = f"playlist-track-requests:{current_user.id}:{playlist_id}"
    source_ref = result.record.source_ref or ""
    spotify_playlist_id = (
        source_ref.removeprefix("spotify:") if source_ref.startswith("spotify:") else None
    )
    task = asyncio.create_task(
        _queue_playlist_tracks(
            candidates,
            current_user.id,
            acquisition,
            musicbrainz,
            spotify,
            spotify_playlist_id,
        )
    )
    try:
        TaskRegistry.get_instance().register(task_name, task)
    except RuntimeError:
        task.cancel()
        raise HTTPException(
            status_code=409,
            detail="Missing tracks for this playlist are already being queued",
        )

    return BatchRequestResponse(
        success=True,
        message=(
            f"{len(candidates)} track{'s' if len(candidates) != 1 else ''} "
            "are being queued"
        ),
        requested=len(candidates),
    )


async def _queue_playlist_tracks(
    candidates: list[tuple[object, str]],
    user_id: str,
    acquisition,
    musicbrainz,
    spotify=None,
    spotify_playlist_id: str | None = None,
) -> None:
    """Resolve and queue a playlist batch without tying up its HTTP request.

    MusicBrainz lookups deliberately use the background lane. A large playlist
    must never outrank page loads or keep the API request open for minutes.
    """
    spotify_resolutions: dict[str, dict] = {}
    if spotify is not None and spotify_playlist_id:
        try:
            spotify_resolutions = await spotify.resolve_playlist_tracks_for_download(
                user_id,
                spotify_playlist_id,
                [track for track, _release_group_mbid in candidates],
                priority=RequestPriority.BACKGROUND_SYNC,
            )
        except Exception:  # noqa: BLE001 - MusicBrainz fallback remains available
            logger.exception("Spotify playlist fallback could not be loaded")

    resolved: list[tuple[object, str, str, dict | None]] = []
    seen_recordings: set[str] = set()
    for track, release_group_mbid in candidates:
        matches = await musicbrainz.search_recordings(
            track.artist_name or "",
            track.track_name or "",
            priority=RequestPriority.BACKGROUND_SYNC,
        )
        matching = [
            match
            for match in matches
            if any(
                group.release_group_mbid == release_group_mbid
                for group in match.release_groups
            )
        ]
        resolved_release_group_mbid = release_group_mbid
        if matching:
            recording_mbid = max(matching, key=lambda match: match.score).recording_mbid
        else:
            # Imported playlists sometimes store a Plex/Jellyfin/Spotify album ID
            # rather than a MusicBrainz release group. Fall back to the album name,
            # but require a strong match so a same-name recording is not filed under
            # an unrelated album.
            album_name = (track.album_name or "").casefold().strip()
            album_matches = [
                (match, group)
                for match in matches
                for group in match.release_groups
                if album_name
                and SequenceMatcher(
                    None,
                    album_name,
                    (group.release_group_title or "").casefold().strip(),
                ).ratio()
                >= 0.78
            ]
            if not album_matches:
                spotify_resolution = spotify_resolutions.get(track.id)
                if not spotify_resolution:
                    continue
                recording_mbid = spotify_resolution["recording_mbid"]
                resolved_release_group_mbid = spotify_resolution["release_group_mbid"]
                resolved.append(
                    (
                        track,
                        resolved_release_group_mbid,
                        recording_mbid,
                        spotify_resolution,
                    )
                )
                continue
            match, group = max(
                album_matches,
                key=lambda item: item[0].score
                + SequenceMatcher(
                    None,
                    album_name,
                    (item[1].release_group_title or "").casefold().strip(),
                ).ratio()
                * 100,
            )
            recording_mbid = match.recording_mbid
            resolved_release_group_mbid = group.release_group_mbid
        if recording_mbid.casefold() in seen_recordings:
            continue
        seen_recordings.add(recording_mbid.casefold())
        resolved.append((track, resolved_release_group_mbid, recording_mbid, None))

    if not resolved:
        logger.info("No playlist tracks could be matched for background queue")
        return

    queued = 0
    for track, release_group_mbid, recording_mbid, spotify_resolution in resolved:
        try:
            task_id = await acquisition.request_track(
                user_id=user_id,
                recording_mbid=recording_mbid,
                release_group_mbid=release_group_mbid,
                artist_name=(spotify_resolution or {}).get("artist_name")
                or track.artist_name
                or "Unknown Artist",
                track_title=(spotify_resolution or {}).get("track_title")
                or track.track_name
                or "Unknown Track",
                album_title=(spotify_resolution or {}).get("album_title")
                or track.album_name
                or None,
                duration_seconds=(spotify_resolution or {}).get("duration_seconds")
                or track.duration,
                artist_mbid=(spotify_resolution or {}).get("artist_mbid")
                or track.artist_id,
                cover_url=(spotify_resolution or {}).get("cover_url")
                or track.cover_url,
            )
        except Exception:  # noqa: BLE001 - one bad track must not sink the batch
            logger.exception("Playlist track request failed for %s", recording_mbid)
            continue
        if task_id == ALREADY_IN_LIBRARY:
            continue
        else:
            queued += 1

    logger.info("Queued %d playlist track requests", queued)
