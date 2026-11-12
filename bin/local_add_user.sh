#!/bin/bash
# Create a login (a row in the user table) in the local D1, for local tests. The live D1: bin/cloudflare_add_user.sh.
set -euo pipefail

NAME="gb-dev"
EMAIL=""
FULLNAME=""

usage() {
    cat <<USAGE
Usage: $(basename "$0") [-h] -e EMAIL [-n NAME]

Writes the local D1 only (the wrangler volume of compose.yaml; gone after bin/stop_local_dev.sh). Prompts for the
password (at least 8 characters), hashes it as worker/auth.ts checks it (PBKDF2-SHA256, 100000 iterations) and
inserts the user row. Runs in the container $NAME (bin/start_local_dev.sh). A ready-made test login:
t/local_seed.sh.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -e)        EMAIL="$2"; shift 2 ;;
        -n)        FULLNAME="$2"; shift 2 ;;
        *)         echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done
[[ -n "$EMAIL" ]] || { usage >&2; exit 2; }

cd "$(dirname "$0")/.."

read -rsp "Password for $EMAIL: " PASSWORD; echo
[[ ${#PASSWORD} -ge 8 ]] || { echo "password: at least 8 characters" >&2; exit 2; }

HASH=$(docker exec -e PASSWORD="$PASSWORD" "$NAME" node -e '
    const c = require("crypto"), salt = c.randomBytes(16);
    const hash = c.pbkdf2Sync(process.env.PASSWORD, salt, 100000, 32, "sha256");
    console.log(`pbkdf2$100000$${salt.toString("base64")}$${hash.toString("base64")}`);')

q() { printf "'%s'" "${1//\'/\'\'}"; }
docker exec "$NAME" wrangler d1 execute gb-db --local --command \
    "INSERT INTO user (email, name, password_hash) VALUES ($(q "$EMAIL"), $(q "$FULLNAME"), $(q "$HASH"))
     RETURNING id, email, name"
