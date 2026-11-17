/**
 * mold_v0-318: the trail of a record whose area has no sidebar entry of its own, through the records it belongs to
 * (`parents`, nearest first, from its page: src/record-crumbs.ts on the server). Pure, so scripts/record-crumbs-test.ts
 * reads it: the farthest parent's area as its list is crumbed (`areaCrumbs`: its entry, its sub-tab), then each parent
 * record linking to its page, then the record itself.
 */
export type TrailCrumb = { title: string; link?: string; keep?: boolean };
export type TrailParent = { area: string; key: string; title: string | null };

export function parentTrail(parents: readonly TrailParent[], self: { title: string; link: string }, areaCrumbs: (listUrl: string, area: string) => TrailCrumb[]): TrailCrumb[] {
  const root = parents.at(-1);
  if (!root) return [self];
  const records = [...parents].reverse().map((p) => ({ title: p.title || p.key, link: `/app/records/${encodeURIComponent(p.area)}/${encodeURIComponent(p.key)}` }));
  return [...areaCrumbs(`/app/records/${root.area}`, root.area), ...records, self];
}
