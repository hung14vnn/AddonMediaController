import pytest

from services.per_user_client_factory import PerUserClientFactory
from services.spotapi_client import SpotApiClient, _album_item, _track_item


@pytest.mark.asyncio
async def test_catalog_resolver_does_not_require_spotify_credentials():
    client = await PerUserClientFactory(None, None, None, None).resolve_spotify_catalog()

    assert isinstance(client, SpotApiClient)


def test_spotapi_track_is_normalized_to_existing_spotify_shape():
    raw = {
        "uri": "spotify:track:track-1",
        "name": "Track One",
        "trackNumber": 2,
        "discNumber": 1,
        "duration": {"totalMilliseconds": 123000},
        "externalIds": {"items": [{"type": "ISRC", "value": "US-AAA-01"}]},
        "artists": {
            "items": [
                {
                    "uri": "spotify:artist:artist-1",
                    "profile": {"name": "Artist One"},
                }
            ]
        },
        "albumOfTrack": {
            "uri": "spotify:album:album-1",
            "name": "Album One",
            "date": {"isoString": "2024-02-03T00:00:00Z"},
            "coverArt": {"sources": [{"url": "https://image/album.jpg"}]},
            "artists": {
                "items": [
                    {
                        "uri": "spotify:artist:artist-1",
                        "profile": {"name": "Artist One"},
                    }
                ]
            },
        },
    }

    track = _track_item(raw)

    assert track["id"] == "track-1"
    assert track["artists"][0]["id"] == "artist-1"
    assert track["album"]["id"] == "album-1"
    assert track["album"]["images"][0]["url"] == "https://image/album.jpg"
    assert track["external_ids"] == {"isrc": "US-AAA-01"}
    assert track["duration_ms"] == 123000


def test_spotapi_album_normalizes_track_wrappers_and_release_date():
    raw = {
        "uri": "spotify:album:album-1",
        "name": "Album One",
        "type": "ALBUM",
        "date": {"year": "2024", "month": "2", "day": "3"},
        "artists": {
            "items": [
                {"uri": "spotify:artist:artist-1", "profile": {"name": "Artist One"}}
            ]
        },
        "tracksV2": {
            "totalCount": 1,
            "items": [
                {
                    "track": {
                        "uri": "spotify:track:track-1",
                        "name": "Track One",
                        "trackNumber": 1,
                        "duration": {"totalMilliseconds": 1000},
                    }
                }
            ],
        },
    }

    album = _album_item(raw)

    assert album["id"] == "album-1"
    assert album["release_date"] == "2024-02-03"
    assert album["total_tracks"] == 1
    assert album["tracks"]["items"][0]["id"] == "track-1"


def test_spotapi_track_accepts_duration_variants():
    assert _track_item({"duration": 274589})["duration_ms"] == 274589
    assert _track_item({"trackDuration": {"milliseconds": 225830}})["duration_ms"] == 225830
    assert _track_item({"durationMs": "123000"})["duration_ms"] == 123000
