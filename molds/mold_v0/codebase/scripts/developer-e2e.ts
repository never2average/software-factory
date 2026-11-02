// The developer surface end to end (mold_v0-193), over a running dev server with the embedded fixture pack
// (scripts/fixtures/packs/fixture_embedded):
//   npm run test:developer-e2e            (needs the network once: the Standard Webhooks reference libraries, npm and PyPI)
//
//  1. a workspace owner mints a key in the console (/api/developer/keys)
//  2. the OpenAPI document is read from the running server (/openapi.json) and the SDKs generated from it
//     (scripts/gen-sdks.ts: TypeScript and Python), with the publish dry run (nothing is published)
//  3. the TypeScript SDK's declarations type-check a consumer (tsc --strict), and a wrong call fails to compile
//  4. through the generated JS SDK: areas, a webhook endpoint, an idempotent write replayed (no 409), a client session
//     minted and used (it reads; it cannot write), a run started
//  5. through the generated Python SDK: the same reads and writes, an idempotent write replayed, a client session
//  6. a local receiver gets the signed webhooks, verified with the Standard Webhooks reference library in JavaScript
//     (npm standardwebhooks) and in Python (PyPI standardwebhooks)
// The SDK outputs and the reference libraries live in a temporary folder, removed at the end.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { installEmbedded } from "./lib/embedded-fixture.js";

process.env.APP_PREVIEW = "1"; // the dev server's rule: a local webhook receiver is allowed
const ROOT = path.resolve(import.meta.dirname, "..");
// Asynchronous: the server answering the children runs in this process (a synchronous child would block it).
const execFileP = promisify(execFile);
const run = async (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  (await execFileP(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
const proofs: string[] = [];
const proof = (s: string) => { proofs.push(s); console.log(`✓ ${s}`); };

try {
  await installEmbedded();
  const { createOrg } = await import("../src/auth.js");
  const hooks = await import("../src/developer-webhooks.js");
  const A = (await createOrg(`E2E ${STAMP}`)).org;
  const http = await startHttp();
  const got: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const recv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ headers: req.headers, body: b }); res.writeHead(204).end(); }); });
  await new Promise<void>((r) => recv.listen(0, "127.0.0.1", r));
  const RECEIVER = `http://127.0.0.1:${(recv.address() as AddressInfo).port}/hooks`;
  try {
    // ---------- 1. a key ----------
    const owner = await http.signIn(A, "owner");
    const mk = await http.req("POST", "/api/developer/keys", { authorization: `Bearer ${owner}`, "x-pack-request": "1" }, { name: "E2E backend" });
    assert.equal(mk.status, 201);
    const KEY = (await mk.json()).key as string;
    proof(`an owner minted a key in the console (prefix ${KEY.slice(0, 9)}, shown once)`);

    // ---------- 2. OpenAPI and the SDKs ----------
    const doc = await (await fetch(`${http.base}/openapi.json`)).json() as any;
    assert.equal(doc.openapi, "3.1.0");
    const OUT = path.join(TMP, "sdk");
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(TMP, "openapi.json"), JSON.stringify(doc));
    const gen = await run(process.execPath, ["--import", "tsx", "scripts/gen-sdks.ts", "--openapi", path.join(TMP, "openapi.json"), "--out", OUT, "--publish-dry-run"]);
    assert.match(gen, /npm \(dry run, nothing published\)/);
    assert.match(gen, /PyPI \(dry run, nothing published\)/);
    proof(`OpenAPI ${doc.openapi} read from the running server (${Object.keys(doc.paths).length} paths, ${Object.keys(doc.webhooks).length} webhook events); SDKs generated (${doc["x-sdk"].npm}, ${doc["x-sdk"].python}); publish dry run only`);

    // ---------- 3. the TypeScript declarations ----------
    const ts = path.join(TMP, "consumer");
    mkdirSync(ts, { recursive: true });
    writeFileSync(path.join(ts, "ok.ts"), `import { Client, ApiError, type TicketsRecord } from "../sdk/typescript/index.js";
const api = new Client({ baseUrl: "http://x", token: "sk_x" });
export async function f(): Promise<TicketsRecord[]> {
  const page = await api.records.tickets.list({ limit: 10, filter: { severity: "high" } });
  await api.records.tickets.create({ key: "a", data: { summary: "s", severity: "low" } }, { idempotencyKey: "k" });
  await api.records.tickets.move("a", { to: "closed" });
  try { await api.runs.start({ kind: "triage" }); } catch (e) { if (e instanceof ApiError) console.log(e.code); }
  return page.data;
}
`);
    writeFileSync(path.join(ts, "bad.ts"), `import { Client } from "../sdk/typescript/index.js";
const api = new Client({ baseUrl: "http://x", token: "sk_x" });
export const g = () => api.records.tickets.create({ key: "a", data: { summary: "s", severity: "huge" } });
`);
    const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
    const flags = ["--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--lib", "es2022,dom", "--skipLibCheck"];
    await run(tsc, [...flags, path.join(ts, "ok.ts")], { cwd: ts });
    let failed = "";
    try { await run(tsc, [...flags, path.join(ts, "bad.ts")], { cwd: ts }); } catch (e) { failed = String((e as { stdout?: string }).stdout ?? ""); }
    assert.match(failed, /"huge"/, "an enum value the area does not have fails to compile");
    proof("the TypeScript SDK type-checks a consumer under --strict; a wrong enum value fails to compile");

    // ---------- the Standard Webhooks reference libraries ----------
    const LIB = path.join(TMP, "swh");
    mkdirSync(LIB, { recursive: true });
    await run("npm", ["install", "--prefix", LIB, "--no-audit", "--no-fund", "--silent", "standardwebhooks@1"]);
    await run("python3", ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--target", path.join(LIB, "py"), "standardwebhooks"]);
    const { Webhook } = await import(pathToFileURL(path.join(LIB, "node_modules", "standardwebhooks", "dist", "index.js")).href);

    // ---------- 4. the JavaScript SDK ----------
    const jsScript = path.join(TMP, "js-client.mjs");
    writeFileSync(jsScript, `import { Client, ApiError } from ${JSON.stringify(pathToFileURL(path.join(OUT, "typescript", "index.js")).href)};
const out = {};
const api = new Client({ baseUrl: process.env.API_URL, token: process.env.API_KEY });
out.areas = (await api.areas.list()).data.map((a) => a.name).sort();
const ep = (await api.webhook_endpoints.create({ url: process.env.RECEIVER, description: "e2e" })).data;
out.secret = ep.secret;
const first = await api.records.tickets.create({ key: "JS-1", title: "From JS", data: { summary: "made by the JS SDK", severity: "high" } }, { idempotencyKey: "e2e-js-1", actor: "host-user-1" });
const again = await api.records.tickets.create({ key: "JS-1", title: "From JS", data: { summary: "made by the JS SDK", severity: "high" } }, { idempotencyKey: "e2e-js-1", actor: "host-user-1" });
out.replayed = JSON.stringify(first) === JSON.stringify(again);
try { await api.records.tickets.create({ key: "JS-1", data: { summary: "x" } }); out.dup = "no error"; } catch (e) { out.dup = e instanceof ApiError ? e.code : String(e); }
await api.records.tickets.move("JS-1", { to: "in_progress" });
const cs = (await api.client_sessions.create({ subject: "host-user-1", scopes: ["read"], ttl_seconds: 120 })).data;
const browser = new Client({ baseUrl: process.env.API_URL, token: cs.token });
out.sessionRead = (await browser.records.tickets.list({ limit: 5 })).data.map((r) => r.key);
try { await browser.records.tickets.create({ key: "CS-1", data: { summary: "x" } }); out.sessionWrite = "allowed"; } catch (e) { out.sessionWrite = e.code; }
out.run = (await api.runs.start({ kind: "triage", scope: {} })).data.status;
out.page = (await api.records.tickets.list({ limit: 1 })).next !== null;
console.log(JSON.stringify(out));
`);
    const js = JSON.parse((await run(process.execPath, [jsScript], { env: { API_URL: http.base, API_KEY: KEY, RECEIVER } })).trim().split("\n").pop()!);
    assert.deepEqual(js.areas, ["findings", "tickets"]);
    assert.equal(js.replayed, true, "the same Idempotency-Key and request answered the same, no 409");
    assert.equal(js.dup, "conflict", "a create without the key is a 409 problem (ApiError.code)");
    assert.deepEqual(js.sessionRead, ["JS-1"]);
    assert.equal(js.sessionWrite, "insufficient_scope");
    assert.equal(js.run, "queued");
    assert.match(js.secret, /^whsec_/);
    proof("JS SDK: areas listed; webhook endpoint added; an idempotent create replayed (no 409); a duplicate refused as ApiError conflict; a move; a client session minted and used to read (its write refused: insufficient_scope); a run started; cursor pages");

    // ---------- 5. the Python SDK ----------
    const pyScript = path.join(TMP, "py_client.py");
    writeFileSync(pyScript, `import json, os, sys
sys.path.insert(0, os.path.join(${JSON.stringify(OUT)}, "python"))
from ${doc["x-sdk"].python} import Client, ApiError
api = Client(base_url=os.environ["API_URL"], token=os.environ["API_KEY"])
out = {}
out["areas"] = sorted(a["name"] for a in api.areas.list()["data"])
a = api.records.tickets.create({"key": "PY-1", "title": "From Python", "data": {"summary": "made by the Python SDK", "severity": "medium", "points": 3}}, idempotency_key="e2e-py-1")
b = api.records.tickets.create({"key": "PY-1", "title": "From Python", "data": {"summary": "made by the Python SDK", "severity": "medium", "points": 3}}, idempotency_key="e2e-py-1")
out["replayed"] = a == b
try:
    api.records.tickets.create({"key": "PY-1", "data": {"summary": "x"}}, idempotency_key="e2e-py-2")
    out["reused"] = "no error"
except ApiError as e:
    out["reused"] = e.code
api.records.findings.create({"key": "PF-1", "data": {"severity": "low", "scanner": "e2e"}})
out["get"] = api.records.tickets.get("PY-1")["data"]["data"]["points"]
out["filtered"] = [r["key"] for r in api.records.tickets.list(filter={"severity": "medium"})["data"]]
cs = api.client_sessions.create({"subject": "host-user-2", "scopes": ["read"]})["data"]
browser = Client(base_url=os.environ["API_URL"], token=cs["token"])
out["session_read"] = len(browser.records.tickets.list(limit=10)["data"])
api.records.tickets.delete("PY-1")
try:
    api.records.tickets.get("PY-1")
except ApiError as e:
    out["deleted"] = e.code
print(json.dumps(out))
`);
    const py = JSON.parse((await run("python3", ["-I", pyScript], { env: { API_URL: http.base, API_KEY: KEY } })).trim().split("\n").pop()!);
    assert.deepEqual(py.areas, ["findings", "tickets"]);
    assert.equal(py.replayed, true);
    assert.equal(py.reused, "conflict", "a new key for the same create: a 409");
    assert.equal(py.get, 3);
    assert.deepEqual(py.filtered, ["PY-1"]);
    assert.ok(py.session_read >= 2);
    assert.equal(py.deleted, "not_found");
    proof("Python SDK: areas listed; an idempotent create replayed; a reused create refused (conflict); get, a filtered list, a client session reading, a delete then not_found");

    // ---------- 6. signed webhooks, verified with the reference libraries ----------
    await hooks.settled();
    await new Promise((r) => setTimeout(r, 300));
    await hooks.settled();
    assert.ok(got.length >= 4, `webhooks received (${got.length})`);
    const wh = new Webhook(js.secret);
    const types: string[] = [];
    for (const g of got) {
      const v = wh.verify(g.body, { "webhook-id": String(g.headers["webhook-id"]), "webhook-timestamp": String(g.headers["webhook-timestamp"]), "webhook-signature": String(g.headers["webhook-signature"]) });
      types.push(v.type);
    }
    assert.ok(types.includes("record.created") && types.includes("record.state_changed") && types.includes("record.deleted"), types.join(", "));
    const created = got.map((g) => JSON.parse(g.body)).find((e) => e.type === "record.created" && e.data.key === "JS-1");
    assert.equal(created.data.actor, `key:${KEY.slice(0, 9)} as host-user-1`, "the asserted actor rides the event");
    assert.equal(got.map((g) => JSON.parse(g.body)).filter((e) => e.type === "record.created" && e.data.key === "JS-1").length, 1, "the replayed write raised one event");
    let tampered = false;
    try { wh.verify(got[0]!.body.replace("JS-1", "JS-2"), { "webhook-id": String(got[0]!.headers["webhook-id"]), "webhook-timestamp": String(got[0]!.headers["webhook-timestamp"]), "webhook-signature": String(got[0]!.headers["webhook-signature"]) }); }
    catch { tampered = true; }
    assert.ok(tampered, "a changed body fails verification");
    writeFileSync(path.join(TMP, "received.json"), JSON.stringify(got.map((g) => ({ body: g.body, headers: { "webhook-id": g.headers["webhook-id"], "webhook-timestamp": g.headers["webhook-timestamp"], "webhook-signature": g.headers["webhook-signature"] } }))));
    const pyv = (await run("python3", ["-I", "-c", `import json, sys
sys.path.insert(0, sys.argv[3])
from standardwebhooks.webhooks import Webhook
wh = Webhook(sys.argv[2])
n = 0
for m in json.load(open(sys.argv[1])):
    wh.verify(m["body"], m["headers"])
    n += 1
print(n)`, path.join(TMP, "received.json"), js.secret, path.join(LIB, "py")])).trim();
    assert.equal(Number(pyv), got.length);
    proof(`${got.length} signed webhooks received at a local receiver (${[...new Set(types)].sort().join(", ")}), each verified with the Standard Webhooks reference library in JavaScript and in Python; a tampered body fails; the actor rides the event; the replayed write raised one event`);
  } finally {
    recv.close();
    await http.close();
  }
  console.log(`developer e2e: ${proofs.length} proofs passed`);
} finally {
  await (await import("../src/developer-webhooks.js")).settled().catch(() => {});
  cleanup();
}
process.exit(0);
