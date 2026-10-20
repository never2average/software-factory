import { getDb } from "./db.js";
import { useCredential } from "./keyvault.js";
import { asData } from "../orchestrator/core/text-guard.js";

/**
 * Web and package search for onboarding research (docs/onboarding.md). Research used to name competitors from the
 * model's memory; these give it evidence instead:
 *   web      Exa neural search ("alternatives to X", "best tool for <job>"), with page text
 *   similar  Exa findSimilar: pages like the product's own site (its direct competitors)
 *   packages registry search for packages doing the same job, with usage numbers (npm and crates.io, free;
 *            PyPI, Go, Maven and others through libraries.io when its key is in the vault)
 * Searches run here, never in the research sandbox, so the keys stay on the server (vault providers `exa` and
 * `libraries_io`, orchestrator-only; never environment variables). Every result URL is recorded
 * on the research job (product_research.sources): a competitor's evidence_url must be one of them.
 * Result text is web content: data, never instructions (asData).
 */

export const SEARCH = { get maxPerJob() { return Number(process.env.RESEARCH_MAX_SEARCHES ?? 20); }, timeoutMs: 20_000 };
// Read per call (tests point these at stand-ins after the module is loaded).
const url = {
  exa: () => process.env.EXA_BASE_URL ?? "https://api.exa.ai",
  npm: () => process.env.NPM_SEARCH_URL ?? "https://registry.npmjs.org/-/v1/search",
  crates: () => process.env.CRATES_SEARCH_URL ?? "https://crates.io/api/v1/crates",
  libraries: () => process.env.LIBRARIES_IO_URL ?? "https://libraries.io/api",
};
const UA = "OctillionResearch/1.0 (+product research)";
export const ECOSYSTEMS = ["npm", "pypi", "crates", "go", "maven", "nuget", "rubygems", "packagist"] as const;
const LIBRARIES_PLATFORM: Record<string, string> = { npm: "NPM", pypi: "Pypi", crates: "Cargo", go: "Go", maven: "Maven", nuget: "NuGet", rubygems: "Rubygems", packagist: "Packagist" };

export interface SearchHit { url: string; title: string; text?: string; published?: string }
export interface PackageHit { name: string; ecosystem: string; description: string; url: string; homepage?: string; repository?: string; usage?: Record<string, number> }

async function key(provider: string): Promise<string | null> {
  try { return (await useCredential(provider)).secret; } catch { return null; }
}
export const webSearchEnabled = async () => Boolean(await key("exa"));

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(SEARCH.timeoutMs) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).hostname} answered ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
  return r.json();
}

async function exa(path: "search" | "findSimilar", body: Record<string, unknown>): Promise<SearchHit[]> {
  const k = await key("exa");
  if (!k) throw Object.assign(new Error("Web search is not configured (no Exa key in the vault); name competitors from the product's docs and package search, and say so in notes"), { status: 503 });
  const r = await getJson(`${url.exa()}/${path}`, { method: "POST", headers: { "x-api-key": k, "content-type": "application/json" },
    body: JSON.stringify({ ...body, contents: { text: { maxCharacters: 700 } } }) });
  return (r.results ?? []).filter((x: any) => /^https?:\/\//.test(String(x?.url ?? ""))).map((x: any) => ({
    url: String(x.url), title: asData(x.title ?? "", 200), text: asData(x.text ?? "", 700), ...(x.publishedDate ? { published: String(x.publishedDate).slice(0, 10) } : {}),
  }));
}

export const webSearch = (query: string, n = 8) => exa("search", { query, type: "auto", numResults: Math.min(Math.max(n, 1), 10) });
export const findSimilar = (url: string, n = 8) => exa("findSimilar", { url, numResults: Math.min(Math.max(n, 1), 10), excludeSourceDomain: true });

export async function packageSearch(query: string, ecosystem: string, n = 10): Promise<PackageHit[]> {
  const size = Math.min(Math.max(n, 1), 20), q = encodeURIComponent(query);
  if (ecosystem === "npm") {
    const r = await getJson(`${url.npm()}?text=${q}&size=${size}`);
    return (r.objects ?? []).map((o: any) => ({
      name: String(o.package?.name), ecosystem, description: asData(o.package?.description ?? "", 300), url: `https://www.npmjs.com/package/${o.package?.name}`,
      homepage: o.package?.links?.homepage, repository: o.package?.links?.repository,
      usage: { ...(o.downloads?.weekly != null ? { weekly_downloads: Number(o.downloads.weekly) } : {}), ...(o.dependents != null ? { dependents: Number(o.dependents) } : {}) },
    }));
  }
  if (ecosystem === "crates") {
    const r = await getJson(`${url.crates()}?q=${q}&per_page=${size}`);
    return (r.crates ?? []).map((c: any) => ({
      name: String(c.name), ecosystem, description: asData(c.description ?? "", 300), url: `https://crates.io/crates/${c.name}`,
      homepage: c.homepage ?? undefined, repository: c.repository ?? undefined,
      usage: { downloads: Number(c.downloads ?? 0), recent_downloads: Number(c.recent_downloads ?? 0) },
    }));
  }
  const platform = LIBRARIES_PLATFORM[ecosystem];
  if (!platform) throw Object.assign(new Error(`ecosystem must be one of ${ECOSYSTEMS.join(", ")}`), { status: 400 });
  const k = await key("libraries_io");
  if (!k) throw Object.assign(new Error(`${ecosystem} search needs a libraries.io key, which is not configured; use web_search (e.g. "python library for <job>") and confirm names with fetch_url on the registry`), { status: 503 });
  const r = await getJson(`${url.libraries()}/search?q=${q}&platforms=${platform}&per_page=${size}&api_key=${encodeURIComponent(k)}`);
  return (Array.isArray(r) ? r : []).map((p: any) => ({
    name: String(p.name), ecosystem, description: asData(p.description ?? "", 300), url: String(p.package_manager_url ?? `https://libraries.io/${platform.toLowerCase()}/${p.name}`),
    homepage: p.homepage ?? undefined, repository: p.repository_url ?? undefined,
    usage: { stars: Number(p.stars ?? 0), dependents: Number(p.dependents_count ?? 0), dependent_repos: Number(p.dependent_repos_count ?? 0) },
  }));
}

export type SearchRequest = { kind: "web"; query: string; limit?: number } | { kind: "similar"; url: string; limit?: number }
  | { kind: "packages"; query: string; ecosystem: string; limit?: number };

/**
 * One search for a running research job: counted against the job's budget, and every result URL (plus a package's
 * homepage and repository) recorded as a source the job may cite.
 */
export async function researchSearch(jobId: string, req: SearchRequest) {
  const db = await getDb();
  const [slot] = await db.query<{ searches: number }>(
    "/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET searches = searches + 1 WHERE id = $1 AND status = 'running' AND searches < $2 RETURNING searches",
    [jobId, SEARCH.maxPerJob]);
  if (!slot) throw Object.assign(new Error(`search limit reached (${SEARCH.maxPerJob} per job), or the job is not running`), { status: 429 });
  let results: (SearchHit | PackageHit)[];
  if (req.kind === "web" && req.query?.trim()) results = await webSearch(req.query.trim(), req.limit);
  else if (req.kind === "similar" && /^https?:\/\//.test(req.url ?? "")) results = await findSimilar(req.url, req.limit);
  else if (req.kind === "packages" && req.query?.trim()) results = await packageSearch(req.query.trim(), String(req.ecosystem ?? ""), req.limit);
  else throw Object.assign(new Error("give kind web {query}, similar {url} or packages {query, ecosystem}"), { status: 400 });
  const urls = [...new Set(results.flatMap((r) => [r.url, (r as PackageHit).homepage, (r as PackageHit).repository]).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)))];
  if (urls.length)
    await db.query(
      "/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET sources = sources || $2::jsonb WHERE id = $1",
      [jobId, JSON.stringify(urls.map((url) => ({ url, kind: req.kind })))]);
  return { searches_left: SEARCH.maxPerJob - slot.searches, results };
}

/** Normalised URL for matching a cited evidence_url against recorded sources (no scheme, www, fragment or trailing slash). */
export const urlKey = (u: string) => {
  try { const x = new URL(u); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`; } catch { return u.trim(); }
};
