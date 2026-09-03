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
