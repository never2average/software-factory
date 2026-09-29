/**
 * syncs.ts — the ingestion facade over the dm.md `{domain}/syncs/**` landing
 * zones.
 *
 * A "sync" is one pull of raw items from an upstream source (Granola notes, an
 * IMAP inbox, Slack messages the model fetched via MCP, manually-entered
 * items, …) into the data room. This module:
 *
 *   1. maps (domain, source) to the exact dm.md syncs folder (see
 *      SYNC_SOURCE_FOLDERS — note the Deployments `manual_entry` -> `manual_input`
 *      alias and the `meeting_notes/granola` / `bare_metal/*` nested folders);
 *   2. fetches (or accepts pre-fetched `items`) via per-source adapters, each of
 *      which degrades gracefully to a STRUCTURED SKIP instead of throwing when
 *      its credentials/client are unavailable;
 *   3. lands every raw item verbatim as a RawSyncRecord in a single durable
 *      append to one `.jsonl` stream per (domain, source, customer, day); and
 *   4. optionally normalizes Customers-domain items into the system of record via
 *      `recordInteraction` (which mirrors to Customers/{id}/interactions.jsonl).
 *
 * Raw landing is the source of truth: per-item normalization failures are
 * COUNTED (normalized < landed, with a `reason`) rather than failing the pull.
 * ingestSource never throws for operational failures — only zod would throw for
 * a programmer error (an invalid domain enum), which the E2 tool guards anyway.
 *
 * Solutions and Implementation have NO syncs subtree in dm.md, so they are
 * rejected up front with a structured skip.
 */
import { nanoid } from "nanoid";
import type { ZodType } from "zod";
import { z } from "zod";
import {
  jsonValueSchema,
  type JsonValue,
} from "#lib/dataroom-schema.js";
import { getDataroomStore } from "#lib/dataroom-store.js";
import { getDb } from "#lib/db/index.js";
import { DEFAULT_ORG } from "#lib/org-context.js";
import { interactionSchema } from "#lib/customer-schema.js";
import { recordInteraction } from "#lib/system-of-record.js";
import { searchGranolaNotes } from "#lib/granola.js";
import { EmailNotConfiguredError, listInbox } from "#lib/email.js";

// ---------------------------------------------------------------------------
// Domains + source-folder map (encodes the dm.md syncs subtrees exactly)
// ---------------------------------------------------------------------------

/** The five dm.md domains that carry a `syncs/**` landing subtree. */
export type SyncDomain = "Customers" | "Platform" | "Deployments" | "Tickets" | "People";

export const SYNC_DOMAINS: readonly SyncDomain[] = [
  "Customers",
  "Platform",
  "Deployments",
  "Tickets",
  "People",
];

/**
 * (domain -> logical source name -> dm.md syncs folder). Callers always say the
 * logical source (e.g. `manual_entry`); for Deployments that lands in the
 * dm.md-spelled `manual_input/` folder. Nested folders (`meeting_notes/granola`,
 * `bare_metal/oc`) are admitted by the `{domain}/syncs/**` path templates.
 */
export const SYNC_SOURCE_FOLDERS: Record<SyncDomain, Record<string, string>> = {
  Customers: {
    manual_entry: "manual_entry",
    email: "email",
    slack: "slack",
    granola: "meeting_notes/granola",
  },
  Platform: {
    manual_entry: "manual_entry",
    github: "github",
    aws: "aws",
    slack: "slack",
    miro: "miro",
  },
  Deployments: {
    manual_entry: "manual_input",
    claude: "claude",
    codex: "codex",
    email: "email",
    github: "github",
    aws: "aws",
    azure: "azure",
    gcp: "gcp",
    oci: "oci",
    bare_metal_oc: "bare_metal/oc",
    bare_metal_nkp: "bare_metal/nkp",
    bare_metal_custom_k8s: "bare_metal/custom_k8s",
  },
  Tickets: {
    manual_entry: "manual_entry",
    call: "call",
    email: "email",
    slack: "slack",
  },
  People: {
    manual_entry: "manual_entry",
    email: "email",
    slack: "slack",
    analytics: "analytics",
    observability: "observability",
    granola: "meeting_notes/granola",
  },
};

/** The dm.md syncs folder for a (domain, source) pair, or null when unknown. */
export function sourceFolder(domain: SyncDomain, source: string): string | null {
  return SYNC_SOURCE_FOLDERS[domain]?.[source] ?? null;
}

/** The logical source names valid for a domain (keys of the folder map). */
export function listSyncSources(domain: SyncDomain): string[] {
  return Object.keys(SYNC_SOURCE_FOLDERS[domain] ?? {});
}

/**
 * The landing path for one (domain, source, customer, day):
 *   "{domain}/syncs/{folder}/{customerId}/{YYYY-MM-DD}.jsonl"
 * e.g. "Customers/syncs/meeting_notes/granola/acme-bank/2026-07-10.jsonl".
 * `date` defaults to today (UTC). Throws for an unknown (domain, source) — an
 * ingest caller resolves the pair to a structured skip before ever calling this.
 */
export function syncLandingPath(
  domain: SyncDomain,
  source: string,
  customerId: string,
  date?: string,
): string {
  const folder = SYNC_SOURCE_FOLDERS[domain]?.[source];
  if (!folder) {
    throw new Error(`no dm.md syncs folder for domain "${domain}" source "${source}"`);
  }
  const day = date ?? new Date().toISOString().slice(0, 10);
  return `${domain}/syncs/${folder}/${customerId}/${day}.jsonl`;
}

// ---------------------------------------------------------------------------
// Raw-sync-record contract (no contract exists in dataroom-schema.ts)
// ---------------------------------------------------------------------------

export const rawSyncRecordSchema = z.object({
  syncId: z.string().min(1), // `SYNC-${nanoid(10)}`
  domain: z.enum(["Customers", "Platform", "Deployments", "Tickets", "People"]),
  source: z.string().min(1), // logical source name, e.g. "granola"
  customerId: z.string().min(1),
  fetchedAt: z.string().min(1), // ISO timestamp of the pull
  sourceId: z.string().optional(), // upstream id (note id, IMAP uid, slack ts)
  payload: jsonValueSchema, // the raw upstream item, verbatim
  recordedByEmail: z.string().email().optional(), // verified caller, from E2
});
export type RawSyncRecord = z.infer<typeof rawSyncRecordSchema>;

// ---------------------------------------------------------------------------
// Facade input/output
// ---------------------------------------------------------------------------

export interface IngestInput {
  domain: SyncDomain;
  customerId: string;
  /** Key into SYNC_SOURCE_FOLDERS[domain]. */
  source: string;
  /** ISO date lower bound; adapters map it to their client's filter. */
  since?: string;
  /** Search query for search-shaped sources (granola); defaults to customerId. */
  query?: string;
  /** Caller-supplied raw items (manual_entry, and MCP-mediated slack/github). */
  items?: unknown[];
  /** Default true; only effective for domain "Customers". */
  normalize?: boolean;
  /** Verified caller stamp, passed by the E2 tool. */
  recordedByEmail?: string;
  /**
   * The caller's workspace (the tool passes orgForSession). The landing zone and any normalized interaction go in
   * THIS workspace, and a customer id from another one is "Unknown customer". Omitted only by system paths.
   */
  orgId?: string | null;
}

export interface IngestResult {
  /** false only on a structured skip. */
  ok: boolean;
  domain: SyncDomain;
  source: string;
  customerId: string;
  /** null when nothing landed. */
  landingPath: string | null;
  /** Raw records appended. */
  landed: number;
  /** Interactions written via recordInteraction. */
  normalized: number;
  /** Items fetched but not landed (or 0). */
  skipped: number;
  /** Why landed === 0 / normalization partial. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Per-source adapters
// ---------------------------------------------------------------------------

/** One fetched upstream item, ready to land (and optionally normalize). */
interface FetchedItem {
  /** Raw upstream item, stored verbatim as the RawSyncRecord payload. */
  payload: JsonValue;
  /** Upstream id (note id, IMAP uid, slack ts), if any. */
  sourceId?: string;
  /**
   * Interaction fields for Customers-domain normalization (omit for raw-only
   * sources). Merged over `{ interactionId, sourceId: syncId }` and stamped
   * with recordedAt/recordedByEmail by ingestSource, then validated by
   * interactionSchema before recordInteraction.
   */
  interactionDraft?: Record<string, unknown>;
}

interface AdapterOutput {
  items: FetchedItem[];
  /** Items fetched upstream but intentionally not landed (e.g. `since` filter). */
  skipped: number;
  /** Set when items is empty: why nothing landed (missing creds, no items, …). */
  reason?: string;
}

interface AdapterContext {
  input: IngestInput;
  fetchedAt: string;
}

type Adapter = (ctx: AdapterContext) => Promise<AdapterOutput>;

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getField(item: unknown, key: string): unknown {
  if (item !== null && typeof item === "object") {
    return (item as Record<string, unknown>)[key];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Cast a validated-at-append JSON item to JsonValue (rawSyncRecordSchema re-checks). */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

/** Narrow `since` to a whole-day lower bound for listInbox (1..365 days). */
function sinceDaysFrom(since?: string): number | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return undefined;
  const days = Math.ceil((Date.now() - t) / 86_400_000);
  return Math.min(365, Math.max(1, days));
}

/** manual_entry — offline; `items` required from the caller, zero external calls. */
const manualEntryAdapter: Adapter = async ({ input, fetchedAt }) => {
  const items = input.items ?? [];
  if (items.length === 0) {
    return { items: [], skipped: 0, reason: "manual_entry requires items[]" };
  }
  return {
    skipped: 0,
    items: items.map((item) => {
      const type = asString(getField(item, "type"));
      const date = asString(getField(item, "date"));
      const summary = asString(getField(item, "summary"));
      const participants = getField(item, "participantEmails");
      const draft: Record<string, unknown> = {
        interactionType: type ?? "note",
        sourceSystem: "manual",
        interactionAt: date ?? fetchedAt,
        note: getField(item, "note"),
      };
      if (summary !== undefined) draft.summary = summary;
      if (Array.isArray(participants)) draft.participantEmails = participants;
      return { payload: asJson(item), interactionDraft: draft };
    }),
  };
};

/** granola — search notes; filter client-side by `since`. Never throws. */
const granolaAdapter: Adapter = async ({ input }) => {
  const result = await searchGranolaNotes(input.query ?? input.customerId, 20);
  if (!result.configured) {
    return { items: [], skipped: 0, reason: result.message ?? "Granola is not configured." };
  }
  const sinceMs = input.since ? Date.parse(input.since) : Number.NaN;
  const kept = Number.isNaN(sinceMs)
    ? result.notes
    : result.notes.filter((note) => {
        const t = Date.parse(note.date);
        return Number.isNaN(t) || t >= sinceMs;
      });
  return {
    skipped: result.notes.length - kept.length,
    items: kept.map((note) => ({
      payload: asJson(note),
      sourceId: note.id,
      interactionDraft: {
        interactionType: "meeting",
        sourceSystem: "granola",
        interactionAt: note.date,
        summary: note.title,
        note: note.summary,
        sourceId: note.id,
        sourceLink: note.url ?? "",
      },
    })),
  };
};

/** email — IMAP inbox summaries; catches EmailNotConfiguredError -> structured skip. */
const emailAdapter: Adapter = async ({ input, fetchedAt }) => {
  try {
    // The sync's own workspace's mailbox, never another's (agent/lib/workspace-mailbox.ts).
    const summaries = await listInbox(
      {
        from: input.query,
        sinceDays: sinceDaysFrom(input.since),
        max: 25,
      },
      input.orgId ?? null,
    );
    return {
      skipped: 0,
      items: summaries.map((msg) => ({
        payload: asJson(msg),
        sourceId: String(msg.uid),
        interactionDraft: {
          interactionType: "email",
          sourceSystem: "gmail",
          interactionAt: msg.date ?? fetchedAt,
          summary: msg.subject,
          note: `From ${msg.from ?? "unknown"}: ${msg.subject ?? "(no subject)"}`,
          sourceId: String(msg.uid),
        },
      })),
    };
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) {
      return { items: [], skipped: 0, reason: error.message };
    }
    return { items: [], skipped: 0, reason: errMessage(error) };
  }
};

/** slack — MCP is model-mediated; the model fetches and passes `items` in. */
const slackAdapter: Adapter = async ({ input, fetchedAt }) => {
  const items = input.items ?? [];
  if (items.length === 0) {
    return {
      items: [],
      skipped: 0,
      reason:
        "slack is MCP-mediated: fetch messages with the slack connection tools and pass them as items",
    };
  }
  return {
    skipped: 0,
    items: items.map((item) => {
      const ts = asString(getField(item, "ts"));
      const permalink = asString(getField(item, "permalink"));
      const draft: Record<string, unknown> = {
        interactionType: "slack",
        sourceSystem: "slack",
        interactionAt: ts ?? fetchedAt,
        note: getField(item, "text"),
        sourceLink: permalink ?? "",
      };
      if (ts !== undefined) draft.sourceId = ts;
      return { payload: asJson(item), sourceId: ts, interactionDraft: draft };
    }),
  };
};

/** github — MCP is model-mediated (same constraint as slack); raw landing only. */
const githubAdapter: Adapter = async ({ input }) => {
  const items = input.items ?? [];
  if (items.length === 0) {
    return {
      items: [],
      skipped: 0,
      reason:
        "github is MCP-mediated: fetch issues/PRs/commits with the github connection tools and pass them as items",
    };
  }
  return {
    skipped: 0,
    items: items.map((item) => ({ payload: asJson(item), sourceId: githubItemId(item) })),
  };
};

function githubItemId(item: unknown): string | undefined {
  const id = getField(item, "id");
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  const sha = asString(getField(item, "sha"));
  if (sha) return sha;
  const number = getField(item, "number");
  if (typeof number === "number") return String(number);
  return undefined;
}

/**
 * Default adapter for sources with no wired client
 * (analytics/observability/aws/azure/gcp/oci/miro/claude/codex/call/bare_metal_*):
 * pass `items` through as raw landing, or a structured skip when none supplied.
 */
const passthroughAdapter: Adapter = async ({ input }) => {
  const items = input.items ?? [];
  if (items.length === 0) {
    return {
      items: [],
      skipped: 0,
      reason: `no client wired for source "${input.source}"; pass items to land raw records`,
    };
  }
  return {
    skipped: 0,
    items: items.map((item) => ({ payload: asJson(item), sourceId: asString(getField(item, "id")) })),
  };
};

const ADAPTERS: Record<string, Adapter> = {
  manual_entry: manualEntryAdapter,
  granola: granolaAdapter,
  email: emailAdapter,
  slack: slackAdapter,
  github: githubAdapter,
};

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only stamp an email-shaped identity (interactionSchema requires an email). */
function emailStamp(value: string | undefined): string | undefined {
  return value && EMAIL_RE.test(value) ? value : undefined;
}

/**
 * Pull one source into the data room. Validates the (domain, source) pair,
 * runs the adapter (or accepts `items`), lands raw records in one durable
 * append, and optionally normalizes Customers-domain items to interactions.
 * Returns a structured skip (`ok:false`) for unknown domains/sources and for
 * every "no creds"/"no items"/fetch-failure path — never throws for those.
 */
export async function ingestSource(input: IngestInput): Promise<IngestResult> {
  const { domain, source, customerId } = input;
  const skip = (reason: string, skipped = 0): IngestResult => ({
    ok: false,
    domain,
    source,
    customerId,
    landingPath: null,
    landed: 0,
    normalized: 0,
    skipped,
    reason,
  });

  // Reject domains without a dm.md syncs subtree (Solutions/Implementation, or
  // any bad enum value reaching us at runtime) and unknown (domain, source).
  const folders = SYNC_SOURCE_FOLDERS[domain];
  if (!folders) {
    return skip(`domain "${domain}" has no dm.md syncs subtree`);
  }
  if (!folders[source]) {
    return skip(`source "${source}" is not a dm.md syncs source for domain "${domain}"`);
  }

  const fetchedAt = new Date().toISOString();
  const landingPath = syncLandingPath(domain, source, customerId);
  const stampEmail = emailStamp(input.recordedByEmail);

  // 1. Fetch (or take items). Adapters degrade to structured skips; the outer
  //    try/catch is belt-and-braces for any unexpected throw.
  let output: AdapterOutput;
  try {
    output = await (ADAPTERS[source] ?? passthroughAdapter)({ input, fetchedAt });
  } catch (error) {
    return skip(errMessage(error));
  }
  if (output.items.length === 0) {
    return skip(output.reason ?? "no items to land", output.skipped);
  }

  // 2. Wrap each item in a RawSyncRecord and land them in one durable append, in the workspace the sync was run
  //    for. It used to fall back to "the workspace that owns this customer id" (orgForCustomer); a company id names
  //    a company only within a workspace (mold_v1-118), so a sync with a database and no workspace lands nothing.
  //    Without a database (dev, tests) there is one workspace, the default one.
  if (!input.orgId && getDb()) {
    return skip(`no workspace was given for ${customerId}: a company id names a company only within a workspace`);
  }
  // Named explicitly without a database: the store has no default workspace (lib/dataroom-keyspace.ts).
  const store = getDataroomStore(input.orgId || DEFAULT_ORG);
  const wrapped = output.items.map((item) => {
    const syncId = `SYNC-${nanoid(10)}`;
    const record: RawSyncRecord = {
      syncId,
      domain,
      source,
      customerId,
      fetchedAt,
      sourceId: item.sourceId,
      payload: item.payload,
      recordedByEmail: stampEmail,
    };
    return { syncId, record, interactionDraft: item.interactionDraft };
  });

  let landed: number;
  try {
    landed = await store.appendJsonl(
      landingPath,
      wrapped.map((w) => w.record),
      rawSyncRecordSchema as ZodType,
    );
  } catch (error) {
    return skip(errMessage(error), output.skipped);
  }

  // 3. Normalize Customers-domain items into the system of record. Per-item
  //    failures are counted (raw landing already succeeded), not thrown.
  let normalized = 0;
  let normalizable = 0;
  let normReason: string | undefined;
  if (domain === "Customers" && input.normalize !== false) {
    for (const { syncId, interactionDraft } of wrapped) {
      if (!interactionDraft) continue;
      normalizable++;
      try {
        const interaction = interactionSchema.parse({
          interactionId: `INT-${nanoid(10)}`,
          sourceId: syncId,
          ...interactionDraft,
          recordedAt: new Date().toISOString(),
          recordedByEmail: stampEmail,
        });
        await recordInteraction(customerId, interaction, input.orgId);
        normalized++;
      } catch (error) {
        normReason = errMessage(error);
      }
    }
  }

  const reason =
    normalized < normalizable
      ? normReason ?? "some items could not be normalized to interactions"
      : undefined;

  return {
    ok: true,
    domain,
    source,
    customerId,
    landingPath,
    landed,
    normalized,
    skipped: output.skipped,
    reason,
  };
}
