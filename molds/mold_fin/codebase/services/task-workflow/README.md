# Task Workflow Service

API-only Next.js microservice that owns task workflow mutations for the FDE
workspace. It stores immutable definition versions, pins each task to a version,
validates stage transitions, records an append-only transition ledger, and runs
stage assignment automation with Vercel Workflow.

The browser never calls this service directly. The main Ops API and Eve runtime
authenticate their users, then forward only the resolved workspace, actor, and
role using `TASK_WORKFLOW_SERVICE_TOKEN`.

Required environment variables:

- `DATABASE_URL` — the shared application-role Postgres connection
- `TASK_WORKFLOW_SERVICE_TOKEN` — internal bearer token shared with callers

Run locally with `npm run dev`; verify with `npm run typecheck`, `npm test`, and
`npm run build`.
