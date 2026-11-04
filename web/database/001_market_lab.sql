BEGIN;
CREATE SCHEMA IF NOT EXISTS market_lab;
REVOKE ALL ON SCHEMA market_lab FROM PUBLIC;

CREATE TABLE IF NOT EXISTS market_lab.records (
  pk text NOT NULL, sk text NOT NULL, payload jsonb NOT NULL,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pk,sk)
);
CREATE INDEX IF NOT EXISTS records_expiry ON market_lab.records(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pending_forecasts ON market_lab.records((payload->>'pending_sk')) WHERE payload->>'status'='pending';
CREATE TABLE IF NOT EXISTS market_lab.quotas (
  key text PRIMARY KEY, used bigint NOT NULL CHECK (used>=0), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS market_lab.leases (
  key text PRIMARY KEY, owner uuid NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS market_lab.archives (
  key text PRIMARY KEY, sha256 char(64) NOT NULL,
  payload jsonb, object_path text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload IS NOT NULL OR object_path IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS market_lab.audit_heads (
  id uuid PRIMARY KEY, last_hash char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS market_lab.audit_events (
  id uuid NOT NULL REFERENCES market_lab.audit_heads(id),
  type text NOT NULL CHECK(type IN ('freeze','markout')), hash char(64) NOT NULL,
  previous_hash char(64), archive_key text NOT NULL REFERENCES market_lab.archives(key),
  recorded_at timestamptz NOT NULL, PRIMARY KEY (id,type), UNIQUE (id,hash)
);
CREATE TABLE IF NOT EXISTS market_lab.source_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, provider text NOT NULL,
  source_url text NOT NULL, source_as_of timestamptz, ingested_at timestamptz NOT NULL DEFAULT now(),
  sha256 char(64) NOT NULL, archive_key text NOT NULL REFERENCES market_lab.archives(key),
  schema_version integer NOT NULL CHECK(schema_version>0), row_count integer NOT NULL CHECK(row_count>=0),
  UNIQUE(provider,sha256)
);
CREATE TABLE IF NOT EXISTS market_lab.market_snapshots (
  ticker text NOT NULL, observed_at timestamptz NOT NULL, event_ticker text NOT NULL,
  title text NOT NULL, outcome_label text, category text NOT NULL,
  yes_bid numeric(8,6) CHECK(yes_bid BETWEEN 0 AND 1), yes_ask numeric(8,6) CHECK(yes_ask BETWEEN 0 AND 1),
  volume_24h numeric(24,2) CHECK(volume_24h>=0), close_time timestamptz,
  batch_id bigint NOT NULL REFERENCES market_lab.source_batches(id),
  PRIMARY KEY(ticker,observed_at), CHECK(yes_bid IS NULL OR yes_ask IS NULL OR yes_bid<=yes_ask)
);
CREATE INDEX IF NOT EXISTS market_history ON market_lab.market_snapshots(ticker,observed_at DESC);
ALTER TABLE market_lab.market_snapshots ADD COLUMN IF NOT EXISTS quality_flags text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS market_lab.source_observations (
  provider text NOT NULL, entity text NOT NULL, scope text NOT NULL,
  metric text NOT NULL, measurement_date date NOT NULL, value numeric NOT NULL,
  unit text NOT NULL, batch_id bigint NOT NULL REFERENCES market_lab.source_batches(id),
  PRIMARY KEY(provider,entity,scope,metric,measurement_date,batch_id)
);
CREATE INDEX IF NOT EXISTS observation_history ON market_lab.source_observations(provider,scope,metric,measurement_date,entity);
CREATE TABLE IF NOT EXISTS market_lab.sports_games (
  provider text NOT NULL, id text NOT NULL, league text NOT NULL, played_at timestamptz NOT NULL,
  home_id text NOT NULL, away_id text NOT NULL, home_name text NOT NULL, away_name text NOT NULL,
  home_score integer NOT NULL CHECK(home_score>=0), away_score integer NOT NULL CHECK(away_score>=0),
  batch_id bigint NOT NULL REFERENCES market_lab.source_batches(id),
  PRIMARY KEY(provider,id), CHECK(home_id<>away_id)
);
CREATE INDEX IF NOT EXISTS sports_history ON market_lab.sports_games(league,played_at DESC);

CREATE OR REPLACE VIEW market_lab.latest_markets AS
SELECT DISTINCT ON(ticker) * FROM market_lab.market_snapshots ORDER BY ticker,observed_at DESC;
CREATE OR REPLACE VIEW market_lab.team_results AS
SELECT provider,id,league,played_at,home_id AS team_id,away_id AS opponent_id,
  home_name AS team_name,home_score AS scored,away_score AS conceded,true AS at_home,
  CASE WHEN home_score>away_score THEN 1.0 WHEN home_score=away_score THEN 0.5 ELSE 0 END AS result
FROM market_lab.sports_games
UNION ALL
SELECT provider,id,league,played_at,away_id,home_id,away_name,away_score,home_score,false,
  CASE WHEN away_score>home_score THEN 1.0 WHEN home_score=away_score THEN 0.5 ELSE 0 END
FROM market_lab.sports_games;
CREATE OR REPLACE VIEW market_lab.pregame_form AS
SELECT *,count(*) OVER recent AS prior_games,avg(result) OVER recent AS previous_ten_result_rate,
  avg(scored-conceded) OVER recent AS previous_ten_margin
FROM market_lab.team_results
WINDOW recent AS(PARTITION BY provider,league,team_id ORDER BY played_at,id ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING);

ALTER TABLE market_lab.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.audit_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.source_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.market_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.source_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.sports_games ENABLE ROW LEVEL SECURITY;
COMMIT;
