"""Track matching and caching for the YouTube Music proxy.

The first byte of a stream used to wait for two yt-dlp extractions — one in
``search()``, one again in ``proxy_stream()``, which looks entries up under
``<video_id>:<fmt>``. Search hits are now cached under that same key and come
from the fast ytmusicapi search, which also carries each candidate's length so
a music video of a different length can't be matched for a short song.
"""

import re

import httpx
import pytest

from services import ytmusic_stream_service as yt
from services.ytmusic_stream_service import StreamInfo, YTMusicStreamService

pytestmark = pytest.mark.asyncio

PAYLOAD = bytes(range(256)) * 40  # 10,240 bytes
AUDIO_URL = "https://rr1.googlevideo.test/videoplayback?id=abc"
STUDIO = "MUSIC_VIDEO_TYPE_ATV"
VIDEO = "MUSIC_VIDEO_TYPE_OMV"


class FakeYTMusic:
    """The parts of ``ytmusicapi.YTMusic`` the service uses."""

    def __init__(self, tracks: list[dict]) -> None:
        self.tracks = tracks
        self.queries: list[str] = []

    def search(self, query: str, filter: str | None = None, limit: int | None = None) -> list[dict]:
        self.queries.append(query)
        return self.tracks


class FakeGooglevideo:
    def handler(self, request: httpx.Request) -> httpx.Response:
        match = re.match(r"^bytes=(\d+)-(\d*)$", request.headers.get("Range") or "")
        if not match:
            return httpx.Response(200, content=PAYLOAD, headers={"Content-Type": "audio/mp4"})
        start = int(match.group(1))
        end = min(int(match.group(2)) if match.group(2) else len(PAYLOAD) - 1, len(PAYLOAD) - 1)
        return httpx.Response(
            206,
            content=PAYLOAD[start : end + 1],
            headers={
                "Content-Type": "audio/mp4",
                "Content-Range": f"bytes {start}-{end}/{len(PAYLOAD)}",
            },
        )


@pytest.fixture(autouse=True)
def isolated_durations():
    yt._known_durations.clear()
    yield
    yt._known_durations.clear()


@pytest.fixture
def extractions(monkeypatch):
    """Record every yt-dlp extraction; `videos` maps id -> (title, duration)."""
    videos: dict[str, tuple[str, float]] = {}
    calls: list[str] = []

    def fake_extract(video_id: str, fmt: str = "opus") -> StreamInfo | None:
        calls.append(video_id)
        if video_id not in videos:
            return None
        title, duration = videos[video_id]
        return StreamInfo(
            video_id=video_id,
            title=title,
            artist="Artist",
            duration_s=duration,
            thumbnail=None,
            audio_url=AUDIO_URL,
            content_type="audio/mp4",
            source_title=title,
            source_artist="Artist",
        )

    monkeypatch.setattr(yt._YtDlp, "extract_video", staticmethod(fake_extract))
    return calls, videos


def make_service(tracks: list[dict]) -> YTMusicStreamService:
    client = httpx.AsyncClient(transport=httpx.MockTransport(FakeGooglevideo().handler))
    service = YTMusicStreamService(client)
    service._yt_client = FakeYTMusic(tracks)
    return service


async def collect(chunks) -> bytes:
    return b"".join([chunk async for chunk in chunks])


def track(
    video_id: str, duration: float | None, *, title: str = "Song", kind: str = STUDIO
) -> dict:
    return {"videoId": video_id, "title": title, "duration_seconds": duration, "videoType": kind}


async def test_streaming_reuses_the_extraction_search_already_did(extractions):
    calls, videos = extractions
    videos["aaaaaaaaaaa"] = ("Song", 200.0)
    service = make_service([track("aaaaaaaaaaa", 200)])

    info = await service.search("Artist", "Song", fmt="m4a", expected_duration_s=200)
    assert info.video_id == "aaaaaaaaaaa"

    chunks, _, status = await service.proxy_stream(info.video_id, fmt="m4a")
    assert await collect(chunks) == PAYLOAD
    assert status == 200
    # One yt-dlp extraction for the whole first play, not one per endpoint.
    assert calls == ["aaaaaaaaaaa"]


async def test_search_cache_hit_returns_the_bare_video_id(extractions):
    calls, videos = extractions
    videos["aaaaaaaaaaa"] = ("Song", 200.0)
    service = make_service([track("aaaaaaaaaaa", 200)])

    first = await service.search("Artist", "Song", fmt="m4a", expected_duration_s=200)
    second = await service.search("Artist", "Song", fmt="m4a", expected_duration_s=200)

    assert first.video_id == second.video_id == "aaaaaaaaaaa"
    assert calls == ["aaaaaaaaaaa"]


async def test_candidates_far_off_the_expected_length_are_skipped(extractions):
    calls, videos = extractions
    videos["bbbbbbbbbbb"] = ("Song", 4000.0)
    videos["aaaaaaaaaaa"] = ("Song", 200.0)
    service = make_service([track("bbbbbbbbbbb", 4000), track("aaaaaaaaaaa", 200)])

    info = await service.search("Artist", "Song", fmt="m4a", expected_duration_s=200)

    assert info.video_id == "aaaaaaaaaaa"
    assert calls == ["aaaaaaaaaaa"]


async def test_a_grossly_long_extract_falls_through_to_the_next_candidate(extractions):
    calls, videos = extractions
    videos["bbbbbbbbbbb"] = ("Song (Full Version)", 5548.0)
    videos["aaaaaaaaaaa"] = ("Song", 200.0)
    service = make_service([track("bbbbbbbbbbb", None), track("aaaaaaaaaaa", None)])

    info = await service.search("Artist", "Song", fmt="m4a", expected_duration_s=200)

    assert info.video_id == "aaaaaaaaaaa"
    assert calls == ["bbbbbbbbbbb", "aaaaaaaaaaa"]


async def test_mv_upgrade_keeps_the_video_when_the_studio_track_is_another_recording(
    extractions,
):
    _, videos = extractions
    videos["ddddddddddd"] = ("Song (Official Music Video)", 5548.0)
    videos["ccccccccccc"] = ("Song", 200.0)
    service = make_service([track("ccccccccccc", 200)])

    info = await service._extract_uncached("ddddddddddd", "m4a")

    # A 3-minute studio track cannot be the audio of a 92-minute video.
    assert info.video_id == "ddddddddddd"
    assert info.duration_s == 5548.0


async def test_mv_upgrade_uses_the_studio_track_of_the_same_length(extractions):
    calls, videos = extractions
    videos["ddddddddddd"] = ("Song (Official Music Video)", 205.0)
    videos["ccccccccccc"] = ("Song", 200.0)
    service = make_service([track("ccccccccccc", 200)])

    info = await service._extract_uncached("ddddddddddd", "m4a")

    # The caller's id stays stable; only the audio behind it is swapped.
    assert info.video_id == "ddddddddddd"
    assert info.duration_s == 200.0
    assert calls == ["ddddddddddd", "ccccccccccc"]


async def test_extraction_records_the_real_length(extractions):
    _, videos = extractions
    videos["eeeeeeeeeee"] = ("Song", 260.0)
    service = make_service([])

    await service._extract_uncached("eeeeeeeeeee", "m4a")

    assert yt.known_duration("eeeeeeeeeee") == 260.0


async def test_mv_upgrade_records_the_swapped_audio_length(extractions):
    _, videos = extractions
    videos["ddddddddddd"] = ("Song (Official Music Video)", 205.0)
    videos["ccccccccccc"] = ("Song", 200.0)
    service = make_service([track("ccccccccccc", 200)])

    await service._extract_uncached("ddddddddddd", "m4a")

    # Listings for the MV id must report the length of the audio actually served.
    assert yt.known_duration("ddddddddddd") == 200.0
