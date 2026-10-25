import "./hosts.js";
import { canActAsOrchestrator, canActOnSession, resolveWorkerToken, type WorkerAuth } from "./workerauth.js";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { platformAnalytics, platformErrors } from "./insights.js";
import * as telemetry from "./telemetry.js";
import * as mail from "./email.js";
import { answersOf } from "./access-request.js";
import { GENERATED_ACCESS_FIELDS } from "./access-request.generated.js";
import { proxyHops } from "./proxy-trust.js";
import { appRouter } from "./app.js";
import { packAdminRouter, packAppRouter } from "./pack-routes.js";
import { recordAdminRouter, recordAppRouter } from "./record-routes.js";
import { dataAdminRouter, dataAppRouter } from "./data-routes.js";
import { credentialAppRouter, egressHostAppRouter } from "./credential-routes.js";
import { githubAppAdminRoutes, githubAppRouter } from "./github-app-routes.js";
import { PackError } from "./pack-api.js";
import { onboardingAppRouter } from "./onboarding.js";
import { usageAdminRoute, usageAppRouter } from "./usage-routes.js";
import { noticeAppRouter, scheduleAppRouter } from "./schedule-routes.js";
import { metricAppRouter, runAppRouter } from "./view-routes.js";
import { workspaceFileAppRouter } from "./workspace-files.js";
import { schedulerTick, startScheduler, stopScheduler } from "./schedules.js";
import { startChargeDelivery, stopChargeDelivery } from "./run-charges.js";
import { runWorkerRouter } from "./run-routes.js";
import { adminActor, adminAuthRouter, requirePlatformAdmin } from "./admin-auth.js";
import { ADMIN_MCP_PATHS, adminSkillList, adminToolList, adminTools, adminMcpResource, mountAdminMcp } from "./admin-mcp.js";
import { mcpOriginGuard } from "./origin.js";
import { mountInstallPages } from "./install-pages.js";
import { browserNotFound } from "./status-pages.js";
import { currentOffer } from "./data-map.js";
import { offerFooterHtml } from "./source-offer.js";
import { keysOffMessage, memberKeyAppRouter } from "./member-keys.js";
import { builtinAuthRouter } from "./builtin-auth.js";
import * as mcpOAuth from "./mcp-oauth.js";
import * as roles from "./admin-roles.js";
import * as adminTokens from "./admin-tokens.js";
const { need } = roles;
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { hosts, hostToolNames } from "./host.js";
import { memberKeysOn, PROFILE } from "./profile.js";
import { connectorEvents, recordMcpEvent } from "./analytics.js";
import { endpointLimit, hashed, hit, limitsFor, planOf, refusalMessage, takeSlot, type Refusal } from "./rate-limits.js";
import { bearer, cronSecretOk, headerCredential, isWorkerToken, resolveKey, resolveUserToken, urlKeysAllowed, type Org } from "./auth.js";
import { clerkEnabled, ClerkError, frontendApi, mcpAudience } from "./clerk.js";
import { mcpUrlSetting } from "./console-url.js";
import { StripeError } from "./billing.js";
import { getDb } from "./db.js";
import { probeFromCron, rlsProbeState } from "./rls.js";
import { parseJsonl, transcripts, type RawEvent } from "./transcripts.js";
import { appendEvents, claimJobs, completeSession, heartbeat } from "./worker.js";
import { fleetCheckin, fleetLeave, fleetStatus } from "./fleet.js";
import { autoscalerStatus, kickAutoscaler, startAutoscaler, stopAutoscaler } from "./autoscaler.js";
/** On Vercel, orchestrator traffic drives the autoscaler (no ticking loop there); elsewhere the loop does. */
const serverlessTick = (force = false) => { if (process.env.VERCEL) telemetry.keepAlive(kickAutoscaler({ force }).catch((e) => console.error("autoscaler kick:", (e as Error).message))); };
import { startArchiver, stopArchiver } from "./archive.js";
import { startCatalogIndexing } from "./repository-index.js";
import { storageEnabled } from "./storage.js";
import { brokerOrchestratorCredentials, brokerSessionCredentials, gatewayHandler } from "./gateway.js";
import { usageReport } from "./usage.js";
import * as kv from "./keyvault.js";
import { importEnvKeysOnce } from "./keyvault-env.js";
import * as onboarding from "./admin.js";
import * as platformKeys from "./platform-keys.js";
import { computeSummary } from "./compute.js";
import * as spend from "./spend.js";
import * as spendUsage from "./spend-usage.js";
import * as records from "./compute-records.js";
import * as jobs from "./compute-jobs.js";
import * as actions from "./compute-actions.js";
import * as ticks from "./autoscaler-ticks.js";
import { pruneComputeHistory } from "./autoscaler-ticks.js";
import { freshSettings, listSettings, settingGroups, SettingError } from "./settings.js";
import { answerDocs, sseStart, streamDocsAnswer } from "./docs-answers.js";
import { freshPlatformHarnesses } from "./harnesses.js";
import { ENV } from "./env-names.js";
import { NS } from "./namespace.js";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/$/, "");
/** Where AI clients connect (src/console-url.ts mcpUrl, mold_v0-118): the app's own domain when APP_MCP_URL names it, else PUBLIC_URL. */
const MCP_URL = () => mcpUrlSetting() ?? PUBLIC_URL;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
/** The admin panel (/admin) and customer portal (/app): the Next.js app in web/, built to static files (npm run web:build). */
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "out");

/** The server's root page when no host pack brings a landing page: the profile's name, how to connect, where to sign in. */
const neutralRoot = () => {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(PROFILE.name)}</title>` +
    `<meta name="description" content="${esc(PROFILE.short_description)}"><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}a{color:#2563eb}</style></head>` +
    `<body><main><h1>${esc(PROFILE.name)}</h1><p>${esc(PROFILE.console_description)}</p><p><a href="/install">Connect an MCP client</a> · <a href="/app">Sign in</a></p>${offerFooterHtml(currentOffer())}</main></body></html>`;
};

/** Set on SIGTERM/SIGINT: the process is finishing in-flight requests and will exit. */
let draining = false;

export function createApp() {
  const app = express();
  // The client's address behind the real number of proxies (src/proxy-trust.ts, mold_v0-084): never the leftmost
  // X-Forwarded-For entry, which any client writes.
  app.set("trust proxy", proxyHops());
  app.disable("x-powered-by");
  // Origin first (src/origin.ts, DNS-rebinding protection): a browser page from a foreign origin gets a 403 on every MCP
  // endpoint, the admin MCP included, before any credential is looked at and before any database read.
  app.use(["/mcp", ...ADMIN_MCP_PATHS], mcpOriginGuard);
  // Provider keys still set as environment variables go into the key vault once, before anything reads a key.
  void importEnvKeysOnce();
  adminTokens.warnRetiredAdminToken();
  app.use((_req, _res, next) => void importEnvKeysOnce().then(() => next()));
  // The upstream catalogs not indexed at their pin (mold_v0-128, src/repository-index.ts): once per instance, in the
  // background from its first request (kept alive past the answer on Vercel); never delays or fails a request.
  app.use((_req, _res, next) => { startCatalogIndexing(telemetry.keepAlive); next(); });

  app.get("/healthz", async (_req, res) => {
    if (draining) return void res.status(503).json({ ok: false, draining: true }); // rolling deploy: stop routing here
    await (await getDb()).query("SELECT 1");
    res.json({ ok: true, transcripts: transcripts().kind, rls_probe: rlsProbeState() });
  });

  // How to connect each MCP client, from the profile and this address (mold_v0-060): public, no key in any of it.
  mountInstallPages(app, MCP_URL());

  // ---------- inference gateway: /gw/<provider>/... (ogw_ session tokens, real keys from the vault) ----------
  // Mounted before any body parser: requests and responses stream straight through.
  app.use("/gw/:provider", (req, res, next) => void gatewayHandler(req, res).catch(next));

  // The consent screen of the built-in MCP authorization server (mold_v0-013, web/src/app/auth/consent) is never framed.
  app.use("/auth/consent", (_req, res, next) => { res.set({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" }); next(); });
  // ---------- landing page + access requests ----------
  app.use(express.static(WEB_DIR, {
    extensions: ["html"], maxAge: "5m",
    setHeaders: (res, file) => { if (file.includes(`${path.sep}_next${path.sep}static${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); },
  }));
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "5m" }));
  // A host pack's landing page carries the source offer as the shell's root page does (mold_v0-050, 086): while something
  // is offered, its index.html is sent with the shell's footer before </body>; otherwise the file is served as it is, below.
  const hostIndex = hosts().map((h) => h.publicDir && path.join(h.publicDir, "index.html")).find((f) => f && existsSync(f));
  if (hostIndex) app.get(["/", "/index.html"], (_req, res, next) => {
    const footer = offerFooterHtml(currentOffer());
    if (!footer) return next();
    const html = readFileSync(hostIndex, "utf8");
    const at = html.lastIndexOf("</body>");
    res.type("html").set("Cache-Control", "public, max-age=300").send(at < 0 ? html + footer : html.slice(0, at) + footer + html.slice(at));
  });
  // A host pack's own public files (src/host.ts publicDir; the product's landing page and downloads), after the shell's.
  for (const h of hosts()) if (h.publicDir) app.use(express.static(h.publicDir, { extensions: ["html"], maxAge: "5m" }));
  // With no landing page of a host pack's, the root says what this server is, in the profile's words (mold_v0-039).
  if (!hosts().some((h) => h.publicDir)) app.get("/", (_req, res) => void res.type("html").set("Cache-Control", "public, max-age=300").send(neutralRoot()));
  // Global settings (src/settings.ts) and admin-added harnesses (src/harnesses.ts, merged into registry()) are read
  // synchronously from caches: load them, and keep them at most 30s old.
  app.use((_req, _res, next) => void Promise.all([freshSettings(), freshPlatformHarnesses()]).then(() => next()));

  // 5-minute backstop for the event-driven autoscaler on Vercel (vercel.json crons; Vercel sends CRON_SECRET as a
  // bearer). It also prunes the autoscaler's history (src/autoscaler-ticks.ts), which a VM does from its ticking loop.
  app.get("/api/cron/autoscale", async (req, res) => {
    // CRON_SECRET only (Vercel sends it): no fallback to an admin credential.
    if (!cronSecretOk(req.headers.authorization)) return void res.status(401).json({ error: "unauthorized" });
    const tick = await kickAutoscaler();
    const pruned = await pruneComputeHistory().catch((e) => ({ error: (e as Error).message }));
    // A host pack's queued work (src/host.ts background.cron; the product's loss reasons): a short batch.
    const host = Object.assign({}, ...(await Promise.all(hosts().map(async (h) => (h.background?.cron ? await h.background.cron().catch((e) => ({ error: (e as Error).message })) : {}) as object))));
    // Row-level security, proven on the live database (src/rls.ts): Vercel has no release step to run check:rls in.
    const rls = await probeFromCron(getDb);
    // The packs' schedules and the daily due-date check (mold_v0-035, src/schedules.ts): a server ticks them from its own
    // loop (startScheduler); on Vercel this cron entry is the tick. Nothing is read with no job kind and no due area.
    const schedules = await schedulerTick().catch((e) => ({ error: (e as Error).message }));
    // Price per run (mold_v0-019, src/run-charges.ts): pending charges handed on, only when the app bills runs.
    const rc = await import("./run-charges.js");
    const charges = rc.runBillingOn() ? { run_charges: await rc.deliverCharges().catch((e) => ({ error: (e as Error).message })) } : {};
    res.json({ tick, pruned, ...host, rls, schedules, ...charges });
  });

  // Sign-up requests: at most so many an hour per address, counted across instances (mold_v0-018, src/rate-limits.ts).
  // The shell's own fields (email, company, name, message, where they came from) and the answers to the build's own
  // questions (mold_v0-102, src/access-request.ts: the packs' pack.json access_request), checked and stored as `answers`.
  app.post("/api/access-requests", express.json({ limit: "128kb" }), endpointLimit("signup", (req) => req.ip ?? "?") as express.RequestHandler, async (req, res) => {
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const email = s(req.body?.email, 200), company = s(req.body?.company, 200);
    const message = s(req.body?.message, 4000), name = s(req.body?.name, 120);
    const src = req.body?.source && typeof req.body.source === "object" ? req.body.source : {};
    const source = Object.fromEntries([...["referrer", "landing", "first_page", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].map((k) => [k, s(src[k], 300)]),
      ["country", s(req.headers["x-vercel-ip-country"], 8)], ["city", s(decodeURIComponent(String(req.headers["x-vercel-ip-city"] ?? "")), 80)]].filter(([, v]) => v));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void res.status(400).json({ error: "Please enter a valid email." });
    if (!company) return void res.status(400).json({ error: "Please tell us your company." });
    const { answers, problem } = answersOf(req.body, GENERATED_ACCESS_FIELDS);
    if (problem) return void res.status(400).json({ error: problem });
    const [row] = await (await getDb()).query<{ id: number }>(
      `INSERT INTO access_requests (email, company, message, name, source, answers) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, company, message || null, name || null, Object.keys(source).length ? JSON.stringify(source) : null, JSON.stringify(answers)],
    );
    // A host pack's own follow-up (src/host.ts onAccessRequest; the product researches the company); kept alive on Vercel.
    for (const h of hosts()) if (h.onAccessRequest) telemetry.keepAlive(h.onAccessRequest(row.id));
    // Email after the write, never in its way (src/email.ts): "we got it" to them, an alert to the operator.
    mail.fire(mail.requestReceived({ id: row.id, email, company, name: name || null, message: message || null, answers }));
    telemetry.capture({ distinctId: email.toLowerCase() }, "access_requested", { answers: Object.keys(answers).length, has_message: Boolean(message) });
    const hook = process.env.ACCESS_REQUEST_WEBHOOK_URL; // e.g. a Slack incoming webhook
    if (hook)
      fetch(hook, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `New ${PROFILE.name} access request: ${company} <${email}>${message ? `\n${message}` : ""}` }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => console.error("access-request webhook failed:", err.message));
    res.status(201).json({ ok: true });
  });

  // ---------- built-in sign-in: /api/auth (src/builtin-auth.ts, mold_v0-004): an emailed code or Google, sessions,
  // sign-out (everywhere); under Clerk only /api/auth/config answers (it names the provider) ----------
  app.use("/api/auth", builtinAuthRouter());
  // ---------- the built-in MCP authorization server (src/mcp-oauth.ts, mold_v0-013): /oauth/* and the consent page's
  // /api/oauth/*, under built-in sign-in only (with Clerk every route passes on, unanswered) ----------
  app.use(mcpOAuth.mcpOAuthRouter());
  // ---------- customer page: sign-in, setup check, usage, team, billing (src/app.ts, web/app/app) ----------
  // The customer portal can start work too (approvals, re-runs): tick after any write there (Vercel only).
  app.use("/api/app", (req, _res, next) => { if (req.method !== "GET") _res.on("finish", () => serverlessTick()); next(); });
  app.use(appRouter());
  // ---------- packs' customer routes: /api/packs/<id> (src/pack-routes.ts); with no pack routes nothing is mounted ----------
  app.use("/api/packs", packAppRouter());
  // ---------- record areas' list and detail data: /api/records (src/record-areas.ts); with no area nothing is mounted ----------
  app.use("/api/records", recordAppRouter());
  // ---------- the generic data API: /api/data (src/data-routes.ts, mold_v0-059); with no area nothing is mounted ----------
  app.use("/api/data", dataAppRouter());
  // ---------- the workspace credential vault: /api/credentials (src/credential-routes.ts); with no field nothing is mounted ----------
  app.use("/api/credentials", credentialAppRouter());
  // A workspace's GitHub App installation (mold_v0-014): only when a pack's credential field asks for one.
  app.use("/api/github-app", githubAppRouter());
  // Per-company egress hosts (mold_v0-075): only when a kind takes them.
  app.use("/api/egress-hosts", egressHostAppRouter());
  // ---------- the packs' onboarding checklist: /api/onboarding (src/onboarding.ts); with no step nothing is mounted ----------
  app.use("/api/onboarding", onboardingAppRouter());
  // ---------- usage in neutral words: /api/usage (src/usage-routes.ts, mold_v0-008): the workspace's own, read only ----------
  app.use("/api/usage", usageAppRouter());
  // ---------- a member's own MCP keys (mold_v0-007, src/member-keys.ts): header-only, named, expiring, revocable ----------
  app.use("/api/keys", memberKeyAppRouter(MCP_URL()));
  // ---------- schedules per workspace and due-date notices: /api/schedules, /api/notices (src/schedule-routes.ts); with no job kind or due area nothing is mounted ----------
  app.use("/api/schedules", scheduleAppRouter());
  app.use("/api/notices", noticeAppRouter());
  // ---------- metrics and the runs the console's tabs read: /api/metrics, /api/runs (src/view-routes.ts); with no metric or job kind nothing is mounted ----------
  app.use("/api/metrics", metricAppRouter());
  app.use("/api/runs", runAppRouter());
  // ---------- the workspace store's file viewer: /api/workspace-files (src/workspace-files.ts, mold_v0-056); with no workspace store nothing is mounted ----------
  app.use("/api/workspace-files", workspaceFileAppRouter());

  // ---------- a host pack's public routes (src/host.ts; the product's journeys webhook) ----------
  for (const h of hosts()) h.routes?.public?.(app);

  // ---------- OAuth discovery (Clerk is the authorization server, src/clerk.ts; under built-in sign-in this server is,
  // src/mcp-oauth.ts) ----------
  // MCP clients (Claude, ChatGPT, Claude Code, Cursor) find the authorization server from the 401 below, register (CIMD
  // or DCR) and sign the user in. Public and CORS-open, as browser-based MCP clients read them too.
  const oauthServer = () => (clerkEnabled() ? frontendApi() : null);
  const openCors = (req: Request, res: Response, next: NextFunction) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" });
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  };
  app.use("/.well-known", openCors);
  const resourceMetadata = (_req: Request, res: Response) => {
    // Built-in sign-in: this server is the authorization server (src/mcp-oauth.ts).
    if (mcpOAuth.oauthOn()) return void res.json(mcpOAuth.protectedResourceMetadata());
    const as = oauthServer();
    if (!as) return void res.status(404).json({ error: "OAuth is not configured" });
    res.json({ resource: mcpAudience(), authorization_servers: [as], bearer_methods_supported: ["header"], scopes_supported: ["profile", "email"], resource_name: PROFILE.name });
  };
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], resourceMetadata);
  // For clients that only look for authorization-server metadata on the resource's own origin (older MCP spec).
  app.get("/.well-known/oauth-authorization-server", async (_req, res) => {
    if (mcpOAuth.oauthOn()) return void res.json(mcpOAuth.authorizationServerMetadata());
    const as = oauthServer();
    if (!as) return void res.status(404).json({ error: "OAuth is not configured" });
    const r = await fetch(`${as}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
    res.status(r.status).type("application/json").send(await r.text());
  });
  // OIDC discovery, for clients that look there first (the MCP spec has them try both): built-in sign-in only.
  app.get("/.well-known/openid-configuration", (_req, res, next) => (mcpOAuth.oauthOn() ? void res.json(mcpOAuth.authorizationServerMetadata()) : next()));

  // ---------- MCP (Clerk OAuth sign-in, or a per-organization API key) ----------
  // Keys arrive in a header, `Authorization: Bearer oct_...` or `X-API-Key: oct_...`; hosts that only take a URL sign
  // in with OAuth. The old connector URL with the key in it (/mcp/oct_...) is deprecated (APP_URL_KEYS). Stateless: a fresh server per request, bound to the caller's org.
  // One access-log line per connector request (also the ones analytics never sees: bad keys, GET/DELETE probes,
  // rejected Accept headers), so "connected but nothing happened" can be diagnosed. The key is never logged.
  app.use("/mcp", (req, res, next) => {
    const t0 = Date.now();
    res.set("Access-Control-Expose-Headers", "WWW-Authenticate"); // browser MCP clients read the 401's resource metadata
    res.on("finish", () => {
      const msgs = Array.isArray(req.body) ? req.body : req.body ? [req.body] : [];
      const rpc = msgs.map((m: any) => (m?.method === "tools/call" ? `tools/call:${m?.params?.name}` : m?.method)).filter(Boolean).join(",");
      // On Vercel nothing ticks the autoscaler: a tool call may have queued work (onboarding, a simulation, an approval).
      if (rpc.includes("tools/call")) serverlessTick();
      const origin = req.get("origin");
      console.error(`mcp ${req.method} ${res.statusCode} org=${res.locals.org ?? "-"} rpc=${rpc || "-"} ${Date.now() - t0}ms ua="${String(req.get("user-agent") ?? "").slice(0, 80)}"${origin ? ` origin=${JSON.stringify(origin.slice(0, 120))}` : ""}`);
    });
    next();
  });
  // ---------- MCP limits (mold_v0-018, src/rate-limits.ts): per address before sign-in; per key, member and workspace,
  // the request's size and the workspace's requests in flight after it. A refusal is HTTP 429 (413 for size) with
  // Retry-After and a JSON-RPC error whose data says which limit, its number and when to retry; it is recorded as a
  // failed call of class rate_limited, without arguments.
  const rpcId = (body: unknown) => (body && !Array.isArray(body) && typeof body === "object" && "id" in body ? (body as { id: unknown }).id ?? null : null);
  /** JSON-RPC messages in the body that ask for something (a batch counts each; notifications are free). */
  const asks = (body: unknown) => (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === "object" && typeof (m as { method?: unknown }).method === "string" &&
    !String((m as { method: string }).method).startsWith("notifications/")) as { method: string; params?: { name?: unknown } }[];
  const limited = (req: Request, res: Response, r: Refusal, org?: Org) => {
    // One record per refused request, whatever its size (a batch is never written once per element).
    const first = asks(req.body)[0];
    if (org && first) recordMcpEvent(org, { method: first.method, name: typeof first.params?.name === "string" ? first.params.name : null, ok: false, error: refusalMessage(r), error_class: "rate_limited" });
    res.status(429).set("Retry-After", String(r.retry_after)).json({ jsonrpc: "2.0", id: rpcId(req.body),
      error: { code: -32029, message: refusalMessage(r), data: { limit: r.what, per: r.window_seconds >= 3600 ? "hour" : "minute", max: r.limit, retry_after: r.retry_after } } });
  };
  /** Before sign-in: a batch's size (the SDK's own cap), then the address's requests (also bounds key guessing). */
  const MAX_BATCH = 100;
  const ipGate = async (req: Request, res: Response) => {
    if (Array.isArray(req.body) && req.body.length > MAX_BATCH) {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `A batch holds at most ${MAX_BATCH} messages.` } });
      return false;
    }
    const L = limitsFor(null);
    const r = await hit([{ bucket: `mcp:ip:${hashed(req.ip ?? "?")}`, limit: L.mcp.per_ip_per_minute, what: "address" }], 60, Math.max(1, asks(req.body).length));
    if (r) { limited(req, res, r); return false; }
    return true;
  };
  /** After sign-in: size, then key, member and workspace counts, then a slot among the workspace's requests in flight. */
  const mcpGate = async (req: Request, res: Response, org: Org): Promise<(() => void) | null> => {
    const L = limitsFor(await planOf(org.orgId));
    const bytes = Number(req.get("content-length")) || Buffer.byteLength(JSON.stringify(req.body ?? null));
    if (bytes > L.mcp.max_request_bytes) {
      res.status(413).json({ jsonrpc: "2.0", id: rpcId(req.body), error: { code: -32600, message: `The request is too large (${bytes} bytes; at most ${L.mcp.max_request_bytes}).` } });
      return null;
    }
    // Each message of a batch counts, and takes its own place among the requests in flight.
    const weight = Math.max(1, asks(req.body).length);
    const r = await hit([
      ...(org.keyId != null ? [{ bucket: `mcp:key:${org.keyId}`, limit: L.mcp.per_key_per_minute, what: "key" }] : []),
      ...(org.userId ? [{ bucket: `mcp:member:${hashed(org.userId)}`, limit: L.mcp.per_member_per_minute, what: "member" }] : []),
      { bucket: `mcp:workspace:${org.orgId}`, limit: L.mcp.per_workspace_per_minute, what: "workspace" },
    ], 60, weight);
    if (r) { limited(req, res, r, org); return null; }
    const release = takeSlot(org.orgId, L.mcp.concurrent_per_workspace, weight);
    if (!release) {
      limited(req, res, { bucket: `mcp:concurrent:${org.orgId}`, what: "workspace's requests at once", limit: L.mcp.concurrent_per_workspace, retry_after: 1, window_seconds: 0 }, org);
      return null;
    }
    res.on("close", release); res.on("finish", release);
    return release;
  };
  const clientOf = (ua: string | undefined) => {
    const m = /^\s*([A-Za-z0-9@._+-]{1,80})(?:\/([A-Za-z0-9._+-]{1,40}))?/.exec(ua ?? "");
    return { name: m?.[1] ?? null, version: m?.[2] ?? null };
  };

  const mcp = async (req: Request, res: Response, org0: Org) => {
    if (!(await mcpGate(req, res, org0))) return;
    const org: Org = { ...org0, client: clientOf(req.get("user-agent")) };
    res.locals.org = org.slug;
    transcripts().warm(); // a user is here: have transcript search awake by the time they ask for evidence
    for (const e of connectorEvents(req.body, req.get("user-agent"))) recordMcpEvent(org, e);
    // A host pack's context for this caller (src/host.ts mcp.context; the account's and the person's), after the instructions.
    const context = (await Promise.all(hosts().map((h) => h.mcp?.context?.(org).catch(() => "") ?? ""))).join("");
    const server = createServer(org, context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const wwwAuthenticate = (tokenSent = false) => mcpOAuth.oauthOn() ? mcpOAuth.wwwAuthenticate(tokenSent ? "invalid_token" : undefined) : oauthServer()
    ? `Bearer error="unauthorized", error_description="Sign in to ${PROFILE.name}", resource_metadata="${MCP_URL()}/.well-known/oauth-protected-resource"`
    : `Bearer realm="${NS}"`;
  const unauthorized = (res: Response, tokenSent = false) =>
    res.status(401).set("WWW-Authenticate", wwwAuthenticate(tokenSent)).json({
      jsonrpc: "2.0", id: null,
      // With member keys off (mold_v0-099) the answer names sign-in only.
      error: { code: -32001, message: `Sign in to ${PROFILE.name}${memberKeysOn() ? " (or send a valid API key)" : ""}. Request access at ${MCP_URL()}` },
    });
  // A member key made while member keys were on (mold_v0-099): refused, and the client is told why and to sign in.
  const keyRefused = (res: Response) =>
    res.status(401).set("WWW-Authenticate", wwwAuthenticate(true)).json({
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: `${keysOffMessage(MCP_URL())} This key no longer works.`, data: { reason: "member_keys_off" } },
    });
  // One log line per legacy URL key per process and hour: enough to know who to move, without a line per request.
  const urlKeySeen = new Map<string, number>();
  const noteUrlKey = (slug: string, prefix: string) => {
    const k = `${slug} ${prefix}`, now = Date.now();
    if (now - (urlKeySeen.get(k) ?? 0) < 3_600_000) return;
    urlKeySeen.set(k, now);
    console.error(`mcp url-key deprecated org=${slug} key=${prefix}… (move this client to a header or sign-in)`);
  };
  const methodNotAllowed = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    if (!(await ipGate(req, res))) return;
    const token = headerCredential(req.headers);
    const viaBearer = Boolean(bearer(req.headers.authorization));
    // Built-in sign-in's OAuth access tokens (src/mcp-oauth.ts): audience, expiry, revocation and membership checked.
    if (viaBearer && mcpOAuth.oauthOn() && mcpOAuth.isOAuthAccessToken(token)) {
      const t = await mcpOAuth.resolveOAuthAccessToken(token!);
      if (t && "scope" in t) return void res.status(403).set("WWW-Authenticate", mcpOAuth.wwwAuthenticate("insufficient_scope")).json({
        jsonrpc: "2.0", id: null, error: { code: -32001, message: `This sign-in does not allow ${PROFILE.name}'s tools: connect again and allow access` } });
      return t ? await mcp(req, res, t.org) : unauthorized(res, true);
    }
    let refused: "member_keys_off" | undefined;
    const org = token?.startsWith("oct_") ? await resolveKey(token, { onRefused: (why) => { refused = why; } }) : token && viaBearer ? await resolveUserToken(token) : null;
    org ? await mcp(req, res, org) : refused ? keyRefused(res) : unauthorized(res, Boolean(token));
  });
  // Deprecated: a key in the connector URL (see urlKeysAllowed in src/auth.ts). Logged by account and key prefix,
  // never the key, so whoever still uses one can be moved to a header or to sign-in before APP_URL_KEYS=off.
  app.post("/mcp/:key", express.json({ limit: "4mb" }), async (req, res) => {
    if (!(await ipGate(req, res))) return;
    const key = String(req.params.key);
    if (!urlKeysAllowed()) {
      console.error("mcp url-key refused (APP_URL_KEYS=off)");
      // The same WWW-Authenticate as any 401, so a connector holding the old URL can fall into sign-in (OAuth).
      return void res.status(401).set("WWW-Authenticate", wwwAuthenticate()).json({
        jsonrpc: "2.0", id: null,
        error: { code: -32001, message: `API keys in the connector URL are no longer accepted. Connect to ${MCP_URL()}/mcp and send the key in a header (Authorization: Bearer <key>), or sign in.` },
      });
    }
    // A member key (mold_v0-007) is never accepted here: it goes in a header only.
    const org = await resolveKey(key, { inUrl: true });
    if (!org) return unauthorized(res);
    // RFC 9745: deprecated since 2026-10-20 (a structured date); the successor is the plain /mcp with a header.
    res.set({ Deprecation: "@1792454400", Link: `<${MCP_URL()}/mcp>; rel="successor-version"` });
    noteUrlKey(org.slug, key.slice(0, 10));
    await mcp(req, res, org);
  });
  app.all(["/mcp", "/mcp/:key"], methodNotAllowed);
  // The admin panel as MCP (src/admin-mcp.ts): platform admins only, each tool with its route's permission. Before
  // /api/admin below, whose session guard would refuse OAuth access tokens.
  mountAdminMcp(app, MCP_URL());
  adminTools(); // a host pack's admin tool that clashes with the shell's, or names no tool to follow, fails the start

  // ---------- orchestrator worker API: the fleet token, or a job token bound to one job (src/workerauth.ts) ----------
  const worker = express.Router();
  worker.use((req, res, next) => {
    resolveWorkerToken(bearer(req.headers.authorization)).then((auth) => {
      if (!auth) return void res.status(401).json({ error: "Invalid worker token" });
      // A run sandbox's token (mold_v0-055) reaches its run's routes only (src/run-routes.ts checks which run).
      if (auth.kind === "run" && !/^\/runs(\/|$)/.test(req.path)) return void res.status(403).json({ error: "This worker token is bound to one run" });
      res.locals.worker = auth;
      next();
    }, next);
  });
  const authOf = (res: express.Response) => res.locals.worker as WorkerAuth;
  const jobOnly = (res: express.Response) => { const a = authOf(res); return a.kind === "job" ? a : null; };
  const forbidden = (res: express.Response) => void res.status(403).json({ error: "This worker token is bound to another job" });
  // Session routes: a job token may act only on its own simulation's sessions.
  worker.use("/sessions/:id", (req, res, next) => {
    canActOnSession(authOf(res), String(req.params.id)).then((ok) => (ok ? next() : forbidden(res)), next);
  });
  worker.use(express.json({ limit: "32mb" }));
  worker.use(express.text({ type: ["application/x-ndjson", "application/jsonl", "text/plain"], limit: "32mb" }));
  // The generic run engine's runners (mold_v0-041, src/run-routes.ts): the fleet token, then each run's lease token.
  worker.use("/runs", runWorkerRouter());

  worker.post("/claim", async (req, res) => {
    const { worker_id, limit, models, harness, agent_ids, simulation_id } = req.body ?? {};
    if (typeof worker_id !== "string" || !worker_id) return void res.status(400).json({ error: "worker_id is required" });
    // A job token claims only its own simulation, whatever the body says; a research job's token claims no sessions.
    const job = jobOnly(res);
    if (job && !job.jobId.startsWith("sim_")) return void res.json({ jobs: [] });
    const sim = job ? job.jobId : typeof simulation_id === "string" && simulation_id ? simulation_id : undefined;
    res.json({ jobs: await claimJobs(worker_id, { limit, models, harness, agent_ids, simulation_id: sim, includePrivate: Boolean(job) }) });
  });
  worker.post("/sessions/:id/events", async (req, res) => {
    const events: RawEvent[] = typeof req.body === "string" ? parseJsonl(req.body) : req.body?.events;
    if (!Array.isArray(events)) return void res.status(400).json({ error: "Send JSONL (application/x-ndjson) or {events: [...]}" });
    res.json(await appendEvents(String(req.params.id), events));
  });
  worker.post("/sessions/:id/heartbeat", async (req, res) => {
    await heartbeat(String(req.params.id));
    res.status(204).end();
  });
  worker.post("/sessions/:id/complete", async (req, res) => {
    const status = req.body?.status ?? "completed";
    if (!["completed", "failed", "timeout"].includes(status)) return void res.status(400).json({ error: "status must be completed, failed or timeout" });
    res.json((await completeSession(String(req.params.id), { ...req.body, status })) ?? { verdict: null });
  });
  // Fleet: orchestrators check in every ~30s and get their share of the global, usage-proportional pod plan.
  worker.post("/fleet", async (req, res) => {
    const { orchestrator_id, capacity, meta } = req.body ?? {};
    if (typeof orchestrator_id !== "string" || !orchestrator_id) return void res.status(400).json({ error: "orchestrator_id is required" });
    if (!(await canActAsOrchestrator(authOf(res), orchestrator_id))) return forbidden(res);
    const job = jobOnly(res);
    res.json(await fleetCheckin(orchestrator_id, capacity, meta, job ? job.jobId : undefined));
    serverlessTick();
  });
  worker.delete("/fleet/:id", async (req, res) => {
    if (!(await canActAsOrchestrator(authOf(res), String(req.params.id)))) return forbidden(res);
    await fleetLeave(String(req.params.id));
    res.status(204).end();
    serverlessTick(true); // the next tick deletes the sandbox it leaves behind: never skipped
  });
  // The global plan (every orchestrator, every job) is for the fleet only.
  worker.get("/fleet", async (_req, res) => (jobOnly(res) ? forbidden(res) : void res.json(await fleetStatus())));
  // A host pack's worker routes (src/host.ts; the product's research jobs and shared libraries), behind the same token.
  for (const h of hosts()) h.routes?.worker?.(worker, { jobOf: (res) => jobOnly(res)?.jobId ?? null, forbidden });

  // Credential broker: the orchestrator holds no provider keys; it asks per orchestrator and per session.
  worker.post("/orchestrator/credentials", async (req, res) => {
    const id = req.body?.orchestrator_id;
    if (typeof id !== "string" || !id) return void res.status(400).json({ error: "orchestrator_id is required" });
    if (!(await canActAsOrchestrator(authOf(res), id))) return forbidden(res);
    res.json(await brokerOrchestratorCredentials(id));
  });
  worker.post("/sessions/:id/credentials", async (req, res) => void res.json(await brokerSessionCredentials(String(req.params.id))));
  app.use("/api/worker", worker);

  // ---------- platform admin API: /admin console, key vault, populations (src/admin-auth.ts) ----------
  app.use(adminAuthRouter());
  const admin = express.Router();
  admin.use(requirePlatformAdmin);
  /** Routes only a signed-in person may use, not an admin token (requirePlatformAdmin sets adminUserId for Clerk sessions). */
  const signedIn = (_req: Request, res: Response, next: NextFunction) =>
    res.locals.adminUserId ? next() : void res.status(403).json({ error: "Sign in to do this: an admin token cannot mint tokens or change who is an admin", code: "signed_in_only" });
  // Every staff request is logged (who, what, when, outcome); never the body, which can hold secrets.
  admin.use((req, res, next) => {
    res.on("finish", () => {
      const actor = String(res.locals.adminActor ?? "unknown").replace(/[^\w.@ :-]/g, "").slice(0, 80) || "unknown";
      void getDb().then((db) => db.query("INSERT INTO admin_access_log (actor, method, path, status, ip) VALUES ($1, $2, $3, $4, $5)",
        [actor, req.method, req.originalUrl.split("?")[0]!.slice(0, 300), res.statusCode, String(req.ip ?? "").slice(0, 64)])).catch(() => {});
    });
    next();
  });
  admin.use(express.json({ limit: "64kb" }));
  admin.get("/keyvault/providers", async (_req, res) => void res.json({ providers: await kv.listProviders() }));
  admin.put("/keyvault/providers/:slug", need("keys"), async (req, res) => void res.json(await kv.upsertProvider({ ...req.body, slug: String(req.params.slug) })));
  admin.get("/keyvault/credentials", async (_req, res) => void res.json({ credentials: await kv.listCredentials() }));
  admin.post("/keyvault/credentials", need("keys"), async (req, res) => {
    const { provider, secret, label, priority } = req.body ?? {};
    if (typeof provider !== "string" || typeof secret !== "string") return void res.status(400).json({ error: "provider and secret are required" });
    res.status(201).json(await kv.setCredential(provider, secret, { label, priority }));
  });
  admin.patch("/keyvault/credentials/:id", need("keys"), async (req, res) => {
    await kv.setCredentialEnabled(Number(req.params.id), Boolean(req.body?.enabled));
    res.status(204).end();
  });
  admin.delete("/keyvault/credentials/:id", need("keys"), async (req, res) => {
    await kv.deleteCredential(Number(req.params.id));
    res.status(204).end();
  });
  admin.get("/usage/models", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await usageReport({ days: q.days ? Number(q.days) : undefined, model: q.model }));
  });
  admin.get("/gateway/usage", async (_req, res) => {
    const rows = await (await getDb()).query(
      `/* tenant: admin-only (platform admins and admin tokens): global gateway usage */ SELECT provider, coalesce(session_id, orchestrator_id) AS consumer, requests, errors, input_tokens, output_tokens, bytes, last_at
         FROM gateway_usage ORDER BY last_at DESC LIMIT 500`);
    res.json({ usage: rows });
  });
  // A host pack's admin routes (src/host.ts; the product's developer populations), behind the same guard and log.
  for (const h of hosts()) h.routes?.admin?.(admin, { need, actor: adminActor });
  admin.get("/autoscaler", async (_req, res) => void res.json(await autoscalerStatus()));
  // mold_v0-079: a preview's approval by the platform's operator (a kind that declares approval.by "operator"), for the
  // run's own workspace (from the run row). The digest the operator was shown is required (approvePreview).
  const runOrg = async (id: string) => {
    if (!/^run_[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    const [r] = await (await getDb()).query<{ org_id: number }>("/* tenant: admin-only (platform operators): the run's own workspace, by run id */ SELECT org_id FROM runs WHERE id = $1", [id]);
    return r?.org_id ?? null;
  };
  admin.get("/runs/:id/approval", async (req, res, next) => {
    try {
      const org = await runOrg(String(req.params.id));
      if (org === null) return void res.status(404).json({ error: "no such run" });
      const { approvalView } = await import("./run-approvals.js");
      res.set("Cache-Control", "no-store").json(await approvalView(org, String(req.params.id)));
    } catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
  });
  admin.post("/runs/:id/approve", need("accounts"), async (req, res, next) => {
    try {
      const org = await runOrg(String(req.params.id));
      if (org === null) return void res.status(404).json({ error: "no such run" });
      const { approvePreview } = await import("./run-approvals.js");
      res.status(201).json({ approval: await approvePreview(org, String(req.params.id), req.body ?? {}, { role: "operator", by: `operator:${adminActor(req, res)}` }) });
    } catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
  });
  // Admin tokens for scripts (src/admin-tokens.ts): owners list, mint and revoke them. Minting, and changing who is an
  // admin, need a signed-in owner (signedIn), never a token: a leaked token cannot renew itself or make its holder an owner.
  const tokenErr = (res: Response, e: unknown) => {
    if (!(e instanceof adminTokens.AdminTokenError)) throw e;
    res.status(e.status).json({ error: e.message });
  };
  admin.get("/tokens", need("admins"), async (_req, res) => void res.set("Cache-Control", "no-store").json({ tokens: await adminTokens.listAdminTokens(), max_days: adminTokens.ADMIN_TOKEN_MAX_DAYS }));
  admin.post("/tokens", need("admins"), signedIn, async (req, res) => {
    try {
      const { token, ...row } = await adminTokens.createAdminToken({ label: req.body?.label, role: req.body?.role, days: req.body?.days === undefined ? undefined : Number(req.body.days), createdBy: adminActor(req, res) });
      res.set("Cache-Control", "no-store").status(201).json({ token, ...row });
    } catch (e) { tokenErr(res, e); }
  });
  admin.delete("/tokens/:id", need("admins"), async (req, res) => {
    try { res.status((await adminTokens.revokeAdminToken(Number(req.params.id))) ? 204 : 404).end(); } catch (e) { tokenErr(res, e); }
  });
  // Onboarding console (web/app/admin, src/admin.ts): requests, accounts, people (Clerk), billing (Stripe), legacy keys.
  // A signed-in admin is logged by email, an admin token as token:<label>.
  const ob = express.Router();
  ob.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); }); // responses can carry a new key
  const slug = (req: Request) => String(req.params.slug);
  const done = (res: Response, _?: unknown) => void res.status(204).end();
  ob.get("/overview", async (req, res) => void res.json(await onboarding.overview(req.query)));
  ob.get("/requests", async (req, res) => void res.json({ requests: await onboarding.listRequests(req.query.status ? String(req.query.status) : undefined) }));
  ob.post("/requests/:id/approve", need("requests"), async (req, res) => void res.status(201).json(await onboarding.approveRequest(adminActor(req, res), Number(req.params.id), req.body ?? {})));
  ob.post("/requests/:id/decline", need("requests"), async (req, res) => done(res, await onboarding.declineRequest(adminActor(req, res), Number(req.params.id), req.body?.reason)));
  ob.post("/requests/:id/reopen", need("requests"), async (req, res) => done(res, await onboarding.reopenRequest(adminActor(req, res), Number(req.params.id))));
  ob.get("/orgs", async (_req, res) => void res.json(await onboarding.listOrgs()));
  ob.post("/orgs", need("requests"), async (req, res) => void res.status(201).json(await onboarding.createAccount(adminActor(req, res), req.body ?? {})));
  ob.get("/orgs/:slug", async (req, res) => void res.json(await onboarding.orgDetail(slug(req))));
  ob.patch("/orgs/:slug", need("accounts"), async (req, res) => void res.json(await onboarding.renameOrg(adminActor(req, res), slug(req), req.body?.name)));
  ob.post("/orgs/:slug/invitations", need("invite"), endpointLimit("invite", (req) => String(req.params.slug)) as express.RequestHandler, async (req, res) => void res.status(201).json(await onboarding.invite(adminActor(req, res), slug(req), req.body?.email, req.body?.role)));
  ob.post("/orgs/:slug/invitations/:id/resend", need("invite"), async (req, res) => void res.status(201).json(await onboarding.resendInvitation(adminActor(req, res), slug(req), String(req.params.id))));
  ob.post("/orgs/:slug/invitations/:id/revoke", need("invite"), async (req, res) => done(res, await onboarding.revokeInvitation(adminActor(req, res), slug(req), String(req.params.id))));
  ob.post("/orgs/:slug/members/:id/deactivate", need("accounts"), async (req, res) => done(res, await onboarding.setMemberActive(adminActor(req, res), slug(req), String(req.params.id), false)));
  ob.post("/orgs/:slug/members/:id/reactivate", need("accounts"), async (req, res) => done(res, await onboarding.setMemberActive(adminActor(req, res), slug(req), String(req.params.id), true)));
  ob.post("/orgs/:slug/members/:id/role", need("accounts"), async (req, res) => done(res, await onboarding.setMemberRole(adminActor(req, res), slug(req), String(req.params.id), req.body?.role)));
  ob.post("/orgs/:slug/members/:id/remove", need("accounts"), async (req, res) => done(res, await onboarding.removeMember(adminActor(req, res), slug(req), String(req.params.id))));
  ob.post("/orgs/:slug/clerk", need("accounts"), async (req, res) => void res.json(await onboarding.linkClerk(adminActor(req, res), slug(req))));
  ob.post("/orgs/:slug/billing/customer", need("accounts"), async (req, res) => void res.json({ customer: await onboarding.ensureCustomer(adminActor(req, res), slug(req)) }));
  ob.post("/orgs/:slug/prepaid", need("accounts"), async (req, res) => void res.json(await onboarding.setPrepaidAllowed(adminActor(req, res), slug(req), req.body?.allowed)));
  ob.post("/orgs/:slug/allowance", need("accounts"), async (req, res) => void res.json(await onboarding.setAllowance(adminActor(req, res), slug(req), req.body?.usd ?? null)));
  ob.post("/orgs/:slug/billing/checkout", need("accounts"), async (req, res) => void res.json(await onboarding.checkoutLink(adminActor(req, res), slug(req), req.body?.price_id)));
  ob.post("/orgs/:slug/billing/portal", need("accounts"), async (req, res) => void res.json(await onboarding.portalLink(adminActor(req, res), slug(req))));
  // Plans (src/billing.ts): Stripe prices with a KEY_PREFIX lookup key (src/namespace.ts). Owners add one (a product and a price) or archive one.
  ob.get("/plans", async (_req, res) => void res.json(await onboarding.plans()));
  ob.post("/plans", need("plans"), async (req, res) => void res.status(201).json(await onboarding.createPlan(adminActor(req, res), req.body ?? {})));
  ob.post("/plans/:price_id/experiment", need("plans"), async (req, res) => void res.json(await onboarding.setPlanExperiment(adminActor(req, res), String(req.params.price_id), req.body ?? {})));
  ob.post("/plans/:price_id/archive", need("plans"), async (req, res) => void res.json(await onboarding.archivePlan(adminActor(req, res), String(req.params.price_id))));
  ob.post("/orgs/:slug/keys", need("accounts"), endpointLimit("key", (req) => String(req.params.slug)) as express.RequestHandler, async (req, res) => void res.status(201).json(await onboarding.issueKey(adminActor(req, res), slug(req), req.body?.label)));
  ob.post("/orgs/:slug/keys/:id/revoke", need("delete"), async (req, res) => done(res, await onboarding.revokeKey(adminActor(req, res), slug(req), Number(req.params.id))));
  ob.post("/orgs/:slug/keys/:id/rotate", need("delete"), endpointLimit("key", (req) => String(req.params.slug)) as express.RequestHandler, async (req, res) => void res.status(201).json(await onboarding.rotateKey(adminActor(req, res), slug(req), Number(req.params.id))));
  // Platform analytics and health across every account (src/insights.ts).
  ob.get("/analytics", async (req, res) => void res.json(await platformAnalytics(req.query)));
  // Usage in neutral words, every workspace (mold_v0-008, src/usage-routes.ts): read only.
  ob.get("/usage", usageAdminRoute());
  // Every failure in the period, paged: ?kind=tool|session|onboarding&offset&limit, plus the /analytics filters.
  ob.get("/analytics/errors", async (req, res) => void res.json(await platformErrors(req.query)));
  // A host pack's console routes (src/host.ts; the product's journeys, libraries, agent mix and settings, loss reasons),
  // behind the same guard, log and permission check (roles.assertGuarded below covers them).
  for (const h of hosts()) h.routes?.onboarding?.(ob, { need, actor: adminActor });
  // Agent configuration and the Compute page's Limits table read and save global settings here; a host pack's own routes
  // (above: the product adds its agent mix to the answer) answer first when it has them.
  ob.get("/compute", async (_req, res) => void res.json({ groups: settingGroups(), settings: await listSettings() }));
  ob.put("/compute/settings", need("compute"), async (req, res) => {
    await platformKeys.saveSettingValues(adminActor(req, res), req.body?.values);
    res.json({ groups: settingGroups(), settings: await listSettings() });
  });
  // The Compute page (src/compute.ts): verdict, tick freshness, tiles, limits, environment. Read only; ?fresh=1 asks boat again.
  ob.get("/compute/summary", async (req, res) => void res.json(await computeSummary({ fresh: req.query.fresh === "1" })));
  // Its record tables (src/compute-records.ts): sessions and orchestrators with their peeks, and which agents can run. Read only.
  ob.get("/compute/sessions", async (req, res) => void res.json(await records.listSessions(req.query as Record<string, unknown>)));
  ob.get("/compute/sessions/:id", async (req, res) => void res.json(await records.sessionDetail(String(req.params.id))));
  ob.get("/compute/orchestrators", async (req, res) => void res.json(await records.listOrchestrators(req.query as Record<string, unknown>)));
  ob.get("/compute/orchestrators/:id", async (req, res) => void res.json(await records.orchestratorDetail(Number(req.params.id))));
  ob.get("/compute/agents/runnable", async (_req, res) => void res.json(await records.agentRunnability()));
  // Jobs (simulations and research) with why each waits, and failures by reason (src/compute-jobs.ts). Read only.
  ob.get("/compute/jobs", async (req, res) => void res.json(await jobs.listJobs(req.query as Record<string, unknown>)));
  ob.get("/compute/jobs/:id", async (req, res) => void res.json(await jobs.jobDetail(String(req.params.id))));
  ob.get("/compute/failures", async (req, res) => void res.json(await jobs.computeFailures(req.query as Record<string, unknown>)));
  // The packs' runs per job kind, in their words (a build without the session engine: Health's runs tab). Read only.
  ob.get("/compute/runs", async (req, res) => void res.json(await jobs.runKinds(req.query as Record<string, unknown>)));
  ob.get("/spend/runs", async (req, res) => void res.json(await jobs.runKinds(req.query as Record<string, unknown>)));
  // Whether any pricing experiment exists (FinOps shows its Experiments tab only then, mold_v0-126). Read only.
  ob.get("/spend/experiments/any", async (_req, res) => void res.json({ any: await (await import("./experiments.js")).anyPricingExperiment() }));
  // The autoscaler's history (src/autoscaler-ticks.ts): its decisions log and the Activity chart. Read only.
  ob.get("/compute/ticks", async (req, res) => void res.json(await ticks.listTicks(req.query as Record<string, unknown>)));
  ob.get("/compute/activity", async (req, res) => void res.json(await ticks.computeActivity(req.query as Record<string, unknown>)));
  ob.get("/compute/trends", async (req, res) => void res.json(await (await import("./compute-trends.js")).computeTrends(req.query)));
  // Spend (src/spend.ts, src/spend-usage.ts): metered model spend by account and provider, compute hours, data and storage, and one account's
  // breakdown. Read only (GETs: any admin role).
  ob.get("/spend", async (req, res) => void res.json(await spend.spendReport(req.query)));
  ob.get("/spend/compute", async (req, res) => void res.json(await spendUsage.computeReport(req.query)));
  ob.get("/spend/storage", async (req, res) => void res.json(await spendUsage.storageReport(req.query)));
  ob.get("/spend/accounts/:key", async (req, res) => void res.json(await spend.accountSpend(String(req.params.key), req.query)));
  // FinOps › Revenue (src/revenue.ts): Stripe subscriptions and invoices against metered model spend; Stripe off or down is a 200 that says so.
  ob.get("/spend/revenue", async (req, res) => void res.json(await (await import("./revenue.js")).revenueReport(req.query)));
  ob.get("/spend/experiments", async (req, res) => void res.json(await (await import("./experiments.js")).experimentsReport(req.query)));
  // FinOps › Run charges (mold_v0-019, src/run-charges.ts): every account's run charges and credits in the range (read,
  // any admin role), and one credit per charged run (operators: billing actions, in the admin log).
  ob.get("/spend/run-charges", async (req, res) => {
    const rc = await import("./run-charges.js");
    const account = typeof req.query.account === "string" && req.query.account ? req.query.account : undefined;
    res.json((await rc.adminCharges(spend.spendRange(req.query), { account })) ?? { enabled: false });
  });
  ob.post("/spend/run-charges/:run_id/credit", need("accounts"), async (req, res) => {
    const rc = await import("./run-charges.js");
    try {
      const credit = await rc.creditRun(String(req.params.run_id), adminActor(req, res), req.body?.reason);
      onboarding.log(adminActor(req, res), "billing.run_credit", null, { run: credit.run_id, amount_minor: credit.amount_minor, currency: credit.currency });
      res.status(201).json(credit);
    } catch (e) { if (e instanceof rc.ChargeError) throw new onboarding.AdminError(e.message, e.status); throw e; }
  });
  // The page's only two actions (src/compute-actions.ts), both in the admin audit log: run one autoscaler tick now, and
  // cancel a queued or running session (its orchestrator stops the sandbox at the next heartbeat).
  ob.post("/compute/tick", need("compute"), async (req, res) => void res.json(await actions.runTick(adminActor(req, res))));
  ob.post("/compute/sessions/:id/cancel", need("compute"), async (req, res) => void res.json(await actions.cancelSession(adminActor(req, res), String(req.params.id))));
  // Model keys on /admin/compute: the key vault (src/keyvault.ts). A secret is posted once; only its hint comes back.
  ob.get("/compute/keys", async (_req, res) => void res.json(await platformKeys.modelKeys()));
  // Emails (src/email.ts): the log and its last 24 hours; a test email to an address typed in.
  ob.get("/emails", async (req, res) => void res.json(await mail.emailLog(req.query)));
  ob.post("/emails/test", need("email"), async (req, res) => {
    if (!mail.isEmail(String(req.body?.to ?? "").trim())) throw new onboarding.AdminError("Enter a valid email address");
    const r = await mail.sendTest(adminActor(req, res), req.body.to);
    onboarding.log(adminActor(req, res), "email.test", null, { status: r.status, to_domain: mail.domainOf(String(req.body.to)) });
    res.status(201).json(r);
  });
  ob.get("/compute/sandbox", async (_req, res) => void res.json(await platformKeys.sandboxProvider()));
  ob.post("/compute/keys", need("keys"), async (req, res) => void res.status(201).json(await platformKeys.addModelKey(adminActor(req, res), req.body ?? {})));
  ob.post("/compute/keys/:id/enabled", need("keys"), async (req, res) => done(res, await platformKeys.setModelKeyEnabled(adminActor(req, res), Number(req.params.id), req.body?.enabled)));
  ob.delete("/compute/keys/:id", need("keys"), async (req, res) => done(res, await platformKeys.deleteModelKey(adminActor(req, res), Number(req.params.id))));
  ob.post("/compute/providers/:slug/enabled", need("keys"), async (req, res) => done(res, await platformKeys.setProviderEnabled(adminActor(req, res), slug(req), req.body?.enabled)));
  // The platform's GitHub App and every workspace's installation of it (mold_v0-014), beside the key vault, when a pack
  // declares a credential field that asks for one.
  githubAppAdminRoutes(ob, need, adminActor);
  // Admins and their roles (src/admin-roles.ts; Clerk user metadata): everyone reads, owners change.
  const changer = (req: Request, res: Response): roles.Changer => ({ actor: adminActor(req, res), userId: (res.locals.adminUserId as string | undefined) ?? null });
  // The Connect page (/admin/connect): the admin MCP URL and which tools each role may call.
  ob.get("/mcp", (_req, res) => void res.json({ url: adminMcpResource(), tools: adminToolList(), skills: adminSkillList() }));
  ob.get("/admins", async (_req, res) => void res.json({ admins: await roles.listAdmins(), roles: roles.PLATFORM_ROLES.map((r) => ({ id: r, label: roles.ROLE_LABELS[r], help: roles.roleHelp(r) })),
    me: (res.locals.adminUserId as string | undefined) ?? null }));
  ob.post("/admins", need("admins"), signedIn, async (req, res) => {
    const r = await roles.addAdmin(changer(req, res), req.body?.email, req.body?.role);
    onboarding.log(adminActor(req, res), "admin.add", null, { email: req.body?.email, role: req.body?.role, created: r.created });
    res.status(201).json(r);
  });
  ob.post("/admins/:id/role", need("admins"), signedIn, async (req, res) => {
    const a = await roles.setAdminRole(changer(req, res), String(req.params.id), req.body?.role);
    onboarding.log(adminActor(req, res), "admin.role", null, { user: req.params.id, role: a.role });
    res.json({ admin: a });
  });
  ob.delete("/admins/:id", need("admins"), signedIn, async (req, res) => {
    await roles.removeAdmin(changer(req, res), String(req.params.id));
    onboarding.log(adminActor(req, res), "admin.remove", null, { user: req.params.id });
    res.status(204).end();
  });
  roles.assertGuarded(admin, "/api/admin");
  // "Ask AI" in the admin Cmd+K bar (src/docs-answers.ts): the internal docs and the customer guide. Any role.
  ob.post("/docs/answer", need("read"), async (req, res) => void res.json(await answerDocs("admin", req.body?.question, { userKey: `admin:${adminActor(req, res)}` })));
  ob.post("/docs/answer/stream", need("read"), async (req, res) => {
    let started = false;
    await streamDocsAnswer("admin", req.body?.question, { userKey: `admin:${adminActor(req, res)}` }, (e) => {
      if (!started) { sseStart(res); started = true; }
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    res.end();
  });
  roles.assertGuarded(ob, "/api/admin/onboarding");
  // Clerk / Stripe failures are the admin's to see (a bad key, a rate limit), not a generic 500.
  ob.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    const hostError = hosts().some((h) => (h.routes?.onboardingErrors ?? []).some((C) => err instanceof C));
    if (!(err instanceof onboarding.AdminError || err instanceof roles.AdminRoleError || hostError || err instanceof SettingError || err instanceof ClerkError || err instanceof StripeError)) return next(err);
    // A plan config's problems come as a list too (by path), for the JSON editor.
    const problems = (err as { problems?: string[] }).problems;
    res.status(err.status ?? 400).json({ error: err.message, ...(problems ? { problems } : {}) });
  });
  admin.use("/onboarding", ob);
  // Packs' admin routes: /api/admin/packs/<id>, behind the same admin guard, CSRF header and access log (src/pack-routes.ts).
  admin.use("/packs", packAdminRouter());
  admin.use("/records", recordAdminRouter());
  admin.use("/data", dataAdminRouter());
  app.use("/api/admin", admin);

  // ---------- local preview of the widget (development only) ----------
  const previewHost = hosts().find((h) => h.mcp?.runTool && h.mcp.widgetHtml);
  if (ENV.APP_PREVIEW === "1" && previewHost) {
    const runTool = previewHost.mcp!.runTool!, WIDGET_HTML = previewHost.mcp!.widgetHtml!;
    const isTool = (n: string) => hostToolNames().includes(n);
    const keyOf = (req: Request) => String(req.query.key ?? req.body?.key ?? "");
    app.post("/preview/api/tool", express.json(), async (req, res) => {
      const org = await resolveKey(keyOf(req), { inUrl: true });
      const { name, arguments: args = {} } = req.body ?? {};
      if (!org) return void res.status(401).json({ isError: true, content: [{ type: "text", text: "Invalid key" }] });
      if (!isTool(name)) return void res.status(404).json({ isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] });
      res.json(await runTool(org, name, args));
    });
    app.get("/preview/:tool", async (req, res) => {
      const org = await resolveKey(keyOf(req), { inUrl: true });
      const name = req.params.tool;
      if (!org) return void res.status(401).send("Pass ?key=<org API key>");
      if (!isTool(name)) return void res.status(404).send(`Unknown tool ${name}`);
      const { key: _key, ...args } = req.query as Record<string, unknown>;
      for (const k of ["days", "offset", "limit", "repeats"]) if (args[k] !== undefined) args[k] = Number(args[k]);
      const result = await runTool(org, name, args);
      const boot = JSON.stringify({ toolEndpoint: "/preview/api/tool", key: keyOf(req), data: result.structuredContent ?? null, error: result.isError ? result.content : null })
        .replace(/</g, "\\u003c");
      // The widget reads its boot data from window.__<NAMESPACE>_PREVIEW__ (the build's namespace, src/namespace.ts).
      res.type("html").send(WIDGET_HTML.replace("<script>", `<script>window.__${NS.toUpperCase()}_PREVIEW__ = ${boot};</script>\n<script>`));
    });
  }

  // A browser's address that is neither the console's nor this server's: the console's not-found page, a 404 (mold_v0-131).
  app.use(browserNotFound());

  app.use((err: Error & { status?: number; code?: unknown; env?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    if (status >= 500) return void res.status(status).json({ error: "Internal error" });
    // A machine-readable reason (e.g. code "missing_credential" with the env var) so callers need not parse the message.
    const extra = { ...(typeof err.code === "string" ? { code: err.code } : {}), ...(typeof err.env === "string" ? { env: err.env } : {}) };
    res.status(status).json({ error: err.message, ...extra });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await getDb();
  const server = createApp().listen(PORT, HOST, () => {
    console.error(`${PROFILE.mcp_server_name} (${db.kind}, transcripts in ${transcripts().kind}) listening on http://${HOST}:${PORT}`);
    console.error(`  landing page  ${PUBLIC_URL}/`);
    console.error(`  MCP endpoint  ${MCP_URL()}/mcp   (sign in, or send Authorization: Bearer <api key>)`);
    console.error(`  worker API    ${PUBLIC_URL}/api/worker/*${ENV.APP_WORKER_TOKEN ? "" : "   (disabled: set APP_WORKER_TOKEN)"}`);
    // On-demand orchestrators (boat sandboxes launched/reaped by the server). Needs the public https URL the
    // sandboxes reach us on, the worker token and a boat key in the vault. APP_AUTOSCALE=off disables it.
    const autoscale = (ENV.APP_AUTOSCALE ?? "on").toLowerCase() !== "off";
    if (autoscale && /^https:\/\//.test(PUBLIC_URL) && ENV.APP_WORKER_TOKEN) {
      startAutoscaler();
      console.error("  autoscaler    on (orchestrators on demand; APP_AUTOSCALE=off to disable)");
    } else console.error(`  autoscaler    off (${autoscale ? "needs an https PUBLIC_URL and APP_WORKER_TOKEN" : "APP_AUTOSCALE=off"})`);
    // Off-machine archive of traces and research to R2 (src/archive.ts): backfills, then keeps up every 5 minutes.
    startArchiver();
    // The upstream catalogs (mold_v0-128): indexed at their pin in the background, without waiting for a request.
    startCatalogIndexing();
    console.error(`  archive       ${storageEnabled() ? "on (traces + research to R2)" : "off (R2_* not set)"}`);
    // The packs' schedules and the daily due-date check (src/schedules.ts), every minute; APP_SCHEDULER=off disables.
    if (startScheduler()) console.error("  scheduler     on (every minute; APP_SCHEDULER=off to disable)");
    // Price per run (mold_v0-019): pending run charges to Stripe or the ledger, every minute, only when the app bills runs.
    if (startChargeDelivery()) console.error("  run charges   on (every minute; the profile's billing, APP_RUN_BILLING=off to disable)");
  });
  // Graceful drain (deploys, restarts): stop accepting connections, let in-flight requests finish (gateway streams
  // are sandboxed agents' model calls; cutting them fails the sessions), then exit. A rolling deploy starts the new
  // replica first, so new requests land there while this one drains (deploy/rolling-deploy.sh).
  const shutdown = (signal: string) => {
    if (draining) return;
    draining = true;
    const limit = Math.max(0, Number(ENV.APP_DRAIN_SECONDS ?? 300));
    console.error(`${signal}: draining, in-flight requests get up to ${limit}s`);
    void stopAutoscaler();
    stopArchiver();
    stopScheduler();
    stopChargeDelivery();
    void telemetry.flush();
    server.close(() => { console.error("drained, exiting"); process.exit(0); });
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 1000).unref(); // keep-alive sockets as they go idle
    setTimeout(() => { console.error("drain deadline reached, exiting"); process.exit(0); }, limit * 1000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
