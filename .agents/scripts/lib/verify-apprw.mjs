/**
 * PROVE tenant isolation on the exact string that is about to become DATABASE_URL — do not assert it.
 *
 * `datastores.postgres.rls: "fail_closed"` used to be a string literal nothing ever tested, while the
 * deployed app reported `role postgres — WARNING: BYPASSRLS, row-level security is NOT enforced`. The
 * first version of this file checked the role, the wire and `count(pg_policies) > 0`; measured against
 * a database where app_rw was perfect and 37 of 52 org-scoped tables had no policy at all, it printed
 * `policies: 14` and passed. A gate that certifies the broken state is worse than no gate, so this one
 * ends by trying to read another workspace's row and failing.
 *
 *   C1 role      current_user is the app role, rolsuper = false AND rolbypassrls = false.
 *                Both, not just bypassrls: a SUPERUSER NOBYPASSRLS role ignores every policy too, and
 *                the app's own health endpoint (app/api/ops/health/route.ts:83) selects only
 *                rolbypassrls — it would print "(RLS enforced)" for it. This check is deliberately
 *                stronger than the app's.
 *   C2 wire      sslmode=require|verify-full in the URL (the runtime clients pass no ssl option, so
 *                the query parameter is the only thing that turns TLS on) and either Postgres itself
 *                terminated TLS or the server REFUSES a plaintext connection. Neon terminates TLS at
 *                its proxy, so pg_stat_ssl.ssl reads false on a fully encrypted connection.
 *   C3 pooling   a transaction-local set_config('app.org_id', …, true) survives a round trip — this is
 *                what makes RLS hold through Supavisor:6543 and Neon's pooled endpoint.
 *   C4 coverage  EVERY public base table carrying an org_id column has relrowsecurity AND
 *                relforcerowsecurity AND at least one PERMISSIVE policy that applies to this role and
 *                actually SCOPES BY org_id — and NOT ONE permissive policy that does not. Existence is
 *                not coverage: Postgres OR's permissive policies, so a single extra `USING (true)`
 *                beside a perfect org_isolation reopens the table, and a `count(*) > 0` test reads that
 *                database as 52/52 protected (measured on browser_credentials, and again on a table
 *                whose only policy was open under another name). The table set is derived from
 *                pg_attribute, never from a name list — a literal list here would re-import the very
 *                failure mode that left 37 tables open. FORCE is load-bearing: a table's owner bypasses
 *                a merely-ENABLED policy. RESTRICTIVE policies are ignored: they AND, so they can only
 *                narrow. A policy granted TO another role is reported, not counted — it cannot open
 *                anything for this connection.
 *   C5 read      scoped to workspace A, a row belonging to workspace B is invisible — and the same row
 *                IS visible scoped to B, so the check can never pass vacuously on an empty table.
 *   C6 write     scoped to A, inserting a row owned by a THIRD, never-used workspace raises SQLSTATE
 *                42501. Asserting "the insert failed" instead scores a duplicate-key error as a pass;
 *                asserting the SQLSTATE makes RLS the only possible rejection.
 *   C7 unset     fail_closed only: with app.org_id set to the EMPTY STRING (what a transaction pooler
 *                leaves behind, not NULL), the table returns zero rows.
 *
 *   C8 behaviour every permissive policy is EXECUTED, one at a time, against rows this script owns on a
 *                temp copy of its table's columns (lib/rls-policy.mjs). Reading the predicate is not the
 *                same as running it: `USING ((org_id = current_setting('app.org_id', true)) OR true)`
 *                satisfies every text rule in C4 and still hands over another workspace's rows —
 *                measured on `tickets`, which C5-C7 skip because it carries foreign keys. C8 is what
 *                covers the tables the live probe cannot touch, and it can never be vacuous: the
 *                foreign row is one this check inserted.
 *
 * C5/C6/C7 RUN ON EVERY PROBE-ELIGIBLE TABLE, not on one. They are the only checks that read across the
 * boundary rather than reasoning about the catalog, and a single-table probe is exactly as blind as a
 * name list: with the probe on account_summaries, a planted `USING (true)` on browser_credentials was
 * invisible to this file while app_rw read the other workspace's row. 51 extra counts inside a
 * transaction that is going to be rolled back are cheap.
 *
 * All of it runs inside ONE explicit transaction that ends in ROLLBACK, each table inside its own
 * SAVEPOINT so a table whose required columns cannot be synthesised is reported (`probe_skipped`) and
 * does not abort the rest — set_config(..., true) is transaction-local, so in autocommit the workspace
 * context is gone before the next statement, and nothing this script writes survives it. Probe tables
 * are CHOSEN FROM THE CATALOG: org-scoped, RLS-enabled-and-forced, non-control-plane, no foreign keys,
 * no user triggers, only synthesisable required columns. Every synthesised text value is unique per
 * table and per row so a UNIQUE constraint can never masquerade as an RLS refusal.
 *
 * RLS_MODE mirrors datastores.postgres.rls: "fail_closed" runs C1-C7, "on" runs C1-C6 (a permissive
 * policy is allowed to show everything when no workspace is in scope), "off" runs C1-C3 and reports
 * coverage without failing on it.
 *
 * APP_RW_URL arrives in the environment, never in argv: /proc/<pid>/cmdline is world-readable.
 * Prints one JSON line with no secret in it.
 *   exit 0  tenant isolation proven
 *   exit 1  it ran and isolation is NOT proven (the JSON line says exactly what leaked)
 *   exit 2  it was not given a URL — nothing was measured
 *   exit 3  it could not run at all (unreachable, refused, bad credentials) — nothing was measured
 */
import postgres from "postgres";
import { measurePolicies, isScoped, exprs, why, cap, q } from "./rls-policy.mjs";

const url = process.env.APP_RW_URL;
if (!url) { console.error("APP_RW_URL is not set"); process.exit(2); }
const mode = process.env.RLS_MODE || "fail_closed";
const ROLE = process.env.APP_ROLE || "app_rw";
const CONTROL_PLANE = ["orgs", "org_members", "org_invites"];   // same set as rls-cover.mjs; see its header
const A = "__rls_probe_a__", B = "__rls_probe_b__", C = "__rls_probe_c__";
const ROLLBACK = "__rls_probe_rollback__";

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, onnotice: () => {} });
const out = { mode, role: null, superuser: null, bypassrls: null, sslmode: null, pg_stat_ssl: null, plaintext: "not tried",
              guc_roundtrip: null, tables_org_scoped: null, protected: null, unprotected: [], open_policies: [],
              leaking_policies: [], policies_executed: 0, policies_unverified: [],
              other_role_policies: [], probe_tables: 0, probe_table: null, probe_skipped: [], own_org_rows: 0,
              foreign_rows: 0, leaking_tables: [], cross_org_write: null, cross_org_writable: [],
              unset_org_rows: null, open_with_no_org: [], unmeasured: [] };
const bad = [], probedOk = new Set();
try {
  /* C1 + C3 -------------------------------------------------------------- */
  const [r] = await sql`SELECT current_user AS u,
    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`;
  out.role = r.u; out.superuser = r.s; out.bypassrls = r.b; out.pg_stat_ssl = r.ssl;
  const [g] = await sql.begin((t) => t`SELECT set_config('app.org_id', ${A}, true) AS org`);
  out.guc_roundtrip = g.org === A;

  /* C2 ------------------------------------------------------------------- */
  out.sslmode = new URL(url).searchParams.get("sslmode");
  if (r.ssl !== true) {                    // TLS may be terminated in front of Postgres; prove plaintext is refused
    const u = new URL(url); u.searchParams.set("sslmode", "disable");
    const bare = postgres(u.toString(), { max: 1, prepare: false, connect_timeout: 15 });
    // ONLY an SSL-required refusal counts. Scoring any error as "refused" let a transient failure —
    // a timeout, a full connection pool, a pooler hiccup — read as proof that the server encrypts.
    try { await bare`SELECT 1`; out.plaintext = "ACCEPTED"; }
    catch (e) {
      const m = String((e && e.message) || e).toLowerCase();
      out.plaintext = (e && (e.code === "28000" || e.code === "08P01")) ||
        /ssl|encryption|secure connection/.test(m) ? "refused (server requires TLS)"
        : `inconclusive: ${why(e)}`;
    }
    await bare.end({ timeout: 5 }).catch(() => {});
  }

  /* C4 — from the catalog, and by what the policies SAY -------------------- */
  const cov = await sql`
    SELECT c.relname AS t, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
      (SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f') AS fks,
      (SELECT count(*)::int FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal) AS trg
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
    ORDER BY c.relname`;
  // `applies`: a policy listed TO another role cannot open anything for THIS connection. Resolved
  // through pg_has_role, so a policy granted to a group this role belongs to still counts.
  const pols = await sql`
    SELECT tablename AS t, policyname AS p, permissive, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check,
      EXISTS (SELECT 1 FROM unnest(roles) rr
              WHERE CASE WHEN rr = 'public' THEN true
                         WHEN EXISTS (SELECT 1 FROM pg_roles gg WHERE gg.rolname = rr)
                           THEN pg_has_role(current_user, rr, 'USAGE') ELSE false END) AS applies
    FROM pg_policies WHERE schemaname = 'public'`;
  const by = new Map();
  for (const p of pols) { if (!by.has(p.t)) by.set(p.t, []); by.get(p.t).push(p); }
  out.tables_org_scoped = cov.length;
  const live = new Map();
  for (const x of cov) {
    const perm = (by.get(x.t) || []).filter((p) => p.permissive === "PERMISSIVE");
    for (const p of perm) if (!p.applies) out.other_role_policies.push(`${x.t}:${p.p}`);
    const mine = perm.filter((p) => p.applies);
    live.set(x.t, mine);
    for (const p of mine) if (!isScoped(p)) out.open_policies.push(`${x.t}:${p.p}`);
    if (!(x.enabled && x.forced && mine.some(isScoped)) || mine.some((p) => !isScoped(p))) out.unprotected.push(x.t);
  }
  out.protected = cov.length - out.unprotected.length;

  /* C8 — RUN each policy instead of reading it ---------------------------- */
  // A predicate that mentions org_id and the GUC can still hand over the whole table
  // (`... OR true`). lib/rls-policy.mjs executes every permissive policy singly against rows it owns
  // on a temp copy of the table's columns, which is also the only measurement that reaches the tables
  // C5-C7 must skip for their foreign keys and triggers.
  // Not through a role that bypasses RLS: every policy would "leak" and the report would blame the
  // policies for what the ROLE did. C1 already refuses such a URL; this keeps the reason honest.
  const canMeasure = out.superuser === false && out.bypassrls === false;
  const beh = canMeasure ? await measurePolicies(sql, { tables: cov, policies: live, mode, control: new Set(CONTROL_PLANE) })
    : { leaking: [], checked: 0, unverified: [`all:${out.role} bypasses row level security, so no policy can be measured through it`] };
  out.leaking_policies = beh.leaking; out.policies_executed = beh.checked; out.policies_unverified = beh.unverified;
  for (const l of beh.leaking) { const t = l.split(":")[0]; if (!out.unprotected.includes(t)) out.unprotected.push(t); }
  out.protected = cov.length - out.unprotected.length;

  /* C5/C6/C7 — every eligible table, one transaction, rolled back --------- */
  const LIT = { text: (v) => `'${v}'`, varchar: (v) => `'${v}'`, bpchar: (v) => `'${v}'`, citext: (v) => `'${v}'`,
    uuid: () => "gen_random_uuid()", timestamptz: () => "now()", timestamp: () => "now()", date: () => "now()::date",
    bool: () => "false", int2: () => "0", int4: () => "0", int8: () => "0", numeric: () => "0", float4: () => "0",
    float8: () => "0", json: () => `'{}'::json`, jsonb: () => `'{}'::jsonb` };
  // Eligible = RLS actually on (a table with RLS off is already reported unprotected; probing it would
  // only restate that) and nothing that makes a synthetic INSERT fail for a reason other than RLS.
  const pick = cov.filter((x) => x.enabled && x.forced && (live.get(x.t) || []).length > 0 &&
    x.fks === 0 && x.trg === 0 && !CONTROL_PLANE.includes(x.t));
  const names = pick.map((x) => x.t);
  // Say out loud which tables the cross-boundary probe could NOT reach, so `probe_tables: 40` is never
  // read as "all of them". A foreign key or a user trigger makes a synthetic INSERT fail for a reason
  // that is not RLS, and app_rw cannot set session_replication_role to get past one. Those tables are
  // covered by C4 only, and C4 now reads the predicates rather than counting them.
  for (const x of cov) {
    if (names.includes(x.t)) continue;
    const r2 = CONTROL_PLANE.includes(x.t) ? "control plane (readable with no workspace in scope, by design)"
      : !(x.enabled && x.forced) ? "RLS not enabled+forced" : x.fks ? "foreign keys" : x.trg ? "user triggers" : "no policy to probe";
    out.probe_skipped.push(`${x.t}:${r2}`);
  }
  // One query for every required column of every candidate, instead of 52 round trips. Identity and
  // generated columns are excluded: they fill themselves and an explicit value is an error.
  const cols = names.length ? await sql`
    SELECT c.relname AS t, a.attname AS name, ty.typname AS tname, ty.typtype AS tkind
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = ANY(${names}) AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attnotnull AND a.attidentity = '' AND a.attgenerated = ''
      AND NOT EXISTS (SELECT 1 FROM pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum)
    ORDER BY c.relname, a.attnum` : [];
  const enums = new Map((await sql`
    SELECT ty.typname AS n, (SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = ty.oid ORDER BY e.enumsortorder LIMIT 1) AS l
    FROM pg_type ty WHERE ty.typtype = 'e'`).map((x) => [x.n, x.l]));
  const need = new Map(names.map((n) => [n, []]));
  for (const c2 of cols) if (c2.name !== "org_id") need.get(c2.t).push(c2);
  const probes = [];
  for (const t of names) {
    const vals = [];
    for (const c2 of need.get(t)) {
      if (LIT[c2.tname]) { vals.push([c2.name, c2.tname]); continue; }
      if (c2.tkind === "e" && enums.get(c2.tname)) { vals.push([c2.name, "enum:" + enums.get(c2.tname)]); continue; }
      vals.push(null); break;
    }
    if (vals.includes(null)) { out.probe_skipped.push(`${t}:unsynthesisable column`); continue; }
    probes.push({ t, cols: vals });
  }
  if (!probes.length) {
    bad.push("no org-scoped table is usable as an isolation probe, so cross-workspace access cannot be proven here");
  } else {
    out.probe_table = probes[0].t;
    const row = (pr, org, tag) => {
      const ns = ["org_id", ...pr.cols.map(([n]) => n)];
      const lits = [`'${org}'`, ...pr.cols.map(([, ty]) =>
        ty.startsWith("enum:") ? `'${ty.slice(5)}'` : (LIT[ty].length ? LIT[ty](`${tag}`) : LIT[ty]()))];
      return `INSERT INTO ${q(pr.t)} (${ns.map(q).join(",")}) VALUES (${lits.join(",")})`;
    };
    const writes = new Set();
    await sql.begin(async (t) => {
      for (const pr of probes) {
        try {
          await t.savepoint(async (s) => {
            await s`SELECT set_config('app.org_id', ${B}, true)`;
            await s.unsafe(row(pr, B, `${B}-${pr.t}`));
            const [own] = await s`SELECT count(*)::int AS n FROM ${s(pr.t)} WHERE org_id = ${B}`;
            await s`SELECT set_config('app.org_id', ${A}, true)`;
            const [fr] = await s`SELECT count(*)::int AS n FROM ${s(pr.t)} WHERE org_id = ${B}`;
            let w;
            try {
              await s.savepoint(async (s2) => { await s2.unsafe(row(pr, C, `${C}-${pr.t}`)); });
              w = "ACCEPTED";
            } catch (e) { w = e.code || String(e.message).slice(0, 40); }
            let un = null;
            if (mode === "fail_closed") {
              await s`SELECT set_config('app.org_id', '', true)`;
              // capped: the assertion is "zero", and a full count on a restored table is a seq scan
              const [u] = await s`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${s(pr.t)} LIMIT 5) z`;
              un = u.n;
            }
            out.probe_tables += 1; probedOk.add(pr.t);
            out.own_org_rows += own.n;
            out.foreign_rows += fr.n;
            if (own.n !== 1) out.probe_skipped.push(`${pr.t}:own row not visible in its own workspace`);
            if (fr.n > 0) out.leaking_tables.push(`${pr.t}=${fr.n}`);
            if (w !== "42501") { out.cross_org_writable.push(`${pr.t}=${w}`); }
            writes.add(w);
            if (un !== null) { out.unset_org_rows = (out.unset_org_rows || 0) + un; if (un > 0) out.open_with_no_org.push(`${pr.t}=${un}`); }
          });
        } catch (e) {
          // a synthetic INSERT this table will not accept (check constraint, domain, exclusion) —
          // reported, never silently dropped, and never counted as a pass
          out.probe_skipped.push(`${pr.t}:${e.code || String(e.message).slice(0, 40)}`);
        }
      }
      throw new Error(ROLLBACK);        // the only way out of postgres.js's begin() without a COMMIT
    }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
    out.cross_org_write = writes.size === 1 ? [...writes][0] : `mixed: ${out.cross_org_writable.slice(0, 4).join(", ")}`;
    if (mode === "fail_closed" && out.unset_org_rows === null) out.unset_org_rows = 0;

  }

  // A table neither the live probe nor the behavioural pass could measure has been ASSERTED about,
  // not proven — the exact thing this file exists to stop.
  out.unmeasured = !canMeasure ? []
    : cov.map((x) => x.t).filter((t) => !probedOk.has(t) && beh.unverified.some((u) => u.startsWith(t + ":")));

  /* verdict --------------------------------------------------------------- */
  if (out.role !== ROLE) bad.push(`current_user is ${out.role}, not ${ROLE}`);
  if (out.bypassrls !== false) bad.push(`${out.role} has BYPASSRLS: every policy is silently ignored`);
  if (out.superuser !== false) bad.push(`${out.role} is SUPERUSER: every policy is silently ignored (the app's own health check would not see this)`);
  if (out.sslmode !== "require" && out.sslmode !== "verify-full") bad.push(`DATABASE_URL carries sslmode=${out.sslmode} — the runtime clients pass no ssl option, so this would be plaintext`);
  if (out.pg_stat_ssl !== true && !String(out.plaintext).startsWith("refused"))
    bad.push(out.plaintext === "ACCEPTED" ? "the server accepts unencrypted connections and Postgres did not terminate TLS"
      : `Postgres did not terminate TLS and the plaintext probe was ${out.plaintext} — nothing proved this connection is encrypted`);
  if (!out.guc_roundtrip) bad.push("transaction-local app.org_id did not survive the round trip");
  if (mode !== "off") {
    if (out.open_policies.length) bad.push(`${out.open_policies.length} permissive policy/policies do not scope by org_id, and Postgres OR's them, so each reopens its whole table: ` +
      `${out.open_policies.slice(0, 8).join(", ")}${out.open_policies.length > 8 ? " …" : ""}`);
    if (out.leaking_policies.length) bad.push(`${out.leaking_policies.length} permissive policy/policies were EXECUTED and handed over another workspace's rows: ` +
      `${out.leaking_policies.slice(0, 6).join(", ")}${out.leaking_policies.length > 6 ? " …" : ""}`);
    if (out.unmeasured.length) bad.push(`${out.unmeasured.length} org-scoped table(s) could not be measured at all — neither the ` +
      `cross-workspace probe nor the policy execution pass could reach them, so nothing proves them: ${out.unmeasured.slice(0, 6).join(", ")} ` +
      `(${(out.policies_unverified[0] || "").split(":").slice(-1)[0]})`);
    const silent = out.unprotected.filter((t) => !out.open_policies.some((o) => o.startsWith(t + ":")) &&
                                                 !out.leaking_policies.some((o) => o.startsWith(t + ":")));
    if (silent.length) bad.push(`${silent.length} of ${out.tables_org_scoped} org-scoped table(s) lack ENABLE+FORCE+a policy that scopes by org_id: ${silent.slice(0, 8).join(", ")}${silent.length > 8 ? " …" : ""}`);
    if (out.probe_tables) {
      if (out.own_org_rows !== out.probe_tables) bad.push(`the probe row was not visible in its own workspace on ${out.probe_tables - out.own_org_rows} table(s) — those checks would have been vacuous`);
      if (out.leaking_tables.length) bad.push(`rows of another workspace are READABLE from ${out.leaking_tables.length} table(s): ${out.leaking_tables.slice(0, 8).join(", ")}`);
      if (out.cross_org_writable.length) bad.push(`a cross-workspace INSERT was not refused by RLS on ${out.cross_org_writable.length} table(s) (expected SQLSTATE 42501): ${out.cross_org_writable.slice(0, 8).join(", ")}`);
      if (mode === "fail_closed" && out.open_with_no_org.length) bad.push(`with no workspace in scope ${out.open_with_no_org.length} table(s) still return rows — the policy fails OPEN, so "fail_closed" is false: ${out.open_with_no_org.slice(0, 8).join(", ")}`);
    }
  }
  // The counts are the evidence; the lists are there to name names. Cap them so one JSON line stays a
  // line — a 52-table failure otherwise prints four screens of it and state records four screens of it.
  for (const k of ["unprotected", "open_policies", "leaking_policies", "policies_unverified", "other_role_policies",
                   "probe_skipped", "leaking_tables", "cross_org_writable", "open_with_no_org", "unmeasured"])
    if (Array.isArray(out[k])) out[k] = cap(out[k]);
  console.log(JSON.stringify(out));
  if (bad.length) { console.error("tenant isolation NOT proven: " + bad.join("; ")); process.exit(1); }
} catch (e) {
  console.error("tenant isolation could not be measured — " + why(e));
  process.exit(3);
} finally { await sql.end({ timeout: 5 }).catch(() => {}); }
