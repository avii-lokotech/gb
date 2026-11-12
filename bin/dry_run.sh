#!/bin/bash
# What a push to main would deploy, without deploying: compose.yaml's dry-run service (npm ci as Workers Builds
# does, then wrangler deploy --dry-run, which runs the build), on a copy of the checkout.
set -euo pipefail

IMAGE="gb-local"
BUILD=0

usage() {
    cat <<USAGE
Usage: $(basename "$0") [-h] [-b]

Runs compose.yaml's dry-run service once: on a copy of the checkout it runs npm ci (as Workers Builds), then
wrangler deploy --dry-run, which runs the build (build.mjs) but uploads nothing, and lists the files of dist/.
A good run prints "--dry-run: exiting now." and lists the binding DB. No Cloudflare login.
Warns when the checkout has uncommitted or untracked files: the dry run uses them, a push deploys only what is
committed.

Options:
  -b, --build   rebuild the image $IMAGE (etc/Dockerfile) first, e.g. after changing package-lock.json
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)  usage; exit 0 ;;
        -b|--build) BUILD=1; shift ;;
        *)          echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "warning: uncommitted or untracked files; the dry run uses them, a push deploys only what is committed" >&2
fi
if (( BUILD )) || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker compose build site
fi
docker compose run --rm dry-run
