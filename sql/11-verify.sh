#!/usr/bin/env bash
# ============================================================================
# 11-verify.sh — proves the staff isolation on the TEST Supabase project (#50)
#
# SETUP
#   1) Run "Step 1" SQL from 11-verify-isolation.md (creates a test staff
#      member + assigns client_alpha to them).
#   2) Put your test project's URL + anon key in sql/verify-env.sh
#      (that file is git-ignored, so keys are never committed).
#   3) bash sql/11-verify.sh
#
# These go through the REST API with key headers — the same way the extension
# talks to the database. (The SQL Editor bypasses security rules, so it cannot
# be used to test this.)
# ============================================================================

cd "$(dirname "$0")/.." || exit 1

if [ -f sql/verify-env.sh ]; then
  # shellcheck disable=SC1091
  . sql/verify-env.sh
else
  echo "ERROR: sql/verify-env.sh not found. Copy the example and fill it in."
  exit 1
fi

# ---- sanity checks so failures are never silent ----------------------------
case "$URL" in
  https://*.supabase.co) ;;
  *) echo "ERROR: URL must look like https://<project-ref>.supabase.co"
     echo "       Got: '$URL'"
     echo "       (that looks like a KEY, not the project address — find it in"
     echo "        Supabase → Settings → API → Project URL)"
     exit 1 ;;
esac
[ -n "$ANON" ] || { echo "ERROR: ANON is empty."; exit 1; }

echo "Project: $URL"

H_ANON=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON")
H_OWNER=("${H_ANON[@]}" -H "x-operator-key: $OWNER_KEY")
H_STAFF=("${H_ANON[@]}" -H "x-staff-key: $STAFF_KEY")
H_JSON=(-H "Content-Type: application/json" -H "Prefer: return=representation")

# show the HTTP status too, so an empty body is never ambiguous
run() { curl -sS -w $'\n   [HTTP %{http_code}]\n' "$@"; }

line() { echo; echo "──────────────────────────────────────────────"; echo "$1"; echo "   expect: $2"; }

line "3a OWNER sees ALL clients" "client_alpha, client_beta, client_gamma"
run "$URL/rest/v1/user_profiles?select=username&order=username" "${H_OWNER[@]}"

line "3b STAFF sees ONLY assigned  ★ THE CORE PROOF" "only client_alpha"
run "$URL/rest/v1/user_profiles?select=username&order=username" "${H_STAFF[@]}"

line "3c STAFF cannot read pricing table" "[] (empty)"
run "$URL/rest/v1/client_billing?select=*" "${H_STAFF[@]}"

line "3d STAFF CAN edit their client's dates" "success, end_date updated"
run -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha&select=username,end_date" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"end_date":"2027-01-31"}'

line "3e STAFF cannot un-assign / grab clients" "ERROR: Staff may only change..."
run -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"assigned_staff_id":null}'

line "3f STAFF cannot change pricing" "ERROR: Staff may only change..."
run -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_alpha" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"agreed_price":1}'

line "3g STAFF cannot touch another client" "[] (no rows matched)"
run -X PATCH "$URL/rest/v1/user_profiles?username=eq.client_beta&select=username" \
  "${H_STAFF[@]}" "${H_JSON[@]}" -d '{"end_date":"2027-01-31"}'

line "3h STAFF cannot read the staff list (secrets)" "[] (empty)"
run "$URL/rest/v1/staff?select=*" "${H_STAFF[@]}"

echo
echo "──────────────────────────────────────────────"
echo "Done. 3b is the decisive one."
