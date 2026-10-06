"""Last.fm recommendations for the player: shelf building and catalog matching."""

from datetime import date

import pytest

from api.compat.subsonic.router import _pick_ytmusic_match
from repositories.lastfm_models import (
    LastFmAlbum,
    LastFmArtist,
    LastFmLovedTrack,
    LastFmRecentTrack,
    LastFmSimilarArtist,
    LastFmTrack,
)
from services.compat.lastfm_recommendations import build_recommendations

pytestmark = pytest.mark.asyncio


class FakeLastFm:
    def __init__(self, fail_similar_for: str | None = None):
        self.fail_similar_for = fail_similar_for

    async def get_user_top_artists(self, username, period="overall", limit=50):
        return [LastFmArtist(name="Radiohead"), LastFmArtist(name="Portishead")]

    async def get_user_recent_tracks(self, username, limit=50):
        return [
            LastFmRecentTrack(track_name="Reckoner", artist_name="Radiohead"),
            LastFmRecentTrack(track_name="Reckoner", artist_name="Radiohead"),
            LastFmRecentTrack(track_name="Roads", artist_name="Portishead"),
        ]

    async def get_user_loved_tracks(self, username, limit=50):
        return [LastFmLovedTrack(track_name="Teardrop", artist_name="Massive Attack")]

    async def get_similar_artists(self, artist, mbid=None, limit=30):
        if artist == self.fail_similar_for:
            raise RuntimeError("Last.fm down")
        return [
            # already a top artist: never recommended back
            LastFmSimilarArtist(name="Portishead" if artist == "Radiohead" else "Radiohead"),
            LastFmSimilarArtist(name=f"{artist} Fan A"),
            LastFmSimilarArtist(name=f"{artist} Fan B"),
        ]

    async def get_artist_top_albums(self, artist, mbid=None, limit=10):
        return [LastFmAlbum(name=f"{artist} LP", artist_name=artist)]

    async def get_similar_tracks(self, artist, track, limit=20):
        return [
            LastFmTrack(name="Reckoner", artist_name="Radiohead"),  # already played
            LastFmTrack(name=f"Like {track}", artist_name="Someone"),
        ]


async def test_shelves_carry_reasons_and_skip_known_artists():
    shelves = await build_recommendations(FakeLastFm(), "alice", day=date(2026, 10, 6))
    by_key = {s.key: s for s in shelves}

    artists = by_key["artists"]
    names = {p.name for p in artists.picks}
    assert names.isdisjoint({"Radiohead", "Portishead"})
    assert all(p.reason.startswith("Similar to ") for p in artists.picks)

    because = [s for s in shelves if s.kind == "album"]
    assert because and because[0].title.startswith("Because You Listened to ")
    assert all(p.name.endswith(" LP") for p in because[0].picks)

    songs = by_key["songs"]
    assert shelves[0] is songs
    assert ("Reckoner", "Radiohead") not in {(p.name, p.artist) for p in songs.picks}
    assert all(p.reason.startswith("Because you played ") for p in songs.picks)


async def test_seed_rotation_is_stable_within_a_day():
    a = await build_recommendations(FakeLastFm(), "alice", day=date(2026, 10, 6))
    b = await build_recommendations(FakeLastFm(), "alice", day=date(2026, 10, 6))
    assert [s.picks for s in a] == [s.picks for s in b]


async def test_one_failing_seed_does_not_empty_home():
    shelves = await build_recommendations(
        FakeLastFm(fail_similar_for="Radiohead"), "alice", day=date(2026, 10, 6)
    )
    assert any(s.kind == "artist" and s.picks for s in shelves)


def test_match_requires_same_artist_for_songs():
    results = [
        {"videoId": "x", "title": "Teardrop", "artists": [{"name": "Cover Band"}]},
        {"videoId": "y", "title": "Teardrop (Remastered)", "artists": [{"name": "Massive Attack"}]},
    ]
    assert _pick_ytmusic_match("song", "Teardrop", "Massive Attack", results)["videoId"] == "y"
    assert _pick_ytmusic_match("song", "Teardrop", "Nobody", results) is None


def test_match_artist_by_exact_name_ignoring_accents():
    results = [
        {"browseId": "a", "artist": "Sigur Ros Tribute"},
        {"browseId": "b", "artist": "Sigur Rós"},
    ]
    assert _pick_ytmusic_match("artist", "Sigur Ros", "Sigur Ros", results)["browseId"] == "b"



class _FakePrefs:
    def __init__(self):
        self.scrobble_to_lastfm = False

    async def get(self, user_id):
        return self

    async def upsert(self, user_id, *, scrobble_to_lastfm=None, **_):
        if scrobble_to_lastfm is not None:
            self.scrobble_to_lastfm = scrobble_to_lastfm


class _FakeFactory:
    async def is_lastfm_linked(self, user_id):
        return False

    async def resolve_lastfm(self, user_id):
        return None

    async def resolve_lastfm_username(self, user_id):
        return None


@pytest.fixture
def lastfm_env(compat_env):
    from core.dependencies import (
        get_per_user_client_factory,
        get_user_listening_prefs_store,
    )

    prefs, factory = _FakePrefs(), _FakeFactory()
    compat_env.app.dependency_overrides[get_user_listening_prefs_store] = lambda: prefs
    compat_env.app.dependency_overrides[get_per_user_client_factory] = lambda: factory
    return compat_env


def _sub(env, endpoint, **extra):
    import json

    q = {"v": "1.16.1", "c": "pytest", "f": "json", "apiKey": env.secret, **extra}
    resp = env.client.get(f"/subsonic/rest/{endpoint}", params=q)
    assert resp.status_code == 200
    return json.loads(resp.content)["subsonic-response"]


async def test_status_and_recommendations_when_not_linked(lastfm_env):
    status = _sub(lastfm_env, "getLastfmStatus")["lastfm"]
    assert status["linked"] is False
    assert status["available"] is False
    assert status["scrobbling"] is False
    recs = _sub(lastfm_env, "getLastfmRecommendations")["lastfmRecommendations"]
    assert recs["linked"] is False
    assert recs.get("shelf", []) == []


async def test_set_lastfm_scrobbling_toggles_preference(lastfm_env):
    assert _sub(lastfm_env, "setLastfmScrobbling", enabled="true")["lastfm"]["scrobbling"] is True
    assert _sub(lastfm_env, "setLastfmScrobbling", enabled="false")["lastfm"]["scrobbling"] is False


async def test_weekly_charts_list_play_counts():
    from services.compat.lastfm_recommendations import build_weekly_charts

    class Weekly:
        async def get_user_weekly_track_chart(self, username):
            return [LastFmTrack(name="Reckoner", artist_name="Radiohead", playcount=12)]

        async def get_user_weekly_album_chart(self, username):
            return [LastFmAlbum(name="In Rainbows", artist_name="Radiohead", playcount=1)]

        async def get_user_weekly_artist_chart(self, username):
            raise RuntimeError("Last.fm down")

    shelves = {s.key: s for s in await build_weekly_charts(Weekly(), "alice")}
    assert shelves["weekly:songs"].picks[0].reason == "12 plays this week"
    assert shelves["weekly:albums"].picks[0].reason == "1 play this week"
    assert "weekly:artists" not in shelves


async def test_recommended_songs_prefer_the_library_copy(lastfm_env, monkeypatch):
    from api.compat.subsonic import router as subsonic_router
    from services.compat import lastfm_recommendations as recs

    owned = _sub(lastfm_env, "search3", query="")["searchResult3"]["song"]
    picks = [recs.Pick(s["title"], s["artist"], "Because you played X") for s in owned[:2]]
    picks.append(recs.Pick("Not Owned", "Radiohead", "Because you played X"))

    async def linked(*_a):
        return object()

    async def username(*_a):
        return "alice"

    factory = lastfm_env.app.dependency_overrides
    from core.dependencies import get_per_user_client_factory

    fake = factory[get_per_user_client_factory]()
    monkeypatch.setattr(fake, "resolve_lastfm", linked, raising=False)
    monkeypatch.setattr(fake, "resolve_lastfm_username", username, raising=False)

    async def build(*_a, **_k):
        return [recs.Shelf("songs", "song", "Songs", "", picks)]

    async def weekly(*_a, **_k):
        return []

    monkeypatch.setattr(recs, "build_recommendations", build)
    monkeypatch.setattr(recs, "build_weekly_charts", weekly)

    async def resolve(c, kind, name, artist, gate):
        # YouTube Music credits a guest too: "Artist, Guest"
        return {
            "videoId": f"v-{name}",
            "title": name,
            "artists": [{"name": artist}, {"name": "Guest"}],
        }

    monkeypatch.setattr(subsonic_router, "_resolve_on_ytmusic", resolve)
    subsonic_router._LASTFM_RECS.clear()

    body = _sub(lastfm_env, "getLastfmRecommendations")["lastfmRecommendations"]
    songs = body["shelf"][0]["song"]
    assert [s["id"] for s in songs] == [owned[0]["id"], owned[1]["id"], "yt-v-Not Owned"]
    # unmatched songs keep YouTube's full credit
    assert songs[2]["artist"] == "Radiohead, Guest"
    assert all(s["reason"] == "Because you played X" for s in songs)
