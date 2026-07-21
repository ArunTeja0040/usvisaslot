# Proving the staff isolation actually works (issue #50)

⚠️ **You cannot test this in the Supabase SQL Editor.** The editor runs as an admin
account that ignores all security rules — everything will look "allowed". The rules
only apply to requests coming through the API with a key, which is how the extension
talks to the database. So we test with `curl` (or any REST client).

Run everything below against the **TEST** project only.

---

## Step 0 — order of scripts
1. `10-testdb-bootstrap.sql` (creates the mini copy + sample clients)
2. `01-staff-schema.sql`
3. `02-staff-security.sql`

---

## Step 1 — create a test staff member and assign 1 client
Run in the **SQL Editor** of the test project:

```sql
-- create a staff member
insert into public.staff (operator_id, name, email, staff_key, role)
select o.id, 'Test Staff One', 'staff1@example.com', 'TEST-STAFF-KEY-AAA1', 'staff'
from public.operators o
where o.api_key = 'TEST-OPERATOR-KEY-0001'
on conflict (staff_key) do nothing;

-- assign ONE client (client_alpha) to that staff member
update public.user_profiles p
set assigned_staff_id = s.id
from public.staff s
where s.staff_key = 'TEST-STAFF-KEY-AAA1'
  and p.username = 'client_alpha';

-- confirm
select username, assigned_staff_id from public.user_profiles order by username;
```

---

## Step 2 — fill in your test project details
From the test project: **Settings → API**.

```bash
URL="https://YOUR-TEST-PROJECT.supabase.co"
ANON="YOUR-TEST-ANON-KEY"
OWNER_KEY="TEST-OPERATOR-KEY-0001"
STAFF_KEY="TEST-STAFF-KEY-AAA1"
```

---

## Step 3 — the tests

### ✅ 3a. Owner sees ALL clients (should return 3)
```bash
curl -s "$URL/rest/v1/user_profiles?select=username" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-operator-key: $OWNER_KEY"
```
**Expect:** `client_alpha`, `client_beta`, `client_gamma`.

### ✅ 3b. Staff sees ONLY their assigned client (should return 1)
```bash
curl -s "$URL/rest/v1/user_profiles?select=username" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY"
```
**Expect:** only `client_alpha`. ← **the core proof**

### ✅ 3c. Staff cannot see pricing table at all
```bash
curl -s "$URL/rest/v1/client_billing?select=*" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY"
```
**Expect:** `[]` (empty).

### ✅ 3d. Staff CAN edit their client's date range (allowed)
```bash
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY" -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"end_date":"2027-01-31"}'
```
**Expect:** success, row returned with the new date.

### ✅ 3e. Staff CANNOT grab more clients (trigger must block)
```bash
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY" -H "Content-Type: application/json" \
  -d '{"assigned_staff_id":null}'
```
**Expect:** error — *"Staff may only change the date range, cities and run status…"*

### ✅ 3f. Staff CANNOT change pricing (trigger must block)
```bash
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY" -H "Content-Type: application/json" \
  -d '{"agreed_price":1}'
```
**Expect:** the same error.

### ✅ 3g. Staff CANNOT touch someone else's client
```bash
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_beta" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY" -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"end_date":"2027-01-31"}'
```
**Expect:** `[]` — no rows matched, nothing changed.

### ✅ 3h. Staff cannot read the staff list (secrets)
```bash
curl -s "$URL/rest/v1/staff?select=*" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-staff-key: $STAFF_KEY"
```
**Expect:** `[]` (empty).

---

## Known gap at this stage
`price_per_person` / `agreed_price` still exist on `user_profiles`, so in **3b** a staff
member can still *read* those two fields for their own assigned client. They become
truly invisible in step **03**, which drops those columns once the dashboard reads
pricing from `client_billing` instead.

---

## If all 8 pass
The database-level isolation is proven. Then we build the dashboard side (owner
staff-management + assignment UI, staff scoped view), still behind the OFF switch.
