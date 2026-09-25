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
 *   1. the session gate refuses a stranger, refuses a revoked member, and still
 *      allows a session nobody has any record of (the debounce asymmetry);
 *   2. a session known in ANOTHER workspace is not "unknown" — the difference
 *      between "we looked and found nothing" and "we cannot see";
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
import { sessionGateDecision } from "../lib/chat-gate.ts";
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

/** The gate, with nothing recorded anywhere unless a case says otherwise. */
const gate = (over = {}) =>
  sessionGateDecision({
    callerEmail: ME,
    mirrorOwners: [],
    threads: [],
    isMember: false,
    knownElsewhere: false,
    ...over,
  });

/* ---- 1. the eve session gate --------------------------------------------- */

console.log("\nThe ownership gate in front of eve's session routes:");

check(
  "a stranger who knows the id is refused a session that is not theirs",
  (() => {
    const d = gate({ mirrorOwners: [OWNER] });
    return !d.allow && d.reason === "not-yours";
  })(),
);
check(
  "…and refused a SHARED thread they were never invited to",
  !gate({ threads: [THREAD] }).allow,
);
check("the owner of the mirrored chat is allowed", gate({ callerEmail: OWNER, mirrorOwners: [OWNER] }).allow);
check("the owner of the thread is allowed", gate({ callerEmail: OWNER, threads: [THREAD] }).allow);
check(
  "a non-revoked member is allowed — viewer or participant, this gate reads both",
  gate({ threads: [THREAD], isMember: true }).allow,
);
check(
  "a REVOKED member is refused (the lookup carried no status filter at all)",
  !gate({ threads: [THREAD], isMember: false }).allow,
);
check(
  "a session NOBODY has a record of is still allowed — the mirror write is debounced",
  (() => {
    const d = gate();
    return d.allow && d.reason === "unknown";
  })(),
);
check(
  "a session recorded in ANOTHER workspace is not 'unknown' — that is 'we cannot see'",
  (() => {
    const d = gate({ knownElsewhere: true });
    return !d.allow && d.reason === "other-workspace";
  })(),
);
check("a caller with no verified email decides nothing", !gate({ callerEmail: "" }).allow);
check(
  "the comparison is case- and space-insensitive, because a token subject is not normalised",
  gate({ callerEmail: "  Victim@OnFinance.in ", mirrorOwners: ["victim@onfinance.in"] }).allow,
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
check("…it resolves the workspace the way its neighbours do", /orgContextForRequest\(request\)/.test(gateRoute));
check("…and refuses a caller whose workspace will not resolve", /if \(!ctx\)[\s\S]{0,120}401/.test(gateRoute));
check(
  "…the fail-open on a database error is still there, and still loud",
  /SESSION GATE FAILED OPEN/.test(gateRoute) && /console\.error/.test(gateRoute),
);
check("every gate read runs inside a workspace scope", /withOrgRls\(orgId, \(tx\)/.test(accessLib));
check("the gate's member lookup filters revoked rows", /ne\(chatThreadMembers\.status, "revoked"\)/.test(accessLib));
check("the transcript rule ignores an un-shared thread", /isNull\(chatThreads\.archivedAt\)/.test(accessLib));
check(
  "…and reads EVERY mirror row for the session, not only the caller's",
  /claimants\.size === 1 && claimants\.has\(me\)/.test(accessLib),
);
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
