/**
 * The profile (mold_v0-038): the names a build of the shell shows, so none is written into the code. It is
 * profile.json at the codebase root over a neutral default, merged by scripts/gen-packs.mjs into
 * src/profile.generated.ts (and web/src/config/profile.generated.ts for the console). Used for:
 *
 *   mcp_server_name    the customer MCP server's name (src/server.ts) and, with "-admin", the admin one (src/admin-mcp.ts)
 *   email_sender_name  the display name of the default sender (src/settings.ts EMAIL_FROM) and the emails' signature
 *   email_from_address the default sender's address
 *   console_title      the console's title (web/src/app/layout.tsx and the /app and /admin layouts, the manifest)
 *   name, console_description, short_description   the product's name and the console's descriptions
 *   limits             optional (mold_v0-018): the build's own rate limits and run ceilings, and per-plan ones
 *                      (src/rate-limits.ts); absent, the shell's defaults
 *   mcp_server_version optional (mold_v0-060): the customer MCP server's version (absent: the shell's)
 *   mcp_instructions   optional (mold_v0-060): the customer MCP server's instructions, in place of the shell's; the
 *                      paragraph for the tools generated from the packs is added after either
 *   install_clients    optional (mold_v0-010): the clients the install pages and a member's key setup offer, by id
 *                      (src/connect-catalog.ts); absent, every client
 *   billing            optional (mold_v0-019): price per run, off unless `enabled` is true (src/run-charges.ts); only
 *                      the app's own profile.json sets it, never a host pack's profile
 *
 * Until mold_v0-039 moves the product's surface into its pack, profile.json carries the product's own names, so a
 * build is exactly what it was; with no profile.json the shell shows only the neutral default.
 */
import { GENERATED_PROFILE } from "./profile.generated.js";
import type { ProfileLimits } from "./rate-limits.js";

export interface Profile {
  name: string;
  mcp_server_name: string;
  console_title: string;
  console_description: string;
  short_description: string;
  email_sender_name: string;
  email_from_address: string;
  limits?: ProfileLimits;
  mcp_server_version?: string;
  mcp_instructions?: string;
  install_clients?: readonly string[];
  billing?: ProfileBilling;
}

/**
 * Price per run (mold_v0-019; src/run-charges.ts, molds/mold_v0/MOLD.md "Price per run"): the app's billing rules. Off
 * unless `enabled` is true. The rest bounds what a pack's run prices can do: the currency every price must be in
 * (default usd), the ceilings on a run's fixed amount (major units, default 1000) and on its cost-plus percent (default
 * 100), whether a failed or a cancelled run may be charged at all (default no: they are free whatever the pack says),
 * and the Stripe meter event name charges go to when Stripe is configured (default run_charges).
 */
export interface ProfileBilling {
  enabled: boolean;
  currency?: string;
  max_fixed?: number;
  max_cost_plus_percent?: number;
  charge_failed_runs?: boolean;
  charge_cancelled_runs?: boolean;
  stripe_meter?: string;
}

export const PROFILE: Readonly<Profile> = Object.freeze({ ...(GENERATED_PROFILE as Profile) });

/** The default sender, as Name <address> (an admin can change it on the Emails settings). */
export const defaultSender = (p: Profile = PROFILE) => `${p.email_sender_name} <${p.email_from_address}>`;
