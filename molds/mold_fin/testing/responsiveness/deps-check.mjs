// Lane precondition probe: is the browser this harness drives actually here?
//   node molds/mold_fin/testing/responsiveness/deps-check.mjs
// Exit 0 prints what it found; exit 1 names the one command that fixes it. The runner turns a non-zero
// exit into a `skipped` lane, which is the honest verdict for a harness that cannot start — a browser
// that will not launch is not evidence that the layout is fine.
// Node ESM ignores NODE_PATH, so the VM-wide playwright is reached with createRequire, never `import`.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
try {
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const exe = pw.chromium.executablePath();
  if (!existsSync(exe)) throw new Error(`chromium is not downloaded at ${exe}`);
  console.log(`playwright ok, chromium at ${exe}`);
  console.log("no other dependency: this lane installs nothing, into the mold codebase or anywhere else");
  process.exit(0);
} catch (e) {
  console.error(`${e.message}\nInstall it on the VM: npm i -g playwright && npx playwright install chromium`);
  process.exit(1);
}
