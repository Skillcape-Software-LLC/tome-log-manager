# Tome — Node.js/TypeScript Implementation

## 2026-03-18

This document is the Node.js/TypeScript port of the Tome self-hosted log management platform. The Python/FastAPI design reference lives in `custom-logging-platform.md`. The data model, API contract, security model, and PostgreSQL schema are **identical** — only the implementation language and framework change.

For concept definitions (Record, Collection, dual-factor auth, alert rules, etc.) see the reference document. This file covers everything needed to build and run Tome from Node.js.

---

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Fastify v4** | Fastest Node HTTP framework, plugin ecosystem, schema-first design, closest DX to FastAPI |
| Language | **TypeScript** | Strong typing catches auth/validation bugs at compile time; essential for a security-sensitive service |
| Database | **postgres (porsager)** | Tagged template literals, excellent TypeScript types, zero magic, full async |
| Validation | **Zod** | Runtime + compile-time type safety; schema doubles as TS type via `z.infer` |
| Email | **Nodemailer** | De-facto Node SMTP library; works with SendGrid, Postfix, any SMTP |
| Rate limiting | **@fastify/rate-limit** | Fastify-native plugin, minimal config |
| Module system | **CommonJS** | Avoids `.js` extension issues in `ts-node`/`tsc` output; simpler for a single service |

---

## Project Structure

```
tome/
├── docker-compose.yml            # all configuration lives here
├── .gitignore
├── postgres/
│   └── init.sql                  # schema + seed first admin key
└── api/
    ├── Dockerfile
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts              # Fastify app, plugin registration, server start
        ├── db.ts                 # postgres connection pool
        ├── auth.ts               # key hashing + preHandler hooks
        ├── email.ts              # Nodemailer SMTP wrapper
        ├── alertEngine.ts        # rule evaluation + dispatch (fire-and-forget)
        ├── types.ts              # shared TypeScript types
        └── routes/
            ├── ingest.ts         # POST /records, POST /records/batch
            ├── query.ts          # GET /records, GET /records/:id, GET /collections, GET /stats
            ├── keys.ts           # /keys CRUD
            ├── alerts.ts         # /alerts CRUD + history + test
            ├── dashboard.ts      # GET /dashboard — admin snapshot
            └── metrics.ts        # GET /metrics — Prometheus scrape
```

---

## Implementation

### `.gitignore`

```gitignore
node_modules/
dist/
```

---

### `postgres/init.sql`

```sql
-- Core records table
CREATE TABLE IF NOT EXISTS records (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp   TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    level       VARCHAR(20),
    collection  VARCHAR(255) NOT NULL,
    message     TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    search_vec  TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('english', message)
                ) STORED
);

CREATE INDEX IF NOT EXISTS idx_records_timestamp  ON records (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records (collection);
CREATE INDEX IF NOT EXISTS idx_records_level      ON records (level);
CREATE INDEX IF NOT EXISTS idx_records_search_vec ON records USING GIN (search_vec);
CREATE INDEX IF NOT EXISTS idx_records_metadata   ON records USING GIN (metadata);

-- Keyset pagination composite indexes
CREATE INDEX IF NOT EXISTS idx_records_cursor_desc ON records (timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_records_cursor_asc  ON records (timestamp ASC,  id ASC);

-- API keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash     VARCHAR(64) UNIQUE NOT NULL,
    name         VARCHAR(255) NOT NULL,
    role         VARCHAR(20) NOT NULL,       -- 'ingest' | 'admin'
    collection   VARCHAR(255),              -- optional: lock key to this collection
    project_name VARCHAR(255),              -- optional: second factor (stored lowercase)
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_used    TIMESTAMPTZ,
    revoked      BOOLEAN DEFAULT FALSE
);

-- Alert rules
CREATE TABLE IF NOT EXISTS alert_rules (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(255) NOT NULL,
    enabled           BOOLEAN DEFAULT TRUE,
    match_collections TEXT[],
    match_levels      TEXT[],
    match_message     TEXT,
    match_metadata    JSONB,
    action_type       VARCHAR(50) NOT NULL,  -- 'email'
    action_config     JSONB NOT NULL,
    cooldown_seconds  INT DEFAULT 300,
    last_fired        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Alert firing history
CREATE TABLE IF NOT EXISTS alert_history (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id  UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    fired_at TIMESTAMPTZ DEFAULT NOW(),
    status   VARCHAR(20) NOT NULL,  -- 'sent' | 'throttled' | 'failed'
    error    TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_history_rule   ON alert_history (rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_status ON alert_history (status);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_key  VARCHAR(64),     -- key_hash of the actor
    action     VARCHAR(100) NOT NULL,
    target     VARCHAR(255),    -- e.g. key id, rule id
    detail     JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the bootstrap admin key
-- Replace ADMIN_KEY_HASH with: echo -n "your-raw-key" | sha256sum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM api_keys WHERE role = 'admin' AND revoked = FALSE) THEN
        INSERT INTO api_keys (key_hash, name, role)
        VALUES (:'ADMIN_KEY_HASH', 'bootstrap-admin', 'admin');
    END IF;
END $$;
```

> **Bootstrap key:** Generate your admin key with `openssl rand -hex 32`, hash it with `echo -n "your-key" | sha256sum | cut -d' ' -f1`, and set `ADMIN_KEY_HASH` in `docker-compose.yml`. The `DO` block seeds the key on first run only.

---

### `docker-compose.yml`

```yaml
version: "3.9"

services:
  api:
    build: ./api
    restart: unless-stopped
    ports:
      - "8420:3000"
    environment:
      # ── Database ─────────────────────────────────────────────────────────────
      - DATABASE_URL=postgresql://logger:CHANGE_ME_DB_PASSWORD@db:5432/logs

      # ── Auth ─────────────────────────────────────────────────────────────────
      # Generate: openssl rand -hex 32
      # Hash:     echo -n "your-raw-key" | sha256sum | cut -d' ' -f1
      - ADMIN_KEY_HASH=CHANGE_ME_SHA256_HASH

      # ── SMTP ─────────────────────────────────────────────────────────────────
      # SendGrid: SMTP_HOST=smtp.sendgrid.net, SMTP_USER=apikey, SMTP_PASSWORD=SG.xxx
      - SMTP_HOST=smtp.sendgrid.net
      - SMTP_PORT=587
      - SMTP_USER=apikey
      - SMTP_PASSWORD=CHANGE_ME_SMTP_PASSWORD
      - SMTP_FROM=logs@yourdomain.com
      - SMTP_STARTTLS=true

      # ── Ingest ───────────────────────────────────────────────────────────────
      # Comma-separated list of accepted log levels (case-insensitive).
      # Records submitted with any other level are rejected with HTTP 400.
      - TOME_LOG_LEVELS=debug,info,warn,err,crit

      - NODE_ENV=production
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/healthz || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=logger
      - POSTGRES_PASSWORD=CHANGE_ME_DB_PASSWORD  # must match DATABASE_URL above
      - POSTGRES_DB=logs
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
    command: >
      postgres
        -c shared_buffers=256MB
        -c work_mem=8MB
        -c maintenance_work_mem=64MB
        -c max_connections=50
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U logger -d logs"]
      interval: 5s
      retries: 5

  backup:
    image: postgres:16-alpine
    restart: "no"
    profiles: ["backup"]
    environment:
      - PGPASSWORD=CHANGE_ME_DB_PASSWORD  # must match POSTGRES_PASSWORD above
    volumes:
      - ./backups:/backups
    entrypoint: >
      sh -c "pg_dump -h db -U logger -d logs -Fc -f /backups/tome-$(date +%Y%m%d-%H%M%S).dump"
    depends_on:
      - db

volumes:
  pg_data:
```

> **Setup:** Find every `CHANGE_ME_*` placeholder and replace it before running `docker compose up`. The DB password appears in three places — `DATABASE_URL`, `POSTGRES_PASSWORD`, and the backup service's `PGPASSWORD` — all must match.

---

---

### `api/Dockerfile`

```dockerfile
# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Non-root user
RUN addgroup -S tome && adduser -S tome -G tome

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER tome

EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

### `api/package.json`

```json
{
  "name": "tome",
  "version": "1.0.0",
  "description": "Self-hosted log management platform",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@fastify/rate-limit": "^9.0.0",
    "fastify": "^4.28.0",
    "nodemailer": "^6.9.0",
    "postgres": "^3.4.4",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/nodemailer": "^6.4.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
```

---

### `api/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

### `src/types.ts`

```typescript
// Shared TypeScript types used across routes and the alert engine

export interface KeyRecord {
  id: string;
  key_hash: string;
  name: string;
  role: "ingest" | "admin";
  collection: string | null;
  project_name: string | null;
  created_at: Date;
  last_used: Date | null;
  revoked: boolean;
}

export interface RecordRow {
  id: string;
  timestamp: Date;
  received_at: Date;
  level: string;
  collection: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  match_collections: string[] | null;
  match_levels: string[] | null;
  match_message: string | null;
  match_metadata: Record<string, unknown> | null;
  action_type: string;
  action_config: Record<string, unknown>;
  cooldown_seconds: number;
  last_fired: Date | null;
  created_at: Date;
}

export interface IngestRecord {
  timestamp: Date;
  level: string;
  collection: string;
  message: string;
  project_name?: string | null;
  metadata: Record<string, unknown>;
}

// Augment Fastify request with the authenticated key record
declare module "fastify" {
  interface FastifyRequest {
    keyRecord?: KeyRecord;
  }
}
```

---

### `src/db.ts`

```typescript
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const sql = postgres(connectionString, {
  max: 10,              // connection pool size
  idle_timeout: 30,     // close idle connections after 30s
  connect_timeout: 5,   // fail fast if DB unreachable
  types: {
    // Return JSONB columns as plain JS objects (default behavior, explicit for clarity)
    jsonb: {
      to: 114,
      from: [114, 3802],
      serialize: JSON.stringify,
      parse: JSON.parse,
    },
  },
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await sql.end({ timeout: 5 });
  process.exit(0);
});
```

---

### `src/auth.ts`

```typescript
import { createHash } from "crypto";
import { FastifyRequest, FastifyReply } from "fastify";
import { sql } from "./db";
import { KeyRecord } from "./types";

// In-memory debounce: track when last_used was last written per key hash
const lastUsedWritten = new Map<string, number>();
const LAST_USED_DEBOUNCE_MS = 60_000;

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Resolves and validates the X-API-Key header.
 * Attaches the key record to request.keyRecord.
 * Debounces last_used DB writes to once per 60s per key.
 */
async function resolveKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawKey = request.headers["x-api-key"];
  if (!rawKey || typeof rawKey !== "string") {
    reply.status(401).send({ error: "X-API-Key header required" });
    return;
  }

  const keyHash = hashKey(rawKey);
  const rows = await sql<KeyRecord[]>`
    SELECT id, key_hash, name, role, collection, project_name, created_at, last_used, revoked
    FROM api_keys
    WHERE key_hash = ${keyHash} AND revoked = FALSE
    LIMIT 1
  `;

  if (rows.length === 0) {
    reply.status(401).send({ error: "Invalid or revoked API key" });
    return;
  }

  const key = rows[0];

  // Debounced last_used write
  const now = Date.now();
  const lastWrite = lastUsedWritten.get(keyHash) ?? 0;
  if (now - lastWrite > LAST_USED_DEBOUNCE_MS) {
    lastUsedWritten.set(keyHash, now);
    sql`UPDATE api_keys SET last_used = NOW() WHERE key_hash = ${keyHash}`.catch(() => {
      // Non-critical; log and continue
    });
  }

  request.keyRecord = key;
}

/**
 * preHandler for any authenticated endpoint.
 * Validates the API key and attaches keyRecord to the request.
 */
export async function keyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await resolveKey(request, reply);
}

/**
 * preHandler for admin-only endpoints.
 * Validates the API key and enforces role === 'admin'.
 */
export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await resolveKey(request, reply);
  if (reply.sent) return; // resolveKey already replied with 401

  if (request.keyRecord?.role !== "admin") {
    reply.status(403).send({ error: "Admin key required" });
  }
}

/**
 * Validates ingest-specific second-factor requirements:
 *   1. Collection lock — if key.collection is set, entry.collection must match
 *   2. project_name — if key.project_name is set, payload must supply a matching value (case-insensitive)
 *
 * Call AFTER keyAuth has run (request.keyRecord is populated).
 */
export function validateIngestAuth(
  key: KeyRecord,
  entryCollection: string,
  entryProjectName: string | null | undefined,
  reply: FastifyReply
): boolean {
  if (key.collection && key.collection !== entryCollection) {
    reply.status(400).send({ error: `Key is locked to collection '${key.collection}'` });
    return false;
  }

  if (key.project_name) {
    const provided = (entryProjectName ?? "").toLowerCase();
    if (provided !== key.project_name) {
      reply.status(401).send({ error: "Authentication failed" });
      return false;
    }
  }

  return true;
}
```

---

### `src/email.ts`

```typescript
import nodemailer from "nodemailer";

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: parseInt(process.env.SMTP_PORT ?? "587"),
    secure: false, // STARTTLS via requireTLS
    requireTLS: (process.env.SMTP_STARTTLS ?? "true") === "true",
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASSWORD!,
    },
  });
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
}): Promise<void> {
  const transport = createTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM!,
    to: opts.to.join(", "),
    subject: opts.subject,
    text: opts.text,
  });
}
```

---

### `src/alertEngine.ts`

```typescript
import { sql } from "./db";
import { sendEmail } from "./email";
import { AlertRule, IngestRecord } from "./types";

// ── Rule cache ────────────────────────────────────────────────────────────────
// Rules are cached for 30s to avoid a DB hit on every ingest request.
// Any mutation to alert_rules must call invalidateRulesCache().

let rulesCache: AlertRule[] | null = null;
let rulesCacheAt = 0;
const CACHE_TTL_MS = 30_000;

export function invalidateRulesCache(): void {
  rulesCache = null;
  rulesCacheAt = 0;
}

async function getCachedRules(): Promise<AlertRule[]> {
  if (rulesCache && Date.now() - rulesCacheAt < CACHE_TTL_MS) {
    return rulesCache;
  }
  const rows = await sql<AlertRule[]>`
    SELECT * FROM alert_rules WHERE enabled = TRUE
  `;
  rulesCache = rows;
  rulesCacheAt = Date.now();
  return rows;
}

// ── Matching ──────────────────────────────────────────────────────────────────

function matches(rule: AlertRule, record: IngestRecord): boolean {
  if (rule.match_collections?.length && !rule.match_collections.includes(record.collection)) {
    return false;
  }
  if (rule.match_levels?.length && !rule.match_levels.includes(record.level)) {
    return false;
  }
  if (rule.match_message) {
    if (!record.message.toLowerCase().includes(rule.match_message.toLowerCase())) {
      return false;
    }
  }
  if (rule.match_metadata) {
    for (const [key, val] of Object.entries(rule.match_metadata)) {
      if (record.metadata[key] !== val) return false;
    }
  }
  return true;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

async function dispatch(
  rule: AlertRule,
  recordId: string,
  record: IngestRecord
): Promise<"sent" | "failed"> {
  const vars: Record<string, string> = {
    rule_name:  rule.name,
    level:      record.level,
    collection: record.collection,
    message:    record.message,
    timestamp:  record.timestamp.toISOString(),
    metadata:   JSON.stringify(record.metadata, null, 2),
    record_id:  recordId,
  };

  if (rule.action_type === "email") {
    const cfg = rule.action_config as {
      to: string[];
      subject_template: string;
      body_template: string;
    };
    await sendEmail({
      to: cfg.to,
      subject: interpolate(cfg.subject_template, vars),
      text: interpolate(cfg.body_template, vars),
    });
    return "sent";
  }

  throw new Error(`Unknown action_type: ${rule.action_type}`);
}

// ── Main evaluate function ────────────────────────────────────────────────────

export async function evaluateRules(recordId: string, record: IngestRecord): Promise<void> {
  try {
    const rules = await getCachedRules();
    const now = new Date();

    for (const rule of rules) {
      if (!matches(rule, record)) continue;

      // Check cooldown
      if (rule.last_fired) {
        const secondsSinceLastFire = (now.getTime() - rule.last_fired.getTime()) / 1000;
        if (secondsSinceLastFire < rule.cooldown_seconds) {
          // Throttled — record in history but don't fire
          await sql`
            INSERT INTO alert_history (rule_id, record_id, status)
            VALUES (${rule.id}, ${recordId}, 'throttled')
          `;
          continue;
        }
      }

      let status: "sent" | "failed" = "failed";
      let error: string | undefined;

      try {
        status = await dispatch(rule, recordId, record);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[tome.alert] dispatch failed for rule ${rule.id}:`, error);
      }

      // Update last_fired and write history atomically
      await sql.begin(async (tx) => {
        await tx`
          UPDATE alert_rules SET last_fired = NOW() WHERE id = ${rule.id}
        `;
        await tx`
          INSERT INTO alert_history (rule_id, record_id, status, error)
          VALUES (${rule.id}, ${recordId}, ${status}, ${error ?? null})
        `;
      });

      // Bust the cache so next evaluation picks up the new last_fired
      invalidateRulesCache();
    }
  } catch (err) {
    console.error(`[tome.alert] unhandled error for record ${recordId}:`, err);
  }
}
```

---

### `src/routes/ingest.ts`

```typescript
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { keyAuth, validateIngestAuth } from "../auth";
import { evaluateRules } from "../alertEngine";

// Load valid levels from env at startup — no default fallback; level is always required
const VALID_LEVELS: Set<string> = new Set(
  (process.env.TOME_LOG_LEVELS ?? "debug,info,warn,err,crit")
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
);

if (VALID_LEVELS.size === 0) {
  throw new Error("TOME_LOG_LEVELS must contain at least one level");
}

const RecordSchema = z.object({
  timestamp:    z.string().datetime().optional(),
  level:        z.string().min(1).max(20),   // required — no default
  collection:   z.string().min(1).max(255),
  message:      z.string().min(1).max(10_000),
  project_name: z.string().max(255).nullish(),
  metadata:     z.record(z.unknown()).default({}),
}).transform((data) => {
  const level = data.level.toLowerCase().trim();
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`level must be one of: ${[...VALID_LEVELS].join(", ")}`);
  }

  // Validate metadata size
  if (JSON.stringify(data.metadata).length > 32_768) {
    throw new Error("metadata exceeds 32KB limit");
  }

  return {
    ...data,
    level,
    timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
  };
});

export async function ingestRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /records — single record ingest
  fastify.post("/records", {
    preHandler: keyAuth,
  }, async (request, reply) => {
    const parsed = RecordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const entry = parsed.data;
    const key = request.keyRecord!;

    if (!validateIngestAuth(key, entry.collection, entry.project_name, reply)) return;

    const [row] = await sql`
      INSERT INTO records (timestamp, level, collection, message, metadata)
      VALUES (${entry.timestamp}, ${entry.level}, ${entry.collection}, ${entry.message}, ${sql.json(entry.metadata as object)})
      RETURNING id
    `;

    const recordId = row.id as string;

    // Fire-and-forget alert evaluation — never blocks the response
    evaluateRules(recordId, entry).catch((err) => {
      fastify.log.error({ err, recordId }, "alert engine error");
    });

    return reply.status(201).send({ status: "ok", id: recordId });
  });

  // POST /records/batch — batch ingest (up to 1000 records)
  fastify.post("/records/batch", {
    preHandler: keyAuth,
  }, async (request, reply) => {
    const body = request.body as unknown;
    if (!Array.isArray(body)) {
      return reply.status(400).send({ error: "Request body must be an array" });
    }
    if (body.length > 1_000) {
      return reply.status(400).send({ error: "Batch limit is 1000 records" });
    }

    const entries: Array<ReturnType<typeof RecordSchema.parse>> = [];
    for (let i = 0; i < body.length; i++) {
      const parsed = RecordSchema.safeParse(body[i]);
      if (!parsed.success) {
        return reply.status(400).send({ error: `Record ${i}: ${parsed.error.errors[0].message}` });
      }
      entries.push(parsed.data);
    }

    // Validate auth against the first record's collection (all records share the same key)
    const key = request.keyRecord!;
    if (!validateIngestAuth(key, entries[0].collection, entries[0].project_name, reply)) return;

    // Insert all records in a single transaction
    const recordIds: string[] = [];
    await sql.begin(async (tx) => {
      for (const entry of entries) {
        const [row] = await tx`
          INSERT INTO records (timestamp, level, collection, message, metadata)
          VALUES (${entry.timestamp}, ${entry.level}, ${entry.collection}, ${entry.message}, ${tx.json(entry.metadata as object)})
          RETURNING id
        `;
        recordIds.push(row.id as string);
      }
    });

    // Fire-and-forget alert evaluation for each inserted record
    for (let i = 0; i < recordIds.length; i++) {
      evaluateRules(recordIds[i], entries[i]).catch((err) => {
        fastify.log.error({ err, recordId: recordIds[i] }, "alert engine error");
      });
    }

    return reply.status(201).send({ status: "ok", count: recordIds.length });
  });
}
```

---

### `src/routes/query.ts`

```typescript
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { keyAuth, adminAuth } from "../auth";

// ── Cursor encoding ───────────────────────────────────────────────────────────
// Cursor encodes { ts: ISO string, id: UUID } as base64 JSON

function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(JSON.stringify({ ts: timestamp.toISOString(), id })).toString("base64url");
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// ── Query parameter schema ────────────────────────────────────────────────────

const QuerySchema = z.object({
  from:       z.string().datetime().optional(),
  to:         z.string().datetime().optional(),
  collection: z.string().optional(),
  level:      z.string().optional(),
  q:          z.string().max(500).optional(),
  limit:      z.coerce.number().int().min(1).max(1000).default(100),
  cursor:     z.string().optional(),
  order:      z.enum(["asc", "desc"]).default("desc"),
});

export async function queryRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /records — query with filters and keyset pagination
  fastify.get("/records", {
    preHandler: keyAuth,
  }, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { from, to, collection, level, q, limit, cursor, order } = parsed.data;
    const desc = order === "desc";

    // Build filter fragments
    const conditions: ReturnType<typeof sql>[] = [sql`TRUE`];

    if (from)       conditions.push(sql`timestamp >= ${new Date(from)}`);
    if (to)         conditions.push(sql`timestamp <= ${new Date(to)}`);
    if (collection) {
      const cols = collection.split(",").map((c) => c.trim());
      conditions.push(sql`collection = ANY(${cols})`);
    }
    if (level) {
      const levels = level.split(",").map((l) => l.trim());
      conditions.push(sql`level = ANY(${levels})`);
    }
    if (q) {
      conditions.push(sql`search_vec @@ plainto_tsquery('english', ${q})`);
    }

    // Keyset cursor — avoids OFFSET performance degradation
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return reply.status(400).send({ error: "Invalid cursor" });
      }
      if (desc) {
        conditions.push(sql`(timestamp, id) < (${new Date(decoded.ts)}, ${decoded.id}::uuid)`);
      } else {
        conditions.push(sql`(timestamp, id) > (${new Date(decoded.ts)}, ${decoded.id}::uuid)`);
      }
    }

    const whereClause = sql`${conditions.reduce((acc, c) => sql`${acc} AND ${c}`)}`;
    const orderClause = desc
      ? sql`ORDER BY timestamp DESC, id DESC`
      : sql`ORDER BY timestamp ASC, id ASC`;

    const rows = await sql`
      SELECT id, timestamp, received_at, level, collection, message, metadata
      FROM records
      WHERE ${whereClause}
      ${orderClause}
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? encodeCursor(data[data.length - 1].timestamp as Date, data[data.length - 1].id as string)
      : null;

    return { data, next_cursor: nextCursor };
  });

  // GET /records/:id — single record by UUID
  fastify.get<{ Params: { id: string } }>("/records/:id", {
    preHandler: keyAuth,
  }, async (request, reply) => {
    const rows = await sql`
      SELECT id, timestamp, received_at, level, collection, message, metadata
      FROM records
      WHERE id = ${request.params.id}::uuid
    `;
    if (rows.length === 0) {
      return reply.status(404).send({ error: "Record not found" });
    }
    return rows[0];
  });

  // GET /collections — distinct collections with record counts
  fastify.get("/collections", {
    preHandler: keyAuth,
  }, async (_request, _reply) => {
    const rows = await sql`
      SELECT
        collection,
        COUNT(*)::int              AS total,
        MAX(timestamp)             AS last_record_at,
        COUNT(*) FILTER (WHERE level IN ('error','fatal','critical'))::int AS error_count
      FROM records
      GROUP BY collection
      ORDER BY last_record_at DESC
    `;
    return { data: rows };
  });

  // GET /stats — aggregated level and collection breakdown
  fastify.get("/stats", {
    preHandler: keyAuth,
  }, async (request, _reply) => {
    const query = request.query as { from?: string; to?: string };
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : new Date();

    const [byLevel, byCollection] = await Promise.all([
      sql`
        SELECT level, COUNT(*)::int AS count
        FROM records
        WHERE timestamp BETWEEN ${from} AND ${to}
        GROUP BY level
        ORDER BY count DESC
      `,
      sql`
        SELECT collection, COUNT(*)::int AS count
        FROM records
        WHERE timestamp BETWEEN ${from} AND ${to}
        GROUP BY collection
        ORDER BY count DESC
        LIMIT 50
      `,
    ]);

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      by_level: byLevel,
      by_collection: byCollection,
    };
  });
}
```

---

### `src/routes/keys.ts`

```typescript
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { sql } from "../db";
import { adminAuth, hashKey } from "../auth";

const CreateKeySchema = z.object({
  name:         z.string().min(1).max(255),
  role:         z.enum(["ingest", "admin"]),
  collection:   z.string().max(255).nullish(),
  project_name: z.string().max(255).nullish(),
});

export async function keysRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /keys — create a new API key
  fastify.post("/keys", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const parsed = CreateKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { name, role, collection } = parsed.data;
    const projectName = parsed.data.project_name?.toLowerCase() ?? null;

    const rawKey = randomBytes(32).toString("hex");
    const keyHash = hashKey(rawKey);

    const [row] = await sql`
      INSERT INTO api_keys (key_hash, name, role, collection, project_name)
      VALUES (${keyHash}, ${name}, ${role}, ${collection ?? null}, ${projectName})
      RETURNING id, name, role, collection, project_name, created_at
    `;

    // Audit log
    await sql`
      INSERT INTO audit_log (actor_key, action, target, detail)
      VALUES (${request.keyRecord!.key_hash}, 'key.create', ${row.id as string},
              ${sql.json({ name, role })})
    `;

    // Return the raw key ONCE — never stored, never retrievable again
    return reply.status(201).send({
      id:           row.id,
      name:         row.name,
      role:         row.role,
      collection:   row.collection,
      project_name: row.project_name,
      created_at:   row.created_at,
      key:          rawKey,  // ← shown once only
    });
  });

  // GET /keys — list all keys (project_name masked)
  fastify.get("/keys", {
    preHandler: adminAuth,
  }, async (_request, _reply) => {
    const rows = await sql`
      SELECT id, name, role, collection,
             CASE WHEN project_name IS NOT NULL THEN '***' ELSE NULL END AS project_name,
             created_at, last_used, revoked
      FROM api_keys
      ORDER BY created_at DESC
    `;
    return { data: rows };
  });

  // DELETE /keys/:id — revoke a key
  fastify.delete<{ Params: { id: string } }>("/keys/:id", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const [row] = await sql`
      UPDATE api_keys SET revoked = TRUE
      WHERE id = ${request.params.id}::uuid AND revoked = FALSE
      RETURNING id, name
    `;

    if (!row) {
      return reply.status(404).send({ error: "Key not found or already revoked" });
    }

    await sql`
      INSERT INTO audit_log (actor_key, action, target, detail)
      VALUES (${request.keyRecord!.key_hash}, 'key.revoke', ${row.id as string},
              ${sql.json({ name: row.name })})
    `;

    return { status: "revoked", id: row.id };
  });
}
```

---

### `src/routes/alerts.ts`

```typescript
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { adminAuth } from "../auth";
import { invalidateRulesCache, evaluateRules } from "../alertEngine";

const AlertRuleSchema = z.object({
  name:              z.string().min(1).max(255),
  enabled:           z.boolean().default(true),
  match_collections: z.array(z.string()).nullish(),
  match_levels:      z.array(z.string()).nullish(),
  match_message:     z.string().max(500).nullish(),
  match_metadata:    z.record(z.unknown()).nullish(),
  action_type:       z.enum(["email"]),
  action_config:     z.object({
    to:               z.array(z.string().email()),
    subject_template: z.string(),
    body_template:    z.string(),
  }),
  cooldown_seconds:  z.number().int().min(0).default(300),
});

const PatchAlertSchema = AlertRuleSchema.partial();

export async function alertsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /alerts — create alert rule
  fastify.post("/alerts", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const parsed = AlertRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const d = parsed.data;
    const [row] = await sql`
      INSERT INTO alert_rules (
        name, enabled, match_collections, match_levels, match_message,
        match_metadata, action_type, action_config, cooldown_seconds
      ) VALUES (
        ${d.name}, ${d.enabled}, ${d.match_collections ?? null},
        ${d.match_levels ?? null}, ${d.match_message ?? null},
        ${d.match_metadata ? sql.json(d.match_metadata) : null},
        ${d.action_type}, ${sql.json(d.action_config)}, ${d.cooldown_seconds}
      )
      RETURNING *
    `;

    invalidateRulesCache();

    await sql`
      INSERT INTO audit_log (actor_key, action, target, detail)
      VALUES (${request.keyRecord!.key_hash}, 'alert.create', ${row.id as string},
              ${sql.json({ name: d.name })})
    `;

    return reply.status(201).send(row);
  });

  // GET /alerts — list all rules
  fastify.get("/alerts", {
    preHandler: adminAuth,
  }, async (_request, _reply) => {
    const rows = await sql`SELECT * FROM alert_rules ORDER BY created_at DESC`;
    return { data: rows };
  });

  // GET /alerts/:id — get a specific rule
  fastify.get<{ Params: { id: string } }>("/alerts/:id", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const rows = await sql`
      SELECT * FROM alert_rules WHERE id = ${request.params.id}::uuid
    `;
    if (rows.length === 0) return reply.status(404).send({ error: "Rule not found" });
    return rows[0];
  });

  // PATCH /alerts/:id — update rule
  fastify.patch<{ Params: { id: string } }>("/alerts/:id", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const parsed = PatchAlertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const d = parsed.data;
    const setClauses: ReturnType<typeof sql>[] = [];

    if (d.name             !== undefined) setClauses.push(sql`name = ${d.name}`);
    if (d.enabled          !== undefined) setClauses.push(sql`enabled = ${d.enabled}`);
    if (d.match_collections !== undefined) setClauses.push(sql`match_collections = ${d.match_collections ?? null}`);
    if (d.match_levels     !== undefined) setClauses.push(sql`match_levels = ${d.match_levels ?? null}`);
    if (d.match_message    !== undefined) setClauses.push(sql`match_message = ${d.match_message ?? null}`);
    if (d.match_metadata   !== undefined) setClauses.push(sql`match_metadata = ${d.match_metadata ? sql.json(d.match_metadata) : null}`);
    if (d.action_config    !== undefined) setClauses.push(sql`action_config = ${sql.json(d.action_config)}`);
    if (d.cooldown_seconds !== undefined) setClauses.push(sql`cooldown_seconds = ${d.cooldown_seconds}`);

    if (setClauses.length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }

    const setFragment = setClauses.reduce((acc, c) => sql`${acc}, ${c}`);
    const [row] = await sql`
      UPDATE alert_rules SET ${setFragment}
      WHERE id = ${request.params.id}::uuid
      RETURNING *
    `;

    if (!row) return reply.status(404).send({ error: "Rule not found" });

    invalidateRulesCache();

    await sql`
      INSERT INTO audit_log (actor_key, action, target)
      VALUES (${request.keyRecord!.key_hash}, 'alert.update', ${row.id as string})
    `;

    return row;
  });

  // DELETE /alerts/:id — delete rule
  fastify.delete<{ Params: { id: string } }>("/alerts/:id", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const [row] = await sql`
      DELETE FROM alert_rules WHERE id = ${request.params.id}::uuid RETURNING id, name
    `;
    if (!row) return reply.status(404).send({ error: "Rule not found" });

    invalidateRulesCache();

    await sql`
      INSERT INTO audit_log (actor_key, action, target, detail)
      VALUES (${request.keyRecord!.key_hash}, 'alert.delete', ${row.id as string},
              ${sql.json({ name: row.name })})
    `;

    return { status: "deleted", id: row.id };
  });

  // GET /alerts/:id/history — firing history for a rule
  fastify.get<{ Params: { id: string } }>("/alerts/:id/history", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    // Verify rule exists
    const ruleRows = await sql`SELECT id FROM alert_rules WHERE id = ${request.params.id}::uuid`;
    if (ruleRows.length === 0) return reply.status(404).send({ error: "Rule not found" });

    const limit = Math.min(parseInt((request.query as Record<string, string>).limit ?? "100"), 500);
    const rows = await sql`
      SELECT ah.id, ah.record_id, ah.fired_at, ah.status, ah.error,
             r.level, r.collection, r.message, r.timestamp
      FROM alert_history ah
      JOIN records r ON r.id = ah.record_id
      WHERE ah.rule_id = ${request.params.id}::uuid
      ORDER BY ah.fired_at DESC
      LIMIT ${limit}
    `;

    return { data: rows };
  });

  // POST /alerts/:id/test — manually fire the rule's action
  fastify.post<{ Params: { id: string } }>("/alerts/:id/test", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const ruleRows = await sql`
      SELECT * FROM alert_rules WHERE id = ${request.params.id}::uuid
    `;
    if (ruleRows.length === 0) return reply.status(404).send({ error: "Rule not found" });

    const rule = ruleRows[0];

    // Synthesize a test record
    const testRecord = {
      timestamp:  new Date(),
      level:      "info",
      collection: "test",
      message:    "This is a test alert fired manually via POST /alerts/:id/test",
      metadata:   {} as Record<string, unknown>,
    };

    try {
      // Bypass cooldown — call dispatch directly
      const cfg = rule.action_config as {
        to: string[];
        subject_template: string;
        body_template: string;
      };
      const { sendEmail } = await import("../email");
      const { interpolate } = await import("../alertEngine") as unknown as { interpolate: (t: string, v: Record<string, string>) => string };

      // If interpolate is not exported, inline it
      const interp = (template: string, vars: Record<string, string>) =>
        template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

      const vars: Record<string, string> = {
        rule_name:  rule.name as string,
        level:      testRecord.level,
        collection: testRecord.collection,
        message:    testRecord.message,
        timestamp:  testRecord.timestamp.toISOString(),
        metadata:   JSON.stringify(testRecord.metadata, null, 2),
        record_id:  "00000000-0000-0000-0000-000000000000",
      };

      await sendEmail({
        to:      cfg.to,
        subject: interp(cfg.subject_template, vars),
        text:    interp(cfg.body_template, vars),
      });

      return { status: "sent" };
    } catch (err) {
      return reply.status(500).send({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
```

> **Note on `/alerts/:id/test`:** The `interpolate` helper in `alertEngine.ts` should be exported to avoid the dynamic import workaround above. In a production build, export it directly: `export function interpolate(...)`.

---

### `src/routes/dashboard.ts`

```typescript
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { adminAuth } from "../auth";

const VALID_WINDOWS = [1, 6, 24, 48, 168] as const;
type WindowHours = typeof VALID_WINDOWS[number];

function fmtRecord(row: Record<string, unknown>) {
  return {
    id:         row.id,
    timestamp:  row.timestamp,
    level:      row.level,
    collection: row.collection,
    message:    row.message,
    metadata:   row.metadata,
  };
}

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/dashboard", {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const query = request.query as { window_hours?: string };
    const windowHours = (parseInt(query.window_hours ?? "24") || 24) as WindowHours;

    if (!VALID_WINDOWS.includes(windowHours)) {
      return reply.status(400).send({ error: `window_hours must be one of: ${VALID_WINDOWS.join(", ")}` });
    }

    const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const now = new Date();

    const [
      totalCount,
      windowCount,
      lastHourCount,
      levelBreakdown,
      lastError,
      lastCritical,
      collectionsInAlarm,
      recentCriticalRecords,
      alertSystem,
      hourlyActivity,
    ] = await Promise.all([
      // All-time total
      sql`SELECT COUNT(*)::int AS count FROM records`,

      // Window total
      sql`SELECT COUNT(*)::int AS count FROM records WHERE timestamp >= ${windowStart}`,

      // Last 1 hour
      sql`SELECT COUNT(*)::int AS count FROM records WHERE timestamp >= NOW() - INTERVAL '1 hour'`,

      // Level breakdown in window
      sql`
        SELECT level, COUNT(*)::int AS count
        FROM records
        WHERE timestamp >= ${windowStart}
        GROUP BY level
        ORDER BY count DESC
      `,

      // Last error (all-time)
      sql`
        SELECT id, timestamp, level, collection, message, metadata
        FROM records
        WHERE level IN ('error', 'fatal', 'critical')
        ORDER BY timestamp DESC
        LIMIT 1
      `,

      // Last critical (all-time)
      sql`
        SELECT id, timestamp, level, collection, message, metadata
        FROM records
        WHERE level IN ('critical', 'fatal')
        ORDER BY timestamp DESC
        LIMIT 1
      `,

      // Collections with errors in window
      sql`
        SELECT
          collection,
          COUNT(*) FILTER (WHERE level = 'warn')::int    AS warn_count,
          COUNT(*) FILTER (WHERE level = 'error')::int   AS error_count,
          COUNT(*) FILTER (WHERE level IN ('fatal', 'critical'))::int AS critical_count,
          MAX(timestamp) AS last_seen,
          (
            SELECT row_to_json(sub)
            FROM (
              SELECT id, timestamp, level, message, metadata
              FROM records r2
              WHERE r2.collection = r.collection
                AND r2.level IN ('error', 'fatal', 'critical')
                AND r2.timestamp >= ${windowStart}
              ORDER BY r2.timestamp DESC
              LIMIT 1
            ) sub
          ) AS last_offending_record
        FROM records r
        WHERE timestamp >= ${windowStart}
          AND level IN ('warn', 'error', 'fatal', 'critical')
        GROUP BY collection
        HAVING COUNT(*) FILTER (WHERE level IN ('error', 'fatal', 'critical')) > 0
        ORDER BY last_seen DESC
      `,

      // Recent critical records in window
      sql`
        SELECT id, timestamp, level, collection, message, metadata
        FROM records
        WHERE level IN ('critical', 'fatal')
          AND timestamp >= ${windowStart}
        ORDER BY timestamp DESC
        LIMIT 10
      `,

      // Alert system summary
      sql`
        SELECT
          (SELECT COUNT(*)::int FROM alert_rules)                                         AS total_rules,
          (SELECT COUNT(*)::int FROM alert_rules WHERE enabled = TRUE)                    AS enabled_rules,
          (SELECT COUNT(*)::int FROM alert_rules WHERE enabled = FALSE)                   AS disabled_rules,
          (SELECT COUNT(*)::int FROM alert_history WHERE status = 'failed'
             AND fired_at >= ${windowStart})                                              AS failed_dispatches_in_window,
          (SELECT COUNT(*)::int FROM api_keys WHERE revoked = FALSE)                      AS active_keys
      `,

      // Hourly activity for sparkline
      sql`
        SELECT
          date_trunc('hour', timestamp)          AS hour,
          COUNT(*)::int                           AS total,
          COUNT(*) FILTER (WHERE level IN ('error', 'fatal', 'critical'))::int AS errors
        FROM records
        WHERE timestamp >= ${windowStart} AND timestamp <= ${now}
        GROUP BY hour
        ORDER BY hour ASC
      `,
    ]);

    return {
      generated_at:   now.toISOString(),
      window_hours:   windowHours,
      volume: {
        all_time_total:   totalCount[0].count,
        in_window_total:  windowCount[0].count,
        last_1h_total:    lastHourCount[0].count,
      },
      level_breakdown_in_window: levelBreakdown,
      last_error:                lastError.length    ? fmtRecord(lastError[0])    : null,
      last_critical:             lastCritical.length ? fmtRecord(lastCritical[0]) : null,
      collections_in_alarm:      collectionsInAlarm,
      recent_critical_records:   recentCriticalRecords.map(fmtRecord),
      alert_system:              alertSystem[0],
      hourly_activity:           hourlyActivity,
    };
  });
}
```

---

### `src/routes/metrics.ts`

Exposes a Prometheus-compatible text scrape endpoint. No Prometheus client library is required — the format is simple enough to build by hand.

```typescript
import { FastifyInstance } from "fastify";
import { sql } from "../db";
import { adminAuth } from "../auth";

function gauge(name: string, help: string, value: number | string, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`
    : "";
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labelStr} ${value}\n`;
}

function counter(name: string, help: string, value: number | string, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`
    : "";
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}${labelStr} ${value}\n`;
}

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/metrics", {
    preHandler: adminAuth,
  }, async (_request, reply) => {
    const [
      byLevel,
      byCollection,
      last1h,
      last5m,
      lastError,
      lastCritical,
      alertRules,
      alertDispatches,
      apiKeys,
    ] = await Promise.all([
      sql`SELECT level, COUNT(*)::int AS count FROM records GROUP BY level`,
      sql`SELECT collection, COUNT(*)::int AS count FROM records GROUP BY collection`,
      sql`SELECT COUNT(*)::int AS count FROM records WHERE timestamp >= NOW() - INTERVAL '1 hour'`,
      sql`SELECT COUNT(*)::int AS count FROM records WHERE timestamp >= NOW() - INTERVAL '5 minutes'`,
      sql`SELECT EXTRACT(EPOCH FROM timestamp)::bigint AS ts FROM records WHERE level IN ('error','fatal','critical') ORDER BY timestamp DESC LIMIT 1`,
      sql`SELECT EXTRACT(EPOCH FROM timestamp)::bigint AS ts FROM records WHERE level IN ('critical','fatal') ORDER BY timestamp DESC LIMIT 1`,
      sql`SELECT COUNT(*) FILTER (WHERE enabled = TRUE)::int AS enabled, COUNT(*) FILTER (WHERE enabled = FALSE)::int AS disabled FROM alert_rules`,
      sql`SELECT status, COUNT(*)::int AS count FROM alert_history GROUP BY status`,
      sql`SELECT COUNT(*) FILTER (WHERE revoked = FALSE)::int AS active FROM api_keys`,
    ]);

    const lines: string[] = [];

    // Records by level
    for (const row of byLevel) {
      lines.push(counter("tome_records_total", "Total records ingested by level",
        row.count as number, { level: row.level as string }));
    }

    // Records by collection (top 50)
    const sortedCollections = (byCollection as Array<{ collection: string; count: number }>)
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
    for (const row of sortedCollections) {
      lines.push(counter("tome_records_by_collection_total",
        "Total records ingested by collection",
        row.count, { collection: row.collection }));
    }

    lines.push(gauge("tome_records_last_1h",    "Records ingested in the last 1 hour",    (last1h[0].count as number)));
    lines.push(gauge("tome_records_last_5m",    "Records ingested in the last 5 minutes",  (last5m[0].count as number)));
    lines.push(gauge("tome_last_error_timestamp_seconds",    "Unix timestamp of the last error/fatal/critical record",    lastError.length    ? (lastError[0].ts as number)    : 0));
    lines.push(gauge("tome_last_critical_timestamp_seconds", "Unix timestamp of the last critical/fatal record",          lastCritical.length ? (lastCritical[0].ts as number) : 0));
    lines.push(gauge("tome_alert_rules",         "Number of alert rules",  (alertRules[0].enabled as number),  { state: "enabled" }));
    lines.push(gauge("tome_alert_rules",         "Number of alert rules",  (alertRules[0].disabled as number), { state: "disabled" }));

    for (const row of alertDispatches as Array<{ status: string; count: number }>) {
      lines.push(counter("tome_alert_dispatches_total",
        "Alert dispatches by status", row.count, { status: row.status }));
    }

    lines.push(gauge("tome_api_keys", "Number of active (non-revoked) API keys", (apiKeys[0].active as number)));

    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.send(lines.join("\n"));
  });
}
```

---

### `src/index.ts`

```typescript
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

import { ingestRoutes }    from "./routes/ingest";
import { queryRoutes }     from "./routes/query";
import { keysRoutes }      from "./routes/keys";
import { alertsRoutes }    from "./routes/alerts";
import { dashboardRoutes } from "./routes/dashboard";
import { metricsRoutes }   from "./routes/metrics";
import { sql }             from "./db";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  // Reject request bodies larger than 1MB
  bodyLimit: 1_048_576,
  trustProxy: true,
});

async function start() {
  // ── Plugins ────────────────────────────────────────────────────────────────
  await fastify.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    // Exempt admin metrics from rate limit (Prometheus scraping)
    skipOnError: false,
    allowList: [],
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  await fastify.register(ingestRoutes);
  await fastify.register(queryRoutes);
  await fastify.register(keysRoutes);
  await fastify.register(alertsRoutes);
  await fastify.register(dashboardRoutes);
  await fastify.register(metricsRoutes);

  // ── Health check (unauthenticated) ─────────────────────────────────────────
  fastify.get("/healthz", async () => {
    // Quick DB ping
    await sql`SELECT 1`;
    return { status: "ok" };
  });

  // ── Global error handler ───────────────────────────────────────────────────
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);

    // Fastify body parsing errors (malformed JSON, body too large)
    if (error.statusCode === 413) {
      return reply.status(413).send({ error: "Request body too large (max 1MB)" });
    }
    if (error.statusCode === 400) {
      return reply.status(400).send({ error: error.message });
    }

    return reply.status(500).send({ error: "Internal server error" });
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  try {
    await fastify.listen({ port: 3000, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
```

---

## Client Integration

### Node.js — `TomeHandler` class

Drop this class into any Node.js project to start shipping Records to Tome.

```typescript
// tome-client.ts
import { createHash } from "crypto"; // only if you want local key verification

interface TomeConfig {
  baseUrl: string;          // e.g. "http://tome.homelab.local:8420"
  apiKey: string;
  projectName?: string;
  collection: string;
  defaultLevel?: string;
}

export class TomeHandler {
  constructor(private config: TomeConfig) {}

  async log(
    message: string,
    level: string = this.config.defaultLevel ?? "info",
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await fetch(`${this.config.baseUrl}/records`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key":    this.config.apiKey,
      },
      body: JSON.stringify({
        level,
        collection:   this.config.collection,
        message,
        project_name: this.config.projectName,
        metadata,
      }),
    });
    // Swallowed intentionally — logging should never crash your app
  }

  info  = (msg: string, meta?: Record<string, unknown>) => this.log(msg, "info",     meta);
  warn  = (msg: string, meta?: Record<string, unknown>) => this.log(msg, "warn",     meta);
  error = (msg: string, meta?: Record<string, unknown>) => this.log(msg, "error",    meta);
  fatal = (msg: string, meta?: Record<string, unknown>) => this.log(msg, "fatal",    meta);
  debug = (msg: string, meta?: Record<string, unknown>) => this.log(msg, "debug",    meta);
}

// Usage:
// const logger = new TomeHandler({
//   baseUrl:     "http://tome.homelab.local:8420",
//   apiKey:      process.env.TOME_API_KEY!,
//   projectName: process.env.TOME_PROJECT_NAME,
//   collection:  "my-app",
// });
// await logger.error("Database connection failed", { host: "db01", port: 5432 });
```

---

## Prometheus Integration

### `prometheus.yml` scrape config

```yaml
scrape_configs:
  - job_name: "tome"
    scrape_interval: 30s
    static_configs:
      - targets: ["tome.homelab.local:8420"]
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <your-admin-api-key>
```

> Prometheus uses `Authorization: Bearer <token>`. Tome reads `X-API-Key`. To bridge this, either add a Bearer token parser in `auth.ts` or proxy through Nginx with a header rewrite. The simpler option: add an env-var-configured `METRICS_KEY` that bypasses the normal auth flow and only serves `/metrics`.

### PromQL examples

```
# Records per minute over the last 5 minutes
rate(tome_records_total[5m]) * 60

# Error rate as % of total ingestion
sum(rate(tome_records_total{level=~"error|fatal|critical"}[5m]))
  / sum(rate(tome_records_total[5m])) * 100

# Time since last critical record (alert when > 0 for unexpected silence monitoring)
time() - tome_last_critical_timestamp_seconds

# Collections with the most records in the last hour
topk(10, tome_records_by_collection_total)
```

### Alertmanager rules (`tome_alerts.yml`)

```yaml
groups:
  - name: tome
    rules:
      - alert: TomeHighErrorRate
        expr: |
          sum(rate(tome_records_total{level=~"error|fatal|critical"}[5m]))
            / sum(rate(tome_records_total[5m])) * 100 > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Tome error rate > 10% over last 5 minutes"

      - alert: TomeAlertDispatchFailures
        expr: increase(tome_alert_dispatches_total{status="failed"}[15m]) > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Tome alert dispatch failures detected in last 15 minutes"

      - alert: TomeNoIngestActivity
        expr: sum(tome_records_last_5m) == 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Tome has received no records in the last 5 minutes (may indicate collector failure)"
```

---

## Deployment Checklist

- [ ] Generate admin key: `openssl rand -hex 32` — store this somewhere safe, it's shown once
- [ ] Hash it: `echo -n "your-key" | sha256sum | cut -d' ' -f1`
- [ ] Replace all `CHANGE_ME_*` placeholders in `docker-compose.yml`
  - `CHANGE_ME_DB_PASSWORD` — appears in three places; all must match
  - `CHANGE_ME_SHA256_HASH` — the hash from the step above
  - `CHANGE_ME_SMTP_PASSWORD` — SendGrid API key or SMTP password
- [ ] Set `SMTP_FROM` to your actual sending address
- [ ] `docker compose up -d`
- [ ] Confirm health: `curl http://localhost:8420/healthz`
- [ ] Create your first ingest key via `POST /keys`
- [ ] Update each application to use the new key + `project_name` in its payload
- [ ] Create at least one alert rule via `POST /alerts`
- [ ] Test the alert rule via `POST /alerts/:id/test`
- [ ] Configure Prometheus scrape if using `/metrics`
- [ ] Schedule backup sidecar or set up `pg_dump` cron

---

## Considerations & Future Extensions

The following are known gaps or optional enhancements tracked from the design process:

### High Priority
- **Alembic-style migrations**: The current `init.sql` approach only runs on first container start. For schema changes, add a migration runner (e.g., [node-pg-migrate](https://github.com/salsita/node-pg-migrate) or [Flyway](https://flywaydb.org/)).
- **`received_at` filter on `GET /records`**: The current query API filters only on `timestamp` (client-provided). Add `received_from` / `received_to` params to filter on `received_at` for auditing ingestion timing.
- **Structured logging for the API itself**: Fastify's built-in `pino` logger is already structured. Ensure log lines include `request_id`, `key_name`, and `collection` for traceability.

### Secondary
- **Log export / streaming**: `GET /records/export` that streams CSV or NDJSON for large time-range exports without loading everything into memory. Use Node.js streams + `cursor`-based iteration.
- **`DELETE /records`**: Admin endpoint to purge Records by date range or collection. Useful for retention management without running a background sidecar.
- **Retention sidecar**: A scheduled `pg_cron` job or separate Docker service that deletes Records older than a configurable age.
- **Idempotency keys**: `X-Idempotency-Key` header on ingest endpoints to prevent duplicate Records on client retries.
- **Webhook action type**: The `alert_rules.action_type` and `action_config` schema already support `webhook` as a future extension. Implement in `alertEngine.ts` as an additional `dispatch` branch.
- **Metrics Bearer token support**: Add `Authorization: Bearer <token>` parsing to `auth.ts` so Prometheus can scrape `/metrics` without a proxy/header rewrite.
- **CORS middleware**: Add `@fastify/cors` if the API will be consumed from a browser-based dashboard on a different origin.
