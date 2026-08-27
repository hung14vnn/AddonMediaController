from unittest.mock import AsyncMock, MagicMock

import pytest

from services.native.target_library_repository import TargetLibraryRepository
from services.native.target_native_library_service import TargetNativeLibraryService
from services.native.album_identification_service import _to_grouping_track


MBIDS = {
    "0c1f7f1e-2a3b-4c5d-8e9f-000000000003",
    "0A1F7F1E-2A3B-4C5D-8E9F-000000000001",
    "0b1f7f1e-2a3b-4c5d-8e9f-000000000002",
}


def _repo(mbids: set[str]) -> TargetLibraryRepository:
    store = MagicMock()
    store.target_provider_artist_ids = AsyncMock(return_value=mbids)
    return TargetLibraryRepository(store)


@pytest.mark.asyncio
async def test_page_is_sorted_casefolded_and_starts_after_the_cursor() -> None:
    repo = _repo(MBIDS)

    first = await repo.get_artist_mbid_page(after_mbid="", limit=2)
    assert first == [
        "0a1f7f1e-2a3b-4c5d-8e9f-000000000001",
        "0b1f7f1e-2a3b-4c5d-8e9f-000000000002",
    ]

    second = await repo.get_artist_mbid_page(after_mbid=first[-1], limit=2)
    assert second == ["0c1f7f1e-2a3b-4c5d-8e9f-000000000003"]
    assert await repo.get_artist_mbid_page(after_mbid=second[-1], limit=2) == []


@pytest.mark.asyncio
async def test_empty_library_terminates_immediately() -> None:
    assert await _repo(set()).get_artist_mbid_page(after_mbid="", limit=500) == []


@pytest.mark.asyncio
async def test_blank_mbids_are_skipped_and_limit_is_floored() -> None:
    repo = _repo({"", "0a1f7f1e-2a3b-4c5d-8e9f-000000000001"})
    assert await repo.get_artist_mbid_page(after_mbid="", limit=500) == [
        "0a1f7f1e-2a3b-4c5d-8e9f-000000000001"
    ]
    assert len(await repo.get_artist_mbid_page(after_mbid="", limit=0)) == 1


def test_target_native_track_uses_musicbrainz_cover_when_artwork_url_is_missing() -> None:
    release_group_mbid = "b2b34c72-b92f-45fc-95ec-b92c10308e7e"
    track = TargetNativeLibraryService._track(
        {
            "id": "track-1",
            "release_group_mbid": "local-rg",
            "provider_release_group_mbid": release_group_mbid,
            "track_title": "Love Story",
        }
    )

    assert track.cover_available is True
    assert track.cover_url == (
        f"/api/v1/covers/release-group/{release_group_mbid}?size=500"
    )


def test_target_native_album_uses_musicbrainz_cover_when_artwork_url_is_missing() -> None:
    release_group_mbid = "b2b34c72-b92f-45fc-95ec-b92c10308e7e"
    album = TargetNativeLibraryService._album(
        {
            "release_group_mbid": "local-rg",
            "provider_release_group_mbid": release_group_mbid,
            "album_title": "Mini World",
            "album_artist_name": "Indila",
            "album_artist_mbid": "artist-1",
        }
    )

    assert album.cover_available is True
    assert album.cover_url == (
        f"/api/v1/covers/release-group/{release_group_mbid}?size=500"
    )


def test_target_repository_album_summary_uses_musicbrainz_cover_fallback() -> None:
    release_group_mbid = "b2b34c72-b92f-45fc-95ec-b92c10308e7e"
    summary = TargetLibraryRepository._to_album_summary(
        {
            "release_group_mbid": "local-rg",
            "provider_release_group_mbid": release_group_mbid,
            "album_artist_mbid": "artist-1",
            "album_title": "Mini World",
        }
    )

    assert summary.cover_url == (
        f"/api/v1/covers/release-group/{release_group_mbid}?size=500"
    )


def test_grouping_track_accepts_legacy_rows_without_release_track_mbid() -> None:
    track = _to_grouping_track(
        {
            "id": "track-1",
            "root_id": "root-1",
            "relative_path": "track.m4a",
            "title": "Love Story",
            "artist_name": "Indila",
            "album_title": "Mini World",
            "album_artist_name": "Indila",
            "artist_sort": "Indila",
            "album_artist_sort": "Indila",
            "track_number": 3,
            "disc_number": 1,
            "duration_seconds": 316.3,
            "embedded_recording_mbid": None,
            "embedded_release_mbid": None,
            "embedded_release_group_mbid": None,
            "is_compilation": 0,
            "metadata_incomplete": 0,
            "membership_locked": 0,
            "local_album_id": "album-1",
        }
    )

    assert track.release_track_mbid is None
