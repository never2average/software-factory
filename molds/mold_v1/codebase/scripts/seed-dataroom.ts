// Seed migration — decompose data/sample/customers.json + people.json (the demo sample) into the
// dm.md data-room tree via the DataroomStore (local backend).
//
// dm.md at the repository root is the CANONICAL data model. This script does a
// one-time seed of the flat source JSON (whose canonical home is the per-domain
// Master.xlsx sheets) into the addressable dm.md folder tree, using ONLY the
// store's public API + the schema types. It is additive and idempotent: writes
// replace, appends are guarded so re-runs do not double-count interaction/ticket
// lines (each interactions.jsonl / tickets_{id}.jsonl is rebuilt, not appended
// blindly).
//
// What it populates (per the task + docs/data-model.md):
//   - {folder:accounts}/{cid}/interactions.jsonl   (every customer, even with 0 rows)
//   - {folder:accounts}/{cid}/context.md           (stub brief)
//   - {folder:accounts}/{cid}/agreements/README.md (agreements/ placeholder)
//   - {folder:people}/{person_id}/identity.json + context.md   (every people.json row)
//   - {folder:tickets}/{folder}/{cid}/{v1}/tickets_{id}.jsonl  (category -> folder map)
//   - platform / deployments / solutions / implementation rows landed at the
//     closest valid dm.md template under a single synthetic platform_version_id.
//
// Run: npm run seed:dataroom   (node --experimental-strip-types)

import { readFileSync } from "node:fs";
import {
  customerStoreSchema,
  interactionSchema,
  peopleStoreSchema,
  ticketSchema,
  type Customer,
} from "#lib/customer-schema.ts";
import {
  createLocalDataroomStore,
  defaultLocalDataroomRoot,
  type DataroomStore,
} from "#lib/dataroom-store.ts";
import { DEFAULT_ORG } from "#lib/org-context.ts";
import { workspaceDir } from "../lib/dataroom-keyspace.ts";
import {
  ticketCategorySchema,
  type TicketCategory,
} from "#lib/customer-schema.ts";
import type { TicketFolder } from "#lib/dataroom-schema.ts";
import { domainLabel, W } from "../lib/ui-words.ts";
import { FOLDER, pathPattern } from "../agent/lib/dataroom-folders.ts";

// What the report below calls each data-room folder: this deployment's label for it (lib/ui-words.ts). The paths
// written and counted are the stored ones.
const ROOM = { accounts: domainLabel("accounts"), platform: domainLabel("platform"), deployments: domainLabel("deliveries"), solutions: domainLabel("solutions"), implementation: domainLabel("projects"), tickets: domainLabel("tickets") };

// A single synthetic platform_version_id partitions every version-scoped path.
// The real platform_version_id spine is populated by a later iteration; this
// seed lands every row under one deterministic version so the tree is valid.
const PLATFORM_VERSION_ID = "v1";

// ---------------------------------------------------------------------------
// Load + validate source JSON against the canonical Zod contract
// ---------------------------------------------------------------------------

const customersUrl = new URL("../data/sample/customers.json", import.meta.url);
const peopleUrl = new URL("../data/sample/people.json", import.meta.url);

const customerStore = customerStoreSchema.parse(
  JSON.parse(readFileSync(customersUrl, "utf8")),
);
const peopleStore = peopleStoreSchema.parse(
  JSON.parse(readFileSync(peopleUrl, "utf8")),
);

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Folder-safe person id derived from the person's email (the join key). Two
 * people.json rows that share an email (e.g. one member assigned to two accounts)
 * collapse to a single {folder:people}/{person_id}/ folder.
 */
function personIdFromEmail(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/**
 * dm.md ticket storage folder, derived from the canonical `ticket_category`
 * (never the other way around) plus the ticket's subdomain signal (tags). See
 * "Ticket categories <-> dm.md ticket folders" in docs/data-model.md.
 */
function ticketFolderFor(category: TicketCategory, tags: readonly string[]): TicketFolder {
  const tag = new Set(tags.map((t) => t.toLowerCase()));
  switch (category) {
    case "Feature Request":
      if (tag.has("search") || tag.has("retrieval")) return "search";
      if (tag.has("docs") || tag.has("documentation")) return "docs";
      return "feat";
    case "Bug Report":
      return "bug";
    case "Data Migration Request":
      if (tag.has("backfill") || tag.has("backfills")) return "backfills";
      return "data_migration";
    case "Configuration Change Request":
      if (tag.has("onboarding") || tag.has("provisioning")) return "onboarding";
      return "config_changes";
    case "Workflow Customization Request":
      if (tag.has("eval") || tag.has("evals")) return "evals";
      return "config_changes";
    default: {
      // Exhaustiveness guard: a new category must be mapped here.
      const _never: never = category;
      throw new Error(`unmapped ticket_category: ${String(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface Counts {
  customers: number;
  interactionsFiles: number;
  interactionRecords: number;
  contextDocs: number;
  agreementsPlaceholders: number;
  platform: number;
  deployments: number;
  solutions: number;
  implementation: number;
  tickets: number;
  persons: number;
}

async function seedCustomer(store: DataroomStore, customer: Customer, counts: Counts): Promise<void> {
  const cid = customer.id;

  // --- {folder:accounts}/{cid}/interactions.jsonl (always present) ---
  const interactions = customer.interactions ?? [];
  const interactionsPath = `${FOLDER.accounts}/${cid}/interactions.jsonl`;
  if (interactions.length > 0) {
    // Rebuild the file so re-running the seed is idempotent (no double lines).
    await store.write(interactionsPath, "");
    counts.interactionRecords += await store.appendJsonl(
      interactionsPath,
      interactions,
      interactionSchema,
    );
  } else {
    await store.write(interactionsPath, "");
  }
  counts.interactionsFiles += 1;

  // --- {folder:accounts}/{cid}/context.md (stub brief) ---
  const contextLines = [
    `# ${customer.name} — ${W.account} context`,
    "",
    `- customer_id: \`${cid}\``,
    customer.lifecycleStage ? `- lifecycle_stage: ${customer.lifecycleStage}` : null,
    customer.status ? `- status: ${customer.status}` : null,
    customer.fdeOwner ? `- fde_owner: ${customer.fdeOwner}` : null,
    "",
    "_Seeded stub. Owned by the customer-context subagent; expand with the real brief._",
    "",
  ].filter((line): line is string => line !== null);
  await store.write(`${FOLDER.accounts}/${cid}/context.md`, `${contextLines.join("\n")}\n`);
  counts.contextDocs += 1;

  // --- {folder:accounts}/{cid}/agreements/ placeholder ---
  await store.write(
    `${FOLDER.accounts}/${cid}/agreements/README.md`,
    `# Agreements — ${customer.name}\n\nDrop executed contract binaries (MSA/DPA/SOW/Order Form) here.\n`,
  );
  counts.agreementsPlaceholders += 1;

  // --- platform row -> customer platform/tenant config under Deployments ---
  if (customer.platform) {
    await store.write(
      `${FOLDER.deliveries}/${cid}/${PLATFORM_VERSION_ID}/platform/organization.json`,
      `${JSON.stringify(customer.platform, null, 2)}\n`,
    );
    counts.platform += 1;
  }

  // --- deployment rows -> one JSON per deployment ---
  for (const deployment of customer.deployments ?? []) {
    await store.write(
      `${FOLDER.deliveries}/${cid}/${PLATFORM_VERSION_ID}/platform/pipelines/${deployment.deploymentId}/pipeline_config.json`,
      `${JSON.stringify(deployment, null, 2)}\n`,
    );
    counts.deployments += 1;
  }

  // --- solution rows -> one JSON per solution ---
  for (const solution of customer.solutions ?? []) {
    await store.write(
      `${FOLDER.solutions}/${PLATFORM_VERSION_ID}/pipelines/${solution.solutionId}/pipeline_config.json`,
      `${JSON.stringify(solution, null, 2)}\n`,
    );
    counts.solutions += 1;
  }

  // --- implementation row -> one JSON per customer rollout ---
  if (customer.implementation) {
    await store.write(
      `${FOLDER.projects}/${cid}/integromat.json`,
      `${JSON.stringify(customer.implementation, null, 2)}\n`,
    );
    counts.implementation += 1;
  }

  // --- ticket rows -> partitioned into dm.md category folders ---
  for (const ticket of customer.tickets ?? []) {
    const category = ticketCategorySchema.parse(ticket.ticketCategory);
    const folder = ticketFolderFor(category, ticket.tags ?? []);
    const path = `${FOLDER.tickets}/${folder}/${cid}/${PLATFORM_VERSION_ID}/tickets_${ticket.ticketId}.jsonl`;
    // Rebuild so re-runs stay idempotent (one row per ticket file).
    await store.write(path, "");
    counts.tickets += await store.appendJsonl(path, ticket, ticketSchema);
  }
}

interface AggregatedPerson {
  personId: string;
  kind: "internal" | "external";
  displayName: string;
  primaryEmail: string;
  employerOrg: string;
  title?: string;
  customerIds: Set<string>;
  roles: Set<string>;
}

function aggregatePeople(): Map<string, AggregatedPerson> {
  const byId = new Map<string, AggregatedPerson>();

  function add(
    email: string,
    kind: "internal" | "external",
    name: string,
    employerOrg: string,
    customerId: string,
    role: string,
    title?: string,
  ): void {
    const personId = personIdFromEmail(email);
    const existing = byId.get(personId);
    if (existing) {
      existing.customerIds.add(customerId);
      existing.roles.add(role);
      if (!existing.title && title) existing.title = title;
      return;
    }
    byId.set(personId, {
      personId,
      kind,
      displayName: name,
      primaryEmail: email,
      employerOrg,
      title,
      customerIds: new Set([customerId]),
      roles: new Set([role]),
    });
  }

  for (const staff of peopleStore.internalStaffAssignments) {
    add(staff.email, "internal", staff.name, staff.employerOrg, staff.customer_id, staff.staffRole, staff.title);
  }
  for (const stakeholder of peopleStore.customerStakeholders) {
    add(
      stakeholder.email,
      "external",
      stakeholder.name,
      stakeholder.employerOrg,
      stakeholder.customer_id,
      stakeholder.stakeholderRole,
      stakeholder.title,
    );
  }
  return byId;
}

async function seedPerson(store: DataroomStore, person: AggregatedPerson): Promise<void> {
  const customerIds = [...person.customerIds].sort();
  const identity = {
    personId: person.personId,
    kind: person.kind,
    displayName: person.displayName,
    primaryEmail: person.primaryEmail,
    emails: [person.primaryEmail],
    employerOrg: person.employerOrg,
    ...(person.title ? { title: person.title } : {}),
    customerIds,
  };
  await store.write(
    `${FOLDER.people}/${person.personId}/identity.json`,
    `${JSON.stringify(identity, null, 2)}\n`,
  );

  const contextLines = [
    `# ${person.displayName}`,
    "",
    `- person_id: \`${person.personId}\``,
    `- kind: ${person.kind}`,
    `- employer_org: ${person.employerOrg}`,
    person.title ? `- title: ${person.title}` : null,
    `- roles: ${[...person.roles].sort().join(", ")}`,
    `- ${W.accounts}: ${customerIds.join(", ")}`,
    `- primary_email: ${person.primaryEmail}`,
    "",
    "_Seeded stub. Owned by the research subagent; expand with the real brief._",
    "",
  ].filter((line): line is string => line !== null);
  await store.write(`${FOLDER.people}/${person.personId}/context.md`, `${contextLines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Verify (via the store's public list()) that landed counts match source
// ---------------------------------------------------------------------------

async function verify(store: DataroomStore, counts: Counts, sourcePeopleRows: number): Promise<void> {
  const all = await store.list();
  const count = (pred: (p: string) => boolean) => all.filter(pred).length;

  const checks: Array<[string, number, number]> = [
    [`${ROOM.accounts} interactions.jsonl`, counts.interactionsFiles, count((p) => pathPattern("accounts", "[^/]+/interactions\\.jsonl").test(p))],
    [`${ROOM.accounts} context.md`, counts.contextDocs, count((p) => pathPattern("accounts", "[^/]+/context\\.md").test(p))],
    [`${ROOM.accounts} agreements/`, counts.agreementsPlaceholders, count((p) => p.split("/")[0] === FOLDER.accounts && p.split("/")[2] === "agreements" && p.split("/").length > 3)],
    [`${ROOM.platform} rows`, counts.platform, count((p) => pathPattern("deliveries", "[^/]+/[^/]+/platform/organization\\.json").test(p))],
    [`${ROOM.deployments} rows`, counts.deployments, count((p) => pathPattern("deliveries", "[^/]+/[^/]+/platform/pipelines/[^/]+/pipeline_config\\.json").test(p))],
    [`${ROOM.solutions} rows`, counts.solutions, count((p) => pathPattern("solutions", "[^/]+/pipelines/[^/]+/pipeline_config\\.json").test(p))],
    [`${ROOM.implementation} rows`, counts.implementation, count((p) => pathPattern("projects", "[^/]+/integromat\\.json").test(p))],
    [`${ROOM.tickets} rows`, counts.tickets, count((p) => pathPattern("tickets", "[^/]+/[^/]+/[^/]+/tickets_.+\\.jsonl").test(p))],
    ["Person identity.json", counts.persons, count((p) => pathPattern("people", "[^/]+/identity\\.json").test(p))],
    ["Person context.md", counts.persons, count((p) => pathPattern("people", "[^/]+/context\\.md").test(p))],
  ];

  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new Error(`verify failed: ${label} expected ${expected} file(s), store has ${actual}`);
    }
  }

  // Every customer must have interactions.jsonl + context.md.
  for (const customer of customerStore.customers) {
    if (!all.includes(`${FOLDER.accounts}/${customer.id}/interactions.jsonl`)) {
      throw new Error(`verify failed: ${customer.id} missing interactions.jsonl`);
    }
    if (!all.includes(`${FOLDER.accounts}/${customer.id}/context.md`)) {
      throw new Error(`verify failed: ${customer.id} missing context.md`);
    }
  }

  // Every people.json row must resolve to a {folder:people}/{person_id}/ folder.
  const seenPersonIds = new Set(
    all
      .map((p) => pathPattern("people", "([^/]+)/identity\\.json").exec(p)?.[1])
      .filter((id): id is string => id !== undefined),
  );
  const allRows = [...peopleStore.internalStaffAssignments, ...peopleStore.customerStakeholders];
  for (const row of allRows) {
    if (!seenPersonIds.has(personIdFromEmail(row.email))) {
      throw new Error(`verify failed: people.json row (${row.email}) has no ${FOLDER.people}/ folder`);
    }
  }
  if (allRows.length !== sourcePeopleRows) {
    throw new Error("verify failed: people row count drift");
  }
}

function printSummary(counts: Counts, sourcePeopleRows: number): void {
  const rows: Array<[string, number, number]> = [
    [`${ROOM.accounts} (interactions.jsonl)`, customerStore.customers.length, counts.interactionsFiles],
    ["  interaction records", totalInteractions(), counts.interactionRecords],
    [`${ROOM.accounts} (context.md)`, customerStore.customers.length, counts.contextDocs],
    [`${ROOM.accounts} (agreements/)`, customerStore.customers.length, counts.agreementsPlaceholders],
    [ROOM.platform, totalPlatform(), counts.platform],
    [ROOM.deployments, totalDeployments(), counts.deployments],
    [ROOM.solutions, totalSolutions(), counts.solutions],
    [ROOM.implementation, totalImplementation(), counts.implementation],
    [ROOM.tickets, totalTickets(), counts.tickets],
    // People rows dedupe by email into unique {folder:people}/ folders, so the fair
    // comparison is unique-persons vs folders written (see note printed below).
    ["Person (unique persons)", counts.persons, counts.persons],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length), "Domain".length);
  const pad = (s: string, w: number) => s.padEnd(w);
  const padNum = (n: number) => String(n).padStart(6);

  console.log("");
  console.log(`${pad("Domain", labelWidth)}  ${"source".padStart(6)}  ${"landed".padStart(6)}`);
  console.log(`${"-".repeat(labelWidth)}  ${"-".repeat(6)}  ${"-".repeat(6)}`);
  for (const [label, source, landed] of rows) {
    const flag = source === landed ? "" : "  <-- MISMATCH";
    console.log(`${pad(label, labelWidth)}  ${padNum(source)}  ${padNum(landed)}${flag}`);
  }
  console.log("");
  console.log(
    `note: ${sourcePeopleRows} people.json rows deduped by email into ${counts.persons} unique ${FOLDER.people}/ folders.`,
  );
  console.log("");
}

function totalInteractions(): number {
  return customerStore.customers.reduce((n, c) => n + (c.interactions?.length ?? 0), 0);
}
function totalPlatform(): number {
  return customerStore.customers.reduce((n, c) => n + (c.platform ? 1 : 0), 0);
}
function totalDeployments(): number {
  return customerStore.customers.reduce((n, c) => n + (c.deployments?.length ?? 0), 0);
}
function totalSolutions(): number {
  return customerStore.customers.reduce((n, c) => n + (c.solutions?.length ?? 0), 0);
}
function totalImplementation(): number {
  return customerStore.customers.reduce((n, c) => n + (c.implementation ? 1 : 0), 0);
}
function totalTickets(): number {
  return customerStore.customers.reduce((n, c) => n + (c.tickets?.length ?? 0), 0);
}

async function main(): Promise<void> {
  // The local workspace's own tree (`.dataroom/orgs/<id>/`), which is where the local agent and web app read it:
  // there is no root-level data room any more (lib/dataroom-keyspace.ts). SEED_ORG picks another workspace.
  const org = process.env.SEED_ORG?.trim() || DEFAULT_ORG;
  const store = createLocalDataroomStore([defaultLocalDataroomRoot(), ...workspaceDir(org).split("/")].join("/"));
  if (store.backend.kind !== "local") {
    throw new Error("seed:dataroom must run against the local backend");
  }

  const counts: Counts = {
    customers: customerStore.customers.length,
    interactionsFiles: 0,
    interactionRecords: 0,
    contextDocs: 0,
    agreementsPlaceholders: 0,
    platform: 0,
    deployments: 0,
    solutions: 0,
    implementation: 0,
    tickets: 0,
    persons: 0,
  };

  for (const customer of customerStore.customers) {
    await seedCustomer(store, customer, counts);
  }

  const people = aggregatePeople();
  for (const person of people.values()) {
    await seedPerson(store, person);
    counts.persons += 1;
  }

  const sourcePeopleRows =
    peopleStore.internalStaffAssignments.length + peopleStore.customerStakeholders.length;

  await verify(store, counts, sourcePeopleRows);
  printSummary(counts, sourcePeopleRows);

  console.log(
    `seed:dataroom ok — populated ${store.backend.kind} store at ${(store.backend as { rootDir?: string }).rootDir ?? "(unknown root)"}`,
  );
}

await main();
