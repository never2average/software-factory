// The early-access form and sign-in editor (mold_v0-266; src/access-pages.ts, src/access-request.ts, 0055_access_pages),
// offline: the rules, the defaults, the API on an embedded database and (with --browser) the console.
//   npm run test:access-pages
//   tsx scripts/access-pages-test.ts [--browser] [--shots <dir>]
//
// 1. The rules: a saved form keeps email (asked, required, an address), refuses a hidden required field, several choices
//    in one of the shell's columns, braces in its words but {email} and {company}, unknown keys; the sign-in words refuse
//    a bad address, braces but {terms}, {privacy} and {provider}, unknown keys.
// 2. The defaults reproduce today's form: the /request-access form and a request page's form as the editor starts from
//    them are the forms the build drew before (every field's key, label, kind, required, length and placeholder, in order;
//    the button and the thank-you words), and a request checked against them is accepted, refused and stored exactly as
//    the API did without a saved form, request by request.
// 3. The API (this codebase, an embedded database): nothing saved, GET /api/access-pages is null and a request is
//    checked as before; staff-only writes (signed out 401, Viewer and Support 403, Operator saves); a save is version 1,
//    audited (who, when, before null, after the form) and the public pages read it at once; a stale version is 409 and a
//    malformed form 400 with its problems; requests are checked against the CURRENT form (required, kinds, options,
//    hidden fields dropped, the shell's columns as the form asks them) and stored with every answer; the staff list
//    carries them, list_access_requests and the alert email name them by the form's labels; a second save's before is
//    the first's after; Reset to defaults is a version of its own (after null) and requests are checked as before again;
//    the sign-in words save, refuse a bad address and read back; the history lists every version, newest first.
// 4. --browser: a build copy with a fixture pack (four questions, a request page with a fold), the console built with
//    the built-in sign-in: the request page and /request-access draw the same with the defaults saved as with nothing
//    saved (every label, input, button and text); staff edit the form in Admin › Access requests › Request form (the
//    side panel: a label, a new number field), the preview follows the draft, Save makes it live; the request page asks
//    the new form and its answers land in the request, which Access requests shows under their labels; the sign-in page
//    shows staff's words and legal line. With --shots: each in light and dark at 1440 and 390 px.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INNER = process.argv.includes("--inner");
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

/** The fixture pack's questions (as scripts/access-request-test.ts's): one of each kind the form draws differently. */
const FIELDS = [
  { key: "website", label: "Company website", type: "url", required: true, placeholder: "https://example.com" },
  { key: "team_size", label: "Team size", type: "select", options: [{ value: "1-10", label: "1 to 10" }, { value: "11-50", label: "11 to 50" }] },
  { key: "tools", label: "Tools you use", type: "multi_select", options: [{ value: "sheets", label: "Spreadsheets" }, { value: "erp", label: "An ERP" }] },
  { key: "goal", label: "What should it do first?", type: "long_text", max_length: 500, help: "A sentence or two is plenty." },
];
/** A request page as a pack declares one (src/landing.ts request_page), with a fold: `goal` it never asks. */
const REQUEST_PAGE = {
  path: "/early-access", eyebrow: "Early access", title: "Ask for", title_highlight: "early access.", lead: "Tell us about your team and we will be in touch.",
  form: { submit: "Ask for access", message_label: "Anything else we should know?", fields: ["website"], more: { label: "Add details", fields: ["team_size", "tools"] },
    done: { title: "You are on the list", steps: ["We look at {company}.", "We email {email} to set up your account."] } },
};
const WORDS = { message: "What would you like to use Workspace for?", thanks: "Thank you. The Workspace team will look at it", first_step: "The Workspace team looks at your request." };

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

if (INNER) await inner();
else await outer();
process.exit(0);

async function outer() {
  const R = await import("../src/access-request.js");
  type F = import("../src/access-request.js").AccessField;
  type C = import("../src/access-request.js").AccessFormConfig;
  const fields = FIELDS as F[];

  // ---------- 1. the rules ----------
  const base = R.defaultRequestForm(fields, WORDS, null);
  assert.deepEqual(R.accessFormProblems(base), [], "the defaults are a valid form");
  const edit = (fn: (c: C) => void) => { const c = structuredClone(base); fn(c); return c; };
  const refused: [string, unknown, RegExp][] = [
    ["no email field", edit((c) => { c.fields = c.fields.filter((f) => f.key !== "email"); }), /the email field is always in the form/],
    ["email hidden", edit((c) => { c.fields[0]!.hidden = true; c.fields[0]!.required = undefined as never; delete c.fields[0]!.required; }), /email field is always (asked|required)/],
    ["email optional", edit((c) => { delete c.fields[0]!.required; }), /the email field is always required/],
    ["email retyped", edit((c) => { c.fields[0]!.type = "text"; }), /the email field is always an email address/],
    ["a hidden required field", edit((c) => { c.fields[2]!.hidden = true; }), /a hidden field cannot be required/],
    ["several choices in a column", edit((c) => { Object.assign(c.fields[2]!, { type: "multi_select", options: [{ value: "a", label: "A" }] }); delete c.fields[2]!.max_length; }), /company is one answer/],
    ["a key twice", edit((c) => { c.fields.push({ key: "website", label: "Again", type: "text" }); }), /website is in the form twice/],
    ["source as a key", edit((c) => { c.fields.push({ key: "source", label: "Source", type: "text" }); }), /source is where the request came from/],
    ["an unknown kind", edit((c) => { c.fields.push({ key: "cv", label: "CV", type: "file" as never }); }), /type: one of text, long_text, email, select, multi_select, number, url/],
    ["an unknown key", edit((c) => { (c as unknown as Record<string, unknown>).intro = "x"; }), /intro: unknown key/],
    ["braces in the thank-you", edit((c) => { c.thanks.lines = ["Hello {name}"]; }), /thanks\.lines\[0\]: .*\{email\} and \{company\} are the only words in braces/],
    ["no thank-you line", edit((c) => { c.thanks.lines = []; }), /thanks\.lines: 1 to 6 lines/],
    ["a length past the column", edit((c) => { c.fields[1]!.max_length = 500; }), /max_length: a whole number from 1 to 120/],
    ["a choice without options", edit((c) => { c.fields.push({ key: "plan", label: "Plan", type: "select" }); }), /options: a list of 1 to 30/],
  ];
  for (const [what, cfg, re] of refused) assert.match(R.accessFormProblems(cfg).join("\n"), re, what);
  assert.deepEqual(R.accessFormProblems(edit((c) => { c.thanks.lines = ["We look at {company} and write to {email}."]; c.fields.push({ key: "seats", label: "Seats", type: "number", required: true }); })), [], "tokens and a number are fine");
  const signRefused: [string, unknown, RegExp][] = [
    ["an unknown key", { title: "x" }, /title: unknown key/],
    ["a word not plain", { sign_in: { title: "Hi <b>" } }, /sign_in\.title: plain text/],
    ["braces in the legal line", { legal: { text: "See {cookies}" } }, /\{terms\} and \{privacy\} are the only words in braces/],
    ["a bad address", { legal: { text: "See {terms}", terms_url: "javascript:alert(1)" } }, /legal\.terms_url: a path of this site/],
    ["a method twice", { hidden_methods: ["oauth_google", "oauth_google"] }, /hidden_methods: a list/],
  ];
  for (const [what, cfg, re] of signRefused) assert.match(R.signInProblems(cfg).join("\n"), re, what);
  assert.deepEqual(R.signInProblems({ sign_in: { title: "Welcome", subtitle: "Use your work address.", button: "Send my code" }, social_button: "Use {provider}",
    legal: { text: "By continuing you agree to the {terms} and the {privacy}.", terms_url: "https://example.com/terms" }, hidden_methods: ["google"] }), [], "a full sign-in config passes");
  assert.deepEqual(R.legalLineParts("Agree to the {terms} and {privacy}."), [{ text: "Agree to the " }, { link: "terms" }, { text: " and " }, { link: "privacy" }, { text: "." }]);
  ok(`the rules: ${refused.length} malformed forms and ${signRefused.length} malformed sign-in configs refused (email always asked, required and an address; tokens; lengths; kinds)`);

  // ---------- 2. the defaults reproduce today's form ----------
  // What /request-access drew before mold_v0-266 (web/src/features/site/request-access-form.tsx at main): a work email and
  // a name side by side, the company, the build's questions, the message; "Request access"; "Request sent" and its line.
  const pick = (c: C) => c.fields.map((f) => [f.key, f.label, f.type, !!f.required, !!f.hidden, f.max_length ?? null, f.placeholder ?? null]);
  assert.deepEqual(pick(base), [
    ["email", "Work email", "email", true, false, 200, null], ["name", "Your name", "text", false, false, 120, null], ["company", "Company", "text", true, false, 200, null],
    ["website", "Company website", "url", true, false, null, "https://example.com"], ["team_size", "Team size", "select", false, false, null, null],
    ["tools", "Tools you use", "multi_select", false, false, null, null], ["goal", "What should it do first?", "long_text", false, false, 500, null],
    ["message", WORDS.message, "long_text", false, false, 4000, null]]);
  assert.deepEqual([base.submit, base.thanks], ["Request access", { title: "Request sent", lines: [`${WORDS.thanks} and, once it is approved, send an invitation to {email}. Nothing else is needed from you for now.`] }]);
  // What a request page drew (request-page-form.tsx at main): email and company first (their placeholders), the page's
  // fields, the fold (name, its fields, the message under message_label); a field it never asks is not asked.
  const page = R.defaultRequestForm(fields, WORDS, REQUEST_PAGE.form);
  assert.deepEqual(pick(page), [
    ["email", "Work email", "email", true, false, 254, "you@company.com"], ["company", "Company", "text", true, false, 200, "Acme"],
    ["website", "Company website", "url", true, false, null, "https://example.com"], ["name", "Your name", "text", false, false, 120, null],
    ["team_size", "Team size", "select", false, false, null, null], ["tools", "Tools you use", "multi_select", false, false, null, null],
    ["goal", "What should it do first?", "long_text", false, true, 500, null], ["message", "Anything else we should know?", "long_text", false, false, 4000, null]]);
  assert.deepEqual([page.submit, page.thanks], ["Ask for access", REQUEST_PAGE.form.done.steps && { title: "You are on the list", lines: REQUEST_PAGE.form.done.steps }]);
  const noFold = R.defaultRequestForm(fields, WORDS, {});
  assert.deepEqual(noFold.fields.map((f) => f.key), ["email", "company", "name", "website", "team_size", "tools", "goal", "message"], "a page without a fold: the name before the questions");
  assert.deepEqual([noFold.submit, noFold.thanks.title, noFold.thanks.lines], ["Request access", "Request sent", [WORDS.first_step, "Once it is approved, an invitation goes to {email}."]]);
  assert.deepEqual(R.accessFormProblems(page), [], "the page's defaults are a valid form");
  assert.deepEqual(R.defaultRequestForm([], WORDS, null).fields.map((f) => f.key), ["email", "name", "company", "message"], "zero packs: the shell's four");

  // The API's check without a saved form (src/http.ts before mold_v0-266, unchanged on that path), request by request.
  const legacy = (body: Record<string, unknown>) => {
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const email = s(body.email, 200), company = s(body.company, 200), message = s(body.message, 4000), name = s(body.name, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { problem: "Please enter a valid email." };
    if (!company) return { problem: "Please tell us your company." };
    const a = R.answersOf(body, fields);
    return a.problem ? { problem: a.problem } : { stored: { email, company, name, message, answers: a.answers } };
  };
  const viaForm = (cfg: C, body: Record<string, unknown>) => {
    const r = R.formSubmission(body, cfg);
    return r.problem ? { problem: r.problem } : { stored: { email: r.email, company: r.company, name: r.name, message: r.message, answers: r.answers } };
  };
  const good = { email: "ana@acme.example", company: "Acme", name: "Ana", message: "Hello\nthere", answers: { website: "acme.example", team_size: "11-50", tools: ["erp", "sheets", "erp"], goal: "Close the books." } };
  const bodies: Record<string, unknown>[] = [
    good, { ...good, name: "" }, { ...good, message: "" }, { ...good, email: "not-an-address" }, { ...good, email: "" }, { ...good, company: "" }, { ...good, company: "   " },
    { ...good, answers: { team_size: "1-10" } }, { ...good, answers: { website: "a.example", team_size: "500+" } }, { ...good, answers: { website: "a.example", tools: ["crm"] } },
    { ...good, answers: { website: "nope" } }, { ...good, answers: { website: "a.example", goal: "x".repeat(501) } }, { ...good, answers: { website: "a.example", undeclared: "x" } },
    { ...good, website: "flat.example", answers: {} }, { ...good, company: "C".repeat(250), name: "N".repeat(200), message: "M".repeat(5000) }, { email: " pad@acme.example ", company: " Pad Co ", answers: { website: " pad.example " } },
  ];
  for (const b of bodies) assert.deepEqual(viaForm(base, b), legacy(b), `the same outcome for ${JSON.stringify(b).slice(0, 120)}`);
  // The request page's form never sends what it does not ask (goal): for what it sends, the same outcome too.
  for (const b of bodies.filter((x) => !(x.answers as Record<string, unknown> | undefined)?.goal)) assert.deepEqual(viaForm(page, b), legacy(b), `the page's defaults: ${JSON.stringify(b).slice(0, 120)}`);
  ok(`the defaults reproduce today's forms: /request-access's and a request page's fields (keys, labels, kinds, required, lengths, placeholders, order), button and thank-you words; ${bodies.length} requests accepted, refused and stored as the API did without a saved form`);

  // ---------- 3 (and 4): the API, and the console, inside a build copy with the fixture pack ----------
  const TMP = mkdtempSync(path.join(tmpdir(), "access-pages-"));
  try {
    let copy = ROOT;
    if (BROWSER) {
      copy = path.join(TMP, "copy");
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
      for (const nm of ["node_modules", "web/node_modules", "orchestrator/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(realpathSync(path.join(ROOT, nm)), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs", "fields_pack"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      writeFileSync(path.join(copy, "packs", "fields_pack", "pack.json"), JSON.stringify({ id: "fields_pack", name: "Fields pack", version: "1.0.0", access_request: { fields: FIELDS }, landing: { request_page: REQUEST_PAGE } }, null, 2));
      const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
      assert.equal(g.status, 0, `${g.stdout}\n${g.stderr}`.slice(-1500));
    }
    const r = spawnSync(TSX, ["scripts/access-pages-test.ts", "--inner", ...(BROWSER ? ["--browser"] : []), ...(SHOTS ? ["--shots", SHOTS] : [])],
      { cwd: copy, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, AUTH_PROVIDER: "builtin", APP_PROXY_HOPS: "1" } });
    assert.equal(r.status, 0, "the checks on the API (and the console)");
  } finally { rmSync(TMP, { recursive: true, force: true }); }
  console.log(`access-pages: ${n} checks passed on the rules and the defaults${BROWSER ? "" : " (add --browser for the console)"}`);
}

// ---------- 3: the API ----------

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
    await (await import("../src/admin-roles.js")).addAdmin({ actor: "access-pages-test", userId: null }, staffEmail, "owner");
    let ip = 10;
    const call = async (method: string, p: string, h: Record<string, string> = {}, body?: unknown) => {
      const r = await http.req(method, p, { "x-forwarded-for": `198.51.100.${ip++ % 250}`, ...h }, body);
      const t = await r.text();
      let json: any = null;
      try { json = t ? JSON.parse(t) : null; } catch { json = t; }
      return { status: r.status, body: json };
    };
    const tok = async (role: "viewer" | "support" | "operator" | "owner") => ({ authorization: `Bearer ${await http.adminToken(role)}`, "x-app-admin": "1" });
    const operator = await tok("operator");
    const A = await import("../src/access-pages.js");
    const R = await import("../src/access-request.js");
    const { GENERATED_ACCESS_FIELDS } = await import("../src/access-request.generated.js");
    const declared = [...GENERATED_ACCESS_FIELDS];

    // Nothing saved: null, and a request is checked as it always was.
    assert.deepEqual((await call("GET", "/api/access-pages")).body, { request_form: null, sign_in: null });
    const before = await call("POST", "/api/access-requests", {}, { email: `x-${STAMP}@acme.example`, company: "" });
    assert.deepEqual([before.status, before.body.error], [400, "Please tell us your company."], "as before: the company is required");
    ok("nothing saved: GET /api/access-pages is null for both pages and a request is checked as before");

    // Staff-only writes.
    const words = { message: "What would you like to use it for?", thanks: "Thank you", first_step: "We look at it." };
    const defaults = R.defaultRequestForm(declared, words, null);
    const form1 = structuredClone(defaults);
    const company = form1.fields.find((f) => f.key === "company")!;
    Object.assign(company, { label: "Organisation", help: "Leave it empty if you are on your own." }); delete company.required;
    form1.fields.find((f) => f.key === "message")!.hidden = true;
    // The build's own questions (the fixture pack's, in the browser's build copy) hidden: a field the form no longer asks.
    for (const f of form1.fields) if (!R.isShellFormKey(f.key)) { f.hidden = true; delete f.required; }
    form1.fields.splice(3, 0,
      { key: "seats", label: "Seats", type: "number", required: true, help: "Roughly is fine." },
      { key: "plan", label: "Plan", type: "select", options: [{ value: "team", label: "Team" }, { value: "scale", label: "Scale" }] },
      { key: "role", label: "Role", type: "text", person: true },
      { key: "channels", label: "How you heard of us", type: "multi_select", options: [{ value: "friend", label: "A friend" }, { value: "search", label: "A search" }] });
    form1.submit = "Join the list"; form1.thanks = { title: "You are in", lines: ["We will write to {email} about {company}."] };
    const put = (h: Record<string, string>, body: unknown, id = "request_form") => call("PUT", `/api/admin/onboarding/access-pages/${id}`, h, body);
    assert.equal((await put({ "x-app-admin": "1" }, { version: 0, config: form1 })).status, 401, "signed out: refused");
    for (const role of ["viewer", "support"] as const) {
      const r = await put(await tok(role), { version: 0, config: form1 });
      assert.equal(r.status, 403, `${role}: refused`); assert.match(r.body.error, /needs the Operator role/);
    }
    assert.equal((await call("POST", "/api/admin/onboarding/access-pages/request_form/reset", await tok("support"), { version: 0 })).status, 403, "support may not reset");
    assert.equal((await call("GET", "/api/admin/onboarding/access-pages", await tok("viewer"))).status, 200, "a viewer reads");
    assert.equal((await call("GET", "/api/admin/onboarding/access-pages")).status, 401, "signed out reads nothing");
    assert.deepEqual((await db.query("SELECT count(*)::int AS n FROM access_page_changes"))[0], { n: 0 }, "nothing written by a refused write");
    ok("staff-only writes: signed out 401, Viewer and Support 403 (the Operator role is named), a Viewer reads, nothing written");

    // A save: version 1, audited, live at once.
    const bad = await put(operator, { version: 0, config: { ...form1, fields: form1.fields.map((f) => (f.key === "email" ? { ...f, hidden: true } : f)) } });
    assert.equal(bad.status, 400); assert.ok(bad.body.problems.some((p: string) => /email field is always asked/.test(p)), "the problems listed");
    const s1 = await put(operator, { version: 0, config: form1 });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.page.version, 1);
    assert.match(s1.body.page.updated_by, /^token:test-operator-/);
    assert.deepEqual((await call("GET", "/api/access-pages")).body.request_form, form1, "the public pages read it at once");
    const stale = await put(operator, { version: 0, config: form1 });
    assert.equal(stale.status, 409); assert.match(stale.body.error, /Someone saved version 1/);
    const [c1] = await db.query<any>("SELECT version, action, changed_by, before, after, changed_at FROM access_page_changes WHERE page_id = 'request_form' ORDER BY id");
    assert.deepEqual([c1.version, c1.action, c1.before, c1.after], [1, "edited", null, form1], "the change: version, action, before (the defaults: null) and after");
    assert.match(c1.changed_by, /^token:test-operator-/); assert.ok(c1.changed_at, "when");
    ok("a save: version 1 with who and when, the change before (defaults) and after (the form), live on GET /api/access-pages at once; a stale version 409, a malformed form 400 naming its problems");

    // Requests checked against the CURRENT form.
    const send = (body: Record<string, unknown>) => call("POST", "/api/access-requests", {}, body);
    const who = `ana-${STAMP}@acme.example`;
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ email: who, answers: {} }, /^Seats is required\.$/],
      [{ email: who, answers: { seats: "a dozen" } }, /^Seats: enter a number/],
      [{ email: who, answers: { seats: "12", plan: "enterprise" } }, /^Plan: choose one of the options offered\.$/],
      [{ email: who, answers: { seats: "12", channels: ["radio"] } }, /^How you heard of us: choose from the options offered\.$/],
      [{ email: "nobody", answers: { seats: "12" } }, /^Please enter a valid email\.$/],
    ];
    for (const [b, re] of refusals) { const r = await send(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.body.error, re); }
    const sent = await send({ email: who, name: "Ana", message: "a hidden field's answer", answers: { seats: "12", plan: "scale", role: "Head of Ops", channels: ["friend", "search"], website: "dropped.example" } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const [row] = await db.query<any>("SELECT email, name, company, message, answers FROM access_requests WHERE email = $1", [who]);
    assert.deepEqual(row, { email: who, name: "Ana", company: "", message: null, answers: { seats: "12", plan: "scale", role: "Head of Ops", channels: ["friend", "search"] } },
      "stored: the company optional now (empty), the hidden message dropped, every asked answer kept, a field the form no longer asks dropped");
    ok(`requests checked against the current form: ${refusals.length} refused (required, a number, an option, several options, the address), one stored with every answer, a hidden field and one no longer asked dropped`);

    // Staff see every answer under the form's labels.
    const list = await call("GET", "/api/admin/onboarding/requests", await tok("viewer"));
    assert.deepEqual(list.body.requests.find((q: any) => q.email === who).answers, row.answers, "the staff list carries every answer");
    const { runAdminTool } = await import("../src/admin-mcp.js");
    const tool = await runAdminTool({ actor: "test", role: "support", userId: null }, "list_access_requests", { status: "pending" });
    const listed = (tool.structuredContent as any)?.requests ?? JSON.parse((tool.content[0] as any).text).requests;
    assert.deepEqual(listed.find((q: any) => q.email === who).answers, { Seats: "12", Plan: "Scale", Role: "Head of Ops", "How you heard of us": "A friend, A search" }, "list_access_requests: by the form's labels");
    let alert: any = null;
    for (let i = 0; i < 200 && !alert; i++) { alert = (http.mock.state.emails as any[]).find((e) => e.subject === "New access request: " && e.text.includes(who)) ?? (http.mock.state.emails as any[]).find((e) => e.text?.includes(who) && /Seats: 12/.test(e.text)); if (!alert) await new Promise((r) => setTimeout(r, 20)); }
    assert.ok(alert, "the operator's alert");
    assert.match(alert.text, /Seats: 12\nPlan: Scale\nRole: Head of Ops\nHow you heard of us: A friend, A search/, "the alert lists them under the form's labels");
    assert.deepEqual(R.labelledAnswers(await A.answerLabelFields(), row.answers).map((a) => a.label), ["Seats", "Plan", "Role", "How you heard of us"]);
    ok("staff: the list carries every answer; list_access_requests and the alert email name them by the form's labels");

    // A second save, then Reset to defaults.
    const form2 = structuredClone(form1);
    form2.fields.find((f) => f.key === "seats")!.label = "Seats you need";
    const s2 = await put(operator, { version: 1, config: form2 });
    assert.equal(s2.body.page.version, 2);
    const reset = await call("POST", "/api/admin/onboarding/access-pages/request_form/reset", operator, { version: 2 });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.deepEqual([reset.body.page.version, reset.body.page.config], [3, null]);
    assert.equal((await call("POST", "/api/admin/onboarding/access-pages/request_form/reset", operator, { version: 3 })).status, 400, "a second reset: already the defaults");
    const trail = await db.query<any>("SELECT version, action, before, after FROM access_page_changes WHERE page_id = 'request_form' ORDER BY id");
    assert.deepEqual(trail.map((t: any) => [t.version, t.action]), [[1, "edited"], [2, "edited"], [3, "reset"]]);
    assert.deepEqual([trail[1].before, trail[1].after, trail[2].before, trail[2].after], [form1, form2, form2, null], "each version's before is the one before's after");
    assert.deepEqual((await call("GET", "/api/access-pages")).body.request_form, null, "the defaults again");
    const again = await send({ email: `y-${STAMP}@acme.example`, company: "" });
    assert.deepEqual([again.status, again.body.error], [400, "Please tell us your company."], "checked as before again");
    const hist = await call("GET", "/api/admin/onboarding/access-pages/request_form/changes", await tok("viewer"));
    assert.deepEqual(hist.body.changes.map((c: any) => c.version), [3, 2, 1], "the history, newest first");
    ok("versioned: a second save (its before the first's after), Reset to defaults a version of its own (after null), refused when already the defaults; requests checked as before again; the history newest first");

    // The sign-in words.
    const sign = { sign_in: { title: "Welcome back to the workspace", subtitle: "Use your work address.", button: "Send my code" }, legal: { text: "By continuing you agree to the {terms} and the {privacy}.", terms_url: "https://example.com/terms" }, hidden_methods: ["google"] };
    assert.equal((await put(operator, { version: 0, config: { ...sign, legal: { text: "x {terms}", privacy_url: "ftp://x" } } }, "sign_in")).status, 400, "a bad address refused");
    assert.equal((await put(await tok("support"), { version: 0, config: sign }, "sign_in")).status, 403, "support may not");
    const ss = await put(operator, { version: 0, config: { ...sign, sign_up: { title: "  " } } }, "sign_in");
    assert.equal(ss.status, 400, "an empty word is not plain text: refused");
    const ss2 = await put(operator, { version: 0, config: sign }, "sign_in");
    assert.equal(ss2.body.page.version, 1);
    assert.deepEqual((await call("GET", "/api/access-pages")).body.sign_in, sign);
    const admin = await call("GET", "/api/admin/onboarding/access-pages", await tok("viewer"));
    assert.deepEqual(admin.body.methods.methods.map((m: any) => [m.id, m.hideable]), [["email_code", false], ["google", true]], "the built-in sign-in's methods (the emailed code always shown)");
    assert.deepEqual(admin.body.changes.map((c: any) => `${c.page_id}:${c.version}`), ["sign_in:1", "request_form:3", "request_form:2", "request_form:1"]);
    assert.equal((await put(operator, { version: 0, config: sign }, "nothing")).status, 404, "no such page");
    ok("the sign-in words: saved (Operator), a bad address and an empty word refused, read back by the public pages; the methods there are (the emailed code never hidden); every change in the staff list");

    if (BROWSER) await browserChecks({ http, db, staffEmail, STAMP, TMP, teardown, operator, call });
    console.log(`access-pages: ${n} checks passed on the API${BROWSER ? " and the console" : ""}`);
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

async function browserChecks(w: { http: any; db: any; staffEmail: string; STAMP: string; TMP: string; teardown: (() => unknown)[]; operator: Record<string, string>; call: (m: string, p: string, h?: Record<string, string>, b?: unknown) => Promise<{ status: number; body: any }> }) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const R = await import("../src/access-request.js");
  const A = await import("../src/access-pages.js");
  // Back to nothing saved for the console's own checks (the API checks above saved and reset).
  await w.db.query("DELETE FROM access_page_changes"); await w.db.query("DELETE FROM access_pages"); A.forgetAccessPages();
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

  // Staff sign in with an emailed code (the built-in sign-in).
  const kindOf = (e: any) => e.tags?.find((t: any) => t.name === "kind")?.value;
  const h = { "x-forwarded-for": "198.51.100.250" };
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

  const browser = await pw.chromium.launch();
  w.teardown.push(() => browser.close());
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const ctx = async (signedIn: boolean, width = 1440, mode: "light" | "dark" = "dark") => {
    const c = await browser.newContext({ baseURL: origin, serviceWorkers: "block", reducedMotion: "reduce", colorScheme: mode, viewport: { width, height: width < 1024 ? 844 : 1000 }, ...(width < 1024 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await c.addInitScript((m: string) => { try { localStorage.setItem('console-color-mode', m); } catch { /* */ } }, mode);
    await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    if (signedIn) await c.addCookies([{ name: cookie.split("=")[0]!, value: cookie.slice(cookie.indexOf("=") + 1), url: origin }]);
    return c;
  };
  const COMBOS = [["light", 1440], ["light", 390], ["dark", 1440], ["dark", 390]] as const;
  /** Light and dark at 1440 and 390: `prep` gets the page ready (and may name the element to shoot). */
  const shots = async (name: string, url: string, signedIn: boolean, prep: (p: any) => Promise<any | void>) => {
    for (const [mode, width] of COMBOS) {
      const c = await ctx(signedIn, width, mode);
      const p = await c.newPage();
      const errors: string[] = [];
      p.on("pageerror", (e: Error) => errors.push(String(e)));
      await p.goto(url, { waitUntil: "networkidle" });
      const el = await prep(p);
      const wide = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(wide[0] <= wide[1] + 1, `${name} ${mode} ${width}: scrolls sideways (${wide[0]} > ${wide[1]})`);
      assert.deepEqual(errors, [], `${name} ${mode} ${width}: page errors`);
      if (SHOTS) { await wait(300); await (el ?? p).screenshot({ path: path.join(SHOTS, `${name}-${mode}-${width}.png`), ...(el ? {} : { fullPage: true }) }); }
      await c.close();
    }
  };

  /** What a form draws: every label, control (name, kind, required, length, placeholder), button and text, in order. */
  const formShape = async (url: string, sel: string) => {
    const c = await ctx(false);
    const p = await c.newPage();
    await p.goto(url, { waitUntil: "networkidle" });
    await p.locator(sel).first().waitFor({ timeout: 20000 });
    const shape = await p.locator(sel).first().evaluate((form: Element) => ({
      text: (form as HTMLElement).innerText,
      controls: [...form.querySelectorAll("input, textarea, select, button")].map((e) => [e.tagName, e.getAttribute("name"), e.getAttribute("type"), e.hasAttribute("required"), e.getAttribute("maxlength"), e.getAttribute("placeholder"), e.getAttribute("autocomplete"), (e as HTMLElement).innerText ?? ""]),
      labels: [...form.querySelectorAll("label, legend")].map((e) => (e as HTMLElement).innerText)
    }));
    await c.close();
    return shape;
  };
  const save = async (id: "request_form" | "sign_in", config: unknown) => {
    const cur = (await w.call("GET", "/api/admin/onboarding/access-pages", w.operator)).body.pages[id].version;
    const r = await w.call("PUT", `/api/admin/onboarding/access-pages/${id}`, w.operator, { version: cur, config });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const resetPage = async (id: "request_form" | "sign_in") => {
    const cur = (await w.call("GET", "/api/admin/onboarding/access-pages", w.operator)).body.pages[id].version;
    assert.equal((await w.call("POST", `/api/admin/onboarding/access-pages/${id}/reset`, w.operator, { version: cur })).status, 200);
  };
  const PAGE_FORM = 'main form[novalidate]';
  const fields = FIELDS as import("../src/access-request.js").AccessField[];
  const words = { message: "What would you like to use Workspace for?", thanks: "Thank you. The Workspace team will look at it", first_step: "The Workspace team looks at your request." };

  // The defaults draw today's forms: with nothing saved and with the defaults saved explicitly, the same.
  {
    const ownPage = await formShape(REQUEST_PAGE.path, PAGE_FORM);
    const ownShell = await formShape("/request-access", '[data-testid="request-access-form"]');
    assert.ok(ownPage.text.includes("Company website") && ownPage.text.includes("Add details") && !ownPage.text.includes("What should it do first?"), "the page as declared");
    await save("request_form", R.defaultRequestForm(fields, words, REQUEST_PAGE.form));
    assert.deepEqual(await formShape(REQUEST_PAGE.path, PAGE_FORM), ownPage, "the request page: its defaults saved draw exactly what it drew with nothing saved");
    await save("request_form", R.defaultRequestForm(fields, words, null));
    assert.deepEqual(await formShape("/request-access", '[data-testid="request-access-form"]'), ownShell, "/request-access: its defaults saved draw exactly what it drew with nothing saved");
    await resetPage("request_form");
    ok("the defaults reproduce today's forms in the browser: the request page and /request-access draw the same labels, controls, buttons and text with their defaults saved as with nothing saved");
  }

  // Before an edit: the public request page.
  await shots("request-page-before", REQUEST_PAGE.path, false, async (p) => { await p.locator(PAGE_FORM).waitFor({ timeout: 20000 }); });

  // Staff edit the form in the console: the side panel, a new field, the preview, Save.
  {
    const c = await ctx(true, 1440, "dark");
    const p = await c.newPage();
    await p.goto("/admin/requests?section=form", { waitUntil: "networkidle" });
    await p.locator('[data-testid="form-fields"]').waitFor({ timeout: 20000 });
    assert.match(await p.locator('[data-testid="access-page-version"]').innerText(), /the defaults/);
    const keys = await p.locator("[data-form-field]").evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-form-field")));
    assert.deepEqual(keys, ["email", "company", "website", "name", "team_size", "tools", "goal", "message"], "the editor starts from the page's own form");
    await p.locator('[data-form-field="company"]').getByRole("button", { name: "Edit" }).click();
    const panel = p.locator('[data-testid="field-panel"]');
    await panel.waitFor();
    assert.equal(await panel.getByLabel("Kind").locator("option").count(), 6, "the shell's company: every kind but several choices");
    await panel.getByLabel("Label").fill("Organisation");
    await panel.getByLabel("Help text").fill("The team or company you work for.");
    await panel.getByRole("button", { name: "Apply" }).click();
    await p.getByRole("button", { name: "Add field" }).click();
    await panel.waitFor();
    await panel.getByLabel("Label").fill("Seats");
    await panel.getByLabel("Kind").selectOption("number");
    await panel.getByRole("checkbox", { name: "Required" }).click();
    await panel.getByLabel("Help text").fill("Roughly is fine.");
    await panel.getByRole("button", { name: "Add to the form" }).click();
    await p.getByLabel("Submit button").fill("Join the early list");
    const preview = p.locator('[data-testid="form-preview"]');
    await preview.getByText("Organisation").first().waitFor();
    assert.ok(await preview.getByLabel("Seats").count() === 1, "the preview follows the draft");
    assert.match(await preview.innerText(), /Join the early list/);
    assert.equal(await p.locator('[data-form-field="seats"]').count(), 1);
    await p.getByRole("button", { name: "Save changes" }).click();
    await p.getByText(/Version 4, saved by/).waitFor({ timeout: 15000 }); // after the two saves and the reset above
    await c.close();
    const saved = (await w.call("GET", "/api/access-pages")).body.request_form;
    assert.deepEqual(saved.fields.find((f: any) => f.key === "company"), { key: "company", label: "Organisation", type: "text", required: true, placeholder: "Acme", max_length: 200, help: "The team or company you work for." });
    assert.deepEqual(saved.fields.find((f: any) => f.key === "seats"), { key: "seats", label: "Seats", type: "number", required: true, help: "Roughly is fine." });
    assert.equal(saved.submit, "Join the early list");
    const [ch] = await w.db.query("SELECT version, action, changed_by FROM access_page_changes WHERE page_id = 'request_form' ORDER BY id DESC LIMIT 1");
    assert.deepEqual([ch.version, ch.action, ch.changed_by], [4, "edited", w.staffEmail], "audited under the signed-in person");
    ok("the editor: it starts from the page's own form; the side panel relabels the company (every kind but several choices offered) and adds a required number; the preview follows the draft; Save makes the next version (4) under the person's address");
  }
  // The editor and its preview, in both modes and widths (the panel open on the company at the shot).
  await shots("editor", "/admin/requests?section=form", true, async (p) => {
    await p.locator('[data-form-field="company"]').waitFor({ timeout: 20000 });
    await p.locator('[data-form-field="company"]').getByRole("button", { name: "Edit" }).click();
    await p.locator('[data-testid="field-panel"]').waitFor();
  });
  await shots("editor-preview", "/admin/requests?section=form", true, async (p) => {
    const el = p.locator('[data-testid="form-preview"]');
    await el.getByLabel("Seats").waitFor({ timeout: 20000 });
    return el;
  });
  await shots("editor-page", "/admin/requests?section=form", true, async (p) => { await p.locator('[data-testid="form-fields"]').waitFor({ timeout: 20000 }); });

  // After the edit: the public request page asks the new form, live; its answers land in the request.
  {
    const c = await ctx(false);
    const p = await c.newPage();
    await p.goto(REQUEST_PAGE.path, { waitUntil: "networkidle" });
    const form = p.locator(PAGE_FORM);
    await form.waitFor({ timeout: 20000 });
    assert.match(await form.innerText(), /Organisation[\s\S]*Seats[\s\S]*Join the early list/);
    await form.locator('input[name="email"]').fill(`page-${w.STAMP}@browser.example`);
    await form.locator('input[name="company"]').fill("Browser Co");
    await form.getByLabel("Company website").fill("browser.example");
    await form.getByRole("button", { name: /Join the early list/ }).click();
    await p.getByText("Seats is required.").waitFor({ timeout: 5000 });
    await form.getByLabel("Seats").fill("12");
    await p.getByText("Add details").click();
    await form.getByLabel("Team size").selectOption("11-50");
    await form.getByRole("button", { name: "Spreadsheets" }).click();
    await form.getByRole("button", { name: /Join the early list/ }).click();
    await p.getByText("You are on the list").waitFor({ timeout: 15000 });
    const [row] = await w.db.query("SELECT company, answers FROM access_requests WHERE email = $1", [`page-${w.STAMP}@browser.example`]);
    assert.deepEqual(row, { company: "Browser Co", answers: { website: "https://browser.example", seats: "12", team_size: "11-50", tools: ["sheets"] } });
    await c.close();
    ok("the public page after the edit: the new label and field, its own check (Seats is required.), the answers stored with the request");
  }
  await shots("request-page-after", REQUEST_PAGE.path, false, async (p) => { await p.locator(PAGE_FORM).getByLabel("Seats").waitFor({ timeout: 20000 }); });

  // Access requests shows every answer under the form's labels.
  await shots("access-requests", "/admin/requests", true, async (p) => {
    const row = p.locator("tr", { hasText: "Browser Co" });
    await row.waitFor({ timeout: 20000 });
    await row.click();
    const peek = p.locator('[data-slot="detail-panel"]');
    await peek.waitFor({ timeout: 10000 });
    const text = await peek.innerText();
    for (const re of [/Company website\s*browser\.example/, /Seats\s*12/, /Team size\s*11 to 50/, /Tools you use\s*Spreadsheets/]) assert.match(text, re, `the open request: ${re}`);
  });
  ok("Access requests: the open request shows every answer under the form's labels (the new Seats among the pack's)");

  // The sign-in page with staff's words.
  await save("sign_in", { sign_in: { title: "Welcome back to the workspace", subtitle: "Use the address your invitation went to.", button: "Send my sign-in code" },
    legal: { text: "By continuing you agree to the {terms} and the {privacy}.", terms_url: "https://example.com/terms", privacy_url: "https://example.com/privacy" } });
  await shots("sign-in", "/auth/sign-in", false, async (p) => {
    await p.getByText("Welcome back to the workspace").waitFor({ timeout: 20000 });
    const t = await p.locator("main").innerText();
    assert.match(t, /Use the address your invitation went to\.[\s\S]*Send my sign-in code/);
    assert.match(t, /By continuing you agree to the Terms and the Privacy\./);
    assert.equal(await p.locator('[data-testid="auth-legal-line"] a[href="https://example.com/terms"]').count(), 1);
  });
  await shots("sign-in-editor", "/admin/requests?section=sign-in", true, async (p) => { await p.locator('[data-testid="sign-in-preview"]').getByText("Welcome back to the workspace").waitFor({ timeout: 20000 }); });
  ok("the sign-in page shows staff's title, subtitle, button and legal line (links to the addresses given); its editor and preview show them");
}
