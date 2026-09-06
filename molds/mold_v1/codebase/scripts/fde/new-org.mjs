// fde:new-org — provision a new workspace (org) on the platform.
//
//   npm run fde:new-org -- --name "OnFinance" [--id onfinance] \
//     [--domain onfinance.in] [--owner priyesh@onfinance.in]
//
// Writes ONE `orgs` row (idempotent by id), the owner into `org_members`, adds
// the owner to `platform_admins`, and seeds the built-in recipe catalog. This is
// the FDE-assisted door of §6 — a thin client of the same tables the self-serve
// wizard and the provisioning API write. See the Org Onboarding plan.
//
// Requires the org-tenancy migration to have been run (orgs table present).
import { getDb, closeDb, slugify, nowIso } from "./lib/customer.mjs";
import { orgs, orgMembers, platformAdmins, recipes } from "../../agent/lib/db/schema.ts";
import { provisionWorkspace } from "../../agent/lib/provision-workspace.ts";
import { eq, isNull, and } from "drizzle-orm";
import { glyph, flag, hasFlag, resolveIdentity } from "./lib/fde.mjs";

const BUILTIN_RECIPES = [
  ["onboard-self", "Sign in & record yourself", "Get signed in, wired to the data room over MCP, and recorded as an operator.", "members"],
  ["import-roster", "Import the roster", "Pull people from Google Directory or a CSV into the roster.", "roster"],
  ["connect-sources", "Connect a source", "Wire one connector (GitHub, Slack, …) and store its secret.", "connector"],
  ["seed-workflows", "Seed the workflow library", "Install the starter workflow library, default apps, and crons.", "workflows"],
  ["onboard-customer", "Onboard the first customer", "Create the first customer account and its data-room skeleton.", "customer"],
];

async function main() {
  const name = flag("name").trim();
  if (!name) {
    console.error(`${glyph.bad} --name is required (the company's display name).`);
    process.exit(1);
  }
  const id = flag("id").trim() || slugify(name);
  const domain = flag("domain").trim() || null;
  const { email: identity } = resolveIdentity();
  const owner = (flag("owner").trim() || identity || "").toLowerCase();
  if (!owner) {
    console.error(`${glyph.bad} No owner — pass --owner <email> or run \`node setup/fde-login.mjs\`.`);
    process.exit(1);
  }

  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }

  console.log(`New workspace: ${name}  (id: ${id}${domain ? `, domain: ${domain}` : ""})\n`);

  const [existing] = await db.select().from(orgs).where(eq(orgs.orgId, id));
  if (existing && !hasFlag("force")) {
    console.error(`${glyph.bad} Workspace "${id}" already exists. Pass --force to update it, or choose --id.`);
    await closeDb();
    process.exit(1);
  }

  // 1. The org row.
  const values = {
    orgId: id,
    name,
    googleHostedDomain: domain,
    blobPrefix: id === "onfinance" ? "orgs/onfinance" : `orgs/${id}`,
    status: "active",
    createdBy: owner,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(orgs).set(values).where(eq(orgs.orgId, id));
    console.log(`${glyph.ok} Updated orgs row.`);
  } else {
    await db.insert(orgs).values(values);
    console.log(`${glyph.ok} Created orgs row.`);
  }

  // 2. Owner membership + platform admin.
  await db
    .insert(orgMembers)
    .values({ orgId: id, email: owner, role: "owner", acceptedAt: new Date() })
    .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.email], set: { role: "owner" } });
  await db.insert(platformAdmins).values({ email: owner, addedBy: "fde:new-org" }).onConflictDoNothing();
  console.log(`${glyph.ok} ${owner} is owner + platform admin.`);

  // 3. Seed the built-in recipe catalog (global rows; idempotent by slug).
  let seeded = 0;
  for (let i = 0; i < BUILTIN_RECIPES.length; i++) {
    const [slug, title, summary, check] = BUILTIN_RECIPES[i];
    const [have] = await db.select().from(recipes).where(and(isNull(recipes.orgId), eq(recipes.slug, slug)));
    if (!have) {
      await db.insert(recipes).values({ orgId: null, slug, version: "1", title, summary, satisfiesCheck: check, sortOrder: i });
      seeded++;
    }
  }
  console.log(`${glyph.ok} Recipe catalog: ${seeded} new, ${BUILTIN_RECIPES.length - seeded} already present.`);

  // 4. Install the workflow library into THIS workspace, so the org is usable
  //    on arrival rather than after someone remembers a second command.
  const { workflowsCreated, workflowsSkipped } = await provisionWorkspace(db, id, owner);
  console.log(`${glyph.ok} Workflow library: ${workflowsCreated} installed, ${workflowsSkipped} already present.`);

  console.log(`\n${glyph.ok} Workspace "${id}" provisioned at ${nowIso()}.`);
  console.log(`   Next: invite operators, connect a source, onboard the first customer.`);
  console.log(`   Check readiness:  GET /api/ops/orgs/${id}/health`);
  await closeDb();
}

main().catch(async (e) => {
  console.error(`${glyph.bad} ${e?.message ?? e}`);
  await closeDb();
  process.exit(1);
});
