"use client";

/**
 * AN ACCOUNT RECORD AREA DRAWN FROM ITS DEFINITION (deployments or implementations stated in the record-area form,
 * `records.areas.<area>`, compiled with `declared: true`): the list (table, board, timeline), its filters, sorts and
 * groups, the detail with its sections and lifecycle moves, and the create form, each read from
 * lib/record-area-ui.ts. The list is filtered, sorted and paged by the server (GET /api/ops/<area>?where=&sort=&q=
 * &cursor=); every write goes to the ops routes, which check it with the one validator, and the create form runs that
 * same check (agent/lib/record-area-write.ts) before anything is sent.
 *
 * Who may do what (`permissions`, agent/lib/record-permissions.ts) shapes what is offered: no "New" button for a role
 * that may not create, read-only fields and moves it may not make, no delete in the "…" menu (./record-access.ts);
 * the API refuses the same with a 403. The declared metrics (`metrics`) sit above the list, counted by the server.
 *
 * A profile that does not declare the area never mounts this: its screens are today's (./todos-panel.tsx MineList).
 * The toolbar and panel chrome are todos-panel's own, passed in (`chrome`), so the two look the same.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { WorkspaceCard } from "./cards";
import { WorkspaceViews, type ViewMode } from "./workspace-views";
import { errMessage, opsFetch } from "./lib";
import { Field, OpsButton, OpsInput, SidePanel } from "./primitives";
import { SURFACE, TYPE } from "./tokens";
import { RecordFieldControl } from "./task-area";
import { TONE_CLASS, type AreaRow, type RecordAreas, type RecordField } from "@/agent/lib/record-areas";
import { RECORD_AREAS } from "@/agent/lib/record-areas.generated";
import { ACCOUNT_FIELD, type AccountAreaId } from "@/agent/lib/record-area-records";
import { prepareRecordWrite } from "@/agent/lib/record-area-write";
import { listChoice, listQuery, listRowOf, listValue, recordAreaUi, whereOf, type DatePreset, type RecordAreaUi } from "@/lib/record-area-ui";
import type { RecordAccess } from "@/agent/lib/record-permissions";
import type { RecordMetric } from "@/agent/lib/record-metrics";
import { useRecordAccess } from "./record-access";
import { RecordMetricStrip } from "./record-metrics-strip";

/**
 * A list row as GET /api/ops/<area> returns it for a declared area, once read through listRowOf
 * (lib/record-area-ui.ts): `values` and `custom` are objects even when the answer carried neither.
 */
export type RecordAreaRow = {
  id: string;
  /** deployments: the real id when two accounts share one (the list keys the row on account + id). */
  recordId?: string;
  label: string;
  title?: string;
  displayName: string | null;
  owner: string | null;
  customer: string | null;
  customerLabel: string | null;
  values: Record<string, unknown>;
  custom: Record<string, unknown>;
};

type SortOption = { value: string; label: string };
type FilterGroup = { label: string; selected: readonly string[]; onChange: (next: string[]) => void; options: readonly SortOption[] };
/** todos-panel's own toolbar and panel chrome, so a declared area looks like every other tab. */
export interface RecordAreaChrome {
  Toolbar: (p: {
    noun: string;
    nounPlural?: string;
    q: string;
    setQ: (v: string) => void;
    onCreate?: () => void;
    createLabel?: string;
    filter?: React.ReactNode;
    sort: string;
    setSort: (v: string) => void;
    sortOptions: readonly SortOption[];
    onClose: () => void;
    viewSwitcher?: React.ReactNode;
  }) => React.ReactNode;
  FilterMenu: (p: { groups: readonly FilterGroup[] }) => React.ReactNode;
  PanelHeader: (p: { eyebrow: string; children: React.ReactNode }) => React.ReactNode;
  PanelSection: (p: { label: string; children: React.ReactNode }) => React.ReactNode;
}

type FormValue = string | string[] | boolean;
const blank = (x: FormValue) => (Array.isArray(x) ? x.length === 0 : typeof x === "string" ? x.trim() === "" : false);
const isList = (f: RecordField) => f.type === "multi_pick" || f.type === "tags" || (Boolean(f.many) && ["person", "record", "file"].includes(f.type));
/** A stored value as the form holds it: a date field reads its day, a list stays a list. */
function formValueOf(f: RecordField, x: unknown): FormValue {
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === "boolean") return x;
  if (x === null || x === undefined) return f.type === "boolean" ? false : isList(f) ? [] : "";
  const s = String(x);
  return f.type === "date" && /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}
/** A form value as a write sends it. */
function writeValueOf(f: RecordField, x: FormValue): unknown {
  if (blank(x)) return null;
  if (typeof x === "string" && ["integer", "number", "percent", "money"].includes(f.type)) return x.trim();
  return x;
}
/** The body that changes one field: a column by key, an own field under `custom`. */
const fieldBody = (f: RecordField, value: unknown): Record<string, unknown> => (f.column ? { [f.key]: value } : { custom: { [f.key]: value } });
/** A list row as the rule book reads a record: its columns by key, its own fields under `custom`. */
const rowOf = (r: RecordAreaRow): AreaRow => ({ ...r.values, displayName: r.displayName, custom: r.custom ?? {} });

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One cell / card line: a field's value as the definition shows it (a choice with its tone, a link by its host). */
function FieldValue({ ui, row, keyName }: { readonly ui: RecordAreaUi; readonly row: RecordAreaRow; readonly keyName: string }) {
  const v = ui.view;
  if (keyName === ACCOUNT_FIELD) return <>{row.customerLabel ?? row.customer ?? "—"}</>;
  if (keyName === "title") return <>{row.label}</>;
  const f = v.field(keyName);
  const raw = listValue(row, keyName);
  const text = v.display(keyName, raw);
  if (!f || !text) return <span className="text-muted-foreground/50">—</span>;
  const tone = f.type === "pick_list" ? v.tone(keyName, raw) : undefined;
  if (tone) {
    return (
      <span className="inline-flex items-center gap-1.5" data-tone={tone}>
        <span className={cn("size-1.5 rounded-full", TONE_CLASS[tone])} />
        {text}
      </span>
    );
  }
  if (f.type === "link" && typeof raw === "string") {
    return (
      <a href={raw} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
        {hostOf(raw)}
      </a>
    );
  }
  if (f.type === "person" || f.type === "email") return <>{Array.isArray(raw) ? raw.map((x) => String(x).split("@")[0]).join(", ") : text.split("@")[0]}</>;
  if (["integer", "number", "percent", "money"].includes(f.type)) return <span className="tabular-nums">{text}</span>;
  return <>{text}</>;
}

/** The view switch, offering only the views the definition lists. */
function Modes({ modes, mode, setMode }: { readonly modes: readonly ViewMode[]; readonly mode: ViewMode; readonly setMode: (m: ViewMode) => void }) {
  if (modes.length < 2) return null;
  const label: Record<ViewMode, string> = { kanban: "Board", table: "Table", timeline: "Timeline" };
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 p-0.5" data-testid="record-modes">
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          className={cn("rounded-md px-2 py-1 text-xs transition-colors", mode === m ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {label[m]}
        </button>
      ))}
    </div>
  );
}

/**
 * Make repeated ids unique: a deployment id is unique per account, not per workspace, so two accounts may each have
 * one. The list keys rows on `id`; the real id is kept in `recordId` for the API.
 */
function uniqueIds(rows: RecordAreaRow[]): RecordAreaRow[] {
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  return rows.map((r) => ((seen.get(r.id) ?? 0) > 1 ? { ...r, recordId: r.id, id: `${r.customer ?? ""}::${r.id}` } : r));
}

export function RecordAreaPanel({
  area,
  areas = RECORD_AREAS,
  accountLabel,
  authorEmail,
  onClose,
  chrome,
  accountPicker,
  renderRelated,
  renderActions,
}: {
  readonly area: AccountAreaId;
  readonly areas?: RecordAreas;
  readonly accountLabel: string;
  readonly authorEmail?: string;
  readonly onClose: () => void;
  readonly chrome: RecordAreaChrome;
  /** The account picker the create form shows (todos-panel's ReferenceSelect). */
  readonly accountPicker: (p: { value: string; onChange: (id: string) => void; disabled?: boolean }) => React.ReactNode;
  /** The detail's related work: the tasks filed under the record, its activity and comments. */
  readonly renderRelated: (row: RecordAreaRow) => React.ReactNode;
  /** The detail's "…" menu (share, copy, delete); `can.delete` is whether to offer the delete. */
  readonly renderActions: (row: RecordAreaRow, done: () => void, can: { delete: boolean }) => React.ReactNode;
}) {
  const ui = useMemo(() => recordAreaUi(area, areas, accountLabel), [area, areas, accountLabel]);
  const endpoint = `/api/ops/${area}`;
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [sort, setSort] = useState(ui.defaultSort);
  const [facets, setFacets] = useState<Record<string, string[]>>({});
  const [presets, setPresets] = useState<Record<string, DatePreset[]>>({});
  const [mode, setMode] = useState<ViewMode>(ui.defaultMode);
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [rows, setRows] = useState<RecordAreaRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const access = useRecordAccess(area, authorEmail, areas);
  const [metrics, setMetrics] = useState<RecordMetric[]>([]);
  const hasMetrics = (areas[area].metrics ?? []).length > 0;
  // The declared metrics, counted by the server over every record of the area (not the page in hand).
  const loadMetrics = useCallback(async () => {
    if (!hasMetrics) return;
    try {
      const res = await opsFetch<{ metrics: RecordMetric[] }>(`/api/ops/record-metrics?area=${area}`);
      setMetrics(res.metrics ?? []);
    } catch {
      /* the strip keeps what it had */
    }
  }, [area, hasMetrics]);
  // The search goes to the server a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const query = useMemo(() => listQuery(whereOf({ facets, presets }, authorEmail, new Date(), ui.lifecycle?.field ?? null), sort, q), [facets, presets, authorEmail, sort, q, ui]);
  const load = useCallback(
    async (cursor?: string) => {
      try {
        const res = await opsFetch<{ items: RecordAreaRow[]; nextCursor?: string }>(`${endpoint}?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        // Every row read the one way: a row with no values (or no own values) shows empty, never breaks the screen.
        const items = (Array.isArray(res.items) ? res.items : []).map((r) => listRowOf(ui.view, r));
        setRows((prev) => uniqueIds(cursor && prev ? [...prev.map((r) => (r.recordId ? { ...r, id: r.recordId } : r)), ...items] : items));
        setNext(res.nextCursor ?? null);
        setError(null);
      } catch (e) {
        setError(errMessage(e));
      }
      if (!cursor) void loadMetrics();
    },
    [endpoint, query, loadMetrics, ui],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const refetch = () => void load();
  const selected = rows?.find((r) => r.id === selId) ?? null;

  const patch = async (row: RecordAreaRow, body: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const target = area === "deployments" ? row.recordId ?? row.id : row.id;
      const res = await opsFetch<{ warnings?: { message: string }[] }>(`${endpoint}/${encodeURIComponent(target)}`, {
        method: "PATCH",
        body: JSON.stringify({ customerId: row.customer, ...body, actor: authorEmail, ...(row.recordId ? { entityId: row.id } : {}) }),
      });
      // A move that broke a lifecycle rule under "warn" went through; the answer says which rule.
      setNotice(res?.warnings?.length ? res.warnings.map((w) => w.message).join(" ") : null);
      await load();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const v = ui.view;
  const board = ui.board;
  const byField = board ? v.field(board.by) : undefined;
  const card = board?.card ?? {};
  const groups = useMemo(() => {
    if (!groupKey || !rows) return null;
    const out = new Map<string, RecordAreaRow[]>();
    for (const r of rows) {
      const k = groupKey === ACCOUNT_FIELD ? r.customerLabel ?? r.customer ?? "" : v.display(groupKey, listValue(r, groupKey));
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    return [...out.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [groupKey, rows, v]);

  const config = {
    selectedId: selId,
    onSelect: setSelId,
    renderCard: (r: RecordAreaRow) => (
      <WorkspaceCard
        title={card.title && card.title !== "title" ? <FieldValue ui={ui} row={r} keyName={card.title} /> : r.label}
        headerRight={card.badge ? <span className={TYPE.micro}><FieldValue ui={ui} row={r} keyName={card.badge} /></span> : undefined}
        selected={selId === r.id}
        onClick={() => setSelId(r.id)}
        testid="record-card"
      >
        <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground", TYPE.micro)}>
          <span>{r.customerLabel ?? r.customer}</span>
          {(card.meta ?? []).map((k) => (
            <span key={k}>
              <FieldValue ui={ui} row={r} keyName={k} />
            </span>
          ))}
        </div>
      </WorkspaceCard>
    ),
    kanban: {
      columns: board?.columns ?? [],
      columnOf: (r: RecordAreaRow) => (board ? listChoice(v, r, board.by) : ""),
      onMove: (r: RecordAreaRow, col: string) => {
        if (!byField) return;
        // A move this person may not make is not sent (the API would refuse it with the same rule).
        if (!(byField.key === ui.lifecycle?.field ? access.transition(rowOf(r)) : access.field(byField.key, rowOf(r)))) {
          setActionError(`You cannot move this ${ui.noun}.`);
          return;
        }
        void patch(r, fieldBody(byField, col));
      },
    },
    table: ui.columns.map((c) => ({
      key: c.key,
      label: c.label,
      render: (r: RecordAreaRow) => (
        <span data-col={c.key} className={c.key === ui.columns[0]?.key ? "font-medium" : undefined}>
          <FieldValue ui={ui} row={r} keyName={c.key} />
        </span>
      ),
    })),
    timeline: {
      rangeOf: (r: RecordAreaRow) => ({ start: (listValue(r, ui.timeline.start ?? "") as string | undefined) ?? null, end: (listValue(r, ui.timeline.end ?? "") as string | undefined) ?? null }),
      labelOf: (r: RecordAreaRow) => r.label,
      toneOf: (r: RecordAreaRow) => {
        const t = board ? v.tone(board.by, listValue(r, board.by)) : undefined;
        return t ? `${TONE_CLASS[t]}/70` : "bg-indigo-500/70";
      },
    },
  };

  const Toolbar = chrome.Toolbar;
  const FilterMenu = chrome.FilterMenu;
  const filterGroups: FilterGroup[] = [
    ...ui.facets.map((f) => ({ label: f.label, selected: facets[f.key] ?? [], onChange: (n: string[]) => setFacets((p) => ({ ...p, [f.key]: n })), options: f.options })),
    ...ui.presets.map((p) => ({ label: p.label, selected: presets[p.key] ?? [], onChange: (n: string[]) => setPresets((x) => ({ ...x, [p.key]: n.slice(-1) as DatePreset[] })), options: p.presets })),
    ...(ui.groupBy.length
      ? [{ label: "Group by", selected: groupKey ? [groupKey] : [], onChange: (n: string[]) => setGroupKey(n.at(-1) ?? null), options: ui.groupBy.map((k) => ({ value: k, label: k === ACCOUNT_FIELD ? ui.accountLabel : v.label(k) })) }]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`record-area-${area}`}>
      <Toolbar
        noun={ui.noun}
        nounPlural={ui.nouns}
        q={typed}
        setQ={setTyped}
        sort={sort}
        setSort={setSort}
        sortOptions={ui.sorts}
        onClose={onClose}
        onCreate={
          access.create
            ? () => {
                setSelId(null);
                setCreating(true);
              }
            : undefined
        }
        createLabel={ui.createLabel}
        viewSwitcher={<Modes modes={ui.modes} mode={mode} setMode={setMode} />}
        filter={filterGroups.length ? <FilterMenu groups={filterGroups} /> : undefined}
      />
      <RecordMetricStrip metrics={metrics} />
      {error || actionError ? (
        <p role="alert" className={cn("px-4 pt-3 text-red-400", TYPE.meta)}>
          {actionError ?? error}
        </p>
      ) : notice ? (
        <p role="status" data-testid="record-notice" className={cn("px-4 pt-3 text-amber-400", TYPE.meta)}>
          {notice}
        </p>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {rows === null && !error ? (
            <p className={cn("py-10 text-center text-muted-foreground", TYPE.meta)}>{ui.loading}</p>
          ) : (rows?.length ?? 0) === 0 ? (
            <p className={cn("py-16 text-center text-muted-foreground/60 italic", TYPE.meta)}>{ui.empty}</p>
          ) : groups && mode === "table" ? (
            <div className="min-h-0 flex-1 overflow-auto" data-testid="grouped-list">
              {groups.map(([g, items]) => (
                <section key={g || "—"} data-testid="group-section">
                  <div className="border-border/60 border-b bg-muted/20 px-6 pt-4 pb-2" data-testid="group-header">
                    <span className={cn("font-medium text-foreground", TYPE.body)}>{g || "—"}</span>
                    <span className={cn("ml-2 text-muted-foreground", TYPE.micro)}>{items.length}</span>
                  </div>
                  <WorkspaceViews view="table" config={{ ...config, items }} />
                </section>
              ))}
            </div>
          ) : (
            <WorkspaceViews view={mode} config={{ ...config, items: rows ?? [] }} />
          )}
          {next ? (
            <div className="flex justify-center border-border/60 border-t py-2">
              <OpsButton intent="ghost" size="sm" onClick={() => void load(next)} data-testid="record-more">
                Show more
              </OpsButton>
            </div>
          ) : null}
        </div>
        {creating ? (
          <SidePanel onClose={() => setCreating(false)}>
            <RecordCreate
              ui={ui}
              areas={areas}
              endpoint={endpoint}
              authorEmail={authorEmail}
              access={access}
              accountPicker={accountPicker}
              onCancel={() => setCreating(false)}
              onCreated={async (id) => {
                setCreating(false);
                await load();
                setSelId(id);
              }}
            />
          </SidePanel>
        ) : selected ? (
          <SidePanel onClose={() => setSelId(null)} actions={renderActions(selected, () => { setSelId(null); refetch(); }, { delete: access.delete(rowOf(selected)) })}>
            <RecordDetail ui={ui} row={selected} busy={busy} chrome={chrome} access={access} onPatch={(body) => void patch(selected, body)} related={renderRelated(selected)} />
          </SidePanel>
        ) : null}
      </div>
    </div>
  );
}

/** The detail: the title, the lifecycle's moves, the definition's sections, then the related work. */
function RecordDetail({
  ui,
  row,
  busy,
  chrome,
  access,
  onPatch,
  related,
}: {
  readonly ui: RecordAreaUi;
  readonly row: RecordAreaRow;
  readonly busy: boolean;
  readonly chrome: RecordAreaChrome;
  /** What this person may change (./record-access.ts): what they may not is shown, not editable. */
  readonly access: RecordAccess;
  readonly onPatch: (body: Record<string, unknown>) => void;
  readonly related: React.ReactNode;
}) {
  const v = ui.view;
  const lc = ui.lifecycle;
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What was just picked shows at once (a box ticked stays ticked); the stored row replaces it when it comes back.
  const [picked, setPicked] = useState<Record<string, FormValue>>({});
  useEffect(() => setPicked({}), [row]);
  const { PanelHeader, PanelSection } = chrome;
  const state = lc ? listChoice(v, row, lc.field) || null : null;
  const moves = lc && (v.area.lifecycle?.transitions?.length ?? 0) > 0 ? lc.movesFrom(state) : [];
  const lcField = lc ? v.field(lc.field) : undefined;
  const record = rowOf(row);
  const mayMove = access.transition(record);
  const mayRename = access.update(record);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="record-detail">
      <PanelHeader eyebrow={ui.singular}>
        <input
          key={row.displayName ?? ""}
          defaultValue={row.displayName ?? ""}
          placeholder={row.title ?? row.label}
          aria-label="Title"
          readOnly={!mayRename}
          className="w-full truncate bg-transparent font-semibold text-[15px] text-foreground leading-snug outline-none placeholder:text-muted-foreground/60"
          onBlur={(e) => {
            const t = e.target.value.trim();
            if (t !== (row.displayName ?? "")) onPatch({ displayName: t });
          }}
        />
        <p className={cn("mt-0.5 truncate text-muted-foreground", TYPE.meta)}>
          {[row.customerLabel ?? row.customer, ui.idField ? row.recordId ?? row.id : null].filter(Boolean).join(" · ")}
        </p>
      </PanelHeader>
      <div className="flex flex-col gap-5 px-5 py-4">
        {lcField && moves.length ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="lifecycle-moves">
            <span className={cn("text-muted-foreground", TYPE.micro)}>{v.display(lcField.key, state) || "—"} →</span>
            {moves.map((m) => (
              <OpsButton key={`${m.to}:${m.transition?.label ?? ""}`} intent="secondary" size="sm" disabled={busy || !mayMove} onClick={() => onPatch(fieldBody(lcField, m.to))}>
                {m.transition?.label ?? v.display(lcField.key, m.to)}
              </OpsButton>
            ))}
          </div>
        ) : null}
        {ui.sections.filter((s) => s.fields.length).map((s, i) => (
          <PanelSection key={`${s.label ?? ""}:${i}`} label={s.label ?? "Properties"}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-4">
              {s.fields.map((f) =>
                f.computed ? (
                  <Field key={f.key} label={f.label ?? f.key}>
                    <span className={TYPE.body} data-record-value={f.key}>
                      <FieldValue ui={ui} row={row} keyName={f.key} />
                    </span>
                  </Field>
                ) : (
                  <RecordFieldControl
                    key={`${f.key}:${JSON.stringify(listValue(row, f.key) ?? null)}`}
                    field={f}
                    value={picked[f.key] ?? formValueOf(f, listValue(row, f.key))}
                    error={errors[f.key]}
                    disabled={busy || !access.field(f.key, record)}
                    onCommit={(x) => {
                      const value = writeValueOf(f, x);
                      if (value === null && f.required === true) return setErrors((p) => ({ ...p, [f.key]: `"${f.label ?? f.key}" (${f.key}) is required, so it cannot be cleared.` }));
                      setErrors(({ [f.key]: _drop, ...rest }) => rest);
                      setPicked((p) => ({ ...p, [f.key]: x }));
                      onPatch(fieldBody(f, value));
                    }}
                  />
                ),
              )}
            </div>
          </PanelSection>
        ))}
        <div className={cn(SURFACE.inset, "flex flex-col gap-1.5 p-3")}>
          <div className="flex items-center justify-between gap-4">
            <span className={cn("text-muted-foreground", TYPE.micro)}>{ui.accountLabel}</span>
            <span className={cn("truncate text-right", TYPE.meta)}>{row.customer ?? "—"}</span>
          </div>
          {ui.idField ? (
            <div className="flex items-center justify-between gap-4">
              <span className={cn("text-muted-foreground", TYPE.micro)}>{ui.idLabel}</span>
              <span className={cn("truncate text-right font-mono", TYPE.meta)}>{row.recordId ?? row.id}</span>
            </div>
          ) : null}
        </div>
      </div>
      {related}
    </div>
  );
}

/** The create form: the account, the id, the definition's fields; checked as the API checks it before it is sent. */
function RecordCreate({
  ui,
  areas,
  endpoint,
  authorEmail,
  access,
  accountPicker,
  onCreated,
  onCancel,
}: {
  readonly ui: RecordAreaUi;
  readonly areas: RecordAreas;
  readonly endpoint: string;
  readonly authorEmail?: string;
  readonly access: RecordAccess;
  readonly accountPicker: (p: { value: string; onChange: (id: string) => void; disabled?: boolean }) => React.ReactNode;
  readonly onCreated: (id: string) => void | Promise<void>;
  readonly onCancel: () => void;
}) {
  const me = authorEmail;
  const initial = (f: RecordField): FormValue => {
    // A new record starts in the lifecycle's initial state.
    if (ui.lifecycle && f.key === ui.lifecycle.field && ui.lifecycle.initial) return ui.lifecycle.initial;
    const d = f.default;
    if (d === "{me}") return me ?? "";
    if (typeof d === "string" && /^\{today/.test(d)) {
      const m = /\+(\d+)d/.exec(d);
      return new Date(Date.now() + (m ? Number(m[1]) : 0) * 86_400_000).toISOString().slice(0, 10);
    }
    if (Array.isArray(d)) return d.map(String);
    if (typeof d === "boolean") return d;
    if (d !== undefined && d !== null && !String(d).startsWith("{")) return String(d);
    return formValueOf(f, null);
  };
  const [account, setAccount] = useState("");
  const [recordId, setRecordId] = useState("");
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(ui.createFields.map((f) => [f.key, initial(f)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    for (const f of ui.createFields) {
      // A field this person may not set is left to its default.
      if (!access.field(f.key, null)) continue;
      const x = writeValueOf(f, values[f.key]);
      if (x === null) continue;
      if (f.column) body[f.key] = x;
      else custom[f.key] = x;
    }
    if (Object.keys(custom).length) body.custom = custom;
    if (ui.idField && recordId.trim()) body[ui.idField] = recordId.trim();
    const problems: Record<string, string> = {};
    const rest: string[] = [];
    if (!account) problems[ACCOUNT_FIELD] = `Pick ${/^[aeiou]/i.test(ui.accountLabel) ? "an" : "a"} ${ui.accountLabel.toLowerCase()}.`;
    // The same check the API runs (agent/lib/record-area-write.ts), so each sentence lands under its own field.
    // Who may is the API's to say (a 403 with its sentence): the form only leaves out what it does not offer.
    const checked = prepareRecordWrite(ui.id, "create", body, { actor: me ?? "", checkPermissions: false }, areas);
    if (!checked.ok) {
      for (const e of checked.errors) {
        const key = /\(([A-Za-z0-9_]+)\)/.exec(e)?.[1];
        if (key && (ui.createFields.some((f) => f.key === key) || key === ui.idField) && !problems[key]) problems[key] = e;
        else rest.push(e);
      }
    }
    setErrors(problems);
    setFormError(rest.length ? rest.join(" ") : null);
    if (Object.keys(problems).length || rest.length) return;
    setBusy(true);
    try {
      const res = await opsFetch<{ item: { id: string } }>(endpoint, { method: "POST", body: JSON.stringify({ customerId: account, ...body, actor: me }) });
      await onCreated(res.item.id);
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="record-create"
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="pr-12 font-semibold text-[15px] text-foreground">{ui.createTitle}</h2>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        <div className="flex min-w-0 flex-col gap-1.5" data-record-field={ACCOUNT_FIELD}>
          <label>
            <span className={cn("font-medium text-muted-foreground", TYPE.meta)}>
              {ui.accountLabel}
              <span aria-hidden="true" className="text-red-400"> *</span>
            </span>
          </label>
          {accountPicker({ value: account, onChange: setAccount, disabled: busy })}
          {errors[ACCOUNT_FIELD] ? <span role="alert" className={cn("text-red-400", TYPE.micro)}>{errors[ACCOUNT_FIELD]}</span> : null}
        </div>
        {ui.idField ? (
          <div className="flex min-w-0 flex-col gap-1.5" data-record-field={ui.idField}>
            <label htmlFor="record-create-id">
              <span className={cn("font-medium text-muted-foreground", TYPE.meta)}>
                {ui.idLabel}
                <span aria-hidden="true" className="text-red-400"> *</span>
              </span>
            </label>
            <OpsInput id="record-create-id" value={recordId} disabled={busy} placeholder={ui.idPlaceholder} onChange={(e) => setRecordId(e.target.value)} />
            {errors[ui.idField] ? <span role="alert" className={cn("text-red-400", TYPE.micro)}>{errors[ui.idField]}</span> : null}
          </div>
        ) : null}
        {ui.createFields.map((f) => (
          <RecordFieldControl
            key={f.key}
            field={f}
            value={values[f.key]}
            error={errors[f.key]}
            disabled={busy || !access.field(f.key, null)}
            onChange={(x) => {
              setValues((p) => ({ ...p, [f.key]: x }));
              setErrors(({ [f.key]: _drop, ...rest }) => rest);
            }}
          />
        ))}
      </div>
      {formError ? (
        <p role="alert" className={cn("text-red-400", TYPE.meta)}>
          {formError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <OpsButton type="submit" intent="primary" disabled={busy}>
          {ui.createLabel}
        </OpsButton>
        <OpsButton type="button" intent="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </OpsButton>
      </div>
    </form>
  );
}
