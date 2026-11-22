// Every pack key the console must know is in its generated types (mold_v0-335).
//   npm run test:console-types        offline, about 30 s: no database, no server
//
// scripts/gen-packs.mjs writes the packs' console config as typed TypeScript (web/src/config/pack-nav.generated.ts and its
// neighbours: RecordAreaSpec, RecordFieldSpec, the lifecycle, DetailLayout and DetailActionSpec, the tabs, metrics and
// charts, the agent's prompts), and the shell's own CI builds with zero packs, so a key a pack may declare that the
// console's type lacks fails nothing until a real pack declares it, and then fails that app's build (a lifecycle's
// `supersedes`, a field's `filter_new_only` did, each on a deploy). This builds one maximal pack instead:
//
// 1. The fixture (scripts/fixtures/packs/fixture_console, a pack.json alone) declares every key the pack.json schema
//    (src/pack-manifest.ts PackJsonSchema, read through zod) accepts under the declarations the console reads, at every
//    depth: a key added to a schema there fails this test until the fixture declares it, so the next step checks it.
//    Every top-level key of the schema is either one of those or named below as the server's (with why); the kinds
//    (field types, page actions, tabs, measures, charts, ...) are each declared once.
// 2. gen-packs builds the fixture with every feature flag on (each flag's part of the generated types), into a
//    temporary directory.
// 3. The console's TypeScript compiler checks the generated console files against the console's own types (the
//    generated files, and what they import from web/src): an object literal with a key its type lacks is an error.
// 4. The check catches what it is for: the same build with one key its type lacks is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PackJsonSchema } from "../src/pack-manifest.js";
import { CHART_TYPES, DETAIL_SECTION_DISPLAYS, FIELD_TYPES, METRIC_MEASURES, PAGE_ACTION_KINDS, PAGE_ACTION_PLACES, TAB_ACTION_KINDS, TAB_KINDS, TAB_VIEWS } from "../src/pack-api.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_console");
const pack = JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8")) as Record<string, unknown>;
const ok = (m: string) => console.log(`✓ ${m}`);

// The declarations whose keys reach the console's generated files (wholesale or picked), every key at every depth.
const CONSOLE = ["record_areas", "tabs", "metrics", "charts", "onboarding", "agent_defaults", "pages", "object_storage", "agent_profiles", "programs", "recipes"];
// Under them, what never reaches the console: the fixture declares the key itself, not every key below it.
const SERVER_BELOW: Record<string, string> = {
  ".record_areas[].detail.actions[].probe": "a test_connection action's call is the server's: gen-packs strips it from the console's copy (scripts/connection-test-test.ts checks its keys)",
  ".record_areas[].contract": "the console gets the roles the contract resolves (export_roles, import_roles), never the contract",
  ".record_areas[].samples[]": "a shared area's sample rows are the lanes' (src/lane-samples), never the console's",
  ".record_areas[].on_save[]": "checks on save run in the record store (src/record-areas.ts)",
  ".agent_profiles[]": "an agent profile is written into the platform's profiles (src/agent-profiles.ts); its connection_env is checked below",
};
const SERVER_BELOW_BUT = [".agent_profiles[].connection_env"];
// The other top-level keys of pack.json: the server's, or a host pack's, never written into the console's typed config.
const SERVER: Record<string, string> = {
  $schema: "an editor's", $comment: "a note", id: "the pack's id", name: "a string", version: "a string", description: "a string",
  entry: "a code pack's entry", migrations: "SQL", runner: "a runner directory", upstream: "the source offer (server)", host: "a host pack's code",
  engine: "a host pack's engine config (server)", words: "resolved into the build's words (strings)", job_kinds: "the console gets each kind's pack, name and label",
  credentials: "the Credentials pages read the server", oauth_providers: "server", operator_credentials: "server", schedules: "server",
  repositories: "server", run_results: "server", mcp: "server", workspace_store: "server", checks: "server", email: "server",
  documents: "server", team_roles: "resolved into the Teams pages' words (strings)", landing: "landing.generated.ts, typed by its own checks (src/landing.ts)",
  guide: "markdown pages (pack-guides.generated.ts)", staff_docs: "server", console: "the shell pages a build hides (strings)",
  access_request: "access-request.generated.ts, checked by src/access-request.ts", client_skill: "server", connect_page: "server",
  settings: "server", admin_mcp: "server", setup: "server", account_stages: "strings", memory: "pages and words", journeys: "ids and words",
  tips: "server", texts: "strings", developer_surface: "the console gets whether it is on and has webhooks in",
};

type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; in?: unknown; element?: unknown; valueType?: unknown; options?: unknown[];
  left?: unknown; right?: unknown; getter?: () => unknown; entries?: Record<string, string> };
const defOf = (s: unknown): Def | undefined => (s as { _zod?: { def?: Def } })?._zod?.def;
const WRAPPERS = new Set(["optional", "nullable", "default", "readonly", "catch", "nonoptional", "prefault"]);
/** Each child schema of a schema, with the path step to it ("" for a wrapper or a union's option). */
function children(d: Def): [unknown, string][] {
  switch (d.type) {
    case "object": return Object.entries(d.shape ?? {}).map(([k, v]) => [v, `.${k}`]);
    case "pipe": return [[d.in, ""]];
    case "array": return [[d.element, "[]"]];
    case "record": return [[d.valueType, "{}"]];
    case "union": return (d.options ?? []).map((o) => [o, ""]);
    case "intersection": return [[d.left, ""], [d.right, ""]];
    case "lazy": return [[d.getter!(), ""]];
    default: return WRAPPERS.has(d.type) ? [[d.innerType, ""]] : [];
  }
}

try {
  // ---------- 1. the fixture declares every key the console may be given ----------
  {
    const top = Object.keys(defOf(PackJsonSchema)!.shape!);
    const unclassified = top.filter((k) => !CONSOLE.includes(k) && !(k in SERVER));
    assert.deepEqual(unclassified, [], `pack.json keys this test does not place (add each to CONSOLE, or to SERVER with why the console never reads it): ${unclassified.join(", ")}`);
    const inScope = (p: string) => CONSOLE.some((k) => p === `.${k}` || p.startsWith(`.${k}.`) || p.startsWith(`.${k}[`))
      && !(Object.keys(SERVER_BELOW).some((b) => p.startsWith(`${b}.`) || p.startsWith(`${b}[`) || p.startsWith(`${b}{`)) && !SERVER_BELOW_BUT.some((b) => p === b || p.startsWith(b)));
    // Each object schema (by identity: a schema used in several places, a condition, counts once) and its keys in scope.
    const declared = new Map<unknown, { at: string; keys: Set<string> }>();
    const walk = (s: unknown, p: string, stack: unknown[]) => {
      const d = defOf(s);
      if (!d || stack.includes(s)) return;
      if (d.type === "object") for (const k of Object.keys(d.shape ?? {})) if (inScope(`${p}.${k}`)) {
        const e = declared.get(s) ?? { at: p, keys: new Set<string>() };
        e.keys.add(k); declared.set(s, e);
      }
      for (const [c, step] of children(d)) walk(c, p + step, [...stack, s]);
    };
    walk(PackJsonSchema, "", []);
    // The keys the fixture gives each of those schemas, and the scalar values at each path (the kinds below).
    const given = new Map<unknown, Set<string>>(), values = new Map<string, Set<unknown>>();
    const visit = (s: unknown, v: unknown, p: string, depth: number) => {
      const d = defOf(s);
      if (!d || v === undefined || v === null || depth > 80) return;
      if (typeof v !== "object") { const x = values.get(p) ?? new Set(); x.add(v); values.set(p, x); }
      if (d.type === "object") {
        if (typeof v !== "object" || Array.isArray(v)) return;
        const g = given.get(s) ?? new Set<string>();
        for (const [k, c] of Object.entries(d.shape ?? {})) if (k in v) { g.add(k); visit(c, (v as Record<string, unknown>)[k], `${p}.${k}`, depth + 1); }
        given.set(s, g);
        return;
      }
      if (d.type === "array") { if (Array.isArray(v)) for (const x of v) visit(d.element, x, `${p}[]`, depth + 1); return; }
      if (d.type === "record") { if (typeof v === "object" && !Array.isArray(v)) for (const x of Object.values(v)) visit(d.valueType, x, `${p}{}`, depth + 1); return; }
      for (const [c] of children(d)) visit(c, v, p, depth + 1);
    };
    visit(PackJsonSchema, pack, "", 0);
    const parsed = PackJsonSchema.safeParse(pack);
    assert.ok(parsed.success, `the fixture is a valid pack.json: ${JSON.stringify(parsed.error?.issues.slice(0, 5))}`);
    let total = 0;
    const missing: string[] = [];
    for (const [s, e] of declared) { total += e.keys.size; for (const k of e.keys) if (!given.get(s)?.has(k)) missing.push(`${e.at}.${k}`); }
    assert.deepEqual(missing.sort(), [], `scripts/fixtures/packs/fixture_console/pack.json leaves out keys a pack may declare (declare each, so the console's types are checked against it):\n  ${missing.sort().join("\n  ")}`);
    ok(`the fixture declares all ${total} keys of ${declared.size} pack.json shapes the console may be given; ${top.length - CONSOLE.length} other top-level keys are the server's, each with why`);

    // The kinds: each value once, so each kind's part of the generated config is built.
    const kinds: [path: string, all: readonly unknown[], except?: readonly unknown[]][] = [
      [".record_areas[].fields[].type", FIELD_TYPES],
      [".record_areas[].detail.actions[].kind", PAGE_ACTION_KINDS],
      [".record_areas[].detail.actions[].place", PAGE_ACTION_PLACES],
      [".record_areas[].detail.style", ["cards", "rail"]],
      [".record_areas[].detail.tabs[].sections[].display", DETAIL_SECTION_DISPLAYS],
      [".record_areas[].role", ["source", "check", "asset"]],
      [".record_areas[].scope", ["platform", "workspace"]],
      [".record_areas[].visibility.modes[]", ["workspace", "team", "private"]],
      // A home tab that includes the Setup page and the notices is refused beside a setup or notices tab of its own.
      [".tabs[].kind", TAB_KINDS, ["setup", "notices"]],
      [".tabs[].views[]", TAB_VIEWS],
      [".tabs[].action.kind", TAB_ACTION_KINDS],
      [".metrics[].measure", METRIC_MEASURES],
      [".charts[].type", CHART_TYPES],
    ];
    const short: string[] = [];
    for (const [p, all, except = []] of kinds) for (const v of all) if (!except.includes(v) && !values.get(p)?.has(v)) short.push(`${p} ${String(v)}`);
    assert.deepEqual(short, [], `the fixture leaves out a kind:\n  ${short.join("\n  ")}`);
    ok(`every kind is declared once: ${kinds.map(([p, all, except = []]) => `${all.length - except.length} ${p.split(".").slice(-2).join(".").replace(/\[\]/g, "")}`).join(", ")}`);
  }

  // ---------- 2. gen-packs builds it with every feature on ----------
  const TMP = mkdtempSync(path.join(tmpdir(), "console-types-"));
  try {
    const packsDir = path.join(TMP, "packs"), out = path.join(TMP, "out"), profileFile = path.join(TMP, "profile.json");
    mkdirSync(packsDir);
    cpSync(FIXTURE, path.join(packsDir, "fixture_console"), { recursive: true });
    const flags = (JSON.parse(readFileSync(path.join(ROOT, "src", "features.json"), "utf8")) as { flags: { id: string }[] }).flags;
    writeFileSync(profileFile, JSON.stringify({ features: Object.fromEntries(flags.map((f) => [f.id, true])) }));
    const g = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packsDir, "--out", out, "--profile", profileFile], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(g.status, 0, `gen-packs builds the fixture: ${g.stderr}${g.stdout.slice(-2000)}`);
    const config = path.join(out, "web", "src", "config"), lib = path.join(out, "web", "src", "lib");
    const on = readFileSync(path.join(config, "features.generated.ts"), "utf8");
    const off = flags.filter((f) => !new RegExp(`"${f.id.replace(".", "\\.")}": true`).test(on)).map((f) => f.id);
    assert.deepEqual(off, [], `every feature flag is on in the fixture's build (the fixture asks for each): ${off.join(", ")}`);
    const nav = readFileSync(path.join(config, "pack-nav.generated.ts"), "utf8");
    for (const k of ["supersedes", "filter_new_only", "on_outcome", "creates", "stops_session", "failed_stage", "visibility", "related_columns", "\"parent\""])
      assert.ok(nav.includes(k), `the generated registry carries ${k}`);
    assert.ok(!nav.includes("\"probe\""), "a test_connection action's probe stays the server's");
    ok(`gen-packs builds it with all ${flags.length} feature flags on; the registry carries supersedes, filter_new_only, on_outcome, creates and the rest`);

    // ---------- 3. the console's compiler takes the generated files ----------
    const web = path.join(ROOT, "web"), tsc = path.join(web, "node_modules", ".bin", "tsc");
    assert.ok(existsSync(tsc), "the console's packages are installed (npm --prefix web ci): this test runs its compiler");
    const generated = [config, lib].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => path.join(d, f)));
    // The generated files, as the console imports them (@/config/*, @/lib/*), over the console's own web/src.
    writeFileSync(path.join(TMP, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
        module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "react-jsx", baseUrl: web, typeRoots: [path.join(web, "node_modules", "@types")],
        paths: { "@/config/*": [path.join(config, "*"), path.join(web, "src", "config", "*")], "@/lib/*": [path.join(lib, "*"), path.join(web, "src", "lib", "*")], "@/*": [path.join(web, "src", "*")] } },
      files: generated,
    }));
    const check = () => spawnSync(tsc, ["-p", path.join(TMP, "tsconfig.json")], { cwd: TMP, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const t = check();
    assert.equal(t.status, 0, `the console's types take every key of the fixture's generated config (add the key to the type gen-packs writes, or to web/src):\n${(t.stdout + t.stderr).split(TMP).join("<build>").slice(0, 4000)}`);
    ok(`the console's compiler takes the ${generated.length} generated files (${path.basename(config)}/*.generated.ts and lib/*.generated.ts)`);

    // ---------- 4. it catches a key its type lacks ----------
    const navFile = path.join(config, "pack-nav.generated.ts");
    const at = nav.indexOf("\"filter_new_only\": true");
    assert.ok(at > 0, "the fixture's field with filter_new_only is in the registry");
    writeFileSync(navFile, `${nav.slice(0, at)}"not_a_console_key": true,\n${nav.slice(at)}`);
    const bad = check();
    assert.notEqual(bad.status, 0, "a key the console's type lacks is refused");
    assert.match(bad.stdout, /'"not_a_console_key"' does not exist in type 'RecordFieldSpec'/, bad.stdout.slice(0, 2000));
    writeFileSync(navFile, nav);
    ok("a field key RecordFieldSpec lacks fails the check, naming the key and the type");
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
  console.log("console-types: ok");
} catch (e) {
  console.error(e);
  process.exit(1);
}
