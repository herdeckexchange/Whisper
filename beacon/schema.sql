-- Beacon Brain — Phase 1 data foundation schema (PostgreSQL)
--
-- Mirrors the BeaconStore interface in src/repositories/store.ts. The
-- in-memory implementation is the reference for behaviour; this is the
-- production target (Replit ships a Postgres add-on).
--
-- Design rule enforced structurally, not by convention: market snapshots,
-- historical bars, and fundamentals are APPEND-ONLY. Beacon must be able to
-- reconstruct what it knew when a past recommendation was made, so refreshes
-- INSERT new rows. Only assets and data_sources — present-tense identity and
-- health — are updated in place.

BEGIN;

-- ---------------------------------------------------------------------------
-- Source registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_sources (
  source_id                TEXT PRIMARY KEY,
  provider_name            TEXT        NOT NULL,
  categories               TEXT[]      NOT NULL DEFAULT '{}',
  provider_type            TEXT        NOT NULL
                             CHECK (provider_type IN ('official','third_party','aggregator','derived')),
  official                 BOOLEAN     NOT NULL DEFAULT FALSE,
  reliability_tier         SMALLINT    NOT NULL CHECK (reliability_tier BETWEEN 1 AND 4),
  refresh_frequency_ms     BIGINT      NOT NULL,
  last_successful_refresh  TIMESTAMPTZ,
  last_failed_refresh      TIMESTAMPTZ,
  last_failure_reason      TEXT,
  health_status            TEXT        NOT NULL DEFAULT 'unknown'
                             CHECK (health_status IN ('healthy','degraded','failing','unknown')),
  licensing_notes          TEXT,
  attribution              TEXT,
  backup_source_id         TEXT REFERENCES data_sources(source_id),
  consecutive_failures     INTEGER     NOT NULL DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Assets  (upserted — identity, not history)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  asset_id     TEXT PRIMARY KEY,
  symbol       TEXT        NOT NULL,
  name         TEXT,
  asset_type   TEXT        NOT NULL
                 CHECK (asset_type IN ('stock','etf','crypto','option','index','fund','adr','warrant','other')),
  exchange     TEXT,
  currency     TEXT,
  sector       TEXT,
  industry     TEXT,
  market_cap   NUMERIC(24,2),
  cap_tier     TEXT        NOT NULL DEFAULT 'unknown'
                 CHECK (cap_tier IN ('mega','large','mid','small','micro','nano','unknown')),
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  external_ids JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS assets_symbol_type_idx ON assets (UPPER(symbol), asset_type);
-- Screening the whole market by size is a core Beacon requirement.
CREATE INDEX IF NOT EXISTS assets_cap_tier_idx ON assets (cap_tier) WHERE active;

-- ---------------------------------------------------------------------------
-- Market snapshots  (APPEND-ONLY)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_snapshots (
  snapshot_id         TEXT PRIMARY KEY,
  asset_id            TEXT        NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  symbol              TEXT        NOT NULL,
  price               NUMERIC(20,6),
  previous_close      NUMERIC(20,6),
  change              NUMERIC(20,6),
  change_percent      NUMERIC(12,6),
  open                NUMERIC(20,6),
  high                NUMERIC(20,6),
  low                 NUMERIC(20,6),
  volume              BIGINT,
  average_volume      BIGINT,
  fifty_two_week_high NUMERIC(20,6),
  fifty_two_week_low  NUMERIC(20,6),
  market_timestamp    TIMESTAMPTZ,
  source_id           TEXT        NOT NULL REFERENCES data_sources(source_id),
  retrieved_at        TIMESTAMPTZ NOT NULL,
  freshness           TEXT        NOT NULL
                        CHECK (freshness IN ('fresh','stale','delayed','estimated','missing','failed')),
  attribution         TEXT,
  missing_fields      TEXT[]      NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS snapshots_asset_time_idx
  ON market_snapshots (asset_id, retrieved_at DESC);

-- Guard the append-only rule at the database level: a snapshot row is a record
-- of an observation, and observations do not change after the fact.
CREATE OR REPLACE FUNCTION beacon_block_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Beacon: % on % is not permitted — this table is append-only so historical state stays reconstructable.',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_snapshots_append_only ON market_snapshots;
CREATE TRIGGER market_snapshots_append_only
  BEFORE UPDATE OR DELETE ON market_snapshots
  FOR EACH ROW EXECUTE FUNCTION beacon_block_mutation();

-- ---------------------------------------------------------------------------
-- Historical prices  (immutable per asset/date/source)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_prices (
  asset_id       TEXT        NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  symbol         TEXT        NOT NULL,
  bar_date       DATE        NOT NULL,
  open           NUMERIC(20,6),
  high           NUMERIC(20,6),
  low            NUMERIC(20,6),
  close          NUMERIC(20,6),
  adjusted_close NUMERIC(20,6),
  volume         BIGINT,
  source_id      TEXT        NOT NULL REFERENCES data_sources(source_id),
  retrieved_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (asset_id, bar_date, source_id)
);

CREATE INDEX IF NOT EXISTS historical_asset_date_idx
  ON historical_prices (asset_id, bar_date DESC);

-- ---------------------------------------------------------------------------
-- Fundamentals  (APPEND-ONLY — restatements add rows, never overwrite)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fundamental_snapshots (
  fundamental_id    TEXT PRIMARY KEY,
  asset_id          TEXT        NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  symbol            TEXT        NOT NULL,
  revenue           NUMERIC(24,2),
  earnings          NUMERIC(24,2),
  eps               NUMERIC(16,6),
  profit_margin     NUMERIC(12,6),
  cash              NUMERIC(24,2),
  debt              NUMERIC(24,2),
  pe_ratio          NUMERIC(16,6),
  price_to_sales    NUMERIC(16,6),
  price_to_book     NUMERIC(16,6),
  enterprise_value  NUMERIC(24,2),
  reporting_period  TEXT,
  fiscal_period_end DATE,
  source_id         TEXT        NOT NULL REFERENCES data_sources(source_id),
  retrieved_at      TIMESTAMPTZ NOT NULL,
  freshness         TEXT        NOT NULL,
  missing_fields    TEXT[]      NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fundamentals_asset_time_idx
  ON fundamental_snapshots (asset_id, retrieved_at DESC);

-- ---------------------------------------------------------------------------
-- News
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news_items (
  article_id          TEXT PRIMARY KEY,
  headline            TEXT        NOT NULL,
  headline_fingerprint TEXT       NOT NULL,
  summary             TEXT,
  publisher           TEXT,
  published_at        TIMESTAMPTZ,
  source_url          TEXT,
  source_id           TEXT        NOT NULL REFERENCES data_sources(source_id),
  retrieved_at        TIMESTAMPTZ NOT NULL,
  freshness           TEXT        NOT NULL,
  verification_status TEXT        NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','corroborated','disputed')),
  duplicate_group_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Syndicated copies of one wire story share a fingerprint; this is what the
-- duplicate-group assignment keys off.
CREATE INDEX IF NOT EXISTS news_fingerprint_idx ON news_items (headline_fingerprint);
CREATE INDEX IF NOT EXISTS news_group_idx       ON news_items (duplicate_group_id);
CREATE INDEX IF NOT EXISTS news_published_idx   ON news_items (published_at DESC);

-- Many-to-many: one article can move several tickers.
CREATE TABLE IF NOT EXISTS news_assets (
  article_id TEXT NOT NULL REFERENCES news_items(article_id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES assets(asset_id)       ON DELETE CASCADE,
  PRIMARY KEY (article_id, asset_id)
);

-- ---------------------------------------------------------------------------
-- Job runs  (failed-job recording)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_runs (
  job_run_id        TEXT PRIMARY KEY,
  job_name          TEXT        NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ,
  status            TEXT        NOT NULL CHECK (status IN ('success','partial','failed')),
  symbols_processed TEXT[]      NOT NULL DEFAULT '{}',
  errors            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  duration_ms       INTEGER
);

CREATE INDEX IF NOT EXISTS job_runs_name_time_idx ON job_runs (job_name, started_at DESC);

COMMIT;
