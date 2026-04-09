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
  if (reply.headersSent) return; // resolveKey already replied with 401

  if (!request.keyRecord || request.keyRecord.role !== "admin") {
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
      reply.status(401).send({ error: "Invalid or revoked API key" });
      return false;
    }
  }

  return true;
}
