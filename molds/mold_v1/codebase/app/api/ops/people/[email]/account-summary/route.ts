import { NextRequest, NextResponse } from "next/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { accountSummaries } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { makeDelegate } from "@/lib/workflow-delegate";

/** How long a cached briefing is served before it is regenerated. */
const CACHE_MS = 60 * 60 * 1000;

// Env values added via `echo | vercel env add` carry a trailing newline — the
// same trap that once silently routed the whole fleet to the wrong provider
// (see agent/lib/model.ts). Trim everything.
const envTrim = (v: string | undefined) => v?.trim() || undefined;
const cfAccount = envTrim(process.env.CLOUDFLARE_ACCOUNT_ID);
const cfToken = envTrim(process.env.CLOUDFLARE_API_TOKEN);
/** Override the summarization model without a redeploy. */
const summaryModel = envTrim(process.env.SUMMARY_MODEL);

/**
 * A SMALL Cloudflare Workers AI model for inline summarization. The fleet's
 * GLM 5.2 is far too big (and slow) for a two-sentence briefing — gpt-oss-120b
 * is plenty. Cloudflare is the ONLY inference provider; returns null when its
 * creds aren't on this project, in which case we fall back to the eve agent
 * (which runs Cloudflare too, just the big model behind a full turn).
 */
function smallModel() {
  if (!cfAccount || !cfToken) return null;
  const cf = createOpenAICompatible({
    name: "cloudflare-workers-ai",
    baseURL:
      envTrim(process.env.CLOUDFLARE_BASE_URL) ??
      `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/v1`,
    apiKey: cfToken,
  });
  return cf(summaryModel ?? "@cf/openai/gpt-oss-120b");
}

/**
 * Generate the briefing on the small model; fall back to the eve agent (with the
 * caller's credentials) if that provider errors, so this can never regress to
 * broken — only to slower.
 */
async function generate(prompt: string, bearer: string, orgId: string): Promise<string> {
  const model = smallModel();
  if (model) {
    try {
      const { text } = await generateText({ model, prompt, maxOutputTokens: 220 });
      if (text.trim()) return text.trim();
    } catch {
      /* provider/model unavailable — fall through to the agent */
    }
  }
  const delegate = makeDelegate(bearer, undefined, undefined, undefined, orgId);
  return (await delegate(prompt)).trim();
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/ops/people/:email/account-summary — an AI-generated, grounded
 * briefing on ONE person's role and work on ONE account, for the person modal.
 *
 * Runs a real agent turn (with its tools) using the CALLER's credentials, like
 * the workflow-author route: the agent can look the customer up (get_customer,
 * list_followups, …) and enrich the thin dossier slice into dense, specific
 * prose. The `context` block is what the client already knows, so the agent
 * starts grounded rather than from scratch.
 */
const contextSchema = z
  .object({
    account: z.string().min(1),
    /** Stable id for the cache key (the display name can change). */
    accountId: z.string().optional(),
    role: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    lastContact: z.string().nullable().optional(),
    person: z
      .object({
        name: z.string().optional(),
        title: z.string().nullable().optional(),
        org: z.string().nullable().optional(),
        kind: z.string().nullable().optional(),
      })
      .partial()
      .optional(),
    counts: z
      .object({
        tickets: z.number().optional(),
        deployments: z.number().optional(),
        implementations: z.number().optional(),
        todos: z.number().optional(),
      })
      .partial()
      .optional(),
    /** Pre-formatted list of what this person owns on the account. Supplying it
     *  inline is what keeps this a ONE-STEP generation — the agent never has to
     *  call tools to find it, which is where the latency went. */
    workText: z.string().max(6000).optional(),
  })
  .strict();

function buildPrompt(email: string, c: z.infer<typeof contextSchema>): string {
  const person = c.person?.name ?? email;
  const counts = c.counts ?? {};
  return [
    `Write a short, specific briefing on ${person}'s role and work on the "${c.account}" account. It renders directly as a summary paragraph in an internal Control Panel (an FDE ops tool).`,
    "",
    "PERSON: " +
      `${person} (${email})${c.person?.title ? `, ${c.person.title}` : ""}${c.person?.org ? ` at ${c.person.org}` : ""}${c.person?.kind ? ` — ${c.person.kind}` : ""}`,
    `ACCOUNT: ${c.account}`,
    `THEIR ROLE ON THIS ACCOUNT: ${c.role ?? "unknown"}${c.title ? ` (${c.title})` : ""}`,
    `LAST CONTACT: ${c.lastContact ?? "unknown"}`,
    `TOTALS ON THIS ACCOUNT: ${counts.tickets ?? 0} tickets, ${counts.deployments ?? 0} deployments, ${counts.implementations ?? 0} implementations, ${counts.todos ?? 0} TODOs`,
    "",
    "WHAT THEY OWN ON THIS ACCOUNT:",
    c.workText?.trim() || "(nothing recorded against them on this account)",
    "",
    `Write AT MOST 2 sentences — 60 words maximum, a hard limit. This is a briefing about ${person}, NOT an account status report: every sentence should be about what THEY are doing, own, or are blocked on here. Lead with their responsibility on this account, then the single most notable thing about their work on it (a blocker they need to clear, a risk they carry, a stale item, or that it's quiet for them). Describe the account only where it explains their position. Cut all account boilerplate: no SLA terms, no lifecycle/stage recital, no capacity math, no "nothing recorded" inventory.`,
    "",
    "CRITICAL — do NOT call any tools or look anything up. Everything you need is above; answer directly in a single step. No headings, no bullet points, no preamble or sign-off, no markdown. Ground every claim in the data above and omit anything not present rather than inventing it. Your entire reply IS the summary; a program renders it verbatim.",
  ].join("\n");
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ email: string }> }) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) {
    return NextResponse.json(
      { error: "Sign in again — the summary uses your own credentials to reach the agent." },
      { status: 401 },
    );
  }
  // The cached summary is tenant data; this route resolved no workspace, so it
  // wrote rows owned by whatever the column defaulted to.
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const email = decodeURIComponent((await ctx.params).email).trim().toLowerCase();
  const parsed = contextSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "An account is required." }, { status: 400 });
  }
  const db = getOpsDb();
  const key = `${email}|${parsed.data.accountId ?? parsed.data.account}`;
  // Serve a briefing generated within the last hour rather than regenerating.
  if (db) {
    try {
      const [hit] = await withOrgRls(org.orgId, (tx) =>
        tx
          .select()
          .from(accountSummaries)
          .where(eq(accountSummaries.key, key)),
      );
      if (hit && Date.now() - hit.createdAt.getTime() < CACHE_MS) {
        return NextResponse.json({ summary: hit.summary, cached: true });
      }
    } catch (e) {
      console.error("[account-summary] cache read failed:", e);
    }
  }
  try {
    const summary = await generate(buildPrompt(email, parsed.data), bearer, org.orgId);
    if (!summary) {
      return NextResponse.json({ error: "The model returned nothing." }, { status: 502 });
    }
    if (db) {
      // Best-effort write-through; a cache failure must not fail the response —
      // but it MUST be visible, or a silently-broken cache looks identical to a
      // cache that was simply never exercised.
      try {
        await withOrgRls(org.orgId, (tx) =>
          tx
            .insert(accountSummaries)
            .values({ orgId: org.orgId, key, summary, createdAt: new Date() })
            .onConflictDoUpdate({
              target: accountSummaries.key,
              set: { summary, createdAt: new Date() },
            }),
        );
      } catch (e) {
        console.error(`[account-summary] cache write failed for ${key}:`, e);
      }
    }
    return NextResponse.json({ summary });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
