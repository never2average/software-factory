/**
 * DataroomStore — a durable virtual filesystem over the dm.md data-room tree.
 *
 * dm.md at the repository root is the CANONICAL data model. This module is the
 * storage substrate underneath it: every artifact the agents produce (context
 * docs, signoff records, pipeline configs, ticket/interaction JSONL streams)
 * is addressed by its dm.md path, e.g.
 *
 *   Customers/acme-bank/interactions.jsonl
 *   Deployments/acme-bank/2026.06.3/infrastructure/inference/signoff/internal.md
 *   Tickets/bug/acme-bank/2026.06.3/tickets_TCK-1042.jsonl
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
    // SLA contract: the shape of Customers/{id}/agreements/sla.json, streamlined
    // into infra / platform / solutions tiers. See system-cron / read_customer_slas.
    "slas",
  ]),
};

/**
 * File-path templates transcribed from dm.md (the canonical data model).
 * `{token}` segments match per TOKEN_PATTERNS; a trailing `**` matches any
 * non-empty file subtree (free-form folders like agreements/, recipe/ seeds,
 * helm/ variants, syncs/ landing zones).
 */
export const DATAROOM_PATH_TEMPLATES: readonly string[] = [
  // --- Customers -----------------------------------------------------------
  "Customers/Master.xlsx",
  "Customers/{customer_id}/interactions.jsonl",
  "Customers/{customer_id}/context.md",
  "Customers/{customer_id}/personas.jsonl",
  "Customers/{customer_id}/agreements/**",
  // mold_fin: a covered company's SEBI LODR filings (filings/lodr/), investor presentations and
  // concalls (filings/presentations/), and the jsonl logs the research subagents keep beside them.
  "Customers/{customer_id}/filings/**",
  "Customers/syncs/**",
  // --- Platform ------------------------------------------------------------
  "Platform/Master.xlsx",
  "Platform/{platform_version_id}/{date}_changelog_manager.md",
  "Platform/{platform_version_id}/architecture/helm/**",
  "Platform/{platform_version_id}/architecture/diagrams/**",
  "Platform/{platform_version_id}/architecture/infrastructure/**",
  "Platform/{platform_version_id}/design_decisions/{design_doc}.schemas.json",
  "Platform/{platform_version_id}/tests/**",
  "Platform/{platform_version_id}/security/**",
  "Platform/{platform_version_id}/integromat/**",
  "Platform/syncs/**",
  // --- Deployments ---------------------------------------------------------
  "Deployments/{customer_id}/{platform_version_id}/infrastructure/{component}/customizations.tf",
  "Deployments/{customer_id}/{platform_version_id}/infrastructure/{component}/rationale.md",
  "Deployments/{customer_id}/{platform_version_id}/infrastructure/{component}/signoff/{signoff_role}.md",
  "Deployments/{customer_id}/{platform_version_id}/platform/organization.json",
  "Deployments/{customer_id}/{platform_version_id}/platform/dataplatform.json",
  "Deployments/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/dataengineering.approach.json",
  "Deployments/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/context.md",
  "Deployments/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/interactions.jsonl",
  "Deployments/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/codebase/**",
  "Deployments/{customer_id}/{platform_version_id}/platform/migrations/{migration_id}/credentials/**",
  "Deployments/{customer_id}/{platform_version_id}/platform/agents/{agent_id}/**",
  "Deployments/{customer_id}/{platform_version_id}/platform/pipelines/{pipeline_id}/pipeline_config.json",
  "Deployments/{customer_id}/{platform_version_id}/platform/pipelines/{pipeline_id}/private.integromat.json",
  "Deployments/{customer_id}/{platform_version_id}/platform/integromat.json",
  "Deployments/syncs/**",
  // --- Solutions -----------------------------------------------------------
  "Solutions/{platform_version_id}/supported.personas.jsonl",
  "Solutions/{platform_version_id}/agents/{agent_id}/dataplatform.schemas.json",
  "Solutions/{platform_version_id}/agents/{agent_id}/run_configs.schema.json",
  "Solutions/{platform_version_id}/agents/{agent_id}/recipe.md",
  "Solutions/{platform_version_id}/agents/{agent_id}/recipe/**",
  "Solutions/{platform_version_id}/agents/{agent_id}/evals/dataset.jsonl",
  "Solutions/{platform_version_id}/agents/{agent_id}/evals/benchmark.jsonl",
  "Solutions/{platform_version_id}/agents/{agent_id}/evals/{run_id}/run_configs.json",
  "Solutions/{platform_version_id}/agents/{agent_id}/evals/{run_id}/output.jsonl",
  "Solutions/{platform_version_id}/agents/{agent_id}/evals/{run_id}/trace.jsonl",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/pipeline_config.json",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/run_configs.schema.json",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/integromat.schema.json",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/migrations/{migration_id}/dataengineering.approach.json",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/migrations/{migration_id}/context.md",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/migrations/{migration_id}/interactions.jsonl",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/evals/{run_id}/run_configs.json",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/evals/{run_id}/output.jsonl",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/evals/{run_id}/trace.jsonl",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/background_research/{person_id}/context.md",
  "Solutions/{platform_version_id}/pipelines/{pipeline_id}/background_research/{person_id}/interaction.jsonl",
  // --- Implementation ------------------------------------------------------
  "Implementation/{customer_id}/migrations/{migration_id}/dataengineering.approach.json",
  "Implementation/{customer_id}/migrations/{migration_id}/context.md",
  "Implementation/{customer_id}/migrations/{migration_id}/interactions.jsonl",
  "Implementation/{customer_id}/migrations/{migration_id}/credentials/**",
  "Implementation/{customer_id}/migrations/{migration_id}/codebase/**",
  "Implementation/{customer_id}/agents/{agent_id}/**",
  "Implementation/{customer_id}/pipelines/{pipeline_id}/pipeline_config.json",
  "Implementation/{customer_id}/pipelines/{pipeline_id}/private.integromat.json",
  "Implementation/{customer_id}/integromat.json",
  "Implementation/{customer_id}/evals/agents/**",
  "Implementation/{customer_id}/evals/pipelines/**",
  // --- Tickets -------------------------------------------------------------
  "Tickets/{ticket_folder}/{customer_id}/{platform_id}/tickets_{id}.jsonl",
  "Tickets/syncs/**",
  // --- People --------------------------------------------------------------
  "People/Master.xlsx",
  "People/{person_id}/interactions.jsonl",
  "People/{person_id}/context.md",
  "People/{person_id}/identity.json",
  "People/{person_id}/roles_and_responsibilities.md",
  "People/{person_id}/agreements/**",
  "People/syncs/**",
  // --- Uploads -------------------------------------------------------------
  // Files a signed-in user uploads through the chat, filed under their identity.
  "Uploads/{person_id}/**",
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
      if (underPrefix(rel, prefix)) paths.push(rel);
    }
    return paths.sort();
  }

  async appendLines(path: string, lines: readonly string[]): Promise<void> {
    const abs = this.absolute(path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    // True append: O_APPEND, no read-modify-write of existing content.
    await fs.appendFile(abs, ensureTrailingNewline(lines.join("\n")), "utf8");
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
  /** Object-key prefix inside the blob store. Defaults to "dataroom". */
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
    this.storePrefix = (options.storePrefix ?? "dataroom").replace(/\/+$/, "");
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
      if (rel.length > 0 && underPrefix(rel, prefix)) logical.add(rel);
    }
    return [...logical].sort();
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

  constructor(backend: DataroomBackend) {
    this.backend = backend;
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
    const body = path.endsWith(".jsonl") ? ensureTrailingNewline(content) : content;
    await this.backend.write(path, body);
  }

  /**
   * Logical file paths at or under `prefix` (directory-boundary semantics:
   * "Customers/acme" does NOT match "Customers/acme-bank/..."). Empty prefix
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
  /** Local root override (defaults to $DATAROOM_DIR, then ./.dataroom). */
  localRootDir?: string;
  /**
   * Which workspace's data room. Org #1 (`onfinance`, the default) keeps the
   * LEGACY ROOT layout — the dm.md tree directly under the store prefix, no
   * copy — so its bytes are untouched. Every other org's tree lives under
   * `orgs/{org_id}/…` with the identical structure. See agent/lib/org-blob.ts.
   */
  orgId?: string | null;
}

/**
 * Org #1 — its data room is the legacy root (no per-org sub-prefix).
 *
 * TWO ids, and that is not tidiness. The workspace row is `org-onfinance-ai`
 * while this constant was `org-onfinance`, so the two never matched: callers
 * that resolved the real workspace id got `dataroom/orgs/org-onfinance-ai/`
 * and callers that passed nothing got `dataroom/`. Org #1's data room was
 * split across two prefixes — 223 customer files in one, every chat upload in
 * the other — and each half looked complete to whoever was reading it.
 *
 * Both ids alias to the legacy root. A new workspace is unaffected: it has
 * exactly one id and gets exactly one tree.
 */
const LEGACY_ROOT_ORGS = new Set(["org-onfinance", "org-onfinance-ai"]);
const isLegacyRootOrg = (orgId?: string | null) => !orgId || LEGACY_ROOT_ORGS.has(orgId);
/** Kept for the cache key: every alias must collapse to ONE entry. */
const LEGACY_ROOT_ORG = "org-onfinance";

/**
 * The Blob store prefix for a workspace, layered under the base "dataroom" key
 * space: onfinance → "dataroom" (unchanged), others → "dataroom/orgs/{id}".
 */
function blobStorePrefixForOrg(orgId?: string | null): string {
  return isLegacyRootOrg(orgId) ? "dataroom" : `dataroom/orgs/${orgId}`;
}

/** The local-filesystem root for a workspace (mirror of the Blob layout). */
function localRootForOrg(base: string, orgId?: string | null): string {
  return isLegacyRootOrg(orgId) ? base : nodePath.join(base, "orgs", orgId as string);
}

/** Local-filesystem store rooted at `rootDir` (default: $DATAROOM_DIR or ./.dataroom). */
export function createLocalDataroomStore(rootDir?: string): DataroomStore {
  return new DataroomStore(new LocalDataroomBackend(rootDir));
}

/** Vercel Blob store (throws without a token). */
export function createBlobDataroomStore(options: BlobDataroomBackendOptions = {}): DataroomStore {
  return new DataroomStore(new BlobDataroomBackend(options));
}

/**
 * Build a store, picking the backend automatically: Vercel Blob when a
 * BLOB_READ_WRITE_TOKEN is available (production — same plumbing as
 * artifact.ts), local `.dataroom/` filesystem otherwise (dev/tests).
 */
export function createDataroomStore(options: CreateDataroomStoreOptions = {}): DataroomStore {
  if (options.backend) return new DataroomStore(options.backend);
  const token = options.blobToken ?? process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    return new DataroomStore(
      new BlobDataroomBackend({ token, storePrefix: blobStorePrefixForOrg(options.orgId) }),
    );
  }
  const base = options.localRootDir ?? defaultLocalDataroomRoot();
  return new DataroomStore(new LocalDataroomBackend(localRootForOrg(base, options.orgId)));
}

/** One cached store per workspace (keyed by org; the default org is 'onfinance'). */
const storeByOrg = new Map<string, DataroomStore>();

/**
 * Process-wide shared store for a workspace, with automatic backend selection
 * (cached per org). Called with no argument it returns org #1's store — the
 * legacy-root data room — so existing single-org callers are byte-for-byte
 * unchanged. Pass an `orgId` to reach another workspace's `orgs/{id}/` tree.
 */
export function getDataroomStore(orgId?: string | null): DataroomStore {
  const key = isLegacyRootOrg(orgId) ? LEGACY_ROOT_ORG : (orgId as string);
  let store = storeByOrg.get(key);
  if (!store) {
    store = createDataroomStore({ orgId: key });
    storeByOrg.set(key, store);
  }
  return store;
}
