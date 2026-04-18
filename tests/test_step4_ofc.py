"""
STEP 4 — OFC BOOKING TESTS

✅ Date building from day/month/year
✅ Session expiry detection
✅ Error row detection
❌ Date outside range is skipped
"""
from __future__ import annotations

import pytest
from unittest.mock import patch
from tests.conftest import MockPage, MockLocator
from datetime import date


class TestStep4OFCBooking:

    def test_build_date_from_parts(self, test_user):
        """✅ _build_date constructs date from day, month name, year."""
        from ofc_booking import _build_date

        d = _build_date("15", "June", "2026")
        assert d == date(2026, 6, 15)

        d2 = _build_date("1", "January", "2027")
        assert d2 == date(2027, 1, 1)

    def test_build_date_invalid(self):
        """❌ Invalid inputs return None."""
        from ofc_booking import _build_date

        assert _build_date("abc", "June", "2026") is None
        assert _build_date("15", "InvalidMonth", "2026") is None

    def test_date_within_range(self, test_user):
        """✅ Date within range passes filter."""
        from ofc_booking import _build_date

        d = _build_date("15", "June", "2026")
        assert d is not None
        assert test_user.date_range_start <= d <= test_user.date_range_end

    def test_date_outside_range(self, test_user):
        """❌ Date outside range is filtered out."""
        from ofc_booking import _build_date

        d = _build_date("1", "January", "2025")
        assert d is not None
        assert not (test_user.date_range_start <= d <= test_user.date_range_end)

    def test_session_expired_on_login_redirect(self):
        """✅ Session expired detected when URL has b2clogin.com."""
        from ofc_booking import _session_expired

        page = MockPage()
        page.url = "https://atlasauth.b2clogin.com/sign-in"
        assert _session_expired(page) is True

    def test_session_not_expired(self):
        """✅ Normal URL → session not expired."""
        from ofc_booking import _session_expired

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/ofc-schedule/123"
        page.set_body_text("Select your appointment")
        assert _session_expired(page) is False

    def test_error_row_maxed_out(self, test_user):
        """✅ Error row with 'maximum' text detected."""
        from ofc_booking import _check_error_row

        page = MockPage()
        page.set_locator("#error_row", MockLocator(
            visible=True, count=1, text="maximum number of times you may view this page"
        ))

        result = _check_error_row(page, test_user)
        assert result is True

    def test_error_row_empty(self, test_user):
        """✅ No error row → returns False."""
        from ofc_booking import _check_error_row

        page = MockPage()
        result = _check_error_row(page, test_user)
        assert result is False

    def test_five_consulate_locations_configured(self, test_user):
        """✅ Exactly 5 locations configured."""
        assert len(test_user.preferred_consulates) == 5
        expected = ["Mumbai", "New Delhi", "Chennai", "Kolkata", "Hyderabad"]
        assert test_user.preferred_consulates == expected
