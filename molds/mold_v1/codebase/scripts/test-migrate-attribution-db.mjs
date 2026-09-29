/**
 * THE ROOT MIGRATION ATTRIBUTES A COMPANY'S FILES BY ITS WORKSPACES' OWN RECORDS — against a real Postgres, as app_rw.
 *
 * scripts/migrate-dataroom-root.mjs moves a `Customers/<id>/…` (or other company-scoped) object from the data room's
 * root only to the ONE workspace whose customers table holds `<id>`; held by two, or by none, it stays (ambiguous).
 * This drives its `loadCompanyOwners()` — each workspace read inside its own RLS scope, read-only — and the plan it
 * feeds, so the attribution is the database's, not a guess.
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:migrate-attribution-db
 */
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-migrate-attribution-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const stamp = Date.now();
const A = `attr-a-${stamp}`;
const B = `attr-b-${stamp}`;
const { closeDb } = await import("../agent/lib/db/index.ts");
const migrate = await import("../scripts/migrate-dataroom-root.mjs");

try {
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Attr A', 'active'), (${B}, 'Attr B', 'active')`;
  await admin`insert into customers (customer_id, org_id, customer_name) values
    (${`only-a-${stamp}`}, ${A}, 'Only A'), (${`both-${stamp}`}, ${A}, 'Both'), (${`both-${stamp}`}, ${B}, 'Both')`;

  console.log("\nThe company owners come from each workspace's own customers table");
  const load = migrate.loadCompanyOwners;
  check("scripts/migrate-dataroom-root.mjs exports loadCompanyOwners", typeof load === "function");
  if (typeof load === "function") {
    const owners = await load();
    const of = (id) => [...(owners.get(id) ?? [])].sort();
    check("a company one workspace holds maps to that workspace", JSON.stringify(of(`only-a-${stamp}`)) === JSON.stringify([A]), of(`only-a-${stamp}`));
    check("a company both hold maps to both", JSON.stringify(of(`both-${stamp}`)) === JSON.stringify([A, B].sort()), of(`both-${stamp}`));
    const plan = migrate.planRootObjects(
      [
        { pathname: `Customers/only-a-${stamp}/context.md`, size: 1 },
        { pathname: `Customers/both-${stamp}/context.md`, size: 1 },
        { pathname: `Deployments/only-a-${stamp}/v1/platform/organization.json`, size: 1 },
        { pathname: `Customers/nobody-${stamp}/context.md`, size: 1 },
      ],
      { companyOwners: owners },
    );
    const act = (p) => plan.find((o) => o.pathname === p);
    check("…so its files are planned into that workspace", act(`Customers/only-a-${stamp}/context.md`)?.to === `orgs/${A}/Customers/only-a-${stamp}/context.md` && act(`Deployments/only-a-${stamp}/v1/platform/organization.json`)?.to?.startsWith(`orgs/${A}/`), plan);
    check("…and a company held by both, or by nobody, stays at the root as ambiguous", act(`Customers/both-${stamp}/context.md`)?.action === "ambiguous" && act(`Customers/nobody-${stamp}/context.md`)?.action === "ambiguous", plan);
  }
} finally {
  await admin`delete from customers where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
  await admin.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
