// Row-level security check (src/rls.ts, docs/security.md), against DATABASE_URL (or the local PGlite): run on every
// deploy after the migrations (deploy/rolling-deploy.sh). Exits 1 if a tenant table has no policy or the live probe
// finds one organization reaching another's rows. Changes nothing: the probe's rows are rolled back.
//   npm run check:rls
const { getDb } = await import("../src/db.js");
const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
const db = await getDb();
try {
  const catalog = await rlsCatalogProblems(db);
  const probe = catalog.length ? { problems: [], checked: 0 } : await rlsProbe(db);
  const problems = [...catalog, ...probe.problems];
  if (problems.length) {
    console.error(`RLS CHECK FAIL (${db.kind}):\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else console.log(`RLS CHECK PASS (${db.kind}): every tenant table has row-level security; live probe ${probe.checked} checks, nothing crossed`);
} finally {
  await db.close();
}
