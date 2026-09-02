import sqlite3
import threading
from pathlib import Path

import pytest

from infrastructure.persistence.native_library_store import NativeLibraryStore
from models.local_catalog import (
    CatalogMembership,
    LocalAlbum,
    LocalAlbumExternalIdentity,
    LocalArtist,
    LocalArtistCredit,
    LocalTrack,
    LocalTrackExternalIdentity,
)


@pytest.mark.asyncio
async def test_catalog_is_global_but_library_lists_are_user_selected(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "library.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE auth_users (id TEXT PRIMARY KEY)")

    store = NativeLibraryStore(db_path, threading.Lock())
    artist = LocalArtist(
        id="artist-1",
        display_name="Artist",
        folded_name="artist",
        kind="person",
        created_at=1,
        updated_at=1,
    )
    album = LocalAlbum(
        id="album-1",
        root_id="root-1",
        grouping_key="album-1",
        title="Album",
        album_artist_id=artist.id,
        album_artist_name=artist.display_name,
        created_at=1,
        updated_at=1,
    )
    track = LocalTrack(
        id="track-1",
        local_album_id=album.id,
        root_id="root-1",
        file_path="/music/track.flac",
        relative_path="track.flac",
        path_hash="hash-1",
        file_size_bytes=100,
        file_mtime_ns=1,
        stat_revision="stat-1",
        title="Track",
        artist_name="Artist",
        album_title="Album",
        album_artist_name="Artist",
        file_format="flac",
        imported_at=1,
    )
    await store.create_catalog_membership(
        CatalogMembership(
            album=album,
            artists=[artist],
            tracks=[track],
            track_credits={
                track.id: [LocalArtistCredit(local_artist_id=artist.id, position=0)]
            },
        )
    )
    await store.attach_album_identity(
        LocalAlbumExternalIdentity(
            local_album_id=album.id,
            release_group_mbid="rg-1",
            selected_at=2,
        ),
        expected_album_revision=1,
    )
    await store.attach_track_identity(
        LocalTrackExternalIdentity(
            local_track_id=track.id,
            recording_mbid="recording-1",
            selected_at=2,
        ),
        expected_track_revision=1,
    )

    admin_albums, _ = await store.list_target_albums()
    user_one_albums, _ = await store.list_target_albums(user_id="user-1")
    assert len(admin_albums) == 1
    assert user_one_albums == []

    await store.select_target_library_item("user-1", "album", "RG-1")
    user_one_albums, _ = await store.list_target_albums(user_id="user-1")
    user_two_albums, _ = await store.list_target_albums(user_id="user-2")
    assert len(user_one_albums) == 1
    assert user_two_albums == []
    user_one_artists, _ = await store.list_target_artists(user_id="user-1")
    assert [row["artist_mbid"] for row in user_one_artists] == ["artist-1"]
    user_one_stats = await store.get_target_library_stats(user_id="user-1")
    assert user_one_stats["total_albums"] == 1
    assert user_one_stats["total_tracks"] == 1
    assert user_one_stats["total_size_bytes"] == 100

    # A second user selects the already existing recording. No catalog/file row
    # is inserted, but that track becomes visible in their personal library.
    await store.select_target_library_item("user-2", "track", "recording-1")
    user_two_tracks, _ = await store.list_target_tracks(user_id="user-2")
    assert [row["id"] for row in user_two_tracks] == ["track-1"]
    assert await store.get_target_track("track-1", user_id="user-1") is not None
    assert await store.get_target_track("track-1", user_id="user-2") is not None
    assert await store.get_target_track("track-1", user_id="user-3") is None

    with sqlite3.connect(db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM local_tracks").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_user_scoped_reads_migrate_missing_embedded_release_group_column(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "library.db"
    NativeLibraryStore(db_path, threading.Lock())

    # Databases created before the target catalog schema included the embedded
    # release-group tag can still be opened by the current application.  Admin
    # reads do not reference this column, while user-scoped reads do.
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "ALTER TABLE local_tracks DROP COLUMN embedded_release_group_mbid"
        )

    migrated = NativeLibraryStore(db_path, threading.Lock())
    with sqlite3.connect(db_path) as connection:
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(local_tracks)")
        }
    assert "embedded_release_group_mbid" in columns
    assert await migrated.get_target_library_stats(user_id="user-1")
    tracks, total = await migrated.list_target_tracks(user_id="user-1")
    assert tracks == []
    assert total == 0
