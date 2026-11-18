"""Load the bundled card automatically through Home Assistant's frontend API."""

import logging

from homeassistant.components.frontend import (
    DATA_EXTRA_MODULE_URL,
    add_extra_js_url,
    remove_extra_js_url,
)
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from yarl import URL

from .const import CARD_PATH

_LOGGER = logging.getLogger(__name__)


def _is_card_url(value: object) -> bool:
    """Match only this integration's local path, regardless of version query."""
    if not isinstance(value, str):
        return False
    try:
        url = URL(value)
        return not url.scheme and not url.host and url.path == CARD_PATH
    except ValueError, UnicodeError:
        return False


async def async_register_card(hass: HomeAssistant, version: str) -> None:
    """Register one current module URL for both storage and YAML dashboards."""
    module_url = str(URL(CARD_PATH).with_query(v=version))
    modules = hass.data[DATA_EXTRA_MODULE_URL]
    for existing in tuple(modules.urls):
        if _is_card_url(existing) and existing != module_url:
            remove_extra_js_url(hass, existing)
    if module_url not in modules.urls:
        add_extra_js_url(hass, module_url)

    # Old manual entries would otherwise load another URL for the same card.
    # YAML configuration files are user-owned and must remain unchanged.
    resources = hass.data[LOVELACE_DATA].resources
    if isinstance(resources, ResourceStorageCollection):
        try:
            await resources.async_get_info()
            for resource in resources.async_items():
                if _is_card_url(resource.get("url")):
                    await resources.async_delete_item(resource["id"])
        except HomeAssistantError, OSError:
            _LOGGER.warning(
                "The RC30 card is registered, but old manual resource entries could not be removed"
            )
