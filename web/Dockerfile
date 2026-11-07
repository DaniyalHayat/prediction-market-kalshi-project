FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0
ENV NODE_ENV=production
ENV SEMANTIC_MODEL_CACHE_DIR=/tmp/market-lab-models
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node app/api ./app/api
COPY --chown=node:node lib ./lib
COPY --chown=node:node cloud ./cloud
COPY --chown=node:node public ./public
COPY --chown=node:node database ./database
COPY --chown=node:node research-data/crypto-minute-archive.json.gz research-data/nba-completed-games-2026-11-04.json.gz research-data/nba-quarter-replay-2026-11-04.json.gz research-data/nfl-heldout-predictions-2025.json research-data/settlement-calibration-archive.json research-data/weather-settlement-archive.json research-data/weekly-tsa-archive.json ./research-data/
RUN mkdir -p /tmp/market-lab-models && chown node:node /tmp/market-lab-models
USER node
EXPOSE 8780
CMD ["node", "--max-old-space-size=384", "cloud/railway.mjs"]
