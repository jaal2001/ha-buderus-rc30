"""Check registry ownership, admin checks and explicit save/restore consent."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from homeassistant.exceptions import Unauthorized
from homeassistant.helpers import entity_registry as er

from custom_components.buderus_rc30.websocket import ws_restore, ws_save, ws_status
from custom_components.buderus_rc30.writer import SaveError


@pytest.fixture
async def loaded(hass, config_entry, mock_poll):
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    entity = next(
        item.entity_id
        for item in er.async_entries_for_config_entry(er.async_get(hass), config_entry.entry_id)
        if item.unique_id.endswith("_schedule")
    )
    return entity, config_entry.runtime_data.writer


async def invoke(hass, command, message, *, admin=True):
    """Run the actual command decorators and schema without opening a TCP port."""
    result = asyncio.get_running_loop().create_future()
    connection = SimpleNamespace(
        user=SimpleNamespace(is_admin=admin),
        send_result=lambda _, data: result.set_result(("result", data)),
        send_error=lambda _, code, text: result.set_result(("error", code, text)),
        async_handle_exception=lambda _, err: result.set_exception(err),
    )
    command(hass, connection, command._ws_schema(message))
    return await asyncio.wait_for(result, 2)


async def test_status_is_local_and_excludes_backup(hass, loaded):
    entity, writer = loaded
    result = await invoke(
        hass, ws_status, {"id": 1, "type": "buderus_rc30/save_status", "entity_id": entity}
    )
    assert result == ("result", writer.status())
    assert "before" not in result[1]


@pytest.mark.parametrize("command", [ws_save, ws_restore, ws_status])
async def test_all_commands_require_admin(hass, loaded, command):
    entity, writer = loaded
    writer.async_save = AsyncMock()
    message = {"id": 1, "type": command._ws_command, "entity_id": entity}
    if command is not ws_status:
        message.update(request_id="test", confirmed=True)
    if command is ws_save:
        message.update(expected_slots=[], slots=[])
    with pytest.raises(Unauthorized):
        await invoke(hass, command, message, admin=False)
    writer.async_save.assert_not_awaited()


@pytest.mark.parametrize("command", [ws_save, ws_restore])
async def test_explicit_confirmation_is_required(hass, loaded, command):
    entity, writer = loaded
    writer.async_save = AsyncMock()
    writer.async_restore = AsyncMock()
    message = {
        "id": 1,
        "type": command._ws_command,
        "entity_id": entity,
        "request_id": "test",
        "confirmed": False,
    }
    if command is ws_save:
        message.update(expected_slots=[], slots=[])
    result = await invoke(hass, command, message)
    assert result[1] == "confirmation_required"
    writer.async_save.assert_not_awaited()
    writer.async_restore.assert_not_awaited()


async def test_save_resolves_real_registry_owner(hass, loaded):
    entity, writer = loaded
    writer.async_save = AsyncMock()
    result = await invoke(
        hass,
        ws_save,
        {
            "id": 1,
            "type": "buderus_rc30/save",
            "entity_id": entity,
            "request_id": "test",
            "confirmed": True,
            "expected_slots": [],
            "slots": [],
        },
    )
    assert result == ("result", writer.status())
    writer.async_save.assert_awaited_once_with("test", [], [])


async def test_fake_or_wrong_sensor_cannot_redirect_writes(hass, loaded):
    _, writer = loaded
    writer.async_save = AsyncMock()
    hass.states.async_set("sensor.fake", "2", {"heating_circuit": 1, "schedule_program": "own 1"})
    result = await invoke(
        hass, ws_status, {"id": 1, "type": "buderus_rc30/save_status", "entity_id": "sensor.fake"}
    )
    assert result[1] == "wrong_entity"
    writer.async_save.assert_not_awaited()


async def test_error_text_is_sanitized(hass, loaded):
    entity, writer = loaded
    writer.async_restore = AsyncMock(side_effect=SaveError("recovery_conflict"))
    result = await invoke(
        hass,
        ws_restore,
        {
            "id": 1,
            "type": "buderus_rc30/restore",
            "entity_id": entity,
            "request_id": "test",
            "confirmed": True,
        },
    )
    assert result[1] == "recovery_conflict"
    assert result[2] == "Schedule operation was refused"


async def test_invalid_full_schedule_is_rejected_by_real_backend(hass, loaded):
    entity, writer = loaded
    result = await invoke(
        hass,
        ws_save,
        {
            "id": 1,
            "type": "buderus_rc30/save",
            "entity_id": entity,
            "request_id": "test",
            "confirmed": True,
            "expected_slots": [],
            "slots": [],
        },
    )
    assert result[1] == "invalid_schedule"
    assert writer.status()["state"] == "idle"
