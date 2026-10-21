/**
 * Redaction of workspace credential values (mold_v0-034): what a run writes (its stdout and stderr, results, error
 * messages, event types) passes through here before it is stored or sent, so a value a program prints by accident
 * never lands in run_events, run_results, the MCP output or a log. Used by the harness (src/run-harness.ts), which
 * holds the values it delivered, and again by the engine (src/runs.ts), which reads them for the run it is writing.
 * Pure: no imports, no I/O.
 *
 * A value is replaced wherever it appears as is, JSON-escaped, URL-encoded, hex, or base64 at any byte offset (so
 * "user:<value>" in a Basic header is caught too), and each line of a multi-line value. This guards against accidents,
 * not against a hostile program: one that reverses, splits or re-encodes a value can still print it (the run's egress
 * allowlist and its user are what bound such a program). Values are at least 8 characters (src/credentials.ts).
 */
export interface Secret { name: string; value: string }

const MIN_FORM = 8;
/** base64 of `v` at byte offset k (0, 1, 2) in a longer buffer: the characters that depend on `v` alone. */
const b64At = (v: Buffer, k: number, url: boolean) => {
  const s = Buffer.concat([Buffer.alloc(k), v]).toString(url ? "base64url" : "base64");
  return s.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + v.length)) / 6));
};

const formsOf = (v: string): string[] => {
  const out = new Set<string>([v, JSON.stringify(v).slice(1, -1)]);
  try { out.add(encodeURIComponent(v)); } catch { /* lone surrogate: no URL form */ }
  const b = Buffer.from(v, "utf8");
  for (const k of [0, 1, 2]) { out.add(b64At(b, k, false)); out.add(b64At(b, k, true)); }
  out.add(b.toString("hex"));
  out.add(b.toString("hex").toUpperCase());
  // A value of several lines (a PEM key) printed line by line: each of its lines is a form too.
  if (/[\r\n]/.test(v)) for (const line of v.split(/\r?\n/)) out.add(line.trim());
  return [...out].filter((x) => x.length >= MIN_FORM);
};

/** Every form of every secret, longest first across all of them (a value inside another is replaced after it). */
const allForms = (secrets: readonly Secret[]) =>
  secrets.flatMap((s) => formsOf(s.value).map((f) => ({ f, name: s.name }))).sort((a, b) => b.f.length - a.f.length);

/** `text` with every form of every secret replaced by "[credential <name>]". */
export function redactText(text: string, secrets: readonly Secret[]): string {
  if (!secrets.length || !text) return text;
  let out = text;
  for (const { f, name } of allForms(secrets)) if (out.includes(f)) out = out.split(f).join(`[credential ${name}]`);
  return out;
}

/** A JSON value with every secret redacted in every string and key; a number that spells a value becomes a string. */
export function redactJson<T>(v: T, secrets: readonly Secret[]): T {
  if (!secrets.length) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return redactText(x, secrets);
    if (typeof x === "number" || typeof x === "bigint") { const s = String(x), r = redactText(s, secrets); return r === s ? x : r; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [redactText(k, secrets), walk(y)]));
    return x;
  };
  return walk(v) as T;
}

/** Whether `buf` (a file's contents, or its path) holds any form of any secret: the name of that secret, or null. */
export function findSecret(buf: Buffer | string, secrets: readonly Secret[]): string | null {
  for (const { f, name } of allForms(secrets)) if (buf.includes(f)) return name;
  return null;
}
