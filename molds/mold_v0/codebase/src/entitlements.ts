/**
 * Plan entitlements (mold_v0-083; mold_v0-019's "plans in the profile carry limits and entitlements"): what each plan a
 * workspace can be on unlocks, declared in the app's own profile.json `entitlements` (src/profile.ts
 * ProfileEntitlements; scripts/gen-packs.mjs checks it, and refuses it in a host pack's profile):
 *
 *   "entitlements": {
 *     "plans": {
 *       "starter": { "features": ["runs"] },
 *       "team":    { "features": ["runs", "schedules"], "run_charges": "included" }
 *     },
 *     "without_plan": "starter"
 *   }
 *
 * A workspace's plan: its live subscription's plan (src/billing.ts orgBudget: active or trialing) when `plans` declares
 * it, else `without_plan` (no subscription, a lapsed one, one whose plan is not declared here, or one that cannot be
 * read). Never a value a request or a pack sends. Enforced where the plan's other rules are read:
 *
 *   features     runs        a run starts only on a plan that lists it (src/run-limits.ts checkRunStart, with 018's limits)
 *                schedules   a schedule is made or turned on, and a due schedule fires, only on a plan that lists it
 *                            (src/schedules.ts)
 *   limits       the plan's limits are the profile's `limits.plans.<plan>` (src/rate-limits.ts limitsFor, planOf: 018)
 *   run_charges  "included": the plan's runs are frozen with no price, so they are never charged (src/runs.ts startRun,
 *                src/run-charges.ts priceForStart: 019's billing); "charged" (the default): as billing says
 *
 * With no `entitlements` in the profile nothing here gates anything: every workspace has every feature (as before).
 */
import { PackError } from "./pack-api.js";
import { PROFILE, type ProfileEntitlements } from "./profile.js";

/** The features the shell gates by plan, and what each means (the words a refusal and the docs use). */
export const FEATURES = {
  runs: "start runs",
  schedules: "run on a schedule",
} as const;
export type Feature = keyof typeof FEATURES;

let testEntitlements: ProfileEntitlements | null | undefined;
/** Tests only: entitlements in place of the profile's (undefined: the profile's again). Forgets cached plans. */
export async function setEntitlementsForTest(e: ProfileEntitlements | null | undefined) {
  testEntitlements = e;
  (await import("./rate-limits.js")).forgetPlans();
}
/** The profile's entitlements, or null when it declares none (nothing gated). */
export const entitlementsProfile = (): ProfileEntitlements | null =>
  (testEntitlements !== undefined ? testEntitlements : (PROFILE as { entitlements?: ProfileEntitlements }).entitlements) ?? null;

/** The plan a workspace is on, given its live subscription's plan name (null: none): declared, else without_plan. */
export function resolvePlan(subscriptionPlan: string | null, e: ProfileEntitlements | null = entitlementsProfile()): string | null {
  if (!e) return subscriptionPlan;
  return subscriptionPlan && Object.hasOwn(e.plans, subscriptionPlan) ? subscriptionPlan : e.without_plan;
}

export interface Entitlements { plan: string | null; gated: boolean; features: Set<Feature>; run_charges: "charged" | "included" }
/** What `plan` unlocks. Nothing declared: every feature, runs charged. A plan not declared: nothing. */
export function entitlementsFor(plan: string | null, e: ProfileEntitlements | null = entitlementsProfile()): Entitlements {
  if (!e) return { plan, gated: false, features: new Set(Object.keys(FEATURES) as Feature[]), run_charges: "charged" };
  const p = plan && Object.hasOwn(e.plans, plan) ? e.plans[plan]! : null;
  return { plan, gated: true, features: new Set((p?.features ?? []).filter((f): f is Feature => Object.hasOwn(FEATURES, f))),
           run_charges: p?.run_charges === "included" ? "included" : "charged" };
}

/** A workspace's entitlements now (its plan read at most once a minute: src/rate-limits.ts planOf). */
export async function workspaceEntitlements(orgId: number): Promise<Entitlements> {
  const e = entitlementsProfile();
  if (!e) return entitlementsFor(null, null);
  const { planOf } = await import("./rate-limits.js");
  return entitlementsFor(await planOf(orgId), e);
}

/** Why `feature` is refused for these entitlements, in words, or null when the plan includes it. */
export const featureRefusal = (ent: Entitlements, feature: Feature): string | null =>
  ent.features.has(feature) ? null : `this workspace's plan (${ent.plan ?? "none"}) does not include ${FEATURES[feature]}: ask an owner to change the plan`;

/** Throws a PackError (403) when the workspace's plan does not include `feature`. Returns its entitlements otherwise. */
export async function requireFeature(orgId: number, feature: Feature): Promise<Entitlements> {
  const ent = await workspaceEntitlements(orgId);
  const why = featureRefusal(ent, feature);
  if (why) throw new PackError(why, 403);
  return ent;
}
