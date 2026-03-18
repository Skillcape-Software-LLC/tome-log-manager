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
    fastify.log.error({ err: error, msg: error.message }, "request error");

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
