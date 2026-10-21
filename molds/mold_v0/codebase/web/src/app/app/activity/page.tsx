import { WorkspaceActivityPage } from '@/features/usage/activity-page';

// Usage in neutral words (mold_v0-008): the workspace's tool calls, members and runs. In the sidebar when the build has a pack.
export const metadata = { title: 'Activity' };

export default function Page() {
  return <WorkspaceActivityPage />;
}
