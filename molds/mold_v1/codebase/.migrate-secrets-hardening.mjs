// Migration: credential hardening.
//
//   1. connector_secrets.key_version — which key sealed each row, so keys can
//      be rotated and eventually RETIRED. You cannot re-encrypt what you can't
//      tell apart, which is why rotation was impossible before this column.
//   2. NOT NULL on connector_secrets.org_id (already true in the data; this
//      makes the database enforce it) — the org id is the HKDF salt, so a null
//      meant ciphertext sealed with the shared master key.
//   3. STRICT row-level security on connector_secrets ONLY.
//
// On (3): the org_isolation policy from .migrate-org-rls.mjs is PERMISSIVE when
// `app.org_id` is unset — any query that forgets to set the GUC sees every
// workspace's rows. That is a reasonable default for most tables and a bad one
// for the table holding credentials, so this replaces the policy on that single
// table with one that DENIES when the GUC is absent. The other 13 tables are
// untouched: tightening them is a much larger blast radius and a separate call.
//
// This WILL break any reader of connector_secrets that does not go through
// withOrgRls (front-end) or withOrgDb (agent). Every reader was updated in the
// same change set; the verification below re-proves it against live data.
//
// Additive + idempotent. RUN THIS BEFORE deploying.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

// --- 1. key_version -------------------------------------------------------
await sql`ALTER TABLE connector_secrets ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 1`;

// --- 2. org_id NOT NULL ---------------------------------------------------
const [{ orphans }] = await sql`
  SELECT count(*)::int AS orphans FROM connector_secrets WHERE org_id IS NULL`;
if (orphans > 0) {
  // Refuse rather than guess. These rows were sealed with the MASTER key, so
  // assigning them an org would make them undecryptable — they must be
  // re-encrypted (decrypt with the base key, re-seal with the derived one),
  // which needs the real OPS_SECRETS_KEY and a deliberate decision.
  console.error(`REFUSING: ${orphans} connector_secrets rows have a NULL org_id.`);
  console.error("They are sealed with the master key. Re-encrypt them before enforcing NOT NULL.");
  await sql.end();
  process.exit(1);
}
await sql`ALTER TABLE connector_secrets ALTER COLUMN org_id SET NOT NULL`;

// --- 3. strict RLS on the credential table --------------------------------
const STRICT = `(
  org_id = nullif(current_setting('app.org_id', true), '')
)`;
await sql.unsafe(`ALTER TABLE connector_secrets ENABLE ROW LEVEL SECURITY`);
await sql.unsafe(`ALTER TABLE connector_secrets FORCE ROW LEVEL SECURITY`);
await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON connector_secrets`);
await sql.unsafe(`DROP POLICY IF EXISTS org_isolation_strict ON connector_secrets`);
await sql.unsafe(
  `CREATE POLICY org_isolation_strict ON connector_secrets
     USING ${STRICT}
     WITH CHECK ${STRICT}`,
);

/* ------------------------------- verify ---------------------------------- */

const [{ n: total }] = await sql`SELECT count(*)::int AS n FROM connector_secrets`;
console.log(`\nkey_version column: present · connector_secrets rows: ${total}`);

const [{ is_nullable }] = await sql`
  SELECT is_nullable FROM information_schema.columns
  WHERE table_name = 'connector_secrets' AND column_name = 'org_id'`;
console.log(`org_id nullable (must be NO): ${is_nullable}`);

/**
 * Enforcement MUST be verified as the role the application uses — not as
 * whoever runs this migration.
 *
 * A role with the BYPASSRLS attribute ignores every policy, and FORCE ROW LEVEL
 * SECURITY does not change that (FORCE only subjects the table's OWNER to
 * policies; BYPASSRLS outranks it). Neon's `neondb_owner`, which is what
 * DATABASE_URL points at, has BYPASSRLS — so a check run over that connection
 * reports "still visible" no matter how correct the policy is, and would send
 * you looking for a bug in the policy that isn't there.
 */
const [who] = await sql`
  SELECT current_user AS role,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
console.log(`\nmigration role: ${who.role} (bypassrls=${who.bypassrls})`);

// DATABASE_URL is the app role now (app_rw on Supabase). DATABASE_URL_APP_RW
// was a Neon URL left behind by the migration off that provider — it still
// CONNECTED, to a database ten customers out of date, which is the worst kind
// of stale credential: it fails silently rather than loudly.
const appUrl = env.DATABASE_URL;
let enforced = null;
if (!appUrl) {
  console.log("No DATABASE_URL — cannot verify enforcement from here.");
} else {
  const app = postgres(appUrl, { ssl: "require" });
  const [{ n: unscoped }] = await app`SELECT count(*)::int AS n FROM connector_secrets`;
  let own = -1;
  let foreign = -1;
  await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', 'org-onfinance', true)`;
    [{ n: own }] = await tx`SELECT count(*)::int AS n FROM connector_secrets`;
  });
  await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', 'zz-nonexistent-org', true)`;
    [{ n: foreign }] = await tx`SELECT count(*)::int AS n FROM connector_secrets`;
  });
  await app.end();
  console.log(`as app_rw · GUC unset (must be 0): ${unscoped}`);
  console.log(`as app_rw · own workspace (must be ${total}): ${own}`);
  console.log(`as app_rw · foreign workspace (must be 0): ${foreign}`);
  enforced = unscoped === 0 && own === total && foreign === 0;
}

console.log(
  enforced && is_nullable === "NO"
    ? "\nOK — credential table hardened AND enforced for app_rw."
    : "\nCHECK THE OUTPUT ABOVE.",
);

if (who.bypassrls) {
  console.log(
    "\n⚠ The application still connects as a BYPASSRLS role (DATABASE_URL = " +
      `${who.role}). Until DATABASE_URL points at app_rw, these policies protect ` +
      "nothing at runtime and application-level WHERE org_id is the only isolation.",
  );
}

await sql.end();
