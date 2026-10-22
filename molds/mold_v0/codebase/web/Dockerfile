# The web console (admin panel /admin, customer portal /app, sign-in /auth, the public pages) on a server of its own
# (mold_v0-020): Next.js standalone output (next.config.ts BUILD_STANDALONE), its own service in
# deploy/docker-compose.prod.yml behind the stack's Caddy. On Vercel the same web/ is its own project (mold_v0-029).
#
# Built from the codebase root (compose: context .., dockerfile web/Dockerfile): the build bundles ../docs and a host
# pack's ../packs/<id>/docs into the admin docs (web/scripts/sync-docs.mjs); a host pack's console files are already
# under web/src/packs/<id>/ in the copy being built (the factory's build/<app_id>/).
#
# Build arguments are PUBLIC values only, never a secret: Next.js writes them into the build itself.
#   OCTILLION_API_URL                  the API service inside the compose network; the console's fallback rewrite
#                                      (next.config.ts) is fixed at build time, so it is set here and again at run time
#   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY  Clerk's publishable key (sent to every browser; the browser bundle needs it)
#   NEXT_PUBLIC_APP_URL                the public address (absolute icon and share-image URLs)
# CLERK_SECRET_KEY is given at run time only (compose environment), never here.
FROM node:22-slim AS build
WORKDIR /src/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
COPY docs /src/docs
COPY packs /src/packs
ARG OCTILLION_API_URL=http://octillion:3333
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ARG NEXT_PUBLIC_APP_URL=
# The sign-in (mold_v0-004): builtin or clerk; empty: Clerk when the publishable key is given, else the built-in one.
ARG AUTH_PROVIDER=
RUN BUILD_STANDALONE=true OCTILLION_API_URL="$OCTILLION_API_URL" NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" AUTH_PROVIDER="$AUTH_PROVIDER" \
    NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" npm run build \
 && test -f .next/standalone/server.js

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3400
# The server's files belong to root and are read-only to it; only Next.js's own cache (.next/cache) is writable.
COPY --from=build /src/web/.next/standalone ./
COPY --from=build /src/web/.next/static ./.next/static
COPY --from=build /src/web/public ./public
RUN install -d -o node -g node -m 755 /app/.next/cache
USER node
EXPOSE 3400
# /healthz is the API's, reached THROUGH the console's fallback rewrite: healthy means the console serves and reaches the API.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
