/**
 * Redaction of workspace credential values (mold_v0-034): what a run writes (its stdout and stderr, results, error
 * messages) passes through here before it is stored or sent, so a value a program prints never lands in run_events,
 * run_results, the MCP output or a log. Used by the harness (src/run-harness.ts), which holds the values it delivered,
 * and again by the engine (src/runs.ts), which reads them for the run it is writing. Pure: no imports, no I/O.
 *
 * A value is replaced wherever it appears as is, JSON-escaped, or base64/hex-encoded (the encodings a program most
 * often prints a key in). Values are at least 8 characters (src/credentials.ts), so short common strings are never
 * mistaken for one.
 */
export interface Secret { name: string; value: string }

const forms = (v: string): string[] => {
  const out = new Set<string>([v]);
  const json = JSON.stringify(v).slice(1, -1);
  out.add(json);
  const b = Buffer.from(v, "utf8");
  out.add(b.toString("base64"));
  out.add(b.toString("base64").replace(/=+$/, ""));
  out.add(b.toString("base64url"));
  out.add(b.toString("hex"));
  // A value of several lines (a PEM key) printed line by line: each of its lines is a form too.
  if (/[\r\n]/.test(v)) for (const line of v.split(/\r?\n/)) out.add(line.trim());
  return [...out].filter((x) => x.length >= 8).sort((a, b2) => b2.length - a.length);
};

/** `text` with every form of every secret replaced by "[credential <name>]". */
export function redactText(text: string, secrets: readonly Secret[]): string {
  if (!secrets.length || !text) return text;
  let out = text;
  for (const s of secrets) for (const f of forms(s.value)) if (out.includes(f)) out = out.split(f).join(`[credential ${s.name}]`);
  return out;
}

/** A JSON value with every secret redacted in every string (keys included). */
export function redactJson<T>(v: T, secrets: readonly Secret[]): T {
  if (!secrets.length) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return redactText(x, secrets);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [redactText(k, secrets), walk(y)]));
    return x;
  };
  return walk(v) as T;
}

/** Whether `buf` holds any form of any secret (a file a run would write back to the workspace store). */
export function findSecret(buf: Buffer, secrets: readonly Secret[]): string | null {
  for (const s of secrets) for (const f of forms(s.value)) if (buf.includes(f)) return s.name;
  return null;
}
