#!/usr/bin/env node
/**
 * `npx <this package> install-skills` — install this product's agent skills.
 *
 * Why this exists rather than `npx skills add <url>`: installing instructions
 * from a bare URL is mutable, unversioned and unauditable, and "pipe this URL
 * into your coding agent" is the shape security review rejects. A published npm
 * package is a real trust anchor — pinned by version, immutable once released,
 * and already the thing they run for the login command.
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
import { DEPLOYMENT } from "./deployment.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "skills");

const PKG = DEPLOYMENT.packageName;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error(
    [
      `${DEPLOYMENT.commands.installSkills} - install the ${DEPLOYMENT.name} agent skills into your coding agent.`,
      ...(DEPLOYMENT.origin ? [`These skills are for ${DEPLOYMENT.name} at ${DEPLOYMENT.origin}.`] : []),
      "",
      `  npx ${PKG} ${DEPLOYMENT.commands.installSkills}        this project`,
      `  npx ${PKG} ${DEPLOYMENT.commands.installSkills} -g     every project`,
      "",
      "The skills are read from this installed package; nothing is fetched. Other flags pass through to `skills add`.",
    ].join("\n"),
  );
  process.exit(0);
}

if (!existsSync(skillsDir)) {
  console.error(`✗ This build of ${PKG} ships no skills directory.`);
  console.error(`  Upgrade:  npm i -g ${PKG}@latest`);
  process.exit(1);
}

const passthrough = process.argv.slice(2).filter((a) => a !== "install-skill" && a !== "install-skills");
const args = ["-y", "skills@latest", "add", skillsDir, ...passthrough];

console.log(`Installing ${DEPLOYMENT.name} skills from ${skillsDir}\n`);
const run = spawnSync("npx", args, { stdio: "inherit" });

if (run.error || run.status !== 0) {
  // Never leave them stuck: the path is the whole input the other CLI needs.
  console.error("\n✗ Could not run the skills installer automatically.");
  console.error("  Run this instead:\n");
  console.error(`    npx skills add ${skillsDir}\n`);
  console.error("  Add -g to install for every project rather than just this one.");
  process.exit(run.status ?? 1);
}
