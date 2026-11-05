BEGIN;
SET LOCAL lock_timeout='5s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE predictir FROM PUBLIC;
GRANT CONNECT ON DATABASE predictir TO market_lab_app;
GRANT USAGE ON SCHEMA market_lab TO market_lab_app;

GRANT SELECT, INSERT, UPDATE ON market_lab.records, market_lab.quotas, market_lab.audit_heads,
  market_lab.sports_games, market_lab.jobs TO market_lab_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON market_lab.leases TO market_lab_app;
GRANT SELECT, INSERT ON market_lab.archives, market_lab.audit_events, market_lab.source_batches,
  market_lab.market_snapshots, market_lab.source_observations TO market_lab_app;
GRANT SELECT ON market_lab.market_attribution TO market_lab_app;
GRANT USAGE ON SEQUENCE market_lab.source_batches_id_seq TO market_lab_app;

DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'records','quotas','audit_heads','sports_games','jobs','leases','archives',
    'audit_events','source_batches','market_snapshots','source_observations'
  ] LOOP
    IF NOT EXISTS (
      SELECT FROM pg_policies WHERE schemaname='market_lab' AND tablename=relation AND policyname='backend_app'
    ) THEN
      EXECUTE format('CREATE POLICY backend_app ON market_lab.%I TO market_lab_app USING (true) WITH CHECK (true)',relation);
    END IF;
  END LOOP;
END
$policies$;
COMMIT;
