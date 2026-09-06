from services.album_utils import extract_tracks


def test_extract_tracks_preserves_disc_numbers_and_track_positions():
    release_data = {
        "media": [
            {
                "position": "1",
                "tracks": [
                    {
                        "position": "1",
                        "title": "Disc One Intro",
                        "length": 1000,
                        "recording": {"id": "rec-1", "title": "Disc One Intro"},
                    },
                    {
                        "position": "2",
                        "title": "Disc One Main",
                        "recording": {
                            "id": "rec-2",
                            "title": "Disc One Main",
                            "length": 2000,
                        },
                    },
                ],
            },
            {
                "position": "2",
                "tracks": [
                    {
                        "position": "1",
                        "title": "Disc Two Outro",
                        "length": 3000,
                        "recording": {"id": "rec-3", "title": "Disc Two Outro"},
                    }
                ],
            },
        ]
    }

    tracks, total_length = extract_tracks(release_data)

    assert [
        (track.disc_number, track.position, track.title, track.recording_id)
        for track in tracks
    ] == [
        (1, 1, "Disc One Intro", "rec-1"),
        (1, 2, "Disc One Main", "rec-2"),
        (2, 1, "Disc Two Outro", "rec-3"),
    ]
    assert total_length == 6000


def test_extract_tracks_prefers_exact_release_track_title():
    release_data = {
        "media": [
            {
                "position": 1,
                "tracks": [
                    {
                        "position": 14,
                        "title": "The Fisherman Will Be Bewildered",
                        "recording": {
                            "id": "ec935e35-b2fa-4925-aa83-052d9e3e69f1",
                            "title": "The Fishermen Will Be Bewildered",
                        },
                    }
                ],
            }
        ]
    }

    tracks, _total_length = extract_tracks(release_data)

    assert tracks[0].title == "The Fisherman Will Be Bewildered"


from types import SimpleNamespace

from services.album_utils import audio_tracks, is_audio_medium


def test_extract_tracks_stamps_medium_format_per_medium():
    release_data = {
        "media": [
            {
                "position": "1",
                "format": "CD",
                "tracks": [
                    {
                        "position": "1",
                        "title": "Audio Song",
                        "recording": {"id": "rec-1", "title": "Audio Song"},
                    }
                ],
            },
            {
                "position": "2",
                "format": "DVD",
                "tracks": [
                    {
                        "position": "1",
                        "title": "Video Clip",
                        "recording": {"id": "rec-2", "title": "Video Clip"},
                    }
                ],
            },
            {
                "position": "3",
                "tracks": [
                    {
                        "position": "1",
                        "title": "Unknown Carrier",
                        "recording": {"id": "rec-3", "title": "Unknown Carrier"},
                    }
                ],
            },
        ]
    }

    tracks, _total = extract_tracks(release_data)

    assert [track.media_format for track in tracks] == ["CD", "DVD", None]


def test_is_audio_medium_video_carriers_excluded_audio_kept():
    for fmt in ("CD", "DVD-Audio", "SACD", "Vinyl", "Digital Media", "Cassette"):
        assert is_audio_medium(fmt) is True
    for fmt in ("DVD", "DVD-Video", "Blu-ray", "HD-DVD", "VHS", "Video CD", "Laserdisc"):
        assert is_audio_medium(fmt) is False
    assert is_audio_medium("  dvd  ") is False  # case/whitespace tolerant
    # Fail-open: missing or unrecognized formats never strand an acquisition.
    assert is_audio_medium(None) is True
    assert is_audio_medium("") is True
    assert is_audio_medium("Future-Carrier-3000") is True


def test_audio_tracks_filters_video_duck_typed_and_fail_open():
    tracks = [
        SimpleNamespace(title="a", media_format="CD"),
        SimpleNamespace(title="b", media_format="DVD"),
        SimpleNamespace(title="c"),  # legacy shape without the field: kept
        SimpleNamespace(title="d", media_format=None),  # local rows: kept
    ]

    assert [t.title for t in audio_tracks(tracks)] == ["a", "c", "d"]
