# Tome Reporting Guide

How to search, retrieve, and analyze log data stored in Tome. This guide is organized by task — find the section that matches what you're trying to do.

**Base URL:** `http://your-host:8420/tome`

All requests require an `X-API-Key` header. Query and export endpoints accept both `ingest` and `admin` keys. Dashboard and metrics require an `admin` key.

---

## Table of Contents

1. [Quick Stats](#quick-stats)
2. [Searching Logs](#searching-logs)
   - [By date range](#by-date-range)
   - [By severity level](#by-severity-level)
   - [By collection](#by-collection)
   - [Full-text search](#full-text-search)
   - [Exact substring match](#exact-substring-match)
   - [By metadata](#by-metadata)
   - [Combining filters](#combining-filters)
3. [Pagination](#pagination)
4. [Exporting Data](#exporting-data)
5. [Viewing Collections](#viewing-collections)
6. [Dashboard](#dashboard)
7. [Prometheus Metrics](#prometheus-metrics)
8. [Recipes](#recipes)

---

## Quick Stats

**`GET /stats`** returns a level-by-level and collection-by-collection breakdown for any time window.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO 8601 datetime | 24 hours ago | Start of the window |
| `to` | ISO 8601 datetime | Now | End of the window |

```bash
# Breakdown for the last hour
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/stats?from=2025-04-10T08:00:00Z&to=2025-04-10T09:00:00Z" | jq
```

**Response:**

```json
{
  "window": {
    "from": "2025-04-10T08:00:00.000Z",
    "to": "2025-04-10T09:00:00.000Z"
  },
  "by_level": [
    { "level": "info", "count": 4821 },
    { "level": "warn", "count": 312 },
    { "level": "error", "count": 47 }
  ],
  "by_collection": [
    { "collection": "payments-api", "count": 2100 },
    { "collection": "auth-service", "count": 1890 },
    { "collection": "notifications", "count": 1190 }
  ]
}
```

`by_collection` returns the top 50 collections by volume.

---

## Searching Logs

**`GET /records`** is the primary search endpoint. Every filter below is optional — combine them freely.

### By date range

| Parameter | Description |
|-----------|-------------|
| `from` | Records with `timestamp >= value` (when the event happened) |
| `to` | Records with `timestamp <= value` |
| `received_from` | Records with `received_at >= value` (when Tome received it) |
| `received_to` | Records with `received_at <= value` |

All values are ISO 8601 datetime strings.

```bash
# Everything between two dates
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?from=2025-04-09T00:00:00Z&to=2025-04-10T00:00:00Z" | jq
```

> **`timestamp` vs `received_at`:** Use `from`/`to` when you care about when the event occurred. Use `received_from`/`received_to` when you care about when Tome ingested the record — useful for finding records that arrived late or were backfilled.

### By severity level

Pass one or more comma-separated levels:

```bash
# All errors and fatals
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?level=error,fatal" | jq
```

Default allowed levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal` (configurable via `TOME_LOG_LEVELS`).

### By collection

Pass one or more comma-separated collection names:

```bash
# Logs from two services
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?collection=payments-api,auth-service" | jq
```

### Full-text search

The `q` parameter runs a full-text search against log messages using PostgreSQL's English-language stemming. This means searching for "failing" also matches "fail", "failed", etc.

```bash
# Search for messages about connection timeouts
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?q=connection+timeout" | jq
```

Max length: 500 characters.

### Exact substring match

The `message_contains` parameter does a case-insensitive exact substring match. Use this when hunting for UUIDs, error codes, or stack trace fragments where stemming would get in the way.

```bash
# Find a specific request ID
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?message_contains=req_8f3a2b1c" | jq

# Find a specific error code
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?message_contains=ECONNREFUSED" | jq
```

Max length: 500 characters.

### By metadata

Filter records by their JSONB metadata fields using `metadata.*` query parameters. Values are type-aware — numbers and booleans match their stored types, not just strings.

```bash
# All records for a specific user
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?metadata.user_id=usr_123" | jq

# Records with a specific HTTP status code (numeric match)
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?metadata.status_code=503" | jq

# Multiple metadata conditions (AND logic)
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?metadata.service=payments&metadata.region=us-east-1" | jq
```

This uses PostgreSQL's GIN-indexed JSONB containment operator, so metadata queries are fast even on large datasets.

### Combining filters

All filters compose with AND logic. Stack as many as you need:

```bash
# Errors in payments-api from today where the user is usr_123
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?level=error&collection=payments-api&from=2025-04-10T00:00:00Z&metadata.user_id=usr_123" | jq
```

---

## Pagination

Search results use keyset pagination, which stays fast regardless of how deep you page.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Records per page (1–1000) |
| `order` | `asc` or `desc` | `desc` | Sort direction by timestamp |
| `cursor` | string | — | Opaque cursor from a previous response |

**Response shape:**

```json
{
  "data": [ ... ],
  "next_cursor": "eyJ0cyI6IjIwMjUtMDQt..."
}
```

When `next_cursor` is `null`, there are no more results.

**Walking through pages:**

```bash
# Page 1
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?level=error&limit=50" | jq

# Page 2 — pass the cursor from page 1
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?level=error&limit=50&cursor=eyJ0cyI6IjIwMjUtMDQt..." | jq
```

---

## Exporting Data

**`GET /records/export`** streams all matching records as newline-delimited JSON (NDJSON). It accepts the same filters as `GET /records` but without pagination — every matching record is returned.

```bash
# Export all errors from payments-api this month
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records/export?collection=payments-api&level=error&from=2025-04-01T00:00:00Z" \
  > payments-errors.ndjson
```

The default sort order for export is `asc` (oldest first), which is usually what you want for analysis.

**Pipe to `jq` for post-processing:**

```bash
# Export and filter to a specific user
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records/export?collection=payments-api&level=error" \
  | jq 'select(.metadata.user_id == "usr_123")'

# Count errors per collection
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records/export?level=error&from=2025-04-09T00:00:00Z" \
  | jq -s 'group_by(.collection) | map({collection: .[0].collection, count: length})'
```

---

## Viewing Collections

**`GET /collections`** lists every collection with aggregate stats, sorted by most recently active.

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/collections" | jq
```

**Response:**

```json
{
  "data": [
    {
      "collection": "payments-api",
      "total": 184320,
      "last_record_at": "2025-04-10T08:42:11.000Z",
      "error_count": 412
    },
    {
      "collection": "auth-service",
      "total": 97210,
      "last_record_at": "2025-04-10T08:41:58.000Z",
      "error_count": 23
    }
  ]
}
```

`error_count` includes records with level `error`, `fatal`, or `critical`.

---

## Dashboard

**`GET /dashboard`** returns a comprehensive snapshot of system health. Admin key required.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `window_hours` | integer | 24 | One of: `1`, `6`, `24`, `48`, `168` (7 days) |

```bash
# Last 6 hours
curl -s -H "X-API-Key: $ADMIN_KEY" \
  "http://your-host:8420/tome/dashboard?window_hours=6" | jq
```

### What's in the response

**Volume:**

| Field | Description |
|-------|-------------|
| `volume.all_time_total` | Total records ever ingested |
| `volume.in_window_total` | Records in the selected window |
| `volume.last_1h_total` | Records in the last hour |

**Level breakdown:**

`level_breakdown_in_window` — array of `{ level, count }` for every severity level seen in the window.

**Recent errors:**

| Field | Description |
|-------|-------------|
| `last_error` | Most recent error/fatal/critical record (all-time) |
| `last_critical` | Most recent critical/fatal record (all-time) |
| `recent_critical_records` | Up to 10 critical/fatal records in the window |

**Collections in alarm:**

`collections_in_alarm` — collections that have error/fatal/critical records in the window. Each entry includes:

| Field | Description |
|-------|-------------|
| `collection` | Collection name |
| `warn_count` | Warning count in the window |
| `error_count` | Error count in the window |
| `critical_count` | Critical/fatal count in the window |
| `last_seen` | Most recent problematic record timestamp |
| `last_offending_record` | The most recent error/fatal/critical record |

**Alert system status:**

| Field | Description |
|-------|-------------|
| `alert_system.total_rules` | Total alert rules defined |
| `alert_system.enabled_rules` | Enabled rules |
| `alert_system.disabled_rules` | Disabled rules |
| `alert_system.failed_dispatches_in_window` | Failed alert sends in the window |
| `alert_system.active_keys` | Non-revoked API keys |

**Hourly sparkline:**

`hourly_activity` — one entry per hour in the window:

```json
{ "hour": "2025-04-10T08:00:00.000Z", "total": 1420, "errors": 12 }
```

Use this to chart ingestion volume and error rate over time.

---

## Prometheus Metrics

**`GET /metrics`** exposes metrics in Prometheus text format. Admin key required.

```bash
curl -s -H "X-API-Key: $ADMIN_KEY" "http://your-host:8420/tome/metrics"
```

### Available metrics

| Metric | Type | Description |
|--------|------|-------------|
| `tome_records_total{level="..."}` | counter | Records ingested by level |
| `tome_records_by_collection_total{collection="..."}` | counter | Records ingested by collection (top 50) |
| `tome_records_last_1h` | gauge | Records ingested in the last hour |
| `tome_records_last_5m` | gauge | Records ingested in the last 5 minutes |
| `tome_last_error_timestamp_seconds` | gauge | Unix timestamp of the last error/fatal/critical |
| `tome_last_critical_timestamp_seconds` | gauge | Unix timestamp of the last critical/fatal |
| `tome_alert_rules{state="enabled\|disabled"}` | gauge | Alert rule counts by state |
| `tome_alert_dispatches_total{status="..."}` | counter | Alert dispatches by status (sent, throttled, failed) |
| `tome_api_keys` | gauge | Active (non-revoked) API keys |

Point your Prometheus instance at `http://your-host:8420/tome/metrics` and configure a Grafana dashboard to visualize trends, set up alerting thresholds, or feed into your existing observability stack.

---

## Recipes

### Find all errors for a user in the last 24 hours

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?level=error,fatal,critical&from=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&metadata.user_id=usr_123" | jq
```

### Get a daily error trend for a collection

Pull the dashboard with a 7-day window and read the hourly sparkline:

```bash
curl -s -H "X-API-Key: $ADMIN_KEY" \
  "http://your-host:8420/tome/dashboard?window_hours=168" | jq '.hourly_activity'
```

### Export logs matching a metadata field to a file

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records/export?metadata.service=payments&from=2025-04-01T00:00:00Z" \
  > payments-logs.ndjson
```

Then analyze locally:

```bash
# Count by level
cat payments-logs.ndjson | jq -s 'group_by(.level) | map({level: .[0].level, count: length})'

# Find unique user IDs in error records
cat payments-logs.ndjson | jq 'select(.level == "error") | .metadata.user_id' | sort -u
```

### Check which collections are having problems right now

```bash
curl -s -H "X-API-Key: $ADMIN_KEY" \
  "http://your-host:8420/tome/dashboard?window_hours=1" | jq '.collections_in_alarm[] | {collection, error_count, critical_count}'
```

### Search for a specific error across all collections

```bash
# Full-text search (stemmed — matches variations)
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?q=database+connection+refused" | jq

# Exact substring match (literal — for codes and IDs)
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records?message_contains=ECONNREFUSED" | jq
```

### Monitor error rate with Prometheus + Grafana

1. Add a scrape target in your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "tome"
    scrape_interval: 30s
    static_configs:
      - targets: ["your-host:8420"]
    metrics_path: "/tome/metrics"
    authorization:
      credentials: "YOUR_ADMIN_KEY"
```

2. In Grafana, create panels using:
   - **Error rate:** `rate(tome_records_total{level=~"error|fatal|critical"}[5m])`
   - **Ingestion volume:** `tome_records_last_5m`
   - **Time since last error:** `time() - tome_last_error_timestamp_seconds`

### Look up a single record by ID

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://your-host:8420/tome/records/550e8400-e29b-41d4-a716-446655440000" | jq
```
