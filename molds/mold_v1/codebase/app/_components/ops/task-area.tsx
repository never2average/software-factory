"use client";

/**
 * THE TASKS VIEW, AS THE DEPLOYMENT DEFINES A TASK (profiles records.areas.tasks; agent/lib/record-areas.ts).
 *
 * `taskUi(view)` is everything the Tasks list, board, table and detail read that the definition decides: the words,
 * the states (the board's columns) and where they live (the status column, or the task's own state field), the
 * priorities, the sorts, the table's columns, the labels. For the DEFAULT definition it is today's literals, exactly:
 * the default deployment's Tasks view does not change by a character. For a REDEFINED one every piece comes from the
 * definition, and base code only branches on a state's category and a field's type.
 *
 * `TaskCreatePanel` is the create form a redefined task needs (its required fields are asked for up front, checked by
 * the same validator the API runs, agent/lib/record-validate.ts); `TaskOwnFields` the detail's own fields.
 */
import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { BoardColumn } from "./board";
import { Field, OpsButton, OpsInput, OpsSelect, OpsTextarea } from "./primitives";
import { SPACE, TYPE } from "./tokens";
import { inputFor, TONE_CLASS, type AreaView, type RecordAreas, type RecordField } from "@/agent/lib/record-areas";
import { validateRecordWrite } from "@/agent/lib/record-validate";
import { coerceFieldValue } from "@/agent/lib/record-values";
import { TASK_PASS_THROUGH } from "@/agent/lib/task-area";

export type TaskState = { readonly value: string; readonly label: string; readonly tone: string };
export type TaskSortKey = string;

/** The default deployment's Tasks view: today's literals, unchanged. */
const LEGACY_STATES: readonly TaskState[] = [
  { value: "backlog", label: "Backlog", tone: "bg-muted-foreground/40" },
  { value: "open", label: "Open", tone: "bg-sky-500" },
  { value: "in_progress", label: "In progress", tone: "bg-amber-500" },
  { value: "blocked", label: "Blocked", tone: "bg-red-500" },
  { value: "done", label: "Done", tone: "bg-emerald-500" },
  { value: "cancelled", label: "Cancelled", tone: "bg-muted-foreground/25" },
];
const LEGACY_UI = {
  redefined: false,
  navLabel: "Tasks",
  navBlurb: "The team's internal checklist.",
  /** The toolbar's and the banners' noun. */
  noun: "todo",
  createLabel: "New task",
  loading: "Loading todos…",
  empty: "No todos yet — hit New task.",
  eyebrow: "Task",
  untitled: "Untitled task",
  /** The subtask line's placeholder. */
  addSubtask: "Add subtask…",
  deleteLabel: "Delete task",
  states: LEGACY_STATES,
  columns: LEGACY_STATES.map((s) => ({ key: s.value, label: s.label, tone: s.tone })) as BoardColumn[],
  /** Where a task's state lives: the status column, or (own) the task's own field under `custom`. */
  stateField: "status",
  ownState: false,
  initialState: "open",
  doneState: "done",
  priorities: [
    { value: "low", label: "Low" },
    { value: "normal", label: "Normal" },
    { value: "high", label: "High" },
  ] as readonly { value: string; label: string }[],
  sorts: [
    { value: "created", label: "Newest" },
    { value: "priority", label: "Priority" },
    { value: "due", label: "Due date" },
    { value: "title", label: "Title" },
  ] as readonly { value: TaskSortKey; label: string }[],
  labels: { title: "Task", status: "Status", priority: "Priority", due: "Due", assignee: "Assignee", notes: "Notes" },
  assigneeHint: "Blank = the creator." as string | undefined,
  assigneePlaceholder: "name@company.com",
  notesPlaceholder: "Any detail…",
  /** The table's columns beyond today's (none by default); a redefined table lists its own. */
  tableColumns: null as string[] | null,
  defaultSort: "created" as TaskSortKey,
};
export type TaskUi = typeof LEGACY_UI;

/** A sort of the definition as the list sorts it: today's four keys, or `field:<key>` for any other field. */
const SORT_KEY: Record<string, TaskSortKey> = { createdAt: "created", priority: "priority", dueAt: "due", title: "title" };

export function taskUi(v: AreaView): TaskUi {
  if (!v.redefined || !v.lifecycle) return LEGACY_UI;
  const lc = v.lifecycle;
  const states = lc.states.filter((s) => !s.retired).map((s) => ({ value: s.value, label: s.label, tone: TONE_CLASS[s.tone ?? "muted"] }));
  const submit = v.submitLabel;
  return {
    redefined: true,
    navLabel: v.area.nav?.label ?? v.plural,
    navBlurb: v.description || LEGACY_UI.navBlurb,
    noun: v.noun,
    createLabel: submit,
    loading: v.area.views?.loading ?? `Loading ${v.nouns}…`,
    empty: v.area.views?.empty ?? `No ${v.nouns} yet — hit ${submit}.`,
    eyebrow: v.singular,
    untitled: titlePlaceholder(v),
    addSubtask: `Add sub-${v.noun}…`,
    deleteLabel: `Delete ${v.noun}`,
    states,
    columns: states.map((s) => ({ key: s.value, label: s.label, tone: s.tone })),
    stateField: lc.field,
    ownState: lc.own,
    initialState: lc.initial ?? states[0]?.value ?? "open",
    doneState: lc.states.find((s) => s.category === "done")?.value ?? "done",
    priorities: v.options("priority").map((o) => ({ value: o.value, label: o.label })),
    sorts: v.sorts.map((s) => ({ value: SORT_KEY[s.field] ?? `field:${s.field}`, label: s.label })),
    labels: {
      title: v.label("title", LEGACY_UI.labels.title),
      status: v.label(lc.field, LEGACY_UI.labels.status),
      priority: v.label("priority", LEGACY_UI.labels.priority),
      due: v.label("dueAt", LEGACY_UI.labels.due),
      assignee: v.label("assignee", LEGACY_UI.labels.assignee),
      notes: v.label("notes", LEGACY_UI.labels.notes),
    },
    assigneeHint: v.field("assignee")?.help,
    assigneePlaceholder: v.field("assignee")?.placeholder ?? LEGACY_UI.assigneePlaceholder,
    notesPlaceholder: v.field("notes")?.placeholder ?? LEGACY_UI.notesPlaceholder,
    tableColumns: v.tableColumns(),
    defaultSort: (() => {
      const d = v.sorts.find((x) => x.default);
      return d ? SORT_KEY[d.field] ?? `field:${d.field}` : LEGACY_UI.defaultSort;
    })(),
  };
}

/**
 * The title's placeholder: the definition's own, else "Untitled <its word>". A redefined area that names its records
 * but not the title's placeholder inherits the default's ("Untitled task") when profiles merge; that one is the
 * default's word, so it is read as unset.
 */
function titlePlaceholder(v: AreaView): string {
  const own = v.field("title")?.placeholder;
  return own && own !== LEGACY_UI.untitled ? own : `Untitled ${v.noun}`;
}

/** A task's state: its status, or its own state field's value (the initial state when none is stored yet). */
export function stateOf(ui: TaskUi, v: AreaView, t: { status: string; custom?: Record<string, unknown> | null }): string {
  if (!ui.ownState) return ui.states.some((s) => s.value === t.status) ? t.status : "open";
  const s = v.get(t as never, ui.stateField);
  return typeof s === "string" && ui.states.some((x) => x.value === s) ? s : ui.initialState;
}
/** The write that moves a task to a state. */
export const moveTo = (ui: TaskUi, state: string): Record<string, unknown> => (ui.ownState ? { custom: { [ui.stateField]: state } } : { status: state });

/** What a field's value is, as the form holds it (a string for every control but a list). */
type FormValue = string | string[] | boolean;
const today = () => new Date().toISOString().slice(0, 10);
function initialValue(f: RecordField, me: string | undefined): FormValue {
  const d = f.default;
  if (d === "{me}") return me ?? "";
  if (typeof d === "string" && /^\{today/.test(d)) {
    const m = /\+(\d+)d/.exec(d);
    return new Date(Date.now() + (m ? Number(m[1]) : 0) * 86_400_000).toISOString().slice(0, 10);
  }
  if (Array.isArray(d)) return d.map(String);
  if (typeof d === "boolean") return d;
  if (d !== undefined && d !== null) return String(d);
  return inputFor(f) === "multiselect" || inputFor(f) === "file" || inputFor(f) === "tags" ? [] : f.type === "boolean" ? false : "";
}
const blank = (x: FormValue) => (Array.isArray(x) ? x.length === 0 : typeof x === "string" ? x.trim() === "" : false);

/**
 * One field of a record area: its label (with a required marker), the control for its type, its help, its error.
 * Controlled (`onChange`) on the create form; on the detail card `onCommit` saves on blur or on pick.
 */
export function RecordFieldControl({
  field,
  value,
  error,
  disabled,
  onChange,
  onCommit,
}: {
  readonly field: RecordField;
  readonly value: FormValue;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly onChange?: (value: FormValue) => void;
  readonly onCommit?: (value: FormValue) => void;
}) {
  const id = useId();
  const kind = inputFor(field);
  const required = field.required === true || field.required === "on_create";
  const described = [field.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const shared = { id, name: field.column ? field.key : `custom.${field.key}`, disabled, "aria-required": required || undefined, "aria-invalid": error ? true : undefined, "aria-describedby": described };
  const text = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  const bind = onChange ? { value: text } : { defaultValue: text };
  const choices = (field.options ?? []).filter((o) => !o.retired);
  const commitText = (t: string) => {
    const next: FormValue = kind === "file" || kind === "tags" ? t.split(/\n|,/).map((x) => x.trim()).filter(Boolean) : t;
    onChange?.(next);
    if (onCommit && JSON.stringify(next) !== JSON.stringify(value)) onCommit(next);
  };
  let control: React.ReactNode;
  if (kind === "select") {
    control = (
      <OpsSelect key={onChange ? undefined : text} {...shared} {...bind} onChange={(e) => commitText(e.target.value)}>
        <option value="">{required ? "Choose…" : "—"}</option>
        {text && !choices.some((o) => o.value === text) ? <option value={text}>{text}</option> : null}
        {choices.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </OpsSelect>
    );
  } else if (kind === "multiselect") {
    const picked = Array.isArray(value) ? value : [];
    control = (
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${id}-label`}>
        {choices.map((o) => (
          <label key={o.value} className={cn("flex items-center gap-1.5", TYPE.meta)}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={picked.includes(o.value)}
              onChange={(e) => {
                const next = e.target.checked ? [...picked, o.value] : picked.filter((x) => x !== o.value);
                onChange?.(next);
                onCommit?.(next);
              }}
            />
            {o.label ?? o.value}
          </label>
        ))}
      </div>
    );
  } else if (kind === "checkbox") {
    control = <input type="checkbox" {...shared} checked={Boolean(value)} onChange={(e) => { onChange?.(e.target.checked); onCommit?.(e.target.checked); }} />;
  } else if (kind === "textarea" || kind === "file" || kind === "tags") {
    control = (
      <OpsTextarea
        {...shared}
        {...bind}
        rows={kind === "textarea" ? 3 : 2}
        placeholder={field.placeholder ?? (kind === "file" ? "One data-room path per line" : kind === "tags" ? "Comma-separated" : undefined)}
        onChange={onChange ? (e) => commitText(e.target.value) : undefined}
        onBlur={onCommit ? (e) => commitText(e.target.value) : undefined}
      />
    );
  } else {
    const type = kind === "number" ? "number" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : kind === "email" || kind === "person" ? "email" : kind === "url" ? "url" : "text";
    control = (
      <OpsInput
        {...shared}
        {...bind}
        type={type}
        placeholder={field.placeholder}
        onChange={onChange ? (e) => commitText(e.target.value) : undefined}
        onBlur={onCommit ? (e) => commitText(e.target.value) : undefined}
      />
    );
  }
  return (
    <div data-record-field={field.key} className={cn("flex min-w-0 flex-col", SPACE.fieldGap, kind === "textarea" || kind === "multiselect" ? "col-span-2" : null)}>
      <label htmlFor={id} id={`${id}-label`}>
        <span className={cn("font-medium text-muted-foreground", TYPE.meta)}>
          {field.label ?? field.key}
          {required ? <span aria-hidden="true" className="text-red-400"> *</span> : null}
        </span>
      </label>
      {control}
      {field.help ? <span id={`${id}-help`} className={cn("text-muted-foreground/60", TYPE.micro)}>{field.help}</span> : null}
      {error ? (
        <span id={`${id}-error`} role="alert" className={cn("text-red-400", TYPE.micro)}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A form value as the write takes it: a due day is that day's morning (as the detail sends it), a list stays a list. */
function writeValue(f: RecordField, x: FormValue): unknown {
  if (blank(x)) return null;
  if (f.column && f.key === "dueAt" && typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) return new Date(`${x}T09:00:00Z`).toISOString();
  if (typeof x === "string" && ["integer", "number", "percent", "money"].includes(f.type)) return x.trim();
  return x;
}

/**
 * The create form of a REDEFINED task: its create fields (the definition's), each with its default, checked by the
 * same validator the API runs before anything is sent. `onCreate` posts the body and returns the new id, or throws.
 */
export function TaskCreatePanel({
  view,
  areas,
  me,
  onCreate,
  onCancel,
}: {
  readonly view: AreaView;
  readonly areas: RecordAreas;
  readonly me?: string;
  readonly onCreate: (body: Record<string, unknown>) => Promise<void>;
  readonly onCancel: () => void;
}) {
  // The title's placeholder in the area's own word (titlePlaceholder), as the detail's title shows it.
  const fields = useMemo(() => view.createFields().map((f) => (f.key === "title" ? { ...f, placeholder: taskUi(view).untitled } : f)), [view]);
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(fields.map((f) => [f.key, initialValue(f, me)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    for (const f of fields) {
      const x = writeValue(f, values[f.key]);
      if (x === null) continue;
      if (f.column) body[f.key] = x;
      else custom[f.key] = x;
    }
    if (Object.keys(custom).length) body.custom = custom;
    const checked = validateRecordWrite("tasks", { mode: "create", patch: body, actor: me ?? "", passThrough: TASK_PASS_THROUGH }, areas);
    if (!checked.ok) {
      const byField: Record<string, string> = {};
      const rest: string[] = [];
      for (const e of checked.errors) {
        const key = /\(([A-Za-z0-9_]+)\)/.exec(e)?.[1];
        if (key && fields.some((f) => f.key === key) && !byField[key]) byField[key] = e;
        else rest.push(e);
      }
      setErrors(byField);
      setFormError(rest.length ? rest.join(" ") : null);
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onCreate({ ...body, createdBy: me ?? "web" });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="task-create"
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className={cn("pr-12 font-semibold text-[15px] text-foreground")}>{view.area.views?.create?.title ?? `New ${view.noun}`}</h2>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        {fields.map((f) => (
          <RecordFieldControl
            key={f.key}
            field={f}
            value={values[f.key]}
            error={errors[f.key]}
            disabled={busy}
            onChange={(x) => {
              setValues((p) => ({ ...p, [f.key]: x }));
              setErrors((p) => {
                if (!p[f.key]) return p;
                const { [f.key]: _drop, ...rest } = p;
                return rest;
              });
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
          {view.submitLabel}
        </OpsButton>
        <OpsButton type="button" intent="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </OpsButton>
      </div>
    </form>
  );
}

/** A stored own value as the form holds it. */
const formValueOf = (f: RecordField, x: unknown): FormValue => (Array.isArray(x) ? x.map(String) : typeof x === "boolean" ? x : x === null || x === undefined ? (f.type === "boolean" ? false : inputFor(f) === "multiselect" || inputFor(f) === "file" || inputFor(f) === "tags" ? [] : "") : String(x));

/**
 * A REDEFINED task's own fields on its detail card (the state field aside: the detail's state select moves it). Each
 * saves on blur or on pick as `{ custom: { key: value } }`; a value the field would not take is answered under it,
 * with the API's sentence, and not sent.
 */
export function TaskOwnFields({
  view,
  ui,
  custom,
  busy,
  onPatch,
}: {
  readonly view: AreaView;
  readonly ui: TaskUi;
  readonly custom: Record<string, unknown>;
  readonly busy: boolean;
  readonly onPatch: (body: Record<string, unknown>) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fields = view.ownFields.filter((f) => !f.hidden && f.key !== ui.stateField);
  if (!fields.length) return null;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4">
      {fields.map((f) =>
        f.computed ? (
          <Field key={f.key} label={f.label ?? f.key}>
            <span className={TYPE.body}>{view.display(f.key, view.get({ custom }, f.key)) || "—"}</span>
          </Field>
        ) : (
          <RecordFieldControl
            key={`${f.key}:${JSON.stringify(custom[f.key] ?? null)}`}
            field={f}
            value={formValueOf(f, view.get({ custom }, f.key))}
            error={errors[f.key]}
            disabled={busy}
            onCommit={(x) => {
              const value = blank(x) ? null : x;
              if (value !== null) {
                const out = coerceFieldValue(f, value);
                if ("error" in out) return setErrors((p) => ({ ...p, [f.key]: out.error }));
              } else if (f.required === true) return setErrors((p) => ({ ...p, [f.key]: `"${f.label}" (${f.key}) is required, so it cannot be cleared.` }));
              setErrors((p) => {
                const { [f.key]: _drop, ...rest } = p;
                return rest;
              });
              onPatch({ custom: { [f.key]: value } });
            }}
          />
        ),
      )}
    </div>
  );
}

export { today as todayIso };
