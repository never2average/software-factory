// Record clocks: deadlines, reminders and escalation (mold_v0-191; src/clock-math.ts, src/record-clocks.ts,
// sql/migrations/0032_record_clocks.sql), offline: an embedded database, the HTTP server behind a fake Clerk and a fake
// Resend, a fixture pack declared as definePack would compile pack.json, and a clock the test controls.
//   npm run test:record-clocks
//
// 1. Zero packs: no clock area, the check reads and writes nothing, no tool.
// 2. Clock math: durations; business time over weekends (against a naive count, at random); calendar and business
//    deadlines; a duration by a field's value, a default, none; a cap; pauses (observed and from lifecycle times), stops
//    (met, missed, at a date field), reopening; due soon; the steps due; raise.
// 3. Declarations refused: a start that is not a date, mixed kinds of time, an assignee not declared, escalation out of
//    order, raising the field the duration is chosen by, a clock on a shared area, reassign on a read-only area.
// 4. The scheduler's clock check on a fixture workspace: each record's clock remembered, every change and step recorded
//    once per record and deadline; reminders and escalations notify (in-app notices, one email per person: the
//    workspace's owners, the assignee), reassign and raise through the record store; a record first seen long overdue
//    does every step but tells only the latest; a pause moves the deadline out; running it again (and three at once)
//    does nothing more.
// 5. Tenant isolation: the check for one workspace never reads or writes another's; a workspace's scope cannot write
//    another's clock rows or events, nor change an event; each workspace's notices, emails, pages and tool are its own.
// 6. Reads: /api/records pages and records carry their clocks and history; the record tools and list_due_records; a
//    metric over a clock's status; the default cards of a list tab gain Overdue; the home page's Due soon card
//    (/api/records/due-soon, mold_v0-207).
import assert from "node:assert/strict";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";

const DAY = 86_400_000;
const at = (s: string) => new Date(s);
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const cm = await import("../src/clock-math.js");
  const rc = await import("../src/record-clocks.js");
  const { workspaceRecords, listFor, detailFor, SYSTEM_ACTOR, recordTools } = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params))[0]!.n;

  // ---------- 1. zero packs ----------
  {
    assert.deepEqual(rc.clockAreas(), []);
    assert.deepEqual(rc.clockTools(), [], "no list_due_records");
    const r = await rc.clockCheck(at("2030-01-07T00:30:00Z"));
    assert.deepEqual([r.ran, r.reason], [false, "no record area declares clocks"]);
    assert.equal(await count("SELECT count(*)::int AS n FROM workspace_record_clocks"), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM scheduler_marks WHERE name = 'record_clocks'"), 0, "nothing marked either");
    console.log("✓ zero packs: no clock area, the check reads and writes nothing, no tool");
  }

  // ---------- 2. clock math ----------
  {
    assert.deepEqual(cm.parseDuration("90d"), { ms: 90 * DAY, kind: "calendar" });
    assert.deepEqual(cm.parseDuration("48h"), { ms: 48 * 3_600_000, kind: "calendar" });
    assert.deepEqual(cm.parseDuration("10bd"), { ms: 10 * DAY, kind: "business" });
    assert.throws(() => cm.parseDuration("1w"));
    const t = (s: string) => Date.parse(s);
    // 2030-03-01 is a Friday.
    assert.equal(cm.businessMs(t("2030-03-01T12:00:00Z"), t("2030-03-04T12:00:00Z")), DAY, "Friday noon to Monday noon: one business day");
    assert.equal(cm.businessMs(t("2030-03-02T00:00:00Z"), t("2030-03-04T00:00:00Z")), 0, "a weekend counts nothing");
    assert.equal(new Date(cm.addBusiness(t("2030-03-01T12:00:00Z"), DAY)).toISOString(), "2030-03-04T12:00:00.000Z", "Friday noon + 1bd = Monday noon");
    assert.equal(new Date(cm.addBusiness(t("2030-03-02T10:00:00Z"), DAY)).toISOString(), "2030-03-05T00:00:00.000Z", "a Saturday start waits for Monday");
    assert.equal(new Date(cm.addBusiness(t("2030-03-04T00:00:00Z"), 10 * DAY)).toISOString(), "2030-03-18T00:00:00.000Z", "10bd from a Monday: two weeks");
    assert.equal(new Date(cm.addBusiness(t("2030-03-04T00:00:00Z"), 5 * DAY)).toISOString(), "2030-03-11T00:00:00.000Z", "5bd from a Monday ends as Friday ends: Monday 00:00");
    // Against a naive hour-by-hour count, at random (the week skips must agree with walking day by day).
    const naiveMs = (a: number, b: number) => { let n = 0; for (let x = a; x < b; x += 3_600_000) { const w = new Date(x).getUTCDay(); if (w !== 0 && w !== 6) n += Math.min(3_600_000, b - x); } return n; };
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 150; i++) {
      const a = t("2030-01-01T00:00:00Z") + Math.floor(rnd() * 60 * 24) * 3_600_000;
      const ms = Math.floor(rnd() * 40 * 24) * 3_600_000;
      const end = cm.addBusiness(a, ms);
      assert.equal(cm.businessMs(a, end), ms, `businessMs(addBusiness(a, ${ms})) = ${ms}`);
      const b = a + Math.floor(rnd() * 50 * 24) * 3_600_000;
      assert.equal(cm.businessMs(a, b), naiveMs(a, b), "businessMs agrees with a naive count");
    }
    assert.equal(cm.parseTime("2030-03-01"), t("2030-03-01T00:00:00Z"));
    assert.equal(cm.parseTime("2030-03-01T10:00:00"), t("2030-03-01T10:00:00Z"), "no zone: UTC");
    assert.equal(cm.parseTime("2030-03-01T10:00:00+05:30"), t("2030-03-01T04:30:00Z"));
    assert.equal(cm.parseTime("soon"), null);

    const clock = (c: Record<string, unknown>) => ({ name: "c", label: "C", starts: { field: "start" }, after: "30d", ...c }) as never;
    const rec = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ data, created_at: "2030-01-01T00:00:00Z", ...extra });
    const NOW = at("2030-03-04T09:00:00Z"); // a Monday
    let o = cm.observe(clock({}), rec({ start: "2030-02-01" }), null, NOW);
    assert.equal(o.view.due_at, "2030-03-03T00:00:00.000Z");
    assert.deepEqual([o.view.status, o.view.overdue, o.view.overdue_days, o.changes], ["overdue", true, 1, ["started"]]);
    o = cm.observe(clock({}), rec({ start: "2030-02-28" }), null, NOW);
    assert.deepEqual([o.view.status, o.view.due_on], ["on_track", "2030-03-30"]);
    o = cm.observe(clock({ soon: "30d" }), rec({ start: "2030-02-28" }), null, NOW);
    assert.equal(o.view.status, "due_soon", "within soon");
    o = cm.observe(clock({ remind: [{ before: "14d" }, { before: "3d" }] }), rec({ start: "2030-02-16" }), null, NOW);
    assert.deepEqual([o.view.status, o.view.due_on], ["due_soon", "2030-03-18"], "due soon: the earliest reminder");
    // By a field's value; a default; none.
    const sev = clock({ after: { by: "severity", values: { high: "30d", medium: "90d", low: "180d" } } });
    assert.equal(cm.observe(sev, rec({ start: "2030-01-01", severity: "medium" }), null, NOW).view.due_on, "2030-04-01");
    assert.equal(cm.observe(sev, rec({ start: "2030-01-01", severity: "critical" }), null, NOW).view.status, "not_started", "no duration for this value");
    assert.equal(cm.observe(clock({ after: { by: "severity", values: { high: "30d" }, default: "10d" } }), rec({ start: "2030-01-01", severity: "x" }), null, NOW).view.due_on, "2030-01-11");
    assert.equal(cm.observe(clock({}), rec({}), null, NOW).view.status, "not_started", "no start");
    // Events: created, entered a state.
    assert.equal(cm.observe(clock({ starts: { event: "created" }, after: "2bd" }), rec({}), null, NOW).view.due_at, "2030-01-03T00:00:00.000Z");
    assert.equal(cm.observe(clock({ starts: { event: "entered", state: "triage" }, after: "1d" }), rec({}, { state_at: { triage: "2030-03-01T08:00:00Z" } }), null, NOW).view.due_at, "2030-03-02T08:00:00.000Z");
    // A cap (not_later_than) wins when earlier.
    assert.equal(cm.observe(clock({ not_later_than: "cap" }), rec({ start: "2030-02-01", cap: "2030-02-10" }), null, NOW).view.due_on, "2030-02-10");
    assert.equal(cm.observe(clock({ not_later_than: "cap" }), rec({ start: "2030-02-01", cap: "2031-02-10" }), null, NOW).view.due_on, "2030-03-03");
    // Business days, starting on a weekend.
    assert.equal(cm.observe(clock({ after: "10bd" }), rec({ start: "2030-03-02" }), null, NOW).view.due_at, "2030-03-18T00:00:00.000Z", "Saturday + 10bd = two weeks from Monday");
    // Pauses (observed): paused at NOW, resumed 6 days later: the deadline moves out by 6 days.
    const pc = clock({ pauses_when: { field: "hold", in: ["yes"] } });
    let m = cm.observe(pc, rec({ start: "2030-02-20" }), null, NOW);
    assert.equal(m.view.due_on, "2030-03-22");
    m = cm.observe(pc, rec({ start: "2030-02-20", hold: "yes" }), m.memory, NOW);
    assert.deepEqual([m.view.status, m.changes, m.memory.paused_since], ["paused", ["paused"], NOW.toISOString()]);
    const later = new Date(NOW.getTime() + 6 * DAY);
    const p2 = cm.observe(pc, rec({ start: "2030-02-20", hold: "yes" }), m.memory, later);
    assert.deepEqual([p2.view.status, p2.view.due_on], ["paused", "2030-03-28"], "while paused, the deadline as if it ran again now");
    const r2 = cm.observe(pc, rec({ start: "2030-02-20", hold: "no" }), m.memory, later);
    assert.deepEqual([r2.view.status, r2.changes, r2.memory.paused_ms, r2.view.due_on], ["on_track", ["resumed"], 6 * DAY, "2030-03-28"]);
    // A business-day clock paused over a weekend: only the weekdays move it out (Fri 00:00 to Tue 00:00: two business days).
    const bp = clock({ after: "10bd", pauses_when: { field: "hold", in: ["yes"] } });
    const fri = at("2030-03-08T00:00:00Z"), tue = at("2030-03-12T00:00:00Z");
    const b1 = cm.observe(bp, rec({ start: "2030-03-04", hold: "yes" }), null, fri);
    const b2 = cm.observe(bp, rec({ start: "2030-03-04", hold: "no" }), b1.memory, tue);
    assert.deepEqual([b2.memory.paused_ms, b2.view.due_at], [2 * DAY, "2030-03-20T00:00:00.000Z"], "10bd from 03-04 is 03-18, plus two business days paused");
    // Lifecycle times: a pause by the lifecycle's field starts and ends exactly when the record moved.
    const lc = (state: string, state_at: Record<string, string>) => rec({ start: "2030-02-20", state }, { state_at, lifecycle_field: "state" });
    const lp = clock({ pauses_when: { field: "state", in: ["waiting"] } });
    const l1 = cm.observe(lp, lc("waiting", { waiting: "2030-03-01T00:00:00Z" }), null, NOW);
    assert.equal(l1.memory.paused_since, "2030-03-01T00:00:00.000Z", "paused since it entered waiting");
    const l2 = cm.observe(lp, lc("open", { waiting: "2030-03-01T00:00:00Z", open: "2030-03-03T00:00:00Z" }), l1.memory, NOW);
    assert.deepEqual([l2.memory.paused_ms, l2.view.due_on], [2 * DAY, "2030-03-24"], "resumed when it entered open: two days");
    // Stops: met, missed, at a date field; reopening.
    const sc = clock({ stops_when: { field: "status", in: ["resolved"], at: "resolved_at" } });
    assert.equal(cm.observe(sc, rec({ start: "2030-02-01", status: "resolved", resolved_at: "2030-02-20" }), null, NOW).view.status, "met");
    const missed = cm.observe(sc, rec({ start: "2030-02-01", status: "resolved", resolved_at: "2030-03-04" }), null, NOW);
    assert.deepEqual([missed.view.status, missed.view.stopped_at, missed.changes], ["missed", "2030-03-04T00:00:00.000Z", ["started", "stopped"]]);
    const reo = cm.observe(sc, rec({ start: "2030-02-01", status: "open" }), missed.memory, NOW);
    assert.deepEqual([reo.view.status, reo.changes], ["overdue", ["reopened"]]);
    // Steps due: reminders before the deadline; escalations after; nothing while paused or stopped.
    const steps = clock({ remind: [{ before: "7d" }, { before: "1d" }], escalate: [{ after: "0d", notify: ["owner"] }, { after: "7d", notify: ["owner"] }] });
    const ids = (start: string, extra: Record<string, unknown> = {}) => cm.stepsDue(steps, cm.observe(steps, rec({ start, ...extra }), null, NOW).view, NOW).map((s) => s.id);
    assert.deepEqual(ids("2030-02-07"), ["remind:0"], "due 03-09: within 7 days, not 1");
    assert.deepEqual(ids("2030-02-02T12:00:00Z"), ["remind:0", "remind:1"], "due 03-04 12:00: within both");
    assert.deepEqual(ids("2030-02-01"), ["escalate:0"], "overdue a day");
    assert.deepEqual(ids("2030-01-20"), ["escalate:0", "escalate:1"], "overdue two weeks");
    assert.deepEqual(cm.stepsDue(sc, cm.observe(sc, rec({ start: "2030-01-01", status: "resolved" }), null, NOW).view, NOW), [], "stopped");
    assert.deepEqual([cm.raised(["l1", "l2", "l3"], "l1"), cm.raised(["l1", "l2", "l3"], "l2", "l2"), cm.raised(["l1", "l2", "l3"], "l3"), cm.raised(["l1"], "x")], ["l2", null, null, null]);
    console.log("✓ clock math: calendar and business time (150 random spans against a naive count), deadlines by a field, defaults, caps, events; pauses observed and from lifecycle times (business time only on weekdays); stops met, missed and reopened; due soon; the steps due; raise");
  }

  // ---------- 3. declarations refused ----------
  const FIELDS = [
    { name: "severity", label: "Severity", type: "enum", options: ["low", "medium", "high", "critical"] },
    { name: "state", label: "State", type: "enum", options: ["open", "done"] },
    { name: "hold", label: "On hold", type: "enum", options: ["no", "yes"] },
    { name: "opened_on", label: "Opened", type: "date" },
    { name: "cap", label: "Fix by at the latest", type: "date" },
    { name: "owner_id", label: "Owner", type: "person" },
    { name: "backup_id", label: "Backup", type: "person" },
    { name: "level", label: "Level", type: "enum", options: ["l1", "l2", "l3"] },
    { name: "note", label: "Note" },
  ];
  const FIX_BY = {
    name: "fix_by", label: "Fix by", starts: { field: "opened_on" },
    after: { by: "severity", values: { high: "30d", medium: "90d", low: "180d" } },
    not_later_than: "cap",
    stops_when: { field: "state", in: ["done"] },
    pauses_when: { field: "hold", in: ["yes"] },
    assignee: "owner_id",
    notify: ["owner"],
    remind: [{ before: "7d", notify: ["assignee"] }],
    escalate: [
      { after: "0d", notify: ["assignee", "owner"] },
      { after: "7d", label: "Reassigned to the backup", reassign: { field: "owner_id", from_field: "backup_id" }, notify: ["assignee"] },
      { after: "14d", label: "Raised", raise: { field: "level", to: "l3" }, notify: ["owner"] },
    ],
  };
  const AREA = {
    name: "dl_items", label: "Items", role: "check", scope: "workspace", fields: FIELDS, list_columns: ["severity", "state", "level"],
    lifecycle: { field: "state", initial: "open", transitions: [{ from: "*", to: "done" }, { from: "*", to: "open" }] },
    clocks: [FIX_BY, { name: "respond", label: "Respond by", starts: { event: "created" }, after: "2bd" }],
  };
  {
    const pack = (clocks: unknown[], extra: Record<string, unknown> = {}) => definePack({ id: "rf", recordAreas: [{ ...AREA, clocks, ...extra }] as never });
    assert.doesNotThrow(() => pack(AREA.clocks));
    assert.throws(() => pack([{ ...FIX_BY, starts: { field: "note" } }]), /starts.field must name one of the area's date fields/);
    assert.throws(() => pack([{ ...FIX_BY, after: { by: "severity", values: { high: "30d", low: "5bd" } } }]), /all calendar time/);
    assert.throws(() => pack([{ ...FIX_BY, remind: [{ before: "2bd" }] }]), /own kind of time/);
    assert.throws(() => pack([{ ...FIX_BY, assignee: undefined }]), /declare the clock's assignee/);
    assert.throws(() => pack([{ ...FIX_BY, assignee: "note" }]), /single person fields/);
    assert.throws(() => pack([{ ...FIX_BY, escalate: [{ after: "7d", notify: ["owner"] }, { after: "2d", notify: ["owner"] }] }]), /in order of after/);
    assert.throws(() => pack([{ ...FIX_BY, escalate: [{ after: "1d" }] }]), /notifies, reassigns or raises/);
    assert.throws(() => pack([{ ...FIX_BY, escalate: [{ after: "1d", raise: { field: "severity" } }] }]), /the field the clock's duration is chosen by/);
    assert.throws(() => pack([{ ...FIX_BY, escalate: [{ after: "1d", raise: { field: "state" } }] }]), /lifecycle's field/);
    assert.throws(() => pack([{ ...FIX_BY, after: { by: "severity", values: { urgent: "1d" } } }]), /urgent is not one of severity's options/);
    assert.throws(() => pack([{ ...FIX_BY, stops_when: { field: "state", in: ["closed"] } }]), /closed is not one of state's options/);
    assert.throws(() => pack([{ ...FIX_BY, pauses_when: { field: "state", in: ["done"] } }]), /both stop and pause/);
    assert.throws(() => pack([FIX_BY, FIX_BY]), /declared twice/);
    assert.throws(() => pack([{ ...FIX_BY, name: "severity" }]), /name of one of the area's fields/);
    assert.throws(() => pack([{ ...FIX_BY, after: "1w" }]), /a duration/);
    assert.throws(() => definePack({ id: "rf", recordAreas: [{ ...AREA, scope: "platform", lifecycle: undefined }] as never }), /workspace scope/);
    assert.throws(() => definePack({ id: "rf", repositories: { files: { kind: "workspace_files", path: "x/items.jsonl", format: "jsonl", identity: "id" } },
      recordAreas: [{ ...AREA, lifecycle: undefined, repository: "files", clocks: [{ ...FIX_BY, stops_when: undefined }] }] as never }), /cannot reassign or raise/);
    assert.doesNotThrow(() => definePack({ id: "rf", repositories: { files: { kind: "workspace_files", path: "x/items.jsonl", format: "jsonl", identity: "id" } },
      recordAreas: [{ ...AREA, lifecycle: undefined, repository: "files", clocks: [{ ...FIX_BY, stops_when: undefined, escalate: [{ after: "0d", notify: ["owner"] }] }] }] as never }),
      "a read-only area may notify");
    console.log("✓ declarations refused: a start that is not a date, mixed time, an undeclared or wrong assignee, steps out of order or doing nothing, raising the duration's or lifecycle's field, unknown options, a value that stops and pauses, twice, a shared area, reassign on a read-only area");
  }

  // ---------- the fixture pack and workspaces ----------
  const def = definePack({ id: "fixture_deadlines", recordAreas: [AREA] as never,
    metrics: [{ name: "overdue_items", label: "Overdue", over: "dl_items", clock: { name: "fix_by", is: ["overdue"] } }] as never });
  setPacksForTest([{ manifest: { id: "fixture_deadlines", name: "Fixture deadlines", version: "1", entry: null, migrations: null, words: {}, dir: "." } as never, definition: def }]);
  assert.deepEqual(rc.clockAreas().map((a) => a.name), ["dl_items"]);
  const A = (await createOrg(`Clocks A ${STAMP}`)).org, B = (await createOrg(`Clocks B ${STAMP}`)).org;
  const recs = (o: { orgId: number }) => workspaceRecords("fixture_deadlines", o.orgId);
  const http = await startHttp();
  try {
    process.env.RESEND_API_URL = http.mock.url;
    await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
    (await import("../src/email.js")).setEmailProfileForTest({ notifications: ["due_dates"] });
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A, "member");
    const ownerB = await http.signIn(B, "owner");
    // Two people of A by sign-in id (the assignee and the backup), members of A's organization in the fake Clerk.
    const corgA = (await db.query<{ c: string }>("SELECT clerk_org_id AS c FROM organizations WHERE id = $1", [A.orgId]))[0]!.c;
    const person = async (who: string) => {
      const post = async (p: string, body: unknown) => (await fetch(`${http.mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      const u = await post("/_mock/clerk/users", { email: `${who}+${A.orgId}-${STAMP}@example.org` });
      await post("/_mock/clerk/memberships", { org_id: corgA, user_id: u.id, role: "org:member" });
      return u.id as string;
    };
    const u1 = await person("assignee"), u2 = await person("backup");
    const NOW0 = at("2030-03-04T09:00:00Z");
    rc.setClockNowForTest(() => NOW0);
    const put = (o: { orgId: number }, key: string, data: Record<string, unknown>, title = key) => recs(o).put("dl_items", key, { title, data });
    await put(A, "a-high", { severity: "high", opened_on: "2030-02-01", owner_id: u1, level: "l1" }, "Open port on the API");
    await put(A, "a-old", { severity: "high", opened_on: "2030-01-01", owner_id: u1, backup_id: u2, level: "l1" }, "Stale secret");
    await put(A, "a-soon", { severity: "medium", opened_on: "2029-12-08", owner_id: u1 }, "Old library");
    await put(A, "a-capped", { severity: "low", opened_on: "2030-03-01", cap: "2030-03-05" }, "Capped");
    await put(A, "a-done", { severity: "high", opened_on: "2030-01-01" }, "Done already");
    await recs(A).move("dl_items", "a-done", "done");
    await put(A, "a-hold", { severity: "high", opened_on: "2030-02-20", hold: "no" }, "Waiting on a vendor");
    await put(A, "a-none", { severity: "critical", opened_on: "2030-01-01" }, "No deadline for critical here");
    await put(B, "b-high", { severity: "high", opened_on: "2030-02-01" }, "B's own item");
    const emails = () => (http.mock.state.emails as any[]).filter((e) => e.tags?.some((t: any) => t.value === "clock_step"));
    const events = async (o: { orgId: number }, key?: string) => db.query<{ record_key: string; clock: string; step: string; detail: any }>(
      "SELECT record_key, clock, step, detail FROM workspace_clock_events WHERE org_id = $1 AND ($2::text IS NULL OR record_key = $2) ORDER BY id", [o.orgId, key ?? null]);
    const stepsOf = async (o: { orgId: number }, key: string) => (await events(o, key)).filter((e) => e.clock === "fix_by").map((e) => e.step);

    // ---------- 4 and 5. the check, for A alone first ----------
    {
      const r = await rc.clockCheck(NOW0, { orgId: A.orgId });
      assert.equal(r.ran, true);
      assert.equal(r.workspaces, 1);
      assert.equal(r.records, 7, "A's seven records");
      assert.equal(await count("SELECT count(*)::int AS n FROM workspace_record_clocks WHERE org_id = $1", [B.orgId]), 0, "B untouched by A's check");
      assert.equal(await count("SELECT count(*)::int AS n FROM workspace_clock_events WHERE org_id = $1", [B.orgId]), 0);
      assert.deepEqual(await stepsOf(A, "a-high"), ["started", "escalate:0"], "overdue a day: the first escalation");
      assert.deepEqual(await stepsOf(A, "a-old"), ["started", "escalate:0", "escalate:1", "escalate:2"], "first seen 32 days overdue: every step");
      const old = (await events(A, "a-old")).filter((e) => e.step.startsWith("escalate"));
      assert.deepEqual(old.map((e) => e.detail.told), [[], [], ["owner"]], "only the latest tells");
      assert.ok(old[0]!.detail.skipped && old[1]!.detail.skipped);
      assert.deepEqual(old[1]!.detail.reassigned, { field: "owner_id", from: u1, to: u2 });
      assert.deepEqual(old[2]!.detail.raised, { field: "level", from: "l1", to: "l2" });
      const aOld = await recs(A).get("dl_items", "a-old");
      assert.deepEqual([aOld!.data.owner_id, aOld!.data.level], [u2, "l2"], "reassigned and raised through the record store");
      assert.deepEqual(await stepsOf(A, "a-soon"), ["started", "remind:0"], "due 03-08: the 7-day reminder");
      assert.deepEqual(await stepsOf(A, "a-capped"), ["started", "remind:0"], "capped at 03-05");
      assert.deepEqual(await stepsOf(A, "a-done"), ["started", "stopped"], "stopped: no step");
      assert.deepEqual(await stepsOf(A, "a-hold"), ["started"]);
      assert.deepEqual(await stepsOf(A, "a-none"), [], "no deadline: nothing");
      // Notices: one per record and deadline, in A only.
      const { listNotices } = await import("../src/schedules.js");
      const na = await listNotices(A.orgId);
      assert.deepEqual(na.filter((n) => n.kind === "clock").map((n) => `${n.key}@${n.due_on}`).sort(), ["a-capped@2030-03-05", "a-high@2030-03-03", "a-old@2030-01-31", "a-soon@2030-03-08"]);
      assert.match(na.find((n) => n.key === "a-old")!.what!, /Raised; told owner; raised Level to l2/);
      assert.deepEqual(await listNotices(B.orgId), [], "B has none");
      // Emails: one per person, with their steps: A's owner (escalations to owners), the assignee u1 (reminders, the first escalation of a-high).
      const sent = emails();
      const to = (e: any) => e.to[0] as string;
      const owner = sent.filter((e) => /^owner\+/.test(to(e)));
      const assignee = sent.filter((e) => /^assignee\+/.test(to(e)));
      assert.equal(owner.length, 1, "one email to A's owner");
      assert.match(owner[0].text, /Open port on the API/); assert.match(owner[0].text, /Stale secret/);
      assert.doesNotMatch(owner[0].text, /Old library|B's own item/, "a reminder to the assignee only; nothing of B");
      assert.equal(assignee.length, 1, "one email to the assignee");
      assert.match(assignee[0].text, /Old library/); assert.match(assignee[0].text, /Open port on the API/);
      assert.ok(!sent.some((e) => /^backup\+|^member\+/.test(to(e))), "nobody else");
      console.log("✓ the check for one workspace: clocks remembered, changes and steps recorded once per deadline; a record first seen long overdue does every step (reassigned, raised through the store) and tells only the latest; reminders to the assignee, escalations to owners: one notice per record, one email per person; the other workspace untouched");
    }
    // Every workspace; then again, and three at once: nothing more.
    {
      const before = { ev: await count("SELECT count(*)::int AS n FROM workspace_clock_events"), mails: emails().length };
      const r = await rc.clockCheck(NOW0, { force: true });
      assert.equal(r.workspaces, 2);
      assert.deepEqual(await stepsOf(B, "b-high"), ["started", "escalate:0"], "B's own record, in B's own scope");
      const ownerBMails = emails().slice(before.mails).filter((e) => new RegExp(`^owner\\+${B.orgId}-`).test(e.to[0]));
      assert.equal(ownerBMails.length, 1); assert.match(ownerBMails[0].text, /B's own item/); assert.doesNotMatch(ownerBMails[0].text, /Stale secret/);
      const mid = { ev: await count("SELECT count(*)::int AS n FROM workspace_clock_events"), mails: emails().length };
      assert.equal(mid.ev, before.ev + 3, "only B's three events are new (both clocks started, the first escalation)");
      const again = await Promise.all([rc.clockCheck(NOW0, { force: true }), rc.clockCheck(NOW0, { force: true }), rc.clockCheck(NOW0, { force: true })]);
      assert.deepEqual(again.map((x) => x.steps + x.changes + x.notices), [0, 0, 0], "nothing new");
      assert.equal(await count("SELECT count(*)::int AS n FROM workspace_clock_events"), mid.ev);
      assert.equal(emails().length, mid.mails, "no email twice");
      // The scheduler's tick runs it at most every 15 minutes.
      const t1 = await rc.clockCheck(new Date(NOW0.getTime() + 60_000));
      assert.equal(t1.ran, true, "the first unforced check");
      const t2 = await rc.clockCheck(new Date(NOW0.getTime() + 5 * 60_000));
      assert.deepEqual([t2.ran, t2.reason], [false, "checked less than 15 minutes ago"]);
      console.log("✓ every workspace in its own scope; running it again, or three at once, records, notices and emails nothing more; unforced, at most every 15 minutes");
    }
    // Tenant isolation at the database: A's scope cannot write B's clock rows or events, nor change an event.
    {
      await assert.rejects(withTenant(A.orgId, () => db.query("INSERT INTO workspace_record_clocks (org_id, pack, area, record_key, clock, status, evaluated_at) VALUES ($1, 'fixture_deadlines', 'dl_items', 'x', 'fix_by', 'overdue', now())", [B.orgId])), /row-level security|permission/);
      await assert.rejects(withTenant(A.orgId, () => db.query("INSERT INTO workspace_clock_events (org_id, pack, area, record_key, clock, step, mark, at) VALUES ($1, 'fixture_deadlines', 'dl_items', 'x', 'fix_by', 'started', 'z', now())", [B.orgId])), /row-level security|permission/);
      await assert.rejects(withTenant(A.orgId, () => db.query("UPDATE workspace_clock_events SET detail = '{}' WHERE org_id = $1", [A.orgId])), /permission/);
      await assert.rejects(withTenant(A.orgId, () => db.query("DELETE FROM workspace_clock_events WHERE org_id = $1", [A.orgId])), /permission/);
      const seen = await withTenant(A.orgId, () => db.query<{ org_id: number }>("/* tenant: test, A's scope reads every row it can */ SELECT DISTINCT org_id FROM workspace_record_clocks"));
      assert.deepEqual(seen.map((r) => r.org_id), [A.orgId], "A's scope sees its own clock rows only");
      const changed = await withTenant(A.orgId, () => db.query("UPDATE workspace_record_clocks SET status = 'met' WHERE org_id = $1 RETURNING org_id", [B.orgId]));
      assert.equal(changed.length, 0, "nor changes B's");
      console.log("✓ tenant isolation: a workspace's scope reads and writes its own clock rows only, records events for itself only, never changes or deletes one");
    }

    // ---------- a pause, a resolution, the next steps ----------
    {
      const NOW1 = new Date(NOW0.getTime() + DAY);
      await recs(A).update("dl_items", "a-hold", { title: "Waiting on a vendor", data: { severity: "high", opened_on: "2030-02-20", hold: "yes" } });
      await rc.clockCheck(NOW1, { force: true });
      const NOW3 = new Date(NOW1.getTime() + 6 * DAY);
      await recs(A).update("dl_items", "a-hold", { title: "Waiting on a vendor", data: { severity: "high", opened_on: "2030-02-20", hold: "no" } });
      await rc.clockCheck(NOW3, { force: true });
      assert.deepEqual(await stepsOf(A, "a-hold"), ["started", "paused", "resumed"]);
      rc.setClockNowForTest(() => NOW3);
      const v = (await recs(A).get("dl_items", "a-hold"))!.clocks!.fix_by!;
      assert.deepEqual([v.status, v.due_on, v.paused_ms], ["on_track", "2030-03-28", 6 * DAY], "paused six days: due six days later");
      // a-high resolved: stopped, missed (after its deadline); no further step.
      await recs(A).move("dl_items", "a-high", "done");
      const NOW4 = new Date(NOW0.getTime() + 8 * DAY);
      await rc.clockCheck(NOW4, { force: true });
      assert.deepEqual(await stepsOf(A, "a-high"), ["started", "escalate:0", "escalate:1", "stopped"], "a week overdue at the check before: reassigned (it had no backup: nothing changed); then stopped");
      rc.setClockNowForTest(() => NOW4);
      // Stopped when the lifecycle says it moved to done: the store stamps that with the wall clock (today, before this
      // test's 2030), so the stop is before the deadline: met. A stop after it is missed (the math above, at a date field).
      const stopped = (await recs(A).get("dl_items", "a-high"))!.clocks!.fix_by!;
      assert.deepEqual([stopped.status, stopped.stopped_at! < "2030"], ["met", true]);
      // a-soon (due 03-08) is overdue on 03-12: its first escalation tells the assignee and the owner.
      assert.deepEqual(await stepsOf(A, "a-soon"), ["started", "remind:0", "escalate:0"]);
      console.log("✓ a pause moves the deadline out by the time paused; a resolved record stops (at the time its lifecycle records) and takes no further step; a reminded record escalates once overdue");
    }

    // ---------- 6. reads ----------
    {
      const NOWR = new Date(NOW0.getTime() + 8 * DAY);
      rc.setClockNowForTest(() => NOWR);
      const h = (tok: string) => ({ authorization: `Bearer ${tok}` });
      const page = await (await http.req("GET", "/api/records/dl_items?limit=50", h(memberA))).json();
      const st = Object.fromEntries(page.records.map((r: any) => [r.key, r.clocks?.fix_by?.status]));
      assert.deepEqual(st, { "a-capped": "overdue", "a-done": "met", "a-high": "met", "a-hold": "on_track", "a-none": "not_started", "a-old": "overdue", "a-soon": "overdue" });
      assert.ok(page.records.every((r: any) => r.clocks.respond?.due_at), "every record has its response clock (2 business days from when it was added)");
      assert.deepEqual(page.area.clocks.map((c: any) => c.name), ["fix_by", "respond"], "the area's summary names its clocks");
      const detail = await (await http.req("GET", "/api/records/dl_items/a-old", h(memberA))).json();
      assert.equal(detail.record.clocks.fix_by.overdue, true);
      assert.ok(detail.clock_events.some((e: any) => /reassigned Owner/.test(e.what)), "the record page's history");
      assert.equal((await http.req("GET", "/api/records/dl_items/a-old", h(ownerB))).status, 404, "B never reaches A's record");
      const pageB = await (await http.req("GET", "/api/records/dl_items", h(ownerB))).json();
      assert.deepEqual(pageB.records.map((r: any) => r.key), ["b-high"]);
      const notices = await (await http.req("GET", "/api/notices", h(ownerA))).json();
      assert.ok(notices.notices.some((n: any) => n.kind === "clock" && n.key === "a-soon" && /Overdue/.test(n.what)));
      // The MCP tools: list_records says when each is due; list_due_records lists overdue and due soon, soonest first.
      assert.deepEqual(recordTools().map((t) => t.name), ["list_records", "get_record"]);
      const mcpA = await connect(A);
      try {
        const names = (await mcpA.client.listTools()).tools.map((t) => t.name);
        assert.ok(names.includes("list_due_records") && names.includes("list_records"));
        const lr = (await mcpA.call("list_records", { area: "dl_items" })).structuredContent;
        assert.ok(lr.records.find((r: any) => r.key === "a-old").due.some((d: any) => d.clock === "fix_by" && d.overdue === true));
        const due = (await mcpA.call("list_due_records", { area: "dl_items" })).structuredContent;
        assert.deepEqual(due.records.map((r: any) => r.key), ["a-old", "a-capped", "a-soon"], "overdue, soonest deadline first");
        assert.equal(due.records[0].title, "Stale secret");
        const met = (await mcpA.call("list_due_records", { area: "dl_items", status: ["met", "missed"] })).structuredContent;
        assert.deepEqual(met.records.map((r: any) => r.key).sort(), ["a-done", "a-high"]);
        assert.equal((await mcpA.call("list_due_records", { area: "dl_items", clock: "nope" })).isError, true);
      } finally { await mcpA.close(); }
      const mcpB = await connect(B);
      try {
        const due = (await mcpB.call("list_due_records", { area: "dl_items" })).structuredContent;
        assert.deepEqual(due.records.map((r: any) => r.key), ["b-high"], "B's own only");
      } finally { await mcpB.close(); }
      // A metric over a clock's status, and the default cards of a list tab.
      const { computeSpec, buildViews } = await import("../src/metrics.js");
      const m = buildViews().metrics.find((x) => x.name === "overdue_items")!;
      assert.equal((await computeSpec(A.orgId, m, SYSTEM_ACTOR, NOWR)).value, 3);
      assert.equal((await computeSpec(B.orgId, m, SYSTEM_ACTOR, NOWR)).value, 1);
      const { sparkPlan } = await import("../src/metric-spec.js");
      const cards = sparkPlan({ pack: "fixture_deadlines", id: "items", kind: "area", area: "dl_items" } as never, buildViews(), { readable: () => true, fill: (x) => x, label: "Items" });
      assert.deepEqual(cards.map((c) => c.id).slice(0, 2), ["_records", "_overdue"]);
      const od = cards.find((c) => c.id === "_overdue")!;
      assert.equal((await computeSpec(A.orgId, od.value, SYSTEM_ACTOR, NOWR)).value, 3, "the Overdue card");
      // The home page's Due soon card (mold_v0-207): every clock area and clock at once, overdue first, then the
      // soonest due; the workspace's own; the areas the role may read only.
      const ds = await (await http.req("GET", "/api/records/due-soon?limit=50", h(memberA))).json();
      assert.deepEqual(ds.areas.map((a: any) => a.name), ["dl_items"]);
      assert.deepEqual(ds.records.filter((r: any) => r.clock === "fix_by").map((r: any) => r.key), ["a-old", "a-capped", "a-soon"], "fix_by: overdue, soonest deadline first");
      assert.ok(ds.records.every((r: any) => ["overdue", "due_soon"].includes(r.status) && r.area_label === "Items" && r.clock_label), "only overdue or due soon, each with its area and clock");
      const rank = (r: any) => (r.status === "overdue" ? 0 : 1);
      assert.ok(ds.records.every((r: any, i: number) => i === 0 || rank(ds.records[i - 1]) < rank(r) || (rank(ds.records[i - 1]) === rank(r) && ds.records[i - 1].due_at <= r.due_at)), "overdue first, then by deadline");
      assert.equal(ds.total, ds.records.length);
      assert.equal(ds.records.find((r: any) => r.key === "a-old" && r.clock === "fix_by").title, "Stale secret");
      const ds6 = await (await http.req("GET", "/api/records/due-soon", h(memberA))).json();
      assert.equal(ds6.records.length, Math.min(6, ds.total), "six at most by default");
      const dsB = await (await http.req("GET", "/api/records/due-soon?limit=50", h(ownerB))).json();
      assert.deepEqual([...new Set(dsB.records.map((r: any) => r.key))], ["b-high"], "B's own only");
      assert.equal((await http.req("GET", "/api/records/due-soon")).status, 401, "signed in only");
      rc.setClockNowForTest(() => NOW0);
      const early = await (await http.req("GET", "/api/records/due-soon?limit=50", h(memberA))).json();
      const firstSoon = early.records.findIndex((r: any) => r.status === "due_soon");
      assert.ok(firstSoon > 0 && early.records.slice(firstSoon).every((r: any) => r.status === "due_soon"), "overdue rows before due soon ones");
      assert.ok(early.records.some((r: any) => r.key === "a-soon" && r.clock === "fix_by" && r.status === "due_soon"));
      rc.setClockNowForTest(() => NOWR);
      // An area the role may not read is left out: none to show, and no area named.
      setPacksForTest([{ manifest: { id: "fixture_deadlines", name: "Fixture deadlines", version: "1", entry: null, migrations: null, words: {}, dir: "." } as never,
        definition: definePack({ id: "fixture_deadlines", recordAreas: [{ ...AREA, permissions: { read: ["owner"] } }] as never }) }]);
      const denied = await (await http.req("GET", "/api/records/due-soon", h(memberA))).json();
      assert.deepEqual([denied.areas, denied.records], [[], []], "a member who may not read the area sees none of it");
      const owned = await (await http.req("GET", "/api/records/due-soon", h(ownerA))).json();
      assert.ok(owned.records.length > 0, "the owner still does");
      setPacksForTest([{ manifest: { id: "fixture_deadlines", name: "Fixture deadlines", version: "1", entry: null, migrations: null, words: {}, dir: "." } as never, definition: def }]);
      void listFor; void detailFor; void ownerA;
      console.log("✓ reads: pages and records carry each clock (status, due date), the record page its history, notices the latest step; list_records says when each is due; list_due_records lists a workspace's own, soonest first; a metric and the list tab's Overdue card count overdue records per workspace; the home page's Due soon card lists every clock's overdue then due-soon records, the workspace's own, for the roles that may read them");
    }
  } finally {
    rc.setClockNowForTest(null);
    await http.close();
  }
  await db.close();
  console.log("RECORD CLOCKS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
