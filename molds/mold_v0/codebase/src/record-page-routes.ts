/**
 * A record's page, part 2 (mold_v0-254, flag record_pages; the area's `detail`, src/pack-api.ts RecordDetailSchema):
 * what a laid-out record page reads beyond the record itself, and its actions, for a signed-in person of a workspace
 * (the portal's session check, src/app.ts). Mounted before /api/records (src/http.ts); while the flag is off, or no area
 * declares a layout, every request passes on and /api/records answers it as before (404: no area is named "_page").
 *
 *   GET  /api/records/_page/<area>/<key>[?tab=<id>]
 *        {actions, sections}: the page's actions this person may take on the record (each with why it is disabled, when
 *        it is), and the open tab's related lists and runs (a section the person may not read: {hidden: true})
 *   POST /api/records/_page/<area>/<key>/actions/<id>
 *        take one of them: start_run {input} (a run of the kind on this record, started as its generated start tool
 *        starts one; the run carries the record: src/runs.ts onRecord), move {to}, edit {title, data}, delete,
 *        start_agent (mold_v0-261, flag agent_harness: a workspace agent session with the action's profile, its first
 *        message filled from the record here, never from the browser; the session links back to the record)
 *
 * Who may: an action is offered (and taken) only by a role the action's `roles` and the area's own permission allow (the
 * kind's start tool for a run, the area's move and the transition's roles for a move, its update for an edit, its delete
 * for a delete, the target area's read for a link), never one the pack's MCP settings withhold. A disabled one (its
 * `unavailable` condition holds; no transition leaves the record's state) is refused with its reason (409). Writes go
 * through the data API (src/data-api.ts), whose checks are the record store's own; a related list reads the target area
 * as the person (its read permission), in the workspace's own scope only.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ACCOUNT_ROLE_LABELS, canAccount, type AccountRole } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import type { Org } from "./auth.js";
import { dataApi, type DataCaller } from "./data-api.js";
import { featureOn } from "./features.js";
import { areaOpWithheld, packOpWithheld } from "./mcp-withheld.js";
import { permitted, startFromConsole, startToolOf } from "./mcp-tools.js";
import { packs } from "./packs.js";
import { ReferenceWhereSchema, type ReferenceWhere, COMPUTED_COUNT_MAX, conditionHolds, detailTabId, type DetailCondition, inputField, isRelatedColumn, relatedColumnId, linksBack, PackError, pageActionId, areaLinks, type DetailAction, type RecordDetailLayout, type RecordRow } from "./pack-api.js";
import { changedByWords, recordHistory } from "./record-history.js";
import { findArea, getFor, isReadOnlyArea, listFor, may, recordAreas, withRefTitles, type Actor, type RecordArea } from "./record-areas.js";
import { withTenant } from "./tenant-scope.js";

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.status(status).json(await fn(req, res)); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

type Layout = RecordDetailLayout;
const layoutOf = (a: RecordArea): Layout | null => (a as RecordArea & { detail?: Layout }).detail ?? null;
/** Whether /api/records/_page answers (the flag on and an area laid out); else every request passes on (features-test reads it). */
export const pageRoutesOn = () => featureOn("record_pages") && recordAreas().some((a) => !!layoutOf(a));
const served = pageRoutesOn;

/** A field as the console's form draws it (src/tab-actions.ts FormField). */
type FormField = import("./tab-actions.js").FormField;

/** The words of a state (its option's label, else its value). */
const stateWords = (area: RecordArea, v: unknown) => {
  const f = area.lifecycle ? area.fields.find((x) => x.name === area.lifecycle!.field) : undefined;
  const o = f?.options?.find((x) => (typeof x === "string" ? x : x.value) === v);
  return o && typeof o !== "string" ? o.label ?? o.value : String(v ?? "none");
};
const roleWords = (roles: readonly string[]) => roles.map((r) => (ACCOUNT_ROLE_LABELS[r as AccountRole] ?? r).toLowerCase()).join(", ");
/** A condition on the record (src/pack-api.ts conditionHolds, mold_v0-256: dates, a clock's state, all and any too). */
const holds = (when: DetailCondition, data: Record<string, unknown>, clocks?: unknown) => conditionHolds(when, data, (clocks ?? null) as never);
const same = (a: unknown, b: unknown) => a === b || (typeof a !== "object" && a != null && String(a) === String(b));

/** A page action as this person may take it on this record. */
export interface ActionView {
  id: string; kind: DetailAction["kind"]; place: "primary" | "secondary" | "more"; label: string;
  /** Why it cannot be taken now (shown on hover and focus), or null. */
  disabled: string | null;
  /** What it asks before it acts (a delete always asks), or null. */
  confirm: string | null;
  /** start_run: the kind, its arguments pre-filled from the record, its environments. */
  run?: { kind: string; label: string; description: string | null; args: FormField[]; values: Record<string, unknown>; environments: string[] | null;
    /** mold_v0-256: the linked record the run targets (target: {via}), in place of this one. */
    target?: { area: string; key: string; title: string | null } | null };
  /** move: the states it moves to, each with why it is disabled, if it is. */
  moves?: { to: string; label: string; disabled: string | null }[];
  /** edit: the form's fields (the lifecycle's and file fields left out: they are kept as they are; an area with an
   *  encrypted field has no edit). */
  fields?: FormField[];
  /** link: the record it opens. */
  target?: { area: string; key: string } | null;
  /**
   * create_record (mold_v0-256): a new record of `area`, its fields filled from this record (`values`); with forms, the
   * area's create form (its fields, whether its files upload, whether its Key follows its Title).
   */
  create?: { area: string; label: string; values: Record<string, unknown>; fields?: FormField[]; upload_max?: number | null; key_from_title?: boolean };
  /** start_agent (mold_v0-261): the agent profile it starts and the first message, filled from this record. */
  agent?: { profile: string; name: string; version: number; message: string };
  /** open_url (mold_v0-262): the web address it opens in a new tab (null: the field holds none). */
  url?: string | null;
}

/** The moves of `area`'s lifecycle `role` may make to `to` (any state when undefined), from any state. */
const movesFor = (area: RecordArea, role: AccountRole | null, to?: string) =>
  (area.lifecycle?.transitions ?? []).filter((t) => (to === undefined || t.to === to) && (role === null || !t.roles || t.roles.includes(role)));

/**
 * Each action of `area`'s page that `actor` may take on `record`, in declared order (one it may not take is left out):
 * labelled, with why it is disabled when it is. `withForms: false` (a related list's rows) leaves the edit form's fields
 * out: a row's edit opens the record's own page.
 */
/** mold_v0-260: whether a start tool's `record` takes records of this area (its enum of areas). */
function recordAreaAllowed(tool: { input: Record<string, unknown> }, area: string): boolean {
  const r = tool.input.record as unknown as { safeParse?: (v: unknown) => { success: boolean } } | undefined;
  return !!r?.safeParse && r.safeParse({ area, key: "k" }).success;
}
const findKindSync = (pack: string, kind: string) => {
  const p = packs().find((x) => x.id === pack);
  return ([...(p?.definition.jobKinds ?? []), ...(p?.definition.agentJobKinds ?? [])] as { name: string; input_from_record?: Record<string, string> }[]).find((k) => k.name === kind) ?? null;
};

export async function pageActions(area: RecordArea, record: RecordRow, actor: Actor, opts: { withForms?: boolean; org?: number } = {}): Promise<ActionView[]> {
  const layout = layoutOf(area);
  if (!layout?.actions?.length) return [];
  const role = actor.role;
  const out: ActionView[] = [];
  const { formField } = await import("./tab-actions.js");
  for (const x of layout.actions) {
    if (role !== null && x.roles && !x.roles.includes(role)) continue;
    const base = { id: pageActionId(x), kind: x.kind, place: x.place ?? "more", confirm: x.confirm ?? (x.kind === "delete" ? `${record.title || record.key} is removed from ${area.label}, for everyone in this workspace. This can't be undone.` : null) } as const;
    const unavailable = (x.unavailable ?? []).find((u) => holds(u.when, record.data, (record as { clocks?: unknown }).clocks))?.reason ?? null;
    const writes = area.scope === "workspace";
    switch (x.kind) {
      case "start_run": {
        const tool = startToolOf(area.pack, x.job_kind!);
        if (!tool || !permitted(tool, role) || !may(area, "read", actor)) continue;
        const { findKind } = await import("./runs.js");
        const k = findKind(area.pack, x.job_kind!);
        if (!k) continue;
        const label = (k as { label?: string }).label ?? k.name;
        const values: Record<string, unknown> = {};
        // mold_v0-260 (flag record_run_inputs): the kind's own input_from_record first, then the action's input over it;
        // the arguments the record gives are the server's (from_record: the form shows them, never sends them).
        const fromKind = tool.input.record ? ((k as { input_from_record?: Record<string, string> }).input_from_record ?? {}) : {};
        const fromRecord: string[] = [];
        for (const [arg, from] of [...Object.entries(fromKind), ...Object.entries(x.input ?? {})]) {
          const v = from === "$key" ? record.key : from === "$title" ? record.title : record.data[from];
          if (v !== undefined && v !== null && v !== "") { values[arg] = v; if (arg in fromKind && !fromRecord.includes(arg)) fromRecord.push(arg); }
        }
        const { environmentsOf } = await import("./tab-actions.js");
        // mold_v0-256: a run on the record a link field names (the finding's application), found in the area it belongs to.
        let target: { area: string; key: string; title: string | null } | null | undefined;
        let noTarget: string | null = null;
        if (x.target) {
          target = await linkedRecord(opts.org ?? null, area, x.target.via, record, actor);
          const f = area.fields.find((y) => y.name === x.target!.via);
          if (!target) noTarget = `No ${(f?.label ?? x.target.via).toLowerCase()} is set on this record, so there is nothing to run on.`;
        }
        out.push({ ...base, label: x.label ?? `Start ${label.charAt(0).toLowerCase()}${label.slice(1)}`, disabled: unavailable ?? noTarget,
          run: { kind: k.name, label, description: (k as { description?: string }).description ?? null, args: ((k as { args?: unknown[] }).args ?? []).map(formField), values,
            environments: environmentsOf(tool.input), ...(x.target ? { target: target ?? null } : {}), ...(fromRecord.length ? { from_record: fromRecord } : {}) } });
        break;
      }
      case "move": {
        if (!writes || !area.lifecycle || !may(area, "move", actor) || areaOpWithheld(area.name, "move")) continue;
        const ways = movesFor(area, role, x.to);
        if (!ways.length) continue; // this role makes none of its moves, from any state
        const from = record.data[area.lifecycle.field];
        const targets = [...new Set(ways.map((t) => t.to))];
        const moves = targets.map((to) => {
          const label = ways.find((t) => t.to === to && t.label)?.label ?? `Move to ${stateWords(area, to)}`;
          const here = (t: { from: "*" | string[] }) => t.from === "*" || (typeof from === "string" && t.from.includes(from));
          const anyRole = (area.lifecycle!.transitions).filter((t) => t.to === to && here(t));
          const disabled = same(from, to) ? `It is already ${stateWords(area, to)}.`
            : ways.some((t) => t.to === to && here(t)) ? null
            : anyRole.length ? `Only ${roleWords([...new Set(anyRole.flatMap((t) => t.roles ?? []))])} can move it from ${stateWords(area, from)} to ${stateWords(area, to)}.`
            : `It can't move from ${stateWords(area, from)} to ${stateWords(area, to)}.`;
          return { to, label, disabled };
        });
        const open = moves.filter((m) => !m.disabled);
        const label = x.label ?? (x.to !== undefined ? moves[0]!.label : "Move");
        const disabled = unavailable ?? (open.length ? null : x.to !== undefined ? moves[0]!.disabled : `Nothing you can do moves it from ${stateWords(area, from)}.`);
        // Without a state of its own, the states it can move to now (the rest stay listed, disabled, with why).
        out.push({ ...base, label, disabled, moves });
        break;
      }
      case "edit": {
        if (!writes || !may(area, "update", actor) || areaOpWithheld(area.name, "update") || area.fields.some((f) => f.encrypted)) continue;
        const fields = area.fields.filter((f) => f.type !== "file" && f.name !== area.lifecycle?.field);
        out.push({ ...base, label: x.label ?? "Edit", disabled: unavailable, ...(opts.withForms === false ? {} : { fields: fields.map(formField) }) });
        break;
      }
      case "delete": {
        if (!writes || !may(area, "delete", actor) || areaOpWithheld(area.name, "delete")) continue;
        out.push({ ...base, label: x.label ?? "Delete", disabled: unavailable });
        break;
      }
      case "link": {
        // mold_v0-256: a field linking to several areas opens the area its value belongs to, not the first declared.
        const ls = areaLinks(area).filter((y) => y.field === x.field).filter((y) => { const t = findArea(y.area); return !!t && may(t, "read", actor); });
        if (!ls.length) continue;
        const found = await linkedRecord(opts.org ?? null, area, x.field!, record, actor);
        const f = area.fields.find((y) => y.name === x.field);
        out.push({ ...base, label: x.label ?? `Open ${(f?.label ?? x.field!).toLowerCase()}`, disabled: unavailable ?? (found ? null : `No ${(f?.label ?? x.field!).toLowerCase()} is set on this record.`),
          target: found ? { area: found.area, key: found.key } : null });
        break;
      }
      case "copy_link":
        out.push({ ...base, label: x.label ?? "Copy link", disabled: unavailable });
        break;
      case "open_url": {
        // mold_v0-262: a web address from the record (an http or https one only), opened in a new tab by the page.
        const f = area.fields.find((y) => y.name === x.field);
        if (!f || f.encrypted) continue;
        const v = record.data[x.field!];
        const url = typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v.trim()) && URL.canParse(v.trim()) ? v.trim() : null;
        out.push({ ...base, label: x.label ?? `Open ${f.label.toLowerCase()}`, disabled: unavailable ?? (url ? null : `No ${f.label.toLowerCase()} is set on this record.`), url });
        break;
      }
      case "start_agent": {
        // mold_v0-261 (flag agent_harness): a session with the action's profile, for a role that may start it (else not shown).
        if (area.scope !== "workspace" || !may(area, "read", actor) || opts.org === undefined) continue;
        if (role !== null && !canAccount(role, "launch")) continue;
        const { profileOffer } = await import("./agent-profiles.js");
        const prof = await profileOffer(x.profile!, opts.org, { kind: actor.userId ? "person" : "key", role });
        if (!prof) continue;
        const { fillTemplate } = await import("./agent-profile-spec.js");
        out.push({ ...base, label: x.label ?? `Start ${prof.name}`, disabled: unavailable ?? prof.disabled,
          agent: { profile: prof.id, name: prof.name, version: prof.version, message: fillTemplate(x.first_message ?? "", record) } });
        break;
      }
      case "create_record": {
        // A new record of another workspace area: that area's create permission (its read too), never a withheld create.
        const target = findArea(x.area!);
        if (!target || target.scope !== "workspace" || isReadOnlyArea(target) || !may(target, "read", actor) || !may(target, "create", actor) || areaOpWithheld(target.name, "create")) continue;
        const values: Record<string, unknown> = {};
        for (const [f, raw] of Object.entries(x.input ?? {})) {
          const from = inputField(raw);
          const v = from === null ? (raw === "$key" ? record.key : record.title) : record.data[from];
          if (v !== undefined && v !== null && v !== "") values[f] = v;
        }
        const singular = target.label.replace(/ies$/i, "y").replace(/(?<!s)s$/i, "");
        const { uploadMax } = await import("./record-files.js");
        out.push({ ...base, label: x.label ?? `Add ${singular.charAt(0).toLowerCase()}${singular.slice(1)}`, disabled: unavailable,
          create: { area: target.name, label: target.label, values, ...(opts.withForms === false ? {} : { fields: target.fields.map(formField), upload_max: uploadMax(target),
            ...((target as { key_from_title?: boolean }).key_from_title ? { key_from_title: true } : {}) }) } });
        break;
      }
    }
  }
  return out;
}

/**
 * The record `area`'s link or reference field `field` names on `record` (mold_v0-256): its first key, in the area it
 * belongs to. One area: that one (as before). Several: the first of them, in declared order, where this person reads a
 * record of that key (in workspace `org`, read with its title); none found, the first readable one's. Null when the field
 * is empty.
 */
export async function linkedRecord(org: number | null, area: RecordArea, field: string, record: RecordRow, actor: Actor): Promise<{ area: string; key: string; title: string | null } | null> {
  const v = record.data[field];
  const key = (Array.isArray(v) ? v : [v]).find((k): k is string => typeof k === "string" && k !== "") ?? null;
  if (!key) return null;
  const ls = areaLinks(area).filter((y) => y.field === field).map((y) => findArea(y.area)).filter((t): t is RecordArea => !!t && may(t, "read", actor));
  if (!ls.length) return null;
  if (org === null) return { area: ls[0]!.name, key, title: null };
  for (const t of ls) {
    const got = await getFor(org, t.name, key, actor).catch(() => null);
    if (got) return { area: t.name, key, title: got.title };
  }
  return { area: ls[0]!.name, key, title: null };
}

/** The filter that finds `target`'s records pointing at `key` through `field` (a list field: holding it). */
const pointingAt = (target: RecordArea, field: string, key: string) => {
  const f = target.fields.find((x) => x.name === field);
  return { [field]: f?.multiple || f?.type === "link" ? { contains: key } : key };
};
/** The field a related list points back through: its `via`, else the target's one field pointing at `area`. */
export const viaOf = (area: string, target: RecordArea, related: { via?: string }) => related.via ?? linksBack(target, area)[0] ?? null;

type Fact = NonNullable<NonNullable<Layout["header"]>["facts"]>[number];
/** A computed fact's answer (mold_v0-256): a count, the latest related record's value, or hidden from this person. */
export type ComputedAnswer = { hidden: true } | { op: "count"; value: number; capped: boolean; area: string; via: string }
  | { op: "latest"; value: unknown; area: string; field: string; record: { key: string; title: string | null } | null };
/**
 * A fact computed from the records of another area that point back to `record` (mold_v0-256), read as the person (the
 * area's read permission, its list not withheld; else hidden), in the workspace's own scope, a page at a time: `count`
 * those its `where` keeps (at most COMPUTED_COUNT_MAX, then "capped"), or `latest`: its `field` on the first of them by
 * `sort` (default the newest change). An encrypted field is never read (the build refuses one).
 */
export async function computedFact(org: number, area: RecordArea, record: RecordRow, fact: Fact, actor: Actor): Promise<ComputedAnswer> {
  const c = fact.computed!;
  const target = findArea(c.area);
  const via = target ? viaOf(area.name, target, c) : null;
  if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) return { hidden: true };
  const filter = pointingAt(target, via, record.key);
  const keeps = (row: RecordRow) => !c.where || holds(c.where, row.data, (row as { clocks?: unknown }).clocks);
  if (c.op === "count") {
    let n = 0, after: string | undefined;
    for (;;) {
      const page = await listFor(org, target.name, { filter, limit: 200, ...(after ? { after } : {}) }, actor);
      n += page.records.filter(keeps).length;
      if (n >= COMPUTED_COUNT_MAX) return { op: "count", value: COMPUTED_COUNT_MAX, capped: true, area: target.name, via };
      if (!page.next) return { op: "count", value: n, capped: false, area: target.name, via };
      after = page.next;
    }
  }
  const sortField = c.sort?.field ?? "updated_at";
  const sort = `${(c.sort?.direction ?? "desc") === "desc" ? "-" : ""}${sortField}`;
  let after: string | undefined;
  for (let read = 0; read < COMPUTED_COUNT_MAX;) {
    const page = await listFor(org, target.name, { filter, sort, limit: c.where ? 100 : 1, ...(after ? { after } : {}) }, actor);
    read += page.records.length;
    const row = page.records.find(keeps);
    if (row) return { op: "latest", value: row.data[c.field!] ?? null, area: target.name, field: c.field!, record: { key: row.key, title: row.title } };
    if (!page.next) break;
    after = page.next;
  }
  return { op: "latest", value: null, area: target.name, field: c.field!, record: null };
}

/** The record picker's page: at most PICK_MAX choices, from the PICK_SCAN newest records. */
const PICK_MAX = 20, PICK_SCAN = 2000;
/**
 * A tab column computed from related records (mold_v0-256), for the rows `keys` of `area`: the records of the column's
 * area pointing at them (read as the person, the workspace's own scope, at most COMPUTED_COUNT_MAX), counted per row or
 * the newest one's field. A role that may not read that area: {hidden: true}.
 */
async function relatedColumn(org: number, area: RecordArea, c: import("./pack-api.js").TabRelatedColumn, keys: string[], actor: Actor): Promise<Record<string, unknown> | { hidden: true }> {
  const target = findArea(c.related.area);
  const via = target ? viaOf(area.name, target, c.related) : null;
  if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) return { hidden: true };
  const out: Record<string, unknown> = {};
  const latest = c.show.startsWith("latest:") ? c.show.slice(7) : null;
  for (const k of keys) out[k] = latest ? null : 0;
  if (!keys.length) return out;
  const f = target.fields.find((x) => x.name === via);
  const many = !!(f?.multiple || f?.type === "link");
  let after: string | undefined, read = 0;
  while (read < COMPUTED_COUNT_MAX) {
    // Newest change first: the first row seen for a key is its latest.
    const page = await listFor(org, target.name, { filter: many ? {} : { [via]: { in: keys } }, sort: "-updated_at", limit: 200, ...(after ? { after } : {}) }, actor);
    read += page.records.length;
    for (const row of page.records) {
      const v = row.data[via];
      for (const k of (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x in out)) {
        if (latest) { if (out[k] === null) out[k] = row.data[latest] ?? null; } else out[k] = (out[k] as number) + 1;
      }
    }
    if (!page.next) break;
    after = page.next;
  }
  return out;
}

/** Who started a run, in words (as Usage's runs: src/app.ts): you, a member's address, a schedule, staff, a connector key. */
export async function byWords(s: Session) {
  let members: { user_id: string; email?: string | null }[] = [];
  try { members = (await (await import("./admin.js")).team(s.slug)).members as typeof members; } catch { /* the directory unreachable: no addresses */ }
  return (id: string | null) => (id?.startsWith("schedule:") ? "Schedule" : id?.startsWith("staff:") ? "Staff" : id
    ? (id === s.user ? "You" : members.find((m) => m.user_id === id)?.email ?? "A member") : "Connector key");
}

/** A history section's lines as the page shows them: who in words, each field's before and after (encrypted: redacted). */
async function historyOf(org: number, area: RecordArea, key: string, h: { fields?: string[]; limit?: number }, before: number | null, by: (id: string | null) => string) {
  const got = await recordHistory(org, area, key, { limit: h.limit ?? 20, before, fields: h.fields ?? null });
  const person = (id: string) => by(id);
  return { more: got.more, changes: got.lines.map((l) => ({ id: l.id, at: l.at, action: l.action, by: changedByWords(l.by, person), title: l.title, changes: l.changes })) };
}

export function recordPageRouter(): Router {
  const r = express.Router();
  if (!recordAreas().length) return r;
  // While the flag is off or nothing is laid out, every request passes on (/api/records answers it, as before).
  r.use((_req, _res, next) => (served() ? next() : next("router")));
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "1mb" }));
  r.use(customerSession);
  // A cross-site form cannot send a custom header: a change riding the session cookie must carry this one.
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const session = (res: Response) => res.locals.session as Session;
  const actorOf = (res: Response): Actor => ({ role: session(res).accountRole ?? null, userId: session(res).user ?? null });
  const callerOf = (res: Response): DataCaller => ({ orgId: session(res).org, role: session(res).accountRole ?? null, userId: session(res).user ?? null });
  /** The laid-out area and the record, as the person reads it (its read permission; 404 when there is none). */
  const recordOf = async (req: Request, res: Response) => {
    const area = findArea(String(req.params.area));
    if (!area || !layoutOf(area) || areaOpWithheld(area.name, "get")) throw new PackError("Not found", 404);
    const record = await getFor(session(res).org, area.name, String(req.params.key), actorOf(res));
    if (!record) throw new PackError("Not found", 404);
    return { area, layout: layoutOf(area)!, record };
  };

  // mold_v0-256: a reference field's choices (the console's record picker): the records of `area` this person may read,
  // the workspace's own (and shared ones), those whose title or key holds every word of ?q, newest change first, at most 20.
  r.get("/_pick/:area", answer(async (req, res) => {
    const area = findArea(String(req.params.area));
    if (!area || areaOpWithheld(area.name, "list")) throw new PackError("Not found", 404);
    const actor = actorOf(res);
    if (!may(area, "read", actor)) throw new PackError(`Your role can't read ${area.label}.`, 403);
    const words = String(req.query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    // mold_v0-260 (flag record_rules): a reference's where narrows the list (only ever narrows: every write checks it too).
    let where: ReferenceWhere | null = null;
    if (req.query.where !== undefined && featureOn("record_rules")) {
      let raw: unknown = null;
      try { raw = JSON.parse(String(req.query.where)); } catch { raw = null; }
      const w = ReferenceWhereSchema.safeParse(raw);
      if (!w.success) throw new PackError("where: a reference's condition", 400);
      where = w.data;
    }
    const keeps = (x: { data?: Record<string, unknown> }) => !where || conditionHolds(where as DetailCondition, x.data ?? {});
    const out: { key: string; title: string | null }[] = [];
    let after: string | undefined, read = 0, more = false;
    while (read < PICK_SCAN) {
      const page = await listFor(session(res).org, area.name, { sort: "-updated_at", limit: 200, ...(after ? { after } : {}) }, actor);
      read += page.records.length;
      for (const x of page.records) if (keeps(x) && words.every((w) => x.key.toLowerCase().includes(w) || (x.title ?? "").toLowerCase().includes(w))) out.push({ key: x.key, title: x.title });
      if (out.length > PICK_MAX || !page.next) { more = out.length > PICK_MAX || (!!page.next && read >= PICK_SCAN); break; }
      after = page.next;
    }
    return { records: out.slice(0, PICK_MAX), more };
  }));

  // mold_v0-256: a tab's columns computed from related records, for the rows of ?keys= (comma-separated, at most 200).
  r.get("/_columns/:pack/:tab", answer(async (req, res) => {
    const { buildViews } = await import("./metrics.js");
    const tab = buildViews().tabs.find((t) => t.pack === String(req.params.pack) && t.id === String(req.params.tab) && t.kind === "area" && !t.areas);
    const area = tab?.area ? findArea(tab.area) : null;
    if (!tab || !area || areaOpWithheld(area.name, "list")) throw new PackError("Not found", 404);
    const actor = actorOf(res);
    if (!may(area, "read", actor)) throw new PackError(`Your role can't read ${area.label}.`, 403);
    const keys = [...new Set(String(req.query.keys ?? "").split(",").map((k) => k.trim()).filter(Boolean))].slice(0, 200);
    const columns: Record<string, Record<string, unknown> | { hidden: true }> = {};
    for (const c of (tab.columns ?? []).filter(isRelatedColumn)) columns[relatedColumnId(c)] = await relatedColumn(session(res).org, area, c, keys, actor);
    return { columns };
  }));

  r.get("/:area/:key", answer(async (req, res) => {
    const { area, layout, record } = await recordOf(req, res);
    const actor = actorOf(res), org = session(res).org;
    // mold_v0-256: the header's computed facts, each as this person may read it (index -> answer).
    const facts: Record<string, ComputedAnswer> = {};
    for (const [i, f] of (layout.header?.facts ?? []).entries()) if (f.computed) facts[String(i)] = await computedFact(org, area, record, f, actor);
    const asked = typeof req.query.tab === "string" ? req.query.tab : null;
    const tab = layout.tabs.find((t) => detailTabId(t.label) === asked) ?? layout.tabs[0]!;
    const ti = layout.tabs.indexOf(tab);
    const sections: Record<string, unknown> = {};
    let by: ((id: string | null) => string) | null = null;
    for (const [si, s] of tab.sections.entries()) {
      const id = `${ti}-${si}`;
      if (s.related) {
        const target = findArea(s.related.area);
        const via = target ? viaOf(area.name, target, s.related) : null;
        // mold_v0-256: matched on a field: their via holds this record's match_field value (nothing to match: none listed).
        const matchOn = s.related.match_field !== undefined ? record.data[s.related.match_field] : record.key;
        // The target area's read permission, and its list not withheld: else the section is not drawn at all.
        if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) { sections[id] = { hidden: true }; continue; }
        const limit = s.related.limit ?? 5;
        const sortField = s.related.sort?.field ?? "updated_at";
        const sort = `${(s.related.sort?.direction ?? (s.related.sort ? "asc" : "desc")) === "desc" ? "-" : ""}${sortField}`;
        if (matchOn == null || matchOn === "" || typeof matchOn === "object") { sections[id] = { area: target.name, via, match: null, more: false, records: [] }; continue; }
        const page = await listFor(org, target.name, { filter: s.related.match_field !== undefined ? { [via]: matchOn } : pointingAt(target, via, record.key), sort, limit: limit + 1 }, actor);
        // mold_v0-262: each row's references' titles (its cells show them, linked).
        const rows = await withRefTitles(org, target, page.records.slice(0, limit), actor);
        sections[id] = {
          area: target.name, via, match: String(matchOn), more: page.records.length > limit,
          records: await Promise.all(rows.map(async (row) => ({ key: row.key, title: row.title, data: row.data, updated_at: row.updated_at, ...(row.ref_titles ? { ref_titles: row.ref_titles } : {}),
            actions: await pageActions(target, row, actor, { withForms: false, org }) }))),
        };
      } else if (s.runs) {
        const { recordRuns } = await import("./runs.js");
        const kinds = s.runs.kinds ? s.runs.kinds.map((k) => `${area.pack}/${k}`) : null;
        const got = await withTenant(org, () => recordRuns(org, { area: area.name, key: record.key }, { kinds, limit: s.runs!.limit ?? 5 }));
        by ??= await byWords(session(res));
        // A pack whose runs list its MCP settings withhold lists none here either (mold_v0-067).
        const shown = got.runs.filter((x) => !packOpWithheld(x.pack, "list_runs"));
        // mold_v0-261 (flag agent_harness): the workspace agent sessions started from this record, beside its runs.
        const H = await import("./harness-sessions.js");
        const ss = await H.recordSessions(org, { area: area.name, key: record.key }, H.actorOf(session(res)), s.runs!.limit ?? 5);
        sections[id] = { total: got.total - (got.runs.length - shown.length), runs: shown.map(({ requested_by, ...x }) => ({ ...x, by: by!(requested_by) })),
          ...(ss.total ? { sessions: { total: ss.total, rows: ss.sessions.map((x) => ({ id: x.id, title: x.title, phase: x.phase, profile: x.profile, started_by: x.mine ? "You" : x.started_by,
            spent_usd: x.spent_usd, budget_usd: x.budget_usd, created_at: x.created_at, last_activity_at: x.last_activity_at })) } } : {}) };
      } else if (s.history) {
        // mold_v0-256: the record's changes, read as the person (the record's own read: it read the record above).
        by ??= await byWords(session(res));
        sections[id] = await historyOf(org, area, record.key, s.history, null, by);
      }
    }
    return { actions: await pageActions(area, record, actor, { org }), sections, facts };
  }));

  // mold_v0-256: a history section's older lines (Show more): ?section=<tab>-<section>&before=<line id>.
  r.get("/:area/:key/history", answer(async (req, res) => {
    const { area, layout, record } = await recordOf(req, res);
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(req.query.section ?? ""));
    const s = m ? layout.tabs[Number(m[1])]?.sections[Number(m[2])] : undefined;
    if (!s?.history) throw new PackError("section: a history section of this page (<tab>-<section>)", 400);
    const before = req.query.before === undefined ? null : Number(req.query.before);
    if (before !== null && (!Number.isInteger(before) || before < 1)) throw new PackError("before: a line's id", 400);
    return historyOf(session(res).org, area, record.key, s.history, before, await byWords(session(res)));
  }));

  r.post("/:area/:key/actions/:id", answer(async (req, res) => {
    const { area, record } = await recordOf(req, res);
    const actor = actorOf(res);
    const id = String(req.params.id);
    const declared = (layoutOf(area)!.actions ?? []).find((x) => pageActionId(x) === id);
    if (!declared) throw new PackError("This page has no such action", 404);
    const a = (await pageActions(area, record, actor, { org: session(res).org })).find((x) => x.id === id);
    const role = actor.role ? ACCOUNT_ROLE_LABELS[actor.role] : null;
    if (!a) throw new PackError(`${declared.label ?? id} is not open to the ${role ?? "caller's"} role on ${area.label} records.`, 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    switch (a.kind) {
      case "start_run": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        const s = session(res);
        const tool = startToolOf(area.pack, declared.job_kind!)!;
        const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? { ...(body.input as Record<string, unknown>) } : {};
        // An asset area's record is also the run's target, as the start tool's target_asset names one; mold_v0-256: or the
        // record its target's link field names (never one sent from the browser).
        if ("target_asset" in tool.input && area.role === "asset") input.target_asset = { area: area.name, key: record.key };
        // mold_v0-260: a tenant area's record is the run's tenant (its credentials bound to it reach the run).
        if ("target_tenant" in tool.input && (area as { tenant?: boolean }).tenant) input.target_tenant = { area: area.name, key: record.key };
        // mold_v0-260 (flag record_run_inputs): the arguments the kind takes from the record come from it here, on the
        // server, never from the browser (what the browser sent for them is dropped where the record has a value).
        const rec = tool.input.record as unknown as { def?: unknown } | undefined;
        if (rec && recordAreaAllowed(tool, area.name)) {
          const fromKind = (findKindSync(area.pack, declared.job_kind!)?.input_from_record ?? {}) as Record<string, string>;
          for (const [arg, f] of Object.entries(fromKind)) {
            const v = f === "$key" ? record.key : f === "$title" ? record.title : record.data[f];
            if (v !== undefined && v !== null && v !== "") delete input[arg];
          }
          input.record = { area: area.name, key: record.key };
        }
        if (declared.target) {
          if (!a.run?.target || !("target_asset" in tool.input)) throw new PackError(`${a.label} has no record to run on.`, 409);
          input.target_asset = { area: a.run.target.area, key: a.run.target.key };
        }
        const org: Org = { orgId: s.org, slug: s.slug, name: "", userId: s.user ?? undefined, role: s.accountRole };
        const { onRecord } = await import("./runs.js");
        return onRecord({ area: area.name, key: record.key }, () => startFromConsole(org, tool, input));
      }
      case "move": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        const to = declared.to ?? body.to;
        const m = a.moves?.find((x) => x.to === to);
        if (!m) throw new PackError(`${typeof to === "string" ? `${stateWords(area, to)} is` : "to is"} not a state this action moves ${area.label} records to${a.moves?.length ? ` (${a.moves.map((x) => x.to).join(", ")})` : ""}.`, 400);
        if (m.disabled) throw new PackError(m.disabled, 409);
        return dataApi.move(callerOf(res), area.name, record.key, m.to);
      }
      case "edit": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        const v = body as { title?: unknown; data?: unknown; visibility?: unknown };
        if (!v.data || typeof v.data !== "object" || Array.isArray(v.data)) throw new PackError("give {title?, data}", 400);
        // What the form leaves out (the lifecycle's field, file fields) stays as it is.
        const kept = Object.fromEntries(Object.entries(record.data).filter(([k]) => !a.fields?.some((f) => f.name === k)));
        // mold_v0-259 (flag teams): who sees it, when the form changed it (the record store checks who may).
        return dataApi.update(callerOf(res), area.name, record.key, { title: typeof v.title === "string" ? v.title : record.title, data: { ...kept, ...(v.data as Record<string, unknown>) },
          ...(v.visibility !== undefined ? { visibility: v.visibility } : {}) });
      }
      case "delete": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        return { deleted: await dataApi.delete(callerOf(res), area.name, record.key) };
      }
      case "start_agent": {
        // The first message is the record's, filled here (whatever the browser sends); the session carries the record.
        if (a.disabled) throw new PackError(a.disabled, 409);
        const s = session(res);
        const H = await import("./harness-sessions.js");
        const org: Org = { orgId: s.org, slug: s.slug, name: "", userId: s.user ?? undefined, role: s.accountRole };
        return { session: await H.startSession(s.org, H.actorOf(s), { message: a.agent!.message, profile: a.agent!.profile, title: `${a.agent!.name}: ${record.title || record.key}` }, org,
          { record: { area: area.name, key: record.key } }) };
      }
      default:
        throw new PackError(`${a.label} happens in the browser: nothing to send`, 400);
    }
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

