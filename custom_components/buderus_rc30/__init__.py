"""Buderus RC30 schedule through EMS-ESP with explicit, verified saves."""

from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_KEY, CONF_HOST, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .api import EmsEspClient
from .const import CARD_PATH, DOMAIN
from .coordinator import Rc30Coordinator
from .frontend import async_register_card
from .websocket import async_register_commands

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
type Rc30ConfigEntry = ConfigEntry[Rc30Coordinator]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve and register the bundled card, once per integration setup."""
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                CARD_PATH,
                str(Path(__file__).parent / "www" / "buderus-rc30-schedule-card.js"),
                False,
            )
        ]
    )
    async_register_commands(hass)
    integration = await async_get_integration(hass, DOMAIN)
    await async_register_card(hass, str(integration.version))
    return True


async def async_setup_entry(hass: HomeAssistant, entry: Rc30ConfigEntry) -> bool:
    """Set up only after the first complete verified schedule is available."""
    client = EmsEspClient(
        async_get_clientsession(hass), entry.data[CONF_HOST], entry.data[CONF_API_KEY]
    )
    coordinator = Rc30Coordinator(hass, entry, client)
    await coordinator.writer.async_initialize()
    if not await coordinator.async_initialize_cache():
        await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: Rc30ConfigEntry) -> bool:
    """Unload platforms; the coordinator then removes its polling listener."""
    await entry.runtime_data.writer.async_wait_idle()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
