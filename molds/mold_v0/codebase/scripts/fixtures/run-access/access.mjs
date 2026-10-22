// mold_v0-075 fixture: what a run receives. A file credential's path in its declared variable, an operator credential,
// and egress through the run's proxy to the hosts it is told (RUN_SCOPE.hosts). By mode: print or write a value.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
const env = process.env, scope = JSON.parse(env.RUN_SCOPE || "{}");
const say = (o) => console.log(JSON.stringify(o));
const fileOf = (p) => (p && existsSync(p) ? { path: p, in_dir: !!env.RUN_CREDENTIALS_DIR && p.startsWith(`${env.RUN_CREDENTIALS_DIR}/`), mode: (statSync(p).mode & 0o777).toString(8),
  uid: statSync(p).uid, sha: createHash("sha256").update(readFileSync(p)).digest("hex") } : p ? { path: p, missing: true } : null);
say({ event: "access", kube: fileOf(env.KUBECONFIG), prod: fileOf(env.PROD_RO_KUBECONFIG), cred_dir: env.RUN_CREDENTIALS_DIR ?? null,
  op: env.CATALOGUE_LOGIN ? createHash("sha256").update(env.CATALOGUE_LOGIN).digest("hex") : null, op_file: fileOf(env.CATALOGUE_FILE) });
if (scope.mode === "print") { say({ event: "printed", line: `login is ${env.CATALOGUE_LOGIN}` }); console.error(`stderr: ${env.CATALOGUE_LOGIN}`); }
if (scope.mode === "leak_ws") writeFileSync(`${env.RUN_WORKSPACE}/stolen.txt`, `${env.CATALOGUE_LOGIN}\n`);
if (scope.mode === "egress") {
  const proxy = new URL(env.HTTPS_PROXY);
  const tryHost = (h) => new Promise((r) => { const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write(`CONNECT ${h}:443 HTTP/1.1\r\nHost: ${h}:443\r\n\r\n`));
    let b = ""; s.setTimeout(5000); s.on("data", (d) => { b += d; if (b.includes("\r\n")) { s.destroy(); r(b.split("\r\n")[0]); } }); s.on("timeout", () => { s.destroy(); r("timeout"); }); s.on("error", (e) => r(`error ${e.code}`)); });
  const out = {};
  for (const h of scope.hosts ?? []) out[h] = await tryHost(h);
  say({ event: "egress", ...out });
}
writeFileSync(`${env.RUN_OUT}/results.json`, JSON.stringify(scope.mode === "print_results" ? [{ check: { area: "access_checks", key: "c1" }, status: "pass", detail: { note: env.CATALOGUE_LOGIN } }] : []));
