from services.spotify_catalog import (
    album_provider_id,
    artist_provider_id,
    spotify_album_basic,
    spotify_album_id,
    spotify_album_search_result,
    spotify_album_tracks,
    spotify_artist_id,
    spotify_artist_info,
    spotify_artist_search_result,
    spotify_suggestion,
)


ARTIST = {
    "id": "artist123",
    "name": "Test Artist",
    "genres": ["indie"],
    "images": [{"url": "https://i.scdn.co/artist.jpg"}],
    "external_urls": {"spotify": "https://open.spotify.com/artist/artist123"},
    "popularity": 80,
}

ALBUM = {
    "id": "album123",
    "name": "Test Album",
    "album_type": "album",
    "release_date": "2026-08-20",
    "images": [{"url": "https://i.scdn.co/album.jpg"}],
    "artists": [{"id": "artist123", "name": "Test Artist"}],
    "tracks": {
        "items": [
            {
                "id": "track123",
                "name": "Test Track",
                "track_number": 1,
                "disc_number": 1,
                "duration_ms": 123000,
            }
        ]
    },
    "total_tracks": 1,
}


def test_spotify_provider_ids_round_trip() -> None:
    artist_id = artist_provider_id("artist123")
    album_id = album_provider_id("album123")

    assert spotify_artist_id(artist_id) == "artist123"
    assert spotify_album_id(album_id) == "album123"
    assert spotify_artist_id(album_id) is None
    assert spotify_album_id(artist_id) is None


def test_spotify_search_and_suggestions_keep_images_and_provider_ids() -> None:
    artist = spotify_artist_search_result(ARTIST, "Test Artist")
    album = spotify_album_search_result(ALBUM, "Test Album")
    suggestion = spotify_suggestion(ALBUM, "album", "Test Album")

    assert artist.musicbrainz_id == "spotify:artist:artist123"
    assert artist.thumb_url == "https://i.scdn.co/artist.jpg"
    assert album.musicbrainz_id == "spotify:album:album123"
    assert album.album_thumb_url == "https://i.scdn.co/album.jpg"
    assert suggestion.cover_url == "https://i.scdn.co/album.jpg"


def test_spotify_artist_and_album_page_mappers() -> None:
    artist = spotify_artist_info(ARTIST)
    album = spotify_album_basic(ALBUM)
    tracks = spotify_album_tracks(ALBUM)

    assert artist.musicbrainz_id == "spotify:artist:artist123"
    assert artist.tags == ["indie"]
    assert album.musicbrainz_id == "spotify:album:album123"
    assert album.artist_id == "spotify:artist:artist123"
    assert tracks.total_tracks == 1
    assert tracks.tracks[0].recording_id == "spotify:track:track123"
