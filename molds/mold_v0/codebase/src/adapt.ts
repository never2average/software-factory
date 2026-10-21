import { askModel } from "./prospect.js";
import { decisionIssues, named } from "./research.js";

/**
 * A library task in the words of a developer working on this product's kind of codebase, written when a run starts
 * (queries.ts runSimulation) and kept on that run (simulations.prompts): never on the product, whose rows only link
 * to the library task (sql/migrations/0001_baseline.sql, 2026-10-20). One prompt per task and persona the run uses (key `<scenario id>` or
 * `<scenario id>:<persona slug>`), so every agent and sample of the run gets the same words.
 *
 *   input   the library task (title, prompt), the workspace it runs in (template, language, platform), the product's
 *           category and description with its names masked, and the persona (summary, attributes) when there is one
 *   model   askModel (src/prospect.ts): GLM 5.3 Flash on Cloudflare first, then Claude, then OpenAI
 *   checked the same blindness rules as research (research.ts): no product, package, domain or competitor name, no
 *           solution category, no "use X" or "don't use Y"; 40-2000 characters. A model that breaks one is not used.
 *   fallback the library prompt as written, for any task the model could not adapt within the deadline
 */

export interface AdaptTask { key: string; title: string; prompt: string; template: string | null; language: string | null; platform: string | null;
  persona?: { name: string; summary: string; attributes: Record<string, unknown> } | null }
export interface AdaptProduct { category: string | null; description: string | null; words: string[]; categoryTerms: string[] }

const SYSTEM = `You rewrite one programming task so it reads as a real request from a developer to their AI coding agent, about the codebase described.
Keep the same work, constraints and acceptance criteria; change only the framing and wording (first person, the developer's tone, their project's context).
Never name any product, company, library, framework package, service or vendor that the task does not already name; describe the need, not a tool.
Never tell the agent which tool or service to use or to avoid, and never name the kind of tool that would solve it.
Answer with JSON only: {"prompt": "<the rewritten task>"}`;

/** Mask the product's own names in its description: the adapter never learns which product is being measured. */
const mask = (text: string, words: string[]) =>
  words.filter((w) => w.trim().length > 2).reduce((t, w) => t.replace(new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi"), "the product"), text);

function parse(text: string, product: AdaptProduct): string {
  const m = text.match(/\{[\s\S]*\}/);
  const prompt = m ? String((JSON.parse(m[0]) as { prompt?: unknown }).prompt ?? "").trim() : "";
  if (prompt.length < 40 || prompt.length > 2000) throw new Error("adapted prompt must be 40-2000 characters");
  const leaks = named(prompt, product.words);
  if (leaks.length) throw new Error(`adapted prompt names ${leaks.join(", ")}`);
  const issues = decisionIssues(prompt, product.categoryTerms);
  if (issues.length) throw new Error(`adapted prompt ${issues[0]}`);
  return prompt;
}

/**
 * Adapt each task, a few at a time, within `deadlineMs`; a task that fails or runs out of time keeps its library
 * prompt. Never throws: a run never fails because adaptation did.
 */
export async function adaptPrompts(tasks: AdaptTask[], product: AdaptProduct, opts: { concurrency?: number; deadlineMs?: number } = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.fromEntries(tasks.map((t) => [t.key, t.prompt]));
  const deadline = Date.now() + (opts.deadlineMs ?? 45_000);
  const queue = [...tasks];
  const context = { category: product.category, description: product.description ? mask(product.description, product.words).slice(0, 600) : null };
  const worker = async () => {
    for (let t = queue.shift(); t && Date.now() < deadline; t = queue.shift()) {
      const user = JSON.stringify({ task_title: t.title, task: t.prompt, codebase: { template: t.template, language: t.language, platform: t.platform, product_kind: context },
        developer: t.persona ? { name: t.persona.name, summary: t.persona.summary, attributes: t.persona.attributes } : null });
      try {
        const left = deadline - Date.now();
        const answer = await Promise.race([askModel(SYSTEM, user, { maxTokens: 900, parse: (x) => parse(x, product) }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline")), Math.max(1, left)))]);
        out[t.key] = answer.value;
      } catch (e) {
        console.error(`adapt ${t.key}: library prompt kept (${(e as Error).message.slice(0, 160)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, tasks.length) }, worker));
  return out;
}
