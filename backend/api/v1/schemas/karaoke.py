from typing import Literal

from api.v1.schemas.common import AppStruct


KaraokeStatus = Literal["not_generated", "queued", "processing", "ready", "failed"]


class KaraokePrepareRequest(AppStruct):
    track_file_id: str


class KaraokeJobResponse(AppStruct):
    cache_key: str
    status: KaraokeStatus
    job_id: str | None = None
    cached: bool = False
    instrumental_url: str | None = None
    vocals_url: str | None = None
    error_message: str | None = None


KaraokeCacheEntryStatus = Literal["ready", "partial", "legacy"]


class KaraokeCacheEntry(AppStruct):
    """One administrator-visible folder in the karaoke cache.

    ``legacy`` deliberately includes complete cache folders without the current
    metadata file. They are still safe to remove from the management screen.
    """

    id: str
    name: str
    relative_path: str
    status: KaraokeCacheEntryStatus
    size_bytes: int = 0
    instrumental_size_bytes: int = 0
    vocals_size_bytes: int = 0
    created_at: float | None = None
    last_accessed_at: float | None = None
    track_file_id: str | None = None
    track_title: str | None = None
    artist_name: str | None = None
    album_name: str | None = None


class KaraokeCacheEntriesResponse(AppStruct):
    items: list[KaraokeCacheEntry] = []
    total: int = 0


class KaraokeCacheEntryDeleteRequest(AppStruct):
    id: str
