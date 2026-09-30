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
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { todos } from "./db/schema.ts";
import { orgForSession } from "./org-context.ts";
import { taskWorkflowRequest } from "./task-workflow-service.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

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

export const upsertTodoTool = modelFacing("upsert_todo", defineTool({
  description:
    "Create OR update a TODO — the FDE team's internal checklist item (NOT a customer ticket; use create_ticket for those). Omit `id` to create; pass `id` to update just the fields you provide. A todo can be filed under a Deployment or Implementation (the 'epic' — set container*), linked to a related object (a ticket/customer/app/cron/workflow/chat — set link*), assigned, prioritised, and given a due date. Use this for 'remind me to X', 'add a todo to Y', or to mark one done.",
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
    cycleId: z.string().nullable().optional().describe("The cycle (sprint) id from list_cycles; null = backlog."),
  }),
  async execute(input, ctx) {
    const { id, ...fields } = input;
    const orgId = await orgForSession(ctx);
    const actor = callerEmail(ctx);

    if (id) {
      const item = await taskWorkflowRequest<{ id: string; title: string; done: boolean }>(
        orgId,
        actor,
        `/api/v1/tasks/${encodeURIComponent(id)}`,
        { method: "PATCH", body: fields },
      );
      return { updated: true as const, todo: { id: item.id, title: item.title, done: item.done } };
    }

    if (!fields.title) throw new Error("Creating a todo needs a `title`.");
    const item = await taskWorkflowRequest<{ id: string; title: string }>(
      orgId,
      actor,
      "/api/v1/tasks",
      { method: "POST", body: fields },
    );
    return { created: true as const, todo: { id: item.id, title: item.title } };
  },
}));

export const listTodosTool = modelFacing("list_todos", defineTool({
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
}));

export const hideTodoTool = modelFacing("hide_todo", defineTool({
  description:
    "Hide a TODO — archives it (soft delete; recoverable), removing it from the list. Use list_todos to get the id.",
  approval: once(),
  inputSchema: z.object({ id: z.string().min(1).describe("The todo id from list_todos.") }),
  async execute({ id }, ctx) {
    const item = await taskWorkflowRequest<{ id: string; title: string }>(
      await orgForSession(ctx),
      callerEmail(ctx),
      `/api/v1/tasks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: { archived: true } },
    );
    return { hidden: true as const, id: item.id, title: item.title };
  },
}));

import { cycles } from "./db/schema.ts";

export const listCyclesTool = modelFacing("list_cycles", defineTool({
  description:
    "List the team's cycles (sprints) — for filing todos into with upsert_todo. Returns id, name, and window.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const db = requireDb();
    // Was unscoped in both senses: no workspace resolved, and no org filter on
    // the query — so this listed every workspace's cycles.
    const orgId = await orgForSession(ctx);
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(cycles)
        .where(and(eq(cycles.orgId, orgId), isNull(cycles.archivedAt)))
        .orderBy(desc(cycles.createdAt)),
    );
    return {
      cycles: rows.map((c) => ({
        id: c.id,
        name: c.name,
        startsAt: c.startsAt?.toISOString() ?? null,
        endsAt: c.endsAt?.toISOString() ?? null,
      })),
    };
  },
}));

export const upsertCycleTool = modelFacing("upsert_cycle", defineTool({
  description:
    "Create OR update a cycle (sprint) — a time-boxed window that groups todos. Omit `id` to create; pass `id` to update. Then file todos into it with upsert_todo (cycleId).",
  approval: once(),
  inputSchema: z.object({
    id: z.string().optional().describe("Cycle id to update; omit to create."),
    name: z.string().min(1).max(200).optional().describe("Required when creating, e.g. 'Sprint 12'."),
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
      const [c] = await withOrgDb(org, (tx) =>
        tx.update(cycles).set({ ...fields, updatedAt: new Date() }).where(and(eq(cycles.id, id), eq(cycles.orgId, org))).returning(),
      );
      if (!c) throw new Error(`No cycle with id "${id}".`);
      return { updated: true as const, cycle: { id: c.id, name: c.name } };
    }
    if (!fields.name) throw new Error("Creating a cycle needs a `name`.");
    const cycleOrg = await orgForSession(ctx);
    const [c] = await withOrgDb(cycleOrg, (tx) =>
      tx
        .insert(cycles)
        .values({ ...(fields as { name: string }), orgId: cycleOrg, createdBy: callerEmail(ctx) })
        .returning(),
    );
    return { created: true as const, cycle: { id: c.id, name: c.name } };
  },
}));
