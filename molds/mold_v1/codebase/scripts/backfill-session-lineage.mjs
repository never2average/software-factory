/**
 * ONE-TIME, IDEMPOTENT: give every subagent child delegated before #66 its parent's owner (mold_v1-133).
 *
 * A child session announced on its parent's stream before the agent recorded lineage has no row in
 * agent_session_owners, so the session guard refuses it to everyone — its own owner included (404 on the child's
 * stream in the Control Panel) — until someone replays the parent from index 0 through the guard.
 *
 * This does exactly that replay, for every owned root, as its OWNER: a two-minute, read-only token bound to that one
 * session (the queue-delivery kind, lib/auth-session.ts mintQueueDeliveryToken, act "read"), sent to the agent's own
 * `GET /eve/v1/session/:id/stream?startIndex=0`. The guard admits it only for that session and only for its recorded
 * (or unambiguous legacy) owner, and records each `subagent.called` child's owner as the line passes
 * (agent/lib/session-lineage-stream.ts) — so nothing here writes an owner itself, and no child can go to anyone who
 * could not already read its parent. Re-running writes nothing new (`ON CONFLICT DO NOTHING`).
 *
 * The factory runs it once after deploying the agent that carries the lazy path (agent/lib/session-guard.ts
 * recordSkippedLineage), which covers any gap this leaves.
 *
 *   DATABASE_URL=…  AUTH_JWT_PRIVATE_KEY=…  NEXT_PUBLIC_EVE_API_URL=https://<agent>  npm run db:backfill:session-lineage
 *   … -- --dry-run            list what would be replayed, touch nothing
 *   … -- --org <orgId>        one workspace only (repeatable)
 *   … -- --concurrency <n>    parents replayed at once (default 4)
 *
 * Secrets are read from the environment by name and never printed.
 */
import { agentSystemGateDb } from "../agent/lib/session-owner-backfill.ts";
import { closeDb } from "../agent/lib/db/index.ts";
import { backfillLineage, listLineageParents } from "../agent/lib/session-lineage-backfill.ts";
import { mintQueueDeliveryToken } from "../lib/auth-session.ts";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const values = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const dryRun = flag("--dry-run");
const orgs = values("--org");
const concurrency = Number(values("--concurrency")[0] ?? 4) || 4;
const agentUrl = (process.env.NEXT_PUBLIC_EVE_API_URL ?? process.env.AGENT_URL ?? "").replace(/\/$/, "");

function fail(message) {
  console.error(`backfill-session-lineage: ${message}`);
  process.exit(2);
}

const db = agentSystemGateDb();
if (!db) fail("DATABASE_URL is not set.");
if (!dryRun && !agentUrl) fail("NEXT_PUBLIC_EVE_API_URL (the agent's URL) is not set.");
if (!dryRun && !process.env.AUTH_JWT_PRIVATE_KEY) fail("AUTH_JWT_PRIVATE_KEY is not set (needed to sign the owner's read token).");

try {
  const parents = await listLineageParents(db, orgs.length ? orgs : undefined);
  console.log(`backfill-session-lineage: ${parents.length} owned session(s) to replay${dryRun ? " (dry run)" : ""}`);
  if (dryRun) {
    for (const p of parents) console.log(`  ${p.orgId}  ${p.sessionId}`);
  } else {
    const outcome = await backfillLineage(
      parents,
      async (parent) => {
        const token = await mintQueueDeliveryToken(parent.ownerEmail, {
          org: parent.orgId,
          sessionId: parent.sessionId,
          scope: { act: "read" },
        });
        const res = await fetch(`${agentUrl}/eve/v1/session/${encodeURIComponent(parent.sessionId)}/stream?startIndex=0`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return { status: res.status, body: res.body };
      },
      { concurrency, log: (line) => console.log(`  ${line}`) },
    );
    console.log(`backfill-session-lineage: ${JSON.stringify(outcome)}`);
    if (outcome.failed) process.exitCode = 1;
  }
} finally {
  await closeDb().catch(() => undefined);
}
