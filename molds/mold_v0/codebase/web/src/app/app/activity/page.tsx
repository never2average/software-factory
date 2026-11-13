import { WorkspaceActivityPage } from '@/features/activity/activity-page';
import { activityLabel } from '@/features/activity/title';

// Usage in neutral words (mold_v0-008): the workspace's tool calls, members and runs. In the sidebar when the build has a pack.
// mold_v0-298: named as the sidebar names it (a pack's usage tab's label, else the sidebar's entry), one name per build.
export const metadata = { title: activityLabel() };

export default function Page() {
  return <WorkspaceActivityPage />;
}
