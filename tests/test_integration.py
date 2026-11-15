"""Exercise real Home Assistant setup, sensors, failures, recovery and unload."""

from dataclasses import replace
from unittest.mock import patch

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers import entity_registry as er

from custom_components.buderus_rc30.api import AuthenticationError, CommunicationError


async def test_setup_sensors_failure_recovery_and_unload(hass, config_entry, mock_poll, snapshot):
    """A failed refresh preserves last-good data but makes sensor states unavailable."""
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    entities = {
        item.unique_id.rsplit("_", 1)[-1]: item.entity_id
        for item in er.async_entries_for_config_entry(registry, config_entry.entry_id)
    }
    assert len(entities) == 4
    schedule_id = next(
        item.entity_id
        for item in er.async_entries_for_config_entry(registry, config_entry.entry_id)
        if item.unique_id.endswith("_schedule")
    )
    schedule = hass.states.get(schedule_id)
    assert schedule.state == "38"
    assert schedule.attributes["free_slots"] == 4
    assert len(schedule.attributes["slots"]) == 42
    assert schedule.attributes["slots"][-1]["slot"] == "41"
    assert "test-key" not in str(schedule.attributes)
    coordinator = config_entry.runtime_data
    mock_poll.side_effect = CommunicationError("Sensitive upstream detail")
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert coordinator.data is snapshot
    assert not coordinator.last_update_success
    assert all(
        hass.states.get(entity_id).state == STATE_UNAVAILABLE for entity_id in entities.values()
    )
    mock_poll.side_effect = None
    mock_poll.return_value = replace(snapshot, active_program="own 2")
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(schedule_id).state == "38"
    assert hass.states.get(schedule_id).attributes["schedule_program"] == "own 1"
    assert hass.states.get(schedule_id).attributes["active_program"] == "own 2"
    assert await hass.config_entries.async_unload(config_entry.entry_id)
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.NOT_LOADED
    assert not coordinator.async_update_listeners()


async def test_first_poll_failure_retries(hass, config_entry, mock_poll):
    """Do not install sensors with a partial or missing initial snapshot."""
    mock_poll.side_effect = CommunicationError()
    config_entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(config_entry.entry_id)
    assert config_entry.state is ConfigEntryState.SETUP_RETRY
    assert not er.async_entries_for_config_entry(er.async_get(hass), config_entry.entry_id)


async def test_auth_failure_requests_reauth(hass, config_entry, mock_poll):
    """A rejected key requires reauthentication rather than endless polling."""
    mock_poll.side_effect = AuthenticationError()
    config_entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.SETUP_ERROR
    assert len(hass.config_entries.flow.async_progress()) == 1


async def test_coordinator_error_sanitization(hass, config_entry, mock_poll):
    """Coordinator errors must not expose upstream exceptions."""
    from homeassistant.helpers.update_coordinator import UpdateFailed

    from custom_components.buderus_rc30.coordinator import Rc30Coordinator

    with patch("custom_components.buderus_rc30.api.EmsEspClient") as client:
        client.async_read_schedule = mock_poll
        coordinator = Rc30Coordinator(hass, config_entry, client)
        mock_poll.side_effect = CommunicationError("test-key private-host")
        with pytest.raises(UpdateFailed) as caught:
            await coordinator._async_update_data()
        assert "test-key" not in str(caught.value)
        mock_poll.side_effect = AuthenticationError("test-key private-host")
        with pytest.raises(ConfigEntryAuthFailed):
            await coordinator._async_update_data()
