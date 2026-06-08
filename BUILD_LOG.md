# BUILD_LOG.md — Plain-English History

Every build gets an entry here, written in simple, non-technical language. Newest on top.

Format:
```
## YYYY-MM-DD — <short title> (Issue #N)
**What it does:** plain English.
**Why:** plain English.
**What changed for you:** plain English.
```

---

## 2026-06-07 — Dashboard: delete-sync + rate-limit unblock + search (#42/#43/#44)
**What it does:**
- **#42 Delete sync:** deleting a profile now removes it from ALL dashboards, not just the one you clicked on. The cloud is treated as the master list — anything removed there is removed everywhere on the next sync.
- **#43 Rate-limit unblock:** a profile flagged "rate limited" now auto-unblocks after 24 hours (Start button returns). Before, it could stay stuck/blocked forever because the check ignored the clock.
- **#44 Search:** added a search box at the top of the profiles list — type a name or username to filter instantly, no scrolling.
**Why:** Three operator-dashboard annoyances — deletes didn't propagate, rate-limit blocks never lifted, and finding a profile meant scrolling the whole list.
**What changed for you:** Delete once → gone everywhere. Rate-limited users free themselves after 24h (your currently-stuck one should clear on next dashboard sync). A search box to jump to any profile. Dashboard-only — no effect on the booking bot. (Caveat for #42: a profile created locally but not yet pushed to cloud could be pruned on sync — profiles are cloud-synced, so low risk.)

## 2026-06-07 — Patient grab + never stop hunting (Issue #41)
**What it does:** Two fixes to the booking grab. (1) **Patient calendar:** when grabbing a slot, the bot now waits up to 10 seconds for the pop-up calendar to finish loading (slow under heavy traffic) instead of giving up the instant it's not there; still waits up to 12s for time slots before submitting. (2) **Retry + keep hunting:** if the calendar or times don't load, it re-pokes the SAME city (no page refresh) to reload and tries again, up to 5 times. If the date is gone (taken/unlisted) or after 5 tries, it goes back to scanning all cities — instead of stopping dead like before. A date that's listed but never actually clickable is skipped for 15 minutes so it can't get stuck on it.
**Why:** A real client (GOGREE) hit exactly this — the calendar was slow, the bot gave up AND stopped completely, so that client quit hunting. Now it's patient and never silently stops on a failed grab.
**What changed for you:** Much more reliable booking, and the bot keeps hunting after a miss. Worst case it spends ~10-12s being patient per try, then moves on. (Rate-limit/429 during the grab is still a separate, unfixed risk.)

## 2026-06-07 — LIVE booking enabled (Issue #40)
**What it does:** Turns OFF the safety that stopped the bot before the final "Submit." Now when the bot grabs an in-range slot, it ACTUALLY books it (clicks Submit for real). Also added a guard so it won't crash if the Submit button isn't ready, and a guard preventing a double-click.
**Why:** Move from dry-run to real booking, as approved.
**What changed for you:** ⚠️ REAL BOOKINGS NOW HAPPEN. The next in-range slot the bot finds gets booked for real on the live account — irreversible. It books the FIRST in-range date, then stops. Set your date range to ONLY dates you genuinely want. Telegram still shows the [TEST] tag (TEST_MODE on) but the booking is REAL. Note: a rate-limit (429/1015) during booking can still make it fail — that hardening is not done yet.

## 2026-06-07 — Instant restart on "unable to load" (Issue #39)
**What it does:** When the site throws "unable to load," the bot used to wait 60 seconds before going back to the dashboard to restart. Now it goes straight to the dashboard and restarts immediately — no wait.
**Why:** That 60s wait was dead time. Faster restart = back to scanning sooner.
**What changed for you:** On "unable to load," the bot jumps to the dashboard and resumes right away. Safety net: if the error keeps repeating fast (4+ times within 2 minutes), it takes ONE 60-second breather to avoid hammering Cloudflare (which could IP-ban you). Normal case = instant.

## 2026-06-05 — Faster start: go parallel after the first city (Issue #38)
**What it does:** Before, the very first round checked ALL your cities one-by-one (slow) before switching to the fast "2 at a time" mode. The bot only needs to peek at ONE city to learn how to do the fast checks. Now it checks just the first city, then immediately switches to fast mode for everything else.
**Why:** Those ~4 extra slow checks at the start wasted ~30-60 seconds before fast mode kicked in. No reason for them.
**What changed for you:** The bot reaches fast mode almost immediately — round 1 = one city, then fast 2-at-a-time. The first city still gets checked (and grabbed if it has an in-range slot). Nothing missed — fast mode rotates through all cities. If fast mode ever errors and falls back to one-by-one, it still checks them all, as before.

## 2026-06-05 — Availability alerts on the fast rounds too (Issue #37)
**What it does:** Until now, the "what's available" Telegram (📍 SLOTS OVERVIEW — in-range vs out-of-range dates) only went out on the very first round. Every round after is the fast "2 cities at once" check, which sent nothing unless a slot was actually in your range. Now those fast rounds also send the same in/out overview for every city that has dates — so you always see what's open, every round.
**Why:** You weren't getting any messages while dates were clearly showing up — because those finds were on the fast rounds, which were silent. Now the fast rounds report availability too.
**What changed for you:** Expect MORE Telegram messages — one 📍 SLOTS OVERVIEW per city that has dates, every fast round (~every 20s), split into IN RANGE / OUT OF RANGE by month. If it's too chatty, we can switch to "only when it changes" later. No booking change; still dry-run.

## 2026-06-05 — One booking path + correct time in alerts (Issue #36)
**What it does:** Before, the bot had TWO ways of grabbing a slot — a new fast way (used on the "all cities at once" rounds) and an older slower way (used on the very first round and any fallback round). They sent different messages and behaved differently. Now there's just ONE way: every time the bot spots a slot in your date range, no matter which round found it, it uses the same fast grab. Also fixed the alert so it shows the real appointment TIME (like "09:00") instead of accidentally repeating the date.
**Why:** Two paths meant confusing double messages, and the slow path could sneak in on the first round and book the old (slower) way — defeating the whole point of the fast grab. One path = predictable, always fast, one clean set of messages.
**What changed for you:** You'll now see the same messages every time — 🎯 "Slot found — grabbing", then 🧪 "Would book [city/date/TIME]" (dry-run) — whether the slot is caught on the first round or a later round. The time shown is now the actual slot time. Still DRY-RUN (nothing books for real). Trade-off: the bot now goes for the FIRST in-range date it sees (your chosen "grab fastest" design) instead of trying several dates one-by-one. The old "🟢 SLOT FOUND! / Auto-submitting / screenshot" messages during booking are gone (the plain "SLOTS OVERVIEW" availability message stays — that's just info).

## 2026-06-04 — Fast-grab booking + Telegram (Issue #36, dry-run stage)
**What it does:** When the scan finds a date inside your range, the bot instantly grabs it: jumps to that city, picks the date the moment the calendar data arrives, picks the first time the moment times arrive, and submits — all reacting to the website's own signals (no waiting/polling), so it's ~2-3 seconds. You get Telegram messages at each step: "🎯 Slot found — grabbing", and either "🎉 VAC BOOKED!" or "⚠️ slot taken".
**Why:** Detection was fast but the bot didn't book. This makes it actually secure the appointment the instant it spots one — the whole point.
**What changed for you:** SAFETY: it's in DRY-RUN — it does everything except the final submit, and sends "🧪 WOULD BOOK [city/date/time]" so you can confirm it works WITHOUT booking for real. Flip one switch later to go live. First in-range slot wins; VAC only for now.

## 2026-06-02 — Rotating batch-of-2 scan (Issue #35)
**What it does:** Instead of checking ALL selected cities at once (which overwhelmed the site → slow + "too many requests"), the bot now checks just **2 cities each round**, rotating through your list. E.g. 5 cities → round 1: Hyd+Chennai, round 2: Kolkata+Mumbai, round 3: Delhi+Hyd, and so on. Always 2 at a time, every ~20s.
**Why:** 2-at-a-time is the website's sweet spot — fast (~2s) and stays under the rate limit. 4-5 at once was getting blocked (429) and stopping. This way every city still gets checked regularly, reliably, with no blocks.
**What changed for you:** Pick as many cities as you want — the bot quietly rotates through them 2 at a time. No more "too many requests" stops. Each city is checked roughly every ~50s (for 5 cities), steady and reliable. Also: if the page breaks after a block, it now re-enters via dashboard instead of stopping.

## 2026-06-02 — Fix: detect the full-page Cloudflare checkbox page (Issue #34)
**What it does:** The bot now recognizes Cloudflare's "verify you are human" page even though the checkbox itself is hidden inside a protected frame. It spots the page by its title ("Just a moment") and text ("Performing security verification") — things our code CAN see — then sends the Telegram alert naming the device.
**Why:** First version missed it: the checkbox is locked inside a closed frame our code can't read, so the bot thought it was the dashboard and sat waiting forever with no alert. Now it detects the page reliably.
**What changed for you:** When the checkbox page appears, you now get the Telegram alert ("Cloudflare challenge on device X — remote in and click") instead of silence. After you click, the page moves on and the bot resumes.

## 2026-05-31 — Cloudflare challenge: alert + remote-solve + auto-resume (Issue #34)
**What it does:** When the website throws its "verify you are human" checkbox (the real cause of "unable to load"), the bot now: stops, sends you a Telegram alert that says WHICH device is stuck, reloads the page so the checkbox is visible, then waits. You remote into that machine (Chrome Remote Desktop), click the checkbox once, and the bot resumes by itself.
**Why:** That checkbox can't be clicked by software (it's built to need a real human). Solving it once on the machine's network unblocks everything. The alert tells you exactly which machine to remote into, from anywhere.
**What changed for you:** Instead of silent "unable to load" failures, you get a clear Telegram: "Cloudflare challenge on device X — remote in and click." One click, bot continues. One-time setup: install Chrome Remote Desktop on the machine.

## 2026-05-31 — Removed long "human-like" pauses (Issue #32)
**What it does:** Turned off the bot's long rest breaks (the 30-90s idle pause and the 2-5 min long break). The bot now keeps a steady ~45s gap between rounds instead.
**Why:** Testing showed those long pauses made the connection go "cold" — and the very next check after a pause got rejected (403 / "unable to load"). 2-cities-at-once ran perfectly for 16 rounds until a pause hit. Removing the pauses removes that failure.
**What changed for you:** The bot no longer takes long breaks. It checks steadily every ~45s. Should run without the "unable to load" that kept appearing right after a rest. Trade-off: slightly more robotic rhythm (we judged the pause was hurting more than helping).

## 2026-05-31 — Make parallel requests look like the real page (Issue #32, Stage 1)
**What it does:** Our fast "all cities at once" requests now carry the same tracking headers the website's own requests use (a session ID + a fresh per-request ID), so they look identical to normal page activity.
**Why:** In testing, after ~4-5 rounds the website's security started rejecting our requests (403 Forbidden) because they didn't look exactly like the real page. Adding these headers should let them blend in and not get flagged.
**What changed for you:** Nothing visible. Behind the scenes the parallel requests now mimic the website more closely. Test = let it run 10+ rounds and check it no longer gets the 403/"unable to load" after round 5.

## 2026-05-31 — Cycling now uses parallel scan (Issue #31, Activity 3 of 4)
**What it does:** When the bot starts a user, the first round runs normally (one-by-one) to grab the template. After that, every round checks ALL selected cities at once instead of one-by-one. The slow one-by-one method automatically switches off. If anything goes wrong (no template, an error, or a "too many requests"), it safely falls back to the old one-by-one way for that round.
**Why:** This is the actual speed upgrade in action — each round now covers all cities in ~3-4 seconds instead of ~1-2 minutes, and avoids the earlier mistake of running both methods together (which caused the block).
**What changed for you:** Start a test user and watch — round 1 is normal, then it flips to "⚡ Parallel scanning..." and checks everything together, waiting ~45s between rounds. Still NO booking. If it ever hits a block it logs out safely like before.

## 2026-05-31 — "Ask all cities at once" function + test button (Issue #30, Activity 2 of 4)
**What it does:** Built the function that sends a request to ALL cities at the same time (instead of one-by-one) and reads back each city's available dates. Added a purple "⚡ TEST PARALLEL SCAN" button on the booking panel so you can try it with one click.
**Why:** This is the core of the speed boost — checking 5 cities together takes ~3-5 seconds instead of ~50. The button lets us prove it works and is accurate before wiring it into the real cycling.
**What changed for you:** A new purple button on the OFC booking panel (test build only). Clicking it scans all cities instantly and shows each city's dates + how fast it was. It does NOT book anything and does NOT change the normal cycling yet.

## 2026-05-31 — Remember the real slot request (Issue #29, Activity 1 of 4)
**What it does:** When you change the city dropdown, the test extension now quietly remembers the exact request the website made (the web address + your per-session IDs).
**Why:** So later we can copy that exact request to ask all 5 cities at once — using the real thing, never a guess.
**What changed for you:** Nothing visible. Behind the scenes, after you change the city once, the console shows "template captured". No effect on booking or cycling. Just the foundation for the fast all-at-once scan coming next.

## 2026-05-31 — Investigated how the site fetches slots (Issue #28)
**What it does:** We watched the real request the website makes when you change the city dropdown, and wrote down exactly how it works.
**Why:** So when we build the "check all cities at once" feature, we copy the real request instead of guessing — no risk of getting blocked for sending a wrong request.
**What changed for you:** Nothing visible yet — this was research. Good news: the website's slot request needs no special security token, just your normal login. That means checking all 5 cities at the same time is safe and simple to build next. Findings saved in the project notes.

## 2026-05-31 — Test workspace set up (no issue)
**What it does:** Created a separate, safe copy of the extension for testing new ideas, plus a set of guide documents so the assistant always knows the rules, the code, and the workflow without being reminded.
**Why:** So new booking improvements can be built and tried in ONE test Chrome profile without ever touching the live extension that runs all your real clients.
**What changed for you:** You now have a "SlotHunter TEST" extension to load in one test profile. It can find slots but will NOT book anything until you say so. Every future build will be explained here in plain English automatically.
