"""Exercise durable backups and partial writes using a synthetic in-memory gateway."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from custom_components.buderus_rc30.api import (
    CommunicationError,
    InvalidResponse,
    ScheduleSlot,
    ScheduleSnapshot,
    decode_slots,
)
from custom_components.buderus_rc30.writer import SaveError, ScheduleWriter


class Gateway:
    """Model a non-atomic gateway without any network access."""

    def __init__(self):
        self.slots = tuple(
            [ScheduleSlot(0, "mo", "06:00", "on"), ScheduleSlot(1, "mo", "09:00", "off")]
            + [ScheduleSlot(index) for index in range(2, 42)]
        )
        self.program = "own 1"
        self.reads = 0
        self.writes = []
        self.actions = []
        self.fail_reads = set()
        self.lock = asyncio.Lock()
        self.before_write = None

    @asynccontextmanager
    async def async_transaction(self):
        async with self.lock:
            yield

    async def async_read_locked(self, *, fresh=False):
        assert fresh
        self.reads += 1
        if self.reads in self.fail_reads:
            raise CommunicationError("Secret transport detail")
        return ScheduleSnapshot(self.slots, self.program, datetime.now(UTC))

    async def async_write_slot(self, slot):
        if self.before_write:
            await self.before_write()
        self.writes.append(slot)
        action = self.actions.pop(0) if self.actions else "apply"
        if action == "fail":
            raise CommunicationError("Secret transport detail")
        if action != "ignore":
            self.slots = tuple(slot if item.index == slot.index else item for item in self.slots)
        if action == "timeout_applied":
            raise CommunicationError("Secret transport detail")


@pytest.fixture
def setup_writer(hass):
    gateway = Gateway()
    coordinator = SimpleNamespace(
        client=gateway,
        async_update_listeners=Mock(),
        async_set_updated_data=Mock(),
        async_set_update_error=Mock(),
    )
    writer = ScheduleWriter(hass, "synthetic-entry", coordinator)
    before = [slot.as_dict() for slot in gateway.slots]
    target = deepcopy(before)
    target[0]["time"] = "07:00"
    target[1]["time"] = "10:00"
    return writer, gateway, before, target


async def test_save_has_two_reads_diff_only_and_durable_backup(setup_writer):
    writer, gateway, before, target = setup_writer

    async def check_backup():
        saved = await writer.store.async_load()
        assert saved["before"] == before
        assert saved["target"] == target
        assert saved["state"] == "writing"
        assert "test-key" not in str(saved)

    gateway.before_write = check_backup
    result = await writer.async_save("request-1", before, target)
    assert result["state"] == "succeeded" and not result["busy"]
    assert gateway.reads == 2
    assert [slot.index for slot in gateway.writes] == [0, 1]
    assert [slot.as_dict() for slot in gateway.slots] == target
    assert (await writer.store.async_load())["state"] == "succeeded"
    assert "before" not in result and "target" not in result


async def test_partial_failure_never_rolls_back_automatically(setup_writer):
    writer, gateway, before, target = setup_writer
    gateway.actions = ["apply", "fail"]
    result = await writer.async_save("request-1", before, target)
    assert result["state"] == "recovery_required" and result["can_restore"]
    assert gateway.reads == 2 and len(gateway.writes) == 2
    assert gateway.slots[0].time == "07:00" and gateway.slots[1].time == "09:00"
    assert "Secret" not in str(result)
    with pytest.raises(SaveError, match="recovery_required"):
        await writer.async_save("request-2", before, target)
    assert len(gateway.writes) == 2
    result = await writer.async_restore("request-1")
    assert result["state"] == "rolled_back" and not result["busy"]
    assert gateway.reads == 4
    assert [slot.index for slot in gateway.writes] == [0, 1, 0]
    assert [slot.as_dict() for slot in gateway.slots] == before


async def test_lost_write_ack_can_still_verify_success(setup_writer):
    writer, gateway, before, target = setup_writer
    target[1] = deepcopy(before[1])
    gateway.actions = ["timeout_applied"]
    result = await writer.async_save("request-1", before, target)
    assert result["state"] == "succeeded"
    assert gateway.reads == 2 and len(gateway.writes) == 1


async def test_backup_failure_prevents_all_writes(setup_writer):
    writer, gateway, before, target = setup_writer
    writer.store.async_save = AsyncMock(side_effect=OSError("Secret path"))
    result = await writer.async_save("request-1", before, target)
    assert result["state"] == "rejected" and result["error"] == "backup_failed"
    assert not gateway.writes and gateway.reads == 1


@pytest.mark.parametrize("changed", ["source", "program"])
async def test_preflight_conflicts_prevent_writes(setup_writer, changed):
    writer, gateway, before, target = setup_writer
    if changed == "source":
        gateway.slots = (replace(gateway.slots[0], time="05:00"), *gateway.slots[1:])
    else:
        gateway.program = "own 2"
    result = await writer.async_save("request-1", before, target)
    assert result["error"] == ("source_changed" if changed == "source" else "program_changed")
    assert not gateway.writes and gateway.reads == 1


async def test_request_id_is_idempotent_and_payload_bound(setup_writer):
    writer, gateway, before, target = setup_writer
    await writer.async_save("request-1", before, target)
    await writer.async_save("request-1", before, target)
    assert gateway.reads == 2 and len(gateway.writes) == 2
    target[0]["time"] = "08:00"
    with pytest.raises(SaveError, match="request_conflict"):
        await writer.async_save("request-1", before, target)


async def test_failed_verification_survives_restart_and_requires_consent(setup_writer, hass):
    writer, gateway, before, target = setup_writer
    gateway.fail_reads = {2}
    await writer.async_save("request-1", before, target)
    restored = ScheduleWriter(hass, "synthetic-entry", writer.coordinator)
    await restored.async_initialize()
    assert restored.status()["can_restore"]
    assert len(gateway.writes) == 2
    assert restored.status()["error"] == "interrupted"
    result = await restored.async_restore("request-1")
    assert result["state"] == "rolled_back" and len(gateway.writes) == 4


@pytest.mark.parametrize("known", [True, False])
async def test_restore_refuses_new_external_changes(setup_writer, known):
    writer, gateway, before, target = setup_writer
    gateway.actions = ["apply", "fail"]
    if not known:
        gateway.fail_reads = {2}
    await writer.async_save("request-1", before, target)
    gateway.slots = (replace(gateway.slots[0], time="08:00"), *gateway.slots[1:])
    result = await writer.async_restore("request-1")
    assert result["error"] == "recovery_conflict" and len(gateway.writes) == 2
    assert result["can_restore"]


async def test_restore_failure_preserves_backup(setup_writer):
    writer, gateway, before, target = setup_writer
    gateway.actions = ["apply", "fail"]
    await writer.async_save("request-1", before, target)
    gateway.actions = ["fail"]
    result = await writer.async_restore("request-1")
    assert result["state"] == "recovery_required" and result["can_restore"]
    assert (await writer.store.async_load())["before"] == before


async def test_concurrent_save_is_refused_and_cancellation_leaves_recovery(setup_writer, hass):
    writer, gateway, before, target = setup_writer
    started, release = asyncio.Event(), asyncio.Event()

    async def pause():
        started.set()
        await release.wait()

    gateway.before_write = pause
    task = asyncio.create_task(writer.async_save("request-1", before, target))
    await started.wait()
    assert writer.busy
    with pytest.raises(SaveError, match="busy"):
        await writer.async_save("request-2", before, target)
    # Replaying the same request queries status; it cannot create another writer.
    assert (await writer.async_save("request-1", before, target))["busy"]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    restored = ScheduleWriter(hass, "synthetic-entry", writer.coordinator)
    await restored.async_initialize()
    assert restored.status()["can_restore"] and not writer.busy
    assert not gateway.writes


async def test_corrupt_backup_blocks_new_saves(setup_writer):
    writer, gateway, before, target = setup_writer
    writer.store.async_load = AsyncMock(return_value={"state": "writing", "before": []})
    await writer.async_initialize()
    assert writer.status()["error"] == "backup_invalid"
    with pytest.raises(SaveError, match="recovery_required"):
        await writer.async_save("request-1", before, target)
    assert not gateway.writes


@pytest.mark.parametrize("mutation", ["empty", "count", "index", "time", "conflict", "occupied"])
async def test_untrusted_schedule_is_rejected_before_any_requests(setup_writer, mutation):
    writer, gateway, before, target = setup_writer
    if mutation == "empty":
        target = [ScheduleSlot(index).as_dict() for index in range(42)]
    elif mutation == "count":
        target.pop()
    elif mutation == "index":
        target[0]["slot"] = "41"
    elif mutation == "time":
        target[0]["time"] = "07:01"
    elif mutation == "conflict":
        target[1]["time"] = target[0]["time"]
    else:
        target[0]["occupied"] = False
    with pytest.raises((ValueError, InvalidResponse)):
        await writer.async_save("request-1", before, target)
    assert not gateway.writes and gateway.reads == 0


def test_decoder_normalizes_physical_order(setup_writer):
    _, _, before, _ = setup_writer
    assert decode_slots(before[::-1]) == decode_slots(before)


async def test_acknowledgment_without_changed_device_data_is_not_success(setup_writer):
    writer, gateway, before, target = setup_writer
    gateway.actions = ["ignore", "ignore"]
    result = await writer.async_save("request-1", before, target)
    assert result["state"] == "recovery_required"
    assert result["error"] == "verification_failed"
    assert gateway.reads == 2 and len(gateway.writes) == 2
    assert [slot.as_dict() for slot in gateway.slots] == before


async def test_final_storage_failure_never_reports_clean_success(setup_writer):
    writer, gateway, before, target = setup_writer
    persist = writer.store.async_save
    calls = 0

    async def fail_final(record):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise OSError("Secret path")
        await persist(record)

    writer.store.async_save = fail_final
    result = await writer.async_save("request-1", before, target)
    assert result["state"] == "recovery_required" and result["error"] == "backup_failed"
    assert result["can_restore"]
    assert (await writer.store.async_load())["before"] == before
