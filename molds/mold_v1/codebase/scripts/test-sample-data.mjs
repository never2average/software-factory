#!/usr/bin/env node
/**
 * THE SAMPLE RECORDS STAY A LOCAL DEMO'S — the rules that need no build (the build and the pages are
 * check:no-sample-data's).
 *
 *   · the no-database fallback starts EMPTY, and from the sample only with DEMO_SAMPLE_DATA=1;
 *   · it never writes its store to disk (it used to write <cwd>/data/customers.json, a file the client bundled);
 *   · `seed:postgres` puts the invented accounts into a database only when asked (DEMO_SAMPLE_DATA=1 or --sample),
 *     and refuses BEFORE connecting otherwise: a real workspace's database is one `npm run seed:postgres` away;
 *   · nothing the model or a workspace reads still names the sample file or its ids (the research specialist's
 *     prompt cited `data/customers.json` and `acme-bank`/`northwind-cap`; seed-ops seeded the connector card with
 *     "customers.json" and sample Slack channels), in any prompt, instruction or skill;
 *   · the /preview/* fixtures (whose chunks ship in every build) name no real institution (review of #62).
 *
 *   npm run test:sample-data
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORG_SLUG } from "./lib/default-org.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${String(detail).slice(0, 400)}`}`); }
};
const node = (args, env, cwd = ROOT) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });

/* ------------------------------------------------------------------------------------ the fallback */

const probe = `
  const { listCustomers, upsertCustomer } = await import(${JSON.stringify(join(ROOT, "agent/lib/system-of-record.ts"))});
  const before = (await listCustomers()).map((c) => c.id);
  await upsertCustomer({ id: "probe-co", name: "Probe Co", tier: "Growth", status: "On Track", lifecycleStage: "Live" });
  console.log(JSON.stringify({ before }));
`;
const noDb = { DATABASE_URL: "", POSTGRES_URL: "", DEMO_SAMPLE_DATA: "", DEMO_SAMPLE_DATA_DIR: "" };
const scratch = mkdtempSync(join(tmpdir(), "sample-data-"));
mkdirSync(join(scratch, "data"), { recursive: true });
const off = node(["--input-type=module", "-e", probe], noDb, scratch);
const offOut = JSON.parse(off.stdout.trim().split("\n").at(-1) || "{}");
check("with no database and no flag, the fallback starts empty", off.status === 0 && Array.isArray(offOut.before) && offOut.before.length === 0, off.stderr || off.stdout);
check("…and a write stays in memory: nothing lands in <cwd>/data/customers.json", !existsSync(join(scratch, "data", "customers.json")));
const on = node(["--input-type=module", "-e", probe], { ...noDb, DEMO_SAMPLE_DATA: "1", DEMO_SAMPLE_DATA_DIR: join(ROOT, "data/sample") }, scratch);
const onOut = JSON.parse(on.stdout.trim().split("\n").at(-1) || "{}");
check("with DEMO_SAMPLE_DATA=1 it starts from the sample", on.status === 0 && onOut.before?.includes("acme-bank"), on.stderr || on.stdout);

/* ------------------------------------------------------------------------------------ seed:postgres */

// A port nothing listens on: if the script tried to connect, it would fail with a connection error instead.
const closedDb = "postgres://nobody:nothing@127.0.0.1:1/none";
const seed = node(["scripts/seed-postgres.ts"], { DATABASE_URL: closedDb, DEMO_SAMPLE_DATA: "" });
const said = `${seed.stdout}${seed.stderr}`;
check("seed:postgres without DEMO_SAMPLE_DATA=1 or --sample refuses (non-zero exit)", seed.status !== 0 && seed.status !== null, `exit ${seed.status}`);
check("…says how to ask for the sample", /DEMO_SAMPLE_DATA=1/.test(said) && /--sample/.test(said), said);
check("…and never connected", !/ECONNREFUSED|connect/i.test(said.replace(/DEMO_SAMPLE_DATA|--sample/g, "")), said);

/* ------------------------------------------------------------------------------------ what still names the sample */

const NAMES = [/data\/customers\.json/, /data\/people\.json/, /\bacme-bank\b/, /\bnorthwind-cap\b/];
for (const f of ["agent/subagents/research/prompt.md", "agent/lib/prompts.generated.ts"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const hit = NAMES.find((re) => re.test(text));
  check(`${f} names neither the sample file nor its ids`, !hit, hit && text.match(hit)?.[0]);
}
// Every file the MODEL reads as text: each specialist's prompt, instructions and skills, the root instructions.
// #62 fixed the research prompt; this holds the rest, so a new prompt cannot bring the sample file back.
const modelText = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(md|txt)$/.test(f)).map((f) => join(dir, f)) : []);
const prompts = [...modelText(join(ROOT, "agent/subagents")), ...modelText(join(ROOT, "agent/instructions")), ...modelText(join(ROOT, "skills"))];
const promptHits = prompts.flatMap((f) => { const t = readFileSync(f, "utf8"); const re = [/customers\.json/, /people\.json/, ...NAMES.slice(2)].find((r) => r.test(t)); return re ? [`${f.slice(ROOT.length + 1)}: ${t.match(re)[0]}`] : []; });
check(`no prompt, instruction or skill the model reads names the sample file or its ids (${prompts.length} files)`, prompts.length > 0 && promptHits.length === 0, promptHits.join("; "));

// The /preview/* fixtures 404 in production, but their chunks ship in every build: example names only, never a
// real institution's or this company's (they showed real institutions' names; review of #62).
const REAL = new RegExp(`\\b(SBI|HDFC|CUB|MLP USA|Axis Bank|Kotak|Aavas|${DEFAULT_ORG_SLUG})\\b`, "i");
const previews = [...modelText(join(ROOT, "app/preview")), ...(existsSync(join(ROOT, "app/preview")) ? readdirSync(join(ROOT, "app/preview"), { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => join(ROOT, "app/preview", f)) : []), join(ROOT, "tests/cards.spec.ts"), join(ROOT, "tests/stickloop.spec.ts")].filter(existsSync);
const previewHits = previews.flatMap((f) => { const m = readFileSync(f, "utf8").match(REAL); return m ? [`${f.slice(ROOT.length + 1)}: ${m[0]}`] : []; });
check(`the /preview pages and their specs use example names only (${previews.length} files)`, previewHits.length === 0, previewHits.join("; "));

const ops = readFileSync(join(ROOT, "scripts/seed-ops.mjs"), "utf8");
const opsHit = [/customers\.json/, /people\.json/, /#acme-/, /#northwind-/].find((re) => re.test(ops));
check("scripts/seed-ops.mjs seeds no sample file name or sample channel onto a connector card", !opsHit, opsHit && ops.match(opsHit)?.[0]);

if (failures.length) {
  console.error(`\ntest-sample-data: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-sample-data: all ${passed} checks passed`);
