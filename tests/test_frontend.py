"""Verify real frontend registration, upgrades and legacy resource migration."""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, add_extra_js_url
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.exceptions import HomeAssistantError
from homeassistant.loader import async_get_integration
from homeassistant.setup import async_setup_component

from custom_components.buderus_rc30 import async_setup
from custom_components.buderus_rc30.const import CARD_PATH
from custom_components.buderus_rc30.frontend import async_register_card

VERSION = "test-version"
MODULE_URL = f"{CARD_PATH}?v={VERSION}"


@pytest.fixture
async def frontend_setup(hass):
    """Use actual Home Assistant frontend and Lovelace collections."""
    assert await async_setup_component(hass, "frontend", {})
    return hass.data[DATA_EXTRA_MODULE_URL]


async def test_static_card_registration(hass, frontend_setup):
    """Serve one file and automatically register the installed manifest version."""
    with patch.object(hass.http, "async_register_static_paths", new_callable=AsyncMock) as paths:
        assert await async_setup(hass, {})
    configs = paths.call_args.args[0]
    assert len(configs) == 1
    assert configs[0].url_path == CARD_PATH
    path = Path(configs[0].path)
    assert path.name == "buderus-rc30-schedule-card.js"
    assert await hass.async_add_executor_job(path.is_file)
    assert configs[0].cache_headers is False
    integration = await async_get_integration(hass, "buderus_rc30")
    assert f"{CARD_PATH}?v={integration.version}" in frontend_setup.urls


async def test_registration_is_idempotent(hass, frontend_setup):
    """Repeated registration must not create duplicate modules or change callbacks."""
    await async_register_card(hass, VERSION)
    with patch.object(frontend_setup, "add") as add:
        await async_register_card(hass, VERSION)
        add.assert_not_called()
    assert frontend_setup.urls == frozenset({MODULE_URL})


async def test_upgrade_replaces_only_owned_module_urls(hass, frontend_setup):
    """Refresh the version query without touching unrelated or remote modules."""
    external = f"https://example.test{CARD_PATH}"
    add_extra_js_url(hass, f"{CARD_PATH}?v=0.4.0")
    add_extra_js_url(hass, CARD_PATH)
    add_extra_js_url(hass, "/other-card.js")
    add_extra_js_url(hass, external)
    await async_register_card(hass, VERSION)
    assert frontend_setup.urls == frozenset({MODULE_URL, "/other-card.js", external})


async def test_old_manual_resources_are_removed(hass, frontend_setup):
    """Migrate our manual entries to automatic loading, preserving unrelated entries."""
    resources = hass.data[LOVELACE_DATA].resources
    await resources.async_create_item({"url": CARD_PATH, "res_type": "module"})
    await resources.async_create_item({"url": f"{CARD_PATH}?v=0.4.0", "res_type": "module"})
    other = await resources.async_create_item({"url": "/other-card.js", "res_type": "module"})
    remote = await resources.async_create_item(
        {"url": f"https://example.test{CARD_PATH}", "res_type": "module"}
    )
    await async_register_card(hass, VERSION)
    assert resources.async_items() == [other, remote]
    assert MODULE_URL in frontend_setup.urls
    await async_register_card(hass, VERSION)
    assert resources.async_items() == [other, remote]


async def test_loading_failure_does_not_prevent_automatic_module(hass, frontend_setup, caplog):
    """A storage error during migration must not stop the card or expose raw errors."""
    resources = hass.data[LOVELACE_DATA].resources
    with patch.object(
        resources, "async_get_info", side_effect=HomeAssistantError("private-detail")
    ):
        await async_register_card(hass, VERSION)
    assert MODULE_URL in frontend_setup.urls
    assert "old manual resource entries could not be removed" in caplog.text
    assert "private-detail" not in caplog.text


async def test_yaml_resources_load_card_without_editing_configuration(hass):
    """The frontend module API works with YAML resource mode as well."""
    configured = [
        {"url": "/other-card.js", "type": "module"},
        {"url": f"{CARD_PATH}?v=0.4.0", "type": "module"},
    ]
    assert await async_setup_component(
        hass, "frontend", {"lovelace": {"resource_mode": "yaml", "resources": configured}}
    )
    resources = hass.data[LOVELACE_DATA].resources
    before = [dict(item) for item in resources.async_items()]
    await async_register_card(hass, VERSION)
    assert hass.data[LOVELACE_DATA].resource_mode == "yaml"
    assert resources.async_items() == before
    assert MODULE_URL in hass.data[DATA_EXTRA_MODULE_URL].urls
