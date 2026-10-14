# Ops Platform database migrations

Run in order, **test project first**. Production only after the founder approves the test run.

| File | What it adds | Last result you should see |
| --- | --- | --- |
| `101_ops_core.sql` | New tables and columns, security-question list, expense categories | `new ops tables = 17`, then a count of clients per stage |
| `102_ops_security.sql` | Who can see what (founder, staff, bots), storage rules | 17 rows, every one with `rls_on = true` and at least 1 rule |
| `103_ops_audit.sql` | Audit log triggers, append-only guard, password-view logging | The list of audited tables |
| `104_ops_queue.sql` | Stage rules, payments, bot queue, money automation, schedules | 9 function names |
| `199_undo_ops.sql` | Removes all of the above. **Test only.** | `undo complete` |

## Steps (Supabase dashboard)

1. Open the **test** project, then go to **Database → Extensions** and switch on **pg_cron**. This powers the stalled-bot sweep and the monthly costs.
2. Go to **SQL Editor → New query**, paste `101_ops_core.sql`, and click **Run**. Repeat for 102, 103 and 104, in that order.
3. Check that each run ends with the result in the table above. If anything shows an error, stop and send a screenshot of it.
4. Point the extension at the test project and do one normal login and cycle. It must behave exactly as before.

Prerequisite: the staff scripts `sql/01`, `02` and `03` from #50 and #53 are already on the project. The test project has them.

## Local tests (no Supabase needed)

```bash
pip install pgserver "psycopg[binary]"
python supabase/tests/run_local.py
```

This runs 50 checks, acting as a bot, the founder and a staff member. Every one must pass.
