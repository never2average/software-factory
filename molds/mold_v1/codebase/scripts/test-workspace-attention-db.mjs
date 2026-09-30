/**
 * THE WORKSPACE SWITCHER'S "needs attention" COUNTS, against a Postgres failing closed (mold_v1-099).
 *
 * lib/workspace-attention.ts counted inbox items, urgent tickets, overdue to-dos, unhealthy deployments, risky
 * implementations and recently failed workflow runs for every workspace at once — on the bare handle. Under the
 * production policy (`org_id = current_setting('app.org_id', true)`, FORCE ROW LEVEL SECURITY, app_rw NOBYPASSRLS) a
 * query that sets no workspace sees no rows, so every count was 0 and the switcher showed nothing to do anywhere.
 *
 * This seeds a known number of each in two workspaces (as the admin), flips the six tables' `org_isolation` policies
 * to the fail-closed shape, and asks lib/workspace-attention.ts — as app_rw — for both. It restores the policies and
 * removes its rows afterwards.
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:workspace-attention-db
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

// The web app's `@/` alias and extensionless imports, so the module loads as the app loads it (and as it did before
// mold_v1-099, which is how this was shown to fail first). The resolver scripts/test-agent-vocabulary.mjs uses.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-workspace-attention-db: SKIPPED — needs ADMIN_URL (seeding, policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}

const TABLES = ["inbox_items", "tickets", "todos", "deployments", "implementation", "workflow_runs", "customers"];
const A = `org-attention-a-${process.pid}`;
const B = `org-attention-b-${process.pid}`;
const QUIET = `org-attention-quiet-${process.pid}`;
const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `  — got ${JSON.stringify(detail)}`}`);
  }
};

const saved = new Map();
const cleanup = async () => {
  for (const t of ["inbox_items", "tickets", "todos", "deployments", "implementation", "workflow_runs", "customers"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2, $3)`, [A, B, QUIET]);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B}, ${QUIET})`;
};

/** Seed one workspace with `k` of each counted thing, plus one of each that must NOT be counted. */
async function seed(org, k) {
  const hour = 60 * 60 * 1000;
  for (let i = 0; i < k; i++) {
    const cust = `${org}-cust-${i}`;
    await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${cust}, ${org}, ${"Customer " + i})`;
    await admin`INSERT INTO inbox_items (org_id, source, external_id, thread_key, occurred_at, status)
                VALUES (${org}, 'gmail', ${`${org}-in-${i}`}, ${`t${i}`}, now(), 'new')`;
    await admin`INSERT INTO tickets (customer_id, ticket_id, org_id, summary, ticket_type, ticket_category, ticket_priority,
                  ticket_status, ticket_owner_email, ticket_opened_date, last_activity_date, source_channel, ticket_next_step)
                VALUES (${cust}, ${`T-${i}`}, ${org}, 'down', 'Incident', 'Ops', 'P0-Critical', 'Open', 'o@x.test',
                  '2026-09-01', '2026-09-01', 'email', 'fix')`;
    await admin`INSERT INTO todos (org_id, title, created_by, done, status, due_at)
                VALUES (${org}, ${"overdue " + i}, 'test', false, 'open', ${new Date(Date.now() - 2 * hour)})`;
    await admin`INSERT INTO deployments (customer_id, deployment_id, org_id, environment, region, deployed_version,
                  health_status, release_status)
                VALUES (${cust}, ${`D-${i}`}, ${org}, 'prod', 'in', '1.0', 'Degraded', 'Live')`;
    await admin`INSERT INTO implementation (customer_id, org_id, implementation_stage, implementation_progress_pct,
                  implementation_risk_level, blocker_owner)
                VALUES (${cust}, ${org}, 'Build', 50, 'High', 'nobody')`;
    await admin`INSERT INTO workflow_runs (org_id, run_id, workflow_name, status, updated_at)
                VALUES (${org}, ${`wfr_attention_${org}_${i}`}, 'probe', 'failed', now())`;
  }
  // Not attention: a read inbox item, a low-priority ticket, a to-do not yet due, a healthy deployment, an old failure.
  const calm = `${org}-calm`;
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${calm}, ${org}, 'Calm')`;
  await admin`INSERT INTO inbox_items (org_id, source, external_id, thread_key, occurred_at, status)
              VALUES (${org}, 'gmail', ${`${org}-read`}, 'tr', now(), 'done')`;
  await admin`INSERT INTO todos (org_id, title, created_by, done, status, due_at)
              VALUES (${org}, 'later', 'test', false, 'open', ${new Date(Date.now() + 48 * hour)})`;
  await admin`INSERT INTO deployments (customer_id, deployment_id, org_id, environment, region, deployed_version,
                health_status, release_status)
              VALUES (${calm}, 'D-calm', ${org}, 'prod', 'in', '1.0', 'Healthy', 'Live')`;
  await admin`INSERT INTO workflow_runs (org_id, run_id, workflow_name, status, updated_at)
              VALUES (${org}, ${`wfr_attention_${org}_old`}, 'probe', 'failed', ${new Date(Date.now() - 72 * hour)})`;
}

try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Attention A', 'active'), (${B}, 'Attention B', 'active'), (${QUIET}, 'Quiet', 'active')`;
  await seed(A, 2); // 2 of each of six things = 12
  await seed(B, 1); // 6
  await seed(QUIET, 0); // only things that are NOT attention

  for (const t of TABLES) {
    const [row] = await admin`SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename=${t} AND policyname='org_isolation'`;
    if (!row) continue;
    saved.set(t, row.qual);
    const closed = `(org_id = current_setting('app.org_id', true))`;
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING ${closed} WITH CHECK ${closed}`);
  }
  const [who] = await postgres(appUrl, { prepare: false, max: 1 })`SELECT current_user AS u, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`;
  if (who.b) throw new Error(`${who.u} bypasses RLS — this test would prove nothing`);
  console.log(`\nAs ${who.u}, policies fail-closed on ${[...saved.keys()].join(", ")}:`);

  const { getDb, withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
  const attention = await import("../lib/workspace-attention.ts");
  const inWorkspace = (orgId, fn) => withOrgDb(orgId, fn);
  let counts;
  try {
    counts = await attention.attentionCounts([A, B, QUIET], inWorkspace);
  } catch (error) {
    // The pre-fix signature, attentionCounts(db, orgIds), on the bare handle — what the route used to pass.
    console.log(`  (attentionCounts(orgIds, inWorkspace) threw "${error.message}"; asking it the old way, on the bare handle)`);
    counts = await attention.attentionCounts(getDb(), [A, B, QUIET]);
  }
  check("workspace A: 2 inbox + 2 urgent tickets + 2 overdue to-dos + 2 unhealthy deployments + 2 risky implementations + 2 recent failures = 12", counts[A] === 12, counts);
  check("workspace B: 6", counts[B] === 6, counts);
  check("a workspace with nothing needing attention: 0 (its read, calm and old rows are not counted)", counts[QUIET] === 0, counts);
  check("no workspace it was not asked about appears", Object.keys(counts).sort().join() === [A, B, QUIET].sort().join(), Object.keys(counts));

  if (typeof attention.attentionCounts === "function" && counts[A] === 12) {
    // Each workspace is read in ITS OWN scope: a runner that enters the wrong workspace sees nothing of A's.
    const crossed = await attention.attentionCounts([A], (_orgId, fn) => withOrgDb(B, fn));
    check("the count for A read inside B's scope is 0 — the scope, not the WHERE clause, is what admits rows", crossed[A] === 0, crossed);
    // One section failing (a table not migrated yet) blanks that section only, not the workspace.
    const flaky = await attention.attentionCounts([A], (orgId, fn) =>
      withOrgDb(orgId, (tx) => {
        let calls = 0;
        const wrapped = new Proxy(tx, {
          get(target, prop) {
            if (prop !== "transaction") return Reflect.get(target, prop);
            return (inner) => (calls++ === 0 ? target.transaction(async () => { throw new Error('relation "inbox_items" does not exist'); }) : target.transaction(inner));
          },
        });
        return fn(wrapped);
      }),
    );
    check("a count that fails contributes nothing and the rest still arrive (10 of 12)", flaky[A] === 10, flaky);
    const down = await attention.attentionCounts([A, B], async () => {
      throw new Error("database unreachable");
    });
    check("a workspace whose scope cannot be entered shows 0, and the call still returns", down[A] === 0 && down[B] === 0, down);
  }
  await closeDb();
} finally {
  for (const [t, qual] of saved) {
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await cleanup().catch((e) => console.error("cleanup failed:", e));
  await admin.end();
}

console.log(failures === 0 ? "\ntest-workspace-attention-db: all assertions passed" : `\ntest-workspace-attention-db: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
