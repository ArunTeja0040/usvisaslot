from __future__ import annotations

import random
import time
from playwright.sync_api import Page
from config import BASE_URL, CAPTCHA_MODE, TWO_CAPTCHA_API_KEY, USER_AGENTS
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


def _wait_for_page_ready(page: Page, user_name: str, max_wait: int = 120):
    """Wait for Cloudflare challenge to pass and page to load."""
    prompted_manual = False
    for i in range(max_wait):
        try:
            title = page.title().lower()
            url = page.url.lower()
        except Exception:
            # Context destroyed during navigation (Cloudflare redirect) — wait and retry
            time.sleep(1)
            continue

        # Cloudflare challenge page — wait for it to auto-solve or manual click
        if "attention required" in title or "just a moment" in title or "checking" in title:
            if i == 0:
                print(f"[Login] {user_name} — Cloudflare challenge detected, waiting...")
            if i == 15 and not prompted_manual:
                print(f"[Login] {user_name} — If you see 'Verify you are human', click the checkbox in the browser")
                prompted_manual = True
            if i % 30 == 0 and i > 0:
                print(f"[Login] {user_name} — Still waiting for Cloudflare... ({i}s)")
            time.sleep(1)
            continue

        # Page loaded (either B2C login or the visa site)
        if "b2clogin.com" in url or "usvisascheduling.com" in url:
            page.wait_for_timeout(random.randint(1000, 3000))
            return

        time.sleep(1)

    print(f"[Login] {user_name} — Page did not load within {max_wait}s, continuing anyway...")


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
        current = page.url.lower()
        already_on_site = "usvisascheduling.com" in current and "b2clogin.com" not in current

        if already_on_site:
            print(f"[Login] {user.name} — Already on site ({current[:80]}), skipping goto...")
        else:
            print(f"[Login] {user.name} — Opening {BASE_URL}...")
            try:
                page.goto(BASE_URL, wait_until="commit", timeout=30000)
            except Exception as nav_err:
                print(f"[Login] {user.name} — Navigation slow ({nav_err.__class__.__name__}), checking page state...")
                if "usvisascheduling.com" not in page.url.lower():
                    try:
                        page.goto(BASE_URL, wait_until="commit", timeout=30000)
                    except Exception:
                        print(f"[Login] {user.name} — Second navigation attempt also slow, continuing with current page...")

        # Wait for Cloudflare challenge / page to fully render
        _wait_for_page_ready(page, user.name)

        # If we hit "Page Not Found", click "Visa Application Home" link
        page_text = ""
        try:
            page_text = page.locator("body").inner_text()[:500].lower()
        except Exception:
            pass
        if "page not found" in page.title().lower() or "page not found" in page_text:
            home_link = page.locator("a:has-text('Visa Application Home')")
            if home_link.count() > 0:
                print(f"[Login] {user.name} — Page Not Found, clicking Visa Application Home...")
                home_link.first.click()
                _wait_for_page_ready(page, user.name)

        # If not on B2C login page yet, look for sign-in link on the site
        if "b2clogin.com" not in page.url.lower():
            sign_in_link = page.locator("a[href*='sign-in'], a[href*='Sign-In'], a[href*='login'], a[href*='Login']")
            if sign_in_link.count() > 0:
                print(f"[Login] {user.name} — Clicking sign-in link...")
                sign_in_link.first.click()
                _wait_for_page_ready(page, user.name)

        print(f"[Login] {user.name} — Current URL: {page.url}")

        # Azure B2C login form — wait longer since redirects can be slow
        page.wait_for_selector("#signInName", timeout=30000)

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

        # Handle CAPTCHA + submit with retry on wrong CAPTCHA
        max_captcha_retries = 5
        for captcha_attempt in range(max_captcha_retries):
            if not _solve_captcha(page, user):
                notify_login_failed(user.name, "CAPTCHA not solved", chat_id)
                return False

            # Click continue/submit
            print(f"[Login] {user.name} — Clicking Continue...")
            continue_btn = page.locator("#continue")
            if continue_btn.count() > 0:
                continue_btn.click()
            else:
                page.locator("button[type='submit'], #next").first.click()

            # Wait for processing modal to appear and disappear
            _wait_for_processing(page, user.name)

            current_url = page.url.lower()
            print(f"[Login] {user.name} — After submit, URL: {current_url[:100]}...")

            # Check if we left the login page (success)
            if "b2clogin.com" not in current_url and "usvisascheduling.com" in current_url:
                print(f"[Login] {user.name} — Login successful, redirected to site")
                break

            # Check if we're on security questions page (success)
            if page.locator("#signInNameReadOnly").count() > 0:
                print(f"[Login] {user.name} — Login successful, on security questions page")
                break

            # Check for login errors
            error_el = page.locator("#claimVerificationServerError")
            if error_el.count() > 0 and error_el.first.is_visible():
                msg = error_el.first.inner_text().strip()
                if msg:
                    print(f"[Login] {user.name} — Error: {msg}")
                    if "captcha" in msg.lower() or "validation" in msg.lower():
                        print(f"[Login] {user.name} — Wrong CAPTCHA (attempt {captcha_attempt + 1}/{max_captcha_retries}), retrying...")
                        _safe_refresh_captcha(page)
                        continue
                    notify_login_failed(user.name, msg, chat_id)
                    return False

            # Still on B2C but no error — might still be loading
            if "b2clogin.com" in current_url:
                captcha_img = page.locator("#captchaImage")
                if captcha_img.count() > 0 and captcha_img.is_visible():
                    # Double-check: is a processing modal blocking?
                    modal = page.locator("#verifying_blurb, #simplemodal-container")
                    if modal.count() > 0 and modal.first.is_visible():
                        print(f"[Login] {user.name} — Processing modal still visible, waiting...")
                        _wait_for_processing(page, user.name)
                        # Re-check URL after processing
                        current_url = page.url.lower()
                        if "b2clogin.com" not in current_url:
                            print(f"[Login] {user.name} — Login successful after processing")
                            break
                        if page.locator("#signInNameReadOnly").count() > 0:
                            print(f"[Login] {user.name} — Login successful, on security questions")
                            break
                    else:
                        print(f"[Login] {user.name} — CAPTCHA still showing, retrying (attempt {captcha_attempt + 1}/{max_captcha_retries})...")
                        _safe_refresh_captcha(page)
                        continue
                # Wait a bit more for redirect
                page.wait_for_timeout(3000)

            break

        print(f"[Login] {user.name} — Step 1 passed, now on: {page.url}")
        return True

    except Exception as e:
        import traceback
        traceback.print_exc()
        notify_login_failed(user.name, str(e), chat_id)
        return False


def _wait_for_processing(page: Page, user_name: str, max_wait: int = 30):
    """Wait for the 'Please wait while we process' modal to appear and then disappear."""
    # First, wait a moment for modal to potentially appear
    page.wait_for_timeout(2000)

    for i in range(max_wait):
        try:
            modal = page.locator("#verifying_blurb, #simplemodal-container")
            if modal.count() > 0 and modal.first.is_visible():
                if i == 0:
                    print(f"[Login] {user_name} — Processing modal visible, waiting for it to complete...")
                time.sleep(1)
                continue

            # Modal gone — check if page navigated
            current_url = page.url.lower()
            if "b2clogin.com" not in current_url:
                return
            if page.locator("#signInNameReadOnly").count() > 0:
                return
            # Modal gone but still on login page — CAPTCHA might have failed
            return

        except Exception:
            time.sleep(1)
            continue

    print(f"[Login] {user_name} — Processing did not complete in {max_wait}s")


def _safe_refresh_captcha(page: Page):
    """Refresh CAPTCHA image, waiting for any blocking modal to disappear first."""
    # Wait for modal to disappear
    for _ in range(10):
        modal = page.locator("#verifying_blurb, #simplemodal-container")
        if modal.count() == 0 or not modal.first.is_visible():
            break
        time.sleep(1)

    refresh_btn = page.locator("#captchaRefreshImage")
    if refresh_btn.count() > 0:
        try:
            refresh_btn.click(timeout=5000)
            page.wait_for_timeout(2000)
        except Exception as e:
            print(f"[Login] Could not refresh CAPTCHA: {e}")
            page.wait_for_timeout(2000)


def _solve_captcha(page: Page, user: UserProfile) -> bool:
    """CAPTCHA is an image-based captcha on Azure B2C. Supports auto, 2captcha, and manual modes."""
    chat_id = user.telegram_chat_id

    captcha_image = page.locator("#captchaImage")
    if captcha_image.count() == 0 or not captcha_image.is_visible():
        print(f"[Login] {user.name} — No CAPTCHA detected, proceeding...")
        return True

    print(f"[Login] {user.name} — CAPTCHA detected! Mode: {CAPTCHA_MODE}")

    if CAPTCHA_MODE == "auto":
        return _solve_captcha_ocr(page, user, max_attempts=5)

    elif CAPTCHA_MODE == "2captcha":
        return _solve_captcha_2captcha(page, user)

    elif CAPTCHA_MODE == "manual":
        notify_captcha_waiting(user.name, chat_id)
        print(f"[Login] {user.name} — Waiting for manual CAPTCHA solve...")
        print("[Login] Please type the CAPTCHA answer in the browser and click Continue.")

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

    return False


def _solve_captcha_ocr(page: Page, user: UserProfile, max_attempts: int = 3) -> bool:
    """Auto-solve CAPTCHA using local OCR (ddddocr)."""
    try:
        import ddddocr
    except ImportError:
        print(f"[Login] {user.name} — ddddocr not installed. Run: pip3 install ddddocr")
        notify_error(user.name, "ddddocr not installed for auto CAPTCHA", user.telegram_chat_id)
        return False

    ocr = ddddocr.DdddOcr(show_ad=False)

    for attempt in range(1, max_attempts + 1):
        try:
            captcha_image = page.locator("#captchaImage")
            if captcha_image.count() == 0 or not captcha_image.is_visible():
                return True

            # Get CAPTCHA image bytes — answer is always uppercase
            image_bytes = captcha_image.screenshot()
            result = ocr.classification(image_bytes).upper().strip()
            print(f"[Login] {user.name} — OCR attempt {attempt}: '{result}'")

            if not result or len(result) < 3:
                # Refresh CAPTCHA and retry
                refresh_btn = page.locator("#captchaRefreshImage")
                if refresh_btn.count() > 0:
                    refresh_btn.click()
                    page.wait_for_timeout(1500)
                continue

            # Fill the CAPTCHA answer
            captcha_input = page.locator("#extension_atlasCaptchaResponse")
            if captcha_input.count() > 0:
                captcha_input.click()
                captcha_input.fill("")
                captcha_input.type(result, delay=random.randint(30, 80))
                page.wait_for_timeout(random.randint(300, 600))
                print(f"[Login] {user.name} — CAPTCHA answer filled: '{result}'")
                return True

        except Exception as e:
            print(f"[Login] {user.name} — OCR attempt {attempt} failed: {e}")
            # Refresh CAPTCHA for next attempt
            refresh_btn = page.locator("#captchaRefreshImage")
            if refresh_btn.count() > 0:
                refresh_btn.click()
                page.wait_for_timeout(1500)

    print(f"[Login] {user.name} — OCR failed after {max_attempts} attempts, falling back to manual...")
    return _solve_captcha_manual_fallback(page, user)


def _solve_captcha_2captcha(page: Page, user: UserProfile) -> bool:
    """Auto-solve CAPTCHA using 2Captcha API service."""
    import httpx

    if not TWO_CAPTCHA_API_KEY:
        print(f"[Login] {user.name} — 2Captcha API key not set in .env")
        notify_error(user.name, "TWO_CAPTCHA_API_KEY not configured", user.telegram_chat_id)
        return False

    try:
        captcha_image = page.locator("#captchaImage")
        image_src = captcha_image.get_attribute("src")

        if not image_src:
            print(f"[Login] {user.name} — Could not get CAPTCHA image src")
            return False

        # Send to 2Captcha
        print(f"[Login] {user.name} — Sending CAPTCHA to 2Captcha...")
        resp = httpx.post(
            "https://2captcha.com/in.php",
            data={
                "key": TWO_CAPTCHA_API_KEY,
                "method": "base64",
                "body": _get_captcha_base64(page),
                "json": 1,
            },
            timeout=30,
        )
        data = resp.json()

        if data.get("status") != 1:
            print(f"[Login] {user.name} — 2Captcha submit error: {data}")
            return False

        request_id = data["request"]
        print(f"[Login] {user.name} — 2Captcha request ID: {request_id}, waiting for solution...")

        # Poll for result (max 60 seconds)
        for _ in range(12):
            time.sleep(5)
            result_resp = httpx.get(
                "https://2captcha.com/res.php",
                params={"key": TWO_CAPTCHA_API_KEY, "action": "get", "id": request_id, "json": 1},
                timeout=15,
            )
            result_data = result_resp.json()

            if result_data.get("status") == 1:
                answer = result_data["request"]
                print(f"[Login] {user.name} — 2Captcha solved: '{answer}'")

                captcha_input = page.locator("#extension_atlasCaptchaResponse")
                if captcha_input.count() > 0:
                    captcha_input.click()
                    captcha_input.fill("")
                    captcha_input.type(answer, delay=random.randint(30, 80))
                    page.wait_for_timeout(random.randint(300, 600))
                    return True

            if result_data.get("request") != "CAPCHA_NOT_READY":
                print(f"[Login] {user.name} — 2Captcha error: {result_data}")
                return False

        print(f"[Login] {user.name} — 2Captcha timeout")
        return False

    except Exception as e:
        print(f"[Login] {user.name} — 2Captcha error: {e}")
        return False


def _get_captcha_base64(page: Page) -> str:
    """Get CAPTCHA image as base64 string."""
    import base64
    image_bytes = page.locator("#captchaImage").screenshot()
    return base64.b64encode(image_bytes).decode("utf-8")


def _solve_captcha_manual_fallback(page: Page, user: UserProfile) -> bool:
    """Fallback: wait for manual solve after auto-solve fails."""
    print(f"[Login] {user.name} — Please solve the CAPTCHA manually in the browser (60s timeout)...")
    captcha_input = page.locator("#extension_atlasCaptchaResponse")
    for _ in range(60):
        if captcha_input.count() > 0:
            value = captcha_input.input_value()
            if value and len(value) >= 3:
                print(f"[Login] {user.name} — CAPTCHA solved manually!")
                return True
        time.sleep(1)
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

            # Find the answer input field using multiple strategies
            answer_input = _find_answer_input(page, q_element)

            if not answer_input or answer_input.count() == 0:
                notify_login_failed(user.name, f"Could not find answer input for: {question_text}", chat_id)
                return False

            answer_input.click()
            answer_input.fill("")
            answer_input.type(answer, delay=random.randint(50, 120))
            print(f"[Login] {user.name} — Answer filled for: {question_text[:40]}...")
            page.wait_for_timeout(random.randint(300, 800))

        page.wait_for_timeout(random.randint(500, 1000))

        # Click Continue
        print(f"[Login] {user.name} — Clicking Continue after security questions...")
        continue_btn = page.locator("#continue")
        try:
            if continue_btn.count() > 0:
                continue_btn.click()
        except Exception:
            pass

        # Wait for navigation — page may redirect to dashboard
        try:
            page.wait_for_timeout(5000)
        except Exception:
            pass

        # After security questions, we expect to land on the main site
        # The B2C context may be destroyed due to navigation — that's OK
        try:
            current_url = page.url
            print(f"[Login] {user.name} — After security questions, URL: {current_url}")

            if _is_dashboard(page):
                print(f"[Login] {user.name} — Security questions passed, on dashboard")
                return True

            # Wait a bit more for redirect
            page.wait_for_timeout(5000)
            if _is_dashboard(page):
                print(f"[Login] {user.name} — Security questions passed, on dashboard (after wait)")
                return True

            # If we left B2C, consider it a success
            if "b2clogin.com" not in page.url.lower():
                print(f"[Login] {user.name} — Left B2C auth, assuming success")
                return True

            # Still on B2C — check for errors
            error_el = page.locator("#claimVerificationServerError")
            if error_el.count() > 0 and error_el.first.is_visible():
                msg = error_el.first.inner_text().strip()
                if msg:
                    notify_login_failed(user.name, f"Security questions failed: {msg}", chat_id)
                    return False

        except Exception as nav_err:
            if "context was destroyed" in str(nav_err) or "navigation" in str(nav_err).lower():
                print(f"[Login] {user.name} — Page navigated after security questions (success)")
                _wait_for_post_login_page(page, user.name)
                return True
            raise

        print(f"[Login] {user.name} — Post-security page: {page.url}")
        return True

    except Exception as e:
        err_msg = str(e).lower()
        if "context was destroyed" in err_msg or "navigation" in err_msg:
            print(f"[Login] {user.name} — Page navigated (security questions likely passed)")
            _wait_for_post_login_page(page, user.name)
            return True

        import traceback
        traceback.print_exc()
        notify_login_failed(user.name, f"Security questions error: {e}", chat_id)
        return False


def _wait_for_post_login_page(page: Page, user_name: str, max_wait: int = 30):
    """Wait for the page to finish loading after login/security questions."""
    from config import BASE_URL

    try:
        page.wait_for_load_state("domcontentloaded", timeout=10000)
    except Exception:
        pass

    retries = 0
    for i in range(max_wait):
        try:
            url = page.url.lower()
            title = page.title().lower()

            # Cloudflare server error (524 timeout, 522 connection timed out, 503, etc.)
            if "timeout" in title or "524" in title or "522" in title or "error" in title:
                if retries < 3:
                    retries += 1
                    print(f"[Login] {user_name} — Server error: '{title[:50]}', refreshing (retry {retries}/3)...")
                    time.sleep(3)
                    try:
                        page.goto(BASE_URL, wait_until="commit", timeout=30000)
                        page.wait_for_timeout(3000)
                    except Exception:
                        pass
                    continue
                else:
                    print(f"[Login] {user_name} — Server errors persist after {retries} retries")
                    return

            # Profile redirect page — try navigating to base URL directly
            if "/profile/" in url and "returnurl" in url:
                if i == 0:
                    print(f"[Login] {user_name} — Profile redirect page, navigating to dashboard...")
                    try:
                        page.goto(BASE_URL, wait_until="commit", timeout=30000)
                        page.wait_for_timeout(3000)
                    except Exception:
                        pass
                    continue
                time.sleep(1)
                continue

            # On the main site and not an error page — we're good
            if "usvisascheduling.com" in url and "b2clogin.com" not in url:
                print(f"[Login] {user_name} — Post-login page ready: {url[:80]}")
                return

        except Exception:
            time.sleep(1)
            continue

        time.sleep(1)

    print(f"[Login] {user_name} — Post-login wait done, continuing on: {page.url[:80]}")


def _find_answer_input(page: Page, question_element):
    """Find the answer input field for a security question using multiple strategies."""
    # Strategy 1: question <p> → closest <li> → next sibling <li> → .textInput
    try:
        question_li = question_element.locator("xpath=ancestor::li[1]")
        if question_li.count() > 0:
            answer_li = question_li.locator("xpath=following-sibling::li[1]")
            if answer_li.count() > 0:
                answer_input = answer_li.locator(".textInput")
                if answer_input.count() > 0:
                    print("[Login] Found answer input via li→sibling→textInput")
                    return answer_input
    except Exception:
        pass

    # Strategy 2: question <p> → parent → next sibling → input
    try:
        parent = question_element.locator("xpath=..")
        if parent.count() > 0:
            sibling = parent.locator("xpath=following-sibling::*[1]")
            if sibling.count() > 0:
                answer_input = sibling.locator("input[type='text'], input[type='password'], .textInput, input")
                if answer_input.count() > 0:
                    print("[Login] Found answer input via parent→sibling→input")
                    return answer_input
    except Exception:
        pass

    # Strategy 3: find all .textInput on page and match by order
    try:
        all_questions = page.locator("p.textInParagraph").all()
        all_inputs = page.locator(".textInput").all()
        for idx, q in enumerate(all_questions):
            try:
                if q.inner_text().strip() == question_element.inner_text().strip() and idx < len(all_inputs):
                    print(f"[Login] Found answer input via index matching (#{idx})")
                    return all_inputs[idx]
            except Exception:
                continue
    except Exception:
        pass

    # Strategy 4: find input fields near the question using CSS
    try:
        all_inputs = page.locator("input.textInput, input[type='text']").all()
        if all_inputs:
            print(f"[Login] Found {len(all_inputs)} text inputs on page, using index fallback")
            all_questions = page.locator("p.textInParagraph").all()
            for idx, q in enumerate(all_questions):
                try:
                    if q.inner_text().strip() == question_element.inner_text().strip() and idx < len(all_inputs):
                        return all_inputs[idx]
                except Exception:
                    continue
    except Exception:
        pass

    print("[Login] Could not find answer input with any strategy")
    return None


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
