// The credential vault's run program (mold_v0-034; scripts/credentials-test.ts). RUN_TARGETS.mode:
//   report   reports, for each credential the fixture declares, whether it arrived and the sha256 of what arrived (never
//            the value), and where the file was (mode, owner, directory)
//   leak     prints every value it got every way it can (stdout, a JSON event, base64, stderr) and puts them in its
//            results: all of it must reach the database redacted
//   leak_ws  writes a value into its workspace: the workspace must not be written back
//   leak_bad writes a results.json that is not JSON and holds a value: the run's error must not quote it
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const t = JSON.parse(process.env.RUN_TARGETS || "{}");
const dir = process.env.RUN_CREDENTIALS_DIR ?? null;
const file = dir ? path.join(dir, "app_key.pem") : null;
let fileValue = null, fileInfo = null;
if (file) { try { fileValue = readFileSync(file, "utf8"); const st = statSync(file); fileInfo = { mode: (st.mode & 0o777).toString(8), uid: st.uid, dir_mode: (statSync(dir).mode & 0o777).toString(8) }; } catch (e) { fileInfo = { error: e.code }; } }
const got = { api_token: process.env.FIXTURE_API_TOKEN ?? null, app_key: fileValue, db_password: process.env.FIXTURE_DB_PASSWORD ?? null };
const out = (o) => console.log(JSON.stringify(o));
if (t.mode === "report" || !t.mode) {
  out({ event: "creds", dir, uid: process.getuid(), file: fileInfo,
    sha: Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v === null ? null : sha(v)])) });
  writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
} else if (t.mode === "leak") {
  for (const [k, v] of Object.entries(got)) {
    if (v === null) continue;
    console.log(`plain ${k}=${v}`);
    out({ event: "leak", name: k, value: v, nested: { list: [v], [v]: "as a key" } });
    console.log(`base64 ${Buffer.from(v).toString("base64")} hex ${Buffer.from(v).toString("hex")}`);
    console.error(`stderr ${k}=${v}`);
  }
  const v = got.api_token ?? "none";
  writeFileSync(path.join(process.env.RUN_OUT, "results.json"), JSON.stringify([
    { check: { area: "cred_checks", key: "k1" }, status: "fail", evidence_ref: `token ${v}`, detail: { token: v, again: [v] } }]));
} else if (t.mode === "leak_ws") {
  writeFileSync(path.join(process.env.RUN_WORKSPACE, "config.txt"), `token=${got.api_token}\n`);
} else if (t.mode === "leak_bad") {
  writeFileSync(path.join(process.env.RUN_OUT, "results.json"), `[{"check": ${got.api_token}`);
}
