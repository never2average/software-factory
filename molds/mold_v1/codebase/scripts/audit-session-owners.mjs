/**
 * READ-ONLY: list session owner records that disagree with the server's own evidence (mold_v1-293).
 *
 * Looks for past abuse of the hole mold_v1-293 closed: a member could file a shared thread naming themselves on any
 * session id, and the agent's guard then froze them in as the owner of a legacy session. See
 * agent/lib/session-owner-audit.ts for exactly what is listed and why. It writes nothing (every transaction is
 * read-only), has no --apply, and changes no record: what to do about a finding is a person's decision.
 *
 * Runs only as the application role (app_rw), like scripts/backfill-session-owners.mjs: each workspace is read inside
 * its own row-level-security scope.
 *
 *   DATABASE_URL=…app_rw… node --experimental-strip-types scripts/audit-session-owners.mjs          # a summary
 *   DATABASE_URL=…app_rw… node --experimental-strip-types scripts/audit-session-owners.mjs --json   # one JSON object
 *
 * Exit 0 with nothing found, 1 with findings, 2 when it could not run. Secrets are read from the environment by name
 * and never printed.
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../agent/lib/db/index.ts";
import { agentSystemGateDb } from "../agent/lib/session-owner-backfill.ts";
import { auditSessionOwners } from "../agent/lib/session-owner-audit.ts";

const json = process.argv.includes("--json");
const db = agentSystemGateDb();
if (!db) {
  console.error("audit-session-owners: DATABASE_URL is not set.");
  process.exit(2);
}
try {
  const [role] = await getDb().execute(
    sql`select current_user as who, rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user`,
  );
  if (!role || role.super || role.bypass) {
    console.error(
      `audit-session-owners: refusing to run as ${role?.who ?? "an unknown role"}, which ${role?.super ? "is a superuser" : "bypasses row-level security"}. ` +
        "Use the application role's URL (app_rw), whose reads stay inside each workspace's scope.",
    );
    process.exitCode = 2;
  } else {
    const findings = await auditSessionOwners(db);
    const counts = { disagrees: 0, "thread-first": 0, "unrecorded-claims": 0 };
    for (const f of findings) counts[f.kind] += 1;
    if (json) {
      console.log(JSON.stringify({ counts, findings }, null, 2));
    } else {
      console.log(
        `audit-session-owners: ${counts.disagrees} record(s) whose owner is not the scope row's person, ` +
          `${counts["thread-first"]} with no scope person and the owner's own thread first, ` +
          `${counts["unrecorded-claims"]} unrecorded session(s) claimed by someone the scope row does not name.`,
      );
      for (const f of findings) {
        console.log(
          `  ${f.kind.padEnd(17)} ${f.orgId}  ${f.sessionId}  recorded=${f.recordedOwner ?? "-"}  scope=${f.scopePrincipal ?? "-"}` +
            `  threads=[${f.threadOwners.join(",")}]  chats=[${f.claimants.join(",")}]${f.recordedAt ? `  at=${f.recordedAt}` : ""}`,
        );
      }
      console.log("audit-session-owners: read-only — nothing was changed.");
    }
    process.exitCode = findings.length ? 1 : 0;
  }
} catch (e) {
  console.error(`audit-session-owners: could not run (${e instanceof Error ? e.message : String(e)}).`);
  process.exitCode = 2;
} finally {
  await closeDb?.();
}
