BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS market_lab.public_evidence_chunks(
  ticker text NOT NULL,
  id char(64) NOT NULL,
  source_url text NOT NULL CHECK(source_url LIKE 'https://%'),
  title text NOT NULL CHECK(length(title)<=400),
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 1200),
  publisher text NOT NULL CHECK(length(publisher)<=160),
  source_kind text NOT NULL,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  embedding double precision[],
  model_id text,
  model_revision char(40),
  search_document tsvector GENERATED ALWAYS AS(to_tsvector('english'::regconfig,title||' '||content)) STORED,
  PRIMARY KEY(ticker,id),
  CHECK(embedding IS NULL OR cardinality(embedding)=384),
  CHECK(expires_at>retrieved_at)
);
CREATE INDEX IF NOT EXISTS evidence_ticker_recent ON market_lab.public_evidence_chunks(ticker,retrieved_at DESC);
CREATE INDEX IF NOT EXISTS evidence_expiry ON market_lab.public_evidence_chunks(expires_at);
CREATE INDEX IF NOT EXISTS evidence_search ON market_lab.public_evidence_chunks USING gin(search_document);
ALTER TABLE market_lab.public_evidence_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON market_lab.public_evidence_chunks FROM PUBLIC;
DO $body$
DECLARE vector_schema text;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Vector installation unavailable to this role; retained-array cosine remains supported';
    END;
  END IF;
  SELECT n.nspname INTO vector_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector';
  IF vector_schema IS NOT NULL THEN
    EXECUTE format('ALTER TABLE market_lab.public_evidence_chunks ADD COLUMN IF NOT EXISTS embedding_vector %I.vector(384)',vector_schema);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='market_lab_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON market_lab.public_evidence_chunks TO market_lab_app;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='market_lab' AND tablename='public_evidence_chunks' AND policyname='backend_app') THEN
      CREATE POLICY backend_app ON market_lab.public_evidence_chunks TO market_lab_app USING(true) WITH CHECK(true);
    END IF;
  END IF;
END
$body$;
COMMIT;
