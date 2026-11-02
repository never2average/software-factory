/**
 * The company's own email over HTTP (mold_v0-192; src/company-email.ts, src/email-intake.ts): /api/email, the data
 * behind the console's Settings › Email page. Mounted only when a pack turns it on (pack.json `email`); with none
 * nothing answers.
 *
 *   GET    /api/email                       what the build offers (a sender, intakes and their folders), whether the
 *                                           caller may manage it; for those who may ("manage": owners), the sender and
 *                                           the mailboxes (settings, status, never a secret)
 *   PUT    /api/email/sender                {provider, settings, secret?, enabled?}: set or replace ("manage")
 *   PATCH  /api/email/sender                {enabled}: switch it on or off ("manage")
 *   DELETE /api/email/sender                back to the app's own sender ("manage")
 *   POST   /api/email/sender/test           {to?}: sign in, and send a test email to `to` when given ("manage")
 *   PUT    /api/email/inboxes               {id?, pack?, provider, settings, secret?, poll_minutes?, enabled?} ("manage")
 *   PATCH  /api/email/inboxes/:id           {enabled} ("manage")
 *   DELETE /api/email/inboxes/:id           ("manage")
 *   POST   /api/email/inboxes/:id/test      sign in, open the pack's folder read-only and count it ("manage")
 *   GET    /api/email/attachments/:area/:key/:n   one attachment of a message taken in, as a download, for people of
 *                                           the workspace whose role may read that area
 *
 * The workspace is always the session's (src/app.ts customerSession); a change made with the session cookie carries
 * X-Pack-Request: 1 (CSRF). No answer, log line or audit entry carries a secret, and the audit entries name the
 * provider and the fields changed, never an address or a mailbox's content. There is no /api/admin counterpart: the
 * platform's operators never see a workspace's mail settings, credentials or mail.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import * as ce from "./company-email.js";
import { readAttachment } from "./email-intake.js";
import { PackError } from "./pack-api.js";
import { RECORD_KEY } from "./pack-api.js";

export function emailAppRouter(): Router {
  const r = express.Router();
  if (!ce.companyEmailWired()) return r; // nothing declared: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "32kb" }));
  // The body parser's own error text quotes the body (it may hold a secret): answer without it.
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
      next(e);
    }
  };
  const can = (res: Response) => canAccount(S(res).accountRole, "manage");
  const manage = (res: Response) => { if (!can(res)) throw new PackError(accountRefusal("manage").message, 403); };
  const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;
  const body = (req: Request) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const fieldsOf = (b: Record<string, unknown>) => Object.keys((b.settings ?? {}) as object).sort();

  r.get("/", answer(async (_req, res) => {
    const offer = {
      sender: ce.senderAllowed(),
      intakes: ce.intakeSpecs().map((s) => ({ pack: s.pack, area: s.intake.area, label: s.intake.label ?? null, folder: s.intake.folder })),
      providers: ce.PROVIDERS.map((id) => ({ id, label: ce.PROVIDER_LABELS[id] })),
    };
    if (!can(res)) return { offer, can_manage: false };
    return { offer, can_manage: true, ...(ce.senderAllowed() ? await ce.getSender(S(res).org) : {}), inboxes: ce.intakeSpecs().length ? await ce.listInboxes(S(res).org) : [] };
  }));

  r.put("/sender", answer(async (req, res) => {
    manage(res);
    const b = body(req);
    const out = await ce.putSender(S(res).org, who(res), b);
    log(who(res), "email.sender_updated", S(res).slug, { provider: out.sender?.provider, fields: fieldsOf(b), secret_replaced: typeof b.secret === "string" && b.secret !== "" });
    return out;
  }));
  r.patch("/sender", answer(async (req, res) => {
    manage(res);
    const out = await ce.setSenderEnabled(S(res).org, who(res), body(req).enabled);
    log(who(res), "email.sender_switched", S(res).slug, { enabled: out.sender?.enabled });
    return out;
  }));
  r.delete("/sender", answer(async (_req, res) => {
    manage(res);
    if (!(await ce.deleteSender(S(res).org))) throw new PackError("No sender to remove", 404);
    log(who(res), "email.sender_deleted", S(res).slug, {});
    return { removed: true };
  }));
  r.post("/sender/test", answer(async (req, res) => {
    manage(res);
    const out = await ce.testSender(S(res).org, body(req));
    log(who(res), "email.sender_tested", S(res).slug, { ok: out.ok, sent: out.sent, kind: out.kind });
    return out;
  }));

  r.put("/inboxes", answer(async (req, res) => {
    manage(res);
    const b = body(req);
    const out = await ce.putInbox(S(res).org, who(res), b);
    log(who(res), b.id ? "email.inbox_updated" : "email.inbox_added", S(res).slug, { inbox: out.id, pack: out.pack, provider: out.provider, fields: fieldsOf(b), secret_replaced: typeof b.secret === "string" && b.secret !== "" });
    return out;
  }));
  r.patch("/inboxes/:id", answer(async (req, res) => {
    manage(res);
    const out = await ce.setInboxEnabled(S(res).org, req.params.id, who(res), body(req).enabled);
    log(who(res), "email.inbox_switched", S(res).slug, { inbox: out.id, enabled: out.enabled });
    return out;
  }));
  r.delete("/inboxes/:id", answer(async (req, res) => {
    manage(res);
    await ce.deleteInbox(S(res).org, req.params.id);
    log(who(res), "email.inbox_deleted", S(res).slug, { inbox: req.params.id });
    return { removed: true };
  }));
  r.post("/inboxes/:id/test", answer(async (req, res) => {
    manage(res);
    const out = await ce.testInbox(S(res).org, req.params.id);
    log(who(res), "email.inbox_tested", S(res).slug, { inbox: req.params.id, ok: out.ok, kind: out.kind });
    return out;
  }));

  // An attachment: for anyone of the workspace whose role may read the area (the record pages' own rule); a download,
  // never shown inline (it is whatever a sender attached).
  r.get("/attachments/:area/:key/:n", async (req, res, next) => {
    try {
      const n = Number(req.params.n);
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(req.params.area!) || !RECORD_KEY.test(req.params.key!) || !Number.isInteger(n) || n < 1 || n > 1000) throw new PackError("no such attachment", 404);
      const a = await readAttachment(S(res).org, { role: S(res).accountRole, userId: S(res).user }, req.params.area!, req.params.key!, n);
      res.set({ "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `attachment; filename="${a.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.name)}` });
      res.send(a.data);
    } catch (e) {
      if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
