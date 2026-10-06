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

_ARTIST_SEEDS = 3
_ALBUM_SHELVES = 2
_TRACK_SEEDS = 4
_ARTISTS_PER_SHELF = 15
_ALBUMS_PER_SHELF = 10
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

    recent_top, long_top, recent_tracks, loved = await asyncio.gather(
        _safe(lastfm.get_user_top_artists(username, period="1month", limit=30), []),
        _safe(lastfm.get_user_top_artists(username, period="6month", limit=100), []),
        _safe(lastfm.get_user_recent_tracks(username, limit=50), []),
        _safe(lastfm.get_user_loved_tracks(username, limit=30), []),
    )
    known_artists = {_norm(a.name) for a in (*recent_top, *long_top) if a.name}

    shelves: list[Shelf] = []

    # ---- artists similar to the ones in heavy rotation ---------------------
    pool = (recent_top or long_top)[:10]
    seeds = rng.sample(pool, min(_ARTIST_SEEDS, len(pool)))
    similar_lists: list[list["LastFmSimilarArtist"]] = await asyncio.gather(
        *(_safe(lastfm.get_similar_artists(s.name, s.mbid, limit=30), []) for s in seeds)
    )
    fresh_by_seed: list[list["LastFmSimilarArtist"]] = [
        [a for a in similar if a.name and _norm(a.name) not in known_artists]
        for similar in similar_lists
    ]

    artist_lists = [
        [Pick(a.name, a.name, f"Similar to {seed.name}") for a in fresh]
        for seed, fresh in zip(seeds, fresh_by_seed)
    ]
    artist_picks = _round_robin(artist_lists, _ARTISTS_PER_SHELF, set())
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

    # ---- "Because You Listened to <seed>": top albums of similar artists ---
    used_albums: set[str] = set()
    for seed, fresh in list(zip(seeds, fresh_by_seed))[:_ALBUM_SHELVES]:
        candidates = fresh[:_ALBUMS_PER_SHELF]
        tops = await asyncio.gather(
            *(_safe(lastfm.get_artist_top_albums(a.name, a.mbid, limit=2), []) for a in candidates)
        )
        picks: list[Pick] = []
        for albums in tops:
            album = next(
                (
                    al
                    for al in albums
                    if al.name and al.name != "(null)" and _norm(al.name) not in used_albums
                ),
                None,
            )
            if album is None:
                continue
            used_albums.add(_norm(album.name))
            picks.append(Pick(album.name, album.artist_name, f"Similar to {seed.name}"))
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


_WEEKLY_PER_SHELF = 15


def _plays(count: int) -> str:
    return f"{count} play{'' if count == 1 else 's'} this week"


async def build_weekly_charts(lastfm: "LastFmRepository", username: str) -> list[Shelf]:
    """The user's Last.fm chart for the latest finished week: top songs, albums
    and artists, each with its play count as the reason."""
    tracks, albums, artists = await asyncio.gather(
        _safe(lastfm.get_user_weekly_track_chart(username), []),
        _safe(lastfm.get_user_weekly_album_chart(username), []),
        _safe(lastfm.get_user_weekly_artist_chart(username), []),
    )
    subtitle = "Your Last.fm weekly chart"
    shelves = [
        Shelf(
            key="weekly:songs",
            kind="song",
            title="Your Top Songs This Week",
            subtitle=subtitle,
            picks=[
                Pick(t.name, t.artist_name, _plays(t.playcount))
                for t in tracks[:_WEEKLY_PER_SHELF]
                if t.name and t.artist_name
            ],
        ),
        Shelf(
            key="weekly:albums",
            kind="album",
            title="Your Top Albums This Week",
            subtitle=subtitle,
            picks=[
                Pick(a.name, a.artist_name, _plays(a.playcount))
                for a in albums[:_WEEKLY_PER_SHELF]
                if a.name and a.artist_name
            ],
        ),
        Shelf(
            key="weekly:artists",
            kind="artist",
            title="Your Top Artists This Week",
            subtitle=subtitle,
            picks=[
                Pick(a.name, a.name, _plays(a.playcount))
                for a in artists[:_WEEKLY_PER_SHELF]
                if a.name
            ],
        ),
    ]
    return [s for s in shelves if s.picks]
