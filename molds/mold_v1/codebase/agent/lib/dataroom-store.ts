/**
 * DataroomStore — a durable virtual filesystem over the dm.md data-room tree.
 *
 * dm.md at the repository root is the CANONICAL data model. This module is the
 * storage substrate underneath it: every artifact the agents produce (context
 * docs, signoff records, pipeline configs, ticket/interaction JSONL streams)
 * is addressed by its dm.md path, e.g.
 *
 *   {folder:accounts}/acme-bank/interactions.jsonl
 *   {folder:deliveries}/acme-bank/2026.06.3/infrastructure/inference/signoff/internal.md
 *   {folder:tickets}/bug/acme-bank/2026.06.3/tickets_TCK-1042.jsonl
 *
 * Paths are validated against the schema layer (./dataroom-schema.ts enums +
 * the dm.md folder templates below) before any I/O happens, so a typo'd or
 * traversal-y path can never land in the store.
 *
 * Backends are pluggable:
 *   - BlobDataroomBackend  — Vercel Blob (private store), selected when
 *     BLOB_READ_WRITE_TOKEN is present (same plumbing as ./artifact.ts).
 *     Append semantics use an append-object convention: each appendJsonl call
 *     writes an immutable, lexicographically ordered part object under
 *     `{path}.appends/`; read() reconstructs base + parts, list() collapses
 *     parts back onto the logical path. No read-modify-write race.
 *   - LocalDataroomBackend — plain filesystem under a gitignored `.dataroom/`
 *     directory (or $DATAROOM_DIR), selected automatically when the Blob
 *     token is absent so everything is testable without network or secrets.
 *     Appends use O_APPEND fs.appendFile, i.e. true appends.
 *
 * JSONL invariant: every write/append to a `.jsonl` path is normalized to end
 * with a newline, so appended records always start on a fresh line and lines
 * survive interleaved writers and process restarts.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { del, issueSignedToken, list as listBlobs, presignUrl, put } from "@vercel/blob";
import type { ZodType } from "zod";
import {
  dataroomDomainSchema,
  infrastructureComponentSchema,
  signoffRoleSchema,
  ticketFolderSchema,
  type DataroomDomain,
  type JsonValue,
} from "./dataroom-schema.ts";
import { FOLDER } from "./dataroom-folders.ts";
import { DataroomFoldersNotPinnedError, UNPINNED_FORMER_FOLDERS, findStranded } from "./dataroom-folder-guard.ts";
import { EXTRA_DATAROOM_PATH_TEMPLATES } from "./subagent-registry.generated.ts";
import { isListedPath, requireWorkspace, workspaceBlobPrefix, workspaceDir } from "../../lib/dataroom-keyspace.ts";

// ---------------------------------------------------------------------------
// Path grammar — the dm.md tree as validated templates
// ---------------------------------------------------------------------------

export class DataroomPathError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`invalid data-room path "${path}": ${reason}`);
    this.name = "DataroomPathError";
    this.path = path;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enumAlternation(values: readonly string[]): string {
  return `(?:${values.map(escapeRegExp).join("|")})`;
}

/** Same slug shape as dataroom-schema.ts (folder-addressable IDs). */
const SLUG_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]*";

/**
 * `{token}` placeholders usable inside path templates. ID tokens share the
 * schema layer's slug shape; categorical tokens are bound to the zod enums in
 * ./dataroom-schema.ts so the path grammar and the record contracts cannot
 * drift apart.
 */
const TOKEN_PATTERNS: Record<string, string> = {
  customer_id: SLUG_PATTERN,
  platform_version_id: SLUG_PATTERN,
  platform_id: SLUG_PATTERN,
  person_id: SLUG_PATTERN,
  agent_id: SLUG_PATTERN,
  pipeline_id: SLUG_PATTERN,
  migration_id: SLUG_PATTERN,
  run_id: SLUG_PATTERN,
  id: SLUG_PATTERN,
  date: "\\d{4}-\\d{2}-\\d{2}",
  ticket_folder: enumAlternation(ticketFolderSchema.options),
  component: enumAlternation(infrastructureComponentSchema.options),
  signoff_role: enumAlternation(signoffRoleSchema.options),
  design_doc: enumAlternation([
    "tenancy",
    "organization",
    "dataplatform",
    "dataengineering",
    "agents",
    "pipeline_config",
    "integromat",
    // SLA contract: the shape of {folder:accounts}/{id}/agreements/sla.json, streamlined
    // into infra / platform / solutions tiers. See system-cron / read_customer_slas.
    "slas",
  ]),
};

/**
 * File-path templates transcribed from dm.md (the canonical data model). Each starts with its domain's STORED
 * folder, which is the deployment profile's (./dataroom-folders.ts): the tree below is the same under every profile,
 * and only the first segment's name differs.
 * `{token}` segments match per TOKEN_PATTERNS; a trailing `**` matches any
 * non-empty file subtree (free-form folders like agreements/, recipe/ seeds,
 * helm/ variants, syncs/ landing zones).
 */
export const DATAROOM_PATH_TEMPLATES: readonly string[] = [
  // --- accounts --------------------------------------------------------------
  `${FOLDER.accounts}/Master.xlsx`,
  `${FOLDER.accounts}/{customer_id}/interactions.jsonl`,
  `${FOLDER.accounts}/{customer_id}/context.md`,
  `${FOLDER.accounts}/{customer_id}/personas.jsonl`,
  `${FOLDER.accounts}/{customer_id}/agreements/**`,
  `${FOLDER.accounts}/syncs/**`,
  // --- platform --------------------------------------------------------------
  `${FOLDER.platform}/Master.xlsx`,
  `${FOLDER.platform}/{platform_version_id}/{date}_changelog_manager.md`,
  `${FOLDER.platform}/{platform_version_id}/architecture/helm/**`,
  `${FOLDER.platform}/{platform_version_id}/architecture/diagrams/**`,
  `${FOLDER.platform}/{platform_version_id}/architecture/infrastructure/**`,
  `${FOLDER.platform}/{platform_version_id}/design_decisions/{design_doc}.schemas.json`,
  `${FOLDER.platform}/{platform_version_id}/tests/**`,
  `${FOLDER.platform}/{platform_version_id}/security/**`,
  `${FOLDER.platform}/{platform_version_id}/integromat/**`,
  `${FOLDER.platform}/syncs/**`,
  // --- deliveries ------------------------------------------------------------
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/infrastructure/{component}/customizations.tf`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/infrastructure/{component}/rationale.md`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/infrastructure/{component}/signoff/{signoff_role}.md`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/organization.json`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/dataplatform.json`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/dataengineering.approach.json`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/context.md`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/interactions.jsonl`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/codebase/**`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/credentials/**`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/agents/{agent_id}/**`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/pipelines/{pipeline_id}/pipeline_config.json`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/pipelines/{pipeline_id}/private.integromat.json`,
  `${FOLDER.deliveries}/{customer_id}/{platform_version_id}/platform/integromat.json`,
  `${FOLDER.deliveries}/syncs/**`,
  // --- solutions -------------------------------------------------------------
  `${FOLDER.solutions}/{platform_version_id}/supported.personas.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/dataplatform.schemas.json`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/run_configs.schema.json`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/recipe.md`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/recipe/**`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/evals/dataset.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/evals/benchmark.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/evals/{run_id}/run_configs.json`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/evals/{run_id}/output.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/agents/{agent_id}/evals/{run_id}/trace.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/pipeline_config.json`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/run_configs.schema.json`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/integromat.schema.json`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/migrations/{migration_id}/dataengineering.approach.json`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/migrations/{migration_id}/context.md`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/migrations/{migration_id}/interactions.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/evals/{run_id}/run_configs.json`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/evals/{run_id}/output.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/evals/{run_id}/trace.jsonl`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/background_research/{person_id}/context.md`,
  `${FOLDER.solutions}/{platform_version_id}/pipelines/{pipeline_id}/background_research/{person_id}/interaction.jsonl`,
  // --- projects --------------------------------------------------------------
  `${FOLDER.projects}/{customer_id}/migrations/{migration_id}/dataengineering.approach.json`,
  `${FOLDER.projects}/{customer_id}/migrations/{migration_id}/context.md`,
  `${FOLDER.projects}/{customer_id}/migrations/{migration_id}/interactions.jsonl`,
  `${FOLDER.projects}/{customer_id}/migrations/{migration_id}/credentials/**`,
  `${FOLDER.projects}/{customer_id}/migrations/{migration_id}/codebase/**`,
  `${FOLDER.projects}/{customer_id}/agents/{agent_id}/**`,
  `${FOLDER.projects}/{customer_id}/pipelines/{pipeline_id}/pipeline_config.json`,
  `${FOLDER.projects}/{customer_id}/pipelines/{pipeline_id}/private.integromat.json`,
  `${FOLDER.projects}/{customer_id}/integromat.json`,
  `${FOLDER.projects}/{customer_id}/evals/agents/**`,
  `${FOLDER.projects}/{customer_id}/evals/pipelines/**`,
  // --- tickets ---------------------------------------------------------------
  `${FOLDER.tickets}/{ticket_folder}/{customer_id}/{platform_id}/tickets_{id}.jsonl`,
  `${FOLDER.tickets}/syncs/**`,
  // --- people ----------------------------------------------------------------
  `${FOLDER.people}/Master.xlsx`,
  `${FOLDER.people}/{person_id}/interactions.jsonl`,
  `${FOLDER.people}/{person_id}/context.md`,
  `${FOLDER.people}/{person_id}/identity.json`,
  `${FOLDER.people}/{person_id}/roles_and_responsibilities.md`,
  `${FOLDER.people}/{person_id}/agreements/**`,
  `${FOLDER.people}/syncs/**`,
  // --- uploads ---------------------------------------------------------------
  // Files a signed-in user uploads through the chat, filed under their identity.
  `${FOLDER.uploads}/{person_id}/**`,
  // --- Contributed by subagents ---------------------------------------------
  // A subagent that keeps its own files declares their templates in its subagent.json ("dataroomPaths");
  // scripts/gen-subagent-meta.mjs validates and collects them. dm.md stays the canonical core.
  ...EXTRA_DATAROOM_PATH_TEMPLATES,
];

interface CompiledTemplate {
  template: string;
  domain: DataroomDomain;
  regex: RegExp;
}

function compileTemplate(template: string): CompiledTemplate {
  const segments = template.split("/");
  const domain = dataroomDomainSchema.parse(segments[0]);
  const pieces = segments.map((segment, index) => {
    if (segment === "**") {
      if (index !== segments.length - 1) {
        throw new Error(`template "${template}": ** is only allowed as the final segment`);
      }
      return "(?:[^/]+/)*[^/]+";
    }
    return segment
      .split(/(\{[a-z_]+\})/g)
      .map((piece) => {
        const token = /^\{([a-z_]+)\}$/.exec(piece);
        if (!token) return escapeRegExp(piece);
        const pattern = TOKEN_PATTERNS[token[1]];
        if (!pattern) throw new Error(`template "${template}": unknown token {${token[1]}}`);
        return pattern;
      })
      .join("");
  });
  return { template, domain, regex: new RegExp(`^${pieces.join("/")}$`) };
}

const COMPILED_TEMPLATES: readonly CompiledTemplate[] = DATAROOM_PATH_TEMPLATES.map(compileTemplate);

/** One path segment: no traversal, no hidden dotfiles, filesystem-safe. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

function checkSegments(path: string): string | null {
  if (path.length === 0) return "path is empty";
  if (path.includes("\\")) return "backslashes are not allowed (use forward slashes)";
  if (path.startsWith("/")) return "path must be relative to the data-room root";
  if (path.endsWith("/")) return "path must address a file, not a folder";
  for (const segment of path.split("/")) {
    if (!SAFE_SEGMENT.test(segment)) {
      return `segment "${segment}" is not a safe path segment`;
    }
  }
  return null;
}

export interface DataroomPathMatch {
  path: string;
  domain: DataroomDomain;
  /** The dm.md template that admitted this path. */
  template: string;
}

/** Match a concrete file path against the dm.md tree; null when not admitted. */
export function matchDataroomPath(path: string): DataroomPathMatch | null {
  if (checkSegments(path) !== null) return null;
  for (const { template, domain, regex } of COMPILED_TEMPLATES) {
    if (regex.test(path)) return { path, domain, template };
  }
  return null;
}

/** Validate a path against the dm.md schema layer; throws DataroomPathError. */
export function validateDataroomPath(path: string): DataroomPathMatch {
  const segmentProblem = checkSegments(path);
  if (segmentProblem !== null) throw new DataroomPathError(path, segmentProblem);
  const match = matchDataroomPath(path);
  if (!match) {
    throw new DataroomPathError(path, "does not match any dm.md data-room template");
  }
  return match;
}

export function isValidDataroomPath(path: string): boolean {
  return matchDataroomPath(path) !== null;
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export interface DataroomBackend {
  readonly kind: "local" | "vercel-blob";
  /** Full logical content of a file, or null when absent. */
  read(path: string): Promise<string | null>;
  /** Create or replace a file. */
  write(path: string, content: string): Promise<void>;
  /**
   * Logical file paths at or under `prefix` (directory-boundary semantics),
   * sorted. Empty prefix lists the whole data room.
   */
  list(prefix: string): Promise<string[]>;
  /** Durably append newline-terminated lines to a file (created on demand). */
  appendLines(path: string, lines: readonly string[]): Promise<void>;
  /**
   * A short-lived, GET-only URL for the file's RAW BYTES, when the backend can
   * mint one. Optional because only the blob backend needs it: local dev has a
   * real filesystem, so there is nothing to bridge.
   */
  downloadUrl?(path: string): Promise<string>;
  /**
   * The file's RAW BYTES, or null when absent.
   *
   * `read()` decodes UTF-8, which is correct for markdown and jsonl and
   * destructive for a png: the replacement characters it produces are not the
   * image, and nothing downstream can tell that from an image of a blank page.
   * Optional on the interface for the same reason `downloadUrl` is — a backend
   * that cannot serve bytes says so by not having it, rather than by returning
   * something that looks like bytes.
   */
  readBytes?(path: string): Promise<Uint8Array | null>;
  /**
   * Does this workspace hold ANY file under the top-level folder `name`? One cheap look (a directory, a listing
   * capped at one object), for the write guard: a data room that still has a former folder the profile stores
   * nothing under is refused before a second set of folders is started (./dataroom-folder-guard.ts).
   */
  hasFolder?(name: string): Promise<boolean>;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

// ---------------------------------------------------------------------------
// Local filesystem backend (.dataroom/) — the no-secrets default
// ---------------------------------------------------------------------------

export function defaultLocalDataroomRoot(): string {
  return process.env.DATAROOM_DIR ?? nodePath.join(process.cwd(), ".dataroom");
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class LocalDataroomBackend implements DataroomBackend {
  readonly kind = "local" as const;
  readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = nodePath.resolve(rootDir ?? defaultLocalDataroomRoot());
  }

  private absolute(path: string): string {
    const abs = nodePath.resolve(this.rootDir, ...path.split("/"));
    // Belt-and-braces: path validation already forbids traversal segments.
    if (abs !== this.rootDir && !abs.startsWith(this.rootDir + nodePath.sep)) {
      throw new DataroomPathError(path, "escapes the data-room root");
    }
    return abs;
  }

  async read(path: string): Promise<string | null> {
    try {
      return await fs.readFile(this.absolute(path), "utf8");
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      // Through `absolute()`, so the raw-byte read goes past the SAME root check
      // as every text read. A second reader with its own path arithmetic is how
      // one of two doors ends up missing a guard the other has.
      return new Uint8Array(await fs.readFile(this.absolute(path)));
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const abs = this.absolute(path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    // Atomic replace: write a sibling temp file, then rename over the target,
    // so readers never observe a torn file.
    const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  }

  async list(prefix: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.rootDir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const abs = nodePath.join(entry.parentPath, entry.name);
      const rel = nodePath.relative(this.rootDir, abs).split(nodePath.sep).join("/");
      // Never a snapshot, never a nested `orgs/` tree (lib/dataroom-keyspace.ts isListedPath).
      if (isListedPath(rel) && underPrefix(rel, prefix)) paths.push(rel);
    }
    return paths.sort();
  }

  async appendLines(path: string, lines: readonly string[]): Promise<void> {
    const abs = this.absolute(path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    // True append: O_APPEND, no read-modify-write of existing content.
    await fs.appendFile(abs, ensureTrailingNewline(lines.join("\n")), "utf8");
  }

  async hasFolder(name: string): Promise<boolean> {
    try {
      return (await fs.readdir(this.absolute(name))).length > 0;
    } catch (error) {
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Vercel Blob backend — production, reuses artifact.ts token plumbing
// ---------------------------------------------------------------------------

/** Marker directory holding immutable append parts for one logical file. */
const APPENDS_MARKER = ".appends/";
/** How long a presigned internal GET stays valid — just long enough to fetch. */
const READ_LINK_TTL_MS = 5 * 60 * 1000;

export interface BlobDataroomBackendOptions {
  /** Defaults to process.env.BLOB_READ_WRITE_TOKEN. */
  token?: string;
  /** Object-key prefix inside the blob store — a workspace's `dataroom/orgs/<id>`. Required. */
  storePrefix?: string;
}

export class BlobDataroomBackend implements DataroomBackend {
  readonly kind = "vercel-blob" as const;
  private readonly token: string;
  private readonly storePrefix: string;
  /** Keeps same-millisecond appends from one process in order. */
  private appendSequence = 0;

  constructor(options: BlobDataroomBackendOptions = {}) {
    const token = options.token ?? process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new Error(
        "BlobDataroomBackend requires BLOB_READ_WRITE_TOKEN (the same private Vercel Blob store used by publish_artifact).",
      );
    }
    this.token = token;
    // No default: the prefix IS the workspace (lib/dataroom-keyspace.ts). A backend built without one used to be
    // the whole store's root, which contains every workspace's tree.
    if (!options.storePrefix) throw new Error("BlobDataroomBackend requires a storePrefix (a workspace's: workspaceBlobPrefix(orgId)).");
    this.storePrefix = options.storePrefix.replace(/\/+$/, "");
  }

  private objectPathname(path: string): string {
    return `${this.storePrefix}/${path}`;
  }

  /**
   * A short-lived URL the SANDBOX can fetch.
   *
   * `read()` returns text, which is fine for markdown and jsonl and useless for
   * a spreadsheet: an .xlsx is a zip, and text() mangles it into replacement
   * characters. The agent could see the file existed, could not obtain its
   * bytes, and looped — reading it, looking for it on the sandbox filesystem,
   * listing the directory, reading it again — for half an hour, saying "let me
   * bridge the data room file into the bash sandbox" with no bridge to use.
   *
   * This is the bridge. Presigned, expiring, and GET-only, so handing it to a
   * sandbox command grants nothing beyond that one object for a few minutes.
   */
  async downloadUrl(path: string): Promise<string> {
    const pathname = this.objectPathname(path);
    const validUntil = Date.now() + READ_LINK_TTL_MS;
    const signed = await issueSignedToken({
      token: this.token,
      pathname,
      operations: ["get"],
      validUntil,
    });
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
      { operation: "get", pathname, access: "private", validUntil: signed.validUntil },
    );
    return presignedUrl;
  }

  /** Fetch one private blob's text via a short-lived presigned GET; null on 404. */
  private async fetchObject(pathname: string): Promise<string | null> {
    const validUntil = Date.now() + READ_LINK_TTL_MS;
    const signed = await issueSignedToken({
      token: this.token,
      pathname,
      operations: ["get"],
      validUntil,
    });
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
      { operation: "get", pathname, access: "private", validUntil: signed.validUntil },
    );
    const response = await fetch(presignedUrl);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`blob read failed for "${pathname}": HTTP ${response.status}`);
    }
    return await response.text();
  }

  /**
   * One private blob's RAW BYTES via the same short-lived presigned GET; null on 404.
   *
   * No append-part assembly, unlike `read()`. A binary is always written whole
   * (`appendJsonl` refuses a non-`.jsonl` path), so there are no parts to
   * concatenate — and concatenating them onto a png would corrupt it silently.
   */
  async readBytes(path: string): Promise<Uint8Array | null> {
    const pathname = this.objectPathname(path);
    const response = await fetch(await this.downloadUrl(path));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`blob read failed for "${pathname}": HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async listObjectPathnames(rawPrefix: string): Promise<string[]> {
    const pathnames: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listBlobs({ token: this.token, prefix: rawPrefix, cursor, limit: 1000 });
      for (const blob of page.blobs) pathnames.push(blob.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return pathnames;
  }

  /** Append-part object pathnames for one logical file, in append order. */
  private async listPartPathnames(objectPathname: string): Promise<string[]> {
    const parts = await this.listObjectPathnames(`${objectPathname}${APPENDS_MARKER}`);
    return parts.sort();
  }

  async read(path: string): Promise<string | null> {
    const objectPathname = this.objectPathname(path);
    const [base, partPathnames] = await Promise.all([
      this.fetchObject(objectPathname),
      this.listPartPathnames(objectPathname),
    ]);
    if (partPathnames.length === 0) return base;
    const pieces: string[] = base === null ? [] : [ensureTrailingNewline(base)];
    for (const partPathname of partPathnames) {
      const part = await this.fetchObject(partPathname);
      if (part !== null) pieces.push(ensureTrailingNewline(part));
    }
    if (pieces.length === 0) return null;
    return pieces.join("");
  }

  async write(path: string, content: string): Promise<void> {
    const objectPathname = this.objectPathname(path);
    await put(objectPathname, content, {
      access: "private",
      token: this.token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: contentTypeForPath(path),
    });
    // write() replaces the whole logical file, so retire any append parts —
    // otherwise a later read() would resurrect pre-overwrite lines.
    const staleParts = await this.listPartPathnames(objectPathname);
    if (staleParts.length > 0) await del(staleParts, { token: this.token });
  }

  async list(prefix: string): Promise<string[]> {
    const rawPrefix = prefix === "" ? `${this.storePrefix}/` : `${this.storePrefix}/${prefix}`;
    const logical = new Set<string>();
    for (const pathname of await this.listObjectPathnames(rawPrefix)) {
      let rel = pathname.slice(this.storePrefix.length + 1);
      // Collapse append-part objects onto their logical file path.
      const marker = rel.indexOf(APPENDS_MARKER);
      if (marker !== -1) rel = rel.slice(0, marker);
      if (isListedPath(rel) && underPrefix(rel, prefix)) logical.add(rel);
    }
    return [...logical].sort();
  }

  async hasFolder(name: string): Promise<boolean> {
    const page = await listBlobs({ token: this.token, prefix: `${this.storePrefix}/${name}/`, limit: 1 });
    return page.blobs.length > 0;
  }

  async appendLines(path: string, lines: readonly string[]): Promise<void> {
    // Append-object convention: never read-modify-write the base object.
    // Each append lands as its own immutable part whose key sorts by time,
    // so concurrent appenders cannot clobber each other's lines.
    const stamp = String(Date.now()).padStart(14, "0");
    const sequence = String(this.appendSequence++).padStart(6, "0");
    const nonce = randomBytes(4).toString("hex");
    const partPathname = `${this.objectPathname(path)}${APPENDS_MARKER}${stamp}-${sequence}-${nonce}.part`;
    await put(partPathname, ensureTrailingNewline(lines.join("\n")), {
      access: "private",
      token: this.token,
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: contentTypeForPath(path),
    });
  }
}

function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jsonl":
    case "part":
      return "application/x-ndjson";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown; charset=utf-8";
    case "tf":
      return "text/plain; charset=utf-8";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

// ---------------------------------------------------------------------------
// The store facade
// ---------------------------------------------------------------------------

function assertJsonlPath(path: string): void {
  if (!path.endsWith(".jsonl")) {
    throw new DataroomPathError(path, "JSONL operations require a .jsonl path");
  }
}

function normalizeListPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  if (trimmed === "") return "";
  const problem = checkSegments(trimmed);
  if (problem !== null) throw new DataroomPathError(prefix, problem);
  return trimmed;
}

export class DataroomStore {
  readonly backend: DataroomBackend;
  /** The workspace this store is for, when it is one's (named in the write guard's refusal). */
  private readonly workspace: string | undefined;
  private folderCheck: Promise<void> | undefined;

  constructor(backend: DataroomBackend, workspace?: string) {
    this.backend = backend;
    this.workspace = workspace;
  }

  /**
   * Before the first write through this store: refuse when the data room still holds a former folder this build's
   * profile stores nothing under (./dataroom-folder-guard.ts). Looked at once per store, so once per workspace per
   * process; not at all when the profile pins every former name, which is every deployment that predates the
   * setting. A look that fails (the store unreachable) is not remembered.
   */
  private guardWrite(): Promise<void> {
    if (UNPINNED_FORMER_FOLDERS.length === 0 || !this.backend.hasFolder) return Promise.resolve();
    if (!this.folderCheck) {
      const where = this.workspace ? `The data room of workspace "${this.workspace}"` : "This data room";
      const check = findStranded((name) => this.backend.hasFolder!(name)).then((stranded) => {
        if (stranded.length) throw new DataroomFoldersNotPinnedError(where, stranded);
      });
      this.folderCheck = check;
      check.catch((error) => {
        if (!(error instanceof DataroomFoldersNotPinnedError) && this.folderCheck === check) this.folderCheck = undefined;
      });
    }
    return this.folderCheck;
  }
  /** See DataroomBackend.downloadUrl — null when the backend cannot mint one. */
  async downloadUrl(path: string): Promise<string | null> {
    return this.backend.downloadUrl ? await this.backend.downloadUrl(path) : null;
  }


  /** Full logical content of a dm.md file (base + any append parts), or null. */
  async read(path: string): Promise<string | null> {
    validateDataroomPath(path);
    return this.backend.read(path);
  }

  /**
   * Raw bytes of a dm.md file (images, pdfs), or null when it does not exist.
   *
   * `validateDataroomPath` FIRST and unconditionally, exactly as `read()` does:
   * this is a second way into the same tree, and the reason a store instance is
   * per-workspace is that the instance — not the caller — decides which tree the
   * path is resolved against. A byte reader that skipped the template check
   * would accept paths the text reader refuses, which is a wider door reached by
   * changing one argument.
   */
  async readBytes(path: string): Promise<Uint8Array | null> {
    validateDataroomPath(path);
    if (!this.backend.readBytes) return null;
    return this.backend.readBytes(path);
  }

  /** Parse a .jsonl file into records; [] when the file does not exist yet. */
  async readJsonl(path: string): Promise<JsonValue[]> {
    assertJsonlPath(path);
    const content = await this.read(path);
    if (content === null) return [];
    const records: JsonValue[] = [];
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (line === "") continue;
      try {
        records.push(JSON.parse(line) as JsonValue);
      } catch {
        throw new Error(`"${path}" line ${index + 1} is not valid JSON: ${line.slice(0, 120)}`);
      }
    }
    return records;
  }

  /** Create or replace a dm.md file. `.jsonl` content is newline-normalized. */
  async write(path: string, content: string): Promise<void> {
    validateDataroomPath(path);
    await this.guardWrite();
    const body = path.endsWith(".jsonl") ? ensureTrailingNewline(content) : content;
    await this.backend.write(path, body);
  }

  /**
   * Logical file paths at or under `prefix` (directory-boundary semantics:
   * "{folder:accounts}/acme" does NOT match "{folder:accounts}/acme-bank/..."). Empty prefix
   * lists the whole data room.
   */
  async list(prefix = ""): Promise<string[]> {
    return this.backend.list(normalizeListPrefix(prefix));
  }

  /**
   * Durably append one record (or an array of records) to a .jsonl file,
   * creating it on demand. Records are serialized one-per-line; pass a zod
   * `schema` (e.g. interactionSchema, ticketSchema, evalDatasetRecordSchema)
   * to validate each record before anything is written. Returns the number
   * of records appended. Appends are true appends: previously stored lines
   * are never rewritten.
   */
  async appendJsonl(path: string, records: unknown, schema?: ZodType): Promise<number> {
    assertJsonlPath(path);
    validateDataroomPath(path);
    const items = Array.isArray(records) ? records : [records];
    if (items.length === 0) return 0;
    const lines = items.map((item, index) => {
      const value = schema ? schema.parse(item) : item;
      const line = JSON.stringify(value);
      if (line === undefined) {
        throw new TypeError(`appendJsonl("${path}"): record ${index} is not JSON-serializable`);
      }
      return line;
    });
    await this.guardWrite();
    await this.backend.appendLines(path, lines);
    return lines.length;
  }
}

// ---------------------------------------------------------------------------
// Construction + automatic backend selection
// ---------------------------------------------------------------------------

export interface CreateDataroomStoreOptions {
  /** Fully custom backend; wins over everything else. */
  backend?: DataroomBackend;
  /** Blob token override (defaults to process.env.BLOB_READ_WRITE_TOKEN). */
  blobToken?: string;
  /** Local root override (defaults to $DATAROOM_DIR, then ./.dataroom). The workspace's tree is `orgs/<id>` under it. */
  localRootDir?: string;
  /**
   * WHICH WORKSPACE'S DATA ROOM. Required: every workspace, the first one included, lives under its own
   * `orgs/<org_id>/` prefix, and there is no default. It used to be optional, and "none" meant the ROOT — which is
   * where workspace #1 lived and which contains every other workspace's `orgs/<id>/` tree, so a caller that lost its
   * workspace on the way read and listed everybody's files. See lib/dataroom-keyspace.ts.
   */
  orgId?: string | null;
}

/**
 * The local-filesystem root for a workspace: `<base>/orgs/<id>` (mirror of the Blob layout). The same nesting the
 * blob driver had: the legacy workspace was `<base>` itself, and `<base>` contains `orgs/`.
 */
function localRootForOrg(base: string, orgId: string): string {
  return nodePath.join(base, ...workspaceDir(orgId).split("/"));
}

/**
 * Local-filesystem store rooted EXACTLY at `rootDir` — no workspace layer. For tests and fixtures that own a scratch
 * directory; application code goes through {@link createDataroomStore} / {@link getDataroomStore} with a workspace.
 */
export function createLocalDataroomStore(rootDir?: string): DataroomStore {
  return new DataroomStore(new LocalDataroomBackend(rootDir));
}

/** Vercel Blob store for one workspace (throws without a token or a workspace). */
export function createBlobDataroomStore(options: BlobDataroomBackendOptions & { orgId: string }): DataroomStore {
  return new DataroomStore(new BlobDataroomBackend({ ...options, storePrefix: workspaceBlobPrefix(options.orgId) }), options.orgId);
}

/**
 * Build ONE WORKSPACE's store, picking the backend automatically: Vercel Blob when a BLOB_READ_WRITE_TOKEN is
 * available (production — same plumbing as artifact.ts), the local `.dataroom/orgs/<id>/` filesystem otherwise
 * (dev/tests). Throws when no workspace is named (lib/dataroom-keyspace.ts requireWorkspace).
 */
export function createDataroomStore(options: CreateDataroomStoreOptions = {}): DataroomStore {
  if (options.backend) return new DataroomStore(options.backend);
  const orgId = requireWorkspace(options.orgId);
  const token = options.blobToken ?? process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    return new DataroomStore(new BlobDataroomBackend({ token, storePrefix: workspaceBlobPrefix(orgId) }), orgId);
  }
  const base = options.localRootDir ?? defaultLocalDataroomRoot();
  return new DataroomStore(new LocalDataroomBackend(localRootForOrg(base, orgId)), orgId);
}

/** One cached store per workspace. */
const storeByOrg = new Map<string, DataroomStore>();

/**
 * Process-wide shared store for ONE workspace, with automatic backend selection (cached per workspace). The
 * workspace is required — `getDataroomStore()` with no argument used to return workspace #1's legacy-root store,
 * which listed every workspace's files; it now throws, like every other door without a workspace.
 */
export function getDataroomStore(orgId: string | null | undefined): DataroomStore {
  const key = requireWorkspace(orgId);
  let store = storeByOrg.get(key);
  if (!store) {
    store = createDataroomStore({ orgId: key });
    storeByOrg.set(key, store);
  }
  return store;
}
