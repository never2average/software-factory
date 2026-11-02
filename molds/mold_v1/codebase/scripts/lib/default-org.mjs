/**
 * Org #1's identity — its workspace id and its email domain — by the rule lib/default-org.ts applies: DEFAULT_ORG_ID
 * and DEFAULT_ORG_DOMAIN from the environment, else the built-in placeholders written in that file (read from it here,
 * never spelled twice). Scripts, checks and the operator tooling take it from here, so a deployment that names its own
 * org #1 changes nothing in the code.
 */
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../../lib/default-org.ts", import.meta.url), "utf8");

function constant(name) {
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(SOURCE);
  if (!m) throw new Error(`scripts/lib/default-org.mjs: no \`export const ${name} = "…"\` in lib/default-org.ts`);
  return m[1];
}

/** The built-in placeholders, used when the deployment names no org #1 of its own. */
export const BUILT_IN_ORG = constant("BUILT_IN_ORG");
export const BUILT_IN_DOMAIN = constant("BUILT_IN_DOMAIN");
/** Org #1's workspace id (DEFAULT_ORG): DEFAULT_ORG_ID, else BUILT_IN_ORG. */
export const DEFAULT_ORG = process.env.DEFAULT_ORG_ID?.trim() || BUILT_IN_ORG;
/** Org #1's Google Workspace hosted domain (DEFAULT_DOMAIN): DEFAULT_ORG_DOMAIN, else BUILT_IN_DOMAIN, lower case. */
export const DEFAULT_DOMAIN = (process.env.DEFAULT_ORG_DOMAIN?.trim() || BUILT_IN_DOMAIN).toLowerCase();
/** DEFAULT_ORG without its `org-` prefix: the company's slug. */
export const DEFAULT_ORG_SLUG = DEFAULT_ORG.replace(/^org-/, "");
/** A string as a literal inside a RegExp. */
export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
