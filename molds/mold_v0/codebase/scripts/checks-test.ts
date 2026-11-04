// Declarative yes/no checks (mold_v0-196; src/check-spec.ts, src/check-eval.ts, src/checks.ts), offline: an embedded
// database, the HTTP server behind a fake Clerk, and the fixture pack scripts/fixtures/packs/fixture_checks (a
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
// mold_v0-226:
// 2b. Bucketing: the bucket is a pure function of (salt, input), stable run to run and equal to an independent SHA-256
//     (Python's hashlib, the SDKs' copies in JavaScript and Python); over 100,000 ids the buckets are uniform within
//     tolerance and each percent holds its share; 0% holds no one, 100% everyone; a larger percent keeps everyone a
//     smaller one held; two salts bucket independently.
// 4b. A fallback across areas (first_of): an exception decides when one exists and is current (allowing or denying),
//     an expired one or none passes to the consent, nothing at all denies; the explanation lists each step and the
//     area that decided; the share's bucket decides among consents, as bucketOf says.
// 9. Onboarding (mold_v0-225): an answer at /api/checks or /v1/checks is recorded once per workspace and check
//    (check/answer, the tool's name, nothing of the inputs), so a step tool:check_<name> is done.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import type * as SpecT from "../src/check-spec.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_checks");
const json = JSON.parse(readFileSync(path.join(FIX, "pack.json"), "utf8"));
const [MAIN, SHARED] = [json.checks[0].rule.area as string, json.checks[0].rule.lookup.area as string];
const DAY = 86_400_000;
const BASIS = json.record_areas[0].fields[0].options[0] as string;
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABEL = (i: number) => json.checks[0].rule.require[i].label as string;
const MAIN_LABEL = json.record_areas[1].label as string;

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

  // ---------- 2b. bucketing (mold_v0-226) ----------
  {
    const N = 100_000;
    const ids = Array.from({ length: N }, (_, i) => `user-${i}`);
    // Stable: the same (salt, input) gives the same bucket, every time; a known vector (independent of this code).
    const first = ids.slice(0, 2000).map((id) => spec.bucketOf("rollout", id));
    assert.deepEqual(ids.slice(0, 2000).map((id) => spec.bucketOf("rollout", id)), first, "stable run to run");
    const dir = mkdtempSync(path.join(os.tmpdir(), "bucket-"));
    try {
      const sample = [...ids.slice(0, 300), "", "é", "ünïcødé 😀", "x".repeat(200), "a:b", "user-1 "];
      writeFileSync(path.join(dir, "ids.json"), JSON.stringify(sample));
      // Python's hashlib, written from the definition (not the SDK's code): sha256(salt + ":" + input), 4 bytes, mod 10000.
      const py = JSON.parse(execFileSync("python3", ["-I", "-c", "import hashlib,json,sys\nids=json.load(open(sys.argv[1]))\nprint(json.dumps([int.from_bytes(hashlib.sha256(('rollout:'+i).encode('utf-8')).digest()[:4],'big')%10000 for i in ids]))", path.join(dir, "ids.json")], { encoding: "utf8" }));
      assert.deepEqual(sample.map((id) => spec.bucketOf("rollout", id)), py, "the same bucket as an independent SHA-256 (Python)");
      // The SDKs' copies (scripts/lib/sdk-gen.ts): JavaScript (its own SHA-256) and Python agree with the server's.
      const sdk = await import("./lib/sdk-gen.js");
      writeFileSync(path.join(dir, "b.mjs"), sdk.TS_BUCKETING);
      const js = await import(path.join(dir, "b.mjs"));
      assert.deepEqual(sample.map((id) => js.bucket(id, "rollout")), py, "the JavaScript SDK's bucket");
      assert.deepEqual([js.inRollout("user-1", "rollout", 0), js.inRollout("user-1", "rollout", 100), js.inRollout("user-1", "rollout", 101)], [false, true, false]);
      writeFileSync(path.join(dir, "b.py"), `import hashlib\nimport math\n${sdk.PY_BUCKETING}`);
      const pySdk = JSON.parse(execFileSync("python3", ["-I", "-c", "import json,sys,importlib.util as u\ns=u.spec_from_file_location('b',sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m)\nids=json.load(open(sys.argv[2]))\nprint(json.dumps([[m.bucket(i,'rollout') for i in ids],[m.in_rollout(i,'rollout',37.5) for i in ids],[m.in_rollout('u','rollout',p) for p in (0,100,-1,101)]]))", path.join(dir, "b.py"), path.join(dir, "ids.json")], { encoding: "utf8" }));
      assert.deepEqual(pySdk[0], py, "the Python SDK's bucket");
      assert.deepEqual(pySdk[1], sample.map((id) => spec.inBucket("rollout", id, 37.5)), "the Python SDK's in_rollout agrees with the server");
      assert.deepEqual(pySdk[2], [false, true, false, false], "Python: 0 holds no one, 100 everyone, out of range no one");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // Uniform: ten bands of buckets each hold a tenth of 100,000 ids within 3% of it (about six standard deviations).
    const buckets = ids.map((id) => spec.bucketOf("rollout", id));
    assert.ok(buckets.every((b) => Number.isInteger(b) && b >= 0 && b < spec.BUCKETS), "0 to 9999");
    const bands = Array.from({ length: 10 }, () => 0);
    for (const b of buckets) bands[Math.floor(b / 1000)]!++;
    for (const [i, n] of bands.entries()) assert.ok(Math.abs(n - N / 10) < N / 10 * 0.03, `band ${i}: ${n} of ${N} ids (expected ${N / 10})`);
    // Each percent holds its share (within half a point over 100,000 ids); 0% no one; 100% everyone; monotone.
    for (const pct of [0.5, 1, 5, 10, 25, 33.33, 50, 75, 99]) {
      const held = ids.filter((id) => spec.inBucket("rollout", id, pct)).length;
      assert.ok(Math.abs(held / N * 100 - pct) < 0.5, `${pct}%: ${(held / N * 100).toFixed(2)}% of ids`);
    }
    assert.equal(ids.filter((id) => spec.inBucket("rollout", id, 0)).length, 0, "0% holds no one");
    assert.equal(ids.filter((id) => spec.inBucket("rollout", id, 100)).length, N, "100% holds everyone");
    assert.ok(ids.slice(0, 20_000).every((id) => !spec.inBucket("rollout", id, 20) || spec.inBucket("rollout", id, 20.01)), "a larger percent keeps everyone a smaller one held");
    assert.deepEqual([spec.bucketThreshold(-1), spec.bucketThreshold(100.01), spec.bucketThreshold(Number.NaN), spec.bucketThreshold("50"), spec.bucketThreshold(12.345)], [null, null, null, null, 1235]);
    // Two salts bucket independently: about a quarter of ids are in the first half under both.
    const both = ids.filter((id) => spec.inBucket("a", id, 50) && spec.inBucket("b", id, 50)).length / N;
    assert.ok(Math.abs(both - 0.25) < 0.01, `independent salts: ${both.toFixed(4)} in both halves`);
    // As a condition: the evaluator's leaf says the bucket and the threshold, and fails closed with no value or percent.
    const NOW = Date.now();
    const kindOf = (p: string) => (p === "share" ? "number" as const : "string" as const);
    const ctx = (data: Record<string, unknown>, inputs: Record<string, unknown>) => ({ record: { key: "r", data }, lookup: null, lookupAs: null, inputs, now: NOW, kindOf });
    const b = { bucket: { input: "$who", salt: "s1", percent: "@share" } };
    const o = ev.evaluate(b, ctx({ share: 30 }, { who: "user-5" }), "require", "c");
    assert.equal(o.passed, spec.inBucket("s1", "user-5", 30));
    assert.deepEqual([o.evaluated[0]!.actual, (o.evaluated[0]!.expected as { below: number }).below], [spec.bucketOf("s1", "user-5"), 3000]);
    assert.match(ev.leafWords(o.evaluated[0]!), new RegExp(`who is in bucket ${spec.bucketOf("s1", "user-5")} of 10000, (not )?below 3000 \\(30%\\)`));
    assert.equal(ev.evaluate(b, ctx({}, { who: "user-5" })).passed, false, "no percent: fails closed");
    assert.equal(ev.evaluate(b, ctx({ share: 100 }, {})).passed, false, "no input: fails closed");
    assert.equal(ev.evaluate({ bucket: { input: "$who", percent: 100 } }, ctx({}, { who: "x" }), "require", "c").passed, true, "100: everyone");
    assert.equal(ev.evaluate({ bucket: { input: "$who", percent: 50 } }, ctx({}, { who: "user-5" }), "require", "my_check").passed, spec.inBucket("my_check", "user-5", 50), "the salt defaults to the check's name");
    console.log(`✓ bucketing: stable, equal to an independent SHA-256 and to both SDKs' copies; over ${N.toLocaleString("en")} ids each band within 3% and each percent within half a point; 0% no one, 100% everyone; salts independent`);
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
      // mold_v0-226: buckets and fallbacks.
      ["a bucket of a literal", (c) => { c.rule.require = [{ bucket: { input: "everyone", percent: 10 } }]; }, /bucket.input: "everyone": name what is bucketed/],
      ["a bucket of a number input", (c) => { c.rule.require = [{ bucket: { input: "$kk", percent: 10 } }]; }, /bucket.input: \$kk is a number: a bucket hashes text/],
      ["a bucket of an unknown input", (c) => { c.rule.require = [{ bucket: { input: "$ghost", percent: 10 } }]; }, /bucket.input: \$ghost is not one of the check's inputs/],
      ["a bucket salted with a date field", (c) => { c.rule.require = [{ bucket: { input: "$who", salt: "@at", percent: 10 } }]; }, /bucket.salt: @at holds a date: a bucket hashes text/],
      ["a percent over 100", (c) => { c.rule.require = [{ bucket: { input: "$who", percent: 150 } }]; }, /bucket.percent: 150 is not a share from 0 to 100/],
      ["a percent below 0", (c) => { c.rule.require = [{ bucket: { input: "$who", percent: -1 } }]; }, /bucket.percent: -1 is not a share/],
      ["a percent from a text field", (c) => { c.rule.require = [{ bucket: { input: "$who", percent: "@who" } }]; }, /bucket.percent: @who holds a string/],
      ["a percent that is a word", (c) => { c.rule.require = [{ bucket: { input: "$who", percent: "lots" } }]; }, /bucket.percent: "lots" is not a number/],
      ["a percent from an unknown field", (c) => { c.rule.require = [{ bucket: { input: "$who", percent: "@nope" } }]; }, /bucket.percent: @nope: nope is not a field/],
      ["a bucket without latest_by", (c) => { delete c.rule.latest_by; c.rule.require = [{ bucket: { input: "$who", percent: 10 } }]; }, /without latest_by, a rule has no bucket/],
      ["a bucket with an unknown key", (c) => { c.rule.require = [{ bucket: { input: "$who", percent: 10, seed: 1 } }]; }, /checks\[0\]/],
      ["first_of of one step", (c) => { c.rule = { first_of: [c.rule] }; }, /checks\[0\]/],
      ["first_of of five steps", (c) => { c.rule = { first_of: [c.rule, c.rule, c.rule, c.rule, c.rule] }; }, /checks\[0\]/],
      ["a first_of step before the last without latest_by", (c) => { const s = structuredClone(c.rule); delete s.latest_by; c.rule = { first_of: [s, c.rule] }; }, /rule.first_of.0.latest_by: a first_of step before the last decides by its latest record/],
      ["when on a rule of its own", (c) => { c.rule.when = [{ field: "state", eq: "on" }]; }, /rule.when: when: a rule of its own has no when/],
      ["when on the last step", (c) => { const s = { ...structuredClone(c.rule), when: [{ field: "state", eq: "on" }] }; c.rule = { first_of: [c.rule, s] }; }, /rule.first_of.1.when: when: the last step decides/],
      ["a first_of step of an unknown area", (c) => { c.rule = { first_of: [c.rule, { ...structuredClone(c.rule), area: "nope" }] }; }, /rule.first_of\[1\].area: nope is not a record area/],
      ["a when naming an unknown field", (c) => { c.rule = { first_of: [{ ...structuredClone(c.rule), when: [{ field: "nope", exists: true }] }, c.rule] }; }, /rule.first_of.0.when.*nope is not a field/],
      ["a step's unknown input", (c) => { c.rule = { first_of: [c.rule, { ...structuredClone(c.rule), match: { who: "$ghost" } }] }; }, /rule.first_of.1.match.who: \$ghost is not one of the check's inputs/],
    ];
    for (const [what, patch, re] of refused) assert.match(problems(patch), re, what);
    // A sound fallback with a bucket: no problem; the shared areas' fields too.
    assert.equal(problems((c) => { c.rule = { first_of: [{ ...structuredClone(c.rule), when: [{ field: "at", gt: "$tt|now" }] }, { ...structuredClone(c.rule), require: [{ bucket: { input: "$who", salt: "@who", percent: "@num" } }] }] }; }), "", "a fallback with a when and a bucket");
    const twice = spec.checksProblems([{ id: "p", checks: [base] }, { id: "q", checks: [base] }], areas).join("\n");
    assert.match(twice, /check ok_check is already pack p's/);
    // A pack that declares a check whose tool a pack tool already has is refused when the packs are installed.
    const { definePack } = await import("../src/pack-api.js");
    assert.throws(() => setPacksForTest([{ manifest: { id: "fixture_checks", name: "x", version: "1", entry: null, migrations: null, words: {}, dir: FIX } as never,
      declared: compileDeclarations(json), definition: definePack({ id: "fixture_checks", tools: [{ name: "check_may_process", description: "x", handler: () => null }] }) }]), /check_may_process is already/);
    console.log(`✓ declarations refused at build: ${refused.length} kinds (unknown fields and inputs, type mismatches, unbounded scans, any-record rules the database cannot find, lookups), a name twice, a tool name taken`);
  }

  // ---------- the fixture ----------
  setPacksForTest([{ manifest: { id: "fixture_checks", name: "Fixture checks", version: "1", entry: null, migrations: null, words: {}, dir: FIX }, declared: compileDeclarations(json), definition: null }]);
  assert.deepEqual(ck.declaredChecks().map((c) => c.name), ["may_process", "may_email", "may_contact"]);
  assert.deepEqual(ck.checkTools().map((t) => t.name), ["check_may_process", "check_may_email", "check_may_contact"]);
  assert.match(ck.checkTools()[2]!.description, /Reads this workspace's exceptions records \(the latest by recorded_at, when there is one, decides\), else its consents records \(the latest by recorded_at decides\)/);
  const A = await createOrg(`Checks A ${STAMP}`), B = await createOrg(`Checks B ${STAMP}`);
  const recs = (o: { orgId: number }) => rec.workspaceRecords("fixture_checks", o.orgId);
  await rec.adminRecords.put(SHARED, "marketing", { data: { lawful_basis: BASIS, active: true } });
  await rec.adminRecords.put(SHARED, "analytics", { data: { lawful_basis: BASIS, active: false } });
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
    assert.match(withdrawn.reason, new RegExp(`${esc(LABEL(0))} is "withdrawn", not "granted"`));
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
    assert.match(none.reason, new RegExp(`no ${esc(MAIN_LABEL)} record matches \\(subject, purpose\\)`));
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

  // ---------- 4b. a fallback across areas, with a bucket (mold_v0-226) ----------
  {
    const EXC = json.record_areas[2].name as string, EXC_LABEL = json.record_areas[2].label as string;
    const exc = (o: { orgId: number }, key: string, data: Record<string, unknown>) => recs(o).create(EXC, key, { data });
    await exc(A.org, "x1", { subject: "s1", purpose: "marketing", allowed: false, recorded_at: day(-1) });
    await exc(A.org, "x2", { subject: "s2", purpose: "marketing", allowed: true, recorded_at: day(-1), until: day(10) });
    await exc(A.org, "x3", { subject: "s3", purpose: "marketing", allowed: false, recorded_at: day(-9), until: day(-2) });
    const steps = (a: Awaited<ReturnType<typeof ask>>) => a.explanation!.steps!.map((x) => [x.area, x.outcome, x.record?.key ?? null]);
    // An exception that exists decides, denying even a granted consent...
    const denied = await ask(A.org, "may_contact", { subject: "s1", purpose: "marketing" });
    assert.equal(denied.allowed, false, "s1's exception denies, though its consent is granted");
    assert.equal(denied.explanation!.decided_by_area, EXC);
    assert.deepEqual(steps(denied), [[EXC, "decided", "x1"], [MAIN, "not_reached", null]]);
    assert.deepEqual(denied.record_refs, [{ area: EXC, key: "x1" }]);
    assert.match(denied.reason, new RegExp(`the latest ${esc(EXC_LABEL)} record \\(x1\\) does not: The exception allows it is false, not true`));
    // ...or allowing even a withdrawn one.
    const allowed = await ask(A.org, "may_contact", { subject: "s2", purpose: "marketing" });
    assert.deepEqual([allowed.allowed, allowed.explanation!.decided_by_area], [true, EXC], "s2's current exception allows, though its consent is withdrawn");
    // An expired exception does not apply: the consent decides, and the reason says why the first step passed.
    const expired = await ask(A.org, "may_contact", { subject: "s3", purpose: "marketing" });
    assert.deepEqual([expired.allowed, expired.explanation!.decided_by_area], [true, MAIN], "s3's exception expired: its granted consent decides");
    assert.deepEqual(steps(expired), [[EXC, "not_applicable", "x3"], [MAIN, "decided", "s3-2"]]);
    assert.match(expired.reason, new RegExp(`^the latest ${esc(EXC_LABEL)} record \\(x3\\) does not apply: until has a value .*until is "${day(-2)}", not after .*; the latest ${esc(MAIN_LABEL)} record \\(s3-2\\) meets every condition$`));
    assert.deepEqual(expired.record_refs, [{ area: MAIN, key: "s3-2" }, { area: SHARED, key: "marketing" }]);
    assert.ok(expired.explanation!.steps![0]!.conditions!.some((l) => l.field === "until"), "the step that passed lists its when");
    // Asked at a time the exception was current: it decides.
    const then = await ask(A.org, "may_contact", { subject: "s3", purpose: "marketing", at: new Date(NOW - 5 * DAY).toISOString() });
    assert.deepEqual([then.allowed, then.explanation!.decided_by_area], [false, EXC], "at a time the exception was current, it decides");
    // No exception: the consent decides; nothing at all: denied, every step listed.
    const plain = await ask(A.org, "may_contact", { subject: "s4", purpose: "marketing" });
    assert.deepEqual([plain.allowed, steps(plain)], [true, [[EXC, "no_record", null], [MAIN, "decided", "s4-1"]]]);
    assert.match(plain.reason, new RegExp(`^no ${esc(EXC_LABEL)} record matches \\(subject, purpose\\); the latest ${esc(MAIN_LABEL)} record`));
    const nobody = await ask(A.org, "may_contact", { subject: "nobody", purpose: "marketing" });
    assert.deepEqual([nobody.allowed, nobody.record_refs, steps(nobody)], [false, [], [[EXC, "no_record", null], [MAIN, "decided", null]]]);
    assert.match(nobody.reason, new RegExp(`no ${esc(EXC_LABEL)} record matches \\(subject, purpose\\); no ${esc(MAIN_LABEL)} record matches`));
    // Another workspace's exception never decides for A.
    await exc(B.org, "x9", { subject: "s4", purpose: "marketing", allowed: false, recorded_at: day(-1) });
    assert.equal((await ask(A.org, "may_contact", { subject: "s4", purpose: "marketing" })).allowed, true, "B's exception never answers for A");
    // The share's bucket decides among granted consents, exactly as bucketOf says (salted by the purpose).
    const shares: [string, number][] = [...Array.from({ length: 60 }, (_, i) => [`b30-${i}`, 30] as [string, number]), ...Array.from({ length: 6 }, (_, i) => [`b0-${i}`, 0] as [string, number]), ...Array.from({ length: 6 }, (_, i) => [`b100-${i}`, 100] as [string, number])];
    for (const [sub, share] of shares) await put(A.org, `${sub}-c`, { subject: sub, purpose: "marketing", status: "granted", recorded_at: day(-1), share });
    let inShare = 0;
    for (const [sub, share] of shares) {
      const a = await ask(A.org, "may_contact", { subject: sub, purpose: "marketing" });
      assert.equal(a.allowed, spec.inBucket("marketing", sub, share), `${sub} at ${share}%`);
      if (share === 0) assert.equal(a.allowed, false, "0%: no one");
      if (share === 100) assert.equal(a.allowed, true, "100%: everyone");
      if (share === 30 && a.allowed) inShare++;
      const leafB = a.explanation!.conditions.find((l) => l.op === "bucket")!;
      assert.equal(leafB.actual, spec.bucketOf("marketing", sub), "the explanation shows the subject's bucket");
    }
    assert.ok(inShare > 5 && inShare < 35, `about 30% of 60 subjects in a 30% share (${inShare})`);
    console.log(`✓ a fallback across areas: an existing exception decides (denying a granted consent, allowing a withdrawn one), an expired one or none passes to the consent, nothing denies; each step and the deciding area explained; the share's bucket decides as bucketOf (${inShare} of 60 at 30%, 0% none, 100% all)`);
  }

  // ---------- 5. workspaces ----------
  // The developer surface on (mold_v0-193), as gen-packs would carry a pack's developer_surface: its /v1/checks door.
  await import("../src/hosts.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  setPackConfigsForTest([{ pack: "fixture_checks", developer_surface: { events: [], sdk_languages: ["typescript"], client_sessions: { ttl_seconds: 900, allowed_origins: [], scopes: ["read", "checks"] } } } as never]);
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
      const listed = (await r.json()).checks;
      assert.deepEqual(listed.map((c: { name: string }) => c.name), ["may_process", "may_email", "may_contact"]);
      assert.deepEqual(listed[2].first_of.map((x: { area: string }) => x.area), [json.record_areas[2].name, MAIN], "a fallback lists its areas in order");
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

    // ---------- 9. onboarding: answers recorded once (mold_v0-225) ----------
    {
      const rows = await db.query<{ org_id: number; name: string; client: string; ok: boolean }>("SELECT org_id, name, client, ok FROM mcp_events WHERE method = 'check/answer' ORDER BY id");
      const pairs = rows.map((r) => `${r.org_id === A.org.orgId ? "A" : r.org_id === B.org.orgId ? "B" : r.org_id} ${r.name}`);
      assert.equal(new Set(pairs).size, pairs.length, `once per workspace and check (${pairs.join(", ")})`);
      for (const want of ["A check_may_process", "A check_may_email", "A check_may_contact", "B check_may_process"]) assert.ok(pairs.includes(want), `${want} recorded`);
      assert.ok(rows.every((r) => r.ok && r.client === "api"));
      const all = JSON.stringify(await db.query("SELECT * FROM mcp_events WHERE method = 'check/answer'"));
      assert.ok(!all.includes("marketing") && !all.includes('"s1"'), "no input in the event");
      // Asked again by another door: still one.
      await http.req("POST", "/api/checks/may_email", { authorization: `Bearer ${A.key}` }, { subject: "s6" });
      assert.equal((await db.query("SELECT 1 FROM mcp_events WHERE org_id = $1 AND method = 'check/answer' AND name = 'check_may_email'", [A.org.orgId])).length, 1);
      console.log("✓ onboarding: an answer at the HTTP doors is recorded once per workspace and check (check/answer under the tool's name), never an input");
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
    assert.deepEqual(hints.map((h) => [h.check, h.by, h.equal, h.order, h.limit]), [["may_process", "fields", ["purpose", "subject"], "recorded_at", 1], ["may_email", "fields", ["status", "subject"], null, 20],
      ["may_contact", "fields", ["purpose", "subject"], "recorded_at", 1], ["may_contact", "fields", ["purpose", "subject"], "recorded_at", 1]]);
    assert.deepEqual(hints.slice(2).map((h) => [h.area, (h as { step?: number }).step]), [[json.record_areas[2].name, 0], [MAIN, 1]], "a fallback's hint per step");
    assert.match(hints[0]!.suggest!, /CREATE INDEX ON workspace_records \(org_id, \(COALESCE\(data -> 'purpose'/);
    console.log(`✓ speed: median ${median.toFixed(1)} ms per answer over 3,000 records of one workspace (p90 ${times[27]!.toFixed(1)} ms); each check's index hint (the area's key index, its match fields, the latest by LIMIT 1)`);
  }
  await db.close();
  console.log("CHECKS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
