"""
STEP 2 — SECURITY QUESTIONS TESTS (Azure B2C)

✅ Correct answers → proceeds to dashboard
✅ Questions matched via substring
❌ Unrecognized question → returns None
✅ Questions randomly picked from 3
"""
from __future__ import annotations

import pytest
import itertools
from unittest.mock import patch
from tests.conftest import MockPage, MockLocator
from models import UserProfile
from datetime import date


@pytest.fixture
def sec_user():
    return UserProfile(
        name="Security Test",
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


class TestStep2SecurityQuestions:

    def test_match_answer_exact_match(self, sec_user):
        """✅ _match_answer finds exact question matches."""
        from login import _match_answer

        assert _match_answer("What is your mother's maiden name?", sec_user.security_questions) == "Smith"
        assert _match_answer("What city were you born in?", sec_user.security_questions) == "Mumbai"
        assert _match_answer("What is the name of your first pet?", sec_user.security_questions) == "Rex"

    def test_match_answer_substring_match(self, sec_user):
        """✅ _match_answer handles substring matching."""
        from login import _match_answer

        result = _match_answer("mother's maiden name", sec_user.security_questions)
        assert result == "Smith"

    def test_match_answer_no_match_returns_none(self, sec_user):
        """❌ Unrecognized question returns None."""
        from login import _match_answer

        result = _match_answer("What is your favorite color?", sec_user.security_questions)
        assert result is None

    def test_questions_randomly_picked(self, sec_user):
        """✅ Any 2-of-3 combination has matching answers."""
        from login import _match_answer

        all_questions = list(sec_user.security_questions.keys())
        assert len(all_questions) == 3

        for combo in itertools.combinations(all_questions, 2):
            for q in combo:
                answer = _match_answer(q, sec_user.security_questions)
                assert answer is not None, f"No answer found for: {q}"

    def test_empty_answers_fail(self, sec_user):
        """❌ Unknown question → cannot proceed."""
        from login import _match_answer

        result = _match_answer("Unknown question not in user profile?", sec_user.security_questions)
        assert result is None

    def test_is_dashboard_detection(self, sec_user):
        """✅ Dashboard detected by #pagetitle or button IDs."""
        from login import _is_dashboard

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/dashboard"
        page.set_locator("#pagetitle", MockLocator(visible=True, count=1, text="Apply for a U.S. Visa:"))

        assert _is_dashboard(page) is True

    def test_is_dashboard_with_reschedule(self, sec_user):
        """✅ Dashboard detected by #reschedule_appointment."""
        from login import _is_dashboard

        page = MockPage()
        page.url = "https://www.usvisascheduling.com/dashboard"
        page.set_locator("#reschedule_appointment", MockLocator(visible=True, count=1))

        assert _is_dashboard(page) is True

    def test_b2c_page_is_not_dashboard(self, sec_user):
        """❌ B2C login page is not dashboard."""
        from login import _is_dashboard

        page = MockPage()
        page.url = "https://atlasauth.b2clogin.com/something"

        assert _is_dashboard(page) is False
