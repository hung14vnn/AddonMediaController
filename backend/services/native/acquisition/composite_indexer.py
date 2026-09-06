"""CompositeIndexer - pool Newznab + usenet-targeting plugin indexers.

Wraps ``[NewznabIndexer, *registry.indexers_for_target('usenet')]`` as one
``IndexerProtocol`` with ``indexer_name == "usenet"``. Fans one logical search
out across every member with ``return_exceptions`` gather, pools the
``UsenetRelease`` results, and dedups by the cross-indexer
:func:`models.download_identity.usenet_identity` key (first-seen-wins, so the
configured Newznab priority wins over pooled plugin copies). One member
erroring never fails the fan-out.
"""

import asyncio
import logging

from models.common import ServiceStatus
from models.download_identity import usenet_identity

logger = logging.getLogger(__name__)


class CompositeIndexer:
    """One ``usenet`` indexer pooling Newznab + plugin usenet indexers."""

    def __init__(self, newznab_indexer=None, plugin_indexers=None) -> None:
        self._primary = newznab_indexer
        self._extras = list(plugin_indexers or [])

    @property
    def indexer_name(self) -> str:
        return "usenet"

    def is_configured(self) -> bool:
        try:
            if self._primary is not None and self._primary.is_configured():
                return True
        except Exception:  # noqa: BLE001 - absence, not failure
            pass
        for extra in self._extras:
            try:
                if extra.is_configured():
                    return True
            except Exception:  # noqa: BLE001 - one bad plugin never blocks
                continue
        return False

    async def health_check(self) -> ServiceStatus:
        if self._primary is not None:
            try:
                return await self._primary.health_check()
            except Exception:  # noqa: BLE001 - degraded, never fatal
                pass
        if not self._extras:
            return ServiceStatus(status="error", message="No indexers configured")
        reachable = 0
        for extra in self._extras:
            try:
                status = await extra.health_check()
            except Exception:  # noqa: BLE001 - one bad plugin never blocks
                continue
            if getattr(status, "status", "") == "ok":
                reachable += 1
        if reachable:
            return ServiceStatus(
                status="ok",
                message=f"{reachable}/{len(self._extras)} indexer(s) reachable",
            )
        return ServiceStatus(status="error", message="No indexer reachable")

    def _members(self) -> list:
        members = []
        if self._primary is not None:
            members.append(self._primary)
        members.extend(self._extras)
        return members

    def _dedup(self, releases: list) -> list:
        seen: set[str] = set()
        out = []
        dropped = 0
        for release in releases:
            try:
                key = usenet_identity(release.title, release.size_bytes)
            except Exception:  # noqa: BLE001 - one bad release never blocks
                continue
            if key in seen:
                dropped += 1
                continue
            seen.add(key)
            out.append(release)
        if dropped:
            logger.info("usenet composite deduped %d cross-indexer duplicate(s)", dropped)
        return out

    async def search_album(
        self,
        artist_name: str,
        album_title: str,
        year: int | None = None,
        track_count: int | None = None,
        *,
        timeout: float = 30.0,
    ) -> list:
        members = self._members()
        if not members:
            return []
        results = await asyncio.gather(
            *(
                member.search_album(
                    artist_name, album_title, year, track_count, timeout=timeout
                )
                for member in members
            ),
            return_exceptions=True,
        )
        pooled = []
        for member, res in zip(members, results):
            if isinstance(res, Exception):
                logger.warning(
                    "usenet composite member %s search failed: %s",
                    getattr(member, "indexer_name", "?"),
                    res,
                )
                continue
            for row in res or []:
                release = getattr(row, "usenet", None)
                if release is not None:
                    pooled.append(release)
        deduped = self._dedup(pooled)
        from repositories.protocols.indexer import IndexerResult

        return [IndexerResult(source="usenet", usenet=r) for r in deduped]

    async def search_track(
        self,
        artist_name: str,
        track_title: str,
        album_title: str | None = None,
        duration_seconds: int | None = None,
        *,
        timeout: float = 30.0,
    ) -> list:
        members = self._members()
        if not members:
            return []
        results = await asyncio.gather(
            *(
                member.search_track(
                    artist_name,
                    track_title,
                    album_title,
                    duration_seconds,
                    timeout=timeout,
                )
                for member in members
            ),
            return_exceptions=True,
        )
        pooled = []
        for member, res in zip(members, results):
            if isinstance(res, Exception):
                logger.warning(
                    "usenet composite member %s search failed: %s",
                    getattr(member, "indexer_name", "?"),
                    res,
                )
                continue
            for row in res or []:
                release = getattr(row, "usenet", None)
                if release is not None:
                    pooled.append(release)
        deduped = self._dedup(pooled)
        from repositories.protocols.indexer import IndexerResult

        return [IndexerResult(source="usenet", usenet=r) for r in deduped]
