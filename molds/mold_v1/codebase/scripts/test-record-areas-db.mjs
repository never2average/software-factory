/**
 * THE TWO RECORD AREAS (deployments[], implementation), WRITTEN BY upsert_customer, AGAINST A REAL POSTGRES.
 *
 * #57 stopped the account's own `custom` column being rewritten from a stale read. The two record areas still were:
 * upsert_customer read the whole record, merged the patch in memory, deleted every nested row and inserted the
 * merged copy back. So, between its read and its write:
 *
 *   · a field someone else changed on a deployment row or the implementation (the ops API, another agent turn, a
 *     coding agent through MCP) was put back to the value read before it;
 *   · an interaction logged meanwhile was deleted with the rest of the nested rows;
 *   · a row the caller did not resend was deleted, and its long text with it (the shrink guard never saw it), and a
 *     field it did not resend was blanked;
 *   · the record it returned was the one computed from the read, not the one stored.
 *
 * Now a patch names the rows and fields it changes; each is written in SQL onto what is stored at write time, a row
 * is deleted only by `remove: true`, and the result is read back after the write. Each check below fails on 324649d.
 *
 * Run in CI's `isolation` job after drizzle-kit push and scripts/bootstrap-test-db.mjs, as app_rw under RLS; its rows
 * live under a throwaway workspace carrying this process's pid, removed in a finally block. Needs ADMIN_URL and
 * DATABASE_URL (the app_rw url); without them it skips.
 *
 * Run:  ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/workspace_test \
 *       DATABASE_URL=postgres://app_rw:…@127.0.0.1:5432/workspace_test npm run test:record-areas-db
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { readJsonFixture } from "./lib/read-fixture.mjs";

const adminUrl = process.env.ADMIN_URL;
const url = process.env.DATABASE_URL;
if (!adminUrl || !url) {
  console.log("test-record-areas-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (the app_rw url).");
  process.exit(0);
}

// record_interaction mirrors each interaction into the data room: a throwaway one, never the checkout's.
const DATAROOM = mkdtempSync(join(tmpdir(), "record-areas-"));
process.env.DATAROOM_DIR = DATAROOM;

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
};
/** A check whose body may throw (a write refused by the old schema counts as the check failing, not the run). */
const attempt = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    check(label, false, `threw: ${String(e?.message ?? e).slice(0, 300)}`);
  }
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const ORG = `areas-test-${process.pid}`;
const OTHER = `areas-other-${process.pid}`;
const CO = `areas-co-${process.pid}`;
const ROUNDS = 40;
const LONG = `Initiation thesis. ${"Deposits reprice slower than the book. ".repeat(40)}`.trim();

// What a coverage-report desk declares (this build's own profile declares none).
const declared = {
  account: [],
  deployments: [
    { key: "summary", label: "Summary", type: "long_text" },
    { key: "rating", label: "Rating", type: "pick_list", options: ["Buy", "Hold", "Sell"] },
  ],
  implementations: [{ key: "crew", label: "Crew", type: "number" }],
};
// The fields a brand-new row needs; a row that exists needs only what changes.
const REQUIRED_DEP = { environment: "prod", region: "ap-south-1", deployedVersion: "Q2 FY26", releaseStatus: "deployed", healthStatus: "healthy" };
const REQUIRED_IMPL = { implementationStage: "Discovery", implementationProgressPct: 10, implementationRiskLevel: "Green", blockerOwner: "None" };

let closeDb = null;
try {
  await admin`insert into orgs (org_id, name, status) values (${ORG}, 'Record areas probe', 'active'), (${OTHER}, 'Another workspace', 'active')`;
  const { getDb, closeDb: close, withOrgDb } = await import("../agent/lib/db/index.ts");
  closeDb = close;
  const sor = await import("../agent/lib/system-of-record.ts");
  const { sql } = await import("drizzle-orm");
  const [{ current_user: role }] = await getDb().execute(sql`select current_user`);
  check("the app connects as app_rw (NOBYPASSRLS), not as the owner", role === "app_rw", role);

  const upsert = (patch) => sor.upsertCustomer({ id: CO, ...patch }, ORG, { declared });
  // Another writer, as the ops API writes: one scoped statement on one row.
  const opsWrite = (statement) => withOrgDb(ORG, (tx) => tx.execute(statement));
  const depRow = async (id) => (await admin`select * from deployments where customer_id = ${CO} and deployment_id = ${id}`)[0] ?? null;
  const implRow = async () => (await admin`select * from implementation where customer_id = ${CO}`)[0] ?? null;

  // Seeded as the owner, so the record exists whatever the write path under test does with it.
  await admin`insert into customers (customer_id, org_id, customer_name) values (${CO}, ${ORG}, 'Areas Co')`;
  await admin`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status, notes, custom)
              values (${ORG}, ${CO}, 'R1', 'prod', 'ap-south-1', 'Q2 FY26', 'deployed', 'healthy', 'n0', ${admin.json({ summary: LONG, rating: "Hold" })}),
                     (${ORG}, ${CO}, 'R2', 'prod', 'ap-south-1', 'Q1 FY26', 'deployed', 'healthy', null, '{}'::jsonb)`;
  await admin`insert into implementation (org_id, customer_id, rollout_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, blocker, custom)
              values (${ORG}, ${CO}, 'large-caps', 'Discovery', 10, 'Green', 'None', 'b0', ${admin.json({ crew: 2 })})`;
  check("the record has both rows and the implementation", (await depRow("R1")) && (await depRow("R2")) && (await implRow()));

  console.log("\n1. A field written by someone else while upsert_customer changes another is never put back");
  await attempt("deployments[]: a row's note survives a concurrent change of its status", async () => {
    let lost = 0;
    let stale = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      const note = `note written in round ${i}`;
      let opsDone = false;
      let result;
      await Promise.all([
        // What a model sends to change one field: the row's id, its required fields, the one change. No `notes`.
        upsert({ deployments: [{ deploymentId: "R1", ...REQUIRED_DEP, releaseStatus: i % 2 ? "in-progress" : "deployed" }] }).then((r) => {
          result = { r, opsFirst: opsDone };
        }),
        opsWrite(sql`update deployments set notes = ${note} where customer_id = ${CO} and deployment_id = 'R1'`).then(() => {
          opsDone = true;
        }),
      ]);
      if ((await depRow("R1")).notes !== note) lost++;
      // The ops write finished before the upsert returned: what the upsert returns must already carry it.
      if (result.opsFirst && result.r.deployments?.find((d) => d.deploymentId === "R1")?.notes !== note) stale++;
    }
    check(`…the note is never lost (${ROUNDS} rounds, lost ${lost})`, lost === 0, `lost in ${lost} of ${ROUNDS} rounds`);
    check(`…and the record upsert_customer returns is the one stored (stale in ${stale} rounds)`, stale === 0, `stale in ${stale} rounds`);
  });
  await attempt("implementation: its blocker survives a concurrent change of its stage", async () => {
    let lost = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      const blocker = `blocker written in round ${i}`;
      await Promise.all([
        upsert({ implementation: { ...REQUIRED_IMPL, implementationStage: i % 2 ? "UAT" : "Pilot" } }),
        opsWrite(sql`update implementation set blocker = ${blocker} where customer_id = ${CO}`),
      ]);
      if ((await implRow()).blocker !== blocker) lost++;
    }
    check(`…the blocker is never lost (${ROUNDS} rounds, lost ${lost})`, lost === 0, `lost in ${lost} of ${ROUNDS} rounds`);
  });
  await attempt("a row's own fields: a summary saved meanwhile survives a change of its rating", async () => {
    let lost = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      const summary = `${LONG} Round ${i}.`;
      await Promise.all([
        upsert({ deployments: [{ deploymentId: "R1", ...REQUIRED_DEP, custom: { rating: i % 2 ? "Buy" : "Sell" } }] }),
        opsWrite(sql`update deployments set custom = custom || jsonb_build_object('summary', ${summary}::text) where customer_id = ${CO} and deployment_id = 'R1'`),
      ]);
      const row = await depRow("R1");
      if (row.custom.summary !== summary || !row.custom.rating) lost++;
    }
    check(`…both land, every round (${ROUNDS} rounds, lost ${lost})`, lost === 0, `lost in ${lost} of ${ROUNDS} rounds`);
  });
  await attempt("an interaction logged while upsert_customer changes the account is kept", async () => {
    const before = (await admin`select count(*)::int as n from interactions where customer_id = ${CO}`)[0].n;
    for (let i = 1; i <= 20; i++) {
      await Promise.all([
        upsert({ healthReason: `round ${i}` }),
        sor.recordInteraction(CO, { interactionId: `INT-areas-${process.pid}-${i}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: `logged in round ${i}` }, ORG),
      ]);
    }
    const after = (await admin`select count(*)::int as n from interactions where customer_id = ${CO}`)[0].n;
    check(`…all 20 are still there (${after - before} of 20)`, after - before === 20, { before, after });
  });

  console.log("\n2. Two upserts at once, each naming its own change, both land");
  await attempt("two new rows added at once both exist, every round", async () => {
    let missing = 0;
    for (let i = 1; i <= 20; i++) {
      const [a, b] = [`A${i}`, `B${i}`];
      await Promise.all([upsert({ deployments: [{ deploymentId: a, ...REQUIRED_DEP }] }), upsert({ deployments: [{ deploymentId: b, ...REQUIRED_DEP }] })]);
      if (!(await depRow(a)) || !(await depRow(b))) missing++;
    }
    check(`…(20 rounds, a row missing in ${missing})`, missing === 0, `${missing} of 20`);
  });
  await attempt("two changes to different fields of one row both land, every round", async () => {
    let lost = 0;
    for (let i = 1; i <= 20; i++) {
      await Promise.all([
        upsert({ deployments: [{ deploymentId: "R2", ...REQUIRED_DEP, notes: `n${i}` }] }),
        upsert({ deployments: [{ deploymentId: "R2", ...REQUIRED_DEP, approvedByEmail: `r${i}@example.com` }] }),
      ]);
      const row = await depRow("R2");
      if (row.notes !== `n${i}` || row.approved_by_email !== `r${i}@example.com`) lost++;
    }
    check(`…(20 rounds, one lost in ${lost})`, lost === 0, `${lost} of 20`);
  });

  console.log("\n3. Deleting is explicit; leaving a row or a field out keeps it");
  await attempt("a patch naming only R2 keeps R1, and R1's long text", async () => {
    await upsert({ deployments: [{ deploymentId: "R2", healthStatus: "degraded" }] });
    const r1 = await depRow("R1");
    check("…R1 is still there with its long summary", r1 && r1.custom.summary.startsWith(LONG), r1 && r1.custom);
    const r2 = await depRow("R2");
    check("…and R2 changed only its health (its note and reviewer kept)", r2.health_status === "degraded" && r2.notes === "n20" && r2.approved_by_email === "r20@example.com", r2);
  });
  await attempt("a field left out of a row keeps its value; null clears it", async () => {
    await upsert({ deployments: [{ deploymentId: "R1", healthStatus: "down" }] });
    const kept = await depRow("R1");
    check("…left out: kept", kept.notes !== null && kept.health_status === "down", kept.notes);
    await upsert({ deployments: [{ deploymentId: "R1", notes: null }] });
    check("…null: cleared", (await depRow("R1")).notes === null);
  });
  await attempt("remove: true deletes exactly that row", async () => {
    const out = await upsert({ deployments: [{ deploymentId: "R2", remove: true }] });
    check("…R2 is gone, R1 stays", !(await depRow("R2")) && (await depRow("R1")));
    check("…and the result says so", !out.deployments.some((d) => d.deploymentId === "R2") && out.deployments.some((d) => d.deploymentId === "R1"));
  });
  await attempt("the implementation: a field left out keeps its value; remove: true deletes it", async () => {
    await upsert({ implementation: { implementationProgressPct: 55 } });
    const row = await implRow();
    check("…one field changed, the rest kept (stage, rollout, crew)", row.implementation_progress_pct === 55 && row.rollout_id === "large-caps" && row.custom.crew === 2, row);
    await upsert({ implementation: { remove: true } });
    check("…removed only when asked", (await implRow()) === null);
  });

  console.log("\n4b. One rule for every list: solutions, tickets, interactions and platform merge row by row too");
  await attempt("a patch naming one interaction keeps every other one", async () => {
    const before = (await admin`select count(*)::int as n from interactions where customer_id = ${CO}`)[0].n;
    await upsert({ interactions: [{ interactionId: `INT-one-${process.pid}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: "one more" }] });
    const after = (await admin`select count(*)::int as n from interactions where customer_id = ${CO}`)[0].n;
    check(`…${before} kept, one added (${after})`, before > 0 && after === before + 1, { before, after });
  });
  await attempt("tickets: a field of one ticket changes, the rest of it and the other tickets are kept", async () => {
    const FX = readJsonFixture(new URL("./fixtures/customers.fixture.json", import.meta.url)).customers[0];
    await upsert({ tickets: [{ ...FX.tickets[0], ticketId: "T1" }, { ...FX.tickets[0], ticketId: "T2" }] });
    await upsert({ tickets: [{ ticketId: "T1", ticketNextStep: "changed" }] });
    const rows = await admin`select ticket_id, ticket_next_step, summary from tickets where customer_id = ${CO} order by 1`;
    check("…T1 changed only its next step, T2 untouched", rows.length === 2 && rows[0].ticket_next_step === "changed" && rows[0].summary === FX.tickets[0].summary && rows[1].ticket_next_step === FX.tickets[0].ticketNextStep, rows);
  });
  await attempt("remove: true sent with other fields is refused, nothing deleted", async () => {
    await assert.rejects(upsert({ tickets: [{ ticketId: "T2", remove: true, summary: "x" }] }), (e) => {
      check("…in a sentence", /Nothing was written\. ticketId T2: remove: true deletes the row, so it is sent with nothing else \(it also named summary\)/.test(e.message), e.message);
      return true;
    });
    check("…T2 is still there", (await admin`select 1 from tickets where customer_id = ${CO} and ticket_id = 'T2'`).length === 1);
  });
  await attempt("remove on an id that is not there is said, not silently ignored", async () => {
    await assert.rejects(upsert({ deployments: [{ deploymentId: "NOPE", remove: true }] }), (e) => {
      check("…in a sentence", /Nothing was written\. deploymentId NOPE: there is no such deliveries row to remove\./.test(e.message), e.message);
      return true;
    });
  });

  console.log("\n5. Another workspace cannot write any nested area of this account (review of #70)");
  // Workspace OTHER names this account's id. A company is keyed by (org_id, customer_id) (mold_v1-118), so OTHER's
  // write is to ITS OWN company of that id, created on first use; the nested rows it writes carry OTHER and hang off
  // OTHER's company (the foreign key names both columns). Nothing may land under THIS workspace's account, and a row
  // stamped OTHER with no company of OTHER's to hang off is refused by the database.
  const FIXTURE = readJsonFixture(new URL("./fixtures/customers.fixture.json", import.meta.url)).customers[0];
  const mineNow = async () => {
    const out = {};
    for (const t of ["customers", "deployments", "implementation", "platform", "solutions", "tickets", "interactions"]) {
      out[t] = await admin.unsafe(`select to_jsonb(x) - 'updated_at' as r from ${t} x where customer_id = $1 and org_id = $2 order by 1::text`, [CO, ORG]);
    }
    return JSON.stringify(out);
  };
  const orphans = async () =>
    (await admin.unsafe(`select count(*)::int as n from (
       select org_id, customer_id from deployments union all select org_id, customer_id from implementation
       union all select org_id, customer_id from platform union all select org_id, customer_id from solutions
       union all select org_id, customer_id from tickets union all select org_id, customer_id from interactions) r
     where r.org_id = $1 and not exists (select 1 from customers c where c.org_id = r.org_id and c.customer_id = r.customer_id)`, [OTHER]))[0].n;
  const mineBefore = await mineNow();
  const attempts = {
    deployments: { deployments: [{ deploymentId: `SQUAT-${process.pid}`, ...REQUIRED_DEP }] },
    implementation: { implementation: { ...REQUIRED_IMPL } },
    platform: { platform: FIXTURE.platform },
    solutions: { solutions: [{ ...FIXTURE.solutions[0], solutionId: `SOL-${process.pid}` }] },
    tickets: { tickets: [{ ...FIXTURE.tickets[0], ticketId: `TCK-${process.pid}` }] },
    interactions: { interactions: [{ interactionId: `INT-squat-${process.pid}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: "squat" }] },
  };
  for (const [area, patch] of Object.entries(attempts)) {
    let written = null;
    try {
      written = await sor.upsertCustomer({ id: CO, ...patch }, OTHER, { declared });
    } catch (e) {
      written = String(e?.message ?? e);
    }
    const theirs = typeof written === "object" && written !== null;
    check(`${area}: OTHER's write lands in OTHER's own company of this id, never under this workspace's account`,
      (await mineNow()) === mineBefore && (await orphans()) === 0 && (!theirs || (written.name === CO && !JSON.stringify(written).includes("Areas Co"))),
      { written: typeof written === "string" ? written.slice(0, 160) : written?.name, orphans: await orphans() });
  }
  const { deployments: depTable } = await import("../agent/lib/db/schema.ts");
  const planted = await withOrgDb(OTHER, (tx) => tx.insert(depTable).values({ orgId: OTHER, customerId: `areas-none-${process.pid}`, deploymentId: "X", ...REQUIRED_DEP })).then(() => "inserted", (e) => e?.code ?? e?.cause?.code ?? String(e));
  check("a nested row stamped OTHER under an id OTHER does not hold is refused by the foreign key (23503)", planted === "23503", planted);
  await admin`delete from customers where customer_id = ${CO} and org_id = ${OTHER}`;

  console.log("\n4. A new row still needs every required field, said in a sentence, and nothing is written");
  await attempt("a new row without its required fields is refused", async () => {
    await assert.rejects(upsert({ healthReason: "should not land", deployments: [{ deploymentId: "R9", notes: "x" }] }), (e) => {
      check("…in a sentence naming the missing fields", /Nothing was written\. deploymentId R9 is a new row, so it needs environment, region, deployedVersion, releaseStatus and healthStatus/.test(e.message), e.message);
      return true;
    });
    check("…and nothing was written, the account included", !(await depRow("R9")) && (await admin`select health_reason from customers where customer_id = ${CO}`)[0].health_reason !== "should not land");
  });
} finally {
  await admin`delete from customers where customer_id = ${CO}`.catch(() => {}); // both workspaces' companies of this id
  for (const t of ["deployments", "implementation", "platform", "solutions", "tickets", "interactions"]) await admin.unsafe(`delete from ${t} where org_id = $1`, [OTHER]).catch(() => {});
  await admin`delete from orgs where org_id in (${ORG}, ${OTHER})`.catch(() => {});
  await admin.end();
  if (closeDb) await closeDb();
  rmSync(DATAROOM, { recursive: true, force: true });
}

console.log(`\nrecord areas (db): ${passed} check(s) passed, ${failed} failed`);
if (failed) process.exit(1);
