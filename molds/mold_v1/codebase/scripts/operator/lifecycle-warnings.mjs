// operator:lifecycle-warnings — READ-ONLY: the lifecycle rules a deployment let through under enforce "warn", so the
// operator can decide whether it may go to "strict" (agent/lib/lifecycle-warnings.ts says what is read and how).
//
//   npm run operator:lifecycle-warnings -- --since 2026-10-21                 # every workspace, as text
//   npm run operator:lifecycle-warnings -- --since 2026-10-21 --json          # one JSON object
//   npm run operator:lifecycle-warnings -- --since 2026-10-21T05:56:00Z --until 2026-10-28 --org <workspace id>
//
// Per workspace: the warned moves counted by rule, by area and by actor, each one listed (time, workspace, record,
// from → to, rule, actor, comment), and the number of lifecycle moves in the same window, so the share that warned is
// plain. It writes nothing: the workspace list and every workspace's reads each run in a transaction set READ ONLY
// before its first statement, so a write would fail instead. Like the read-only audits (scripts/audit-session-owners.mjs)
// it runs only as the application role (app_rw): each workspace is read inside its own row-level-security scope
// (withOrgDb), and a role that bypasses row-level security is refused.
//
// Exit 0 once it has reported (warned moves or none: provision.py --operator reads any other code as a failure), 2 when
// it could not run. The database address is read from DATABASE_URL by name and never printed.
import { sql } from "drizzle-orm";
import { closeDb, getDb, withOrgDb } from "../../agent/lib/db/index.ts";
import { formatLifecycleWarnings, lifecycleWarnings, parseLifecycleWarningsArgs } from "../../agent/lib/lifecycle-warnings.ts";

const NAME = "operator:lifecycle-warnings";
const args = parseLifecycleWarningsArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${NAME}: ${args.error}`);
  process.exit(2);
}
const db = getDb();
if (!db) {
  console.error(`${NAME}: DATABASE_URL is not set.`);
  process.exit(2);
}
const rowsOf = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));

/** A read-only transaction on the bare handle (the control plane only: the role check and the workspace list). */
const readOnly = (fn) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return fn(tx);
  });

try {
  const [role] = rowsOf(
    await readOnly((tx) => tx.execute(sql`select current_user as who, rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user`)),
  );
  if (!role || role.super || role.bypass) {
    console.error(
      `${NAME}: refusing to run as ${role?.who ?? "an unknown role"}, which ${role?.super ? "is a superuser" : "bypasses row-level security"}. ` +
        "Use the application role's URL (app_rw), whose reads stay inside each workspace's scope.",
    );
    process.exitCode = 2;
  } else {
    const gate = {
      listOrgs: () => readOnly(async (tx) => rowsOf(await tx.execute(sql`select org_id from orgs order by org_id`)).map((r) => String(r.org_id))),
      inOrg: (orgId, fn) => withOrgDb(orgId, fn),
    };
    const report = await lifecycleWarnings(gate, { since: args.since, until: args.until, orgs: args.orgs });
    const missing = args.orgs.filter((o) => !report.orgs.some((r) => r.orgId === o));
    if (missing.length) console.error(`${NAME}: no workspace ${missing.join(", ")} in this database.`);
    console.log(args.json ? JSON.stringify(report, null, 2) : formatLifecycleWarnings(report));
    process.exitCode = missing.length ? 2 : 0;
  }
} catch (e) {
  console.error(`${NAME}: could not run (${e instanceof Error ? e.message : String(e)}).`);
  process.exitCode = 2;
} finally {
  await closeDb?.();
}
