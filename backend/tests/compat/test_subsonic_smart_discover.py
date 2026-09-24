"""getSimilarSongs2 as Smart Discover: repeated ids blend into one YouTube Music radio mix.

The Hify web client sends up to five queue tracks as repeated `id` params, mirroring the
native POST /api/v1/discover/queue/smart-discover route. YouTube Music is faked here so
the tests never reach the network.
"""

import json
from types import SimpleNamespace

import pytest

from core import dependencies as deps

pytestmark = pytest.mark.asyncio


class FakeYTMusic:
    def __init__(self):
        self.searches: list[tuple[str, str]] = []
        self.mix_calls: list[list[str]] = []

    async def search(self, artist, title, **_):
        self.searches.append((artist, title))
        return SimpleNamespace(video_id=f"vid{len(self.searches)}")

    async def get_smart_discover(self, video_ids, limit=15):
        self.mix_calls.append(list(video_ids))
        # The mix echoes its seeds first (as YouTube Music does), then suggestions.
        seeds = [{"videoId": v, "title": f"seed {v}", "artists": [{"name": "Seed"}]} for v in video_ids]
        picks = [
            {"videoId": f"new{i}", "title": f"Pick {i}", "artists": [{"name": "Artist"}], "length": "3:05"}
            for i in range(limit)
        ]
        return seeds + picks


@pytest.fixture
def yt(compat_env):
    fake = FakeYTMusic()
    compat_env.app.dependency_overrides[deps.get_ytmusic_stream_service] = lambda: fake
    yield fake
    compat_env.app.dependency_overrides.pop(deps.get_ytmusic_stream_service, None)


def _get(env, endpoint, params):
    q = [("v", "1.16.1"), ("c", "pytest"), ("f", "json"), ("apiKey", env.secret), *params]
    resp = env.client.get(f"/subsonic/rest/{endpoint}", params=q)
    assert resp.status_code == 200
    return json.loads(resp.content)["subsonic-response"]


def _song_ids(env, n):
    songs = _get(env, "search3", [("query", ""), ("songCount", "50")])["searchResult3"]["song"]
    local = [s["id"] for s in songs if s["id"].startswith("tr-")]
    assert len(local) >= n
    return local[:n]


async def test_repeated_ids_blend_into_one_mix(compat_env, yt):
    ids = _song_ids(compat_env, 2)
    body = _get(compat_env, "getSimilarSongs2", [("id", ids[0]), ("id", ids[1]), ("count", "15")])

    assert body["status"] == "ok"
    assert len(yt.searches) == 2  # each local seed resolved to a video
    assert yt.mix_calls == [["vid1", "vid2"]]  # one blended radio, not one per seed
    songs = body["similarSongs2"]["song"]
    assert len(songs) == 15
    assert all(s["id"].startswith("yt-new") for s in songs)  # seeds themselves excluded


async def test_ytmusic_seed_uses_video_id_without_search(compat_env, yt):
    body = _get(compat_env, "getSimilarSongs2", [("id", "yt-abc123"), ("count", "5")])

    assert body["status"] == "ok"
    assert yt.searches == []
    assert yt.mix_calls == [["abc123"]]
    assert "yt-abc123" not in {s["id"] for s in body["similarSongs2"]["song"]}


async def test_seeds_are_capped_at_five(compat_env, yt):
    params = [("id", f"yt-v{i}") for i in range(8)] + [("count", "3")]
    _get(compat_env, "getSimilarSongs2", params)

    assert yt.mix_calls == [[f"v{i}" for i in range(5)]]


async def test_single_id_still_works(compat_env, yt):
    (song_id,) = _song_ids(compat_env, 1)
    body = _get(compat_env, "getSimilarSongs", [("id", song_id), ("count", "4")])

    assert len(body["similarSongs"]["song"]) == 4
    assert yt.mix_calls == [["vid1"]]


async def test_unknown_ids_are_rejected(compat_env, yt):
    body = _get(compat_env, "getSimilarSongs2", [("id", "zz-nope"), ("id", "tr-00000000000000000000000000000000")])

    assert body["status"] == "failed"
    assert body["error"]["code"] == 70
    assert yt.mix_calls == []


async def test_artist_title_pairs_seed_one_mix(compat_env, yt):
    params = [
        ("artist", "Radiohead"), ("title", "Airbag"),
        ("artist", "Daft Punk"), ("title", "One More Time"),
        ("count", "15"),
    ]
    body = _get(compat_env, "getSimilarSongs2", params)

    assert body["status"] == "ok"
    assert yt.searches == [("Radiohead", "Airbag"), ("Daft Punk", "One More Time")]
    assert yt.mix_calls == [["vid1", "vid2"]]
    assert len(body["similarSongs2"]["song"]) == 15


async def test_pairs_are_deduped_and_capped(compat_env, yt):
    params = [("artist", "A"), ("title", "Same")] * 2
    params += [p for i in range(8) for p in (("artist", f"A{i}"), ("title", f"T{i}"))]
    _get(compat_env, "getSimilarSongs2", params)

    assert len(yt.searches) == 5
    assert yt.searches[0] == ("A", "Same") and ("A", "Same") not in yt.searches[1:]


async def test_unpaired_artist_title_is_rejected(compat_env, yt):
    body = _get(compat_env, "getSimilarSongs2", [("artist", "A"), ("artist", "B"), ("title", "T")])

    assert body["error"]["code"] == 10
    assert yt.mix_calls == []
