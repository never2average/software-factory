// The GitHub App's run program (mold_v0-014; scripts/github-app-test.ts). RUN_TARGETS.mode:
//   report  the sha256 of the GITHUB_TOKEN it got (never the token), and everything it can see that a key could be in:
//           every environment variable and every file of its credential directory (the test greps these for the
//           platform's private key and secrets, which must not be there)
//   leak    prints its token every way: what is stored must be redacted
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const t = JSON.parse(process.env.RUN_TARGETS || "{}");
const token = process.env.GITHUB_TOKEN ?? null;
const out = (o) => console.log(JSON.stringify(o));
const dir = process.env.RUN_CREDENTIALS_DIR ?? null;
const files = dir && existsSync(dir) ? Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), "utf8")])) : {};
if (t.mode === "leak") {
  console.log(`plain GITHUB_TOKEN=${token}`);
  console.error(`stderr ${token}`);
  console.log(`base64 ${Buffer.from(String(token)).toString("base64")} url https://x-access-token:${token}@github.com/acme/api.git`);
  writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
} else {
  // The whole environment and credential directory, as seen by the program (redacted of its own token when stored).
  out({ event: "gh", sha: token === null ? null : sha(token), env: process.env, files });
  writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
}
