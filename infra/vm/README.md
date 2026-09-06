# infra/vm

VM target. Current host: DigitalOcean droplet, 4 vCPU / 8 GB / 154 GB, Ubuntu 24.04, SSH alias `digitalocean`.

Provisioned 2026-09-06 by `provision.sh` (idempotent, rerun on a fresh box): node 22, npm, docker engine + compose, Vercel CLI, Playwright + chromium with system deps. Verified: `npm ci` and `npm run typecheck` pass in `molds/mold_v1/codebase`.
