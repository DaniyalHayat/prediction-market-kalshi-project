FROM node:26.12.1-bookworm-slim
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
COPY --chown=node:node research-data/weather-settlement-archive.json ./research-data/weather-settlement-archive.json
RUN mkdir -p /tmp/market-lab-models && chown node:node /tmp/market-lab-models
USER node
EXPOSE 8780
CMD ["node", "--max-old-space-size=384", "cloud/railway.mjs"]
