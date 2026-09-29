/**
 * WHO MAY REACH A CONVERSATION — the access rules, executed.
 *
 * Every one of these was a hole, and every one of them was invisible to a test
 * that read the source and believed it. The gate in front of eve's own session
 * routes said "deny when the session belongs to someone else" in a comment and
 * allowed everybody in fact, because it asked the database a question the
 * database could not answer. So the rules are RUN here: the real decision
 * functions over the real inputs, and the real stream transform over real
 * NDJSON bytes.
 *
 * Six things it holds, in order:
 *
 *   1. the session gate (lib/chat-gate.ts — the ONE rule the agent and the web
 *      proxy both run) admits the recorded owner, a live member of a thread the
 *      OWNER shared (a viewer read-only), a workspace-visible step's colleagues,
 *      trusted services and a session-bound token for its one session — and
 *      refuses everyone else, INCLUDING for a session nobody has a record of
 *      (the old "unknown, allow" branch);
 *   2. the transcript-cache rule;
 *   3. a viewer's mount carries no continuation token, proved by running the
 *      proxy's redaction over a stream that contains one;
 *   4. a colleague cannot claim someone else's session, at the read rule and at
 *      the write path;
 *   5. an archived (un-shared) thread refuses, and deleting a chat takes the
 *      stored copy with it, server-side;
 *   6. `check:tenancy` FAILS on the shape of the original bug — the regression
 *      guard that matters as much as the fix, because the reason finding 1
 *      survived is that nothing ever scanned the file it lived in.
 *
 * The database-backed half — that the unscoped reads really do return zero rows
 * under the production fail-closed policy, which is the mechanism of the whole
 * thing — is scripts/test-chat-access-db.mjs, run by CI's `isolation` job
 * against a real Postgres.
 *
 * Run:  npm run test:chat-access
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { rightFor, sessionGateDecision } from "../lib/chat-gate.ts";
import { snapshotAccess } from "../lib/chat-snapshot.ts";
import { withoutContinuationTokens } from "../lib/chat-replay-stream.ts";

let failures = 0;
const check = (what, ok) => {
  if (ok) {
    console.log(`  ✓ ${what}`);
  } else {
    failures++;
    console.error(`  ✗ ${what}`);
  }
};

const ME = "analyst@onfinance.in";
const OWNER = "victim@onfinance.in";
const THREAD = { ownerEmail: OWNER };
const SID = "wrun_probe";

/** A session Alice-style owned, recorded by the agent at creation. */
const OWNED = {
  orgId: "org-a",
  ownerEmail: OWNER,
  ownerPrincipal: null,
  ownerKind: "person",
  visibility: "owner",
  rootSessionId: null,
  tokenSha256: "abc",
  source: "record",
};
const person = (email) => ({ kind: "person", email });

/** The gate, with a recorded owner and nothing else unless a case says otherwise. */
const gate = (over = {}) =>
  sessionGateDecision({
    caller: person(ME),
    sessionId: SID,
    right: "read",
    ownership: OWNED,
    membership: null,
    callerInWorkspace: false,
    localDevAllowed: false,
    ...over,
  });

/* ---- 1. the eve session gate --------------------------------------------- */

console.log("\nThe ownership gate in front of eve's session routes (agent AND web proxy):");

check(
  "a stranger who knows the id is refused a session that is not theirs",
  (() => {
    const d = gate();
    return !d.allow && d.reason === "not-yours";
  })(),
);
check("…whatever they ask to do", !gate({ right: "write" }).allow);
check("the recorded owner reads", gate({ caller: person(OWNER) }).allow);
check("…and writes (message, approval answer, cancel)", gate({ caller: person(OWNER), right: "write" }).allow);
check(
  "a live PARTICIPANT of a thread the owner shared reads and writes",
  gate({ membership: { role: "participant" } }).allow && gate({ membership: { role: "participant" }, right: "write" }).allow,
);
check(
  "a VIEWER reads…",
  (() => {
    const d = gate({ membership: { role: "viewer" } });
    return d.allow && d.role === "viewer";
  })(),
);
check(
  "…but may not send, answer an approval or cancel",
  (() => {
    const d = gate({ membership: { role: "viewer" }, right: "write" });
    return !d.allow && d.reason === "read-only";
  })(),
);
check(
  "a REVOKED member is refused (the reads never hand one over as membership)",
  !gate({ membership: null }).allow,
);
check(
  "a session NOBODY has a record of is REFUSED — the old 'debounce' allowance is gone",
  (() => {
    const d = gate({ ownership: null, caller: person(OWNER) });
    return !d.allow && d.reason === "unknown";
  })(),
);
check(
  "a workspace-visible step is open to its workspace's members…",
  gate({ ownership: { ...OWNED, visibility: "workspace" }, callerInWorkspace: true }).allow,
);
check(
  "…to READ only: a colleague may not steer, answer or cancel it",
  (() => {
    const d = gate({ ownership: { ...OWNED, visibility: "workspace" }, callerInWorkspace: true, right: "write" });
    return !d.allow && d.reason === "read-only";
  })(),
);
check(
  "…while its initiator keeps full rights",
  gate({ caller: person(OWNER), ownership: { ...OWNED, visibility: "workspace" }, right: "write" }).allow,
);
check("…and to nobody else", !gate({ ownership: { ...OWNED, visibility: "workspace" }, callerInWorkspace: false }).allow);
check("…while a private chat is not open to the workspace", !gate({ callerInWorkspace: true }).allow);
/*
 * A SERVICE is the platform acting for ONE workspace, on the sessions it runs there. It used to be admitted to ANY
 * session in the workspace it named — and to ANY session at all when it named none — so the front-end's token read a
 * person's private chat just by leaving the header off (mold_v1-130).
 */
const STEP = { ...OWNED, ownerEmail: null, ownerPrincipal: "svc", ownerKind: "service", visibility: "workspace" };
const svc = (serviceScope) => ({ kind: "service", email: null, principalId: "svc", serviceScope });
check(
  "a trusted service, naming the session's workspace, is admitted to a step it started there (read and write)",
  gate({ caller: svc("org-a"), ownership: STEP }).allow && gate({ caller: svc("org-a"), ownership: STEP, right: "write" }).allow,
);
check(
  "…and to a person's workflow/app step (workspace-visible), which the run-cancel fan-out must reach",
  gate({ caller: svc("org-a"), ownership: { ...OWNED, visibility: "workspace" }, right: "write" }).allow,
);
check(
  "…and to a step's delegated child (lineage carries the step's origin)",
  gate({ caller: svc("org-a"), ownership: { ...STEP, rootSessionId: "wrun_root", source: "lineage" }, right: "write" }).allow,
);
check(
  "a service naming NO workspace is refused — even its own step",
  (() => {
    const d = gate({ caller: svc(null), ownership: STEP });
    return !d.allow && d.reason === "no-workspace";
  })(),
);
check(
  "a service is refused a person's PRIVATE chat, even in the workspace it names",
  (() => {
    const d = gate({ caller: svc("org-a") });
    const w = gate({ caller: svc("org-a"), right: "write" });
    return !d.allow && d.reason === "not-yours" && !w.allow;
  })(),
);
check("…and with no header at all (the old any-workspace door)", !gate({ caller: svc(null) }).allow && !gate({ caller: svc("") }).allow);
// mold_v1-138: #69's one-release door for a headerless service stream read or cancel of a platform step is closed.
// The web app and agent deploy together and name the workspace on every call, so no header is refused everywhere.
check(
  "a headerless service is refused even a step the platform runs, to read or to cancel (no-workspace)",
  (() => {
    const read = gate({ caller: svc(null), ownership: STEP });
    const cancel = gate({ caller: svc(null), ownership: STEP, right: "write" });
    const blank = gate({ caller: svc("   "), ownership: STEP });
    return !read.allow && read.reason === "no-workspace" && !cancel.allow && cancel.reason === "no-workspace" && !blank.allow;
  })(),
);
check(
  "…and the transition input is gone from the gate and the agent's guard (not merely unset)",
  !/headerlessServiceTransition/.test(readFileSync(new URL("../lib/chat-gate.ts", import.meta.url), "utf8")) &&
    !/headerlessServiceTransition|HEADERLESS service/.test(readFileSync(new URL("../agent/lib/session-guard.ts", import.meta.url), "utf8")),
);
check(
  "…refused one naming a different workspace than the session's",
  (() => {
    const d = gate({ caller: svc("org-b"), ownership: STEP });
    return !d.allow && d.reason === "wrong-workspace";
  })(),
);
check("…and refused a session nobody recorded", !gate({ caller: { kind: "service", email: null }, ownership: null }).allow);
check(
  "a session-bound token opens its one session, for its owner — a POST token to write, any other to read",
  gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: SID, boundAct: "post" }, right: "write" }).allow &&
    gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: SID, boundAct: "read" }, right: "read" }).allow &&
    gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: SID }, right: "read" }).allow,
);
check(
  "…a READ token (or one naming no act) never writes; a POST token never reads (PR #63's token kinds)",
  !gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: SID, boundAct: "read" }, right: "write" }).allow &&
    !gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: SID }, right: "write" }).allow &&
    !gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: SID, boundAct: "post" }, right: "read" }).allow,
);
check(
  "…and no other, whatever email it carries",
  !gate({ caller: { kind: "session-bound", email: OWNER, boundSessionId: "wrun_other" } }).allow,
);
check(
  "…nor someone else's session it was (mis)bound to",
  !gate({ caller: { kind: "session-bound", email: ME, boundSessionId: SID } }).allow,
);
check(
  "a session-bound token is never read as its person (no membership widening)",
  !gate({ caller: { kind: "session-bound", email: ME, boundSessionId: "wrun_other" }, membership: { role: "participant" } }).allow,
);
check("eve dev's local-dev principal only where local development is allowed", gate({ caller: { kind: "local-dev", email: null }, localDevAllowed: true }).allow && !gate({ caller: { kind: "local-dev", email: null } }).allow);
check("a caller with no verified identity decides nothing", !gate({ caller: { kind: "none", email: null } }).allow);
check("…nor a person with an empty email", !gate({ caller: person("") }).allow);
check(
  "a principal with no email owns only what it created (by principal id)",
  gate({ caller: { kind: "principal", email: null, principalId: "p1" }, ownership: { ...OWNED, ownerEmail: null, ownerPrincipal: "p1" } }).allow &&
    !gate({ caller: { kind: "principal", email: null, principalId: "p2" }, ownership: { ...OWNED, ownerEmail: null, ownerPrincipal: "p1" } }).allow,
);
check(
  "the comparison is case- and space-insensitive, because a token subject is not normalised",
  gate({ caller: person("  Victim@OnFinance.in ") }).allow,
);
check(
  "a stream read is the only read; every other verb is a write",
  rightFor("GET", ["stream"]) === "read" && rightFor("POST", []) === "write" && rightFor("POST", ["cancel"]) === "write" && rightFor("GET", []) === "write",
);

/* ---- 2. who may replace the cached transcript ---------------------------- */

console.log("\nThe transcript cache — the most complete copy of a conversation we store:");

const access = (caller, thread, membership, ownsMirrorRow = false) =>
  snapshotAccess({ callerEmail: caller, thread, membership, ownsMirrorRow });

check("the thread's owner reads and writes", access(OWNER, THREAD, null).write);
check(
  "a PARTICIPANT reads but no longer writes — one event at the seam cannot vouch for a prefix",
  (() => {
    const a = access(ME, THREAD, { role: "participant", status: "accepted" });
    return a.read && !a.write;
  })(),
);
check(
  "a viewer reads but never writes",
  (() => {
    const a = access(ME, THREAD, { role: "viewer", status: "accepted" });
    return a.read && !a.write;
  })(),
);
check("a revoked member is cut off from the cache", !access(ME, THREAD, { role: "participant", status: "revoked" }).read);
check("someone it was never shared with is refused", !access(ME, THREAD, null).read);
check("a private chat's sole owner reads and writes it", access(ME, null, null, true).write);
check(
  "a colleague who CLAIMED the session gets nothing: an ambiguous claim is no claim",
  // `ownsMirrorRow` is false when the session has more than one claimant —
  // lib/chat-session-access.ts computes it from every mirror row, not just the
  // caller's, because minting one used to be a POST away.
  !access(ME, null, null, false).read,
);

/* ---- 3. the continuation token never reaches a shared thread's client ---- */

console.log("\nA shared thread's stream, through the proxy:");

const NDJSON = [
  JSON.stringify({ type: "message.appended", data: { turnId: "t1", stepIndex: 0, message: "hello" } }),
  JSON.stringify({ type: "session.waiting", data: { continuationToken: "ct_live_secret", turnId: "t1" } }),
  JSON.stringify({ type: "turn.completed", data: { turnId: "t1" } }),
].join("\n");

/** Feed the transform in the chunk shapes a real stream arrives in. */
async function through(text, chunkSize) {
  const bytes = new TextEncoder().encode(text);
  const upstream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  const reader = withoutContinuationTokens(upstream).getReader();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return new TextDecoder().decode(
    new Uint8Array(out.flatMap((chunk) => Array.from(chunk))),
  );
}

const whole = await through(NDJSON, NDJSON.length);
check("the live resume token is gone", !whole.includes("ct_live_secret"));
check("…and the key with it, because an EMPTY token is a rejected send, not a fallback", !whole.includes("continuationToken"));
check(
  "every event still arrives, in order, projectable",
  (() => {
    const lines = whole.trim().split("\n").map((l) => JSON.parse(l));
    return (
      lines.length === 3 &&
      lines[0].type === "message.appended" &&
      lines[0].data.message === "hello" &&
      lines[1].type === "session.waiting" &&
      lines[1].data.turnId === "t1" &&
      lines[2].type === "turn.completed"
    );
  })(),
);
// A chunk boundary inside the word "continuationToken" is exactly how a
// substring-based shortcut would leak it, so the token is hunted at every split.
const split = [];
for (let size = 1; size <= 24; size++) split.push(await through(NDJSON, size));
check(
  "…at every chunk boundary, including one through the middle of the key",
  split.every((s) => !s.includes("ct_live_secret") && !s.includes("continuationToken")),
);
check(
  "…and the transcript survives every one of those splits intact",
  split.every((s) => s.trim().split("\n").filter(Boolean).length === 3),
);
const unterminated = await through(NDJSON, NDJSON.length); // no trailing newline upstream
check("a stream that ends without a newline still has its last event redacted", !unterminated.includes("ct_"));

/* ---- 4-5. the routes say what the rules say ------------------------------ */

console.log("\nThe routes that carry those rules:");

const src = (p) => readFileSync(p, "utf8");
const gateRoute = src("app/eve/v1/session/[...segments]/route.ts");
const accessLib = src("lib/chat-session-access.ts");
const sessionsRoute = src("app/api/ops/chat-sessions/route.ts");
const threadRoute = src("app/api/ops/threads/[id]/route.ts");
const streamRoute = src("app/api/ops/threads/[id]/stream/route.ts");
const shell = src("app/_components/chat-shell.tsx");
const telemetryRoute = src("app/api/ops/chat-telemetry/route.ts");
const auditRoute = src("app/api/ops/orgs/[id]/audit/route.ts");

check(
  "the gate no longer queries an unscoped handle",
  !/\bdb\s*\.(select|insert|update|delete)\b/.test(gateRoute.replace(/\s+/g, " ")),
);
const sharedReads = src("lib/session-gate.ts");
const agentGuard = src("agent/lib/session-guard.ts");
check("the web proxy and the agent run ONE gate", /gateSessionRequest\(/.test(accessLib) && /from "\.\.\/\.\.\/lib\/session-gate\.ts"/.test(agentGuard) && /sessionGateDecision\(/.test(agentGuard));
check("…the proxy refuses with 404, never a 403 that confirms the id", /status: 404/.test(gateRoute) && !/status: 403/.test(gateRoute));
check("…and answers 503 when it cannot read — it no longer fails OPEN", /status: 503/.test(gateRoute) && !/FAILED OPEN/.test(gateRoute));
check("…the agent answers 503 too", /unavailable\(\)/.test(agentGuard) && /status: 503/.test(agentGuard));
check("every gate read runs inside a workspace scope", /inOrg: \(orgId, fn\) => withOrgRls\(orgId, fn\)/.test(accessLib) && !/\bdb\s*\.\s*select\(\)\.from\(chat/.test(sharedReads));
check("the gate's member lookup filters revoked rows", /ne\(chatThreadMembers\.status, "revoked"\)/.test(sharedReads));
check("…and counts only threads the session's OWNER shared", /lower\(\$\{chatThreads\.ownerEmail\}\) = \$\{owner\}/.test(sharedReads));
// The transcript cache (chat-snapshots, chat-replay) is the session gate's own decision now (mold_v1-129): it used to
// crown the sole chat-list claimant, a row the browser writes. Behaviour: scripts/test-session-guard.mjs.
const transcriptRule = sharedReads.slice(sharedReads.indexOf("export async function readTranscriptAccess"));
check("the transcript rule is the gate's (readTranscriptAccess)", /readTranscriptAccess\(webGateDb\(\), orgId, email, sessionId\)/.test(accessLib));
check(
  "…decided on the agent's owner record, never the chat list",
  /readOwnerRecordIn\(db, orgId, sessionId\)/.test(transcriptRule) && !/chatSessions/.test(transcriptRule.slice(0, transcriptRule.indexOf("\n}\n"))) && !/claimants/.test(accessLib),
);
check("…and it ignores an un-shared thread (the membership read skips archived threads)", /isNull\(chatThreads\.archivedAt\)/.test(sharedReads));
// The write itself lives in lib/chat-sessions-mirror.ts (shared with its database test); the route calls it.
const sessionsMirror = src("lib/chat-sessions-mirror.ts");
check(
  "the mirror write refuses a session someone else has already claimed",
  /writeMirrorRows\(inOrg/.test(sessionsRoute) &&
    /\.from\(chatSessions\)[\s\S]{0,200}inArray\(chatSessions\.eveSessionId, sessionIds\)/.test(sessionsMirror),
);
check(
  "…and a ROW someone else owns under that very id, whatever else the post says",
  /\.from\(chatSessions\)\.where\(inArray\(chatSessions\.id, ids\)\)/.test(sessionsMirror) && /foreignIds\.has\(s\.id\)/.test(sessionsMirror),
);
check(
  "deleting a chat deletes its cached transcript SERVER-SIDE",
  /\.delete\(chatTranscriptSnapshots\)/.test(sessionsRoute),
);
check("…and un-shares it, so members do not keep a deleted conversation", /archivedAt: new Date\(\)/.test(sessionsRoute));
check(
  "un-sharing a thread revokes its members",
  /status: "revoked", revokedAt: new Date\(\)/.test(threadRoute),
);
check("…and drops the relay's token with it", /continuationToken: null/.test(threadRoute));
check("the shared stream refuses an archived thread", /access\.thread\.archivedAt/.test(streamRoute));
check(
  "…and strips the resume token out of everything it forwards",
  /withoutContinuationTokens\(/.test(streamRoute),
);
check(
  "the shared mount no longer sets a continuation token",
  !/continuationToken: fresh\?\.continuationToken/.test(shell),
);
check("chat telemetry stores a hash, not the session id", /sessionTag\(sessionId\)/.test(telemetryRoute));
check("…derived with sha256", /createHash\("sha256"\)/.test(telemetryRoute));
check("the audit feed reads inside the workspace's scope", /withOrgRls\(id, \(tx\)/.test(auditRoute));
check("…and only for a workspace admin", /isOrgAdmin\(ctx\.role\)/.test(auditRoute));

/* ---- 6. the checker would now catch the original bug --------------------- */

console.log("\nThe regression guard:");

/**
 * Reproduce the SHAPE of finding 1 — a tenant read on the bare handle, in a
 * directory `scripts/check-tenancy.mjs` did not use to scan — and require the
 * ratchet to fail on it.
 *
 * This is the assertion that would have prevented the whole incident. The gate
 * was unscoped from the day it was written; the checker's web surface was
 * `grep -rl getOpsDb app/api`, and `app/eve/**` and `lib/**` were never in it,
 * so it reported clean for months about a file it had never opened.
 */
const PROBE = "lib/__tenancy_regression_probe__.ts";
writeFileSync(
  PROBE,
  `import { eq } from "drizzle-orm";
import { chatSessions } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";

/** The pre-fix session gate's read: a tenant table, no workspace named. */
export async function probe(sessionId: string) {
  const db = getOpsDb();
  if (!db) return [];
  return db.select().from(chatSessions).where(eq(chatSessions.eveSessionId, sessionId));
}
`,
);
let ratchetFailed = false;
let listed = "";
try {
  execFileSync("node", ["scripts/check-tenancy.mjs", "--list"], {
    encoding: "utf8",
    // Captured, not inherited: the ratchet's failure is this test's PASS, and
    // printing it in red under a green run is how a reader mistrusts both.
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  ratchetFailed = true;
  listed = `${e.stdout ?? ""}${e.stderr ?? ""}`;
} finally {
  rmSync(PROBE, { force: true });
}
check("check:tenancy fails on an unscoped tenant read in lib/", ratchetFailed);
check("…and names the file", listed.includes(PROBE));

// And it is green again the moment the probe is gone — a ratchet that stays red
// is one somebody turns off.
let cleanAgain = true;
try {
  execFileSync("node", ["scripts/check-tenancy.mjs"], { encoding: "utf8" });
} catch {
  cleanAgain = false;
}
check("…and passes again once it is removed", cleanAgain);

console.log(
  failures === 0
    ? "\ntest-chat-access: all assertions passed"
    : `\ntest-chat-access: ${failures} FAILED`,
);
assert.equal(failures, 0, `${failures} access-control assertion(s) failed`);
