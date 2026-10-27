// Engine packs and their config packs (mold_v0-145): a host pack whose code and migrations carry no product's words
// (an engine), run by an app through a config pack of its own (a pack.json alone whose engine.pack names the engine).
// Offline: throwaway build copies for what gen-packs writes and refuses.
//   npm run test:engine-packs
//
// 1. Folding: an engine pack and its config pack build exactly what one host pack saying all of it builds: every
//    generated file byte for byte the same (the registry, the profile, the host entries and their engine.config, the
//    server's config, the console's sidebar, routes, guides and build facts), the build has one pack under the engine's
//    id with the config pack's name, version and description, and the only difference is the migrations' earlier id
//    (engine.migrations_recorded_as, written as `formerly` beside the engine's migration directory).
// 2. Refused, each naming the pack and what to do: a config pack whose engine is not a host pack of the build, two
//    config packs for one engine, an engine pack that says a product's words when a config pack configures it (a
//    declaration, host.profile, host.schema.labels), a config pack with code or another file, a label of a table the
//    engine does not have, an earlier id that is the engine's own or another pack's with migrations, and the config
//    pack's keys in a pack that names no engine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "engine-packs-"));
let n = 0;

/** A throwaway copy of this codebase (its node_modules linked) with these packs, console files and profile; gen-packs run in it. */
function world(packs: Record<string, Record<string, string>>, profile: Record<string, unknown>, web: Record<string, string> = {}) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, files] of Object.entries(packs)) for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, "packs", id, f)), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, f), text);
  }
  for (const [f, text] of Object.entries(web)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, status: gen.status, out: `${gen.stdout}\n${gen.stderr}` };
}
/** Every generated file of a copy (src, web/src, orchestrator), by path. */
function generated(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(path.join(dir, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); }
      else if (/\.generated\.(ts|json)$/.test(e.name)) out.set(rel.split(path.sep).join("/"), readFileSync(path.join(dir, rel), "utf8"));
    }
  };
  for (const d of ["src", "web/src", "orchestrator"]) walk(d);
  return out;
}

// The engine: a host entry, its migration (a table of its own under a plain name, secured by its own policy) and schema.
const W = "CREATE TABLE IF NOT EXISTS widgets (id SERIAL PRIMARY KEY, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE, name TEXT);\n";
const SEC = "DO $mig$\nDECLARE r TEXT := app_tenant_role();\nBEGIN\n  ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;\n" +
  "  EXECUTE format('CREATE POLICY tenant_isolation ON widgets TO %I USING (org_id = app_tenant_org())', r);\n" +
  "  EXECUTE format('GRANT SELECT ON widgets TO %I', r);\nEND $mig$;\n";
const HOST_TS = `import { defineHost } from "../../src/pack-host.js";\nexport default defineHost({ id: "motor" });\n`;
const CODE = { entry: "host.ts", scripts: "scripts", schema: { tables: ["widgets"] } };
const engineFiles = { "host.ts": HOST_TS, "migrations/0001_widgets.sql": W + SEC, "scripts/hello.ts": "console.log('hello');\n" };
const engine = (extra: Record<string, unknown> = {}, host: Record<string, unknown> = CODE) => ({
  "pack.json": JSON.stringify({ id: "motor", name: "Motor engine", version: "1.0.0", description: "An engine with no product's words.", migrations: "migrations", host, ...extra }),
  ...engineFiles,
});
const WEB = {
  "web/src/packs/motor/index.ts": "export default { id: 'motor', app: {}, admin: {} };\n",
  "web/src/packs/motor/routes.json": JSON.stringify({ app: ["alpha"], admin: ["beta"] }),
};
const PROFILE = { name: "Brand", mcp_server_name: "brand", console_title: "Brand", sign_up_subtitle: "Brand things well", words: { run: "trial" } };
const LABELS = { widgets: "Brand widgets" };
const CONFIG = { greeting: "Hello from Brand", tools: { ping: { title: "Ping Brand" } } };
// What the product says, in the order a host pack's pack.json says it.
const DECLS = {
  mcp: { instructions: "Use Brand to manage widgets.", error_hints: [{ match: "budget", text: "Raise Brand's budget." }] },
  console: { nav: { app: [{ label: "Brand", before: "Operational", items: [{ title: "Alpha", url: "/app/alpha", icon: "trendingUp" }] }], admin: [{ into: "Operations", items: [{ title: "Beta", url: "/admin/beta", icon: "code" }] }] },
    redirects: [{ source: "/app/old-alpha", destination: "/app/alpha", permanent: true }] },
  settings: { groups: [{ id: "brand", label: "Brand", after: "runs" }], defs: [{ key: "BRAND_MODE", group: "brand", label: "Mode", kind: "choice", default: "on", options: ["on", "off"], help: "On or off." }] },
  texts: { "usage.score": "Brand points" },
};
const NAMES = { id: "brand", name: "Brand", version: "3.1.0", description: "Brand: widgets, measured." };
const configPack = (engineDecl: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, files: Record<string, string> = {}) => ({
  "pack.json": JSON.stringify({ ...NAMES, mcp: DECLS.mcp,
    engine: { pack: "motor", migrations_recorded_as: "brand", profile: PROFILE, labels: LABELS, config: CONFIG, ...engineDecl },
    console: DECLS.console, settings: DECLS.settings, texts: DECLS.texts, ...extra }),
  ...files,
});
const HOSTS = { host_packs: ["motor"] };

try {
  // ---------- 1. folding ----------
  const split = world({ motor: engine(), brand: configPack() }, HOSTS, WEB);
  assert.equal(split.status, 0, split.out);
  // The same product as one host pack saying all of it, its keys where the folded pack has them.
  const one = world({ motor: { "pack.json": JSON.stringify({ id: "motor", name: NAMES.name, version: NAMES.version, description: NAMES.description, migrations: "migrations",
    host: { ...CODE, profile: PROFILE, schema: { ...CODE.schema, labels: LABELS } }, mcp: DECLS.mcp, engine: { config: CONFIG }, console: DECLS.console, settings: DECLS.settings, texts: DECLS.texts }), ...engineFiles } }, HOSTS, WEB);
  assert.equal(one.status, 0, one.out);
  const a = generated(split.dir), b = generated(one.dir);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "the same generated files");
  const differ = [...a.keys()].filter((f) => a.get(f) !== b.get(f));
  assert.deepEqual(differ, ["src/pack-migrations.generated.ts"], `only the migrations' earlier id differs: ${differ.join(", ")}`);
  const dirsOf = (text: string) => JSON.parse(/PACK_MIGRATION_DIRS[^=]*= (\[[\s\S]*?\]);\n/.exec(text)![1]!);
  const dirsSplit = dirsOf(a.get("src/pack-migrations.generated.ts")!), dirsOne = dirsOf(b.get("src/pack-migrations.generated.ts")!);
  assert.deepEqual(dirsSplit, [{ ...dirsOne[0], formerly: ["brand"] }], "the engine's migrations, recorded under the config pack's id before: formerly");
  assert.equal(dirsOne[0].formerly, undefined, "a host pack of its own has no earlier id");
  const packsFile = a.get("src/packs.generated.ts")!;
  assert.match(packsFile, /manifest: \{"id":"motor","name":"Brand","version":"3\.1\.0","entry":null,"migrations":"migrations","words":\{\},"dir":"packs\/motor"\}/, "one pack, the engine's id, the config pack's name and version");
  assert.doesNotMatch(packsFile, /"id":"brand"/, "the config pack is not a pack of its own in the build");
  assert.match(a.get("src/hosts.generated.ts")!, /HOST_ENGINE_CONFIG[^=]*= \{\n  "motor": \{\n    "greeting": "Hello from Brand"/, "the config pack's engine.config is the engine's");
  assert.match(a.get("src/profile.generated.ts")!, /"name": "Brand"/, "its engine.profile is the build's profile");
  assert.match(a.get("src/pack-migrations.generated.ts")!, /HOST_TABLE_LABELS[^=]*= \{\n  "widgets": "Brand widgets"\n\}/, "its engine.labels are the tables' labels");
  // A build with the engine and no config pack: the engine's own, with no product's words (its server refuses to start
  // without engine.config when its host entry reads one: src/host.ts registerHosts).
  const bare = world({ motor: engine() }, HOSTS, WEB);
  assert.equal(bare.status, 0, bare.out);
  assert.match(generated(bare.dir).get("src/packs.generated.ts")!, /"id":"motor","name":"Motor engine"/);
  console.log("✓ an engine pack and its config pack build what one host pack saying all of it builds (every generated file identical but the migrations' earlier id); one pack under the engine's id, the config pack's names, config, profile and labels");

  // ---------- 2. refusals ----------
  const refused = (what: string, packs: Record<string, Record<string, string>>, re: RegExp, profile: Record<string, unknown> = HOSTS) => {
    const r = world(packs, profile, WEB);
    assert.equal(r.status, 1, `${what}: refused (${r.out.slice(-600)})`);
    assert.match(r.out, re, `${what}: refused with ${re}\n${r.out.slice(-800)}`);
  };
  refused("a config pack whose engine is not in the build", { brand: configPack() }, /packs\/brand\/pack\.json: engine\.pack: motor is not a host pack of this build \(the app names its engine pack too/, {});
  refused("a config pack whose engine is not a host pack", { motor: { "pack.json": JSON.stringify({ id: "motor", name: "M", version: "1" }) }, brand: configPack() }, /engine\.pack: motor is not a host pack of this build$/m, {});
  refused("two config packs for one engine", { motor: engine(), brand: configPack(), other: { "pack.json": JSON.stringify({ id: "other", name: "Other", version: "1", engine: { pack: "motor", config: CONFIG } }) } },
    /engine\.pack: motor is configured by brand and other: one config pack per engine/);
  refused("an engine pack that declares a product's words", { motor: engine({ guide: { markdown: "## Hi\nThere." } }), brand: configPack() },
    /packs\/motor\/pack\.json: guide: an engine pack \(configured by brand\) declares nothing of a product's/);
  refused("an engine pack's own engine.config", { motor: engine({ engine: { config: CONFIG } }), brand: configPack() }, /packs\/motor\/pack\.json: engine: an engine pack \(configured by brand\)/);
  refused("an engine pack's own profile", { motor: engine({}, { ...CODE, profile: { name: "Motor" } }), brand: configPack() }, /host\.profile: an engine pack's profile is its config pack's engine\.profile \(brand\)/);
  refused("an engine pack's own table labels", { motor: engine({}, { ...CODE, schema: { ...CODE.schema, labels: LABELS } }), brand: configPack() }, /host\.schema\.labels: an engine pack's table labels are its config pack's engine\.labels \(brand\)/);
  refused("a config pack with a code entry", { motor: engine(), brand: configPack({}, { entry: "index.ts" }, { "index.ts": "export default {};\n" }) }, /engine\.pack: a pack that names its engine is config only/);
  refused("a config pack with migrations", { motor: engine(), brand: configPack({}, { migrations: "migrations" }, { "migrations/0001_x.sql": "SELECT 1;\n" }) }, /engine\.pack: a pack that names its engine is config only/);
  refused("a config pack with another file", { motor: engine(), brand: configPack({}, {}, { "notes.md": "# Notes\n" }) }, /notes\.md: a declarative pack \(no entry, migrations or runner\) is its pack\.json alone/);
  refused("a label of a table the engine does not have", { motor: engine(), brand: configPack({ labels: { gadgets: "Gadgets" } }) }, /engine\.labels\.gadgets: not one of engine motor's tables/);
  refused("the engine's own id as the earlier one", { motor: engine(), brand: configPack({ migrations_recorded_as: "motor" }) }, /engine\.migrations_recorded_as: motor is the engine's own id/);
  refused("another pack's id with migrations of its own", { motor: engine(), brand: configPack({ migrations_recorded_as: "notes" }),
    notes: { "pack.json": JSON.stringify({ id: "notes", name: "Notes", version: "1", migrations: "migrations" }), "migrations/0001_notes.sql": "CREATE TABLE notes_items (id INT, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE);\nSELECT shell_pack_tenant_table('notes_items');\n" } },
    /engine\.migrations_recorded_as: notes is a pack of this build with migrations of its own/);
  refused("an engine of its own", { motor: engine(), brand: configPack({ pack: "brand" }) }, /engine\.pack: the id of the engine pack this pack configures/);
  refused("a config pack's keys in a pack that names no engine", { motor: engine({ engine: { config: CONFIG, profile: PROFILE } }) }, /engine\.profile: only a config pack \(engine\.pack\) says it; a host pack says it in host\.profile/);
  refused("engine.config in a declarative pack that names no engine", { motor: engine(), plain: { "pack.json": JSON.stringify({ id: "plain", name: "Plain", version: "1", engine: { config: CONFIG } }) } },
    /packs\/plain\/pack\.json: engine: only a host pack's own code reads engine\.config/);
  console.log("✓ refused: an engine that is not a host pack of the build, two config packs for one engine, an engine pack's own words (declarations, profile, labels), a config pack with code or other files, a label of a table not the engine's, an earlier id that is the engine's or another pack's with migrations, a config pack's keys elsewhere");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
