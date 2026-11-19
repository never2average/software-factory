// A sample of a hosting provider's request logs, in Vercel's documented log-drain format (mold_v0-325;
// https://vercel.com/docs/drains/reference/logs): one deterministic run of four deployments of one project, each
// replacing the one before, so a drain's reports and its A/B comparisons have known answers.
//
//   release-1  24 hours, about 120 requests an hour, 0.5% server errors, fast         (the first: nothing to compare with)
//   release-2  24 hours, the same traffic, 3% server errors, slower                   (regressed against release-1)
//   release-3  24 hours, the same traffic, 0.5% server errors, as fast as release-1   (no change detected against release-2)
//   release-4   2 hours, about 120 requests an hour                                    (insufficient data against release-3)
//
// Each request is a proxy line (source static or lambda, its proxy.statusCode); a function's request also has its
// REPORT line ("Duration: <n> ms", joined by requestId) and sometimes a console line; a few build lines, preview
// lines, background revalidations (proxy.statusCode -1) and a crashed function (statusCode -1) are mixed in. Every
// request is also returned as the truth (deployment, hour, status, duration) for the tests to count independently.
// Paths, addresses and agents are made up (documentation ranges); nothing here is anyone's real traffic.

export interface SampleDeployment { key: string; title: string; provider_id: string; previous: string | null; from: number; hours: number; errorRate: number; slow: boolean }
export interface TruthRequest { deployment: string; at: number; status: number; duration_ms: number | null }
/** `groups`: each request's lines together (a provider sends a request's lines in one batch here; see deliveries). */
export interface Sample { deployments: SampleDeployment[]; groups: Record<string, unknown>[][]; lines: Record<string, unknown>[]; truth: TruthRequest[]; project: string; host: string }

/** A small deterministic generator (mulberry32), so a sample is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const HOUR = 3_600_000;
const PATHS = ["/", "/pricing", "/api/items", "/api/items/42", "/docs/start", "/api/search?q=example"];

/** The sample, starting at `start` (a UTC hour), with `perHour` requests an hour on average. */
export function vercelSample(start: number, perHour = 120, seed = 325): Sample {
  const r = rng(seed);
  const project = "prj_sample0000000000000000001", host = "sample-app.example.com";
  const deployments: SampleDeployment[] = [
    { key: "release-1", title: "Release 1", provider_id: "dpl_SampleRelease1aaaaaaaaaaaa", previous: null, from: start, hours: 24, errorRate: 0.005, slow: false },
    { key: "release-2", title: "Release 2", provider_id: "dpl_SampleRelease2bbbbbbbbbbbb", previous: "release-1", from: start + 24 * HOUR, hours: 24, errorRate: 0.03, slow: true },
    { key: "release-3", title: "Release 3", provider_id: "dpl_SampleRelease3cccccccccccc", previous: "release-2", from: start + 48 * HOUR, hours: 24, errorRate: 0.005, slow: false },
    { key: "release-4", title: "Release 4", provider_id: "dpl_SampleRelease4dddddddddddd", previous: "release-3", from: start + 72 * HOUR, hours: 2, errorRate: 0.005, slow: false },
  ];
  const groups: Record<string, unknown>[][] = [], truth: TruthRequest[] = [];
  const lines = { push: (...l: Record<string, unknown>[]) => void groups.push(l) };
  let n = 0;
  const id = () => `${Date.now().toString().slice(0, 4)}${String(++n).padStart(20, "0")}`;
  for (const d of deployments) {
    const base = { deploymentId: d.provider_id, projectId: project, projectName: "sample-app", host: `sample-app-${d.key}.example.com`, environment: "production", branch: "main" };
    lines.push({ ...base, id: id(), source: "build", level: "info", type: "stdout", message: "Build completed", buildId: `bld_${d.key}`, timestamp: d.from - 60_000 });
    for (let h = 0; h < d.hours; h++) {
      const count = Math.round(perHour * (0.8 + 0.4 * r()));
      for (let i = 0; i < count; i++) {
        const at = d.from + h * HOUR + Math.floor(r() * HOUR);
        const fn = r() < 0.7;
        const err = r() < d.errorRate;
        const status = err ? (r() < 0.8 ? 500 : 503) : r() < 0.05 ? 404 : r() < 0.1 ? 304 : 200;
        const requestId = `req_${d.key}_${h}_${i}`;
        const proxy = { timestamp: at, method: "GET", host, path: PATHS[Math.floor(r() * PATHS.length)], userAgent: ["Mozilla/5.0 (sample)"],
          referer: `https://${host}/`, region: "iad1", statusCode: status, clientIp: `203.0.113.${1 + Math.floor(r() * 250)}`, scheme: "https",
          vercelCache: fn ? "MISS" : "HIT", pathType: fn ? "func" : "static" };
        if (!fn) {
          lines.push({ ...base, id: id(), source: "static", level: "info", requestId, statusCode: status, path: proxy.path, timestamp: at, proxy });
          truth.push({ deployment: d.key, at, status, duration_ms: null });
          continue;
        }
        // A function's time: mostly 20 to 200 ms, a slow tail; the slow release twice as slow with a longer tail.
        const tail = r() < 0.06 ? (d.slow ? 1500 + r() * 2500 : 400 + r() * 600) : 0;
        const ms = Math.round(((20 + r() * 180) * (d.slow ? 2 : 1) + tail) * 100) / 100;
        lines.push({ ...base, id: id(), source: "lambda", level: err ? "error" : "info", type: "stdout", requestId, statusCode: status, path: "/api/[route]",
          entrypoint: "api/index.js", executionRegion: "iad1", message: err ? "Error: the upstream did not answer" : "handled", timestamp: at, proxy },
        { ...base, id: id(), source: "lambda", level: "info", type: "report", requestId, timestamp: at + Math.round(ms),
          message: `REPORT RequestId: ${requestId} Duration: ${ms} ms Billed Duration: ${Math.ceil(ms)} ms Memory Size: 1024 MB Max Memory Used: 88 MB` });
        truth.push({ deployment: d.key, at, status, duration_ms: ms });
      }
      // A background revalidation each hour (proxy -1: no visitor waited) and a preview request: neither counted.
      lines.push({ ...base, id: id(), source: "lambda", level: "info", requestId: `reval_${d.key}_${h}`, timestamp: d.from + h * HOUR + 1000,
        proxy: { timestamp: d.from + h * HOUR + 1000, method: "GET", host, path: "/pricing", statusCode: -1, scheme: "https" } });
      lines.push({ ...base, environment: "preview", id: id(), source: "static", level: "info", statusCode: 200, timestamp: d.from + h * HOUR + 2000,
        proxy: { timestamp: d.from + h * HOUR + 2000, method: "GET", host: `sample-app-git-branch.example.com`, path: "/", statusCode: 200, scheme: "https" } });
    }
  }
  // One function that crashed without answering (statusCode -1 on its own line): a server error the visitor saw.
  const crash = deployments[1]!.from + 5 * HOUR + 777;
  lines.push({ deploymentId: deployments[1]!.provider_id, projectId: project, host, environment: "production", id: id(), source: "lambda", level: "fatal",
    type: "fatal", requestId: "req_crash", statusCode: -1, message: "Function crashed", timestamp: crash });
  truth.push({ deployment: deployments[1]!.key, at: crash, status: 500, duration_ms: null });
  // Delivery order is not request order: shuffle the requests, as a provider's batches arrive.
  for (let i = groups.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [groups[i], groups[j]] = [groups[j]!, groups[i]!]; }
  return { deployments, groups, lines: groups.flat(), truth, project, host };
}

/**
 * The requests as deliveries of about `size` lines (a request's lines never split): NDJSON, every third one a JSON array
 * (both formats Vercel offers). A request whose lines a provider splits across two batches is counted without its
 * duration (src/log-drain.ts joins lines by requestId within a delivery): the sample keeps them together.
 */
export function deliveries(groups: Record<string, unknown>[][], size = 400): string[] {
  const out: string[] = [];
  let part: Record<string, unknown>[] = [];
  const flush = () => { if (part.length) out.push(out.length % 3 === 2 ? JSON.stringify(part) : part.map((l) => JSON.stringify(l)).join("\n")); part = []; };
  for (const g of groups) { if (part.length + g.length > size) flush(); part.push(...g); }
  flush();
  return out;
}
