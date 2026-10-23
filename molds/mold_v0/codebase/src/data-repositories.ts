/**
 * Data repositories (mold_v0-059; molds/mold_v0/MOLD.md "Pack and record-area contract"): where an area's rows come from,
 * through one adapter interface. A pack declares its repositories (pack.json `repositories`, src/pack-api.ts
 * RepositorySchema) and each area names one with `repository`; an area that names none reads the shell's tables.
 *
 *   shell_tables      the default: workspace_records / platform_records, written through the record store
 *   workspace_files   the workspace store's files (mold_v0-033), read only: a declared file template (one row per
 *                     identity of a JSON-lines or JSON file) or directory template (one row per directory), indexed into
 *                     the workspace's own rows by indexWorkspaceFiles(orgId, pack, files?) (called after a commit:
 *                     the hook is mold_v0-064's)
 *   upstream_catalog  an upstream project at a pinned commit: fetched at the pin only (git, any other commit and any
 *                     redirect refused; or GitHub's raw files and tree at the commit), indexed into shared rows by
 *                     platform staff (syncUpstreamCatalog)
 *   http_api          an external API, read live and read only: its declared base URL (an egress host), the workspace's
 *                     credential field (mold_v0-034) in a header, no redirects, no private addresses
 *
 * Indexing is idempotent and all-or-nothing: every row's fingerprint (a hash of what is written; keyed with the
 * workspace's data key for a sealed area) is stored with it, so a re-index of the same input writes nothing; the whole
 * index is one transaction of the record store (src/record-areas.ts writeFromRepository), so it is written whole or not
 * at all; the prune removes only rows this repository wrote, and is refused when it would empty an area or remove more
 * than the declared fraction of it (unless staff force it).
 *
 * Rows come from the pack's loader (definePack `loaders`, code) when it has one, else from the declared `map` or the
 * kind's default mapping. Either way every row is checked as any write is (types, required fields, references).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { orgMac } from "./orgcrypto.js";
import { PackError, RECORD_KEY, RepositorySchema, VALUE_PATH, type RecordOperation, type RecordRow, type Repository, type RepositoryInput, type RepositoryRows } from "./pack-api.js";
import { packs } from "./packs.js";
import { checkData, conform, isSealedArea, recordAreas, storedMarks, SYSTEM_ACTOR, writeFromRepository, type RecordArea } from "./record-areas.js";
import { pageInMemory, type Parsed } from "./record-query.js";
import { asPlatform } from "./tenant-scope.js";
import { ENV } from "./env-names.js";

void SYSTEM_ACTOR;
const run = promisify(execFile);

/** One adapter per kind: how an area's rows are read, and whether a door may write them. */
export interface RepositoryAdapter {
  kind: Repository["kind"];
  /** "table": rows are in the shell's tables (written by a door, or indexed); "live": read from elsewhere on each call. */
  reads: "table" | "live";
  /** May a door (ctx.records, the data API) write the area's rows? */
  writable: boolean;
  /** Who indexes it into the tables: nobody, a workspace's commit, platform staff. */
  indexedBy: "none" | "workspace_commit" | "staff";
}
export const ADAPTERS: Record<Repository["kind"], RepositoryAdapter> = {
  shell_tables: { kind: "shell_tables", reads: "table", writable: true, indexedBy: "none" },
  workspace_files: { kind: "workspace_files", reads: "table", writable: false, indexedBy: "workspace_commit" },
  upstream_catalog: { kind: "upstream_catalog", reads: "table", writable: true, indexedBy: "staff" },
  http_api: { kind: "http_api", reads: "live", writable: false, indexedBy: "none" },
};

/** A pack's repositories, parsed, with the areas each feeds. */
export function repositoriesOf(pack: string): { name: string; settings: Repository; areas: RecordArea[] }[] {
  const p = packs().find((x) => x.id === pack);
  if (!p) return [];
  const areas = recordAreas().filter((a) => a.pack === pack);
  return Object.keys(p.definition.repositories ?? {}).map((name) => {
    const a = areas.find((x) => x.repo?.name === name);
    const settings = a?.repo?.settings ?? RepositorySchema.parse(p.definition.repositories![name]);
    return { name, settings, areas: areas.filter((x) => x.repo?.name === name) };
  });
}
/** Every repository of the build, for the admin data API's list. */
export const allRepositories = () => packs().flatMap((p) => repositoriesOf(p.id).map((r) => ({
  pack: p.id, name: r.name, areas: r.areas.map((a) => a.name), ...ADAPTERS[r.settings.kind],
})));
const repositoryOrThrow = (pack: string, name: string) => {
  const r = repositoriesOf(pack).find((x) => x.name === name);
  if (!r) throw new PackError(`pack ${pack} has no repository ${JSON.stringify(String(name).slice(0, 64))}`, 404);
  return r;
};

// ---------- documents: a source of files at a version ----------

/** Files at one version, read only: an upstream at its pin, or a workspace's snapshot. */
export interface FileSource { version: string | null; describe: string; read(rel: string): Promise<string | null>; list(dir?: string): Promise<string[]>; close(): Promise<void> }
const SAFE_REL = /^(?!\/)[A-Za-z0-9._/@+()-]{1,500}$/;
const safeRel = (rel: string) => {
  if (typeof rel !== "string" || !SAFE_REL.test(rel) || rel.split("/").some((s) => s === ".." || s === "." || s === "")) throw new PackError(`not a path inside the repository: ${JSON.stringify(String(rel).slice(0, 120))}`, 400);
  return rel;
};
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20_000;

/** A workspace snapshot's files (mold_v0-033), as a source. */
export function filesSource(files: { path: string; body: Uint8Array | string }[], version: string | null = null): FileSource {
  const dec = new TextDecoder("utf-8", { fatal: false });
  const map = new Map(files.map((f) => [f.path, typeof f.body === "string" ? f.body : dec.decode(f.body)]));
  const all = [...map.keys()].sort();
  return {
    version, describe: `the workspace's files (${map.size})`,
    // A lookup in the snapshot's own files: a path the snapshot holds, whatever its characters; nothing else.
    read: async (rel) => (typeof rel === "string" ? map.get(rel) ?? null : null),
    list: async (dir) => (dir === undefined ? all : all.filter((p) => p.startsWith(`${String(dir).replace(/\/$/, "")}/`))),
    close: async () => {},
  };
}

/** The test switches: file:// upstreams (a local fixture repository) and private API addresses. Off in production. */
const allowFileUpstream = () => ENV.APP_DATA_ALLOW_FILE_UPSTREAM === "1";
const allowPrivate = () => ENV.APP_DATA_ALLOW_PRIVATE === "1";

/**
 * An upstream repository at its pinned commit, by git: a fresh empty repository fetches that one commit (shallow, no
 * tags, no submodules, no hooks, no credential helper, no redirects, https only), the fetched commit must be the pin,
 * and files are read from the commit's own tree (never a working tree: nothing is checked out).
 */
export async function gitSource(up: { repo: string; commit: string }): Promise<FileSource> {
  const commit = up.commit;
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new PackError("an upstream is pinned by a full commit id", 400);
  const isFile = up.repo.startsWith("file:///");
  // Tests only (the same switch as file://): plain http to this machine, to prove a redirect is refused.
  const isLocalHttp = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~/-]+$/.test(up.repo);
  if ((isFile || isLocalHttp) && !allowFileUpstream()) throw new PackError("a file:// or http:// upstream is for tests only", 400);
  if (!isFile && !isLocalHttp && !/^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/.test(up.repo)) throw new PackError("an upstream is an https:// repository", 400);
  const dir = await mkdtemp(path.join(tmpdir(), "upstream-"));
  const proto = isFile ? "file" : isLocalHttp ? "http" : "https";
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: proto, GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" };
  const cfg = ["-c", "protocol.allow=never", "-c", `protocol.${proto}.allow=always`, "-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "transfer.fsckObjects=true", "-c", "fetch.recurseSubmodules=false"];
  const git = async (args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) =>
    (await run("git", [...cfg, "-C", dir, ...args], { env, timeout: opts.timeout ?? 60_000, maxBuffer: opts.maxBuffer ?? MAX_FILE_BYTES, encoding: "utf8" })).stdout;
  const close = () => rm(dir, { recursive: true, force: true });
  try {
    await git(["init", "-q", "--bare"]);
    try { await git(["fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", up.repo, commit], { timeout: 180_000 }); }
    catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message).replace(/\s+/g, " ");
      throw new PackError(`the upstream could not be fetched at ${commit}${/redirect/i.test(msg) ? " (it redirected: refused)" : ""}`, 502);
    }
    const got = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
    if (got !== commit) throw new PackError(`the upstream gave ${got.slice(0, 12)}, not the pinned commit ${commit}: refused`, 502);
  } catch (e) { await close(); throw e; }
  return {
    version: commit, describe: `${up.repo} at ${commit} (git)`,
    read: async (rel) => {
      const spec = `${commit}:${safeRel(rel)}`;
      const type = await git(["cat-file", "-t", spec]).then((t) => t.trim(), () => null);
      if (type !== "blob") return null;
      const size = Number((await git(["cat-file", "-s", spec])).trim());
      if (!(size <= MAX_FILE_BYTES)) throw new PackError(`${rel} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
      return git(["cat-file", "blob", spec]);
    },
    list: async (sub) => {
      const out = await git(["ls-tree", "-r", "-z", "--name-only", commit, ...(sub === undefined ? [] : ["--", `${safeRel(sub).replace(/\/$/, "")}/`])], { maxBuffer: 64 * 1024 * 1024 });
      const names = out.split("\u0000").filter(Boolean).sort();
      if (names.length > MAX_FILES) throw new PackError(`the upstream has more than ${MAX_FILES} files there`, 413);
      return names;
    },
    close,
  };
}

/**
 * An upstream on GitHub at its pinned commit, over HTTPS without git (a server with no git): the commit must exist as
 * itself (the API's answer names it), files come from raw.githubusercontent.com/<owner>/<name>/<commit>/<path>
 * (content-addressed by the commit) and directories from the commit's tree. Every request refuses a redirect.
 */
export async function githubSource(up: { repo: string; commit: string }, fetcher: typeof fetch = fetch): Promise<FileSource> {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(\.git)?$/.exec(up.repo);
  if (!m) throw new PackError("the github transport reads https://github.com/<owner>/<name> repositories", 400);
  if (!/^[0-9a-f]{40}$/.test(up.commit)) throw new PackError("an upstream is pinned by a full commit id", 400);
  const [owner, name, commit] = [m[1]!, m[2]!, up.commit];
  const get = async (url: string) => {
    let r: Response;
    try { r = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { accept: "application/vnd.github+json, */*" } }); }
    catch { throw new PackError("GitHub could not be reached, or it redirected (refused)", 502); }
    if (r.status >= 300 && r.status < 400) throw new PackError("GitHub redirected: refused", 502);
    return r;
  };
  const meta = await get(`https://api.github.com/repos/${owner}/${name}/commits/${commit}`);
  const sha = meta.ok ? ((await meta.json().catch(() => null)) as { sha?: unknown } | null)?.sha : null;
  if (sha !== commit) throw new PackError(`GitHub has no commit ${commit} in ${owner}/${name}${meta.ok ? ` (it answered ${String(sha).slice(0, 12)})` : ` (${meta.status})`}: refused`, 502);
  let tree: string[] | null = null;
  return {
    version: commit, describe: `https://raw.githubusercontent.com/${owner}/${name}/${commit}/ (GitHub, at the pinned commit)`,
    read: async (rel) => {
      const r = await get(`https://raw.githubusercontent.com/${owner}/${name}/${commit}/${safeRel(rel)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new PackError(`GitHub answered ${r.status} for ${rel}`, 502);
      const body = await r.text();
      if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new PackError(`${rel} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
      return body;
    },
    list: async (sub) => {
      if (!tree) {
        const r = await get(`https://api.github.com/repos/${owner}/${name}/git/trees/${commit}?recursive=1`);
        const j = (r.ok ? await r.json().catch(() => null) : null) as { truncated?: boolean; tree?: { path?: unknown; type?: unknown }[] } | null;
        if (!j || !Array.isArray(j.tree) || j.truncated) throw new PackError("GitHub's tree at the commit could not be read whole", 502);
        tree = j.tree.filter((x) => x.type === "blob" && typeof x.path === "string").map((x) => x.path as string).sort();
      }
      return sub === undefined ? tree : tree.filter((p) => p.startsWith(`${safeRel(sub).replace(/\/$/, "")}/`));
    },
    close: async () => {},
  };
}

// ---------- documents to rows ----------

type Doc = unknown;
/**
 * A value of a document: "a.b" in the item, "$.a" from the document's root, "@name" a path placeholder, "@file" its path;
 * "a[0]" the first item of the list a, "a[0].b" a property of it (mold_v0-076). Each step reads an own property of an
 * object or an item of a list, nothing else: a step that does not fit (a list where a property is named, an object where
 * an index is, an index past the end) is no value, never an error.
 */
function valueAt(expr: string, ctx: { item: Doc; root: Doc; vars: Record<string, string> }): unknown {
  if (!VALUE_PATH.test(expr)) throw new PackError(`not a value path: ${expr}`, 400);
  if (expr.startsWith("@")) return Object.hasOwn(ctx.vars, expr.slice(1)) ? ctx.vars[expr.slice(1)] : undefined;
  const [from, p] = expr.startsWith("$.") ? [ctx.root, expr.slice(2)] : [ctx.item, expr];
  let v: unknown = from;
  for (const part of p.split(".")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\d{1,3}\])*)$/.exec(part);
    if (!m) return undefined; // unreachable past VALUE_PATH
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.hasOwn(v, m[1]!)) return undefined;
    v = (v as Record<string, unknown>)[m[1]!];
    for (const [, i] of m[2]!.matchAll(/\[(\d{1,3})\]/g)) {
      const n = Number(i);
      if (!Array.isArray(v) || n >= v.length) return undefined;
      v = v[n];
    }
  }
  return v;
}
const fillTemplate = (t: string, ctx: Parameters<typeof valueAt>[1]) => t.replace(/\{([^{}]+)\}/g, (_m, e: string) => {
  const v = valueAt(e, ctx);
  if (typeof v !== "string" && typeof v !== "number") throw new PackError(`template ${t}: ${e} is not a value here`, 422);
  return String(v);
});
/** The items of a document along a dotted path: every list on the way is walked ("groups.controls"). */
function itemsAt(doc: Doc, each: string | undefined): Doc[] {
  let cur: Doc[] = [doc];
  if (!each) return Array.isArray(doc) ? doc : [doc];
  for (const part of each.split(".")) {
    const next: Doc[] = [];
    for (const x of cur) {
      const v = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>)[part] : undefined;
      if (Array.isArray(v)) next.push(...v); else if (v !== undefined && v !== null) next.push(v);
    }
    cur = next;
  }
  return cur;
}
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** An item's value for a field: the declared path, else the property of the field's name or its camelCase form, else a placeholder. */
const fieldValue = (field: string, map: Record<string, string> | undefined, ctx: Parameters<typeof valueAt>[1]) => {
  if (map?.[field]) return valueAt(map[field]!, ctx);
  const item = ctx.item && typeof ctx.item === "object" && !Array.isArray(ctx.item) ? (ctx.item as Record<string, unknown>) : {};
  if (Object.hasOwn(item, field)) return item[field];
  if (Object.hasOwn(item, camel(field))) return item[camel(field)];
  return Object.hasOwn(ctx.vars, field) ? ctx.vars[field] : undefined;
};

/** `never_read` (workspace_files): "<file> <a.b[].c>" drops that value of that file; "any ENC[...] value" drops every sealed value. */
function dropNeverRead(rules: string[] | undefined, fileKey: string, fileName: string, v: unknown): unknown {
  if (!rules?.length) return v;
  let out = JSON.parse(JSON.stringify(v ?? null));
  for (const rule of rules) {
    if (/^any ENC\[\.\.\.\] value$/.test(rule)) {
      const walk = (x: unknown): unknown => (typeof x === "string" ? (x.includes("ENC[") ? null : x) : Array.isArray(x) ? x.map(walk)
        : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
      out = walk(out);
      continue;
    }
    const m = /^(\S+) ([A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*)$/.exec(rule);
    if (!m || /(__proto__|constructor|prototype)/.test(rule)) throw new PackError(`never_read: ${JSON.stringify(rule.slice(0, 80))} is "<file> <path>" or "any ENC[...] value"`, 400);
    if (m[1] !== fileKey && m[1] !== fileName) continue;
    const parts = m[2]!.split(".");
    const drop = (x: unknown, i: number): void => {
      if (!x || typeof x !== "object") return;
      const [, key, many] = /^([A-Za-z0-9_]+)(\[\])?$/.exec(parts[i]!)!;
      const o = x as Record<string, unknown>;
      if (i === parts.length - 1 && !many) { delete o[key!]; return; }
      const next = o[key!];
      if (many && Array.isArray(next)) { if (i === parts.length - 1) delete o[key!]; else for (const y of next) drop(y, i + 1); }
      else drop(next, i + 1);
    };
    drop(out, 0);
  }
  return out;
}

/** A path template's segments as a pattern: {name} one segment (a value), * any part of one segment. */
function templateMatcher(tpl: string): (p: string) => Record<string, string> | null {
  const names: string[] = [];
  const re = new RegExp(`^${tpl.split("/").map((seg) => seg.split(/(\{[A-Za-z_][A-Za-z0-9_]*\}|\*)/).map((x) => {
    if (x === "*") return "[^/]*";
    const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(x);
    if (m) { names.push(m[1]!); return "([^/]+)"; }
    return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("")).join("/")}$`);
  return (p) => { const m = re.exec(p); return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]!])) : null; };
}
const parseDoc = (rel: string, body: string, format?: "json" | "jsonl" | "text"): Doc[] => {
  const f = format ?? (rel.endsWith(".jsonl") ? "jsonl" : rel.endsWith(".json") ? "json" : "text");
  if (f === "text") return [{ text: body }];
  if (f === "jsonl") return body.split("\n").flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { throw new PackError(`${rel} line ${i + 1} is not JSON: nothing is indexed`, 422); }
  });
  try { return [JSON.parse(body)]; } catch { throw new PackError(`${rel} is not JSON: nothing is indexed`, 422); }
};
const readJsonish = (rel: string, body: string) => (rel.endsWith(".json") ? (() => { try { return JSON.parse(body); } catch { throw new PackError(`${rel} is not JSON: nothing is indexed`, 422); } })() : body);

/** A desired row of an area: what an index writes. */
export interface Desired { key: string; title: string | null; data: Record<string, unknown>; version: string | null }

/** The rows of every area a repository feeds, from its documents: the pack's loader, else the declared map or the default. */
export async function repositoryRows(pack: string, name: string, src: FileSource): Promise<Map<string, Desired[]>> {
  const r = repositoryOrThrow(pack, name);
  const s = r.settings;
  if (s.kind !== "workspace_files" && s.kind !== "upstream_catalog") throw new PackError(`repository ${name} (${s.kind}) is not indexed`, 400);
  const loader = packs().find((p) => p.id === pack)?.definition.loaders?.[name];
  const out = new Map<string, Desired[]>(r.areas.map((a) => [a.name, []]));
  // A refusal never quotes a value of a document that feeds a sealed area (it may reach a run's error, unsealed).
  const quiet = r.areas.some((a) => isSealedArea(a));
  const shown = (v: unknown) => (quiet ? "a value" : JSON.stringify(String(v).slice(0, 80)));
  const push = (area: string, d: { key: unknown; title?: unknown; data: unknown }, where: string) => {
    if (!out.has(area)) throw new PackError(`${where}: area ${area} does not read from repository ${name}`, 422);
    if (typeof d.key !== "string" || !RECORD_KEY.test(d.key)) throw new PackError(`${where}: ${shown(d.key)} cannot be a record key (1-200 letters, digits, . _ : ( ) -)`, 422);
    if (!d.data || typeof d.data !== "object" || Array.isArray(d.data)) throw new PackError(`${where}: a row's data is an object`, 422);
    const title = d.title === undefined || d.title === null ? null : String(d.title).slice(0, 500);
    out.get(area)!.push({ key: d.key, title, data: Object.fromEntries(Object.entries(d.data as Record<string, unknown>).filter(([, v]) => v !== undefined)), version: s.kind === "upstream_catalog" ? src.version : null });
  };
  if (loader) {
    const input: RepositoryInput = { repository: name, kind: s.kind, settings: JSON.parse(JSON.stringify(s)), version: src.version,
      areas: r.areas.map((a) => ({ name: a.name, role: a.role, fields: a.fields.map((f) => f.name) })), read: (p) => src.read(p), list: (d) => src.list(d) };
    let rows: RepositoryRows;
    try { rows = await loader(input); }
    catch (e) { throw e instanceof PackError ? e : new PackError(`the loader of ${name} refused${quiet ? "" : `: ${String((e as Error).message).slice(0, 500)}`}`, 422); }
    if (!rows || typeof rows !== "object") throw new PackError(`the loader of ${name} returned no rows by area`, 422);
    for (const [area, list] of Object.entries(rows)) {
      if (!Array.isArray(list)) throw new PackError(`the loader of ${name}: ${area} is not a list of rows`, 422);
      for (const [i, d] of list.entries()) push(area, d as never, `loader ${name}, ${area}[${i}]`);
    }
    return out;
  }
  const maps = (s as { map?: Record<string, { from?: string; each?: string; key: string; title?: string; fields?: Record<string, string>; where?: Record<string, string | number | boolean> }> }).map ?? {};
  const kept = (m: { where?: Record<string, unknown> } | undefined, ctx: Parameters<typeof valueAt>[1]) => !m?.where || Object.entries(m.where).every(([k, v]) => valueAt(k, ctx) === v);
  if (s.kind === "upstream_catalog") {
    for (const a of r.areas) {
      const m = maps[a.name];
      if (!m) throw new PackError(`repository ${name} feeds ${a.name}: declare map.${a.name} (or a loader) to say which rows it holds`, 422);
      const rel = m.from ? (s.files ?? {})[m.from] : undefined;
      if (!rel) throw new PackError(`repository ${name}: map.${a.name}.from names one of its files`, 422);
      const docs = await documentsAt(src, rel);
      for (const { path: p, vars, doc } of docs) for (const item of itemsAt(doc, m.each)) {
        const ctx = { item, root: doc, vars: { ...vars, file: p } };
        if (!kept(m, ctx)) continue;
        push(a.name, { key: fillTemplate(m.key, ctx), title: m.title ? fillTemplate(m.title, ctx) : null, data: Object.fromEntries(a.fields.map((f) => [f.name, fieldValue(f.name, m.fields, ctx)])) }, `${p}`);
      }
    }
    return out;
  }
  // workspace_files
  const files = await src.list();
  if (s.path !== undefined) {
    const match = templateMatcher(s.path);
    const identity = s.identity ?? "id";
    for (const a of r.areas) {
      const m = maps[a.name];
      const rows = new Map<string, { d: { key: string; title: unknown; data: Record<string, unknown> }; at: string }>();
      for (const p of files) {
        const vars = match(p);
        if (!vars) continue;
        const body = await src.read(p);
        if (body === null) continue;
        for (const raw of parseDoc(p, body, s.format)) {
          const doc = dropNeverRead(s.never_read, "path", path.posix.basename(p), raw);
          for (const item of itemsAt(doc, m?.each)) {
            const ctx = { item, root: doc, vars: { ...vars, file: p } };
            if (!kept(m, ctx)) continue;
            const key = m ? fillTemplate(m.key, ctx) : valueAt(identity, ctx);
            if (typeof key !== "string") continue; // a line with no identity (another kind of entry) is not a row
            const t = m?.title ? fillTemplate(m.title, ctx) : valueAt("title", ctx);
            // Append-only: the last line of an identity is its state. Otherwise an identity twice is a mistake.
            if (rows.has(key) && !s.append_only) throw new PackError(`${p}: ${quiet ? "a key" : key} appears twice (declare append_only when the last one wins)`, 422);
            rows.set(key, { d: { key, title: typeof t === "string" && t ? t : key, data: Object.fromEntries(a.fields.map((f) => [f.name, fieldValue(f.name, m?.fields, ctx)])) }, at: p });
          }
        }
      }
      for (const { d, at } of rows.values()) push(a.name, d, at);
    }
    return out;
  }
  // A directory per row: its declared files read into the fields of the same name.
  const dirMatch = templateMatcher(s.dir!);
  const dirs = new Map<string, Record<string, string>>();
  for (const p of files) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); const v = dirMatch(d); if (v && !dirs.has(d)) dirs.set(d, v); }
  }
  for (const [d, vars] of [...dirs].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const doc: Record<string, unknown> = {};
    for (const [fk, rel] of Object.entries(s.files ?? {})) {
      if (rel.includes("*")) {
        const fm = templateMatcher(`${d}/${rel}`);
        const hits = files.filter((p) => fm(p));
        const list = [];
        for (const p of hits) { const b = await src.read(p); if (b !== null) list.push(dropNeverRead(s.never_read, fk, path.posix.basename(p), readJsonish(p, b))); }
        doc[fk] = list;
      } else {
        const b = await src.read(`${d}/${rel}`);
        doc[fk] = b === null ? null : dropNeverRead(s.never_read, fk, path.posix.basename(rel), readJsonish(rel, b));
      }
    }
    const last = Object.keys(vars).at(-1);
    for (const a of r.areas) {
      const m = maps[a.name];
      const ctx = { item: doc, root: doc, vars: { ...vars, file: d } };
      const key = m ? fillTemplate(m.key, ctx) : last ? vars[last] : path.posix.basename(d);
      push(a.name, { key, title: m?.title ? fillTemplate(m.title, ctx) : key, data: Object.fromEntries(a.fields.map((f) => [f.name, fieldValue(f.name, m?.fields, ctx)])) }, d);
    }
  }
  return out;
}

/** The JSON documents under a declared file: one file, a directory (every .json under it) or a glob. */
async function documentsAt(src: FileSource, rel: string): Promise<{ path: string; vars: Record<string, string>; doc: Doc }[]> {
  const isPattern = /[*{]/.test(rel);
  const one = !isPattern ? await src.read(rel) : null;
  let paths: string[];
  if (one !== null) paths = [rel];
  else if (isPattern) { const m = templateMatcher(rel); paths = (await src.list()).filter((p) => m(p)); }
  else paths = (await src.list(rel)).filter((p) => p.endsWith(".json"));
  const out = [];
  for (const p of paths) {
    const body = p === rel && one !== null ? one : await src.read(p);
    if (body === null) continue;
    const vars = isPattern ? templateMatcher(rel)(p) ?? {} : {};
    for (const doc of parseDoc(p, body, p.endsWith(".jsonl") ? "jsonl" : "json")) out.push({ path: p, vars, doc });
  }
  return out;
}

// ---------- the index: fingerprints, plan, guarded prune, one transaction ----------

/** JSON with sorted keys, null and missing alike: the same row always gives the same text. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== null && o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  if (typeof v === "number" && !Number.isFinite(v)) throw new PackError("a row holds a number that is not finite", 422);
  return JSON.stringify(v);
}

export interface AreaCounts { area: string; desired: number; created: number; updated: number; unchanged: number; deleted: number; kept_by_hand: number }
export interface IndexReport { pack: string; repository: string; kind: string; version: string | null; source: string; written: boolean; areas: AreaCounts[] }

/**
 * Bring the areas a repository feeds to exactly `rows` (for one workspace, or the shared rows when orgId is null), as
 * one transaction. Unchanged rows (same fingerprint, same source) are not written; rows this repository wrote that are
 * no longer produced are pruned, unless that would empty an area that has rows (refused unless `allow_empty`) or
 * remove more than `max_fraction` of its rows (refused unless `force`). Rows written by hand (no source) are kept.
 */
export async function applyIndex(orgId: number | null, pack: string, repo: { name: string; settings: Repository; areas: RecordArea[] }, rows: Map<string, Desired[]>,
  opts: { force?: boolean; describe?: string; version?: string | null } = {}): Promise<IndexReport> {
  const prune = (repo.settings as { prune?: { max_fraction?: number; allow_empty?: boolean } }).prune ?? {};
  const maxFraction = prune.max_fraction ?? 0.5;
  const puts: RecordOperation[] = [], deletes: RecordOperation[] = [];
  const fingerprints = new Map<string, string>();
  const counts: AreaCounts[] = [];
  // References first: an area whose rows refer to another area this repository feeds is written after it.
  const order = [...repo.areas].sort((a, b) => Number(refersTo(a, b)) - Number(refersTo(b, a)));
  for (const area of order) {
    const desired = rows.get(area.name) ?? [];
    const c: AreaCounts = { area: area.name, desired: desired.length, created: 0, updated: 0, unchanged: 0, deleted: 0, kept_by_hand: 0 };
    const keys = new Set<string>();
    for (const d of desired) { if (keys.has(d.key)) throw new PackError(`area ${area.name}: the index produced ${d.key} twice`, 422); keys.add(d.key); }
    const marks = new Map((await storedMarks(area, orgId)).map((m) => [m.key, m]));
    const ours = [...marks.values()].filter((m) => m.source === repo.name);
    for (const d of desired) {
      // Types checked before anything is written; the write inside the transaction checks the whole record again
      // (required fields, and references: to rows this same index writes first, too).
      let data: Record<string, unknown>;
      try { data = checkData(area, d.data, `${area.name} record ${d.key}`); }
      catch (e) { throw new PackError(`the index of ${repo.name} is refused: ${(e as Error).message}`, 422); }
      const text = canonical({ title: d.title, data, version: d.version });
      const fp = orgId !== null && isSealedArea(area) ? `k1:${await orgMac(orgId, `record/${area.pack}/${area.name}`, text)}` : `h1:${createHash("sha256").update(text).digest("hex")}`;
      fingerprints.set(`${area.name}\u0000${d.key}`, fp);
      const m = marks.get(d.key);
      if (m && m.source === repo.name && m.fingerprint === fp) { c.unchanged++; continue; }
      // A row written or changed by hand (no source) is the hand's: kept, and counted, unless staff force the index.
      if (m && m.source === null && !opts.force) { c.kept_by_hand++; continue; }
      puts.push({ op: "put", area: area.name, key: d.key, title: d.title, data, version: d.version });
      if (m) c.updated++; else c.created++;
    }
    const gone = ours.filter((m) => !keys.has(m.key));
    c.kept_by_hand += [...marks.values()].filter((m) => m.source === null && !keys.has(m.key)).length;
    // The guards are an upstream's (a fetch that came back short): a workspace's committed files are the truth.
    const guarded = repo.settings.kind === "upstream_catalog" && !opts.force;
    if (guarded && !desired.length && ours.length && !prune.allow_empty)
      throw new PackError(`area ${area.name}: the index of ${repo.name} produced no rows over ${ours.length} it wrote before; refused rather than emptying it`, 409);
    if (guarded && gone.length && gone.length > maxFraction * ours.length)
      throw new PackError(`area ${area.name}: the index of ${repo.name} would remove ${gone.length} of its ${ours.length} rows (more than ${Math.round(maxFraction * 100)}%); refused (staff may force it)`, 409);
    for (const m of gone) deletes.push({ op: "delete", area: area.name, key: m.key });
    c.deleted = gone.length;
    counts.push(c);
  }
  // Deletes after every put, in the reverse order: nothing written refers to a row removed in the same index.
  const ops = [...puts, ...deletes.reverse()];
  if (ops.length) await writeFromRepository(orgId, pack, repo.name, ops, fingerprints, !!opts.force);
  return { pack, repository: repo.name, kind: repo.settings.kind, version: opts.version ?? null, source: opts.describe ?? "", written: ops.length > 0, areas: counts };
}
const refersTo = (a: RecordArea, b: RecordArea) => a.fields.some((f) => f.type === "reference" && f.to === b.name);

/**
 * Index one upstream catalog into its shared areas (platform staff): fetched at its pin only, then applyIndex. `force`
 * passes the prune's guard (staff with the delete permission).
 */
export async function syncUpstreamCatalog(pack: string, name: string, opts: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<IndexReport> {
  const repo = repositoryOrThrow(pack, name);
  const s = repo.settings;
  if (s.kind !== "upstream_catalog") throw new PackError(`repository ${name} is ${s.kind}, not an upstream catalog`, 400);
  if (typeof s.upstream !== "object") throw new PackError(`repository ${name}: its upstream pin is not resolved (pack.json upstream)`, 400);
  if (!repo.areas.length) throw new PackError(`repository ${name} feeds no area`, 400);
  const transport = s.transport ?? (s.upstream.repo.startsWith("https://github.com/") ? "github" : "git");
  const src = transport === "github" ? await githubSource(s.upstream, opts.fetcher) : await gitSource(s.upstream);
  try {
    if (src.version !== s.upstream.commit) throw new PackError("the source is not at the pinned commit: refused", 502);
    const rows = await repositoryRows(pack, name, src);
    return await asPlatform(() => applyIndex(null, pack, repo, rows, { force: opts.force, describe: src.describe, version: src.version }));
  } finally { await src.close(); }
}

/**
 * Index a workspace's files into its own rows (every workspace_files repository of the pack), as one transaction per
 * repository. `files` is the snapshot just committed (mold_v0-064's hook passes it); without it the latest committed
 * snapshot of the workspace's store for this pack is read. The workspace is the caller's id, never the files'.
 */
export async function indexWorkspaceFiles(orgId: number, pack: string, files?: { path: string; body: Uint8Array | string }[]): Promise<IndexReport[]> {
  const repos = repositoriesOf(pack).filter((r) => r.settings.kind === "workspace_files" && r.areas.length);
  if (!repos.length) return [];
  let version: string | null = null;
  if (!files) {
    const { latestSnapshot, openSnapshot } = await import("./workspace-store.js");
    const { readBundle } = await import("./workspace-bundle.js");
    const { getDb } = await import("./db.js");
    const snap = await asPlatform(async () => latestSnapshot(await getDb(), orgId, pack));
    if (!snap) return repos.map((r) => ({ pack, repository: r.name, kind: "workspace_files", version: null, source: "no snapshot yet", written: false, areas: [] }));
    files = readBundle(await asPlatform(() => openSnapshot(snap))).files;
    version = `v${snap.version}`;
  }
  const src = filesSource(files, version);
  const out: IndexReport[] = [];
  for (const repo of repos) out.push(await applyIndex(orgId, pack, repo, await repositoryRows(pack, repo.name, src), { describe: src.describe, version }));
  return out;
}

// ---------- an external HTTP API, read live ----------

const PRIVATE4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./, /^192\.0\.2\./, /^198\.1[89]\./, /^198\.51\.100\./, /^203\.0\.113\./, /^(22[4-9]|2[3-5]\d)\./, /^255\./];
/** Not a public unicast address: private, loopback, link-local, shared, documentation, benchmark, multicast, and IPv6's ways of carrying an IPv4 address. */
export const isPrivateAddress = (raw: string) => {
  const ip = raw.toLowerCase();
  const mapped = /^(::ffff:|::ffff:0:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return true; // IPv4 inside IPv6 (mapped, compatible, NAT64): refused outright
  if (isIP(ip) === 4) return PRIVATE4.some((r) => r.test(ip));
  return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89a-f]/.test(ip) || /^ff/.test(ip) || /^2002:/.test(ip) || /^64:ff9b:/.test(ip) || /^2001:db8:/.test(ip) || /^::ffff:/.test(ip);
};
type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
let resolver: Resolver = (host) => new Promise((ok, no) => dnsLookup(host, { all: true }, (e, a) => (e ? no(e) : ok(a))));
/** Tests only: resolve host names without DNS. */
export function setResolverForTest(r: Resolver | null) { resolver = r ?? ((host) => new Promise((ok, no) => dnsLookup(host, { all: true }, (e, a) => (e ? no(e) : ok(a))))); }

const allowedHost = (host: string, egress: readonly string[]) => egress.some((e) => { const x = e.toLowerCase().replace(/^\*\./, ""); return host === x || host.endsWith(`.${x}`); });
const MAX_BODY = 5 * 1024 * 1024;

/**
 * GET one JSON document from an API repository: its own host list only, https (http only with the test switch), the
 * address resolved once and checked (no private, loopback or link-local address) and that address used for the
 * connection, no redirect followed, at most 5 MB and 15 s. Errors name the status, never a header or the body.
 */
export async function apiGet(url: string, egress: readonly string[], headers: Record<string, string>): Promise<unknown> {
  let u: URL;
  try { u = new URL(url); } catch { throw new PackError("the API address is not a URL", 502); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowPrivate())) throw new PackError("an API repository is reached over https only", 502);
  const host = u.hostname.toLowerCase();
  // HTTPS on port 443 only (the egress rule); another port only with the test switch.
  if (u.port && u.port !== "443" && !allowPrivate()) throw new PackError("an API repository is reached on port 443 only", 502);
  if (!allowedHost(host, egress)) throw new PackError(`the API host ${host} is not in the repository's egress list: refused`, 502);
  let addrs: { address: string; family: number }[];
  try { addrs = await resolver(host); } catch { throw new PackError(`the API host ${host} could not be resolved`, 502); }
  if (!addrs.length || (!allowPrivate() && addrs.some((a) => isPrivateAddress(a.address)))) throw new PackError(`the API host ${host} resolves to a private address: refused`, 502);
  const pick = addrs[0]!;
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: "GET", headers: { accept: "application/json", ...headers }, timeout: 15_000,
      // The address checked above is the one connected to (a second lookup could answer differently).
      lookup: ((_h: string, o: { all?: boolean }, cb: (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void) =>
        (o?.all ? cb(null, [pick]) : cb(null, pick.address, pick.family))) as never,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return reject(new PackError(`the API redirected (${status}): refused`, 502)); }
      if (status === 404) { res.resume(); return resolve(undefined); }
      if (status < 200 || status >= 300) { res.resume(); return reject(new PackError(`the API answered ${status}`, 502)); }
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { req.destroy(); reject(new PackError("the API's answer is over 5 MB", 502)); } else chunks.push(c); });
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new PackError("the API's answer is not JSON", 502)); } });
      res.on("error", () => reject(new PackError("the API's answer broke off", 502)));
    });
    req.on("timeout", () => { req.destroy(); reject(new PackError("the API did not answer in 15 s", 504)); });
    // A whole-request deadline too (the socket timeout is per idle period: a dripping answer would hold it).
    const deadline = setTimeout(() => { req.destroy(); reject(new PackError("the API did not answer in 30 s", 504)); }, 30_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (e) => reject(e instanceof PackError ? e : new PackError("the API could not be reached", 502)));
    req.end();
  });
}

type ApiSettings = Extract<Repository, { kind: "http_api" }>;
async function apiHeaders(s: ApiSettings, pack: string, orgId: number | null): Promise<Record<string, string>> {
  if (!s.credential) return {};
  if (orgId === null) throw new PackError("this API is read with a workspace's credential", 400);
  const { workspaceCredentialValue } = await import("./credentials.js");
  const v = await workspaceCredentialValue(orgId, pack, s.credential);
  if (v === null) throw new PackError(`set the ${s.credential} credential first (Credentials page): this area is read from an API with it`, 409);
  if (/[\r\n]/.test(v)) throw new PackError(`the ${s.credential} credential cannot be sent in a header (it holds a line break)`, 409);
  return { [s.auth?.header ?? "Authorization"]: s.auth?.scheme ? `${s.auth.scheme} ${v}` : s.auth?.header ? v : `Bearer ${v}` };
}
/** An API item as a record of the area: its declared map (key, title, fields), else id, title or name, same-named fields. */
function apiRow(area: RecordArea, s: ApiSettings, item: unknown): RecordRow | null {
  const m = s.map?.[area.name];
  const ctx = { item, root: item, vars: {} };
  let key: unknown;
  try { key = m ? fillTemplate(m.key, ctx) : valueAt("id", ctx); } catch { return null; }
  if (typeof key === "number") key = String(key);
  if (typeof key !== "string" || !RECORD_KEY.test(key)) return null;
  const titleV = m?.title ? (() => { try { return fillTemplate(m.title!, ctx); } catch { return null; } })() : (valueAt("title", ctx) ?? valueAt("name", ctx) ?? null);
  const raw = Object.fromEntries(area.fields.map((f) => [f.name, fieldValue(f.name, m?.fields, ctx)]).filter(([, v]) => v !== undefined));
  const { data, drift } = conform(area, raw as Record<string, unknown>);
  return { area: area.name, key, title: typeof titleV === "string" ? titleV.slice(0, 500) : null, data, version: null, updated_at: new Date().toISOString(), ...(drift.length ? { drift } : {}) };
}
async function apiList(area: RecordArea, orgId: number | null): Promise<RecordRow[]> {
  const s = area.repo!.settings as ApiSettings;
  const doc = await apiGet(new URL(s.list.path.replace(/^\//, ""), s.base_url.endsWith("/") ? s.base_url : `${s.base_url}/`).toString(), s.egress, await apiHeaders(s, area.pack, orgId));
  const items = s.list.items ? itemsAt(doc, s.list.items) : Array.isArray(doc) ? doc : [];
  const max = s.max_items ?? 1000;
  if (items.length > max) throw new PackError(`the API listed more than ${max} items`, 502);
  const rows = items.map((x) => apiRow(area, s, x)).filter((r): r is RecordRow => !!r);
  return [...new Map(rows.map((r) => [r.key, r])).values()];
}
/** A page of an area read live from its API: the caller's own (its credential), filtered and sorted in memory. */
export async function listLive(area: RecordArea, orgId: number | null, p: Parsed) {
  return pageInMemory(p, await apiList(area, orgId));
}
/** One record of an area read live: its get path with the key (encoded), else found in the list. */
export async function getLive(area: RecordArea, orgId: number | null, key: string): Promise<RecordRow | null> {
  const s = area.repo!.settings as ApiSettings;
  if (!s.get) return (await apiList(area, orgId)).find((r) => r.key === key) ?? null;
  const url = new URL(s.get.path.replace(/^\//, "").replace("{key}", encodeURIComponent(key).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)), s.base_url.endsWith("/") ? s.base_url : `${s.base_url}/`);
  const doc = await apiGet(url.toString(), s.egress, await apiHeaders(s, area.pack, orgId));
  if (doc === undefined) return null;
  const row = apiRow(area, s, doc);
  return row && row.key === key ? row : null;
}
