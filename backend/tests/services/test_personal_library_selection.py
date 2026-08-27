from unittest.mock import AsyncMock, MagicMock

import pytest

from services.request_service import RequestService


@pytest.mark.asyncio
async def test_existing_global_album_only_adds_user_selection() -> None:
    history = MagicMock()
    history.async_get_record = AsyncMock()
    history.async_record_request = AsyncMock()
    acquisition = MagicMock()
    acquisition.request_album = AsyncMock()
    ownership = MagicMock()
    ownership.provider_album_id = AsyncMock(return_value="rg-1")
    ownership.existing_provider_album_ids = AsyncMock(return_value={"rg-1"})
    ownership.select_album = AsyncMock()

    service = RequestService(
        history,
        get_download_service=lambda: MagicMock(),
        acquisition=acquisition,
        ownership_service=ownership,
    )

    response = await service.request_album(
        "rg-1",
        artist="Artist",
        album="Album",
        user_id="user-2",
        user_role="user",
    )

    assert response.message == "Album is already in the library"
    ownership.select_album.assert_awaited_once_with("user-2", "rg-1")
    history.async_get_record.assert_not_awaited()
    history.async_record_request.assert_not_awaited()
    acquisition.request_album.assert_not_awaited()

