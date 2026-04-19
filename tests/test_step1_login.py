"""
STEP 1 — LOGIN PAGE TESTS (Azure B2C)

✅ Valid username + password + no CAPTCHA → proceeds to security questions
❌ CAPTCHA not completed → block login
❌ Wrong credentials → show error via #claimVerificationServerError
"""
from __future__ import annotations

import pytest
from unittest.mock import patch
from tests.conftest import MockPage, MockLocator
from models import UserProfile
from datetime import date


@pytest.fixture
def login_user():
    return UserProfile(
        name="Login Test",
        username="test@example.com",
        password="pass123",
        security_questions={
            "What is your mother's maiden name?": "Smith",
            "What city were you born in?": "Mumbai",
            "What is the name of your first pet?": "Rex",
        },
        preferred_consulates=["Mumbai"],
        date_range_start=date(2026, 5, 1),
        date_range_end=date(2026, 12, 31),
        telegram_chat_id="123",
    )


class TestStep1Login:

    def test_valid_login_proceeds(self, login_user):
        """✅ Valid credentials + no CAPTCHA → proceeds past login page."""
        from login import _step1_login

        page = MockPage()
        page.url = "https://atlasauth.b2clogin.com/login"
        page.set_locator("#signInName", MockLocator(visible=True, count=1))
        page.set_locator("#password", MockLocator(visible=True, count=1))

        # No CAPTCHA
        page.set_locator("#captchaImage", MockLocator(visible=False, count=0))

        # Continue button — clicking it changes URL
        continue_btn = MockLocator(visible=True, count=1)
        continue_btn.click = lambda: setattr(page, 'url', 'https://atlasauth.b2clogin.com/SelfAsserted/confirmed')
        page.set_locator("#continue", continue_btn)

        # No error
        page.set_locator("#claimVerificationServerError", MockLocator(visible=False, count=0, text=""))

        with patch("login.notify_login_failed"), patch("login.notify_error"):
            result = _step1_login(page, login_user)

        assert result is True

    def test_captcha_not_completed_blocks_login(self, login_user):
        """❌ CAPTCHA present but not solved → login blocked."""
        from login import _solve_captcha

        page = MockPage()
        page.set_locator("#captchaImage", MockLocator(visible=True, count=1))
        page.set_locator("#extension_atlasCaptchaResponse", MockLocator(visible=True, count=1, value=""))

        with patch("login.time.sleep"):
            result = _solve_captcha(page, login_user)

        assert result is False

    def test_no_captcha_proceeds(self, login_user):
        """✅ No CAPTCHA on page → proceeds immediately."""
        from login import _solve_captcha

        page = MockPage()
        page.set_locator("#captchaImage", MockLocator(visible=False, count=0))

        result = _solve_captcha(page, login_user)
        assert result is True

    def test_captcha_solved_manually(self, login_user):
        """✅ CAPTCHA solved manually → proceeds."""
        from login import _solve_captcha

        page = MockPage()
        page.set_locator("#captchaImage", MockLocator(visible=True, count=1))

        call_count = [0]

        class SolvingLocator(MockLocator):
            def input_value(self):
                call_count[0] += 1
                if call_count[0] > 3:
                    return "abc123"
                return ""

        page.set_locator("#extension_atlasCaptchaResponse", SolvingLocator(visible=True, count=1))

        with patch("login.time.sleep"):
            result = _solve_captcha(page, login_user)

        assert result is True

    def test_login_error_detected(self, login_user):
        """❌ Login error shown → fails with error message."""
        from login import _step1_login

        page = MockPage()
        page.url = "https://atlasauth.b2clogin.com/login"
        page.set_locator("#signInName", MockLocator(visible=True, count=1))
        page.set_locator("#password", MockLocator(visible=True, count=1))
        page.set_locator("#captchaImage", MockLocator(visible=False, count=0))

        continue_btn = MockLocator(visible=True, count=1)
        page.set_locator("#continue", continue_btn)

        # Error shown after submit
        page.set_locator("#claimVerificationServerError", MockLocator(
            visible=True, count=1, text="Invalid credentials"
        ))

        with patch("login.notify_login_failed") as mock_fail, patch("login.notify_error"):
            result = _step1_login(page, login_user)

        assert result is False
        mock_fail.assert_called()
