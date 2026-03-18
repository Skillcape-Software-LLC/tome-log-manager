import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { keyAuth, validateIngestAuth } from "../auth";
import { evaluateRules } from "../alertEngine";

// Load valid levels from env at startup — no default fallback; level is always required
const VALID_LEVELS: Set<string> = new Set(
  (process.env.TOME_LOG_LEVELS ?? "trace,debug,info,warn,error,fatal")
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
      VALUES (${entry.timestamp}, ${entry.level}, ${entry.collection}, ${entry.message}, ${sql.json(entry.metadata as any)})
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
    await sql.begin(async (tx: any) => {
      for (const entry of entries) {
        const [row] = await tx`
          INSERT INTO records (timestamp, level, collection, message, metadata)
          VALUES (${entry.timestamp}, ${entry.level}, ${entry.collection}, ${entry.message}, ${tx.json(entry.metadata as any)})
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
