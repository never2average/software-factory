# Off Vercel: the agent's address, and a new database on plain Postgres

Two things that were only right on Vercel, and what to do about them anywhere else. On Vercel nothing here changes.

## The agent's address

The web app proxies chat to the agent API. With no address configured it used to fall back to the agent that runs
on Vercel (`https://agent-workspace-api.vercel.app`). A web app built on another machine without the address did not
fail: it built, started, and sent every chat to that Vercel agent.

Off Vercel, a production build (`next build`) or server (`next start`) now refuses to build or start without the
address, and says what to set:

```
NEXT_PUBLIC_EVE_API_URL=http://127.0.0.1:18210     # the address of YOUR agent API
```

Set it in the environment of the build and of the running server. `EVE_API_URL` is optional; if you set it, give it
the same address (a different one, or `EVE_API_URL` alone, is refused: most of the server reads the other name).

| Where | With no address |
|---|---|
| On Vercel (`VERCEL` is set) | Falls back to the Vercel agent, as before. |
| Development (`next dev`), plain-node tests | Falls back, as before. |
| An automated test build (`CI` is set), or `EVE_API_URL_OPTIONAL=1` | Falls back, as before. |
| Any other production build or server | Refuses, with the message. |

The same rule covers the session proxy (`app/eve/v1/session/[...segments]/route.ts`), which had its own copy of the
fallback.

Test: `npm run test:off-vercel-defaults` (includes one real `next build` and `next start` that must stop).

## A Postgres without TLS (`DATABASE_SSL`)

`npm run db:migrate:production` and `npm run db:migrate:task-workflows` connect with TLS required. A Postgres on
the same machine as the app usually has no TLS, and both scripts failed against it.

| `DATABASE_SSL` | Meaning |
|---|---|
| unset, empty, `require` | TLS required. The default. |
| `disable` | No TLS, and only for a database on this machine: `localhost`, `127.x.x.x`, `::1` or a unix socket. For any other host it is refused before connecting. |

Both scripts read the admin connection from `.env.supabase` and `.env.local` in the directory they are run from,
before the environment. On a server with neither file they read the environment:

| Script | Admin URL from the environment |
|---|---|
| `db:migrate:production` | `DATABASE_URL_UNPOOLED`, else `DATABASE_URL` |
| `db:migrate:task-workflows` | `DATABASE_URL_UNPOOLED` |

## A new database on plain Postgres

The migration journal alone does not build the schema the app reads. `scripts/test-migrations-db.mjs` builds a
database from the journal and lists what it lacks compared with `agent/lib/db/schema.ts`: the inbox and sign-in
code tables, `org_id NOT NULL`, and four later columns, each applied to the live database by a one-off script. The
journal also creates no role and no row-level security.

So a new database is built from `schema.ts`, the journal is recorded on top, and the role and policies are added.
A managed Supabase database has its own script for the last part (`.bootstrap-supabase.mjs`). For a plain Postgres,
`ADMIN` below is the URL of a role that owns the database (for example
`postgres://postgres:<password>@127.0.0.1:5432/app`):

```
# 1. The schema. ONLY on an empty database: on one with data, push can drop things.
DATABASE_URL="$ADMIN" npx drizzle-kit push --force

# 2. Record the migration journal, so later deploys apply only what is new.
DATABASE_SSL=disable DATABASE_URL_UNPOOLED="$ADMIN" npm run db:migrate:production

# 3. The app's role (app_rw, which cannot bypass row-level security) and the policies.
APP_RW_PASSWORD='<a long random password>' DATABASE_URL="$ADMIN" npm run db:bootstrap

# 4. The task-workflow tables.
DATABASE_SSL=disable DATABASE_URL_UNPOOLED="$ADMIN" npm run db:migrate:task-workflows

# 5. The bootstrap again, so step 4's tables get the same policies.
APP_RW_PASSWORD='<the same password>' DATABASE_URL="$ADMIN" npm run db:bootstrap
```

Leave `DATABASE_SSL=disable` out if the database has TLS.

The app then connects as `app_rw`, never as the admin role:

```
DATABASE_URL=postgres://app_rw:<the password>@127.0.0.1:5432/app
```

`npm run db:bootstrap` is `scripts/bootstrap-test-db.mjs --production`: the script CI builds its database with,
plus what a deployment needs. It requires `APP_RW_PASSWORD` (there is no default), creates every workspace policy
fail-closed (a query that names no workspace sees no rows, as on the live deployments), grants tables created later
to `app_rw`, and prints the app's URL without the password. It can be run again at any time.

Later deploys run steps 2 and 4 only, as `make migrate-production` does. Never run step 1 on a database that holds
data.

Test: `npm run test:new-database-db` runs these five steps against a scratch database on a Postgres with no TLS and
checks the result as `app_rw`.
