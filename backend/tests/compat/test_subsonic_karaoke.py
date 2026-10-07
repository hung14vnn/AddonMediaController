"""getKaraoke: a karaoke version of a song, picked from a YouTube search (faked here)."""

import json

import pytest

from api.compat.subsonic import router
from core import dependencies as deps
from services.compat.karaoke import pick_karaoke, search_query


def _v(vid, title, duration=240, channel="Sing King"):
    return {"id": vid, "title": title, "duration": duration, "channel": channel}


def test_picks_a_karaoke_upload_of_the_same_song():
    candidates = [
        _v("orig0000001", "Ed Sheeran - Shape of You (Official Music Video)"),
        _v("other000001", "Perfect - Ed Sheeran (Karaoke Version)"),
        _v("kara0000001", "Ed Sheeran - Shape Of You (Karaoke Version)", 236),
    ]
    assert pick_karaoke("Shape of You", "Ed Sheeran", 233, candidates)["id"] == "kara0000001"


def test_rejects_other_versions_and_wrong_lengths():
    candidates = [
        _v("remix000001", "Shape of You (Remix) Karaoke"),
        _v("short000001", "Shape of You Karaoke (Short)", 90),
    ]
    assert pick_karaoke("Shape of You", "Ed Sheeran", 233, candidates) is None


def test_a_keyword_in_the_song_name_is_not_a_karaoke_marker():
    # "Beat It" contains "beat", which alone would read as an instrumental.
    assert pick_karaoke("Beat It", "Michael Jackson", 258, [_v("mv000000001", "Michael Jackson - Beat It", 258)]) is None
    hit = pick_karaoke("Beat It", "Michael Jackson", 258, [_v("kara0000002", "Beat It - Michael Jackson | Karaoke", 260)])
    assert hit["id"] == "kara0000002"


def test_vietnamese_beat_upload_matches_without_accents_mattering():
    candidates = [_v("vnbeat00001", "Em Của Ngày Hôm Qua - Sơn Tùng M-TP | Beat Chuẩn Tone Nam", 230, "Beat Việt")]
    assert pick_karaoke("Em Của Ngày Hôm Qua", "Sơn Tùng M-TP", 226, candidates)["id"] == "vnbeat00001"


def test_query_drops_features_and_extra_artists():
    assert search_query("Señorita (feat. X)", "Shawn Mendes, Camila Cabello") == "Señorita Shawn Mendes karaoke"


class FakeYT:
    def __init__(self, results):
        self.results = results
        self.queries: list[str] = []

    async def search_videos(self, query, limit=10):
        self.queries.append(query)
        return self.results


@pytest.fixture
def yt(compat_env):
    fake = FakeYT([_v("kara0000001", "Ed Sheeran - Shape Of You (Karaoke Version)", 236)])
    compat_env.app.dependency_overrides[deps.get_ytmusic_stream_service] = lambda: fake
    router._KARAOKE.clear()
    yield fake
    compat_env.app.dependency_overrides.pop(deps.get_ytmusic_stream_service, None)
    router._KARAOKE.clear()


def _get(env, params):
    q = [("v", "1.16.1"), ("c", "pytest"), ("f", "json"), ("apiKey", env.secret), *params]
    resp = env.client.get("/subsonic/rest/getKaraoke", params=q)
    assert resp.status_code == 200
    return json.loads(resp.content)["subsonic-response"]


@pytest.mark.asyncio
async def test_endpoint_returns_a_playable_track_and_caches_it(compat_env, yt):
    params = [("title", "Shape of You"), ("artist", "Ed Sheeran"), ("duration", "233")]
    song = _get(compat_env, params)["karaoke"]["song"]
    assert song["id"] == "yt-kara0000001"
    assert song["title"] == "Shape of You"
    assert song["album"] == "Karaoke"
    assert song["duration"] == 236

    _get(compat_env, params)
    assert len(yt.queries) == 1  # second call served from the cache


@pytest.mark.asyncio
async def test_endpoint_reports_none_found(compat_env, yt):
    yt.results = [_v("orig0000001", "Ed Sheeran - Shape of You (Official Music Video)")]
    body = _get(compat_env, [("title", "Shape of You"), ("artist", "Ed Sheeran")])
    assert body["status"] == "ok"
    assert "song" not in body.get("karaoke", {})
