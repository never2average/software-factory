/**
 * Validating the payload a caller hands a workflow.
 *
 * A workflow run that silently ignores its arguments is the worst outcome
 * available: it succeeds, produces a plausible document about the wrong scope,
 * and nothing anywhere says the payload was dropped. "Run renewal-risk for
 * Acme" that quietly assesses the whole book looks like it worked.
 *
 * So a payload is checked against what the SCRIPT actually reads, and anything
 * that does not line up fails immediately rather than at the end of a run that
 * spent tokens.
 */

/** Keys a script reads off `args`, or null when it reads them dynamically. */
export function argKeysRead(script: string): Set<string> | null {
  // Comments can mention args.foo without reading it.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * `args[expr]` with a non-literal subscript means the script chooses keys at
   * runtime, so no static list can be complete. Checking against a partial list
   * would reject correct payloads — the worse error of the two, because it
   * blocks work that would have succeeded.
   */
  if (/\bargs\s*\[\s*[^"'\]\s]/.test(code)) return null;

  const keys = new Set<string>();
  for (const m of code.matchAll(/\bargs\s*(?:&&\s*args\s*)?\.\s*([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\bargs\s*\[\s*["']([^"']+)["']\s*\]/g)) keys.add(m[1]);
  return keys;
}

export interface ArgsProblem {
  message: string;
  /** What the script does read, so the caller can correct itself in one step. */
  expected?: string[];
}

/**
 * Check a payload against a script. Returns null when it is fine.
 *
 * Deliberately strict about EXTRA keys. The common failure is a near-miss —
 * `customer` for `customerId`, `account_id` for `customerId` — and a near-miss
 * accepted silently is exactly the run that produces confident nonsense.
 * Missing keys are NOT an error: a script may reasonably treat every argument
 * as optional, as renewal-risk does.
 */
export function validateWorkflowArgs(script: string, args: unknown): ArgsProblem | null {
  if (args === undefined || args === null) return null;

  if (typeof args !== "object" || Array.isArray(args)) {
    return {
      message: `args must be a JSON object, not ${Array.isArray(args) ? "an array" : typeof args}.`,
    };
  }

  const provided = Object.keys(args as Record<string, unknown>);
  if (provided.length === 0) return null;

  const read = argKeysRead(script);
  if (read === null) return null; // dynamic access — cannot judge, so do not
  if (read.size === 0) {
    return {
      message: `This workflow reads no arguments, so ${JSON.stringify(provided)} would be ignored.`,
      expected: [],
    };
  }

  const unknown = provided.filter((k) => !read.has(k));
  if (unknown.length) {
    return {
      message: `This workflow never reads ${unknown.map((k) => `"${k}"`).join(", ")}.`,
      expected: [...read].sort(),
    };
  }
  return null;
}

/**
 * Parse a payload that may arrive as an object or as JSON text.
 *
 * Models emit both, and a JSON string that fails to parse must fail HERE, with
 * the parser's own message, rather than reaching the runtime as a string that
 * every `args.x` lookup then reads as undefined.
 */
export function coerceWorkflowArgs(raw: unknown): { args?: unknown; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return {};
    try {
      return { args: JSON.parse(text) };
    } catch (e) {
      return { error: `args is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { args: raw };
}
