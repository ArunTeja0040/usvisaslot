#!/usr/bin/env bash
# ============================================================================
# 11-verify.sh — proves the staff isolation on the TEST Supabase project (#50)
#
# 1) Run the "Step 1" SQL from 11-verify-isolation.md first (creates a test
#    staff member + assigns client_alpha to them).
# 2) Fill in URL and ANON below (Supabase → Settings → API on the TEST project).
# 3) bash sql/11-verify.sh
#
# These go through the REST API with key headers — the same way the extension
# talks to the database. (The SQL Editor bypasses security rules, so it cannot
# be used to test this.)
# ============================================================================

URL="https://YOUR-TEST-PROJECT.supabase.co"     # <-- fill in
ANON="YOUR-TEST-ANON-KEY"                        # <-- fill in

OWNER_KEY="TEST-OPERATOR-KEY-0001"
STAFF_KEY="TEST-STAFF-KEY-AAA1"

H_ANON=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON")
H_OWNER=("${H_ANON[@]}" -H "x-operator-key: $OWNER_KEY")
H_STAFF=("${H_ANON[@]}" -H "x-staff-key: $STAFF_KEY")
H_JSON=(-H "Content-Type: application/json" -H "Prefer: return=representation")

line() { echo; echo "──────────────────────────────────────────────"; echo "$1"; echo "   expect: $2"; }

line "3a OWNER sees ALL clients" "client_alpha, client_beta, client_gamma"
curl -s "$URL/rest/v1/user_profiles?select=username&order=username" "${H_OWNER[@]}"; echo

line "3b STAFF sees ONLY assigned  ★ THE CORE PROOF" "only client_alpha"
curl -s "$URL/rest/v1/user_profiles?select=username&order=username" "${H_STAFF[@]}"; echo

line "3c STAFF cannot read pricing table" "[] (empty)"
curl -s "$URL/rest/v1/client_billing?select=*" "${H_STAFF[@]}"; echo

line "3d STAFF CAN edit their client's dates" "success, end_date updated"
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha&select=username,end_date" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"end_date":"2027-01-31"}'; echo

line "3e STAFF cannot un-assign / grab clients" "ERROR: Staff may only change..."
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"assigned_staff_id":null}'; echo

line "3f STAFF cannot change pricing" "ERROR: Staff may only change..."
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"agreed_price":1}'; echo

line "3g STAFF cannot touch another client" "[] (no rows matched)"
curl -s -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_beta&select=username" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"end_date":"2027-01-31"}'; echo

line "3h STAFF cannot read the staff list (secrets)" "[] (empty)"
curl -s "$URL/rest/v1/staff?select=*" "${H_STAFF[@]}"; echo

echo
echo "──────────────────────────────────────────────"
echo "Done. 3b is the decisive one."
