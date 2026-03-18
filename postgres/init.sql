-- Core records table
CREATE TABLE IF NOT EXISTS records (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp   TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    level       VARCHAR(20),
    collection  VARCHAR(255) NOT NULL,
    message     TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    search_vec  TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('english', message)
                ) STORED
);

CREATE INDEX IF NOT EXISTS idx_records_timestamp   ON records (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_records_received_at ON records (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_collection  ON records (collection);
CREATE INDEX IF NOT EXISTS idx_records_level       ON records (level);
CREATE INDEX IF NOT EXISTS idx_records_search_vec  ON records USING GIN (search_vec);
CREATE INDEX IF NOT EXISTS idx_records_metadata    ON records USING GIN (metadata);

-- Keyset pagination composite indexes
CREATE INDEX IF NOT EXISTS idx_records_cursor_desc ON records (timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_records_cursor_asc  ON records (timestamp ASC,  id ASC);

-- API keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash     VARCHAR(64) UNIQUE NOT NULL,
    name         VARCHAR(255) NOT NULL,
    role         VARCHAR(20) NOT NULL,       -- 'ingest' | 'admin'
    collection   VARCHAR(255),              -- optional: lock key to this collection
    project_name VARCHAR(255),              -- optional: second factor (stored lowercase)
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_used    TIMESTAMPTZ,
    revoked      BOOLEAN DEFAULT FALSE
);

-- Alert rules
CREATE TABLE IF NOT EXISTS alert_rules (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(255) NOT NULL,
    enabled           BOOLEAN DEFAULT TRUE,
    match_collections TEXT[],
    match_levels      TEXT[],
    match_message     TEXT,
    match_metadata    JSONB,
    action_type       VARCHAR(50) NOT NULL,  -- 'email'
    action_config     JSONB NOT NULL,
    cooldown_seconds  INT DEFAULT 300,
    last_fired        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Alert firing history
CREATE TABLE IF NOT EXISTS alert_history (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id  UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    record_id UUID NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    fired_at TIMESTAMPTZ DEFAULT NOW(),
    status   VARCHAR(20) NOT NULL,  -- 'sent' | 'throttled' | 'failed'
    error    TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_history_rule   ON alert_history (rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_status ON alert_history (status);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_key  VARCHAR(64),     -- key_hash of the actor
    action     VARCHAR(100) NOT NULL,
    target     VARCHAR(255),    -- e.g. key id, rule id
    detail     JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bootstrap admin key seeding is handled by 02-seed.sh
-- which receives ADMIN_KEY_HASH as an environment variable from docker-compose.
