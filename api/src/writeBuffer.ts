import { FastifyBaseLogger } from "fastify";
import { sql } from "./db";
import { evaluateRules } from "./alertEngine";
import { IngestRecord } from "./types";

let log: FastifyBaseLogger | typeof console = console;

export function initBuffer(logger: FastifyBaseLogger): void {
  log = logger;
}

let buffer: IngestRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

const FLUSH_INTERVAL_MS = parseInt(process.env.TOME_FLUSH_INTERVAL_MS ?? "2000", 10);
const FLUSH_SIZE_THRESHOLD = parseInt(process.env.TOME_FLUSH_SIZE ?? "500", 10);
const MAX_BUFFER_SIZE = 10_000;

export function enqueue(record: IngestRecord): void {
  if (buffer.length >= MAX_BUFFER_SIZE) {
    throw new Error("Write buffer full");
  }
  buffer.push(record);

  if (buffer.length >= FLUSH_SIZE_THRESHOLD) {
    triggerFlush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(triggerFlush, FLUSH_INTERVAL_MS);
  }
}

function triggerFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush().catch((err) => {
    log.error({ err }, "[tome.buffer] flush error");
  });
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;

  const batch = buffer;
  buffer = [];

  try {
    const rows = await sql`
      INSERT INTO records (timestamp, level, collection, message, metadata)
      SELECT * FROM unnest(
        ${sql.array(batch.map((e) => e.timestamp))}::timestamptz[],
        ${sql.array(batch.map((e) => e.level))}::text[],
        ${sql.array(batch.map((e) => e.collection))}::text[],
        ${sql.array(batch.map((e) => e.message))}::text[],
        ${sql.array(batch.map((e) => JSON.stringify(e.metadata)))}::jsonb[]
      )
      RETURNING id
    `;

    for (let i = 0; i < rows.length; i++) {
      evaluateRules(rows[i].id as string, batch[i]).catch((err) => {
        log.error("[tome.buffer] alert engine error:", err);
      });
    }
  } catch (err) {
    // Re-queue failed records for retry
    buffer = batch.concat(buffer);
    if (buffer.length > MAX_BUFFER_SIZE) {
      const dropped = buffer.length - MAX_BUFFER_SIZE;
      buffer = buffer.slice(0, MAX_BUFFER_SIZE);
      log.error(`[tome.buffer] dropped ${dropped} records after failed flush`);
    }
    throw err;
  } finally {
    flushing = false;
    if (buffer.length > 0) {
      flushTimer = setTimeout(triggerFlush, FLUSH_INTERVAL_MS);
    }
  }
}

export async function drainBuffer(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (let attempt = 0; attempt < 3 && buffer.length > 0; attempt++) {
    try {
      flushing = false;
      await flush();
    } catch (err) {
      log.error(`[tome.buffer] drain attempt ${attempt + 1} failed:`, err);
    }
  }
  if (buffer.length > 0) {
    log.error(`[tome.buffer] ${buffer.length} records lost on shutdown`);
  }
}
