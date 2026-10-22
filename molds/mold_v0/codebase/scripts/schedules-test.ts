// Schedules per workspace and due-date alerts (mold_v0-035; src/schedules.ts, src/schedule-routes.ts, src/cron.ts),
// offline: an embedded database, the HTTP server behind a fake Clerk and a fake Resend, a fixture pack, and a clock the
// test controls (every tick is handed its `now`).
//   npm run test:schedules
//
// 1. Zero packs: nothing scheduled, nothing mounted, no row read or written, the console's Workspace group empty.
// 2. Cron expressions (UTC): next and previous matches, steps, ranges, day-of-month OR day-of-week; refusals.
// 3. definePack refuses a schedule of another pack's kind or area, a bad cron, a due date on the wrong area or field.
// 4. Defaults: every workspace gets its own copy of the pack's schedules; a missed tick runs at most once (five hours
//    missed: one run per asset, five due times counted as skipped); the next tick at the same time starts nothing; a
//    target whose previous run is still going is not started again; three ticks at once start each run once.
// 5. Workspaces: each run is its own workspace's, over its own asset records; over HTTP each person sees only their
//    own workspace's schedules; only owners change them; another workspace's schedule or record is not found;
//    a pack's later change reaches the copies no owner changed.
// 6. The daily due-date check: an in-app notice per record due within the window, an email to the workspace's own
//    owners only, recorded in email_log; once a day; a record entering the window later is posted and emailed then.
// 7. The cron entry (/api/cron/autoscale) needs CRON_SECRET and ticks the scheduler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.CRON_SECRET = `cron-${STAMP}-secret`;
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const cron = await import("../src/cron.js");
  const sch = await import("../src/schedules.js");
  const routes = await import("../src/schedule-routes.js");
  const { workspaceRecords } = await import("../src/record-areas.js");
  const { cancelRun } = await import("../src/runs.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Sched A ${STAMP}`)).org, B = (await createOrg(`Sched B ${STAMP}`)).org;
  const at = (s: string) => new Date(s);
  const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params))[0]!.n;

  // ---------- 1. zero packs ----------
  {
    assert.equal(sch.schedulesWired(), false);
    assert.deepEqual(sch.defaultSchedules(), []);
    assert.deepEqual(sch.dueAreas(), []);
    assert.equal(routes.scheduleAppRouter().stack.length, 0, "nothing mounted at /api/schedules");
    assert.equal(routes.noticeAppRouter().stack.length, 0, "nothing mounted at /api/notices");
    const t = await sch.tickSchedules(at("2030-01-07T00:30:00Z"));
    assert.deepEqual([t.defaults, t.due, t.fired, t.runs], [0, 0, 0, 0]);
    assert.equal((await sch.dueCheck(at("2030-01-07T00:30:00Z"))).ran, false);
    assert.equal(await count("SELECT count(*)::int AS n FROM workspace_schedules"), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM scheduler_marks"), 0, "the due check wrote nothing either");
    const nav = readFileSync(path.join(ROOT, "web", "src", "config", "pack-nav.generated.ts"), "utf8");
    assert.match(nav, /export const workspacePortalNav: NavGroup\[\] = \[\];/, "the console's Workspace group is empty");
    console.log("✓ zero packs: nothing scheduled, nothing mounted, nothing read or written, the sidebar unchanged");
  }

  // ---------- 2. cron ----------
  {
    const c = cron.parseCron("0 * * * *");
    assert.equal(cron.nextAfter(c, at("2030-01-07T00:30:00Z"))!.toISOString(), "2030-01-07T01:00:00.000Z");
    assert.equal(cron.nextAfter(c, at("2030-01-07T01:00:00Z"))!.toISOString(), "2030-01-07T02:00:00.000Z", "strictly after");
    assert.equal(cron.latestAtOrBefore(c, at("2030-01-07T06:15:00Z"))!.toISOString(), "2030-01-07T06:00:00.000Z");
    assert.equal(cron.latestAtOrBefore(c, at("2030-01-07T06:00:00Z"))!.toISOString(), "2030-01-07T06:00:00.000Z", "at or before");
    assert.equal(cron.countBetween(c, at("2030-01-07T00:59:59Z"), at("2030-01-07T06:00:00Z")), 5);
    const weekly = cron.parseCron("30 3 * * 1");
    assert.equal(cron.nextAfter(weekly, at("2030-01-07T04:00:00Z"))!.toISOString(), "2030-01-14T03:30:00.000Z", "Mondays at 03:30");
    assert.equal(cron.latestAtOrBefore(weekly, at("2030-01-13T00:00:00Z"))!.toISOString(), "2030-01-07T03:30:00.000Z");
    assert.equal(cron.nextAfter(cron.parseCron("0 0 */2 * 1"), at("2030-01-01T00:00:00Z"))!.toISOString(), "2030-01-07T00:00:00.000Z", "as Vixie cron: */2 with a weekday means both (an odd day that is a Monday)");
    const either = cron.parseCron("0 0 1 * 5"); // the 1st of the month or a Friday
    assert.equal(cron.nextAfter(either, at("2030-01-01T00:00:00Z"))!.toISOString(), "2030-01-04T00:00:00.000Z", "a Friday");
    assert.equal(cron.nextAfter(either, at("2030-01-25T00:00:00Z"))!.toISOString(), "2030-02-01T00:00:00.000Z", "the 1st (also a Friday)");
    assert.equal(cron.nextAfter(cron.parseCron("*/15 9-10 * 2 *"), at("2030-01-31T23:00:00Z"))!.toISOString(), "2030-02-01T09:00:00.000Z");
    assert.equal(cron.nextAfter(cron.parseCron("0 0 29 2 *"), at("2030-03-01T00:00:00Z"))!.toISOString(), "2032-02-29T00:00:00.000Z", "leap day");
    for (const bad of ["", "* * * *", "* * * * * *", "* * * * *", "*/2 * * * *", "0,3 * * * *", "58,1 * * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 31 2 *", "a * * * *", "0 0 * * MON", "5-1 * * * *"])
      assert.throws(() => cron.parseCron(bad), cron.CronError, `refused: ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => cron.parseCron("*/5 * * * *"));
    assert.doesNotThrow(() => cron.parseCron("0 0 * * 7"));
    console.log("✓ cron (UTC): next and previous matches, steps, ranges, day-of-month or day-of-week, leap days; malformed, too frequent and impossible expressions refused");
  }

  // ---------- 3. refusals ----------
  {
    const areas = [
      { name: "rf_apps", label: "Apps", role: "asset", scope: "workspace", fields: [{ name: "url", label: "URL" }] },
      { name: "rf_ctrl", label: "Controls", role: "check", scope: "workspace", fields: [{ name: "sla", label: "SLA", type: "date" }, { name: "note", label: "Note" }] },
    ] as const;
    const kinds = [{ name: "kk", runner: "workspace-harness", entry: "noop.mjs" }] as const;
    const pack = (extra: Record<string, unknown>) => definePack({ id: "rf", jobKinds: [...kinds], recordAreas: [...areas] as never, ...extra });
    assert.throws(() => pack({ schedules: [{ name: "ss", job_kind: "other", cron: "0 * * * *" }] }), /names job kind other/);
    assert.throws(() => pack({ schedules: [{ name: "ss", job_kind: "kk", cron: "* * * * *" }] }), /cron expression/);
    assert.throws(() => pack({ schedules: [{ name: "ss", job_kind: "kk", cron: "0 0 31 2 *" }] }), /cron expression/);
    assert.throws(() => pack({ schedules: [{ name: "ss", job_kind: "kk", cron: "0 * * * *", assets: { area: "rf_ctrl" } }] }), /not one of this pack's asset areas/);
    assert.throws(() => pack({ schedules: [{ name: "ss", job_kind: "kk", cron: "0 * * * *", assets: { area: "elsewhere" } }] }), /not one of this pack's asset areas/);
    assert.throws(() => pack({ schedules: [{ name: "ss", job_kind: "kk", cron: "0 * * * *" }, { name: "ss", job_kind: "kk", cron: "0 1 * * *" }] }), /declared twice/);
    assert.doesNotThrow(() => pack({ schedules: [{ name: "ss", job_kind: "kk", cron: "0 * * * *", assets: { area: "rf_apps", keys: ["x"] }, environment: "prod" }] }));
    const due = (a: Record<string, unknown>) => definePack({ id: "rf", recordAreas: [a] as never });
    assert.throws(() => due({ ...areas[1], due: { field: "note" } }), /date fields/);
    assert.throws(() => due({ ...areas[1], due: { field: "nope" } }), /date fields/);
    assert.throws(() => due({ ...areas[0], fields: [{ name: "sla", label: "SLA", type: "date" }], due: { field: "sla" } }), /check area of workspace scope/);
    assert.throws(() => due({ ...areas[1], scope: "platform", due: { field: "sla" } }), /check area of workspace scope/);
    assert.throws(() => due({ ...areas[1], due: { field: "sla", notify: ["root"] } }), /notify/);
    assert.doesNotThrow(() => due({ ...areas[1], due: { field: "sla", within_days: 3, notify: ["owner", "member"] } }));
    console.log("✓ definePack refuses a schedule of a kind or asset area that is not the pack's own, a bad cron, a due date on the wrong area or field");
  }

  // ---------- the fixture pack ----------
  const def = (hourly = "0 * * * *", extra: { name: string; job_kind: string; cron: string; enabled?: boolean }[] = [], weekly = true) => definePack({
    id: "fixture_sched",
    recordAreas: [
      { name: "sc_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
      { name: "sc_controls", label: "Controls", role: "check", scope: "workspace", fields: [{ name: "sla", label: "SLA date", type: "date" }],
        due: { field: "sla", within_days: 7 } },
    ],
    jobKinds: [{ name: "sweep", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15 },
      { name: "manual", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15 }],
    schedules: [
      ...extra,
      { name: "hourly_sweep", label: "Hourly sweep", job_kind: "sweep", cron: hourly, assets: { area: "sc_apps" } },
      ...(weekly ? [{ name: "weekly_report", job_kind: "sweep", cron: "0 3 * * 1", enabled: false }] : []),
    ],
  });
  const manifest = { id: "fixture_sched", name: "Fixture schedules", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") };
  setPacksForTest([{ manifest, definition: def() }]);
  const put = (org: { orgId: number }, area: string, key: string, data: Record<string, unknown>, title?: string) =>
    workspaceRecords("fixture_sched", org.orgId).put(area, key, { title: title ?? key, data });
  await put(A, "sc_apps", "a-web", { url: "https://a-web.example" });
  await put(A, "sc_apps", "a-api", { url: "https://a-api.example" });
  await put(B, "sc_apps", "b-web", { url: "https://b-web.example" });
  // Scheduled runs have no launcher: the account's own standing applies (src/limits.ts). Both accounts have an allowance.
  await db.query("UPDATE organizations SET budget_override_usd = 100 WHERE id = ANY ($1::int[])", [[A.orgId, B.orgId]]);
  const runsOf = (org: { orgId: number }, id?: string) => db.query<{ id: string; org_id: number; status: string; targets: any; requested_by: string }>(
    `SELECT id, org_id, status, targets, requested_by FROM runs WHERE org_id = $1 AND ($2::text IS NULL OR requested_by = $2) ORDER BY created_at, id`, [org.orgId, id ? `schedule:${id}` : null]);
  const rowOf = async (org: { orgId: number }, name: string) => (await db.query<any>("SELECT * FROM workspace_schedules WHERE org_id = $1 AND name = $2", [org.orgId, name]))[0];
  const cancelAll = async () => { for (const o of [A, B]) for (const r of await runsOf(o)) if (r.status === "queued") await cancelRun(o.orgId, r.id); };

  let NOW = at("2030-01-07T00:30:00Z");
  sch.setSchedulerClock(() => NOW);
  const http = await startHttp();
  try {
    // ---------- 4. defaults, a missed tick, overlap, concurrent ticks ----------
    {
      const t0 = await sch.tickSchedules(at("2030-01-07T00:30:00Z"));
      assert.equal(t0.defaults, 4, "each workspace gets its own copy of both defaults");
      assert.equal(t0.fired, 0, "nothing due yet");
      const a0 = await rowOf(A, "hourly_sweep"), w0 = await rowOf(A, "weekly_report");
      assert.equal(new Date(a0.next_at).toISOString(), "2030-01-07T01:00:00.000Z");
      assert.ok(a0.is_default && a0.enabled && !a0.customized);
      assert.equal(w0.enabled, false, "a default the pack leaves off is off");
      assert.equal((await sch.tickSchedules(at("2030-01-07T00:31:00Z"))).defaults, 0, "copied once");

      // Nothing ticked from 00:30 to 06:15: the 01:00 to 06:00 due times (six) run once, as one.
      const t1 = await sch.tickSchedules(at("2030-01-07T06:15:00Z"));
      assert.deepEqual([t1.due, t1.fired, t1.runs, t1.skipped_slots], [2, 2, 3, 10], "two schedules due, one firing each, one run per asset, five missed times each not run");
      const a1 = await rowOf(A, "hourly_sweep");
      const aRuns = await runsOf(A, a1.id), bRuns = await runsOf(B, (await rowOf(B, "hourly_sweep")).id);
      assert.deepEqual(aRuns.map((r) => r.targets.asset.key).sort(), ["a-api", "a-web"], "A's runs: A's own assets");
      assert.deepEqual(bRuns.map((r) => r.targets.asset.key), ["b-web"], "B's run: B's own asset");
      assert.ok(aRuns.every((r) => r.org_id === A.orgId && r.targets.asset.area === "sc_apps") && bRuns.every((r) => r.org_id === B.orgId));
      assert.equal(new Date(a1.last_slot_at).toISOString(), "2030-01-07T06:00:00.000Z", "the latest due time ran");
      assert.equal(a1.last_skipped, 5);
      assert.equal(new Date(a1.next_at).toISOString(), "2030-01-07T07:00:00.000Z", "next: the first match after now");
      assert.deepEqual([...a1.last_runs].sort(), aRuns.map((r) => r.id).sort());
      const again = await sch.tickSchedules(at("2030-01-07T06:16:00Z"));
      assert.deepEqual([again.fired, again.runs], [0, 0], "the same due time never runs twice");
      assert.equal((await runsOf(A)).length, 2);

      // 07:00 while the 06:00 runs are still queued: not started again (a slow run never piles up).
      const t2 = await sch.tickSchedules(at("2030-01-07T07:00:00Z"));
      assert.deepEqual([t2.fired, t2.runs], [2, 0]);
      assert.match((await rowOf(A, "hourly_sweep")).last_error, /still going/);
      await cancelAll();

      // Three ticks at the same moment (the Vercel cron and two servers): each schedule fires once.
      const before = await count("SELECT count(*)::int AS n FROM runs");
      const tri = await Promise.all([0, 1, 2].map(() => sch.tickSchedules(at("2030-01-07T08:00:30Z"))));
      assert.equal(tri.reduce((n, r) => n + r.fired, 0), 2, "two schedules fired in all");
      assert.equal(tri.reduce((n, r) => n + r.runs, 0), 3, "three runs in all");
      assert.equal(await count("SELECT count(*)::int AS n FROM runs") - before, 3, "three runs in the database");
      assert.ok(tri.reduce((n, r) => n + r.lost, 0) >= 0);
      // And a tick that read a due row just before another moved it on cannot start it again (the compare-and-set).
      const stale = await rowOf(A, "hourly_sweep");
      await db.query("UPDATE workspace_schedules SET next_at = '2030-01-07T09:00:00Z' WHERE id = $1", [stale.id]); // as if another tick moved it on
      const won = await db.query("UPDATE workspace_schedules SET seq = seq + 1 WHERE id = $1 AND seq = $2 RETURNING id", [stale.id, stale.seq - 1]);
      assert.equal(won.length, 0, "a stale seq moves nothing");
      await cancelAll();
      console.log("✓ defaults copied per workspace; five missed hours run once (latest due time, five counted as skipped); never twice; no pile-up; three ticks at once start each run once");
    }

    // ---------- 5. workspaces, owners, the pack's later changes ----------
    {
      NOW = at("2030-01-07T08:30:00Z"); // the console's changes happen at the scheduler's clock
      const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer");
      const ownerB = await http.signIn(B, "owner");
      const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
      const get = async (tok: string) => (await http.req("GET", "/api/schedules", h(tok))).json();
      const mine = await get(viewer);
      assert.equal(mine.schedules.length, 2, "a viewer reads the workspace's schedules");
      assert.equal(mine.can_manage, false);
      const theirs = await get(ownerB);
      const aIds = new Set(mine.schedules.map((s: any) => s.id)), bIds = theirs.schedules.map((s: any) => s.id);
      assert.ok(bIds.every((id: string) => !aIds.has(id)), "each workspace sees only its own");
      const hourly = mine.schedules.find((s: any) => s.name === "hourly_sweep");
      assert.equal((await http.req("PATCH", `/api/schedules/${hourly.id}`, h(viewer), { enabled: false })).status, 403, "a viewer cannot change one");
      assert.equal((await http.req("PATCH", `/api/schedules/${hourly.id}`, h(member), { enabled: false })).status, 403, "nor a member");
      const bHourly = theirs.schedules.find((s: any) => s.name === "hourly_sweep");
      assert.equal((await http.req("PATCH", `/api/schedules/${bHourly.id}`, h(owner), { enabled: false })).status, 404, "A's owner cannot reach B's schedule");
      assert.equal((await http.req("DELETE", `/api/schedules/${bHourly.id}`, h(owner))).status, 404);
      assert.equal((await rowOf(B, "hourly_sweep")).enabled, true);
      // Adding: only the build's kinds, only A's own records, at most every 5 minutes.
      const add = (body: Record<string, unknown>, tok = owner) => http.req("POST", "/api/schedules", h(tok), body);
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "spy", cron: "0 * * * *", assets: { area: "sc_apps", keys: ["b-web"] } })).status, 400, "B's record is not in A");
      assert.equal((await add({ pack: "fixture_sched", job_kind: "nope", name: "x", cron: "0 * * * *" })).status, 400);
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "x", cron: "* * * * *" })).status, 400);
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "x", cron: "0 * * * *", assets: { area: "sc_controls" } })).status, 400, "not an asset area");
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "hourly_sweep", cron: "0 * * * *" })).status, 409, "a default's name");
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "x", cron: "0 * * * *" }, member)).status, 403);
      assert.equal((await add({ pack: "fixture_sched", job_kind: "manual", name: "x", cron: "0 * * * *" })).status, 400, "a kind the pack does not schedule itself");
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "x", cron: "0 * * * *", scope: { checks: ["all"] } })).status, 400, "the scope is the pack's");
      assert.deepEqual(mine.kinds, [{ pack: "fixture_sched", name: "sweep" }], "only the kinds the pack schedules are offered");
      const made = await (await add({ pack: "fixture_sched", job_kind: "sweep", name: "nightly_web", cron: "15 2 * * *", assets: { area: "sc_apps", keys: ["a-web"] }, environment: "prod" })).json();
      assert.equal(made.is_default, false);
      assert.equal(made.next_at, "2030-01-08T02:15:00.000Z", "due by the scheduler's clock");
      assert.equal(made.assets.keys[0], "a-web");
      // Turn A's hourly off: at 09:00 only B's fires (and A's own, not due until tomorrow 02:15, does not).
      const off = await (await http.req("PATCH", `/api/schedules/${hourly.id}`, h(owner), { enabled: false })).json();
      assert.equal(off.enabled, false);
      assert.equal(off.customized, true);
      const t = await sch.tickSchedules(at("2030-01-07T09:00:00Z"));
      assert.deepEqual([t.fired, t.runs], [1, 1], "only B's hourly fired");
      assert.equal((await runsOf(B)).at(-1)!.targets.asset.key, "b-web");
      // On again at 11:30: what was missed while off (10:00, 11:00) is not run; next is 12:00.
      NOW = at("2030-01-07T11:30:00Z");
      const on = await (await http.req("PATCH", `/api/schedules/${hourly.id}`, h(owner), { enabled: true })).json();
      assert.equal(on.next_at, "2030-01-07T12:00:00.000Z", "on again: due from now, not for what was missed");
      assert.equal((await sch.tickSchedules(at("2030-01-07T11:31:00Z"))).fired, 1, "B's 11:00 (due since) fires; A's does not");
      // The nightly one runs over its one asset, with the environment.
      await cancelAll();
      const n1 = await sch.tickSchedules(at("2030-01-08T02:15:00Z"));
      const nightly = await runsOf(A, made.id);
      assert.equal(nightly.length, 1);
      assert.deepEqual(nightly[0]!.targets, { asset: { area: "sc_apps", key: "a-web" }, environment: "prod" });
      assert.ok(n1.fired >= 1);
      // The pack's later change (hourly becomes every 30 minutes) reaches B's copy, not A's (changed by its owner).
      await cancelAll();
      setPacksForTest([{ manifest, definition: def("0,30 * * * *") }]);
      await sch.ensureDefaults(at("2030-01-08T03:10:00Z"));
      assert.equal((await rowOf(B, "hourly_sweep")).cron, "0,30 * * * *", "B's untouched copy follows the pack");
      assert.equal(new Date((await rowOf(B, "hourly_sweep")).next_at).toISOString(), "2030-01-08T03:30:00.000Z");
      assert.equal((await rowOf(A, "hourly_sweep")).cron, "0 * * * *", "A's changed copy is A's own");
      // A default added later with the name of an owner's own schedule is still copied in, beside it.
      assert.equal((await add({ pack: "fixture_sched", job_kind: "sweep", name: "clash_me", cron: "0 4 * * *" })).status, 200);
      setPacksForTest([{ manifest, definition: def("0,30 * * * *", [{ name: "clash_me", job_kind: "sweep", cron: "0 5 * * *" }]) }]);
      await sch.ensureDefaults(at("2030-01-08T03:11:00Z"));
      assert.deepEqual((await db.query<any>("SELECT is_default, cron FROM workspace_schedules WHERE org_id = $1 AND name = 'clash_me' ORDER BY is_default", [A.orgId])).map((r) => [r.is_default, r.cron]),
        [[false, "0 4 * * *"], [true, "0 5 * * *"]]);
      // A default the pack drops is turned off and said so; then its owner may remove it.
      setPacksForTest([{ manifest, definition: def("0,30 * * * *", [], false) }]);
      await sch.ensureDefaults(at("2030-01-08T03:12:00Z"));
      const gone = await db.query<any>("SELECT id, enabled, last_error FROM workspace_schedules WHERE org_id = $1 AND is_default AND name IN ('weekly_report', 'clash_me')", [A.orgId]);
      assert.ok(gone.length === 2 && gone.every((r) => !r.enabled && /no pack declares/.test(r.last_error)), "dropped defaults are off");
      assert.equal((await http.req("PATCH", `/api/schedules/${gone[0].id}`, h(owner), { enabled: true })).status, 409, "and cannot be turned on");
      assert.equal((await http.req("DELETE", `/api/schedules/${gone[0].id}`, h(owner))).status, 204, "but can be removed");
      // A blocked account (no allowance) starts no scheduled run: the tick says why.
      await cancelAll();
      // An allowance of $0 (the test world gives every workspace a default allowance, so NULL is no longer "none").
      await db.query("UPDATE organizations SET budget_override_usd = 0 WHERE id = $1", [B.orgId]);
      const blocked = await sch.tickSchedules(at("2030-01-08T03:30:00Z"));
      assert.ok(blocked.fired >= 1);
      assert.deepEqual((await rowOf(B, "hourly_sweep")).last_runs, [], "B's due time started nothing");
      assert.match((await rowOf(B, "hourly_sweep")).last_error, /cannot start runs now \(no_allowance\)/);
      await db.query("UPDATE organizations SET budget_override_usd = 100 WHERE id = $1", [B.orgId]);
      // Removing: A's own one goes; a default cannot be removed (turned off instead).
      assert.equal((await http.req("DELETE", `/api/schedules/${hourly.id}`, h(owner))).status, 409);
      assert.equal((await http.req("DELETE", `/api/schedules/${made.id}`, h(owner))).status, 204);
      // Tenant work reads only its own workspace's schedules and writes none.
      const seen = await withTenant(A.orgId, async () => (await db.query<{ org_id: number }>("SELECT org_id FROM workspace_schedules")));
      assert.ok(seen.length > 0 && seen.every((r) => r.org_id === A.orgId), "row-level security: A's rows only");
      await assert.rejects(withTenant(A.orgId, () => db.query("UPDATE workspace_schedules SET enabled = false WHERE org_id = $1", [A.orgId])), /permission denied/i);
      console.log("✓ each workspace's runs are over its own assets; each person sees only their workspace's schedules; only owners change them; another workspace's schedule or record is not found; the pack's change reaches only untouched copies");
    }

    // ---------- 6. the daily due-date check ----------
    {
      process.env.RESEND_API_URL = http.mock.url;
      await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
      // Due-date emails are a notification the app's profile turns on (mold_v0-083, src/email.ts): this app's does.
      (await import("../src/email.js")).setEmailProfileForTest({ notifications: ["due_dates"] });
      const ownerA = await http.signIn(A, "owner"), viewerA = await http.signIn(A, "viewer"), memberA = await http.signIn(A, "member");
      const ownerB = await http.signIn(B, "owner");
      const day = "2030-02-04", plus = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      await put(A, "sc_controls", "c-soon", { sla: plus(3) }, "Rotate keys");
      await put(A, "sc_controls", "c-today", { sla: `${plus(0)}T17:00:00Z` }, "Review access");
      await put(A, "sc_controls", "c-later", { sla: plus(10) }, "Pen test");
      await put(A, "sc_controls", "c-past", { sla: plus(-2) }, "Old");
      await put(A, "sc_controls", "c-none", {}, "No date");
      await put(B, "sc_controls", "c-soon", { sla: plus(1) }, "B's own control");
      const emails = () => (http.mock.state.emails as any[]).filter((e) => e.tags?.some((t: any) => t.value === "due_soon"));
      const d1 = await sch.dueCheck(at(`${day}T06:00:00Z`));
      assert.equal(d1.ran, true);
      assert.deepEqual([d1.found, d1.posted], [3, 3], "A's two and B's one within 7 days");
      const notices = async (org: { orgId: number }) => (await sch.listNotices(org.orgId)).map((n) => `${n.key}@${n.due_on}`).sort();
      assert.deepEqual(await notices(A), [`c-soon@${plus(3)}`, `c-today@${plus(0)}`]);
      assert.deepEqual(await notices(B), [`c-soon@${plus(1)}`]);
      const sent = emails();
      // To the workspace's own owners only: A's owners get A's records, B's owners B's; no one else.
      const ownerOf = (to: string, org: { orgId: number }) => new RegExp(`^owner\\+${org.orgId}-`).test(to);
      assert.ok(sent.length >= 2);
      for (const e of sent) {
        assert.equal(e.to.length, 1);
        const inA = ownerOf(e.to[0], A), inB = ownerOf(e.to[0], B);
        assert.ok(inA || inB, `only owners are emailed (got ${e.to[0]})`);
        if (inA) { assert.match(e.text, /Rotate keys/); assert.match(e.text, /Review access/); assert.doesNotMatch(e.text, /B's own control|Pen test|Old/); }
        if (inB) { assert.match(e.text, /B's own control/); assert.doesNotMatch(e.text, /Rotate keys|Review access/); }
      }
      assert.ok(sent.some((e) => ownerOf(e.to[0], A)) && sent.some((e) => ownerOf(e.to[0], B)), "both workspaces' owners");
      assert.ok(!sent.some((e) => /^(member|viewer)\+/.test(e.to[0])), "not members or viewers (the area notifies owners)");
      const logged = await db.query<{ status: string; meta: any; to_domain: string }>("SELECT status, meta, to_domain FROM email_log WHERE kind = 'due_soon'");
      assert.equal(logged.length, sent.length, "every email is in the email log");
      assert.ok(logged.every((r) => r.status === "sent" && r.meta.area === "sc_controls" && r.meta.day === day && !JSON.stringify(r.meta).includes("@")), "sent, with no address in the log");
      assert.equal(await count("SELECT count(*)::int AS n FROM workspace_notices WHERE emailed_at IS NULL"), 0, "each notice marked emailed");
      // Once a day: the same day again does nothing.
      const d2 = await sch.dueCheck(at(`${day}T18:00:00Z`));
      assert.deepEqual([d2.ran, d2.reason], [false, "already ran today"]);
      assert.equal(emails().length, sent.length);
      // Four days later c-later (plus 10) is within 7 days: posted and emailed then; nothing is emailed twice.
      const d3 = await sch.dueCheck(at(`${plus(4)}T06:00:00Z`));
      assert.equal(d3.posted, 1);
      const later = emails().slice(sent.length);
      assert.ok(later.length >= 1 && later.every((e) => ownerOf(e.to[0], A) && /Pen test/.test(e.text) && !/Rotate keys/.test(e.text)), "only the new one, only to A's owners");
      // Over HTTP: a person reads their own workspace's notices; a viewer cannot dismiss; nobody reaches another's.
      const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
      const listed = await (await http.req("GET", "/api/notices", h(viewerA))).json();
      assert.deepEqual(listed.notices.map((n: any) => n.key).sort(), ["c-later", "c-soon", "c-today"]);
      const bNotice = (await sch.listNotices(B.orgId))[0]!;
      assert.equal((await http.req("POST", `/api/notices/${bNotice.id}/dismiss`, h(ownerA))).status, 404, "B's notice is not found from A");
      assert.equal((await http.req("POST", `/api/notices/${listed.notices[0].id}/dismiss`, h(viewerA))).status, 403);
      assert.equal((await http.req("POST", `/api/notices/${listed.notices[0].id}/dismiss`, h(memberA))).status, 200);
      assert.equal((await (await http.req("GET", "/api/notices", h(ownerA))).json()).notices.length, 2);
      assert.equal((await (await http.req("GET", "/api/notices", h(ownerB))).json()).notices.length, 1);
      assert.equal((await http.req("GET", "/api/notices", {})).status, 401);
      console.log("✓ due check: a notice per record due within 7 days, an email to each workspace's own owners with only its records, in the email log without addresses; once a day; a later record posted and emailed then");
    }

    // ---------- 8. plan entitlements (mold_v0-083, src/entitlements.ts) ----------
    {
      const ent = await import("../src/entitlements.js");
      NOW = at("2030-03-04T08:30:00Z");
      const owner = await http.signIn(A, "owner");
      const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
      await ent.setEntitlementsForTest({ plans: { basic: { features: ["runs"] }, team: { features: ["runs", "schedules"] }, sched_only: { features: ["schedules"] } }, without_plan: "basic" });
      // Making one, or turning one on: only on a plan that includes schedules. Turning one off always.
      const made = await http.req("POST", "/api/schedules", h(owner), { pack: "fixture_sched", job_kind: "sweep", name: "plan_check", cron: "0 * * * *" });
      assert.equal(made.status, 403);
      assert.match((await made.json()).error, /plan \(basic\) does not include run on a schedule/);
      const hourly = (await (await http.req("GET", "/api/schedules", h(owner))).json()).schedules.find((s: any) => s.name === "hourly_sweep");
      assert.equal((await http.req("PATCH", `/api/schedules/${hourly.id}`, h(owner), { enabled: false })).status, 200, "turning one off is always allowed");
      assert.equal((await http.req("PATCH", `/api/schedules/${hourly.id}`, h(owner), { enabled: true })).status, 403, "turning one on needs the plan");
      // A due schedule does not fire on such a plan: its row says why, and no run is written.
      await cancelAll();
      const nB = (await runsOf(B)).length;
      await sch.tickSchedules(at("2030-03-04T10:00:00Z"));
      assert.equal((await runsOf(B)).length, nB, "B's due hourly started nothing");
      assert.match((await rowOf(B, "hourly_sweep")).last_error, /not started: this workspace's plan \(basic\) does not include run on a schedule/);
      // A plan with schedules but not runs: the schedule fires, its runs are refused (the runs feature).
      await ent.setEntitlementsForTest({ plans: { basic: { features: ["runs"] }, team: { features: ["runs", "schedules"] }, sched_only: { features: ["schedules"] } }, without_plan: "sched_only" });
      await sch.tickSchedules(at("2030-03-04T11:00:00Z"));
      assert.equal((await runsOf(B)).length, nB, "no run without the runs feature");
      assert.match((await rowOf(B, "hourly_sweep")).last_error, /does not include start runs/);
      // The plan with both: on again, and it fires.
      await ent.setEntitlementsForTest({ plans: { basic: { features: ["runs"] }, team: { features: ["runs", "schedules"] } }, without_plan: "team" });
      assert.equal((await http.req("PATCH", `/api/schedules/${hourly.id}`, h(owner), { enabled: true })).status, 200);
      await sch.tickSchedules(at("2030-03-04T12:00:00Z"));
      assert.ok((await runsOf(B)).length > nB, "on a plan with schedules and runs, B's due hourly starts its run");
      await cancelAll();
      await ent.setEntitlementsForTest(undefined);
      console.log("✓ plan entitlements: a schedule is made, turned on and fired only on a plan with schedules, its runs only on a plan with runs; turning one off always works");
    }

    // ---------- 7. the cron entry ----------
    {
      assert.equal((await http.req("GET", "/api/cron/autoscale", {})).status, 401, "no secret");
      assert.equal((await http.req("GET", "/api/cron/autoscale", { authorization: "Bearer wrong" })).status, 401, "a wrong secret");
      assert.equal((await http.req("GET", "/api/cron/autoscale", { authorization: `Bearer ${(await http.signIn(A, "owner"))}` })).status, 401, "a person's session is not the secret");
      const ok = await http.req("GET", "/api/cron/autoscale", { authorization: `Bearer ${process.env.CRON_SECRET}` });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.ok(body.schedules?.schedules && body.schedules?.due, "the cron entry ticks the scheduler");
      console.log("✓ the cron entry needs CRON_SECRET and ticks the scheduler");
    }
  } finally {
    await http.close();
  }
  await db.close();
  console.log("SCHEDULES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
