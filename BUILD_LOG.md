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

## 2026-08-16 — Fix: console errors on Cloudflare "verify you are human" pages (Issue #65)
**What you saw:** a stream of red "Content Security Policy" errors in the console whenever the bot landed on a Cloudflare verification page.

**Why:** the bot installs a small watcher on each page to spot session errors. Cloudflare's verification pages have very strict security rules that forbid adding anything to the page — so every attempt was rejected and logged an error. The watcher wasn't needed there anyway: on a verification page the website isn't doing any work to watch.

**Fixed:** the bot now recognises a Cloudflare verification page and skips the watcher entirely, installing it on the next real page instead. No error, no lost function.

**Other messages in that same report are not faults and need no action:**
- **"Cannot read properties of null (outerText)"** — comes from the older bundled extension code, which expects page elements that don't exist on a verification page.
- **"Supabase Failed to fetch"** — Cloudflare's verification page blocks outside connections, so cloud updates can't send from there. They're queued and sent on the next normal page.
- **"Running the JavaScript URL violates..."** — links on the site that run scripts; already handled for the bot's own clicks.

All three are just symptoms of sitting on a verification page.

---

## 2026-08-16 — Removed the settings panel from the login page (Issue #64)
**What changed:** the big blue "Auto-Booking Settings" box that covered the left side of the login page is gone.

**Why it's safe:** that panel only ever appeared when you opened the login page *without* starting a client. The moment you press **Start Now** on the dashboard, the bot fills the login form and signs in on its own — it never used that panel. It was left over from before the dashboard existed.

**Why it was worth removing:** besides taking up a third of the screen, it displayed your **operator key, master password box, the client's password and their security answers in plain text** on a page sitting open on staff machines. Anyone walking past could read them.

**What happens now instead:**
- Open the login page with no client running → nothing appears, and you can use the site normally by hand.
- A client is started but has no saved password → you get a Telegram message saying to add it on the dashboard, rather than a panel appearing.

**Nothing else changes:** Start Now → login → security questions → dashboard → booking works exactly as before.

---

## 2026-08-16 — URGENT: dates went blank after an IP change, arming the bot to book any date (Issue #62)
**What could have gone wrong:** after the VPN changed IP, the booking panel came back with **Start Date and End Date empty** — while the bot kept running. An empty date range means the bot treats **every** date as one you want. So the next slot to appear, at any date in any year, would have been booked and submitted for that client. With only one free reschedule allowed, that is expensive to undo.

**Why it happened:** changing IP breaks the website session, so the bot re-logs in. The re-login step was saving a blank placeholder — no dates, no cities — and after logging back in it wrote those blanks straight over the panel. The bot then carried on with no range at all.

**Three fixes:**
1. **The re-login step now takes the dates and cities from that client's own profile**, instead of saving blanks.
2. **Restoring can no longer wipe good values.** A blank saved value is ignored rather than written over a date that was already filled in.
3. **A hard safety stop:** if there is no date range for any reason, the bot **refuses to book**. It sends "BOOKING BLOCKED — NO DATE RANGE", stops that client, and waits for you. Looking for slots still works — only automatic booking is blocked.

Fix 3 is the one that matters most: it makes this kind of failure safe no matter what causes it in future.

**What you should check:** open the dashboard and make sure every client actually has a start and end date saved. Any client without one will now be stopped safely rather than booked wrongly — but it is better to have the dates in place.
---

## 2026-08-15 — Fix: dates stopped loading after a Cloudflare check (VPN changes) (Issue #61)
**What was wrong:** When the VPN switched IP, Cloudflare would show the "verify you are human" box. You'd solve it, the bot would say it resumed — but **the dates never loaded again**. The only way out was to log out and start the client over. This kept happening around VPN rotations.

**Why:** After Cloudflare interrupts a page, the page's own scripts are left half-alive — the city dropdown and the calendar never rebuild themselves. The bot had two different ways of dealing with a Cloudflare check, and only one of them was right:
- During its **fast scanning**, it saved its place, reloaded the page, and carried on properly.
- During its **one-city-at-a-time scanning**, it just waited, then carried on **without reloading** — talking to a page that was effectively dead. Hence blank dates.

**The fix:** both now do the same thing — save the settings (dates, gap, cities), reload the page so you can solve the Cloudflare box, and once solved the bot picks up automatically where it left off. No manual logout.

**Why VPN changes triggered it so often:** the "you're verified" pass Cloudflare gives you is tied to your IP address. Every time the VPN moves you to a new IP, that pass stops counting and Cloudflare can ask again — right in the middle of a scan.

**If it still happens:** the next step would be for the bot to notice the IP changed and do the clean reload *before* Cloudflare interrupts it, rather than reacting afterwards. Only worth building if this doesn't settle it.

---

## 2026-08-15 — Fix: bot logged itself out on the Privacy Act / terms page (Issue #60)
**What was wrong:** After Start Now, the bot logged in, answered the security questions, reached the Privacy Act consent page — and immediately **logged the client straight back out**.

**Why:** That page's browser-tab title is **"Access Denied"**. It's a quirk of the site's software — you count as "not authorised" until you tick the boxes, so it reuses the access-denied page title. Our bot had a rule saying *"if the page title says access denied, Cloudflare has blocked us"* — so it panicked and logged out. **Nothing was actually blocked.** It was a normal page in the login flow, misread.

**What it does now:**
1. **Recognises the page properly** — by its web address first, and as a backup by what's on it (the acknowledgement boxes plus a Continue button).
2. **Ticks both boxes and clicks Continue**, then carries on with the normal booking work.
3. **Stopped panicking about the title.** "Access denied" in a page title is no longer treated as a block on its own — there now has to be a genuine Cloudflare fingerprint on the page too.
4. **If it can't complete it** (Continue stays greyed out, or the button isn't found), it does **not** force anything — it sends you a Telegram message asking someone to tick it manually on that machine.

**What the page actually says, for the record:** it's the US government's **Privacy Act Statement** and **Confidentiality Statement** — how the applicant's personal information is handled and shared. It's a data-privacy notice, not the site's rules-of-use document.

**Kept safe:** the bot only touches checkboxes on a page it has already confirmed is this consent page, only clicks a button labelled Continue/Accept/Agree, and never forces a disabled button.

---

## 2026-08-11 — Dashboard redesign (Issue #59)

**What it does:** Rebuilds the dashboard — header, numbers row, a new alert strip, the client cards and the activity log — and fixes the two-second flicker underneath all of it.

**The alert strip ("NEEDS YOU"):** Anyone with a slot found, or anyone blocked by a rate limit, now floats to the top of the page in its own strip, above the client grid. Before, a found slot was one card among forty-seven and you had to hunt for it. Each entry has a **Show** button that jumps to that client's card and flashes it. The strip disappears entirely when nothing needs you.

**The browser tab tells you now:** When a slot is found while you're on another tab, the tab title becomes **"(1) Slot found — SlotHunter"**. Return to the tab and it goes back to normal. This is the big one — the dashboard sits in a background tab for hours, and until now nothing reached you there unless Telegram was set up.

**A pop-up when a slot lands:** A small card slides up bottom-right when a client goes to "slot found", with a Show button. Flick it sideways to dismiss. Its timer **pauses while the tab is hidden** — so a slot found at 2pm while you were elsewhere is still waiting at 2:30 instead of having quietly expired.

**Search everything with Cmd-K (Ctrl-K on Windows):** Press it anywhere and a search box opens. Type a client name to jump to them, or type a command — Add client, Export CSV, Open Cloud Sync. It opens instantly with no animation on purpose: you use it constantly, and animation there just reads as lag.

**Clearing the log now needs a press-and-hold.** This was a real hazard — the **Clear** button under the activity log wiped every event on a single click and asked nothing. It is now **Hold to clear**: hold about a second while a red fill sweeps across. Let go early and nothing happens.

**The header got quieter.** Eight buttons in eight colours, all shouting equally. Cloud, Telegram and Sheets are now one group with a small dot each — green connected, grey not — so connection state is visible without clicking. Export, Export CSV, Import and the sheet link moved into a "..." menu. Logs and Staff stayed out in the open because you use them often.

**The numbers row got a lead.** "Cycling now" is large with the client total beside it; slots found, confirmed, errors and CAPTCHA rate sit in a smaller row alongside. Digits use a fixed-width font so numbers stop twitching sideways every two seconds as they update.

**Why:** The dashboard was built for a handful of clients and is now watched for hours with dozens. Nothing on screen said "this is what needs you", and nothing reached you at all when the tab was in the background.

**What changed for you:** Every client card shows exactly the same information and the same buttons as before — nothing was removed. Your data, logins, cloud sync, staff view and the booking engine are untouched. If any of this misbehaves there is a single switch that turns the whole new layer off and restores the old behaviour, including the one-click Clear.

**The client cards were rebuilt too.** Every label now lines up in a column, so you can read down forty cards without your eye hunting. The emoji are gone — 🎯 ✅ ⚪ 🎉 📜 🔁 ⚠️ 🔴 📍 all replaced with plain text or a drawn icon, because emoji render differently on every machine. **Edit** and **History** now stay hidden until you hover a card, so a screen of forty clients isn't a wall of buttons. Each card has a coloured stripe down its left edge — teal cycling, amber slot found, green confirmed, red blocked — readable from across the room without reading a word.

**The activity log became a timeline** with a coloured dot per line joined by a thread, so errors and found slots stand out while routine chatter recedes.

**The two-second flicker is fixed.** The whole client grid used to be thrown away and rebuilt every two seconds. That is why hovering a card sometimes felt like it slipped, why text you highlighted vanished, and why an open "Assigned to" dropdown had to be protected with a special rule that froze the entire screen while it was open. Now each card is compared against what is already on screen and only the ones that actually changed are redrawn. **Measured: 38 of 39 cards now survive untouched across three refreshes — only the one client actually cycling gets redrawn.** The dropdown fix is better too: instead of freezing the whole dashboard while it is open, only that one card is left alone and everything else keeps updating.

**A bug found and fixed during your testing:** at normal zoom every card was cut down to just the name row — no dates, no Start button. Cause: the new left stripe needed the card to clip its own edges, and in a CSS grid an element that clips itself is allowed to shrink to nothing when space runs short. With six test clients there was room to spare so it never appeared; with your thirty-nine there wasn't. Fixed by rounding the stripe instead of clipping the card, and by pinning row heights to their content.

**Five new things on top of the redesign.**

**A consulate strip.** Five tiles under the numbers — Mumbai, New Delhi, Chennai, Kolkata, Hyderabad — each showing how many in-range slots that city has released today, how many were seen in total, and how long ago the last one appeared. A city glows amber when it has produced something in range today and greys out when it has gone quiet. Click one and the client list filters to everyone hunting that city. It tells you where to point people before you start them.

**A release heatmap** (Stats tab). Every slot the extension has ever recorded carries a timestamp. Those get bucketed by consulate and by hour of the day, IST, and drawn as a grid — dark where nothing happens, bright amber where slots land. Underneath it works out the densest three-hour window across all consulates and says so in a sentence. On the test data that reads "07:00–10:00 IST". That is the answer to "when should I have clients running", and just as importantly when it is worth spending one of a client's limited daily page-views. Nothing else you have shows this, and it needed no new data collection — the timestamps were already there.

**Pipeline value** (Stats tab, owner only). You store an agreed price and an applicant count against every client, and who each is assigned to. That is now added up: confirmed this month, in flight, and blocked-or-at-risk, plus a per-staff board of who has confirmed what. Hidden entirely in staff view, same rule as the price on the card.

**Client health rings** (Stats tab). Your dashboard was showing clients at 93 errors in 464 rounds and 88 in 460 — about one request in five failing — in plain grey text that nothing drew your eye to. Each client now gets a ring that fills green, amber or red by error rate, worst first. A client degrading toward a rate-limit becomes obvious before it gets blocked. Clients with under ten rounds are left out, since there is not enough there to judge.

**Wall mode.** A **Wall** button in the header, Esc to leave. Fills the screen with four big numbers — cycling, slots today, confirmed, blocked — the consulate line, and the last six events, for leaving on a second monitor. It reads; it never starts or stops anything.

**Cards got shorter, not taller.** The first cut of the redesign put one label per row and boxed both the slot summary and the round counters, which made every card about 420px tall — worse than before. Now dates and visa sit side by side, two pairs to a row, and the two boxes are quiet single lines. Cards came down to roughly 290px, so you see about twice as many clients per screen.

**A bug this caught:** the Slot History tab shared its row layout with the activity log, and the log had gained a colour dot column. Slot History was still emitting the old four columns, so every row would have shifted one place to the left. Fixed by giving it the same five, with in-range now shown by the dot and a small "in range" tag instead of a tick emoji.

**Two off switches, not one:** one turns off the new alert strip, pop-ups, palette and hold-to-clear; the other returns to the old rebuild-everything-every-two-seconds behaviour. Either can be flipped on its own.

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
