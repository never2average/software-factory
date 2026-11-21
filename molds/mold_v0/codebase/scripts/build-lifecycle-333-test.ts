// A truthful build and deployment lifecycle (mold_v0-333), offline: an embedded database, a fake sign-in, a neutral
// fixture pack declared here (applications, builds, deployments), the agent harness on with no runner (a session's
// first wake stays queued). Run by `npm run test:build-lifecycle`.
//   1. Refused at build: creates on another kind, its area, link, fields and states; stops_session without to; a clock
//      step that moves without a lifecycle state or a transition; supersedes without its transition; failed_stage on a
//      list field; a related column's sort and where; mode current with by_time; an onboarding where off a record step.
//   2. Start build makes the build (queued, linked, the session, the person, the time) as the session starts, and the
//      agent's first message names its key; the session keeps the link in its policy; a refused start leaves no build.
//   3. Cancel stops the session (a move with stops_session) and the session's late move is ignored, never a 409.
//   4. Close-out by why the session ended: failed (its error written, its deployment still BUILDING made CANCELED),
//      finished, crash, policy, budget (a declined raise); once only; a build the agent finished is left as it is; the
//      sweep settles one a lost reconcile missed.
//   5. A clock step moves a running build past its limit to timed_out (history: the clock), once, and leaves a build
//      that moved on alone.
//   6. Steps: a failed record shows where it stopped (failed_stage, else the last state it entered), drawn as reached,
//      stopped here and not reached; the page answers the state times.
//   7. Superseded: a new READY deployment of an application moves the one before to SUPERSEDED (another application's
//      stays); a derived pointer (the serving deployment) as a fact and a list column; a list column's sort and where.
//   8. A metric card in mode current: today's count, no sparkline.
//   9. An onboarding step done only when a deployment is READY, not when any exists.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
const ok = (m: string) => console.log(`✓ ${m}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// The console's modules by path (as scripts/record-pages-test.ts loads them): the server's typecheck never reads web/.
const web = (rel: string) => import(pathToFileURL(path.join(ROOT, "web", "src", rel)).href);

const states = (xs: string[]) => xs.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1).toLowerCase().replace("_", " ") }));
const BUILD_STATES = ["queued", "running", "deploying", "succeeded", "failed", "cancelled", "timed_out"];
const PACK = {
  id: "fixture_lifecycle", name: "Fixture lifecycle", version: "0.1.0",
  record_areas: [
    { name: "fx_apps", label: "Applications", role: "check", scope: "workspace", fields: [{ name: "summary", label: "Summary", type: "text" }],
      detail: {
        header: { facts: [
          { label: "Serving", computed: { area: "fx_deploys", via: "app", op: "latest", where: { field: "state", equals: "READY" } } },
          { label: "Last build", computed: { area: "fx_builds", via: "app", op: "latest", field: "status", sort: { field: "started", direction: "desc" } } },
        ] },
        tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["summary"] }] }],
        actions: [{ kind: "start_agent", place: "primary", label: "Start build", profile: "default", first_message: "Build {{title}}. Your build record is {{created_key}}.",
          creates: { area: "fx_builds", link: "app", title: "{{title}} build", fields: { session: "$session", requested_by: "$person", started: "$now", summary: "summary" },
            on_session_end: { failed: "failed", crash: "failed", policy: "failed", budget: "failed", finished: "failed", stopped: "cancelled" }, reason_field: "error",
            children: [{ area: "fx_deploys", via: "build", from: ["BUILDING"], to: "CANCELED" }] } }] } },
    { name: "fx_builds", label: "Builds", role: "check", scope: "workspace",
      fields: [{ name: "status", label: "Status", type: "enum", options: states(BUILD_STATES) }, { name: "app", label: "Application", type: "reference", to: "fx_apps" },
        { name: "session", label: "Session", type: "text", set_by: "action" }, { name: "requested_by", label: "Requested by", type: "person", set_by: "action" },
        { name: "started", label: "Started", type: "date" }, { name: "summary", label: "Summary", type: "text" }, { name: "error", label: "Error", type: "text" },
        { name: "failed_stage", label: "Failed at", type: "enum", options: states(["queued", "running", "deploying", "succeeded"]) }],
      lifecycle: { field: "status", initial: "queued", transitions: [
        { from: ["queued"], to: "running" }, { from: ["running"], to: "deploying" }, { from: ["deploying"], to: "succeeded" },
        { from: ["queued", "running", "deploying"], to: "failed" }, { from: ["queued", "running", "deploying"], to: "cancelled", roles: ["member", "owner"] }, { from: ["queued", "running", "deploying"], to: "timed_out" }] },
      clocks: [{ name: "build_limit", label: "Time limit", starts: { event: "entered", state: "running" }, after: "90m", stops_when: { field: "status", in: ["succeeded", "failed", "cancelled", "timed_out"] },
        escalate: [{ after: "0m", label: "Timed out", move_to: "timed_out", move_from: ["running", "deploying"] }] }],
      detail: { tabs: [{ label: "Overview", sections: [{ title: "Progress", steps: { field: "status", states: ["queued", "running", "deploying", "succeeded"], failed_stage: "failed_stage" } }] }],
        actions: [{ kind: "move", to: "cancelled", label: "Cancel", stops_session: true, confirm: "Cancel this build and stop its agent session?" }] } },
    { name: "fx_deploys", label: "Deployments", role: "check", scope: "workspace",
      fields: [{ name: "state", label: "State", type: "enum", options: states(["BUILDING", "READY", "ERROR", "CANCELED", "SUPERSEDED"]) },
        { name: "app", label: "Application", type: "reference", to: "fx_apps" }, { name: "build", label: "Build", type: "reference", to: "fx_builds" }],
      lifecycle: { field: "state", initial: "BUILDING", transitions: [{ from: ["BUILDING"], to: "READY" }, { from: ["BUILDING"], to: "ERROR" }, { from: ["BUILDING"], to: "CANCELED" }, { from: ["READY"], to: "SUPERSEDED" }],
        supersedes: { scope_fields: ["app"], when_enters: "READY", previous_to: "SUPERSEDED" } } },
  ],
  metrics: [
    { name: "fx_live", label: "Live deployments", over: "fx_deploys", where: [{ field: "state", op: "eq", value: "READY" }], mode: "current" },
    { name: "fx_deploys_total", label: "Deployments", over: "fx_deploys" },
  ],
  tabs: [{ id: "apps", kind: "area", area: "fx_apps", icon: "rocket", group: "Build", charts: [], views: ["table"], sparklines: ["fx_live", "fx_deploys_total"],
    columns: ["summary", { related: { area: "fx_builds", via: "app" }, show: "latest:status", sort: { field: "started", direction: "desc" }, label: "Last build" },
      { related: { area: "fx_deploys", via: "app" }, show: "latest", where: { field: "state", equals: "READY" }, label: "Serving", id: "serving" }] }],
  onboarding: [{ id: "first_live", label: "First app live", done_when: "record:fx_deploys", where: { field: "state", in: ["READY"] } }],
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
  const S = await import("../src/session-records.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const kv = await import("../src/keyvault.js");
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_lifecycle", name: "Fixture lifecycle", version: "0.1.0", entry: null, migrations: null, words: {}, dir: ROOT }, declared: compileDeclarations(j) } as never]);

  // ---------- 1. refused at build ----------
  {
    const area = (i: number, edit: (a: any) => void) => { const a = clone(PACK.record_areas[i]); edit(a); return P.RecordAreaSchema.safeParse(a); };
    const says = (r: { success: boolean; error?: { issues: { message: string }[] } }, re: RegExp, what: string) => {
      assert.equal(r.success, false, `${what}: refused`);
      assert.ok(r.error!.issues.some((x) => re.test(x.message)), `${what}: ${r.error!.issues.map((x) => x.message).join(" | ")}`);
    };
    for (const i of [0, 1, 2]) assert.equal(P.RecordAreaSchema.safeParse(PACK.record_areas[i]).success, true, `area ${i} is valid: ${JSON.stringify(P.RecordAreaSchema.safeParse(PACK.record_areas[i]).error?.issues)}`);
    says(area(1, (a) => { a.detail.actions[0].stops_session = true; delete a.detail.actions[0].to; }), /names the state it moves to/, "stops_session without to");
    says(area(1, (a) => { a.detail.actions.push({ kind: "copy_link", stops_session: true }); }), /stops_session is for a move action/, "stops_session on a copy");
    says(area(0, (a) => { a.detail.actions.push({ kind: "copy_link", creates: { area: "fx_builds" } }); }), /creates is for a start_agent action/, "creates on a copy");
    says(area(0, (a) => { a.detail.actions[0].creates.fields.extra = "nope"; }), /nope is not one of the area's fields/, "creates from a field this record lacks");
    says(area(1, (a) => { a.clocks[0].escalate[0].move_to = "queued"; }), /no transition names running and moves it to queued/, "a clock step with no transition");
    says(area(1, (a) => { a.clocks[0].starts = { event: "created" }; }), /started by entering a state/, "a moving clock not started by a state");
    says(area(2, (a) => { a.lifecycle.transitions.pop(); }), /no transition moves READY to SUPERSEDED/, "supersedes without its transition");
    says(area(2, (a) => { a.lifecycle.supersedes.scope_fields = ["state"]; }), /cannot scope a replacement/, "supersedes scoped by the lifecycle's field");
    says(area(2, (a) => { a.lifecycle.supersedes.when_enters = "BUILDING"; a.lifecycle.transitions.push({ from: ["BUILDING"], to: "SUPERSEDED" }); }), /not its initial state/, "supersedes on entering the initial state");
    says(area(2, (a) => { a.lifecycle.transitions = a.lifecycle.transitions.filter((t: any) => t.to !== "SUPERSEDED"); a.lifecycle.transitions.push({ from: "*", to: "SUPERSEDED" }); }), /no transition moves READY to SUPERSEDED/, "a \"*\" transition is not the shell's");
    says(area(1, (a) => { delete a.lifecycle.transitions[4].roles; }), /give every transition to cancelled its roles/, "stops_session over a transition with no roles");
    says(area(1, (a) => { a.clocks[0].escalate[0].move_from = ["succeeded", "running"]; }), /no transition names succeeded and moves it to timed_out/, "move_from a state with no transition");
    says(area(1, (a) => { a.detail.tabs[0].sections[0].steps.failed_stage = "app"; }), /failed_stage names an enum or text field/, "failed_stage on a reference");
    assert.match(P.MetricSchema.safeParse({ name: "fx_m", label: "M", over: "fx_deploys", mode: "current", by_time: { at: "created", every: "week" } }).error?.issues[0]?.message ?? "", /mode "current" is for a count or a sum of now/);
    assert.equal(P.CLOCK_DURATION.test("90m"), true, "minutes are a clock duration");
    // Across areas: what creates names elsewhere.
    const parsed = PACK.record_areas.map((a) => ({ ...P.RecordAreaSchema.parse(a), pack: "fixture_lifecycle" }));
    assert.deepEqual(P.detailBuildProblems(parsed as never, []), [], "the fixture's cross-area declarations hold");
    const bent = clone(parsed) as any[];
    bent[0].detail.actions[0].creates.link = "summary";
    bent[0].detail.actions[0].creates.on_session_end.failed = "nowhere";
    bent[0].detail.actions[0].creates.children[0].via = "app";
    bent[0].detail.actions[0].creates.fields.status = "$key";
    bent[0].detail.actions[0].creates.fields.session = "summary";
    const probs = P.detailBuildProblems(bent as never, []).join("\n");
    for (const re of [/link summary is not a reference or link field of fx_builds to fx_apps/, /on_session_end.failed: nowhere is not a state/, /via app is not a reference or link field of fx_deploys to fx_builds/, /field status is fx_builds's lifecycle field/, /field session is set by the app's own actions/])
      assert.match(probs, re);
    const sealed = clone(parsed) as any[];
    sealed[1].append_only = true; sealed[1].sealed = true;
    assert.match(P.detailBuildProblems(sealed as never, []).join("\n"), /fx_builds is append-only[\s\S]*fx_builds is sealed/, "creates into an append-only or sealed area");
    // A related column's sort and where; an onboarding where only on a record step.
    install(PACK);
    const { checkViews } = await import("../src/metric-spec.js");
    const { buildViews } = await import("../src/metrics.js");
    assert.deepEqual(checkViews(buildViews()), [], "the fixture's tabs, columns and metrics hold");
    const badCol = clone(PACK) as any;
    badCol.tabs[0].columns[1].sort.field = "nope"; badCol.tabs[0].columns[2].where.field = "nope";
    assert.throws(() => install(badCol), (e: Error) => /sort nope is not one of fx_builds's fields/.test(e.message) && /rel_serving: where: nope/.test(e.message));
    const badStep = clone(PACK) as any;
    badStep.onboarding[0].done_when = "workspace";
    assert.throws(() => P.validatePack(compileDeclarations(badStep) as never), /where is for a record:<area> step/);
    const badVal = clone(PACK) as any;
    badVal.onboarding[0].where.in = ["LIVE"];
    assert.throws(() => P.validatePack(compileDeclarations(badVal) as never), /LIVE is not one of state's options/);
    install(PACK);
    ok("refused at build: creates on another kind, from a field this record lacks, its link, a lifecycle field, an unknown state, a child's via; stops_session without to; a clock step with no transition or not started by a state; supersedes without its transition or by the lifecycle's field; failed_stage on a reference; a related column's sort and where; mode current with by_time; an onboarding where off a record step or with a value not an option");
  }

  // ---------- the world ----------
  F.setFeaturesForTest({ record_pages: true, agent_harness: true, scheduled_alerts: true });
  await saveSettingValues("test-staff", { AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  await kv.setCredential("anthropic", `sk-default-${STAMP}-0123456789`, { label: "default", priority: 0 });
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const W = (await createOrg(`Lifecycle ${STAMP}`)).org, W2 = (await createOrg(`Lifecycle two ${STAMP}`)).org;
  const own = await http.signInAs(W, "owner"), own2 = await http.signInAs(W2, "owner");
  const h = (t: string) => ({ authorization: `Bearer ${t}`, "x-pack-request": "1" });
  const app = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rec = ra.workspaceRecords("fixture_lifecycle", W.orgId);
  await ra.asWriter({ by: "people", id: own.userId }, async () => {
    await rec.put("fx_apps", "shop", { title: "Shop", data: { summary: "An online shop" } });
    await rec.put("fx_apps", "blog", { title: "Blog", data: { summary: "A blog" } });
  });
  const press = async (key = "shop") => {
    const p = await app(own.token, "GET", `/api/records/_page/fx_apps/${key}`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const a = p.body.actions.find((x: { kind: string }) => x.kind === "start_agent");
    assert.equal(a.agent.message, `Build ${key === "shop" ? "Shop" : "Blog"}. Your build record is (given when it starts).`, "the preview says the record's key comes when it starts");
    const r = await app(own.token, "POST", `/api/records/_page/fx_apps/${key}/actions/${a.id}`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { session: r.body.session, build: r.body.created.key as string };
  };
  const build = (k: string) => ra.getFor(W.orgId, "fx_builds", k);
  const session = (id: string) => H.read((q) => H.rowOf(q, W.orgId, id));
  const by = async (area: string, key: string) => (await db.query<{ updated_by: string }>("SELECT updated_by FROM workspace_records WHERE org_id = $1 AND area = $2 AND key = $3", [W.orgId, area, key]))[0]?.updated_by;
  const end = (id: string, state: "stopped" | "failed", reason: string) => H.tx(async (q) => H.endSession(q, await H.rowOf(q, W.orgId, id, true), state, reason));

  // ---------- 2. Start build makes the build ----------
  let first: { session: any; build: string };
  {
    const before = Date.now();
    first = await press();
    const b = await build(first.build);
    assert.ok(b, "the build exists as soon as the session does");
    assert.deepEqual([b!.title, b!.data.status, b!.data.app, b!.data.session, b!.data.requested_by, b!.data.summary], ["Shop build", "queued", "shop", first.session.id, own.userId, "An online shop"],
      "queued, linked to the application, the session and the person who pressed, its summary from the application");
    assert.ok(Date.parse(String(b!.data.started)) >= before - 1000, "started: the time it was pressed");
    assert.equal(first.session.messages.find((m: { role: string }) => m.role === "person").body, `Build Shop. Your build record is ${first.build}.`, "the agent is told the build's key");
    const s = await session(first.session.id);
    assert.deepEqual([s.record_area, s.record_key, (s.policy as any).creates.area, (s.policy as any).creates.key], ["fx_apps", "shop", "fx_builds", first.build], "the session links both records");
    ok("Start build makes the build (queued, linked to the application and the session, the person and the time) as the session starts; the agent's first message names its key; the session keeps the link");
  }

  // ---------- 3. Cancel stops the session; its late move is ignored ----------
  {
    await rec.put("fx_deploys", "c-building", { title: "Cancelled build's deploy", data: { app: "blog", build: first.build } });
    const p = await app(own.token, "GET", `/api/records/_page/fx_builds/${first.build}`);
    const cancel = p.body.actions.find((x: { kind: string }) => x.kind === "move");
    const r = await app(own.token, "POST", `/api/records/_page/fx_builds/${first.build}/actions/${cancel.id}`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stopped_sessions, 1, "the build's session is stopped");
    assert.equal((await build(first.build))!.data.status, "cancelled");
    const s = await session(first.session.id);
    assert.equal(s.state, "stopped", "Cancel cancels: the session ended");
    assert.equal((s.policy as any).creates.closed.reason, "stopped", "settled once: nothing left to move");
    assert.equal((await ra.getFor(W.orgId, "fx_deploys", "c-building"))!.data.state, "CANCELED", "its deployment still building is cancelled with it");
    const [wake] = await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 AND harness_session_id = $2 LIMIT 1", [W.orgId, first.session.id]);
    assert.ok(wake, "the stopped session's wake");
    // The session's late final move (its agent did not hear yet): ignored, said in the log.
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    const late = await ra.asVia(`run:${wake!.id}`, () => rec.move("fx_builds", first.build, "succeeded")).finally(() => { console.log = orig; });
    assert.equal(late.data.status, "cancelled", "the late move changes nothing");
    assert.ok(logged.some((l) => /ignored: the record was moved to "cancelled"/.test(l)), "and says so in the log");
    await assert.rejects(rec.move("fx_builds", first.build, "succeeded"), /cannot move from "cancelled"/, "a person's move is still refused");
    await assert.rejects(ra.asVia("run:another-run", () => rec.move("fx_builds", first.build, "succeeded")), /cannot move from "cancelled"/, "and so is another run's: only the stopped session's moves are ignored");
    ok("Cancel (a move with stops_session) stops the build's session; the session's late final move is ignored with a log line, a person's is still refused");
  }

  // ---------- 4. close-out by why the session ended ----------
  {
    const failed = await press();
    await ra.asWriter({ by: "run", id: "agent" }, async () => {
      await rec.move("fx_builds", failed.build, "running");
      await rec.put("fx_deploys", "d-building", { title: "Shop deploy", data: { app: "shop", build: failed.build } });
      await rec.put("fx_deploys", "d-error", { title: "Shop deploy 2", data: { app: "shop", build: failed.build } });
      await rec.move("fx_deploys", "d-error", "ERROR");
    });
    await end(failed.session.id, "failed", "the harness failed");
    const got = await S.settleCreated(W.orgId, failed.session.id);
    assert.deepEqual(got, { reason: "failed", moved_to: "failed", children: 1 });
    const fb = await build(failed.build);
    assert.deepEqual([fb!.data.status, fb!.data.error], ["failed", S.REASON_WORDS.failed], "moved to failed, why written");
    assert.equal(await by("fx_builds", failed.build), "shell:session", "by the shell, for the session");
    assert.equal((await ra.getFor(W.orgId, "fx_deploys", "d-building"))!.data.state, "CANCELED", "its deployment still building: cancelled");
    assert.equal((await ra.getFor(W.orgId, "fx_deploys", "d-error"))!.data.state, "ERROR", "one already ended stays");
    assert.equal(await S.settleCreated(W.orgId, failed.session.id), null, "once only");

    // finished (the session ended its turn, the build left running), crash, policy.
    for (const [state, reason, want] of [["stopped", "done", "finished"], ["failed", "crashed 4 times in a row: the wake stopped", "crash"], ["failed", "policy: blocked", "policy"]] as const) {
      const x = await press();
      await rec.move("fx_builds", x.build, "running");
      await end(x.session.id, state, reason);
      await H.settleRecord(W.orgId, x.session.id);
      const b = await build(x.build);
      assert.deepEqual([b!.data.status, b!.data.error, ((await session(x.session.id)).policy as any).creates.closed.reason], ["failed", S.REASON_WORDS[want], want], `${want}: closed out`);
    }
    // A build the agent finished is left as it is.
    const done = await press();
    for (const to of ["running", "deploying", "succeeded"]) await rec.move("fx_builds", done.build, to);
    await end(done.session.id, "stopped", "done");
    assert.deepEqual(await S.settleCreated(W.orgId, done.session.id), { reason: "finished", moved_to: null, children: 0 });
    assert.equal((await build(done.build))!.data.status, "succeeded", "a finished build stays succeeded");
    // budget: its raise declined, nothing running; and a lost reconcile settled by the sweep.
    const broke = await press();
    await db.query("UPDATE harness_sessions SET state = 'parked', current_run_id = NULL WHERE id = $1 AND org_id = $2", [broke.session.id, W.orgId]);
    await db.query("INSERT INTO harness_session_requests (id, session_id, org_id, run_id, kind, subject, detail, status) VALUES ($1, $2, $3, NULL, 'budget', '$1.00', '{}', 'declined')", [H.newId("hsr"), broke.session.id, W.orgId]);
    const lost = await press();
    await end(lost.session.id, "stopped", "stopped");
    const swept = await S.settleEnded();
    assert.ok(swept >= 2, `the sweep settled both (${swept})`);
    assert.equal((await build(broke.build))!.data.status, "failed", "budget refused: failed");
    assert.equal((await build(broke.build))!.data.error, S.REASON_WORDS.budget);
    assert.equal((await build(lost.build))!.data.status, "cancelled", "a stopped session's build cancelled by the sweep");
    // A close-out whose move failed (done: false) is tried again by the sweep, never left claimed.
    const retry = await press();
    await rec.move("fx_builds", retry.build, "running");
    await end(retry.session.id, "failed", "the harness failed");
    await db.query(`UPDATE harness_sessions SET policy = jsonb_set(policy, '{creates,closed}', '{"reason": "failed", "at": "2026-11-21T00:00:00Z", "moved_to": null, "done": false, "tries": 1}'::jsonb) WHERE id = $1 AND org_id = $2`, [retry.session.id, W.orgId]);
    await S.settleEnded();
    const rs = (await session(retry.session.id)).policy as any;
    assert.deepEqual([(await build(retry.build))!.data.status, rs.creates.closed.done, rs.creates.closed.tries], ["failed", true, 2], "a failed close-out is tried again by the sweep");
    // Pure: the end reasons.
    assert.equal(S.endReasonOf({ state: "failed", state_reason: "approval_timeout: x", current_run_id: null }), "policy");
    assert.equal(S.endReasonOf({ state: "parked", state_reason: null, current_run_id: null }), null, "parked is not an end");
    assert.equal(S.endReasonOf({ state: "parked", state_reason: null, current_run_id: "r" }, true), null, "a budget refused while a wake still runs is not yet");
    ok("close-out by why the session ended: failed (its error written, its deployment still BUILDING made CANCELED, an ended one left), finished, crash, policy and budget all to failed with their words, stopped to cancelled; once only; a build the agent finished is left; the sweep settles what a lost reconcile missed");
  }

  // ---------- 5. a clock step moves a running build past its limit ----------
  {
    const rc = await import("../src/record-clocks.js");
    const x = await press();
    await rec.move("fx_builds", x.build, "running");
    const y = await press();
    for (const to of ["running", "deploying", "succeeded"]) await rec.move("fx_builds", y.build, to);
    const z = await press();
    await rec.move("fx_builds", z.build, "running"); await rec.move("fx_builds", z.build, "deploying");
    await rec.put("fx_deploys", "z-building", { title: "Timed-out build's deploy", data: { app: "blog", build: z.build } });
    const later = new Date(Date.now() + 2 * 3600_000);
    await rc.clockCheck(later, { force: true, orgId: W.orgId });
    assert.equal((await build(x.build))!.data.status, "timed_out", "running past 90 minutes: timed out");
    assert.equal((await build(z.build))!.data.status, "timed_out", "deploying is covered too (move_from)");
    assert.equal((await build(y.build))!.data.status, "succeeded", "one that finished is left alone");
    assert.equal((await ra.getFor(W.orgId, "fx_deploys", "z-building"))!.data.state, "CANCELED", "a timed-out build's deployment still building is cancelled with it");
    const ev = await db.query<{ step: string; detail: any }>("SELECT step, detail FROM workspace_clock_events WHERE org_id = $1 AND record_key = $2 AND step LIKE 'escalate%' ORDER BY step", [W.orgId, x.build]);
    assert.deepEqual(ev.map((e) => [e.step, e.detail.move_to ?? null, e.detail.moved?.to ?? null]), [["escalate:0", "timed_out", null], ["escalate:0:moved", null, "timed_out"]], "the step says what it meant; its own event that it moved");
    await rc.clockCheck(new Date(later.getTime() + 60_000), { force: true, orgId: W.orgId });
    assert.equal((await db.query("SELECT 1 FROM workspace_clock_events WHERE org_id = $1 AND record_key = $2 AND step LIKE 'escalate%'", [W.orgId, x.build])).length, 2, "never again");
    assert.equal(await by("fx_builds", x.build), "shell:clock", "the record's last writer is the clock");
    assert.equal(rc.stepWords(ra.findArea("fx_builds")!, "build_limit", "escalate:0", { moved: { to: "timed_out" } }), "Timed out; moved to Timed out");
    ok("a clock step moves a running build past its 90-minute limit to timed_out, recorded once with its move (its history names the clock); deploying too (move_from), its BUILDING deployment cancelled; a build that finished is left alone");
  }

  // ---------- 6. steps show where a failed record stopped ----------
  {
    const L = await web("features/records/detail-layout.ts");
    const path_ = ["queued", "running", "deploying", "succeeded"];
    assert.deepEqual(L.stepRows(path_, "failed", { stage: "deploying" }).steps.map((s: { state: string }) => s.state), ["done", "done", "failed", "todo"], "failed_stage: reached, stopped here, not reached");
    const at = { queued: "2026-11-01T10:00:00Z", running: "2026-11-01T10:01:00Z", failed: "2026-11-01T10:05:00Z" };
    const r = L.stepRows(path_, "failed", { stateAt: at });
    assert.deepEqual([r.steps.map((s: { state: string }) => s.state), r.off, r.stopped], [["done", "failed", "todo", "todo"], "failed", "running"], "without a stage: the last state it entered before it left the path");
    assert.deepEqual(L.stepRows(path_, "failed").steps.map((s: { state: string }) => s.state), ["todo", "todo", "todo", "todo"], "a record from before: as before");
    assert.deepEqual(L.stepRows(path_, "running", { stateAt: at }).steps.map((s: { state: string }) => s.state), ["done", "now", "todo", "todo"], "on the path: as before");
    const failed = (await ra.listFor(W.orgId, "fx_builds", { filter: { status: "failed" }, limit: 1 })).records[0]!;
    const p = await app(own.token, "GET", `/api/records/_page/fx_builds/${failed.key}`);
    assert.ok(p.body.state_at?.queued && p.body.state_at?.failed, `the page answers when it entered each state: ${JSON.stringify(p.body.state_at)}`);
    ok("steps: a failed build shows where it stopped (its failed_stage, else the last state it entered before it left the path) as reached, stopped here and not reached; the page answers the state times; on the path and from before as before");
  }

  // ---------- 7. superseded, the serving pointer, sort and where ----------
  {
    const put = (k: string, app_: string) => rec.put("fx_deploys", k, { title: `Deploy ${k}`, data: { app: app_ } });
    await put("p1", "shop"); await rec.move("fx_deploys", "p1", "READY");
    await put("b1", "blog"); await rec.move("fx_deploys", "b1", "READY");
    await put("p2", "shop"); await rec.move("fx_deploys", "p2", "READY");
    const st = async (k: string) => (await ra.getFor(W.orgId, "fx_deploys", k))!.data.state;
    assert.deepEqual([await st("p1"), await st("p2"), await st("b1")], ["SUPERSEDED", "READY", "READY"], "the newer READY of the same application replaces the one before; another application's stays");
    const live = (await ra.listFor(W.orgId, "fx_deploys", { filter: { state: "READY" }, limit: 50 })).records.map((r) => r.key).sort();
    assert.deepEqual(live, ["b1", "p2"], "one serving deployment per application");
    assert.equal(await by("fx_deploys", "p1"), "shell:supersede", "the replaced one moved by the shell");
    const p = await app(own.token, "GET", "/api/records/_page/fx_apps/shop");
    assert.deepEqual([p.body.facts["0"].value, p.body.facts["0"].field, p.body.facts["0"].record.key], ["Deploy p2", null, "p2"], "Serving: a derived pointer to the serving deployment");
    // The list's columns: the last build by started (not by last change) and the serving deployment.
    const builds = (await ra.listFor(W.orgId, "fx_builds", { filter: { app: "shop" }, sort: "-started", limit: 1 })).records[0]!;
    const oldest = (await ra.listFor(W.orgId, "fx_builds", { filter: { app: "shop" }, sort: "started", limit: 1 })).records[0]!;
    await rec.update("fx_builds", oldest.key, { title: oldest.title, data: { ...oldest.data, summary: "edited late" } });
    const cols = await app(own.token, "GET", "/api/records/_page/_columns/fixture_lifecycle/apps?keys=shop,blog");
    assert.equal(cols.status, 200, JSON.stringify(cols.body));
    assert.equal(cols.body.columns.rel_fx_builds_latest_status.shop, builds.data.status, "Last build: by started, a late edit to an old build does not flip it");
    assert.deepEqual(cols.body.columns.rel_serving, { shop: { key: "p2", title: "Deploy p2" }, blog: { key: "b1", title: "Deploy b1" } }, "Serving: the pointer per row");
    assert.equal((await app(own2.token, "GET", "/api/records/_page/_columns/fixture_lifecycle/apps?keys=shop")).body.columns.rel_serving.shop, null, "another workspace's never");
    ok("superseded: a new READY deployment moves the one before it of the same application to SUPERSEDED (another application's stays); the serving deployment as a derived pointer (a fact and a list column); a list column's sort (last build by started) and where (READY)");
  }

  // ---------- 8. a metric card in mode current ----------
  {
    const { computeSparklines } = await import("../src/sparklines.js");
    const { buildViews } = await import("../src/metrics.js");
    const tab = buildViews().tabs.find((t) => t.id === "apps")!;
    const s = await computeSparklines(W.orgId, tab, { role: "owner", userId: own.userId });
    const c = s.cards.find((x) => x.id === "fx_live")!, t = s.cards.find((x) => x.id === "fx_deploys_total")!;
    assert.deepEqual([c.mode, c.value, c.series], ["current", 2, []], "Live deployments: what serves now, no running total");
    assert.equal(t.mode, "total", "an undeclared card as before");
    const words = await web("features/tabs/spark-words.ts");
    assert.equal(words.trendWords({ series: [], unit: "count", mode: "current" }, 12, (v: number | null) => String(v)), "As of now.");
    ok("a metric card in mode current shows today's count (the two serving deployments) with no sparkline; another card as before");
  }

  // ---------- 9. onboarding done only when a deployment is READY ----------
  {
    const { onboardingFor } = await import("../src/onboarding.js");
    const W3 = (await createOrg(`Lifecycle three ${STAMP}`)).org;
    const r3 = ra.workspaceRecords("fixture_lifecycle", W3.orgId);
    await r3.put("fx_apps", "one", { title: "One", data: {} });
    await r3.put("fx_deploys", "x", { title: "X", data: { app: "one" } });
    const step = async () => (await onboardingFor(W3.orgId)).steps.find((s) => s.id === "first_live")!;
    assert.equal((await step()).done, false, "a deployment still building is no first live app");
    await r3.move("fx_deploys", "x", "ERROR").catch(() => null);
    await r3.put("fx_deploys", "y", { title: "Y", data: { app: "one" } });
    await r3.move("fx_deploys", "y", "READY");
    const s = await step();
    assert.equal(s.done, true, "done once one is READY");
    assert.ok(s.at && Date.parse(s.at) > 0, "from when it entered READY");
    ok("an onboarding step done only once a deployment is READY (not when any exists), from when it entered that state");
  }

  F.setFeaturesForTest(null);
  await http.close();
  console.log("build lifecycle: all checks passed");
} finally {
  cleanup();
}
process.exit(0);
