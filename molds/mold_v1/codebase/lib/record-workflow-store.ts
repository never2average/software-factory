/**
 * A RECORD'S WORKFLOW, STORED IN POSTGRES (phase 3 of the workflow engine, docs/WORKFLOW_ENGINE.md "Storage").
 *
 * The engine's `WorkflowStore` interface (lib/workflow-engine/engine/src/core/store.ts) over two per-workspace tables,
 * `record_workflow_instances` and `record_workflow_events` (drizzle/0047, agent/lib/db/schema.ts). The record write
 * path calls it (phase 5, lib/record-workflow-moves.ts), in the transaction the record is written in.
 *
 * ONE STORE IS ONE WORKSPACE, INSIDE ITS SCOPE. It is made with the handle of the caller's workspace-scoped
 * transaction (`withOrgRls` in the web app, `withOrgDb` in the agent) and that workspace's id, and every statement runs
 * on that handle, so row-level security applies to every read and write. Its first statement checks that the
 * transaction's `app.org_id` is the workspace it was made for, and refuses to go on otherwise
 * (`RecordWorkflowScopeError`): a store handed the bare pool, or another workspace's transaction, does nothing. Every
 * statement also names the workspace itself. A method that takes an organization id (the engine's interface) answers
 * nothing for any other workspace.
 *
 * WHAT A ROW HOLDS. The instance's own state (steps, `fired_once`, `terminal`, the rest of the engine's fields in
 * `engine_state`), the PINNED copy of the workflow document it was made from and that document's hash, and a revision.
 * Its history is the events table, one row per `HistoryEvent`, append-only, read back in the order it was appended.
 * The record's own values are NOT stored: the record is their one home. A read gives `object.data` and `task` as `{}`;
 * the caller puts the record's current values there before running the engine (`withRecordData`).
 *
 * REVISIONS. A write names the revision it read (`instance.revision`); a stale one changes nothing and is a
 * `RecordWorkflowConflict` (`status` 409, the engine's `PersistenceConflictError` with code `STALE_REVISION`). The
 * store's own methods (`create`, `update`) RETURN the conflict; the engine's `saveInstance` throws it, as the engine's
 * own stores do. Neither ever aborts the caller's transaction: a conflict is found without a failed statement
 * (`ON CONFLICT DO NOTHING`, an UPDATE that matches no row). Appending an event is a change to the instance too, so it
 * moves the revision on: a writer holding an instance read before it is refused, never silently drops the event.
 *
 * PINNED DEFINITIONS. An instance's `definition_version` is keyed by its pinned document's hash
 * (`definitionVersionOf`), and the engine's `getWorkflowVersion` answers it with that pinned copy, so an old instance
 * never runs on rules a later build changed; `getWorkflow` is the deployment's current document, for new instances.
 *
 * HISTORY IS AN AUDIT TRAIL. app_rw may only read and add events (scripts/lib/append-only-tables.mjs), and an instance
 * with a history cannot be deleted (the foreign key restricts). An instance outlives its record; phase 5 marks one
 * terminal or detached, never deletes it. An instance read without its history (a list's summary) cannot be saved
 * over it: `update` compares before writing anything (`history_mismatch`).
 *
 * NOT HELD HERE. Registering, changing or deleting a workflow definition throws `RecordWorkflowNotSupported`
 * (definitions change only through the build: the profile's `records.workflows`, passed in as `definitions`), as do
 * storing an identity snapshot, callbacks and job leases (none in this phase). `getIdentitySnapshot` answers undefined:
 * the directory is the workspace's people data (phase 4), handed to the engine by the write path (phase 5).
 * `reassignObjectScope` matches nothing: the record holds its own fields and the workflow reads them from it.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { recordWorkflowEvents, recordWorkflowInstances } from "../agent/lib/db/schema.ts";
import type { WorkflowDSL } from "./workflow-engine/dsl/types.ts";
import type { HistoryEvent, RegisteredWorkflow, StepState, WorkflowInstance } from "./workflow-engine/engine/src/core/state.ts";
import {
  PersistenceConflictError,
  type CallbackClaim,
  type JobCheckpoint,
  type ObjectScope,
  type WorkflowStore,
} from "./workflow-engine/engine/src/core/store.ts";
import { projectSummaryFields } from "./workflow-engine/engine/src/core/summary.ts";
import type { IdentitySnapshot } from "./workflow-engine/engine/src/integrations/identity.ts";

/** The handle of a workspace-scoped transaction: what `withOrgRls` and `withOrgDb` pass their callback. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScopedDb = Pick<PostgresJsDatabase<any>, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * Why a write was refused: it read a revision that is no longer current, the instance is not there, the record already
 * runs that workflow, or it carries less history than is stored (an instance read without its history, such as a
 * list's summary, can never be saved over it).
 */
export type RecordWorkflowConflictReason = "stale_revision" | "missing" | "attached" | "history_mismatch";

/**
 * A refused write, for the route to answer 409. The engine's own conflict type (so engine code that catches
 * `PersistenceConflictError` catches this), with what the caller needs to say why.
 */
export class RecordWorkflowConflict extends PersistenceConflictError {
  readonly status = 409 as const;
  readonly reason: RecordWorkflowConflictReason;
  readonly instanceId: string;
  /** The revision the write named. */
  readonly expected: number;
  /** The revision stored now (undefined when there is no such instance). */
  readonly current: number | undefined;
  constructor(reason: RecordWorkflowConflictReason, instanceId: string, expected: number, current: number | undefined, message: string) {
    super(message, reason === "attached" || reason === "history_mismatch" ? "CONFLICT" : "STALE_REVISION");
    this.name = "RecordWorkflowConflict";
    this.reason = reason;
    this.instanceId = instanceId;
    this.expected = expected;
    this.current = current;
  }
}

export const isRecordWorkflowConflict = (e: unknown): e is RecordWorkflowConflict => e instanceof RecordWorkflowConflict;

/** A part of the engine's store interface this store does not carry (see the header). */
export class RecordWorkflowNotSupported extends Error {
  constructor(what: string, why: string) {
    super(`record workflow store: ${what} is not supported (${why})`);
    this.name = "RecordWorkflowNotSupported";
  }
}

/** The store was handed a handle that is not its workspace's scoped transaction. */
export class RecordWorkflowScopeError extends Error {
  constructor(orgId: string, scoped: string | null) {
    super(
      scoped
        ? `record workflow store: made for workspace "${orgId}" but the transaction is scoped to another workspace; nothing was read or written`
        : `record workflow store: made for workspace "${orgId}" but the transaction names no workspace (use withOrgRls / withOrgDb); nothing was read or written`,
    );
    this.name = "RecordWorkflowScopeError";
  }
}

export type WriteResult = { ok: true; instance: WorkflowInstance } | { ok: false; conflict: RecordWorkflowConflict };

/** A stored history event: the engine's event, with its row id (append order) and its instance. */
export type RecordWorkflowEvent = HistoryEvent & { id: number; instance_id: string };

/** A workflow's pinned definition, as the instance was made from it. */
export interface PinnedDefinition {
  workflow_id: string;
  definition: WorkflowDSL;
  definition_hash: string;
}

/** JSON with every object's keys sorted, so equal documents hash equally whatever order their keys were written in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The hash a pinned definition is stored under: sha256 over its canonical JSON, hex. */
export function definitionHash(definition: WorkflowDSL): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

/**
 * The engine's `definition_version` for a pinned definition: a number keyed by its hash (the first 48 bits, plus one),
 * so each distinct document a workflow ever ran under has its own version, the same in every process, with no counter
 * to race on. `getWorkflowVersion` answers it with the pinned copy, so an old instance never runs on new rules.
 */
export function definitionVersionOf(hash: string): number {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`record workflow store: not a definition hash: ${JSON.stringify(hash)}`);
  return Number.parseInt(hash.slice(0, 12), 16) + 1;
}

/** The hash prefix a version stands for (the inverse of `definitionVersionOf`), or null for a number that is none. */
function hashPrefixOf(version: number): string | null {
  if (!Number.isSafeInteger(version) || version < 1 || version > 2 ** 48) return null;
  return (version - 1).toString(16).padStart(12, "0");
}

/** The instance with the record's current values as its object data (the engine reads `object.data` and `task`). */
export function withRecordData(instance: WorkflowInstance, data: Record<string, unknown>): WorkflowInstance {
  return { ...instance, object: { ...instance.object, data }, task: data };
}

/** The instance fields that are columns (or the history table, or the record); everything else is `engine_state`. */
const COLUMN_FIELDS = new Set([
  "id", "organization_id", "workflow_id", "revision", "object", "task", "steps", "terminal", "fired_once", "history",
  "created_at", "updated_at",
]);

export type InstanceRow = typeof recordWorkflowInstances.$inferSelect;
export type EventRow = typeof recordWorkflowEvents.$inferSelect;

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const toDate = (value: string, what: string): Date => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`record workflow store: ${what} is not a time: ${JSON.stringify(value)}`);
  return d;
};
const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : ((result as { rows?: T[] } | null)?.rows ?? [])) as T[];

function engineStateOf(instance: WorkflowInstance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(instance)) {
    if (!COLUMN_FIELDS.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

/** The row an engine history event is stored as. */
export function eventValues(orgId: string, instanceId: string, event: HistoryEvent) {
  return {
    orgId,
    instanceId,
    at: toDate(event.at, "an event's time"),
    type: event.type,
    stepId: event.step_id ?? null,
    actor: event.actor ?? null,
    source: event.source ?? null,
    detail: event.detail ?? null,
    originInstanceId: event.origin_instance_id ?? null,
    data: event.data ?? null,
  };
}

/** A stored event as the engine's event, with its row id and instance. */
export function eventFromRow(row: EventRow): RecordWorkflowEvent {
  const event: RecordWorkflowEvent = { id: Number(row.id), instance_id: row.instanceId, at: iso(row.at), type: row.type as HistoryEvent["type"] };
  if (row.stepId !== null) event.step_id = row.stepId;
  if (row.detail !== null) event.detail = row.detail;
  if (row.data !== null) event.data = row.data;
  if (row.actor !== null) event.actor = row.actor;
  if (row.source !== null) event.source = row.source as HistoryEvent["source"];
  if (row.originInstanceId !== null) event.origin_instance_id = row.originInstanceId;
  return event;
}

/** The engine's event, without the row's own id and instance (what `instance.history` holds). */
function historyOf(event: RecordWorkflowEvent): HistoryEvent {
  const { id: _id, instance_id: _instance, ...rest } = event;
  return rest;
}

/** The row a new instance is stored as (revision 1), with its pinned definition. */
export function instanceRowValues(orgId: string, instance: WorkflowInstance, definition: WorkflowDSL) {
  const hash = definitionHash(definition);
  return {
    orgId,
    id: instance.id,
    entityType: instance.object.type,
    entityId: instance.object.id,
    workflowId: instance.workflow_id,
    definitionHash: hash,
    definition: definition as unknown as Record<string, unknown>,
    steps: instance.steps as unknown as Record<string, unknown>[],
    revision: 1,
    terminal: instance.terminal ?? null,
    firedOnce: instance.fired_once ?? [],
    // The version is the pinned document's, whatever the caller's instance said.
    engineState: { ...engineStateOf(instance), definition_version: definitionVersionOf(hash) },
    createdAt: toDate(instance.created_at, "created_at"),
    updatedAt: toDate(instance.updated_at, "updated_at"),
  };
}

/** A stored row as the engine's instance, with `history`; `object.data` and `task` are `{}` (see `withRecordData`). */
export function instanceFromRow(row: InstanceRow, history: HistoryEvent[]): WorkflowInstance {
  const state = (row.engineState ?? {}) as Record<string, unknown>;
  const instance = {
    ...state,
    id: row.id,
    organization_id: row.orgId,
    workflow_id: row.workflowId,
    definition_version: typeof state.definition_version === "number" ? state.definition_version : 1,
    revision: row.revision,
    object: { type: row.entityType, id: row.entityId, data: {} },
    task: {},
    start_id: typeof state.start_id === "string" ? state.start_id : "",
    steps: row.steps as unknown as StepState[],
    outbox: Array.isArray(state.outbox) ? state.outbox : [],
    flat_order: Array.isArray(state.flat_order) ? state.flat_order : [],
    pending_prompts: (state.pending_prompts ?? {}) as Record<string, string>,
    history,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  } as WorkflowInstance;
  if (row.terminal !== null) instance.terminal = row.terminal;
  if (row.firedOnce.length > 0) instance.fired_once = [...row.firedOnce];
  return instance;
}

export interface RecordWorkflowStoreOptions {
  /**
   * The workflow documents the deployment declares (the profile's `records.workflows`), by id. `saveInstance` pins
   * the one an instance names when it creates it, and `getWorkflow` reads them. `create` takes its definition
   * directly and does not need this.
   */
  definitions?: Record<string, WorkflowDSL>;
}

export class RecordWorkflowStore implements WorkflowStore {
  private readonly tx: ScopedDb;
  readonly orgId: string;
  private readonly definitions: Record<string, WorkflowDSL>;
  private scopeChecked: Promise<void> | null = null;

  constructor(tx: ScopedDb, orgId: string, options: RecordWorkflowStoreOptions = {}) {
    if (typeof orgId !== "string" || !orgId.trim()) throw new Error("record workflow store: needs a workspace id");
    this.tx = tx;
    this.orgId = orgId;
    this.definitions = options.definitions ?? {};
  }

  /** Once per store: the transaction's `app.org_id` must be this store's workspace. */
  private scoped(): Promise<void> {
    this.scopeChecked ??= (async () => {
      const [row] = rowsOf<{ org: string | null }>(await this.tx.execute(sql`select current_setting('app.org_id', true) as org`));
      const scopedTo = row?.org ? String(row.org) : null;
      if (scopedTo !== this.orgId) throw new RecordWorkflowScopeError(this.orgId, scopedTo);
    })();
    return this.scopeChecked;
  }

  private mine(organizationId: string | undefined): boolean {
    return organizationId === undefined || organizationId === this.orgId;
  }

  // ── the store's own API ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Store a new instance (revision 0, as the engine's `initInstance` makes it) with its pinned definition, and its
   * history so far. Revision 1 on success. A record that already runs this workflow, or an id already taken, is a
   * conflict (`attached`) and nothing is written.
   */
  async create(instance: WorkflowInstance, definition: WorkflowDSL): Promise<WriteResult> {
    await this.scoped();
    this.assertOwn(instance);
    const expected = instance.revision ?? 0;
    if (expected !== 0) {
      return { ok: false, conflict: new RecordWorkflowConflict("stale_revision", instance.id, expected, undefined, `instance "${instance.id}" does not exist at expected revision ${expected}`) };
    }
    const inserted = await this.tx
      .insert(recordWorkflowInstances)
      .values(instanceRowValues(this.orgId, instance, definition))
      .onConflictDoNothing()
      .returning({ id: recordWorkflowInstances.id });
    if (inserted.length === 0) {
      return {
        ok: false,
        conflict: new RecordWorkflowConflict("attached", instance.id, 0, undefined, `${instance.object.type} "${instance.object.id}" already runs workflow "${instance.workflow_id}" in this workspace (or the instance id is taken)`),
      };
    }
    await this.insertEvents(instance.id, instance.history ?? []);
    return { ok: true, instance: { ...structuredClone(instance), revision: 1, definition_version: definitionVersionOf(definitionHash(definition)) } };
  }

  /**
   * Save a changed instance read at `instance.revision`: its steps, terminal, fired rules and engine state, and the
   * history events appended since it was read. A stale revision (someone wrote in between), a missing instance, or
   * less history than is stored (`history_mismatch`) is a conflict and nothing is written. Which record and which
   * workflow an instance belongs to, and the definition version it was pinned to, never change.
   */
  async update(instance: WorkflowInstance): Promise<WriteResult> {
    await this.scoped();
    this.assertOwn(instance);
    const expected = instance.revision ?? 0;
    const history = instance.history ?? [];
    // How much history is stored, BEFORE anything is written. If someone appends between this read and the UPDATE
    // below, they moved the revision on, so the UPDATE matches no row and the write is a stale-revision conflict: the
    // count is exact whenever the UPDATE succeeds.
    const [{ n }] = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(recordWorkflowEvents)
      .where(and(eq(recordWorkflowEvents.orgId, this.orgId), eq(recordWorkflowEvents.instanceId, instance.id)));
    if (history.length < n) {
      return {
        ok: false,
        conflict: new RecordWorkflowConflict("history_mismatch", instance.id, expected, undefined, `instance "${instance.id}" carries ${history.length} history events but ${n} are stored; history is append-only (read the instance with its history before changing it)`),
      };
    }
    const { definition_version: _pinned, ...state } = engineStateOf(instance);
    const updated = await this.tx
      .update(recordWorkflowInstances)
      .set({
        steps: instance.steps as unknown as Record<string, unknown>[],
        terminal: instance.terminal ?? null,
        firedOnce: instance.fired_once ?? [],
        // The stored definition version is kept whatever the instance says: it names the pinned document.
        engineState: sql`${JSON.stringify(state)}::jsonb || jsonb_strip_nulls(jsonb_build_object('definition_version', ${recordWorkflowInstances.engineState}->'definition_version'))`,
        updatedAt: toDate(instance.updated_at, "updated_at"),
        revision: sql`${recordWorkflowInstances.revision} + 1`,
      })
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.id, instance.id), eq(recordWorkflowInstances.revision, expected)))
      .returning({ revision: recordWorkflowInstances.revision, version: sql<number | null>`(${recordWorkflowInstances.engineState}->>'definition_version')::bigint` });
    if (updated.length === 0) {
      const [now] = await this.tx
        .select({ revision: recordWorkflowInstances.revision })
        .from(recordWorkflowInstances)
        .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.id, instance.id)));
      return {
        ok: false,
        conflict: now
          ? new RecordWorkflowConflict("stale_revision", instance.id, expected, now.revision, `instance "${instance.id}" changed concurrently (expected revision ${expected}, current ${now.revision})`)
          : new RecordWorkflowConflict("missing", instance.id, expected, undefined, `instance "${instance.id}" does not exist at expected revision ${expected}`),
      };
    }
    // The row is locked by the UPDATE until the caller's transaction ends, and its revision was the one read, so the
    // stored history is exactly the `n` events counted above: what follows them in `instance.history` is new.
    await this.insertEvents(instance.id, history.slice(n));
    const saved = { ...structuredClone(instance), revision: updated[0].revision };
    if (updated[0].version !== null && updated[0].version !== undefined) saved.definition_version = Number(updated[0].version);
    return { ok: true, instance: saved };
  }

  /** The instance with this id, with its history; undefined when this workspace has none. */
  async get(id: string): Promise<WorkflowInstance | undefined> {
    await this.scoped();
    const [row] = await this.tx
      .select()
      .from(recordWorkflowInstances)
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.id, id)));
    return row ? (await this.withHistory([row]))[0] : undefined;
  }

  /** The instance of `workflowId` running on this record, with its history. */
  async getByEntity(entityType: string, entityId: string, workflowId: string): Promise<WorkflowInstance | undefined> {
    return (await this.listByEntity(entityType, entityId)).find((i) => i.workflow_id === workflowId);
  }

  /** Every workflow instance on this record, with their histories, oldest first. */
  async listByEntity(entityType: string, entityId: string): Promise<WorkflowInstance[]> {
    await this.scoped();
    const rows = await this.tx
      .select()
      .from(recordWorkflowInstances)
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.entityType, entityType), eq(recordWorkflowInstances.entityId, entityId)))
      .orderBy(asc(recordWorkflowInstances.createdAt), asc(recordWorkflowInstances.id));
    return this.withHistory(rows);
  }

  /** The definition an instance was made from (its pinned copy and hash), whatever the profile says now. */
  async getDefinition(instanceId: string): Promise<PinnedDefinition | undefined> {
    await this.scoped();
    const [row] = await this.tx
      .select({ workflowId: recordWorkflowInstances.workflowId, definition: recordWorkflowInstances.definition, hash: recordWorkflowInstances.definitionHash })
      .from(recordWorkflowInstances)
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.id, instanceId)));
    return row ? { workflow_id: row.workflowId, definition: row.definition as unknown as WorkflowDSL, definition_hash: row.hash } : undefined;
  }

  /**
   * Append one event to an instance's history. It moves the instance's revision on (an event is a change to the
   * instance), so a writer holding an older read is refused rather than losing it. Returns the stored event and the
   * new revision; undefined when this workspace has no such instance (nothing is written).
   */
  async appendEvent(instanceId: string, event: HistoryEvent): Promise<{ event: RecordWorkflowEvent; revision: number } | undefined> {
    await this.scoped();
    const at = toDate(event.at, "the event's time");
    const bumped = await this.tx
      .update(recordWorkflowInstances)
      // updated_at never moves backwards: an event stamped earlier than the last change leaves it where it is.
      .set({ revision: sql`${recordWorkflowInstances.revision} + 1`, updatedAt: sql`greatest(${recordWorkflowInstances.updatedAt}, ${at.toISOString()}::timestamptz)` })
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.id, instanceId)))
      .returning({ revision: recordWorkflowInstances.revision });
    if (bumped.length === 0) return undefined;
    const [row] = await this.tx.insert(recordWorkflowEvents).values(eventValues(this.orgId, instanceId, event)).returning();
    return { event: eventFromRow(row), revision: bumped[0].revision };
  }

  /** An instance's history, in the order it was appended; [] when this workspace has no such instance. */
  async listEvents(instanceId: string): Promise<RecordWorkflowEvent[]> {
    await this.scoped();
    const rows = await this.tx
      .select()
      .from(recordWorkflowEvents)
      .where(and(eq(recordWorkflowEvents.orgId, this.orgId), eq(recordWorkflowEvents.instanceId, instanceId)))
      .orderBy(asc(recordWorkflowEvents.id));
    return rows.map(eventFromRow);
  }

  private assertOwn(instance: WorkflowInstance): void {
    if (instance.organization_id !== this.orgId) {
      throw new RecordWorkflowScopeError(this.orgId, instance.organization_id || null);
    }
  }

  private async insertEvents(instanceId: string, events: HistoryEvent[]): Promise<void> {
    if (events.length === 0) return;
    // One INSERT, rows in order: the identity numbers them in the order given.
    await this.tx.insert(recordWorkflowEvents).values(events.map((e) => eventValues(this.orgId, instanceId, e)));
  }

  private async withHistory(rows: InstanceRow[]): Promise<WorkflowInstance[]> {
    if (rows.length === 0) return [];
    const events = await this.tx
      .select()
      .from(recordWorkflowEvents)
      .where(and(eq(recordWorkflowEvents.orgId, this.orgId), inArray(recordWorkflowEvents.instanceId, rows.map((r) => r.id))))
      .orderBy(asc(recordWorkflowEvents.id));
    const byInstance = new Map<string, HistoryEvent[]>();
    for (const e of events) {
      const list = byInstance.get(e.instanceId) ?? [];
      list.push(historyOf(eventFromRow(e)));
      byInstance.set(e.instanceId, list);
    }
    return rows.map((r) => instanceFromRow(r, byInstance.get(r.id) ?? []));
  }

  // ── the engine's WorkflowStore interface ────────────────────────────────────────────────────────────────────────

  async registerWorkflow(_workflow: RegisteredWorkflow): Promise<void> {
    throw new RecordWorkflowNotSupported("registering a workflow", "definitions change only through the build");
  }

  async upsertWorkflow(_workflow: RegisteredWorkflow): Promise<{ created: boolean }> {
    throw new RecordWorkflowNotSupported("changing a workflow", "definitions change only through the build");
  }

  async deleteWorkflow(_id: string, _force?: boolean, _organizationId?: string): Promise<void> {
    throw new RecordWorkflowNotSupported("deleting a workflow", "definitions change only through the build");
  }

  /** The deployment's CURRENT document for a workflow (what a new instance is pinned to), versioned by its hash. */
  async getWorkflow(id: string, organizationId?: string): Promise<RegisteredWorkflow | undefined> {
    const dsl = this.mine(organizationId) && Object.hasOwn(this.definitions, id) ? this.definitions[id] : undefined;
    if (!dsl) return undefined;
    const version = definitionVersionOf(definitionHash(dsl));
    return { id, organization_id: this.orgId, version, dsl: structuredClone(dsl), registered_at: new Date(0).toISOString() };
  }

  /**
   * The document a version stands for: the deployment's current one when that is the version asked for, else the
   * copy an instance of this workspace was pinned to (the engine asks for `instance.definition_version`, so an
   * instance always runs on the rules it was made with, whatever the profile says now). Undefined when neither.
   */
  async getWorkflowVersion(id: string, version: number, organizationId?: string): Promise<RegisteredWorkflow | undefined> {
    if (!this.mine(organizationId)) return undefined;
    const current = await this.getWorkflow(id);
    if (current && current.version === version) return current;
    const prefix = hashPrefixOf(version);
    if (!prefix) return undefined;
    await this.scoped();
    const [row] = await this.tx
      .select({ definition: recordWorkflowInstances.definition, hash: recordWorkflowInstances.definitionHash, createdAt: recordWorkflowInstances.createdAt })
      .from(recordWorkflowInstances)
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.workflowId, id), sql`${recordWorkflowInstances.definitionHash} like ${`${prefix}%`}`))
      .orderBy(asc(recordWorkflowInstances.createdAt))
      .limit(1);
    if (!row || definitionVersionOf(row.hash) !== version) return undefined;
    return { id, organization_id: this.orgId, version, dsl: row.definition as unknown as WorkflowDSL, registered_at: iso(row.createdAt) };
  }

  async listWorkflows(organizationId?: string): Promise<RegisteredWorkflow[]> {
    if (!this.mine(organizationId)) return [];
    const out: RegisteredWorkflow[] = [];
    for (const id of Object.keys(this.definitions).sort()) {
      const w = await this.getWorkflow(id);
      if (w) out.push(w);
    }
    return out;
  }

  /**
   * Create (revision 0, pinning `definitions[workflow_id]`) or compare-and-swap (any other revision). Throws the
   * conflict, as the engine's stores do, and sets `instance.revision` to the stored one on success.
   */
  async saveInstance(instance: WorkflowInstance): Promise<void> {
    let result: WriteResult;
    if ((instance.revision ?? 0) === 0) {
      const definition = Object.hasOwn(this.definitions, instance.workflow_id) ? this.definitions[instance.workflow_id] : undefined;
      if (!definition) throw new Error(`record workflow store: no definition for workflow "${instance.workflow_id}" to pin (pass it in definitions, or call create)`);
      result = await this.create(instance, definition);
    } else {
      result = await this.update(instance);
    }
    if (!result.ok) throw result.conflict;
    instance.revision = result.instance.revision;
  }

  async getInstance(id: string, organizationId?: string): Promise<WorkflowInstance | undefined> {
    return this.mine(organizationId) ? this.get(id) : undefined;
  }

  async listInstances(workflowId?: string, organizationId?: string): Promise<WorkflowInstance[]> {
    if (!this.mine(organizationId)) return [];
    await this.scoped();
    const rows = await this.tx
      .select()
      .from(recordWorkflowInstances)
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), workflowId === undefined ? undefined : eq(recordWorkflowInstances.workflowId, workflowId)))
      .orderBy(asc(recordWorkflowInstances.id));
    return this.withHistory(rows);
  }

  async listInstancesPage(
    organizationId: string,
    workflowId: string | undefined,
    after: string | undefined,
    limit: number,
  ): Promise<{ items: WorkflowInstance[]; next_cursor?: string }> {
    if (!this.mine(organizationId)) return { items: [] };
    await this.scoped();
    const rows = await this.tx
      .select()
      .from(recordWorkflowInstances)
      .where(and(
        eq(recordWorkflowInstances.orgId, this.orgId),
        workflowId === undefined ? undefined : eq(recordWorkflowInstances.workflowId, workflowId),
        after === undefined ? undefined : gt(recordWorkflowInstances.id, after),
      ))
      .orderBy(asc(recordWorkflowInstances.id))
      .limit(Math.max(0, limit) + 1);
    const items = await this.withHistory(rows.slice(0, limit));
    return { items, next_cursor: rows.length > limit ? items[items.length - 1]?.id : undefined };
  }

  async listObjectInstances(organizationId: string, type: string, id: string): Promise<WorkflowInstance[]> {
    return this.mine(organizationId) ? this.listByEntity(type, id) : [];
  }

  async listInstancesForObjects(organizationId: string, type: string, ids: string[]): Promise<WorkflowInstance[]> {
    if (!this.mine(organizationId) || ids.length === 0) return [];
    await this.scoped();
    const rows = await this.tx
      .select()
      .from(recordWorkflowInstances)
      .where(and(eq(recordWorkflowInstances.orgId, this.orgId), eq(recordWorkflowInstances.entityType, type), inArray(recordWorkflowInstances.entityId, ids)))
      .orderBy(asc(recordWorkflowInstances.id));
    // The summary needs no history: the cut the engine's in-memory store makes.
    return rows.map((r) => projectSummaryFields(instanceFromRow(r, [])));
  }

  /**
   * Nothing to move: a record holds its own fields (department, business unit) and the workflow reads them from the
   * record (`withRecordData`), so no stored instance carries a copy that could fall out of date.
   */
  async reassignObjectScope(_organizationId: string, _type: string, _id: string, _scope: ObjectScope): Promise<{ matched: number; updated: number }> {
    return { matched: 0, updated: 0 };
  }

  async findAttachment(organizationId: string, workflowId: string, type: string, id: string): Promise<WorkflowInstance | undefined> {
    return this.mine(organizationId) ? this.getByEntity(type, id, workflowId) : undefined;
  }

  async replaceIdentitySnapshot(_snapshot: IdentitySnapshot): Promise<void> {
    throw new RecordWorkflowNotSupported("storing an identity snapshot", "the directory is the workspace's own people data (phase 4), supplied by the caller (phase 5)");
  }

  /**
   * None stored: the directory the engine routes to is built from the workspace's own people data (phase 4) and handed
   * to the engine by the write path (phase 5), never kept in this store.
   */
  async getIdentitySnapshot(_organizationId: string): Promise<IdentitySnapshot | undefined> {
    return undefined;
  }

  async claimCallbackEvent(_organizationId: string, _eventId: string, _fingerprint: string): Promise<CallbackClaim> {
    throw new RecordWorkflowNotSupported("callbacks", "no external callbacks in this phase");
  }

  async completeCallbackEvent(_organizationId: string, _eventId: string): Promise<void> {
    throw new RecordWorkflowNotSupported("callbacks", "no external callbacks in this phase");
  }

  async failCallbackEvent(_organizationId: string, _eventId: string, _error: string): Promise<void> {
    throw new RecordWorkflowNotSupported("callbacks", "no external callbacks in this phase");
  }

  async getJobCheckpoint(_organizationId: string, _jobId: string): Promise<JobCheckpoint | undefined> {
    throw new RecordWorkflowNotSupported("job checkpoints", "no engine jobs in this phase");
  }

  async claimJobLease(_organizationId: string, _jobId: string, _owner: string, _leaseSeconds: number): Promise<{ acquired: boolean; checkpoint: JobCheckpoint }> {
    throw new RecordWorkflowNotSupported("job leases", "no engine jobs in this phase");
  }

  async saveJobCheckpoint(_checkpoint: JobCheckpoint, _owner: string): Promise<JobCheckpoint> {
    throw new RecordWorkflowNotSupported("job checkpoints", "no engine jobs in this phase");
  }

  async releaseJobLease(_organizationId: string, _jobId: string, _owner: string): Promise<void> {
    throw new RecordWorkflowNotSupported("job leases", "no engine jobs in this phase");
  }
}
