"""Configure an EMS-ESP hostname and API key through Home Assistant."""

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.const import CONF_API_KEY, CONF_HOST
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import AuthenticationError, EmsEspClient, EmsEspError, InvalidResponse, normalize_host
from .const import DOMAIN, NAME


class Rc30ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Validate one complete snapshot before storing an entry."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Show credentials as a password field and avoid echoing them on errors."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                host = normalize_host(user_input[CONF_HOST])
                await self.async_set_unique_id(host)
                self._abort_if_unique_id_configured()
                client = EmsEspClient(
                    async_get_clientsession(self.hass), host, user_input[CONF_API_KEY]
                )
                await client.async_read_schedule()
            except ValueError:
                errors["base"] = "invalid_input"
            except AuthenticationError:
                errors["base"] = "invalid_auth"
            except InvalidResponse:
                errors["base"] = "invalid_response"
            except EmsEspError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(
                    title=NAME,
                    data={CONF_HOST: host, CONF_API_KEY: user_input[CONF_API_KEY].strip()},
                )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_API_KEY): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                    ),
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: dict[str, Any]):
        """Allow replacing an expired key without changing the gateway."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None):
        """Check the replacement key before updating and reloading the entry."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                client = EmsEspClient(
                    async_get_clientsession(self.hass),
                    entry.data[CONF_HOST],
                    user_input[CONF_API_KEY],
                )
                await client.async_read_schedule()
            except ValueError:
                errors["base"] = "invalid_input"
            except AuthenticationError:
                errors["base"] = "invalid_auth"
            except InvalidResponse:
                errors["base"] = "invalid_response"
            except EmsEspError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_API_KEY: user_input[CONF_API_KEY].strip()}
                )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_API_KEY): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                    )
                }
            ),
            errors=errors,
        )
