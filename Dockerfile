FROM node:24.21.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node data ./data
RUN mkdir -p /app/runtime && chown node:node /app/runtime
USER node
EXPOSE 3000
CMD ["node", "scripts/container-start.mjs"]
