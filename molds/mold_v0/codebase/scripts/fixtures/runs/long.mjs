// A run longer than its tokens (mold_v0-014; scripts/oauth-providers-test.ts): every `every_ms` for `ticks` times it reads
// its credential files as a program does each time it needs them (the OAuth connection's api_token, the GitHub App's
// gh_token) and uses each against the stand-ins (RUN_TARGETS.oa_url, gh_url), recording what they answered and the
// sha256 of what it read (never a value). The test moves the credential clock forward hours meanwhile.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const t = JSON.parse(process.env.RUN_TARGETS || "{}");
const dir = process.env.RUN_CREDENTIALS_DIR;
const read = (f) => { try { return readFileSync(path.join(dir, f), "utf8"); } catch { return null; } };
const reads = [];
for (let i = 0; i < (t.ticks ?? 10); i++) {
  const oa = read("api_token"), gh = read("gh_token");
  const oaStatus = oa ? (await fetch(`${t.oa_url}/api/me`, { headers: { authorization: `Bearer ${oa}` } })).status : 0;
  const ghStatus = gh ? (await fetch(`${t.gh_url}/repos/acme/api/contents`, { headers: { authorization: `token ${gh}` } })).status : 0;
  reads.push({ oa: oaStatus, gh: ghStatus, oa_sha: oa ? sha(oa) : null, gh_sha: gh ? sha(gh) : null });
  await new Promise((r) => setTimeout(r, t.every_ms ?? 100));
}
console.log(JSON.stringify({ event: "long", reads }));
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
