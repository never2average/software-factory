/**
 * Network egress lockdown for an agent sandbox (docs/security.md, phase 2). Used for private runs, where customer
 * text steers the agent: the coding agent (uid `agent`) may only reach an allowlist of hosts, through a small HTTPS
 * proxy running inside the VM as its own user.
 *
 *   agent ──► 127.0.0.1:3128 (proxy, user octiproxy) ──► gateway, package registries, the task's git host
 *   agent ──► anything else (internet, DNS, metadata IP, other machines): dropped by nftables/iptables (uid match)
 *
 * The proxy accepts CONNECT to port 443 only, refuses IP-literal targets and any host that resolves to a private,
 * loopback, link-local (metadata) or reserved address, and logs every decision. Loopback stays open for the agent
 * (dev servers, test databases). After the rules are in place a probe, run as the agent, must reach the gateway
 * through the proxy and must fail to reach the internet directly, an unlisted host through the proxy, the metadata
 * IP and a public DNS server; any other outcome fails the sandbox open (fail closed).
 */

export const EGRESS_PROXY_PORT = 3128;
/** Transparent TLS (SNI) listener and DNS responder the firewall redirects the agent's 443 and 53 to. */
export const EGRESS_TRANSPARENT_PORT = 3129;
export const EGRESS_DNS_PORT = 15353;
export const EGRESS_DIR = "/opt/octi-egress";

/** Hosts agents need beyond the gateway: package registries (installing packages is part of the measured choice). */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "sum.golang.org",
  "index.crates.io", "static.crates.io", "crates.io", "repo.maven.apache.org", "repo1.maven.org", "pub.dev", "storage.googleapis.com",
  "rubygems.org", "packagist.org", "repo.packagist.org", "api.nuget.org",
];

export interface EgressPolicy { hosts: string[]; gatewayHost: string; gatewayPort: number }

/** The allowlist for one session: the gateway's host(s), registries, and the task repository's git host. */
export function egressPolicy(opts: { gatewayUrls: string[]; repoUrl?: string | null }): EgressPolicy {
  const hosts = new Set<string>(REGISTRY_HOSTS);
  let gatewayHost = "", gatewayPort = 443;
  for (const u of opts.gatewayUrls) {
    try {
      const x = new URL(u);
      if (!gatewayHost) { gatewayHost = x.hostname.toLowerCase(); gatewayPort = x.port ? Number(x.port) : x.protocol === "https:" ? 443 : 80; }
      hosts.add(x.hostname.toLowerCase());
    } catch { /* ignore */ }
  }
  if (opts.repoUrl) {
    try {
      const h = new URL(opts.repoUrl).hostname.toLowerCase();
      if (!isIpLiteral(h)) { hosts.add(h); if (h === "github.com") hosts.add("codeload.github.com"); }
    } catch { /* ignore */ }
  }
  if (!gatewayHost) throw new Error("egress: no gateway URL to allow");
  if (gatewayPort !== 443) throw new Error(`egress: the gateway must be HTTPS on port 443 (got ${gatewayHost}:${gatewayPort})`);
  return { hosts: [...hosts].sort(), gatewayHost, gatewayPort };
}

const isIpLiteral = (h: string) => /^[\d.]+$/.test(h) || h.includes(":");

/** Environment for the agent's processes so HTTP clients use the proxy (Node needs NODE_USE_ENV_PROXY for fetch). */
export function proxyEnv(): Record<string, string> {
  const p = `http://127.0.0.1:${EGRESS_PROXY_PORT}`;
  return { HTTPS_PROXY: p, HTTP_PROXY: p, https_proxy: p, http_proxy: p, ALL_PROXY: p, all_proxy: p, NO_PROXY: "localhost,127.0.0.1,::1",
           no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1", npm_config_proxy: p, npm_config_https_proxy: p };
}

/** The proxy program written into the VM (Node, no dependencies). Args: allowlist JSON path, log path. */
export function proxySource(): string {
  return `// Octillion egress proxy (orchestrator/core/egress.ts): CONNECT to allowlisted hosts on 443 only.
import http from "node:http"; import net from "node:net"; import dns from "node:dns/promises"; import fs from "node:fs";
const allow = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).hosts;
const logf = process.argv[3];
const log = (o) => { try { fs.appendFileSync(logf, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\\n"); } catch {} };
// A bug in one connection must never take the whole proxy (and with it the agent's only way out) down: record it, carry on.
process.on("uncaughtException", (e) => log({ error: "uncaught", message: String(e && e.stack || e).slice(0, 400) }));
process.on("unhandledRejection", (e) => log({ error: "unhandled", message: String(e && e.stack || e).slice(0, 400) }));
function blocked(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const m = /^::(?:ffff:)?(\\d+\\.\\d+\\.\\d+\\.\\d+)$/.exec(x);
    if (m) return blocked(m[1]);
    const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return blocked((a >> 8) + "." + (a & 255) + "." + (b >> 8) + "." + (b & 255)); }
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") ||
      x.startsWith("2001:db8") || x.startsWith("2002:") || x.startsWith("2001:0:") || x.startsWith("2001::");
  }
  return true;
}
const listed = (h) => allow.some((b) => h === b || h.endsWith("." + b));
const srv = http.createServer((req, res) => { log({ deny: String(req.url).slice(0, 200), why: "plain http" }); res.writeHead(403); res.end("egress: HTTPS via CONNECT only\\n"); });
srv.on("connect", async (req, sock, head) => {
  const deny = (why) => { log({ deny: String(req.url).slice(0, 200), why }); sock.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); };
  const m = /^([A-Za-z0-9.-]+):(\\d+)$/.exec(req.url || "");
  if (!m) return deny("bad or IP-literal target");
  const host = m[1].toLowerCase(), port = Number(m[2]);
  if (port !== 443) return deny("port " + port);
  if (/^[\\d.]+$/.test(host)) return deny("IP literal");
  if (!listed(host)) return deny("host not allowed");
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { return deny("dns"); }
  const good = addrs.filter((a) => !blocked(a.address));
  if (!good.length) return deny("private or reserved address");
  const up = net.connect(port, good[0].address, () => {
    sock.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
    log({ allow: host });
  });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
srv.on("clientError", (e, s) => s.destroy());
const fatal = (what) => (e) => { log({ fatal: what, error: String(e && e.message || e) }); process.stderr.write("egress proxy: " + what + ": " + String(e && e.message || e) + "\\n"); process.exit(1); };
srv.on("error", fatal("proxy listener"));
srv.listen(Number(process.argv[4] || ${EGRESS_PROXY_PORT}), "127.0.0.1");
const TPORT = ${EGRESS_TRANSPARENT_PORT}, DPORT = ${EGRESS_DNS_PORT};

// Transparent mode: the firewall redirects the agent's outbound TCP 443 here, so harnesses that ignore proxy settings
// still go through the allowlist. The host comes from the TLS ClientHello (SNI); we connect to that host's own public
// address, so a forged SNI cannot reach anything but an allowlisted host.
function sniOf(buf) {
  if (buf.length < 5 || buf[0] !== 0x16) return { need: buf.length < 5 };
  const recLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recLen) return { need: true };
  let p = 5;
  if (buf[p] !== 0x01) return {};
  p += 4 + 2 + 32;
  p += 1 + buf[p];
  p += 2 + buf.readUInt16BE(p);
  p += 1 + buf[p];
  if (p + 2 > buf.length) return {};
  const end = p + 2 + buf.readUInt16BE(p); p += 2;
  while (p + 4 <= end && p + 4 <= buf.length) {
    const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
    if (type === 0 && p + 5 <= buf.length) { const n = buf.readUInt16BE(p + 3); return { host: buf.slice(p + 5, p + 5 + n).toString("latin1").toLowerCase() }; }
    p += len;
  }
  return {};
}
const tsrv = net.createServer((sock) => {
  let buf = Buffer.alloc(0); let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; log({ deny: "transparent", why: "no TLS ClientHello" }); sock.destroy(); } }, 5000);
  const onData = async (d) => {
    if (done) return;
    buf = Buffer.concat([buf, d]);
    const r = sniOf(buf);
    if (r.need && buf.length < 16384) return;
    done = true; clearTimeout(timer); sock.removeListener("data", onData); sock.pause();
    const host = r.host;
    const deny = (why) => { log({ deny: host || "transparent", why }); sock.destroy(); };
    if (!host) return deny("no SNI");
    if (/^[\\d.]+$/.test(host) || host.includes(":")) return deny("IP literal");
    if (!listed(host)) return deny("host not allowed");
    let addrs; try { addrs = await dns.lookup(host, { all: true }); } catch { return deny("dns"); }
    const good = addrs.filter((a) => !blocked(a.address));
    if (!good.length) return deny("private or reserved address");
    const up = net.connect(443, good[0].address, () => { up.write(buf); up.pipe(sock); sock.pipe(up); sock.resume(); log({ allow: host, mode: "transparent" }); });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  };
  sock.on("data", onData); sock.on("error", () => {});
});
tsrv.on("error", fatal("transparent TLS listener"));
tsrv.listen(Number(process.argv[5] || TPORT), "127.0.0.1");

// DNS for the agent (the firewall redirects its port 53 here): allowlisted names get their public IPv4 addresses,
// everything else NXDOMAIN, and nothing is forwarded for unlisted names, so DNS cannot carry data out.
import dgram from "node:dgram";
const udp = dgram.createSocket("udp4");
udp.on("message", async (q, rinfo) => {
  if (q.length < 17) return;
  let p = 12; const labels = [];
  while (p < q.length && q[p] !== 0) { const n = q[p]; labels.push(q.slice(p + 1, p + 1 + n).toString("latin1")); p += 1 + n; }
  const qEnd = p + 5; if (qEnd > q.length) return;
  const name = labels.join(".").toLowerCase(), qtype = q.readUInt16BE(p + 1);
  const head = Buffer.alloc(12); q.copy(head, 0, 0, 2); head.writeUInt16BE(1, 4);
  const question = q.slice(12, qEnd);
  let answers = [];
  let rcode = 3;
  if (listed(name)) {
    rcode = 0;
    if (qtype === 1) {
      try { answers = (await dns.lookup(name, { all: true, family: 4 })).map((a) => a.address).filter((a) => !blocked(a)); } catch {}
      if (!answers.length) rcode = 2;
    }
  }
  log(rcode === 0 ? { allow: name, mode: "dns" } : { deny: name, why: "dns not allowed" });
  head.writeUInt16BE(0x8180 | rcode, 2); head.writeUInt16BE(answers.length, 6);
  const rr = answers.map((ip) => { const b = Buffer.alloc(16); b.writeUInt16BE(0xc00c, 0); b.writeUInt16BE(1, 2); b.writeUInt16BE(1, 4); b.writeUInt32BE(60, 6); b.writeUInt16BE(4, 10); ip.split(".").forEach((x, i) => (b[12 + i] = Number(x))); return b; });
  udp.send(Buffer.concat([head, question, ...rr]), rinfo.port, rinfo.address);
});
udp.on("error", fatal("DNS responder"));
udp.bind(Number(process.argv[6] || DPORT), "127.0.0.1");
`;
}

/** Facts about the lockdown, collected from the VM when its probe fails (the VM is destroyed right after). */
export function diagnosticsScript(): string {
  return `echo "--- proxy processes"; ps -eo user:10,pid,args 2>/dev/null | grep -E "proxy.mjs" | grep -v grep | cut -c1-120 | head -3; echo "(end)"
echo "--- service"; sudo -n systemctl is-active octi-egress-proxy 2>&1 | head -1; sudo -n journalctl -u octi-egress-proxy -n 6 --no-pager 2>/dev/null | cut -c1-160
echo "--- listeners"; (sudo -n ss -lntu 2>/dev/null || ss -lntu 2>/dev/null) | head -10
echo "--- proxy error output"; sudo -n head -c 500 /var/log/octi-egress.err 2>/dev/null | head -8
echo "--- proxy log (last)"; sudo -n tail -n 12 /var/log/octi-egress.log 2>/dev/null | cut -c1-160
echo "--- rules"; (sudo -n nft list table inet octi_egress 2>&1 | head -14) || true
(sudo -n iptables -t nat -S OUTPUT 2>/dev/null; sudo -n iptables -S OUTPUT 2>/dev/null) | grep -E "owner|REDIRECT|DROP" | head -8 || true
echo "--- resolver"; grep -v '^#' /etc/resolv.conf 2>/dev/null | head -3`;
}

/** Probe program run as the agent after lockdown; prints JSON results and exits 1 on any unexpected outcome. */
export function probeSource(gatewayHost: string): string {
  return `import net from "node:net"; import tls from "node:tls"; import dns from "node:dns/promises";
const T = 6000;
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: T }); s.on("connect", () => { s.destroy(); r(true); }); s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false)); });
const viaProxy = (target) => new Promise((r) => {
  const s = net.connect(${EGRESS_PROXY_PORT}, "127.0.0.1", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
  let buf = ""; s.setTimeout(T); s.on("data", (d) => { buf += d; if (buf.includes("\\r\\n")) { s.destroy(); r(/^HTTP\\/1\\.1 200/.test(buf)); } });
  s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false));
});
const tlsOk = (host, servername) => new Promise((r) => {
  const s = tls.connect({ host, port: 443, servername, timeout: T, rejectUnauthorized: false }, () => { s.destroy(); r(true); });
  s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false)); s.on("close", () => r(false));
});
const resolves = (name) => dns.lookup(name).then(() => true, () => false);
const checks = [
  ["gateway directly (transparent, as a harness that ignores proxy settings)", true, () => tlsOk(${JSON.stringify(gatewayHost)}, ${JSON.stringify(gatewayHost)})],
  ["DNS for the gateway", true, () => resolves(${JSON.stringify(gatewayHost)})],
  ["DNS for an unlisted host", false, () => resolves("example.com")],
  ["HTTPS to an unlisted host by IP", false, () => tlsOk("93.184.215.14", "example.com")],
  ["HTTPS by IP with a forged allowlisted name", true, () => tlsOk("93.184.215.14", ${JSON.stringify(gatewayHost)})],
  ["plain HTTP directly", false, () => tcp("93.184.215.14", 80)],
  ["gateway through the proxy", true, () => viaProxy(${JSON.stringify(gatewayHost)} + ":443")],
  ["unlisted host through the proxy", false, () => viaProxy("example.com:443")],
  ["IP literal through the proxy", false, () => viaProxy("1.1.1.1:443")],
  ["public DNS directly", false, () => tcp("1.1.1.1", 53)],
  ["metadata IP directly", false, () => tcp("169.254.169.254", 80)],
];
const out = []; let bad = 0;
for (const [name, want, f] of checks) { const got = await f(); out.push({ name, want, got }); if (got !== want) bad++; }
console.log(JSON.stringify({ ok: bad === 0, checks: out }));
process.exit(bad ? 1 : 0);
`;
}

/**
 * Root-side setup (runs as the boat user with sudo): proxy user and files, start the proxy, firewall rules for the
 * agent uid. Exits non-zero (fail closed) when node or a firewall tool is missing or the proxy does not come up.
 * `user`: whose traffic is locked down ("agent" by default; a run sandbox's run user, mold_v0-055). `sudo`: false when
 * the script already runs as root (a run sandbox's runner). `systemd`: false keeps the proxy a detached process of the
 * caller rather than a systemd unit (a run sandbox's runner lives as long as the run; a network namespace is not
 * systemd's). `proxyUser`, `installDir`, `logDir`: the proxy's user and files elsewhere than the defaults (the offline
 * firewall test, which must not add a user or files to the machine it runs on).
 */
export function setupScript(dir: string, opts: { user?: string; sudo?: boolean; systemd?: boolean; proxyUser?: string; installDir?: string; logDir?: string; strict?: boolean } = {}): string {
  const user = opts.user ?? "agent", proxyUser = opts.proxyUser ?? "octiproxy";
  const name = /^[a-z_][a-z0-9_-]{0,31}$/, dirOk = /^\/[A-Za-z0-9._\/-]{1,200}$/;
  if (!name.test(user) || !name.test(proxyUser)) throw new Error(`egress: not a user name: ${user} / ${proxyUser}`);
  if ((opts.installDir && !dirOk.test(opts.installDir)) || (opts.logDir && !dirOk.test(opts.logDir))) throw new Error("egress: install and log directories are absolute plain paths");
  let body = setupBody(dir, user);
  if (opts.strict) body = strictRules(body);
  if (opts.systemd === false) body = body.replace("if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then", "if false; then");
  if (opts.installDir) body = body.replace(`D=${EGRESS_DIR};`, `D=${opts.installDir};`);
  if (opts.logDir) body = body.replaceAll("/var/log/octi-egress.", `${opts.logDir}/octi-egress.`);
  if (proxyUser !== "octiproxy") body = body.replaceAll("octiproxy", proxyUser);
  // As root already, "sudo -n" is dropped (a container has no sudo); "-u <proxy user>" runs through runuser instead.
  return opts.sudo === false ? body.replaceAll(`sudo -n -u ${proxyUser} `, `runuser -u ${proxyUser} -- `).replaceAll("sudo -n ", "") : body;
}
/**
 * A run sandbox's rules (mold_v0-055, `strict`): the run user reaches loopback only at the proxy's three ports, so
 * neither a local resolver (Docker's 127.0.0.11, systemd-resolved's 127.0.0.53, over UDP or TCP) nor any other local
 * daemon (on loopback or the sandbox's own address) is a way out; DNS over UDP goes to the proxy's responder from a nat
 * chain that runs before Docker's own (priority -150), DNS over TCP is dropped; IPv6 is dropped, and the iptables form
 * fails closed when ip6tables is missing.
 */
function strictRules(body: string): string {
  const nftStart = body.indexOf("table inet octi_egress {"), nftEnd = body.indexOf("\nEOF\n", nftStart);
  const nft = `table inet octi_egress {
  chain nat_out {
    type nat hook output priority -150; policy accept;
    meta skuid $AUID udp dport 53 redirect to :${EGRESS_DNS_PORT}
    meta skuid $AUID tcp dport 443 redirect to :${EGRESS_TRANSPARENT_PORT}
  }
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid $AUID ip daddr 127.0.0.1 tcp dport { ${EGRESS_PROXY_PORT}, ${EGRESS_TRANSPARENT_PORT} } accept
    meta skuid $AUID ip daddr 127.0.0.1 udp dport ${EGRESS_DNS_PORT} accept
    meta skuid $AUID counter drop
  }
}`;
  let out = body.slice(0, nftStart) + nft + body.slice(nftEnd);
  const ipStart = out.indexOf("elif command -v iptables"), ipEnd = out.indexOf("else\n  echo \"egress: neither nft nor iptables", ipStart);
  const ipt = `elif command -v iptables >/dev/null 2>&1 && command -v ip6tables >/dev/null 2>&1; then
  sudo -n iptables -t nat -I OUTPUT 1 -m owner --uid-owner "$AUID" -p udp --dport 53 -j REDIRECT --to-ports ${EGRESS_DNS_PORT}
  sudo -n iptables -t nat -I OUTPUT 2 -m owner --uid-owner "$AUID" -p tcp --dport 443 -j REDIRECT --to-ports ${EGRESS_TRANSPARENT_PORT}
  sudo -n iptables -A OUTPUT -d 127.0.0.1 -p tcp --dport ${EGRESS_PROXY_PORT} -m owner --uid-owner "$AUID" -j ACCEPT
  sudo -n iptables -A OUTPUT -d 127.0.0.1 -p tcp --dport ${EGRESS_TRANSPARENT_PORT} -m owner --uid-owner "$AUID" -j ACCEPT
  sudo -n iptables -A OUTPUT -d 127.0.0.1 -p udp --dport ${EGRESS_DNS_PORT} -m owner --uid-owner "$AUID" -j ACCEPT
  sudo -n iptables -A OUTPUT -m owner --uid-owner "$AUID" -j DROP
  sudo -n ip6tables -A OUTPUT -m owner --uid-owner "$AUID" -j DROP
elif command -v iptables >/dev/null 2>&1; then
  echo "egress: iptables without ip6tables would leave IPv6 open" >&2; exit 23
`;
  out = out.slice(0, ipStart) + ipt + out.slice(ipEnd);
  if (!out.includes("priority -150") || !out.includes("exit 23")) throw new Error("egress: strict rules not applied");
  return out;
}

function setupBody(dir: string, user: string): string {
  return `set -eu
D=${EGRESS_DIR}; O=${dir}
NODE="$(command -v node || true)"; [ -n "$NODE" ] || { echo "egress: node not found" >&2; exit 20; }
id octiproxy >/dev/null 2>&1 || sudo -n useradd -r -M -s /usr/sbin/nologin octiproxy
sudo -n install -d -m 755 -o root -g root "$D"
sudo -n install -m 644 -o root -g root "$O/egress-proxy.mjs" "$D/proxy.mjs"
sudo -n install -m 644 -o root -g root "$O/egress-allow.json" "$D/allow.json"
sudo -n install -m 644 -o root -g root "$O/egress-probe.mjs" "$D/probe.mjs"
sudo -n install -m 640 -o octiproxy -g root /dev/null /var/log/octi-egress.log
sudo -n install -m 640 -o octiproxy -g root /dev/null /var/log/octi-egress.err
# The proxy must outlive this command's session (a plain background child is killed when it ends): run it as its own
# systemd service; where there is no systemd, as a detached session whose stderr is opened by the proxy user itself.
if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  sudo -n systemd-run --quiet --unit=octi-egress-proxy --uid=octiproxy --property=Restart=on-failure --property=StandardOutput=null \\
    --property=StandardError=append:/var/log/octi-egress.err "$NODE" "$D/proxy.mjs" "$D/allow.json" /var/log/octi-egress.log
else
  sudo -n -u octiproxy setsid sh -c 'exec nohup "$0" "$@" >/dev/null 2>/var/log/octi-egress.err' "$NODE" "$D/proxy.mjs" "$D/allow.json" /var/log/octi-egress.log </dev/null &
fi
up=0; for i in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/${EGRESS_PROXY_PORT}) 2>/dev/null && { up=1; break; }; sleep 0.25; done
# All three listeners must be up: the proxy port, the transparent TLS port and the DNS responder.
if [ "$up" = 1 ]; then
  up=0; for i in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/${EGRESS_TRANSPARENT_PORT}) 2>/dev/null && { up=1; break; }; sleep 0.25; done
fi
[ "$up" = 1 ] || { echo "egress: proxy did not start: $(sudo -n head -c 600 /var/log/octi-egress.err 2>/dev/null | tr '\\n' ' ')" >&2; exit 22; }
AUID="$(id -u ${user})"
if command -v nft >/dev/null 2>&1; then
  sudo -n nft -f - <<EOF
table inet octi_egress {
  chain nat_out {
    type nat hook output priority -100; policy accept;
    meta skuid $AUID udp dport 53 redirect to :${EGRESS_DNS_PORT}
    meta skuid $AUID tcp dport 443 redirect to :${EGRESS_TRANSPARENT_PORT}
  }
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid $AUID oifname "lo" accept
    # A packet the nat chain redirected to the proxy keeps the output interface it had before (oifname is not updated
    # by the reroute), so loopback is also matched by its (rewritten) destination: else every redirected 443 and DNS
    # packet is dropped (found by scripts/run-firewall-test.ts, mold_v0-055).
    meta skuid $AUID ip daddr 127.0.0.0/8 accept
    meta skuid $AUID ip6 daddr ::1 accept
    meta skuid $AUID counter drop
  }
}
EOF
elif command -v iptables >/dev/null 2>&1; then
  sudo -n iptables -t nat -A OUTPUT -m owner --uid-owner "$AUID" -p udp --dport 53 -j REDIRECT --to-ports ${EGRESS_DNS_PORT}
  sudo -n iptables -t nat -A OUTPUT -m owner --uid-owner "$AUID" -p tcp --dport 443 -j REDIRECT --to-ports ${EGRESS_TRANSPARENT_PORT}
  sudo -n iptables -A OUTPUT -o lo -m owner --uid-owner "$AUID" -j ACCEPT
  sudo -n iptables -A OUTPUT -d 127.0.0.0/8 -m owner --uid-owner "$AUID" -j ACCEPT
  sudo -n iptables -A OUTPUT -m owner --uid-owner "$AUID" -j DROP
  if command -v ip6tables >/dev/null 2>&1; then
    sudo -n ip6tables -A OUTPUT -o lo -m owner --uid-owner "$AUID" -j ACCEPT
    sudo -n ip6tables -A OUTPUT -d ::1/128 -m owner --uid-owner "$AUID" -j ACCEPT
    sudo -n ip6tables -A OUTPUT -m owner --uid-owner "$AUID" -j DROP
  fi
else
  echo "egress: neither nft nor iptables is available" >&2; exit 21
fi
echo "egress: locked down (${user} uid $AUID; proxy on 127.0.0.1:${EGRESS_PROXY_PORT})"
`;
}
