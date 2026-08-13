import pytest
from unittest.mock import AsyncMock

from services.lrclib_lyrics_service import LrclibLyricsService, _REQUEST_FAILED


def test_parse_lrc_supports_multiple_timestamps_and_milliseconds():
    lines = LrclibLyricsService._parse_lrc("[00:01.25][00:02.500]Hello\n[01:03.04]World")
    assert lines == [
        {"text": "Hello", "start_seconds": 1.25},
        {"text": "Hello", "start_seconds": 2.5},
        {"text": "World", "start_seconds": 63.04},
    ]


@pytest.mark.asyncio
async def test_transient_lookup_failure_is_not_negative_cached():
    service = LrclibLyricsService()
    service._fetch = AsyncMock(  # type: ignore[method-assign]
        side_effect=[_REQUEST_FAILED, {"text": "lyrics", "is_synced": False, "lines": []}]
    )

    first = await service.get(artist="Artist", title="Track", album="Album", duration=180)
    second = await service.get(artist="Artist", title="Track", album="Album", duration=180)

    assert first is None
    assert second == {"text": "lyrics", "is_synced": False, "lines": []}
    assert service._fetch.await_count == 2


@pytest.mark.asyncio
async def test_get_searches_when_duration_is_unavailable(monkeypatch):
    service = LrclibLyricsService()
    called = False

    async def fake_fetch(*args, **kwargs):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(service, "_fetch", fake_fetch)
    assert await service.get(artist="Artist", title="Song", album="", duration=None) is None
    assert called is True


def test_search_match_requires_exact_artist_and_title():
    matches = [
        {"artistName": "Other", "trackName": "Song"},
        {"artistName": "Artist", "trackName": "Song", "plainLyrics": "Words"},
    ]
    assert LrclibLyricsService._select_match(matches, "Artist", "Song", "", None) == matches[1]


@pytest.mark.asyncio
async def test_get_caches_positive_result(monkeypatch):
    service = LrclibLyricsService()
    calls = 0

    async def fake_fetch(*args, **kwargs):
        nonlocal calls
        calls += 1
        return {"text": "Words", "is_synced": False, "lines": [], "source": "lrclib"}

    monkeypatch.setattr(service, "_fetch", fake_fetch)
    first = await service.get(artist="Artist", title="Song", album="Album", duration=200)
    second = await service.get(artist="Artist", title="Song", album="Album", duration=200)
    assert first == second
    assert calls == 1
