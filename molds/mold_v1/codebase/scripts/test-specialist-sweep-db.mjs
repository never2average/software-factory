#!/usr/bin/env node
/**
 * THE SPECIALIST SWEEP'S LEDGER, ACROSS PROCESSES AND WORKSPACES — against a real Postgres (mold_v1-196).
 *
 * The sweep runs from a schedule and from every turn start, on any number of serverless instances. Its right to act
 * on a delegation is a row in `specialist_sweeps` (agent/lib/sweep-ledger.ts): this starts TWO SEPARATE node processes
 * per round, each with its own app_rw connection (no BYPASSRLS), releases them at the same instant, and requires
 * exactly one to win. Then: which rows a later sweep may take over (a stale claim, a pending or unread delivery, a
 * waiting note that turned into something to act on) and which never (a delivered one); the rows are their
 * workspace's; the chat's notes and the scheduled sweep's candidates are read in one workspace only; the wired sweep
 * (agent/lib/specialist-sweep-run.ts) acts on a main thread only in the workspace its owner record is in; the
 * scheduled pass reads only the main threads with a delegation still outstanding, after one catch-up pass over the
 * window (mold_v1-199: many finished threads cost no stream read, and (a)–(d) still hold); and drizzle/0034 and 0035
 * are additive, in step with schema.ts, with an empty drift plan after each.
 *
 * Needs ADMIN_URL (seeding, catalog reads) and DATABASE_URL (app_rw), a database built by `drizzle-kit push` +
 * scripts/bootstrap-test-db.mjs (CI's isolation job).
 *
 *   ADMIN_URL=… DATABASE_URL=postgres://app_rw:…  npm run test:specialist-sweep-db
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { ROOT, driftPlan, kit } from "./lib/drift-plan.mjs";

const SELF = fileURLToPath(import.meta.url);
const claimRow = (parent, call) => ({ parentSessionId: parent, callId: call, childSessionId: `wrun_sw_child_${call}`, name: "research", kind: "undelivered", since: Date.now() - 600_000, facts: { name: "research" } });

/* ---- worker: one "instance" ------------------------------------------------------------------------------------ */
if (process.argv[2] === "--worker") {
  const [, , , org, parent, call, startAt] = process.argv;
  const { agentGateDb } = await import("../agent/lib/session-owners.ts");
  const { sweepLedger } = await import("../agent/lib/sweep-ledger.ts");
  const db = agentGateDb();
  await db.ping();
  await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
  process.stdout.write(await sweepLedger(db, org).claim(claimRow(parent, call)));
  process.exit(0);
}

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl || !process.env.DATABASE_URL) {
  console.log("test-specialist-sweep-db: SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).");
  process.exit(0);
}
let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const admin = postgres(adminUrl, { ssl: /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const ORG_A = `org_sw_a_${process.pid}`;
const ORG_B = `org_sw_b_${process.pid}`;
const ORG_C = `org_sw_c_${process.pid}`;
const worker = (org, parent, call, startAt) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", SELF, "--worker", org, parent, call, String(startAt)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("exit", (code) => resolve(code === 0 ? out : `error: ${err.slice(-300)}`));
  });
const rowsOf = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

try {
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG_A}, 'Sweep A', 'active'), (${ORG_B}, 'Sweep B', 'active'), (${ORG_C}, 'Sweep C', 'active')`;

  console.log("the tables are tenant tables like their neighbours:");
  for (const table of ["specialist_sweeps", "specialist_sweep_settled"]) {
    const [rls] = await admin`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`;
    check(`row-level security is enabled and FORCED on ${table}`, rls?.relrowsecurity === true && rls?.relforcerowsecurity === true, rls);
    const policies = await admin`select policyname from pg_policies where tablename = ${table}`;
    check("…with the workspace policy", policies.some((p) => p.policyname === "org_isolation"), policies);
  }
  const [role] = await admin`select rolbypassrls from pg_roles where rolname = 'app_rw'`;
  check("…and the app's role cannot bypass it (or every check below would be vacuous)", role?.rolbypassrls === false, role);
  const pk = await admin`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'specialist_sweeps'::regclass and i.indisprimary`;
  check("…keyed by (main thread, call id): one row per delegation", pk.map((r) => r.attname).sort().join() === "call_id,parent_session_id", pk);

  console.log("\ntwo sweeps, two processes, one delegation, the same instant:");
  const ROUNDS = 12;
  const tally = [];
  for (let i = 0; i < ROUNDS; i++) {
    const startAt = Date.now() + 1_500;
    tally.push((await Promise.all([worker(ORG_A, `wrun_sw_parent_${process.pid}`, `call_${i}`, startAt), worker(ORG_A, `wrun_sw_parent_${process.pid}`, `call_${i}`, startAt)])).sort().join("+"));
  }
  check(`${ROUNDS} rounds of two simultaneous claims: exactly one wins every time`, tally.every((t) => t === "held+won"), tally);
  const rows = await admin`select count(*)::int as n from specialist_sweeps where org_id = ${ORG_A}`;
  check("…one row per delegation, not two", rows[0].n === ROUNDS, rows);

  console.log("\nwhat a later sweep may take over, and what never:");
  const { agentGateDb } = await import("../agent/lib/session-owners.ts");
  const { sweepLedger, sweepNotes, sweepCandidates } = await import("../agent/lib/sweep-ledger.ts");
  const db = agentGateDb();
  const a = sweepLedger(db, ORG_A);
  const b = sweepLedger(db, ORG_B);
  const P = `wrun_sw_p_${process.pid}`;
  const row = (call, kind = "undelivered") => ({ ...claimRow(P, call), kind });
  check("a fresh claim is won", (await a.claim(row("c1"))) === "won");
  check("…and held against a second sweep while it is being acted on", (await a.claim(row("c1"))) === "held");
  await a.settle(P, "c1", "pending");
  check("a PENDING outcome is not retaken at once (a pass is not repeated back to back)", (await a.claim(row("c1"))) === "held");
  await admin`update specialist_sweeps set updated_at = now() - interval '5 minutes' where parent_session_id = ${P} and call_id = 'c1'`;
  check("…but is retaken once it is stale (the next pass tries again)", (await a.claim(row("c1"))) === "won");
  await a.settle(P, "c1", "sent");
  await admin`update specialist_sweeps set updated_at = now() - interval '5 minutes' where parent_session_id = ${P} and call_id = 'c1'`;
  check("a SENT delivery the main agent has not read is retaken when stale (re-sent; eve drops a second copy)", (await a.claim(row("c1", "unreported"))) === "won");
  const [kept] = await admin`select kind from specialist_sweeps where parent_session_id = ${P} and call_id = 'c1'`;
  check("…and keeps what it was (a frozen one the sweep stopped reads 'stopped' next time; its note still says why)", kept?.kind === "undelivered", kept);
  await a.settle(P, "c1", "delivered");
  await admin`update specialist_sweeps set updated_at = now() - interval '5 hours' where parent_session_id = ${P} and call_id = 'c1'`;
  check("a DELIVERED one is never claimed again, however old", (await a.claim(row("c1"))) === "held");
  await a.claim(row("c2", "frozen"));
  await admin`update specialist_sweeps set updated_at = now() - interval '10 minutes' where parent_session_id = ${P} and call_id = 'c2' and status = 'claimed'`;
  check("a claim whose holder went quiet (a frozen instance) is taken over", (await a.claim(row("c2", "frozen"))) === "won");
  await a.settle(P, "c2", "delivered");
  check("a frozen one stopped by the sweep is listed until its run is ended", JSON.stringify((await a.frozenToEnd(P)).map((r) => r.callId)) === '["c2"]');
  await a.ended(P, "c2");
  check("…and not after", (await a.frozenToEnd(P)).length === 0);

  console.log("\nthe waiting note (d):");
  await a.surfaceWaiting(row("c3", "waiting"));
  await a.surfaceWaiting(row("c3", "waiting"));
  const [w] = await admin`select kind, status from specialist_sweeps where parent_session_id = ${P} and call_id = 'c3'`;
  check("surfacing twice leaves one waiting note", w?.kind === "waiting" && w?.status === "surfaced", w);
  await a.surfaceWaiting(row("c1", "waiting"));
  const [c1] = await admin`select kind, status from specialist_sweeps where parent_session_id = ${P} and call_id = 'c1'`;
  check("surfacing never overwrites what the sweep did (c1 stays delivered)", c1?.kind === "undelivered" && c1?.status === "delivered", c1);
  check("a waiting delegation that turns into something to act on is claimed (the note gives way)", (await a.claim(row("c3", "frozen"))) === "won");
  await a.settle(P, "c3", "delivered");
  await a.surfaceWaiting(row("c4", "waiting"));
  await a.surfaceWaiting(row("c5", "waiting"));
  await a.clearWaiting(P, ["c5"]);
  const waits = await admin`select call_id, status from specialist_sweeps where parent_session_id = ${P} and kind = 'waiting' order by call_id`;
  check("notes of delegations that no longer wait are cleared; the one still waiting stays", JSON.stringify(waits.map((r) => `${r.call_id}:${r.status}`)) === '["c4:cleared","c5:surfaced"]', waits);

  console.log("\none workspace's rows, and its alone:");
  const seenFromB = rowsOf(await db.inOrg(ORG_B, (tx) => tx.execute(`select count(*)::int as n from specialist_sweeps where parent_session_id = '${P}'`)));
  check("another workspace cannot see the rows", Number(seenFromB[0].n) === 0, seenFromB);
  check("…cannot claim them", (await b.claim(row("c5", "frozen"))) === "held");
  await b.settle(P, "c5", "delivered");
  await b.clearWaiting(P, []);
  await b.ended(P, "c2");
  const [c5] = await admin`select org_id, status from specialist_sweeps where parent_session_id = ${P} and call_id = 'c5'`;
  check("…and cannot settle, clear or end them", c5?.org_id === ORG_A && c5?.status === "surfaced", c5);
  const notesA = await sweepNotes(db, ORG_A, P);
  const notesB = await sweepNotes(db, ORG_B, P);
  check("the chat's notes: what the sweep did and what it surfaces, in the workspace's own scope", notesA.map((n) => `${n.kind}:${n.status}`).sort().join() === "frozen:delivered,frozen:delivered,undelivered:delivered,waiting:surfaced" && notesB.length === 0, { notesA, notesB });
  await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) VALUES (${`wrun_sw_main_${process.pid}`}, ${ORG_A}, 'owner@sweep.test', 'person', 'owner')`;
  await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, root_session_id, parent_session_id) VALUES (${`wrun_sw_kid_${process.pid}`}, ${ORG_A}, 'owner@sweep.test', 'person', 'owner', ${`wrun_sw_main_${process.pid}`}, ${`wrun_sw_main_${process.pid}`})`;
  const candA = await sweepCandidates(db, ORG_A, 3_600_000);
  const candB = await sweepCandidates(db, ORG_B, 3_600_000);
  check("the scheduled sweep's main threads: one that delegated recently, and one with an open note — in that workspace only", candA.includes(`wrun_sw_main_${process.pid}`) && candA.includes(P) && candB.length === 0, { candA, candB });

  console.log("\nthe wired sweep acts on a main thread only in the workspace its owner record is in:");
  const { sweepOneMainThread } = await import("../agent/lib/specialist-sweep-run.ts");
  const MAIN = `wrun_sw_main_${process.pid}`;
  const KID = `wrun_sw_kid_${process.pid}`;
  const old = (ms) => ({ at: new Date(Date.now() - ms).toISOString() });
  const streams = {
    [MAIN]: [
      { type: "turn.started", data: { turnId: "turn_0" }, meta: old(900_000) },
      { type: "subagent.called", data: { callId: "call_kid", childSessionId: KID, name: "research", toolName: "research", turnId: "turn_0", detachable: true }, meta: old(900_000) },
      { type: "action.result", data: { result: { callId: "call_kid", kind: "subagent-result", subagentName: "research", output: { status: "running", childSessionId: KID, name: "research" } } }, meta: old(890_000) },
      { type: "session.waiting", data: { continuationToken: "tok_main" }, meta: old(880_000) },
    ],
    [KID]: [
      { type: "turn.started", data: { turnId: "turn_0" }, meta: old(800_000) },
      { type: "message.completed", data: { message: "THE LOST RESULT", finishReason: "stop" }, meta: old(700_000) },
      { type: "session.completed", data: {}, meta: old(700_000) },
    ],
  };
  const delivered = [];
  const runtime = {
    async events(id, startIndex = 0) {
      const all = streams[id] ?? [];
      const from = startIndex < 0 ? Math.max(0, all.length + startIndex) : startIndex;
      return new ReadableStream({ start(c) { for (const e of all.slice(from)) c.enqueue(e); } });
    },
    async cancel() { return { status: "accepted" }; },
    async terminate() { return true; },
    async handOver() { return false; },
    async deliverLateResult(input) {
      delivered.push({ sessionId: input.sessionId, tokens: input.continuationTokens, result: input.result });
      streams[MAIN].push({ type: "action.result", data: { result: input.result }, meta: { at: new Date().toISOString() } });
      return true;
    },
  };
  const settings = { enabled: true, frozenMs: 1_800_000, graceMs: 120_000, waitingMs: 14_400_000, lookbackMs: 259_200_000 };
  const fromB = await sweepOneMainThread(db, ORG_B, MAIN, { runtime, settings });
  check("from another workspace: nothing (its owner record is not there)", fromB.length === 0 && delivered.length === 0, { fromB, delivered });
  const fromKid = await sweepOneMainThread(db, ORG_A, KID, { runtime, settings });
  check("a delegation's own session is never swept as a main thread", fromKid.length === 0 && delivered.length === 0, fromKid);
  const fromA = await sweepOneMainThread(db, ORG_A, MAIN, { runtime, settings });
  check("in its own workspace: the finished specialist's lost result is delivered to that main thread, once", fromA.length === 1 && fromA[0].action === "delivered" && delivered.length === 1 && delivered[0].sessionId === MAIN && delivered[0].result.output === "THE LOST RESULT" && delivered[0].tokens.includes("tok_main"), { fromA, delivered });
  const [ledgered] = await admin`select org_id, kind, status, name from specialist_sweeps where parent_session_id = ${MAIN} and call_id = 'call_kid'`;
  check("…and the ledger says so, in that workspace", ledgered?.org_id === ORG_A && ledgered?.kind === "undelivered" && ledgered?.status === "delivered", ledgered);
  const again = await sweepOneMainThread(db, ORG_A, MAIN, { runtime, settings });
  check("a second pass finds nothing owed and delivers nothing more", again.length === 0 && delivered.length === 1, again);

  console.log("\nthe scheduled pass, and its one line (mold_v1-198):");
  {
    const { sweepAllWorkspaces } = await import("../agent/lib/specialist-sweep-run.ts");
    const MAIN2 = `wrun_sw_main2_${process.pid}`;
    const KID2 = `wrun_sw_kid2_${process.pid}`;
    await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) VALUES (${MAIN2}, ${ORG_A}, 'owner@sweep.test', 'person', 'owner')`;
    await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, root_session_id, parent_session_id) VALUES (${KID2}, ${ORG_A}, 'owner@sweep.test', 'person', 'owner', ${MAIN2}, ${MAIN2})`;
    streams[MAIN2] = streams[MAIN].slice(0, 4).map((e) => JSON.parse(JSON.stringify(e).replaceAll(KID, KID2).replaceAll("call_kid", "call_kid2")));
    streams[KID2] = streams[KID].map((e) => JSON.parse(JSON.stringify(e).replace("THE LOST RESULT", "THE SECOND LOST RESULT")));
    const lines = [];
    const errors = [];
    const tally = await sweepAllWorkspaces({ inOrg: db.inOrg, listOrgs: async () => [ORG_A] }, { runtime, settings, log: (l) => lines.push(l), logError: (l) => errors.push(l) });
    check("one pass over a workspace writes ONE line, with what it did: the lost result delivered (acted on 1, undelivered 1)", lines.length === 1 && errors.length === 0 && /acted on 1 \(frozen 0, undelivered 1, unreported 0, surfaced \d+\)/.test(lines[0]) && tally.undelivered === 1 && tally.threads >= 2 && tally.outstanding >= 1, { lines, errors, tally });
    check("…counts only: no session id, no call id, no workspace id, nothing a session said", !/wrun_|call_|org_sw|LOST RESULT/.test(lines[0]), lines[0]);
    check("…and that main thread got its result", delivered.some((d) => d.sessionId === MAIN2 && d.result.output === "THE SECOND LOST RESULT"));
    const again = [];
    await sweepAllWorkspaces({ inOrg: db.inOrg, listOrgs: async () => [ORG_A] }, { runtime, settings, log: (l) => again.push(l), logError: (l) => again.push(l) });
    check("the next pass, with nothing to do, still writes its one line (acted on 0)", again.length === 1 && /acted on 0 \(frozen 0, undelivered 0, unreported 0, surfaced \d+\)/.test(again[0]), again);
  }

  /* ---- mold_v1-199: a pass reads only the threads with a delegation outstanding ----------------------------------- */
  console.log("\nonly the main threads with a delegation outstanding are read (mold_v1-199):");
  {
    const { sweepAllWorkspaces } = await import("../agent/lib/specialist-sweep-run.ts");
    const { markSettled } = await import("../agent/lib/sweep-ledger.ts");
    const ago = (ms) => ({ at: new Date(Date.now() - ms).toISOString() });
    const MIN = 60_000;
    const FINISHED = 40;
    const pid = process.pid;
    const st = {};
    /** A main thread that called one specialist; `delivered`: its real result is on the main thread's stream. */
    const thread = (main, kid, { delivered = false, child }) => {
      st[main] = [
        { type: "turn.started", data: { turnId: "turn_0" }, meta: ago(6 * 60 * MIN) },
        { type: "subagent.called", data: { callId: `call_${kid}`, childSessionId: kid, name: "research", toolName: "research", turnId: "turn_0", detachable: true }, meta: ago(6 * 60 * MIN) },
        delivered
          ? { type: "action.result", data: { result: { callId: `call_${kid}`, kind: "subagent-result", subagentName: "research", output: "DONE" } }, meta: ago(6 * 60 * MIN - 5_000) }
          : { type: "action.result", data: { result: { callId: `call_${kid}`, kind: "subagent-result", subagentName: "research", output: { status: "running", childSessionId: kid, name: "research" } } }, meta: ago(6 * 60 * MIN - 5_000) },
        { type: "turn.completed", data: { turnId: "turn_0" }, meta: ago(6 * 60 * MIN - 6_000) },
        { type: "session.waiting", data: { continuationToken: `tok_${main}` }, meta: ago(6 * 60 * MIN - 6_000) },
      ];
      st[kid] = child;
    };
    const finishedChild = (agoMs, text) => [
      { type: "turn.started", data: { turnId: "turn_0" }, meta: ago(agoMs + MIN) },
      { type: "message.completed", data: { message: text, finishReason: "stop" }, meta: ago(agoMs) },
      { type: "session.completed", data: {}, meta: ago(agoMs) },
    ];
    const owners = [];
    const seed = (main, kid) => owners.push([main, null], [kid, main]);
    for (let i = 0; i < FINISHED; i++) {
      const main = `wrun_sw_done_${pid}_${i}`;
      const kid = `wrun_sw_donekid_${pid}_${i}`;
      thread(main, kid, { delivered: true, child: finishedChild(6 * 60 * MIN - 4_000, "DONE") });
      seed(main, kid);
    }
    // (a) frozen, (b) finished and never handed back, (c) crashed and never reported, (d) waiting on a person: each
    // recorded before the settled marks existed, so the catch-up pass must find it.
    const M = { a: `wrun_sw_froz_${pid}`, b: `wrun_sw_lost_${pid}`, c: `wrun_sw_crash_${pid}`, d: `wrun_sw_ask_${pid}` };
    const K = { a: `wrun_sw_frozkid_${pid}`, b: `wrun_sw_lostkid_${pid}`, c: `wrun_sw_crashkid_${pid}`, d: `wrun_sw_askkid_${pid}` };
    thread(M.a, K.a, { child: [{ type: "turn.started", data: { turnId: "turn_0" }, meta: ago(50 * MIN) }, { type: "step.started", data: {}, meta: ago(45 * MIN) }] });
    thread(M.b, K.b, { child: finishedChild(10 * MIN, "THE CAUGHT-UP RESULT") });
    thread(M.c, K.c, { child: [{ type: "turn.started", data: { turnId: "turn_0" }, meta: ago(20 * MIN) }, { type: "session.failed", data: { message: "Sandbox bootstrap failed" }, meta: ago(10 * MIN) }] });
    thread(M.d, K.d, { child: [{ type: "turn.started", data: { turnId: "turn_0" }, meta: ago(5 * 60 * MIN + 30_000) }, { type: "input.requested", data: { requests: [{ requestId: "r1" }] }, meta: ago(5 * 60 * MIN) }, { type: "turn.completed", data: {}, meta: ago(5 * 60 * MIN) }, { type: "session.waiting", data: {}, meta: ago(5 * 60 * MIN) }] });
    for (const x of ["a", "b", "c", "d"]) seed(M[x], K[x]);
    for (const [sid, root] of owners) {
      await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, root_session_id, parent_session_id) VALUES (${sid}, ${ORG_C}, 'owner@sweep.test', 'person', 'owner', ${root}, ${root})`;
    }
    let read = new Set();
    const sent = [];
    const cancelled = [];
    const rtC = {
      async events(id, startIndex = 0) {
        read.add(id);
        const all = st[id] ?? [];
        const from = startIndex < 0 ? Math.max(0, all.length + startIndex) : startIndex;
        return new ReadableStream({ start(c) { for (const e of all.slice(from)) c.enqueue(e); } });
      },
      async cancel(id) {
        cancelled.push(id);
        st[id].push({ type: "turn.cancelled", data: {}, meta: ago(0) }, { type: "session.waiting", data: {}, meta: ago(0) });
        return { status: "accepted" };
      },
      async terminate() { return true; },
      async handOver() { return false; },
      async deliverLateResult(input) {
        sent.push({ sessionId: input.sessionId, result: input.result });
        st[input.sessionId].push({ type: "action.result", data: { result: input.result }, meta: ago(0) });
        return true;
      },
    };
    const pass = async () => {
      read = new Set();
      const lines = [];
      const tally = await sweepAllWorkspaces({ inOrg: db.inOrg, listOrgs: async () => [ORG_C] }, { runtime: rtC, settings, log: (l) => lines.push(l), logError: (l) => lines.push(l) });
      return { tally, lines, read: [...read].sort() };
    };
    const mains = (r) => r.read.filter((id) => !/kid_/.test(id));
    const finishedRead = (r) => r.read.filter((id) => /wrun_sw_done/.test(id));

    const first = await pass();
    check(`the catch-up pass (no settled marks yet) reads the ${FINISHED + 4} threads that delegated in the window, as before`, first.tally.threads === FINISHED + 4 && mains(first).length === FINISHED + 4, { tally: first.tally, mains: mains(first).length });
    check("…and reads no finished specialist's own stream (only those of delegations still owed)", first.read.filter((id) => /donekid_/.test(id)).length === 0, first.read.filter((id) => /donekid_/.test(id)).slice(0, 3));
    check("…and settles what was lost before the marks existed: (a) frozen, (b) undelivered, (c) unreported, (d) surfaced", first.tally.frozen === 1 && first.tally.undelivered === 1 && first.tally.unreported === 1 && first.tally.surfaced === 1 && first.tally.outstanding === 4, first.tally);
    const byMain = (m) => sent.filter((d) => d.sessionId === m);
    check("(a) the frozen one: told 'stopped, and why' once, then stopped", byMain(M.a).length === 1 && byMain(M.a)[0].result.output?.reason === "no-progress" && cancelled.includes(K.a), { sent: byMain(M.a), cancelled });
    check("(b) the lost result delivered once, as the delegation's own", byMain(M.b).length === 1 && byMain(M.b)[0].result.output === "THE CAUGHT-UP RESULT");
    check("(c) the crash reported once", byMain(M.c).length === 1 && byMain(M.c)[0].result.isError === true && /Sandbox bootstrap failed/.test(byMain(M.c)[0].result.output?.message ?? ""), byMain(M.c));
    check("(d) the one waiting on a person: never stopped, nothing delivered", byMain(M.d).length === 0 && !cancelled.includes(K.d));
    const [marked] = await admin`select count(*)::int as n from specialist_sweep_settled where org_id = ${ORG_C}`;
    check(`…and the ${FINISHED} finished delegations are marked settled (the four owed ones are not)`, marked.n === FINISHED, marked);

    const second = await pass();
    check("the next pass reads no finished thread: only the four it acted on or surfaced (to see each settled, once)", finishedRead(second).length === 0 && JSON.stringify(mains(second)) === JSON.stringify([M.a, M.b, M.c, M.d].sort()) && second.tally.threads === 4, { mains: mains(second), tally: second.tally });
    check("…delivering nothing a second time (exactly once)", sent.length === 3 && second.tally.frozen + second.tally.undelivered + second.tally.unreported === 0, { sent: sent.length, tally: second.tally });

    const third = await pass();
    check("THEN A PASS READS ONLY THE OUTSTANDING DELEGATION: its main thread and its specialist, nothing else", JSON.stringify(third.read) === JSON.stringify([K.d, M.d].sort()) && third.tally.threads === 1 && third.tally.outstanding === 1 && third.tally.surfaced === 1, { read: third.read, tally: third.tally });
    check("…and its line has the same shape", third.lines.length === 1 && /^\[specialist-sweep\] pass: 1 thread\(s\) checked in 1 workspace\(s\), 1 delegation\(s\) outstanding, acted on 0 \(frozen 0, undelivered 0, unreported 0, surfaced 1\) in \d+ ms$/.test(third.lines[0]), third.lines);
    const [noted] = await admin`select status from specialist_sweeps where parent_session_id = ${M.d}`;
    check("…(d) is still surfaced, never stopped", noted?.status === "surfaced" && !cancelled.includes(K.d), noted);

    // A new delegation after the catch-up is picked up by the next pass, and settled once.
    const NEWM = `wrun_sw_new_${pid}`;
    const NEWK = `wrun_sw_newkid_${pid}`;
    thread(NEWM, NEWK, { child: finishedChild(10 * MIN, "THE NEW RESULT") });
    await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) VALUES (${NEWM}, ${ORG_C}, 'owner@sweep.test', 'person', 'owner')`;
    await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, root_session_id, parent_session_id) VALUES (${NEWK}, ${ORG_C}, 'owner@sweep.test', 'person', 'owner', ${NEWM}, ${NEWM})`;
    const fourth = await pass();
    check("a delegation made after the catch-up is read on the next pass and its lost result delivered once", JSON.stringify(mains(fourth)) === JSON.stringify([M.d, NEWM].sort()) && byMain(NEWM).length === 1 && byMain(NEWM)[0].result.output === "THE NEW RESULT" && fourth.tally.undelivered === 1, { mains: mains(fourth), tally: fourth.tally });
    await pass();
    const fifth = await pass();
    check("…and once seen settled it costs nothing again", JSON.stringify(mains(fifth)) === JSON.stringify([M.d]) && byMain(NEWM).length === 1, mains(fifth));

    // A nested specialist (its record names a specialist as its parent) never holds its main thread open.
    const NEST = `wrun_sw_nestkid_${pid}`;
    await admin`INSERT INTO agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, root_session_id, parent_session_id) VALUES (${NEST}, ${ORG_C}, 'owner@sweep.test', 'person', 'owner', ${`wrun_sw_done_${pid}_0`}, ${`wrun_sw_donekid_${pid}_0`})`;
    const nested = await pass();
    check("a nested specialist's record does not make its main thread a candidate", JSON.stringify(mains(nested)) === JSON.stringify([M.d]), mains(nested));

    // The marks are the workspace's own.
    const fromB = rowsOf(await db.inOrg(ORG_B, (tx) => tx.execute(`select count(*)::int as n from specialist_sweep_settled where parent_session_id like 'wrun_sw_%'`)));
    check("another workspace cannot see the settled marks", Number(fromB[0].n) === 0, fromB);
    await markSettled(db, ORG_B, M.d, [K.d]);
    const [stillOpen] = await admin`select count(*)::int as n from specialist_sweep_settled where parent_session_id = ${M.d}`;
    check("…and a mark written from another workspace lands there, never closing this one's delegation", stillOpen.n === 1 && (await pass()).read.includes(M.d), stillOpen);
    await admin`delete from specialist_sweep_settled where org_id = ${ORG_B}`;
    check("…nor does it make that workspace see this one's threads", (await sweepCandidates(db, ORG_B, 3_600_000)).length === 0);
  }

  /* ---- the migrations: additive, in step with schema.ts, the drift plan empty after each --------------------------- */
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  for (const { TAG, TABLE } of [
    { TAG: "0034_specialist_sweeps", TABLE: "specialist_sweeps" },
    { TAG: "0035_specialist_sweep_settled", TABLE: "specialist_sweep_settled" },
  ]) {
    console.log(`\ndrizzle/${TAG}.sql on a database as the live ones are before it:`);
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1 && journal.entries.every((e, i) => e.idx === i), journal.entries.slice(at - 1, at + 2));
    const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
    const others = new RegExp(`\\bALTER\\s+TABLE\\s+"(?!${TABLE}")`, "i");
    check("it is additive: it creates one table (and its index), and alters or drops nothing else", statements.every((x) => { const code = x.replace(/^--.*$/gm, ""); return !/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i.test(code) && !others.test(code); }), statements.map((x) => x.split("\n").pop().slice(0, 60)));
    const SCRATCH = `swmig_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl: false, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      check("a database built from schema.ts has the table", pushed.status === 0 && (await sdb`select 1 from information_schema.tables where table_name = ${TABLE}`).length === 1, pushed.out.slice(-300));
      await sdb.unsafe(`drop table "${TABLE}"`);
      const before = driftPlan(scratchUrl);
      check(`before ${TAG.slice(0, 4)} the drift plan against schema.ts names the table, and only it (so an empty plan after means something)`, !before.error && before.apply.length >= 1 && before.apply.every((x) => x.includes(`"${TABLE}"`)) && before.refused.length === 0, before.error ? before : { apply: before.apply.map((x) => x.slice(0, 80)), refused: before.refused });
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check(`after ${TAG.slice(0, 4)} the drift dry run plans NOTHING to apply, and refuses nothing`, !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
      check("…what it sets aside is only policy / row-level-security noise", !after.error && after.aside.every((x) => !/COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)), after.aside);
      const [flags] = await sdb`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${TABLE}`;
      const pol = await sdb`select policyname, qual, with_check from pg_policies where tablename = ${TABLE}`;
      check("the migration itself enables and forces row-level security and creates the workspace policy", flags?.relrowsecurity && flags?.relforcerowsecurity && pol.length === 1 && pol[0].policyname === "org_isolation" && /app\.org_id/.test(pol[0].qual) && /app\.org_id/.test(pol[0].with_check), { flags, pol });
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      check("run again it changes nothing", (await sdb`select policyname from pg_policies where tablename = ${TABLE}`).length === 1 && driftPlan(scratchUrl).apply?.length === 0);
    } finally {
      await sdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
    }
  }
} finally {
  await admin`delete from specialist_sweeps where org_id in (${ORG_A}, ${ORG_B}, ${ORG_C})`.catch(() => {});
  await admin`delete from specialist_sweep_settled where org_id in (${ORG_A}, ${ORG_B}, ${ORG_C})`.catch(() => {});
  await admin`delete from agent_session_owners where org_id in (${ORG_A}, ${ORG_B}, ${ORG_C})`.catch(() => {});
  await admin`delete from orgs where org_id in (${ORG_A}, ${ORG_B}, ${ORG_C})`.catch(() => {});
  await admin.end({ timeout: 2 });
}
if (failures.length) {
  console.error(`\ntest-specialist-sweep-db: ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\ntest-specialist-sweep-db: ${passed} checks passed`);
process.exit(0);
