from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from api.v1.schemas.karaoke import KaraokeJobResponse, KaraokePrepareRequest
from core.dependencies import get_karaoke_service
from core.exceptions import RangeNotSatisfiableError
from infrastructure.msgspec_fastapi import MsgSpecBody, MsgSpecRoute
from middleware import CurrentUserDep
from services.karaoke_service import KaraokeService

router = APIRouter(route_class=MsgSpecRoute, prefix="/karaoke", tags=["karaoke"])


@router.post("", response_model=KaraokeJobResponse)
async def prepare_karaoke(
    _current_user: CurrentUserDep,
    body: KaraokePrepareRequest = MsgSpecBody(KaraokePrepareRequest),
    service: KaraokeService = Depends(get_karaoke_service),
) -> KaraokeJobResponse:
    return await service.prepare(body.track_file_id)


@router.get("/jobs/{job_id}", response_model=KaraokeJobResponse)
async def get_karaoke_job(
    job_id: str,
    _current_user: CurrentUserDep,
    service: KaraokeService = Depends(get_karaoke_service),
) -> KaraokeJobResponse:
    return await service.get_job(job_id)


@router.get("/{track_file_id}/status", response_model=KaraokeJobResponse)
async def get_karaoke_status(
    track_file_id: str,
    _current_user: CurrentUserDep,
    service: KaraokeService = Depends(get_karaoke_service),
) -> KaraokeJobResponse:
    """Report the current karaoke state without starting generation."""
    return await service.status(track_file_id)


@router.get("/{cache_key}/{stem}")
async def stream_karaoke_stem(
    cache_key: str,
    stem: Literal["instrumental", "vocals"],
    request: Request,
    _current_user: CurrentUserDep,
    service: KaraokeService = Depends(get_karaoke_service),
) -> StreamingResponse:
    try:
        chunks, headers, status_code = await service.stream_stem(
            cache_key, stem, request.headers.get("Range")
        )
    except RangeNotSatisfiableError as exc:
        raise HTTPException(
            status_code=416,
            detail="Range not satisfiable",
            headers={"Content-Range": f"bytes */{exc.file_size}"},
        ) from exc
    return StreamingResponse(
        chunks,
        status_code=status_code,
        headers=headers,
        media_type="audio/mp4",
    )
