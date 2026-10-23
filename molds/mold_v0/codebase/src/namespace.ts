/**
 * The keys this build writes into Stripe and Clerk (mold_v0-045): its namespace (src/profile.ts profileNamespace, the
 * MCP server name: "workspace" for the neutral default) and an underscore, then the key's own name. A Stripe price is
 * one of this build's plans when its lookup key starts with KEY_PREFIX; its metadata, a checkout's and a customer's,
 * and a Clerk organization's and membership's public metadata use NS_KEYS. Before mold_v0-045 these were spelled with
 * the product's own name whatever the build's profile, which is the namespace of the builds that carry its host pack, so
 * their keys are unchanged. Any other build deployed before then may have written keys under that old namespace, so
 * reads accept it as a fallback (LEGACY_KEY_PREFIX, nsGet, isPlanKey); writes use the build's own.
 */
import { LEGACY_ENV_PREFIX } from "./env-names.js";
import { profileNamespace } from "./profile.js";

export const NS = profileNamespace();
/** The prefix of this build's Stripe lookup keys (and of every metadata key it writes). */
export const KEY_PREFIX = `${NS}_`;
const key = <K extends string>(k: K) => `${KEY_PREFIX}${k}` as const;
export const NS_KEYS = {
  slug: key("slug"), role: key("role"), experiment: key("experiment"), variant: key("variant"), weight: key("weight"),
  trial_days: key("trial_days"), metric: key("metric"), plan: key("plan"), kind: key("kind"), run_id: key("run_id"),
} as const;

/** The namespace every build wrote under before mold_v0-045 (the env names' old prefix in lower case). */
export const LEGACY_NS = LEGACY_ENV_PREFIX.replace(/_+$/, "").toLowerCase();
export const LEGACY_KEY_PREFIX = `${LEGACY_NS}_`;
type NsKey = keyof typeof NS_KEYS;
/** A metadata value under the build's key, else under the key it had before mold_v0-045. */
export const nsGet = (meta: Record<string, unknown> | null | undefined, k: NsKey): any =>
  meta?.[NS_KEYS[k]] ?? meta?.[`${LEGACY_KEY_PREFIX}${k}`];
/** A Stripe lookup key of this build's plans: its own prefix, or the one plans were made with before mold_v0-045. */
export const isPlanKey = (lookupKey: string | null | undefined): boolean =>
  !!lookupKey && (lookupKey.startsWith(KEY_PREFIX) || lookupKey.startsWith(LEGACY_KEY_PREFIX));
/** A metadata key this build (or a build before mold_v0-045) reserves. */
export const isNsKey = (k: string): boolean => k.startsWith(NS) || k.startsWith(LEGACY_NS);
