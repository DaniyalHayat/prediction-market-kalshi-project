FROM postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
WORKDIR /bootstrap
COPY web/database/001_market_lab.sql web/database/002_pipeline.sql web/database/003_runtime_safety.sql web/database/004_owner_portfolios.sql web/database/005_engineering_events.sql web/database/006_public_evidence.sql ./database/
COPY terraform/azure/bootstrap/apply.sql terraform/azure/bootstrap/legacy-access.sql terraform/azure/bootstrap/verify.sql terraform/azure/bootstrap/run.sh ./
USER postgres
ENTRYPOINT ["/bin/bash", "/bootstrap/run.sh"]
