"use client";

/** Connectors section: table, stepped Add wizard, inline-editable detail panel. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellRingIcon,
  BoxIcon,
  KeyRoundIcon,
  LinkIcon,
  PlugZapIcon,
  ServerIcon,
  FolderTreeIcon,
  PowerIcon,
  RefreshCwIcon,
  TagIcon,
  TextIcon,
  TypeIcon,
  UserIcon,
  ZapIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TOOL_META } from "../dataroom";
import {
  EMPTY_VALUE,
  DetailLabel,
  DetailPanel,
  InlineEnabled,
  InlineField,
  SummaryList,
  StatusLine,
  editableNotifyEmailSection,
  recordSection,
  reviewText,
  type DetailSection,
  type InlineOption,
} from "./detail";
import {
  errMessage,
  fmtTime,
  matches,
  opsFetch,
  panelId,
  splitList,
  useOpsList,
  usePager,
  type Access,
  type ApiConnector,
  type ApiConnectorSecret,
  type ApiWorkflow,
  type PanelState,
} from "./lib";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Banners,
  Chip,
  ConfirmDeleteDialog,
  DeepLink,
  ContextCell,
  EmptyCell,
  ErrorBanner,
  Field,
  ListFooter,
  ListRow,
  MenuCell,
  NameCell,
  NotifyEmailField,
  OpsButton,
  OpsInput,
  PanelLayout,
  RadioCards,
  RowMenu,
  SearchBox,
  SectionHeaderCard,
  SidePanel,
  StateRow,
  StatusDot,
  TableCard,
  WorkflowMultiSelect,
  Td,
  Th,
  WizardFrame,
  type RadioOption,
} from "./primitives";
import { CONTROL_DENSE, STATUS_META, SURFACE, TYPE } from "./tokens";

const ACCESS_LABEL: Record<Access, string> = {
  read: "read",
  write: "write",
  read_write: "read & write",
};

const ACCESS_INLINE_OPTIONS: InlineOption[] = [
  { value: "read", label: "read" },
  { value: "write", label: "write" },
  { value: "read_write", label: "read & write" },
];

const STATUS_INLINE_OPTIONS: InlineOption[] = [
  { value: "connected", label: "connected" },
  { value: "read_only", label: "read-only" },
  { value: "setup", label: "setup needed" },
];

function ToolLogo({ name }: { readonly name: string }) {
  const color = TOOL_META[name]?.color ?? "#64748b";
  return (
    <span
      className={cn("grid size-7 shrink-0 place-items-center font-semibold text-white rounded-md", TYPE.body)}
      style={{ backgroundColor: color }}
    >
      {name.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * The connector detail panel's sections — every field the PATCH endpoint
 * honours edits inline; only the derived Record provenance stays plain.
 */
function connectorDetailSections(
  c: ApiConnector,
  patch: (body: Record<string, unknown>) => Promise<void>,
): DetailSection[] {
  // Deliberately NOT here: name (the panel title says it), kind, status, detail
  // and "lands in". They described the connector rather than letting you operate
  // it, and status in particular was seeded text, not a live health check.
  const isCustom = Boolean(c.endpointUrl);
  return [
    // Only a bring-your-own connector has an endpoint to show; a built-in
    // kind's URL lives in code and editing it here would do nothing.
    ...(isCustom
      ? [
          {
            icon: LinkIcon,
            label: "Endpoint",
            value: (
              <InlineField
                label="endpoint"
                value={c.endpointUrl ?? ""}
                placeholder="https://mcp.example.com/mcp"
                hint="The MCP server the agent calls. Public https only."
                onCommit={(v: string) => patch({ endpointUrl: v.trim() || null })}
              />
            ),
          } satisfies DetailSection,
          {
            icon: KeyRoundIcon,
            label: "Required secrets",
            value: <RequiredSecretsEditor connector={c} patch={patch} />,
          } satisfies DetailSection,
        ]
      : []),
    {
      icon: BoxIcon,
      label: "Access",
      value: (
        <InlineField
          label="access"
          variant="select"
          value={c.access}
          options={ACCESS_INLINE_OPTIONS}
          display={ACCESS_LABEL[c.access] ?? c.access}
          onCommit={(v) => patch({ access: v })}
        />
      ),
    },
    {
      icon: PowerIcon,
      label: "Enabled",
      value: <InlineEnabled enabled={c.enabled} onCommit={(next) => patch({ enabled: next })} />,
    },
    {
      icon: RefreshCwIcon,
      label: "Synced",
      // The workflows this connector feeds — a closed set, so a picker rather
      // than free text. Each toggle saves; there is no separate commit.
      value: (
        <WorkflowMultiSelect
          values={c.synced ?? []}
          onChange={(next: string[]) => void patch({ synced: next.length ? next : null })}
        />
      ),
    },
    editableNotifyEmailSection(c.notifyEmails, patch),
    {
      icon: BellRingIcon,
      label: "Notify when",
      value: (
        <InlineField
          label="notify condition"
          variant="multiline"
          value={c.notifyWhen ?? ""}
          placeholder="e.g. the sync fails twice in a row, or a customer channel goes quiet for a week"
          hint="The condition, in your words. ⌘⏎ to save · esc to cancel"
          onCommit={(v) => patch({ notifyWhen: v.trim() || null })}
        />
      ),
    },
    recordSection(c),
  ];
}


/**
 * What "3 workflows" actually means, on hover.
 *
 * The cell used to hang a native `title` off the count — a comma-joined list of
 * names, unstyled, half a second late, and silent about what any of them DO or
 * whether they are even running. A connector's whole job is feeding those
 * workflows, so the hover names them, says what each one does, and flags the two
 * things that make the row a lie: a workflow that is paused (the connector feeds
 * nothing) and a name that matches no workflow at all (stale free text left over
 * from before this was a picker).
 */
function SyncedTooltip({
  synced,
  workflows,
  children,
}: {
  readonly synced: string[];
  readonly workflows: ApiWorkflow[];
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        variant="panel"
        sideOffset={6}
        // A FIXED width, not w-fit: a one-word workflow name and a long
        // description would otherwise give every row a different box.
        className="w-72 p-0"
      >
        <p className={cn("border-border/60 border-b px-2.5 py-1.5 font-medium", TYPE.meta)}>
          Feeds {synced.length} workflow{synced.length === 1 ? "" : "s"}
        </p>
        <ul className="flex flex-col divide-y divide-border/60">
          {synced.map((name) => {
            const w = workflows.find((x) => x.name === name);
            return (
              <li key={name} className="flex flex-col gap-0.5 px-2.5 py-1.5">
                <span className="flex items-baseline gap-1.5">
                  <span className={cn("min-w-0 truncate font-mono", TYPE.meta)}>{name}</span>
                  {!w ? (
                    <span className={cn("ml-auto shrink-0 text-amber-500", TYPE.micro)}>
                      no such workflow
                    </span>
                  ) : !w.enabled ? (
                    <span className={cn("ml-auto shrink-0 text-amber-500", TYPE.micro)}>
                      paused
                    </span>
                  ) : null}
                </span>
                {/* Wraps rather than truncates — the description is the reason
                    you hovered. text-balance would rag it; this stays flush left. */}
                <span className={cn("text-muted-foreground leading-snug", TYPE.micro)}>
                  {w ? w.description : "Nothing by this name exists any more — it feeds nothing."}
                </span>
              </li>
            );
          })}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** How a connector's DERIVED health renders: dot + the sentence behind it. */
const HEALTH_META: Record<string, { dot: string; label: string }> = {
  live: { dot: "bg-emerald-500", label: "Live — every secret it uses is set in the agent" },
  degraded: {
    dot: "bg-amber-500",
    label: "Partly working — an optional secret is missing (e.g. Slack can post but not read)",
  },
  missing: { dot: "bg-red-500", label: "Missing a required secret — this connector cannot run" },
  unimplemented: { dot: "bg-muted-foreground/40", label: "No connector code exists for this kind yet" },
  unknown: { dot: "bg-muted-foreground/40", label: "The agent has not reported its environment yet" },
};

/* --------------------------------- Secrets -------------------------------- */

/**
 * The credentials this connector needs, and the two DIFFERENT facts about each:
 *
 * - LIVE: the name is set in the running agent's environment. Reported by the
 *   agent's own dispatcher (agent/lib/env-presence.ts) — the Ops Center runs in
 *   a different Vercel project, so it cannot see the agent's env itself. This
 *   is the only thing that means the connector actually works.
 * - STORED: an operator typed a value in here. It is encrypted at rest and the
 *   API never gives it back — you get the last 4 characters, nothing else.
 *
 * A stored secret does NOT make the connector live: eve's connection modules
 * read process.env at import time, so it has to be promoted to the agent's
 * environment. The row says exactly that instead of showing a green light.
 */
function SecretRow({
  secret,
  connectorId,
  authorEmail,
  onChanged,
}: {
  readonly secret: ApiConnectorSecret;
  readonly connectorId: string;
  readonly authorEmail?: string;
  readonly onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
      setEditing(false);
      setDraft("");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await opsFetch(`/api/ops/connectors/${connectorId}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ name: secret.name, value: draft, actor: authorEmail }),
      });
    });

  const clear = () =>
    run(async () => {
      await opsFetch(`/api/ops/connectors/${connectorId}/secrets`, {
        method: "DELETE",
        body: JSON.stringify({ name: secret.name, actor: authorEmail }),
      });
    });

  // Blunt about WHICH of the two facts holds — "stored" is not "working".
  const status = secret.live
    ? "Live in the agent"
    : secret.stored
      ? "Stored — not in the agent's env"
      : secret.live === null
        ? "Not reported"
        : "Missing";
  const tone = secret.live
    ? "text-emerald-500"
    : secret.stored
      ? "text-amber-500"
      : secret.optional
        ? "text-muted-foreground/60"
        : "text-red-400";

  return (
    <li className="flex flex-col gap-1.5 px-2.5 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={cn("truncate font-mono", TYPE.meta)}>{secret.name}</span>
        {secret.optional ? (
          <span className={cn("shrink-0 text-muted-foreground/50", TYPE.micro)}>optional</span>
        ) : null}
        {secret.stored && !editing ? (
          <span className={cn("shrink-0 font-mono text-muted-foreground/60", TYPE.micro)}>
            ••••{secret.hint}
          </span>
        ) : null}
        <span className={cn("ml-auto shrink-0", TYPE.micro, tone)}>{status}</span>
      </div>
      <div className="flex items-center gap-2">
        <p className={cn("min-w-0 flex-1 truncate text-muted-foreground", TYPE.micro)}>
          {secret.purpose}
        </p>
        {editing ? null : (
          <>
            <OpsButton
              intent="ghost"
              size="xs"
              disabled={busy}
              className={cn("h-6 shrink-0 px-2 font-normal", TYPE.meta)}
              onClick={() => {
                setDraft("");
                setError(null);
                setEditing(true);
              }}
            >
              {secret.stored ? "Replace" : "Add"}
            </OpsButton>
            {secret.stored ? (
              <OpsButton
                intent="ghost"
                size="xs"
                disabled={busy}
                className={cn("h-6 shrink-0 px-2 font-normal text-muted-foreground", TYPE.meta)}
                onClick={() => void clear()}
              >
                Remove
              </OpsButton>
            ) : null}
          </>
        )}
      </div>
      {editing ? (
        <div data-escape-trap className="flex items-center gap-1.5">
          <OpsInput
            autoFocus
            type="password"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Paste ${secret.name}`}
            className={cn("flex-1 font-mono", CONTROL_DENSE)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) void save();
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <OpsButton
            intent="primary"
            size="xs"
            disabled={busy || !draft.trim()}
            className={cn("h-6 shrink-0 px-2 font-normal", TYPE.meta)}
            onClick={() => void save()}
          >
            {busy ? <Spinner className="size-3" /> : null}
            Store
          </OpsButton>
          <OpsButton
            intent="ghost"
            size="xs"
            disabled={busy}
            className={cn("h-6 shrink-0 px-2 font-normal", TYPE.meta)}
            onClick={() => setEditing(false)}
          >
            Cancel
          </OpsButton>
        </div>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </li>
  );
}

function SecretsSection({
  connector,
  authorEmail,
}: {
  readonly connector: ApiConnector;
  readonly authorEmail?: string;
}) {
  const { items, error, loading, refetch } = useOpsList<ApiConnectorSecret>(
    `/api/ops/connectors/${connector.id}/secrets`,
  );
  const custom = Boolean(connector.endpointUrl);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <DetailLabel icon={KeyRoundIcon}>Secrets</DetailLabel>
      {loading ? (
        <p className={cn("flex items-center gap-1.5 text-muted-foreground", TYPE.meta)}>
          <Spinner className="size-3" />
          Loading secrets…
        </p>
      ) : error ? (
        <ErrorBanner message={error} />
      ) : connector.health === "unimplemented" ? (
        <p className={cn("text-amber-500/90", TYPE.meta)}>
          No connector code exists for this kind — nothing in the agent reads it, so no credential
          would make it work.
        </p>
      ) : !items?.length ? (
        <p className={cn("text-muted-foreground/60 italic", TYPE.meta)}>
          {custom
            ? "No credentials declared. Add them to Required secrets above — the wizard's list is the only thing this tab accepts."
            : "This connector kind needs no credentials."}
        </p>
      ) : (
        <>
          <ul className={cn("divide-y divide-border/60 overflow-hidden", SURFACE.inset)}>
            {items.map((s) => (
              <SecretRow
                key={s.name}
                secret={s}
                connectorId={connector.id}
                authorEmail={authorEmail}
                onChanged={refetch}
              />
            ))}
          </ul>
          {/* Two different truths, and saying the built-in one about a custom
              connector would send an operator to run a deploy they don't need. */}
          <p className={cn("text-muted-foreground/60", TYPE.micro)}>
            Stored encrypted, never returned.{" "}
            {custom ? (
              <>
                The agent reads this connector&apos;s credentials at call time, so storing one here
                is all it takes — no deploy.
              </>
            ) : (
              <>
                A secret goes live only once it is in the agent&apos;s environment —{" "}
                <code className="font-mono">vercel env add</code> on fde-agent-api.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------ Connector wizard ------------------------- */

const CONNECTOR_KIND_LABELS = [
  "Slack",
  "GitHub",
  "Gmail",
  "Granola",
  "Exa",
  "PagerDuty",
  "System of record",
] as const;

const CONNECTOR_KIND_OPTIONS: RadioOption<string>[] = CONNECTOR_KIND_LABELS.map((label) => ({
  value: label,
  title: label,
  description: TOOL_META[label]?.synced?.length
    ? `Syncs ${TOOL_META[label].synced.join(" · ")}`
    : "Custom ingestion source.",
}));

function kindSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

const ACCESS_OPTIONS: RadioOption<Access>[] = [
  {
    value: "read",
    title: "Read",
    description: "The agent syncs data in from this source but never writes back.",
  },
  {
    value: "write",
    title: "Write",
    description: "The agent can push updates to this source but does not sync it in.",
  },
  {
    value: "read_write",
    title: "Read & write",
    description: "Two-way — the agent syncs data in and can write back.",
  },
];

const CONNECTOR_WIZARD_STEPS = [
  {
    heading: "What kind of connector do you want to add?",
    subtitle: "Select the source this connector reads from.",
  },
  {
    heading: "How should the agent access it?",
    subtitle: "Pick the permission level for this connector.",
  },
  {
    heading: "Connector details",
    subtitle: "Name it and describe where the sync lands in the data room.",
  },
  {
    heading: "Review & create",
    subtitle: "Double-check the connector before creating it.",
  },
];

function ConnectorWizard({
  authorEmail,
  onDone,
  onCancel,
}: {
  readonly authorEmail?: string;
  readonly onDone: (id: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [lands, setLands] = useState("");
  const [synced, setSynced] = useState<string[]>([]);
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  /**
   * WHOSE connector this is. Defaults to "me": a credential you add is yours
   * until you deliberately share it.
   */
  const [scope, setScope] = useState<"me" | "workspace">("me");
  /**
   * Whether this person may create a SHARED connector. The server decides —
   * this only governs whether the option is offered, so the control and the
   * 403 agree instead of the UI promising something the route refuses.
   */
  const [canShare, setCanShare] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void opsFetch<{ active: string | null; memberships: { orgId: string; role: string }[] }>(
      "/api/ops/me/workspaces",
    )
      .then((d) => {
        if (cancelled) return;
        const mine = d.memberships.find((m) => m.orgId === d.active) ?? d.memberships[0];
        setCanShare(mine?.role === "owner" || mine?.role === "admin");
      })
      .catch(() => {
        /* leave it false — offering an option the server will refuse is worse */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectKind = (label: string) => {
    if (!name.trim() || name === kind) setName(label);
    setKind(label);
  };

  const valid = step === 0 ? kind !== "" : step === 2 ? name.trim().length > 0 : true;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await opsFetch<{ item: ApiConnector }>("/api/ops/connectors", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind: kindSlug(kind),
          access,
          status: "setup",
          detail: detail.trim() || undefined,
          lands: lands.trim() || undefined,
          synced: synced.length ? synced : undefined,
          notifyEmails: notifyEmails.length ? notifyEmails : undefined,
          scope,
          createdBy: authorEmail,
        }),
      });
      await onDone(created.item.id);
    } catch (e) {
      setError(errMessage(e));
      setCreating(false);
    }
  };

  const meta = CONNECTOR_WIZARD_STEPS[step];
  return (
    <WizardFrame
      heading={meta.heading}
      subtitle={meta.subtitle}
      step={step}
      stepCount={CONNECTOR_WIZARD_STEPS.length}
      valid={valid}
      creating={creating}
      error={error}
      onBack={() => (step === 0 ? onCancel() : setStep(step - 1))}
      onNext={() => (step === CONNECTOR_WIZARD_STEPS.length - 1 ? void create() : setStep(step + 1))}
    >
      {step === 0 ? (
        <RadioCards
          label="Connector kind"
          value={kind}
          onChange={selectKind}
          options={CONNECTOR_KIND_OPTIONS}
        />
      ) : null}
      {step === 1 ? (
        <div className="flex flex-col gap-4">
          <RadioCards
            label="Access level"
            value={access}
            onChange={setAccess}
            options={ACCESS_OPTIONS}
          />
          <RadioCards
            label="Who can use it"
            value={scope}
            onChange={setScope}
            options={[
              {
                value: "me" as const,
                title: "Just me",
                description:
                  "Only you can see or use it. Its credentials are sealed with a key only your account derives.",
              },
              {
                value: "workspace" as const,
                title: "Everyone in this workspace",
                description:
                  "Shared by the whole team, and the only kind that scheduled workflows can use.",
                ...(canShare
                  ? {}
                  : {
                      disabledReason:
                        "Only a workspace owner or admin can add a shared connector — ask one of them, or add this one just for yourself.",
                    }),
              },
            ]}
          />
        </div>
      ) : null}
      {step === 2 ? (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <OpsInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Slack" />
          </Field>
          <Field label="Detail">
            <OpsInput
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Customer channels & alerts via Vercel Connect"
            />
          </Field>
          <Field label="Contexts" hint="Where the sync lands in the data room.">
            <OpsInput
              value={lands}
              onChange={(e) => setLands(e.target.value)}
              placeholder="Customers/·/Tickets/·/People/syncs/slack"
            />
          </Field>
          <Field label="Synced" hint="Which workflows this connector feeds.">
            <WorkflowMultiSelect values={synced} onChange={setSynced} />
          </Field>
          <NotifyEmailField recipients={notifyEmails} onRecipients={setNotifyEmails} />
        </div>
      ) : null}
      {step === 3 ? (
        <SummaryList
          fields={[
            { label: "Name", value: reviewText(name.trim()) },
            { label: "Kind", value: kindSlug(kind) || EMPTY_VALUE },
            { label: "Access", value: ACCESS_LABEL[access] },
            {
              label: "Who can use it",
              value: scope === "me" ? "Just me" : "Everyone in this workspace",
            },
            { label: "Detail", value: reviewText(detail.trim() || null) },
            { label: "Contexts", value: reviewText(lands.trim() || null) },
            { label: "Synced", value: synced.length ? synced.join(", ") : EMPTY_VALUE },
            { label: "Notify", value: reviewText(notifyEmails.join(", ") || null) },
          ]}
        />
      ) : null}
    </WizardFrame>
  );
}

/* -------------------------- Bring-your-own wizard ------------------------ */

/** Mirrors SECRET_NAME_RE on the server; a mismatch here is a 400 there. */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

interface SecretDraft {
  name: string;
  purpose: string;
  optional: boolean;
}

const CUSTOM_WIZARD_STEPS = [
  {
    heading: "Where does your connector live?",
    subtitle: "Name it and point us at its MCP server.",
  },
  {
    heading: "How should the agent access it?",
    subtitle: "Pick the permission level for this connector.",
  },
  {
    heading: "What credentials does it need?",
    subtitle: "Declare them here; you enter the values after it is created.",
  },
  {
    heading: "Review & create",
    subtitle: "Double-check the connector before creating it.",
  },
];

/**
 * The rows that declare a custom connector's credential contract.
 *
 * This list is not cosmetic: the secrets route accepts these names and no
 * others. Without it a bring-your-own connector can be created and then never
 * given a credential, which was exactly the old failure — so the wizard refuses
 * to finish with an empty contract unless the server genuinely needs no auth.
 */
function SecretDrafts({
  rows,
  onChange,
  authName,
  onAuthName,
}: {
  readonly rows: SecretDraft[];
  readonly onChange: (rows: SecretDraft[]) => void;
  readonly authName: string;
  readonly onAuthName: (name: string) => void;
}) {
  const set = (i: number, patch: Partial<SecretDraft>) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => {
    const next = rows.filter((_, n) => n !== i);
    onChange(next);
    if (rows[i].name === authName) onAuthName(next[0]?.name ?? "");
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const bad = row.name.length > 0 && !SECRET_NAME_RE.test(row.name);
        return (
          <div key={i} className={cn("flex flex-col gap-2 px-3 py-2.5", SURFACE.card)}>
            <div className="flex items-center gap-2">
              <OpsInput
                value={row.name}
                onChange={(e) => {
                  const name = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
                  if (row.name === authName) onAuthName(name);
                  set(i, { name });
                }}
                placeholder="LINEAR_API_KEY"
                className="font-mono"
                aria-label="Secret name"
              />
              <OpsButton
                intent="ghost"
                size="xs"
                onClick={() => remove(i)}
                aria-label={`Remove ${row.name || "secret"}`}
              >
                Remove
              </OpsButton>
            </div>
            {bad ? (
              <p className={cn("text-destructive", TYPE.meta)}>
                Use UPPER_SNAKE_CASE — letters, digits and underscores.
              </p>
            ) : null}
            <OpsInput
              value={row.purpose}
              onChange={(e) => set(i, { purpose: e.target.value })}
              placeholder="What breaks without it, in one line."
              aria-label="Purpose"
            />
            <div className="flex items-center gap-4">
              <label className={cn("flex items-center gap-1.5 text-muted-foreground", TYPE.meta)}>
                <input
                  type="checkbox"
                  checked={row.optional}
                  onChange={(e) => set(i, { optional: e.target.checked })}
                />
                Optional
              </label>
              <label className={cn("flex items-center gap-1.5 text-muted-foreground", TYPE.meta)}>
                <input
                  type="radio"
                  name="auth-secret"
                  checked={authName === row.name && row.name.length > 0}
                  onChange={() => onAuthName(row.name)}
                />
                Sent as the Bearer token
              </label>
            </div>
          </div>
        );
      })}
      <OpsButton
        intent="secondary"
        size="xs"
        className="self-start"
        onClick={() => onChange([...rows, { name: "", purpose: "", optional: false }])}
      >
        Add a credential
      </OpsButton>
    </div>
  );
}

/**
 * Edit a custom connector's credential contract after it exists.
 *
 * Necessary rather than nice: the contract is what the secrets route validates
 * against, so a connector whose server later needs a second header would
 * otherwise be stuck — the wizard runs once. Removing a name here does NOT
 * delete a stored value; it stops the connector declaring it, and the secrets
 * list stops showing it.
 */
function RequiredSecretsEditor({
  connector,
  patch,
}: {
  readonly connector: ApiConnector;
  readonly patch: (body: Record<string, unknown>) => Promise<void>;
}) {
  const stored: SecretDraft[] = (connector.requiredSecrets ?? []).map((s) => ({
    name: s.name,
    purpose: s.purpose,
    optional: Boolean(s.optional),
  }));
  const [rows, setRows] = useState<SecretDraft[]>(stored);
  const [authName, setAuthName] = useState(connector.authSecretName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = rows.filter((r) => r.name.trim() && r.purpose.trim());
  const ok =
    filled.every((r) => SECRET_NAME_RE.test(r.name)) &&
    new Set(filled.map((r) => r.name)).size === filled.length;
  const dirty =
    JSON.stringify(filled) !== JSON.stringify(stored) ||
    authName !== (connector.authSecretName ?? "");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await patch({
        requiredSecrets: filled.length
          ? filled.map((r) => ({ name: r.name, purpose: r.purpose, optional: r.optional || undefined }))
          : null,
        authSecretName: filled.some((r) => r.name === authName) ? authName : null,
      });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SecretDrafts rows={rows} onChange={setRows} authName={authName} onAuthName={setAuthName} />
      {error ? <ErrorBanner message={error} /> : null}
      {dirty ? (
        <OpsButton
          intent="primary"
          size="xs"
          className="self-start"
          disabled={!ok || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save contract"}
        </OpsButton>
      ) : null}
    </div>
  );
}

function CustomConnectorWizard({
  authorEmail,
  onDone,
  onCancel,
}: {
  readonly authorEmail?: string;
  readonly onDone: (id: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [detail, setDetail] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [lands, setLands] = useState("");
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<SecretDraft[]>([
    { name: "", purpose: "", optional: false },
  ]);
  const [authName, setAuthName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = secrets.filter((s) => s.name.trim() && s.purpose.trim());
  // Mirror the server's guard so the mistake is caught while it is still
  // editable, rather than as a 400 on the last step.
  const endpointOk = /^https:\/\/[^\s]+$/i.test(endpointUrl.trim());
  const secretsOk =
    filled.every((s) => SECRET_NAME_RE.test(s.name)) &&
    new Set(filled.map((s) => s.name)).size === filled.length;

  const valid =
    step === 0
      ? name.trim().length > 0 && endpointOk
      : step === 2
        ? secretsOk
        : true;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await opsFetch<{ item: ApiConnector }>("/api/ops/connectors", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          // Everything not in the built-in manifest takes the dynamic path; the
          // agent recognises it by having an endpoint, not by the slug.
          kind: "mcp",
          access,
          status: "setup",
          // A bring-your-own MCP server is somebody's own endpoint and
          // credential, so it belongs to them unless they say otherwise. This
          // wizard has no scope control yet; being explicit keeps the choice
          // visible here rather than resting on a server-side default.
          scope: "me",
          detail: detail.trim() || undefined,
          lands: lands.trim() || undefined,
          notifyEmails: notifyEmails.length ? notifyEmails : undefined,
          endpointUrl: endpointUrl.trim(),
          requiredSecrets: filled.length
            ? filled.map((s) => ({
                name: s.name.trim(),
                purpose: s.purpose.trim(),
                optional: s.optional || undefined,
              }))
            : undefined,
          authSecretName: filled.some((s) => s.name === authName) ? authName : undefined,
          createdBy: authorEmail,
        }),
      });
      await onDone(created.item.id);
    } catch (e) {
      setError(errMessage(e));
      setCreating(false);
    }
  };

  const meta = CUSTOM_WIZARD_STEPS[step];
  return (
    <WizardFrame
      heading={meta.heading}
      subtitle={meta.subtitle}
      step={step}
      stepCount={CUSTOM_WIZARD_STEPS.length}
      valid={valid}
      creating={creating}
      error={error}
      onBack={() => (step === 0 ? onCancel() : setStep(step - 1))}
      onNext={() => (step === CUSTOM_WIZARD_STEPS.length - 1 ? void create() : setStep(step + 1))}
    >
      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <OpsInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Linear" />
          </Field>
          <Field
            label="MCP endpoint"
            hint="Must be public https — private and loopback addresses are refused."
          >
            <OpsInput
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://mcp.linear.app/mcp"
              className="font-mono"
            />
          </Field>
          {endpointUrl.trim() && !endpointOk ? (
            <p className={cn("text-destructive", TYPE.meta)}>
              The endpoint must start with https:// — a credential is sent to it.
            </p>
          ) : null}
          <Field label="Detail">
            <OpsInput
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Issues and projects from our Linear workspace"
            />
          </Field>
          <Field label="Contexts" hint="Where its data lands in the data room.">
            <OpsInput
              value={lands}
              onChange={(e) => setLands(e.target.value)}
              placeholder="Customers/·/Tickets/"
            />
          </Field>
          <NotifyEmailField recipients={notifyEmails} onRecipients={setNotifyEmails} />
        </div>
      ) : null}
      {step === 1 ? (
        <RadioCards
          label="Access level"
          value={access}
          onChange={setAccess}
          options={ACCESS_OPTIONS}
        />
      ) : null}
      {step === 2 ? (
        <div className="flex flex-col gap-3">
          <SecretDrafts
            rows={secrets}
            onChange={setSecrets}
            authName={authName}
            onAuthName={setAuthName}
          />
          <p className={cn("text-muted-foreground", TYPE.meta)}>
            These names are the whole contract — the secrets tab accepts them and nothing else.
            You enter the values in the connector&apos;s detail panel once it exists; they are
            encrypted and never shown again. Leave this empty only if the server needs no auth.
          </p>
        </div>
      ) : null}
      {step === 3 ? (
        <SummaryList
          fields={[
            { label: "Name", value: reviewText(name.trim()) },
            { label: "Kind", value: "mcp (your own server)" },
            { label: "Endpoint", value: reviewText(endpointUrl.trim()) },
            { label: "Access", value: ACCESS_LABEL[access] },
            { label: "Detail", value: reviewText(detail.trim() || null) },
            { label: "Contexts", value: reviewText(lands.trim() || null) },
            {
              label: "Credentials",
              value: filled.length
                ? filled.map((s) => s.name + (s.optional ? " (optional)" : "")).join(", ")
                : "none — the server needs no auth",
            },
            { label: "Bearer token", value: reviewText(authName || null) },
            { label: "Notify", value: reviewText(notifyEmails.join(", ") || null) },
          ]}
        />
      ) : null}
    </WizardFrame>
  );
}

/* ------------------------------ Connectors panel ------------------------- */

export function ConnectorsPanel({
  authorEmail,
  initialSelectedId,
  onInitialConsumed,
}: {
  readonly authorEmail?: string;
  readonly initialSelectedId?: string;
  readonly onInitialConsumed?: () => void;
}) {
  const { items, error, refetch, loading } = useOpsList<ApiConnector>("/api/ops/connectors");
  // The tooltip on "N workflows" names them and says what they do, so the table
  // needs the workflows themselves — not just the strings stored on the row.
  const { items: workflows } = useOpsList<ApiWorkflow>("/api/ops/workflows");
  const workflowList = workflows ?? [];
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<PanelState>({ mode: "closed" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiConnector | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const all = items ?? [];
  const q = search.trim().toLowerCase();
  const filtered = all.filter(
    (c) =>
      !q ||
      matches(q, c.name, c.kind, c.detail, c.status, c.createdBy, c.lands, c.synced?.join(" ")),
  );
  const pager = usePager(filtered);
  const { setPage } = pager;

  // Deep-link (`/?ops=connectors&id=<id>`): once the list loads, jump the
  // pager to the row's page, select it, and open its detail panel. Applied
  // exactly once per mount.
  const initialApplied = useRef(false);
  useEffect(() => {
    if (initialApplied.current || !initialSelectedId || items === null) return;
    initialApplied.current = true;
    onInitialConsumed?.();
    const idx = items.findIndex((c) => c.id === initialSelectedId);
    if (idx === -1) return;
    setPage(Math.floor(idx / pager.pageSize) + 1);
    setSelectedId(initialSelectedId);
    setPanel({ mode: "view", id: initialSelectedId });
  }, [items, initialSelectedId, onInitialConsumed, setPage]);

  const openId = panelId(panel);
  const openItem = openId ? (all.find((c) => c.id === openId) ?? null) : null;

  const closePanel = useCallback(() => {
    setPanel({ mode: "closed" });
    setSelectedId(null);
  }, []);

  const mutate = async (id: string, fn: () => Promise<unknown>) => {
    setPendingId(id);
    setActionError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setPendingId(null);
    }
  };

  // Inline-edit commit: PATCH the single changed field, then refetch. Errors
  // propagate so the InlineField keeps its editor open with the message.
  const patchField = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await opsFetch(`/api/ops/connectors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, actor: authorEmail }),
      });
      await refetch();
    },
    [authorEmail, refetch],
  );

  const runDelete = () => {
    const item = confirmDelete;
    setConfirmDelete(null);
    if (item) {
      void mutate(item.id, async () => {
        await opsFetch(`/api/ops/connectors/${item.id}`, {
          method: "DELETE",
          body: JSON.stringify({ actor: authorEmail }),
        });
        setPanel((p) => (panelId(p) === item.id ? { mode: "closed" } : p));
        setSelectedId((s) => (s === item.id ? null : s));
      });
    }
  };

  const emptyText =
    all.length === 0 ? "No connectors yet — add one." : `No connectors match "${search.trim()}".`;

  // Land on the new connector's detail panel, where its secrets are entered —
  // for a custom one that is the step that actually makes it work.
  const afterCreate = async (id: string) => {
    await refetch();
    setSelectedId(id);
    setPanel({ mode: "view", id });
  };

  let panelBody: React.ReactNode = null;
  if (panel.mode === "wizard") {
    panelBody = (
      <ConnectorWizard authorEmail={authorEmail} onCancel={closePanel} onDone={afterCreate} />
    );
  } else if (panel.mode === "wizard-custom") {
    panelBody = (
      <CustomConnectorWizard authorEmail={authorEmail} onCancel={closePanel} onDone={afterCreate} />
    );
  } else if (panel.mode === "view" && openItem) {
    panelBody = (
      <DetailPanel
        title={`Connector — ${openItem.name}`}
        sections={connectorDetailSections(openItem, (body) => patchField(openItem.id, body))}
        log={{ type: "connector", id: openItem.id }}
      >
        <SecretsSection key={openItem.id} connector={openItem} authorEmail={authorEmail} />
      </DetailPanel>
    );
  }

  // With the panel open the table only gets 30% of the modal, which is not
  // enough for six columns — it clipped the name and pushed the row menu out of
  // reach. Collapse to Name + Actions and restore the rest when it closes.
  const compact = panelBody !== null;
  const cols = compact ? 2 : 6;

  return (
    <>
      <ConfirmDeleteDialog
        name={confirmDelete?.name ?? null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={runDelete}
      />
      <PanelLayout
        panel={panelBody ? <SidePanel onClose={closePanel}>{panelBody}</SidePanel> : null}
        header={
          <>
            <SectionHeaderCard
              section="connectors"
              noun="Connector"
              verb="Configure"
              // A plug for the connectors we ship — the section's own glyph.
              icon={PlugZapIcon}
              onAdd={() => {
                setSelectedId(null);
                setPanel({ mode: "wizard" });
              }}
              secondary={{
                // A server, because that is literally what you are pointing at:
                // your own MCP endpoint rather than one from our catalogue.
                icon: ServerIcon,
                label: "Configure custom connector",
                onClick: () => {
                  setSelectedId(null);
                  setPanel({ mode: "wizard-custom" });
                },
              }}
            />
            <SearchBox
              noun="connector"
              value={search}
              onChange={(v) => {
                setSearch(v);
                pager.setPage(1);
              }}
            />
            <Banners loadError={error} actionError={actionError} noun="connector" />
          </>
        }
        table={
            <TableCard
              footer={
                <ListFooter
                  noun="connector"
                  total={pager.total}
                  page={pager.page}
                  pages={pager.pages}
                  onPage={pager.setPage}
                  pageSize={pager.pageSize}
                  onPageSize={pager.setPageSize}
                />
              }
            >
              <thead>
                <tr>
                  <Th icon={TagIcon} label="Name" />
                  {compact ? null : (
                    <>
                      <Th icon={BoxIcon} label="Access" />
                      <Th icon={RefreshCwIcon} label="Synced" />
                      <Th icon={FolderTreeIcon} label="Contexts" />
                      <Th icon={UserIcon} label="Connected by" />
                    </>
                  )}
                  <Th label="Actions" align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <StateRow span={cols}>Loading…</StateRow>
                ) : pager.total === 0 ? (
                  <StateRow span={cols} italic>
                    {emptyText}
                  </StateRow>
                ) : (
                  pager.rows.map((c) => {
                    // The DOT tells the truth about credentials, not the seeded
                    // `status` string (which said "connected" next to a missing
                    // token). See healthFor() in app/api/ops/connectors/route.ts.
                    const health = HEALTH_META[c.health] ?? HEALTH_META.unknown;
                    const isSel = selectedId === c.id;
                    return (
                      <ListRow
                        key={c.id}
                        selected={isSel}
                        dimmed={!c.enabled}
                        onSelect={() => setSelectedId(c.id)}
                      >
                        <NameCell selected={isSel}>
                          <span className="flex min-w-0 items-center gap-2.5">
                            <ToolLogo name={c.name} />
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5">
                                <DeepLink
                                  section="connectors"
                                  id={c.id}
                                  className={cn(
                                    "truncate font-medium hover:underline",
                                    isSel && "text-primary",
                                  )}
                                >
                                  {c.name}
                                </DeepLink>
                                <span
                                  aria-label={health.label}
                                  title={health.label}
                                  className={cn("size-1.5 shrink-0 rounded-full", health.dot)}
                                />
                                {/* Only YOUR personal connectors reach this
                                    list, so the badge answers "is this mine or
                                    the team's" — which decides whether editing
                                    it affects anybody else. */}
                                {c.ownerEmail ? (
                                  <span
                                    title={`Personal to ${c.ownerEmail} — not shared with the workspace`}
                                    className={cn(
                                      "shrink-0 rounded-full border border-border px-1.5 py-px text-muted-foreground",
                                      TYPE.micro,
                                    )}
                                  >
                                    Personal
                                  </span>
                                ) : null}
                              </span>
                              {c.detail ? (
                                <span
                                  className={cn(
                                    "block max-w-56 truncate text-muted-foreground",
                                    TYPE.meta,
                                  )}
                                >
                                  {c.detail}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </NameCell>
                        {compact ? null : (
                          <>
                            <Td>
                              <Chip>{ACCESS_LABEL[c.access] ?? c.access}</Chip>
                            </Td>
                            <Td>
                              {c.synced?.length ? (
                                <SyncedTooltip synced={c.synced} workflows={workflowList}>
                                  <span
                                    className={cn(
                                      "cursor-default whitespace-nowrap text-muted-foreground underline decoration-dotted underline-offset-2",
                                      TYPE.meta,
                                    )}
                                  >
                                    {c.synced.length} workflow
                                    {c.synced.length === 1 ? "" : "s"}
                                  </span>
                                </SyncedTooltip>
                              ) : (
                                <EmptyCell />
                              )}
                            </Td>
                            <Td>
                              <ContextCell value={c.lands} />
                            </Td>
                            <Td>
                              <span
                                className={cn(
                                  "block max-w-40 truncate text-muted-foreground",
                                  TYPE.meta,
                                )}
                              >
                                {c.createdBy}
                              </span>
                              <span
                                className={cn(
                                  "block max-w-40 truncate text-muted-foreground/50",
                                  TYPE.micro,
                                )}
                              >
                                {fmtTime(c.createdAt) ?? "—"}
                              </span>
                            </Td>
                          </>
                        )}
                        <MenuCell>
                          <RowMenu
                            enabled={c.enabled}
                            pending={pendingId === c.id}
                            onReview={() => {
                              setSelectedId(c.id);
                              setPanel({ mode: "view", id: c.id });
                            }}
                            onToggleEnabled={() =>
                              void mutate(c.id, () =>
                                opsFetch(`/api/ops/connectors/${c.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    enabled: !c.enabled,
                                    actor: authorEmail,
                                  }),
                                }),
                              )
                            }
                            onDelete={() => setConfirmDelete(c)}
                          />
                        </MenuCell>
                      </ListRow>
                    );
                  })
                )}
              </tbody>
            </TableCard>
        }
      />
    </>
  );
}
