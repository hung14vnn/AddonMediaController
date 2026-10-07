"""Find a karaoke (instrumental) version of a song among YouTube search results.

The player's karaoke mode plays an uploaded karaoke video's audio in place of the
song. A wrong pick (the original with vocals, another song, a cut-down version)
is worse than none, so a candidate must say it is karaoke, name the song, and
be about as long as it.
"""

from __future__ import annotations

import re
import unicodedata

KARAOKE_WORDS = re.compile(
    r"karaoke|instrumental|off[\s-]*vocal|backing\s+track|minus\s+one|"
    r"\bbeat\b|nh[aạ]c\s+n[eề]n|\bktv\b|\bmr\b",
    re.IGNORECASE,
)
# Explicitly karaoke ranks above the looser "beat"/"instrumental".
_STRONG = re.compile(r"karaoke|ktv", re.IGNORECASE)
# Versions that aren't the song as recorded.
_OTHER_VERSION = re.compile(r"\b(remix|live|nightcore|speed\s*up|sped\s*up|slowed|8d|lofi|lo-fi)\b", re.IGNORECASE)
# "(feat. X)", "[Official Audio]", " - From the film …": not part of the name people type.
_DECORATION = re.compile(r"[\(\[].*?[\)\]]|\s[-–—]\s.*$|\bfeat\.?.*$|\bft\.?.*$", re.IGNORECASE)
# Longer or shorter than this, it's an edit, a medley or a different song.
MAX_DURATION_DIFF_S = 60


def loose(value: str | None) -> str:
    """Case-, accent- and punctuation-blind form for matching names."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    return "".join(ch for ch in decomposed.casefold() if ch.isalnum())


def core_title(title: str) -> str:
    return _DECORATION.sub("", title).strip() or title


def primary_artist(artist: str) -> str:
    return re.split(r",|&|\bfeat\.?|\bft\.?|\bx\b", artist, maxsplit=1, flags=re.IGNORECASE)[0].strip()


def search_query(title: str, artist: str) -> str:
    return f"{core_title(title)} {primary_artist(artist)} karaoke".strip()


def pick_karaoke(title: str, artist: str, duration: float | None, candidates: list[dict]) -> dict | None:
    """The best karaoke video among *candidates* (``id``, ``title``, ``duration``,
    ``channel``, in search order), or None."""
    want = loose(core_title(title))
    who = loose(primary_artist(artist))
    if not want:
        return None
    best: tuple[float, dict] | None = None
    for rank, cand in enumerate(candidates):
        name = str(cand.get("title") or "")
        # The marker must come from outside the song's own name ("Beat It").
        rest = re.sub(re.escape(core_title(title)), " ", name, flags=re.IGNORECASE)
        if not KARAOKE_WORDS.search(rest) or _OTHER_VERSION.search(rest):
            continue
        if want not in loose(name):
            continue
        score = 2.0 if _STRONG.search(rest) else 1.0
        if who and (who in loose(name) or who in loose(str(cand.get("channel") or ""))):
            score += 1.5
        length = cand.get("duration")
        if duration and isinstance(length, (int, float)) and length > 0:
            diff = abs(length - duration)
            if diff > MAX_DURATION_DIFF_S:
                continue
            score -= diff / 30
        # Search order is a decent tie-breaker (views, relevance).
        score -= rank * 0.1
        if best is None or score > best[0]:
            best = (score, cand)
    return best[1] if best else None
