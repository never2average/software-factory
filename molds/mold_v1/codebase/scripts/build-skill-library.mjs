/**
 * Mirror skills/<name>/SKILL.md into the published CLI package.
 *
 * The app briefly served these over HTTP from /.well-known/agent-skills/ so
 * `npx skills add <url>` would work. That was removed: installing agent
 * instructions from a mutable URL is the wrong trust model, and every endpoint
 * we do not need is an endpoint that can be attacked. Distribution goes through
 * the npm package instead, which is versioned and immutable.
 *
 * This still validates each skill against the skills CLI's own rules, so a bad
 * name or an over-long description fails the build rather than a customer's
 * install.
 *
 * Run:  npm run build:skill-library   (and after editing any SKILL.md)
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fillPlaceholders, hasPlaceholder } from "./lib/profile-words.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "skills");

const skills = readdirSync(src)
  .filter((d) => statSync(join(src, d)).isDirectory())
  .sort()
  .map((dir) => {
    const body = readFileSync(join(src, dir, "SKILL.md"), "utf8");
    // Frontmatter is the source of truth for name/description — the discovery
    // index must not describe the skill differently from the skill itself.
    const fm = /^---\n([\s\S]*?)\n---/.exec(body);
    if (!fm) throw new Error(`${dir}/SKILL.md: missing frontmatter`);
    const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim();
    const description = /^description:\s*([\s\S]*?)(?=\n[a-z-]+:|$)/m.exec(fm[1])?.[1]?.trim();
    if (!name || !description) throw new Error(`${dir}/SKILL.md: needs name and description`);
    if (!/^[a-z0-9-]{1,64}$/.test(name)) {
      throw new Error(`${dir}/SKILL.md: name "${name}" must match ^[a-z0-9-]{1,64}$ (the CLI rejects others)`);
    }
    if (description.length > 1024) {
      throw new Error(`${dir}/SKILL.md: description is ${description.length} chars, the CLI caps it at 1024`);
    }
    return {
      name,
      description,
      body,
      // The discovery index carries a digest the CLI VERIFIES against the bytes
      // it downloads. Computing it here, from the same string the route serves,
      // is what keeps the two from drifting.
      digest: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
    };
  });

/**
 * Mirror the skills into the published CLI package.
 *
 * skills/ at the repo root stays the single source of truth; setup/skills is a
 * generated copy so `npx @delivery-agents/cli install-skill` serves the bytes
 * from the version someone installed rather than fetching anything. Wiping and
 * re-copying (not merging) means a deleted skill actually disappears from the
 * package instead of lingering in the next publish.
 */
const pkgSkills = join(here, "..", "setup", "skills");
rmSync(pkgSkills, { recursive: true, force: true });
mkdirSync(pkgSkills, { recursive: true });
cpSync(src, pkgSkills, { recursive: true });
// A base skill never spells a role or a record word: it writes a placeholder ({account}, {member}, …). The generic
// package is the base product's, so its copy is filled from the base profile alone (profiles/00-default.json);
// a deployment's own package fills the same source from its own profiles (scripts/build-agent-cli.mjs).
const baseProfile = JSON.parse(readFileSync(join(here, "..", "profiles", "00-default.json"), "utf8"));
const fillTree = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) fillTree(p);
    else if (/\.(md|txt|json|ya?ml)$/i.test(entry.name)) {
      const text = readFileSync(p, "utf8");
      const filled = fillPlaceholders(text, baseProfile);
      if (filled !== text) writeFileSync(p, filled);
      if (hasPlaceholder(filled)) throw new Error(`${p}: a placeholder was left unfilled`);
    }
  }
};
fillTree(pkgSkills);
console.log(`✓ mirrored into ${pkgSkills}`);
for (const s of skills) console.log(`  ${s.name}  ${s.digest.slice(0, 20)}…  ${s.body.length} bytes`);
