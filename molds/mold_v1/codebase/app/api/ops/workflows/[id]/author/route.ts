import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workflows } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { makeDelegate } from "@/lib/workflow-delegate";
import { HOST_FUNCTIONS, analyzeWorkflowScript } from "@/lib/workflow-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The inline agent behind ⌘K: an instruction in, a workflow script out.
 *
 * This WRITES a script, it never runs one — the response is text the operator
 * then reads, edits and saves themselves. That is the whole safety story: the
 * model's output lands in a textarea, not in the sandbox, and it still has to
 * pass the validator on save and the sandbox on run.
 *
 * It reaches the agent with the CALLER's own credentials, like a run does.
 */
const bodySchema = z.strictObject({
  prompt: z.string().min(1).max(4_000),
  /** The script as it stands, so "add a phase" means something. */
  current: z.string().max(100_000).optional(),
});

const uuidSchema = z.uuid();

type RouteContext = { params: Promise<{ id: string }> };

/** Models fence code even when told not to. Take the fence off. */
function unfence(text: string): string {
  const fenced = /```(?:[a-zA-Z]+)?\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * The brief. It deliberately does NOT restate the runtime — the sandbox's
 * globals, its bans and its limits are the `workflow-author` subagent's authored
 * instructions (agent/subagents/workflow-author/instructions.md), which is the
 * one place they belong. Duplicating them here is how the two drift apart.
 *
 * The reminder of the host functions stays, because HOST_FUNCTIONS is the same
 * constant the validator enforces — if it ever changes, this line changes with
 * it rather than silently lying.
 */
function brief(
  prompt: string,
  current: string | undefined,
  name: string,
  override: string | null,
): string {
  return [
    `Workflow: "${name}". The only globals the sandbox injects are: ${HOST_FUNCTIONS.join(", ")}.`,
    "",
    // The operator's standing instructions for this workflow. They already steer
    // the subagent this workflow's steps delegate to (agent/lib/workflow-override.ts);
    // an author that ignored them would write scripts that contradict the very
    // rules the run then obeys.
    override
      ? `The operator has set STANDING INSTRUCTIONS for this workflow. They steer the subagent every step delegates to, so the script you write must be consistent with them:\n\n${override}\n`
      : "",
    current?.trim()
      ? `The CURRENT script is below. Change it as asked and return the WHOLE new script.\n\n${current}`
      : "There is no script yet. Write one from scratch.",
    "",
    `The operator asks: ${prompt}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function POST(request: NextRequest, context: RouteContext) {
  // This route read tenant data with NO workspace resolved at all.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid workflow id" }, { status: 400 });
  }

  // Same rule as a run: the agent is reached as YOU, or not at all.
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) {
    return NextResponse.json(
      { error: "Sign in again — writing a script uses your own credentials to reach the agent." },
      { status: 401 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Say what the workflow should do." }, { status: 400 });
  }

  const [workflow] = await withOrgRls(ctx.orgId, (tx) =>
    tx.select().from(workflows).where(eq(workflows.id, id)).limit(1),
  );
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  try {
    // Routed to the `workflow-author` subagent: the specialist that knows the
    // sandbox's globals, its bans and its limits, and that lints and reviews a
    // script as well as writing one. It has no tools by design.
    const delegate = makeDelegate(bearer, undefined, undefined, undefined, ctx.orgId);
    // The override only counts when the operator has actually switched it on —
    // the same gate loadWorkflowOverride() applies before it reaches a subagent.
    const override =
      workflow.instructionsEnabled && workflow.instructions?.trim()
        ? workflow.instructions.trim()
        : null;
    const reply = await delegate(
      brief(parsed.data.prompt, parsed.data.current, workflow.name, override),
      "workflow-author",
    );
    const script = unfence(reply);
    if (!script) {
      return NextResponse.json({ error: "The agent came back with nothing." }, { status: 502 });
    }
    // Report what the validator makes of it, but DON'T refuse: a script that
    // almost works is more useful in the editor than an error the operator
    // cannot see or fix. Save and Run still enforce.
    const analysis = analyzeWorkflowScript(script);
    return NextResponse.json({
      script,
      ok: analysis.ok,
      issues: analysis.issues.filter((i) => i.level === "error").map((i) => `Line ${i.line}: ${i.message}`),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
