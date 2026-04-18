"""
STEP 5 — INTERVIEW BOOKING TESTS

❌ OFC NOT CONFIRMED → block interview
✅ OFC reset during wait → raises OFCResetRequired
❌ Window expires → error/timeout
✅ Date building works same as OFC
"""
from __future__ import annotations

import pytest
from unittest.mock import patch, MagicMock
from tests.conftest import MockPage, MockLocator
from models import BookingResult
from datetime import date


class TestStep5InterviewBooking:

    def test_ofc_not_confirmed_blocks_interview(self, test_user):
        """❌ OFC not confirmed → interview blocked."""
        from interview_booking import book_interview

        page = MockPage()
        booking = BookingResult(user=test_user, consulate="Mumbai", ofc_confirmed=False)

        with patch("interview_booking.notify_error") as mock_err:
            result = book_interview(page, test_user, booking)

        assert result is False
        mock_err.assert_called()

    def test_ofc_reset_during_interview_wait(self, confirmed_ofc_booking):
        """✅ OFC becomes unblocked during wait → raises OFCResetRequired."""
        from interview_booking import book_interview, OFCResetRequired

        page = MockPage()
        user = confirmed_ofc_booking.user

        with patch("interview_booking._try_book_interview", return_value=False), \
             patch("interview_booking._ofc_became_unblocked", return_value=True), \
             patch("interview_booking.notify_waiting_interview"), \
             patch("interview_booking.notify_ofc_reset"), \
             patch("interview_booking.notify_error"), \
             patch("interview_booking.time.sleep"):
            with pytest.raises(OFCResetRequired):
                book_interview(page, user, confirmed_ofc_booking)

        assert confirmed_ofc_booking.ofc_confirmed is False

    def test_interview_wait_timeout(self, confirmed_ofc_booking):
        """❌ Window expires → error returned."""
        from interview_booking import book_interview
        import time as real_time

        page = MockPage()
        user = confirmed_ofc_booking.user

        base_time = real_time.time()
        call_count = [0]

        def fake_time():
            call_count[0] += 1
            return base_time + (call_count[0] * 2000)

        with patch("interview_booking._try_book_interview", return_value=False), \
             patch("interview_booking._ofc_became_unblocked", return_value=False), \
             patch("interview_booking.time.time", side_effect=fake_time), \
             patch("interview_booking.time.sleep"), \
             patch("interview_booking._retrigger_consulate"), \
             patch("interview_booking.notify_waiting_interview"), \
             patch("interview_booking.notify_error") as mock_err:
            result = book_interview(page, user, confirmed_ofc_booking)

        assert result is False
        mock_err.assert_called()

    def test_build_date_works(self):
        """✅ Date building same as OFC."""
        from interview_booking import _build_date

        d = _build_date("20", "July", "2026")
        assert d == date(2026, 7, 20)

        assert _build_date("abc", "July", "2026") is None

    def test_ofc_unblocked_detection(self):
        """✅ OFC pending status detected."""
        from interview_booking import _ofc_became_unblocked

        page = MockPage()
        page.set_body_text("OFC Appointment: Pending review")

        user = MagicMock()
        result = _ofc_became_unblocked(page, user)
        assert result is True

    def test_ofc_not_unblocked(self):
        """✅ Normal page → OFC not unblocked."""
        from interview_booking import _ofc_became_unblocked

        page = MockPage()
        page.set_body_text("Select your interview date")

        user = MagicMock()
        result = _ofc_became_unblocked(page, user)
        assert result is False
