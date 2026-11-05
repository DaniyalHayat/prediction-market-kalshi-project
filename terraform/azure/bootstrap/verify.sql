BEGIN;

DO $verify$
DECLARE
  probe uuid := gen_random_uuid();
  journal text := 'journal#bootstrap-' || probe;
  archive text := 'bootstrap/' || probe;
  batch bigint;
  saved bigint;
  verified_ssl boolean;
BEGIN
  SELECT ssl INTO verified_ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();
  IF current_user <> 'market_lab_app' OR current_database() <> 'predictir' OR verified_ssl IS DISTINCT FROM true
    OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname=current_user AND rolconnlimit=12 AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR has_database_privilege(current_user,current_database(),'CREATE,TEMP')
    OR has_schema_privilege(current_user,'market_lab','CREATE')
    OR has_schema_privilege(current_user,'public','CREATE')
    OR has_table_privilege(current_user,'market_lab.archives','UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user,'market_lab.operational_events','SELECT,INSERT')
    OR NOT row_security_active('market_lab.records') OR NOT row_security_active('market_lab.owner_portfolios')
    OR NOT EXISTS (SELECT FROM pg_extension WHERE extname='pgcrypto') THEN
    RAISE EXCEPTION 'Runtime login security invariants failed';
  END IF;

  INSERT INTO market_lab.owner_portfolios(owner_id,ledger) VALUES (probe,'{}');
  UPDATE market_lab.owner_portfolios SET revision=revision+1 WHERE owner_id=probe AND revision=1 RETURNING revision INTO saved;
  IF saved IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'Portfolio compare-and-swap failed'; END IF;

  INSERT INTO market_lab.records(pk,sk,payload) VALUES
    (journal,'forecast#bootstrap',jsonb_build_object('pk',journal,'sk','forecast#bootstrap','status','pending','immutable',42));
  UPDATE market_lab.records SET payload=payload||'{"status":"settled"}' WHERE pk=journal;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal settlement failed'; END IF;
  BEGIN
    UPDATE market_lab.records SET payload=payload||'{"immutable":43}' WHERE pk=journal;
    RAISE EXCEPTION 'Frozen journal update was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  INSERT INTO market_lab.leases(key,owner,expires_at) VALUES (archive,probe,now()+interval '1 minute');
  DELETE FROM market_lab.leases WHERE key=archive AND owner=probe;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lease release failed'; END IF;
  INSERT INTO market_lab.quotas(key,used,expires_at) VALUES (archive,1,now()+interval '1 minute');
  UPDATE market_lab.quotas SET used=2 WHERE key=archive;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quota update failed'; END IF;

  INSERT INTO market_lab.archives(key,sha256,payload) VALUES (archive,repeat('0',64),'{}');
  INSERT INTO market_lab.audit_heads(id,last_hash) VALUES (probe,repeat('0',64));
  INSERT INTO market_lab.audit_events(id,type,hash,archive_key,recorded_at) VALUES (probe,'freeze',repeat('0',64),archive,now());
  INSERT INTO market_lab.source_batches(provider,source_url,sha256,archive_key,schema_version,row_count)
    VALUES (archive,'https://example.invalid',repeat('0',64),archive,1,0) RETURNING id INTO batch;
  INSERT INTO market_lab.market_snapshots(ticker,observed_at,event_ticker,title,category,batch_id)
    VALUES (archive,now(),'BOOTSTRAP','Bootstrap','test',batch);
  PERFORM 1 FROM market_lab.market_attribution WHERE ticker=archive;
  IF NOT FOUND THEN RAISE EXCEPTION 'Market attribution read failed'; END IF;
  INSERT INTO market_lab.jobs(key,kind) VALUES (archive,'bootstrap');
  PERFORM 1 FROM market_lab.job_transition_events WHERE job_key=archive AND state='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline transition trigger failed'; END IF;
END
$verify$;
ROLLBACK;
