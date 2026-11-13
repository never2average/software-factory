// The staff invite popup's setup email (mold_v0-277), offline: the shell's server in this process (an embedded database,
// the offline Clerk), zero packs. The customer Overview is unchanged (its Connect section and setup steps as before).
//   npm run test:setup-email
//
// 1. The email is built ONLY for the clients chosen: one client's subject and body name it, its own way in and the
//    connection URL, and no other client; three clients in the order chosen; refusals (none, empty, not a list,
//    unknown, more than five).
// 2. The staff console's invite result carries no generic email any more; its POST /setup-email builds the email for
//    the clients a staff member picks, the key's place a placeholder (the key never sent back), with the same refusals.
// 3. Removed from the staff invite popup: the "Client setup" row and the "Optional follow-up" mail header.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, startHttp } from "./lib/test-world.js";

process.env.APP_EMAIL_PROVIDER = "test";
const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (s: string) => console.log(`✓ ${s}`);

try {
  const { PROFILE } = await import("../src/profile.js");
  const { clientCatalog } = await import("../src/connect-catalog.js");
  const { chosenClients, setupEmailText, SetupEmailError, MAX_SETUP_CLIENTS } = await import("../src/setup-email.js");
  const settings = await import("../src/settings.js");
  await settings.setSettings("test", { EMAILS_ENABLED: "on" });
  const NAME = PROFILE.name;

  // ---------- 1. only the chosen clients (the builder itself) ----------
  {
    const URL = "https://app.example.org/mcp";
    const catalog = clientCatalog(URL);
    const names = catalog.map((c) => c.client);
    const others = (keep: string[]) => names.filter((n) => !keep.includes(n));
    const one = setupEmailText(chosenClients(["cursor"], catalog), { name: NAME, url: URL, prompt: "Start." });
    assert.equal(one.subject, `Set up ${NAME} in Cursor`);
    assert.deepEqual(one.clients, ["cursor"]);
    const cursor = catalog.find((c) => c.id === "cursor")!;
    for (const part of [URL, cursor.steps, cursor.install_url!, cursor.file!, cursor.snippet!, 'type: "Start."'])
      assert.ok(one.body.includes(part), `the body has Cursor's own ${part.slice(0, 40)}`);
    for (const n of others(["Cursor"])) assert.ok(!one.body.includes(n), `one client: the body never names ${n}`);
    const three = setupEmailText(chosenClients(["claude-code", "claude", "vscode"], catalog), { name: NAME, url: URL, prompt: "Start." });
    assert.equal(three.subject, `Set up ${NAME} in Claude Code, Claude (web & desktop) and VS Code (Copilot Chat)`);
    const at = ["1. Claude Code", "2. Claude (web & desktop)", "3. VS Code (Copilot Chat)"].map((h) => three.body.indexOf(h));
    assert.ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]!)), `three clients, numbered in the order chosen: ${at}`);
    assert.ok(three.body.includes(catalog.find((c) => c.id === "claude-code")!.command!) && three.body.includes(catalog.find((c) => c.id === "vscode")!.file!), "each with its own command and file");
    for (const n of others(["Claude Code", "Claude (web & desktop)", "VS Code (Copilot Chat)"])) assert.ok(!three.body.includes(n), `three clients: the body never names ${n}`);
    assert.deepEqual(chosenClients(["cursor", " cursor ", "cursor"], catalog).map((c) => c.id), ["cursor"], "a client chosen twice is in it once");
    for (const [bad, why] of [[undefined, /must be a list/], ["cursor", /must be a list/], [[1], /must be a list/], [[], /at least one/], [["", " "], /at least one/],
      [["cursor", "nope"], /Unknown agent: "nope"/], [catalog.slice(0, MAX_SETUP_CLIENTS + 1).map((c) => c.id), /at most 5/]] as const)
      assert.throws(() => chosenClients(bad, catalog), (e: Error) => e instanceof SetupEmailError && why.test(e.message), `refused: ${JSON.stringify(bad)}`);
    ok("the email is built only for the clients chosen: one client's subject, its own install link, file, snippet and the URL, no other client named; three in the order chosen and none of the rest; refusals: none, empty, not a list, unknown, more than five");
  }

  const http = await startHttp();
  try {
    // ---------- 2. the staff console ----------
    const staff = await http.adminToken("support");
    const admin = async (p: string, body: unknown) => { const r = await http.req("POST", `/api/admin/onboarding${p}`, { authorization: `Bearer ${staff}` }, body); return { status: r.status, body: await r.json().catch(() => null) as any }; };
    const staffOne = await admin("/setup-email", { clients: ["gemini-cli"] });
    assert.equal(staffOne.status, 200);
    assert.equal(staffOne.body.subject, `Set up ${NAME} in Gemini CLI`);
    assert.ok(!staffOne.body.body.includes("Claude") && !staffOne.body.body.includes("Cursor"), "the staff email names only its client too");
    const keyed = await admin("/setup-email", { clients: ["claude-code"], key: true });
    assert.ok(keyed.body.body.includes("[paste the API key here]") && /Authorization: Bearer \[paste the API key here\]/.test(keyed.body.body), "with a key: its place a placeholder, in the client's own header");
    assert.equal((await admin("/setup-email", { clients: [] })).status, 400, "staff: an empty choice refused");
    assert.equal((await admin("/setup-email", { clients: ["nope"] })).status, 400, "staff: an unknown client refused");
    const { connectInfo } = await import("../src/admin.js");
    assert.ok(!("email" in connectInfo()), "connectInfo carries no generic email (the old list of five clients and every other one)");
    ok("the staff console: the email for the clients picked (a key's place a placeholder), the same refusals; no generic email in connectInfo or an invite result");
  } finally { await http.close(); }

  // ---------- 3. the staff invite popup's source: the removed parts are gone ----------
  {
    const dir = path.join(ROOT, "web", "src", "features", "admin");
    const hits: string[] = [];
    for (const f of readdirSync(dir, { recursive: true }).map(String).filter((x) => /\.tsx?$/.test(x))) {
      const t = readFileSync(path.join(dir, f), "utf8");
      for (const re of [/Optional follow-up/, /<Label>Client setup<\/Label>/, /result\.email\.body/]) if (re.test(t)) hits.push(`${f}: ${re.source}`);
    }
    assert.deepEqual(hits, [], "the invite popup has no Client setup row, no optional follow-up mail header, no generic email");
    ok("the staff invite popup: no Client setup row, no optional follow-up mail header, no generic email");
  }
} finally {
  cleanup();
}
process.exit(0);
