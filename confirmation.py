from __future__ import annotations

import os
import random
from datetime import datetime
from playwright.sync_api import Page
from config import SCREENSHOTS_DIR, DOWNLOADS_DIR
from models import UserProfile, BookingResult
from notifier import notify_booking_complete, notify_error


def handle_confirmation(page: Page, user: UserProfile, booking: BookingResult) -> bool:
    """
    Step 6: Confirmation Page.

    URL pattern: /appointment-confirmation/...
    Parses appointment details from table rows, downloads/screenshots confirmation.
    """
    chat_id = user.telegram_chat_id

    if not booking.ofc_confirmed or not booking.interview_confirmed:
        notify_error(user.name, "Cannot access confirmation — OFC or Interview not confirmed", chat_id)
        return False

    try:
        page.wait_for_timeout(random.randint(1000, 2000))

        if not _is_confirmation_page(page):
            notify_error(user.name, "Not on confirmation page after booking", chat_id)
            _save_screenshot(page, user, "not_confirmation_page")
            return False

        # Parse appointment details from confirmation table
        details = _parse_confirmation_details(page)
        if details:
            print(f"[Confirmation] {user.name} — Appointment details: {details}")

        # Take a screenshot of the confirmation
        _save_screenshot(page, user, "confirmation")

        # Download the confirmation document
        download_path = _download_confirmation(page, user)
        if download_path:
            booking.confirmation_downloaded = True
            booking.download_path = download_path

        notify_booking_complete(user.name, chat_id, download_path)

        print(f"[Confirmation] {user.name} — Complete! Document: {download_path or 'screenshot only'}")
        return True

    except Exception as e:
        notify_error(user.name, f"Confirmation page error: {e}", chat_id)
        _save_screenshot(page, user, "confirmation_error")
        return False


def _is_confirmation_page(page: Page) -> bool:
    """Check if we're on the confirmation page."""
    if "appointment-confirmation" in page.url.lower():
        return True
    try:
        page_text = page.inner_text("body").lower()
        return any(w in page_text for w in ["confirmation", "confirmed", "your appointment", "appointment number"])
    except Exception:
        return False


def _parse_confirmation_details(page: Page) -> dict:
    """Parse appointment details from the confirmation table rows."""
    details = {}
    try:
        rows = page.locator("table tr.border-bottom").all()
        for row in rows:
            cells = row.locator("td").all()
            if len(cells) >= 2:
                label = cells[0].inner_text().strip().rstrip(":")
                value = cells[1].inner_text().strip()
                if label and value:
                    details[label] = value
    except Exception:
        pass
    return details


def _download_confirmation(page: Page, user: UserProfile) -> str:
    """Download confirmation document or fall back to PDF/screenshot."""
    safe_name = user.name.replace(" ", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Try clicking download/print buttons
    download_selectors = [
        'button:has-text("Download")',
        'a:has-text("Download")',
        'button:has-text("Print")',
        'a:has-text("Print")',
        'a[href*="download"]',
        'a[href*="print"]',
        ".download-btn",
        ".print-btn",
    ]

    for sel in download_selectors:
        try:
            btn = page.locator(sel).first
            if btn.count() > 0 and btn.is_visible():
                with page.expect_download(timeout=15000) as download_info:
                    btn.click()
                download = download_info.value
                filename = f"confirmation_{safe_name}_{timestamp}_{download.suggested_filename}"
                save_path = os.path.join(DOWNLOADS_DIR, filename)
                download.save_as(save_path)
                print(f"[Confirmation] {user.name} — Downloaded: {save_path}")
                return save_path
        except Exception:
            continue

    # Fallback: save page as PDF (headless Chromium only)
    try:
        pdf_path = os.path.join(DOWNLOADS_DIR, f"confirmation_{safe_name}_{timestamp}.pdf")
        page.pdf(path=pdf_path, format="A4", print_background=True)
        print(f"[Confirmation] {user.name} — Saved as PDF: {pdf_path}")
        return pdf_path
    except Exception:
        pass

    # Last resort: screenshot
    screenshot_path = os.path.join(DOWNLOADS_DIR, f"confirmation_{safe_name}_{timestamp}.png")
    try:
        page.screenshot(path=screenshot_path, full_page=True)
        return screenshot_path
    except Exception:
        return ""


def _save_screenshot(page: Page, user: UserProfile, label: str) -> str:
    safe_name = user.name.replace(" ", "_")
    filename = f"{label}_{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    path = os.path.join(SCREENSHOTS_DIR, filename)
    try:
        page.screenshot(path=path, full_page=True)
        print(f"[Confirmation] Screenshot saved: {path}")
    except Exception:
        return ""
    return path
