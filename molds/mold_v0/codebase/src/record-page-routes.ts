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
 *        starts one; the run carries the record: src/runs.ts onRecord), move {to}, edit {title, data}, delete
 *
 * Who may: an action is offered (and taken) only by a role the action's `roles` and the area's own permission allow (the
 * kind's start tool for a run, the area's move and the transition's roles for a move, its update for an edit, its delete
 * for a delete, the target area's read for a link), never one the pack's MCP settings withhold. A disabled one (its
 * `unavailable` condition holds; no transition leaves the record's state) is refused with its reason (409). Writes go
 * through the data API (src/data-api.ts), whose checks are the record store's own; a related list reads the target area
 * as the person (its read permission), in the workspace's own scope only.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ACCOUNT_ROLE_LABELS, type AccountRole } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import type { Org } from "./auth.js";
import { dataApi, type DataCaller } from "./data-api.js";
import { featureOn } from "./features.js";
import { areaOpWithheld, packOpWithheld } from "./mcp-withheld.js";
import { permitted, startFromConsole, startToolOf } from "./mcp-tools.js";
import { detailTabId, linksBack, PackError, pageActionId, areaLinks, type DetailAction, type RecordDetailLayout, type RecordRow } from "./pack-api.js";
import { findArea, getFor, listFor, may, recordAreas, type Actor, type RecordArea } from "./record-areas.js";
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
const same = (a: unknown, b: unknown) => a === b || (typeof a !== "object" && a != null && String(a) === String(b));
/** A condition on the record's data (as the console's ./detail-layout.ts conditionHolds: a list field by any value). */
function holds(when: NonNullable<DetailAction["unavailable"]>[number]["when"], data: Record<string, unknown>): boolean {
  const v = data[when.field];
  const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
  const values = Array.isArray(v) ? v : [v];
  if (when.empty !== undefined) return empty === when.empty;
  if (when.equals !== undefined) return values.some((x) => same(x, when.equals));
  if (when.in) return values.some((x) => when.in!.some((y) => same(x, y)));
  if (when.not_in) return !empty && !values.some((x) => when.not_in!.some((y) => same(x, y)));
  return false;
}

/** A page action as this person may take it on this record. */
export interface ActionView {
  id: string; kind: DetailAction["kind"]; place: "primary" | "secondary" | "more"; label: string;
  /** Why it cannot be taken now (shown on hover and focus), or null. */
  disabled: string | null;
  /** What it asks before it acts (a delete always asks), or null. */
  confirm: string | null;
  /** start_run: the kind, its arguments pre-filled from the record, its environments. */
  run?: { kind: string; label: string; description: string | null; args: FormField[]; values: Record<string, unknown>; environments: string[] | null };
  /** move: the states it moves to, each with why it is disabled, if it is. */
  moves?: { to: string; label: string; disabled: string | null }[];
  /** edit: the form's fields (the lifecycle's and file fields left out: they are kept as they are; an area with an
   *  encrypted field has no edit). */
  fields?: FormField[];
  /** link: the record it opens. */
  target?: { area: string; key: string } | null;
}

/** The moves of `area`'s lifecycle `role` may make to `to` (any state when undefined), from any state. */
const movesFor = (area: RecordArea, role: AccountRole | null, to?: string) =>
  (area.lifecycle?.transitions ?? []).filter((t) => (to === undefined || t.to === to) && (role === null || !t.roles || t.roles.includes(role)));

/**
 * Each action of `area`'s page that `actor` may take on `record`, in declared order (one it may not take is left out):
 * labelled, with why it is disabled when it is. `withForms: false` (a related list's rows) leaves the edit form's fields
 * out: a row's edit opens the record's own page.
 */
export async function pageActions(area: RecordArea, record: RecordRow, actor: Actor, opts: { withForms?: boolean } = {}): Promise<ActionView[]> {
  const layout = layoutOf(area);
  if (!layout?.actions?.length) return [];
  const role = actor.role;
  const out: ActionView[] = [];
  const { formField } = await import("./tab-actions.js");
  for (const x of layout.actions) {
    if (role !== null && x.roles && !x.roles.includes(role)) continue;
    const base = { id: pageActionId(x), kind: x.kind, place: x.place ?? "more", confirm: x.confirm ?? (x.kind === "delete" ? `${record.title || record.key} is removed from ${area.label}, for everyone in this workspace. This can't be undone.` : null) } as const;
    const unavailable = (x.unavailable ?? []).find((u) => holds(u.when, record.data))?.reason ?? null;
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
        for (const [arg, from] of Object.entries(x.input ?? {})) {
          const v = from === "$key" ? record.key : from === "$title" ? record.title : record.data[from];
          if (v !== undefined && v !== null && v !== "") values[arg] = v;
        }
        const { environmentsOf } = await import("./tab-actions.js");
        out.push({ ...base, label: x.label ?? `Start ${label.charAt(0).toLowerCase()}${label.slice(1)}`, disabled: unavailable,
          run: { kind: k.name, label, description: (k as { description?: string }).description ?? null, args: ((k as { args?: unknown[] }).args ?? []).map(formField), values,
            environments: environmentsOf(tool.input) } });
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
        const l = areaLinks(area).find((y) => y.field === x.field);
        const target = l ? findArea(l.area) : null;
        if (!l || !target || !may(target, "read", actor)) continue;
        const v = record.data[l.field];
        const key = (Array.isArray(v) ? v : [v]).find((k): k is string => typeof k === "string" && k !== "") ?? null;
        const f = area.fields.find((y) => y.name === l.field);
        out.push({ ...base, label: x.label ?? `Open ${(f?.label ?? l.field).toLowerCase()}`, disabled: unavailable ?? (key ? null : `No ${(f?.label ?? l.field).toLowerCase()} is set on this record.`),
          target: key ? { area: target.name, key } : null });
        break;
      }
      case "copy_link":
        out.push({ ...base, label: x.label ?? "Copy link", disabled: unavailable });
        break;
    }
  }
  return out;
}

/** The filter that finds `target`'s records pointing at `key` through `field` (a list field: holding it). */
const pointingAt = (target: RecordArea, field: string, key: string) => {
  const f = target.fields.find((x) => x.name === field);
  return { [field]: f?.multiple || f?.type === "link" ? { contains: key } : key };
};
/** The field a related list points back through: its `via`, else the target's one field pointing at `area`. */
export const viaOf = (area: string, target: RecordArea, related: { via?: string }) => related.via ?? linksBack(target, area)[0] ?? null;

/** Who started a run, in words (as Usage's runs: src/app.ts): you, a member's address, a schedule, staff, a connector key. */
async function byWords(s: Session) {
  let members: { user_id: string; email?: string | null }[] = [];
  try { members = (await (await import("./admin.js")).team(s.slug)).members as typeof members; } catch { /* the directory unreachable: no addresses */ }
  return (id: string | null) => (id?.startsWith("schedule:") ? "Schedule" : id?.startsWith("staff:") ? "Staff" : id
    ? (id === s.user ? "You" : members.find((m) => m.user_id === id)?.email ?? "A member") : "Connector key");
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

  r.get("/:area/:key", answer(async (req, res) => {
    const { area, layout, record } = await recordOf(req, res);
    const actor = actorOf(res), org = session(res).org;
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
        // The target area's read permission, and its list not withheld: else the section is not drawn at all.
        if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) { sections[id] = { hidden: true }; continue; }
        const limit = s.related.limit ?? 5;
        const sortField = s.related.sort?.field ?? "updated_at";
        const sort = `${(s.related.sort?.direction ?? (s.related.sort ? "asc" : "desc")) === "desc" ? "-" : ""}${sortField}`;
        const page = await listFor(org, target.name, { filter: pointingAt(target, via, record.key), sort, limit: limit + 1 }, actor);
        const rows = page.records.slice(0, limit);
        sections[id] = {
          area: target.name, via, more: page.records.length > limit,
          records: await Promise.all(rows.map(async (row) => ({ key: row.key, title: row.title, data: row.data, updated_at: row.updated_at,
            actions: await pageActions(target, row, actor, { withForms: false }) }))),
        };
      } else if (s.runs) {
        const { recordRuns } = await import("./runs.js");
        const kinds = s.runs.kinds ? s.runs.kinds.map((k) => `${area.pack}/${k}`) : null;
        const got = await withTenant(org, () => recordRuns(org, { area: area.name, key: record.key }, { kinds, limit: s.runs!.limit ?? 5 }));
        by ??= await byWords(session(res));
        // A pack whose runs list its MCP settings withhold lists none here either (mold_v0-067).
        const shown = got.runs.filter((x) => !packOpWithheld(x.pack, "list_runs"));
        sections[id] = { total: got.total - (got.runs.length - shown.length), runs: shown.map(({ requested_by, ...x }) => ({ ...x, by: by!(requested_by) })) };
      }
    }
    return { actions: await pageActions(area, record, actor), sections };
  }));

  r.post("/:area/:key/actions/:id", answer(async (req, res) => {
    const { area, record } = await recordOf(req, res);
    const actor = actorOf(res);
    const id = String(req.params.id);
    const declared = (layoutOf(area)!.actions ?? []).find((x) => pageActionId(x) === id);
    if (!declared) throw new PackError("This page has no such action", 404);
    const a = (await pageActions(area, record, actor)).find((x) => x.id === id);
    const role = actor.role ? ACCOUNT_ROLE_LABELS[actor.role] : null;
    if (!a) throw new PackError(`${declared.label ?? id} is not open to the ${role ?? "caller's"} role on ${area.label} records.`, 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    switch (a.kind) {
      case "start_run": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        const s = session(res);
        const tool = startToolOf(area.pack, declared.job_kind!)!;
        const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? { ...(body.input as Record<string, unknown>) } : {};
        // An asset area's record is also the run's target, as the start tool's target_asset names one.
        if ("target_asset" in tool.input && area.role === "asset") input.target_asset = { area: area.name, key: record.key };
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
        const v = body as { title?: unknown; data?: unknown };
        if (!v.data || typeof v.data !== "object" || Array.isArray(v.data)) throw new PackError("give {title?, data}", 400);
        // What the form leaves out (the lifecycle's field, file fields) stays as it is.
        const kept = Object.fromEntries(Object.entries(record.data).filter(([k]) => !a.fields?.some((f) => f.name === k)));
        return dataApi.update(callerOf(res), area.name, record.key, { title: typeof v.title === "string" ? v.title : record.title, data: { ...kept, ...(v.data as Record<string, unknown>) } });
      }
      case "delete": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        return { deleted: await dataApi.delete(callerOf(res), area.name, record.key) };
      }
      default:
        throw new PackError(`${a.label} happens in the browser: nothing to send`, 400);
    }
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

