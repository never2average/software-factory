#!/usr/bin/env node
/**
 * `npx @delivery-agents/cli install-skill` — install the Delivered agent skills.
 *
 * Why this exists rather than `npx skills add <url>`: installing instructions
 * from a bare URL is mutable, unversioned and unauditable, and "pipe this URL
 * into your coding agent" is the shape security review rejects. A published npm
 * package is a real trust anchor — pinned by version, immutable once released,
 * and already the thing they run for `fde-login`.
 *
 * It does NOT reimplement agent detection. The `skills` CLI already resolves
 * Claude Code, Cursor, VS Code, Codex and a dozen more, and handles symlink vs
 * copy; this hands it a LOCAL PATH inside this package, so the bytes come from
 * the version you installed and nothing is fetched at install time.
 *
 * Falls back to printing the path when `skills` cannot be run, so the command
 * is never a dead end.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "skills");

if (!existsSync(skillsDir)) {
  console.error("✗ This build of @delivery-agents/cli ships no skills directory.");
  console.error("  Upgrade:  npm i -g @delivery-agents/cli@latest");
  process.exit(1);
}

const passthrough = process.argv.slice(2).filter((a) => a !== "install-skill");
const args = ["-y", "skills@latest", "add", skillsDir, ...passthrough];

console.log(`Installing Delivered skills from ${skillsDir}\n`);
const run = spawnSync("npx", args, { stdio: "inherit" });

if (run.error || run.status !== 0) {
  // Never leave them stuck: the path is the whole input the other CLI needs.
  console.error("\n✗ Could not run the skills installer automatically.");
  console.error("  Run this instead:\n");
  console.error(`    npx skills add ${skillsDir}\n`);
  console.error("  Add -g to install for every project rather than just this one.");
  process.exit(run.status ?? 1);
}
