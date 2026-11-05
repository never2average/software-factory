import { AgentPage } from '@/features/agent/agent-page';

// Every workspace's agent sessions (mold_v0-243), for staff: pause, stop, raise a budget, decline a request; never a
// message (a session acts for the person who started it). A page of the build only with agent_harness on.
export const metadata = { title: 'Agent sessions' };

export default function Page() {
  return <AgentPage area='admin' />;
}
