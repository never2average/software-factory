// The agent composer and session numbers (mold_v0-290; src/agent-composer.ts, src/harness-sessions.ts, src/agent-harness.ts,
// src/github-app.ts sessionRepositoryGrant), offline: an embedded database, the run engine in this process, the stand-in
// CLI, a stand-in for GitHub and a local mirror to copy from. `npm run test:agent-harness`, last.
//   1. Pure: how dictation merges with what was typed, its errors in plain words; a file's names and limits; the number's form.
//   2. Numbers: AGI-001 onward per workspace, stored, unique under concurrency, never reused, the same for staff.
//   3. Files: over HTTP (limits, program refused, sealed at rest, a viewer and another person's session refused), carried by the
//      first message into the session's sandbox workspace, named in the message, shown in the trace; a steer mid-wake; a message
//      queued behind a decision; on an ended session; drafts swept.
//   4. Repositories: only the workspace's own and read-only, a token per wake for exactly those, its copy in the sandbox with no
//      history, the token in no answer, transcript, event, working directory or the agent's environment, revoked when the wake ends;
//      a governance policy without github.com, no app, not connected and suspended each refused or stated in words.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { startGithubStandin } from "./lib/github-standin.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = { command: process.execPath, args: [path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs")] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (what: string) => console.log(`✓ ${what}`);
const walkFiles = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]));

const GH_APP_ID = 515151;
const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const CLIENT_ID = `Iv1.${randomBytes(8).toString("hex")}`, CLIENT_SECRET = `client-secret-${randomBytes(16).toString("hex")}`, WEBHOOK_SECRET = `webhook-secret-${randomBytes(16).toString("hex")}`;
const gh = await startGithubStandin({ appId: GH_APP_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, publicKeyPem: PUBLIC_KEY });
gh.installations.set(7001, { id: 7001, app_id: GH_APP_ID, account: { login: "acme", type: "Organization" }, repository_selection: "selected", repositories: [{ id: 11, full_name: "acme/api" }, { id: 12, full_name: "acme/web" }] });

try {
  const V = await import("../web/src/features/agent/composer/voice-transcript.js");
  const AC = await import("../src/agent-composer.js");
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const harness = await import("../src/run-harness.js");
  const H = await import("../src/harness-sessions.js");
  const C = await import("../src/agent-harness-config.js");
  const P = await import("../src/agent-profiles.js");
  const ghApp = await import("../src/github-app.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const { createOrg } = await import("../src/auth.js");
  const { asPlatform } = await import("../src/tenant-scope.js");

  // ---------- 1. pure ----------
  {
    assert.equal(V.composeVoiceInput("typed first", "said words", "still hearing"), "typed first said words still hearing", "typed, then said, then the phrase in progress");
    assert.equal(V.composeVoiceInput("", "", ""), "");
    assert.equal(V.joinTranscripts("before the pause", "after it"), "before the pause after it");
    assert.equal(V.spokenSince("one two three", 3), "two three", "what the person typed over is not said again");
    assert.deepEqual(V.transcriptFromResults([{ isFinal: true, 0: { transcript: "hello " } }, { isFinal: false, 0: { transcript: "wor" } }] as never), { final: "hello", interim: "wor" });
    assert.match(V.voiceErrorWords("not-allowed", false)!.message, /blocked/);
    assert.equal(V.voiceErrorWords("not-allowed", false)!.state, "denied");
    assert.match(V.voiceErrorWords("no-speech", false)!.message, /No speech was heard/, "silence before any word is said in words");
    assert.equal(V.voiceErrorWords("no-speech", true), null, "a pause after words is not an error");
    assert.match(V.voiceErrorWords("network", false)!.message, /speech service could not be reached/);
    assert.equal(V.voiceErrorWords("aborted", false), null);
    assert.equal(AC.displayName("../../etc/pass\u0000wd.txt"), "passwd.txt", "never a path");
    assert.equal(AC.displayName(".env"), "env", "not a hidden file");
    assert.equal(AC.attachmentPath("my report (final).pdf", new Set()), "attachments/my-report-final-.pdf");
    assert.equal(AC.attachmentPath("a.pdf", new Set(["attachments/a.pdf"])), "attachments/a-2.pdf", "two with one name both arrive");
    assert.equal(AC.attachmentPath("..", new Set()), "attachments/file");
    assert.equal(AC.fileIsProgram("a.exe", Buffer.from("x")), true);
    assert.equal(AC.fileIsProgram("a.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])), true, "an ELF by its bytes");
    assert.equal(AC.fileIsProgram("a.py", Buffer.from("#!/usr/bin/env python")), false, "a script is text the agent reads");
    assert.match(AC.attachmentNote({ files: [{ id: "x", name: "a b.pdf", path: "attachments/a-b.pdf", bytes: 2048, sha256: "0" }], repositories: ["acme/api"] }), /attachments\/a-b\.pdf \(2 KB\)[\s\S]*repos\/acme\/api/, "named in the message");
    assert.equal(AC.attachmentNote({}), "", "a plain message carries no note");
    assert.equal(H.sessionRef(1), "AGI-001"); assert.equal(H.sessionRef(1234), "AGI-1234");
    ok("pure: dictation merged with typing and its errors in plain words; names, paths and programs; the number's form");
  }

  F.setFeaturesForTest({ agent_harness: true });
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 2, AGENT_BUDGET_CEILING_USD: 5 });
  P.resetProfileSeedForTest(); await P.ensureProfiles();
  ghApp.setGithubEndpointsForTest({ api: gh.url, web: gh.url });
  const org = (await createOrg(`Composer ${STAMP}`)).org, other = (await createOrg(`Composer other ${STAMP}`)).org;
  const owner = { kind: "person", user: "user_owner", name: "owner@example.org", role: "owner" } as const;
  const member = { kind: "person", user: "user_member", name: "member@example.org", role: "member" } as const;
  const viewer = { kind: "person", user: "user_viewer", name: "viewer@example.org", role: "viewer" } as const;
  const staff = H.staffActor("staff@example.org");
  const client = await harness.localRunnerClient("w-composer");
  // ---------- the mirror a repository's copy comes from ----------
  const bare = path.join(TMP, "mirror", "acme", "api.git"), seed = path.join(TMP, "seed");
  mkdirSync(path.dirname(bare), { recursive: true }); mkdirSync(seed);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.org", "-c", "user.name=T", ...a], { cwd, stdio: "pipe" }).toString().trim();
  git(seed, "init", "-q", "-b", "main"); writeFileSync(path.join(seed, "README.md"), "the api repository\n"); git(seed, "add", "."); git(seed, "commit", "-qm", "first");
  git(TMP, "clone", "-q", "--bare", seed, bare);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  const head = git(seed, "rev-parse", "HEAD");
  gh.state.heads["acme/api"] = head;
  const opts = { allowSameUser: true, egress: "off" as const, agentCli: CLI, pollMs: 50, beatMs: 150,
    repositoryFetch: { remote: (n: string) => `file://${path.join(TMP, "mirror", ...n.split("/"))}.git`, options: { allowFile: true } } };
  const until = async (what: string, f: () => Promise<boolean>, ms = 25_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(80); } };
  const claimWake = async () => { const c = await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]); assert.ok(c, "a wake to claim"); return { claim: c!, done: harness.runWorkspaceHarness(client, c!, opts) }; };
  const said = async (sid: string, a: unknown = owner) => (await H.readSession(org.orgId, sid, a as never)).messages.filter((m) => m.role === "agent").map((m) => m.body).join("\n");
  const end = async (sid: string, w: { done: Promise<unknown> }, a: unknown = owner) => { await H.stopSession(org.orgId, sid, a as never).catch(() => null); await Promise.race([w.done, sleep(15_000)]); };

  // ---------- 2. numbers ----------
  {
    const a = await H.startSession(org.orgId, owner as never, { message: "first" });
    const b = await H.startSession(org.orgId, owner as never, { message: "second" });
    assert.deepEqual([a.ref, b.ref], ["AGI-001", "AGI-002"], "in order of creation");
    const c = await H.startSession(other.orgId, owner as never, { message: "another workspace" });
    assert.equal(c.ref, "AGI-001", "per workspace");
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => H.startSession(other.orgId, owner as never, { message: `at once ${i}` })));
    assert.equal(new Set(many.map((s) => s.ref)).size, 8, "started at once, each its own number");
    assert.equal((await H.readSession(null, a.id, staff)).ref, "AGI-001", "staff see the same number");
    assert.ok((await H.listSessions(org.orgId, owner as never)).every((s) => /^AGI-\d{3}$/.test(s.ref)), "the list carries it");
    const [high] = await asPlatform(() => db.query<{ last_number: number }>("SELECT last_number FROM harness_session_counters WHERE org_id = $1", [org.orgId]));
    await asPlatform(() => db.query("DELETE FROM harness_sessions WHERE org_id = $1 AND id = $2", [org.orgId, b.id]));
    const d = await H.startSession(org.orgId, owner as never, { message: "third" });
    assert.equal(d.ref, `AGI-${String(high!.last_number + 1).padStart(3, "0")}`, "a number is never given again");
    for (const s of [a, c, d, ...many]) await asPlatform(() => db.query("UPDATE harness_sessions SET state = 'stopped', current_run_id = NULL WHERE id = $1", [s.id]));
    await asPlatform(() => db.query("UPDATE runs SET status = 'cancelled' WHERE status = 'queued'"));
    ok("numbers: AGI-001 onward per workspace, stored, distinct when started at once, never given again, the same for staff");
  }

  // ---------- 3. files ----------
  const canary = `file-canary-${randomBytes(8).toString("hex")}`;
  const http = await startHttp();
  const tokenO = await http.signInAs(org, "owner"), tokenV = await http.signInAs(org, "viewer");
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const put = (t: string, name: string, body: Buffer | string, qs = "") => fetch(`${http.base}/api/agent/files${qs}`, { method: "POST", headers: { ...auth(t), "content-type": "application/octet-stream", "x-pack-request": "1", "x-file-name": encodeURIComponent(name), "x-file-type": "text/plain" }, body: body as BodyInit });
  const ownerActor = H.actorOf({ user: tokenO.userId, email: "owner@example.org", accountRole: "owner" } as never);
  {
    const offer = (await (await http.req("GET", "/api/agent/composer", auth(tokenO.token))).json() as { offer: { files: { available: boolean; max_per_message: number; max_file_bytes: number }; repositories: { state: string } } }).offer;
    assert.equal(offer.files.available, true); assert.equal(offer.files.max_per_message, 10);
    assert.equal(offer.repositories.state, "no_app", "no platform app: said, not an error");
    assert.equal((await put(tokenO.token, "tool.exe", "x")).status, 415, "a program refused by name");
    assert.equal((await put(tokenO.token, "a.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1]))).status, 415, "a program refused by its bytes");
    assert.equal((await put(tokenO.token, "big.txt", Buffer.alloc(AC.attachmentMaxBytes() + 1, "a"))).status, 413, "over the limit");
    assert.equal((await put(tokenO.token, "empty.txt", "")).status, 400, "an empty file");
    assert.equal((await put(tokenV.token, "v.txt", "x")).status, 403, "a viewer may not attach");
    const r = await put(tokenO.token, "notes.txt", `the notes ${canary}\n`);
    assert.equal(r.status, 201);
    const f = (await r.json() as { file: { id: string; name: string } }).file;
    assert.equal(f.name, "notes.txt");
    const stored = walkFiles(process.env.APP_STORAGE_DIR!).filter((x) => x.includes(`.agent/attachments/${f.id}`));
    assert.equal(stored.length, 1, "under the workspace's prefix"); assert.ok(!readFileSync(stored[0]!).includes(canary), "sealed at rest");
    const r2 = await put(tokenO.token, "drop.txt", "to remove");
    const drop = (await r2.json() as { file: { id: string } }).file;
    assert.equal((await http.req("DELETE", `/api/agent/files/${drop.id}`, { ...auth(tokenO.token), "x-pack-request": "1" })).status, 200, "removed before sending");
    assert.equal((await http.req("DELETE", `/api/agent/files/${drop.id}`, { ...auth(tokenO.token), "x-pack-request": "1" })).status, 404);

    // Another person cannot send my draft, and it is not theirs to remove.
    await assert.rejects(H.startSession(org.orgId, member as never, { message: "hi", files: [f.id] }), /no longer waiting/, "a draft is its uploader's alone");
    await assert.rejects(AC.removeDraftFile(org.orgId, "user_member", f.id), /no such file/);
    await assert.rejects(H.startSession(other.orgId, ownerActor, { message: "hi", files: [f.id] }), /no longer waiting/, "nor another workspace's");

    // The first message carries it into the sandbox's working directory.
    const s = await H.startSession(org.orgId, ownerActor, { message: "cat attachments/notes.txt", files: [f.id], mode: "conversation" });
    const w = await claimWake();
    await until("it answers", async () => (await said(s.id, ownerActor)).includes(canary));
    assert.match(await said(s.id, ownerActor), new RegExp(`File attachments/notes\\.txt: the notes ${canary}`), "the file is in the session's workspace");
    const trace = await H.sessionTrace(org.orgId, s.id, ownerActor);
    const person = trace.steps.find((x) => x.role === "person")!;
    assert.deepEqual(person.attachments, { files: [{ name: "notes.txt", bytes: Buffer.byteLength(`the notes ${canary}\n`) }], repositories: [] }, "the trace shows what was attached");
    assert.equal(person.body, "cat attachments/notes.txt", "the person's words stay their own");
    await until("the stage is in the trace", async () => (await H.sessionTrace(org.orgId, s.id, ownerActor)).steps.some((x) => /attached file is in its workspace/.test(x.title)));

    // A viewer's or another person's session is refused at the door; staff never reach it.
    await assert.rejects(H.mayCompose(org.orgId, member as never, s.id), /Only the person who started/);
    await assert.rejects(H.mayCompose(org.orgId, staff, s.id), /Staff cannot/);
    assert.equal((await put(tokenO.token, "ok.txt", "x", `?session=${s.id}`)).status, 201, "its starter may");
    assert.equal((await put((await http.signInAs(org, "owner")).token, "no.txt", "x", `?session=${s.id}`)).status, 403, "another owner may not attach to someone else's session");

    // A steer mid-wake: the file is there before its words are.
    const steerFile = (await (await put(tokenO.token, "second.txt", `second ${canary}`, `?session=${s.id}`)).json() as { file: { id: string } }).file;
    await H.messageSession(org.orgId, s.id, ownerActor, "cat attachments/second.txt", undefined, { files: [steerFile.id] });
    await until("the steer's file is read", async () => (await said(s.id, ownerActor)).includes(`second ${canary}`));
    // Parked, the next message wakes it; every attached file is delivered again.
    await H.pauseSession(org.orgId, s.id, ownerActor);
    await Promise.race([w.done, sleep(15_000)]);
    const third = (await (await put(tokenO.token, "third.txt", "third", `?session=${s.id}`)).json() as { file: { id: string } }).file;
    const queued = await H.messageSession(org.orgId, s.id, ownerActor, "files", undefined, { files: [third.id] });
    assert.equal(queued.status, "waking");
    const w2 = await claimWake();
    await until("every file is there on a new wake", async () => /Files:.*attachments\/notes\.txt.*attachments\/second\.txt.*attachments\/third\.txt/.test(await said(s.id, ownerActor)));
    await end(s.id, w2, ownerActor);
    // Ended: a message with a file continues it.
    const after = (await (await put(tokenO.token, "after.txt", "after", `?session=${s.id}`)).json() as { file: { id: string } }).file;
    const cont = await H.messageSession(org.orgId, s.id, ownerActor, "cat attachments/after.txt", undefined, { files: [after.id] });
    assert.equal(cont.status, "continued", "an ended session continues, with its file");
    const w3 = await claimWake();
    await until("the file arrives in the continued session", async () => (await said(s.id, ownerActor)).includes("File attachments/after.txt: after"));
    await end(s.id, w3, ownerActor);

    // Queued behind a pending decision: it waits with its file.
    const s2 = await H.startSession(org.orgId, ownerActor, { message: "hello", mode: "conversation" });
    const w4 = await claimWake();
    await until("it answers", async () => (await said(s2.id, ownerActor)).length > 0);
    await H.pauseSession(org.orgId, s2.id, ownerActor);
    await Promise.race([w4.done, sleep(15_000)]);
    await asPlatform(() => db.query("UPDATE harness_sessions SET state = 'awaiting', state_reason = 'budget' WHERE id = $1", [s2.id]));
    const held = (await (await put(tokenO.token, "held.txt", "held", `?session=${s2.id}`)).json() as { file: { id: string } }).file;
    const q = await H.messageSession(org.orgId, s2.id, ownerActor, "waits", undefined, { files: [held.id] });
    assert.equal(q.status, "queued", "queued behind the decision");
    const [m] = await asPlatform(() => db.query<{ attachments: { files: { name: string }[] } }>("SELECT attachments FROM harness_session_messages WHERE session_id = $1 AND body = 'waits'", [s2.id]));
    assert.equal(m!.attachments.files[0]!.name, "held.txt", "the waiting message holds its file");
    await asPlatform(() => db.query("UPDATE harness_sessions SET state = 'stopped' WHERE id = $1", [s2.id]));

    // A draft nobody sent goes after a day.
    const stale = (await (await put(tokenO.token, "stale.txt", "stale")).json() as { file: { id: string } }).file;
    await asPlatform(() => db.query("UPDATE harness_session_files SET created_at = now() - interval '2 days' WHERE id = $1", [stale.id]));
    assert.ok((await AC.sweepAttachments(new Date(), [])) >= 1);
    assert.equal((await asPlatform(() => db.query("SELECT 1 FROM harness_session_files WHERE id = $1", [stale.id]))).length, 0, "swept");
    ok("files: limits and refusals over HTTP; sealed at rest; a draft its uploader's alone; delivered and named at the start, mid-wake, on a new wake and on an ended session; queued with its message; shown in the trace; swept");
  }

  // ---------- 4. repositories ----------
  {
    assert.equal((await H.composerOffer(org.orgId, ownerActor)).repositories.state, "no_app", "no app");
    await assert.rejects(H.startSession(org.orgId, ownerActor, { message: "x", repositories: ["acme/api"] }), /GitHub App is not set up/);
    await ghApp.setAppConfig({ app_id: String(GH_APP_ID), slug: "composer-app", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, private_key: PRIVATE_KEY, webhook_secret: WEBHOOK_SECRET });
    assert.equal((await H.composerOffer(org.orgId, ownerActor)).repositories.state, "not_connected", "app but no connection: said");
    await assert.rejects(H.startSession(org.orgId, ownerActor, { message: "x", repositories: ["acme/api"] }), /has not connected GitHub/);
    await asPlatform(() => db.query(`INSERT INTO workspace_github_installations (org_id, installation_id, account_login, account_type, repository_selection, repositories, connected_by) VALUES ($1, 7001, 'acme', 'Organization', 'selected', $2::jsonb, 'owner')`,
      [org.orgId, JSON.stringify([{ id: 11, full_name: "acme/api" }, { id: 12, full_name: "acme/web" }])]));
    const offer = await H.composerOffer(org.orgId, ownerActor);
    assert.equal(offer.repositories.state, "ready"); assert.deepEqual(offer.repositories.repositories, ["acme/api", "acme/web"]);
    assert.ok(!/token/i.test(JSON.stringify(offer.repositories.repositories)) && !Object.keys(offer.repositories).includes("token"), "no token offered");
    await assert.rejects(H.startSession(org.orgId, ownerActor, { message: "x", repositories: ["acme/secrets"] }), /not one of the repositories/, "only what the installation allows");
    await assert.rejects(H.startSession(other.orgId, ownerActor, { message: "x", repositories: ["acme/api"] }), /has not connected GitHub/, "another workspace's connection is not this one's");

    const s = await H.startSession(org.orgId, ownerActor, { message: "cat repos/acme/api/README.md", repositories: ["ACME/api"], mode: "conversation" });
    const w = await claimWake();
    await until("it reads the repository", async () => (await said(s.id, ownerActor)).includes("the api repository"));
    assert.deepEqual((await H.composerOffer(org.orgId, ownerActor, s.id)).repositories.granted, ["acme/api"], "the picker says what it can read already");
    const minted = gh.minted.filter((t) => t.repository_ids?.length === 1 && t.repository_ids[0] === 11);
    assert.equal(minted.length, 1, "one token for this wake and this repository");
    assert.deepEqual(minted[0]!.permissions, { contents: "read", metadata: "read" }, "contents:read only (GitHub adds read metadata to every token), never more");
    assert.deepEqual(minted[0]!.repository_ids, [11], "and only the chosen repository");
    const token = minted[0]!.token;
    await H.messageSession(org.orgId, s.id, ownerActor, "run git -C repos/acme/api status");
    await until("no git history in the copy", async () => /not a git repository|Ran: (128|127)/.test(await said(s.id, ownerActor)));
    await H.messageSession(org.orgId, s.id, ownerActor, "run env");
    await until("its environment listed", async () => /Ran: 0 /.test(await said(s.id, ownerActor)));
    const answer = await said(s.id, ownerActor);
    assert.ok(!answer.includes(token) && !answer.includes("repository access"), "the agent's own environment never held it (not even redacted)");
    const detail = JSON.stringify(await H.readSession(org.orgId, s.id, ownerActor)) + JSON.stringify(await H.sessionTrace(org.orgId, s.id, ownerActor));
    assert.ok(!detail.includes(token), "the token is in no answer and not in the transcript");
    assert.ok(detail.includes("acme/api") && /gave this session read access to acme\/api/.test(detail), "the trace says which repository");
    const events = await asPlatform(() => db.query("SELECT type, data FROM run_events WHERE run_id = $1", [w.claim.run.id]));
    assert.ok(!JSON.stringify(events).includes(token), "nor in a run event");
    const [row] = await asPlatform(() => db.query<{ sealed: string }>("SELECT sealed FROM run_github_app_tokens WHERE run_id = $1 AND name = $2", [w.claim.run.id, ghApp.SESSION_REPOSITORY_NAME]));
    assert.ok(row && !Buffer.from(row.sealed, "base64").includes(token), "kept sealed");
    assert.ok((await gh.read(token, "acme/web")) === 404, "the token reaches only the chosen repository");
    await end(s.id, w, ownerActor);
    await ghApp.flushRevocations();
    assert.equal(gh.minted.find((t) => t.token === token)?.revoked, true, "revoked when the wake ends");

    // What cannot be given is said to the agent and the trace, never a broader token.
    await asPlatform(() => db.query("UPDATE workspace_github_installations SET suspended_at = now() WHERE org_id = $1", [org.orgId]));
    assert.equal((await H.composerOffer(org.orgId, ownerActor)).repositories.state, "suspended");
    await assert.rejects(H.messageSession(org.orgId, s.id, ownerActor, "x", undefined, { repositories: ["acme/web"] }), /suspended/);
    await asPlatform(() => db.query("UPDATE workspace_github_installations SET suspended_at = NULL WHERE org_id = $1", [org.orgId]));

    // An empty repository is named as such.
    const empty = await H.startSession(org.orgId, ownerActor, { message: "said", repositories: ["acme/web"], mode: "conversation" });
    const we = await claimWake();
    await until("told it could not be given", async () => /acme\/web \(it is empty\)/.test(await said(empty.id, ownerActor)));
    await end(empty.id, we, ownerActor);

    // Governance: a policy without github.com takes no repository.
    const g = await H.startSession(org.orgId, ownerActor, { message: "hi", mode: "conversation" });
    await asPlatform(() => db.query(`UPDATE harness_sessions SET policy = policy || '{"governance":{"web":{"enabled":true,"web_fetch_enabled":true,"web_fetch_allowed_domains":["docs.example.com"]}}}'::jsonb WHERE id = $1`, [g.id]));
    await assert.rejects(H.messageSession(org.orgId, g.id, ownerActor, "x", undefined, { repositories: ["acme/api"] }), /governance policy does not allow github\.com/);
    assert.match((await H.composerOffer(org.orgId, ownerActor, g.id)).repositories.refused!, /governance policy/);
    await asPlatform(() => db.query(`UPDATE harness_sessions SET policy = policy || '{"governance":{"web":{"enabled":true,"web_fetch_enabled":true,"web_fetch_allowed_domains":["github.com"]}}}'::jsonb WHERE id = $1`, [g.id]));
    assert.equal((await H.composerOffer(org.orgId, ownerActor, g.id)).repositories.refused, null, "allowed when its policy names it");
    await asPlatform(() => db.query("UPDATE harness_sessions SET state = 'stopped', current_run_id = NULL WHERE id = $1", [g.id]));
    ok("repositories: only the workspace's own, read-only, one token per wake for exactly those; a copy with no history; the token in no answer, transcript, event or the agent's environment, sealed and revoked; refusals in words");
  }
  await http.close();
  F.setFeaturesForTest(null);
  console.log("\nthe agent composer (mold_v0-290): all checks passed");
} finally {
  await gh.close();
  cleanup();
}
process.exit(0);
