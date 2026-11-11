#!/bin/sh
# The app on this machine, with hot reload: `npm run dev:local`.
# - a Postgres in Docker, kept between runs (container and volume
#   <folder name>-dev-pg), reachable from this machine only;
# - the tests' fake identity provider, which signs in without asking
#   (a "Dev" person, in DEV_GROUPS);
# - files in .data/dev-storage (git ignores .data).
# Nothing here talks to the real platform.
# Do not run `npm run build` while this runs: it downloads the shared layers
# again and breaks the dev server. Stop this first, or restart it afterwards.
set -eu
cd "$(dirname "$0")/.."

# Another app running at the same time needs other ports.
PG_PORT=${DEV_PG_PORT:-55433}
ISSUER_PORT=${DEV_ISSUER_PORT:-4011}
APP_PORT=${DEV_APP_PORT:-3000}
# The groups the app maps to roles (comma-separated).
DEV_GROUPS=${DEV_GROUPS:-famille}

PG="$(basename "$PWD" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_.\n-' '-')-dev-pg"

if ! docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null | grep -q true; then
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" -e POSTGRES_PASSWORD=dev -p "127.0.0.1:$PG_PORT:5432" \
    -v "$PG:/var/lib/postgresql" postgis/postgis:18-3.7 >/dev/null
fi
until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
export DATABASE_URL="postgres://postgres:dev@localhost:$PG_PORT/postgres"
# The app runs migrations at startup in production only: here, before starting.
npx drizzle-kit migrate

FAKE_ISSUER_PORT=$ISSUER_PORT APP_PORT=$APP_PORT node test/e2e/fake-issuer.mjs &
ISSUER_PID=$!
trap 'kill $ISSUER_PID 2>/dev/null' EXIT INT TERM
until curl -fs "http://localhost:$ISSUER_PORT/jwks" >/dev/null 2>&1; do
  kill -0 $ISSUER_PID 2>/dev/null || { echo "The fake identity provider did not start: is port $ISSUER_PORT taken? (DEV_ISSUER_PORT)" >&2; exit 1; }
  sleep 0.2
done
curl -fsG "http://localhost:$ISSUER_PORT/test/next-user" \
  --data-urlencode sub=dev --data-urlencode name=Dev --data-urlencode "groups=$DEV_GROUPS" >/dev/null

PORT=$APP_PORT \
OIDC_ISSUER="http://localhost:$ISSUER_PORT" \
OIDC_CLIENT_ID=test-client \
OIDC_CLIENT_SECRET=test-secret-test-secret-test-secret \
STORAGE_DIR=.data/dev-storage \
  npx nuxt dev --port "$APP_PORT"
