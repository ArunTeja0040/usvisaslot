from __future__ import annotations

import os
import random
import time
from datetime import datetime, date
from playwright.sync_api import Page
from config import BASE_URL, SCREENSHOTS_DIR, POLL_DELAY_MIN, POLL_DELAY_MAX
from models import UserProfile, BookingResult
from notifier import (
    notify_checking_ofc,
    notify_ofc_slot_found,
    notify_ofc_booked,
    notify_no_slots,
    notify_error,
)

_running = True


def set_running(value: bool):
    global _running
    _running = value


def book_ofc(page: Page, user: UserProfile) -> BookingResult | None:
    """
    OFC (Biometric) Appointment Booking.

    URL pattern: /ofc-schedule/...
    Uses jQuery UI datepicker calendar with green dates.
    Polls by re-selecting consulate from #post_select dropdown.
    """
    chat_id = user.telegram_chat_id

    # Navigate to OFC booking page
    current_url = page.url.lower()
    if "ofc-schedule" not in current_url:
        page.goto(f"{BASE_URL}/ofc-schedule", wait_until="domcontentloaded", timeout=20000)
    page.wait_for_timeout(random.randint(1000, 2000))

    # Wait for the consulate dropdown to appear
    try:
        page.wait_for_selector("#post_select", timeout=15000)
    except Exception:
        notify_error(user.name, "Consulate dropdown (#post_select) not found on OFC page", chat_id)
        return None

    # Check for group members panel (applicant readiness)
    _wait_for_group_members(page, user)

    poll_count = 0
    while _running:
        poll_count += 1

        for consulate in user.preferred_consulates:
            if not _running:
                return None

            if poll_count == 1 or poll_count % 10 == 0:
                notify_checking_ofc(user.name, consulate, chat_id)
            else:
                print(f"[OFC] {user.name} — Poll #{poll_count}: checking {consulate}...")

            result = _select_consulate_and_book(page, user, consulate)
            if result and result.ofc_confirmed:
                return result

        # Check for errors (maxed out, etc.)
        if _check_error_row(page, user):
            return None

        # No matching slots — wait and re-poll via DOM (no refresh)
        delay = random.randint(POLL_DELAY_MIN, POLL_DELAY_MAX)
        print(f"[OFC] {user.name} — No matching slots. Re-checking in {delay}s (no refresh)...")
        _interruptible_sleep(delay)

        if _session_expired(page):
            print(f"[OFC] {user.name} — Session expired during polling")
            notify_error(user.name, "Session expired while checking OFC slots", chat_id)
            return None

    return None


def _wait_for_group_members(page: Page, user: UserProfile, timeout: int = 10000):
    """Wait for group members / applicant panel to load."""
    try:
        gm_select = page.locator("#gm_select")
        if gm_select.count() > 0:
            gm_select.wait_for(state="visible", timeout=timeout)
            labels = page.locator("#gm_select .list-group-item label").all()
            names = [l.inner_text().strip() for l in labels]
            print(f"[OFC] {user.name} — Applicants: {', '.join(names)}")
    except Exception:
        print(f"[OFC] {user.name} — Group members panel not found, proceeding...")


def _select_consulate_and_book(page: Page, user: UserProfile, consulate: str) -> BookingResult | None:
    """Select a consulate from dropdown, wait for calendar, check for matching dates."""
    chat_id = user.telegram_chat_id
    try:
        dropdown = page.locator("#post_select")
        if dropdown.count() == 0:
            return None

        # Select consulate by matching option text
        options = dropdown.locator("option").all()
        matched = False
        for opt in options:
            text = opt.inner_text().strip()
            if consulate.upper() in text.upper():
                dropdown.select_option(value=opt.get_attribute("value"))
                matched = True
                break

        if not matched:
            print(f"[OFC] {user.name} — Consulate '{consulate}' not in dropdown")
            return None

        # Dispatch change event to trigger calendar update
        dropdown.dispatch_event("change")
        page.wait_for_timeout(random.randint(2000, 4000))

        # Wait for datepicker to become ready
        if not _wait_for_datepicker(page):
            return None

        # Wait for month/year selects to have options
        if not _wait_for_calendar_options(page):
            return None

        # Check for green (available) dates
        return _check_and_book_date(page, user, consulate)

    except Exception as e:
        notify_error(user.name, f"OFC booking error at {consulate}: {e}", chat_id)
        _save_screenshot(page, user, "ofc_error")
        return None


def _wait_for_datepicker(page: Page, timeout: int = 12000) -> bool:
    """Wait for #datepicker to have the 'hasDatepicker' class (jQuery UI ready)."""
    try:
        start = time.time()
        while time.time() - start < timeout / 1000:
            dp = page.locator("#datepicker")
            if dp.count() > 0:
                classes = dp.get_attribute("class") or ""
                if "hasDatepicker" in classes:
                    page.wait_for_timeout(1000)
                    return True
            time.sleep(1)
    except Exception:
        pass
    return False


def _wait_for_calendar_options(page: Page, timeout: int = 15000) -> bool:
    """Wait for month and year selects to have loaded options."""
    try:
        month_sel = page.locator(".ui-datepicker-group-first .ui-datepicker-month")
        year_sel = page.locator(".ui-datepicker-group-first .ui-datepicker-year")

        start = time.time()
        while time.time() - start < timeout / 1000:
            if month_sel.count() > 0 and year_sel.count() > 0:
                return True
            time.sleep(0.5)
    except Exception:
        pass
    return False


def _check_and_book_date(page: Page, user: UserProfile, consulate: str) -> BookingResult | None:
    """Scan the datepicker calendar for green (available) dates within user's range."""
    chat_id = user.telegram_chat_id

    # Navigate calendar to the correct month/year for user's date range
    _navigate_calendar_to_range(page, user)

    # Look for green dates in all visible calendar groups
    for group_selector in [".ui-datepicker-group-first", ".ui-datepicker-group-last"]:
        group = page.locator(group_selector)
        if group.count() == 0:
            continue

        # Get the month/year displayed in this group
        month_text = _get_text(group.locator(".ui-datepicker-month"))
        year_text = _get_text(group.locator(".ui-datepicker-year"))

        # Find green (available) dates
        green_dates = group.locator(".greenday a").all()
        if not green_dates:
            # Fallback: try non-unselectable dates
            calendar = group.locator(".ui-datepicker-calendar")
            if calendar.count() > 0:
                green_dates = calendar.locator("td:not(.ui-datepicker-unselectable) a").all()

        if not green_dates:
            continue

        for date_link in green_dates:
            day_num = date_link.get_attribute("data-date") or date_link.inner_text().strip()
            if not day_num:
                continue

            # Build full date and check against user's range
            full_date = _build_date(day_num, month_text, year_text)
            if not full_date:
                continue
            if not (user.date_range_start <= full_date <= user.date_range_end):
                continue

            date_str = full_date.isoformat()
            notify_ofc_slot_found(user.name, consulate, date_str, "checking times...", chat_id)

            # Click the date
            date_link.click()
            page.wait_for_timeout(random.randint(1000, 2000))

            # Select a time slot
            time_text = _select_time_slot(page)
            if not time_text:
                print(f"[OFC] {user.name} — No time slots for {date_str} at {consulate}")
                continue

            notify_ofc_slot_found(user.name, consulate, date_str, time_text, chat_id)

            # Submit
            if not _submit_booking(page):
                notify_error(user.name, "Could not submit OFC booking", chat_id)
                return None

            # Verify
            if _verify_booking_success(page):
                _save_screenshot(page, user, "ofc_confirmed")
                notify_ofc_booked(user.name, consulate, date_str, time_text, chat_id)
                result = BookingResult(user=user, consulate=consulate)
                result.ofc_date = date_str
                result.ofc_time = time_text
                result.ofc_confirmed = True
                return result
            else:
                notify_error(user.name, f"OFC submit did not confirm at {consulate}", chat_id)
                _save_screenshot(page, user, "ofc_submit_failed")
                return None

    return None


def _navigate_calendar_to_range(page: Page, user: UserProfile):
    """Navigate the datepicker calendar to show the user's preferred date range."""
    try:
        month_select = page.locator(".ui-datepicker-group-first .ui-datepicker-month")
        year_select = page.locator(".ui-datepicker-group-first .ui-datepicker-year")

        if month_select.count() == 0 or year_select.count() == 0:
            return

        target_month = user.date_range_start.month - 1  # jQuery UI months are 0-indexed
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
    """Select a random available time slot from #time_select radio buttons."""
    try:
        # Wait for time slots to appear
        start = time.time()
        while time.time() - start < 60:
            radios = page.locator('#time_select input[type="radio"]').all()
            if radios:
                chosen = random.choice(radios)
                chosen.click()

                # Get the time text from the parent row
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
    """Click #submitbtn and wait for it to be enabled first."""
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
    """Check if booking was successful by looking for confirmation indicators."""
    try:
        page_text = page.inner_text("body").lower()
        success_words = ["confirmed", "successfully", "booked", "scheduled", "appointment confirmed"]
        if any(word in page_text for word in success_words):
            return True
        # Check if navigated to confirmation page
        if "appointment-confirmation" in page.url.lower():
            return True
    except Exception:
        pass
    return False


def _check_error_row(page: Page, user: UserProfile) -> bool:
    """Check for error messages on the booking page."""
    try:
        error_row = page.locator("#error_row")
        if error_row.count() > 0 and error_row.first.is_visible():
            error_text = error_row.first.inner_text().strip()
            if error_text:
                if "maximum" in error_text.lower() or "exceeded" in error_text.lower():
                    notify_error(user.name, f"Maxed out: {error_text}", user.telegram_chat_id)
                    return True
                print(f"[OFC] {user.name} — Error row: {error_text}")
    except Exception:
        pass
    return False


def _session_expired(page: Page) -> bool:
    """Detect session expiry from current DOM state."""
    try:
        url = page.url.lower()
        if "b2clogin.com" in url or "/sign-in" in url or "login" in url:
            return True
        # Check for session timeout modals
        page_text = page.inner_text("body").lower()
        if "session expired" in page_text or "please login" in page_text:
            return True
    except Exception:
        pass
    return False


def _get_text(locator) -> str:
    try:
        if locator.count() > 0:
            # Could be a <select> (use value) or a <span> (use text)
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
            month = int(month_str) + 1  # jQuery UI 0-indexed
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
        print(f"[OFC] Screenshot saved: {path}")
    except Exception:
        pass
