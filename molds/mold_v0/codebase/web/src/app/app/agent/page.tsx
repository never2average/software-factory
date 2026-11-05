import { AgentPage } from '@/features/agent/agent-page';

// The workspace agent (mold_v0-243): its sessions and their steering, opened by the top bar's agent icon. A page of the
// build only while the app's profile turns agent_harness on (scripts/gen-packs.mjs leaves it out of the routes otherwise).
export const metadata = { title: 'Agent' };

export default function Page() {
  return <AgentPage area='app' />;
}
