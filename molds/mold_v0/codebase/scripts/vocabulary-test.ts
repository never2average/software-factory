// The vocabulary check and the env-name table (mold_v0-045; scripts/lib/vocabulary.ts, scripts/check-vocabulary.ts).
//   npm run test:vocabulary
// On planted trees: a product word in a file, in any case, or in a path fails; an allow entry covers only its exact
// spelling in its own files; an entry that covers nothing fails; a pack's own files are not read, nor a build's
// generated files when it has packs; the env-name table lists every APP_ name with its old spelling and is stale when a
// name is added. Then the real codebase passes. The product word is read from scripts/vocabulary.json, never written here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aliasTable, checkVocabulary, shellEnvNames, TABLE_BEGIN, TABLE_END, withTable, type Vocabulary } from "./lib/vocabulary.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(path.join(ROOT, "scripts", "vocabulary.json"), "utf8")) as Vocabulary;
const W = REAL.words[0]!; // the product word, lower case
const Cap = W[0]!.toUpperCase() + W.slice(1), UP = W.toUpperCase();
const TMP = mkdtempSync(path.join(tmpdir(), "vocab-test-"));
let passed = 0;
const ok = (what: string) => { passed++; console.log(`✓ ${what}`); };

function tree(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(TMP, "t-"));
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), text); }
  return d;
}
const DB_RULE = { id: "db", pattern: `\\b${W}_tenant_role\\b`, paths: ["src/rls.ts"], why: "test" };
const vocab = (allow = [DB_RULE], files: Record<string, string> = {}): Vocabulary => ({ words: [W], files, allow });

try {
  // ---------- words ----------
  {
    const clean = tree({ "src/a.ts": "export const name = PROFILE.name;\n", "src/rls.ts": `SELECT ${W}_tenant_role();\n` });
    const r = checkVocabulary(clean, vocab());
    assert.deepEqual([r.findings, r.unused], [[], []], "a clean tree with its one allowed identifier passes");
    ok("a tree with no product word but an allowed identifier in its allowed file passes, and the entry counts as used");

    for (const [what, text] of [["capitalised", `// ${Cap} keeps this\n`], ["upper case", `const x = process.env.${UP}_URL;\n`], ["inside a word", `const u = "x-${W}-admin";\n`]] as const) {
      const r2 = checkVocabulary(tree({ "src/rls.ts": `SELECT ${W}_tenant_role();\n`, "src/b.ts": text }), vocab());
      assert.equal(r2.findings.length, 1, `${what}: found`);
      assert.deepEqual([r2.findings[0]!.file, r2.findings[0]!.line], ["src/b.ts", 1]);
    }
    ok("the word is found capitalised, in upper case and inside another word, with its file and line");

    const elsewhere = checkVocabulary(tree({ "src/rls.ts": `SELECT ${W}_tenant_role();\n`, "src/other.ts": `SELECT ${W}_tenant_role();\n` }), vocab());
    assert.deepEqual(elsewhere.findings.map((f) => f.file), ["src/other.ts"], "an allowed spelling outside its files is a finding");
    const longer = checkVocabulary(tree({ "src/rls.ts": `SELECT ${W}_tenant_role(); -- ${Cap} staff\n` }), vocab());
    assert.equal(longer.findings.length, 1, "an allowed spelling covers only itself: the same line's other word is found");
    ok("an allow entry covers its exact spelling in its own files only, not another file or the rest of the line");

    const stale = checkVocabulary(tree({ "src/a.ts": "ok\n" }), vocab());
    assert.deepEqual(stale.unused, ["allow db"], "an entry that covers nothing is reported");
    const staleFile = checkVocabulary(tree({ "src/a.ts": "ok\n", "src/rls.ts": `SELECT ${W}_tenant_role();\n` }), vocab([DB_RULE], { "sql/*.sql": "test" }));
    assert.deepEqual(staleFile.unused, ["files sql/*.sql"]);
    ok("an allow entry or a whole-file entry that covers nothing fails the check (the list cannot outgrow the tree)");

    const pathHit = checkVocabulary(tree({ [`web/src/lib/${W}-format.ts`]: "export {};\n", "src/rls.ts": `SELECT ${W}_tenant_role();\n` }), vocab());
    assert.deepEqual(pathHit.findings.map((f) => [f.file, f.line]), [[`web/src/lib/${W}-format.ts`, 0]], "a path is checked too");
    const pathOk = checkVocabulary(tree({ [`web/src/lib/${W}-format.ts`]: "export {};\n", "src/rls.ts": `SELECT ${W}_tenant_role();\n` }), vocab([DB_RULE], { [`web/src/lib/${W}-format.ts`]: "test" }));
    assert.deepEqual([pathOk.findings, pathOk.unused], [[], []], "unless the whole file is allowed");
    ok("a product word in a file's path is found, unless the file is listed whole");

    const packs = {
      "src/rls.ts": `SELECT ${W}_tenant_role();\n`, [`packs/${W}/pack.json`]: `{"name": "${Cap}"}\n`, [`web/src/packs/${W}/page.tsx`]: `${Cap}\n`,
      [`orchestrator/packs/${W}/main.ts`]: `${Cap}\n`, "src/profile.generated.ts": `export const P = { name: "${Cap}" };\n`, "profile.json": `{"host_packs": ["${W}"]}\n`,
    };
    const built = checkVocabulary(tree(packs), vocab());
    assert.deepEqual(built.findings, [], "a build with packs: the packs' files and the generated ones are theirs");
    const { [`packs/${W}/pack.json`]: _pj, ...unpacked } = packs;
    const shell = checkVocabulary(tree(unpacked), vocab());
    assert.deepEqual(shell.findings.map((f) => f.file).sort(), ["profile.json", "src/profile.generated.ts"], "with no pack, generated files are the shell's and are read");
    ok("a pack's own files are never read; generated files are read unless the tree has packs");
  }

  // ---------- the abbreviations (mold_v0-096) ----------
  {
    // The product word's short forms in runtime identifiers (a namespace, a run user, a tools directory), read from the
    // real vocabulary as the word is: each is found where no allow entry covers it, and the real entries cover only theirs.
    const ABBR = REAL.words.slice(1);
    assert.ok(ABBR.length >= 2, "the vocabulary lists the abbreviations too");
    for (const a of ABBR) {
      const files = { "src/rls.ts": `SELECT ${W}_tenant_role();\n`, "src/x.ts": `const ns = env.NS || "${a}"; const user = "${a}run-7"; const dir = "/opt/${a}-tools";\n` };
      const r = checkVocabulary(tree(files), { ...vocab(), words: [W, ...ABBR] });
      assert.equal(r.findings.filter((f) => f.file === "src/x.ts").length, 3, `${a}: found in each runtime identifier (namespace, run user, tools directory)`);
    }
    // mold_v0-156 renamed the runtime identifiers; what is left is the namespace's old default (one file) and a runner
    // host's old lease and cache directories (one file), each allowed only where it is spelled.
    const real = REAL.allow.filter((e) => ["legacy-boat-namespace", "legacy-runner-host-dirs"].includes(e.id));
    assert.equal(real.length, 2, "the abbreviations' allow entries");
    assert.ok(!REAL.allow.some((e) => ["boat-namespace", "run-sandbox-runtime"].includes(e.id)), "the broad entries before mold_v0-156 are gone");
    const nsFile = "orchestrator/core/boat-namespace.ts", dirFile = "src/run-users.ts";
    const held = { [nsFile]: `const legacy = vercel ? "${ABBR[1]}" : "${ABBR[0]}";\n`, [dirFile]: `const leases = "/run/${ABBR[0]}-run-uids", cache = "/var/cache/${ABBR[0]}-checkouts";\n` };
    const covered = checkVocabulary(tree(held), { words: REAL.words, files: {}, allow: real });
    assert.deepEqual(covered.findings, [], "the old defaults and the old host directories, in their own files, pass");
    const fresh = checkVocabulary(tree({ ...held, [dirFile]: `${held[dirFile]}const user = "${ABBR[0]}run-7", tools = "/opt/${ABBR[0]}-tools";\n`,
      "src/run-sandboxes.ts": `const ns = env.NS || "${ABBR[0]}";\n` }), { words: REAL.words, files: {}, allow: real });
    assert.deepEqual(fresh.findings.map((f) => `${f.file}:${f.line}`).sort(), [`${dirFile}:2`, `${dirFile}:2`, "src/run-sandboxes.ts:1"].sort(),
      "a run user or tools directory under the old name, or the old default outside its file, is refused");
    ok("the abbreviations are product words: found in runtime identifiers; only the namespace's old default and the old host directories are allowed, each in its one file");
  }

  // ---------- the env-name table ----------
  {
    const d = tree({ "src/a.ts": "const a = ENV.APP_VAULT_KEY ?? ENV.APP_PROXY_HOPS; const n = NEXT_PUBLIC_APP_URL; const c = CLICKHOUSE_APP_PASSWORD;\n",
      "src/b.ts": "const lim = ENV[`APP_LIMIT_${s}`];\n", "deploy/x.sh": "echo ${APP_DRAIN_SECONDS:-300}\n", "docs/x.md": "APP_ONLY_IN_PROSE\n" });
    const names = shellEnvNames(d);
    assert.deepEqual(names, ["APP_DRAIN_SECONDS", "APP_LIMIT_", "APP_PROXY_HOPS", "APP_VAULT_KEY"], "code and deploy files' names; not prose, not another prefix's");
    const table = aliasTable(names, `${UP}_`, "APP_");
    assert.ok(table.includes(`| \`${UP}_VAULT_KEY\` | \`APP_VAULT_KEY\` |`) && table.includes(`| \`${UP}_LIMIT_*\` | \`APP_LIMIT_*\` |`), "each name with its old spelling; a family with *");
    const md = `# x\n\n${TABLE_BEGIN}\n${TABLE_END}\n\nafter\n`;
    const once = withTable(md, table)!;
    assert.ok(once.endsWith("\n\nafter\n") && withTable(once, table) === once, "the table replaces only what is between its markers, and is stable");
    writeFileSync(path.join(d, "src", "c.ts"), "const z = ENV.APP_NEW_SETTING;\n");
    assert.notEqual(withTable(once, aliasTable(shellEnvNames(d), `${UP}_`, "APP_")), once, "a name added in the code makes the table stale");
    assert.equal(withTable("no markers", table), null);
    ok("the env-name table lists every APP_ name of the code and deploy files with its old spelling, and goes stale when one is added");
  }

  // ---------- the codebase itself ----------
  {
    const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/check-vocabulary.ts"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, `npm run check:vocabulary fails on the codebase:\n${r.stderr}`);
    const planted = path.join(ROOT, "src", `vocabulary-test-${process.pid}.ts`);
    writeFileSync(planted, `// ${Cap}\n`);
    try {
      const r2 = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/check-vocabulary.ts"], { cwd: ROOT, encoding: "utf8" });
      assert.equal(r2.status, 1, "a product word planted in src/ fails the check");
      assert.match(r2.stderr, new RegExp(`src/vocabulary-test-${process.pid}\\.ts:1: a product word`));
    } finally { rmSync(planted, { force: true }); }
    ok(`the codebase passes check:vocabulary (${r.stdout.trim().replace(/^check:vocabulary: /, "")}), and fails it with one word planted in src/`);
  }
  console.log(`\nvocabulary: ${passed} checks passed`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
