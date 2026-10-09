#!/usr/bin/env node
/**
 * THE STORED-PATH CENSUS — every path this build stores a data-room file under, taken from the code that stores it.
 *
 * A deployment that already holds files keeps its folder names by pinning them in its profile
 * (`dataroom.domains.<id>.folder`). "Nothing moves" is only true if every place that builds a path builds the
 * same one as before, so this prints all of them, from the running code and never from a list kept by hand:
 *
 *   grammar     the path templates the store validates against, its top-level folders, the sync domains and each
 *               (domain, source)'s landing path, the workbook domains, a ticket's affectedSchema values
 *   store       a real file written through the store at EVERY template (write, appendJsonl), then what the store
 *               lists (whole room and per folder), what it reads back, and what is on disk
 *   tools       the agent's own tools run offline (dataroom_write / read / list / append_jsonl, record_interaction's
 *               mirror, read_customer_slas, list_members, record_signoff, get_signoff_status, sync_pull, list_syncs,
 *               build_workbook_spec), their answers and the files they left on disk
 *   workbooks   each domain's Master.xlsx path and its sheet names, from the workbook builder
 *   web         which first segments the web app's two path guards admit
 *   starter     the files a new workspace is seeded with, path and sha256
 *   seeders     the local seeder's tree on disk and the blob seeder's tree (--print), path and sha256
 *
 * scripts/test-dataroom-folders.mjs runs it in a copy of the checkout stamped with the pin and holds the output
 * equal, byte for byte, to scripts/fixtures/dataroom-folders/stored-paths-before.json: this same census taken on the
 * last commit before the folder names became a profile setting (when they were literals in the code, so it was run
 * there with DATAROOM_CENSUS_FOLDERS naming them; today the names come from this build's profile).
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/lib/dataroom-path-census.mjs
 *
 * Volatile values (generated ids, timestamps, today's date in a sync's landing path) are masked the same way on
 * both sides. Offline: the local file driver in a scratch directory, the in-memory system of record, no network.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { mask } from "./census-mask.mjs";

const ROOT = process.cwd();
// eve's `.js` -> `.ts` specifiers, the web app's `@/` alias and extensionless imports, Next's `server-only` guard.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(ROOT + "/").href)};
      export async function resolve(s, c, n) {
        if (s === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

// The folder names this build stores each domain under. From its profile; on a commit that had them in the code,
// from the environment (the one way a before-image could be taken with this same script).
const N = process.env.DATAROOM_CENSUS_FOLDERS ? JSON.parse(process.env.DATAROOM_CENSUS_FOLDERS) : (await imp("agent/lib/dataroom-folders.ts")).FOLDER;
const DOMAIN_IDS = ["accounts", "platform", "deliveries", "solutions", "projects", "tickets", "people"];
const ROOT_IDS = [...DOMAIN_IDS, "uploads"];

const SCRATCH = mkdtempSync(join(tmpdir(), "dataroom-census-"));
process.env.DATAROOM_DIR = join(SCRATCH, "room");
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.DATABASE_URL;

const sha = (text) => createHash("sha256").update(text).digest("hex");
/** Every file under a directory, relative, sorted. */
function walk(dir) {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  try { visit(dir); } catch { /* nothing written */ }
  return out.sort();
}
const census = {};
try {
  // The system of record, seeded from the test fixture (in memory; moves the process to a scratch directory).
  const { seedFixtureStore } = await imp("scripts/lib/test-fixture.mjs");
  await seedFixtureStore();

  const store = await imp("agent/lib/dataroom-store.ts");
  const schema = await imp("agent/lib/dataroom-schema.ts");
  const syncs = await imp("agent/lib/syncs.ts");
  const workbook = await imp("agent/lib/workbook-spec.ts");
  const records = await imp("agent/lib/customer-schema.ts");
  const { DEFAULT_ORG } = await imp("agent/lib/org-context.ts");

  /* ---- grammar -------------------------------------------------------------------------------------------------- */
  census.grammar = {
    templates: [...store.DATAROOM_PATH_TEMPLATES],
    topLevelFolders: [...schema.dataroomDomainSchema.options],
    syncDomains: [...syncs.SYNC_DOMAINS],
    syncLandingPaths: syncs.SYNC_DOMAINS.flatMap((d) => syncs.listSyncSources(d).map((s) => syncs.syncLandingPath(d, s, "acme-bank", "2026-07-10"))),
    workbookDomains: [...workbook.WORKBOOK_DOMAINS],
    ticketAffectedSchema: [...records.ticketSchema.shape.affectedSchema.unwrap().options],
  };

  /* ---- store: a real file at every template --------------------------------------------------------------------- */
  const TOKENS = {
    customer_id: "acme-bank", platform_version_id: "2026.06.3", platform_id: "2026.06.3", person_id: "sam-example-com", agent_id: "agent-1",
    pipeline_id: "pl-1", migration_id: "mig-1", run_id: "run-1", id: "TCK-1", date: "2026-07-10", ticket_folder: "bug", component: "inference",
    signoff_role: "internal", design_doc: "tenancy",
  };
  const sample = (template) => template.replace(/\{([a-z_]+)\}/g, (_m, t) => TOKENS[t] ?? `<${t}>`).replace(/\*\*$/, "notes/readme.md");
  const room = store.getDataroomStore("org-census");
  const written = [];
  for (const template of store.DATAROOM_PATH_TEMPLATES) {
    const path = sample(template);
    if (path.endsWith(".jsonl")) await room.appendJsonl(path, [{ n: 1 }]);
    else await room.write(path, `${template}\n`);
    written.push(path);
  }
  census.store = {
    written,
    listed: await room.list(""),
    listedPerFolder: Object.fromEntries(await Promise.all(ROOT_IDS.map(async (id) => [N[id], await room.list(N[id])]))),
    readBack: Object.fromEntries(await Promise.all(written.map(async (p) => [p, sha((await room.read(p)) ?? "<missing>")]))),
    refused: await Promise.all(["Nowhere/x/y.md", `${N.accounts}`, `../${N.accounts}/x.md`, "README.md"].map(async (p) => [p, await room.read(p).then(() => "admitted", (e) => e.name)])),
    onDisk: walk(join(process.env.DATAROOM_DIR, "orgs", "org-census")),
  };

  /* ---- tools: the agent's own, run offline against the default workspace ----------------------------------------- */
  const ctx = { session: { id: "census", auth: { current: null, initiator: null } } };
  const dataroom = await imp("agent/lib/dataroom-tools.ts");
  const tools = await imp("agent/lib/tools.ts");
  const signoff = await imp("agent/lib/signoff-tools.ts");
  const syncTools = await imp("agent/lib/sync-tools.ts");
  const render = await imp("agent/lib/artifact-render-tools.ts");
  const run = async (name, tool, input) => {
    try { return [name, input, await tool.execute(input, ctx)]; } catch (e) { return [name, input, { thrown: String(e?.message ?? e) }]; }
  };
  const C = "acme-bank";
  const calls = [];
  calls.push(await run("dataroom_write", dataroom.dataroomWriteTool, { path: `${N.accounts}/${C}/context.md`, content: "# Acme Bank\n" }));
  calls.push(await run("dataroom_write", dataroom.dataroomWriteTool, { path: `${N.accounts}/${C}/agreements/sla.json`, content: '{"tiers": {}}\n' }));
  calls.push(await run("dataroom_write", dataroom.dataroomWriteTool, { path: `${N.projects}/${C}/integromat.json`, content: "{}\n" }));
  calls.push(await run("dataroom_write", dataroom.dataroomWriteTool, { path: `${N.people}/sam-example-com/identity.json`, content: JSON.stringify({ kind: "internal-member", email: "sam@example.com", name: "Sam" }) }));
  calls.push(await run("dataroom_write", dataroom.dataroomWriteTool, { path: `${N.uploads}/sam-example-com/notes.md`, content: "hi\n" }));
  calls.push(await run("dataroom_write", dataroom.dataroomWriteTool, { path: `Nowhere/${C}/context.md`, content: "x\n" }));
  calls.push(await run("dataroom_append_jsonl", dataroom.dataroomAppendJsonlTool, { path: `${N.tickets}/syncs/call/${C}/notes.jsonl`, records: { note: "appended" } }));
  calls.push(await run("dataroom_read", dataroom.dataroomReadTool, { path: `${N.accounts}/${C}/context.md` }));
  calls.push(await run("dataroom_list", dataroom.dataroomListTool, { prefix: `${N.accounts}/${C}` }));
  calls.push(await run("dataroom_list", dataroom.dataroomListTool, {}));
  calls.push(await run("record_interaction", tools.recordInteractionTool, { customerId: C, date: "2026-07-07", type: "call", source: "manual", note: "Census call." }));
  calls.push(await run("read_customer_slas", tools.readCustomerSlasTool, {}));
  calls.push(await run("list_members", tools.listMembersTool, {}));
  calls.push(await run("record_signoff", signoff.recordSignoffTool, { customerId: C, platformVersionId: "2026.06.3", component: "inference", party: "internal", status: "requested" }));
  calls.push(await run("get_signoff_status", signoff.getSignoffStatusTool, { customerId: C, platformVersionId: "2026.06.3" }));
  for (const id of ["accounts", "platform", "deliveries", "tickets", "people"]) {
    calls.push(await run("sync_pull", syncTools.syncPullTool, { domain: N[id], customerId: C, source: "manual_entry", items: [{ id: "m1", note: "landed by the census" }], normalize: false }));
    calls.push(await run("list_syncs", syncTools.listSyncsTool, { domain: N[id], source: "manual_entry", customerId: C }));
  }
  calls.push(await run("sync_pull", syncTools.syncPullTool, { domain: N.solutions, customerId: C, source: "manual_entry", items: [{ id: "m1" }] }));
  const books = await run("build_workbook_spec", render.buildWorkbookSpecTool, { customerId: C });
  calls.push([books[0], books[1], { customerId: books[2]?.customerId, workbooks: (books[2]?.workbooks ?? []).map((w) => ({ workbook: w.workbook, domain: w.domain, sheets: w.sheets.map((s) => s.name) })), thrown: books[2]?.thrown }]);
  census.tools = {
    calls: mask(calls.map(([tool, input, output]) => ({ tool, input, output }))),
    onDisk: mask(walk(join(process.env.DATAROOM_DIR, "orgs", DEFAULT_ORG))),
  };

  /* ---- workbooks ------------------------------------------------------------------------------------------------- */
  census.workbooks = (await workbook.buildCustomerWorkbookSpecs({ customerId: C, now: "2026-07-10T00:00:00Z" })).map((w) => ({ workbook: w.workbook, domain: w.domain, sheets: w.sheets.map((s) => s.name) }));

  /* ---- web: the two path guards ---------------------------------------------------------------------------------- */
  const webBlob = await imp("lib/dataroom-blob.ts");
  const preview = await imp("lib/pdf-preview.ts");
  census.web = {
    isSafeDataroomPath: [...ROOT_IDS.map((id) => N[id]), "Nowhere"].map((r) => [r, webBlob.isSafeDataroomPath(`${r}/x/y.pdf`)]),
    isDataroomPath: [...ROOT_IDS.map((id) => N[id]), "Nowhere"].map((r) => [r, preview.isDataroomPath(`${r}/x/y.pdf`)]),
  };

  /* ---- starter: what a new workspace is seeded with -------------------------------------------------------------- */
  const seed = await imp("lib/org-seed.ts");
  census.starter = seed.starterFiles("org-1", "Acme").map(([path, body]) => [path, sha(body)]);

  /* ---- seeders --------------------------------------------------------------------------------------------------- */
  const node = (args, env) => spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
  const seedRoom = join(SCRATCH, "seeded");
  const local = node(["scripts/seed-dataroom.ts"], { DATAROOM_DIR: seedRoom, SEED_ORG: "org-seeded" });
  const blob = node(["scripts/seed-dataroom-blob.mjs", "--print"], {});
  let printed = null;
  try { printed = JSON.parse(blob.stdout); } catch { /* reported below */ }
  census.seeders = {
    local: local.status === 0 ? walk(join(seedRoom, "orgs", "org-seeded")).map((p) => [p, sha(readFileSync(join(seedRoom, "orgs", "org-seeded", p), "utf8"))]) : { failed: (local.stderr || local.stdout).slice(-600) },
    blob: printed ? Object.entries(printed.files ?? printed).map(([p, body]) => [p, sha(typeof body === "string" ? body : JSON.stringify(body))]) : { failed: (blob.stderr || blob.stdout).slice(-600) },
  };
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(census, null, 2)}\n`, () => process.exit(0));
