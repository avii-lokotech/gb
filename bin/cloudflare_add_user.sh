#!/bin/bash
# Create a login (a row in the user table) in the live D1 gb-db, from the host: OpenSSL 3 hashes the password,
# curl writes it through Cloudflare's D1 query API.
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
ITERATIONS=100000
EMAIL=""
FULLNAME=""
TOKEN="${CLOUDFLARE_API_TOKEN:-}"

usage() {
    cat <<USAGE
Usage: $(basename "$0") [-h] -t TOKEN -e EMAIL [-n NAME]

Writes to the live D1. Prompts for the password (twice, at least 8 characters), hashes it with OpenSSL 3 in the
format worker/auth.ts checks, and inserts the user row. Prints the new user's id, email and name, or D1's error
(e.g. "UNIQUE constraint failed: user.email").

  -t TOKEN      Cloudflare API token with D1 Edit (and Account Settings Read, to find the account);
                default: CLOUDFLARE_API_TOKEN
  -e EMAIL      the login
  -n NAME       shown in the site (default: empty)

Optional: CLOUDFLARE_ACCOUNT_ID when the token sees more than one account; OPENSSL, an OpenSSL 3 binary
(macOS's own openssl is LibreSSL, which cannot derive PBKDF2 keys; Homebrew's openssl@3 is found by itself).
Needs curl and jq. The password and a -t token are visible in the process list while the script runs.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -t)        TOKEN="$2"; shift 2 ;;
        -e)        EMAIL="$2"; shift 2 ;;
        -n)        FULLNAME="$2"; shift 2 ;;
        *)         echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done
[[ -n "$EMAIL" ]] || { usage >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "API token (D1 Edit) required: -t TOKEN, or CLOUDFLARE_API_TOKEN" >&2; exit 2; }

cd "$(dirname "$0")/.."

# The database the Worker binds, so this never drifts from the deployed binding.
DATABASE_ID="$(sed -n 's/.*"database_id": *"\([^"]*\)".*/\1/p' wrangler.jsonc)"
[[ -n "$DATABASE_ID" ]] || { echo "no database_id in wrangler.jsonc" >&2; exit 1; }

# The first OpenSSL 3 found; LibreSSL has no kdf command (and still exits 0 on it).
FOUND=""
for candidate in ${OPENSSL:-} openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    [[ "$("$candidate" version 2>/dev/null)" == OpenSSL\ 3* ]] && { FOUND="$candidate"; break; }
done
[[ -n "$FOUND" ]] || { echo "OpenSSL 3 not found (brew install openssl@3, or set OPENSSL)" >&2; exit 1; }

read -rsp "Password for $EMAIL: " PASSWORD; echo
read -rsp "Again: " AGAIN; echo
[[ "$PASSWORD" == "$AGAIN" ]] || { echo "the passwords differ" >&2; exit 1; }
(( ${#PASSWORD} >= 8 )) || { echo "password: at least 8 characters" >&2; exit 1; }

SALT_HEX="$("$FOUND" rand -hex 16)"
HASH="$("$FOUND" kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt "pass:$PASSWORD" -kdfopt "hexsalt:$SALT_HEX" \
    -kdfopt "iter:$ITERATIONS" -binary PBKDF2 | base64)"
unset PASSWORD AGAIN
SALT="$(printf '%s' "$SALT_HEX" | xxd -r -p | base64)"

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
if [[ -z "$ACCOUNT" ]]; then
    ACCOUNTS="$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" "$API/accounts")"
    if [[ "$(jq -r '.success' <<<"$ACCOUNTS" 2>/dev/null)" != true ]]; then
        echo "Cloudflare refused the token: $(jq -r '[.errors[]?.message] | join("; ")' <<<"$ACCOUNTS" 2>/dev/null || echo "$ACCOUNTS")" >&2
        exit 1
    fi
    N="$(jq -r '.result | length' <<<"$ACCOUNTS")"
    if [[ "$N" != 1 ]]; then
        echo "the token sees $N accounts: give it Account Settings Read, or set CLOUDFLARE_ACCOUNT_ID (the account" >&2
        echo "id is in the dashboard's address, dash.cloudflare.com/<account id>/..., and on the Workers & Pages page)" >&2
        exit 1
    fi
    ACCOUNT="$(jq -r '.result[0].id' <<<"$ACCOUNTS")"
fi

# query SQL [PARAM...]: one statement with bound parameters; prints its result rows as JSON, or the error and exits.
query() {
    local sql="$1" reply
    shift
    reply="$(jq -n --arg sql "$sql" '{sql: $sql, params: $ARGS.positional}' --args "$@" |
        curl -s --max-time 30 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
            --data-binary @- "$API/accounts/$ACCOUNT/d1/database/$DATABASE_ID/query")"
    if [[ "$(jq -r '.success' <<<"$reply")" != true ]]; then
        jq -r '.errors[]?.message // .' <<<"$reply" >&2
        exit 1
    fi
    jq -c '.result[0].results' <<<"$reply"
}

USER_ROW="$(query "INSERT INTO user (email, name, password_hash) VALUES (?1, ?2, ?3) RETURNING id, email, name" \
    "$EMAIL" "$FULLNAME" "pbkdf2\$$ITERATIONS\$$SALT\$$HASH")"
echo "$USER_ROW"
