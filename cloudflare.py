from __future__ import annotations

import time
import random
from playwright.sync_api import Page


def wait_for_cloudflare(page: Page, user_name: str = "", max_wait: int = 60) -> bool:
    """
    Detect and wait for Cloudflare challenge/block to clear.
    Returns True if page is ready, False if still blocked.
    """
    reload_attempts = 0
    max_reloads = 3

    for i in range(max_wait):
        try:
            title = page.title().lower()
            body = ""
            try:
                body = page.locator("body").inner_text()[:500].lower()
            except Exception:
                pass

            # Cloudflare WAF block page
            if "sorry, you have been blocked" in body or "you are unable to access" in body:
                if i == 0:
                    print(f"[Cloudflare] {user_name} — WAF block detected")
                    print(f"[Cloudflare] {user_name} — URL: {page.url[:80]}")

                # Try reloading after a delay — sometimes Cloudflare downgrades to challenge
                if reload_attempts < max_reloads and i > 0 and i % 15 == 0:
                    reload_attempts += 1
                    delay = random.randint(5, 10)
                    print(f"[Cloudflare] {user_name} — Reload attempt {reload_attempts}/{max_reloads} after {delay}s delay...")
                    time.sleep(delay)
                    try:
                        page.reload(wait_until="commit", timeout=15000)
                        time.sleep(3)
                    except Exception:
                        pass
                    continue

                if i % 15 == 0 and i > 0:
                    print(f"[Cloudflare] {user_name} — Still blocked ({i}s)...")
                time.sleep(1)
                continue

            # Cloudflare challenge page (solvable)
            if "attention required" in title or "just a moment" in title or "checking" in title:
                if i == 0 or (reload_attempts > 0 and "challenge" not in str(i)):
                    print(f"[Cloudflare] {user_name} — Cloudflare challenge detected (solvable!)")
                if "verify you are human" in body:
                    if i % 10 == 0:
                        print(f"[Cloudflare] {user_name} — Click 'Verify you are human' checkbox! ({i}s)")
                elif i % 15 == 0 and i > 0:
                    print(f"[Cloudflare] {user_name} — Challenge pending ({i}s)...")
                time.sleep(1)
                continue

            # Page loaded OK
            return True

        except Exception:
            time.sleep(1)
            continue

    print(f"[Cloudflare] {user_name} — Cloudflare did not clear after {max_wait}s")
    print(f"[Cloudflare] {user_name} — Trying to reload and solve manually...")
    print(f"[Cloudflare] {user_name} — If you see a challenge, solve it. Waiting 2 more minutes...")

    # Extended wait — give user time to solve manually, with periodic reloads
    for i in range(120):
        try:
            # Reload every 30 seconds during extended wait
            if i > 0 and i % 30 == 0:
                print(f"[Cloudflare] {user_name} — Reloading page ({i}s)...")
                try:
                    page.reload(wait_until="commit", timeout=15000)
                    time.sleep(3)
                except Exception:
                    pass

            title = page.title().lower()
            body = page.locator("body").inner_text()[:500].lower()

            if "sorry, you have been blocked" not in body and "unable to access" not in body:
                if "attention required" not in title and "just a moment" not in title:
                    print(f"[Cloudflare] {user_name} — Cloudflare cleared!")
                    return True
        except Exception:
            pass
        time.sleep(1)

    print(f"[Cloudflare] {user_name} — Still blocked after extended wait")
    return False


def is_blocked(page: Page) -> bool:
    """Check if current page is a Cloudflare block or challenge."""
    try:
        title = page.title().lower()
        if "attention required" in title or "just a moment" in title:
            return True
        body = page.locator("body").inner_text()[:500].lower()
        if "sorry, you have been blocked" in body or "you are unable to access" in body:
            return True
        if "verify you are human" in body:
            return True
    except Exception:
        pass
    return False
