import { notFound } from "next/navigation";

/**
 * /preview/* are test fixtures: pages that render real components over mock
 * data with no auth, no database and no network, so Playwright can check them
 * in isolation (tests/cards.spec.ts, tests/stickloop.spec.ts). They exist for
 * `next dev` only — a production build answers 404 here, so a deployment never
 * gains an unauthenticated route it did not ask for.
 */
export default function PreviewLayout({ children }: { readonly children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
