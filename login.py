from __future__ import annotations

import random
import time
from playwright.sync_api import Page
from config import BASE_URL, CAPTCHA_MODE, USER_AGENTS
from models import UserProfile
from notifier import (
    notify_login_start,
    notify_captcha_waiting,
    notify_security_questions,
    notify_login_success,
    notify_login_failed,
    notify_error,
)


def get_random_user_agent() -> str:
    return random.choice(USER_AGENTS)


def login(page: Page, user: UserProfile) -> bool:
    chat_id = user.telegram_chat_id
    notify_login_start(user.name, chat_id)

    if not _step1_login(page, user):
        return False

    if not _step2_security_questions(page, user):
        return False

    notify_login_success(user.name, chat_id)
    return True


def _step1_login(page: Page, user: UserProfile) -> bool:
    """Step 1: Login page — redirects to Azure B2C (atlasauth.b2clogin.com)."""
    chat_id = user.telegram_chat_id
    try:
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(random.randint(2000, 4000))

        # If we hit "Page Not Found", click "Visa Application Home" link
        if "page not found" in page.title().lower() or "page not found" in (page.locator("body").inner_text()[:500].lower()):
            home_link = page.locator("a:has-text('Visa Application Home')")
            if home_link.count() > 0:
                print(f"[Login] {user.name} — Page Not Found, clicking Visa Application Home...")
                home_link.first.click()
                page.wait_for_load_state("domcontentloaded", timeout=15000)
                page.wait_for_timeout(random.randint(2000, 4000))

        # If not on B2C login page yet, look for sign-in link on the site
        if "b2clogin.com" not in page.url.lower():
            sign_in_link = page.locator("a[href*='sign-in'], a[href*='Sign-In'], a[href*='login'], a[href*='Login']")
            if sign_in_link.count() > 0:
                print(f"[Login] {user.name} — Clicking sign-in link...")
                sign_in_link.first.click()
                page.wait_for_load_state("domcontentloaded", timeout=15000)
                page.wait_for_timeout(random.randint(2000, 4000))

        # Azure B2C login form
        page.wait_for_selector("#signInName", timeout=15000)

        username_field = page.locator("#signInName")
        username_field.click()
        username_field.fill("")
        username_field.type(user.username, delay=random.randint(50, 150))
        page.wait_for_timeout(random.randint(500, 1000))

        password_field = page.locator("#password")
        password_field.click()
        password_field.fill("")
        password_field.type(user.password, delay=random.randint(50, 150))
        page.wait_for_timeout(random.randint(500, 1500))

        # Handle CAPTCHA
        if not _solve_captcha(page, user):
            notify_login_failed(user.name, "CAPTCHA not solved", chat_id)
            return False

        # Click continue/submit
        page.locator("#continue").click()
        page.wait_for_load_state("domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)

        # Check for login errors
        error_el = page.locator("#claimVerificationServerError")
        if error_el.count() > 0 and error_el.first.is_visible():
            msg = error_el.first.inner_text().strip()
            if msg:
                notify_login_failed(user.name, msg, chat_id)
                return False

        print(f"[Login] {user.name} — Step 1 passed, now on: {page.url}")
        return True

    except Exception as e:
        notify_login_failed(user.name, str(e), chat_id)
        return False


def _solve_captcha(page: Page, user: UserProfile) -> bool:
    """CAPTCHA is an image-based captcha on Azure B2C."""
    chat_id = user.telegram_chat_id

    captcha_image = page.locator("#captchaImage")
    if captcha_image.count() == 0 or not captcha_image.is_visible():
        print(f"[Login] {user.name} — No CAPTCHA detected, proceeding...")
        return True

    if CAPTCHA_MODE == "manual":
        notify_captcha_waiting(user.name, chat_id)
        print(f"[Login] {user.name} — CAPTCHA detected! Waiting for manual solve...")
        print("[Login] Please type the CAPTCHA answer in the browser and click Continue.")

        # Wait up to 3 minutes for user to fill #extension_atlasCaptchaResponse
        captcha_input = page.locator("#extension_atlasCaptchaResponse")
        for _ in range(180):
            if captcha_input.count() > 0:
                value = captcha_input.input_value()
                if value and len(value) >= 3:
                    print(f"[Login] {user.name} — CAPTCHA answer entered!")
                    return True
            time.sleep(1)

        print(f"[Login] {user.name} — CAPTCHA solve timeout (3 min)")
        return False

    elif CAPTCHA_MODE == "2captcha":
        print(f"[Login] {user.name} — 2Captcha mode not yet implemented")
        notify_error(user.name, "2Captcha auto-solve not implemented yet", chat_id)
        return False

    return False


def _step2_security_questions(page: Page, user: UserProfile) -> bool:
    """Answer 2 of 3 security questions on Azure B2C SelfAsserted page."""
    chat_id = user.telegram_chat_id
    notify_security_questions(user.name, chat_id)

    try:
        page.wait_for_timeout(random.randint(1000, 2000))

        # Security questions page is detected by #signInNameReadOnly
        if page.locator("#signInNameReadOnly").count() == 0:
            if _is_dashboard(page):
                print(f"[Login] {user.name} — No security questions page, already on dashboard")
                return True
            # May have navigated past security questions
            page.wait_for_timeout(2000)
            if _is_dashboard(page):
                return True

        # Wait for question text elements
        page.wait_for_selector("p.textInParagraph", timeout=10000)
        page.wait_for_timeout(random.randint(500, 1000))

        # Find all question text elements
        question_elements = page.locator("p.textInParagraph").all()

        if len(question_elements) < 2:
            if _is_dashboard(page):
                print(f"[Login] {user.name} — Already on dashboard")
                return True
            notify_login_failed(user.name, "Could not find security questions on page", chat_id)
            return False

        # For each question, find the answer input in the next sibling <li>
        for q_element in question_elements[:2]:
            question_text = q_element.inner_text().strip()
            print(f"[Login] {user.name} — Question: {question_text}")
            answer = _match_answer(question_text, user.security_questions)

            if not answer:
                notify_login_failed(
                    user.name,
                    f"No matching answer for question: {question_text}",
                    chat_id,
                )
                return False

            # Navigate: question <p> → parent <li> → next sibling <li> → .textInput
            question_li = q_element.locator("xpath=ancestor::li[1]")
            answer_li = question_li.locator("xpath=following-sibling::li[1]")
            answer_input = answer_li.locator(".textInput")

            if answer_input.count() == 0:
                notify_login_failed(user.name, f"Could not find answer input for: {question_text}", chat_id)
                return False

            answer_input.click()
            answer_input.fill("")
            answer_input.type(answer, delay=random.randint(50, 120))
            page.wait_for_timeout(random.randint(300, 800))

        page.wait_for_timeout(random.randint(500, 1000))

        # Click Continue
        page.locator("#continue").click()
        page.wait_for_load_state("domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)

        if _is_dashboard(page):
            print(f"[Login] {user.name} — Security questions passed, on dashboard")
            return True

        # Check for errors
        error_el = page.locator("#claimVerificationServerError")
        if error_el.count() > 0 and error_el.first.is_visible():
            msg = error_el.first.inner_text().strip()
            if msg:
                notify_login_failed(user.name, f"Security questions failed: {msg}", chat_id)
                return False

        print(f"[Login] {user.name} — Post-security page: {page.url}")
        return True

    except Exception as e:
        notify_login_failed(user.name, f"Security questions error: {e}", chat_id)
        return False


def _match_answer(question_text: str, security_questions: dict[str, str]) -> str | None:
    """Find the best matching answer using substring matching."""
    question_lower = question_text.lower().strip().rstrip("?").strip()
    best_match = None
    best_score = 0

    for stored_question, answer in security_questions.items():
        stored_lower = stored_question.lower().strip().rstrip("?").strip()
        # Exact match
        if stored_lower == question_lower:
            return answer
        # Substring match
        if stored_lower in question_lower or question_lower in stored_lower:
            score = len(stored_lower) / max(len(question_lower), 1)
            if score > best_score:
                best_score = score
                best_match = answer

    return best_match


def _is_dashboard(page: Page) -> bool:
    """Check if the current page is the dashboard."""
    url = page.url.lower()

    # Not on B2C auth page and on the main site
    if "b2clogin.com" not in url and "usvisascheduling.com" in url:
        # Check for dashboard page title
        pagetitle = page.locator("#pagetitle")
        if pagetitle.count() > 0:
            title_text = pagetitle.inner_text().strip().lower()
            if "apply for" in title_text or "u.s. visa" in title_text:
                return True

        # Check for schedule/reschedule buttons
        if page.locator("#reschedule_appointment").count() > 0:
            return True
        if page.locator("#continue_application").count() > 0:
            return True

    return False


def ensure_logged_in(page: Page, user: UserProfile) -> bool:
    """Check if still logged in; re-login if needed."""
    try:
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=20000)
        url = page.url.lower()
        if "b2clogin.com" in url or "/sign-in" in url or "/login" in url:
            print(f"[Login] {user.name} — Session expired, re-logging in...")
            return login(page, user)
        return True
    except Exception as e:
        notify_error(user.name, f"Session check failed: {e}", user.telegram_chat_id)
        return False
