/**
 * A SHARED CHAT'S QUEUE, against a real Postgres (CI's `isolation` job) — mold_v1-290.
 *
 * Runs lib/thread-queue-server.ts — the code app/api/ops/threads/[id]/messages runs — as app_rw under row-level
 * security, with a fake agent behind it that holds ONE live continuation token at a time (refusing a stale one, as eve
 * does), is busy while a turn runs, and admits a queued message only through the agent's REAL door for the single-use
 * author token (agent/lib/queue-delivery-auth.ts `consumePostInDb`, the shared-chat branch):
 *
 *  0. Migration 0048 applies twice; the table is workspace-scoped and fails closed (no workspace, no rows).
 *  1. AS ITS AUTHOR: the owner's page runs a participant's message, and the agent receives the PARTICIPANT's identity;
 *     the door spends that token once and refuses it again, for another body, another author or another claim.
 *  2. RE-CHECKED AT CLAIM: a participant removed from the chat (or the workspace) has their message failed with the
 *     reason, nothing is sent, and the next message runs.
 *  3. THE OWNER WAITS IN LINE TOO: while the owner's own direct turn runs (the session is not parked), nothing is sent;
 *     owner and participant messages run in the order they were queued, each as its author.
 *  4. EXACTLY ONCE, IN ORDER, UNDER CONCURRENCY: six pumps racing per round never send an item twice, never two at once,
 *     never out of order. Two takers of a stale thread claim: one wins.
 *  5. RETRIES: a refusal that may pass backs off and does not block the next message; a permanent 4xx fails at once;
 *     one refused for long (measured from its FIRST attempt) fails.
 *  6. NO DOUBLE DELIVERY: a send whose answer is lost AFTER the agent took it is delivered exactly once (the session's
 *     history is checked before any resend); one lost BEFORE the door spent its token is withdrawn, so a late copy is
 *     refused, and sent once later. A claim a crashed request left `sending` is checked the same way.
 *  7. Ids are per workspace (another workspace's same id is another row and reveals nothing); take-backs.
 *     A history that cannot be read in full (refused, failed, truncated) fails the item as unconfirmed: never resent.
 *     Where only the author's page can send, a message first in line waits a few minutes, then fails with a reason.
 *     A token is its own thread's: the gate and the door refuse it for another thread, or a thread not the owner's.
 *  8. NO TABLE, NO OUTAGE: on a database the migration has not reached, nothing throws and enqueue says to send directly.
 *
 * Run:  ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:thread-queue-db
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-thread-queue-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const app = postgres(appUrl, { max: 2, onnotice: () => {} });
let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};

const STAMP = Date.now();
const ORG = `tq-probe-${STAMP}`;
const ORG2 = `tq-probe-other-${STAMP}`;
const ALICE = "alice@probe.example"; // the chat's owner
const BOB = "bob@probe.example"; // a participant, not the author
const CAROL = "carol@probe.example"; // another participant
const MALLORY = "mallory@probe.example"; // a workspace member who wrote a thread row on someone else's session
const SID = `wrun_TQPROBE_${STAMP}`;

const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
const q = await import("../lib/thread-queue-server.ts");
const door = await import("../agent/lib/queue-delivery-auth.ts");
const { sentUnderClaim } = await import("../lib/queue-delivery-token.ts");
const { agentGateDb } = await import("../agent/lib/session-owners.ts");
const { readCallerFacts, readOwnership } = await import("../lib/session-gate.ts");
const { sessionGateDecision } = await import("../lib/chat-gate.ts");
const runIn = (orgId, fn) => withOrgDb(orgId, fn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const applyMigration = async () => {
  const sqlText = readFileSync("drizzle/0048_chat_thread_queue.sql", "utf8");
  for (const st of sqlText.split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean)) await admin.unsafe(st);
};

/**
 * A fake agent. ONE live token (`ct-k`); a send with any other is refused (409). A send is admitted only if the
 * agent's real door spends its single-use author token (`consumePostInDb`, queue "thread"), exactly as the guard does.
 * An admitted send starts a turn: the session is not parked (no token) until `park()`. `ownerTurn()` starts a turn
 * nobody's queue started (the owner typing straight into their copy). Records who each turn ran as.
 */
function fakeAgent() {
  const a = { k: 1, busy: false, posts: [], sends: [], refuse: [], loseAfter: 0, loseBefore: 0, inFlight: 0, maxInFlight: 0 };
  a.park = () => {
    if (a.busy) {
      a.busy = false;
      a.k += 1;
    }
  };
  a.ownerTurn = () => {
    a.busy = true;
  };
  a.deps = (over = {}) => ({
    runIn,
    singleUse: true,
    canSendAs: () => true,
    parkedToken: async (sessionId) => ({ token: a.busy ? undefined : `ct-${a.k}`, sessionId }),
    forward: async (send) => {
      a.inFlight += 1;
      a.maxInFlight = Math.max(a.maxInFlight, a.inFlight);
      a.sends.push(send);
      try {
        if (a.loseBefore > 0) {
          a.loseBefore -= 1;
          throw new Error("socket hang up (before the agent)");
        }
        if (a.refuse.length) return { ok: false, status: a.refuse.shift(), detail: "refused" };
        const spent = await door.consumePostInDb({
          org: ORG,
          sid: send.sessionId,
          email: send.author,
          item: send.item,
          claim: send.claim,
          seq: send.seq,
          message: send.message,
          queue: "thread",
          thread: send.thread,
        });
        if (!spent) return { ok: false, status: 404, detail: "the door refused the token" };
        if (a.busy || send.continuationToken !== `ct-${a.k}`) return { ok: false, status: 409, detail: "stale token" };
        a.posts.push({ as: send.author, message: send.message });
        a.busy = true;
        await sleep(5);
        if (a.loseAfter > 0) {
          a.loseAfter -= 1;
          throw new Error("socket hang up (after the agent took it)");
        }
        return { ok: true, status: 200, sessionId: send.sessionId };
      } finally {
        a.inFlight -= 1;
      }
    },
    tail: async (sessionId) => {
      a.park();
      return { token: `ct-${a.k}`, sessionId };
    },
    received: async (_sid, claims) => (a.posts.some((p) => sentUnderClaim(p.message, claims)) ? "yes" : "no"),
    ...over,
  });
  return a;
}

const newThread = async (owner = ALICE) => {
  const id = randomUUID();
  await admin`
    insert into chat_threads (id, org_id, eve_session_id, title, owner_email, continuation_token)
    values (${id}, ${ORG}, ${SID}, 'probe', ${owner}, 'ct-1')`;
  for (const who of [BOB, CAROL]) {
    await admin`
      insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by)
      values (${ORG}, ${id}, ${who}, 'participant', 'accepted', ${ALICE})`;
  }
  return id;
};
const words = (posts) => posts.map((p) => `${p.as}: ${p.message.replace(/^\[from: [^\]]+\]\n\n/, "").replace(/\n\n⁦directives⁩[\s\S]*$/, "")}`);
let n = 0;
const put = (thread, author, text) =>
  q.enqueueThreadMessage(runIn, { orgId: ORG, threadId: thread, author, id: `m${STAMP}_${++n}`, text });
const pump = (agent, thread, pumper, over) => q.pumpThreadQueue(agent.deps(over), { orgId: ORG, threadId: thread, pumper });
const state = async (id) => (await admin`select state, error, tried_claims, next_attempt_at from chat_thread_queue where org_id = ${ORG} and id = ${id}`)[0];

try {
  // 0. The migration.
  await applyMigration();
  await applyMigration();
  check("0048 applies twice", true);
  const policy = await admin`select qual from pg_policies where tablename = 'chat_thread_queue' and policyname = 'org_isolation'`;
  check("the table has the workspace policy", policy.length === 1, policy);
  const forced = await admin`select relforcerowsecurity as f from pg_class where relname = 'chat_thread_queue'`;
  check("row-level security is forced", forced[0]?.f === true);
  for (const who of [ALICE, BOB, CAROL, MALLORY]) {
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${who}, 'member') on conflict do nothing`;
  }
  // The session's owner, as the agent records it at creation.
  await admin`
    insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility)
    values (${SID}, ${ORG}, ${ALICE}, 'person', 'owner')`;

  // 1. As its author.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    const b = await put(thread, BOB, "from the participant");
    const r = await pump(agent, thread, ALICE); // the OWNER's page runs it
    check("the owner's page runs a participant's message", r.outcome === "sent" && r.item.id === b.item.id, r);
    check("…and the agent receives the PARTICIPANT's identity, not the owner's", agent.posts.length === 1 && agent.posts[0].as === BOB, agent.posts);
    const [row] = await admin`select claim_id, token_seq, text from chat_thread_queue where org_id = ${ORG} and id = ${b.item.id}`;
    const claim = {
      org: ORG,
      sid: SID,
      email: BOB,
      item: b.item.id,
      claim: row.claim_id,
      seq: row.token_seq,
      message: agent.posts[0].message,
      queue: "thread",
      thread,
    };
    check("the door spent the author's token once: the same token again is refused", !(await door.consumePostInDb(claim)));
    await admin`update chat_thread_queue set state = 'sending', token_seq = 0 where org_id = ${ORG} and id = ${b.item.id}`;
    check("…as is another body", !(await door.consumePostInDb({ ...claim, message: claim.message + " and more" })));
    check("…another author", !(await door.consumePostInDb({ ...claim, email: CAROL })));
    check("…another claim", !(await door.consumePostInDb({ ...claim, claim: "someone-else" })));
    check("…while the right one, unspent, is admitted", await door.checkPostInDb(claim));
    await admin`update chat_thread_queue set state = 'sent' where org_id = ${ORG} and id = ${b.item.id}`;
  }

  // 2. Re-checked at claim.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    const b = await put(thread, BOB, "from a participant about to be removed");
    const c = await put(thread, CAROL, "from one who stays");
    await admin`update chat_thread_members set status = 'revoked' where thread_id = ${thread} and email = ${BOB}`;
    const r = await pump(agent, thread, ALICE);
    const bs = await state(b.item.id);
    check("a removed participant's message is failed, with the reason", bs.state === "failed" && /can no longer post/.test(bs.error ?? ""), bs);
    check("…nothing of theirs is sent, and the next message runs", r.outcome === "sent" && r.item.id === c.item.id && agent.posts.length === 1 && agent.posts[0].as === CAROL, { r, posts: agent.posts });
    const x = await put(thread, CAROL, "after leaving the workspace");
    await admin`delete from org_members where org_id = ${ORG} and email = ${CAROL}`;
    await pump(agent, thread, ALICE);
    const xs = await state(x.item.id);
    check("one who left the workspace: failed, not sent", xs.state === "failed" && /no longer a member/.test(xs.error ?? "") && agent.posts.length === 1, xs);
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${CAROL}, 'member') on conflict do nothing`;
  }

  // 3. The owner waits in line too.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    agent.ownerTurn(); // the owner typed straight into their own copy: a turn runs that no queue started
    const a1 = await put(thread, ALICE, "owner, first");
    const b1 = await put(thread, BOB, "participant, second");
    const a2 = await put(thread, ALICE, "owner, third");
    check("owner and participant messages queue alike", a1.ok && b1.ok && a2.ok && b1.ahead === 1 && a2.ahead === 2);
    const busy = await pump(agent, thread, BOB);
    check("nothing is sent while the owner's own turn runs (the session is not parked)", busy.outcome === "busy" && agent.posts.length === 0, busy);
    const [t] = await admin`select turn_holder from chat_threads where id = ${thread}`;
    check("…and the thread is not left held by the pump that waited", t.turn_holder === null, t);
    agent.park();
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await pump(agent, thread, i % 2 ? ALICE : BOB)).outcome);
    check("then one message per turn, in the order queued", out.join(",") === "sent,sent,sent,empty", out);
    check(
      "…each as its author, whoever's page ran it",
      JSON.stringify(words(agent.posts)) ===
        JSON.stringify([`${ALICE}: owner, first`, `${BOB}: participant, second`, `${ALICE}: owner, third`]),
      words(agent.posts),
    );
  }

  // 4. Concurrency.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    for (let i = 0; i < 6; i++) await put(thread, [ALICE, BOB, CAROL][i % 3], `m${i}`);
    for (let round = 0; round < 12; round++) {
      await Promise.all(Array.from({ length: 6 }, (_, k) => pump(agent, thread, [ALICE, BOB, CAROL][k % 3])));
    }
    const sent = words(agent.posts).map((w) => w.split(": ")[1]);
    check("six racing pumps send each message exactly once", sent.length === 6 && new Set(sent).size === 6, sent);
    check("…in the order they were queued", sent.join(",") === "m0,m1,m2,m3,m4,m5", sent);
    check("…never two at once", agent.maxInFlight === 1, agent.maxInFlight);

    const t2 = await newThread();
    await admin`update chat_threads set turn_holder = 'crashed@probe.example', turn_claimed_at = now() - interval '1 hour' where id = ${t2}`;
    const takers = await Promise.all(Array.from({ length: 6 }, (_, k) => q.claimThread(runIn, { orgId: ORG, threadId: t2, holder: `taker${k}@probe.example` })));
    check("a stale thread claim is taken over by exactly one of six", takers.filter((t) => !("busy" in t)).length === 1, takers);
  }

  // 5. Retries.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    const x = await put(thread, BOB, "refused for now");
    const y = await put(thread, CAROL, "behind it");
    agent.refuse.push(409);
    const r1 = await pump(agent, thread, ALICE, { backoffMs: () => 400 });
    const xs = await state(x.item.id);
    check("a refusal that may pass goes back, with a back-off", r1.outcome === "refused" && !r1.failed && xs.state === "queued" && xs.next_attempt_at, { r1, xs });
    const r2 = await pump(agent, thread, ALICE);
    check("…and does not block the message behind it", r2.outcome === "sent" && r2.item.id === y.item.id, r2);
    const early = await pump(agent, thread, ALICE);
    check("…nor is it retried before its back-off", early.outcome === "empty", early);
    await sleep(450);
    const r3 = await pump(agent, thread, ALICE);
    check("…after which it is sent, once", r3.outcome === "sent" && r3.item.id === x.item.id && agent.posts.length === 2, r3);

    const p = await put(thread, BOB, "a permanent refusal");
    agent.refuse.push(400);
    const r4 = await pump(agent, thread, ALICE);
    check("a permanent 4xx fails at once", r4.outcome === "refused" && r4.failed && (await state(p.item.id)).state === "failed", r4);

    const g = await put(thread, BOB, "refused for too long");
    await admin`update chat_thread_queue set attempts = ${q.MAX_ATTEMPTS}, first_attempt_at = now() - interval '1 hour', created_at = now() where org_id = ${ORG} and id = ${g.item.id}`;
    agent.refuse.push(409);
    const r5 = await pump(agent, thread, ALICE);
    check("one still refused long after its FIRST attempt fails (not measured from when it was queued)", r5.outcome === "refused" && r5.failed, r5);
    const forAuthor = await q.listThreadQueue(runIn, { orgId: ORG, threadId: thread, viewer: BOB });
    const forOther = await q.listThreadQueue(runIn, { orgId: ORG, threadId: thread, viewer: CAROL });
    check("its author is told; nobody else's list carries it", forAuthor.some((i) => i.state === "failed") && !forOther.some((i) => i.state === "failed"));
  }

  // 6. No double delivery.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    const l = await put(thread, BOB, "taken, answer lost");
    agent.loseAfter = 1;
    const r1 = await pump(agent, thread, ALICE);
    const ls = await state(l.item.id);
    check("an answer lost after the agent took it: not repeated blindly", r1.outcome === "refused" && agent.posts.length === 1 && ls.state === "queued" && (ls.tried_claims ?? []).length === 1, { r1, ls });
    const busy = await pump(agent, thread, ALICE);
    check("…its turn holds the thread while it runs", busy.outcome === "busy" && agent.posts.length === 1, busy);
    agent.park();
    const r2 = await pump(agent, thread, ALICE);
    { const st = await state(l.item.id); check("…and once parked it is found in the session's history: sent, exactly once", r2.outcome === "sent" && agent.posts.length === 1 && st.state === "sent", { posts: agent.posts.length, st }); }

    const m = await put(thread, CAROL, "lost before the agent");
    agent.loseBefore = 1;
    const r3 = await pump(agent, thread, ALICE, { backoffMs: () => 0 });
    const [row] = await admin`select claim_id, tried_claims from chat_thread_queue where org_id = ${ORG} and id = ${m.item.id}`;
    check("an answer lost before the agent: the unspent claim is withdrawn", r3.outcome === "refused" && row.claim_id === null && (row.tried_claims ?? []).length === 0, { r3, row });
    const lost = agent.sends.at(-1);
    const late = await door.consumePostInDb({ org: ORG, sid: lost.sessionId, email: lost.author, item: lost.item, claim: lost.claim, seq: lost.seq, message: lost.message, queue: "thread", thread: lost.thread });
    check("…so a late copy is refused at the door", !late);
    const r4 = await pump(agent, thread, ALICE);
    check("…and it is sent once, later", r4.outcome === "sent" && words(agent.posts).filter((w) => w.includes("lost before")).length === 1, r4);

    const c = await put(thread, BOB, "left sending by a crash");
    await admin`update chat_thread_queue set state = 'sending', claim_id = 'crashed-claim', claimed_at = now() - interval '1 hour' where org_id = ${ORG} and id = ${c.item.id}`;
    const r5 = await pump(agent, thread, ALICE);
    check("a claim a crashed request left goes back in line and, not found in the history, is sent once", r5.outcome === "sent" && r5.item.id === c.item.id, r5);
    check("a message already sent cannot be taken back", (await q.removeThreadMessage(runIn, { orgId: ORG, threadId: thread, author: BOB, id: c.item.id })) === "already-sent");
  }

  // 6a. A tail severed before the turn parked keeps the claim; the stale takeover then recovers the thread.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    const s1 = await put(thread, BOB, "its tail is severed");
    const s2 = await put(thread, CAROL, "behind it");
    const severed = { tail: async (sessionId) => ({ token: undefined, sessionId }) };
    const r1 = await pump(agent, thread, ALICE, severed);
    const [held] = await admin`select turn_holder, turn_claimed_at from chat_threads where id = ${thread}`;
    check("a severed tail leaves the claim (holder and time) so recovery can still fire", r1.outcome === "sent" && held.turn_holder === BOB && held.turn_claimed_at !== null, { r1: r1.outcome, held });
    agent.park();
    const r2 = await pump(agent, thread, ALICE);
    check("…the next send does not go in meanwhile", r2.outcome === "busy" && agent.posts.length === 1, r2);
    await admin`update chat_threads set turn_claimed_at = now() - interval '1 hour' where id = ${thread}`;
    const r3 = await pump(agent, thread, ALICE);
    check("…and once the claim is stale it is taken over and the queue runs on", r3.outcome === "sent" && r3.item.id === s2.item.id && agent.posts.length === 2, r3);
    void s1;
  }

  // 6b. A history that cannot be read in full is never taken for "not received".
  {
    for (const how of ["unknown", "throws"]) {
      const agent = fakeAgent();
      const thread = await newThread();
      const u = await put(thread, BOB, `answer lost, history ${how}`);
      agent.loseAfter = 1;
      await pump(agent, thread, ALICE);
      agent.park();
      const unreadable = {
        received: async () => {
          if (how === "throws") throw new Error("the history read failed");
          return "unknown";
        },
      };
      const r = await pump(agent, thread, ALICE, unreadable);
      const us = await state(u.item.id);
      check(
        `a history read that ${how === "throws" ? "fails" : "is incomplete"} fails the item as unconfirmed — never a second delivery`,
        r.outcome === "refused" && r.failed && us.state === "failed" && /could not be confirmed/.test(us.error ?? "") && agent.posts.length === 1,
        { r: r.outcome, us, posts: agent.posts.length },
      );
    }
  }

  // 6c. Where only the author's own page can send, a message first in line does not hold the line for ever.
  {
    const agent = fakeAgent();
    const thread = await newThread();
    const b = await put(thread, BOB, "waits for its author's page");
    const a = await put(thread, ALICE, "the owner's, behind it");
    const keyless = { singleUse: false, canSendAs: (who) => who === ALICE };
    const w = await pump(agent, thread, ALICE, keyless);
    check("keyless: a participant's message waits for its author's page", w.outcome === "waiting-for-author" && agent.posts.length === 0, w);
    await admin`update chat_thread_queue set author_wait_since = now() - interval '1 hour' where org_id = ${ORG} and id = ${b.item.id}`;
    const r = await pump(agent, thread, ALICE, keyless);
    const bs = await state(b.item.id);
    check("…but not for ever: it is failed with a reason its author sees", bs.state === "failed" && /only its sender's own page/.test(bs.error ?? ""), bs);
    check("…and the next message runs", r.outcome === "sent" && r.item.id === a.item.id && agent.posts.length === 1, r);
    const told = await q.listThreadQueue(runIn, { orgId: ORG, threadId: thread, viewer: BOB });
    check("…its author is told", told.some((i) => i.id === b.item.id && i.state === "failed"));
  }

  // 6d. A token is its own thread's: removed from thread A but still in thread B on the same session, A's is refused.
  {
    const agent = fakeAgent();
    const ta = await newThread();
    const tb = await newThread();
    const item = await put(ta, BOB, "in thread A");
    await admin`update chat_thread_members set status = 'revoked' where thread_id = ${ta} and email = ${BOB}`;
    const db = agentGateDb();
    const ownership = await readOwnership(db, SID, ORG);
    const caller = (thread) => ({ kind: "session-bound", email: BOB, boundSessionId: SID, boundAct: "post", boundQueue: "thread", boundThread: thread });
    const decide = async (thread) => {
      const facts = await readCallerFacts(db, caller(thread), SID, ownership);
      return sessionGateDecision({ caller: caller(thread), sessionId: SID, right: "write", ownership, membership: facts.membership, callerInWorkspace: false, localDevAllowed: false });
    };
    check("the gate refuses A's token for one removed from A, though they stay in B on the same session", !(await decide(ta)).allow);
    check("…and admits a token for B, where they still are", (await decide(tb)).allow);
    await admin`update chat_thread_queue set state = 'sending', claim_id = 'c-a', token_seq = 0 where org_id = ${ORG} and id = ${item.item.id}`;
    const body = q.fromLine(BOB, "in thread A") + (await import("../lib/queue-delivery-token.ts")).deliveryReference("c-a");
    const claimA = { org: ORG, sid: SID, email: BOB, item: item.item.id, claim: "c-a", seq: 1, message: body, queue: "thread" };
    check("the door refuses A's item under a token bound to thread B", !(await door.checkPostInDb({ ...claimA, thread: tb })));
    check("…and admits it under its own thread's token (the gate decides the membership)", await door.checkPostInDb({ ...claimA, thread: ta }));
    const tm = await newThread(MALLORY);
    await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by) values (${ORG}, ${tm}, ${CAROL}, 'participant', 'accepted', ${MALLORY}) on conflict do nothing`;
    const mi = await put(tm, CAROL, "in a thread the session's owner never shared");
    await admin`update chat_thread_queue set state = 'sending', claim_id = 'c-m', token_seq = 0 where org_id = ${ORG} and id = ${mi.item.id}`;
    const mBody = q.fromLine(CAROL, "in a thread the session's owner never shared") + (await import("../lib/queue-delivery-token.ts")).deliveryReference("c-m");
    check(
      "the door refuses an item whose thread is not the session owner's",
      !(await door.checkPostInDb({ org: ORG, sid: SID, email: CAROL, item: mi.item.id, claim: "c-m", seq: 1, message: mBody, queue: "thread", thread: tm })),
    );
    void agent;
  }

  // 7. Ids, take-backs, workspace scope.
  {
    const thread = await newThread();
    const id = `i1_${STAMP}`;
    const first = await q.enqueueThreadMessage(runIn, { orgId: ORG, threadId: thread, author: BOB, id, text: "once" });
    const again = await q.enqueueThreadMessage(runIn, { orgId: ORG, threadId: thread, author: BOB, id, text: "once" });
    const [{ count }] = await admin`select count(*)::int as count from chat_thread_queue where org_id = ${ORG} and id = ${id}`;
    check("a retried POST is the same message", first.ok && again.ok && count === 1);
    const foreign = await q.enqueueThreadMessage(runIn, { orgId: ORG, threadId: thread, author: ALICE, id, text: "mine now" });
    check("an id someone else holds in this workspace is refused, never taken over", !foreign.ok && foreign.reason === "foreign", foreign);
    const elsewhere = await q.enqueueThreadMessage(runIn, { orgId: ORG2, threadId: thread, author: BOB, id, text: "from elsewhere" });
    const [orig] = await admin`select text from chat_thread_queue where org_id = ${ORG} and id = ${id}`;
    check("the same id in another workspace is another row: it reveals and touches nothing", elsewhere.ok && orig.text === "once", { elsewhere, orig });
    check("someone else's waiting message cannot be taken back", (await q.removeThreadMessage(runIn, { orgId: ORG, threadId: thread, author: ALICE, id })) === "not-found");
    check("your own can", (await q.removeThreadMessage(runIn, { orgId: ORG, threadId: thread, author: BOB, id })) === "removed");
    const other = await q.listThreadQueue(runIn, { orgId: ORG2, threadId: randomUUID(), viewer: BOB });
    check("another workspace's list of this chat is empty", other.length === 0, other);
    const bare = await app`select count(*)::int as n from chat_thread_queue`;
    check("no workspace set, no rows (fail closed)", bare[0].n === 0, bare);
  }

  // 8. No table, no outage.
  {
    const thread = await newThread();
    await admin`alter table chat_thread_queue rename to chat_thread_queue_away`;
    try {
      const agent = fakeAgent();
      const r = await q.enqueueThreadMessage(runIn, { orgId: ORG, threadId: thread, author: BOB, id: `n1_${STAMP}`, text: "no table" });
      check("no table: enqueue says there is no queue (the route sends directly)", !r.ok && r.reason === "no-queue", r);
      check("no table: the list is empty", (await q.listThreadQueue(runIn, { orgId: ORG, threadId: thread, viewer: BOB })).length === 0);
      const p = await pump(agent, thread, BOB);
      check("no table: a pump finds nothing and sends nothing", p.outcome === "empty" && agent.posts.length === 0, p);
      check("no table: a take-back says there is no queue (the route answers 503)", (await q.removeThreadMessage(runIn, { orgId: ORG, threadId: thread, author: BOB, id: `n1_${STAMP}` })) === "no-queue");
      const d = await q.claimForDirectSend(agent.deps(), { orgId: ORG, threadId: thread, holder: BOB });
      check("no table: the direct path takes the parked session's token", !("busy" in d) && d.token === "ct-1", d);
    } finally {
      await admin`alter table chat_thread_queue_away rename to chat_thread_queue`;
    }
  }
} catch (e) {
  check(`the run completed (${String(e?.stack ?? e).slice(0, 300)})`, false);
} finally {
  await admin`delete from chat_thread_queue where org_id in (${ORG}, ${ORG2})`.catch(() => {});
  await admin`delete from chat_thread_members where org_id = ${ORG}`.catch(() => {});
  await admin`delete from chat_threads where org_id = ${ORG}`.catch(() => {});
  await admin`delete from org_members where org_id = ${ORG}`.catch(() => {});
  await admin`delete from agent_session_owners where session_id = ${SID}`.catch(() => {});
  await closeDb().catch(() => {});
  await admin.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
