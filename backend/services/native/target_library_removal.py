"""Remove an album from the target library, with its follow-up cleanup.

Shared by the web UI route (``DELETE /library/album/{album_id}``) and the
Subsonic extension the player uses (``removeLibraryAlbum``).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def remove_album_and_cleanup(
    album_id: str,
    *,
    actor_user_id: str,
    delete_files: bool,
    stop_wanted: bool,
    writer: Any,  # TargetCatalogWriterService
    wanted: Any,  # WantedWatcherService
    download_service: Any,  # DownloadService
) -> list[str]:
    """Remove the album, then purge its downloads and settle its Wanted state.

    Returns the removed track ids. Cleanup failures are logged, not raised: the
    removal itself has already succeeded.
    """
    release_group_mbid = await writer.provider_release_group_id(album_id)
    removed = await writer.remove_album(
        album_id, actor_user_id=actor_user_id, delete_files=delete_files
    )
    cleanup_id = release_group_mbid or album_id
    try:
        await download_service.purge_album_downloads(cleanup_id)
    except Exception:  # noqa: BLE001 - removal already succeeded
        logger.warning("Target album removal download cleanup failed")
    if release_group_mbid:
        try:
            if stop_wanted:
                await wanted.stop_after_library_removal(release_group_mbid)
            else:
                await wanted.continue_after_library_removal(release_group_mbid)
        except Exception:  # noqa: BLE001 - removal already succeeded
            logger.warning("Target album removal wanted-state cleanup failed")
    return removed
