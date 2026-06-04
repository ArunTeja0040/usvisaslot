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

### 403 finding (A3 test, 2026-05-31) — parallel fetch gets WAF-flagged after a few rounds
- A3 mechanism verified working: rounds 1-4 parallel ran clean (4→2 req/min, ~1.7-2.5s, no block). Fallback-to-sequential + "unable to load" re-entry both fired correctly when it broke.
- After ~5 rounds, parallel `fetch()` requests returned **403 Forbidden** (NOT 1015/rate). Then the site's OWN `session/valid` call also 403'd → whole session flagged → "Unable to load".
- Root cause (hypothesis): our content-script `fetch()` doesn't perfectly mimic the site's own XHR. We dropped headers the real request carries (`Request-Id`, `traceparent`, `Referer`, browser fingerprint/sec-fetch). WAF/bot-detection spots the mismatch after a few rounds → 403.
- NOT a rate problem (403 ≠ 429). It's a "doesn't look like the real page" problem.
- **A3 is NOT production-ready until 403 solved.** #31 wiring kept; 403 fix tracked separately.

### Tarpit finding (A3.1 Stage 1 test, 2026-05-31) — concurrency is the wall
- Stage 1 (tracing headers: Request-Id + traceparent reusing session trace-id) **FIXED the 403.** Header mimicry works.
- BUT all-5-at-once now gets **tarpitted**: parallel scans took 16s / 45s / 110s / 120s, with **524** (origin timeout) on some. avg per-request 33-36s.
- Sequential dropdown checks stayed **fast (~1.6-2.6s)** the whole time.
- Conclusion: the server **serializes/slow-walks concurrent schedule requests for one session.** Firing 5 together is SLOWER + unreliable than 1-by-1 on this site. Not a fingerprint problem anymore — a concurrency-tolerance problem.
- Safety nets all worked: fallback-to-sequential on 524, soft throttle 5/min, hard cap 6/min 60s pause.
- Next: test **concurrency = 2** (2 in flight max). If 2 stays fast → partial win. If 2 also tarpits → parallel can't beat sequential here; pivot to optimized sequential.

### Fix plan for 403 (A3.1 / A4)
1. Mimic the real request fully: send ALL captured headers incl. fresh per-request `Request-Id` + `traceparent` (generate like the site), add `Referer` = OFC page URL.
2. If still 403 → fire the parallel requests from the PAGE context (page.js, MAIN world) as real `XMLHttpRequest`, so they're identical to the site's own calls (same fingerprint), not a content-script fetch.
3. Keep stagger + parallel-replaces-sequential. Re-test for several rounds past the point it broke (round 5+).

### Burst finding (A2 test, 2026-05-31) — IMPORTANT for A3/A4
- Clicking TEST PARALLEL SCAN (5 requests at once) WHILE sequential cycling was also running → ~7 requests in ~1 min → Cloudflare 429 → 1015 block.
- Lessons:
  1. **Parallel scan must REPLACE the sequential per-city loop, not run alongside it.** When parallel is ON, the one-by-one dropdown checking must be OFF. (A3 requirement.)
  2. **Cloudflare here is strict on bursts.** 5 requests fired close together can trip the limit even though total == sequential. Mitigate: limit concurrency (2-3 at a time, not all 5), larger stagger, and don't scan too often. (A4 requirement.)
  3. Winning pattern likely: ONE controlled parallel burst per round, then a healthy wait. Never parallel + sequential together.
- A2 parallel fetch itself works (valid data, 3.7s for 5). The risk is frequency/burst, not correctness.

### Booking chain captured (Issue #36, 2026-06-04) — full 3-step flow + CRITICAL token finding
Captured a real VAC booking end-to-end (live slot). All 3 steps:

1. **DAYS** — `POST /en-US/custom-actions/?route=/api/v1/schedule-group/get-family-ofc-schedule-days&appd=<APPT>&cacheString=<ms>`
   - body: `parameters={"primaryId","applications":[..],"scheduleDayId":"","scheduleEntryId":"","postId":"<city>","isReschedule":"false"}`
   - resp: `{"ScheduleDays":[{"ID":null,"Date":"2027-01-20"},...],"Token":"<TOKEN_A>"}` (each day: ID null + Date string)

2. **TIMES** — `POST .../route=/api/v1/schedule-group/get-family-ofc-schedule-entries&appd=<APPT>&cacheString=<ms>`
   - body: `parameters={"primaryId":null,"applications":null,"scheduleDayId":null,"scheduleEntryId":"","postId":null,"Token":"<TOKEN_A + appended date-blob>"}`
   - resp: `{"ScheduleEntries":[{"ID":null,"EntriesAvailable":5,"Time":"09:00","Num":1},...],"Token":"<TOKEN_B>"}`

3. **SUBMIT** — `POST .../route=/api/v1/schedule-group/schedule-ofc-appointments-for-family&appd=<APPT>&cacheString=<ms>`
   - body: `parameters={...nulls...,"Token":"<TOKEN_B + appended time-blob>"}`
   - resp: `{"AllScheduled":true,"RedirectStub":"schedule/",...}` → BOOKED, redirects to consular scheduling.

**CRITICAL FINDING — pure-API booking for a CHOSEN date is NOT feasible:**
- The chosen date/time are NOT sent as plain fields (all null in body). They are **baked into the Token**: each step's input token = previous response token + an **opaque encrypted blob** appended by the site's calendar JS when the user clicks a date/time.
- Confirmed: TIMES-input token === DAYS-response token + extra ~96-char blob. We cannot forge that blob (site-side crypto).
- Token rotates each step: days→TOKEN_A, entries(TOKEN_A+dateblob)→TOKEN_B, submit(TOKEN_B+timeblob)→done.
- Day objects + entry objects have `ID:null` — no usable per-date/per-time id to send; the token is the only carrier.

**Implication:** Can't book a specific date via raw fetch (can't build the date-blob). Fast path must: detect via API (all cities, instant) → switch dropdown to the ONE winning city → trigger the site's own datepicker select (it builds the correct token) → pick time → submit (reuse existing booking code). Only one city-switch round-trip (~1-2s), unavoidable because the date is encrypted into the site-built token.
- Submit endpoint name: `schedule-ofc-appointments-for-family`. Success flag: `AllScheduled:true`. Consular = same flow on `schedule/`.
- NOTE: appd + primaryId are per-user/session (3 different accounts seen across captures).

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
