"use client";

/**
 * Self-serve org onboarding — the §6 three-screen flow:
 *   1. Name the company (slug derived live; domain = the hd-claim rule).
 *   2. The fork — "we'll set it up ourselves" vs "our agents run the recipes".
 *   3. Invite the operators (deterministic setup email, previewed before send)
 *      OR the six setup checks (verified from GET org health, never asserted).
 *
 * Both branches read the SAME /api/ops/orgs/{id}/health — the round-trip is the
 * product. Not a stepper: each screen advances on its own action. Backed
 * entirely by the provisioning API; this file holds no business logic of its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEPLOYMENT_PROFILE, PRODUCT_NAME } from "@/lib/deployment-profile.generated";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  ImagePlusIcon,
  LinkIcon,
  MinusIcon,
  PlusIcon,
  MousePointer2Icon,
  SquareTerminalIcon,
  TerminalIcon,
  UploadIcon,
  UsersIcon,
  FileCodeIcon,
  XIcon,
} from "lucide-react";
import { authToken } from "@/app/_components/ops/lib";
import { mcpConnect } from "@/lib/mcp-connect";
import { toLogoDataUrl } from "@/app/_components/org-mark";
import { W } from "@/lib/ui-words";

type Screen = "name" | "fork" | "invite" | "checks" | "sent";
type Role = "owner" | "admin" | "engineer" | "member";
type InviteRow = { email: string; role: Role };
type HealthCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  deepLink: string;
  /** The server could not evaluate this one — render it as neither pass nor fail. */
  unverifiable?: boolean;
};
/** One invite as the server reports it back — including whether it truly went out. */
type SentInvite = {
  email: string;
  role: string;
  url: string;
  delivered: boolean;
  via?: string;
  reason?: string;
};

/** Good enough to catch a typo before it fails the whole batch server-side. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

const AGENT_CLIENTS = ["Claude Code", "Cursor", "Codex"];
const AGENT_CLIENTS_MORE = ["pi.dev", "hermes", "openclaw"];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = authToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Carry the body through. A 409 on a claimed domain names the workspace to
    // join, and throwing only the message threw that away — leaving the most
    // common real case (a teammate onboarding second) as a dead end.
    const err = new Error((data && data.error) || `Request failed (${res.status})`) as Error & {
      body?: { joinOrgId?: string };
    };
    err.body = data ?? undefined;
    throw err;
  }
  return data as T;
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export default function OnboardPage() {
  const [screen, setScreen] = useState<Screen>("name");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentInvites, setSentInvites] = useState<SentInvite[]>([]);
  /**
   * Whether this visitor may be here at all.
   *
   *   "checking" — asking the server
   *   "ok"       — signed in, no workspace yet: onboarding is for them
   *
   * Anything else redirects. The page used to render for anyone: signed out you
   * could name your company and cross a whole screen before the create call
   * came back "Unauthorized", and an existing member who typed /onboard could
   * quietly create a second workspace beside their real one.
   */
  const [gate, setGate] = useState<"checking" | "ok">("checking");

  const slug = useMemo(() => slugify(company), [company]);

  /**
   * Advance a screen AND push a history entry, so the browser's Back button
   * steps back through onboarding instead of leaving the flow entirely (it used
   * to land on the console, since the screens were pure React state).
   */
  const go = useCallback((next: Screen) => {
    setScreen(next);
    window.history.pushState({ screen: next }, "", `?step=${next}`);
  }, []);

  useEffect(() => {
    // Always start at the first screen: a refresh loses the in-memory org, and
    // the later screens are meaningless without it. Seed history so the very
    // first Back has somewhere to go.
    // Preserve an explicit ?step=checks — that is a real entry point now, not
    // just a position within a flow someone is part-way through.
    const requested = new URLSearchParams(window.location.search).get("step");
    if (requested !== "checks" && requested !== "invite") {
      window.history.replaceState({ screen: "name" }, "", "?step=name");
    }
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { screen?: Screen } | null)?.screen;
      setScreen(s ?? "name");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const token = authToken();
    if (!token) {
      window.location.replace("/");
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { items } = await api<{ items: { orgId: string; name?: string }[] }>("/api/ops/orgs");
        if (!alive) return;
        if (items.length > 0) {
          /**
           * Already in a workspace. Creating a SECOND one by wandering back
           * here is the thing to prevent — but the setup checks are not that.
           * They are the page you need precisely when setup is unfinished, and
           * redirecting unconditionally made them unreachable the moment the
           * workspace existed: nothing else in the product links to them, so
           * "finish this later" meant "never".
           */
          const step = new URLSearchParams(window.location.search).get("step");
          // "invite" is the other real entry point: the workspace settings always offer "Invite agents", long
          // after setup is finished. It was reachable only from inside the first-run flow, so the one way to
          // bring a coding agent in to improve the workspace vanished the moment setup completed.
          if (step === "checks" || step === "invite") {
            const requestedOrg = new URLSearchParams(window.location.search).get("org");
            const selected = items.find((item) => item.orgId === requestedOrg) ?? items[0];
            setOrgId(selected.orgId);
            if (selected.name) setCompany(selected.name);
            setScreen(step);
            setGate("ok");
            return;
          }
          window.location.replace("/");
        } else setGate("ok");
      } catch {
        // Can't tell (401, offline). Send them to the front door, which knows
        // how to sign them in and will route them back here if they need it.
        if (alive) window.location.replace("/");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Default the work domain to the one you signed in from. The server only lets
  // you claim your OWN domain (it compares against the token's `hd` claim), so
  // prefilling it is both the useful default and the only value that can succeed.
  useEffect(() => {
    const t = authToken();
    if (!t) return;
    try {
      const payload = JSON.parse(
        atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      ) as { hd?: string; email?: string };
      const derived = payload.hd || payload.email?.split("@")[1] || "";
      if (derived) setDomain((cur) => cur || derived);
    } catch {
      /* unreadable token — leave the field empty */
    }
  }, []);

  const createOrg = useCallback(async (): Promise<string | null> => {
    if (orgId) return orgId; // already provisioned this session
    setCreating(true);
    setError(null);
    try {
      const { item } = await api<{ item: { orgId: string } }>("/api/ops/orgs", {
        method: "POST",
        body: JSON.stringify({
          name: company,
          slug,
          googleHostedDomain: domain || undefined,
          ...(logo ? { branding: { logoUrl: logo } } : {}),
        }),
      });
      setOrgId(item.orgId);
      return item.orgId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /**
       * The domain is already claimed by another workspace.
       *
       * This is the ordinary case, not an error: the second person from a
       * company signs in and their employer already has a workspace. Sign-in
       * now materialises the membership a claimed domain implies, so the only
       * thing left to do is send them into it.
       */
      const joinOrgId = (e as { body?: { joinOrgId?: string } })?.body?.joinOrgId;
      if (joinOrgId) {
        window.location.replace("/");
        return null;
      }
      /**
       * A workspace with this id already exists.
       *
       * It used to adopt `slug` and carry on — wrong twice. The server creates
       * `org-<slug>`, so every later call targeted an id that does not exist;
       * and "exists" was treated as "mine", so two companies both called Acme
       * meant the second one's wizard drove the first one's workspace until the
       * server refused it with an unexplained 403.
       *
       * Only continue into a workspace you are actually a member of.
       */
      if (/already exists/i.test(msg)) {
        const candidate = slug.startsWith("org-") ? slug : `org-${slug}`;
        try {
          const { items } = await api<{ items: { orgId: string }[] }>("/api/ops/orgs");
          if (items.some((o) => o.orgId === candidate)) {
            setOrgId(candidate);
            return candidate;
          }
        } catch {
          /* fall through to the error below */
        }
        setError(
          `The workspace id "${candidate}" is taken by another company. Try a more specific name.`,
        );
        return null;
      }
      setError(msg);
      return null;
    } finally {
      setCreating(false);
    }
  }, [orgId, company, slug, domain, logo]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-12 text-foreground">
      <main className="w-full max-w-3xl">
        {/* Brand mark — the same checkmark as the favicon / sign-in page. */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <span className="grid size-12 place-items-center rounded-2xl bg-foreground shadow-[0_8px_32px_-8px] shadow-foreground/25 ring-1 ring-foreground/10">
            <svg viewBox="0 0 32 32" className="size-7" fill="none" aria-hidden>
              <path
                d="M9 16.5L14 21.5L23.5 11"
                className="stroke-background"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          {orgId && (
            <span className="text-2xs text-muted-foreground">
              workspace <span className="font-mono text-foreground">{orgId}</span>
            </span>
          )}
        </div>

        {error && (
          <div className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {gate === "checking" && (
          <p className="text-center text-sm text-muted-foreground">Checking your workspace…</p>
        )}

        {gate === "ok" && screen === "name" && (
          <NameScreen
            company={company}
            setCompany={setCompany}
            domain={domain}
            setDomain={setDomain}
            slug={slug}
            logo={logo}
            setLogo={setLogo}
            onContinue={() => go("fork")}
          />
        )}

        {gate === "ok" && screen === "fork" && (
          <ForkScreen
            company={company}
            busy={creating}
            onBack={() => window.history.back()}
            onManual={async () => {
              if (await createOrg()) go("checks");
            }}
            onAgent={async () => {
              if (await createOrg()) go("invite");
            }}
          />
        )}

        {gate === "ok" && screen === "invite" && orgId && (
          <InviteScreen
            orgId={orgId}
            company={company}
            onManual={() => go("checks")}
            onSent={(rows) => {
              setSentInvites(rows);
              go("sent");
            }}
          />
        )}

        {gate === "ok" && screen === "checks" && orgId && (
          <ChecksScreen orgId={orgId} onInviteAgents={() => go("invite")} />
        )}

        {gate === "ok" && screen === "sent" && orgId && (
          <SentScreen orgId={orgId} sent={sentInvites} onConsole={() => go("checks")} />
        )}
      </main>
    </div>
  );
}

/* ------------------------------- Screen 1 -------------------------------- */

function NameScreen({
  company,
  setCompany,
  domain,
  setDomain,
  slug,
  logo,
  setLogo,
  onContinue,
}: {
  company: string;
  setCompany: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  slug: string;
  logo: string | null;
  setLogo: (v: string | null) => void;
  onContinue: () => void;
}) {
  const logoRef = useRef<HTMLInputElement>(null);
  async function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setLogo(await toLogoDataUrl(file));
    } catch {
      /* unreadable image — leave the placeholder */
    }
  }
  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Set up a company</h1>
        <p className="text-sm text-muted-foreground">
          {PRODUCT_NAME} runs one workspace per company — its people, connectors, workflows and {DEPLOYMENT_PROFILE.vocabulary.account.plural}.
        </p>
      </div>
      <div className="mx-auto max-w-md space-y-6">
        {/* Workspace logo — optional, and captured before the org exists, so it
            rides along with the create call. Downscaled to a small data URI. */}
        <div className="flex flex-col items-center gap-2">
          <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={onPickLogo} />
          <button
            type="button"
            onClick={() => logoRef.current?.click()}
            className="group relative grid size-16 place-items-center overflow-hidden rounded-2xl border border-dashed border-border bg-muted/30 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="size-full object-cover" />
            ) : (
              <ImagePlusIcon className="size-5" />
            )}
          </button>
          <span className="text-2xs text-muted-foreground">
            {logo ? "Change logo" : "Add a company logo (optional)"}
          </span>
        </div>
        <label className="block space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Company name</span>
          {/* A generic placeholder: this is the FIRST field a new company fills in,
              and prompting them with another customer's name is a strange
              welcome. */}
          <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Inc." autoFocus />
          {slug && (
            <span className="text-xs text-muted-foreground">
              Workspace id <span className="font-mono text-foreground">{slug}</span>
            </span>
          )}
        </label>
        <label className="block space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Work email domain</span>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" />
          <span className="text-xs text-muted-foreground">
            Anyone signing in from this domain joins this workspace. You can only claim the domain
            you sign in from — clear it to keep the workspace invite-only.
          </span>
        </label>
        <Button className="w-full" disabled={!company.trim()} onClick={onContinue}>
          Continue <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- Screen 2 -------------------------------- */

function ForkScreen({
  company,
  busy,
  onBack,
  onManual,
  onAgent,
}: {
  company: string;
  busy: boolean;
  onBack: () => void;
  onManual: () => void;
  onAgent: () => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Get {company || "your company"} running</h1>
        <p className="text-sm text-muted-foreground">
          Roster, connectors, workflow library, data room, first {DEPLOYMENT_PROFILE.vocabulary.account.singular}. Two ways to get there.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ForkCard
          icon={<TerminalIcon className="size-5" />}
          title="We'll set it up ourselves"
          body="Work through the setup checks in the console — invite admins, import the roster, connect a source."
          disabled={busy}
          onClick={onManual}
        />
        <ForkCard
          icon={<BotIcon className="size-5" />}
          title="Our agents run the recipes"
          badge="~10 min"
          body={`Your coding agents clone the setup recipes ${PRODUCT_NAME} ships and run them against your data room.`}
          disabled={busy}
          onClick={onAgent}
          footer={
            <div className="flex flex-wrap gap-1.5 pt-1">
              {AGENT_CLIENTS.map((c) => (
                <span key={c} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {c}
                </span>
              ))}
              <span
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={AGENT_CLIENTS_MORE.join(" · ")}
              >
                +3
              </span>
            </div>
          }
        />
      </div>
      <div className="text-center">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Change company
        </button>
      </div>
    </div>
  );
}

function ForkCard({
  icon,
  title,
  body,
  badge,
  footer,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string;
  footer?: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-5 text-left transition hover:border-foreground/30 hover:shadow-sm disabled:opacity-60"
    >
      <div className="flex items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted text-foreground">{icon}</span>
        {badge && <span className="text-[11px] font-medium text-muted-foreground">{badge}</span>}
      </div>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
      {footer}
    </button>
  );
}

/* ------------------------------- Screen 3a ------------------------------- */

function InviteScreen({
  orgId,
  company,
  onManual,
  onSent,
}: {
  orgId: string;
  company: string;
  onManual: () => void;
  onSent: (sent: SentInvite[]) => void;
}) {
  const [rows, setRows] = useState<InviteRow[]>([{ email: "", role: "owner" }]);
  const [preview, setPreview] = useState<{
    subject: string;
    roleSentence: string;
    acceptUrl: string;
    loginCommand: string;
    tokenNote?: string;
    mcpEndpoint?: string;
    packageAlternative?: { login: string; claudeCommand: string; note: string };
    mcpConfig: string;
    mcpSetup: { client: string; path: string; snippet: string; note?: string }[];
    agentPrompt: string;
    skillCommand: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvNote, setCsvNote] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [mcpClient, setMcpClient] = useState("Claude Code");
  /**
   * What to show before the server's preview arrives: the SAME strings, built
   * from the address this page was loaded from. These fallbacks used to be
   * literals naming one product's production address and a package with no
   * address at all — correct on exactly one deployment of this codebase.
   */
  const [pageOrigin, setPageOrigin] = useState("");
  useEffect(() => setPageOrigin(window.location.origin), []);
  const connect = useMemo(() => mcpConnect({ origin: pageOrigin, productName: PRODUCT_NAME }), [pageOrigin]);
  const copyPrompt = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the text is selectable in the box */
    }
  }, []);

  const filled = rows.filter((r) => r.email.trim());
  // Validate here rather than letting the server's zod reject the whole batch
  // with one message that doesn't say which row was wrong.
  const badRows = filled.filter((r) => !EMAIL_RE.test(r.email.trim()));
  const dupes = filled
    .map((r) => r.email.trim().toLowerCase())
    .filter((e, i, all) => all.indexOf(e) !== i);

  /**
   * Load the preview regardless of whether anyone has been added.
   *
   * It used to bail when there was no filled row, so on arrival — the state
   * everyone starts in — step 4 sat on "Loading the setup prompt…" forever
   * while steps 1-3 rendered their fallbacks. The prompt depends on the
   * workspace and role, not on the recipient, so there is nothing to wait for.
   */
  const previewRole = filled[0]?.role ?? rows[0]?.role ?? "owner";
  const previewEmail = filled[0]?.email ?? "someone@example.com";
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api<{ preview: NonNullable<typeof preview> }>(`/api/ops/orgs/${orgId}/invites`, {
        method: "POST",
        body: JSON.stringify({ rows: [{ email: previewEmail, role: previewRole }], preview: true }),
      })
        .then((r) => !cancelled && setPreview(r.preview))
        .catch(() => !cancelled && setPreview(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [orgId, previewRole, previewEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(i: number, patch: Partial<InviteRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { email: "", role: "engineer" }]);
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }
  const MAX_ROWS = 200; // matches the API's per-request cap
  function onCsv(file: File) {
    setCsvNote(null);
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const parsed: InviteRow[] = lines
        .map((l) => {
          const [email, role] = l.split(",").map((x) => x.trim());
          const r = (["owner", "admin", "engineer", "member"] as Role[]).includes(role as Role) ? (role as Role) : "member";
          return { email: (email ?? "").toLowerCase(), role: r };
        })
        .filter((r) => r.email && r.email.includes("@"));

      // MERGE with what is already typed rather than replacing it. Replacing
      // silently discarded rows someone had just entered by hand.
      const existing = rows.filter((r) => r.email.trim());
      const seen = new Set(existing.map((r) => r.email.trim().toLowerCase()));
      const fresh = parsed.filter((r) => !seen.has(r.email) && (seen.add(r.email), true));
      const merged = [...existing, ...fresh].slice(0, MAX_ROWS);

      const skipped = lines.length - parsed.length;
      const dropped = existing.length + fresh.length - merged.length;
      setRows(merged.length ? merged : [{ email: "", role: "owner" }]);
      // Say what happened. Silence after an upload reads as "nothing worked".
      setCsvNote(
        [
          `${fresh.length} added`,
          skipped > 0 ? `${skipped} line${skipped === 1 ? "" : "s"} skipped (no email address)` : null,
          parsed.length - fresh.length > 0 ? `${parsed.length - fresh.length} already listed` : null,
          dropped > 0 ? `${dropped} over the ${MAX_ROWS} limit` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    };
    reader.readAsText(file);
  }

  async function send() {
    if (!filled.length || badRows.length || dupes.length) return;
    setSending(true);
    setError(null);
    try {
      const res = await api<{
        sent: SentInvite[];
        results?: { email: string; status: string; reason?: string }[];
        failed?: number;
      }>(`/api/ops/orgs/${orgId}/invites`, { method: "POST", body: JSON.stringify({ rows: filled }) });
      // Partial failures used to be invisible: the API returned one 500 for the
      // whole batch even when most rows had been created and emailed. Name the
      // ones that didn't make it and keep the rest.
      const bad = (res.results ?? []).filter((r) => r.status === "failed");
      if (bad.length) {
        setError(
          `${bad.length} of ${filled.length} couldn't be sent: ` +
            bad.map((b) => `${b.email} (${b.reason ?? "unknown"})`).join(", "),
        );
      }
      const members = (res.results ?? []).filter((r) => r.status === "already-member");
      if (members.length && !bad.length) {
        setError(`${members.map((m) => m.email).join(", ")} ${members.length === 1 ? "is" : "are"} already in this workspace — no email sent.`);
      }
      if (res.sent.length) onSent(res.sent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Invite the people who&apos;ll run it</h1>
      </div>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/*
        The people are a COUNT plus an inline disclosure, not a permanently-open form.
        A stack of empty inputs occupied the top of the screen whether or not
        anyone was being added, and pushed the thing that actually needs reading
        — the email everyone receives — below the fold.
      */}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2.5">
            <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm">
              {filled.length === 0 ? (
                <span className="text-muted-foreground">No one added yet</span>
              ) : (
                <>
                  {filled.length} {filled.length === 1 ? "person" : "people"}
                  <span className="text-muted-foreground">
                    {" · "}
                    {filled
                      .slice(0, 2)
                      .map((r) => r.email.trim())
                      .join(", ")}
                    {filled.length > 2 ? ` +${filled.length - 2}` : ""}
                  </span>
                </>
              )}
            </span>
          </span>
          {editorOpen ? (
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <UploadIcon className="size-3.5" />
                {csvNote ?? "Import a CSV"}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && onCsv(e.target.files[0])}
                />
              </label>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setEditorOpen(true)}>
              {filled.length ? "Edit" : "Add people"}
            </Button>
          )}
        </div>
        {editorOpen && (
          <PeopleEditor rows={rows} update={update} addRow={addRow} removeRow={removeRow} />
        )}
        {!editorOpen && (badRows.length > 0 || dupes.length > 0) && (
          <div className="border-t border-border bg-destructive/5 px-4 py-2 text-xs text-destructive">
            {badRows.length > 0 && (
              <div>
                {badRows.length === 1 ? "Not an email address" : "Not email addresses"}:{" "}
                {badRows.map((r) => r.email.trim()).join(", ")}
              </div>
            )}
            {dupes.length > 0 && <div>Listed twice: {[...new Set(dupes)].join(", ")}</div>}
          </div>
        )}
      </div>


      {/*
        A specimen of the email, not a mock email client.
        
        It used to render fake mail chrome — "To …" with a bare ellipsis before
        anyone was added, a subject line crammed beside it with no truncation,
        and a primary-coloured "Open setup" button that looked clickable and
        wasn't. It also addressed one person while the footer promised the same
        message to everyone. It now says what it is, states who receives it, and
        makes its inert parts visibly inert.
      */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <header className="border-b border-border bg-muted/30 px-4 py-2.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Email preview
          </span>
        </header>

        <dl className="border-b border-border text-sm">
          <div className="flex items-baseline gap-3 px-4 py-2">
            <dt className="w-14 shrink-0 text-xs text-muted-foreground">To</dt>
            <dd className="min-w-0 flex-1 truncate text-xs">
              {filled.length === 0 ? (
                <span className="text-muted-foreground/70">the people you add above</span>
              ) : filled.length === 1 ? (
                filled[0].email
              ) : (
                <>
                  {filled[0].email}
                  <span className="text-muted-foreground"> and {filled.length - 1} other{filled.length === 2 ? "" : "s"}</span>
                </>
              )}
            </dd>
          </div>
          <div className="flex items-baseline gap-3 px-4 py-2">
            <dt className="w-14 shrink-0 text-xs text-muted-foreground">Subject</dt>
            <dd className="min-w-0 flex-1 truncate text-xs">
              {preview?.subject || `Set up ${company} on ${PRODUCT_NAME}`}
            </dd>
          </div>
        </dl>

        {/* Inert: a rendering of the message, not the message. */}
        <div className="space-y-4 px-4 py-4 text-sm">
          <p className="leading-relaxed">
            {preview?.roleSentence || `You've been added to ${company} on ${PRODUCT_NAME}.`}
          </p>

          <ol className="space-y-3.5">
            <EmailStep n={1} title="Accept the invite and sign in">
              <span className="break-all font-mono text-xs text-muted-foreground">
                {preview?.acceptUrl ?? `${pageOrigin}/?invite=dlv_inv_******`}
              </span>
            </EmailStep>

            <EmailStep n={2} title="Get your access token">
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed">
                {preview?.loginCommand ?? `${connect.tokenCommands.request}\n${connect.tokenCommands.verify}`}
              </pre>
              <p className="mt-1 text-2xs text-muted-foreground">{preview?.tokenNote ?? connect.tokenNote}</p>
            </EmailStep>

            <EmailStep n={3} title="Wire your coding agent">
              {/* One config per client. These are NOT interchangeable: VS Code
                  keys on `servers`, Codex reads TOML — the old single JSON
                  block was unusable in half the clients we name. */}
              <div className="mb-2 flex flex-wrap gap-1">
                {(preview?.mcpSetup ?? connect.clients).map((m) => {
                  const Icon = CLIENT_ICONS[m.client] ?? TerminalIcon;
                  return (
                    <button
                      key={m.client}
                      type="button"
                      onClick={() => setMcpClient(m.client)}
                      className={
                        m.client === mcpClient
                          ? "flex items-center gap-1.5 rounded border border-foreground/30 bg-accent px-2 py-1 text-2xs font-medium"
                          : "flex items-center gap-1.5 rounded border border-border px-2 py-1 text-2xs text-muted-foreground hover:text-foreground"
                      }
                    >
                      <Icon className="size-3.5 shrink-0" />
                      {m.client}
                    </button>
                  );
                })}
              </div>
              {(() => {
                const list = preview?.mcpSetup ?? connect.clients;
                const active = list.find((m) => m.client === mcpClient) ?? list[0];
                const alt = preview?.packageAlternative ?? connect.packageAlternative;
                return (
                  <>
                    <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed">
                      {active.snippet}
                    </pre>
                    {/* Three separate facts, so they get three sentences. They
                        were concatenated into one run-on: "…writes the config
                        for you Restart the agent after." */}
                    <p className="mt-1 text-2xs text-muted-foreground">
                      {active.path}. {active.note ? `${active.note} ` : ""}Put the token from step 2 where it says{" "}
                      <span className="font-mono">&lt;token&gt;</span>, then restart the agent. This connects to{" "}
                      <span className="font-mono">{preview?.mcpEndpoint ?? connect.endpoint}</span> — this
                      workspace&apos;s own address, nothing to install.
                    </p>
                    <details className="mt-2 text-2xs text-muted-foreground">
                      <summary className="cursor-pointer hover:text-foreground">Use the npm package instead</summary>
                      <p className="mt-1">{alt.note}</p>
                      <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-2xs leading-relaxed">
                        {`${alt.login}\n${alt.claudeCommand}`}
                      </pre>
                    </details>
                  </>
                );
              })()}
            </EmailStep>

            {/* When a public skill source is configured the procedure installs
                itself, so the invitee gets a one-line trigger instead of an
                essay to paste. Falls back to the inline steps otherwise —
                never render an install command that would 404. */}
            <EmailStep n={4} title="Install the setup skill">
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-xs">
                {preview?.skillCommand ?? "npx @delivery-agents/cli install-skill"}
              </pre>
              <p className="mt-1 text-2xs text-muted-foreground">
                A published, versioned npm package. Installs into whichever
                agent it finds: Claude Code, Cursor, VS Code or Codex. Add{" "}
                <span className="font-mono">-g</span> for every project rather than just
                this one. Their agent then knows the whole procedure, so there is nothing
                to paste.
              </p>
            </EmailStep>

            <EmailStep n={5} title="Begin work — say this to your agent">
              <div className="relative">
                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/60 px-3 py-2.5 pr-16 font-mono text-2xs leading-relaxed">
                  {preview?.agentPrompt ?? "Loading the setup prompt…"}
                </pre>
                <button
                  type="button"
                  onClick={() => copyPrompt(preview?.agentPrompt ?? "")}
                  disabled={!preview?.agentPrompt}
                  className="absolute right-2 top-2 rounded border border-border bg-background px-2 py-1 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {promptCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </EmailStep>
          </ol>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-5">
        <Button variant="ghost" size="sm" onClick={onManual}>
          Do it by hand <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button disabled={!filled.length || !!badRows.length || !!dupes.length || sending} onClick={send}>
          {sending ? "Sending…" : "Send invites"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The people editor — inline, inside the count card.
 *
 * It was briefly a dialog. That was worse: adding people is the primary act of
 * this screen, and putting the primary act behind a modal means opening
 * something to do the thing you came to do, then closing it to see whether it
 * worked. It expands in place instead, so the count above it updates as you
 * type. Import sits at the bottom — the alternative to typing, not the first
 * thing to reach for.
 */
function PeopleEditor({
  rows,
  update,
  addRow,
  removeRow,
}: {
  rows: InviteRow[];
  update: (i: number, patch: Partial<InviteRow>) => void;
  addRow: () => void;
  removeRow: (i: number) => void;
}) {
  return (
    <div className="space-y-3 border-t border-border bg-muted/10 px-4 py-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1 pb-0.5">
          <span className="flex-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Email address
          </span>
          <span className="w-[7.5rem] text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Role
          </span>
          {rows.length > 1 && <span className="w-6" aria-hidden="true" />}
        </div>

        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={row.email}
              onChange={(e) => update(i, { email: e.target.value })}
              placeholder="name@company.com"
              aria-invalid={row.email.trim() !== "" && !EMAIL_RE.test(row.email.trim())}
              className="flex-1 aria-[invalid=true]:border-destructive/60"
            />
            <select
              value={row.role}
              onChange={(e) => update(i, { role: e.target.value as Role })}
              className="h-9 w-[7.5rem] rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="engineer">Engineer</option>
              <option value="member">Member</option>
            </select>
            {rows.length > 1 && (
              <button
                onClick={() => removeRow(i)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Remove ${row.email.trim() || "this person"}`}
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
        ))}

        <button
          onClick={addRow}
          className="inline-flex items-center gap-1 pt-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <PlusIcon className="size-3.5" /> Add another person
        </button>
      </div>
    </div>
  );
}

/**
 * Which glyph fronts each MCP client.
 *
 * Lucide, not brand logos: the page's CSP blocks external assets, so a real
 * mark would have to be inlined by hand — and an approximated logo reads as a
 * wrong logo. These say what KIND of tool it is, which is the distinction that
 * matters when you are picking your own.
 */
const CLIENT_ICONS: Record<string, typeof TerminalIcon> = {
  "Claude Code": TerminalIcon,
  Cursor: MousePointer2Icon,
  "VS Code": FileCodeIcon,
  "Codex CLI": SquareTerminalIcon,
};

/** One numbered step in the email preview. */
function EmailStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-xs font-medium">{title}</div>
        {children}
      </div>
    </li>
  );
}

/* ------------------------------- Screen 3b ------------------------------- */

function ChecksScreen({ orgId, onInviteAgents }: { orgId: string; onInviteAgents: () => void }) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [ready, setReady] = useState(false);
  // Distinguish "nothing has changed" from "I cannot reach the server". They
  // looked identical before: the poll swallowed every error and kept the last
  // state, so a workspace that had gone unreachable rendered as one making no
  // progress, indefinitely.
  const [stale, setStale] = useState(false);

  const poll = useCallback(async () => {
    try {
      const r = await api<{ ready: boolean; checks: HealthCheck[] }>(`/api/ops/orgs/${orgId}/health`);
      setChecks(r.checks);
      setReady(r.ready);
      setStale(false);
      return r.ready;
    } catch {
      setStale(true);
      return false;
    }
  }, [orgId]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    // Stop once ready. The old fixed 8s interval ran forever, polling a
    // workspace whose checks had all passed for as long as the tab stayed open.
    const tick = async () => {
      const done = await poll();
      if (stop || done) return;
      timer = setTimeout(tick, 8000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [poll]);

  const loading = checks === null;

  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Setup checks</h1>
        <p className="text-sm text-muted-foreground">
          Each one turns green when {PRODUCT_NAME} can verify it — never on your say-so.
        </p>
      </div>

      {stale && !loading && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Couldn&apos;t refresh these just now — showing the last known state. Retrying…
        </div>
      )}

      {ready && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          This workspace is ready.
        </div>
      )}

      {loading ? (
        // A skeleton, not fake rows. The placeholder list rendered six real
        // looking unchecked items captioned "loading…", which is indistinguishable
        // from six checks that genuinely failed.
        <ol className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <span className="size-6 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/5 animate-pulse rounded bg-muted/60" />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="space-y-2">
          {checks!.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <span
                className={
                  c.ok
                    ? "flex size-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground"
                }
                title={c.unverifiable ? `Can't be verified in this ${W.install}` : undefined}
              >
                {c.ok ? (
                  <CheckIcon className="size-3.5" />
                ) : c.unverifiable ? (
                  <MinusIcon className="size-3.5" />
                ) : (
                  <CircleDashedIcon className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-xs text-muted-foreground">{c.detail}</div>
              </div>
              {!c.ok && (
                <a
                  href={c.deepLink}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                >
                  Set up →
                </a>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* The screen had no exit at all: finishing setup left you here, with
          "Invite agents instead" as the only control on the page. */}
      <div className="space-y-3">
        <Button className="w-full" onClick={() => { window.location.href = "/workspace"; }}>
          {ready ? "Enter workspace" : "Go to workspace — finish these later"}
        </Button>
        <div className="text-center text-xs text-muted-foreground">
          Any check can be handed to an agent instead — the recipes are the same steps.{" "}
          <button onClick={onInviteAgents} className="text-foreground underline-offset-2 hover:underline">
            Invite agents instead →
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Sent ----------------------------------- */

function SentScreen({
  orgId,
  sent,
  onConsole,
}: {
  orgId: string;
  sent: SentInvite[];
  onConsole: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const delivered = sent.filter((s) => s.delivered);
  const undelivered = sent.filter((s) => !s.delivered);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch {
      /* clipboard blocked — the link is selectable on screen either way */
    }
  }

  const allLinks = sent.map((s) => `${s.email}\t${s.url}`).join("\n");

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="space-y-2 text-center">
        <span
          className={
            undelivered.length
              ? "mx-auto flex size-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          }
        >
          {undelivered.length ? <LinkIcon className="size-6" /> : <CheckIcon className="size-6" />}
        </span>
        <h1 className="text-xl font-semibold tracking-tight">
          {/* Say what happened. This screen used to read "Setup emails sent"
              unconditionally — including when no mail channel existed and
              nothing had been sent to anyone. */}
          {undelivered.length === 0
            ? `${delivered.length} invite${delivered.length === 1 ? "" : "s"} sent`
            : delivered.length === 0
              ? "Invites created — send these links yourself"
              : `${delivered.length} sent, ${undelivered.length} need a link`}
        </h1>
        <p className="text-sm text-muted-foreground">
          {undelivered.length === 0
            ? "Everyone got the same message, generated from the workspace. As their agents run the recipes, the checks turn green."
            : "This platform has no mail channel configured, so these invites could not be delivered for you. Each link below signs its person in and joins them to the workspace. They expire in 14 days."}
        </p>
      </div>

      {undelivered.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
          Copy these now. Only a hash of each token is stored, so the links cannot be shown again
          — if you lose one, invite that person a second time.
        </div>
      )}

      <ul className="space-y-2">
        {sent.map((row) => (
          <li key={row.email} className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-sm font-medium">{row.email}</span>
              <span className="text-2xs uppercase tracking-wide text-muted-foreground">{row.role}</span>
              {row.delivered ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckIcon className="size-3.5" /> {row.via === "slack" ? "Slack" : "Emailed"}
                </span>
              ) : (
                <button
                  onClick={() => copy(row.url, row.email)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  <LinkIcon className="size-3.5" />
                  {copied === row.email ? "Copied" : "Copy link"}
                </button>
              )}
            </div>
            {!row.delivered && (
              <>
                <p className="mt-1 truncate font-mono text-2xs text-muted-foreground" title={row.url}>
                  {row.url}
                </p>
                {row.reason && <p className="mt-1 text-2xs text-muted-foreground">{row.reason}</p>}
              </>
            )}
          </li>
        ))}
      </ul>

      {undelivered.length > 1 && (
        <button
          onClick={() => copy(allLinks, "__all__")}
          className="w-full rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        >
          {copied === "__all__" ? "Copied all links" : "Copy every link (email + URL, one per line)"}
        </button>
      )}

      <Button className="w-full" onClick={onConsole}>
        Open the checklist <ArrowRightIcon className="size-4" />
      </Button>
      <p className="text-center text-xs text-muted-foreground">workspace {orgId}</p>
    </div>
  );
}
