// The access-request form's own fields (mold_v0-102; src/access-request.ts, sql/migrations/0020_access_request_answers.sql),
// offline: the rules, build copies of the codebase with a pack that declares fields (gen-packs run in each), and in such a
// copy the API on an embedded database (and, with --browser, the console).
//   npm run test:access-request
//   tsx scripts/access-request-test.ts [--browser] [--shots <dir>]
//
// 1. The rules: each kind of field, the refusals (a shell field's key, a key twice, options on a text field, a select
//    without options, unknown keys, text that is not plain), the answers checked (required, an option not offered, an
//    address, a length, a key nobody declared dropped, a host pack's flat form read).
// 2. gen-packs: with no packs the build declares no field (src/access-request.generated.ts and the console's copy are []);
//    a pack's fields are written to both, in order; two packs' are joined; the same key in two packs, a shell field's key
//    and a host pack's host.profile access_request are refused; the app's profile.json replaces the packs'.
// 3. In a build with the pack, the API: a request stores its answers (an address gets https://, the options chosen), a
//    required field left empty, an option not offered and a bad address are refused naming the label; a key nobody
//    declared is not stored; the staff list (GET /api/admin/onboarding/requests) carries the answers, list_access_requests
//    names them by label, and the operator's alert email lists them under their labels. Zero-pack (this codebase): a request
//    stores no answer and the old columns stay empty. The migration's backfill moves an older row's columns into answers.
// 4. --browser: the console built in that copy: /request-access asks the declared fields (a line, a choice, several
//    choices, a box) after the company, sends them, and /admin/requests shows them under their labels in the open
//    request; axe finds no serious or critical violation on either page, and neither scrolls sideways at 390 px.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INNER = process.argv.includes("--inner");
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
/** The mold's testing folder (axe): beside the codebase, or named by the run that made this build copy. */
const TESTING = process.env.MOLD_TESTING_DIR ?? path.resolve(ROOT, "..", "testing");

/** The fixture pack's questions: one of each kind the form draws differently. */
export const FIELDS = [
  { key: "website", label: "Company website", type: "url", required: true, placeholder: "https://example.com" },
  { key: "team_size", label: "Team size", type: "select", options: [{ value: "1-10", label: "1 to 10" }, { value: "11-50", label: "11 to 50" }] },
  { key: "tools", label: "Tools you use", type: "multi_select", options: [{ value: "sheets", label: "Spreadsheets" }, { value: "erp", label: "An ERP" }] },
  { key: "goal", label: "What should it do first?", type: "long_text", max_length: 500, help: "A sentence or two is plenty." },
];

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

if (INNER) await inner();
else await outer();
process.exit(0);

// ---------- 1 and 2: the rules and gen-packs; then 3 and 4 inside a build copy ----------

async function outer() {
  const { accessRequestProblems, answersOf, joinAccessFields, labelledAnswers } = await import("../src/access-request.js");
  type F = import("../src/access-request.js").AccessField;
  const fields = FIELDS as F[];
  assert.deepEqual(accessRequestProblems({ fields }), [], "the fixture's fields are valid");
  const refused: [string, unknown, RegExp][] = [
    ["a shell field's key", { fields: [{ key: "email", label: "Email", type: "email" }] }, /email is the shell's own field/],
    ["a key twice", { fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }] }, /a is declared twice/],
    ["options on a text field", { fields: [{ key: "a", label: "A", type: "text", options: [{ value: "x", label: "X" }] }] }, /options: only for a select/],
    ["a select without options", { fields: [{ key: "a", label: "A", type: "select" }] }, /options: a list of 1 to 30/],
    ["an option twice", { fields: [{ key: "a", label: "A", type: "select", options: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] }] }, /x is offered twice/],
    ["an unknown type", { fields: [{ key: "a", label: "A", type: "file" }] }, /type: one of text, long_text/],
    ["an unknown key on a field", { fields: [{ key: "a", label: "A", type: "text", hint: "x" }] }, /fields\[0\]\.hint: unknown key/],
    ["an unknown key on the block", { fields: [{ key: "a", label: "A", type: "text" }], intro: "x" }, /access_request\.intro: unknown key/],
    ["a label over two lines", { fields: [{ key: "a", label: "A\nB", type: "text" }] }, /label: plain text on one line/],
    ["a bad key", { fields: [{ key: "A-b", label: "A", type: "text" }] }, /key: 1-40 lowercase letters/],
    ["max_length past the kind's ceiling", { fields: [{ key: "a", label: "A", type: "text", max_length: 9000 }] }, /max_length: a whole number from 1 to 500/],
    ["no fields", { fields: [] }, /a list of 1 to 20 fields/],
  ];
  for (const [what, spec, re] of refused) assert.match(accessRequestProblems(spec).join("\n"), re, what);
  ok(`the rules: ${refused.length} malformed blocks refused (a shell field's key, a key twice, options on text, a select without options, unknown keys, text that is not plain)`);

  const good = answersOf({ answers: { website: "acme.example", team_size: "11-50", tools: ["erp", "sheets", "erp"], goal: "  Line one\nline two ", nobody: "x" } }, fields);
  assert.equal(good.problem, null);
  assert.deepEqual(good.answers, { website: "https://acme.example", team_size: "11-50", tools: ["erp", "sheets"], goal: "Line one\nline two" }, "normalised, a repeat dropped, an undeclared key not kept");
  const bad: [unknown, RegExp][] = [
    [{ answers: {} }, /^Company website is required\.$/],
    [{ answers: { website: "not a site" } }, /^Company website: enter a web address/],
    [{ answers: { website: "javascript:alert(1)" } }, /^Company website: enter a web address/],
    [{ answers: { website: "a.example", team_size: "500+" } }, /^Team size: choose one of the options/],
    [{ answers: { website: "a.example", tools: ["sheets", "crm"] } }, /^Tools you use: choose from the options/],
    [{ answers: { website: "a.example", goal: "x".repeat(501) } }, /^What should it do first\?: at most 500 characters/],
    [{ answers: { website: "a.example", team_size: ["1-10"] } }, /^Team size: send text/],
    [{ answers: { website: "a.example\nb" } }, /plain text only/],
  ];
  for (const [body, re] of bad) assert.match(String(answersOf(body, fields).problem), re);
  // A host pack's own form posts its fields flat: a declared key at the top level is read; answers{} wins.
  assert.deepEqual(answersOf({ website: "flat.example", answers: { team_size: "1-10" } }, fields).answers, { website: "https://flat.example", team_size: "1-10" });
  assert.deepEqual(answersOf({ website: "flat.example", answers: { website: "inner.example" } }, fields).answers, { website: "https://inner.example" });
  assert.deepEqual(answersOf({ answers: { anything: "x" } }, []).answers, {}, "a build with no fields stores no answer");
  const shown = labelledAnswers(fields, { tools: ["sheets", "erp"], team_size: "1-10", product_url: "https://old.example" });
  assert.deepEqual(shown.map((a) => [a.label, a.text]), [["Team size", "1 to 10"], ["Tools you use", "Spreadsheets, An ERP"], ["Product url", "https://old.example"]],
    "labelled in the declared order, options by their labels, an undeclared older answer under its key");
  ok(`the answers: normalised (https://, repeats, trimming), ${bad.length} bad ones refused naming the label, a key nobody declared dropped, a host pack's flat form read`);

  const joined = joinAccessFields([{ id: "one", spec: { fields: [fields[0]] } }, { id: "two", spec: { fields: [fields[1]] } }], undefined);
  assert.deepEqual([joined.problems, joined.fields.map((f: F) => f.key)], [[], ["website", "team_size"]], "two packs' fields joined in pack order");
  assert.match(joinAccessFields([{ id: "one", spec: { fields: [fields[0]] } }, { id: "two", spec: { fields: [fields[0]] } }], undefined).problems.join(), /packs\/two: access_request\.fields: website is already pack one's/);
  assert.deepEqual(joinAccessFields([{ id: "one", spec: { fields } }], { fields: [fields[3]] }).fields.map((f: F) => f.key), ["goal"], "the app's profile.json replaces the packs'");
  ok("joined: two packs' fields in pack order, a key in two packs refused, the app's profile.json in place of the packs'");

  // ---------- 2. gen-packs ----------
  const shell = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
  const TMP = mkdtempSync(path.join(tmpdir(), "access-request-"));
  try {
    const copyOf = (name: string, packs: Record<string, object>, profile?: object) => {
      const copy = path.join(TMP, name);
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
      for (const nm of ["node_modules", "web/node_modules", "orchestrator/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(realpathSync(path.join(ROOT, nm)), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      for (const [id, extra] of Object.entries(packs)) {
        mkdirSync(path.join(copy, "packs", id), { recursive: true });
        writeFileSync(path.join(copy, "packs", id, "pack.json"), JSON.stringify({ id, name: `Pack ${id}`, version: "1.0.0", ...extra }, null, 2));
      }
      if (profile !== undefined) writeFileSync(path.join(copy, "profile.json"), JSON.stringify(profile, null, 2));
      const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
      return { copy, status: g.status, out: `${g.stdout}\n${g.stderr}` };
    };
    const generated = (copy: string) => {
      const read = (f: string) => JSON.parse(/= (\[[\s\S]*\]);\n/.exec(readFileSync(path.join(copy, f), "utf8"))![1]!);
      return [read("src/access-request.generated.ts"), read("web/src/config/access-request.generated.ts")];
    };
    const zero = copyOf("zero", {});
    assert.equal(zero.status, 0, zero.out.slice(-1500));
    assert.deepEqual(generated(zero.copy), [[], []], "no packs: no field");
    assert.equal(readFileSync(path.join(zero.copy, "web", "src", "lib", "access-request.generated.ts"), "utf8").split("\n").slice(1).join("\n"), shell("src/access-request.ts"), "the console's copy of the rules is the server's");
    const one = copyOf("one", { fields_pack: { access_request: { fields: FIELDS } } });
    assert.equal(one.status, 0, one.out.slice(-1500));
    const [server, web] = generated(one.copy);
    assert.deepEqual([server.map((f: F) => f.key), web], [FIELDS.map((f) => f.key), server], "the pack's fields, in order, for the server and the console");
    const two = copyOf("two", { fields_pack: { access_request: { fields: FIELDS.slice(0, 2) } }, more_fields: { access_request: { fields: FIELDS.slice(2) } } });
    assert.equal(two.status, 0, two.out.slice(-1500));
    assert.deepEqual(generated(two.copy)[0].map((f: F) => f.key), FIELDS.map((f) => f.key), "two packs' fields joined");
    const prof = copyOf("profile", { fields_pack: { access_request: { fields: FIELDS } } }, { name: "Acme", access_request: { fields: [{ key: "region", label: "Region", type: "text" }] } });
    assert.equal(prof.status, 0, prof.out.slice(-1500));
    assert.deepEqual(generated(prof.copy)[0].map((f: F) => f.key), ["region"], "the app's profile.json replaces the packs'");
    const no = (what: string, packs: Record<string, object>, re: RegExp, profile?: object) => {
      const b = copyOf(`no-${n}-${what.replace(/\W+/g, "-")}`, packs, profile);
      assert.notEqual(b.status, 0, `${what}: refused`);
      assert.match(b.out, re, what);
    };
    no("the same key in two packs", { fields_pack: { access_request: { fields: FIELDS } }, more_fields: { access_request: { fields: [FIELDS[0]] } } }, /packs\/more_fields: access_request\.fields: website is already pack fields_pack's/);
    no("a shell field's key", { fields_pack: { access_request: { fields: [{ key: "company", label: "Company", type: "text" }] } } }, /company is the shell's own field/);
    no("a select without options (the pack.json schema)", { fields_pack: { access_request: { fields: [{ key: "a", label: "A", type: "select" }] } } }, /options/);
    no("a malformed profile block", {}, /profile\.json: access_request\.fields\[0\]\.type/, { name: "Acme", access_request: { fields: [{ key: "a", label: "A", type: "file" }] } });
    ok("gen-packs: no packs, no field; a pack's fields written for the server and the console (the rules copied whole); two packs joined; the profile's in their place; a key twice, a shell field's key and malformed blocks refused");

    // ---------- 3 (and 4): the API, and the console, inside the copy with the pack ----------
    const r = spawnSync(TSX, ["scripts/access-request-test.ts", "--inner", ...(BROWSER ? ["--browser"] : []), ...(SHOTS ? ["--shots", SHOTS] : [])],
      { cwd: one.copy, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, AUTH_PROVIDER: "builtin", MOLD_TESTING_DIR: TESTING } });
    assert.equal(r.status, 0, "the checks inside the build copy");
  } finally { rmSync(TMP, { recursive: true, force: true }); }

  // ---------- zero-pack: this codebase ----------
  {
    const probe = path.join(ROOT, "scripts", `.access-request-zero-${process.pid}.mts`);
    writeFileSync(probe, `
      const { cleanup, startHttp } = await import("./lib/test-world.ts");
      try {
        const http = await startHttp();
        const { getDb } = await import("../src/db.ts");
        const r = await http.req("POST", "/api/access-requests", {}, { email: "zero@example.org", company: "Zero Co", product_url: "https://x.example", answers: { website: "a.example" } });
        if (r.status !== 201) throw new Error("status " + r.status);
        const [row] = await (await getDb()).query("SELECT answers, product_url FROM access_requests WHERE email = 'zero@example.org'");
        process.stdout.write("\\u0001" + JSON.stringify(row));
        await http.close();
      } finally { cleanup(); }
      process.exit(0);`);
    let zero;
    try { zero = spawnSync(TSX, [probe], { cwd: ROOT, encoding: "utf8", env: { ...process.env } }); } finally { rmSync(probe, { force: true }); }
    assert.equal(zero.status, 0, zero.stderr.slice(-1500));
    const row = JSON.parse(zero.stdout.slice(zero.stdout.indexOf("\u0001") + 1));
    assert.deepEqual([row.answers, row.product_url], [{}, null], "zero-pack: no answer stored, the old column stays empty");
    ok("zero-pack: a request stores no answer and nothing in the old columns, whatever it sends");
  }
  console.log(`access-request: ${n} checks passed${BROWSER ? "" : " (add --browser for the console)"}`);
}

// ---------- 3: the API in a build with the fixture pack (and 4, the console) ----------

async function inner() {
  const { cleanup, startHttp, STAMP, TMP } = await import("./lib/test-world.js");
  const teardown: (() => unknown)[] = [];
  try {
    const http = await startHttp();
    const { getDb } = await import("../src/db.js");
    const db = await getDb();
    process.env.RESEND_API_URL = http.mock.url;
    await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
    const mail = await import("../src/email.js");
    mail.setEmailProfileForTest({ notifications: ["access_requests"] });
    const staffEmail = `staff-${STAMP}@platform.example`;
    await (await import("../src/admin-roles.js")).addAdmin({ actor: "access-request-test", userId: null }, staffEmail, "owner"); // owners get the alert (src/email.ts adminRecipients)
    const call = async (method: string, p: string, h: Record<string, string> = {}, body?: unknown) => {
      const r = await http.req(method, p, h, body);
      const t = await r.text();
      let json: any = null;
      try { json = t ? JSON.parse(t) : null; } catch { json = t; }
      return { status: r.status, body: json };
    };
    const email = `ana-${STAMP}@acme.example`;
    const sent = await call("POST", "/api/access-requests", {}, { email, company: "Acme", name: "Ana", message: "Hello",
      answers: { website: "acme.example", team_size: "11-50", tools: ["sheets", "erp"], goal: "Close the books faster.", undeclared: "dropped" }, source: { landing: "/request-access" } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const [row] = await db.query<{ answers: any; product_url: string | null; role: string | null }>("SELECT answers, product_url, role FROM access_requests WHERE email = $1", [email]);
    assert.deepEqual(row!.answers, { website: "https://acme.example", team_size: "11-50", tools: ["sheets", "erp"], goal: "Close the books faster." });
    assert.deepEqual([row!.product_url, row!.role], [null, null], "the old columns are not written");
    const refusals: [object, RegExp][] = [
      [{ answers: { team_size: "1-10" } }, /^Company website is required\.$/],
      [{ answers: { website: "a.example", team_size: "huge" } }, /^Team size: choose one of the options offered\.$/],
      [{ answers: { website: "no site here" } }, /^Company website: enter a web address/],
    ];
    for (const [extra, re] of refusals) {
      const r = await call("POST", "/api/access-requests", {}, { email: `x-${STAMP}@acme.example`, company: "X", ...extra });
      assert.equal(r.status, 400); assert.match(r.body.error, re);
    }
    assert.equal((await db.query("SELECT 1 FROM access_requests WHERE email = $1", [`x-${STAMP}@acme.example`])).length, 0, "nothing stored for a refused request");
    ok("the API: answers stored (https:// added, the options chosen), an undeclared key dropped, the old columns untouched; a required field, an option and an address refused naming the label");

    // The staff side: the list, the admin MCP tool, the alert email.
    const adminH = { authorization: `Bearer ${await http.adminToken("support")}` };
    const list = await call("GET", "/api/admin/onboarding/requests", adminH);
    assert.equal(list.status, 200);
    const mine = list.body.requests.find((q: any) => q.email === email);
    assert.deepEqual(mine.answers.tools, ["sheets", "erp"]);
    assert.ok(!("product_url" in mine) && !("agents" in mine), "no column of the first product's form in the list");
    const { runAdminTool } = await import("../src/admin-mcp.js");
    const tool = await runAdminTool({ actor: "test", role: "support", userId: null }, "list_access_requests", { status: "pending" });
    const listed = (tool.structuredContent as any)?.requests ?? JSON.parse((tool.content[0] as any).text).requests;
    assert.deepEqual(listed.find((q: any) => q.email === email).answers,
      { "Company website": "https://acme.example", "Team size": "11 to 50", "Tools you use": "Spreadsheets, An ERP", "What should it do first?": "Close the books faster." });
    let alert: any = null;
    for (let i = 0; i < 200 && !alert; i++) {
      alert = (http.mock.state.emails as any[]).find((e) => e.subject === "New access request: Acme");
      if (!alert) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(alert, "the operator's alert");
    assert.match(alert.text, /Company website: https:\/\/acme\.example\nTeam size: 11 to 50\nTools you use: Spreadsheets, An ERP\nWhat should it do first\?: Close the books faster\./);
    ok("staff: the list carries the answers (no column of the first product's form), list_access_requests names them by label, the alert email lists them under their labels");

    // The migration's backfill: an older row's own columns become its answers (run again on a row written the old way).
    const backfill = readFileSync(path.join(import.meta.dirname, "..", "sql", "migrations", "0020_access_request_answers.sql"), "utf8").split(/\n(?=UPDATE access_requests q)/)[1]!;
    await db.query(`INSERT INTO access_requests (email, company, product_url, agents, goal, team_size, docs_url) VALUES ($1, 'Old Co', 'https://old.example', '{Agent A,Agent B}', 'other', '', NULL)`, [`old-${STAMP}@old.example`]);
    await db.query(backfill);
    const [old] = await db.query<{ answers: any }>("SELECT answers FROM access_requests WHERE email = $1", [`old-${STAMP}@old.example`]);
    assert.deepEqual(old!.answers, { product_url: "https://old.example", agents: ["Agent A", "Agent B"], goal: "other" }, "the old columns as answers; empty ones left out");
    const [still] = await db.query<{ answers: any }>("SELECT answers FROM access_requests WHERE email = $1", [email]);
    assert.equal(still!.answers.website, "https://acme.example", "a row with answers is left as it is");
    ok("the migration: an older row's columns become its answers under their keys (empty ones left out); a row with answers is not touched");

    if (BROWSER) await browserChecks({ http, db, staffEmail, STAMP, TMP, teardown });
  } finally {
    for (const f of teardown.reverse()) { try { await f(); } catch { /* best effort */ } }
    cleanup();
  }
}

// ---------- 4: the console ----------

async function freePort() {
  return new Promise<number>((res, rej) => {
    const s = netServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

async function browserChecks(w: { http: any; db: any; staffEmail: string; STAMP: string; TMP: string; teardown: (() => unknown)[] }) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const apiPort = await freePort();
  const web = path.join(ROOT, "web");
  const out = path.join(w.TMP, "console");
  cpSync(web, path.join(out, "web"), { recursive: true, filter: (src) => !["node_modules", ".next", ".turbo"].includes(path.basename(src)) && !path.basename(src).startsWith(".env") });
  symlinkSync(realpathSync(path.join(web, "node_modules")), path.join(out, "web", "node_modules"), "dir");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_AUTH_PROVIDER: "builtin", APP_API_URL: `http://127.0.0.1:${apiPort}` };
  console.log("  next build of the console…");
  const b = spawnSync("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: path.join(out, "web"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (b.status !== 0) throw new Error(`next build failed:\n${(b.stdout + b.stderr).split("\n").slice(-40).join("\n")}`);
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  process.env.PUBLIC_URL = origin;
  const { createApp } = await import("../src/http.js");
  const api = createApp().listen(apiPort, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  w.teardown.push(() => new Promise((r) => api.close(() => r(null))));
  const next: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(consolePort), "-H", "127.0.0.1"], { cwd: path.join(out, "web"), stdio: ["ignore", "pipe", "pipe"], env });
  let log = "";
  next.stdout?.on("data", (d) => { log = (log + d).slice(-8000); }); next.stderr?.on("data", (d) => { log = (log + d).slice(-8000); });
  w.teardown.push(() => new Promise((r) => { if (next.exitCode !== null) return r(null); next.once("exit", () => r(null)); next.kill("SIGTERM"); setTimeout(() => { next.kill("SIGKILL"); r(null); }, 5000); }));
  let up = false;
  for (let i = 0; i < 120 && !up && next.exitCode === null; i++) {
    try { up = (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })).status < 500; } catch { await wait(1000); }
  }
  assert.ok(up, `the console came up on ${origin}:\n${log}`);

  // Staff sign in with an emailed code (the built-in sign-in), as a browser would.
  const kindOf = (e: any) => e.tags?.find((t: any) => t.name === "kind")?.value;
  const h = { "x-forwarded-for": "198.51.100.7" };
  assert.equal((await w.http.req("POST", "/api/auth/email/request", h, { email: w.staffEmail })).status, 200);
  let code: string | null = null;
  for (let i = 0; i < 200 && !code; i++) {
    const m = (w.http.mock.state.emails as any[]).filter((e) => e.to.includes(w.staffEmail) && kindOf(e) === "sign_in_code").at(-1);
    code = m ? /sign-in code is (\d{8})/.exec(m.text)![1]! : null;
    if (!code) await wait(20);
  }
  const v = await w.http.req("POST", "/api/auth/email/verify", h, { email: w.staffEmail, code });
  assert.equal(v.status, 200);
  const cookie = v.headers.getSetCookie().find((c: string) => /^(__Host-)?oct_session=[^;]+/.test(c) && !/Max-Age=0/.test(c))!.split(";")[0]!;

  const AXE = readFileSync(path.join(TESTING, "accessibility", "vendor", "axe.min.js"), "utf8");
  const browser = await pw.chromium.launch();
  w.teardown.push(() => browser.close());
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const ctx = async (signedIn: boolean, width = 1280) => {
    const c = await browser.newContext({ baseURL: origin, serviceWorkers: "block", reducedMotion: "reduce", viewport: { width, height: 900 }, ...(width < 1024 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    if (signedIn) await c.addCookies([{ name: cookie.split("=")[0]!, value: cookie.slice(cookie.indexOf("=") + 1), url: origin }]);
    return c;
  };
  const grade = async (p: any, label: string) => {
    await p.addScriptTag({ content: AXE });
    const found = await p.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] }, resultTypes: ["violations"] }))
      .violations.map((x: any) => ({ id: x.id, impact: x.impact, target: x.nodes[0]?.target?.join(" ") })));
    assert.deepEqual(found.filter((x: any) => x.impact === "serious" || x.impact === "critical"), [], `${label}: serious or critical axe violations`);
  };
  const narrow = async (signedIn: boolean, url: string, ready: string, label: string) => {
    const c = await ctx(signedIn, 390);
    const p = await c.newPage();
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector(ready, { timeout: 20000 });
    const wide = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(wide[0] <= wide[1] + 1, `${label} at 390 px scrolls sideways (${wide[0]} > ${wide[1]})`);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${label.replace(/\W+/g, "-")}-390.png`), fullPage: true });
    await c.close();
  };

  // /request-access asks the declared fields and sends them.
  {
    const c = await ctx(false);
    const p = await c.newPage();
    await p.goto("/request-access", { waitUntil: "networkidle" });
    const form = p.locator('[data-testid="request-access-form"]');
    await form.waitFor({ timeout: 20000 });
    const order = await form.locator("[data-field]").evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-field")));
    assert.deepEqual(order, FIELDS.map((f) => f.key), "the declared fields, in order");
    assert.equal(await p.getByLabel("Company website").getAttribute("required"), "", "a required field is required");
    assert.ok(await p.getByText("A sentence or two is plenty.").isVisible(), "a field's help");
    await grade(p, "request access");
    await form.locator('input[name="email"]').fill(`browser-${w.STAMP}@browser.example`);
    await form.locator('input[name="company"]').fill("Browser Co");
    await p.getByLabel("Company website").fill("browser.example");
    await p.getByLabel(/Team size/).selectOption("11-50");
    await p.getByLabel("Spreadsheets").check(); await p.getByLabel("An ERP").check();
    await p.getByLabel(/What should it do first/).fill("Reports.");
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "request-access-1280.png"), fullPage: true });
    await form.locator('button[type="submit"]').click();
    await p.waitForSelector('[data-testid="request-access-sent"]', { timeout: 15000 });
    const [row] = await w.db.query("SELECT answers FROM access_requests WHERE company = 'Browser Co'");
    assert.deepEqual(row?.answers, { website: "https://browser.example", team_size: "11-50", tools: ["sheets", "erp"], goal: "Reports." });
    await c.close();
    await narrow(false, "/request-access", '[data-testid="request-access-form"]', "request access");
    ok("the console: /request-access asks the declared fields in order (a line, a choice, several, a box, with help), sends them and they are stored");
  }
  // /admin/requests shows them under their labels.
  {
    const c = await ctx(true);
    const p = await c.newPage();
    await p.goto("/admin/requests", { waitUntil: "networkidle" });
    const row = p.locator("tr", { hasText: "Browser Co" });
    await row.waitFor({ timeout: 20000 });
    assert.match(await row.innerText(), /browser\.example/, "the site under the company");
    await row.click();
    const peek = p.locator('aside[aria-label="Record"]');
    await peek.waitFor({ timeout: 10000 });
    const text = await peek.innerText();
    for (const re of [/Company website\s*browser\.example/, /Team size\s*11 to 50/, /Tools you use\s*Spreadsheets, An ERP/, /What should it do first\?\s*Reports\./])
      assert.match(text, re, `the open request: ${re}`);
    assert.doesNotMatch(text, /Agents|Competitors|Wants first|baseline/i, "nothing of the first product's form");
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "admin-requests-1280.png"), fullPage: true });
    await grade(p, "admin requests");
    await c.close();
    await narrow(true, "/admin/requests", "tr", "admin requests");
    ok("the console: /admin/requests shows each answer under its label in the open request, the site under the company; axe clean on both pages, nothing scrolls sideways at 390 px");
  }
}
