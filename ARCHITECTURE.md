# ARCHITECTURE.md — How SlotHunter Works

Map of the extension so logic doesn't need re-deriving each session.

---

## Files

```
extension/
  manifest.json            MV3 config — permissions, content scripts, hosts
  js/auto-booking.js       MAIN automation: login, CAPTCHA, security Qs, dashboard, cycling, booking, error recovery, rate tracker. ~4000+ lines. The file you edit most.
  js/supabase-sync.js      Cloud sync: profiles, status, slots, events, devices, request_stats. Encryption with master password.
  js/dashboard.js          Dashboard UI (dashboard.html): user cards, start/stop/logout, cloud sync, stats, filters.
  js/content.js            Original CVS extension (minified, read-only). Slot display, XHR processing.
  js/page.js               MAIN world XHR interceptor. Fires vSCP events with schedule data.
  js/alert-override.js     MAIN world. Intercepts window.alert(), dispatches __abAlertDismissed event.
  js/sw-enhanced.js        Service worker. CAPTCHA relay, Telegram send, quota checks.
  js/sheets-sync.js        Google Sheets sync.
  dashboard.html           Operator dashboard page.
```

---

## Content script worlds (critical)

- **ISOLATED world** (`auto-booking.js`, `content.js`, `supabase-sync.js`): has `chrome.*` APIs. Cannot touch page's JS variables directly.
- **MAIN world** (`page.js`, `alert-override.js`): runs in the page's own context, can wrap XHR/fetch and read page JS. No `chrome.*`.
- **Communication:** MAIN → ISOLATED via `CustomEvent`. Key events:
  - `vSCP` — schedule data (from page.js). detail = `{ data, resource }` where resource is `vD` (members), `vSD` (schedule days), `vST` (time slots).
  - `__abAlertDismissed` — an alert() was auto-dismissed (from alert-override.js). detail = alert text.
  - `fromContent` — ISOLATED → MAIN, e.g. select a date/location.

---

## The Schedule API (CONFIRMED via Issue #28 capture, 2026-05)

When the location dropdown (`#post_select`) changes, the site POSTs to get schedule days. Confirmed from real captured requests:

- **Endpoint (one URL for all cities):**
  ```
  POST /en-US/custom-actions/?route=/api/v1/schedule-group/get-family-ofc-schedule-days&appd=<APPT_ID>&cacheString=<ms-timestamp>
  ```
  - `appd` = appointment/application id — per user/session, SAME across all cities in a session.
  - `cacheString` = millisecond timestamp, cache-buster, regenerate per call (`Date.now()`).
- **Method:** POST, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.
- **Headers:** `Accept: application/json...`, `X-Requested-With: XMLHttpRequest`. `Request-Id`/`traceparent` are tracing, optional. **NO `__RequestVerificationToken`.**
- **AUTH = LOGIN COOKIE ONLY.** Same-origin fetch auto-sends it. No anti-forgery token in the request → parallel replay is straightforward.
- **Body (only `postId` changes per city):**
  ```
  parameters={"primaryId":"<USER_ID>","applications":["<USER_ID>"],"scheduleDayId":"","scheduleEntryId":"","postId":"<CITY_ID>","isReschedule":"false"}
  ```
  - `primaryId` + `applications[0]` = applicant id, per user/session, same across cities.
  - `postId` = the city — the ONLY value to swap for parallel scan.
  - `scheduleDayId`/`scheduleEntryId` empty for the days fetch (used in later booking steps).
- **Response:** `{"ScheduleDays":[{Date:"YYYY-MM-DD"},...] , "ScheduleEntries":null, "CategoryID":"...", "Token":"...", "HasError":false, "Errors":{...}}`
  - `ScheduleDays` = available dates (empty `[]` = no slots).
  - `Token` (response) only needed for the downstream day/entry selection + booking, NOT for fetching days.
- **City → postId map** (this session — re-read live, ids are stable per environment):
  - CHENNAI VAC `3f6bf614-b0db-ec11-a7b4-001dd80234f6`
  - HYDERABAD VAC `436bf614-b0db-ec11-a7b4-001dd80234f6`
  - KOLKATA VAC `466bf614-b0db-ec11-a7b4-001dd80234f6`
  - MUMBAI VAC `486bf614-b0db-ec11-a7b4-001dd80234f6`
  - NEW DELHI VAC `4a6bf614-b0db-ec11-a7b4-001dd80234f6`
- **page.js events:** schedule-days response → `vSCP` resource `vSD`; entries → `vST`; members → `vD`.

### Parallel-fetch rule (capture-replay, still applies)
`appd` + `primaryId` are per-user/session. CAPTURE them from the first real dropdown-change request (page.js sees `_url` + `_postData`), build a template, then `fetch()` all cities in parallel with swapped `postId` + fresh `cacheString`. Stagger 200-300ms to avoid burst-block. Booking flow stays on the existing dropdown path.

---

## Main flows

### Login (b2clogin.com)
- Settings panel injected. SAVE & START gate (sessionStorage flag) — automation only runs after the user clicks it.
- Auto-fill username/password. CAPTCHA optional (site removed it — fills then clicks Sign In directly if no CAPTCHA).
- Security questions: detect 2 questions, auto-fill, continue.

### Dashboard (usvisascheduling.com/en-US/)
- Auto-click Reschedule / Continue → reach booking page.
- Severe-logout flag (`__abSevereLogout`) → find sign-out link, log out instead of clicking through.

### Cycling (OFC / interview page)
- Booking panel injected (dates, location checkboxes, START/STOP/LOGOUT).
- Loop selected locations, humanDelay between (weighted 4-25s), simulate human activity.
- Listen for `vSCP` schedule data → check dates in range.
- In range → select date → (auto-submit if enabled) → book.
- Rate tracker: counts req/min, soft throttle 4/min, hard cap 6/min, flush stats to Supabase every 60s.

### Error recovery
- **Unable to load / "An error has occurred"** → stop → 60s cooldown → dashboard re-entry → resume cycling.
- **1015 / CF blocked / 429 (severe)** → `handleSevereError`: re-entry guard + attempt counter. 2 dashboard-logout tries, then stop + wait (no flood, no IP-wide block).
- **Rate limit "exceeded the limit"** on OFC → auto-logout, set `rate_limited` + timestamp in Supabase, dashboard shows red banner + blocks START (24h auto-clear).
- **Waiting room** (any domain) → detect by text, auto-refresh, NOT treated as Turnstile.
- **Turnstile "verify you are human"** (any domain) → wait for manual solve.
- **401** → re-login flow. **Page Not Found / site error** → retry with caps.

---

## Persistence keys
- `chrome.storage.local`: `userProfilesList`, `loginDetails`, `securityQuestions`, `activeAutomationUser`, `userStatuses`, `is_auto-*`, `captchaMode`, `telegram*`, `__supabase_*`, `eventLog`.
- `sessionStorage` (per origin): `ab-cycling-state`, `__autoBookingRelogin`, `__abSevereLogout`, `__abSevereCount`, retry counters.
