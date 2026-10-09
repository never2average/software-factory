/**
 * Browser runtime — the provider driver + per-call page operations behind the
 * browser_* tools.
 *
 * WHY A DRIVER INTERFACE: a serverless function keeps no in-memory browser
 * handle between tool calls, so every tool call re-attaches over CDP to a
 * browser the PROVIDER keeps alive (proven in the Phase 0 spike: connectOverCDP
 * ~tens of ms, survives detach). The session key lives in Postgres
 * (`browser_sessions`). Two drivers implement the same interface:
 *   - browserbase — the hosted CDP service (prod). Attach across invocations +
 *     an operator live-view URL, no infra. Activates when BROWSERBASE_API_KEY is
 *     set; until then the tools report the connector is unconfigured.
 *   - local — launches a headless Chromium with a CDP port for `eve dev` /
 *     offline. NOT usable in the Vercel function (no local browser there).
 *
 * Read-only for Phase 1: open / goto / read / screenshot / wait / close. Page
 * MUTATION (act/login) is Phase 2 and is approval-gated there.
 */
import { and, count, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright-core";
import { acrossOrgDbs, getDb, type Db, withOrgDb } from "./db/index.ts";
import { browserAllowlist, browserContexts, browserCredentials, browserSessions } from "./db/schema.ts";
import { openBrowserCapability, sealBrowserCapability } from "./browser-capability-crypto.ts";
import { decryptSecret, hasSecretsKey } from "./secret-crypto.ts";
import { fill } from "./agent-vocabulary.ts";

export type BrowserProvider = "browserbase" | "local";

export interface CreatedSession {
  provider: BrowserProvider;
  providerSessionId: string;
  connectUrl: string;
  liveViewUrl?: string;
}

interface BrowserDriver {
  readonly provider: BrowserProvider;
  /** `contextId` (when given) makes the session reuse a persistent provider
   *  context, so a prior login is remembered. */
  createSession(customerId?: string, contextId?: string): Promise<CreatedSession>;
  closeSession(providerSessionId: string): Promise<void>;
  /** Create a fresh persistent context (provider context id), or null if the
   *  provider doesn't support them. */
  createContext(): Promise<string | null>;
}

/* ------------------------------ Browserbase ------------------------------- */

const BB_API = "https://api.browserbase.com/v1";

// The project is resolved FROM THE API KEY (GET /v1/projects) — there is
// deliberately no BROWSERBASE_PROJECT_ID env var (the key alone identifies the
// project; Browserbase's own onboarding forbids surfacing a project id). Cached
// for the process after the first resolve.
let cachedProjectId: string | null = null;
async function browserbaseProjectId(apiKey: string): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const res = await fetch(`${BB_API}/projects`, { headers: { "X-BB-API-Key": apiKey } });
  if (!res.ok) throw new Error(`Browserbase: could not resolve a project from the API key (${res.status}).`);
  const projects = (await res.json()) as Array<{ id: string }>;
  if (!projects.length) throw new Error("Browserbase: the API key has no projects.");
  cachedProjectId = projects[0].id;
  return cachedProjectId;
}

const browserbaseDriver: BrowserDriver = {
  provider: "browserbase",
  async createContext(): Promise<string | null> {
    const apiKey = process.env.BROWSERBASE_API_KEY!;
    const projectId = await browserbaseProjectId(apiKey);
    const res = await fetch(`${BB_API}/contexts`, {
      method: "POST",
      headers: { "X-BB-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { id: string }).id;
  },
  async createSession(_customerId?: string, contextId?: string): Promise<CreatedSession> {
    const apiKey = process.env.BROWSERBASE_API_KEY!;
    const projectId = await browserbaseProjectId(apiKey);
    // Reuse the customer's persistent context (persist:true saves cookies back)
    // so a prior login is remembered.
    /**
     * Viewport, because the default does not fit where we show it.
     *
     * Nothing was set, so Browserbase used its own default and the live view
     * arrived at an aspect ratio unrelated to the Control Panel rail it is
     * embedded in — letterboxed, with the page's own layout deciding it was a
     * wide desktop. The remote browser should be shaped like the window the
     * operator actually watches it in, or every site renders for a viewport
     * nobody is looking at.
     *
     * Env-tunable rather than hard-coded: the rail's proportions are a UI
     * decision that will change, and rebuilding the agent to re-shape a panel
     * would be the wrong coupling. 1280x800 (16:10) is a sane default — real
     * enough that sites serve their desktop layout, close enough to the rail
     * that the embed is not mostly bars.
     */
    const viewport = {
      width: Number(process.env.BROWSER_VIEWPORT_WIDTH ?? "1280"),
      height: Number(process.env.BROWSER_VIEWPORT_HEIGHT ?? "800"),
    };
    const browserSettings = {
      ...(contextId ? { context: { id: contextId, persist: true } } : {}),
      viewport,
    };
    // keepAlive is ESSENTIAL for the re-attach-per-op model: without it,
    // Browserbase ends the session the instant the first CDP connection detaches,
    // so the SECOND page op (read after goto) hits "410 Gone — session not
    // running". The idle-sweep cron + browser_close still bound the cost/lifetime.
    const res = await fetch(`${BB_API}/sessions`, {
      method: "POST",
      headers: { "X-BB-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        keepAlive: true,
        // Hard cap (seconds) so a session the agent forgets to browser_close —
        // and the idle-sweep misses — still self-terminates. Bounds keepAlive cost.
        timeout: Number(process.env.BROWSER_SESSION_TIMEOUT ?? "900"),
        browserSettings,
      }),
    });
    if (!res.ok) throw new Error(`Browserbase createSession failed (${res.status}): ${await res.text().catch(() => "")}`);
    const s = (await res.json()) as { id: string; connectUrl: string };
    // Live-view (debugger) URL for the cockpit "watch it browse" card.
    let liveViewUrl: string | undefined;
    try {
      const dbg = await fetch(`${BB_API}/sessions/${s.id}/debug`, { headers: { "X-BB-API-Key": apiKey } });
      if (dbg.ok) liveViewUrl = ((await dbg.json()) as { debuggerFullscreenUrl?: string }).debuggerFullscreenUrl;
    } catch {
      /* live-view is best-effort */
    }
    return { provider: "browserbase", providerSessionId: s.id, connectUrl: s.connectUrl, liveViewUrl };
  },
  async closeSession(providerSessionId: string): Promise<void> {
    const apiKey = process.env.BROWSERBASE_API_KEY!;
    const projectId = await browserbaseProjectId(apiKey).catch(() => null);
    if (!projectId) throw new Error("Browserbase project resolution failed during release.");
    const response = await fetch(`${BB_API}/sessions/${providerSessionId}`, {
      method: "POST",
      headers: { "X-BB-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
    });
    // Releasing an already-gone provider session is idempotent.
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Browserbase release failed (${response.status}).`);
    }
  },
};

/* -------------------------------- Local ----------------------------------- */
// Dev/offline only: a single long-lived process (`eve dev`) can hold the child
// Chromium handles in a module map. Never selected in the Vercel function.

const localProcs = new Map<string, Browser>();

const localDriver: BrowserDriver = {
  provider: "local",
  async createContext(): Promise<string | null> {
    return null; // local dev has no persistent provider context
  },
  async createSession(): Promise<CreatedSession> {
    const port = 9400 + Math.floor(((Date.now() % 1000) / 1000) * 500);
    const proc = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    const id = `local_${port}_${Date.now()}`;
    localProcs.set(id, proc);
    return { provider: "local", providerSessionId: id, connectUrl: `http://127.0.0.1:${port}` };
  },
  async closeSession(providerSessionId: string): Promise<void> {
    const proc = localProcs.get(providerSessionId);
    if (proc) {
      await proc.close().catch(() => {});
      localProcs.delete(providerSessionId);
    }
  },
};

/** The active driver, chosen by configured env. Null when no provider is set.
 *  Browserbase needs ONLY the API key (the project resolves from it). */
export function getBrowserDriver(): BrowserDriver | null {
  if (process.env.BROWSERBASE_API_KEY) return browserbaseDriver;
  if (process.env.BROWSER_LOCAL === "1") return localDriver;
  return null;
}

export function browserConfigured(): boolean {
  return getBrowserDriver() !== null && hasSecretsKey();
}

/* --------------------------- session store --------------------------------- */

export type SessionRow = typeof browserSessions.$inferSelect;

export type BrowserContextScope = "principal" | "team";

/** Verified scope supplied by the tool/session boundary, never by the model. */
export interface BrowserAccessScope {
  readonly orgId: string;
  readonly principalId: string;
}

export interface OpenBrowserSessionInput extends BrowserAccessScope {
  readonly eveSessionId?: string;
  readonly customerId?: string;
  readonly contextScope?: BrowserContextScope;
}

export interface OpenBrowserSessionResult {
  readonly row: SessionRow;
  readonly reattached: boolean;
}

/** Stable identity for persistent provider cookies. */
export function browserContextScopeKey(scope: BrowserAccessScope, sharing: BrowserContextScope): string {
  return sharing === "team" ? "team" : `principal:${scope.principalId}`;
}

/** Never persist provider errors verbatim: they may echo a capability URL. */
export function redactBrowserError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/\b(?:wss?|https?):\/\/[^\s"']+/gi, "[redacted-browser-url]")
    .replace(/([?&](?:token|key|secret|auth)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

/** Audit navigation without retaining query-string bearer tokens or fragments. */
export function browserAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

/**
 * Cap concurrent sessions — at the PROVIDER's limit, not above it.
 *
 * The default was 5 while Browserbase allows 3 concurrent (and 5 new per
 * minute). A fan-out of six research subagents therefore sailed past our cap
 * and was rejected by theirs: five `browser_open` calls failed with 429 "You've
 * exceeded your max concurrent sessions limit (limit 3, currently 3)", the
 * subagents sat Running with nothing to run, and the operator watched six live
 * panels that were never going to open.
 *
 * A cap above the provider's is not a cap; it just moves the failure somewhere
 * with a worse error message. Raise BROWSER_MAX_SESSIONS only after raising the
 * Browserbase plan limit.
 */
const MAX_SESSIONS = Number(process.env.BROWSER_MAX_SESSIONS ?? "3");

/** Get-or-create the customer's persistent provider context, so a login done
 *  once (stored-cred or take-control) is remembered across sessions. */
async function contextFor(
  db: Db,
  driver: BrowserDriver,
  scope: BrowserAccessScope,
  customerId: string | undefined,
  sharing: BrowserContextScope,
): Promise<string | undefined> {
  if (!customerId) return undefined;
  const scopeKey = browserContextScopeKey(scope, sharing);
  const [existing] = await withOrgDb(scope.orgId, (tx) =>
    tx
      .select()
      .from(browserContexts)
      .where(
        and(
          eq(browserContexts.orgId, scope.orgId),
          eq(browserContexts.customerId, customerId),
          eq(browserContexts.scopeKey, scopeKey),
        ),
      )
      .limit(1),
  );
  if (existing && existing.provider === driver.provider) {
    await withOrgDb(scope.orgId, (tx) =>
      tx
        .update(browserContexts)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(browserContexts.orgId, scope.orgId),
            eq(browserContexts.customerId, customerId),
            eq(browserContexts.scopeKey, scopeKey),
          ),
        ),
    );
    return existing.providerContextId;
  }
  const contextId = await driver.createContext();
  if (!contextId) return undefined;
  await withOrgDb(scope.orgId, (tx) =>
    tx
      .insert(browserContexts)
      .values({
        orgId: scope.orgId,
        customerId,
        scopeType: sharing,
        scopeKey,
        createdBy: scope.principalId,
        provider: driver.provider,
        providerContextId: contextId,
      })
      .onConflictDoUpdate({
        target: [browserContexts.orgId, browserContexts.customerId, browserContexts.scopeKey],
        set: { provider: driver.provider, providerContextId: contextId, lastUsedAt: new Date() },
      }),
  );
  return contextId;
}

/** Open (or re-attach to) a browser session for this eve session × customer. */
export async function openSession(input: OpenBrowserSessionInput): Promise<OpenBrowserSessionResult> {
  const { orgId, principalId, eveSessionId, customerId } = input;
  if (!orgId || !principalId) throw new Error("Browser sessions require authenticated workspace and principal scope.");
  const contextScope = input.contextScope ?? "principal";
  const db = getDb();
  if (!db) throw new Error("Database not configured — browser sessions need Postgres.");
  if (!hasSecretsKey()) {
    throw new Error("OPS_SECRETS_KEY is not set on the agent — browser capabilities cannot be persisted safely.");
  }
  const driver = getBrowserDriver();
  if (!driver) {
    throw new Error(
      "Browser runtime is not configured. Set BROWSERBASE_API_KEY on the agent (or BROWSER_LOCAL=1 for dev).",
    );
  }
  // Re-attach to a live session for this eve session (+ customer) if one exists.
  if (eveSessionId) {
    const existing = await withOrgDb(input.orgId, (tx) =>
      tx
        .select()
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.orgId, orgId),
            eq(browserSessions.principalId, principalId),
            eq(browserSessions.eveSessionId, eveSessionId),
            eq(browserSessions.contextScope, contextScope),
            customerId
              ? eq(browserSessions.customerId, customerId)
              : isNull(browserSessions.customerId),
            eq(browserSessions.status, "open"),
          ),
        )
        .limit(1),
    );
    const match = existing[0];
    if (match) {
      const now = new Date();
      await withOrgDb(input.orgId, (tx) =>
        tx
          .update(browserSessions)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(browserSessions.id, match.id),
              eq(browserSessions.orgId, orgId),
              eq(browserSessions.principalId, principalId),
            ),
          ),
      );
      return { row: { ...match, lastUsedAt: now }, reattached: true };
    }
  }
  // Cost cap: refuse to open past the concurrency ceiling (fail loudly, like
  // MAX_AGENT_CALLS) — a stuck sweep or a loop can't silently burn budget.
  const [{ open }] = await withOrgDb(input.orgId, (tx) =>
    tx
      .select({ open: count() })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.orgId, orgId),
          inArray(browserSessions.status, ["open", "closing", "release_failed"]),
        ),
      ),
  );
  if (Number(open) >= MAX_SESSIONS) {
    throw new Error(
      `The browser session cap (${MAX_SESSIONS}) is reached — this matches the provider's concurrent limit, so opening more would be refused with a 429 rather than queued. Close one with browser_close and reuse it: visiting many sites in ONE session, sequentially, is the working pattern. Do not fan out browser subagents.`,
    );
  }
  const contextId = await contextFor(db, driver, { orgId, principalId }, customerId, contextScope);
  const created = await driver.createSession(customerId, contextId);
  try {
    const connect = sealBrowserCapability(created.connectUrl, orgId);
    const live = created.liveViewUrl ? sealBrowserCapability(created.liveViewUrl, orgId) : null;
    const [row] = await withOrgDb(input.orgId, (tx) =>
      tx
        .insert(browserSessions)
        .values({
          orgId,
          principalId,
          provider: created.provider,
          providerSessionId: created.providerSessionId,
          capabilityKeyVersion: connect.keyVersion,
          connectUrlCiphertext: connect.ciphertext,
          connectUrlIv: connect.iv,
          connectUrlTag: connect.tag,
          liveViewUrlCiphertext: live?.ciphertext ?? null,
          liveViewUrlIv: live?.iv ?? null,
          liveViewUrlTag: live?.tag ?? null,
          eveSessionId: eveSessionId ?? null,
          customerId: customerId ?? null,
          contextScope,
        })
        .returning(),
    );
    return { row, reattached: false };
  } catch (error) {
    // Do not orphan billable provider state if encryption or persistence fails.
    await driver.closeSession(created.providerSessionId).catch(() => {});
    throw error;
  }
}

/** Look up a session row by our id (the sessionRef the model carries). */
export async function getSession(id: string, scope: BrowserAccessScope): Promise<SessionRow | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await withOrgDb(scope.orgId, (tx) =>
    tx
      .select()
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.id, id),
          eq(browserSessions.orgId, scope.orgId),
          eq(browserSessions.principalId, scope.principalId),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

export async function listSessions(scope: BrowserAccessScope): Promise<SessionRow[]> {
  const db = getDb();
  if (!db) return [];
  return withOrgDb(scope.orgId, (tx) =>
    tx
      .select()
      .from(browserSessions)
      .where(
        and(eq(browserSessions.orgId, scope.orgId), eq(browserSessions.principalId, scope.principalId)),
      ),
  );
}

export function liveViewUrl(row: SessionRow): string | undefined {
  if (!row.liveViewUrlCiphertext || !row.liveViewUrlIv || !row.liveViewUrlTag) return undefined;
  return openBrowserCapability(
    {
      ciphertext: row.liveViewUrlCiphertext,
      iv: row.liveViewUrlIv,
      tag: row.liveViewUrlTag,
      keyVersion: row.capabilityKeyVersion,
    },
    row.orgId,
  );
}

export async function closeSession(id: string, scope: BrowserAccessScope): Promise<void> {
  const db = getDb();
  if (!db) return;
  const [row] = await withOrgDb(scope.orgId, (tx) =>
    tx
      .select()
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.id, id),
          eq(browserSessions.orgId, scope.orgId),
          eq(browserSessions.principalId, scope.principalId),
        ),
      )
      .limit(1),
  );
  if (!row || row.status === "closed") return;
  if (row.status === "closing") return; // another invocation owns the release
  const [claimed] = await withOrgDb(scope.orgId, (tx) =>
    tx
      .update(browserSessions)
      .set({ status: "closing", lastUsedAt: new Date() })
      .where(
        and(
          eq(browserSessions.id, id),
          eq(browserSessions.orgId, scope.orgId),
          eq(browserSessions.principalId, scope.principalId),
          inArray(browserSessions.status, ["open", "release_failed"]),
        ),
      )
      .returning(),
  );
  if (!claimed) return;
  const driver = getBrowserDriver();
  try {
    if (!driver || driver.provider !== claimed.provider) {
      throw new Error(`Browser provider "${claimed.provider}" is not configured on the releasing service.`);
    }
    await driver.closeSession(claimed.providerSessionId);
    await withOrgDb(scope.orgId, (tx) =>
      tx
        .update(browserSessions)
        .set({
          status: "closed",
          closedAt: new Date(),
          releaseAttempts: sql`${browserSessions.releaseAttempts} + 1`,
          releaseError: null,
        })
        .where(
          and(
            eq(browserSessions.id, id),
            eq(browserSessions.orgId, scope.orgId),
            eq(browserSessions.principalId, scope.principalId),
            eq(browserSessions.status, "closing"),
          ),
        ),
    );
  } catch (error) {
    const detail = redactBrowserError(error);
    await withOrgDb(scope.orgId, (tx) =>
      tx
        .update(browserSessions)
        .set({
          status: "release_failed",
          releaseAttempts: sql`${browserSessions.releaseAttempts} + 1`,
          releaseError: detail,
        })
        .where(
          and(
            eq(browserSessions.id, id),
            eq(browserSessions.orgId, scope.orgId),
            eq(browserSessions.principalId, scope.principalId),
            eq(browserSessions.status, "closing"),
          ),
        ),
    );
    throw new Error(`Browser session release failed: ${detail}`);
  }
}

/** Provider-owning cleanup. Every row retains and reuses its tenant scope. */
export async function sweepIdleSessions(now = new Date()): Promise<{ released: number; failed: number }> {
  const db = getDb();
  if (!db) return { released: 0, failed: 0 };
  const idleMs = Number(process.env.BROWSER_SESSION_IDLE_MS ?? 6 * 60_000);
  const cutoff = new Date(now.getTime() - idleMs);
  // A crashed closer is reclaimable after the same idle window. Provider
  // release is idempotent, so a retry safely finishes DB bookkeeping.
  /**
   * Cross-workspace by construction: this reclaims idle browsers wherever they
   * are, and there is no single workspace to ask from. Swept per workspace, so
   * it keeps working once the isolation policy fails closed — an unscoped sweep
   * would release nothing and look exactly like "nothing idle".
   */
  await acrossOrgDbs(async (tx) => {
    await tx
      .update(browserSessions)
      .set({ status: "release_failed", releaseError: "Release lease expired; retrying." })
      .where(and(eq(browserSessions.status, "closing"), lt(browserSessions.lastUsedAt, cutoff)));
    return [];
  });
  const rows = await acrossOrgDbs((tx) =>
    tx
      .select({
        id: browserSessions.id,
        orgId: browserSessions.orgId,
        principalId: browserSessions.principalId,
      })
      .from(browserSessions)
      .where(
        or(
          and(eq(browserSessions.status, "open"), lt(browserSessions.lastUsedAt, cutoff)),
          eq(browserSessions.status, "release_failed"),
        ),
      ),
  );
  let released = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await closeSession(row.id, { orgId: row.orgId, principalId: row.principalId });
      released += 1;
    } catch {
      failed += 1;
    }
  }
  return { released, failed };
}

/* --------------------------- navigation allow-list ------------------------- */

/** Normalise a URL/origin to a bare host for matching (drops scheme, path, www). */
function hostOf(input: string): string {
  try {
    const u = new URL(input.includes("://") ? input : `https://${input}`);
    return u.host.replace(/^www\./, "").toLowerCase();
  } catch {
    return input.replace(/^www\./, "").toLowerCase();
  }
}

/** Does `entry` (an allow-list origin) cover `host`? Exact host or a parent
 *  domain (so "acme-bank.com" covers "app.acme-bank.com"). */
function originCovers(entry: string, host: string): boolean {
  const e = hostOf(entry);
  return host === e || host.endsWith(`.${e}`);
}

/**
 * Enforcement is DEFAULT-DENY once configured. "Configured" = any allow-list row
 * exists OR `BROWSER_ALLOWED_ORIGINS` (comma list) is set. When nothing is
 * configured, navigation is permitted (and always audited) so Phase 1 browsing
 * keeps working until an operator locks it down. Throws a clear, actionable
 * error on an off-list target.
 */
/**
 * Refuse every agent page operation while a human holds the browser.
 *
 * The live view has always been interactive, so "take control" was real in the
 * sense that clicks reached the page — and imaginary in the sense that nothing
 * stopped the agent driving the same page at the same time. Two hands on one
 * browser is worst precisely when control is taken: during a login, where the
 * agent can navigate away from a form somebody is typing into.
 *
 * Read-only operations are refused too. A screenshot mid-keystroke is not
 * harmful, but "the agent does nothing while I have control" is a promise worth
 * keeping literally — a half-exception is a thing nobody can reason about.
 *
 * The lock EXPIRES. A held lock with no deadline turns a closed laptop into a
 * browser no later turn can use, and there would be no way to clear it.
 */
export function assertNotHumanControlled(row: SessionRow): void {
  const until = row.controlExpiresAt ? new Date(row.controlExpiresAt).getTime() : 0;
  if (!row.controlHeldBy || until <= Date.now()) return;
  const mins = Math.max(1, Math.round((until - Date.now()) / 60000));
  throw new Error(
    `${row.controlHeldBy} has taken control of this browser — you must not act on it. ` +
      `Their control lapses in ~${mins} min unless they hand it back. Do something else, ` +
      `or ask them to hand control back before you continue.`,
  );
}

export async function assertNavigationAllowed(
  url: string,
  orgId: string,
  customerId?: string | null,
): Promise<void> {
  const host = hostOf(url);
  const envList = (process.env.BROWSER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const db = getDb();
  const rows = db
    ? await withOrgDb(orgId, (tx) =>
        tx
        .select()
        .from(browserAllowlist)
        .where(
          and(
            eq(browserAllowlist.orgId, orgId),
            customerId
              ? or(isNull(browserAllowlist.customerId), eq(browserAllowlist.customerId, customerId))
              : isNull(browserAllowlist.customerId),
          ),
        ),
      ).catch(() => [])
    : [];
  const configured = envList.length > 0 || rows.length > 0;
  if (!configured) return; // unconfigured → permissive (audited by the tool)
  const allowed =
    envList.some((e) => originCovers(e, host)) || rows.some((r) => originCovers(r.origin, host));
  if (!allowed) {
    throw new Error(
      `Navigation to "${host}" is blocked by the browser allow-list. An operator must add it (Ops Center → browser allow-list, or POST /api/ops/browser-allowlist) before the agent can visit it.`,
    );
  }
}

/* --------------------------- per-call page ops ----------------------------- */

/** Attach over CDP, run one operation on the active page, then disconnect.
 *  The provider keeps the browser alive between calls (the whole design). */
async function withPage<T>(row: SessionRow, fn: (page: Page) => Promise<T>): Promise<T> {
  const connectUrl = openBrowserCapability(
    {
      ciphertext: row.connectUrlCiphertext,
      iv: row.connectUrlIv,
      tag: row.connectUrlTag,
      keyVersion: row.capabilityKeyVersion,
    },
    row.orgId,
  );
  const browser = await chromium.connectOverCDP(connectUrl);
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const out = await fn(page);
    const db = getDb();
    if (db) {
      await withOrgDb(row.orgId, (tx) =>
        tx
          .update(browserSessions)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(browserSessions.id, row.id),
              eq(browserSessions.orgId, row.orgId),
              eq(browserSessions.principalId, row.principalId),
            ),
          ),
      );
    }
    return out;
  } finally {
    // Disconnect (not close) — the provider's browser stays alive for the next
    // tool call. `browser.close()` on a CDP connection just detaches the client.
    await browser.close().catch(() => {});
  }
}

export async function pageGoto(row: SessionRow, url: string): Promise<{ url: string; title: string }> {
  assertNotHumanControlled(row);
  await assertNavigationAllowed(url, row.orgId, row.customerId);
  return withPage(row, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { url: page.url(), title: await page.title() };
  });
}

export type PageAction = "click" | "type" | "fill" | "select" | "press";

/** Act on an element by its ref from the last aria snapshot (`aria-ref=eN`).
 *  Refs are re-resolved at act time; a stale ref fails softly telling the model
 *  to re-read. Enforces the allow-list against the CURRENT page too. */
export async function pageAct(
  row: SessionRow,
  action: PageAction,
  ref: string,
  value?: string,
): Promise<{ ok: boolean; url: string; title: string }> {
  assertNotHumanControlled(row);
  return withPage(row, async (page) => {
    await assertNavigationAllowed(page.url(), row.orgId, row.customerId);
    const locator = page.locator(`aria-ref=${ref}`);
    try {
      switch (action) {
        case "click":
          await locator.click({ timeout: 10_000 });
          break;
        case "type":
        case "fill":
          await locator.fill(value ?? "", { timeout: 10_000 });
          break;
        case "select":
          await locator.selectOption(value ?? "", { timeout: 10_000 });
          break;
        case "press":
          await locator.press(value ?? "Enter", { timeout: 10_000 });
          break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        /aria-ref|not found|resolve/i.test(msg)
          ? `Element ref "${ref}" is stale or gone — call browser_read again to get fresh refs, then retry.`
          : msg,
      );
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
    return { ok: true, url: page.url(), title: await page.title() };
  });
}

/** An LLM-friendly aria snapshot (stable refs) of the page, truncated to a
 *  token budget. This is the read primitive the model reasons over. */
export async function pageRead(row: SessionRow, maxChars = 8000): Promise<{ url: string; title: string; aria: string; truncated: boolean }> {
  assertNotHumanControlled(row);
  return withPage(row, async (page) => {
    const aria = await page.locator("body").ariaSnapshot({ mode: "ai" }).catch(() => "");
    const truncated = aria.length > maxChars;
    return { url: page.url(), title: await page.title(), aria: truncated ? aria.slice(0, maxChars) : aria, truncated };
  });
}

export async function pageScreenshot(row: SessionRow, fullPage = false): Promise<Buffer> {
  assertNotHumanControlled(row);
  return withPage(row, (page) => page.screenshot({ type: "png", fullPage }));
}

/* ------------------------------- login ------------------------------------- */

export function credentialsConfigured(): boolean {
  return hasSecretsKey();
}

/** Fetch + DECRYPT a stored credential for (customer, site). The plaintext is
 *  returned only to pageLogin (server-side); it never reaches a tool result or
 *  the model. Null when none is stored. */
async function getStoredCredential(
  orgId: string,
  customerId: string,
  siteOrigin: string,
): Promise<{ username: string; password: string } | null> {
  const db = getDb();
  if (!db) return null;
  const host = hostOf(siteOrigin);
  // The lookup runs in the session's workspace and is constrained by it, so a
  // credential another workspace stored is simply not found (row-level security
  // is the check). It used to ask first which workspace owned the customer, on
  // the bare handle: under the fail-closed policy that read sees nothing and
  // answered the default workspace for every customer, so no other workspace
  // could ever use a credential it had stored.
  const [row] = await withOrgDb(orgId, (tx) =>
    tx
      .select()
      .from(browserCredentials)
      .where(
        and(
          eq(browserCredentials.orgId, orgId),
          eq(browserCredentials.customerId, customerId),
          eq(browserCredentials.siteOrigin, host),
        ),
      )
      .limit(1),
  );
  if (!row) return null;
  const password = decryptSecret({ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag }, orgId);
  return { username: row.username, password };
}

/** Fill a stored username/password into the given field refs and submit, all
 *  server-side. Returns whether a credential existed + a screenshot; the
 *  credential itself is never returned. */
export async function pageLogin(
  row: SessionRow,
  customerId: string,
  siteOrigin: string,
  refs: { usernameRef: string; passwordRef: string; submitRef?: string },
): Promise<{ ok: boolean; found: boolean; url: string; title: string }> {
  assertNotHumanControlled(row);
  if (row.customerId !== customerId) {
    throw new Error(fill("The {account} named for the credential does not own this browser session."));
  }
  const cred = await getStoredCredential(row.orgId, customerId, siteOrigin);
  if (!cred) return { ok: false, found: false, url: "", title: "" };
  return withPage(row, async (page) => {
    await assertNavigationAllowed(page.url(), row.orgId, row.customerId);
    await page.locator(`aria-ref=${refs.usernameRef}`).fill(cred.username, { timeout: 10_000 });
    await page.locator(`aria-ref=${refs.passwordRef}`).fill(cred.password, { timeout: 10_000 });
    if (refs.submitRef) {
      await page.locator(`aria-ref=${refs.submitRef}`).click({ timeout: 10_000 });
    } else {
      await page.locator(`aria-ref=${refs.passwordRef}`).press("Enter", { timeout: 10_000 });
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return { ok: true, found: true, url: page.url(), title: await page.title() };
  });
}

export async function pageWait(row: SessionRow, opts: { selector?: string; ms?: number }): Promise<{ ok: boolean }> {
  assertNotHumanControlled(row);
  return withPage(row, async (page) => {
    if (opts.selector) {
      await page.waitForSelector(opts.selector, { timeout: Math.min(opts.ms ?? 15_000, 30_000) });
    } else {
      await page.waitForLoadState("networkidle", { timeout: Math.min(opts.ms ?? 15_000, 30_000) }).catch(() => {});
    }
    return { ok: true };
  });
}
