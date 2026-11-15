"""Read-only Buderus RC30 schedule through EMS-ESP."""

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_KEY, CONF_HOST, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import EmsEspClient
from .coordinator import Rc30Coordinator

PLATFORMS = [Platform.SENSOR]
type Rc30ConfigEntry = ConfigEntry[Rc30Coordinator]


async def async_setup_entry(hass: HomeAssistant, entry: Rc30ConfigEntry) -> bool:
    """Set up only after the first complete verified schedule is available."""
    client = EmsEspClient(
        async_get_clientsession(hass), entry.data[CONF_HOST], entry.data[CONF_API_KEY]
    )
    coordinator = Rc30Coordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: Rc30ConfigEntry) -> bool:
    """Unload platforms; the coordinator then removes its polling listener."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
