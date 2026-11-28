/**
 * A record's page, part 2 (mold_v0-254, flag record_pages; the area's `detail`, src/pack-api.ts RecordDetailSchema):
 * what a laid-out record page reads beyond the record itself, and its actions, for a signed-in person of a workspace
 * (the portal's session check, src/app.ts). Mounted before /api/records (src/http.ts); while the flag is off, or no area
 * declares a layout, every request passes on and /api/records answers it as before (404: no area is named "_page").
 *
 *   GET  /api/records/_page/<area>/<key>[?tab=<id>]
 *        {actions, sections}: the page's actions this person may take on the record (each with why it is disabled, when
 *        it is), and the open tab's related lists and runs (a section the person may not read: {hidden: true});
 *        mold_v0-310: `writers` {made, changed}, the run or agent session that made the record and those that changed it
 *        (src/record-runs.ts), and each history line's `run`
 *   POST /api/records/_page/<area>/<key>/actions/<id>
 *        take one of them: start_run {input} (a run of the kind on this record, started as its generated start tool
 *        starts one; the run carries the record: src/runs.ts onRecord), move {to}, edit {title, data}, delete,
 *        start_agent (mold_v0-261, flag agent_harness: a workspace agent session with the action's profile, its first
 *        message filled from the record here, never from the browser; the session links back to the record),
 *        start_program (mold_v0-303, flag nested_runs: the action's program, its inputs filled from the record here;
 *        src/program-start.ts),
 *        test_storage (mold_v0-305, flag workspace_storage: the declared object_storage area's record's bucket written,
 *        read and deleted once with its own settings; src/workspace-storage.ts testStorageRecord),
 *        test_connection (mold_v0-312: a workspace connection record's own call, its pack's probe made on the server
 *        with the record's fields; src/connection-test.ts testConnectionRecord)
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
import { HOP_RECORDS_MAX, type RecordsHop, personSets, ReferenceWhereSchema, type ReferenceWhere, COMPUTED_COUNT_MAX, conditionHolds, detailTabId, type DetailCondition, inputField, isRelatedColumn, relatedColumnId, linksBack, PackError, pageActionId, areaLinks, type DetailAction, type RecordDetailLayout, type RecordRow } from "./pack-api.js";
import { changedByWords, recordHistory } from "./record-history.js";
import { lineLinks, recordWriters } from "./record-runs.js";
import { asAction, findArea, getFor, inTransaction, recordQuery, recordStateTimes, getPlatform, isReadOnlyArea, listFor, listPlatform, may, recordAreas, withRefTitles, type Actor, type RecordArea } from "./record-areas.js";
const listForWorkspace = listFor;
import { formOffers } from "./secret-binding.js";
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
  moves?: { to: string; label: string; state: string; disabled: string | null }[];
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
  /** toggle (mold_v0-336): whether its boolean field is on now. */
  on?: boolean;
  /** mold_v0-336: drawn as a bare text link in place of the outlined button (declared `look: "link"`). */
  look?: "link";
  /** start_program (mold_v0-303): the program it starts, its inputs filled from this record, and how it runs. */
  program?: { id: string; name: string; version: number; via: "session" | "runner"; inputs: Record<string, unknown> };
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
    // mold_v0-339: an action offered only while its condition holds (the one that fits this record) is left out otherwise.
    if (x.show_when && !holds(x.show_when, record.data, (record as { clocks?: unknown }).clocks)) continue;
    const base = { id: pageActionId(x), kind: x.kind, place: x.place ?? "more", ...(x.look === "link" ? { look: "link" as const } : {}), confirm: x.confirm ?? (x.kind === "delete" ? `${record.title || record.key} is removed from ${area.label}, for everyone in this workspace. This can't be undone.` : null) } as const;
    let unavailable = (x.unavailable ?? []).find((u) => u.when && holds(u.when, record.data, (record as { clocks?: unknown }).clocks))?.reason ?? null;
    // mold_v0-337: or while a related record is open (a build of this application still running): read as the shell.
    if (!unavailable && opts.org !== undefined) for (const u of x.unavailable ?? []) {
      if (u.related && (await relatedOpen(opts.org, area, record.key, u.related, 1)).length) { unavailable = u.reason; break; }
    }
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
        // mold_v0-337: to_any keeps the states it offers (Remove is an action of its own).
        const ways = movesFor(area, role, x.to).filter((t) => !x.to_any || x.to_any.includes(t.to));
        if (!ways.length) continue; // this role makes none of its moves, from any state
        const from = record.data[area.lifecycle.field] ?? area.lifecycle.initial;
        const targets = [...new Set(ways.map((t) => t.to))];
        const here = (t: { from: "*" | string[] }) => t.from === "*" || (typeof from === "string" && t.from.includes(from));
        const moves = targets.map((to) => {
          // mold_v0-337: named by the transition that applies from where the record is (Resume from suspended, Mark live
          // from pending, both to active), else by any labelled one to it.
          const label = (ways.find((t) => t.to === to && t.label && here(t)) ?? area.lifecycle!.transitions.find((t) => t.to === to && t.label && here(t)) ?? ways.find((t) => t.to === to && t.label))?.label
            ?? `Move to ${stateWords(area, to)}`;
          const anyRole = (area.lifecycle!.transitions).filter((t) => t.to === to && here(t));
          const disabled = same(from, to) ? `It is already ${stateWords(area, to)}.`
            : ways.some((t) => t.to === to && here(t)) ? null
            : anyRole.length ? `Only ${roleWords([...new Set(anyRole.flatMap((t) => t.roles ?? []))])} can move it from ${stateWords(area, from)} to ${stateWords(area, to)}.`
            : `It can't move from ${stateWords(area, from)} to ${stateWords(area, to)}.`;
          // mold_v0-348: the state it moves to, in words (the toast says where it went, never the button's verb).
          return { to, label, state: stateWords(area, to), disabled };
        });
        const open = moves.filter((m) => !m.disabled);
        // mold_v0-337: label_from_move: named by the one move open now (Suspend, Resume, Mark live, Add back).
        const label = x.label_from_move && open.length === 1 ? open[0]!.label : x.label ?? (x.to !== undefined ? moves[0]!.label : "Move");
        const disabled = unavailable ?? (open.length ? null : x.to !== undefined ? moves[0]!.disabled : `Nothing you can do moves it from ${stateWords(area, from)}.`);
        // Without a state of its own, the states it can move to now (the rest stay listed, disabled, with why).
        out.push({ ...base, label, disabled, moves });
        break;
      }
      case "edit": {
        // mold_v0-305: an area with encrypted fields is edited too (each a secret input left empty: its value is kept).
        if (!writes || !may(area, "update", actor) || areaOpWithheld(area.name, "update")) continue;
        // mold_v0-309: a field only the app's actions set is not the form's (its stored value is kept).
        // mold_v0-322: nor a connection's members' opt-in, for anyone but an owner (its stored value is kept).
        const fields = area.fields.filter((f) => f.type !== "file" && f.name !== area.lifecycle?.field && personSets(f)).filter(formOffers(area, role));
        out.push({ ...base, label: x.label ?? "Edit", disabled: unavailable, ...(opts.withForms === false ? {} : { fields: fields.map(formField) }) });
        break;
      }
      case "delete": {
        if (!writes || !may(area, "delete", actor) || areaOpWithheld(area.name, "delete")) continue;
        out.push({ ...base, label: x.label ?? "Delete", disabled: unavailable });
        break;
      }
      case "toggle": {
        // mold_v0-336: a boolean field turned on or off in one click, for whom an edit form would offer the field (the
        // update permission; a members' opt-in to owners only, mold_v0-322); the record store refuses the rest on save.
        const f = area.fields.find((y) => y.name === x.field);
        if (!writes || !f || !personSets(f) || !may(area, "update", actor) || areaOpWithheld(area.name, "update") || !formOffers(area, role)(f)) continue;
        out.push({ ...base, label: x.label ?? f.label, disabled: unavailable, on: record.data[f.name] === true });
        break;
      }
      case "link": {
        // mold_v0-256: a field linking to several areas opens the area its value belongs to, not the first declared.
        const ls = areaLinks(area).filter((y) => y.field === x.field).filter((y) => { const t = findArea(y.area); return !!t && may(t, "read", actor); });
        if (!ls.length) continue;
        // mold_v0-298: no link set, no action (a button that can never work is noise); set but not found, disabled with why.
        const lv = record.data[x.field!];
        if (lv == null || lv === "" || (Array.isArray(lv) && !lv.length)) continue;
        const found = await linkedRecord(opts.org ?? null, area, x.field!, record, actor);
        const f = area.fields.find((y) => y.name === x.field);
        out.push({ ...base, label: x.label ?? `Open ${(f?.label ?? x.field!).toLowerCase()}`, disabled: unavailable ?? (found ? null : `The linked ${(f?.label ?? x.field!).toLowerCase()} can't be found, or you can't open it.`),
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
        if (v == null || (typeof v === "string" && v.trim() === "")) continue; // mold_v0-298: nothing set, no action
        const url = typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v.trim()) && URL.canParse(v.trim()) ? v.trim() : null;
        out.push({ ...base, label: x.label ?? `Open ${f.label.toLowerCase()}`, disabled: unavailable ?? (url ? null : `This record's ${f.label.toLowerCase()} is not a web address.`), url });
        break;
      }
      case "start_agent": {
        // mold_v0-261 (flag agent_harness): a session with the action's profile, for a role that may start it (else not shown).
        if (area.scope !== "workspace" || !may(area, "read", actor) || opts.org === undefined) continue;
        if (role !== null && !canAccount(role, "launch")) continue;
        const { profileOffer } = await import("./agent-profiles.js");
        const prof = await profileOffer(x.profile!, opts.org, { kind: actor.userId ? "person" : "key", role });
        if (!prof) continue;
        const { fillTemplate, templateRecord } = await import("./agent-profile-spec.js");
        // mold_v0-348: references by their titles, options by their labels (read as the person), never bare keys.
        const words = templateRecord(area.fields, (await withRefTitles(opts.org, area, [record], actor))[0] ?? record);
        out.push({ ...base, label: x.label ?? `Start ${prof.name}`, disabled: unavailable ?? prof.disabled,
          // mold_v0-333: the record it makes has no key until it starts: the preview says so.
          agent: { profile: prof.id, name: prof.name, version: prof.version, message: fillTemplate(x.first_message ?? "", x.creates ? { ...words, data: { ...words.data, created_key: "(given when it starts)" } } : words) } });
        break;
      }
      case "start_program": {
        // mold_v0-303 (flag nested_runs): a program people may start, for a role that may (else not shown); its inputs
        // from the record, here on the server (src/program-start.ts says who may and how it runs).
        if (area.scope !== "workspace" || !may(area, "read", actor) || opts.org === undefined) continue;
        if (role !== null && !canAccount(role, "launch")) continue;
        const P = await import("./programs.js");
        if (!P.programsOn()) continue;
        const prog = await P.readProgram(x.program!).catch(() => null);
        if (!prog || prog.status !== "active") continue;
        const S = await import("./program-start.js");
        if (S.actorProblem(actor.userId ? { kind: "person", user: actor.userId, name: null, role } : { kind: "key", user: null, name: null, role: null }, prog.config)) continue;
        const how = S.personStart(prog.config);
        const inputs = S.inputsFromRecord(x.input, record);
        const { validateJson } = await import("./program-spec.js");
        const bad = "refused" in how ? [] : validateJson(inputs, prog.config.inputs);
        out.push({ ...base, label: x.label ?? `Run ${prog.name}`,
          disabled: unavailable ?? ("refused" in how ? how.refused : bad.length ? `This record does not give the program what it needs: ${bad.slice(0, 2).join("; ")}` : null),
          program: { id: prog.id, name: prog.name, version: prog.version, via: "refused" in how ? "session" : how.via, inputs } });
        break;
      }
      case "test_storage": {
        // mold_v0-305 (flag workspace_storage): the declared storage area's own record, for a role that may update it.
        if (!writes || opts.org === undefined || !may(area, "update", actor) || areaOpWithheld(area.name, "update")) continue;
        const W = await import("./workspace-storage.js");
        if (!W.isStorageArea(area.name)) continue;
        out.push({ ...base, label: x.label ?? "Test", disabled: unavailable });
        break;
      }
      case "test_connection": {
        // mold_v0-312: a workspace's own connection record, for a role that may update it (the test writes its status).
        if (!writes || opts.org === undefined || !x.probe || !may(area, "update", actor) || areaOpWithheld(area.name, "update")) continue;
        out.push({ ...base, label: x.label ?? "Test connection", disabled: unavailable });
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
          create: { area: target.name, label: target.label, values, ...(opts.withForms === false ? {} : { fields: target.fields.filter(personSets).filter(formOffers(target, role)).map(formField), upload_max: uploadMax(target),
            ...((target as { key_from_title?: boolean }).key_from_title ? { key_from_title: true } : {}) }) } });
        break;
      }
    }
  }
  // mold_v0-339: several primaries each shown on their own records: where more than one holds, the first is the primary.
  let primary = false;
  for (const a of out) if (a.place === "primary") { if (primary) { a.place = "more"; delete a.look; } primary = true; }
  return out;
}

/** mold_v0-333/339: whether a page reads its record's state times (a steps section, a state_since fact). */
const needsStateTimes = (layout: RecordDetailLayout) => layout.tabs.some((t) => t.sections.some((x) => x.steps)) || (layout.header?.facts ?? []).some((f) => f.state_since);

/** mold_v0-339: whether a declared action is offered on this record now (its show_when holds, or it has none). */
export const shownOn = (x: DetailAction, record: RecordRow) => !x.show_when || holds(x.show_when, record.data, (record as { clocks?: unknown }).clocks);

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

/**
 * mold_v0-340: a hop's records (RecordsHopSchema): the keys of every record of `hop.area` pointing at `key` of `from` that
 * its `where` keeps, newest change first, at most HOP_RECORDS_MAX, read as the person; hidden when they may not read it.
 */
export async function hopKeys(org: number, from: string, key: string, hop: RecordsHop, actor: Actor): Promise<{ keys: string[] } | { hidden: true }> {
  const hopArea = findArea(hop.area);
  const via = hopArea ? viaOf(from, hopArea, hop) : null;
  if (!hopArea || !via || !may(hopArea, "read", actor) || areaOpWithheld(hopArea.name, "list")) return { hidden: true };
  const keys: string[] = [];
  let after: string | undefined, read = 0;
  while (keys.length < HOP_RECORDS_MAX && read < COMPUTED_COUNT_MAX) {
    const page = await listFor(org, hopArea.name, { filter: pointingAt(hopArea, via, key), sort: "-updated_at", limit: 200, ...(after ? { after } : {}) }, actor);
    read += page.records.length;
    for (const row of page.records) if (!hop.where || holds(hop.where, row.data, (row as { clocks?: unknown }).clocks)) keys.push(row.key);
    if (!page.next) break;
    after = page.next;
  }
  return { keys: keys.slice(0, HOP_RECORDS_MAX) };
}

/**
 * mold_v0-340: the records a sessions or runs section is about: this one, and each hop's (those the person may read),
 * as {area, key} pairs (at most 1 + 4 x HOP_RECORDS_MAX).
 */
async function sectionRecords(org: number, area: RecordArea, key: string, hops: readonly RecordsHop[], actor: Actor): Promise<{ area: string; key: string }[]> {
  const out = [{ area: area.name, key }];
  for (const h of hops) {
    const got = await hopKeys(org, area.name, key, h, actor);
    if ("keys" in got) out.push(...got.keys.map((k) => ({ area: h.area, key: k })));
  }
  return out;
}

type Fact = NonNullable<NonNullable<Layout["header"]>["facts"]>[number];
/** A computed fact's answer (mold_v0-256): a count, the latest related record's value, or hidden from this person. */
export type ComputedAnswer = { hidden: true } | { op: "count"; value: number; capped: boolean; area: string; via: string }
  | { op: "latest"; value: unknown; area: string; field: string | null; record: { key: string; title: string | null } | null };
/**
 * A fact computed from the records of another area that point back to `record` (mold_v0-256), read as the person (the
 * area's read permission, its list not withheld; else hidden), in the workspace's own scope, a page at a time: `count`
 * those its `where` keeps (at most COMPUTED_COUNT_MAX, then "capped"), or `latest`: its `field` on the first of them by
 * `sort` (default the newest change). An encrypted field is never read (the build refuses one).
 */
export async function computedFact(org: number | null, area: RecordArea, record: RecordRow, fact: Fact, actor: Actor): Promise<ComputedAnswer> {
  const c = fact.computed!;
  // mold_v0-337: through a first hop (the application's default environment): the fact is that record's, each hop read
  // as the person (a hop they may not read hides the fact; no record there reads as none).
  if (c.through) {
    const hopArea = findArea(c.through.area);
    if (org === null || !hopArea) return { hidden: true };
    const hop = await relatedColumn(org, area, { related: { area: hopArea.name, via: c.through.via }, show: "latest", sort: c.through.sort, where: c.through.where }, [record.key], actor);
    if ((hop as { hidden?: unknown }).hidden === true) return { hidden: true };
    const mid = (hop as Record<string, { key: string; title: string | null } | null>)[record.key];
    const target = findArea(c.area);
    if (!mid || !target) return c.op === "count" ? { op: "count", value: 0, capped: false, area: c.area, via: (target && viaOf(hopArea.name, target, c)) ?? "" } : { op: "latest", value: null, area: c.area, field: c.field ?? null, record: null };
    const { through: _t, ...next } = c;
    return computedFact(org, hopArea, { area: hopArea.name, key: mid.key, title: mid.title, data: {} } as RecordRow, { ...fact, computed: next }, actor);
  }
  const target = findArea(c.area);
  const via = target ? viaOf(area.name, target, c) : null;
  // mold_v0-271: staff (org null) read shared areas only, as their own record pages list them.
  if (org === null) { if (!target || !via || target.scope !== "platform" || areaOpWithheld(target.name, "admin_list")) return { hidden: true }; }
  else if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) return { hidden: true };
  const listFor = (o: number | null, name: string, q: Parameters<typeof listPlatform>[1], a: Actor) => (o === null ? listPlatform(findArea(name)!, q) : listForWorkspace(o, name, q as never, a));
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
    // mold_v0-333: with no field, the record itself (a pointer): its title (or key) is the value.
    if (row) return { op: "latest", value: c.field ? row.data[c.field] ?? null : row.title || row.key, area: target.name, field: c.field ?? null, record: { key: row.key, title: row.title } };
    if (!page.next) break;
    after = page.next;
  }
  return { op: "latest", value: null, area: target.name, field: c.field ?? null, record: null };
}

/**
 * mold_v0-337 (an action's unavailable `related`, a title's {{$n}}): the records of `rel.area` pointing at `key` (through
 * `rel.via`) that `rel.where` keeps, at most `max` of them, in the order they were made, read as the shell: every
 * record of the workspace, whoever may see it (a member's private build counts too; the action's reason is the pack's
 * words and names none of them), on the write's own transaction when inside one (src/connection-test-health.ts
 * shellRead). A page at a time, stopping at `max` matches or COMPUTED_COUNT_MAX read.
 */
export async function relatedOpen(org: number, area: RecordArea, key: string, rel: { area: string; via?: string; where?: DetailCondition }, max = COMPUTED_COUNT_MAX): Promise<string[]> {
  const target = findArea(rel.area);
  const via = target ? viaOf(area.name, target, rel) : null;
  if (!target || !via || target.scope !== "workspace") return [];
  const { shellRead } = await import("./connection-test-health.js");
  type R = { id: string; key: string; data: Record<string, unknown> | string };
  const out: string[] = [];
  for (let read = 0, after = "0"; read < COMPUTED_COUNT_MAX && out.length < max;) {
    const rows = await shellRead<R>(org,
      `SELECT id::text AS id, key, data FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND id > $4::bigint
         AND (data -> $5 = to_jsonb($6::text) OR (jsonb_typeof(data -> $5) = 'array' AND data -> $5 @> jsonb_build_array($6::text))) ORDER BY id LIMIT 200`,
      [org, target.pack, target.name, after, via, key]);
    read += rows.length;
    for (const r of rows) {
      const data = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
      if ((!rel.where || holds(rel.where, data)) && out.length < max) out.push(r.key);
    }
    if (rows.length < 200) break;
    after = rows[rows.length - 1]!.id;
  }
  return out;
}

/** The record picker's page: at most PICK_MAX choices, from the PICK_SCAN newest records. */
const PICK_MAX = 20, PICK_SCAN = 2000;
/**
 * A tab column computed from related records (mold_v0-256), for the rows `keys` of `area`: the records of the column's
 * area pointing at them (read as the person, the workspace's own scope, at most COMPUTED_COUNT_MAX), counted per row or
 * the newest one's field. A role that may not read that area: {hidden: true}.
 */
async function relatedColumn(org: number, area: RecordArea, c: import("./pack-api.js").TabRelatedColumn, keys: string[], actor: Actor): Promise<Record<string, unknown> | { hidden: true }> {
  // mold_v0-337: through a first hop: each row's hop record (its newest that the hop's where keeps), then the column
  // over those, read back to each row; each hop read as the person.
  const h = c.related.through;
  if (h) {
    const hopArea = findArea(h.area);
    if (!hopArea) return { hidden: true };
    const hop = await relatedColumn(org, area, { related: { area: hopArea.name, via: h.via }, show: "latest", sort: h.sort, where: h.where }, keys, actor);
    if ((hop as { hidden?: unknown }).hidden === true) return { hidden: true };
    const mid = new Map(keys.map((k) => [k, ((hop as Record<string, { key: string } | null>)[k])?.key ?? null]));
    const { through: _t, ...related } = c.related;
    const inner = await relatedColumn(org, hopArea, { ...c, related }, [...new Set([...mid.values()].filter((x): x is string => !!x))], actor);
    if ((inner as { hidden?: unknown }).hidden === true) return { hidden: true };
    const none = c.show === "count" ? 0 : null;
    return Object.fromEntries(keys.map((k) => { const m = mid.get(k); return [k, m ? (inner as Record<string, unknown>)[m] ?? none : none]; }));
  }
  const target = findArea(c.related.area);
  const via = target ? viaOf(area.name, target, c.related) : null;
  if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) return { hidden: true };
  const out: Record<string, unknown> = {};
  // mold_v0-333: "latest" alone is the record itself (a pointer: {key, title}); sort and where choose which.
  const pointer = c.show === "latest";
  const latest = c.show.startsWith("latest:") ? c.show.slice(7) : null;
  for (const k of keys) out[k] = latest || pointer ? null : 0;
  if (!keys.length) return out;
  const f = target.fields.find((x) => x.name === via);
  const many = !!(f?.multiple || f?.type === "link");
  const sort = c.sort ? `${(c.sort.direction ?? "desc") === "desc" ? "-" : ""}${c.sort.field}` : "-updated_at";
  const keeps = (row: RecordRow) => !c.where || holds(c.where, row.data, (row as { clocks?: unknown }).clocks);
  let after: string | undefined, read = 0;
  while (read < COMPUTED_COUNT_MAX) {
    // In the column's order (newest change first by default): the first row seen for a key is its latest.
    const page = await listFor(org, target.name, { filter: many ? {} : { [via]: { in: keys } }, sort, limit: 200, ...(after ? { after } : {}) }, actor);
    read += page.records.length;
    for (const row of page.records) {
      if (!keeps(row)) continue;
      const v = row.data[via];
      for (const k of (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x in out)) {
        if (pointer) { if (out[k] === null) out[k] = { key: row.key, title: row.title ?? null }; }
        else if (latest) { if (out[k] === null) out[k] = row.data[latest] ?? null; } else out[k] = (out[k] as number) + 1;
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
  // mold_v0-310: each line's run or agent session, linked (src/record-runs.ts), when the person may open it.
  const runs = await lineLinks(org, got.lines);
  return { more: got.more, changes: got.lines.map((l, i) => ({ id: l.id, at: l.at, action: l.action, by: changedByWords(l.by, person), ...(runs[i] ? { run: runs[i] } : {}), title: l.title, changes: l.changes })) };
}

/**
 * mold_v0-340: a charts section's metrics for one record: each metric over a record area the section's `records` names,
 * narrowed to the records whose field points at this record (or at any of a hop's records), counted as the person reads
 * them (src/metrics.ts computeSpec: its roles and area; the records as the person may see them). A metric over an area the
 * person may not read is refused as on an overview (403); one whose hop they may not read counts nothing.
 */
/** A value no record's key is (a key has no spaces): a hop with no records narrows a metric to none. */
const NO_KEY = "no record";
export async function recordMetrics(org: number, area: RecordArea, key: string, c: NonNullable<Layout["tabs"][number]["sections"][number]["charts"]>, actor: Actor) {
  const M = await import("./metrics.js");
  const { asViewerOf } = await import("./visibility.js");
  const views = M.buildViews();
  const names = [...new Set(c.charts.flatMap((n) => views.charts.find((x) => x.pack === area.pack && x.name === n)?.metrics ?? []))];
  const keysOf = new Map<string, Promise<string[]>>();
  return asViewerOf(actor, () => Promise.all(names.map(async (n): Promise<import("./metrics.js").MetricResult> => {
    const spec = M.findMetric(n);
    const scope = spec ? c.records.find((x) => x.area === spec.over) : undefined;
    const target = scope ? findArea(scope.area) : null;
    if (!spec || !scope || !target) return { name: n, error: "This chart is not counted for one record.", status: 404 };
    const via = viaOf(scope.through?.area ?? area.name, target, scope);
    if (!via) return { name: n, error: "This chart is not counted for one record.", status: 404 };
    const id = JSON.stringify(scope.through ?? null);
    if (!keysOf.has(id)) keysOf.set(id, scope.through ? hopKeys(org, area.name, key, scope.through, actor).then((h) => ("keys" in h ? h.keys : [])) : Promise.resolve([key]));
    const keys = await keysOf.get(id)!;
    try {
      // The record's own records: one more condition, the metric's other conditions kept.
      return await M.computeSpec(org, { ...spec, where: [...(spec.where ?? []), { field: via, op: "in", value: keys.length ? keys : [NO_KEY] }] } as typeof spec, actor);
    } catch (e) {
      if (e instanceof PackError) return { name: n, error: e.message, status: e.status };
      console.error(`record metric ${n}: ${(e as Error).message}`);
      return { name: n, error: "The metric could not be computed.", status: 500 };
    }
  })));
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
    let writers: Awaited<ReturnType<typeof recordWriters>> | null = null;
    for (const [si, s] of tab.sections.entries()) {
      const id = `${ti}-${si}`;
      if (s.related) {
        const target = findArea(s.related.area);
        const via = target ? viaOf(s.related.through?.area ?? area.name, target, s.related) : null;
        // mold_v0-256: matched on a field: their via holds this record's match_field value (nothing to match: none listed).
        const matchOn = s.related.match_field !== undefined ? record.data[s.related.match_field] : record.key;
        // The target area's read permission, and its list not withheld: else the section is not drawn at all.
        if (!target || !via || !may(target, "read", actor) || areaOpWithheld(target.name, "list")) { sections[id] = { hidden: true }; continue; }
        const limit = s.related.limit ?? 5;
        const sortField = s.related.sort?.field ?? "updated_at";
        const sort = `${(s.related.sort?.direction ?? (s.related.sort ? "asc" : "desc")) === "desc" ? "-" : ""}${sortField}`;
        // mold_v0-340: through a hop: the records pointing at any of the hop's records (each read as the person), with no
        // Show all (the list's filter names one record).
        if (s.related.through) {
          const hop = await hopKeys(org, area.name, record.key, s.related.through, actor);
          const hv = findArea(s.related.through.area) ? viaOf(s.related.through.area, target, s.related) : null;
          if ("hidden" in hop || !hv) { sections[id] = { hidden: true }; continue; }
          const f = target.fields.find((x) => x.name === hv);
          const many = !!(f?.multiple || f?.type === "link");
          const want = new Set(hop.keys);
          const kept: RecordRow[] = [];
          let after: string | undefined, read = 0;
          while (hop.keys.length && kept.length <= limit && read < COMPUTED_COUNT_MAX) {
            const page = await listFor(org, target.name, { filter: many ? {} : { [hv]: { in: hop.keys } }, sort, limit: 200, ...(after ? { after } : {}) }, actor);
            read += page.records.length;
            for (const row of page.records) { const v = row.data[hv]; if ((Array.isArray(v) ? v : [v]).some((x) => typeof x === "string" && want.has(x))) kept.push(row); }
            if (!page.next) break;
            after = page.next;
          }
          const rows = await withRefTitles(org, target, kept.slice(0, limit), actor);
          sections[id] = { area: target.name, via: hv, match: null, more: kept.length > limit,
            records: await Promise.all(rows.map(async (row) => ({ key: row.key, title: row.title, data: row.data, updated_at: row.updated_at, ...(row.ref_titles ? { ref_titles: row.ref_titles } : {}),
              actions: await pageActions(target, row, actor, { withForms: false, org }) }))) };
          continue;
        }
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
        // mold_v0-310: `wrote`: the runs and sessions that made or changed it too (the header's writers, read once).
        if (s.runs.wrote) writers ??= await recordWriters(org, area, record.key);
        sections[id] = { total: got.total - (got.runs.length - shown.length), runs: shown.map(({ requested_by, ...x }) => ({ ...x, by: by!(requested_by) })),
          ...(s.runs.wrote ? { wrote: [...(writers!.made ? [{ ...writers!.made, how: "Made" }] : []), ...writers!.changed.map((x) => ({ ...x, how: "Changed" }))] } : {}),
          ...(ss.total ? { sessions: { total: ss.total, rows: ss.sessions.map((x) => ({ id: x.id, title: x.title, phase: x.phase, profile: x.profile, started_by: x.mine ? "You" : x.started_by,
            spent_usd: x.spent_usd, budget_usd: x.budget_usd, created_at: x.created_at, last_activity_at: x.last_activity_at })) } } : {}) };
      } else if (s.sessions || s.agent_runs) {
        // mold_v0-340: the record's agent sessions (its own and its hops' records'), or the runs among them.
        const spec = (s.sessions ?? s.agent_runs)!;
        const H = await import("./harness-sessions.js");
        if (!featureOn("agent_harness") || (s.agent_runs && !featureOn("nested_runs"))) { sections[id] = { hidden: true }; continue; }
        const recs = await sectionRecords(org, area, record.key, spec.through ?? [], actor);
        const limit = spec.limit ?? 10;
        if (s.sessions) {
          const ss = await H.recordsSessions(org, recs, H.actorOf(session(res)), limit);
          sections[id] = { total: ss.total, rows: ss.sessions.map((x) => ({ id: x.id, title: x.title, phase: x.phase, profile: x.profile, started_by: x.mine ? "You" : x.started_by,
            spent_usd: x.spent_usd, budget_usd: x.budget_usd, created_at: x.created_at, last_activity_at: x.last_activity_at })) };
        } else {
          const D = await import("./agent-dock.js");
          const roots = await H.recordsSessionIds(org, recs);
          const runs = roots.length ? await D.activeRuns(org, { roots }) : [];
          sections[id] = { total: runs.length, rows: runs.slice(0, limit).map((x) => ({ id: x.id, ref: x.ref, title: x.title, status: x.status, needs: x.needs, why: x.why, outcome: x.outcome,
            finished: x.finished, children: x.children, open: x.open, waiting: x.waiting, spent_usd: x.spent_usd + x.children_spent_usd, budget_usd: x.budget_usd,
            last_activity_at: x.last_activity_at, settled_at: x.settled_at })) };
        }
      } else if (s.history) {
        // mold_v0-256: the record's changes, read as the person (the record's own read: it read the record above).
        by ??= await byWords(session(res));
        sections[id] = await historyOf(org, area, record.key, s.history, null, by);
      }
    }
    // mold_v0-310: the run or agent session that made the record and those that changed it since (the header's "Made by").
    writers ??= await recordWriters(org, area, record.key);
    // mold_v0-333: a steps section shows where a record that left the path stopped: when it entered each state.
    // mold_v0-339: a steps section's skipped states and a state_since fact read them too (a shared record's as well).
    const steps = needsStateTimes(layout) ? { state_at: await recordStateTimes(org, area, record.key) } : {};
    return { actions: await pageActions(area, record, actor, { org }), sections, facts, writers, ...steps };
  }));

  // mold_v0-340: a charts section's numbers: its charts' metrics counted over this record's records only, as the person.
  r.get("/:area/:key/metrics", answer(async (req, res) => {
    const { area, layout, record } = await recordOf(req, res);
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(req.query.section ?? ""));
    const s = m ? layout.tabs[Number(m[1])]?.sections[Number(m[2])] : undefined;
    if (!s?.charts) throw new PackError("section: a charts section of this page (<tab>-<section>)", 400);
    return { metrics: await recordMetrics(session(res).org, area, record.key, s.charts, actorOf(res)) };
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
    // mold_v0-339: an action offered only while a condition holds is refused on a record it does not hold on.
    if (!shownOn(declared, record)) throw new PackError(`${declared.label ?? id} is not offered on this record now.`, 409);
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
        const moved = await dataApi.move(callerOf(res), area.name, record.key, m.to);
        // mold_v0-333: Cancel cancels: the session that made the record stops (it works only for the record; this move's
        // transition names who may make it), and those started from it that this person may stop under the session's
        // own rules (theirs, or as an owner). Only those sessions' late moves of this record are ignored afterwards.
        if (declared.stops_session) {
          const S = await import("./session-records.js"), H = await import("./harness-sessions.js");
          const s = session(res);
          const words = `${s.email ?? "Someone"} (moved ${record.title || record.key} to ${stateWords(area, m.to)})`;
          const { stopped } = await S.stopSessionsFor(s.org, area.name, record.key, words, H.actorOf(s));
          // Its children (deployments still building) close with it now, not when the session's wake ends.
          await S.closeChildrenFor(s.org, area.name, record.key).catch((e) => console.error(`${area.name}/${record.key}: children not closed: ${(e as Error).message}`));
          return { ...moved, stopped_sessions: stopped };
        }
        return moved;
      }
      case "edit": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        const v = body as { title?: unknown; data?: unknown; visibility?: unknown };
        if (!v.data || typeof v.data !== "object" || Array.isArray(v.data)) throw new PackError("give {title?, data}", 400);
        // What the form leaves out (the lifecycle's field, file fields) stays as it is.
        const kept = Object.fromEntries(Object.entries(record.data).filter(([k]) => !a.fields?.some((f) => f.name === k)));
        // mold_v0-305: an encrypted field sent empty (its secret input left blank) keeps its stored value: it is left out.
        const sent = Object.fromEntries(Object.entries(v.data as Record<string, unknown>).filter(([k, x]) => !(area.fields.some((f) => f.name === k && f.encrypted) && (x === "" || x === null || x === undefined))));
        // mold_v0-259 (flag teams): who sees it, when the form changed it (the record store checks who may).
        return dataApi.update(callerOf(res), area.name, record.key, { title: typeof v.title === "string" ? v.title : record.title, data: { ...kept, ...sent },
          ...(v.visibility !== undefined ? { visibility: v.visibility } : {}) });
      }
      case "delete": {
        if (a.disabled) throw new PackError(a.disabled, 409);
        return { deleted: await dataApi.delete(callerOf(res), area.name, record.key) };
      }
      case "toggle": {
        // mold_v0-336: {on: true|false} (absent: the other way round). Only this field changes: the record is read again
        // inside one transaction with its row locked (as a program's write over a stored record, src/program-records.ts),
        // so an edit saved meanwhile is kept, never undone; its encrypted fields, its state and the $ keys are left out
        // (kept as stored). Written through the record store as the person: its save checks (a connection's only_one: 409
        // in its words), the owners-only rule, history and health reset all apply.
        if (a.disabled) throw new PackError(a.disabled, 409);
        const on = body.on === undefined ? !a.on : body.on;
        if (typeof on !== "boolean") throw new PackError("on: true or false", 400);
        const field = declared.field!, c = callerOf(res);
        const RA = await import("./record-areas.js"), { auditAtomic } = await import("./audit-trail.js");
        return RA.asWriterUnlessSet({ by: "people", id: c.userId ?? (c.role === null ? "key" : null) }, () => auditAtomic(() => RA.inTransaction(c.orgId, async () => {
          const row = await RA.lockedWorkspaceRow(c.orgId, area, record.key);
          if (!row) throw new PackError(`${area.label} has no record ${record.key}`, 404);
          if ((row.data[field] === true) === on) return { record, unchanged: true };
          const keep = Object.fromEntries(Object.entries(row.data).filter(([k]) => !k.startsWith("$") && k !== area.lifecycle?.field && !area.fields.some((f) => f.name === k && f.encrypted)));
          return { record: await RA.workspaceRecords(area.pack, c.orgId, { role: c.role, userId: c.userId }).update(area.name, record.key, { title: row.title, data: { ...keep, [field]: on } }) };
        })));
      }
      case "start_agent": {
        // The first message is the record's, filled here (whatever the browser sends); the session carries the record.
        if (a.disabled) throw new PackError(a.disabled, 409);
        const s = session(res);
        const H = await import("./harness-sessions.js");
        const org: Org = { orgId: s.org, slug: s.slug, name: "", userId: s.user ?? undefined, role: s.accountRole };
        // mold_v0-333: the record the session makes (a build, queued), added by the server as it starts; the agent is
        // told its key ({{created_key}}) and moves it; the shell closes it out when the session ends.
        const c = declared.creates;
        if (c) {
          const S = await import("./session-records.js");
          const { fillTemplate, templateRecord } = await import("./agent-profile-spec.js");
          const key = S.createdKey();
          const target = findArea(c.area)!;
          // mold_v0-348: references by their titles, options by their labels (read as the person), never bare keys.
          const words = templateRecord(area.fields, (await withRefTitles(s.org, area, [record], actorOf(res)))[0] ?? record);
          const message = fillTemplate(declared.first_message ?? "", { ...words, data: { ...words.data, created_key: key } });
          const link: import("./session-records.js").CreatedLink = { area: c.area, key, pack: target.pack,
            ...(c.on_session_end ? { on_session_end: c.on_session_end } : {}), ...(c.reason_field ? { reason_field: c.reason_field } : {}), ...(c.children ? { children: c.children } : {}) };
          // mold_v0-337: a title's {{$n}}, one more than the records made from this one so far (counted as the shell).
          const numbered = !!c.link && !!c.title && /\{\{\s*\$n\s*\}\}/.test(c.title);
          // mold_v0-337: one at a time, made under a lock on (workspace, area, this record): the check and the make in one
          // transaction, so of two presses at the same moment the second waits, then finds the first's record open and is
          // refused with the action's reason; {{$n}} is counted inside the same lock.
          const busy = (declared.unavailable ?? []).filter((u) => u.related && u.related.area === c.area).map((u) => ({ related: u.related!, reason: u.reason }));
          const make = async (sid: string) => {
            const { auditAtomic } = await import("./audit-trail.js");
            return auditAtomic(() => inTransaction(s.org, async () => {
              if (busy.length || numbered)
                await (await recordQuery()).query("SELECT pg_advisory_xact_lock(hashtext($1))", [`made-from/${s.org}/${c.area}/${area.name}/${record.key}`]);
              for (const u of busy) if ((await relatedOpen(s.org, area, record.key, u.related, 1)).length) throw new PackError(u.reason, 409);
              const n = numbered ? (await relatedOpen(s.org, area, record.key, { area: c.area, via: c.link })).length + 1 : undefined;
              return S.makeCreated(s.org, c, key, S.planCreated(c, record, { session: sid, person: s.user ?? null, now: new Date(), n }, fillTemplate), actor);
            }));
          };
          const made = await H.startSession(s.org, H.actorOf(s), { message, profile: a.agent!.profile, title: `${a.agent!.name}: ${record.title || record.key}` }, org,
            { record: { area: area.name, key: record.key }, creates: { link, make } });
          return { session: made, created: { area: c.area, key } };
        }
        return { session: await H.startSession(s.org, H.actorOf(s), { message: a.agent!.message, profile: a.agent!.profile, title: `${a.agent!.name}: ${record.title || record.key}` }, org,
          { record: { area: area.name, key: record.key } }) };
      }
      case "start_program": {
        // mold_v0-303: the inputs are the record's, filled here (whatever the browser sends); the session carries the record.
        if (a.disabled) throw new PackError(a.disabled, 409);
        const s = session(res);
        const H = await import("./harness-sessions.js");
        const org: Org = { orgId: s.org, slug: s.slug, name: "", userId: s.user ?? undefined, role: s.accountRole };
        // mold_v0-334: the session carries the action that started it (only its outcomes move the record).
        const started = await (await import("./program-start.js")).startProgram(s.org, H.actorOf(s), a.program!.id, { inputs: a.program!.inputs, title: `${a.program!.name}: ${record.title || record.key}` }, org,
          { record: { area: area.name, key: record.key, action: id } });
        // mold_v0-334: the action's move on start (src/record-outcomes.ts); the session has started whatever it says.
        // Moved as the person who started it.
        const moved = await (await import("./record-outcomes.js")).moveOnStart(s.org, area.name, record.key, id, started.session.id, actor).catch((e: Error) => { console.error(`record outcomes: ${e.message}`); return null; });
        return { ...started, ...(moved ? { moved: { from: moved.from, to: moved.to } } : {}) };
      }
      case "test_storage": {
        // mold_v0-305: never a key in the answer; the bucket's own words, cleaned (src/storage.ts bucketErrorInWords).
        if (a.disabled) throw new PackError(a.disabled, 409);
        const W = await import("./workspace-storage.js");
        // mold_v0-309: the app's own action: it may set the fields `set_by: "action"` (the test's status and date).
        return asAction(() => W.testStorageRecord(session(res).org, record.key, actor));
      }
      case "test_connection": {
        // mold_v0-312: the call is the pack's (never the browser's); never a secret or the service's body in the answer.
        if (a.disabled) throw new PackError(a.disabled, 409);
        const C = await import("./connection-test.js");
        return asAction(() => C.testConnectionRecord(session(res).org, area, record.key, declared.probe!, actor));
      }
      default:
        throw new PackError(`${a.label} happens in the browser: nothing to send`, 400);
    }
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}


/**
 * mold_v0-271 (flag record_pages): a shared record's laid-out page for staff (/admin/records/<area>/<key>): its header's
 * computed facts and the open tab's related lists, each over the shared areas only (staff read no workspace's records:
 * a fact or a list of a workspace area is {hidden: true}, and its section is not drawn). No page actions: staff's own
 * Edit and Remove stand in the header. GET /api/admin/records/_page/<area>/<key>[?tab=<id>] (src/record-routes.ts).
 */
export async function staffPageData(areaName: string, key: string, asked: string | null): Promise<{ actions: []; facts: Record<string, ComputedAnswer>; sections: Record<string, unknown>; state_at?: Record<string, string> }> {
  const area = findArea(areaName);
  const layout = area ? layoutOf(area) : null;
  if (!area || area.scope !== "platform" || !layout || !featureOn("record_pages") || areaOpWithheld(area.name, "admin_get")) throw new PackError("Not found", 404);
  const record = await getPlatform(area, key);
  if (!record) throw new PackError("Not found", 404);
  const staff: Actor = { role: null, userId: null };
  const facts: Record<string, ComputedAnswer> = {};
  for (const [i, f] of (layout.header?.facts ?? []).entries()) if (f.computed) facts[String(i)] = await computedFact(null, area, record, f, staff);
  const tab = layout.tabs.find((t) => detailTabId(t.label) === asked) ?? layout.tabs[0]!;
  const ti = layout.tabs.indexOf(tab);
  const sections: Record<string, unknown> = {};
  for (const [si, s] of tab.sections.entries()) {
    if (!s.related) continue;
    const id = `${ti}-${si}`;
    const target = findArea(s.related.area);
    const via = target ? viaOf(area.name, target, s.related) : null;
    if (!target || !via || target.scope !== "platform" || areaOpWithheld(target.name, "admin_list")) { sections[id] = { hidden: true }; continue; }
    const matchOn = s.related.match_field !== undefined ? record.data[s.related.match_field] : record.key;
    const limit = s.related.limit ?? 5;
    const sortField = s.related.sort?.field ?? "updated_at";
    const sort = `${(s.related.sort?.direction ?? (s.related.sort ? "asc" : "desc")) === "desc" ? "-" : ""}${sortField}`;
    if (matchOn == null || matchOn === "" || typeof matchOn === "object") { sections[id] = { area: target.name, via, match: null, more: false, records: [] }; continue; }
    const page = await listPlatform(target, { filter: s.related.match_field !== undefined ? { [via]: matchOn } : pointingAt(target, via, record.key), sort, limit: limit + 1 } as never);
    const rows = await withRefTitles(null, target, page.records.slice(0, limit), staff);
    sections[id] = { area: target.name, via, match: String(matchOn), more: page.records.length > limit,
      records: rows.map((row) => ({ key: row.key, title: row.title, data: row.data, updated_at: row.updated_at, ...(row.ref_titles ? { ref_titles: row.ref_titles } : {}), actions: [] })) };
  }
  // mold_v0-339: when it entered each state (a state_since fact, a steps section), as on a workspace's page.
  const { platformStateTimes } = await import("./record-areas.js");
  return { actions: [], facts, sections, ...(needsStateTimes(layout) ? { state_at: await platformStateTimes(area, record.key) } : {}) };
}
