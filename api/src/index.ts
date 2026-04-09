import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { ingestRoutes }    from "./routes/ingest";
import { queryRoutes }     from "./routes/query";
import { keysRoutes }      from "./routes/keys";
import { alertsRoutes }    from "./routes/alerts";
import { dashboardRoutes } from "./routes/dashboard";
import { metricsRoutes }   from "./routes/metrics";
import { sql }             from "./db";
import { hashKey }         from "./auth";
import { drainBuffer, initBuffer } from "./writeBuffer";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  // Reject request bodies larger than 1MB
  bodyLimit: 1_048_576,
  trustProxy: true,
});

async function start() {
  initBuffer(fastify.log);

  // ── Plugins ────────────────────────────────────────────────────────────────
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // API-only, no HTML
  });

  await fastify.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    skipOnError: false,
    allowList: [],
    keyGenerator: (request) => {
      // Rate limit per API key hash when present, fall back to IP for unauthenticated routes
      const apiKey = request.headers["x-api-key"] as string;
      return apiKey ? hashKey(apiKey) : request.ip;
    },
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  await fastify.register(ingestRoutes,    { prefix: "/tome" });
  await fastify.register(queryRoutes,     { prefix: "/tome" });
  await fastify.register(keysRoutes,      { prefix: "/tome" });
  await fastify.register(alertsRoutes,    { prefix: "/tome" });
  await fastify.register(dashboardRoutes, { prefix: "/tome" });
  await fastify.register(metricsRoutes,   { prefix: "/tome" });

  // ── Health check (unauthenticated) ─────────────────────────────────────────
  fastify.get("/tome/healthz", async () => {
    // Quick DB ping
    await sql`SELECT 1`;
    return { status: "ok" };
  });

  // ── Global error handler ───────────────────────────────────────────────────
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error({ err: error, msg: error.message }, "request error");

    // Backpressure — write buffer full
    if (error.message === "Write buffer full") {
      reply.header("Retry-After", "5");
      return reply.status(503).send({ error: "Write buffer full — try again shortly" });
    }

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

// ── Graceful shutdown ──────────────────────────────────────────────────────
const shutdown = async () => {
  fastify.log.info("shutting down — draining write buffer");
  await drainBuffer();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
