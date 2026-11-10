'use client';
// A staff Records entry of in-page tabs (mold_v0-281, console.admin_records `tabs`; scripts/gen-packs.mjs resolves it):
// the console's one in-page tab strip (web/src/features/tabs/in-page-tabs.tsx, the customer sections tabs' too), and
// below it the selected member's own staff list, exactly as its own page draws it: a shared area's list
// (/admin/records/<area>) or a shell staff page's body (Journeys, Recipes, Agent profiles, Data repositories). Each
// member's own address of before leads here (next.config redirects); a record's own page stays where it is.
import { ProgramsPage } from '@/features/agent/programs-page';
import PageContainer from '@/components/layout/page-container';
import { InPageTabs } from '@/features/tabs/in-page-tabs';
import { AdminJourneys } from '@/features/journeys/admin';
import { RecipesPage } from '@/features/agent/recipes-page';
import { AgentProfilesPage } from '@/features/agent/profiles-page';
import { AdminRepositories } from '@/features/admin/repositories';
import { findRecordArea, findRecordGroup } from './registry';
import { StaffRecordListPage } from './staff-records';

type Member = { id: string; label: string; url: string; area?: string };

function MemberBody({ tab }: { tab: Member }) {
  if (tab.area) {
    const area = findRecordArea('admin', tab.area);
    return area ? <StaffRecordListPage key={tab.id} area={area} bare /> : null;
  }
  switch (tab.id) {
    case 'journeys': return <AdminJourneys key={tab.id} bare />;
    case 'recipes': return <RecipesPage key={tab.id} bare />;
    case 'agent-profiles': return <AgentProfilesPage key={tab.id} bare />;
    case 'repositories': return <AdminRepositories key={tab.id} bare />;
    case 'programs': return <ProgramsPage key={tab.id} bare />;
    default: return null;
  }
}

export function StaffRecordGroupPage({ group }: { group: string }) {
  const entry = findRecordGroup(group);
  if (!entry) return null;
  // A page of in-page tabs starts with its strip: no title above it (as a customer sections tab), its name for screen readers.
  return (
    <PageContainer pageTitle={entry.title}>
      <InPageTabs tabs={entry.inPageTabs}>{(tab) => <MemberBody tab={tab} />}</InPageTabs>
    </PageContainer>
  );
}
