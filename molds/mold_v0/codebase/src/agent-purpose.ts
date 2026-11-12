/**
 * What an agent is for (mold_v0-295): one word from a fixed list, declared on an agent profile (its config's `purpose`, set
 * in Admin › Agent profiles or a pack's `agent_profiles`) or on a program (pack.json `programs[].config.purpose`). The
 * console draws each with one icon beside the agent's name wherever an agent speaks or runs (the trace, the run tree, Active
 * runs, the dock); web/src/lib/agent-purpose.ts holds the same list with the icons, and test:agent-dock keeps the two equal.
 * Where nothing is declared it is read from the program or profile itself (its id, name, section and icon, then its shape),
 * and `general` when nothing says. Pure: no database, imported by the specs and the dock alike.
 */
export const AGENT_PURPOSES = ["researcher", "formalizer", "builder", "reviewer", "tester", "deployer", "analyst", "improver", "general"] as const;
export type AgentPurpose = (typeof AGENT_PURPOSES)[number];
export const DEFAULT_PURPOSE: AgentPurpose = "general";
/** The purposes in words, as a select and a tooltip say them. */
export const PURPOSE_WORDS: Record<AgentPurpose, string> = {
  researcher: "Researcher", formalizer: "Formalizer", builder: "Builder", reviewer: "Reviewer", tester: "Tester",
  deployer: "Deployer", analyst: "Analyst", improver: "Improver", general: "General",
};
export const isPurpose = (v: unknown): v is AgentPurpose => typeof v === "string" && (AGENT_PURPOSES as readonly string[]).includes(v);

/** Words that give a purpose away, first match wins (the narrower purposes first: "formalization discovery" formalizes). */
const CLUES: [AgentPurpose, RegExp][] = [
  ["formalizer", /\b(formali[sz]|formal\b|specif|precis|proof|prove|theorem|math)/],
  ["tester", /\b(test|a\/?b\b|ab ?test|experiment|split|compar|verif|qa\b|flask)/],
  ["deployer", /\b(deploy|release|ship|rollout|roll out|publish|launch|rocket)/],
  ["reviewer", /\b(review|critic|critique|audit|inspect|approv|eye)/],
  ["improver", /\b(improv|climb|optimi[sz]|tune|tuning|refine|evolv|trending ?up|champion)/],
  ["analyst", /\b(analy|metric|scan|monitor|report|insight|measur|dashboard|activity|chart|learn|graduation)/],
  ["builder", /\b(build|implement|develop|code|coder|coding|construct|engineer|hammer|fix)/],
  ["researcher", /\b(research|investigat|explor|discover|search|find|gather|study|thought|think|brain|idea|hypothes|microscope)/],
];
/** The purpose some words give away (camelCase, - and _ read as spaces), or null. */
export function purposeFromWords(...words: (string | null | undefined)[]): AgentPurpose | null {
  const text = words.filter(Boolean).map((w) => String(w).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")).join(" | ").toLowerCase();
  if (!text.trim()) return null;
  for (const [p, re] of CLUES) if (re.test(text)) return p;
  return null;
}

/** An agent as the console names it: its words and its purpose. */
export interface AgentLabel { name: string; purpose: AgentPurpose }

/** A program's purpose: its own, else its profile's declared one, else what its words and shape say, else general. */
export function programPurpose(p: { id: string; name: string; config: { purpose?: unknown; icon?: string; dock?: { section?: string; label?: string; kind?: string } ; acceptance?: unknown; machine?: unknown } | null }, profileDeclared?: AgentPurpose | null): AgentPurpose {
  const c = p.config ?? {};
  if (isPurpose(c.purpose)) return c.purpose;
  if (profileDeclared) return profileDeclared;
  return purposeFromWords(p.id, p.name, c.dock?.section, c.dock?.label, c.icon)
    ?? (c.acceptance || c.dock?.kind === "climb" || c.dock?.kind === "changes" ? "improver" : c.machine ? "builder" : DEFAULT_PURPOSE);
}

/** A profile's purpose: its own, else what its id and name say, else general. */
export function profilePurpose(p: { id: string; name: string; config?: { purpose?: unknown } | null }): AgentPurpose {
  return isPurpose(p.config?.purpose) ? p.config!.purpose as AgentPurpose : purposeFromWords(p.id, p.name) ?? DEFAULT_PURPOSE;
}
