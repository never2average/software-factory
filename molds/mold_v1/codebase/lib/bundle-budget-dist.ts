/**
 * The output directory of the bundle budget's source-mapped build (scripts/check-bundle-budget.mjs), or undefined for
 * every other build.
 *
 * next.config.ts reads no env var raw (scripts/check-gates.mjs): a value is validated for its SHAPE. This one is
 * accepted only as exactly `.next-budget`, the directory the budget script asks for, so no other value can move a
 * build's output or switch on source maps (which carry source text) for a build that ships.
 */
export const BUNDLE_BUDGET_DIST = ".next-budget";

export function bundleBudgetDist(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.BUNDLE_BUDGET_DIST === BUNDLE_BUDGET_DIST ? BUNDLE_BUDGET_DIST : undefined;
}
