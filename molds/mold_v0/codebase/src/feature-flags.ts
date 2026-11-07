/**
 * The features registry's flags (mold_v0-219; src/features.ts has what asks for each and whether it is on): each flag
 * as the app's profile sets it. Kept apart from src/features.ts so src/profile.ts and the other early modules may read a
 * flag without loading the packs.
 */
import REGISTRY from "./features.json" with { type: "json" };
import { PROFILE } from "./profile.js";

export type FeatureId =
  | "customer_key_vault" | "company_email" | "scheduled_alerts" | "record_clocks" | "audit.data" | "audit.platform"
  | "audit.sign" | "onprem_runners" | "developer_surface" | "declarative_checks" | "encrypted_fields" | "health_history" | "document_preview"
  | "agent_harness" | "record_pages" | "side_panel_forms" | "teams"
  | "record_run_inputs" | "private_catalogs" | "wide_lists" | "record_rules" | "credential_sets" | "overview_cards" | "run_analytics" | "filters_in_address" | "usage_tool"
  | "workspace_recipes";

export interface FeatureSpec {
  id: FeatureId;
  short: string;
  label: string;
  default: boolean;
  legacy?: string;
  requested_by: "credentials" | "email" | "alerts" | "clocks" | "always" | "private_network" | "developer_surface" | "checks" | "encrypted" | "no_engine" | "documents" | "layouts"
    | "record_inputs" | "private_catalogs" | "wide_lists" | "record_rules" | "credential_sets" | "home_cards";
  requested_words: string;
  requires?: FeatureId[];
  requires_any?: FeatureId[];
  /** mold_v0-243: while off, left out of the build's generated files (an app that never turns it on builds as before it existed). */
  quiet_off?: boolean;
  since: string;
  about: string;
  off: string;
}

export const FEATURES: readonly FeatureSpec[] = Object.freeze((REGISTRY as { flags: FeatureSpec[] }).flags);
export const FEATURE_IDS: readonly FeatureId[] = FEATURES.map((f) => f.id);
const byId = new Map(FEATURES.map((f) => [f.id, f]));
export const featureSpec = (id: FeatureId): FeatureSpec => {
  const f = byId.get(id);
  if (!f) throw new Error(`no feature flag ${id} (src/features.json)`);
  return f;
};

/** What the profile says of the flags: `features` and the legacy keys, as written (null: not said). */
export type FeatureSettings = Partial<Record<FeatureId, boolean>>;
let testSettings: FeatureSettings = {};
/** Tests only: set flags as the profile's `features` would (null: the profile's own for every flag). */
export function setFeaturesForTest(s: FeatureSettings | null) { testSettings = { ...(s ?? {}) }; }
/** Tests only: one flag (null: the profile's own), the others left as they are. */
export function setFeatureForTest(id: FeatureId, on: boolean | null) {
  featureSpec(id);
  const next = { ...testSettings };
  if (on === null) delete next[id]; else next[id] = on;
  testSettings = next;
}

const legacyValue = (p: Record<string, unknown>, path: string): boolean | undefined => {
  let v: unknown = p;
  for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === "boolean" ? v : undefined;
};

/**
 * The flag as the profile sets it: `features[id]`, else its legacy key, else the registry's default. A test's setting
 * wins over this build's profile; a `profile` given is read instead of this build's (and no test setting applies).
 */
export function featureSetting(id: FeatureId, profile?: Record<string, unknown>): boolean {
  const spec = featureSpec(id);
  if (!profile && typeof testSettings[id] === "boolean") return testSettings[id]!;
  const p = profile ?? (PROFILE as unknown as Record<string, unknown>);
  const f = p.features && typeof p.features === "object" ? (p.features as Record<string, unknown>)[id] : undefined;
  if (typeof f === "boolean") return f;
  return (spec.legacy ? legacyValue(p, spec.legacy) : undefined) ?? spec.default;
}
