/**
 * What a pack declares for record files and document previews (mold_v0-220; src/record-files.ts, src/document-fetch.ts).
 * Pure: zod only, so src/pack-api.ts (definePack), src/pack-manifest.ts (pack.json) and the build read the same rules.
 *
 *   a field   { "name": "attachments", "label": "Attachments", "type": "file", "multiple": true }
 *             a file field's value is a reference: a path in the workspace store's files ({path, name?, sha256?, size?},
 *             mold_v0-057), or a stored file ({object, name, size, content_type, sha256}): an object the shell keeps for
 *             the record, sealed with the workspace's data key (a workspace area only). Never inlined: lists, exports and
 *             MCP answers carry the reference, the console's lists its name and count; the bytes are read one file at a
 *             time, from the record's card, by people who may read the area.
 *   preview   { "name": "url", "label": "Official text", "type": "text", "preview": "document" }: the text is a URL whose
 *             document the record's card previews, fetched through the pack's `documents.hosts` only.
 *   documents { "hosts": ["rbi.org.in", "*.sebi.gov.in"], "max_bytes": 20971520, "refresh_days": 30 }
 */
import { z } from "zod";

/** A stored file's id: what a reference names; the object's key is derived from it, the workspace and the area. */
export const FILE_OBJECT = /^rf_[0-9a-f]{32}$/;
/** A stored file's reference, as a file field holds it. */
export interface StoredFileRef { object: string; name: string; size: number; content_type: string; sha256: string }
export const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,126}$/;

/** Whether `v` is a stored file's reference (the shape only: whether it opens is checked on read). */
export function isStoredFileRef(v: unknown): v is StoredFileRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["object", "name", "size", "content_type", "sha256"].includes(k))) return false;
  return typeof o.object === "string" && FILE_OBJECT.test(o.object)
    && typeof o.name === "string" && o.name.length >= 1 && o.name.length <= 200 && !/[\u0000-\u001f/\\]/.test(o.name)
    && Number.isSafeInteger(o.size) && (o.size as number) >= 0
    && typeof o.content_type === "string" && CONTENT_TYPE.test(o.content_type)
    && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256);
}

/** A file reference's name, as lists and exports show it (never its bytes, never its object). */
export function fileRefName(v: unknown): string {
  if (!v || typeof v !== "object") return String(v ?? "");
  const o = v as { name?: unknown; path?: unknown };
  return typeof o.name === "string" && o.name ? o.name : typeof o.path === "string" ? o.path : "";
}

const host = z.string().regex(/^(\*\.)?(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "a host name (HTTPS on port 443; a host allows its subdomains too)");
export const DocumentsSchema = z.object({
  $comment: z.string().max(2000).optional(),
  /** The hosts documents may be fetched from (a host allows its subdomains; "*.x" is x and its subdomains). */
  hosts: z.array(host).min(1).max(100),
  /** The largest document kept (default 20 MiB, at most 25 MiB). */
  max_bytes: z.number().int().min(1024).max(25 * 1024 * 1024).default(20 * 1024 * 1024),
  /** How long a fetched copy is kept before it is fetched again (default 30 days). */
  refresh_days: z.number().int().min(1).max(365).default(30),
}).strict();
export type DocumentsConfig = z.output<typeof DocumentsSchema>;

interface AreaLike { name: string; fields: readonly { name: string; type?: string; preview?: string; encrypted?: boolean }[] }
/** The problems of a pack's document previews against its own areas; [] when it is good. */
export function documentProblems(pack: string, documents: unknown, areas: readonly AreaLike[]): string[] {
  const out: string[] = [];
  const previews = areas.flatMap((a) => a.fields.filter((f) => f.preview === "document").map((f) => `${a.name}.${f.name}`));
  if (documents !== undefined) {
    const r = DocumentsSchema.safeParse(documents);
    if (!r.success) out.push(...r.error.issues.map((i) => `pack ${pack}: documents${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`));
  }
  if (previews.length && documents === undefined) out.push(`pack ${pack}: ${previews.join(", ")} preview${previews.length === 1 ? "s" : ""} documents: declare documents.hosts, the hosts they may be fetched from`);
  return out;
}
