// A record-centred console (mold_v0-340), offline: an embedded database, a fake sign-in, a neutral fixture pack declared
// here (apps, builds, deployments, hourly reports, problems, learnings), the agent harness and nested runs on with no
// runner (a session's first wake stays queued). Run by `npm run test:app-nav`.
//   1. Refused at build: a related list's hop that does not point here, its list's via that does not point at the hop,
//      match_field beside through; a sessions or runs section's hop that does not point here, one hop twice; a charts
//      section naming a chart that is not the pack's, a chart whose metric's area it does not narrow, a metric over runs,
//      a records entry whose field is no single reference here; pack.json console.billing with an unknown tab, a tab
//      twice, settings_teams off the teams tab, an unknown field; console.sidebar_end empty or with a bad entry; in a
//      build: a sidebar_end tab with a group, one that is not the pack's, a usage tab beside a Spending tab;
//      console.sidebar_end_label (mold_v0-341) not plain words, without sidebar_end, in a profile, or (in a build) another
//      group's heading.
//   2. Related through a hop: an app's learnings are those of ITS problems (not another app's, not another workspace's
//      same keys), with no Show all; a role that may not read the hop's area does not see the list.
//   3. A record's sessions: those started from the app, from its builds and from its problems, never another app's;
//      the runs among them (a session handing work to other agents), active and finished, only those of its tree.
//   4. A record's charts: the pack's charts counted over this app's records only (its deployments' hourly reports, through
//      the deployments), another app's and another workspace's left out; a role that may not read the hop counts none.
//   5. The console (a build copy through gen-packs): Billing's tabs in the pack's order and words, Spending and Alerts in
//      them; Settings without Alerts and Teams (and without Automation); /app/activity, /app/usage and
//      /app/settings/automation leading to Billing's tabs; the moved Settings tabs' old ?tab= recorded; the sidebar's foot
//      (Billing, then Settings) after every group, under no heading, or (mold_v0-341) under console.sidebar_end_label's;
//      without the keys, Billing and Settings as before.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
const ok = (m: string) => console.log(`✓ ${m}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const ID = "fixture_app_nav";
/** A generated file's `export const <name>: T = <json>;` value (the JSON may span lines). */
const valueIn = (text: string, name: string) => {
  const m = new RegExp(`export const ${name}(?::[^=]*)? = ([\\s\\S]*?);\\n(?=\\S|\\n|$)`).exec(text);
  assert.ok(m, `${name} in the generated file`);
  return JSON.parse(m[1]!);
};
const ref = (name: string, label: string, to: string) => ({ name, label, type: "reference", to });
const PACK = {
  id: ID, name: "Fixture app nav", version: "0.1.0",
  record_areas: [
    { name: "nv_apps", label: "Applications", role: "check", scope: "workspace", fields: [{ name: "summary", label: "Summary", type: "text" }],
      detail: {
        tabs: [
          { label: "Overview", sections: [{ title: "About", fields: ["summary"] }] },
          { label: "Traffic", sections: [{ title: "Traffic", charts: { charts: ["nv_traffic_chart", "nv_total_chart", "nv_deploys_chart"], records: [
            { area: "nv_reports", via: "deploy", through: { area: "nv_deploys", via: "app" } }, { area: "nv_deploys", via: "app" }] } }] },
          { label: "Agents", sections: [{ title: "Agent sessions", sessions: { through: [{ area: "nv_builds", via: "app" }, { area: "nv_problems", via: "app" }], limit: 10 } }] },
          { label: "Runs", sections: [{ title: "Runs", agent_runs: { through: [{ area: "nv_builds", via: "app" }, { area: "nv_problems", via: "app" }] } }] },
          { label: "Improvement", sections: [
            { title: "Problems", related: { area: "nv_problems", via: "app" } },
            { title: "Learnings", related: { area: "nv_learnings", via: "problem", through: { area: "nv_problems", via: "app" }, limit: 10 } }] },
        ],
        actions: [{ kind: "start_agent", place: "primary", label: "Start build", profile: "default", first_message: "Build {{title}}.",
          creates: { area: "nv_builds", link: "app", fields: { session: "$session" } } }] } },
    { name: "nv_builds", label: "Builds", role: "check", scope: "workspace", fields: [ref("app", "Application", "nv_apps"), { name: "session", label: "Session", type: "text", set_by: "action" }],
      detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["app"] }] }],
        actions: [{ kind: "start_agent", place: "primary", label: "Ask about it", profile: "default", first_message: "Look at {{title}}." }] } },
    { name: "nv_deploys", label: "Deployments", role: "check", scope: "workspace", fields: [ref("app", "Application", "nv_apps")] },
    { name: "nv_reports", label: "Hourly reports", role: "check", scope: "workspace", fields: [ref("deploy", "Deployment", "nv_deploys"), { name: "requests", label: "Requests", type: "number" }] },
    { name: "nv_problems", label: "Problems", role: "check", scope: "workspace", fields: [ref("app", "Application", "nv_apps")],
      detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["app"] }] }],
        actions: [{ kind: "start_agent", place: "primary", label: "Improve", profile: "default", first_message: "Improve {{title}}." }] } },
    { name: "nv_learnings", label: "Learnings", role: "check", scope: "workspace", fields: [ref("problem", "Problem", "nv_problems"), { name: "detail", label: "Detail", type: "text" }] },
  ],
  metrics: [
    { name: "nv_requests_by_deploy", label: "Requests", over: "nv_reports", measure: "sum", field: "requests", group_by: "deploy", limit: 10 },
    { name: "nv_requests", label: "Requests", over: "nv_reports", measure: "sum", field: "requests" },
    { name: "nv_deploys_total", label: "Deployments", over: "nv_deploys" },
  ],
  charts: [
    { name: "nv_traffic_chart", title: "Requests by deployment", type: "bar", metrics: ["nv_requests_by_deploy"] },
    { name: "nv_total_chart", title: "Requests", type: "number", metrics: ["nv_requests"] },
    { name: "nv_deploys_chart", title: "Deployments", type: "number", metrics: ["nv_deploys_total"] },
  ],
  tabs: [{ id: "apps", kind: "area", area: "nv_apps", icon: "rocket", group: "Build", charts: [], views: ["table"] }],
};

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const P = await import("../src/pack-api.js");
  const C = await import("../src/console-pages.js");
  const ra = await import("../src/record-areas.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { createOrg } = await import("../src/auth.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const kv = await import("../src/keyvault.js");
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: ID, name: "Fixture app nav", version: "0.1.0", entry: null, migrations: null, words: {}, dir: ROOT }, declared: compileDeclarations(j) } as never]);

  // ---------- 1. refused at build ----------
  {
    for (const a of PACK.record_areas) assert.equal(P.RecordAreaSchema.safeParse(a).success, true, `${a.name}: ${JSON.stringify(P.RecordAreaSchema.safeParse(a).error?.issues)}`);
    const parsed = PACK.record_areas.map((a) => ({ ...P.RecordAreaSchema.parse(a), pack: ID }));
    assert.deepEqual(P.detailBuildProblems(parsed as never, []), [], "the fixture's cross-area declarations hold");
    const bent = clone(parsed) as any[];
    const tabs = bent[0].detail.tabs;
    tabs[4].sections[1].related.through.via = "summary";              // the hop's via is no field pointing here
    tabs[2].sections[0].sessions.through[0].via = "session";          // a sessions hop through a text field
    tabs[3].sections[0].agent_runs.through.push(clone(tabs[3].sections[0].agent_runs.through[0])); // one hop twice
    tabs[1].sections[0].charts.records[1].via = "nope";               // a chart records entry's field
    const probs = P.detailBuildProblems(bent as never, []).join("\n");
    for (const re of [/section Learnings: through: nv_problems has no link back|section Learnings: through: nv_problems's field summary does not point at nv_apps/,
      /sessions\.through\[0\]: nv_builds's field session does not point at nv_apps/, /agent_runs\.through names a hop twice/,
      /charts\.records\[1\]: nv_deploys's field nope is not a single reference to nv_apps/])
      assert.match(probs, re);
    const viaOff = clone(parsed) as any[];
    viaOff[0].detail.tabs[4].sections[1].related.via = "detail";      // the list's via must point at the hop's area
    viaOff[0].detail.tabs[4].sections[0].related.match_field = "summary";
    viaOff[0].detail.tabs[4].sections[0].related.through = { area: "nv_builds", via: "app" };
    const p2 = P.detailBuildProblems(viaOff as never, []).join("\n");
    assert.match(p2, /nv_learnings's field detail does not point at nv_problems: a related list shows the records that point back at the nv_problems records it goes through/);
    assert.match(p2, /a related list through a hop points at the hop's records: it has no match_field/);
    const many = clone(PACK.record_areas[0]) as any;
    many.detail.tabs[2].sections[0].sessions.through = [1, 2, 3, 4, 5].map(() => ({ area: "nv_builds" }));
    assert.equal(P.RecordAreaSchema.safeParse(many).success, false, "at most 4 hops");
    const mixed = clone(PACK.record_areas[0]) as any;
    mixed.detail.tabs[2].sections[0].fields = ["summary"];
    assert.ok(P.RecordAreaSchema.safeParse(mixed).error?.issues.some((x) => /lists agent sessions: it has no fields/.test(x.message)), "a sessions section has no fields");
    install(PACK);
    const { checkViews } = await import("../src/metric-spec.js");
    const { buildViews } = await import("../src/metrics.js");
    assert.deepEqual(checkViews(buildViews()), [], "the fixture's charts hold");
    const badChart = clone(PACK) as any;
    badChart.record_areas[0].detail.tabs[1].sections[0].charts.charts.push("nope_chart");
    badChart.record_areas[0].detail.tabs[1].sections[0].charts.records.pop();
    badChart.metrics.push({ name: "nv_runs", label: "Runs", over: "runs" });
    badChart.charts.push({ name: "nv_runs_chart", title: "Runs", type: "number", metrics: ["nv_runs"] });
    badChart.record_areas[0].detail.tabs[1].sections[0].charts.charts.push("nv_runs_chart");
    assert.throws(() => install(badChart), (e: Error) => /nope_chart is not one of pack fixture_app_nav's charts/.test(e.message)
      && /chart nv_deploys_chart's metric nv_deploys_total is over nv_deploys: say in records which of its records are this record's/.test(e.message)
      && /chart nv_runs_chart's metric nv_runs is over runs: a record's charts count record areas only/.test(e.message), "a chart not the pack's, an area not narrowed, a metric over runs");
    install(PACK);
    // console.billing and console.sidebar_end
    const cp = (v: unknown) => C.consoleProblems(v, "pack.json").join("\n");
    assert.equal(cp({ billing: { tabs: ["spending", { id: "teams", label: "Teams", settings_teams: true }, "alerts"] }, sidebar_end: ["billing", "settings"] }), "", "a good block");
    assert.match(cp({ billing: { tabs: ["spending", "wallet"] } }), /wallet" is not one of Billing's tabs/);
    assert.match(cp({ billing: { tabs: ["people", "people"] } }), /people is named twice/);
    assert.match(cp({ billing: { tabs: [{ id: "rules", settings_teams: true }] } }), /settings_teams is true, on the teams tab only/);
    assert.match(cp({ billing: { tabs: ["people"], order: 1 } }), /unknown field order/);
    assert.match(cp({ billing: { tabs: [] } }), /1 to 6 of spending/);
    assert.match(cp({ sidebar_end: [] }), /1 to 6 entries/);
    assert.match(cp({ sidebar_end: ["Billing"] }), /a tab's id, or "settings"/);
    // mold_v0-341: the foot's heading.
    assert.equal(cp({ sidebar_end: ["billing", "settings"], sidebar_end_label: "Workspace" }), "", "a foot with a heading");
    for (const bad of ["", " Workspace", "Work/space", "x".repeat(41), 3, ["Workspace"]])
      assert.match(cp({ sidebar_end: ["settings"], sidebar_end_label: bad }), /sidebar_end_label: a short name in plain words \(1 to 40 characters\)/, `label ${JSON.stringify(bad)}`);
    assert.match(cp({ sidebar_end_label: "Workspace" }), /sidebar_end_label: the heading of console\.sidebar_end's group/, "a heading with no foot");
    assert.match(C.consoleProblems({ sidebar_end_label: "Workspace" }, "profile.json").join("\n"), /sidebar_end_label is a pack's/);
    assert.match(C.consoleProblems({ billing: { tabs: ["people"] } }, "profile.json").join("\n"), /billing is a pack's/);
    ok("refused at build: a hop that does not point here (a related list's, a sessions or runs section's), a list's via off the hop, match_field with a hop, a hop twice, five hops; a chart not the pack's, an area its records do not narrow, a metric over runs, a records field; console.billing's unknown tab, a tab twice, settings_teams off teams, an unknown field, none; sidebar_end empty or malformed; sidebar_end_label not plain words or with no foot; each in a profile");
  }

  // ---------- the world ----------
  F.setFeaturesForTest({ record_pages: true, agent_harness: true, nested_runs: true });
  await saveSettingValues("test-staff", { AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  await kv.setCredential("anthropic", `sk-default-${STAMP}-0123456789`, { label: "default", priority: 0 });
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const W = (await createOrg(`App nav ${STAMP}`)).org;
  const W2 = (await createOrg(`App nav other ${STAMP}`)).org;
  const own = await http.signInAs(W, "owner");
  const own2 = await http.signInAs(W2, "owner");
  const viewer = await http.signInAs(W, "viewer");
  const h = (t: string) => ({ authorization: `Bearer ${t}`, "x-pack-request": "1" });
  const app = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const seed = async (org: number, user: string, big = 1) => {
    const rec = ra.workspaceRecords(ID, org);
    await ra.asWriter({ by: "people", id: user }, async () => {
      for (const a of ["shop", "blog"]) await rec.put("nv_apps", a, { title: a === "shop" ? "Shop" : "Blog", data: { summary: a } });
      for (const [d, a] of [["shop-d1", "shop"], ["shop-d2", "shop"], ["blog-d1", "blog"]]) await rec.put("nv_deploys", d!, { title: `Deploy ${d}`, data: { app: a } });
      const reports: [string, string, number][] = [["r1", "shop-d1", 100], ["r2", "shop-d1", 20], ["r3", "shop-d2", 5], ["r4", "blog-d1", 7000]];
      for (const [k, d, n] of reports) await rec.put("nv_reports", k, { title: k, data: { deploy: d, requests: n * big } });
      for (const [p, a] of [["shop-p1", "shop"], ["blog-p1", "blog"]]) await rec.put("nv_problems", p!, { title: `Problem ${p}`, data: { app: a } });
      for (const [l, p] of [["shop-l1", "shop-p1"], ["shop-l2", "shop-p1"], ["blog-l1", "blog-p1"]]) await rec.put("nv_learnings", l!, { title: `Learning ${l}`, data: { problem: p, detail: l } });
    });
  };
  await seed(W.orgId, own.userId);
  await seed(W2.orgId, own2.userId, 1000);
  const page = async (tok: string, key: string, tab: string) => {
    const r = await app(tok, "GET", `/api/records/_page/nv_apps/${key}?tab=${tab}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  // ---------- 2. related through a hop ----------
  {
    const p = await page(own.token, "shop", "improvement");
    assert.deepEqual(p.sections["4-0"].records.map((r: any) => r.key), ["shop-p1"], "its problems");
    const l = p.sections["4-1"];
    assert.deepEqual(l.records.map((r: any) => r.key).sort(), ["shop-l1", "shop-l2"], "its problems' learnings only (not the blog's, not the other workspace's)");
    assert.deepEqual([l.via, l.match, l.more], ["problem", null, false], "no Show all: the list names no one record");
    const blog = await page(own.token, "blog", "improvement");
    assert.deepEqual(blog.sections["4-1"].records.map((r: any) => r.key), ["blog-l1"], "the blog's");
    const hide = clone(PACK) as any;
    hide.record_areas[4].permissions = { read: ["owner", "member"] };
    install(hide);
    const v = await page(viewer.token, "shop", "improvement");
    assert.deepEqual([v.sections["4-0"], v.sections["4-1"]], [{ hidden: true }, { hidden: true }], "a role that may not read the problems sees neither list");
    install(PACK);
    ok("related through a hop: an app's learnings are those of its own problems (not another app's, nor another workspace's same keys), with no Show all; hidden from a role that may not read the hop");
  }

  // ---------- 3. a record's sessions and the runs among them ----------
  {
    const press = async (area: string, key: string) => {
      const p = await app(own.token, "GET", `/api/records/_page/${area}/${key}`);
      const a = p.body.actions.find((x: { kind: string }) => x.kind === "start_agent");
      const r = await app(own.token, "POST", `/api/records/_page/${area}/${key}/actions/${a.id}`, {});
      assert.equal(r.status, 200, `${area}/${key}: ${JSON.stringify(r.body)}`);
      return { session: r.body.session.id as string, build: r.body.created?.key as string | undefined };
    };
    const fromApp = await press("nv_apps", "shop");
    assert.ok(fromApp.build, "Start build made a build");
    const fromBuild = await press("nv_builds", fromApp.build!);
    const fromProblem = await press("nv_problems", "shop-p1");
    const other = await press("nv_apps", "blog");
    const s = (await page(own.token, "shop", "agents")).sections["2-0"];
    assert.deepEqual(s.rows.map((r: any) => r.id).sort(), [fromApp.session, fromBuild.session, fromProblem.session].sort(), "started from the app, its build and its problem; not the blog's");
    assert.equal(s.total, 3);
    assert.ok(!s.rows.some((r: any) => r.id === other.session), "never another app's");
    assert.ok(s.rows.every((r: any) => typeof r.title === "string" && "phase" in r && "spent_usd" in r), "each as the Agents page lists it");
    // Runs: only a session handing work to other agents is one; the problem's session hands work to one child.
    let r = (await page(own.token, "shop", "runs")).sections["3-0"];
    assert.deepEqual([r.total, r.rows], [0, []], "no run yet: no session has handed work on");
    const child = async (root: string, status: string) => db.query(
      `INSERT INTO harness_children (id, org_id, root_id, parent_id, kind, name, child_no, budget_usd, status, settled_at) VALUES ($1, $2, $3, $3, 'prompt', 'Look', $4, 0.1, $5, $6)`,
      [`hch_${Math.random().toString(36).slice(2, 12)}`, W.orgId, root, 1, status, status === "running" ? null : new Date()]);
    await child(fromProblem.session, "running");
    await child(other.session, "done");
    r = (await page(own.token, "shop", "runs")).sections["3-0"];
    assert.deepEqual(r.rows.map((x: any) => x.id), [fromProblem.session], "the shop's run (active), not the blog's");
    assert.deepEqual([r.rows[0].finished, r.rows[0].children, r.rows[0].open], [false, 1, 1], "active, one agent at work");
    await db.query("UPDATE harness_children SET status = 'done', settled_at = now() WHERE root_id = $1", [fromProblem.session]);
    r = (await page(own.token, "shop", "runs")).sections["3-0"];
    assert.deepEqual([r.rows.length, r.rows[0].finished], [1, true], "and once finished, still listed (finished)");
    const blogRuns = (await page(own.token, "blog", "runs")).sections["3-0"];
    assert.deepEqual(blogRuns.rows.map((x: any) => x.id), [other.session], "the blog's own");
    F.setFeaturesForTest({ record_pages: true, agent_harness: true, nested_runs: false });
    assert.deepEqual((await page(own.token, "shop", "runs")).sections["3-0"], { hidden: true }, "without nested runs: no runs section");
    F.setFeaturesForTest({ record_pages: true, agent_harness: true, nested_runs: true });
    // mold_v0-343: two runs that are no agent session's, of a kind this build does not declare ("build"): one started on
    // a build record (its title), one on none (the kind in words, "Build"), never the raw id.
    await ra.workspaceRecords(ID, W.orgId).put("nv_builds", "shop-b9", { title: "build 9 · 22 Nov", data: { app: "shop" } });
    const rawRun = async (id: string, record: [string, string] | null) => db.query(
      `INSERT INTO runs (id, org_id, pack, kind, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, record_area, record_key) VALUES ($1, $2, $3, 'build', '{}', 1, 60, 60, 1, $4, $5)`,
      [id, W.orgId, ID, record?.[0] ?? null, record?.[1] ?? null]);
    await rawRun(`run_nv343rec${STAMP}`, ["nv_builds", "shop-b9"]);
    await rawRun(`run_nv343none${STAMP}`, null);
    // Billing's Spending (GET /api/usage) and Usage (GET /api/app/usage): each run by its own title, never a raw kind id.
    for (const [where, get] of [["Spending", "/api/usage?days=7"], ["Usage", "/api/app/usage?days=7"]] as const) {
      const u = await app(own.token, "GET", get);
      assert.equal(u.status, 200, JSON.stringify(u.body).slice(0, 300));
      const recent = (where === "Spending" ? u.body.runs.recent : u.body.run_usage.recent) as { id: string; kind: string; title: string | null }[];
      const titles = JSON.stringify(recent.map((x) => [x.kind, x.title]));
      assert.ok(recent.length >= 2, `${where}: Recent runs listed: ${titles}`);
      assert.ok(recent.every((x) => typeof x.title === "string" && x.title.trim() !== "" && x.title !== x.kind), `${where}: no Recent runs title is a raw kind id: ${titles}`);
      assert.ok(recent.some((x) => x.kind === "session" && /Shop|Ask about|Improve|Agent session/.test(String(x.title))), `${where}: a wake by its session's title: ${titles}`);
      assert.equal(recent.find((x) => x.id.startsWith("run_nv343rec"))?.title, "build 9 · 22 Nov", `${where}: a run on a record by its record's title`);
      assert.equal(recent.find((x) => x.id.startsWith("run_nv343none"))?.title, "Build", `${where}: else its kind in words, capitalised`);
    }
    ok("a record's sessions: those started from the app, its build and its problem, never another app's; the runs among them only once a session hands work on, active then finished, the app's own; none without nested runs; Recent runs (Spending, Usage) each by its own title: a session's, a record's, else its kind in words, never a raw kind id");
  }

  // ---------- 4. a record's charts ----------
  {
    const m = async (tok: string, key: string) => {
      const r = await app(tok, "GET", `/api/records/_page/nv_apps/${key}/metrics?section=1-0`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return Object.fromEntries((r.body.metrics as any[]).map((x) => [x.name, x]));
    };
    const shop = await m(own.token, "shop");
    assert.equal(shop.nv_requests.value, 125, "the shop's deployments' reports only (100 + 20 + 5)");
    assert.deepEqual(shop.nv_requests_by_deploy.groups.map((g: any) => [g.key, g.value]), [["shop-d1", 120], ["shop-d2", 5]], "by its deployments");
    assert.equal(shop.nv_deploys_total.value, 2, "its deployments, directly");
    assert.equal((await m(own.token, "blog")).nv_requests.value, 7000, "the blog's");
    assert.equal((await m(own2.token, "shop")).nv_requests.value, 125000, "the other workspace's shop: its own records");
    const bad = await app(own.token, "GET", "/api/records/_page/nv_apps/shop/metrics?section=0-0");
    assert.equal(bad.status, 400, "a section that is not a charts section");
    const none = await app(own.token, "GET", "/api/records/_page/nv_apps/nope/metrics?section=1-0");
    assert.equal(none.status, 404, "no such record");
    const hide = clone(PACK) as any;
    hide.record_areas[2].permissions = { read: ["owner", "member"] };
    install(hide);
    const v = await m(viewer.token, "shop");
    assert.equal(v.nv_requests.value, 0, "a role that may not read the deployments counts none of their reports");
    assert.equal(v.nv_deploys_total.status, 403, "and is refused the deployments' own count, as on an overview");
    install(PACK);
    ok("a record's charts: counted over the app's own records (its deployments' reports through the deployments, its deployments), never another app's or workspace's; a role that may not read the hop counts none; a section that is no charts section refused");
  }
  F.setFeaturesForTest(null);
  await http.close();

  // ---------- 5. the console: Billing's tabs, Settings, the sidebar's foot (a build through gen-packs) ----------
  {
    const consolePack = {
      id: ID, name: "Fixture app nav", version: "0.1.0",
      // A due date: Settings' Alerts has a row (the scheduled_alerts flag is asked for).
      record_areas: [{ name: "nv_apps", label: "Applications", role: "check", scope: "workspace", fields: [{ name: "summary", label: "Summary", type: "text" }, { name: "due", label: "Due", type: "date" }],
        due: { field: "due", within_days: 3 } }],
      tabs: [{ id: "overview", kind: "overview", label: "Overview", include: ["setup"] }, { id: "apps", kind: "area", area: "nv_apps", group: "Build" },
        { id: "billing", kind: "billing", label: "Billing" }],
      console: { billing: { tabs: [{ id: "spending", label: "Spending" }, "people", { id: "teams", label: "Teams", settings_teams: true }, "rules", { id: "alerts", label: "Alerts" }, "access-log"] },
        sidebar_end: ["billing", "settings"] },
    };
    const gen = (name: string, pack: unknown, extra: string[] = []) => {
      const dir = path.join(TMP, name), packs = path.join(dir, "packs"), out = path.join(dir, "out"), profile = path.join(dir, "profile.json");
      mkdirSync(path.join(packs, ID), { recursive: true });
      writeFileSync(path.join(packs, ID, "pack.json"), JSON.stringify(pack));
      writeFileSync(profile, JSON.stringify({ features: { teams: true, scheduled_alerts: true, agent_harness: true } }));
      const g = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packs, "--out", out, "--profile", profile, ...extra], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { status: g.status, out: `${g.stdout}\n${g.stderr}`, file: (f: string) => readFileSync(path.join(out, f), "utf8") };
    };
    const g = gen("with", consolePack);
    assert.equal(g.status, 0, g.out.slice(-2000));
    const nav = g.file("web/src/config/pack-nav.generated.ts");
    const val = (name: string) => valueIn(nav, name);
    assert.deepEqual(val("billingTabs"), [{ id: "spending", label: "Spending" }, { id: "people" }, { id: "teams", label: "Teams", settings_teams: true }, { id: "rules" }, { id: "alerts", label: "Alerts" }, { id: "access-log" }], "Billing's tabs in the pack's order and words");
    assert.deepEqual(val("settingsTabs").map((t: any) => t.id), ["credentials"], "Settings keeps neither Alerts nor Teams");
    assert.ok(!val("settingsTabs").some((t: any) => t.group === "automation"), "no Automation group left");
    assert.deepEqual(val("movedSettingsTabs"), { alerts: "/app/billing?tab=alerts", teams: "/app/billing?tab=teams" }, "their old ?tab= addresses lead to Billing");
    assert.deepEqual(val("sidebarEnd"), ["/app/billing", "/app/settings"], "the sidebar's foot: Billing, then Settings");
    const groups = val("tabPortalNav");
    assert.deepEqual(groups.map((x: any) => [x.label, x.items.map((i: any) => i.url)]), [["", ["/app"]], ["Build", ["/app/apps"]], ["", ["/app/billing"]]], "Billing after every group, under no heading");
    assert.deepEqual(val("usagePortalNav"), [], "no Activity entry of its own");
    const routes = JSON.parse(g.file("web/src/config/pack-routes.generated.json")).redirects as { source: string; destination: string }[];
    for (const [s, d] of [["/app/activity", "/app/billing?tab=spending"], ["/app/usage", "/app/billing?tab=spending"], ["/app/settings/automation", "/app/billing?tab=alerts"]])
      assert.ok(routes.some((x) => x.source === s && x.destination === d), `${s} leads to ${d}`);
    const side = gen("with-sidebar", consolePack, ["--sidebar"]);
    assert.equal(side.status, 0, side.out.slice(-1500));
    const app = side.out.slice(side.out.indexOf("/app sidebar:"), side.out.indexOf("/admin sidebar:"));
    assert.ok(/Build\n\s+Applications? \/app\/apps\n\s+\(no heading\)\n\s+Billing \/app\/billing\n\s+Settings \/app\/settings/.test(app) || /Billing\s+\/app\/billing[\s\S]*Settings\s+\/app\/settings\s*$/.test(app.trim()), `--sidebar prints Billing then Settings at the foot:\n${app}`);
    assert.ok(app.indexOf("Settings") > app.indexOf("Build"), "Settings after the groups, not below Overview");
    // Without the keys: Billing as before, Alerts and Teams in Settings, no foot, no redirects.
    const plain = clone(consolePack) as any;
    delete plain.console;
    const g0 = gen("without", plain);
    assert.equal(g0.status, 0, g0.out.slice(-1500));
    const nav0 = g0.file("web/src/config/pack-nav.generated.ts");
    const val0 = (name: string) => valueIn(nav0, name);
    assert.equal(val0("billingTabs"), null);
    assert.deepEqual(val0("settingsTabs").filter((t: any) => ["alerts", "teams"].includes(t.id)).map((t: any) => t.id).sort(), ["alerts", "teams"], "Settings keeps Alerts and Teams");
    assert.deepEqual([val0("movedSettingsTabs"), val0("sidebarEnd")], [{}, []]);
    assert.deepEqual(val0("tabPortalNav").map((x: any) => x.label), ["", "Build"], "Billing joins the first group, as before");
    const routes0 = JSON.parse(g0.file("web/src/config/pack-routes.generated.json")).redirects as { source: string }[];
    assert.ok(!routes0.some((x) => ["/app/activity", "/app/usage", "/app/settings/automation"].includes(x.source)), "no redirects");
    // Refused in a build.
    const refuse = (name: string, edit: (p: any) => void, re: RegExp) => {
      const p = clone(consolePack) as any;
      edit(p);
      const r = gen(name, p);
      assert.notEqual(r.status, 0, `${name}: refused`);
      assert.match(r.out, re, name);
    };
    refuse("grouped-end", (p) => { p.tabs[2].group = "Money"; }, /console\.sidebar_end: tab billing has a group \(Money\)/);
    refuse("unknown-end", (p) => { p.console.sidebar_end = ["wallet"]; }, /console\.sidebar_end: wallet is not one of the pack's tabs/);
    // mold_v0-341: the foot under a heading of its own: the same entries, Settings in it, the console's drawing unchanged.
    const headed = clone(consolePack) as any;
    headed.console.sidebar_end_label = "Workspace";
    const gh = gen("with-heading", headed);
    assert.equal(gh.status, 0, gh.out.slice(-2000));
    const navh = gh.file("web/src/config/pack-nav.generated.ts");
    assert.equal(valueIn(navh, "sidebarEndLabel"), "Workspace");
    assert.deepEqual(valueIn(navh, "sidebarEnd"), ["/app/billing", "/app/settings"], "the same foot");
    assert.deepEqual(valueIn(navh, "tabPortalNav").map((x: any) => [x.label, x.items.map((i: any) => i.url)]), [["", ["/app"]], ["Build", ["/app/apps"]], ["Workspace", ["/app/billing"]]], "Billing under Workspace, after every group");
    const ghs = gen("with-heading-sidebar", headed, ["--sidebar"]);
    assert.equal(ghs.status, 0, ghs.out.slice(-1500));
    const apph = ghs.out.slice(ghs.out.indexOf("/app sidebar:"), ghs.out.indexOf("/admin sidebar:"));
    assert.match(apph, /Build\n\s+Applications?\s+\/app\/apps\n\s+Workspace\n\s+Billing\s+\/app\/billing\n\s+Settings\s+\/app\/settings\s*$/, `--sidebar prints Billing then Settings under Workspace:\n${apph}`);
    assert.doesNotMatch(apph, /\(no heading\)\n\s+Billing/, "no unheaded foot");
    assert.equal(valueIn(nav, "sidebarEndLabel"), "", "without the heading: none (the foot as before)");
    assert.equal(valueIn(nav0, "sidebarEndLabel"), "", "without the keys: none");
    // Settings alone at the foot takes the heading too.
    const alone = clone(headed) as any;
    alone.console.sidebar_end = ["settings"];
    const ga = gen("heading-settings-only", alone, ["--sidebar"]);
    assert.equal(ga.status, 0, ga.out.slice(-2000));
    const appa = ga.out.slice(ga.out.indexOf("/app sidebar:"), ga.out.indexOf("/admin sidebar:"));
    assert.match(appa, /\n\s+Workspace\n\s+Settings\s+\/app\/settings\s*$/, `Settings alone under Workspace:\n${appa}`);
    refuse("heading-is-a-group", (p) => { p.console.sidebar_end_label = "build"; }, /console\.sidebar_end_label: build is already a group's heading \(tab apps of pack fixture_app_nav\)/);
    refuse("usage-tab", (p) => { p.tabs.push({ id: "usage", kind: "usage", label: "Usage", group: "Build" }); }, /tab usage: the Activity page is Billing's Spending tab/);
    ok("the console: Billing's tabs in the pack's order and words (Spending, People, Teams, Budget rules, Alerts, Access log); Settings without Alerts, Teams and Automation; /app/activity, /app/usage and /app/settings/automation lead to Billing; Billing then Settings at the sidebar's foot (also --sidebar), under no heading or console.sidebar_end_label's (Settings alone too); without the keys all as before; refused: a foot tab with a group or not the pack's, a heading that is another group's, a usage tab beside Spending");
  }

  // ---------- 6. the console's drawing rules (offline, from its source; the lane console measures them drawn) ----------
  {
    const src = (rel: string) => readFileSync(path.join(ROOT, "web", "src", rel), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const page = src("features/records/detail-page.tsx");
    const strip = page.slice(page.indexOf("function RecordTabStrip("), page.indexOf("/** The first tab's end:"));
    const cls = /export const RECORD_TAB_STRIP_CLASS = '([^']+)'/.exec(page)?.[1] ?? "";
    assert.match(cls, /(^| )flex-wrap( |$)/, "the record's tab strip wraps to another row when its tabs do not fit");
    assert.doesNotMatch(cls + strip, /flex-nowrap|overflow-x-auto|w-max|scrollLeft|mask-image/, "never a sideways scroller that clips a tab");
    assert.match(strip, /<TabsTrigger [^>]*className='[^']*flex-none[^']*whitespace-nowrap/, "a tab's label never breaks inside itself");
    const row = page.slice(page.indexOf("export function CompactRunRow("), page.indexOf("/** mold_v0-340: a record's agent sessions"));
    assert.match(row, /title=\{whole\} className='[^']*\btruncate\b/, "a compact row's title: one line, cut with an ellipsis, the whole on hover");
    assert.match(row, /\{title\}<\/Link>\s*<span className='flex [^']*'>\{state\}<span className='tabular-nums'>\{spend\}<\/span><\/span>\s*<span className='text-muted-foreground [^']*\btruncate\b[^']*'>\{meta\}<\/span>/, "then two lines: state and spend, then who and when (muted)");
    assert.match(page, /const useCompactRows = \(\) => \{ const inPanel = useInRecordPanel\(\), full = useRecordPanelFull\(\); return inPanel && !full; \};/, "compact inside a record panel, not once it is expanded with room");
    assert.equal((page.match(/compact \? \(\s*<CompactRunRow/g) ?? []).length, 2, "both the sessions and the runs lists use it");
    const usage = src("features/portal/usage.tsx");
    const table = usage.slice(usage.indexOf("export function RunTable("));
    assert.match(table, /\{x\.title \|\| runKindLabel\(x\.pack \?\? '', x\.kind\)\}/, "Recent runs: a run's title, else its kind in the pack's words");
    assert.match(table, /<RunStatusBadge status=\{runStatusOf\(x\.status\)\} \/>/, "its status in the one status vocabulary, as a badge");
    assert.doesNotMatch(table, /<TableCell>\{x\.status\}<\/TableCell>/, "never the stored status word");
    const route = readFileSync(path.join(ROOT, "src", "usage-routes.ts"), "utf8");
    assert.match(route, /runTitles\(s\.org, report\.runs\.recent,/, "Recent runs on Spending: each run's own title (src/run-analytics.ts runTitles)");
    const rr = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "tabs", "run-rows.ts")).href);
    assert.deepEqual([rr.runKindLabel("p", "build"), rr.runKindLabel("p", "weekly_scan"), rr.runKindLabel("_agent", "session")], ["Build", "Weekly scan", "Agent session"],
      "a kind the build does not declare: its id in words, capitalised, never the raw id (mold_v0-343)");
    ok("the console's drawing: the record's tab strip wraps (no scroller, no tab clipped, no label broken); sessions and runs in a record panel as compact rows (title on one line with an ellipsis and the whole on hover, state and spend, then who and when), the table layout once expanded; Recent runs by title and status words");
  }

  console.log("app nav (mold_v0-340): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
