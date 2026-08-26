"""Filename/folder parsing fallback (Lidarr-style) for poorly-tagged files."""

from pathlib import Path

import pytest

from services.native.filename_parser import fallback_track_title, parse_names_from_path


@pytest.mark.parametrize(
    "path,artist,album,title,track,year",
    [
        (
            "/music/Trapeze/Trapeze - Hot Wire/Trapeze - Hot Wire - 05 - Turn It On.mp3",
            "Trapeze",
            "Hot Wire",
            "Turn It On",
            5,
            None,
        ),
        (
            "/music/Blaze Foley/(2010) Sittin' by the Road/04. Blaze Foley - Slow Boat to China.mp3",
            "Blaze Foley",
            "Sittin' by the Road",
            "Slow Boat to China",
            4,
            2010,
        ),
        (
            "/music/MARINA/Electra Heart (2012)/MARINA - Electra Heart - 07 - Power & Control.flac",
            "MARINA",
            "Electra Heart",
            "Power & Control",
            7,
            2012,
        ),
    ],
)
def test_parses_common_layouts(path, artist, album, title, track, year):
    r = parse_names_from_path(Path(path))
    assert r.artist == artist
    assert r.album == album
    assert r.title == title
    assert r.track_number == track
    assert r.year == year


def test_handles_file_with_no_parent_folders():
    r = parse_names_from_path(Path("/lonely.mp3"))
    assert r.title == "lonely"
    assert r.artist is None and r.album is None


def test_strips_artist_prefix_from_album_folder():
    r = parse_names_from_path(Path("/m/Trapeze/Trapeze - Hot Wire/02 - Take It On.mp3"))
    assert r.album == "Hot Wire"
    assert r.title == "Take It On"
    assert r.track_number == 2


def test_fallback_title_strips_default_disc_track_prefix_when_tags_agree():
    assert (
        fallback_track_title(
            Path("/music/Indila/Mini World/0103 Love Story.flac"),
            disc_number=1,
            track_number=3,
        )
        == "Love Story"
    )


@pytest.mark.parametrize(
    "filename,disc,track",
    [
        ("0103 Love Story.flac", 1, 4),
        ("1999.flac", 1, 9),
        ("1000 Oceans.flac", 1, 10),
        ("0103Love Story.flac", 1, 3),
    ],
)
def test_fallback_title_keeps_numeric_title_when_prefix_is_not_an_exact_tagged_position(
    filename, disc, track
):
    assert fallback_track_title(
        Path(filename), disc_number=disc, track_number=track
    ) == Path(filename).stem
