// operator:new-org — provision a new workspace (org) on the platform.
//
//   npm run operator:new-org -- --name "OnFinance" [--id onfinance] \
//     [--domain onfinance.in] [--owner priyesh@onfinance.in]
//
// Writes ONE `orgs` row (idempotent by id), the owner into `org_members`, adds
// the owner to `platform_admins`, and provisions the workspace with what the deployment
// profile names (`library.sources`: recipes and workflows; none by default) and one row per specialist. This is the operator-assisted door of
// §6 — a thin client of the same tables the self-serve wizard and the
// provisioning API write. See the Org Onboarding plan.
//
// Requires the org-tenancy migration to have been run (orgs table present).
import { getDb, closeDb, slugify, nowIso } from "./lib/customer.mjs";
import { withOrgDb } from "../../agent/lib/db/index.ts";
import { orgs, orgMembers, platformAdmins } from "../../agent/lib/db/schema.ts";
import { provisionWorkspace } from "../../agent/lib/provision-workspace.ts";
import { LIBRARY_SOURCES } from "../../agent/lib/workflow-library.generated.ts";
import { eq } from "drizzle-orm";
import { glyph, flag, hasFlag, resolveIdentity } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";

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
    console.error(`${glyph.bad} No owner — pass --owner <email> or run \`node setup/workspace-login.mjs\`.`);
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
  await db.insert(platformAdmins).values({ email: owner, addedBy: "operator:new-org" }).onConflictDoNothing();
  console.log(`${glyph.ok} ${owner} is owner + platform admin.`);

  // Steps 3 and 4 write org-scoped tables, and those are different from the
  // three above: `recipes.org_id` is NOT NULL (543913c) and both `recipes` and
  // `workflows` carry the org_isolation policy, which fails closed. The runtime
  // role is app_rw, so an insert on a connection with no workspace in scope is
  // refused by the database. So: one transaction, scoped to the org this
  // script already knows. What gets seeded — the recipe catalog and the
  // workflow library — lives in provisionWorkspace, shared with the self-serve
  // wizard (POST /api/ops/orgs), so the two doors cannot drift apart.
  const { recipesCreated, recipesSkipped, workflowsCreated, workflowsSkipped } = await withOrgDb(id, (tx) =>
    provisionWorkspace(tx, id, owner),
  );
  console.log(`${glyph.info} Library: ${LIBRARY_SOURCES.length ? LIBRARY_SOURCES.join(", ") : "none (the profile of this build names no library source; see docs/DEPLOYMENT_PROFILE.md, \"library\")"}.`);
  console.log(`${glyph.ok} Recipe catalog: ${recipesCreated} new, ${recipesSkipped} already present.`);
  console.log(`${glyph.ok} Workflows (the library's, and one row per specialist): ${workflowsCreated} installed, ${workflowsSkipped} already present.`);

  console.log(`\n${glyph.ok} Workspace "${id}" provisioned at ${nowIso()}.`);
  console.log(`   Next: invite operators, connect a source, onboard the first ${W.account}.`);
  console.log(`   Check readiness:  GET /api/ops/orgs/${id}/health`);
  await closeDb();
}

main().catch(async (e) => {
  console.error(`${glyph.bad} ${e?.message ?? e}`);
  await closeDb();
  process.exit(1);
});
