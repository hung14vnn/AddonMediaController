"""The YouTube Music proxy fetches upstream in bounded byte ranges.

googlevideo throttles one request for a whole file to about playback speed (31 KB/s
measured) but serves bounded ranges at full speed (~4.8 MB/s). Whatever the client
asks for, every upstream request must carry a bounded Range, and the client must still
get exactly the bytes and headers it asked for in one response.
"""

import re

import httpx
import pytest

from services import ytmusic_stream_service as yt
from services.ytmusic_stream_service import StreamInfo, YTMusicStreamService

pytestmark = pytest.mark.asyncio

PAYLOAD = bytes(range(256)) * 40  # 10,240 bytes
CHUNK = 3000
AUDIO_URL = "https://rr1.googlevideo.test/videoplayback?id=abc"


class FakeGooglevideo:
    """Serves PAYLOAD, honouring bounded ranges; can ignore ranges or reject some."""

    def __init__(self, *, honour_ranges: bool = True) -> None:
        self.honour_ranges = honour_ranges
        self.ranges: list[str | None] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        header = request.headers.get("Range")
        self.ranges.append(header)
        match = re.match(r"^bytes=(\d+)-(\d*)$", header or "")
        if not self.honour_ranges or not match:
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
def small_ranges(monkeypatch):
    monkeypatch.setattr(yt, "_UPSTREAM_RANGE_BYTES", CHUNK)


def make_service(upstream: FakeGooglevideo) -> YTMusicStreamService:
    service = YTMusicStreamService(httpx.AsyncClient(transport=httpx.MockTransport(upstream.handler)))
    service._cache.put(
        StreamInfo(
            video_id="vid:m4a",
            title="t",
            artist="a",
            duration_s=1.0,
            thumbnail=None,
            audio_url=AUDIO_URL,
            content_type="audio/mp4",
        )
    )
    return service


async def collect(chunks) -> bytes:
    return b"".join([chunk async for chunk in chunks])


def assert_all_bounded(ranges: list[str | None]) -> None:
    for header in ranges:
        assert header is not None and re.fullmatch(r"bytes=\d+-\d+", header), header
        start, end = map(int, header[len("bytes=") :].split("-"))
        assert end - start + 1 <= CHUNK


async def test_whole_file_is_fetched_in_bounded_ranges_and_served_as_one_200():
    upstream = FakeGooglevideo()
    chunks, headers, status = await make_service(upstream).proxy_stream("vid", fmt="m4a")
    assert await collect(chunks) == PAYLOAD
    assert status == 200
    assert headers["Content-Length"] == str(len(PAYLOAD))
    assert "Content-Range" not in headers
    assert_all_bounded(upstream.ranges)
    assert len(upstream.ranges) == 4  # 3000 + 3000 + 3000 + 1240


async def test_open_ended_range_from_a_media_element():
    upstream = FakeGooglevideo()
    chunks, headers, status = await make_service(upstream).proxy_stream("vid", "bytes=1500-", fmt="m4a")
    assert await collect(chunks) == PAYLOAD[1500:]
    assert status == 206
    assert headers["Content-Range"] == f"bytes 1500-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"
    assert headers["Content-Length"] == str(len(PAYLOAD) - 1500)
    assert_all_bounded(upstream.ranges)


async def test_bounded_range_is_served_exactly():
    upstream = FakeGooglevideo()
    chunks, headers, status = await make_service(upstream).proxy_stream("vid", "bytes=100-6099", fmt="m4a")
    assert await collect(chunks) == PAYLOAD[100:6100]
    assert status == 206
    assert headers["Content-Range"] == f"bytes 100-6099/{len(PAYLOAD)}"
    assert upstream.ranges == ["bytes=100-3099", "bytes=3100-6099"]


async def test_upstream_that_ignores_ranges_is_relayed_whole():
    upstream = FakeGooglevideo(honour_ranges=False)
    chunks, headers, status = await make_service(upstream).proxy_stream("vid", fmt="m4a")
    assert await collect(chunks) == PAYLOAD
    assert status == 200
    assert len(upstream.ranges) == 1


async def test_suffix_range_is_passed_through_unchanged():
    upstream = FakeGooglevideo()
    chunks, _, _ = await make_service(upstream).proxy_stream("vid", "bytes=-500", fmt="m4a")
    await collect(chunks)
    assert upstream.ranges == ["bytes=-500"]
