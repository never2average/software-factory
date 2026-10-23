// Fake Clerk Backend API + Stripe + Resend for the smoke test only: scripts/smoke.ts starts it in memory on 127.0.0.1 and points
// CLERK_API_URL / STRIPE_API_URL at it. Never mounted by the server; production always talks to the real services.
// Not a simulator of either product: only the fields the app reads, with the same shapes.
// Test hooks: POST /_mock/clerk/users {email, first_name?, verified?, platform_admin?, platform_role?}, POST /_mock/invitations/:id/accept
// {first_name?}, POST /_mock/clerk/memberships {org_id, user_id, role?, public_metadata?}, POST /_mock/session {user_id, org_id?, org_role?,
// azp?, expired?, v1?} -> a Clerk session token, POST /_mock/oauth {user_id, jwt?, revoked?, expired?, aud?, iss?} -> an OAuth
// access token, GET /_mock/public-key -> {pem} for CLERK_JWT_KEY, POST /_mock/subscriptions {customer, price, status?, start_date?, trial_end?,
// ended_at?, canceled_at?, cancel_at_period_end?, current_period_end?, quantity?, invoice? (default true: one paid invoice now)},
// POST /_mock/prices {id, unit_amount, interval, ...} (an archived price: not listed with active=true), POST /v1/products and
// POST /v1/prices (plans made on FinOps; lookup keys unique) and POST /v1/prices/:id (active=false archives; metadata merges,
// "" removes a key), POST /v1/checkout/sessions (stored, listed by GET /v1/checkout/sessions; POST /_mock/checkout/:id/complete
// {status?, trial_end?} turns one into a subscription carrying its subscription_data metadata, like a paid checkout),
// POST /_mock/invoices {customer, amount, status?, created?, paid_at?, subscription?, number?}, POST /_mock/stripe/outage {down} (customer
// balance transactions answer 500 while down). Times are Unix seconds.
// Resend: POST /emails (Bearer re_...; an Idempotency-Key header returns the first email's id again for the same body, 409
// for a different one); every accepted email is in state.emails. POST /_mock/resend/outage {down} (POST /emails answers 500).
// Cloudflare Workers AI: POST /client/v4/accounts/:id/ai/v1/chat/completions (Bearer); state.aiRequests logs each body and
// state.aiReply(body) decides the answer (in-process only; unset: 503).
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { exportJWK, exportSPKI, generateKeyPair, importJWK, SignJWT } from "jose";
import { KEY_PREFIX } from "../../src/namespace.js";
import { PROFILE } from "../../src/profile.js";

export interface MockPersistence { load(): Promise<string | null>; save(state: string): Promise<void> }

const id = (p: string) => `${p}_${randomBytes(10).toString("hex").toUpperCase()}`;
const now = () => new Date().toISOString();

export async function createMockApp(getBase: () => string, persist?: MockPersistence) {
  const saved = persist ? JSON.parse((await persist.load()) ?? "null") : null;
  // The signing key survives restarts in persisted mode (tokens issued earlier keep verifying).
  const { publicKey, privateKey } = saved?.keys
    ? { publicKey: await importJWK(saved.keys.pub, "RS256", { extractable: true }), privateKey: await importJWK(saved.keys.priv, "RS256") }
    : await generateKeyPair("RS256", { extractable: true });
  const keyJson = saved?.keys ?? { pub: await exportJWK(publicKey), priv: await exportJWK(privateKey) };
  const jwk = { ...keyJson.pub, kid: "mock-1", alg: "RS256", use: "sig" };
  const s = {
    orgs: new Map<string, any>(), invitations: new Map<string, any>(), memberships: new Map<string, any>(), users: new Map<string, any>(),
    customers: new Map<string, any>(), subscriptions: new Map<string, any>(), checkouts: [] as any[], meters: [] as any[], meterEvents: [] as any[], invoices: [] as any[], balanceTxns: [] as any[], stripeDown: false,
    oauth: new Map<string, any>(), keyed: new Map<string, any>(),
    emails: [] as any[], resendKeys: new Map<string, { id: string; body: string }>(), resendDown: false,
    // Cloudflare Workers AI: every chat request (its body), and how to answer one (status and/or content; unset: 503).
    aiRequests: [] as any[], aiReply: null as null | ((body: any) => { status?: number; content?: string }),
    prices: [
      { id: "price_mock_starter", object: "price", active: true, lookup_key: `${KEY_PREFIX}starter`, unit_amount: 49900, currency: "usd", recurring: { interval: "month" },
        nickname: "Starter", metadata: { monthly_budget_usd: "300" }, product: { id: "prod_mock_1", name: PROFILE.name, metadata: {} } },
      { id: "price_mock_growth", object: "price", active: true, lookup_key: `${KEY_PREFIX}growth`, unit_amount: 149900, currency: "usd", recurring: { interval: "month" },
        nickname: "Growth", metadata: { monthly_budget_usd: "1500" }, product: { id: "prod_mock_1", name: PROFILE.name, metadata: {} } },
      { id: "price_unrelated", object: "price", active: true, lookup_key: "other_thing", unit_amount: 100, currency: "usd", recurring: null, nickname: null, metadata: {}, product: { name: "x", metadata: {} } },
    ] as any[],
    products: [] as any[],
  };
  const app = express();
  const MAPS = ["orgs", "invitations", "memberships", "users", "customers", "subscriptions", "oauth", "keyed"] as const;
  const dump = () => JSON.stringify({ keys: keyJson, meterEvents: s.meterEvents, invoices: s.invoices, balanceTxns: s.balanceTxns, checkouts: s.checkouts, meters: s.meters,
    ...Object.fromEntries(MAPS.map((k) => [k, [...(s[k] as Map<string, unknown>).entries()]])) });
  const restore = (j: any) => {
    for (const k of MAPS) { const m = s[k] as Map<string, unknown>; m.clear(); for (const [a, b] of j[k] ?? []) m.set(a, b); }
    s.meterEvents.splice(0, s.meterEvents.length, ...(j.meterEvents ?? []));
    s.invoices.splice(0, s.invoices.length, ...(j.invoices ?? []));
    s.balanceTxns.splice(0, s.balanceTxns.length, ...(j.balanceTxns ?? []));
    s.checkouts.splice(0, s.checkouts.length, ...(j.checkouts ?? []));
    s.meters.splice(0, s.meters.length, ...(j.meters ?? []));
  };
  if (saved) restore(saved);
  if (persist) app.use(async (_req, res, next) => {
    const j = await persist.load();
    if (j) restore(JSON.parse(j));
    const before = dump();
    // Save before the response ends: a serverless function may be frozen right after it.
    const end = res.end.bind(res) as (...a: unknown[]) => typeof res;
    res.end = ((...a: unknown[]) => {
      const after = dump();
      if (after === before) return end(...a);
      persist.save(after).catch((e) => console.error("mock state save failed:", e.message)).finally(() => end(...a));
      return res;
    }) as typeof res.end;
    next();
  });
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const page = (data: any[]) => ({ object: "list", data, list_metadata: { before: null, after: null } });
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) =>
    /^Bearer \S+/.test(req.get("authorization") ?? "") ? next() : void res.status(401).json({ message: "Unauthorized" });

  const pem = await exportSPKI(publicKey as Parameters<typeof exportSPKI>[0]);
  const ms = () => Date.now();
  const clerkErr = (res: express.Response, status: number, message: string, code = "form_param_invalid") =>
    void res.status(status).json({ errors: [{ message, long_message: message, code }] });
  const list = (data: any[]) => ({ data, total_count: data.length });
  const userJson = (u: any) => u;
  const membershipJson = (m: any) => {
    const u = s.users.get(m.user_id);
    const e = u?.email_addresses.find((x: any) => x.id === u.primary_email_address_id);
    return { object: "organization_membership", id: m.id, role: m.role, public_metadata: m.public_metadata ?? {}, created_at: m.created_at,
      organization: s.orgs.get(m.organization_id), public_user_data: { user_id: m.user_id, identifier: e?.email_address ?? null, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null } };
  };
  const newUser = (email: string, opts: { first_name?: string | null; verified?: boolean; platform_admin?: boolean; platform_role?: string } = {}) => {
    const eid = id("idn");
    const u = { object: "user", id: id("user"), first_name: opts.first_name ?? null, last_name: null, primary_email_address_id: eid,
      email_addresses: [{ id: eid, email_address: email.toLowerCase(), verification: { status: opts.verified === false ? "unverified" : "verified" } }],
      public_metadata: { ...(opts.platform_admin ? { platform_admin: true } : {}), ...(opts.platform_role ? { platform_role: opts.platform_role } : {}) },
      last_sign_in_at: null, created_at: ms() };
    s.users.set(u.id, u);
    return u;
  };
  const userByEmail = (email: string) => [...s.users.values()].find((u) => u.email_addresses.some((e: any) => e.email_address === email.toLowerCase()));
  const addMembership = (orgId: string, userId: string, role: string) => {
    const m = { id: id("orgmem"), organization_id: orgId, user_id: userId, role, public_metadata: {}, created_at: ms() };
    s.memberships.set(`${orgId}:${userId}`, m);
    return m;
  };

  // ---------- Clerk Frontend API (the OAuth authorization server for /mcp) ----------
  app.get("/.well-known/oauth-authorization-server", (_req, res) => void res.json({
    issuer: getBase(), authorization_endpoint: `${getBase()}/oauth/authorize`, token_endpoint: `${getBase()}/oauth/token`, registration_endpoint: `${getBase()}/oauth/register`,
    jwks_uri: `${getBase()}/.well-known/jwks.json`, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true }));

  // ---------- Clerk Backend API (/v1, Bearer secret key) ----------
  const c = express.Router();
  c.use(auth);
  c.get("/v1/jwks", (_req, res) => void res.json({ keys: [jwk] }));
  c.post("/v1/organizations", (req, res) => {
    const { name, slug, public_metadata } = req.body ?? {};
    if (!name) return clerkErr(res, 422, "name is required");
    if (slug && [...s.orgs.values()].some((o) => o.slug === slug)) return clerkErr(res, 422, "That slug is taken. Please try another.", "form_identifier_exists");
    const o = { object: "organization", id: id("org"), name, slug: slug ?? null, public_metadata: public_metadata ?? {}, private_metadata: {}, created_at: ms(), updated_at: ms() };
    s.orgs.set(o.id, o); res.json(o);
  });
  c.get("/v1/organizations", (_req, res) => void res.json(list([...s.orgs.values()])));
  c.get("/v1/organizations/:id", (req, res) => { const o = s.orgs.get(req.params.id); o ? res.json(o) : clerkErr(res, 404, "Organization not found", "resource_not_found"); });
  c.patch("/v1/organizations/:id", (req, res) => {
    const o = s.orgs.get(req.params.id); if (!o) return clerkErr(res, 404, "Organization not found", "resource_not_found");
    if (req.body?.name !== undefined) o.name = req.body.name;
    o.updated_at = ms(); res.json(o);
  });
  c.patch("/v1/organizations/:id/metadata", (req, res) => {
    const o = s.orgs.get(req.params.id); if (!o) return clerkErr(res, 404, "Organization not found", "resource_not_found");
    o.public_metadata = { ...o.public_metadata, ...(req.body?.public_metadata ?? {}) }; res.json(o);
  });
  c.post("/v1/organizations/:id/invitations", (req, res) => {
    const orgId = req.params.id; if (!s.orgs.has(orgId)) return clerkErr(res, 404, "Organization not found", "resource_not_found");
    const email = String(req.body?.email_address ?? "").toLowerCase();
    if (!email) return clerkErr(res, 422, "email_address is required");
    // Like Clerk: inviting an address that already has a pending invitation revokes the old one and sends a new one.
    for (const x of s.invitations.values())
      if (x.email_address === email && x.organization_id === orgId && x.status === "pending") Object.assign(x, { status: "revoked", updated_at: ms() });
    const inv = { object: "organization_invitation", id: id("orginv"), email_address: email, role: req.body?.role ?? "org:member", status: "pending",
      public_metadata: req.body?.public_metadata ?? {}, organization_id: orgId, created_at: ms(), updated_at: ms(), expires_at: ms() + 30 * 86_400_000 };
    s.invitations.set(inv.id, inv); res.json(inv);
  });
  c.get("/v1/organizations/:id/invitations", (req, res) =>
    void res.json(list([...s.invitations.values()].filter((x) => x.organization_id === req.params.id).reverse())));
  c.post("/v1/organizations/:id/invitations/:inv/revoke", (req, res) => {
    const inv = s.invitations.get(req.params.inv);
    if (!inv || inv.organization_id !== req.params.id) return clerkErr(res, 404, "Invitation not found", "resource_not_found");
    if (inv.status !== "pending") return clerkErr(res, 404, "The organization invitation is not in the 'pending' status.", "resource_not_found");
    Object.assign(inv, { status: "revoked", updated_at: ms() }); res.json(inv);
  });
  c.get("/v1/organizations/:id/memberships", (req, res) =>
    void res.json(list([...s.memberships.values()].filter((m) => m.organization_id === req.params.id).map(membershipJson))));
  const mem = (req: express.Request) => s.memberships.get(`${req.params.id}:${req.params.user}`);
  c.patch("/v1/organizations/:id/memberships/:user", (req, res) => {
    const m = mem(req); if (!m) return clerkErr(res, 404, "Membership not found", "resource_not_found");
    if (req.body?.role) m.role = req.body.role;
    res.json(membershipJson(m));
  });
  c.patch("/v1/organizations/:id/memberships/:user/metadata", (req, res) => {
    const m = mem(req); if (!m) return clerkErr(res, 404, "Membership not found", "resource_not_found");
    m.public_metadata = { ...m.public_metadata, ...(req.body?.public_metadata ?? {}) }; res.json(membershipJson(m));
  });
  c.delete("/v1/organizations/:id/memberships/:user", (req, res) => {
    const m = mem(req); if (!m) return clerkErr(res, 404, "Membership not found", "resource_not_found");
    s.memberships.delete(`${req.params.id}:${req.params.user}`); res.json(membershipJson(m));
  });
  c.get("/v1/users", (req, res) => {
    const emails = ([] as unknown[]).concat(req.query.email_address ?? []).map((e) => String(e).toLowerCase());
    const all = [...s.users.values()].filter((u) => !emails.length || u.email_addresses.some((e: any) => emails.includes(e.email_address)));
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 10);
    res.json(all.slice(offset, offset + limit).map(userJson));
  });
  c.post("/v1/users", (req, res) => {
    const email = String(req.body?.email_address?.[0] ?? "");
    if (!email) return clerkErr(res, 422, "email_address is required");
    if (userByEmail(email)) return clerkErr(res, 422, "That email address is taken. Please try another.", "form_identifier_exists");
    const u = newUser(email, { verified: true });
    u.public_metadata = req.body?.public_metadata ?? {};
    res.json(userJson(u));
  });
  c.patch("/v1/users/:id/metadata", (req, res) => {
    const u = s.users.get(req.params.id); if (!u) return clerkErr(res, 404, "User not found", "resource_not_found");
    // Like Clerk: a deep merge where null removes the key.
    const md = { ...u.public_metadata, ...(req.body?.public_metadata ?? {}) };
    for (const [k, v] of Object.entries(md)) if (v === null) delete md[k];
    u.public_metadata = md; res.json(userJson(u));
  });
  c.get("/v1/users/:id", (req, res) => { const u = s.users.get(req.params.id); u ? res.json(userJson(u)) : clerkErr(res, 404, "User not found", "resource_not_found"); });
  c.get("/v1/users/:id/organization_memberships", (req, res) =>
    void res.json(list([...s.memberships.values()].filter((m) => m.user_id === req.params.id).map(membershipJson))));
  c.post("/v1/oauth_applications/access_tokens/verify", (req, res) => {
    const t = s.oauth.get(String(req.body?.access_token ?? ""));
    if (!t) return clerkErr(res, 404, "OAuth access token not found", "resource_not_found");
    res.json({ object: "clerk_idp_oauth_access_token", id: t.id, client_id: "mock_client", type: "oauth_token", subject: t.user_id, scopes: ["profile", "email"],
      revoked: Boolean(t.revoked), expired: Boolean(t.expired), expiration: ms() + 3_600_000, created_at: t.created_at, updated_at: t.created_at, ...(t.aud ? { aud: t.aud } : {}) });
  });

  // ---------- Stripe (form-encoded) ----------
  const st = express.Router();
  st.use(auth);
  // Like Stripe: an expand deeper than 4 levels is refused (data.items.data.price.product is 5).
  st.use((req, res, next) => {
    const ex = ([] as unknown[]).concat(req.query["expand[]"] ?? req.query.expand ?? []).map(String);
    const deep = ex.find((e) => e.split(".").length > 4);
    if (deep) return void res.status(400).json({ error: { message: `You cannot expand more than 4 levels of a property. Property: ${deep}` } });
    next();
  });
  const keyed = s.keyed;
  st.post("/v1/customers", (req, res) => {
    const k = req.get("idempotency-key");
    if (k && keyed.has(k)) return void res.json(keyed.get(k));
    const c = { id: id("cus"), object: "customer", name: req.body.name, email: req.body.email ?? null, metadata: req.body.metadata ?? {} };
    s.customers.set(c.id, c); if (k) keyed.set(k, c); res.json(c);
  });
  st.get("/v1/prices", (req, res) => {
    const lk = req.query["lookup_keys[]"] ?? req.query.lookup_keys, keys = lk == null ? null : ([] as unknown[]).concat(lk).map(String);
    res.json({ object: "list", data: s.prices.filter((p) => (req.query.active !== "true" || p.active) && (!keys || keys.includes(p.lookup_key))), has_more: false });
  });
  st.get("/v1/prices/:id", (req, res) => {
    const p = s.prices.find((x) => x.id === req.params.id);
    if (!p) return void res.status(404).json({ error: { message: `No such price: '${req.params.id}'` } });
    res.json({ ...p, product: p.product?.id ?? p.product });
  });
  // Plans made on FinOps: a product, then a price on it (lookup keys unique, like Stripe), then active=false to archive.
  st.post("/v1/products", (req, res) => {
    const k = req.get("idempotency-key");
    if (k && keyed.has(k)) return void res.json(keyed.get(k));
    const p = { id: id("prod"), object: "product", active: true, name: req.body.name, description: req.body.description ?? null, tax_code: req.body.tax_code ?? null, metadata: req.body.metadata ?? {} };
    s.products.push(p); if (k) keyed.set(k, p); res.json(p);
  });
  st.get("/v1/products", (_req, res) => void res.json({ object: "list", data: [{ id: "prod_mock_1", object: "product", name: PROFILE.name, metadata: {} }, ...s.products], has_more: false }));
  st.post("/v1/prices", (req, res) => {
    const k = req.get("idempotency-key");
    if (k && keyed.has(k)) return void res.json(keyed.get(k));
    const b = req.body, product = s.products.find((p) => p.id === b.product);
    if (!product) return void res.status(400).json({ error: { message: `No such product: '${b.product}'` } });
    if (b.lookup_key && s.prices.some((p) => p.lookup_key === b.lookup_key))
      return void res.status(400).json({ error: { message: `A price (\`${b.lookup_key}\`) already uses that lookup key.` } });
    if (b.recurring?.usage_type === "metered" && !s.meters.some((m) => m.id === b.recurring.meter))
      return void res.status(400).json({ error: { message: `No such billing meter: '${b.recurring?.meter}'` } });
    const price = { id: id("price"), object: "price", active: true, lookup_key: b.lookup_key ?? null, unit_amount: b.unit_amount == null ? null : Number(b.unit_amount), currency: b.currency,
      recurring: b.recurring ? { interval: b.recurring.interval, interval_count: Number(b.recurring.interval_count ?? 1), usage_type: b.recurring.usage_type ?? "licensed", meter: b.recurring.meter ?? null } : null,
      billing_scheme: b.billing_scheme ?? "per_unit", tiers_mode: b.tiers_mode ?? null,
      tiers: b.tiers ? ([] as any[]).concat(Object.values(b.tiers)).map((t: any) => ({ up_to: t.up_to === "inf" ? null : Number(t.up_to), unit_amount: null, unit_amount_decimal: t.unit_amount_decimal ?? null })) : undefined,
      nickname: b.nickname ?? null,
      metadata: b.metadata ?? {}, created: Math.floor(Date.now() / 1000), product: { id: product.id, name: product.name, description: product.description, metadata: product.metadata } };
    s.prices.push(price);
    const out = { ...price, product: product.id };
    if (k) keyed.set(k, out); res.json(out);
  });
  st.post("/v1/prices/:id", (req, res) => {
    const p = s.prices.find((x) => x.id === req.params.id);
    if (!p) return void res.status(404).json({ error: { message: `No such price: '${req.params.id}'` } });
    if (req.body.active != null) p.active = String(req.body.active) === "true";
    for (const [k, v] of Object.entries(req.body.metadata ?? {})) { if (v === "") delete p.metadata[k]; else p.metadata[k] = String(v); }
    res.json({ ...p, product: p.product?.id ?? p.product });
  });
  // A subscription's prices name their product by id, as Stripe does without an expand.
  const unexpanded = (sub: any) => ({ ...sub, items: { data: sub.items.data.map((it: any) => ({ ...it, price: it.price && { ...it.price, product: it.price.product?.id ?? it.price.product } })) } });
  st.get("/v1/subscriptions", (req, res) =>
    void res.json({ object: "list", data: [...s.subscriptions.values()].filter((x) => !req.query.customer || x.customer === req.query.customer).map(unexpanded), has_more: false }));
  st.post("/v1/checkout/sessions", (req, res) => {
    if (!s.customers.has(req.body.customer)) return void res.status(400).json({ error: { message: "No such customer" } });
    const b = req.body, cs = { id: id("cs"), object: "checkout.session", created: Math.floor(Date.now() / 1000), status: "open", mode: b.mode, customer: b.customer,
      price: b.line_items?.[0]?.price, line_items: ([] as any[]).concat(Object.values(b.line_items ?? {})), metadata: b.metadata ?? {}, subscription_data: b.subscription_data ?? {}, subscription: null as string | null,
      url: `${getBase()}/checkout/${b.customer}/${b.line_items?.[0]?.price}` };
    s.checkouts.push(cs);
    res.json(cs);
  });
  st.get("/v1/billing/meters", (_req, res) => void res.json({ object: "list", data: s.meters, has_more: false }));
  st.post("/v1/billing/meters", (req, res) => {
    const k = req.get("idempotency-key");
    if (k && keyed.has(k)) return void res.json(keyed.get(k));
    const b = req.body;
    if (s.meters.some((m) => m.event_name === b.event_name)) return void res.status(400).json({ error: { message: `A meter with event_name ${b.event_name} already exists` } });
    const m = { id: id("mtr"), object: "billing.meter", status: "active", event_name: b.event_name, display_name: b.display_name, default_aggregation: b.default_aggregation,
      customer_mapping: b.customer_mapping, value_settings: b.value_settings };
    s.meters.push(m); if (k) keyed.set(k, m); res.json(m);
  });
  st.get("/v1/checkout/sessions", (_req, res) => void res.json({ object: "list", data: s.checkouts.map(({ subscription_data: _sd, price: _p, ...x }) => x), has_more: false }));
  st.post("/v1/billing_portal/sessions", (req, res) => void res.json({ id: id("bps"), url: `${getBase()}/billing/${req.body.customer}` }));
  st.get("/v1/invoices", (req, res) => void res.json({ object: "list", data: s.invoices.filter((i) => !req.query.customer || i.customer === req.query.customer), has_more: false }));
  // Customer balance transactions (credits are negative amounts), with Stripe's idempotency keys.
  st.post("/v1/customers/:id/balance_transactions", (req, res) => {
    if (s.stripeDown) return void res.status(500).json({ error: { message: "Stripe is having trouble (mock outage)" } });
    if (!s.customers.has(req.params.id)) return void res.status(404).json({ error: { message: `No such customer: '${req.params.id}'` } });
    const k = req.get("idempotency-key");
    if (k && keyed.has(k)) return void res.json(keyed.get(k));
    const t = { id: id("cbtxn"), object: "customer_balance_transaction", customer: req.params.id, amount: Number(req.body.amount), currency: req.body.currency ?? "usd",
      description: req.body.description ?? null, metadata: req.body.metadata ?? {}, type: "adjustment", created: Math.floor(Date.now() / 1000) };
    s.balanceTxns.push(t); if (k) keyed.set(k, t); res.json(t);
  });
  st.get("/v1/customers/:id/balance_transactions", (req, res) => {
    if (s.stripeDown) return void res.status(500).json({ error: { message: "Stripe is having trouble (mock outage)" } });
    res.json({ object: "list", data: s.balanceTxns.filter((t) => t.customer === req.params.id).reverse(), has_more: false });
  });
  st.post("/v1/billing/meter_events", (req, res) => {
    if (!s.meterEvents.some((e) => e.identifier === req.body.identifier)) s.meterEvents.push(req.body);
    res.json({ object: "billing.meter_event", ...req.body });
  });

  // ---------- test hooks ----------
  app.get("/_mock/public-key", (_req, res) => void res.json({ pem }));
  app.post("/_mock/clerk/users", (req, res) => {
    const email = String(req.body?.email ?? "");
    if (!email) return void res.status(400).end();
    res.json(userByEmail(email) ?? newUser(email, req.body));
  });
  app.post("/_mock/invitations/:id/accept", (req, res) => {
    const inv = s.invitations.get(req.params.id); if (!inv) return void res.status(404).end();
    const user = userByEmail(inv.email_address) ?? newUser(inv.email_address, { first_name: req.body?.first_name ?? null });
    const m = addMembership(inv.organization_id, user.id, inv.role);
    m.public_metadata = { ...(inv.public_metadata ?? {}) }; // like Clerk: the invitation's metadata moves to the membership
    Object.assign(inv, { status: "accepted", updated_at: ms() });
    res.json({ user, membership: membershipJson(m) });
  });
  app.post("/_mock/clerk/memberships", (req, res) => {
    const { org_id, user_id, role, public_metadata } = req.body ?? {};
    if (!s.orgs.has(org_id) || !s.users.has(user_id)) return void res.status(404).end();
    const m = addMembership(org_id, user_id, role ?? "org:member");
    if (public_metadata) m.public_metadata = public_metadata;
    res.json(membershipJson(m));
  });
  /** A Clerk session token (v2 claims by default: `o: {id, rol, slg}`; v1: org_id/org_role). */
  app.post("/_mock/session", async (req, res) => {
    const b = req.body ?? {};
    const org = b.org_id ? s.orgs.get(b.org_id) : null;
    const claims: Record<string, unknown> = { sid: id("sess"), azp: b.azp ?? undefined, v: b.v1 ? undefined : 2 };
    if (org) {
      if (b.v1) Object.assign(claims, { org_id: org.id, org_role: b.org_role ?? "org:member", org_slug: org.slug });
      else claims.o = { id: org.id, rol: String(b.org_role ?? "member").replace(/^org:/, ""), slg: org.slug };
    }
    const t = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "mock-1", typ: "JWT" }).setIssuer(getBase()).setSubject(b.user_id)
      .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 5).setExpirationTime(b.expired ? Math.floor(Date.now() / 1000) - 60 : "5m");
    res.json({ token: await t.sign(privateKey) });
  });
  // ---------- Google, a stand-in for the built-in sign-in's tests (mold_v0-004; src/builtin-auth.ts) ----------
  // POST /_mock/google/code {email, sub, nonce, code_challenge, redirect_uri?, email_verified?, given_name?, hd?, aud?, iss?, expired?} -> {code}: what
  // Google's consent screen would hand back. POST /_mock/google/token (form, like Google's) checks the client, the
  // redirect URI and the PKCE verifier against that challenge, and answers an ID token signed with the mock's key, served
  // at GET /_mock/google/jwks. The issuer is `${base}/google` unless the test asks for another (point GOOGLE_ISSUER at it).
  const googleCodes = new Map<string, any>();
  app.post("/_mock/google/code", (req, res) => {
    const code = id("gcode");
    googleCodes.set(code, { ...(req.body ?? {}) });
    res.json({ code });
  });
  app.get("/_mock/google/jwks", (_req, res) => void res.json({ keys: [jwk] }));
  app.post("/_mock/google/token", async (req, res) => {
    const b = req.body ?? {};
    const c = googleCodes.get(String(b.code ?? ""));
    googleCodes.delete(String(b.code ?? ""));
    if (!c || b.grant_type !== "authorization_code") return void res.status(400).json({ error: "invalid_grant" });
    if (b.client_id !== process.env.GOOGLE_CLIENT_ID || b.client_secret !== process.env.GOOGLE_CLIENT_SECRET) return void res.status(401).json({ error: "invalid_client" });
    if (c.redirect_uri && b.redirect_uri !== c.redirect_uri) return void res.status(400).json({ error: "redirect_uri_mismatch" });
    const { createHash } = await import("node:crypto");
    if (!b.code_verifier || createHash("sha256").update(String(b.code_verifier)).digest("base64url") !== c.code_challenge) return void res.status(400).json({ error: "invalid_grant", error_description: "PKCE" });
    const t = new SignJWT({ email: c.email, email_verified: c.email_verified ?? true, nonce: c.nonce, ...(c.given_name ? { given_name: c.given_name } : {}), ...(c.hd ? { hd: c.hd } : {}) })
      .setProtectedHeader({ alg: "RS256", kid: "mock-1", typ: "JWT" }).setIssuer(c.iss ?? `${getBase()}/google`).setSubject(String(c.sub))
      .setAudience(c.aud ?? String(b.client_id)).setIssuedAt().setExpirationTime(c.expired ? Math.floor(Date.now() / 1000) - 60 : "5m");
    res.json({ id_token: await t.sign(privateKey), access_token: "ya29.mock", token_type: "Bearer", expires_in: 3599 });
  });
  /** A Clerk OAuth access token for an MCP client: opaque oat_… (verified through the Backend API) or a JWT (typ at+jwt). */
  app.post("/_mock/oauth", async (req, res) => {
    const b = req.body ?? {};
    if (b.jwt) {
      const t = new SignJWT({ scp: "profile email", client_id: "mock_client", ...(b.aud ? { aud: b.aud } : {}) }).setProtectedHeader({ alg: "RS256", kid: "mock-1", typ: "at+jwt" })
        .setIssuer(b.iss ?? getBase()).setSubject(b.user_id).setIssuedAt().setExpirationTime(b.expired ? Math.floor(Date.now() / 1000) - 60 : "5m");
      return void res.json({ access_token: await t.sign(privateKey) });
    }
    const token = `oat_${randomBytes(18).toString("hex")}`;
    s.oauth.set(token, { id: id("oat"), user_id: b.user_id, revoked: Boolean(b.revoked), expired: Boolean(b.expired), aud: b.aud ?? null, created_at: ms() });
    res.json({ access_token: token });
  });
  const invoice = (b: { customer: string; amount: number; status?: string; created?: number; paid_at?: number | null; subscription?: string | null; number?: string }) => {
    const created = b.created ?? Math.floor(Date.now() / 1000), status = b.status ?? "paid";
    const inv = { id: id("in"), object: "invoice", customer: b.customer, number: b.number ?? `MOCK-${s.invoices.length + 1}`, status, total: b.amount, amount_due: b.amount,
      amount_paid: status === "paid" ? b.amount : 0, currency: "usd", created, subscription: b.subscription ?? null, hosted_invoice_url: `${getBase()}/invoice`,
      status_transitions: { paid_at: status === "paid" ? b.paid_at ?? created : null } };
    s.invoices.push(inv);
    return inv;
  };
  app.post("/_mock/subscriptions", (req, res) => {
    const b = req.body, t = Math.floor(Date.now() / 1000);
    const price = s.prices.find((p) => p.id === b.price);
    const start = b.start_date ?? t;
    const sub = { id: id("sub"), object: "subscription", customer: b.customer, status: b.status ?? "active", cancel_at_period_end: Boolean(b.cancel_at_period_end),
      trial_end: b.trial_end ?? null, start_date: start, created: start, ended_at: b.ended_at ?? null, canceled_at: b.canceled_at ?? null, cancel_at: null,
      current_period_end: b.current_period_end ?? t + 30 * 86400, metadata: b.metadata ?? {}, items: { data: [{ price, quantity: b.quantity ?? 1 }] } };
    s.subscriptions.set(sub.id, sub);
    if (b.invoice !== false) invoice({ customer: b.customer, amount: price?.unit_amount ?? 0, subscription: sub.id });
    res.json(sub);
  });
  app.post("/_mock/checkout/:id/complete", (req, res) => {
    const cs = s.checkouts.find((x) => x.id === req.params.id);
    if (!cs) return void res.status(404).json({ error: "no such checkout" });
    const t = Math.floor(Date.now() / 1000), price = s.prices.find((p) => p.id === cs.price), trial = Number(cs.subscription_data?.trial_period_days ?? 0);
    const items = (cs.line_items?.length ? cs.line_items : [{ price: cs.price, quantity: 1 }]).map((li: any) => ({ price: s.prices.find((p) => p.id === li.price), quantity: li.quantity == null ? null : Number(li.quantity) }));
    const status = req.body?.status ?? (trial ? "trialing" : "active");
    const sub = { id: id("sub"), object: "subscription", customer: cs.customer, status, cancel_at_period_end: false, trial_end: trial ? t + trial * 86400 : null,
      start_date: t, created: t, ended_at: null, canceled_at: null, cancel_at: null, current_period_end: t + 30 * 86400,
      metadata: cs.subscription_data?.metadata ?? {}, items: { data: items } };
    s.subscriptions.set(sub.id, sub);
    cs.status = "complete"; cs.subscription = sub.id;
    if (!trial && price?.unit_amount) invoice({ customer: cs.customer, amount: price.unit_amount, subscription: sub.id });
    res.json(sub);
  });
  app.post("/_mock/prices", (req, res) => {
    const b = req.body;
    const price = { id: b.id, object: "price", active: false, lookup_key: b.lookup_key ?? null, unit_amount: b.unit_amount, currency: "usd",
      recurring: { interval: b.interval ?? "month", interval_count: b.interval_count ?? 1 }, nickname: b.nickname ?? null, metadata: {},
      product: { id: "prod_mock_1", name: PROFILE.name, metadata: {} } };
    s.prices = [...s.prices.filter((p) => p.id !== b.id), price];
    res.json(price);
  });
  app.post("/_mock/invoices", (req, res) => void res.json(invoice(req.body)));
  app.post("/_mock/stripe/outage", (req, res) => { s.stripeDown = Boolean(req.body?.down); res.json({ down: s.stripeDown }); });

  // ---------- Resend (POST /emails): only the fields the app sends ----------
  const resendErr = (res: express.Response, statusCode: number, name: string, message: string) => void res.status(statusCode).json({ statusCode, name, message });
  app.post("/emails", (req, res) => {
    if (!/^Bearer re_\S+$/.test(req.get("authorization") ?? "")) return resendErr(res, 401, "missing_api_key", "Missing API key in the authorization header.");
    if (s.resendDown) return resendErr(res, 500, "application_error", "An unexpected error occurred.");
    const b = req.body ?? {};
    const to = Array.isArray(b.to) ? b.to : b.to ? [b.to] : [];
    if (!b.from || !to.length || !b.subject || !(b.text || b.html)) return resendErr(res, 422, "validation_error", "from, to, subject and text or html are required.");
    if (to.length > 50) return resendErr(res, 422, "validation_error", "At most 50 recipients.");
    const key = req.get("idempotency-key") ?? null, body = JSON.stringify(b);
    if (key && key.length > 256) return resendErr(res, 422, "validation_error", "The idempotency key is too long.");
    const prev = key ? s.resendKeys.get(key) : undefined;
    if (prev) return prev.body === body ? void res.json({ id: prev.id }) : resendErr(res, 409, "invalid_idempotent_request", "Same idempotency key used with a different request payload.");
    const email = { id: randomUUID(), ...b, to, idempotency_key: key, created_at: now() };
    s.emails.push(email);
    if (key) s.resendKeys.set(key, { id: email.id, body });
    res.json({ id: email.id });
  });
  // ---------- Cloudflare Workers AI (OpenAI-compatible chat completions): answers come from state.aiReply ----------
  app.post("/client/v4/accounts/:account/ai/v1/chat/completions", (req, res) => {
    if (!/^Bearer \S+$/.test(req.get("authorization") ?? "")) return void res.status(401).json({ success: false, errors: [{ message: "Authentication error" }] });
    s.aiRequests.push({ account: req.params.account, ...req.body });
    const r = s.aiReply?.(req.body) ?? { status: 503 };
    if (r.status && r.status >= 400) return void res.status(r.status).json({ success: false, errors: [{ message: "mock: no answer" }] });
    res.json({ id: id("chatcmpl"), object: "chat.completion", model: req.body?.model, choices: [{ index: 0, message: { role: "assistant", content: r.content ?? "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: Math.ceil(JSON.stringify(req.body?.messages ?? []).length / 4), completion_tokens: Math.ceil((r.content ?? "").length / 4) } });
  });
  app.post("/_mock/resend/outage", (req, res) => { s.resendDown = Boolean(req.body?.down); res.json({ down: s.resendDown }); });
  app.use(c);
  app.use(st);

  return { app, state: s };
}

/** The mock on its own port, in memory (smoke test, local preview). */
export async function startMockProviders(port = 0) {
  let url = "";
  const { app, state } = await createMockApp(() => url);
  const server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
