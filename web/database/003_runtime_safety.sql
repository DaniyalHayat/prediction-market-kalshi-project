BEGIN;
SET LOCAL lock_timeout='5s';
DO $body$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='market_lab' AND t.typname='job_transition_state') THEN
    CREATE TYPE market_lab.job_transition_state AS ENUM('pending','running','complete','failed');
  END IF;
END
$body$;
CREATE TABLE IF NOT EXISTS market_lab.job_transition_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_key text NOT NULL REFERENCES market_lab.jobs(key) ON DELETE RESTRICT,
  previous_state market_lab.job_transition_state,
  state market_lab.job_transition_state NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE market_lab.job_transition_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS job_transitions_recent ON market_lab.job_transition_events(changed_at DESC);
CREATE INDEX IF NOT EXISTS job_transitions_key ON market_lab.job_transition_events(job_key,id DESC);
CREATE INDEX IF NOT EXISTS observation_entity_history ON market_lab.source_observations(provider,scope,metric,entity,measurement_date DESC) INCLUDE(value,batch_id);
CREATE INDEX IF NOT EXISTS snapshot_observed_brin ON market_lab.market_snapshots USING brin(observed_at) WITH(pages_per_range=32);
ALTER TABLE market_lab.market_snapshots ADD COLUMN IF NOT EXISTS search_document tsvector
  GENERATED ALWAYS AS(to_tsvector('english'::regconfig,coalesce(title,'')||' '||coalesce(outcome_label,'')||' '||ticker)) STORED;
CREATE INDEX IF NOT EXISTS snapshot_search_gin ON market_lab.market_snapshots USING gin(search_document);

CREATE OR REPLACE FUNCTION market_lab.record_job_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,market_lab AS $body$
BEGIN
  INSERT INTO market_lab.job_transition_events(job_key,previous_state,state)
  VALUES(NEW.key,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.state::market_lab.job_transition_state END,NEW.state::market_lab.job_transition_state);
  PERFORM pg_notify('market_lab_jobs',json_build_object('kind',NEW.kind,'state',NEW.state)::text);
  RETURN NEW;
END
$body$;
CREATE OR REPLACE FUNCTION market_lab.maintenance_authorized(target oid,table_name text,operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,market_lab AS $body$
  SELECT coalesce(current_setting('market_lab.destructive_confirmation',true)='confirmed:'||table_name||':'||operation
    AND pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=target),'MEMBER'),false)
$body$;
CREATE OR REPLACE FUNCTION market_lab.guard_evidence_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,market_lab AS $body$
BEGIN
  IF NOT market_lab.maintenance_authorized(TG_RELID,TG_TABLE_NAME,TG_OP) THEN
    RAISE EXCEPTION 'Evidence mutation blocked; reviewed owner maintenance transaction required' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' THEN RETURN NEW; ELSIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NULL; END IF;
END
$body$;
CREATE OR REPLACE FUNCTION market_lab.guard_journal_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,market_lab AS $body$
BEGIN
  IF TG_OP='DELETE' THEN
    IF market_lab.maintenance_authorized(TG_RELID,TG_TABLE_NAME,TG_OP) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Forecast deletion blocked; reviewed owner maintenance transaction required' USING ERRCODE='42501';
  END IF;
  IF NEW.pk<>OLD.pk OR NEW.sk<>OLD.sk OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
    (NEW.payload-ARRAY['pending_pk','pending_sk','status','score','settlement_as_of']) IS DISTINCT FROM
    (OLD.payload-ARRAY['pending_pk','pending_sk','status','score','settlement_as_of']) OR
    OLD.payload->>'status'='settled' AND NEW.payload IS DISTINCT FROM OLD.payload OR
    NEW.payload->>'status'='pending' AND (NEW.payload-'pending_sk') IS DISTINCT FROM (OLD.payload-'pending_sk') OR
    NOT coalesce(NEW.payload->>'status' IN('pending','settled'),false) OR
    NEW.payload->>'pk' IS DISTINCT FROM NEW.pk OR NEW.payload->>'sk' IS DISTINCT FROM NEW.sk THEN
    RAISE EXCEPTION 'Frozen forecast fields cannot be rewritten' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$body$;
DO $body$
DECLARE name text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='market_lab.jobs'::regclass AND tgname='job_insert_transition') THEN
    CREATE TRIGGER job_insert_transition AFTER INSERT ON market_lab.jobs FOR EACH ROW EXECUTE FUNCTION market_lab.record_job_transition();
    CREATE TRIGGER job_update_transition AFTER UPDATE OF state ON market_lab.jobs FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION market_lab.record_job_transition();
  END IF;
  FOREACH name IN ARRAY ARRAY['archives','audit_events','source_batches','job_transition_events'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('market_lab.'||name)::regclass AND tgname='immutable_evidence_update') THEN
      EXECUTE format('CREATE TRIGGER immutable_evidence_update BEFORE UPDATE ON market_lab.%I FOR EACH ROW WHEN(OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION market_lab.guard_evidence_mutation()',name);
      EXECUTE format('CREATE TRIGGER immutable_evidence_delete BEFORE DELETE ON market_lab.%I FOR EACH ROW EXECUTE FUNCTION market_lab.guard_evidence_mutation()',name);
      EXECUTE format('CREATE TRIGGER immutable_evidence_truncate BEFORE TRUNCATE ON market_lab.%I FOR EACH STATEMENT EXECUTE FUNCTION market_lab.guard_evidence_mutation()',name);
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='market_lab.records'::regclass AND tgname='journal_frozen_fields') THEN
    CREATE TRIGGER journal_frozen_fields BEFORE UPDATE OR DELETE ON market_lab.records FOR EACH ROW WHEN(OLD.pk LIKE 'journal#%') EXECUTE FUNCTION market_lab.guard_journal_mutation();
    CREATE TRIGGER journal_truncate_guard BEFORE TRUNCATE ON market_lab.records FOR EACH STATEMENT EXECUTE FUNCTION market_lab.guard_evidence_mutation();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='market_lab.records'::regclass AND conname='journal_payload_identity_complete') THEN
    ALTER TABLE market_lab.records ADD CONSTRAINT journal_payload_identity_complete CHECK(pk NOT LIKE 'journal#%' OR coalesce(
      jsonb_typeof(payload)='object' AND jsonb_typeof(payload->'status')='string' AND payload->>'status' IN('pending','settled')
      AND jsonb_typeof(payload->'pk')='string' AND jsonb_typeof(payload->'sk')='string'
      AND (payload->>'pk') IS NOT DISTINCT FROM pk AND (payload->>'sk') IS NOT DISTINCT FROM sk,false)) NOT VALID;
    ALTER TABLE market_lab.records VALIDATE CONSTRAINT journal_payload_identity_complete;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='market_lab_app') THEN
    GRANT SELECT,INSERT ON market_lab.job_transition_events TO market_lab_app;
    GRANT USAGE,SELECT ON SEQUENCE market_lab.job_transition_events_id_seq TO market_lab_app;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='market_lab' AND tablename='job_transition_events' AND policyname='backend_app') THEN
      CREATE POLICY backend_app ON market_lab.job_transition_events TO market_lab_app USING(true) WITH CHECK(true);
    END IF;
  END IF;
END
$body$;
COMMIT;
