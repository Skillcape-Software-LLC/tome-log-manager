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
    const sortedCollections = (byCollection as unknown as Array<{ collection: string; count: number }>)
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

    for (const row of alertDispatches as unknown as Array<{ status: string; count: number }>) {
      lines.push(counter("tome_alert_dispatches_total",
        "Alert dispatches by status", row.count, { status: row.status }));
    }

    lines.push(gauge("tome_api_keys", "Number of active (non-revoked) API keys", (apiKeys[0].active as number)));

    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.send(lines.join("\n"));
  });
}
