// Compare two parity snapshots (snapshot.mts) and print what differs, grouped, in words a reviewer reads:
//   tsx molds/mold_v0/testing/parity/diff.mts <before> <after> [--allow <allow.json>] [--pixel-threshold 0.001] [--json]
//       [--max-lines 40]
// Exit 0: nothing differs outside the allow list. 1: something does (printed). 2: a snapshot could not be read.
//
// Every difference has a key, parts joined by "::" (`mcp.customer::tools::list_products::description`,
// `pages::/app/settings::text`, `shots::/app::390-dark`, `generated::web/src/config/landing.generated.ts`). An allow list
// marks the differences a phase expects, by key pattern (`*` is any run without "::", `**` anything):
//   {"phase": "P1: tools from config", "allow": [{"key": "mcp.customer::tools::*::description", "reason": "reworded in config"}]}
// Allowed differences are printed in their own section and do not fail the diff; an entry that matched nothing is named
// (a stale entry hides nothing, but should go).
//
// Screenshots: two shots of one page differ when more than --pixel-threshold of their pixels (default 0.1%) differ by
// more than PIXEL_TOLERANCE in any channel (anti-aliasing and font hinting move single pixels between runs).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Difference { key: string; group: string; kind: "added" | "removed" | "changed"; summary: string; detail: string[] }
export interface AllowEntry { key: string; reason?: string }
export interface Result { differences: Difference[]; allowed: (Difference & { reason: string })[]; stale: AllowEntry[] }

export const PIXEL_TOLERANCE = 24;
export const GROUP_ORDER = ["meta", "mcp.customer", "mcp.admin", "generated", "api", "pages", "shots", "smoke"];

// ---------- line diff (Myers, O((N+M)D)) ----------

/** The edit script between two line lists: [" ", line] kept, ["-", line] only in a, ["+", line] only in b. */
export function lineDiff(a: string[], b: string[]): [" " | "-" | "+", string][] {
  // Common prefix and suffix first: most changes are small, and this keeps D small.
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length, max = n + m;
  const head: [" ", string][] = a.slice(0, pre).map((l) => [" ", l]);
  const tail: [" ", string][] = a.slice(a.length - suf).map((l) => [" ", l]);
  if (!n || !m || n * m > 25_000_000 && max > 20000) {
    // Nothing in common in the middle, or too large to search: all of a's middle went, all of b's came.
    return [...head, ...A.map((l) => ["-", l] as ["-", string]), ...B.map((l) => ["+", l] as ["+", string]), ...tail];
  }
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  const mid: [" " | "-" | "+", string][] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d]!, k = x - y;
    const prevK = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const px = vv.get(prevK) ?? 0, py = px - prevK;
    while (x > px && y > py) { mid.push([" ", A[x - 1]!]); x--; y--; }
    if (d > 0) { if (x === px) mid.push(["+", B[y - 1]!]); else mid.push(["-", A[x - 1]!]); }
    x = px; y = py;
  }
  return [...head, ...mid.reverse(), ...tail];
}

/** A unified-style excerpt: the changed lines with up to `ctx` lines around them, at most `max` lines. */
export function unified(a: string, b: string, max = 40, ctx = 2): string[] {
  const ops = lineDiff(a.split("\n"), b.split("\n"));
  const keep = new Set<number>();
  ops.forEach(([o], i) => { if (o !== " ") for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep.add(j); });
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((p, q) => p - q)) {
    if (last >= 0 && i > last + 1) out.push("  ...");
    out.push(`${ops[i]![0]} ${ops[i]![1]}`);
    last = i;
  }
  if (out.length > max) return [...out.slice(0, max), `  ... (${out.length - max} more lines of diff)`];
  return out;
}

// ---------- values ----------

const short = (v: unknown, n = 160) => { const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); return s.length > n ? s.slice(0, n) + "..." : s; };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** An array of objects that each carry one of these is compared by it, not by position. */
const ID_FIELDS = ["name", "uri", "uriTemplate", "path", "id", "key", "href"];
const idField = (arr: unknown[]) => ID_FIELDS.find((f) => arr.length > 0 && arr.every((x) => isObj(x) && typeof x[f] === "string") && new Set(arr.map((x) => (x as Record<string, unknown>)[f])).size === arr.length);

/** Every leaf that differs between two JSON values, by path. Arrays of named objects are matched by name, and a change
 * of their order is one difference of its own. */
export function jsonDiff(a: unknown, b: unknown, at: string[] = []): { at: string[]; kind: Difference["kind"]; a?: unknown; b?: unknown }[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const f = idField(a) && idField(a) === idField(b) ? idField(a)! : null;
    if (f) {
      const ka = a.map((x) => String((x as Record<string, unknown>)[f])), kb = b.map((x) => String((x as Record<string, unknown>)[f]));
      const out: ReturnType<typeof jsonDiff> = [];
      for (const k of ka) if (!kb.includes(k)) out.push({ at: [...at, k], kind: "removed", a: a[ka.indexOf(k)] });
      for (const k of kb) if (!ka.includes(k)) out.push({ at: [...at, k], kind: "added", b: b[kb.indexOf(k)] });
      for (const k of ka) if (kb.includes(k)) out.push(...jsonDiff(a[ka.indexOf(k)], b[kb.indexOf(k)], [...at, k]));
      const common = ka.filter((k) => kb.includes(k));
      if (common.join("\n") !== kb.filter((k) => ka.includes(k)).join("\n")) out.push({ at: [...at, "(order)"], kind: "changed", a: common, b: kb.filter((k) => ka.includes(k)) });
      return out;
    }
    if (a.every((x) => typeof x === "string") && b.every((x) => typeof x === "string")) return [{ at, kind: "changed", a: a.join("\n"), b: b.join("\n") }];
    const out: ReturnType<typeof jsonDiff> = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ at: [...at, `[${i}]`], kind: "added", b: b[i] });
      else if (i >= b.length) out.push({ at: [...at, `[${i}]`], kind: "removed", a: a[i] });
      else out.push(...jsonDiff(a[i], b[i], [...at, `[${i}]`]));
    }
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out: ReturnType<typeof jsonDiff> = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push({ at: [...at, k], kind: "removed", a: a[k] });
      else if (!(k in a)) out.push({ at: [...at, k], kind: "added", b: b[k] });
      else out.push(...jsonDiff(a[k], b[k], [...at, k]));
    }
    return out;
  }
  return [{ at, kind: "changed", a, b }];
}

function describe(group: string, key: string[], d: ReturnType<typeof jsonDiff>[number], max: number): Difference {
  const k = [group, ...key, ...d.at].join("::");
  if (d.kind === "added") return { key: k, group, kind: "added", summary: `added: ${short(d.b)}`, detail: [] };
  if (d.kind === "removed") return { key: k, group, kind: "removed", summary: `removed: ${short(d.a)}`, detail: [] };
  if (typeof d.a === "string" && typeof d.b === "string" && (d.a.includes("\n") || d.b.includes("\n") || d.a.length + d.b.length > 200))
    return { key: k, group, kind: "changed", summary: "text changed", detail: unified(d.a, d.b, max) };
  return { key: k, group, kind: "changed", summary: `${short(d.a)} -> ${short(d.b)}`, detail: [] };
}

// ---------- snapshots ----------

const readJson = (f: string): unknown => JSON.parse(readFileSync(f, "utf8"));
const files = (dir: string, base = dir): string[] => !existsSync(dir) ? [] : readdirSync(dir).sort().flatMap((e) => {
  const p = path.join(dir, e);
  return statSync(p).isDirectory() ? files(p, base) : [path.relative(base, p)];
});

let PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } | null | undefined;
function png() {
  if (PNG !== undefined) return PNG;
  // The VM-wide Playwright (as testing/console/browser.mjs) carries pngjs in its bundle; without it, shots compare by hash.
  for (const base of ["/usr/lib/node_modules/playwright/", "/usr/lib/node_modules/playwright-core/", "/usr/local/lib/node_modules/playwright/"]) {
    try {
      const core = path.dirname(createRequire(base).resolve("playwright-core/package.json"));
      PNG = createRequire(base)(path.join(core, "lib", "utilsBundle.js")).PNG; if (PNG) return PNG;
    } catch { /* next */ }
  }
  return (PNG = null);
}

/** The share of pixels that differ by more than PIXEL_TOLERANCE in a channel; a size change counts the area only one has. */
export function pixelRatio(a: Buffer, b: Buffer): { ratio: number; size: string } | null {
  const P = png(); if (!P) return null;
  const x = P.sync.read(a), y = P.sync.read(b);
  const w = Math.min(x.width, y.width), h = Math.min(x.height, y.height);
  let bad = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = (r * x.width + c) * 4, j = (r * y.width + c) * 4;
    for (let ch = 0; ch < 4; ch++) if (Math.abs(x.data[i + ch]! - y.data[j + ch]!) > PIXEL_TOLERANCE) { bad++; break; }
  }
  const area = Math.max(x.width * x.height, y.width * y.height);
  bad += area - w * h;
  return { ratio: bad / area, size: `${x.width}x${x.height} -> ${y.width}x${y.height}` };
}

export function compare(A: string, B: string, opts: { allow?: AllowEntry[]; pixelThreshold?: number; maxLines?: number } = {}): Result {
  const max = opts.maxLines ?? 40, thr = opts.pixelThreshold ?? 0.001;
  const out: Difference[] = [];
  const add = (group: string, key: string[], a: unknown, b: unknown) => { for (const d of jsonDiff(a, b)) out.push(describe(group, key, d, max)); };
  for (const s of [A, B]) if (!existsSync(path.join(s, "meta.json"))) throw new Error(`${s} is not a parity snapshot (no meta.json)`);

  // meta: which packs the build carries (timings and parts are about the run, not the build).
  const ma = readJson(path.join(A, "meta.json")) as Record<string, unknown>, mb = readJson(path.join(B, "meta.json")) as Record<string, unknown>;
  add("meta", ["packs"], ma.packs, mb.packs);

  for (const server of ["customer", "admin"]) {
    const fa = path.join(A, "mcp", `${server}.json`), fb = path.join(B, "mcp", `${server}.json`);
    if (!existsSync(fa) && !existsSync(fb)) continue;
    const a = existsSync(fa) ? readJson(fa) as Record<string, unknown> : {}, b = existsSync(fb) ? readJson(fb) as Record<string, unknown> : {};
    const g = `mcp.${server}`;
    add(g, ["initialize"], a.initialize, b.initialize);
    add(g, ["tools"], (a.tools as { tools?: unknown })?.tools ?? a.tools, (b.tools as { tools?: unknown })?.tools ?? b.tools);
    add(g, ["prompts"], (a.prompts as { prompts?: unknown })?.prompts ?? a.prompts, (b.prompts as { prompts?: unknown })?.prompts ?? b.prompts);
    const label = (args: Record<string, string>) => Object.keys(args).length ? Object.keys(args).sort().join("+") : "(no arguments)";
    const pg = (x: unknown) => Object.fromEntries(Object.entries((x ?? {}) as Record<string, { args: Record<string, string>; answer: unknown }[]>)
      .map(([n, list]) => [n, Object.fromEntries(list.map((e) => [label(e.args), e.answer]))]));
    add(g, ["prompt_get"], pg(a.prompt_get), pg(b.prompt_get));
    add(g, ["resources"], (a.resources as { resources?: unknown })?.resources ?? a.resources, (b.resources as { resources?: unknown })?.resources ?? b.resources);
    add(g, ["resource_templates"], a.resource_templates, b.resource_templates);
    add(g, ["resource_read"], a.resource_read, b.resource_read);
    if (a.skills || b.skills) add(g, ["skills"], a.skills, b.skills);
  }
  // The memory search's answers over the context fixture (snapshot --context-fixture, mold_v0-142), when either has them.
  {
    const fa = path.join(A, "mcp", "memory-search.json"), fb = path.join(B, "mcp", "memory-search.json");
    if (existsSync(fa) || existsSync(fb)) add("mcp.customer", ["memory_search"], existsSync(fa) ? readJson(fa) : null, existsSync(fb) ? readJson(fb) : null);
  }

  // generated files: added, removed, or their lines.
  const ga = files(path.join(A, "generated")), gb = files(path.join(B, "generated"));
  if (ga.length || gb.length) {
    for (const f of ga) if (!gb.includes(f)) out.push({ key: `generated::${f}`, group: "generated", kind: "removed", summary: "file removed", detail: [] });
    for (const f of gb) if (!ga.includes(f)) out.push({ key: `generated::${f}`, group: "generated", kind: "added", summary: "file added", detail: [] });
    for (const f of ga) if (gb.includes(f)) {
      const x = readFileSync(path.join(A, "generated", f), "utf8"), y = readFileSync(path.join(B, "generated", f), "utf8");
      if (x === y) continue;
      if (f.endsWith(".json")) { try { add("generated", [f], JSON.parse(x), JSON.parse(y)); continue; } catch { /* as text */ } }
      out.push({ key: `generated::${f}`, group: "generated", kind: "changed", summary: "lines changed", detail: unified(x, y, max) });
    }
  }

  // api: the route list, then each recorded answer.
  const ra = existsSync(path.join(A, "api", "routes.json")) ? readJson(path.join(A, "api", "routes.json")) as string[] : [];
  const rb = existsSync(path.join(B, "api", "routes.json")) ? readJson(path.join(B, "api", "routes.json")) as string[] : [];
  for (const r of ra) if (!rb.includes(r)) out.push({ key: `api::routes::${r}`, group: "api", kind: "removed", summary: "route removed", detail: [] });
  for (const r of rb) if (!ra.includes(r)) out.push({ key: `api::routes::${r}`, group: "api", kind: "added", summary: "route added", detail: [] });
  const aa = files(path.join(A, "api")).filter((f) => f !== "routes.json"), ab = files(path.join(B, "api")).filter((f) => f !== "routes.json");
  const apiKey = (s: string, f: string) => (readJson(path.join(s, "api", f)) as { path: string }).path + (f.startsWith("public/") ? " (signed out)" : "");
  for (const f of aa) if (!ab.includes(f)) out.push({ key: `api::${apiKey(A, f)}`, group: "api", kind: "removed", summary: "no longer recorded", detail: [] });
  for (const f of ab) if (!aa.includes(f)) out.push({ key: `api::${apiKey(B, f)}`, group: "api", kind: "added", summary: "newly recorded", detail: [] });
  for (const f of aa) if (ab.includes(f)) add("api", [apiKey(A, f)], readJson(path.join(A, "api", f)), readJson(path.join(B, "api", f)));

  // pages: by path (and persona); their facts, text, links, then their screenshots.
  const pages = (s: string) => new Map(files(path.join(s, "pages")).filter((f) => f !== "_index.json").map((f) => {
    const p = readJson(path.join(s, "pages", f)) as Record<string, unknown>;
    return [`${p.path}${p.as ? ` (as ${p.as})` : ""}`, p] as const;
  }));
  const pa = pages(A), pb = pages(B);
  for (const k of pa.keys()) if (!pb.has(k)) out.push({ key: `pages::${k}`, group: "pages", kind: "removed", summary: `page removed (${pa.get(k)!.pack})`, detail: [] });
  for (const k of pb.keys()) if (!pa.has(k)) out.push({ key: `pages::${k}`, group: "pages", kind: "added", summary: `page added (${pb.get(k)!.pack})`, detail: [] });
  for (const [k, a] of pa) {
    const b = pb.get(k); if (!b) continue;
    const { shots: sa, links: la, ...ra2 } = a, { shots: sb, links: lb, ...rb2 } = b;
    add("pages", [k], ra2, rb2);
    // Links as a set of "text -> href" lines: an added or removed link reads as one line.
    const ln = (l: unknown) => ((l ?? []) as { href: string; text: string }[]).map((x) => `${x.text || "(no text)"} -> ${x.href}`);
    const lx = ln(la), ly = ln(lb);
    if (lx.join("\n") !== ly.join("\n")) out.push({ key: `pages::${k}::links`, group: "pages", kind: "changed", summary: "links changed", detail: unified(lx.join("\n"), ly.join("\n"), max) });
    for (const v of new Set([...Object.keys((sa ?? {}) as object), ...Object.keys((sb ?? {}) as object)])) {
      const x = (sa as Record<string, string> | undefined)?.[v], y = (sb as Record<string, string> | undefined)?.[v];
      const key = `shots::${k}::${v}`;
      if (!x || !y) { out.push({ key, group: "shots", kind: x ? "removed" : "added", summary: x ? "shot missing in the second snapshot" : "shot missing in the first snapshot", detail: [] }); continue; }
      if (x === y) continue;
      const r = pixelRatio(readFileSync(path.join(A, "shots", `${x}.png`)), readFileSync(path.join(B, "shots", `${y}.png`)));
      if (!r) out.push({ key, group: "shots", kind: "changed", summary: `pixels differ (not measured: no PNG decoder); ${x.slice(0, 12)} -> ${y.slice(0, 12)}`, detail: [] });
      else if (r.ratio > thr) out.push({ key, group: "shots", kind: "changed", summary: `${(r.ratio * 100).toFixed(2)}% of pixels differ (threshold ${(thr * 100).toFixed(2)}%), ${r.size}`,
        detail: [`shots/${x}.png -> shots/${y}.png`] });
    }
  }

  // smoke: a pack's own end-to-end check (parity.py writes smoke.json).
  const sa = existsSync(path.join(A, "smoke.json")) ? readJson(path.join(A, "smoke.json")) : null, sb = existsSync(path.join(B, "smoke.json")) ? readJson(path.join(B, "smoke.json")) : null;
  if (sa || sb) add("smoke", [], sa ?? {}, sb ?? {});

  // The allow list.
  const allow = opts.allow ?? [];
  const used = new Set<AllowEntry>();
  const res: Result = { differences: [], allowed: [], stale: [] };
  for (const d of out) {
    const e = allow.find((x) => globKey(x.key).test(d.key));
    if (e) { used.add(e); res.allowed.push({ ...d, reason: e.reason ?? "" }); } else res.differences.push(d);
  }
  res.stale = allow.filter((e) => !used.has(e));
  return res;
}

/** An allow-list pattern: `*` any run without "::", `**` anything, everything else literal. */
export function globKey(p: string): RegExp {
  const esc = p.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("(?:(?!::).)*")).join(".*");
  return new RegExp(`^${esc}$`);
}

export function readAllow(f: string): { phase: string; allow: AllowEntry[] } {
  const doc = readJson(f) as { phase?: string; allow?: AllowEntry[] };
  if (!Array.isArray(doc.allow) || doc.allow.some((e) => typeof e?.key !== "string")) throw new Error(`${f}: expected {"phase": "...", "allow": [{"key": "...", "reason": "..."}]}`);
  return { phase: doc.phase ?? path.basename(f), allow: doc.allow };
}

export function render(r: Result, phase = ""): string {
  const lines: string[] = [];
  const group = (list: Difference[]) => {
    const groups = [...new Set([...GROUP_ORDER, ...list.map((d) => d.group)])];
    for (const g of groups) {
      const mine = list.filter((d) => d.group === g); if (!mine.length) continue;
      lines.push(`## ${g} (${mine.length})`, "");
      for (const d of mine) {
        lines.push(`- ${d.key.split("::").slice(1).join(" :: ") || g}: ${d.summary}${(d as { reason?: string }).reason ? `  [allowed: ${(d as { reason?: string }).reason}]` : ""}`);
        for (const l of d.detail) lines.push(`      ${l}`);
      }
      lines.push("");
    }
  };
  if (r.differences.length) { lines.push(`# ${r.differences.length} difference(s)`, ""); group(r.differences); }
  if (r.allowed.length) { lines.push(`# ${r.allowed.length} allowed difference(s)${phase ? ` (${phase})` : ""}`, ""); group(r.allowed); }
  if (r.stale.length) lines.push(`# ${r.stale.length} allow-list entr${r.stale.length === 1 ? "y" : "ies"} matched nothing`, "", ...r.stale.map((e) => `- ${e.key}${e.reason ? ` (${e.reason})` : ""}`), "");
  lines.push(r.differences.length ? `parity: ${r.differences.length} difference(s), ${r.allowed.length} allowed` : `parity: no difference${r.allowed.length ? ` outside the allow list (${r.allowed.length} allowed)` : ""}`);
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const pos = argv.filter((x, i) => !x.startsWith("--") && !["--allow", "--pixel-threshold", "--max-lines"].includes(argv[i - 1] ?? ""));
  if (pos.length !== 2) { console.error("usage: diff.mts <before> <after> [--allow allow.json] [--pixel-threshold 0.001] [--max-lines 40] [--json]"); process.exit(2); }
  try {
    const al = opt("--allow") ? readAllow(opt("--allow")!) : { phase: "", allow: [] };
    const r = compare(path.resolve(pos[0]!), path.resolve(pos[1]!), { allow: al.allow, pixelThreshold: opt("--pixel-threshold") ? Number(opt("--pixel-threshold")) : undefined, maxLines: opt("--max-lines") ? Number(opt("--max-lines")) : undefined });
    console.log(argv.includes("--json") ? JSON.stringify(r, null, 1) : render(r, al.phase));
    process.exit(r.differences.length ? 1 : 0);
  } catch (e) {
    console.error(`parity diff: ${(e as Error).message}`);
    process.exit(2);
  }
}
