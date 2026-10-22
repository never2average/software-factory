// Lane precondition: is the browser this harness drives on this machine (and, with --axe, the vendored rule set)?
//   node molds/mold_v0/testing/console/deps-check.mjs [--axe]
// Exit 0 prints what it found; exit 1 names the command that fixes it, which the runner turns into a `skipped` lane.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from './browser.mjs';

let ok = true;
try {
  const exe = playwright().chromium.executablePath();
  if (!existsSync(exe)) throw new Error(`chromium is not downloaded at ${exe}`);
  console.log(`playwright ok, chromium at ${exe}`);
} catch (e) {
  ok = false;
  console.error(`${e.message}\nInstall it on this machine: npm i -g playwright && npx playwright install chromium`);
}
if (process.argv.includes('--axe')) {
  const axe = join(dirname(fileURLToPath(import.meta.url)), '..', 'accessibility', 'vendor', 'axe.min.js');
  if (existsSync(axe)) console.log(`axe-core vendored: ${(readFileSync(axe, 'utf8').match(/axe v([\d.]+)/) || [])[1]}`);
  else { ok = false; console.error(`missing ${axe}\nRestore it from git: git checkout molds/mold_v0/testing/accessibility/vendor/axe.min.js`); }
}
process.exit(ok ? 0 : 1);
