"""Chooses the acquisition backend for a request.

A user-configured download client (slskd or Usenet) wins when one is set up;
otherwise the request goes to Free Music (D24), the native lawful client. This is
the single place that choice is made, so every acquisition path - interactive
album and track requests, batch requests, Weekly Mix, new-release auto-download,
and request approvals routes the same way. The wanted watcher remains on the
built-in client because it needs source scouting and partial-track acquisition.
After 2.0 deletes slskd and Usenet, that watcher will be reworked separately and
this dispatcher will always route to Free Music.

The public acquisition arguments mirror ``DownloadService``. The dispatcher adds
one internal priority hint for resolving a missing album track count before Free
Music ranks sources. Free Music ignores the args it has no use for (year, origin,
dedup, duration) and never returns the ``ALREADY_IN_LIBRARY`` sentinel - its own
drop-import handoff skips or upgrades an owned album after the fact.
"""

from typing import TYPE_CHECKING, Callable

from core.exceptions import ProviderIdentityRequiredError
from infrastructure.queue.priority_queue import RequestPriority
from services.native.download_service import ALREADY_IN_LIBRARY

if TYPE_CHECKING:
    from services.album_service import AlbumService
    from services.native.download_service import DownloadService
    from services.native.free_music_service import FreeMusicService
    from services.preferences_service import PreferencesService
    from services.native.library_ownership_service import LibraryOwnershipService


class AcquisitionDispatcher:
    def __init__(
        self,
        *,
        get_download_service: "Callable[[], DownloadService]",
        get_free_music_service: "Callable[[], FreeMusicService]",
        get_spotiflac_service=None,  # Callable[[], SpotiflacService] | None
        preferences_service: "PreferencesService",
        ownership_service: "LibraryOwnershipService | None" = None,
        get_album_service: "Callable[[], AlbumService] | None" = None,
    ) -> None:
        self._get_download_service = get_download_service
        self._get_free_music_service = get_free_music_service
        self._get_spotiflac_service = get_spotiflac_service
        self._prefs = preferences_service
        self._ownership = ownership_service
        self._get_album_service = get_album_service

    def _use_free_music(self) -> bool:
        if self._prefs.is_builtin_download_ready():
            return False
        return self._get_free_music_service().is_ready()

    def _use_spotiflac(self) -> bool:
        return (
            self._get_spotiflac_service is not None
            and self._prefs.get_spotiflac_connection().enabled
        )

    def _first_ready_source(self) -> str | None:
        """Return the first configured acquisition source that can accept a request."""
        for source in self._prefs.get_source_priority():
            if source == "spotiflac" and self._use_spotiflac():
                return source
            if source == "soulseek" and self._prefs.is_soulseek_ready():
                return source
            if source == "usenet" and self._prefs.is_usenet_ready():
                return source
        return None

    async def request_album(
        self,
        user_id: str,
        release_group_mbid: str,
        artist_name: str,
        album_title: str,
        year: int | None = None,
        track_count: int | None = None,
        recording_mbid: str | None = None,
        track_title: str | None = None,
        track_duration_seconds: float | None = None,
        download_type: str = "album",
        artist_mbid: str | None = None,
        cover_url: str | None = None,
        origin: str = "user",
        release_mbid: str | None = None,
        release_track_mbid: str | None = None,
        track_count_priority: RequestPriority = RequestPriority.USER_INITIATED,
    ) -> str:
        if self._ownership is not None:
            release_group_mbid = await self._ownership.provider_album_id(
                release_group_mbid
            )
            if origin not in {"upgrade", "edition_conversion"}:
                await self._ownership.select_album(user_id, release_group_mbid)
                if await self._ownership.existing_provider_album_ids(
                    [release_group_mbid]
                ):
                    return ALREADY_IN_LIBRARY
            if recording_mbid is not None:
                recording_mbid = await self._ownership.provider_track_id(recording_mbid)
            if artist_mbid is not None:
                artist_mbid = await self._ownership.provider_artist_id(artist_mbid)
        if self._first_ready_source() == "spotiflac":
            return await self._get_spotiflac_service().request_album(
                user_id=user_id,
                release_group_mbid=release_group_mbid,
                artist_name=artist_name,
                album_title=album_title,
                artist_mbid=artist_mbid,
                cover_url=cover_url,
                origin=origin,
                year=year,
                track_count=track_count,
            )
        if self._use_free_music():
            resolved_track_count = await self._free_music_track_count(
                release_group_mbid,
                release_mbid,
                track_count,
                track_count_priority,
            )
            return await self._get_free_music_service().request_album(
                user_id=user_id,
                release_group_mbid=release_group_mbid,
                artist_name=artist_name,
                album_title=album_title,
                track_count=resolved_track_count,
            )
        return await self._get_download_service().request_album(
            user_id=user_id,
            release_group_mbid=release_group_mbid,
            artist_name=artist_name,
            album_title=album_title,
            year=year,
            track_count=track_count,
            recording_mbid=recording_mbid,
            track_title=track_title,
            track_duration_seconds=track_duration_seconds,
            download_type=download_type,
            artist_mbid=artist_mbid,
            origin=origin,
            release_mbid=release_mbid,
            release_track_mbid=release_track_mbid,
        )

    async def request_track(
        self,
        user_id: str,
        recording_mbid: str,
        artist_name: str,
        track_title: str,
        album_title: str | None = None,
        duration_seconds: int | None = None,
        release_group_mbid: str | None = None,
        artist_mbid: str | None = None,
        cover_url: str | None = None,
        origin: str = "user",
        release_mbid: str | None = None,
        release_track_mbid: str | None = None,
        track_number: int | None = None,
        disc_number: int | None = None,
    ) -> str:
        if self._ownership is not None:
            recording_mbid = await self._ownership.provider_track_id(recording_mbid)
            if origin not in {"upgrade", "edition_conversion"}:
                await self._ownership.select_track(user_id, recording_mbid)
                if await self._ownership.provider_track_owned(recording_mbid):
                    return ALREADY_IN_LIBRARY
            if release_group_mbid is not None:
                release_group_mbid = await self._ownership.provider_album_id(
                    release_group_mbid
                )
            if artist_mbid is not None:
                artist_mbid = await self._ownership.provider_artist_id(artist_mbid)
        if self._first_ready_source() == "spotiflac":
            return await self._get_spotiflac_service().request_track(
                user_id=user_id,
                recording_mbid=recording_mbid,
                artist_name=artist_name,
                track_title=track_title,
                album_title=album_title,
                release_group_mbid=release_group_mbid,
                artist_mbid=artist_mbid,
                cover_url=cover_url,
                origin=origin,
            )
        if self._use_free_music():
            if origin != "edition_conversion":
                return await self._get_free_music_service().request_track(
                    user_id=user_id,
                    recording_mbid=recording_mbid,
                    artist_name=artist_name,
                    track_title=track_title,
                )
            return await self._get_free_music_service().request_track(
                user_id=user_id,
                recording_mbid=recording_mbid,
                artist_name=artist_name,
                track_title=track_title,
                origin=origin,
                release_group_mbid=release_group_mbid,
                release_mbid=release_mbid,
                release_track_mbid=release_track_mbid,
                duration_seconds=duration_seconds,
                album_title=album_title,
                track_number=track_number,
                disc_number=disc_number,
            )
        return await self._get_download_service().request_track(
            user_id=user_id,
            recording_mbid=recording_mbid,
            artist_name=artist_name,
            track_title=track_title,
            album_title=album_title,
            duration_seconds=duration_seconds,
            release_group_mbid=release_group_mbid,
            artist_mbid=artist_mbid,
            origin=origin,
            release_mbid=release_mbid,
            release_track_mbid=release_track_mbid,
        )
