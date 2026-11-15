"""Exercise the actual HTTP client, parser and read-only boundary."""

import asyncio
from unittest.mock import patch

import aiohttp
import pytest
from aioresponses import aioresponses
from yarl import URL

from custom_components.buderus_rc30.api import (
    AuthenticationError,
    CommunicationError,
    EmsEspClient,
    InvalidResponse,
    SlotMismatch,
    normalize_host,
    parse_slot,
)
from custom_components.buderus_rc30.const import PROGRAM_PATH, SWITCHTIME_PATH

HOST = "http://ems-esp.example"
SWITCH = HOST + SWITCHTIME_PATH
PROGRAM = HOST + PROGRAM_PATH


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("EMS-ESP.example/", HOST),
        ("https://ems-esp.example:8443/", "https://ems-esp.example:8443"),
        ("http://[::1]:8080", "http://[::1]:8080"),
    ],
)
def test_host_normalization(value, expected):
    """Canonicalize origins for duplicate detection."""
    assert normalize_host(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "a b",
        "ftp://host",
        "http://user:secret@host",
        "host/api",
        "host?key=x",
        "host#x",
        "http://host:0",
        "http://host:65536",
    ],
)
def test_invalid_hosts(value):
    """Reject embedded secrets, paths, invalid ports and unsupported schemes."""
    with pytest.raises(ValueError):
        normalize_host(value)


@pytest.mark.parametrize("raw", ["01 mo 09:30 off", "01 su 24:00 on", "01 not_set"])
def test_parse_slot(raw):
    """Accept the observed format, end-of-day time and empty slots."""
    slot = parse_slot(1, raw)
    assert slot.index == 1
    assert slot.occupied == (raw != "01 not_set")
    assert slot.as_dict()["slot"] == "01"


@pytest.mark.parametrize(
    "raw",
    [
        None,
        {},
        "01 mo 09:35 off",
        "01 mo 24:10 on",
        "01 mo 25:00 on",
        "01 mo 09:60 on",
        "01 xx 09:30 on",
        "01 mo 09:30 T2",
        "01 mo 09:30 off\n",
        "01 not_set extra",
    ],
)
def test_reject_malformed_slots(raw):
    """Do not silently reinterpret unsupported formats or corrupt values."""
    with pytest.raises(InvalidResponse):
        parse_slot(1, raw)


def test_wrong_slot():
    """An otherwise valid cached value must not pass verification."""
    with pytest.raises(SlotMismatch):
        parse_slot(1, "00 not_set")


async def test_complete_poll_and_exact_post_payloads():
    """Read all physical slots exactly once; no schedule text may be posted."""
    with aioresponses() as responses, patch("custom_components.buderus_rc30.api.SETTLE_DELAY", 0):
        responses.get(PROGRAM, payload={"value": "own 1"}, repeat=2)
        for index in range(42):
            responses.post(SWITCH, payload={"message": "OK"})
            raw = f"{index:02d} mo 09:30 off" if index < 38 else f"{index:02d} not_set"
            responses.get(SWITCH, payload={"value": raw})
        async with aiohttp.ClientSession() as session:
            data = await EmsEspClient(session, HOST, "test-key").async_read_schedule()
        assert data.occupied_count == 38
        assert [slot.index for slot in data.slots] == list(range(42))
        assert data.active_program == "own 1"
        posts = responses.requests[("POST", URL(SWITCH))]
        assert [call.kwargs["json"] for call in posts] == [
            {"value": f"{index:02d}"} for index in range(42)
        ]
        assert all(call.kwargs["allow_redirects"] is False for call in posts)
        assert all(call.kwargs["headers"]["Authorization"] == "Bearer test-key" for call in posts)


async def test_stale_slot_is_retried_without_another_post():
    """Wait for the selected slot while bounding bus traffic."""
    with aioresponses() as responses, patch("custom_components.buderus_rc30.api.SETTLE_DELAY", 0):
        responses.post(SWITCH, status=204)
        responses.get(SWITCH, payload={"value": "00 not_set"})
        responses.get(SWITCH, payload="01 mo 09:30 off")
        async with aiohttp.ClientSession() as session:
            slot = await EmsEspClient(session, HOST, "test-key")._read_slot(1)
        assert slot.mode == "off"
        assert len(responses.requests[("POST", URL(SWITCH))]) == 1


async def test_persistently_wrong_slot_fails():
    """Never publish a previous slot under a new index."""
    with aioresponses() as responses, patch("custom_components.buderus_rc30.api.SETTLE_DELAY", 0):
        responses.post(SWITCH, status=204)
        responses.get(SWITCH, payload={"value": "00 not_set"}, repeat=True)
        async with aiohttp.ClientSession() as session:
            with pytest.raises(InvalidResponse, match="verification timed out"):
                await EmsEspClient(session, HOST, "test-key")._read_slot(1)
        assert len(responses.requests[("GET", URL(SWITCH))]) == 6


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (401, AuthenticationError),
        (403, AuthenticationError),
        (500, CommunicationError),
        (302, CommunicationError),
    ],
)
async def test_http_errors_are_sanitized(status, error):
    """Reject redirects and keep server text and credentials out of exceptions."""
    with aioresponses() as responses:
        responses.get(PROGRAM, status=status, body="test-key private-host")
        async with aiohttp.ClientSession() as session:
            with pytest.raises(error) as caught:
                await EmsEspClient(session, HOST, "test-key").async_read_schedule()
        assert "test-key" not in str(caught.value)
        assert "private-host" not in str(caught.value)


@pytest.mark.parametrize(
    "body", ["not-json", "{}", "null", '{"value":12}', '""', '"' + "x" * 17000 + '"']
)
async def test_invalid_http_body(body):
    """Reject malformed, missing and oversized values."""
    with aioresponses() as responses:
        responses.get(PROGRAM, body=body)
        async with aiohttp.ClientSession() as session:
            with pytest.raises(InvalidResponse):
                await EmsEspClient(session, HOST, "test-key").async_read_schedule()


async def test_timeout_and_cancellation():
    """Convert request timeouts while allowing cancellation to propagate."""
    with aioresponses() as responses:
        responses.get(PROGRAM, exception=TimeoutError())
        responses.get(PROGRAM, exception=asyncio.CancelledError())
        async with aiohttp.ClientSession() as session:
            client = EmsEspClient(session, HOST, "test-key")
            with pytest.raises(CommunicationError):
                await client.async_read_schedule()
            with pytest.raises(asyncio.CancelledError):
                await client.async_read_schedule()


@pytest.mark.parametrize("slot", [-1, 42, True, "01 mo 09:30 on", "01 not_set"])
async def test_post_guard(slot):
    """Reject all values that could become schedule writes before any network I/O."""
    async with aiohttp.ClientSession() as session:
        client = EmsEspClient(session, HOST, "test-key")
        with pytest.raises(ValueError):
            await client._request("POST", SWITCHTIME_PATH, slot)
        with pytest.raises(ValueError):
            await client._request("POST", PROGRAM_PATH, 1)


async def test_program_change_discards_pass(snapshot):
    """A changing active program invalidates the whole pass."""
    with (
        patch.object(EmsEspClient, "_request", side_effect=["own 1", "own 2"]),
        patch.object(EmsEspClient, "_read_slot", side_effect=snapshot.slots),
    ):
        async with aiohttp.ClientSession() as session:
            with pytest.raises(InvalidResponse, match="program changed"):
                await EmsEspClient(session, HOST, "test-key").async_read_schedule()


async def test_polls_do_not_interleave(snapshot):
    """Serialize two callers over the full slot-selection sequence."""
    indexes = []

    async def read_slot(index):
        indexes.append(index)
        await asyncio.sleep(0)
        return snapshot.slots[index]

    with (
        patch.object(EmsEspClient, "_request", return_value="own 1"),
        patch.object(EmsEspClient, "_read_slot", side_effect=read_slot),
    ):
        async with aiohttp.ClientSession() as session:
            client = EmsEspClient(session, HOST, "test-key")
            await asyncio.gather(client.async_read_schedule(), client.async_read_schedule())
    assert indexes == list(range(42)) * 2


async def test_partial_pass_never_returns(snapshot):
    """A late failed slot discards the preceding successful reads."""
    with (
        patch.object(EmsEspClient, "_request", return_value="own 1"),
        patch.object(
            EmsEspClient,
            "_read_slot",
            side_effect=[*snapshot.slots[:40], CommunicationError("Lost connection")],
        ) as read,
    ):
        async with aiohttp.ClientSession() as session:
            with pytest.raises(CommunicationError):
                await EmsEspClient(session, HOST, "test-key").async_read_schedule()
    assert read.await_count == 41


async def test_entire_poll_deadline():
    """Bound the whole scan even when an operation stalls."""

    async def stalled_request(*args, **kwargs):
        await asyncio.Event().wait()

    with (
        patch("custom_components.buderus_rc30.api.POLL_TIMEOUT", 0.01),
        patch.object(EmsEspClient, "_request", side_effect=stalled_request),
    ):
        async with aiohttp.ClientSession() as session:
            with pytest.raises(CommunicationError, match="polling timed out"):
                await EmsEspClient(session, HOST, "test-key").async_read_schedule()


async def test_failed_selector_stops_before_get():
    """Do not read cached data when the gateway rejected the selector."""
    with aioresponses() as responses:
        responses.post(SWITCH, status=400)
        async with aiohttp.ClientSession() as session:
            with pytest.raises(CommunicationError):
                await EmsEspClient(session, HOST, "test-key")._read_slot(0)
        assert ("GET", URL(SWITCH)) not in responses.requests


@pytest.mark.parametrize("key", ["", " ", "test\rkey", "test\nkey"])
async def test_invalid_key(key):
    """Reject blank keys and header injection before any network I/O."""
    async with aiohttp.ClientSession() as session:
        with pytest.raises(ValueError):
            EmsEspClient(session, HOST, key)
