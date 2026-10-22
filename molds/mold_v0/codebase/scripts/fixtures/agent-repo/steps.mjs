// A program with steps (mold_v0-071..074 fixture; scripts/agent-steps-test.ts commits it into a local git repository
// with agent.mjs and validate.mjs). It stands in for an audit program: one command writes a result OBJECT outside the
// checkout (<RUN_OUT>), a step turns a spec file (an input) into repository manifests, a step asks git for a credential,
// a step reads the repositories the runner checked out. Each prints one JSON line saying what it saw.
//   node steps.mjs main --company <id> --mode <mode>
//   node steps.mjs add <spec.json> --company <id>
//   node steps.mjs gitfill <host>
//   node steps.mjs readrepo <dir> [<another workspace's path>]
//   node steps.mjs tool <program> [args...]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const say = (o) => console.log(JSON.stringify(o));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const credNames = () => ({ token_env: process.env.FIXTURE_AGENT_TOKEN ? "set" : "unset", git_env: process.env.FIXTURE_GIT_TOKEN ? "set" : "unset",
  cred_dir: process.env.RUN_CREDENTIALS_DIR ? readdirSync(process.env.RUN_CREDENTIALS_DIR).sort() : null, git_config: process.env.GIT_CONFIG_GLOBAL ?? null });

if (cmd === "main") {
  const company = arg("company"), mode = arg("mode") ?? "ok";
  say({ event: "main_env", ...credNames(), path_first: (process.env.PATH ?? "").split(":")[0] });
  mkdirSync(`data/${company}`, { recursive: true });
  const notes = `data/${company}/notes.json`;
  writeFileSync(notes, JSON.stringify({ notes: [...(existsSync(notes) ? JSON.parse(readFileSync(notes, "utf8")).notes : []), process.env.RUN_ID] }));
  // The program's own result: an object, outside the checkout (as an audit program's --result-file is).
  const findings = [
    { id: "f-1", kind: "finding", control: "c1", app: `${company}-app`, status: "open", fingerprint: "fp-a", severity: "high", title: "First" },
    { id: "f-2", kind: "finding", control: "c1", app: `${company}-app`, status: "resolved", fingerprint: "fp-b", severity: "low", title: "Second" },
    { id: "n-1", kind: "note", title: "not a finding" },
  ];
  if (mode === "unmappable") findings.push({ id: "f-3", kind: "finding", app: `${company}-app`, status: "open", fingerprint: "fp-c" }); // no control
  if (mode === "forged") {
    // Another workspace's application as the asset, a check that does not exist, a status outside the map, a key
    // posing as the prototype, a fingerprint with forbidden characters, an item that is not an object.
    findings.push({ id: "f-4", kind: "finding", control: "c1", status: "open", fingerprint: "fp-d", app: "b-co-app" });
    findings.push({ id: "f-5", kind: "finding", control: "nope", app: `${company}-app`, status: "open", fingerprint: "fp-e" });
    findings.push({ id: "f-6", kind: "finding", control: "c1", app: `${company}-app`, status: "pwned", fingerprint: "fp-f" });
    findings.push(JSON.parse(`{"id":"f-7","kind":"finding","control":"c1","app":"${company}-app","status":"open","fingerprint":"fp g;rm"}`));
    findings.push(JSON.parse(`{"id":"f-9","kind":"finding","app":"${company}-app","status":"open","fingerprint":"fp-i","__proto__":{"control":"c1"}}`));
    findings.push("f-8");
  }
  const doc = { workflow: "audit", company, outcome: "success", files: [notes], ledger: { appended: findings.length }, findings, validation: { ran: true, ok: true } };
  if (mode !== "nofile") {
    if (mode === "symlink") symlinkSync("/etc/hostname", `${process.env.RUN_OUT}/program-result.json`);
    else writeFileSync(`${process.env.RUN_OUT}/program-result.json`, mode === "leak" ? JSON.stringify({ ...doc, findings: [{ ...findings[0], title: process.env.FIXTURE_AGENT_TOKEN }] }) : JSON.stringify(doc));
  }
  writeFileSync(`${process.env.RUN_OUT}/report.md`, `# Audit of ${company}\n`);
  mkdirSync(`${process.env.RUN_OUT}/sub`, { recursive: true });
  writeFileSync(`${process.env.RUN_OUT}/sub/usage.json`, JSON.stringify({ turns: 2 }));
  // The checkout cache's repositories are links the write-back never keeps; one the program put elsewhere is its own.
  if (mode === "copy_into_mount") { try { writeFileSync(`data/${company}/repos/one/STOLEN`, "x"); say({ event: "mount_write", ok: true }); } catch (e) { say({ event: "mount_write", ok: false, code: e.code }); } }
  process.exit(0);
}

if (cmd === "add") {
  // An application spec (an input file) to repository manifests in the workspace, as an audit program's add does.
  const spec = JSON.parse(readFileSync(rest[0], "utf8"));
  const company = arg("company");
  mkdirSync(`data/${company}/repos`, { recursive: true });
  for (const r of spec.repos) writeFileSync(`data/${company}/repos/${r.repoId}.json`, JSON.stringify({ repoId: r.repoId, url: r.url, pinnedCommit: r.pinnedCommit }));
  say({ add: { app: spec.appId, repos: spec.repos.length, input_mode: (lstatSync(rest[0]).mode & 0o777).toString(8) }, ...credNames() });
  process.exit(0);
}

if (cmd === "gitfill") {
  // What git hands over for the declared host, and for another one; what this process's environment and arguments hold.
  const fill = (host) => spawnSync("git", ["credential", "fill"], { input: `protocol=https\nhost=${host}\n\n`, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" } });
  const ok = fill(rest[0]), other = fill("elsewhere.example");
  const pw = /^password=(.*)$/m.exec(ok.stdout)?.[1] ?? null, user = /^username=(.*)$/m.exec(ok.stdout)?.[1] ?? null;
  say({ gitfill: { password_sha256: pw ? sha(pw) : null, username: user, other_password: /^password=/m.test(other.stdout ?? ""), other_status: other.status },
    env_names: Object.keys(process.env).sort(), env_values_sha256: Object.values(process.env).map((v) => sha(v).slice(0, 16)), argv_sha256: process.argv.map((v) => sha(v).slice(0, 16)), ...credNames() });
  process.exit(0);
}

if (cmd === "readrepo") {
  const dir = rest[0];
  const st = lstatSync(dir);
  let write = "ok";
  try { writeFileSync(`${dir}/WRITTEN`, "x"); } catch (e) { write = e.code; }
  let other = null;
  if (rest[1]) { try { readdirSync(rest[1]); other = "readable"; } catch (e) { other = e.code; } }
  say({ readrepo: { link: st.isSymbolicLink(), files: readdirSync(dir).sort(), readme: readFileSync(`${dir}/README.md`, "utf8").trim(), write, other } });
  process.exit(0);
}

if (cmd === "tool") {
  const r = spawnSync(rest[0], rest.slice(1), { encoding: "utf8" });
  say({ tool: { program: rest[0], status: r.status, out: (r.stdout ?? "").trim(), error: r.error?.code ?? null } });
  process.exit(r.status === 0 ? 0 : 4);
}
console.error(`unknown command ${cmd}`);
process.exit(2);
