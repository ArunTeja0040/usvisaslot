from __future__ import annotations

import os
import random
import shutil
import signal
import subprocess
import time
from playwright.sync_api import sync_playwright

from config import (
    USER_SWITCH_DELAY_MIN,
    USER_SWITCH_DELAY_MAX,
    HEADLESS,
    load_users,
)
from models import UserProfile
from login import login
from dashboard import navigate_to_schedule
from ofc_booking import book_ofc, set_running as ofc_set_running
from interview_booking import book_interview, OFCResetRequired, set_running as interview_set_running
from confirmation import handle_confirmation
from notifier import notify_bot_started, notify_bot_stopped, notify_error

_running = True

CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_USER_DATA = os.path.expanduser("~/Library/Application Support/Google/Chrome")
CHROME_PROFILE_DIR = os.getenv("CHROME_PROFILE_DIR", "Profile 1")
BOT_DATA_DIR = os.path.join(os.path.dirname(__file__), ".bot_chrome_data")
CDP_PORT = 9222


def _handle_signal(sig, frame):
    global _running
    print("\n[Main] Shutdown signal received...")
    _running = False
    ofc_set_running(False)
    interview_set_running(False)


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


def process_user(page, user: UserProfile) -> bool:
    chat_id = user.telegram_chat_id
    print(f"\n[Main] Processing: {user.name}")

    try:
        if not login(page, user):
            return False

        if not navigate_to_schedule(page, user):
            return False

        max_ofc_retries = 3
        for attempt in range(max_ofc_retries):
            if not _running:
                return False

            booking = book_ofc(page, user)
            if not booking or not booking.ofc_confirmed:
                print(f"[Main] {user.name} — OFC session ended without booking")
                return False

            try:
                if book_interview(page, user, booking):
                    handle_confirmation(page, user, booking)
                    return True
                else:
                    print(f"[Main] {user.name} — Interview booking failed")
                    return False

            except OFCResetRequired:
                print(f"[Main] {user.name} — OFC reset, restarting from Step 4 (attempt {attempt + 2}/{max_ofc_retries})")
                if not navigate_to_schedule(page, user):
                    return False
                continue

        print(f"[Main] {user.name} — Max OFC retries reached")
        return False

    except Exception as e:
        import traceback
        notify_error(user.name, f"Unexpected error: {e}", chat_id)
        print(f"[Main] {user.name} — Error: {e}")
        traceback.print_exc()
        return False


def navigate_to_schedule(page, user: UserProfile) -> bool:
    """Navigate to OFC schedule page from dashboard."""
    from dashboard import find_schedule_button, _wait_for_dashboard_ready, _dump_page_debug
    from cloudflare import is_blocked, wait_for_cloudflare
    from config import BASE_URL

    chat_id = user.telegram_chat_id
    ofc_url = f"{BASE_URL}/ofc-schedule"

    print(f"[Dashboard] {user.name} — Current URL: {page.url}")
    _wait_for_dashboard_ready(page, user.name)

    # Pre-warm Cloudflare for /ofc-schedule with authenticated session
    print(f"[Dashboard] {user.name} — Pre-warming /ofc-schedule with auth session...")
    _warmup_single_url(page, ofc_url, user.name)

    # Go back to dashboard for button click
    print(f"[Dashboard] {user.name} — Returning to dashboard...")
    try:
        page.goto(BASE_URL, wait_until="commit", timeout=30000)
        page.wait_for_timeout(3000)
    except Exception:
        pass
    _wait_for_dashboard_ready(page, user.name)

    button_selector = find_schedule_button(page, user)
    if not button_selector:
        _dump_page_debug(page, user.name)
        notify_error(user.name, "No Schedule/Reschedule button found", chat_id)
        return False

    # Click button with human-like delay
    print(f"[Dashboard] {user.name} — Clicking {button_selector}...")
    page.wait_for_timeout(random.randint(3000, 6000))
    page.locator(button_selector).click()
    page.wait_for_timeout(5000)

    print(f"[Dashboard] {user.name} — After click, URL: {page.url}")
    print(f"[Dashboard] {user.name} — Page title: '{page.title()}'")

    if not is_blocked(page):
        print(f"[Dashboard] {user.name} — Navigation complete: {page.url}")
        return True

    # Strategy 1: Try direct page.goto() navigation (bypasses button click detection)
    print(f"[Dashboard] {user.name} — WAF block after button click, trying direct navigation...")
    page.wait_for_timeout(random.randint(3000, 5000))
    try:
        page.goto(ofc_url, wait_until="commit", timeout=30000)
        page.wait_for_timeout(3000)
    except Exception:
        pass

    if not is_blocked(page):
        print(f"[Dashboard] {user.name} — Direct navigation worked: {page.url}")
        return True

    # Strategy 2: Try JavaScript navigation (looks like natural browser behavior)
    print(f"[Dashboard] {user.name} — Still blocked, trying JS navigation...")
    page.wait_for_timeout(random.randint(2000, 4000))
    try:
        page.evaluate(f"window.location.href = '{ofc_url}'")
        page.wait_for_timeout(5000)
    except Exception:
        pass

    if not is_blocked(page):
        print(f"[Dashboard] {user.name} — JS navigation worked: {page.url}")
        return True

    # Strategy 3: Open in new tab (fresh request context)
    print(f"[Dashboard] {user.name} — Still blocked, trying new tab...")
    try:
        context = page.context
        new_page = context.new_page()
        new_page.goto(ofc_url, wait_until="commit", timeout=30000)
        new_page.wait_for_timeout(3000)

        if not is_blocked(new_page):
            print(f"[Dashboard] {user.name} — New tab worked! Switching...")
            page.close()
            # Return the new page reference via the outer scope
            # We need to update the page reference in the caller
            # For now, navigate the original approach
            new_page.close()
            page.goto(ofc_url, wait_until="commit", timeout=30000)
            page.wait_for_timeout(3000)
            if not is_blocked(page):
                print(f"[Dashboard] {user.name} — Navigation complete after new tab warmup: {page.url}")
                return True
        else:
            print(f"[Dashboard] {user.name} — New tab also blocked")
            new_page.close()
    except Exception as e:
        print(f"[Dashboard] {user.name} — New tab failed: {e}")

    # Final fallback: manual intervention
    print(f"[Dashboard] {user.name} — =============================================")
    print(f"[Dashboard] {user.name} — ALL AUTO STRATEGIES FAILED — MANUAL HELP NEEDED:")
    print(f"[Dashboard] {user.name} —   1. Go to the browser")
    print(f"[Dashboard] {user.name} —   2. Press F5 or Ctrl+R to refresh")
    print(f"[Dashboard] {user.name} —   3. If 'Verify you are human' appears, click it")
    print(f"[Dashboard] {user.name} —   4. Bot will auto-detect when page loads")
    print(f"[Dashboard] {user.name} — =============================================")
    if not wait_for_cloudflare(page, user.name, max_wait=180):
        notify_error(user.name, "Cloudflare block on OFC page", chat_id)
        return False

    print(f"[Dashboard] {user.name} — Navigation complete: {page.url}")
    return True


def _warmup_single_url(page, url: str, user_name: str):
    """Visit a single URL to clear Cloudflare challenge (post-login warmup)."""
    from cloudflare import is_blocked, wait_for_cloudflare

    print(f"[Warmup-Auth] {user_name} — Visiting {url}...")
    try:
        page.goto(url, wait_until="commit", timeout=30000)
    except Exception:
        pass
    page.wait_for_timeout(3000)

    title = ""
    try:
        title = page.title().lower()
    except Exception:
        pass

    if is_blocked(page):
        print(f"[Warmup-Auth] {user_name} — Cloudflare detected, waiting for clearance...")
        print(f"[Warmup-Auth] {user_name} — If you see 'Verify you are human', click it")
        wait_for_cloudflare(page, user_name, max_wait=120)
    elif "just a moment" in title or "checking" in title or "attention" in title:
        print(f"[Warmup-Auth] {user_name} — Cloudflare challenge, waiting...")
        wait_for_cloudflare(page, user_name, max_wait=90)
    else:
        print(f"[Warmup-Auth] {user_name} — {url} — OK")

    page.wait_for_timeout(random.randint(2000, 4000))


def _prepare_bot_profile():
    """Copy essential files from user's Chrome profile to bot's data dir."""
    src_profile = os.path.join(CHROME_USER_DATA, CHROME_PROFILE_DIR)
    dst_profile = os.path.join(BOT_DATA_DIR, CHROME_PROFILE_DIR)
    os.makedirs(dst_profile, exist_ok=True)

    # Copy Local State (needed for cookie decryption)
    src_state = os.path.join(CHROME_USER_DATA, "Local State")
    dst_state = os.path.join(BOT_DATA_DIR, "Local State")
    if os.path.exists(src_state):
        shutil.copy2(src_state, dst_state)

    # Copy essential profile files (cookies, preferences, local storage)
    essential_files = [
        "Cookies", "Cookies-journal",
        "Preferences", "Secure Preferences",
        "Login Data", "Login Data-journal",
        "Web Data", "Web Data-journal",
    ]
    copied = []
    for fname in essential_files:
        src = os.path.join(src_profile, fname)
        dst = os.path.join(dst_profile, fname)
        if os.path.exists(src):
            try:
                shutil.copy2(src, dst)
                copied.append(fname)
            except Exception as e:
                print(f"[Main] Could not copy {fname}: {e}")

    # Copy Local Storage directory
    src_ls = os.path.join(src_profile, "Local Storage")
    dst_ls = os.path.join(dst_profile, "Local Storage")
    if os.path.exists(src_ls):
        try:
            shutil.copytree(src_ls, dst_ls, dirs_exist_ok=True)
            copied.append("Local Storage")
        except Exception as e:
            print(f"[Main] Could not copy Local Storage: {e}")

    if copied:
        print(f"[Main] Copied from Chrome {CHROME_PROFILE_DIR}: {', '.join(copied)}")
    else:
        print(f"[Main] Warning: no files found in {src_profile}")


def _launch_chrome() -> subprocess.Popen:
    """Launch Chrome normally via subprocess — no Playwright automation flags."""
    cmd = [
        CHROME_BIN,
        f"--user-data-dir={os.path.abspath(BOT_DATA_DIR)}",
        f"--profile-directory={CHROME_PROFILE_DIR}",
        f"--remote-debugging-port={CDP_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ]
    print(f"[Main] Launching Chrome (port {CDP_PORT})...")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def run():
    global _running

    print("[Main] Starting US Visa Slot Bot...")
    print("[Main] Loading users...")

    raw_users = load_users()
    users = [UserProfile.from_dict(u) for u in raw_users]
    print(f"[Main] Loaded {len(users)} user(s): {', '.join(u.name for u in users)}")

    for user in users:
        notify_bot_started(user.telegram_chat_id)

    completed_users: set[str] = set()

    # Prepare bot profile with cookies from your real Chrome
    _prepare_bot_profile()

    # Launch Chrome as a normal process (no automation flags!)
    chrome_proc = _launch_chrome()

    # Wait for Chrome to start and CDP to be ready
    print("[Main] Waiting for Chrome to start...")
    time.sleep(4)

    try:
        with sync_playwright() as pw:
            print(f"[Main] Connecting to Chrome via CDP (port {CDP_PORT})...")
            browser = pw.chromium.connect_over_cdp(f"http://localhost:{CDP_PORT}")
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()

            print("[Main] Connected to Chrome. No automation flags — Cloudflare should not block.")

            # Warm up: visit key pages to solve Cloudflare challenges before login
            _warmup_cloudflare(page)

            for user in users:
                if not _running:
                    break

                if user.username in completed_users:
                    continue

                success = process_user(page, user)
                if success:
                    completed_users.add(user.username)
                    print(f"[Main] {user.name} — BOOKING COMPLETE!")

                if _running and user != users[-1]:
                    delay = random.randint(USER_SWITCH_DELAY_MIN, USER_SWITCH_DELAY_MAX)
                    print(f"[Main] Switching to next user in {delay}s...")
                    _interruptible_sleep(delay)

            if completed_users:
                print(f"\n[Main] Successfully booked: {len(completed_users)}/{len(users)} users")
            failed = [u.name for u in users if u.username not in completed_users]
            if failed:
                print(f"[Main] Not booked: {', '.join(failed)}")

            browser.close()

    finally:
        print("[Main] Shutting down Chrome...")
        chrome_proc.terminate()
        try:
            chrome_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome_proc.kill()

    for user in users:
        notify_bot_stopped(user.telegram_chat_id)

    print("[Main] Bot stopped.")


def _warmup_cloudflare(page):
    """Visit key site pages to solve Cloudflare challenges before login."""
    from cloudflare import wait_for_cloudflare, is_blocked
    from config import BASE_URL

    warmup_urls = [
        BASE_URL,
        f"{BASE_URL}/ofc-schedule",
    ]

    for url in warmup_urls:
        if not _running:
            return
        print(f"[Warmup] Visiting {url} to clear Cloudflare...")
        try:
            page.goto(url, wait_until="commit", timeout=30000)
        except Exception:
            pass
        time.sleep(3)

        if is_blocked(page):
            print(f"[Warmup] Cloudflare detected — waiting (click 'Verify you are human' if prompted)...")
            wait_for_cloudflare(page, "Warmup", max_wait=90)
        else:
            # Check for challenge via title
            try:
                title = page.title().lower()
                if "just a moment" in title or "checking" in title or "attention" in title:
                    print(f"[Warmup] Cloudflare challenge — waiting...")
                    wait_for_cloudflare(page, "Warmup", max_wait=90)
                else:
                    print(f"[Warmup] {url} — OK")
            except Exception:
                time.sleep(2)

        time.sleep(random.randint(2, 5))

    print("[Warmup] Cloudflare warmup complete.")


def _interruptible_sleep(seconds: int):
    elapsed = 0
    while elapsed < seconds and _running:
        time.sleep(1)
        elapsed += 1


if __name__ == "__main__":
    run()
