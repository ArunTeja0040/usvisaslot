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
- **Parallel detection (next enhancement):** plan = capture one real schedule request via page.js (URL+headers+token+body), replay per postId in parallel with stagger. Detection only, booking flow unchanged. Investigate page.js template-capture first.

---

## Cloudflare WAF
- #1 operational blocker historically. Check memory `project_cloudflare_waf.md` before proposing CF fixes — don't repeat failed strategies.
