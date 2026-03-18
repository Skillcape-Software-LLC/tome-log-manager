import { sql } from "./db";
import { sendEmail } from "./email";
import { AlertRule, IngestRecord } from "./types";

// ── Rule cache ────────────────────────────────────────────────────────────────
// Rules are cached for 30s to avoid a DB hit on every ingest request.
// Any mutation to alert_rules must call invalidateRulesCache().

let rulesCache: AlertRule[] | null = null;
let rulesCacheAt = 0;
const CACHE_TTL_MS = 30_000;

export function invalidateRulesCache(): void {
  rulesCache = null;
  rulesCacheAt = 0;
}

async function getCachedRules(): Promise<AlertRule[]> {
  if (rulesCache && Date.now() - rulesCacheAt < CACHE_TTL_MS) {
    return rulesCache;
  }
  const rows = await sql<AlertRule[]>`
    SELECT * FROM alert_rules WHERE enabled = TRUE
  `;
  rulesCache = rows;
  rulesCacheAt = Date.now();
  return rows;
}

// ── Matching ──────────────────────────────────────────────────────────────────

function matches(rule: AlertRule, record: IngestRecord): boolean {
  if (rule.match_collections?.length && !rule.match_collections.includes(record.collection)) {
    return false;
  }
  if (rule.match_levels?.length && !rule.match_levels.includes(record.level)) {
    return false;
  }
  if (rule.match_message) {
    if (!record.message.toLowerCase().includes(rule.match_message.toLowerCase())) {
      return false;
    }
  }
  if (rule.match_metadata) {
    for (const [key, val] of Object.entries(rule.match_metadata)) {
      if (record.metadata[key] !== val) return false;
    }
  }
  return true;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

async function dispatch(
  rule: AlertRule,
  recordId: string,
  record: IngestRecord
): Promise<"sent" | "failed"> {
  const vars: Record<string, string> = {
    rule_name:  rule.name,
    level:      record.level,
    collection: record.collection,
    message:    record.message,
    timestamp:  record.timestamp.toISOString(),
    metadata:   JSON.stringify(record.metadata, null, 2),
    record_id:  recordId,
  };

  if (rule.action_type === "email") {
    const cfg = rule.action_config as {
      to: string[];
      subject_template: string;
      body_template: string;
    };
    await sendEmail({
      to: cfg.to,
      subject: interpolate(cfg.subject_template, vars),
      text: interpolate(cfg.body_template, vars),
    });
    return "sent";
  }

  throw new Error(`Unknown action_type: ${rule.action_type}`);
}

// ── Main evaluate function ────────────────────────────────────────────────────

export async function evaluateRules(recordId: string, record: IngestRecord): Promise<void> {
  try {
    const rules = await getCachedRules();
    const now = new Date();

    for (const rule of rules) {
      if (!matches(rule, record)) continue;

      // Check cooldown
      if (rule.last_fired) {
        const secondsSinceLastFire = (now.getTime() - rule.last_fired.getTime()) / 1000;
        if (secondsSinceLastFire < rule.cooldown_seconds) {
          // Throttled — record in history but don't fire
          await sql`
            INSERT INTO alert_history (rule_id, record_id, status)
            VALUES (${rule.id}, ${recordId}, 'throttled')
          `;
          continue;
        }
      }

      let status: "sent" | "failed" = "failed";
      let error: string | undefined;

      try {
        status = await dispatch(rule, recordId, record);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[tome.alert] dispatch failed for rule ${rule.id}:`, error);
      }

      // Update last_fired and write history atomically
      await sql.begin(async (tx: any) => {
        await tx`
          UPDATE alert_rules SET last_fired = NOW() WHERE id = ${rule.id}
        `;
        await tx`
          INSERT INTO alert_history (rule_id, record_id, status, error)
          VALUES (${rule.id}, ${recordId}, ${status}, ${error ?? null})
        `;
      });

      // Bust the cache so next evaluation picks up the new last_fired
      invalidateRulesCache();
    }
  } catch (err) {
    console.error(`[tome.alert] unhandled error for record ${recordId}:`, err);
  }
}
