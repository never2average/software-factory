/**
 * What a row-level-security policy DOES, measured — not what its text looks like.
 *
 * Both RLS scripts used to classify a policy by reading its predicate: "does the expression mention
 * org_id and current_setting('app.org_id')". That is one step better than counting policies and one
 * step short of a proof. Measured on a throwaway copy of this mold's schema:
 *
 *     CREATE POLICY tickets_scope ON tickets
 *       USING ((org_id = current_setting('app.org_id', true)) OR true)
 *       WITH CHECK ((org_id = current_setting('app.org_id', true)) OR true);
 *
 * names org_id, names the GUC, satisfies every text rule — and lets app_rw (rolsuper false,
 * rolbypassrls false) scoped to org_alpha read org_beta's row. rls-cover.mjs filed it under
 * `kept_strict` and exited 0; verify-apprw.mjs reported `protected: 52, open_policies: []` and exited
 * 0. `tickets` carries foreign keys, so the cross-boundary INSERT probe skips it, and the text rule was
 * the only thing standing between that database and a "tenant isolation proven" record.
 *
 * So every permissive policy is now EXECUTED against rows this module owns:
 *
 *   1. build a TEMP table with the real table's exact columns (name + format_type), no constraints, no
 *      foreign keys, no triggers, no defaults — nothing that can make an INSERT fail for a reason other
 *      than RLS, which is precisely what makes the 12 tables the live probe cannot touch measurable;
 *   2. seed workspace A, workspace B, and a second B row with every synthesisable column filled, so a
 *      predicate that reads some OTHER column is exercised rather than left NULL;
 *   3. ENABLE + FORCE row level security, then, ONE POLICY AT A TIME (permissive policies OR, so a
 *      single one that admits a foreign row opens the table by itself, and testing them singly is what
 *      names the guilty policy rather than the table);
 *   4. scoped to A, read B's rows       — anything visible is a cross-workspace READ;
 *      scoped to A, insert C's row      — anything but SQLSTATE 42501 is a cross-workspace WRITE;
 *      fail_closed, app.org_id = ''     — anything visible means the policy fails OPEN.
 *
 * Everything runs in ONE transaction that ends in ROLLBACK, each table under its own SAVEPOINT. Nothing
 * outside the transaction is read and nothing is written: the temp tables and the policies on them
 * disappear with it. The rows are synthetic, so the test is never vacuous — an empty real table proves
 * nothing, this one always carries a foreign row to find.
 *
 * Cost: a handful of round trips per policy, ~52 policies on this schema — under two seconds against a
 * database on the same box, ten or so against a managed one across the internet. Statements are not
 * batched on purpose: a multi-statement simple query would hide which one failed, and this file's whole
 * job is to say exactly what was measured and what was not.
 *
 * It must run AS THE APPLICATION ROLE: a superuser (and any BYPASSRLS role) ignores every policy, so
 * measuring as one would report a leak on a perfect database. rls-cover.mjs connects as the admin and
 * therefore asks for `assume`, which does SET LOCAL ROLE for the duration of the transaction;
 * verify-apprw.mjs already IS app_rw and asks for nothing. If the role cannot be assumed, or a table's
 * shape cannot be replicated, that table is reported `unverified` — never silently counted as passing.
 *
 * Text classification (isScoped) stays, and stays load-bearing: it answers a different question — "is
 * there a policy whose predicate scopes by org_id at all" — and it is what makes a table with no such
 * policy report as uncovered. The two are ANDed. A table is protected when it is enabled, forced,
 * carries a scoped policy, and NOT ONE of its permissive policies admitted a foreign row here.
 */
/**
 * THE predicates, in one place. rls-cover.mjs converges every org-scoped table to them and
 * deploy-window.mjs holds the same tables to them for the length of a deploy; if the two ever differed,
 * the guard would either lock the app out (stricter) or be the window it exists to close (looser).
 * provision.py --self-test fails if either script defines its own copy.
 *
 * The CONTROL PLANE (read before any workspace is known: sign-in, "which workspaces am I in", claiming an
 * invite, acrossOrgsRls()'s sweep) keeps the open-when-unset shape even in fail_closed; see rls-cover.mjs.
 */
export const CONTROL_PLANE = new Set(["orgs", "org_members", "org_invites"]);
export const STRICT = `(org_id = current_setting('app.org_id', true))`;
export const OPEN = `(coalesce(current_setting('app.org_id', true), '') = '' OR org_id = current_setting('app.org_id', true))`;
/** The predicate a table converges to under `mode`. */
export const orgPredicate = (mode, t) => (mode === "fail_closed" && !CONTROL_PLANE.has(t) ? STRICT : OPEN);

export const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
export const exprs = (p) => [p.qual, p.with_check].filter((e) => e !== null && e !== undefined && e !== "");
/** A predicate can only confine a row to a workspace if it reads the workspace and compares org_id. */
const scopedText = (e) => /\borg_id\b/i.test(e) && /current_setting\(\s*'app\.org_id'/i.test(e);
export const isScoped = (p) => { const e = exprs(p); return e.length > 0 && e.every(scopedText); };

/** One line, no stack, no Node version banner — provision.py stores this verbatim as the revert reason. */
export function why(e) {
  const c = e && (e.code || e.errno), m = String((e && e.message) || e);
  if (c === "ECONNREFUSED") return "cannot reach the database: connection refused";
  if (c === "ENOTFOUND" || c === "EAI_AGAIN") return "cannot reach the database: host not found";
  if (c === "ETIMEDOUT" || c === "CONNECT_TIMEOUT") return "cannot reach the database: connection timed out";
  if (c === "28P01" || c === "28000") return "the database refused these credentials (password authentication failed)";
  if (c === "3D000") return "that database does not exist on this server";
  if (c === "42501") return "not allowed: " + m.split("\n")[0].slice(0, 120);
  if (c === "ECONNRESET" || c === "EPIPE") return "the database closed the connection (TLS or pooler mismatch)";
  return (c ? `${c}: ` : "") + m.split("\n")[0].slice(0, 200);
}

/** The counts are the evidence; the names are there to point at. Keep one JSON line one line. */
export const cap = (a) => (a.length > 20 ? [...a.slice(0, 20), `+${a.length - 20} more`] : a);

const LIT = { text: (v) => `'${v}'`, varchar: (v) => `'${v}'`, bpchar: (v) => `'${v}'`, citext: (v) => `'${v}'`,
  name: (v) => `'${v}'`, uuid: () => "gen_random_uuid()", timestamptz: () => "now()", timestamp: () => "now()",
  date: () => "now()::date", time: () => "'00:00:00'", bool: () => "false", int2: () => "0", int4: () => "0",
  int8: () => "0", numeric: () => "0", float4: () => "0", float8: () => "0", json: () => `'{}'::json`,
  jsonb: () => `'{}'::jsonb`, inet: () => `'127.0.0.1'`, bytea: () => `'\\x00'` };

/** Three workspace ids of the org_id column's own type, so the seed works whether it is text or uuid. */
function orgIds(col) {
  const t = col ? col.tname : "text";
  if (t === "uuid") return ["1e0a0000-0000-4000-8000-000000000001", "1e0a0000-0000-4000-8000-000000000002",
                            "1e0a0000-0000-4000-8000-000000000003"];
  if (["int2", "int4", "int8", "numeric"].includes(t)) return ["910001", "910002", "910003"];
  return ["__rls_eval_a__", "__rls_eval_b__", "__rls_eval_c__"];
}

const ROLLBACK = "__rls_eval_rollback__";

/**
 * @param sql        postgres.js handle, connected AS THE APP ROLE or as a role that can SET ROLE to it
 * @param tables     [{t, ...}] the org-scoped tables to measure
 * @param policies   Map table -> [{p, cmd, qual, with_check}] permissive policies that apply to the app role
 * @param mode       "fail_closed" | "on"
 * @param control    Set of control-plane table names (exempt from the no-workspace-in-scope check only)
 * @param assume     role name to SET LOCAL ROLE to, or null when already connected as it
 * @returns {leaking: ["table:policy(reason)"], unverified: ["table:reason"], checked, tables_checked}
 */
export async function measurePolicies(sql, { tables, policies, mode = "fail_closed", control = new Set(), assume = null }) {
  const out = { leaking: [], unverified: [], checked: 0, tables_checked: 0 };
  const names = tables.filter((x) => (policies.get(x.t) || []).length).map((x) => x.t);
  if (!names.length) return out;
  const cols = await sql`
    SELECT c.relname AS t, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
           ty.typname AS tname, ty.typtype AS tkind
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = ANY(${names}) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`;
  const enums = new Map((await sql`
    SELECT ty.typname AS n, (SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = ty.oid ORDER BY e.enumsortorder LIMIT 1) AS l
    FROM pg_type ty WHERE ty.typtype = 'e'`).map((x) => [x.n, x.l]));
  const byTable = new Map(names.map((n) => [n, []]));
  for (const c of cols) if (byTable.has(c.t)) byTable.get(c.t).push(c);

  try {
    await sql.begin(async (t) => {
      // SET LOCAL: it is undone by the ROLLBACK below, and a failure here is reported for every table
      // rather than mistaken for a clean run.
      if (assume) await t.unsafe(`SET LOCAL ROLE ${q(assume)}`);
      let i = 0;
      for (const name of names) {
        const cs = byTable.get(name) || [];
        const org = cs.find((c) => c.name === "org_id");
        const pols = policies.get(name) || [];
        const probe = `rls_eval_${i++}`;
        const [A, B, C] = orgIds(org);
        try {
          await t.savepoint(async (s) => {
            await s.unsafe(`CREATE TEMP TABLE ${q(probe)} (${cs.map((c) => `${q(c.name)} ${c.type}`).join(", ")})`);
            const fill = (org_id, filled) => {
              const ns = [], vs = [];
              for (const c of cs) {
                if (c.name === "org_id") { ns.push(c.name); vs.push(`'${org_id}'`); continue; }
                if (!filled) continue;
                if (LIT[c.tname]) { ns.push(c.name); vs.push(LIT[c.tname].length ? LIT[c.tname](`${org_id}-${c.name}`) : LIT[c.tname]()); }
                else if (c.tkind === "e" && enums.get(c.tname)) { ns.push(c.name); vs.push(`'${enums.get(c.tname)}'`); }
              }
              return `INSERT INTO ${q(probe)} (${ns.map(q).join(", ")}) VALUES (${vs.join(", ")})`;
            };
            // A's row, B's row, and a B row with every synthesisable column filled: a predicate that
            // reads some other column is then exercised instead of short-circuiting on NULL.
            await s.unsafe(fill(A, false)); await s.unsafe(fill(B, false)); await s.unsafe(fill(B, true));
            await s.unsafe(`ALTER TABLE ${q(probe)} ENABLE ROW LEVEL SECURITY`);
            await s.unsafe(`ALTER TABLE ${q(probe)} FORCE ROW LEVEL SECURITY`);
            out.tables_checked += 1;
            for (const p of pols) {
              const cmd = (p.cmd || "ALL").toUpperCase();
              const using = p.qual ? ` USING (${p.qual})` : "";
              const chk = p.with_check ? ` WITH CHECK (${p.with_check})` : (cmd === "ALL" && p.qual ? ` WITH CHECK (${p.qual})` : "");
              // one fixed name: only ever one policy at a time on the probe, and a real policy name
              // can be 63 bytes long, which a prefixed copy would silently truncate into a collision.
              const ddl = `CREATE POLICY ${q("rls_eval_policy")} ON ${q(probe)} FOR ${cmd}` +
                (["SELECT", "DELETE"].includes(cmd) ? using : ["INSERT"].includes(cmd) ? chk : using + chk);
              try {
                await s.savepoint(async (s2) => {
                  await s2.unsafe(ddl);
                  const reasons = [];
                  if (["ALL", "SELECT"].includes(cmd)) {
                    await s2`SELECT set_config('app.org_id', ${A}, true)`;
                    const [f] = await s2.unsafe(`SELECT count(*)::int AS n FROM ${q(probe)} WHERE org_id = '${B}'`);
                    if (f.n > 0) reasons.push("reads another workspace's rows");
                    if (mode === "fail_closed" && !control.has(name)) {
                      await s2`SELECT set_config('app.org_id', '', true)`;
                      const [u] = await s2.unsafe(`SELECT count(*)::int AS n FROM ${q(probe)}`);
                      if (u.n > 0) reasons.push("returns rows with no workspace in scope");
                    }
                  }
                  if (["ALL", "INSERT"].includes(cmd)) {          // an UPDATE-only policy cannot admit an INSERT
                    await s2`SELECT set_config('app.org_id', ${A}, true)`;
                    let w = "42501";
                    try { await s2.savepoint(async (s3) => { await s3.unsafe(fill(C, false)); }); w = "ACCEPTED"; }
                    catch (e) { w = e.code || "error"; }
                    if (w === "ACCEPTED") reasons.push("accepts a row owned by another workspace");
                  }
                  out.checked += 1;
                  if (reasons.length) out.leaking.push(`${name}:${p.p}(${reasons.join(" + ")})`);
                  throw new Error(ROLLBACK);          // drop the policy by unwinding to the savepoint
                });
              } catch (e) { if (e.message !== ROLLBACK) out.unverified.push(`${name}:${p.p}:${why(e).slice(0, 90)}`); }
            }
            throw new Error(ROLLBACK);                // drop the temp table with the savepoint
          });
        } catch (e) {
          if (e.message !== ROLLBACK) out.unverified.push(`${name}:${why(e).slice(0, 90)}`);
        }
      }
      throw new Error(ROLLBACK);                      // the only way out of begin() without a COMMIT
    }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
  } catch (e) {
    // Could not measure at all (SET ROLE refused, no TEMP privilege). Say so per table: an unverified
    // policy must never read as a passing one.
    out.unverified.push(`all:${why(e)}`);
    for (const n of names) if (!out.unverified.some((u) => u.startsWith(n + ":"))) out.unverified.push(`${n}:not measured`);
  }
  return out;
}
