// Migration: Org (workspace) tenancy layer — the tenant layer ABOVE customers,
// roster, connectors, workflows, apps, cycles, todos, memories, schedules,
// secrets, and the automation/activity feeds. OnFinance becomes org #1
// (slug 'onfinance').
//
// SAFE BY DESIGN — additive + idempotent + NULLABLE-FIRST:
//   * new tables: orgs, org_members, org_invites, platform_admins, recipes
//   * new NULLABLE `org_id` column on each global table, backfilled to
//     'onfinance'. NO column is made NOT NULL here — the NOT-NULL + composite-PK
//     tightening is a SEPARATE later migration, run only once every write path
//     stamps org_id. Nothing here can lock a table or break an existing query.
//
// Because org_id stays nullable and backfills to 'onfinance', the running app
// behaves EXACTLY as today (single implicit org) until the org-aware code ships.
//
// Review the DDL, then run:  ! node .migrate-org-tenancy.mjs
import postgres from "postgres";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

// The org #1 backfill target. Its Google Workspace domain is what today's
// hard-coded ALLOWED_DOMAIN gate accepts, so the hd → org lookup keeps working.
const ORG = "onfinance";
const ORG_NAME = "OnFinance";
const ORG_DOMAIN = "onfinance.in";

/* -------------------------------------------------------------------------- */
/* 1. New tables                                                              */
/* -------------------------------------------------------------------------- */

await sql`
  CREATE TABLE IF NOT EXISTS orgs (
    org_id text PRIMARY KEY,
    name text NOT NULL,
    google_hosted_domain text UNIQUE,
    branding jsonb,
    plan text,
    limits jsonb,
    billing jsonb,
    blob_prefix text,
    data_residency text,
    status text NOT NULL DEFAULT 'provisioning',
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE TABLE IF NOT EXISTS org_members (
    org_id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL DEFAULT 'member',
    invited_by text,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, email)
  )`;
await sql`CREATE INDEX IF NOT EXISTS org_members_email_idx ON org_members (email)`;

await sql`
  CREATE TABLE IF NOT EXISTS org_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL DEFAULT 'member',
    token_hash text NOT NULL,
    invited_by text,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites (org_id)`;
await sql`CREATE INDEX IF NOT EXISTS org_invites_token_idx ON org_invites (token_hash)`;

await sql`
  CREATE TABLE IF NOT EXISTS platform_admins (
    email text PRIMARY KEY,
    added_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE TABLE IF NOT EXISTS recipes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text,
    slug text NOT NULL,
    version text NOT NULL DEFAULT '1',
    title text NOT NULL,
    summary text,
    body text,
    satisfies_check text,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS recipes_org_slug_idx ON recipes (org_id, slug)`;

/* -------------------------------------------------------------------------- */
/* 2. Nullable org_id on every global table (customer-scoped tables inherit    */
/*    their org through the customer FK, so only `customers` needs it here).   */
/* -------------------------------------------------------------------------- */

const ORG_SCOPED = [
  "customers",
  "connectors",
  "connector_secrets",
  "workflows",
  "apps",
  "cycles",
  "todos",
  "people_roster",
  "memories",
  "schedule_rules",
  "automation_runs",
  "automation_audit",
  "entity_activity",
  "comments",
];

for (const table of ORG_SCOPED) {
  // DEFAULT '<org>' means an insert that doesn't yet stamp org_id can NEVER
  // produce a NULL row (which would vanish once org filters apply) — the
  // single-org world stays consistent with zero route changes, and this is the
  // safety net during the multi-tenant cutover. Phase 3 (NOT NULL tightening)
  // DROPs the default once every write path stamps the caller's org explicitly.
  await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS org_id text DEFAULT '${ORG}'`);
  // Ensure the default is set even if the column pre-existed without one.
  await sql.unsafe(`ALTER TABLE ${table} ALTER COLUMN org_id SET DEFAULT '${ORG}'`);
  // Backfill existing rows to org #1. Idempotent: only touches NULLs.
  await sql.unsafe(`UPDATE ${table} SET org_id = '${ORG}' WHERE org_id IS NULL`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ${table}_org_idx ON ${table} (org_id)`);
}

/* -------------------------------------------------------------------------- */
/* 3. Seed org #1 + its owner + the built-in recipe catalog                    */
/* -------------------------------------------------------------------------- */

await sql`
  INSERT INTO orgs (org_id, name, google_hosted_domain, blob_prefix, status, created_by)
  VALUES (${ORG}, ${ORG_NAME}, ${ORG_DOMAIN}, ${"orgs/" + ORG}, 'active', 'system')
  ON CONFLICT (org_id) DO UPDATE
    SET google_hosted_domain = EXCLUDED.google_hosted_domain,
        status = 'active'`;

// Everyone already on the roster becomes a member of org #1 (member role);
// the platform operator is added below as owner + platform admin.
await sql`
  INSERT INTO org_members (org_id, email, role, accepted_at)
  SELECT ${ORG}, email, 'member', now() FROM people_roster
  ON CONFLICT (org_id, email) DO NOTHING`;

const OPERATOR = "operator@example.com";
await sql`
  INSERT INTO org_members (org_id, email, role, accepted_at)
  VALUES (${ORG}, ${OPERATOR}, 'owner', now())
  ON CONFLICT (org_id, email) DO UPDATE SET role = 'owner', accepted_at = now()`;
await sql`
  INSERT INTO platform_admins (email, added_by)
  VALUES (${OPERATOR}, 'system')
  ON CONFLICT (email) DO NOTHING`;

const RECIPES = [
  ["onboard-self", "Sign in & record yourself", "Get signed in, wired to the data room over MCP, and recorded as an operator.", "members"],
  ["import-roster", "Import the roster", "Pull people from Google Directory or a CSV into the roster.", "roster"],
  ["connect-sources", "Connect a source", "Wire one connector (GitHub, Slack, …) and store its secret.", "connector"],
  ["seed-workflows", "Seed the workflow library", "Install the starter workflow library, default apps, and crons.", "workflows"],
  ["onboard-customer", "Onboard the first customer", "Create the first customer account and its data-room skeleton.", "customer"],
];
let order = 0;
for (const [slug, title, summary, check] of RECIPES) {
  await sql`
    INSERT INTO recipes (org_id, slug, version, title, summary, satisfies_check, sort_order)
    VALUES (NULL, ${slug}, '1', ${title}, ${summary}, ${check}, ${order})
    ON CONFLICT DO NOTHING`;
  order += 1;
}

/* -------------------------------------------------------------------------- */
/* 4. Verify                                                                  */
/* -------------------------------------------------------------------------- */

const [t] = await sql`
  SELECT
    to_regclass('public.orgs') AS orgs,
    to_regclass('public.org_members') AS members,
    to_regclass('public.org_invites') AS invites,
    to_regclass('public.platform_admins') AS admins,
    to_regclass('public.recipes') AS recipes,
    (SELECT count(*) FROM orgs) AS org_count,
    (SELECT count(*) FROM org_members WHERE org_id = ${ORG}) AS member_count,
    (SELECT count(*) FROM recipes WHERE org_id IS NULL) AS recipe_count`;
console.log("orgs:", t.orgs ? "OK" : "MISSING", `(count ${t.org_count})`);
console.log("org_members:", t.members ? "OK" : "MISSING", `(onfinance members ${t.member_count})`);
console.log("org_invites:", t.invites ? "OK" : "MISSING");
console.log("platform_admins:", t.admins ? "OK" : "MISSING");
console.log("recipes:", t.recipes ? "OK" : "MISSING", `(built-in ${t.recipe_count})`);

// Confirm the org_id backfill on a representative scoped table.
const [backfill] = await sql`
  SELECT
    (SELECT count(*) FROM customers WHERE org_id IS NULL) AS cust_null,
    (SELECT count(*) FROM todos WHERE org_id IS NULL) AS todo_null,
    (SELECT count(*) FROM people_roster WHERE org_id IS NULL) AS roster_null`;
console.log(
  "org_id backfill (should all be 0 nulls):",
  `customers=${backfill.cust_null}, todos=${backfill.todo_null}, roster=${backfill.roster_null}`,
);

await sql.end();
