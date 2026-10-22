// Per-IP limits behind the real number of proxies (mold_v0-084; src/proxy-trust.ts, src/http.ts), offline: an embedded
// database and the server on a local port; every "proxy" is a header this test writes.
//   npm run test:proxy-hops
//
// 1. OCTILLION_PROXY_HOPS: unset is 0 (reached directly) or 1 on Vercel; 0 to 5 taken; anything else refused at start.
// 2. Which address a request is from, for each hop count: the N-th from the right of X-Forwarded-For, never an entry to
//    its left (the client's to write); with 0, the connection's own address.
// 3. The server: behind one proxy (a server's Caddy, Vercel's edge), a client that writes a new X-Forwarded-For entry
//    on every request still hits the sign-in limit of the address the proxy saw, and another client keeps its own;
//    with no proxy, X-Forwarded-For is ignored.
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.AUTH_PROVIDER = "builtin";
process.env.OCTILLION_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP = "3";
const { cleanup } = await import("./lib/test-world.js");
const { proxyHops } = await import("../src/proxy-trust.js");

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };
const listen = async (app: express.Express) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
};

try {
  // ---------- 1. the setting ----------
  assert.equal(proxyHops({}), 0, "unset: reached directly");
  assert.equal(proxyHops({ VERCEL: "1" }), 1, "unset on Vercel: its edge");
  for (const v of ["0", "1", "2", "5"]) assert.equal(proxyHops({ OCTILLION_PROXY_HOPS: v }), Number(v));
  assert.equal(proxyHops({ OCTILLION_PROXY_HOPS: "0", VERCEL: "1" }), 0, "set wins");
  for (const v of ["true", "-1", "6", "1.5", "1e0", "loopback", " 2x"]) assert.throws(() => proxyHops({ OCTILLION_PROXY_HOPS: v }), /whole number from 0 to 5/, v);
  ok("OCTILLION_PROXY_HOPS: unset is 0 (1 on Vercel); 0 to 5 taken; anything else refused");

  // ---------- 2. the address, per hop count ----------
  for (const [hops, xff, want] of [
    [0, "203.0.113.9", "127.0.0.1"],
    [1, "6.6.6.6, 203.0.113.9", "203.0.113.9"],
    [1, "203.0.113.9", "203.0.113.9"],
    [1, undefined, "127.0.0.1"],
    [2, "6.6.6.6, 203.0.113.9, 10.0.0.2", "203.0.113.9"],
  ] as const) {
    const app = express();
    app.set("trust proxy", proxyHops({ OCTILLION_PROXY_HOPS: String(hops) }));
    app.get("/ip", (req, res) => void res.json({ ip: req.ip }));
    const s = await listen(app);
    const got = (await (await fetch(`${s.base}/ip`, { headers: xff ? { "x-forwarded-for": xff } : {} })).json()).ip;
    await s.close();
    assert.equal(String(got).replace(/^::ffff:/, ""), want, `${hops} hop(s), X-Forwarded-For ${xff ?? "(none)"}`);
  }
  ok("the address: the N-th from the right of X-Forwarded-For, never an entry the client wrote to its left; 0 hops, the connection's");

  // ---------- 3. the server's own limits ----------
  const { createApp } = await import("../src/http.js");
  const ask = (base: string, xff?: string) => fetch(`${base}/api/auth/email/request`, { method: "POST",
    headers: { "content-type": "application/json", ...(xff ? { "x-forwarded-for": xff } : {}) }, body: JSON.stringify({ email: "someone@example.org" }) }).then((r) => r.status);
  {
    process.env.OCTILLION_PROXY_HOPS = "1"; // a server's Caddy, or Vercel's edge
    const s = await listen(createApp());
    const seen: number[] = [];
    // The client writes a new address of its own before the one the proxy saw, every time.
    for (let i = 0; i < 5; i++) seen.push(await ask(s.base, `198.18.${i}.${i + 1}, 203.0.113.9`));
    assert.deepEqual(seen.slice(0, 3).map((x) => x === 429), [false, false, false], `the first three pass the limit: ${seen}`);
    assert.deepEqual(seen.slice(3), [429, 429], `then the proxy's address is limited, whatever the client wrote: ${seen}`);
    assert.notEqual(await ask(s.base, "203.0.113.10"), 429, "another client keeps its own limit");
    await s.close();
  }
  {
    process.env.OCTILLION_PROXY_HOPS = "0"; // reached directly: X-Forwarded-For means nothing
    const s = await listen(createApp());
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) seen.push(await ask(s.base, `203.0.114.${i + 1}`));
    assert.deepEqual(seen.map((x) => x === 429), [false, false, false, true], `no proxy: one address however X-Forwarded-For varies: ${seen}`);
    await s.close();
  }
  ok("the server: behind one proxy a client cannot step around the per-IP limit by writing X-Forwarded-For; with none it is ignored");
  console.log(`PROXY HOPS TEST PASS (${n} groups)`);
} finally {
  delete process.env.OCTILLION_PROXY_HOPS;
  cleanup();
}
process.exit(0);
