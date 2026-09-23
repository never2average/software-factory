/**
 * Seed the in-memory system of record for the fallback-path tests.
 *
 * Why this exists: test:render, test:sor and test:workbook-spec assert against
 * a customer called `acme-bank` that used to live in data/customers.json.
 * Commit c7b929c ("remove hardcoded dummy data") emptied that file — correctly,
 * it is shipped product data and should not carry fake customers — but the
 * tests kept asserting against it. They failed from 15 Jul until CI surfaced
 * them, because nothing ran them.
 *
 * The fix is not to put the dummy data back. Tests own their fixtures: this
 * loads the recovered seed from scripts/fixtures/customers.fixture.json and
 * upserts it into the in-memory store.
 *
 * IMPORTANT — must be called BEFORE importing anything that reads the store,
 * and it moves the process to a temp directory first. `writeStore()`
 * best-effort persists to `<cwd>/data/customers.json`, so seeding from the repo
 * root would write the fixture straight into the tracked file this whole
 * problem came from. From a temp cwd that write lands somewhere harmless (or
 * fails silently, which is the documented behaviour on read-only filesystems),
 * and the in-memory copy — the thing under test — is correct either way.
 */
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "customers.fixture.json");
const PEOPLE_FIXTURE = join(here, "..", "fixtures", "people.fixture.json");

/**
 * @returns {Promise<string[]>} the customer ids seeded, so a caller can assert
 *   the fixture actually landed rather than assuming it did.
 */
export async function seedFixtureStore() {
  /**
   * The people seed is a static import with no upsert path, so it is injected
   * by env instead (see workbook-spec.ts). ABSOLUTE path deliberately: the
   * chdir below moves the process off the repo root, and a relative fixture
   * path would resolve into the temp directory and fail to open.
   *
   * Set before the chdir and before any module that reads it is imported —
   * workbook-spec resolves this once, at load.
   */
  process.env.WORKSPACE_PEOPLE_SEED ??= PEOPLE_FIXTURE;

  // Keep every write out of the repo. Do this before the store module loads.
  process.chdir(mkdtempSync(join(tmpdir(), "fde-fixture-")));

  const { customers } = JSON.parse(await readFile(FIXTURE, "utf8"));
  const { upsertCustomer } = await import("../../agent/lib/system-of-record.ts");

  const seeded = [];
  for (const customer of customers) {
    await upsertCustomer(customer);
    seeded.push(customer.id);
  }
  if (seeded.length === 0) {
    throw new Error(`${FIXTURE} contains no customers — the fixture is empty`);
  }
  return seeded;
}
