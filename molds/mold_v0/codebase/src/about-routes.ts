/**
 * The About page's data (mold_v0-050; src/data-map.ts, src/source-offer.ts): the build's data-flow and residency
 * statement, what the running server measures about itself, and the source offer.
 *
 *   GET /api/about        a signed-in person of a workspace (src/app.ts customerSession)
 *   GET /api/admin/about  platform staff (mounted inside the admin router, behind its guard and access log)
 *
 * Both answer {name, deploy, sections, measured, offer}; staff also get the operators' details in `measured`. `measured` is read when asked: names, providers, regions and host
 * names only. A URL from the environment is reduced to its host (never its user, password, path or query); the database
 * address to its provider and region; nothing returns a key, a token or a credential's value.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { customerSession } from "./app.js";
import { currentOffer, dataMap, type DataMapRow, type DataMapSection, type DeployFacts } from "./data-map.js";
import { packs } from "./packs.js";
import { asPlatform } from "./tenant-scope.js";
import { authProvider } from "./auth-provider.js";

/** The host of a URL from the environment, or null: never its user, password, path or query. */
export const urlHost = (u: string | undefined): string | null => { if (!u) return null; try { return new URL(u).hostname.toLowerCase() || null; } catch { return null; } };

/**
 * The database the server is configured with, in words: its provider and the region its host name says, never the host
 * itself or anything else of the address (DATABASE_URL holds the password).
 */
export function databaseWords(url: string | undefined): string {
  if (!url) return "an embedded Postgres (PGlite) on this server's disk (DATABASE_URL is not set)";
  const h = urlHost(url);
  if (!h) return "a Postgres server (its address could not be read)";
  let m: RegExpMatchArray | null;
  if ((m = h.match(/\.([a-z]{2}-[a-z]+-\d+)\.aws\.neon\.tech$/))) return `Neon Postgres on AWS, region ${m[1]}`;
  if ((m = h.match(/\.([a-z0-9]+)\.azure\.neon\.tech$/))) return `Neon Postgres on Azure, region ${m[1]}`;
  if (h.endsWith(".neon.tech")) return "Neon Postgres (its region cannot be read from its host name)";
  if ((m = h.match(/^aws-\d+-([a-z]{2}-[a-z]+-\d+)\.pooler\.supabase\.com$/))) return `Supabase Postgres on AWS, region ${m[1]}`;
  if (h.endsWith(".supabase.co") || h.endsWith(".supabase.com")) return "Supabase Postgres (its region cannot be read from its host name)";
  if ((m = h.match(/\.([a-z]{2}-[a-z]+-\d+)\.rds\.amazonaws\.com$/))) return `Amazon RDS Postgres, region ${m[1]}`;
  if (!h.includes(".") || h === "127.0.0.1" || h === "::1" || h === "[::1]") return "a Postgres server on this machine or its private network";
  return "a Postgres server (its region cannot be read from its host name)";
}

/** The object store this server uses (src/storage.ts objectStore): R2 with its bucket and jurisdiction, a directory, or none. */
export function objectStoreWords(env: NodeJS.ProcessEnv = process.env): string {
  if (env.R2_BUCKET && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    const h = urlHost(env.R2_ENDPOINT) ?? "";
    const j = h.match(/\.(eu|fedramp)\.r2\.cloudflarestorage\.com$/)?.[1];
    return `Cloudflare R2, bucket ${env.R2_BUCKET}${j ? `, ${j === "eu" ? "EU" : "FedRAMP"} jurisdiction` : ", no jurisdiction set (R2 places the bucket itself)"}`;
  }
  if (env.OCTILLION_STORAGE_DIR) return "a directory on this server's disk (OCTILLION_STORAGE_DIR)";
  return "none configured (a feature that needs one refuses to run)";
}

/**
 * What the running server reads about itself now (no request leaves the server but the database's; nothing is written).
 * `staff` (the admin page) adds what only operators need: the bucket's name, key counts, the sandbox setting, webhook and
 * telemetry hosts. A workspace's people get where things are: regions and providers.
 */
export async function measured(env: NodeJS.ProcessEnv = process.env, staff = true): Promise<DataMapSection> {
  const rows: DataMapRow[] = [];
  rows.push({ item: "Answering from", detail: env.VERCEL ? `a Vercel function in the region ${env.VERCEL_REGION || "(Vercel did not say)"}` : "a server process (not a Vercel function): its location is the server's" });
  rows.push({ item: "Database", detail: databaseWords(env.DATABASE_URL) });
  const store = objectStoreWords(env);
  rows.push({ item: "Object store", detail: staff ? store : store.replace(/, bucket [^,]+/, "") });
  const { transcripts } = await import("./transcripts.js");
  const ch = urlHost(env.CLICKHOUSE_URL)?.match(/\.([a-z]{2}-[a-z]+-\d+)\.(aws|gcp|azure)\.clickhouse\.cloud$/);
  rows.push({ item: "Session transcripts", detail: transcripts().kind === "clickhouse" ? `ClickHouse${ch ? ` on ${ch[2]!.toUpperCase()}, region ${ch[1]}` : " (its region cannot be read from its address)"}` : "the database" });

  // Where each model provider the build's job kinds name is forwarded now, as the gateway would choose (src/gateway.ts):
  // the provider's own key, else (Claude) a Vertex AI key at the global location; a Vertex backend at its location.
  const providers = [...new Set(packs().flatMap((p) => [...(p.definition.agentJobKinds ?? []), ...(p.definition.jobKinds ?? [])].flatMap((k) => k.providers ?? [])))].sort();
  if (providers.length) {
    const [{ getProvider, VERTEX_LABEL, VERTEX_PROVIDER }, { vertexBase }, { freshSettings, settingText }, { getDb }] = await Promise.all([import("./keyvault.js"), import("./vertex.js"), import("./settings.js"), import("./db.js")]);
    await freshSettings();
    const db = await getDb();
    const count = async (provider: string, vertex: boolean | null) => Number((await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM vault_credentials WHERE provider = $1 AND enabled${vertex === null ? "" : vertex ? " AND label = $2" : " AND label IS DISTINCT FROM $2"}`,
      vertex === null ? [provider] : [provider, VERTEX_LABEL]).catch(() => [{ n: 0 }]))[0]?.n ?? 0);
    const vertexAt = (cfg: { region?: string; endpoint?: string } | undefined, region: string) => `Google Cloud Vertex AI, location ${region} (${urlHost(vertexBase({ ...(cfg ?? {}), region })) ?? "?"})`;
    for (const slug of providers) {
      const p = await getProvider(slug).catch(() => null);
      const own = await count(slug, false), vertexKeys = (await count(slug, true)) + (slug === VERTEX_PROVIDER ? 0 : await count(VERTEX_PROVIDER, null));
      let where: string;
      if (!p) where = "not configured in the key vault (runs that need it fail)";
      else if (!p.enabled || p.mode !== "gateway") where = `not usable by runs (${p.enabled ? `mode ${p.mode}` : "turned off"} in the key vault)`;
      else if (p.backend === "vertex") where = vertexAt(p.backend_config, p.backend_config?.region || settingText("VERTEX_REGION") || "global");
      else if (!own && slug === "anthropic" && vertexKeys) where = `${vertexAt(undefined, "global")}: the vault has no Anthropic key of its own but a Vertex AI key`;
      else where = own ? (urlHost(p.upstream_url ?? undefined) ?? "no upstream address set") : `${urlHost(p.upstream_url ?? undefined) ?? "no upstream address set"}, but the vault holds no key for it (runs that need it fail)`;
      rows.push({ item: `Model provider ${slug}`, detail: staff ? `${where}; ${own} key${own === 1 ? "" : "s"} of its own and ${vertexKeys} Vertex AI key${vertexKeys === 1 ? "" : "s"} enabled in the key vault` : where });
    }
  }
  if (staff && packs().some((p) => (p.definition.agentJobKinds ?? []).length || (p.definition.jobKinds ?? []).length)) {
    // The setting only: which provider a launch picks is decided where runs are launched (on a server of its own, the
    // runner service, which alone holds the Docker socket), never probed from a request.
    const { RUN_SANDBOXES } = await import("./run-sandboxes.js");
    rows.push({ item: "Run sandboxes", detail: `OCTILLION_RUN_SANDBOX is ${RUN_SANDBOXES.mode()} (auto: the sandbox provider whose key is in the key vault, else the server's Docker from its runner service)` });
  }
  const third: [string, boolean, string, boolean][] = [
    // The server's sign-in (src/auth-provider.ts): Clerk, or its own (people and sessions in the database).
    ["Sign-in", true, authProvider() === "clerk" && env.CLERK_SECRET_KEY ? `Clerk (${urlHost(env.CLERK_API_URL) ?? "api.clerk.com"})` : "this server's own sign-in: people and sessions are kept in the database", true],
    ["Billing", Boolean(env.STRIPE_SECRET_KEY), `Stripe (${urlHost(env.STRIPE_API_URL) ?? "api.stripe.com"})`, true],
    ["Product analytics", Boolean(env.POSTHOG_API_KEY), `PostHog (${urlHost(env.POSTHOG_HOST) ?? "us.i.posthog.com"}): product events, and the signed-in person's email address and name`, true],
    ["Traces and metrics", Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) && env.OTEL_SDK_DISABLED !== "true", `OpenTelemetry export to ${urlHost(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? "?"}`, staff],
    ["Access-request alerts", Boolean(env.ACCESS_REQUEST_WEBHOOK_URL), `a webhook at ${urlHost(env.ACCESS_REQUEST_WEBHOOK_URL) ?? "?"}`, staff],
    ["Spend alerts", Boolean(env.OCTILLION_ALERT_WEBHOOK_URL), `a webhook at ${urlHost(env.OCTILLION_ALERT_WEBHOOK_URL) ?? "?"}`, staff],
  ];
  for (const [item, on, what, shown] of third) if (shown) rows.push({ item, detail: on ? what : "not configured" });
  const { emailStatus } = await import("./email.js");
  const e = await emailStatus().catch(() => null);
  rows.push({ item: "Email", detail: e ? (e.enabled && e.connected ? `Resend (${urlHost(env.RESEND_API_URL) ?? "api.resend.com"})` : "not sending (no Resend key in the key vault, or email turned off)") : "could not be read" });
  return { id: "measured", title: "Measured by the running server", intro: "Read by this server when the page was opened: names, providers, regions and host names only.", rows };
}

/** The whole answer: the statement (declared and deploy facts), what is measured now, and the source offer. */
export async function about(staff: boolean) {
  const { deploy, ...m } = dataMap();
  const shown = deploy ? (({ $comment: _c, ...d }) => d)(deploy as DeployFacts & { $comment?: string }) : null;
  return { ...m, deploy: shown, measured: await measured(process.env, staff), offer: currentOffer() };
}

// The key vault's provider settings and the email settings are the platform's, not a workspace's: read as the platform.
const answer = (staff: boolean) => async (_req: Request, res: Response, next: NextFunction) => {
  try { res.set("Cache-Control", "no-store").json(await asPlatform(() => about(staff))); } catch (e) { next(e); }
};

/** /api/about for a signed-in person of a workspace. */
export function aboutAppRouter(): Router {
  const r = express.Router();
  r.use(customerSession);
  r.get("/", answer(false));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** /api/admin/about, inside the admin router (its guard and access log). */
export function aboutAdminRouter(): Router {
  const r = express.Router();
  r.get("/", answer(true));
  return r;
}
