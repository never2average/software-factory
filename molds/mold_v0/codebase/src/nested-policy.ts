/**
 * What a child session may do (mold_v0-291; molds/mold_v0/docs/agent-harness.md "Nested runs and Programs"): the
 * intersection of what its program's agent profile allows and what its parent has, never wider than either. Pure, so a
 * test can hold every case to the rule. The parent's own runtime approvals count as what it has; the child can never ask for
 * more (no approvals, no requests: what is not allowed ends it).
 */
import { ALLOW_ALL_DOMAINS, activeExceptions, domainAllowed, fetchRules, hostIsPublic, type FrozenGovernance } from "./agent-governance.js";
import { hostAllowed, workspaceToolOf, type AgentPolicy, type ResolvedHook } from "./agent-harness-config.js";

/** Keys only the orchestrator or the autoscaler may hold, never a child (src/gateway.ts ORCHESTRATOR_ONLY_PROVIDERS says the same). */
const SANDBOX_PROVIDERS = new Set(["boat", "vertex", "freestyle", "neon"]);

export interface EffectiveWeb { search: boolean; fetch: boolean; rules: string[]; max: number }

/** What a policy can reach, in one form: governance's when it has one, else the platform's web fields. */
export function effectiveWeb(p: Pick<AgentPolicy, "web" | "governance">, now = Date.now()): EffectiveWeb {
  if (p.governance) {
    const w = p.governance.web;
    if (!w?.enabled) return { search: false, fetch: false, rules: [], max: 0 };
    return { search: !!w.web_search_enabled, fetch: !!w.web_fetch_enabled, rules: w.web_fetch_enabled ? fetchRules(p.governance, now) : [], max: w.max_calls };
  }
  if (p.web.tools === "off") return { search: false, fetch: false, rules: [], max: 0 };
  // The platform's `*.x` also allows x itself: said as both, in governance's terms.
  const rules = p.web.hosts.flatMap((h) => (h.startsWith("*.") ? [h, h.slice(2)] : [h]));
  return { search: p.web.tools === "search", fetch: true, rules, max: p.web.calls_max };
}

/** Whether every host `rule` allows is allowed by `rules`. */
export function ruleCovered(rule: string, rules: readonly string[]): boolean {
  if (rule === ALLOW_ALL_DOMAINS) return rules.includes(ALLOW_ALL_DOMAINS);
  if (rule.startsWith("*.")) {
    const d = rule.slice(2);
    return rules.includes(ALLOW_ALL_DOMAINS) ? hostIsPublic(d) : rules.some((r) => r === rule || (r.startsWith("*.") && d.endsWith(`.${r.slice(2)}`)));
  }
  return domainAllowed(rule, rules);
}
/** The hosts both lists allow, as rules that are each within both. */
export function intersectRules(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a.filter((r) => ruleCovered(r, b)), ...b.filter((r) => ruleCovered(r, a))])].sort();
}

export interface ProgramSide {
  flavour: string; model: string; provider: string; hooks: ResolvedHook[];
  web: EffectiveWeb;
  tools_rule: { allowed: string[]; max_calls: number } | null;
  retention_days: number | null;
  credentials: string[];
  vault_keys: NonNullable<AgentPolicy["vault_keys"]>;
  inference_key: string | null;
  free_tools: string[];
  uploads: NonNullable<AgentPolicy["uploads"]>;
  files: NonNullable<AgentPolicy["files"]>;
  recipes: NonNullable<AgentPolicy["recipes"]>;
  max_turns?: number; wake_max_seconds?: number;
}

export class ChildPolicyRefused extends Error {}

/** The child's frozen policy. `base` is what a task session gets from the platform's settings now. */
export function intersectChildPolicy(parent: AgentPolicy, program: ProgramSide, base: AgentPolicy, now = Date.now()): AgentPolicy {
  if (program.provider !== parent.provider) throw new ChildPolicyRefused(`it uses the ${program.provider} provider, and this session only has ${parent.provider}: a child cannot have a key its parent does not`);
  // The key that pays: the parent's, unless the program names the same one. A program naming another key would be a wider key.
  if (program.inference_key && program.inference_key !== (parent.inference_key ?? null)) throw new ChildPolicyRefused("it uses a model key this session does not have: a child cannot have a key its parent does not");
  const inference = parent.inference_key ?? null;

  const pw = effectiveWeb(parent, now), cw = program.web;
  const search = pw.search && cw.search, fetch = pw.fetch && cw.fetch;
  const rules = fetch ? intersectRules(pw.rules, cw.rules) : [];
  const fetchOn = fetch && rules.length > 0;
  const max = Math.min(pw.max, cw.max);
  const enabled = (search || fetchOn) && max > 0;
  const pt = parent.governance?.tools ?? null, ct = program.tools_rule;
  const toolRule = pt && ct ? { allowed: pt.allowed.filter((t) => ct.allowed.includes(t)), max_calls: Math.min(pt.max_calls, ct.max_calls) } : (pt ?? ct);
  const days = [parent.governance?.retention_days, program.retention_days].filter((x): x is number => typeof x === "number" && x > 0);
  const governance: FrozenGovernance = {
    web: { enabled, web_search_enabled: enabled && search, web_fetch_enabled: enabled && fetchOn, web_fetch_allowed_domains: enabled && fetchOn ? rules : [], max_calls: enabled ? max : 0 },
    // The parent's approvals are folded into `rules` above: a child never asks for anything itself.
    egress_approvals: false,
    ...(toolRule ? { tools: toolRule } : {}),
    ...(days.length ? { retention_days: Math.min(...days) } : {}),
  };
  const web = { tools: (enabled && fetchOn ? (search ? "search" : "fetch") : "off") as AgentPolicy["web"]["tools"], hosts: enabled && fetchOn ? rules.filter((h) => h !== ALLOW_ALL_DOMAINS) : [], calls_max: enabled ? max : 0 };

  const credentials = program.credentials.filter((c) => (parent.credentials ?? []).includes(c));
  const vault = program.vault_keys.filter((k) => !SANDBOX_PROVIDERS.has(k.provider) && (parent.vault_keys ?? []).some((p) => p.provider === k.provider && p.label === k.label && p.env === k.env));

  // The harness's own tools, and the workspace's free ones, each only if the parent had it free too.
  const parentFree = new Set(parent.tools);
  const tools = [...new Set([...base.tools.filter((t) => !workspaceToolOf(t) && parentFree.has(t)), ...program.free_tools.filter((t) => parentFree.has(t))])];

  const parentReach = parent.workspace;
  const reach = parentReach ? {
    ...parentReach,
    free: "none" as const, named: tools.flatMap((t) => { const w = workspaceToolOf(t); return w ? [w] : []; }),
    // A hidden tool stays hidden; anything the parent could not call, the child cannot either.
    tools: toolRule ? parentReach.tools.filter((t) => toolRule.allowed.includes(t.name)) : parentReach.tools,
    hidden: [...new Set([...(parentReach.hidden ?? []), ...(toolRule ? parentReach.tools.filter((t) => !toolRule.allowed.includes(t.name)).map((t) => t.name) : [])])],
  } : undefined;

  return {
    ...base, flavour: program.flavour, model: program.model, provider: parent.provider, mode: "task", hooks: program.hooks,
    max_turns: Math.min(program.max_turns ?? parent.max_turns, parent.max_turns),
    wake_max_seconds: Math.min(program.wake_max_seconds ?? parent.wake_max_seconds, parent.wake_max_seconds),
    park_after_seconds: Math.min(base.park_after_seconds, parent.park_after_seconds),
    approval_window_hours: parent.approval_window_hours,
    crash_resumes: Math.min(1, parent.crash_resumes), auto_resume: true,
    budget_ceiling_usd: parent.budget_ceiling_usd,
    web, tools, governance,
    ...(inference ? { inference_key: inference } : {}),
    ...(credentials.length ? { credentials } : {}), ...(vault.length ? { vault_keys: vault } : {}),
    ...(program.uploads.length ? { uploads: program.uploads } : {}), ...(program.files.length ? { files: program.files } : {}), ...(program.recipes.length ? { recipes: program.recipes } : {}),
    ...(reach ? { workspace: reach } : {}),
  };
}

export { hostAllowed, activeExceptions };
