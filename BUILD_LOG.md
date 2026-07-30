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

## 2026-07-26 — Stop losing slots to "too many requests" (Issue #58)

**Update — it now keeps fighting for the same city.** Originally, after 3 quick re-clicks of the Book button it went back to normal scanning. Now, if the site is still saying "busy", it **reloads that city's calendar, checks whether your date is still there, and if it is, goes again** — repeating until either it books, the slot genuinely disappears, or a 90-second ceiling is reached. That matches how these releases actually behave: slots often sit unclaimed for 20-30 seconds while everyone is being turned away, so the winner is whoever is still trying.

**Why there's a 90-second ceiling:** every calendar reload spends one of the client's limited daily page-views. Letting it retry forever would burn the day's allowance and get the client locked out for 24-72 hours — which would also cost you the *next* slot release. So it fights hard, briefly, then lets go.
**The bug we found:** when the site said *"too many requests processing at the same time"* at the moment of booking, the bot read that message, spotted the words **"try again"** in it, and concluded **"someone else grabbed the slot"** — then gave up and blacklisted that slot. **The slot was never taken.** The site had just said "not right now". So a good share of those *"Someone grabbed it first"* alerts you've been getting were never lost races at all.

**What changed:**
1. **The bot now understands the difference** between "someone beat you" and "the site is momentarily busy". They look similar in words but mean opposite things.
2. **When the site says busy, it now tries again** — up to 3 more times, a second or two apart. Crucially it re-clicks only the final Book button; it does **not** redo the city, calendar and time steps. That makes each retry cheap.
3. **It picks a random time slot** instead of always the first one on the day. Every bot in the world grabs the first time, so they all collide there. **The date is still the earliest available** — your client gets the same appointment day, we just stop queueing behind everyone for the same hour.
4. **Removed about 1.3 seconds of dead waiting.** The bot used to pause on a timer and hope the page was ready. Now it reacts the instant the Book button lights up.
5. **It now records what the error actually said** — including which system refused us. Three different systems can produce that same message and they need opposite responses; until now we couldn't tell them apart.

**Deliberately kept small:** the site limits how many times you may load the appointment page per day, and going over locks the client out for 24-72 hours — which would cost you the *next* slot release too. So retries are capped at 3, not an endless loop.

**Unchanged and important:** if the site goes completely silent after you click Book (no answer at all), the bot still refuses to re-submit. That silence might mean the booking actually went through, and re-clicking could double-book the client. That caution stays exactly as it was.

---

## 2026-07-26 — Sequential counts each city as a round; parallel unchanged (Issue #56)
**What changed:** In **Sequential** mode the **Round** number now goes up by **one for every city** checked. With 4 cities: Mumbai → Round 1, Delhi → Round 2, Chennai → Round 3, Hyderabad → Round 4, then round 5, 6, 7, 8 on the next lap.
**Parallel is untouched** — it still counts a round once per full pass over all your cities, exactly as it did.
**Nothing else changed:** same random 10-15s gap, same booking, same auto-submit. Only the sequential round-number meaning changed, as requested.

---

## 2026-07-25 — Random 10-15s gap between checks, set from the booking panel (Issue #56)
**What changed:** The single "Seconds between checks" box is now **two boxes — Min and Max** (default **10** and **15**). Before every check, the bot waits a **fresh random amount between them** — e.g. 11s, then 14s, then 10s.

**Applies to both modes:**
- **Sequential:** checks a city, waits a random 10-15s, checks the next city — **no page reload** — and auto-submits the moment an in-range date shows.
- **Parallel:** each batch runs, then waits a random 10-15s before the next.

**Nothing else touches the timing** — no extra pauses, no self-throttle penalty. Just the one random gap you set.

**Why random instead of a flat 15s:** a perfectly even beat looks like a machine. A random 10-15s gap is both what you asked for and the safer, more human-like pattern.

**Still off (unchanged):** the bot's own preventive brake is still disabled, so the only thing pacing it is this random gap. Its reactive protection (detecting a real "too many requests" block and backing off) is untouched. If accounts start getting blocked, widen the gap (e.g. 15-25) or we turn the brake back on.

---

## 2026-07-25 — Two sheet-sync fixes: edits now sync, and no more duplicate master sheet (Issue #57)
**Problem 1 — staff sheet ignored profile edits:** When you changed a client's dates or cities and hit **Sync Sheet**, the staff sheet didn't pick it up (only re-assigning a client did). The sync was writing from a cached copy of your clients that only refreshes every 30 seconds, so a just-made edit wasn't in it yet.
**Fix:** the sheet now pulls your latest data the instant you click, before writing — so edits show immediately.

**Problem 2 — the main "Sheets Sync" made a NEW sheet instead of updating the old one:** The link to your master sheet is remembered in the browser, and it's separate for each extension. If that link goes missing (most often because it was set up on one extension and clicked on another), the tool thinks nothing is linked and creates a fresh sheet.
**Fix (two parts):**
- **To reuse your old sheet now:** paste its URL into the "Paste Google Sheet URL" box and click Sheets Sync once — that re-links it, and future syncs update it.
- **So it can't happen again:** before ever creating a new sheet, it now **asks you** ("create new, or paste your existing URL?") instead of silently making a duplicate.
Also: the master sync now pulls your latest data before writing, same as the staff sheets.

**Booking engine untouched** — dashboard only.

---

## 2026-07-25 — Staff Google Sheet + Sync Sheet buttons (Issue #57)
**What it does:** In the Staff popup, each person now has two buttons:
- **Staff Google Sheet** — makes a Google Sheet with only that person's assigned clients and gives you the link to forward. They open it and see their IDs.
- **Sync Sheet** — after you assign or edit their clients, click this to push the latest data into that same sheet. The link never changes; the contents refresh.
**No pricing** goes into the staff sheet — that stays with you.
**Why Google (not a file):** you wanted a link you send once that stays current. A downloaded file can't update itself; a Google Sheet can. Your production Sheets Sync already works, so these use the same connection.
**Testing:** this only works where Google Sheets is connected — your production extension. The test build can't reach Google (its extension ID isn't registered), so this is tested directly in production.
**Booking engine untouched:** this is dashboard-only. It does not change anything about how the bot books, the scan speed, or the rate limits.

---

## 2026-07-22 — Per-staff backup sheet (safe to share) (Issue #57)

**Your own sheet too:** your master Sheets Sync now has an extra **"Assigned To"** column at the end, showing which staff member each client belongs to (blank = still yours). So you can filter your own sheet by person at a glance. Your sheet keeps everything it had, including pricing — it's yours. Only the separate per-staff backup sheets leave out the price.
**What it does:** In the Staff popup, each person now has an **Export backup** button. It makes a Google Sheet containing **only that person's assigned clients**, and gives you a link to send them.

**The danger it avoids — please read this:** if you had just filtered your main sheet and sent the link, it would NOT have worked the way you'd expect. A shared Google Sheet link opens the **whole** sheet — the other person can clear your filter and see everything. Your main sheet has every client's **password, security answers, and the price you charge**. Sending that link would have handed one staff member the lot. So this build makes a **separate sheet per person** instead — the only kind of link that's safe to share.

**What's in it:** their clients' username, password, security answers, dates, cities, applicants and category. **No pricing** — that never leaves your side. (You chose to include passwords so they have a full offline backup of their own clients.)

**What changed for you:** open Staff → **Export backup** next to a person → it builds their sheet and shows the link → copy it and send. Run it again later and the **same** link just refreshes with the latest data, so you can share one link once. Someone with no clients yet → it tells you, instead of making an empty sheet.

**Still treat the link as sensitive** — it does contain their clients' logins. Only send it to that staff member.

---

## 2026-07-22 — Fix: it was still checking every 10 seconds sometimes (Issue #56 follow-up)
**What was wrong:** Even after setting 15 seconds, the bot sometimes checked every 10 seconds instead.
**Why:** There's a "grace period" — when the bot spots a slot but can't grab it in time, it hammers that one location for 5 quick rounds, hoping someone cancels again. That burst used a **hardcoded 10 seconds** and ignored whatever you'd set in the panel. It only kicks in after a near-miss, which is why it looked random.
**The fix:** the grace period now uses your configured interval like everything else. Whatever number is in the box is the gap before every check, with no exceptions anywhere in the bot.
**Also fixed:** a few leftover spots still assumed the old 30-second default. After the bot refreshed the page to keep the session alive, those could quietly reset your setting. They're all on 15 now.
**Throttle switched off:** the bot's own self-imposed brake is now **disabled** so we can see the true speed. Protection against the website's actual rate-limit responses (the 429 errors) is completely untouched — that still detects and backs off as before. If we see 429s, one line switches the brake back on.
**Trade-off worth knowing:** the grace-period burst is now 15 seconds instead of 10, so it's slightly slower at chasing a slot you just missed. If you'd rather keep that one burst fast, say so and I'll make it the exception.

---

## 2026-07-22 — Steady 15-second checking, and a clearer round count (Issue #56)
**What it does:** The bot now checks on an even beat — one check every **15 seconds**, over and over, in both Sequential and Parallel. No more long pause at the end of a lap.

**Why the old way felt lumpy:** it used a *random* 4-to-25 second gap between cities, and then an **extra 24-36 second pause** once it had been through them all. So the wait you got was never the same twice.

**The 30-second gap mystery — solved.** The bot has a built-in brake that slows it down if it thinks it's asking the website too often. That brake was set to trip at 4 checks per minute, and adds a flat 15 seconds when it does. A check every 15 seconds *is* exactly 4 per minute — so the brake fired on literally every check and turned your 15 seconds into 30. **The bot was slowing itself down.** The brake is now set at 10 per minute, so normal running no longer trips it.

**Rounds now mean what you'd expect:** one round = the bot has checked **every** city you selected, once. Before, Parallel counted a round for every 2 cities, so with 4 cities you'd see the round number climb twice as fast as it should. Sequential was already correct. With 4 cities: Sequential finishes a round every 60 seconds, Parallel every 30.

**What changed for you:** the "Cycle Interval" box is now **"Seconds between checks"** and starts at **15**. Whatever you put there is the gap before every single check — nothing else is added on top. You can still change it live per client.

**One honest note on risk:** this does mean the bot asks the website a bit more often than before in Parallel (about 8 times a minute instead of 5-6). That's still far below what the site actually allows, and the existing protection against rate-limit errors is untouched — if the site starts pushing back, we lower the number. Sequential is unchanged in practice; it just spends its time checking instead of pausing.

---

## 2026-07-22 — Choose Sequential or Parallel scanning from the booking panel (Issue #55)
**What it does:** Adds a **Scan mode** choice to the booking panel, right under the VPN Rotation row: **Parallel** or **Sequential**.
- **Parallel** (the default) is exactly what the bot does today — checks 2 cities at once, and if the website starts stalling it automatically slows to one-at-a-time, then speeds back up on its own.
- **Sequential** switches that off completely. It checks one city at a time, every time, moving through your selected cities by changing the city dropdown on the page — no page reload between cities.

**Why:** The bot already decides this for itself, and it recovers well. But it only gives up on the fast mode after it has failed 3 rounds in a row, then waits 5 minutes before trying again. When you can already see the website is being difficult, you shouldn't have to wait for it to work that out — now you can just pin it to Sequential.

**What changed for you:** Nothing unless you touch it. It starts on Parallel, which is today's behaviour. You can switch **while the bot is running** — it takes effect from the next round, no stopping or restarting.

**Two details worth knowing:**
1. In Sequential mode it checks **every** city you've selected, each round. (Normally the bot deliberately checks just the first city on the very first round as a shortcut to get into fast mode quicker — that shortcut is skipped when you've asked for Sequential, otherwise it would only ever check one city.)
2. Your choice is remembered on that computer, and it survives the automatic page refresh the bot does every few minutes to keep the session alive. Without that, a Sequential choice would have quietly flipped back to Parallel after a refresh.

**Note:** this is a per-computer setting, not per-client. It isn't stored in the database, so nothing changed there and staff can set it themselves.

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
