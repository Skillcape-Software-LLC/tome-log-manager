import { FastifyInstance } from "fastify";
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
