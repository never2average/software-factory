import { NextRequest, NextResponse } from "next/server";
import { errorMessage, errorText, zodMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cronMatches } from "@/agent/lib/cron-match";
import { systemCronOverrides, workflows } from "@/agent/lib/db/schema";
import { AUTHORED_SYSTEM_CRON_EXPRS } from "@/agent/lib/system-cron-defs";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A CLOSED set. The name is the primary key and these rows are upserted, so
 * without this guard any string could write a row — and a row whose name never
 * matches a real schedule would be an invisible no-op the UI still lists. The
 * agent-side twin is SYSTEM_CRON_NAMES in agent/lib/system-cron-store.ts; keep
 * the two in step (Next cannot import that module — it uses .ts specifiers the
 * Next bundler will not resolve).
 */
const nameSchema = z.enum(["dynamic"]);

// `enabled` = pause/resume. `restore` un-deletes (and re-enables) a soft-deleted
// cron. `cron` OVERRIDES the authored cadence (null clears the override) —
// validated with agent/lib/cron-match.ts before it is ever persisted; the
// every-minute dispatcher (agent/schedules/dynamic.ts) enforces it. `prompt`
// OVERRIDES the authored prompt the same way (null / empty string clears it —
// back to the authored prompt in agent/lib/system-cron-defs.ts); the run
// itself resolves it via resolveSystemCronMessage. `notifyEmail` is the alert
// target appended to the message as a NOTIFY TARGET line (null/empty clears).
const patchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    restore: z.literal(true).optional(),
    cron: z.string().min(1).nullable().optional(),
    prompt: z.string().nullable().optional(),
    // WHICH workflow (subagent) runs this cron. Null clears the routing.
    workflow: z.string().nullable().optional(),
    notifyEmail: z.string().nullable().optional(),
    // The recipient LIST (supersedes the deprecated single notifyEmail above).
    notifyEmails: z.array(z.email()).nullable().optional(),
    // Who is making the change (audit-trail only; not a column).
    actor: z.string().min(1).optional(),
  })
  .refine(
    (b) =>
      b.enabled !== undefined ||
      b.restore !== undefined ||
      b.cron !== undefined ||
      b.prompt !== undefined ||
      b.workflow !== undefined ||
      b.notifyEmail !== undefined ||
      b.notifyEmails !== undefined,
    { message: "No fields to update" },
  );

// DELETE may carry an optional JSON body naming the actor for the audit trail.
const deleteBodySchema = z.strictObject({ actor: z.string().min(1).optional() });


type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { name: raw } = await context.params;
  const name = nameSchema.safeParse(raw);
  if (!name.success) {
    return NextResponse.json({ error: "Unknown system cron" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }

  // Cadence override: validate the expression BEFORE anything is persisted.
  // "dynamic" is the every-minute dispatcher that ENFORCES overrides — its own
  // cadence cannot be overridden (nothing would be left to enforce it).
  if (parsed.data.cron !== undefined) {
    if (name.data === "dynamic") {
      return NextResponse.json(
        { error: "The dynamic dispatcher's cadence cannot be overridden — it is the clock that enforces the other overrides." },
        { status: 400 },
      );
    }
    if (parsed.data.cron !== null) {
      try {
        cronMatches(parsed.data.cron, new Date());
      } catch (e) {
        return NextResponse.json(
          { error: errorMessage(e) },
          { status: 400 },
        );
      }
    }
  }

  // Prompt / notify-email overrides: "dynamic" is the dispatcher — it never
  // hands a prompt to Slack (it runs the rules and the other crons), so an
  // override on it would sit in the DB unhonoured. Refuse rather than lie.
  if (
    name.data === "dynamic" &&
    (parsed.data.prompt !== undefined ||
      parsed.data.workflow !== undefined ||
      parsed.data.notifyEmail !== undefined ||
      parsed.data.notifyEmails !== undefined)
  ) {
    return NextResponse.json(
      { error: "The dynamic dispatcher has no prompt of its own — it runs the dynamic rules and the overridden crons. Set prompt/notify overrides on daily-standup or sla-sweep instead." },
      { status: 400 },
    );
  }

  // Empty string means "clear the override" — store NULL, same as explicit null.
  const promptValue =
    parsed.data.prompt === undefined ? undefined : parsed.data.prompt?.trim() || null;
  const workflowValue =
    parsed.data.workflow === undefined ? undefined : parsed.data.workflow?.trim() || null;
  const notifyEmailValue =
    parsed.data.notifyEmail === undefined ? undefined : parsed.data.notifyEmail?.trim() || null;
  if (notifyEmailValue != null && !z.email().safeParse(notifyEmailValue).success) {
    return NextResponse.json(
      { error: "notifyEmail must be a valid email address." },
      { status: 400 },
    );
  }

  // An empty list means "no recipients" — store NULL so the resolver treats it
  // the same as never-configured.
  const notifyEmailsValue =
    parsed.data.notifyEmails === undefined
      ? undefined
      : parsed.data.notifyEmails?.length
        ? parsed.data.notifyEmails
        : null;

  const actor = parsed.data.actor ?? "web";
  const values: {
    enabled?: boolean;
    deletedAt?: Date | null;
    cron?: string | null;
    prompt?: string | null;
    workflow?: string | null;
    notifyEmail?: string | null;
    notifyEmails?: string[] | null;
  } = parsed.data.restore
    ? { enabled: true, deletedAt: null }
    : parsed.data.enabled !== undefined
      ? { enabled: parsed.data.enabled }
      : {};
  if (parsed.data.cron !== undefined) values.cron = parsed.data.cron;
  if (promptValue !== undefined) values.prompt = promptValue;
  if (workflowValue !== undefined) values.workflow = workflowValue;
  if (notifyEmailValue !== undefined) values.notifyEmail = notifyEmailValue;
  if (notifyEmailsValue !== undefined) values.notifyEmails = notifyEmailsValue;
  const now = new Date();

  try {
    // The routed workflow must actually EXIST — otherwise the run's ROUTE TO
    // WORKFLOW line would name a subagent nobody can delegate to.
    if (workflowValue) {
      const [match] = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select({ name: workflows.name })
          .from(workflows)
          .where(and(eq(workflows.name, workflowValue), eq(workflows.orgId, ctx.orgId)))
          .limit(1),
      );
      if (!match) {
        return NextResponse.json(
          { error: `No workflow named "${workflowValue}".` },
          { status: 400 },
        );
      }
    }

    // Read the current row first so the cadence audit sentence can name the
    // effective before-value (override if set, else the authored expression).
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(systemCronOverrides)
        .where(eq(systemCronOverrides.name, name.data))
        .limit(1),
    );

    // Upsert: the override row does not exist until the cron is first touched.
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(systemCronOverrides)
        .values({ name: name.data, ...values, updatedAt: now })
        .onConflictDoUpdate({
          target: systemCronOverrides.name,
          set: { ...values, updatedAt: now },
        })
        .returning(),
    );

    // Best-effort audit trail — a failed audit write never fails the patch.
    const events: string[] = [];
    if (parsed.data.restore) events.push("Restored");
    else if (parsed.data.enabled !== undefined) {
      events.push(parsed.data.enabled ? "Resumed" : "Paused");
    }
    if (parsed.data.cron !== undefined) {
      const authored = AUTHORED_SYSTEM_CRON_EXPRS[name.data];
      const effectiveBefore = before?.cron ?? authored;
      events.push(
        parsed.data.cron === null
          ? `Cadence override cleared (back to the authored ${authored})`
          : `Cadence changed ${effectiveBefore} → ${parsed.data.cron}`,
      );
    }
    if (promptValue !== undefined) {
      // Long free text — never quoted inline (matches lib/ops-audit.ts style).
      events.push(
        promptValue === null
          ? "Prompt override cleared (back to the authored prompt)"
          : before?.prompt
            ? "Prompt override updated"
            : "Prompt override set",
      );
    }
    if (workflowValue !== undefined) {
      events.push(
        workflowValue === null
          ? "Workflow routing cleared (the orchestrator runs it)"
          : `Routed to the ${workflowValue} workflow`,
      );
    }
    if (notifyEmailValue !== undefined) {
      events.push(
        notifyEmailValue === null
          ? "Notify email cleared"
          : `Notify email set to ${notifyEmailValue}`,
      );
    }
    if (notifyEmailsValue !== undefined) {
      events.push(
        notifyEmailsValue === null
          ? "Notify recipients cleared"
          : `Notify recipients set to ${notifyEmailsValue.join(", ")}`,
      );
    }
    // Never write a blank audit row — if nothing described the change, say so.
    if (events.length === 0) events.push("Updated");
    await recordOpsAudit(db, {
      automationType: "system_cron",
      automationId: name.data,
      actor,
      event: events.join("; "),
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/**
 * SOFT delete. The schedule file still exists in the repo and Vercel still fires
 * its cron — the run() handler just returns early — so a hard delete would be a
 * lie. PATCH {restore:true} brings it back.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { name: raw } = await context.params;
  const name = nameSchema.safeParse(raw);
  if (!name.success) {
    return NextResponse.json({ error: "Unknown system cron" }, { status: 400 });
  }
  // Optional body: { actor } for the audit trail; no/invalid body means "web".
  const body = await request.json().catch(() => null);
  const actor = deleteBodySchema.safeParse(body).data?.actor ?? "web";
  const now = new Date();
  try {
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(systemCronOverrides)
        .values({ name: name.data, deletedAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: systemCronOverrides.name,
          set: { deletedAt: now, updatedAt: now },
        }),
    );
    // Best-effort audit trail — a failed audit write never fails the delete.
    await recordOpsAudit(db, {
      automationType: "system_cron",
      automationId: name.data,
      actor,
      event: "Soft-deleted (restorable from the Ops Center)",
      orgId: ctx.orgId,
    });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
