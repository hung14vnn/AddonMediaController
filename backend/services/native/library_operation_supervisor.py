"""Claim and dispatch one durable target library operation at a time."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from api.v1.schemas.library_operations import OperationResponse
from core.exceptions import StaleRevisionError
from infrastructure.persistence.native_library_store import NativeLibraryStore
from services.native.background_workload_gate import BackgroundWorkloadGate
from services.native.explicit_reidentification_worker import (
    ExplicitReidentificationWorker,
)
from services.native.identity_repair_service import IdentityRepairService
from services.native.library_operation_service import (
    LEASE_SECONDS,
    LibraryOperationService,
)

logger = logging.getLogger(__name__)


class LibraryOperationSupervisor:
    def __init__(
        self,
        store: NativeLibraryStore,
        operations: LibraryOperationService,
        repairs: IdentityRepairService,
        reidentification: ExplicitReidentificationWorker,
        workload_gate: BackgroundWorkloadGate | None = None,
    ) -> None:
        self._store = store
        self._operations = operations
        self._repairs = repairs
        self._reidentification = reidentification
        self._workload_gate = workload_gate

    async def recover(self, *, now: float | None = None) -> int:
        return await self._operations.recover(now=now)

    async def run_once(
        self, worker_id: str, *, now: float | None = None
    ) -> OperationResponse | None:
        timestamp = time.time() if now is None else now
        job = None
        kinds = ["bulk_review_apply", "repair"]
        if self._workload_gate is None or not self._workload_gate.scan_active:
            kinds.insert(0, "explicit_reidentification")
        for kind in kinds:
            job = await self._store.claim_operation_job(
                worker_id,
                now=timestamp,
                lease_seconds=LEASE_SECONDS,
                kind=kind,
            )
            if job is not None:
                break
        if job is None:
            return None
        try:
            return await self._dispatch_claimed(job, worker_id, timestamp, now=now)
        except asyncio.CancelledError:
            # R-04: release the 60s claim so the job is immediately
            # reclaimable instead of sitting running until lease expiry. One
            # handler here covers all operation callees (reidentification,
            # management, bulk, repair, hygiene, reconciliation) - no
            # per-service change. The claim-time revision goes stale
            # mid-run (work-counter writes bump it), so release against the
            # live row (mirrors run_claimed_job's pre-finish re-read).
            # StaleRevisionError means the finish commit (or a control
            # transition) already landed → commit wins, swallow.
            # (R-03: no worker-level cleanup - this job-level release runs
            # before the cancel propagates to the worker, which must not
            # double-release.)
            try:
                current = await self._store.get_operation_job(str(job["id"]))
                expected = (
                    int(current["row_revision"])
                    if current is not None
                    else int(job["row_revision"])
                )
                await self._store.release_operation_claim(
                    str(job["id"]),
                    worker_id=worker_id,
                    expected_job_revision=expected,
                    now=time.time(),
                )
            except StaleRevisionError:
                pass
            except Exception:  # noqa: BLE001 - release failure must not mask the cancel
                logger.exception(
                    "Operation claim release failed for %s; re-raising cancel",
                    job["id"],
                )
            raise

    async def _dispatch_claimed(
        self,
        job: dict,
        worker_id: str,
        timestamp: float,
        *,
        now: float | None,
    ) -> OperationResponse | None:
        if job["kind"] == "explicit_reidentification":
            row = await self._reidentification.run_claimed(
                job, worker_id, now=timestamp
            )
            return self._operations._response(row)
        if job["kind"] == "bulk_review_apply":
            return await self._operations.run_bulk_claimed(
                job,
                worker_id,
                str(job["requested_by_user_id"]),
                now=timestamp,
            )
        snapshot = await self._store.get_operation_snapshot(str(job["id"]))
        if snapshot is None:
            return await self._operations.get(str(job["id"]))
        if snapshot["snapshot"]["phase"] == "apply":
            return await self._repairs.run_claimed_apply(
                job,
                worker_id,
                str(job["requested_by_user_id"]),
                now=timestamp,
            )
        return await self._repairs.run_claimed_audit(job, worker_id, now=timestamp)
