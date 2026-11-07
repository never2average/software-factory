// The Overview's Connect card and its setup email (mold_v0-277), offline: the shell's server in this process (an embedded
// database, the offline Clerk, the test email transport), zero packs.
//   npm run test:setup-email
//
// 1. The email is built ONLY for the clients chosen: one client's subject and body name it, its own way in (one-click
//    link, config file and snippet, command) and the connection URL, and no other client; three clients, each of the
//    three in the order chosen, and none of the rest; the same choice twice is the same email.
// 2. Refused (a 400, nothing sent): no choice, an empty one, a choice that is not a list, an unknown client id, more
//    than five clients; the person's own address only (no `to` is read), and a session without one is refused.
// 3. Sent: to the signed-in person's own address, through the one email adapter, with the previewed subject and text;
//    the same choice pressed again within minutes is a duplicate, never a second email.
// 4. The staff console's invite result carries no generic email any more; its POST /setup-email builds the same email
//    for the clients a staff member picks, the key's place a placeholder (the key never sent back), with the same refusals.
// 5. Removed (mold_v0-277): the Setup page has no row for adding the connector or switching its tools on, the console
//    has no tips block, no "Optional follow-up" mail header, no "Client setup" row; the old generic list is gone.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, startHttp, STAMP } from "./lib/test-world.js";

process.env.APP_EMAIL_PROVIDER = "test";
const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (s: string) => console.log(`✓ ${s}`);

try {
  const { PROFILE } = await import("../src/profile.js");
  const { clientCatalog } = await import("../src/connect-catalog.js");
  const { chosenClients, setupEmailText, SetupEmailError, MAX_SETUP_CLIENTS } = await import("../src/setup-email.js");
  const mail = await import("../src/email.js");
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
      [["cursor", "nope"], /Unknown AI client: "nope"/], [catalog.slice(0, MAX_SETUP_CLIENTS + 1).map((c) => c.id), /at most 5/]] as const)
      assert.throws(() => chosenClients(bad, catalog), (e: Error) => e instanceof SetupEmailError && why.test(e.message), `refused: ${JSON.stringify(bad)}`);
    ok("the email is built only for the clients chosen: one client's subject, its own install link, file, snippet and the URL, no other client named; three in the order chosen and none of the rest; refusals: none, empty, not a list, unknown, more than five");
  }

  const http = await startHttp();
  try {
    const { createOrg } = await import("../src/auth.js");
    const { org } = await createOrg(`Setup email ${STAMP}`);
    const owner = await http.signInAs(org, "owner");
    const call = async (method: string, p: string, body?: unknown, token = owner.token) => {
      const r = await http.req(method, `/api/app${p}`, { authorization: `Bearer ${token}` }, body);
      return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) as any };
    };

    // ---------- 5. the Setup page: no client-setup or settings row ----------
    const setup = (await call("GET", "/setup")).body;
    assert.deepEqual(setup.steps.map((s: { id: string }) => s.id), ["joined", "first_call"], "the Setup page's steps: joining and a first question, no connect or tools row");
    assert.ok(!setup.steps.some((s: { label: string }) => /connector to your AI client|tools on/i.test(s.label)), "no step asks to add the connector or switch its tools on");
    assert.deepEqual([setup.done, setup.total], [1, 2]);
    assert.ok(setup.email && /@example\.org$/.test(setup.email), "the setup data names the person's own address, where Send setup by email goes");
    assert.ok(!("email" in setup.connect), "the connection carries no generic email");
    assert.ok(setup.connect.clients.length > 5 && setup.connect.clients.every((c: { id: string }) => typeof c.id === "string"), "the client catalogue, for the dropdown and the checkboxes");
    assert.equal((await call("GET", "/nudges")).status, 404, "no tips list for the Overview");
    ok("the Setup page: joined and first_call only (no client-setup or settings row), the person's own address, the catalogue; no generic email, no tips list");

    // ---------- 1 and 2 over the API: preview ----------
    const url = setup.connect.connector_url as string;
    const one = await call("POST", "/setup/email/preview", { clients: ["cursor"] });
    assert.equal(one.status, 200);
    assert.equal(one.body.subject, `Set up ${NAME} in Cursor`);
    assert.ok(one.body.body.includes(url) && one.body.body.includes("~/.cursor/mcp.json"), "the URL and Cursor's own file");
    assert.equal(one.body.to, setup.email, "the preview says where it goes");
    for (const n of setup.connect.clients.map((c: { client: string }) => c.client).filter((n: string) => n !== "Cursor")) assert.ok(!one.body.body.includes(n), `preview: never ${n}`);
    const three = await call("POST", "/setup/email/preview", { clients: ["claude", "cursor", "claude-code"] });
    assert.deepEqual(three.body.clients, ["claude", "cursor", "claude-code"]);
    assert.match(three.body.subject, /in Claude \(web & desktop\), Cursor and Claude Code$/);
    for (const [body, why] of [[{}, /must be a list/], [{ clients: [] }, /at least one/], [{ clients: "cursor" }, /must be a list/], [{ clients: ["cursor", "made-up"] }, /Unknown AI client/],
      [{ clients: setup.connect.clients.slice(0, 6).map((c: { id: string }) => c.id) }, /at most 5/]] as const) {
      const r = await call("POST", "/setup/email/preview", body);
      assert.equal(r.status, 400, `preview refused: ${JSON.stringify(body)}`);
      assert.match(r.body.error, why);
    }
    ok("preview over the API: one client and three, only theirs; refused with a 400 for none, empty, not a list, unknown, more than five");

    // ---------- 3. sent: to the person's own address only ----------
    mail.clearTestOutbox();
    for (const body of [{ clients: [] }, { clients: ["nope"] }]) assert.equal((await call("POST", "/setup/email", body)).status, 400, `send refused: ${JSON.stringify(body)}`);
    assert.equal(mail.testOutbox().length, 0, "a refused choice sends nothing");
    const sent = await call("POST", "/setup/email", { clients: ["cursor"], to: "someone-else@example.com" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual([sent.body.status, sent.body.to], ["sent", setup.email]);
    const m = mail.testOutbox().at(-1)!;
    assert.deepEqual([m.to, m.kind, m.subject], [setup.email, "setup", `Set up ${NAME} in Cursor`], "to the signed-in person, never an address in the request");
    assert.ok(m.text.startsWith(one.body.body), "the text the preview showed");
    assert.equal((await call("POST", "/setup/email", { clients: ["cursor"] })).body.status, "duplicate", "the same choice again within minutes: a duplicate");
    assert.equal(mail.testOutbox().length, 1, "one email, not two");
    assert.equal((await call("POST", "/setup/email", { clients: ["cursor", "claude"] })).body.status, "sent", "another choice is another email");
    assert.equal(mail.testOutbox().length, 2);
    ok("sent through the one adapter to the signed-in person's own address (a `to` in the request is ignored), the previewed subject and text; the same choice again is a duplicate");

    // ---------- 4. the staff console ----------
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

  // ---------- 5. the console's source: the removed parts are gone ----------
  {
    const web = path.join(ROOT, "web", "src");
    const files = readdirSync(web, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f) && !f.includes(".generated."));
    const hits: string[] = [];
    for (const f of files) {
      const t = readFileSync(path.join(web, f), "utf8");
      for (const re of [/Tips for you/, /Suggestions to get more out of/, /Show tips in my AI client/, /Optional follow-up/, /<Label>Client setup<\/Label>/, /TipsSection/, /Pick your client/, /connect\.email\b/, /result\.email\.body/])
        if (re.test(t)) hits.push(`${f}: ${re.source}`);
    }
    assert.deepEqual(hits, [], "the tips block, the optional follow-up mail header, the Client setup row and the generic email are gone from the console");
    const setup = readFileSync(path.join(web, "features", "portal", "setup.tsx"), "utf8");
    assert.match(setup, /<ConnectCard /, "the Overview draws the Connect card");
    assert.match(setup, /\/setup\/email\/preview/, "its email is the server's, for the chosen clients");
    const app = readFileSync(path.join(ROOT, "src", "app.ts"), "utf8");
    assert.doesNotMatch(app, /Add the \$\{P\} connector to your AI client|Switch the \$\{P\} tools on/, "the server has no connect or tools row");
    ok("removed from the console's source: Tips for you and its switch, the optional follow-up mail header, the Client setup row, the generic email; the server's connect and tools rows");
  }
} finally {
  cleanup();
}
process.exit(0);
