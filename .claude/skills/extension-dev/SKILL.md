---
name: extension-dev
description: Safe-edit rules for the SlotHunter Chrome extension codebase (auto-booking.js, supabase-sync.js, dashboard.js, page.js). Use whenever writing or modifying extension code, to avoid breaking the working login/cycling/booking flow or the Cloudflare error recovery. Encodes the codebase's gotchas and conventions.
---

# extension-dev — Safe-Edit Rules

`auto-booking.js` is 4000+ lines and drives live client bookings. One bad edit can break real bookings or trigger Cloudflare IP blocks. Follow these rules.

## Golden rules

1. **Test folder only.** Edit `SlotHunter-test/extension/`. Never edit the production folder (`Usa Visa slot Booking/extension/`) from here.
2. **Feature-flag every new behavior.** Wrap new logic in a flag (like `TEST_MODE`). Old path must keep working unchanged. Provide a fallback to the existing sequential behavior.
3. **Don't touch the working booking flow** unless that's the task. Add NEW code paths beside it; don't rewrite cycling/submit.
4. **Keep TEST_MODE guards intact:** `TEST_MODE`, `TEST_FORCE_NO_SUBMIT`, `[TEST]` Telegram prefix, `TEST-` device prefix. Never remove them in this build.

## Worlds & events (do not cross wrong)
- ISOLATED world (auto-booking.js, supabase-sync.js, content.js): has `chrome.*`, NOT page JS.
- MAIN world (page.js, alert-override.js): page context, can wrap XHR/fetch, NO `chrome.*`.
- Cross only via CustomEvent: `vSCP` (schedule data), `__abAlertDismissed` (alerts), `fromContent` (commands to page).

## The schedule API — CAPTURE, never GUESS
- Power Apps portal needs `__RequestVerificationToken` + exact headers + `route`/`cacheString` params.
- NEVER hardcode/guess the token or body — a wrong request can hard-block.
- Correct approach: let page.js capture a REAL request (`_url`, `_requestHeaders`, `_postData`), store it as a template, then replay with a swapped `postId`. Stagger parallel calls (200-300ms) to avoid burst-block.

## Async & storage gotchas
- `chrome.storage.local.remove/set` is async. If a navigation/redirect follows, `await new Promise(r => chrome.storage.local.remove([...], r))` before navigating — else the value survives the page load (caused the rate-limit re-login bug).
- Status writes to Supabase only happen if `SupabaseSync.isReady()`. A device not connected = local-only status = invisible to other dashboards.

## Anti-flood / loops
- Any handler that can fire repeatedly (observers, page-load detectors, alert handlers) MUST have a re-entry guard (a `window.__xHandling` flag) and/or a sessionStorage attempt counter. The 1015 flood bug came from a missing guard.
- Navigation loops: cap attempts with a sessionStorage counter; after N, stop and wait.

## Cloudflare
- Don't increase request rate or remove humanDelay/throttle without care — raises block risk.
- Check memory `project_cloudflare_waf.md` before proposing CF strategies; don't repeat failed ones.

## After editing
- State plainly what changed and why (layman). Append to BUILD_LOG.md.
- Reload reminder: user must reload "SlotHunter TEST" in chrome://extensions + refresh the page.
