// Folder-level context graph — the projection of dm.md onto a single folder.
//
// The canonical spec is DATAROOM_PATH_TEMPLATES (the dm.md grammar in
// dataroom-store.ts). Rather than hand-author what each folder must contain,
// we DERIVE it: for a concrete folder path, find the templates that live under
// it and read off the expected immediate children. Add live edges (a customer's
// deployments, implementation, tickets, stakeholders) as [[wikilinks]] — the same
// link vocabulary the memory system uses — and you have a graph, not just a tree.
import { DATAROOM_PATH_TEMPLATES } from "../../../agent/lib/dataroom-store.ts";
import { deployments, implementation, tickets, customerStakeholders } from "../../../agent/lib/db/schema.ts";
import { withOrgDb } from "../../../agent/lib/db/index.ts";
import { and, eq } from "drizzle-orm";

const isToken = (seg) => /^\{[a-z_]+\}$/.test(seg);

/**
 * The immediate children dm.md expects directly under `folderPath`, derived from
 * the templates. Returns { requiredFiles, requiredDirs, instanceSlots, openDirs }.
 *  - requiredFiles: literal files that must exist here (context.md, …)
 *  - requiredDirs:  literal subfolders (agreements, signoff, …)
 *  - instanceSlots: token children — where instances live ({customer_id}, …)
 *  - openDirs:      `**` children — arbitrary files allowed
 */
export function folderRequirements(folderPath) {
  const segs = folderPath.split("/").filter(Boolean);
  const depth = segs.length;
  const requiredFiles = new Set();
  const requiredDirs = new Set();
  const instanceSlots = new Set();
  let openDirs = false;

  for (const template of DATAROOM_PATH_TEMPLATES) {
    const t = template.split("/");
    if (t.length <= depth) continue;
    // The template's first `depth` segments must be compatible with this folder:
    // a token matches anything, a literal must equal.
    let matches = true;
    for (let i = 0; i < depth; i++) {
      if (isToken(t[i]) || t[i] === "**") continue;
      if (t[i] !== segs[i]) { matches = false; break; }
    }
    if (!matches) continue;

    const child = t[depth];
    const isLastSegment = t.length === depth + 1;
    if (child === "**") openDirs = true;
    else if (isToken(child)) instanceSlots.add(child);
    else if (isLastSegment && child.includes(".")) requiredFiles.add(child);
    else requiredDirs.add(child);
  }
  return {
    requiredFiles: [...requiredFiles].sort(),
    requiredDirs: [...requiredDirs].sort(),
    instanceSlots: [...instanceSlots].sort(),
    openDirs,
  };
}

/** Immediate child names present under `folderPath` in the live store. */
async function presentChildren(store, folderPath) {
  const paths = await store.list(folderPath);
  const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
  const files = new Set();
  const dirs = new Set();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length).split("/");
    if (rest.length === 1) files.add(rest[0]);
    else dirs.add(rest[0]);
  }
  return { files: [...files], dirs: [...dirs] };
}

/**
 * Live cross-folder edges for a customer node (DB-derived), as [[wikilinks]]: the workspace's own company, by its
 * whole key (org_id, customer_id), read inside the workspace's scope. Without a workspace there are no DB edges: the
 * same id may be two companies in two workspaces (mold_v1-118).
 */
async function customerEdges(db, orgId, customerId) {
  if (!db || !orgId) return [];
  const edges = [];
  const [deps, impl, tks, stk] = await withOrgDb(orgId, (tx) =>
    Promise.all([
      tx.select({ v: deployments.deploymentId }).from(deployments).where(and(eq(deployments.orgId, orgId), eq(deployments.customerId, customerId))),
      tx.select({ c: implementation.customerId }).from(implementation).where(and(eq(implementation.orgId, orgId), eq(implementation.customerId, customerId))),
      tx.select({ id: tickets.ticketId, type: tickets.ticketType }).from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.customerId, customerId))),
      tx.select({ e: customerStakeholders.email }).from(customerStakeholders).where(and(eq(customerStakeholders.orgId, orgId), eq(customerStakeholders.customerId, customerId))),
    ]),
  );
  for (const d of deps) edges.push(`[[Deployments/${customerId}/${d.v}]]`);
  if (impl.length) edges.push(`[[Implementation/${customerId}]]`);
  for (const t of tks) edges.push(`[[Tickets/${t.type ?? "feat"}/${customerId}]]`);
  for (const s of stk) edges.push(`[[person:${s.e}]]`);
  return edges;
}

/**
 * The full context graph for a folder: what it must contain (from dm.md), what it
 * actually contains, what's missing, and its live edges. Pure data — a caller
 * prints it, writes it, or validates against it (fde:doctor).
 */
export async function buildContextGraph(store, db, folderPath, stampIso, orgId) {
  const req = folderRequirements(folderPath);
  const present = await presentChildren(store, folderPath);
  const missingFiles = req.requiredFiles.filter((f) => !present.files.includes(f));
  const missingDirs = req.requiredDirs.filter((d) => !present.dirs.includes(d));

  // Edges: customer nodes (Customers/{id}) get live DB relations.
  const segs = folderPath.split("/").filter(Boolean);
  let edges = [];
  if (segs.length === 2 && segs[0] === "Customers") {
    edges = await customerEdges(db, orgId, segs[1]);
  }

  return {
    path: folderPath,
    generatedAt: stampIso ?? null,
    requires: { files: req.requiredFiles, dirs: req.requiredDirs, instanceSlots: req.instanceSlots, openFiles: req.openDirs },
    present,
    missing: { files: missingFiles, dirs: missingDirs },
    edges,
    ok: missingFiles.length === 0 && missingDirs.length === 0,
  };
}
