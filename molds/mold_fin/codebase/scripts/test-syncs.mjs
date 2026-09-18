// End-to-end test for agent/lib/syncs.ts (the `{domain}/syncs/**` ingestion
// facade) against the LOCAL .dataroom/ backend, with NO DATABASE_URL and NO
// external credentials — so the local dataroom backend and the JSON-fallback
// system of record are both forced, and every "no creds" adapter path is real.
//
// Run via: npm run test:syncs  (node --experimental-strip-types)
//
// The orchestrator (no args) wipes a scratch root under .dataroom/ and runs two
// SEPARATE child processes so append durability across process exits is real:
//   --phase ingest   drives the manual_entry ingestion path end-to-end (2 items
//                    landed + 2 normalized interactions) and asserts every
//                    graceful-degradation path (granola/email with no creds,
//                    unknown source, Solutions misuse, empty items) is a
//                    structured skip that never throws.
//   --phase verify   fresh process: proves the landed raw records + mirrored
//                    interactions survived the ingest process exit, that
//                    list() sees exactly the landing file, and that a second
//                    ingest APPENDS (4 raw records) rather than clobbering.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// agent/lib/syncs.ts (E1) uses eve's `#lib/*.js` subpath imports, but Node's
// type-stripping doesn't rewrite a `.js` specifier to its sibling `.ts` file.
// Register a resolve hook that retries `.js` → `.ts` on resolution failure, then
// load the modules dynamically (after the hook is active).
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
         try { return await next(specifier, context); }
         catch (err) {
           if (specifier.endsWith(".js")) return await next(specifier.slice(0, -3) + ".ts", context);
           throw err;
         }
       }`,
    ),
  import.meta.url,
);

const { ingestSource, rawSyncRecordSchema } = await import("../agent/lib/syncs.ts");
const { createLocalDataroomStore } = await import("../agent/lib/dataroom-store.ts");

const SELF = fileURLToPath(import.meta.url);
const TODAY = new Date().toISOString().slice(0, 10);
const LANDING_PATH = `Customers/syncs/manual_entry/acme-bank/${TODAY}.jsonl`;
const INTERACTIONS_PATH = "Customers/acme-bank/interactions.jsonl";

// The two manual_entry items driven end-to-end (dm.md JSON-fallback seed
// customer id `acme-bank` exists in data/customers.json).
const ITEMS = [
  { note: "Kickoff recap", date: "2026-07-09" },
  { note: "Sent SOW", type: "email" },
];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function makeStore() {
  const root = process.env.DATAROOM_TEST_DIR;
  assert(root, "phase processes need DATAROOM_TEST_DIR");
  const store = createLocalDataroomStore(root);
  assert(store.backend.kind === "local", "test must run against the local backend");
  return store;
}

async function phaseIngest() {
  // Guard: the env the orchestrator set up must really be creds-free, so the
  // "no creds" skips below are genuine, not accidental.
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "BLOB_READ_WRITE_TOKEN", "GRANOLA_API_KEY", "IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"]) {
    assert(!process.env[key], `${key} must be unset for the offline ingest phase`);
  }

  // --- happy path: manual_entry lands 2 raw records + normalizes 2 interactions ---
  const res = await ingestSource({
    domain: "Customers",
    customerId: "acme-bank",
    source: "manual_entry",
    items: ITEMS,
  });
  assert(res.ok === true, `manual_entry ingest should succeed (reason: ${res.reason})`);
  assert(res.landed === 2, `manual_entry should land 2 raw records, got ${res.landed}`);
  assert(res.normalized === 2, `manual_entry should normalize 2 interactions, got ${res.normalized}`);
  assert(res.skipped === 0, "manual_entry should skip nothing");
  assert(
    res.landingPath === LANDING_PATH,
    `landingPath should be ${LANDING_PATH}, got ${res.landingPath}`,
  );

  // --- graceful degradation: no external creds → structured skip, never throws ---
  const granola = await ingestSource({ domain: "Customers", customerId: "acme-bank", source: "granola" });
  assert(granola.ok === false, "granola with no key must be a structured skip");
  assert(granola.landed === 0, "granola with no key lands nothing");
  assert(typeof granola.reason === "string" && granola.reason.length > 0, "granola skip carries a reason");
  assert(granola.landingPath === null, "granola skip has no landing path");

  const email = await ingestSource({ domain: "Customers", customerId: "acme-bank", source: "email" });
  assert(email.ok === false, "email with no IMAP must be a structured skip");
  assert(email.landed === 0, "email with no IMAP lands nothing");
  assert(typeof email.reason === "string" && email.reason.length > 0, "email skip carries a reason (EmailNotConfiguredError caught)");

  // --- unknown source → structured skip ---
  const unknown = await ingestSource({ domain: "Customers", customerId: "acme-bank", source: "carrier-pigeon" });
  assert(unknown.ok === false && unknown.landed === 0, "unknown source is a structured skip");
  assert(/not a dm\.md syncs source/.test(unknown.reason ?? ""), "unknown-source reason names the misuse");

  // --- Solutions has NO syncs subtree → rejected up front ---
  const solutions = await ingestSource({ domain: "Solutions", customerId: "acme-bank", source: "manual_entry", items: ITEMS });
  assert(solutions.ok === false && solutions.landed === 0, "Solutions domain has no syncs subtree → skip");
  assert(/no dm\.md syncs subtree/.test(solutions.reason ?? ""), "Solutions reason names the missing subtree");

  // --- manual_entry with no items → lands nothing (offline, zero external calls) ---
  const empty = await ingestSource({ domain: "Customers", customerId: "acme-bank", source: "manual_entry" });
  assert(empty.ok === false && empty.landed === 0, "manual_entry with no items lands nothing");
  assert(/requires items/.test(empty.reason ?? ""), "empty manual_entry reason asks for items[]");

  console.log("ingest ok (2 landed + 2 normalized; granola/email/unknown/Solutions/empty all skipped, none threw)");
}

async function phaseVerify() {
  const store = makeStore();

  // --- raw landing survived the ingest process exit ---
  const raw = await store.readJsonl(LANDING_PATH);
  assert(raw.length === 2, `landing stream should have 2 raw records, got ${raw.length}`);
  for (const rec of raw) {
    const parsed = rawSyncRecordSchema.parse(rec); // parses under the raw envelope
    assert(parsed.source === "manual_entry", "raw record source is manual_entry");
    assert(parsed.domain === "Customers", "raw record domain is Customers");
    assert(parsed.customerId === "acme-bank", "raw record customerId round-trips");
    assert(typeof parsed.syncId === "string" && parsed.syncId.startsWith("SYNC-"), "raw record carries a SYNC- id");
  }
  assert(raw[0].payload.note === "Kickoff recap", "payload.note round-trips verbatim (record 1)");
  assert(raw[1].payload.note === "Sent SOW", "payload.note round-trips verbatim (record 2)");

  // --- normalization mirror survived (cross-process-visible face of the SoR) ---
  const interactions = await store.readJsonl(INTERACTIONS_PATH);
  assert(interactions.length === 2, `interactions mirror should have 2 records, got ${interactions.length}`);
  for (const it of interactions) {
    assert(it.sourceSystem === "manual", "mirrored interaction has sourceSystem 'manual'");
    assert(typeof it.interactionId === "string" && it.interactionId.length > 0, "mirrored interaction has an id");
  }

  // --- list() sees exactly the one landing file under Customers/syncs ---
  const listed = await store.list("Customers/syncs");
  assert(listed.length === 1 && listed[0] === LANDING_PATH, `Customers/syncs should list only ${LANDING_PATH}, got ${JSON.stringify(listed)}`);

  // --- a second ingest APPENDS rather than clobbers (durable O_APPEND) ---
  const again = await ingestSource({
    domain: "Customers",
    customerId: "acme-bank",
    source: "manual_entry",
    items: ITEMS,
  });
  assert(again.ok === true && again.landed === 2, "second ingest lands 2 more raw records");
  const rawAfter = await store.readJsonl(LANDING_PATH);
  assert(rawAfter.length === 4, `landing stream should accumulate to 4 raw records, got ${rawAfter.length}`);

  console.log("verify ok (raw + normalized durable across process exit; second ingest appended to 4)");
}

const PHASES = { ingest: phaseIngest, verify: phaseVerify };

const phaseIndex = process.argv.indexOf("--phase");
if (phaseIndex !== -1) {
  const phase = PHASES[process.argv[phaseIndex + 1]];
  assert(phase, `unknown phase: ${process.argv[phaseIndex + 1]}`);
  await phase();
} else {
  // Orchestrator: fresh scratch root inside the gitignored .dataroom/ dir.
  const root = path.join(process.cwd(), ".dataroom", "__syncs_selftest__");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true }); // children run with cwd:<scratch>

  // Force the local dataroom backend AND the JSON-fallback SoR, and make every
  // "no creds" adapter path real, by scrubbing all relevant env for the children.
  const env = { ...process.env, DATAROOM_DIR: root, DATAROOM_TEST_DIR: root };
  for (const key of [
    "BLOB_READ_WRITE_TOKEN",
    "DATABASE_URL",
    "POSTGRES_URL",
    "GRANOLA_API_KEY",
    "IMAP_HOST",
    "IMAP_USER",
    "IMAP_PASSWORD",
  ]) {
    delete env[key];
  }

  for (const phase of ["ingest", "verify"]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SELF, "--phase", phase],
      { stdio: "inherit", env, cwd: root },
    );
    if (result.status !== 0) {
      console.error(`phase "${phase}" failed (exit ${result.status})`);
      process.exit(result.status ?? 1);
    }
  }
  console.log("syncs ingestion round-trip ok (local backend, JSON-fallback SoR, 2 separate processes)");
}
