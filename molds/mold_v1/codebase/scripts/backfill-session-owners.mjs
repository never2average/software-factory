/**
 * ONE-TIME (re-runnable): record an owner for every agent session from before owners were recorded (#66).
 *
 * The session gate reads ONE workspace per request now (lib/session-gate.ts): a legacy session is inferred on a
 * request only when the request's own workspace holds the agent's scope row or a workflow / app / cron step for it.
 * The rest — the oldest chats, known only from chat-list rows — used to be decided on every request by reading EVERY
 * workspace. This decides them once, as a system job, with that same cross-workspace rule
 * (agent/lib/session-owner-backfill.ts), and writes owner records; from then on the record decides, in its workspace.
 *
 * Insert-only: a session that already has a record is never touched. Dry run unless --apply. Run it after the deploy
 * that ships the one-workspace gate, and BEFORE scripts/backfill-session-lineage.mjs (whose replay relies on its
 * parents having owners).
 *
 * Runs only as the application role (app_rw): it refuses a superuser or BYPASSRLS URL.
 *
 *   DATABASE_URL=…app_rw… node scripts/backfill-session-owners.mjs     # dry run: counts and a sample
 *   DATABASE_URL=… node scripts/backfill-session-owners.mjs --apply
 *
 * Secrets are read from the environment by name and never printed.
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../agent/lib/db/index.ts";
import { agentSystemGateDb, backfillLegacyOwners } from "../agent/lib/session-owner-backfill.ts";

const apply = process.argv.includes("--apply");
const db = agentSystemGateDb();
if (!db) {
  console.error("backfill-session-owners: DATABASE_URL is not set.");
  process.exit(2);
}
try {
  // ONLY as the application role (app_rw): the evidence is read one workspace at a time, each inside its own
  // row-level-security scope, and that is what makes it per-workspace. A superuser or BYPASSRLS role sees every
  // workspace's rows in every scope, and would decide one workspace's sessions on another's rows.
  const [role] = await getDb().execute(
    sql`select current_user as who, rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user`,
  );
  if (!role || role.super || role.bypass) {
    console.error(
      `backfill-session-owners: refusing to run as ${role?.who ?? "an unknown role"}, which ${role?.super ? "is a superuser" : "bypasses row-level security"}. ` +
        "Use the application role's URL (app_rw), whose reads stay inside each workspace's scope.",
    );
    process.exitCode = 2;
  } else {
    const result = await backfillLegacyOwners(db, { apply });
    console.log(
      `backfill-session-owners: ${result.candidates} legacy session(s) without an owner record — ` +
        `${result.recorded} ${apply ? "recorded" : "would be recorded"}, ${result.unresolved} left unowned (conflicting or no owner evidence).`,
    );
    for (const s of result.sample) console.log(`  ${s.orgId}  ${s.sessionId}  ${s.ownerEmail ?? "(workspace step)"}  ${s.visibility}`);
    if (!apply) console.log("backfill-session-owners: dry run — re-run with --apply to write the records.");
  }
} finally {
  await closeDb?.();
}
