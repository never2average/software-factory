// A tab's empty state (mold_v0-107): what an area, runs or reports tab shows while it has nothing to show. The words
// come from the build (src/metric-spec.ts tabEmpty, written by gen-packs into the tab's spec): the pack's pack.json
// `empty` where it says one, else the shell's default from the area's label, the build's words and its onboarding.
// Plain text, drawn as text; the link's address was checked by the build (a path of this site, https: or mailto:).
// Pure: the tab page decides when there is nothing; a rendered check draws it (scripts/console-tabs-test.ts).
import type { ReactNode } from 'react';
import { EmptyNotice } from '@/features/status/empty-state';
import type { PackTabSpec } from '@/config/pack-nav.generated';

export type EmptySpec = NonNullable<PackTabSpec['empty']>;

/** The Setup page's anchor of a pack's onboarding step: the same as the build's (src/metric-spec.ts onboardingAnchor). */
export const onboardingAnchor = (pack: string, step: string) => `onboarding-${pack}-${step}`.replace(/[^A-Za-z0-9_-]/g, '-');

/** The fallback when a tab's spec carries none (a console built before mold_v0-107's generator). */
const NOTHING: EmptySpec = { title: 'Nothing here yet.', text: '', cta: null };

/**
 * mold_v0-298: one empty state for the console: this draws the shared EmptyNotice (features/status/empty-state.tsx).
 * `action` (a button of the caller's, such as Start) takes the link's place inside the box.
 */
export function EmptyState({ empty, id, action }: { empty?: EmptySpec | null; id?: string; action?: ReactNode }) {
  const e = empty ?? NOTHING;
  return <EmptyNotice id={id} note={{ title: e.title, text: e.text || undefined, action: action ?? e.cta ?? undefined }} />;
}
