/**
 * DataroomStore-backed domain tools. Each is re-exported from a snake_case file
 * under a `tools/` directory (root or subagent) so the model-facing tool name
 * comes from the filename. These wrap the shared DataroomStore facade
 * (agent/lib/dataroom-store.ts) — the durable virtual filesystem over the dm.md
 * data-room tree — so subagents can read/list/write/append data-room artifacts
 * by their canonical dm.md path. All paths are validated against
 * DATAROOM_PATH_TEMPLATES inside the store, so these tools never need their own
 * traversal checks.
 *
 * Overwrites go through #lib/dataroom-versions.js rather than straight at the
 * store, so the bytes a write replaces are kept and a batch of them can be
 * reverted; backfill_start / backfill_finish are how the model declares a batch.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import type { ZodType } from "zod";
import { z } from "zod";
import { interactionSchema, ticketSchema } from "#lib/customer-schema.js";
import {
  evalBenchmarkRecordSchema,
  evalDatasetRecordSchema,
  evalOutputRecordSchema,
  evalTraceRecordSchema,
  jsonObjectSchema,
  personInteractionRecordSchema,
  personaSchema,
} from "#lib/dataroom-schema.js";
import { DataroomPathError } from "#lib/dataroom-store.js";
import {
  commitChangeset,
  openChangeset,
  versioningAvailable,
  writeVersioned,
} from "#lib/dataroom-versions.js";
import { callerFromCtx, orgForSession, type SessionCtxLike } from "#lib/org-context.js";
// The workspace-scoped store resolver, shared with every other data-room reader
// (agent/lib/dataroom-session.ts) so a second reader cannot arrive with its own.
import { storeForSession } from "./dataroom-session.ts";

import { inheritedScope } from "./session-scope.ts";
/** Re-throw as a model-readable message when the store rejects a path. */
function pathErrorMessage(error: unknown): string | null {
  if (error instanceof DataroomPathError) return error.message;
  return null;
}

/** Who a version row is attributed to: the verified caller, else the agent itself. */
async function actorFor(ctx: SessionCtxLike | undefined): Promise<string> {
  const own = callerFromCtx(ctx).email;
  if (own) return own;
  // A subagent's session has no identity of its own; attribute its writes to the person whose root session
  // delegated to it, not to an anonymous "agent" (agent/lib/session-scope.ts).
  return (await inheritedScope(ctx?.session?.parent))?.email ?? "agent";
}

/**
 * Get a data-room file's BYTES into the bash sandbox.
 *
 * `dataroom_read` returns text. For markdown and jsonl that is the right
 * answer; for a spreadsheet it is useless, because an .xlsx is a zip and
 * decoding it as UTF-8 destroys it. Without this tool the agent could see the
 * file, could not obtain it, and looped for half an hour — reading it, hunting
 * the sandbox filesystem for it, listing the directory, reading it again —
 * narrating "let me bridge the data room file into the bash sandbox" with no
 * bridge in existence.
 *
 * The URL is presigned, GET-only and short-lived, so putting it in a sandbox
 * command exposes that one object for a few minutes and nothing else.
 */
export const dataroomFetchToSandboxTool = defineTool({
  description:
    "Get a data-room file into your bash sandbox so you can PARSE it (spreadsheets, PDFs, images, archives — anything that is not plain text). Returns a short-lived download URL plus the exact curl command to run. Use this instead of dataroom_read whenever the file is binary: dataroom_read decodes as text and will hand you mangled bytes for an .xlsx. Typical flow: call this, run the command in bash, then parse the local file (openpyxl is installed).",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Data-room path, e.g. 'Uploads/sam-example-com/Tracker.xlsx'."),
    destination: z
      .string()
      .optional()
      .describe("Where to put it in the sandbox. Defaults to /workspace/<filename>."),
  }),
  async execute({ path, destination }, ctx) {
    try {
      const store = await storeForSession(ctx);
      const url = await store.downloadUrl(path);
      if (url === null) {
        return {
          path,
          error:
            "This data room is a local filesystem, so there is nothing to bridge — read the file directly.",
        };
      }
      const filename = path.split("/").pop() ?? "file";
      const target = destination ?? `/workspace/${filename}`;
      return {
        path,
        destination: target,
        url,
        expiresInSeconds: 300,
        // Quoted: real data-room filenames contain spaces and parentheses, and
        // an unquoted command silently fetches the wrong thing or nothing.
        command: `curl -sSL -o "${target}" "${url}"`,
        next: `Run the command in bash, then parse "${target}" (openpyxl is available for .xlsx).`,
      };
    } catch (error) {
      const message = pathErrorMessage(error);
      if (message !== null) return { path, error: message };
      throw error;
    }
  },
});

export const dataroomReadTool = defineTool({
  description:
    "Read one artifact from the dm.md data room by its canonical path. `.jsonl` paths are parsed into a `records` array; every other path returns raw `content` (null `content` / `found:false` when the file does not exist yet). Invalid paths return an error message so you can self-correct.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "dm.md data-room path, e.g. 'Customers/acme-bank/context.md' or 'Tickets/bug/acme-bank/2026.06.3/tickets_TCK-1042.jsonl'.",
      ),
  }),
  async execute({ path }, ctx) {
    try {
      const store = await storeForSession(ctx);
      if (path.endsWith(".jsonl")) {
        return { path, records: await store.readJsonl(path) };
      }
      const content = await store.read(path);
      if (content === null) return { path, found: false as const };
      return { path, content };
    } catch (error) {
      const message = pathErrorMessage(error);
      if (message !== null) return { path, error: message };
      throw error;
    }
  },
});

export const dataroomListTool = defineTool({
  description:
    "List the logical file paths in the dm.md data room at or under a folder prefix (directory-boundary semantics: 'Customers/acme' does NOT match 'Customers/acme-bank/...'). Omit `prefix` to list the whole data room.",
  inputSchema: z.object({
    prefix: z
      .string()
      .optional()
      .describe(
        "Folder prefix with directory-boundary semantics, e.g. 'Deployments/acme-bank'. Omit to list the whole data room.",
      ),
  }),
  async execute({ prefix }, ctx) {
    try {
      return { paths: await (await storeForSession(ctx)).list(prefix ?? "") };
    } catch (error) {
      const message = pathErrorMessage(error);
      if (message !== null) return { prefix: prefix ?? "", error: message };
      throw error;
    }
  },
});

export const dataroomWriteTool = defineTool({
  description:
    "Create or replace a TEXT artifact in the dm.md data room (context.md, rationale.md, config/contract JSON, etc.) at its canonical path. Binary workbooks (.xlsx) are built in the sandbox and published, not text-written here. The store overwrites IN PLACE, so open a changeset with backfill_start and pass its `changesetId` here whenever you are writing more than two or three files — that is what makes the batch revertible. Gated on approval since it mutates the team's shared document store.",
  approval: once(),
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("dm.md data-room path to write, e.g. 'Customers/acme-bank/context.md'."),
    content: z.string().min(1).describe("Full text content of the file."),
    changesetId: z
      .string()
      .optional()
      .describe("From backfill_start. Attaches this write to a revertible batch."),
  }),
  async execute({ path, content, changesetId }, ctx) {
    if (path.endsWith(".xlsx")) {
      return {
        written: false as const,
        path,
        error:
          "binary workbooks are built in the sandbox and published, not text-written; use publish_artifact for .xlsx.",
      };
    }
    try {
      await writeVersioned({
        orgId: await orgForSession(ctx),
        path,
        content,
        actor: await actorFor(ctx),
        changesetId,
      });
      return { written: true as const, path };
    } catch (error) {
      const message = pathErrorMessage(error);
      if (message !== null) return { written: false as const, path, error: message };
      throw error;
    }
  },
});

/**
 * Pick a per-record zod schema by the .jsonl path so appended records are
 * validated against their dm.md contract before anything is written. Paths with
 * no known contract append unvalidated.
 */
function schemaForJsonlPath(path: string): ZodType | undefined {
  if (/interactions\.jsonl$/.test(path)) {
    if (path.startsWith("People/")) return personInteractionRecordSchema;
    if (path.startsWith("Customers/")) return interactionSchema;
    return undefined;
  }
  // Matches both Customers/{id}/personas.jsonl and Solutions/{v}/supported.personas.jsonl.
  if (/personas\.jsonl$/.test(path)) return personaSchema;
  if (/tickets_[^/]+\.jsonl$/.test(path)) return ticketSchema;
  if (/evals\/dataset\.jsonl$/.test(path)) return evalDatasetRecordSchema;
  if (/evals\/benchmark\.jsonl$/.test(path)) return evalBenchmarkRecordSchema;
  if (/output\.jsonl$/.test(path)) return evalOutputRecordSchema;
  if (/trace\.jsonl$/.test(path)) return evalTraceRecordSchema;
  return undefined;
}

export const dataroomAppendJsonlTool = defineTool({
  description:
    "Durably append one record (or an array of records) to a `.jsonl` artifact in the dm.md data room (interactions, tickets, eval dataset/benchmark/output/trace streams), creating it on demand. Records are validated against their dm.md contract when the path has one. Gated on approval since it mutates the team's shared streams.",
  approval: once(),
  inputSchema: z.object({
    path: z.string().min(1).describe("A `.jsonl` data-room path, e.g. 'Customers/acme-bank/interactions.jsonl'."),
    records: z
      .union([jsonObjectSchema, z.array(jsonObjectSchema).min(1)])
      .describe("A single JSON object record, or a non-empty array of JSON object records."),
  }),
  async execute({ path, records }, ctx) {
    try {
      const appended = await (await storeForSession(ctx)).appendJsonl(path, records, schemaForJsonlPath(path));
      return { appended, path };
    } catch (error) {
      const message = pathErrorMessage(error);
      if (message !== null) return { appended: 0, path, error: message };
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Changesets — a backfill as one revertible act (see #lib/dataroom-versions.ts)
// ---------------------------------------------------------------------------

const NO_VERSIONING =
  "version control is unavailable here (no database configured); writes still land but cannot be reverted as a batch.";

export const backfillStartTool = defineTool({
  description:
    "Open a CHANGESET before a bulk write, then pass its id as `changesetId` on every dataroom_write in the batch. This is what makes a backfill reviewable and revertible as ONE act instead of forty separate overwrites — the data room writes IN PLACE, so without a changeset the previous content of each file is simply gone. Always use this when you are about to write more than two or three files. Call backfill_finish when done.",
  inputSchema: z.object({
    label: z
      .string()
      .min(1)
      .describe("What this batch is, in your words, e.g. 'backfill acme-bank integration history'."),
    rationale: z
      .string()
      .max(500)
      .optional()
      .describe("Why the batch is happening and where its content came from."),
  }),
  async execute({ label, rationale }, ctx) {
    if (!versioningAvailable()) return { changesetId: null, error: NO_VERSIONING };
    const { id } = await openChangeset({
      orgId: await orgForSession(ctx),
      label,
      actor: await actorFor(ctx),
      rationale,
    });
    return {
      changesetId: id,
      next: "Pass changesetId on every dataroom_write in this batch, then call backfill_finish.",
    };
  },
});

export const backfillFinishTool = defineTool({
  description:
    "Close a changeset opened with backfill_start, once every write in the batch has landed. Until it is closed it stays 'open' and is not offered for revert. Reports how many files the batch touched.",
  inputSchema: z.object({
    changesetId: z.string().min(1).describe("The id returned by backfill_start."),
  }),
  async execute({ changesetId }, ctx) {
    if (!versioningAvailable()) return { committed: false as const, error: NO_VERSIONING };
    const { files } = await commitChangeset(await orgForSession(ctx), changesetId);
    return { committed: true as const, changesetId, files };
  },
});
