"""Verify configuration, duplicate detection and key replacement."""

from unittest.mock import patch

import pytest
from homeassistant import config_entries
from homeassistant.const import CONF_API_KEY, CONF_HOST
from homeassistant.data_entry_flow import FlowResultType

from custom_components.buderus_rc30.api import (
    AuthenticationError,
    CommunicationError,
    InvalidResponse,
)
from custom_components.buderus_rc30.const import DOMAIN

INPUT = {CONF_HOST: "ems-esp.example/", CONF_API_KEY: "test-key"}


async def test_user_flow(hass, mock_poll):
    """Validate before creating a canonicalized configuration entry."""
    with patch("custom_components.buderus_rc30.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )
        assert result["type"] is FlowResultType.FORM
        result = await hass.config_entries.flow.async_configure(result["flow_id"], INPUT)
        await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_HOST: "http://ems-esp.example", CONF_API_KEY: "test-key"}
    mock_poll.assert_awaited_once()


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (AuthenticationError(), "invalid_auth"),
        (CommunicationError(), "cannot_connect"),
        (InvalidResponse(), "invalid_response"),
        (ValueError(), "invalid_input"),
    ],
)
async def test_flow_errors(hass, mock_poll, error, expected):
    """Keep configuration open with an actionable, sanitized error."""
    mock_poll.side_effect = error
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}, data=INPUT
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": expected}


async def test_duplicate(hass, config_entry, mock_poll):
    """Do not poll or create a second entry for the same canonical origin."""
    config_entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}, data=INPUT
    )
    assert result["reason"] == "already_configured"
    mock_poll.assert_not_awaited()


async def test_reauth(hass, config_entry, mock_poll):
    """Replace an invalid key while retaining the entry and entity identities."""
    config_entry.add_to_hass(hass)
    result = await config_entry.start_reauth_flow(hass)
    await hass.async_block_till_done()
    progress = hass.config_entries.flow.async_progress()
    assert len(progress) == 1
    with patch("custom_components.buderus_rc30.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_configure(
            progress[0]["flow_id"], {CONF_API_KEY: "replacement-test-key"}
        )
        await hass.async_block_till_done()
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert config_entry.data[CONF_API_KEY] == "replacement-test-key"
    assert config_entry.unique_id == "http://ems-esp.example"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (AuthenticationError(), "invalid_auth"),
        (CommunicationError(), "cannot_connect"),
        (InvalidResponse(), "invalid_response"),
        (ValueError(), "invalid_input"),
    ],
)
async def test_reauth_keeps_old_key_on_failure(hass, config_entry, mock_poll, error, expected):
    """Do not overwrite a stored key when the replacement cannot be verified."""
    config_entry.add_to_hass(hass)
    mock_poll.side_effect = error
    await config_entry.start_reauth_flow(hass)
    await hass.async_block_till_done()
    flow = hass.config_entries.flow.async_progress()[0]
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {CONF_API_KEY: "unverified-test-key"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": expected}
    assert config_entry.data[CONF_API_KEY] == "test-key"
