"""
STEP 3 — DASHBOARD TESTS

✅ Reschedule button found → clicks it
✅ Continue/Schedule button found → clicks it
❌ Neither button found → fails
❌ Rate limit warning → fails
❌ Not accessible without login
"""
from __future__ import annotations

import pytest
from unittest.mock import patch
from tests.conftest import MockPage, MockLocator


class TestStep3Dashboard:

    def test_reschedule_button_clicks(self, test_user):
        """✅ #reschedule_appointment found → clicks it."""
        from dashboard import navigate_to_schedule

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/dashboard"
        page.set_locator("#pagetitle", MockLocator(visible=True, count=1, text="Apply for a U.S. Visa:"))

        btn = MockLocator(visible=True, count=1, text="Reschedule Appointment")
        btn.click = lambda: setattr(page, 'url', 'https://www.usvisascheduling.com/ofc-schedule')
        page.set_locator("#reschedule_appointment", btn)

        with patch("dashboard.notify_error"):
            result = navigate_to_schedule(page, test_user)

        assert result is True

    def test_continue_button_clicks(self, test_user):
        """✅ #continue_application found → clicks it."""
        from dashboard import navigate_to_schedule

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/dashboard"
        page.set_locator("#pagetitle", MockLocator(visible=True, count=1, text="Apply for a U.S. Visa:"))

        btn = MockLocator(visible=True, count=1, text="Continue Application")
        btn.click = lambda: setattr(page, 'url', 'https://www.usvisascheduling.com/ofc-schedule')
        page.set_locator("#continue_application", btn)

        with patch("dashboard.notify_error"):
            result = navigate_to_schedule(page, test_user)

        assert result is True

    def test_no_buttons_fails(self, test_user):
        """❌ Neither button found → fails."""
        from dashboard import navigate_to_schedule

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/dashboard"
        page.set_locator("#pagetitle", MockLocator(visible=True, count=1, text="Apply for a U.S. Visa:"))

        with patch("dashboard.notify_error") as mock_err:
            result = navigate_to_schedule(page, test_user)

        assert result is False
        mock_err.assert_called()

    def test_rate_limit_warning_fails(self, test_user):
        """❌ Rate limit warning → fails."""
        from dashboard import navigate_to_schedule

        page = MockPage()
        page.set_locator("#pagetitle", MockLocator(visible=True, count=1))
        page.set_locator(".alert-warning", MockLocator(
            visible=True, count=1, text="You have exceeded the limit"
        ))

        with patch("dashboard.notify_error") as mock_err:
            result = navigate_to_schedule(page, test_user)

        assert result is False

    def test_not_accessible_without_login(self, test_user):
        """❌ Redirects to login page → re-login attempted."""
        from login import ensure_logged_in

        page = MockPage()

        def goto_redirect(url, **kwargs):
            page.url = "https://atlasauth.b2clogin.com/sign-in"

        page.goto = goto_redirect

        with patch("login.login", return_value=False) as mock_login, \
             patch("login.notify_error"):
            result = ensure_logged_in(page, test_user)

        assert result is False
        mock_login.assert_called_once()
