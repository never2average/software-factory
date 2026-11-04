// The typed SDKs of an embedded app (mold_v0-193), generated from its OpenAPI 3.1 document (src/developer-openapi.ts):
// one JavaScript/TypeScript package (ESM JavaScript with its .d.ts: no build step, no dependency) and one Python package
// (the standard library only, TypedDicts for every schema). Each operation is named by its `x-sdk` {group, method}, so
// `client.records.tickets.list()` reads the same in both. Every write sends an Idempotency-Key (one per call, reused by
// its retries); GETs and keyed writes are retried on 429, 5xx and network errors (honouring Retry-After); an error is
// thrown as ApiError carrying the problem (status, code, detail, request_id).
// Pure functions over the document: scripts/gen-sdks.ts writes the files.

type Schema = Record<string, any>;
export interface SdkOp {
  group: string; method: string; http: string; path: string; summary: string;
  pathParams: string[]; query: { name: string; schema: Schema; required: boolean }[];
  body: Schema | null; bodyRequired: boolean; ok: Schema | null; okStatus: number; write: boolean;
}
export interface SdkFile { path: string; content: string }

const WRITE = new Set(["post", "put", "patch", "delete"]);

/**
 * Percentage bucketing (mold_v0-226; src/check-spec.ts bucketOf): emitted into both SDKs when a check of the build
 * declares a bucket (the document's x-sdk.bucketing), so a client puts a subject in the same bucket the server does.
 * The SDKs ask the server for a check's answer (POST /v1/checks/<name>); they never evaluate a check themselves. The
 * JavaScript one is synchronous and dependency-free (SHA-256 written out; TextEncoder for UTF-8), for browsers and Node.
 */
export const TS_BUCKETING = `
// ---------- percentage bucketing (the same function as the server's checks) ----------
const SHA_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
/** The first 32 bits of SHA-256 of a byte array, as an unsigned integer. */
function sha256First32(bytes) {
  const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor((l * 8) / 2 ** 32)); dv.setUint32(n - 4, (l * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), W = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      W[i] = W[i - 16] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + W[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10));
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) >>> 0;
      const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return H[0];
}
export const BUCKETS = 10000;
/** The bucket of input under salt, 0 to 9999: SHA-256 of the UTF-8 text salt + ":" + input, its first 4 bytes big-endian, mod 10000. */
export function bucket(input, salt) {
  if (typeof input !== "string" || typeof salt !== "string") throw new TypeError("bucket(input, salt): two strings");
  return sha256First32(new TextEncoder().encode(\`\${salt}:\${input}\`)) % BUCKETS;
}
/** Is input within the first percent (0 to 100, two decimals) of buckets under salt? 0: no one; 100: everyone. */
export function inRollout(input, salt, percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
  return bucket(input, salt) < Math.floor(percent * 100 + 0.5);
}
`;
export const TS_BUCKETING_DTS = `/** Buckets a percent is counted in (10000: two decimals). */
export declare const BUCKETS: 10000;
/** The bucket of input under salt, 0 to 9999 (the same function as the server's checks: SHA-256 of salt + ":" + input, first 4 bytes, mod 10000). */
export declare function bucket(input: string, salt: string): number;
/** Is input within the first percent (0 to 100) of buckets under salt? */
export declare function inRollout(input: string, salt: string, percent: number): boolean;
`;
export const PY_BUCKETING = `

# ---------- percentage bucketing (the same function as the server's checks) ----------
BUCKETS = 10000


def bucket(input: str, salt: str) -> int:
    """The bucket of input under salt, 0 to 9999: SHA-256 of the UTF-8 text salt + ":" + input, its first 4 bytes big-endian, mod 10000."""
    if not isinstance(input, str) or not isinstance(salt, str):
        raise TypeError("bucket(input, salt): two strings")
    return int.from_bytes(hashlib.sha256(f"{salt}:{input}".encode("utf-8")).digest()[:4], "big") % BUCKETS


def in_rollout(input: str, salt: str, percent: float) -> bool:
    """Is input within the first percent (0 to 100, two decimals) of buckets under salt? 0: no one; 100: everyone."""
    if isinstance(percent, bool) or not isinstance(percent, (int, float)) or percent != percent or percent < 0 or percent > 100:
        return False
    return bucket(input, salt) < math.floor(percent * 100 + 0.5)
`;
const refName = (r: string) => r.replace(/^#\/components\/schemas\//, "");

/** Every operation with x-sdk, in document order. */
export function sdkOps(doc: Schema): SdkOp[] {
  const out: SdkOp[] = [];
  for (const [p, item] of Object.entries<Record<string, Schema>>(doc.paths ?? {})) {
    for (const [http, op] of Object.entries(item)) {
      if (!op?.["x-sdk"]) continue;
      const params = (op.parameters ?? []).map((x: Schema) => (x.$ref ? doc.components.parameters[x.$ref.split("/").pop()] : x));
      const okKey = Object.keys(op.responses ?? {}).find((k) => /^2\d\d$/.test(k)) ?? "200";
      out.push({
        group: op["x-sdk"].group, method: op["x-sdk"].method, http: http.toUpperCase(), path: p, summary: op.summary ?? "",
        pathParams: params.filter((x: Schema) => x.in === "path").map((x: Schema) => x.name),
        query: params.filter((x: Schema) => x.in === "query").map((x: Schema) => ({ name: x.name, schema: x.schema ?? {}, required: !!x.required })),
        body: op.requestBody?.content?.["application/json"]?.schema ?? null, bodyRequired: !!op.requestBody?.required,
        ok: op.responses?.[okKey]?.content?.["application/json"]?.schema ?? null, okStatus: Number(okKey), write: WRITE.has(http),
      });
    }
  }
  return out;
}

// ---------- TypeScript ----------

const tsKey = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
export function tsType(s: Schema | undefined, depth = 0): string {
  if (!s || depth > 8) return "unknown";
  if (s.$ref) return refName(s.$ref);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map((x: Schema) => tsType(x, depth + 1)).join(" | ");
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (!types.length) return s.properties ? tsType({ ...s, type: "object" }, depth) : "unknown";
  return types.map((t) => {
    switch (t) {
      case "string": return "string";
      case "integer": case "number": return "number";
      case "boolean": return "boolean";
      case "null": return "null";
      case "array": return `Array<${tsType(s.items, depth + 1)}>`;
      case "object": {
        if (!s.properties) return "Record<string, unknown>";
        const req = new Set<string>(s.required ?? []);
        const fields = Object.entries<Schema>(s.properties).map(([k, v]) => `${tsKey(k)}${req.has(k) ? "" : "?"}: ${tsType(v, depth + 1)}`);
        return `{ ${fields.join("; ")}${s.additionalProperties === false ? "" : fields.length ? "; [key: string]: unknown" : "[key: string]: unknown"} }`;
      }
      default: return "unknown";
    }
  }).join(" | ");
}

/** The client's object tree: group path -> its methods. */
const tree = (ops: SdkOp[]) => {
  const root: Record<string, any> = {};
  for (const o of ops) {
    let node = root;
    for (const part of o.group.split(".")) node = node[part] ??= {};
    (node.__ops ??= []).push(o);
  }
  return root;
};

export function typescriptSdk(doc: Schema): SdkFile[] {
  const ops = sdkOps(doc);
  const bucketing = doc["x-sdk"]?.bucketing === true;
  const pkg = doc["x-sdk"]?.npm ?? "app-api";
  const version = String(doc.info.version);
  const semver = `0.${version.replace(/-/g, "")}.0`;
  const opTable = ops.map((o) => ({ g: o.group, m: o.method, h: o.http, p: o.path, pp: o.pathParams, q: o.query.map((x) => x.name), b: !!o.body, w: o.write, s: o.okStatus }));
  const js = `// Generated from the ${doc.info.title} OpenAPI document (API version ${version}) by scripts/gen-sdks.ts. Do not edit.
const OPS = ${JSON.stringify(opTable)};
export const API_VERSION = ${JSON.stringify(version)};

/** An API error: the problem the server answered (application/problem+json). */
export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.detail || problem?.title || \`HTTP \${status}\`);
    this.name = "ApiError"; this.status = status; this.problem = problem ?? null;
    this.code = problem?.code ?? "error"; this.requestId = problem?.request_id ?? null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`);

export class Client {
  /** options: {baseUrl, token (sk_... on a server, cs_... in a browser), apiVersion?, maxRetries? (2), fetch?} */
  constructor(options) {
    if (!options?.baseUrl || !options?.token) throw new Error("Client needs baseUrl and token");
    this.baseUrl = options.baseUrl.replace(/\\/$/, "");
    this.token = options.token;
    this.apiVersion = options.apiVersion ?? API_VERSION;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    for (const o of OPS) {
      let node = this;
      for (const part of o.g.split(".")) node = node[part] ??= {};
      node[o.m] = (...args) => this.#call(o, args);
    }
  }
  #call(o, args) {
    const a = [...args];
    const pathArgs = a.splice(0, o.pp.length);
    let path = o.p;
    o.pp.forEach((name, i) => { path = path.replace(\`{\${name}}\`, encodeURIComponent(String(pathArgs[i]))); });
    const body = o.b ? a.shift() : undefined;
    const query = o.q.length ? a.shift() : undefined;
    const opts = a.shift() ?? {};
    return this.request(o.h, path, { body, query, write: o.w, ...opts });
  }
  /** A raw request: {query, body, idempotencyKey, actor, scope, apiVersion}. Writes get an Idempotency-Key unless given one. */
  async request(method, path, { query, body, idempotencyKey, actor, scope, apiVersion, write } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    const headers = { authorization: \`Bearer \${this.token}\`, "api-version": apiVersion ?? this.apiVersion, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const key = idempotencyKey ?? (write ? newKey() : undefined);
    if (key) headers["idempotency-key"] = key;
    if (actor) headers["x-actor"] = actor;
    if (scope) headers["x-scope"] = Array.isArray(scope) ? scope.join(" ") : scope;
    const retryable = method === "GET" || !!key;
    for (let attempt = 0; ; attempt++) {
      let res;
      try { res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
      catch (e) { if (retryable && attempt < this.maxRetries) { await sleep(250 * 2 ** attempt); continue; } throw e; }
      if ((res.status === 429 || res.status >= 500) && retryable && attempt < this.maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 250 * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return undefined;
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new ApiError(res.status, json);
      return json;
    }
  }
}
${bucketing ? TS_BUCKETING : ""}`;
  // The declarations: every schema, the options, and the client's tree typed.
  const schemas = Object.entries<Schema>(doc.components?.schemas ?? {}).map(([n, s]) => `/** ${String(s.title ?? n).replace(/\*\//g, "")} */\nexport type ${n} = ${tsType(s)};`).join("\n");
  const sig = (o: SdkOp) => {
    const parts = o.pathParams.map((p) => `${p}: string`);
    if (o.body) parts.push(`body${o.bodyRequired ? "" : "?"}: ${tsType(o.body)}`);
    if (o.query.length) parts.push(`query?: { ${o.query.map((q) => `${tsKey(q.name)}?: ${q.name === "filter" ? "string | Record<string, unknown>" : tsType(q.schema)}`).join("; ")} }`);
    parts.push("options?: RequestOptions");
    return `  /** ${o.summary.replace(/\*\//g, "")} (${o.http} ${o.path}) */\n  ${o.method}(${parts.join(", ")}): Promise<${o.okStatus === 204 || !o.ok ? "void" : tsType(o.ok)}>;`;
  };
  const iface = (node: Record<string, any>, name: string): string[] => {
    const lines: string[] = [];
    const children = Object.keys(node).filter((k) => k !== "__ops");
    const body = [...(node.__ops ?? []).map(sig), ...children.map((c) => `  readonly ${tsKey(c)}: ${name}_${c.replace(/[^A-Za-z0-9_]/g, "_")};`)];
    lines.push(`export interface ${name} {\n${body.join("\n")}\n}`);
    for (const c of children) lines.push(...iface(node[c], `${name}_${c.replace(/[^A-Za-z0-9_]/g, "_")}`));
    return lines;
  };
  const t = tree(ops);
  const groups = Object.keys(t);
  const dts = `// Generated from the ${doc.info.title} OpenAPI document (API version ${version}) by scripts/gen-sdks.ts. Do not edit.
export declare const API_VERSION: ${JSON.stringify(version)};
export interface Problem { type: string; title: string; status: number; detail?: string; code: string; request_id?: string; [key: string]: unknown }
export declare class ApiError extends Error {
  readonly status: number; readonly code: string; readonly requestId: string | null; readonly problem: Problem | null;
  constructor(status: number, problem: Problem | null);
}
export interface RequestOptions {
  /** Sent as Idempotency-Key (a write gets a new one per call when none is given; its retries reuse it). */
  idempotencyKey?: string;
  /** X-Actor: your signed-in user this call is for (keys only). */
  actor?: string;
  /** X-Scope: narrow this request to these scopes. */
  scope?: string | string[];
  /** API-Version for this request. */
  apiVersion?: string;
}
export interface ClientOptions { baseUrl: string; token: string; apiVersion?: string; maxRetries?: number; fetch?: typeof fetch }
${schemas}
${groups.flatMap((g) => iface(t[g], `Group_${g.replace(/[^A-Za-z0-9_]/g, "_")}`)).join("\n")}
export declare class Client {
  constructor(options: ClientOptions);
${groups.map((g) => `  readonly ${tsKey(g)}: Group_${g.replace(/[^A-Za-z0-9_]/g, "_")};`).join("\n")}
  request(method: string, path: string, options?: RequestOptions & { query?: Record<string, unknown>; body?: unknown; write?: boolean }): Promise<unknown>;
}
${bucketing ? TS_BUCKETING_DTS : ""}`;
  const pkgJson = { name: pkg, version: semver, description: `Typed client for the ${doc.info.title} (API version ${version}).`, type: "module", main: "./index.js", types: "./index.d.ts",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } }, files: ["index.js", "index.d.ts", "README.md"], sideEffects: false, license: "UNLICENSED", engines: { node: ">=18" } };
  const readme = `# ${pkg}\n\nTyped client for the ${doc.info.title}, API version ${version}, generated from its OpenAPI document.\n\n\`\`\`ts\nimport { Client } from "${pkg}";\nconst api = new Client({ baseUrl: process.env.API_URL!, token: process.env.API_KEY! });\n\`\`\`\n\nOperations: ${ops.map((o) => `\`${o.group}.${o.method}\``).join(", ")}.\n`;
  return [{ path: "index.js", content: js }, { path: "index.d.ts", content: dts }, { path: "package.json", content: `${JSON.stringify(pkgJson, null, 2)}\n` }, { path: "README.md", content: readme }];
}

// ---------- Python ----------

const PY_RESERVED = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
const pyName = (s: string) => { const n = s.replace(/[^A-Za-z0-9_]/g, "_"); return PY_RESERVED.has(n) ? `${n}_` : n; };
export function pyType(s: Schema | undefined, depth = 0): string {
  if (!s || depth > 8) return "Any";
  if (s.$ref) return `"${refName(s.$ref)}"`;
  if (s.const !== undefined) return `Literal[${JSON.stringify(s.const)}]`;
  if (s.enum) return `Literal[${s.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}]`;
  if (s.anyOf || s.oneOf) return `Union[${(s.anyOf ?? s.oneOf).map((x: Schema) => pyType(x, depth + 1)).join(", ")}]`;
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const one = (t: string) => ({ string: "str", integer: "int", number: "float", boolean: "bool", null: "None", array: `List[${pyType(s.items, depth + 1)}]`, object: "Dict[str, Any]" } as Record<string, string>)[t] ?? "Any";
  if (!types.length) return "Any";
  return types.length === 1 ? one(types[0]!) : `Optional[${types.filter((t) => t !== "null").map(one).join(", ")}]`;
}

export function pythonSdk(doc: Schema): SdkFile[] {
  const ops = sdkOps(doc);
  const bucketing = doc["x-sdk"]?.bucketing === true;
  const mod = pyName(doc["x-sdk"]?.python ?? "app_api");
  const version = String(doc.info.version);
  // TypedDicts: an object schema with properties (required keys as Required, the rest NotRequired); others as aliases.
  const defs: string[] = [];
  for (const [n, s] of Object.entries<Schema>(doc.components?.schemas ?? {})) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.includes("object") && s.properties && Object.keys(s.properties).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !PY_RESERVED.has(k))) {
      const req = new Set<string>(s.required ?? []);
      const fields = Object.entries<Schema>(s.properties).map(([k, v]) => `    ${k}: ${req.has(k) ? pyType(v) : `NotRequired[${pyType(v)}]`}`);
      defs.push(`class ${n}(TypedDict):\n    """${String(s.title ?? n).replace(/"""/g, "'")}"""\n${fields.join("\n") || "    pass"}\n`);
    } else defs.push(`${n} = ${pyType(s).replace(/^"(.*)"$/, "$1")}\n`);
  }
  const t = tree(ops);
  const classes: string[] = [];
  const cls = (node: Record<string, any>, name: string) => {
    const children = Object.keys(node).filter((k) => k !== "__ops");
    for (const c of children) cls(node[c], `${name}_${pyName(c)}`);
    const lines = [`class ${name}:`, `    def __init__(self, client: "Client") -> None:`, `        self._c = client`];
    for (const c of children) lines.push(`        self.${pyName(c)} = ${name}_${pyName(c)}(client)`);
    for (const o of node.__ops ?? [] as SdkOp[]) {
      const args = ["self", ...o.pathParams.map((p: string) => `${pyName(p)}: str`)];
      if (o.body) args.push(o.bodyRequired ? `body: ${pyType(o.body)}` : `body: Optional[${pyType(o.body)}] = None`);
      const kw = o.query.map((q: { name: string; schema: Schema }) => `${pyName(q.name)}: Optional[${q.name === "filter" ? "Union[str, Dict[str, Any]]" : pyType(q.schema)}] = None`);
      args.push("*", ...kw, "idempotency_key: Optional[str] = None", "actor: Optional[str] = None", "scope: Optional[Union[str, List[str]]] = None", "api_version: Optional[str] = None");
      const ret = o.okStatus === 204 || !o.ok ? "None" : pyType(o.ok);
      const path = o.pathParams.reduce((p: string, n: string) => p.replace(`{${n}}`, `{_q(${pyName(n)})}`), o.path);
      lines.push(`    def ${pyName(o.method)}(${args.join(", ")}) -> ${ret}:`, `        """${o.summary.replace(/"""/g, "'")} (${o.http} ${o.path})"""`,
        `        return self._c.request(${JSON.stringify(o.http)}, f${JSON.stringify(path)}, body=${o.body ? "body" : "None"}, query={${o.query.map((q: { name: string }) => `${JSON.stringify(q.name)}: ${pyName(q.name)}`).join(", ")}}, write=${o.write ? "True" : "False"}, idempotency_key=idempotency_key, actor=actor, scope=scope, api_version=api_version)  # type: ignore[return-value]`);
    }
    classes.push(lines.join("\n") + "\n");
  };
  const groups = Object.keys(t);
  for (const g of groups) cls(t[g], `_${pyName(g)}`);
  const init = `"""Typed client for the ${doc.info.title} (API version ${version}). Generated by scripts/gen-sdks.ts from its OpenAPI document. Do not edit."""
from __future__ import annotations

${bucketing ? "import hashlib\n" : ""}import json
${bucketing ? "import math\n" : ""}import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Literal, Optional, Union

try:
    from typing import NotRequired, TypedDict
except ImportError:  # Python < 3.11
    from typing_extensions import NotRequired, TypedDict  # type: ignore

API_VERSION = ${JSON.stringify(version)}


class ApiError(Exception):
    """An API error: the problem the server answered (application/problem+json)."""

    def __init__(self, status: int, problem: Optional[Dict[str, Any]]) -> None:
        self.status = status
        self.problem = problem or {}
        self.code = self.problem.get("code", "error")
        self.request_id = self.problem.get("request_id")
        super().__init__(self.problem.get("detail") or self.problem.get("title") or f"HTTP {status}")


def _q(v: Any) -> str:
    return urllib.parse.quote(str(v), safe="")


${defs.join("\n")}

${classes.join("\n\n")}

class Client:
    """base_url: the API's address; token: a key (sk_...) on a server, a client session (cs_...) elsewhere."""

    def __init__(self, base_url: str, token: str, api_version: str = API_VERSION, max_retries: int = 2, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.api_version = api_version
        self.max_retries = max_retries
        self.timeout = timeout
${groups.map((g) => `        self.${pyName(g)} = _${pyName(g)}(self)`).join("\n")}

    def request(self, method: str, path: str, body: Any = None, query: Optional[Dict[str, Any]] = None, write: bool = False,
                idempotency_key: Optional[str] = None, actor: Optional[str] = None, scope: Optional[Union[str, List[str]]] = None,
                api_version: Optional[str] = None) -> Any:
        q = {k: (json.dumps(v) if isinstance(v, (dict, list)) else ("true" if v is True else "false" if v is False else str(v))) for k, v in (query or {}).items() if v is not None}
        url = self.base_url + path + ("?" + urllib.parse.urlencode(q) if q else "")
        headers = {"Authorization": f"Bearer {self.token}", "API-Version": api_version or self.api_version, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        key = idempotency_key or (str(uuid.uuid4()) if write else None)
        if key:
            headers["Idempotency-Key"] = key
        if actor:
            headers["X-Actor"] = actor
        if scope:
            headers["X-Scope"] = " ".join(scope) if isinstance(scope, list) else scope
        retryable = method == "GET" or bool(key)
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    text = res.read().decode("utf-8")
                    return json.loads(text) if text else None
            except urllib.error.HTTPError as e:
                text = e.read().decode("utf-8")
                if (e.code == 429 or e.code >= 500) and retryable and attempt < self.max_retries:
                    after = e.headers.get("Retry-After")
                    time.sleep(min(float(after), 30.0) if after and after.isdigit() else 0.25 * 2 ** attempt)
                    attempt += 1
                    continue
                try:
                    problem = json.loads(text) if text else None
                except ValueError:
                    problem = None
                raise ApiError(e.code, problem) from None
            except urllib.error.URLError:
                if retryable and attempt < self.max_retries:
                    time.sleep(0.25 * 2 ** attempt)
                    attempt += 1
                    continue
                raise
${bucketing ? PY_BUCKETING : ""}`;
  const pyproject = `[build-system]\nrequires = ["setuptools>=61"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "${mod.replace(/_/g, "-")}"\nversion = "0.${version.replace(/-/g, "")}.0"\ndescription = "Typed client for the ${doc.info.title} (API version ${version})."\nrequires-python = ">=3.9"\ndependencies = ['typing_extensions>=4.0; python_version<"3.11"']\n\n[tool.setuptools]\npackages = ["${mod}"]\n\n[tool.setuptools.package-data]\n${mod} = ["py.typed"]\n`;
  const readme = `# ${mod}\n\nTyped client for the ${doc.info.title}, API version ${version}, generated from its OpenAPI document.\n\n\`\`\`python\nfrom ${mod} import Client\napi = Client(base_url=API_URL, token=API_KEY)\n\`\`\`\n`;
  return [{ path: `${mod}/__init__.py`, content: init }, { path: `${mod}/py.typed`, content: "" }, { path: "pyproject.toml", content: pyproject }, { path: "README.md", content: readme }];
}
