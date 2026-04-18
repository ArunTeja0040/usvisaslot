from __future__ import annotations

import os
import random
import time
from datetime import datetime, date
from playwright.sync_api import Page
from config import BASE_URL, SCREENSHOTS_DIR, INTERVIEW_WAIT_MINUTES, POLL_DELAY_MIN, POLL_DELAY_MAX
from models import UserProfile, BookingResult
from notifier import (
    notify_interview_slot_found,
    notify_interview_booked,
    notify_waiting_interview,
    notify_ofc_reset,
    notify_error,
)

_running = True


def set_running(value: bool):
    global _running
    _running = value


class OFCResetRequired(Exception):
    """Raised when OFC becomes unblocked during interview wait — must restart from Step 4."""
    pass


def book_interview(page: Page, user: UserProfile, booking: BookingResult) -> bool:
    """
    Step 5: Interview Booking.

    URL pattern: /schedule/... (not /ofc-schedule)
    Same jQuery UI datepicker + #post_select pattern as OFC.
    Polls by re-selecting consulate dropdown.
    """
    chat_id = user.telegram_chat_id

    if not booking.ofc_confirmed:
        notify_error(user.name, "Cannot book interview — OFC not confirmed", chat_id)
        return False

    # Navigate to interview page if not already there
    current_url = page.url.lower()
    if "schedule" not in current_url or "ofc-schedule" in current_url:
        page.goto(f"{BASE_URL}/schedule", wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(random.randint(1000, 2000))

    # Try immediately first
    result = _try_book_interview(page, user, booking)
    if result:
        return True

    # Edge case: dates not visible yet — poll within INTERVIEW_WAIT_MINUTES
    print(f"[Interview] {user.name} — No interview dates visible. Polling every {POLL_DELAY_MIN}-{POLL_DELAY_MAX}s...")
    notify_waiting_interview(user.name, INTERVIEW_WAIT_MINUTES, chat_id)

    start_time = time.time()
    max_wait = INTERVIEW_WAIT_MINUTES * 60
    poll_count = 0

    while time.time() - start_time < max_wait and _running:
        poll_count += 1
        elapsed_min = int((time.time() - start_time) / 60)
        remaining_min = INTERVIEW_WAIT_MINUTES - elapsed_min

        # Check if OFC became unblocked (needs restart from Step 4)
        if _ofc_became_unblocked(page, user):
            notify_ofc_reset(user.name, chat_id)
            booking.ofc_confirmed = False
            raise OFCResetRequired(f"{user.name} — OFC unblocked during interview wait")

        # Wait before re-polling
        delay = random.randint(POLL_DELAY_MIN, POLL_DELAY_MAX)
        print(f"[Interview] {user.name} — Poll #{poll_count}, {remaining_min} min remaining, next check in {delay}s...")
        _interruptible_sleep(delay)

        if not _running:
            return False

        # Re-trigger consulate dropdown to force calendar refresh
        _retrigger_consulate(page, user, booking)

        result = _try_book_interview(page, user, booking)
        if result:
            return True

    notify_error(user.name, f"Interview dates did not appear within {INTERVIEW_WAIT_MINUTES} min", chat_id)
    return False


def _retrigger_consulate(page: Page, user: UserProfile, booking: BookingResult):
    """Re-select the consulate dropdown to trigger calendar refresh without page reload."""
    try:
        dropdown = page.locator("#post_select")
        if dropdown.count() == 0:
            return

        # Find the option matching the booked consulate
        options = dropdown.locator("option").all()
        for opt in options:
            text = opt.inner_text().strip()
            if booking.consulate.upper() in text.upper():
                dropdown.select_option(value=opt.get_attribute("value"))
                dropdown.dispatch_event("change")
                page.wait_for_timeout(random.randint(2000, 4000))
                return
    except Exception:
        pass


def _try_book_interview(page: Page, user: UserProfile, booking: BookingResult) -> bool:
    """Single attempt to find and book an interview slot."""
    chat_id = user.telegram_chat_id
    consulate = booking.consulate

    try:
        # Wait for datepicker
        if not _wait_for_datepicker(page):
            return False

        # Wait for calendar options to load
        if not _wait_for_calendar_options(page):
            return False

        # Navigate calendar to user's preferred range
        _navigate_calendar_to_range(page, user)

        # Check for green dates in all visible groups
        for group_selector in [".ui-datepicker-group-first", ".ui-datepicker-group-last"]:
            group = page.locator(group_selector)
            if group.count() == 0:
                continue

            month_text = _get_text(group.locator(".ui-datepicker-month"))
            year_text = _get_text(group.locator(".ui-datepicker-year"))

            # Find available dates
            green_dates = group.locator(".greenday a").all()
            if not green_dates:
                calendar = group.locator(".ui-datepicker-calendar")
                if calendar.count() > 0:
                    green_dates = calendar.locator("td:not(.ui-datepicker-unselectable) a").all()

            if not green_dates:
                continue

            for date_link in green_dates:
                day_num = date_link.get_attribute("data-date") or date_link.inner_text().strip()
                if not day_num:
                    continue

                full_date = _build_date(day_num, month_text, year_text)
                if not full_date:
                    continue
                if not (user.date_range_start <= full_date <= user.date_range_end):
                    continue

                date_str = full_date.isoformat()

                # Click the date
                date_link.click()
                page.wait_for_timeout(random.randint(1000, 2000))

                # Select time slot
                time_text = _select_time_slot(page)
                if not time_text:
                    print(f"[Interview] {user.name} — No time slots for {date_str}")
                    continue

                notify_interview_slot_found(user.name, consulate, date_str, time_text, chat_id)

                # Submit
                if not _submit_booking(page):
                    notify_error(user.name, "Could not submit interview booking", chat_id)
                    return False

                # Verify
                if _verify_booking_success(page):
                    _save_screenshot(page, user, "interview_confirmed")
                    booking.interview_date = date_str
                    booking.interview_time = time_text
                    booking.interview_confirmed = True
                    notify_interview_booked(user.name, consulate, date_str, time_text, chat_id)
                    return True
                else:
                    notify_error(user.name, "Interview submit did not confirm", chat_id)
                    _save_screenshot(page, user, "interview_submit_failed")
                    return False

        return False

    except Exception as e:
        notify_error(user.name, f"Interview booking error: {e}", chat_id)
        _save_screenshot(page, user, "interview_error")
        return False


def _wait_for_datepicker(page: Page, timeout: int = 12000) -> bool:
    """Wait for #datepicker to have the 'hasDatepicker' class."""
    try:
        start = time.time()
        while time.time() - start < timeout / 1000:
            dp = page.locator("#datepicker")
            if dp.count() > 0:
                classes = dp.get_attribute("class") or ""
                if "hasDatepicker" in classes and dp.locator("> *").count() > 0:
                    page.wait_for_timeout(1000)
                    return True
            time.sleep(1)
    except Exception:
        pass
    return False


def _wait_for_calendar_options(page: Page, timeout: int = 15000) -> bool:
    """Wait for month and year selects to have loaded."""
    try:
        start = time.time()
        while time.time() - start < timeout / 1000:
            month = page.locator(".ui-datepicker-month")
            year = page.locator(".ui-datepicker-year")
            if month.count() > 0 and year.count() > 0:
                return True
            time.sleep(0.5)
    except Exception:
        pass
    return False


def _navigate_calendar_to_range(page: Page, user: UserProfile):
    """Navigate the datepicker to the user's preferred start month/year."""
    try:
        month_select = page.locator(".ui-datepicker-group-first .ui-datepicker-month")
        year_select = page.locator(".ui-datepicker-group-first .ui-datepicker-year")

        if month_select.count() == 0 or year_select.count() == 0:
            return

        target_month = user.date_range_start.month - 1
        target_year = user.date_range_start.year

        current_month = month_select.input_value() if month_select.count() > 0 else None
        current_year = year_select.input_value() if year_select.count() > 0 else None

        if current_month is not None and int(current_month) != target_month:
            month_select.select_option(value=str(target_month))
            month_select.dispatch_event("change")
            page.wait_for_timeout(600)

        if current_year is not None and int(current_year) != target_year:
            year_select.select_option(value=str(target_year))
            year_select.dispatch_event("change")
            page.wait_for_timeout(600)

    except Exception:
        pass


def _select_time_slot(page: Page) -> str | None:
    """Select a random time slot from #time_select radio buttons."""
    try:
        start = time.time()
        while time.time() - start < 60:
            radios = page.locator('#time_select input[type="radio"]').all()
            if radios:
                chosen = random.choice(radios)
                chosen.click()

                row = chosen.locator("xpath=ancestor::tr[1]")
                time_cell = row.locator("td:nth-child(2) div")
                time_text = time_cell.inner_text().strip() if time_cell.count() > 0 else "Selected"

                page.wait_for_timeout(random.randint(500, 1000))
                return time_text
            time.sleep(1)
    except Exception:
        pass
    return None


def _submit_booking(page: Page) -> bool:
    """Click #submitbtn when enabled."""
    try:
        start = time.time()
        while time.time() - start < 15:
            submit_btn = page.locator("#submitbtn")
            if submit_btn.count() > 0 and submit_btn.is_enabled():
                submit_btn.dispatch_event("click")
                page.wait_for_load_state("domcontentloaded", timeout=15000)
                page.wait_for_timeout(2000)
                return True
            time.sleep(1)
    except Exception:
        pass
    return False


def _verify_booking_success(page: Page) -> bool:
    try:
        page_text = page.inner_text("body").lower()
        if any(w in page_text for w in ["confirmed", "successfully", "booked", "scheduled"]):
            return True
        if "appointment-confirmation" in page.url.lower():
            return True
    except Exception:
        pass
    return False


def _ofc_became_unblocked(page: Page, user: UserProfile) -> bool:
    """Check if OFC booking has been reset during the interview wait."""
    try:
        error_row = page.locator("#error_row")
        if error_row.count() > 0 and error_row.first.is_visible():
            text = error_row.first.inner_text().strip().lower()
            if "ofc" in text and ("pending" in text or "not confirmed" in text or "reset" in text):
                return True
        # Check page text for pending/unblocked indicators
        page_text = page.inner_text("body").lower()
        if "ofc appointment: pending" in page_text:
            return True
    except Exception:
        pass
    return False


def _get_text(locator) -> str:
    try:
        if locator.count() > 0:
            tag = locator.evaluate("el => el.tagName")
            if tag == "SELECT":
                return locator.locator("option:checked").inner_text().strip()
            return locator.inner_text().strip()
    except Exception:
        pass
    return ""


MONTH_MAP = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}


def _build_date(day_str: str, month_str: str, year_str: str) -> date | None:
    try:
        day = int(day_str)
        month = MONTH_MAP.get(month_str.lower().strip())
        if month is None:
            month = int(month_str) + 1
        year = int(year_str)
        return date(year, month, day)
    except (ValueError, TypeError):
        return None


def _interruptible_sleep(seconds: int):
    elapsed = 0
    while elapsed < seconds and _running:
        time.sleep(1)
        elapsed += 1


def _save_screenshot(page: Page, user: UserProfile, label: str):
    safe_name = user.name.replace(" ", "_")
    filename = f"{label}_{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    path = os.path.join(SCREENSHOTS_DIR, filename)
    try:
        page.screenshot(path=path, full_page=True)
        print(f"[Interview] Screenshot saved: {path}")
    except Exception:
        pass
