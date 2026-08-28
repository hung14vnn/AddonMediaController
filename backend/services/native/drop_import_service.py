"""DropImportService - the Store Sync drop importer (phase 01c).

The user buys music anywhere, downloads the archive from the store's own site,
and hands it to DN. This service stages the upload, safely extracts archives,
identifies each album-shaped unit with the same tiered logic the scanner uses
(MBID tags, then a tag-based album match, then an AcoustID-backed match),
organises identified files into the library via the naming template, and
resolves any open request for the album. Units nothing could identify become
``needs_review`` items the user matches manually (against a release group they
pick) or discards.

Boundaries:
- Only the user's own files ever enter here (an upload); nothing is fetched.
- Identified files import download-style: album identity is stamped on the
  file (``write_album_identity``), the move is atomic and cross-mount safe,
  and the library row carries ``source='drop'``.
- Duplicate policy (owner-signed): a file whose album position is already
  covered imports only when strictly better quality (the old file goes to the
  recycle bin, download-upgrade semantics); otherwise it is skipped.
"""

import asyncio
import errno
import logging
import os
import re
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, NamedTuple

import msgspec

from core.exceptions import ResourceNotFoundError, ValidationError
from infrastructure.validators import validate_spotify_cover_url
from models.drop_import import DropImportItem, DropImportJob, ItemStatus, JobStatus
from services.native.album_matcher import (
    AlbumMatch,
    LocalTrack,
    MBTrack,
    _ReleaseMeta,
    score_release,
)
from services.native.file_processor import row_covers_track
from infrastructure.audio.metadata_engine import AUDIO_SUFFIXES
from services.native.naming import NamingTemplateEngine
from services.native.quality_tiers import tier_for, tier_rank
from services.native.recycle_bin import recycle, resolve_bin_path

if TYPE_CHECKING:
    from infrastructure.audio.fingerprinter import AudioFingerprinter
    from infrastructure.audio.tagger import AudioTagger
    from infrastructure.persistence.drop_import_store import DropImportStore
    from infrastructure.persistence.request_history import RequestHistoryStore
    from infrastructure.persistence.wanted_store import WantedStore
    from infrastructure.sse_publisher import SSEPublisher
    from models.audio import AudioInfo, AudioTag, FingerprintResult
    from services.native.album_matcher import AlbumIdentifier, AlbumMatch
    from services.native.library_manager import LibraryManager
    from services.native.musicbrainz_matcher import MusicBrainzMatcher
    from services.native.target_native_library_service import TargetNativeLibraryService
    from services.preferences_service import PreferencesService

logger = logging.getLogger(__name__)

# mirror the scanner's thresholds so a drop identifies exactly like a scan would
_FINGERPRINT_SCORE_THRESHOLD = 0.70
_UNMAPPED_CONFIDENCE = 0.5
_MAX_FILES_PER_UNIT = 60

# archive safety rails: far above any real purchase, far below a zip bomb
_MAX_ARCHIVE_ENTRIES = 4096
_MAX_ARCHIVE_TOTAL_BYTES = 64 * 2**30

_SOURCE = "drop"
_LOOSE_UNIT_NAME = "Loose tracks"
_SPOTIFY_LOCAL_ALBUM_PREFIX = "spotify:album:"
_YOUTUBE_LOCAL_ALBUM_PREFIX = "youtube:album:"
_PROVIDER_LOCAL_ALBUM_PREFIXES = (
    _SPOTIFY_LOCAL_ALBUM_PREFIX,
    _YOUTUBE_LOCAL_ALBUM_PREFIX,
)

# Callback the DI layer wires to the canonical import invalidation (cache bust +
# album-row materialisation) so a dropped album surfaces in the UI immediately.
OnImport = Callable[..., Awaitable[None]]


class _Entry(NamedTuple):
    path: Path
    tag: "AudioTag"
    info: "AudioInfo"


class _Identified(NamedTuple):
    meta: object  # album_matcher._ReleaseMeta
    tracks: "list[MBTrack]"
    match: "AlbumMatch"


class _Coverage(NamedTuple):
    """F-NL-05: authoritative release-position coverage for one organised unit.

    ``expected`` counts the canonical mapped positions from ``ident.tracks``;
    ``covered`` counts the distinct positions accepted for publication by a
    mapped (authoritative) plan; ``skipped_mapped`` records that at least one
    mapped position was skipped (equal/worse copy, collision, missing recycle
    bin). ``ambiguous`` marks a canonical tracklist with duplicated positions,
    which must never be declared covered."""

    expected: int
    covered: int
    skipped_mapped: bool
    ambiguous: bool

    @property
    def complete(self) -> bool:
        return (
            self.expected > 0
            and not self.ambiguous
            and self.covered == self.expected
            and not self.skipped_mapped
        )


_NO_COVERAGE = _Coverage(expected=0, covered=0, skipped_mapped=False, ambiguous=False)


def _position_key(track) -> tuple:  # noqa: ANN001 - MBTrack from album_matcher
    """Stable identity for an expected canonical position: the release-track
    MBID when present, else the local ``(disc, position)`` pair."""
    if track.release_track_mbid:
        return ("rt", track.release_track_mbid)
    return ("dp", track.disc, track.position)


class _OrganiseResult(NamedTuple):
    imported: int
    upgraded: int
    skipped: int
    bonus: int
    coverage: _Coverage = _NO_COVERAGE


def _strip_stage_prefix(stem: str) -> str:
    """Drop the NNN_ collision prefix create_job adds to staged uploads."""
    return re.sub(r"^\d{3}_", "", stem) or stem


def _safe_component(name: str) -> str:
    """A filesystem-safe single path component for staging (never for the
    library - the naming engine owns that)."""
    cleaned = re.sub(r'[\x00-\x1f/\\:*?"<>|]', "_", name).strip(" .")
    return cleaned or "upload"


class DropImportService:
    def __init__(
        self,
        *,
        store: "DropImportStore",
        tagger: "AudioTagger",
        fingerprinter: "AudioFingerprinter",
        album_identifier: "AlbumIdentifier",
        mb_matcher: "MusicBrainzMatcher",
        naming_engine: "NamingTemplateEngine",
        library_manager: "LibraryManager",
        preferences_service: "PreferencesService",
        request_history: "RequestHistoryStore",
        wanted_store: "WantedStore",
        sse_publisher: "SSEPublisher",
        on_import: OnImport,
        staging_root: Path,
        native_library: "TargetNativeLibraryService | None" = None,
    ) -> None:
        self._store = store
        self._tagger = tagger
        self._fingerprinter = fingerprinter
        self._identifier = album_identifier
        self._mb_matcher = mb_matcher
        self._naming = naming_engine
        self._library = library_manager
        self._prefs = preferences_service
        self._requests = request_history
        self._wanted = wanted_store
        self._sse = sse_publisher
        self._on_import = on_import
        self._staging_root = staging_root
        self._native_library = native_library
        self._tasks: dict[str, asyncio.Task] = {}

    def incoming_dir(self) -> Path:
        """Where the route streams uploads before a job exists. Same filesystem
        as the job staging dirs, so adopting them into a job is a rename."""
        path = self._staging_root / "_incoming"
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def create_job(
        self,
        *,
        user_id: str,
        user_name: str,
        uploads: list[tuple[str, Path]],
        release_group_mbid: str | None = None,
        recording_mbid: str | None = None,
        requested_artist_name: str | None = None,
        requested_artist_mbid: str | None = None,
        requested_album_title: str | None = None,
        requested_track_title: str | None = None,
        requested_cover_url: str | None = None,
    ) -> DropImportJob:
        """Register an upload as a job and start processing it in the background.
        ``uploads`` are (original filename, temp path) pairs the route already
        wrote to disk; this moves them into the job's staging directory."""
        if not uploads:
            raise ValidationError("No files were uploaded")
        self._require_library_root()

        job_id = uuid.uuid4().hex
        staging_dir = self._staging_root / job_id

        def _stage() -> None:
            staging_dir.mkdir(parents=True, exist_ok=True)
            for index, (name, tmp_path) in enumerate(uploads):
                target = staging_dir / f"{index:03d}_{_safe_component(name)}"
                shutil.move(str(tmp_path), str(target))

        await asyncio.to_thread(_stage)

        first_name = uploads[0][0]
        upload_name = (
            first_name
            if len(uploads) == 1
            else f"{first_name} +{len(uploads) - 1} more"
        )
        await self._store.create_job(
            job_id, user_id, user_name, upload_name, str(staging_dir)
        )
        task = asyncio.create_task(
            self._run_job(
                job_id,
                release_group_mbid,
                recording_mbid,
                requested_artist_name,
                requested_artist_mbid,
                requested_album_title,
                requested_track_title,
                requested_cover_url,
            )
        )
        self._tasks[job_id] = task
        task.add_done_callback(lambda t, jid=job_id: self._on_task_done(jid, t))
        job = await self._store.get_job(job_id)
        assert job is not None  # just created
        return job

    async def list_jobs(
        self, *, user_id: str, include_all: bool
    ) -> list[DropImportJob]:
        return await self._store.list_jobs(user_id=None if include_all else user_id)

    async def get_job(
        self, job_id: str, *, user_id: str, is_admin: bool
    ) -> DropImportJob:
        job = await self._store.get_job(job_id)
        if job is None or (job.user_id != user_id and not is_admin):
            raise ResourceNotFoundError("Import job not found")
        return job

    async def match_item(
        self,
        item_id: int,
        release_group_mbid: str | None = None,
        *,
        recording_mbid: str | None = None,
        library_album_id: str | None = None,
        library_track_id: str | None = None,
        artist_name: str | None = None,
        album_title: str | None = None,
        track_title: str | None = None,
        cover_url: str | None = None,
        selected_recording_mbids: list[str] | None = None,
        user_id: str,
        is_admin: bool,
    ) -> DropImportItem:
        """Force-import a ``needs_review`` item against a user-chosen release
        group. Track assignment is best-effort (``score_release`` without the
        acceptance gate) - the user's choice of album is authoritative."""
        item, job = await self._owned_item(item_id, user_id, is_admin)
        if item.status != ItemStatus.NEEDS_REVIEW:
            raise ValidationError("Only items awaiting review can be matched")
        rg = (release_group_mbid or "").strip()
        entries, unreadable = await self._read_entries(
            [Path(p) for p in item.staging_paths if Path(p).exists()]
        )
        if not entries:
            raise ValidationError("The staged files no longer exist on disk")

        if rg.startswith(_PROVIDER_LOCAL_ALBUM_PREFIXES):
            if rg.startswith(_SPOTIFY_LOCAL_ALBUM_PREFIX) and cover_url:
                cover_url = cover_url.strip()
                if not validate_spotify_cover_url(cover_url):
                    raise ValidationError("Spotify artwork URL is invalid")
            ident = self._identify_provider_local_download(
                entries,
                release_group_mbid=rg,
                recording_mbid=recording_mbid,
                artist_name=artist_name,
                album_title=album_title,
                track_title=track_title,
            )
        elif rg:
            picked = await self._identifier.release_tracks(rg, len(entries))
            if picked is None:
                raise ValidationError(
                    "Could not load that release group from MusicBrainz"
                )
            meta, tracks = picked
            match = score_release([self._to_local(e) for e in entries], tracks, meta)
            ident = _Identified(meta=meta, tracks=tracks, match=match)
        else:
            ident = await self._manual_identity(
                entries,
                library_album_id=library_album_id,
                library_track_id=library_track_id,
                artist_name=artist_name,
                album_title=album_title,
                track_title=track_title,
            )

        if selected_recording_mbids is not None:
            selected = {
                value.strip() for value in selected_recording_mbids if value.strip()
            }
            if not selected:
                raise ValidationError("Select at least one track to import")
            entries = [
                entry
                for entry in entries
                if ident.match.assignments.get(str(entry.path)) in selected
            ]
            if not entries:
                raise ValidationError(
                    "The selected tracks could not be matched to the uploaded files"
                )

        # the user's explicit choice is authoritative: full confidence, so the
        # scanner's sticky-anchor guard protects it from later re-attribution
        result = await self._organise(
            entries, ident, confidence_override=1.0, cover_url=cover_url
        )
        await self._finish_item(
            job,
            item.id,
            ident,
            result,
            unreadable,
            staged=entries,
            cover_url=cover_url,
        )
        await self._publish_job(job)
        refreshed = await self._store.get_item(item.id)
        assert refreshed is not None
        return refreshed

    async def discard_item(
        self, item_id: int, *, user_id: str, is_admin: bool
    ) -> DropImportItem:
        item, job = await self._owned_item(item_id, user_id, is_admin)
        if item.status not in (ItemStatus.NEEDS_REVIEW, ItemStatus.FAILED):
            raise ValidationError("Only failed or review-needed items can be discarded")

        def _remove() -> None:
            for raw in item.staging_paths:
                try:
                    Path(raw).unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove staged file %s", raw)

        await asyncio.to_thread(_remove)
        await self._store.update_item(
            item.id, status=ItemStatus.DISCARDED, staging_paths=[], detail="Discarded"
        )
        await self._publish_job(job)
        refreshed = await self._store.get_item(item.id)
        assert refreshed is not None
        return refreshed

    async def _manual_identity(
        self,
        entries: list[_Entry],
        *,
        library_album_id: str | None,
        library_track_id: str | None,
        artist_name: str | None,
        album_title: str | None,
        track_title: str | None,
    ) -> _Identified:
        """Build a local identity selected by the user during manual review."""
        artist = (artist_name or "").strip()
        album_name = (album_title or "").strip()
        title = (track_title or "").strip()
        album = None
        selected_track = None
        album_tracks = []

        if library_album_id or library_track_id:
            if self._native_library is None:
                raise ValidationError("Local library matching is unavailable")
            if library_track_id:
                selected_track = await self._native_library.track(library_track_id)
                if selected_track is None:
                    raise ValidationError("The selected library track no longer exists")
                if library_album_id and selected_track.album_id != library_album_id:
                    raise ValidationError(
                        "The selected track does not belong to that album"
                    )
                library_album_id = selected_track.album_id
            if library_album_id:
                album = await self._native_library.album(library_album_id)
                if album is None:
                    raise ValidationError("The selected library album no longer exists")
                album_tracks = await self._native_library.album_tracks(album.id)

        if album is not None:
            # A selected local album is authoritative. Free-text overrides
            # would create contradictory rows under the same local album ID.
            artist = album.artist_name
            album_name = album.title
            group_id = album.id
            release_id = album.musicbrainz_release_id or album.id
            artist_mbid = album.musicbrainz_artist_id
            year = album.year
            is_various = album.is_compilation
        else:
            if not artist or not album_name or not title:
                raise ValidationError("Track name, album, and artist are required")
            group_id = f"manual:album:{uuid.uuid4().hex}"
            release_id = group_id
            artist_mbid = None
            year = entries[0].tag.year
            is_various = False

        if selected_track is not None:
            title = selected_track.title
        if not title:
            title = (
                selected_track.title
                if selected_track
                else (entries[0].tag.title or "").strip()
            )
        if not title:
            raise ValidationError("A track name is required")

        if selected_track is None and album_tracks:
            folded = " ".join(title.casefold().split())
            selected_track = next(
                (
                    track
                    for track in album_tracks
                    if " ".join(track.title.casefold().split()) == folded
                ),
                None,
            )

        next_position = (
            max((track.track_number for track in album_tracks), default=0) + 1
        )
        tracks: list[MBTrack] = []
        assignments: dict[str, str] = {}
        for index, entry in enumerate(entries):
            existing = selected_track if index == 0 else None
            position = existing.track_number if existing else next_position + index
            disc = existing.disc_number if existing else 1
            recording_id = (
                existing.musicbrainz_recording_id
                if existing and existing.musicbrainz_recording_id
                else f"manual:track:{existing.id if existing else uuid.uuid4().hex}"
            )
            current_title = (
                (title if index == 0 else None)
                or entry.tag.title
                or f"Track {position}"
            )
            tracks.append(
                MBTrack(
                    title=current_title,
                    position=position,
                    disc=disc,
                    absolute_position=position,
                    length_ms=(
                        round(entry.info.duration_seconds * 1000)
                        if entry.info.duration_seconds
                        else None
                    ),
                    recording_mbid=recording_id,
                )
            )
            assignments[str(entry.path)] = recording_id

        meta = _ReleaseMeta(
            release_group_mbid=group_id,
            release_mbid=release_id,
            album_title=album_name,
            artist=artist,
            is_various=is_various,
            artist_mbid=artist_mbid,
            year=year,
            secondary_types=frozenset({"__manual_local__"}),
        )
        return _Identified(
            meta=meta,
            tracks=tracks,
            match=AlbumMatch(
                accepted=True,
                distance=0.0,
                release_group_mbid=group_id,
                release_mbid=release_id,
                assignments=assignments,
                artist_mbid=artist_mbid,
                artist_name=artist,
            ),
        )

    async def clear_discarded_items(
        self, *, user_id: str, is_admin: bool, include_all: bool = False
    ) -> int:
        return await self._store.clear_discarded_items(
            user_id=user_id, include_all=include_all and is_admin
        )

    async def clear_finished_jobs(
        self, *, user_id: str, is_admin: bool, include_all: bool = False
    ) -> int:
        dirs = await self._store.clear_finished_jobs(
            user_id=user_id, include_all=include_all and is_admin
        )

        def _remove_staging() -> None:
            root = self._staging_root.resolve()
            for raw in dirs:
                try:
                    Path(raw).resolve().relative_to(root)
                except ValueError:
                    logger.warning(
                        "Refusing to remove import staging directory outside root: %s",
                        raw,
                    )
                    continue
                shutil.rmtree(raw, ignore_errors=True)

        if dirs:
            await asyncio.to_thread(_remove_staging)
        return len(dirs)

    async def sweep_stale(self) -> None:
        """Startup housekeeping: jobs whose task died with the process are
        failed, and staging directories with nothing left to review are removed."""
        detail = "The server restarted mid-import. Drop the files in again."
        failed = await self._store.fail_stale_processing(detail)
        if failed:
            logger.info("drop_import.stale_failed", extra={"jobs": failed})
        jobs = await self._store.list_jobs(limit=500)

        def _cleanup(dirs: list[str]) -> None:
            for raw in dirs:
                shutil.rmtree(raw, ignore_errors=True)

        removable = [
            job.staging_dir
            for job in jobs
            if job.status != JobStatus.PROCESSING
            and not any(i.status == ItemStatus.NEEDS_REVIEW for i in job.items)
            and Path(job.staging_dir).exists()
        ]
        if removable:
            await asyncio.to_thread(_cleanup, removable)

    def _on_task_done(self, job_id: str, task: asyncio.Task) -> None:
        self._tasks.pop(job_id, None)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.error("Drop import job %s crashed", job_id, exc_info=exc)

    async def _run_job(
        self,
        job_id: str,
        release_group_mbid: str | None = None,
        recording_mbid: str | None = None,
        requested_artist_name: str | None = None,
        requested_artist_mbid: str | None = None,
        requested_album_title: str | None = None,
        requested_track_title: str | None = None,
        requested_cover_url: str | None = None,
    ) -> None:
        try:
            await self._process_job(
                job_id,
                release_group_mbid,
                recording_mbid,
                requested_artist_name,
                requested_artist_mbid,
                requested_album_title,
                requested_track_title,
                requested_cover_url,
            )
        except Exception:
            logger.exception("Drop import job %s failed", job_id)
            try:
                await self._store.set_job_status(
                    job_id,
                    JobStatus.FAILED,
                    "The import didn't finish. Check the server logs.",
                )
                job = await self._store.get_job(job_id)
                if job:
                    await self._publish_job(job)
            except Exception:  # noqa: BLE001 - the failure path must not raise again
                logger.warning("Could not record failure for drop job %s", job_id)

    async def _process_job(
        self,
        job_id: str,
        release_group_mbid: str | None = None,
        recording_mbid: str | None = None,
        requested_artist_name: str | None = None,
        requested_artist_mbid: str | None = None,
        requested_album_title: str | None = None,
        requested_track_title: str | None = None,
        requested_cover_url: str | None = None,
    ) -> None:
        job = await self._store.get_job(job_id)
        if job is None:
            return
        units, notes = await asyncio.to_thread(
            self._extract_and_group, Path(job.staging_dir)
        )
        if notes:
            logger.info(
                "drop_import.extract_notes", extra={"job_id": job_id, "notes": notes}
            )
        if not units:
            error = notes[0] if notes else "No audio files found in the upload"
            await self._store.set_job_status(job_id, JobStatus.FAILED, error)
            await self._publish_job(job)
            return

        item_ids: list[tuple[int, str, list[Path]]] = []
        for folder_name, paths in units:
            item_id = await self._store.add_item(
                job_id, folder_name, [str(p) for p in paths], len(paths)
            )
            item_ids.append((item_id, folder_name, paths))
        await self._publish_job(job)

        for item_id, _folder_name, paths in item_ids:
            try:
                await self._process_item(
                    job,
                    item_id,
                    paths,
                    release_group_mbid=release_group_mbid,
                    recording_mbid=recording_mbid,
                    requested_artist_name=requested_artist_name,
                    requested_artist_mbid=requested_artist_mbid,
                    requested_album_title=requested_album_title,
                    requested_track_title=requested_track_title,
                    requested_cover_url=requested_cover_url,
                )
            except Exception:
                logger.exception("Drop import item %s failed", item_id)
                await self._store.update_item(
                    item_id,
                    status=ItemStatus.FAILED,
                    detail="Couldn't import this folder.",
                )
            await self._publish_job(job)

        # a corrupt/oversized archive alongside good ones must still be reported:
        # the job completes, and the notes ride along so the user sees what was
        # skipped rather than silently getting fewer albums than they dropped
        await self._store.set_job_status(
            job_id, JobStatus.COMPLETED, "; ".join(notes) if notes else None
        )
        await asyncio.to_thread(self._remove_empty_dirs, Path(job.staging_dir))
        await self._publish_job(job)

    def _extract_and_group(
        self, staging_dir: Path
    ) -> tuple[list[tuple[str, list[Path]]], list[str]]:
        """Extract every archive in the staging dir, then group all audio into
        album-shaped units: one per top-level folder, plus one for loose files.
        Runs in a worker thread (archive extraction is heavy blocking work)."""
        notes: list[str] = []
        for child in sorted(staging_dir.iterdir()):
            if not child.is_file() or child.suffix.lower() != ".zip":
                continue
            # staged uploads carry an NNN_ collision prefix; strip it so item
            # names and messages read as the user's own filename, falling back
            # to the prefixed stem when two zips share a name
            display = _strip_stage_prefix(child.stem)
            target = staging_dir / _safe_component(display)
            if target.exists():
                target = staging_dir / _safe_component(child.stem)
            # a truncated upload can carry a zip header and still fail to open;
            # say so rather than letting the file vanish unremarked
            if not zipfile.is_zipfile(child):
                notes.append(f"Couldn't read {display}.zip - the archive is corrupt.")
            else:
                try:
                    self._safe_extract(child, target, notes, display=f"{display}.zip")
                except zipfile.BadZipFile:
                    notes.append(
                        f"Couldn't read {display}.zip - the archive is corrupt."
                    )
            child.unlink(missing_ok=True)

        units: dict[str, list[Path]] = {}
        for child in sorted(staging_dir.iterdir()):
            if child.is_dir():
                audio = sorted(
                    p
                    for p in child.rglob("*")
                    if p.is_file() and p.suffix.lower() in AUDIO_SUFFIXES
                )
                if audio:
                    units[child.name] = audio
            elif child.is_file() and child.suffix.lower() in AUDIO_SUFFIXES:
                units.setdefault(_LOOSE_UNIT_NAME, []).append(child)
        return list(units.items()), notes

    def _safe_extract(
        self, archive: Path, target_dir: Path, notes: list[str], *, display: str = ""
    ) -> None:
        """Extract only audio entries, refusing traversal, absolute paths, and
        decompression bombs. The size cap counts bytes actually written, not the
        zip's declared sizes - headers can lie. Non-audio entries are counted,
        not extracted."""
        skipped = 0
        written_total = 0
        label = display or archive.name
        with zipfile.ZipFile(archive) as zf:
            entries = zf.infolist()
            if len(entries) > _MAX_ARCHIVE_ENTRIES:
                notes.append(f"Skipped {label} - too many files.")
                return
            if sum(e.file_size for e in entries) > _MAX_ARCHIVE_TOTAL_BYTES:
                notes.append(f"Skipped {label} - archive too large.")
                return
            for entry in entries:
                if entry.is_dir():
                    continue
                raw = Path(entry.filename)
                if raw.is_absolute() or ".." in raw.parts:
                    skipped += 1
                    continue
                if raw.suffix.lower() not in AUDIO_SUFFIXES:
                    skipped += 1
                    continue
                safe = target_dir.joinpath(*(_safe_component(p) for p in raw.parts))
                safe.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(entry) as src, open(safe, "wb") as dst:
                    while chunk := src.read(1024 * 1024):
                        written_total += len(chunk)
                        if written_total > _MAX_ARCHIVE_TOTAL_BYTES:
                            dst.close()
                            safe.unlink(missing_ok=True)
                            notes.append(
                                f"Stopped extracting {label} - it unpacks "
                                "far larger than it claims."
                            )
                            return
                        dst.write(chunk)
        if skipped:
            notes.append(
                f"{label}: ignored {skipped} non-audio "
                f"{'file' if skipped == 1 else 'files'}."
            )

    @staticmethod
    def _remove_empty_dirs(root: Path) -> None:
        if not root.exists():
            return
        for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass  # not empty - a needs_review unit still lives here
        try:
            root.rmdir()
        except OSError:
            pass

    async def _process_item(
        self,
        job: DropImportJob,
        item_id: int,
        paths: list[Path],
        *,
        release_group_mbid: str | None = None,
        recording_mbid: str | None = None,
        requested_artist_name: str | None = None,
        requested_artist_mbid: str | None = None,
        requested_album_title: str | None = None,
        requested_track_title: str | None = None,
        requested_cover_url: str | None = None,
    ) -> None:
        entries, unreadable = await self._read_entries(paths)
        if not entries:
            await self._store.update_item(
                item_id,
                status=ItemStatus.FAILED,
                detail="No readable audio files",
                staging_paths=[],
            )
            return
        if len(entries) > _MAX_FILES_PER_UNIT:
            await self._store.update_item(
                item_id,
                status=ItemStatus.NEEDS_REVIEW,
                detail=(
                    f"Too many files to be one album ({len(entries)}). "
                    "Match it manually, or discard it."
                ),
            )
            return

        ident = await self._identify_known_download(
            entries,
            release_group_mbid=release_group_mbid,
            recording_mbid=recording_mbid,
            requested_artist_name=requested_artist_name,
            requested_artist_mbid=requested_artist_mbid,
            requested_album_title=requested_album_title,
            requested_track_title=requested_track_title,
        )
        if ident is None:
            ident = await self._identify(entries)
        if ident is None:
            detail = "Couldn't work out which album this is. Match it manually."
            if unreadable:
                plural = "file" if unreadable == 1 else "files"
                detail += f" ({unreadable} unreadable {plural} ignored)"
            await self._store.update_item(
                item_id, status=ItemStatus.NEEDS_REVIEW, detail=detail
            )
            return

        # Hold identified albums for explicit track selection.
        detail = (
            f"{len(entries)} files identified. Review the album and choose which tracks to import."
        )
        if unreadable:
            plural = "file" if unreadable == 1 else "files"
            detail += f" ({unreadable} unreadable {plural} ignored)"
        await self._store.update_item(
            item_id,
            status=ItemStatus.NEEDS_REVIEW,
            release_group_mbid=ident.meta.release_group_mbid,
            album_title=ident.meta.album_title,
            artist_name=ident.meta.artist,
            detail=detail,
        )

    async def _finish_item(
        self,
        job: DropImportJob,
        item_id: int,
        ident: _Identified,
        result: _OrganiseResult,
        unreadable: int,
        *,
        staged: list[_Entry],
        cover_url: str | None = None,
    ) -> None:
        meta = ident.meta
        if result.imported > 0:
            status = ItemStatus.IMPORTED
        elif result.skipped > 0:
            status = ItemStatus.SKIPPED
        else:
            status = ItemStatus.FAILED
        # F-NL-05: request fulfillment requires complete authoritative coverage -
        # every expected canonical position published, no unreadable file, and no
        # skipped mapped position. Bonus files never count toward coverage.
        fulfills_request = (
            result.imported > 0 and result.coverage.complete and unreadable == 0
        )
        parts: list[str] = []
        if result.imported:
            parts.append(f"imported {result.imported}")
        if result.upgraded:
            parts.append(f"upgraded {result.upgraded} existing files")
        if result.skipped:
            parts.append(f"{result.skipped} already in your library at this quality")
        if result.bonus:
            parts.append(f"{result.bonus} extra files kept alongside the album")
        if unreadable:
            parts.append(
                f"{unreadable} unreadable {'file' if unreadable == 1 else 'files'} ignored"
            )
        if (
            not fulfills_request
            and result.coverage.expected > 0
            and result.coverage.covered < result.coverage.expected
        ):
            parts.append(
                f"covers {result.coverage.covered} of {result.coverage.expected} "
                "album tracks"
            )
        elif not fulfills_request and result.coverage.expected > 0:
            parts.append("album tracks are incomplete in this import")
        await self._store.update_item(
            item_id,
            status=status,
            release_group_mbid=meta.release_group_mbid,
            album_title=meta.album_title,
            artist_name=meta.artist,
            files_imported=result.imported,
            detail=", ".join(parts).capitalize() if parts else None,
            staging_paths=[],
        )
        if result.imported > 0:
            await self._after_import(
                job,
                ident,
                cover_url=cover_url,
                fulfills_request=fulfills_request,
            )

        # staged sources are consumed by the moves; clear any cross-mount leftovers
        def _tidy() -> None:
            for entry in staged:
                try:
                    entry.path.unlink(missing_ok=True)
                except OSError:
                    pass  # best-effort: sweep_stale removes the directory later

        await asyncio.to_thread(_tidy)

    # identification mirrors the scanner's tiers

    async def _read_entries(self, paths: list[Path]) -> tuple[list[_Entry], int]:
        entries: list[_Entry] = []
        unreadable = 0
        for path in paths:
            try:
                tag, info = await asyncio.to_thread(self._tagger.read_tags, path)
                entries.append(_Entry(path=path, tag=tag, info=info))
            except Exception:  # noqa: BLE001 - one bad file must not sink the unit
                unreadable += 1
                logger.warning("Unreadable audio file in drop import: %s", path)
        return entries, unreadable

    @staticmethod
    def _to_local(entry: _Entry) -> LocalTrack:
        tag, info = entry.tag, entry.info
        return LocalTrack(
            path=str(entry.path),
            title=tag.title or "",
            artist=tag.artist or tag.album_artist or "",
            album=tag.album or "",
            track_number=tag.track_number or 0,
            disc_number=tag.disc_number or 1,
            year=tag.year,
            duration_seconds=info.duration_seconds,
            recording_mbid=tag.musicbrainz_recording_id,
        )

    async def _identify(self, entries: list[_Entry]) -> _Identified | None:
        locals_ = [self._to_local(e) for e in entries]

        # Tier 1: consistent MBID tags are authoritative (store purchases are
        # often fully Picard-tagged already).
        tagged_rgs = {
            e.tag.musicbrainz_release_group_id
            for e in entries
            if e.tag.musicbrainz_release_group_id
        }
        if len(tagged_rgs) == 1 and all(
            e.tag.musicbrainz_release_group_id and e.tag.musicbrainz_recording_id
            for e in entries
        ):
            forced = await self._score_against(next(iter(tagged_rgs)), locals_)
            if forced is not None:
                return forced

        if len(entries) >= 2:
            match = await self._try_identify(locals_)
            if match is None:
                enriched, seeds = await self._fingerprint_enrich(entries, locals_)
                if seeds:
                    match = await self._try_identify(enriched, seeds)
                    locals_ = enriched
            if match is not None:
                scored = await self._score_against(match.release_group_mbid, locals_)
                if scored is not None:
                    return scored
            return None

        # Single file: an MBID tag wins, else the fingerprint decides.
        entry = entries[0]
        if entry.tag.musicbrainz_release_group_id:
            return await self._score_against(
                entry.tag.musicbrainz_release_group_id, locals_
            )
        try:
            fp = await self._fingerprinter.fingerprint(entry.path)
        except Exception:  # noqa: BLE001 - no fingerprint just means needs_review
            logger.warning("Fingerprint failed for %s", entry.path)
            return None
        if (
            fp is None
            or fp.status != "pass"
            or (fp.score or 0.0) < _FINGERPRINT_SCORE_THRESHOLD
            or not fp.recording_id
        ):
            return None
        rg = await self._mb_matcher.resolve_recording_to_release_group(fp.recording_id)
        if not rg:
            return None
        locals_ = [msgspec.structs.replace(locals_[0], recording_mbid=fp.recording_id)]
        return await self._score_against(rg, locals_)

    async def _identify_known_download(
        self,
        entries: list[_Entry],
        *,
        release_group_mbid: str | None,
        recording_mbid: str | None,
        requested_artist_name: str | None = None,
        requested_artist_mbid: str | None = None,
        requested_album_title: str | None = None,
        requested_track_title: str | None = None,
    ) -> _Identified | None:
        """Trust the canonical IDs already attached to an app-created download.

        Manual uploads still use the normal identification tiers. This avoids
        treating a completed provider download as an anonymous loose file just
        because the provider chose an opaque filename.
        """
        if (release_group_mbid or "").startswith(_PROVIDER_LOCAL_ALBUM_PREFIXES):
            return self._identify_provider_local_download(
                entries,
                release_group_mbid=release_group_mbid,
                recording_mbid=recording_mbid,
                artist_name=requested_artist_name,
                album_title=requested_album_title,
                track_title=requested_track_title,
            )
        if not release_group_mbid and recording_mbid:
            release_group_mbid = (
                await self._mb_matcher.resolve_recording_to_release_group(
                    recording_mbid
                )
            )
        if not release_group_mbid:
            return None
        picked = await self._identifier.release_tracks(release_group_mbid, len(entries))
        if picked is None:
            return self._identify_known_track_download(
                entries,
                release_group_mbid=release_group_mbid,
                recording_mbid=recording_mbid,
                artist_name=requested_artist_name,
                artist_mbid=requested_artist_mbid,
                album_title=requested_album_title,
                track_title=requested_track_title,
            )
        meta, tracks = picked
        # App-created requests carry an explicit artist selection. Preserve its
        # verified MBID instead of losing it to release-level Various Artists
        # metadata. A single-track request also owns its selected album title.
        artist = (requested_artist_name or "").strip()
        album = (requested_album_title or "").strip()
        if requested_artist_mbid:
            meta = msgspec.structs.replace(
                meta,
                artist=artist or meta.artist,
                album_title=(
                    album if recording_mbid and len(entries) == 1 else meta.album_title
                ),
                is_various=False,
                artist_mbid=requested_artist_mbid,
            )
        elif recording_mbid and len(entries) == 1 and (artist or album):
            meta = msgspec.structs.replace(
                meta,
                artist=artist or meta.artist,
                album_title=album or meta.album_title,
                is_various=False if artist else meta.is_various,
                artist_mbid=None if artist else meta.artist_mbid,
            )
        assignments: dict[str, str] = {}
        if recording_mbid:
            if not any(track.recording_mbid == recording_mbid for track in tracks):
                return self._identify_known_track_download(
                    entries,
                    release_group_mbid=release_group_mbid,
                    recording_mbid=recording_mbid,
                    artist_name=requested_artist_name,
                    artist_mbid=requested_artist_mbid,
                    album_title=requested_album_title,
                    track_title=requested_track_title,
                )
            # A SpotiFLAC track task represents exactly one requested recording.
            if len(entries) == 1:
                assignments[str(entries[0].path)] = recording_mbid
        else:
            scored = score_release(
                [self._to_local(entry) for entry in entries], tracks, meta
            )
            assignments = scored.assignments
        return _Identified(
            meta=meta,
            tracks=tracks,
            match=AlbumMatch(
                accepted=True,
                distance=0.0,
                release_group_mbid=meta.release_group_mbid,
                release_mbid=meta.release_mbid,
                assignments=assignments,
                artist_mbid=meta.artist_mbid,
                artist_name=meta.artist,
            ),
        )

    @staticmethod
    def _identify_provider_local_download(
        entries: list[_Entry],
        *,
        release_group_mbid: str,
        recording_mbid: str | None,
        artist_name: str | None,
        album_title: str | None,
        track_title: str | None,
    ) -> _Identified:
        """Build a library-only album from a provider result without MusicBrainz.

        Stable provider IDs group and de-duplicate local files, but are never
        written into MusicBrainz tag fields.
        """
        first = entries[0]
        artist = (
            artist_name
            or first.tag.album_artist
            or first.tag.artist
            or "Unknown Artist"
        ).strip()
        album = (
            album_title
            or first.tag.album
            or track_title
            or first.tag.title
            or "Unknown Album"
        ).strip()
        tracks: list[MBTrack] = []
        assignments: dict[str, str] = {}
        for index, entry in enumerate(entries, start=1):
            position = entry.tag.track_number or index
            local_recording_id = (
                recording_mbid
                if index == 1 and recording_mbid
                else f"{release_group_mbid}:track:{position}"
            )
            tracks.append(
                MBTrack(
                    title=(track_title if index == 1 else None)
                    or entry.tag.title
                    or f"Track {position}",
                    position=position,
                    disc=entry.tag.disc_number or 1,
                    absolute_position=index,
                    length_ms=(
                        round(entry.info.duration_seconds * 1000)
                        if entry.info.duration_seconds
                        else None
                    ),
                    recording_mbid=local_recording_id,
                )
            )
            assignments[str(entry.path)] = local_recording_id
        meta = _ReleaseMeta(
            release_group_mbid=release_group_mbid,
            release_mbid=release_group_mbid,
            album_title=album,
            artist=artist,
            is_various=False,
            year=first.tag.year,
        )
        return _Identified(
            meta=meta,
            tracks=tracks,
            match=AlbumMatch(
                accepted=True,
                distance=0.0,
                release_group_mbid=release_group_mbid,
                release_mbid=release_group_mbid,
                assignments=assignments,
                artist_name=artist,
            ),
        )

    @staticmethod
    def _identify_known_track_download(
        entries: list[_Entry],
        *,
        release_group_mbid: str | None,
        recording_mbid: str | None,
        artist_name: str | None,
        artist_mbid: str | None,
        album_title: str | None,
        track_title: str | None,
    ) -> _Identified | None:
        """Import a provider-confirmed track without an MB tracklist.

        Only app-created downloads reach ``_identify_known_download``. Manual
        uploads still use the normal identification path.
        """
        if len(entries) != 1 or not release_group_mbid or not recording_mbid:
            return None
        entry = entries[0]
        artist = (artist_name or "").strip()
        album = (album_title or "").strip()
        title = (track_title or "").strip()
        if not artist or not album or not title:
            return None
        position = entry.tag.track_number or 1
        track = MBTrack(
            title=title,
            position=position,
            disc=entry.tag.disc_number or 1,
            absolute_position=position,
            length_ms=(
                round(entry.info.duration_seconds * 1000)
                if entry.info.duration_seconds
                else None
            ),
            recording_mbid=recording_mbid,
        )
        meta = _ReleaseMeta(
            release_group_mbid=release_group_mbid,
            release_mbid="",
            album_title=album,
            artist=artist,
            is_various=False,
            artist_mbid=artist_mbid,
            year=entry.tag.year,
            secondary_types=frozenset({"__known_track_fallback__"}),
        )
        return _Identified(
            meta=meta,
            tracks=[track],
            match=AlbumMatch(
                accepted=True,
                distance=0.0,
                release_group_mbid=release_group_mbid,
                release_mbid="",
                assignments={str(entry.path): recording_mbid},
                artist_mbid=artist_mbid,
                artist_name=artist,
            ),
        )

    async def _try_identify(
        self, locals_: list[LocalTrack], seeds: list[str] | None = None
    ) -> "AlbumMatch | None":
        try:
            match = await self._identifier.identify(locals_, seed_release_groups=seeds)
        except Exception as exc:  # noqa: BLE001 - identification falls back to review
            logger.warning("Album identification failed: %s", exc)
            return None
        return match if match is not None and match.accepted else None

    async def _score_against(
        self, release_group_mbid: str, locals_: list[LocalTrack]
    ) -> _Identified | None:
        picked = await self._identifier.release_tracks(release_group_mbid, len(locals_))
        if picked is None:
            return None
        meta, tracks = picked
        match = score_release(locals_, tracks, meta)
        return _Identified(meta=meta, tracks=tracks, match=match)

    async def _fingerprint_enrich(
        self, entries: list[_Entry], locals_: list[LocalTrack]
    ) -> tuple[list[LocalTrack], list[str]]:
        """The scanner's audio-backed second attempt: fingerprint every file
        (fail-open per file), enrich locals with confirmed recordings, and
        collect the distinct release groups as matcher seeds."""
        enriched: list[LocalTrack] = []
        seeds: list[str] = []
        seen: set[str] = set()
        for entry, local in zip(entries, locals_):
            try:
                fp: "FingerprintResult" = await self._fingerprinter.fingerprint(
                    entry.path
                )
                if (
                    fp.status == "pass"
                    and (fp.score or 0.0) >= _FINGERPRINT_SCORE_THRESHOLD
                    and fp.recording_id
                ):
                    local = msgspec.structs.replace(
                        local, recording_mbid=fp.recording_id
                    )
                    rg = await self._mb_matcher.resolve_recording_to_release_group(
                        fp.recording_id
                    )
                    if rg and rg not in seen:
                        seen.add(rg)
                        seeds.append(rg)
            except Exception as exc:  # noqa: BLE001 - one bad file degrades to tag-only
                logger.warning("Fingerprint/resolve failed for %s: %s", entry.path, exc)
            enriched.append(local)
        return enriched, seeds

    # organisation mirrors the download import

    def _require_library_root(self) -> Path:
        lib = self._prefs.get_typed_library_settings_raw()
        if not lib.library_roots:
            raise ValidationError("Set a library path before importing.")
        return Path(lib.library_roots[0].path)

    async def _organise(
        self,
        entries: list[_Entry],
        ident: _Identified,
        confidence_override: float | None = None,
        cover_url: str | None = None,
    ) -> _OrganiseResult:
        root = self._require_library_root()
        lib = self._prefs.get_typed_library_settings_raw()
        template = lib.naming_template or NamingTemplateEngine.DEFAULT
        meta, tracks, match = ident.meta, ident.tracks, ident.match
        confidence = (
            confidence_override
            if confidence_override is not None
            else max(0.0, round(1.0 - match.distance, 4))
        )
        track_by_recording = {t.recording_mbid: t for t in tracks if t.recording_mbid}

        imported = upgraded = skipped = bonus = 0
        for entry in entries:
            recording = match.assignments.get(str(entry.path))
            track = track_by_recording.get(recording) if recording else None
            if track is not None:
                outcome = await self._import_mapped(
                    entry, meta, track, root, template, confidence, cover_url
                )
                if outcome == "imported":
                    imported += 1
                elif outcome == "upgraded":
                    imported += 1
                    upgraded += 1
                else:
                    skipped += 1
            else:
                if await self._import_bonus(entry, meta, root, template, cover_url):
                    imported += 1
                    bonus += 1
                else:
                    skipped += 1
        return _OrganiseResult(
            imported=imported, upgraded=upgraded, skipped=skipped, bonus=bonus
        )

    async def _import_mapped(
        self,
        entry: _Entry,
        meta,  # noqa: ANN001 - album_matcher._ReleaseMeta
        track: MBTrack,
        root: Path,
        template: str,
        confidence: float,
        cover_url: str | None,
    ) -> str:
        """Import one file mapped to an MB track. Returns 'imported', 'upgraded'
        or 'skipped'."""
        target_tag = self._target_tag(meta, track, entry.tag)
        upgrading = False
        present = await self._library.get_file_at_position(
            meta.release_group_mbid,
            target_tag.disc_number or 1,
            target_tag.track_number,
        )
        if present is not None:
            covers = row_covers_track(
                present,
                recording_mbid=track.recording_mbid,
                title=track.title,
                duration_seconds=entry.info.duration_seconds,
            )
            if covers:
                new_rank = tier_rank(
                    tier_for(entry.info.file_format, entry.info.bitrate)
                )
                old_rank = tier_rank(
                    tier_for(present.get("file_format") or "", present.get("bit_rate"))
                )
                if new_rank <= old_rank:
                    return "skipped"
                old_path = Path(present["file_path"])
                policy = self._prefs.get_download_policy()
                bin_path = resolve_bin_path(
                    policy.recycle_bin_path,
                    [
                        root.path
                        for root in self._prefs.get_typed_library_settings_raw().library_roots
                    ],
                )
                try:
                    if bin_path is not None and old_path.exists():
                        await asyncio.to_thread(recycle, old_path, bin_path)
                    await self._library.soft_delete_file(str(old_path))
                except OSError:
                    logger.warning(
                        "Could not recycle %s; keeping both copies", old_path
                    )
                upgrading = True
            # a non-covering occupant is a squatter from an earlier wrong grab -
            # import alongside, keep it for review (the download importer's D5 rule)

        target = root / self._naming.format_path(
            template, target_tag, entry.info.file_format
        )
        if (
            target.exists()
            and not upgrading
            and not meta.release_group_mbid.startswith(_PROVIDER_LOCAL_ALBUM_PREFIXES)
        ):
            return "skipped"
        await asyncio.to_thread(self._move_into_library, entry.path, target, target_tag)
        await self._library.upsert_file(
            target,
            target_tag,
            entry.info,
            release_group_mbid=meta.release_group_mbid,
            release_mbid=meta.release_mbid,
            recording_mbid=track.recording_mbid,
            confidence=confidence,
            source=_SOURCE,
            cover_url=cover_url,
        )
        return "upgraded" if upgrading else "imported"

    async def _import_bonus(
        self,
        entry: _Entry,
        meta,  # noqa: ANN001 - album_matcher._ReleaseMeta
        root: Path,
        template: str,
        cover_url: str | None,
    ) -> bool:
        """A file the release's tracklist doesn't cover (bonus track, alternate
        take): keep it with the album under its own tags, no recording claim -
        the scanner's unmapped-album-member semantics."""
        target_tag = self._target_tag(meta, None, entry.tag)
        target = root / self._naming.format_path(
            template, target_tag, entry.info.file_format
        )
        if target.exists():
            return False
        await asyncio.to_thread(self._move_into_library, entry.path, target, target_tag)
        await self._library.upsert_file(
            target,
            target_tag,
            entry.info,
            release_group_mbid=meta.release_group_mbid,
            release_mbid=meta.release_mbid,
            recording_mbid=None,
            confidence=_UNMAPPED_CONFIDENCE,
            source=_SOURCE,
            cover_url=cover_url,
        )
        return True

    @staticmethod
    def _target_tag(
        meta,  # noqa: ANN001 - album_matcher._ReleaseMeta
        track: MBTrack | None,
        file_tag: "AudioTag",
    ) -> "AudioTag":
        from models.audio import AudioTag

        album_artist = "Various Artists" if meta.is_various else (meta.artist or None)
        is_provider_local = meta.release_group_mbid.startswith(
            _PROVIDER_LOCAL_ALBUM_PREFIXES
        )
        is_manual_local = "__manual_local__" in meta.secondary_types
        is_known_track_fallback = "__known_track_fallback__" in meta.secondary_types
        suppress_provider_ids = is_provider_local or is_manual_local
        return AudioTag(
            title=(track.title if track else None) or file_tag.title or "",
            # A matched non-compilation release has a canonical artist. Keep a
            # compilation's per-track artist instead, since that is the useful
            # distinction between its tracks.
            artist=(meta.artist if not meta.is_various else file_tag.artist)
            or file_tag.artist
            or meta.artist
            or "",
            album=meta.album_title,
            album_artist=album_artist,
            track_number=track.position if track else (file_tag.track_number or 0),
            disc_number=(track.disc if track else file_tag.disc_number) or 1,
            year=meta.year or file_tag.year,
            genre=file_tag.genre,
            musicbrainz_release_group_id=(
                None if suppress_provider_ids else meta.release_group_mbid
            ),
            musicbrainz_release_id=(
                None
                if suppress_provider_ids or is_known_track_fallback
                else meta.release_mbid
            ),
            musicbrainz_recording_id=None
            if suppress_provider_ids
            else (
                (track.recording_mbid if track else None)
                or file_tag.musicbrainz_recording_id
            ),
            musicbrainz_artist_id=file_tag.musicbrainz_artist_id,
            musicbrainz_album_artist_id=(
                None if suppress_provider_ids else meta.artist_mbid
            ),
            acoustid_id=file_tag.acoustid_id,
            compilation=file_tag.compilation or meta.is_various,
        )

    def _move_into_library(self, source: Path, target_path: Path, target_tag) -> None:  # noqa: ANN001
        """Stage-then-publish move, cross-mount safe (the download importer's
        pattern): rename the source onto the library mount when possible, else
        copy; stamp album identity on the staged copy, never the original; and
        publish with an atomic ``os.replace``. A failure restores the source."""
        target_path.parent.mkdir(parents=True, exist_ok=True)
        # Keep the real extension on the unpublished file. AudioTagger/Mutagen
        # uses it to select the container handler; a bare ``.part`` makes a
        # perfectly valid FLAC look like an unreadable MP4.
        tmp = target_path.parent / (
            f".{target_path.stem}.{uuid.uuid4().hex[:8]}.part{target_path.suffix}"
        )
        consumed_source = False
        try:
            try:
                os.replace(source, tmp)  # same mount: atomic, no copy
                consumed_source = True
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                shutil.copyfile(source, tmp)
                try:
                    shutil.copystat(source, tmp)
                except OSError:
                    pass  # some filesystems reject metadata even for the owner
            self._tagger.write_album_identity(tmp, target_tag)
            os.replace(tmp, target_path)
        except BaseException:
            if consumed_source:
                try:
                    os.replace(tmp, source)
                except OSError:
                    logger.warning("Could not restore staged source %s", source)
            else:
                tmp.unlink(missing_ok=True)
            raise
        if not consumed_source:
            try:
                source.unlink()
            except OSError:
                logger.warning("Could not remove dropped source %s", source)

    # -- post-import hooks --

    async def _after_import(
        self,
        job: DropImportJob,
        ident: _Identified,
        *,
        cover_url: str | None = None,
        fulfills_request: bool,
    ) -> None:
        meta = ident.meta
        rg = meta.release_group_mbid
        if cover_url and rg.startswith(_PROVIDER_LOCAL_ALBUM_PREFIXES):
            try:
                await self._library.set_album_cover_url(rg, cover_url)
                # The native catalog powers the album page.  It has a separate
                # artwork table, so keep its local album projection in sync with
                # the legacy import index used by this pipeline.
                if self._native_library is not None:
                    await self._native_library.set_imported_local_album_artwork(
                        artist_name=meta.artist,
                        album_title=meta.album_title,
                        year=meta.year,
                        cover_url=cover_url,
                    )
            except Exception:  # noqa: BLE001 - artwork must not undo an import
                logger.warning("Could not save provider artwork for %s", rg)
        try:
            await self._on_import(
                mbid=rg,
                artist_mbid=meta.artist_mbid,
                artist_name=meta.artist,
                title=meta.album_title,
                year=meta.year,
            )
        except Exception:  # noqa: BLE001 - invalidation is best-effort
            logger.warning("Import invalidation failed for %s", rg)

        # F-NL-05: a partial import keeps the catalog fresh but leaves the
        # durable request and wanted watch open for normal recovery.
        if not fulfills_request:
            return

        record = None
        try:
            record = await self._requests.async_get_record(rg)
            if record is not None and record.status != "imported":
                await self._requests.async_update_status(
                    rg,
                    "imported",
                    completed_at=datetime.now(timezone.utc).isoformat(),
                )
        except Exception:  # noqa: BLE001 - request sync must never fail the import
            logger.warning("Could not sync request state for %s", rg)

        try:
            watch = await self._wanted.get_watch(rg)
            if watch is not None:
                await self._wanted.mark_fulfilled(rg, "satisfied")
        except Exception:  # noqa: BLE001 - the watcher reconciles later
            logger.warning("Could not fulfil wanted watch for %s", rg)

        if record is not None and record.user_id and record.user_id != job.user_id:
            try:
                await self._sse.publish(
                    f"user:{record.user_id}",
                    "request_imported",
                    {
                        "event_id": uuid.uuid4().hex,
                        "release_group_mbid": rg,
                        "artist_name": meta.artist,
                        "album_title": meta.album_title,
                    },
                )
            except Exception as exc:  # noqa: BLE001 - notification is best-effort
                logger.debug("request_imported publish failed: %s", exc)

    async def _publish_job(self, job: DropImportJob) -> None:
        try:
            await self._sse.publish(
                f"user:{job.user_id}",
                "drop_import_updated",
                {"event_id": uuid.uuid4().hex, "job_id": job.id},
            )
        except Exception as exc:  # noqa: BLE001 - progress push is best-effort
            logger.debug("drop_import_updated publish failed: %s", exc)

    async def _owned_item(
        self, item_id: int, user_id: str, is_admin: bool
    ) -> tuple[DropImportItem, DropImportJob]:
        item = await self._store.get_item(item_id)
        if item is None:
            raise ResourceNotFoundError("Import item not found")
        job = await self._store.get_job(item.job_id)
        if job is None or (job.user_id != user_id and not is_admin):
            raise ResourceNotFoundError("Import item not found")
        return item, job
