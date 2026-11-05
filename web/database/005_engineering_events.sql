BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS market_lab.domain_events(
  stream_id text NOT NULL CHECK(length(stream_id) BETWEEN 1 AND 160),
  version bigint NOT NULL CHECK(version>0),
  command_id text NOT NULL CHECK(length(command_id) BETWEEN 1 AND 160),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL CHECK(length(event_type) BETWEEN 1 AND 80),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(stream_id,version),
  UNIQUE(stream_id,command_id)
);
CREATE TABLE IF NOT EXISTS market_lab.event_deliveries(
  destination text NOT NULL CHECK(length(destination) BETWEEN 1 AND 80),
  event_id uuid NOT NULL REFERENCES market_lab.domain_events(event_id),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(destination,event_id)
);
CREATE TABLE IF NOT EXISTS market_lab.projection_cursors(
  projection text NOT NULL CHECK(length(projection) BETWEEN 1 AND 80),
  stream_id text NOT NULL CHECK(length(stream_id) BETWEEN 1 AND 160),
  version bigint NOT NULL CHECK(version>=0),
  PRIMARY KEY(projection,stream_id)
);
ALTER TABLE market_lab.domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lab.projection_cursors ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION market_lab.reject_domain_event_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'Domain events are append-only' USING ERRCODE='42501';
END
$body$;
DO $body$
DECLARE table_name text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='market_lab.domain_events'::regclass AND tgname='immutable_domain_events') THEN
    CREATE TRIGGER immutable_domain_events BEFORE UPDATE OR DELETE OR TRUNCATE ON market_lab.domain_events FOR EACH STATEMENT EXECUTE FUNCTION market_lab.reject_domain_event_mutation();
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='market_lab_app') THEN
    GRANT SELECT,INSERT ON market_lab.domain_events,market_lab.event_deliveries TO market_lab_app;
    GRANT SELECT,INSERT,UPDATE ON market_lab.projection_cursors TO market_lab_app;
    FOREACH table_name IN ARRAY ARRAY['domain_events','event_deliveries','projection_cursors'] LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='market_lab' AND tablename=table_name AND policyname='backend_app') THEN
        EXECUTE format('CREATE POLICY backend_app ON market_lab.%I TO market_lab_app USING(true) WITH CHECK(true)',table_name);
      END IF;
    END LOOP;
  END IF;
END
$body$;
COMMIT;
