"""Keep a durable schedule; read the gateway only on explicit requests."""

import logging
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from hmac import compare_digest
from time import monotonic

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import AuthenticationError, EmsEspClient, EmsEspError, ScheduleSnapshot, decode_slots
from .const import DOMAIN
from .writer import SaveError, ScheduleWriter

_LOGGER = logging.getLogger(__name__)

_VALIDATED_KEY = f"{DOMAIN}_validated_schedule"
_VALIDATED_TTL = 60


@callback
def async_remember_validated_schedule(
    hass: HomeAssistant, host: str, api_key: str, snapshot: ScheduleSnapshot
) -> None:
    """Hand a just-validated snapshot to setup without retaining the API key."""
    now = monotonic()
    pending = hass.data.setdefault(_VALIDATED_KEY, {})
    for origin, (_, created, _) in tuple(pending.items()):
        if now - created > _VALIDATED_TTL:
            pending.pop(origin)
    pending[host] = (sha256(api_key.strip().encode()).digest(), now, snapshot)


@callback
def async_take_validated_schedule(
    hass: HomeAssistant, host: str, api_key: str
) -> ScheduleSnapshot | None:
    """Consume once, only for the same origin/key and within the short handoff window."""
    pending = hass.data.get(_VALIDATED_KEY, {})
    candidate = pending.pop(host, None)
    if not pending:
        hass.data.pop(_VALIDATED_KEY, None)
    if candidate is None:
        return None
    digest, created, snapshot = candidate
    if monotonic() - created > _VALIDATED_TTL or not compare_digest(
        digest, sha256(api_key.strip().encode()).digest()
    ):
        return None
    return snapshot


class Rc30Coordinator(DataUpdateCoordinator[ScheduleSnapshot]):
    """Expose the last verified plan without scheduling periodic bus reads."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: EmsEspClient) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, config_entry=entry, update_interval=None)
        self.client = client
        self.writer = ScheduleWriter(hass, entry.entry_id, self)
        self.cache = Store(
            hass, 1, f"{DOMAIN}_schedule_{entry.entry_id}", private=True, atomic_writes=True
        )
        self.schedule_source = "stored"
        self.refresh_error: str | None = None
        self.cache_error = False
        self.refreshing = False

    async def async_initialize_cache(self) -> bool:
        """Restore the original verification time; never turn cached data into a fresh read."""
        try:
            saved = await self.cache.async_load()
            if saved is None:
                return False
            slots = decode_slots(saved["slots"])
            program = saved["active_program"]
            stamp = datetime.fromisoformat(saved["verified_at"])
            if (
                not isinstance(program, str)
                or not program
                or len(program) > 64
                or stamp.tzinfo is None
                or stamp > datetime.now(UTC) + timedelta(minutes=5)
            ):
                raise ValueError
            self.async_set_updated_data(ScheduleSnapshot(slots, program, stamp))
            return True
        except Exception:
            _LOGGER.warning("Stored RC30 schedule could not be loaded; a complete read is required")
            return False

    async def _async_store_snapshot(self, snapshot: ScheduleSnapshot) -> None:
        self.schedule_source = "read"
        self.refresh_error = None
        try:
            await self.cache.async_save(
                {
                    "slots": [slot.as_dict() for slot in snapshot.slots],
                    "active_program": snapshot.active_program,
                    "verified_at": snapshot.fetched_at.isoformat(),
                }
            )
            self.cache_error = False
        except Exception:
            # The verified in-memory plan remains usable, and the fallback journal is separate.
            self.cache_error = True
            _LOGGER.warning("Verified RC30 schedule could not be persisted")

    async def async_accept_snapshot(self, snapshot: ScheduleSnapshot) -> None:
        """Persist complete save/restore readbacks before publishing them."""
        await self._async_store_snapshot(snapshot)
        self.async_set_updated_data(snapshot)

    @callback
    def async_snapshot_error(self, code: str) -> None:
        """Retain the last complete plan and explicitly report uncertain live state."""
        self.refresh_error = code
        self.schedule_source = "stored"
        self.async_update_listeners()

    async def async_refresh_schedule(self) -> None:
        """One explicit refresh; reject overlapping clicks instead of queuing scans."""
        if self.writer.busy or self.refreshing:
            raise SaveError("busy")
        self.refreshing = True
        self.async_update_listeners()
        try:
            await self.async_refresh()
            if self.refresh_error:
                raise SaveError("refresh_failed")
        finally:
            self.refreshing = False
            self.async_update_listeners()

    async def _async_update_data(self) -> ScheduleSnapshot:
        """Only setup without a cache or explicit refresh reaches this method."""
        try:
            snapshot = await self.client.async_read_schedule(fresh=True)
        except AuthenticationError:
            if self.data is None:
                raise ConfigEntryAuthFailed("API key rejected") from None
            self.refresh_error = "authentication_failed"
        except EmsEspError:
            if self.data is None:
                raise UpdateFailed("Unable to verify the complete RC30 schedule") from None
            self.refresh_error = "read_failed"
        else:
            await self._async_store_snapshot(snapshot)
            return snapshot
        self.schedule_source = "stored"
        return self.data
