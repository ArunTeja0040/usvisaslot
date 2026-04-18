from __future__ import annotations

import random
import signal
import time
from playwright.sync_api import sync_playwright

from config import (
    USER_SWITCH_DELAY_MIN,
    USER_SWITCH_DELAY_MAX,
    HEADLESS,
    load_users,
)
from models import UserProfile
from login import login, get_random_user_agent
from dashboard import navigate_to_schedule
from ofc_booking import book_ofc, set_running as ofc_set_running
from interview_booking import book_interview, OFCResetRequired, set_running as interview_set_running
from confirmation import handle_confirmation
from notifier import notify_bot_started, notify_bot_stopped, notify_error

_running = True


def _handle_signal(sig, frame):
    global _running
    print("\n[Main] Shutdown signal received...")
    _running = False
    ofc_set_running(False)
    interview_set_running(False)


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


def process_user(browser, user: UserProfile) -> bool:
    """
    Run the full 6-step flow for a single user.

    Login ONCE → stay logged in → poll slots every 10-15s until booked.
    No logout, no page refresh during polling.
    """
    chat_id = user.telegram_chat_id
    print(f"\n[Main] Processing: {user.name}")

    user_agent = get_random_user_agent()
    context = browser.new_context(
        user_agent=user_agent,
        viewport={"width": 1280, "height": 800},
        locale="en-US",
        timezone_id="Asia/Kolkata",
    )
    page = context.new_page()

    try:
        # Steps 1 & 2: Login + Security Questions (ONCE)
        if not login(page, user):
            return False

        # Step 3: Dashboard → Schedule/Reschedule (ONCE)
        if not navigate_to_schedule(page, user):
            return False

        # Steps 4 & 5 may loop if OFC resets during interview wait
        max_ofc_retries = 3
        for attempt in range(max_ofc_retries):
            if not _running:
                return False

            # Step 4: OFC Booking — polls in-page every 10-15s until slot found
            booking = book_ofc(page, user)
            if not booking or not booking.ofc_confirmed:
                print(f"[Main] {user.name} — OFC session ended without booking")
                return False

            # Step 5: Interview Booking — polls in-page every 10-15s
            try:
                if book_interview(page, user, booking):
                    # Step 6: Confirmation
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
        notify_error(user.name, f"Unexpected error: {e}", chat_id)
        print(f"[Main] {user.name} — Error: {e}")
        return False
    finally:
        context.close()


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

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=HEADLESS)
        try:
            # Process each user — login once, poll until booked
            for user in users:
                if not _running:
                    break

                if user.username in completed_users:
                    continue

                success = process_user(browser, user)
                if success:
                    completed_users.add(user.username)
                    print(f"[Main] {user.name} — BOOKING COMPLETE!")

                # Delay before next user
                if _running and user != users[-1]:
                    delay = random.randint(USER_SWITCH_DELAY_MIN, USER_SWITCH_DELAY_MAX)
                    print(f"[Main] Switching to next user in {delay}s...")
                    _interruptible_sleep(delay)

            # Summary
            if completed_users:
                print(f"\n[Main] Successfully booked: {len(completed_users)}/{len(users)} users")
            failed = [u.name for u in users if u.username not in completed_users]
            if failed:
                print(f"[Main] Not booked: {', '.join(failed)}")

        finally:
            browser.close()

    for user in users:
        notify_bot_stopped(user.telegram_chat_id)

    print("[Main] Bot stopped.")


def _interruptible_sleep(seconds: int):
    elapsed = 0
    while elapsed < seconds and _running:
        time.sleep(1)
        elapsed += 1


if __name__ == "__main__":
    run()
