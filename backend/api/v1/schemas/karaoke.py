from typing import Literal

from api.v1.schemas.common import AppStruct


KaraokeStatus = Literal["not_generated", "queued", "processing", "ready", "failed"]
KaraokePreviewStatus = Literal["pending", "generating", "ready", "unavailable"]


class KaraokePrepareRequest(AppStruct):
    track_file_id: str


class KaraokeReleaseRequest(AppStruct):
    session_id: str


class KaraokeJobResponse(AppStruct):
    cache_key: str
    status: KaraokeStatus
    job_id: str | None = None
    cached: bool = False
    session_id: str | None = None
    instrumental_url: str | None = None
    vocals_url: str | None = None
    preview_url: str | None = None
    preview_status: KaraokePreviewStatus = "pending"
    error_message: str | None = None


KaraokeCacheEntryStatus = Literal["ready", "preview"]


class KaraokeCacheEntry(AppStruct):
    """One karaoke package currently held in memory.

    ``preview`` entries only have the quick vocal-cut mix while the AI stems are
    still being generated.
    """

    id: str
    name: str
    relative_path: str
    status: KaraokeCacheEntryStatus
    size_bytes: int = 0
    instrumental_size_bytes: int = 0
    vocals_size_bytes: int = 0
    preview_size_bytes: int = 0
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
