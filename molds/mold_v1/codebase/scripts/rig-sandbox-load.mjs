#!/usr/bin/env node
/**
 * DO SPECIALISTS GET A WORKING SANDBOX UNDER LOAD? — N delegated turns started at once against a running app, each
 * delegating to K specialists in one step; every specialist runs bash in two SEPARATE model steps.
 *
 *   RIG_BASE=https://app.example.com RIG_TOKEN=<a signed-in session token> [RIG_ORG=<workspace id>] \
 *     node scripts/rig-sandbox-load.mjs [--turns 3] [--per-turn 2] [--specialists a,b,c] [--steps 2]
 *                                       [--max-start-s 60] [--max-bash-s 60] [--timeout-s 420] [--json]
 *
 * For every specialist session it reports:
 *   start     seconds from `subagent.called` on the main thread to the specialist's own `session.started` (the
 *             specialist's sandbox is opened in between, so a VM that is slow to boot or queued shows up here)
 *   bash      for each of its bash calls: ok, or the error text; and how long the call itself took
 *   verdict   ok when every bash call printed its marker; else the first failure ("no agent socket found" is the
 *             defect mold_v1-183: a later step reusing a sandbox that the end of the previous step had stopped; a call
 *             that never returned, or an `echo` slower than --max-bash-s, is a sandbox stuck under it). The guard's own
 *             plain answers (mold_v1-190) are named apart: `watchdog` (a guest hung, the call was answered within
 *             SANDBOX_STALL_S and the VM replaced) and `no-free-sandbox` (the running cap's wait ran out)
 *
 * TIME IN LINE IS NOT A STUCK SANDBOX (mold_v1-190 follow-up). Under the running cap a call's time from outside is
 * its wait for a sandbox plus its run; measured on 2026-10-06, an 85 s echo had waited 81 s and run 3 s. The guard
 * logs where a slow call's time went (`[sandbox] timing: ...`, agent/lib/sandbox-guard.ts). So:
 *   --rows-out FILE                     also write each specialist's recorded events (for a later --judge)
 *   --judge FILE --server-log LOG       judge a recorded run again with the agent API's journal lines: each call's
 *                                       wait against --max-wait-s (240: SANDBOX_WAIT_S 180 + one abandoned 60 s boot),
 *                                       its run against --max-run-s (90: SANDBOX_STALL_S 60 + the 20 s before the
 *                                       watchdog's first check + 10 s), and a late start less the time its sandbox
 *                                       waited to open. `slow-wait` is a call that waited longer than its bound.
 * `provision.py <app> --sandbox-load` does both: the run, then the judgement with the server's lines.
 *
 *   inconclusive  the model did not do what it was asked (fewer bash calls, no delegation): says nothing about sandboxes
 *
 * Exit 0 `sandbox-load: pass` when no specialist hit a sandbox failure or a start slower than --max-start-s and at
 * least one was conclusive. Exit 1 `sandbox-load: fail` with the counts. Exit 3 `sandbox-load: skipped` when RIG_BASE or
 * RIG_TOKEN is missing. `--self-test` checks the verdicts on recorded event shapes, offline. The token is read from the environment (`MOLD_V1_SESSION_TOKEN` is accepted for it) and
 * never printed. Times are `meta.at`, eve's own server-side timestamps.
 *
 * It starts test chats and real model calls, so run it where test chats are welcome.
 */
import http from "node:http";
import https from "node:https";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const SELF_TEST = argv.includes("--self-test");
const JUDGE = opt("judge", "");
const OFFLINE = SELF_TEST || Boolean(JUDGE);
const BASE = SELF_TEST ? "http://self-test.invalid" : JUDGE ? "http://judge.invalid" : (process.env.RIG_BASE ?? "").replace(/\/$/, "");
const TOKEN = OFFLINE ? "offline" : (process.env.RIG_TOKEN ?? process.env.MOLD_V1_SESSION_TOKEN ?? "").trim();
if (!BASE || !TOKEN) {
  console.log("sandbox-load: skipped — set RIG_BASE (the app's address) and RIG_TOKEN (a signed-in session token). See the header.");
  process.exit(3);
}
const ORG = process.env.RIG_ORG ?? "";
const TURNS = Math.max(1, Number(opt("turns", "3")));
const PER_TURN = Math.max(1, Number(opt("per-turn", "2")));
const STEPS = Math.max(1, Number(opt("steps", "2")));
const SPECIALISTS = opt("specialists", "agent").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_START_S = Number(opt("max-start-s", "60"));
const MAX_BASH_S = Number(opt("max-bash-s", "60")); // each call is an `echo`: anything near this is a sandbox stuck under it
const TIMEOUT_S = Number(opt("timeout-s", "420"));
const JSON_OUT = argv.includes("--json");
// mold_v1-190 follow-up: under the running cap a call's time is mostly time in line. Judged apart, with the guard's
// own timing lines (agent/lib/sandbox-guard.ts `timing`): the wait against SANDBOX_WAIT_S plus one abandoned boot, the
// run against SANDBOX_STALL_S plus the 20 s before the watchdog's first check and a margin.
const MAX_WAIT_S = Number(opt("max-wait-s", "240"));
const MAX_RUN_S = Number(opt("max-run-s", "90"));
const ROWS_OUT = opt("rows-out", "");
const SERVER_LOG = opt("server-log", "");

const target = new URL(BASE);
const lib = target.protocol === "https:" ? https : http;
const prefix = target.pathname.replace(/\/$/, "");
const headers = () => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "user-agent": "rig-sandbox-load",
  ...(ORG ? { "x-ops-org": ORG } : {}),
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = lib.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: "POST", path: `${prefix}${path}`, headers: headers() }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("request timed out")));
    req.end(JSON.stringify(body));
  });
}

/** Read a session's durable stream until `until(event)` or `timeoutMs`; token deltas are dropped. */
function read(sessionId, { until, timeoutMs }) {
  return new Promise((resolve) => {
    const events = [];
    let seen = 0;
    let done = false;
    let req;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      req?.destroy();
      resolve({ events, why });
    };
    const limit = setTimeout(() => finish("timeout"), timeoutMs);
    const open = () => {
      if (done) return;
      req = lib.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: "GET", path: `${prefix}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${seen}`, headers: headers() }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if ([401, 403, 404].includes(res.statusCode ?? 0)) return finish(`http ${res.statusCode}`);
          return void setTimeout(open, 1_000);
        }
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim() || done) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            seen += 1;
            if (/\.appended$/.test(event.type)) continue;
            events.push(event);
            if (until(event)) return finish("until");
          }
        });
        res.on("end", () => setTimeout(open, 500));
        res.on("error", () => setTimeout(open, 500));
      });
      req.on("error", () => setTimeout(open, 1_000));
      req.end();
    };
    open();
  });
}

const at = (event) => (event?.meta?.at ? Date.parse(event.meta.at) : NaN);
const secs = (ms) => (Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);

const tool = (name) => (name === "agent" ? "the built-in `agent` tool" : `the tool named \`${name}\` (a declared specialist)`);
function childMessage(tag) {
  const steps = Array.from({ length: STEPS }, (_, i) => `Step ${i + 1}${i ? ", in a SEPARATE tool call made only after you have seen the previous result" : ""}: use your bash tool to run exactly: echo SBX-${tag}-${i + 1}`);
  return `${steps.join(". ")}. Then reply with exactly the outputs, one per line, or the exact error text of any call that failed. Use no other tool. Do not ask anything.`;
}
function turnMessage(turn) {
  const calls = Array.from({ length: PER_TURN }, (_, k) => {
    const name = SPECIALISTS[(turn * PER_TURN + k) % SPECIALISTS.length];
    return { name, tag: `T${turn}K${k}` };
  });
  const list = calls.map((c, k) => `${k + 1}. ${tool(c.name)} with the message '${childMessage(c.tag)}'`).join(" ");
  return {
    calls,
    message: `This is an automated check of sandboxes. Do exactly what is asked and nothing else. Do not ask me anything. In ONE step, make these ${calls.length} delegation(s) at the same time: ${list} When all have handed back, reply to me with exactly: LOAD-DONE.`,
  };
}

/** What one specialist's own events say about its sandbox. Pure: the self-test feeds it recorded shapes. */
/**
 * The guard's timing lines for one session, from the agent API's journal (`journalctl -o short-iso`, or the same lines
 * without the host prefix). Returns { opens: [{ at, waitedMs }], commands: [{ at, waitedMs, ranMs }] } per session id.
 */
export function parseServerTimings(text) {
  const bySession = new Map();
  const of = (id) => bySession.get(id) ?? (bySession.set(id, { opens: [], commands: [] }), bySession.get(id));
  for (const line of String(text).split("\n")) {
    const at = Date.parse(line.split(" ")[0]);
    if (!Number.isFinite(at)) continue;
    let m;
    if ((m = /\[sandbox\] timing: a command \(session (\S+), .*\) waited ([\d.]+) s for its sandbox and ran ([\d.]+) s/.exec(line)))
      of(m[1]).commands.push({ at, waitedMs: Number(m[2]) * 1000, ranMs: Number(m[3]) * 1000 });
    else if ((m = /\[sandbox\] timing: a sandbox \(session (\S+), .*\) opened after ([\d.]+) s/.exec(line))) of(m[1]).opens.push({ at, waitedMs: Number(m[2]) * 1000 });
  }
  return bySession;
}

/** The timing line closest to `at` within [at - before, at + after] (journal times are whole seconds). */
function nearest(list, at, before = 3_000, after = 2_000) {
  let best = null;
  for (const t of list ?? []) if (t.at >= at - before && t.at <= at + after && (!best || Math.abs(t.at - at) < Math.abs(best.at - at))) best = t;
  return best;
}

export function verdictOf(events, calledAt, { steps = STEPS, maxStartS = MAX_START_S, maxBashS = MAX_BASH_S, maxWaitS = MAX_WAIT_S, maxRunS = MAX_RUN_S, why = "until", timings = null } = {}) {
  const started = events.find((e) => e.type === "session.started");
  const requested = new Map();
  const bash = [];
  for (const e of events) {
    if (e.type === "actions.requested") for (const a of e.data?.actions ?? []) if (a.toolName === "bash") requested.set(a.callId, { at: at(e), command: String(a.input?.command ?? "") });
    if (e.type === "action.result" && e.data?.result?.toolName === "bash") {
      const r = requested.get(e.data.result.callId);
      const out = e.data.result.output;
      const stdout = typeof out === "object" && out ? String(out.stdout ?? "") : "";
      const marker = /SBX-\S+/.exec(r?.command ?? "")?.[0];
      const failure = e.data.error?.message ?? (typeof out === "string" ? out : null);
      const t = timings ? nearest(timings.commands, at(e)) : null;
      bash.push({ ok: !failure && (!marker || stdout.includes(marker)), ms: r ? at(e) - r.at : NaN, error: failure, ...(t ? { waitedMs: t.waitedMs, ranMs: t.ranMs } : {}) });
    }
  }
  const startMs = started ? at(started) - calledAt : NaN;
  // The sandbox a specialist opens before its session starts may have waited for a place: that is not a slow start.
  const opened = started && timings ? nearest(timings.opens, at(started), at(started) - calledAt + 1_000, 3_000) : null;
  const startOwnMs = opened ? Math.max(0, startMs - opened.waitedMs) : startMs;
  const last = events[events.length - 1];
  const failed = bash.find((b) => !b.ok);
  // A bash call that was asked for and never answered: the sandbox hung under it (seen live: a guest at 100% CPU).
  const answered = new Set(events.filter((e) => e.type === "action.result").map((e) => e.data?.result?.callId));
  const hung = [...requested.entries()].find(([id]) => !answered.has(id));
  let kind = "ok";
  let verdict = "ok";
  if (!started) [kind, verdict] = ["never-started", `never started (${why})`];
  else if (failed) {
    // mold_v1-190: the guard's two plain answers are named apart. Both are failures of that call, but bounded ones:
    // `watchdog` is a guest that hung and was replaced (before the guard, a call that never returned); `no-free-sandbox`
    // is the running cap's bounded wait running out (the host was full for SANDBOX_WAIT_S).
    const text = failed.error ?? "bash did not print its marker";
    const retried = bash.slice(bash.indexOf(failed) + 1).some((b) => b.ok) ? " (a later call worked)" : "";
    if (/^Waiting for a free sandbox/.test(text)) [kind, verdict] = ["no-free-sandbox", `${text.slice(0, 160)}${retried}`];
    else if (/The sandbox stopped responding/.test(text)) [kind, verdict] = ["watchdog", `a guest hung and the guard answered after ${secs(failed.ms)} s and replaced it${retried}`];
    else [kind, verdict] = ["sandbox", text];
  }
  else if (hung) [kind, verdict] = ["sandbox", `a bash call never returned: the sandbox hung under \`${hung[1].command.slice(0, 40)}\` (reading stopped: ${why})`];
  else if (startOwnMs > maxStartS * 1000) [kind, verdict] = ["slow-start", `started ${secs(startMs)} s after it was called (limit ${maxStartS} s${opened ? `, of which ${secs(opened.waitedMs)} s waiting for a sandbox` : ""})`];
  else if (bash.some((b) => b.ranMs !== undefined && b.ranMs > maxRunS * 1000)) {
    const b = bash.find((x) => x.ranMs !== undefined && x.ranMs > maxRunS * 1000);
    [kind, verdict] = ["slow-bash", `a bash \`echo\` RAN ${secs(b.ranMs)} s in its sandbox (limit ${maxRunS} s, after ${secs(b.waitedMs)} s waiting): the sandbox was stuck under it`];
  } else if (bash.some((b) => b.waitedMs !== undefined && b.waitedMs > maxWaitS * 1000)) {
    const b = bash.find((x) => x.waitedMs !== undefined && x.waitedMs > maxWaitS * 1000);
    [kind, verdict] = ["slow-wait", `a bash call waited ${secs(b.waitedMs)} s for a sandbox (limit ${maxWaitS} s)`];
  } else if (bash.some((b) => b.ranMs === undefined && b.ms > maxBashS * 1000))
    [kind, verdict] = ["slow-bash", `a bash \`echo\` took ${secs(Math.max(...bash.filter((b) => b.ranMs === undefined).map((b) => b.ms)))} s (limit ${maxBashS} s)${timings ? " and the server said nothing of where the time went" : ": the sandbox was stuck under it, or it waited for a place (run with the server's lines: --judge)"}`];
  else if (bash.length < steps) [kind, verdict] = ["inconclusive", `the model made ${bash.length} of ${steps} bash call(s) (${last?.type ?? why})`];
  if (kind === "ok") {
    const queued = bash.filter((b) => b.waitedMs >= 1_000).map((b) => secs(b.waitedMs));
    if (queued.length || opened) verdict = `ok (waited for a sandbox: ${[...(opened ? [`${secs(opened.waitedMs)} s to open`] : []), ...queued.map((q) => `${q} s`)].join(", ")})`;
  }
  return {
    startS: secs(startMs),
    bash: bash.map((b) => ({ ok: b.ok, s: secs(b.ms), ...(b.waitedMs !== undefined ? { waitedS: secs(b.waitedMs), ranS: secs(b.ranMs) } : {}), ...(b.error ? { error: b.error.slice(0, 200) } : {}) })),
    kind,
    verdict,
  };
}

async function runChild(turn, call) {
  const { events, why } = await read(call.child, { timeoutMs: TIMEOUT_S * 1000, until: (e) => ["session.completed", "session.failed", "session.waiting", "input.requested"].includes(e.type) });
  return { turn, name: call.name, child: call.child, ...verdictOf(events, call.calledAt, { why }), recorded: { events: events.map(slim), calledAt: call.calledAt, why } };
}

/** What the verdict reads of an event, and nothing else (what --rows-out keeps for --judge). */
function slim(e) {
  const d = e.data ?? {};
  return {
    type: e.type,
    meta: { at: e.meta?.at },
    data: {
      ...(d.actions ? { actions: d.actions.map((a) => ({ callId: a.callId, toolName: a.toolName, input: { command: a.input?.command } })) } : {}),
      ...(d.result ? { result: { callId: d.result.callId, toolName: d.result.toolName, output: d.result.output } } : {}),
      ...(d.error ? { error: { message: d.error.message } } : {}),
    },
  };
}

async function runTurn(turn) {
  const { calls, message } = turnMessage(turn);
  const res = await post("/eve/v1/session", { message });
  const sessionId = res.json?.sessionId;
  if (!sessionId) return [{ turn, name: "-", child: null, startS: null, bash: [], kind: "inconclusive", verdict: `the app opened no session (${res.status})` }];
  const { events } = await read(sessionId, {
    timeoutMs: TIMEOUT_S * 1000,
    until: (e) => e.type === "turn.failed" || e.type === "session.failed" || e.type === "turn.completed",
  });
  const called = events.filter((e) => e.type === "subagent.called").map((e) => ({ name: e.data.name, child: e.data.childSessionId, calledAt: at(e) }));
  if (called.length === 0) return [{ turn, name: "-", child: null, startS: null, bash: [], kind: "inconclusive", verdict: `the main agent delegated to nobody (${events.slice(-1)[0]?.type ?? "no events"})` }];
  const rows = await Promise.all(called.map((c) => runChild(turn, c)));
  if (called.length < calls.length) rows.push({ turn, name: "-", child: null, startS: null, bash: [], kind: "inconclusive", verdict: `the main agent delegated to ${called.length} of ${calls.length}` });
  return rows;
}

function selfTest() {
  const t = (s) => ({ meta: { at: new Date(Date.parse("2026-10-05T19:30:00Z") + s * 1000).toISOString() } });
  const ev = (s, type, data = {}) => ({ ...t(s), type, data });
  const req = (s, id, command) => ev(s, "actions.requested", { actions: [{ callId: id, toolName: "bash", input: { command } }] });
  const ok = (s, id, stdout) => ev(s, "action.result", { result: { callId: id, toolName: "bash", output: { exitCode: 0, stdout, stderr: "" } } });
  const fail = (s, id, message) => ev(s, "action.result", { error: { code: "ACTION_RESULT_FAILED", message }, result: { callId: id, toolName: "bash", output: message } });
  const dead = (s, id) => ev(s, "action.result", { error: { code: "ACTION_RESULT_FAILED", message: 'runtime error: no agent socket found for sandbox "eve-sbx-ses-e148"' }, result: { callId: id, toolName: "bash", output: 'runtime error: no agent socket found for sandbox "eve-sbx-ses-e148"' } });
  const cases = [
    ["two steps, both work", [ev(2, "session.started"), req(6, "a", "echo SBX-T0K0-1"), ok(6.1, "a", "SBX-T0K0-1\n"), req(20, "b", "echo SBX-T0K0-2"), ok(20.1, "b", "SBX-T0K0-2\n"), ev(25, "session.completed")], "ok"],
    // recorded on the first self-hosted server, 2026-10-05 19:30, timings kept
    ["the second step's bash finds no agent socket (mold_v1-183)", [ev(2, "session.started"), req(6.4, "a", "echo SBX-T0K0-1"), ok(6.5, "a", "SBX-T0K0-1\n"), req(61.7, "b", "echo SBX-T0K0-2"), dead(61.7, "b"), ev(67.4, "session.completed")], "sandbox"],
    ["started three minutes after it was called (mold_v1-183)", [ev(182, "session.started"), req(186, "a", "echo SBX-T0K0-1"), ok(186.1, "a", "SBX-T0K0-1\n"), req(190, "b", "echo SBX-T0K0-2"), ok(190.1, "b", "SBX-T0K0-2\n")], "slow-start"],
    ["never started", [], "never-started"],
    ["the model ran bash once instead of twice", [ev(2, "session.started"), req(6, "a", "echo SBX-T0K0-1"), ok(6.1, "a", "SBX-T0K0-1\n"), ev(9, "session.completed")], "inconclusive"],
    // recorded on the first self-hosted server, 2026-10-05 19:58: the guest took the request and spun at 100% CPU
    ["an echo that took 304 s (a guest stuck, then back)", [ev(9, "session.started"), req(44, "a", "echo SBX-T2K1-1"), ok(348, "a", "SBX-T2K1-1\n"), req(360, "b", "echo SBX-T2K1-2"), ok(360.1, "b", "SBX-T2K1-2\n")], "slow-bash"],
    ["a bash call that never returns (a hung guest)", [ev(12, "session.started"), ev(14, "step.started"), req(48, "a", "echo SBX-T0K1-1")], "sandbox"],
    // mold_v1-190, the guard's plain answers
    ["a hung guest answered by the watchdog, the model's retry works", [ev(3, "session.started"), req(6, "a", "echo SBX-T0K0-1"), fail(87, "a", "The sandbox stopped responding (nothing came back from it for 60 s), so this command was stopped and the sandbox is being restarted. Run the command again. Files from earlier steps are kept."), req(95, "c", "echo SBX-T0K0-1"), ok(99, "c", "SBX-T0K0-1\n"), req(110, "b", "echo SBX-T0K0-2"), ok(110.1, "b", "SBX-T0K0-2\n")], "watchdog"],
    ["no free sandbox within the bounded wait", [ev(3, "session.started"), req(6, "a", "echo SBX-T0K0-1"), fail(186, "a", "Waiting for a free sandbox: all 2 sandboxes this server runs at once are in use, and none came free within 180 s. Nothing was run. Try again in a minute or two.")], "no-free-sandbox"],
  ];
  // mold_v1-190 follow-up: the same calls judged with the guard's timing lines (recorded 2026-10-06, 12:00-12:05)
  const T0 = Date.parse("2026-10-05T19:30:00Z");
  const iso = (sec) => new Date(T0 + sec * 1000).toISOString().replace(/\.\d+Z$/, "+00:00");
  const line = (sec, text) => `${iso(sec)} ubuntu node[1]: [sandbox] ${text}`;
  const queued85 = [ev(1, "session.started"), req(19, "a", "echo SBX-T3K2-1"), ok(104, "a", "SBX-T3K2-1\n"), req(170, "b", "echo SBX-T3K2-2"), ok(170.1, "b", "SBX-T3K2-2\n")];
  const judged = [
    ["an 85 s echo that waited 81 s in line and ran 3 s: ok", queued85, [line(104, "timing: a command (session S1, …k) waited 81.0 s for its sandbox and ran 3.1 s")], "ok"],
    ["the same echo with no server line: still slow-bash", queued85, [], "slow-bash"],
    ["an echo that RAN 92 s in its sandbox: slow-bash", queued85, [line(104, "timing: a command (session S1, …k) waited 0.0 s for its sandbox and ran 92.0 s")], "slow-bash"],
    ["a call that waited 250 s for a place: slow-wait", queued85, [line(104, "timing: a command (session S1, …k) waited 250.0 s for its sandbox and ran 0.1 s")], "slow-wait"],
    ["started 65 s late, of which 62 s opening its sandbox: ok", [ev(65, "session.started"), req(70, "a", "echo SBX-1"), ok(70.1, "a", "SBX-1\n"), req(80, "b", "echo SBX-2"), ok(80.1, "b", "SBX-2\n")], [line(64, "timing: a sandbox (session S1, …k) opened after 61.7 s")], "ok"],
    ["started 65 s late with no sandbox wait to explain it: slow-start", [ev(65, "session.started"), req(70, "a", "echo SBX-1"), ok(70.1, "a", "SBX-1\n"), req(80, "b", "echo SBX-2"), ok(80.1, "b", "SBX-2\n")], [], "slow-start"],
  ];
  for (const [what, events, lines, want] of judged) {
    const timings = parseServerTimings(lines.join("\n")).get("S1") ?? { opens: [], commands: [] };
    const got = verdictOf(events, T0, { steps: 2, maxStartS: 60, maxBashS: 60, maxWaitS: 240, maxRunS: 90, why: "until", timings });
    cases.push([`judged: ${what}`, null, want, got]);
  }
  let failed = 0;
  for (const [what, events, want, pre] of cases) {
    if (pre) {
      const pass = pre.kind === want;
      if (!pass) failed += 1;
      console.log(`  ${pass ? "ok  " : "FAIL"} ${what}: ${pre.kind}${pass ? "" : ` (expected ${want}; ${pre.verdict})`}`);
      continue;
    }
    const got = verdictOf(events, Date.parse("2026-10-05T19:30:00Z"), { steps: 2, maxStartS: 60, why: "timeout" });
    const pass = got.kind === want;
    if (!pass) failed += 1;
    console.log(`  ${pass ? "ok  " : "FAIL"} ${what}: ${got.kind}${pass ? "" : ` (expected ${want}; ${got.verdict})`}`);
  }
  console.log(failed ? `rig-sandbox-load --self-test: ${failed} FAILED` : `rig-sandbox-load --self-test: ${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
if (SELF_TEST) selfTest();

const t0 = Date.now();
let rows;
if (JUDGE) {
  // Judge a recorded run again, with what the server logged meanwhile (scripts' caller: provision.py --sandbox-load).
  const { readFileSync } = await import("node:fs");
  const recorded = JSON.parse(readFileSync(JUDGE, "utf8"));
  const timings = SERVER_LOG ? parseServerTimings(readFileSync(SERVER_LOG, "utf8")) : new Map();
  rows = recorded.rows.map((r) =>
    r.recorded
      ? { ...r, ...verdictOf(r.recorded.events, r.recorded.calledAt, { why: r.recorded.why, timings: timings.get(r.child) ?? { opens: [], commands: [] } }) }
      : r,
  );
} else rows = (await Promise.all(Array.from({ length: TURNS }, (_, i) => runTurn(i)))).flat();
if (ROWS_OUT && !JUDGE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(ROWS_OUT, JSON.stringify({ rows }));
}
const conclusive = rows.filter((r) => r.kind !== "inconclusive");
const ok = rows.filter((r) => r.kind === "ok");
const bad = rows.filter((r) => r.kind !== "ok" && r.kind !== "inconclusive");
const starts = rows.map((r) => r.startS).filter((s) => s !== null && Number.isFinite(s)).sort((a, b) => a - b);
const pct = (p) => (starts.length ? starts[Math.min(starts.length - 1, Math.floor((p / 100) * starts.length))] : null);
const reasons = {};
for (const r of rows) {
  if (r.kind === "ok") continue;
  const why = `${r.kind}: ${r.verdict.replace(/eve-sbx-ses-[0-9a-f]+/g, "<sandbox>").replace(/\d+(\.\d+)? s after/, "… s after").slice(0, 120)}`;
  reasons[why] = (reasons[why] ?? 0) + 1;
}
const summary = {
  base: BASE,
  turns: TURNS,
  perTurn: PER_TURN,
  stepsPerSpecialist: STEPS,
  specialists: rows.filter((r) => r.child).length,
  working: ok.length,
  sandboxFailures: bad.length,
  inconclusive: rows.length - conclusive.length,
  startSeconds: { min: starts[0] ?? null, p50: pct(50), p90: pct(90), max: starts[starts.length - 1] ?? null },
  failures: reasons,
  wallSeconds: secs(Date.now() - t0),
};
if (JSON_OUT) console.log(JSON.stringify({ summary, rows: rows.map(({ recorded, ...r }) => r) }, null, 2));
else {
  if (JUDGE) console.log(`judged with ${SERVER_LOG ? "the server's timing lines" : "no server lines"}: a call's wait against ${MAX_WAIT_S} s, its run against ${MAX_RUN_S} s`);
  const shown = (b) => (b.ok ? (b.waitedS !== undefined ? `ok(${b.s}s = wait ${b.waitedS} + run ${b.ranS})` : `ok(${b.s}s)`) : "FAIL");
  for (const r of rows) console.log(`turn ${r.turn}  ${r.name.padEnd(24)} start ${r.startS === null ? "-" : `${r.startS}s`.padStart(6)}  bash ${r.bash.map(shown).join(",") || "-"}  ${r.verdict}`);
  console.log(
    `\n${ok.length} of ${conclusive.length} conclusive specialist session(s) got a working sandbox in every step (${rows.length - conclusive.length} inconclusive); ` +
      `start delay s: min ${summary.startSeconds.min} p50 ${summary.startSeconds.p50} p90 ${summary.startSeconds.p90} max ${summary.startSeconds.max}; wall ${summary.wallSeconds}s`,
  );
  for (const [why, n] of Object.entries(reasons)) console.log(`  ${n} × ${why}`);
}
const pass = bad.length === 0 && ok.length > 0;
console.log(`sandbox-load: ${pass ? "pass" : "fail"}`);
process.exit(pass ? 0 : 1);
