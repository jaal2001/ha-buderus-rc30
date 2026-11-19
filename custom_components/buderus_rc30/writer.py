"""Save a draft with one preflight, durable backup and one full verification pass."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from homeassistant.helpers.storage import Store

from .api import EmsEspError, decode_slots
from .const import DOMAIN

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .coordinator import Rc30Coordinator

TERMINAL = {"idle", "succeeded", "rolled_back", "rejected"}


class SaveError(Exception):
    """Expose only a stable error code, never upstream text or credentials."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ScheduleWriter:
    """Keep one persistent fallback; restore only after an explicit admin request."""

    def __init__(self, hass: HomeAssistant, entry_id: str, coordinator: Rc30Coordinator):
        self.coordinator = coordinator
        self.client = coordinator.client
        self.store = Store(hass, 1, f"{DOMAIN}_save_{entry_id}", private=True, atomic_writes=True)
        self.record: dict[str, Any] = {"state": "idle"}
        self.busy = False
        self._idle = asyncio.Event()
        self._idle.set()
        self.backup_valid = False

    async def async_wait_idle(self) -> None:
        """Let unloading wait without replacing the active transaction owner."""
        await self._idle.wait()

    async def async_initialize(self) -> None:
        """An interrupted save always needs a fresh check and an explicit decision."""
        try:
            saved = await self.store.async_load()
            if saved is None:
                return
            if not isinstance(saved, dict) or not isinstance(saved.get("request_id"), str):
                raise ValueError
            decode_slots(saved["before"])
            decode_slots(saved["target"], require_nonempty=True)
            if saved.get("observed") is not None:
                decode_slots(saved["observed"])
            self.record = saved
            self.backup_valid = True
            if saved.get("state") not in TERMINAL:
                self.record["state"] = "recovery_required"
                self.record["error"] = "interrupted"
        except Exception:
            self.record = {"state": "recovery_required", "error": "backup_invalid"}
            self.backup_valid = False

    def status(self) -> dict[str, Any]:
        """Return progress, without exposing the private fallback schedule."""
        return {
            "state": self.record.get("state", "idle"),
            "request_id": self.record.get("request_id"),
            "error": self.record.get("error"),
            "completed": self.record.get("completed", 0),
            "total": self.record.get("total", 0),
            "busy": self.busy,
            "can_restore": self.backup_valid
            and not self.busy
            and self.record.get("state") == "recovery_required",
        }

    def _phase(self, state: str, **values: Any) -> None:
        self.record.update(state=state, **values)
        self.coordinator.async_update_listeners()

    async def _persist(self) -> None:
        await self.store.async_save(deepcopy(self.record))

    async def _finish(self, state: str, error: str | None = None) -> dict:
        self._phase(state, error=error)
        try:
            await self._persist()
        except Exception:
            self._phase("recovery_required", error="backup_failed")
        return self.status()

    async def async_save(self, request_id: str, expected_raw: list, target_raw: list) -> dict:
        """Return status after the transaction has released its busy flag."""
        await self._async_save(request_id, expected_raw, target_raw)
        return self.status()

    async def _async_save(self, request_id: str, expected_raw: list, target_raw: list) -> dict:
        """Apply only the final slot differences, with no per-Apply REST traffic."""
        expected = decode_slots(expected_raw)
        target = decode_slots(target_raw, require_nonempty=True)
        if not request_id or len(request_id) > 64:
            raise SaveError("invalid_request")
        if request_id == self.record.get("request_id"):
            if self.record.get("expected", self.record.get("before")) != [
                slot.as_dict() for slot in expected
            ] or self.record.get("target") != [slot.as_dict() for slot in target]:
                raise SaveError("request_conflict")
            return self.status()
        if self.busy:
            raise SaveError("busy")
        if self.record.get("state") not in TERMINAL:
            raise SaveError("recovery_required")
        changes = [index for index in range(42) if expected[index] != target[index]]
        if not changes:
            raise SaveError("no_changes")
        self.busy = True
        self._idle.clear()
        self.backup_valid = False
        self.record = {
            "state": "preflight",
            "request_id": request_id,
            "total": len(changes),
            "completed": 0,
            "error": None,
            "expected": [slot.as_dict() for slot in expected],
            "target": [slot.as_dict() for slot in target],
        }
        armed = False
        try:
            async with self.client.async_transaction(), asyncio.timeout(600):
                current = await self.client.async_read_locked(fresh=True)
                if current.active_program != "own 1":
                    raise SaveError("program_changed")
                if current.slots != expected:
                    await self.coordinator.async_accept_snapshot(current)
                    raise SaveError("source_changed")
                self.record.update(
                    before=[slot.as_dict() for slot in current.slots],
                    target=[slot.as_dict() for slot in target],
                    observed=None,
                    created_at=datetime.now(UTC).isoformat(),
                    state="writing",
                )
                # This write must finish successfully before the first gateway POST.
                await self._persist()
                armed = self.backup_valid = True
                self._phase("writing")
                error = None
                try:
                    # Clear obsolete slots last; physical slot indexes never shift.
                    for index in sorted(
                        changes, key=lambda index: (not target[index].occupied, index)
                    ):
                        await self.client.async_write_slot(target[index])
                        self._phase("writing", completed=self.record["completed"] + 1)
                except EmsEspError:
                    error = "write_failed"
                self._phase("verifying")
                try:
                    actual = await self.client.async_read_locked(fresh=True)
                    self.record["observed"] = [slot.as_dict() for slot in actual.slots]
                    await self.coordinator.async_accept_snapshot(actual)
                    if actual.active_program == "own 1" and actual.slots == target:
                        return await self._finish("succeeded")
                    error = error or "verification_failed"
                except EmsEspError:
                    error = error or "read_failed"
                    self.coordinator.async_snapshot_error("verification_failed")
                return await self._finish("recovery_required", error)
        except asyncio.CancelledError:
            self._phase("recovery_required" if armed else "rejected", error="interrupted")
            raise
        except Exception as err:
            code = (
                err.code
                if isinstance(err, SaveError)
                else "backup_failed"
                if not armed and "before" in self.record
                else "save_failed"
            )
            if armed:
                return await self._finish("recovery_required", code)
            self._phase("rejected", error=code)
            return self.status()
        finally:
            self.busy = False
            self._idle.set()
            self.coordinator.async_update_listeners()

    async def async_restore(self, request_id: str) -> dict:
        """Return status after restoration has released its busy flag."""
        await self._async_restore(request_id)
        return self.status()

    async def _async_restore(self, request_id: str) -> dict:
        """Restore after consent, but refuse to overwrite newer unrelated changes."""
        if self.busy:
            raise SaveError("busy")
        if not self.status()["can_restore"] or request_id != self.record.get("request_id"):
            raise SaveError("backup_invalid")
        before = decode_slots(self.record["before"])
        target = decode_slots(self.record["target"], require_nonempty=True)
        observed = (
            decode_slots(self.record["observed"])
            if self.record.get("observed") is not None
            else None
        )
        self.busy = True
        self._idle.clear()
        try:
            async with self.client.async_transaction(), asyncio.timeout(600):
                self._phase("preflight")
                actual = await self.client.async_read_locked(fresh=True)
                if actual.active_program != "own 1":
                    raise SaveError("program_changed")
                if observed is not None:
                    if actual.slots != observed:
                        raise SaveError("recovery_conflict")
                elif any(
                    slot not in (before[index], target[index])
                    for index, slot in enumerate(actual.slots)
                ):
                    raise SaveError("recovery_conflict")
                changes = [index for index in range(42) if actual.slots[index] != before[index]]
                self.record.update(
                    state="restoring", observed=None, completed=0, total=len(changes)
                )
                await self._persist()
                self._phase("restoring")
                error = None
                try:
                    for index in sorted(
                        changes, key=lambda index: (not before[index].occupied, index)
                    ):
                        await self.client.async_write_slot(before[index])
                        self._phase("restoring", completed=self.record["completed"] + 1)
                except EmsEspError:
                    error = "restore_failed"
                self._phase("verifying")
                try:
                    final = await self.client.async_read_locked(fresh=True)
                    self.record["observed"] = [slot.as_dict() for slot in final.slots]
                    await self.coordinator.async_accept_snapshot(final)
                    if final.active_program == "own 1" and final.slots == before:
                        return await self._finish("rolled_back")
                    error = error or "verification_failed"
                except EmsEspError:
                    error = error or "read_failed"
                    self.coordinator.async_snapshot_error("verification_failed")
                return await self._finish("recovery_required", error)
        except asyncio.CancelledError:
            self._phase("recovery_required", error="interrupted")
            raise
        except Exception as err:
            code = err.code if isinstance(err, SaveError) else "restore_failed"
            return await self._finish("recovery_required", code)
        finally:
            self.busy = False
            self._idle.set()
            self.coordinator.async_update_listeners()
