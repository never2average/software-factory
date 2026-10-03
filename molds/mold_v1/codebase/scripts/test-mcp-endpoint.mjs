/**
 * The hosted MCP endpoint (/api/mcp): who may talk to it, what it offers, and
 * that a tool call reaches the Ops API as the caller.
 *
 * Drives lib/mcp-server.ts — the function the route calls — in-process. Auth is
 * REAL (a session token minted and verified with a throwaway ES256 key, the
 * same verifier the Ops API uses for email sessions); the Ops API is a recording
 * fake, because the claim under test is what this endpoint SENDS it.
 *
 * Run:  npm run test:mcp-endpoint
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { FOLDER } from "../agent/lib/dataroom-folders.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
};

const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(kp.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(kp.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
delete process.env.VERCEL;

const session = await import("../lib/auth-session.ts");
const { handleMcpRequest, MAX_BODY_BYTES, MAX_BATCH, MAX_RESULT_CHARS } = await import("../lib/mcp-server.ts");
const { createTools } = await import("../setup/workspace-tools.mjs");
const { mcpConnect, productSlug } = await import("../lib/mcp-connect.ts");

const ORIGIN = "https://research.example.com";
const PRODUCT = "Acme Research";
const token = await session.mintSessionToken("analyst@example.com");

/** The recording Ops API. */
const calls = [];
let opsReply = () => Response.json({ customers: [{ customerId: "northwind" }] });
const fetchImpl = async (url, init) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
  return opsReply(String(url), init);
};
const deps = {
  productName: PRODUCT,
  verifyAuth: async (header) => {
    const email = await session.verifySessionToken(header?.replace(/^Bearer\s+/i, "") ?? null);
    return email ? { email } : null;
  },
  readSpec: async () => "# dm.md",
  folders: FOLDER,
  fetchImpl,
};
const post = (body, headers = {}) =>
  handleMcpRequest(
    new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );
const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

/* ---- who may talk to it --------------------------------------------------- */

let res = await post(rpc(1, "initialize"), { authorization: "" });
let body = await res.json();
check("no token -> 401", res.status === 401);
check("401 carries WWW-Authenticate: Bearer", /^Bearer /.test(res.headers.get("www-authenticate") ?? ""));
check("401 body is a JSON-RPC error", body.jsonrpc === "2.0" && body.error?.code === -32001 && body.id === null);
check("401 says how to get a token, at THIS address", body.error.message.includes(`${ORIGIN}/api/auth/email/request`));

res = await post(rpc(1, "tools/list"), { authorization: "Bearer not.a.token" });
check("a bad token -> 401, even for tools/list", res.status === 401);

res = await post(rpc(1, "initialize"), { origin: "https://evil.example" });
check("a foreign Origin -> 403", res.status === 403);
check("403 is JSON-RPC shaped", (await res.json()).error?.code === -32000);
res = await post(rpc(1, "initialize"), { origin: "https://evil.example", authorization: "" });
check("a foreign Origin is refused before auth is even looked at", res.status === 403);
res = await post(rpc(1, "ping"), { origin: ORIGIN });
check("this deployment's own Origin is accepted", res.status === 200);
check("no CORS header is ever sent", res.headers.get("access-control-allow-origin") === null);

res = await handleMcpRequest(new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${token}` } }), deps);
check("GET -> 405 with Allow: POST (no server stream, stateless)", res.status === 405 && res.headers.get("allow") === "POST");

/* ---- protocol ------------------------------------------------------------- */

res = await post(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
body = await res.json();
check("initialize -> 200 JSON", res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json"));
check("serverInfo names the PRODUCT, not the base product's role word", body.result.serverInfo.name === "acme-research" && body.result.serverInfo.title === PRODUCT);
check("the client's protocol version is echoed when supported", body.result.protocolVersion === "2025-06-18");
check("instructions name this deployment's address", body.result.instructions.includes(ORIGIN) && body.result.instructions.includes(PRODUCT));
check("instructions name no other product's address", !/fde-agent\.vercel\.app|useimmaculate/.test(body.result.instructions));
check("no session id is issued (stateless)", res.headers.get("mcp-session-id") === null);
check("initialize needs no Ops API call (so no database)", calls.length === 0);

body = await (await post(rpc(1, "initialize", { protocolVersion: "1999-01-01" }))).json();
check("an unknown protocol version is answered with one we speak", body.result.protocolVersion === "2025-11-25");
res = await post(rpc(1, "ping"), { "mcp-protocol-version": "1999-01-01" });
check("an unsupported MCP-Protocol-Version header -> 400", res.status === 400);

res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
check("a notification -> 202, empty body", res.status === 202 && (await res.text()) === "");

body = await (await post(rpc(7, "ping"))).json();
check("ping", body.id === 7 && JSON.stringify(body.result) === "{}");
body = await (await post(rpc(8, "resources/list"))).json();
check("an unknown method -> -32601", body.error?.code === -32601 && body.id === 8);
res = await post("{not json");
check("unparseable body -> 400 / -32700", res.status === 400 && (await res.json()).error.code === -32700);
res = await post(rpc(1, "ping"), { "content-type": "text/plain" });
check("a non-JSON content type -> 415", res.status === 415);

/* ---- the tools cannot drift from the package ------------------------------ */

body = await (await post(rpc(2, "tools/list"))).json();
const hosted = body.result.tools.map((t) => t.name);
const shared = createTools({ api: async () => ({}), getOrg: () => null, setOrg() {}, identity: async () => null, folders: FOLDER }).map((t) => t.name);
assert.deepEqual(hosted, shared, "hosted tools/list === the shared definitions");
passed++;

/* …and the stdio package, asked the same question over its real transport. */
const cliNames = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "setup/workspace-mcp.mjs"], {
    env: { ...process.env, HOME: "/nonexistent", WORKSPACE_OPS_URL: ORIGIN, BLOB_READ_WRITE_TOKEN: "" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
    const line = out.split("\n").find((l) => l.includes('"id":2'));
    if (line) {
      child.kill();
      resolve(JSON.parse(line).result.tools.map((t) => t.name));
    }
  });
  child.on("error", reject);
  setTimeout(() => reject(new Error("the stdio server did not answer tools/list")), 20_000).unref();
  child.stdin.write(`${JSON.stringify(rpc(2, "tools/list"))}\n`);
});
assert.deepEqual(hosted, cliNames, "hosted tools/list === the stdio package's tools/list");
passed++;
check("there are tools at all", hosted.length > 50 && hosted.includes("workspace_status") && hosted.includes("dataroom_write"));
/* The orientation tool is `workspace_status` on both transports, and NEITHER advertises the
 * name it had before — an alias exists to be accepted by tools/call, never offered by
 * tools/list, or a newly connected assistant learns the old name all over again. */
check("neither transport advertises the pre-rename tool name", !hosted.includes("fde_status") && !cliNames.includes("fde_status"));
check("every tool has a schema and a description", body.result.tools.every((t) => t.description && t.inputSchema?.type === "object"));
check("no tool description carries a credential or a foreign address", !/GOCSPX|fde-agent\.vercel\.app|useimmaculate|Bearer ey/.test(JSON.stringify(body.result.tools)));

/* ---- a tool call reaches the Ops API as the caller ------------------------ */

calls.length = 0;
body = await (await post(rpc(3, "tools/call", { name: "customer_list", arguments: {} }), { "x-ops-org": "org-acme" })).json();
check("one Ops API call was made", calls.length === 1);
check("…to THIS deployment's Ops API", calls[0].url === `${ORIGIN}/api/ops/customers` && calls[0].method === "GET");
check("…with the caller's own Authorization", calls[0].headers.authorization === `Bearer ${token}`);
check("…and the caller's workspace header", calls[0].headers["x-ops-org"] === "org-acme");
check("the tool result is the API's JSON", JSON.parse(body.result.content[0].text)[0].customerId === "northwind" && !body.result.isError);

calls.length = 0;
await post(rpc(3, "tools/call", { name: "customer_list", arguments: {} }));
check("no x-ops-org -> none is invented; the server's active workspace decides", !("x-ops-org" in calls[0].headers));

/* Self-hosted, a caller can put anything in Host — so what the operator configured wins over the request. */
calls.length = 0;
await handleMcpRequest(
  new Request("http://attacker.internal/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(3, "tools/call", { name: "customer_list" })),
  }),
  { ...deps, webOrigin: ORIGIN },
);
check("self-hosted: the Ops call goes to the configured address, not the request's Host", calls[0].url === `${ORIGIN}/api/ops/customers`);
calls.length = 0;
await handleMcpRequest(
  new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(3, "tools/call", { name: "customer_list" })),
  }),
  { ...deps, internalOrigin: "http://127.0.0.1:3000" },
);
check("MCP_INTERNAL_ORIGIN overrides where the Ops API is reached", calls[0].url === "http://127.0.0.1:3000/api/ops/customers");

calls.length = 0;
body = await (await post([
  rpc(1, "tools/call", { name: "workspace_use", arguments: { orgId: "org-two" } }),
  rpc(2, "tools/call", { name: "customer_list" }),
])).json();
check("a batch is answered as a batch, in order", Array.isArray(body) && body[0].id === 1 && body[1].id === 2);
check("workspace_use applies to the calls after it", calls.at(-1).headers["x-ops-org"] === "org-two");

/* ---- failures are tool errors, not transport errors ----------------------- */

opsReply = () => Response.json({ error: "You are not a member of org-other." }, { status: 403 });
res = await post(rpc(4, "tools/call", { name: "customer_list" }), { "x-ops-org": "org-other" });
body = await res.json();
check("an Ops API refusal -> HTTP 200 + isError, not a 500", res.status === 200 && body.result.isError === true);
check("…carrying the API's own message", body.result.content[0].text.includes("not a member of org-other"));
opsReply = () => {
  throw new Error("socket hang up");
};
res = await post(rpc(5, "tools/call", { name: "customer_list" }));
body = await res.json();
check("a thrown handler -> isError too", res.status === 200 && body.result.isError && body.result.content[0].text.includes("socket hang up"));
body = await (await post(rpc(6, "tools/call", { name: "no_such_tool" }))).json();
check("an unknown tool -> -32602", body.error?.code === -32602);

/* ---- caps ----------------------------------------------------------------- */

res = await post(rpc(1, "tools/call", { name: "dataroom_write", arguments: { path: `${FOLDER.accounts}/a/b.md`, content: "x".repeat(MAX_BODY_BYTES) } }));
check("an oversized body -> 413", res.status === 413 && (await res.json()).error.code === -32600);
res = await handleMcpRequest(
  new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": "10" },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(MAX_BODY_BYTES + 1));
        c.close();
      },
    }),
    duplex: "half",
  }),
  deps,
);
check("…even when Content-Length lies about it", res.status === 413);
res = await post(Array.from({ length: MAX_BATCH + 1 }, (_, i) => rpc(i, "ping")));
check("an oversized batch -> 400", res.status === 400);
opsReply = () => Response.json({ found: true, content: "y".repeat(MAX_RESULT_CHARS + 5000) });
body = await (await post(rpc(9, "tools/call", { name: "dataroom_read", arguments: { path: `${FOLDER.accounts}/a/b.md` } }))).json();
check("an oversized tool result is truncated, and says so", body.result.content[0].text.length < MAX_RESULT_CHARS + 400 && body.result.content[0].text.includes("[truncated"));

/* ---- what a person is told to type ---------------------------------------- */

const c = mcpConnect({ origin: `${ORIGIN}/`, productName: PRODUCT });
check("the slug comes from the product name", productSlug("Acme Research!") === "acme-research" && productSlug("") === "workspace");
check(
  "the Claude Code line names THIS deployment and THIS product",
  c.claudeCommand === `claude mcp add --transport http acme-research ${ORIGIN}/api/mcp --header "Authorization: Bearer <token>"`,
);
check("every client's snippet carries this deployment's endpoint", c.clients.every((m) => m.snippet.includes(`${ORIGIN}/api/mcp`)));
check("the package alternative spells out WORKSPACE_OPS_URL", c.packageAlternative.claudeCommand.includes(`WORKSPACE_OPS_URL=${ORIGIN}`));

/* ---- source-level: the defaults that caused this stay gone ---------------- */

const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const f of ["setup/workspace-mcp.mjs", "setup/workspace-login.mjs", "setup/workspace-tools.mjs", "lib/mcp-server.ts", "lib/mcp-connect.ts", "app/onboard/page.tsx", "lib/platform-notify.ts"]) {
  check(`${f} hardcodes no product's address`, !/fde-agent\.vercel\.app|delivered\.useimmaculate\.com/.test(decomment(readFileSync(f, "utf8"))));
}
check("the route authenticates with the Ops API's own verifier", /verifyOpsAuth/.test(readFileSync("app/api/mcp/route.ts", "utf8")));
check("the endpoint sends no CORS header", !/access-control-allow-origin/i.test(decomment(readFileSync("lib/mcp-server.ts", "utf8"))));

console.log(`test-mcp-endpoint: ${passed} checks passed`);
