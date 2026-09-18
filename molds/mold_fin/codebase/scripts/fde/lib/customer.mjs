// Customer + data-room helpers for the customer-facing FDE scripts
// (new-customer, backfill-*). Kept separate from lib/fde.mjs so the lightweight
// onboard-self path doesn't pull in the db/blob layer.
import { readFileSync, existsSync } from "node:fs";
import { getDb, closeDb } from "../../../agent/lib/db/index.ts";
import { customers } from "../../../agent/lib/db/schema.ts";
import { eq } from "drizzle-orm";
import { createDataroomStore } from "../../../agent/lib/dataroom-store.ts";

export { getDb, closeDb };

/** Display name → data-room / DB slug: lowercase-kebab, ascii-only. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The live blob data room. Throws if BLOB_READ_WRITE_TOKEN points nowhere real. */
export function dataroom() {
  const store = createDataroomStore();
  if (store.backend?.kind !== "vercel-blob") {
    throw new Error(
      "Data-room writes need BLOB_READ_WRITE_TOKEN set to the production blob store (got: " +
        (store.backend?.kind ?? "none") +
        ").",
    );
  }
  return store;
}

/** Read a customer row by id, or null. */
export async function getCustomer(db, customerId) {
  const rows = await db.select().from(customers).where(eq(customers.customerId, customerId)).limit(1);
  return rows[0] ?? null;
}

/** `--from-file x.json` bulk input, parsed, or null when the flag is absent. */
export function readFromFile() {
  const i = process.argv.indexOf("--from-file");
  const path = i !== -1 ? process.argv[i + 1] : "";
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`--from-file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** ISO date-time stamp — passed in from the caller so scripts stay pure-ish. */
export function nowIso() {
  return new Date().toISOString();
}

/** Append one JSON event to a customer's timeline-style .jsonl in the data room. */
export async function appendInteraction(store, path, event) {
  await store.appendJsonl(path, [event]);
}

/** Write only when the path is absent (never clobber authored content). Returns true if written. */
export async function writeIfAbsent(store, existing, path, content) {
  if (existing.includes(path)) return false;
  await store.write(path, content.endsWith("\n") ? content : content + "\n");
  return true;
}

/** A minimal, valid JSON-Schema stub the FDE fills in. */
export function schemaStub(title) {
  return (
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title,
        type: "object",
        properties: {},
        required: [],
        "x-status": "TODO",
      },
      null,
      2,
    ) + "\n"
  );
}
