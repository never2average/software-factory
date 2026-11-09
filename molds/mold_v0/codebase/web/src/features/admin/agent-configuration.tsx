'use client';
// Admin › Agent configuration (mold_v0-284): with agent_harness on, one sidebar entry of two in-page tabs drawn with the
// console's one strip (web/src/features/tabs/in-page-tabs.tsx, ?tab=): Configuration (the settings, ./configuration.tsx)
// and Profiles (the workspace agent's profiles, exactly as their own page draws them: a row opens its side panel,
// ?profile=<id>; New profile is the modal). /admin/agent-profiles leads to ?tab=profiles, its query kept (next.config
// redirects from scripts/gen-packs.mjs). Without the tabs (the agent off, or the profiles in the staff Records group):
// the settings page alone, as before.
import PageContainer from '@/components/layout/page-container';
import { agentConfigTabs } from '@/config/nav-config';
import { InPageTabs } from '@/features/tabs/in-page-tabs';
import { AgentProfilesPage } from '@/features/agent/profiles-page';
import { AdminConfiguration } from './configuration';

export function AgentConfigurationPage() {
  if (!agentConfigTabs.length) return <AdminConfiguration />;
  // A page of in-page tabs starts with its strip: no title above it (its name is the breadcrumb's).
  return (
    <PageContainer>
      <InPageTabs tabs={agentConfigTabs}>
        {(tab) => (tab.id === 'profiles' ? <AgentProfilesPage key={tab.id} bare /> : <AdminConfiguration key={tab.id} bare />)}
      </InPageTabs>
    </PageContainer>
  );
}
