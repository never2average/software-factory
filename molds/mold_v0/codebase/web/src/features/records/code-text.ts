// What a record page's code, table, history and file sections decide without drawing (mold_v0-256, flag record_pages):
// a field as JSON, YAML or text, cut into highlighted tokens per line; a json list's table columns and cells; a long
// text's line diff; a record's files as a tree. Pure, so scripts/record-pages-test.ts reads it without a browser; the
// sections draw it (./code-view.tsx, ./history-section.tsx, ./file-browser.tsx). Relative imports only.

export type CodeLanguage = 'json' | 'yaml' | 'text';
/** A token's kind: each its own colour (theme-mixed, legible in light and dark). */
export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'comment' | 'plain';
export interface Token { kind: TokenKind; text: string }

/** A value as YAML (block style; strings quoted only when they must be): a json field shown as a manifest. */
export function toYaml(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  const scalar = (x: unknown): string => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    const s = String(x);
    return s === '' || /^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|on|off|~)$|^[+-]?(\d|\.\d)/i.test(s) || s.includes('\n') ? JSON.stringify(s) : s;
  };
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[]`;
    return v.map((x) => {
      if (x && typeof x === 'object' && !(Array.isArray(x) && !x.length) && !(!Array.isArray(x) && !Object.keys(x).length)) {
        const inner = toYaml(x, indent + 1).replace(/^\s+/, '');
        return `${pad}- ${inner}`;
      }
      return `${pad}- ${x && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : scalar(x)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>);
    if (!e.length) return `${pad}{}`;
    return e.map(([k, x]) => {
      const key = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k);
      if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) return `${pad}${key}:\n${toYaml(x, indent + 1)}`;
      return `${pad}${key}: ${x && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : scalar(x)}`;
    }).join('\n');
  }
  return `${pad}${scalar(v)}`;
}

/** What a code section shows of a field's value in its language: JSON pretty-printed, YAML, or the text as it is. */
export function codeText(v: unknown, language: CodeLanguage): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    if (language === 'json') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
    return v;
  }
  return language === 'yaml' ? toYaml(v) : JSON.stringify(v, null, 2);
}
/** The language a field reads in by default: a json field JSON, a text field holding a JSON document JSON, else text. */
export function languageOf(v: unknown, declared?: CodeLanguage, type?: string): CodeLanguage {
  if (declared) return declared;
  if (type === 'json' || (v && typeof v === 'object')) return 'json';
  if (typeof v === 'string' && /^\s*[{[]/.test(v)) { try { JSON.parse(v); return 'json'; } catch { /* text */ } }
  if (typeof v === 'string' && /^[A-Za-z_][\w.-]*:\s/m.test(v) && /^\s*(---\s*$|[A-Za-z_][\w.-]*:)/.test(v)) return 'yaml';
  return 'text';
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|([^\s"{}[\],:]+)/g;
/** One line of JSON as tokens (a key a string followed by a colon). */
export function jsonTokens(line: string): Token[] {
  const out: Token[] = [];
  for (const m of line.matchAll(JSON_TOKEN)) {
    if (m[1] !== undefined) { out.push({ kind: m[2] ? 'key' : 'string', text: m[1] }); if (m[2]) out.push({ kind: 'punct', text: m[2] }); }
    else if (m[3] !== undefined) out.push({ kind: 'number', text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: 'literal', text: m[4] });
    else if (m[5] !== undefined) out.push({ kind: 'punct', text: m[5] });
    else out.push({ kind: 'plain', text: m[0] });
  }
  return out;
}
/** One line of YAML as tokens: its indent and dash, a key and its colon, then the value (quoted, number, literal, text), a comment. */
export function yamlTokens(line: string): Token[] {
  const out: Token[] = [];
  const m = /^(\s*)(-\s+)?(?:((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s#:'"][^:#]*?))(\s*:)(?=\s|$))?(.*)$/.exec(line)!;
  if (m[1]) out.push({ kind: 'plain', text: m[1] });
  if (m[2]) out.push({ kind: 'punct', text: m[2] });
  if (m[3]) { out.push({ kind: 'key', text: m[3] }); out.push({ kind: 'punct', text: m[4]! }); }
  let rest = m[5] ?? '';
  const c = /(^|\s)#.*$/.exec(rest);
  const comment = c ? rest.slice(c.index + c[1]!.length) : '';
  if (c) rest = rest.slice(0, c.index + c[1]!.length);
  const lead = /^\s*/.exec(rest)![0], v = rest.slice(lead.length), trail = /\s*$/.exec(v)![0], core = v.slice(0, v.length - trail.length);
  if (lead) out.push({ kind: 'plain', text: lead });
  if (core) out.push({ kind: /^(['"]).*\1$/.test(core) ? 'string' : /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(core) ? 'number'
    : /^(true|false|null|yes|no|on|off|~)$/i.test(core) ? 'literal' : /^[|>[\]{}-]+$/.test(core) || core === '---' ? 'punct' : 'string', text: core });
  if (trail) out.push({ kind: 'plain', text: trail });
  if (comment) out.push({ kind: 'comment', text: comment });
  return out;
}
/** A line in its language as tokens (text: one plain token). */
export const tokensOf = (line: string, language: CodeLanguage): Token[] =>
  language === 'json' ? jsonTokens(line) : language === 'yaml' ? yamlTokens(line) : [{ kind: 'plain', text: line }];
/** Each token kind's colour: theme tokens mixed toward the foreground, the same in both themes' contrast. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  key: 'text-[color:color-mix(in_oklab,var(--viz-1)_70%,var(--foreground))]',
  string: 'text-[color:color-mix(in_oklab,var(--viz-2)_70%,var(--foreground))]',
  number: 'text-[color:color-mix(in_oklab,var(--viz-4)_72%,var(--foreground))]',
  literal: 'text-[color:color-mix(in_oklab,var(--viz-5)_72%,var(--foreground))] font-medium',
  punct: 'text-muted-foreground',
  comment: 'text-muted-foreground italic',
  plain: ''
};
/** A download's name and type for a code section: the field's name and its language's extension. */
export const codeFile = (name: string, language: CodeLanguage) => ({
  name: `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'value'}.${language === 'json' ? 'json' : language === 'yaml' ? 'yaml' : 'txt'}`,
  type: language === 'json' ? 'application/json' : language === 'yaml' ? 'application/yaml' : 'text/plain'
});

// ---------------------------------------------------------------- a json list as a table

/** A json field's value as a list of objects (a table's rows), or null when it is not one. */
export function tableRows(v: unknown): Record<string, unknown>[] | null {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return null; } }
  if (!Array.isArray(x)) return null;
  return x.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r }));
}
/** The table's columns: those declared, else every key its rows have, in the order they first show (at most 8). */
export function tableColumns(rows: readonly Record<string, unknown>[], declared?: readonly string[]): string[] {
  if (declared?.length) return [...declared];
  const seen: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  return seen.slice(0, 8);
}
/** A column key in words: words split at _ and capitals, the first capitalised. */
export const columnWords = (k: string) => { const w = k.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); };
/** A cell: a number grouped, a boolean Yes or No, a list joined, an object as key: value pairs, nothing a dash. */
export function cellText(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString('en', { maximumFractionDigits: 4 });
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(cellText).join(', ');
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${cellText(x)}`).join(', ');
  return String(v);
}
/** Whether a column holds numbers only (right-aligned, tabular). */
export const numericColumn = (rows: readonly Record<string, unknown>[], k: string) => rows.some((r) => typeof r[k] === 'number') && rows.every((r) => r[k] == null || typeof r[k] === 'number');

// ---------------------------------------------------------------- a long text's line diff

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string; a: number | null; b: number | null };
/** Whether a change's values read best as a diff: either is text over 80 characters or of more than one line. */
export const isLongText = (before: unknown, after: unknown) => [before, after].some((v) => typeof v === 'string' && (v.length > 80 || v.includes('\n')));
/**
 * The line diff of two texts (the longest common subsequence of their lines; past 2,000 lines each, the common head and
 * tail kept and the middle shown removed then added). Each line with its number before (a) and after (b).
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const A = before.split('\n'), B = after.split('\n');
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a = A.slice(head, A.length - tail), b = B.slice(head, B.length - tail);
  const out: DiffLine[] = A.slice(0, head).map((t, i) => ({ kind: 'same', text: t, a: i + 1, b: i + 1 }));
  if (a.length * b.length > 4_000_000) {
    a.forEach((t, i) => out.push({ kind: 'removed', text: t, a: head + i + 1, b: null }));
    b.forEach((t, i) => out.push({ kind: 'added', text: t, a: null, b: head + i + 1 }));
  } else {
    const L: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'same', text: a[i]!, a: head + i + 1, b: head + j + 1 }); i++; j++; }
      // A change reads as its removed lines, then its added ones.
      else if (i < a.length && (j >= b.length || L[i + 1]![j]! >= L[i]![j + 1]!)) { out.push({ kind: 'removed', text: a[i]!, a: head + i + 1, b: null }); i++; }
      else { out.push({ kind: 'added', text: b[j]!, a: null, b: head + j + 1 }); j++; }
    }
  }
  A.slice(A.length - tail).forEach((t, k) => out.push({ kind: 'same', text: t, a: A.length - tail + k + 1, b: B.length - tail + k + 1 }));
  return out;
}
/** A diff with long runs of unchanged lines folded to `context` lines around each change ({skip: n} in their place). */
export function foldDiff(lines: readonly DiffLine[], context = 3): (DiffLine | { skip: number })[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
  const out: (DiffLine | { skip: number })[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) { out.push(lines[i]!); continue; }
    let n = 0;
    while (i < lines.length && !keep[i]) { n++; i++; }
    i--;
    out.push({ skip: n });
  }
  return out;
}
/** How many lines a diff adds and removes. */
export const diffCounts = (lines: readonly DiffLine[]) => ({ added: lines.filter((l) => l.kind === 'added').length, removed: lines.filter((l) => l.kind === 'removed').length });

// ---------------------------------------------------------------- a record's files as a tree

export interface TreeFile<T> { path: string; item: T }
export interface TreeNode<T> { name: string; path: string; children: TreeNode<T>[]; item: T | null }
/** Files by their paths ("Reports/2026/q3.pdf") as a tree: folders first, each level by name. */
export function fileTree<T>(files: readonly TreeFile<T>[]): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', path: '', children: [], item: null };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let at = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const leaf = i === parts.length - 1;
      let next = at.children.find((c) => c.name === p && (leaf ? c.item === null && !c.children.length : c.item === null));
      if (!next || leaf) { next = { name: p, path, children: [], item: leaf ? f.item : null }; at.children.push(next); }
      at = next;
    });
  }
  const sort = (n: TreeNode<T>[]): TreeNode<T>[] => n.sort((a, b) => Number(!!a.item) - Number(!!b.item) || a.name.localeCompare(b.name, 'en', { numeric: true })).map((x) => ({ ...x, children: sort(x.children) }));
  return sort(root.children);
}
/** Every node of a tree in the order it shows with these folders open (its depth beside it): the tree's rows. */
export function treeRows<T>(nodes: readonly TreeNode<T>[], open: ReadonlySet<string>, depth = 0): { node: TreeNode<T>; depth: number }[] {
  return nodes.flatMap((n) => [{ node: n, depth }, ...(!n.item && open.has(n.path) ? treeRows(n.children, open, depth + 1) : [])]);
}
/** Every folder's path (to open them all at first). */
export const folderPaths = <T,>(nodes: readonly TreeNode<T>[]): string[] => nodes.flatMap((n) => (n.item ? [] : [n.path, ...folderPaths(n.children)]));
/** A byte count in words (as the document cards: B, KB, MB). */
export const sizeWords = (n: number | null | undefined) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
