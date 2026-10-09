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
import { fill } from "./agent-vocabulary.ts";
import { WORK_PERIODS, currentPeriod, progressByPerson } from "./work-periods.ts";
import { ensureCurrentPeriod, goalsFor, newPeriodWindow, rollOverEnded, setMemberGoal, taskWriteRefusal } from "./work-period-store.ts";

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
    const { id, ...fields } = input as typeof input & { cycleId?: string | null };
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
export const listCyclesTool = modelFacing("list_cycles", !WORK_PERIODS.individual
  ? defineTool({
    description:
      "List the team's cycles ({periods}) — for filing todos into with upsert_todo. Returns id, name, and window.",
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
      return {
        cycles: rows.map((c) => ({
          id: c.id,
          name: c.name,
          startsAt: c.startsAt?.toISOString() ?? null,
          endsAt: c.endsAt?.toISOString() ?? null,
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

export const upsertCycleTool = modelFacing("upsert_cycle", !WORK_PERIODS.individual
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
        const [c] = await withOrgDb(org, (tx) =>
          tx.update(cycles).set({ ...fields, updatedAt: new Date() }).where(and(eq(cycles.id, id), eq(cycles.orgId, org))).returning(),
        );
        if (!c) throw new Error(`No cycle with id "${id}".`);
        return { updated: true as const, cycle: { id: c.id, name: c.name } };
      }
      const cycleOrg = await orgForSession(ctx);
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
    }),
    async execute({ id, name, startsAt, endsAt, person, goal, planned }, ctx) {
      const db = requireDb();
      const org = await orgForSession(ctx);
      const actor = callerEmail(ctx).toLowerCase();
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
        if (cycleId) {
          if (Object.keys(fields).length) {
            [row] = await tx.update(cycles).set({ ...fields, updatedAt: new Date() }).where(and(eq(cycles.id, cycleId), eq(cycles.orgId, org))).returning();
          } else {
            [row] = await tx.select().from(cycles).where(and(eq(cycles.id, cycleId), eq(cycles.orgId, org)));
          }
          if (!row) throw new Error(`No cycle with id "${cycleId}".`);
        } else {
          // The workspace's length (its admin's choice, else the profile's): a new {period} given no dates runs that long.
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
