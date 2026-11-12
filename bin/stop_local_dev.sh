#!/bin/bash
# Stop and remove the local site (compose.yaml's site) and its volumes.
set -euo pipefail

usage() {
    cat <<USAGE
Usage: $(basename "$0") [-h]

Stops and removes compose.yaml's container, network and volumes: wrangler (what wrangler dev writes, the local D1 included), dist (the
built site) and dry-run-npm (bin/dry_run.sh's npm cache). The next bin/start_local_dev.sh starts clean.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *)         echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")/.."

# --profile tools includes the dry-run service, whose volume compose would otherwise leave.
docker compose --profile tools down --volumes
