from __future__ import annotations

import random
from playwright.sync_api import Page
from config import BASE_URL
from models import UserProfile
from notifier import notify_error


def navigate_to_schedule(page: Page, user: UserProfile) -> bool:
    """
    Dashboard: detect and click either "Reschedule Appointment" or
    "Continue Application" (Schedule), then proceed to booking page.
    """
    chat_id = user.telegram_chat_id
    try:
        page.wait_for_timeout(random.randint(1000, 2000))

        # Check for rate limit / maxed out warning
        warning = page.locator(".alert-warning.warning")
        if warning.count() > 0 and warning.first.is_visible():
            warning_text = warning.first.inner_text().strip().lower()
            if "exceeded" in warning_text or "maximum" in warning_text:
                notify_error(user.name, f"Rate limited: {warning_text}", chat_id)
                return False

        # Wait for dashboard to load — look for page title
        page.wait_for_selector("#pagetitle", timeout=15000)

        # Try Reschedule first, then Continue/Schedule
        reschedule_btn = page.locator("#reschedule_appointment")
        continue_btn = page.locator("#continue_application")

        if reschedule_btn.count() > 0 and reschedule_btn.is_visible():
            print(f"[Dashboard] {user.name} — Found 'Reschedule Appointment', clicking...")
            reschedule_btn.click()
        elif continue_btn.count() > 0 and continue_btn.is_visible():
            print(f"[Dashboard] {user.name} — Found 'Continue Application', clicking...")
            continue_btn.click()
        else:
            # Fallback: look in sidebar navigation
            sidebar = page.locator("#ctl00_nav_side1")
            if sidebar.count() > 0:
                links = sidebar.locator("a").all()
                for link in links:
                    text = link.inner_text().strip().lower()
                    if "continue" in text or "schedule" in text or "reschedule" in text:
                        print(f"[Dashboard] {user.name} — Found sidebar link '{text}', clicking...")
                        link.click()
                        break
                else:
                    notify_error(user.name, "No Schedule/Reschedule button found on dashboard", chat_id)
                    return False
            else:
                notify_error(user.name, "No Schedule/Reschedule button found on dashboard", chat_id)
                return False

        page.wait_for_load_state("domcontentloaded", timeout=15000)
        page.wait_for_timeout(random.randint(1000, 2000))

        print(f"[Dashboard] {user.name} — Navigated to: {page.url}")
        return True

    except Exception as e:
        notify_error(user.name, f"Dashboard navigation error: {e}", chat_id)
        return False
