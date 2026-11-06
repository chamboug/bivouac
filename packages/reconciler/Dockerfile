# Image of the Bivouac reconciler, built from the monorepo root:
#   docker build -f packages/reconciler/Dockerfile .
# Published to GHCR by CI with an exact `sha-<commit>` tag.

FROM node:26-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci && npx tsc -b packages/reconciler

# Production dependencies only. Workspace packages are symlinks into
# packages/, so the final image keeps the same layout.
FROM node:26-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/manifest/package.json packages/manifest/
COPY packages/bivy/package.json packages/bivy/
COPY packages/reconciler/package.json packages/reconciler/
RUN npm ci --omit=dev --workspace @bivouac/reconciler

# sops decrypts the instance's secrets. Its official image ships a static
# binary, which runs as is on Alpine (verified, v3.13.3, D47).
FROM ghcr.io/getsops/sops:v3.13.3@sha256:857f5a151ac0b2bfc55c1e4e5581d66fb8e268e4d106b38e74191f3bac9d58ea AS sops

FROM node:26-alpine
# git and ssh read the instance repo with the read-only deploy key.
RUN apk add --no-cache git openssh-client
COPY --from=sops /usr/local/bin/sops /usr/local/bin/sops
WORKDIR /app
COPY --from=deps /src/node_modules node_modules
COPY --from=build /src/packages/manifest/package.json packages/manifest/
COPY --from=build /src/packages/manifest/dist packages/manifest/dist
COPY --from=build /src/packages/reconciler/package.json packages/reconciler/
COPY --from=build /src/packages/reconciler/dist packages/reconciler/dist
COPY packages/reconciler/github_known_hosts packages/reconciler/
CMD ["node", "packages/reconciler/dist/main.js"]
