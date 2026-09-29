"""download for YouTube Music ids always serves M4A, whatever the client.

Offline copies are replayed later on any device, and iOS (Safari/AVPlayer) cannot
decode WebM/Opus. YouTube Music is faked so the tests never reach the network.
"""

import pytest

from core import dependencies as deps

pytestmark = pytest.mark.asyncio

_IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)
_ANDROID_UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"
)


class FakeYTMusicStream:
    def __init__(self):
        self.calls: list[dict] = []

    async def proxy_stream(self, video_id, range_header=None, *, title=None, artist=None, fmt="opus"):
        self.calls.append({"video_id": video_id, "range": range_header, "fmt": fmt})

        async def chunks():
            yield b"m4a-bytes"

        return chunks(), {"Content-Type": "audio/mp4", "Accept-Ranges": "bytes"}, 200


@pytest.fixture
def yt(compat_env):
    fake = FakeYTMusicStream()
    compat_env.app.dependency_overrides[deps.get_ytmusic_stream_service] = lambda: fake
    yield fake
    compat_env.app.dependency_overrides.pop(deps.get_ytmusic_stream_service, None)


def _q(env, **extra):
    return {"v": "1.16.1", "c": "pytest", "f": "json", "apiKey": env.secret, **extra}


@pytest.mark.parametrize("user_agent", [_IPHONE_UA, _ANDROID_UA])
async def test_ytmusic_download_is_m4a(compat_env, yt, user_agent):
    r = compat_env.client.get(
        "/subsonic/rest/download",
        params=_q(compat_env, id="yt-R-hYM3BqTbA"),
        headers={"User-Agent": user_agent},
    )
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "audio/mp4"
    assert r.content == b"m4a-bytes"
    assert yt.calls == [{"video_id": "R-hYM3BqTbA", "range": None, "fmt": "m4a"}]


async def test_ytmusic_download_forwards_range(compat_env, yt):
    compat_env.client.get(
        "/subsonic/rest/download",
        params=_q(compat_env, id="yt-R-hYM3BqTbA"),
        headers={"Range": "bytes=0-99"},
    )
    assert yt.calls[0]["range"] == "bytes=0-99"
    assert yt.calls[0]["fmt"] == "m4a"
