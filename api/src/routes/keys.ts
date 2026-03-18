import { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "crypto";
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
