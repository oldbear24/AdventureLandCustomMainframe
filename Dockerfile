FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
