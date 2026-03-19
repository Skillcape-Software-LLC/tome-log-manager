# Tome Integrations Guide

This guide walks through every Tome API endpoint with working examples. Whether you're connecting a new application, querying logs, managing access, or setting up alerts — start here.

**Base URL:** `http://your-host:8420`

All requests require an `X-API-Key` header.

---

## Table of Contents

1. [Authentication](#authentication)
2. [Sending Logs](#sending-logs)
   - [POST /records](#post-records)
   - [POST /records/batch](#post-recordsbatch)
   - [Integration patterns](#integration-patterns)
3. [Querying Logs](#querying-logs)
   - [GET /records](#get-records)
   - [GET /records/:id](#get-recordsid)
   - [GET /collections](#get-collections)
   - [GET /stats](#get-stats)
   - [GET /records/export](#get-recordsexport)
4. [Managing API Keys](#managing-api-keys)
   - [POST /keys](#post-keys)
   - [GET /keys](#get-keys)
   - [DELETE /keys/:id](#delete-keysid)
5. [Alert Rules](#alert-rules)
   - [POST /alerts](#post-alerts)
   - [GET /alerts](#get-alerts)
   - [GET /alerts/:id](#get-alertsid)
   - [PATCH /alerts/:id](#patch-alertsid)
   - [DELETE /alerts/:id](#delete-alertsid)
   - [GET /alerts/:id/history](#get-alertsidhistory)
   - [POST /alerts/:id/test](#post-alertsidtest)
6. [Dashboard](#dashboard)
7. [Prometheus Metrics](#prometheus-metrics)
8. [Error Reference](#error-reference)

---

## Authentication

Every request must include an `X-API-Key` header containing the raw 32-byte hex key issued by Tome.

```bash
curl -H "X-API-Key: YOUR_KEY_HERE" http://your-host:8420/collections
```

### Key roles

| Role | What it can do |
|------|----------------|
| `ingest` | POST records, GET records, GET collections, GET stats, GET export |
| `admin` | Everything above, plus key management, alert rules, dashboard, and metrics |

Your first admin key is printed once by `./start.sh` (Docker) or `bash postgres/seed.sh` (manual). Store it securely — it cannot be recovered from the database.

### Collection lock

An API key can be locked to a specific collection. When locked, every record posted with that key must use the same collection name. Posting a different collection returns `400`.

This is useful for isolating per-service keys so a misbehaving service can't pollute another service's collection.

### Project name second factor

An API key can have a `project_name` set (stored internally in lowercase). When set, every ingest request must include a `project_name` field whose value matches (case-insensitive). Mismatches return `401`.

Use this for multi-tenant environments where multiple applications share a Tome instance and you want to prevent cross-tenant writes even if a key is compromised.

### Key lifecycle

- `last_used` is updated at most once per 60 seconds per key — no write amplification on high-traffic keys.
- Revocation is a soft delete. A revoked key is immediately rejected (`401`) but its record is kept for audit purposes.

---

## Sending Logs

### POST /records

Ingest a single log record.

**Required role:** `ingest` or `admin`

#### Request body

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `level` | string | Yes | Must be in `TOME_LOG_LEVELS` (default: `trace,debug,info,warn,error,fatal`); case-insensitive |
| `collection` | string | Yes | 1–255 characters; must match key's collection lock if one is set |
| `message` | string | Yes | 1–10,000 characters |
| `timestamp` | string (ISO 8601) | No | Defaults to server receive time if omitted |
| `project_name` | string | No | Required if the key has a `project_name` second factor set; 0–255 characters |
| `metadata` | object | No | Any JSON object; serialized size must not exceed 32 KB |

#### Example — curl

```bash
curl -s -X POST http://your-host:8420/records \
  -H "X-API-Key: YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "level": "error",
    "collection": "payments-api",
    "message": "Charge failed: card declined",
    "metadata": {
      "user_id": "usr_123",
      "amount": 4999,
      "currency": "usd",
      "card_last4": "4242"
    }
  }'
```

#### Example — JavaScript (fetch)

```js
await fetch('http://your-host:8420/records', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.TOME_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    level: 'error',
    collection: 'payments-api',
    message: 'Charge failed: card declined',
    metadata: {
      user_id: 'usr_123',
      amount: 4999,
      currency: 'usd',
    },
  }),
});
```

#### Response — `201 Created`

```json
{
  "status": "ok",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

> Alert rules are evaluated asynchronously after the response is sent — ingestion is never delayed by alert processing.

---

### POST /records/batch

Ingest up to 1,000 records in a single atomic transaction. All records are committed together or not at all.

**Required role:** `ingest` or `admin`

#### Request body

An array of record objects (same schema as [POST /records](#post-records)).

```bash
curl -s -X POST http://your-host:8420/records/batch \
  -H "X-API-Key: YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "level": "info",
      "collection": "worker",
      "message": "Job started",
      "metadata": { "job_id": "job_001" }
    },
    {
      "level": "info",
      "collection": "worker",
      "message": "Job completed",
      "metadata": { "job_id": "job_001", "duration_ms": 412 }
    },
    {
      "level": "warn",
      "collection": "worker",
      "message": "Job retried",
      "metadata": { "job_id": "job_002", "attempt": 2 }
    }
  ]'
```

#### Response — `201 Created`

```json
{
  "status": "ok",
  "count": 3
}
```

**Limits and validation:**
- Maximum 1,000 records per request; exceeding this returns `400`.
- Each record is validated individually; the first validation failure is returned.

---

### Integration patterns

**One key per service, locked to its collection**

Create a dedicated ingest key for each service and set `collection` to that service's name. The key cannot accidentally write to another collection, and revoking it only affects that one service.

```bash
# Create a locked ingest key for the payments service
curl -s -X POST http://your-host:8420/keys \
  -H "X-API-Key: ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "payments-api prod", "role": "ingest", "collection": "payments-api"}'
```

**Buffer and batch for high-volume services**

Accumulate records in memory for up to a few seconds, then flush with `/records/batch`. This reduces HTTP overhead and keeps Postgres write amplification low. Example: collect up to 500 records or flush every 2 seconds, whichever comes first.

**Use `timestamp` for replaying historical data**

When importing logs from another system or replaying events, supply the original event time in the `timestamp` field. Tome stores both `timestamp` (event time) and `received_at` (ingest time) independently.

---

## Querying Logs

### GET /records

Retrieve log records with optional filters. Returns paginated results.

**Required role:** `ingest` or `admin`

#### Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO 8601 string | — | Filter records where `timestamp >=` this value |
| `to` | ISO 8601 string | — | Filter records where `timestamp <=` this value |
| `received_from` | ISO 8601 string | — | Filter by `received_at >=` (ingest time) |
| `received_to` | ISO 8601 string | — | Filter by `received_at <=` (ingest time) |
| `collection` | string | — | One or more collection names, comma-separated; matched with OR logic |
| `level` | string | — | One or more levels, comma-separated; matched with OR logic |
| `q` | string (≤ 500 chars) | — | Full-text search on `message` using English stemming |
| `message_contains` | string (≤ 500 chars) | — | Case-insensitive exact substring match on `message` |
| `metadata.*` | any | — | JSONB containment filter; see [metadata filtering](#metadata-filtering) below |
| `limit` | integer 1–1000 | `100` | Number of records per page |
| `cursor` | base64 string | — | Pagination cursor from previous response |
| `order` | `asc` \| `desc` | `desc` | Sort direction by timestamp |

#### Basic example

```bash
# Last 50 errors in the payments-api collection
curl -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "collection=payments-api" \
  --data-urlencode "level=error,fatal" \
  --data-urlencode "limit=50"
```

#### Date-windowed example

```bash
# Records from a specific hour
curl -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "from=2025-03-01T14:00:00Z" \
  --data-urlencode "to=2025-03-01T15:00:00Z" \
  --data-urlencode "order=asc"
```

#### Metadata filtering

Prefix any metadata key with `metadata.` to filter by that field. Values are JSON-parsed, so numbers and booleans match their types correctly.

```bash
# Records where metadata.status_code is 500
curl -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "metadata.status_code=500"

# Multiple metadata filters (AND logic)
curl -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "metadata.service=payments" \
  --data-urlencode "metadata.retried=true"
```

#### Full-text vs. substring search

- **`q`** — uses PostgreSQL full-text search with English stemming. The query `"failed charge"` will also match "charging failure" because both stem to the same root. Best for exploratory or keyword searches.
- **`message_contains`** — case-insensitive literal substring match. Use this when you need to find an exact string like an error code or a UUID.

```bash
# Full-text search
curl -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "q=payment declined"

# Exact substring
curl -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "message_contains=STRIPE_ERR_4029"
```

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "timestamp": "2025-03-01T14:32:11.000Z",
      "received_at": "2025-03-01T14:32:11.123Z",
      "level": "error",
      "collection": "payments-api",
      "message": "Charge failed: card declined",
      "metadata": {
        "user_id": "usr_123",
        "amount": 4999
      }
    }
  ],
  "next_cursor": "eyJ0cyI6IjIwMjUtMDMtMDFUMTQ6MzI6MTEuMDAwWiIsImlkIjoiYTFiMmMzZDQifQ=="
}
```

`next_cursor` is `null` when there are no more results.

#### Pagination walkthrough

Tome uses keyset pagination — each page's `next_cursor` encodes the `(timestamp, id)` of the last record returned. Pass it as `cursor` to get the next page. This scales to millions of records without degrading performance.

```bash
# Page 1
RESPONSE=$(curl -s -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "collection=payments-api" \
  --data-urlencode "limit=100")

CURSOR=$(echo "$RESPONSE" | jq -r '.next_cursor')

# Page 2
curl -s -G "http://your-host:8420/records" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "collection=payments-api" \
  --data-urlencode "limit=100" \
  --data-urlencode "cursor=$CURSOR"
```

Continue until `next_cursor` is `null`.

---

### GET /records/:id

Retrieve a single record by its UUID.

**Required role:** `ingest` or `admin`

```bash
curl http://your-host:8420/records/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "X-API-Key: YOUR_KEY"
```

Returns the record object or `404` if not found.

---

### GET /collections

List all collections with summary statistics.

**Required role:** `ingest` or `admin`

```bash
curl http://your-host:8420/collections \
  -H "X-API-Key: YOUR_KEY"
```

#### Response — `200 OK`

```json
{
  "data": [
    {
      "collection": "payments-api",
      "total": 48291,
      "last_record_at": "2025-03-19T09:14:02.000Z",
      "error_count": 142
    },
    {
      "collection": "worker",
      "total": 12003,
      "last_record_at": "2025-03-19T09:13:58.000Z",
      "error_count": 0
    }
  ]
}
```

`error_count` is the number of records with level `error`, `fatal`, or `critical`. Results are sorted by `last_record_at` descending.

---

### GET /stats

Aggregated volume breakdown by level and collection for a time window.

**Required role:** `ingest` or `admin`

#### Query parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `from` | 24 hours ago | Window start (ISO 8601) |
| `to` | now | Window end (ISO 8601) |

```bash
# Last 6 hours
curl -G "http://your-host:8420/stats" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "from=$(date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
```

#### Response — `200 OK`

```json
{
  "window": {
    "from": "2025-03-19T03:00:00.000Z",
    "to": "2025-03-19T09:00:00.000Z"
  },
  "by_level": [
    { "level": "info",  "count": 9823 },
    { "level": "warn",  "count": 341  },
    { "level": "error", "count": 87   }
  ],
  "by_collection": [
    { "collection": "payments-api", "count": 5422 },
    { "collection": "worker",       "count": 4829 }
  ]
}
```

`by_collection` is limited to the top 50 by count.

---

### GET /records/export

Stream all matching records as newline-delimited JSON (NDJSON). Useful for bulk exports, piping into `jq`, or loading into external analysis tools.

**Required role:** `ingest` or `admin`

Accepts the same filter parameters as [GET /records](#get-records), except `limit`, `cursor`, and `order` (export is always ascending by default).

**Content-Type:** `application/x-ndjson`

Each line of the response is a complete JSON record object.

#### Examples

```bash
# Export all errors from the past week to a file
curl -G "http://your-host:8420/records/export" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "level=error,fatal" \
  --data-urlencode "from=2025-03-12T00:00:00Z" \
  > errors-this-week.ndjson

# Pipe into jq to extract specific fields
curl -sG "http://your-host:8420/records/export" \
  -H "X-API-Key: YOUR_KEY" \
  --data-urlencode "collection=payments-api" \
  --data-urlencode "level=error" \
  | jq -r '[.timestamp, .level, .message] | @tsv'

# Count records by level from a stream
curl -sG "http://your-host:8420/records/export" \
  -H "X-API-Key: YOUR_KEY" \
  | jq -r '.level' | sort | uniq -c
```

Records are streamed in 100-row batches from Postgres. Disconnecting mid-stream is handled gracefully.

---

## Managing API Keys

All key management endpoints require an **admin** key.

### POST /keys

Create a new API key.

#### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable label; 1–255 characters |
| `role` | `"ingest"` \| `"admin"` | Yes | Key role |
| `collection` | string | No | Lock this key to a single collection |
| `project_name` | string | No | Require a matching `project_name` field on every ingest request |

```bash
# Create a collection-locked ingest key
curl -s -X POST http://your-host:8420/keys \
  -H "X-API-Key: ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "payments-api production",
    "role": "ingest",
    "collection": "payments-api"
  }'
```

#### Response — `201 Created`

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
  "name": "payments-api production",
  "role": "ingest",
  "collection": "payments-api",
  "project_name": null,
  "created_at": "2025-03-19T09:00:00.000Z",
  "key": "a3f8c2e1d9b47560f1e83a2c4d6b8e90f7c2a1d4b3e8f9c0a2d5b7e1f4c8a3d6"
}
```

> The `key` field contains the raw 32-byte hex key. **It is only shown once.** Copy it immediately — it cannot be retrieved again. Only its SHA-256 hash is stored.

---

### GET /keys

List all API keys. This includes revoked keys.

```bash
curl http://your-host:8420/keys \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
      "name": "payments-api production",
      "role": "ingest",
      "collection": "payments-api",
      "project_name": null,
      "created_at": "2025-03-19T09:00:00.000Z",
      "last_used": "2025-03-19T09:14:01.000Z",
      "revoked": false
    }
  ]
}
```

`project_name` is always shown as `"***"` if set — it is never disclosed after key creation. Use `last_used` to audit which keys are actively being used.

---

### DELETE /keys/:id

Revoke an API key. The key is rejected immediately on all subsequent requests. The record is retained for audit purposes.

```bash
curl -s -X DELETE http://your-host:8420/keys/b2c3d4e5-f6a7-8901-bcde-f23456789012 \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response — `200 OK`

```json
{
  "status": "revoked",
  "id": "b2c3d4e5-f6a7-8901-bcde-f23456789012"
}
```

Returns `404` if the key doesn't exist or is already revoked.

---

## Alert Rules

Alert rules fire email notifications when ingested records match specified criteria. Rules are evaluated fire-and-forget on every record ingest, with a per-rule cooldown to prevent notification floods.

All alert endpoints require an **admin** key.

### POST /alerts

Create a new alert rule.

#### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable rule name; 1–255 characters |
| `action_type` | string | Yes | Currently only `"email"` is supported |
| `action_config` | object | Yes | Delivery configuration (see below) |
| `enabled` | boolean | No | Default `true` |
| `match_collections` | string[] | No | Fire only if record's collection is in this list (OR logic) |
| `match_levels` | string[] | No | Fire only if record's level is in this list (OR logic) |
| `match_message` | string | No | Fire only if record's message contains this substring (case-insensitive) |
| `match_metadata` | object | No | Fire only if record's metadata contains all of these key/value pairs (AND logic) |
| `cooldown_seconds` | integer | No | Minimum seconds between firings for this rule; default `300` |

**`action_config` for `email` type:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string[] | Yes | Recipient email addresses |
| `subject_template` | string | Yes | Email subject line with `{variable}` placeholders |
| `body_template` | string | Yes | Email body with `{variable}` placeholders |

**Template variables available in subject and body:**

| Variable | Value |
|----------|-------|
| `{rule_name}` | Name of the alert rule |
| `{level}` | Log level of the triggering record |
| `{collection}` | Collection of the triggering record |
| `{message}` | Message of the triggering record |
| `{timestamp}` | ISO 8601 timestamp of the triggering record |
| `{metadata}` | Pretty-printed JSON of the record's metadata |
| `{record_id}` | UUID of the triggering record |

#### Matching logic

Multiple `match_*` fields are combined with AND logic — all specified conditions must be satisfied for the rule to fire. Within `match_collections` and `match_levels`, the values are OR-ed (any match is sufficient).

Example: a rule with `match_collections: ["api", "worker"]` and `match_levels: ["error", "fatal"]` fires only when the collection is `api` OR `worker` AND the level is `error` OR `fatal`.

#### Example — alert on errors in a specific collection

```bash
curl -s -X POST http://your-host:8420/alerts \
  -H "X-API-Key: ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Payments API errors",
    "match_collections": ["payments-api"],
    "match_levels": ["error", "fatal"],
    "action_type": "email",
    "action_config": {
      "to": ["oncall@example.com"],
      "subject_template": "[{level}] {collection}: {message}",
      "body_template": "Alert: {rule_name}\n\nTime: {timestamp}\nCollection: {collection}\nLevel: {level}\n\nMessage:\n{message}\n\nMetadata:\n{metadata}\n\nRecord ID: {record_id}"
    },
    "cooldown_seconds": 300
  }'
```

#### Example — alert when specific metadata matches

```bash
curl -s -X POST http://your-host:8420/alerts \
  -H "X-API-Key: ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Payment gateway timeout",
    "match_metadata": { "error_code": "GATEWAY_TIMEOUT" },
    "action_type": "email",
    "action_config": {
      "to": ["payments-team@example.com"],
      "subject_template": "Gateway timeout detected in {collection}",
      "body_template": "A gateway timeout was logged at {timestamp}.\n\n{message}\n\nMetadata:\n{metadata}"
    },
    "cooldown_seconds": 60
  }'
```

#### Response — `201 Created`

Returns the full alert rule object (same schema as [GET /alerts/:id](#get-alertsid)).

> Alert rules are cached for 30 seconds. New rules and updates take effect within that window.

---

### GET /alerts

List all alert rules, sorted by creation date (newest first).

```bash
curl http://your-host:8420/alerts \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-345678901234",
      "name": "Payments API errors",
      "enabled": true,
      "match_collections": ["payments-api"],
      "match_levels": ["error", "fatal"],
      "match_message": null,
      "match_metadata": null,
      "action_type": "email",
      "action_config": {
        "to": ["oncall@example.com"],
        "subject_template": "[{level}] {collection}: {message}",
        "body_template": "Alert: {rule_name}\n\nTime: {timestamp}\n..."
      },
      "cooldown_seconds": 300,
      "created_at": "2025-03-19T09:00:00.000Z",
      "last_fired": "2025-03-19T09:01:45.000Z"
    }
  ]
}
```

---

### GET /alerts/:id

Retrieve a single alert rule by UUID.

```bash
curl http://your-host:8420/alerts/c3d4e5f6-a7b8-9012-cdef-345678901234 \
  -H "X-API-Key: ADMIN_KEY"
```

Returns the rule object or `404` if not found.

---

### PATCH /alerts/:id

Partially update an alert rule. Supply only the fields you want to change. At least one field is required.

```bash
# Temporarily disable a rule
curl -s -X PATCH \
  http://your-host:8420/alerts/c3d4e5f6-a7b8-9012-cdef-345678901234 \
  -H "X-API-Key: ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Update recipients and cooldown
curl -s -X PATCH \
  http://your-host:8420/alerts/c3d4e5f6-a7b8-9012-cdef-345678901234 \
  -H "X-API-Key: ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action_config": {
      "to": ["oncall@example.com", "backup@example.com"],
      "subject_template": "[{level}] {collection}: {message}",
      "body_template": "Alert: {rule_name}\n\nTime: {timestamp}\n..."
    },
    "cooldown_seconds": 600
  }'
```

Returns the updated rule object or `404`.

---

### DELETE /alerts/:id

Delete an alert rule permanently.

```bash
curl -s -X DELETE \
  http://your-host:8420/alerts/c3d4e5f6-a7b8-9012-cdef-345678901234 \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response — `200 OK`

```json
{
  "status": "deleted",
  "id": "c3d4e5f6-a7b8-9012-cdef-345678901234"
}
```

---

### GET /alerts/:id/history

View the dispatch history for an alert rule — when it fired, what triggered it, and whether the email was sent, throttled by the cooldown, or failed.

#### Query parameters

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `limit` | `100` | `500` | Number of history entries to return |

```bash
curl "http://your-host:8420/alerts/c3d4e5f6-a7b8-9012-cdef-345678901234/history?limit=20" \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "d4e5f6a7-b8c9-0123-defa-456789012345",
      "record_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "fired_at": "2025-03-19T09:01:45.000Z",
      "status": "sent",
      "error": null,
      "level": "error",
      "collection": "payments-api",
      "message": "Charge failed: card declined",
      "timestamp": "2025-03-19T09:01:44.000Z"
    },
    {
      "id": "e5f6a7b8-c9d0-1234-efab-567890123456",
      "record_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
      "fired_at": "2025-03-19T09:02:01.000Z",
      "status": "throttled",
      "error": null,
      "level": "error",
      "collection": "payments-api",
      "message": "Charge failed: insufficient funds",
      "timestamp": "2025-03-19T09:02:00.000Z"
    }
  ]
}
```

| Status | Meaning |
|--------|---------|
| `sent` | Email delivered successfully |
| `throttled` | Cooldown was active; no email sent |
| `failed` | Delivery attempted but SMTP error occurred; see `error` field |

---

### POST /alerts/:id/test

Send a test email for a rule using a synthetic record. Use this to confirm SMTP configuration and preview the rendered subject/body before the rule goes live.

```bash
curl -s -X POST \
  http://your-host:8420/alerts/c3d4e5f6-a7b8-9012-cdef-345678901234/test \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response

```json
{ "status": "sent" }
```

On failure:

```json
{
  "status": "failed",
  "error": "connect ECONNREFUSED 127.0.0.1:587"
}
```

This does not create an entry in alert history and does not update `last_fired`.

---

## Dashboard

A single endpoint returning a multi-window analytics snapshot for admin dashboards and health monitoring.

**Required role:** `admin`

### GET /dashboard

#### Query parameters

| Parameter | Allowed values | Default |
|-----------|---------------|---------|
| `window_hours` | `1`, `6`, `24`, `48`, `168` | `24` |

```bash
curl "http://your-host:8420/dashboard?window_hours=24" \
  -H "X-API-Key: ADMIN_KEY"
```

#### Response — `200 OK`

```json
{
  "generated_at": "2025-03-19T09:15:00.000Z",
  "window_hours": 24,
  "volume": {
    "all_time_total": 1482931,
    "in_window_total": 58210,
    "last_1h_total": 2341
  },
  "level_breakdown_in_window": [
    { "level": "info",  "count": 52000 },
    { "level": "warn",  "count": 4800  },
    { "level": "error", "count": 1350  },
    { "level": "fatal", "count": 60    }
  ],
  "last_error": {
    "id": "a1b2c3d4-...",
    "timestamp": "2025-03-19T09:14:58.000Z",
    "level": "error",
    "collection": "payments-api",
    "message": "Charge failed: card declined",
    "metadata": {}
  },
  "last_critical": null,
  "collections_in_alarm": [
    {
      "collection": "payments-api",
      "warn_count": 241,
      "error_count": 88,
      "critical_count": 0,
      "last_seen": "2025-03-19T09:14:58.000Z",
      "last_offending_record": { "id": "a1b2c3d4-...", "..." : "..." }
    }
  ],
  "recent_critical_records": [],
  "alert_system": {
    "total_rules": 3,
    "enabled_rules": 2,
    "disabled_rules": 1,
    "failed_dispatches_in_window": 0,
    "active_keys": 5
  },
  "hourly_activity": [
    { "hour": "2025-03-18T09:00:00.000Z", "total": 2100, "errors": 12 },
    { "hour": "2025-03-18T10:00:00.000Z", "total": 2340, "errors": 9 }
  ]
}
```

#### Field reference

| Field | Notes |
|-------|-------|
| `volume.all_time_total` | Total records ever ingested |
| `volume.in_window_total` | Records in the selected window |
| `volume.last_1h_total` | Records in the last 60 minutes (always, regardless of window) |
| `level_breakdown_in_window` | Count per level within the window; sorted by count descending |
| `last_error` | Most recent record with level `error`, `fatal`, or `critical` — **all-time**, not scoped to window |
| `last_critical` | Most recent record with level `critical` or `fatal` — **all-time** |
| `collections_in_alarm` | Collections with at least one `error`, `fatal`, or `critical` record in the window |
| `recent_critical_records` | Up to 10 `critical`/`fatal` records from within the window |
| `alert_system.failed_dispatches_in_window` | Count of `status = 'failed'` alert_history rows within the window |
| `hourly_activity` | One row per hour in the window; use for sparkline/time-series charts |

---

## Prometheus Metrics

Exposes all key counters and gauges in Prometheus text format. Suitable for scraping with Prometheus or compatible agents.

**Required role:** `admin`

### GET /metrics

```bash
curl http://your-host:8420/metrics \
  -H "X-API-Key: ADMIN_KEY"
```

#### Available metrics

```
# HELP tome_records_total Total records ingested by level
# TYPE tome_records_total counter
tome_records_total{level="info"} 52000
tome_records_total{level="warn"} 4800
tome_records_total{level="error"} 1350
tome_records_total{level="fatal"} 60

# HELP tome_records_by_collection_total Total records ingested by collection
# TYPE tome_records_by_collection_total counter
tome_records_by_collection_total{collection="payments-api"} 38000
tome_records_by_collection_total{collection="worker"} 20210
# (top 50 collections only)

# HELP tome_records_last_1h Records ingested in the last 1 hour
# TYPE tome_records_last_1h gauge
tome_records_last_1h 2341

# HELP tome_records_last_5m Records ingested in the last 5 minutes
# TYPE tome_records_last_5m gauge
tome_records_last_5m 192

# HELP tome_last_error_timestamp_seconds Unix timestamp of the last error/fatal/critical record
# TYPE tome_last_error_timestamp_seconds gauge
tome_last_error_timestamp_seconds 1742374498

# HELP tome_last_critical_timestamp_seconds Unix timestamp of the last critical/fatal record
# TYPE tome_last_critical_timestamp_seconds gauge
tome_last_critical_timestamp_seconds 0

# HELP tome_alert_rules Number of alert rules
# TYPE tome_alert_rules gauge
tome_alert_rules{state="enabled"} 2
tome_alert_rules{state="disabled"} 1

# HELP tome_alert_dispatches_total Alert dispatches by status
# TYPE tome_alert_dispatches_total counter
tome_alert_dispatches_total{status="sent"} 847
tome_alert_dispatches_total{status="throttled"} 203
tome_alert_dispatches_total{status="failed"} 4

# HELP tome_api_keys Number of active (non-revoked) API keys
# TYPE tome_api_keys gauge
tome_api_keys 5
```

- Counters (`_total`) accumulate over the lifetime of the database.
- Gauges are point-in-time.
- `tome_last_*_timestamp_seconds` is `0` if no matching records exist.
- `tome_records_by_collection_total` is limited to the top 50 collections by total count.

#### Prometheus scrape configuration

```yaml
scrape_configs:
  - job_name: tome
    static_configs:
      - targets: ["your-host:8420"]
    authorization:
      credentials: YOUR_ADMIN_KEY_HERE
    metrics_path: /metrics
```

Or with a Bearer token header:

```yaml
scrape_configs:
  - job_name: tome
    static_configs:
      - targets: ["your-host:8420"]
    params: {}
    relabel_configs: []
    metric_relabel_configs: []
    static_configs:
      - targets: ["your-host:8420"]
    http_sd_configs: []
    authorization:
      type: Bearer
      credentials: YOUR_ADMIN_KEY_HERE
    metrics_path: /metrics
```

Note: Prometheus does not natively support `X-API-Key` headers. Use the `authorization` field (which sends `Authorization: Bearer YOUR_KEY`). Tome accepts either `X-API-Key` or `Authorization: Bearer` headers.

> **Check first:** Verify your Tome version supports `Authorization: Bearer` before relying on this. If not, use a metrics proxy or the [prometheus-pushgateway](https://github.com/prometheus/pushgateway) pattern to forward metrics.

---

## Error Reference

| Status | Cause |
|--------|-------|
| `400 Bad Request` | Validation error — check the response body for detail. Common causes: invalid `level`, metadata object exceeding 32 KB, batch array exceeding 1,000 records, collection mismatch with key lock, missing required fields, no fields provided for PATCH. |
| `401 Unauthorized` | Missing or invalid `X-API-Key` header, revoked key, or `project_name` second factor mismatch. |
| `403 Forbidden` | Valid key but insufficient role. For example, an `ingest` key attempting to call `/keys` or `/alerts`. |
| `404 Not Found` | Resource does not exist, or (for DELETE /keys) the key is already revoked. |
| `500 Internal Server Error` | Server-side error such as a database connection failure or SMTP error. Check server logs. |

All error responses include a JSON body:

```json
{
  "error": "Human-readable description of the problem"
}
```
