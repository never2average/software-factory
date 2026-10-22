// The pack seam (mold_v0-038; molds/mold_v0/MOLD.md "Pack and record-area contract").
//   npm run test:packs                 everything below
//   PACKS_TEST_TYPECHECK=off           skip the two TypeScript checks of the build copy (the slow part)
//
// 1. Zero packs: the generated registry is current and empty, and the shell's surface has no pack in it.
// 2. The build refuses packs that would get past the seam (scripts/gen-packs.mjs): SQL without row-level security, outside
//    the pack's names or writing policies and grants; code importing the shell or leaving the workspace's scope; and
//    the runner boundary (mold_v0-054): run programs under pack.json `runner` may start processes, server code may not
//    and may not import them, runner code reaches no shell module; no symbolic links.
// 3. definePack and the registry refuse bad definitions (an admin change without a permission, a shell tool's name).
// 4. A build copy with the fixture pack (scripts/fixtures/packs/fixture_notes) and a fixture profile: gen-packs there,
//    then scripts/packs-fixture-check.ts there (tool, page and migrated table reachable, RLS, routes, profile), and
//    the copy's own TypeScript checks (the server with the pack, the console with its page and navigation).
// 5. A build copy with the declarative fixture pack (scripts/fixtures/packs/fixture_tracker: a pack.json alone, mold_v0-057):
//    gen-packs there and the copy's TypeScript checks (the registry with no import, the console's typed record areas).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_notes");
const tmp = mkdtempSync(path.join(tmpdir(), "packs-test-"));
const gen = (args: string[], cwd = ROOT) => spawnSync(process.execPath, [path.join(cwd, "scripts", "gen-packs.mjs"), ...args], { cwd, encoding: "utf8" });

try {
  // ---------- 1. zero packs ----------
  {
    const r = gen(["--check"]);
    assert.equal(r.status, 0, `the generated registry is current: ${r.stderr}`);
    assert.match(r.stdout, /0 pack\(s\)/, "this codebase has no packs");
    const { PACKS } = await import("../src/packs.generated.js");
    const { PACK_MIGRATION_DIRS } = await import("../src/pack-migrations.generated.js");
    assert.deepEqual([PACKS.length, PACK_MIGRATION_DIRS.length], [0, 0]);
    const { packRegistry } = await import("../src/packs.js");
    const reg = packRegistry();
    assert.deepEqual([reg.packs, reg.tools, reg.routes], [[], [], []], "no pack tools or routes");
    const { mcpSurface } = await import("./export-mcp-tools.js");
    const surface = await mcpSurface();
    const TOOL_NAMES = (await import("../src/server.js")).ownToolNames(); // the host packs' tools (src/host.ts): none with zero packs
    assert.deepEqual(surface.tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), "with zero packs the MCP server lists exactly the shell's own tools");
    console.log(`✓ zero packs: registry current and empty; the MCP server lists the shell's ${TOOL_NAMES.length} tools only`);
  }

  // ---------- 2. the build refuses what would get past the seam ----------
  {
    const API = path.join(ROOT, "src", "pack-api.js");
    let n = 0;
    /** A one-pack packs directory with these files; returns gen-packs' result on it. */
    const tryPack = (id: string, files: Record<string, string>, manifest: Record<string, unknown> = {}) => {
      const dir = path.join(tmp, `refuse-${++n}`), pdir = path.join(dir, id);
      mkdirSync(pdir, { recursive: true });
      const api = path.relative(pdir, API).split(path.sep).join("/");
      const entry = files["index.ts"] ?? `import { definePack } from "${api}";\nexport default definePack({ id: "${id}" });\n`;
      writeFileSync(path.join(pdir, "pack.json"), JSON.stringify({ id, name: "Test", version: "1", entry: "index.ts", ...(Object.keys(files).some((f) => f.startsWith("migrations/")) ? { migrations: "migrations" } : {}), ...manifest }));
      for (const [f, text] of Object.entries({ ...files, "index.ts": entry.replaceAll("$API", api) })) {
        mkdirSync(path.dirname(path.join(pdir, f)), { recursive: true });
        writeFileSync(path.join(pdir, f), text);
      }
      return gen(["--packs", dir, "--out", path.join(dir, "out")]);
    };
    const refused = (what: string, r: ReturnType<typeof gen>, re: RegExp) => {
      assert.equal(r.status, 1, `${what}: refused (got ${r.status}: ${r.stdout}${r.stderr})`);
      assert.match(r.stderr, re, `${what}: says why`);
    };
    const T = "CREATE TABLE pk_notes (id SERIAL PRIMARY KEY, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE, body TEXT);\n";
    const ok = tryPack("pk", { "migrations/0001_notes.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\n` });
    assert.equal(ok.status, 0, `a good pack passes: ${ok.stderr}`);
    refused("a table without row-level security", tryPack("pk", { "migrations/0001_notes.sql": T }), /pk_notes has no row-level security/);
    refused("a table outside the pack's names", tryPack("pk", { "migrations/0001_x.sql": "CREATE TABLE notes (id INT);\nSELECT shell_pack_private_table('notes');\n" }), /must be named pk_/);
    refused("a workspace table without org_id NOT NULL … CASCADE", tryPack("pk", { "migrations/0001_x.sql": "CREATE TABLE pk_x (id INT, org_id INT REFERENCES organizations (id));\nSELECT shell_pack_tenant_table('pk_x');\n" }), /needs org_id INT NOT NULL/);
    refused("a GRANT", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nGRANT ALL ON pk_notes TO PUBLIC;\n` }), /uses GRANT/);
    refused("a policy of its own", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nCREATE POLICY open ON pk_notes USING (true);\n` }), /policies/);
    refused("a DO block", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nDO $$ BEGIN EXECUTE 'ALTER TABLE pk_notes DISABLE ROW LEVEL SECURITY'; END $$;\n` }), /dollar-quoted/);
    refused("altering a shell table", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nALTER TABLE api_keys ADD COLUMN x INT;\n` }), /alters api_keys/);
    refused("writing a shell table", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nINSERT INTO api_keys (org_id) VALUES (1);\n` }), /writes api_keys/);
    refused("a view", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nCREATE VIEW pk_v AS SELECT * FROM pk_notes;\n` }), /not a statement a pack migration may run/);
    refused("a migration gap", tryPack("pk", { "migrations/0002_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\n` }), /expected version 0001/);
    refused("an id that covers a shell table", tryPack("api", {}), /prefix api_ is taken by the shell's api_keys/);
    refused("importing a shell module", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nimport { getDb } from "${path.relative(path.join(tmp, "x", "pk"), path.join(ROOT, "src", "db.js")).split(path.sep).join("/")}";\nexport default definePack({ id: "pk" });\n` }), /a pack may import its own files and src\/pack-api.ts only/);
    refused("a database driver", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nimport pg from "pg";\nexport default definePack({ id: "pk" });\n` }), /imports pg: not allowed/);
    refused("leaving the workspace's scope", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nconst q = "RESET ROLE";\nexport default definePack({ id: "pk" });\n` }), /SET\/RESET ROLE/);
    refused("asPlatform", tryPack("pk", { "index.ts": `import { definePack } from "$API";\n// asPlatform(() => 1)\nexport default definePack({ id: "pk" });\n` }), /asPlatform/);
    // The review's exploit (mold_v0-038): a comment marker inside a string must not hide a statement from the checks.
    refused("a statement hidden between quoted comment markers", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nCOMMENT ON TABLE pk_notes IS '/*';\nCREATE POLICY leak ON products FOR SELECT USING (org_id = octillion_tenant_org() OR org_id = 1);\nCOMMENT ON TABLE pk_notes IS '*/';\n` }), /policies/);
    refused("a -- marker inside a string", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nINSERT INTO pk_notes (org_id, body) VALUES (1, '--'); GRANT ALL ON products TO PUBLIC;\n` }), /uses GRANT/);
    refused("ALTER TABLE … INHERIT a shell table", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nALTER TABLE pk_notes INHERIT schema_migrations;\n` }), /may only add, drop, alter or rename/);
    refused("an escape string", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nINSERT INTO pk_notes (org_id, body) VALUES (1, E'\\'');\n` }), /escape/);
    refused("a dynamic import built from pieces", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nconst m = await import("../../src/" + "tenant-scope.js");\nexport default definePack({ id: "pk" });\n` }), /dynamic import of anything but one string literal/);
    refused("a module loader", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nconst mod = process.getBuiltinModule("node:module");\nexport default definePack({ id: "pk" });\n` }), /module loader/);
    refused("globalThis", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nconst g = globalThis;\nexport default definePack({ id: "pk" });\n` }), /globalThis/);
    refused("an unknown pack.json field", tryPack("pk", {}, { tables: [] }), /unknown field tables/);
    // The runner boundary (mold_v0-054): a run program under pack.json `runner` may start processes and use the file
    // system; the server code may not, and may not import it; runner code reaches no shell module, pack-api included.
    {
      const R = { runner: "runner" };
      const spawnProg = `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nimport { helper } from "./lib/helper.mjs";\nwriteFileSync("out.txt", String(spawnSync("/bin/true").status) + helper());\n`;
      const okRunner = tryPack("pk", { "runner/run.mjs": spawnProg, "runner/lib/helper.mjs": "export const helper = () => 'x';\n" }, R);
      assert.equal(okRunner.status, 0, `runner code may start processes: ${okRunner.stderr}`);
      refused("the same program outside the runner directory", tryPack("pk", { "tools/run.mjs": spawnProg, "tools/lib/helper.mjs": "export const helper = () => 'x';\n" }, R), /imports node:child_process: not allowed in a pack's server code/);
      refused("child_process in a pack with no runner directory", tryPack("pk", { "run.mjs": `import { spawn } from "node:child_process";\n` }), /imports node:child_process: not allowed/);
      refused("server code importing the runner's", tryPack("pk", { "index.ts": `import { definePack } from "$API";\nimport "./runner/run.mjs";\nexport default definePack({ id: "pk" });\n`, "runner/run.mjs": spawnProg.replace(/import \{ helper[^\n]*\n/, "").replace(" + helper()", "") }, R), /server code may not import the runner's code/);
      refused("runner code importing the server's", tryPack("pk", { "runner/run.mjs": `import x from "../index.ts";\n` }, R), /runner code may import its own runner files and node's built-ins only/);
      refused("runner code importing the pack API", tryPack("pk", { "runner/run.mjs": `import { z } from "../../../src/pack-api.js";\n` }, R), /runner code may import its own runner files/);
      refused("runner code importing a shell module", tryPack("pk", { "runner/run.mjs": `import { getDb } from "${path.relative(path.join(tmp, "x", "pk", "runner"), path.join(ROOT, "src", "db.js")).split(path.sep).join("/")}";\n` }, R), /runner code may import its own runner files/);
      refused("runner code importing a database driver", tryPack("pk", { "runner/run.mjs": `import pg from "pg";\n` }, R), /imports pg: not allowed in runner code/);
      refused("runner code importing a package", tryPack("pk", { "runner/run.mjs": `import { z } from "zod";\n` }, R), /imports zod: not allowed in runner code/);
      refused("asPlatform in runner code", tryPack("pk", { "runner/run.mjs": `// asPlatform\n` }, R), /asPlatform/);
      refused("SET ROLE in runner code", tryPack("pk", { "runner/run.mjs": `import { spawnSync } from "node:child_process";\nspawnSync("psql", ["-c", "SET ROLE postgres"]);\n` }, R), /SET\/RESET ROLE/);
      refused("set_config in runner code", tryPack("pk", { "runner/run.mjs": `const q = "select set_config('x', '1', false)";\n` }, R), /set_config/);
      refused("the tenant setting in runner code", tryPack("pk", { "runner/run.mjs": `const s = "octillion.org_id";\n` }, R), /the tenant setting/);
      refused("createRequire in runner code", tryPack("pk", { "runner/run.mjs": `import { createRequire } from "node:module";\n` }, R), /module loader|imports node:module/);
      refused("a computed import in runner code", tryPack("pk", { "runner/run.mjs": `const m = await import("node:" + "child_process");\n` }, R), /dynamic import of anything but one string literal/);
      refused("TypeScript in the runner directory", tryPack("pk", { "runner/run.ts": `export const x = 1;\n` }, R), /a \.js or \.mjs file/);
      refused("the entry inside the runner directory", tryPack("pk", { "runner/index.ts": "export default 1;\n" }, { runner: "runner", entry: "runner/index.ts" }), /inside the runner directory/);
      refused("a runner directory that is not there", tryPack("pk", {}, R), /runner directory runner does not exist/);
      refused("a runner directory outside the pack", tryPack("pk", { "runner/x.mjs": "" }, { runner: "../elsewhere" }), /runner must be a directory inside the pack/);
      const linked = (() => {
        const dir = path.join(tmp, `refuse-link`), pdir = path.join(dir, "pk");
        mkdirSync(path.join(pdir, "runner"), { recursive: true });
        const api = path.relative(pdir, API).split(path.sep).join("/");
        writeFileSync(path.join(pdir, "pack.json"), JSON.stringify({ id: "pk", name: "Test", version: "1", entry: "index.ts", runner: "runner" }));
        writeFileSync(path.join(pdir, "index.ts"), `import { definePack } from "${api}";\nexport default definePack({ id: "pk" });\n`);
        symlinkSync(path.join(ROOT, "src", "db.ts"), path.join(pdir, "runner", "db.mjs"));
        return gen(["--packs", dir, "--out", path.join(dir, "out")]);
      })();
      refused("a symbolic link in a pack", linked, /a symbolic link/);
      // The review's bypasses of the import scan (mold_v0-054): the import graph is resolved, not read with a pattern.
      const IDX = (extra: string) => `import { definePack } from "$API";\n${extra}\nexport default definePack({ id: "pk" });\n`;
      refused("an import with no spaces", tryPack("pk", { "index.ts": IDX(`import{execSync}from"node:child_process";`) }, R), /imports node:child_process: not allowed in a pack's server code/);
      refused("an import split by a comment", tryPack("pk", { "index.ts": IDX(`import {execSync} from /*"*/ "node:child_process";`) }, R), /imports node:child_process/);
      refused("a re-export of the runner's code", tryPack("pk", { "index.ts": IDX(`export*from"./runner/run.mjs";`), "runner/run.mjs": "export const x = 1;\n" }, R), /server code may not import the runner's code/);
      refused("an extensionless file", tryPack("pk", { "index.ts": IDX(`import "./helper";`), "helper": `import { execSync } from "node:child_process";\n` }, R), /a file a pack may not carry/);
      refused("a dot directory", tryPack("pk", { "index.ts": IDX(`import "./.lib/h.ts";`), ".lib/h.ts": `import{execSync}from"node:child_process";\n` }, R), /\.lib\/h\.ts: imports node:child_process/);
      refused("a node_modules directory", tryPack("pk", { "index.ts": IDX(`import "./node_modules/h.mjs";`), "node_modules/h.mjs": "export {};\n" }, R), /a node_modules directory/);
      refused("runner code reaching the pack API with no spaces", tryPack("pk", { "runner/run.mjs": `import{z}from"${path.relative(path.join(tmp, "x", "pk", "runner"), API).split(path.sep).join("/")}";\n` }, R), /runner code may import its own runner files/);
      refused("node:module from server code", tryPack("pk", { "index.ts": IDX(`import*as m from"node:module";`) }, R), /imports node:module/);
      console.log("✓ the runner boundary: run programs under the runner directory may start processes; server code may not, nor import them; runner code reaches no shell module and never leaves the workspace's scope");
    }
    // A host pack's own schema (mold_v0-049): tables under the names they had in the shell's base schema, its functions
    // and the shell migrations it adopts, declared in pack.json host.schema; only a host pack of the build may have one.
    {
      const HOST = "hp";
      const tryHost = (files: Record<string, string>, schema: unknown, host = true) => {
        const dir = path.join(tmp, `host-${++n}`), pdir = path.join(dir, HOST);
        mkdirSync(path.join(pdir, "migrations"), { recursive: true });
        const hostApi = path.relative(pdir, path.join(ROOT, "src", "pack-host.js")).split(path.sep).join("/");
        writeFileSync(path.join(pdir, "pack.json"), JSON.stringify({ id: HOST, name: "Host", version: "1", migrations: "migrations", host: { entry: "host.ts", ...(schema === undefined ? {} : { schema }) } }));
        writeFileSync(path.join(pdir, "host.ts"), `import { defineHost } from "${hostApi}";
export default defineHost({ id: "${HOST}" });
`);
        for (const [f, text] of Object.entries(files)) writeFileSync(path.join(pdir, f), text);
        writeFileSync(path.join(dir, "profile.json"), JSON.stringify(host ? { host_packs: [HOST] } : {}));
        return gen(["--packs", dir, "--out", path.join(dir, "out"), "--profile", path.join(dir, "profile.json")]);
      };
      const W = "CREATE TABLE IF NOT EXISTS widgets (id SERIAL PRIMARY KEY, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE, name TEXT);\n" +
        "CREATE INDEX IF NOT EXISTS widgets_org_idx ON widgets (org_id);\n";
      const SEC = "DO $mig$\nDECLARE r TEXT := octillion_tenant_role();\nBEGIN\n  ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;\n" +
        "  EXECUTE format('CREATE POLICY tenant_isolation ON widgets TO %I USING (org_id = octillion_tenant_org())', r);\n" +
        "  EXECUTE format('GRANT SELECT ON widgets TO %I', r);\nEND $mig$;\n";
      const FN = "CREATE OR REPLACE FUNCTION widget_score(n TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT length(n) $$;\n";
      const S = { tables: ["widgets"], functions: ["widget_score"], adopts: { "0001_widgets": "0001_baseline" } };
      const good = tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, S);
      assert.equal(good.status, 0, `a host pack's own tables, policies, DO blocks and declared function pass: ${good.stderr}`);
      const genFile = readFileSync(path.join(tmp, `host-${n}`, "out", "src", "pack-migrations.generated.ts"), "utf8");
      assert.match(genFile, /"tables": \[\s*"widgets"\s*\]/, "the generated registry carries the host schema (src/migrate.ts reads it)");
      refused("host.schema in a pack that is not a host pack of the build", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, S, false), /not a host pack of this build/);
      refused("a table it does not declare", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "CREATE TABLE gadgets (id INT);\n" }, S), /table gadgets must be named hp_… or declared in pack.json host.schema.tables/);
      refused("a function it does not declare", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "CREATE FUNCTION other_fn() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$;\n" }, S), /defines function other_fn, which pack.json host.schema.functions does not declare/);
      refused("a declared table that is the shell's", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "CREATE TABLE IF NOT EXISTS api_keys (id INT);\n" }, { ...S, tables: ["widgets", "api_keys"] }), /host.schema.tables: api_keys is a shell table/);
      refused("a declared function that is the shell's", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "CREATE OR REPLACE FUNCTION octillion_tenant_org() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$;\n" }, { ...S, functions: ["widget_score", "octillion_tenant_org"] }), /host.schema.functions: octillion_tenant_org is a shell function/);
      refused("a declared table no migration creates", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, { ...S, tables: ["widgets", "gizmos"] }), /names gizmos, which no migration here creates/);
      refused("SET ROLE inside a DO block", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "DO $$ BEGIN EXECUTE 'SET ROLE postgres'; END $$;\n" }, S), /SET\/RESET ROLE/);
      refused("SECURITY DEFINER", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN.replace("IMMUTABLE", "IMMUTABLE SECURITY DEFINER") }, S), /SECURITY DEFINER/);
      refused("a trigger inside a DO block", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "DO $$ BEGIN EXECUTE 'CREATE TRIGGER t AFTER INSERT ON api_keys FOR EACH ROW EXECUTE FUNCTION widget_score()'; END $$;\n" }, S), /triggers, rules, views/);
      refused("a role", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "DO $$ BEGIN CREATE ROLE sneaky; END $$;\n" }, S), /uses roles/);
      refused("disabling row-level security in a DO block", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN + "DO $$ BEGIN ALTER TABLE widgets DISABLE ROW LEVEL SECURITY; END $$;\n" }, S), /DISABLE ROW LEVEL SECURITY/);
      refused("adopting a migration it does not have", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, { ...S, adopts: { "0002_more": "0001_baseline" } }), /adopts names 0002_more, which is not one of its migrations/);
      refused("adopting a shell migration that does not exist", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, { ...S, adopts: { "0001_widgets": "0099_nothing" } }), /0099_nothing, which is not a shell migration/);
      refused("a platform library that is not one of its tables", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, { ...S, platform_read: ["gadgets"] }), /platform_read: gadgets is not one of host.schema.tables/);
      refused("an unknown host.schema field", tryHost({ "migrations/0001_widgets.sql": W + SEC + FN }, { ...S, views: [] }), /host.schema: unknown field views/);
      refused("a DO block in an ordinary pack still", tryPack("pk", { "migrations/0001_x.sql": `${T}SELECT shell_pack_tenant_table('pk_notes');\nDO $$ BEGIN NULL; END $$;\n` }), /dollar-quoted/);
      console.log("✓ a host pack's own schema (mold_v0-049): declared tables, functions and adopted migrations pass; undeclared names, the shell's names, roles, triggers, SET ROLE and SECURITY DEFINER are refused");
    }
    refused("a page in no area", tryPack("pk", {}, { pages: [{ id: "x", area: "elsewhere", title: "X", data: "/x" }] }), /area must be/);
    console.log(`✓ gen-packs refuses ${n - 1} kinds of pack that would get past the seam, and passes a good one`);
    // No profile.json: the neutral default, no product's names.
    const neutral = gen(["--packs", path.join(tmp, "none"), "--profile", path.join(tmp, "none.json"), "--out", path.join(tmp, "neutral")]);
    assert.equal(neutral.status, 0, neutral.stderr);
    const prof = JSON.parse(/GENERATED_PROFILE = ([\s\S]*?) as const;/.exec(readFileSync(path.join(tmp, "neutral", "src", "profile.generated.ts"), "utf8"))![1]!);
    assert.deepEqual([prof.mcp_server_name, prof.console_title, prof.email_sender_name], ["workspace", "Workspace", "Workspace"], "without a profile the names are the neutral default");
    refused("a profile with an unknown field", gen(["--packs", path.join(tmp, "none"), "--profile", (writeFileSync(path.join(tmp, "bad.json"), '{"title":"x"}'), path.join(tmp, "bad.json")), "--out", path.join(tmp, "neutral")]), /unknown field title/);
    console.log("✓ with no profile.json the server name, sender and console title are the neutral default");
  }

  // ---------- 3. definitions and the registry ----------
  {
    const { definePack, PackDefinitionError, z } = await import("../src/pack-api.js");
    const h = () => null;
    assert.throws(() => definePack({ id: "pk", routes: [{ scope: "admin", method: "post", path: "/x", handler: h }] }), /an admin change must name the permission/);
    assert.throws(() => definePack({ id: "pk", tools: [{ name: "t", description: "d", handler: h }, { name: "t", description: "d", handler: h }] }), /declared twice/);
    assert.throws(() => definePack({ id: "pk", tools: [{ name: "t", description: "d", inputSchema: { x: "text" as never }, handler: h }] }), /not a zod schema/);
    assert.throws(() => definePack({ id: "pk", routes: [{ scope: "workspace", method: "get", path: "../x", handler: h }] }), /path must start with \//);
    assert.throws(() => definePack({ id: "pk", recordAreas: [{ name: "a", label: "A", role: "asset", scope: "platform", fields: [{ name: "x", label: "X" }] }] }), /workspace scope only/);
    assert.throws(() => definePack({ id: "pk", schedules: [{ name: "s", job_kind: "nope", cron: "0 1 * * *" }] }), /does not declare/);
    assert.throws(() => definePack({ id: "pk", credentials: [{ name: "c", label: "C", bound_to: "workspace", deliver_as: { env: "lower" } }] }), PackDefinitionError);
    assert.doesNotThrow(() => definePack({ id: "pk", tools: [{ name: "t", description: "d", inputSchema: { x: z.string() }, handler: h }] }));
    const { installPacks } = await import("../src/packs.js");
    const TOOL_NAMES = ["shell_tool"]; // a name the shell reserves (a host pack's tool, src/host.ts)
    const manifest = (id: string) => ({ id, name: id, version: "1", entry: "index.ts", migrations: null, words: {} });
    const tool = (name: string) => ({ name, description: "d", handler: h });
    assert.throws(() => installPacks([{ manifest: manifest("pk"), definition: { id: "pk", tools: [tool(TOOL_NAMES[0]!)] } }], TOOL_NAMES), /already a shell tool/);
    assert.throws(() => installPacks([{ manifest: manifest("pk"), definition: { id: "pk", tools: [tool("t")] } }, { manifest: manifest("qk"), definition: { id: "qk", tools: [tool("t")] } }]), /already pack pk's/);
    assert.throws(() => installPacks([{ manifest: manifest("pk"), definition: { id: "qk" } }]), /the ids must match/);
    console.log("✓ definePack and the registry refuse bad definitions, shell tool names and clashes between packs");
  }

  // ---------- 4. a build copy with the fixture pack ----------
  {
    const copy = path.join(tmp, "build");
    const skip = new Set(["node_modules", ".pglite", ".pglite-preview", ".transcripts", ".next", "out", "dist"]);
    // The codebase's own packs/ folder is left out (the fixture goes there); the console's packs/ folders are the shell's.
    cpSync(ROOT, copy, { recursive: true, filter: (src) => (!skip.has(path.basename(src)) && src !== path.join(ROOT, "packs")) || src === ROOT });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    cpSync(FIXTURE, path.join(copy, "packs", "fixture_notes"), { recursive: true });
    writeFileSync(path.join(copy, "profile.json"), JSON.stringify({ name: "Fixture Desk", mcp_server_name: "fixture-desk", console_title: "Fixture Desk",
      email_sender_name: "Fixture Desk", email_from_address: "desk@example.org" }, null, 2));
    const g = gen([], copy);
    assert.equal(g.status, 0, `gen-packs in the build copy: ${g.stderr}`);
    assert.match(g.stdout, /1 pack\(s\) \(fixture_notes\), 2 page\(s\), 1 record area\(s\), 1 credential\(s\), 1 onboarding step\(s\), 1 with migrations; profile "Fixture Desk"/);
    assert.deepEqual(JSON.parse(/PACK_MIGRATION_DIRS[^=]*= (\[[\s\S]*\]);/.exec(readFileSync(path.join(copy, "src", "pack-migrations.generated.ts"), "utf8"))![1]!),
      [{ pack: "fixture_notes", dir: "packs/fixture_notes/migrations" }], "the ordered pack migration directories");
    const env: Record<string, string | undefined> = { ...process.env, PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_REGISTRY: "scripts/fixtures/registry.json" };
    delete env.DATABASE_URL; // always the throwaway embedded database
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const run = (what: string, cmd: string, args: string[], cwd = copy) => {
      const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 900_000 });
      process.stdout.write(r.stdout ?? "");
      assert.equal(r.status, 0, `${what} failed:\n${(r.stdout ?? "").slice(-3000)}\n${(r.stderr ?? "").slice(-3000)}`);
      return r.stdout;
    };
    run("the fixture check", tsx, ["scripts/packs-fixture-check.ts"]);
    const tsql = run("the tenant-SQL check with the pack", tsx, ["scripts/check-tenant-sql.ts"]);
    assert.match(tsql, /packs: 1 pack table\(s\) checked/, "the tenant-SQL check reads the pack's code");
    if ((process.env.PACKS_TEST_TYPECHECK ?? "on") !== "off") {
      run("TypeScript (server and the pack)", path.join(ROOT, "node_modules", ".bin", "tsc"), ["--noEmit"]);
      if (existsSync(path.join(ROOT, "web", "node_modules"))) run("TypeScript (console with the pack's page and navigation)", path.join(ROOT, "web", "node_modules", ".bin", "tsc"), ["--noEmit"], path.join(copy, "web"));
      console.log("✓ the build copy typechecks: the server with the pack, the console with its page and navigation");
    }
    console.log("✓ a build copy with the fixture pack: tool, page and migrated table reachable, under row-level security");
  }
  // ---------- 5. a build copy with the declarative fixture pack (mold_v0-057) ----------
  {
    const copy = path.join(tmp, "build-declarative");
    const skip = new Set(["node_modules", ".pglite", ".pglite-preview", ".transcripts", ".next", "out", "dist"]);
    // The codebase's own packs/ folder is left out (the fixture goes there); the console's packs/ folders are the shell's.
    cpSync(ROOT, copy, { recursive: true, filter: (src) => (!skip.has(path.basename(src)) && src !== path.join(ROOT, "packs")) || src === ROOT });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    cpSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_tracker"), path.join(copy, "packs", "fixture_tracker"), { recursive: true });
    const g = gen([], copy);
    assert.equal(g.status, 0, `gen-packs with a pack.json alone: ${g.stderr}`);
    assert.match(g.stdout, /1 pack\(s\) \(fixture_tracker\), 0 page\(s\), 3 record area\(s\), 1 credential\(s\), 2 onboarding step\(s\), 0 with migrations/);
    if ((process.env.PACKS_TEST_TYPECHECK ?? "on") !== "off") {
      const tc = (what: string, cmd: string, cwd: string) => {
        const r = spawnSync(cmd, ["--noEmit"], { cwd, encoding: "utf8", timeout: 900_000 });
        assert.equal(r.status, 0, `${what} failed:\n${(r.stdout ?? "").slice(-3000)}\n${(r.stderr ?? "").slice(-3000)}`);
      };
      tc("TypeScript (server with a declarative pack)", path.join(ROOT, "node_modules", ".bin", "tsc"), copy);
      if (existsSync(path.join(ROOT, "web", "node_modules"))) tc("TypeScript (console with typed record areas)", path.join(ROOT, "web", "node_modules", ".bin", "tsc"), path.join(copy, "web"));
      console.log("✓ a build copy with a pack.json alone typechecks: the server's registry with no import, the console's typed record areas");
    } else console.log("✓ a build copy with a pack.json alone generates its registry (typecheck skipped)");
  }
  console.log("PACKS TEST PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
