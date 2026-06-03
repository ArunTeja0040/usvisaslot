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
