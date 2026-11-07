/**
 * The workspace credential vault over HTTP (mold_v0-034; src/credentials.ts): /api/credentials, the data behind the
 * console's Settings › Credentials tab (/app/settings?tab=credentials, mold_v0-218). With no pack declaring a credential nothing is mounted.
 *
 *   GET    /api/credentials   a signed-in person of the workspace: the fields the packs declare and, for each stored
 *                             value, its slot (and, for an owner, its last 4 characters). Never a value.
 *                             ?scope=workspace: only the workspace's own (Settings › Credentials, mold_v0-239);
 *                             (and record_areas: the areas whose records have credentials, that this person may read);
 *                             ?area=<area>&key=<key>: one record's (its own page's Credentials card), with its environments;
 *                             ?records=<area>: mold_v0-241, Settings › Credentials' one row per record of that area, in one
 *                             answer: every record the person may read (the area's read permission), its environments and
 *                             its values' slots (no last 4 characters)
 *   PUT    /api/credentials   {pack, name, asset?, environment?, value}: set or replace one value ("manage": an owner);
 *                             {pack, group, asset?, environment?, values: {<field>: <value>}}: every field of a group at once
 *   DELETE /api/credentials   {pack, name | group, asset?, environment?}: remove one, or a group's ("manage")
 *
 * The workspace is the session's (src/app.ts customerSession). A change made with the session cookie carries
 * X-Pack-Request: 1 (CSRF, as the packs' routes). A body that is not JSON is refused without echoing any of it, and no
 * answer or log line carries a value: the audit log records the slot and who, never the value.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { areaCredentials, credentialAreasNow, deleteCredential, deleteCredentialGroup, listCredentials, recordCredentials, setCredential, setCredentialGroup } from "./credentials.js";
import { findArea, may } from "./record-areas.js";
import { featureOn } from "./features.js";
import { PackError } from "./pack-api.js";
import { addCompanyHost, companyEgressPacks, listCompanyHosts, removeCompanyHost } from "./egress-hosts.js";

/**
 * Per-company egress hosts over HTTP (mold_v0-075; src/egress-hosts.ts): /api/egress-hosts. Mounted only when a kind of
 * the build declares company_egress. GET: a signed-in person of the workspace; PUT {pack, host, asset?} and DELETE
 * {pack, host, asset?}: "manage" (an owner). The workspace is the session's.
 */
export function egressHostAppRouter(): Router {
  const r = express.Router();
  if (!companyEgressPacks().length) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "8kb" }));
  r.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
  });
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await fn(req, res)); }
    catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
  };
  const manage = (res: Response) => { if (!canAccount(S(res).accountRole, "manage")) throw new PackError(accountRefusal("manage").message, 403); };
  const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;
  r.get("/", answer(async (_req, res) => ({ hosts: await listCompanyHosts(S(res).org), packs: companyEgressPacks().map((p) => p.id), can_manage: canAccount(S(res).accountRole, "manage") })));
  r.put("/", answer(async (req, res) => {
    manage(res);
    const out = await addCompanyHost(S(res).org, who(res), (req.body ?? {}) as Record<string, unknown>);
    log(who(res), "egress_host.add", S(res).slug, { pack: out.pack, asset: out.asset, host: out.host });
    return out;
  }));
  r.delete("/", answer(async (req, res) => {
    manage(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!(await removeCompanyHost(S(res).org, b))) throw new PackError("no such host", 404);
    log(who(res), "egress_host.remove", S(res).slug, { pack: b.pack, asset: b.asset ?? null, host: b.host });
    return { removed: true };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

export function credentialAppRouter(): Router {
  const r = express.Router();
  // no fields, or the features registry's customer_key_vault off (mold_v0-219): nothing is mounted, nothing answers
  if (!featureOn("customer_key_vault")) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "32kb" }));
  // The body parser's own error text quotes the body: answer without it.
  r.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
  });
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const v = await fn(req, res);
      if (v === undefined) return void res.status(204).end();
      res.json(v);
    } catch (e) {
      if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
      // Anything else is a 500 whose text is never shown (and src/http.ts logs it): ours never carry a value.
      next(e);
    }
  };
  const manage = (res: Response) => { if (!canAccount(S(res).accountRole, "manage")) throw new PackError(accountRefusal("manage").message, 403); };
  const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;
  const slotOf = (b: Record<string, unknown>) => ({ pack: b.pack, ...(b.group !== undefined ? { group: b.group } : { name: b.name }), asset: b.asset ?? null, environment: b.environment ?? null, ...(b.entry ? { entry: b.entry } : {}) });

  // The last 4 characters go to those who manage the values (owners); everyone else sees which are set.
  r.get("/", answer(async (req, res) => {
    const can = canAccount(S(res).accountRole, "manage");
    const q = req.query as Record<string, unknown>;
    const actor = { role: S(res).accountRole ?? null, userId: S(res).user ?? null };
    // mold_v0-241: one area's records, for Settings › Credentials' rows (one request per area, never one per record).
    if (q.records !== undefined) return { ...await areaCredentials(S(res).org, q.records, actor), can_manage: can };
    // mold_v0-239: each credential in its own place: the workspace's on Settings, a record's on the record's page.
    const v = q.area !== undefined || q.key !== undefined ? await recordCredentials(S(res).org, q.area, q.key, actor)
      : await listCredentials(S(res).org, { scope: q.scope === "workspace" ? "workspace" : "all" });
    // Settings › Credentials then asks for the rows of each area whose records have credentials and the person may read.
    const areas = q.scope === "workspace" ? { record_areas: (await credentialAreasNow()).filter((a) => { const x = findArea(a); return !!x && may(x, "read", actor); }) } : {};
    return { ...v, ...areas, values: can ? v.values : v.values.map((x) => ({ ...x, last4: null })), can_manage: can };
  }));
  r.put("/", answer(async (req, res) => {
    manage(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.group !== undefined) {
      const out = await setCredentialGroup(S(res).org, who(res), b);
      for (const o of out) log(who(res), "credential.set", S(res).slug, { pack: o.pack, name: o.name, asset: o.asset, environment: o.environment });
      return { values: out };
    }
    const out = await setCredential(S(res).org, who(res), b);
    log(who(res), "credential.set", S(res).slug, { pack: out.pack, name: out.name, asset: out.asset, environment: out.environment, ...(out.entry ? { entry: out.entry } : {}) });
    return out;
  }));
  r.delete("/", answer(async (req, res) => {
    manage(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const removed = b.group !== undefined ? await deleteCredentialGroup(S(res).org, b) : await deleteCredential(S(res).org, b);
    if (!removed) throw new PackError("no such value", 404);
    log(who(res), "credential.remove", S(res).slug, slotOf(b));
    return { removed };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
