import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { adminAuth } from "../auth";
import { invalidateRulesCache, interpolate } from "../alertEngine";
import { sendEmail } from "../email";

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
        ${d.match_metadata ? sql.json(d.match_metadata as any) : null},
        ${d.action_type}, ${sql.json(d.action_config as any)}, ${d.cooldown_seconds}
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

    if (d.name              !== undefined) setClauses.push(sql`name = ${d.name}`);
    if (d.enabled           !== undefined) setClauses.push(sql`enabled = ${d.enabled}`);
    if (d.match_collections !== undefined) setClauses.push(sql`match_collections = ${d.match_collections ?? null}`);
    if (d.match_levels      !== undefined) setClauses.push(sql`match_levels = ${d.match_levels ?? null}`);
    if (d.match_message     !== undefined) setClauses.push(sql`match_message = ${d.match_message ?? null}`);
    if (d.match_metadata    !== undefined) setClauses.push(sql`match_metadata = ${d.match_metadata ? sql.json(d.match_metadata as any) : null}`);
    if (d.action_config     !== undefined) setClauses.push(sql`action_config = ${sql.json(d.action_config as any)}`);
    if (d.cooldown_seconds  !== undefined) setClauses.push(sql`cooldown_seconds = ${d.cooldown_seconds}`);

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

    const testRecord = {
      timestamp:  new Date(),
      level:      "info",
      collection: "test",
      message:    "This is a test alert fired manually via POST /alerts/:id/test",
      metadata:   {} as Record<string, unknown>,
    };

    try {
      const cfg = rule.action_config as {
        to: string[];
        subject_template: string;
        body_template: string;
      };

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
        subject: interpolate(cfg.subject_template, vars),
        text:    interpolate(cfg.body_template, vars),
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
