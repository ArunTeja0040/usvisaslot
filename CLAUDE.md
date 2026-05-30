# CLAUDE.md — SlotHunter TEST Build

This is the **TEST build** of the SlotHunter Chrome extension. It runs in ONE isolated test Chrome profile. Production lives in a separate folder and must NEVER be touched from here.

> These instructions OVERRIDE default behavior. Follow them exactly.

---

## What This Is

Test/dev copy of the US visa appointment booking Chrome extension, on branch `feature/parallel-booking`. Used to build and prove new booking-logic enhancements (e.g. parallel slot detection) WITHOUT disturbing the production extension that runs all live client profiles.

- **Production folder:** `/Users/aruntejagannu/Documents/Claude/Projects/Usa Visa slot Booking/extension/` (branch `main`) — loaded in all client profiles. **Do not edit from this worktree.**
- **Test folder (this one):** `/Users/aruntejagannu/Documents/Claude/Projects/SlotHunter-test/extension/` (branch `feature/parallel-booking`) — loaded in ONE test profile only.

---

## THE THUMB RULE (most important — never skip)

Every change follows this exact order. **Never jump ahead. Never build without approval.**

```
1. PLAN     → present a plan in plain language. What, why, which files, risks.
2. APPROVE  → wait for the user's explicit "yes / go / ok to proceed". STOP until then.
3. ISSUE    → create a GitHub issue on the autobooking repo + add to project board (Todo).
4. BUILD    → implement. Test-folder files only.
5. EXPLAIN  → tell the user in LAYMAN ENGLISH what was built (see rule below).
6. TEST     → user tests. Wait for their confirmation it works.
7. CLOSE    → on user OK: close issue, commit, push to BOTH repos, move board to Done, write BUILD_LOG entry.
```

If unsure which step we're on → ask. Do not assume approval.

---

## LAYMAN-ENGLISH RULE (every build)

The user is not deeply technical. After ANY build or fix:

1. Explain in plain, simple English — no jargon. What it does, why, what changes for them.
2. Append the same explanation to `BUILD_LOG.md` (newest entry on top).

Use everyday analogies. Example: "Before, the bot checked one city at a time like reading one page of a menu before flipping to the next. Now it reads all pages at once — much faster."

---

## Repos & Branch

- **Public repo (origin):** https://github.com/ArunTeja0040/usvisaslot
- **Private repo (autobooking):** https://github.com/ArunTeja0040/autobooking
- **Issues + project board live on:** `autobooking`
- **Project board:** https://github.com/users/ArunTeja0040/projects/2
  - Project ID: `PVT_kwHOAp7Gbs4BYH1D`
  - Status field ID: `PVTSSF_lAHOAp7Gbs4BYH1DzhTP1-U`
  - Status options: Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657`
- **This branch:** `feature/parallel-booking`
- **Always push to BOTH remotes:** `origin` and `autobooking`.

Commit message footer:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## Test-Build Safety (already wired — keep intact)

This build has guardrails so testing on a real client never causes harm:

- **Manifest name:** "SlotHunter TEST" — distinct in `chrome://extensions`.
- **`TEST_MODE = true`** (top of `extension/js/auto-booking.js`).
- **`TEST_FORCE_NO_SUBMIT = true`** — auto-submit is DISABLED. Bot detects slots but never books. Flip to `false` ONLY when the user approves the booking stage.
- **Telegram:** every message prefixed `🧪 [TEST]`.
- **Device name:** auto-prefixed `TEST-` → dashboard can filter test noise.
- **Shared backend:** same Supabase + Telegram as production (tagged, not separate).

Two-stage testing:
1. **Detection stage** (now): no booking, read-only. Prove speed/accuracy.
2. **Booking stage** (later, on approval): flip `TEST_FORCE_NO_SUBMIT` to false.

---

## Docs (read these before acting)

| File | Use |
|------|-----|
| `WORKFLOW.md` | Exact step-by-step of the thumb rule + commit/push/board conventions |
| `ARCHITECTURE.md` | How the extension works — files, worlds, events, API, flows |
| `TESTING.md` | How to load + test the build, what to watch |
| `SUPABASE_SCHEMA.md` | All cloud tables + columns |
| `DECISIONS.md` | Past decisions, known issues, deferred items |
| `BUILD_LOG.md` | Plain-English history of every build (append on each build) |

## Skills

- `issue-flow` — runs the whole thumb-rule lifecycle.
- `extension-dev` — safe-edit rules for the codebase.
