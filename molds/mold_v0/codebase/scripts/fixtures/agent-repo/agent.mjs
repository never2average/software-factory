// A tiny agent repository's command (mold_v0-061 fixture; scripts/agent-runner-test.ts commits it into a local git
// repository): node agent.mjs --company <id> --mode <mode>. It reports what the restored workspace holds, appends the
// run to data/<company>/notes.json, writes its results and a session summary, and, by mode, misbehaves.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const company = arg("company"), mode = arg("mode") ?? "ok";
const say = (o) => console.log(JSON.stringify(o));
const file = `data/${company}/notes.json`;
const notes = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).notes : null;
say({ event: "seen", company, notes, data: existsSync("data") ? readdirSync("data").sort() : [], stripped: { secret: existsSync("secret.txt"), samples: existsSync("samples") },
  uid: process.getuid?.(), argv: process.argv.slice(2) });
say({ event: "env", has_gateway_token: !!process.env.ANTHROPIC_AUTH_TOKEN, base_url: process.env.ANTHROPIC_BASE_URL ?? null, fixed: process.env.AGENT_FIXED ?? null,
  token_cred: process.env.FIXTURE_AGENT_TOKEN ? "set" : "unset", cred_file: process.env.RUN_CREDENTIALS_DIR && existsSync(`${process.env.RUN_CREDENTIALS_DIR}/agent_key.pem`) ? "set" : "unset" });
mkdirSync(`data/${company}`, { recursive: true });
writeFileSync(file, JSON.stringify({ notes: [...(notes ?? []), process.env.RUN_ID] }));
mkdirSync("sessions", { recursive: true });
writeFileSync(`sessions/${process.env.RUN_ID}.summary.json`, JSON.stringify({ run: process.env.RUN_ID, turns: 3, cost_usd: 0.01 }));
mkdirSync("out", { recursive: true });
const results = [{ check: { area: "agent_checks", key: "c1" }, asset: { area: "agent_apps", key: `${company}-app` }, status: "fail", finding_fingerprint: "fp-1" },
  { check: { area: "agent_checks", key: "c1" }, asset: { area: "agent_apps", key: `${company}-app` }, status: "fail", finding_fingerprint: "fp-2" }];
if (mode === "leak") {
  // Every value it was given, everywhere it can write.
  const vals = [process.env.FIXTURE_AGENT_TOKEN, process.env.ANTHROPIC_AUTH_TOKEN, readFileSync(`${process.env.RUN_CREDENTIALS_DIR}/agent_key.pem`, "utf8").trim()];
  for (const v of vals) { console.log(`value: ${v}`); console.error(`stderr value: ${v}`); }
  results[0].detail = { leaked: vals };
}
if (mode === "leak_ws") writeFileSync(`data/${company}/stolen.txt`, process.env.FIXTURE_AGENT_TOKEN ?? "");
if (mode === "invalid") writeFileSync(file, "{ not json");
if (mode === "symlink") { symlinkSync("/etc/hostname", `data/${company}/planted`); symlinkSync("/etc", "data/escape"); }
if (mode === "outside") { mkdirSync("elsewhere", { recursive: true }); writeFileSync("elsewhere/x.txt", "not written back"); }
if (mode === "egress") {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const ask = (t) => new Promise((r) => { const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write(`CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`));
    let b = ""; s.setTimeout(8000); s.on("data", (d) => { b += d; if (b.includes("\r\n")) { s.destroy(); r(b.split("\r\n")[0]); } }); s.on("timeout", () => { s.destroy(); r("timeout"); }); s.on("error", (e) => r(`error ${e.code}`)); });
  say({ event: "egress", allowed: await ask("api.agent-allowed.example:443"), other: await ask("elsewhere.example:443") });
}
writeFileSync("out/results.json", JSON.stringify(results));
if (mode === "sleep") {
  // A child in its own session that would outlive the run, and the agent itself never ends.
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); c.unref();
  say({ event: "child", pid: c.pid });
  setInterval(() => {}, 1000);
}
if (mode === "tamper") { writeFileSync("validate.mjs", "process.exit(0);\n"); writeFileSync(file, "{ not json"); } // its own validator rewritten
if (mode === "fifo") { spawnSync("mkfifo", [`${process.env.RUN_OUT}/results.json`]); } // a pipe where the runner reads its results
if (mode === "forbidden") writeFileSync(`data/${company}/forbidden.json`, "{}"); // a stripped path, written into the workspace
if (mode === "big") writeFileSync(`data/${company}/big.bin`, Buffer.alloc(2 * 1024 * 1024));
if (mode === "fail") process.exit(3);
