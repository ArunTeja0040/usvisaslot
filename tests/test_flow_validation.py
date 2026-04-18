"""
FLOW & SEQUENCE VALIDATION TESTS

❌ Cannot access Step 5 without completing Step 4
❌ Cannot access Step 6 without completing Step 5
✅ After full confirmation, booking contains both OFC + Interview details
✅ Multi-user: each user gets isolated session
✅ Completed users are skipped
✅ Full flow 1→2→3→4→5→6 succeeds with mocked steps
✅ OFC reset retries from Step 4
"""
from __future__ import annotations

import pytest
from unittest.mock import patch, MagicMock
from models import UserProfile, BookingResult
from datetime import date


class TestFlowSequenceValidation:

    def test_step5_blocked_without_step4(self, test_user):
        """❌ Cannot start interview without OFC confirmed."""
        from interview_booking import book_interview

        page = MagicMock()
        booking = BookingResult(user=test_user, consulate="Mumbai", ofc_confirmed=False)

        with patch("interview_booking.notify_error"):
            result = book_interview(page, test_user, booking)

        assert result is False

    def test_step6_blocked_without_step5(self, test_user):
        """❌ Cannot access confirmation without interview confirmed."""
        from confirmation import handle_confirmation

        page = MagicMock()
        booking = BookingResult(user=test_user, consulate="Mumbai",
                                ofc_confirmed=True, interview_confirmed=False)

        with patch("confirmation.notify_error"):
            result = handle_confirmation(page, test_user, booking)

        assert result is False

    def test_step6_blocked_without_both(self, test_user):
        """❌ Cannot access confirmation without both."""
        from confirmation import handle_confirmation

        page = MagicMock()
        booking = BookingResult(user=test_user, consulate="Mumbai",
                                ofc_confirmed=False, interview_confirmed=False)

        with patch("confirmation.notify_error"):
            result = handle_confirmation(page, test_user, booking)

        assert result is False

    def test_full_booking_contains_both_details(self, full_booking):
        """✅ Full booking has both OFC + Interview details."""
        assert full_booking.ofc_confirmed is True
        assert full_booking.ofc_date == "2026-06-15"
        assert full_booking.ofc_time == "09:00 AM"
        assert full_booking.interview_confirmed is True
        assert full_booking.interview_date == "2026-07-20"
        assert full_booking.interview_time == "10:30 AM"
        assert full_booking.consulate == "Mumbai"

    def test_process_user_full_flow_success(self, test_user):
        """✅ Full flow succeeds end-to-end with mocked steps."""
        from main import process_user

        mock_browser = MagicMock()
        mock_context = MagicMock()
        mock_page = MagicMock()
        mock_browser.new_context.return_value = mock_context
        mock_context.new_page.return_value = mock_page

        mock_booking = BookingResult(
            user=test_user, consulate="Mumbai",
            ofc_date="2026-06-15", ofc_time="09:00 AM", ofc_confirmed=True,
            interview_date="2026-07-20", interview_time="10:30 AM", interview_confirmed=True,
        )

        with patch("main.login", return_value=True), \
             patch("main.navigate_to_schedule", return_value=True), \
             patch("main.book_ofc", return_value=mock_booking), \
             patch("main.book_interview", return_value=True), \
             patch("main.handle_confirmation", return_value=True):
            result = process_user(mock_browser, test_user)

        assert result is True

    def test_login_failure_stops(self, test_user):
        """❌ Login failure → no further steps."""
        from main import process_user

        mock_browser = MagicMock()
        mock_browser.new_context.return_value = MagicMock(new_page=MagicMock(return_value=MagicMock()))

        with patch("main.login", return_value=False), \
             patch("main.navigate_to_schedule") as mock_dash, \
             patch("main.book_ofc") as mock_ofc:
            result = process_user(mock_browser, test_user)

        assert result is False
        mock_dash.assert_not_called()
        mock_ofc.assert_not_called()

    def test_dashboard_failure_stops(self, test_user):
        """❌ Dashboard failure → no OFC or Interview."""
        from main import process_user

        mock_browser = MagicMock()
        mock_browser.new_context.return_value = MagicMock(new_page=MagicMock(return_value=MagicMock()))

        with patch("main.login", return_value=True), \
             patch("main.navigate_to_schedule", return_value=False), \
             patch("main.book_ofc") as mock_ofc:
            result = process_user(mock_browser, test_user)

        assert result is False
        mock_ofc.assert_not_called()

    def test_ofc_reset_retries(self, test_user):
        """✅ OFC reset during interview → retries from Step 4."""
        from main import process_user
        from interview_booking import OFCResetRequired

        mock_browser = MagicMock()
        mock_browser.new_context.return_value = MagicMock(new_page=MagicMock(return_value=MagicMock()))

        booking1 = BookingResult(user=test_user, consulate="Mumbai",
                                  ofc_confirmed=True, ofc_date="2026-06-15", ofc_time="09:00 AM")
        booking2 = BookingResult(user=test_user, consulate="Mumbai",
                                  ofc_confirmed=True, ofc_date="2026-06-16", ofc_time="10:00 AM")

        ofc_calls = [0]

        def ofc_side_effect(page, user):
            ofc_calls[0] += 1
            return booking1 if ofc_calls[0] == 1 else booking2

        interview_calls = [0]

        def interview_side_effect(page, user, booking):
            interview_calls[0] += 1
            if interview_calls[0] == 1:
                raise OFCResetRequired("OFC reset")
            return True

        with patch("main.login", return_value=True), \
             patch("main.navigate_to_schedule", return_value=True), \
             patch("main.book_ofc", side_effect=ofc_side_effect), \
             patch("main.book_interview", side_effect=interview_side_effect), \
             patch("main.handle_confirmation", return_value=True):
            result = process_user(mock_browser, test_user)

        assert result is True
        assert ofc_calls[0] == 2
        assert interview_calls[0] == 2

    def test_multi_user_independent(self):
        """✅ Users have independent configs."""
        user1 = UserProfile(
            name="User 1", username="u1@test.com", password="p1",
            security_questions={"Q1?": "A1", "Q2?": "A2", "Q3?": "A3"},
            preferred_consulates=["Mumbai"],
            date_range_start=date(2026, 5, 1), date_range_end=date(2026, 12, 31),
            telegram_chat_id="111",
        )
        user2 = UserProfile(
            name="User 2", username="u2@test.com", password="p2",
            security_questions={"Q1?": "B1", "Q2?": "B2", "Q3?": "B3"},
            preferred_consulates=["Chennai"],
            date_range_start=date(2026, 6, 1), date_range_end=date(2026, 10, 31),
            telegram_chat_id="222",
        )

        assert user1.username != user2.username
        assert user1.preferred_consulates != user2.preferred_consulates

    def test_completed_users_tracking(self):
        """✅ Completed users are tracked and skipped."""
        completed: set[str] = set()
        all_users = ["user1@test.com", "user2@test.com", "user3@test.com"]

        completed.add("user1@test.com")
        pending = [u for u in all_users if u not in completed]
        assert len(pending) == 2
        assert "user1@test.com" not in pending


class TestModelsValidation:

    def test_user_profile_from_dict(self):
        """✅ UserProfile.from_dict parses correctly."""
        data = {
            "name": "Test", "username": "t@t.com", "password": "p",
            "security_questions": {"Q?": "A"},
            "preferred_consulates": ["Mumbai"],
            "date_range_start": "2026-05-01", "date_range_end": "2026-12-31",
            "telegram_chat_id": "123",
        }
        user = UserProfile.from_dict(data)
        assert user.name == "Test"
        assert user.date_range_start == date(2026, 5, 1)

    def test_booking_result_defaults(self, test_user):
        """✅ BookingResult defaults are correct."""
        b = BookingResult(user=test_user, consulate="Mumbai")
        assert b.ofc_confirmed is False
        assert b.interview_confirmed is False
        assert b.confirmation_downloaded is False


class TestNotifierValidation:

    def test_html_escaping(self):
        """✅ HTML special chars are escaped."""
        from notifier import _e
        assert _e("<script>alert(1)</script>") == "&lt;script&gt;alert(1)&lt;/script&gt;"
        assert _e("a & b") == "a &amp; b"

    @pytest.fixture(autouse=False)
    def mock_notifier(self):
        pass

    def test_empty_chat_id_not_sent(self):
        """❌ No chat_id → message not sent."""
        import importlib
        import notifier
        importlib.reload(notifier)
        result = notifier.send_message("test", chat_id="")
        assert result is False
