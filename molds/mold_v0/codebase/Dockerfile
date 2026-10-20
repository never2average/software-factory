# Octillion server: landing page, MCP endpoint, orchestrator worker API, admin panel and customer portal.
# The admin panel and portal (web/, Next.js) build to static files the server serves.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3333
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY sql ./sql
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY --from=web /web/out ./web/out
COPY harnesses ./harnesses
# Curated developer profiles and task library (npm run vault:sync with VAULT_DIR=vault/curated).
COPY vault ./vault
# Orchestrator sources (no node_modules, no Pi clone, no tests): the autoscaler (src/autoscaler.ts) imports
# orchestrator/deploy/boat-lib.ts, and tars these same files for orchestrator sandboxes / the snapshot image.
COPY orchestrator/package.json orchestrator/package-lock.json orchestrator/tsconfig.json orchestrator/worker.ts ./orchestrator/
COPY orchestrator/core ./orchestrator/core
COPY orchestrator/deploy ./orchestrator/deploy
COPY orchestrator/fleet ./orchestrator/fleet
# The whole directory: the worker sandbox also gets files from here (acp-client.mjs for Zed personas).
COPY orchestrator/harnesses ./orchestrator/harnesses
COPY orchestrator/images ./orchestrator/images
COPY orchestrator/pi-octillion ./orchestrator/pi-octillion
COPY orchestrator/workspaces ./orchestrator/workspaces
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3333/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Plain node (not npx) so SIGTERM reaches the server; run with an init (compose `init: true`) as PID 1.
CMD ["node", "--import", "tsx", "--import", "./src/otel.ts", "src/http.ts"]
