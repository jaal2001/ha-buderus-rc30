"""Verify manual-only reads and durable, timestamp-preserving schedule storage."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.buderus_rc30.api import AuthenticationError, CommunicationError
from custom_components.buderus_rc30.coordinator import Rc30Coordinator
from custom_components.buderus_rc30.writer import SaveError


async def test_no_scheduled_reads_even_after_multiple_days(hass, config_entry, mock_poll):
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    coordinator = config_entry.runtime_data
    assert coordinator.update_interval is None
    for hours in (1, 24, 72):
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(hours=hours))
        await hass.async_block_till_done()
    mock_poll.assert_awaited_once_with(fresh=True)


async def test_reload_uses_disk_cache_without_gateway_reads(
    hass, config_entry, mock_poll, snapshot
):
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    old = config_entry.runtime_data
    saved = await old.cache.async_load()
    assert saved["verified_at"] == snapshot.fetched_at.isoformat()
    assert "test-key" not in str(saved)
    mock_poll.reset_mock()
    mock_poll.side_effect = AssertionError("Restart must not query the heater")
    assert await hass.config_entries.async_reload(config_entry.entry_id)
    await hass.async_block_till_done()
    coordinator = config_entry.runtime_data
    assert coordinator is not old
    assert coordinator.data == snapshot
    assert coordinator.schedule_source == "stored"
    mock_poll.assert_not_awaited()
    entity = next(
        item.entity_id
        for item in er.async_entries_for_config_entry(er.async_get(hass), config_entry.entry_id)
        if item.unique_id.endswith("_schedule")
    )
    assert hass.states.get(entity).attributes["verified_at"] == snapshot.fetched_at.isoformat()
    assert hass.states.get(entity).attributes["automatic_polling"] is False


async def test_explicit_refresh_reads_once_and_updates_persistent_plan(
    hass, config_entry, mock_poll, snapshot
):
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    changed = replace(snapshot, active_program="own 2", fetched_at=dt_util.utcnow())
    mock_poll.reset_mock()
    mock_poll.return_value = changed
    await config_entry.runtime_data.async_refresh_schedule()
    mock_poll.assert_awaited_once_with(fresh=True)
    saved = await config_entry.runtime_data.cache.async_load()
    assert saved["active_program"] == "own 2"
    assert saved["verified_at"] == changed.fetched_at.isoformat()
    assert not config_entry.runtime_data.refreshing


@pytest.mark.parametrize("error", [CommunicationError("secret"), AuthenticationError("secret")])
async def test_failed_manual_refresh_keeps_timestamp_and_never_retries(
    hass, config_entry, mock_poll, snapshot, error
):
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    mock_poll.reset_mock()
    mock_poll.side_effect = error
    coordinator = config_entry.runtime_data
    with pytest.raises(SaveError, match="refresh_failed"):
        await coordinator.async_refresh_schedule()
    assert coordinator.data is snapshot
    assert coordinator.data.fetched_at == snapshot.fetched_at
    assert not coordinator.refreshing
    assert "secret" not in str(coordinator.refresh_error)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(days=2))
    await hass.async_block_till_done()
    mock_poll.assert_awaited_once_with(fresh=True)


@pytest.mark.parametrize("saved", [{"slots": []}, {"slots": "bad"}, "invalid"])
async def test_corrupt_cache_requires_a_real_read(hass, config_entry, saved):
    coordinator = Rc30Coordinator(hass, config_entry, AsyncMock())
    await coordinator.cache.async_save(saved)
    assert not await coordinator.async_initialize_cache()
    assert coordinator.data is None


async def test_storage_failure_preserves_verified_memory_without_faking_persistence(
    hass, config_entry, snapshot
):
    coordinator = Rc30Coordinator(hass, config_entry, AsyncMock())
    coordinator.cache.async_save = AsyncMock(side_effect=OSError("private path"))
    await coordinator.async_accept_snapshot(snapshot)
    assert coordinator.data is snapshot
    assert coordinator.cache_error


async def test_refresh_rejects_overlapping_clicks_and_live_save(hass, config_entry, mock_poll):
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    coordinator = config_entry.runtime_data
    mock_poll.reset_mock()
    coordinator.writer.busy = True
    with pytest.raises(SaveError, match="busy"):
        await coordinator.async_refresh_schedule()
    coordinator.writer.busy = False
    started, release = asyncio.Event(), asyncio.Event()
    original = coordinator.data

    async def pause(**kwargs):
        started.set()
        await release.wait()
        return original

    mock_poll.side_effect = pause
    task = asyncio.create_task(coordinator.async_refresh_schedule())
    await started.wait()
    with pytest.raises(SaveError, match="busy"):
        await coordinator.async_refresh_schedule()
    release.set()
    await task
    mock_poll.assert_awaited_once_with(fresh=True)


async def test_save_readback_is_persisted_without_additional_scan(hass, config_entry, snapshot):
    target = replace(snapshot.slots[0], time="08:30")
    final = replace(snapshot, slots=(target, *snapshot.slots[1:]), fetched_at=dt_util.utcnow())

    @asynccontextmanager
    async def transaction():
        yield

    client = AsyncMock()
    client.async_transaction = transaction
    client.async_read_locked.side_effect = [snapshot, final]
    coordinator = Rc30Coordinator(hass, config_entry, client)
    await coordinator.async_accept_snapshot(snapshot)
    result = await coordinator.writer.async_save(
        "request",
        [slot.as_dict() for slot in snapshot.slots],
        [slot.as_dict() for slot in final.slots],
    )
    assert result["state"] == "succeeded"
    assert client.async_read_locked.await_count == 2
    client.async_write_slot.assert_awaited_once_with(target)
    restored = Rc30Coordinator(hass, config_entry, client)
    assert await restored.async_initialize_cache()
    assert restored.data == final
    assert client.async_read_locked.await_count == 2
