FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=predictir-public-npm,target=/root/.npm npm pkg delete dependencies.next dependencies.react dependencies.react-dom dependencies.lucide-react dependencies.uplot dependencies.payload 'dependencies.@payloadcms/db-sqlite' \
    && npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund \
    && mkdir -p /tmp/market-lab-models

FROM gcr.io/distroless/nodejs26-debian13@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8 AS node-runtime
FROM gcr.io/distroless/base-nossl-debian13@sha256:e6b0f82595aa1edde72c8054de7a9dca30f0f8f54820c37a167c0ddfc21c5c67 AS runtime
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=node-runtime /nodejs /nodejs
COPY --from=node-runtime /usr/lib/*-linux-gnu/libatomic.so.1* /usr/lib/*-linux-gnu/libgcc_s.so.1 /usr/lib/*-linux-gnu/libgomp.so.1* /usr/lib/*-linux-gnu/libstdc++.so.6* /usr/lib/
COPY --from=node-runtime /var/lib/dpkg/status.d/gcc-14-base /var/lib/dpkg/status.d/libatomic1 /var/lib/dpkg/status.d/libgcc-s1 /var/lib/dpkg/status.d/libgomp1 /var/lib/dpkg/status.d/libstdc++6 /var/lib/dpkg/status.d/
COPY --from=node-runtime /usr/share/doc/gcc-14-base /usr/share/doc/gcc-14-base
COPY --from=node-runtime /usr/share/doc/libatomic1 /usr/share/doc/libatomic1
COPY --from=node-runtime /usr/share/doc/libgcc-s1 /usr/share/doc/libgcc-s1
COPY --from=node-runtime /usr/share/doc/libgomp1 /usr/share/doc/libgomp1
COPY --from=node-runtime /usr/share/doc/libstdc++6 /usr/share/doc/libstdc++6

FROM runtime
ENV NODE_ENV=production SEMANTIC_MODEL_CACHE_DIR=/tmp/market-lab-models
WORKDIR /app
COPY --from=dependencies --chown=65532:65532 /app/package.json /app/package-lock.json ./
COPY --from=dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=dependencies --chown=65532:65532 /tmp/market-lab-models /tmp/market-lab-models
COPY --chown=65532:65532 app/api ./app/api
COPY --chown=65532:65532 lib ./lib
COPY --chown=65532:65532 cloud ./cloud
COPY --chown=65532:65532 public ./public
COPY --chown=65532:65532 database ./database
COPY --chown=65532:65532 research-data/crypto-minute-archive.json.gz research-data/nba-completed-games-2026-11-04.json.gz research-data/nba-quarter-replay-2026-11-04.json.gz research-data/nfl-heldout-predictions-2025.json research-data/settlement-calibration-archive.json research-data/weather-settlement-archive.json research-data/weekly-tsa-archive.json ./research-data/
USER 65532:65532
EXPOSE 8780
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["--max-old-space-size=384", "cloud/railway.mjs"]
