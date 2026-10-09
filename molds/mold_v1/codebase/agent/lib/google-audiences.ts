/**
 * The Google OAuth clients whose ID tokens the coding-agent package mints, as a
 * deployment's SETTINGS. Both front doors (lib/ops-auth.ts and
 * agent/channels/eve.ts) admit exactly this list beside their web client, and
 * scripts/check-gates.mjs fails if either stops reading it from here.
 *
 * No client id is written in code. The code is public; which Google project a
 * deployment signs its people in through is that deployment's business, the
 * same as its address (lib/web-origin.ts). Two settings:
 *
 *   - `WORKSPACE_OAUTH_CLIENT_ID` — the installed-app (desktop) client this
 *     deployment's agent package is built with. The package build reads the
 *     same name (scripts/build-agent-cli.mjs), so one value set once serves the
 *     package and the server that verifies its tokens.
 *   - `WORKSPACE_CLI_CLIENT_ID` — further CLI clients still admitted, comma
 *     separated: the previous client while people move off it, a client a team
 *     minted for itself.
 *
 * Unset, no CLI token is admitted: Google sign-in from the package is off and
 * the emailed-code sign-in still works. That is the failure to want — closed,
 * and named by the setting — rather than every deployment trusting one
 * project's client because it was written here.
 *
 * Edge-safe (lib/ops-auth.ts runs in middleware): no Node built-ins.
 */
/** A comma- or whitespace-separated list, trimmed, empties and repeats dropped. */
export function splitClientIds(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** The CLI audiences this deployment admits, read at call time (a test sets the env after import). */
export function cliClientIds(): string[] {
  return [...new Set([...splitClientIds(process.env.WORKSPACE_OAUTH_CLIENT_ID), ...splitClientIds(process.env.WORKSPACE_CLI_CLIENT_ID)])];
}
