#!/usr/bin/env bash
# Starts a throwaway Garage (S3-compatible) for the app template's storage
# tests, and prints the TEST_S3_* variables they read (D72). CI only.
set -euo pipefail

name=bivouac-test-garage
config="$(mktemp)"
cat > "$config" <<EOF
metadata_dir = "/tmp/meta"
data_dir = "/tmp/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
EOF
chmod 644 "$config"

docker run -d --name "$name" -p 127.0.0.1:3900:3900 -v "$config:/etc/garage.toml:ro" dxflrs/garage:v2.5.0 >/dev/null
garage() { docker exec "$name" /garage "$@"; }

for _ in $(seq 1 30); do
  if garage status >/dev/null 2>&1; then break; fi
  sleep 1
done

node_id="$(garage status | awk '/^[0-9a-f]{16}/ { print $1; exit }')"
garage layout assign -z dc1 -c 1G "$node_id" >/dev/null
garage layout apply --version 1 >/dev/null
garage bucket create test >/dev/null
key="$(garage key create test-key)"
garage bucket allow --read --write --owner test --key test-key >/dev/null

echo "TEST_S3_BUCKET=test"
echo "TEST_S3_ENDPOINT=http://localhost:3900"
echo "TEST_S3_ACCESS_KEY_ID=$(awk '/^Key ID/ { print $NF }' <<<"$key")"
echo "TEST_S3_SECRET_ACCESS_KEY=$(awk '/^Secret key/ { print $NF }' <<<"$key")"
