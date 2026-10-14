/**
 * THE /eve SESSION GATE, AS A STREAM (app/eve/v1/session/[...segments]/route.ts).
 *
 * The real route handler, run in Node against a real HTTP "agent" that streams NDJSON a line at a time, with the
 * gate's database and sign-in checks stubbed to "allowed" (they are held elsewhere: test:chat-access,
 * test:session-guard). What is held here:
 *
 *   1. ABORT. A reader that gives up stops the agent's read too, including the case that mattered on the live app:
 *      6 of 12 specialist streams never sent response headers (60-240 s), and a reader that left was still holding
 *      the gate's and the agent's functions open for up to the gate's 800 s ceiling.
 *   2. COMPRESSED, NOT BUFFERED. A read that asks (`?compressed=1`) from a browser that accepts brotli is sent
 *      brotli, and every event the agent sends is decodable by the reader BEFORE the agent sends the next one: the
 *      compressor holds nothing back, so a live stream is exactly as live as it was uncompressed.
 *   3. SMALLER. A generated specialist stream (cumulative reasoning deltas, the measured shape) is many times smaller
 *      on the wire, and decodes to the same bytes.
 *   4. UNCHANGED otherwise. A read that does not ask, a browser without brotli, a POST: identity, as before, and the
 *      gate's own flag never reaches the agent.
 *
 * Run: npm run test:eve-proxy-stream
 */
import { createServer } from "node:http";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import { specialistStream } from "./fixtures/child-feed/make-stream.mjs";

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : `\n         got: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`}`);
  }
};
/** A decoder for what the response says it is: brotli, or the bytes as they are. */
const decoderFor = (res) => {
  if (res.headers.get("content-encoding") === "br") return createBrotliDecompress();
  return new PassThrough();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
};

/* ---- the agent ------------------------------------------------------------------------------------------------- */
// Each request is recorded; the test decides when it sends headers and each line.
const upstream = [];
const agent = createServer((req, res) => {
  const r = { url: req.url, method: req.method, closed: false, res, headersSent: false };
  upstream.push(r);
  res.on("close", () => {
    r.closed = true;
  });
  if (req.url.includes("/never/")) return; // no headers, ever (the stalled specialist streams)
  if (req.method === "POST") {
    let body = "";
    res.on("finish", () => {
      r.finished = true;
    });
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      r.body = body;
      // A Stop or a message takes the agent a moment; it must not be cut short by a reader that left.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, req.url.includes("/slow/") ? 300 : 0);
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/x-ndjson", "x-eve-session-delegation": "1" });
  res.flushHeaders();
  r.headersSent = true;
});
await new Promise((r) => agent.listen(0, "127.0.0.1", r));
process.env.NEXT_PUBLIC_EVE_API_URL = `http://127.0.0.1:${agent.address().port}`;

/* ---- the route, with its gate stubbed to "allowed" ------------------------------------------------------------- */
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  "@/lib/chat-session-access": stub("export async function gateForSession() { return { allow: true }; }"),
  "@/lib/chat-gate": stub("export function rightFor() { return 'read'; }"),
  "@/lib/agent-url": stub("export function agentUrlFallback() { return ''; }"),
  "@/lib/ops-auth": stub("export async function verifyOpsAuth(h) { return h ? { email: 'person@example.com', hostedDomain: null } : null; }"),
  "@/lib/org-context": stub(
    "export const ORG_HEADER = 'x-ops-org'; export async function resolveOrgForIdentity() { return { orgId: 'org-1' }; } export function isWorkspaceRefusal() { return false; } export function workspaceRefusedResponse() { return new Response(null, { status: 403 }); }",
  ),
};
register(
  stub(`
    const ROOT = ${JSON.stringify(pathToFileURL(`${process.cwd()}/`).href)};
    const STUBS = ${JSON.stringify(STUBS)};
    export async function resolve(s, c, n) {
      if (STUBS[s]) return { url: STUBS[s], shortCircuit: true };
      if (s.startsWith("@/")) s = ROOT + s.slice(2);
      try { return await n(s, c); } catch (e) {
        if (!/\\.[cm]?[jt]sx?$/.test(s)) {
          try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
        }
        throw e;
      }
    }`),
  import.meta.url,
);
const { NextRequest } = await import("next/server.js");
const route = await import("../app/eve/v1/session/[...segments]/route.ts");

const call = (method, segments, { query = "", headers = {}, signal, body } = {}) =>
  route[method](
    new NextRequest(`http://app.test/eve/v1/session/${segments.join("/")}${query}`, {
      method,
      headers: { authorization: "Bearer t", ...headers },
      signal,
      ...(body ? { body, duplex: "half" } : {}),
    }),
    { params: Promise.resolve({ segments }) },
  );

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n1. An abandoned read stops the agent's read");
{
  const ctrl = new AbortController();
  const pending = call("GET", ["never", "stream"], { query: "?startIndex=0", signal: ctrl.signal }).catch((e) => e);
  await waitFor(() => upstream.some((u) => u.url.includes("/never/")));
  const req = upstream.find((u) => u.url.includes("/never/"));
  check("the agent has the request, and has sent no headers", req && !req.headersSent);
  ctrl.abort();
  const closed = await waitFor(() => req.closed, 2_000);
  check("the reader leaves before any headers: the agent's request is closed within 2 s", closed);
  const outcome = await Promise.race([pending, sleep(2_000).then(() => "still waiting")]);
  check("…and the gate answers instead of waiting out its 800 s", outcome !== "still waiting", String(outcome));
}
{
  const ctrl = new AbortController();
  const res = await call("GET", ["sess_live", "stream"], { query: "?startIndex=0", signal: ctrl.signal });
  const req = upstream.at(-1);
  req.res.write(`${JSON.stringify({ type: "turn.started", data: { turnId: "turn_0" } })}\n`);
  const reader = res.body.getReader();
  await reader.read();
  ctrl.abort();
  await reader.cancel().catch(() => {});
  check("the reader leaves mid-stream: the agent's request is closed within 2 s", await waitFor(() => req.closed, 2_000));
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n2. A compressed read is compressed, and holds nothing back");
{
  const ctrl = new AbortController();
  const res = await call("GET", ["sess_br", "stream"], {
    query: "?startIndex=7&compressed=1",
    headers: { "accept-encoding": "gzip, deflate, br, zstd" },
    signal: ctrl.signal,
  });
  const req = upstream.at(-1);
  check("sent brotli", res.headers.get("content-encoding") === "br", res.headers.get("content-encoding"));
  check("still no-transform and unbuffered for every hop after the gate", /no-transform/.test(res.headers.get("cache-control") ?? "") && res.headers.get("x-accel-buffering") === "no");
  check("the delegation header still reaches the panel", res.headers.get("x-eve-session-delegation") === "1");
  check("the agent gets the reader's query without the gate's flag", req.url.endsWith("/stream?startIndex=7"), req.url);
  const decoded = [];
  const inflate = decoderFor(res);
  inflate.on("data", (b) => decoded.push(b.toString("utf8")));
  const reader = res.body.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      inflate.write(value);
    }
  })();
  let prompt = 0;
  for (let i = 0; i < 6; i++) {
    const line = JSON.stringify({ data: { reasoningSoFar: "x".repeat(200 * (i + 1)), stepIndex: 0, turnId: "turn_0" }, type: "reasoning.appended" });
    req.res.write(`${line}\n`);
    // The agent sends the NEXT event only once this one is readable, or after 1 s if it never is.
    const ok = await waitFor(() => decoded.join("").includes(line), 1_000);
    if (ok) prompt++;
  }
  check("each of 6 events is readable before the agent sends the next one (nothing waits in the compressor)", prompt === 6, prompt);
  ctrl.abort();
  await reader.cancel().catch(() => {});
  check("…and leaving closes the agent's request", await waitFor(() => req.closed, 2_000));
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n3. Smaller on the wire, same bytes");
{
  const lines = specialistStream({ seed: 3, steps: 3, reasoningChars: 20_000 });
  const raw = lines.map((l) => `${l}\n`).join("");
  const res = await call("GET", ["sess_big", "stream"], { query: "?startIndex=0&compressed=1", headers: { "accept-encoding": "br" } });
  const req = upstream.at(-1);
  // The agent writes it in many small chunks, as eve does, then ends the segment.
  void (async () => {
    for (let i = 0; i < lines.length; i += 20) {
      req.res.write(lines.slice(i, i + 20).map((l) => `${l}\n`).join(""));
      await sleep(0);
    }
    req.res.end();
  })();
  let wire = 0;
  const parts = [];
  const inflate = decoderFor(res);
  inflate.on("data", (b) => parts.push(b));
  const done = new Promise((r) => inflate.on("end", r));
  const reader = res.body.getReader();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    wire += value.byteLength;
    inflate.write(value);
  }
  inflate.end();
  await done;
  const text = Buffer.concat(parts).toString("utf8");
  check(`decodes to exactly what the agent sent (${(raw.length / 1e6).toFixed(1)} MB)`, text === raw, { got: text.length, want: raw.length });
  check(`…in ${(wire / 1e3).toFixed(0)} KB on the wire (${Math.round(raw.length / wire)}x smaller; bound 20x)`, wire * 20 < raw.length, wire);
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n4. Everything else unchanged");
{
  const res = await call("GET", ["sess_plain", "stream"], { query: "?startIndex=0", headers: { "accept-encoding": "br" } });
  check("a read that does not ask stays identity", res.headers.get("content-encoding") === "identity");
  check("…and its query reaches the agent untouched", upstream.at(-1).url.endsWith("/stream?startIndex=0"));
  upstream.at(-1).res.end();
  await res.body?.cancel().catch(() => {});
  const res2 = await call("GET", ["sess_nobr", "stream"], { query: "?startIndex=0&compressed=1", headers: { "accept-encoding": "gzip, deflate" } });
  check("a browser without brotli gets identity", res2.headers.get("content-encoding") === "identity");
  upstream.at(-1).res.end();
  await res2.body?.cancel().catch(() => {});
  const res3 = await call("GET", ["sess_q0", "stream"], { query: "?startIndex=0&compressed=1", headers: { "accept-encoding": "br;q=0, gzip" } });
  check("br;q=0 is a refusal", res3.headers.get("content-encoding") === "identity");
  upstream.at(-1).res.end();
  await res3.body?.cancel().catch(() => {});
  const post = await call("POST", ["sess_post"], { query: "?compressed=1", headers: { "content-type": "application/json", "accept-encoding": "br" }, body: JSON.stringify({ message: "hi" }) });
  check("a POST goes through, identity, body intact", post.status === 200 && post.headers.get("content-encoding") === "identity" && upstream.at(-1).body === JSON.stringify({ message: "hi" }), {
    status: post.status,
    enc: post.headers.get("content-encoding"),
  });
}

{
  const ctrl = new AbortController();
  const pending = call("POST", ["slow", "cancel"], { headers: { "content-type": "application/json" }, body: "{}", signal: ctrl.signal }).catch((e) => e);
  await waitFor(() => upstream.some((u) => u.url.includes("/slow/") && u.body !== undefined));
  ctrl.abort();
  await pending;
  const req = upstream.find((u) => u.url.includes("/slow/"));
  check("a POST whose sender leaves is still delivered: the agent finishes it (a Stop is not cut short)", await waitFor(() => req.finished === true, 2_000));
}

agent.close();
agent.closeAllConnections?.();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
