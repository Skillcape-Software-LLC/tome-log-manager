#!/usr/bin/env bash
# Runs via docker-entrypoint-initdb.d after 01-schema.sql.
# ADMIN_KEY_HASH is injected as an environment variable by docker-compose.
set -e

if [ -z "${ADMIN_KEY_HASH:-}" ]; then
  echo "WARN: ADMIN_KEY_HASH not set — skipping bootstrap admin key seed"
  exit 0
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname   "$POSTGRES_DB" \
  -v admin_key_hash="$ADMIN_KEY_HASH" \
  -c "INSERT INTO api_keys (key_hash, name, role)
      SELECT :'admin_key_hash', 'bootstrap-admin', 'admin'
      WHERE NOT EXISTS (
        SELECT 1 FROM api_keys WHERE role = 'admin' AND revoked = FALSE
      );"

echo "Bootstrap admin key seeded."
