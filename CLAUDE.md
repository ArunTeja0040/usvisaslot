# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chrome extension for automated US visa appointment booking on https://usvisascheduling.com for Indian consulates (Mumbai, New Delhi, Chennai, Kolkata, Hyderabad). Handles: login with CAPTCHA solving, security questions, dashboard navigation, and OFC/interview slot cycling with auto-submit.

## Setup & Run

1. Load extension in Chrome:
   - Go to `chrome://extensions/` → Enable Developer mode → Load unpacked → select `extension/` folder
2. Start CAPTCHA solver server:
   ```bash
   pip install ddddocr
   python captcha_server.py
   ```
3. Open https://usvisascheduling.com → settings panel appears on login page → fill credentials → click SAVE & START

## Architecture

```
extension/
  ├── manifest.json           MV3 manifest — permissions, content scripts, service worker
  ├── js/auto-booking.js      Main automation (login, CAPTCHA, security Qs, dashboard, cycling)
  ├── js/sw-enhanced.js       Service worker — relays CAPTCHA images to local solver
  ├── js/content.js           Original CVS extension — slot display, date selection, XHR processing
  ├── js/page.js              MAIN world script — intercepts XHR, dispatches vSCP events
  ├── js/options-init.js      Options page logic (not used in current flow)
  ├── js/html2canvas.js       Screenshot library
  ├── js/html2pdf.bundle.min.js  PDF generation for confirmations
  ├── js/sweetalert2.min.js   Alert dialogs
  ├── options.html             Options page HTML
  └── css/sidebar.css          Sidebar styles

captcha_server.py             Local OCR server (ddddocr) on port 5123
```

### Flow

```
Login Page (b2clogin.com)
  → Settings panel injected (position:fixed, left side)
  → User clicks SAVE & START
  → Auto-fill username/password
  → CAPTCHA: capture image → canvas → base64 → service worker → localhost:5123 → ddddocr OCR
  → CAPTCHA rules: must be exactly 5 alphanumeric chars, uppercase only
  → Click Continue
  → If wrong: refresh CAPTCHA, retry (up to 5 attempts)

Security Questions Page (b2clogin.com)
  → Detect 2 questions from saved answers
  → Auto-fill and click Continue

Dashboard (usvisascheduling.com)
  → Auto-click Reschedule/Continue button

Booking Page — OFC or Interview (usvisascheduling.com)
  → Booking panel injected (date range, location checkboxes, START/STOP)
  → Cycling: iterate through selected locations
  → 3-6 second random delay between locations (avoid Cloudflare rate limit)
  → Listen for vSCP events from page.js for schedule data
  → If dates found in preferred range → STOP cycling, select date, wait for user to submit
  → If auto-submit enabled → auto-select time slot and click submit
```

### Key Design Decisions

- **SAVE & START gate**: All automation (login, security Qs, dashboard, auto-submit) only triggers after user explicitly clicks SAVE & START. Without it, the site works normally. Uses `sessionStorage` flag.
- **Content script worlds**: auto-booking.js runs in ISOLATED world. page.js runs in MAIN world (intercepts XHR). Communication via CustomEvents (`vSCP`).
- **CAPTCHA canvas approach**: Image drawn to canvas → toDataURL → base64. Works because CAPTCHA is same-origin on b2clogin.com.
- **CSP workaround**: `clickSafe()` strips `javascript:` href before clicking to avoid CSP violations on b2clogin.com.

### Error Handling

- **401 Unauthorized**: DOM bridge detection (hidden div + MutationObserver crosses MAIN/ISOLATED world boundary). Saves cycling state to sessionStorage, redirects to login, auto-re-logins, restores cycling.
- **429 Rate Limited (Cloudflare)**: Detected via same DOM bridge. Exponential backoff: 60s → 120s → 240s → max 5min. Resets after successful request.
- **Rate limit warning** ("approaching maximum number of times"): Auto-logout to protect session.
- **Session keep-alive**: Page refreshes every ~8 minutes during cycling to prevent session expiry.

## Files

| File | Purpose |
|---|---|
| `extension/js/auto-booking.js` | All automation logic — the main file you'll edit |
| `extension/js/sw-enhanced.js` | Service worker — CAPTCHA relay + slot data push |
| `extension/js/content.js` | Original CVS extension (minified, read-only) |
| `extension/js/page.js` | MAIN world XHR interceptor |
| `captcha_server.py` | Local ddddocr OCR server |
| `extension/manifest.json` | Extension config |

## CAPTCHA Details

- Server: `captcha_server.py` on `localhost:5123` using `ddddocr` library
- Rules: always 5 characters, alphabets always uppercase, alphanumeric only
- Flow: image → canvas → base64 → service worker → POST to server → OCR → clean (strip special chars, uppercase, validate 5 chars) → return or reject and refresh
- Max 5 retry attempts before falling back to manual

## Branch

Active branch: `extension-v2-enhanced`
