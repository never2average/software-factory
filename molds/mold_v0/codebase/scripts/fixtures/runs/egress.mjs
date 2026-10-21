// The per-run egress probe: asks the run's proxy (HTTPS_PROXY) to CONNECT to each host in RUN_SCOPE.try and reports
// the proxy's answer line for each. It never connects directly: what it proves is the proxy's allowlist.
import net from "node:net";

const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const ask = (target) => new Promise((resolve) => {
  if (!proxy) return resolve("no proxy");
  const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = ""; s.setTimeout(8000);
  s.on("data", (d) => { buf += d; if (buf.includes("\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]); } });
  s.on("timeout", () => { s.destroy(); resolve("timeout"); }); s.on("error", (e) => resolve(`error ${e.code ?? e.message}`)); s.on("close", () => resolve(buf.split("\r\n")[0] || "closed"));
});
const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
const answers = {};
for (const t of scope.try ?? []) answers[t] = await ask(t);
console.log(JSON.stringify({ event: "egress", proxy: !!proxy, answers }));
