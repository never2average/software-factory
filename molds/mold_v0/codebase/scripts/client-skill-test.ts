// The client skill (mold_v0-144; src/client-skill-config.ts, src/client-skill.ts, src/install-pages.ts), offline.
//   npm run test:client-skill
//
// 1. The rules: what a `client_skill` block may say (name, one-line description, body without frontmatter, file paths
//    beside SKILL.md, the words), and the app's block over a pack's.
// 2. What gen-packs writes: a pack's block (checked, without its $comment) to src/client-skill.generated.ts, the app's
//    profile.json block over it, null with neither; two packs declaring one, or a broken block, refuse the build.
// 3. The files from a config: the frontmatter, the body as given, the generated connection section with the front door's
//    address, reference/tools.md from the tools the server lists, the config's own files; the default body without one.
// 4. Served (zero packs, an embedded database): /install offers it, /install.json names it, /install/skill.zip and
//    /downloads/<name>-skill.zip are the same zip, readable by Python's zipfile, every entry in the skill's folder, the
//    same bytes on every request; its tools are exactly what tools/list answers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup as cleanupWorld, connect, startHttp, STAMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "client-skill-"));
let n = 0, checks = 0;
const ok = (what: string) => { checks++; console.log(`✓ ${what}`); };

/** A throwaway copy of this codebase (its node_modules linked) with these packs and this profile; gen-packs run in it. */
function world(packs: Record<string, unknown>, profile: Record<string, unknown> = {}) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, json] of Object.entries(packs)) {
    mkdirSync(path.join(dir, "packs", id), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, "pack.json"), JSON.stringify(json, null, 2));
  }
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, status: gen.status, out: `${gen.stdout}\n${gen.stderr}` };
}
const generated = (dir: string) => JSON.parse(/export const GENERATED_CLIENT_SKILL: ClientSkillConfig \| null = ([\s\S]*?);\n/.exec(readFileSync(path.join(dir, "src", "client-skill.generated.ts"), "utf8"))![1]!);

/** A zip's entries and texts, as Python's zipfile reads them (an independent reader). */
function unzip(zip: Buffer): Record<string, string> {
  const f = path.join(TMP, `z${++n}.zip`);
  writeFileSync(f, zip);
  const r = spawnSync("python3", ["-I", "-c", "import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({i.filename: z.read(i).decode('utf-8') for i in z.infolist()}))", f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

try {
  const { clientSkillProblems, mergeClientSkill, skillFiles, skillName, CLIENT_SKILL_WORDS } = await import("../src/client-skill-config.js");

  // ---------- 1. the rules ----------
  {
    assert.deepEqual(clientSkillProblems({}), [], "every field is optional");
    assert.deepEqual(clientSkillProblems({ $comment: "c", name: "acme-desk", description: "Does things. Use when asked.", body: "# Acme\n\nText\twith a tab.", files: { "reference/terms.md": "x", "notes.txt": "y" }, words: { connect_heading: "Connect" } }), []);
    const bad: [unknown, RegExp][] = [
      [[], /an object/],
      [{ other: 1 }, /client_skill\.other: not a client_skill field/],
      [{ name: "Acme Desk" }, /name: lowercase letters/],
      [{ name: "acme--desk" }, /name: lowercase letters/],
      [{ name: "x".repeat(65) }, /name: lowercase letters/],
      [{ name: "my-claude-helper" }, /name: may not contain "claude"/],
      [{ description: "two\nlines" }, /description: plain text on one line/],
      [{ description: "a <tag>" }, /description: plain text on one line/],
      [{ description: "x".repeat(1025) }, /description: at most 1024/],
      [{ body: "---\nname: x\n---\nbody" }, /body: the shell writes the frontmatter/],
      [{ body: "bad \u0000 byte" }, /body: Markdown text/],
      [{ body: "x".repeat(30001) }, /body: at most 30000/],
      [{ files: { "../escape.md": "x" } }, /files\.\.\.\/escape\.md: a path beside SKILL\.md/],
      [{ files: { "SKILL.md": "x" } }, /files\.SKILL\.md: a path beside|files\.SKILL\.md: the shell writes/],
      [{ files: { "reference/tools.md": "x" } }, /files\.reference\/tools\.md: the shell writes this file itself/],
      [{ files: { "script.sh": "x" } }, /files\.script\.sh: a path beside SKILL\.md/],
      [{ files: Object.fromEntries(Array.from({ length: 11 }, (_v, i) => [`f${i}.md`, "x"])) }, /files: at most 10 files/],
      [{ words: { nope: "x" } }, /words\.nope: not a client_skill word/],
      [{ words: { connect_heading: "a\nb" } }, /words\.connect_heading: plain text on one line/],
    ];
    for (const [v, re] of bad) assert.ok(clientSkillProblems(v).some((p) => re.test(p)), `${JSON.stringify(v).slice(0, 80)}: ${clientSkillProblems(v).join("; ")}`);
    assert.equal(mergeClientSkill(null, null), null, "neither: null");
    assert.deepEqual(mergeClientSkill({ name: "pack-one", description: "P", files: { "a.md": "A", "b.md": "B" }, words: { tools_heading: "T" } }, { $comment: "c", description: "App", files: { "b.md": "B2" }, words: { no_tools: "N" } } as never),
      { name: "pack-one", description: "App", files: { "a.md": "A", "b.md": "B2" }, words: { tools_heading: "T", no_tools: "N" } }, "the app's over the pack's, field by field, files and words path by path, no $comment");
    assert.equal(skillName(null, "Acme Desk!"), "acme-desk", "the default name from the MCP server's name");
    assert.equal(skillName(null, "claude"), "connector", "never a reserved word");
    ok("the rules: names, one-line texts, bodies without frontmatter, paths beside SKILL.md, words; the app's block over a pack's");
  }

  // ---------- 2. what gen-packs writes ----------
  {
    const block = { $comment: "c", name: "fixture-skill", description: "A fixture's skill.", body: "# Fixture\n\nUse the tools.", files: { "reference/notes.md": "# Notes\n" } };
    const base = { id: "fixture_skill", name: "Fixture skill", version: "1.0.0" };
    const none = world({});
    assert.equal(none.status, 0, none.out);
    assert.equal(generated(none.dir), null, "no block: null");
    const on = world({ fixture_skill: { ...base, client_skill: block } });
    assert.equal(on.status, 0, on.out);
    const { $comment: _c, ...want } = block;
    assert.deepEqual(generated(on.dir), want, "a pack's block reaches the server, without its $comment");
    const app = world({ fixture_skill: { ...base, client_skill: block } }, { client_skill: { description: "The app's own." } });
    assert.equal(app.status, 0, app.out);
    assert.deepEqual(generated(app.dir), { ...want, description: "The app's own." }, "the app's profile.json block over it");
    const two = world({ fixture_skill: { ...base, client_skill: block }, fixture_other: { id: "fixture_other", name: "Other", version: "1.0.0", client_skill: { name: "other" } } });
    assert.ok(two.status !== 0 && /fixture_other and fixture_skill both declare a client_skill|fixture_skill and fixture_other both declare a client_skill/.test(two.out), two.out.slice(-600));
    const broken = world({ fixture_skill: { ...base, client_skill: { name: "Bad Name", files: { "reference/tools.md": "x" } } } });
    assert.ok(broken.status !== 0 && /client_skill\.name: lowercase/.test(broken.out) && /files\.reference\/tools\.md: the shell writes/.test(broken.out), broken.out.slice(-600));
    const badApp = world({}, { client_skill: { words: { nope: "x" } } });
    assert.ok(badApp.status !== 0 && /profile\.json.*client_skill\.words\.nope/.test(badApp.out), badApp.out.slice(-600));
    ok("gen-packs: a pack's block (checked, no $comment), the app's over it, null with neither; two packs or a broken block refuse the build");
  }

  // ---------- 3. the files from a config ----------
  {
    const facts = { product: "Acme", server: "acme", summary: "Acme tracks things.", url: "https://acme.example/mcp", install: "https://acme.example/install", instructions: "Call get_started first.",
      tools: [{ name: "list_items", title: "List items", description: "Lists the items. Then more detail.", read_only: true }, { name: "add_item", title: null, description: "Adds an item | with a pipe.", read_only: false }] };
    const cfg = { name: "acme-desk", description: "Acme: what it does.", body: "# Acme\n\nThe body as written.\n", files: { "reference/terms.md": "# Terms\n" }, words: { connect_heading: "Hooking up {product}" } };
    const f = skillFiles(cfg, facts);
    assert.deepEqual(Object.keys(f), ["SKILL.md", "reference/terms.md", "reference/tools.md"], "SKILL.md, the config's files and the tools, sorted");
    assert.ok(f["SKILL.md"]!.startsWith('---\nname: acme-desk\ndescription: "Acme: what it does."\n---\n\n# Acme\n\nThe body as written.\n\n## Hooking up Acme\n\n'), f["SKILL.md"]);
    assert.ok(f["SKILL.md"]!.includes("an MCP server at https://acme.example/mcp") && f["SKILL.md"]!.includes("https://acme.example/install") && f["SKILL.md"]!.includes("reference/tools.md"), "the connection section: the front door, the install page, the tools");
    assert.equal(f["reference/terms.md"], "# Terms\n");
    assert.ok(f["reference/tools.md"]!.includes("## `list_items`: List items\n\nLists the items. Then more detail.\n\nReads only.") && f["reference/tools.md"]!.includes("## `add_item`\n\nAdds an item | with a pipe.\n\nChanges something."), f["reference/tools.md"]);
    const plain = skillFiles(null, facts);
    assert.ok(plain["SKILL.md"]!.startsWith(`---\nname: acme\ndescription: Acme tracks things. Use it when the user wants to work with Acme from this AI client. Needs the Acme connector (an MCP server).\n---\n\n# Acme\n\nAcme tracks things.\n\n## How to work with Acme\n\nCall get_started first.\n\n## Tools\n\n| Tool | What it does |\n|---|---|\n| \`list_items\` | Lists the items. Then more detail. |\n| \`add_item\` | Adds an item \\| with a pipe. |\n\n## Connecting Acme\n\n`), plain["SKILL.md"]);
    assert.ok(skillFiles(null, { ...facts, tools: [], instructions: "" })["SKILL.md"]!.includes(`## Tools\n\n${CLIENT_SKILL_WORDS.no_tools}`), "no tools: says so");
    ok("the files: frontmatter, the body as given, the connection section on the front door, the tools from the server, the config's files; a generated body without one");
  }

  // ---------- 4. served, zero packs ----------
  {
    const { createOrg } = await import("../src/auth.js");
    const { PROFILE } = await import("../src/profile.js");
    const http = await startHttp();
    const get = (p: string) => http.req("GET", p);
    const guide = await (await get("/install.json")).json();
    const name = skillName(null, PROFILE.mcp_server_name);
    assert.deepEqual(guide.skill, { file: `${name}-skill.zip`, download: "/install/skill.zip" }, "install.json names it");
    const page = await (await get("/install")).text();
    assert.ok(page.includes('href="/install/skill.zip"') && page.includes(`Download ${name}-skill.zip`), "/install offers it");
    const r = await get("/install/skill.zip");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/zip");
    assert.equal(r.headers.get("content-disposition"), `attachment; filename="${name}-skill.zip"`);
    const zip = Buffer.from(await r.arrayBuffer());
    assert.ok(zip.equals(Buffer.from(await (await get("/install/skill.zip")).arrayBuffer())), "the same bytes every time");
    assert.ok(zip.equals(Buffer.from(await (await get(`/downloads/${name}-skill.zip`)).arrayBuffer())), "the same zip at /downloads/<name>-skill.zip");
    const files = unzip(zip);
    assert.deepEqual(Object.keys(files), [`${name}/SKILL.md`, `${name}/reference/tools.md`], "every entry in the skill's folder");
    assert.ok(files[`${name}/SKILL.md`]!.startsWith(`---\nname: ${name}\n`) && files[`${name}/SKILL.md`]!.includes(`at ${guide.url}.`), "its name, and the address clients connect to (the install pages')");
    const org = (await createOrg(`Skill ${STAMP}`)).org;
    const { client } = await connect(org);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    const inSkill = [...files[`${name}/reference/tools.md`]!.matchAll(/^## `([^`]+)`/gm)].map((m) => m[1]);
    assert.deepEqual(inSkill, listed, "reference/tools.md lists exactly the tools the server lists");
    assert.equal((await get("/install/skill")).status, 404, "/install/skill is no client page");
    await http.close();
    ok(`served: /install offers it, /install.json names it, /install/skill.zip and /downloads/${name}-skill.zip are one deterministic zip in the skill's folder; its tools are tools/list's (${listed.length})`);
  }
  console.log(`\n${checks} checks passed`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
  cleanupWorld();
}
process.exit(0);
