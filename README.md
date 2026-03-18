# Tome

Self-hosted log management. Ingest structured records from any application, query them, and get alerted — all on infrastructure you control.

**Stack:** Fastify · TypeScript · PostgreSQL · Docker

---

## Quick start

**Prerequisites:** Docker and Docker Compose installed. `openssl` available in your shell.

```bash
git clone https://github.com/YOUR_ORG/tome.git
cd tome
./start.sh
```

That's it. On first run `start.sh` generates a random database password and admin API key, stores them locally (gitignored), and starts the stack. Your admin key is printed to the terminal and saved to `data/admin.key`.

```
Tome is running at http://localhost:8420

Your admin API key:
  a3f7c2e1...

Health check:
  curl http://localhost:8420/healthz
```

To retrieve your admin key later:

```bash
cat data/admin.key
```

### Subsequent starts

`start.sh` is idempotent — it skips credential generation if `.env` already exists:

```bash
./start.sh          # start (or restart)
docker compose down # stop
```

---

## Configuration

No configuration is required to get started. The only values you may want to set before first run are SMTP (if you plan to use email alert rules) and log levels.

### SMTP

Edit the SMTP block in `docker-compose.yml`:

```yaml
- SMTP_HOST=smtp.sendgrid.net
- SMTP_PORT=587
- SMTP_USER=apikey
- SMTP_PASSWORD=CHANGE_ME_SMTP_PASSWORD   # ← your SendGrid API key or SMTP password
- SMTP_FROM=logs@yourdomain.com
```

SMTP is only used when an alert rule fires. The rest of the stack runs without it.

### Log levels

Tome accepts these levels by default:

```
trace, debug, info, warn, error, fatal
```

Records submitted with any other level are rejected with HTTP 400. To add platform-specific levels (e.g. `critical` for Python, `panic` for Go), set `TOME_LOG_LEVELS` in `docker-compose.yml`:

```yaml
- TOME_LOG_LEVELS=trace,debug,info,warn,error,fatal,critical,panic
```

### Port

The API is exposed on port `8420` by default. Change the left side of `"8420:3000"` in `docker-compose.yml` to use a different host port.

---

## API overview

All endpoints require `X-API-Key: <key>`. Admin endpoints require a key with `role: admin`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/records` | key | Ingest a single record |
| `POST` | `/records/batch` | key | Ingest up to 1000 records |
| `GET` | `/records` | key | Query records (filters, full-text search, keyset pagination) |
| `GET` | `/records/:id` | key | Fetch a single record |
| `GET` | `/records/export` | key | Stream all matching records as NDJSON |
| `GET` | `/collections` | key | List collections with counts |
| `GET` | `/stats` | key | Level and collection breakdown for a time window |
| `GET` | `/dashboard` | admin | Admin snapshot (volume, alarms, sparkline) |
| `GET` | `/metrics` | admin | Prometheus scrape endpoint |
| `POST` | `/keys` | admin | Create an API key |
| `GET` | `/keys` | admin | List all keys |
| `DELETE` | `/keys/:id` | admin | Revoke a key |
| `POST` | `/alerts` | admin | Create an alert rule |
| `GET` | `/alerts` | admin | List alert rules |
| `PATCH` | `/alerts/:id` | admin | Update an alert rule |
| `DELETE` | `/alerts/:id` | admin | Delete an alert rule |
| `GET` | `/alerts/:id/history` | admin | Alert firing history |
| `POST` | `/alerts/:id/test` | admin | Test-fire an alert rule |
| `GET` | `/healthz` | — | Health check (unauthenticated) |

### Query parameters — `GET /records` and `GET /records/export`

| Param | Example | Description |
|---|---|---|
| `from` / `to` | `?from=2024-01-15T00:00:00Z` | Filter by log timestamp |
| `received_from` / `received_to` | `?received_from=2024-01-15T14:00:00Z` | Filter by ingestion time |
| `collection` | `?collection=payments,auth` | Comma-separated |
| `level` | `?level=error,fatal` | Comma-separated |
| `q` | `?q=connection+refused` | Full-text search (stemmed) |
| `message_contains` | `?message_contains=ECONNREFUSED` | Exact substring match |
| `metadata.<key>` | `?metadata.service=payments&metadata.error_code=503` | JSONB field match; values are type-aware |
| `limit` | `?limit=50` | 1–1000, default 100 (`/records` only) |
| `cursor` | `?cursor=<token>` | Keyset pagination (`/records` only) |
| `order` | `?order=asc` | `asc` or `desc`, default `desc` (`asc` for export) |

### Ingest example

```bash
curl -X POST http://localhost:8420/records \
  -H "X-API-Key: $(cat data/admin.key)" \
  -H "Content-Type: application/json" \
  -d '{
    "level": "error",
    "collection": "my-app",
    "message": "Database connection failed",
    "metadata": { "host": "db01", "port": 5432 }
  }'
```

### Export example

Stream all errors from a collection during an incident window, filter locally with `jq`:

```bash
curl -sH "X-API-Key: $(cat data/admin.key)" \
  "http://localhost:8420/records/export?collection=payments&level=error&received_from=2024-01-15T14:00:00Z" \
  | jq 'select(.metadata.user_id == "u_abc123")'
```

### Create an ingest key

```bash
curl -X POST http://localhost:8420/keys \
  -H "X-API-Key: $(cat data/admin.key)" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "role": "ingest", "collection": "my-app"}'
```

The raw key is returned once in the response — store it immediately.

---

## Database backup

```bash
docker compose --profile backup run --rm backup
```

Dumps are written to `./backups/` as `tome-YYYYMMDD-HHMMSS.dump`.

To restore, run `pg_restore` through Docker (the database is not exposed directly to the host):

```bash
docker compose run --rm \
  -v ./backups:/backups \
  backup \
  pg_restore -h db -U logger -d logs /backups/tome-<timestamp>.dump
```

---

## Local development

### 1. Postgres

You need a Postgres 16 instance accessible on `localhost:5432`. Two quick options:

**Option A — spin up a standalone container (no schema init needed yet):**
```bash
docker run -d --name tome-dev-db \
  -e POSTGRES_USER=logger \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=logs \
  -p 5432:5432 \
  postgres:16-alpine
```

**Option B — reuse the Docker Compose db service** by temporarily adding a port mapping to `docker-compose.yml`:
```yaml
db:
  ports:
    - "5432:5432"
```
Then `./start.sh` (or `docker compose up -d db`) and connect with the generated password from `.env`.

### 2. Schema

Run the schema against whichever Postgres you chose:
```bash
docker exec -i tome-dev-db psql -U logger -d logs < postgres/init.sql
```

Seed your bootstrap admin key (replace with any hex string for local testing):
```bash
HASH=$(echo -n "localdevkey" | openssl dgst -sha256 | awk '{print $2}')
docker exec -i tome-dev-db psql -U logger -d logs \
  -c "INSERT INTO api_keys (key_hash, name, role) VALUES ('$HASH', 'dev-admin', 'admin');"
```

Your local admin key is then just `localdevkey`.

### 3. Run the API

```bash
cd api
npm install
npm run dev
```

`npm run dev` loads `api/.env.local` automatically via Node's `--env-file` flag. Edit that file to point `DATABASE_URL` at your Postgres instance. All other values are pre-stubbed and safe to leave as-is.

```
Tome is running at http://localhost:3000   ← note: port 3000 locally, not 8420
```

SMTP is stubbed — the server starts without it. If you want to test alert email dispatch locally, [Mailpit](https://github.com/axllent/mailpit) runs on port 1025 and matches the stub config exactly.

### 4. Build the production image locally

Swap `image:` for `build: ./api` in `docker-compose.yml`, then `./start.sh`.

---

## Releasing

Tag a commit to trigger a multi-platform build (amd64 + arm64) and push to GHCR:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow publishes `ghcr.io/YOUR_ORG/tome:1.0.0`, `1.0`, `1`, and `latest`.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
