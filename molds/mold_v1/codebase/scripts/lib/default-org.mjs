/**
 * Org #1's identity — its workspace id and its email domain — read from lib/org-context.ts, the one place it is
 * written. Scripts, checks and the operator tooling take it from here instead of spelling it, so a deployment that
 * changes it changes it in one file.
 */
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../../lib/org-context.ts", import.meta.url), "utf8");

function constant(name) {
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(SOURCE);
  if (!m) throw new Error(`scripts/lib/default-org.mjs: no \`export const ${name} = "…"\` in lib/org-context.ts`);
  return m[1];
}

/** Org #1's workspace id (DEFAULT_ORG). */
export const DEFAULT_ORG = constant("DEFAULT_ORG");
/** Org #1's Google Workspace hosted domain (DEFAULT_DOMAIN). */
export const DEFAULT_DOMAIN = constant("DEFAULT_DOMAIN");
/** DEFAULT_ORG without its `org-` prefix: the company's slug. */
export const DEFAULT_ORG_SLUG = DEFAULT_ORG.replace(/^org-/, "");
/** A string as a literal inside a RegExp. */
export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
