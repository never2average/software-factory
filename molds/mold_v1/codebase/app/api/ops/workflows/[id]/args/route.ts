import { NextRequest, NextResponse } from "next/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, workflows } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { argKeysRead, validateWorkflowArgs } from "@/lib/workflow-args";
import { W } from "@/lib/ui-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ops/workflows/{id}/args — a DRAFT payload for this workflow.
 *
 * Running a workflow "for something" needs a payload, and asking a person to
 * type raw JSON against a script they may not have written is a poor trade: to
 * get `{"customerId":"matic-insurance"}` right you must know the key is
 * `customerId` and not `customer`, and that the value is a slug and not a
 * display name. So the model drafts it and the person edits it.
 *
 * The KEYS are not the model's to choose. They are read statically out of the
 * script (lib/workflow-args.ts), and the model only fills in values — so a
 * draft can never be rejected by the very validator that guards the run. A
 * model free to invent key names would reliably produce `customer`, which is
 * precisely the mistake this feature exists to prevent.
 *
 * Everything here is a suggestion. The draft is returned, never run.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  /** What the person said they want, e.g. "for Matic Insurance". Optional. */
  intent: z.string().max(500).optional(),
});

function smallModel() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!account || !token) return null;
  const cf = createOpenAICompatible({
    name: "cloudflare-workers-ai",
    baseURL:
      process.env.CLOUDFLARE_BASE_URL?.trim() ??
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
    apiKey: token,
  });
  return cf(process.env.CLOUDFLARE_SUMMARY_MODEL?.trim() ?? "@cf/openai/gpt-oss-120b");
}

/**
 * The JSON object in a model reply, which rarely arrives clean.
 *
 * The first attempt sliced from the first `{` to the last `}`. That works only
 * when the reply is nothing but JSON — any prose containing a brace ("use the
 * {customerId} key…", a reasoning aside) makes the slice unparseable, and the
 * draft silently degraded to a blank skeleton. Which is what happened: the
 * feature worked twice, then stopped, with the model blamed in the note.
 *
 * So: walk the string, take every BALANCED brace span, and prefer the last one
 * that parses to an object — models put their reasoning first and the answer
 * last.
 */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const hay = (fenced?.[1] ?? text).trim();
  const found: Record<string, unknown>[] = [];
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < hay.length; j++) {
      const ch = hay[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(hay.slice(i, j + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              found.push(parsed as Record<string, unknown>);
            }
          } catch {
            /* not JSON — keep scanning */
          }
          i = j; // resume after this span
          break;
        }
      }
    }
  }
  return found.length ? found[found.length - 1] : null;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { id } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  const intent = parsed.success ? (parsed.data.intent ?? "") : "";

  const [workflow] = await withOrgRls(ctx.orgId, (tx) =>
    tx
      .select({ name: workflows.name, script: workflows.script })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, ctx.orgId),
          UUID.test(id) ? eq(workflows.id, id) : eq(workflows.name, id),
        ),
      )
      .limit(1),
  );
  if (!workflow?.script) {
    return NextResponse.json({ error: "That workflow has no script yet." }, { status: 404 });
  }

  const keys = argKeysRead(workflow.script);
  if (keys === null) {
    return NextResponse.json({
      args: {},
      keys: [],
      note: "This workflow chooses its argument names at runtime, so there is nothing to pre-fill.",
    });
  }
  if (keys.size === 0) {
    return NextResponse.json({
      args: {},
      keys: [],
      note: "This workflow reads no arguments — it works out its own scope.",
    });
  }

  const keyList = [...keys].sort();
  // Real ids, so the draft is runnable rather than a plausible-looking guess.
  const roster = await withOrgRls(ctx.orgId, (tx) =>
    tx
      .select({ id: customers.customerId, name: customers.customerName })
      .from(customers)
      .where(eq(customers.orgId, ctx.orgId))
      .limit(200),
  );

  const skeleton: Record<string, unknown> = Object.fromEntries(keyList.map((k) => [k, null]));
  const model = smallModel();
  let args = skeleton;
  let note: string | undefined;

  if (model) {
    const prompt =
      `A workflow named "${workflow.name}" reads exactly these arguments: ${JSON.stringify(keyList)}.\n\n` +
      `Its script:\n${workflow.script.slice(0, 2500)}\n\n` +
      `${W.Accounts} in this workspace (id → name):\n` +
      roster.map((c) => `${c.id} → ${c.name}`).join("\n").slice(0, 2000) +
      `\n\nWhat the operator wants: ${intent || "(not stated)"}\n\n` +
      `Return ONE JSON object using ONLY those exact keys. Use a real ${W.account} id from the list ` +
      `where an id is wanted — never a display name. Use null for anything you cannot determine. ` +
      `Reply with the JSON object and nothing else.`;
    try {
      /**
       * A reasoning model spends tokens before it says anything.
       *
       * gpt-oss emits its reasoning first, so a 300-token cap was being used up
       * entirely on thinking and `text` came back EMPTY — the draft degraded to
       * a skeleton and the note blamed unparseable JSON, when there was no JSON
       * because there was no output at all. Give it room, and read the
       * reasoning channel too: when a model does answer inside its thinking,
       * the JSON is there and perfectly good.
       */
      const out = await generateText({ model, prompt, maxOutputTokens: 1200 });
      const reasoning =
        typeof (out as { reasoningText?: unknown }).reasoningText === "string"
          ? ((out as { reasoningText?: string }).reasoningText ?? "")
          : Array.isArray((out as { reasoning?: unknown }).reasoning)
            ? ((out as { reasoning?: { text?: string }[] }).reasoning ?? [])
                .map((r) => r?.text ?? "")
                .join("\n")
            : "";
      const text = [out.text ?? "", reasoning].filter(Boolean).join("\n");
      const proposed = firstJsonObject(text);
      if (proposed) {
        // Keep only keys the script reads: the model's judgement is welcome on
        // values, never on the shape.
        args = Object.fromEntries(keyList.map((k) => [k, proposed[k] ?? null]));
      } else {
        note =
          (text.trim()
            ? "The model did not return usable JSON, so this is a blank skeleton. It said: " +
              text.trim().replace(/\s+/g, " ").slice(0, 120)
            : "The model returned nothing, so this is a blank skeleton. Fill the values in yourself.");
      }
    } catch {
      note = "Drafting is unavailable right now, so this is a blank skeleton.";
    }
  } else {
    note = "No drafting model is configured, so this is a blank skeleton.";
  }

  // Prove the draft passes the same gate the run will apply. If it somehow does
  // not, hand back the skeleton rather than something that will be refused.
  const problem = validateWorkflowArgs(workflow.script, args);
  if (problem) {
    args = skeleton;
    note = problem.message;
  }

  return NextResponse.json({ args, keys: keyList, ...(note ? { note } : {}) });
}
