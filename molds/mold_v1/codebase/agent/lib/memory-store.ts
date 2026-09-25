/**
 * Multi-player long-term memory for the FDE agent.
 *
 * POSTGRES IS THE SOURCE OF RECORD. When a `DATABASE_URL` (or `POSTGRES_URL`)
 * is configured, memories persist in the `memories` table (see
 * `./db/schema.ts`) via Drizzle ORM + the postgres.js driver — durable across
 * sessions, processes, and teammates.
 *
 * FALLBACK: when no Postgres URL is set (dev / CI / tests), memories live in
 * an in-process store so the `remember` / `list_memories` / `forget` tools and
 * the turn-recall instructions keep working end-to-end with no credentials.
 * The fallback is shared module state, so recall works across turns and
 * sessions within one process (and across "teammates" hitting that process).
 *
 * SCOPES — every memory is saved under exactly one scope string:
 *   - `team`            shared with everyone, recalled on every turn
 *   - `customer:{id}`   recalled when that customer is named in a turn
 *                       (id = `customers.customer_id`, e.g. `acme-bank`)
 *   - `person:{id}`     recalled when that person is named in a turn
 *                       (id = an email or slug, e.g. `sam@acmebank.com`)
 *
 * A deployment whose profile renames customers (agent/lib/agent-vocabulary.ts) has the model write
 * `company:{id}`: the same scope under the deployment's word. It is accepted everywhere a scope is, stored as
 * the `customer` kind (the `memory_scope` column is a Postgres enum; storage does not move), and shown back to
 * the model as `company:{id}` — so both spellings, and every row written before the profile, read as one.
 *
 * A memory is keyed by (scope, key): remembering the same key in the same
 * scope updates the value in place (version bumps), so facts stay current.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { samplePeople } from "./sample-data.ts";
import { getDb, withOrgDb } from "./db/index.ts";
import { memories as memoriesTable } from "./db/schema.ts";
import { DEFAULT_ORG } from "./org-context.ts";
import { listCustomers } from "./system-of-record.ts";
import { MEMORY_ACCOUNT_PREFIX } from "./agent-vocabulary.ts";

/* -------------------------------------------------------------------------- */
/* Scope strings                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `team`, `customer:{id}`, or `person:{id}` — no whitespace, one colon. Under a profile that renames customers,
 * the deployment's own prefix (`company:{id}`) as well.
 */
export const MEMORY_SCOPE_PATTERN = MEMORY_ACCOUNT_PREFIX === "customer"
  ? /^(team|customer:[^\s:]+|person:[^\s:]+)$/
  : new RegExp(`^(team|customer:[^\\s:]+|${MEMORY_ACCOUNT_PREFIX}:[^\\s:]+|person:[^\\s:]+)$`);

export const memoryScopeStringSchema = z
  .string()
  .regex(
    MEMORY_SCOPE_PATTERN,
    "Scope must be 'team', 'customer:{id}', or 'person:{id}'",
  );

export type MemoryScopeKind = "team" | "customer" | "person";

export interface ParsedMemoryScope {
  kind: MemoryScopeKind;
  /** null for the team scope. */
  entityId: string | null;
}

export function parseMemoryScope(scope: string): ParsedMemoryScope {
  const valid = memoryScopeStringSchema.parse(scope);
  if (valid === "team") return { kind: "team", entityId: null };
  const [kind, entityId] = valid.split(":", 2) as [string, string];
  // The deployment's word for a customer is the customer kind, stored as it always was.
  return { kind: kind === MEMORY_ACCOUNT_PREFIX ? "customer" : (kind as MemoryScopeKind), entityId };
}

export function formatMemoryScope(kind: MemoryScopeKind, entityId: string | null): string {
  return kind === "team" ? "team" : `${kind}:${entityId}`;
}

/* -------------------------------------------------------------------------- */
/* Memory record                                                              */
/* -------------------------------------------------------------------------- */

export const memorySensitivitySchema = z.enum([
  "internal",
  "customer_shareable",
  "restricted",
]);

export const memoryRecordSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  /** Full scope string, e.g. `team` or `customer:acme-bank`. */
  scope: z.string().regex(MEMORY_SCOPE_PATTERN),
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(4000),
  authorEmail: z.string(),
  sensitivity: memorySensitivitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().min(1),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

type MemoryRow = typeof memoriesTable.$inferSelect;

function rowToRecord(row: MemoryRow): MemoryRecord {
  return memoryRecordSchema.parse({
    id: row.id,
    orgId: row.orgId ?? DEFAULT_ORG,
    scope: formatMemoryScope(row.scope, row.entityId),
    key: row.key,
    value: row.value,
    authorEmail: row.authorEmail,
    sensitivity: row.sensitivity,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  });
}

/* -------------------------------------------------------------------------- */
/* Fallback store — in-process, keyed by (scope, key)                         */
/* -------------------------------------------------------------------------- */

const fallbackMemories = new Map<string, MemoryRecord>();

function fallbackKey(orgId: string, scope: string, key: string): string {
  return `${orgId}\u0000${scope}\u0000${key}`;
}

/* -------------------------------------------------------------------------- */
/* Postgres helpers                                                           */
/* -------------------------------------------------------------------------- */

function scopeFilter(parsed: ParsedMemoryScope) {
  return and(
    eq(memoriesTable.scope, parsed.kind),
    parsed.entityId === null
      ? isNull(memoriesTable.entityId)
      : eq(memoriesTable.entityId, parsed.entityId),
  );
}

function orgFilter(orgId: string) {
  return orgId === DEFAULT_ORG
    ? or(eq(memoriesTable.orgId, orgId), isNull(memoriesTable.orgId))
    : eq(memoriesTable.orgId, orgId);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface RememberInput {
  orgId?: string;
  scope: string;
  key: string;
  value: string;
  authorEmail: string;
  sensitivity?: z.infer<typeof memorySensitivitySchema>;
}

/** Save (or update, by scope+key) one durable memory. */
export async function rememberMemory(input: RememberInput): Promise<MemoryRecord> {
  const orgId = input.orgId ?? DEFAULT_ORG;
  const parsed = parseMemoryScope(input.scope);
  const sensitivity = input.sensitivity ?? "internal";
  const db = getDb();
  if (db) {
    const existing = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(memoriesTable)
        .where(and(orgFilter(orgId), scopeFilter(parsed), eq(memoriesTable.key, input.key)))
        .limit(1),
    );
    if (existing[0]) {
      const updated = await withOrgDb(orgId, (tx) =>
        tx
          .update(memoriesTable)
          .set({
            value: input.value,
            authorEmail: input.authorEmail,
            sensitivity,
            updatedAt: new Date(),
            version: existing[0].version + 1,
          })
          .where(eq(memoriesTable.id, existing[0].id))
          .returning(),
      );
      return rowToRecord(updated[0]);
    }
    const inserted = await withOrgDb(orgId, (tx) =>
      tx
        .insert(memoriesTable)
        .values({
          orgId,
          scope: parsed.kind,
          entityId: parsed.entityId,
          key: input.key,
          value: input.value,
          authorEmail: input.authorEmail,
          sensitivity,
        })
        .returning(),
    );
    return rowToRecord(inserted[0]);
  }
  // Fallback: in-process upsert.
  const scope = formatMemoryScope(parsed.kind, parsed.entityId);
  const now = new Date().toISOString();
  const prior = fallbackMemories.get(fallbackKey(orgId, scope, input.key));
  const record = memoryRecordSchema.parse({
    id: prior?.id ?? randomUUID(),
    orgId,
    scope,
    key: input.key,
    value: input.value,
    authorEmail: input.authorEmail,
    sensitivity,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
    version: (prior?.version ?? 0) + 1,
  });
  fallbackMemories.set(fallbackKey(orgId, scope, input.key), record);
  return record;
}

/** List memories — all of them, or just one scope. Newest-updated first. */
export async function listMemories(scope?: string, orgId = DEFAULT_ORG): Promise<MemoryRecord[]> {
  const parsed = scope ? parseMemoryScope(scope) : null;
  const db = getDb();
  let records: MemoryRecord[];
  if (db) {
    const rows = await withOrgDb(orgId, (tx) =>
      parsed
        ? tx.select().from(memoriesTable).where(and(orgFilter(orgId), scopeFilter(parsed)))
        : tx.select().from(memoriesTable).where(orgFilter(orgId)),
    );
    records = rows.map(rowToRecord);
  } else {
    records = [...fallbackMemories.values()].filter(
      (m) => m.orgId === orgId && (!parsed || m.scope === formatMemoryScope(parsed.kind, parsed.entityId)),
    );
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Delete one memory by scope+key. Returns whether anything was removed. */
export async function forgetMemory(scope: string, key: string, orgId = DEFAULT_ORG): Promise<boolean> {
  const parsed = parseMemoryScope(scope);
  const db = getDb();
  if (db) {
    const deleted = await withOrgDb(orgId, (tx) =>
      tx
        .delete(memoriesTable)
        .where(and(orgFilter(orgId), scopeFilter(parsed), eq(memoriesTable.key, key)))
        .returning({ id: memoriesTable.id }),
    );
    return deleted.length > 0;
  }
  return fallbackMemories.delete(
    fallbackKey(orgId, formatMemoryScope(parsed.kind, parsed.entityId), key),
  );
}

/* -------------------------------------------------------------------------- */
/* Turn recall — team memories + memories for entities named in the turn      */
/* -------------------------------------------------------------------------- */

const MAX_RECALL_MEMORIES = 50;

export interface TurnMemories {
  /** Team-wide memories: always recalled. */
  team: MemoryRecord[];
  /** Customer/person memories whose entity is named in the turn text. */
  entity: MemoryRecord[];
}

/**
 * Lowercased aliases for an entity id so a memory saved under
 * `customer:acme-bank` is recalled when the turn says "Acme Bank", and one
 * under `person:sam@acmebank.com` when the turn says "Sam Cole". Customer
 * aliases come from the system of record (Postgres or the no-database
 * fallback); person aliases from the sample people, which exist only in a local
 * demo (DEMO_SAMPLE_DATA=1, ./sample-data.ts). The raw entity id always
 * matches, so memories about any person still recall by id.
 */
async function entityAliases(orgId = DEFAULT_ORG): Promise<Map<string, string[]>> {
  const aliases = new Map<string, string[]>();
  const add = (kind: MemoryScopeKind, entityId: string, alias: string | undefined) => {
    if (!alias) return;
    const key = formatMemoryScope(kind, entityId);
    const list = aliases.get(key) ?? [];
    const lowered = alias.toLowerCase();
    if (!list.includes(lowered)) list.push(lowered);
    aliases.set(key, list);
  };
  // A customer can be remembered before its source-of-record row is imported.
  // Keep one conservative slug-derived alias so `northwind-cap` still matches
  // "Northwind Capital" without falling back to unsafe single-token matching.
  const WORD_EXPANSIONS: Readonly<Record<string, string>> = {
    cap: "capital",
    corp: "corporation",
    fin: "finance",
    tech: "technology",
  };
  const slugAlias = (entityId: string) => entityId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => WORD_EXPANSIONS[word] ?? word)
    .join(" ");
  try {
    for (const customer of await listCustomers(orgId)) {
      add("customer", customer.id, customer.id);
      add("customer", customer.id, customer.name);
    }
  } catch {
    // Alias enrichment is best-effort; raw entity ids still match below.
  }
  for (const memory of await listMemories(undefined, orgId)) {
    const { kind, entityId } = parseMemoryScope(memory.scope);
    if (kind === "customer" && entityId) add(kind, entityId, slugAlias(entityId));
    if (kind === "person" && entityId) {
      // A person may be remembered before the roster/stakeholder import. A
      // leading two-to-four-word proper name in the fact ("Sam Cole (CISO)…")
      // is a conservative display-name alias; lowercase prose does not match.
      const displayName = memory.value.match(
        /^([\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+){1,3})\b/u,
      )?.[1];
      add(kind, entityId, displayName);
    }
  }
  const peopleSeed = samplePeople();
  const people = [
    ...peopleSeed.internalStaffAssignments,
    ...peopleSeed.customerStakeholders,
  ] as { email: string; name: string }[];
  for (const person of people) {
    add("person", person.email, person.email);
    add("person", person.email, person.name);
  }
  return aliases;
}

/**
 * Load the memories relevant to one turn: every `team` memory plus the
 * `customer:*` / `person:*` memories whose entity id or known alias appears
 * in the turn text (case-insensitive substring match).
 */
export async function loadTurnMemories(turnText: string, orgId = DEFAULT_ORG): Promise<TurnMemories> {
  const all = await listMemories(undefined, orgId);
  const team = all.filter((m) => m.scope === "team").slice(0, MAX_RECALL_MEMORIES);
  const scoped = all.filter((m) => m.scope !== "team");
  if (scoped.length === 0 || turnText.trim().length === 0) {
    return { team, entity: [] };
  }
  const aliases = await entityAliases(orgId);
  const text = turnText.toLowerCase();
  const entity = scoped
    .filter((m) => {
      const { entityId } = parseMemoryScope(m.scope);
      const candidates = new Set([entityId!.toLowerCase(), ...(aliases.get(m.scope) ?? [])]);
      for (const candidate of candidates) {
        if (candidate.length > 1 && text.includes(candidate)) return true;
      }
      return false;
    })
    .slice(0, MAX_RECALL_MEMORIES);
  return { team, entity };
}
