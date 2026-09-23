/**
 * Environment variables the DEPLOYED app and agent read — and the additive
 * rename that moved them off the base product's role name.
 *
 * Two of them, and only two: everything else prefixed `FDE_` is read by the
 * published npm package (see `LEGACY_ENV_NAMES` in setup/fde-tools.mjs, a
 * disjoint set) or by the factory operator's own tooling under `scripts/fde/`.
 * These two are different because deployed server code reads them, so a plain
 * rename is a configuration change somebody has to make on a running project
 * before the next deploy, not a text edit:
 *
 *   - `WORKSPACE_CLI_CLIENT_ID` decides which Google OAuth audience is admitted
 *     at BOTH front doors (lib/ops-auth.ts and agent/channels/eve.ts, which
 *     check:gates keeps in lockstep). Set and then not read, every CLI-minted
 *     token 401s — which is precisely the outage check-gates.mjs was written
 *     for. It exists so the CLI client can be rotated without a code change.
 *   - `WORKSPACE_PEOPLE_SEED` is a test-only fixture path read by
 *     agent/lib/workbook-spec.ts. Never set in production.
 *
 * So both are read the same way: prefer the new name, fall back to the old, and
 * say once, loudly, that the old one is what answered. Nothing breaks on the
 * deploy that renames them, and the warning is how an operator finds out there
 * is something to change — a silent fallback is how a compatibility shim
 * becomes permanent.
 *
 * It lives under agent/lib because the agent is built and deployed on its own
 * (`eve build`) and cannot reach the web app's lib/; the web app imports across
 * the other way already (lib/mcp-server.ts). Edge-safe: no imports, no Node
 * built-ins — lib/ops-auth.ts runs in middleware.
 */

/** new name -> the name that held the same value before the rename. */
export const LEGACY_APP_ENV_NAMES: Readonly<Record<string, string>> = {
  WORKSPACE_CLI_CLIENT_ID: "FDE_CLI_CLIENT_ID",
  WORKSPACE_PEOPLE_SEED: "FDE_PEOPLE_SEED",
};

/** One warning per name per process. A per-read warning would drown a log. */
const warned = new Set<string>();

/**
 * The value of `name`, falling back to whatever the variable used to be called.
 * Returns undefined when neither is set, exactly as `process.env.X` would.
 */
export function compatEnv(name: keyof typeof LEGACY_APP_ENV_NAMES | string): string | undefined {
  const current = process.env[name];
  if (current !== undefined && current !== "") return current;
  const legacy = LEGACY_APP_ENV_NAMES[name];
  if (!legacy) return current;
  const old = process.env[legacy];
  if (old === undefined || old === "") return current;
  if (!warned.has(legacy)) {
    warned.add(legacy);
    console.warn(
      `[config] ${legacy} is the old name for ${name} and still works, but it will be removed. ` +
        `Set ${name} to the same value on this deployment and drop ${legacy}.`,
    );
  }
  return old;
}
