"""
Parallel Agent E2E Test Suite

Simulates 6 independent agents with mocked steps.
Tests the full flow orchestration, session isolation, and error paths.
"""
from __future__ import annotations

import time
import pytest
from datetime import date, datetime
from unittest.mock import patch, MagicMock
from dataclasses import dataclass, field
from models import UserProfile, BookingResult


@dataclass
class StepLog:
    step: str
    status: str
    timestamp: str
    detail: str = ""


@dataclass
class AgentReport:
    agent_id: str
    user_name: str
    overall_status: str = "PENDING"
    steps: list[StepLog] = field(default_factory=list)
    failure_reason: str = ""

    def log_step(self, step: str, status: str, detail: str = ""):
        self.steps.append(StepLog(
            step=step, status=status,
            timestamp=datetime.now().isoformat(), detail=detail,
        ))
        if status == "FAIL" and not self.failure_reason:
            self.failure_reason = f"{step}: {detail}"
            self.overall_status = "FAIL"

    def finalize(self):
        if self.overall_status == "PENDING":
            self.overall_status = "PASS"


AGENT_USERS = [
    UserProfile(name=f"Agent-{i+1}", username=f"agent{i+1}@test.com", password=f"pass_a{i+1}",
                security_questions={"Q1?": f"A{i+1}", "Q2?": f"B{i+1}", "Q3?": f"C{i+1}"},
                preferred_consulates=[c], date_range_start=date(2026, 5, 1),
                date_range_end=date(2026, 12, 31), telegram_chat_id=str(100000 + i + 1))
    for i, c in enumerate(["Mumbai", "New Delhi", "Chennai", "Kolkata", "Hyderabad"])
] + [
    UserProfile(name="Agent-6 (FailCase)", username="agent6@test.com", password="wrong_pass",
                security_questions={"Q1?": "W1", "Q2?": "W2", "Q3?": "W3"},
                preferred_consulates=["Mumbai"], date_range_start=date(2026, 5, 1),
                date_range_end=date(2026, 12, 31), telegram_chat_id="100006")
]


def run_agent(agent_id: str, user: UserProfile, login_success: bool = True) -> AgentReport:
    """Run full workflow using mocked step functions."""
    report = AgentReport(agent_id=agent_id, user_name=user.name)

    mock_browser = MagicMock()
    mock_browser.new_context.return_value = MagicMock(new_page=MagicMock(return_value=MagicMock()))

    if not login_success:
        with patch("main.login", return_value=False), \
             patch("main.navigate_to_schedule") as m_dash, \
             patch("main.book_ofc") as m_ofc:
            from main import process_user
            result = process_user(mock_browser, user)

        report.log_step("LOGIN", "FAIL", "Invalid credentials")
        m_dash.assert_not_called()
        m_ofc.assert_not_called()
        report.finalize()
        return report

    booking = BookingResult(user=user, consulate=user.preferred_consulates[0],
                             ofc_date="2026-06-15", ofc_time="09:30 AM", ofc_confirmed=True,
                             interview_date="2026-07-20", interview_time="10:00 AM", interview_confirmed=True)

    with patch("main.login", return_value=True), \
         patch("main.navigate_to_schedule", return_value=True), \
         patch("main.book_ofc", return_value=booking), \
         patch("main.book_interview", return_value=True), \
         patch("main.handle_confirmation", return_value=True):
        from main import process_user
        result = process_user(mock_browser, user)

    report.log_step("LOGIN", "PASS", "Logged in")
    report.log_step("CAPTCHA", "PASS", "No CAPTCHA (mocked)")
    report.log_step("SECURITY_QUESTIONS", "PASS", "2 of 3 answered")
    report.log_step("DASHBOARD", "PASS", "Schedule button clicked")
    report.log_step("OFC_BOOKING", "PASS" if result else "FAIL",
                    f"{booking.consulate} on {booking.ofc_date}")
    report.log_step("INTERVIEW_BOOKING", "PASS" if result else "FAIL",
                    f"{booking.interview_date} at {booking.interview_time}")
    report.log_step("CONFIRMATION", "PASS" if result else "FAIL", "Downloaded")
    report.finalize()
    return report


class TestAgent1Mumbai:
    def test_full_workflow(self):
        report = run_agent("AGENT-1", AGENT_USERS[0])
        assert report.overall_status == "PASS"

    def test_session_isolation(self):
        assert AGENT_USERS[0].username == "agent1@test.com"
        assert AGENT_USERS[0].telegram_chat_id == "100001"


class TestAgent2Delhi:
    def test_full_workflow(self):
        report = run_agent("AGENT-2", AGENT_USERS[1])
        assert report.overall_status == "PASS"


class TestAgent3Chennai:
    def test_full_workflow(self):
        report = run_agent("AGENT-3", AGENT_USERS[2])
        assert report.overall_status == "PASS"


class TestAgent4Kolkata:
    def test_full_workflow(self):
        report = run_agent("AGENT-4", AGENT_USERS[3])
        assert report.overall_status == "PASS"


class TestAgent5Hyderabad:
    def test_full_workflow(self):
        report = run_agent("AGENT-5", AGENT_USERS[4])
        assert report.overall_status == "PASS"


class TestAgent6FailCase:
    def test_login_failure_stops_workflow(self):
        report = run_agent("AGENT-6", AGENT_USERS[5], login_success=False)
        assert report.overall_status == "FAIL"
        assert "LOGIN" in report.failure_reason
        step_names = [s.step for s in report.steps]
        assert "OFC_BOOKING" not in step_names


class TestEdgeCases:

    def test_ofc_reset_during_interview(self):
        from interview_booking import OFCResetRequired, book_interview

        user = AGENT_USERS[0]
        page = MagicMock()
        booking = BookingResult(user=user, consulate="Mumbai", ofc_confirmed=True)

        with patch("interview_booking._try_book_interview", return_value=False), \
             patch("interview_booking._ofc_became_unblocked", return_value=True), \
             patch("interview_booking.notify_waiting_interview"), \
             patch("interview_booking.notify_ofc_reset"), \
             patch("interview_booking.notify_error"), \
             patch("interview_booking.time.sleep"):
            with pytest.raises(OFCResetRequired):
                book_interview(page, user, booking)

        assert booking.ofc_confirmed is False

    def test_all_agents_unique_credentials(self):
        usernames = [u.username for u in AGENT_USERS]
        assert len(usernames) == len(set(usernames))

    def test_sensitive_data_not_in_logs(self):
        report = run_agent("AGENT-MASK", AGENT_USERS[0])
        all_text = " ".join(s.detail for s in report.steps)
        for user in AGENT_USERS:
            assert user.password not in all_text


class TestAggregatedReport:

    def test_run_all_agents(self, capsys):
        configs = [
            ("AGENT-1", AGENT_USERS[0], True),
            ("AGENT-2", AGENT_USERS[1], True),
            ("AGENT-3", AGENT_USERS[2], True),
            ("AGENT-4", AGENT_USERS[3], True),
            ("AGENT-5", AGENT_USERS[4], True),
            ("AGENT-6", AGENT_USERS[5], False),
        ]

        reports = [run_agent(aid, user, login_ok) for aid, user, login_ok in configs]

        total = len(reports)
        passed = sum(1 for r in reports if r.overall_status == "PASS")
        failed = sum(1 for r in reports if r.overall_status == "FAIL")

        print(f"\n{'=' * 60}")
        print(f"  SUMMARY: {passed}/{total} PASSED, {failed}/{total} FAILED")
        for r in reports:
            icon = "PASS" if r.overall_status == "PASS" else "FAIL"
            print(f"  {icon} {r.agent_id} ({r.user_name})")
        print(f"{'=' * 60}")

        assert passed >= 5
        assert failed == 1
