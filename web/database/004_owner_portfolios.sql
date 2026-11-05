BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS market_lab.owner_portfolios(
  owner_id uuid PRIMARY KEY,
  ledger jsonb NOT NULL CHECK(jsonb_typeof(ledger)='object'),
  watchlist text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(cardinality(watchlist)<=200),
  CHECK(octet_length(ledger::text)<=1500000)
);
ALTER TABLE market_lab.owner_portfolios ENABLE ROW LEVEL SECURITY;
DO $body$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='market_lab_app') THEN
    GRANT SELECT,INSERT,UPDATE ON market_lab.owner_portfolios TO market_lab_app;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='market_lab' AND tablename='owner_portfolios' AND policyname='backend_app') THEN
      CREATE POLICY backend_app ON market_lab.owner_portfolios TO market_lab_app USING(true) WITH CHECK(true);
    END IF;
  END IF;
END
$body$;
COMMIT;
