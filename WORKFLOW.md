# WORKFLOW.md — The Thumb Rule, In Detail

Every enhancement or bug fix follows these steps in order. Approval gates are hard stops.

---

## Step 1 — PLAN

- Present a plan in plain English: what the problem is, what the fix does, which files change, what the risks are.
- Keep it short and non-technical enough for the user to follow.
- Do NOT create issues or write code yet.

## Step 2 — APPROVE (hard stop)

- Wait for explicit approval: "yes", "go", "ok to proceed", "build it".
- If the user asks questions or changes the plan → revise and re-confirm.
- Never proceed on a guess.

## Step 3 — ISSUE

- Create a GitHub issue on `ArunTeja0040/autobooking`:
  ```
  gh issue create --repo ArunTeja0040/autobooking --title "..." --label "bug|enhancement" --body "..."
  ```
- Body includes: problem, solution, files, related items.
- Add the issue to the project board (lands in Todo by default):
  ```
  gh project item-add 2 --owner ArunTeja0040 --url <issue-url>
  ```
- Optionally move to In Progress (`47fc9ee4`) while building.

## Step 4 — BUILD

- Edit ONLY files inside this test folder (`SlotHunter-test/extension/`).
- Follow `extension-dev` skill rules (feature-flag, don't break booking flow, capture-don't-guess API).
- Keep `TEST_MODE` guardrails intact.

## Step 5 — EXPLAIN (layman)

- Tell the user in plain English what was built — what it does, why, what changes for them.
- Append the same to `BUILD_LOG.md` (newest on top).

## Step 6 — TEST (hard stop)

- User reloads the test extension and tests.
- Wait for their confirmation it works.
- If broken → fix (back to Build), re-explain, re-test.

## Step 7 — CLOSE & SHIP (only after user confirms)

```
# close issue with a verified comment
gh issue close <n> --repo ArunTeja0040/autobooking --comment "✅ Verified working — ..."

# commit (on feature/parallel-booking)
git add <files>
git commit -m "<message>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

# push to BOTH remotes
git push origin feature/parallel-booking
git push autobooking feature/parallel-booking

# move board card to Done
ITEM_ID=$(gh api graphql -f query='{ user(login: "ArunTeja0040") { projectV2(number: 2) { items(first: 80) { nodes { id content { ... on Issue { number } } } } } } }' --jq '.data.user.projectV2.items.nodes[] | select(.content.number == <n>) | .id')
gh project item-edit --project-id PVT_kwHOAp7Gbs4BYH1D --id "$ITEM_ID" --field-id PVTSSF_lAHOAp7Gbs4BYH1DzhTP1-U --single-select-option-id 98236657
```

- Append the BUILD_LOG.md entry.

---

## Merging to main (only when user asks)
- Production merge happens from `main`, not automatically.
- Never merge `feature/parallel-booking` → `main` without explicit instruction.

## Notes
- Board item IDs: query fresh each time (they change per issue).
- If `gh` rate-limited: `gh api rate_limit --jq .resources`, wait for reset.
