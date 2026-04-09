import { FastifyInstance } from "fastify";
import { z } from "zod";
import { keyAuth, validateIngestAuth } from "../auth";
import { enqueue } from "../writeBuffer";

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

    enqueue(entry);
    return reply.status(202).send({ status: "accepted" });
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

    const key = request.keyRecord!;
    for (const entry of entries) {
      if (!validateIngestAuth(key, entry.collection, entry.project_name, reply)) return;
      enqueue(entry);
    }

    return reply.status(202).send({ status: "accepted", count: entries.length });
  });
}
