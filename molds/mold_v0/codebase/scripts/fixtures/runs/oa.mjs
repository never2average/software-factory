// The OAuth connections' run program (mold_v0-014; scripts/oauth-providers-test.ts). RUN_TARGETS.mode:
//   report  the sha256 of what it got for each field (the api_token file, APP_TOKEN), never a value, and everything it can
//           see that a secret could be in (its environment and credential files): the test greps it for the platform's
//   leak    prints its tokens: what is stored must be redacted
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const t = JSON.parse(process.env.RUN_TARGETS || "{}");
const dir = process.env.RUN_CREDENTIALS_DIR ?? null;
const files = dir && existsSync(dir) ? Object.fromEntries(readdirSync(dir).filter((f) => !f.startsWith(".")).map((f) => [f, readFileSync(path.join(dir, f), "utf8")])) : {};
const api = files.api_token ?? null, app = process.env.APP_TOKEN ?? null;
if (t.mode === "leak") { console.log(`api ${api} app ${app}`); console.error(`stderr ${api}`); }
else console.log(JSON.stringify({ event: "oa", sha: { api_token: api === null ? null : sha(api), app_token: app === null ? null : sha(app) }, env: process.env, files }));
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
