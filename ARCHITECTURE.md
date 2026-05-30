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

## The Schedule API (for parallel detection)

When the location dropdown (`#post_select`) changes, the site POSTs to get schedule days. `page.js` intercepts it.

- **Endpoint pattern:** `.../schedule-group/get-family-(emergency-)?(ofc|consular)-schedule`
- **Also:** `query-family-members`, `schedule-days` (vSD), `schedule-entries` (vST)
- **Method:** POST, form-encoded body. Body has a `parameters` field = JSON string containing `postId` (the location id).
- **Query params on URL:** `route`, `cacheString`.
- **Response (schedule days):** `{ ScheduleDays: [{ Date: "YYYY-MM-DD" }, ...], postId: "..." }`
- **Location map:** `#post_select` options → `value` = postId, `text` = location name (e.g. "MUMBAI VAC").
- **Auth:** Power Apps portal. Requires `__RequestVerificationToken` + cookies (same-origin auto). **DO NOT hardcode/guess the token or body. CAPTURE a real request (page.js already has `_url`, `_requestHeaders`, `_postData`) and REPLAY it with a swapped postId.** See `extension-dev` skill.

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
