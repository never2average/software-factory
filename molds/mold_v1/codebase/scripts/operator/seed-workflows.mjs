// operator:seed-workflows — install the workflow library into the `workflows`
// table from scripts/operator/workflows/*.workflow.js. Each file is a workflow SCRIPT
// (export const meta + phase()/agent()/parallel()/pipeline()); we read it as
// text and store it. Idempotent: upserts by workflow name.
//
//   npm run operator:seed-workflows -- --org <id>   # install/update for one workspace
//   npm run operator:seed-workflows -- --list       # just print what would be seeded
//
// The library is PER-WORKSPACE. Every row carries an org_id, because the
// workflows table is org-scoped and RLS keys on `org_id = current_setting(...)`:
// a NULL org_id matches no workspace at all, so an unscoped seed writes rows
// that are invisible to every reader while reporting success.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb, closeDb } from "../../agent/lib/db/index.ts";
import { orgs, workflows } from "../../agent/lib/db/schema.ts";
import { and, eq, notInArray } from "drizzle-orm";
import { flag, glyph, hasFlag } from "./lib/operator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "workflows");

function parse(script) {
  const name = /name:\s*"([^"]+)"/.exec(script)?.[1];
  const description = /description:\s*"([^"]+)"/.exec(script)?.[1];
  const steps = [...script.matchAll(/phase\("([^"]+)"\)/g)].map((m) => m[1]);
  return { name, description, steps };
}

async function main() {
  const files = readdirSync(dir).filter((f) => f.endsWith(".workflow.js")).sort();
  const items = files.map((f) => {
    const script = readFileSync(join(dir, f), "utf8");
    const { name, description, steps } = parse(script);
    if (!name || !description) throw new Error(`${f}: missing name/description in meta`);
    return { name, description, steps, script };
  });

  if (hasFlag("list")) {
    for (const it of items) console.log(`${glyph.info} ${it.name} — ${it.description}  [${it.steps.join(" → ")}]`);
    console.log(`\n${items.length} workflow(s).`);
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
  // Prune system-seeded workflows whose file was removed (keeps the library in
  // sync with scripts/operator/workflows/ — a removed .workflow.js drops its row).
  const names = items.map((it) => it.name);
  const orphans = await db
    .delete(workflows)
    .where(
      and(
        eq(workflows.createdBy, "system"),
        // Confine the prune to THIS workspace. Unscoped, it deleted every
        // system-seeded workflow in every workspace — so seeding one tenant
        // wiped the library of all the others.
        eq(workflows.orgId, orgId),
        notInArray(workflows.name, names),
      ),
    )
    .returning({ name: workflows.name });
  for (const o of orphans) console.log(`${glyph.warn} removed ${o.name} (no file)`);

  await closeDb();
  console.log(`\n${glyph.ok} seeded ${items.length} workflow(s) into ${orgId} (${created} new, ${updated} updated, ${orphans.length} removed).`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} seed-workflows failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
