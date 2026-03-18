// Shared TypeScript types used across routes and the alert engine

export interface KeyRecord {
  id: string;
  key_hash: string;
  name: string;
  role: "ingest" | "admin";
  collection: string | null;
  project_name: string | null;
  created_at: Date;
  last_used: Date | null;
  revoked: boolean;
}

export interface RecordRow {
  id: string;
  timestamp: Date;
  received_at: Date;
  level: string;
  collection: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  match_collections: string[] | null;
  match_levels: string[] | null;
  match_message: string | null;
  match_metadata: Record<string, unknown> | null;
  action_type: string;
  action_config: Record<string, unknown>;
  cooldown_seconds: number;
  last_fired: Date | null;
  created_at: Date;
}

export interface IngestRecord {
  timestamp: Date;
  level: string;
  collection: string;
  message: string;
  project_name?: string | null;
  metadata: Record<string, unknown>;
}

// Augment Fastify request with the authenticated key record
declare module "fastify" {
  interface FastifyRequest {
    keyRecord?: KeyRecord;
  }
}
