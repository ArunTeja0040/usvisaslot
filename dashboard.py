from __future__ import annotations

import random
import time
from playwright.sync_api import Page
from config import BASE_URL
from models import UserProfile
from notifier import notify_error


def find_schedule_button(page: Page, user: UserProfile) -> str | None:
    """Find the schedule/reschedule button and return its CSS selector."""
    try:
        page.wait_for_timeout(random.randint(1000, 2000))

        # Debug: what's on the page?
        try:
            body_text = page.locator("body").inner_text()[:300].strip()
            print(f"[Dashboard] {user.name} — Body: '{body_text[:150]}...'")
        except Exception:
            pass

        # Check for rate limit
        warning = page.locator(".alert-warning.warning")
        if warning.count() > 0 and warning.first.is_visible():
            warning_text = warning.first.inner_text().strip().lower()
            print(f"[Dashboard] {user.name} — Warning: {warning_text}")
            if "exceeded" in warning_text or "maximum" in warning_text:
                notify_error(user.name, f"Rate limited: {warning_text}", user.telegram_chat_id)
                return None

        # Wait for dashboard
        print(f"[Dashboard] {user.name} — Waiting for #pagetitle...")
        try:
            page.wait_for_selector("#pagetitle", timeout=15000)
            pagetitle_text = page.locator("#pagetitle").inner_text().strip()
            print(f"[Dashboard] {user.name} — #pagetitle: '{pagetitle_text}'")
        except Exception as e:
            print(f"[Dashboard] {user.name} — #pagetitle not found: {e}")

        max_button_wait = 20
        print(f"[Dashboard] {user.name} — Polling for action buttons (up to {max_button_wait}s)...")
        for wait_i in range(max_button_wait):
            reschedule_btn = page.locator("#reschedule_appointment")
            continue_btn = page.locator("#continue_application")
            r_count = reschedule_btn.count()
            c_count = continue_btn.count()

            if wait_i == 0 or wait_i % 5 == 0:
                print(f"[Dashboard] {user.name} — [{wait_i}s] Reschedule: count={r_count}, Continue: count={c_count}")

            if r_count > 0 and reschedule_btn.is_visible():
                print(f"[Dashboard] {user.name} — Found 'Reschedule Appointment' after {wait_i}s")
                return "#reschedule_appointment"
            if c_count > 0 and continue_btn.is_visible():
                print(f"[Dashboard] {user.name} — Found 'Continue Application' after {wait_i}s")
                return "#continue_application"

            page.wait_for_timeout(1000)

        # Buttons not found after polling — dump all links/buttons for debugging
        print(f"[Dashboard] {user.name} — No primary buttons after {max_button_wait}s, dumping page elements...")
        try:
            all_buttons = page.locator("button, input[type='submit'], a.btn, a[role='button']").all()
            for btn in all_buttons[:15]:
                try:
                    txt = btn.inner_text().strip()
                    btn_id = btn.get_attribute("id") or ""
                    btn_class = btn.get_attribute("class") or ""
                    if txt:
                        print(f"[Dashboard] {user.name} — Element: '{txt}' id='{btn_id}' class='{btn_class[:60]}'")
                except Exception:
                    pass
        except Exception:
            pass

        # Search for any scheduling links as fallback
        print(f"[Dashboard] {user.name} — Searching all links for scheduling keywords...")
        all_links = page.locator("a").all()
        for link in all_links:
            try:
                text = link.inner_text().strip().lower()
                href = link.get_attribute("href") or ""
                if any(kw in text for kw in ["continue", "schedule", "reschedule", "book"]):
                    link_id = link.get_attribute("id")
                    if link_id:
                        print(f"[Dashboard] {user.name} — Found link: #{link_id} '{text}'")
                        return f"#{link_id}"
                    print(f"[Dashboard] {user.name} — Found link without id: '{text}' → {href}")
            except Exception:
                continue

        print(f"[Dashboard] {user.name} — No scheduling links found")
        return None

    except Exception as e:
        import traceback
        print(f"[Dashboard] {user.name} — Error finding button: {e}")
        traceback.print_exc()
        return None


def navigate_to_schedule(page: Page, user: UserProfile) -> bool:
    """Legacy direct navigation (used as fallback)."""
    chat_id = user.telegram_chat_id
    try:
        selector = find_schedule_button(page, user)
        if not selector:
            _dump_page_debug(page, user.name)
            notify_error(user.name, "No Schedule/Reschedule button found", chat_id)
            return False

        print(f"[Dashboard] {user.name} — Clicking {selector}...")
        page.wait_for_timeout(random.randint(2000, 5000))
        page.locator(selector).click()

        page.wait_for_timeout(3000)
        print(f"[Dashboard] {user.name} — After click, URL: {page.url}")

        from cloudflare import wait_for_cloudflare, is_blocked
        if is_blocked(page):
            print(f"[Dashboard] {user.name} — Cloudflare detected, waiting...")
            if not wait_for_cloudflare(page, user.name, max_wait=90):
                notify_error(user.name, "Blocked by Cloudflare", chat_id)
                return False

        print(f"[Dashboard] {user.name} — Navigation complete: {page.url}")
        return True

    except Exception as e:
        import traceback
        print(f"[Dashboard] {user.name} — ERROR: {e}")
        traceback.print_exc()
        notify_error(user.name, f"Dashboard error: {e}", chat_id)
        return False


def _wait_for_dashboard_ready(page: Page, user_name: str, max_wait: int = 30):
    """Wait for any redirects to finish and page to be ready."""
    from cloudflare import wait_for_cloudflare, is_blocked

    retries = 0
    for i in range(max_wait):
        try:
            url = page.url.lower()
            title = page.title().lower()

            # Server errors
            if "timeout" in title or "524" in title or "522" in title or ("error" in title and "cloudflare" in title):
                if retries < 3:
                    retries += 1
                    print(f"[Dashboard] {user_name} — Server error: '{title[:50]}', refreshing ({retries}/3)...")
                    time.sleep(3)
                    try:
                        page.reload(wait_until="commit", timeout=30000)
                        page.wait_for_timeout(3000)
                    except Exception:
                        pass
                    continue
                else:
                    try:
                        page.goto(BASE_URL, wait_until="commit", timeout=30000)
                        page.wait_for_timeout(3000)
                    except Exception:
                        pass
                    return

            # Cloudflare challenge
            if "just a moment" in title or "attention required" in title or "checking" in title:
                if i == 0:
                    print(f"[Dashboard] {user_name} — Cloudflare challenge, waiting...")
                if is_blocked(page):
                    wait_for_cloudflare(page, user_name, max_wait=90)
                    return
                time.sleep(1)
                continue

            # Profile redirect
            if "/profile/" in url and "returnurl" in url:
                if i == 0:
                    print(f"[Dashboard] {user_name} — Profile redirect, navigating to dashboard...")
                    try:
                        page.goto(BASE_URL, wait_until="commit", timeout=30000)
                        page.wait_for_timeout(3000)
                    except Exception:
                        pass
                    continue
                time.sleep(1)
                continue

            if "usvisascheduling.com" in url:
                print(f"[Dashboard] {user_name} — Dashboard ready: {url[:80]}")
                return

        except Exception:
            time.sleep(1)
            continue

        time.sleep(1)

    print(f"[Dashboard] {user_name} — Dashboard wait timeout: {page.url[:80]}")


def _dump_page_debug(page: Page, user_name: str):
    """Print debug info about the current page."""
    try:
        print(f"[Dashboard] {user_name} — DEBUG URL: {page.url}")
        print(f"[Dashboard] {user_name} — DEBUG Title: {page.title()}")
        body = page.locator("body").inner_text()[:500]
        print(f"[Dashboard] {user_name} — DEBUG Body: {body[:300]}")
        buttons = page.locator("button, input[type='submit'], a.btn").all()
        for btn in buttons[:10]:
            try:
                txt = btn.inner_text().strip()
                if txt:
                    print(f"[Dashboard] {user_name} — DEBUG Button: '{txt}'")
            except Exception:
                pass
    except Exception as e:
        print(f"[Dashboard] {user_name} — DEBUG failed: {e}")
