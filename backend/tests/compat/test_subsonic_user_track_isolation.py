import threading
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI

from api.compat.common.path_case import CompatPathCaseMiddleware
from api.compat.common.deps import CompatServices, get_compat_services
from api.v1.schemas.settings import ConnectAppsSettings
from api.compat.subsonic.router import router as subsonic_router
from core.config import Settings
from infrastructure.crypto import init_crypto
from infrastructure.persistence.app_password_store import AppPasswordStore
from infrastructure.persistence.auth_store import AuthStore
from infrastructure.persistence.native_library_store import NativeLibraryStore
from models.local_catalog import (
    CatalogMembership,
    LocalAlbum,
    LocalAlbumExternalIdentity,
    LocalArtist,
    LocalArtistCredit,
    LocalTrack,
    LocalTrackExternalIdentity,
)
from services.compat.advanced_transcode_service import AdvancedTranscodeService
from services.compat.app_password_service import AppPasswordService
from services.compat.avatar_service import CompatAvatarService
from services.compat.stream_concurrency import StreamConcurrencyService
from services.native.target_consumer_composition import (
    build_target_consumer_composition,
)
from services.preferences_service import PreferencesService
from tests.compat.conftest import subsonic_query
from tests.helpers import build_test_client
from types import SimpleNamespace


@pytest.mark.asyncio
async def test_subsonic_endpoints_isolate_user_tracks(tmp_path: Path):
    db_path = tmp_path / "target_isolation.db"
    lock = threading.Lock()
    auth = AuthStore(db_path, lock)

    await auth.create_user(
        id="user-1", display_name="User One", role="member", username="userone"
    )
    await auth.create_user(
        id="user-2", display_name="User Two", role="member", username="usertwo"
    )
    await auth.create_user(
        id="admin-1", display_name="Admin User", role="admin", username="adminuser"
    )

    init_crypto(tmp_path / "config")
    app_passwords = AppPasswordService(AppPasswordStore(db_path, lock), auth)
    _, secret_1 = await app_passwords.create("user-1", "user1-client")
    _, secret_2 = await app_passwords.create("user-2", "user2-client")
    _, secret_admin = await app_passwords.create("admin-1", "admin-client")

    store = NativeLibraryStore(db_path, lock)

    # Seed User 1's track: Artist 1, Album 1, Track 1 (Rock)
    artist_1 = LocalArtist(
        id="artist-1",
        display_name="Artist One",
        folded_name="artist one",
        kind="person",
        created_at=1,
        updated_at=1,
    )
    album_1 = LocalAlbum(
        id="album-1",
        root_id="root-1",
        grouping_key="album-1",
        title="Album One",
        album_artist_id=artist_1.id,
        album_artist_name=artist_1.display_name,
        created_at=1,
        updated_at=1,
    )
    track_1 = LocalTrack(
        id="track-1",
        local_album_id=album_1.id,
        root_id="root-1",
        file_path="/music/track1.flac",
        relative_path="track1.flac",
        path_hash="hash-1",
        file_size_bytes=1000,
        file_mtime_ns=1,
        stat_revision="stat-1",
        title="Track One",
        artist_name="Artist One",
        album_title="Album One",
        album_artist_name="Artist One",
        genre="Rock",
        year=2021,
        file_format="flac",
        imported_at=10,
    )
    await store.create_catalog_membership(
        CatalogMembership(
            album=album_1,
            artists=[artist_1],
            tracks=[track_1],
            track_credits={
                track_1.id: [LocalArtistCredit(local_artist_id=artist_1.id, position=0)]
            },
        )
    )
    await store.attach_album_identity(
        LocalAlbumExternalIdentity(
            local_album_id=album_1.id,
            release_group_mbid="rg-user-1",
            selected_at=2,
        ),
        expected_album_revision=1,
    )
    await store.attach_track_identity(
        LocalTrackExternalIdentity(
            local_track_id=track_1.id,
            recording_mbid="rec-user-1",
            selected_at=2,
        ),
        expected_track_revision=1,
    )

    # Seed User 2's track: Artist 2, Album 2, Track 2 (Pop)
    artist_2 = LocalArtist(
        id="artist-2",
        display_name="Artist Two",
        folded_name="artist two",
        kind="person",
        created_at=3,
        updated_at=3,
    )
    album_2 = LocalAlbum(
        id="album-2",
        root_id="root-1",
        grouping_key="album-2",
        title="Album Two",
        album_artist_id=artist_2.id,
        album_artist_name=artist_2.display_name,
        created_at=3,
        updated_at=3,
    )
    track_2 = LocalTrack(
        id="track-2",
        local_album_id=album_2.id,
        root_id="root-1",
        file_path="/music/track2.flac",
        relative_path="track2.flac",
        path_hash="hash-2",
        file_size_bytes=2000,
        file_mtime_ns=3,
        stat_revision="stat-2",
        title="Track Two",
        artist_name="Artist Two",
        album_title="Album Two",
        album_artist_name="Artist Two",
        genre="Pop",
        year=2022,
        file_format="flac",
        imported_at=20,
    )
    await store.create_catalog_membership(
        CatalogMembership(
            album=album_2,
            artists=[artist_2],
            tracks=[track_2],
            track_credits={
                track_2.id: [LocalArtistCredit(local_artist_id=artist_2.id, position=0)]
            },
        )
    )
    await store.attach_album_identity(
        LocalAlbumExternalIdentity(
            local_album_id=album_2.id,
            release_group_mbid="rg-user-2",
            selected_at=4,
        ),
        expected_album_revision=1,
    )
    await store.attach_track_identity(
        LocalTrackExternalIdentity(
            local_track_id=track_2.id,
            recording_mbid="rec-user-2",
            selected_at=4,
        ),
        expected_track_revision=1,
    )

    # User 1 selects Album 1
    await store.select_target_library_item("user-1", "album", "rg-user-1")
    # User 2 selects Album 2
    await store.select_target_library_item("user-2", "album", "rg-user-2")

    settings = Settings()
    settings.config_file_path = tmp_path / "target-compat.json"
    preferences = PreferencesService(settings)
    preferences.save_connect_apps_settings(
        ConnectAppsSettings(subsonic_enabled=True, jellyfin_enabled=True)
    )
    provider_covers = AsyncMock()
    provider_covers.get_release_group_cover.return_value = None
    provider_covers.get_release_group_cover_etag.return_value = None
    provider_covers.get_artist_image.return_value = None
    provider_covers.get_artist_image_etag.return_value = None

    plugin_host = SimpleNamespace(
        dispatch_event=AsyncMock(), dispatch_scrobble=AsyncMock()
    )
    target = build_target_consumer_composition(
        store=store,
        preferences=preferences,
        auth_store=auth,
        provider_covers=provider_covers,
        cache=AsyncMock(),
        cache_dir=tmp_path,
        client_factory=SimpleNamespace(
            resolve_lastfm=AsyncMock(return_value=None),
            resolve_listenbrainz=AsyncMock(return_value=None),
        ),
        listening_prefs_store=SimpleNamespace(
            get=AsyncMock(
                return_value=SimpleNamespace(
                    scrobble_to_lastfm=False,
                    scrobble_to_listenbrainz=False,
                )
            )
        ),
        now_playing=SimpleNamespace(
            update=AsyncMock(),
            remove=AsyncMock(),
            compat_now_playing=lambda: [],
        ),
        plugin_host=plugin_host,
    )

    scan = AsyncMock()
    scan.status.return_value = (False, 0)
    bundle = CompatServices(
        app_passwords=app_passwords,
        view=target.view,
        favorites=target.favorites,
        playlists=target.playlists,
        scrobble=target.scrobble,
        discover=target.discover,
        id_map=target.id_map,
        local_files=target.local_files,
        coverart=target.covers,
        preferences=preferences,
        transcode=AsyncMock(),
        stream_concurrency=StreamConcurrencyService(),
        now_playing=AsyncMock(),
        version=SimpleNamespace(
            get_current_version=lambda: SimpleNamespace(version="test")
        ),
        play_queue=target.play_queue,
        bookmarks=target.bookmarks,
        lyrics=AsyncMock(),
        avatars=CompatAvatarService(tmp_path),
        playback_report=target.playback_report,
        scan=scan,
        advanced_transcode=AdvancedTranscodeService(),
    )

    app = FastAPI()
    app.include_router(subsonic_router)
    app.add_middleware(
        CompatPathCaseMiddleware,
        routes=list(subsonic_router.routes),
    )
    app.dependency_overrides[get_compat_services] = lambda: bundle
    client = build_test_client(app)

    q1 = subsonic_query(secret_1, "userone")
    q2 = subsonic_query(secret_2, "usertwo")
    q_admin = subsonic_query(secret_admin, "adminuser")

    # 1. getRandomSongs for User 1: MUST only see Track One, NEVER Track Two
    resp1 = client.get("/subsonic/rest/getRandomSongs", params={**q1, "size": 10}).json()
    songs1 = resp1["subsonic-response"]["randomSongs"].get("song", [])
    titles1 = [s["title"] for s in songs1]
    assert titles1 == ["Track One"], f"User 1 saw unexpected songs: {titles1}"

    # 2. getRandomSongs for User 2: MUST only see Track Two, NEVER Track One
    resp2 = client.get("/subsonic/rest/getRandomSongs", params={**q2, "size": 10}).json()
    songs2 = resp2["subsonic-response"]["randomSongs"].get("song", [])
    titles2 = [s["title"] for s in songs2]
    assert titles2 == ["Track Two"], f"User 2 saw unexpected songs: {titles2}"

    # 3. getRandomSongs for Admin: CAN see both
    resp_admin = client.get("/subsonic/rest/getRandomSongs", params={**q_admin, "size": 10}).json()
    songs_admin = resp_admin["subsonic-response"]["randomSongs"].get("song", [])
    titles_admin = {s["title"] for s in songs_admin}
    assert titles_admin == {"Track One", "Track Two"}

    # 4. getTopSongs for User 1:
    # Query Artist One: sees Track One
    resp_top1 = client.get("/subsonic/rest/getTopSongs", params={**q1, "artist": "Artist One"}).json()
    top_songs1 = resp_top1["subsonic-response"]["topSongs"].get("song", [])
    assert [s["title"] for s in top_songs1] == ["Track One"]

    # Query Artist Two: 70 Artist not found
    resp_top_foreign = client.get("/subsonic/rest/getTopSongs", params={**q1, "artist": "Artist Two"}).json()
    assert resp_top_foreign["subsonic-response"]["status"] == "failed"
    assert resp_top_foreign["subsonic-response"]["error"]["code"] == 70

    # 5. search3 for User 1: only sees Track One and Album One and Artist One
    search1 = client.get("/subsonic/rest/search3", params={**q1, "query": ""}).json()[
        "subsonic-response"
    ]["searchResult3"]
    assert [s["title"] for s in search1.get("song", [])] == ["Track One"]
    assert [a["name"] for a in search1.get("album", [])] == ["Album One"]
    assert [a["name"] for a in search1.get("artist", [])] == ["Artist One"]

    # 6. getSongsByGenre: User 1 querying "Pop" (Genre of User 2's track) sees nothing
    genre_pop1 = client.get("/subsonic/rest/getSongsByGenre", params={**q1, "genre": "Pop"}).json()[
        "subsonic-response"
    ]["songsByGenre"].get("song", [])
    assert genre_pop1 == []

    genre_rock1 = client.get("/subsonic/rest/getSongsByGenre", params={**q1, "genre": "Rock"}).json()[
        "subsonic-response"
    ]["songsByGenre"].get("song", [])
    assert [s["title"] for s in genre_rock1] == ["Track One"]

    # 7. getAlbum for User 1: can access Album One, but Album Two returns 70
    album1_resp = client.get("/subsonic/rest/getAlbum", params={**q1, "id": search1["album"][0]["id"]}).json()
    assert album1_resp["subsonic-response"]["status"] == "ok"

    # Search for User 2's album id
    search2 = client.get("/subsonic/rest/search3", params={**q2, "query": ""}).json()[
        "subsonic-response"
    ]["searchResult3"]
    album2_id = search2["album"][0]["id"]
    track2_id = search2["song"][0]["id"]

    album2_for_user1 = client.get("/subsonic/rest/getAlbum", params={**q1, "id": album2_id}).json()
    assert album2_for_user1["subsonic-response"]["status"] == "failed"
    assert album2_for_user1["subsonic-response"]["error"]["code"] == 70

    # 8. getSong for User 1: Track Two returns 70
    song2_for_user1 = client.get("/subsonic/rest/getSong", params={**q1, "id": track2_id}).json()
    assert song2_for_user1["subsonic-response"]["status"] == "failed"
    assert song2_for_user1["subsonic-response"]["error"]["code"] == 70

    # 9. getSimilarSongs for User 1:
    artist1_id = search1["artist"][0]["id"]
    sim1 = client.get("/subsonic/rest/getSimilarSongs", params={**q1, "id": artist1_id}).json()
    assert [s["title"] for s in sim1["subsonic-response"]["similarSongs"].get("song", [])] == ["Track One"]

    artist2_id = search2["artist"][0]["id"]
    sim2_for_user1 = client.get("/subsonic/rest/getSimilarSongs", params={**q1, "id": artist2_id}).json()
    assert sim2_for_user1["subsonic-response"]["status"] == "failed"
    assert sim2_for_user1["subsonic-response"]["error"]["code"] == 70

    # 10. getAlbumList2 for User 1: only returns Album One across types
    for list_type in ["newest", "random", "alphabeticalByName"]:
        albums_resp = client.get(
            "/subsonic/rest/getAlbumList2", params={**q1, "type": list_type, "size": 10}
        ).json()
        returned_albums = albums_resp["subsonic-response"]["albumList2"].get("album", [])
        assert [a.get("name") or a.get("title") for a in returned_albums] == ["Album One"]

    # 11. getArtists for User 1: only sees Artist One
    artists_resp = client.get("/subsonic/rest/getArtists", params=q1).json()
    idx_artists = [
        a["name"]
        for index in artists_resp["subsonic-response"]["artists"].get("index", [])
        for a in index.get("artist", [])
    ]
    assert idx_artists == ["Artist One"]

    # 12. getMusicDirectory:
    # Directory root: only sees Artist One
    root_dir = client.get("/subsonic/rest/getMusicDirectory", params={**q1, "id": "1"}).json()
    child_artists = [c["title"] for c in root_dir["subsonic-response"]["directory"].get("child", [])]
    assert child_artists == ["Artist One"]

    # Album directory for foreign album: 70
    album2_dir = client.get("/subsonic/rest/getMusicDirectory", params={**q1, "id": album2_id}).json()
    assert album2_dir["subsonic-response"]["status"] == "failed"
    assert album2_dir["subsonic-response"]["error"]["code"] == 70

    # 13. stream for foreign track: binary 404
    stream_foreign = client.get("/subsonic/rest/stream", params={**q1, "id": track2_id})
    assert stream_foreign.status_code == 404
    assert stream_foreign.text == "Song not found"

    # 14. download for foreign track: binary 404
    download_foreign = client.get("/subsonic/rest/download", params={**q1, "id": track2_id})
    assert download_foreign.status_code == 404
    assert download_foreign.text == "Song not found"

    # 15. getLyricsBySongId for foreign track: 70
    lyrics_foreign = client.get("/subsonic/rest/getLyricsBySongId", params={**q1, "id": track2_id}).json()
    assert lyrics_foreign["subsonic-response"]["status"] == "failed"
    assert lyrics_foreign["subsonic-response"]["error"]["code"] == 70

    # 16. getGenres: User 1 only sees Rock; User 2 only sees Pop; Admin sees both
    genres1 = client.get("/subsonic/rest/getGenres", params=q1).json()
    genre_names1 = [g["value"] for g in genres1["subsonic-response"]["genres"].get("genre", [])]
    assert genre_names1 == ["Rock"]

    genres2 = client.get("/subsonic/rest/getGenres", params=q2).json()
    genre_names2 = [g["value"] for g in genres2["subsonic-response"]["genres"].get("genre", [])]
    assert genre_names2 == ["Pop"]

    genres_admin = client.get("/subsonic/rest/getGenres", params=q_admin).json()
    admin_genre_names = [g["value"] for g in genres_admin["subsonic-response"]["genres"].get("genre", [])]
    assert admin_genre_names == ["Pop", "Rock"]

    # 17. getCoverArt with foreign track: binary 404
    cover_foreign = client.get("/subsonic/rest/getCoverArt", params={**q1, "id": track2_id})
    assert cover_foreign.status_code == 404

    # 18. createBookmark and deleteBookmark for foreign track: 70
    bm_foreign = client.get("/subsonic/rest/createBookmark", params={**q1, "id": track2_id, "position": 1000}).json()
    assert bm_foreign["subsonic-response"]["status"] == "failed"
    assert bm_foreign["subsonic-response"]["error"]["code"] == 70

    del_bm_foreign = client.get("/subsonic/rest/deleteBookmark", params={**q1, "id": track2_id}).json()
    assert del_bm_foreign["subsonic-response"]["status"] == "failed"
    assert del_bm_foreign["subsonic-response"]["error"]["code"] == 70

    # 19. savePlayQueue with foreign track: 70
    pq_foreign = client.get("/subsonic/rest/savePlayQueue", params={**q1, "id": track2_id}).json()
    assert pq_foreign["subsonic-response"]["status"] == "failed"
    assert pq_foreign["subsonic-response"]["error"]["code"] == 70

    # 20. star and unstar with foreign track: 70
    star_foreign = client.get("/subsonic/rest/star", params={**q1, "id": track2_id}).json()
    assert star_foreign["subsonic-response"]["status"] == "failed"
    assert star_foreign["subsonic-response"]["error"]["code"] == 70

    # 21. setRating with foreign track: 70
    rating_foreign = client.get("/subsonic/rest/setRating", params={**q1, "id": track2_id, "rating": 5}).json()
    assert rating_foreign["subsonic-response"]["status"] == "failed"
    assert rating_foreign["subsonic-response"]["error"]["code"] == 70

    # 22. createPlaylist and updatePlaylist with foreign track: 70
    pl_create_foreign = client.get("/subsonic/rest/createPlaylist", params={**q1, "name": "My PL", "songId": track2_id}).json()
    assert pl_create_foreign["subsonic-response"]["status"] == "failed"
    assert pl_create_foreign["subsonic-response"]["error"]["code"] == 70

