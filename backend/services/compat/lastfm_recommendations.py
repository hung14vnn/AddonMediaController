"""Personal recommendations from a user's Last.fm history, Apple Music style.

Last.fm retired its own recommendation endpoint, so picks are derived the way
its site does: artists similar to what the user plays (``artist.getSimilar``)
and tracks similar to what they played recently (``track.getSimilar``). Every
pick keeps the seed it came from, so the client can say *why* it is shown.

Seeds rotate daily (seeded by user and date) so Home changes from day to day
but stays stable within one. This module only names things; resolving names
to playable catalog items is the caller's job.
"""

from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from repositories.lastfm_models import LastFmSimilarArtist, LastFmTrack
    from repositories.lastfm_repository import LastFmRepository

logger = logging.getLogger(__name__)

ShelfKind = Literal["artist", "album", "song"]

_ARTIST_SEEDS = 10
_TRACK_SEEDS = 4
_ARTISTS_PER_SHELF = 15
_ALBUM_SHELVES = 2
_ALBUMS_PER_SHELF = 12
_ALBUM_ARTISTS_PER_SEED = 8
_TAG_ALBUMS_PER_SEED = 5
# Last.fm tags that say nothing about the music.
_NOISE_TAGS = {"seen live", "favorites", "favourite", "favorite", "albums i own"}
_SONGS_PER_SHELF = 20


@dataclass(frozen=True)
class Pick:
    """One recommended item. For an artist pick ``name`` is the artist."""

    name: str
    artist: str
    reason: str


@dataclass
class Shelf:
    key: str
    kind: ShelfKind
    title: str
    subtitle: str
    picks: list[Pick] = field(default_factory=list)


def _norm(name: str) -> str:
    return " ".join(name.casefold().split())


def _similar_to(seeds: list[str]) -> str:
    """Last.fm's own wording: "Similar to A", "Similar to A and B"."""
    return "Similar to " + " and ".join(seeds[:2])


def _round_robin(lists: list[list[Pick]], limit: int, seen: set[str]) -> list[Pick]:
    """Interleave per-seed lists so no single seed dominates a shelf."""
    out: list[Pick] = []
    i = 0
    while len(out) < limit and any(i < len(lst) for lst in lists):
        for lst in lists:
            if i < len(lst) and len(out) < limit:
                key = _norm(f"{lst[i].artist}\0{lst[i].name}")
                if key not in seen:
                    seen.add(key)
                    out.append(lst[i])
        i += 1
    return out


async def _safe(coro, default):
    try:
        return await coro
    except Exception as e:  # noqa: BLE001 - one failed seed must not empty Home
        logger.debug("Last.fm recommendation call failed: %s", e)
        return default


async def build_recommendations(
    lastfm: "LastFmRepository", username: str, *, day: date | None = None
) -> list[Shelf]:
    rng = random.Random(f"{username}:{(day or date.today()).isoformat()}")

    recent_top, long_top, recent_tracks, loved, played_albums = await asyncio.gather(
        _safe(lastfm.get_user_top_artists(username, period="1month", limit=30), []),
        _safe(lastfm.get_user_top_artists(username, period="6month", limit=100), []),
        _safe(lastfm.get_user_recent_tracks(username, limit=50), []),
        _safe(lastfm.get_user_loved_tracks(username, limit=30), []),
        _safe(lastfm.get_user_top_albums(username, period="6month", limit=100), []),
    )
    known_artists = {_norm(a.name) for a in (*recent_top, *long_top) if a.name}

    shelves: list[Shelf] = []

    # ---- artists similar to the ones in heavy rotation ---------------------
    # Like Last.fm's own recommendations: similar artists of every top artist
    # are pooled, so one liked by several of them ranks first, and its reason
    # names the seeds that contributed most. A seed counts by its play count;
    # a small daily jitter keeps the order from being the same every day.
    seeds = (recent_top or long_top)[:_ARTIST_SEEDS]
    similar_lists: list[list["LastFmSimilarArtist"]] = await asyncio.gather(
        *(_safe(lastfm.get_similar_artists(s.name, s.mbid, limit=30), []) for s in seeds)
    )
    top_plays = max((s.playcount for s in seeds), default=0) or 1
    scores: dict[str, float] = {}
    sources: dict[str, dict[str, float]] = {}
    found: dict[str, "LastFmSimilarArtist"] = {}
    for rank, (seed, similar) in enumerate(zip(seeds, similar_lists)):
        # rank fallback when Last.fm sends no play counts
        weight = seed.playcount / top_plays if seed.playcount else 1 / (rank + 1)
        for a in similar:
            key = _norm(a.name)
            if not a.name or key in known_artists:
                continue
            gain = (a.match or 0.1) * weight
            scores[key] = scores.get(key, 0.0) + gain
            sources.setdefault(key, {})[seed.name] = gain
            found.setdefault(key, a)
    ranked = sorted(scores, key=lambda k: scores[k] * rng.uniform(0.75, 1.25), reverse=True)

    def reason(key: str) -> str:
        by = sources[key]
        return _similar_to(sorted(by, key=by.__getitem__, reverse=True))

    artist_picks = [
        Pick(found[k].name, found[k].name, reason(k)) for k in ranked[:_ARTISTS_PER_SHELF]
    ]
    if artist_picks:
        shelves.append(
            Shelf(
                key="artists",
                kind="artist",
                title="Artists You Might Like",
                subtitle="Based on your Last.fm listening",
                picks=artist_picks,
            )
        )

    # ---- "Because You Listened to <seed>" -------------------------------
    # Two seeds, drawn by play count so heavy rotation comes up more often.
    # Each shelf mixes two sources so it isn't only every similar artist's
    # biggest hit: a random pick among each similar artist's top albums, and
    # popular albums from the seed's own genre tags. Albums the user already
    # plays are left out.
    played = {_norm(f"{a.artist_name}\0{a.name}") for a in played_albums if a.name}
    used: set[str] = set()

    def fresh_album(album) -> bool:
        key = _norm(f"{album.artist_name}\0{album.name}")
        return bool(album.name) and album.name != "(null)" and key not in played | used

    album_seeds: list[int] = []
    weights = [max(s.playcount, 1) for s in seeds]
    while len(album_seeds) < min(_ALBUM_SHELVES, len(seeds)):
        i = rng.choices(range(len(seeds)), weights=weights)[0]
        if i not in album_seeds:
            album_seeds.append(i)

    for i in album_seeds:
        seed = seeds[i]
        similar = [
            a for a in similar_lists[i] if a.name and _norm(a.name) not in known_artists
        ][:_ALBUM_ARTISTS_PER_SEED]
        tops, info = await asyncio.gather(
            asyncio.gather(
                *(_safe(lastfm.get_artist_top_albums(a.name, a.mbid, limit=5), []) for a in similar)
            ),
            _safe(lastfm.get_artist_info(seed.name, seed.mbid), None),
        )
        tags = [
            t.name
            for t in (info.tags or [] if info else [])
            if t.name and t.name.casefold() not in _NOISE_TAGS
        ][:2]
        tag_lists = await asyncio.gather(
            *(_safe(lastfm.get_tag_top_albums(t, limit=50), []) for t in tags)
        )

        by_similar: list[Pick] = []
        for albums in tops:
            choices = [al for al in albums if fresh_album(al)][:3]
            if choices:
                al = rng.choice(choices)
                used.add(_norm(f"{al.artist_name}\0{al.name}"))
                by_similar.append(Pick(al.name, al.artist_name, f"Similar to {seed.name}"))
        by_tag: list[Pick] = []
        for tag, albums in zip(tags, tag_lists):
            pool = [
                al
                for al in albums
                if fresh_album(al) and _norm(al.artist_name) not in known_artists
            ]
            for al in rng.sample(pool, min(_TAG_ALBUMS_PER_SEED, len(pool))):
                used.add(_norm(f"{al.artist_name}\0{al.name}"))
                by_tag.append(Pick(al.name, al.artist_name, f"Popular in {tag}"))

        picks = _round_robin([by_similar, by_tag], _ALBUMS_PER_SHELF, set())
        if picks:
            shelves.append(
                Shelf(
                    key=f"because:{_norm(seed.name)}",
                    kind="album",
                    title=f"Because You Listened to {seed.name}",
                    subtitle="Albums from artists like them",
                    picks=picks,
                )
            )

    # ---- songs similar to recent plays and loved tracks -------------------
    seen_tracks: set[tuple[str, str]] = set()
    track_seeds: list[tuple[str, str]] = []
    for artist, track in [
        *((t.artist_name, t.track_name) for t in recent_tracks),
        *((t.artist_name, t.track_name) for t in loved),
    ]:
        key = (_norm(artist), _norm(track))
        if artist and track and key not in seen_tracks:
            seen_tracks.add(key)
            track_seeds.append((artist, track))
    # Prefer recent plays but let a loved track in now and then.
    head, tail = track_seeds[:12], track_seeds[12:]
    chosen = rng.sample(head, min(_TRACK_SEEDS - 1, len(head)))
    if tail:
        chosen.append(rng.choice(tail))

    similar_tracks: list[list["LastFmTrack"]] = await asyncio.gather(
        *(_safe(lastfm.get_similar_tracks(a, t, limit=15), []) for a, t in chosen)
    )
    song_lists = [
        [
            Pick(s.name, s.artist_name, f"Because you played {seed_track}")
            for s in similar
            if s.name
            and s.artist_name
            and (_norm(s.artist_name), _norm(s.name)) not in seen_tracks
        ]
        for (_seed_artist, seed_track), similar in zip(chosen, similar_tracks)
    ]
    song_picks = _round_robin(song_lists, _SONGS_PER_SHELF, set())
    if song_picks:
        shelves.insert(
            0,
            Shelf(
                key="songs",
                kind="song",
                title="Songs You Might Like",
                subtitle="Based on what you played recently",
                picks=song_picks,
            ),
        )

    return shelves


_MIX_SIZE = 25
_MIX_FAVORITES = 8
_MIX_SEEDS = 6


def mix_week(day: date | None = None) -> str:
    """ISO week the mix belongs to; a new mix starts every Monday."""
    year, week, _ = (day or date.today()).isocalendar()
    return f"{year}-W{week:02d}"


async def build_weekly_mix(
    lastfm: "LastFmRepository", username: str, *, day: date | None = None
) -> list[Shelf]:
    """"Your Weekly Mix": songs on repeat lately mixed with songs similar to
    them, about two new ones for each familiar one. Seeded by ISO week, so it
    holds for the week and changes on Monday."""
    rng = random.Random(f"{username}:mix:{mix_week(day)}")
    top, recent = await asyncio.gather(
        _safe(lastfm.get_user_top_tracks(username, period="1month", limit=50), []),
        _safe(lastfm.get_user_recent_tracks(username, limit=50), []),
    )
    top = [t for t in top if t.name and t.artist_name]
    if not top:
        return []
    heard = {_norm(f"{t.artist_name}\0{t.name}") for t in top} | {
        _norm(f"{t.artist_name}\0{t.track_name}") for t in recent
    }

    seeds = rng.sample(top[:20], min(_MIX_SEEDS, len(top[:20])))
    similar = await asyncio.gather(
        *(_safe(lastfm.get_similar_tracks(t.artist_name, t.name, limit=20), []) for t in seeds)
    )
    new_lists = [
        [
            Pick(s.name, s.artist_name, f"Because you played {seed.name}")
            for s in rng.sample(found, len(found))
            if s.name and s.artist_name and _norm(f"{s.artist_name}\0{s.name}") not in heard
        ]
        for seed, found in zip(seeds, similar)
    ]
    seen: set[str] = set()
    discoveries = _round_robin(new_lists, _MIX_SIZE - _MIX_FAVORITES, seen)
    favorites = [
        Pick(t.name, t.artist_name, "On repeat lately")
        for t in rng.sample(top[:30], min(_MIX_FAVORITES, len(top[:30])))
    ]

    # Two new songs, then a familiar one.
    picks: list[Pick] = []
    while discoveries or favorites:
        picks.extend(discoveries[:2])
        del discoveries[:2]
        if favorites:
            picks.append(favorites.pop(0))
    return [
        Shelf(
            key="weekly:mix",
            kind="song",
            title="Your Weekly Mix",
            subtitle="Updated every Monday",
            picks=picks[:_MIX_SIZE],
        )
    ]
