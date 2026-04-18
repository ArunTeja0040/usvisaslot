from __future__ import annotations

import sys
import os
import pytest
from unittest.mock import MagicMock, patch
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models import UserProfile, BookingResult


@pytest.fixture
def test_user():
    return UserProfile(
        name="Test User",
        username="test@example.com",
        password="testpass123",
        security_questions={
            "What is your mother's maiden name?": "Smith",
            "What city were you born in?": "Mumbai",
            "What is the name of your first pet?": "Rex",
        },
        preferred_consulates=["Mumbai", "New Delhi", "Chennai", "Kolkata", "Hyderabad"],
        date_range_start=date(2026, 5, 1),
        date_range_end=date(2026, 12, 31),
        telegram_chat_id="123456789",
    )


@pytest.fixture
def confirmed_ofc_booking(test_user):
    return BookingResult(
        user=test_user,
        consulate="Mumbai",
        ofc_date="2026-06-15",
        ofc_time="09:00 AM",
        ofc_confirmed=True,
    )


@pytest.fixture
def full_booking(test_user):
    return BookingResult(
        user=test_user,
        consulate="Mumbai",
        ofc_date="2026-06-15",
        ofc_time="09:00 AM",
        ofc_confirmed=True,
        interview_date="2026-07-20",
        interview_time="10:30 AM",
        interview_confirmed=True,
    )


class MockLocator:
    """Mock Playwright Locator with configurable behavior."""

    def __init__(self, visible=True, text="", count=1, elements=None, value="", attributes=None, enabled=True):
        self._visible = visible
        self._text = text
        self._count = count
        self._elements = elements or []
        self._value = value
        self._attributes = attributes or {}
        self._enabled = enabled

    def is_visible(self):
        return self._visible

    def is_enabled(self):
        return self._enabled

    def count(self):
        return self._count

    def inner_text(self):
        return self._text

    def input_value(self):
        return self._value

    def click(self):
        pass

    def fill(self, text):
        pass

    def type(self, text, delay=0):
        pass

    def select_option(self, label=None, value=None):
        pass

    def dispatch_event(self, event_type):
        pass

    def evaluate(self, expression):
        return "DIV"

    def wait_for(self, state="visible", timeout=5000):
        if not self._visible:
            raise TimeoutError(f"Locator not visible within {timeout}ms")

    def get_attribute(self, name):
        return self._attributes.get(name, None)

    def all(self):
        return self._elements

    def locator(self, selector):
        return MockLocator(visible=False, count=0)

    @property
    def first(self):
        return self


class MockPage:
    """Mock Playwright Page with configurable state for each test step."""

    def __init__(self):
        self.url = "https://usvisascheduling.com/sign-in"
        self._locators = {}
        self._goto_history = []
        self._default_locator = MockLocator(visible=False, count=0)
        self._body_text = ""

    def goto(self, url, wait_until="domcontentloaded", timeout=30000):
        self._goto_history.append(url)
        self.url = url

    def wait_for_load_state(self, state="domcontentloaded", timeout=15000):
        pass

    def wait_for_timeout(self, ms):
        pass

    def wait_for_selector(self, selector, timeout=10000):
        pass

    def reload(self, wait_until="domcontentloaded", timeout=15000):
        pass

    def inner_text(self, selector):
        if selector == "body":
            return self._body_text
        return ""

    def screenshot(self, path="", full_page=False):
        pass

    def pdf(self, path="", format="A4", print_background=True):
        pass

    def expect_download(self, timeout=15000):
        return MagicMock()

    def locator(self, selector):
        for key, loc in self._locators.items():
            if key in selector or selector in key:
                return loc
        return self._default_locator

    def set_locator(self, key, locator):
        self._locators[key] = locator

    def set_body_text(self, text):
        self._body_text = text


@pytest.fixture
def mock_page():
    return MockPage()


@pytest.fixture(autouse=True)
def mock_notifier():
    """Suppress all Telegram notifications during tests."""
    with patch("notifier.send_message", return_value=True), \
         patch("notifier.send_photo", return_value=True), \
         patch("notifier.send_document", return_value=True):
        yield
