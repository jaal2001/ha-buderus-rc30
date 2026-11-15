"""Coordinate complete RC30 schedule snapshots."""

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import AuthenticationError, EmsEspClient, EmsEspError, ScheduleSnapshot
from .const import DOMAIN, SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class Rc30Coordinator(DataUpdateCoordinator[ScheduleSnapshot]):
    """Retain the last good snapshot and mark entities unavailable on failure."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: EmsEspClient) -> None:
        """Poll at a deliberately modest interval."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            config_entry=entry,
            update_interval=SCAN_INTERVAL,
        )
        self.client = client

    async def _async_update_data(self) -> ScheduleSnapshot:
        """Do not include response bodies, URLs or keys in errors."""
        try:
            return await self.client.async_read_schedule()
        except AuthenticationError:
            raise ConfigEntryAuthFailed("API key rejected") from None
        except EmsEspError:
            raise UpdateFailed("Unable to verify the complete RC30 schedule") from None
