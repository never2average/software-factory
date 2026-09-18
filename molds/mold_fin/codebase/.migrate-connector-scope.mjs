/**
 * Migration: account-level vs organization-level connectors.
 *
 *   owner_email NULL  → organization-level. Shared by the workspace. "Our Slack."
 *   owner_email set   → account-level. That person's. "My GitHub PAT."
 *
 * org_id stays NOT NULL on both. A personal connector still lives INSIDE a
 * workspace — that is what makes it billable to the right place, visible to
 * RLS, and removable when the person leaves. "My GitHub in Onfinance" and "my
 * GitHub in Example AI" are properly different rows.
 *
 * THE VISIBILITY RULE LIVES IN THE POLICY, not in application code. Today's
 * work found nine places where a hand-written filter had been forgotten; a
 * personal credential is the last thing that should depend on remembering one.
 * The policy gains a second clause reading a second GUC:
 *
 *   org_id = current_setting('app.org_id')
 *   AND (owner_email IS NULL OR owner_email = current_setting('app.principal_email'))
 *
 * A caller with no principal set — a cron, a workflow, any automation — sees
 * ONLY organization-level connectors. That is deliberate and it is the safe
 * default: a scheduled job must not act with a person's personal credentials,
 * and must not break the day they leave.
 *
 * Run now, while `connectors` and `connector_secrets` are both EMPTY: the
 * secret key derivation changes for personal connectors (the HKDF salt gains
 * the owner, so a workspace admin with database access cannot decrypt a
 * colleague's token with the workspace key). After the first secret is stored,
 * that same change means re-encrypting every row.
 *
 * Review the DDL, then run:  ! node .migrate-connector-scope.mjs
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";

function readEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const url =
  readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

const sql = postgres(url, { ssl: "require", prepare: false });
const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}\n`);

// Re-encryption warning rather than silent breakage.
const [{ n: secretCount }] = await sql`SELECT count(*)::int n FROM connector_secrets`;
if (secretCount > 0 && !process.argv.includes("--accept-reencryption")) {
  console.log(
    `✗ ${secretCount} connector secret(s) already exist.\n` +
      "  Personal connectors derive their key from a salt that includes the owner, so\n" +
      "  those rows would need re-encrypting before this is safe. Re-run with\n" +
      "  --accept-reencryption only once that is handled.",
  );
  await sql.end();
  process.exit(1);
}

await sql.unsafe(`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS owner_email text`);
console.log("✓ owner_email added (NULL = organization-level)");

// The list is filtered by owner on every read, and by org before that.
await sql.unsafe(
  `CREATE INDEX IF NOT EXISTS connectors_org_owner_idx ON connectors (org_id, owner_email)`,
);
console.log("✓ index on (org_id, owner_email)");

/**
 * The policy. Note the coalesce on the workspace clause: a transaction-local
 * set_config resets to '' on a pooled connection rather than to unset, and
 * testing IS NULL for that cost an outage earlier today.
 */
const visible = `(
  org_id = current_setting('app.org_id', true)
  AND (
    owner_email IS NULL
    OR owner_email = coalesce(current_setting('app.principal_email', true), '')
  )
)`;
await sql.unsafe(`ALTER POLICY org_isolation ON connectors USING ${visible} WITH CHECK ${visible}`);
console.log("✓ connectors policy now enforces owner visibility as well as workspace");

// Secrets inherit their connector's visibility — a personal connector's
// credential must not be readable by the rest of the workspace either.
const secretsVisible = `(
  coalesce(current_setting('app.org_id', true), '') <> ''
  AND org_id = current_setting('app.org_id', true)
  AND connector_id IN (
    SELECT id FROM connectors
    WHERE org_id = current_setting('app.org_id', true)
      AND (
        owner_email IS NULL
        OR owner_email = coalesce(current_setting('app.principal_email', true), '')
      )
  )
)`;
/**
 * The policy on connector_secrets is NOT called org_isolation — it is
 * `org_isolation_strict`, installed by .migrate-secrets-hardening.mjs, and it
 * was already fail-closed long before the rest of the tables were. Assuming
 * the name here failed the migration halfway through, after the connectors
 * half had applied. Look it up instead.
 */
const [secretsPolicy] = await sql`
  SELECT policyname FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'connector_secrets'
  LIMIT 1`;
if (!secretsPolicy) {
  console.log("! connector_secrets has no RLS policy — skipping (nothing to extend)");
} else {
  await sql.unsafe(
    `ALTER POLICY ${secretsPolicy.policyname} ON connector_secrets USING ${secretsVisible} WITH CHECK ${secretsVisible}`,
  );
  console.log(`✓ ${secretsPolicy.policyname} on connector_secrets follows its connector's visibility`);
}

const [col] = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'connectors' AND column_name = 'owner_email'`;
console.log(`\n${col ? "✓ ready" : "✗ owner_email missing"}`);
await sql.end();
process.exit(col ? 0 : 1);
