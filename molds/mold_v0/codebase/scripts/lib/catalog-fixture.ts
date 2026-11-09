// The data fixture (mold_v0-059, 066): scripts/fixtures/packs/fixture_catalog installed for a test, and a workspace's
// files. Import after ./test-world.js (it sets the environment the shell's modules read).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TMP } from "./test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_catalog");
export const fixtureJson = () => JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8"));

let n = 0;
/**
 * The fixture as gen-packs would register it: its pack.json's declarations (compiled), and its code entry (the loader)
 * from a copy whose import names this codebase's pack API. `edit` changes the pack.json first (a map, an API address).
 */
export async function catalogPack(edit?: (j: any) => void) {
  const json = fixtureJson();
  edit?.(json);
  const dir = path.join(TMP, `catalog-pack-${++n}`, "fixture_catalog");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "pack.json"), JSON.stringify(json, null, 2));
  const api = path.relative(dir, path.join(ROOT, "src", "pack-api.js")).split(path.sep).join("/");
  writeFileSync(path.join(dir, "index.ts"), readFileSync(path.join(FIXTURE, "index.ts"), "utf8").replace("../../src/pack-api.js", api));
  const { compileDeclarations } = await import("../../src/pack-manifest.js");
  const definition = (await import(path.join(dir, "index.ts"))).default;
  return { manifest: { id: json.id, name: json.name, version: json.version, entry: "index.ts", migrations: null, words: {}, dir }, declared: compileDeclarations(json), definition, json };
}
/** The fixture pack copied into a packs directory for gen-packs (its import rewritten to this codebase's pack API). */
export function catalogPackDir(into: string) {
  const dir = path.join(into, "fixture_catalog");
  cpSync(FIXTURE, dir, { recursive: true });
  const api = path.relative(dir, path.join(ROOT, "src", "pack-api.js")).split(path.sep).join("/");
  writeFileSync(path.join(dir, "index.ts"), readFileSync(path.join(FIXTURE, "index.ts"), "utf8").replace("../../src/pack-api.js", api));
  return dir;
}

/**
 * A workspace's files in the shape the fixture's (and the second app's) workspace repositories read: a company's
 * append-only control ledger and its application folders. `variant` changes the values, so two workspaces differ.
 */
export function workspaceFiles(company: string, variant: string, extra: Record<string, string> = {}) {
  const line = (x: unknown) => JSON.stringify(x);
  const files: Record<string, string> = {
    [`company-profile/${company}/soc/main.jsonl`]: [
      line({ kind: "control", id: "alpha-rules-2024:7(2)(b)", companyId: company, title: `Patch policy ${variant}`, implementationStatus: "not-implemented", effectiveness: "ineffective", recordedAt: "2026-10-01T10:00:00Z" }),
      line({ kind: "finding", id: "F-1", companyId: company, controlIds: ["alpha-rules-2024:7(2)(b)"], status: "open" }),
      line({ kind: "control", id: "alpha-rules-2024:34(vii)", companyId: company, title: "Access reviews", implementationStatus: "implemented", effectiveness: "effective", owner: { type: "team" }, nextDueAt: "2026-12-01" }),
      // The same control again: append-only, so this later line is its state.
      line({ kind: "control", id: "alpha-rules-2024:7(2)(b)", companyId: company, title: `Patch policy ${variant}`, implementationStatus: "implemented", effectiveness: "partially-effective", recordedAt: "2026-10-15T10:00:00Z" }),
      "",
    ].join("\n"),
    "applications/web-portal/README.md": `# Web portal ${variant}\n\nThe customer-facing portal.\n`,
    "applications/web-portal/env/prod.json": JSON.stringify({ envId: "prod", tier: "production", dbPassword: "ENC[AES256_GCM,data:abc,tag:x]", note: `prod-${variant}` }),
    "applications/web-portal/env/staging.json": JSON.stringify({ envId: "staging", tier: "staging" }),
    "applications/web-portal/repos/main.json": JSON.stringify({ repoId: "main", url: "https://git.example.org/portal" }),
    "applications/web-portal/credentials.json": JSON.stringify({ entries: [{ key: "DB_PASSWORD", ref: `vault://secret/${variant}/db-password` }] }),
    "applications/web-portal/repos/main/checkout/notes.json": JSON.stringify({ not: "a repo file of its own" }),
    ...extra,
  };
  return Object.entries(files).map(([p, body]) => ({ path: p, body }));
}
