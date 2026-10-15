/**
 * THE PER-AREA RECORD TOOLS: `list_deployments` / `upsert_deployment` and `list_implementations` /
 * `upsert_implementation` (re-exported from snake_case files under agent/tools/), for an area whose definition turns
 * them on (`records.areas.<area>.agent.tools.read` / `.write`; off by default, so the default model surface is
 * unchanged). The model reads them in the profile's words: the vocabulary boundary speaks `deployment` as the area's
 * label (`list_coverage_reports`, `upsert_regulatory_filing`), and every description and parameter here is built
 * from the area's definition (its label, its fields, their choices and help).
 *
 *   list_<area>     filters, sorts and pages in the database (agent/lib/record-query.ts), so the model asks for
 *                   "the overdue filings of one company" without loading every row; whitelisted keys, bound values.
 *   upsert_<area>   one record by its key, checked by the one validator (agent/lib/record-area-write.ts), its own
 *                   fields merged per key in SQL onto what is stored at write time. Gated on approval.
 *
 * Every query runs in the caller's workspace (withOrgDb) and names it.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, withOrgDb } from "./db/index.ts";
import { deployments, implementation } from "./db/schema.ts";
import { orgForSession } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { customMergeSql } from "./custom-merge-sql.ts";
import type { CustomDelta } from "./custom-fields.ts";
import { RECORD_AREAS } from "./record-areas.generated.ts";
import { areaView, describeArea, describeField, type AreaRow, type RecordAreas, type RecordField } from "./record-areas.ts";
import { ACCOUNT_FIELD, recordTitle, recordValues, writableFields, type AccountAreaId } from "./record-area-records.ts";
import { prepareRecordWrite } from "./record-area-write.ts";
import { writeOutcome } from "./record-lifecycle-store.ts";
import { enforced, enteredByOf, memberRole } from "./record-area-store.ts";
import { permissionsDeclared } from "./record-permissions.ts";
import { compileRecordQuery, defaultSort, encodeCursor, parseRecordQuery, type AreaTable } from "./record-query.ts";

const TABLE = { deployments, implementations: implementation } as const;
const tableOf = (id: AccountAreaId) => TABLE[id] as unknown as AreaTable & typeof deployments;

/** Does the definition offer the model this area's list (read) or write tool? */
export function areaToolOn(id: AccountAreaId, kind: "read" | "write", areas: RecordAreas = RECORD_AREAS): boolean {
  const a = areas[id];
  return a.enabled && a.agent?.tools?.[kind] === true;
}

function callerEmail(ctx: { session?: { auth?: { current?: { principalId?: string; attributes?: Readonly<Record<string, string | readonly string[]>> } | null } } }): string {
  const current = ctx.session?.auth?.current;
  const email = current?.attributes?.email;
  if (typeof email === "string" && email.length > 0) return email;
  return current?.principalId ?? "agent";
}

/** A field as a tool parameter: its choices as an enum, its words as the description; null clears it. */
export function fieldParam(f: RecordField) {
  const said = describeField(f).replace(/^`[^`]+` /, "");
  const choices = (f.options ?? []).filter((o) => !o.retired).map((o) => o.value);
  const list = f.type === "multi_pick" || f.type === "tags" || (f.many && ["person", "record", "file"].includes(f.type));
  const base =
    f.type === "pick_list" && choices.length ? z.enum(choices as [string, ...string[]])
    : f.type === "multi_pick" && choices.length ? z.array(z.enum(choices as [string, ...string[]]))
    : list ? z.array(z.string())
    : ["integer", "number", "percent", "money"].includes(f.type) ? z.number()
    : f.type === "boolean" ? z.boolean()
    : z.string();
  return base.nullable().optional().describe(`${said}${f.help ? ` ${f.help}` : ""}`);
}

/** The words a tool says about an area: its noun, what one is, its fields. Built from the definition only. */
export function areaToolWords(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS) {
  const v = areaView(id, areas);
  const keyed = id === "deployments" ? ` Each is identified by its account and its \`deploymentId\` ("${v.area.id?.label ?? "id"}").` : " An account has at most one.";
  const fields = writableFields(v);
  const lc = v.lifecycle;
  const states = lc ? ` Its \`${lc.field}\` moves through: ${lc.states.filter((s) => !s.retired).map((s) => `"${s.label}"`).join(" → ")}.` : "";
  const computed = v.visibleFields.filter((f) => f.computed).map((f) => `\`${f.key}\``);
  const list =
    `List ${v.nouns}${v.description ? ` (${v.description.replace(/\.$/, "")})` : ""}, filtered, sorted and paged in the database.${keyed}` +
    ` Filter with \`where\`: { field: value } or { field: { eq | ne | in | not_in | lt | lte | gt | gte | set | contains${lc ? " | category" : ""} } }, every condition must hold; \`${ACCOUNT_FIELD}\` is the account id.` +
    ` Sort with \`sort\` ("field" or "-field" for descending). A page holds \`limit\` rows (default 25); pass \`cursor\` from the answer for the next.` +
    ` The fields: ${[`\`${ACCOUNT_FIELD}\``, ...v.visibleFields.map((f) => `\`${f.key}\` ("${f.label ?? f.key}")`)].join(", ")}.${states}${computed.length ? ` Computed, read-only: ${computed.join(", ")}.` : ""}`;
  const upsert =
    `Create OR update one ${v.noun} (${v.nouns}${v.description ? `: ${v.description.replace(/\.$/, "")}` : ""}).${keyed} Send \`customerId\`${id === "deployments" ? " and `deploymentId`" : ""}, then in \`values\` only the fields that change (null clears one); a new one needs every required field.` +
    ` Checked against this workspace's definition before anything is written; a refusal says what to fix.${states}` +
    (computed.length ? ` Never set ${computed.join(", ")}: computed.` : "") +
    ` Gated on approval since this changes the team's records.` +
    `\n\n${describeArea(id, areas) ?? ""}`.trimEnd();
  return { v, fields, list, upsert };
}

/** A row as the model reads it: the account, the id, the title, every visible field by key. */
function rowForModel(id: AccountAreaId, row: AreaRow, areas: RecordAreas) {
  const v = areaView(id, areas);
  return {
    [ACCOUNT_FIELD]: row.customerId,
    ...(id === "deployments" ? { deploymentId: row.deploymentId } : {}),
    title: recordTitle(v, row, String(row.displayName ?? row.deploymentId ?? row.customerId)),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    values: recordValues(v, row),
  };
}

/** list_<area>, as the definition says it. */
export function listAreaTool(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS) {
  const { list } = areaToolWords(id, areas);
  return defineTool({
    description: list,
    inputSchema: z.object({
      where: z.record(z.string(), z.unknown()).optional().describe("Conditions by field key, all of which must hold."),
      sort: z.string().optional().describe('Field keys, comma-separated; "-" before one for descending.'),
      q: z.string().max(200).optional().describe("Words to find in the record's text fields."),
      cursor: z.string().optional().describe("The `nextCursor` of the previous page."),
      limit: z.number().int().min(1).max(100).optional().describe("Rows per page (default 25)."),
    }),
    async execute(input, ctx) {
      if (!getDb()) throw new Error("This list needs the database, and none is configured.");
      const orgId = await orgForSession(ctx);
      const parsed = parseRecordQuery(id, { ...input, sort: input.sort ?? defaultSort(id, areas) }, areas, { defaultLimit: 25 });
      if (!parsed.ok) throw new Error(parsed.errors.join(" "));
      const t = tableOf(id);
      const q = compileRecordQuery(id, parsed.query, t, orgId, areas);
      const rows = await withOrgDb(orgId, (tx) => tx.select().from(t).where(q.where).orderBy(...q.orderBy).limit(q.limit + 1).offset(q.offset));
      const more = rows.length > q.limit;
      return {
        items: (more ? rows.slice(0, q.limit) : rows).map((r) => rowForModel(id, r as AreaRow, areas)),
        ...(more ? { nextCursor: encodeCursor(q.offset + q.limit) } : {}),
      };
    },
  });
}

/** upsert_<area>, as the definition says it. */
export function upsertAreaTool(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS) {
  const { fields, upsert, v } = areaToolWords(id, areas);
  const values = z.object(Object.fromEntries(fields.filter((f) => f.key !== "deploymentId").map((f) => [f.key, fieldParam(f)]))).describe(`The ${v.noun}'s fields to set, by key; null clears one.`);
  return defineTool({
    description: upsert,
    approval: once(),
    inputSchema: z.object({
      customerId: z.string().min(1).describe("The account id."),
      ...(id === "deployments" ? { deploymentId: z.string().min(1).describe(`"${v.area.id?.label ?? "Id"}"${v.area.id?.placeholder ? `, for example ${v.area.id.placeholder}` : ""}.`) } : {}),
      values,
    }),
    async execute(input, ctx) {
      if (!getDb()) throw new Error("Writing needs the database, and none is configured.");
      const orgId = await orgForSession(ctx);
      const actor = callerEmail(ctx);
      const { customerId, values: given } = input as { customerId: string; deploymentId?: string; values: Record<string, unknown> };
      const recordId = (input as { deploymentId?: string }).deploymentId;
      const t = tableOf(id);
      const where = id === "deployments" ? and(eq(t.orgId, orgId), eq(t.customerId, customerId), eq(deployments.deploymentId, recordId ?? ""))! : and(eq(t.orgId, orgId), eq(t.customerId, customerId))!;
      return withOrgDb(orgId, async (tx) => {
        const [before] = await tx.select().from(t).where(where);
        const body = Object.fromEntries(Object.entries(given ?? {}).filter(([, x]) => x !== undefined));
        if (id === "deployments" && !before) body.deploymentId = recordId;
        // The lifecycle (agent/lib/record-lifecycle.ts), as the routes keep it: who entered the stored state, for four
        // eyes; a refused move throws the rule book's sentence; the move goes to the activity feed with the write.
        const v = areaView(id, areas);
        const entity = { type: id === "deployments" ? ("deployment" as const) : ("implementation" as const), id: id === "deployments" ? String(recordId) : customerId };
        // The caller's role in the workspace, for a transition's `roles` and the area's permissions (read only when the
        // lifecycle is enforced or the area says who may write it).
        const role = enforced(v) || permissionsDeclared(id, areas) ? await memberRole(tx, orgId, actor) : undefined;
        const enteredBy = await enteredByOf(tx, orgId, v, entity, (before as AreaRow | undefined) ?? null);
        const prepared = prepareRecordWrite(id, before ? "update" : "create", body, { actor, role, before: (before as AreaRow | undefined) ?? null, enteredBy }, areas);
        if (!prepared.ok) throw new Error(prepared.conflict ? prepared.conflict.error : `Nothing was written. ${prepared.errors.join(" ")}`);
        const delta = prepared.customDelta ? ({ ...prepared.customDelta } as unknown as CustomDelta) : null;
        let row: Record<string, unknown> | undefined;
        if (before) {
          const set: Record<string, unknown> = { ...prepared.columns };
          delete set.deploymentId;
          if (delta) set.custom = customMergeSql(t.custom, delta, { empty: "object" });
          if (!Object.keys(set).length) throw new Error(`Nothing was written: \`values\` names nothing to change.`);
          [row] = await tx.update(t).set(set).where(where).returning();
        } else {
          // The account must be this workspace's: the foreign key names (org_id, customer_id), so another workspace's
          // account id is refused, never attached to.
          try {
            [row] = await tx.insert(t).values({ ...prepared.columns, ...(id === "deployments" ? { deploymentId: recordId } : {}), customerId, custom: prepared.custom, orgId } as never).returning();
          } catch (e) {
            // 23503: the foreign key to the account (org_id, customer_id), however the driver wraps it.
            for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
              if ((c as { code?: string }).code === "23503") throw new Error(`Unknown account: ${customerId}. Create it first (upsert_customer).`);
            }
            throw e;
          }
        }
        if (!row) throw new Error("It was removed while it was being written; send it again.");
        await writeOutcome(tx, orgId, entity, actor, v, prepared.lifecycle);
        return { [before ? "updated" : "created"]: true, record: rowForModel(id, row as AreaRow, areas), ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}) };
      });
    },
  });
}

// Built (and their spoken names registered) only where the definition turns them on: elsewhere the tool files
// export disableTool() and the model never meets them.
export const listDeploymentsTool = areaToolOn("deployments", "read") ? modelFacing("list_deployments", listAreaTool("deployments")) : null;
export const upsertDeploymentTool = areaToolOn("deployments", "write") ? modelFacing("upsert_deployment", upsertAreaTool("deployments")) : null;
export const listImplementationsTool = areaToolOn("implementations", "read") ? modelFacing("list_implementations", listAreaTool("implementations")) : null;
export const upsertImplementationTool = areaToolOn("implementations", "write") ? modelFacing("upsert_implementation", upsertAreaTool("implementations")) : null;
