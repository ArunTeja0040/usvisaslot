"""
STEP 6 — CONFIRMATION PAGE TESTS

✅ Both OFC + Interview CONFIRMED → show confirmation page
❌ Only OFC confirmed → block
❌ Only Interview confirmed → block
✅ Confirmation page detection by URL
✅ Confirmation page detection by text
"""
from __future__ import annotations

import pytest
from unittest.mock import patch
from tests.conftest import MockPage, MockLocator
from models import BookingResult


class TestStep6Confirmation:

    def test_both_confirmed_shows_confirmation(self, full_booking):
        """✅ Both confirmed → confirmation page accessible."""
        from confirmation import handle_confirmation

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/appointment-confirmation/123"
        page.set_body_text("Confirmation — your appointment is confirmed. Print Download")

        with patch("confirmation.notify_booking_complete"), \
             patch("confirmation.notify_error"), \
             patch("confirmation._download_confirmation", return_value="/tmp/confirmation.pdf"), \
             patch("confirmation._save_screenshot", return_value="/tmp/screenshot.png"):
            result = handle_confirmation(page, full_booking.user, full_booking)

        assert result is True
        assert full_booking.confirmation_downloaded is True

    def test_only_ofc_confirmed_blocks(self, test_user):
        """❌ Only OFC confirmed → blocks confirmation."""
        from confirmation import handle_confirmation

        page = MockPage()
        booking = BookingResult(user=test_user, consulate="Mumbai",
                                ofc_confirmed=True, interview_confirmed=False)

        with patch("confirmation.notify_error") as mock_err:
            result = handle_confirmation(page, test_user, booking)

        assert result is False
        mock_err.assert_called()

    def test_only_interview_confirmed_blocks(self, test_user):
        """❌ Only Interview confirmed → blocks confirmation."""
        from confirmation import handle_confirmation

        page = MockPage()
        booking = BookingResult(user=test_user, consulate="Mumbai",
                                ofc_confirmed=False, interview_confirmed=True)

        with patch("confirmation.notify_error") as mock_err:
            result = handle_confirmation(page, test_user, booking)

        assert result is False
        mock_err.assert_called()

    def test_neither_confirmed_blocks(self, test_user):
        """❌ Neither confirmed → blocks confirmation."""
        from confirmation import handle_confirmation

        page = MockPage()
        booking = BookingResult(user=test_user, consulate="Mumbai",
                                ofc_confirmed=False, interview_confirmed=False)

        with patch("confirmation.notify_error"):
            result = handle_confirmation(page, test_user, booking)

        assert result is False

    def test_confirmation_page_detected_by_url(self):
        """✅ URL with appointment-confirmation detected."""
        from confirmation import _is_confirmation_page

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/appointment-confirmation/456"

        assert _is_confirmation_page(page) is True

    def test_confirmation_page_detected_by_text(self):
        """✅ Page text with 'confirmation' detected."""
        from confirmation import _is_confirmation_page

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/some-page"
        page.set_body_text("Your appointment confirmation is ready.")

        assert _is_confirmation_page(page) is True

    def test_non_confirmation_page(self):
        """❌ Login page is not confirmation."""
        from confirmation import _is_confirmation_page

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/sign-in"
        page.set_body_text("Login to your account")

        assert _is_confirmation_page(page) is False
