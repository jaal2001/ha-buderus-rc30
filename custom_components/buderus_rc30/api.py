"""Small asynchronous EMS-ESP client with a read-selector-only POST boundary."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import aiohttp
from yarl import URL

from .const import (
    POLL_TIMEOUT,
    PROGRAM_PATH,
    REQUEST_TIMEOUT,
    SETTLE_DELAY,
    SLOT_ATTEMPTS,
    SLOT_COUNT,
    SWITCHTIME_PATH,
)


class EmsEspError(Exception):
    """Represent a sanitized API error."""


class AuthenticationError(EmsEspError):
    """Represent a rejected API key."""


class CommunicationError(EmsEspError):
    """Represent an unreachable gateway or failed request."""


class InvalidResponse(EmsEspError):
    """Represent invalid data or an unverified schedule."""


class SlotMismatch(InvalidResponse):
    """Represent a cached response for a different slot."""


def normalize_host(host: str) -> str:
    """Accept only an HTTP(S) origin, without credentials or an API path."""
    if not isinstance(host, str) or not host.strip():
        raise ValueError("Enter a hostname or HTTP(S) origin")
    value = host.strip()
    if any(char.isspace() for char in value):
        raise ValueError("Invalid hostname")
    try:
        url = URL(value if "://" in value else f"http://{value}")
        if (
            url.scheme not in ("http", "https")
            or not url.host
            or url.user is not None
            or url.password is not None
            or url.path not in ("", "/")
            or url.query_string
            or url.fragment
            or url.port is None
            or not 1 <= url.port <= 65535
        ):
            raise ValueError
        return str(url.origin())
    except (ValueError, UnicodeError) as err:
        raise ValueError("Enter a hostname or HTTP(S) origin without a path") from err


@dataclass(frozen=True)
class ScheduleSlot:
    """One physical slot; empty slots remain present in the snapshot."""

    index: int
    day: str | None = None
    time: str | None = None
    mode: str | None = None

    @property
    def occupied(self) -> bool:
        """Return whether this slot contains a switching point."""
        return self.day is not None

    def as_dict(self) -> dict[str, Any]:
        """Return JSON-compatible attributes without gateway details."""
        return {
            "slot": f"{self.index:02d}",
            "occupied": self.occupied,
            "day": self.day,
            "time": self.time,
            "mode": self.mode,
        }


@dataclass(frozen=True)
class ScheduleSnapshot:
    """A complete, validated pass over own 1 for heating circuit 1."""

    slots: tuple[ScheduleSlot, ...]
    active_program: str
    fetched_at: datetime

    @property
    def occupied_count(self) -> int:
        """Count occupied slots rather than assuming a fixed example count."""
        return sum(slot.occupied for slot in self.slots)


_SLOT_PATTERN = re.compile(
    r"(?P<index>[0-9]{2}) (?:(?P<empty>not_set)|"
    r"(?P<day>mo|tu|we|th|fr|sa|su) "
    r"(?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}) (?P<mode>on|off))"
)


def parse_slot(expected: int, raw: Any) -> ScheduleSlot:
    """Reject wrong slot IDs, unsupported modes and invalid RC30 times."""
    if type(expected) is not int or not 0 <= expected < SLOT_COUNT:
        raise ValueError("Slot must be an integer between 0 and 41")
    match = _SLOT_PATTERN.fullmatch(raw) if isinstance(raw, str) else None
    if match is None:
        raise InvalidResponse("Unsupported switchtime response")
    if int(match["index"]) != expected:
        raise SlotMismatch("Gateway returned a different slot")
    if match["empty"]:
        return ScheduleSlot(expected)
    hour, minute = int(match["hour"]), int(match["minute"])
    if minute > 59 or minute % 10 or hour > 24 or (hour == 24 and minute):
        raise InvalidResponse("Invalid RC30 switching time")
    return ScheduleSlot(expected, match["day"], f"{hour:02d}:{minute:02d}", match["mode"])


class EmsEspClient:
    """Serialize complete polls; expose no schedule-writing method."""

    def __init__(self, session: aiohttp.ClientSession, host: str, api_key: str) -> None:
        """Use the caller's session and keep secrets out of representations."""
        self._session = session
        self._host = normalize_host(host)
        if (
            not isinstance(api_key, str)
            or not api_key.strip()
            or any(char in api_key for char in "\r\n")
        ):
            raise ValueError("Enter a non-empty API key")
        self._api_key = api_key.strip()
        self._lock = asyncio.Lock()

    async def _request(self, method: str, path: str, slot: int | None = None) -> Any:
        """Allow only two read endpoints and a two-digit slot selector POST."""
        if method == "POST":
            if path != SWITCHTIME_PATH or type(slot) is not int or not 0 <= slot < SLOT_COUNT:
                raise ValueError("Only read selectors for slots 00 through 41 are allowed")
            payload = {"value": f"{slot:02d}"}
        elif method == "GET" and path in (SWITCHTIME_PATH, PROGRAM_PATH) and slot is None:
            payload = None
        else:
            raise ValueError("Unsupported API operation")
        try:
            async with self._session.request(
                method,
                f"{self._host}{path}",
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=payload,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                allow_redirects=False,
            ) as response:
                if response.status in (401, 403):
                    raise AuthenticationError("API key rejected")
                if not 200 <= response.status < 300:
                    raise CommunicationError("Gateway rejected the request")
                body = bytearray()
                async for chunk in response.content.iter_chunked(4096):
                    body.extend(chunk)
                    if len(body) > 16384:
                        raise InvalidResponse("Gateway response too large")
                if method == "POST":
                    return None
                try:
                    data = json.loads(body)
                except ValueError, UnicodeError:
                    raise InvalidResponse("Gateway returned invalid JSON") from None
                if isinstance(data, dict):
                    data = data.get("value")
                if not isinstance(data, str) or not data:
                    raise InvalidResponse("Gateway response has no text value")
                return data
        except aiohttp.ClientError, TimeoutError:
            raise CommunicationError("Gateway request failed or timed out") from None

    async def _read_slot(self, index: int) -> ScheduleSlot:
        """Select a slot once and wait for a response with the matching ID."""
        await self._request("POST", SWITCHTIME_PATH, index)
        for attempt in range(SLOT_ATTEMPTS):
            await asyncio.sleep(SETTLE_DELAY)
            raw = await self._request("GET", SWITCHTIME_PATH)
            try:
                return parse_slot(index, raw)
            except SlotMismatch:
                if attempt == SLOT_ATTEMPTS - 1:
                    raise InvalidResponse("Slot verification timed out") from None
        raise InvalidResponse("Slot verification failed")

    async def async_read_schedule(self) -> ScheduleSnapshot:
        """Publish only complete passes; never return a partial schedule."""
        async with self._lock:
            try:
                async with asyncio.timeout(POLL_TIMEOUT):
                    program = await self._request("GET", PROGRAM_PATH)
                    if len(program) > 64:
                        raise InvalidResponse("Invalid program response")
                    slots = tuple([await self._read_slot(index) for index in range(SLOT_COUNT)])
                    if await self._request("GET", PROGRAM_PATH) != program:
                        raise InvalidResponse("Active program changed during polling")
                    return ScheduleSnapshot(slots, program, datetime.now(UTC))
            except TimeoutError:
                raise CommunicationError("Schedule polling timed out") from None
