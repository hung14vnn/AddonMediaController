"""Chooses the acquisition backend for a request.

A user-configured download source is tried in the configured order; a source that
cannot start is handed off to the next source. Otherwise the request goes to Free
Music (D24), the native lawful client. This is the single place that choice is
made, so every acquisition path - interactive album and track requests, batch
requests, Weekly Mix, new-release auto-download, wanted watches, and request
approvals - follows the same priority order. After 2.0 deletes slskd and Usenet,
this dispatcher will always route to Free Music.

The public acquisition arguments mirror ``DownloadService``. The dispatcher adds
one internal priority hint for resolving a missing album track count before Free
Music ranks sources. Free Music ignores the args it has no use for (year, origin,
dedup, duration) and never returns the ``ALREADY_IN_LIBRARY`` sentinel - its own
drop-import handoff skips or upgrades an owned album after the fact.
"""

import logging
from typing import TYPE_CHECKING, Awaitable, Callable

from core.exceptions import ProviderIdentityRequiredError, ResourceNotFoundError
from infrastructure.queue.priority_queue import RequestPriority
from services.native.download_service import ALREADY_IN_LIBRARY

logger = logging.getLogger(__name__)

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
        if self._get_spotiflac_service is None:
            return False
        service = self._get_spotiflac_service()
        settings = self._prefs.get_spotiflac_connection()
        return bool(settings.enabled and service.is_ready())

    def _source_priority(self) -> list[str]:
        getter = getattr(self._prefs, "get_source_priority", None)
        if getter is None:
            return ["soulseek", "usenet"]
        return getter()

    def _source_ready(self, source: str) -> bool:
        if source == "spotiflac":
            return self._use_spotiflac()
        if source == "soulseek":
            getter = getattr(self._prefs, "is_soulseek_ready", None)
            return bool(getter() if getter is not None else self._prefs.is_builtin_download_ready())
        if source == "usenet":
            getter = getattr(self._prefs, "is_usenet_ready", None)
            return bool(getter()) if getter is not None else False
        return False

    def _first_ready_source(self) -> str | None:
        """Return the first configured acquisition source that can accept a request."""
        for source in self._source_priority():
            if self._source_ready(source):
                return source
        return None

    async def _request_with_fallback(
        self,
        method: str,
        *,
        spotiflac_kwargs: dict,
        native_kwargs: dict,
        free_request: Callable[[], Awaitable[str]] | None = None,
    ) -> str:
        """Try configured acquisition sources in order.

        A source can fail while creating its task (bad configuration, unavailable
        mount, provider lookup error, etc.). In that case continue with the next
        ready source instead of pinning the request to the first source forever.
        Runtime failures after a task has been created are handled by the periodic
        retry ladder, which creates the next source task from the persisted task.
        """
        last_error: Exception | None = None
        for source in self._source_priority():
            if not self._source_ready(source):
                continue
            service = (
                self._get_spotiflac_service()
                if source == "spotiflac"
                else self._get_download_service()
            )
            kwargs = spotiflac_kwargs if source == "spotiflac" else native_kwargs
            try:
                return await getattr(service, method)(**kwargs)
            except Exception as exc:  # noqa: BLE001 - try the next configured source
                last_error = exc
                logger.warning(
                    "Acquisition source %s failed for %s; trying the next source",
                    source,
                    method,
                    exc_info=True,
                )

        if self._use_free_music() and free_request is not None:
            return await free_request()
        if last_error is not None:
            raise last_error
        return await getattr(self._get_download_service(), method)(**native_kwargs)

    async def get_quality_snapshot_summary(
        self, task_id: str, user_id: str, user_role: str
    ) -> str | None:
        """Read the summary pinned to the just-created task, regardless of backend."""
        try:
            task = await self._get_download_service().get_task(
                task_id, user_id, user_role
            )
        except ResourceNotFoundError:
            task = await self._get_free_music_service().get_task(
                task_id, user_id=user_id, is_admin=user_role == "admin"
            )
        return getattr(task, "quality_snapshot_summary", None)

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
        native_kwargs = {
            "user_id": user_id,
            "release_group_mbid": release_group_mbid,
            "artist_name": artist_name,
            "album_title": album_title,
            "year": year,
            "track_count": track_count,
            "recording_mbid": recording_mbid,
            "track_title": track_title,
            "track_duration_seconds": track_duration_seconds,
            "download_type": download_type,
            "artist_mbid": artist_mbid,
            "origin": origin,
            "release_mbid": release_mbid,
            "release_track_mbid": release_track_mbid,
        }
        return await self._request_with_fallback(
            "request_album",
            spotiflac_kwargs={
                "user_id": user_id,
                "release_group_mbid": release_group_mbid,
                "artist_name": artist_name,
                "album_title": album_title,
                "artist_mbid": artist_mbid,
                "cover_url": cover_url,
                "origin": origin,
                "year": year,
                "track_count": track_count,
            },
            native_kwargs=native_kwargs,
            free_request=self._free_album_request(
                native_kwargs, release_mbid, track_count_priority
            ),
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
        native_kwargs = {
            "user_id": user_id,
            "recording_mbid": recording_mbid,
            "artist_name": artist_name,
            "track_title": track_title,
            "album_title": album_title,
            "duration_seconds": duration_seconds,
            "release_group_mbid": release_group_mbid,
            "artist_mbid": artist_mbid,
            "cover_url": cover_url,
            "origin": origin,
            "release_mbid": release_mbid,
            "release_track_mbid": release_track_mbid,
        }
        return await self._request_with_fallback(
            "request_track",
            spotiflac_kwargs={
                "user_id": user_id,
                "recording_mbid": recording_mbid,
                "artist_name": artist_name,
                "track_title": track_title,
                "album_title": album_title,
                "release_group_mbid": release_group_mbid,
                "artist_mbid": artist_mbid,
                "cover_url": cover_url,
                "origin": origin,
            },
            native_kwargs=native_kwargs,
            free_request=self._free_track_request(
                native_kwargs, origin, release_group_mbid, release_mbid,
                release_track_mbid, duration_seconds, album_title, track_number,
                disc_number,
            ),
        )

    async def _free_music_track_count(
        self,
        release_group_mbid: str,
        release_mbid: str | None,
        track_count: int | None,
        priority: RequestPriority,
    ) -> int | None:
        """Resolve the album size only when Free Music is actually selected."""
        if track_count is not None or not release_group_mbid:
            return track_count
        if self._get_album_service is None:
            return track_count
        if release_mbid:
            info = await self._get_album_service().get_exact_edition_tracks_info(
                release_group_mbid, release_mbid, priority=priority
            )
        else:
            info = await self._get_album_service().get_album_tracks_info(
                release_group_mbid, priority=priority
            )
        total_tracks = getattr(info, "total_tracks", None)
        if not total_tracks:
            raise ProviderIdentityRequiredError(
                "Free Music needs the album tracklist to determine what to download"
            )
        return total_tracks

    def _free_album_request(
        self, native_kwargs: dict, release_mbid: str | None, priority: RequestPriority
    ) -> Callable[[], Awaitable[str]]:
        async def request() -> str:
            track_count = await self._free_music_track_count(
                native_kwargs["release_group_mbid"],
                release_mbid,
                native_kwargs.get("track_count"),
                priority,
            )
            return await self._get_free_music_service().request_album(
                user_id=native_kwargs["user_id"],
                release_group_mbid=native_kwargs["release_group_mbid"],
                artist_name=native_kwargs["artist_name"],
                album_title=native_kwargs["album_title"],
                track_count=track_count,
            )

        return request

    def _free_track_request(
        self,
        native_kwargs: dict,
        origin: str,
        release_group_mbid: str | None,
        release_mbid: str | None,
        release_track_mbid: str | None,
        duration_seconds: int | None,
        album_title: str | None,
        track_number: int | None,
        disc_number: int | None,
    ) -> Callable[[], Awaitable[str]]:
        async def request() -> str:
            kwargs = {
                "user_id": native_kwargs["user_id"],
                "recording_mbid": native_kwargs["recording_mbid"],
                "artist_name": native_kwargs["artist_name"],
                "track_title": native_kwargs["track_title"],
            }
            if origin == "edition_conversion":
                kwargs.update(
                    {
                        "origin": origin,
                        "release_group_mbid": release_group_mbid,
                        "release_mbid": release_mbid,
                        "release_track_mbid": release_track_mbid,
                        "duration_seconds": duration_seconds,
                        "album_title": album_title,
                        "track_number": track_number,
                        "disc_number": disc_number,
                    }
                )
            return await self._get_free_music_service().request_track(**kwargs)

        return request
