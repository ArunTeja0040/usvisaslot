---
name: issue-flow
description: Run the full SlotHunter change lifecycle (the "thumb rule") for any enhancement or bug fix in this repo — plan, get approval, create GitHub issue + board card, build, explain in layman English, wait for test, then close + commit + push both repos + move board to Done + log. Use whenever the user requests a new feature, enhancement, or bug fix in the SlotHunter extension.
---

# issue-flow — Change Lifecycle

Enforces the project workflow so the user never has to re-explain it. Follow the steps in order. Approval gates are HARD STOPS.

## Steps

### 1. PLAN
Present a short plan in plain language: the problem, the proposed fix, which files change, the risks. No code, no issue yet.

### 2. APPROVE (hard stop)
Wait for explicit approval ("yes", "go", "ok to proceed"). If the user questions or revises → adjust and re-confirm. Never proceed on assumption.

### 3. ISSUE
```
gh issue create --repo ArunTeja0040/autobooking --title "<title>" --label "bug|enhancement" --body "<problem / solution / files / related>"
gh project item-add 2 --owner ArunTeja0040 --url <issue-url>
```
Optionally set status In Progress (`47fc9ee4`).

### 4. BUILD
Edit ONLY files under `SlotHunter-test/extension/`. Obey the `extension-dev` skill (feature-flag, don't break booking flow, capture-don't-guess API, keep TEST_MODE guards).

### 5. EXPLAIN (layman) + log
Explain in simple English: what it does, why, what changes for the user. Append the same to `BUILD_LOG.md` (newest on top), using its format.

### 6. TEST (hard stop)
User reloads the test extension and tests. Wait for confirmation. If broken → fix → re-explain → re-test.

### 7. CLOSE & SHIP (only after user confirms)
```
gh issue close <n> --repo ArunTeja0040/autobooking --comment "✅ Verified working — <summary>"

git add <files>
git commit -m "<message>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

git push origin feature/parallel-booking
git push autobooking feature/parallel-booking

ITEM_ID=$(gh api graphql -f query='{ user(login: "ArunTeja0040") { projectV2(number: 2) { items(first: 80) { nodes { id content { ... on Issue { number } } } } } } }' --jq '.data.user.projectV2.items.nodes[] | select(.content.number == <n>) | .id')
gh project item-edit --project-id PVT_kwHOAp7Gbs4BYH1D --id "$ITEM_ID" --field-id PVTSSF_lAHOAp7Gbs4BYH1DzhTP1-U --single-select-option-id 98236657
```
Confirm BUILD_LOG.md entry is written.

## Notes
- Board IDs: Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657`. Project `PVT_kwHOAp7Gbs4BYH1D`.
- Always push BOTH remotes (origin + autobooking).
- If `gh` rate-limited: `gh api rate_limit --jq .resources`, wait for reset.
- Never merge to `main` unless the user explicitly asks.
