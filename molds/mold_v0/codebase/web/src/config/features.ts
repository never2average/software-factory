// The features registry (mold_v0-219; the server's src/features.ts, src/features.json): which optional capabilities are
// on in this build, as scripts/gen-packs.mjs resolved them (asked for by the packs, or always, and not turned off by
// profile.json `features`). The console's pages, sidebar entries and Settings tabs read this, never a pack's declaration.
import { features } from './features.generated';

export type FeatureId =
  | 'customer_key_vault' | 'company_email' | 'scheduled_alerts' | 'record_clocks' | 'audit.data' | 'audit.platform'
  | 'audit.sign' | 'onprem_runners' | 'developer_surface' | 'declarative_checks' | 'encrypted_fields' | 'health_history' | 'document_preview'
  | 'agent_harness' | 'record_pages' | 'side_panel_forms' | 'teams'
  | 'record_run_inputs' | 'wide_lists' | 'record_rules' | 'credential_sets' | 'overview_cards' | 'run_analytics' | 'filters_in_address' | 'usage_tool'
  | 'workspace_recipes'
  | 'nested_runs'
  | 'record_resources';
export const featureOn = (id: FeatureId): boolean => features[id] === true;
