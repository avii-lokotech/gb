# Tooling image for compose.yaml's site (wrangler dev) and dry-run (wrangler deploy --dry-run) services:
# everything runs in here, nothing is installed on the host. The repo is mounted read-only at /app; the pinned
# dependencies (package-lock.json) live in /node_modules, outside the mount, and Node resolves them from /app by
# walking up the tree. What the build and wrangler dev write goes to /app/dist and /app/.wrangler, named volumes
# (compose.yaml), so nothing is written into the checkout. Debian (glibc): workerd does not run on Alpine.
# The base image is pinned by digest (multi-arch index); the tag says which version that is.
FROM node:22.23.1-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba

# ca-certificates: workerd will not start without system CA certificates.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

ENV PATH=/node_modules/.bin:$PATH \
    HOME=/tmp \
    WRANGLER_SEND_METRICS=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
# Owned by node so the named volumes mounted here are too: Docker fills an empty volume from the image's content
# at the mount point, ownership included.
RUN mkdir -p /app/.wrangler /app/dist /tmp/.npm && chown node:node /app/.wrangler /app/dist /tmp/.npm
USER node
WORKDIR /app
