// The fixture agent repository's validation (mold_v0-061): every data/<company>/notes.json is JSON with a list of notes.
import { existsSync, readdirSync, readFileSync } from "node:fs";

if (process.env.FIXTURE_AGENT_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.RUN_CREDENTIALS_DIR) { console.log("validation got a secret"); process.exit(9); }
for (const c of existsSync("data") ? readdirSync("data") : []) {
  const f = `data/${c}/notes.json`;
  if (!existsSync(f)) continue;
  try { if (!Array.isArray(JSON.parse(readFileSync(f, "utf8")).notes)) process.exit(1); } catch { console.log(`${f} is not JSON`); process.exit(1); }
}
console.log("valid");
