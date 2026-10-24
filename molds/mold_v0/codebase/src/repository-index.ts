/**
 * Upstream catalogs index themselves (mold_v0-128; molds/mold_v0/MOLD.md "Upstream catalogs index themselves"). An
 * upstream_catalog repository is pinned to a commit, so what it holds is fixed by the build: the server indexes every
 * one whose stored pin (table repository_index, sql/migrations/0019) differs from its declared pin, without staff:
 *
 *   startup      the first request an instance serves (src/http.ts), in the background: never delays an answer. Once per
 *                instance; on Vercel the work is kept alive past the response (waitUntil)
 *   first read   a list of an empty platform area fed by such a catalog (src/record-areas.ts listPlatform) starts it
 *                too, and waits for it a few seconds (READ_WAIT_MS) before answering, so the first person sees rows
 *   deploy       `npm run catalogs:index` (scripts/catalogs-index.ts), run once by the factory's deploy after its health
 *                checks; it prints the counts
 *   staff        the admin MCP's admin_sync_<repository> and the console's Repositories page "Index now" (both through
 *                indexNow: the same code path), which may also force a guarded prune
 *
 * A pack opts a catalog out with `index: "manual"` in its repository declaration (then only staff index it).
 * Only one instance indexes a catalog at a time: a lease row, claimed in a short transaction under a transaction-level
 * advisory lock (concurrent Vercel instances, a server's replicas), lasting LEASE_S; another instance finds it held and
 * leaves it. The fetch is the adapter's own (src/data-repositories.ts: at the pin only, redirects refused, its timeouts);
 * the whole index is bounded by INDEX_TIMEOUT_MS. A failure is recorded (last_error, shown on the admin console's
 * Repositories page and on Health) and never breaks a request; an automatic retry at the same pin waits RETRY_AFTER_S.
 * APP_CATALOG_AUTOINDEX=off turns the startup and first-read triggers off (the offline tests do; staff and the deploy's
 * script still index).
 */
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { ENV } from "./env-names.js";
import { PackError, type Repository } from "./pack-api.js";
import { packs } from "./packs.js";
import type { RecordArea } from "./record-areas.js";
import { asPlatform } from "./tenant-scope.js";

export type IndexTrigger = "startup" | "first_read" | "deploy" | "staff";
type Pinned = Omit<Extract<Repository, { kind: "upstream_catalog" }>, "upstream"> & { upstream: { repo: string; commit: string } };
type Catalog = { pack: string; name: string; settings: Pinned; areas: RecordArea[] };

const LEASE_S = 600;
const RETRY_AFTER_S = 900;
const INDEX_TIMEOUT_MS = 8 * 60_000;
export const READ_WAIT_MS = 8_000;
const OWNER = `${process.pid}-${randomBytes(4).toString("hex")}`;

/** Is a catalog indexed on its own (the pack did not say `index: "manual"`)? */
const automatic = (c: Catalog) => (c.settings as { index?: string }).index !== "manual";
export const autoIndexOn = () => (ENV.APP_CATALOG_AUTOINDEX ?? "on").toLowerCase() !== "off";

/** Every upstream catalog of the build with a resolved pin and an area it feeds. */
export async function catalogs(): Promise<Catalog[]> {
  const { repositoriesOf } = await import("./data-repositories.js");
  return packs().flatMap((p) => repositoriesOf(p.id).flatMap((r) => (r.settings.kind === "upstream_catalog" && typeof r.settings.upstream === "object" && r.areas.length
    ? [{ pack: p.id, name: r.name, settings: r.settings as Pinned, areas: r.areas }] : [])));
}

export interface IndexState {
  pack: string; name: string; pin: string | null; indexed_at: string | null; rows: Record<string, number>;
  attempted_at: string | null; attempted_pin: string | null; attempted_by: string | null; last_error: string | null; last_error_at: string | null;
  lease_until: string | null;
}
const COLS = "pack, name, pin, indexed_at::text, rows, attempted_at::text, attempted_pin, attempted_by, last_error, last_error_at::text, lease_until::text";
const stateOf = async (pack: string, name: string) => asPlatform(async () =>
  (await (await getDb()).query<IndexState>(`SELECT ${COLS} FROM repository_index WHERE pack = $1 AND name = $2`, [pack, name]))[0] ?? null);

/** What the admin console shows: each repository of the build, and for an upstream catalog its pin and index state. */
export async function repositoryStatus() {
  const { allRepositories } = await import("./data-repositories.js");
  const { recordAreas } = await import("./record-areas.js");
  const cats = await catalogs();
  const states = await asPlatform(async () => (await (await getDb()).query<IndexState>(`SELECT ${COLS} FROM repository_index`)));
  const counts = await asPlatform(async () => (await (await getDb()).query<{ pack: string; area: string; n: number; ours: number }>(
    "SELECT pack, area, count(*)::int AS n, count(source)::int AS ours FROM platform_records GROUP BY pack, area")));
  const now = Date.now();
  return {
    automatic: autoIndexOn(),
    repositories: allRepositories().map((r) => {
      const c = cats.find((x) => x.pack === r.pack && x.name === r.name);
      const s = states.find((x) => x.pack === r.pack && x.name === r.name) ?? null;
      const areas = recordAreas().filter((a) => a.pack === r.pack && a.repo?.name === r.name).map((a) => {
        const n = a.scope === "platform" ? counts.find((x) => x.pack === r.pack && x.area === a.name) : undefined;
        return { name: a.name, label: a.label, scope: a.scope, rows: a.scope === "platform" ? n?.n ?? 0 : null };
      });
      return {
        ...r, area_rows: areas,
        ...(c ? {
          upstream: { repo: c.settings.upstream.repo, commit: c.settings.upstream.commit },
          index: automatic(c) ? "automatic" : "manual",
          state: s ? { ...s, indexing: !!s.lease_until && Date.parse(s.lease_until) > now, current: s.pin === c.settings.upstream.commit } : null,
        } : {}),
      };
    }),
  };
}

/**
 * Claim one catalog's lease: in one short transaction under an advisory lock on the catalog, the row is read, and the
 * lease written only when nobody holds it and (unless `retry`) the catalog still needs an index. -> the claim, or why not.
 */
async function claim(c: Catalog, by: IndexTrigger, opts: { retry: boolean; anyPin: boolean }): Promise<{ ok: true } | { ok: false; why: "current" | "held" | "backoff" }> {
  const pin = c.settings.upstream.commit;
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`repository-index:${c.pack}/${c.name}`]);
    await tx.query("INSERT INTO repository_index (pack, name) VALUES ($1, $2) ON CONFLICT (pack, name) DO NOTHING", [c.pack, c.name]);
    const [s] = await tx.query<{ pin: string | null; held: boolean; recent_failure: boolean }>(
      `SELECT pin, (lease_until IS NOT NULL AND lease_until > now()) AS held,
              (last_error IS NOT NULL AND attempted_pin = $3 AND attempted_at > now() - make_interval(secs => $4)) AS recent_failure
         FROM repository_index WHERE pack = $1 AND name = $2`, [c.pack, c.name, pin, RETRY_AFTER_S]);
    if (s!.held) return { ok: false as const, why: "held" as const };
    if (!opts.anyPin && s!.pin === pin) return { ok: false as const, why: "current" as const };
    if (!opts.retry && s!.recent_failure) return { ok: false as const, why: "backoff" as const };
    await tx.query("UPDATE repository_index SET lease_until = now() + make_interval(secs => $3), lease_owner = $4, attempted_at = now(), attempted_pin = $5, attempted_by = $6 WHERE pack = $1 AND name = $2",
      [c.pack, c.name, LEASE_S, OWNER, pin, by]);
    return { ok: true as const };
  }));
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => new Promise<T>((ok, no) => {
  const t = setTimeout(() => no(new PackError(`${what} took longer than ${Math.round(ms / 1000)} s: stopped`, 504)), ms);
  t.unref?.();
  p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); });
});

type Report = Awaited<ReturnType<typeof import("./data-repositories.js").syncUpstreamCatalog>>;
/** Run one claimed index and record what came of it; the lease is released either way. */
async function runClaimed(c: Catalog, opts: { force?: boolean; fetcher?: typeof fetch }): Promise<Report> {
  const { syncUpstreamCatalog } = await import("./data-repositories.js");
  const db = await getDb();
  try {
    const report = await withTimeout(syncUpstreamCatalog(c.pack, c.name, opts), INDEX_TIMEOUT_MS, `the index of ${c.name}`);
    const rows = Object.fromEntries(report.areas.map((a) => [a.area, a.created + a.updated + a.unchanged]));
    await asPlatform(() => db.query(
      `UPDATE repository_index SET pin = $3, indexed_at = now(), rows = $4, report = $5, last_error = NULL, last_error_at = NULL, lease_until = NULL, lease_owner = NULL
        WHERE pack = $1 AND name = $2`, [c.pack, c.name, report.version, JSON.stringify(rows), JSON.stringify(report)]));
    return report;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/[\u0000-\u001f]+/g, " ").slice(0, 1000);
    await asPlatform(() => db.query("UPDATE repository_index SET last_error = $3, last_error_at = now(), lease_until = NULL, lease_owner = NULL WHERE pack = $1 AND name = $2",
      [c.pack, c.name, msg])).catch(() => {});
    throw e;
  }
}

/**
 * Staff's index (the admin MCP's admin_sync_<repository>, the console's "Index now"): the catalog at its pin, now, even
 * when it is indexed there already (idempotent: unchanged rows are not written); `force` passes the prune's guard.
 * Refused (409) while another instance is indexing it.
 */
export async function indexNow(pack: string, name: string, opts: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<Report> {
  const c = (await catalogs()).find((x) => x.pack === pack && x.name === name);
  if (!c) {
    // Not an indexable catalog (another kind, no pin, no area): the adapter's own refusal says which.
    const { syncUpstreamCatalog } = await import("./data-repositories.js");
    return syncUpstreamCatalog(pack, name, opts);
  }
  const got = await claim(c, "staff", { retry: true, anyPin: true });
  if (!got.ok) throw new PackError(`${name} is being indexed right now; try again in a minute`, 409);
  return runClaimed(c, opts);
}

export interface EnsureResult { pack: string; name: string; outcome: "indexed" | "current" | "manual" | "held" | "backoff" | "failed"; report?: Report; error?: string }
/**
 * Index every automatic catalog not indexed at its pin (one at a time; a failure does not stop the next). `retry`
 * (the deploy) ignores the wait after a failed attempt.
 */
export async function ensureCatalogs(by: IndexTrigger, opts: { retry?: boolean; only?: { pack: string; name: string }; fetcher?: typeof fetch } = {}): Promise<EnsureResult[]> {
  const out: EnsureResult[] = [];
  for (const c of await catalogs()) {
    if (opts.only && (opts.only.pack !== c.pack || opts.only.name !== c.name)) continue;
    if (!automatic(c)) { out.push({ pack: c.pack, name: c.name, outcome: "manual" }); continue; }
    const got = await claim(c, by, { retry: !!opts.retry, anyPin: false });
    if (!got.ok) { out.push({ pack: c.pack, name: c.name, outcome: got.why }); continue; }
    try { out.push({ pack: c.pack, name: c.name, outcome: "indexed", report: await runClaimed(c, { fetcher: opts.fetcher }) }); }
    catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 300);
      console.error(`[catalogs] ${c.pack}/${c.name} could not be indexed at ${c.settings.upstream.commit.slice(0, 12)} (${by}): ${error}`);
      out.push({ pack: c.pack, name: c.name, outcome: "failed", error });
    }
  }
  return out;
}

// ---------- the triggers in a running server ----------

let running: Promise<EnsureResult[]> | null = null;
let started = false;
/** One background pass in this instance (a second call while one runs joins it). Never rejects. */
export function kickCatalogs(by: IndexTrigger): Promise<EnsureResult[]> {
  running ??= asPlatform(() => ensureCatalogs(by)).catch((e) => {
    console.error(`[catalogs] the automatic index stopped: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return [] as EnsureResult[];
  }).finally(() => { running = null; });
  return running;
}

/** The first request of an instance: one background pass, once (APP_CATALOG_AUTOINDEX=off: never). */
export function startCatalogIndexing(keep?: (p: Promise<unknown>) => void): void {
  if (started || !autoIndexOn()) return;
  started = true;
  // Only when the build has a catalog at all: a build with none never touches the table.
  const p = catalogs().then((cs) => (cs.some(automatic) ? kickCatalogs("startup") : []), () => []);
  keep?.(p);
}

/**
 * A read found an automatic catalog's platform area empty: start the index (if this instance is not already running
 * it) and wait for it up to READ_WAIT_MS. -> true when an index finished in that time (read again).
 */
export async function onEmptyCatalogArea(area: RecordArea): Promise<boolean> {
  if (!autoIndexOn() || area.scope !== "platform" || area.repo?.kind !== "upstream_catalog") return false;
  const s = area.repo.settings as Catalog["settings"];
  if (typeof s.upstream !== "object" || (s as { index?: string }).index === "manual") return false;
  const st = await stateOf(area.pack, area.repo.name).catch(() => null);
  if (st?.pin === s.upstream.commit && !running) return false; // indexed at the pin, and simply empty
  const p = kickCatalogs("first_read");
  void import("./telemetry.js").then((t) => t.keepAlive(p)).catch(() => {}); // Vercel: the index outlives this answer
  let timer: NodeJS.Timeout | undefined;
  const done = await Promise.race([p.then(() => true), new Promise<boolean>((ok) => { timer = setTimeout(() => ok(false), READ_WAIT_MS); timer.unref?.(); })]);
  clearTimeout(timer);
  return done;
}

/** Tests: forget this instance's startup pass. */
export function resetCatalogIndexingForTest() { started = false; running = null; }
