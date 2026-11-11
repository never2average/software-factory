// What an agent is for (mold_v0-295): the console's copy of src/agent-purpose.ts's list (test:agent-dock keeps the two equal),
// with the one icon each purpose is drawn with beside an agent's name (features/agent/agent-name.tsx).
export const AGENT_PURPOSES = ['researcher', 'formalizer', 'builder', 'reviewer', 'tester', 'deployer', 'analyst', 'improver', 'general'] as const;
export type AgentPurpose = (typeof AGENT_PURPOSES)[number];
export const PURPOSE_WORDS: Record<AgentPurpose, string> = {
  researcher: 'Researcher', formalizer: 'Formalizer', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester',
  deployer: 'Deployer', analyst: 'Analyst', improver: 'Improver', general: 'General'
};
/** Each purpose's icon, by its name in components/icons.tsx. */
export const PURPOSE_ICON: Record<AgentPurpose, string> = {
  researcher: 'microscope', formalizer: 'mathFunction', builder: 'hammer', reviewer: 'eyeCheck', tester: 'flask',
  deployer: 'rocket', analyst: 'chartBar', improver: 'trendingUp', general: 'agent'
};
export const isPurpose = (v: unknown): v is AgentPurpose => typeof v === 'string' && (AGENT_PURPOSES as readonly string[]).includes(v);
export interface AgentLabel { name: string; purpose: AgentPurpose }
