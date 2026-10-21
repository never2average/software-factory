/**
 * A RECORD'S WORKFLOW, READ AND CHANGED BY A PERSON (phase 7 of the workflow engine, docs/WORKFLOW_ENGINE.md
 * "Surfaces"): the doors the ops API (app/api/ops/record-workflow/**) and the agent's tools
 * (agent/lib/record-workflow-tools.ts) share. Each runs in the caller's workspace-scoped transaction (`withOrgRls`,
 * `withOrgDb`):
 *
 *   readWorkflowDoor     who holds the next step and when it is due, every step, the step timeline; what this reader may
 *                        change (who a supervisor may put on each step, which steps' due date extends). Under the
 *                        record's workflow lock, re-synced and saved when the record moved without the engine.
 *   changeStepDoor       a step's holders (supervisors only, the step rules' checkReassign) or its due date (the one-time
 *                        bounded extension, checkDueOnChange): the rule's refusal with its status, or the change saved.
 *   nextStepsDoor        the cards' line for many records at once: the next step, its holders, its due date.
 *
 * People are shown as the reader may see them (lib/record-workflow-view.ts): an owner or an admin reads emails, anyone
 * else names on the roster. A record is found by the reference the screens and the model hold (its id, and for a
 * deployment its account), only in the caller's workspace; another workspace's record is "not found".
 *
 * Server-only (it reads the schema).
 */
import { and, eq } from "drizzle-orm";
import { cycles, deployments, implementation } from "../agent/lib/db/schema.ts";
import { storedTask } from "../agent/lib/record-lifecycle-store.ts";
import { periodRow } from "../agent/lib/period-area.ts";
import { implementationKey } from "../agent/lib/implementation-ids.ts";
import { areaView, type AreaRow, type RecordAreas } from "../agent/lib/record-areas.ts";
import { RECORD_AREAS, type RecordAreaId } from "../agent/lib/record-areas.generated.ts";
import { storedStateOf } from "../agent/lib/record-lifecycle.ts";
import {
  changeRecordStep,
  lockedRead,
  readRecordWorkflow,
  recordWorkflowBound,
  recordWorkflowSummaries,
  stepOptions,
  workflowRecordKey,
  type ScopedDb,
  type StepActionRunner,
  type StepChangeRequest,
} from "./record-workflow-moves.ts";
import { nextStepSummary, personShown, workflowView, type NextStepSummary, type PersonShown, type ViewReader, type WorkflowView } from "./record-workflow-view.ts";

/** How the screens and the model name a record: its id (a deployment's, a task's, ...) and, for a deployment, its account. */
export interface RecordRef {
  id: string;
  customerId?: string | null;
}

export interface Reader {
  email: string;
  /** The reader's role in the workspace (owner and admin read emails). */
  role: string | null | undefined;
}

const privilegedRole = (role: string | null | undefined) => role === "owner" || role === "admin";

/**
 * The record a reference names, in this workspace, as the rules read it; null when there is none. `locked` (a read that
 * may save, a change): under its workflow lock, taken before the record is read (lockedRead). The cards' lines read
 * without it (they write nothing), so a page of cards never holds a lock per record.
 */
async function boundRecord(tx: ScopedDb, orgId: string, areaId: RecordAreaId, ref: RecordRef, locked = true): Promise<{ row: AreaRow; key: string; feedId: string } | null> {
  const id = String(ref.id ?? "").trim();
  if (!id) return null;
  const read = async (): Promise<AreaRow | null> => {
    if (areaId === "deployments") {
      if (!ref.customerId) return null;
      const [row] = await tx.select().from(deployments).where(and(eq(deployments.orgId, orgId), eq(deployments.customerId, ref.customerId), eq(deployments.deploymentId, id))).limit(1);
      return (row as AreaRow | undefined) ?? null;
    }
    if (areaId === "implementations") {
      const [own] = await tx.select().from(implementation).where(and(eq(implementation.orgId, orgId), eq(implementation.implementationId, id))).limit(1);
      if (own) return own as AreaRow;
      if (!ref.customerId) return null;
      // An account's one implementation, named by the account: only when it has exactly one (with two or more, which
      // one is meant is not known, and none is guessed).
      const some = await tx.select().from(implementation).where(and(eq(implementation.orgId, orgId), eq(implementation.customerId, ref.customerId))).limit(2);
      return some.length === 1 ? (some[0] as AreaRow) : null;
    }
    if (areaId === "tasks") return storedTask(tx as never, orgId, id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const [row] = await tx.select().from(cycles).where(and(eq(cycles.orgId, orgId), eq(cycles.id, id))).limit(1);
    return row ? periodRow(row as unknown as Record<string, unknown>) : null;
  };
  const { row, key } = locked ? await lockedRead(tx, orgId, areaId, read) : await unlockedRead(areaId, read);
  if (!row || !key) return null;
  const feedId = areaId === "deployments" ? String(row.deploymentId) : areaId === "implementations" ? implementationKey(row) : String(row.id);
  return { row, key, feedId };
}

async function unlockedRead(areaId: RecordAreaId, read: () => Promise<AreaRow | null>): Promise<{ row: AreaRow | null; key: string | null }> {
  const row = await read();
  return { row, key: workflowRecordKey(areaId, row) };
}

/** What a reader may change on the record's workflow (only what the rules would let them). */
export interface WorkflowOptions {
  /** Supervisors (owners and admins): who they may put on each step. */
  holders?: Record<string, PersonShown[]>;
  /** The steps whose due date the reader may extend (the template declares the extension). */
  extends: string[];
}

export type DoorAnswer<T> = { status: 200; body: T } | { status: 403 | 404 | 409 | 422; body: { error: string; errors: string[]; code?: string } };

const notFound = (noun: string) => ({ status: 404 as const, body: { error: `No such ${noun} here.`, errors: [`No such ${noun} here.`] } });
const noWorkflow = (noun: string) => ({ status: 422 as const, body: { error: `This ${noun} runs no workflow.`, errors: [`This ${noun} runs no workflow.`], code: "no_workflow" } });

/** The record's workflow as the reader may read it, and what they may change. */
export async function readWorkflowDoor(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  ref: RecordRef,
  reader: Reader,
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown>; now?: Date; deliver?: StepActionRunner } = {},
): Promise<DoorAnswer<{ area: RecordAreaId; key: string; noun: string; workflow: WorkflowView; options: WorkflowOptions }>> {
  const areas = opts.areas ?? RECORD_AREAS;
  const noun = areaView(areaId, areas).noun;
  if (!recordWorkflowBound(areaId, areas, opts.workflows)) return noWorkflow(noun);
  const found = await boundRecord(tx, orgId, areaId, ref);
  if (!found) return notFound(noun);
  const read = await readRecordWorkflow(tx, orgId, areaId, { entityId: found.key, feedId: found.feedId, before: found.row, actor: reader.email, now: opts.now, deliver: opts.deliver }, opts);
  if (!read) return noWorkflow(noun);
  const privileged = privilegedRole(reader.role);
  const nameOf = (id: string) => {
    const n = read.session.directory.get(id, orgId)?.name;
    return typeof n === "string" ? n : null;
  };
  const viewReader: ViewReader = { privileged, nameOf, now: opts.now };
  const options = stepOptions(read.session, read.instance);
  return {
    status: 200,
    body: {
      area: areaId,
      key: found.key,
      noun,
      workflow: workflowView(read.instance, viewReader),
      options: {
        ...(privileged ? { holders: Object.fromEntries(Object.entries(options.holders).map(([s, ids]) => [s, ids.map((id) => personShown(id, viewReader))])) } : {}),
        extends: options.extends,
      },
    },
  };
}

/** Change a step's holders or its due date for the record a reference names; the step rule's refusal, or the new view. */
export async function changeStepDoor(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  ref: RecordRef,
  reader: Reader,
  change: StepChangeRequest,
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown>; now?: Date; deliver?: StepActionRunner } = {},
): Promise<DoorAnswer<{ changed: boolean; workflow: WorkflowView }>> {
  const areas = opts.areas ?? RECORD_AREAS;
  const noun = areaView(areaId, areas).noun;
  if (!recordWorkflowBound(areaId, areas, opts.workflows)) return noWorkflow(noun);
  const found = await boundRecord(tx, orgId, areaId, ref);
  if (!found) return notFound(noun);
  const { result, instance } = await changeRecordStep(tx, orgId, areaId, { entityId: found.key, feedId: found.feedId, before: found.row, actor: reader.email, change, deliver: opts.deliver, now: opts.now }, opts);
  if (!result.ok) return { status: result.status, body: { error: result.message, errors: [result.message], code: result.code } };
  const read = await readRecordWorkflow(tx, orgId, areaId, { entityId: found.key, feedId: found.feedId, before: found.row, actor: reader.email, now: opts.now, deliver: opts.deliver }, opts);
  const nameOf = (id: string) => {
    const n = read?.session.directory.get(id, orgId)?.name;
    return typeof n === "string" ? n : null;
  };
  return { status: 200, body: { changed: result.changed, workflow: workflowView(read?.instance ?? instance!, { privileged: privilegedRole(reader.role), nameOf, now: opts.now }) } };
}

/**
 * The cards' line for each reference, in the order given (`next` null for a record not found here, or that its workflow
 * does not apply to), as the reader may read it. At most 100 at once. Read only: no record's workflow lock is taken
 * and nothing is saved (a record moved without the engine is shown re-synced in memory).
 */
export async function nextStepsDoor(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  refs: RecordRef[],
  reader: Reader,
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown>; now?: Date } = {},
): Promise<{ id: string; customerId: string | null; next: NextStepSummary | null }[]> {
  const areas = opts.areas ?? RECORD_AREAS;
  if (!recordWorkflowBound(areaId, areas, opts.workflows)) return [];
  const v = areaView(areaId, areas);
  const found: { ref: RecordRef; key: string | null; state: string | null; row: AreaRow | null }[] = [];
  for (const ref of refs.slice(0, 100)) {
    const r = await boundRecord(tx, orgId, areaId, ref, false);
    found.push({ ref, key: r?.key ?? null, state: r ? storedStateOf(v, r.row) : null, row: r?.row ?? null });
  }
  const keyed = found.filter((f): f is { ref: RecordRef; key: string; state: string | null; row: AreaRow | null } => f.key !== null);
  const read = await recordWorkflowSummaries(tx, orgId, areaId, keyed.map((f) => ({ key: f.key, state: f.state, row: f.row })), opts);
  const reader2: ViewReader = {
    privileged: privilegedRole(reader.role),
    nameOf: (id) => {
      const n = read?.directory.get(id, orgId)?.name;
      return typeof n === "string" ? n : null;
    },
    now: opts.now,
  };
  return found.map((f) => {
    const instance = f.key ? read?.instances.get(f.key) : undefined;
    return { id: String(f.ref.id), customerId: f.ref.customerId ?? null, next: instance ? nextStepSummary(instance, reader2) : null };
  });
}

export { workflowRecordKey };
