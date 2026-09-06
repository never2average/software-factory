// Round-trip test for agent/lib/dataroom-store.ts against the LOCAL backend.
// Run via: npm run test:dataroom  (node --experimental-strip-types)
//
// The orchestrator (no args) wipes a scratch root under .dataroom/ and then
// runs three SEPARATE child processes:
//   --phase seed    writes + lists + appends representative dm.md paths in
//                   all 7 domains, and checks path validation
//   --phase append  proves the seed process's jsonl lines survived, appends more
//   --phase verify  proves lines from BOTH earlier processes are present, in order
// so append durability across process invocations is exercised for real.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DataroomPathError,
  createLocalDataroomStore,
  isValidDataroomPath,
  matchDataroomPath,
  validateDataroomPath,
} from "../agent/lib/dataroom-store.ts";

const SELF = fileURLToPath(import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

// Representative dm.md paths — at least one per canonical domain.
const PATHS = {
  customerContext: "Customers/acme-bank/context.md",
  customerInteractions: "Customers/acme-bank/interactions.jsonl", // Customers jsonl
  platformDesign: "Platform/2026.06.3/design_decisions/tenancy.schemas.json",
  platformChangelog: "Platform/2026.06.3/2026-06-14_changelog_manager.md",
  deploymentSignoff:
    "Deployments/acme-bank/2026.06.3/infrastructure/inference/signoff/internal.md",
  deploymentPipeline:
    "Deployments/acme-bank/2026.06.3/platform/pipelines/doc-ingest/pipeline_config.json",
  solutionRecipe: "Solutions/2026.06.3/agents/kyc-review/recipe.md",
  solutionDataset: "Solutions/2026.06.3/agents/kyc-review/evals/dataset.jsonl", // Solutions jsonl
  implementationConfig: "Implementation/acme-bank/pipelines/doc-ingest/pipeline_config.json",
  ticketsBug: "Tickets/bug/acme-bank/2026.06.3/tickets_TCK-1042.jsonl", // Tickets jsonl
  personIdentity: "People/jane-doe/identity.json",
  personAgreement: "People/jane-doe/agreements/nda-2026.pdf.md",
};

const INVALID_PATHS = [
  "../etc/passwd",
  "/etc/passwd",
  "Customers/../Platform/x.md",
  "Customers/acme-bank/context.txt", // not a dm.md leaf
  "Unknown/foo.md", // not one of the 7 domains
  "Tickets/wrong_category/acme-bank/2026.06.3/tickets_1.jsonl", // bad ticket folder
  "Deployments/acme-bank/2026.06.3/infrastructure/inference/signoff/nonsense.md", // bad signoff role
  "Customers/acme-bank", // folder, not a file
  "",
];

function makeStore() {
  const root = process.env.DATAROOM_TEST_DIR;
  assert(root, "phase processes need DATAROOM_TEST_DIR");
  const store = createLocalDataroomStore(root);
  assert(store.backend.kind === "local", "test must run against the local backend");
  return store;
}

async function phaseSeed() {
  // --- path validation against the schema layer ---
  for (const p of Object.values(PATHS)) {
    assert(isValidDataroomPath(p), `expected valid: ${p}`);
  }
  assert(
    matchDataroomPath(PATHS.ticketsBug)?.domain === "Tickets",
    "ticket path should resolve to the Tickets domain",
  );
  for (const p of INVALID_PATHS) {
    assert(!isValidDataroomPath(p), `expected invalid: ${p}`);
    let threw = false;
    try {
      validateDataroomPath(p);
    } catch (error) {
      threw = true;
      assert(error instanceof DataroomPathError, `expected DataroomPathError for: ${p}`);
    }
    assert(threw, `validateDataroomPath should throw for: ${p}`);
  }

  const store = makeStore();

  // Invalid paths must be rejected before any I/O.
  await store.write("Customers/../Platform/x.md", "nope").then(
    () => assert(false, "write to a traversal path must reject"),
    (error) => assert(error instanceof DataroomPathError, "write rejects with DataroomPathError"),
  );
  await store.appendJsonl(PATHS.customerContext, { a: 1 }).then(
    () => assert(false, "appendJsonl to a non-.jsonl path must reject"),
    (error) => assert(error instanceof DataroomPathError, "appendJsonl rejects non-jsonl"),
  );

  // --- writes across all 7 domains ---
  await store.write(PATHS.customerContext, "# Acme Bank\n\nStrategic account.\n");
  await store.write(
    PATHS.platformDesign,
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }),
  );
  await store.write(PATHS.platformChangelog, "# 2026-06-14 changelog\n");
  await store.write(PATHS.deploymentSignoff, "# Internal signoff\n\nstatus: approved\n");
  await store.write(
    PATHS.deploymentPipeline,
    JSON.stringify({ pipelineId: "doc-ingest", platformVersionId: "2026.06.3" }),
  );
  await store.write(PATHS.solutionRecipe, "# KYC review agent recipe\n");
  await store.write(
    PATHS.implementationConfig,
    JSON.stringify({ pipelineId: "doc-ingest", version: "1" }),
  );
  await store.write(PATHS.personIdentity, JSON.stringify({ personId: "jane-doe" }));
  await store.write(PATHS.personAgreement, "NDA scan placeholder\n");

  // --- first-process appends (three domains' jsonl streams) ---
  const n1 = await store.appendJsonl(PATHS.customerInteractions, {
    interactionId: "int-1",
    seq: 1,
    phase: "seed",
  });
  assert(n1 === 1, "appendJsonl returns the appended record count");
  const n2 = await store.appendJsonl(PATHS.ticketsBug, [
    { ticketId: "TCK-1042", seq: 1, phase: "seed" },
  ]);
  assert(n2 === 1, "array form appends one record");
  await store.appendJsonl(PATHS.solutionDataset, { caseId: "case-1", input: "doc-a" });

  // --- read-backs ---
  const context = await store.read(PATHS.customerContext);
  assert(context?.includes("Acme Bank"), "context.md round-trips");
  assert((await store.read("Customers/no-such-customer/context.md")) === null, "missing → null");
  const interactions = await store.readJsonl(PATHS.customerInteractions);
  assert(interactions.length === 1 && interactions[0].seq === 1, "jsonl round-trips");

  // --- list ---
  const all = await store.list();
  for (const p of Object.values(PATHS)) {
    if (p === PATHS.customerInteractions || p === PATHS.ticketsBug || p === PATHS.solutionDataset) {
      assert(all.includes(p), `list() must include appended file ${p}`);
    } else {
      assert(all.includes(p), `list() must include written file ${p}`);
    }
  }
  const customersOnly = await store.list("Customers");
  assert(
    customersOnly.length === 2 && customersOnly.every((p) => p.startsWith("Customers/")),
    "domain-prefixed list returns only that domain",
  );
  const boundary = await store.list("Customers/acme");
  assert(boundary.length === 0, "list uses directory-boundary prefix semantics");

  console.log(`seed   ok (${all.length} files across 7 domains)`);
}

async function phaseAppend() {
  const store = makeStore();

  // Lines appended by the SEED process must still be here (new process).
  const interactions = await store.readJsonl(PATHS.customerInteractions);
  assert(interactions.length === 1, "seed-process interaction line survived the process exit");
  assert(interactions[0].phase === "seed", "surviving line has seed content");
  const tickets = await store.readJsonl(PATHS.ticketsBug);
  assert(tickets.length === 1 && tickets[0].seq === 1, "seed-process ticket line survived");

  // Second-process appends.
  await store.appendJsonl(PATHS.customerInteractions, {
    interactionId: "int-2",
    seq: 2,
    phase: "append",
  });
  await store.appendJsonl(PATHS.ticketsBug, { ticketId: "TCK-1042", seq: 2, phase: "append" });
  await store.appendJsonl(PATHS.solutionDataset, { caseId: "case-2", input: "doc-b" });

  console.log("append ok (second process appended to seed-process files)");
}

async function phaseVerify() {
  const store = makeStore();

  // Both processes' lines must coexist, in append order.
  for (const [p, key] of [
    [PATHS.customerInteractions, "seq"],
    [PATHS.ticketsBug, "seq"],
  ]) {
    const rows = await store.readJsonl(p);
    assert(rows.length === 2, `${p}: expected 2 lines across 2 process invocations`);
    assert(rows[0][key] === 1 && rows[1][key] === 2, `${p}: append order preserved`);
    assert(rows[0].phase === "seed" && rows[1].phase === "append", `${p}: both processes' lines`);
  }
  const dataset = await store.readJsonl(PATHS.solutionDataset);
  assert(dataset.length === 2, "Solutions eval dataset accumulated across processes");

  // Raw content sanity: every jsonl line is newline-terminated, no joins.
  const raw = await store.read(PATHS.customerInteractions);
  assert(raw.endsWith("\n"), "jsonl file is newline-terminated");
  assert(raw.split("\n").filter(Boolean).length === 2, "no glued lines");

  const all = await store.list();
  assert(all.length === Object.keys(PATHS).length, "list() sees exactly the files we created");

  console.log("verify ok (jsonl lines durable across separate process invocations)");
}

const PHASES = { seed: phaseSeed, append: phaseAppend, verify: phaseVerify };

const phaseIndex = process.argv.indexOf("--phase");
if (phaseIndex !== -1) {
  const phase = PHASES[process.argv[phaseIndex + 1]];
  assert(phase, `unknown phase: ${process.argv[phaseIndex + 1]}`);
  await phase();
} else {
  // Orchestrator: fresh scratch root inside the gitignored .dataroom/ dir.
  const root = path.join(process.cwd(), ".dataroom", "__selftest__");
  rmSync(root, { recursive: true, force: true });

  const env = { ...process.env, DATAROOM_TEST_DIR: root };
  delete env.BLOB_READ_WRITE_TOKEN; // force the local backend even in prod-ish shells
  delete env.DATAROOM_DIR;

  for (const phase of ["seed", "append", "verify"]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SELF, "--phase", phase],
      { stdio: "inherit", env },
    );
    if (result.status !== 0) {
      console.error(`phase "${phase}" failed (exit ${result.status})`);
      process.exit(result.status ?? 1);
    }
  }
  console.log("dataroom-store round-trip ok (local backend, 3 separate processes)");
}
