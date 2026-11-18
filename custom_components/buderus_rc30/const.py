"""Constants for the read-only RC30 schedule integration."""

from datetime import timedelta

DOMAIN = "buderus_rc30"
CARD_PATH = "/buderus_rc30/buderus-rc30-schedule-card.js"
NAME = "Buderus RC30 Schedule"
SLOT_COUNT = 42
SCAN_INTERVAL = timedelta(minutes=15)
SWITCHTIME_PATH = "/api/thermostat/hc1/switchtime1"
PROGRAM_PATH = "/api/thermostat/hc1/program"
REQUEST_TIMEOUT = 5
SLOT_ATTEMPTS = 6
SETTLE_DELAY = 0.5
POLL_TIMEOUT = 180
