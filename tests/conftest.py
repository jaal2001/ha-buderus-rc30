"""Shared synthetic test data; no private gateway data is used."""

from datetime import UTC, datetime
from functools import partial
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from aiohttp import ClientResponse
from homeassistant.const import CONF_API_KEY, CONF_HOST
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.buderus_rc30.api import ScheduleSlot, ScheduleSnapshot
from custom_components.buderus_rc30.const import DOMAIN


@pytest.fixture(autouse=True)
def response_constructor_compatibility(monkeypatch):
    """Supply aiohttp 3.14's new writer argument missing in aioresponses 0.7.9."""
    monkeypatch.setattr(
        "aioresponses.core.ClientResponse",
        partial(ClientResponse, stream_writer=SimpleNamespace(output_size=0)),
    )


@pytest.fixture(autouse=True)
def custom_integrations(enable_custom_integrations):
    """Allow Home Assistant to load the integration under test."""


@pytest.fixture
def snapshot():
    """Represent 38 occupied slots and four empty ones."""
    return ScheduleSnapshot(
        tuple(
            ScheduleSlot(index, "mo", "09:30", "off") if index < 38 else ScheduleSlot(index)
            for index in range(42)
        ),
        "own 1",
        datetime(2026, 1, 1, tzinfo=UTC),
    )


@pytest.fixture
def config_entry():
    """Return fake, non-sensitive credentials."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Buderus RC30 Schedule",
        unique_id="http://ems-esp.example",
        data={CONF_HOST: "http://ems-esp.example", CONF_API_KEY: "test-key"},
    )


@pytest.fixture
def mock_poll(snapshot):
    """Mock only the transport-facing poll for Home Assistant lifecycle tests."""
    with patch(
        "custom_components.buderus_rc30.api.EmsEspClient.async_read_schedule",
        new_callable=AsyncMock,
        return_value=snapshot,
    ) as mock:
        yield mock
