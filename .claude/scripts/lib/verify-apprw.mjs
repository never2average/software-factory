/**
 * Gate the DATABASE_URL that is ABOUT to be deployed.
 *
 * provision.py used to trust the mold's own self-test and then push a URL it had never opened. That
 * is how the live app came to report `role postgres — WARNING: BYPASSRLS, row-level security is NOT
 * enforced`. This proves five things on the exact string that will become DATABASE_URL, and exits
 * non-zero otherwise, so that state is unreachable.
 *
 *   1 current_user is app_rw            — not the owner, not postgres
 *   2 rolbypassrls is false             — BYPASSRLS silently ignores every policy, and
 *                                         FORCE ROW LEVEL SECURITY does not override it
 *   3 at least one policy exists        — .setup-app-role.mjs would give a perfect role and 0 policies
 *   4 the wire is encrypted             — see below
 *   5 a transaction-local app.org_id survives a round trip — this is what makes RLS hold through a
 *     transaction pooler, which is exactly what Neon's pooled endpoint and Supavisor:6543 are
 *
 * ENCRYPTION IS NOT pg_stat_ssl. Neon terminates TLS at its proxy, so the backend reports
 * `pg_stat_ssl.ssl = false` on a connection that is fully encrypted on the wire; measured on both its
 * pooled and direct endpoints. The honest test is the server's own refusal: with sslmode=disable Neon
 * answers `connection is insecure (try using sslmode=require)`. So: accept ssl=true when Postgres
 * itself terminated TLS, otherwise require that the server REFUSES a plaintext connection. A server
 * that happily accepts plaintext fails here, which is the property that actually matters — the mold's
 * runtime clients pass no ssl option at all, so the URL is the only thing that turns TLS on.
 *
 * The URL arrives in APP_RW_URL, never in argv: /proc/<pid>/cmdline is world-readable.
 * Prints one JSON line with no secret in it.
 */
import postgres from "postgres";
const url = process.env.APP_RW_URL;
if (!url) { console.error("APP_RW_URL is not set"); process.exit(2); }
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20 });
let plaintext = "not tried";
try {
  const [r] = await sql`SELECT current_user AS u,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b,
    (SELECT count(*)::int FROM pg_policies) AS p,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`;
  const [g] = await sql.begin((t) => t`SELECT set_config('app.org_id','__probe__',true) AS org`);
  if (r.ssl !== true) {                       // TLS may be terminated in front of Postgres; prove plaintext is refused
    const u = new URL(url); u.searchParams.set("sslmode", "disable");
    const bare = postgres(u.toString(), { max: 1, prepare: false, connect_timeout: 15 });
    try { await bare`SELECT 1`; plaintext = "ACCEPTED"; } catch { plaintext = "refused"; }
    await bare.end({ timeout: 5 }).catch(() => {});
  }
  const sslmode = new URL(url).searchParams.get("sslmode");
  console.log(JSON.stringify({ user: r.u, bypassrls: r.b, policies: r.p, pg_stat_ssl: r.ssl, sslmode, plaintext, guc: g.org }));
  const bad = [];
  if (r.u !== "app_rw") bad.push(`current_user is ${r.u}, not app_rw`);
  if (r.b !== false) bad.push("app_rw has BYPASSRLS: every policy is silently ignored");
  if (!(r.p > 0)) bad.push("0 row-level security policies exist");
  if (sslmode !== "require" && sslmode !== "verify-full") bad.push(`DATABASE_URL carries sslmode=${sslmode} — the runtime clients pass no ssl option, so this would be plaintext`);
  if (r.ssl !== true && plaintext !== "refused") bad.push("the server accepts unencrypted connections and Postgres did not terminate TLS");
  if (g.org !== "__probe__") bad.push("transaction-local app.org_id did not survive the round trip");
  if (bad.length) { console.error("app_rw verification failed: " + bad.join("; ")); process.exit(1); }
} finally { await sql.end({ timeout: 5 }).catch(() => {}); }
