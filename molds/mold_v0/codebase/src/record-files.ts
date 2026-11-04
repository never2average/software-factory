/**
 * Record files and document cards (mold_v0-220): the files a record holds (a `file` field's stored files) and the
 * documents its URL fields point at (a field with `preview: "document"`), each shown on the record's card with its name,
 * type and size, a Download and, where the type has one, an inline preview.
 *
 *   stored     storeRecordFile(orgId, area, key, {name, content_type, data}) seals the bytes with the workspace's data
 *              key (src/orgcrypto.ts sealBytes, the store the mail intake and the workspace store use) under
 *              workspaces/org-<id>/.records/<area>/<object>.wse, the additional data binding it to its workspace, pack,
 *              area, record key, object and sha256: a reference copied into another record, area or workspace does not
 *              open. The field holds {object, name, size, content_type, sha256}; a workspace area only. The objects go
 *              with the workspace (src/tenancy.ts removes its prefix).
 *   documents  a URL field with `preview: "document"` (src/document-fetch.ts): fetched through the pack's
 *              documents.hosts and cached (a shared area's under documents/shared/, a workspace area's sealed under the
 *              workspace's prefix), served as a card like a stored file.
 *   never      in a list, an export, an MCP answer or a log line: those carry the reference (the console's lists the
 *              name and count). Bytes are read one file at a time, here.
 *   who        the area's read permission (src/record-areas.ts getFor, as the record itself), the record must exist for
 *              the caller; a withheld get answers 404 (src/record-routes.ts). Bytes are served only at a signed,
 *              short-lived link (10 minutes) bound to the person and the file, on the console's own origin, with the
 *              caller's session too: a link copied to someone else, or kept, opens nothing.
 *   previews   PDF (its bytes start %PDF-) inline for the browser's own viewer; PNG, JPEG, GIF and WebP (by their bytes);
 *              plain text (as text); HTML (an email's body, a fetched page) only through src/html-sanitise.ts, in a
 *              sandboxed frame whose policy runs no script and loads no remote image unless the reader asks
 *              (`images=1`); anything else (docx, xlsx ...) download only, said so on the card. A download is always
 *              application/octet-stream as an attachment, with a policy that would run nothing.
 *   trail      when the app's data trail is on (mold_v0-197): a preview is a `read` of target `file`, a download an
 *              `export`, each with the record's key and the file's place (never its name or bytes). A shared area's
 *              document is no workspace's data: no entry.
 *
 * Gated by the features registry's `document_preview` flag (mold_v0-219, src/features.json; default on, asked for by a
 * file field or a field previewing its document): off, the card routes answer not found and the console shows no card.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { auditData, auditQuiet } from "./audit-trail.js";
import { derivedKey, vaultUnlocked } from "./keyvault.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { PackError } from "./pack-api.js";
import { packs } from "./packs.js";
import { areaOrThrow, checkKey, getFor, getPlatform, type Actor, type RecordArea } from "./record-areas.js";
import { CONTENT_TYPE, DocumentsSchema, isStoredFileRef, type DocumentsConfig, type StoredFileRef } from "./record-files-config.js";
import { DocumentFetchError, checkDocumentUrl, fetchDocument, sniff } from "./document-fetch.js";
import { documentOf, htmlPolicy, sanitiseHtml } from "./html-sanitise.js";
import { objectStore } from "./storage.js";
import { asPlatform } from "./tenant-scope.js";
import { featureOn } from "./features.js";

export const RECORD_FILE_MAX = 25 * 1024 * 1024;
const TEXT_PREVIEW_MAX = 1024 * 1024;
const LINK_SECONDS = 600;
const FAILED_RETRY_MS = 3_600_000;

// ---------- stored files ----------

const objectKey = (orgId: number, area: string, object: string) => `workspaces/org-${Math.trunc(orgId)}/.records/${area}/${object}.wse`;
const aad = (orgId: number, pack: string, area: string, recordKey: string, ref: Pick<StoredFileRef, "object" | "sha256">) =>
  `record-file:v1:org-${orgId}:${pack}:${area}:${recordKey}:${ref.object}:${ref.sha256}`;
/** A file name safe to store and show: no directory, no control character, at most 200 characters. */
export const cleanFileName = (name: string, fallback = "file") =>
  String(name ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_").replace(/^\.+/, "").trim().slice(0, 200) || fallback;

/** The type a stored file is kept as: what its bytes are when they say (PDF, the images), else its declared type. */
export function storedType(data: Buffer, declared: string): string {
  const t = declared.split(";")[0]!.trim().toLowerCase();
  const s = sniff(data, "");
  if (s) return s;
  return CONTENT_TYPE.test(t) && !["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(t) ? t : "application/octet-stream";
}

/**
 * Keep one file for a record of a workspace area: sealed with the workspace's data key, bound to the record. Returns the
 * reference its file field holds. The record need not exist yet (the mail intake keeps the files, then writes it).
 */
export async function storeRecordFile(orgId: number, area: RecordArea, recordKey: string, file: { name: string; content_type: string; data: Buffer }): Promise<StoredFileRef> {
  if (area.scope !== "workspace") throw new PackError(`area ${area.name} is shared: files are kept for a workspace's own records`, 400);
  checkKey(recordKey);
  if (file.data.length > RECORD_FILE_MAX) throw new PackError(`a record's file is at most ${RECORD_FILE_MAX} bytes`, 413);
  const ref: StoredFileRef = {
    object: `rf_${randomBytes(16).toString("hex")}`, name: cleanFileName(file.name), size: file.data.length,
    content_type: storedType(file.data, file.content_type), sha256: createHash("sha256").update(file.data).digest("hex"),
  };
  const sealed = await asPlatform(() => sealBytes(orgId, file.data, aad(orgId, area.pack, area.name, recordKey, ref)));
  await (await objectStore()).put(objectKey(orgId, area.name, ref.object), sealed, "application/octet-stream");
  return ref;
}
/** Remove stored files (a write that failed after keeping them). */
export async function removeRecordFiles(orgId: number, area: string, refs: StoredFileRef[]): Promise<void> {
  if (refs.length) await (await objectStore()).remove(refs.map((r) => objectKey(orgId, area, r.object))).catch(() => null);
}
/** One stored file's bytes for its record (opened with the workspace's key, checked against its sha256). */
export async function openRecordFile(orgId: number, area: RecordArea, recordKey: string, ref: StoredFileRef): Promise<Buffer> {
  if (!vaultUnlocked()) throw new PackError("the key vault is locked: files cannot be opened now, try again later", 503);
  const sealed = await (await objectStore()).get(objectKey(orgId, area.name, ref.object));
  // Missing, or named by a reference from another record or workspace: the same answer.
  if (!sealed) throw new PackError("no such file", 404);
  let data: Buffer;
  try { data = await asPlatform(() => openBytes(orgId, sealed, aad(orgId, area.pack, area.name, recordKey, ref))); }
  catch { throw new PackError("no such file", 404); }
  if (createHash("sha256").update(data).digest("hex") !== ref.sha256) throw new PackError("no such file", 404);
  return data;
}

// ---------- documents (a URL field with preview: "document") ----------

const documentsOf = (pack: string): DocumentsConfig | null => {
  const d = packs().find((p) => p.id === pack)?.definition as { documents?: unknown } | undefined;
  const r = d?.documents === undefined ? null : DocumentsSchema.safeParse(d.documents);
  return r?.success ? r.data : null;
};
interface DocMeta { url: string; final_url?: string; content_type?: string; size?: number; sha256?: string; fetched_at: string; error?: string; kind?: string }
const docHash = (url: string) => createHash("sha256").update(url).digest("hex");
const docKeys = (orgId: number | null, url: string) => {
  const h = docHash(url);
  const base = orgId === null ? `documents/shared/${h}` : `workspaces/org-${Math.trunc(orgId)}/.documents/${h}`;
  return { meta: `${base}.json`, body: orgId === null ? `${base}.bin` : `${base}.wse`, aad: `record-document:v1:org-${orgId}:${h}` };
};
const inflight = new Map<string, Promise<DocMeta>>();

async function readMeta(orgId: number | null, url: string): Promise<DocMeta | null> {
  const raw = await (await objectStore()).get(docKeys(orgId, url).meta);
  if (!raw) return null;
  try {
    const m = JSON.parse((orgId === null ? raw : await asPlatform(() => openBytes(orgId, raw, `${docKeys(orgId, url).aad}:meta`))).toString("utf8")) as DocMeta;
    return m.url === url ? m : null;
  } catch { return null; }
}
async function writeMeta(orgId: number | null, url: string, m: DocMeta) {
  const k = docKeys(orgId, url), body = Buffer.from(JSON.stringify(m));
  await (await objectStore()).put(k.meta, orgId === null ? body : await asPlatform(() => sealBytes(orgId, body, `${k.aad}:meta`)), "application/octet-stream");
}

/** The document's cached copy, fetched when there is none or it is older than the pack's refresh_days. */
async function documentMeta(orgId: number | null, area: RecordArea, url: string): Promise<DocMeta> {
  const cfg = documentsOf(area.pack);
  if (!cfg) return { url, fetched_at: new Date().toISOString(), error: "this app declares no hosts to fetch documents from", kind: "not_allowed" };
  try { checkDocumentUrl(url, cfg.hosts); } catch (e) {
    if (e instanceof DocumentFetchError) return { url, fetched_at: new Date().toISOString(), error: e.message, kind: e.kind };
    throw e;
  }
  const have = await readMeta(orgId, url);
  const age = have ? Date.now() - Date.parse(have.fetched_at) : Infinity;
  if (have && !have.error && age < cfg.refresh_days * 86_400_000) return have;
  if (have?.error && age < FAILED_RETRY_MS) return have;
  const k = docKeys(orgId, url).meta;
  let p = inflight.get(k);
  if (!p) {
    p = (async (): Promise<DocMeta> => {
      try {
        const d = await fetchDocument(url, cfg.hosts, cfg.max_bytes);
        const keys = docKeys(orgId, url);
        await (await objectStore()).put(keys.body, orgId === null ? d.data : await asPlatform(() => sealBytes(orgId, d.data, keys.aad)), "application/octet-stream");
        const m: DocMeta = { url, final_url: d.final_url, content_type: d.content_type, size: d.data.length, sha256: d.sha256, fetched_at: d.fetched_at };
        await writeMeta(orgId, url, m);
        return m;
      } catch (e) {
        if (!(e instanceof DocumentFetchError)) throw e;
        // A refresh that failed keeps the last good copy; a first fetch that failed is remembered for an hour.
        if (have && !have.error) return have;
        const m: DocMeta = { url, fetched_at: new Date().toISOString(), error: e.message, kind: e.kind };
        await writeMeta(orgId, url, m).catch(() => null);
        return m;
      }
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
async function openDocument(orgId: number | null, url: string, m: DocMeta): Promise<Buffer> {
  const k = docKeys(orgId, url);
  const raw = await (await objectStore()).get(k.body);
  if (!raw) throw new PackError("this document's copy is missing: open the record again to fetch it", 410);
  const data = orgId === null ? raw : await asPlatform(() => openBytes(orgId, raw, k.aad));
  if (createHash("sha256").update(data).digest("hex") !== m.sha256) throw new PackError("this document's copy does not match: open the record again to fetch it", 409);
  return data;
}
/** A document's file name: the URL's last part, else its host. */
const docName = (url: string) => {
  try { const u = new URL(url); return cleanFileName(decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? ""), u.hostname); } catch { return "document"; }
};

// ---------- cards ----------

export type PreviewKind = "pdf" | "image" | "text" | "html";
/** The preview a type has (null: download only). */
export function previewOf(contentType: string): PreviewKind | null {
  const t = contentType.toLowerCase();
  if (t === "application/pdf") return "pdf";
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(t)) return "image";
  if (t === "text/html") return "html";
  if (t.startsWith("text/") || t === "application/json" || t === "message/rfc822") return "text";
  return null;
}

export interface FileCard {
  id: string; field: string; label: string; n: number; source: "file" | "document";
  name: string; size: number | null; content_type: string | null; preview: PreviewKind | null;
  /** A document's address (a URL field), and when the kept copy was fetched. */
  url?: string; fetched_at?: string;
  /** Why there is no copy (a document that could not be fetched). */
  error?: string;
  preview_url: string | null; download_url: string | null;
}
type FileSlot = { field: RecordArea["fields"][number]; n: number; ref?: StoredFileRef; url?: string };

/** The record's file slots: each stored file of its file fields (in order), each document URL of its preview fields. */
function slotsOf(area: RecordArea, data: Record<string, unknown>): FileSlot[] {
  const out: FileSlot[] = [];
  for (const f of area.fields) {
    const v = data[f.name];
    if (f.type === "file") (Array.isArray(v) ? v : v == null ? [] : [v]).forEach((x, i) => { if (isStoredFileRef(x)) out.push({ field: f, n: i + 1, ref: x }); });
    else if ((f as { preview?: string }).preview === "document" && typeof v === "string" && v.trim()) out.push({ field: f, n: 1, url: v.trim() });
  }
  return out;
}

// ---------- signed links ----------

type Who = { scope: string; person: string };
const linkMac = (who: Who, area: string, key: string, field: string, n: number, exp: number) =>
  createHmac("sha256", derivedKey("record-file-link")).update(`record-file-link/v1|${who.scope}|${who.person}|${area}|${key}|${field}|${n}|${exp}`).digest("base64url");
function link(base: string, who: Who, area: string, key: string, field: string, n: number, mode: "inline" | "download") {
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return `${base}/${area}/${encodeURIComponent(key)}/files/${field}/${n}?mode=${mode}&exp=${exp}&t=${linkMac(who, area, key, field, n, exp)}`;
}
function checkLink(req: Request, who: Who, area: string, key: string, field: string, n: number) {
  const exp = Number(req.query.exp), t = String(req.query.t ?? "");
  if (!Number.isSafeInteger(exp) || exp < Date.now() / 1000) throw new PackError("this file's link has expired: open the record again", 403);
  if (exp > Date.now() / 1000 + LINK_SECONDS + 60) throw new PackError("not a link to this file", 403);
  const want = Buffer.from(linkMac(who, area, key, field, n, exp)), got = Buffer.from(t);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new PackError("not a link to this file", 403);
}

// ---------- over HTTP (mounted by src/record-routes.ts) ----------

export interface FileDoor {
  /** The records route these links are under (/api/records or /api/admin/records). */
  base: string;
  /** The workspace whose records are read (null: staff, shared areas only). */
  org: (res: Response) => number | null;
  actor: (res: Response) => Actor;
  who: (res: Response) => Who;
  /** The area as this door may read it (staff: shared areas only). */
  area: (name: string) => RecordArea;
}

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = await fn(req, res);
    if (!res.headersSent) res.json(v);
  } catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

async function recordOf(door: FileDoor, res: Response, areaName: string, key: string) {
  const area = door.area(areaName);
  const orgId = door.org(res);
  // The record as the caller may read it (its area's read permission; a workspace's own row): its page wrote the read.
  const record = await auditQuiet(() => (orgId === null ? getPlatform(area, checkKey(key)) : getFor(orgId, area.name, checkKey(key), door.actor(res))));
  if (!record) throw new PackError("Not found", 404);
  return { area, orgId, record };
}

/** The record's file cards, for its page. */
export async function fileCards(door: FileDoor, res: Response, areaName: string, key: string): Promise<{ files: FileCard[] }> {
  const { area, orgId, record } = await recordOf(door, res, areaName, key);
  // Every link is signed with a key derived from the vault's: none while it is locked.
  if (!vaultUnlocked()) throw new PackError("the key vault is locked: files cannot be opened now, try again later", 503);
  const who = door.who(res);
  const files: FileCard[] = [];
  for (const s of slotsOf(area, record.data)) {
    const base = { id: `${s.field.name}:${s.n}`, field: s.field.name, label: s.field.label, n: s.n };
    if (s.ref) {
      const preview = previewOf(s.ref.content_type);
      files.push({ ...base, source: "file", name: s.ref.name, size: s.ref.size, content_type: s.ref.content_type, preview,
        preview_url: preview ? link(door.base, who, area.name, record.key, s.field.name, s.n, "inline") : null,
        download_url: link(door.base, who, area.name, record.key, s.field.name, s.n, "download") });
      continue;
    }
    const m = await documentMeta(area.scope === "platform" ? null : orgId, area, s.url!).catch((e: Error): DocMeta => {
      console.error(`record files: a document of ${area.name} could not be kept (${e.name})`);
      return { url: s.url!, fetched_at: new Date().toISOString(), error: "the document could not be kept here now: try again later", kind: "unreachable" };
    });
    if (m.error) { files.push({ ...base, source: "document", url: s.url, name: docName(s.url!), size: null, content_type: null, preview: null, error: m.error, fetched_at: m.fetched_at, preview_url: null, download_url: null }); continue; }
    const preview = previewOf(m.content_type!);
    files.push({ ...base, source: "document", url: s.url, name: docName(m.final_url ?? s.url!), size: m.size ?? null, content_type: m.content_type!, preview, fetched_at: m.fetched_at,
      preview_url: preview ? link(door.base, who, area.name, record.key, s.field.name, s.n, "inline") : null,
      download_url: link(door.base, who, area.name, record.key, s.field.name, s.n, "download") });
  }
  return { files };
}

/** A download's file name, as a plain ASCII name and in RFC 5987 form. */
const disposition = (kind: "inline" | "attachment", name: string) => {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
  const ext = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${ext}`;
};

/** One file's bytes: a preview (inline, by its kind) or a download, at a signed link, for the caller's session. */
export async function serveFile(door: FileDoor, req: Request, res: Response): Promise<void> {
  const areaName = String(req.params.area), key = String(req.params.key), fieldName = String(req.params.field), n = Number(req.params.n);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new PackError("Not found", 404);
  checkLink(req, door.who(res), areaName, key, fieldName, n);
  const { area, orgId, record } = await recordOf(door, res, areaName, key);
  const slot = slotsOf(area, record.data).find((s) => s.field.name === fieldName && s.n === n);
  if (!slot) throw new PackError("Not found", 404);
  const mode = req.query.mode === "download" ? "download" : "inline";
  let data: Buffer, name: string, type: string;
  if (slot.ref) {
    data = await openRecordFile(orgId!, area, record.key, slot.ref);
    name = slot.ref.name; type = slot.ref.content_type;
  } else {
    const docOrg = area.scope === "platform" ? null : orgId;
    const m = await documentMeta(docOrg, area, slot.url!);
    if (m.error) throw new PackError(m.error, 404);
    data = await openDocument(docOrg, slot.url!, m);
    name = docName(m.final_url ?? slot.url!); type = m.content_type!;
  }
  // The data trail (mold_v0-197): which record's file was previewed (read) or downloaded (export); a shared area's
  // document is nobody's workspace data.
  if (orgId !== null && area.scope === "workspace") auditData(orgId, { action: mode === "download" ? "export" : "read", target: "file", pack: area.pack, area: area.name, key: `${record.key}:${fieldName}/${n}` });
  const common = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer" };
  if (mode === "download") {
    res.set({ ...common, "Content-Type": "application/octet-stream", "Content-Disposition": disposition("attachment", name), "Content-Length": String(data.length), "Content-Security-Policy": "default-src 'none'; sandbox" });
    return void res.end(data);
  }
  const preview = previewOf(type);
  // The bytes must be what the type says before a browser is shown them.
  if (preview === "pdf" || preview === "image") {
    if (sniff(data, "") !== type) throw new PackError("This file's contents do not match its type: download it instead", 415);
    res.set({ ...common, "Content-Type": type, "Content-Disposition": disposition("inline", name), "Content-Length": String(data.length),
      "Content-Security-Policy": preview === "pdf" ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; frame-ancestors 'self'; sandbox" });
    return void res.end(data);
  }
  if (preview === "text") {
    const text = data.subarray(0, TEXT_PREVIEW_MAX).toString("utf8").replace(/\u0000/g, "");
    res.set({ ...common, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; sandbox", "X-Truncated": data.length > TEXT_PREVIEW_MAX ? "1" : "0" });
    return void res.end(text);
  }
  if (preview === "html") {
    const images = req.query.images === "1";
    const { html } = sanitiseHtml(data.toString("utf8"), { remoteImages: images ? "allow" : "block" });
    res.set({ ...common, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": htmlPolicy(images) });
    return void res.end(documentOf(html));
  }
  throw new PackError("No preview for this type: download it instead", 415);
}

/** Mount the file routes on a records router (before its /:area/:key route). */
export function mountFileRoutes(r: Router, door: FileDoor, guard: (op: "get") => (req: Request, res: Response, next: NextFunction) => void, ...before: ((req: Request, res: Response, next: NextFunction) => void)[]) {
  // The features registry's document_preview (mold_v0-219): off, these answer 404 and the console shows no card.
  const previews = (_req: Request, res: Response, next: NextFunction) =>
    (featureOn("document_preview") ? next() : void res.status(404).json({ error: "Document previews are off in this app", code: "document_preview_off" }));
  r.get("/:area/:key/files", previews, ...before, guard("get"), answer((req, res) => fileCards(door, res, String(req.params.area), String(req.params.key))));
  r.get("/:area/:key/files/:field/:n", previews, ...before, guard("get"), answer(async (req, res) => { await serveFile(door, req, res); }));
}

/** The area as a door may read it: any declared area for a workspace's people, shared areas only for staff. */
export const anyArea = (name: string) => areaOrThrow(name);
