// operator:doctor — walk the data room and check each customer's folders against their
// dm.md context graph: missing required files, dangling [[edges]]. Advisory by
// default; --strict exits non-zero if anything is missing (a CI / finish gate).
//
//   npm run operator:doctor                      # every workspace's customers, each against its own data room
//   npm run operator:doctor -- --org <workspace id> [--customer contoso-bank]
//   npm run operator:doctor -- --strict
//
// Like solution-manager's doctor.ts, but structural and dm.md-driven — it reads
// the same DATAROOM_PATH_TEMPLATES the store validates writes against. See
// docs/OPERATOR_WORKFLOW.md and the context-graph library.
import { getDb, closeDb, dataroom, nowIso, withOrgDb } from "./lib/customer.mjs";
import { customers, orgs } from "../../agent/lib/db/schema.ts";
import { accountOwnerSql } from "../../agent/lib/db/owner-columns.ts";
import { isMemberKind } from "../../agent/lib/member-kind.ts";
import { eq } from "drizzle-orm";
import { buildContextGraph } from "./lib/context-graph.mjs";
import { glyph, flag, hasFlag, operatorEnv } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";
import { DEPLOYMENT_PROFILE } from "../../lib/deployment-profile.generated.ts";
import { FOLDER, pathPattern } from "../../agent/lib/dataroom-folders.ts";

async function main() {
  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }
  // Per workspace: a company is keyed by (org_id, customer_id) and its folders live in its workspace's data room
  // (mold_v1-118). --org names one; without it every workspace is checked, each in its own scope and data room.
  const only = flag("customer").trim();
  const named = (flag("org") || operatorEnv("WORKSPACE_ORG")).trim();
  if (only && !named) {
    console.error(`${glyph.bad} --customer needs --org <workspace id>: a company id names a company only within a workspace.`);
    process.exit(1);
  }
  const workspaces = named ? [named] : (await db.select({ orgId: orgs.orgId }).from(orgs)).map((o) => o.orgId);
  let problems = 0;
  let rosterProblems = 0;
  for (const orgId of workspaces) {
    const found = await doctorWorkspace(db, orgId, only);
    problems += found.problems;
    rosterProblems += found.rosterProblems;
  }

  await closeDb();
  const total = problems + rosterProblems;
  console.log(`\n${total === 0 ? glyph.ok + " all healthy" : glyph.warn + " " + total + " issue(s)"}.`);
  if (total > 0 && hasFlag("strict")) process.exit(1);
}

/** One workspace: its customers' folders in its own data room, and its roster. */
async function doctorWorkspace(db, orgId, only) {
  const store = dataroom(orgId);
  const rows = only
    ? [{ customerId: only }]
    : await withOrgDb(orgId, (tx) => tx.select({ customerId: customers.customerId }).from(customers).where(eq(customers.orgId, orgId)));

  if (rows.length === 0) {
    console.log(`${glyph.info} ${orgId}: no ${W.accounts} to check.`);
    return { problems: 0, rosterProblems: 0 };
  }

  console.log(`Doctor — ${orgId}: checking ${rows.length} ${W.account} folder(s)\n`);
  let problems = 0;
  for (const { customerId } of rows) {
    const g = await buildContextGraph(store, db, `${FOLDER.accounts}/${customerId}`, nowIso(), orgId);
    const miss = [...g.missing.files, ...g.missing.dirs.map((d) => d + "/")];
    if (miss.length === 0) {
      console.log(`${glyph.ok} ${customerId}: complete (${g.edges.length} edge(s))`);
    } else {
      problems += miss.length;
      console.log(`${glyph.warn} ${customerId}: missing ${miss.join(", ")}`);
    }
  }

  // Roster reconciliation: unassigned accounts + owners not in the {folder:people}/ roster.
  let rosterProblems = 0;
  if (!only) {
    const rosterPaths = (await store.list(FOLDER.people)).filter((p) => pathPattern("people", "[^/]+/identity\\.json").test(p));
    const rosterEmails = new Set();
    for (const p of rosterPaths) {
      try {
        const id = JSON.parse((await store.read(p)) ?? "{}");
        if (isMemberKind(id.kind) && typeof id.email === "string") rosterEmails.add(id.email.toLowerCase());
      } catch {
        /* skip */
      }
    }
    const owned = await withOrgDb(orgId, (tx) =>
      tx.select({ customerId: customers.customerId, owner: accountOwnerSql }).from(customers).where(eq(customers.orgId, orgId)),
    );
    const unassigned = owned.filter((c) => !c.owner).map((c) => c.customerId);
    const dangling = owned
      .filter((c) => c.owner && !rosterEmails.has(c.owner.toLowerCase()))
      .map((c) => `${c.customerId}→${c.owner}`);
    console.log(`\nRoster — ${rosterEmails.size} ${DEPLOYMENT_PROFILE.vocabulary.member.plural} on file`);
    if (unassigned.length) {
      rosterProblems += unassigned.length;
      console.log(`${glyph.warn} unassigned accounts (no owner): ${unassigned.join(", ")}`);
    }
    if (dangling.length) {
      rosterProblems += dangling.length;
      console.log(`${glyph.warn} owner not in roster: ${dangling.join(", ")}`);
    }
    if (!unassigned.length && !dangling.length) console.log(`${glyph.ok} every account has a rostered owner`);
  }
  return { problems, rosterProblems };
}

main().catch(async (e) => {
  console.error(`${glyph.bad} doctor failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
