// mold_v0-349: operator-approved design changes from a console's end-to-end audit (2026-11-28):
//   npm run test:design-349        an embedded database and the API, about a minute
//   1. A fact, an action's unavailable and a notice's link that follow a reference forward, then back (match_field):
//      the schema, the build's checks, the console's pure helpers; in the database, read as the person in the
//      workspace's own scope (another workspace's records never count), nothing to follow when the field is empty, and
//      `none` with `ask`: the action asks first instead of being disabled (a plain `none` disables it, refused 409).
//   2. connection_env's `where` takes a list (one of its values), so one record per kind keeps its own one-only flag.
//   3. The spend ledger as a metric's `over` is checked by scripts/metrics-test.ts (in the database, against Billing's
//      orgMonthSpendUsd); here its pure rules: a card reads this month beside its weeks, in usd.
//   4. The record panel's Back (pushes one entry; closes first) is checked in a browser by scripts/record-panel-test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const fixture = (id: string) => JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", id, "pack.json"), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const areaOf = (j: { record_areas: { name: string }[] }, n: string) => j.record_areas.find((a) => a.name === n) as any;

try {
  // ---------- 1a. the declarations, pure ----------
  {
    const api = await import("../src/pack-api.js");
    assert.ok(api.DetailComputedSchema.safeParse({ area: "conns", via: "block", match_field: "compute", op: "latest" }).success, "a computed fact matched on a field");
    assert.ok(api.UnavailableRelatedSchema.safeParse({ area: "conns", via: "block", match_field: "compute", where: { field: "on", equals: true }, none: true }).success, "an unavailable related: matched, none");
    assert.ok(!api.UnavailableRelatedSchema.safeParse({ area: "conns", match_field: "compute", where: { field: "on", equals: true } }).success, "matched on a field names the field of theirs (via)");
    assert.ok(!api.UnavailableRelatedSchema.safeParse({ area: "conns", via: "block", where: { field: "on", equals: true }, none: false }).success, "none is true or left out");
    assert.ok(api.DetailNoticeLinkSchema.safeParse({ label: "Connect it on Compute › Hosting", tab: "compute-hosting", field: "compute" }).success, "a notice's link: a tab and a reference field");
    assert.ok(!api.DetailNoticeLinkSchema.safeParse({ label: "Go {there}", tab: "x-y" }).success, "its words are plain");
    assert.ok(api.DetailConditionSchema.safeParse({ fact: 11, empty: true }).success && !api.DetailConditionSchema.safeParse({ fact: 12, empty: true }).success, "a notice tests any of a rail's 12 facts");
    const conds = { field: "on", equals: true } as const;
    const apps = { pack: "p", name: "apps", scope: "workspace", fields: [{ name: "compute", label: "Compute", type: "reference", to: "providers" }, { name: "secret", label: "S", type: "text", encrypted: true }] as any[],
      detail: { tabs: [{ label: "A", sections: [{ title: "S", fields: ["compute"] }] }], header: { facts: [{ label: "Account", computed: { area: "conns", via: "block", match_field: "compute", op: "latest", where: conds } }] },
        actions: [{ kind: "edit", unavailable: [{ related: { area: "conns", via: "block", match_field: "compute", where: conds, none: true }, reason: "Not connected: go on?", ask: true }] }] } as any };
    const conns = { pack: "p", name: "conns", scope: "workspace", fields: [{ name: "block", label: "Block", type: "reference", to: "providers" }, { name: "on", label: "On", type: "boolean" }] as any[] };
    const providers = { pack: "p", name: "providers", scope: "platform", fields: [] as any[] };
    assert.deepEqual(api.detailBuildProblems([apps, conns, providers] as never, []), [], "forward through compute, back through the connections' block: builds");
    const bad = clone(apps); bad.detail.header.facts[0].computed.match_field = "ghost"; bad.detail.actions[0].unavailable[0].related.via = "nothing";
    const said = api.detailBuildProblems([bad, conns, providers] as never, []);
    assert.ok(said.some((m) => /fact 1 \(Account\): match_field ghost is not one of apps's fields/.test(m)), said.join("\n"));
    assert.ok(said.some((m) => /unavailable\[0\]\.related: via nothing is not one of conns's fields/.test(m)), said.join("\n"));
    const sealed = clone(apps); sealed.detail.header.facts[0].computed.match_field = "secret";
    assert.ok(api.detailBuildProblems([sealed, conns, providers] as never, []).some((m) => /match_field secret is encrypted/.test(m)), "never matched on an encrypted field");
    ok("a fact and an action's unavailable follow a reference forward then back (match_field); none, ask; a notice's link; the build names what is wrong");
  }

  // ---------- 1b. a notice's link, across the build (gen-packs' checkViews) and in the console ----------
  {
    const spec = await import("../src/metric-spec.js");
    const j = fixture("fixture_console");
    const views = (x: unknown) => spec.checkViews(spec.viewsOf([{ id: "fixture_console", definition: (x as any) }] as never)).filter((m) => /notice \d+: link/.test(m));
    const asDef = (x: any) => ({ ...x, recordAreas: x.record_areas });
    assert.deepEqual(views(asDef(j)), [], "the console fixture's link opens its parent's panel in the merged tab (which lists parents)");
    const other = clone(j); areaOf(other, "mx_items").detail.notices.find((n: any) => n.link).link.tab = "items";
    assert.match(views(asDef(other))[0] ?? "", /tab items does not list mx_parents parent names/, "a tab that does not list the records the field names");
    const gone = clone(j); areaOf(gone, "mx_items").detail.notices.find((n: any) => n.link).link.tab = "no-such-tab";
    assert.match(views(asDef(gone))[0] ?? "", /no-such-tab is not a tab of pack fixture_console/);
    const api = await import("../src/pack-api.js");
    const wrong = clone(areaOf(j, "mx_items")); wrong.detail.notices.find((n: any) => n.link).link.field = "summary";
    assert.ok(api.detailProblems(wrong).some((p) => /a notice's link opens the record a reference or link field names \(summary is text\)/.test(p.message)), "the field is a reference");
    // The console's own file, at run time (the server's typecheck never reads the console's types).
    const L = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "records", "detail-layout.ts")).href);
    const tabs = [{ pack: "p", id: "compute-hosting", url: "/app/compute?tab=compute-hosting" }, { pack: "p", id: "builds", url: "/app/builds" }];
    assert.equal(L.noticeHref({ label: "x", tab: "compute-hosting", field: "compute" }, "p", { compute: "fly-io" }, tabs), "/app/compute?tab=compute-hosting&id=fly-io", "that service's panel in its tab");
    assert.equal(L.noticeHref({ label: "x", tab: "builds" }, "p", {}, tabs), "/app/builds", "a tab alone");
    assert.equal(L.noticeHref({ label: "x", tab: "compute-hosting", field: "compute" }, "p", { compute: "" }, tabs), null, "nothing to open: no link");
    assert.equal(L.noticeHref({ label: "x", tab: "builds" }, "q", {}, tabs), null, "another pack's tab: none");
    const holds = L.conditionHolds({ all: [{ field: "compute", empty: false }, { fact: 8, empty: true }] }, { compute: "fly-io" }, null, Date.now(), { 8: { op: "latest", value: null, area: "conns", field: null, record: null } });
    assert.equal(holds, true, "a notice over the ninth fact (a rail's): no account marked, the compute set");
    ok("a notice's link names a tab of its pack listing the records its field names; the console opens that row's panel there (?id=)");
  }

  // ---------- 2. connection_env where lists ----------
  {
    const C = await import("../src/connection-env-config.js");
    assert.ok(C.ConnectionEnvSchema.safeParse({ area: "net", where: { category: ["firewall", "security-group"] }, use: "on", prefix: "FIREWALL_", only_one: true, fields: { CREDENTIALS: "credentials" } }).success, "a where of a list");
    assert.ok(!C.ConnectionEnvSchema.safeParse({ area: "net", where: { category: [] }, use: "on", prefix: "FIREWALL_", fields: { CREDENTIALS: "credentials" } }).success, "never an empty list");
    assert.equal(C.whereHolds({ category: ["firewall", "security-group"] }, { category: "security-group" }), true);
    assert.equal(C.whereHolds({ category: ["firewall", "security-group"] }, { category: "vpc" }), false);
    assert.equal(C.whereHolds({ category: "vpc", provider: "aws" }, { category: "vpc", provider: "aws" }), true, "one value as before");
    assert.deepEqual(C.whereFilter({ category: ["firewall", "security-group"], provider: "aws" }), { category: { in: ["firewall", "security-group"] }, provider: "aws" }, "a list's filter is in");
    const areas = [{ name: "net", scope: "workspace", contract: { actions: { reveal: { none: "secrets" } } }, fields: [{ name: "category", type: "enum" }, { name: "on", type: "boolean" }, { name: "credentials", type: "text", encrypted: true }] }];
    const entry = (where: unknown, prefix: string) => ({ area: "net", where, use: "on", prefix, only_one: true, fields: { CREDENTIALS: "credentials" } });
    assert.deepEqual(C.connectionEnvProblems([entry({ category: "vpc" }, "NETWORK_"), entry({ category: ["firewall", "security-group"] }, "FIREWALL_"), entry({ category: "private-link" }, "PRIVATELINK_")], areas), [], "one entry per kind, each its own prefix");
    const health = readFileSync(path.join(ROOT, "src", "connection-test-health.ts"), "utf8");
    assert.match(health, /const matches = \(where: Record<string, unknown>, data: Record<string, unknown>\) => whereHolds\(where, data\);/, "the one-only rule reads a list too: one marked per kind");
    const env = readFileSync(path.join(ROOT, "src", "connection-env.ts"), "utf8");
    assert.match(env, /filter: \{ \.\.\.whereFilter\(c\.where\),/, "a session's start finds the kind's record with the list as in");
    ok("connection_env's where takes a list (one of its values): one record marked per kind, each kind's variables under its own prefix");
  }

  // ---------- 3. the spend ledger's card, pure ----------
  {
    const spec = await import("../src/metric-spec.js");
    const m = { name: "month_spend", label: "Model spend this month", over: "spend", measure: "sum", limit: 12, pack: "p" } as never;
    assert.equal(spec.sparkCardOf(m).mode, "weekly", "this month's figure beside its weeks (never a running total of twelve weeks)");
    assert.equal(spec.metricUnit(m, "spend"), "usd");
    assert.ok((spec.RUN_SOURCES as readonly string[]).includes("spend"));
    const api = await import("../src/pack-api.js");
    assert.ok(api.MetricSchema.safeParse({ name: "month_spend", label: "x", over: "spend", measure: "sum" }).success, "a sum over spend names no field");
    assert.ok(!api.MetricSchema.safeParse({ name: "run_spend", label: "x", over: "runs", measure: "sum" }).success, "any other sum still names its field");
    const metrics = readFileSync(path.join(ROOT, "src", "metrics.ts"), "utf8");
    assert.match(metrics, /if \(!m\.by_time\) return \{ \.\.\.base, kind: "single", value: round\(await orgMonthSpendUsd\(orgId\)\) \};/, "this month's value IS Billing's figure");
    ok("a metric over spend: a sum with no field, in usd; its card this month's figure beside its weeks");
  }

  // ---------- 1c. in the database, through the API ----------
  {
    const F = await import("../src/features.js");
    const { setPacksForTest } = await import("../src/packs.js");
    const { compileDeclarations } = await import("../src/pack-manifest.js");
    const { createOrg } = await import("../src/auth.js");
    const ra = await import("../src/record-areas.js");
    const j = fixture("fixture_pages");
    const pr = areaOf(j, "projects");
    const passed = { field: "status", equals: "passed" };
    pr.detail.header.facts.push({ label: "Passed by its owner", computed: { area: "builds", via: "triggered_by", match_field: "owner", op: "count", where: passed } });
    const at = pr.detail.header.facts.length - 1;
    pr.detail.actions.find((a: any) => a.kind === "edit").unavailable = [{ related: { area: "builds", via: "triggered_by", match_field: "owner", where: passed, none: true }, reason: "No build by its owner passed yet: edit it anyway?", ask: true }];
    pr.detail.actions.find((a: any) => a.kind === "delete").unavailable = [{ related: { area: "builds", via: "triggered_by", match_field: "owner", where: passed, none: true }, reason: "No build by its owner passed yet." }];
    setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") },
      declared: compileDeclarations(j) } as never]);
    F.setFeaturesForTest({ record_pages: true });
    const A = (await createOrg(`Design A ${STAMP}`)).org, B = (await createOrg(`Design B ${STAMP}`)).org;
    const http = await startHttp();
    const owner = await http.signIn(A, "owner");
    const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
    const page = async (tok: string, key: string) => { const r = await http.req("GET", `/api/records/_page/projects/${key}`, h(tok)); return (await r.json()) as any; };
    const act = async (tok: string, key: string, id: string) => (await http.req("POST", `/api/records/_page/projects/${key}/actions/${id}`, h(tok), {})).status;
    const seed = async (org: number) => ra.asWriter({ by: "people", id: "seed" }, async () => {
      const rec = ra.workspaceRecords("fixture_pages", org);
      await rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages", owner: "Payments team" } });
      await rec.put("projects", "search", { title: "Search", data: { summary: "Product search" } });
    });
    await seed(A.orgId); await seed(B.orgId);
    const build = async (org: number, key: string, by: string, to: string[]) => {
      const rec = ra.workspaceRecords("fixture_pages", org);
      await ra.asWriter({ by: "run", id: "seed" }, () => rec.put("builds", key, { title: key, data: { status: "queued", triggered_by: by, started: "2026-11-01" } }));
      for (const s of to) await ra.asWriter({ by: "run", id: "seed" }, () => rec.move("builds", key, s));
    };
    const byId = (p: any) => Object.fromEntries(p.actions.map((a: any) => [a.id, a]));
    // A: a failed build by the owner (the where keeps none); B: a passed one by a team of the same name.
    await build(A.orgId, "b-1", "Payments team", ["running", "failed"]);
    await build(B.orgId, "b-9", "Payments team", ["running", "passed"]);
    let p = await page(owner, "checkout");
    assert.equal(p.facts[String(at)].value, 0, "none of A's own builds by its owner passed (B's never counts: its own scope)");
    assert.match(byId(p).edit.confirm ?? "", /^No build by its owner passed yet: edit it anyway\?/, "ask: still enabled, asking first in the reason's words");
    assert.equal(byId(p).edit.disabled, null);
    assert.equal(byId(p).delete.disabled, "No build by its owner passed yet.", "a plain none disables it with its reason");
    assert.equal(await act(owner, "checkout", "delete"), 409, "and the API refuses it");
    const s = await page(owner, "search");
    assert.deepEqual([s.facts[String(at)].value, byId(s).edit.confirm ?? null, byId(s).delete.disabled], [0, null, null], "no owner: nothing to follow, so neither holds");
    await build(A.orgId, "b-2", "Payments team", ["running", "passed"]);
    p = await page(owner, "checkout");
    assert.deepEqual([p.facts[String(at)].value, byId(p).edit.confirm ?? null, byId(p).delete.disabled], [1, null, null], "one passed: the fact counts it; no question, not disabled");
    const pB = await page(await http.signIn(B, "owner"), "checkout");
    assert.equal(pB.facts[String(at)].value, 1, "B's own count is its own build");
    F.setFeaturesForTest(null);
    await http.close();
    ok("in the database: the fact counts the workspace's own records whose field holds the record's value; nothing to follow, none; none with ask asks, without it disables (409)");
  }
} finally {
  cleanup();
}
process.exit(0);
