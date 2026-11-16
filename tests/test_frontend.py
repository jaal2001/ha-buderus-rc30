"""Verify the bundled card is exposed without exposing configuration files."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from custom_components.buderus_rc30 import async_setup


async def test_static_card_registration(hass):
    """Register a single public JavaScript asset, with browser caching disabled."""
    hass.http = MagicMock(async_register_static_paths=AsyncMock())
    assert await async_setup(hass, {})
    paths = hass.http.async_register_static_paths.call_args.args[0]
    assert len(paths) == 1
    assert paths[0].url_path == "/buderus_rc30/buderus-rc30-schedule-card.js"
    path = Path(paths[0].path)
    assert path.name == "buderus-rc30-schedule-card.js"
    assert await hass.async_add_executor_job(path.is_file)
    assert paths[0].cache_headers is False
