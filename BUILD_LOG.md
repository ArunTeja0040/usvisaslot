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

## 2026-05-31 — Test workspace set up (no issue)
**What it does:** Created a separate, safe copy of the extension for testing new ideas, plus a set of guide documents so the assistant always knows the rules, the code, and the workflow without being reminded.
**Why:** So new booking improvements can be built and tried in ONE test Chrome profile without ever touching the live extension that runs all your real clients.
**What changed for you:** You now have a "SlotHunter TEST" extension to load in one test profile. It can find slots but will NOT book anything until you say so. Every future build will be explained here in plain English automatically.
