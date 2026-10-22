// The run sandbox's egress lockdown (mold_v0-055; src/run-sandbox-runner.ts lockDown, orchestrator/core/egress.ts
// setupScript), enforced for real, offline: two throwaway network namespaces joined by a veth pair, one standing in
// for the sandbox and one for "the internet" (listeners that record every connection they get). The lockdown script
// the runner runs in a sandbox (the same text, with the run user, as root, no systemd) is run in the sandbox namespace;
// then the run's user tries to get out directly. Nothing outside the two namespaces is touched: the proxy runs as an
// existing user (daemon) from a temporary directory, and deleting the namespaces removes their firewall rules.
//   npm run test:run-firewall           (needs root, ip, nft or iptables; says SKIPPED otherwise)
//
//  1. Before the lockdown the run user reaches the outside directly (the test can see a blocked path).
//  2. After it, as the run user: a direct TCP connection to any port is dropped, as is one to a local daemon, a local
//     resolver over TCP, the sandbox's own address or IPv6 loopback; TCP 443 goes to the sandbox's own
//     proxy, which refuses an unlisted name (SNI) and nothing reaches the outside; DNS goes to the proxy's responder
//     (NXDOMAIN for an unlisted name), not out; through the proxy, an IP address or an unlisted host is refused.
//  3. Root in the sandbox (the runner) still reaches the outside: the rules hold for the run's user, by uid.
// The run user is one leased per run (mold_v0-078, src/run-users.ts): a uid no account names, locked down by number;
// the run's allowlist has a company's own host (mold_v0-075), allowed exactly: never its subdomains.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxySource, probeSource, setupScript } from "../orchestrator/core/egress.js";
import { leaseRunUser, type RunUser } from "../src/run-users.js";

const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const why = process.getuid?.() !== 0 ? "not root" : !has("ip") ? "no ip" : !has("nft") && !has("iptables") ? "neither nft nor iptables" : !has("setpriv") ? "no setpriv" : null;
if (why) { console.log(`RUN FIREWALL TEST SKIPPED: ${why} (the lockdown is then proven only where a sandbox runs it)`); process.exit(0); }

const tag = `t55${randomBytes(3).toString("hex")}`;
const nsS = `${tag}s`, nsO = `${tag}o`; // the sandbox, the outside
const OUT = "10.255.55.2", IN = "10.255.55.1";
const dir = mkdtempSync(path.join(tmpdir(), "run-firewall-"));
chmodSync(dir, 0o755);
const sh = (args: string[], opts: { ns?: string } = {}) => {
  const r = spawnSync(opts.ns ? "ip" : args[0]!, opts.ns ? ["netns", "exec", opts.ns, ...args] : args.slice(1), { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`${args.join(" ")}: status ${r.status} ${r.signal ?? ""} ${r.error?.message ?? ""} ${r.stderr || r.stdout}`);
  return r.stdout;
};
const kids: ChildProcess[] = [];
let failed = false;
let lease: RunUser | null = null;
try {
  // The run's user as a sandbox's runner gets it: leased for this run (a uid with no account), never shared meanwhile.
  lease = await leaseRunUser(`firewall-${tag}`);
  const RUID = lease.uid;
  // ---------- two namespaces and a cable ----------
  sh(["ip", "netns", "add", nsS]); sh(["ip", "netns", "add", nsO]);
  sh(["ip", "link", "add", `${tag}a`, "type", "veth", "peer", "name", `${tag}b`]);
  sh(["ip", "link", "set", `${tag}a`, "netns", nsS]); sh(["ip", "link", "set", `${tag}b`, "netns", nsO]);
  sh(["ip", "-n", nsS, "addr", "add", `${IN}/30`, "dev", `${tag}a`]); sh(["ip", "-n", nsO, "addr", "add", `${OUT}/30`, "dev", `${tag}b`]);
  for (const [ns, dev] of [[nsS, `${tag}a`], [nsO, `${tag}b`]]) { sh(["ip", "-n", ns!, "link", "set", "lo", "up"]); sh(["ip", "-n", ns!, "link", "set", dev!, "up"]); }
  sh(["ip", "-n", nsS, "route", "add", "default", "via", OUT]);

  // ---------- the outside: listeners that record who reached them ----------
  const seen = path.join(dir, "seen.jsonl");
  writeFileSync(path.join(dir, "outside.mjs"), `import net from "node:net"; import dgram from "node:dgram"; import fs from "node:fs";
const rec = (o) => fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(o) + "\\n");
for (const port of [443, 8080]) net.createServer((s) => { rec({ tcp: port, from: s.remoteAddress }); s.end("hello\\n"); }).listen(port, ${JSON.stringify(OUT)});
const u = dgram.createSocket("udp4"); u.on("message", (m, r) => { rec({ udp: 53, from: r.address }); u.send(m, r.port, r.address); }); u.bind(53, ${JSON.stringify(OUT)});
fs.writeFileSync(${JSON.stringify(path.join(dir, "outside.up"))}, "up");`);
  writeFileSync(seen, "");
  kids.push(spawn("ip", ["netns", "exec", nsO, process.execPath, path.join(dir, "outside.mjs")], { stdio: "ignore" }));
  for (let i = 0; i < 100 && !readdirSync(dir).includes("outside.up"); i++) await new Promise((r) => setTimeout(r, 100));
  // In the sandbox: daemons of root's on loopback, a local resolver (as systemd-resolved's 127.0.0.53, over TCP) and on
  // the sandbox's own address, which the run user must not reach either (strict rules).
  writeFileSync(path.join(dir, "local.mjs"), `import net from "node:net"; import fs from "node:fs";
for (const [h, p] of [["127.0.0.1", 7777], ["127.0.0.53", 53], [${JSON.stringify(IN)}, 7778]]) net.createServer((s) => s.end("local\\n")).listen(p, h);
fs.writeFileSync(${JSON.stringify(path.join(dir, "local.up"))}, "up");`);
  kids.push(spawn("ip", ["netns", "exec", nsS, process.execPath, path.join(dir, "local.mjs")], { stdio: "ignore" }));
  for (let i = 0; i < 100 && !readdirSync(dir).includes("local.up"); i++) await new Promise((r) => setTimeout(r, 100));
  const seenLines = () => readFileSync(seen, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tcp?: number; udp?: number; from: string });

  // ---------- what the run user tries ----------
  writeFileSync(path.join(dir, "try.mjs"), `import net from "node:net"; import dgram from "node:dgram";
const T = 3000, OUT = ${JSON.stringify(OUT)};
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: T }); s.on("connect", () => { s.destroy(); r(true); }); s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false)); });
// A TLS ClientHello carrying a server name: what a harness that ignores proxy settings sends to port 443.
const hello = (name) => { const n = Buffer.from(name); const sni = Buffer.concat([Buffer.from([0, 0]), Buffer.from([(n.length + 5) >> 8, (n.length + 5) & 255, (n.length + 3) >> 8, (n.length + 3) & 255, 0, n.length >> 8, n.length & 255]), n]);
  const ext = Buffer.concat([Buffer.from([sni.length >> 8, sni.length & 255]), sni]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), Buffer.from([0, 2, 0x13, 0x01]), Buffer.from([1, 0]), ext]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1, hs.length >> 8, hs.length & 255]), hs]); };
const tls443 = (name) => new Promise((r) => { const s = net.connect({ host: OUT, port: 443, timeout: T }); let got = "";
  s.on("connect", () => s.write(hello(name))); s.on("data", (d) => (got += d)); s.on("timeout", () => { s.destroy(); r("timeout:" + got); }); s.on("close", () => r("closed:" + got)); s.on("error", () => r("error:" + got)); });
const dns = (name) => new Promise((r) => { const u = dgram.createSocket("udp4"); const q = Buffer.concat([Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
  ...name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 1, 0, 1])]);
  const t = setTimeout(() => { u.close(); r("no answer"); }, T); u.on("message", (m) => { clearTimeout(t); u.close(); r("rcode " + (m[3] & 15) + (m.equals(q) ? " (echo from outside)" : "")); }); u.send(q, 53, OUT); });
const viaProxy = (target) => new Promise((r) => { const s = net.connect(3128, "127.0.0.1", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
  let b = ""; s.setTimeout(T); s.on("data", (d) => { b += d; if (b.includes("\\r\\n")) { s.destroy(); r(b.split("\\r\\n")[0]); } }); s.on("timeout", () => { s.destroy(); r("timeout"); }); s.on("error", (e) => r("error " + e.code)); });
const mode = process.argv[2];
const out = mode === "baseline" ? { direct8080: await tcp(OUT, 8080), local_daemon: await tcp("127.0.0.1", 7777) }
  : mode === "root" ? { direct8080: await tcp(OUT, 8080) }
  : { direct8080: await tcp(OUT, 8080), direct22: await tcp(OUT, 22), dns_tcp: await tcp(OUT, 53), local_daemon: await tcp("127.0.0.1", 7777),
      local_resolver_tcp: await tcp("127.0.0.53", 53), own_address: await tcp(${JSON.stringify(IN)}, 7778), ipv6_loopback: await tcp("::1", 7777), tls443_unlisted: await tls443("example.com"), tls443_listed_no_dns: await tls443("allowed.test"),
      dns: await dns("example.com"), proxy_ip: await viaProxy(OUT + ":443"), proxy_unlisted: await viaProxy("example.com:443") };
if (mode === "after") Object.assign(out, { company_exact: await viaProxy("company.test:443"), company_sub: await viaProxy("x.company.test:443") });
console.log(JSON.stringify(out));`);
  const asRunUser = (mode: string) => JSON.parse(sh(["setpriv", `--reuid=${RUID}`, `--regid=${RUID}`, "--clear-groups", process.execPath, path.join(dir, "try.mjs"), mode], { ns: nsS }).trim());

  // 1. baseline
  const before = asRunUser("baseline");
  assert.equal(before.direct8080, true, "before the lockdown the run user reaches the outside (the path exists)");
  assert.equal(before.local_daemon, true, "and a local daemon");
  const base = seenLines().length;
  console.log("✓ before the lockdown the run user reaches the outside directly");

  // 2. the lockdown, as the runner runs it (as root, no systemd), for the run user "nobody"
  for (const [f, body] of [["egress-proxy.mjs", proxySource()], ["egress-allow.json", JSON.stringify({ hosts: ["allowed.test"], exact: ["company.test"] })], ["egress-probe.mjs", probeSource("allowed.test")]] as const)
    writeFileSync(path.join(dir, f), body);
  const inst = path.join(dir, "inst"), logs = path.join(dir, "log");
  sh(["install", "-d", "-m", "755", logs]);
  writeFileSync(path.join(dir, "setup.sh"), setupScript(dir, { user: "octirun", uid: RUID, sudo: false, systemd: false, strict: true, proxyUser: "daemon", installDir: inst, logDir: logs }));
  const set = spawnSync("ip", ["netns", "exec", nsS, "bash", path.join(dir, "setup.sh")], { encoding: "utf8", timeout: 60_000 });
  assert.equal(set.status, 0, `lockdown: ${set.stderr}`);
  assert.match(set.stdout, new RegExp(`egress: locked down \\(octirun uid ${RUID};`), "the run's own uid, by number (it has no account)");
  const after = asRunUser("after");
  console.log(JSON.stringify(after));
  if (process.env.FW_DEBUG) {
    console.log(spawnSync("ip", ["netns", "exec", nsS, "nft", "list", "ruleset"], { encoding: "utf8" }).stdout);
    console.log(spawnSync("ip", ["netns", "exec", nsS, "ss", "-lntup"], { encoding: "utf8" }).stdout);
    console.log(readFileSync(path.join(logs, "octi-egress.log"), "utf8"), readFileSync(path.join(logs, "octi-egress.err"), "utf8"));
  }
  assert.equal(after.direct8080, false, "direct TCP to the outside is dropped");
  assert.equal(after.direct22, false, "any port");
  assert.equal(after.dns_tcp, false, "DNS over TCP to the outside");
  assert.equal(after.local_daemon, false, "a daemon on loopback");
  assert.equal(after.local_resolver_tcp, false, "a local resolver over TCP (as 127.0.0.53 or Docker's 127.0.0.11)");
  assert.equal(after.own_address, false, "a daemon on the sandbox's own address");
  assert.equal(after.ipv6_loopback, false, "IPv6 loopback");
  assert.match(after.tls443_unlisted, /^closed:$/, `443 goes to the proxy, which refuses an unlisted name: ${after.tls443_unlisted}`);
  assert.match(after.tls443_listed_no_dns, /^closed:$/, "a listed name is looked up by the proxy, never passed through by address");
  assert.equal(after.dns, "rcode 3", `DNS answered by the sandbox's responder (NXDOMAIN), not the outside: ${after.dns}`);
  assert.match(after.proxy_ip, /403/);
  assert.match(after.proxy_unlisted, /403/);
  assert.equal(seenLines().length, base, `nothing of the run user reached the outside: ${JSON.stringify(seenLines().slice(base))}`);
  const plog = readFileSync(path.join(logs, "octi-egress.log"), "utf8");
  assert.match(plog, /"deny":"example.com","why":"host not allowed"/);
  // mold_v0-075: a company's host passes the list exactly (then the proxy looks it up: offline, no such name); a
  // subdomain of it does not pass the list at all.
  assert.match(after.company_exact, /403/); assert.match(after.company_sub, /403/);
  assert.match(plog, /"deny":"company.test:443","why":"dns"/, "the company's host passed the allowlist");
  assert.match(plog, /"deny":"x.company.test:443","why":"host not allowed"/, "its subdomain did not");
  console.log("✓ after the lockdown, as the run user: direct TCP dropped (any port, DNS over TCP), no local daemon, local resolver, own address or IPv6; 443 and DNS go to the sandbox's proxy, which refuses unlisted names and addresses; nothing reached the outside");

  // 3. root (the runner) is not the run user
  const root = JSON.parse(sh([process.execPath, path.join(dir, "try.mjs"), "root"], { ns: nsS }).trim());
  assert.equal(root.direct8080, true, "root in the sandbox still reaches the outside");
  assert.equal(seenLines().length, base + 1);
  console.log("✓ the runner (root) still reaches the API: the rules hold for the run's user, by uid");
  console.log("\nRUN FIREWALL TEST PASS");
} catch (e) {
  failed = true;
  console.error(e);
  console.error("\nRUN FIREWALL TEST FAIL");
} finally {
  // The proxy (started detached by the lockdown script, as daemon) and the listeners, by PID; then the namespaces,
  // which takes their links and firewall rules with them.
  for (const k of kids) if (k.pid) { try { process.kill(k.pid, "SIGKILL"); } catch { /* gone */ } }
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(dir)) process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
  }
  for (const ns of [nsS, nsO]) spawnSync("ip", ["netns", "del", ns]);
  rmSync(dir, { recursive: true, force: true });
  await lease?.release();
}
process.exit(failed ? 1 : 0);
