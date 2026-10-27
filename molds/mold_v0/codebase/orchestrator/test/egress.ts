/**
 * Egress lockdown pieces (orchestrator/core/egress.ts), tested on this host: the generated proxy really runs, lets an
 * allowlisted host through and refuses everything else; the policy is built from the gateway and repo hosts; the
 * setup script fails closed. The firewall rules themselves are exercised by the in-VM probe on a real boat VM.
 *   npx tsx orchestrator/test/egress.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { EGRESS_DNS_PORT, EGRESS_PROXY_PORT, egressPolicy, probeSource, proxyEnv, proxySource, setupScript } from "../core/egress.js";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`[egress] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

const pol = egressPolicy({ gatewayUrls: ["https://gw.app.example/gw/anthropic", "https://gw.app.example/gw/openai/v1"], repoUrl: "https://github.com/acme/app.git" });
check("policy: gateway, registries and the repo's git host", pol.gatewayHost === "gw.app.example" && pol.hosts.includes("registry.npmjs.org") &&
  pol.hosts.includes("github.com") && pol.hosts.includes("codeload.github.com") && !pol.hosts.includes("example.com"), pol.hosts.join(","));
let refused = false;
try { egressPolicy({ gatewayUrls: ["http://127.0.0.1:3000/gw/anthropic"] }); } catch { refused = true; }
check("policy: a non-HTTPS gateway is refused (strict mode is production only)", refused);
check("policy: a repo given as an IP literal is not allowlisted", !egressPolicy({ gatewayUrls: ["https://gw.x.example"], repoUrl: "https://10.0.0.5/app.git" }).hosts.includes("10.0.0.5"));
check("proxy env routes HTTP clients through the proxy", proxyEnv().HTTPS_PROXY === `http://127.0.0.1:${EGRESS_PROXY_PORT}` && proxyEnv().NODE_USE_ENV_PROXY === "1");
const setup = setupScript("/tmp/app");
check("setup runs the proxy as its own systemd service, with a detached-session fallback (it must outlive the setup command)",
  /systemd-run --quiet --unit=app-egress-proxy --uid=appproxy/.test(setupScript("/tmp/app")) && /appproxy setsid sh -c 'exec nohup/.test(setupScript("/tmp/app")));
check("setup shows the proxy's own error when it does not start (file opened by the proxy user, read with sudo)",
  /-u appproxy setsid sh -c 'exec nohup "\$0" "\$@" >\/dev\/null 2>\/var\/log\/app-egress\.err'/.test(setupScript("/tmp/app")) && /egress: proxy did not start: \$\(sudo -n head/.test(setupScript("/tmp/app")));
check("setup fails closed without node, a firewall tool or a running proxy", /exit 20/.test(setup) && /exit 21/.test(setup) && /exit 22/.test(setup) && /meta skuid \$AUID counter drop/.test(setup));
check("probe expects the gateway reachable (also without proxy settings) and everything else blocked",
  /gateway directly \(transparent/.test(probeSource("gw.x.example")) && /DNS for an unlisted host", false/.test(probeSource("gw.x.example")) &&
  /metadata IP directly", false/.test(probeSource("gw.x.example")));
check("setup redirects the agent's HTTPS and DNS to the proxy", /tcp dport 443 redirect/.test(setup) && /udp dport 53 redirect/.test(setup) && /REDIRECT --to-ports/.test(setup));

// Run the generated proxy on a free port (rewritten from 3128) with a small allowlist.
const dir = mkdtempSync(path.join(os.tmpdir(), "app-egress-"));
const port = 31000 + Math.floor(Math.random() * 2000);
writeFileSync(path.join(dir, "proxy.mjs"), proxySource());
const tport = port + 1, dport = port + 2;
writeFileSync(path.join(dir, "allow.json"), JSON.stringify({ hosts: ["registry.npmjs.org"] }));
const proc = spawn(process.execPath, [path.join(dir, "proxy.mjs"), path.join(dir, "allow.json"), path.join(dir, "log.jsonl"), String(port), String(tport), String(dport)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const connect = (target: string) => new Promise<string>((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = ""; s.setTimeout(8000);
  s.on("data", (d) => { buf += d; if (buf.includes("\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]!); } });
  s.on("timeout", () => { s.destroy(); resolve("timeout"); }); s.on("error", (e) => resolve(`error ${e.message}`));
});
const plain = await new Promise<string>((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"));
  let buf = ""; s.on("data", (d) => { buf += d; s.destroy(); resolve(buf.split("\r\n")[0]!); }); s.on("error", (e) => resolve(`error ${e.message}`));
});
try {
  const allowed = await connect("registry.npmjs.org:443");
  check("an allowlisted host connects through the proxy", /^HTTP\/1\.1 200/.test(allowed), allowed);
  for (const [target, why] of [["example.com:443", "unlisted host"], ["1.1.1.1:443", "IP literal"], ["registry.npmjs.org:80", "port other than 443"], ["[::1]:443", "IPv6 literal"]])
    check(`refused through the proxy: ${why}`, /^HTTP\/1\.1 403/.test(await connect(target!)), target);
  check("plain HTTP proxying is refused", /^HTTP\/1\.1 403/.test(plain), plain);
  // Transparent mode: a TLS handshake redirected to the proxy goes through only for an allowlisted SNI.
  const viaT = (servername: string) => new Promise<boolean>((r) => {
    const t = tls.connect({ host: "127.0.0.1", port: tport, servername, timeout: 8000 }, () => { t.destroy(); r(true); });
    t.on("timeout", () => { t.destroy(); r(false); }); t.on("error", () => r(false)); t.on("close", () => r(false));
  });
  check("transparent: TLS to an allowlisted host goes through (its real certificate validates)", await viaT("registry.npmjs.org"));
  check("transparent: TLS to an unlisted host is cut off", !(await viaT("example.com")));
  // DNS responder: allowlisted names resolve, others are NXDOMAIN and never forwarded.
  const ask = (name: string) => new Promise<{ rcode: number; answers: number }>((r) => {
    const q = Buffer.concat([Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
      ...name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 1, 0, 1])]);
    const u = dgram.createSocket("udp4");
    const timer = setTimeout(() => { u.close(); r({ rcode: -1, answers: 0 }); }, 5000);
    u.on("message", (m) => { clearTimeout(timer); u.close(); r({ rcode: m.readUInt16BE(2) & 0xf, answers: m.readUInt16BE(6) }); });
    u.send(q, dport, "127.0.0.1");
  });
  const okName = await ask("registry.npmjs.org"), badName = await ask("example.com");
  check("DNS: an allowlisted name resolves", okName.rcode === 0 && okName.answers > 0, JSON.stringify(okName));
  check("DNS: an unlisted name is NXDOMAIN", badName.rcode === 3 && badName.answers === 0, JSON.stringify(badName));
  const log = readFileSync(path.join(dir, "log.jsonl"), "utf8");
  check("the proxy has not died after serving every kind of request (and has no unexpected errors in its log)", proc.exitCode === null && !/"error":"(uncaught|unhandled)"/.test(readFileSync(path.join(dir, "log.jsonl"), "utf8")), String(proc.exitCode));
check("decisions are logged", /"allow":"registry.npmjs.org"/.test(log) && /"why":"host not allowed"/.test(log), "");
} finally {
  proc.kill();
}
// A port that is already taken (what the old DNS port did on a VM) must fail loudly, not leave a half-started proxy.
{
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const busy = (taken.address() as net.AddressInfo).port;
  const out = await new Promise<{ code: number | null; err: string }>((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "proxy.mjs"), path.join(dir, "allow.json"), path.join(dir, "log2.jsonl"), String(busy), String(busy + 1000), String(busy + 2000)], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { c.kill(); resolve({ code: null, err }); }, 8000);
    c.on("exit", (code) => { clearTimeout(t); resolve({ code, err }); });
  });
  taken.close();
  check("a taken port makes the proxy exit with a clear error (not silently)", out.code === 1 && /egress proxy: proxy listener: /.test(out.err), `${out.code} ${out.err.trim().slice(0, 120)}`);
  check("the default DNS port is not the mDNS port", (EGRESS_DNS_PORT as number) !== 5353, String(EGRESS_DNS_PORT));
}
// An on-premises runner's private allow list (mold_v0-036): an address inside a listed network on a listed port goes
// through; another port, another address, and loopback or link-local whatever is listed, never. Uses this host's own
// private address (a container bridge's, a cloud's private interface).
{
  const mine = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal &&
    (/^10\./.test(i.address) || /^192\.168\./.test(i.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(i.address)))?.address;
  if (!mine) check("private allow list: skipped (this host has no private IPv4 address)", true);
  else {
    const target = net.createServer((sock) => { sock.end("private hello\n"); });
    await new Promise<void>((r) => target.listen(0, mine, r));
    const tp = (target.address() as net.AddressInfo).port;
    const pport = 33000 + Math.floor(Math.random() * 2000);
    writeFileSync(path.join(dir, "allow-private.json"), JSON.stringify({ hosts: ["registry.npmjs.org"], private: [
      { cidr: `${mine}/32`, ports: [tp] }, { cidr: "127.0.0.0/8", ports: [tp] }, { cidr: "169.254.0.0/16", ports: [80] }, { name: "localhost", ports: [443, tp] }] }));
    const pp = spawn(process.execPath, [path.join(dir, "proxy.mjs"), path.join(dir, "allow-private.json"), path.join(dir, "log3.jsonl"), String(pport), String(pport + 1), String(pport + 2)], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    const via = (t: string, wantData = false) => new Promise<string>((resolve) => {
      const c = net.connect(pport, "127.0.0.1", () => c.write(`CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`));
      let buf = ""; c.setTimeout(8000);
      c.on("data", (d) => { buf += d; if (buf.includes("private hello") || /^HTTP\/1\.1 403/.test(buf) || (!wantData && /^HTTP\/1\.1 200[^]*\r\n\r\n/.test(buf))) { c.destroy(); resolve(buf); } });
      c.on("timeout", () => { c.destroy(); resolve(`timeout ${buf}`); }); c.on("error", (e) => resolve(`error ${e.message}`)); c.on("close", () => resolve(buf));
    });
    try {
      const ok = await via(`${mine}:${tp}`, true);
      check("private allow list: an address in a listed network, on a listed port, goes through", /^HTTP\/1\.1 200/.test(ok) && ok.includes("private hello"), ok.split("\r\n")[0]);
      check("private allow list: the same address on another port is refused", /^HTTP\/1\.1 403/.test(await via(`${mine}:${tp + 1}`)));
      check("private allow list: an address outside the listed networks is refused", /^HTTP\/1\.1 403/.test(await via(`10.255.255.254:${tp}`)) || mine === "10.255.255.254");
      check("private allow list: loopback is never reached, even listed", /^HTTP\/1\.1 403/.test(await via(`127.0.0.1:${tp}`)) && /^HTTP\/1\.1 403/.test(await via(`localhost:${tp}`)));
      check("private allow list: link-local (metadata) is never reached, even listed", /^HTTP\/1\.1 403/.test(await via("169.254.169.254:80")));
      check("private allow list: the public allowlist is unchanged beside it", /^HTTP\/1\.1 200/.test(await via("registry.npmjs.org:443")) && /^HTTP\/1\.1 403/.test(await via("example.com:443")));
    } finally { pp.kill(); target.close(); }
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`EGRESS TEST ${failed.length ? "FAIL" : "PASS"} (${results.length - failed.length}/${results.length} assertions)`);
process.exit(failed.length ? 1 : 0);
