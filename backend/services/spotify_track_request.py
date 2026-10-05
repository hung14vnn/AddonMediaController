"""Queue a single Spotify catalog track for native acquisition.

Shared by the web UI route (``POST /me/spotify/tracks/request``) and the
Subsonic extension the player uses (``requestSpotifyDownload``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from services.native.download_service import ALREADY_IN_LIBRARY


@dataclass(frozen=True)
class SpotifyTrackRequestResult:
    status: str  # "queued" | "already_in_library"
    task_id: str | None
    duration_seconds: int | None


async def request_spotify_track(
    *,
    user_id: str,
    user_role: str | None,
    spotify_id: str,
    svc: Any,  # SpotifyImportService
    acquisition: Any,  # AcquisitionDispatcher
    quota: Any,  # QuotaService
) -> SpotifyTrackRequestResult:
    """Resolve a Spotify track to MusicBrainz, then hand it to acquisition.

    Raises the quota's ``ValidationError``, ``SpotifyNotLinkedError`` or
    ``ValueError`` (unresolvable track) for the caller to map.
    """
    await quota.check_request_quota(user_id, user_role)
    resolved = await svc.resolve_track_for_download(spotify_id)
    duration_seconds = resolved.get("duration_seconds")
    if not duration_seconds:
        # Keep the task metadata populated even if an older resolver path
        # returned the track identity without carrying its duration through.
        catalog_track = await svc.get_catalog_track(spotify_id)
        duration_ms = catalog_track.get("duration_ms")
        if duration_ms:
            duration_seconds = round(float(duration_ms) / 1000)
    task_id = await acquisition.request_track(
        user_id=user_id,
        recording_mbid=resolved["recording_mbid"],
        release_group_mbid=resolved["release_group_mbid"],
        artist_name=resolved["artist_name"],
        track_title=resolved["track_title"],
        album_title=resolved["album_title"],
        duration_seconds=duration_seconds,
        artist_mbid=resolved.get("artist_mbid"),
        cover_url=resolved.get("cover_url"),
    )
    if task_id == ALREADY_IN_LIBRARY:
        return SpotifyTrackRequestResult("already_in_library", None, duration_seconds)
    return SpotifyTrackRequestResult("queued", task_id, duration_seconds)
