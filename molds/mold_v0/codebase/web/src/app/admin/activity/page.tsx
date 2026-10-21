import { OperatorActivityPage } from '@/features/usage/activity-page';

// Usage in neutral words (mold_v0-008): every workspace's tool calls and runs. In the sidebar when the build has a pack.
export const metadata = { title: 'Activity' };

export default function Page() {
  return <OperatorActivityPage />;
}
