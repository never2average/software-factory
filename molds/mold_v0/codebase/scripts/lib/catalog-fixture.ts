// The data fixture (mold_v0-059, 066): scripts/fixtures/packs/fixture_catalog installed for a test, a local git
// repository standing in for an upstream catalog (never the network), and a workspace's files. Import after
// ./test-world.js (it sets the environment the shell's modules read).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TMP } from "./test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_catalog");
export const fixtureJson = () => JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8"));

let n = 0;
/**
 * The fixture as gen-packs would register it: its pack.json's declarations (compiled), and its code entry (the loader)
 * from a copy whose import names this codebase's pack API. `edit` changes the pack.json first (a pin, a map).
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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=fixture@example.org", "-c", "user.name=fixture", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const put = (root: string, rel: string, v: unknown) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2)); };

/** One catalog of controls, in groups (the shape the fixture's loader reads). */
const catalog = (kind: string, instrumentId: string, regulator: string, controls: { id: string; prose?: string; mandatory?: boolean }[]) => ({
  kind, instrumentId, regulator,
  groups: [{ id: "G1", title: "First group", controls: controls.map((c) => ({ id: c.id, title: `Control ${c.id}`, prose: c.prose ?? `Requirement ${c.id}`, mandatory: c.mandatory ?? true, defaultSeverity: "high" })) }],
});

/**
 * A git repository holding an upstream catalog laid out by a repository's `files` settings (regulators, instruments,
 * catalogs_dir) and kinds, in three commits:
 *   c1  regulators alpha, beta; instruments alpha-rules-2024 (3 controls: 7(2)(b), 34(vii), PR.MA.S3), beta-code-2023
 *       (12 controls), alpha-old (no catalog): 5 sources, 15 controls
 *   c2  7(2)(b)'s requirement changed, 7(3) added
 *   c3  beta-code-2023 cut to 2 controls (10 of 16 controls gone)
 * The branch is left at c3: a pin to c1 must still read c1.
 */
export function catalogRepo(settings: { files: Record<string, string>; catalog_kind: string; instruments_kind: string }) {
  const root = path.join(TMP, `upstream-${++n}`);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  const f = settings.files;
  const cat = (id: string) => `${f.catalogs_dir}/${id}.catalog.json`;
  const beta = Array.from({ length: 12 }, (_, i) => ({ id: `B.${i + 1}` }));
  const write = (alpha: { id: string; prose?: string }[], betaControls: { id: string }[]) => {
    put(root, f.regulators!, { $schema: "https://json-schema.org/draft/2020-12/schema", enum: ["alpha", "beta"] });
    put(root, f.instruments!, { kind: settings.instruments_kind, instruments: [
      { instrumentId: "alpha-rules-2024", regulator: "alpha", shortName: "Alpha rules", status: "in-force", catalogFile: cat("alpha-rules-2024") },
      { instrumentId: "beta-code-2023", regulator: "beta", shortName: "Beta code", status: "in-force", catalogFile: cat("beta-code-2023") },
      { instrumentId: "alpha-old", regulator: "alpha", shortName: "Old alpha rules", status: "repealed" },
    ] });
    put(root, cat("alpha-rules-2024"), catalog(settings.catalog_kind, "alpha-rules-2024", "alpha", alpha));
    put(root, cat("beta-code-2023"), catalog(settings.catalog_kind, "beta-code-2023", "beta", betaControls));
    git(root, "add", "-A");
  };
  write([{ id: "7(2)(b)" }, { id: "34(vii)" }, { id: "PR.MA.S3" }], beta);
  git(root, "commit", "-q", "-m", "c1");
  const c1 = git(root, "rev-parse", "HEAD");
  write([{ id: "7(2)(b)", prose: "Changed requirement" }, { id: "34(vii)" }, { id: "PR.MA.S3" }, { id: "7(3)" }], beta);
  git(root, "commit", "-q", "-m", "c2");
  const c2 = git(root, "rev-parse", "HEAD");
  write([{ id: "7(2)(b)", prose: "Changed requirement" }, { id: "34(vii)" }, { id: "PR.MA.S3" }, { id: "7(3)" }], beta.slice(0, 2));
  git(root, "commit", "-q", "-m", "c3");
  const c3 = git(root, "rev-parse", "HEAD");
  return { root, url: `file://${root}`, c1, c2, c3 };
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
