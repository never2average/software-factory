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
 *   source_offer       optional (mold_v0-050): where this build's own source is offered, {app: {url, license}}, or
 *                      {app: "licensor_exception"} when the shell's licensor (or an affiliate) runs it under the additional
 *                      permission that does not require the offer, which the build then says (src/source-offer.ts);
 *                      absent, the build says nothing about its own source (its packs' copyleft upstreams are offered
 *                      either way). `upstreams` (mold_v0-099): {"<pack id>": "licensor_owned"} for a pack whose pinned
 *                      upstream is the app licensor's own project: as its copyright holder it need not offer that
 *                      source, so the build does not (no footer line, no /install.json sentence, no MCP instructions
 *                      line, no DATA-MAP.md row; its "Source code" section goes when nothing else is in it). Only the app's own
 *                      profile.json sets `upstreams`, never a host pack's profile; gen-packs refuses a pack id the build
 *                      does not have or whose pack pins no upstream
 *   member_keys        optional (mold_v0-099): false turns per-member API keys off (src/member-keys.ts): the console's
 *                      API keys page and its sidebar link go, the install pages and the setup offer sign-in (OAuth) only,
 *                      POST /api/keys and the rest of /api/keys are refused (403, "member_keys_off"), and a member key
 *                      made before is refused on /mcp with a sentence saying so (src/auth.ts resolveKey). Absent or
 *                      true: as before. The account keys staff issue on /admin are not member keys and keep working
 *   billing            optional (mold_v0-019): price per run, off unless `enabled` is true (src/run-charges.ts); only
 *                      the app's own profile.json sets it, never a host pack's profile
 *   email              optional (mold_v0-083): the email adapter's transport and which notifications are on
 *                      (src/email.ts); absent, Resend and sign-in codes and invitations only
 *   entitlements       optional (mold_v0-083): what each plan unlocks (src/entitlements.ts); absent, every workspace has
 *                      every feature. Only the app's own profile.json sets it, never a host pack's profile
 *   landing            optional (mold_v0-091, src/landing.ts): the app's landing page at /, over a pack's pack.json
 *                      `landing`; never part of this profile: gen-packs writes it to web/src/config/landing.generated.ts
 *   words              optional (mold_v0-100, src/words.ts, src/vocabulary.ts): the app's own words for the shell's
 *                      placeholders, {"run": "audit", "runs": "audits", "member": "analyst"}: keys workspace, account,
 *                      member, owner, run, tool_call, key and each with an s for its plural. Over a pack's pack.json
 *                      `words`, over the neutral BASE; a host pack's host.profile.words come under the app's (and
 *                      name its own engine's work only, not the generic runs of the usage pages). Never
 *                      part of the profile modules: gen-packs writes them to src/vocabulary.generated.ts (this layer)
 *                      and web/src/config/vocabulary.generated.ts (the build's words, resolved)
 *
 * Until mold_v0-039 moves the product's surface into its pack, profile.json carries the product's own names, so a
 * build is exactly what it was; with no profile.json the shell shows only the neutral default.
 */
import { GENERATED_PROFILE } from "./profile.generated.js";
import type { ProfileLimits } from "./rate-limits.js";
import type { SourceOfferSetting } from "./source-offer.js";

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
  source_offer?: SourceOfferSetting;
  member_keys?: boolean;
  billing?: ProfileBilling;
  email?: ProfileEmail;
  entitlements?: ProfileEntitlements;
}

/**
 * The email adapter (mold_v0-083, src/email.ts). `provider`: resend (default), test (kept in the process; never in
 * production) or none; APP_EMAIL_PROVIDER overrides it on a server. `notifications`: the groups that are on
 * besides sign-in codes and invitations (always on): access_requests, library, usage, due_dates, billing; absent, none.
 */
export interface ProfileEmail {
  provider?: "resend" | "test" | "none";
  notifications?: string[];
}

/**
 * Plan entitlements (mold_v0-083, src/entitlements.ts): what each plan unlocks. A workspace's plan is its live
 * subscription's (src/billing.ts orgBudget) when this declares it, else `without_plan`. Each plan lists its `features`
 * (the shell's: src/entitlements.ts FEATURES) and whether its runs are charged (`run_charges`, default charged; only
 * when billing is on). Its limits are the profile's `limits.plans.<name>` (src/rate-limits.ts), read for the same plan.
 * Absent, nothing is gated: every workspace has every feature and runs are charged as billing says.
 */
export interface ProfileEntitlements {
  plans: Record<string, { features: string[]; run_charges?: "charged" | "included" }>;
  without_plan: string;
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

/**
 * The build's namespace (mold_v0-045): its MCP server name in lower-case letters, digits and underscores ("workspace"
 * for the neutral default). The prefix of the keys this build writes into systems it shares with nothing else of its
 * own: Stripe lookup keys, price and customer metadata and meter event names (src/billing.ts, src/plan-config.ts,
 * src/experiments.ts), Clerk's organization and membership metadata (src/auth.ts, src/account-roles.ts), and the
 * default ClickHouse database. A build keeps the keys it wrote as long as its profile keeps its MCP server name.
 */
export const profileNamespace = (p: Profile = PROFILE): string =>
  p.mcp_server_name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";

/** The default sender, as Name <address> (an admin can change it on the Emails settings). */
export const defaultSender = (p: Profile = PROFILE) => `${p.email_sender_name} <${p.email_from_address}>`;

/** Whether people may make their own API keys (mold_v0-099, profile `member_keys`): on unless the profile says false. */
export function memberKeysOn(p?: Pick<Profile, "member_keys">): boolean {
  if (p) return p.member_keys !== false;
  return testMemberKeys ?? PROFILE.member_keys !== false;
}
let testMemberKeys: boolean | undefined;
/** Tests only: turn member keys on or off as the profile would (null: the profile's own setting). */
export function setMemberKeysForTest(on: boolean | null) { testMemberKeys = on ?? undefined; }
