# TESTING.md — How to Test the TEST Build

---

## Load the test extension (one time)

1. `chrome://extensions/` → Developer mode ON.
2. Load unpacked → select `/Users/aruntejagannu/Documents/Claude/Projects/SlotHunter-test/extension/`.
3. It appears as **"SlotHunter TEST"** — load it in your ONE test Chrome profile only.
4. Production "SlotHunter" stays loaded in all other profiles — untouched.

## After every code change
- Go to `chrome://extensions/` → click reload (↻) on **SlotHunter TEST**.
- Refresh the visa site tab.

---

## TEST_MODE guardrails (top of `extension/js/auto-booking.js`)

```js
const TEST_MODE = true;            // keep true in this build
const TEST_FORCE_NO_SUBMIT = true; // true = detect only, never book
```

- **Detection stage** (default): `TEST_FORCE_NO_SUBMIT = true`. Bot finds slots, never clicks submit. Safe on a real client.
- **Booking stage** (only after user approval): set `TEST_FORCE_NO_SUBMIT = false`.

---

## What to watch when testing

| Where | What to look for |
|-------|------------------|
| Booking panel status bar | live status, `req/min` rate |
| Activity log (dashboard) | events for the test user |
| Telegram | messages prefixed `🧪 [TEST]` |
| Supabase tables | rows where device_name starts `TEST-` |
| DevTools console | logs prefixed `[AutoBook-TEST]` |

## Force-trigger helpers (DevTools console on the page)

- Fake "unable to load":
  ```js
  document.dispatchEvent(new CustomEvent("__abAlertDismissed", { detail: "Unable to load appointment available days" }));
  ```

## Safe vs risky tests
- **Safe (detection):** cycling, slot detection, rate tracking, parallel scan, status sync — no booking.
- **Risky (booking):** only after detection proven + user approves flipping `TEST_FORCE_NO_SUBMIT`.

## Confirm isolation
- Test extension has its OWN `chrome.storage.local` (separate extension ID). It does NOT share local data with production.
- It DOES share Supabase + Telegram (tagged `TEST-` / `[TEST]`).
