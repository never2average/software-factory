# infra/vercel

Vercel target. CLI is logged in on the VM as `your-vercel-team` (team `your-vercel-team`, orgId `team_mUzQJcvvpaGJK9j8luNIDzY7`).

## Factory project (linked 2026-09-06)

| Project | Id | Linked from | Purpose |
|---|---|---|---|
| claudecode-web | prj_ckb1e5ES08k2EdKzcWIApWVuiXel | `molds/mold_v1/codebase` | product claudecode_web, Next.js app (`vercel.json`) |

`.vercel/` and `.env.local` are git-ignored; re-run `vercel link --yes --project claudecode-web` inside the mold on a fresh checkout. No env vars set yet and nothing deployed.

## Live reference deployment (do not touch from the factory)

The upstream fde-agent runs as three projects, one per config file: `fde-agent` (`vercel.json`, Next app + crons), `fde-agent-api` (`vercel.api.json`, eve API), `fde-task-workflow` (`vercel.eve.json`, eve workflow service). A stamped product needs the same split: create `claudecode-web-api` and `claudecode-web-workflow` when deploying (task mold_v1-009).

`env-names.fde-agent.txt` lists the 32 production env var **names** on the live app (values never recorded). Use it as the `secrets` list in `infrastructure.json`. Note the live datastore is Supabase Postgres, not Neon; `datastores.schema.json` allows both.
