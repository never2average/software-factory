// A rule's logic in plain words (mold_v0-337): a JsonLogic expression ({"<": [{"var": "documents"}, 2]}) read as
// "documents is less than 2" wherever a record's json is shown in words (./json-text.ts, a table's cells in
// ./code-text.ts). The common operators only; any other part is shown as its JSON (the raw fallback), so nothing is
// ever hidden or guessed. Pure, no imports: proven offline (scripts/apps-ui-337-test.ts). Generic: it knows JsonLogic,
// not any pack's rules.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The comparisons, in words. */
const COMPARE: Record<string, string> = {
  '==': 'is', '===': 'is', '!=': 'is not', '!==': 'is not',
  '<': 'is less than', '<=': 'is at most', '>': 'is more than', '>=': 'is at least',
};
const ARITHMETIC: Record<string, string> = { '+': '+', '-': '-', '*': '×', '/': '÷', '%': 'mod' };
/** Every operator read in words (anything else is a raw part). */
export const LOGIC_OPERATORS = [...Object.keys(COMPARE), ...Object.keys(ARITHMETIC), 'var', 'and', 'or', '!', '!!', 'if', '?:', 'in', 'missing', 'missing_some', 'min', 'max', 'cat', 'some', 'all', 'none'] as const;
const KNOWN = new Set<string>(LOGIC_OPERATORS);

/** Whether a value is a JsonLogic expression whose top operator is one this reads (one key, a known operator). */
export function isLogic(v: unknown): boolean {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && KNOWN.has(keys[0]!) && keys[0] !== 'var';
}

const raw = (v: unknown) => JSON.stringify(v);
const args = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
/** A literal in words: text quoted, a list joined, nothing as "nothing". */
function literal(v: unknown): string {
  if (v === null || v === undefined) return 'nothing';
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(words).join(', ');
  return String(v);
}
/** A variable's name: its path ("vendor.documents" reads vendor documents), "it" for the item in some/all/none. */
function variable(a: unknown): string {
  const name = Array.isArray(a) ? a[0] : a;
  if (name === '' || name === null || name === undefined) return 'it';
  return String(name).replace(/[._]+/g, ' ');
}
/** A part inside another: and/or/if wrapped in brackets so the reading keeps its grouping. */
function inner(v: unknown): string {
  const w = words(v);
  return isObj(v) && ['and', 'or', 'if', '?:'].includes(Object.keys(v)[0] ?? '') ? `(${w})` : w;
}

/** Any value in words: an expression read, a literal said, an operator this does not know as its JSON. */
export function words(v: unknown): string {
  if (!isObj(v)) return literal(v);
  const keys = Object.keys(v);
  if (keys.length !== 1 || !KNOWN.has(keys[0]!)) return raw(v);
  const op = keys[0]!, a = args(v[op]);
  if (op === 'var') return variable(v[op]);
  if (op in COMPARE) {
    // A between: {"<": [1, x, 10]} is 1 < x < 10.
    if (a.length === 3 && (op === '<' || op === '<=')) return `${inner(a[1])} is between ${inner(a[0])} and ${inner(a[2])}${op === '<=' ? ' (both included)' : ''}`;
    if (a.length !== 2) return raw(v);
    return `${inner(a[0])} ${COMPARE[op]} ${inner(a[1])}`;
  }
  if (op in ARITHMETIC) return a.length === 1 && op === '-' ? `minus ${inner(a[0])}` : a.map(inner).join(` ${ARITHMETIC[op]} `);
  switch (op) {
    case 'and': return a.map(inner).join(' and ');
    case 'or': return a.map(inner).join(' or ');
    case '!': return isObj(a[0]) && Object.keys(a[0])[0] === 'var' ? `${inner(a[0])} is empty` : `not ${inner(a[0])}`;
    case '!!': return isObj(a[0]) && Object.keys(a[0])[0] === 'var' ? `${inner(a[0])} is set` : `${inner(a[0])} is true`;
    case 'if': case '?:': {
      // [if, then, else if, then, ..., else]
      const parts: string[] = [];
      for (let i = 0; i + 1 < a.length; i += 2) parts.push(`${i === 0 ? 'if' : 'else if'} ${inner(a[i])} then ${inner(a[i + 1])}`);
      if (a.length % 2 === 1) parts.push(`else ${inner(a[a.length - 1])}`);
      return parts.join(', ');
    }
    case 'in': return a.length === 2 ? (Array.isArray(a[1]) ? `${inner(a[0])} is one of ${literal(a[1])}` : `${inner(a[1])} contains ${inner(a[0])}`) : raw(v);
    case 'missing': return `${a.map((x) => (typeof x === 'string' ? x.replace(/[._]+/g, ' ') : words(x))).join(', ')} ${a.length === 1 ? 'is' : 'are'} missing`;
    case 'missing_some': return a.length === 2 && Array.isArray(a[1]) ? `fewer than ${literal(a[0])} of ${(a[1] as unknown[]).map((x) => String(x).replace(/[._]+/g, ' ')).join(', ')} are given` : raw(v);
    case 'min': return `the least of ${a.map(inner).join(', ')}`;
    case 'max': return `the most of ${a.map(inner).join(', ')}`;
    case 'cat': return a.map(inner).join(' then ');
    case 'some': case 'all': case 'none':
      return a.length === 2 ? `${op === 'some' ? 'some of' : op === 'all' ? 'every one of' : 'none of'} ${inner(a[0])} match: ${words(a[1])}` : raw(v);
  }
  return raw(v);
}

/** A value's words when it is a rule's logic (isLogic), else null: the caller shows it as it would any other value. */
export function logicWords(v: unknown): string | null {
  return isLogic(v) ? words(v) : null;
}
