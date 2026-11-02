/**
 * Chain and sign (mold_v0-195): the audit trails (src/audit-trail.ts) and a pack's record areas declared
 * `append_only: true` with `chain: true` are hash-chained in the database (sql/migrations/0033_ledger_chain.sql: a
 * trigger computes every entry's hash = sha256(prev_hash || canonical entry), per workspace and stream), and, when the
 * profile says `audit.sign: true`, signed: a scheduler job writes checkpoints, each an Ed25519 signature over the
 * Merkle root of a window of a stream's entries and the previous checkpoint's hash, with a key the database never sees.
 *
 *   streams      'data' and 'platform' (the trails, numbered by their writer) and 'records:<pack>/<area>' (a chained
 *                area's records, numbered by the trigger); scope: a workspace's id, or 0 for the platform's own entries.
 *   canonical    canon(fields): each field as `<bytes>:<text>;`, a null as `~;` (the same rule as app_ledger_canon in
 *                SQL); the fields are the row's own values as text, times as whole microseconds since 1970 (UTC).
 *   Merkle root  RFC 6962's tree hash over the window's entry hashes (leaf: sha256(0x00 || h), node: sha256(0x01 || l || r)).
 *   statement    the text that is signed (statement() below): stream, scope, n, the window, its entry count, the last
 *                entry's hash, the Merkle root, the previous checkpoint's hash, when and with which key.
 *   the key      APP_LEDGER_SIGNING_KEY, from the app's environment by name (the factory's --set-secret), never
 *                printed and never sent to the database: a key the database can read (a database setting, a Key vault
 *                provider that serves that name) is refused, and nothing is signed. Its public half, and retired ones
 *                (APP_LEDGER_PUBLIC_KEYS), are published at /.well-known/ledger-keys.json.
 *   verify       a workspace's owners: GET /api/ledger/verify and the MCP tool verify_audit_trail (ok, or the first bad
 *                sequence number and why). The operator, offline: scripts/operator/verify-ledger.ts (provision.py <app>
 *                --operator verify-ledger), with the published public key; scripts/operator/verify_ledger.py checks
 *                its --export bundle in Python.
 *
 * A tampered chain is refused rather than certified: before signing, the window is recomputed from the rows' values
 * and checked to continue from the last checkpoint; a mismatch writes no checkpoint and says why.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Org } from "./auth.js";
import { auditSettings } from "./audit-trail.js";
import { getDb, type Queryable } from "./db.js";
import { ENV } from "./env-names.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

// ---------------------------------------------------------------- settings

/** profile.json audit.sign (default false) and audit.checkpoint_minutes (default 60). */
export const signOn = () => auditSettings().sign;
export const checkpointMinutes = () => auditSettings().checkpoint_minutes;

export const KEY_ENV = "APP_LEDGER_SIGNING_KEY";
export const RETIRED_KEYS_ENV = "APP_LEDGER_PUBLIC_KEYS";

// ---------------------------------------------------------------- the canonical form, hashes, the Merkle root

export const ZERO = Buffer.alloc(32);
const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
export const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString("hex");
const buf = (v: unknown): Buffer => (v == null ? Buffer.alloc(0) : Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  : typeof v === "string" && v.startsWith("\\x") ? Buffer.from(v.slice(2), "hex") : Buffer.from(String(v), "hex"));

/** The canonical text of an entry: each field as `<bytes>:<text>;`, a null as `~;` (SQL app_ledger_canon). */
export function canon(parts: readonly (string | null)[]): string {
  return parts.map((p) => (p === null ? "~;" : `${Buffer.byteLength(p, "utf8")}:${p};`)).join("");
}
export const entryHash = (prev: Buffer, parts: readonly (string | null)[]) => sha256(prev, Buffer.from(canon(parts), "utf8"));

/** RFC 6962 Merkle tree hash of the leaves (entry hashes). */
export function merkleRoot(leaves: readonly Buffer[]): Buffer {
  if (!leaves.length) return sha256();
  const mth = (lo: number, hi: number): Buffer => {
    if (hi - lo === 1) return sha256(Buffer.from([0]), leaves[lo]!);
    let k = 1;
    while (k * 2 < hi - lo) k *= 2;
    return sha256(Buffer.from([1]), mth(lo, lo + k), mth(lo + k, hi));
  };
  return mth(0, leaves.length);
}

// ---------------------------------------------------------------- the streams and their rows

export type StreamKind = "data" | "platform" | "records";
export const streamKind = (stream: string): StreamKind | null =>
  stream === "data" || stream === "platform" ? stream : /^records:[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(stream) ? "records" : null;
export const recordStream = (pack: string, area: string) => `records:${pack}/${area}`;

const US = (col: string) => `(extract(epoch FROM ${col}) * 1000000)::bigint::text`;
/**
 * Each stream's rows as text, in the canonical order (the same fields as SQL app_ledger_fields_*; read here with plain
 * casts so a verifier never relies on a function the database holds).
 */
const STREAM_SQL: Record<StreamKind, { from: string; seq: string; cols: string; where: string }> = {
  data: { from: "audit_data_events", seq: "seq", where: "org_id = $1",
    cols: `org_id::text AS f_org, seq::text AS f_seq, ${US("at")} AS f_at, actor_kind, actor_id, key_id::text AS f_key, action, target, pack, area, record_key, rows::text AS f_rows, channel` },
  platform: { from: "audit_platform_events", seq: "seq", where: "scope_id = $1",
    cols: `scope_id::text AS f_scope, seq::text AS f_seq, org_id::text AS f_org, ${US("at")} AS f_at, kind, channel, method, path, key_id::text AS f_key, actor_kind, actor_id, scopes, status::text AS f_status, latency_ms::text AS f_latency, ip` },
  records: { from: "workspace_records", seq: "chain_seq", where: "org_id = $1 AND pack = $3 AND area = $4 AND chained",
    cols: `org_id::text AS f_org, pack, area, chain_seq::text AS f_seq, key, title, data::text AS f_data, sealed::text AS f_sealed, source, fingerprint, ${US("created_at")} AS f_at` },
};
const textArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String)
  : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((s) => s.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1")) : []);
function partsOf(kind: StreamKind, r: Record<string, any>): (string | null)[] {
  if (kind === "data") return ["ledger/v1", "data", r.f_org, r.f_seq, r.f_at, r.actor_kind, r.actor_id, r.f_key, r.action, r.target, r.pack, r.area, r.record_key, r.f_rows, r.channel];
  if (kind === "platform") return ["ledger/v1", "platform", r.f_scope, r.f_seq, r.f_org, r.f_at, r.kind, r.channel, r.method, r.path, r.f_key, r.actor_kind, r.actor_id,
    canon(textArray(r.scopes)), r.f_status, r.f_latency, r.ip];
  return ["ledger/v1", "records", r.f_org, r.pack, r.area, r.f_seq, r.key, r.title, r.f_data, r.f_sealed, r.source, r.fingerprint, r.f_at];
}

export interface LedgerEntry { seq: number; prev_hash: Buffer; hash: Buffer; parts: (string | null)[] }
/** Any way to run a query: the app's database (getDb, withTenant) or a verifier's own read-only connection. */
export type RunQuery = (sql: string, params: unknown[]) => Promise<Record<string, any>[]>;
export const runOn = (db: Queryable): RunQuery => (sql, params) => db.query<Record<string, any>>(sql, params);

const PAGE = 2000;
/** A stream's entries in sequence order, page by page (from `after`, up to `upTo`). */
export async function* readEntries(q: RunQuery, scope: number, stream: string, after = 0, upTo: number | null = null): AsyncGenerator<LedgerEntry> {
  const kind = streamKind(stream);
  if (!kind) throw new Error(`no such stream ${JSON.stringify(stream).slice(0, 80)}`);
  const s = STREAM_SQL[kind];
  const [pack, area] = kind === "records" ? stream.slice("records:".length).split("/") : [];
  let last = after;
  for (;;) {
    const params: unknown[] = [scope, last, ...(kind === "records" ? [pack, area] : []), upTo ?? Number.MAX_SAFE_INTEGER];
    const rows = await q(`/* tenant: one workspace's (scope_id: its id) stream, by sequence */ SELECT ${s.seq}::text AS q_seq, prev_hash, hash, ${s.cols} FROM ${s.from}
      WHERE ${s.where} AND ${s.seq} > $2 AND ${s.seq} <= $${params.length} ORDER BY ${s.seq} LIMIT ${PAGE}`, params);
    for (const r of rows) yield { seq: Number(r.q_seq), prev_hash: buf(r.prev_hash), hash: buf(r.hash), parts: partsOf(kind, r) };
    if (rows.length < PAGE) return;
    last = Number(rows[rows.length - 1]!.q_seq);
  }
}

// ---------------------------------------------------------------- checkpoints

export interface Checkpoint {
  scope: number; stream: string; n: number; from_seq: number; to_seq: number; entries: number; last_hash: Buffer; merkle_root: Buffer;
  prev_checkpoint: Buffer; checkpoint_hash: Buffer; key_id: string; signature: Buffer; signed_ms: number;
}
/** The text a checkpoint signs (and whose sha256 is its hash, the next one's prev_checkpoint). */
export function statement(c: Omit<Checkpoint, "checkpoint_hash" | "signature">): string {
  return ["ledger-checkpoint/v1", `stream=${c.stream}`, `scope=${c.scope}`, `n=${c.n}`, `from=${c.from_seq}`, `to=${c.to_seq}`, `entries=${c.entries}`,
    `last=${hex(c.last_hash)}`, `root=${hex(c.merkle_root)}`, `prev=${hex(c.prev_checkpoint)}`, `signed_ms=${c.signed_ms}`, `kid=${c.key_id}`].join("\n");
}
export async function readCheckpoints(q: RunQuery, scope: number, stream: string, lastOnly = false): Promise<Checkpoint[]> {
  const rows = await q(`/* tenant: one workspace's (scope_id: its id) checkpoints */ SELECT scope_id::text AS scope, stream, n::text AS n, from_seq::text AS from_seq, to_seq::text AS to_seq, entries,
      last_hash, merkle_root, prev_checkpoint, checkpoint_hash, key_id, signature, (extract(epoch FROM signed_at) * 1000)::bigint::text AS signed_ms
      FROM ledger_checkpoints WHERE scope_id = $1 AND stream = $2 ORDER BY n ${lastOnly ? "DESC LIMIT 1" : ""}`, [scope, stream]);
  return rows.map((r) => ({ scope: Number(r.scope), stream: r.stream, n: Number(r.n), from_seq: Number(r.from_seq), to_seq: Number(r.to_seq), entries: Number(r.entries),
    last_hash: buf(r.last_hash), merkle_root: buf(r.merkle_root), prev_checkpoint: buf(r.prev_checkpoint), checkpoint_hash: buf(r.checkpoint_hash),
    key_id: r.key_id, signature: buf(r.signature), signed_ms: Number(r.signed_ms) }));
}

// ---------------------------------------------------------------- keys

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export const keyId = (pub: Buffer) => createHash("sha256").update(pub).digest("hex").slice(0, 16);
export const publicKeyObject = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: "der", type: "spki" })).subarray(SPKI_ED25519.length);
/** 32 raw bytes as hex or base64(url), or nothing. */
function raw32(v: string): Buffer | null {
  const s = v.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) { const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"); return b.length === 32 ? b : null; }
  return null;
}
interface SigningKey { key: KeyObject; pub: Buffer; kid: string; forms: string[] }
/** The signing key from the environment (a 32-byte seed, hex or base64, or a PKCS#8 PEM); a problem in words, never the key. */
export function loadSigningKey(env: NodeJS.ProcessEnv = ENV): SigningKey | { problem: string } {
  const v = env[KEY_ENV];
  if (!v || !v.trim()) return { problem: `${KEY_ENV} is not set: nothing is signed until the operator sets it (provision.py <app> --set-secret ${KEY_ENV})` };
  try {
    const seed = raw32(v);
    const key = seed ? createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" }) : createPrivateKey(v.replace(/\\n/g, "\n"));
    if (key.asymmetricKeyType !== "ed25519") return { problem: `${KEY_ENV} is not an Ed25519 key` };
    const pub = rawPublic(createPublicKey(key));
    const der = Buffer.from(key.export({ format: "der", type: "pkcs8" }));
    const s = der.subarray(der.length - 32);
    // Every spelling of the private key, to look for in what the database can read (never printed).
    const forms = [v.trim(), s.toString("hex"), s.toString("base64"), s.toString("base64url"), der.toString("base64")].filter((f) => f.length >= 32);
    return { key, pub, kid: keyId(pub), forms };
  } catch {
    return { problem: `${KEY_ENV} is not an Ed25519 key (32 bytes as hex or base64, or a PKCS#8 PEM)` };
  }
}
/** The published keys: the current key's public half and the retired ones (APP_LEDGER_PUBLIC_KEYS, comma-separated). */
export function publishedKeys(env: NodeJS.ProcessEnv = ENV): { kid: string; alg: "Ed25519"; public_key: string; public_key_hex: string; pem: string; current: boolean }[] {
  const out: ReturnType<typeof publishedKeys> = [];
  const add = (pub: Buffer, current: boolean) => {
    if (out.some((k) => k.public_key_hex === hex(pub))) return;
    out.push({ kid: keyId(pub), alg: "Ed25519", public_key: pub.toString("base64"), public_key_hex: hex(pub), pem: String(publicKeyObject(pub).export({ format: "pem", type: "spki" })), current });
  };
  const k = loadSigningKey(env);
  if (!("problem" in k)) add(k.pub, true);
  for (const p of String(env[RETIRED_KEYS_ENV] ?? "").split(",")) { const b = raw32(p); if (b) add(b, false); }
  return out;
}
export type KeyRing = Map<string, KeyObject>;
export const keyRing = (pubs: Buffer[]): KeyRing => new Map(pubs.map((p) => [keyId(p), publicKeyObject(p)]));
/** A public key from hex, base64 or a PEM. */
export function parsePublicKey(v: string): Buffer | null {
  const r = raw32(v);
  if (r) return r;
  try { const k = createPublicKey(v.replace(/\\n/g, "\n")); return k.asymmetricKeyType === "ed25519" ? rawPublic(k) : null; } catch { return null; }
}

let guard: { at: number; problem: string | null } | null = null;
/**
 * Refuse a signing key the database role can read: one a database or role setting holds (pg_settings, ALTER DATABASE /
 * ROLE ... SET), or one the Key vault (a database table) would serve under the key's name. Checked at most every 10
 * minutes; the key is compared in this process and never sent anywhere.
 */
export async function keyReadableByDatabase(db: Queryable, k: SigningKey): Promise<string | null> {
  if (guard && Date.now() - guard.at < 600_000) return guard.problem;
  let problem: string | null = null;
  const vault = await db.query<{ slug: string }>("SELECT slug FROM vault_providers WHERE $1 = ANY (env_vars)", [KEY_ENV]).catch(() => []);
  if (vault.length) problem = `the Key vault (in the database) has a provider for ${KEY_ENV} (${vault.map((v) => v.slug).join(", ")}): the signing key must live only in the app's environment; remove it from the Key vault`;
  if (!problem) {
    const settings = [
      ...(await db.query<{ name: string; setting: string | null }>("SELECT name, setting FROM pg_settings").catch(() => [])),
      ...(await db.query<{ name: string; setting: string | null }>("SELECT 'role or database setting' AS name, unnest(setconfig) AS setting FROM pg_db_role_setting").catch(() => [])),
    ];
    const hit = settings.find((s) => s.setting && k.forms.some((f) => s.setting!.includes(f)));
    if (hit) problem = `the signing key is in a database setting (${hit.name}): the database must never see it; remove it there and keep it only in the app's environment`;
  }
  guard = { at: Date.now(), problem };
  return problem;
}
/** Tests only: forget the last key check. */
export const resetKeyGuardForTest = () => { guard = null; };

// ---------------------------------------------------------------- verifying a stream

export interface Problem { seq: number; reason: string }
export interface StreamReport {
  scope: number; stream: string; ok: boolean; entries: number; first_seq: number | null; last_seq: number | null;
  checkpoints: number; signed_through: number | null; unsigned: number; first_bad_seq: number | null; reason: string | null; problems: Problem[];
  /** Checkpoints whose signature could not be checked (no published key for their key id). */
  unchecked: number;
}

/**
 * Verify a stream: every entry's hash recomputed from its values, each linked to the one before, numbered without a gap;
 * every checkpoint's statement, its signature (with `keys`), its link to the one before, and its Merkle root and last
 * hash recomputed from the entries it signed. The first bad sequence number, and why.
 */
export async function verifyStream(q: RunQuery, scope: number, stream: string, keys: KeyRing | null): Promise<StreamReport> {
  const cps = await readCheckpoints(q, scope, stream);
  const problems: Problem[] = [];
  const bad = (seq: number, reason: string) => { if (problems.length < 20) problems.push({ seq, reason }); };
  let unchecked = 0;
  // The checkpoints among themselves.
  let prevCp: Checkpoint | null = null;
  for (const c of cps) {
    const where = `checkpoint ${c.n} (entries ${c.from_seq} to ${c.to_seq})`;
    if (c.n !== (prevCp ? prevCp.n + 1 : 1)) bad(c.from_seq, `${where}: checkpoint ${prevCp ? prevCp.n + 1 : 1} is missing`);
    if (!c.prev_checkpoint.equals(prevCp ? sha256(Buffer.from(statement(prevCp), "utf8")) : ZERO)) bad(c.from_seq, `${where} does not follow the checkpoint before it`);
    if (prevCp && c.from_seq !== prevCp.to_seq + 1) bad(Math.min(c.from_seq, prevCp.to_seq + 1), `${where} does not start where checkpoint ${prevCp.n} ended (${prevCp.to_seq})`);
    const st = Buffer.from(statement(c), "utf8");
    if (!c.checkpoint_hash.equals(sha256(st))) bad(c.from_seq, `${where} was changed after it was signed (its hash does not match it)`);
    const pub = keys?.get(c.key_id);
    if (!keys) unchecked++;
    else if (!pub) { unchecked++; bad(c.from_seq, `${where} is signed with key ${c.key_id}, which is not among the published keys`); }
    else if (!edVerify(null, st, pub, c.signature)) bad(c.from_seq, `${where}: the signature does not verify with key ${c.key_id}`);
    prevCp = c;
  }
  // The entries, with each checkpoint's window as it goes by.
  let i = 0, n = 0, first: number | null = null, last: number | null = null, prevStored: Buffer | null = null;
  let leaves: Buffer[] = [], leafFrom: number | null = null;
  const close = (c: Checkpoint) => {
    const where = `checkpoint ${c.n} (entries ${c.from_seq} to ${c.to_seq}, signed ${new Date(c.signed_ms).toISOString()})`;
    if (leafFrom === null) { /* the whole window is gone: pruned (before the first entry) or missing (reported as a gap) */ }
    else if (leafFrom === c.from_seq && leaves.length === c.entries) {
      if (!merkleRoot(leaves).equals(c.merkle_root)) bad(c.from_seq, `the entries ${c.from_seq} to ${c.to_seq} no longer give the Merkle root signed in ${where}: one of them was changed after it was signed`);
      else if (!leaves[leaves.length - 1]!.equals(c.last_hash)) bad(c.to_seq, `entry ${c.to_seq} no longer gives the last hash signed in ${where}`);
    } else if (leafFrom === c.from_seq || first === null || leafFrom !== first) {
      bad(c.from_seq, `${where} signed ${c.entries} entries; ${leaves.length} of them are here`);
    } else if (last !== null && last >= c.to_seq && !leaves[leaves.length - 1]!.equals(c.last_hash)) {
      // The start of the window was pruned (retention): its last entry still has to match.
      bad(c.to_seq, `entry ${c.to_seq} no longer gives the last hash signed in ${where}`);
    }
    leaves = []; leafFrom = null;
  };
  for await (const e of readEntries(q, scope, stream)) {
    n++;
    const recomputed = entryHash(e.prev_hash, e.parts);
    if (first === null) {
      first = e.seq;
      if (e.seq === 1 && !e.prev_hash.equals(ZERO)) bad(1, "entry 1 does not start the chain");
    } else {
      if (e.seq !== last! + 1) bad(last! + 1, `entries ${last! + 1}${e.seq - 1 > last! + 1 ? ` to ${e.seq - 1}` : ""} are missing`);
      if (!e.prev_hash.equals(prevStored!)) bad(e.seq, `entry ${e.seq} does not continue the chain from entry ${last}`);
    }
    if (!recomputed.equals(e.hash)) bad(e.seq, `entry ${e.seq}'s values do not give its hash: it was changed after it was written`);
    prevStored = e.hash; last = e.seq;
    while (i < cps.length && cps[i]!.to_seq < e.seq) close(cps[i++]!);
    if (i < cps.length && e.seq >= cps[i]!.from_seq) { if (leafFrom === null) leafFrom = e.seq; leaves.push(recomputed); }
  }
  for (; i < cps.length; i++) {
    const c = cps[i]!;
    if (last === null || c.to_seq > last) bad(last === null ? c.from_seq : Math.max(last + 1, c.from_seq), `entries ${last === null ? c.from_seq : Math.max(last + 1, c.from_seq)} to ${c.to_seq}, signed in checkpoint ${c.n}, are missing`);
    close(c);
  }
  problems.sort((a, b) => a.seq - b.seq);
  const signedThrough = cps.length ? cps[cps.length - 1]!.to_seq : null;
  return { scope, stream, ok: problems.length === 0, entries: n, first_seq: first, last_seq: last, checkpoints: cps.length, signed_through: signedThrough,
    unsigned: last === null ? 0 : Math.max(0, last - Math.max(signedThrough ?? 0, (first ?? 1) - 1)), first_bad_seq: problems[0]?.seq ?? null, reason: problems[0]?.reason ?? null, problems, unchecked };
}

// ---------------------------------------------------------------- writing checkpoints

const MAX_WINDOW = 10_000;
export interface CheckpointResult { scope: number; stream: string; n?: number; from_seq?: number; to_seq?: number; refused?: string }

/**
 * One checkpoint of a stream: the entries after the last checkpoint (at most MAX_WINDOW), recomputed from their values
 * and checked to continue from it, signed. A tampered window is refused (nothing written; the reason returned).
 */
export async function checkpointStream(scope: number, stream: string, k: SigningKey, now = new Date()): Promise<CheckpointResult> {
  const db = await getDb();
  return asPlatform(() => db.transaction(async (tx) => {
    const q = runOn(tx);
    const prev = (await readCheckpoints(q, scope, stream, true))[0] ?? null;
    const refuse = (seq: number, why: string): CheckpointResult => ({ scope, stream, refused: `entry ${seq}: ${why}` });
    if (prev) {
      // The checkpoint this one chains to must be as it was signed.
      if (!prev.checkpoint_hash.equals(sha256(Buffer.from(statement(prev), "utf8")))) return { scope, stream, refused: `checkpoint ${prev.n} was changed after it was signed` };
      if (prev.key_id === k.kid && !edVerify(null, Buffer.from(statement(prev), "utf8"), publicKeyObject(k.pub), prev.signature)) return { scope, stream, refused: `checkpoint ${prev.n}'s signature does not verify` };
    }
    const leaves: Buffer[] = [];
    let from: number | null = null, last: number | null = null, prevHash: Buffer | null = prev ? prev.last_hash : null;
    // The last signed entry, still there, must still give the hash that was signed.
    if (prev) for await (const e of readEntries(q, scope, stream, prev.to_seq - 1, prev.to_seq)) {
      if (!entryHash(e.prev_hash, e.parts).equals(prev.last_hash) || !e.hash.equals(prev.last_hash)) return refuse(e.seq, `it no longer gives the hash signed in checkpoint ${prev.n}: the signed entries were changed`);
    }
    for await (const e of readEntries(q, scope, stream, prev ? prev.to_seq : 0, null)) {
      if (from === null) {
        from = e.seq;
        if (prev && e.seq !== prev.to_seq + 1) return refuse(prev.to_seq + 1, `missing (the chain continues at ${e.seq})`);
        if (!prev && e.seq === 1 && !e.prev_hash.equals(ZERO)) return refuse(1, "it does not start the chain");
      } else if (e.seq !== last! + 1) return refuse(last! + 1, "missing");
      if (prevHash && !e.prev_hash.equals(prevHash)) return refuse(e.seq, "it does not continue the chain");
      const h = entryHash(e.prev_hash, e.parts);
      if (!h.equals(e.hash)) return refuse(e.seq, "its values do not give its hash: it was changed after it was written");
      leaves.push(h); prevHash = h; last = e.seq;
      if (leaves.length >= MAX_WINDOW) break;
    }
    if (from === null || last === null) return { scope, stream };
    const body = { scope, stream, n: (prev?.n ?? 0) + 1, from_seq: from, to_seq: last, entries: leaves.length, last_hash: leaves[leaves.length - 1]!,
      merkle_root: merkleRoot(leaves), prev_checkpoint: prev ? sha256(Buffer.from(statement(prev), "utf8")) : ZERO, key_id: k.kid, signed_ms: now.getTime() };
    const st = Buffer.from(statement(body), "utf8");
    const signature = edSign(null, st, k.key);
    // Another instance that signed the same window first wins; this one writes nothing.
    const wrote = await tx.query(`INSERT INTO ledger_checkpoints (scope_id, org_id, stream, n, from_seq, to_seq, entries, last_hash, merkle_root, prev_checkpoint, checkpoint_hash, key_id, signature, signed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (scope_id, stream, n) DO NOTHING RETURNING n`,
      [scope, scope === 0 ? null : scope, stream, body.n, body.from_seq, body.to_seq, body.entries, body.last_hash, body.merkle_root, body.prev_checkpoint, sha256(st), k.kid, signature, new Date(body.signed_ms)]);
    if (!wrote.length) return { scope, stream };
    return { scope, stream, n: body.n, from_seq: body.from_seq, to_seq: body.to_seq };
  }));
}

export interface LedgerTick { ran: boolean; checkpoints: number; refused: CheckpointResult[]; problem?: string }
let lastProblem: string | null = null;
/**
 * The scheduler's job (src/schedules.ts schedulerTick; every minute on a server, the cron on Vercel): every stream with
 * entries after its last checkpoint, and no checkpoint in the last audit.checkpoint_minutes (default 60), is signed.
 */
export async function checkpointTick(now = new Date(), opts: { force?: boolean } = {}): Promise<LedgerTick> {
  if (!signOn()) return { ran: false, checkpoints: 0, refused: [] };
  const k = loadSigningKey();
  const db = await getDb();
  const problem = "problem" in k ? k.problem : await asPlatform(() => keyReadableByDatabase(db, k));
  if (problem) {
    if (problem !== lastProblem) console.error(`ledger: nothing signed: ${problem}`);
    lastProblem = problem;
    return { ran: false, checkpoints: 0, refused: [], problem };
  }
  lastProblem = null;
  const key = k as SigningKey;
  const due = await asPlatform(() => db.query<{ scope_id: number; stream: string }>(
    `/* tenant: the checkpoint writer, every stream with new entries */ SELECT h.scope_id, h.stream FROM ledger_heads h
       LEFT JOIN LATERAL (SELECT to_seq, signed_at FROM ledger_checkpoints c WHERE c.scope_id = h.scope_id AND c.stream = h.stream ORDER BY n DESC LIMIT 1) c ON true
      WHERE h.last_seq > coalesce(c.to_seq, 0) AND (h.scope_id = 0 OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = h.scope_id))
        AND ($1 OR c.signed_at IS NULL OR c.signed_at <= $2::timestamptz - make_interval(mins => $3))
      ORDER BY h.scope_id, h.stream LIMIT 200`, [!!opts.force, now.toISOString(), checkpointMinutes()]));
  let written = 0;
  const refused: CheckpointResult[] = [];
  for (const d of due) {
    // Catch up a long stream window by window (each at most MAX_WINDOW entries), at most 20 a tick.
    for (let round = 0; round < 20; round++) {
      const r: CheckpointResult = await checkpointStream(Number(d.scope_id), d.stream, key, now).catch((e) => ({ scope: Number(d.scope_id), stream: d.stream, refused: `could not write: ${(e as Error).message.slice(0, 200)}` }));
      if (r.refused) { refused.push(r); console.error(`ledger: checkpoint of ${r.stream} (scope ${r.scope}) refused: ${r.refused}`); break; }
      if (!r.n) break;
      written++;
      if (r.to_seq! - r.from_seq! + 1 < MAX_WINDOW) break;
    }
  }
  return { ran: true, checkpoints: written, refused };
}

// ---------------------------------------------------------------- a workspace's verification

/** The streams of one workspace: its trails that are on and hold entries, and its chained areas. */
async function workspaceStreams(): Promise<string[]> {
  const s = auditSettings();
  const { recordAreas } = await import("./record-areas.js");
  return [...(s.data ? ["data"] : []), ...(s.platform ? ["platform"] : []),
    ...recordAreas().filter((a) => a.chain === true && a.scope === "workspace").map((a) => recordStream(a.pack, a.name))];
}
/** The workspace's own verification, as its owners ask for it (under row-level security: only its rows are read). */
export async function verifyWorkspace(orgId: number, only?: string | null): Promise<{ ok: boolean; streams: StreamReport[]; keys: string[] }> {
  const pubs = publishedKeys();
  const ring = pubs.length ? keyRing(pubs.map((p) => Buffer.from(p.public_key_hex, "hex"))) : null;
  const streams = (await workspaceStreams()).filter((s) => !only || s === only || (only === "records" && s.startsWith("records:")));
  const out: StreamReport[] = [];
  for (const stream of streams) out.push(await withTenant(orgId, async () => verifyStream(runOn(await getDb()), orgId, stream, ring)));
  return { ok: out.every((r) => r.ok), streams: out, keys: pubs.map((p) => p.kid) };
}
const summary = (r: { ok: boolean; streams: StreamReport[] }) => r.streams.length
  ? r.streams.map((s) => `${s.stream}: ${s.ok ? `ok, ${s.entries} entr${s.entries === 1 ? "y" : "ies"}, ${s.checkpoints} checkpoint(s), signed through ${s.signed_through ?? "none yet"}` : `BAD at ${s.first_bad_seq}: ${s.reason}`}`).join("\n")
  : "Nothing to verify: no trail or chained area holds entries here.";

// ---------------------------------------------------------------- HTTP and MCP

const isOwner = (s: { accountRole?: string | null } | undefined) => s?.accountRole === "owner";
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

/** /api/ledger (a workspace's owners), when audit.sign is on: GET /verify[?stream=data|platform|records|records:<pack>/<area>]. */
export function ledgerAppRouter(customerSession: RequestHandler): Router {
  const r = express.Router();
  if (!signOn()) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.use((_req, res, next) => (isOwner(res.locals.session) ? next() : void res.status(403).json({ error: "Only the workspace's owners verify its access log.", code: "owners_only" })));
  r.get("/verify", wrap(async (req, res) => {
    const only = typeof req.query.stream === "string" ? req.query.stream : null;
    const out = await verifyWorkspace((res.locals.session as { org: number }).org, only);
    res.json({ ...out, summary: summary(out) });
  }));
  return r;
}
/** GET /.well-known/ledger-keys.json: the public keys checkpoints are signed with (current and retired). */
export function ledgerKeysRoute(app: express.Express) {
  if (!signOn()) return;
  app.get("/.well-known/ledger-keys.json", (_req, res) => void res.set({ "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" })
    .json({ format: "ledger-keys/v1", alg: "Ed25519", statement: "ledger-checkpoint/v1", keys: publishedKeys() }));
}
/** The customer MCP's verify tool (src/shell-tools.ts AUDIT_TOOL_NAMES): with audit.sign on, for the workspace's owners. */
export function registerLedgerTools(server: McpServer, org: Org) {
  if (!signOn()) return;
  if (!(org.role === "owner" || (!org.userId && !org.role && !org.staff))) return;
  server.registerTool("verify_audit_trail", {
    title: "Verify the access log",
    description: "Check this workspace's access log has not been changed: every entry's hash recomputed and linked to the one before, every signed checkpoint's signature and Merkle root. Returns ok, or the first bad sequence number and why. Workspace owners only.",
    inputSchema: { stream: z.string().max(120).optional().describe("Only this stream: data, platform, records, or records:<pack>/<area>") },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const out = await verifyWorkspace(org.orgId, a.stream ?? null);
    return { content: [{ type: "text", text: `${out.ok ? "OK" : "NOT OK"}.\n${summary(out)}\n\n${JSON.stringify(out)}` }], structuredContent: out };
  });
}
