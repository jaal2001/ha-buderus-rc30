"""Expose schedule counts, active program and last verified poll."""

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import Rc30ConfigEntry
from .const import DOMAIN, NAME, SLOT_COUNT
from .coordinator import Rc30Coordinator

SENSORS = (
    SensorEntityDescription(key="schedule", translation_key="schedule", icon="mdi:calendar-clock"),
    SensorEntityDescription(
        key="free_slots", translation_key="free_slots", icon="mdi:calendar-plus"
    ),
    SensorEntityDescription(
        key="active_program", translation_key="active_program", icon="mdi:calendar"
    ),
    SensorEntityDescription(
        key="last_success",
        translation_key="last_success",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: Rc30ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create sensors sharing one coordinator and one gateway device."""
    async_add_entities(Rc30Sensor(entry, description) for description in SENSORS)


class Rc30Sensor(CoordinatorEntity[Rc30Coordinator], SensorEntity):
    """Never present a partial or failed poll as a current schedule."""

    _attr_has_entity_name = True

    def __init__(self, entry: Rc30ConfigEntry, description: SensorEntityDescription) -> None:
        """Use stable IDs independent of an API key."""
        super().__init__(entry.runtime_data)
        self.entity_description = description
        self._attr_unique_id = f"{entry.unique_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.unique_id)},
            name=NAME,
            manufacturer="Buderus",
            model="RC30 schedule via EMS-ESP (HC1, own 1)",
        )

    @property
    def native_value(self):
        """Return a compact state; the full schedule lives in attributes."""
        data = self.coordinator.data
        match self.entity_description.key:
            case "schedule":
                return data.occupied_count
            case "free_slots":
                return SLOT_COUNT - data.occupied_count
            case "active_program":
                return data.active_program
            case "last_success":
                return data.fetched_at
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Keep physical slot order, including empty slots."""
        if self.entity_description.key != "schedule":
            return None
        data = self.coordinator.data
        return {
            "heating_circuit": 1,
            "schedule_program": "own 1",
            "active_program": data.active_program,
            "capacity": SLOT_COUNT,
            "free_slots": SLOT_COUNT - data.occupied_count,
            "verified_at": data.fetched_at.isoformat(),
            "slots": [slot.as_dict() for slot in data.slots],
            "save_status": self.coordinator.writer.status(),
        }
