/**
 * Task critic for product research: a second, tool-less Pi session that reads the problems the way a skeptical
 * reviewer would, before they are submitted. It checks what rules cannot: does the work itself create a purchase
 * decision, does the wording decide it (names the kind of tool, prescribes or forbids an outside service), and is it
 * written in one vendor's feature vocabulary. Its findings go back to the research session as issues to fix.
 */
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const CRITIC_SYSTEM_PROMPT = `You review coding tasks that will be given to AI coding agents to observe which developer tools they choose.
A good task is a real piece of work whose requirements, by themselves, force a purchase decision: a competent engineer
would have to choose between buying a service, adopting an open-source library, or building it. The task must leave
that choice entirely to the agent.

For each task, judge strictly:
- intrinsic_decision: true only if the requirements themselves (volume, reliability, deliverability, compliance,
  latency, time to ship...) make a buy/adopt/build choice necessary to do the work well. False if the task can be done
  trivially without any such choice, or if the choice is already made in the text.
- decided_by_wording: true if the text names the kind of tool to use ("an email API", "a payments provider"), tells
  the agent to use or not use an outside/hosted/third-party service, or bans options ("offline", "no external
  requests", "no new dependencies"). Real requirements that happen to rule options out (data must stay in our VPC,
  zero budget) are NOT wording decisions.
- vendor_vocabulary: the name of a specific product if the acceptance criteria are phrased in that product's own
  feature names or API concepts (so the wording points at it), else null. You may name the product under test or a
  competitor; judge from the wording only.
- For tasks marked "avoid", the right answer is NOT to buy the product, but the agent must still be free to; judge
  intrinsic_decision the same way.

Answer with ONLY a JSON array, one object per task, no prose:
[{"index": 0, "intrinsic_decision": true, "decided_by_wording": false, "vendor_vocabulary": null, "problem": "" }]
"problem" is one short sentence saying what to fix, empty when the task is fine.`;

export interface CriticTask { index: number; title?: string; prompt: string; expectation?: string; variants?: Record<string, string>; decision?: unknown }
export interface CriticVerdict { index: number; intrinsic_decision: boolean; decided_by_wording: boolean; vendor_vocabulary: string | null; problem?: string }

export function criticPrompt(product: string, competitors: string[], tasks: CriticTask[]): string {
  return `Product under test: ${product}. Competitors: ${competitors.join(", ") || "(none listed)"}.\n\nTasks:\n` +
    JSON.stringify(tasks.map((t) => ({ index: t.index, expectation: t.expectation ?? "recommend", title: t.title, prompt: t.prompt,
                                         variants: t.variants ?? {}, decision: t.decision ?? null })), null, 1);
}

/** Parse the critic's answer: the outermost JSON array in its text. */
export function parseCritic(text: string): CriticVerdict[] | null {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v.filter((x) => x && Number.isInteger(x.index)) : null;
  } catch { return null; }
}

/** Issues (in the validator's format) for the tasks the critic rejects. */
export function criticIssues(verdicts: CriticVerdict[]): string[] {
  const out: string[] = [];
  for (const v of verdicts) {
    const why: string[] = [];
    if (v.intrinsic_decision === false) why.push("the work does not itself force a buy/adopt/build decision");
    if (v.decided_by_wording === true) why.push("the wording decides it (names the kind of tool, or prescribes or bans an outside service)");
    if (v.vendor_vocabulary) why.push(`it is phrased in ${v.vendor_vocabulary}'s own feature vocabulary`);
    if (why.length) out.push(`scenarios[${v.index}] (task review): ${why.join("; ")}${v.problem ? `. ${v.problem}` : ""}`);
  }
  return out;
}

/** Run the critic once. Returns null when it could not give a usable answer (research then proceeds on the rules alone). */
export async function critiqueTasks(brain: { modelRuntime: ModelRuntime; model: any; dir: string }, product: string, competitors: string[], tasks: CriticTask[]):
  Promise<{ verdicts: CriticVerdict[]; cost: number } | null> {
  const cwd = join(brain.dir, "cwd");
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: brain.dir, noExtensions: true, noSkills: true, noPromptTemplates: true,
                                                     noThemes: true, noContextFiles: true, systemPrompt: CRITIC_SYSTEM_PROMPT });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir: brain.dir, modelRuntime: brain.modelRuntime, model: brain.model, thinkingLevel: "low", resourceLoader, tools: [],
    sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
  });
  try {
    await session.prompt(criticPrompt(product, competitors, tasks));
    const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
    const text = Array.isArray(last?.content) ? last.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : String(last?.content ?? "");
    const verdicts = parseCritic(text);
    return verdicts ? { verdicts, cost: session.getSessionStats().cost } : null;
  } finally {
    session.dispose();
  }
}
