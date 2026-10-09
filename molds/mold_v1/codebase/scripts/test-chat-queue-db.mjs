/**
 * THE SERVER-HELD CHAT QUEUE AND THE NOTIFICATION DEVICES, against a real Postgres (CI's `isolation` job).
 *
 * Runs the code the routes run — lib/chat-queue-server.ts, lib/chat-queue-drain.ts, lib/push-subscriptions.ts and
 * the agent's agent/lib/push-recipients.ts + push-notify.ts — as app_rw under row-level security, with a fake eve
 * behind the drain:
 *
 *  0. Migration 0021 applies twice (tables, the one-in-flight index, org_isolation AND the restrictive owner policy).
 *  1. OWNER-ONLY, ORG-SCOPED (the takeover variants of test:chat-sessions-mirror-db): a colleague in the same
 *     workspace who knows an item id cannot read it, list it, edit it, remove it, re-queue it under their name or
 *     insert a row in the owner's name — through the library or with raw SQL under the policy; another workspace
 *     sees nothing. The same for push subscriptions (an endpoint is never re-homed).
 *  2. EXACTLY ONCE UNDER CONCURRENCY: eight claimers racing for one session, twenty rounds — one wins each round,
 *     and never are two items of one session `sending`. Two drains (two tabs, or a tab and the agent's hook) at one
 *     rest send ONE message.
 *  3. THE OLD BUGS STAY FIXED, server-side: a Plan-mode item goes out with its directive (planmode); a closed tab's
 *     item is sent with no tab (queuedclosed); two tabs never send it twice (twotab / dup); a day-old item is
 *     expired, shown, and never sent unless asked (stale); × works until it has gone and says so after (remove);
 *     a parked question holds the queue until answered or stopped; a lost answer from eve is checked, never
 *     blindly resent; "target session was not found" (the park not visible yet) is retried.
 *  4. A 410 from the push service removes that device's row.
 *
 * Run:  ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:chat-queue-db
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-chat-queue-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const app = postgres(appUrl, { max: 4, onnotice: () => {} });
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
const ORG = `queue-probe-${STAMP}`;
const ORG2 = `queue-probe-other-${STAMP}`;
const ALICE = "alice@probe.example";
const MALLORY = "mallory@probe.example";
const BOB = "bob@probe.example";
const SID = `wrun_QPROBE_${STAMP}`;

const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
const q = await import("../lib/chat-queue-server.ts");
const d = await import("../lib/chat-queue-drain.ts");
const subs = await import("../lib/push-subscriptions.ts");
const recipients = await import("../agent/lib/push-recipients.ts");
const pushNotify = await import("../agent/lib/push-notify.ts");
const runIn = (scope, fn) => withOrgDb(scope, fn);
// (Older code had no delivery reference: then it is empty, so this file still runs there and reports what fails.)
const deliveryReference = (await import("../lib/queue-delivery-token.ts")).deliveryReference ?? (() => "");
/** The words a delivery carried, without its delivery reference (lib/queue-delivery-token.ts). */
const words = (m) => String(m ?? "").replace(/\n\n⁦directives⁩ \(This message was queued earlier[\s\S]*$/, "");

const applyMigration = async () => {
  const sqlText = readFileSync("drizzle/0021_chat_queue_and_push.sql", "utf8");
  for (const st of sqlText.split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean)) await admin.unsafe(st);
};
const itemRow = async (id) => (await admin`select * from chat_queue_items where id = ${id}`)[0] ?? null;
const asPerson = async (org, email, fn) =>
  app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${org}, true)`;
    if (email) await tx`select set_config('app.principal_email', ${email}, true)`;
    return fn(tx);
  });

const BUILD = { mode: "build", webSearch: true, browserUse: false, customers: [] };
const PLAN = { mode: "plan", webSearch: false, browserUse: false, customers: ["acme-hfc"] };
const PLAN_DIRECTIVE = "(Plan mode is ON — investigate and plan only, take no action.)";
let n = 0;
const item = (sessionId, text, extra = {}) => ({
  id: `item_${STAMP}_${++n}`,
  eveSessionId: sessionId,
  chatId: "chat-1",
  text,
  message: text,
  settings: BUILD,
  ...extra,
});

/**
 * A fake eve session, as an event log: it rests on `session.waiting` #k; a POST it accepts appends `turn.started`
 * and the message's own `message.received` (the session is busy), and `settle()` ends that turn on waiting #k+1.
 * `otherTurn()` is a turn somebody ELSE started (no receipt of any queued item). Records every POST it accepts.
 */
function fakeEve() {
  const s = { k: 1, busy: false, parked: null, posts: [], lose: 0, notFound: 0, events: [] };
  const waiting = () => ({ type: "session.waiting", data: { continuationToken: `ct-${s.k}` }, meta: { at: `2026-09-28T10:00:${String(s.k).padStart(2, "0")}.000Z` } });
  s.markOf = (k) => `2026-09-28T10:00:${String(k).padStart(2, "0")}.000Z|ct-${k}`;
  s.events.push({ type: "step.completed" }, { type: "turn.completed" }, waiting());
  s.tail = (n = 12) => {
    if (s.parked && !s.busy) {
      return [...s.events.slice(0, -1), { type: "input.requested", data: { requests: [{ requestId: s.parked }] } }, { type: "turn.completed" }, s.events[s.events.length - 1]].slice(-n);
    }
    return s.events.slice(-n);
  };
  s.startTurn = (message) => {
    s.busy = true;
    s.events.push({ type: "turn.started", data: { turnId: `t${s.k}` } }, { type: "message.received", data: { message } });
  };
  s.otherTurn = () => {
    s.busy = true;
    s.events.push({ type: "turn.started", data: { turnId: `o${s.k}` } }, { type: "message.received", data: { message: "somebody else's message" } });
  };
  s.settle = () => {
    if (s.busy) {
      s.busy = false;
      s.k += 1;
      s.events.push({ type: "turn.completed" }, waiting());
    }
  };
  s.deps = (over = {}) => ({
    runIn,
    readTail: async (_sid, _bearer, n) => s.tail(n),
    post: async (_sid, bearer, body) => {
      if (s.notFound > 0) {
        s.notFound -= 1;
        return { status: 500, text: '{"error":"target session was not found"}' };
      }
      if (body.continuationToken !== `ct-${s.k}` || s.busy) return { status: 409, text: "stale" };
      s.posts.push({ bearer, body });
      s.startTurn(body.message);
      if (s.lose > 0) {
        s.lose -= 1;
        return { status: 0 };
      }
      return { status: 200 };
    },
    mint: async (email, orgId, sid, scope) => `minted:${email}:${orgId}:${sid}:${scope?.act}${scope?.act === "post" ? `:${scope.item}:${scope.seq}` : ""}`,
    stoppedRequests: async () => new Set(s.stopped ?? []),
    goalSchema: { type: "object" },
    sleep: async () => {},
    ...over,
  });
  return s;
}

/** One review block: an exception (a function the code under test does not have) is that block's FAIL, not the end. */
const guarded = async (fn) => {
  try {
    await fn();
  } catch (e) {
    check(`this block runs on this code (${String(e?.message ?? e).slice(0, 100)})`, false);
  }
};

/** A session is someone's chat when the AGENT recorded them as its owner at creation (agent_session_owners, #66). */
const ownChat = async (sessionId, email = ALICE, org = ORG) =>
  admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) values (${sessionId}, ${org}, ${email}, 'person', 'owner')
        on conflict (session_id) do update set org_id = excluded.org_id, owner_email = excluded.owner_email, owner_kind = 'person', visibility = 'owner'`;

try {
  console.log("\n0. Migration 0021 applies, twice");
  await applyMigration();
  await applyMigration();
  const policies = await admin`select policyname, permissive from pg_policies where tablename in ('chat_queue_items', 'push_subscriptions') order by 1`;
  check(
    "both tables carry org_isolation AND a restrictive owner policy",
    policies.some((p) => p.policyname === "chat_queue_owner" && p.permissive === "RESTRICTIVE") &&
      policies.some((p) => p.policyname === "push_subscriptions_owner" && p.permissive === "RESTRICTIVE") &&
      policies.filter((p) => p.policyname === "org_isolation").length === 2,
    policies,
  );
  await admin`insert into orgs (org_id, name, status) values (${ORG}, 'Queue probe', 'active'), (${ORG2}, 'Other probe', 'active')`;
  // Alice, Mallory and Bob are colleagues in ORG; Alice is in ORG2 as well.
  await admin`insert into org_members (org_id, email, role) values (${ORG}, ${ALICE}, 'owner'), (${ORG}, ${MALLORY}, 'member'), (${ORG}, ${BOB}, 'member'), (${ORG2}, ${ALICE}, 'member')`;
  await ownChat(SID);

  console.log("\n1. Owner-only and org-scoped: nobody else can see, change or take a queued item");
  const a1 = item(SID, "MSG-2 Alice's queued message");
  const put = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: a1 });
  check("the owner queues an item", put.ok && put.row.ownerEmail === ALICE && put.row.state === "queued", put);
  const again = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: a1 });
  check("a retried POST of the same item is the same row (idempotent)", again.ok && (await admin`select count(*)::int n from chat_queue_items where id = ${a1.id}`)[0].n === 1);
  const before = await itemRow(a1.id);
  check("a colleague's list of that chat is empty", (await q.listQueue(runIn, { orgId: ORG, email: MALLORY, sessionId: SID })).length === 0);
  check("a colleague's × finds nothing, and the item stays", (await q.removeQueued(runIn, { orgId: ORG, email: MALLORY, id: a1.id })) === "not-found" && Boolean(await itemRow(a1.id)));
  check("a colleague cannot edit it", (await q.updateQueued(runIn, { orgId: ORG, email: MALLORY, id: a1.id, patch: { text: "pwned", message: "pwned" } })) === null);
  const take = await q.enqueueItem(runIn, { orgId: ORG, email: MALLORY, item: { ...a1, text: "mine now", message: "mine now" } });
  const after = await itemRow(a1.id);
  check("re-queueing its id under another name is refused (the takeover)", !take.ok && take.reason === "foreign", take);
  check("…and the row is exactly as it was", after.owner_email === ALICE && after.text === before.text && after.message === before.message);
  const raw = await asPerson(ORG, MALLORY, async (tx) => ({
    select: (await tx`select id from chat_queue_items where id = ${a1.id}`).length,
    update: (await tx`update chat_queue_items set text = 'x' where id = ${a1.id} returning id`).length,
    del: (await tx`delete from chat_queue_items where id = ${a1.id} returning id`).length,
  }));
  check("under the policy, the colleague's raw SQL sees and touches no row", raw.select === 0 && raw.update === 0 && raw.del === 0, raw);
  let forged = false;
  try {
    await asPerson(ORG, MALLORY, (tx) => tx`insert into chat_queue_items (id, org_id, owner_email, eve_session_id, text, message, settings, position) values (${`forged_${STAMP}`}, ${ORG}, ${ALICE}, ${SID}, 'x', 'x', '{}'::jsonb, 1)`);
    forged = true;
  } catch {
    forged = false;
  }
  check("a colleague cannot insert a row in the owner's name (WITH CHECK)", !forged);
  check("the owner, under the same policy, sees it", (await asPerson(ORG, ALICE, (tx) => tx`select id from chat_queue_items where id = ${a1.id}`)).length === 1);
  check("another workspace sees nothing, not even its owner", (await q.listQueue(runIn, { orgId: ORG2, email: ALICE, sessionId: SID })).length === 0 && (await asPerson(ORG2, ALICE, (tx) => tx`select id from chat_queue_items where id = ${a1.id}`)).length === 0);
  await q.removeQueued(runIn, { orgId: ORG, email: ALICE, id: a1.id });

  console.log("\n2. Exactly once under concurrency");
  const S2 = `${SID}_race`;
  await ownChat(S2);
  let winners = 0;
  let doubleSending = 0;
  for (let round = 0; round < 20; round++) {
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S2, `race ${round} a`) });
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S2, `race ${round} b`) });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => q.claimNextQueued(runIn, { orgId: ORG, sessionId: S2, owner: ALICE, claimId: `c${round}-${i}`, restMark: `m${round}` }).catch(() => null)),
    );
    const won = claims.filter(Boolean);
    if (won.length === 1) winners++;
    const [{ n: sending }] = await admin`select count(*)::int n from chat_queue_items where eve_session_id = ${S2} and state = 'sending'`;
    if (sending > 1) doubleSending++;
    if (won[0]) await q.markSent(runIn, { orgId: ORG, id: won[0].id, claimId: won[0].claimId, by: "server" });
  }
  check("eight claimers racing for one session: exactly one wins, every round (20)", winners === 20, { winners });
  check("…and one session never has two items on their way", doubleSending === 0);
  {
    // The guarantee under the lock: the index itself refuses a second in-flight item of one session.
    const S2b = `${SID}_index`;
    await ownChat(S2b);
    const x = item(S2b, "x");
    const y = item(S2b, "y");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: x });
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: y });
    await admin`update chat_queue_items set state = 'sending' where id = ${x.id}`;
    let refused = false;
    try {
      await admin`update chat_queue_items set state = 'sending' where id = ${y.id}`;
    } catch (e) {
      refused = e?.code === "23505";
    }
    check("the unique index alone refuses a second item of one session on its way", refused);
  }
  check("…in order: each round took the oldest item", (await admin`select text from chat_queue_items where eve_session_id = ${S2} and state = 'sent' order by sent_at`).every((r, i) => r.text === (i === 0 ? "race 0 a" : r.text)));

  console.log("\n3. The drain: at rest, as the owner, once — and the old bugs stay fixed");
  {
    // queuedclosed + planmode: a Plan-mode item, no tab at all (the agent's hook calls the drain).
    const eve = fakeEve();
    const S3 = `${SID}_drain`;
    await ownChat(S3);
    const planMsg = `⁦directives⁩${PLAN_DIRECTIVE}⁦/directives⁩\n\nMSG-2 PLAN ONLY do not act`;
    const p1 = item(S3, "MSG-2 PLAN ONLY do not act", { settings: PLAN, message: planMsg });
    const p2 = item(S3, "MSG-3 next");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: p1 });
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: p2 });
    // Busy: nothing is sent into a running turn.
    eve.otherTurn();
    const busy = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" });
    check("a running turn: nothing is sent", busy.reason === "busy" && eve.posts.length === 0, busy);
    eve.settle();
    // twotab / dup: a tab and the hook drain at the same rest.
    const [r1, r2, r3] = await Promise.all([
      d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" }),
      d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "tab", caller: { email: ALICE, bearer: "alice-token" } }),
      d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" }),
    ]);
    check("three drains at one rest (two tabs + the hook): ONE message sent", eve.posts.length === 1, { posts: eve.posts.length, reasons: [r1.reason, r2.reason, r3.reason] });
    check("…the oldest item, and it is the Plan-mode one", words(eve.posts[0]?.body.message) === planMsg);
    check("…sent verbatim, with its Plan directive (planmode)", eve.posts[0]?.body.message.includes(PLAN_DIRECTIVE) && eve.posts[0]?.body.continuationToken === "ct-2");
    check("…as the owner (their own sign-in from a tab, or one signed for them)", /^(alice-token|minted:alice@probe\.example:)/.test(eve.posts[0]?.bearer ?? ""), eve.posts[0]?.bearer);
    const again1 = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" });
    check("the reply has not started yet (same waiting): the next item waits", again1.reason === "busy" || again1.reason === "delivering");
    eve.settle();
    const next = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" });
    check("the next rest sends the next item, and only then", next.reason === "sent" && eve.posts.length === 2 && words(eve.posts[1].body.message) === "MSG-3 next", next);
    eve.settle();
    const empty = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" });
    check("nothing left: nothing sent", empty.reason === "empty" && eve.posts.length === 2);
    check("a colleague's tab cannot drain someone's queue", (await (async () => {
      await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S3, "MSG-4 later") });
      return d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "tab", caller: { email: MALLORY, bearer: "m" } });
    })()).reason === "not-owner" && eve.posts.length === 2);
    const noCred = await d.drainSession(eve.deps({ mint: async () => null }), { orgId: ORG, sessionId: S3, by: "server" });
    check("a server that cannot sign for the owner sends nothing (the tab will)", noCred.reason === "no-credential" && eve.posts.length === 2);
    await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S3, by: "server" });
    eve.settle();
  }
  {
    // A park holds the queue; a Stop of that question releases it.
    const eve = fakeEve();
    const S4 = `${SID}_park`;
    await ownChat(S4);
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S4, "MSG-2 behind a question") });
    eve.parked = "req-1";
    const parked = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S4, by: "server" });
    check("a question waiting on the person holds the queue (it would answer or clear it)", parked.reason === "parked" && eve.posts.length === 0);
    eve.stopped = ["req-1"];
    const stopped = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S4, by: "server" });
    check("…and the owner's Stop of that question releases it", stopped.reason === "sent" && eve.posts.length === 1, stopped);
  }
  {
    // A lost answer from eve is checked, never blindly resent.
    const eve = fakeEve();
    const S5 = `${SID}_lost`;
    await ownChat(S5);
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S5, "MSG-2 answer lost on the way back") });
    eve.lose = 1;
    const lost = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S5, by: "server" });
    const row = (await admin`select state from chat_queue_items where eve_session_id = ${S5}`)[0];
    check("eve took it but the answer was lost: the tail shows it started, so it is SENT, not resent", lost.reason === "received" && row.state === "sent" && eve.posts.length === 1, { lost, row });
    // …and one that really did not arrive goes back in line, then out once.
    const S6 = `${SID}_notarrived`;
    await ownChat(S6);
    const eve2 = fakeEve();
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S6, "MSG-2 never arrived") });
    const deps = eve2.deps({ post: async () => ({ status: 502 }) });
    const nr = await d.drainSession(deps, { orgId: ORG, sessionId: S6, by: "server" });
    check("no answer and the session did not move: back in line (not received)", nr.reason === "not-received" && (await admin`select state from chat_queue_items where eve_session_id = ${S6}`)[0].state === "queued", nr);
    const ok = await d.drainSession(eve2.deps(), { orgId: ORG, sessionId: S6, by: "server" });
    check("…and the next drain sends it, once", ok.reason === "sent" && eve2.posts.length === 1);
    // eve's "target session was not found" (it has not parked on the token yet) took nothing: retried.
    const S7 = `${SID}_notfound`;
    await ownChat(S7);
    const eve3 = fakeEve();
    eve3.notFound = 2;
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(S7, "MSG-2 right at the boundary") });
    const nf = await d.drainSession(eve3.deps(), { orgId: ORG, sessionId: S7, by: "server" });
    check("\"target session was not found\" is retried until eve has parked (one delivery)", nf.reason === "sent" && eve3.posts.length === 1, nf);
  }
  {
    // A sender that died holding a claim: settled from the tail, never by sending again.
    const eve = fakeEve();
    const S8 = `${SID}_dead`;
    await ownChat(S8);
    const it = item(S8, "MSG-2 its sender died");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: it });
    await q.claimNextQueued(runIn, { orgId: ORG, sessionId: S8, owner: ALICE, claimId: "dead", restMark: eve.markOf(1) });
    await admin`update chat_queue_items set claimed_at = now() - interval '5 minutes' where id = ${it.id}`;
    eve.startTurn(it.message + deliveryReference("dead")); // it HAD been delivered: its own receipt is on the stream
    eve.settle();
    const settled = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S8, by: "server" });
    check("a dead sender's claim with ITS OWN receipt on the stream: marked sent, nothing resent", settled.reason === "received" && eve.posts.length === 0 && (await itemRow(it.id)).state === "sent", settled);
  }
  {
    // stale: a day-old item is expired, shown, never sent unless the person asks.
    const eve = fakeEve();
    const S9 = `${SID}_stale`;
    await ownChat(S9);
    const old = item(S9, "MSG-7 queued three days ago");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: old });
    await admin`update chat_queue_items set created_at = now() - interval '3 days' where id = ${old.id}`;
    const r = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S9, by: "server" });
    const listed = await q.listQueue(runIn, { orgId: ORG, email: ALICE, sessionId: S9 });
    check("an item older than a day is NOT sent (stale)", eve.posts.length === 0 && r.reason === "empty", r);
    check("…it is listed as expired — shown, not silently dropped", listed.length === 1 && listed[0].state === "expired");
    const requeued = await q.updateQueued(runIn, { orgId: ORG, email: ALICE, id: old.id, patch: { requeue: true } });
    const sent = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S9, by: "server" });
    check("…and \"Send now\" queues it again, as new, and it is sent once", requeued?.state === "queued" && sent.reason === "sent" && eve.posts.length === 1);
  }
  {
    // remove: × works on a server item until it has gone, and says so after.
    const S10 = `${SID}_remove`;
    await ownChat(S10);
    const keep = item(S10, "MSG-2 keep");
    const drop = item(S10, "MSG-3 remove me");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: keep });
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: drop });
    check("× removes a queued item", (await q.removeQueued(runIn, { orgId: ORG, email: ALICE, id: drop.id })) === "removed" && !(await itemRow(drop.id)));
    const eve = fakeEve();
    await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S10, by: "server" });
    check("…the removed item is never sent; the other is", eve.posts.length === 1 && words(eve.posts[0].body.message) === "MSG-2 keep");
    check("× on an item already sent says so, and changes nothing", (await q.removeQueued(runIn, { orgId: ORG, email: ALICE, id: keep.id })) === "already-sent" && (await itemRow(keep.id)).state === "sent");
    const up = item(S10, "MSG-4 with a deck", { filesPending: 1, fileNames: ["deck.pdf"] });
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: up });
    eve.settle();
    const held = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S10, by: "server" });
    check("an item whose upload never finished is held (never sent without its file)", held.reason === "empty" && eve.posts.length === 1, held);
    await q.updateQueued(runIn, { orgId: ORG, email: ALICE, id: up.id, patch: { filesPending: 0, message: "MSG-4 with a deck\n\n(deck.pdf failed to upload)" } });
    const without = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: S10, by: "server" });
    check("…until the person chooses \"Send without it\"", without.reason === "sent" && eve.posts[1].body.message.includes("failed to upload"));
  }

  console.log("\n4. Push subscriptions: owner-only, org-scoped, never re-homed; a 410 removes the device");
  const endpoint = `https://fcm.googleapis.com/fcm/send/${STAMP}`;
  const sub = { endpoint, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
  check("the owner turns it on", (await subs.saveSubscription(runIn, { orgId: ORG, email: ALICE, subscription: sub })).ok);
  const steal = await subs.saveSubscription(runIn, { orgId: ORG, email: MALLORY, subscription: { ...sub, keys: { ...sub.keys, auth: "AAAAAAAAAAAAAAAAAAAAAA" } } });
  const kept = (await admin`select owner_email, auth from push_subscriptions where endpoint = ${endpoint}`)[0];
  check("a colleague posting the same endpoint is refused (takeover)", !steal.ok && steal.reason === "foreign" && kept.owner_email === ALICE && kept.auth === sub.keys.auth, { steal, kept });
  check("a colleague cannot turn it off", (await subs.removeSubscription(runIn, { orgId: ORG, email: MALLORY, endpoint })) === 0);
  check("…nor change its preview setting", (await subs.setPreview(runIn, { orgId: ORG, email: MALLORY, endpoint, preview: false })) === false);
  check("…nor see it with raw SQL under the policy", (await asPerson(ORG, MALLORY, (tx) => tx`select id from push_subscriptions where endpoint = ${endpoint}`)).length === 0);
  check("another workspace sees nothing", (await asPerson(ORG2, ALICE, (tx) => tx`select id from push_subscriptions where endpoint = ${endpoint}`)).length === 0);
  check("the owner's preview choice is kept", (await subs.setPreview(runIn, { orgId: ORG, email: ALICE, endpoint, preview: false })) && (await subs.readSubscription(runIn, { orgId: ORG, email: ALICE, endpoint })).preview === false);
  await subs.setPreview(runIn, { orgId: ORG, email: ALICE, endpoint, preview: true });
  check("an invalid subscription is refused", !(await subs.saveSubscription(runIn, { orgId: ORG, email: ALICE, subscription: { endpoint: "http://evil.example/x", keys: sub.keys } })).ok);
  for (const bad of ["https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/admin", "https://localhost:8443/x", "http://127.0.0.1:3000/api/cron/deliver-queued", "https://metadata.google.internal/", "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x"]) {
    check(`SSRF: a subscription to ${bad} is refused (push services only)`, !(await subs.saveSubscription(runIn, { orgId: ORG, email: ALICE, subscription: { endpoint: bad, keys: sub.keys } })).ok);
  }

  // Who is notified: the owner's chat, a shared thread's participants who turned it on — nobody for a workflow run.
  const CHAT = `${SID}_chat`;
  await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${CHAT}, ${ORG}, ${ALICE}, ${CHAT}, 'Quarterly review')`;
  const bobEndpoint = `https://fcm.googleapis.com/fcm/send/bob-${STAMP}`;
  await subs.saveSubscription(runIn, { orgId: ORG, email: BOB, subscription: { ...sub, endpoint: bobEndpoint } });
  const ownerOnly = await recipients.recipientsFor(CHAT, { orgId: ORG, email: ALICE });
  check("the owner's own chat: the owner's devices, titled as they titled it", ownerOnly.length === 1 && ownerOnly[0].email === ALICE && ownerOnly[0].title === "Quarterly review", ownerOnly);
  const [thread] = await admin`insert into chat_threads (org_id, client_key, eve_session_id, title, owner_email) values (${ORG}, ${CHAT}, ${CHAT}, 'Quarterly review (shared)', ${ALICE}) returning id`;
  await admin`insert into chat_thread_members (thread_id, org_id, email, role, status, invited_by, accepted_at) values (${thread.id}, ${ORG}, ${BOB}, 'participant', 'accepted', ${ALICE}, now())`;
  const shared = await recipients.recipientsFor(CHAT, { orgId: ORG, email: ALICE });
  check("a shared thread adds its participants who turned notifications on", shared.length === 2 && shared.some((r) => r.email === BOB), shared.map((r) => r.email));
  check("a session that is not a chat (a workflow step) notifies nobody", (await recipients.recipientsFor(`${SID}_run`, { orgId: ORG, email: ALICE })).length === 0);
  const vapid = { publicKey: "x", privateKey: "y", subject: "mailto:ops@probe.example" };
  const result = await pushNotify.notify(
    {
      vapid: () => vapid,
      recipients: recipients.recipientsFor,
      send: async (t) => ({ status: t.email === BOB ? 410 : 201, gone: t.email === BOB }),
      forget: recipients.forgetSubscription,
    },
    { kind: "reply", sessionId: CHAT, turnId: "turn_1", text: "Done." },
    { orgId: ORG, email: ALICE },
  );
  const bobLeft = (await admin`select count(*)::int n from push_subscriptions where endpoint = ${bobEndpoint}`)[0].n;
  check("a 410 from the push service removes that device; the others are sent", result.sent === 1 && result.removed === 1 && bobLeft === 0, { result, bobLeft });
  check("the owner turns it off (and on sign-out)", (await subs.removeSubscription(runIn, { orgId: ORG, email: ALICE, endpoint })) === 1);

  console.log("\n5. Review of #63 — each of these failed on 2a1d80c");
  await guarded(async () => {
  {
    // R1: a colleague queues into someone else's session.
    const R1 = `${SID}_r1`;
    await ownChat(R1, ALICE);
    const r1 = await q.enqueueItem(runIn, { orgId: ORG, email: MALLORY, item: item(R1, "mallory text into alice's chat") });
    check("R1: a colleague cannot queue into someone else's chat", !r1.ok && r1.reason === "not-your-chat", r1);
    const unknown = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(`${SID}_nobody`, "into a session nobody recorded") });
    check("…nor into a session the agent never recorded anyone running", !unknown.ok && unknown.reason === "not-your-chat");
    const listedOther = `${SID}_r1_listed`;
    await ownChat(listedOther, ALICE);
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${listedOther}, ${ORG}, ${MALLORY}, ${listedOther}, 'x')`;
    const mismatch = await q.enqueueItem(runIn, { orgId: ORG, email: MALLORY, item: item(listedOther, "claimed via the chat list") });
    const mismatchA = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(listedOther, "and alice") });
    check("…and a chat-list row that disagrees with the agent's record is refused for both (never guessed)", !mismatch.ok && !mismatchA.ok);
    const stepS = `${SID}_r1_step`;
    await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) values (${stepS}, ${ORG}, ${ALICE}, 'person', 'workspace')`;
    const childS = `${SID}_r1_child`;
    await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, parent_session_id) values (${childS}, ${ORG}, ${ALICE}, 'person', 'owner', ${SID})`;
    const step = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(stepS, "into a workflow step") });
    const child = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(childS, "into a specialist's session") });
    check("…nor into a workspace-visible step or a specialist's child session (only a person's own chat)", !step.ok && !child.ok);
    const sharedS = `${SID}_r1_shared`;
    await ownChat(sharedS, ALICE);
    await admin`insert into chat_threads (org_id, client_key, eve_session_id, title, owner_email) values (${ORG}, ${sharedS}, ${sharedS}, 'shared', ${ALICE})`;
    const sh = await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(sharedS, "into a shared thread") });
    check("…and never into a shared thread (its turns go through the thread's relay)", !sh.ok && sh.reason === "not-your-chat");
  }
  });
  await guarded(async () => {
  for (const by of ["server", "tab"]) {
    // R2c: rows of two people in one session (planted, as the old enqueue allowed), Mallory's first, and edited.
    const R2 = `${SID}_r2c_${by}`;
    await ownChat(R2, ALICE);
    const eve = fakeEve();
    const m = item(R2, "MALLORY TEXT");
    await admin`insert into chat_queue_items (id, org_id, owner_email, eve_session_id, text, message, settings, position)
                values (${m.id}, ${ORG}, ${MALLORY}, ${R2}, 'MALLORY TEXT', 'MALLORY TEXT (edited)', ${JSON.stringify(BUILD)}::jsonb, 1)`;
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(R2, "alice text") });
    const res = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R2, by, ...(by === "tab" ? { caller: { email: ALICE, bearer: "ALICE-OWN-TOKEN" } } : {}) });
    check(
      `R2c (${by}): nobody's text is ever sent as another person — only Alice's own item goes, as Alice`,
      eve.posts.length === 1 && words(eve.posts[0].body.message) === "alice text" && /^(ALICE-OWN-TOKEN|minted:alice@probe\.example:)/.test(eve.posts[0].bearer),
      { reason: res.reason, posts: eve.posts.map((p) => [p.bearer, p.body.message]) },
    );
    check(`…(${by}) the planted row is never claimed`, (await itemRow(m.id)).state === "queued");
  }
  });
  await guarded(async () => {
  {
    // R2b: Alice's tab drains; her own item vanishes mid-drain; the next row is someone else's.
    const R2b = `${SID}_r2b`;
    await ownChat(R2b, ALICE);
    const eve = fakeEve();
    const a = item(R2b, "alice text");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: a });
    await admin`insert into chat_queue_items (id, org_id, owner_email, eve_session_id, text, message, settings, position)
                values (${`r2b_m_${STAMP}`}, ${ORG}, ${MALLORY}, ${R2b}, 'x', 'MALLORY via alice''s tab', ${JSON.stringify(BUILD)}::jsonb, 9)`;
    const deps = eve.deps({ readTail: async (_s, _b, n) => { await q.removeQueued(runIn, { orgId: ORG, email: ALICE, id: a.id }); return eve.tail(n); } });
    const res = await d.drainSession(deps, { orgId: ORG, sessionId: R2b, by: "tab", caller: { email: ALICE, bearer: "ALICE-GOOGLE-ID-TOKEN" } });
    check("R2b: Alice's tab never carries someone else's text", eve.posts.length === 0, { reason: res.reason, posts: eve.posts });
  }
  });
  await guarded(async () => {
  {
    // R2: the token is minted for the CLAIMED row's owner, whatever was "next" when the drain looked.
    const R2 = `${SID}_r2`;
    await ownChat(R2, ALICE);
    const eve = fakeEve();
    const minted = [];
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(R2, "alice's own queued text") });
    const res = await d.drainSession(eve.deps({ mint: async (em, org, sid, scope) => (minted.push([em, org, sid, scope?.act]), `minted:${em}:${org}:${sid}`) }), { orgId: ORG, sessionId: R2, by: "server" });
    check("R2: every token is minted for the owner, bound to this workspace and this session", res.reason === "sent" && minted.length > 0 && minted.every(([em, org, sid]) => em === ALICE && org === ORG && sid === R2), minted);
  }
  });
  await guarded(async () => {
  {
    // R3 / 2a: a removed member's queued item is not sent as them.
    const R3 = `${SID}_r3`;
    await ownChat(R3, BOB);
    const eve = fakeEve();
    await q.enqueueItem(runIn, { orgId: ORG, email: BOB, item: item(R3, "bob queued before removal") });
    await admin`delete from org_members where org_id = ${ORG} and email = ${BOB}`;
    const res = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R3, by: "server" });
    check("R3: a removed member's queue is not sent as them", res.reason === "not-member" && eve.posts.length === 0, res);
    const refused = await q.enqueueItem(runIn, { orgId: ORG, email: BOB, item: item(R3, "after removal") });
    check("…and they cannot queue any more", !refused.ok);
    // 2b: the removal clears their rows in this workspace — with the membership, in one transaction.
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${BOB}, 'member') on conflict do nothing`;
    await admin`insert into push_subscriptions (org_id, owner_email, endpoint, p256dh, auth) values (${ORG}, ${BOB}, ${`https://fcm.googleapis.com/fcm/send/rm-${STAMP}`}, 'k', 'a')`;
    const { removeMemberEverywhere } = await import("../lib/member-removal.ts");
    const removed = await removeMemberEverywhere(runIn, { orgId: ORG, email: BOB });
    const left = (await admin`select (select count(*)::int from chat_queue_items where org_id = ${ORG} and owner_email = ${BOB} and state <> 'sent') + (select count(*)::int from push_subscriptions where org_id = ${ORG} and owner_email = ${BOB}) + (select count(*)::int from org_members where org_id = ${ORG} and email = ${BOB}) as n`)[0].n;
    check("2b: removing a member deletes their membership, queued items and devices in that workspace", removed.membership === 1 && removed.queued >= 1 && removed.devices === 1 && left === 0, { removed, left });
    const route = readFileSync("app/api/ops/orgs/[id]/members/[email]/route.ts", "utf8");
    check("…and the member-removal route does exactly that, and answers 500 (not a silent success) when it fails", /removeMemberEverywhere\(/.test(route) && /status: 500/.test(route));
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${BOB}, 'member') on conflict do nothing`;
  }
  });
  await guarded(async () => {
    // Second review, 1: the queue acts for MEMBERS only — never for an unverified same-domain email.
    const R3b = `${SID}_r3b`;
    await ownChat(R3b, BOB);
    await admin`update orgs set google_hosted_domain = 'probe.example' where org_id = ${ORG}`;
    const eve = fakeEve();
    await q.enqueueItem(runIn, { orgId: ORG, email: BOB, item: item(R3b, "bob queued before removal") });
    await admin`delete from org_members where org_id = ${ORG} and email = ${BOB}`;
    const res = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R3b, by: "server" });
    check("R3 (2nd review): a removed member whose email shares the workspace's domain is NOT sent as", res.reason === "not-member" && eve.posts.length === 0, res);
    const CH = `${SID}_r3b_chat`;
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${CH}, ${ORG}, ${BOB}, ${CH}, 'Bob chat')`;
    await admin`insert into push_subscriptions (org_id, owner_email, endpoint, p256dh, auth) values (${ORG}, ${BOB}, ${`https://fcm.googleapis.com/fcm/send/b3-${STAMP}`}, 'k', 'a')`;
    check("…nor notified", (await recipients.recipientsFor(CH, { orgId: ORG, email: BOB })).length === 0);
    // …and a claim left in flight for them is ended, freeing the session.
    const R3c = `${SID}_r3c`;
    await ownChat(R3c, BOB);
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${BOB}, 'member') on conflict do nothing`;
    const it = item(R3c, "bob in flight");
    await q.enqueueItem(runIn, { orgId: ORG, email: BOB, item: it });
    await q.claimNextQueued(runIn, { orgId: ORG, sessionId: R3c, owner: BOB, claimId: "dead", restMark: "m" });
    await admin`update chat_queue_items set claimed_at = now() - interval '5 minutes' where id = ${it.id}`;
    await admin`delete from org_members where org_id = ${ORG} and email = ${BOB}`;
    const res2 = await d.drainSession(fakeEve().deps(), { orgId: ORG, sessionId: R3c, by: "server" });
    check("…a removed member's stale in-flight claim is ended as failed (slot freed), then not-member", res2.reason === "not-member" && (await itemRow(it.id)).state === "failed", { reason: res2.reason, state: (await itemRow(it.id)).state });
    await admin`update orgs set google_hosted_domain = null where org_id = ${ORG}`;
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${BOB}, 'member') on conflict do nothing`;
  });
  await guarded(async () => {
    // Second review, 1: one status rule for "a domain resolves to this workspace", web and agent alike.
    const DOM = `trial-${STAMP}.example`;
    const TORG = `queue-probe-trial-${STAMP}`;
    await admin`insert into orgs (org_id, name, status, google_hosted_domain) values (${TORG}, 'Trial', 'trial', ${DOM})`;
    try {
      const { resolveOrg } = await import("../agent/lib/org-context.ts");
      const got = await resolveOrg(`carol@${DOM}`, DOM);
      check("the agent resolves a verified hosted domain to a workspace in any status but suspended (as the web app does)", got === TORG, got);
      const web = readFileSync("lib/org-context.ts", "utf8");
      const agentSrc = readFileSync("agent/lib/org-context.ts", "utf8");
      check("…both from one shared rule (lib/workspace-rules.ts resolvableByDomain)", /resolvableByDomain\(orgs\.status\)/.test(web) && /resolvableByDomain\(orgs\.status\)/.test(agentSrc));
    } finally {
      await admin`delete from orgs where org_id = ${TORG}`;
    }
  });
  await guarded(async () => {
    // Second review, 2: the removal is ONE transaction — a failed cleanup removes nothing.
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${MALLORY}, 'member') on conflict do nothing`;
    await admin`insert into push_subscriptions (org_id, owner_email, endpoint, p256dh, auth) values (${ORG}, ${MALLORY}, ${`https://fcm.googleapis.com/fcm/send/tx-${STAMP}`}, 'k', 'a')`;
    await admin.unsafe(`CREATE OR REPLACE FUNCTION probe_block_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'cleanup failed'; END $$ LANGUAGE plpgsql`);
    await admin.unsafe(`CREATE TRIGGER probe_block_delete BEFORE DELETE ON push_subscriptions FOR EACH ROW EXECUTE FUNCTION probe_block_delete()`);
    let threw = false;
    try {
      const { removeMemberEverywhere } = await import("../lib/member-removal.ts");
      await removeMemberEverywhere(runIn, { orgId: ORG, email: MALLORY });
    } catch {
      threw = true;
    } finally {
      await admin.unsafe(`DROP TRIGGER IF EXISTS probe_block_delete ON push_subscriptions`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS probe_block_delete()`);
    }
    const still = (await admin`select count(*)::int n from org_members where org_id = ${ORG} and email = ${MALLORY}`)[0].n;
    check("2: when the cleanup fails, the removal fails and the membership is untouched (one transaction)", threw && still === 1, { threw, still });
  });
  await guarded(async () => {
    // Second review, 4: only THIS delivery's receipt counts — the same words sent another way prove nothing.
    const R9 = `${SID}_r9`;
    await ownChat(R9, ALICE);
    const eve = fakeEve();
    const it = item(R9, "the same words");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: it });
    await q.claimNextQueued(runIn, { orgId: ORG, sessionId: R9, owner: ALICE, claimId: "lost", restMark: eve.markOf(1) });
    await admin`update chat_queue_items set claimed_at = now() - interval '5 minutes' where id = ${it.id}`;
    eve.startTurn("the same words"); // typed again by hand: identical text, no delivery reference
    eve.settle();
    const res = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R9, by: "server" });
    check("4: the same text sent another way does NOT mark a lost queued item as sent", res.reason === "unknown" && (await itemRow(it.id)).state === "sending", { reason: res.reason, state: (await itemRow(it.id)).state });
    const R10 = `${SID}_r10`;
    await ownChat(R10, ALICE);
    const e2 = fakeEve();
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(R10, "tagged") });
    const r = await d.drainSession(e2.deps(), { orgId: ORG, sessionId: R10, by: "server" });
    const body = e2.posts[0]?.body.message ?? "";
    check("…every delivery carries a reference unique to its claim, and the tab is told exactly what went", /ref server-\d+-[a-z0-9]+\.\) ⁦\/directives⁩$/.test(body) && r.delivered?.message === body, body.slice(-120));
    const { displayText } = await import("../lib/chat-attachments.ts");
    check("…and a reader never sees it", displayText(body) === "tagged");
  });
  await guarded(async () => {
    // Second review, 3: the post token is single-use and only carries the claimed item.
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.AUTH_JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
    const pub = publicKey.export({ type: "spki", format: "pem" });
    const auth = await import("../lib/auth-session.ts");
    const qda = await import("../agent/lib/queue-delivery-auth.ts");
    // The door checks; the session guard SPENDS (once per request — eve re-runs the door inside its handler). An
    // admission here is both, as a request through the real channel gets them.
    const check1 = qda.queueDeliveryAuth(pub);
    const door = async (r) => {
      const ok = await check1(r.clone());
      if (!ok || !qda.consumePostInDb) return ok;
      const claims = qda.claimsOf(r);
      if (claims?.act !== "post") return ok;
      const post = qda.postClaimOf(claims, claims.sid, await r.clone().json().catch(() => null));
      return post && (await qda.consumePostInDb(post)) ? ok : null;
    };
    const R11 = `${SID}_r11`;
    await ownChat(R11, ALICE);
    const it = item(R11, "exactly this");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: it });
    const claim = await q.claimNextQueued(runIn, { orgId: ORG, sessionId: R11, owner: ALICE, claimId: "c11", restMark: "m" });
    const post = (seq) => auth.mintQueueDeliveryToken(ALICE, { org: ORG, sessionId: R11, scope: { act: "post", item: it.id, claim: "c11", seq } });
    const read = await auth.mintQueueDeliveryToken(ALICE, { org: ORG, sessionId: R11, scope: { act: "read" } });
    const req = (method, path, token, reqBody) =>
      new Request(`https://agent.example${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(reqBody ? { body: JSON.stringify(reqBody) } : {}) });
    const good = { continuationToken: "ct", message: it.message + deliveryReference("c11") };
    const t1 = await post(1);
    const claims = JSON.parse(Buffer.from(t1.split(".")[1], "base64url").toString());
    check("3: the post token has a jti, one session, one item, one claim", Boolean(claims.jti) && claims.sid === R11 && claims.item === it.id && claims.claim === "c11" && claims.act === "post" && claim?.id === it.id);
    check("…admitted once for exactly the claimed item's body", Boolean(await door(req("POST", `/eve/v1/session/${R11}`, t1, good))));
    check("…and refused when replayed", !(await door(req("POST", `/eve/v1/session/${R11}`, t1, good))));
    const t2 = await post(2);
    check("…refused with any other text", !(await door(req("POST", `/eve/v1/session/${R11}`, t2, { ...good, message: "something else" }))));
    check("…refused carrying inputResponses (it cannot answer a question)", !(await door(req("POST", `/eve/v1/session/${R11}`, t2, { ...good, inputResponses: [{ requestId: "r", optionId: "approve" }] }))));
    check("…refused on the stream, on cancel, on a new session", !(await door(req("POST", `/eve/v1/session/${R11}/stream`, t2, good))) && !(await door(req("POST", `/eve/v1/session/${R11}/cancel`, t2, good))) && !(await door(req("POST", "/eve/v1/session", t2, good))));
    check("…a fresh token for the next attempt of the same claim is admitted (a retry)", Boolean(await door(req("POST", `/eve/v1/session/${R11}`, t2, good))));
    check("…but an OLDER one is not (single-use is ordered)", !(await door(req("POST", `/eve/v1/session/${R11}`, await post(2), good))));
    await q.releaseClaim(runIn, { orgId: ORG, id: it.id, claimId: "c11", error: null });
    check("…and nothing once the claim is over", !(await door(req("POST", `/eve/v1/session/${R11}`, await post(9), good))));
    check("the read token reads the stream only", Boolean(await door(req("GET", `/eve/v1/session/${R11}/stream`, read))) && !(await door(req("POST", `/eve/v1/session/${R11}`, read, good))));
  });
  await guarded(async () => {
  {
    // R4: a claim held for days on a session that can no longer be read.
    const R4 = `${SID}_r4`;
    await ownChat(R4, ALICE);
    const eve = fakeEve();
    const a1 = item(R4, "alice 1");
    const a2 = item(R4, "alice 2");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: a1 });
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: a2 });
    await q.claimNextQueued(runIn, { orgId: ORG, sessionId: R4, owner: ALICE, claimId: "dead", restMark: "t1|ct-1" });
    await admin`update chat_queue_items set claimed_at = now() - interval '3 days' where id = ${a1.id}`;
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await d.drainSession(eve.deps({ readTail: async () => null }), { orgId: ORG, sessionId: R4, by: "server" })).reason);
    check("R4: an unsettleable claim past the hard timeout ends as FAILED (not stuck for ever)", (await itemRow(a1.id)).state === "failed", { out, state: (await itemRow(a1.id)).state });
    const listed = await q.listQueue(runIn, { orgId: ORG, email: ALICE, sessionId: R4 });
    check("…shown to the person (\"Didn't send — Send again\")", listed.some((r) => r.id === a1.id && r.state === "failed"));
    const next = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R4, by: "server" });
    check("…and the one-in-flight slot is free: the next item goes", next.reason === "sent" && words(eve.posts[0]?.body.message) === "alice 2", next);
    const again = await q.updateQueued(runIn, { orgId: ORG, email: ALICE, id: a1.id, patch: { requeue: true } });
    check("…\"Send again\" puts it back in line", again?.state === "queued");
  }
  });
  await guarded(async () => {
  {
    // R5: another workspace's in-flight row on the same session id.
    const R5 = `${SID}_r5`;
    await ownChat(R5, ALICE);
    await admin`insert into chat_queue_items (id, org_id, owner_email, eve_session_id, text, message, settings, position, state, claim_id, claimed_at)
                values (${`r5_other_${STAMP}`}, ${ORG2}, ${MALLORY}, ${R5}, 'x', 'x', ${JSON.stringify(BUILD)}::jsonb, 1, 'sending', 'x', now())`;
    const eve = fakeEve();
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(R5, "alice") });
    const res = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R5, by: "server" });
    check("R5: another workspace's row never blocks this workspace's queue", res.reason === "sent" && eve.posts.length === 1, res);
  }
  });
  await guarded(async () => {
  {
    // 7c: a stale claim is settled only by ITS OWN receipt — not because someone else's turn moved the session.
    const R7 = `${SID}_r7`;
    await ownChat(R7, ALICE);
    const eve = fakeEve();
    const it = item(R7, "alice lost item");
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: it });
    await q.claimNextQueued(runIn, { orgId: ORG, sessionId: R7, owner: ALICE, claimId: "dead", restMark: eve.markOf(1) });
    await admin`update chat_queue_items set claimed_at = now() - interval '5 minutes' where id = ${it.id}`;
    eve.otherTurn();
    eve.settle();
    const res = await d.drainSession(eve.deps(), { orgId: ORG, sessionId: R7, by: "server" });
    check("7c: another sender's turn moving the session does NOT mark a lost item sent", (await itemRow(it.id)).state === "sending" && res.reason === "unknown", { reason: res.reason, state: (await itemRow(it.id)).state });
    // 7d: claim age comes from the database's clock, not this machine's.
    const R8 = `${SID}_r8`;
    await ownChat(R8, ALICE);
    await q.enqueueItem(runIn, { orgId: ORG, email: ALICE, item: item(R8, "fresh claim") });
    await q.claimNextQueued(runIn, { orgId: ORG, sessionId: R8, owner: ALICE, claimId: "live", restMark: "m" });
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 60_000; // this machine's clock an hour ahead
    let res8;
    try {
      res8 = await d.drainSession(fakeEve().deps({ readTail: async () => null }), { orgId: ORG, sessionId: R8, by: "server" });
    } finally {
      Date.now = realNow;
    }
    check("7d: a claim a second old is still \"delivering\" even with this machine's clock an hour ahead", res8.reason === "delivering", res8);
  }
  });
  await guarded(async () => {
  {
    // 2: recipients are only people who can still act in the workspace.
    const CH = `${SID}_notify_member`;
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${CH}, ${ORG}, ${MALLORY}, ${CH}, 'Mallory chat')`;
    await admin`insert into push_subscriptions (org_id, owner_email, endpoint, p256dh, auth) values (${ORG}, ${MALLORY}, ${`https://fcm.googleapis.com/fcm/send/m-${STAMP}`}, 'k', 'a')`;
    const before = await recipients.recipientsFor(CH, { orgId: ORG, email: MALLORY });
    await admin`delete from org_members where org_id = ${ORG} and email = ${MALLORY}`;
    const after = await recipients.recipientsFor(CH, { orgId: ORG, email: MALLORY });
    check("2: a removed member's devices get no notification, even before their rows are cleaned up", before.length >= 1 && after.length === 0, { before: before.length, after: after.length });
    await admin`insert into org_members (org_id, email, role) values (${ORG}, ${MALLORY}, 'member')`;
  }
  });
  await guarded(async () => {
  {
    // 5: the owner-only policies survive a redeploy: drizzle-kit push --force (drops them), then the bootstrap.
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env, DATABASE_URL: adminUrl };
    execFileSync("npx", ["drizzle-kit", "push", "--force"], { env, stdio: "ignore", timeout: 180_000 });
    const afterPush = await admin`select policyname from pg_policies where policyname in ('chat_queue_owner', 'push_subscriptions_owner')`;
    execFileSync(process.execPath, ["scripts/bootstrap-test-db.mjs"], { env, stdio: "ignore", timeout: 120_000 });
    const afterBoot = await admin`select tablename, policyname, permissive from pg_policies where policyname in ('chat_queue_owner', 'push_subscriptions_owner')`;
    const rls = await admin`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('chat_queue_items', 'push_subscriptions')`;
    check(
      "5: after push --force and the bootstrap, both RESTRICTIVE owner policies are back, RLS on and forced",
      afterPush.length === 0 && afterBoot.length === 2 && afterBoot.every((p) => p.permissive === "RESTRICTIVE") && rls.every((r) => r.relrowsecurity && r.relforcerowsecurity),
      { afterPush: afterPush.length, afterBoot, rls },
    );
    const deployBootstrap = readFileSync(".bootstrap-supabase.mjs", "utf8");
    check("…and the deployment bootstrap applies the same policies", /applyOwnerOnlyPolicies\(sql\)/.test(deployBootstrap));
  }
  });
} finally {
  await admin`delete from chat_queue_items where org_id in (${ORG}, ${ORG2})`.catch(() => {});
  await admin`delete from push_subscriptions where org_id in (${ORG}, ${ORG2})`.catch(() => {});
  await admin`delete from chat_thread_members where org_id = ${ORG}`.catch(() => {});
  await admin`delete from chat_threads where org_id = ${ORG}`.catch(() => {});
  await admin`delete from chat_sessions where org_id = ${ORG}`.catch(() => {});
  await admin`delete from agent_session_owners where org_id in (${ORG}, ${ORG2})`.catch(() => {});
  await admin`delete from org_members where org_id in (${ORG}, ${ORG2})`.catch(() => {});
  await admin`delete from orgs where org_id in (${ORG}, ${ORG2})`.catch(() => {});
  await admin.end();
  await app.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
