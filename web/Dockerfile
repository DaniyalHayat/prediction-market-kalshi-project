FROM node:26.12.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node app/api ./app/api
COPY --chown=node:node lib ./lib
COPY --chown=node:node cloud ./cloud
COPY --chown=node:node public ./public
COPY --chown=node:node database ./database
USER node
EXPOSE 8780
CMD ["node", "--max-old-space-size=384", "cloud/railway.mjs"]
