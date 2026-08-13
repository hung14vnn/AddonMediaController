from unittest.mock import AsyncMock

import pytest

from api.v1.routes import lyrics
from core.exceptions import ResourceNotFoundError


@pytest.mark.asyncio
async def test_local_lyrics_falls_back_to_lrclib_when_native_track_is_unknown(
    monkeypatch,
) -> None:
    native = AsyncMock()
    native.get.side_effect = ResourceNotFoundError("Track file local-id not found")
    fallback = {
        "text": "lyrics",
        "is_synced": True,
        "lines": [{"text": "lyrics", "start_seconds": 1.5}],
    }
    lookup = AsyncMock(return_value=fallback)
    monkeypatch.setattr(lyrics._lrclib, "get", lookup)

    response = await lyrics.get_lyrics(
        None,
        source="local",
        track_id="local-id",
        artist="KAWALA",
        title="Ticket to Ride",
        album="Ticket to Ride",
        duration=182.0,
        jellyfin=AsyncMock(),
        navidrome=AsyncMock(),
        native=native,
    )

    assert response.source == "lrclib"
    assert response.lines == [lyrics.LyricsLine(text="lyrics", start_seconds=1.5)]
    lookup.assert_awaited_once_with(
        artist="KAWALA",
        title="Ticket to Ride",
        album="Ticket to Ride",
        duration=182.0,
    )
