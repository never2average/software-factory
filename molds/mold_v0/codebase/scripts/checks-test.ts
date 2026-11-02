// Declarative yes/no checks (mold_v0-196; src/check-spec.ts, src/check-eval.ts, src/checks.ts), offline: an embedded
// database, the HTTP server behind a fake Clerk, and the fixture pack scripts/fixtures/packs/fixture_consent (a
// pack.json alone, compiled as gen-packs compiles it).
//   npm run test:checks
//
// 1. Zero packs: no check, no tool, nothing mounted at /api/checks.
// 2. The condition evaluator, at random (property tests): all/any/not against their definitions, De Morgan, eq/ne and
//    the orders as complements, in as a disjunction of eq, within as a pair of bounds, the latest record whatever the
//    order of the rows, an absent input failing closed.
// 3. Declarations refused at build: unknown fields and inputs, type mismatches, an enum value not an option, an
//    operator a type does not take, empty or optional matches (unbounded scans), latest_by not a date or number, a lookup
//    of an unknown area, an any-record rule the database cannot find, a name twice, a tool name taken.
// 4. The fixture's checks: granted, withdrawn, expired (and not yet, at an earlier time), latest-wins both ways, the
//    lookup's purpose inactive, no record; an any-record rule; the explanation names what decided.
// 5. Workspaces: another workspace's records never answer, the workspace is never an input; every door (session, MCP
//    key, MCP tool) answers for the caller's own.
// 6. Scopes, on the developer surface (mold_v0-193): keys and client sessions with checks, checks:<name>, or neither.
// 7. Audit: each answer one platform-trail entry (name and outcome, never an input) when audit.platform is on; none off.
// 8. Speed: answers over 3,000 records of one workspace, with the declaration's index hint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import type * as SpecT from "../src/check-spec.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_consent");
const json = JSON.parse(readFileSync(path.join(FIX, "pack.json"), "utf8"));
const [MAIN, SHARED] = [json.checks[0].rule.area as string, json.checks[0].rule.lookup.area as string];
const DAY = 86_400_000;

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const spec = await import("../src/check-spec.js");
  const ev = await import("../src/check-eval.js");
  const ck = await import("../src/checks.js");
  const { createOrg, createApiKey } = await import("../src/auth.js");
  const rec = await import("../src/record-areas.js");
  const audit = await import("../src/audit-trail.js");

  // ---------- 1. zero packs ----------
  {
    assert.deepEqual(ck.declaredChecks(), []);
    assert.deepEqual(ck.checkTools(), []);
    const { getRouter } = { getRouter: () => ck.checkAppRouter((_q, _s, n) => n()) };
    assert.equal((getRouter() as unknown as { stack: unknown[] }).stack.length, 0, "nothing mounted");
    console.log("✓ zero packs: no check, no tool, nothing mounted at /api/checks");
  }

  // ---------- 2. the evaluator, at random ----------
  {
    let seed = 196;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const NOW = Date.parse("2030-06-15T12:00:00Z");
    const kinds: Record<string, "number" | "string" | "date" | "boolean" | "list"> = { n: "number", s: "string", d: "date", b: "boolean", l: "list" };
    const val = (f: string): unknown => {
      if (rnd() < 0.12) return pick([null, undefined, ""]);
      switch (kinds[f]) {
        case "number": return Math.floor(rnd() * 7) - 3;
        case "string": return pick(["a", "b", "c"]);
        case "date": return new Date(NOW + Math.floor(rnd() * 9 - 4) * DAY).toISOString().slice(0, rnd() < 0.5 ? 10 : 24);
        case "boolean": return rnd() < 0.5;
        default: return ["a", "b", "c"].filter(() => rnd() < 0.5);
      }
    };
    const record = (key = `r${Math.floor(rnd() * 1000)}`) => ({ key, data: Object.fromEntries(Object.keys(kinds).map((f) => [f, val(f)])) });
    const kindOf = (p: string) => kinds[p] ?? "string";
    const ctx = (r: { key: string; data: Record<string, unknown> }, inputs: Record<string, unknown> = {}) => ({ record: r, lookup: null, lookupAs: null, inputs, now: NOW, kindOf });
    const operand = (f: string) => (kinds[f] === "date" ? pick(["now", "now-2d", "now+1d", "$tt|now", new Date(NOW + Math.floor(rnd() * 7 - 3) * DAY).toISOString()]) : f === "n" ? Math.floor(rnd() * 7) - 3 : f === "b" ? rnd() < 0.5 : pick(["a", "b", "c"]));
    const leaf = (): SpecT.FieldCondition => {
      const f = pick(["n", "s", "d", "b", "l"]);
      if (f === "l") return rnd() < 0.5 ? { field: f, has: pick(["a", "b", "c"]) } : { field: f, exists: rnd() < 0.5 };
      const ops = f === "n" || f === "d" ? ["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "exists", ...(f === "d" ? ["within"] : [])] : ["eq", "ne", "in", "not_in", "exists"];
      const op = pick(ops);
      if (op === "exists") return { field: f, exists: rnd() < 0.5 };
      if (op === "within") return { field: f, within: rnd() < 0.5 ? { last: pick(["1d", "3d", "36h"]) } : { next: pick(["1d", "2d"]) } };
      if (op === "in" || op === "not_in") return { field: f, [op]: [operand(f), operand(f)].filter((x) => typeof x !== "string" || !x.startsWith("$")) } as never;
      return { field: f, [op]: operand(f) } as never;
    };
    const cond = (depth = 0): SpecT.CheckCondition => {
      const r = rnd();
      if (depth >= 3 || r < 0.5) return leaf();
      if (r < 0.7) return { all: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => cond(depth + 1)) };
      if (r < 0.9) return { any: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => cond(depth + 1)) };
      return { not: cond(depth + 1) };
    };
    const holds = (c: SpecT.CheckCondition, r: ReturnType<typeof record>, inputs: Record<string, unknown> = {}) => ev.evaluate(c, ctx(r, inputs)).passed;
    let n = 0;
    for (let i = 0; i < 1500; i++) {
      const r = record();
      const inputs = rnd() < 0.5 ? { tt: new Date(NOW + Math.floor(rnd() * 5 - 2) * DAY).toISOString() } : {};
      const a = cond(), b = cond();
      const o = ev.evaluate({ all: [a, b] }, ctx(r, inputs));
      assert.equal(o.passed, holds(a, r, inputs) && holds(b, r, inputs), "all = every");
      assert.equal(holds({ any: [a, b] }, r, inputs), holds(a, r, inputs) || holds(b, r, inputs), "any = some");
      assert.equal(holds({ not: { all: [a, b] } }, r, inputs), holds({ any: [{ not: a }, { not: b }] }, r, inputs), "De Morgan");
      assert.equal(holds({ not: { not: a } }, r, inputs), holds(a, r, inputs), "not not");
      assert.equal(holds({ all: [a] }, r, inputs), holds(a, r, inputs), "all of one");
      // What decided it: a failed all is decided by a leaf that failed; a passed any by one that passed.
      const dec = ev.evaluate({ all: [a, b] }, ctx(r, inputs));
      if (!dec.passed) assert.ok(dec.decided_by.length >= 1 && dec.evaluated.length >= dec.decided_by.length);
      const l = leaf();
      const op = spec.opOf(l)[0]!;
      const present = !(r.data[l.field] === null || r.data[l.field] === undefined || r.data[l.field] === "" || (Array.isArray(r.data[l.field]) && (r.data[l.field] as unknown[]).length === 0));
      if (op === "eq" && present) assert.equal(holds(l, r, inputs), !holds({ field: l.field, ne: l.eq }, r, inputs), "eq and ne complement on a value");
      if ((op === "gt" || op === "lte") && present) {
        const v = (l as Record<string, unknown>)[op];
        const gt = holds({ field: l.field, gt: v } as never, r, inputs), lte = holds({ field: l.field, lte: v } as never, r, inputs);
        if (kinds[l.field] === "number" || (kinds[l.field] === "date" && (typeof v !== "string" || !v.startsWith("$")))) { assert.equal(gt, !lte, "gt and lte complement on comparable values"); n++; }
      }
      if (op === "in") assert.equal(holds(l, r, inputs), (l.in as unknown[]).some((v) => holds({ field: l.field, eq: v } as never, r, inputs)), "in = some eq");
      if (op === "not_in") assert.equal(holds(l, r, inputs), !(l.not_in as unknown[]).some((v) => holds({ field: l.field, eq: v } as never, r, inputs)), "not_in = no eq");
      if (op === "within" && l.within!.last) {
        const span = spec.durationMs(l.within!.last);
        assert.equal(holds(l, r, inputs), holds({ all: [{ field: l.field, gte: new Date(NOW - span).toISOString() }, { field: l.field, lte: new Date(NOW).toISOString() }] }, r, inputs), "within last = a pair of bounds");
      }
    }
    assert.ok(n > 50, `the order complements were exercised (${n})`);
    // An absent input fails closed (eq, ne, gt alike); $x|now falls back to now.
    const r0 = { key: "k", data: { d: new Date(NOW + DAY).toISOString(), s: "a" } };
    for (const c of [{ field: "s", eq: "$xx" }, { field: "s", ne: "$xx" }, { field: "d", gt: "$xx" }, { field: "s", in: ["$xx"] }, { field: "s", not_in: ["$xx"] }] as SpecT.FieldCondition[])
      assert.equal(holds(c, r0 as never), false, `absent input: ${JSON.stringify(c)} fails closed`);
    assert.equal(holds({ field: "d", gt: "$xx|now" }, r0 as never), true, "$xx|now: now");
    // Latest wins, whatever the order the rows came in; ties to the greater key; no value last.
    for (let i = 0; i < 300; i++) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, j) => record(`k${j}`));
      const want = [...rows].sort((x, y) => {
        const a = x.data.d, b = y.data.d;
        const ta = typeof a === "string" && a ? Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a) : null, tb = typeof b === "string" && b ? Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b) : null;
        if (ta === null && tb === null) return x.key < y.key ? 1 : -1;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta || (x.key < y.key ? 1 : -1);
      })[0]!;
      for (let k = 0; k < 3; k++) {
        const shuffled = [...rows].sort(() => rnd() - 0.5);
        assert.equal(ev.pickLatest(shuffled, "d", "date")!.key, want.key, "the latest by date, ties to the greater key, whatever the order");
      }
    }
    console.log("✓ the evaluator, at random: all/any/not by definition, De Morgan, eq/ne and gt/lte complements, in and not_in as eq, within as two bounds, latest-wins under any order, absent inputs fail closed");
  }

  // ---------- 3. declarations refused ----------
  {
    const areas: import("../src/check-spec.js").CheckArea[] = [
      { name: "items", scope: "workspace", fields: [{ name: "who", type: "text" }, { name: "state", type: "enum", options: ["on", "off"] }, { name: "at", type: "date" }, { name: "num", type: "number" }, { name: "tags", type: "enum", multiple: true, options: ["x", "y"] }, { name: "blob", type: "json" }] },
      { name: "shared", scope: "platform", fields: [{ name: "ok", type: "boolean" }] },
      { name: "live_rows", scope: "workspace", live: true, fields: [{ name: "who", type: "text" }] },
    ];
    const base = { name: "ok_check", inputs: { who: "string", tt: "datetime?", kk: "number" }, rule: { area: "items", match: { who: "$who" }, latest_by: "at", require: [{ field: "state", eq: "on" }] } };
    const problems = (patch: (c: any) => void) => { const c = structuredClone(base) as any; patch(c); return spec.checksProblems([{ id: "p", checks: [c] }], areas).join("\n"); };
    assert.equal(problems(() => {}), "", "the base check is fine");
    const refused: [string, (c: any) => void, RegExp][] = [
      ["unknown area", (c) => { c.rule.area = "nope"; }, /not a record area/],
      ["unknown field in match", (c) => { c.rule.match = { nope: "$who" }; }, /nope is not a field of items/],
      ["unknown field in require", (c) => { c.rule.require = [{ field: "nope", eq: 1 }]; }, /nope is not a field/],
      ["unknown input", (c) => { c.rule.match = { who: "$ghost" }; }, /\$ghost is not one of the check's inputs/],
      ["input of the wrong type", (c) => { c.rule.match = { who: "$kk" }; }, /\$kk is a number; the field holds a string/],
      ["literal of the wrong type", (c) => { c.rule.require = [{ field: "num", gt: "many" }]; }, /"many" is not a number/],
      ["enum value not an option", (c) => { c.rule.require = [{ field: "state", eq: "maybe" }]; }, /not one of the field's options/],
      ["order on text", (c) => { c.rule.require = [{ field: "who", gt: "a" }]; }, /gt compares numbers and dates/],
      ["within on a number", (c) => { c.rule.require = [{ field: "num", within: { last: "3d" } }]; }, /within is a time window/],
      ["has on a single value", (c) => { c.rule.require = [{ field: "state", has: "on" }]; }, /has is for list fields/],
      ["eq on a list", (c) => { c.rule.require = [{ field: "tags", eq: "x" }]; }, /a list: use has/],
      ["two operators", (c) => { c.rule.require = [{ field: "num", gt: 1, lt: 3 }]; }, /one operator/],
      ["empty match: an unbounded scan", (c) => { c.rule.match = {}; }, /never scans a whole area/],
      ["a match resting on an optional input", (c) => { c.inputs.opt = "string?"; c.rule.match = { who: "$opt" }; }, /may be left out/],
      ["latest_by not a date or number", (c) => { c.rule.latest_by = "who"; }, /found by a date or number field/],
      ["lookup of an unknown area", (c) => { c.rule.lookup = { area: "nope", as: "xx", key: "$who" }; }, /lookup.area: nope/],
      ["a lookup's field not declared", (c) => { c.rule.lookup = { area: "shared", as: "sh", key: "$who" }; c.rule.require = [{ field: "sh.nope", eq: true }]; }, /nope is not a field of shared/],
      ["a lookup named like a field", (c) => { c.rule.lookup = { area: "shared", as: "who", key: "$who" }; }, /is a field of items/],
      ["an area read live", (c) => { c.rule.area = "live_rows"; }, /read live from an API/],
      ["any-record rule with an any group", (c) => { delete c.rule.latest_by; c.rule.require = [{ any: [{ field: "state", eq: "on" }, { field: "num", gt: 1 }] }]; }, /without latest_by, require is all-of/],
      ["any-record rule with a lookup", (c) => { delete c.rule.latest_by; c.rule.lookup = { area: "shared", as: "sh", key: "$who" }; }, /without latest_by, a rule has no lookup/],
      ["now against text", (c) => { c.rule.require = [{ field: "num", eq: "now" }]; }, /not a number/],
      ["$x|now on a string input", (c) => { c.rule.require = [{ field: "who", eq: "$who|now" }]; }, /only a date or datetime input falls back to now/],
      ["JSON in a match", (c) => { c.rule.match = { who: "$who", blob: "x" }; }, /match on single values/],
      ["a bad shape", (c) => { c.rule.require = [{ field: "num", between: [1, 2] }]; }, /checks\[0\]/],
    ];
    for (const [what, patch, re] of refused) assert.match(problems(patch), re, what);
    const twice = spec.checksProblems([{ id: "p", checks: [base] }, { id: "q", checks: [base] }], areas).join("\n");
    assert.match(twice, /check ok_check is already pack p's/);
    // A pack that declares a check whose tool a pack tool already has is refused when the packs are installed.
    const { definePack } = await import("../src/pack-api.js");
    assert.throws(() => setPacksForTest([{ manifest: { id: "fixture_consent", name: "x", version: "1", entry: null, migrations: null, words: {}, dir: FIX } as never,
      declared: compileDeclarations(json), definition: definePack({ id: "fixture_consent", tools: [{ name: "check_may_process", description: "x", handler: () => null }] }) }]), /check_may_process is already/);
    console.log(`✓ declarations refused at build: ${refused.length} kinds (unknown fields and inputs, type mismatches, unbounded scans, any-record rules the database cannot find, lookups), a name twice, a tool name taken`);
  }

  // ---------- the fixture ----------
  setPacksForTest([{ manifest: { id: "fixture_consent", name: "Fixture consent", version: "1", entry: null, migrations: null, words: {}, dir: FIX }, declared: compileDeclarations(json), definition: null }]);
  assert.deepEqual(ck.declaredChecks().map((c) => c.name), ["may_process", "may_email"]);
  assert.deepEqual(ck.checkTools().map((t) => t.name), ["check_may_process", "check_may_email"]);
  const A = await createOrg(`Checks A ${STAMP}`), B = await createOrg(`Checks B ${STAMP}`);
  const recs = (o: { orgId: number }) => rec.workspaceRecords("fixture_consent", o.orgId);
  await rec.adminRecords.put(SHARED, "marketing", { data: { lawful_basis: "consent", active: true } });
  await rec.adminRecords.put(SHARED, "analytics", { data: { lawful_basis: "consent", active: false } });
  const NOW = Date.now();
  const day = (d: number) => new Date(NOW + d * DAY).toISOString().slice(0, 10);
  const put = (o: { orgId: number }, key: string, data: Record<string, unknown>) => recs(o).create(MAIN, key, { data });
  await put(A.org, "s1-1", { subject: "s1", purpose: "marketing", status: "granted", recorded_at: day(-10) });
  await put(A.org, "s2-1", { subject: "s2", purpose: "marketing", status: "granted", recorded_at: day(-20) });
  await put(A.org, "s2-2", { subject: "s2", purpose: "marketing", status: "withdrawn", recorded_at: day(-5) });
  await put(A.org, "s3-1", { subject: "s3", purpose: "marketing", status: "withdrawn", recorded_at: day(-20) });
  await put(A.org, "s3-2", { subject: "s3", purpose: "marketing", status: "granted", recorded_at: day(-5) });
  await put(A.org, "s4-1", { subject: "s4", purpose: "marketing", status: "granted", recorded_at: day(-100), expires_at: day(-30) });
  await put(A.org, "s5-1", { subject: "s5", purpose: "analytics", status: "granted", recorded_at: day(-3) });
  await put(B.org, "s9-1", { subject: "s9", purpose: "marketing", status: "granted", recorded_at: day(-1) });
  // The any-record rule's rows: s6 has an old grant with email, a recent one without, and a recent adult one with email.
  await put(A.org, "s6-1", { subject: "s6", purpose: "marketing", status: "granted", recorded_at: day(-400), channels: ["email"], age: 30 });
  await put(A.org, "s6-2", { subject: "s6", purpose: "marketing", status: "granted", recorded_at: day(-2), channels: ["sms"], age: 30 });
  await put(A.org, "s7-1", { subject: "s7", purpose: "marketing", status: "granted", recorded_at: day(-2), channels: ["email"], age: 16 });
  const caller = (o: { orgId: number }) => ({ orgId: o.orgId, role: "member" as const, userId: "user_test", scopes: null });
  const ask = (o: { orgId: number }, name: string, inputs: unknown) => ck.answerCheck(caller(o), name, inputs);

  // ---------- 4. the fixture's checks ----------
  {
    const granted = await ask(A.org, "may_process", { subject: "s1", purpose: "marketing" });
    assert.equal(granted.allowed, true, granted.reason);
    assert.deepEqual(granted.record_refs, [{ area: MAIN, key: "s1-1" }, { area: SHARED, key: "marketing" }]);
    assert.match(granted.reason, /meets every condition/);
    assert.equal(granted.explanation!.mode, "latest");
    assert.equal(granted.explanation!.conditions.length, 4, "every condition evaluated (status, the expiry's two, the purpose)");
    const withdrawn = await ask(A.org, "may_process", { subject: "s2", purpose: "marketing" });
    assert.equal(withdrawn.allowed, false);
    assert.deepEqual(withdrawn.record_refs[0], { area: MAIN, key: "s2-2" }, "latest wins: the withdrawal");
    assert.deepEqual(withdrawn.explanation!.decided_by.map((l) => [l.field, l.op, l.expected, l.actual]), [["status", "eq", "granted", "withdrawn"]]);
    assert.match(withdrawn.reason, /Consent is granted is "withdrawn", not "granted"/);
    const regranted = await ask(A.org, "may_process", { subject: "s3", purpose: "marketing" });
    assert.equal(regranted.allowed, true, "latest wins: the grant after a withdrawal");
    assert.equal(regranted.record_refs[0]!.key, "s3-2");
    const expired = await ask(A.org, "may_process", { subject: "s4", purpose: "marketing" });
    assert.equal(expired.allowed, false, "expired");
    assert.deepEqual(expired.explanation!.decided_by.map((l) => [l.field, l.op]), [["expires_at", "exists"], ["expires_at", "gt"]], "decided by the expiry (neither branch of not-expired held)");
    const before = await ask(A.org, "may_process", { subject: "s4", purpose: "marketing", at: new Date(NOW - 60 * DAY).toISOString() });
    assert.equal(before.allowed, true, "asked at a time before it expired");
    const inactive = await ask(A.org, "may_process", { subject: "s5", purpose: "analytics" });
    assert.equal(inactive.allowed, false);
    assert.deepEqual(inactive.explanation!.decided_by.map((l) => l.field), ["purpose_rec.active"], "the lookup's purpose decided it");
    assert.deepEqual(inactive.record_refs.map((r) => r.area), [MAIN, SHARED]);
    const none = await ask(A.org, "may_process", { subject: "nobody", purpose: "marketing" });
    assert.deepEqual([none.allowed, none.record_refs], [false, []]);
    assert.match(none.reason, /no Consents record matches \(subject, purpose\)/);
    // The any-record rule: a recent grant with email by an adult; no explanation (explain: false).
    const email6 = await ask(A.org, "may_email", { subject: "s6" });
    assert.equal(email6.allowed, false, "the email grant is older than a year; the recent one has no email");
    assert.equal(email6.explanation, undefined, "explain: false");
    const email7 = await ask(A.org, "may_email", { subject: "s7" });
    assert.equal(email7.allowed, false, "under age");
    await put(A.org, "s6-3", { subject: "s6", purpose: "marketing", status: "granted", recorded_at: day(-1), channels: ["sms", "email"], age: 30 });
    const email6b = await ask(A.org, "may_email", { subject: "s6" });
    assert.deepEqual([email6b.allowed, email6b.record_refs], [true, [{ area: MAIN, key: "s6-3" }]]);
    // Inputs exactly as declared.
    await assert.rejects(ask(A.org, "may_process", { subject: "s1" }), /purpose is required/);
    await assert.rejects(ask(A.org, "may_process", { subject: "s1", purpose: "marketing", at: "yesterday" }), /at: a datetime/);
    await assert.rejects(ask(A.org, "may_process", { subject: 7, purpose: "marketing" }), /subject: a string/);
    await assert.rejects(ask(A.org, "nope", {}), /no check nope/);
    console.log("✓ the fixture's checks: granted, withdrawn and granted again (latest wins both ways), expired and not yet at an earlier time, the lookup's purpose inactive, no record; an any-record rule; each with the condition that decided it");
  }

  // ---------- 5. workspaces ----------
  // The developer surface on (mold_v0-193), as gen-packs would carry a pack's developer_surface: its /v1/checks door.
  await import("../src/hosts.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  setPackConfigsForTest([{ pack: "fixture_consent", developer_surface: { events: [], sdk_languages: ["typescript"], client_sessions: { ttl_seconds: 900, allowed_origins: [], scopes: ["read", "checks"] } } } as never]);
  const http = await startHttp();
  try {
    {
      const theirs = await ask(A.org, "may_process", { subject: "s9", purpose: "marketing" });
      assert.deepEqual([theirs.allowed, theirs.record_refs], [false, []], "B's grant never answers for A");
      assert.equal((await ask(B.org, "may_process", { subject: "s9", purpose: "marketing" })).allowed, true, "B's own");
      assert.equal((await ask(B.org, "may_process", { subject: "s1", purpose: "marketing" })).allowed, false, "A's never answers for B");
      for (const sneak of [{ org_id: A.org.orgId }, { workspace: A.org.slug }, { org: A.org.orgId }])
        await assert.rejects(ask(B.org, "may_process", { subject: "s1", purpose: "marketing", ...sneak }), /is not an input/, `the workspace is never an input (${Object.keys(sneak)[0]})`);
      // The doors: a signed-in member (session token), a member of B, an MCP key, the MCP tool.
      const memberA = await http.signIn(A.org, "member"), memberB = await http.signIn(B.org, "member");
      const post = (tok: string, name: string, body: unknown, extra: Record<string, string> = {}) => http.req("POST", `/api/checks/${name}`, { authorization: `Bearer ${tok}`, ...extra }, body);
      let r = await post(memberA, "may_process", { subject: "s1", purpose: "marketing" });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).allowed, true);
      r = await post(memberB, "may_process", { subject: "s1", purpose: "marketing" });
      assert.deepEqual([(await r.json()).allowed], [false], "B's member asking about A's subject: denied");
      r = await post(memberB, "may_process", { subject: "s1", purpose: "marketing", org_id: A.org.orgId });
      assert.equal(r.status, 400, "an org in the body is refused");
      r = await post(A.key, "may_process", { subject: "s2", purpose: "marketing" });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).allowed, false, "an MCP key of A");
      r = await post(B.key, "may_process", { subject: "s9", purpose: "marketing" });
      assert.equal((await r.json()).allowed, true, "an MCP key of B");
      r = await post("oct_not_a_key", "may_process", { subject: "s9", purpose: "marketing" });
      assert.equal(r.status, 401);
      r = await http.req("POST", "/api/checks/may_process", {}, { subject: "s9", purpose: "marketing" });
      assert.equal(r.status, 401, "no one: refused");
      r = await http.req("GET", "/api/checks", { authorization: `Bearer ${memberA}` });
      assert.deepEqual((await r.json()).checks.map((c: { name: string }) => c.name), ["may_process", "may_email"]);
      const mcpA = await connect(A.org), mcpB = await connect(B.org);
      const tools = (await mcpA.client.listTools()).tools.map((t) => t.name);
      assert.ok(tools.includes("check_may_process") && tools.includes("check_may_email"));
      const viaTool = await mcpA.call("check_may_process", { subject: "s3", purpose: "marketing" });
      assert.equal(viaTool.structuredContent.allowed, true);
      assert.equal((await mcpB.call("check_may_process", { subject: "s3", purpose: "marketing" })).structuredContent.allowed, false, "the tool reads its own workspace");
      const sneaky = await mcpB.call("check_may_process", { subject: "s3", purpose: "marketing", org_id: A.org.orgId } as never);
      assert.ok(sneaky.isError || sneaky.structuredContent?.allowed === false, "an extra argument never reaches another workspace");
      await mcpA.close(); await mcpB.close();
      console.log("✓ workspaces: another workspace's records never answer (direct, session, MCP key, MCP tool), the workspace is never an input");
    }

    // ---------- 6. scopes (the developer surface, mold_v0-193) ----------
    {
      const { createDeveloperKey, checkScopes } = await import("../src/developer-keys.js");
      const { mintClientSession } = await import("../src/developer-sessions.js");
      const key = async (scopes: string[]) => (await createDeveloperKey(A.org.orgId, { name: `checks ${scopes.join(" ")}`, scopes }, "user_test")).key;
      const [all, one, read] = [await key(["checks"]), await key(["checks:may_email"]), await key(["read"])];
      const post = (tok: string, name: string, body: unknown) => http.req("POST", `/v1/checks/${name}`, { authorization: `Bearer ${tok}` }, body);
      let r = await post(all, "may_process", { subject: "s1", purpose: "marketing" });
      assert.equal(r.status, 200, "checks: every check");
      assert.equal((await r.json()).data.allowed, true);
      assert.equal((await post(one, "may_email", { subject: "s6" })).status, 200, "checks:may_email: that one");
      r = await post(one, "may_process", { subject: "s1", purpose: "marketing" });
      assert.equal(r.status, 403);
      assert.match(JSON.stringify(await r.json()), /checks:may_process/);
      assert.equal((await post(read, "may_email", { subject: "s6" })).status, 403, "a key without a checks scope");
      r = await post(all, "may_process", { subject: "s9", purpose: "marketing" });
      assert.equal((await r.json()).data.allowed, false, "a key of A never reads B's records");
      assert.equal((await post(all, "may_process", { subject: "s1", purpose: "marketing", org_id: B.org.orgId })).status, 400, "nor names a workspace");
      assert.deepEqual((await (await http.req("GET", "/v1/checks", { authorization: `Bearer ${one}` })).json()).data.map((c: { name: string }) => c.name), ["may_email"]);
      // A client session minted by a key that holds checks:may_email, for one of the app's users.
      const minter = (await createDeveloperKey(A.org.orgId, { name: "minter", scopes: ["sessions", "checks:may_email"] }, "user_test")).row;
      const cs = await mintClientSession(A.org.orgId, minter.id, minter.scopes, { subject: "end-user-1", scopes: ["checks:may_email"] });
      assert.equal((await post(cs.token, "may_email", { subject: "s6" })).status, 200, "a client session with checks:may_email");
      assert.equal((await post(cs.token, "may_process", { subject: "s1", purpose: "marketing" })).status, 403, "and no other check");
      await assert.rejects(mintClientSession(A.org.orgId, minter.id, minter.scopes, { subject: "end-user-1", scopes: ["checks:may_process"] }), /does not hold it/, "never a check its key lacks");
      assert.throws(() => checkScopes(["checks:nope"], "secret"), /nope is not one of the checks/);
      assert.deepEqual(checkScopes(["checks", "checks:may_process"], "secret"), ["checks", "checks:may_process"]);
      const doc = JSON.stringify((await (await http.req("GET", "/openapi.json")).json()).paths["/v1/checks/may_process"]);
      assert.match(doc, /"x-scope":"checks:may_process"/);
      assert.equal(ck.scopeAllows(null, "x"), true);
      assert.equal(ck.scopeAllows(["checks:x"], "y"), false);
      assert.equal(ck.scopeAllows(["checks:x2", "checks"], "y"), true);
      console.log("✓ scopes: a developer key with checks asks every check, checks:<name> that one, another scope none; a client session holds at most its key's check scopes; /openapi.json lists each check");
    }

    // ---------- 7. audit ----------
    {
      const entries = async () => db.query<{ path: string; method: string; org_id: number; actor_kind: string }>("SELECT path, method, org_id, actor_kind FROM audit_platform_events WHERE method = 'CHECK' ORDER BY seq");
      await ask(A.org, "may_process", { subject: "s1", purpose: "marketing" });
      await audit.flushAudit();
      assert.equal((await entries()).length, 0, "platform trail off: nothing written");
      audit.setAuditForTest({ platform: true });
      const memberA = await http.signIn(A.org, "member");
      await http.req("POST", "/api/checks/may_process", { authorization: `Bearer ${memberA}` }, { subject: "s1", purpose: "marketing" });
      await http.req("POST", "/api/checks/may_process", { authorization: `Bearer ${A.key}` }, { subject: "s2", purpose: "marketing" });
      const mcp = await connect(A.org);
      await mcp.call("check_may_email", { subject: "s6" });
      await mcp.close();
      await audit.flushAudit();
      const got = await entries();
      assert.deepEqual(got.map((e) => e.path), ["/checks/may_process allowed", "/checks/may_process denied", "/checks/may_email allowed"]);
      assert.ok(got.every((e) => e.org_id === A.org.orgId));
      assert.deepEqual(got.slice(0, 2).map((e) => e.actor_kind), ["user", "key"]);
      const all = JSON.stringify(await db.query("SELECT * FROM audit_platform_events"));
      assert.ok(!all.includes("s1") && !all.includes("marketing"), "no input and no value in the trail");
      audit.setAuditForTest(null);
      console.log("✓ audit: each answer one platform-trail entry (the check and its outcome, by the asker, never an input) with audit.platform on; none off");
    }
  } finally {
    await http.close();
  }

  // ---------- 8. speed ----------
  {
    const C = (await createOrg(`Checks C ${STAMP}`)).org;
    const ops = [];
    for (let i = 0; i < 3000; i++) ops.push({ op: "create", area: MAIN, key: `bulk-${i}`, data: { subject: `b${i % 300}`, purpose: "marketing", status: i % 7 === 0 ? "withdrawn" : "granted", recorded_at: day(-(i % 90)), channels: ["email"], age: 20 + (i % 50) } });
    for (let i = 0; i < ops.length; i += 250) await recs(C).batch(ops.slice(i, i + 250) as never);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const a = await ask(C, i % 2 ? "may_process" : "may_email", i % 2 ? { subject: `b${i * 7 % 300}`, purpose: "marketing" } : { subject: `b${i * 7 % 300}` });
      times.push(performance.now() - t0);
      assert.equal(typeof a.allowed, "boolean");
    }
    times.sort((x, y) => x - y);
    const median = times[15]!;
    assert.ok(median < 250, `median answer ${median.toFixed(1)} ms over 3,000 records (embedded database)`);
    const hints = ck.checkHints();
    assert.deepEqual(hints.map((h) => [h.check, h.by, h.equal, h.order, h.limit]), [["may_process", "fields", ["purpose", "subject"], "recorded_at", 1], ["may_email", "fields", ["status", "subject"], null, 20]]);
    assert.match(hints[0]!.suggest!, /CREATE INDEX ON workspace_records \(org_id, \(COALESCE\(data -> 'purpose'/);
    console.log(`✓ speed: median ${median.toFixed(1)} ms per answer over 3,000 records of one workspace (p90 ${times[27]!.toFixed(1)} ms); each check's index hint (the area's key index, its match fields, the latest by LIMIT 1)`);
  }
  await db.close();
  console.log("CHECKS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
