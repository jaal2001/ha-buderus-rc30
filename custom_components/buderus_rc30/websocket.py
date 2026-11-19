"""Authenticated admin commands for explicit schedule saves and recovery."""

from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .api import EmsEspError
from .const import DOMAIN
from .writer import SaveError, ScheduleWriter


def _writer(hass: HomeAssistant, entity_id: str) -> ScheduleWriter:
    """Resolve the registry owner, never client-supplied entity attributes."""
    entity = er.async_get(hass).async_get(entity_id)
    if (
        entity is None
        or entity.platform != DOMAIN
        or entity.domain != "sensor"
        or not entity.unique_id.endswith("_schedule")
        or not entity.config_entry_id
    ):
        raise SaveError("wrong_entity")
    entry = hass.config_entries.async_get_entry(entity.config_entry_id)
    if entry is None or entry.domain != DOMAIN or entry.state is not ConfigEntryState.LOADED:
        raise SaveError("not_ready")
    return entry.runtime_data.writer


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register once during integration setup."""
    for command in (ws_save, ws_status, ws_restore, ws_refresh):
        websocket_api.async_register_command(hass, command)


async def _execute(hass, connection, msg, operation: str) -> None:
    """Keep errors stable and leave background transactions running on disconnect."""
    try:
        writer = _writer(hass, msg["entity_id"])
        if operation != "status" and msg.get("confirmed") is not True:
            raise SaveError("confirmation_required")
        if operation == "save":
            await writer.async_save(msg["request_id"], msg["expected_slots"], msg["slots"])
        elif operation == "restore":
            await writer.async_restore(msg["request_id"])
        connection.send_result(msg["id"], writer.status())
    except SaveError as err:
        connection.send_error(msg["id"], err.code, "Schedule operation was refused")
    except ValueError, EmsEspError:
        connection.send_error(msg["id"], "invalid_schedule", "Invalid schedule")


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): "buderus_rc30/save",
        probatio.Required("entity_id"): str,
        probatio.Required("request_id"): str,
        probatio.Required("expected_slots"): [dict],
        probatio.Required("slots"): [dict],
        probatio.Required("confirmed"): bool,
    }
)
@websocket_api.async_response
async def ws_save(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Apply a complete final draft, after explicit confirmation."""
    await _execute(hass, connection, msg, "save")


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): "buderus_rc30/save_status",
        probatio.Required("entity_id"): str,
    }
)
@websocket_api.async_response
async def ws_status(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Query local progress without any gateway REST requests."""
    await _execute(hass, connection, msg, "status")


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): "buderus_rc30/restore",
        probatio.Required("entity_id"): str,
        probatio.Required("request_id"): str,
        probatio.Required("confirmed"): bool,
    }
)
@websocket_api.async_response
async def ws_restore(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Restore a durable fallback only after a separate explicit confirmation."""
    await _execute(hass, connection, msg, "restore")


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): "buderus_rc30/refresh",
        probatio.Required("entity_id"): str,
    }
)
@websocket_api.async_response
async def ws_refresh(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Explicitly read all slots, without changing the draft or writing any slot."""
    try:
        writer = _writer(hass, msg["entity_id"])
        await writer.coordinator.async_refresh_schedule()
        connection.send_result(msg["id"], {"refreshed": True})
    except SaveError as err:
        connection.send_error(msg["id"], err.code, "Schedule refresh could not be completed")
