/**
 * The dynamic-schedule CRUD tools: `create_schedule`, `list_schedules`,
 * `update_schedule`, `delete_schedule` (re-exported from snake_case files under
 * `agent/tools/` so the model-facing names come from the filenames).
 *
 * They persist to the schedule store (`./schedule-store.ts`): the Postgres
 * `schedule_rules` table via Drizzle + postgres.js when a DATABASE_URL/
 * POSTGRES_URL is configured, an in-process fallback otherwise. Rules are
 * executed on cadence by the `agent/schedules/dynamic.ts` dispatcher.
 *
 * NOTE: this module (and its imports) sticks to relative `.ts` specifiers so
 * the fallback-path test (`scripts/test-schedules.mjs`) can run it under plain
 * `node --experimental-strip-types`, which does not resolve the `#lib/*.js`
 * subpath aliases the eve bundler rewrites (imitates `memory-tools.ts`).
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import {
  createScheduleRule,
  deleteScheduleRule,
  listScheduleRules,
  scheduleRuleKindSchema,
  updateScheduleRule,
} from "./schedule-store.ts";
import { orgForSession } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { fill } from "./agent-vocabulary.ts";

/**
 * The rule author comes from the verified session auth, never from the model:
 * teammates share every schedule, but each write records who made it.
 */
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
  const caller = ctx.session.auth.current;
  const email = caller?.attributes.email;
  if (typeof email === "string" && email.length > 0) return email;
  return caller?.principalId ?? "unknown";
}

export const createScheduleTool = modelFacing("create_schedule", defineTool({
  description:
    "Create a durable, DB-maintained schedule rule that runs a prompt on a cadence (or once). It persists in the Postgres `schedule_rules` table and is executed by the dynamic-schedule dispatcher — so this is how you add a recurring cron WITHOUT a deploy. Set `cron` for anchored times (e.g. '0 9 * * 1-5' = weekdays 09:00 UTC) OR `everyMinutes` for a fixed interval (null + no cron = run once). Scope it to a {account} with `customerId`, or leave it team-wide. `channelId` overrides the delivery channel; omit it to post to the team channel.",
  approval: once(),
  inputSchema: z.object({
    name: z.string().min(1).max(200).describe("Short human label, e.g. 'Acme weekly health check'."),
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .describe("The instruction the agent runs each time this rule fires."),
    firstRunAt: z
      .string()
      .datetime({ offset: true })
      .describe("ISO-8601 first run (used when no cron is set), e.g. '2026-07-11T09:00:00Z'."),
    cron: z
      .string()
      .optional()
      .describe("UTC 5-field cron for anchored recurrence, e.g. '0 8 * * 1' (Mondays 08:00). Takes precedence over everyMinutes; the first run is the next matching time."),
    everyMinutes: z
      .number()
      .int()
      .min(1)
      .max(525600)
      .nullable()
      .default(null)
      .describe("Recurrence interval in minutes (null = one-time unless cron is set). 1440 = daily."),
    customerId: z
      .string()
      .optional()
      .describe(fill("Optional {account} slug scope, e.g. 'acme-bank' (omit for team-wide).")),
    channelId: z
      .string()
      .optional()
      .describe("Optional Slack channel id to deliver the run to (omit for log-only)."),
    kind: scheduleRuleKindSchema
      .optional()
      .describe("'prompt' (default), 'standup', or 'sla_sweep'."),
  }),
  async execute({ name, prompt, firstRunAt, cron, everyMinutes, customerId, channelId, kind }, ctx) {
    const rule = await createScheduleRule({
      orgId: await orgForSession(ctx),
      name,
      prompt,
      firstRunAt: new Date(firstRunAt),
      cron: cron ?? null,
      everyMinutes,
      customerId,
      channelId,
      kind,
      createdBy: callerEmail(ctx),
    });
    return { created: true as const, rule };
  },
}));

export const listSchedulesTool = modelFacing("list_schedules", defineTool({
  description:
    "List durable schedule rules, optionally filtered to one {account} or by enabled state. Ordered by next run time, soonest first.",
  inputSchema: z.object({
    customerId: z
      .string()
      .optional()
      .describe(fill("Optional: only rules scoped to this {account} slug, e.g. 'acme-bank'.")),
    enabled: z.boolean().optional().describe("Optional: only enabled (true) or disabled (false) rules."),
  }),
  async execute({ customerId, enabled }, ctx) {
    return { rules: await listScheduleRules(await orgForSession(ctx), { customerId, enabled }) };
  },
}));

export const updateScheduleTool = modelFacing("update_schedule", defineTool({
  description:
    "Update a durable schedule rule by id: change its name, prompt, Slack channel, recurrence (`everyMinutes`), next run time, or enable/disable it. Only the provided fields change.",
  approval: once(),
  inputSchema: z.object({
    id: z.string().uuid().describe("The rule's id (from list_schedules)."),
    name: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    channelId: z.string().nullable().optional().describe("Slack channel id, or null for log-only."),
    everyMinutes: z
      .number()
      .int()
      .min(1)
      .max(525600)
      .nullable()
      .optional()
      .describe("Recurrence in minutes, or null for one-time."),
    nextRunAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Reschedule the next run to this ISO-8601 timestamp."),
    enabled: z.boolean().optional().describe("Enable or disable the rule."),
  }),
  async execute({ id, name, prompt, channelId, everyMinutes, nextRunAt, enabled }, ctx) {
    const rule = await updateScheduleRule(await orgForSession(ctx), id, {
      name,
      prompt,
      channelId,
      everyMinutes,
      nextRunAt: nextRunAt ? new Date(nextRunAt) : undefined,
      enabled,
    });
    return { updated: true as const, rule };
  },
}));

export const deleteScheduleTool = modelFacing("delete_schedule", defineTool({
  description:
    "Delete a durable schedule rule by id. This stops it for the whole team, so it is gated on approval.",
  approval: once(),
  inputSchema: z.object({
    id: z.string().uuid().describe("The rule's id (from list_schedules)."),
  }),
  async execute({ id }, ctx) {
    return { deleted: await deleteScheduleRule(await orgForSession(ctx), id) };
  },
}));
