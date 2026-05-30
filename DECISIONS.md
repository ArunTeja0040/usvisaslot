# DECISIONS.md — Decisions, Known Issues, Deferred Items

Running memory across sessions. Newest on top.

---

## Decisions

- **2026-05: Test build via git worktree.** Separate folder `SlotHunter-test/` on branch `feature/parallel-booking`. Production folder stays untouched. Test extension = different ID = isolated local storage, loaded in ONE test profile.
- **Test filtering by device_name prefix `TEST-`** (not a new DB column) — zero schema change, dashboard filters by prefix.
- **Detection-first staging.** New booking logic tested with `TEST_FORCE_NO_SUBMIT = true` (no real booking) until proven, protecting the real client used for testing.
- **Severe-error handling (1015/429/CF):** 2 dashboard-logout attempts via `__abSevereCount`, then stop + wait. Re-entry guard `window.__severeErrorHandling` prevents per-page flood. Restores stable "log once + wait" when whole site blocked.
- **"Unable to load"/"An error has occurred":** dashboard re-entry + 60s cooldown, then resume cycling.
- **Rate-limit "exceeded the limit":** auto-logout, `rate_limited` + `rate_limited_at` in Supabase, dashboard red banner + Blocked button (Shift+Click force), 24h auto-clear.
- **CAPTCHA removed by site:** login fills user/pass then clicks Sign In directly when no CAPTCHA present.
- **Config export/import:** base64 string carries Telegram + Supabase keys for fast new-profile onboarding (pulls all profiles after connect).
- **Deferred to FUTURE_ROADMAP:** #6 Telegram Remote Control, #7 CAPTCHA cloud deploy (Fly.io).

---

## Known issues / open questions

- **anuk0505 cross-device status:** showed cycling locally on one device but idle on others. Root: the cycling device wasn't writing status to Supabase (`isReady()` false / not connected on that profile), so cloud stayed stale (`on_dashboard`, device "Testing"). Stale device heartbeat (>10 min) → dashboard auto-cleanup marked it idle elsewhere. FIX PATH: ensure every device running users is Supabase-connected. (Unconfirmed whether the running profile was connected.)
- **Date range empty after stop/start on OFC panel (closed #25):** dates set on OFC panel weren't persisted back to profile; closed without code fix — revisit if it recurs.
- **Parallel detection (next enhancement):** plan = capture one real schedule request via page.js, replay per postId in parallel with stagger. Detection only, booking flow unchanged.

### Step 0 findings — schedule API (Issue #28, CONFIRMED via live capture)
- Endpoint: `POST /en-US/custom-actions/?route=/api/v1/schedule-group/get-family-ofc-schedule-days&appd=<APPT_ID>&cacheString=<ms>`.
- **No anti-forgery token in request** — auth is login COOKIE only (auto on same-origin fetch). Parallel replay is easy + low-risk on auth.
- Body: `parameters={...,"primaryId":"<USER_ID>","applications":["<USER_ID>"],"postId":"<CITY>","isReschedule":"false"}` — only `postId` changes per city.
- `appd` (URL) + `primaryId` (body) are per-session → capture live, reuse. `cacheString` = fresh `Date.now()`.
- Response `{"ScheduleDays":[{Date}],...}`. Response `Token` only for downstream booking, not for days fetch.
- City→postId map recorded in ARCHITECTURE.md.
- Conclusion: parallel fetch is the clean approach — fire all 5 cities at once (staggered), cookies auto-attach, parse `ScheduleDays`. Booking flow untouched. Token reuse not even needed for detection.
- Not yet tested: how many simultaneous fetches before Cloudflare pushback (will stagger + start conservative).

---

## Cloudflare WAF
- #1 operational blocker historically. Check memory `project_cloudflare_waf.md` before proposing CF fixes — don't repeat failed strategies.
