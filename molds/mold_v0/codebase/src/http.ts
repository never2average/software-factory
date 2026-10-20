import { researchSearch } from "./websearch.js";
import { canActAsOrchestrator, canActOnSession, resolveWorkerToken, type WorkerAuth } from "./workerauth.js";
import path from "node:path";
import { contextForAI } from "./context.js";
import { platformAnalytics, platformErrors } from "./insights.js";
import * as journeys from "./journeys.js";
import * as playbooks from "./playbooks.js";
import * as prospect from "./prospect.js";
import * as telemetry from "./telemetry.js";
import * as mail from "./email.js";
import { appRouter } from "./app.js";
import { adminActor, adminAuthRouter, requirePlatformAdmin } from "./admin-auth.js";
import { adminSkillList, adminToolList, adminMcpResource, mountAdminMcp } from "./admin-mcp.js";
import * as roles from "./admin-roles.js";
const { need } = roles;
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, runTool, TOOL_NAMES, WIDGET_HTML, type ToolName } from "./server.js";
import { connectorEvents, recordMcpEvent } from "./analytics.js";
import { bearer, isWorkerToken, resolveKey, resolveUserToken, type Org } from "./auth.js";
import { clerkEnabled, ClerkError, frontendApi, mcpAudience } from "./clerk.js";
import { StripeError } from "./billing.js";
import { getDb } from "./db.js";
import { parseJsonl, transcripts, type RawEvent } from "./transcripts.js";
import { appendEvents, claimJobs, completeSession, heartbeat } from "./worker.js";
import { fleetCheckin, fleetLeave, fleetStatus } from "./fleet.js";
import { autoscalerStatus, kickAutoscaler, startAutoscaler, stopAutoscaler } from "./autoscaler.js";
/** On Vercel, orchestrator traffic drives the autoscaler (no ticking loop there); elsewhere the loop does. */
const serverlessTick = (force = false) => { if (process.env.VERCEL) telemetry.keepAlive(kickAutoscaler({ force }).catch((e) => console.error("autoscaler kick:", (e as Error).message))); };
import { startArchiver, stopArchiver } from "./archive.js";
import { storageEnabled } from "./storage.js";
import { brokerOrchestratorCredentials, brokerSessionCredentials, gatewayHandler } from "./gateway.js";
import * as research from "./research.js";
import { usageReport } from "./usage.js";
import * as kv from "./keyvault.js";
import { importEnvKeysOnce } from "./keyvault-env.js";
import * as populations from "./populations.js";
import * as onboarding from "./admin.js";
import * as reasons from "./reasons.js";
import * as library from "./library.js";
import * as contributions from "./contributions.js";
import { computeSummary } from "./compute.js";
import * as spend from "./spend.js";
import * as spendUsage from "./spend-usage.js";
import * as records from "./compute-records.js";
import * as jobs from "./compute-jobs.js";
import * as actions from "./compute-actions.js";
import * as ticks from "./autoscaler-ticks.js";
import { pruneComputeHistory } from "./autoscaler-ticks.js";
import { freshSettings, SettingError } from "./settings.js";
import { answerDocs, sseStart, streamDocsAnswer } from "./docs-answers.js";
import { freshPlatformHarnesses } from "./harnesses.js";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/$/, "");
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
/** The admin panel (/admin) and customer portal (/app): the Next.js app in web/, built to static files (npm run web:build). */
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "out");

/** Set on SIGTERM/SIGINT: the process is finishing in-flight requests and will exit. */
let draining = false;

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  // Provider keys still set as environment variables go into the key vault once, before anything reads a key.
  void importEnvKeysOnce();
  app.use((_req, _res, next) => void importEnvKeysOnce().then(() => next()));

  app.get("/healthz", async (_req, res) => {
    if (draining) return void res.status(503).json({ ok: false, draining: true }); // rolling deploy: stop routing here
    await (await getDb()).query("SELECT 1");
    res.json({ ok: true, transcripts: transcripts().kind });
  });

  // ---------- inference gateway: /gw/<provider>/... (ogw_ session tokens, real keys from the vault) ----------
  // Mounted before any body parser: requests and responses stream straight through.
  app.use("/gw/:provider", (req, res, next) => void gatewayHandler(req, res).catch(next));

  // ---------- landing page + access requests ----------
  app.use(express.static(WEB_DIR, {
    extensions: ["html"], maxAge: "5m",
    setHeaders: (res, file) => { if (file.includes(`${path.sep}_next${path.sep}static${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); },
  }));
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "5m" }));
  // Global settings (src/settings.ts) and admin-added harnesses (src/harnesses.ts, merged into registry()) are read
  // synchronously from caches: load them, and keep them at most 30s old.
  app.use((_req, _res, next) => void Promise.all([freshSettings(), freshPlatformHarnesses()]).then(() => next()));

  // 5-minute backstop for the event-driven autoscaler on Vercel (vercel.json crons; Vercel sends CRON_SECRET as a
  // bearer). It also prunes the autoscaler's history (src/autoscaler-ticks.ts), which a VM does from its ticking loop.
  app.get("/api/cron/autoscale", async (req, res) => {
    const secret = process.env.CRON_SECRET || process.env.OCTILLION_ADMIN_TOKEN;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return void res.status(401).json({ error: "unauthorized" });
    const tick = await kickAutoscaler();
    const pruned = await pruneComputeHistory().catch((e) => ({ error: (e as Error).message }));
    // Loss reasons queued while nothing drained them (src/reasons.ts): a short batch, within the daily cap.
    const reasons = await (await import("./reasons.js")).drainReasons(30).catch((e) => ({ error: (e as Error).message }));
    res.json({ tick, pruned, reasons });
  });

  const recent = new Map<string, number[]>();
  app.post("/api/access-requests", express.json({ limit: "16kb" }), async (req, res) => {
    const ip = req.ip ?? "?";
    const now = Date.now();
    const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60 * 60_000);
    if (hits.length >= 5) return void res.status(429).json({ error: "Too many requests, try again later." });
    recent.set(ip, [...hits, now]);

    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const email = s(req.body?.email, 200), company = s(req.body?.company, 200);
    const productUrl = s(req.body?.product_url, 500), message = s(req.body?.message, 4000);
    const name = s(req.body?.name, 120), role = s(req.body?.role, 120), teamSize = s(req.body?.team_size, 20);
    const docsUrl = s(req.body?.docs_url, 500), competitors = s(req.body?.competitors, 500), goal = s(req.body?.goal, 40), timeline = s(req.body?.timeline, 40), heardFrom = s(req.body?.heard_from, 120), subindustry = s(req.body?.subindustry, 80);
    const agents = (Array.isArray(req.body?.agents) ? req.body.agents : []).map((x: unknown) => s(x, 40)).filter(Boolean).slice(0, 12);
    const src = req.body?.source && typeof req.body.source === "object" ? req.body.source : {};
    const source = Object.fromEntries([...["referrer", "landing", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].map((k) => [k, s(src[k], 300)]),
      ["country", s(req.headers["x-vercel-ip-country"], 8)], ["city", s(decodeURIComponent(String(req.headers["x-vercel-ip-city"] ?? "")), 80)]].filter(([, v]) => v));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void res.status(400).json({ error: "Please enter a valid email." });
    if (!company) return void res.status(400).json({ error: "Please tell us your company." });
    const [row] = await (await getDb()).query<{ id: number }>(
      `INSERT INTO access_requests (email, company, product_url, message, name, role, team_size, agents, source, docs_url, competitors, goal, timeline, heard_from, subindustry)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [email, company, productUrl || null, message || null, name || null, role || null, teamSize || null, agents, Object.keys(source).length ? JSON.stringify(source) : null,
       docsUrl || null, competitors || null, goal || null, timeline || null, heardFrom || null, subindustry || null],
    );
    // Background research on the company for whoever reviews the request (src/prospect.ts); kept alive on Vercel.
    telemetry.keepAlive(prospect.researchRequest(row.id));
    // Email after the write, never in its way (src/email.ts): "we got it" to them, an alert to the operator.
    mail.fire(mail.requestReceived({ id: row.id, email, company, name: name || null, product_url: productUrl || null, message: message || null }));
    telemetry.capture({ distinctId: email.toLowerCase() }, "access_requested", { has_product_url: Boolean(productUrl), has_message: Boolean(message) });
    const hook = process.env.ACCESS_REQUEST_WEBHOOK_URL; // e.g. a Slack incoming webhook
    if (hook)
      fetch(hook, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `New Octillion access request: ${company} <${email}> ${productUrl}\n${message}` }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => console.error("access-request webhook failed:", err.message));
    res.status(201).json({ ok: true });
  });

  // ---------- customer page: sign-in, setup check, usage, team, billing (src/app.ts, web/app/app) ----------
  // The customer portal can start work too (approvals, re-runs): tick after any write there (Vercel only).
  app.use("/api/app", (req, _res, next) => { if (req.method !== "GET") _res.on("finish", () => serverlessTick()); next(); });
  app.use(appRouter());

  // ---------- journey webhook: PostHog Workflows queues in-chat nudges (src/journeys.ts) ----------
  // The secret goes in an Authorization header, or in the path for webhook steps that cannot set headers.
  const nudgeHook = async (req: Request, res: Response, secret: string | null) => {
    if (!journeys.journeySecretOk(secret)) return void res.status(401).json({ error: "Invalid journey secret" });
    try { res.status(201).json(await journeys.receiveNudge(req.body ?? {})); }
    catch (e) { const err = e as journeys.JourneyError; if (!(err instanceof journeys.JourneyError)) throw e; res.status(err.status).json({ error: err.message }); }
  };
  app.post("/api/journeys/nudges", express.json({ limit: "32kb" }), (req, res) => nudgeHook(req, res, bearer(req.headers.authorization)));
  app.post("/api/journeys/nudges/:secret", express.json({ limit: "32kb" }), (req, res) => nudgeHook(req, res, String(req.params.secret)));

  // ---------- OAuth discovery (Clerk is the authorization server; src/clerk.ts) ----------
  // MCP clients (Claude, ChatGPT, Claude Code, Cursor) find Clerk from the 401 below, register (CIMD or DCR) and sign
  // the user in. Public and CORS-open, as browser-based MCP clients read them too.
  const oauthServer = () => (clerkEnabled() ? frontendApi() : null);
  const openCors = (req: Request, res: Response, next: NextFunction) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" });
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  };
  app.use("/.well-known", openCors);
  const resourceMetadata = (_req: Request, res: Response) => {
    const as = oauthServer();
    if (!as) return void res.status(404).json({ error: "OAuth is not configured" });
    res.json({ resource: mcpAudience(), authorization_servers: [as], bearer_methods_supported: ["header"], scopes_supported: ["profile", "email"], resource_name: "Octillion" });
  };
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], resourceMetadata);
  // For clients that only look for authorization-server metadata on the resource's own origin (older MCP spec).
  app.get("/.well-known/oauth-authorization-server", async (_req, res) => {
    const as = oauthServer();
    if (!as) return void res.status(404).json({ error: "OAuth is not configured" });
    const r = await fetch(`${as}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
    res.status(r.status).type("application/json").send(await r.text());
  });

  // ---------- MCP (Clerk OAuth sign-in, or a per-organization API key) ----------
  // Keys arrive as `Authorization: Bearer oct_...` or in the connector URL, /mcp/oct_..., for hosts that
  // only take a URL. Stateless: a fresh server per request, bound to the caller's org.
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
      console.error(`mcp ${req.method} ${res.statusCode} org=${res.locals.org ?? "-"} rpc=${rpc || "-"} ${Date.now() - t0}ms ua="${String(req.get("user-agent") ?? "").slice(0, 80)}"`);
    });
    next();
  });
  const mcp = async (req: Request, res: Response, org: Org) => {
    res.locals.org = org.slug;
    transcripts().warm(); // a user is here: have transcript search awake by the time they ask for evidence
    for (const e of connectorEvents(req.body, req.get("user-agent"))) recordMcpEvent(org, e);
    const server = createServer(org, await contextForAI(org).catch(() => ""));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const unauthorized = (res: Response) =>
    res.status(401).set("WWW-Authenticate", oauthServer()
      ? `Bearer error="unauthorized", error_description="Sign in to Octillion", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`
      : 'Bearer realm="octillion"').json({
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: `Sign in to Octillion (or send a valid API key). Request access at ${PUBLIC_URL}` },
    });
  const methodNotAllowed = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const token = bearer(req.headers.authorization);
    const org = token?.startsWith("oct_") ? await resolveKey(token) : token ? await resolveUserToken(token) : null;
    org ? await mcp(req, res, org) : unauthorized(res);
  });
  app.post("/mcp/:key", express.json({ limit: "4mb" }), async (req, res) => {
    const org = await resolveKey(String(req.params.key));
    org ? await mcp(req, res, org) : unauthorized(res);
  });
  app.all(["/mcp", "/mcp/:key"], methodNotAllowed);
  // The admin panel as MCP (src/admin-mcp.ts): platform admins only, each tool with its route's permission. Before
  // /api/admin below, whose session guard would refuse OAuth access tokens.
  mountAdminMcp(app, PUBLIC_URL);

  // ---------- orchestrator worker API: the fleet token, or a job token bound to one job (src/workerauth.ts) ----------
  const worker = express.Router();
  worker.use((req, res, next) => {
    resolveWorkerToken(bearer(req.headers.authorization)).then((auth) => {
      if (!auth) return void res.status(401).json({ error: "Invalid worker token" });
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
  // Product onboarding research (docs/onboarding.md).
  worker.post("/research/claim", async (req, res) => {
    const { worker_id, limit, research_id } = req.body ?? {};
    if (typeof worker_id !== "string" || !worker_id) return void res.status(400).json({ error: "worker_id is required" });
    const job = jobOnly(res);
    if (job && !job.jobId.startsWith("rsh_")) return void res.json({ jobs: [] });
    const rid = job ? job.jobId : typeof research_id === "string" && research_id ? research_id : undefined;
    res.json({ jobs: await research.claimResearch(worker_id, limit, rid) });
  });
  // Research routes: a job token may act only on its own research.
  worker.use("/research/:id", (req, res, next) => {
    const job = jobOnly(res);
    return !job || job.jobId === String(req.params.id) ? next() : forbidden(res);
  });
  worker.post("/research/:id/progress", async (req, res) => {
    await research.researchProgress(String(req.params.id), String(req.body?.stage ?? "working"), req.body?.note);
    res.status(204).end();
  });
  worker.post("/research/:id/validate", async (req, res) => void res.json(await research.validateResearchJob(String(req.params.id), req.body?.result)));
  worker.post("/research/:id/complete", async (req, res) => {
    try { res.json(await research.completeResearch(String(req.params.id), req.body ?? {})); }
    catch (e) {
      const err = e as Error & { status?: number; issues?: string[] };
      if (err.status === 422) return void res.status(422).json({ error: err.message, issues: err.issues });
      throw e;
    }
  });
  // Web and package search for research (src/websearch.ts): runs here so the search keys never reach the sandbox.
  worker.post("/research/:id/search", async (req, res) => {
    try { res.json(await researchSearch(String(req.params.id), req.body ?? {})); }
    catch (e) {
      const err = e as Error & { status?: number };
      res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({ error: err.message });
    }
  });
  // The shared libraries are Octillion's IP: research (the fleet, or a research job's own token) reads them, a run's job token does not.
  worker.use("/library", (_req, res, next) => {
    const job = jobOnly(res);
    return !job || job.jobId.startsWith("rsh_") ? next() : forbidden(res);
  });
  worker.get("/library/profiles", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await research.libraryProfiles({ query: q.query, limit: q.limit ? Number(q.limit) : undefined }));
  });
  worker.get("/library/tasks", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await research.libraryTasks({ query: q.query, category: q.category, language: q.language, platform: q.platform, limit: q.limit ? Number(q.limit) : undefined }));
  });

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
  // Every staff request is logged (who, what, when, outcome); never the body, which can hold secrets.
  admin.use((req, res, next) => {
    res.on("finish", () => {
      const actor = String(res.locals.adminActor ?? req.headers["x-octillion-actor"] ?? "admin-token").replace(/[^\w.@ -]/g, "").slice(0, 80) || "admin-token";
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
      `/* tenant: admin-only (OCTILLION_ADMIN_TOKEN): global gateway usage */ SELECT provider, coalesce(session_id, orchestrator_id) AS consumer, requests, errors, input_tokens, output_tokens, bytes, last_at
         FROM gateway_usage ORDER BY last_at DESC LIMIT 500`);
    res.json({ usage: rows });
  });
  // Developer populations: the coding-agent mix per population (shares, pauses, sandbox unit).
  admin.get("/populations", async (_req, res) => void res.json({ populations: await populations.listPopulations() }));
  admin.get("/populations/:slug", async (req, res) => void res.json(await populations.getPopulation(String(req.params.slug))));
  admin.post("/populations", need("harnesses"), async (req, res) => {
    const { slug, name, from, description } = req.body ?? {};
    if (typeof slug !== "string" || typeof name !== "string") return void res.status(400).json({ error: "slug and name are required" });
    res.status(201).json(await populations.createPopulation(slug, name, { from, description }));
  });
  admin.patch("/populations/:slug", need("harnesses"), async (req, res) => void res.json(await populations.updatePopulation(String(req.params.slug), req.body ?? {})));
  admin.put("/populations/:slug/agents/:agent", need("harnesses"), async (req, res) => {
    const slug = String(req.params.slug), agent = decodeURIComponent(String(req.params.agent));
    const { market_share, paused, paused_reason, notes } = req.body ?? {};
    if (market_share !== undefined) await populations.setShare(slug, agent, Number(market_share), notes);
    if (paused !== undefined) await populations.setPaused(slug, agent, Boolean(paused), paused_reason);
    res.json(await populations.getPopulation(slug));
  });
  admin.post("/populations/:slug/default", need("harnesses"), async (req, res) => void res.json(await populations.setDefaultPopulation(String(req.params.slug))));
  admin.get("/autoscaler", async (_req, res) => void res.json(await autoscalerStatus()));
  // Onboarding console (web/app/admin, src/admin.ts): requests, accounts, people (Clerk), billing (Stripe), legacy keys.
  // X-Admin-Actor names the person in the log lines; the token is shared, so it is a label, not an identity.
  const ob = express.Router();
  ob.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); }); // responses can carry a new key
  const slug = (req: Request) => String(req.params.slug);
  const done = (res: Response, _?: unknown) => void res.status(204).end();
  ob.get("/overview", async (req, res) => void res.json(await onboarding.overview(req.query)));
  ob.get("/requests", async (req, res) => void res.json({ requests: await onboarding.listRequests(req.query.status ? String(req.query.status) : undefined) }));
  ob.post("/requests/:id/approve", need("requests"), async (req, res) => void res.status(201).json(await onboarding.approveRequest(adminActor(req, res), Number(req.params.id), req.body ?? {})));
  ob.post("/requests/:id/decline", need("requests"), async (req, res) => done(res, await onboarding.declineRequest(adminActor(req, res), Number(req.params.id), req.body?.reason)));
  // Research the company: the quick pass now (it also queues the deep pass on the research harness).
  ob.post("/requests/:id/research", need("requests"), async (req, res) => {
    const id = Number(req.params.id);
    await onboarding.requestExists(id);
    await prospect.researchRequest(id);
    res.json({ ok: true, deep: await prospect.queueDeepResearch(id, { manual: true }) });
  });
  ob.post("/requests/:id/reopen", need("requests"), async (req, res) => done(res, await onboarding.reopenRequest(adminActor(req, res), Number(req.params.id))));
  ob.get("/orgs", async (_req, res) => void res.json(await onboarding.listOrgs()));
  ob.post("/orgs", need("requests"), async (req, res) => void res.status(201).json(await onboarding.createAccount(adminActor(req, res), req.body ?? {})));
  ob.get("/orgs/:slug", async (req, res) => void res.json(await onboarding.orgDetail(slug(req))));
  ob.patch("/orgs/:slug", need("accounts"), async (req, res) => void res.json(await onboarding.renameOrg(adminActor(req, res), slug(req), req.body?.name)));
  ob.post("/orgs/:slug/invitations", need("invite"), async (req, res) => void res.status(201).json(await onboarding.invite(adminActor(req, res), slug(req), req.body?.email, req.body?.role)));
  ob.post("/orgs/:slug/invitations/:id/resend", need("invite"), async (req, res) => void res.status(201).json(await onboarding.resendInvitation(adminActor(req, res), slug(req), String(req.params.id))));
  ob.post("/orgs/:slug/invitations/:id/revoke", need("invite"), async (req, res) => done(res, await onboarding.revokeInvitation(adminActor(req, res), slug(req), String(req.params.id))));
  ob.post("/orgs/:slug/members/:id/deactivate", need("accounts"), async (req, res) => done(res, await onboarding.setMemberActive(adminActor(req, res), slug(req), String(req.params.id), false)));
  ob.post("/orgs/:slug/members/:id/reactivate", need("accounts"), async (req, res) => done(res, await onboarding.setMemberActive(adminActor(req, res), slug(req), String(req.params.id), true)));
  ob.post("/orgs/:slug/members/:id/role", need("accounts"), async (req, res) => done(res, await onboarding.setMemberRole(adminActor(req, res), slug(req), String(req.params.id), req.body?.role)));
  ob.post("/orgs/:slug/clerk", need("accounts"), async (req, res) => void res.json(await onboarding.linkClerk(adminActor(req, res), slug(req))));
  ob.post("/orgs/:slug/billing/customer", need("accounts"), async (req, res) => void res.json({ customer: await onboarding.ensureCustomer(adminActor(req, res), slug(req)) }));
  ob.post("/orgs/:slug/prepaid", need("accounts"), async (req, res) => void res.json(await onboarding.setPrepaidAllowed(adminActor(req, res), slug(req), req.body?.allowed)));
  ob.post("/orgs/:slug/allowance", need("accounts"), async (req, res) => void res.json(await onboarding.setAllowance(adminActor(req, res), slug(req), req.body?.usd ?? null)));
  ob.post("/orgs/:slug/billing/checkout", need("accounts"), async (req, res) => void res.json(await onboarding.checkoutLink(adminActor(req, res), slug(req), req.body?.price_id)));
  ob.post("/orgs/:slug/billing/portal", need("accounts"), async (req, res) => void res.json(await onboarding.portalLink(adminActor(req, res), slug(req))));
  // Plans (src/billing.ts): Stripe prices with an octillion_ lookup key. Owners add one (a product and a price) or archive one.
  ob.get("/plans", async (_req, res) => void res.json(await onboarding.plans()));
  ob.post("/plans", need("plans"), async (req, res) => void res.status(201).json(await onboarding.createPlan(adminActor(req, res), req.body ?? {})));
  ob.post("/plans/:price_id/experiment", need("plans"), async (req, res) => void res.json(await onboarding.setPlanExperiment(adminActor(req, res), String(req.params.price_id), req.body ?? {})));
  ob.post("/plans/:price_id/archive", need("plans"), async (req, res) => void res.json(await onboarding.archivePlan(adminActor(req, res), String(req.params.price_id))));
  ob.post("/orgs/:slug/keys", need("accounts"), async (req, res) => void res.status(201).json(await onboarding.issueKey(adminActor(req, res), slug(req), req.body?.label)));
  ob.post("/orgs/:slug/keys/:id/revoke", need("delete"), async (req, res) => done(res, await onboarding.revokeKey(adminActor(req, res), slug(req), Number(req.params.id))));
  ob.post("/orgs/:slug/keys/:id/rotate", need("delete"), async (req, res) => void res.status(201).json(await onboarding.rotateKey(adminActor(req, res), slug(req), Number(req.params.id))));
  // Platform analytics and health across every account (src/insights.ts).
  ob.get("/analytics", async (req, res) => void res.json(await platformAnalytics(req.query)));
  // Every failure in the period, paged: ?kind=tool|session|onboarding&offset&limit, plus the /analytics filters.
  ob.get("/analytics/errors", async (req, res) => void res.json(await platformErrors(req.query)));
  // Customer journeys (src/playbooks.ts): the use-case pipelines on /app Setup. Admins write them, promote the ones
  // customers see, and order them; adoption = accounts that started / finished each.
  ob.get("/playbooks", async (_req, res) => void res.json({ playbooks: await playbooks.templatesWithAdoption(), tools: TOOL_NAMES }));
  ob.post("/playbooks", need("library"), async (req, res) => void res.status(201).json({ id: await playbooks.createTemplate(adminActor(req, res), req.body ?? {}, TOOL_NAMES) }));
  ob.put("/playbooks/:id", need("library"), async (req, res) => { await playbooks.updateTemplate(adminActor(req, res), String(req.params.id), req.body ?? {}, TOOL_NAMES); res.status(204).end(); });
  ob.post("/playbooks/:id/promote", need("library"), async (req, res) => { await playbooks.setPromoted(adminActor(req, res), String(req.params.id), req.body?.promoted !== false); res.status(204).end(); });
  ob.post("/playbooks/reorder", need("library"), async (req, res) => { await playbooks.reorder(adminActor(req, res), req.body?.ids); res.status(204).end(); });
  ob.delete("/playbooks/:id", need("delete"), async (req, res) => { await playbooks.deleteTemplate(String(req.params.id)); res.status(204).end(); });
  // Journeys: what PostHog Workflows queued for the in-chat channel, and nudges sent by hand.
  ob.get("/journeys", async (_req, res) => void res.json(await journeys.adminView()));
  ob.post("/journeys/nudges", need("journeys"), async (req, res) => void res.status(201).json(await journeys.sendFromAdmin(adminActor(req, res), req.body ?? {})));
  ob.delete("/journeys/nudges/:id", need("journeys"), async (req, res) => { await journeys.adminDelete(adminActor(req, res), Number(req.params.id)); res.status(204).end(); });
  // Shared libraries (src/library.ts): personas and the task library. Edits stamp edited_at, which the vault sync respects.
  ob.get("/personas", async (_req, res) => void res.json(await library.listPersonas()));
  ob.post("/personas", need("library"), async (req, res) => void res.status(201).json(await library.createPersona(adminActor(req, res), req.body ?? {})));
  ob.post("/personas/active", need("library"), async (req, res) => void res.json(await library.setPersonasActive(adminActor(req, res), req.body?.slugs, req.body?.active)));
  ob.patch("/personas/:slug", need("library"), async (req, res) => void res.json(await library.updatePersona(adminActor(req, res), slug(req), req.body ?? {})));
  ob.get("/tasks", async (req, res) => void res.json(await library.listTasks(req.query)));
  ob.post("/tasks", need("library"), async (req, res) => void res.status(201).json(await library.createTask(adminActor(req, res), req.body ?? {})));
  ob.post("/tasks/active", need("library"), async (req, res) => void res.json(await library.setTasksActive(adminActor(req, res), req.body?.ids, req.body?.active)));
  ob.post("/tasks/harnesses", need("library"), async (req, res) => void res.json(await library.setTasksHarnesses(adminActor(req, res), req.body?.ids, req.body?.harnesses)));
  ob.patch("/tasks/:id", need("library"), async (req, res) => void res.json(await library.updateTask(adminActor(req, res), Number(req.params.id), req.body ?? {})));
  // Library contributions from accounts (src/contributions.ts): review on /admin/personas and /admin/tasks (Submissions).
  ob.get("/submissions", async (req, res) => void res.json(await contributions.listSubmissions(req.query)));
  ob.post("/submissions/:id/accept", need("library"), async (req, res) => void res.json(await contributions.accept(adminActor(req, res), String(req.params.id), req.body ?? {})));
  ob.post("/submissions/:id/decline", need("library"), async (req, res) => void res.json(await contributions.decline(adminActor(req, res), String(req.params.id), req.body?.reason)));
  ob.post("/submissions/:id/retry-credit", need("library"), async (req, res) => void res.json(await contributions.retryCredit(adminActor(req, res), String(req.params.id))));
  // Global compute settings (src/settings.ts) and the default population's agent mix.
  ob.get("/compute", async (_req, res) => void res.json(await library.compute()));
  ob.put("/compute/settings", need("compute"), async (req, res) => void res.json(await library.saveSettings(adminActor(req, res), req.body?.values)));
  // Loss reasons (src/reasons.ts): the queue and today's cap. Past losses are queued by every drain, no button.
  ob.get("/compute/reasons", async (_req, res) => void res.json(await reasons.reasonsStatus()));
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
  // The page's only two actions (src/compute-actions.ts), both in the admin audit log: run one autoscaler tick now, and
  // cancel a queued or running session (its orchestrator stops the sandbox at the next heartbeat).
  ob.post("/compute/tick", need("compute"), async (req, res) => void res.json(await actions.runTick(adminActor(req, res))));
  ob.post("/compute/sessions/:id/cancel", need("compute"), async (req, res) => void res.json(await actions.cancelSession(adminActor(req, res), String(req.params.id))));
  // Admin-added harnesses (src/harnesses.ts): variants of a registry.json CLI; a new one joins the mix at weight 0, off.
  ob.get("/compute/harnesses", async (_req, res) => void res.json(await library.listHarnesses()));
  ob.post("/compute/harnesses", need("harnesses"), async (req, res) => void res.status(201).json(await library.addHarness(adminActor(req, res), req.body ?? {})));
  ob.patch("/compute/harnesses/:id", need("harnesses"), async (req, res) => void res.json(await library.editHarness(adminActor(req, res), decodeURIComponent(String(req.params.id)), req.body ?? {})));
  ob.delete("/compute/harnesses/:id", need("delete"), async (req, res) => void res.json(await library.deleteHarness(adminActor(req, res), decodeURIComponent(String(req.params.id)))));
  ob.put("/compute/agents/:agent", need("harnesses"), async (req, res) => void res.json(await library.setAgent(adminActor(req, res), decodeURIComponent(String(req.params.agent)), req.body ?? {})));
  // Model keys on /admin/compute: the key vault (src/keyvault.ts). A secret is posted once; only its hint comes back.
  ob.get("/compute/keys", async (_req, res) => void res.json(await library.modelKeys()));
  // Emails (src/email.ts): the log and its last 24 hours; a test email to an address typed in.
  ob.get("/emails", async (req, res) => void res.json(await mail.emailLog(req.query)));
  ob.post("/emails/test", need("email"), async (req, res) => {
    if (!mail.isEmail(String(req.body?.to ?? "").trim())) throw new onboarding.AdminError("Enter a valid email address");
    const r = await mail.sendTest(adminActor(req, res), req.body.to);
    onboarding.log(adminActor(req, res), "email.test", null, { status: r.status, to_domain: mail.domainOf(String(req.body.to)) });
    res.status(201).json(r);
  });
  ob.get("/compute/sandbox", async (_req, res) => void res.json(await library.sandboxProvider()));
  ob.post("/compute/keys", need("keys"), async (req, res) => void res.status(201).json(await library.addModelKey(adminActor(req, res), req.body ?? {})));
  ob.post("/compute/keys/:id/enabled", need("keys"), async (req, res) => done(res, await library.setModelKeyEnabled(adminActor(req, res), Number(req.params.id), req.body?.enabled)));
  ob.delete("/compute/keys/:id", need("keys"), async (req, res) => done(res, await library.deleteModelKey(adminActor(req, res), Number(req.params.id))));
  ob.post("/compute/providers/:slug/enabled", need("keys"), async (req, res) => done(res, await library.setProviderEnabled(adminActor(req, res), slug(req), req.body?.enabled)));
  // Admins and their roles (src/admin-roles.ts; Clerk user metadata): everyone reads, owners change.
  const changer = (req: Request, res: Response): roles.Changer => ({ actor: adminActor(req, res), userId: (res.locals.adminUserId as string | undefined) ?? null });
  // The Connect page (/admin/connect): the admin MCP URL and which tools each role may call.
  ob.get("/mcp", (_req, res) => void res.json({ url: adminMcpResource(), tools: adminToolList(), skills: adminSkillList() }));
  ob.get("/admins", async (_req, res) => void res.json({ admins: await roles.listAdmins(), roles: roles.PLATFORM_ROLES.map((r) => ({ id: r, label: roles.ROLE_LABELS[r], help: roles.ROLE_HELP[r] })),
    me: (res.locals.adminUserId as string | undefined) ?? null }));
  ob.post("/admins", need("admins"), async (req, res) => {
    const r = await roles.addAdmin(changer(req, res), req.body?.email, req.body?.role);
    onboarding.log(adminActor(req, res), "admin.add", null, { email: req.body?.email, role: req.body?.role, created: r.created });
    res.status(201).json(r);
  });
  ob.post("/admins/:id/role", need("admins"), async (req, res) => {
    const a = await roles.setAdminRole(changer(req, res), String(req.params.id), req.body?.role);
    onboarding.log(adminActor(req, res), "admin.role", null, { user: req.params.id, role: a.role });
    res.json({ admin: a });
  });
  ob.delete("/admins/:id", need("admins"), async (req, res) => {
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
    if (!(err instanceof onboarding.AdminError || err instanceof roles.AdminRoleError || err instanceof journeys.JourneyError || err instanceof playbooks.PlaybookError || err instanceof SettingError || err instanceof ClerkError || err instanceof StripeError)) return next(err);
    // A plan config's problems come as a list too (by path), for the JSON editor.
    const problems = (err as { problems?: string[] }).problems;
    res.status(err.status ?? 400).json({ error: err.message, ...(problems ? { problems } : {}) });
  });
  admin.use("/onboarding", ob);
  app.use("/api/admin", admin);

  // ---------- local preview of the widget (development only) ----------
  if (process.env.OCTILLION_PREVIEW === "1") {
    const isTool = (n: string): n is ToolName => (TOOL_NAMES as string[]).includes(n);
    const keyOf = (req: Request) => String(req.query.key ?? req.body?.key ?? "");
    app.post("/preview/api/tool", express.json(), async (req, res) => {
      const org = await resolveKey(keyOf(req));
      const { name, arguments: args = {} } = req.body ?? {};
      if (!org) return void res.status(401).json({ isError: true, content: [{ type: "text", text: "Invalid key" }] });
      if (!isTool(name)) return void res.status(404).json({ isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] });
      res.json(await runTool(org, name, args));
    });
    app.get("/preview/:tool", async (req, res) => {
      const org = await resolveKey(keyOf(req));
      const name = req.params.tool;
      if (!org) return void res.status(401).send("Pass ?key=<org API key>");
      if (!isTool(name)) return void res.status(404).send(`Unknown tool ${name}`);
      const { key: _key, ...args } = req.query as Record<string, unknown>;
      for (const k of ["days", "offset", "limit", "repeats"]) if (args[k] !== undefined) args[k] = Number(args[k]);
      const result = await runTool(org, name, args);
      const boot = JSON.stringify({ toolEndpoint: "/preview/api/tool", key: keyOf(req), data: result.structuredContent ?? null, error: result.isError ? result.content : null })
        .replace(/</g, "\\u003c");
      res.type("html").send(WIDGET_HTML.replace("<script>", `<script>window.__OCTILLION_PREVIEW__ = ${boot};</script>\n<script>`));
    });
  }

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
    console.error(`octillion (${db.kind}, transcripts in ${transcripts().kind}) listening on http://${HOST}:${PORT}`);
    console.error(`  landing page  ${PUBLIC_URL}/`);
    console.error(`  MCP endpoint  ${PUBLIC_URL}/mcp/<api key>   (or /mcp with Authorization: Bearer <api key>)`);
    console.error(`  worker API    ${PUBLIC_URL}/api/worker/*${process.env.OCTILLION_WORKER_TOKEN ? "" : "   (disabled: set OCTILLION_WORKER_TOKEN)"}`);
    // On-demand orchestrators (boat sandboxes launched/reaped by the server). Needs the public https URL the
    // sandboxes reach us on, the worker token and a boat key in the vault. OCTILLION_AUTOSCALE=off disables it.
    const autoscale = (process.env.OCTILLION_AUTOSCALE ?? "on").toLowerCase() !== "off";
    if (autoscale && /^https:\/\//.test(PUBLIC_URL) && process.env.OCTILLION_WORKER_TOKEN) {
      startAutoscaler();
      console.error("  autoscaler    on (orchestrators on demand; OCTILLION_AUTOSCALE=off to disable)");
    } else console.error(`  autoscaler    off (${autoscale ? "needs an https PUBLIC_URL and OCTILLION_WORKER_TOKEN" : "OCTILLION_AUTOSCALE=off"})`);
    // Off-machine archive of traces and research to R2 (src/archive.ts): backfills, then keeps up every 5 minutes.
    startArchiver();
    console.error(`  archive       ${storageEnabled() ? "on (traces + research to R2)" : "off (R2_* not set)"}`);
  });
  // Graceful drain (deploys, restarts): stop accepting connections, let in-flight requests finish (gateway streams
  // are sandboxed agents' model calls; cutting them fails the sessions), then exit. A rolling deploy starts the new
  // replica first, so new requests land there while this one drains (deploy/rolling-deploy.sh).
  const shutdown = (signal: string) => {
    if (draining) return;
    draining = true;
    const limit = Math.max(0, Number(process.env.OCTILLION_DRAIN_SECONDS ?? 300));
    console.error(`${signal}: draining, in-flight requests get up to ${limit}s`);
    void stopAutoscaler();
    stopArchiver();
    void telemetry.flush();
    server.close(() => { console.error("drained, exiting"); process.exit(0); });
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 1000).unref(); // keep-alive sockets as they go idle
    setTimeout(() => { console.error("drain deadline reached, exiting"); process.exit(0); }, limit * 1000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
