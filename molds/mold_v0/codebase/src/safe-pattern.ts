/**
 * Bounded patterns (mold_v0-123): the one kind of regular expression a pack.json may hold, used by a repository's row
 * map (`matches` in `where` and in a field's value; src/data-repositories.ts). A pattern is checked when the build reads
 * pack.json (src/pack-api.ts RowMapSchema) and compiled once; it can never take more than a bounded time on any text:
 *
 *   - at most PATTERN_LIMITS.chars characters, compiled with Unicode rules (the `u` flag), no other flag
 *   - literal characters, `.`, `^`, `$`, character classes `[a-z0-9_-]` (`[^...]` too), the escapes \d \D \w \W \s \S
 *     and an escaped punctuation character (`\.`, `\:`, `\(` ...; `\-` inside a class), alternation `a|b`, groups
 *     `( )` and `(?: )`, and the repetitions `?`, `*`, `+`, `{n}`, `{n,}`, `{n,m}` (n, m at most 1,000)
 *   - never: a lookahead or lookbehind, a backreference or named group, a lazy or possessive repetition, a word
 *     boundary, a Unicode property or code-point escape, a control character
 *   - a group is never repeated (only `?`, on a group with no repetition inside it): a repeated group holding a
 *     repetition is what makes matching take exponential time
 *   - the product of every repetition's range (an unbounded one counted as the text limit) is at most
 *     PATTERN_LIMITS.cost, which bounds the backtracking on one text
 *   - the text a pattern is tested on is at most PATTERN_LIMITS.text characters: longer text never matches
 *
 * No imports: gen-packs and the server read the same rules.
 */

export const PATTERN_LIMITS = { chars: 200, cost: 2_000, text: 1_000, repeat: 1_000, depth: 4 } as const;

/** Escapes a pattern may use outside a class: the character kinds, and punctuation that would otherwise mean something. */
const KIND_ESCAPES = new Set(["d", "D", "w", "W", "s", "S"]);
const SYNTAX = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"]);

class PatternError extends Error {}

/** Why `src` is not a bounded pattern, or null when it is. */
export function patternProblem(src: unknown): string | null {
  if (typeof src !== "string" || !src.length) return "a pattern is non-empty text";
  if (src.length > PATTERN_LIMITS.chars) return `a pattern is at most ${PATTERN_LIMITS.chars} characters`;
  if (/[\u0000-\u001f\u007f]/.test(src)) return "a pattern holds no control character (write \\s for a space or a line break)";
  let i = 0;
  let cost = 1;
  const fail = (m: string): never => { throw new PatternError(`${m} (at character ${i + 1})`); };
  const escape = (inClass: boolean) => {
    const c = src[i + 1];
    if (c === undefined) fail("a pattern does not end with \\");
    if (KIND_ESCAPES.has(c!) || SYNTAX.has(c!) || (inClass && c === "-")) { i += 2; return; }
    fail(`\\${c} is not taken: only \\d \\D \\w \\W \\s \\S and escaped punctuation such as \\. or \\( (a colon or a hyphen outside a class is written plain)`);
  };
  const klass = () => {
    i++; // [
    if (src[i] === "^") i++;
    let items = 0;
    while (i < src.length && src[i] !== "]") {
      if (src[i] === "\\") escape(true);
      else if (src[i] === "[") fail("a class holds no [ (escape it as \\[)");
      else i++;
      items++;
    }
    if (src[i] !== "]") fail("a class [ is not closed");
    if (!items) fail("an empty class [] matches nothing");
    i++;
  };
  /** A sequence of alternatives up to `)` or the end; whether any repetition is inside. */
  const alternatives = (depth: number): boolean => {
    let repeated = false;
    for (;;) {
      while (i < src.length && src[i] !== "|" && src[i] !== ")") {
        const c = src[i]!;
        let kind: "char" | "group" | "anchor" = "char";
        let inner = false;
        if (c === "^" || c === "$") { kind = "anchor"; i++; }
        else if (c === "(") {
          if (src[i + 1] === "?") { if (src[i + 2] === ":") i += 3; else fail("(?...) is not taken: no lookahead, lookbehind or named group"); }
          else i++;
          if (depth >= PATTERN_LIMITS.depth) fail(`groups nest at most ${PATTERN_LIMITS.depth} deep`);
          inner = alternatives(depth + 1);
          if (src[i] !== ")") fail("a group ( is not closed");
          i++;
          kind = "group";
        } else if (c === "[") klass();
        else if (c === "\\") escape(false);
        else if ("*+?{".includes(c)) fail(`${c} repeats nothing`);
        else if (c === "]" || c === "}") fail(`${c} stands alone: escape it as \\${c}`);
        else i++;
        // A repetition after the atom.
        const q = src[i];
        if (q === "*" || q === "+" || q === "?" || q === "{") {
          let max: number;
          if (q === "{") {
            const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(src.slice(i));
            if (!m) fail("{ starts a repetition {n}, {n,} or {n,m}: escape it as \\{ otherwise");
            const lo = Number(m![1]), hi = m![2] === undefined ? lo : m![3] === "" ? Infinity : Number(m![3]);
            if (lo > PATTERN_LIMITS.repeat || (hi !== Infinity && hi > PATTERN_LIMITS.repeat)) fail(`a repetition is at most ${PATTERN_LIMITS.repeat}`);
            if (hi < lo) fail("a repetition {n,m} has n at most m");
            max = hi;
            i += m![0].length;
          } else { max = q === "?" ? 1 : Infinity; i++; }
          if (src[i] === "?" || src[i] === "+" || src[i] === "*" || src[i] === "{") fail("a repetition is not followed by ?, +, * or { (no lazy or stacked repetition)");
          if (kind === "anchor") fail("an anchor (^ or $) is not repeated");
          if (kind === "group" && (max !== 1 || inner)) fail("a group is never repeated (only ? on a group with no repetition inside): a repeated group can take exponential time");
          cost *= max === Infinity ? PATTERN_LIMITS.text : max + 1;
          if (cost > PATTERN_LIMITS.cost) fail(`the repetitions allow too many ways to match (their ranges multiply past ${PATTERN_LIMITS.cost}): use fewer or smaller ones`);
          repeated = true;
        }
        if (kind === "group" && inner) repeated = true;
      }
      if (src[i] === "|") { i++; continue; }
      return repeated;
    }
  };
  try {
    alternatives(0);
    if (i < src.length) fail(") closes no group");
    new RegExp(src, "u");
  } catch (e) {
    return e instanceof PatternError ? e.message : `not a pattern: ${(e as Error).message.replace(/^Invalid regular expression: /, "").slice(0, 120)}`;
  }
  return null;
}

const compiled = new Map<string, RegExp>();
/** The pattern compiled (checked first: a pattern that is not bounded throws). */
export function boundedPattern(src: string): RegExp {
  let re = compiled.get(src);
  if (re) return re;
  const p = patternProblem(src);
  if (p) throw new Error(`pattern ${JSON.stringify(String(src).slice(0, 60))}: ${p}`);
  re = new RegExp(src, "u");
  if (compiled.size > 500) compiled.clear();
  compiled.set(src, re);
  return re;
}

/** Whether `v` is text the pattern matches: text only, at most PATTERN_LIMITS.text characters. */
export const patternMatches = (src: string, v: unknown): boolean =>
  typeof v === "string" && v.length <= PATTERN_LIMITS.text && boundedPattern(src).test(v);
