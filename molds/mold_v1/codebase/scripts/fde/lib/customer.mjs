// Customer + data-room helpers for the customer-facing FDE scripts
// (new-customer, backfill-*). Kept separate from lib/fde.mjs so the lightweight
// onboard-self path doesn't pull in the db/blob layer.
import { readFileSync, existsSync } from "node:fs";
import { getDb, closeDb, withOrgDb } from "../../../agent/lib/db/index.ts";
import { customers } from "../../../agent/lib/db/schema.ts";
import { and, eq } from "drizzle-orm";
import { createDataroomStore } from "../../../agent/lib/dataroom-store.ts";
import { DEPLOYMENT_PROFILE } from "../../../lib/deployment-profile.generated.ts";
import { flag } from "./fde.mjs";

export { getDb, closeDb, withOrgDb };

/**
 * The workspace a customer-facing script acts in: `--org <org_id>`, else FDE_ORG. Required: a company is keyed by
 * (org_id, customer_id) and two workspaces may hold the same id (mold_v1-118), so the workspace is never taken from
 * the id. Without one this throws, and says nothing about which workspaces hold the id: workspaces are not aware of
 * each other.
 */
export function workspaceFor() {
  const org = (flag("org") || process.env.FDE_ORG || "").trim();
  if (org) return org;
  throw new Error("--org <workspace id> (or FDE_ORG) is required: a company id names a company only within a workspace.");
}

/** Display name → data-room / DB slug: lowercase-kebab, ascii-only. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * The live blob data room of ONE workspace (dataroom/orgs/<org>/…). There is no shared or default tree: a missing
 * workspace throws (lib/dataroom-keyspace.ts), so version-scoped trees such as Platform/{ver} are each workspace's
 * own too — pass `workspaceFor()`. Throws if BLOB_READ_WRITE_TOKEN points nowhere real.
 */
export function dataroom(orgId) {
  const store = createDataroomStore({ orgId });
  if (store.backend?.kind !== "vercel-blob") {
    throw new Error(
      "Data-room writes need BLOB_READ_WRITE_TOKEN set to the production blob store (got: " +
        (store.backend?.kind ?? "none") +
        ").",
    );
  }
  return store;
}

/** Read a workspace's customer row by id, or null: by the company's whole key, inside the workspace's scope. */
export async function getCustomer(db, orgId, customerId) {
  void db;
  const rows = await withOrgDb(orgId, (tx) =>
    tx.select().from(customers).where(and(eq(customers.orgId, orgId), eq(customers.customerId, customerId))).limit(1),
  );
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

/**
 * The fields of `row` a record schema refuses, as one sentence naming each field and what it accepts; null when the
 * row is valid. Only the fields present are checked (a row that already exists needs only what changes).
 */
export function checkValues(schema, row) {
  const errors = [];
  for (const [key, value] of Object.entries(row)) {
    const field = schema.shape[key];
    if (!field) { errors.push(`${key} is not a field of this record`); continue; }
    const r = field.safeParse(value);
    if (r.success) continue;
    const options = field.unwrap?.().options ?? field.options;
    errors.push(`${key} "${value}" is not accepted${Array.isArray(options) ? ` (one of: ${options.join(", ")})` : `: ${r.error.issues[0]?.message ?? "invalid"}`}`);
  }
  return errors.length ? `${errors.join("; ")}.` : null;
}

/** The value the deployment profile fixes for a deployments field (a research desk fixes region and environment). */
export function fixedOr(field, fallback) {
  const fixed = DEPLOYMENT_PROFILE.domains?.deployments?.fields?.[field]?.fixed;
  return typeof fixed === "string" ? fixed : fallback;
}
