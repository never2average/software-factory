/**
 * The evaluator's own scorers (mold_v0-303; molds/mold_v0/docs/agent-harness.md "Acceptance"): trusted code the evaluator
 * runs itself, in place of a scorer program a test ships, so a pack can declare a test with no code of its own. Pure and
 * import-free but for the two pure modules it scores with: it runs inside the evaluator (src/program-evaluator.ts), part of
 * the run sandbox's code. Each answers its metrics for one case; a metric it cannot measure is left out (a floor on it fails
 * closed, and a missing main metric refuses the candidate).
 *
 *   builtin:exact           score 1 when the candidate's output is the case's expected answer (compared as JSON when both
 *                           parse, else as trimmed text), else 0
 *   builtin:json-schema     the output parsed as JSON. With `expected.schema`: score 1 when the output meets that schema.
 *                           With `expected.valid` (true or false): the output is a schema, and score 1 when the case's
 *                           `input` meets it exactly when `valid` says so (a schema a candidate improves, judged by examples)
 *   builtin:governance-sim  the output is a governance policy (an agent profile's `governance`, src/agent-governance.ts).
 *                           The case's input is one tool call ({tool: {name, input}, web_calls?, mcp_calls?}) and its
 *                           expected answer the decision (allow, deny, ask or pass, or {decision}); score 1 when the policy
 *                           decides so. Also `false_allow`: 1 when it allowed what should not be (a floor: max 0), and
 *                           `valid`: 1 when the policy is a policy at all
 */
import { governToolUse, webPolicyProblems, type FrozenGovernance } from "./agent-governance.js";
import { schemaProblems, validateJson, type JsonSchema } from "./program-spec.js";

export interface ScoredCase { id: string; input: unknown; expected?: unknown }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const json = (s: string): { ok: true; v: unknown } | { ok: false } => { try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } };
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** What a governance policy says wrongly, as far as the simulation needs it to be one. */
function policyOf(v: unknown): FrozenGovernance | null {
  if (!isObject(v)) return null;
  if (v.web !== undefined && (!isObject(v.web) || webPolicyProblems(v.web as never).length)) return null;
  if (v.tools !== undefined && v.tools !== null && !(isObject(v.tools) && Array.isArray(v.tools.allowed) && v.tools.allowed.every((t) => typeof t === "string") && typeof v.tools.max_calls === "number")) return null;
  return v as FrozenGovernance;
}

/** One case's metrics from a built-in scorer, or {} when the output cannot be read. Never throws. */
export function builtinScore(scorer: string, c: ScoredCase, output: string | null): Record<string, number> {
  if (output === null) return {};
  try {
    if (scorer === "builtin:exact") {
      const o = json(output.trim());
      const hit = typeof c.expected === "string" ? output.trim() === c.expected.trim() || (o.ok && same(o.v, c.expected)) : o.ok && same(o.v, c.expected);
      return { score: hit ? 1 : 0, exact: hit ? 1 : 0 };
    }
    if (scorer === "builtin:json-schema") {
      const o = json(output);
      if (!o.ok) return { score: 0, valid: 0 };
      const e = isObject(c.expected) ? c.expected : {};
      if (isObject(e.schema)) {
        if (schemaProblems(e.schema).length) return {};
        return { score: validateJson(o.v, e.schema as JsonSchema).length ? 0 : 1, valid: 1 };
      }
      if (typeof e.valid === "boolean") {
        if (!isObject(o.v) || schemaProblems(o.v).length) return { score: 0, valid: 0 };
        const passes = !validateJson(c.input, o.v as JsonSchema).length;
        return { score: passes === e.valid ? 1 : 0, valid: 1 };
      }
      return {};
    }
    if (scorer === "builtin:governance-sim") {
      const o = json(output);
      const policy = o.ok ? policyOf(o.v) : null;
      const want = typeof c.expected === "string" ? c.expected : isObject(c.expected) && typeof c.expected.decision === "string" ? c.expected.decision : null;
      if (!want) return {};
      if (!policy) return { score: 0, valid: 0, false_allow: 0 };
      const x = isObject(c.input) ? c.input : {};
      const tool = isObject(x.tool) ? x.tool : {};
      const got = governToolUse({ name: String(tool.name ?? ""), input: isObject(tool.input) ? tool.input : {} }, policy, { webCalls: Number(x.web_calls ?? 0) || 0, mcpCalls: Number(x.mcp_calls ?? 0) || 0, now: typeof x.now === "number" ? x.now : 0 }).decision;
      return { score: got === want ? 1 : 0, valid: 1, false_allow: got === "allow" && want !== "allow" ? 1 : 0 };
    }
  } catch { /* an output that breaks a scorer measures nothing */ }
  return {};
}
