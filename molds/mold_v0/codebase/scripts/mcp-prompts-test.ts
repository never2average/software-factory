// MCP words as config (mold_v0-137; src/text-template.ts, src/mcp-prompts.ts, src/server.ts leadInstructions, src/host.ts
// engineConfig), offline: an embedded database, the declarative fixture pack scripts/fixtures/packs/fixture_digest.
//   npm run test:mcp-prompts
//
// 1. Text templates: {arg}, {arg|json}, {a,b|json}, {?arg}…{/arg}, {!arg}…{/arg}, {{, literal braces; every problem a
//    declared template can have is named (an unknown value, a block never closed or closed by another name, a block
//    inside one of the same name, a block or object written another way).
// 2. Zero packs: no prompt, and no prompts capability at all.
// 3. A declarative pack's pack.json mcp.prompts: listed in order with their titles, descriptions and arguments (required
//    or not); each answers one user message, its text filled with the arguments given (an integer one only when it is a
//    positive number, rounded; JSON quoted and escaped); a required argument missing is refused.
// 4. Order and the host slot: a host pack's own prompts come first, then the declared ones; a host pack's pack.json
//    mcp.instructions stand where its host entry's did (they win over another pack's, the profile's and the host
//    entry's own win over them).
// 5. The build: two packs declaring one prompt name are refused (installPacks and gen-packs); gen-packs refuses a template
//    that names no argument and an engine block on a pack that is not a host pack.
// 6. A host pack's engine.config: checked against its host entry's schema when it registers (every problem named, with
//    its path), refused with no schema or no config, and read with engineConfig (never before it registers).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { cleanup, connect, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_digest");
const fixture = () => JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8"));

try {
  const { fillTemplate, templateProblems } = await import("../src/text-template.js");

  // ---------- 1. text templates ----------
  {
    const v = { a: "x", b: "", n: 0, q: 'say "hi"\n', none: undefined };
    assert.equal(fillTemplate("[{a}] [{b}] [{n}] [{none}]", v), "[x] [] [0] []", "{name}: the value, an empty one included");
    assert.equal(fillTemplate("{q|json} {b|json} {none|json}", v), '"say \\"hi\\"\\n" "" null', "{name|json}: JSON, null with no value");
    assert.equal(fillTemplate("{a,b,n,none|json}", v), '{"a":"x","n":0}', "{a,b|json}: the given ones, in order");
    assert.equal(fillTemplate("{?a}A{/a}{!a}not A{/a} {?b}B{/b}{!b}no B{/b}", v), "A no B", "blocks: given (an empty string is not)");
    assert.equal(fillTemplate("{?a}{?n}both{/n}{/a}", v), "both", "blocks nest");
    assert.equal(fillTemplate("{} { a: {a|json} } {profiles: [slug]} {{a} {A}", v), '{} { a: "x" } {profiles: [slug]} {a} {A}', "anything else in braces is text; {{ is a brace");
    const probs = (t: string, names: string[] = ["a", "b"]) => templateProblems(t, names);
    assert.deepEqual(probs("{a} {?b}x{/b} {a,b|json}"), []);
    assert.match(probs("{c}").join(), /\{c\} is not a value this text is filled with \(a, b\)/);
    assert.match(probs("{?a}x").join(), /never closed/);
    assert.match(probs("{?a}x{/b}").join(), /closes the block of a/);
    assert.match(probs("x{/a}").join(), /closes no block/);
    assert.match(probs("{?a}{!a}x{/a}{/a}").join(), /inside a block of the same name/);
    assert.match(probs("{?a|json}").join(), /a block names one value/);
    assert.match(probs("{a,b}").join(), /one JSON object/);
    assert.match(probs("{a,a|json}").join(), /names a value twice/);
    assert.throws(() => fillTemplate("{?a}"), /does not parse/);
    console.log("✓ text templates: values, JSON, objects, blocks, literal braces, and every problem named");
  }

  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { setPacksForTest, installPacks } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { registerHosts, engineConfig } = await import("../src/host.js");
  const { createOrg } = await import("../src/auth.js");
  const srv = await import("../src/server.js");
  const A = (await createOrg(`Prompts A ${STAMP}`)).org;
  const declared = (j: Record<string, any>) => ({
    manifest: { id: j.id, name: j.name, version: j.version, entry: null, migrations: null, words: j.words ?? {}, dir: FIXTURE },
    declared: compileDeclarations(j),
  });
  const text = (r: { messages: { role: string; content: { type: string; text?: string } }[] }) => {
    assert.equal(r.messages.length, 1); assert.equal(r.messages[0]!.role, "user"); assert.equal(r.messages[0]!.content.type, "text");
    return r.messages[0]!.content.text!;
  };

  // ---------- 2. zero packs ----------
  {
    setPacksForTest([]);
    const c = await connect(A);
    assert.equal(c.client.getServerCapabilities()?.prompts, undefined, "zero packs: no prompts capability");
    await assert.rejects(c.client.listPrompts(), /Method not found/);
    await c.close();
    console.log("✓ zero packs: no prompt and no prompts capability");
  }

  // ---------- 3. a declarative pack's prompts ----------
  setPacksForTest([declared(fixture())]);
  {
    const c = await connect(A);
    const { prompts } = await c.client.listPrompts();
    assert.deepEqual(JSON.parse(JSON.stringify(prompts)), [
      { name: "weekly_notes", title: "Weekly notes", description: "A short summary of the week's notes." },
      { name: "explain_note", title: "Explain a note", description: "Read one note and explain it in plain words.",
        arguments: [{ name: "key", description: "The note's key, e.g. n-1", required: true }] },
      { name: "notes_report", title: "Notes report", description: "A report on the notes of one topic, or of a time window.",
        arguments: [{ name: "topic", description: "Only this topic; omit for every topic", required: false },
          { name: "days", description: "Look-back window in days (default 30)", required: false },
          { name: "since", description: "Only notes since this date (YYYY-MM-DD); overrides days", required: false }] },
    ], "listed in order, with their arguments");
    assert.equal(text(await c.client.getPrompt({ name: "weekly_notes" })),
      "Summarise this week's notes.\n1. Call fixture_digest_list_digest_notes.\nKeep it under 100 words.", "lines joined with line breaks");
    assert.equal(text(await c.client.getPrompt({ name: "explain_note", arguments: { key: 'n-"1"' } })),
      'Explain the note n-"1".\n1. Call fixture_digest_get_digest_notes { key: "n-\\"1\\"" }.\n2. Say what it means in two sentences.');
    await assert.rejects(c.client.getPrompt({ name: "explain_note", arguments: {} }), /Invalid arguments for prompt explain_note/, "a required argument missing is refused");
    const report = async (args: Record<string, string>) => text(await c.client.getPrompt({ name: "notes_report", arguments: args }));
    const tail = " Literal braces stay as written: {} and { topic: ... } and {topic}.";
    assert.equal(await report({}), `Call fixture_digest_list_digest_notes with {} (then group the notes by topic).\nCover the last 30 days.${tail}`);
    assert.equal(await report({ topic: "ops", days: "14" }), `Call fixture_digest_list_digest_notes with {"topic":"ops","days":14}.\nCover the last 14 days.${tail}`);
    assert.equal(await report({ days: "2.6" }), `Call fixture_digest_list_digest_notes with {"days":3} (then group the notes by topic).\nCover the last 3 days.${tail}`, "an integer: rounded");
    for (const d of ["0", "-3", "abc", ""]) assert.equal(await report({ days: d }), await report({}), `days ${JSON.stringify(d)}: not a positive number, not given`);
    assert.equal(await report({ topic: "ops", days: "7", since: "2026-10-01" }), `Call fixture_digest_list_digest_notes with {"topic":"ops","since":"2026-10-01"}.\nCover the last 7 days.${tail}`, "since overrides days");
    await c.close();
    console.log("✓ a declarative pack's mcp.prompts: listed in order with their arguments; each fills its text with the arguments given");
  }

  // ---------- 4. order and the host slot ----------
  {
    const HOST_TEXT = "Host entry's own instructions.";
    const host = (id: string, instructions?: string) => ({
      id, mcp: {
        toolNames: [], ...(instructions ? { instructions } : {}), register() {},
        registerPrompts(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer) {
          server.registerPrompt("host_own", { title: "Host's own", description: "Registered by the host's code." }, () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: "own" } }] }));
        },
      },
    });
    // The host pack declares its instructions and a prompt in its pack.json (it is pack fixture_host here).
    const hostPack = { id: "fixture_host", name: "Fixture host", version: "0.1.0", mcp: { instructions: "The host pack's pack.json instructions.", prompts: [{ name: "host_declared", text: "declared by the host pack" }] } };
    registerHosts([host("fixture_host")]);
    setPacksForTest([declared(hostPack), declared(fixture())]);
    const c = await connect(A);
    assert.deepEqual((await c.client.listPrompts()).prompts.map((p) => p.name), ["host_own", "host_declared", "weekly_notes", "explain_note", "notes_report"],
      "the host's own prompts, then the declared ones in pack order");
    assert.ok((c.client.getInstructions() ?? "").startsWith("The host pack's pack.json instructions."), "a host pack's pack.json instructions lead");
    assert.ok(!(c.client.getInstructions() ?? "").includes("Fixture digest keeps"), "and win over another pack's (never joined)");
    await c.close();
    assert.equal(srv.leadInstructions({ mcp_instructions: "The profile's own." }), "The profile's own.", "the profile's win");
    assert.equal(srv.leadInstructions({}, [host("fixture_host", HOST_TEXT)]), HOST_TEXT, "the host entry's own win over its pack.json");
    assert.equal(srv.leadInstructions({}, []), "The host pack's pack.json instructions.\n\nFixture digest keeps a workspace's notes. Read them with fixture_digest_list_digest_notes.",
      "a pack that is not a host pack's: joined with the others in pack order");
    registerHosts([]);
    console.log("✓ the host packs' own prompts first, then the declared ones; a host pack's pack.json instructions take the host slot");
  }

  // ---------- 5. the build ----------
  {
    const twin = { ...fixture(), id: "fixture_twin", name: "Fixture twin", record_areas: [] };
    assert.throws(() => installPacks([declared(fixture()), declared(twin)]), /pack fixture_twin: prompt weekly_notes is already pack fixture_digest's/);
    const out = path.join(TMP, "gen-out");
    let n = 0;
    const build = (packs: Record<string, any>[]) => {
      const dir = path.join(TMP, `try-${++n}`, "packs");
      for (const p of packs) { mkdirSync(path.join(dir, p.id), { recursive: true }); writeFileSync(path.join(dir, p.id, "pack.json"), JSON.stringify(p, null, 2)); }
      return spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", dir, "--out", out], { cwd: ROOT, encoding: "utf8" });
    };
    const ok = build([fixture()]);
    assert.equal(ok.status, 0, ok.stderr);
    const dup = build([fixture(), twin]);
    assert.notEqual(dup.status, 0); assert.match(dup.stderr, /prompt weekly_notes is already pack fixture_digest's/);
    const typo = fixture(); typo.mcp.prompts[1].text = "Explain {kee}.";
    const bad = build([typo]);
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /\{kee\} is not a value this text is filled with \(key\)/);
    const open = fixture(); open.mcp.prompts[2].text = "{?topic}never closed";
    assert.match(build([open]).stderr, /never closed/);
    const ctl = fixture(); ctl.mcp.prompts[0].text = "a‮b";
    assert.match(build([ctl]).stderr, /no control or direction characters/);
    const engine = fixture(); engine.engine = { config: { words: "x" } };
    const eng = build([engine]);
    assert.notEqual(eng.status, 0); assert.match(eng.stderr, /engine: only a host pack's own code reads engine.config/);
    console.log("✓ the build refuses a prompt name two packs declare, a template naming no argument or never closed, and engine.config on a pack that is not a host pack");
  }

  // ---------- 6. a host pack's engine.config ----------
  {
    const schema = z.object({ greeting: z.string().min(1), tools: z.object({ ping: z.object({ title: z.string() }).strict() }).strict() }).strict();
    const host = { id: "fixture_host", engine: { config: schema } };
    assert.throws(() => engineConfig("fixture_host"), /no engine.config registered/, "never before it registers");
    registerHosts([host], { fixture_host: { greeting: "Hello", tools: { ping: { title: "Ping" } } } });
    assert.deepEqual(engineConfig("fixture_host"), { greeting: "Hello", tools: { ping: { title: "Ping" } } });
    assert.throws(() => registerHosts([host], { fixture_host: { greeting: "", tools: { ping: { title: 1 } }, extra: true } }),
      (e: Error) => /pack.json engine.config.greeting: /.test(e.message) && /engine.config.tools.ping.title: /.test(e.message) && /Unrecognized key/.test(e.message));
    assert.throws(() => registerHosts([host], {}), /its host entry reads engine.config but its pack.json has none/);
    assert.throws(() => registerHosts([{ id: "fixture_host" }], { fixture_host: {} }), /gives no schema for it/);
    assert.throws(() => registerHosts([], { fixture_other: {} }), /no host entry with id "fixture_other"/);
    assert.deepEqual(engineConfig("fixture_host"), { greeting: "Hello", tools: { ping: { title: "Ping" } } }, "a refused registration changes nothing");
    registerHosts([]);
    assert.throws(() => engineConfig("fixture_host"), /no engine.config registered/);
    console.log("✓ a host pack's engine.config: checked against its schema when it registers (each problem with its path), read with engineConfig");
  }
  await db.close();
  console.log("MCP PROMPTS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
