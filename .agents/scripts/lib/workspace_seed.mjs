// workspace_seed.mjs <org-seed.json> <customers.json> — run by workspace.py with cwd = build/<app_id>/ and
// DATABASE_URL (the app role, app_rw) in the environment. Creates or updates ONE workspace on a live app and
// fills it, every org-scoped write inside that workspace's scope (set_config('app.org_id')), exactly as the
// app's own code does. Uses the application's own modules from its build copy, so a pack's subagents get their
// "on delegation" rows too. Prints one JSON line. Never prints a connection string.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const lib = (p) => import(pathToFileURL(join(process.cwd(), p)).href);
const [seedPath, customersPath] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const customers = customersPath ? JSON.parse(readFileSync(customersPath, "utf8")).customers : [];

const { getDb, withOrgDb, closeDb } = await lib("agent/lib/db/index.ts").then(async (m) => ({ ...m, closeDb: (await lib("scripts/operator/lib/customer.mjs")).closeDb }));
const schema = await lib("agent/lib/db/schema.ts");
const { provisionWorkspace } = await lib("agent/lib/provision-workspace.ts");
const { writeCustomerToPostgres } = await lib("agent/lib/system-of-record.ts");
const { eq, and, sql } = await import(pathToFileURL(join(process.cwd(), "node_modules/drizzle-orm/index.js")).href);

const db = getDb();
if (!db) { console.error("no DATABASE_URL in the environment"); process.exit(1); }
const out = { org: seed.org_id };
try {
  const { orgs, orgMembers, peopleRoster } = schema;
  const [existing] = await db.select({ orgId: orgs.orgId }).from(orgs).where(eq(orgs.orgId, seed.org_id));
  const row = { orgId: seed.org_id, name: seed.name, googleHostedDomain: seed.google_hosted_domain ?? null,
                blobPrefix: `orgs/${seed.org_id}`, status: "active", createdBy: seed.owner, updatedAt: new Date() };
  if (existing) { await db.update(orgs).set({ name: row.name, googleHostedDomain: row.googleHostedDomain, updatedAt: row.updatedAt }).where(eq(orgs.orgId, seed.org_id)); out.orgs = "updated"; }
  else { await db.insert(orgs).values(row); out.orgs = "created"; }

  const people = [{ email: seed.owner, role: "owner" }, ...seed.members.filter((m) => m.email !== seed.owner)];
  for (const m of people) {
    await db.insert(orgMembers).values({ orgId: seed.org_id, email: m.email.toLowerCase(), role: m.role, invitedBy: seed.owner, acceptedAt: new Date() })
      .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.email], set: { role: m.role } });
  }
  out.org_members = people.length;

  const prov = await withOrgDb(seed.org_id, (tx) => provisionWorkspace(tx, seed.org_id, seed.owner));
  out.recipes = prov.recipesCreated; out.workflows_created = prov.workflowsCreated; out.workflows_present = prov.workflowsSkipped;

  out.people_roster = await withOrgDb(seed.org_id, async (tx) => {
    let n = 0;
    for (const m of seed.members) {
      await tx.execute(sql`insert into people_roster (org_id, email, name, team) values (${seed.org_id}, ${m.email.toLowerCase()}, ${m.name ?? null}, ${m.team ?? "Research"})
        on conflict (email) do update set name = excluded.name, team = excluded.team`);   // email alone is the PK in this mold (the composite key is deferred upstream), so one person is on one workspace's roster
      n++;
    }
    return n;
  });

  let ok = 0; const failed = [];
  for (const c of customers) {
    try { await writeCustomerToPostgres(db, c, seed.org_id); ok++; }
    catch (e) { failed.push(`${c.id}: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  out.customers = ok; if (failed.length) out.customers_failed = failed;
  const count = await withOrgDb(seed.org_id, (tx) => tx.execute(sql`select count(*)::int as n from customers where org_id = ${seed.org_id}`));
  out.customers_in_workspace = Array.from(count)[0]?.n ?? null;
} catch (e) {
  out.error = String(e?.message ?? e).slice(0, 400);
} finally {
  await closeDb();
}
console.log(JSON.stringify(out));
process.exit(out.error || out.customers_failed ? 1 : 0);
