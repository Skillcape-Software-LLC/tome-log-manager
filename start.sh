#!/usr/bin/env bash
set -euo pipefail

# ── First-run credential generation ──────────────────────────────────────────
if [ ! -f .env ]; then
  echo "First run — generating credentials..."

  # Require openssl
  if ! command -v openssl &>/dev/null; then
    echo "ERROR: openssl is required but not found. Please install it and re-run."
    exit 1
  fi

  DB_PASSWORD=$(openssl rand -hex 32)
  ADMIN_KEY=$(openssl rand -hex 32)
  ADMIN_KEY_HASH=$(echo -n "$ADMIN_KEY" | openssl dgst -sha256 | sed 's/^.*= //')

  if [ -z "$ADMIN_KEY_HASH" ]; then
    echo "ERROR: Failed to compute SHA-256 hash of admin key."
    exit 1
  fi

  cat > .env <<EOF
DB_PASSWORD=${DB_PASSWORD}
ADMIN_KEY_HASH=${ADMIN_KEY_HASH}
EOF

  mkdir -p data/postgres
  echo "$ADMIN_KEY" > data/admin.key
  chmod 600 data/admin.key

  echo "  Credentials written to .env (gitignored)"
  echo "  Admin API key saved to data/admin.key (gitignored)"
  echo ""
fi

# ── Validate .env ─────────────────────────────────────────────────────────────
source .env
if [ -z "${DB_PASSWORD:-}" ] || [ -z "${ADMIN_KEY_HASH:-}" ]; then
  echo "ERROR: .env is missing required variables (DB_PASSWORD, ADMIN_KEY_HASH)."
  echo "       Delete .env and re-run start.sh to regenerate credentials."
  exit 1
fi

# ── Start ─────────────────────────────────────────────────────────────────────
docker compose up -d

echo ""
echo "Tome is running at http://localhost:8420"
echo ""
echo "Your admin API key:"
echo "  $(cat data/admin.key)"
echo ""
echo "Health check:"
echo "  curl http://localhost:8420/healthz"
