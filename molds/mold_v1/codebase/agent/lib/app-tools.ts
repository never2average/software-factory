/**
 * The APPS tools: `create_app`, `list_apps`, `update_app` (re-exported from
 * snake_case files under `agent/tools/` so the model-facing names come from the
 * filenames).
 *
 * An app is a LIVING DOCUMENT: Markdown the agent regenerates on a cadence and
 * the Ops Center renders read-only. The content is produced either by a
 * workflow script or by a prompt; the `refresh-apps` cron runs whichever is set
 * and stores the Markdown on the row. These tools only manage the DEFINITION —
 * they never generate content themselves (the refresh does that).
 *
 * Relative `.ts` specifiers, same as schedule-tools.ts, so the module runs under
 * plain `node --experimental-strip-types`.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { apps } from "./db/schema.ts";
import { orgForSession } from "./org-context.ts";
import { cronMatches } from "./cron-match.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

/** The author comes from the verified session auth, never from the model. */
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

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("Apps need a database — DATABASE_URL is not configured.");
  return db;
}

/** Refuse an unparseable cadence up front; it would silently never fire. */
function assertCron(expr: string | null | undefined): string | null {
  const v = expr?.trim();
  if (!v) return null;
  cronMatches(v, new Date());
  return v;
}

export const createAppTool = modelFacing("create_app", defineTool({
  description:
    "Create an APP — a living Markdown document that is REGENERATED on a cadence and rendered read-only in the Ops Center's Apps tab. Use this when someone wants a standing report/dashboard that stays current (e.g. 'a daily at-risk accounts digest'), rather than a one-off answer. Content comes from either a PROMPT (one agent call each refresh; simplest) or a WORKFLOW (a saved workflow script whose return value is the document). Set `refreshCron` (5-field UTC) to refresh automatically; omit it for manual-only. This creates the DEFINITION — the first document appears after the first refresh.",
  approval: once(),
  inputSchema: z.object({
    name: z.string().min(1).max(200).describe("Short human label, e.g. 'Portfolio health digest'."),
    description: z
      .string()
      .max(500)
      .optional()
      .describe("Optional one-line summary of what the document is for."),
    sourceKind: z
      .enum(["prompt", "workflow"])
      .default("prompt")
      .describe("'prompt' = one agent call per refresh. 'workflow' = run a saved workflow script."),
    prompt: z
      .string()
      .max(4000)
      .optional()
      .describe("Required when sourceKind='prompt': what to generate each refresh. Ask for Markdown."),
    workflow: z
      .string()
      .optional()
      .describe("Required when sourceKind='workflow': the workflows.name to run."),
    subagent: z
      .string()
      .optional()
      .describe("Optional subagent to run a prompt as (omit for the orchestrator)."),
    refreshCron: z
      .string()
      .optional()
      .describe("UTC 5-field cron for automatic refresh, e.g. '0 7 * * *' (daily 07:00). Omit for manual-only."),
    customerId: z
      .string()
      .optional()
      .describe("Optional customer slug scope, e.g. 'acme-bank' (omit for team-wide)."),
  }),
  async execute(input, ctx) {
    const db = requireDb();
    if (input.sourceKind === "workflow" && !input.workflow?.trim()) {
      throw new Error("sourceKind='workflow' needs `workflow` (the workflow name to run).");
    }
    if (input.sourceKind === "prompt" && !input.prompt?.trim()) {
      throw new Error("sourceKind='prompt' needs `prompt` (what to generate).");
    }
    const refreshCron = assertCron(input.refreshCron);
    const orgId = await orgForSession(ctx);
    const [app] = await withOrgDb(orgId, (tx) =>
      tx
        .insert(apps)
        .values({
          orgId,
          slug: slugify(input.name),
          name: input.name,
          description: input.description ?? null,
          sourceKind: input.sourceKind,
          prompt: input.sourceKind === "prompt" ? (input.prompt ?? null) : null,
          workflow: input.sourceKind === "workflow" ? (input.workflow ?? null) : null,
          subagent: input.subagent ?? null,
          refreshCron,
          customerId: input.customerId ?? null,
          createdBy: callerEmail(ctx),
        })
        .returning(),
    );
    return {
      created: true as const,
      app: { id: app.id, slug: app.slug, name: app.name, refreshCron: app.refreshCron },
      note: refreshCron
        ? "It will refresh on its cadence; open the Apps tab to read it."
        : "No cadence set — refresh it from the Apps tab to generate the first document.",
    };
  },
}));

export const listAppsTool = modelFacing("list_apps", defineTool({
  description:
    "List the APPS (living Markdown documents regenerated on a cadence) with their source, cadence, and when each was last refreshed. Use before updating one, or to tell someone what standing reports already exist.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const db = requireDb();
    const rows = await withOrgDb(await orgForSession(ctx), (tx) =>
      tx
        .select()
        .from(apps)
        .where(isNull(apps.deletedAt))
        .orderBy(asc(apps.createdAt)),
    );
    return {
      apps: rows.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        sourceKind: a.sourceKind,
        workflow: a.workflow,
        refreshCron: a.refreshCron,
        enabled: a.enabled,
        lastRefreshAt: a.lastRefreshAt?.toISOString() ?? null,
        lastError: a.lastError,
      })),
    };
  },
}));

export const updateAppTool = modelFacing("update_app", defineTool({
  description:
    "Update an APP's definition — its prompt/workflow, refresh cadence, customer scope, or paused state. Only the fields you pass change. Use `list_apps` first to get the id. This does NOT regenerate the document; the next refresh does.",
  approval: once(),
  inputSchema: z.object({
    id: z.string().min(1).describe("The app id from list_apps."),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).nullable().optional(),
    prompt: z.string().max(4000).nullable().optional(),
    workflow: z.string().nullable().optional(),
    refreshCron: z
      .string()
      .nullable()
      .optional()
      .describe("UTC 5-field cron, or null to clear it (manual-only)."),
    customerId: z.string().nullable().optional(),
    enabled: z.boolean().optional().describe("false pauses automatic refreshes."),
  }),
  async execute({ id, ...patch }, ctx) {
    const db = requireDb();
    const fields: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) fields[k] = v;
    }
    if (patch.refreshCron !== undefined) {
      fields.refreshCron = assertCron(patch.refreshCron);
    }
    const updateOrg = await orgForSession(ctx);
    const [app] = await withOrgDb(updateOrg, (tx) =>
      tx
        .update(apps)
        .set(fields)
        .where(and(eq(apps.id, id), isNull(apps.deletedAt)))
        .returning(),
    );
    if (!app) throw new Error(`No app with id "${id}".`);
    return {
      updated: true as const,
      app: { id: app.id, name: app.name, refreshCron: app.refreshCron, enabled: app.enabled },
    };
  },
}));
