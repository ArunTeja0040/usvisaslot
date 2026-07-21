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

## 2026-07-21 — Fix: Deactivate did nothing on production (Issue #53 follow-up)
**What was wrong:** Clicking **Deactivate** on a staff member did nothing at all — the person didn't grey out, and their clients didn't come back to you. The database was rejecting the whole action.
**Why:** When someone is deactivated, the system writes a note into the activity log for each client it returns to you. That note was written to a column called `type` — but your real activity-log table names that column `event_type`. (The mismatch came from a throwaway test database that happened to use the other name.) So every deactivate hit an error and the database undid the entire thing, leaving nothing changed.
**The fix:** Two parts. (1) Use the correct column name so the note saves. (2) Wrap the note-writing so that even if it ever fails again, it can **never** block the actual job of releasing the clients — the note is skipped, the clients still come back. Also corrected the test database blueprint so it matches your real one and can't cause this kind of surprise again.
**What changed for you:** Deactivate now works: the person greys out to "Reactivate", and their clients return to your pool immediately.

---

## 2026-07-20 — Staff login and their own dashboard (Issue #53)
**What it does:** Turns the keys you hand out into something real. A staff member pastes their key into the same Cloud Sync box you use. The extension spots that it's a staff key (they all start `SH-`) and switches into staff view on its own — no separate app, no separate download.

**What they see:** only the clients you assigned them. Their screen carries a purple **STAFF VIEW** badge and a line explaining they're seeing a subset, so nobody ever confuses it for your dashboard.

**What's hidden from them:** every price, client passwords and security answers, Add User, Delete, Export, Import, Sheets Sync, Export Config, and the Staff button. What's left is what you agreed they should have: start, stop, and edit the date range and cities.

**A bug this caught before it bit:** the password is scrambled with a different random starting value every single time it's saved — so re-saving an *unchanged* password still produces different-looking text. The protection built in Phase 1 would have read that as "this staff member is meddling with the login" and blocked it. Since the booking engine re-saves profiles during normal running, **every staff member's automation would have died** with a baffling message about date ranges. Now the extension simply never re-saves whole profiles in staff view; date and city edits send only those two fields.

**Why that fix matters beyond the bug:** it lives in one shared file, so the booking engine itself needed no changes at all. The part that books your live appointments is untouched by this work.

**What changed for you:** nothing. Your dashboard behaves exactly as before — all of this only activates for someone connecting with a staff key.

**Still to be straight about:** the prices are hidden from their *screen*, but the price is still stored alongside each client, so someone technical could still reach it. It becomes genuinely unreachable in the next step, which moves pricing out of that table for good. Same for client passwords — their computer must be able to unlock logins to do the booking at all, so that one is screen-level only and always will be.

---

## 2026-07-20 — Staff & client assignment, owner side (Issue #52)
**What it does:** Adds the owner's control panel for handing clients to your hired staff. Three new pieces, all switched off until you turn them on:
1. A **Team Mode** tick-box inside Cloud Sync. Off = your dashboard behaves exactly as it always has. On = the two things below appear.
2. A **Staff** button in the top row. Opens a popup where you add a person (name + email). Each person gets a long random key — that key is what makes their extension show only the clients you gave them. Buttons per person: **Copy key**, **Rename**, **New key** (kills the old one instantly, for when a key leaks), and **Deactivate**.
3. On each client card, an **"Assigned to"** picker, plus tick-boxes and an **Apply** bar at the top so you can hand over many clients at once instead of one by one.

**Why:** You have around 100 clients and 5 staff. Handing out logins one at a time was never going to work, and you needed a way to give someone 15 clients without showing them the other 85 — or what you charge.

**What changed for you:**
- **Nothing, until you switch Team Mode on.** Default is off, and the Staff button and assignment picker are hidden until then.
- Turning it on **checks the database first**. If the team tables aren't set up there yet, it refuses politely and tells you which files to run, rather than half-working.
- **Deactivating someone** cuts their access straight away and their clients come back to you automatically. That's enforced inside the database itself, not just by the dashboard — so it holds even if someone changes it another way. Before each client is released, a line is written into your activity log recording who used to hold it, so you don't lose that history.
- The **pricing you charge stays invisible** to staff. That part is enforced by the database and was already proven with 8 out of 8 tests.

**Still to be straight about:** a staff member's computer has to be able to unlock client logins, otherwise their extension can't do the booking. So logins are hidden from their *screen*, but a determined technical person could dig them out of their own browser. Pricing isolation is real; login hiding is screen-level only.

**Before testing:** run `sql/03-staff-deactivate-unassign.sql` on the test database — that's the piece that releases clients when someone is deactivated.

---

## 2026-07-20 — VPN toggle brought into the test build (Issue #51)
**What it does:** The VPN rotation switch (the one that changes your Mullvad location) existed in your **production** extension but had never been added to the **test** extension. This copies it across, so the test build now has the exact same VPN switch, plus the small helper program it talks to (`vpn_server.py`).
**Why:** Two reasons. First, testing was misleading — you couldn't try VPN rotation in the test build because it simply wasn't there. Second, and more serious: because the test copy said "no VPN here", the next time we pushed test work up to production, the computer could have decided the VPN switch was meant to be **deleted** and quietly removed it from your live extension. You'd only have noticed when the switch disappeared. This closes that hole permanently — the two copies now agree.
**What changed for you:** The test extension gets the VPN switch, working exactly as it does in production (verified line-for-line identical). Nothing about production changed — your live extension is untouched, still on the same version, with its VPN switch intact. The test build also stays a test build: it still says **SlotHunter TEST**, still logs as **[AutoBook-TEST]**, and still keeps its own set of rules.

## 2026-06-10 — Smarter error handling: 3-then-logout + change-IP on rate limit (Issue #49)
**What it does:** Two error fixes. (1) **"Unable to load"** — the bot tries returning to the dashboard up to **3 times**; if still failing after 3, it sends a Telegram alert and **logs out** (clean reset) instead of retrying forever. (2) **"Too many requests" (429 / rate limit)** — the bot **no longer logs out** (logging out doesn't help — the new login is on the same blocked IP). Instead it goes to the dashboard, **stays logged in**, and sends **"🚫 RATE LIMITED — CHANGE IP"**. You switch network/IP and restart the client.
**Why:** Logging out on a rate limit wasted the session for nothing (same IP = still blocked). And "unable to load" could keep looping. Each error now gets the right response.
**What changed for you:** Rate limit → Telegram "change IP", bot paused at dashboard (still logged in) → you change IP + restart. Repeated "unable to load" → after 3 tries it alerts + logs out.

## 2026-06-10 — Consular / interview page support (Issue #48)
**What it does:** Extends everything the bot does on the OFC (VAC) page — fast parallel scanning, fast-grab live booking, adaptive scan, alerts — to the **interview/consular** page (the second step, at the consulate) too.
**Why:** The bot was fully wired for the OFC page only. The interview page needs the same speed.
**What changed for you:** Almost all the machinery was already shared between the two pages — the one missing piece was the fast "all-at-once" scan, which was locked to the OFC request. Now it also recognises the interview page's request, so parallel scanning + fast-grab work there too. The consulate list comes from the page's own dropdown automatically.
**NOTE:** must be tested on a real interview-stage account — the interview page only opens after OFC is already booked, so it can't be verified until a client reaches that step. The change is safe for OFC (OFC behaviour unchanged).

## 2026-06-10 — Active clients pinned to top of dashboard (Issue #47)
**What it does:** Reorders the dashboard cards so the clients currently RUNNING float to the top — the one running on YOUR dashboard first, then ones running on other people's dashboards, then everyone idle (A-Z) below.
**Why:** With several dashboards each running a different client, you had to scroll to find who's active. Now the running ones are always at the top of your screen.
**What changed for you:** Open the dashboard → the top row is whoever's running (yours first). Doesn't change the active count or the Start-button rules — just the order. Works with search + filters.

## 2026-06-07 — Adaptive scan: cut off slow requests + fall back to steady mode (Issue #46)
**What it does:** Two changes to how the bot scans:
1. **12-second cutoff:** if a fast "2-cities-at-once" check takes longer than 12s (the website slow-walling it), the bot drops that request instead of waiting up to a minute.
2. **Quick probe + back-off:** when slow-walling happens, the bot does a short **2-check** one-at-a-time probe, then **immediately re-tries the fast way**. If it's still jammed, the next probe is a bit longer (**2 → 4 → 6** checks) so a long jam doesn't flip-flop; the instant the fast way works again, it snaps back to a 2-check probe. (One-at-a-time stays fast — 3-7s — even when the fast way is throttled.)
3. **Bench it after 3 strikes (#46b):** if the fast way times out **3 rounds in a row** (i.e. it's fully dead, not just slow), the bot stops re-trying it for **5 minutes** and runs purely one-at-a-time. After 5 min it tests the fast way once — works → back to normal; still dead → bench another 5 min. This stops the bot wasting 12s every round on a fast way that never succeeds.
**Why:** Live testing showed "2-at-once" scans getting throttled to 19-64 seconds (then timing out), which let slots vanish before the bot could book. One-at-a-time stayed fast throughout. So instead of stubbornly retrying the slow way every round, the bot bails to the fast-and-steady method.
**What changed for you:** When the website starts throttling, the bot no longer wastes a minute per round — it caps at 12s and switches to the steady method, so detection stays fast and slots don't slip away. It returns to the fast method automatically once throttling lifts.

## 2026-06-07 — Removed fake "human activity" (Issue #45)
**What it does:** Removed the fake mouse-moves / scrolling / tab-switching the bot did between checks.
**Why:** Those events were fake — the browser tags them "not from a real human" — so they didn't actually fool Cloudflare, but they cluttered the logs and added a few seconds of delay. The fake "tab switch" even pretended the tab was hidden, which can make the website throttle itself.
**What changed for you:** Cleaner logs (no more "Human sim..."), slightly faster checking between cities. No downside expected — the fake activity wasn't helping. Easily added back if blocks ever rise.

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
