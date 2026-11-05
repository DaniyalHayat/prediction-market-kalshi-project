SELECT pg_advisory_lock(907260612025155318);

DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='market_lab_app') THEN
    CREATE ROLE market_lab_app LOGIN CONNECTION LIMIT 12;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles r
    WHERE r.rolname='market_lab_app' AND (
      r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member=r.oid)
    )
  ) THEN
    RAISE EXCEPTION 'Existing runtime login has unexpected elevated permissions';
  END IF;
END
$role$;
ALTER ROLE market_lab_app LOGIN CONNECTION LIMIT 12;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\ir database/001_market_lab.sql
\ir database/002_pipeline.sql
\ir database/003_runtime_safety.sql
\ir database/004_owner_portfolios.sql
\ir database/005_engineering_events.sql
\ir database/006_public_evidence.sql
\ir legacy-access.sql
