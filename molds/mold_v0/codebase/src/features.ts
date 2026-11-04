/**
 * The features registry (mold_v0-219): one on/off flag for every optional capability of the shell, read by every gate
 * that decides whether the capability's pages, routes, sidebar entries, MCP tools and scheduler jobs exist.
 *
 * The flags and their documentation are src/features.json (also read by scripts/gen-packs.mjs for the console, by the
 * factory's .claude/scripts/lib/features.py for the app spec and the brief, and by the factory board). Each flag:
 *
 *   setting    the app's profile.json `features` ({"record_clocks": false, "audit.data": true}), else its legacy key
 *              (profile.audit.data, .platform, .sign; profile.onprem_runners), else the registry's default (true where the
 *              capability was on whenever a pack declared it before this registry, false for the opt-in toggles)
 *   requested  what asks for it: a pack's declaration (credentials, email, due dates or clocks, private-network kinds,
 *              developer_surface, checks, encrypted fields), a build without the session engine (health_history), or
 *              always (the audit toggles: the profile alone decides)
 *   on         requested AND the setting is not false
 *
 * The modules ask `featureOn(id)` (or `featureSetting(id)` where they hold the pack signal themselves, e.g. a cached
 * list of areas); nothing else decides. Tests turn a flag with setFeaturesForTest, as the profile would.
 */
import { packConfigs } from "./host.js";
import { sessionEngine } from "./host-tables.js";
import { packs } from "./packs.js";
import { FEATURES, featureSetting, featureSpec, type FeatureId } from "./feature-flags.js";

export { FEATURES, FEATURE_IDS, featureSetting, featureSpec, setFeaturesForTest, setFeatureForTest } from "./feature-flags.js";
export type { FeatureId, FeatureSettings, FeatureSpec } from "./feature-flags.js";

// ---------------------------------------------------------------- what asks for each

type Def = ReturnType<typeof packs>[number]["definition"];
const areasOf = (d: Def) => (d.recordAreas ?? []) as { scope?: string; due?: unknown; clocks?: unknown[]; fields?: { encrypted?: boolean; type?: string; preview?: string }[] }[];
const kindsOf = (d: Def) => [...(d.jobKinds ?? []), ...(d.agentJobKinds ?? [])] as { private_network?: boolean }[];

/** Whether something in this build asks for the capability (the pack signal), whatever its flag says. */
export function featureRequested(id: FeatureId): boolean {
  const defs = () => packs().map((p) => p.definition);
  switch (featureSpec(id).requested_by) {
    case "always": return true;
    case "credentials": return defs().some((d) => (d.credentials ?? []).length > 0);
    case "email": return defs().some((d) => { const e = d.email as { sender?: { allow?: boolean }; intake?: unknown } | undefined; return !!e && (e.sender?.allow === true || !!e.intake); });
    case "clocks": return defs().some((d) => areasOf(d).some((a) => a.scope === "workspace" && (a.clocks?.length ?? 0) > 0));
    case "alerts": return defs().some((d) => areasOf(d).some((a) => !!a.due)) || featureOn("record_clocks");
    case "private_network": return defs().some((d) => kindsOf(d).some((k) => k.private_network === true));
    case "developer_surface": return packConfigs().some((c) => !!c.developer_surface);
    case "checks": return defs().some((d) => (d.checks ?? []).length > 0);
    case "encrypted": return defs().some((d) => areasOf(d).some((a) => (a.fields ?? []).some((f) => f.encrypted === true)));
    case "no_engine": return !sessionEngine();
    case "documents": return defs().some((d) => areasOf(d).some((a) => (a.fields ?? []).some((f) => f.type === "file" || f.preview === "document")));
  }
}

/** The capability is on: something asks for it and its flag is not false. */
export const featureOn = (id: FeatureId): boolean => featureSetting(id) && featureRequested(id);

export interface FeatureState { id: FeatureId; short: string; label: string; setting: boolean; requested: boolean; on: boolean }
/** Every flag of this build: its setting, whether it is asked for, and the result (the data map, Health and tests). */
export const featureStates = (): FeatureState[] => FEATURES.map((f) => {
  const setting = featureSetting(f.id), requested = featureRequested(f.id);
  return { id: f.id, short: f.short, label: f.label, setting, requested, on: setting && requested };
});
/** The short names of the capabilities that are on, in registry order ("email, clocks, alerts, audit.data, runners"). */
export const featuresOnWords = () => featureStates().filter((s) => s.on).map((s) => s.short).join(", ");
