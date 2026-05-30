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
