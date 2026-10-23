// First-run guidance on the customer MCP server (mold_v0-105; src/mcp-tools.ts getStarted and packInstructions,
// src/mcp-catalog.ts, src/server.ts leadInstructions), offline: an embedded database, the declarative fixture pack
// (scripts/fixtures/packs/fixture_tracker), two workspaces.
//   npm run test:get-started
//
// 1. Zero packs: no tool, the shell's own instructions exactly, no get_started and no "FIRST" line.
// 2. A host pack (its own get_started and instructions) with no pack declaring onboarding steps is untouched: its tool
//    and instructions exactly, nothing generated.
// 3. A declarative pack with onboarding steps and pack.json mcp.instructions: <prefix>_get_started is generated, read
//    only, offered first; the server's instructions lead with the pack's own (the profile's and a host pack's still
//    win) and tell the client to call it first. Its answer follows the caller's own workspace (done, next, how, the
//    prompt to type), names only the tools the caller is offered (a viewer is sent to the console), and is all done
//    once every step is; another workspace's progress never shows.
// 4. The pack's mcp settings apply to it (rename, exclude: no tool and no "FIRST" line); a pack without onboarding
//    steps gets none.
// 5. gen-packs builds a pack.json with mcp.instructions and an onboarding prompt, and refuses either when it is not
//    plain text.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_tracker");
const fixture = () => JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8"));
const PACK_TEXT = "Fixture tracker keeps a workspace's applications and their findings. Add an application, then scan it.";

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { registerHosts } = await import("../src/host.js");
  const { createOrg } = await import("../src/auth.js");
  const srv = await import("../src/server.js");
  const mt = await import("../src/mcp-tools.js");
  const A = (await createOrg(`Get started A ${STAMP}`)).org, B = (await createOrg(`Get started B ${STAMP}`)).org;
  const declared = (j: Record<string, any>) => ({
    manifest: { id: j.id, name: j.name, version: j.version, entry: null, migrations: null, words: j.words ?? {}, dir: FIXTURE },
    declared: compileDeclarations(j),
  });
  const names = async (c: Awaited<ReturnType<typeof connect>>) => (await c.client.listTools()).tools.map((t) => t.name);

  // ---------- 1. zero packs ----------
  {
    setPacksForTest([]);
    const c = await connect(A);
    assert.deepEqual(await names(c), [], "zero packs: no tool");
    assert.equal(c.client.getInstructions(), srv.SHELL_INSTRUCTIONS, "zero packs: the shell's instructions, nothing added");
    assert.equal(mt.packInstructions(), null);
    assert.ok(!mt.generatedTools().some((t) => t.op === "get_started"));
    await c.close();
    console.log("✓ zero packs: no tool, the shell's instructions exactly, no get_started");
  }

  // ---------- 2. a host pack, untouched ----------
  const HOST_TEXT = "Host product. FIRST call get_started.";
  const host = {
    id: "host_fixture",
    mcp: {
      toolNames: ["get_started"], instructions: HOST_TEXT,
      register(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer) {
        server.registerTool("get_started", { description: "The host's own welcome." }, () => ({ content: [{ type: "text" as const, text: "host welcome" }] }));
      },
    },
  };
  {
    registerHosts([host]);
    setPacksForTest([]);
    const c = await connect(A);
    assert.deepEqual(await names(c), ["get_started"], "the host's own tool only");
    assert.equal(c.client.getInstructions(), HOST_TEXT, "the host's own instructions exactly");
    assert.equal(((await c.call("get_started")).content[0] as { text: string }).text, "host welcome");
    await c.close();
    // A pack without onboarding steps beside it adds no get_started and no FIRST line.
    const plainPack = fixture(); delete plainPack.onboarding;
    setPacksForTest([declared(plainPack)]);
    const d = await connect(A);
    const listed = await names(d);
    assert.equal(listed[0], "get_started");
    assert.ok(!listed.some((n) => n.endsWith("_get_started")), "no generated get_started without onboarding steps");
    const instr = d.client.getInstructions() ?? "";
    assert.ok(instr.startsWith(HOST_TEXT) && !instr.includes("FIRST: when"), "the host's lead, no generated FIRST line");
    await d.close();
    registerHosts([]);
    console.log("✓ a host pack's own get_started and instructions are untouched; a pack without onboarding steps gets none");
  }

  // ---------- 3. a declarative pack with onboarding steps ----------
  const j = fixture();
  j.mcp = { ...(j.mcp ?? {}), instructions: PACK_TEXT };
  j.onboarding = [...j.onboarding, { id: "token", label: "Give an application token", help: "Each application's token reaches its scans.", done_when: "credential:tracker_token" }];
  j.onboarding[1].prompt = "Scan my first application.";
  setPacksForTest([declared(j)]);
  {
    const gs = mt.generatedTools().filter((t) => t.op === "get_started");
    assert.deepEqual(gs.map((t) => t.name), ["fixture_tracker_get_started"], "one get_started for the pack, under its prefix");
    assert.equal(gs[0]!.annotations.readOnlyHint, true);
    assert.match(gs[0]!.description, /^Start here\. .*Add a first application; Run a first scan; Give an application token/);
    assert.equal(mt.packInstructions(), PACK_TEXT);
    assert.equal(srv.leadInstructions({}, []), PACK_TEXT, "the pack's instructions lead");
    assert.equal(srv.leadInstructions({ mcp_instructions: "The profile's own." }, []), "The profile's own.", "the profile's win");
    assert.equal(srv.leadInstructions({}, [host]), HOST_TEXT, "a host pack's win over a pack's");

    const ca = await connect(A), cb = await connect(B);
    const listed = await names(ca);
    assert.equal(listed[0], "fixture_tracker_get_started", "offered first, before every other pack tool");
    const instr = ca.client.getInstructions() ?? "";
    assert.ok(instr.startsWith(PACK_TEXT), "the instructions lead with the pack's");
    assert.match(instr, /FIRST: when the user has not asked for something specific .* call fixture_tracker_get_started and tell the user their one next step with the exact prompt to type\. Never answer a new user with a list of tools\./);
    assert.ok(instr.includes(mt.generatedInstructions({})), "then the generated tools' paragraph");

    const started = async (c: typeof ca) => {
      const r = await c.call("fixture_tracker_get_started");
      assert.ok(!r.isError, r.content[0]?.text);
      return r.structuredContent as { done: number; total: number; steps: { id: string; done: boolean; how?: string }[]; next: { id: string; how: string; say: string } | null; message: string };
    };
    const fresh = await started(ca);
    assert.deepEqual([fresh.done, fresh.total, fresh.next?.id], [0, 3, "first_app"], "a new workspace: nothing done, the first step next");
    assert.match(fresh.next!.how, /with fixture_tracker_create_tracker_apps$/, "how: the tool that does it");
    assert.equal(fresh.next!.say, "Help me with the next step: Add a first application.", "the default prompt");
    assert.ok(fresh.message.startsWith(`Welcome to `) && fresh.message.includes("Fixture tracker keeps a workspace's applications and their findings.") &&
      fresh.message.endsWith('offer this prompt to type: "Help me with the next step: Add a first application."'), fresh.message);
    assert.ok(!(await ca.call("fixture_tracker_create_tracker_apps", { key: "web", data: { url: "https://web.example" } })).isError);
    const second = await started(ca);
    assert.deepEqual([second.done, second.next?.id], [1, "first_scan"], "the record ticks the step");
    assert.match(second.next!.how, /start a run of Scan an application with fixture_tracker_start_tracker_scan, then follow it with fixture_tracker_run_status/);
    assert.equal(second.next!.say, "Scan my first application.", "the step's own prompt");
    assert.ok(second.steps.find((s) => s.id === "token")!.how!.includes("/app/credentials") && second.steps.find((s) => s.id === "token")!.how!.includes("never typed into the chat"));
    const other = await started(cb);
    assert.deepEqual([other.done, other.next?.id], [0, "first_app"], "another workspace's progress never shows");
    await ca.close(); await cb.close();

    // A viewer (no create on the area) is offered get_started but sent to the console, never to a tool it may not use.
    const viewer = await connect({ ...B, role: "viewer", userId: "user_viewer" });
    const vl = await names(viewer);
    assert.equal(vl[0], "fixture_tracker_get_started");
    assert.ok(!vl.includes("fixture_tracker_create_tracker_apps"));
    const v = await started(viewer);
    assert.equal(v.next?.id, "first_app");
    assert.ok(v.next!.how.includes("/app/records") && !v.next!.how.includes("fixture_tracker_create_tracker_apps"), v.next!.how);
    await viewer.close();

    // Every step done: no next step, and the client is told to ask what the person wants.
    const k = fixture();
    k.onboarding = [{ id: "made", label: "Workspace made", done_when: "workspace" }, { id: "first_app", label: "Add a first application", done_when: "record:tracker_apps" }];
    setPacksForTest([declared(k)]);
    const done = await connect(A);
    const all = await started(done);
    assert.deepEqual([all.done, all.total, all.next], [2, 2, null]);
    assert.match(all.message, /Every setup step is done \(2 of 2\)\. Ask the user what they want to do now/);
    await done.close();
    console.log("✓ a declarative pack: get_started generated and offered first; its instructions lead (profile and host win) with the FIRST line; done, next, how and the prompt follow the caller's own workspace and role");
  }

  // ---------- 4. the pack's mcp settings ----------
  {
    const r = fixture(); r.mcp = { rename: { fixture_tracker_get_started: "tracker_start_here" } };
    setPacksForTest([declared(r)]);
    const c = await connect(A);
    assert.equal((await names(c))[0], "tracker_start_here");
    assert.match(c.client.getInstructions() ?? "", /call tracker_start_here and tell the user/);
    assert.equal(c.client.getInstructions()?.startsWith(srv.SHELL_INSTRUCTIONS), true, "no pack instructions: the shell's lead");
    await c.close();
    const x = fixture(); x.mcp = { exclude: ["fixture_tracker_get_started"] };
    setPacksForTest([declared(x)]);
    const d = await connect(A);
    assert.ok(!(await names(d)).some((n) => n.endsWith("get_started")));
    assert.ok(!(d.client.getInstructions() ?? "").includes("FIRST: when"), "excluded: no FIRST line");
    await d.close();
    console.log("✓ rename and exclude apply to get_started (the FIRST line follows)");
  }

  // ---------- 5. gen-packs ----------
  {
    const out = path.join(TMP, "gen-out");
    let n = 0;
    const build = (edit: (j: Record<string, any>) => void) => {
      const dir = path.join(TMP, `try-${++n}`, "packs");
      mkdirSync(dir, { recursive: true });
      cpSync(FIXTURE, path.join(dir, "fixture_tracker"), { recursive: true });
      const p = fixture(); edit(p);
      writeFileSync(path.join(dir, "fixture_tracker", "pack.json"), JSON.stringify(p, null, 2));
      return spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", dir, "--out", out], { cwd: ROOT, encoding: "utf8" });
    };
    const ok = build((p) => { p.mcp = { instructions: `${PACK_TEXT}\nSecond line.` }; p.onboarding[0].prompt = "Add my first application."; });
    assert.equal(ok.status, 0, ok.stderr);
    const bad1 = build((p) => { p.mcp = { instructions: "x‮y" }; });
    assert.notEqual(bad1.status, 0); assert.match(bad1.stderr, /instructions/);
    const bad2 = build((p) => { p.onboarding[0].prompt = "Add <b>one</b>"; });
    assert.notEqual(bad2.status, 0); assert.match(bad2.stderr, /prompt/);
    console.log("✓ gen-packs builds mcp.instructions and an onboarding prompt, and refuses either when it is not plain text");
  }
  await db.close();
  console.log("GET STARTED TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
