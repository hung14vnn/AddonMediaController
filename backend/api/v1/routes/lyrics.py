import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from core.exceptions import ResourceNotFoundError
from core.dependencies import (
    CurrentUserDep, get_jellyfin_library_service, get_navidrome_library_service,
    get_native_lyrics_service,
)
from infrastructure.msgspec_fastapi import AppStruct, MsgSpecRoute
from services.compat.native_lyrics_service import NativeLyricsService
from services.jellyfin_library_service import JellyfinLibraryService
from services.lrclib_lyrics_service import LrclibLyricsService
from services.navidrome_library_service import NavidromeLibraryService

router = APIRouter(route_class=MsgSpecRoute, prefix="/lyrics", tags=["lyrics"])
_lrclib = LrclibLyricsService()
logger = logging.getLogger(__name__)

class LyricsLine(AppStruct):
    text: str = ""
    start_seconds: float | None = None

class LyricsResponse(AppStruct):
    text: str = ""
    is_synced: bool = False
    lines: list[LyricsLine] = []
    source: str = ""

@router.get("", response_model=LyricsResponse)
async def get_lyrics(
    _: CurrentUserDep,
    source: Literal["jellyfin", "navidrome", "local"] = Query(...),
    track_id: str = Query(..., min_length=1),
    artist: str = Query(""), title: str = Query(""), album: str = Query(""), duration: float | None = Query(None, gt=0),
    jellyfin: JellyfinLibraryService = Depends(get_jellyfin_library_service),
    navidrome: NavidromeLibraryService = Depends(get_navidrome_library_service),
    native: NativeLyricsService = Depends(get_native_lyrics_service),
) -> LyricsResponse:
    if source == "jellyfin":
        result = await jellyfin.get_lyrics(track_id)
        if result and result.lines:
            return LyricsResponse(text=result.lyrics_text, is_synced=result.is_synced, lines=[LyricsLine(text=x.text, start_seconds=x.start_seconds) for x in result.lines], source=source)
    elif source == "navidrome":
        result = await navidrome.get_lyrics(track_id, artist=artist, title=title)
        if result and (result.text.strip() or result.lines):
            return LyricsResponse(text=result.text, is_synced=result.is_synced, lines=[LyricsLine(text=x.text, start_seconds=x.start_seconds) for x in result.lines], source=source)
    else:
        try:
            result = await native.get(track_id)
        except ResourceNotFoundError:
            result = None
        if result:
            return LyricsResponse(text="\n".join(x.value for x in result.lines), is_synced=result.synced, lines=[LyricsLine(text=x.value, start_seconds=x.start_ms / 1000 if x.start_ms is not None else None) for x in result.lines], source=source)
    fallback = await _lrclib.get(artist=artist, title=title, album=album, duration=duration)
    if fallback is None:
        raise HTTPException(status_code=404, detail="Lyrics not available")
    return LyricsResponse(lines=[LyricsLine(**line) for line in fallback["lines"]], text=fallback["text"], is_synced=fallback["is_synced"], source="lrclib")
