/**
 * Per-company egress (mold_v0-075): hosts a workspace's owners list for a pack's runs (its own API, its cloud's
 * endpoint), for the whole workspace or for one asset record (an application), added to the allowlist of the runs of
 * the pack's kinds that declare `company_egress: true`. Table: sql/migrations/0014_runs_approvals_egress.sql
 * (workspace_egress_hosts; no tenant access at all, as the credential vault).
 *
 *   validated  a DNS name only: lowercase letters, digits and -, at least two labels, a top-level label of letters (so
 *              never an IPv4 or IPv6 address, in any notation), no port, no wildcard, no user, no trailing dot; never a
 *              local or internal name (localhost, *.local, *.internal, *.localhost, *.home.arpa, *.arpa, *.lan, *.corp,
 *              *.intranet, *.test, *.invalid) nor the platform's own hosts; and, when it resolves here, never to a
 *              private, loopback, link-local, reserved or multicast address. At run time the egress proxy checks the
 *              address again for every connection (orchestrator/core/egress.ts blocked()): a name that later resolves
 *              to a private address is refused then (DNS rebinding), whatever was checked here.
 *   exact      a listed host is allowed exactly: not its subdomains (the proxy's `exact` list), unlike a kind's own
 *              `egress`, which the pack's author wrote and which allows subdomains.
 *   per run    the workspace's hosts of the pack and those of the asset the run targets (targets.asset {area, key} of
 *              one of the pack's asset areas), read when the run is claimed, at most 20 (src/runs.ts claimRun).
 *   reach      only the run's programs, through the run's egress proxy (and the sandbox firewall). Never a host the
 *              runner itself fetches from (the agent repository, a checkout step's hosts, git credentials: those must be
 *              in the kind's own egress), so a company host never receives a credential the runner holds.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { getDb } from "./db.js";
import { PackError } from "./pack-api.js";
import { packs } from "./packs.js";
import { checkKey, findArea, getFor } from "./record-areas.js";
import { asPlatform } from "./tenant-scope.js";
import { ENV } from "./env-names.js";

export const MAX_HOSTS_PER_SLOT = 20;
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "localdomain", "home.arpa", "arpa", "lan", "corp", "intranet", "test", "invalid", "onion"];
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A private, loopback, link-local, reserved or multicast address (as the egress proxy's blocked()). */
export function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const m = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (m) return privateAddress(m[1]!);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") ||
      x.startsWith("2001:db8") || x.startsWith("2002:") || x.startsWith("2001:0:") || x.startsWith("2001::") || x.startsWith("::ffff:");
  }
  return true;
}

/** The platform's own hosts (its public address, the gateway's): never a company's to list. */
const ownHosts = () => [process.env.PUBLIC_URL, ENV.APP_GATEWAY_URL, ENV.APP_RUN_API_URL].flatMap((u) => {
  try { return u ? [new URL(u).hostname.toLowerCase()] : []; } catch { return []; }
});

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (h) => (await dns.lookup(h, { all: true, verbatim: true })).map((a) => a.address);

/**
 * A host a company may list, normalised (lowercase), or a PackError saying why not. `resolve` (tests) replaces the
 * system's resolver; a name that does not resolve here is accepted (the proxy checks every address at run time).
 */
export async function checkCompanyHost(raw: unknown, resolve: Resolver = systemResolver): Promise<{ host: string; resolved: boolean }> {
  if (typeof raw !== "string") throw new PackError("host: a host name", 400);
  const h = raw.trim().toLowerCase();
  if (!HOST.test(h)) throw new PackError("host: a host name only (like api.example.com): no address, port, path, wildcard or trailing dot", 400);
  if (net.isIP(h)) throw new PackError("host: an address is never listed, only a name", 400);
  if (LOCAL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) throw new PackError(`host: ${h} is a local or internal name`, 400);
  if (ownHosts().some((o) => h === o || h.endsWith(`.${o}`) || o.endsWith(`.${h}`))) throw new PackError(`host: ${h} is the platform's own`, 400);
  let addrs: string[] = [];
  try { addrs = await Promise.race([resolve(h), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000).unref())]); }
  catch { return { host: h, resolved: false }; }
  const bad = addrs.find((a) => privateAddress(a));
  if (bad) throw new PackError(`host: ${h} resolves to a private or reserved address (${bad}): never listed`, 400);
  return { host: h, resolved: addrs.length > 0 };
}

/** The pack's kinds that take company hosts (none: nothing here is offered). */
export const companyEgressPacks = () => packs().filter((p) => [...(p.definition.jobKinds ?? []), ...(p.definition.agentJobKinds ?? [])].some((k) => (k as { company_egress?: boolean }).company_egress));

interface Slot { pack: string; area: string | null; key: string | null }
async function slot(orgId: number, input: { pack?: unknown; asset?: unknown }): Promise<Slot> {
  const pack = typeof input?.pack === "string" ? input.pack : "";
  if (!companyEgressPacks().some((p) => p.id === pack)) throw new PackError("no pack of this build takes company hosts by that name", 404);
  const a = input?.asset as { area?: unknown; key?: unknown } | null | undefined;
  if (a === undefined || a === null) return { pack, area: null, key: null };
  if (typeof a !== "object" || typeof a.area !== "string") throw new PackError("asset: {area, key} of one of the pack's asset areas", 400);
  const area = findArea(a.area);
  if (!area || area.pack !== pack || area.role !== "asset") throw new PackError(`asset: ${a.area} is not one of the pack's asset areas`, 400);
  const key = checkKey(a.key);
  if (!(await getFor(orgId, area.name, key))) throw new PackError(`no ${area.name} record ${key} in this workspace`, 404);
  return { pack, area: area.name, key };
}

export interface CompanyHost { pack: string; asset: { area: string; key: string } | null; host: string; created_by: string | null; created_at: string }
const row = (r: { pack: string; asset_area: string | null; asset_key: string | null; host: string; created_by: string | null; created_at: Date | string }): CompanyHost =>
  ({ pack: r.pack, asset: r.asset_area ? { area: r.asset_area, key: r.asset_key! } : null, host: r.host, created_by: r.created_by, created_at: new Date(r.created_at).toISOString() });

/** A workspace's company hosts (every pack), for its people. */
export async function listCompanyHosts(orgId: number): Promise<CompanyHost[]> {
  const rows = await asPlatform(async () => (await getDb()).query<Parameters<typeof row>[0]>(
    "SELECT pack, asset_area, asset_key, host, created_by, created_at FROM workspace_egress_hosts WHERE org_id = $1 ORDER BY pack, asset_area NULLS FIRST, asset_key NULLS FIRST, host", [orgId]));
  return rows.map(row);
}

/** Add a host for workspace `orgId` (an owner's action, src/http.ts). Validated; at most MAX_HOSTS_PER_SLOT per slot. */
export async function addCompanyHost(orgId: number, by: string | null, input: { pack?: unknown; asset?: unknown; host?: unknown }, resolve?: Resolver): Promise<CompanyHost> {
  const s = await slot(orgId, input);
  const { host } = await checkCompanyHost(input?.host, resolve);
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`egress-hosts:${orgId}`]);
    const [{ n }] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM workspace_egress_hosts WHERE org_id = $1 AND pack = $2 AND coalesce(asset_area, '') = $3 AND coalesce(asset_key, '') = $4",
      [orgId, s.pack, s.area ?? "", s.key ?? ""]);
    if (n >= MAX_HOSTS_PER_SLOT) throw new PackError(`at most ${MAX_HOSTS_PER_SLOT} hosts ${s.key ? "per asset" : "for the workspace"}`, 409);
    const [r] = await tx.query<Parameters<typeof row>[0]>(
      `INSERT INTO workspace_egress_hosts (org_id, pack, asset_area, asset_key, host, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, pack, (coalesce(asset_area, '')), (coalesce(asset_key, '')), host) DO UPDATE SET host = excluded.host
       RETURNING pack, asset_area, asset_key, host, created_by, created_at`, [orgId, s.pack, s.area, s.key, host, by]);
    return row(r!);
  }));
}

/** Remove a host of workspace `orgId`. */
export async function removeCompanyHost(orgId: number, input: { pack?: unknown; asset?: unknown; host?: unknown }): Promise<boolean> {
  const s = await slot(orgId, input);
  const h = typeof input?.host === "string" ? input.host.trim().toLowerCase() : "";
  return asPlatform(async () => (await (await getDb()).query(
    "DELETE FROM workspace_egress_hosts WHERE org_id = $1 AND pack = $2 AND coalesce(asset_area, '') = $3 AND coalesce(asset_key, '') = $4 AND host = $5 RETURNING id",
    [orgId, s.pack, s.area ?? "", s.key ?? "", h])).length > 0);
}

/**
 * The company hosts a run reaches (exactly): for a kind with company_egress, its workspace's hosts of the pack and
 * those of the asset it targets. The workspace from the run row, never from a runner's input. Checked again here (a
 * host stored before a rule changed is not handed out). At most MAX_HOSTS_PER_SLOT * 2.
 */
export async function runCompanyHosts(run: { org_id: number; pack: string; spec: { company_egress?: boolean } | null; targets: Record<string, unknown> | null }): Promise<string[]> {
  if (!run.spec?.company_egress) return [];
  const a = run.targets?.asset;
  const asset = a && typeof a === "object" ? (a as { area?: unknown; key?: unknown }) : null;
  const area = typeof asset?.area === "string" ? asset.area : null, key = typeof asset?.key === "string" ? asset.key : typeof a === "string" ? a : null;
  const rows = await asPlatform(async () => (await getDb()).query<{ host: string }>(
    `/* tenant: the run row's own workspace */ SELECT DISTINCT host FROM workspace_egress_hosts WHERE org_id = $1 AND pack = $2
        AND (asset_key IS NULL OR (asset_key = $3 AND ($4::text IS NULL OR asset_area = $4))) ORDER BY host LIMIT $5`,
    [run.org_id, run.pack, key, area, MAX_HOSTS_PER_SLOT * 2]));
  return rows.map((r) => r.host).filter((h) => HOST.test(h) && !net.isIP(h) && !LOCAL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`)));
}
