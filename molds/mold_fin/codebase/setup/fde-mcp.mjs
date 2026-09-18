#!/usr/bin/env node
/**
 * fde-mcp — one stdio MCP server that lets a LOCAL coding agent set up the whole
 * FDE control plane in the live web app: the Data Room, Connectors, Workflows,
 * and Crons.
 *
 *   node --experimental-strip-types setup/fde-mcp.mjs
 *
 * Two backends, both pointing at production:
 *   - Data Room  → the private Vercel Blob store (BLOB_READ_WRITE_TOKEN), the
 *                  SAME store the deployed agent reads.
 *   - Connectors / Workflows / Crons → the Ops Center HTTP API at FDE_OPS_URL
 *                  (default https://fde-agent.vercel.app), the SAME endpoints the
 *                  web modal uses. So "set up by a local agent" and "set up in the
 *                  browser" write to exactly the same place.
 *
 * It speaks newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio transport) and
 * needs no MCP SDK. Point Claude Code at it (see setup/README.md §2).
 *
 * Config (env):
 *   BLOB_READ_WRITE_TOKEN   required for the Data Room tools (private blob store)
 *   FDE_OPS_URL             Ops API base; default https://fde-agent.vercel.app
 *   FDE_ACTOR              audit label written on every create/update/delete;
 *                          default "local-agent"
 *
 * Security: this is DIRECT write access to production. The Ops API CRUD is
 * unauthenticated by design (the browser modal is SSO-gated; the API is open),
 * so anything with FDE_OPS_URL can write it — give this to trusted machines only.
 * `record_coding_session` redacts before landing; raw `dataroom_write` does NOT.
 */
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";

/**
 * The Data Room tools live in the platform repo (TypeScript, loaded via
 * --experimental-strip-types). When this CLI is installed standalone from npm
 * those files are not present, so the imports are OPTIONAL: without them the
 * server still starts and serves the Connector / Workflow / Cron tools, which
 * need nothing but your `fde-login` identity. Previously these were hard
 * top-level imports, which crashed the server outright outside the repo.
 */
const dataroomLib = await import("../agent/lib/dataroom-store.ts").catch(() => null);
const sessionsLib = await import("../agent/lib/coding-sessions.ts").catch(() => null);
const createDataroomStore = dataroomLib?.createDataroomStore ?? null;
const parseClaudeTranscript = sessionsLib?.parseClaudeTranscript ?? null;
const sessionToSyncItem = sessionsLib?.sessionToSyncItem ?? null;
/** True when the data-room half of the toolset is available. */
const DATAROOM_AVAILABLE = Boolean(createDataroomStore);
const { CRED_PATH } = await import("./fde-login.mjs").catch(() => ({ CRED_PATH: null }));
import { readFile as readPkgFile } from "node:fs/promises";

const OPS_URL = (process.env.FDE_OPS_URL ?? "https://fde-agent.vercel.app").replace(/\/$/, "");
const ACTOR = process.env.FDE_ACTOR ?? "local-agent";
// How the Ops API knows who you are: your per-user Google identity from
// `fde-login` (see fde-login.mjs). There is no service-key fallback — run the
// login first. The Data Room tools use the blob token instead and need no login.
const OAUTH_CLIENT_ID =
  process.env.FDE_OAUTH_CLIENT_ID ??
  "000000000000-example.apps.googleusercontent.com";
// Baked-in desktop-client secret — non-confidential by design (see fde-login.mjs).
const OAUTH_CLIENT_SECRET =
  process.env.FDE_OAUTH_CLIENT_SECRET ?? "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";

/**
 * A live @onfinance.in ID token from the stored login, or null. Cached in memory
 * and refreshed a minute before it expires, so most calls pay nothing.
 */
let cachedIdToken = null;
let cachedExp = 0;
async function userIdToken() {
  const now = Date.now() / 1000;
  if (cachedIdToken && cachedExp - now > 60) return cachedIdToken;
  let creds;
  try {
    creds = JSON.parse(await readFile(CRED_PATH, "utf8"));
  } catch {
    return null;
  }
  const stored = creds.id_token;
  const exp = stored ? JSON.parse(Buffer.from(stored.split(".")[1], "base64url").toString()).exp : 0;
  if (stored && exp - now > 60) {
    cachedIdToken = stored;
    cachedExp = exp;
    return stored;
  }
  // Refresh. Google requires the client secret even for desktop refresh.
  if (!creds.refresh_token || !OAUTH_CLIENT_SECRET) return stored ?? null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.id_token) return stored ?? null;
  cachedIdToken = t.id_token;
  cachedExp = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).exp;
  await writeFile(CRED_PATH, JSON.stringify({ ...creds, id_token: t.id_token }, null, 2), {
    mode: 0o600,
  }).catch(() => {});
  return cachedIdToken;
}

/** The bearer for an Ops API call: your Google identity. Null if not logged in. */
async function opsBearer() {
  return await userIdToken();
}
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN) && DATAROOM_AVAILABLE;
/**
 * The blob store for the SELECTED workspace — rebuilt when the selection
 * changes, never cached across it.
 *
 * This was `createDataroomStore()` with no argument, which is the legacy-root
 * tree: workspace #1's. So with a blob token set, every data-room write landed
 * in workspace #1 no matter which workspace was selected, while the Ops API
 * calls beside them went to the right one. Half a session in the right place
 * is worse than none, because the customer records look correct and the
 * documents are quietly somewhere else.
 */
let storeOrg;
let storeCached = null;
function currentStore() {
  if (!hasBlob) return null;
  if (storeCached && storeOrg === OPS_ORG) return storeCached;
  storeOrg = OPS_ORG;
  storeCached = createDataroomStore({ orgId: OPS_ORG ?? undefined });
  return storeCached;
}
const backend = hasBlob ? "vercel-blob" : "none";

// ------------------------------------------------------------ HTTP to the Ops API

/**
 * The workspace every Ops call is aimed at, when you name one.
 *
 * Without this the target was implicit: the server resolves an org from your
 * identity, so which workspace you wrote to depended on account state you
 * cannot see from here. That is fine with one workspace and unacceptable with
 * two — seeding a demo workspace must not be one wrong resolution away from
 * writing into a live one. `FDE_ORG=org-acme` makes it explicit and is
 * re-checked server-side against your membership, so it targets, never grants.
 */
let OPS_ORG = process.env.FDE_ORG?.trim() || null;

async function api(method, path, body) {
  const bearer = await opsBearer();
  if (!bearer) {
    throw new Error(
      "Not signed in. Ask the user to run `npx -p @delivery-agents/cli fde-login` in a terminal" +
        " (an interactive browser sign-in you cannot do yourself), then retry.",
    );
  }
  const res = await fetch(`${OPS_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(OPS_ORG ? { "x-ops-org": OPS_ORG } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status} from ${path}`);
  return parsed;
}

/** The Data Room tools require the REAL blob store, not the local-dir fallback. */
function requireBlob() {
  const store = currentStore();
  if (!store || backend !== "vercel-blob") {
    throw new Error(
      "Data Room tools need BLOB_READ_WRITE_TOKEN set to the production blob store." +
        " Without it these would write a local folder, not the live data room.",
    );
  }
  return store;
}

/**
 * The data room, reachable two ways:
 *   - the Ops API under your `fde-login` identity (the default — works from a
 *     plain npm install, keeps the production blob token off your machine, and
 *     is org-scoped + audited server-side);
 *   - the blob store directly, when you're inside the platform repo WITH
 *     BLOB_READ_WRITE_TOKEN set (faster, and what the deployed agent uses).
 *
 * Without this the data-room tools were repo-only, so the published CLI could
 * not configure a data room at all.
 */

/**
 * The workspace these tools act on.
 *
 * NOT simply `items[0]`: a platform admin's /api/ops/orgs lists EVERY workspace,
 * so the first row can belong to someone else entirely — inviting into it would
 * be a cross-tenant mistake. Prefer the org whose id matches the signed-in
 * user's own email domain, and only fall back to the single row when there is
 * exactly one.
 */
async function myWorkspace() {
  const { items = [] } = await api("GET", "/api/ops/orgs");
  // An explicit FDE_ORG settles it — including the "ambiguous, say which one"
  // case below, which otherwise has no answer you can give from a config file.
  if (OPS_ORG) {
    const named = items.find((o) => o.orgId === OPS_ORG);
    if (named) return named;
    throw new Error(`FDE_ORG=${OPS_ORG} is not a workspace you belong to.`);
  }
  if (items.length === 0) {
    throw new Error(`No workspace yet. Open ${OPS_URL}/onboard in a browser to create one.`);
  }
  if (items.length === 1) return items[0];
  const email = (await whoami())?.email ?? "";
  const domain = email.split("@")[1]?.split(".")[0]?.toLowerCase();
  const mine = domain && items.find((o) => o.orgId.toLowerCase().includes(domain));
  if (mine) return mine;
  throw new Error(
    `You can see ${items.length} workspaces (${items.map((o) => o.orgId).join(", ")}). ` +
      "Ambiguous — say which one you mean.",
  );
}

/** Claims from the current ID token, or null when signed out. */
async function whoami() {
  const token = await userIdToken();
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

/* ---------------------------- approval protocol --------------------------- *
 * Two holes the trial runs found in preview→confirm, both worth closing.
 *
 * 1. NOTHING BOUND THE CONFIRM TO THE PREVIEW. `confirm:true` re-sent the whole
 *    payload, so the content written need not be the content shown. An agent
 *    could preview one thing, be approved, and write another — not maliciously,
 *    just by regenerating the body between calls — and the audit trail would
 *    record an approved write either way. A protocol whose entire purpose is
 *    trust cannot leave that open. Preview now returns a token over the exact
 *    bytes; confirm must present it, and a mismatch is refused.
 *
 * 2. THERE WAS NO HONEST PATH THROUGH A HEADLESS RUN. Every preview ended "show
 *    this to the human and wait", and in an unattended session there is nobody
 *    to wait for. Both trial agents did the same reasonable thing — proceeded on
 *    a standing instruction — and both flagged that the approval step had been
 *    structurally unavailable rather than satisfied. So make that state
 *    declarable instead of forcing a polite fiction: `approvedBy` records WHO
 *    stood behind the write, and an unattended run must say so explicitly and is
 *    audited as unattended. The trail can then distinguish "a person approved
 *    this" from "an agent proceeded on standing instructions", which is the
 *    distinction that actually matters when someone reads it back later.
 */
import { createHash } from "node:crypto";

/** A short token over exactly what was shown. */
function approvalToken(path, body) {
  return createHash("sha256").update(`${path}\n${body}`).digest("hex").slice(0, 16);
}

/**
 * Decide whether a confirmed write may proceed.
 * Returns null when it may, or an object to return to the caller when it may not.
 */
function checkApproval({ path, body, previewToken, approvedBy }) {
  const expected = approvalToken(path, body);
  if (previewToken && previewToken !== expected) {
    return {
      wrote: false,
      refused: "content-changed",
      detail:
        "This is not the content that was previewed and approved. Preview it again and get approval for what you actually intend to write.",
      expected,
      got: previewToken,
    };
  }
  if (!approvedBy) {
    return {
      wrote: false,
      refused: "no-approval-recorded",
      detail:
        "Say who approved this. Pass `approvedBy` with the name or email of the person who said yes. " +
        "If there is no human in this session, pass approvedBy: 'unattended:<the standing instruction you are acting on>' — " +
        "that is allowed, and it is recorded as unattended so the trail never implies someone reviewed it.",
    };
  }
  return null;
}

/** How the approval reads in the audit trail. */
const approvalNote = (approvedBy) =>
  approvedBy.startsWith("unattended:")
    ? `UNATTENDED (${approvedBy.slice("unattended:".length).trim() || "no reason given"})`
    : `approved by ${approvedBy}`;

/** Fold the agent's stated reason + citations into the write request. */
function cite({ rationale, sources, changesetId } = {}) {
  const note = [rationale, sources?.length ? `sources: ${sources.join(", ")}` : null]
    .filter(Boolean)
    .join(" · ");
  return { ...(note ? { rationale: note.slice(0, 500) } : {}), ...(changesetId ? { changesetId } : {}) };
}

const dataroom = {
  via: hasBlob ? "blob" : "ops-api",
  async list(prefix = "") {
    if (hasBlob) return await requireBlob().list(prefix);
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    return (await api("GET", `/api/ops/dataroom${q}`)).paths ?? [];
  },
  async read(path) {
    if (hasBlob) return await requireBlob().read(path);
    const r = await api("GET", `/api/ops/dataroom?path=${encodeURIComponent(path)}`);
    if (!r.found) return null;
    return r.content ?? JSON.stringify(r.records ?? [], null, 2);
  },
  async readJsonl(path) {
    if (hasBlob) return await requireBlob().readJsonl(path);
    const r = await api("GET", `/api/ops/dataroom?path=${encodeURIComponent(path)}`);
    return r.found ? (r.records ?? []) : [];
  },
  // `meta` (rationale + sources) rides along so the server audit records WHY a
  // file changed and where the content came from, not just that it changed.
  async write(path, content, meta = {}) {
    if (hasBlob) return await requireBlob().write(path, content);
    await api("POST", "/api/ops/dataroom", { path, content, ...cite(meta) });
  },
  async appendJsonl(path, records, meta = {}) {
    if (hasBlob) return await requireBlob().appendJsonl(path, records);
    const body = records.map((r) => JSON.stringify(r)).join("\n");
    await api("POST", "/api/ops/dataroom", { path, content: body, append: true, ...cite(meta) });
    return records.length;
  },
};

const json = (v) => JSON.stringify(v, null, 2);

/** The eve subagents the orchestrator can delegate to. */
const SUBAGENT_IDS = [
  "research", "customer-context", "configuration", "deployment", "data-migration",
  "evals", "workflow-author", "app-author", "follow-ups", "browser",
  "hfc-kpi-extraction", "lodr-filings", "investor-presentations", "annual-report-format",
];

// -------------------------------------------------------------------- the tools

const TOOLS = [
  // ---------------------------------------------------------------- Orientation
  {
    name: "workspace_list",
    description:
      "List the workspaces you belong to and show which one these tools are currently writing to. Call this FIRST whenever you belong to more than one — every customer, data-room and workflow write goes to the selected workspace, and writing demo data into a live workspace is not undoable.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      // The SERVER says which workspace is active — asking it is the only way
      // to be sure this matches where writes actually land.
      const { memberships = [], active: serverActive } = await api("GET", "/api/ops/me/workspaces");
      const active = OPS_ORG ?? serverActive ?? memberships[0]?.orgId ?? null;
      return json({
        selected: active,
        selectedVia: OPS_ORG ? "FDE_ORG (this session)" : "your retained choice, shared with the web app",
        workspaces: memberships.map((m) => ({
          orgId: m.orgId,
          name: m.name,
          role: m.role,
          current: m.orgId === active,
        })),
        note: "workspace_use switches it and the choice is remembered — the web app switcher and the deployed agent follow the same setting.",
      });
    },
  },
  {
    name: "workspace_use",
    description:
      "Switch which workspace these tools write to, and REMEMBER it. The choice is stored server-side on your membership, so the web app's switcher and the deployed agent land in the same place — there is one selected workspace per person, not one per client. Rejected unless you are a member.",
    inputSchema: {
      type: "object",
      properties: { orgId: { type: "string", description: "Workspace id, e.g. 'org-example-ai'. See workspace_list." } },
      required: ["orgId"],
    },
    handler: async ({ orgId }) => {
      // Server-side, so it outlives this process and is shared with the web
      // app. A local file would drift from what the UI shows, which is the
      // exact confusion this is meant to remove.
      await api("POST", "/api/ops/me/workspaces/active", { orgId });
      OPS_ORG = orgId;
      const { memberships = [] } = await api("GET", "/api/ops/me/workspaces");
      const m = memberships.find((x) => x.orgId === orgId);
      return json({
        selected: orgId,
        name: m?.name ?? orgId,
        role: m?.role ?? null,
        remembered: true,
        appliesTo: "these MCP tools, the web app switcher, and the deployed agent",
      });
    },
  },
  {
    name: "fde_status",
    description:
      "START HERE. Who you are signed in as, which workspace you're operating on, what's already set up (connectors/workflows/crons), and the concrete next steps. Call this before anything else — every other tool depends on the identity and workspace it reports.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const out = {
        signedIn: false,
        identity: null,
        workspace: null,
        dataRoom: hasBlob ? "ready (direct blob)" : "ready (via Ops API, as you)",
        opsApi: OPS_URL,
        contents: null,
        nextSteps: [],
      };

      // Identity comes from the stored fde-login session.
      const token = await userIdToken();
      if (!token) {
        out.nextSteps.push(
          "Not signed in. Run `npx -p @delivery-agents/cli fde-login` in a terminal, then call fde_status again.",
        );
        return json(out);
      }
      try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        out.signedIn = true;
        out.identity = { email: claims.email ?? "unknown", domain: claims.hd ?? null };
      } catch {
        out.identity = { email: "unknown", domain: null };
      }

      // Which workspace does this identity operate on? An explicit selection
      // wins — reporting a different one than we write to is how demo data
      // ends up in a live workspace.
      try {
        if (OPS_ORG) {
          const { memberships = [] } = await api("GET", "/api/ops/me/workspaces");
          const m = memberships.find((x) => x.orgId === OPS_ORG);
          if (m) {
            out.workspace = { id: m.orgId, name: m.name, role: m.role, selected: true };
            out.nextSteps.push(`Writing to ${m.name} (${m.orgId}). workspace_use switches it.`);
            return json(out);
          }
        }
        const { items = [] } = await api("GET", "/api/ops/orgs");
        if (items.length === 0) {
          out.nextSteps.push(
            `No workspace yet. Open ${OPS_URL}/onboard in a browser to create one, then call fde_status again.`,
          );
          return json(out);
        }
        const w = items[0];
        out.workspace = { id: w.orgId, name: w.name, role: w.role };
      } catch (e) {
        out.nextSteps.push(`Could not read your workspace: ${e.message}`);
        return json(out);
      }

      // What already exists, so the agent doesn't propose duplicates.
      const count = async (path) => {
        try {
          return ((await api("GET", path)).items ?? []).length;
        } catch {
          return null;
        }
      };
      const [connectors, workflows, crons] = await Promise.all([
        count("/api/ops/connectors"),
        count("/api/ops/workflows"),
        count("/api/ops/schedules"),
      ]);
      out.contents = { connectors, workflows, crons };

      if (!connectors) out.nextSteps.push("No connectors yet — `connector_create` to add an ingestion source.");
      if (!workflows) out.nextSteps.push("No workflows yet — `workflow_create`, then `workflow_set_script`.");
      if (!crons) out.nextSteps.push("No schedules yet — `cron_create` to run a workflow on a cadence.");
      if (out.nextSteps.length === 0) {
        out.nextSteps.push("Workspace is set up. List connectors/workflows/crons to see what to change.");
      }
      return json(out);
    },
  },
  // -------------------------------------------------- Connector secrets (creds)
  {
    name: "connector_secrets",
    description:
      "What a connector NEEDS to work vs what it actually HAS. Shows each required secret, its purpose, whether it is optional, whether a value is stored, and whether the running agent sees it. Call this after connector_create — a connector without its secrets is a dead shell.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Connector id from connector_list." } },
      required: ["id"],
    },
    handler: async ({ id }) => json(await api("GET", `/api/ops/connectors/${id}/secrets`)),
  },
  {
    name: "connector_secret_set",
    description:
      "Store one secret for a connector (e.g. SLACK_BOT_TOKEN, GITHUB_TOKEN). The value is encrypted per-workspace and never returned — reads only ever show a last-4 hint. NEVER echo a secret back, and never write one into a data-room file. IMPORTANT: stored is not the same as LIVE — the running agent reads its own environment, so a stored secret only takes effect once it is promoted there; connector_secrets shows both columns, so report `live` when the human asks whether a connector works.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string", description: "Secret name from connector_secrets." },
        value: { type: "string" },
      },
      required: ["id", "name", "value"],
    },
    handler: async ({ id, name, value }) => {
      await api("PUT", `/api/ops/connectors/${id}/secrets`, { name, value, actor: ACTOR });
      return `stored ${name} for connector ${id} (value not echoed)`;
    },
  },
  {
    name: "connector_secret_delete",
    description: "Remove one stored secret from a connector.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    handler: async ({ id, name }) => {
      await api("DELETE", `/api/ops/connectors/${id}/secrets`, { name, actor: ACTOR });
      return `removed ${name} from connector ${id}`;
    },
  },
  // ------------------------------------------------------------- Customers
  {
    name: "customer_create",
    description:
      "Create (or update) a customer. DO THIS FIRST when onboarding a new account — `implementation_upsert` and `deployment_upsert` both hold a foreign key to this record, so without it they fail and the customer exists only as data-room files with nothing structured behind them. Idempotent: calling it again updates the fields you pass and leaves the rest alone. customerId is a lowercase slug and is the SAME id used in data-room paths (Customers/<id>/…).",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Lowercase slug, e.g. 'northwind-capital'." },
        customerName: { type: "string" },
        vertical: { type: "string", description: "e.g. 'financial services', 'legal', 'healthcare'." },
        regulatoryProfile: { type: "string", description: "Regulators and regimes in scope, e.g. 'RBI, SEBI'." },
        tier: { type: "string" },
        lifecycleStage: { type: "string", description: "e.g. onboarding, live, renewal." },
        status: { type: "string" },
        companyDomain: { type: "string" },
        fdeOwner: { type: "string" },
        businessOwnerEmail: { type: "string" },
        technicalOwnerEmail: { type: "string" },
      },
      required: ["customerId", "customerName"],
    },
    handler: async (a) => json(await api("POST", "/api/ops/customers", { ...a, actor: ACTOR })),
  },
  {
    name: "customer_list",
    description: "Existing customers with their tier, stage, status, owner and open-ticket count. Check here before creating one — the id you need may already exist.",
    inputSchema: { type: "object", properties: {} },
    // NOTE the key: this route answers { customers }, not { items } like the
    // others. Reading .items returned undefined and the tool printed the literal
    // string "undefined" — no error, so it read as "no customers".
    handler: async () => json((await api("GET", "/api/ops/customers")).customers),
  },
  // ---------------------------------------------------------------- People
  {
    name: "people_list",
    description: "Everyone in the workspace: roster entries (name, team, manager) merged with workspace members and their roles.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const [roster, ws] = await Promise.all([
        api("GET", "/api/ops/roster").catch(() => ({ items: [] })),
        myWorkspace(),
      ]);
      const orgId = ws.orgId;
      const members = await api("GET", `/api/ops/orgs/${orgId}/members`).catch(() => ({ items: [] }));
      const roleOf = new Map((members.items ?? []).map((m) => [m.email.toLowerCase(), m.role]));
      const rows = new Map();
      for (const p of roster.items ?? []) {
        rows.set(p.email.toLowerCase(), { ...p, role: roleOf.get(p.email.toLowerCase()) ?? null });
      }
      for (const m of members.items ?? []) {
        const k = m.email.toLowerCase();
        if (!rows.has(k)) rows.set(k, { email: m.email, name: null, team: null, role: m.role });
      }
      return json({ orgId, people: [...rows.values()] });
    },
  },
  {
    name: "people_invite",
    description:
      "Invite someone to the workspace by email and get a shareable invite link back. Admin/owner only, and only an owner may invite another owner — a 403 here means your role is too low, not that the tool is broken.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        role: { type: "string", enum: ["owner", "admin", "engineer", "member"] },
        confirm: { type: "boolean", description: "Omit to PREVIEW the invite email; pass true to actually send it." },
      },
      required: ["email"],
    },
    handler: async ({ email, role = "member", confirm = false }) => {
      const { orgId, name } = await myWorkspace();
      // Preview first: an invite is an email to a real person, so the human sees
      // exactly who and what before it leaves.
      if (!confirm) {
        const { preview } = await api("POST", `/api/ops/orgs/${orgId}/invites`, {
          rows: [{ email, role }],
          preview: true,
        });
        return json({
          preview: true,
          sent: false,
          workspace: `${name} (${orgId})`,
          invite: { email, role },
          email: preview,
          next: "Show this to the human. Only re-call with confirm:true once they approve.",
        });
      }
      const res = await api("POST", `/api/ops/orgs/${orgId}/invites`, { rows: [{ email, role }] });
      return json(res.sent ?? res);
    },
  },
  {
    name: "people_set_role",
    description: "Change a member's workspace role, or add them to the workspace. Admin/owner only; only an owner can grant or change `owner`.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        role: { type: "string", enum: ["owner", "admin", "engineer", "member"] },
      },
      required: ["email", "role"],
    },
    handler: async ({ email, role }) => {
      const { orgId } = await myWorkspace();
      const members = await api("GET", `/api/ops/orgs/${orgId}/members`);
      const exists = (members.items ?? []).some((m) => m.email.toLowerCase() === email.toLowerCase());
      if (exists) {
        await api("PATCH", `/api/ops/orgs/${orgId}/members/${encodeURIComponent(email)}`, { role });
        return `${email} is now ${role}`;
      }
      await api("POST", `/api/ops/orgs/${orgId}/members`, { email, role });
      return `added ${email} as ${role}`;
    },
  },
  // ---------------------------------------------------------------- Subagents
  {
    name: "agent_list",
    description: "The specialist subagents the orchestrator delegates to, with their per-workspace state: paused or active, and any custom instructions.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { items = [] } = await api("GET", "/api/ops/agent-configs").catch(() => ({ items: [] }));
      const cfg = new Map(items.map((i) => [i.agentKey, i]));
      return json(
        SUBAGENT_IDS.map((key) => ({
          agent: key,
          paused: cfg.get(key)?.paused ?? false,
          instructions: cfg.get(key)?.instructions ?? null,
        })),
      );
    },
  },
  {
    name: "agent_configure",
    description:
      "Tune a subagent for your use case: pause/resume it (a paused agent is never delegated to) and give it standing instructions injected whenever it runs. Admin/owner only.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "One of: " + SUBAGENT_IDS.join(", ") },
        paused: { type: "boolean" },
        instructions: { type: "string", description: "Standing instructions; pass an empty string to clear." },
      },
      required: ["agent"],
    },
    handler: async ({ agent, paused, instructions }) => {
      if (!SUBAGENT_IDS.includes(agent)) {
        throw new Error(`Unknown subagent "${agent}". One of: ${SUBAGENT_IDS.join(", ")}`);
      }
      const body = { agentKey: agent };
      if (paused !== undefined) body.paused = paused;
      if (instructions !== undefined) body.instructions = instructions || null;
      return json(await api("PUT", "/api/ops/agent-configs", body));
    },
  },
  // -------------------------------------------------------------------- Apps
  {
    name: "app_list",
    description: "Living documents the agent regenerates on a cadence (dashboards, digests, QBRs).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/apps")).items),
  },
  {
    name: "app_create",
    description:
      "Create an app — a living document regenerated on a cadence. sourceKind 'workflow' runs a workflow; 'prompt' runs a prompt (optionally via a named subagent). refreshCron sets the cadence.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        sourceKind: { type: "string", enum: ["workflow", "prompt"] },
        workflow: { type: "string", description: "Workflow name when sourceKind is 'workflow'." },
        prompt: { type: "string", description: "The prompt when sourceKind is 'prompt'." },
        subagent: { type: "string" },
        customerId: { type: "string" },
        refreshCron: { type: "string", description: "e.g. '0 7 * * 1-5'" },
      },
      required: ["name", "description", "sourceKind"],
    },
    handler: async (a) => json(await api("POST", "/api/ops/apps", { ...a, createdBy: ACTOR })),
  },
  // ------------------------------------------------- Delivery (sprints/rollouts)
  {
    name: "sprint_list",
    description: "Sprints (cycles): name, window, and state.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/cycles")).items),
  },
  {
    name: "sprint_create",
    description: "Create a sprint (cycle) with a name and an ISO start/end window.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        startsAt: { type: "string", description: "ISO date/time" },
        endsAt: { type: "string", description: "ISO date/time" },
      },
      required: ["name", "startsAt", "endsAt"],
    },
    handler: async ({ name, startsAt, endsAt }) =>
      json(await api("POST", "/api/ops/cycles", { name, startsAt, endsAt, createdBy: ACTOR })),
  },
  {
    name: "implementation_upsert",
    description:
      "Create or update a customer rollout: stage (scoping/configuration/integration/uat/go-live), risk, progress and owner. Keyed on customerId, and genuinely an upsert — call it again to move the stage.\nREQUIRES THE CUSTOMER TO EXIST FIRST (`customer_create`): this record holds a foreign key to it. If you are thinking in terms of 'rollout' this is the tool you reach for first, and it will fail until the customer row is there.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        implementationStage: { type: "string" },
        implementationRiskLevel: { type: "string" },
        implementationProgressPct: { type: "number" },
        implementationOwnerEmail: { type: "string" },
        displayName: { type: "string" },
      },
      required: ["customerId"],
    },
    handler: async (a) => json(await api("POST", "/api/ops/implementations", a)),
  },
  {
    name: "deployment_upsert",
    description: "Create or update a deployment record: environment, region, version, release + health status, owner.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        deploymentId: { type: "string" },
        environment: { type: "string" },
        region: { type: "string" },
        deployedVersion: { type: "string" },
        releaseStatus: { type: "string" },
        healthStatus: { type: "string" },
        deployOwnerEmail: { type: "string" },
        displayName: { type: "string" },
      },
      required: ["customerId"],
    },
    handler: async (a) => json(await api("POST", "/api/ops/deployments", a)),
  },
  // ------------------------------------------------------------ Tasks & tickets
  {
    name: "task_update",
    description:
      "Correct or close an existing task. Without this the task list can only ACCUMULATE: every correction becomes a new task pointing at a stale one, and a task whose notes turned out to be wrong stays in the backlog asserting something false. Set status:'done' to close, or rewrite title/notes when you learn the original was mistaken.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id from task_list." },
        title: { type: "string" },
        notes: { type: "string" },
        status: { type: "string", enum: ["backlog", "open", "in_progress", "blocked", "done", "cancelled"] },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        assignee: { type: "string" },
        dueAt: { type: "string", description: "ISO-8601" },
        cycleId: { type: "string" },
      },
      required: ["id"],
    },
    handler: async ({ id, ...patch }) =>
      json(await api("PATCH", `/api/ops/todos/${id}`, { ...patch, actor: ACTOR })),
  },
  {
    name: "task_delete",
    description: "Delete a task outright. Prefer task_update with status 'cancelled' when the work was considered and dropped — that keeps the reasoning. Delete is for tasks filed in error.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async ({ id }) => json(await api("DELETE", `/api/ops/todos/${id}`, { actor: ACTOR })),
  },
  {
    name: "implementation_list",
    description: "Every customer rollout with its stage, risk, progress and owner. The read path for implementation_upsert — use it to confirm a write landed, and to see a customer's rollout state before changing it. The customer id comes back as `customer`.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { items = [] } = await api("GET", "/api/ops/implementations");
      // This route names the customer id `customer`; the write tool calls it
      // `customerId`. Echo BOTH so a caller can round-trip a row straight back
      // into implementation_upsert without noticing the seam.
      return json(items.map((r) => ({ customerId: r.customer, ...r })));
    },
  },
  {
    name: "deployment_list",
    description: "Every deployment record with its environment, version, release and health status. The read path for deployment_upsert.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/deployments")).items),
  },
  {
    name: "ticket_list",
    description: "Customer tickets — use these ids to link a task to the ticket it came from.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/tickets")).items),
  },
  {
    name: "task_list",
    description: "The team's TODOs: status, assignee, sprint, container and any linked object.",
    inputSchema: {
      type: "object",
      properties: { includeDone: { type: "boolean" } },
      required: [],
    },
    handler: async ({ includeDone = false }) =>
      json((await api("GET", `/api/ops/todos?includeDone=${includeDone ? "true" : "false"}`)).items),
  },
  {
    name: "task_create",
    description:
      "Create a task, optionally LINKED to the ticket it came from (linkType:'ticket', linkId: the ticket id from ticket_list) and filed under a sprint (cycleId) or a deployment/implementation (containerType + containerId).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        status: { type: "string", enum: ["backlog", "open", "in_progress", "blocked", "done", "cancelled"] },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        dueAt: { type: "string", description: "ISO-8601" },
        assignee: { type: "string" },
        cycleId: { type: "string", description: "Sprint id from sprint_list." },
        linkType: { type: "string", enum: ["ticket", "customer", "app", "cron", "workflow", "chat"] },
        linkId: { type: "string" },
        linkLabel: { type: "string" },
        containerType: { type: "string", enum: ["deployment", "implementation"] },
        containerId: { type: "string" },
      },
      required: ["title"],
    },
    handler: async (a) => json(await api("POST", "/api/ops/todos", { ...a, createdBy: ACTOR })),
  },
  // ------------------------------------------------- Data-room version control
  {
    name: "backfill_start",
    description:
      "Open a CHANGESET before a bulk write, then pass its id to every dataroom_write / dataroom_append_jsonl in the batch. This is what makes a backfill reviewable and revertible as ONE act instead of forty separate overwrites — the data room writes in place, so without a changeset the previous content of each file is gone. Always use this when you are about to write more than two or three files. Call backfill_finish when done.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "What this batch is, e.g. 'Backfill lexwell-partners onboarding'." },
        rationale: { type: "string", description: "Why the batch is being written." },
        unattended: {
          type: "boolean",
          description: "True when no human is reviewing this session (see the approval protocol).",
        },
      },
      required: ["label"],
    },
    handler: async ({ label, rationale, unattended = false }) => {
      const { id } = await api("POST", "/api/ops/dataroom/changesets", {
        label,
        rationale,
        unattended,
        source: "cli",
      });
      return json({
        changesetId: id,
        next: "Pass changesetId on every write in this batch, then call backfill_finish.",
      });
    },
  },
  {
    name: "backfill_finish",
    description: "Close a changeset opened with backfill_start. Until it is closed it stays 'open' and is not offered for revert.",
    inputSchema: {
      type: "object",
      properties: { changesetId: { type: "string" } },
      required: ["changesetId"],
    },
    handler: async ({ changesetId }) =>
      json(await api("POST", "/api/ops/dataroom/changesets", { id: changesetId, commit: true })),
  },
  {
    name: "backfill_list",
    description: "Recent data-room changesets — what each batch was, who wrote it, how many files it touched, and whether it has been reverted.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/dataroom/changesets")).items),
  },
  {
    name: "backfill_show",
    description: "One changeset with every file it touched, and the size before and after. Pass `path` to get the exact bytes that write replaced — the 'before' side of a diff.",
    inputSchema: {
      type: "object",
      properties: {
        changesetId: { type: "string" },
        path: { type: "string", description: "Optional — return the pre-write content of this file." },
      },
      required: ["changesetId"],
    },
    handler: async ({ changesetId, path }) =>
      json(
        await api(
          "GET",
          `/api/ops/dataroom/changesets/${changesetId}${path ? `?path=${encodeURIComponent(path)}` : ""}`,
        ),
      ),
  },
  {
    name: "backfill_revert",
    description:
      "Put every file in a changeset back to what it was before the batch. Admin or owner only. Files the batch CREATED are emptied rather than deleted — the store has no delete, and a revert is the wrong moment to invent one. Show the human backfill_show first; this rewrites many files at once.",
    inputSchema: {
      type: "object",
      properties: {
        changesetId: { type: "string" },
        confirm: { type: "boolean", description: "Must be true. Without it this only previews what would change." },
      },
      required: ["changesetId"],
    },
    handler: async ({ changesetId, confirm = false }) => {
      const detail = await api("GET", `/api/ops/dataroom/changesets/${changesetId}`);
      if (!confirm) {
        return json({
          preview: true,
          reverted: false,
          changeset: detail.changeset,
          wouldRestore: detail.files.filter((f) => f.hasSnapshot).map((f) => f.path),
          wouldEmpty: detail.files.filter((f) => !f.hasSnapshot).map((f) => f.path),
          next: "Show this to the human. Only re-call with confirm:true once they approve.",
        });
      }
      return json(await api("POST", `/api/ops/dataroom/changesets/${changesetId}`, { revert: true }));
    },
  },
  // ------------------------------------------------------------------ Data Room
  {
    name: "dataroom_structure",
    description:
      "READ THIS BEFORE WRITING TO THE DATA ROOM. Returns dm.md — the canonical folder/file contract (Customers/ Platform/ Deployments/ Solutions/ Implementation/ Tickets/ People/) showing exactly where each artifact belongs and which files are .jsonl streams. Paths must start with one of those domains and have at least two segments; a root-level file is rejected.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const url = new URL("./dm.md", import.meta.url);
      const spec = await readPkgFile(url, "utf8").catch(() => null);
      return spec ?? "dm.md is not bundled with this install.";
    },
  },
  {
    name: "dataroom_list",
    description: "List object paths in the data-room blob store under a prefix (e.g. 'Customers/'). Empty prefix lists everything.",
    inputSchema: { type: "object", properties: { prefix: { type: "string" } } },
    handler: async ({ prefix = "" }) => (await dataroom.list(prefix)).join("\n") || "(empty)",
  },
  {
    name: "dataroom_read",
    description: "Read one object's full text from the data room. '(not found)' if absent.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async ({ path }) => (await dataroom.read(path)) ?? "(not found)",
  },
  {
    name: "dataroom_read_jsonl",
    description: "Read a .jsonl data-room object and return its records as a JSON array.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async ({ path }) => json(await dataroom.readJsonl(path)),
  },
  {
    name: "dataroom_write",
    description:
      "Write a file to the data room. HUMAN-IN-THE-LOOP: without `confirm:true` this WRITES NOTHING — it returns a preview (path, whether it overwrites, size, the content itself) plus a `previewToken`. Show that preview to the human, explain what you are writing and where each fact came from, then call again with confirm:true, the SAME content, the `previewToken`, and `approvedBy`. The token is checked against the bytes: change the content after approval and the write is refused.\nNO HUMAN IN THIS SESSION? That is allowed and you must not pretend otherwise — pass approvedBy: 'unattended:<the standing instruction you are acting on>'. It is recorded as unattended so nobody later reads it as reviewed. Always pass `rationale` and `sources`; they are audited.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canonical dm.md path (see dataroom_structure)." },
        content: { type: "string" },
        confirm: { type: "boolean", description: "Must be true to actually write. Omit to preview." },
        previewToken: { type: "string", description: "The token from the preview. Binds the write to what was approved." },
        approvedBy: {
          type: "string",
          description: "Who approved it: a person's name/email, or 'unattended:<standing instruction>' when no human is in the session.",
        },
        changesetId: { type: "string", description: "From backfill_start. Attaches this write to a revertible batch." },
        rationale: { type: "string", description: "Why this file, in one line — shown to the human and audited." },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Where the content came from (data-room paths, URLs, the person who told you).",
        },
      },
      required: ["path", "content"],
    },
    handler: async ({ path, content, confirm = false, previewToken, approvedBy, rationale, sources = [], changesetId }) => {
      const existing = await dataroom.read(path).catch(() => null);
      if (!confirm) {
        return json({
          preview: true,
          wrote: false,
          path,
          action: existing === null ? "create" : "OVERWRITE an existing file",
          bytes: content.length,
          previewToken: approvalToken(path, content),
          rationale: rationale ?? "(none given — say why before asking the human)",
          sources: sources.length ? sources : ["(none cited — cite where this came from)"],
          replaces: existing === null ? null : `${existing.slice(0, 400)}${existing.length > 400 ? "…" : ""}`,
          content,
          next: "Show this to the human verbatim. Then re-call with confirm:true, this previewToken, and approvedBy.",
        });
      }
      const refusal = checkApproval({ path, body: content, previewToken, approvedBy });
      if (refusal) return json(refusal);
      await dataroom.write(path, content, {
        rationale: rationale ? `${rationale} — ${approvalNote(approvedBy)}` : approvalNote(approvedBy),
        sources,
        changesetId,
      });
      return json({
        wrote: true,
        path,
        bytes: content.length,
        action: existing === null ? "created" : "overwrote",
        approvedBy,
        unattended: approvedBy.startsWith("unattended:"),
        rationale: rationale ?? null,
        sources,
      });
    },
  },
  {
    name: "dataroom_append_jsonl",
    description:
      "Append records to a .jsonl data-room stream. HUMAN-IN-THE-LOOP: without `confirm:true` this returns a preview of exactly what would be appended, plus a `previewToken`. Show it to the human, then re-call with confirm:true, the SAME records, the token, and `approvedBy` — the token is checked against the records, so changing them after approval is refused. With no human in the session pass approvedBy: 'unattended:<standing instruction>'; it is recorded as unattended. Pass `rationale` and `sources`.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        records: { type: "array", items: { type: "object" } },
        confirm: { type: "boolean", description: "Must be true to actually append." },
        previewToken: { type: "string", description: "The token from the preview." },
        approvedBy: { type: "string", description: "Who approved it, or 'unattended:<standing instruction>'." },
        changesetId: { type: "string", description: "From backfill_start. Attaches this write to a revertible batch." },
        rationale: { type: "string" },
        sources: { type: "array", items: { type: "string" } },
      },
      required: ["path", "records"],
    },
    handler: async ({ path, records, confirm = false, previewToken, approvedBy, rationale, sources = [], changesetId }) => {
      if (!Array.isArray(records)) throw new Error("records must be a JSON array");
      // Token over the serialised records — the same bytes that would be written.
      const body = records.map((r) => JSON.stringify(r)).join("\n");
      if (!confirm) {
        return json({
          preview: true,
          wrote: false,
          path,
          action: `append ${records.length} record(s)`,
          previewToken: approvalToken(path, body),
          rationale: rationale ?? "(none given)",
          sources: sources.length ? sources : ["(none cited)"],
          records,
          next: "Show this to the human. Then re-call with confirm:true, this previewToken, and approvedBy.",
        });
      }
      const refusal = checkApproval({ path, body, previewToken, approvedBy });
      if (refusal) return json(refusal);
      const n = await dataroom.appendJsonl(path, records, {
        rationale: rationale ? `${rationale} — ${approvalNote(approvedBy)}` : approvalNote(approvedBy),
        sources,
        changesetId,
      });
      return json({
        wrote: true,
        path,
        appended: n,
        approvedBy,
        unattended: approvedBy.startsWith("unattended:"),
        rationale: rationale ?? null,
        sources,
      });
    },
  },
  {
    name: "record_coding_session",
    description: "Redact a Claude Code .jsonl transcript and land it as a Deployments/syncs/claude record for a customer. Secrets are stripped before anything is stored.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string" },
        customerId: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD; defaults to today (UTC)." },
      },
      required: ["transcript", "customerId"],
    },
    handler: async ({ transcript, customerId, date }) => {
      const session = parseClaudeTranscript(transcript, `mcp-${customerId}`);
      if (!session) return "no session could be parsed from that transcript";
      const day = date ?? new Date().toISOString().slice(0, 10);
      const path = `Deployments/syncs/claude/${customerId}/${day}.jsonl`;
      const n = await requireBlob().appendJsonl(path, [sessionToSyncItem(session)]);
      return `landed ${n} redacted session → ${path} (repo: ${session.repo ?? "?"}, ${session.userTurns} turns)`;
    },
  },

  // ------------------------------------------------------------------ Learnings
  /**
   * Sessions in, distilled learnings out, shared everywhere.
   *
   * `record_coding_session` already lands a redacted transcript, but it files it
   * under ONE customer's deployment syncs — fine for "what happened on acme",
   * useless for "what has this team learned". These three are the other axis:
   * upload from any environment, distil on the server, and put the result
   * somewhere every teammate and every deployment actually reads.
   */
  {
    name: "session_upload",
    description:
      "Upload a coding-agent transcript (Claude Code .jsonl) as a LEARNING source, redacted. Unlike record_coding_session this is not filed under a customer — it lands in Learnings/sessions/ for the whole team, so distillation can run across everyone's work. Pass customerId only if the session really is about one account.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Raw .jsonl transcript contents." },
        author: { type: "string", description: "Whose session this is; defaults to your MCP actor." },
        customerId: { type: "string", description: "Optional — only if the session is about one account." },
        date: { type: "string", description: "YYYY-MM-DD; defaults to today (UTC)." },
      },
      required: ["transcript"],
    },
    handler: async ({ transcript, author, customerId, date }) => {
      const who = (author ?? ACTOR).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const session = parseClaudeTranscript(transcript, `mcp-${who}`);
      if (!session) return "no session could be parsed from that transcript";
      const day = date ?? new Date().toISOString().slice(0, 10);
      const path = `Learnings/sessions/${who}/${day}.jsonl`;
      const record = {
        ...sessionToSyncItem(session),
        author: author ?? ACTOR,
        customerId: customerId ?? null,
        uploadedAt: new Date().toISOString(),
      };
      const n = await requireBlob().appendJsonl(path, [record]);
      return `landed ${n} redacted session → ${path} (repo: ${session.repo ?? "?"}, ${session.userTurns} turns)`;
    },
  },
  {
    name: "session_upload_batch",
    description:
      "Upload MANY transcripts in one call — hundreds or thousands. Groups them by author and day so the data room gains a handful of append-only JSONL files rather than one file per session, which is what keeps the web agents fast: their tools list and read paths, and a directory with 5,000 entries in it is a directory nobody can browse. Returns per-group counts and anything it skipped.",
    inputSchema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          description: "Each: { transcript, author?, date?, customerId? }.",
          items: {
            type: "object",
            properties: {
              transcript: { type: "string" },
              author: { type: "string" },
              date: { type: "string" },
              customerId: { type: "string" },
            },
            required: ["transcript"],
          },
        },
      },
      required: ["sessions"],
    },
    handler: async ({ sessions }) => {
      if (!Array.isArray(sessions) || sessions.length === 0) return "no sessions given";
      /**
       * Group first, write once per group.
       *
       * The naive version appends per session: 3,000 sessions is 3,000 blob
       * round trips and, worse, a data room the agent's own dataroom_list has
       * to page through on every unrelated question. Grouping keeps the file
       * count proportional to (authors × days), not to sessions.
       */
      const groups = new Map();
      const skipped = [];
      for (const [i, entry] of sessions.entries()) {
        const parsed = parseClaudeTranscript(entry.transcript, `mcp-batch-${i}`);
        if (!parsed) {
          skipped.push(`#${i}${entry.author ? ` (${entry.author})` : ""}: unparseable`);
          continue;
        }
        const who = (entry.author ?? ACTOR).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const day = entry.date ?? new Date().toISOString().slice(0, 10);
        const path = `Learnings/sessions/${who}/${day}.jsonl`;
        const record = {
          ...sessionToSyncItem(parsed),
          author: entry.author ?? ACTOR,
          customerId: entry.customerId ?? null,
          uploadedAt: new Date().toISOString(),
        };
        if (!groups.has(path)) groups.set(path, []);
        groups.get(path).push(record);
      }
      if (groups.size === 0) return `nothing landed — ${skipped.length} unparseable`;
      const lines = [];
      let total = 0;
      for (const [path, records] of groups) {
        // One append per group, in slices, so a very large day cannot build a
        // single request big enough to be rejected.
        for (let i = 0; i < records.length; i += 250) {
          await requireBlob().appendJsonl(path, records.slice(i, i + 250));
        }
        total += records.length;
        lines.push(`  ${records.length.toString().padStart(5)} → ${path}`);
      }
      return [
        `landed ${total} session(s) across ${groups.size} file(s):`,
        ...lines,
        skipped.length ? `\nskipped ${skipped.length}:\n  ${skipped.slice(0, 10).join("\n  ")}` : "",
      ].join("\n").trim();
    },
  },
  {
    name: "session_continue_url",
    description:
      "A web link that opens a NEW chat on the platform already primed with a recorded coding session — so work done in a terminal can be picked up in the browser by you or a teammate. The chat starts from the session's data-room path, so the agent reads the real transcript rather than a summary someone pasted.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Data-room path from session_upload / learning_list, e.g. Learnings/sessions/operator/2026-08-09.jsonl" },
        ask: { type: "string", description: "What to do with it. Defaults to picking up where the session left off." },
      },
      required: ["path"],
    },
    handler: async ({ path, ask }) => {
      const origin = process.env.WEB_ORIGIN ?? "https://delivered.example.com";
      const seed =
        ask ??
        `Read the recorded coding session at \`${path}\` and pick up where it left off: summarise what was done, what remains, then continue.`;
      return `${origin}/?seed=${encodeURIComponent(seed)}`;
    },
  },
  {
    name: "learning_distil",
    description:
      "Create and RUN a remote job that reads recent uploaded sessions and turns them into RUNBOOKS — when this applies / how to tell / do this / verify / watch out for — written as markdown into Learnings/runbooks/ so a new joiner can follow them, indexed in index.jsonl, with the most broadly useful pointers saved to the team's shared memory for every teammate in every environment. Runs server-side: you can close your laptop. Use dryRun first to see the plan for free.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "YYYY-MM-DD; only sessions on/after this date. Defaults to the last 14 days." },
        focus: { type: "string", description: "Optional theme, e.g. 'deployment failures' or 'onboarding friction'." },
        maxLearnings: { type: "number", description: "How many to keep. Default 8." },
        dryRun: { type: "boolean", description: "Plan the job without spending model tokens. Do this first." },
      },
    },
    handler: async ({ since, focus, maxLearnings, dryRun }) => {
      const from = since ?? new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const keep = maxLearnings ?? 8;
      const name = `Distil learnings since ${from}`;
      /**
       * The job is a real workflow, so it is durable, resumable and visible in
       * run history — the same machinery every other automation uses. One
       * delegated step, because distillation is a reading task and fanning it
       * out would multiply cost for no gain.
       */
      /**
       * RUNBOOKS, not a list of lessons.
       *
       * "We learned X" is only useful to whoever already hit X. A new joiner
       * needs to know when it applies to them, how to tell, what to do, and how
       * to check it worked — so the job is told to emit that shape, and to write
       * each one as its own markdown file people can actually open and follow.
       * Usage compounds because the next person starts from the runbook instead
       * of rediscovering the incident.
       */
      const script = [
        'phase("Distil")',
        'const out = await agent(`Read the redacted coding sessions under Learnings/sessions/ dated on or after ${args.from}` +',
        '  `${args.focus ? ", focusing on: " + args.focus : ""}. Use dataroom_list then read a SAMPLE — do not read every file if there are many.` +',
        '  ` Produce at most ${args.keep} RUNBOOKS for someone who has never done this before. A runbook is not a lesson; it is instructions.` +',
        '  ` Skip anything that is a one-off incident, gossip, or customer-confidential.` +',
        '  ` Write EACH runbook as its own markdown file at Learnings/runbooks/<kebab-title>.md using dataroom_write, with exactly these sections:` +',
        '  ` "# <Title>", "## When this applies" (the trigger, in the reader\'s words),` +',
        '  ` "## How to tell" (the symptom or check that confirms it),` +',
        '  ` "## Do this" (numbered, concrete commands/tools/paths — no vague advice),` +',
        '  ` "## Verify" (how you know it worked), "## Watch out for" (the trap that caught us).` +',
        '  ` Then append one index row per runbook to Learnings/runbooks/index.jsonl with dataroom_append_jsonl:` +',
        '  ` {title, path, appliesWhen, source, createdAt}.` +',
        '  ` Finally save the two or three most broadly useful as one-line pointers to the team\'s shared memory with remember(scope: "team"),` +',
        '  ` each naming its runbook path so anyone can open the full thing.` +',
        '  ` Reply with the runbook titles and paths, one per line.`)',
        "return out",
      ].join("\n");

      const { item } = await api("POST", "/api/ops/workflows", {
        name,
        description: `Turn coding sessions since ${from}${focus ? ` (focus: ${focus})` : ""} into follow-able runbooks in Learnings/runbooks/, indexed, with the most useful shared to team memory.`,
        trigger: "on delegation",
        createdBy: ACTOR,
      });
      await api("PATCH", `/api/ops/workflows/${item.id}`, { script, actor: ACTOR });
      const run = await api("POST", `/api/ops/workflows/${item.id}/run`, {
        args: { from, focus: focus ?? "", keep },
        actor: ACTOR,
        dryRun: Boolean(dryRun),
      });
      if (dryRun) {
        return `DRY RUN of "${name}" (workflow ${item.id}): ${run.agentCalls} agent call(s), phases ${JSON.stringify(run.phases)}. Nothing was recorded. Re-run without dryRun to execute.`;
      }
      return `ran "${name}" (workflow ${item.id})\n\n${run.result ?? run.error ?? "(no result)"}`;
    },
  },
  {
    name: "learning_list",
    description:
      "The runbook index: what has already been written, and where. Check here before running learning_distil — the runbook you need may exist, and re-deriving it wastes a job and splits the guidance in two.",
    inputSchema: {
      type: "object",
      properties: {
        contains: { type: "string", description: "Filter titles/triggers by substring." },
      },
    },
    handler: async ({ contains }) => {
      let rows = [];
      try {
        rows = await requireBlob().readJsonl("Learnings/runbooks/index.jsonl");
      } catch {
        rows = [];
      }
      if (rows.length === 0) return "no runbooks yet — run learning_distil";
      const needle = (contains ?? "").toLowerCase();
      const hits = needle
        ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle))
        : rows;
      return json(hits);
    },
  },

  // ------------------------------------------------------------------ Connectors
  {
    name: "connector_list",
    description: "List all connectors, with id, name, kind, access, synced workflows and health.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/connectors")).items),
  },
  {
    name: "connector_create",
    description:
      "Create a connector. Two shapes:\n" +
      "(1) BUILT-IN — kind is one of github, slack, gmail, granola, exa, pagerduty, system_of_record. Its credential contract is fixed in code; call connector_secrets to see it.\n" +
      "(2) BRING-YOUR-OWN — any other kind (use 'mcp'). Give `endpointUrl` (the https MCP server), `requiredSecrets` (the credentials it needs, UPPER_SNAKE_CASE, each with a purpose) and `authSecretName` (which of those is the bearer token). The agent then discovers and calls that server's tools at runtime — no redeploy, no code change. Without endpointUrl and requiredSecrets a custom connector is only a note in a list: nothing can authenticate to it.\n" +
      "access is read|write|read_write; lands is where its sync writes in the data room; synced is the workflow names it feeds.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", description: "Built-in slug, or 'mcp' for your own server." },
        access: { type: "string", enum: ["read", "write", "read_write"] },
        lands: { type: "string" },
        detail: { type: "string" },
        synced: { type: "array", items: { type: "string" } },
        notifyEmails: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
        endpointUrl: {
          type: "string",
          description: "Bring-your-own only: the https MCP endpoint, e.g. https://mcp.linear.app/mcp. Must be public https — private and loopback addresses are refused.",
        },
        requiredSecrets: {
          type: "array",
          description: "Bring-your-own only: the credential contract. The secrets route accepts these names and no others.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "UPPER_SNAKE_CASE, e.g. LINEAR_API_KEY." },
              purpose: { type: "string", description: "What breaks without it, in one line." },
              optional: { type: "boolean" },
            },
            required: ["name", "purpose"],
          },
        },
        authSecretName: {
          type: "string",
          description: "Bring-your-own only: which required secret is sent as the Bearer token.",
        },
      },
      required: ["name", "kind", "access"],
    },
    handler: async (a) => json((await api("POST", "/api/ops/connectors", { ...a, createdBy: ACTOR })).item),
  },
  {
    name: "connector_update",
    description: "Update fields on a connector by id (name, access, lands, detail, synced, notifyEmails, notifyWhen, enabled, and for a bring-your-own connector endpointUrl / requiredSecrets / authSecretName).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object", description: "Fields to change." } },
      required: ["id", "patch"],
    },
    handler: async ({ id, patch }) => json((await api("PATCH", `/api/ops/connectors/${id}`, { ...patch, actor: ACTOR })).item),
  },
  {
    name: "connector_delete",
    description: "Delete a connector by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async ({ id }) => json(await api("DELETE", `/api/ops/connectors/${id}`, { actor: ACTOR })),
  },

  // ------------------------------------------------------------------- Workflows
  {
    name: "workflow_list",
    description: "List all workflows, with id, name, description, trigger, enabled, and whether they have a script.",
    inputSchema: { type: "object", properties: {} },
    handler: async () =>
      json(
        (await api("GET", "/api/ops/workflows")).items.map((w) => ({
          id: w.id,
          name: w.name,
          trigger: w.trigger,
          enabled: w.enabled,
          hasScript: Boolean(w.script?.trim()),
          description: w.description,
        })),
      ),
  },
  {
    name: "workflow_create",
    description: "Create a workflow (name + description required). trigger defaults to 'on delegation'. Set the TypeScript with workflow_set_script afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        trigger: { type: "string" },
        customerId: { type: "string" },
        steps: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
      },
      required: ["name", "description"],
    },
    handler: async (a) => json((await api("POST", "/api/ops/workflows", { ...a, createdBy: ACTOR })).item),
  },
  {
    name: "workflow_run",
    description:
      "Actually RUN a workflow now, with your identity, and return the result. Everything else here only SAVES a script — a saved script has been validated, not executed, and the two are very different claims.\n" +
      "ALWAYS `dryRun:true` FIRST. That executes the real script in the real sandbox but stubs every agent() call: you get the true phase order and the true fan-out (how many subagent calls, and which), for zero model tokens and with nothing recorded. Only then run it for real. A workflow that fans out over an array can be far more expensive than it looks.\n" +
      "Pass `runId` to resume a durable run: completed steps replay from the journal and execution continues from the first unfinished one.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow id from workflow_list." },
        args: { description: "Value exposed to the script as `args`." },
        dryRun: {
          type: "boolean",
          description: "Plan the run without calling any model: real control flow, stubbed agents, nothing recorded. Do this first.",
        },
        runId: { type: "string", description: "Resume this durable run instead of starting fresh." },
      },
      required: ["id"],
    },
    handler: async ({ id, args, runId, dryRun }) =>
      json(await api("POST", `/api/ops/workflows/${id}/run`, { args, runId, dryRun, actor: ACTOR })),
  },
  {
    name: "connector_probe",
    description:
      "Actually CALL a bring-your-own connector's MCP endpoint and report which tools it exposes. connector_create accepts any https URL without contacting it, so a typo'd host, a dead server or a token that was never valid all look exactly like success until the agent tries to use it. Run this after storing the credential. Reads only — it performs the MCP handshake and lists tools, and calls nothing.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Connector id from connector_list." } },
      required: ["id"],
    },
    handler: async ({ id }) => json(await api("POST", `/api/ops/connectors/${id}/probe`, {})),
  },
  {
    name: "workflow_get",
    description:
      "Read one workflow back IN FULL, including its script and the server's analysis of it. Use it to see how existing workflows are written before authoring a new one, and to confirm what you saved is what is stored — workflow_list only tells you whether a script exists.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Workflow id from workflow_list." } },
      required: ["id"],
    },
    handler: async ({ id }) => json(await api("GET", `/api/ops/workflows/${id}`)),
  },
  {
    name: "workflow_set_script",
    description:
      "Set a workflow's TypeScript by id. The script is validated server-side on save (sandbox contract: only agent/parallel/pipeline/phase/log/args; no imports, no host access). A bad script is rejected with the offending line — write it, read the error, fix it.\n" +
      "DELEGATING TO A SUBAGENT: `agent(prompt, { subagent: 'research' })`. `agentType` is accepted as an alias; ANY OTHER key is ignored silently, so the call lands on the default agent and your fan-out quietly does not happen. Names come from `agent_list`.\n" +
      "After saving, `workflow_run` with `dryRun:true` and check `bySubagent` in the result — that is the only way to confirm your delegation actually resolved, and it costs nothing.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, script: { type: "string" } },
      required: ["id", "script"],
    },
    handler: async ({ id, script }) => {
      const { item } = await api("PATCH", `/api/ops/workflows/${id}`, { script, actor: ACTOR });
      return `saved script for "${item.name}" (${script.split("\n").length} lines)`;
    },
  },
  {
    name: "workflow_update",
    description: "Update fields on a workflow by id (name, description, trigger, customerId, steps, instructions, instructionsEnabled, enabled).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
    },
    handler: async ({ id, patch }) => json((await api("PATCH", `/api/ops/workflows/${id}`, { ...patch, actor: ACTOR })).item),
  },
  {
    name: "workflow_delete",
    description: "Delete a workflow by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async ({ id }) => json(await api("DELETE", `/api/ops/workflows/${id}`, { actor: ACTOR })),
  },

  // ----------------------------------------------------------------------- Crons
  {
    name: "cron_list",
    description: "List all custom schedules (crons), with id, name, prompt, cron/everyMinutes, channelId and enabled.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json((await api("GET", "/api/ops/schedules")).items),
  },
  {
    name: "cron_create",
    description: "Create a scheduled run (name + prompt required). Give EITHER cron (a 5-field expression) OR everyMinutes. channelId is an optional Slack channel to post into.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        cron: { type: "string" },
        everyMinutes: { type: "number" },
        channelId: { type: "string" },
        customerId: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["name", "prompt"],
    },
    handler: async (a) => json((await api("POST", "/api/ops/schedules", { ...a, createdBy: ACTOR })).item),
  },
  {
    name: "cron_update",
    description: "Update fields on a schedule by id (name, prompt, cron, everyMinutes, channelId, customerId, enabled).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
    },
    handler: async ({ id, patch }) => json((await api("PATCH", `/api/ops/schedules/${id}`, { ...patch, actor: ACTOR })).item),
  },
  {
    name: "cron_delete",
    description: "Delete a schedule by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async ({ id }) => json(await api("DELETE", `/api/ops/schedules/${id}`, { actor: ACTOR })),
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------ JSON-RPC plumbing

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fde-control", version: "0.3.0" },
      instructions: [
        "Delivered control plane — operate a real FDE workspace from this editor.",
        "",
        "**Call `fde_status` first.** It reports who you're signed in as, which workspace",
        "you're operating on, what already exists, and the concrete next step. Every other",
        "tool depends on that identity; without it they fail with 'Not signed in'.",
        "",
        "What you can do here:",
        "- **Connectors** — ingestion sources (`connector_*`). `connector_secrets` shows what one",
        "  NEEDS vs HAS; `connector_secret_set` stores a credential. A connector without its",
        "  secrets is a dead shell. Any kind we don't ship is a BRING-YOUR-OWN connector: give it",
        "  an `endpointUrl` + `requiredSecrets` and the agent calls that MCP server directly.",
        "- **Customers** — `customer_create` FIRST when onboarding a new account: implementations",
        "  and deployments hold a foreign key to it, and the data room will happily hold files for",
        "  a customer the database has never heard of. `customer_list` to check before creating.",
        "- **People** — `people_list`, `people_invite`, `people_set_role`.",
        "- **Subagents** — `agent_list` / `agent_configure` to pause one or give it standing",
        "  instructions for this workspace.",
        "- **Workflows** — durable scripts the orchestrator runs (`workflow_*`; create it,",
        "  then `workflow_set_script`). `workflow_get` reads one back in full — read an existing",
        "  one before authoring your first. NOTE: nothing here RUNS a workflow; `cron_create`",
        "  schedules one. A saved script has been validated, not executed.",
        "- **Crons** — schedules that run a workflow on a cadence (`cron_*`).",
        "- **Apps** — living documents regenerated on a cadence (`app_*`).",
        "- **Delivery** — `sprint_*`, `implementation_upsert`, `deployment_upsert`.",
        "- **Work** — `task_*` and `ticket_list`; link a task to its ticket with",
        "  `linkType:'ticket'` + `linkId`.",
        "- **Data room** — read/write the customer document store (`dataroom_*`). Call",
        "  `dataroom_structure` FIRST: it returns dm.md, the folder contract every path must obey.",
        "- **Bulk writes** — `backfill_start` before writing more than two or three files, pass the",
        "  returned changesetId on every write, then `backfill_finish`. The store overwrites in",
        "  place, so a batch without a changeset cannot be undone: the previous content of each",
        "  file is simply gone. `backfill_list` / `backfill_show` / `backfill_revert` are the way",
        "  back out of a backfill that got something wrong.",
        "",
        `These write to LIVE PRODUCTION at ${OPS_URL} — the same data the web console shows.`,
        "There is no sandbox. Read before you write, prefer updating over recreating, and",
        "confirm destructive changes (`*_delete`) with the user first.",
        "",
        "## Ask before you write",
        "",
        "Writes to the data room and invites to people PREVIEW by default: called without",
        "`confirm:true` they return exactly what would happen and change nothing. That preview",
        "is for the HUMAN, not for you — show it to them verbatim, in your own message, and wait.",
        "Along with it state:",
        "- **What** — the path and whether it creates or OVERWRITES (the preview says which).",
        "- **Why** — pass `rationale`; it is written into the audit trail, so the workspace",
        "  later says why a file changed and not merely that it did.",
        "- **Where it came from** — pass `sources`: the files you read, the URLs, the person who",
        "  told you. Content you inferred rather than sourced must be labelled as inferred.",
        "Re-call with `confirm:true`, the SAME content, the `previewToken` from the preview, and",
        "`approvedBy`. The token is checked against the bytes, so what gets written is provably",
        "what was approved. Never pass `confirm:true` on the first call to save a round trip —",
        "that is the entire safeguard.",
        "",
        "If there is NO HUMAN in this session, do not pretend there was one and do not skip the",
        "preview. Pass `approvedBy: \"unattended:<the standing instruction you are acting on>\"`.",
        "That is a legitimate, supported mode; it is recorded as unattended so nobody reading the",
        "trail later mistakes it for something a person reviewed.",
        "",
        "Never write a credential into a data-room file. Secrets go through",
        "`connector_secret_set`, which encrypts them and never reads them back.",
        "",
        "If a tool says you're not signed in, tell the user to run",
        "`npx -p @delivery-agents/cli fde-login` — you cannot complete that browser flow yourself.",
      ].join("\n"),
    });
  }
  if (method === "notifications/initialized" || id === undefined) return;

  if (method === "tools/list") {
    return reply(id, {
      // Outside the platform repo the data-room modules are absent, so those
      // tools are withheld rather than advertised and then failing on call.
      // dataroom_* work over the Ops API, so they ship everywhere. Only
      // record_coding_session needs the repo (its redactor lives there).
      tools: TOOLS.filter((t) => DATAROOM_AVAILABLE || t.name !== "record_coding_session")
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method === "tools/call") {
    const tool = TOOL_MAP.get(params?.name);
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const text = await tool.handler(params.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: String(text) }] });
    } catch (e) {
      return reply(id, {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") return reply(id, {});
  return fail(id, -32601, `method not found: ${method}`);
}

process.stderr.write(
  `[fde-mcp] ready — Data Room blob: ${backend}, Ops API: ${OPS_URL}, ${TOOLS.length} tools\n`,
);
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }
  handle(msg).catch((e) => {
    if (msg?.id !== undefined) fail(msg.id, -32603, e instanceof Error ? e.message : String(e));
  });
}
