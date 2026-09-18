from infrastructure.msgspec_fastapi import AppStruct


class PlaybackSessionResponse(AppStruct):
    play_session_id: str
    item_id: str


class StartPlaybackRequest(AppStruct):
    play_session_id: str | None = None


class ProgressReportRequest(AppStruct):
    play_session_id: str
    position_seconds: float
    is_paused: bool = False


class StopReportRequest(AppStruct):
    play_session_id: str
    position_seconds: float


class YTMusicStreamSearchResponse(AppStruct):
    video_id: str
    title: str
    artist: str
    duration_s: float | None = None
    thumbnail: str | None = None

