"use client";

/**
 * Ops Center UI primitives — every visual building block of the modal, built
 * on `components/ui/*` and the tokens in ./tokens.ts. Panels compose these and
 * carry no raw <input>/<textarea>/<button> markup of their own, so a future
 * design tweak is a one-line change here (or in tokens.ts).
 */

import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  MoreHorizontalIcon,
  PauseIcon,
  RefreshCwIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  type LucideIcon,
  Trash2Icon,
  XIcon,
  type PlugIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  SECTION_META,
  errMessage,
  opsFetch,
  useOpsList,
  type OpsPerson,
  type OpsSection,
} from "./lib";
import {
  BUTTON_INTENT,
  BUTTON_SIZE,
  CONTROL,
  SPACE,
  SURFACE,
  TYPE,
  statusDot,
  type ButtonIntent,
  type OpsButtonSize,
} from "./tokens";
import { W } from "@/lib/ui-words";

/* --------------------------------- Buttons -------------------------------- */

/**
 * The only button in the Ops Center. `intent` picks the hierarchy level,
 * `size` the density — both resolve through tokens onto the shared Button.
 */
export function OpsButton({
  intent = "secondary",
  size = "sm",
  className,
  ...props
}: React.ComponentProps<"button"> & {
  readonly intent?: ButtonIntent;
  readonly size?: OpsButtonSize;
}) {
  const v = BUTTON_INTENT[intent];
  const s = BUTTON_SIZE[size];
  return (
    <Button type="button" variant={v.variant} size={s.ui} className={cn(v.cls, s.cls, className)} {...props} />
  );
}

/** Square icon-only button (row menu trigger, pager arrows, panel close). */
export function IconButton({
  intent = "ghost",
  className,
  ...props
}: React.ComponentProps<"button"> & { readonly intent?: ButtonIntent }) {
  const v = BUTTON_INTENT[intent];
  return (
    <Button type="button" variant={v.variant} size="icon-xs" className={cn(v.cls, className)} {...props} />
  );
}

/* ------------------------------- Form controls ---------------------------- */

/** Shared Input at the modal's compact density. */
export function OpsInput({ className, ...props }: React.ComponentProps<"input">) {
  return <Input className={cn(CONTROL, className)} {...props} />;
}

/** Shared Textarea at the modal's compact density. */
export function OpsTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <Textarea className={cn(CONTROL, "min-h-16 resize-y", className)} {...props} />;
}

/**
 * Native <select> skinned to the control token. Deliberately native (not the
 * Radix Select) so keyboard/focus behaviour inside the modal stays exactly
 * what it was.
 */
export function OpsSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "w-full appearance-none border outline-none",
        CONTROL,
        "text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Label + control + optional hint. Wraps any of the controls above. */
export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col", SPACE.fieldGap)}>
      <span className={cn("font-medium text-muted-foreground", TYPE.meta)}>{label}</span>
      {children}
      {hint ? <span className={cn("text-muted-foreground/60", TYPE.micro)}>{hint}</span> : null}
    </label>
  );
}

/**
 * Notify-email input shared by every form and wizard. (There is deliberately
 * no "notify when" field — the record's own prompt carries those instructions.)
 */
export function NotifyEmailField({
  recipients,
  onRecipients,
}: {
  readonly recipients: string[];
  readonly onRecipients: (value: string[]) => void;
}) {
  return (
    <Field
      label="Notify"
      hint="Optional — who gets alerted. Search your people, or type any address."
    >
      <RecipientsPicker value={recipients} onChange={onRecipients} />
    </Field>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The notify-recipients picker: chips for the chosen addresses, a live search
 * over the people we actually have in Postgres (GET /api/ops/people — internal
 * staff + customer stakeholders, deduped by email), and free entry for anyone
 * who isn't in those tables.
 *
 * Controlled, so the wizard (NotifyEmailField) and the detail panel's inline
 * editor (InlineRecipients) share one implementation.
 */
export function RecipientsPicker({
  value,
  onChange,
  disabled,
}: {
  readonly value: string[];
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<OpsPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The list is tiny (a handful of rows) — fetch it whole once and filter locally.
    void opsFetch<{ items: OpsPerson[] }>("/api/ops/people")
      .then((d) => setPeople(d.items))
      .catch((e) => setError(errMessage(e)));
  }, []);

  const toggle = (email: string) =>
    onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);

  const addTyped = () => {
    const email = query.trim();
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      setError(`"${email}" is not a valid email address.`);
      return;
    }
    if (!value.includes(email)) onChange([...value, email]);
    setQuery("");
    setError(null);
  };

  const q = query.trim().toLowerCase();
  const results = (people ?? []).filter(
    (p) => !q || [p.name, p.email, p.title, p.org].some((f) => f?.toLowerCase().includes(q)),
  );

  return (
    <div className={cn("flex min-w-0 flex-col", SPACE.fieldGap)}>
      {value.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {value.map((e) => (
            <span
              key={e}
              className={cn(SURFACE.chip, "flex items-center gap-1 font-mono", TYPE.micro)}
            >
              {e}
              <button
                type="button"
                aria-label={`Remove ${e}`}
                disabled={disabled}
                onClick={() => toggle(e)}
                className="text-muted-foreground/60 hover:text-foreground"
              >
                <XIcon className="size-2.5" />
              </button>
            </span>
          ))}
        </span>
      ) : null}

      <OpsInput
        aria-label="Search people"
        value={query}
        disabled={disabled}
        placeholder="Search people, or type an email…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTyped();
          }
        }}
      />

      <div className="max-h-44 overflow-y-auto rounded-md border border-border">
        {people === null && !error ? (
          <span
            className={cn("flex items-center gap-1.5 px-2 py-2 text-muted-foreground", TYPE.micro)}
          >
            <Spinner className="size-3" />
            Loading people…
          </span>
        ) : results.length === 0 ? (
          <span className={cn("block px-2 py-2 text-muted-foreground/60", TYPE.micro)}>
            {q ? "No match — press ⏎ to add it as an address." : "No people found."}
          </span>
        ) : (
          results.map((p) => {
            const picked = value.includes(p.email);
            return (
              <button
                key={p.email}
                type="button"
                aria-pressed={picked}
                disabled={disabled}
                onClick={() => toggle(p.email)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-muted/50",
                  picked && "bg-muted/40",
                )}
              >
                <CheckIcon
                  aria-hidden
                  className={cn("size-3 shrink-0", picked ? "text-foreground" : "text-transparent")}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", TYPE.body)}>{p.name}</span>
                  <span
                    className={cn("block truncate font-mono text-muted-foreground", TYPE.micro)}
                  >
                    {p.email}
                  </span>
                </span>
                <span className={cn("shrink-0 text-muted-foreground/60", TYPE.micro)}>
                  {p.kind === "internal" ? "internal" : (p.org ?? "stakeholder")}
                </span>
              </button>
            );
          })
        )}
      </div>

      {error ? <span className={cn("break-words text-red-400", TYPE.micro)}>{error}</span> : null}
    </div>
  );
}

/** Small on/off switch used by the wizards and the inline enabled editor. */
export function EnabledToggle({
  checked,
  onToggle,
  disabled,
}: {
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? "Disable" : "Enable"}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full border transition-colors",
        checked ? "border-emerald-500/60 bg-emerald-500/70" : "border-border bg-muted",
        disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] size-2.5 rounded-full bg-white transition-all",
          checked ? "left-[15px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

/* ------------------------------ Status + chips ---------------------------- */

/** Traffic-light dot with its label exposed as title/aria-label. */
export function StatusDot({ status, label }: { readonly status: string; readonly label?: string }) {
  const text = label ?? status;
  return (
    <span
      title={text}
      aria-label={text}
      className={cn("size-2 shrink-0 rounded-full", statusDot(status))}
    />
  );
}

/** Tiny muted pill for table cells (trigger, access, cadence). */
export function Chip({ className, children }: { readonly className?: string; readonly children: React.ReactNode }) {
  return (
    <span className={cn("whitespace-nowrap text-muted-foreground", SURFACE.chip, TYPE.meta, className)}>
      {children}
    </span>
  );
}

/** Chip variant rendered as <code> in the mono font (cron expressions). */
export function CodeChip({ className, children }: { readonly className?: string; readonly children: React.ReactNode }) {
  return (
    <code
      className={cn("whitespace-nowrap font-mono text-muted-foreground", SURFACE.chip, TYPE.meta, className)}
    >
      {children}
    </code>
  );
}

/** The muted em-dash placeholder used in table cells. */
export function EmptyCell() {
  return <span className={cn("text-muted-foreground/50", TYPE.meta)}>—</span>;
}

/* -------------------------------- Contexts -------------------------------- */

/**
 * `connectors.lands` is free text, but in practice it always says the same two
 * things: WHICH parts of the dm.md tree a connector writes into, and WHERE
 * under them the sync lands — "<accounts>/·/<tickets>/·/<people>/syncs/slack", each a domain's label.
 * Printed raw into a cell, that is line noise that gets cut mid-word and hides
 * the rest behind a hover.
 *
 * So split it instead of truncating it: the leading capitalised segments are
 * the containers, everything after the first lowercase one is the leaf path.
 * Free text that doesn't fit the shape (no leading container) is left alone —
 * it renders as the sentence someone wrote.
 */
export function parseContexts(raw: string): { containers: string[]; leaf: string | null } {
  const containers: string[] = [];
  const rest: string[] = [];
  for (const token of raw.split(/[·,/]+/).map((t) => t.trim()).filter(Boolean)) {
    // Order matters: once the path has dropped into lowercase it is the leaf,
    // and a capitalised word inside it ("mirrored to <the accounts folder>/{id}/…") is part
    // of the leaf, not another container.
    if (rest.length === 0 && /^[A-Z]/.test(token)) containers.push(token);
    else rest.push(token);
  }
  return { containers, leaf: rest.length ? rest.join("/") : null };
}

const MAX_CONTAINERS = 3;

/** The Contexts cell: containers as chips, the sync leaf as a quiet path. */
export function ContextCell({ value }: { readonly value: string | null | undefined }) {
  const raw = value?.trim();
  if (!raw) return <EmptyCell />;
  const { containers, leaf } = parseContexts(raw);
  if (containers.length === 0) {
    return (
      <span title={raw} className={cn("block max-w-64 truncate text-muted-foreground", TYPE.meta)}>
        {raw}
      </span>
    );
  }
  const shown = containers.slice(0, MAX_CONTAINERS);
  const hidden = containers.length - shown.length;
  return (
    <span title={raw} className="flex max-w-72 min-w-0 items-center gap-1">
      {shown.map((c) => (
        <Chip key={c} className="text-foreground/80">
          {c}
        </Chip>
      ))}
      {hidden > 0 ? (
        <span className={cn("shrink-0 text-muted-foreground/60", TYPE.meta)}>+{hidden}</span>
      ) : null}
      {leaf ? (
        <code
          className={cn("min-w-0 truncate font-mono text-muted-foreground/60", TYPE.micro)}
        >
          {leaf}
        </code>
      ) : null}
    </span>
  );
}

/* --------------------------------- Banners -------------------------------- */

export function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <p className={cn("rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-red-400", TYPE.meta)}>
      {message}
    </p>
  );
}

export function Banners({
  loadError,
  actionError,
  noun,
}: {
  readonly loadError: string | null;
  readonly actionError: string | null;
  readonly noun: string;
}) {
  if (!loadError && !actionError) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2">
      {loadError ? <ErrorBanner message={`Failed to load ${noun}s: ${loadError}`} /> : null}
      {actionError ? <ErrorBanner message={actionError} /> : null}
    </div>
  );
}

/* -------------------------------- Row menu -------------------------------- */

// Review opens the detail panel, which IS the editor (fields edit inline) —
// so there is no separate Edit item.
export function RowMenu({
  enabled,
  onReview,
  onToggleEnabled,
  onDelete,
  onRefresh,
  pending,
  canToggle = true,
  canDelete = true,
}: {
  readonly enabled: boolean;
  readonly onReview: () => void;
  /** Optional — adds a Refresh item directly under Review. */
  readonly onRefresh?: () => void;
  readonly onToggleEnabled: () => void;
  readonly onDelete: () => void;
  readonly pending: boolean;
  readonly canToggle?: boolean;
  readonly canDelete?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-label="Row actions"
          disabled={pending}
          className="shrink-0 data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          {pending ? <Spinner className="size-3.5" /> : <MoreHorizontalIcon className="size-3.5" />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem className={cn("gap-2", TYPE.body)} onSelect={() => onReview()}>
          <EyeIcon className="size-3.5" />
          Review
        </DropdownMenuItem>
        {onRefresh ? (
          <DropdownMenuItem className={cn("gap-2", TYPE.body)} onSelect={() => onRefresh()}>
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </DropdownMenuItem>
        ) : null}
        {canToggle ? (
          <DropdownMenuItem className={cn("gap-2", TYPE.body)} onSelect={() => onToggleEnabled()}>
            {enabled ? (
              <>
                <PauseIcon className="size-3.5" />
                Pause
              </>
            ) : (
              <>
                <PlayIcon className="size-3.5" />
                Resume
              </>
            )}
          </DropdownMenuItem>
        ) : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className={cn("gap-2", TYPE.body)}
              onSelect={() => onDelete()}
            >
              <Trash2Icon className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ---------------------------- Confirm delete ------------------------------ */

export function ConfirmDeleteDialog({
  name,
  onCancel,
  onConfirm,
}: {
  readonly name: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(SURFACE.overlay, "w-full max-w-sm gap-3 border-white/10 p-5 sm:max-w-sm")}
      >
        <DialogHeader>
          <DialogTitle className={TYPE.title}>{`Delete "${name ?? ""}"?`}</DialogTitle>
          <DialogDescription className={TYPE.body}>This can&apos;t be undone.</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-1">
          <OpsButton intent="secondary" size="sm" onClick={onCancel}>
            Cancel
          </OpsButton>
          <OpsButton intent="danger" size="sm" onClick={onConfirm}>
            Delete
          </OpsButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- Workflow multi-select ------------------------ */

/**
 * Which WORKFLOWS a connector feeds — the connector's `synced` list.
 *
 * A closed set, so it is a picker, not free text: the options are the declared
 * workflows (GET /api/ops/workflows), and a typo can no longer name a workflow
 * that does not exist. A value already on the row that matches no workflow —
 * the free-text era stored data streams here ("messages", "channels") — is
 * still listed, checked, and marked, so an operator sees it and can uncheck it
 * rather than have it vanish silently on the next save.
 */
export function WorkflowMultiSelect({
  values,
  onChange,
  disabled,
}: {
  readonly values: string[];
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
}) {
  const { items } = useOpsList<{ id: string; name: string; description: string }>(
    "/api/ops/workflows",
  );
  const names = (items ?? []).map((w) => w.name);
  const stale = values.filter((v) => !names.includes(v));

  const toggle = (name: string) => {
    onChange(values.includes(name) ? values.filter((v) => v !== name) : [...values, name]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OpsButton
          intent="secondary"
          size="sm"
          disabled={disabled}
          className="h-auto min-h-8 w-full justify-start gap-1.5 py-1.5 font-normal data-[state=open]:border-foreground/30"
        >
          {values.length === 0 ? (
            <span className="text-muted-foreground">Select workflows…</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              {values.map((v) => (
                <Chip key={v} className={stale.includes(v) ? "text-amber-500" : undefined}>
                  {v}
                </Chip>
              ))}
            </span>
          )}
          <ChevronDownIcon className="ml-auto size-3.5 shrink-0 opacity-60" />
        </OpsButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-64 overflow-y-auto">
        {items === null ? (
          <DropdownMenuItem disabled className={cn("gap-2", TYPE.body)}>
            <Spinner className="size-3" />
            Loading workflows…
          </DropdownMenuItem>
        ) : names.length === 0 ? (
          <DropdownMenuItem disabled className={TYPE.body}>
            No workflows yet
          </DropdownMenuItem>
        ) : (
          (items ?? []).map((w) => (
            <DropdownMenuCheckboxItem
              key={w.id}
              checked={values.includes(w.name)}
              onSelect={(e) => {
                // Keep the menu open — picking several workflows is the norm.
                e.preventDefault();
                toggle(w.name);
              }}
              className={cn("flex-col items-start gap-0", TYPE.body)}
            >
              <span className="w-full truncate font-medium">{w.name}</span>
              {w.description ? (
                // Two lines, then stop. These descriptions are paragraphs — one
                // of them is 300 characters — and a menu is not where you read
                // them.
                <span
                  className={cn(
                    "line-clamp-2 w-full whitespace-normal text-muted-foreground",
                    TYPE.micro,
                  )}
                >
                  {w.description}
                </span>
              ) : null}
            </DropdownMenuCheckboxItem>
          ))
        )}
        {stale.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className={cn("text-muted-foreground", TYPE.micro)}>
              Not a workflow — left over from free text
            </DropdownMenuLabel>
            {stale.map((v) => (
              <DropdownMenuCheckboxItem
                key={v}
                checked
                onSelect={(e) => {
                  e.preventDefault();
                  toggle(v);
                }}
                className={cn("text-amber-500", TYPE.body)}
              >
                {v}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * WHICH workflow runs something — a single choice, with "None" meaning the
 * orchestrator handles it itself. Same closed set as WorkflowMultiSelect.
 */
export function WorkflowSelect({
  value,
  onChange,
  disabled,
  noneLabel = "None — the orchestrator runs it",
}: {
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
  readonly disabled?: boolean;
  readonly noneLabel?: string;
}) {
  const { items } = useOpsList<{ id: string; name: string; description: string }>(
    "/api/ops/workflows",
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OpsButton
          intent="secondary"
          size="sm"
          disabled={disabled}
          className="w-full justify-start gap-1.5 font-normal data-[state=open]:border-foreground/30"
        >
          {value ? (
            <span className="truncate">{value}</span>
          ) : (
            <span className="truncate text-muted-foreground">{noneLabel}</span>
          )}
          <ChevronDownIcon className="ml-auto size-3.5 shrink-0 opacity-60" />
        </OpsButton>
      </DropdownMenuTrigger>
      {/* A WIDTH, which this never had. `truncate` on the description below
          cannot do anything without one, so each item grew to fit a whole
          sentence and dragged the menu out to the width of the viewport. */}
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <DropdownMenuCheckboxItem
          checked={value === null}
          onSelect={() => onChange(null)}
          className={cn("text-muted-foreground", TYPE.body)}
        >
          {noneLabel}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {items === null ? (
          <DropdownMenuItem disabled className={cn("gap-2", TYPE.body)}>
            <Spinner className="size-3" />
            Loading workflows…
          </DropdownMenuItem>
        ) : (
          (items ?? []).map((w) => (
            <DropdownMenuCheckboxItem
              key={w.id}
              checked={value === w.name}
              onSelect={() => onChange(w.name)}
              className={cn("flex-col items-start gap-0", TYPE.body)}
            >
              <span className="w-full truncate font-medium">{w.name}</span>
              {w.description ? (
                // Two lines, then stop. These descriptions are paragraphs — one
                // of them is 300 characters — and a menu is not where you read
                // them.
                <span
                  className={cn(
                    "line-clamp-2 w-full whitespace-normal text-muted-foreground",
                    TYPE.micro,
                  )}
                >
                  {w.description}
                </span>
              ) : null}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Pick one customer (or none) from the live /api/ops/customers feed — an inline
 * dropdown, same shape as WorkflowSelect. `value` is the customer id; the label
 * shows the customer's name. Null = team-wide / no scope.
 */
export function CustomerSelect({
  value,
  onChange,
  disabled,
  noneLabel = "None — team-wide",
}: {
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
  readonly disabled?: boolean;
  readonly noneLabel?: string;
}) {
  const { items } = useOpsList<{ id: string; name: string }>("/api/ops/customers");
  const selected = (items ?? []).find((c) => c.id === value);
  const label = selected?.name ?? value; // fall back to the raw id if unknown
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OpsButton
          intent="secondary"
          size="sm"
          disabled={disabled}
          className="w-full justify-start gap-1.5 font-normal data-[state=open]:border-foreground/30"
        >
          {value ? (
            <span className="truncate">{label}</span>
          ) : (
            <span className="truncate text-muted-foreground">{noneLabel}</span>
          )}
          <ChevronDownIcon className="ml-auto size-3.5 shrink-0 opacity-60" />
        </OpsButton>
      </DropdownMenuTrigger>
      {/* A WIDTH, which this never had. `truncate` on the description below
          cannot do anything without one, so each item grew to fit a whole
          sentence and dragged the menu out to the width of the viewport. */}
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <DropdownMenuCheckboxItem
          checked={value === null}
          onSelect={() => onChange(null)}
          className={cn("text-muted-foreground", TYPE.body)}
        >
          {noneLabel}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {items === null ? (
          <DropdownMenuItem disabled className={cn("gap-2", TYPE.body)}>
            <Spinner className="size-3" />
            Loading {W.accounts}…
          </DropdownMenuItem>
        ) : (
          (items ?? []).map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={value === c.id}
              onSelect={() => onChange(c.id)}
              className={cn("flex-col items-start gap-0", TYPE.body)}
            >
              <span>{c.name}</span>
              <span className={cn("truncate text-muted-foreground", TYPE.micro)}>{c.id}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------- Table chrome (header, search, frame) --------------- */

export function SectionHeaderCard({
  section,
  noun,
  onAdd,
  secondary,
  verb = "Add",
  icon: PrimaryIcon = PlusIcon,
}: {
  readonly section: OpsSection;
  readonly noun: string;
  readonly onAdd: () => void;
  /**
   * The primary action's verb. Defaults to "Add" — most sections create a
   * thing. Connectors say "Configure", because a connector is not finished when
   * the row exists: it is finished when it holds its credentials.
   */
  readonly verb?: string;
  /** The primary action's glyph; defaults to a plus, which is what "Add" means
   *  everywhere else. A section that renames the verb usually wants its own. */
  readonly icon?: LucideIcon;
  /**
   * A second way in, folded into the primary button as a dropdown rather than
   * standing beside it. Two buttons of near-equal weight made the header read
   * as two competing choices; this keeps one action on the surface and puts the
   * rarer path one click underneath it.
   */
  readonly secondary?: {
    readonly label: string;
    readonly onClick: () => void;
    /** Its own glyph. Two identical plus signs make the menu look like a
     *  duplicate of the button above it rather than a different road. */
    readonly icon?: LucideIcon;
  };
}) {
  const meta = SECTION_META[section];
  const Icon = meta.icon;
  return (
    <div className={cn("flex shrink-0 items-center gap-3 px-4 py-3", SURFACE.card)}>
      <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className={cn("leading-tight", TYPE.title)}>{meta.title}</h2>
        <p className={cn("mt-0.5 truncate text-muted-foreground", TYPE.meta)}>{meta.blurb}</p>
      </div>
      {/* The only primary action on the screen, so it LOOKS like one: solid,
          on the body type step, h-7. Quiet-but-outlined read as disabled next to
          the section title, and at the 2xs button default the label came out at
          10px — smaller than the blurb underneath it. Compact, not timid. */}
      {/* Split button: the label runs the common path, the caret opens the rest.
          Joined into one shape (the two halves share a border and lose their
          facing corners) so it reads as a single control with a second gear,
          not as two buttons that happen to touch. */}
      <div className="flex shrink-0 items-stretch">
        <OpsButton
          intent="primary"
          size="sm"
          onClick={onAdd}
          className={cn(
            "h-7 shrink-0 gap-1.5 px-3 font-medium",
            secondary ? "rounded-l-lg rounded-r-none" : "rounded-lg",
            TYPE.body,
          )}
        >
          <PrimaryIcon className="size-3.5" />
          {verb} {verb === "Add" ? noun : noun.toLowerCase()}
        </OpsButton>
        {secondary ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <OpsButton
                intent="primary"
                size="sm"
                aria-label={`More ${noun.toLowerCase()} options`}
                className={cn(
                  "h-7 shrink-0 rounded-l-none rounded-r-lg border-l border-background/25 px-1.5",
                  TYPE.body,
                )}
              >
                <ChevronDownIcon className="size-3.5" />
              </OpsButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem
                className={cn("gap-2", TYPE.body)}
                onSelect={() => secondary.onClick()}
              >
                {secondary.icon ? (
                  <secondary.icon className="size-3.5" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
                {secondary.label}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

export function SearchBox({
  noun,
  value,
  onChange,
}: {
  readonly noun: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="relative shrink-0">
      <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground/60" />
      <OpsInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Search ${noun}s…`}
        className="py-2 pr-2.5 pl-8"
      />
    </div>
  );
}

export function Th({
  icon: Icon,
  label,
  align = "left",
}: {
  readonly icon?: typeof PlugIcon;
  readonly label: string;
  readonly align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-border border-b text-muted-foreground first:pl-4 last:pr-4",
        SPACE.headerCell,
        TYPE.label,
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <span className="inline-flex items-center gap-1">
        {Icon ? <Icon className="size-3 opacity-70" /> : null}
        {label}
      </span>
    </th>
  );
}

/** Standard body cell at the table's cell spacing. `colSpan` lets an empty /
 *  loading row stretch the FULL table so its message centres, instead of being
 *  crammed into the first column. */
export function Td({
  className,
  colSpan,
  children,
}: {
  readonly className?: string;
  readonly colSpan?: number;
  readonly children: React.ReactNode;
}) {
  return (
    <td colSpan={colSpan} className={cn(SPACE.cell, className)}>
      {children}
    </td>
  );
}

export function ListRow({
  selected,
  dimmed,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly dimmed?: boolean;
  readonly onSelect: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "cursor-default outline-none transition-colors focus-visible:bg-muted/40",
        selected ? SURFACE.rowSelected : SURFACE.rowHover,
        dimmed && "opacity-60",
      )}
    >
      {children}
    </tr>
  );
}

/**
 * Deep-linkable row name — a REAL anchor to `/?ops=<section>&id=<id>`, so
 * cmd/ctrl-click, shift-click, and middle-click open the Ops Center in a new
 * tab natively (landing on this section with this row's detail panel open).
 * A plain left-click is prevented and simply bubbles to the row's onSelect,
 * so in-app behaviour is unchanged.
 */
export function DeepLink({
  section,
  id,
  className,
  children,
}: {
  readonly section: OpsSection;
  readonly id: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <a
      href={`/?ops=${section}&id=${encodeURIComponent(id)}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        // Only modified clicks navigate; a plain click selects the row.
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) e.preventDefault();
      }}
      className={className}
    >
      {children}
    </a>
  );
}

/** First cell of a row — carries the selected-row accent bar. */
export function NameCell({
  selected,
  children,
}: {
  readonly selected: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <td
      className={cn(
        "relative py-2.5 pr-3 pl-4",
        selected &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-primary",
      )}
    >
      {children}
    </td>
  );
}

export function MenuCell({ children }: { readonly children: React.ReactNode }) {
  return (
    // Row-selection must not fire when interacting with the ⋯ menu.
    // biome-ignore lint/a11y/useKeyWithClickEvents: click containment only
    <td className="py-2.5 pr-4 pl-3" onClick={(e) => e.stopPropagation()}>
      <span className="flex items-center justify-end">{children}</span>
    </td>
  );
}

/** Full-width loading / empty row. */
export function StateRow({
  span,
  italic,
  children,
}: {
  readonly span: number;
  readonly italic?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={span}
        className={cn("px-4 py-14 text-center text-muted-foreground", TYPE.body, italic && "italic")}
      >
        {children}
      </td>
    </tr>
  );
}

/** Table footer: row count + configurable page size + pager. */
export function ListFooter({
  noun,
  total,
  page,
  pages,
  onPage,
  pageSize,
  onPageSize,
  children,
}: {
  readonly noun: string;
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly onPage: (page: number) => void;
  readonly pageSize?: number;
  readonly onPageSize?: (size: number) => void;
  /** Extra footer content (e.g. hidden-row recovery), placed left of the pager. */
  readonly children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 border-border border-t",
        SPACE.chromeBar,
      )}
    >
      <div className="flex items-center gap-2.5">
        {pageSize !== undefined && onPageSize ? (
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            aria-label="Rows per page"
            className={cn(
              "h-6 rounded-md border border-border bg-background px-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
              TYPE.meta,
            )}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        ) : null}
        {children}
      </div>
      <div className="flex items-center gap-1.5">
        <IconButton
          intent="secondary"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeftIcon className="size-3.5" />
        </IconButton>
        <span
          className={cn(
            "grid size-6 place-items-center rounded-md bg-foreground font-medium text-background tabular-nums",
            TYPE.meta,
          )}
        >
          {page}
        </span>
        {pages > 1 ? (
          <span className={cn("text-muted-foreground tabular-nums", TYPE.meta)}>of {pages}</span>
        ) : null}
        <IconButton
          intent="secondary"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRightIcon className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

/* ---------------- Layout: full-width table + transient sidebar ------------ */

/**
 * Resting state: the table column is the only child and spans the modal width.
 * When `panel` is present it becomes a sibling and the table reflows narrower
 * (30/70 split — the table collapses to its compact density).
 */
export function PanelLayout({
  header,
  table,
  panel,
}: {
  /** Section header + search, rendered FULL WIDTH above the list/panel row so
   *  the list and the detail panel share the same top edge (no offset). When
   *  omitted, falls back to the legacy layout (everything in `table`). */
  readonly header?: React.ReactNode;
  readonly table: React.ReactNode;
  readonly panel: React.ReactNode | null;
}) {
  if (header !== undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className={cn("flex shrink-0 flex-col", SPACE.formGap)}>{header}</div>
        <div className="flex min-h-0 flex-1 gap-4">
          <div className={cn("flex min-h-0 min-w-0 flex-col transition-all duration-200", panel ? "w-[30%] shrink-0" : "flex-1")}>
            {table}
          </div>
          {panel}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      {/* Full width at rest; 30/70 against the panel once it opens. */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col transition-all duration-200",
          SPACE.formGap,
          panel ? "w-[30%] shrink-0" : "flex-1",
        )}
      >
        {table}
      </div>
      {panel}
    </div>
  );
}

/** Transient right sidebar: × close affordance + Escape (without closing the modal). */
export function SidePanel({
  onClose,
  children,
  actions,
}: {
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  // Record-level actions, rendered immediately left of the dismiss button.
  readonly actions?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An inner overlay (the ⌘K instructions editor) owns Escape while focus
      // is inside it — let it close itself instead of closing the panel.
      if (e.target instanceof Element && e.target.closest("[data-escape-trap]")) return;
      // An OPEN MENU owns Escape too. Radix renders it in a portal, so it is not
      // inside the panel and the check above never sees it: without this, Escape
      // dismissed the menu AND took the whole panel down with it.
      if (document.querySelector('[role="menu"][data-state="open"]')) return;
      // Swallow it so Radix's Dialog doesn't close the whole ops modal.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <aside
      aria-label="Details"
      className={cn("relative flex min-h-0 w-[70%] flex-1 flex-col overflow-hidden", SURFACE.card)}
    >
      <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-0.5">
        {actions}
        <IconButton aria-label="Close panel" onClick={onClose}>
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
      {children}
    </aside>
  );
}

export function TableCard({
  children,
  footer,
  flush = false,
}: {
  readonly children: React.ReactNode;
  readonly footer: React.ReactNode;
  /**
   * Drop the card's own frame.
   *
   * Inside a dialog the surface is already a card, so the table drew a second
   * bordered box a few pixels inside the first — two frames saying the same
   * thing, with the gap between them reading as a mistake.
   */
  readonly flush?: boolean;
}) {
  return (
    <div
      className={cn(
        // No `overflow-hidden` on the frame: it clipped rows below the fold
        // behind a box nobody can scroll. The inner region is the ONE scroll
        // container (both axes) and rounds its own top corners instead.
        "flex min-h-0 flex-1 flex-col",
        flush ? "rounded-none border-0 bg-transparent" : SURFACE.card,
      )}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-t-[inherit]">
        {/* No min-width: the columns compress (and truncate) when the panel
            squeezes the table to 30% rather than forcing a horizontal scroll. */}
        <table className={cn("w-full text-left", TYPE.body)}>{children}</table>
      </div>
      {footer}
    </div>
  );
}

/* ------------------------------ Wizard scaffold --------------------------- */

export interface RadioOption<V extends string> {
  value: V;
  title: string;
  description: string;
  /** Optional glyph shown beside the title. */
  icon?: typeof PlugIcon;
  /**
   * Why this choice is unavailable. Present = disabled, and the reason is
   * shown in place of the description — an option that is greyed out with no
   * explanation reads as a bug, and the person cannot tell whether to go and
   * ask someone for it.
   */
  disabledReason?: string;
}

export function RadioCards<V extends string>({
  label,
  value,
  onChange,
  options,
  orientation = "vertical",
}: {
  readonly label: string;
  readonly value: V | "";
  readonly onChange: (value: V) => void;
  readonly options: RadioOption<V>[];
  /** "horizontal" lays the cards side by side, sharing the width equally. */
  readonly orientation?: "vertical" | "horizontal";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = options.findIndex((o) => o.value === value);
  const horizontal = orientation === "horizontal";
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex gap-2", horizontal ? "flex-row" : "flex-col")}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const disabled = Boolean(o.disabledReason);
        const tabbable = !disabled && (selected || (selectedIdx === -1 && i === 0));
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled}
            aria-disabled={disabled}
            title={o.disabledReason}
            onClick={() => !disabled && onChange(o.value)}
            onKeyDown={(e) => {
              const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
              const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
              if (!forward && !back) return;
              e.preventDefault();
              // Skip past anything unavailable rather than landing on it.
              let next = i;
              for (let hop = 0; hop < options.length; hop++) {
                next = (next + (forward ? 1 : -1) + options.length) % options.length;
                if (!options[next].disabledReason) break;
              }
              if (options[next].disabledReason) return;
              onChange(options[next].value);
              refs.current[next]?.focus();
            }}
            className={cn(
              "flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
              horizontal ? "min-w-0 flex-1 basis-0" : "w-full",
              selected
                ? "border-foreground/50 bg-muted/40 ring-1 ring-foreground/30"
                : "border-border hover:border-foreground/25 hover:bg-muted/20",
              disabled && "cursor-not-allowed opacity-55 hover:border-border hover:bg-transparent",
            )}
          >
            {/* No radio dot — the card's own border + ring carries selection.
                role="radio" + aria-checked still convey it to assistive tech. */}
            <span className="min-w-0">
              <span className={cn("flex items-center gap-1.5 text-foreground", TYPE.title)}>
                {o.icon ? <o.icon className="size-3.5 shrink-0 opacity-80" /> : null}
                <span className="min-w-0 truncate">{o.title}</span>
              </span>
              <span className={cn("mt-0.5 block text-muted-foreground", TYPE.body)}>
                {/* The reason REPLACES the description when unavailable: what
                    this option would do matters less than why you cannot pick
                    it and who could. */}
                {o.disabledReason ?? o.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function WizardFrame({
  heading,
  subtitle,
  step,
  stepCount,
  valid,
  creating,
  error,
  onBack,
  onNext,
  children,
}: {
  readonly heading: string;
  readonly subtitle: string;
  readonly step: number;
  readonly stepCount: number;
  readonly valid: boolean;
  readonly creating: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onNext: () => void;
  readonly children: React.ReactNode;
}) {
  const isLast = step === stepCount - 1;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center px-5 py-6">
          <div className={cn("flex w-full max-w-[640px] flex-col", "gap-5")}>
            <div className="pr-8">
              <h3 className={TYPE.heading}>{heading}</h3>
              <p className={cn("mt-1 text-muted-foreground", TYPE.body)}>{subtitle}</p>
            </div>
            {error ? <ErrorBanner message={error} /> : null}
            {children}
          </div>
        </div>
      </div>
      <div
        className={cn(
          "grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-border border-t",
          SPACE.panelFooter,
        )}
      >
        <div>
          <OpsButton intent="ghost" size="sm" onClick={onBack} disabled={creating}>
            <ChevronLeftIcon className="size-3.5" />
            Back
          </OpsButton>
        </div>
        <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${stepCount}`}>
          {Array.from({ length: stepCount }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static dot list
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === step ? "bg-foreground" : "bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
        <div className="flex justify-end">
          <OpsButton
            intent="primary"
            size="sm"
            onClick={onNext}
            disabled={!valid || creating}
            className="rounded-full px-4"
          >
            {creating ? <Spinner className="size-3" /> : null}
            {isLast ? "Create" : "Next"}
            {isLast ? null : <ChevronRightIcon className="size-3.5" />}
          </OpsButton>
        </div>
      </div>
    </div>
  );
}
