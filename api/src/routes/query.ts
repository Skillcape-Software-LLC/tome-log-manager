import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { keyAuth } from "../auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Cursor encoding ───────────────────────────────────────────────────────────
// Cursor encodes { ts: ISO string, id: UUID } as base64 JSON

function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(JSON.stringify({ ts: timestamp.toISOString(), id })).toString("base64url");
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed.ts || !parsed.id || !UUID_RE.test(parsed.id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Metadata filter extraction ────────────────────────────────────────────────
// Parses ?metadata.key=value query params into a JSONB containment object.
// Values are JSON-parsed so numbers and booleans match their stored types.
// e.g. ?metadata.service=payments&metadata.error_code=503

function extractMetadataFilter(query: Record<string, string>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(query)) {
    if (key.startsWith("metadata.")) {
      const metaKey = key.slice(9);
      try {
        filter[metaKey] = JSON.parse(val);
      } catch {
        filter[metaKey] = val;
      }
    }
  }
  return filter;
}

// ── Shared condition builder ──────────────────────────────────────────────────
// Used by both GET /records and GET /records/export so filter logic stays in sync.

interface FilterParams {
  from?:             string;
  to?:               string;
  received_from?:    string;
  received_to?:      string;
  collection?:       string;
  level?:            string;
  q?:                string;
  message_contains?: string;
  metadata?:         Record<string, unknown>;
}

function buildConditions(p: FilterParams): ReturnType<typeof sql>[] {
  const conditions: ReturnType<typeof sql>[] = [sql`TRUE`];

  if (p.from)          conditions.push(sql`timestamp >= ${new Date(p.from)}`);
  if (p.to)            conditions.push(sql`timestamp <= ${new Date(p.to)}`);
  if (p.received_from) conditions.push(sql`received_at >= ${new Date(p.received_from)}`);
  if (p.received_to)   conditions.push(sql`received_at <= ${new Date(p.received_to)}`);

  if (p.collection) {
    const cols = p.collection.split(",").map((c) => c.trim());
    conditions.push(sql`collection = ANY(${cols})`);
  }
  if (p.level) {
    const levels = p.level.split(",").map((l) => l.trim());
    conditions.push(sql`level = ANY(${levels})`);
  }

  // Full-text search — stemmed English, good for prose messages
  if (p.q) {
    conditions.push(sql`search_vec @@ plainto_tsquery('english', ${p.q})`);
  }

  // Exact substring match — use when hunting UUIDs, error codes, stack trace fragments
  if (p.message_contains) {
    const escaped = p.message_contains.replace(/[%_\\]/g, "\\$&");
    conditions.push(sql`message ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }

  // JSONB containment — uses the GIN index; values are type-aware
  if (p.metadata && Object.keys(p.metadata).length > 0) {
    conditions.push(sql`metadata @> ${sql.json(p.metadata as any)}`);
  }

  return conditions;
}

// ── Query parameter schemas ───────────────────────────────────────────────────

const QuerySchema = z.object({
  from:             z.string().datetime().optional(),
  to:               z.string().datetime().optional(),
  received_from:    z.string().datetime().optional(),
  received_to:      z.string().datetime().optional(),
  collection:       z.string().optional(),
  level:            z.string().optional(),
  q:                z.string().max(500).optional(),
  message_contains: z.string().max(500).optional(),
  limit:            z.coerce.number().int().min(1).max(1000).default(100),
  cursor:           z.string().optional(),
  order:            z.enum(["asc", "desc"]).default("desc"),
});

const ExportSchema = z.object({
  from:             z.string().datetime().optional(),
  to:               z.string().datetime().optional(),
  received_from:    z.string().datetime().optional(),
  received_to:      z.string().datetime().optional(),
  collection:       z.string().optional(),
  level:            z.string().optional(),
  q:                z.string().max(500).optional(),
  message_contains: z.string().max(500).optional(),
  order:            z.enum(["asc", "desc"]).default("asc"),
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

    const { from, to, received_from, received_to, collection, level, q,
            message_contains, limit, cursor, order } = parsed.data;
    const desc = order === "desc";

    const metadataFilter = extractMetadataFilter(request.query as Record<string, string>);

    const conditions = buildConditions({
      from, to, received_from, received_to, collection, level, q,
      message_contains, metadata: metadataFilter,
    });

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

  // GET /records/export — stream all matching records as NDJSON
  // Supports the same filters as GET /records (minus pagination params).
  // Useful for piping into jq, loading into external tools, or incident analysis.
  //
  // Example:
  //   curl -H "X-API-Key: $KEY" \
  //     "http://localhost:8420/records/export?collection=payments&level=err&received_from=2024-01-01T00:00:00Z" \
  //     | jq 'select(.metadata.user_id == "u_123")'
  fastify.get("/records/export", {
    preHandler: keyAuth,
  }, async (request, reply) => {
    const parsed = ExportSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { from, to, received_from, received_to, collection, level,
            q, message_contains, order } = parsed.data;
    const desc = order === "desc";

    const metadataFilter = extractMetadataFilter(request.query as Record<string, string>);

    const conditions = buildConditions({
      from, to, received_from, received_to, collection, level, q,
      message_contains, metadata: metadataFilter,
    });

    const whereClause = sql`${conditions.reduce((acc, c) => sql`${acc} AND ${c}`)}`;
    const orderClause = desc
      ? sql`ORDER BY timestamp DESC, id DESC`
      : sql`ORDER BY timestamp ASC, id ASC`;

    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson" });

    try {
      const cursor = sql`
        SELECT id, timestamp, received_at, level, collection, message, metadata
        FROM records
        WHERE ${whereClause}
        ${orderClause}
      `.cursor(100); // fetch 100 rows at a time from postgres

      for await (const rows of cursor) {
        for (const row of rows) {
          reply.raw.write(JSON.stringify(row) + "\n");
        }
      }
    } catch (err) {
      // Client disconnected mid-stream — not an error worth logging loudly
      if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_DESTROYED") {
        fastify.log.error({ err }, "export stream error");
      }
    } finally {
      reply.raw.end();
    }
  });

  // GET /records/:id — single record by UUID
  // Registered after /records/export so the static segment takes precedence.
  fastify.get<{ Params: { id: string } }>("/records/:id", {
    preHandler: keyAuth,
  }, async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: "Invalid record ID" });
    }
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
