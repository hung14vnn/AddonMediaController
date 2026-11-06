"""getKaraoke: local karaoke sessions served from RAM (worker faked here)."""

import json

import pytest

from api.v1.schemas.karaoke import KaraokeJobResponse
from core import dependencies as deps

CACHE_KEY = "a" * 64


class FakeKaraoke:
    def __init__(self) -> None:
        self.response = KaraokeJobResponse(
            cache_key=CACHE_KEY,
            status="queued",
            preview_url=f"/api/v1/karaoke/{CACHE_KEY}/preview",
            preview_status="generating",
            session_id="session-1",
        )
        self.prepare_calls: list[tuple[str, str | None]] = []
        self.released: list[str] = []
        self.range_header: str | None = None

    async def prepare(self, file_id: str, session_id: str | None = None):
        self.prepare_calls.append((file_id, session_id))
        return self.response

    async def release(self, session_id: str) -> None:
        self.released.append(session_id)

    async def stream_karaoke(self, cache_key: str, range_header: str | None):
        assert cache_key == CACHE_KEY
        self.range_header = range_header
        data = b"ai-instrumental"
        start, end, status = 0, len(data) - 1, 200
        if range_header:
            first, last = range_header.rsplit("=", 1)[-1].split("-")
            start, end, status = int(first), int(last), 206
        headers = {
            "Content-Type": "audio/mp4",
            "Content-Length": str(end - start + 1),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
        }
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{len(data)}"

        async def chunks():
            yield data[start : end + 1]

        return chunks(), headers, status


@pytest.fixture
def karaoke(compat_env):
    fake = FakeKaraoke()
    compat_env.app.dependency_overrides[deps.get_karaoke_service] = lambda: fake
    yield fake
    compat_env.app.dependency_overrides.pop(deps.get_karaoke_service, None)


def _query(env, params):
    return [("v", "1.16.1"), ("c", "pytest"), ("f", "json"), ("apiKey", env.secret), *params]


def _get(env, params):
    resp = env.client.get("/subsonic/rest/getKaraoke", params=_query(env, params))
    assert resp.status_code == 200
    return json.loads(resp.content)["subsonic-response"]


def _track_id(env) -> str:
    return "tr-" + env.ids["tracks"][0]


def test_reports_a_generating_session_without_a_song(compat_env, karaoke):
    body = _get(compat_env, [("id", _track_id(compat_env)), ("title", "Airbag")])

    payload = body["karaoke"]
    assert payload["status"] == "queued"
    assert payload["streamReady"] is False
    assert payload["sessionId"] == "session-1"
    assert "song" not in payload


def test_preview_ready_returns_a_playable_karaoke_track(compat_env, karaoke):
    karaoke.response.preview_status = "ready"

    payload = _get(
        compat_env,
        [
            ("id", _track_id(compat_env)),
            ("title", "Airbag"),
            ("artist", "Radiohead"),
            ("duration", "283"),
        ],
    )["karaoke"]

    assert payload["streamReady"] is True
    assert payload["preview"] is True
    assert payload["song"]["id"] == "kr-" + CACHE_KEY
    assert payload["song"]["album"] == "Karaoke"
    assert payload["song"]["duration"] == 283
    assert karaoke.prepare_calls[-1][0] == compat_env.ids["tracks"][0]


def test_poll_reuses_the_session_and_stems_replace_the_preview(compat_env, karaoke):
    karaoke.response.preview_status = "ready"
    _get(compat_env, [("id", _track_id(compat_env)), ("session", "session-1")])

    karaoke.response.status = "ready"
    karaoke.response.preview_status = "pending"
    karaoke.response.instrumental_url = f"/api/v1/karaoke/{CACHE_KEY}/instrumental"
    karaoke.response.vocals_url = f"/api/v1/karaoke/{CACHE_KEY}/vocals"
    payload = _get(
        compat_env, [("id", _track_id(compat_env)), ("session", "session-1")]
    )["karaoke"]

    assert karaoke.prepare_calls[-1] == (compat_env.ids["tracks"][0], "session-1")
    assert payload["preview"] is False
    assert payload["status"] == "ready"
    assert payload["song"]["id"] == "kr-" + CACHE_KEY


def test_failed_ai_still_returns_the_preview(compat_env, karaoke):
    karaoke.response.status = "failed"
    karaoke.response.preview_status = "ready"
    karaoke.response.error_message = "Karaoke worker is unavailable"

    payload = _get(compat_env, [("id", _track_id(compat_env))])["karaoke"]

    assert payload["streamReady"] is True
    assert payload["preview"] is True
    assert payload["error"] == "Karaoke worker is unavailable"
    assert payload["song"]["id"] == "kr-" + CACHE_KEY


def test_release_ends_the_session(compat_env, karaoke):
    resp = compat_env.client.get(
        "/subsonic/rest/releaseKaraoke",
        params=_query(compat_env, [("sessionId", "session-1")]),
    )

    assert resp.status_code == 200
    assert json.loads(resp.content)["subsonic-response"]["karaokeRelease"]["released"] is True
    assert karaoke.released == ["session-1"]


def test_karaoke_ids_stream_through_the_normal_stream_endpoint(compat_env, karaoke):
    resp = compat_env.client.get(
        "/subsonic/rest/stream",
        params=_query(compat_env, [("id", "kr-" + CACHE_KEY)]),
        headers={"Range": "bytes=3-6"},
    )

    assert resp.status_code == 206
    assert resp.content == b"inst"
    assert resp.headers["content-range"] == "bytes 3-6/15"
    assert karaoke.range_header == "bytes=3-6"
