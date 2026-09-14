"""Playlist track record mapping: a deleted local file must never read as owned."""

from __future__ import annotations

from services.native.target_reference_adapters import _playlist_track_record


def _row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "pt-1",
        "playlist_id": "p-1",
        "position": 0,
        "track_name": "Song",
        "artist_name": "Artist",
        "album_name": "Album",
        "album_id": "album-1",
        "artist_id": "artist-1",
        "track_source_id": "file-1",
        "cover_url": None,
        "source_type": "local",
        "available_sources": '["local"]',
        "format": "flac",
        "track_number": 1,
        "disc_number": 1,
        "duration": 100,
        "created_at": "2026-01-01",
        "plex_rating_key": None,
        "library_file_id": "file-1",
        "local_track_id": "file-1",
    }
    row.update(overrides)
    return row


def test_missing_local_file_clears_every_ownership_field(tmp_path) -> None:
    """library_file_id is a separate column from local_track_id.

    Clearing only local_track_id left a dangling library_file_id, which the
    request endpoints read as proof the track is owned - so a deleted track
    could never be re-requested.
    """
    record = _playlist_track_record(
        _row(
            local_track_availability="missing",
            local_track_path=str(tmp_path / "gone.flac"),
        )
    )

    assert record.library_file_id is None
    assert record.track_source_id is None
    assert record.available_sources == []


def test_indexed_but_deleted_from_disk_is_not_owned(tmp_path) -> None:
    """A file removed from disk before the rescan still reads as 'indexed'."""
    record = _playlist_track_record(
        _row(
            local_track_availability="indexed",
            local_track_path=str(tmp_path / "never-written.flac"),
        )
    )

    assert record.library_file_id is None
    assert record.available_sources == []


def test_present_local_file_stays_owned(tmp_path) -> None:
    present = tmp_path / "present.flac"
    present.write_bytes(b"audio")

    record = _playlist_track_record(
        _row(local_track_availability="indexed", local_track_path=str(present))
    )

    assert record.library_file_id == "file-1"
    assert record.available_sources == ["local"]


def test_row_without_availability_columns_is_left_untouched() -> None:
    """Rows from queries that do not join local_tracks keep their values."""
    record = _playlist_track_record(_row())

    assert record.library_file_id == "file-1"
    assert record.available_sources == ["local"]
