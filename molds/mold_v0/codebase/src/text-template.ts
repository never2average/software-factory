/**
 * Text templates (mold_v0-137; molds/mold_v0/MOLD.md "MCP words as config"): words a pack declares in its pack.json,
 * with values filled in where they are used. A declared slash command's text (pack.json `mcp.prompts[].text`, filled
 * with the person's arguments: src/mcp-prompts.ts) and a host pack's engine texts (pack.json `engine.config`, filled by
 * its own code through src/pack-host.ts `fillTemplate`) are written in it.
 *
 *   {name}             the value as text, an empty one included (nothing when there is no value)
 *   {name|json}        the value as JSON: a string quoted and escaped, a number as it is (`null` when there is none)
 *   {a,b,c|json}       a JSON object of those of a, b and c that are given, in that order ({"a":"x","c":2})
 *   {?name}…{/name}    the text inside only when name is given
 *   {!name}…{/name}    the text inside only when it is not
 *   {{                 a literal {
 *
 * Blocks nest (never inside a block of the same name). Anything else in braces is text as written: "{}",
 * "{ product: ... }", "{profiles: [slug]}". Given (for blocks and objects): a value that is not undefined, null, false,
 * an empty string or a number that is not finite; there is no value only for undefined and null. A template is parsed once; every name it uses must be one the caller says it fills
 * (templateProblems), so a typo is refused where the template is declared, never shown to a person.
 *
 * No imports: the build's own checks (scripts/gen-packs.mjs, through src/pack-api.ts) and the server share it.
 */
export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateValues = Readonly<Record<string, TemplateValue>>;

type Node =
  | { t: "text"; s: string }
  | { t: "value"; name: string; json: boolean }
  | { t: "object"; names: string[] }
  | { t: "block"; name: string; when: boolean; body: Node[] };

const TOKEN = /\{\{|\{([?!/]?)([a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*)(\|json)?\}/g;

/** Parse a template: its nodes, or the problems (each a plain sentence). */
function parse(text: string): { nodes: Node[]; problems: string[] } {
  const problems: string[] = [];
  const root: Node[] = [];
  const stack: { name: string; body: Node[] }[] = [];
  const out = () => (stack.length ? stack[stack.length - 1]!.body : root);
  const pushText = (s: string) => {
    if (!s) return;
    const o = out(), last = o[o.length - 1];
    if (last?.t === "text") last.s += s; else o.push({ t: "text", s });
  };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    pushText(text.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[0] === "{{") { pushText("{"); continue; }
    const [whole, sigil, list, json] = m as unknown as [string, string, string, string | undefined];
    const names = list.split(",");
    if (sigil) {
      if (names.length > 1 || json) { problems.push(`${whole}: a block names one value, with no |json`); continue; }
      const name = names[0]!;
      if (sigil === "/") {
        const open = stack.pop();
        if (!open) problems.push(`${whole} closes no block`);
        else if (open.name !== name) problems.push(`${whole} closes the block of ${open.name} ({/${open.name}} expected)`);
        continue;
      }
      if (stack.some((b) => b.name === name)) { problems.push(`{${sigil}${name}} is inside a block of the same name`); continue; }
      const node: Node = { t: "block", name, when: sigil === "?", body: [] };
      out().push(node);
      stack.push({ name, body: node.body });
      continue;
    }
    if (names.length > 1) {
      if (!json) { problems.push(`${whole}: several values are written as one JSON object ({${list}|json})`); continue; }
      if (new Set(names).size !== names.length) { problems.push(`${whole} names a value twice`); continue; }
      out().push({ t: "object", names });
    } else out().push({ t: "value", name: names[0]!, json: !!json });
  }
  pushText(text.slice(at));
  for (const b of stack.reverse()) problems.push(`{?${b.name}} or {!${b.name}} is never closed ({/${b.name}})`);
  return { nodes: root, problems };
}

const namesIn = (nodes: Node[], into = new Set<string>()): Set<string> => {
  for (const n of nodes) {
    if (n.t === "value") into.add(n.name);
    else if (n.t === "object") n.names.forEach((x) => into.add(x));
    else if (n.t === "block") { into.add(n.name); namesIn(n.body, into); }
  }
  return into;
};

/** What is wrong with a template that may use only `names` (each problem a plain sentence; none when it is sound). */
export function templateProblems(text: string, names: Iterable<string>): string[] {
  const { nodes, problems } = parse(text);
  const allowed = new Set(names);
  for (const n of namesIn(nodes)) if (!allowed.has(n)) problems.push(`{${n}} is not a value this text is filled with (${allowed.size ? [...allowed].join(", ") : "none"})`);
  return problems;
}

/** The names a template uses. */
export const templateNames = (text: string): string[] => [...namesIn(parse(text).nodes)];

export const isGiven = (v: TemplateValue): boolean =>
  v !== undefined && v !== null && v !== false && v !== "" && !(typeof v === "number" && !Number.isFinite(v));

const render = (nodes: Node[], values: TemplateValues): string => {
  let s = "";
  for (const n of nodes) {
    if (n.t === "text") s += n.s;
    else if (n.t === "value") {
      const v = values[n.name];
      s += v === undefined || v === null ? (n.json ? "null" : "") : n.json ? JSON.stringify(v) : String(v);
    } else if (n.t === "object") {
      const o: Record<string, TemplateValue> = {};
      for (const k of n.names) if (isGiven(values[k])) o[k] = values[k];
      s += JSON.stringify(o);
    } else if (isGiven(values[n.name]) === n.when) s += render(n.body, values);
  }
  return s;
};

const cache = new Map<string, Node[]>();
/**
 * Fill a template with values. Throws on a template that does not parse (a declared one was checked where it was
 * declared); a name with no value renders as not given.
 */
export function fillTemplate(text: string, values: TemplateValues = {}): string {
  let nodes = cache.get(text);
  if (!nodes) {
    const p = parse(text);
    if (p.problems.length) throw new Error(`a text template does not parse: ${p.problems.join("; ")}`);
    nodes = p.nodes;
    if (cache.size < 2000) cache.set(text, nodes);
  }
  return render(nodes, values);
}

/**
 * A result object as a template's values (mold_v0-140: a pack's admin tool summary, pack.json admin_mcp.reword
 * summary_template): each value that is text, a number or a boolean by its path with the keys joined by _ ({account_name}
 * for d.account.name), and each list's length as {<path>_count} ({members_count}), three levels deep. A key that is no
 * template name (capitals, dashes) is left out; the first of two paths that join to one name wins.
 */
export function summaryValues(d: unknown): Record<string, TemplateValue> {
  const out: Record<string, TemplateValue> = {};
  const NAME = /^[a-z][a-z0-9_]*$/;
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!NAME.test(k)) continue;
      const name = prefix ? `${prefix}_${k}` : k;
      if (Array.isArray(x)) { if (!(`${name}_count` in out)) out[`${name}_count`] = x.length; }
      else if (x === null || ["string", "number", "boolean"].includes(typeof x)) { if (!(name in out)) out[name] = x as TemplateValue; }
      else if (x instanceof Date) { if (!(name in out)) out[name] = x.toISOString(); }
      else if (depth < 3) walk(x, name, depth + 1);
    }
  };
  walk(d, "", 1);
  return out;
}
