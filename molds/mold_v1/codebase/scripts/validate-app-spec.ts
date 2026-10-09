#!/usr/bin/env node --experimental-strip-types
/**
 * Validate an app dashboard spec against the contract.
 *
 *   node --experimental-strip-types scripts/validate-app-spec.ts <file.json>
 *   cat spec.json | node --experimental-strip-types scripts/validate-app-spec.ts
 *
 * Exits non-zero if the content isn't a valid spec or any block was dropped.
 * The same `cleanDashboardSpec` runs on every refresh, so this is just the
 * standalone way to check a spec by hand or in CI.
 */
import { readFileSync } from "node:fs";
import { cleanDashboardSpec } from "../lib/dashboard-spec.ts";

const arg = process.argv[2];
const raw = arg ? readFileSync(arg, "utf8") : readFileSync(0, "utf8");

const r = cleanDashboardSpec(raw);
if (r.content === null) {
  console.error("✗ not a dashboard spec (or invalid JSON)");
  process.exit(1);
}
console.log(`kept ${r.kept} block(s), dropped ${r.dropped}`);
for (const e of r.errors) console.log(`  ✗ ${e}`);
if (r.dropped > 0) process.exit(2);
console.log("✓ valid");
