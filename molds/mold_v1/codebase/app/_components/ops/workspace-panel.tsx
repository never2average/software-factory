"use client";

/**
 * Workspace (control plane) — the §7 admin surface. People is the single place
 * for the roster, workspace roles, and the full invite lifecycle; keeping those
 * together avoids two competing member directories.
 *
 * Every panel is a thin client of /api/ops/orgs/{id}/* — no business logic here.
 * Admin-only actions surface only when the caller's role allows them (the API
 * enforces regardless). The workspace scope selector lives in the one header
 * card and everything below inherits it (§7 layout convention).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { OrgMark, toLogoDataUrl } from "../org-mark";
import {
  ActivityIcon,
  BotIcon,
  BuildingIcon,
  ChevronDownIcon,
  ClockIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  GitCommitIcon,
  HistoryIcon,
  LinkIcon,
  MailIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  TagIcon,
  Trash2Icon,
  UploadIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
  CheckIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { activeOrg, authToken, errMessage, fmtTime, opsFetch } from "./lib";
import { ConnectorsPanel } from "./connectors-panel";
import { HeaderCard, PaginatedTable, type Column } from "./paginated-table";
import { OpsButton } from "./primitives";
import { SPACE, SURFACE, TYPE } from "./tokens";
import { ChangesetDiffView } from "./diff-view";
import { CustomerMark } from "../customer-mark";
import { CodeEditor } from "./code-editor";
import { PromptHistoryButton } from "./prompt-history";
import { afterMenuClose } from "./after-menu-close";
import { RosterImportDialog } from "./roster-import";
import { WorkflowBuilder } from "./workflow-builder";

import { SUBAGENT_META } from "../subagent-meta.generated";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
type Role = "owner" | "admin" | "engineer" | "member";
type WorkspaceTab =
  | "dataroom"
  | "people"
  | "agents"
  | "connectors"
  | "workflows"
  | "audit"
  | "readiness"
  | "settings"
  | "usage";

type AgentMode = "build" | "plan" | "goal" | "loop";
interface AgentProfileFields {
  personaName: string | null;
  tone: string | null;
  instructions: string | null;
  defaultMode: AgentMode | null;
  webSearchDefault: boolean | null;
  browserDefault: boolean | null;
  model: string | null;
}

interface OrgRow {
  orgId: string;
  name: string;
  googleHostedDomain: string | null;
  status: string;
  limits: { monthlyTokenCap?: number; monthlyCostUsdCap?: number; workflowRunCap?: number } | null;
}
interface MemberRow {
  orgId: string;
  email: string;
  role: Role;
  acceptedAt: string | null;
}
interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  status: "pending" | "expired" | "accepted";
}
interface OrgSummary {
  orgId: string;
  name: string;
  role: Role;
  status: string;
  branding?: { logoUrl?: string; displayName?: string } | null;
}

function SetupProgressRing({ done, total }: { done: number; total: number }) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? Math.min(Math.max(done / total, 0), 1) : 0;
  const progressColor = `hsl(${Math.round(progress * 120)} 72% 50%)`;

  return (
    <span className="block size-6" style={{ color: progressColor }} aria-hidden="true">
      <svg className="size-6 -rotate-90" viewBox="0 0 24 24">
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          className="opacity-25"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
    </span>
  );
}


/**
 * Compact unfinished-setup action for the workspace header.
 *
 * The onboarding checks screen told people "the setup surface collapses to a
 * banner from here" — and no return path was ever built. Onboarding also redirects
 * away once a workspace exists, so the moment someone chose "finish these
 * later" the checks became permanently unreachable and nothing in the product
 * mentioned them again. This is the way back, and the workspace page is where
 * it belongs: this is the page about the workspace's own state.
 *
 * Silent once the workspace is ready, and silent if the check can't be read —
 * an unreachable health endpoint is not evidence of unfinished setup.
 */
function SetupAction({ orgId }: { orgId: string | null }) {
  const [state, setState] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    if (!orgId) return;
    void (async () => {
      try {
        const h = await opsFetch<{ ready: boolean; checks: { ok: boolean }[] }>(
          `/api/ops/orgs/${orgId}/health`,
        );
        if (cancelled) return;
        if (h.ready) {
          setState(null);
          return;
        }
        setState({ done: h.checks.filter((c) => c.ok).length, total: h.checks.length });
      } catch {
        /* can't tell — say nothing rather than nag */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (!state || !orgId) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href={`/onboard?step=checks&org=${encodeURIComponent(orgId)}`}
        aria-label={`Finish setup, ${state.done} of ${state.total} checks complete`}
        title={`${state.done} of ${state.total} checks complete`}
      >
        <span>Finish setup</span>
        <SetupProgressRing done={state.done} total={state.total} />
      </a>
    </Button>
  );
}


/**
 * "Invite agents" — always here, for every workspace, finished setup or not.
 *
 * Bringing a coding agent into the workspace (the MCP connection and the setup recipes) is how the agent gets
 * better over time, not a first-run step. It lived only inside the onboarding flow, behind a "Finish setup"
 * button that disappears once setup is complete.
 */
function InviteAgentsAction({ orgId }: { orgId: string | null }) {
  if (!orgId) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={`/onboard?step=invite&org=${encodeURIComponent(orgId)}`} title="Connect a coding agent to this workspace to improve the agent">
        Invite agents
      </a>
    </Button>
  );
}

const TABS: { key: WorkspaceTab; label: string }[] = [
  { key: "dataroom", label: "Data room" },
  { key: "people", label: "People" },
  { key: "agents", label: "Agents" },
  { key: "connectors", label: "Connectors" },
  { key: "workflows", label: "Project workflows" },
  { key: "audit", label: "Audit trail" },
];

/* ----------------------- Shared table cells / actions --------------------- */

/** The "Connected by" cell every workspace table shares: actor over timestamp. */
function ConnectedByCell({ actor, when }: { actor: string | null; when: string | null }) {
  return (
    <div className="leading-tight">
      <div className="text-xs">{actor ?? "—"}</div>
      {when ? <div className="text-2xs text-muted-foreground">{fmtTime(when)}</div> : null}
    </div>
  );
}

/** A role, shown as a quiet chip — owner carries weight, the rest are neutral. */
function RolePill({ role }: { role: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs capitalize",
        role === "owner"
          ? "border-primary/30 bg-primary/10 text-foreground"
          : "border-border/60 text-muted-foreground",
      )}
    >
      {role}
    </span>
  );
}

export interface RowAction {
  label: string;
  onClick?: () => void;
  destructive?: boolean;
  /** Renders as a submenu instead of a leaf item. */
  items?: { label: string; onClick: () => void; checked?: boolean }[];
}
/** The "Actions" ··· menu every workspace table shares. */
function RowActions({ items }: { items: RowAction[] }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Actions"
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((it) =>
          it.items ? (
            <DropdownMenuSub key={it.label}>
              <DropdownMenuSubTrigger>{it.label}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {it.items.map((sub) => (
                  <DropdownMenuItem key={sub.label} onSelect={() => sub.onClick()} className="capitalize">
                    <CheckIcon className={cn("size-3.5", sub.checked ? "opacity-100" : "opacity-0")} />
                    {sub.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem
              key={it.label}
              onSelect={() => it.onClick?.()}
              className={it.destructive ? "text-destructive focus:text-destructive" : ""}
            >
              {it.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The standard Connected-by + Actions column pair, appended to every table.
 *  `onReview`, when given, prepends a "Review" action that opens the detail. */
function metaColumns<T>(
  connectedBy: (r: T) => { actor: string | null; when: string | null },
  actions: (r: T) => RowAction[],
  onReview?: (r: T) => void,
): Column<T>[] {
  return [
    {
      key: "connectedBy",
      header: "Connected by",
      icon: UserIcon,
      text: (r) => connectedBy(r).actor ?? "",
      cell: (r) => {
        const c = connectedBy(r);
        return <ConnectedByCell actor={c.actor} when={c.when} />;
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (r) => (
        <RowActions items={[...(onReview ? [{ label: "Review", onClick: () => onReview(r) }] : []), ...actions(r)]} />
      ),
    },
  ];
}

/** A labeled field section inside a detail side panel — a bordered card,
 *  matching the Apps / Ops-Center detail design. */
function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-muted/[0.06] px-3.5 py-3">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}
/** The scrollable body wrapper of a detail side panel (title + fields). */
function PanelBody({ title, subtitle, avatar, children }: { title: string; subtitle?: string; avatar?: React.ReactNode; children: React.ReactNode }) {
  return (
    // Top padding matches the table card's header inset so the detail title lines
    // up with the list's top; the close button sits top-right and never overlaps.
    <div className="min-h-0 flex-1 overflow-auto p-5 pt-4">
      <div className="mb-4 flex items-center gap-3 pr-6">
        {avatar}
        <div className="min-w-0">
          <div className="truncate font-semibold text-sm">{title}</div>
          {subtitle ? <div className="truncate text-2xs text-muted-foreground">{subtitle}</div> : null}
        </div>
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

/** Download `rows` as a CSV file (client-side; no server round-trip). */
function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const isAdmin = (r: Role) => r === "owner" || r === "admin";

export function WorkspacePanel({ authorEmail }: { authorEmail?: string }) {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("dataroom");
  /**
   * `?tab=<key>` (and `?import=roster`) so a setup check can land on the exact
   * task. Read once on mount, in an effect, so SSR/hydration never sees it.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t && TABS.some((x) => x.key === t)) setTab(t as WorkspaceTab);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);

  useEffect(() => {
    // The ACTIVE workspace — the one the sidebar switcher shows and every other screen is already scoped to.
    // ONE rule, the server's: the choice stored in this browser if it is still a workspace you belong to, else
    // `active` from /api/ops/me/workspaces (the most recently chosen membership, falling back to the oldest).
    // Never list order: /api/ops/orgs and the memberships list are ordered differently, so "the first one"
    // here was a different workspace from the first one in the sidebar — settings opened workspace B for
    // someone working in A whenever nothing was stored in the browser yet.
    Promise.all([
      opsFetch<{ items: OrgSummary[] }>("/api/ops/orgs"),
      opsFetch<{ active: string | null }>("/api/ops/me/workspaces").catch(() => ({ active: null })),
    ])
      .then(([d, me]) => {
        setOrgs(d.items);
        const has = (id: string | null | undefined) => (id ? d.items.find((o) => o.orgId === id)?.orgId : undefined);
        setOrgId((prev) => prev ?? has(activeOrg()) ?? has(me.active) ?? d.items[0]?.orgId ?? null);
      })
      .catch((e) => setError(errMessage(e)));
  }, []);

  // Member count for the header subtitle.
  useEffect(() => {
    if (!orgId) return;
    setMemberCount(null);
    opsFetch<{ items: unknown[] }>(`/api/ops/orgs/${orgId}/members`)
      .then((d) => setMemberCount(d.items.length))
      .catch(() => setMemberCount(null));
  }, [orgId]);

  const current = orgs?.find((o) => o.orgId === orgId) ?? null;
  const role = current?.role ?? "member";
  const canEditOrg = isAdmin(role);
  const logoRef = useRef<HTMLInputElement>(null);
  const [logoOverride, setLogoOverride] = useState<string | null>(null);
  const logoUrl = logoOverride ?? current?.branding?.logoUrl ?? null;

  // Pick → downscale → PATCH the org's branding. Optimistic so the mark updates
  // immediately; a failure surfaces in the panel's error banner.
  async function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !orgId) return;
    try {
      const dataUrl = await toLogoDataUrl(file);
      setLogoOverride(dataUrl);
      await opsFetch(`/api/ops/orgs/${orgId}`, {
        method: "PATCH",
        body: JSON.stringify({ branding: { ...(current?.branding ?? {}), logoUrl: dataUrl } }),
      });
    } catch (err) {
      setLogoOverride(null);
      setError(errMessage(err));
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: the ONE workspace scope selector everything inherits. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={onPickLogo} />
        <button
          type="button"
          onClick={() => canEditOrg && logoRef.current?.click()}
          disabled={!canEditOrg}
          title={canEditOrg ? "Change workspace logo" : undefined}
          // The mark inside is aria-hidden (initials are decoration, not a name), so
          // without this the button has no accessible name at all.
          aria-label={canEditOrg ? "Change workspace logo" : "Workspace logo"}
          className={cn("group relative flex shrink-0", canEditOrg && "cursor-pointer")}
        >
          <OrgMark name={current?.name ?? orgId ?? "Workspace"} logoUrl={logoUrl} size="md" />
          {canEditOrg ? (
            <span className="absolute inset-0 hidden items-center justify-center rounded-md bg-background/70 group-hover:flex">
              <UploadIcon className="size-3.5" />
            </span>
          ) : null}
        </button>
        <div className="min-w-0 flex-1">
          {/* Not a dropdown: settings are the ACTIVE workspace's. Switching happens in one place, the sidebar
              switcher, which reloads every screen into the new workspace together. */}
          <div className="truncate text-sm font-semibold">{current?.name ?? "Workspace"}</div>
          <div className="truncate text-xs text-muted-foreground">
            {orgId ? (
              <>
                <span className="font-mono">{orgId}</span>
                {memberCount != null ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : ""}
                {orgs && orgs.length > 1 ? " · switch workspace from the sidebar" : ""}
              </>
            ) : (
              "loading…"
            )}
          </div>
        </div>
        <SetupAction orgId={orgId} />
        <InviteAgentsAction orgId={orgId} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border px-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? "shrink-0 whitespace-nowrap border-b-2 border-foreground px-3 py-2 text-sm font-medium"
                : "shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {!orgId ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : error ? (
        <div className="p-6">
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
        </div>
      ) : tab === "connectors" ? (
        // Embed manages its own layout; needs a flex-column parent with height
        // so its PanelLayout `flex-1` fills the page.
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ConnectorsPanel authorEmail={authorEmail} />
        </div>
      ) : tab === "workflows" ? (
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <WorkflowBuilder />
        </div>
      ) : tab === "dataroom" ? (
        <div className="flex min-h-0 flex-1 flex-col p-4"><DataroomTab role={role} /></div>
      ) : tab === "people" ? (
        <div className="flex min-h-0 flex-1 flex-col p-4"><PeopleTab orgId={orgId} role={role} authorEmail={authorEmail} /></div>
      ) : tab === "agents" ? (
        <div className="flex min-h-0 flex-1 flex-col p-4"><AgentsTab role={role} /></div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-4"><AuditTab orgId={orgId} /></div>
      )}
    </div>
  );
}

/* -------------------------------- Agents --------------------------------- */

// People tab wording from the deployment profile. The default profile reproduces today's sentence exactly.
const VOCAB = DEPLOYMENT_PROFILE.vocabulary;
const ACCOUNTS_LABEL =
  VOCAB.account.plural === "customers" ? "Accounts" : VOCAB.account.plural.charAt(0).toUpperCase() + VOCAB.account.plural.slice(1);
const NOT_AN_OWNER =
  VOCAB.account.singular === "customer"
    ? `Not the ${VOCAB.owner} on any account.`
    : `Not the ${VOCAB.owner.toLowerCase()} of any ${VOCAB.account.singular}.`;

/** The specialist subagents the orchestrator delegates to: curated copy for the built-in ones, then every other
 *  declared subagent (discovered from agent/subagents/ by scripts/gen-subagent-meta.mjs) with what it declares. */
const CURATED_SUBAGENTS: { key: string; name: string; description: string }[] = [
  { key: "research", name: "Research", description: "Investigates questions across the data room and the web, then returns synthesized findings." },
  { key: "customer-context", name: "Customer context", description: "Assembles the full history and current state for a customer before work begins." },
  { key: "configuration", name: "Configuration", description: "Sets up platform, solution, and agent configuration for a customer." },
  { key: "deployment", name: "Deployment", description: "Runs rollouts, environments, and go-live steps." },
  { key: "data-migration", name: "Data migration", description: "Moves and reshapes data into the system of record." },
  { key: "evals", name: "Evals", description: "Builds and runs evaluation suites against the solution." },
  { key: "workflow-author", name: "Workflow author", description: "Authors the durable workflow scripts the orchestrator runs on a cadence." },
  { key: "app-author", name: "App author", description: "Generates the living dashboard apps the agent refreshes on a schedule." },
  { key: "follow-ups", name: "Follow-ups", description: "Tracks and drafts the follow-ups coming out of meetings and threads." },
  { key: "browser", name: "Browser", description: "Drives a real browser to navigate, read, and capture pages." },
];
const SUBAGENTS: { key: string; name: string; description: string }[] = [
  ...CURATED_SUBAGENTS.filter((row) => row.key in SUBAGENT_META),
  ...Object.entries(SUBAGENT_META)
    .filter(([key]) => !CURATED_SUBAGENTS.some((row) => row.key === key))
    .map(([key, meta]) => ({ key, name: meta.name, description: meta.summary })),
];

interface AgentConfig {
  paused: boolean;
  instructions: string | null;
}
type SubagentRow = (typeof SUBAGENTS)[number];

function AgentDetailPanel({
  agent,
  config,
  canEdit,
  onPut,
}: {
  agent: SubagentRow;
  config: AgentConfig | undefined;
  canEdit: boolean;
  onPut: (fields: { paused?: boolean; instructions?: string | null }) => Promise<void>;
}) {
  const [draft, setDraft] = useState(config?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const paused = Boolean(config?.paused);
  return (
    <PanelBody
      title={agent.name}
      subtitle={agent.description}
      avatar={
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
          <BotIcon className="size-5" />
        </span>
      }
    >
      {/* Status and Delegation were two cards for two constants: every agent is
          orchestrator-dispatched, and "Active" is the state of all of them until
          one is paused. Pausing moved into the ··· menu, and the paused state
          announces itself below only when it is actually true. */}
      {/* No card around the editor: the label was a border, a heading and two
          layers of padding wrapped around the one control on the screen. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className={cn(TYPE.label, "text-muted-foreground")}>Custom instructions</span>
          <span className="flex items-center gap-1.5">
            {paused && (
              <span className={cn("inline-flex items-center gap-1 text-amber-500", TYPE.micro)}>
                <span className="size-1.5 rounded-full bg-amber-500" /> Paused
              </span>
            )}
            <span className={cn("text-muted-foreground", TYPE.micro)}>
              {busy ? "Saving…" : saved ? "Saved" : canEdit ? "Saves as you type" : "Read-only"}
            </span>
            {/* The prompt is the behaviour, so its history matters as much as
                the data room's. Same clock affordance, same diff viewer. */}
            <PromptHistoryButton
              agentKey={agent.key}
              agentName={agent.name}
              onRestored={(instructions) => setDraft(instructions ?? "")}
            />
            {canEdit && (
              <RowActions
                items={[
                  {
                    label: paused ? "Resume agent" : "Pause agent",
                    onClick: () => void onPut({ paused: !paused }),
                  },
                ]}
              />
            )}
          </span>
        </div>
        <CodeEditor
          value={draft}
          onChange={setDraft}
          // Persisted on idle and on blur — a Save button for one field is a
          // step to forget, not a safeguard.
          onCommit={
            canEdit
              ? async (next) => {
                  setBusy(true);
                  await onPut({ instructions: next || null });
                  setBusy(false);
                  setSaved(true);
                  window.setTimeout(() => setSaved(false), 2000);
                }
              : undefined
          }
          disabled={!canEdit}
          placeholder={canEdit ? `Anything the ${agent.name} agent should always do or avoid…` : "No custom instructions."}
          className="h-[58vh] min-h-[16rem]"
        />
      </div>
    </PanelBody>
  );
}

function AgentsTab({ role: _role }: { role: Role }) {
  // Per-agent config: paused + custom instructions.
  const [configs, setConfigs] = useState<Record<string, AgentConfig>>({});
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [reviewing, setReviewing] = useState<SubagentRow | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await opsFetch<{ items: { agentKey: string; paused: boolean; instructions: string | null }[]; canEdit?: boolean }>("/api/ops/agent-configs");
      const map: Record<string, AgentConfig> = {};
      for (const it of d.items) map[it.agentKey] = { paused: it.paused, instructions: it.instructions };
      setConfigs(map);
      setCanEdit(Boolean(d.canEdit));
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Write one agent's config.
   *
   * Optimistic, and no refetch. This used to apply the change locally only
   * after the PUT resolved AND a full re-list of every agent's config came
   * back — two serial round trips before the editor stopped saying "Saving…",
   * on a control that fires whenever you pause typing. The PUT already returns
   * the stored row, so the list of all the others is a request for data nobody
   * asked about.
   */
  async function put(agentKey: string, fields: { paused?: boolean; instructions?: string | null }) {
    setError(null);
    const previous = configs[agentKey];
    setConfigs((cur) => ({
      ...cur,
      [agentKey]: {
        paused: fields.paused ?? cur[agentKey]?.paused ?? false,
        instructions:
          fields.instructions !== undefined ? fields.instructions : (cur[agentKey]?.instructions ?? null),
      },
    }));
    try {
      const d = await opsFetch<{ item: { agentKey: string; paused: boolean; instructions: string | null } }>(
        "/api/ops/agent-configs",
        { method: "PUT", body: JSON.stringify({ agentKey, ...fields }) },
      );
      if (d?.item) {
        setConfigs((cur) => ({
          ...cur,
          [agentKey]: { paused: d.item.paused, instructions: d.item.instructions ?? null },
        }));
      }
    } catch (e) {
      // Put the old value back rather than leaving the panel showing a state
      // the server rejected.
      setConfigs((cur) => {
        const next = { ...cur };
        if (previous) next[agentKey] = previous;
        else delete next[agentKey];
        return next;
      });
      setError(errMessage(e));
    }
  }

  const columns: Column<SubagentRow>[] = [
    {
      key: "agent",
      header: "Agent",
      icon: BotIcon,
      text: (r) => `${r.name} ${r.description}`,
      cell: (r) => {
        const custom = Boolean(configs[r.key]?.instructions);
        const paused = Boolean(configs[r.key]?.paused);
        return (
          <div className="flex items-center gap-2.5">
            {/* Active-ness rides on the avatar rather than owning a column: it
                is one bit, and a whole column of "Active" said nothing on any
                row until something was paused. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative grid size-7 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
                  <BotIcon className="size-3.5" />
                  <span
                    className={cn(
                      "-right-0.5 -top-0.5 absolute size-2 rounded-full ring-2 ring-card",
                      paused ? "bg-amber-500" : "bg-emerald-500",
                    )}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{paused ? "Paused" : "Active"}</TooltipContent>
            </Tooltip>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate font-medium">
                {r.name}
                {custom ? <span className="rounded bg-primary/10 px-1 py-px text-3xs text-primary">personalized</span> : null}
              </div>
              <div className="truncate text-2xs text-muted-foreground">{r.description}</div>
            </div>
          </div>
        );
      },
    },
    // No "Connected by" here: every subagent ships with the product, so the
    // column read "Built-in" on every row and only ever cost width.
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (r) => (
        <RowActions
          items={[
            { label: "Review", onClick: () => setReviewing(r) },
            ...(canEdit
              ? configs[r.key]?.paused
                ? [{ label: "Resume", onClick: () => void put(r.key, { paused: false }) }]
                : [{ label: "Pause", onClick: () => void put(r.key, { paused: true }), destructive: true }]
              : []),
          ]}
        />
      ),
    },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <HeaderCard
        icon={BotIcon}
        title="Agents"
        blurb="The specialist subagents the orchestrator delegates to — open one to pause it or personalize how it behaves."
      />
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      <PaginatedTable
        rows={SUBAGENTS}
        columns={columns}
        getKey={(r) => r.key}
        noun="agent"
        emptyLabel="No agents."
        selectedKey={reviewing?.key ?? null}
        onCloseDetail={() => setReviewing(null)}
        renderDetail={(a) => (
          <AgentDetailPanel key={a.key} agent={a} config={configs[a.key]} canEdit={canEdit} onPut={(f) => put(a.key, f)} />
        )}
      />
    </div>
  );
}

/* -------------------------------- Agent ---------------------------------- */

const MODE_OPTS: { value: AgentMode; label: string }[] = [
  { value: "build", label: "Build" },
  { value: "plan", label: "Plan" },
  { value: "goal", label: "Goal" },
  { value: "loop", label: "Loop" },
];

function AgentTab({ role }: { role: Role }) {
  const [scope, setScope] = useState<"org" | "me">("me");
  const [orgDefault, setOrgDefault] = useState<AgentProfileFields | null>(null);
  const [mine, setMine] = useState<AgentProfileFields | null>(null);
  const [draft, setDraft] = useState<AgentProfileFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const canEditOrg = isAdmin(role);

  const load = useCallback(async () => {
    try {
      const d = await opsFetch<{ orgDefault: AgentProfileFields | null; mine: AgentProfileFields | null }>(
        "/api/ops/agent-profile",
      );
      setOrgDefault(d.orgDefault);
      setMine(d.mine);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const EMPTY: AgentProfileFields = {
    personaName: null,
    tone: null,
    instructions: null,
    defaultMode: null,
    webSearchDefault: null,
    browserDefault: null,
    model: null,
  };
  // Draft follows the selected scope's stored row.
  useEffect(() => {
    setDraft({ ...EMPTY, ...(scope === "org" ? orgDefault : mine) });
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, orgDefault, mine]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setSaved(false);
    try {
      await opsFetch("/api/ops/agent-profile", { method: "PUT", body: JSON.stringify({ scope, ...draft }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return <div className="flex justify-center py-16"><Spinner /></div>;
  const set = (patch: Partial<AgentProfileFields>) => setDraft({ ...draft, ...patch });
  const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
  return (
    <div className="space-y-6">
      <HeaderCard
        icon={BotIcon}
        title="Agent"
        blurb="Personalize how the agent works — persona, tone, standing instructions, and defaults."
      />
      <div className="max-w-lg space-y-6">
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      {/* Scope: personal override vs workspace default (admins). */}
      {canEditOrg && (
        <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
          {(["me", "org"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-md px-3 py-1 ${scope === s ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
            >
              {s === "me" ? "My agent" : "Workspace default"}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {scope === "org"
          ? "Applies to everyone in this workspace unless they set their own."
          : "Your personal settings — override the workspace default just for you."}
      </p>

      <label className="block space-y-1.5">
        <span className={label}>Agent name</span>
        <Input value={draft.personaName ?? ""} onChange={(e) => set({ personaName: e.target.value || null })} placeholder="e.g. Ava" />
      </label>
      <label className="block space-y-1.5">
        <span className={label}>Tone</span>
        <Input value={draft.tone ?? ""} onChange={(e) => set({ tone: e.target.value || null })} placeholder="e.g. concise and direct" />
      </label>
      <label className="block space-y-1.5">
        <span className={label}>Standing instructions</span>
        <textarea
          value={draft.instructions ?? ""}
          onChange={(e) => set({ instructions: e.target.value || null })}
          rows={5}
          placeholder="Anything the agent should always keep in mind…"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block space-y-1.5">
          <span className={label}>Default mode</span>
          <select
            value={draft.defaultMode ?? ""}
            onChange={(e) => set({ defaultMode: (e.target.value || null) as AgentMode | null })}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">— none —</option>
            {MODE_OPTS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className={label}>Preferred model</span>
          <Input value={draft.model ?? ""} onChange={(e) => set({ model: e.target.value || null })} placeholder="platform default" />
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.webSearchDefault ?? false} onChange={(e) => set({ webSearchDefault: e.target.checked })} />
          Web search on by default
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.browserDefault ?? false} onChange={(e) => set({ browserDefault: e.target.checked })} />
          Browser use on by default
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {saved && <span className="text-xs text-emerald-500">Saved</span>}
      </div>
      </div>
    </div>
  );
}

/* ------------------------------- Settings -------------------------------- */

function SettingsTab({ orgId, role }: { orgId: string; role: Role }) {
  const [org, setOrg] = useState<OrgRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");

  useEffect(() => {
    opsFetch<{ item: OrgRow }>(`/api/ops/orgs/${orgId}`)
      .then((d) => {
        setOrg(d.item);
        setName(d.item.name ?? "");
        setDomain(d.item.googleHostedDomain ?? "");
      })
      .catch((e) => setError(errMessage(e)));
  }, [orgId]);

  async function save() {
    setSaved(false);
    try {
      await opsFetch(`/api/ops/orgs/${orgId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, googleHostedDomain: domain || null }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(errMessage(e));
    }
  }
  async function setStatus(status: "active" | "suspended") {
    try {
      const { item } = await opsFetch<{ item: OrgRow }>(`/api/ops/orgs/${orgId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setOrg(item);
    } catch (e) {
      setError(errMessage(e));
    }
  }

  if (!org) return <div className="flex justify-center py-16"><Spinner /></div>;
  const canEdit = isAdmin(role);
  return (
    <div className="max-w-lg space-y-6">
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      <label className="block space-y-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Company name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Work email domain</span>
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} disabled={!canEdit} placeholder="none — invite-only" />
        <span className="text-xs text-muted-foreground">Anyone signing in from this domain joins this workspace.</span>
      </label>
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button onClick={save}>Save changes</Button>
          {saved && <span className="text-xs text-emerald-700 dark:text-emerald-400">Saved</span>}
        </div>
      )}

      {canEdit && (
        <div className="mt-8 rounded-lg border border-destructive/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-destructive">
            <ShieldAlertIcon className="size-4" /> Danger zone
          </div>
          {org.status === "active" ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Suspend the workspace — the gate 403s and the dispatcher skips its schedules.</span>
              <Button variant="outline" onClick={() => setStatus("suspended")}>Suspend</Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">This workspace is suspended.</span>
              <Button variant="outline" onClick={() => setStatus("active")}>Reactivate</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Usage ---------------------------------- */

function UsageTab({ orgId }: { orgId: string }) {
  const [u, setU] = useState<{
    scope: string;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    limits: { monthlyTokenCap?: number; monthlyCostUsdCap?: number; workflowRunCap?: number } | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    opsFetch<typeof u>(`/api/ops/orgs/${orgId}/usage`).then(setU).catch((e) => setError(errMessage(e)));
  }, [orgId]);

  const tokens = useMemo(() => (u ? u.inputTokens + u.outputTokens : 0), [u]);
  if (error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>;
  if (!u) return <div className="flex justify-center py-16"><Spinner /></div>;
  return (
    <div className="space-y-6">
      <div className="text-xs text-muted-foreground">Trailing 30 days · scope: {u.scope}</div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Runs" value={u.runs.toLocaleString()} cap={u.limits?.workflowRunCap} />
        <Stat label="Tokens" value={tokens.toLocaleString()} cap={u.limits?.monthlyTokenCap} />
        <Stat label="Cost" value={`$${u.costUsd.toFixed(2)}`} cap={u.limits?.monthlyCostUsdCap ? `$${u.limits.monthlyCostUsdCap}` : undefined} />
      </div>
      {!u.limits && (
        <p className="text-xs text-muted-foreground">No caps configured. Set monthly token / cost / run caps in the workspace limits to have the dispatcher enforce them.</p>
      )}
    </div>
  );
}

function Stat({ label, value, cap }: { label: string; value: string; cap?: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {cap != null && <div className="text-xs text-muted-foreground">cap {typeof cap === "number" ? cap.toLocaleString() : cap}</div>}
    </div>
  );
}

/* -------------------------------- Audit ---------------------------------- */

interface AuditRow {
  id: string;
  actor: string;
  event: string;
  automationType: string;
  createdAt: string;
}
const RANGE_PRESETS: { key: string; label: string; days: number | null }[] = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
  { key: "custom", label: "Custom range", days: null },
];

function AuditTab({ orgId }: { orgId: string }) {
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actor, setActor] = useState("all");
  const [reviewing, setReviewing] = useState<AuditRow | null>(null);
  useEffect(() => {
    opsFetch<{ items: AuditRow[] }>(`/api/ops/orgs/${orgId}/audit`).then((d) => setItems(d.items)).catch((e) => setError(errMessage(e)));
  }, [orgId]);

  const actors = useMemo(() => Array.from(new Set((items ?? []).map((i) => i.actor).filter(Boolean))).sort(), [items]);
  const filtered = useMemo(() => {
    if (!items) return [];
    // Resolve the date window [lo, hi) from the preset or the custom inputs.
    let lo = -Infinity;
    let hi = Infinity;
    const p = RANGE_PRESETS.find((x) => x.key === preset);
    if (preset === "custom") {
      if (from) lo = new Date(`${from}T00:00:00`).getTime();
      if (to) hi = new Date(`${to}T23:59:59.999`).getTime();
    } else if (p && p.days != null) {
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - p.days);
      start.setHours(0, 0, 0, 0);
      lo = start.getTime();
    }
    return items.filter((i) => {
      if (actor !== "all" && i.actor !== actor) return false;
      const t = Date.parse(i.createdAt);
      return Number.isNaN(t) ? true : t >= lo && t <= hi;
    });
  }, [items, preset, from, to, actor]);

  if (error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>;
  if (!items) return <div className="flex justify-center py-16"><Spinner /></div>;
  const columns: Column<AuditRow>[] = [
    { key: "type", header: "Type", icon: TagIcon, cell: (r) => <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{r.automationType}</span>, text: (r) => r.automationType },
    { key: "event", header: "Event", icon: ActivityIcon, cell: (r) => r.event, text: (r) => r.event },
    ...metaColumns<AuditRow>(
      (r) => ({ actor: r.actor, when: r.createdAt }),
      (r) => [{ label: "Copy event", onClick: () => void navigator.clipboard.writeText(r.event).catch(() => {}) }],
      (r) => setReviewing(r),
    ),
  ];
  const selectCls = "h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <HeaderCard
        icon={ActivityIcon}
        title="Audit trail"
        blurb="Every change made in this workspace — who did what, and when."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <ClockIcon className="size-3.5" />
            </span>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} className={selectCls} aria-label="Time range">
              {RANGE_PRESETS.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
            {preset === "custom" && (
              <>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={selectCls} />
                <span className="text-2xs text-muted-foreground">→</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={selectCls} />
              </>
            )}
            <select value={actor} onChange={(e) => setActor(e.target.value)} className={selectCls} aria-label="Actor">
              <option value="all">All actors</option>
              {actors.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        }
      />
      <PaginatedTable
        rows={filtered}
        // So the count reads "12 of 104 events" — the date and actor filters
        // happen here, above the table, and the table cannot see them.
        totalBeforeFilters={items.length}
        columns={columns}
        getKey={(r) => r.id}
        noun="event"
        emptyLabel={items.length === 0 ? "No audit events yet." : "No events in this range."}
        selectedKey={reviewing?.id ?? null}
        onCloseDetail={() => setReviewing(null)}
        renderDetail={(a) => (
          <PanelBody
            title={a.event}
            subtitle={`${a.automationType} · ${fmtTime(a.createdAt)}`}
            avatar={
              <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
                <ActivityIcon className="size-5" />
              </span>
            }
          >
            <PanelField label="Event"><span className="whitespace-pre-wrap">{a.event}</span></PanelField>
            <div className="grid grid-cols-2 gap-2.5">
              <PanelField label="Actor">{a.actor}</PanelField>
              <PanelField label="Type">{a.automationType}</PanelField>
            </div>
            <PanelField label="When">{new Date(a.createdAt).toLocaleString()}</PanelField>
            <div className="mt-1.5">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(a.event).catch(() => {})}>Copy event</Button>
            </div>
          </PanelBody>
        )}
      />
    </div>
  );
}

/* ------------------------------- Data room ------------------------------- */

interface DataroomRow {
  path: string;
  section: string;
  type: string;
}
/** Live preview of a data-room file inside the detail panel. Text/Markdown
 *  renders as-is (truncated); .jsonl shows the record count + first records. */
function FilePreview({ path }: { path: string }) {
  const [state, setState] = useState<{ loading: boolean; text?: string; note?: string; error?: string }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    fetch(`/api/dataroom?path=${encodeURIComponent(path)}`, {
      headers: authToken() ? { Authorization: `Bearer ${authToken()}` } : {},
    })
      .then((r) => r.json())
      .then((d: { content?: string; records?: unknown[]; found?: boolean }) => {
        if (!alive) return;
        if (Array.isArray(d.records)) {
          setState({
            loading: false,
            note: `${d.records.length} record${d.records.length === 1 ? "" : "s"} — first ${Math.min(3, d.records.length)} shown`,
            text: JSON.stringify(d.records.slice(0, 3), null, 2),
          });
        } else if (typeof d.content === "string") {
          const truncated = d.content.length > 6000;
          setState({
            loading: false,
            note: truncated ? `${(d.content.length / 1000).toFixed(0)}k chars — first 6k shown` : undefined,
            text: d.content.slice(0, 6000),
          });
        } else {
          setState({ loading: false, error: "File not found in the store." });
        }
      })
      .catch((e) => alive && setState({ loading: false, error: errMessage(e) }));
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <PanelField label={state.note ? `Preview · ${state.note}` : "Preview"}>
      {state.loading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : state.error ? (
        <span className="text-muted-foreground text-xs">{state.error}</span>
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-3 font-mono text-xs leading-relaxed">
          {state.text}
        </pre>
      )}
    </PanelField>
  );
}

/* --------------------------- Data room · history -------------------------- */

interface ChangesetRow {
  id: string;
  label: string;
  actor: string;
  source: string;
  rationale: string | null;
  unattended: boolean;
  status: string;
  createdAt: string;
  committedAt: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  files: number;
}
interface ChangesetFile {
  path: string;
  action: string;
  prevBytes: number | null;
  newBytes: number | null;
  hasSnapshot: boolean;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const CHANGESET_STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  open: { label: "open", cls: "text-amber-500", dot: "bg-amber-500" },
  committed: { label: "committed", cls: "text-emerald-500", dot: "bg-emerald-500" },
  reverted: { label: "reverted", cls: "text-muted-foreground", dot: "bg-muted-foreground/50" },
};

/**
 * Whether a human saw this batch before it landed.
 *
 * The one fact on a changeset that changes how much you trust it, so it reads
 * as a warning rather than as another neutral column value — an unattended
 * backfill that got something wrong is exactly what the revert button is for,
 * and someone scanning this list has to be able to find those at a glance.
 */

/** States exactly what reverting this batch does, per file, before it happens. */
function RevertDialog({
  changeset,
  files,
  onCancel,
  onConfirm,
  busy,
}: {
  changeset: ChangesetRow;
  files: ChangesetFile[];
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const paths = new Set(files.map((f) => f.path));
  // A path written twice in one batch is restored once, to its oldest snapshot,
  // so the counts here are per PATH — otherwise the dialog promises more files
  // than the revert will touch.
  const restore = new Set(files.filter((f) => f.hasSnapshot).map((f) => f.path));
  const empty = [...paths].filter((p) => !restore.has(p));
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className={cn(SURFACE.overlay, "w-full max-w-md gap-3 p-5")}>
        <DialogHeader>
          <DialogTitle className={TYPE.title}>Revert “{changeset.label}”?</DialogTitle>
          <DialogDescription className={TYPE.body}>
            Every file this changeset touched goes back to the bytes it held before the batch ran.
          </DialogDescription>
        </DialogHeader>
        <ul className={cn("flex flex-col gap-1", TYPE.body)}>
          <li>
            <b className="tabular-nums">{restore.size}</b> file{restore.size === 1 ? "" : "s"} restored from the
            snapshot taken before each write.
          </li>
          <li>
            <b className="tabular-nums">{empty.length}</b> file{empty.length === 1 ? "" : "s"} this changeset created
            will be <b>emptied</b>, not deleted — the store has no delete, so they stay visible and removable.
          </li>
        </ul>
        {empty.length > 0 && (
          <div className={cn(SURFACE.inset, "max-h-28 overflow-auto bg-muted/20 px-2.5 py-2 font-mono text-2xs")}>
            {empty.map((p) => (
              <div key={p} className="truncate">{p}</div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <OpsButton intent="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </OpsButton>
          <OpsButton intent="danger" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? "Reverting…" : "Revert changeset"}
          </OpsButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One file's real before/after, as reconstructed by the server. */
interface FileDiffRow {
  path: string;
  action: string;
  before: string | null;
  after: string | null;
}

/**
 * Every file this changeset touched, as one unified diff.
 *
 * The panel used to fetch a file at a time and use the CURRENT content as the
 * after-side, which is only correct for the newest write to a path: a reverted
 * changeset diffed against its own undo, and any later edit was attributed to
 * this version. That is what made it read as noise. The server now reconstructs
 * the real after-state (the next write's before-snapshot) and returns every
 * file in one request.
 */
/**
 * Fetches one changeset's per-file before/after and hands it to the viewer.
 *
 * The rendering lives in ./diff-view — a side-by-side view with hunk headers
 * and word-level highlighting, which is enough code to deserve its own file.
 */
function ChangesetDiff({
  changesetId,
  onSummary,
}: {
  readonly changesetId: string;
  readonly onSummary?: (s: { files: number; added: number; removed: number }) => void;
}) {
  const [files, setFiles] = useState<FileDiffRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(null);
    opsFetch<{ files: FileDiffRow[] }>(`/api/ops/dataroom/changesets/${changesetId}?diff=1`)
      .then((d) => alive && setFiles(d.files))
      .catch((e) => alive && setError(errMessage(e)));
    return () => {
      alive = false;
    };
  }, [changesetId]);

  if (error) return <div className={cn("text-muted-foreground", TYPE.meta)}>{error}</div>;
  if (files === null)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  return <ChangesetDiffView files={files} onSummary={onSummary} />;
}

function ChangesetDetail({
  changeset,
  canRevert,
  onReverted,
}: {
  changeset: ChangesetRow;
  canRevert: boolean;
  onReverted: () => void;
}) {
  const [files, setFiles] = useState<ChangesetFile[] | null>(null);
  const [summary, setSummary] = useState<{ files: number; added: number; removed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ restored: string[]; emptied: string[]; failed: { path: string; error: string }[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setResult(null);
    opsFetch<{ files: ChangesetFile[] }>(`/api/ops/dataroom/changesets/${changeset.id}`)
      .then((d) => alive && setFiles(d.files))
      .catch((e) => alive && setError(errMessage(e)));
    return () => {
      alive = false;
    };
  }, [changeset.id]);

  async function revert() {
    setBusy(true);
    setError(null);
    try {
      const r = await opsFetch<{ restored: string[]; emptied: string[]; failed: { path: string; error: string }[] }>(
        `/api/ops/dataroom/changesets/${changeset.id}`,
        { method: "POST", body: JSON.stringify({ revert: true }) },
      );
      setResult(r);
      setConfirming(false);
      onReverted();
    } catch (e) {
      setError(errMessage(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelBody
      title={changeset.label}
      subtitle={`${changeset.files} file${changeset.files === 1 ? "" : "s"} · ${changeset.source} · ${fmtTime(changeset.createdAt)}`}
      avatar={
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
          <GitCommitIcon className="size-5" />
        </span>
      }
    >
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {/* The subject of the screen. */}
      <div className="flex items-baseline justify-between gap-2 pt-0.5">
        <span className={cn(TYPE.label, "text-muted-foreground")}>Changes</span>
        {summary && (
          <span className={cn("tabular-nums text-muted-foreground", TYPE.meta)}>
            {summary.files} file{summary.files === 1 ? "" : "s"} ·{" "}
            <span className="text-emerald-500">+{summary.added}</span>{" "}
            <span className="text-destructive">−{summary.removed}</span>
          </span>
        )}
      </div>
      <ChangesetDiff changesetId={changeset.id} onSummary={setSummary} />

      {result && (
        <PanelField label="Revert result">
          <div className={cn("flex flex-col gap-0.5", TYPE.body)}>
            <span>{result.restored.length} restored · {result.emptied.length} emptied</span>
            {result.failed.length > 0 && (
              <span className="text-destructive">
                {result.failed.length} failed: {result.failed.map((f) => f.path).join(", ")}
              </span>
            )}
          </div>
        </PanelField>
      )}

      {canRevert && changeset.status !== "reverted" && files !== null && (
        <div className="mt-1.5">
          <OpsButton intent="danger" size="sm" onClick={() => setConfirming(true)}>
            <RotateCcwIcon className="size-3.5" /> Revert changeset
          </OpsButton>
        </div>
      )}
      {confirming && files && (
        <RevertDialog
          changeset={changeset}
          files={files}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void revert()}
        />
      )}
    </PanelBody>
  );
}

function DataroomHistory({ canRevert }: { canRevert: boolean }) {
  const [rows, setRows] = useState<ChangesetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reverting, setReverting] = useState<ChangesetRow | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await opsFetch<{ items: ChangesetRow[] }>("/api/ops/dataroom/changesets");
      setRows(d.items);
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>;
  if (!rows) return <div className="flex justify-center py-16"><Spinner /></div>;

  const columns: Column<ChangesetRow>[] = [
    {
      key: "changeset",
      header: "Changeset",
      icon: GitCommitIcon,
      // "unattended" is searchable text, not only a badge — that is how someone
      // asked to find the unreviewed batches actually narrows this list.
      // Source and status lost their columns but not their searchability —
      // typing "cli" or "reverted" still narrows the list.
      text: (r) =>
        `${r.label} ${r.rationale ?? ""} ${r.unattended ? "unattended" : "reviewed"} ${r.source} ${r.status}`,
      cell: (r) => (
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
            <GitCommitIcon className="size-3.5" />
          </span>
          <div className="min-w-0">
            {/* Title over its summary — nothing else. Badges made the cell a
                row of competing chips; both facts they carried are still one
                click away in the detail, and both are still searchable. */}
            <div className="truncate font-medium">{r.label}</div>
            <div className="truncate text-2xs text-muted-foreground">{r.rationale ?? r.id}</div>
          </div>
        </div>
      ),
    },
    {
      key: "files",
      header: "Files",
      icon: FileTextIcon,
      text: (r) => String(r.files),
      cell: (r) => <span className="tabular-nums text-xs">{r.files}</span>,
    },
    ...metaColumns<ChangesetRow>(
      (r) => ({ actor: r.actor, when: r.committedAt ?? r.createdAt }),
      (r) => [
        ...(canRevert && r.status !== "reverted"
          ? [
              {
                label: "Revert…",
                destructive: true,
                // Deferred: opening the confirm dialog in the same tick as the
                // menu's select leaves body pointer-events stuck at "none".
                onClick: () => afterMenuClose(() => setReverting(r)),
              },
            ]
          : []),
        { label: "Copy id", onClick: () => void navigator.clipboard.writeText(r.id).catch(() => {}) },
      ],
      (r) => setReviewing(r.id),
    ),
  ];
  return (
    <>
    <PaginatedTable
      rows={rows}
      columns={columns}
      getKey={(r) => r.id}
      noun="changeset"
      // Already inside the history dialog, which supplies the frame.
      flush
      emptyLabel="No changesets yet — batched writes will show up here."
      // Every other table here opens its detail on row click; this one required
      // finding Review in the row menu, which reads as "the row is not clickable".
      onRowClick={(r) => setReviewing(r.id)}
      selectedKey={reviewing}
      onCloseDetail={() => setReviewing(null)}
      renderDetail={(r) => (
        <ChangesetDetail key={r.id} changeset={r} canRevert={canRevert} onReverted={() => void load()} />
      )}
    />
    {reverting && (
      <RowRevertFlow
        changeset={reverting}
        onClose={() => setReverting(null)}
        onDone={() => {
          setReverting(null);
          void load();
        }}
      />
    )}
    </>
  );
}

/**
 * Revert straight from the row menu.
 *
 * Reverting was reachable only by opening a changeset and scrolling past the
 * whole diff, which is backwards for the one row you already know is wrong.
 * The confirm dialog is the same one the detail panel uses, and it needs the
 * per-file snapshot list to tell you honestly what will be restored versus
 * emptied — so the files are fetched first and the dialog waits for them
 * rather than guessing.
 */
function RowRevertFlow({
  changeset,
  onClose,
  onDone,
}: {
  readonly changeset: ChangesetRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [files, setFiles] = useState<ChangesetFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    opsFetch<{ files: ChangesetFile[] }>(`/api/ops/dataroom/changesets/${changeset.id}`)
      .then((d) => alive && setFiles(d.files))
      .catch((e) => alive && setError(errMessage(e)));
    return () => {
      alive = false;
    };
  }, [changeset.id]);

  async function revert() {
    setBusy(true);
    try {
      await opsFetch(`/api/ops/dataroom/changesets/${changeset.id}`, {
        method: "POST",
        body: JSON.stringify({ revert: true }),
      });
      onDone();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }

  if (error) {
    return (
      <Dialog open onOpenChange={() => onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Couldn&apos;t revert</DialogTitle>
          <p className={cn("text-destructive", TYPE.body)}>{error}</p>
        </DialogContent>
      </Dialog>
    );
  }
  if (!files) return null;
  return (
    <RevertDialog
      changeset={changeset}
      files={files}
      busy={busy}
      onCancel={onClose}
      onConfirm={() => void revert()}
    />
  );
}

function DataroomTab({ role }: { role: Role }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rows, setRows] = useState<DataroomRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<DataroomRow | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dataroom", { headers: authToken() ? { Authorization: `Bearer ${authToken()}` } : {} });
      const d = (await res.json()) as { paths?: string[] };
      const paths = d.paths ?? [];
      setRows(
        paths.map((p) => {
          const seg = p.split("/").filter(Boolean);
          const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1) : "—";
          return { path: p, section: seg.length > 1 ? seg[0] : "root", type: ext };
        }),
      );
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file, file.name);
        await fetch("/api/ops/upload", { method: "POST", headers: authToken() ? { Authorization: `Bearer ${authToken()}` } : {}, body: form });
      }
      await load();
    } catch (e2) {
      setError(errMessage(e2));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<DataroomRow>[] = [
    {
      key: "file",
      header: "File",
      icon: FileTextIcon,
      text: (r) => r.path,
      cell: (r) => {
        const name = r.path.split("/").filter(Boolean).pop() ?? r.path;
        return (
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
              <FileTextIcon className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium">{name}</div>
              <div className="truncate font-mono text-2xs text-muted-foreground">{r.path}</div>
            </div>
          </div>
        );
      },
    },
    { key: "section", header: "Section", icon: FolderIcon, cell: (r) => <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{r.section}</span>, text: (r) => r.section },
    { key: "type", header: "Type", icon: TagIcon, cell: (r) => <span className="text-muted-foreground text-xs uppercase">{r.type}</span>, text: (r) => r.type },
    ...metaColumns<DataroomRow>(
      () => ({ actor: null, when: null }),
      (r) => [{ label: "Copy path", onClick: () => void navigator.clipboard.writeText(r.path).catch(() => {}) }],
      (r) => setReviewing(r),
    ),
  ];
  const exportPaths = () =>
    downloadCsv("dataroom.csv", ["path", "section", "type"], (rows ?? []).map((r) => [r.path, r.section, r.type]));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <input ref={importRef} type="file" multiple className="hidden" onChange={onImport} />
      <HeaderCard
        icon={FolderIcon}
        title="Data room"
        blurb="Every document, dataset, and artifact the agent works from."
        action={
          <div className="flex items-center gap-2">
            {/* History is something you consult, not a mode you work in — a
                segmented toggle made it a second half of this tab and pushed
                Export/Import around whenever it was on. An icon that opens a
                modal costs nothing when you are not looking at it. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  aria-label="Version history"
                  className="grid size-8 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <HistoryIcon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Version history</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={exportPaths}>
              <DownloadIcon className="size-4" /> Export
            </Button>
            <Button size="sm" onClick={() => importRef.current?.click()} disabled={busy}>
              <UploadIcon className="size-4" /> {busy ? "Uploading…" : "Import"}
            </Button>
          </div>
        }
      />
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        {/* Same 70% as the workflow DAG: the table plus its detail panel needs
            the room, and a default dialog width would put them in a column. */}
        <DialogContent className="flex h-[80vh] w-[80vw] max-w-none flex-col gap-3 sm:max-w-none">
          <DialogHeader className="shrink-0">
            <DialogTitle>Version history</DialogTitle>
            <DialogDescription>
              Every batch of writes, what it replaced, and the way back if it was wrong.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Reverting rewrites the workspace's record in bulk; the API is
                admin/owner-only, so a non-admin is never shown the action. */}
            <DataroomHistory canRevert={isAdmin(role)} />
          </div>
        </DialogContent>
      </Dialog>
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      ) : !rows ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
      <PaginatedTable
        rows={rows}
        columns={columns}
        getKey={(r) => r.path}
        noun="file"
        emptyLabel="The data room is empty."
        selectedKey={reviewing?.path ?? null}
        onCloseDetail={() => setReviewing(null)}
        renderDetail={(f) => (
          <PanelBody
            title={f.path.split("/").filter(Boolean).pop() ?? f.path}
            subtitle={f.path}
            avatar={
              <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
                <FileTextIcon className="size-5" />
              </span>
            }
          >
            <PanelField label="Path"><span className="break-all font-mono text-xs">{f.path}</span></PanelField>
            <div className="grid grid-cols-2 gap-2.5">
              <PanelField label="Section">{f.section}</PanelField>
              <PanelField label="Type"><span className="uppercase">{f.type}</span></PanelField>
            </div>
            <FilePreview key={f.path} path={f.path} />
            <div className="mt-1.5 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(f.path).catch(() => {})}>
                Copy path
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.open(`/api/dataroom?path=${encodeURIComponent(f.path)}`, "_blank")}>
                Open raw
              </Button>
            </div>
          </PanelBody>
        )}
      />
      )}
    </div>
  );
}

/* -------------------------------- People --------------------------------- */

/** Just enough of a customer to give a person's record some context. */
interface CustomerLite {
  id: string;
  name: string;
  tier: string | null;
  lifecycleStage: string | null;
  status: string | null;
  healthScore: number | null;
  fdeOwner: string | null;
  openTickets?: number;
}

interface PersonRow {
  email: string;
  name: string | null;
  team: string | null;
  managerEmail: string | null;
  role: Role | null;
  joinedAt: string | null;
}
/** Initials avatar for a person row. */
function InitialsAvatar({ name, email, size = "sm" }: { name: string | null; email: string; size?: "sm" | "lg" }) {
  const src = name?.trim() || email;
  const initials = src
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground",
        size === "lg" ? "size-10 text-sm" : "size-7 text-[11px]",
      )}
    >
      {initials || "?"}
    </span>
  );
}

const ROLES: Role[] = ["owner", "admin", "engineer", "member"];

/** A person's place in the org and on the accounts — the two things a colleague
 *  opens a person record to find out, and the two the panel never showed. */
function PersonContext({
  person,
  people,
  accounts,
  canEdit,
  onOpen,
  onSaved,
}: {
  readonly person: PersonRow;
  readonly people: PersonRow[];
  readonly accounts: CustomerLite[] | null;
  readonly canEdit: boolean;
  readonly onOpen: (p: PersonRow) => void;
  readonly onSaved: () => Promise<void> | void;
}) {
  const email = person.email.toLowerCase();
  const [saving, setSaving] = useState<"manager" | "team" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState(person.team ?? "");
  useEffect(() => setTeamDraft(person.team ?? ""), [person.email, person.team]);

  /**
   * Write one roster field.
   *
   * POST /api/ops/roster already accepted `team` and `managerEmail` and creates
   * the row when the person isn't on the roster yet — the panel simply never
   * offered a control, so both fields were unreachable and every record read
   * "—" forever.
   */
  async function save(patch: { team?: string | null; managerEmail?: string | null }, which: "manager" | "team") {
    setSaving(which);
    setSaveError(null);
    try {
      await opsFetch("/api/ops/roster", {
        method: "POST",
        body: JSON.stringify({ email: person.email, ...patch }),
      });
      await onSaved();
    } catch (e) {
      setSaveError(errMessage(e));
    } finally {
      setSaving(null);
    }
  }
  const manager = person.managerEmail
    ? (people.find((x) => x.email.toLowerCase() === person.managerEmail!.toLowerCase()) ?? {
        email: person.managerEmail,
        name: null,
        team: null,
        managerEmail: null,
        role: null,
        joinedAt: null,
      })
    : null;
  const reports = people.filter((x) => x.managerEmail?.toLowerCase() === email);
  const owned = (accounts ?? []).filter((c) => c.fdeOwner?.toLowerCase() === email);

  const PersonChip = ({ p }: { p: PersonRow }) => (
    <button
      type="button"
      onClick={() => onOpen(p)}
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
    >
      <InitialsAvatar name={p.name} email={p.email} />
      <span className="min-w-0">
        <span className="block truncate text-xs">{p.name ?? p.email.split("@")[0]}</span>
        <span className="block truncate text-2xs text-muted-foreground">{p.email}</span>
      </span>
    </button>
  );

  return (
    <>
      {saveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveError}
        </div>
      )}

      <PanelField label="Reports to">
        {canEdit ? (
          <div className="flex flex-col gap-1.5">
            <select
              value={person.managerEmail ?? ""}
              disabled={saving === "manager"}
              onChange={(e) => void save({ managerEmail: e.target.value || null }, "manager")}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="">No manager</option>
              {people
                // Nobody reports to themselves, and a two-person cycle is the
                // easiest way to make the chain unwalkable.
                .filter((x) => x.email.toLowerCase() !== email)
                .filter((x) => x.managerEmail?.toLowerCase() !== email)
                .map((x) => (
                  <option key={x.email} value={x.email}>
                    {x.name ? `${x.name} — ${x.email}` : x.email}
                  </option>
                ))}
            </select>
            {manager && <PersonChip p={manager} />}
          </div>
        ) : manager ? (
          <PersonChip p={manager} />
        ) : (
          <span className="text-muted-foreground text-xs">No manager on the roster.</span>
        )}
      </PanelField>

      <div className="grid grid-cols-2 gap-2.5">
        <PanelField label="Team">
          {canEdit ? (
            <input
              value={teamDraft}
              disabled={saving === "team"}
              onChange={(e) => setTeamDraft(e.target.value)}
              onBlur={() => teamDraft !== (person.team ?? "") && void save({ team: teamDraft }, "team")}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              placeholder="e.g. Delivery"
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
          ) : (
            (person.team ?? "—")
          )}
        </PanelField>
        <PanelField label="Joined">{person.joinedAt ? fmtTime(person.joinedAt) : "—"}</PanelField>
      </div>

      {reports.length > 0 && (
        <PanelField label={`Direct reports (${reports.length})`}>
          <div className="flex flex-col">
            {reports.map((r) => (
              <PersonChip key={r.email} p={r} />
            ))}
          </div>
        </PanelField>
      )}

      <PanelField label={`${ACCOUNTS_LABEL}${owned.length ? ` (${owned.length})` : ""}`}>
        {accounts === null ? (
          <span className="text-muted-foreground text-xs">Loading…</span>
        ) : owned.length === 0 ? (
          <span className="text-muted-foreground text-xs">{NOT_AN_OWNER}</span>
        ) : (
          <div className="flex flex-col gap-1">
            {owned.map((c) => (
              <div key={c.id} className={cn(SURFACE.inset, "flex items-center gap-2 px-2 py-1.5")}>
                <CustomerMark name={c.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{c.name}</span>
                  <span className={cn("block truncate text-muted-foreground", TYPE.micro)}>
                    {[c.tier, c.lifecycleStage, c.status].filter(Boolean).join(" · ") || "no stage recorded"}
                  </span>
                </span>
                {c.openTickets ? (
                  <span className={cn(SURFACE.chip, "shrink-0 text-muted-foreground", TYPE.micro)}>
                    {c.openTickets} open
                  </span>
                ) : null}
                {typeof c.healthScore === "number" && (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      TYPE.micro,
                      c.healthScore >= 0.7
                        ? "text-emerald-500"
                        : c.healthScore >= 0.4
                          ? "text-amber-500"
                          : "text-destructive",
                    )}
                  >
                    {Math.round(c.healthScore * 100)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelField>
    </>
  );
}

function PeopleTab({ orgId, role, authorEmail }: { orgId: string; role: Role; authorEmail?: string }) {
  const [rows, setRows] = useState<PersonRow[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [rosterImportOpen, setRosterImportOpen] = useState(false);
  // `?import=roster` opens the importer directly: the "Import the roster" setup
  // check links here, and landing on the page without opening it left the user
  // hunting for a button.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("import") === "roster") {
      setRosterImportOpen(true);
    }
  }, []);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<PersonRow | null>(null);
  /**
   * The accounts each person owns.
   *
   * A person record that says only "team —, manager —" answers nothing anyone
   * opens it to ask. What a colleague actually wants is who they report to and
   * which customers they are on, and both already exist — the roster carries
   * the manager, `customers.fde_owner` carries the accounts. They were simply
   * never joined up in the panel.
   */
  const [accounts, setAccounts] = useState<CustomerLite[] | null>(null);
  const canEdit = isAdmin(role);
  const isOwner = role === "owner";
  // Only an owner may grant the owner role, so non-owners never see it as an option.
  const roleOptions: Role[] = isOwner ? ROLES : ROLES.filter((r) => r !== "owner");

  const load = useCallback(async () => {
    try {
      const [roster, members, pending, custs] = await Promise.all([
        opsFetch<{ items: { email: string; name: string | null; team: string | null; managerEmail: string | null }[] }>("/api/ops/roster"),
        opsFetch<{ items: MemberRow[] }>(`/api/ops/orgs/${orgId}/members`),
        opsFetch<{ items: PendingInvite[] }>(`/api/ops/orgs/${orgId}/invites`),
        // Non-fatal: the roster is the point of this tab, and a customers
        // outage should cost the account list, not the whole page.
        opsFetch<{ customers: CustomerLite[] }>("/api/ops/customers").catch(() => ({ customers: [] })),
      ]);
      setAccounts(custs.customers ?? []);
      setInvites(pending.items ?? []);
      const memberByEmail = new Map(members.items.map((m) => [m.email.toLowerCase(), m]));
      const byEmail = new Map<string, PersonRow>();
      for (const p of roster.items) {
        const m = memberByEmail.get(p.email.toLowerCase());
        byEmail.set(p.email.toLowerCase(), { email: p.email, name: p.name, team: p.team, managerEmail: p.managerEmail, role: m?.role ?? null, joinedAt: m?.acceptedAt ?? null });
      }
      for (const m of members.items) {
        const k = m.email.toLowerCase();
        if (!byEmail.has(k)) byEmail.set(k, { email: m.email, name: null, team: null, managerEmail: null, role: m.role, joinedAt: m.acceptedAt });
      }
      setRows([...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email)));
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  }, [orgId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function setRoleFor(email: string, next: Role) {
    try {
      await opsFetch(`/api/ops/orgs/${orgId}/members/${encodeURIComponent(email)}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
      await load();
    } catch (e) {
      setError(errMessage(e));
    }
  }
  async function removeMember(email: string) {
    try {
      await opsFetch(`/api/ops/orgs/${orgId}/members/${encodeURIComponent(email)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(errMessage(e));
    }
  }
  async function invite() {
    if (!newEmail.trim()) return;
    setBusy(true);
    setError(null);
    setInviteLink(null);
    setCopied(false);
    try {
      const res = await opsFetch<{ sent: { email: string; url: string }[] }>(`/api/ops/orgs/${orgId}/invites`, {
        method: "POST",
        body: JSON.stringify({ rows: [{ email: newEmail.trim(), role: newRole }] }),
      });
      setInviteLink(res.sent[0]?.url ?? null);
      setNewEmail("");
      await load();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function copyInvite() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }
  /** Rotate the token and replace the prior pending invite. */
  async function resendInvite(email: string, inviteRole: Role) {
    setInviteBusy(email);
    setError(null);
    setCopied(false);
    try {
      const res = await opsFetch<{
        results: { status: string; url?: string; reason?: string }[];
      }>(`/api/ops/orgs/${orgId}/invites`, {
        method: "POST",
        body: JSON.stringify({ rows: [{ email, role: inviteRole }] }),
      });
      const result = res.results[0];
      const failure =
        result?.status === "failed"
          ? `Couldn't resend to ${email}: ${result.reason ?? "unknown error"}`
          : null;
      if (result?.url) {
        setInviteLink(result.url);
        setInviteOpen(true);
      }
      await load();
      if (failure) setError(failure);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setInviteBusy(null);
    }
  }

  /** Delete the pending row, which immediately invalidates its token hash. */
  async function revokeInvite(email: string) {
    setInviteBusy(email);
    setError(null);
    try {
      await opsFetch(`/api/ops/orgs/${orgId}/invites?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      await load();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setInviteBusy(null);
    }
  }
  const importRef = useRef<HTMLInputElement>(null);
  // Import a CSV of `email,role` rows — one add-member call each.
  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const lines = (await file.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const body = lines[0]?.toLowerCase().includes("email") ? lines.slice(1) : lines;
      let ok = 0;
      let fail = 0;
      for (const line of body) {
        const [email, roleRaw] = line.split(",").map((s) => s.trim());
        if (!email || !email.includes("@")) continue;
        const r = (ROLES as string[]).includes(roleRaw ?? "") ? (roleRaw as Role) : "member";
        try {
          await opsFetch(`/api/ops/orgs/${orgId}/members`, { method: "POST", body: JSON.stringify({ email, role: r }) });
          ok++;
        } catch {
          fail++;
        }
      }
      setError(fail ? `Imported ${ok}; ${fail} failed (check permissions / format).` : null);
      await load();
    } catch (e2) {
      setError(errMessage(e2));
    } finally {
      setBusy(false);
    }
  }

  if (!rows) return <div className="flex justify-center py-16"><Spinner /></div>;
  const you = authorEmail?.toLowerCase();
  const columns: Column<PersonRow>[] = [
    {
      key: "person",
      header: "Name",
      icon: UserIcon,
      text: (r) => `${r.name ?? ""} ${r.email}`,
      cell: (r) => (
        <div className="flex items-center gap-2.5">
          <InitialsAvatar name={r.name} email={r.email} />
          <div className="min-w-0">
            <div className="truncate font-medium">
              {r.name ?? r.email.split("@")[0]}
              {r.email === you ? <span className="ml-1.5 text-2xs text-muted-foreground">you</span> : null}
            </div>
            <div className="truncate font-mono text-2xs text-muted-foreground">{r.email}</div>
          </div>
        </div>
      ),
    },
    { key: "team", header: "Team", icon: UsersIcon, cell: (r) => r.team ?? <span className="text-muted-foreground">—</span>, text: (r) => r.team ?? "" },
    {
      key: "role",
      header: "Workspace role",
      icon: ShieldIcon,
      text: (r) => r.role ?? "",
      cell: (r) =>
        r.role == null ? (
          canEdit ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void setRoleFor(r.email, "member");
              }}
              className="rounded-md border border-border px-2 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
            >
              + Add to workspace
            </button>
          ) : (
            <span className="text-muted-foreground text-xs">not a member</span>
          )
        ) : (
          // Read-only. Changing a role is a deliberate act on a person's access,
          // and a bare <select> in a dense list is a hover away from doing it by
          // accident — one stray scroll over a focused control demotes an owner.
          // It lives in the Actions menu with everything else that changes state.
          <RolePill role={r.role} />
        ),
    },
    { key: "manager", header: "Manager", icon: UserIcon, cell: (r) => <span className="text-muted-foreground text-xs">{r.managerEmail ?? "—"}</span>, text: (r) => r.managerEmail ?? "" },
    ...metaColumns<PersonRow>(
      (r) => ({ actor: r.role ? "Workspace" : null, when: r.joinedAt }),
      (r) => [
        { label: "Copy email", onClick: () => void navigator.clipboard.writeText(r.email).catch(() => {}) },
        ...(canEdit && r.role != null && !(r.role === "owner" && !isOwner)
          ? [
              {
                label: "Change role",
                items: (r.role === "owner" ? ROLES : roleOptions).map((x) => ({
                  label: x,
                  checked: r.role === x,
                  onClick: () => void setRoleFor(r.email, x as Role),
                })),
              },
            ]
          : []),
        ...(canEdit && r.role == null ? [{ label: "Add to workspace", onClick: () => void setRoleFor(r.email, "member") }] : []),
        ...(canEdit && r.role && r.role !== "owner"
          ? [{ label: "Remove from workspace", onClick: () => void removeMember(r.email), destructive: true }]
          : []),
      ],
      (r) => setReviewing(r),
    ),
  ];
  /**
   * Download the template.
   *
   * Fetched rather than linked: /api/ops/roster/template needs the bearer token,
   * which an <a href> cannot carry. The workbook itself is built server-side —
   * the module that writes it also reads it back, and reading must not happen in
   * the browser (see lib/roster-workbook.ts).
   */
  const downloadRosterTemplate = async () => {
    try {
      const token = authToken();
      const res = await fetch("/api/ops/roster/template", {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error || `Download failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `roster-${orgId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errMessage(e));
    }
  };

  const exportPeople = () =>
    downloadCsv(
      `people-${orgId}.csv`,
      ["name", "email", "team", "role", "manager"],
      rows.map((r) => [r.name, r.email, r.team, r.role, r.managerEmail]),
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onImport} />
      {rosterImportOpen && (
        <RosterImportDialog onClose={() => setRosterImportOpen(false)} onApplied={load} />
      )}
      <HeaderCard
        icon={UsersIcon}
        title="People"
        blurb="Everyone in this workspace — teammates, their roles, and the roster."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportPeople}>
              <DownloadIcon className="size-4" /> Export
            </Button>
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={busy}>
                    <UserPlusIcon className="size-4" /> Invite
                    <ChevronDownIcon className="size-3.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* Deferred: a dialog opened in the same tick as the menu's
                      select inherits body pointer-events:none and locks the
                      page. See afterMenuClose. */}
                  <DropdownMenuItem onSelect={() => afterMenuClose(() => setInviteOpen(true))}>
                    <LinkIcon className="size-4" /> Invite by link
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => importRef.current?.click()}>
                    <UploadIcon className="size-4" /> Import from CSV
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void downloadRosterTemplate()}>
                    <DownloadIcon className="size-4" /> Roster template (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => afterMenuClose(() => setRosterImportOpen(true))}>
                    <UploadIcon className="size-4" /> Import roster (.xlsx)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      {inviteOpen && (
        <div className="space-y-2 rounded-xl border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@company.com" className="min-w-[14rem] flex-1" />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} aria-label="Role for new member" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm capitalize outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {roleOptions.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
            <Button onClick={invite} disabled={busy || !newEmail.trim()}>
              <LinkIcon className="size-4" /> {busy ? "Creating…" : "Create invite link"}
            </Button>
          </div>
          {inviteLink && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteLink}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={copyInvite}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          )}
        </div>
      )}
      {invites.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="workspace-invites-heading">
          <div className="border-b border-border px-3 py-2.5">
            <h3 id="workspace-invites-heading" className="text-xs font-medium">
              Invitations
            </h3>
          </div>
          <ul className="divide-y divide-border">
            {invites.map((invite) => {
              const working = inviteBusy === invite.email;
              return (
                <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{invite.email}</div>
                    <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                      <span className="capitalize">{invite.role}</span>
                      <span aria-hidden="true">·</span>
                      {invite.status === "accepted" ? (
                        <span className="text-emerald-700 dark:text-emerald-400">already joined</span>
                      ) : invite.status === "expired" ? (
                        <span className="text-amber-700 dark:text-amber-400">expired {fmtTime(invite.expiresAt)}</span>
                      ) : (
                        <span>expires {fmtTime(invite.expiresAt)}</span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-1">
                      {invite.status !== "accepted" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={working}
                          onClick={() => void resendInvite(invite.email, invite.role)}
                        >
                          {working ? "Working…" : "Resend"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={working}
                        className={invite.status === "accepted" ? undefined : "text-destructive hover:text-destructive"}
                        onClick={() => void revokeInvite(invite.email)}
                      >
                        {invite.status === "accepted" ? "Dismiss" : "Revoke"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <PaginatedTable
        rows={rows}
        columns={columns}
        getKey={(r) => r.email}
        noun="person"
        emptyLabel="No people yet."
        selectedKey={reviewing?.email ?? null}
        onCloseDetail={() => setReviewing(null)}
        renderDetail={(p, close) => (
          <PanelBody
            title={p.name ?? p.email.split("@")[0]}
            subtitle={p.email}
            avatar={<InitialsAvatar name={p.name} email={p.email} size="lg" />}
          >
            <PersonContext
              person={p}
              people={rows ?? []}
              accounts={accounts}
              canEdit={canEdit}
              onOpen={(next) => setReviewing(next)}
              onSaved={load}
            />
            <PanelField label="Workspace role">
              {p.role == null ? (
                canEdit ? (
                  <Button variant="outline" size="sm" onClick={() => void setRoleFor(p.email, "member")}>Add to workspace</Button>
                ) : (
                  <span className="text-muted-foreground text-xs">Not a member</span>
                )
              ) : canEdit && !(p.role === "owner" && !isOwner) ? (
                <select
                  value={p.role}
                  onChange={(e) => void setRoleFor(p.email, e.target.value as Role)}
                  aria-label={`Role for ${p.email}`}
                  className="rounded-md border border-input bg-transparent px-2 py-1 text-sm capitalize outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {(p.role === "owner" ? ROLES : roleOptions).map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              ) : (
                <span className="capitalize">{p.role}</span>
              )}
            </PanelField>
            <div className="mt-1.5 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(p.email).catch(() => {})}>
                <MailIcon className="size-4" /> Copy email
              </Button>
              {canEdit && p.role && p.role !== "owner" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    void removeMember(p.email);
                    close();
                  }}
                >
                  <Trash2Icon className="size-4" /> Remove
                </Button>
              )}
            </div>
          </PanelBody>
        )}
      />
    </div>
  );
}
