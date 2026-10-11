/**
 * `operator:onboard-self` AGAINST A FAIL-CLOSED POSTGRES (mold_v1-229).
 *
 * onboard-self records the person running it as a team memory (`member-profile:<email>`). It used to read and write
 * that row on a bare connection: no workspace in scope and no org_id on the row. On a deployment whose org_isolation
 * policy fails closed (the production shape, .migrate-rls-fail-closed.mjs) the insert was refused with 42501, so the
 * command failed on every such app, while its siblings `operator:new-org` and `operator:new-customer` worked: they
 * write inside `withOrgDb(<workspace>)`. This runs the real command, as an operator would, and proves:
 *
 *   1. with `--org A` it records the profile in A: one row, org_id A, scope team, under the member-profile key;
 *   2. run again it updates that row in place (version 2), still one row;
 *   3. with `--org B` it records a separate row in B and leaves A's untouched (B's run never sees A's row);
 *   4. with no workspace (no --org, no WORKSPACE_ORG) it refuses, names --org, and writes nothing;
 *   5. on a filesystem-storage deployment it does not warn that BLOB_READ_WRITE_TOKEN is missing (that token is the
 *      Vercel Blob driver's only), and it writes the roster entry into the workspace's own tree. With the default
 *      driver and no token the advisory line is still printed.
 *
 * On the commit before this one check 1 fails: the command exits 1 with "That record can't be changed from this
 * workspace" (42501) and no row is written.
 *
 * It flips every org_isolation policy to the production FAIL-CLOSED shape (bootstrap-test-db builds the permissive
 * one) and puts each back exactly as it found it in a finally block, with every row it wrote. Needs ADMIN_URL (policy
 * DDL) and DATABASE_URL (app_rw); without them it skips.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:onboard-self-db
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { DEFAULT_DOMAIN } from "./lib/default-org.mjs";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-onboard-self-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname;
const scratch = mkdtempSync(path.join(tmpdir(), "onboard-self-test-"));

const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ✓ ${what}`);
  } else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`}`);
  }
};

const PID = process.pid;
const A = `onboard-a-${PID}`;
const B = `onboard-b-${PID}`;
const EMAIL = `probe-${PID}@${DEFAULT_DOMAIN}`;
const KEY = `member-profile:${EMAIL}`;

/** The environment a person runs the command with, minus anything that would reach out or pick a workspace. */
function baseEnv(extra = {}) {
  const env = { ...process.env, DATABASE_URL: appUrl, DATAROOM_DIR: path.join(scratch, "local-dataroom") };
  for (const name of ["WORKSPACE_ORG", "BLOB_READ_WRITE_TOKEN", "STORAGE_DRIVER", "STORAGE_FS_ROOT", "STORAGE_SIGNING_SECRET", "STORAGE_PUBLIC_URL", "WEB_ORIGIN"]) delete env[name];
  // The health probe is advisory; point it at a closed local port so it answers at once and nothing leaves the box.
  env.WORKSPACE_OPS_URL = "http://127.0.0.1:9";
  env.HOME = path.join(scratch, "home"); // no stored sign-in: the identity is --email's
  return { ...env, ...extra };
}

/** Run `npm run operator:onboard-self -- …` as package.json does (without its --env-file). */
function onboard(args, env = baseEnv()) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/operator/onboard-self.mjs", "--email", EMAIL, "--name", "Probe", ...args],
    { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 },
  );
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const rowsFor = () => admin`SELECT org_id, scope, entity_id, key, version, value FROM memories WHERE key = ${KEY} ORDER BY org_id`;

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)));
}

const saved = new Map();
try {
  const probe = postgres(appUrl, { ssl, prepare: false, max: 1 });
  const [{ rolbypassrls, rolsuper, current_user: who }] = await probe`
    SELECT r.rolbypassrls, r.rolsuper, current_user FROM pg_roles r WHERE r.rolname = current_user`;
  await probe.end();
  console.log(`Connected as ${who}`);
  if (rolbypassrls || rolsuper) throw new Error(`${who} bypasses RLS — this test would prove nothing`);

  const policies = await admin`SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.some((p) => p.tablename === "memories")) throw new Error("no org_isolation policy on memories — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const { tablename, qual } of policies) {
    saved.set(tablename, qual);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape\n`);

  // 1. One workspace, first run.
  const first = onboard(["--org", A]);
  check("with --org A the command succeeds", first.status === 0, first.out);
  let rows = await rowsFor();
  check(
    "…and records ONE team memory in A, under the member-profile key",
    rows.length === 1 && rows[0].org_id === A && rows[0].scope === "team" && rows[0].entity_id === null && rows[0].version === 1,
    rows,
  );
  check("…holding the profile it was given", rows.length === 1 && JSON.parse(rows[0].value).email === EMAIL && JSON.parse(rows[0].value).name === "Probe", rows);

  // 2. Same workspace again: an update in place.
  const again = onboard(["--org", A]);
  rows = await rowsFor();
  check("run again in A, it updates the row in place (version 2, still one row)", again.status === 0 && rows.length === 1 && rows[0].version === 2, { out: again.out, rows });

  // 3. Another workspace: its own row; A's is not touched.
  const other = onboard(["--org", B]);
  rows = await rowsFor();
  const inA = rows.find((r) => r.org_id === A);
  const inB = rows.find((r) => r.org_id === B);
  check("with --org B it records a separate row in B", other.status === 0 && inB?.version === 1, { out: other.out, rows });
  check("…and leaves A's row as it was", inA?.version === 2 && rows.length === 2, rows);

  // 4. No workspace named: refused, nothing written.
  const before = (await admin`SELECT count(*)::int AS n FROM memories WHERE key = ${KEY}`)[0].n;
  const none = onboard([]);
  const after = (await admin`SELECT count(*)::int AS n FROM memories WHERE key = ${KEY}`)[0].n;
  check("with no workspace it refuses", none.status !== 0, none.out);
  check("…says to pass --org (or set WORKSPACE_ORG)", /--org/.test(none.out) && /WORKSPACE_ORG/.test(none.out), none.out);
  check("…and writes nothing", after === before, { before, after });
  const viaEnv = onboard([], baseEnv({ WORKSPACE_ORG: A }));
  rows = await rowsFor();
  check("WORKSPACE_ORG names the workspace too", viaEnv.status === 0 && rows.find((r) => r.org_id === A)?.version === 3, { out: viaEnv.out, rows });

  // 5. The storage advisory follows the deployment's driver.
  const fsRoot = path.join(scratch, "fs-store");
  const fsEnv = baseEnv({
    STORAGE_DRIVER: "filesystem",
    STORAGE_FS_ROOT: fsRoot,
    STORAGE_SIGNING_SECRET: "s".repeat(40),
    STORAGE_PUBLIC_URL: "http://127.0.0.1:9",
  });
  const onFs = onboard(["--org", A], fsEnv);
  check("on a filesystem-storage deployment it succeeds", onFs.status === 0, onFs.out);
  check("…without warning that BLOB_READ_WRITE_TOKEN is missing", !/BLOB_READ_WRITE_TOKEN/.test(onFs.out), onFs.out);
  check("…and names the driver it found", /filesystem/.test(onFs.out), onFs.out);
  const written = filesUnder(fsRoot).filter((f) => f.endsWith("/identity.json"));
  check(
    "…and writes the roster entry into A's own tree only",
    written.length === 1 && written[0].split(path.sep).includes(A) && JSON.parse(readFileSync(path.join(fsRoot, written[0]), "utf8")).email === EMAIL,
    written,
  );
  check("with the default driver and no token, the advisory line is still there", /BLOB_READ_WRITE_TOKEN/.test(first.out), first.out);
} catch (error) {
  failures++;
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await admin`DELETE FROM memories WHERE key = ${KEY}`.catch(() => undefined);
  for (const [t, qual] of saved) {
    // Put each policy back exactly as it was found: the other isolation checks expect the permissive shape.
    await admin.unsafe(`ALTER POLICY org_isolation ON "${t}" USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await admin.end();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\ntest-onboard-self-db: all ${passed} assertions passed against a fail-closed Postgres`
    : `\ntest-onboard-self-db: ${failures} FAILED, ${passed} passed`,
);
process.exit(failures === 0 ? 0 : 1);
