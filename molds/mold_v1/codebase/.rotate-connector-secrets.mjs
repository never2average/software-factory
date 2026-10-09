// Rotate the connector-secret encryption key.
//
// Rotation here means: decrypt every stored credential under the key it was
// sealed with, re-seal it under the newest key, and record the new version. The
// plaintext exists only in this process, only for the moment between the two
// operations, and is never printed.
//
// HOW TO ROTATE
//   1. openssl rand -base64 32                     → the new key
//   2. Add it as OPS_SECRETS_KEY_V<n> on BOTH Vercel projects (agent-workspace and
//      agent-workspace-api) AND in .env.local, keeping the old key in place.
//   3. Deploy. New writes immediately use V<n>; old rows still read under their
//      own version, so nothing breaks and there is no flag day.
//   4. node .rotate-connector-secrets.mjs          → re-encrypts everything
//   5. Only once this reports 0 rows on the old version, remove the old key.
//
// Step 5 is the point of the whole exercise: a key you cannot retire is a key
// you can never respond to a compromise with.
//
// --dry-run reports what would change and decrypts nothing.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const DRY = process.argv.includes("--dry-run");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

/* --- keyring: must match lib/secret-crypto.ts exactly --------------------- */
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const HKDF_INFO = "ops-connector-secret-v1";
const MAX_KEY_VERSION = 16;
const keyEnv = (v) => (v === 1 ? "OPS_SECRETS_KEY" : `OPS_SECRETS_KEY_V${v}`);

function baseKey(version) {
  const name = keyEnv(version);
  const raw = env[name] ?? process.env[name];
  if (!raw) throw new Error(`${name} is not set — cannot handle rows on key version ${version}.`);
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === KEY_BYTES) return b64;
  const hex = Buffer.from(raw, "hex");
  if (hex.length === KEY_BYTES) return hex;
  throw new Error(`${name} must decode to ${KEY_BYTES} bytes.`);
}
const derive = (orgId, version) =>
  Buffer.from(
    hkdfSync("sha256", baseKey(version), Buffer.from(orgId, "utf8"), Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES),
  );

function latestVersion() {
  let v = 1;
  for (let i = 2; i <= MAX_KEY_VERSION; i += 1) if (env[keyEnv(i)] ?? process.env[keyEnv(i)]) v = i;
  return v;
}

const target = latestVersion();
const sql = postgres(env.DATABASE_URL, { ssl: "require" });

const rows = await sql`
  SELECT id, org_id, name, ciphertext, iv, tag, key_version
  FROM connector_secrets ORDER BY updated_at`;

const byVersion = rows.reduce((m, r) => ({ ...m, [r.key_version]: (m[r.key_version] ?? 0) + 1 }), {});
console.log(`target key version: ${target} (${keyEnv(target)})`);
console.log(`rows by current version: ${JSON.stringify(byVersion)}`);

const stale = rows.filter((r) => r.key_version !== target);
if (stale.length === 0) {
  console.log("Nothing to rotate — every row is already on the target key.");
  await sql.end();
  process.exit(0);
}
console.log(`${stale.length} row(s) to re-encrypt.`);
if (DRY) {
  for (const r of stale) console.log(`  would re-encrypt ${r.org_id}/${r.name} (v${r.key_version} → v${target})`);
  await sql.end();
  process.exit(0);
}

let done = 0;
let failed = 0;
for (const r of stale) {
  try {
    // Decrypt under the OLD version's derived key.
    const dec = createDecipheriv(ALGORITHM, derive(r.org_id, r.key_version), Buffer.from(r.iv, "base64"));
    dec.setAuthTag(Buffer.from(r.tag, "base64"));
    const plain = Buffer.concat([dec.update(Buffer.from(r.ciphertext, "base64")), dec.final()]);

    // Re-seal under the NEW one, with a fresh IV (never reuse an IV in GCM).
    const iv = randomBytes(12);
    const cip = createCipheriv(ALGORITHM, derive(r.org_id, target), iv);
    const sealed = Buffer.concat([cip.update(plain), cip.final()]);

    await sql`
      UPDATE connector_secrets SET
        ciphertext = ${sealed.toString("base64")},
        iv = ${iv.toString("base64")},
        tag = ${cip.getAuthTag().toString("base64")},
        key_version = ${target}
      WHERE id = ${r.id}`;
    plain.fill(0); // don't leave it sitting in this buffer
    done += 1;
    console.log(`  ✓ ${r.org_id}/${r.name}  v${r.key_version} → v${target}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${r.org_id}/${r.name}: ${e.message}`);
  }
}

const after = await sql`
  SELECT key_version, count(*)::int AS n FROM connector_secrets GROUP BY key_version ORDER BY key_version`;
console.log(`\nre-encrypted ${done}, failed ${failed}`);
console.log("rows by version now:", JSON.stringify(Object.fromEntries(after.map((r) => [r.key_version, r.n]))));
console.log(
  failed === 0 && after.every((r) => r.key_version === target)
    ? `OK — every row is on v${target}. The older key can now be removed from both projects.`
    : "NOT COMPLETE — leave the old key in place until every row has moved.",
);

await sql.end();
process.exit(failed === 0 ? 0 : 1);
