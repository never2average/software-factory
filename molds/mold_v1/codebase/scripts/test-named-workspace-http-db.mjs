#!/usr/bin/env node
/**
 * A NAMED WORKSPACE IS NEVER SWAPPED FOR ANOTHER — over HTTP, against `next start` of a real build, as the restricted
 * app_rw role under the production FAIL-CLOSED policies.
 *
 * Found on a live deployment (2026-10-02): a platform admin's workspace list named every workspace, the console was
 * set to one they were not a member of, and the server — for which `x-ops-org` / `?org=` was "a preference" — dropped
 * the name and answered every request from their FIRST membership. The console showed one workspace's records, chats
 * and files under another's name, and a write made there landed in the wrong workspace. A made-up id did the same.
 *
 * Now a request that names a workspace is served from THAT workspace or refused (lib/org-context.ts):
 *
 *   1. a member of A naming B (it exists; they are not in it) is refused on reads AND on writes, and nothing is
 *      written to A (or to B);
 *   2. naming an id that does not exist is the same refusal, byte for byte (existence is not revealed);
 *   3. a platform admin who is not a member of B gets the same;
 *   4. a GUEST of one shared chat in B (not a member) still opens that chat, read-only, and nothing else of B;
 *      nobody else reaches a chat through a workspace they only name, and a chat of A is not served under B's name;
 *   5. with no workspace named, the default still works (the person's own, the last one they selected);
 *   6. the workspace list holds the caller's own workspaces only — a platform admin's too — and answers whatever
 *      workspace the request names, so the console can always offer them.
 *
 * Needs a production build in --dir (default: this checkout; CI reuses the relabelling build of the workbook step),
 * ADMIN_URL (seeding, policy DDL) and DATABASE_URL (app_rw). Without the URLs it skips. Rows live under throwaway
 * workspaces carrying this process's pid, removed in a finally block, and every policy is restored.
 *
 *   ADMIN_URL=… DATABASE_URL=… npm run test:named-workspace-http-db [-- --dir <built checkout>]
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { freePort, waitForNextStart } from "./lib/own-listener.mjs";

const adminUrl = process.env.ADMIN_URL;
const url = process.env.DATABASE_URL;
if (!adminUrl || !url) {
  console.log("test-named-workspace-http-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (the app_rw url).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIR = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : ROOT;
if (!existsSync(join(DIR, ".next", "BUILD_ID"))) {
  console.error(`test-named-workspace-http-db: no production build in ${DIR}/.next — run \`npm run build\` first.`);
  process.exit(2);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`}`); }
};

// The own fields the build's profile requires on a new row (the relabelling fixture declares some; the default none).
const { DEPLOYMENT_PROFILE: P } = await import(pathToFileURL(join(DIR, "lib/deployment-profile.generated.ts")).href);
const sample = (f) => (f.type === "pick_list" ? f.options[0] : f.type === "number" || f.type === "percent" ? 7 : f.type === "date" ? "2026-09-29" : f.type === "email" ? "x@example.com" : f.type === "link" ? "https://example.com/" : "text");
const requiredOf = (fields) => {
  const req = (fields ?? []).filter((f) => f.required);
  return req.length ? { custom: Object.fromEntries(req.map((f) => [f.key, sample(f)])) } : {};
};
const DEP_OWN = requiredOf(P.domains.deployments?.custom_fields);
const ACCOUNT_OWN = requiredOf(P.account_fields?.custom_fields);

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const PID = process.pid;
const A = `org-named-a-${PID}`; // the caller's own workspace
const B = `org-named-b-${PID}`; // exists; the caller is not a member of it
const NOWHERE = `no-such-org-${PID}`; // does not exist
const ALICE = `alice-${PID}@named-a.test`; // member of A only
const PADMIN = `padmin-${PID}@named-a.test`; // a platform admin; member (owner) of A only
const BOB = `bob-${PID}@named-b.test`; // member of B: owns the chats there
const DUO = `duo-${PID}@named-a.test`; // member of A and B; selected B last
const GUEST = `guest-${PID}@outside.test`; // in no workspace; one chat of B is shared with them
const ACME_A = `acme-a-${PID}`;
const BETA_B = `beta-b-${PID}`;
const NAME_A = `Acme of A ${PID}`;
const NAME_B = `Beta of B ${PID}`;
const PEOPLE = [ALICE, PADMIN, BOB, DUO, GUEST];
const chat = (n) => ({ id: randomUUID(), session: `wrun_named_${n}_${PID}` });
const SHARED = chat("shared"); // in B, shared with the guest
const PRIVATE = chat("private"); // in B, not shared
const OWN = chat("own"); // in A, alice's
const TABLES = ["customers", "deployments", "chat_sessions", "chat_threads", "chat_thread_members", "automation_audit", "entity_activity"];

async function unseed() {
  for (const t of ["chat_thread_members", "chat_threads", "chat_sessions", "agent_session_owners", "deployments", "platform", "solutions", "implementation", "tickets", "interactions", "internal_staff", "customer_stakeholders", "customers", "automation_audit", "entity_activity", "org_members"]) {
    await admin.unsafe(`delete from ${t} where org_id in ($1, $2)`, [A, B]).catch(() => {});
  }
  await admin`delete from platform_admins where email = ${PADMIN}`.catch(() => {});
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
}
/** Every row the two workspaces hold in the tables a refused write could have reached, as one string. */
const snapshot = async () => {
  const out = {};
  for (const t of TABLES) {
    out[t] = (await admin.unsafe(`select org_id, count(*)::int as n, md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by md5(to_jsonb(x)::text)), '')) as h from ${t} x where org_id in ($1, $2) group by org_id order by org_id`, [A, B]).catch((e) => [{ error: e.message }]));
  }
  return JSON.stringify(out);
};

const saved = new Map();
const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
const { mintSessionToken } = await import("../lib/auth-session.ts");
const tokens = Object.fromEntries(await Promise.all(PEOPLE.map(async (p) => [p, await mintSessionToken(p)])));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let server;
let log = "";
async function start() {
  server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: url, AUTH_JWT_PUBLIC_KEY: process.env.AUTH_JWT_PUBLIC_KEY, AUTH_JWT_PRIVATE_KEY: "", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  await waitForNextStart({ server, port, log: () => log });
}
/**
 * One call as `who`. `org` names the workspace in the `x-ops-org` header (what the console sends); `{ query: org }`
 * names it in `?org=` instead (what a link does); undefined names none.
 */
const call = async (who, org, method, path, body) => {
  const named = typeof org === "object" && org ? org.query : null;
  const target = named ? `${path}${path.includes("?") ? "&" : "?"}org=${encodeURIComponent(named)}` : path;
  const res = await fetch(`${base}${target}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(typeof org === "string" ? { "x-ops-org": org } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json ?? text, text };
};
let rpcId = 0;
const mcp = async (who, org, name, args = {}) => {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-ops-org": org },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, isError: Boolean(body?.result?.isError || body?.error), text: body?.result?.content?.map((c) => c.text).join("") ?? "", raw: body };
};

const REFUSAL = { error: "You are not a member of this workspace.", code: "workspace_refused" };
const refused = (r) => r.status === 403 && JSON.stringify(r.body) === JSON.stringify(REFUSAL);
/** Nothing of EITHER workspace in an answer: not the caller's own records under another name, not the named one's. */
const leaks = (r) => [NAME_A, NAME_B, ACME_A, BETA_B, OWN.session, SHARED.session, PRIVATE.session].filter((s) => r.text.includes(s));

/** The reads a console makes on every screen, and the writes a person makes, each tried while naming `org`. */
const READS = [
  ["GET", "/api/ops/customers"],
  ["GET", "/api/ops/chat-sessions"],
  ["GET", "/api/ops/threads"],
  ["GET", "/api/ops/workbook"],
  ["GET", "/api/ops/deployments"],
  ["GET", "/api/dataroom?list=1"],
];
const WRITES = (tag) => [
  ["POST", "/api/ops/customers", { customerId: `planted-${tag}-${PID}`, customerName: `Planted ${tag} ${PID}`, tier: "Tier-1", ...ACCOUNT_OWN }],
  ["POST", "/api/ops/customers", { customerId: ACME_A, customerName: `Renamed by ${tag} ${PID}` }],
  ["POST", "/api/ops/deployments", { customerId: ACME_A, deploymentId: `planted-${tag}-${PID}`, environment: "prod", region: "ap-south-1", deployedVersion: "x", ...DEP_OWN }],
  ["POST", "/api/ops/chat-sessions", { sessions: [{ id: `wrun_planted_${tag}_${PID}`, eveSessionId: `wrun_planted_${tag}_${PID}`, title: `Planted ${tag}` }] }],
  ["POST", "/api/ops/threads", { eveSessionId: OWN.session, title: `Planted ${tag}` }],
];
/** `who`, naming `org` (not theirs): every read and write is the refusal, nothing leaks, nothing is written. */
async function refusedEverywhere(who, org, tag, label) {
  const before = await snapshot();
  const reads = [];
  for (const [m, p] of READS) reads.push([`${m} ${p}`, await call(who, org, m, p)]);
  reads.push(["GET /api/ops/customers?org=…", await call(who, { query: org }, "GET", "/api/ops/customers")]);
  const notRefused = reads.filter(([, r]) => !refused(r)).map(([n, r]) => `${n} → ${r.status}`);
  check(`${label}: every read is refused (403, "You are not a member of this workspace.")`, notRefused.length === 0, notRefused);
  const leaked = reads.flatMap(([n, r]) => leaks(r).map((s) => `${n} shows ${s}`));
  check(`${label}: …and no read shows anything of any workspace (it showed the caller's own, under the other's name)`, leaked.length === 0, leaked);
  const writes = [];
  for (const [m, p, body] of WRITES(tag)) writes.push([`${m} ${p}`, await call(who, org, m, p, body)]);
  const wrote = writes.filter(([, r]) => !refused(r)).map(([n, r]) => `${n} → ${r.status}`);
  check(`${label}: every write is refused the same way`, wrote.length === 0, wrote);
  const after = await snapshot();
  check(`${label}: …and nothing was written — the caller's own workspace and the named one are unchanged`, after === before, after === before ? undefined : { before, after });
  return { reads, writes };
}

try {
  await unseed();
  // The production policy shape: an unscoped read sees nothing (.migrate-rls-fail-closed.mjs).
  const policies = await admin`select tablename, qual from pg_policies where schemaname = 'public' and policyname = 'org_isolation'`;
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const { tablename, qual } of policies) {
    saved.set(tablename, qual);
    await admin.unsafe(`alter policy org_isolation on "${tablename}" using ${closed} with check ${closed}`);
  }
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Named desk A', 'active'), (${B}, 'Named desk B', 'active')`;
  await admin`insert into org_members (org_id, email, role, accepted_at, last_selected_at) values
    (${A}, ${ALICE}, 'member', now(), null), (${A}, ${PADMIN}, 'owner', now(), null), (${B}, ${BOB}, 'owner', now(), null),
    (${A}, ${DUO}, 'member', now(), now() - interval '1 day'), (${B}, ${DUO}, 'member', now(), now())`;
  await admin`insert into platform_admins (email, added_by) values (${PADMIN}, 'test')`;
  await admin`insert into customers (customer_id, org_id, customer_name) values (${ACME_A}, ${A}, ${NAME_A}), (${BETA_B}, ${B}, ${NAME_B})`;
  for (const [c, org, owner] of [[SHARED, B, BOB], [PRIVATE, B, BOB], [OWN, A, ALICE]]) {
    await admin`insert into chat_threads (id, org_id, eve_session_id, title, owner_email) values (${c.id}, ${org}, ${c.session}, ${`chat ${c.session}`}, ${owner})`;
    await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) values (${c.session}, ${org}, ${owner}, 'person', 'owner')`;
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${c.session}, ${org}, ${owner}, ${c.session}, ${`chat ${c.session}`})`;
  }
  await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by, invited_at, expires_at) values
    (${B}, ${SHARED.id}, ${GUEST}, 'viewer', 'invited', ${BOB}, now(), now() + interval '14 days')`;
  await start();

  console.log("1. A member of A naming B (it exists; they are not a member) — reads and writes");
  const control = await call(ALICE, A, "GET", "/api/ops/customers");
  check("control: naming her own workspace A, she reads A's company", control.status === 200 && control.text.includes(NAME_A) && !control.text.includes(NAME_B), control.body);
  const b1 = await refusedEverywhere(ALICE, B, "alice-b", "member of A naming B");

  console.log("2. Naming a workspace that does not exist — the same refusal");
  const n1 = await refusedEverywhere(ALICE, NOWHERE, "alice-none", "member of A naming an id that does not exist");
  const same = b1.reads.concat(b1.writes).every(([name, r], i) => {
    const other = n1.reads.concat(n1.writes)[i][1];
    return r.status === other.status && r.text === other.text;
  });
  check("unknown and not-a-member answer identically, call for call (status and body): existence is not revealed", same);

  console.log("3. A platform admin who is not a member of B");
  const pControl = await call(PADMIN, A, "GET", "/api/ops/customers");
  check("control: in A, where she is a member, the platform admin reads A's company", pControl.status === 200 && pControl.text.includes(NAME_A), pControl.body);
  await refusedEverywhere(PADMIN, B, "padmin-b", "platform admin naming B");
  await refusedEverywhere(PADMIN, NOWHERE, "padmin-none", "platform admin naming an id that does not exist");
  const viaMcp = await mcp(PADMIN, B, "customer_list");
  check("…through the hosted MCP endpoint too: a tool error with the same sentence, none of A's companies", viaMcp.isError && /not a member of this workspace/i.test(viaMcp.text) && !JSON.stringify(viaMcp.raw).includes(NAME_A), viaMcp.raw);

  console.log("4. A guest of one shared chat in B still opens that chat — and only that");
  const thread = (who, org, c) => call(who, org, "GET", `/api/ops/threads/${c.id}`);
  const g1 = await thread(GUEST, B, SHARED);
  check("the guest, naming the chat's workspace B, opens the shared chat (200)", g1.status === 200 && g1.body?.item?.id === SHARED.id, g1.body);
  check("…read-only, shown none of the workspace's people", g1.body?.item?.role === "viewer" && (g1.body?.item?.members ?? []).length === 0 && !g1.body?.item?.ownerEmail, g1.body?.item);
  const g1q = await thread(GUEST, { query: B }, SHARED);
  check("…and through the link's `?org=` as well", g1q.status === 200 && g1q.body?.item?.id === SHARED.id, g1q.status);
  check("another chat of B does not open for the guest (404)", (await thread(GUEST, B, PRIVATE)).status === 404);
  check("the shared chat does not open without naming its workspace (404)", (await thread(GUEST, undefined, SHARED)).status === 404);
  const gWrite = await call(GUEST, B, "POST", `/api/ops/threads/${SHARED.id}/members`, { email: `friend-${PID}@work-named.test`, role: "viewer" });
  const gMembers = await admin`select email from chat_thread_members where thread_id = ${SHARED.id}`;
  check("the guest cannot share it on (403, no member added)", gWrite.status === 403 && gMembers.length === 1, [gWrite.status, gMembers]);
  const gLists = [];
  for (const [m, p] of READS) gLists.push([p, await call(GUEST, B, m, p)]);
  check("B's lists are refused for the guest (nothing of B beyond the chat)", gLists.every(([, r]) => refused(r) && leaks(r).length === 0), gLists.filter(([, r]) => !refused(r)).map(([p, r]) => `${p} → ${r.status}`));
  check("a member of A who was not invited does not open B's chat by naming B (404)", (await thread(ALICE, B, SHARED)).status === 404);
  check("her own chat of A opens naming A (200)", (await thread(ALICE, A, OWN)).status === 200);
  const swapped = await thread(ALICE, B, OWN);
  check("…and is NOT served under B's name (404): a chat of A was found there, in her own workspace, first", swapped.status === 404, swapped.status);
  check("…nor under a name that does not exist (404)", (await thread(ALICE, NOWHERE, OWN)).status === 404);

  console.log("5. With no workspace named, the default still works");
  const d1 = await call(ALICE, undefined, "GET", "/api/ops/customers");
  check("a member of A naming nothing reads A", d1.status === 200 && d1.text.includes(NAME_A) && !d1.text.includes(NAME_B), d1.body);
  const d2 = await call(DUO, undefined, "GET", "/api/ops/customers");
  check("someone in both, naming nothing, reads the one they selected last (B)", d2.status === 200 && d2.text.includes(NAME_B) && !d2.text.includes(NAME_A), d2.body);
  const d3 = await call(DUO, A, "GET", "/api/ops/customers");
  const d4 = await call(DUO, { query: B }, "GET", "/api/ops/customers");
  check("…and naming either of their own workspaces reads that one", d3.text.includes(NAME_A) && !d3.text.includes(NAME_B) && d4.text.includes(NAME_B) && !d4.text.includes(NAME_A), [d3.status, d4.status]);
  const d5 = await call(PADMIN, undefined, "GET", "/api/ops/customers");
  check("the platform admin naming nothing reads her own workspace A", d5.status === 200 && d5.text.includes(NAME_A) && !d5.text.includes(NAME_B), d5.body);
  const w1 = await call(ALICE, A, "POST", "/api/ops/customers", { customerId: `kept-${PID}`, customerName: `Kept ${PID}`, tier: "Tier-1", ...ACCOUNT_OWN });
  const kept = await admin`select org_id from customers where customer_id = ${`kept-${PID}`}`;
  check("a write naming her own workspace lands there (the refused writes above were valid requests)", w1.status === 201 && kept.length === 1 && kept[0].org_id === A, [w1.status, w1.body, kept]);

  console.log("6. The workspace list: the caller's own workspaces only, whatever the request names");
  const ids = (r) => (r.body?.items ?? []).map((o) => o.orgId).filter((id) => id === A || id === B).sort();
  const lAdmin = await call(PADMIN, undefined, "GET", "/api/ops/orgs");
  check("a platform admin's list holds the workspace she is a member of", lAdmin.status === 200 && ids(lAdmin).includes(A), lAdmin.body);
  check("…and NOT the one she is not a member of (it was listed, as role \"admin\")", !ids(lAdmin).includes(B) && !(lAdmin.body?.items ?? []).some((o) => o.orgId !== A && /Named desk/.test(o.name ?? "")), ids(lAdmin));
  check("…with her real role there, and still marked a platform admin", (lAdmin.body?.items ?? []).find((o) => o.orgId === A)?.role === "owner" && lAdmin.body?.platformAdmin === true, lAdmin.body);
  const everyListed = (lAdmin.body?.items ?? []).map((o) => o.orgId);
  const members = (await admin`select org_id from org_members where email = ${PADMIN}`).map((r) => r.org_id);
  check("…every workspace on it is one she can open (a membership)", everyListed.every((id) => members.includes(id)), { everyListed, members });
  const lAlice = await call(ALICE, undefined, "GET", "/api/ops/orgs");
  check("a member's list is her own workspace, and no platform-admin mark", JSON.stringify(ids(lAlice)) === JSON.stringify([A]) && !("platformAdmin" in (lAlice.body ?? {})), lAlice.body);
  const lDuo = await call(DUO, undefined, "GET", "/api/ops/orgs");
  check("someone in both sees both", JSON.stringify(ids(lDuo)) === JSON.stringify([A, B].sort()), lDuo.body);
  // The console must be able to offer a refused person their own workspaces: these two answer about the CALLER.
  const lRefused = await call(PADMIN, B, "GET", "/api/ops/orgs");
  const mine = await call(PADMIN, NOWHERE, "GET", "/api/ops/me/workspaces");
  check("naming a workspace she is not in, the list still answers with her own (200)", lRefused.status === 200 && JSON.stringify(ids(lRefused)) === JSON.stringify([A]), lRefused.body);
  check("…and so does `me/workspaces`, with her memberships to offer", mine.status === 200 && (mine.body?.memberships ?? []).some((m) => m.orgId === A) && !(mine.body?.memberships ?? []).some((m) => m.orgId === B), mine.body);
  const pick = await call(PADMIN, B, "POST", "/api/ops/me/workspaces/active", { orgId: A });
  check("…and she can choose one of them from there (the refusal page's button)", pick.status === 200 && pick.body?.orgId === A, pick.body);
  const guestList = await call(GUEST, B, "GET", "/api/ops/orgs");
  check("a guest's list is empty", guestList.status === 200 && (guestList.body?.items ?? []).length === 0, guestList.body);
} finally {
  server?.kill("SIGTERM");
  for (const [t, qual] of saved) await admin.unsafe(`alter policy org_isolation on "${t}" using (${qual}) with check (${qual})`).catch(() => {});
  await unseed();
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-named-workspace-http-db: ${failures.length} failed, ${passed} passed`);
  if (log && process.env.SHOW_SERVER_LOG) console.error(log.slice(-4000));
  process.exit(1);
}
console.log(`\ntest-named-workspace-http-db: all ${passed} checks passed`);
