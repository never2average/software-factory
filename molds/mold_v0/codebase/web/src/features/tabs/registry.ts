// The console tabs packs declare (mold_v0-058), from the generated web/src/config/pack-nav.generated.ts (scripts/gen-packs.mjs).
import { packCharts, packTabs, type PackChartSpec, type PackTabSpec } from '../../config/pack-nav.generated';

/** The kinds of tab drawn by the tab page itself; the others open a shell page (/app/billing...) or a pack page. */
const OWN_PAGE = new Set<PackTabSpec['kind']>(['overview', 'area', 'runs', 'reports']);
const ownPage = (t: PackTabSpec) => OWN_PAGE.has(t.kind) && t.url === `/app/${t.id}`;

/** The tab at /app/<id> (mold_v0-132: flat; its page is the shell's: overview, area, runs, reports), or null. */
export function findTab(id: string): PackTabSpec | null {
  return packTabs.find((t) => t.id === id && ownPage(t)) ?? null;
}

/** Every tab with a page of its own, for generateStaticParams (beside the packs' own pages). */
export const tabPageParams = () => packTabs.filter(ownPage).map((t) => ({ page: t.id }));

/** A tab's charts, in its order. */
export const tabCharts = (t: PackTabSpec): PackChartSpec[] =>
  t.charts.map((n) => packCharts.find((c) => c.pack === t.pack && c.name === n)).filter((c): c is PackChartSpec => !!c);
