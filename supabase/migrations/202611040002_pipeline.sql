BEGIN;
CREATE TABLE IF NOT EXISTS market_lab.jobs (
  key text PRIMARY KEY, kind text NOT NULL, input jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','complete','failed')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, owner uuid, finished_at timestamptz, error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_jobs ON market_lab.jobs(available_at) WHERE state IN('pending','running');
ALTER TABLE market_lab.jobs ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS market_lab.operational_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL
);
ALTER TABLE market_lab.operational_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS operational_recent ON market_lab.operational_events(occurred_at DESC);
CREATE OR REPLACE VIEW market_lab.market_attribution AS
WITH observations AS (
  SELECT ticker,category,title,observed_at,yes_bid,yes_ask,volume_24h,
    row_number() OVER(PARTITION BY ticker ORDER BY observed_at) AS first_n,
    row_number() OVER(PARTITION BY ticker ORDER BY observed_at DESC) AS last_n,
    count(*) OVER(PARTITION BY ticker) AS observations
  FROM market_lab.market_snapshots WHERE observed_at>now()-interval '7 days'
), endpoints AS (
 SELECT ticker,max(category) AS category,max(title) AS title,max(observations) AS observations,
   min(observed_at) AS first_observed,max(observed_at) AS last_observed,
   max((yes_bid+yes_ask)/2) FILTER(WHERE first_n=1) AS first_midpoint,
   max((yes_bid+yes_ask)/2) FILTER(WHERE last_n=1) AS last_midpoint,
   max(yes_ask-yes_bid) FILTER(WHERE last_n=1) AS latest_spread
 FROM observations GROUP BY ticker
)
SELECT *,last_midpoint-first_midpoint AS observed_price_change FROM endpoints;
COMMIT;
