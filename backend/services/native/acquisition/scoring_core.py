"""Pure token-matching core for acquisition scoring.

Stateless string helpers shared by the Soulseek album preflight scorer, the
per-track matcher, and plugin scoring (``PluginScoringHelper``). No engine
state, no stores, no models: every function takes plain ``str``/``float``
inputs so third-party plugins can score indexer/download candidates with the
exact same calibration as the native scorers.

Ownership: the low-level title discriminator (containment, artist evidence)
stays canonical in ``services.native.title_match``; this module owns the
normalisation + per-file confidence formula historically duplicated between
``album_preflight_scorer._file_confidence`` and ``track_matcher``.
"""

import re
import unicodedata

from rapidfuzz import fuzz
from unidecode import unidecode

from services.native.title_match import title_containment_score

_EDITION_SUFFIXES = re.compile(
    r"\b(deluxe|remastered|remaster|edition|anniversary|special|expanded|"
    r"complete|bonus|acoustic|live|demo|radio edit|extended|instrumental)\b",
    re.IGNORECASE,
)
_VERSION_MARKERS = re.compile(
    r"\b(remix|live|acoustic|instrumental|demo|radio edit|karaoke|cover|commentary)\b",
    re.IGNORECASE,
)
_CJK_RANGES = (
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0x3040, 0x309F),  # Hiragana
    (0x30A0, 0x30FF),  # Katakana
    (0x3400, 0x4DBF),  # CJK Extension A
)


def has_cjk(text: str) -> bool:
    for char in text or "":
        codepoint = ord(char)
        for low, high in _CJK_RANGES:
            if low <= codepoint <= high:
                return True
    return False


def normalize_for_match(text: str) -> str:
    """NFC + lowercase + unidecode, but never mangle CJK."""
    text = unicodedata.normalize("NFC", text or "").lower()
    if has_cjk(text):
        return text
    return unidecode(text)


def strip_edition_suffix(title: str) -> str:
    return _EDITION_SUFFIXES.sub("", title or "").strip()


def version_markers(text: str) -> frozenset[str]:
    return frozenset(marker.lower() for marker in _VERSION_MARKERS.findall(text or ""))


def artist_from_path(parent_directory: str, target_artist: str = "") -> str:
    """Heuristic artist extraction: try "Artist - Album", then a "Artist/Album"
    layout (first path component), then the target artist, else ""."""
    if not parent_directory:
        return ""
    if " - " in parent_directory:
        return parent_directory.split(" - ", 1)[0].strip()
    parts = [p for p in re.split(r"[\\/]", parent_directory) if p]
    if len(parts) >= 2:
        return parts[0].strip()
    if target_artist:
        return target_artist
    return parts[0].strip() if parts else ""


def file_confidence(
    target_title: str,
    target_artist: str,
    target_duration: float | None,
    filename: str,
    parent_directory: str,
    file_duration: float | None,
    *,
    strict_title: bool = False,
) -> float:
    """Per-file confidence, pure-string form of the shared scorer formula.

    ``(0.55*title + 0.20*artist + 0.25*duration) * version_penalty`` when a target
    duration and a file duration are both available, else the duration term drops
    and weights redistribute to ``0.65*title + 0.35*artist``.

    ``strict_title`` (the track matcher + 1-track album fallbacks, P3.4): the title
    term becomes CONTAINMENT-based - a filename must name the target and nothing
    else. ``token_set_ratio`` ignored extra tokens, so "the arrival" scored 0.78
    against "02. Arrival in Ashford" and 1.0 against "Arrival - The Waking Hour" -
    both real auto-tier candidates in the 2026-07-05 incident's search job. The
    artist's own words are excluded from the foreign-token penalty ("01 - Yan Qing -
    the arrival.flac" is not naming another work). Deliberately OFF for multi-track
    albums: their per-file names are TRACK titles, and comparing those to the ALBUM
    title is uniform noise under any metric - the replay corpus showed containment's
    lower noise floor demoting legitimate albums (Inferno, 0.801 -> 0.698), so the
    calibrated token_set noise stays. CJK titles always keep token_set (containment
    tokenisation needs word boundaries)."""
    file_title = re.split(r"[\\/]", filename or "")[-1]
    file_title = re.sub(r"\.\w+$", "", file_title)

    if strict_title and not (has_cjk(target_title or "") or has_cjk(file_title)):
        artist_words = frozenset(
            t for t in normalize_for_match(target_artist).split() if len(t) >= 2
        )
        title_score = title_containment_score(
            strip_edition_suffix(target_title or ""), file_title, ignore=artist_words
        )
    else:
        title_score = (
            fuzz.token_set_ratio(
                normalize_for_match(strip_edition_suffix(target_title or "")),
                normalize_for_match(strip_edition_suffix(file_title)),
            )
            / 100.0
        )

    file_artist = artist_from_path(parent_directory or "", target_artist or "")
    artist_score = (
        fuzz.token_set_ratio(
            normalize_for_match(target_artist or ""),
            normalize_for_match(file_artist),
        )
        / 100.0
    )

    # penalise when exactly one side carries a version marker
    version_penalty = (
        0.3 if version_markers(target_title or "") != version_markers(file_title) else 1.0
    )

    if target_duration and file_duration:
        diff = abs(file_duration - target_duration)
        duration_score = 1.0 if diff <= 15 else (0.5 if diff <= 25 else 0.0)
        base = 0.55 * title_score + 0.20 * artist_score + 0.25 * duration_score
    else:
        base = 0.65 * title_score + 0.35 * artist_score

    return base * version_penalty


def album_match(artist: str, album: str, candidate_title: str) -> float:
    """Score a plugin indexer/download candidate title against a wanted album.

    Parity form of the album preflight path: non-strict (``token_set``) title
    term, no duration, artist drawn from the candidate title itself via the same
    ``"Artist - Album"`` heuristic the folder scorer uses.
    """
    return file_confidence(
        album or "",
        artist or "",
        None,
        candidate_title or "",
        candidate_title or "",
        None,
        strict_title=False,
    )


def track_match(artist: str, track: str, filename: str) -> float:
    """Score a plugin file path against a wanted track.

    Parity form of the track matcher path: strict (containment) title term, no
    duration, artist drawn from the filename's directory part so a bare
    ``"Artist - Track"`` name still carries its artist.
    """
    parts = [p for p in re.split(r"[\\/]", filename or "") if p]
    if len(parts) >= 2:
        parent = "/".join(parts[:-1])
    else:
        parent = filename or ""
    return file_confidence(
        track or "",
        artist or "",
        None,
        filename or "",
        parent,
        None,
        strict_title=True,
    )
