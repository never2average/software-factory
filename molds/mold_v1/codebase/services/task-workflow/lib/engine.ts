import type postgres from "postgres";
import { ensureVersion } from "@/lib/definitions";
import {
  allowedManualTransition,
  findRequestedStage,
  legacyStatusForStage,
} from "@/lib/stages";
import { recordTaskChanges } from "@/lib/task-activity";
import type {
  AssignRule,
  ServiceContext,
  TaskCreateInput,
  TaskPatchInput,
  WorkflowDefinitionRow,
  WorkflowStage,
} from "@/lib/types";

export interface TaskRow {
  id: string;
  org_id: string;
  title: string;
  notes: string | null;
  done: boolean;
  done_at: Date | null;
  status: string;
  priority: string;
  due_at: Date | null;
  container_type: string | null;
  container_id: string | null;
  container_label: string | null;
  link_type: string | null;
  link_id: string | null;
  link_label: string | null;
  created_by: string;
  assignee: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface InstanceRow {
  task_id: string;
  workflow_id: string;
  workflow_version_id: string;
  stage_id: string;
  state: string;
  automation_state: string;
}

interface VersionRow {
  id: string;
  stages: WorkflowStage[];
}

interface TransitionTargetRow {
  workflow_version_id: string;
  to_stage_id: string;
}

interface TaskListRow extends TaskRow {
  workflow_id: string | null;
  workflow_version_id: string | null;
  workflow_stage_id: string | null;
  automation_state: string | null;
  workflow_stages: WorkflowStage[] | null;
}

export interface StageAutomationInput {
  orgId: string;
  taskId: string;
  transitionEventId: string;
}

function toTaskDto(task: TaskRow, workflow?: { stageId: string; stageLabel: string; workflowId: string; automationState: string } | null) {
  return {
    id: task.id,
    orgId: task.org_id,
    title: task.title,
    notes: task.notes,
    done: task.done,
    doneAt: task.done_at?.toISOString() ?? null,
    status: task.status,
    priority: task.priority,
    dueAt: task.due_at?.toISOString() ?? null,
    containerType: task.container_type,
    containerId: task.container_id,
    containerLabel: task.container_label,
    linkType: task.link_type,
    linkId: task.link_id,
    linkLabel: task.link_label,
    createdBy: task.created_by,
    assignee: task.assignee,
    cycleId: task.cycle_id,
    parentId: task.parent_id,
    archivedAt: task.archived_at?.toISOString() ?? null,
    createdAt: task.created_at.toISOString(),
    updatedAt: task.updated_at.toISOString(),
    workflow: workflow ?? null,
  };
}

async function readTask(sql: postgres.TransactionSql, orgId: string, taskId: string, lock = false): Promise<TaskRow | null> {
  const rows = lock
    ? await sql<TaskRow[]>`select * from todos where id = ${taskId} and org_id = ${orgId} for update`
    : await sql<TaskRow[]>`select * from todos where id = ${taskId} and org_id = ${orgId}`;
  return rows[0] ?? null;
}

async function defaultTaskWorkflow(sql: postgres.TransactionSql, orgId: string): Promise<WorkflowDefinitionRow | null> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:task-workflow`}, 0))`;
  const [row] = await sql<WorkflowDefinitionRow[]>`
    select id, org_id, name, entity, stages, current_version, is_default,
           created_by, created_at, updated_at
      from workflow_definitions
     where org_id = ${orgId} and entity = 'task' and archived_at is null
     order by is_default desc, updated_at desc
     limit 1`;
  if (row) return row;

  const id = `pwf_${crypto.randomUUID().replaceAll("-", "")}`;
  const stages: WorkflowStage[] = [
    { id: "backlog", label: "Backlog", description: "Captured but not yet started.", assign: { type: "none" }, transitions: [{ to: "open", migrate: { type: "manual" } }] },
    { id: "open", label: "Open", description: "Ready to be picked up.", assign: { type: "least_loaded" }, transitions: [{ to: "in_progress", migrate: { type: "manual" } }] },
    { id: "in_progress", label: "In progress", description: "Actively being worked.", assign: { type: "none" }, transitions: [{ to: "blocked", migrate: { type: "manual" } }, { to: "done", migrate: { type: "manual" } }] },
    { id: "blocked", label: "Blocked", description: "Waiting on someone or something.", assign: { type: "none" }, transitions: [{ to: "in_progress", migrate: { type: "manual" } }] },
    { id: "done", label: "Done", description: "Completed and verified.", assign: { type: "none" }, transitions: [] },
  ];
  const [created] = await sql<WorkflowDefinitionRow[]>`
    insert into workflow_definitions
      (id, org_id, name, entity, stages, current_version, is_default, created_by)
    values
      (${id}, ${orgId}, 'Default task workflow', 'task', ${sql.json(stages)}, 1, true, 'task-workflow-service')
    returning id, org_id, name, entity, stages, current_version, is_default,
              created_by, created_at, updated_at`;
  return created ?? null;
}

async function recordActivity(sql: postgres.TransactionSql, ctx: ServiceContext, taskId: string, event: string): Promise<void> {
  await sql`insert into entity_activity (org_id, entity_type, entity_id, actor, event)
            values (${ctx.orgId}, 'task', ${taskId}, ${ctx.actor}, ${event})`;
}

export async function listTasks(sql: postgres.TransactionSql, orgId: string) {
  const rows = await sql<TaskListRow[]>`
    select t.*,
           i.workflow_id, i.workflow_version_id, i.stage_id as workflow_stage_id,
           i.automation_state, v.stages as workflow_stages
      from todos t
      left join task_workflow_instances i
        on i.task_id = t.id and i.org_id = t.org_id
      left join project_workflow_versions v
        on v.id = i.workflow_version_id and v.org_id = i.org_id
     where t.org_id = ${orgId} and t.archived_at is null
     order by t.created_at desc`;
  return rows.map((task) => {
    const stage = task.workflow_stages?.find((candidate) => candidate.id === task.workflow_stage_id);
    const workflow = task.workflow_id && task.workflow_stage_id
      ? {
          workflowId: task.workflow_id,
          stageId: task.workflow_stage_id,
          stageLabel: stage?.label ?? task.workflow_stage_id,
          automationState: task.automation_state ?? "idle",
        }
      : null;
    return toTaskDto(task, workflow);
  });
}

export async function createTask(sql: postgres.TransactionSql, ctx: ServiceContext, input: TaskCreateInput) {
  const workflow = await defaultTaskWorkflow(sql, ctx.orgId);
  const initialStage = workflow?.stages[0] ?? null;
  const status = initialStage ? legacyStatusForStage(initialStage) : input.status ?? "open";
  const done = status === "done";
  const [task] = await sql<TaskRow[]>`
    insert into todos
      (org_id, cycle_id, parent_id, title, notes, done, done_at, status, priority,
       due_at, container_type, container_id, container_label, link_type, link_id,
       link_label, created_by, assignee)
    values
      (${ctx.orgId}, ${input.cycleId ?? null}, ${input.parentId ?? null}, ${input.title}, ${input.notes ?? null},
       ${done}, ${done ? new Date() : null}, ${status}, ${input.priority}, ${input.dueAt ? new Date(input.dueAt) : null},
       ${input.containerType ?? null}, ${input.containerId ?? null}, ${input.containerLabel ?? null},
       ${input.linkType ?? null}, ${input.linkId ?? null}, ${input.linkLabel ?? null}, ${ctx.actor}, ${input.assignee ?? null})
    returning *`;
  if (!task) throw new Error("Invalid: Task was not created");
  // Recorded for EVERY task, not only workflow-backed ones. Creation was
  // previously implied by "Workflow entered <stage>", which never fires for a
  // task with no workflow attached — so most tasks' feeds began mid-story.
  await recordActivity(sql, ctx, task.id, `Task created: ${input.title}`);
  if (!workflow || !initialStage) return { item: toTaskDto(task), automation: null };

  const version = await ensureVersion(sql, workflow, ctx.actor);
  const automationState = initialStage.assign.type === "none" ? "idle" : "queued";
  await sql`
    insert into task_workflow_instances
      (task_id, org_id, workflow_id, workflow_version_id, stage_id, state, automation_state)
    values
      (${task.id}, ${ctx.orgId}, ${workflow.id}, ${version.id}, ${initialStage.id},
       ${initialStage.transitions.length === 0 ? "completed" : "active"}, ${automationState})`;
  const [event] = await sql<{ id: string }[]>`
    insert into task_workflow_transition_events
      (org_id, task_id, workflow_id, workflow_version_id, from_stage_id, to_stage_id, trigger, actor, reason)
    values
      (${ctx.orgId}, ${task.id}, ${workflow.id}, ${version.id}, null, ${initialStage.id}, 'create', ${ctx.actor}, 'Task entered its initial workflow stage')
    returning id`;
  await recordActivity(sql, ctx, task.id, `Workflow entered ${initialStage.label}`);
  return {
    item: toTaskDto(task, {
      workflowId: workflow.id,
      stageId: initialStage.id,
      stageLabel: initialStage.label,
      automationState,
    }),
    automation: event && automationState === "queued"
      ? { orgId: ctx.orgId, taskId: task.id, transitionEventId: event.id }
      : null,
  };
}

function buildTaskUpdate(input: TaskPatchInput): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const direct: [keyof TaskPatchInput, string][] = [
    ["title", "title"], ["notes", "notes"], ["priority", "priority"],
    ["containerType", "container_type"], ["containerId", "container_id"], ["containerLabel", "container_label"],
    ["linkType", "link_type"], ["linkId", "link_id"], ["linkLabel", "link_label"],
    ["assignee", "assignee"], ["cycleId", "cycle_id"], ["parentId", "parent_id"],
  ];
  for (const [source, target] of direct) if (input[source] !== undefined) update[target] = input[source];
  if (input.dueAt !== undefined) update.due_at = input.dueAt ? new Date(input.dueAt) : null;
  if (input.archived !== undefined) update.archived_at = input.archived ? new Date() : null;
  return update;
}

async function updateTaskRow(sql: postgres.TransactionSql, orgId: string, taskId: string, update: Record<string, unknown>): Promise<TaskRow> {
  update.updated_at = new Date();
  const [row] = await sql<TaskRow[]>`
    update todos set ${sql(update)} where id = ${taskId} and org_id = ${orgId} returning *`;
  if (!row) throw new Error("Not found: Task not found");
  return row;
}

export async function updateTask(sql: postgres.TransactionSql, ctx: ServiceContext, taskId: string, input: TaskPatchInput) {
  const before = await readTask(sql, ctx.orgId, taskId, true);
  if (!before) throw new Error("Not found: Task not found");
  const [instance] = await sql<InstanceRow[]>`
    select task_id, workflow_id, workflow_version_id, stage_id, state, automation_state
      from task_workflow_instances
     where task_id = ${taskId} and org_id = ${ctx.orgId}
     for update`;
  const update = buildTaskUpdate(input);
  let workflowDto: { stageId: string; stageLabel: string; workflowId: string; automationState: string } | null = null;
  let automation: StageAutomationInput | null = null;
  const requested = input.stageId ?? input.status ?? (input.done === true ? "done" : input.done === false ? "open" : null);

  if (instance) {
    const [version] = await sql<VersionRow[]>`
      select id, stages from project_workflow_versions
       where id = ${instance.workflow_version_id} and org_id = ${ctx.orgId}`;
    if (!version) throw new Error("Conflict: The task's workflow version no longer exists");
    const current = version.stages.find((stage) => stage.id === instance.stage_id);
    if (!current) throw new Error("Conflict: The task's current stage no longer exists");
    let stage = current;
    if (requested) {
      const target = findRequestedStage(version.stages, requested);
      if (!target) throw new Error(`Invalid: No workflow stage matches "${requested}"`);
      if (target.id !== current.id) {
        if (!allowedManualTransition(current, target)) {
          throw new Error(`Conflict: ${current.label} cannot be moved manually to ${target.label}`);
        }
        if (input.idempotencyKey) {
          const [seen] = await sql<{ id: string }[]>`
            select id from task_workflow_transition_events
             where org_id = ${ctx.orgId} and idempotency_key = ${input.idempotencyKey} limit 1`;
          if (seen) {
            return {
              item: toTaskDto(before, {
                stageId: current.id,
                stageLabel: current.label,
                workflowId: instance.workflow_id,
                automationState: instance.automation_state,
              }),
              automation: null,
              idempotent: true,
            };
          }
        }
        const status = legacyStatusForStage(target);
        update.status = status;
        update.done = status === "done";
        update.done_at = status === "done" ? new Date() : null;
        const automationState = target.assign.type === "none" ? "idle" : "queued";
        await sql`
          update task_workflow_instances
             set stage_id = ${target.id}, state = ${target.transitions.length === 0 ? "completed" : "active"},
                 automation_state = ${automationState}, stage_entered_at = now(), updated_at = now()
           where task_id = ${taskId} and org_id = ${ctx.orgId}`;
        const [event] = await sql<{ id: string }[]>`
          insert into task_workflow_transition_events
            (org_id, task_id, workflow_id, workflow_version_id, from_stage_id, to_stage_id,
             trigger, actor, reason, idempotency_key)
          values
            (${ctx.orgId}, ${taskId}, ${instance.workflow_id}, ${instance.workflow_version_id}, ${current.id}, ${target.id},
             'manual', ${ctx.actor}, ${input.reason ?? null}, ${input.idempotencyKey ?? null})
          returning id`;
        await recordActivity(sql, ctx, taskId, `Workflow moved ${current.label} → ${target.label}`);
        stage = target;
        workflowDto = { stageId: target.id, stageLabel: target.label, workflowId: instance.workflow_id, automationState };
        automation = event && automationState === "queued"
          ? { orgId: ctx.orgId, taskId, transitionEventId: event.id }
          : null;
      }
    }
    workflowDto ??= {
      stageId: stage.id,
      stageLabel: stage.label,
      workflowId: instance.workflow_id,
      automationState: instance.automation_state,
    };
  } else if (requested) {
    const status = input.status ?? (input.done ? "done" : "open");
    update.status = status;
    update.done = status === "done";
    update.done_at = status === "done" ? new Date() : null;
  }

  const task = await updateTaskRow(sql, ctx.orgId, taskId, update);
  await recordTaskChanges(sql, ctx, taskId, before, task);
  return { item: toTaskDto(task, workflowDto), automation };
}

export async function deleteTask(sql: postgres.TransactionSql, ctx: ServiceContext, taskId: string): Promise<void> {
  const rows = await sql<{ id: string; title: string }[]>`
    delete from todos
     where org_id = ${ctx.orgId} and (id = ${taskId} or parent_id = ${taskId})
     returning id, title`;
  if (rows.length === 0) throw new Error("Not found: Task not found");
  /**
   * The activity feed is append-only and OUTLIVES the row it describes, which
   * is the point: "who deleted this, and when" is unanswerable from a table the
   * delete emptied. Subtasks cascade here, so each one is named — a parent
   * vanishing with three children is three disappearances to explain.
   */
  for (const row of rows) {
    await recordActivity(sql, ctx, row.id, `Task deleted: ${row.title}`);
  }
}

async function leastLoaded(
  sql: postgres.TransactionSql,
  orgId: string,
  filter: { role?: string; team?: string },
): Promise<string | null> {
  if (filter.role) {
    const [candidate] = await sql<{ email: string }[]>`
      select m.email
        from org_members m
        left join todos t on lower(t.assignee) = lower(m.email)
          and t.org_id = m.org_id and t.archived_at is null and t.done = false
       where m.org_id = ${orgId} and m.role = ${filter.role}
       group by m.email
       order by count(t.id), lower(m.email)
       limit 1`;
    return candidate?.email ?? null;
  }
  const [candidate] = await sql<{ email: string }[]>`
    select r.email
      from people_roster r
      left join todos t on lower(t.assignee) = lower(r.email)
        and t.org_id = ${orgId} and t.archived_at is null and t.done = false
     where r.org_id = ${orgId} and r.archived_at is null
       and (${filter.team ?? null}::text is null or r.team = ${filter.team ?? null})
     group by r.email
     order by count(t.id), lower(r.email)
     limit 1`;
  return candidate?.email ?? null;
}

async function resolveAssignment(sql: postgres.TransactionSql, orgId: string, task: TaskRow, rule: AssignRule): Promise<string | null | "needs_review"> {
  switch (rule.type) {
    case "none":
      return task.assignee;
    case "person":
      return rule.value.toLowerCase();
    case "role":
      return leastLoaded(sql, orgId, { role: rule.value });
    case "team":
      return leastLoaded(sql, orgId, { team: rule.value });
    case "least_loaded":
      return leastLoaded(sql, orgId, { team: rule.department ?? rule.value });
    case "customer_owner": {
      const customerId = task.link_type === "customer"
        ? task.link_id
        : task.container_type === "implementation"
          ? task.container_id
          : null;
      if (!customerId) return "needs_review";
      // The neutral owner column, else the original (drizzle/0028_neutral_owner_columns.sql keeps them equal).
      const [customer] = await sql<{ owner: string | null }[]>`
        select coalesce(account_owner, fde_owner) as owner from customers where customer_id = ${customerId} and org_id = ${orgId} limit 1`;
      return customer?.owner?.toLowerCase() ?? "needs_review";
    }
    case "prompt":
      return "needs_review";
  }
}

export async function applyStageAssignment(input: StageAutomationInput): Promise<{ status: string; assignee: string | null }> {
  const { withOrgTransaction } = await import("@/lib/db");
  return withOrgTransaction(input.orgId, async (sql) => {
    const task = await readTask(sql, input.orgId, input.taskId, true);
    if (!task) throw new Error("Not found: Task not found during stage automation");
    const [instance] = await sql<InstanceRow[]>`
      select task_id, workflow_id, workflow_version_id, stage_id, state, automation_state
        from task_workflow_instances
       where task_id = ${input.taskId} and org_id = ${input.orgId}
       for update`;
    if (!instance) throw new Error("Not found: Workflow instance not found during stage automation");
    const [transition] = await sql<TransitionTargetRow[]>`
      select workflow_version_id, to_stage_id
        from task_workflow_transition_events
       where id = ${input.transitionEventId}
         and task_id = ${input.taskId}
         and org_id = ${input.orgId}
       limit 1`;
    if (!transition) throw new Error("Not found: Workflow transition not found during stage automation");
    if (
      instance.workflow_version_id !== transition.workflow_version_id
      || instance.stage_id !== transition.to_stage_id
    ) {
      return { status: "stale", assignee: task.assignee };
    }
    const [version] = await sql<VersionRow[]>`
      select id, stages from project_workflow_versions
       where id = ${transition.workflow_version_id} and org_id = ${input.orgId}`;
    const stage = version?.stages.find((item) => item.id === transition.to_stage_id);
    if (!stage) throw new Error("Conflict: Workflow stage not found during stage automation");
    const resolved = await resolveAssignment(sql, input.orgId, task, stage.assign);
    if (resolved === "needs_review" || (!resolved && stage.assign.type !== "none")) {
      await sql`update task_workflow_instances set automation_state = 'needs_review', updated_at = now()
                 where task_id = ${input.taskId} and org_id = ${input.orgId}`;
      return { status: "needs_review", assignee: task.assignee };
    }
    if (resolved !== task.assignee) {
      await sql`update todos set assignee = ${resolved}, updated_at = now()
                 where id = ${input.taskId} and org_id = ${input.orgId}`;
      await sql`insert into entity_activity (org_id, entity_type, entity_id, actor, event)
                values (${input.orgId}, 'task', ${input.taskId}, 'task-workflow-service',
                        ${`Workflow assigned ${resolved ?? "unassigned"}`})`;
    }
    await sql`update task_workflow_instances set automation_state = 'completed', updated_at = now()
               where task_id = ${input.taskId} and org_id = ${input.orgId}`;
    return { status: "completed", assignee: resolved };
  });
}

export async function markAutomationFailed(input: StageAutomationInput, error: unknown): Promise<void> {
  const { withOrgTransaction } = await import("@/lib/db");
  await withOrgTransaction(input.orgId, async (sql) => {
    await sql`
      update task_workflow_instances as instance
         set automation_state = 'failed', updated_at = now()
        from task_workflow_transition_events as transition
       where transition.id = ${input.transitionEventId}
         and transition.task_id = ${input.taskId}
         and transition.org_id = ${input.orgId}
         and instance.task_id = transition.task_id
         and instance.org_id = transition.org_id
         and instance.workflow_version_id = transition.workflow_version_id
         and instance.stage_id = transition.to_stage_id`;
    console.error("Stage automation could not be enqueued", { taskId: input.taskId, error });
  });
}
