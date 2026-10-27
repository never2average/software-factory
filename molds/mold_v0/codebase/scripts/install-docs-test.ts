// Install guides and tool docs (mold_v0-010; src/install-pages.ts, src/connect-catalog.ts), offline: an embedded
// database, a fake Clerk, the declarative fixture packs.
//   npm run test:install-docs               the checks
//   npm run test:install-docs -- --update   rewrite the zero-pack golden (scripts/fixtures/install/zero-packs.json)
//
// 1. Zero packs: /install, /install.json, every /install/<client>, /install/tools(.json) and the docs' tool table
//    (web/src/content/mcp-tools.generated.json) are byte for byte the golden, which was written by the code before
//    mold_v0-010 (the base of this change); no tool reference is mounted or linked. Rewritten once since, by mold_v0-144:
//    /install ends with the client skill's section and /install.json names the skill (`skill`), nothing else changed.
// 2. The clients the acceptance names each have a page that says how the client authenticates (sign-in or a key).
// 3. A member's own setup (the console's API keys page): every snippet format, with the key in a header and never in
//    an address, parsed per client (JSON configs, Codex's TOML, the CLI commands); chat apps sign in instead.
// 4. The profile's install_clients narrows the clients; gen-packs takes a list of known ids and refuses anything else.
// 5. With packs: the tool reference lists exactly the tools each role is offered on the customer MCP, per pack, in the
//    packs' and the profile's words, with input schemas; never an admin_only, excluded or staff tool; linked from
//    /install and named in /install.json; nothing in it is markup.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, startHttp, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const UPDATE = process.argv.includes("--update");
const GOLDEN = path.join(ROOT, "scripts", "fixtures", "install", "zero-packs.json");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
const fixture = (id: string) => JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", id, "pack.json"), "utf8"));

try {
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const { installGuide, memberSetup } = await import("../src/install-pages.js");
  const { PROFILE } = await import("../src/profile.js");
  const { ownToolNames } = await import("../src/server.js"); // the host packs' tools (src/host.ts, mold_v0-039), read when used
  const declared = (id: string) => {
    const j = fixture(id);
    return { manifest: { id, name: j.name, version: j.version, entry: null, migrations: null, words: j.words ?? {}, dir: path.join(ROOT, "scripts", "fixtures", "packs", id) },
      declared: compileDeclarations(j) };
  };

  // ---------- 1. zero packs: today's output, byte for byte ----------
  setPacksForTest([]);
  {
    const http = await startHttp();
    const guide = await (await http.req("GET", "/install.json")).json();
    const out: Record<string, string> = {};
    for (const p of ["/install", "/install.json", "/install/tools", "/install/tools.json", ...guide.clients.map((c: { id: string }) => `/install/${c.id}`)]) {
      const r = await http.req("GET", p);
      out[p] = `${r.status} ${r.headers.get("content-type")}\n${(await r.text()).replaceAll(http.base, "BASE")}`;
    }
    out["web/src/content/mcp-tools.generated.json"] = readFileSync(path.join(ROOT, "web", "src", "content", "mcp-tools.generated.json"), "utf8");
    await http.close();
    if (UPDATE) { mkdirSync(path.dirname(GOLDEN), { recursive: true }); writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}`); console.log(`wrote ${path.relative(ROOT, GOLDEN)}`); }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
    assert.deepEqual(Object.keys(out), Object.keys(golden), "the same pages");
    for (const k of Object.keys(golden)) assert.equal(out[k], golden[k], `${k} is byte for byte what it was`);
    assert.ok(out["/install/tools"]!.startsWith("404 "), "no tool reference with zero packs");
    assert.ok(!out["/install"]!.includes("/install/tools"), "nor a link to one");
    console.log(`✓ zero packs: /install, /install.json, ${guide.clients.length} client pages, /install/tools and the docs' tool table are byte for byte what they were`);
  }

  // ---------- 2. a page per client, saying how it authenticates ----------
  const NAMED = { claude: "Claude (web & desktop)", chatgpt: "ChatGPT", "claude-code": "Claude Code", cursor: "Cursor", vscode: "VS Code (Copilot Chat)", windsurf: "Windsurf", codex: "Codex CLI", "gemini-cli": "Gemini CLI" };
  {
    const http = await startHttp();
    for (const [id, name] of Object.entries(NAMED)) {
      const html = await (await http.req("GET", `/install/${id}`)).text();
      assert.ok(html.includes(name.replaceAll("&", "&amp;")), `${id}: its page`);
      assert.ok(/Sign in \(recommended\)/.test(html) || /With an API key/.test(html), `${id}: says how it authenticates`);
      if (id === "claude" || id === "chatgpt") assert.ok(!html.includes("With an API key"), `${id}: signs in only (it cannot send a header)`);
      else assert.ok(html.includes("With an API key") && html.includes("Authorization") && html.includes("Bearer &lt;your API key&gt;"), `${id}: a key, in a header`);
    }
    assert.ok((await (await http.req("GET", "/install/cursor")).text()).includes('href="cursor://anysphere.cursor-deeplink/mcp/install?'), "Cursor's one-click link");
    await http.close();
    console.log("✓ every client the acceptance names has a page that says whether it signs in or sends a key (in a header), with Cursor's one-click link");
  }

  // ---------- 3. a member's own setup: the snippet formats ----------
  {
    const KEY = `oct_${"k".repeat(32)}`, url = "https://desk.example/mcp", S = PROFILE.mcp_server_name, auth = `Bearer ${KEY}`;
    const setup = memberSetup("https://desk.example/", KEY);
    assert.equal(setup.url, url);
    const c = (id: string) => setup.clients.find((x) => x.id === id)!;
    for (const id of Object.keys(NAMED)) assert.ok(c(id), `${id} is in the setup`);
    for (const id of ["claude", "chatgpt"]) { assert.equal(c(id).auth, "oauth", `${id} signs in`); assert.equal(c(id).snippet, null); assert.ok(!c(id).steps.includes(KEY)); }
    for (const id of ["claude-code", "cursor", "vscode", "windsurf", "codex", "gemini-cli"]) assert.equal(c(id).auth, "token", `${id} sends the key`);
    assert.equal(c("claude-code").command, `claude mcp add --transport http ${S} ${url} --header "Authorization: ${auth}"`);
    assert.deepEqual(JSON.parse(c("claude-code").snippet!), { mcpServers: { [S]: { type: "http", url, headers: { Authorization: auth } } } });
    assert.deepEqual(JSON.parse(c("cursor").snippet!), { mcpServers: { [S]: { url, headers: { Authorization: auth } } } });
    assert.equal(c("cursor").command, null, "Cursor's one-click link carries no key (it is offered only without one)");
    assert.deepEqual(JSON.parse(c("vscode").snippet!), { servers: { [S]: { type: "http", url, headers: { Authorization: auth } } } });
    assert.deepEqual(JSON.parse(c("windsurf").snippet!), { mcpServers: { [S]: { serverUrl: url, headers: { Authorization: auth } } } });
    assert.equal(c("codex").snippet, `[mcp_servers.${S}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${auth}" }`);
    assert.equal(c("gemini-cli").command, `gemini mcp add -t http -H "Authorization: ${auth}" ${S} ${url}`);
    assert.deepEqual(JSON.parse(c("gemini-cli").snippet!), { mcpServers: { [S]: { httpUrl: url, headers: { Authorization: auth } } } });
    for (const x of setup.clients) {
      if (x.snippet && x.snippet.trim().startsWith("{")) assert.doesNotThrow(() => JSON.parse(x.snippet!), `${x.id}: its JSON parses`);
      for (const u of `${x.command ?? ""} ${x.snippet ?? ""} ${x.steps}`.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'\\]+/gi) ?? []) assert.ok(!u.includes(KEY), `${x.id}: the key is never in an address: ${u}`);
    }
    console.log("✓ a member's own setup: the exact config or command per client with their key in a header (JSON, TOML and CLI formats checked), chat apps sign in");
  }

  // ---------- 4. the profile's install_clients ----------
  {
    const narrowed = installGuide("https://desk.example", { install_clients: ["claude-code", "cursor"] });
    assert.deepEqual(narrowed.clients.map((x) => x.id), ["claude-code", "cursor"], "only the clients the profile names");
    assert.deepEqual(memberSetup("https://desk.example", "oct_x", { install_clients: ["codex"] }).clients.map((x) => x.id), ["codex", "header"], "in a member's setup too (with the generic header line)");
    assert.equal(installGuide("https://desk.example").clients.length, installGuide("https://desk.example", {}).clients.length, "absent: every client");
    const out = path.join(TMP, "gen-out"), prof = path.join(TMP, "profile.json"), none = path.join(TMP, "no-packs");
    mkdirSync(none, { recursive: true });
    const gen = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", none, "--out", out, "--profile", prof], { cwd: ROOT, encoding: "utf8" });
    writeFileSync(prof, JSON.stringify({ name: "Acme Desk", install_clients: ["claude-code", "cursor", "vscode"] }));
    const g = gen();
    assert.equal(g.status, 0, g.stderr);
    assert.ok(readFileSync(path.join(out, "src", "profile.generated.ts"), "utf8").includes('"install_clients": [\n    "claude-code",'), "gen-packs carries the list");
    for (const bad of [["nope"], [], ["cursor", "cursor"], "cursor", ["header"]]) {
      writeFileSync(prof, JSON.stringify({ name: "Acme Desk", install_clients: bad }));
      assert.match(gen().stderr, /install_clients: a list of client ids, each once/, `refused: ${JSON.stringify(bad)}`);
    }
    console.log("✓ the profile's install_clients narrows the install pages and a member's setup; gen-packs takes known ids only");
  }

  // ---------- 5. the tool reference from the pack registry ----------
  {
    setPacksForTest([declared("fixture_tracker"), declared("fixture_review")]);
    const A = await createOrg(`Docs A ${STAMP}`);
    const http = await startHttp();
    const ref = await (await http.req("GET", "/install/tools.json")).json();
    assert.equal(ref.name, PROFILE.name, "in the profile's name");
    assert.deepEqual(ref.packs.map((p: any) => [p.id, p.name]), [["fixture_tracker", fixture("fixture_tracker").name], ["fixture_review", "Fixture review"]], "per pack, by its name");
    const all = ref.packs.flatMap((p: any) => p.tools) as { name: string; description: string; roles: string[]; role_labels: string[]; input_schema: any; read_only: boolean }[];
    const names = all.map((t) => t.name);
    for (const t of ["review_cancel_review", "review_admin_create_review_guides", "review_admin_delete_review_guides", "fixture_tracker_admin_sync_tracker_library"]) assert.ok(!names.includes(t), `${t} (admin_only, excluded or staff) is not in the reference`);
    assert.ok(!names.some((n) => n.includes("_admin_")), "no staff tool");
    // Exactly what each role is offered on the customer MCP (the shell's own and the record tools aside).
    for (const role of ["viewer", "member", "billing", "owner"] as const) {
      const c = await connect({ ...A.org, userId: `user_${role}`, role });
      const offered = (await c.client.listTools()).tools.map((t) => t.name).filter((n) => !ownToolNames().includes(n) && n !== "list_records" && n !== "get_record");
      await c.close();
      assert.deepEqual(all.filter((t) => t.roles.includes(role)).map((t) => t.name).sort(), offered.sort(), `the reference's ${role} tools are exactly those the ${role} is offered`);
    }
    const create = all.find((t) => t.name === "review_create_review_notes")!;
    assert.deepEqual(create.roles, ["member", "owner"], "an area's narrower roles (billing may not add notes)");
    assert.deepEqual(create.role_labels, ["Member", "Owner"]);
    assert.ok(create.input_schema.properties.key && create.input_schema.properties.data.properties.body, "with its input schema");
    assert.ok(all.find((t) => t.name === "review_notes")!.description.includes("team"), "in the pack's own words (a review pack's team)");
    assert.ok(all.find((t) => t.name === "review_get_review_items")!.description === "One item of this team by its key, with every field.", "a pack's describe override");
    const html = await (await http.req("GET", "/install/tools")).text();
    for (const n of names) assert.ok(html.includes(`<code>${n}</code>`), `${n} on the page`);
    assert.ok(!/<(script|img|iframe)/i.test(html), "nothing from a declaration is markup");
    assert.ok((await (await http.req("GET", "/install")).text()).includes('href="/install/tools"'), "linked from /install");
    assert.equal((await (await http.req("GET", "/install.json")).json()).tool_reference, "/install/tools", "named in /install.json");
    assert.equal((await http.req("GET", "/install/claude-code")).status, 200, "the client pages still answer");
    await http.close();
    console.log(`✓ the tool reference lists exactly the tools each role is offered (${names.length} across 2 packs), with input schemas, in the packs' words; no admin_only, excluded or staff tool`);
  }
  // ---------- 6. member keys off (mold_v0-099): sign-in only, under Clerk and under the built-in sign-in ----------
  {
    const { setMemberKeysForTest } = await import("../src/profile.js");
    const off = installGuide("https://desk.example", { member_keys: false });
    assert.equal(off.api_keys, false, "the guide says keys are off");
    assert.ok(off.clients.every((c) => c.api_key === null), "no client is offered a key");
    assert.ok(!off.clients.some((c) => c.id === "header"), "nor the header-only entry");
    assert.equal(installGuide("https://desk.example", { member_keys: true }).api_keys, undefined, "on: the guide is as before");
    const http = await startHttp();
    const pages = async () => {
      const g = await (await http.req("GET", "/install.json")).json();
      const out: Record<string, string> = { "/install": await (await http.req("GET", "/install")).text() };
      for (const c of g.clients) out[`/install/${c.id}`] = await (await http.req("GET", `/install/${c.id}`)).text();
      return { g, out };
    };
    setMemberKeysForTest(false);
    try {
      for (const provider of ["clerk", "builtin"] as const) {
        process.env.AUTH_PROVIDER = provider;
        const { g, out } = await pages();
        assert.equal(g.sign_in, true, `${provider}: sign-in is the way in`);
        assert.equal(g.api_keys, false);
        assert.equal(g.clients.length, installGuide("https://desk.example", {}).clients.length, `${provider}: every client the build offers is still offered (each signs in)`);
        for (const [pth, html] of Object.entries(out)) {
          assert.ok(!/API key|Bearer|X-API-Key|your API key/i.test(html), `${provider} ${pth}: no key anywhere`);
          if (pth !== "/install" && pth !== "/install/pi") assert.ok(html.includes("Sign in (recommended)"), `${provider} ${pth}: its sign-in steps`);
        }
        assert.ok(out["/install"]!.includes("Every client signs in with your account (OAuth).</p>"), `${provider}: /install says so`);
      }
    } finally { setMemberKeysForTest(null); delete process.env.AUTH_PROVIDER; }
    // On again (the default): the key card is back, exactly as section 2 checked.
    assert.ok((await (await http.req("GET", "/install/claude-code")).text()).includes("With an API key"), "on: the key card is back");
    await http.close();
    // gen-packs: member_keys is true or false, and reaches the console's profile.
    const out = path.join(TMP, "gen-keys"), prof = path.join(TMP, "profile-keys.json"), none = path.join(TMP, "no-packs-keys");
    mkdirSync(none, { recursive: true });
    const gen = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", none, "--out", out, "--profile", prof], { cwd: ROOT, encoding: "utf8" });
    writeFileSync(prof, JSON.stringify({ name: "Acme Desk", member_keys: false }));
    const g = gen();
    assert.equal(g.status, 0, g.stderr);
    assert.ok(readFileSync(path.join(out, "web", "src", "config", "profile.generated.ts"), "utf8").includes('"member_keys": false'), "the console reads it (no API keys page or link)");
    assert.ok(readFileSync(path.join(out, "src", "profile.generated.ts"), "utf8").includes('"member_keys": false'), "the server reads it");
    for (const bad of ["false", 0, null, {}]) {
      writeFileSync(prof, JSON.stringify({ name: "Acme Desk", member_keys: bad }));
      assert.match(gen().stderr, /member_keys: true or false/, `refused: ${JSON.stringify(bad)}`);
    }
    console.log("✓ member keys off: every install page and /install.json offer sign-in only (Clerk and the built-in sign-in), no key card or header entry; gen-packs takes true or false");
  }
  console.log("install-docs: all checks passed");
  process.exit(0);
} finally {
  cleanup();
}
