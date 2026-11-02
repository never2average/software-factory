/**
 * /api/developer: the console's side of the developer surface (mold_v0-193), for a signed-in person of a workspace (the
 * portal's session, src/app.ts customerSession). Reading needs the account's `read`; every change, and reading a
 * webhook secret again, needs `manage` (an owner). A change riding the session cookie carries X-Pack-Request: 1 (CSRF,
 * as the data API). Empty in a build without a developer surface.
 *
 *   GET    /                               what the app offers: events, scopes, versions, the OpenAPI document's address
 *   GET    /keys                           the workspace's API keys (prefix, scopes, state; never a key)
 *   POST   /keys                           {name, kind?, scopes?, expires_in_days?}: a key, answered once
 *   POST   /keys/:id/rotate                {grace_hours?, expires_in_days?}: a new key, answered once; the old one kept for the grace
 *   POST   /keys/:id/revoke
 *   GET    /origins | POST /origins {origin} | DELETE /origins?origin=
 *   GET    /webhooks | POST /webhooks {url, events?, description?} | PATCH /webhooks/:id | DELETE /webhooks/:id
 *   POST   /webhooks/:id/rotate | POST /webhooks/:id/reveal (recorded) | POST /webhooks/:id/test | GET /webhooks/:id/deliveries
 *   GET    /sources | POST /sources {receiver, description?} | DELETE /sources/:id
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount, type AccountPermission } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import { auditPlatform } from "./developer-audit.js";
import { API_VERSIONS, BASE_SCOPES, SDK_LANGUAGES } from "./developer-config.js";
import { createDeveloperKey, listDeveloperKeys, revokeDeveloperKey, rotateDeveloperKey } from "./developer-keys.js";
import { addOrigin, listOrigins, removeOrigin } from "./developer-sessions.js";
import { ApiProblem, currentApiVersion, developerSurface } from "./developer-surface.js";
import * as hooks from "./developer-webhooks.js";
import { createSource, deleteSource, listSources } from "./developer-inbound.js";
import { endpointLimit } from "./rate-limits.js";

const S = (res: Response) => res.locals.session as Session;
const who = (res: Response) => `member:${S(res).user ?? "?"}`;
function may(res: Response, p: AccountPermission) {
  if (!canAccount(S(res).accountRole, p)) { const r = accountRefusal(p); throw new ApiProblem(403, r.code, r.message); }
}
const answer = (p: AccountPermission, fn: (req: Request, res: Response) => Promise<unknown>, status = 200) => async (req: Request, res: Response) => {
  try {
    may(res, p);
    const v = await fn(req, res);
    if (v === undefined) return void res.status(204).end();
    res.status(status).json(v);
  } catch (e) {
    if (e instanceof ApiProblem) return void res.status(e.status).json({ error: e.message, code: e.code });
    console.error(e);
    res.status(500).json({ error: "Internal error" });
  }
};
const body = (req: Request) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

export function developerAppRouter(): Router {
  const r = express.Router();
  const cfg = developerSurface();
  if (!cfg) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "64kb" }));
  r.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) =>
    (err ? void res.status(err.status && err.status < 500 ? err.status : 400).json({ error: "The request body must be JSON" }) : next()));
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));

  r.get("/", answer("read", async () => ({
    openapi: "/openapi.json", api_versions: API_VERSIONS, api_version: currentApiVersion(), scopes: BASE_SCOPES, sdk_languages: cfg.sdk_languages.filter((l) => (SDK_LANGUAGES as readonly string[]).includes(l)),
    events: hooks.eventCatalog(), client_sessions: { ttl_seconds: cfg.client_sessions.ttl_seconds, scopes: cfg.client_sessions.scopes ?? ["read", "write"], allowed_origins: cfg.client_sessions.allowed_origins },
    receivers: (cfg.webhooks_in ?? []).map((x) => ({ name: x.name, description: x.description ?? null, area: x.area })),
  })));

  r.get("/keys", answer("read", async (_q, res) => ({ data: await listDeveloperKeys(S(res).org) })));
  r.post("/keys", endpointLimit("key", (_req, res) => `developer:${(res.locals.session as Session).slug}`) as express.RequestHandler, answer("manage", async (req, res) => {
    const made = await createDeveloperKey(S(res).org, body(req), who(res));
    auditPlatform({ orgId: S(res).org, action: "key.create", actor: who(res), target: made.row.key_prefix, scopes: made.row.scopes });
    return { key: made.key, data: made.row };
  }, 201));
  r.post("/keys/:id/rotate", answer("manage", async (req, res) => {
    const made = await rotateDeveloperKey(S(res).org, Number(req.params.id), body(req), who(res));
    auditPlatform({ orgId: S(res).org, action: "key.rotate", actor: who(res), target: made.previous.key_prefix });
    return { key: made.key, data: made.row, previous: made.previous };
  }));
  r.post("/keys/:id/revoke", answer("manage", async (req, res) => {
    const k = await revokeDeveloperKey(S(res).org, Number(req.params.id), who(res));
    auditPlatform({ orgId: S(res).org, action: "key.revoke", actor: who(res), target: k.key_prefix });
    return { data: k };
  }));

  r.get("/origins", answer("read", async (_q, res) => ({ data: await listOrigins(S(res).org), app: cfg.client_sessions.allowed_origins })));
  r.post("/origins", answer("manage", async (req, res) => { await addOrigin(S(res).org, body(req).origin, who(res)); return { data: await listOrigins(S(res).org) }; }));
  r.delete("/origins", answer("manage", async (req, res) => {
    if (!(await removeOrigin(S(res).org, String(req.query.origin ?? "")))) throw new ApiProblem(404, "not_found", "that origin is not allowed here");
    return { data: await listOrigins(S(res).org) };
  }));

  r.get("/webhooks", answer("read", async (_q, res) => ({ data: await hooks.listEndpoints(S(res).org) })));
  r.post("/webhooks", answer("manage", async (req, res) => ({ data: await hooks.createEndpoint(S(res).org, body(req), who(res)) }), 201));
  r.patch("/webhooks/:id", answer("manage", async (req, res) => ({ data: await hooks.updateEndpoint(S(res).org, String(req.params.id), body(req)) })));
  r.delete("/webhooks/:id", answer("manage", async (req, res) => {
    if (!(await hooks.deleteEndpoint(S(res).org, String(req.params.id)))) throw new ApiProblem(404, "not_found", "No such webhook endpoint");
  }));
  r.post("/webhooks/:id/rotate", answer("manage", async (req, res) => ({ data: await hooks.rotateEndpointSecret(S(res).org, String(req.params.id), body(req), who(res)) })));
  r.post("/webhooks/:id/reveal", answer("manage", async (req, res) => ({ data: await hooks.revealWebhookSecret(S(res).org, String(req.params.id), who(res)) })));
  r.post("/webhooks/:id/test", answer("manage", async (req, res) => ({ data: await hooks.testEndpoint(S(res).org, String(req.params.id)) })));
  r.get("/webhooks/:id/deliveries", answer("read", async (req, res) => hooks.listDeliveries(S(res).org, String(req.params.id), req.query as Record<string, unknown>)));

  if (cfg.webhooks_in?.length) {
    r.get("/sources", answer("read", async (_q, res) => ({ data: await listSources(S(res).org) })));
    r.post("/sources", answer("manage", async (req, res) => ({ data: await createSource(S(res).org, body(req), who(res)) }), 201));
    r.delete("/sources/:id", answer("manage", async (req, res) => {
      if (!(await deleteSource(S(res).org, String(req.params.id)))) throw new ApiProblem(404, "not_found", "No such inbound source");
    }));
  }
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
