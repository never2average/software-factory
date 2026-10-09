// operator:context-graph — show the dm.md context graph for a data-room folder: what it
// must contain, what's present, what's missing, and its live [[edges]].
//
//   npm run operator:context-graph -- --path "{folder:accounts}/contoso-bank"
//   npm run operator:context-graph -- --customer contoso-bank --org <workspace id>   # shorthand for {folder:accounts}/<id>
//   npm run operator:context-graph -- --path "{folder:deliveries}/contoso-bank/v2.4.0/infrastructure/inference"
//
// This is the COMPUTED projection of DATAROOM_PATH_TEMPLATES (the dm.md grammar)
// onto one folder — no hidden file is stored; the graph is derived on demand, so
// it can never drift from the spec. See docs/OPERATOR_WORKFLOW.md.
import { getDb, closeDb, dataroom, workspaceFor, nowIso } from "./lib/customer.mjs";
import { buildContextGraph } from "./lib/context-graph.mjs";
import { glyph, flag } from "./lib/operator.mjs";
import { FOLDER } from "../../agent/lib/dataroom-folders.ts";

async function main() {
  const path = flag("path").trim() || (flag("customer").trim() ? `${FOLDER.accounts}/${flag("customer").trim()}` : "");
  if (!path) {
    console.error(`${glyph.bad} --path "<Domain/…>" (or --customer <id>) is required.`);
    process.exit(1);
  }
  // The workspace's own data room and records (--org / WORKSPACE_ORG, required): every workspace's data room is its own and
  // there is no default tree to fall back to (lib/dataroom-keyspace.ts).
  const orgId = workspaceFor();
  const store = dataroom(orgId);
  const db = getDb();
  const g = await buildContextGraph(store, db, path, nowIso(), orgId);
  await closeDb();

  console.log(`Context graph — ${g.path}\n`);
  const line = (label, arr) => arr.length && console.log(`${label}: ${arr.join(", ")}`);
  line(`${glyph.info} required files`, g.requires.files);
  line(`${glyph.info} required dirs`, g.requires.dirs);
  line(`${glyph.info} instance slots`, g.requires.instanceSlots.map((s) => s.replace(/[{}]/g, "")));
  if (g.requires.openFiles) console.log(`${glyph.info} open: arbitrary files allowed here`);
  console.log("");
  line(`${glyph.ok} present files`, g.present.files);
  line(`${glyph.ok} present dirs`, g.present.dirs);
  if (g.missing.files.length) console.log(`${glyph.warn} missing files: ${g.missing.files.join(", ")}`);
  if (g.missing.dirs.length) console.log(`${glyph.warn} missing dirs: ${g.missing.dirs.join(", ")}`);
  if (g.edges.length) {
    console.log(`\n${glyph.info} edges:`);
    for (const e of g.edges) console.log(`   ${e}`);
  }
  console.log(`\n${g.ok ? glyph.ok + " complete" : glyph.warn + " incomplete"} — ${g.requires.files.length} required file(s), ${g.missing.files.length + g.missing.dirs.length} missing.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} context-graph failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
