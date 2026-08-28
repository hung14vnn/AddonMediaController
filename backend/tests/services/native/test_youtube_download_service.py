import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from services.native import youtube_download_service as youtube_module
from services.native.youtube_download_service import (
    YouTubeDownloadService,
    _preview_for_url,
    _schedule_progress,
    _validate_url,
    _video_urls,
    _youtube_local_ids,
)


class FakeYoutubeDL:
    results: list[object] = []
    instances: list["FakeYoutubeDL"] = []
    downloads: list[str] = []

    def __init__(self, options):
        self.options = options
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return None

    def extract_info(self, _url, *, download):
        assert download is False
        return self.results.pop(0)

    def download(self, urls):
        self.downloads.extend(urls)
        hook = self.options["progress_hooks"][0]
        hook({"status": "downloading", "downloaded_bytes": 25, "total_bytes": 100})
        output = Path(self.options["outtmpl"].replace("%(ext)s", "m4a"))
        output.write_bytes(b"native m4a")


@pytest.fixture(autouse=True)
def reset_fake_ytdlp():
    FakeYoutubeDL.results = []
    FakeYoutubeDL.instances = []
    FakeYoutubeDL.downloads = []


def test_mix_url_keeps_video_and_discards_generated_queue_parameters():
    url = "https://www.youtube.com/watch?v=abc&list=RDabc&start_radio=1&t=12"

    assert _validate_url(url) == "https://www.youtube.com/watch?v=abc&t=12"


def test_single_video_does_not_need_playlist_extraction(monkeypatch):
    monkeypatch.setattr(
        youtube_module,
        "YoutubeDL",
        lambda _options: pytest.fail(
            "single URLs must not trigger playlist extraction"
        ),
    )

    assert _video_urls("https://youtu.be/abc") == ["https://youtu.be/abc"]


@pytest.mark.parametrize(
    ("url", "identity"),
    [
        ("https://youtu.be/short-id", "short-id"),
        ("https://www.youtube.com/watch?v=watch-id", "watch-id"),
        ("https://www.youtube.com/playlist?list=playlist-id", "playlist-id"),
    ],
)
def test_youtube_local_ids_are_stable_for_supported_urls(url, identity):
    assert _youtube_local_ids(url) == (
        f"youtube:album:{identity}",
        f"youtube:track:{identity}",
    )


def test_playlist_entries_are_expanded_in_order(monkeypatch):
    FakeYoutubeDL.results = [
        {
            "entries": [
                {"id": "first"},
                {"webpage_url": "https://www.youtube.com/watch?v=second"},
                None,
            ]
        }
    ]
    monkeypatch.setattr(youtube_module, "YoutubeDL", FakeYoutubeDL)

    assert _video_urls("https://www.youtube.com/playlist?list=PL123") == [
        "https://www.youtube.com/watch?v=first",
        "https://www.youtube.com/watch?v=second",
    ]
    assert FakeYoutubeDL.instances[0].options["extract_flat"] is True


def test_preview_uses_first_playlist_video_and_preserves_response_shape(monkeypatch):
    playlist_url = "https://www.youtube.com/playlist?list=PL123"
    FakeYoutubeDL.results = [
        {"entries": [{"id": "first"}, {"id": "second"}]},
        {
            "title": "A title",
            "channel": "An uploader",
            "duration": 123,
            "thumbnail": "https://img.example/thumb.jpg",
        },
    ]
    monkeypatch.setattr(youtube_module, "YoutubeDL", FakeYoutubeDL)

    assert _preview_for_url(playlist_url) == {
        "url": playlist_url,
        "title": "A title",
        "uploader": "An uploader",
        "duration_seconds": 123,
        "thumbnail": "https://img.example/thumb.jpg",
    }


def test_download_keeps_native_m4a_names_and_reports_progress(monkeypatch, tmp_path):
    monkeypatch.setattr(youtube_module, "YoutubeDL", FakeYoutubeDL)
    monkeypatch.setattr(
        youtube_module,
        "_video_urls",
        lambda _url: ["https://youtu.be/first", "https://youtu.be/second"],
    )
    scheduled: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        youtube_module,
        "_schedule_progress",
        lambda _loop, _callback, task_id, progress: scheduled.append(
            (task_id, progress)
        ),
    )
    service = YouTubeDownloadService(
        drop_import=AsyncMock(),
        download_store=AsyncMock(),
        event_bus=AsyncMock(),
        staging_root=tmp_path,
    )

    service._download_audio("https://example.invalid", tmp_path, "task-1", object())

    assert FakeYoutubeDL.downloads == [
        "https://youtu.be/first",
        "https://youtu.be/second",
    ]
    assert [path.name for path in sorted(tmp_path.glob("*.m4a"))] == [
        "youtube-1.m4a",
        "youtube-2.m4a",
    ]
    assert all(
        instance.options["format"] == "bestaudio[ext=m4a]"
        for instance in FakeYoutubeDL.instances
    )
    assert scheduled[0][0] == "task-1"


def test_progress_hook_uses_estimated_size_when_exact_size_is_missing(monkeypatch):
    calls = []
    published = []
    monkeypatch.setattr(
        asyncio,
        "run_coroutine_threadsafe",
        lambda coroutine, loop: calls.append((coroutine, loop)),
    )

    async def callback(*args):
        published.append(args)

    _schedule_progress(
        "loop",
        callback,
        "task-1",
        {
            "status": "downloading",
            "downloaded_bytes": 40,
            "total_bytes_estimate": 100,
        },
    )

    coroutine, loop = calls[0]
    assert loop == "loop"
    asyncio.run(coroutine)
    assert published == [("task-1", 100, 60)]


@pytest.mark.asyncio
async def test_task_records_ytdlp_as_download_client(monkeypatch, tmp_path):
    store = AsyncMock()
    store.create_task.return_value = SimpleNamespace(id="task-1")
    bus = AsyncMock()
    service = YouTubeDownloadService(
        drop_import=AsyncMock(),
        download_store=store,
        event_bus=bus,
        staging_root=tmp_path,
    )
    service.preview = AsyncMock(
        return_value={
            "title": "Title",
            "uploader": "Uploader",
            "thumbnail": "https://i.ytimg.com/cover.jpg",
        }
    )
    spawned = []

    def capture_task(coroutine):
        spawned.append(coroutine)
        coroutine.close()

    monkeypatch.setattr(asyncio, "create_task", capture_task)

    assert (
        await service.download(
            user_id="user-1",
            url="https://youtu.be/abc",
            artist_name="Edited Artist",
            track_title="Edited Title",
        )
        == "task-1"
    )
    assert store.create_task.await_args.kwargs["download_client"] == "yt-dlp"
    assert store.create_task.await_args.kwargs["release_group_mbid"] == (
        "youtube:album:abc"
    )
    assert store.create_task.await_args.kwargs["recording_mbid"] == "youtube:track:abc"
    assert store.create_task.await_args.kwargs["cover_url"] == (
        "https://i.ytimg.com/cover.jpg"
    )
    assert store.create_task.await_args.kwargs["artist_name"] == "Edited Artist"
    assert store.create_task.await_args.kwargs["album_title"] == "Edited Title"
    assert store.create_task.await_args.kwargs["track_title"] == "Edited Title"
    assert len(spawned) == 1


@pytest.mark.asyncio
async def test_completed_download_forwards_local_identity_and_artwork_to_importer(
    monkeypatch, tmp_path
):
    store = AsyncMock()
    store.get_task.return_value = SimpleNamespace(
        status="downloading",
        release_group_mbid="youtube:album:abc",
        recording_mbid="youtube:track:abc",
        artist_name="Uploader",
        album_title="Title",
        track_title="Title",
        cover_url="https://i.ytimg.com/cover.jpg",
    )
    drop_import = AsyncMock()
    service = YouTubeDownloadService(
        drop_import=drop_import,
        download_store=store,
        event_bus=AsyncMock(),
        staging_root=tmp_path,
    )

    def fake_download(_url, staging, _task_id, _loop):
        (staging / "youtube-1.m4a").write_bytes(b"audio")

    monkeypatch.setattr(service, "_download_audio", fake_download)

    await service._run("task-1", "user-1", "https://youtu.be/abc")

    kwargs = drop_import.create_job.await_args.kwargs
    assert kwargs["release_group_mbid"] == "youtube:album:abc"
    assert kwargs["recording_mbid"] == "youtube:track:abc"
    assert kwargs["requested_cover_url"] == "https://i.ytimg.com/cover.jpg"
