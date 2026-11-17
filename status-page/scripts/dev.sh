#!/bin/sh
# The status page on this machine, with hot reload: `npm run dev:local`.
# Signed in as "Dev" (group admins) through the app template's fake identity
# provider; the reconciler is a stand-in with sample data
# (scripts/fake-reconciler.mjs). Nothing here talks to a real server.
set -eu
cd "$(dirname "$0")/.."
ISSUER_PORT=${DEV_ISSUER_PORT:-4011}
API_PORT=${DEV_API_PORT:-4012}
APP_PORT=${DEV_APP_PORT:-3000}
TOKEN=dev-token-not-a-secret

npm run layers >/dev/null
FAKE_ISSUER_PORT=$ISSUER_PORT APP_PORT=$APP_PORT node ../app-template/test/e2e/fake-issuer.mjs &
ISSUER_PID=$!
BIVOUAC_API_TOKEN=$TOKEN FAKE_RECONCILER_PORT=$API_PORT node scripts/fake-reconciler.mjs &
API_PID=$!
trap 'kill $ISSUER_PID $API_PID 2>/dev/null' EXIT INT TERM
until curl -fs "http://localhost:$ISSUER_PORT/jwks" >/dev/null 2>&1; do sleep 0.2; done
curl -fsG "http://localhost:$ISSUER_PORT/test/next-user" \
  --data-urlencode sub=dev --data-urlencode name=Dev --data-urlencode "groups=admins" >/dev/null

PORT=$APP_PORT \
OIDC_ISSUER="http://localhost:$ISSUER_PORT" \
OIDC_CLIENT_ID=test-client \
OIDC_CLIENT_SECRET=test-secret-test-secret-test-secret \
BIVOUAC_API_URL="http://localhost:$API_PORT" \
BIVOUAC_API_TOKEN=$TOKEN \
BIVOUAC_STATUS_GROUPS=admins \
  npx nuxt dev --port "$APP_PORT"
