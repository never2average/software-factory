// One at a time, one per parent, two hops, time limits that stop the agent, numbered titles, moves named from where
// the record is, a sort by state time, rules in words (mold_v0-337), offline: an embedded database, a fake sign-in, a
// neutral fixture pack declared here (apps, environments, builds, deployments, members), the agent harness on with no
// runner (a session's first wake stays queued). Run by `npm run test:apps-ui`.
//   1. Refused at build: an unavailable entry with both a condition and related (or neither), related through a field
//      that does not point here; to_any beside to, to_any naming a state no transition reaches, label_from_move on an
//      edit; {{$n}} without a link, an unknown {{$x}}; a clock's stops_session without move_to; a unique rule on a
//      field the area lacks, within itself, on a shared or sealed area; a hop whose via does not point back; $state_at
//      on an area without a lifecycle (in a pack, and as a query's sort).
//   2. One build at a time (15): Start build is disabled with its reason while a build of the app is queued, running or
//      deploying, refused on the server (409) when pressed anyway, open again once it ended; two presses at the same
//      moment leave one open build.
//   3. Numbered titles (19): each build made from an app is "<app> build <n> · <day>", counted per app.
//   4. A time limit that stops the agent (18): the clock moves a running build to timed_out and stops the session that
//      made it (an ":stopped" event), and that session's late move is ignored; a step without stops_session leaves it.
//   5. One per parent (16): a second Default environment of an app is refused on save, naming the other one (a create,
//      an edit); another app's Default, an Additional one and an unchanged edit save.
//   6. Two hops (17): the app's Serving is what its DEFAULT environment serves (a fact and a list column), never a
//      Staging deployment that is newer; a role that may not read the hop's area does not see it.
//   7. Moves named from where the record is (20): a suspended member's move reads Resume, a pending one's Mark live
//      (both to active); to_any keeps Remove out of the menu; label_from_move names the button.
//   8. Sort by state time (21): Last deploy (latest by $state_at) is the BUILDING deployment made after the READY one,
//      where by deployed_at it is the READY one; the memory engine orders the same way.
//   9. Rules in words (23): JsonLogic's common operators read in words, an unknown one shown as its JSON; a table cell
//      and a json field read them.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
const ok = (m: string) => console.log(`✓ ${m}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const web = (rel: string) => import(pathToFileURL(path.join(ROOT, "web", "src", rel)).href);

const states = (xs: string[]) => xs.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1).toLowerCase().replace("_", " ") }));
const BUILD_STATES = ["queued", "running", "deploying", "succeeded", "failed", "cancelled", "timed_out"];
const OPEN = ["queued", "running", "deploying"];
const PACK = {
  id: "fixture_apps_ui", name: "Fixture apps UI", version: "0.1.0",
  record_areas: [
    { name: "ux_apps", label: "Applications", role: "check", scope: "workspace", fields: [{ name: "summary", label: "Summary", type: "text" }],
      detail: {
        header: { facts: [
          { label: "Serving", computed: { area: "ux_deploys", via: "env", op: "latest", where: { field: "state", equals: "READY" },
            through: { area: "ux_envs", via: "app", where: { field: "is_default", equals: "default" } } } },
          { label: "Last deploy", computed: { area: "ux_deploys", via: "app", op: "latest", sort: { field: "$state_at", direction: "desc" } } },
          { label: "Last deploy by deployed", computed: { area: "ux_deploys", via: "app", op: "latest", sort: { field: "deployed_at", direction: "desc" } } },
        ] },
        tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["summary"] }] }],
        actions: [{ kind: "start_agent", place: "primary", label: "Start build", profile: "default", first_message: "Build {{title}}. Your build record is {{created_key}}.",
          unavailable: [{ related: { area: "ux_builds", via: "app", where: { field: "status", in: OPEN } }, reason: "A build of it is still going: open it, or cancel it first." }],
          creates: { area: "ux_builds", link: "app", title: "{{title}} build {{$n}} · {{$today}}", fields: { session: "$session", started: "$now" },
            on_session_end: { failed: "failed", crash: "failed", policy: "failed", budget: "failed", finished: "failed", stopped: "cancelled" }, reason_field: "error" } }] } },
    { name: "ux_envs", label: "Environments", role: "check", scope: "workspace",
      fields: [{ name: "app", label: "Application", type: "reference", to: "ux_apps" },
        { name: "is_default", label: "Default", type: "enum", options: [{ value: "default", label: "Default" }, { value: "additional", label: "Additional" }] }],
      on_save: [{ unique: { field: "is_default", value: "default", within: ["app"] } }] },
    { name: "ux_builds", label: "Builds", role: "check", scope: "workspace",
      fields: [{ name: "status", label: "Status", type: "enum", options: states(BUILD_STATES) }, { name: "app", label: "Application", type: "reference", to: "ux_apps" },
        { name: "session", label: "Session", type: "text", set_by: "action" }, { name: "started", label: "Started", type: "date" }, { name: "error", label: "Error", type: "text" }],
      lifecycle: { field: "status", initial: "queued", transitions: [
        { from: ["queued"], to: "running" }, { from: ["running"], to: "deploying" }, { from: ["deploying"], to: "succeeded" },
        { from: ["queued", "running", "deploying"], to: "failed" }, { from: ["queued", "running", "deploying"], to: "cancelled", roles: ["member", "owner"] }, { from: ["queued", "running", "deploying"], to: "timed_out" }] },
      clocks: [{ name: "build_limit", label: "Time limit", starts: { event: "entered", state: "running" }, after: "90m", stops_when: { field: "status", in: ["succeeded", "failed", "cancelled", "timed_out"] },
        escalate: [{ after: "0m", label: "Timed out", move_to: "timed_out", move_from: ["running", "deploying"], stops_session: true }] }],
      detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["error"] }] }],
        actions: [{ kind: "move", to: "cancelled", label: "Cancel", stops_session: true }] } },
    { name: "ux_deploys", label: "Deployments", role: "check", scope: "workspace",
      fields: [{ name: "state", label: "State", type: "enum", options: states(["BUILDING", "READY", "ERROR"]) },
        { name: "app", label: "Application", type: "reference", to: "ux_apps" }, { name: "env", label: "Environment", type: "reference", to: "ux_envs" },
        { name: "deployed_at", label: "Deployed", type: "date" }],
      lifecycle: { field: "state", initial: "BUILDING", transitions: [{ from: ["BUILDING"], to: "READY" }, { from: ["BUILDING"], to: "ERROR" }] } },
    { name: "ux_members", label: "Members", role: "check", scope: "workspace", fields: [{ name: "status", label: "Status", type: "enum", options: states(["pending", "active", "suspended", "removed"]) }],
      lifecycle: { field: "status", initial: "pending", transitions: [
        { from: ["pending"], to: "active", label: "Mark live" }, { from: ["active"], to: "suspended", label: "Suspend" }, { from: ["suspended"], to: "active", label: "Resume" },
        { from: ["pending", "active", "suspended"], to: "removed", label: "Remove" }, { from: ["removed"], to: "pending", label: "Add back" }] },
      detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["status"] }] }],
        actions: [{ kind: "move", place: "primary", label: "Change status", to_any: ["active", "suspended", "pending"], label_from_move: true }, { kind: "move", to: "removed", label: "Remove" }] } },
  ],
  tabs: [{ id: "apps", kind: "area", area: "ux_apps", icon: "rocket", group: "Build", charts: [], views: ["table"],
    columns: ["summary", { related: { area: "ux_deploys", via: "env", through: { area: "ux_envs", via: "app", where: { field: "is_default", equals: "default" } } }, show: "latest", where: { field: "state", equals: "READY" }, label: "Serving", id: "serving" },
      { related: { area: "ux_deploys", via: "app" }, show: "latest:state", sort: { field: "$state_at", direction: "desc" }, label: "Last deploy", id: "last_deploy" }] }],
};

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const P = await import("../src/pack-api.js");
  const ra = await import("../src/record-areas.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { createOrg } = await import("../src/auth.js");
  const H = await import("../src/harness-sessions.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const kv = await import("../src/keyvault.js");
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_apps_ui", name: "Fixture apps UI", version: "0.1.0", entry: null, migrations: null, words: {}, dir: ROOT }, declared: compileDeclarations(j) } as never]);

  // ---------- 1. refused at build ----------
  {
    const area = (i: number, edit: (a: any) => void) => { const a = clone(PACK.record_areas[i]); edit(a); return P.RecordAreaSchema.safeParse(a); };
    const says = (r: { success: boolean; error?: { issues: { message: string }[] } }, re: RegExp, what: string) => {
      assert.equal(r.success, false, `${what}: refused`);
      assert.ok(r.error!.issues.some((x) => re.test(x.message)), `${what}: ${r.error!.issues.map((x) => x.message).join(" | ")}`);
    };
    for (const i of PACK.record_areas.keys()) assert.equal(P.RecordAreaSchema.safeParse(PACK.record_areas[i]).success, true, `area ${i}: ${JSON.stringify(P.RecordAreaSchema.safeParse(PACK.record_areas[i]).error?.issues)}`);
    says(area(0, (a) => { a.detail.actions[0].unavailable[0].when = { field: "summary", empty: true }; }), /one of them/, "unavailable with both");
    says(area(0, (a) => { delete a.detail.actions[0].unavailable[0].related; }), /one of them/, "unavailable with neither");
    says(area(4, (a) => { a.detail.actions[0].to = "active"; }), /names one state \(to\) or the states it offers \(to_any\)/, "to_any beside to");
    says(area(4, (a) => { a.detail.actions[0].to_any = ["active", "gone"]; }), /no transition of the lifecycle goes to gone/, "to_any naming an unreachable state");
    says(area(4, (a) => { a.detail.actions.push({ kind: "edit", label_from_move: true }); }), /label_from_move is for a move action/, "label_from_move on an edit");
    says(area(0, (a) => { delete a.detail.actions[0].creates.link; }), /\{\{\$n\}\} counts the records made from this one/, "{{$n}} without a link");
    says(area(0, (a) => { a.detail.actions[0].creates.title = "{{$week}} build"; }), /\{\{\$week\}\} is not one of the area's fields \(a title takes/, "an unknown {{$x}}");
    says(area(2, (a) => { delete a.clocks[0].escalate[0].move_to; delete a.clocks[0].escalate[0].move_from; a.clocks[0].escalate[0].notify = ["owner"]; }), /stops_session is for a step that moves the record/, "stops_session without move_to");
    says(area(1, (a) => { a.on_save[0].unique.field = "nope"; }), /nope is not one of the area's fields/, "unique on a field the area lacks");
    says(area(1, (a) => { a.on_save[0].unique.within = ["is_default"]; }), /within names the fields siblings share/, "unique within itself");
    says(area(1, (a) => { a.on_save[0].unique.value = "primary"; }), /primary is not one of is_default's options/, "unique value not an option");
    says(area(1, (a) => { a.scope = "platform"; }), /a workspace area's rule/, "unique on a shared area");
    says(area(1, (a) => { a.sealed = true; }), /sealed area's values are ciphertext/, "unique on a sealed area");
    const parsed = PACK.record_areas.map((a) => ({ ...P.RecordAreaSchema.parse(a), pack: "fixture_apps_ui" }));
    assert.deepEqual(P.detailBuildProblems(parsed as never, []), [], "the fixture's cross-area declarations hold");
    const bent = clone(parsed) as any[];
    bent[0].detail.header.facts[0].computed.through.via = "summary";
    bent[0].detail.header.facts[0].computed.via = "app";
    bent[0].detail.actions[0].unavailable[0].related.via = "session";
    bent[0].detail.header.facts[2].computed.sort.field = "$state_at";
    delete bent[3].lifecycle;
    const probs = P.detailBuildProblems(bent as never, []).join("\n");
    for (const re of [/through: ux_envs's field summary does not point at ux_apps/, /ux_deploys's field app does not point at ux_envs/, /unavailable\[0\]\.related: ux_builds's field session does not point at ux_apps/, /sort \$state_at is when a record entered its state: ux_deploys has no lifecycle/])
      assert.match(probs, re);
    install(PACK);
    const { checkViews } = await import("../src/metric-spec.js");
    const { buildViews } = await import("../src/metrics.js");
    assert.deepEqual(checkViews(buildViews()), [], "the fixture's tabs and columns hold");
    const badCol = clone(PACK) as any;
    badCol.tabs[0].columns[1].related.through.via = "is_default";
    badCol.tabs[0].columns[2].sort.field = "$state_at";
    badCol.record_areas[3].lifecycle = undefined; badCol.record_areas[0].detail.header.facts.splice(1, 2);
    assert.throws(() => install(badCol), (e: Error) => /rel_serving: through: ux_envs's field is_default does not point at ux_apps/.test(e.message) && /rel_last_deploy: sort \$state_at is when a record entered its state: ux_deploys has no lifecycle/.test(e.message), "a column's hop and its $state_at");
    install(PACK);
    await assert.rejects(ra.listFor(1, "ux_envs", { sort: "-$state_at" }), /sort \$state_at is when a record entered its state: this area has no lifecycle/, "a query's $state_at on an area without a lifecycle");
    ok("refused at build: unavailable with both or neither, related through a field that does not point here; to_any beside to or naming an unreachable state, label_from_move off a move; {{$n}} without a link, an unknown {{$x}}; a clock's stops_session without move_to; a unique rule on a missing field, within itself, not an option, on a shared or sealed area; a hop's via; $state_at without a lifecycle (a pack's fact or column, a query)");
  }

  // ---------- the world ----------
  F.setFeaturesForTest({ record_pages: true, agent_harness: true, scheduled_alerts: true, record_rules: true });
  await saveSettingValues("test-staff", { AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  await kv.setCredential("anthropic", `sk-default-${STAMP}-0123456789`, { label: "default", priority: 0 });
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const W = (await createOrg(`Apps UI ${STAMP}`)).org;
  const own = await http.signInAs(W, "owner");
  const h = (t: string) => ({ authorization: `Bearer ${t}`, "x-pack-request": "1" });
  const app = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rec = ra.workspaceRecords("fixture_apps_ui", W.orgId);
  await ra.asWriter({ by: "people", id: own.userId }, async () => {
    await rec.put("ux_apps", "shop", { title: "Shop", data: { summary: "An online shop" } });
    await rec.put("ux_apps", "blog", { title: "Blog", data: { summary: "A blog" } });
  });
  const startOf = async (key: string) => {
    const p = await app(own.token, "GET", `/api/records/_page/ux_apps/${key}`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return p.body.actions.find((x: { kind: string }) => x.kind === "start_agent");
  };
  const press = async (key = "shop") => {
    const a = await startOf(key);
    const r = await app(own.token, "POST", `/api/records/_page/ux_apps/${key}/actions/${a.id}`, {});
    return { status: r.status, body: r.body, session: r.body.session, build: r.body.created?.key as string };
  };
  const build = (k: string) => ra.getFor(W.orgId, "ux_builds", k);
  const openBuilds = async (appKey: string) => (await ra.listFor(W.orgId, "ux_builds", { filter: { app: appKey }, limit: 50 })).records.filter((r) => OPEN.includes(String(r.data.status)));
  const cancel = async (k: string) => {
    const p = await app(own.token, "GET", `/api/records/_page/ux_builds/${k}`);
    const c = p.body.actions.find((x: { kind: string }) => x.kind === "move");
    const r = await app(own.token, "POST", `/api/records/_page/ux_builds/${k}/actions/${c.id}`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const today = (await import("../src/session-records.js")).titleDay(new Date());

  // ---------- 2. one build at a time; 3. numbered titles ----------
  {
    assert.equal((await startOf("shop")).disabled, null, "no build yet: Start build is open");
    const one = await press();
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const a = await startOf("shop");
    assert.equal(a.disabled, "A build of it is still going: open it, or cancel it first.", "a queued build: disabled, with the pack's reason");
    const again = await app(own.token, "POST", `/api/records/_page/ux_apps/shop/actions/${a.id}`, {});
    assert.deepEqual([again.status, again.body.error], [409, "A build of it is still going: open it, or cancel it first."], "pressed anyway: refused on the server");
    assert.equal((await startOf("blog")).disabled, null, "another app's Start build stays open");
    await rec.move("ux_builds", one.build, "running");
    assert.ok((await startOf("shop")).disabled, "running: still disabled");
    await cancel(one.build);
    assert.equal((await startOf("shop")).disabled, null, "once it ended: open again");
    const two = await press();
    assert.equal(two.status, 200);
    assert.deepEqual([(await build(one.build))!.title, (await build(two.build))!.title], [`Shop build 1 · ${today}`, `Shop build 2 · ${today}`], "numbered per app, with the day");
    await cancel(two.build);
    const blog = await press("blog");
    assert.equal((await build(blog.build))!.title, `Blog build 1 · ${today}`, "counted per app");
    await cancel(blog.build);
    ok("one build at a time: Start build disabled with its reason while a build of the app is queued or running (another app's open), refused on the server when pressed anyway, open again once it ended; numbered titles per app, with the day");
    // Two presses at the same moment: one build stays open, the other press is refused with the reason.
    const both = await Promise.all([press(), press()]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], `two at once: one made, one refused (${JSON.stringify(both.map((x) => x.body))})`);
    assert.equal((await openBuilds("shop")).length, 1, "and one open build");
    const kept = both.find((x) => x.status === 200)!;
    const sessions = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM harness_sessions WHERE org_id = $1 AND record_key = 'shop' AND state NOT IN ('stopped', 'failed')", [W.orgId]);
    assert.equal(sessions[0]!.n, "1", "and one session working on it");
    await cancel(kept.build);
    ok("two presses at the same moment leave one open build and one session; the other is refused with the reason");
  }

  // ---------- 4. a time limit that stops the agent ----------
  {
    const rc = await import("../src/record-clocks.js");
    const x = await press();
    await rec.move("ux_builds", x.build, "running");
    await rc.clockCheck(new Date(Date.now() + 2 * 3600_000), { force: true, orgId: W.orgId });
    assert.equal((await build(x.build))!.data.status, "timed_out", "timed out");
    const s = await H.read((q) => H.rowOf(q, W.orgId, x.session.id));
    assert.ok(["stopped"].includes(s.state) || s.stop_requested_at, `its agent session stopped (${s.state})`);
    assert.deepEqual((s.policy as any).stopped_for, { area: "ux_builds", key: x.build }, "marked as stopped for the build");
    const ev = await db.query<{ step: string; detail: any }>("SELECT step, detail FROM workspace_clock_events WHERE org_id = $1 AND record_key = $2 AND step LIKE 'escalate%' ORDER BY step", [W.orgId, x.build]);
    assert.deepEqual(ev.map((e) => e.step), ["escalate:0", "escalate:0:moved", "escalate:0:stopped"], "the step, its move, the stop");
    const [wake] = await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 AND harness_session_id = $2 LIMIT 1", [W.orgId, x.session.id]);
    const late = await ra.asVia(`run:${wake!.id}`, () => rec.move("ux_builds", x.build, "succeeded"));
    assert.equal(late.data.status, "timed_out", "its late move is ignored");
    // Without stops_session the clock moves the build and leaves the session (as before).
    const plain = clone(PACK) as any;
    delete plain.record_areas[2].clocks[0].escalate[0].stops_session;
    install(plain);
    const y = await press();
    await rec.move("ux_builds", y.build, "running");
    await rc.clockCheck(new Date(Date.now() + 2 * 3600_000), { force: true, orgId: W.orgId });
    const sy = await H.read((q) => H.rowOf(q, W.orgId, y.session.id));
    assert.deepEqual([(await build(y.build))!.data.status, sy.state !== "stopped" && !sy.stop_requested_at], ["timed_out", true], "without stops_session: moved, its session left");
    install(PACK);
    await H.stopSession(W.orgId, y.session.id, H.actorOf({ user: own.userId, email: null, accountRole: "owner" })).catch(() => null);
    ok("a time limit with stops_session moves a running build to timed_out and stops the session that made it (its own event; the session's late move ignored); without it the session is left");
  }

  // ---------- 5. one per parent ----------
  {
    await rec.put("ux_envs", "shop-prod", { title: "Production", data: { app: "shop", is_default: "default" } });
    await assert.rejects(rec.put("ux_envs", "shop-staging", { title: "Staging", data: { app: "shop", is_default: "default" } }),
      (e: Error) => /Environments: "Production" is already Default for this application, and only one may: change it there first\./.test(e.message) && (e as { status?: number }).status === 409, "a second Default of the same app: refused, naming the other");
    await rec.put("ux_envs", "shop-staging", { title: "Staging", data: { app: "shop", is_default: "additional" } });
    await rec.put("ux_envs", "blog-prod", { title: "Blog production", data: { app: "blog", is_default: "default" } });
    await rec.update("ux_envs", "shop-prod", { title: "Production (EU)", data: { app: "shop", is_default: "default" } });
    await assert.rejects(rec.update("ux_envs", "shop-staging", { title: "Staging", data: { app: "shop", is_default: "default" } }), /"Production \(EU\)" is already Default/, "an edit making a second: refused");
    await rec.put("ux_envs", "loose", { title: "Loose", data: { is_default: "default" } });
    await rec.put("ux_envs", "loose2", { title: "Loose 2", data: { is_default: "default" } });
    ok("one per parent: a second Default environment of an app is refused on save naming the other (a create, an edit); an Additional one, another app's Default, an unchanged edit and a record with no app save");
  }

  // ---------- 6. two hops; 8. sort by state time ----------
  {
    const put = (k: string, data: Record<string, unknown>) => rec.put("ux_deploys", k, { title: `Deploy ${k}`, data });
    await put("prod-1", { app: "shop", env: "shop-prod", deployed_at: "2026-11-20" }); await rec.move("ux_deploys", "prod-1", "READY");
    await new Promise((r) => setTimeout(r, 20));
    await put("stage-1", { app: "shop", env: "shop-staging", deployed_at: "2026-11-21" }); await rec.move("ux_deploys", "stage-1", "READY");
    await new Promise((r) => setTimeout(r, 20));
    await put("prod-2", { app: "shop", env: "shop-prod" }); // BUILDING: no deployed_at yet
    const p = await app(own.token, "GET", "/api/records/_page/ux_apps/shop");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.facts["0"].value, p.body.facts["0"].record?.key], ["Deploy prod-1", "prod-1"], "Serving: what the default environment serves, not the newer Staging one");
    assert.equal(p.body.facts["1"].record?.key, "prod-2", "Last deploy by $state_at: the BUILDING one made last");
    assert.equal(p.body.facts["2"].record?.key, "stage-1", "by deployed_at it would be the older READY one");
    const cols = await app(own.token, "GET", "/api/records/_page/_columns/fixture_apps_ui/apps?keys=shop,blog");
    assert.equal(cols.status, 200, JSON.stringify(cols.body));
    assert.deepEqual(cols.body.columns.rel_serving, { shop: { key: "prod-1", title: "Deploy prod-1" }, blog: null }, "the Serving column, through each row's default environment");
    assert.deepEqual(cols.body.columns.rel_last_deploy, { shop: "BUILDING", blog: null }, "the Last deploy column by $state_at");
    // The memory engine (a sealed area's rows) orders the same way.
    const Q = await import("../src/record-query.js");
    const rows = [{ key: "a", updated_at: "2026-11-22T10:00:00Z", data: {}, [Q.ENTERED_AT]: "2026-11-20T00:00:00Z" }, { key: "b", updated_at: "2026-11-01T00:00:00Z", data: {}, [Q.ENTERED_AT]: "2026-11-21T00:00:00Z" }, { key: "c", updated_at: "2026-11-21T12:00:00Z", data: {} }];
    const parsedQ = Q.parseQuery([], { sort: "-$state_at" } as never, () => true, () => true, "state");
    assert.deepEqual(Q.pageInMemory(parsedQ, rows as never).records.map((r) => r.key), ["c", "b", "a"], "memory: by the time it entered its state, else its last change");
    // A role that may not read the hop's area does not see the two-hop fact.
    const viewer = await http.signInAs(W, "viewer");
    const noHop = clone(PACK) as any;
    noHop.record_areas[1].permissions = { read: ["owner"] };
    install(noHop);
    const pv = await app(viewer.token, "GET", "/api/records/_page/ux_apps/shop");
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.deepEqual(pv.body.facts["0"], { hidden: true }, "the hop's area unreadable: the fact is hidden");
    install(PACK);
    ok("two hops: the app's Serving is what its default environment serves (a fact and a list column), never a newer Staging deployment; hidden from a role that may not read the hop; a sort by $state_at counts a BUILDING deployment for Last deploy (SQL and memory)");
  }

  // ---------- 7. moves named from where the record is ----------
  {
    await rec.put("ux_members", "m1", { title: "Member one", data: {} });
    const actions = async () => (await app(own.token, "GET", "/api/records/_page/ux_members/m1")).body.actions as any[];
    let a = await actions();
    assert.deepEqual([a[0].label, a[0].moves.map((m: any) => `${m.to}:${m.label}`)], ["Mark live", ["active:Mark live", "suspended:Suspend", "pending:Add back"]], "pending: the button says Mark live; Remove is not in its menu");
    await rec.move("ux_members", "m1", "active");
    a = await actions();
    assert.equal(a[0].label, "Suspend", "active: Suspend");
    await rec.move("ux_members", "m1", "suspended");
    a = await actions();
    assert.equal(a[0].label, "Resume", "suspended: Resume (not Mark live, the first transition's label to active)");
    assert.equal(a[0].moves.find((m: any) => m.to === "active").label, "Resume", "its move to active reads Resume");
    assert.deepEqual([a[1].label, a[1].disabled], ["Remove", null], "Remove is an action of its own");
    const r = await app(own.token, "POST", `/api/records/_page/ux_members/m1/actions/${a[0].id}`, { to: "removed" });
    assert.equal(r.status, 400, "the button's to_any keeps Remove out");
    await rec.move("ux_members", "m1", "removed");
    a = await actions();
    assert.equal(a[0].label, "Add back", "removed: Add back");
    ok("moves named from where the record is: Resume on a suspended record (not the first transition's Mark live), Mark live on a pending one; to_any keeps Remove out of the button (its own action); label_from_move names the button by the one move open now");
  }

  // ---------- 9. rules in words ----------
  {
    const L = await web("features/records/logic-words.ts");
    const cases: [unknown, string][] = [
      [{ "<": [{ var: "documents" }, 2] }, "documents is less than 2"],
      [{ ">=": [{ var: "vendor.score" }, 70] }, "vendor score is at least 70"],
      [{ "==": [{ var: "status" }, "approved"] }, 'status is "approved"'],
      [{ and: [{ "!": { var: "blocked" } }, { or: [{ "==": [{ var: "tier" }, "gold"] }, { ">": [{ var: "spend" }, 1000] }] }] }, 'blocked is empty and (tier is "gold" or spend is more than 1000)'],
      [{ in: [{ var: "country" }, ["IN", "SG"]] }, 'country is one of "IN", "SG"'],
      [{ "<=": [1, { var: "n" }, 5] }, "n is between 1 and 5 (both included)"],
      [{ if: [{ var: "rush" }, 1, 3] }, "if rush then 1, else 3"],
      [{ missing: ["pan", "gstin"] }, "pan, gstin are missing"],
      [{ "!!": { var: "signed" } }, "signed is set"],
      [{ "<": [{ regex: ["x"] }, 2] }, '{"regex":["x"]} is less than 2'],
    ];
    for (const [v, want] of cases) assert.equal(L.logicWords(v), want, JSON.stringify(v));
    assert.equal(L.logicWords({ regex: ["x"] }), null, "an operator it does not know at the top: not a rule (shown as any other value)");
    assert.equal(L.logicWords({ name: "x" }), null, "an object that is no rule");
    const C = await web("features/records/code-text.ts");
    assert.equal(C.cellText({ "<": [{ var: "documents" }, 2] }), "documents is less than 2", "a table's cell reads it");
    const J = await web("features/records/json-text.ts");
    assert.equal(J.jsonLine([{ id: "two-docs", description: "Two documents", logic: { "<": [{ var: "documents" }, 2] } }]), "two-docs (Two documents, documents is less than 2)", "a json field's line reads it");
    ok("rules in words: JsonLogic's comparisons, and/or/not, in, between, if, missing and set read in words; an unknown part shown as its JSON; a table cell and a json field read them");
  }

  F.setFeaturesForTest(null);
  await http.close();
  console.log("apps ui (mold_v0-337): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
