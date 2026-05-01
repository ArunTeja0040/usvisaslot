# Cloudflare Evasion — Implementation Plan

## Problem
Cloudflare is blocking ALL accounts — this means it's an **IP-level + behavior-level ban**, not account-specific. The cycling pattern is too machine-like and triggers bot detection.

## Current Behavior (What Cloudflare Sees)
- Fixed 3-6s delay between locations (uniform random = still predictable)
- Sequential location cycling: Mumbai → Delhi → Chennai → Kolkata → Hyderabad → repeat
- Full page reload every ~8 minutes (exact timer)
- No mouse movement, scrolling, or focus changes between requests
- Same request headers every time
- CAPTCHA solved in <1 second (humans take 3-8s)
- Continuous cycling for hours without any pause
- Multiple account logins from same IP in short succession

---

## P0 — Critical (Implement First)

### P0-1: Randomize Timing with Idle Gaps
**What:** Replace the fixed 3-6s delay with a human-like distribution + random idle pauses.
**Current code:** `auto-booking.js` line ~2050: `const delaySec = 3 + Math.random() * 3;`
**Change to:**
- Base delay: weighted random 4-12 seconds (not uniform — cluster around 6-8s)
- After every 4-8 cycles (random), insert an "idle gap" of 30-90 seconds
- After every 15-25 cycles, insert a longer "break" of 2-5 minutes
- Add ±20% jitter to ALL timers (keep-alive, backoff, delays)

**Why it works:** Uniform random is detectable. Real humans have bursts of activity followed by pauses. The idle gaps break the continuous-request pattern that Cloudflare's sliding window tracks.

**Risk:** Slower slot detection. A 2-minute break could miss a slot window.
**Mitigation:** Idle gaps are shorter (30-60s), breaks are rare (every 15-25 rounds).

**Files to change:** `extension/js/auto-booking.js` — `runCycleLoop()` function

---

### P0-2: Shuffle Location Order
**What:** Randomize location order each round instead of always iterating in DOM order.
**Current code:** `auto-booking.js` line ~2035: `const locations = Array.from(checked).map(...)` — always same order.
**Change to:** Fisher-Yates shuffle the `locations` array each round.

**Why it works:** Sequential cycling (A→B→C→D→A→B→C→D) is a unique fingerprint. Cloudflare can correlate the repeating sequence. Shuffled order (B→D→A→C→A→C→D→B) looks like a human browsing different options.

**Risk:** None. Location order doesn't affect slot detection.
**Mitigation:** N/A

**Files to change:** `extension/js/auto-booking.js` — `runCycleLoop()`, add `shuffleArray()` utility

---

## P1 — High Priority (Implement Second)

### P1-1: Replace Page Refresh Keep-Alive with Lightweight Fetch
**What:** Instead of `window.location.reload()` every 8 minutes, make a background `fetch('/en-US/', { credentials: 'include' })` to keep the session alive.
**Current code:** `auto-booking.js` — `cycling.keepAliveTimer` uses `setInterval` with `window.location.reload()`
**Change to:**
- Lightweight fetch to any page (e.g., `/en-US/`) with `credentials: 'include'`
- Randomize interval: 6-12 minutes instead of fixed ~8
- Only do full reload if the fetch fails or returns non-200

**Why it works:** Full page reloads trigger all Cloudflare JS challenges to re-run, generate full page loads in server logs, and the exact 8-min interval is a fingerprint. A background fetch is quieter and looks like AJAX activity.

**Risk:** Session might not stay alive if the site requires full page load for cookie renewal.
**Mitigation:** Fall back to full reload if fetch returns 401/403. Test on live site first.

**Files to change:** `extension/js/auto-booking.js` — keep-alive timer setup

---

### P1-2: Mouse/Scroll Event Simulation
**What:** Inject random mouse movements, scroll events, and clicks on neutral elements between API requests.
**Current code:** No human interaction simulation exists.
**Add:**
- Random `mousemove` events (3-8 between each location check)
- Occasional `scroll` events (small random amounts)
- Random `focus`/`blur` events on input fields
- Occasional `visibilitychange` simulation

**Why it works:** Cloudflare's bot detection JS (`cf_chl_opt`, `cf_chl_prog`) actively monitors for:
- Mouse movement entropy (random vs. linear paths)
- Scroll behavior
- Keyboard/focus events
- Time between events
A page with zero interaction events for 10+ minutes while making API calls = definite bot.

**Risk:** Overly synthetic mouse patterns could backfire. Cloudflare checks movement entropy.
**Mitigation:** Use bezier curves for mouse paths, not straight lines. Randomize event counts and timing.

**Files to change:** `extension/js/auto-booking.js` — new `simulateHumanActivity()` function

---

## P2 — Medium Priority (Implement Third)

### P2-1: Skip Empty Locations for N Rounds
**What:** If a location returned "no dates" 3 times in a row, skip it for the next 2-3 rounds.
**Current code:** Every round checks ALL selected locations, even if they've been empty for 50 rounds.
**Change to:**
- Track per-location empty count: `locationEmptyStreak[locValue] = count`
- If empty 3+ times → skip for next `Math.min(count - 2, 5)` rounds
- Reset streak to 0 when dates are found

**Why it works:** Reduces total request volume by 40-60% (most locations are empty most of the time). Fewer requests = less Cloudflare attention. Also mimics human behavior — you wouldn't keep checking Mumbai if it's been empty 20 times.

**Risk:** Could miss a slot at a skipped location.
**Mitigation:** Max skip = 5 rounds. Even worst case, a skipped location is re-checked within ~3 minutes.

**Files to change:** `extension/js/auto-booking.js` — `runCycleLoop()`, add `cycling.emptyStreaks` object

---

### P2-2: Adaptive Rate Throttle (Self-Regulation)
**What:** Track requests per 10-minute window. If approaching a threshold, voluntarily slow down.
**Current code:** Only reacts to 429 AFTER it happens. No proactive throttling.
**Add:**
- `cycling.requestTimestamps[]` — push `Date.now()` on each location check
- Before each request: count timestamps in last 10 minutes
- If > 30 requests in 10 min → double the delay for next 5 minutes
- If > 50 requests in 10 min → pause for 3 minutes

**Why it works:** Prevents the 429 from ever happening. By the time you get a 429, Cloudflare has already flagged your session. Staying under the threshold keeps you invisible.

**Risk:** Could be overly cautious, slowing detection.
**Mitigation:** Thresholds are generous. 30 requests in 10 min = one every 20s, which is already faster than human.

**Files to change:** `extension/js/auto-booking.js` — `runCycleLoop()`, add rate tracking logic

---

## P3 — Low Priority (Nice to Have)

### P3-1: Request Header Variation
**What:** Slightly vary `Accept-Language`, `sec-ch-ua` headers per request.
**Risk/reward:** Low impact, moderate complexity. Cloudflare weights behavior more than headers.

### P3-2: Canvas/WebGL Fingerprint Noise
**What:** Add tiny pixel noise to canvas operations to vary browser fingerprint.
**Risk/reward:** Only matters if Cloudflare is doing canvas fingerprinting on this specific site.

### P3-3: CAPTCHA Solve Delay
**What:** Add 3-6 second delay before submitting CAPTCHA answer (mimic human reading time).
**Current:** Answer submitted immediately after OCR returns.
**Risk/reward:** Easy win but only affects login phase, not cycling.

### P3-4: Organic Navigation Injection
**What:** Occasionally navigate to non-booking pages (profile, FAQ) during cycling.
**Risk/reward:** High complexity (need to navigate away and back without losing state). Moderate benefit.

---

## Implementation Order

| Step | Item | Est. Lines Changed | Dependencies |
|------|------|-------------------|--------------|
| 1 | P0-1: Randomize timing + idle gaps | ~30 lines | None |
| 2 | P0-2: Shuffle locations | ~10 lines | None |
| 3 | P1-1: Lightweight keep-alive | ~20 lines | None |
| 4 | P1-2: Mouse/scroll simulation | ~60 lines | None |
| 5 | P2-1: Skip empty locations | ~25 lines | None |
| 6 | P2-2: Adaptive rate throttle | ~30 lines | None |
| 7 | P3-3: CAPTCHA solve delay | ~5 lines | None |
| 8 | P3-1/P3-2/P3-4: Headers/canvas/nav | ~80 lines | Test P0-P2 first |

## Testing Strategy
After each step:
1. Load extension, start cycling
2. Monitor Chrome DevTools Network tab for request patterns
3. Run for 30+ minutes without hitting 429
4. Compare request cadence visually to previous runs

## Important Notes
- **Change IP first** before testing any code changes (restart router / use mobile hotspot)
- **Wait 24-48 hours** after current ban before testing
- **Test one change at a time** to know which ones actually help
- All changes are in `extension/js/auto-booking.js` only — no manifest or service worker changes needed
