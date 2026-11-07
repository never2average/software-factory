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
 *              developer_surface, checks, encrypted fields, record page layouts), a build without the session engine (health_history), or
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
const areasOf = (d: Def) => (d.recordAreas ?? []) as { scope?: string; due?: unknown; clocks?: unknown[]; detail?: unknown; key_from_title?: boolean; list_columns?: unknown[]; on_save?: unknown[]; fields?: { encrypted?: boolean; type?: string; preview?: string; copyable?: boolean; where?: unknown; display?: string }[] }[];
const kindsOf = (d: Def) => [...(d.jobKinds ?? []), ...(d.agentJobKinds ?? [])] as { private_network?: boolean; input_from_record?: unknown }[];
const tabsOf = (d: Def) => (d.tabs ?? []) as { kind?: string; include?: string[]; columns?: unknown[]; sparklines?: unknown[]; rail?: string[] }[];

/**
 * mold_v0-260: what asks for each of the batch's flags, read from one pack definition (pack.json's own keys or the
 * compiled definition's: both shapes are read). Shared by the server (featureRequested) and kept in step with
 * scripts/gen-packs.mjs and the factory's lib/features.py.
 */
export const gapAsks = {
  record_inputs: (d: Def) => kindsOf(d).some((k) => !!k.input_from_record),
  private_catalogs: (d: Def) => Object.values((d.repositories ?? {}) as Record<string, { kind?: string; access?: string }>).some((r) => r?.kind === "upstream_catalog" && !!r.access && r.access !== "public"),
  wide_lists: (d: Def) => areasOf(d).some((a) => (a.list_columns?.length ?? 0) > 8) || tabsOf(d).some((t) => (t.columns?.length ?? 0) > 8),
  record_rules: (d: Def) => areasOf(d).some((a) => (a.on_save?.length ?? 0) > 0 || (a.fields ?? []).some((f) => !!f.where))
    || kindsOf(d).some((k) => ((k as { args?: { where?: unknown }[] }).args ?? []).some((f) => !!f.where)),
  credential_sets: (d: Def) => ((d.credentials ?? []) as { entries?: unknown; bound_to?: string }[]).some((c) => !!c.entries || c.bound_to === "tenant"),
  home_cards: (d: Def) => tabsOf(d).some((t) => t.kind === "overview" && (t.include ?? []).includes("setup")
    && ((t.sparklines?.length ?? 0) > 4 || (t.rail ?? []).some((x) => x === "recent_runs" || x === "attention"))),
};

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
    // mold_v0-256: also a tab column computed from related records, or an area whose Key follows its Title.
    case "layouts": return defs().some((d) => areasOf(d).some((a) => !!a.detail || a.key_from_title === true || (a.fields ?? []).some((f) => f.copyable === true || f.display === "chips"))
      || ((d.tabs ?? []) as { columns?: unknown[] }[]).some((t) => (t.columns ?? []).some((c) => !!c && typeof c === "object")));
    case "record_inputs": case "private_catalogs": case "wide_lists": case "record_rules": case "credential_sets": case "home_cards": {
      const ask = gapAsks[featureSpec(id).requested_by as keyof typeof gapAsks];
      return defs().some((d) => ask(d));
    }
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
