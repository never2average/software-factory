// Lane precondition probe: are the two things this harness needs actually here?
//   node molds/mold_fin/testing/accessibility/deps-check.mjs
// Exit 0 prints what it found; exit 1 names the one command that fixes it. The runner turns a
// non-zero exit into a `skipped` lane, which is the honest verdict for a harness that cannot start.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const AXE = join(dirname(fileURLToPath(import.meta.url)), "vendor/axe.min.js");
let ok = true;
try {
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const exe = pw.chromium.executablePath();
  if (!existsSync(exe)) throw new Error(`chromium is not downloaded at ${exe}`);
  console.log(`playwright ok, chromium at ${exe}`);
} catch (e) {
  ok = false;
  console.error(`${e.message}\nInstall it on the VM: npm i -g playwright && npx playwright install chromium`);
}
if (existsSync(AXE)) console.log(`axe-core vendored: ${(readFileSync(AXE, "utf8").match(/axe v([\d.]+)/) || [])[1]}`);
else { ok = false; console.error(`missing ${AXE}\nRestore it: npm --prefix molds/mold_fin/testing/accessibility run vendor`); }
process.exit(ok ? 0 : 1);
