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

## 2026-11-28 — Tidy the Automation checkboxes in the Edit box

**What it does:** The four Automation checkboxes — Auto-Login, Auto-Dashboard, Auto-Select, Auto-Submit — now sit in a neat two-by-two block, each tick next to its own label.

**Why:** They were stacked one per line, with the tick box stranded on the left and its label pushed to the far right, wrapping mid-word as "Auto-" then "Login". Two styling rules were fighting: the one meant for a normal form row came later in the stylesheet and overruled the one meant for a row of tick boxes, stacking them vertically and stretching each tick box to the full width of the box.

**What changed for you:** Only the appearance of those four. Nothing about what they do.

---

## 2026-11-28 — Check faster at minutes you choose (Issue #95)

**What it does:** A new **Release windows** section in the dashboard's `⋯` menu. Pick up to four minutes past the hour, say how long each should last, and the bot checks faster during those minutes — normal pace the rest of the time.

```
☐ Check faster at set minutes
   at min [26] for [2] min
   at min [56] for [2] min
   at min [  ] for [ ] min        ← blank = unused
   at min [  ] for [ ] min
   every [6]–[10] sec inside
```

**Why those numbers appear as examples:** the rival extension on this same website ships exactly 26 and 56 as its defaults, with a 2-minute window and an 8-second interval. That is their guess about when slots are released, and they believe it enough to ship it. **Nothing is fixed in our code** — they are grey placeholder text only. Set whatever minutes you want, or none.

**What changed for you:**
- **Off until you turn it on**, and turning it on asks once, plainly: this sends more requests at the busiest minute, and the website may answer with rate limits or Cloudflare checks. Turning it off never asks and puts everything back exactly as it was.
- **Slot searching only.** The login check is deliberately left alone — running a login sweep in the same minute would compete with the searching it is meant to help.
- **One setting for everything.** A slot appearing at :26 appears at :26 for every client, so this is set once and applies everywhere, rather than fifty times.
- **It still varies.** Inside a window the gap is a random 6–10 seconds, not a metronome tick at exactly 8. A perfectly regular beat is the thing most likely to be noticed.

**The part that matters most:** it counts. Every check is recorded as inside or outside a window, and the menu shows the comparison:

```
in windows: 3 finds / 48 checks (6.25%)
outside:    11 finds / 2104 checks (0.52%)
```

After a few weeks that tells you whether :26 is real **for your consulates** — or that the real minute is different, or that it is noise. Without it you would be inheriting someone else's guess and never finding out.

**What it costs:** a 2-minute window at about 8 seconds makes roughly 15 checks where the normal pace makes 10. Two windows is about 11 extra checks an hour per running client. Modest — but it is more traffic at the busiest minute, and your logs already show the website saying *"The system is processing too many requests."* If that gets worse after turning this on, that is the cause.

**Tested:** 17 checks on the timing (windows hit on the right minutes, every hour, and a window set to run past the hour — ":58 for 5 minutes" correctly covers :58 to :02), and 6 on the pace itself, including 2,000 gaps with the feature off to prove it is byte-for-byte the old 10–15 seconds, 2,000 with it on to prove the faster range still varies rather than ticking, and that "enabled but no windows set" behaves as off. All 23 passing. Not yet run against the live site.

---

## 2026-11-25 — Say which dates a client cannot take, and how much notice they need (Issue #94)

**What it does:** A collapsible **Date rules** section in the booking panel — the panel that appears on the visa site once a client is logged in, next to the date range and locations.

**Excluded dates** — days this client cannot take, even if a slot appears. Type them the way you would say them: `15 Jan 27, 20-25 Feb 27`. Strict form works too: `2027-01-15`. Underneath the box it tells you what it understood — *"7 day(s) excluded: 15 Jan 27, 20 Feb 27, …"* — before you save. If it cannot read something it says so and names the bit it could not read, so nothing is ever thrown away quietly.

**Minimum notice** — the soonest the client could actually attend, in days. Put 10 and a slot three days away is ignored. Underneath it shows the real date that works out to, so there is no counting on your fingers.

Leave either blank and nothing changes for that client.

**Why:** A client's window was only a start and an end date. If they were abroad for a fortnight in the middle, or needed two weeks to arrange travel, the bot would happily grab a slot they could not attend — and you had to watch for it and undo it by hand, which rather defeats the point.

**What changed for you:**
- Dates the client cannot take are **still shown** in the slot alerts, marked 🚫, rather than disappearing. So "was there anything on the 18th?" has an answer, instead of looking like the bot missed it.
- The same rules apply everywhere — the scan, the grab, the counts, the alerts. A date that cannot be taken is never shown as available and then refused.
- Minimum notice counts from today and moves with it: a date that is eleven days away today stops qualifying in two days' time. That is correct, but it does mean a date can quietly drop out.

**Where you set them — two places, one value:**
- **The booking panel**, after a client logs in: expand **Date rules** beside the date range.
- **The Edit box** on their client card, under the dates.

Whichever you use, it is the same saved setting — change it in one and the other shows it. What you enter is saved to that client, so it is still there next run and on your other machines.

**One step for you:** needs a small change in Supabase first — two new optional fields. The file is `sql/06-date-rules.sql`. Run it once. Until you do, everything works exactly as before and the two boxes simply have nothing to save into.

**When the rules leave nothing to book, it now says so.** Minimum notice counts from today and moves with it, so a window closes from both ends. With a window of 1–31 December and one week's notice, on 24 December only the 31st is still reachable, and from the 25th nothing is. Before this the bot would have carried on hunting that client for ever, finding slots and refusing every one, with nothing on screen explaining why.

Two places now catch it:
- **On the client's card:** *"No bookable dates left — 7 days' notice means nothing before 1 Dec, but the window ends 30 Nov."*
- **While you type it:** the line under the notice box turns amber and says the same thing, so you see it when registering the client rather than three weeks later. It re-checks when you change either date too.

**Tested:** 15 checks on the date reader (friendly and strict forms, ranges, rubbish, and impossible dates like 31 February, which must be rejected rather than rolled into March), 15 on the booking rule itself (no rules, excluded only, notice only, both together, and nonsense stored in the fields, which must never widen the window). and 9 on the no-bookable-dates check (open-ended windows, notice landing exactly on the end date, overrunning it by one day, a window already past, and every remaining day excluded). All 39 passing. Not yet run against the live site.

---

## 2026-11-24 — Client card reordered, and the state dropdown matches the buttons (Issue #93)

**What it does:** Two things on each client card.

1. **The order now reads the way you read a client:** dates first, then the consulates we are hunting, then visa and applicants, then price and advance. The consulate tags used to sit right at the bottom of the card, below everything.
2. **The Normal / Booked / Not needed dropdown now looks like the buttons next to it.**

**Why:** The consulate list is what tells you where we are searching, and it was the last thing on the card, under the slot history. It belongs beside the dates.

The dropdown was inheriting the generic form-field style instead of the button style, so beside Edit, History and Check login it sat taller, in a darker shade, with a different arrow. It read as a stray form control rather than part of the row.

**What changed for you:**

```
DATES      01 Jan 27 — 31 Mar 27
[ Mumbai ] [ New Delhi ] [ Chennai ] [ Kolkata ] [ Hyderabad ]
VISA  H1B              APPL  1
PRICE ₹25,000          PAID  ₹10,000 · ₹15,000 due
CAPTCHA auto
```

Everything after that — slot history, round counters, warnings, buttons — is exactly where it was.

**Also fixed, after you spotted them on a real card:**
- **Full dates now show.** The first attempt did not work: the row that holds a label and its value is built in a way that makes it invisible to the layout, so the instruction to "use the whole width" was being given to something that is not there. It now goes on the value itself, and `15 Jun 26 — 30 Sep 26` shows in full instead of `15 Jun 26 — …`.
- **The dropdown no longer runs off the card.** The four buttons were locked to one unbreakable line; on a narrow card the last one hung over the edge. They now wrap onto a second line when there is no room.
- **CAPTCHA is replaced by ADVANCE.** The CAPTCHA setting is chosen once and never looked at again; what a client still owes is looked at constantly. The line reads `₹10,000 · ₹15,000 due` when something is paid, and `— · ₹19,000 due` when nothing is.

**Tested:** Rendered real cards against the actual stylesheet and measured them. Dropdown matches the buttons exactly (27px height, same background, border, text size, weight, radius) and stays inside the card at 460, 400, 340 and 300 pixels wide, wrapping to two rows at the narrowest. Dates no longer truncate at any of those widths. Confirmed working on the live dashboard.

---

## 2026-11-24 — Dashboard now fits phones and tablets properly (Issue #92)

**What it does:** Two lines. The dashboard now lays itself out correctly on any screen size, and the Active / Booked / Expired / Not needed / All strip wraps onto a second row instead of being cut off.

**Why:** The page was missing one standard line that tells a phone or tablet "this page knows how to fit you". Without it, every phone assumed the dashboard was a 980-pixel-wide desktop page and shrank the whole thing to fit — which is why nothing lined up.

Worse, the stylesheet already had seventeen rules for smaller screens, written long ago. **None of them had ever run on a real phone**, because the browser was being told the screen was 980 pixels wide no matter what it actually was. The responsive design was there the whole time and had never once been used.

The tab strip was a separate, smaller fault: it scrolled sideways rather than wrapping, so once the tabs were wider than the space available you got a squeezed strip with a scrollbar and could not see the later options at all. Adding the fifth tab ("Not needed") last week made that start happening at ordinary window sizes.

**What changed for you:**
- On a phone or tablet the dashboard now fits the screen, with the stat cards stacking and the buttons wrapping instead of running off the edge.
- All five tabs are always visible. On a narrow screen they use two rows.
- **Desktop is unchanged.** The tab strip still hugs its buttons on one row, and nothing else moves.

**Measured before and after**, in an emulated phone screen of 375 pixels: the page used to be 980 pixels wide (so it overflowed); it is now exactly 375 with nothing hanging off the edge, and all five tabs reachable. Checked again at tablet (768) and desktop (1440) — no overflow at any of them.

**Tested:** Checked at 375, 768 and 1440 pixels against the real files, then confirmed working on the live dashboard.

---

## 2026-11-24 — Advance payments now show up in the money figures (Issue #91)

**What it does:** Money a client has paid you before their appointment is booked now counts, and shows on their card.

- **COLLECTED** is every rupee you have actually received, booked or not. The line underneath splits it: `₹60,000 from 3 booked · ₹1,25,000 advance from 7 hunting`.
- **The client card** gains a **PAID** line — `₹10,000 · ₹15,000 due` — shown only when something has been paid.
- **OUTSTANDING** counts everyone who still owes you, not only booked clients.

**Why:** You could type an advance into a client's Edit box, and it was saved and shared correctly — but the dashboard only ever added up money from *booked* clients. So an advance was recorded and then shown nowhere. With 46 clients hunting, deposits you had genuinely collected read as ₹0, and the only way to see one was to open that client's Edit box and look. There was no way to answer "how much have I actually taken" from this screen.

**What changed for you:**
- One number for cash in hand, with the source named underneath, so booked money and advance money stay tellable apart.
- A client who has paid part says so on their own card, in orange when money is still due and green when they are square.
- Clients marked **Expired** or **Not needed** are left out of both the advance and the owed figures — they are not being worked, so their balances are not live money.
- The progress bar now measures against every live client's fee, not just the booked ones, so it can no longer read over 100%.

**Tested:** Confirmed working on the live dashboard.

---

## 2026-11-24 — Mark a client Booked or Not needed, and stop checking their login (Issue #90)

**What it does:** Every client card now has a small dropdown: **Normal / Booked / Not needed.**

- **Booked** — moves them into the Booked tab.
- **Not needed** — moves them into a new **Not needed** tab, next to Active, Booked, Expired and All.
- **Both are skipped by "Check all logins".**

Set it back to Normal at any time and the client returns to the Active list.

**Why:** "Booked" was worked out by the bot on its own, from what it had booked. There was no way for you to say so. A client who booked elsewhere, or who no longer wants the service, stayed in the Active list for ever — and every single "Check all logins" run signed in as them, spending one of that client's limited daily page views on an account nobody is working any more. With 57 clients and only a handful actually finished, that adds up every run.

**What changed for you:**
- The dropdown sits on each card beside Edit, History and Check login.
- The tab counts match what each tab actually shows — a client marked Booked leaves Active and the numbers move with them.
- **If you mark a client who is running right now,** it asks first: "X is running right now. Stop that session and mark them Booked?" Say yes and it stops them, then marks them. Say no and nothing changes.
- The mark is shared with your other computers, so every dashboard agrees about who is still being worked.
- Marking someone **Booked by hand does not change anything the bot worked out by itself** — it sits on top. A client the bot already knows is booked stays booked either way.

**One step for you:** this needs a small change in Supabase before the sharing works — one new optional field. The file is `sql/05-service-state.sql`. Run it once. Until you do, the marks still work but stay on the machine you set them on.

**Built straight into production** at your request, because the test folder currently holds another session's unfinished work across the same files. That means **this one has not been through a test build first** — it is dashboard and status work only, nothing near booking, cycling or the Cloudflare handling.

**Tested:** Confirmed working on the live dashboard.

---

## 2026-10-27 — Show what the website actually said when it refuses a booking (Issue #86)

**What it does:** When a booking is refused, the log now prints the website's own words, not just our one-word summary.

Before: `portal verdict: rejected`
Now: `portal verdict: rejected — portal said: "..."`

**Why:** The bot already reads that message — it uses the wording to decide whether the website was simply too busy (so the booking never happened and the date is still worth trying) or whether we genuinely lost the slot to someone else. Those two need opposite responses. But the message was never shown, so there was no way to check that decision was right, and no way to learn the wording of a refusal we had not seen before. On 27 Oct a Chennai slot with 10 free seats was refused twice and we could only report our own interpretation of why.

**What changed for you:** One extra piece of text in the console when a booking is refused. Nothing else — no change to how it books, no extra requests to the website.

**Tested:** Not yet — shows up the next time a booking is refused.

---

## 2026-10-25 — Login check results now show on every computer (Issue #85)

**What it does:** When any machine runs a login check, the result now appears on every dashboard — every Chrome profile, every computer. Before, only the machine that ran the check could see it.

**Why:** The result was being saved in a box that belongs to one Chrome profile on one computer. Nothing ever sent it to the shared cloud, so no other profile could see it — not a delay, it simply was never connected. Whoever was actually handling a client had no way to know whether their login still worked unless they happened to be sitting at the right machine. The client's "status" already travels this way, which is why that one stays in step and this one did not.

**What changed for you:**
- Run a check on one computer, and the result shows on all of them, with the same wording and the same "checked X ago".
- If two computers check the same client, the newer result wins. Neither can overwrite a fresher answer with a stale one.
- A computer with no internet still works exactly as now — it saves locally first, and shares when it can. Nothing waits on the network.
- Nothing about booking, cycling or slot hunting was touched.

**One step for you:** this needs a small change applied to the database before it works — three new optional fields. The file is `sql/04-login-health.sql`. Run it once in Supabase. Until it is run, everything keeps working exactly as it does today; the sharing just stays off.

**Tested:** Not yet — waiting on your test.

---

## 2026-10-25 — Bad security answers no longer freeze the login check (Issue #84)

**What it does:** Three fixes to what happens when a client's saved security answers are wrong or missing.

1. **It stops freezing.** The check now marks that client and moves to the next one straight away, instead of sitting there for four minutes doing nothing.
2. **It tries twice.** If the site says the answers are wrong, it answers once more before giving up. One bad submit no longer writes a client off.
3. **It tells you which question.** The card now names the actual question, so you know exactly what to fix.

**Why:** The freeze had one real cause, found from a live log after a first attempt missed it.

After you type the password, the website **swaps the security questions into the same page** — it does not load a fresh page. Our bot only decides what to do when a page loads. So on that swap nobody was put in charge. The part watching the login saw the questions appear and stepped aside, assuming the next page load would take over. There was no next page load. A separate background check noticed the answer boxes, filled in what it could, sent you the "security questions failed" alert, and stopped — but that part knows nothing about the login check, so it never reported the result. With nobody reporting, the queue kept waiting on that client until a four-minute safety timer gave up.

Two smaller things came out of the same look: there was never actually a retry (it gave up the instant the site complained), and the question wording was read and then thrown away, so you were told "only 1 of 2 questions had a saved answer" without ever being told which one.

**Correction:** the first attempt at this fixed a genuine but different fault — the bot thought a failed client was signed in and hunted for a "sign out" link that was not there. That fix is kept, but it was not what froze the queue, which is why nothing changed when you tested it.

**What changed for you:**
- A client with bad answers is marked and skipped in seconds, not four minutes. A sweep with several such clients finishes much sooner.
- Their card now reads something like **Security answers wrong — missing: "What was the name of your first pet?"** so you can fix that profile directly.
- If the answers are simply wrong, it has a second go before marking them. If we hold no answer for the questions asked, it gives up immediately — retrying a blank is pointless.
- Everything else is untouched: healthy, password changed, CAPTCHA failed, blocked and no-answer all behave exactly as before. Booking, cycling and slot hunting were not touched at all.

**Tested:** Not yet — waiting on your test.

---

---

## 2026-10-20 — Carry on a stopped login check instead of starting over (Issue #83)

**What it does:** Adds a green **"Continue checking (N left)"** button to the orange "Login check stopped" box. Press it and the check picks up at the exact client it stopped on. The button only appears when there are actually clients left to check, and it tells you how many.

**Why:** When the login check gets blocked four times in a row it stops and asks you to change your IP. Until now the box only had a **Dismiss** button. So the only way forward was to dismiss it and press "Check all logins" again — which started from the very top and re-checked every client that had already passed. On the run that prompted this, 11 clients had already signed in fine. Restarting would have signed all 11 in a second time for no reason, and each sign-in spends one of that client's limited daily page-views on the visa site. The list of who still needs checking was already saved — nothing was using it.

**What changed for you:**
- The orange stopped box now has two buttons: **Continue checking (N left)** and **Dismiss**.
- Before it carries on, it asks you to confirm, and reminds you to change your IP first. On the same IP it will simply hit the same block and stop again — so this is a nudge, not a formality.
- Clients already checked are never checked again. Their results stay.
- If some client is mid-session, it refuses and tells you to stop that client first — same safety check the normal "Check all logins" button already has.
- Nothing about booking, cycling or slot hunting was touched. This is dashboard-only.

**Tested:** Confirmed working on the live dashboard — the button appeared on the already-stopped run and carried on from where it left off.

---

## 2026-10-16 — Booking rebuilt around what the website actually does (Issues #80-#90)

**What it does:** A week of work on the moment a slot is found. Four parts.

**1. It books through the website's own commands.** The bot used to click its way through: pick the city, wait for the calendar to draw, click the date, wait for the time buttons to appear, click one, press Submit. Most of that was the bot sitting still waiting for pictures to appear so it had something to click. It now asks the website directly, which cuts those waits out entirely. Picking a date and time went from several seconds to **about 2-3 seconds**. If the quick route is ever unavailable the bot silently falls back to the old clicking method, so nothing can be lost.

**2. It reads the real answer instead of guessing.** Before, it watched the screen for 15 seconds and read the words to decide whether a booking worked. That is how **"too many requests... please try again"** got read as **"someone took the slot"** — because it contains "try again". The website states the outcome plainly in its reply, and the bot now reads that. Telegram quotes the website's exact words when a booking is refused.

**3. It knows the difference between losing and being told to wait.** This was the big discovery. When the website says it is too busy, the booking **never happened** — nobody got it. The bot used to treat that as a lost race, give up on the date, and eventually rest it for five minutes while seats sat unbooked. It now recognises a busy signal, steps back to normal scanning, and does **not** count it against that date.

**4. It stops making things worse.** We measured this directly. Retrying straight after a busy signal made the website progressively slower for us — page reads went from 2 seconds, to 100, to 200. Backing off instead returned everything to normal within minutes. The bot no longer retries into a busy website.

**Also:** it now prefers the time slot with the most places free, shows those numbers on the overview panel, and waits as long as the website asks when the website says how long.

**Why:** Slots are won in seconds. But we discovered the bot was often not losing races at all — it was mishandling a busy website and then punishing itself for it.

**What changed for you:** Reload the extension on every machine. Telegram messages are more accurate: a refusal now quotes the website, and a busy website says "PORTAL BUSY - nobody could book it either" instead of implying the slot was lost.

**Being straight with you:** this has **not yet completed a real booking**. Everything up to the final step is proven on live slots; every attempt during testing was refused by a website too busy to process anyone's booking. The old clicking method remains in place as a fallback at every stage. Watch the first real booking closely.

## 2026-09-22 — Ready for the Chrome Web Store, and the last of the competitor's code is gone (Issue #78)

**What it does:** Three things, so the extension can be published to the Chrome Web Store and installed by your team from a link.

**The competitor's leftover code is removed.** When we deleted their tracking file back in #69, half of it survived in the background script. That half could send a client's **appointment details, personal details and screenshots of the page** to CheckVisaSlots' own server, and their website was allowed to write the key those uploads used. It had no way of running any more — the part that triggered it was already deleted — but it was still inside the extension, and anyone reviewing the code would rightly refuse it. It is now gone completely, along with the setting that let their website talk to your extension at all.

**The CAPTCHA loop can no longer spin forever.** If the site ever shows a CAPTCHA again and the reader program is not running, the extension used to refresh that CAPTCHA every three seconds indefinitely — behaviour that looks exactly like a bot and invites a block. It now stops after 5 tries and sends you a Telegram message asking a person to type it in.

**Store paperwork is written.** A privacy policy page, a plain-English reason for every permission the extension asks for, and the full listing text — all ready to paste, in the new `store/` folder.

**Why:** Loading the extension by hand on each machine needs developer mode, shows a warning every time Chrome starts, and has to be redone by hand for every update. Publishing it privately means your staff install from a link and updates arrive on their own.

**What changed for you:** Nothing in how the bot behaves — everything removed was already dead code, and you confirmed a full run still works. One small tidy-up: a permission the extension asked for but never used has been dropped.

**What you need to do:** Follow `store/README.md`. Four steps: put the privacy policy on a free GitHub page, pay Google's one-time $5 developer fee, upload the package, paste in the text from `store/LISTING.md`. **Do not skip the last step** — after Google approves it the extension gets a new permanent ID, and Google Sheets sync will quietly stop working until you register that ID. The instructions say exactly where.

## 2026-09-21 — Dashboard redesign, booked clients, login health, and the booking-retry fix go live (Issues #59 #74 #75 #76 #77)

**What it does:** Everything that had been built and tested in the test build is now the real thing. Four pieces:

**The booking-retry fix (#77) — the important one.** Until today, if a booking attempt failed, the bot quietly blocked that date for **15 minutes** and refused to try it again, while Telegram kept reporting the date as available. That is exactly the problem you saw: dates found, alerts firing, nothing ever booked. Now a date is **never given up on** while the site still lists it. Every round tries again. Only after **6 failed rounds in a row** does that one date rest for 2-5 minutes, then it gets another 6 rounds, and so on. Resting affects one date only — every other location and date keeps being checked and booked as normal. Telegram now marks a resting date with ⏸️ instead of pretending it is available.

**Dashboard redesign (#59).** New header, live counts, notifications and a cleaner layout.

**Year filter and views (#74).** Filter clients by year, with live counts per view.

**Booked clients and money (#75).** A confirmed client moves out of the working list into a **Booked** section where you record what they paid and see what is still owed.

**Login health sweep (#76).** Checks that client logins still work, and reports which ones are failing before you find out the hard way.

**Why:** All of this had been sitting in the test build only. The machines running real clients were still on the old code — including the 15-minute booking block — so the fixes were not reaching anyone.

**What changed for you:** Reload the extension on every machine, owner and staff. The dashboard looks different and the booking behaviour is materially better. Two smaller fixes rode along: the dashboard logo is correct again, and devices are no longer named "TEST-something" when connecting to cloud sync (a test tag that had leaked into production earlier).

## 2026-08-28 — IP changing: no limit, and four countries (Issue #73)
**What it does:** Two changes to the automatic IP switching. First, the old "only 3 IP changes per hour" limit is gone — when the site blocks you, the bot now changes IP as many times as it takes. Second, it no longer uses only American servers: it picks from **25 locations across the US, Canada, Australia and Italy**, and never picks the one it is already on.
**Why:** If a block covers a whole run of American addresses, having only US servers to move between means nowhere left to go. Three more countries widen the escape route a lot. And the 3-per-hour cap could leave a client stuck waiting for you when the fix was one more switch away.
**What changed for you:** Nothing to set up — same VPN, same buttons. When a block happens, the Telegram "IP CHANGED AUTOMATICALLY" message may now name a city like Toronto, Sydney or Milan instead of always a US one. All 25 locations were checked against Mullvad's real server list first, so none can fail to connect. Calgary was left out on purpose (no server on our approved list), and Rome was dropped because Mullvad has no Rome — Italy is Milan and Palermo.
**One thing to watch:** with no limit, if a block is ever tied to the *account* rather than the address, the bot will keep switching IPs and retrying every 15-20 seconds instead of stopping. This was a deliberate choice. If you see that pattern in Telegram, stop the client and say so — it means the block is not about the IP at all.

## 2026-08-28 — The slots overview panel is back (Issue #72)
**What it does:** Brings back the summary panel under the calendar that shows, at a glance, **which months and dates are open at the city being checked**, plus the times on whichever date is open. Dates inside your client's wanted range show green; dates outside show grey. Both are bold, and so is the month name, so the table reads clearly instead of being a wall of thin digits. When a city has nothing, the table says **No slots available** in bold black, and the calendar itself shows the old "No Slots Available - CITY" line again. The panel closes with a blue bar showing how many dates fall inside that client's range.
**Why:** That overview disappeared when we removed the old third-party file that was quietly uploading your clients' screenshots to a competitor's server. The panel was genuinely useful, so this rebuilds it in our own code — same usefulness, nothing leaving your machine.
**What changed for you:** While the bot cycles you can now see each city's open months, dates and times without opening the calendar. If a client has no date range set, the blue bar warns you in red that booking is blocked for them.

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
