/**
 * Close the row-level-security coverage gap the mold's own bootstrap leaves behind.
 *
 * `.bootstrap-supabase.mjs` policies a HARDCODED 13-name list plus connector_secrets, and
 * `.migrate-task-workflow-service.mjs` adds three more. The schema carries `org_id` on 52 tables, so a
 * database that passes the bootstrap's own verification ("app_rw BYPASSRLS: false / policies: 14 /
 * READY") still lets an app_rw connection scoped to org A read org B's rows out of the other 37 —
 * including browser_credentials, chat_threads and dataroom_file_versions. A hardcoded list is also
 * how the gap appeared in the first place, and `ALTER DEFAULT PRIVILEGES ... TO app_rw` means every
 * table a future migration adds inherits the DML grant with no policy at all.
 *
 * HARD RULE 1 forbids editing the snapshot, so the fix is this factory-side pass, run by provision.py
 * and clone.py immediately AFTER the mold's bootstrap and AFTER the task-workflow migration, on both
 * the managed and the self_hosted backend. It derives the table set from the CATALOG (pg_attribute),
 * never from a name list, so it covers tables that do not exist yet the next time it runs.
 *
 * A POLICY IS JUDGED BY WHAT IT SAYS, NEVER BY THE FACT THAT IT EXISTS. Postgres OR's PERMISSIVE
 * policies, so one extra `USING (true)` beside a perfect `org_isolation` reopens the whole table:
 * measured, `CREATE POLICY svc_all ON browser_credentials USING (true)` let app_rw scoped to org A
 * read org B's row while an existence test still reported "52/52 protected, unprotected []". The same
 * hole appears when the table's ONLY policy is wide open under some other name — an earlier version of
 * this pass filed exactly that under a field it called `kept_stricter` without ever reading the qual.
 * So every permissive policy that applies to the app role is classified:
 *
 *   scoped   its qual AND its with_check both name org_id and current_setting('app.org_id') — the
 *            only shape that can restrict a row to a workspace. The mold's own variants all qualify:
 *            `org_isolation`, `org_isolation_strict`, the NULLIF/coalesce permissive form, and the
 *            connector-scope predicate that ANDs `app.principal_email` on top.
 *   open     anything else, `USING (true)` included. It is reported in `open_policies`, its table is
 *            reported UNPROTECTED, and the pass exits 1 naming the DROP that would fix it. This pass
 *            will not drop a policy the application may depend on — the mold ships one deliberate
 *            `USING (true)` (login_codes_service) — but it will never certify one either.
 *   other    it does not apply to the app role (`TO some_other_role`), so it cannot open anything for
 *            the app. Listed in `other_role_policies` so the drift is still visible, never counted.
 *
 * RESTRICTIVE policies are ignored on purpose: they AND, so they can only narrow access.
 *
 * WHAT IT APPLIES, per public base table carrying an org_id column:
 *   ENABLE ROW LEVEL SECURITY   — without it a policy is inert
 *   FORCE  ROW LEVEL SECURITY   — without it the table OWNER bypasses the policy (measured: a
 *                                 NOSUPERUSER NOBYPASSRLS owner read a foreign row through an
 *                                 enabled-but-unforced policy)
 *   POLICY org_isolation        — the mold's own predicate, in one of two shapes, created when the
 *                                 table has no scoped policy at all and repaired when `org_isolation`
 *                                 itself has drifted off it:
 *
 *   fail_closed  (org_id = current_setting('app.org_id', true))
 *   on           (coalesce(current_setting('app.org_id', true), '') = '' OR org_id = current_setting(...))
 *
 * `coalesce(..., '') = ''`, not `IS NULL`: a transaction pooler resets a transaction-local set_config
 * to the EMPTY STRING rather than to unset, and `IS NULL` is false for '' — the mold documents that
 * exact distinction as the cause of a past outage (.migrate-rls-fail-closed.mjs).
 *
 * THE CONTROL PLANE keeps the permissive shape even in fail_closed mode. `orgs`, `org_members` and
 * `org_invites` are read BEFORE any workspace is known — sign-in, "which workspaces am I in", claiming
 * an invite, and acrossOrgsRls()'s sweep enumerating workspaces (lib/ops-db.ts:104-105,
 * scripts/check-tenancy.mjs CONTROL_PLANE). Failing those closed would not harden the app, it would
 * lock everyone out, and HARD RULE 1 forbids converting the routes. They are still ENABLEd, FORCEd and
 * policied, so once a workspace IS in scope they are scoped like everything else; the exemption is
 * only about the no-context case, and it is printed on every run rather than hidden in a list.
 *
 * WHAT IT NEVER REWRITES: a scoped policy under another name (`org_isolation_strict`, which denies on
 * an unset GUC), or an `org_isolation` that ANDs `app.principal_email` for account-level connector
 * credentials. Both are stricter than what this pass would write and permissive policies OR, so
 * replacing either would WEAKEN the database. They are reported in `kept_strict` — and, unlike the
 * bucket that name replaces, only after their predicate has actually been READ AND RUN.
 *
 * READING A PREDICATE IS STILL NOT PROOF. `USING ((org_id = current_setting('app.org_id', true)) OR
 * true)` names org_id, names the GUC, passes every text rule above, and hands over the whole table:
 * measured on `tickets`, where this pass called it `kept_strict` and exited 0 while app_rw scoped to
 * one workspace read another's row. So after the DDL, every permissive policy is EXECUTED — singly,
 * against rows built for the purpose, on a temp copy of its table's columns, under SET LOCAL ROLE of
 * the app role, inside a transaction that is rolled back (lib/rls-policy.mjs). A policy that admits a
 * foreign row is reported in `leaking_policies` and the pass exits 1, whatever its name.
 *
 * ADMIN_URL travels in the environment, never in argv: /proc/<pid>/cmdline is world-readable.
 * Prints one JSON line; no secret in it.
 *   exit 0  every org-scoped table is enabled, forced, scoped, and carries no open policy
 *   exit 1  it ran and the database is not covered (the operator is told which tables)
 *   exit 2  it was pointed at the wrong role — nothing was measured
 *   exit 3  it could not run at all (unreachable, refused, bad credentials) — nothing was measured
 */
import postgres from "postgres";
import { measurePolicies, isScoped, exprs, why, cap, q } from "./rls-policy.mjs";

const url = process.env.ADMIN_URL;
if (!url) { console.error("ADMIN_URL is not set"); process.exit(2); }
const mode = process.env.RLS_MODE || "fail_closed";
if (!["fail_closed", "on"].includes(mode)) { console.error(`RLS_MODE=${mode} is not fail_closed or on`); process.exit(2); }
const APP_ROLE = process.env.APP_ROLE || "app_rw";

// Read unscoped before a workspace exists; see the header.
const CONTROL_PLANE = new Set(["orgs", "org_members", "org_invites"]);
const STRICT = `(org_id = current_setting('app.org_id', true))`;
const OPEN = `(coalesce(current_setting('app.org_id', true), '') = '' OR org_id = current_setting('app.org_id', true))`;
const norm = (x) => String(x).toLowerCase().replace(/::[a-z ]+/g, "").replace(/[\s()]/g, "");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 20, onnotice: () => {} });
try {
  const [who] = await sql`SELECT current_user AS u,
    (SELECT bool_or(pg_has_role(current_user, c.relowner, 'USAGE')) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind='r') AS owns`;
  if (who.owns === false) {
    console.error(`connected as ${who.u}, which owns no table in public — every ALTER would fail with "must be owner of table". ` +
      "This needs the admin URL (the one that ran the migrations), not DATABASE_URL: after the bootstrap that is app_rw, which owns nothing.");
    process.exit(2);
  }
  // The table set comes from the catalog, not from a list. pg_attribute rather than
  // information_schema.columns: the latter hides columns the connected role has no privilege on.
  // Both of these are re-run after the DDL, so they must be functions: a postgres.js query object
  // executes once and then just resolves to its cached rows.
  const TABLES = () => sql`
    SELECT c.relname AS t, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
    ORDER BY c.relname`;
  // `applies`: a policy listed TO another role cannot open anything for the app role. Resolved through
  // pg_has_role so a policy granted to a group the app role is a member of still counts.
  const POLICIES = () => sql`
    SELECT tablename AS t, policyname AS p, permissive, cmd, coalesce(qual, '') AS qual,
      coalesce(with_check, '') AS with_check,
      EXISTS (SELECT 1 FROM unnest(roles) r
              WHERE CASE WHEN r = 'public' THEN true
                         WHEN EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = r)
                           THEN pg_has_role(${APP_ROLE}, r, 'USAGE') ELSE false END) AS applies
    FROM pg_policies WHERE schemaname = 'public'`;
  const group = (rows) => {
    const by = new Map();
    for (const p of rows) { if (!by.has(p.t)) by.set(p.t, []); by.get(p.t).push(p); }
    return by;
  };

  const tables = await TABLES();
  let by = group(await POLICIES());
  const changed = [], kept = [], cp = [], other = [];
  for (const { t, enabled, forced } of tables) {
    const pred = mode === "fail_closed" && !CONTROL_PLANE.has(t) ? STRICT : OPEN;
    if (CONTROL_PLANE.has(t)) cp.push(t);
    const did = [];
    if (!enabled) { await sql.unsafe(`ALTER TABLE ${q(t)} ENABLE ROW LEVEL SECURITY`); did.push("enable"); }
    if (!forced) { await sql.unsafe(`ALTER TABLE ${q(t)} FORCE ROW LEVEL SECURITY`); did.push("force"); }
    const mine = (by.get(t) || []).filter((p) => p.permissive === "PERMISSIVE");
    for (const p of mine) if (!p.applies) other.push(`${t}:${p.p}`);
    const live = mine.filter((p) => p.applies);
    const own = live.find((p) => p.p === "org_isolation");
    // Repair org_isolation FIRST: an org_isolation that has drifted to `USING (true)` is drift this
    // pass owns, and repairing it may be all that stands between the table and an open policy.
    // principal_email is the one shape it must not touch — that policy is stricter than `pred`.
    if (own && !exprs(own).some((e) => /principal_email/i.test(e))) {
      // Postgres re-renders a policy expression when it stores it — casts made explicit, parentheses
      // added — so a literal string comparison never matches and the pass would re-ALTER all 52 tables
      // on every run. Compare a canonical form instead, so `changed` means real drift.
      if (exprs(own).length !== 2 || exprs(own).some((e) => norm(e) !== norm(pred))) {
        await sql.unsafe(`ALTER POLICY org_isolation ON ${q(t)} USING ${pred} WITH CHECK ${pred}`);
        did.push("predicate");
        own.qual = own.with_check = pred;
      }
    }
    // A table with policies but not one of them scoped (all wide open, or all under other names and
    // open) still needs the scoped one; creating it does not close the open ones, and the report below
    // is what refuses the database.
    if (!live.some(isScoped)) {
      await sql.unsafe(`CREATE POLICY org_isolation ON ${q(t)} USING ${pred} WITH CHECK ${pred}`); did.push("policy");
    } else if (!did.includes("predicate")) {
      const strict = live.filter((p) => isScoped(p) && p.p !== "org_isolation");
      if (strict.length) kept.push(`${t}:${strict.map((p) => p.p).join("+")}`);
    }
    if (did.length) changed.push(`${t}(${did.join("+")})`);
  }

  // Re-read the catalog: report what IS, not what was intended.
  const after = await TABLES();
  by = group(await POLICIES());
  const open_policies = [], unprotected = [];
  for (const r of after) {
    const live = (by.get(r.t) || []).filter((p) => p.permissive === "PERMISSIVE" && p.applies);
    const bad = live.filter((p) => !isScoped(p));
    for (const p of bad) open_policies.push(`${r.t}:${p.p}`);
    if (!(r.enabled && r.forced && live.some(isScoped)) || bad.length) unprotected.push(r.t);
  }
  // Now RUN them. `kept_strict` used to be a name this pass gave a predicate it had only read; a
  // policy that ORs `true` onto a scoped comparison reads as strict and is not. Measured as the app
  // role (SET LOCAL ROLE — the admin this pass connects as is typically a superuser, and a superuser
  // bypasses every policy, which would report a leak on a perfect database).
  const applying = new Map();
  for (const r of after) applying.set(r.t, (by.get(r.t) || []).filter((p) => p.permissive === "PERMISSIVE" && p.applies));
  // Measuring through a role that bypasses RLS would report a leak on every table and blame the
  // policies for what the ROLE does. Say the real thing instead — and it is not something this pass
  // can repair: the role attribute belongs to the bootstrap, and the gate refuses the URL anyway.
  const [ar] = await sql`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  if (!ar) { console.error(`there is no ${APP_ROLE} role on this database — the bootstrap has not run here yet.`); process.exit(2); }
  if (ar.s || ar.b) {
    console.error(`${APP_ROLE} is ${ar.s ? "SUPERUSER" : ""}${ar.s && ar.b ? " and " : ""}${ar.b ? "BYPASSRLS" : ""}: ` +
      `every policy is silently ignored for it, so no amount of coverage means anything. Run ` +
      `ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS as the admin, then rerun.`);
    process.exit(1);
  }
  const beh = await measurePolicies(sql, { tables: after, policies: applying, mode, control: CONTROL_PLANE,
                                           assume: who.u === APP_ROLE ? null : APP_ROLE });
  for (const l of beh.leaking) { const t = l.split(":")[0]; if (!unprotected.includes(t)) unprotected.push(t); }
  // Cap the lists: the counts are the evidence, the names are there to point at. A 52-table run
  // otherwise prints four screens of JSON into a log the operator has to read.
  console.log(JSON.stringify({ mode, tables_org_scoped: after.length, protected: after.length - unprotected.length,
    unprotected: cap(unprotected), open_policies: cap(open_policies), leaking_policies: cap(beh.leaking),
    policies_executed: beh.checked, policies_unverified: cap(beh.unverified), changed: cap(changed),
    control_plane: [...cp], kept_strict: cap(kept), other_role_policies: cap(other) }));
  if (beh.leaking.length) {
    const [t0, rest] = [beh.leaking[0].split(":")[0], beh.leaking[0].split(":").slice(1).join(":")];
    console.error(`${beh.leaking.length} permissive policy/policies were EXECUTED as ${APP_ROLE} and handed over another ` +
      `workspace's rows, whatever their name says: ${beh.leaking.slice(0, 6).join(", ")}${beh.leaking.length > 6 ? " …" : ""}. ` +
      `This pass will not drop a policy the application may depend on. Rewrite each to confine rows to ` +
      `current_setting('app.org_id'), or drop it (DROP POLICY "${rest.replace(/\(.*$/, "")}" ON "${t0}"), then rerun.`);
    process.exit(1);
  }
  if (beh.unverified.length) {
    console.error(`${beh.unverified.length} policy/policies could not be executed, so nothing measured what they actually ` +
      `do: ${beh.unverified.slice(0, 4).join(", ")}. ${APP_ROLE} needs TEMP on this database and the admin role needs to be ` +
      `a member of it (GRANT ${APP_ROLE} TO current_user), then rerun.`);
    process.exit(1);
  }
  if (open_policies.length) {
    console.error(`${open_policies.length} policy/policies on org-scoped table(s) do not scope by org_id, and Postgres OR's ` +
      `permissive policies, so each one reopens its whole table: ${open_policies.slice(0, 8).join(", ")}` +
      `${open_policies.length > 8 ? " …" : ""}. This pass will not drop a policy the application may depend on. ` +
      `Rewrite each to name org_id and current_setting('app.org_id'), or drop it ` +
      `(DROP POLICY "${open_policies[0].split(":").slice(1).join(":")}" ON "${open_policies[0].split(":")[0]}"), then rerun.`);
    process.exit(1);
  }
  if (unprotected.length) {
    console.error(`${unprotected.length} org-scoped table(s) still lack ENABLE+FORCE+a policy that scopes by org_id: ${unprotected.slice(0, 12).join(", ")}`);
    process.exit(1);
  }
} catch (e) {
  console.error("row-level security coverage could not be measured — " + why(e));
  process.exit(3);
} finally { await sql.end({ timeout: 5 }).catch(() => {}); }
