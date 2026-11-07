FROM postgres:17-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac
WORKDIR /bootstrap
COPY web/database/001_market_lab.sql web/database/002_pipeline.sql web/database/003_runtime_safety.sql web/database/004_owner_portfolios.sql web/database/005_engineering_events.sql web/database/006_public_evidence.sql ./database/
COPY terraform/azure/bootstrap/apply.sql terraform/azure/bootstrap/legacy-access.sql terraform/azure/bootstrap/verify.sql terraform/azure/bootstrap/run.sh ./
USER postgres
ENTRYPOINT ["/bin/bash", "/bootstrap/run.sh"]
