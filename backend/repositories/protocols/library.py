from typing import Protocol

from models.library import LibraryAlbum


class LibraryRepositoryProtocol(Protocol):
    """Contract for the native library.

    Implemented by ``services.native.target_library_repository.TargetLibraryRepository``
    via ``NativeLibraryStore``.
    """

    def is_configured(self) -> bool:
        ...


    async def has_album(self, mbid: str) -> bool:
        ...

    async def get_library_albums(self) -> list[LibraryAlbum]:
        ...

    async def get_library_album_mbids(self) -> set[str]:
        ...

    async def get_library_artist_mbids(self) -> set[str]:
        ...

    async def get_file_row_by_id(self, file_id: str) -> dict | None:
        ...

    async def get_karaoke_track_rows(self) -> list[dict]:
        """Active indexed tracks with paths and display metadata."""
        ...
