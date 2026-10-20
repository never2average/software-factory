/**
 * When a customer gives a package registry page as the product's website or docs (pypi.org/project/x,
 * npmjs.com/package/x, crates.io/crates/x), the real documentation usually lives elsewhere (Read the Docs, a project
 * site, GitHub). Read the package's public registry metadata and return its own links, so onboarding research can
 * read them (seen 2026-10-15: mace-torch onboarding failed because only pypi.org was readable).
 */
import { isIP } from "node:net";

const TIMEOUT_MS = 5000;
const MAX_LINKS = 8;

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "OctillionOnboarding/1.0 (+product research)" },
                                 signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function getText(url: string): Promise<string> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "OctillionOnboarding/1.0 (+product research)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? (await r.text()).slice(0, 200_000) : "";
  } catch { return ""; }
}

/** A public https URL (no IP literals, localhost or internal names). Normalises git+https and .git suffixes. */
function cleanUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/^git\+/, "").replace(/^git:\/\//, "https://");
  if (s.startsWith("http://")) s = "https://" + s.slice(7);
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (isIP(h.replace(/^\[|\]$/g, "")) || /(^|\.)(localhost|local|internal|localdomain)$/.test(h) || !/\.[a-z]{2,}$/.test(h)) return null;
    if (u.hostname === "github.com") u.pathname = u.pathname.replace(/\.git$/, "");
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

/** The package's own documentation, homepage and source links, from the registry page(s) the customer gave. */
export async function registryLinks(urls: (string | null | undefined)[]): Promise<string[]> {
  const found: unknown[] = [];
  for (const raw of urls) {
    if (!raw) continue;
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (host === "pypi.org" && parts[0] === "project" && parts[1]) {
      const j = await getJson(`https://pypi.org/pypi/${encodeURIComponent(parts[1])}/json`);
      const info = j?.info ?? {};
      found.push(info.docs_url, info.home_page, ...Object.values(info.project_urls ?? {}));
    } else if (host === "npmjs.com" && parts[0] === "package" && parts[1]) {
      const name = parts[1].startsWith("@") && parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
      const j = await getJson(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
      found.push(j?.homepage, typeof j?.repository === "string" ? j.repository : j?.repository?.url);
    } else if (host === "crates.io" && parts[0] === "crates" && parts[1]) {
      const j = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(parts[1])}`);
      found.push(j?.crate?.documentation, j?.crate?.homepage, j?.crate?.repository);
    }
  }
  // One step further for GitHub repositories: their "homepage" is usually the project's documentation site.
  for (const link of found.map(cleanUrl)) {
    const m = link && /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/.exec(link);
    if (!m) continue;
    const repo = await getJson(`https://api.github.com/repos/${m[1]}/${m[2]}`);
    if (repo?.homepage) found.push(repo.homepage);
    // Many projects leave the homepage empty and link their docs from the README instead.
    const readme = await getText(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/README.md`);
    const docHosts = new Set<string>();
    for (const [href] of readme.matchAll(/https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s)"'<>\]]*/g)) {
      try {
        const h = new URL(href).hostname.toLowerCase();
        if (/\.(readthedocs\.io|readthedocs\.org|github\.io|gitbook\.io)$/.test(h) || /^docs\./.test(h)) docHosts.add(`https://${h}/`);
      } catch { /* ignore */ }
    }
    found.push(...[...docHosts].slice(0, 3));
    break; // the first repository is enough (unauthenticated API calls are rate-limited)
  }
  const given = new Set(urls.filter(Boolean).map((x) => cleanUrl(x)));
  return [...new Set(found.map(cleanUrl).filter((x): x is string => !!x && !given.has(x)))].slice(0, MAX_LINKS);
}
