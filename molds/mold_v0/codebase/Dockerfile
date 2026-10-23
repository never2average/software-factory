# The server: landing page, MCP endpoint, orchestrator worker API.
# The admin panel and portal (web/, a server-rendered Next.js app) are their own image, web/Dockerfile, and their own
# service in deploy/docker-compose.prod.yml behind the same Caddy (mold_v0-020); nothing of web/ is in this image.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3333
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Run sandboxes on a server of its own (mold_v0-055, src/run-sandboxes.ts): each run is a container of this same image,
# started as root only to lock its run user down (nftables) and switch to it. git for agent-workspace runs; the run's
# user (octirun) and the egress proxy's (octiproxy), neither with a login or sudo. The server itself runs as node.
# The run tools the packs' agent kinds declare (mold_v0-072; src/run-tools.generated.json, written by gen-packs): each
# at its pinned version, its artifact checked against src/run-tools.ts's sha256 before it is unpacked into
# /opt/octi-tools (root's). A run never downloads a tool: the harness checks these and refuses a kind the image lacks.
COPY src/run-tools.ts src/run-tools.generated.json ./src/
COPY scripts/install-run-tools.ts ./scripts/
RUN apt-get update && apt-get install -y --no-install-recommends git nftables iptables ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -M -u 10001 -s /usr/sbin/nologin octirun && useradd -r -M -s /usr/sbin/nologin octiproxy \
 && node --import tsx scripts/install-run-tools.ts --from src/run-tools.generated.json --dir /opt/octi-tools
COPY tsconfig.json ./
COPY sql ./sql
COPY src ./src
COPY scripts ./scripts
# Packs (mold_v0-038): their code is imported through src/packs.generated.ts, their migrations read at start.
COPY packs ./packs
COPY public ./public
COPY harnesses ./harnesses
# Orchestrator sources (no node_modules, no Pi clone, no tests): the autoscaler (src/autoscaler.ts) imports
# orchestrator/deploy/boat-lib.ts, and tars these same files for orchestrator sandboxes / the snapshot image.
COPY orchestrator/package.json orchestrator/package-lock.json orchestrator/tsconfig.json orchestrator/worker.ts orchestrator/main.ts orchestrator/packs.generated.ts ./orchestrator/
COPY orchestrator/core ./orchestrator/core
COPY orchestrator/deploy ./orchestrator/deploy
COPY orchestrator/fleet ./orchestrator/fleet
# The whole directory: the worker sandbox also gets files from here (acp-client.mjs for Zed personas).
COPY orchestrator/harnesses ./orchestrator/harnesses
COPY orchestrator/images ./orchestrator/images
COPY orchestrator/packs ./orchestrator/packs
COPY orchestrator/workspaces ./orchestrator/workspaces
# Refused at build when the image lacks a tool a pack's agent kind declares (the generated list, as the code has it).
RUN node --import tsx scripts/install-run-tools.ts --verify --from src/run-tools.generated.json --dir /opt/octi-tools
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3333/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Plain node (not npx) so SIGTERM reaches the server; run with an init (compose `init: true`) as PID 1.
CMD ["node", "--import", "tsx", "--import", "./src/otel.ts", "src/http.ts"]
