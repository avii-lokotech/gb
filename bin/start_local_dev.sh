#!/bin/bash
# Run the local site: compose.yaml's site (wrangler dev on 127.0.0.1:8791).
set -euo pipefail

NAME="gb-dev"
BUILD=()

usage() {
    cat <<USAGE
Usage: $(basename "$0") [-h] [-b]

Starts compose.yaml's service site (container $NAME) detached and returns: the image is built from
etc/Dockerfile if missing; the site comes up on http://127.0.0.1:8791 a few seconds later (wrangler dev runs
the build, build.mjs and the typecheck, first), with its D1 binding on a local D1 in the wrangler volume. Already running and unchanged: nothing happens.
Output: docker logs -f $NAME. Stop: bin/stop_local_dev.sh.

Options:
  -b, --build   rebuild the image first (from cache where possible), e.g. after changing etc/Dockerfile or
                package-lock.json
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)  usage; exit 0 ;;
        -b|--build) BUILD=(--build); shift ;;
        *)          echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")/.."

# The checkout is mounted read-only, so Docker cannot create the mount points of the wrangler and dist volumes in
# it. Empty, git-ignored directories; the only thing ever written into the checkout.
mkdir -p .wrangler dist
docker compose up -d ${BUILD[@]+"${BUILD[@]}"} site
echo "started $NAME on http://127.0.0.1:8791; output: docker logs -f $NAME; stop: bin/stop_local_dev.sh"
