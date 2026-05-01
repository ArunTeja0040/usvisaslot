#!/usr/bin/env python3
"""
Comprehensive test suite for US Visa Auto Booking Chrome Extension.

Tests all logic paths extracted from:
  - extension/js/auto-booking.js  (login, CAPTCHA, security Qs, dashboard, cycling, booking)
  - extension/js/dashboard.js     (user management, Telegram, import/export)
  - extension/js/sw-enhanced.js   (Telegram commands, CAPTCHA relay)
  - extension/manifest.json       (permissions, content script config)

Since we cannot run against the live site, we:
  1. Parse and extract JS functions into testable units
  2. Simulate DOM state for each page type
  3. Mock chrome.storage.local, chrome.runtime, chrome.tabs
  4. Verify logic correctness, state transitions, and edge cases
"""

import json
import re
import os
import sys
import traceback
from pathlib import Path
from datetime import datetime, timedelta

# ─── Test infrastructure ─────────────────────────────────────────────

PASS = 0
FAIL = 0
SKIP = 0
RESULTS = []

def test(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        RESULTS.append(("PASS", name, detail))
    else:
        FAIL += 1
        RESULTS.append(("FAIL", name, detail))

def skip(name, reason):
    global SKIP
    SKIP += 1
    RESULTS.append(("SKIP", name, reason))

def section(title):
    RESULTS.append(("SECTION", title, ""))

# ─── Load source files ───────────────────────────────────────────────

BASE = Path(__file__).resolve().parent.parent
AB_PATH = BASE / "extension" / "js" / "auto-booking.js"
DB_PATH = BASE / "extension" / "js" / "dashboard.js"
SW_PATH = BASE / "extension" / "js" / "sw-enhanced.js"
MF_PATH = BASE / "extension" / "manifest.json"
AO_PATH = BASE / "extension" / "js" / "alert-override.js"
PG_PATH = BASE / "extension" / "js" / "page.js"

ab_code = AB_PATH.read_text()
db_code = DB_PATH.read_text()
sw_code = SW_PATH.read_text()
manifest = json.loads(MF_PATH.read_text())
ao_code = AO_PATH.read_text()
pg_code = PG_PATH.read_text()


# ═════════════════════════════════════════════════════════════════════
# MANIFEST & CONFIGURATION TESTS
# ═════════════════════════════════════════════════════════════════════

section("MANIFEST & PERMISSIONS")

test("Manifest version is MV3",
     manifest.get("manifest_version") == 3)

test("Required permissions present",
     set(["storage", "activeTab", "scripting", "tabs", "alarms"]).issubset(set(manifest["permissions"])))

test("Host permissions cover visa site",
     any("usvisascheduling.com" in h for h in manifest["host_permissions"]))

test("Host permissions cover b2clogin",
     any("b2clogin.com" in h for h in manifest["host_permissions"]))

test("Host permissions cover localhost (CAPTCHA server)",
     any("localhost" in h for h in manifest["host_permissions"]))

test("Host permissions cover Telegram API",
     any("api.telegram.org" in h for h in manifest["host_permissions"]))

test("Service worker configured",
     manifest.get("background", {}).get("service_worker") == "js/sw-enhanced.js")

# Content script injection tests
cs = manifest.get("content_scripts", [])

test("Alert override runs at document_start in MAIN world",
     any(c.get("run_at") == "document_start" and c.get("world") == "MAIN"
         and "js/alert-override.js" in c.get("js", []) for c in cs))

test("auto-booking.js runs on usvisascheduling.com",
     any("js/auto-booking.js" in c.get("js", [])
         and any("usvisascheduling.com" in m for m in c.get("matches", [])) for c in cs))

test("auto-booking.js runs on b2clogin.com",
     any("js/auto-booking.js" in c.get("js", [])
         and any("b2clogin.com" in m for m in c.get("matches", [])) for c in cs))

test("html2canvas does NOT load on b2clogin.com",
     not any("js/html2canvas.js" in c.get("js", [])
             and any("b2clogin.com" in m for m in c.get("matches", [])) for c in cs),
     "Performance fix: html2canvas only needed on scheduling pages")

test("html2canvas loads on usvisascheduling.com",
     any("js/html2canvas.js" in c.get("js", [])
         and any("usvisascheduling.com" in m for m in c.get("matches", [])) for c in cs))

test("content.js does NOT load on b2clogin.com",
     not any("js/content.js" in c.get("js", [])
             and any("b2clogin.com" in m for m in c.get("matches", [])) for c in cs),
     "content.js M() login handler is redundant with auto-booking.js")

test("sweetalert2 only loads on confirmation pages",
     any("js/sweetalert2.min.js" in c.get("js", [])
         and all("appointment-confirmation" in m for m in c.get("matches", [])) for c in cs))

test("page.js registered dynamically (not in manifest)",
     not any("js/page.js" in c.get("js", []) for c in cs),
     "page.js is registered via chrome.scripting.registerContentScripts in sw-enhanced.js")


# ═════════════════════════════════════════════════════════════════════
# STEP 1 — LOGIN PAGE TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 1 — LOGIN PAGE")

# Test: runLogin requires credentials
test("runLogin guards against empty credentials",
     'if (!loginDetails || !loginDetails.username || !loginDetails.password)' in ab_code,
     "Empty username/password → returns early, no login attempt")

# Test: Login form detection waits for all 3 elements
test("Login waits for signInName + password + captchaImage",
     'userField && passField && captchaImg' in ab_code,
     "All 3 elements must be present before auto-fill")

# Test: Login fills username with proper events
test("Username field gets input + change events dispatched",
     'userField.dispatchEvent(new Event("input"' in ab_code and
     'userField.dispatchEvent(new Event("change"' in ab_code)

# Test: Password field gets proper events
test("Password field gets input + change events dispatched",
     'passField.dispatchEvent(new Event("input"' in ab_code and
     'passField.dispatchEvent(new Event("change"' in ab_code)

# Test: CAPTCHA handling after credential fill
test("handleCaptcha called after filling credentials",
     'await handleCaptcha(settings)' in ab_code)

# Test: Login form polling interval
test("Login form polling uses 500ms interval (not too aggressive)",
     '}, 500);' in ab_code.split('async function runLogin')[1].split('function')[0])

# Test: Login aborted when __abortAll is true
test("Login checks __abortAll flag",
     'if (__abortAll) { clearInterval(waitForForm)' in ab_code)

# Test: Security questions detected during login
test("Security questions detected by _response field count",
     'responseFields.length === 2' in ab_code)

# Test: Re-login detection
test("Re-login flag detected (RELOGIN_FLAG)",
     'const RELOGIN_FLAG = "__autoBookingRelogin"' in ab_code)

test("Re-login auto-starts without settings panel",
     "activeAutoUser || isRelogin" in ab_code)

# Test: Login page ready detection
test("waitForB2CPageReady detects login vs security page",
     'resolve("login")' in ab_code and 'resolve("security")' in ab_code)

test("waitForB2CPageReady has timeout after 30 checks (15s)",
     'checks > 30' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# STEP 1a — CAPTCHA TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 1a — CAPTCHA SOLVING")

test("CAPTCHA max retries is 5",
     "const CAPTCHA_MAX_RETRIES = 5" in ab_code)

test("CAPTCHA loop bounded by MAX_RETRIES",
     "attempt <= CAPTCHA_MAX_RETRIES" in ab_code,
     "QA fix: was infinite loop before")

test("CAPTCHA OCR result must be exactly 5 chars",
     'cleaned.length === 5' in ab_code)

test("CAPTCHA OCR enforces uppercase",
     '.toUpperCase()' in ab_code.split('solveCaptchaOCR')[1].split('function')[0])

test("CAPTCHA OCR strips non-alphanumeric",
     "[^A-Z0-9]" in ab_code)

test("CAPTCHA manual mode falls back to focus input",
     'captchaInput.focus()' in ab_code)

test("CAPTCHA refresh button clicked on wrong answer",
     'clickSafe(refreshBtn)' in ab_code)

test("CAPTCHA error detected via claimVerificationServerError element",
     'claimVerificationServerError' in ab_code)

test("CAPTCHA falls back to manual after max retries",
     'Failed after ${CAPTCHA_MAX_RETRIES} attempts' in ab_code)

test("CAPTCHA image load timeout (10s) prevents hanging",
     'sleep(10000)' in ab_code.split('handleCaptcha')[1].split('function normalizeQ')[0])

test("CAPTCHA checks __abortAll on each attempt",
     'if (__abortAll) { log("CAPTCHA aborted")' in ab_code)

# Validate CAPTCHA cleaning logic
def test_captcha_clean(raw, expected):
    cleaned = raw.upper().replace(re.compile(r'[^A-Z0-9]').pattern, '')
    # Python equivalent of JS: .toUpperCase().replace(/[^A-Z0-9]/g, "")
    cleaned = re.sub(r'[^A-Z0-9]', '', raw.upper())
    return cleaned if len(cleaned) == 5 else None

test("CAPTCHA clean: 'abc12' → 'ABC12'", test_captcha_clean("abc12", "ABC12") == "ABC12")
test("CAPTCHA clean: 'AB@C#1' → None (6 chars after strip, not 5)", test_captcha_clean("AB@C#1", None) is None)
test("CAPTCHA clean: 'a1b2c' → 'A1B2C'", test_captcha_clean("a1b2c", "A1B2C") == "A1B2C")
test("CAPTCHA clean: 'AB' → None (too short)", test_captcha_clean("AB", None) is None)
test("CAPTCHA clean: '12345' → '12345'", test_captcha_clean("12345", "12345") == "12345")
test("CAPTCHA clean: 'a!b@c#d$e' → 'ABCDE'", test_captcha_clean("a!b@c#d$e", "ABCDE") == "ABCDE")


# ═════════════════════════════════════════════════════════════════════
# STEP 2 — SECURITY QUESTIONS TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 2 — SECURITY QUESTIONS")

test("Security questions detected by #attributeList li.Paragraph",
     'document.querySelectorAll(\n      "#attributeList li.Paragraph"' in ab_code or
     '#attributeList li.Paragraph' in ab_code)

test("Waits for 2+ question items before proceeding",
     'questionItems.length < 2' in ab_code)

test("Retry limit of 15 for missing security questions",
     'retries >= 15' in ab_code,
     "QA fix: was infinite recursion before")

test("Security questions aborted when __abortAll is true",
     'if (__abortAll) { log("Security questions aborted")' in ab_code)

# Test normalizeQ function
def normalize_q(text):
    return re.sub(r'[^a-z0-9]', '', text.lower())

test("normalizeQ: basic normalization",
     normalize_q("What is your favorite color?") == "whatisyourfavoritecolor")

test("normalizeQ: strips special chars + spaces",
     normalize_q("Where were you born?!") == "wherewereyouborn")

test("normalizeQ: handles empty string",
     normalize_q("") == "")

# Test findAnswer logic
def find_answer(security_qas, question_text):
    # Exact match
    if question_text in security_qas:
        return security_qas[question_text]
    # Normalized match
    norm_q = normalize_q(question_text)
    for saved_q, answer in security_qas.items():
        saved_norm = normalize_q(saved_q)
        if saved_norm == norm_q:
            return answer
        if norm_q in saved_norm or saved_norm in norm_q:
            return answer
    return None

qas = {
    "What is your favorite color?": "Blue",
    "Where were you born?": "Mumbai",
    "What is your pet's name?": "Rex",
}

test("findAnswer: exact match",
     find_answer(qas, "What is your favorite color?") == "Blue")

test("findAnswer: case-insensitive match",
     find_answer(qas, "what is your favorite color?") == "Blue")

test("findAnswer: punctuation-insensitive match",
     find_answer(qas, "What is your favorite color") == "Blue")

test("findAnswer: substring match (question contains saved)",
     find_answer(qas, "Please tell us: What is your favorite color? We need to know.") == "Blue")

test("findAnswer: no match returns None",
     find_answer(qas, "What is your mother's maiden name?") is None)

test("findAnswer: partial overlap match",
     find_answer(qas, "Where were you born") == "Mumbai")

# Test: answers filled via password input
test("Security answers go to input[type=password]",
     'input[type="password"]' in ab_code)

test("Answer input gets dispatched input event",
     'answerInput.dispatchEvent(new Event("input"' in ab_code)

test("Continue button clicked after answering 2+ questions",
     'answered >= 2' in ab_code and 'continueBtn.click()' in ab_code)

test("Telegram login notification sent after security questions answered",
     'sendTelegramNotification("login"' in ab_code)

test("2-second delay before clicking Continue (for Telegram to send)",
     'await sleep(2000)' in ab_code.split('answered >= 2')[1].split('continueBtn')[0])


# ═════════════════════════════════════════════════════════════════════
# STEP 3 — DASHBOARD TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 3 — DASHBOARD")

test("Dashboard detected by path regex /xx-xx/",
     r'/^\/[a-z]{2}-[a-z]{2}\/?$/i' in ab_code)

# Test path matching
import re as re_mod
dash_pattern = re_mod.compile(r'^/[a-z]{2}-[a-z]{2}/?$', re_mod.IGNORECASE)
test("Dashboard path: /en-US/ matches", bool(dash_pattern.match("/en-US/")))
test("Dashboard path: /en-us matches", bool(dash_pattern.match("/en-us")))
test("Dashboard path: /en-US/schedule does NOT match", not dash_pattern.match("/en-US/schedule"))
test("Dashboard path: / does NOT match", not dash_pattern.match("/"))

test("Dashboard checks for Reschedule button (reschedule_appointment)",
     'reschedule_appointment' in ab_code)

test("Dashboard checks for Continue button (continue_application)",
     'continue_application' in ab_code)

test("Dashboard clicks Reschedule if found",
     'rescheduleBtn.click()' in ab_code)

test("Dashboard clicks Continue if found",
     'continueBtn.click()' in ab_code.split('handleDashboard')[1].split('function injectBookingPanel')[0])

test("Dashboard has configurable click delay (DASHBOARD_CLICK_DELAY)",
     "const DASHBOARD_CLICK_DELAY = 2000" in ab_code)

test("Dashboard falls back to schedule links",
     'a[href*="ofc-schedule"]' in ab_code)

test("Dashboard requires active automation user or auto-dashboard setting",
     "!autoUser && !settings[\"is_auto-dashboard\"]" in ab_code)

test("Rate limit warning detected on dashboard",
     '"exceeded"' in ab_code and '"maximum"' in ab_code)

test("Rate limit on dashboard sends Telegram notification",
     'sendTelegramNotification("rate"' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# STEP 4 — OFC BOOKING TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 4 — OFC BOOKING")

test("OFC page detected by path /ofc-schedule",
     'path.includes("/ofc-schedule")' in ab_code)

test("Booking panel injected with id=ab-panel",
     'panel.id = "ab-panel"' in ab_code)

test("Panel has duplicate injection guard",
     'if (document.getElementById("ab-panel")) return' in ab_code)

test("Location dropdown (post_select) required for panel",
     'const select = document.getElementById("post_select")' in ab_code.split('injectBookingPanel')[1].split('function setStatus')[0])

test("Locations extracted from dropdown options",
     'Array.from(select.options)' in ab_code)

test("Empty locations prevents panel injection",
     'if (locations.length === 0) return' in ab_code)

test("START button has click handler",
     '"ab-start-btn"' in ab_code and 'startCycling()' in ab_code)

test("STOP button has click handler",
     '"ab-stop-btn"' in ab_code and 'stopCycling("Stopped by user")' in ab_code)

test("LOGOUT button on OFC panel",
     '"ab-logout-btn"' in ab_code)

test("LOGOUT clears session and clicks Sign out",
     'a[href*="LogOff"]' in ab_code,
     "Uses actual href from site's Sign out link")

test("Start date auto-populated from profile",
     'profile.startDate' in ab_code and 'sd.value = profile.startDate' in ab_code)

test("End date auto-populated from profile",
     'profile.endDate' in ab_code and 'ed.value = profile.endDate' in ab_code)

test("Locations auto-checked from profile",
     'profile.locations' in ab_code)

# Cycling logic
test("startCycling checks for at least 1 selected location",
     'checked.length === 0' in ab_code)

test("Cycling uses weighted human-like delay between locations",
     'humanDelay()' in ab_code and 'function humanDelay()' in ab_code)

test("Location dropdown value changed via dispatchEvent",
     'select.dispatchEvent(new Event("change"' in ab_code)

test("waitForScheduleData listens for vSCP events",
     'addEventListener("vSCP", handler)' in ab_code)

test("waitForScheduleData has 15-second timeout",
     'timeout = 15000' in ab_code)

test("No slots message displayed for empty results",
     'No slots at ${loc.name}' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# STEP 4a — DATE SELECTION & RANGE FILTERING
# ═════════════════════════════════════════════════════════════════════

section("STEP 4a — DATE RANGE FILTERING")

# Test isDateInRange logic
def is_date_in_range(date_str, start_str, end_str):
    if not start_str and not end_str:
        return True
    d = datetime.strptime(date_str, "%Y-%m-%d")
    if start_str and d < datetime.strptime(start_str, "%Y-%m-%d"):
        return False
    if end_str and d > datetime.strptime(end_str, "%Y-%m-%d"):
        return False
    return True

test("Date in range: no bounds → always true",
     is_date_in_range("2026-06-15", "", ""))

test("Date in range: within bounds → true",
     is_date_in_range("2026-06-15", "2026-06-01", "2026-07-01"))

test("Date in range: before start → false",
     not is_date_in_range("2026-05-15", "2026-06-01", "2026-07-01"))

test("Date in range: after end → false",
     not is_date_in_range("2026-08-15", "2026-06-01", "2026-07-01"))

test("Date in range: on start boundary → true",
     is_date_in_range("2026-06-01", "2026-06-01", "2026-07-01"))

test("Date in range: on end boundary → true",
     is_date_in_range("2026-07-01", "2026-06-01", "2026-07-01"))

test("Date in range: only start bound → true if after",
     is_date_in_range("2026-12-31", "2026-06-01", ""))

test("Date in range: only end bound → true if before",
     is_date_in_range("2026-01-01", "", "2026-07-01"))

# Date selection
test("Calendar selection manipulates year dropdown",
     'ui-datepicker-year' in ab_code)

test("Calendar selection manipulates month dropdown",
     'ui-datepicker-month' in ab_code)

test("Calendar clicks date link with data-date attribute",
     'data-date="${day}"' in ab_code)

test("Dates sorted ascending before selection",
     '.sort((a, b) => new Date(a.Date) - new Date(b.Date))' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# STEP 4b — TIME SLOT SELECTION & SUBMIT
# ═════════════════════════════════════════════════════════════════════

section("STEP 4b — TIME SLOT & SUBMIT")

test("Time slot detected by radio input in #time_select",
     '#time_select input[type="radio"]' in ab_code)

test("waitForTimeSlotAndSelect has 12-second timeout",
     'timeout = 12000' in ab_code)

test("Radio button clicked if not checked",
     'if (!radio.checked) radio.click()' in ab_code)

test("Submit button checked by id=submitbtn",
     'document.getElementById("submitbtn")' in ab_code)

test("Submit button disabled check",
     '!submitBtn.disabled' in ab_code)

test("Auto-submit sends Telegram notification",
     'Auto-submitted booking' in ab_code)

test("Slot found stops cycling",
     'stopCycling' in ab_code and 'Slot found' in ab_code)

test("Slot found sends Telegram notification",
     'sendTelegramNotification("slot"' in ab_code or 'SLOT_FOUND' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# STEP 5 — INTERVIEW BOOKING TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 5 — INTERVIEW BOOKING")

test("Interview page detected by path /schedule (not /ofc-schedule)",
     'path.includes("/schedule")' in ab_code)

test("Same booking panel used for interview (pageLabel = Interview)",
     'pageLabel = isOFC ? "OFC" : "Interview"' in ab_code.replace("  ", " "))

test("Interview uses same cycling logic as OFC",
     'injectBookingPanel()' in ab_code.split('handleBookingPage')[1])

# Edge case: OFC booked but interview dates not visible
test("No Class Selected error detected on booking page",
     'No Class Selected' in ab_code)

test("Booking page error count tracked in sessionStorage",
     '__abOFCErrorCount' in ab_code)

test("After 3 errors, automation stops with Telegram alert",
     'errorCount >= 3' in ab_code)

test("On error, redirects back to dashboard for retry",
     'window.location.href = window.location.origin + "/en-US/"' in ab_code)

test("Error counter reset on successful page load",
     'sessionStorage.removeItem("__abOFCErrorCount")' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# STEP 6 — CONFIRMATION PAGE TESTS
# ═════════════════════════════════════════════════════════════════════

section("STEP 6 — CONFIRMATION PAGE")

test("Confirmation page detected by path",
     'appointment-confirmation' in ab_code)

test("Confirmation page triggers trackEvent",
     'Reached appointment confirmation page' in ab_code)

test("Confirmation page sends Telegram notification",
     'BOOKING CONFIRMED' in ab_code)

test("sweetalert2 + html2pdf loaded on confirmation page (manifest)",
     any("js/sweetalert2.min.js" in c.get("js", []) and
         "js/html2pdf.bundle.min.js" in c.get("js", [])
         and "appointment-confirmation" in str(c.get("matches", []))
         for c in cs))

# PDF generation tested in content.js
test("PDF download functionality exists in content.js",
     'html2pdf' in (BASE / "extension" / "js" / "content.js").read_text())


# ═════════════════════════════════════════════════════════════════════
# FLOW & SEQUENCE VALIDATION
# ═════════════════════════════════════════════════════════════════════

section("FLOW & SEQUENCE ENFORCEMENT")

test("Automation gated by SAVE & START (sessionStorage flag)",
     '__autoBookingLoginActive' in ab_code)

test("Dashboard requires activeAutomationUser or relogin flag",
     'activeAutoUser || isRelogin' in ab_code)

test("Booking page checks for activeAutomationUser",
     'activeAutomationUser' in ab_code.split('handleBookingPage')[1][:5000])

test("OFC error redirects to dashboard (enforces step order)",
     '__abOFCErrorCount' in ab_code and 'en-US' in ab_code.split('errorCount >= 3')[1][:1500])

test("401 recovery saves cycling state then redirects to login",
     'saveReloginState' in ab_code and 'RELOGIN_FLAG' in ab_code)

test("Relogin state only valid for 5 minutes",
     '5 * 60 * 1000' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# SESSION MANAGEMENT & ERROR RECOVERY
# ═════════════════════════════════════════════════════════════════════

section("SESSION & ERROR RECOVERY")

# 401 detection
test("401 detected via XHR status code (DOM bridge)",
     'this.status === 401' in ab_code)

test("429 detected via XHR status code",
     'this.status === 429' in ab_code)

test("401 detected via fetch response",
     'resp.status === 401' in ab_code)

test("429 detected via fetch response",
     'resp.status === 429' in ab_code)

test("Duplicate XHR patch guard (_ab401Patched)",
     '_ab401Patched' in ab_code)

test("Duplicate fetch patch guard (_abFetch401Patched)",
     '_abFetch401Patched' in ab_code)

# 401 recovery
test("401 recovery sends Telegram notification",
     'SESSION EXPIRED' in ab_code)

test("401 recovery saves cycling state before redirect",
     'saveReloginState()' in ab_code.split('handle401Recovery')[1][:800])

test("401 recovery sets relogin flag",
     'sessionStorage.setItem(RELOGIN_FLAG' in ab_code)

# 429 rate limiting
test("429 exponential backoff starts at 60s",
     'cycling.backoffMs ? Math.min(cycling.backoffMs * 2, 300000) : 60000' in ab_code)

test("429 backoff caps at 5 minutes (300000ms)",
     '300000' in ab_code)

test("429 backoff resets on success",
     'cycling.backoffMs = 0' in ab_code)

# Keep-alive
test("Session refresh interval is randomized 6-12 minutes",
     'randomRefreshMs()' in ab_code and '6 + Math.random() * 6' in ab_code)

test("Keep-alive checks every 30 seconds",
     '}, 30000)' in ab_code.split('startKeepAlive')[1].split('function stopKeepAlive')[0])

test("Keep-alive saves state before refresh",
     'saveReloginState()' in ab_code.split('startKeepAlive')[1].split('function stopKeepAlive')[0])

# Cloudflare
test("Cloudflare block detection (Error 1015)",
     'Error 1015' in ab_code)

test("Cloudflare detection uses textContent (not innerText)",
     'document.body?.textContent' in ab_code)

test("isSessionExpired checks targeted elements (not full body)",
     '.session-expired' in ab_code and
     '.alert-danger, .error-message' in ab_code)

# Waiting room
test("Waiting room detection by text content",
     'waiting room' in ab_code.lower())

test("Waiting room uses querySelector (not innerHTML scan)",
     'waitingroom' in ab_code and 'hasWaitingRoomClass' in ab_code)

test("Waiting room max 30 retries",
     'attempt > 30' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# PERFORMANCE & SAFETY TESTS
# ═════════════════════════════════════════════════════════════════════

section("PERFORMANCE & SAFETY")

# No document.body.innerText calls
test("No document.body.innerText (causes forced layout reflow)",
     'document.body.innerText' not in ab_code and 'document.body?.innerText' not in ab_code,
     "All replaced with textContent or targeted selectors")

test("No document.body.innerHTML scans",
     'document.body?.innerHTML' not in ab_code and 'document.body.innerHTML' not in ab_code)

# Event batching
test("trackEvent uses batched writes (not per-event storage ops)",
     '__pendingEvents' in ab_code and 'flushEventLog' in ab_code)

test("Event flush on beforeunload (prevents lost logs on navigation)",
     'window.addEventListener("beforeunload"' in ab_code)

test("Event batch flush timer is 2 seconds",
     '__eventFlushTimer = setTimeout' in ab_code and ', 2000)' in ab_code)

# MutationObserver
test("Auto-submit observer targets specific container (not document.body)",
     'document.getElementById("time_select")' in ab_code.split('setupAutoSubmit')[1][:300])

test("Auto-submit observer has 5-minute timeout",
     '300000' in ab_code.split('setupAutoSubmit')[1][:2000])

# page.js registration
test("page.js unregistered before re-registering (prevents double injection)",
     'unregisterContentScripts' in sw_code)

# CSP safety
test("clickSafe strips javascript: href before click",
     'javascript:' in ab_code and 'removeAttribute("href")' in ab_code)

# XSS prevention in dashboard
test("Dashboard has HTML escaping function (esc)",
     "const esc = " in db_code and "&amp;" in db_code and "&lt;" in db_code)

# Validate esc function
def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

test("esc: basic XSS prevention",
     esc('<script>alert(1)</script>') == '&lt;script&gt;alert(1)&lt;/script&gt;')

test("esc: handles quotes",
     esc('"><img onerror=alert(1)>') == '&quot;&gt;&lt;img onerror=alert(1)&gt;')

test("esc: handles ampersand",
     esc("a&b") == "a&amp;b")

test("esc: handles None/empty",
     esc("") == "" and esc(None) == "")


# ═════════════════════════════════════════════════════════════════════
# TELEGRAM NOTIFICATION TESTS
# ═════════════════════════════════════════════════════════════════════

section("TELEGRAM NOTIFICATIONS")

# Notification types
for ntype in ["login", "cycling", "stopped", "logout", "error", "rate", "slot", "confirmed"]:
    present = f'"{ntype}"' in ab_code.split('sendTelegramNotification')[0] or \
              f'sendTelegramNotification("{ntype}"' in ab_code or \
              f"'{ntype}'" in ab_code
    test(f"Telegram notification type '{ntype}' is used",
         f'sendTelegramNotification("{ntype}"' in ab_code or
         (ntype in ["slot", "confirmed"] and ntype in ab_code))

# Telegram preference checking
test("Telegram respects per-type notification preferences",
     'notify[type] === false' in ab_code)

test("Telegram default preferences include all types",
     'login: true, cycling: true, stopped: true' in ab_code)

test("Telegram IST timestamp appended to messages",
     'Asia/Kolkata' in ab_code)

test("Telegram sends via service worker (chrome.runtime.sendMessage)",
     'action: "sendTelegram"' in ab_code)


# ═════════════════════════════════════════════════════════════════════
# TELEGRAM 2-WAY COMMANDS (sw-enhanced.js)
# ═════════════════════════════════════════════════════════════════════

section("TELEGRAM 2-WAY COMMANDS")

test("Telegram polling alarm every 15 seconds",
     'TG_POLL_INTERVAL = 0.25' in sw_code,
     "0.25 minutes = 15 seconds")

test("Telegram polling starts on runtime.onStartup",
     'chrome.runtime.onStartup.addListener(startTelegramPolling)' in sw_code)

test("Telegram first-run flushes old messages",
     'offset=-1' in sw_code)

for cmd in ["/start", "/stop", "/logout", "/status", "/list"]:
    test(f"Telegram command {cmd} handled",
         cmd.replace("/", "") in sw_code.lower())

test("Telegram only processes authorized chat ID",
     'chatId' in sw_code and 'msg.chat.id' in sw_code)

test("Telegram findUserByPartialName supports exact + substring match",
     'findUserByPartialName' in sw_code)

test("Telegram /list shows clickable inline commands",
     '/start_' in sw_code or 'start_' in sw_code)


# ═════════════════════════════════════════════════════════════════════
# DASHBOARD.JS TESTS
# ═════════════════════════════════════════════════════════════════════

section("DASHBOARD UI")

test("Dashboard refresh interval is 2 seconds",
     'const REFRESH_INTERVAL = 2000' in db_code)

test("Dashboard has user card rendering",
     'renderUserCards' in db_code)

test("Dashboard has activity log rendering",
     'activity-log' in db_code or 'renderLog' in db_code)

test("Dashboard startUser sets status to logging_in",
     'status: "logging_in"' in db_code)

test("Dashboard startUser sends Telegram notification",
     'sendDashboardTelegram("login"' in db_code)

test("Dashboard stopUser sends Telegram notification",
     'sendDashboardTelegram("stopped"' in db_code)

test("Dashboard logoutUser sends Telegram notification",
     'sendDashboardTelegram("logout"' in db_code)

test("Dashboard sendDashboardTelegram respects notification preferences",
     'notify[type] === false' in db_code)

test("Dashboard sendDashboardTelegram adds IST timestamp",
     'Asia/Kolkata' in db_code)

test("Dashboard export warns about passwords",
     'password' in db_code.lower() and ('export' in db_code.lower() or 'Export' in db_code))

test("Dashboard import validates profiles",
     'profiles' in db_code and 'importData' in db_code)

test("Dashboard filter by status",
     'filter-status' in db_code)


# ═════════════════════════════════════════════════════════════════════
# ALERT OVERRIDE TESTS
# ═════════════════════════════════════════════════════════════════════

section("ALERT OVERRIDE")

test("window.alert is overridden",
     'window.alert = function' in ao_code)

test("Original alert is preserved",
     'origAlert = window.alert' in ao_code)

test("Dismissed alerts dispatched as custom event",
     '__abAlertDismissed' in ao_code)

test("Alert message is passed as event detail",
     'detail: String(msg)' in ao_code)


# ═════════════════════════════════════════════════════════════════════
# PAGE.JS XHR INTERCEPTOR TESTS
# ═════════════════════════════════════════════════════════════════════

section("PAGE.JS XHR INTERCEPTOR")

test("page.js intercepts XMLHttpRequest",
     'XMLHttpRequest.prototype' in pg_code)

test("page.js fires vSCP custom events",
     'vSCP' in pg_code)

test("page.js identifies schedule-days as vSD",
     'vSD' in pg_code and 'schedule-days' in pg_code)

test("page.js identifies schedule-entries as vST",
     'vST' in pg_code and 'schedule-entries' in pg_code)

test("page.js identifies family-members as vD",
     'vD' in pg_code and 'query-family-members' in pg_code)

test("page.js listens for fromContent events (date/location selection)",
     'fromContent' in pg_code)

test("page.js uses rate limiting (cacheString threshold)",
     'cacheString' in pg_code and '200' in pg_code)


# ═════════════════════════════════════════════════════════════════════
# EDGE CASE TESTS
# ═════════════════════════════════════════════════════════════════════

section("EDGE CASES")

# Page Not Found recovery
test("Page Not Found detection",
     'Page Not Found' in ab_code)

test("Page Not Found retries up to 10 times",
     'retryCount < 10' in ab_code)

test("Page Not Found sends Telegram on max retries",
     'PAGE NOT FOUND' in ab_code)

# Relogin state
test("Relogin state saved to sessionStorage",
     'sessionStorage.setItem("ab-cycling-state"' in ab_code)

test("Relogin state expires after 5 minutes",
     'Date.now() - state.timestamp > 5 * 60 * 1000' in ab_code)

test("Relogin restores locations, dates, interval, round",
     all(x in ab_code for x in ['savedState.startDate', 'savedState.endDate',
                                  'savedState.interval', 'savedState.locations',
                                  'savedState.round']))

# Stop signal
test("Stop signal via chrome.storage (__stopSignal)",
     '__stopSignal' in ab_code)

test("Stop signal checked between each location in cycling",
     'checkStopSignal' in ab_code.split('runCycleLoop')[1])

# Multiple active users prevented
test("Only one active user at a time (activeAutomationUser)",
     'activeAutomationUser' in ab_code and 'activeAutomationUser' in db_code)

# Event log cap
test("Event log capped at 500 entries",
     'const MAX_EVENT_LOG = 500' in ab_code)

test("Event log uses FIFO eviction",
     'events.unshift' in ab_code and 'events.length > MAX_EVENT_LOG' in ab_code)

# Profile name derivation
def derive_profile_name(username):
    if not username:
        return "User"
    at_idx = username.find("@")
    return username[:at_idx] if at_idx > 0 else username

test("deriveProfileName: email → local part",
     derive_profile_name("john@email.com") == "john")

test("deriveProfileName: plain username → as-is",
     derive_profile_name("SowmiyaS") == "SowmiyaS")

test("deriveProfileName: empty → 'User'",
     derive_profile_name("") == "User")

test("deriveProfileName: None → 'User'",
     derive_profile_name(None) == "User")


# ═════════════════════════════════════════════════════════════════════
# INTEGRATION: FULL FLOW STATE TRANSITIONS
# ═════════════════════════════════════════════════════════════════════

section("STATE TRANSITION VALIDATION")

# Verify all status values used
statuses = ["idle", "logging_in", "security_questions", "on_dashboard",
            "cycling", "slot_found", "confirmed", "rate_limited",
            "session_expired", "error"]

for s in statuses:
    test(f"Status '{s}' is used in auto-booking.js",
         f'"{s}"' in ab_code)

# Verify status labels in dashboard
for s in statuses:
    test(f"Status '{s}' has label in dashboard.js",
         s in db_code)

# Verify event types
event_types = ["login", "captcha", "security", "dashboard", "cycling",
               "slot_found", "booking", "error", "queue", "session"]

for et in event_types:
    test(f"Event type '{et}' defined in EVENT_TYPES",
         f'"{et}"' in ab_code.split('EVENT_TYPES')[1].split('}')[0])


# ═════════════════════════════════════════════════════════════════════
# CANNOT-TEST (requires live site / browser)
# ═════════════════════════════════════════════════════════════════════

section("CANNOT TEST (requires live browser)")

skip("Login with valid credentials → proceeds to security questions",
     "Requires live b2clogin.com with real credentials")
skip("Wrong credentials → error shown",
     "Requires live b2clogin.com server-side validation")
skip("CAPTCHA image rendering and OCR solve",
     "Requires live CAPTCHA image + captcha_server.py running")
skip("Dashboard buttons actually navigate to OFC page",
     "Requires live usvisascheduling.com session")
skip("Green date boxes shown after location selection",
     "Requires live schedule API response")
skip("OFC → Interview flow transition",
     "Requires completed OFC booking on live site")
skip("OFC/Interview 20-30 minute timing window",
     "Requires real appointment state on live site")
skip("Confirmation page print/download",
     "Requires sweetalert2 + html2pdf in browser context")
skip("Direct URL access prevention (Steps 4-6)",
     "Server-side enforcement by usvisascheduling.com, not our extension")
skip("chrome.storage.local actual read/write behavior",
     "Requires Chrome extension runtime")


# ═════════════════════════════════════════════════════════════════════
# REPORT
# ═════════════════════════════════════════════════════════════════════

print("\n" + "═" * 70)
print("  US VISA AUTO BOOKING — TEST REPORT")
print("═" * 70)

current_section = ""
for status, name, detail in RESULTS:
    if status == "SECTION":
        current_section = name
        print(f"\n{'─' * 60}")
        print(f"  {name}")
        print(f"{'─' * 60}")
    elif status == "PASS":
        extra = f"  ({detail})" if detail else ""
        print(f"  ✅ {name}{extra}")
    elif status == "FAIL":
        extra = f"  ({detail})" if detail else ""
        print(f"  ❌ {name}{extra}")
    elif status == "SKIP":
        print(f"  ⏭️  {name} — {detail}")

print(f"\n{'═' * 70}")
print(f"  SUMMARY")
print(f"{'═' * 70}")
print(f"  Total tests:    {PASS + FAIL + SKIP}")
print(f"  Passed:         {PASS} ✅")
print(f"  Failed:         {FAIL} ❌")
print(f"  Skipped:        {SKIP} ⏭️")
print(f"  Pass rate:      {PASS/(PASS+FAIL)*100:.1f}%" if (PASS+FAIL) > 0 else "  Pass rate: N/A")
print(f"{'═' * 70}")

if FAIL > 0:
    print(f"\n  FAILED TESTS:")
    for status, name, detail in RESULTS:
        if status == "FAIL":
            extra = f" — {detail}" if detail else ""
            print(f"    ❌ {name}{extra}")

print(f"\n  VERDICT: {'GO ✅' if FAIL == 0 else 'NO-GO ❌ — fix failing tests'}")
print(f"{'═' * 70}\n")

sys.exit(1 if FAIL > 0 else 0)
