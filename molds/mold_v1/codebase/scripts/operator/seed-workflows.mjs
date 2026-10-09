// operator:seed-workflows — install this deployment's workflow library into the `workflows`
// table of a workspace that already exists. Idempotent: upserts by workflow name.
//
//   npm run operator:seed-workflows -- --org <id>   # install/update for one workspace
//   npm run operator:seed-workflows -- --list       # just print what would be seeded
//
// WHICH workflows is the deployment profile's business (`library.sources` in profiles/*.json), not a folder this
// script reads: it installs exactly what a new workspace is provisioned with (agent/lib/workflow-library-view.ts),
// so a workflow that delegates to a specialist the profile excludes is left out here too. A deployment whose
// profile names no library has nothing to seed, and this says so and changes nothing.
//
// It never deletes. It used to prune every system-created row whose file had gone; a row this deployment no longer
// ships is now listed, and removed only when told to, by `npm run operator:library-cleanup`.
//
// The library is PER-WORKSPACE. Every row carries an org_id, because the
// workflows table is org-scoped and RLS keys on `org_id = current_setting(...)`:
// a NULL org_id matches no workspace at all, so an unscoped seed writes rows
// that are invisible to every reader while reporting success.
import { getDb, closeDb } from "../../agent/lib/db/index.ts";
import { orgs, workflows } from "../../agent/lib/db/schema.ts";
import { and, eq } from "drizzle-orm";
import { flag, glyph, hasFlag } from "./lib/operator.mjs";
import { deploymentWorkflowLibrary } from "../../agent/lib/workflow-library-view.ts";
import { LIBRARY_SOURCES, WORKFLOW_LIBRARY } from "../../agent/lib/workflow-library.generated.ts";

async function main() {
  // In this deployment's words, and without what it cannot run: exactly as a new workspace is provisioned.
  const items = deploymentWorkflowLibrary();
  const withheld = WORKFLOW_LIBRARY.length - items.length;

  if (hasFlag("list")) {
    for (const it of items) console.log(`${glyph.info} ${it.name} — ${it.description}  [${it.steps.join(" → ")}]`);
    console.log(`\n${items.length} workflow(s) from ${LIBRARY_SOURCES.length ? LIBRARY_SOURCES.join(", ") : "no library source"}${withheld ? ` (${withheld} more delegate to a specialist the profile excludes, and are left out)` : ""}.`);
    return;
  }
  if (!items.length) {
    console.log(
      LIBRARY_SOURCES.length
        ? `${glyph.info} Every workflow of ${LIBRARY_SOURCES.join(", ")} delegates to a specialist the profile excludes: nothing to seed.`
        : `${glyph.info} The profile of this build names no library source (library.sources is empty), so there is nothing to seed. See docs/DEPLOYMENT_PROFILE.md, "library".`,
    );
    return;
  }

  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }

  /**
   * Which workspace are we seeding? Explicit --org wins; otherwise this is only
   * unambiguous when exactly one workspace exists. Guessing would be the worst
   * option: the writes below update and DELETE by name, so picking the wrong
   * workspace silently rewrites someone else's library.
   */
  let orgId = flag("org");
  if (!orgId) {
    const all = await db.select({ orgId: orgs.orgId, name: orgs.name }).from(orgs);
    if (all.length === 1) {
      orgId = all[0].orgId;
      console.log(`${glyph.info} seeding the only workspace: ${orgId}`);
    } else if (all.length === 0) {
      console.error(`${glyph.bad} No workspaces exist yet. Onboard one first, then seed.`);
      process.exit(1);
    } else {
      console.error(`${glyph.bad} ${all.length} workspaces exist — pass --org <id>:`);
      for (const o of all) console.error(`    ${o.orgId}  (${o.name})`);
      process.exit(1);
    }
  } else {
    const [found] = await db.select({ orgId: orgs.orgId }).from(orgs).where(eq(orgs.orgId, orgId));
    if (!found) {
      console.error(`${glyph.bad} No such workspace: ${orgId}`);
      process.exit(1);
    }
  }

  let created = 0, updated = 0;
  for (const it of items) {
    // Scoped by org: two workspaces may each hold a workflow of the same name.
    const existing = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.name, it.name), eq(workflows.orgId, orgId)))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(workflows)
        .set({ description: it.description, steps: it.steps, script: it.script, trigger: "manual", enabled: true })
        .where(eq(workflows.id, existing[0].id));
      updated++;
      console.log(`${glyph.ok} updated ${it.name}`);
    } else {
      await db.insert(workflows).values({
        name: it.name,
        description: it.description,
        trigger: "manual",
        steps: it.steps,
        script: it.script,
        instructions: null,
        instructionsEnabled: false,
        enabled: true,
        createdBy: "system",
        orgId,
      });
      created++;
      console.log(`${glyph.ok} created ${it.name}`);
    }
  }
  await closeDb();
  console.log(`\n${glyph.ok} seeded ${items.length} workflow(s) into ${orgId} (${created} new, ${updated} updated; nothing removed).`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} seed-workflows failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
