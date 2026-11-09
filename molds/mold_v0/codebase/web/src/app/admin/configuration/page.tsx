import { AgentConfigurationPage } from '@/features/admin/agent-configuration';

// mold_v0-284: with agent_harness on, its Configuration and Profiles in-page tabs (web/src/features/admin/agent-configuration.tsx).
export const metadata = { title: 'Agent configuration' };
export default function Page() {
  return <AgentConfigurationPage />;
}
