#!/usr/bin/env python3
"""
Local test run for the Ops Platform migrations (issue #79).

Builds a throwaway Postgres, loads a Supabase stub + the test-project bootstrap
+ the staff scripts (#50 #53) + migrations 101-104, then checks the access
rules by acting as a bot, the founder and a staff member.

Needs:  pip install pgserver "psycopg[binary]"
Run:    python supabase/tests/run_local.py
Nothing here touches Supabase. Exit code 0 = all checks passed.
"""
import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import pgserver
import psycopg

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase" / "migrations"
OP_KEY = "TEST-OPERATOR-KEY-0001"
FOUNDER_UID = str(uuid.uuid4())
STAFF_UID = str(uuid.uuid4())

passed, failed = 0, []


def load(conn, path, strip=()):
    sql = Path(path).read_text()
    for s in strip:
        sql = sql.replace(s, "")
    with conn.cursor() as cur:
        cur.execute(sql)


def act(conn, who, aal="aal2"):
    """Switch the session to a caller: bot | founder | staff | super."""
    with conn.cursor() as cur:
        cur.execute("reset role")
        headers, claims = {}, {}
        if who == "bot":
            headers = {"x-operator-key": OP_KEY}
            role = "anon"
        elif who in ("founder", "staff"):
            claims = {"sub": FOUNDER_UID if who == "founder" else STAFF_UID, "aal": aal}
            role = "authenticated"
        else:
            role = None
        cur.execute("select set_config('request.headers', %s, false)", (json.dumps(headers),))
        cur.execute("select set_config('request.jwt.claims', %s, false)", (json.dumps(claims),))
        if role:
            cur.execute(f"set role {role}")


def q(conn, sql, args=None):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else None


def check(name, fn):
    global passed
    try:
        fn()
        passed += 1
        print(f"  ok    {name}")
    except Exception as e:  # noqa: BLE001
        failed.append(name)
        print(f"  FAIL  {name}: {e}")


def expect_error(conn, sql, contains, args=None):
    try:
        with conn.transaction():
            q(conn, sql, args)
    except psycopg.Error as e:
        if contains.lower() not in str(e).lower():
            raise AssertionError(f"wrong error: {e}") from e
        return
    raise AssertionError("expected an error, got none")


def eq(a, b):
    if a != b:
        raise AssertionError(f"expected {b!r}, got {a!r}")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="ops-pg-"))
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    conn = psycopg.connect(srv.get_uri(), autocommit=True)
    try:
        print("loading schema")
        load(conn, ROOT / "supabase" / "tests" / "00_supabase_stub.sql")
        load(conn, ROOT / "sql" / "10-testdb-bootstrap.sql",
             strip=("create extension if not exists pgcrypto;",))
        for f in ("01-staff-schema.sql", "02-staff-security.sql", "03-staff-deactivate-unassign.sql"):
            load(conn, ROOT / "sql" / f)
        for f in ("101_ops_core.sql", "102_ops_security.sql", "103_ops_audit.sql", "104_ops_queue.sql"):
            load(conn, MIG / f)

        op = q(conn, "select id from operators where api_key = %s", (OP_KEY,))[0][0]
        q(conn, "insert into auth.users (id) values (%s), (%s)", (FOUNDER_UID, STAFF_UID))
        q(conn, """insert into staff (operator_id, name, staff_key, role, auth_user_id)
                   values (%s, 'Founder', 'k-founder', 'owner', %s),
                          (%s, 'Ravi', 'k-ravi', 'staff', %s)""", (op, FOUNDER_UID, op, STAFF_UID))
        staff_id = q(conn, "select id from staff where name = 'Ravi'")[0][0]
        device = q(conn, """insert into devices (operator_id, device_name, worker_enabled)
                            values (%s, 'Laptop A / Profile 1', true) returning id""", (op,))[0][0]
        alpha = q(conn, "select id from user_profiles where username = 'client_alpha'")[0][0]
        beta = q(conn, "select id from user_profiles where username = 'client_beta'")[0][0]
        q(conn, "update user_profiles set assigned_staff_id = %s where id = %s", (staff_id, alpha))
        q(conn, "update staff set pay_per_booking = 500 where id = %s", (staff_id,))

        print("access rules")
        act(conn, "bot")
        check("bot still sees all clients (extension unchanged)",
              lambda: eq(q(conn, "select count(*) from user_profiles")[0][0], 3))
        check("bot upsert of a new client still works, starts at 'approved'", lambda: (
            q(conn, """insert into user_profiles (operator_id, username, password_enc, status, is_active)
                       values (%s, 'client_delta', 'enc:x', 'idle', false)""", (op,)),
            eq(q(conn, "select stage, source from user_profiles where username = 'client_delta'")[0],
               ("approved", "extension"))))

        act(conn, "staff")
        check("staff cannot read user_profiles directly",
              lambda: eq(q(conn, "select count(*) from user_profiles")[0][0], 0))
        check("staff see clients through client_cards",
              lambda: eq(q(conn, "select count(*) from client_cards")[0][0], 4))
        check("client_cards has no price or secret columns", lambda: eq(
            q(conn, """select count(*) from information_schema.columns where table_name = 'client_cards'
                       and column_name in ('agreed_price','price_per_person','password_enc','security_a1_enc')""")[0][0], 0))
        for t in ("payments", "client_billing", "expenses", "audit_log", "price_list",
                  "v_client_money", "v_monthly_profit", "v_founder_pocket", "founder_repayments"):
            check(f"staff read nothing from {t}",
                  lambda t=t: eq(q(conn, f"select count(*) from {t}")[0][0], 0))
        check("staff cannot insert into payments directly", lambda: expect_error(
            conn, "insert into payments (operator_id, profile_id, kind, amount, method, paid_on) "
                  "values (%s, %s, 'advance', 1, 'upi', current_date)", "row-level security", (op, alpha)))

        act(conn, "staff", aal="aal1")
        check("staff without two-step sign-in see nothing",
              lambda: eq(q(conn, "select count(*) from client_cards")[0][0], 0))

        print("stages, payments, queue")
        act(conn, "staff")
        check("no hunting before the advance", lambda: expect_error(
            conn, "select request_start(%s)", "advance as paid", (alpha,)))
        check("staff record the advance", lambda: q(
            conn, "select record_payment(%s, 'advance', 5000, 'upi', current_date)", (alpha,)))
        act(conn, "super")
        check("advance moves client to advance_paid", lambda: eq(
            q(conn, "select stage, payment_status from user_profiles where id = %s", (alpha,))[0],
            ("advance_paid", "advance_paid")))
        act(conn, "staff")
        job = {}
        check("staff start hunting after the advance", lambda: job.setdefault(
            "id", q(conn, "select request_start(%s)", (alpha,))[0][0]))
        check("second start returns the same job", lambda: eq(
            q(conn, "select request_start(%s)", (alpha,))[0][0], job["id"]))
        check("staff override is refused", lambda: expect_error(
            conn, "select request_start(%s, true)", "advance as paid", (beta,)))

        act(conn, "bot")
        check("bot claims the job", lambda: eq(
            q(conn, "select id from claim_job(%s)", (device,))[0][0], job["id"]))
        check("busy bot gets no second job", lambda: eq(
            q(conn, "select count(*) from claim_job(%s)", (device,))[0][0], 0))
        check("heartbeat says continue", lambda: eq(
            q(conn, "select heartbeat_job(%s, 'hunting')", (job["id"],))[0][0], "continue"))

        act(conn, "staff")
        check("staff pause", lambda: q(conn, "select request_stop(%s, true)", (alpha,)))
        act(conn, "bot")
        check("bot hears pause on next heartbeat", lambda: eq(
            q(conn, "select heartbeat_job(%s)", (job["id"],))[0][0], "pause"))
        act(conn, "super")
        check("pause keeps the client in hunting", lambda: eq(
            q(conn, "select stage from user_profiles where id = %s", (alpha,))[0][0], "hunting"))

        act(conn, "staff")
        job2 = q(conn, "select request_start(%s)", (alpha,))[0][0]
        act(conn, "bot")
        q(conn, "select * from claim_job(%s)", (device,))
        act(conn, "super")
        q(conn, "update bot_jobs set heartbeat_at = now() - interval '11 minutes' where id = %s", (job2,))
        check("stalled job is swept back to the queue", lambda: (
            eq(q(conn, "select sweep_stalled_jobs()")[0][0], 1),
            eq(q(conn, "select status from bot_jobs where id = %s", (job2,))[0][0], "queued")))
        act(conn, "bot")
        q(conn, "select * from claim_job(%s)", (device,))
        check("booked: stage moves, per-booking pay is added", lambda: (
            q(conn, "select finish_job(%s, 'booked')", (job2,)),
            act(conn, "super"),
            eq(q(conn, "select stage from user_profiles where id = %s", (alpha,))[0][0], "booked"),
            eq(q(conn, "select amount from expenses where profile_id = %s and note = 'auto: per-booking pay'",
                 (alpha,))[0][0], 500)))

        act(conn, "super")
        check("stage rule blocks illegal jumps", lambda: expect_error(
            conn, "update user_profiles set stage = 'closed' where id = %s", "cannot move", (beta,)))
        act(conn, "staff")
        check("staff cannot force a stage", lambda: expect_error(
            conn, "select force_stage(%s, 'hunting', 'test')", "only the founder", (beta,)))
        act(conn, "founder")
        check("founder can force a stage with a reason", lambda: q(
            conn, "select force_stage(%s, 'hunting', 'client paid in cash')", (beta,)))

        print("audit log")
        act(conn, "founder")
        check("founder reads the audit log", lambda: (
            q(conn, "select count(*) from audit_log")[0][0] > 0) or (_ for _ in ()).throw(AssertionError("empty")))
        check("override is in the audit log", lambda: eq(
            q(conn, "select count(*) from audit_log where action = 'stage_override'")[0][0], 1))
        check("audit has no secrets", lambda: eq(
            q(conn, "select count(*) from audit_log where before ? 'password_enc' or after ? 'password_enc'")[0][0], 0))
        check("founder can log a password view", lambda: q(
            conn, "select log_secret_view(%s, 'password')", (alpha,)))
        act(conn, "staff")
        check("staff cannot view passwords", lambda: expect_error(
            conn, "select log_secret_view(%s, 'password')", "only the founder", (alpha,)))
        act(conn, "bot")
        check("bots cannot use the password-view function", lambda: expect_error(
            conn, "select log_secret_view(%s, 'password')", "permission denied", (alpha,)))  # blocked before it runs
        act(conn, "super")
        check("audit log cannot be edited, even by the database owner", lambda: expect_error(
            conn, "update audit_log set action = 'x'", "append-only"))
        check("audit log cannot be deleted", lambda: expect_error(
            conn, "delete from audit_log", "append-only"))
        check("audit log cannot be emptied", lambda: expect_error(
            conn, "truncate audit_log", "append-only"))

        print("storage and money")
        act(conn, "staff")
        check("staff upload a screenshot", lambda: q(
            conn, "insert into storage.objects (bucket_id, name) values ('ops-files', %s)", (f"{op}/screens/a.png",)))
        check("staff cannot upload receipts", lambda: expect_error(
            conn, "insert into storage.objects (bucket_id, name) values ('ops-files', %s)",
            "row-level security", (f"{op}/receipts/r.png",)))
        act(conn, "founder")
        check("founder uploads a receipt", lambda: q(
            conn, "insert into storage.objects (bucket_id, name) values ('ops-files', %s)", (f"{op}/receipts/r.png",)))
        check("founder sees profit for this month", lambda: eq(
            q(conn, "select money_in, money_out, profit from v_monthly_profit "
                    "where month = date_trunc('month', current_date)::date")[0], (5000, 500, 4500)))
        act(conn, "super")
        cat = q(conn, "select id from expense_categories where operator_id = %s and name = 'VPN and proxies'", (op,))[0][0]
        q(conn, "insert into recurring_expenses (operator_id, category_id, amount, day_of_month) values (%s, %s, 900, 1)",
          (op, cat))
        check("recurring cost generated once per month", lambda: (
            eq(q(conn, "select generate_recurring_expenses()")[0][0], 1),
            eq(q(conn, "select generate_recurring_expenses()")[0][0], 0)))

        print("re-run and undo")
        check("migrations run twice without error", lambda: [
            load(conn, MIG / f) for f in
            ("101_ops_core.sql", "102_ops_security.sql", "103_ops_audit.sql", "104_ops_queue.sql")])
        check("undo refuses without confirmation", lambda: expect_error(
            conn, (MIG / "199_undo_ops.sql").read_text(), "refusing to undo"))
        check("undo works on test, then migrations re-apply cleanly", lambda: (
            q(conn, "set ops.confirm_undo = 'yes'"),
            load(conn, MIG / "199_undo_ops.sql"),
            q(conn, "reset ops.confirm_undo"),
            [load(conn, MIG / f) for f in
             ("101_ops_core.sql", "102_ops_security.sql", "103_ops_audit.sql", "104_ops_queue.sql")]))
    finally:
        conn.close()
        srv.cleanup()
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{passed} passed, {len(failed)} failed")
    if failed:
        print("failed: " + "; ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
