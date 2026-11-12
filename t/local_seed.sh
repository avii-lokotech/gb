#!/bin/bash
# The test login of the local D1. Safe to repeat.
set -euo pipefail

NAME="gb-dev"
EMAIL="test@gb.test"
PASSWORD="local-test-only"

usage() {
    cat <<USAGE
Usage: $(basename "$0") [-h]

Writes the local D1 only (container $NAME, bin/start_local_dev.sh): the user $EMAIL with the password
"$PASSWORD" (set again, and unlocked, if the user exists; its songs stay). For local tests only; the password
is public, so never create this user in the live D1.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *)         echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

HASH=$(docker exec -e PASSWORD="$PASSWORD" "$NAME" node -e '
    const c = require("crypto"), salt = c.randomBytes(16);
    const hash = c.pbkdf2Sync(process.env.PASSWORD, salt, 100000, 32, "sha256");
    console.log(`pbkdf2$100000$${salt.toString("base64")}$${hash.toString("base64")}`);')

docker exec "$NAME" wrangler d1 execute gb-db --local --command \
    "INSERT INTO user (email, name, password_hash) VALUES ('$EMAIL', 'Test Player', '$HASH')
     ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, failed_logins = 0, locked_until = NULL
     RETURNING id, email, name"
