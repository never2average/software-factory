/**
 * The TODO tools: `upsert_todo`, `list_todos`, `hide_todo` (re-exported from
 * snake_case files under `agent/tools/`). A todo is the team's internal
 * checklist item — NOT a customer ticket (that's `create_ticket`). It can hang
 * off a Deployment/Implementation (the epic analog) and link to a related
 * object. Relative `.ts` specifiers, same as app-tools.ts.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { orgMembers, todos } from "./db/schema.ts";
import { orgForSession } from "./org-context.ts";
import { taskWorkflowRequest } from "./task-workflow-service.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { fill, VOCABULARY } from "./agent-vocabulary.ts";
import { WORK_PERIODS, currentPeriod, progressByPerson } from "./work-periods.ts";
import { ensureCurrentPeriod, goalsFor, newPeriodWindow, rollOverEnded, setMemberGoal, taskWriteRefusal } from "./work-period-store.ts";
import { areaView, describeArea, describeField, describeStructure, periodCompletion, periodContains, type AreaRow, type RecordField } from "./record-areas.ts";
import { prepareTaskWrite, taskCustom, taskLifecycleEnforced } from "./task-area.ts";
import { permissionsDeclared } from "./record-permissions.ts";
import { periodRefusal, taskDeleteRefusal } from "./record-permissions-store.ts";
import { needsEnteredBy, storedStateOf, type NextOccurrence } from "./record-lifecycle.ts";
import { recursOnDone } from "./task-recurrence.ts";
import { recurAfterWrite } from "./task-recurrence-run.ts";
import { storedTask, whoEntered, writeOutcome } from "./record-lifecycle-store.ts";
import type { RecordRole } from "./record-areas.generated.ts";
import { periodDeclared, periodOut, writablePeriodFields } from "./period-area.ts";
import { writeDeclaredPeriod } from "./period-area-store.ts";
import { memberRole } from "./record-area-store.ts";
import {
  attachCreatedRecord,
  lockRecordWorkflow,
  openRecordWorkflow,
  RECORD_SERVICE_TIMEOUT_MS,
  RecordWorkflowBusy,
  recordWorkflowBound,
  reserveRecordMove,
  settleReservedMove,
  workflowRefusal,
  type RecordWorkflowSession,
} from "../../lib/record-workflow-moves.ts";

function callerEmail(ctx: {
  session: {
    auth: {
      current: {
        principalId: string;
        attributes: Readonly<Record<string, string | readonly string[]>>;
      } | null;
    };
  };
}): string {
  const current = ctx.session.auth.current;
  const email = current?.attributes?.email;
  if (typeof email === "string" && email.length > 0) return email;
  return current?.principalId ?? "agent";
}

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("TODOs need a database — DATABASE_URL is not configured.");
  return db;
}

const containerType = z.enum(["deployment", "implementation"]);
const linkType = z.enum(["ticket", "customer", "app", "cron", "workflow", "chat"]);

/**
 * The deployment's definition of a task (profiles records.areas.tasks; agent/lib/record-areas.ts). The two todo tools
 * below are today's, to the byte, unless the profile REDEFINES tasks; then their words, states, priorities and own
 * fields are the definition's. Every write is checked against it (agent/lib/task-area.ts) either way.
 */
const TASKS = areaView("tasks");
const OWN_STATES = TASKS.redefined && TASKS.lifecycle?.own ? TASKS.lifecycle : null;
/**
 * The lifecycle's rules are enforced ("warn" or "strict"; agent/lib/record-lifecycle.ts): a move is checked against
 * the stored task, as the caller's role in the workspace, exactly as the ops API checks it. Off by default.
 */
const ENFORCED = taskLifecycleEnforced();
/** A recurring task (records.areas.tasks.recurrence): completing one creates the next (agent/lib/task-recurrence.ts). */
const RECURS = recursOnDone();
/**
 * The tasks say who may create, change or delete them (records.areas.tasks.permissions; agent/lib/record-permissions.ts):
 * a write reads the caller's role and the stored task, as the ops API does. Off by default.
 */
const PERMS = permissionsDeclared("tasks");
/** The lifecycle runs a workflow (records.areas.tasks.lifecycle.workflow, enforced): a move goes through its step rules. */
const WORKFLOW = recordWorkflowBound("tasks");
/** Some move needs a comment: the tool takes one (`reason`), only then. */
const TAKES_COMMENT = ENFORCED && (TASKS.area.lifecycle?.transitions ?? []).some((t) => t.requires_comment);

/** The caller's role in the workspace (org_members), for a transition's `roles`; "member" when none is recorded. */
async function roleOf(orgId: string, email: string): Promise<RecordRole> {
  const [row] = await withOrgDb(orgId, (tx) =>
    tx.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, email.toLowerCase()))).limit(1),
  );
  const role = row?.role;
  return role === "owner" || role === "admin" || role === "engineer" ? role : "member";
}

/** One upsert_todo call, whichever definition the tool was built from. */
async function writeTodo(input: Record<string, unknown> & { id?: string }, ctx: Parameters<typeof callerEmail>[0]) {
  const { id, ...fields } = input as typeof input & { cycleId?: string | null; assignee?: string | null; title?: string };
  const orgId = await orgForSession(ctx);
  const actor = callerEmail(ctx);
  if (!WORK_PERIODS.enabled) delete fields.cycleId;
  if (WORK_PERIODS.individual) {
    if (fields.cycleId === "current") {
      const period = await withOrgDb(orgId, (tx) => ensureCurrentPeriod(tx, orgId, actor));
      if (!period) throw new Error(`There is no current ${WORK_PERIODS.label.singular}. Create one with upsert_cycle first.`);
      fields.cycleId = period.id;
    }
    const refused = await withOrgDb(orgId, (tx) => taskWriteRefusal(tx, orgId, actor, id ?? null, { cycleId: fields.cycleId, assignee: fields.assignee }));
    if (refused) throw new Error(refused);
  }
  if (!id && !fields.title) throw new Error(`Creating a ${TASKS.redefined ? TASKS.noun : "todo"} needs a \`title\`.`);
  // The deployment's definition of a task: a refused write never reaches the task service. With its lifecycle
  // enforced, a move is checked against the stored task as the caller's role (a refusal names the moves there are).
  const lifecycle = ENFORCED || RECURS || PERMS ? await lifecycleInputs(orgId, actor, id ?? null) : {};
  // One write. `wf`, when the lifecycle runs a workflow: the step rules (read under the task's workflow lock, with the
  // stored task `lc` read there too), then the move reserved, the service's write with nothing held, and the task's
  // actual state settling the reservation (lib/record-workflow-moves.ts, "A record written elsewhere"). Without one,
  // exactly today's write.
  const run = async (lc: typeof lifecycle, wf: { session: RecordWorkflowSession | null } | null) => {
    // While another mover's reserved move is pending, the step rules are not asked (a move is answered "being moved").
    const prepared = prepareTaskWrite(id ? "update" : "create", fields, { actor, ...lc, ...(wf?.session?.gate && !wf.session.busy ? { workflow: wf.session.gate } : {}) });
    if (!prepared.ok) throw new Error(prepared.errors.join(" "));
    // Another mover's reserved move is not settled yet: a move now would be checked against a step about to change.
    if (wf?.session?.busy && prepared.lifecycle) throw new RecordWorkflowBusy();
    const body = prepared.body ?? fields;
    // After the write: the next occurrence of a recurring task it completed (once), then its move in the feed.
    const recur = async (item: unknown): Promise<{ next?: NextOccurrence }> => {
      if (!RECURS) return {};
      try {
        const next = await recurAfterWrite({ orgId, actor, before: (lc as { before?: AreaRow | null }).before ?? null, item: item as AreaRow, withTx: (fn) => withOrgDb(orgId, fn) });
        return next ? { next } : {};
      } catch (error) {
        console.error("[upsert_todo] could not create the next occurrence:", error);
        return {};
      }
    };
    const recordMove = async (taskId: string) => {
      if (!prepared.lifecycle) return;
      const comment = typeof fields.reason === "string" ? fields.reason : null;
      await withOrgDb(orgId, (tx) => writeOutcome(tx, orgId, { type: "task", id: taskId }, actor, TASKS, prepared.lifecycle, comment)).catch((error) => {
        console.error(`[upsert_todo] could not record the move of task ${taskId}:`, error);
      });
    };
    const limit = wf ? { timeoutMs: RECORD_SERVICE_TIMEOUT_MS } : {};

    if (id) {
      // The move reserved on the instance, if the task and its instance are still what was checked (else a refusal).
      const moveId = wf?.session ? (await withOrgDb(orgId, (tx) => reserveRecordMove(tx, wf.session!, { entityId: id, check: prepared.lifecycle ?? null, readRecord: () => storedTask(tx, orgId, id), deliver: (o, fn) => withOrgDb(o, fn as never) }))).id : null;
      const settle = () =>
        moveId
          ? withOrgDb(orgId, (tx) => settleReservedMove(tx, orgId, "tasks", { entityId: id, moveId, readRecord: () => storedTask(tx, orgId, id), deliver: (o, fn) => withOrgDb(o, fn as never) })).catch((error) => {
              console.error(`[upsert_todo] could not settle the move of task ${id}:`, error);
              return null;
            })
          : Promise.resolve(null);
      let item: { id: string; title: string; done: boolean };
      try {
        item = await taskWorkflowRequest<{ id: string; title: string; done: boolean }>(orgId, actor, `/api/v1/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body, ...limit });
      } catch (e) {
        // The service refused, failed or did not answer: the task's state says whether the move was made after all.
        if (moveId) {
          const settled = await settle();
          if (settled?.outcome === "applied") throw new Error(`The task service did not confirm the change, but it was made: this ${TASKS.noun} now reads "${settled.state}", and its workflow step followed. Read it again before changing it.`);
          if (!settled) throw new Error(`The task service did not confirm the change, and it could not be checked whether it was made. Read this ${TASKS.noun} again: its workflow follows what it reads.`);
        }
        throw e;
      }
      const settled = moveId ? await settle() : null;
      const note = moveId && !settled ? { workflow_note: `This ${TASKS.noun} was changed, but its workflow step could not be updated just now; it follows on the next read of this ${TASKS.noun}.` } : {};
      await recordMove(item.id);
      return { updated: true as const, todo: { id: item.id, title: item.title, done: item.done }, ...(prepared.warnings.length && ENFORCED ? { warnings: prepared.warnings } : {}), ...(await recur(item)), ...note };
    }

    const item = await taskWorkflowRequest<{ id: string; title: string }>(orgId, actor, "/api/v1/tasks", { method: "POST", body, ...limit });
    let note = {};
    if (wf) {
      // The new task's instance, attached once the service made it; if not now, on its first move.
      const attached = item?.id
        ? await withOrgDb(orgId, (tx) => attachCreatedRecord(tx, orgId, "tasks", { entityId: item.id, actor, check: prepared.lifecycle ?? null, comment: typeof fields.reason === "string" ? fields.reason : null, readRecord: () => storedTask(tx, orgId, item.id), deliver: (o, fn) => withOrgDb(o, fn as never) })).catch((error) => {
            console.error(`[upsert_todo] could not attach the workflow of task ${item.id}:`, error);
            return null;
          })
        : null;
      if (!attached) note = { workflow_note: `This ${TASKS.noun} was created; its workflow is attached on its first move.` };
    }
    await recordMove(item.id);
    return { created: true as const, todo: { id: item.id, title: item.title }, ...(prepared.warnings.length && ENFORCED ? { warnings: prepared.warnings } : {}), ...note };
  };
  if (!WORKFLOW) return run(lifecycle, null);
  // The lifecycle runs a workflow: under the task's workflow lock, the task as it is now and its instance (a short
  // transaction, closed before anything else is read or sent).
  try {
    const comment = typeof fields.reason === "string" ? fields.reason : null;
    const opened = await withOrgDb(orgId, async (tx) => {
      if (!id) return { lc: lifecycle, session: await openRecordWorkflow(tx, orgId, "tasks", { entityId: null, before: null, actor, comment }) };
      await lockRecordWorkflow(tx, orgId, "tasks", id);
      const before = await storedTask(tx, orgId, id);
      const from = storedStateOf(TASKS, before);
      const enteredBy = before && from !== null && needsEnteredBy(TASKS, from) ? await whoEntered(tx, orgId, { type: "task", id }, TASKS, before, from) : null;
      const session = before ? await openRecordWorkflow(tx, orgId, "tasks", { entityId: id, before, actor, comment }) : null;
      return { lc: { ...lifecycle, before, enteredBy }, session };
    });
    return await run(opened.lc, { session: opened.session });
  } catch (e) {
    const stopped = workflowRefusal(e, TASKS.noun);
    throw stopped ? new Error(stopped.body.error) : e;
  }
}

/** What the lifecycle's rules read besides the body: the caller's role, the stored task, who entered its state. */
async function lifecycleInputs(orgId: string, actor: string, id: string | null) {
  const role = ENFORCED || PERMS ? await roleOf(orgId, actor) : undefined;
  if (!id) return { role };
  const lc = TASKS.lifecycle!;
  return withOrgDb(orgId, async (tx) => {
    const before = await storedTask(tx, orgId, id);
    const from = storedStateOf(TASKS, before);
    const by = before && from !== null && needsEnteredBy(TASKS, from) ? await whoEntered(tx, orgId, { type: "task", id }, TASKS, before, from) : null;
    return { role, before, enteredBy: by };
  });
}

/** An own field as a tool parameter: its choices as an enum, its label and help as the description. */
function ownFieldParam(f: RecordField) {
  const said = describeField(f).replace(/^`[^`]+` /, "");
  const choices = (f.options ?? []).filter((o) => !o.retired).map((o) => o.value);
  const base =
    f.type === "pick_list" && choices.length ? z.enum(choices as [string, ...string[]])
    : f.type === "multi_pick" || f.type === "tags" || f.many ? z.array(z.string())
    : f.type === "integer" || f.type === "number" || f.type === "percent" || f.type === "money" ? z.number()
    : f.type === "boolean" ? z.boolean()
    : z.string();
  return base.nullable().optional().describe(`${said}${f.help ? ` ${f.help}` : ""}`);
}
/** What a task carries in this deployment, for a tool's description: the area's card. */
const TASK_CARD = describeArea("tasks", undefined, VOCABULARY.records.account.singular) ?? "";

export const upsertTodoTool = modelFacing("upsert_todo", !TASKS.redefined
  ? defineTool({
  description:
    "Create OR update a TODO — the team's internal checklist item (NOT a {account} ticket; use create_ticket for those). Omit `id` to create; pass `id` to update just the fields you provide. A todo can be filed under a {deployment} or an {implementation} (the 'epic' — set container*), linked to a related object (a ticket/customer/app/cron/workflow/chat — set link*), assigned, prioritised, and given a due date. Use this for 'remind me to X', 'add a todo to Y', or to mark one done.",
  approval: once(),
  inputSchema: z.object({
    id: z.string().optional().describe("The todo id to UPDATE. Omit to create a new one."),
    title: z.string().min(1).max(300).optional().describe("Required when creating."),
    notes: z.string().max(4000).nullable().optional(),
    done: z.boolean().optional().describe("true marks it done (stamps done_at)."),
    status: z
      .enum(["backlog", "open", "in_progress", "blocked", "done", "cancelled"])
      .optional()
      .describe("Board column: backlog | open | in_progress | blocked | done | cancelled. Kept in sync with done."),
    priority: z.enum(["low", "normal", "high"]).optional(),
    dueAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("ISO-8601 due date, or null to clear."),
    containerType: containerType.nullable().optional().describe("'deployment' | 'implementation' — the epic it's filed under."),
    containerId: z.string().nullable().optional(),
    containerLabel: z.string().nullable().optional().describe("Human label for the container chip."),
    linkType: linkType.nullable().optional(),
    linkId: z.string().nullable().optional(),
    linkLabel: z.string().nullable().optional().describe("Human label for the link chip."),
    assignee: z.string().nullable().optional().describe("Email of the assignee; null = the creator."),
    // The period parameter exists only where the deployment has periods (profile work_periods.mode). Under mode
    // individual a task in a period is one person's {period_item}, and "current" names the period that contains today.
    ...(WORK_PERIODS.enabled
      ? {
          cycleId: z
            .string()
            .nullable()
            .optional()
            .describe(fill(
              WORK_PERIODS.individual
                ? "Makes this todo a {period_item} of a {period}: the cycle id from list_cycles, or \"current\" for the {period} that contains today. It is the assignee's {period_item} (yours when no assignee is given); you may only set one for yourself or for a person who reports to you on the roster. null = not in any {period}."
                : "The cycle ({period}) id from list_cycles; null = backlog.",
            )),
        }
      : {}),
  }),
  async execute(input, ctx) {
    return writeTodo(input as Record<string, unknown> & { id?: string }, ctx);
  },
})
  : defineTool({
    description: fill(
      `Create OR update ${/^[aeiou]/i.test(TASKS.noun) ? "an" : "a"} ${TASKS.noun} (the team's ${TASKS.nouns}; NOT a {account} ticket, use create_ticket for those). Omit \`id\` to create; pass \`id\` to update just the fields you provide.${OWN_STATES ? ` Move it by setting \`custom.${OWN_STATES.field}\` (its state); its status follows, never set it.` : ""}${ENFORCED ? ` Moves follow the ${TASKS.noun}'s lifecycle (below): ${TASKS.lifecycle!.enforce === "strict" ? "a move it does not allow is refused, and the refusal names the moves you can make and what each needs" : "a move it does not allow still goes through, and is noted in the activity feed"}.${TAKES_COMMENT ? " A move that needs a comment takes it in `reason`." : ""}` : ""} It can be filed under a {deployment} or an {implementation} (set container*), linked to a related object (set link*), assigned and given a due date.\n${TASK_CARD}`,
    ),
    approval: once(),
    inputSchema: z.object({
      id: z.string().optional().describe(`The ${TASKS.noun} id to UPDATE. Omit to create a new one.`),
      title: z.string().min(1).max(TASKS.field("title")?.max_length ?? 300).optional().describe(`${TASKS.label("title", "Title")}. Required when creating.`),
      ...(TASKS.field("notes")?.hidden ? {} : { notes: z.string().max(TASKS.field("notes")?.max_length ?? 4000).nullable().optional().describe(TASKS.label("notes", "Notes")) }),
      ...(OWN_STATES
        ? {}
        : {
            done: z.boolean().optional().describe("true marks it done (stamps done_at)."),
            status: z
              .enum(TASKS.options("status").map((o) => o.value) as [string, ...string[]])
              .optional()
              .describe(`Its state: ${TASKS.options("status").map((o) => `${o.value} ("${o.label}")`).join(" | ")}. Kept in sync with done.`),
          }),
      ...(TASKS.field("priority")?.hidden ? {} : { priority: z.enum(TASKS.options("priority").map((o) => o.value) as [string, ...string[]]).optional().describe(`${TASKS.label("priority", "Priority")}: ${TASKS.options("priority").map((o) => `${o.value} ("${o.label}")`).join(" | ")}.`) }),
      dueAt: z.string().nullable().optional().describe(`${TASKS.label("dueAt", "Due")}: a date (yyyy-mm-dd) or an ISO-8601 date-time${TASKS.field("dueAt")?.required === true ? "; required" : ""}. null clears it.`),
      containerType: containerType.nullable().optional().describe("'deployment' | 'implementation' — the record it's filed under."),
      containerId: z.string().nullable().optional(),
      containerLabel: z.string().nullable().optional().describe("Human label for the container chip."),
      linkType: linkType.nullable().optional(),
      linkId: z.string().nullable().optional(),
      linkLabel: z.string().nullable().optional().describe("Human label for the link chip."),
      assignee: z.string().nullable().optional().describe(`${TASKS.label("assignee", "Assignee")}: an email${TASKS.field("assignee")?.default === "{me}" ? "; you when omitted on create" : "; null = the creator"}.`),
      ...(TAKES_COMMENT ? { reason: z.string().max(2000).optional().describe("Why you are making this move: the comment a move may need (sent back, asked for more, set aside).") } : {}),
      ...(TASKS.ownFields.some((f) => !f.hidden && !f.computed)
        ? {
            custom: z
              .object(Object.fromEntries(TASKS.ownFields.filter((f) => !f.hidden && !f.computed).map((f) => [f.key, ownFieldParam(f)])))
              .partial()
              .optional()
              .describe(`The ${TASKS.noun}'s own fields, by key: only the ones you are changing; null clears one.`),
          }
        : {}),
      ...(WORK_PERIODS.enabled
        ? {
            cycleId: z
              .string()
              .nullable()
              .optional()
              .describe(fill(
                WORK_PERIODS.individual
                  ? "Makes this a {period_item} of a {period}: the cycle id from list_cycles, or \"current\" for the {period} that contains today. null = not in any {period}."
                  : "The cycle ({period}) id from list_cycles; null = backlog.",
              )),
          }
        : {}),
    }),
    async execute(input, ctx) {
      return writeTodo(input as Record<string, unknown> & { id?: string }, ctx);
    },
  }));

export const listTodosTool = modelFacing("list_todos", !TASKS.redefined
  ? defineTool({
  description:
    "List the team's TODOs (the internal checklist), newest first. By default only OPEN, non-archived items; pass includeDone to also show completed ones.",
  inputSchema: z.object({
    includeDone: z.boolean().default(false).describe("Also include completed todos."),
    assignee: z.string().optional().describe("Filter to todos assigned to this email."),
  }),
  async execute({ includeDone, assignee }, ctx) {
    const db = requireDb();
    const orgId = await orgForSession(ctx);
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(todos)
        .where(and(eq(todos.orgId, orgId), isNull(todos.archivedAt)))
        .orderBy(desc(todos.createdAt)),
    );
    const items = rows
      .filter((t) => (includeDone ? true : !t.done))
      .filter((t) => (assignee ? t.assignee === assignee : true))
      .map((t) => ({
        id: t.id,
        title: t.title,
        done: t.done,
        priority: t.priority,
        dueAt: t.dueAt?.toISOString() ?? null,
        container: t.containerType ? `${t.containerType}:${t.containerLabel ?? t.containerId}` : null,
        link: t.linkType ? `${t.linkType}:${t.linkLabel ?? t.linkId}` : null,
        assignee: t.assignee,
        createdBy: t.createdBy,
      }));
    return { todos: items };
  },
})
  : defineTool({
    description: `List the team's ${TASKS.nouns}, newest first, with their state and their own fields (\`custom\`). By default only the ones still to do; pass includeDone to also show finished ones.${OWN_STATES ? ` A ${TASKS.noun}'s state is \`custom.${OWN_STATES.field}\`.` : ""}`,
    inputSchema: z.object({
      includeDone: z.boolean().default(false).describe(`Also include finished ${TASKS.nouns}.`),
      assignee: z.string().optional().describe(`Only those whose ${TASKS.label("assignee", "assignee").toLowerCase()} is this email.`),
      ...(TASKS.lifecycle
        ? { state: z.enum(TASKS.lifecycle.states.map((st) => st.value) as [string, ...string[]]).optional().describe(`Only those in this state: ${TASKS.lifecycle.states.map((st) => `${st.value} ("${st.label}")`).join(" | ")}.`) }
        : {}),
    }),
    async execute(input, ctx) {
      const { includeDone, assignee, state } = input as { includeDone: boolean; assignee?: string; state?: string };
      requireDb();
      const orgId = await orgForSession(ctx);
      const rows = await withOrgDb(orgId, (tx) =>
        tx
          .select()
          .from(todos)
          .where(and(eq(todos.orgId, orgId), isNull(todos.archivedAt)))
          .orderBy(desc(todos.createdAt)),
      );
      const lc = TASKS.lifecycle;
      const items = rows
        .filter((t) => (includeDone ? true : !TASKS.closed(t as never)))
        .filter((t) => (assignee ? t.assignee === assignee : true))
        .filter((t) => (state && lc ? TASKS.get(t as never, lc.field) === state : true))
        .map((t) => ({
          id: t.id,
          title: t.title,
          ...(lc ? { state: TASKS.get(t as never, lc.field) ?? null } : {}),
          done: t.done,
          priority: t.priority,
          dueAt: t.dueAt?.toISOString() ?? null,
          container: t.containerType ? `${t.containerType}:${t.containerLabel ?? t.containerId}` : null,
          link: t.linkType ? `${t.linkType}:${t.linkLabel ?? t.linkId}` : null,
          assignee: t.assignee,
          createdBy: t.createdBy,
          custom: taskCustom(t),
        }));
      return { todos: items };
    },
  }));

export const hideTodoTool = modelFacing("hide_todo", defineTool({
  description:
    "Hide a TODO — archives it (soft delete; recoverable), removing it from the list. Use list_todos to get the id.",
  approval: once(),
  inputSchema: z.object({ id: z.string().min(1).describe("The todo id from list_todos.") }),
  async execute({ id }, ctx) {
    const orgId = await orgForSession(ctx);
    // Hiding is the tasks' delete: who may (records.areas.tasks.permissions), against the stored task.
    if (PERMS) {
      const refusal = await withOrgDb(orgId, (tx) => taskDeleteRefusal(tx, orgId, { actor: callerEmail(ctx) }, id));
      if (refusal) throw new Error(`Nothing was hidden. ${refusal}`);
    }
    const item = await taskWorkflowRequest<{ id: string; title: string }>(
      orgId,
      callerEmail(ctx),
      `/api/v1/tasks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: { archived: true } },
    );
    return { hidden: true as const, id: item.id, title: item.title };
  },
}));

import { cycles } from "./db/schema.ts";

/**
 * A period that CONTAINS the tasks filed into it (records.areas.periods.relations.contains; agent/lib/record-areas.ts):
 * list_cycles says what a period is in this deployment's words and returns, per period, how many it holds and how many
 * are done. Empty under the default, so the tool is today's to the byte.
 */
const CONTAINS = periodContains();
const CONTAINS_TEXT = CONTAINS
  ? ` ${describeStructure("periods", undefined, VOCABULARY.records.account.singular) ?? ""} Each also returns \`contains\`: how many ${TASKS.nouns} are filed into it (cancelled ones aside) and how many of them are done${CONTAINS.completion ? "; it is complete when the two are equal" : ""}.`
  : "";

/**
 * A PERIOD STATED IN THE RECORD-AREA FORM (records.areas.periods with `declared`; agent/lib/period-area.ts): the two
 * period tools take and return its fields as the definition says them (its labels, help and choices; its own fields
 * under `custom`) and its declared states, and every write goes through the one validator, who-may and the lifecycle
 * (agent/lib/period-area-store.ts writeDeclaredPeriod), as the ops routes do. Nothing of it exists otherwise, so the
 * tools below are today's to the byte.
 */
const PERIODS_DECLARED = periodDeclared();
const PERIODS = areaView("periods");
const PERIOD_STATE = PERIODS_DECLARED ? PERIODS.lifecycle : null;
/**
 * The period's fields a write may set beside its name and window: its other columns (goal, lead, capacity; under mode
 * individual none of them, a person's goal being their own), its own ones under `custom`.
 */
const PERIOD_FIELDS = PERIODS_DECLARED ? writablePeriodFields(PERIODS).filter((f) => !["name", "startsAt", "endsAt", "state"].includes(f.key) && !(WORK_PERIODS.individual && ["lead", "capacity", "goal"].includes(f.key))) : [];
const PERIOD_COLUMNS = PERIOD_FIELDS.filter((f) => f.column);
const PERIOD_OWN = PERIOD_FIELDS.filter((f) => !f.column);
/** Some move of a period needs a comment, under an enforced lifecycle: the write tool takes one (`reason`). */
const PERIOD_TAKES_COMMENT = Boolean(PERIOD_STATE && PERIOD_STATE.enforce !== "off" && (PERIODS.area.lifecycle?.transitions ?? []).some((t) => t.requires_comment));
/** What a period is here, for the tools' descriptions: the area's card (its states and moves, its own fields, its rules). */
const PERIOD_CARD = PERIODS_DECLARED ? describeArea("periods", undefined, VOCABULARY.records.account.singular) ?? "" : "";
/** The words a declared period's tools say about its window and its name. */
const periodWord = (key: string, fallback: string) => PERIODS.label(key, fallback);
/** A declared period's parameters beside id and its name and window (agent/lib/period-area.ts). Empty otherwise. */
const declaredPeriodParams = PERIODS_DECLARED
  ? {
      ...(PERIOD_STATE
        ? {
            state: z
              .enum(PERIOD_STATE.states.filter((st) => !st.retired).map((st) => st.value) as [string, ...string[]])
              .optional()
              .describe(`${periodWord("state", "State")}: ${PERIOD_STATE.states.filter((st) => !st.retired).map((st) => `${st.value} ("${st.label}")`).join(" | ")}. A new one starts in "${PERIODS.display("state", PERIOD_STATE.initial)}".${PERIOD_STATE.enforce !== "off" ? " Moves follow its lifecycle (below)." : ""}`),
          }
        : {}),
      ...Object.fromEntries(PERIOD_COLUMNS.map((f) => [f.key, ownFieldParam(f)])),
      ...(PERIOD_OWN.length
        ? {
            custom: z
              .object(Object.fromEntries(PERIOD_OWN.map((f) => [f.key, ownFieldParam(f)])))
              .partial()
              .optional()
              .describe(`The ${PERIODS.noun}'s own fields, by key: only the ones you are changing; null clears one.`),
          }
        : {}),
      ...(PERIOD_TAKES_COMMENT ? { reason: z.string().max(2000).optional().describe("Why you are making this move: the comment a move may need.") } : {}),
    }
  : {};
/** A declared period as the tools answer it: its window, its state, its fields by key, its own ones under `custom`. */
function declaredPeriodOut(c: typeof cycles.$inferSelect) {
  const row = periodOut(c as unknown as Record<string, unknown>) as Record<string, unknown>;
  return {
    id: c.id,
    name: c.name,
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
    state: c.state,
    ...Object.fromEntries(PERIOD_COLUMNS.map((f) => [f.key, row[f.key] ?? null])),
    custom: row.custom as Record<string, unknown>,
  };
}
/** One upsert_cycle write of a declared period, as the ops routes make it; a refusal throws its sentences. */
async function writePeriodTool(org: string, actor: string, id: string | null, body: Record<string, unknown>, tx?: Parameters<typeof writeDeclaredPeriod>[0]) {
  const run = async (t: Parameters<typeof writeDeclaredPeriod>[0]) => {
    const r = await writeDeclaredPeriod(t, org, { id, body, actor, role: await memberRole(t, org, actor), deliver: (o, fn) => withOrgDb(o, fn as never) });
    if (!r.ok) throw new Error(r.status === 404 ? `No cycle with id "${id}".` : `Nothing was written. ${r.errors.join(" ")}`);
    return r;
  };
  try {
    return await (tx ? run(tx) : withOrgDb(org, run));
  } catch (e) {
    // A lifecycle that runs a workflow: its instance changed under the move (nothing was kept); the sentence, not the store's.
    const stopped = workflowRefusal(e, areaView("periods").noun);
    throw stopped ? new Error(stopped.body.error) : e;
  }
}

/**
 * The two period tools. Which of them the model is given, and what they say, follows the deployment profile's
 * `work_periods` (agent/lib/work-periods.ts):
 *   mode "team"         the base product's tools, to the byte (the description fills the profile's word);
 *   mode "individual"   the same names with a person's own {period_items}: list_cycles also returns one person's
 *                       items and progress for the current period, upsert_cycle also sets a person's goal;
 *   mode "off"          neither is registered (agent/tools/list_cycles.ts and upsert_cycle.ts export disableTool()),
 *                       and upsert_todo above has no cycleId parameter.
 * Each mode's definition is written INSIDE its modelFacing(...) call, like every other tool here: the source scans
 * that tell a read-only tool from an approval-gated one read a tool from its modelFacing( to the next.
 */
export const listCyclesTool = modelFacing("list_cycles", !WORK_PERIODS.individual && PERIODS_DECLARED
  ? defineTool({
    description: fill(
      `List the ${PERIODS.nouns} (cycles), newest first: each one's id, name, window (startsAt, endsAt), state, and its fields by key (its own under \`custom\`). For filing ${TASKS.nouns} into with upsert_todo (cycleId).${CONTAINS_TEXT}${PERIOD_STATE ? " Pass `state` for only those in one state." : ""}\n${PERIOD_CARD}`,
    ),
    inputSchema: z.object({
      ...(PERIOD_STATE
        ? { state: z.enum(PERIOD_STATE.states.map((st) => st.value) as [string, ...string[]]).optional().describe(`Only those in this state: ${PERIOD_STATE.states.map((st) => `${st.value} ("${st.label}")`).join(" | ")}.`) }
        : {}),
    }),
    async execute(input, ctx) {
      requireDb();
      const { state } = input as { state?: string };
      const orgId = await orgForSession(ctx);
      const rows = await withOrgDb(orgId, async (tx) => {
        await rollOverEnded(tx, orgId);
        return tx
          .select()
          .from(cycles)
          .where(and(eq(cycles.orgId, orgId), isNull(cycles.archivedAt)))
          .orderBy(desc(cycles.createdAt));
      });
      const shown = state ? rows.filter((c) => PERIODS.canonical("state", c.state) === state) : rows;
      const held = CONTAINS && shown.length
        ? periodCompletion(await withOrgDb(orgId, (tx) => tx.select().from(todos).where(and(eq(todos.orgId, orgId), inArray(todos.cycleId, shown.map((c) => c.id)), isNull(todos.archivedAt)))) as AreaRow[])
        : null;
      return { cycles: shown.map((c) => ({ ...declaredPeriodOut(c), ...(held ? { contains: held.get(c.id) ?? { total: 0, done: 0 } } : {}) })) };
    },
  })
  : !WORK_PERIODS.individual
  ? defineTool({
    description:
      "List the team's cycles ({periods}) — for filing todos into with upsert_todo. Returns id, name, and window." + CONTAINS_TEXT,
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const db = requireDb();
      // Was unscoped in both senses: no workspace resolved, and no org filter on
      // the query — so this listed every workspace's cycles.
      const orgId = await orgForSession(ctx);
      const rows = await withOrgDb(orgId, async (tx) => {
        await rollOverEnded(tx, orgId);
        return tx
          .select()
          .from(cycles)
          .where(and(eq(cycles.orgId, orgId), isNull(cycles.archivedAt)))
          .orderBy(desc(cycles.createdAt));
      });
      // A period that contains the tasks filed into it (records.areas.periods.relations.contains): each says how many
      // it holds and how many of them are done. Nothing more is read otherwise.
      const held = CONTAINS && rows.length
        ? periodCompletion(await withOrgDb(orgId, (tx) => tx.select().from(todos).where(and(eq(todos.orgId, orgId), inArray(todos.cycleId, rows.map((c) => c.id)), isNull(todos.archivedAt)))) as AreaRow[])
        : null;
      return {
        cycles: rows.map((c) => ({
          id: c.id,
          name: c.name,
          startsAt: c.startsAt?.toISOString() ?? null,
          endsAt: c.endsAt?.toISOString() ?? null,
          ...(held ? { contains: held.get(c.id) ?? { total: 0, done: 0 } } : {}),
        })),
      };
    },
  })
  : (defineTool({
    description:
      "List the {periods} (cycles) and one person's {period_items} in one of them. Each person has their own {period_items} within a {period}: a {period_item} is a todo filed into the {period} and assigned to them. Returns every {period} (id, name, window, state) and, for `person` (the signed-in person when omitted) in `cycleId` (the {period} that contains today when omitted): their goal, how many they planned, how many are done, and each {period_item}. Add one with upsert_todo (cycleId: \"current\"), complete one with upsert_todo (id, done: true).",
    inputSchema: z.object({
      person: z.string().email().optional().describe(fill("Whose {period_items} to return, by email. Omit for the signed-in person.")),
      cycleId: z.string().optional().describe(fill("Which {period}: an id from this tool's `cycles`. Omit for the {period} that contains today.")),
    }),
    async execute({ person, cycleId }, ctx) {
      const db = requireDb();
      const orgId = await orgForSession(ctx);
      const me = callerEmail(ctx).toLowerCase();
      const who = (person ?? me).trim().toLowerCase();
      return withOrgDb(orgId, async (tx) => {
        await rollOverEnded(tx, orgId);
        const rows = await tx
          .select()
          .from(cycles)
          .where(and(eq(cycles.orgId, orgId), isNull(cycles.archivedAt)))
          .orderBy(desc(cycles.createdAt));
        const period = cycleId ? rows.find((c) => c.id === cycleId) : currentPeriod(rows);
        const listed = rows.map((c) => ({
          id: c.id,
          name: c.name,
          startsAt: c.startsAt?.toISOString() ?? null,
          endsAt: c.endsAt?.toISOString() ?? null,
          state: c.state,
          current: c.id === currentPeriod(rows)?.id,
          ...(PERIODS_DECLARED ? { custom: declaredPeriodOut(c).custom } : {}),
        }));
        if (!period) return { cycles: listed, person: who, cycle: null, items: [] };
        const tasks = await tx
          .select()
          .from(todos)
          .where(and(eq(todos.orgId, orgId), eq(todos.cycleId, period.id), isNull(todos.archivedAt)));
        const mine = progressByPerson(period.id, tasks, await goalsFor(tx, orgId, period.id), who).find((p) => p.person === who);
        return {
          cycles: listed,
          person: who,
          cycle: { id: period.id, name: period.name },
          goal: mine?.goal ?? null,
          planned: mine?.planned ?? 0,
          done: mine?.done ?? 0,
          items: (mine?.items ?? []).map((t) => ({ id: t.id, title: t.title, done: t.done, status: t.status, dueAt: t.dueAt?.toISOString() ?? null })),
        };
      });
    },
  }) as never));

export const upsertCycleTool = modelFacing("upsert_cycle", !WORK_PERIODS.individual && PERIODS_DECLARED
  ? defineTool({
    description: fill(
      `Create OR update ${/^[aeiou]/i.test(PERIODS.noun) ? "an" : "a"} ${PERIODS.noun} (a cycle). Omit \`id\` to create; pass \`id\` to update just the fields you give. Set its state with \`state\` and its own fields under \`custom\`; every write is checked against what ${/^[aeiou]/i.test(PERIODS.noun) ? "an" : "a"} ${PERIODS.noun} is here, and a refusal says why. Then file ${TASKS.nouns} into it with upsert_todo (cycleId).${PERIOD_TAKES_COMMENT ? " A move that needs a comment takes it in `reason`." : ""}\n${PERIOD_CARD}`,
    ),
    approval: once(),
    inputSchema: z.object({
      id: z.string().optional().describe(`The ${PERIODS.noun}'s id (from list_cycles) to update; omit to create.`),
      name: z.string().min(1).max(PERIODS.field("name")?.max_length ?? 200).optional().describe(`${periodWord("name", "Name")}${PERIODS.field("name")?.help ? `: ${PERIODS.field("name")!.help}` : ""}. Required when creating${WORK_PERIODS.lengthDays ? " unless the dates are left to the workspace's length" : ""}.`),
      startsAt: z.string().nullable().optional().describe(`${periodWord("startsAt", "Starts")}: a date (yyyy-mm-dd) or an ISO-8601 date-time; null clears it.`),
      endsAt: z.string().nullable().optional().describe(`${periodWord("endsAt", "Ends")}: a date (yyyy-mm-dd) or an ISO-8601 date-time; null clears it.`),
      ...declaredPeriodParams,
    }),
    async execute(input, ctx) {
      requireDb();
      const { id, ...body } = input as Record<string, unknown> & { id?: string };
      const org = await orgForSession(ctx);
      const r = await writePeriodTool(org, callerEmail(ctx), id ?? null, body);
      return { ...(id ? { updated: true as const } : { created: true as const }), cycle: declaredPeriodOut(r.row), ...(r.warnings.length ? { warnings: r.warnings.map((w) => w.message) } : {}) };
    },
  })
  : !WORK_PERIODS.individual
  ? defineTool({
    description:
      "Create OR update a cycle ({period}) — a time-boxed window that groups todos. Omit `id` to create; pass `id` to update. Then file todos into it with upsert_todo (cycleId).",
    approval: once(),
    inputSchema: z.object({
      id: z.string().optional().describe("Cycle id to update; omit to create."),
      name: z.string().min(1).max(200).optional().describe(fill("Required when creating, e.g. '{Period} 12'.")),
      startsAt: z.string().datetime({ offset: true }).nullable().optional(),
      endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    }),
    async execute({ id, name, startsAt, endsAt }, ctx) {
      const db = requireDb();
      const fields: Record<string, unknown> = {};
      if (name !== undefined) fields.name = name;
      if (startsAt !== undefined) fields.startsAt = startsAt ? new Date(startsAt) : null;
      if (endsAt !== undefined) fields.endsAt = endsAt ? new Date(endsAt) : null;
      if (id) {
        const org = await orgForSession(ctx);
        // Who may change a period (records.areas.periods.permissions); nothing read when undeclared.
        const refusal = await withOrgDb(org, (tx) => periodRefusal(tx, org, { actor: callerEmail(ctx) }, "update", { id, patch: fields }));
        if (refusal) throw new Error(`Nothing was written. ${refusal}`);
        const [c] = await withOrgDb(org, (tx) =>
          tx.update(cycles).set({ ...fields, updatedAt: new Date() }).where(and(eq(cycles.id, id), eq(cycles.orgId, org))).returning(),
        );
        if (!c) throw new Error(`No cycle with id "${id}".`);
        return { updated: true as const, cycle: { id: c.id, name: c.name } };
      }
      const cycleOrg = await orgForSession(ctx);
      const refusal = await withOrgDb(cycleOrg, (tx) => periodRefusal(tx, cycleOrg, { actor: callerEmail(ctx) }, "create", { patch: fields }));
      if (refusal) throw new Error(`Nothing was written. ${refusal}`);
      const [c] = await withOrgDb(cycleOrg, async (tx) => {
        // The workspace's length (its admin's choice, else the profile's): a new cycle given no dates runs that long.
        const window = startsAt === undefined && endsAt === undefined ? await newPeriodWindow(tx, cycleOrg) : null;
        if (!fields.name && !window) throw new Error("Creating a cycle needs a `name`.");
        return tx
          .insert(cycles)
          .values({ ...(window ? { name: window.name, startsAt: window.startsAt, endsAt: window.endsAt } : {}), ...(fields as { name: string }), orgId: cycleOrg, createdBy: callerEmail(ctx) })
          .returning();
      });
      return { created: true as const, cycle: { id: c.id, name: c.name } };
    },
  })
  : (defineTool({
    description:
      "Create OR update a {period} (a cycle: a time-boxed window people hold their own {period_items} in), or set one person's goal for it. Omit `id` to create a {period}; pass `id` to update it. With `id` you may also set `goal` and `planned` for `person` (the signed-in person when omitted); you may only do that for yourself or for a person who reports to you on the roster. A {period} has no shared lead and no team capacity. Add a {period_item} with upsert_todo (cycleId).",
    approval: once(),
    inputSchema: z.object({
      id: z.string().optional().describe(fill("Cycle id to update, or \"current\" for the {period} that contains today; omit to create.")),
      name: z.string().min(1).max(200).optional().describe(fill("Required when creating, e.g. '{Period} 12'.")),
      startsAt: z.string().datetime({ offset: true }).nullable().optional(),
      endsAt: z.string().datetime({ offset: true }).nullable().optional(),
      person: z.string().email().optional().describe("Whose goal to set, by email. Omit for the signed-in person."),
      goal: z.string().max(2000).nullable().optional().describe(fill("What the person means to get done in this {period}; null clears it.")),
      planned: z.number().int().min(0).max(1000).nullable().optional().describe(fill("How many {period_items} the person planned for this {period}; null clears it.")),
      // A declared period's state and own fields (agent/lib/period-area.ts); none otherwise.
      ...declaredPeriodParams,
    }),
    async execute(input, ctx) {
      const { id, name, startsAt, endsAt, person, goal, planned } = input as { id?: string; name?: string; startsAt?: string | null; endsAt?: string | null; person?: string; goal?: string | null; planned?: number | null };
      const db = requireDb();
      const org = await orgForSession(ctx);
      const actor = callerEmail(ctx).toLowerCase();
      // A declared period's own fields and state go through its one write path, beside the person's goal below.
      const declared: Record<string, unknown> = PERIODS_DECLARED
        ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([k, x]) => x !== undefined && (k === "state" || k === "custom" || k === "reason" || PERIOD_COLUMNS.some((f) => f.key === k))))
        : {};
      const fields: Record<string, unknown> = {};
      if (name !== undefined) fields.name = name;
      if (startsAt !== undefined) fields.startsAt = startsAt ? new Date(startsAt) : null;
      if (endsAt !== undefined) fields.endsAt = endsAt ? new Date(endsAt) : null;
      const setsGoal = goal !== undefined || planned !== undefined;
      return withOrgDb(org, async (tx) => {
        let cycleId = id;
        let row: { id: string; name: string } | undefined;
        if (cycleId === "current") {
          const period = await ensureCurrentPeriod(tx, org, actor);
          if (!period) throw new Error(`There is no current ${WORK_PERIODS.label.singular}. Create one first (omit \`id\`, give a \`name\`).`);
          cycleId = period.id;
        }
        if (PERIODS_DECLARED && (!cycleId || Object.keys(fields).length || Object.keys(declared).length)) {
          // A declared period: one write through the validator (who may, the definition, the lifecycle).
          const body = { ...(name !== undefined ? { name } : {}), ...(startsAt !== undefined ? { startsAt } : {}), ...(endsAt !== undefined ? { endsAt } : {}), ...declared };
          row = (await writePeriodTool(org, actor, cycleId ?? null, body, tx)).row;
        } else if (cycleId) {
          if (Object.keys(fields).length) {
            // Who may change a period (records.areas.periods.permissions); nothing read when undeclared.
            const refusal = await periodRefusal(tx, org, { actor }, "update", { id: cycleId, patch: fields });
            if (refusal) throw new Error(`Nothing was written. ${refusal}`);
            [row] = await tx.update(cycles).set({ ...fields, updatedAt: new Date() }).where(and(eq(cycles.id, cycleId), eq(cycles.orgId, org))).returning();
          } else {
            [row] = await tx.select().from(cycles).where(and(eq(cycles.id, cycleId), eq(cycles.orgId, org)));
          }
          if (!row) throw new Error(`No cycle with id "${cycleId}".`);
        } else {
          // The workspace's length (its admin's choice, else the profile's): a new {period} given no dates runs that long.
          const refusal = await periodRefusal(tx, org, { actor }, "create", { patch: fields });
          if (refusal) throw new Error(`Nothing was written. ${refusal}`);
          const window = startsAt === undefined && endsAt === undefined ? await newPeriodWindow(tx, org) : null;
          if (!fields.name && !window) throw new Error("Creating a cycle needs a `name`.");
          [row] = await tx.insert(cycles).values({ ...(window ? { name: window.name, startsAt: window.startsAt, endsAt: window.endsAt } : {}), ...(fields as { name: string }), orgId: org, createdBy: actor }).returning();
        }
        if (!setsGoal) return id ? { updated: true as const, cycle: { id: row.id, name: row.name } } : { created: true as const, cycle: { id: row.id, name: row.name } };
        const set = await setMemberGoal(tx, org, actor, { cycleId: row.id, member: person ?? actor, goal, targetCount: planned });
        if ("refused" in set) throw new Error(set.refused);
        return { updated: true as const, cycle: { id: row.id, name: row.name }, person: set.item.member, goal: set.item.goal, planned: set.item.targetCount };
      });
    },
  }) as never));
