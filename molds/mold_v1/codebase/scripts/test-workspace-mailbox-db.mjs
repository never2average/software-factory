/**
 * ONE WORKSPACE'S MAIL NEVER BECOMES ANOTHER'S — email intake and the inbox tools read the caller's OWN mailbox.
 *
 * Email intake (agent/lib/email-intake.ts) and list_inbox / draft_email (agent/lib/email.ts) read ONE deployment-wide
 * IMAP inbox from whichever workspace ran them, and intake routed that inbox's mail by matching the caller's
 * companies: with the same company in two workspaces (mold_v1-118), one workspace's mail became a ticket in the
 * other. Now a workspace's mailbox is its own `gmail` connector (secrets decrypted in its scope), or the deployment
 * mailbox only for the workspace IMAP_WORKSPACE binds it to (agent/lib/workspace-mailbox.ts).
 *
 * Against a real Postgres as app_rw (CI's isolation job): connector_secrets is RLS-strict, so this also proves the
 * credential read happens inside the workspace's own scope. No mail server is contacted.
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:workspace-mailbox-db
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-workspace-mailbox-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
process.env.OPS_SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
for (const k of ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "IMAP_WORKSPACE"]) delete process.env[k];

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const stamp = Date.now();
const A = `mailbox-a-${stamp}`;
const B = `mailbox-b-${stamp}`;
// Absent on `main` (where this test was first run): reported as failures, and the rest still runs.
const { mailboxFor } = await import("../agent/lib/workspace-mailbox.ts").catch(() => ({
  mailboxFor: async () => ({ mailbox: undefined, reason: "agent/lib/workspace-mailbox.ts does not exist" }),
}));
const { runEmailIntake } = await import("../agent/lib/email-intake.ts");
const { listInbox } = await import("../agent/lib/email.ts");

/**
 * A stand-in for the DEPLOYMENT's mail server: it only counts who connects (and hangs up). Any connection from a
 * workspace the deployment mailbox is not bound to is a read of mail that is not that workspace's.
 */
const net = await import("node:net");
let connections = 0;
const imap = net.createServer((socket) => {
  connections++;
  socket.end("* BYE not a real server\r\n");
});
await new Promise((resolve) => imap.listen(0, "127.0.0.1", resolve));
const deploymentMailbox = { IMAP_HOST: "127.0.0.1", IMAP_PORT: String(imap.address().port), IMAP_SECURE: "false", IMAP_USER: "inbox@deploy.example", IMAP_PASSWORD: "deploy-password" };
const { closeDb } = await import("../agent/lib/db/index.ts");

/** Seal a secret exactly as the web app stores it (the Ops Center's connector_secret_set). */
const { encryptSecret } = await import("../lib/secret-crypto.ts");
const seal = (plaintext, orgId) => encryptSecret(plaintext, orgId);

try {
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Mailbox A', 'active'), (${B}, 'Mailbox B', 'active')`;
  const [conn] = await admin`insert into connectors (org_id, name, kind, status, enabled, created_by) values (${A}, 'A mail', 'gmail', 'connected', true, 'test') returning id`;
  for (const [name, value] of [["IMAP_HOST", "imap.a.example"], ["IMAP_USER", "ops@a.example"], ["IMAP_PASSWORD", "a-app-password"]]) {
    const s = seal(value, A);
    await admin`insert into connector_secrets (org_id, connector_id, name, ciphertext, iv, tag, key_version, updated_by)
                values (${A}, ${conn.id}, ${name}, ${s.ciphertext}, ${s.iv}, ${s.tag}, ${s.keyVersion}, 'test')`;
  }

  console.log("\n1. A workspace reads its OWN mailbox, from its own connector");
  const a = await mailboxFor(A);
  check("workspace A's mailbox is its gmail connector (decrypted in A's scope)", a.mailbox?.source === "connector" && a.mailbox?.user === "ops@a.example", a);
  const b = await mailboxFor(B);
  check("workspace B, with no connector and no deployment mailbox, has none", b.mailbox === null, b);

  console.log("\n2. The deployment's mailbox (IMAP_*) is ONE workspace's, and only when IMAP_WORKSPACE says so");
  Object.assign(process.env, deploymentMailbox);
  const unbound = await mailboxFor(B);
  check("unbound, no workspace reads it (B has none)", unbound.mailbox === null && /IMAP_WORKSPACE/.test(unbound.reason), unbound);
  process.env.IMAP_WORKSPACE = A;
  const notB = await mailboxFor(B);
  check("bound to A, B still does not read it", notB.mailbox === null, notB);
  check("…and A keeps its own connector first", (await mailboxFor(A)).mailbox?.source === "connector");
  process.env.IMAP_WORKSPACE = B;
  const nowB = await mailboxFor(B);
  check("bound to B, B reads it", nowB.mailbox?.source === "deployment" && nowB.mailbox?.user === "inbox@deploy.example", nowB);
  check("…and A still reads only its own", (await mailboxFor(A)).mailbox?.user === "ops@a.example");
  delete process.env.IMAP_WORKSPACE;

  console.log("\n3. Intake and the inbox tools never open a mailbox the workspace does not own");
  Object.assign(process.env, deploymentMailbox);
  delete process.env.IMAP_WORKSPACE;
  const before = connections;
  const none = await runEmailIntake({ orgId: B }).catch((e) => ({ threw: String(e?.message ?? e) }));
  check("intake in workspace B never connects to the deployment's mailbox", connections === before, { connections: connections - before, none });
  check("…reads nothing, and says why", none.read === 0 && Boolean(none.note), none);
  const noOrg = await runEmailIntake({}).catch((e) => ({ threw: String(e?.message ?? e) }));
  check("intake with no workspace never connects, and reads nothing", connections === before && noOrg.read === 0 && /No workspace/.test(noOrg.note ?? ""), noOrg);
  const listed = await listInbox({ max: 1 }, B).then(() => "listed", (e) => e?.name ?? String(e));
  check("list_inbox in workspace B never connects to the deployment's mailbox", connections === before && listed === "EmailNotConfiguredError", { connections: connections - before, listed });
  process.env.IMAP_WORKSPACE = B;
  await runEmailIntake({ orgId: B }).catch(() => undefined);
  check("…and once IMAP_WORKSPACE binds it to B, B's intake does read it (the stand-in saw B connect)", connections === before + 1, connections - before);
  await runEmailIntake({ orgId: A }).catch(() => undefined);
  check("…while A, with its own connector, never touches it", connections === before + 1, connections - before);
  delete process.env.IMAP_WORKSPACE;

  console.log("\n4. Wiring: no mail path reads the deployment mailbox directly");
  const decomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["agent/lib/email-intake.ts", "agent/lib/email.ts"]) {
    const src = decomment(readFileSync(f, "utf8"));
    check(`${f} reads no IMAP_* environment itself (only through workspace-mailbox)`, !/process\.env\.IMAP_/.test(src) && /mailboxFor\(/.test(src));
  }
  const tools = readFileSync("agent/lib/tools.ts", "utf8");
  check("list_inbox, draft_email and run_email_intake name the caller's workspace", /listInbox\([^;]*orgForSession\(ctx\)\)/.test(tools) && /createDraft\(input, await orgForSession\(ctx\)\)/.test(tools) && /runEmailIntake\(\{[^}]*orgId: await orgForSession\(ctx\)/.test(tools));
} finally {
  await admin`delete from connector_secrets where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from connectors where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
  await admin.end();
  await closeDb?.();
  imap.close();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
