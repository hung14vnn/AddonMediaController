"""Spotify playlist import."""

from __future__ import annotations

import asyncio
import logging
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, Any

from infrastructure.queue.priority_queue import RequestPriority
from repositories.musicbrainz_album import _pick_best_release_group
from repositories.musicbrainz_base import mb_api_get
from repositories.async_playlist_repository import AsyncPlaylistRepository

if TYPE_CHECKING:
    from repositories.musicbrainz_repository import MusicBrainzRepository
    from repositories.playlist_repository import PlaylistRepository
    from services.per_user_client_factory import PerUserClientFactory
    from services.playlist_service import PlaylistService

logger = logging.getLogger(__name__)

# Maximum concurrent MusicBrainz ISRC lookups at any one time.
# The module-level mb_rate_limiter naturally throttles to 1 req/sec;
# this just caps the fan-out so we don't queue hundreds of coroutines
# at once for very large playlists.
_MB_CONCURRENCY = 4


class SpotifyNotLinkedError(Exception):
    pass


def _best_image_url(images: list[dict], min_size: int = 250) -> str | None:
    if not images:
        return None
    sorted_imgs = sorted(images, key=lambda i: i.get("width") or 0)
    for img in sorted_imgs:
        if (img.get("width") or 0) >= min_size:
            return img.get("url")
    return sorted_imgs[-1].get("url")


def _recording_artist_mbid(recording: dict[str, Any]) -> str | None:
    """Return the primary MusicBrainz artist from a resolved recording.

    The ISRC endpoint includes recording artist credits.  Keeping the first
    credited artist matches Spotify's primary-artist ordering and avoids
    replacing it with the release-level Various Artists credit.
    """
    for credit in recording.get("artist-credit") or []:
        artist = credit.get("artist") if isinstance(credit, dict) else None
        artist_id = artist.get("id") if isinstance(artist, dict) else None
        if isinstance(artist_id, str) and artist_id.strip():
            return artist_id.strip()
    return None


class SpotifyImportService:
    def __init__(
        self,
        client_factory: PerUserClientFactory,
        playlist_repo: PlaylistRepository | None,
        mb_repo: MusicBrainzRepository,
        playlist_service: PlaylistService,
        async_playlist_repo: Any | None = None,
    ) -> None:
        self._client_factory = client_factory
        if async_playlist_repo is None and playlist_repo is None:
            raise ValueError("A playlist repository is required.")
        self._async_repo = (
            async_playlist_repo
            if async_playlist_repo is not None
            else AsyncPlaylistRepository(playlist_repo)
        )
        self._mb_repo = mb_repo
        self._playlist_service = playlist_service

    async def _get_client(self, user_id: str):
        client = await self._client_factory.resolve_spotify(user_id)
        if client is None:
            raise SpotifyNotLinkedError("Spotify account not linked")
        return client

    async def resolve_track_for_download(
        self,
        user_id: str,
        spotify_track_id: str,
        *,
        priority: RequestPriority = RequestPriority.USER_INITIATED,
    ) -> dict[str, Any]:
        """Resolve a Spotify track to the canonical MusicBrainz IDs used by acquisition."""
        client = await self._client_factory.resolve_spotify_catalog()
        if client is None:
            client = await self._get_client(user_id)
        track = await client.get_track(spotify_track_id)
        isrc = ((track.get("external_ids") or {}).get("isrc") or "").strip()
        album = track.get("album") or {}
        artists = track.get("artists") or []
        artist_name = ", ".join(a.get("name", "") for a in artists if a.get("name"))
        track_title = track.get("name") or ""
        album_title = album.get("name") or ""

        recording_ids: list[tuple[str, str | None]] = []
        if isrc:
            try:
                data = await mb_api_get(
                    f"/isrc/{isrc}", priority=priority
                )
                recordings = data.get("recordings") or []
                if isinstance(recordings, dict):
                    recordings = [recordings]
                recording_ids = [
                    (recording_id, _recording_artist_mbid(recording))
                    for recording in recordings
                    if isinstance(recording, dict)
                    and isinstance(recording_id := recording.get("id"), str)
                    and recording_id
                ]
            except Exception:  # noqa: BLE001 - continue with the local Spotify album
                logger.warning("MusicBrainz ISRC lookup failed for Spotify track %s", spotify_track_id)

        for recording_mbid, artist_mbid in recording_ids:
            release_group_mbid = await self._mb_repo.resolve_recording_to_release_group(
                recording_mbid
            )
            if release_group_mbid:
                return self._resolved_track(
                    recording_mbid,
                    release_group_mbid,
                    artist_name,
                    track_title,
                    album_title,
                    track.get("duration_ms"),
                    artist_mbid=artist_mbid,
                )

        # ISRC coverage is incomplete in MusicBrainz. Fall back to a metadata search,
        # but keep the same canonical recording + release-group requirement.
        matches = await self._mb_repo.search_recordings(
            artist_name, track_title, limit=8, priority=priority
        )
        best: tuple[float, str, str] | None = None
        for match in matches:
            title_score = SequenceMatcher(
                None, track_title.casefold(), match.title.casefold()
            ).ratio()
            if title_score < 0.72:
                continue
            for group in match.release_groups:
                album_score = SequenceMatcher(
                    None, album_title.casefold(), group.release_group_title.casefold()
                ).ratio()
                score = title_score * 0.65 + album_score * 0.35
                candidate = (score, match.recording_mbid, group.release_group_mbid)
                if best is None or candidate[0] > best[0]:
                    best = candidate
        if best is not None:
            return self._resolved_track(
                best[1], best[2], artist_name, track_title, album_title, track.get("duration_ms")
            )

        # Keep an unmatchable Spotify result useful: group it under its Spotify album
        # instead of pretending its IDs are MusicBrainz IDs.
        spotify_album_id = str(album.get("id") or spotify_track_id).strip()
        return {
            "recording_mbid": f"spotify:track:{spotify_track_id}",
            "release_group_mbid": f"spotify:album:{spotify_album_id}",
            "artist_name": artist_name,
            "track_title": track_title,
            "album_title": album_title or track_title,
            "duration_seconds": round((track.get("duration_ms") or 0) / 1000) or None,
            "is_spotify_local": True,
            "cover_url": _best_image_url(album.get("images") or []),
        }

    async def resolve_playlist_tracks_for_download(
        self,
        user_id: str,
        spotify_playlist_id: str,
        playlist_tracks: list[Any],
        *,
        priority: RequestPriority = RequestPriority.BACKGROUND_SYNC,
    ) -> dict[str, dict[str, Any]]:
        """Resolve saved playlist rows through their original Spotify playlist."""
        client = await self._get_client(user_id)
        spotify_tracks = await client.get_playlist_tracks(spotify_playlist_id)
        by_key: dict[tuple[str, str, str], list[dict]] = {}
        for track in spotify_tracks:
            album = track.get("album") or {}
            artists = ", ".join(
                artist.get("name", "")
                for artist in track.get("artists") or []
                if artist.get("name")
            )
            key = (
                artists.casefold(),
                (track.get("name") or "").casefold(),
                (album.get("name") or "").casefold(),
            )
            by_key.setdefault(key, []).append(track)

        resolved: dict[str, dict[str, Any]] = {}
        for playlist_track in playlist_tracks:
            key = (
                (playlist_track.artist_name or "").casefold(),
                (playlist_track.track_name or "").casefold(),
                (playlist_track.album_name or "").casefold(),
            )
            matches = by_key.get(key)
            if not matches:
                continue
            spotify_track = matches.pop(0)
            spotify_track_id = str(spotify_track.get("id") or "")
            if spotify_track_id:
                resolved[playlist_track.id] = await self.resolve_track_for_download(
                    user_id, spotify_track_id, priority=priority
                )
        return resolved

    @staticmethod
    def _resolved_track(
        recording_mbid: str,
        release_group_mbid: str,
        artist_name: str,
        track_title: str,
        album_title: str,
        duration_ms: int | None,
        *,
        artist_mbid: str | None = None,
    ) -> dict[str, Any]:
        return {
            "recording_mbid": recording_mbid,
            "release_group_mbid": release_group_mbid,
            "artist_name": artist_name,
            "artist_mbid": artist_mbid,
            "track_title": track_title,
            "album_title": album_title,
            "duration_seconds": round((duration_ms or 0) / 1000) or None,
        }

    async def list_playlists(self, user_id: str) -> list[dict]:
        client = await self._get_client(user_id)

        spotify_user_id = client.spotify_user_id
        if not spotify_user_id:
            me = await client.get_current_user()
            spotify_user_id = me.get("id", "")

        raw = await client.get_user_playlists()

        user_playlists = await self._async_repo.get_all_playlists(user_id)
        imported_mapping: dict[str, str] = {
            pl.source_ref[len("spotify:") :]: pl.id
            for pl in user_playlists
            if pl.source_ref and pl.source_ref.startswith("spotify:")
        }

        result = []
        for p in raw:
            pid = p.get("id") or ""
            owner = p.get("owner") or {}
            if owner.get("id") != spotify_user_id:
                continue
            images = p.get("images") or []
            cover_url = _best_image_url(images)
            result.append(
                {
                    "id": pid,
                    "name": p.get("name") or "",
                    "description": p.get("description") or "",
                    "track_count": (p.get("tracks") or {}).get("total", 0),
                    "cover_url": cover_url,
                    "owner": owner.get("display_name") or "",
                    "imported_playlist_id": imported_mapping.get(pid),
                }
            )
        return result

    async def ensure_playlist_record(
        self, user_id: str, spotify_playlist_id: str, name: str
    ) -> str:
        source_ref = f"spotify:{spotify_playlist_id}"
        existing = await self._playlist_service.get_by_source_ref(source_ref, user_id)
        if existing:
            return existing.id
        record = await self._playlist_service.create_playlist(
            name or "Spotify Playlist", source_ref=source_ref, user_id=user_id
        )
        return record.id

    async def populate_playlist(
        self, user_id: str, spotify_playlist_id: str, playlist_id: str
    ) -> None:
        client = await self._get_client(user_id)

        _pl_info, raw_tracks = await asyncio.gather(
            client.get_playlist(spotify_playlist_id),
            client.get_playlist_tracks(spotify_playlist_id),
        )

        album_to_mbid = await self._resolve_album_mbids(raw_tracks)

        existing_tracks = await self._async_repo.get_tracks(playlist_id)
        if existing_tracks:
            await self._async_repo.remove_tracks(
                playlist_id, [t.id for t in existing_tracks]
            )

        track_dicts = []
        for track in raw_tracks:
            album = track.get("album") or {}
            album_spotify_id = album.get("id") or ""
            mbid = album_to_mbid.get(album_spotify_id)
            artist_name = ", ".join(
                a.get("name", "") for a in (track.get("artists") or []) if a.get("name")
            )
            if mbid:
                cover_url = f"/api/v1/covers/release-group/{mbid}?size=250"
            else:
                cover_url = _best_image_url(album.get("images") or [])
            duration_ms = track.get("duration_ms")
            track_dicts.append(
                {
                    "track_name": track.get("name") or "",
                    "artist_name": artist_name,
                    "album_name": album.get("name") or "",
                    "album_id": mbid or "",
                    "track_source_id": track.get("id") or None,
                    "source_type": "",
                    "track_number": track.get("track_number"),
                    "disc_number": track.get("disc_number"),
                    "duration": duration_ms // 1000 if duration_ms else None,
                    "cover_url": cover_url,
                }
            )

        await self._async_repo.add_tracks(playlist_id, track_dicts)
        logger.info(
            f"Imported Spotify playlist {spotify_playlist_id} - internal {playlist_id} ({len(track_dicts)} tracks)"
        )

    async def _resolve_album_mbids(
        self, raw_tracks: list[dict]
    ) -> dict[str, str | None]:
        album_isrc: dict[str, str | None] = {}
        album_info: dict[str, tuple[str, str]] = {}
        for track in raw_tracks:
            album = track.get("album") or {}
            album_id = album.get("id") or ""
            if not album_id or album_id in album_isrc:
                continue
            album_isrc[album_id] = (track.get("external_ids") or {}).get("isrc")
            artist = ", ".join(
                a.get("name", "") for a in (track.get("artists") or []) if a.get("name")
            )
            album_info[album_id] = (artist, album.get("name") or "")

        semaphore = asyncio.Semaphore(_MB_CONCURRENCY)

        async def resolve_one(album_id: str) -> tuple[str, str | None]:
            async with semaphore:
                isrc = album_isrc[album_id]
                artist, album_name = album_info[album_id]
                mbid = await self._resolve_mbid(isrc, artist, album_name)
                return album_id, mbid

        results = await asyncio.gather(*[resolve_one(aid) for aid in album_isrc])
        return dict(results)

    async def _resolve_mbid(
        self, isrc: str | None, artist: str, album_name: str
    ) -> str | None:
        if isrc:
            try:
                data = await mb_api_get(
                    f"/isrc/{isrc}",
                    priority=RequestPriority.BACKGROUND_SYNC,
                )
                recordings: list[dict] = data.get("recordings") or []
                if isinstance(recordings, dict):
                    recordings = [recordings]
                for rec in recordings:
                    rec_id = rec.get("id")
                    if not rec_id:
                        continue
                    mbid = await self._mb_repo.resolve_recording_to_release_group(
                        rec_id
                    )
                    if mbid:
                        return mbid
                all_releases: list[dict] = []
                for rec in recordings:
                    all_releases.extend(rec.get("releases") or [])
                best = _pick_best_release_group(all_releases)
                if best:
                    return best[0]
            except Exception:  # noqa: BLE001
                pass

        if album_name:
            try:
                results = await self._mb_repo.search_release_groups(
                    artist,
                    album_name,
                    limit=3,
                    include_all_types=False,
                )
                if results:
                    return results[0].musicbrainz_id
            except Exception:  # noqa: BLE001
                pass

        return None
