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


def test_spotapi_artists_from_raw_search_desktop():
    raw = {
        "data": {
            "searchV2": {
                "artists": {
                    "items": [
                        {
                            "data": {
                                "uri": "spotify:artist:artist-1",
                                "profile": {"name": "Artist One"},
                                "visuals": {
                                    "avatarImage": {
                                        "sources": [{"url": "https://image/artist.jpg", "width": 320, "height": 320}]
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        }
    }
    artists = SpotApiClient._artists_from_raw(raw)
    assert len(artists) == 1
    assert artists[0]["id"] == "artist-1"
    assert artists[0]["name"] == "Artist One"
    assert artists[0]["images"][0]["url"] == "https://image/artist.jpg"


@pytest.mark.asyncio
async def test_spotapi_search_all_single_request(monkeypatch):
    fake_raw = {
        "data": {
            "searchV2": {
                "tracksV2": {
                    "items": [
                        {
                            "item": {
                                "data": {
                                    "uri": "spotify:track:track-1",
                                    "name": "Track One",
                                    "duration": {"totalMilliseconds": 1000},
                                    "artists": {"items": [{"uri": "spotify:artist:artist-1", "profile": {"name": "Artist One"}}]},
                                    "albumOfTrack": {"uri": "spotify:album:album-1", "name": "Album One"}
                                }
                            }
                        }
                    ]
                },
                "artists": {
                    "items": [
                        {
                            "data": {
                                "uri": "spotify:artist:artist-1",
                                "profile": {"name": "Artist One"}
                            }
                        }
                    ]
                },
                "albumsV2": {
                    "items": [
                        {
                            "data": {
                                "uri": "spotify:album:album-1",
                                "name": "Album One"
                            }
                        }
                    ]
                },
                "playlists": {
                    "items": [
                        {
                            "data": {
                                "uri": "spotify:playlist:playlist-1",
                                "name": "Playlist One"
                            }
                        }
                    ]
                }
            }
        }
    }

    client = SpotApiClient()
    calls = []

    async def mock_search_raw(query, limit, offset):
        calls.append((query, limit, offset))
        return fake_raw

    monkeypatch.setattr(client, "_search_raw", mock_search_raw)
    artists, albums, tracks, playlists = await client.search_all("test", limit=10)

    # Must only make 1 single upstream request!
    assert len(calls) == 1
    assert calls[0] == ("test", 10, 0)
    assert len(artists) == 1
    assert artists[0]["id"] == "artist-1"
    assert len(albums) == 1
    assert albums[0]["id"] == "album-1"
    assert len(tracks) == 1
    assert tracks[0]["id"] == "track-1"
    assert len(playlists) == 1
    assert playlists[0]["id"] == "playlist-1"
