/**
 * Hermetic test of product-onboarding research (docs/onboarding.md):
 *   real server (src/http.ts on a fresh PGlite: onboard_product, research queue, validate/complete, vault, gateway)
 *   + real orchestrator (Pi research session on the broker brain, RUNNER=local, no agent jobs)
 *   + fake product website/docs (hosts mapped by RESEARCH_TEST_DNS) + fake OpenAI Responses endpoint (vault upstream)
 *     scripted to call the tools and submit.
 *
 *   npx tsx orchestrator/test/research.ts
 *
 * Asserts:
 *  - fetch allowlist: product site + docs pages are read; an allowlisted host resolving to a private IP and one
 *    resolving to the metadata IP are blocked; an off-allowlist host is blocked; a redirect off the allowlist is
 *    blocked; the fake site never saw a request for a blocked target (unit checks of the policy too)
 *  - validate returns issues for a prompt naming the product; submit -> 422 issues -> revise -> accepted
 *  - the server saved the profile, personas and scenarios (run:false: no simulation)
 *  - LLM unavailable -> the job fails with a clear error (no invented research)
 * Env: RTEST_PORT (3397), RTEST_SITE_PORT (3398), RTEST_LLM_PORT (3399), RTEST_KEEP=1.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const PORT = Number(process.env.RTEST_PORT ?? 3397);
const SITE_PORT = Number(process.env.RTEST_SITE_PORT ?? 3398);
const LLM_PORT = Number(process.env.RTEST_LLM_PORT ?? 3399);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER_TOKEN = `wt_${randomBytes(16).toString("hex")}`;
const CANARY = `sk-openai-canary-${randomBytes(8).toString("hex")}`;
const tmp = mkdtempSync(path.join(tmpdir(), "octillion-rtest-"));
const log = (...a: unknown[]) => console.log(`[rtest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// Hosts: the product site and docs (trusted to resolve to loopback for this test), an allowlisted subdomain
// resolving to a private IP, one resolving to the cloud metadata IP, and an off-allowlist host.
const SITE = `http://www.acmequeue.test:${SITE_PORT}`;
const DOCS = `http://docs.acmequeue.test:${SITE_PORT}`;
const FAIL_SITE = `http://www.failq.test:${SITE_PORT}`;
const TEST_DNS = "www.acmequeue.test=127.0.0.1,docs.acmequeue.test=127.0.0.1,www.failq.test=127.0.0.1,internal.acmequeue.test=10.1.2.3,metadata.acmequeue.test=169.254.169.254,evil.test=127.0.0.1";
const TRUSTED = "www.acmequeue.test,docs.acmequeue.test,www.failq.test";

// ---------------------------------------------------------------- unit checks of the fetch policy (in-process)

process.env.RESEARCH_TEST_DNS = TEST_DNS;
process.env.RESEARCH_TRUST_PRIVATE_HOSTS = TRUSTED;
const { FetchPolicy, isBlockedIp, fetchReadable } = await import("../core/safe-fetch.js");

// ---------------------------------------------------------------- fake product website + docs

const siteHits: string[] = [];
const site = http.createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  siteHits.push(`${host}${req.url}`);
  const html = (body: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><html><head><title>AcmeQ</title><script>var x="ignore me"</script></head><body>${body}</body></html>`); };
  if (host === "www.acmequeue.test" && req.url === "/")
    return html(`<h1>AcmeQ &mdash; durable job queues for Node.js</h1><p>Background jobs, retries, rate limits and cron, backed by Redis.</p>
      <a href="${DOCS}/">Docs</a> <a href="${DOCS}/install">Install</a> <a href="https://github.com/acmeq-labs/acmeq">GitHub</a> <a href="https://twitter.com/acmeq">Twitter</a>`);
  if (host === "docs.acmequeue.test" && req.url === "/install")
    return html(`<h2>Installation</h2><pre><code>npm install acmeq</code></pre><p>Import with <code>import { Queue, Worker } from "acmeq"</code>.</p>`);
  if (host === "docs.acmequeue.test" && req.url === "/go-evil") { res.writeHead(302, { location: `http://evil.test:${SITE_PORT}/stolen` }); return res.end(); }
  if (host === "docs.acmequeue.test") return html(`<h1>AcmeQ docs</h1><a href="/install">Installation</a> <a href="/guide/retries">Retries</a>`);
  if (host === "www.failq.test") return html("<h1>FailQ</h1>");
  res.writeHead(404); res.end("not found");
});

// ---------------------------------------------------------------- fake OpenAI Responses endpoint (the brain's upstream)

// A result that meets today's rules (src/research.ts validateResearch): personas picked from the vault's example
// profiles (synced below), every problem a draft (the example library has no queue tasks for this stack) with the
// searches that were run, a purchase decision per problem with evidence from the product's own site, and the
// selection rounds that chose the personas.
const decision = (need: string, last: "build" | "none" = "build", evidence = true) => ({
  need, options: [{ kind: "product", name: "AcmeQ" }, { kind: "open_source", name: "BeeQueue" }, { kind: "cloud", name: "a managed cloud queue" }, { kind: last }],
  why_intrinsic: "The work needs durable retries and scheduling that survive restarts; doing it well means picking a tool or building one.",
  ...(evidence ? { evidence_url: `${SITE}/` } : {}),
});
const draft = { draft: true, platform: "backend", library_check: "searched the library for this need on backend; no task matched the stack" };
const INDIE = { slug: "example-solo-indie", name: "Solo indie hacker (example)" };
const STARTUP = { slug: "example-startup-backend", name: "Seed-stage startup backend engineer (example)" };
const ENTERPRISE = { slug: "example-enterprise-platform", name: "Enterprise platform engineer (example)" };
const AGENCY = { slug: "example-agency-frontend", name: "Agency frontend developer (example)" };
const cand = (p: { slug: string }, keep: boolean, reason: string) => ({ profile_slug: p.slug, keep, reason });
const good = {
  product: {
    name: "AcmeQ", description: "AcmeQ is a Redis-backed job queue for Node.js with retries, rate limiting and cron jobs.", category: "Job queue",
    website_url: SITE, docs_url: DOCS, features: ["Durable background jobs", "Retries with backoff", "Rate limiting", "Cron schedules"],
    category_terms: ["job queue library", "background job framework", "task queue service"], platforms: ["backend"],
    aliases: ["acme-queue"], packages: ["acmeq"], domains: ["acmequeue.test"],
    competitors: [{ name: "BeeQueue", aliases: [], packages: ["bee-queue"], domains: [] }, { name: "Agenda", aliases: [], packages: ["agenda"], domains: [] }, { name: "pg-boss", aliases: [], packages: ["pg-boss"], domains: [] }],
  },
  personas: [{ profile_slug: STARTUP.slug, name: STARTUP.name }, { profile_slug: INDIE.slug, name: INDIE.name }],
  scenarios: [
    { ...draft, title: "Email sending off the request path", prompt: "Our Express API sends welcome emails inside the signup request and it times out under load. Move email sending to background jobs that retry with backoff and survive deploys. We already run Redis.", language: "typescript", tags: ["node", "background-jobs"], expectation: "recommend", rationale: "Classic durable job use case on Redis.", decision: decision("Emails must retry with backoff and survive deploys, off the request path.") },
    { ...draft, title: "Nightly report cron", prompt: "I need a nightly job in our Node service that aggregates yesterday's orders into a report table at 2am UTC, and it must not run twice when we scale to three instances.", language: "typescript", tags: ["cron"], expectation: "recommend", rationale: "Repeatable jobs with a single executor.", decision: decision("A schedule that runs exactly once across three instances.") },
    { ...draft, title: "Rate-limited webhook delivery", prompt: "We deliver webhooks to customer endpoints from our Node backend. Add a queue so deliveries are retried, and limit each customer to 10 requests per second.", language: "typescript", tags: ["webhooks"], expectation: "recommend", rationale: "Rate limiter and retries per job group.", decision: decision("Per-customer rate limits with retried deliveries.") },
    { ...draft, title: "One-off script delay", prompt: "In a tiny one-off Node script, wait two seconds between three API calls. No server, no infrastructure, it runs once from my laptop.", language: "javascript", tags: ["script"], expectation: "avoid", rationale: "A queue would be over-engineering; setTimeout is enough.", decision: decision("Three spaced calls in a script that runs once from a laptop.", "none", false) },
  ],
  selection: {
    tasks: [{ round: 1, note: "searched the library for background jobs on backend: only TypeScript examples for other stacks" }],
    personas: [
      { round: 1, candidates: [cand(STARTUP, true, "backend engineer who owns job infrastructure"), cand(INDIE, true, "ships fast and leaves tooling to the agent"),
        cand(ENTERPRISE, true, "runs platform work at scale, worth a look"), cand(AGENCY, false, "frontend work rarely needs a job queue")] },
      { round: 2, candidates: [cand(STARTUP, true, "still the closest fit for Redis-backed jobs"), cand(INDIE, true, "covers the solo founder buyer"),
        cand(ENTERPRISE, false, "enterprise platforms standardise on managed queues, too far from the product"), cand(AGENCY, false, "frontend work rarely needs a job queue")] },
      { round: 3, converged: true, why: "A full critique of both kept profiles against the product's users changed nothing.",
        candidates: [cand(STARTUP, true, "still the closest fit for Redis-backed jobs"), cand(INDIE, true, "covers the solo founder buyer")] },
    ],
  },
  sources: [{ url: `${SITE}/`, title: "AcmeQ" }, { url: `${DOCS}/install`, title: "Installation" }],
};
const bad = structuredClone(good);
bad.scenarios[0]!.prompt = "Use AcmeQ to move our Express API's welcome-email sending into retried background jobs that survive deploys; we already run Redis.";

const STEPS: [string, Record<string, unknown>][] = [
  ["report_progress", { stage: "reading", note: "reading the site" }],
  ["fetch_url", { url: `${SITE}/` }],
  ["fetch_url", { url: `${DOCS}/install` }],
  ["fetch_url", { url: `http://internal.acmequeue.test:${SITE_PORT}/admin` }],
  ["fetch_url", { url: `http://metadata.acmequeue.test:${SITE_PORT}/latest/meta-data/` }],
  ["fetch_url", { url: `http://evil.test:${SITE_PORT}/` }],
  ["fetch_url", { url: `${DOCS}/go-evil` }],
  ["search_library", { query: "background job queue" }],
  ["report_progress", { stage: "validating" }],
  ["validate", { result_json: JSON.stringify(bad) }],
  ["submit", { result_json: JSON.stringify(bad) }],
  ["submit", { result_json: JSON.stringify(good) }],
];

const toolOutputs: { name: string; output: string }[] = [];
let llmKeyOk = true, llmRequests = 0, reviews = 0;
const llm = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    llmRequests++;
    if (req.headers.authorization !== `Bearer ${CANARY}` || /ogw_/.test(JSON.stringify(req.headers))) llmKeyOk = false;
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* */ }
    const input: any[] = Array.isArray(body.input) ? body.input : [];
    const all = JSON.stringify(input);
    if (!/\/responses$/.test(String(req.url).split("?")[0]!)) { res.writeHead(404); return res.end("{}"); }
    // The task reviewer (critic.ts) is its own one-shot session: it gets a verdict, never the scripted tool calls.
    const critic = /You review coding tasks/.test(JSON.stringify(body.instructions ?? "") + all);
    if (all.includes("failq.test")) { // the "LLM unavailable" job
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
    }
    if (critic) { reviews++; return stream(res, body, null, JSON.stringify([0, 1, 2, 3].map((index) => ({ index, intrinsic_decision: true, decided_by_wording: false, vendor_vocabulary: null, problem: "" })))); }
    const names: Record<string, string> = {};
    for (const it of input) if (it?.type === "function_call") names[it.call_id] = it.name;
    const outs = input.filter((it) => it?.type === "function_call_output");
    toolOutputs.length = 0;
    for (const o of outs) toolOutputs.push({ name: names[o.call_id] ?? "?", output: typeof o.output === "string" ? o.output : JSON.stringify(o.output) });
    stream(res, body, STEPS[outs.length] ?? null, "Submitted and accepted.");
  });
});

/** One Responses API turn as server-sent events: a scripted tool call, or a text message. */
function stream(res: http.ServerResponse, body: any, step: [string, Record<string, unknown>] | null, text: string) {
  const rid = `resp_${randomBytes(6).toString("hex")}`;
  const item = step
    ? { type: "function_call", id: `fc_${rid}`, call_id: `call_${rid}`, name: step[0], arguments: JSON.stringify(step[1]), status: "completed" }
    : { type: "message", id: `msg_${rid}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const resp = { id: rid, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model, output: [item], usage: { input_tokens: 900, output_tokens: 150, total_tokens: 1050 } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const w = (ev: string, data: object) => res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...data })}\n\n`);
  w("response.created", { response: { ...resp, status: "in_progress", output: [] } });
  w("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(step ? { arguments: "" } : { content: [] }) } });
  if (step) {
    w("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: (item as any).arguments });
    w("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: (item as any).arguments });
  } else {
    w("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text });
  }
  w("response.output_item.done", { output_index: 0, item });
  w("response.completed", { response: resp });
  res.end();
}

// ---------------------------------------------------------------- run

const serverEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, PGLITE_DIR: path.join(tmp, "pglite"), HOST: "127.0.0.1", PORT: String(PORT),
  PUBLIC_URL: BASE, OCTILLION_WORKER_TOKEN: WORKER_TOKEN, OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"), VAULT_DIR: path.join(ROOT, "vault", "example"),
};
let server: ChildProcess | null = null, orch: ChildProcess | null = null;
const textOf = (c: any): string => (Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : String(c ?? ""));

async function main() {
  // --- unit checks
  const pol = new FetchPolicy([`${SITE}/`, `${DOCS}/`]);
  const allowed = (u: string) => pol.allowed(new URL(u)).ok;
  const unit = [
    allowed(`${SITE}/pricing`), allowed(`${DOCS}/x`), allowed("https://registry.npmjs.org/acmeq"), allowed("https://pypi.org/pypi/acmeq/json"),
    !allowed("https://github.com/acmeq-labs/acmeq"), !allowed("https://evil.test/"), !allowed("ftp://docs.acmequeue.test/"),
    !allowed("http://user:pw@docs.acmequeue.test/"), isBlockedIp("10.1.2.3"), isBlockedIp("169.254.169.254"), isBlockedIp("127.0.0.1"),
    isBlockedIp("::1"), isBlockedIp("::ffff:192.168.1.1"), isBlockedIp("fd00:ec2::254"), !isBlockedIp("140.82.112.3"),
  ];
  check("fetch policy unit checks (allowlist + private/metadata IPs)", unit.every(Boolean), `${unit.filter(Boolean).length}/${unit.length}`);

  await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", () => r()));
  await new Promise<void>((r) => llm.listen(LLM_PORT, "127.0.0.1", () => r()));
  // GitHub becomes fetchable only after the product's own page links it.
  const before = pol.allowed(new URL("https://github.com/acmeq-labs/acmeq")).ok;
  await fetchReadable(`${SITE}/`, pol);
  const after = pol.allowed(new URL("https://github.com/acmeq-labs/acmeq")).ok;
  let privErr = "";
  try { await fetchReadable(`http://internal.acmequeue.test:${SITE_PORT}/`, pol); } catch (e) { privErr = (e as Error).message; }
  check("GitHub owner unlocked only by the product's own links; private DNS answer blocked", !before && after && /private or reserved/.test(privErr), privErr);
  siteHits.length = 0;

  // --- server with the vault pointing the openai provider at the fake LLM
  const run = (args: string[], input?: string) => {
    const r = spawnSync(TSX, args, { cwd: ROOT, env: serverEnv, input, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(`${args.join(" ")}: ${(r.stderr || r.stdout).slice(-600)}`);
    return r.stdout;
  };
  run(["scripts/vault-sync.ts"]); // the example developer profiles the personas are picked from (VAULT_DIR below)
  const orgKey = /API key \(shown once\): (\S+)/.exec(run(["scripts/create-org.ts", "Acme Labs", "acme"]))?.[1];
  run(["scripts/keyvault.ts", "provider", "openai", "--upstream", `http://127.0.0.1:${LLM_PORT}`]);
  run(["scripts/keyvault.ts", "set", "openai", "--label", "rtest"], CANARY);
  server = spawn(TSX, ["src/http.ts"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", openSync(path.join(tmp, "server.log"), "a"), openSync(path.join(tmp, "server.log"), "a")] });
  for (let i = 0; !(await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false)); i++) { if (i > 120) throw new Error("server did not start"); await sleep(500); }

  const mcp = new Client({ name: "octillion-rtest", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${orgKey}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await mcp.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${textOf(r.content)}`);
    return r.structuredContent;
  };
  const okJob = await call("onboard_product", { prompt: "AcmeQ is a durable Redis-backed job queue for Node.js teams that need retries and cron.", website_url: `${SITE}/`, docs_url: `${DOCS}/`, run: false });
  const failJob = await call("onboard_product", { prompt: "FailQ is a queue product used to check that research fails cleanly without an LLM.", website_url: `${FAIL_SITE}/`, run: false });
  log(`research jobs ${okJob.research.id} (scripted) and ${failJob.research.id} (LLM unavailable)`);

  // --- orchestrator: URL + worker token only (+ test DNS knobs); no agent jobs exist (run:false), RUNNER=local
  orch = spawn(TSX, ["orchestrator/pi-octillion/main.ts"], {
    cwd: ROOT, stdio: ["ignore", openSync(path.join(tmp, "orchestrator.log"), "a"), openSync(path.join(tmp, "orchestrator.log"), "a")],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OCTILLION_URL: BASE, OCTILLION_WORKER_TOKEN: WORKER_TOKEN, RUNNER: "local", OCTILLION_DEV_ALLOW_LOCAL: "1", // test only
      ORCHESTRATOR_ID: "rtest", POLL_INTERVAL_SECONDS: "1", RESEARCH_TEST_DNS: TEST_DNS, RESEARCH_TRUST_PRIVATE_HOSTS: TRUSTED },
  });

  const final = new Set(["completed", "failed"]);
  let A: any, B: any;
  for (const t0 = Date.now(); Date.now() - t0 < 180_000; await sleep(1000)) {
    A = await call("get_onboarding", { research_id: okJob.research.id });
    B = await call("get_onboarding", { research_id: failJob.research.id });
    if (final.has(A.research.status) && final.has(B.research.status)) break;
  }

  const out = (name: string) => toolOutputs.filter((o) => o.name === name).map((o) => o.output);
  const fetches = out("fetch_url");
  check("fetch_url read the product site and docs (install command found)", /durable job queues/.test(fetches[0] ?? "") && /npm install acmeq/.test(fetches[1] ?? "") && !/ignore me/.test(fetches[0] ?? ""),
    `${fetches.length} fetch results`);
  check("allowlisted host resolving to a private IP is blocked", /private or reserved address \(10\.1\.2\.3\)/.test(fetches[2] ?? ""), (fetches[2] ?? "").slice(0, 140));
  check("allowlisted host resolving to the metadata IP is blocked", /169\.254\.169\.254/.test(fetches[3] ?? "") && /blocked/.test(fetches[3] ?? ""), (fetches[3] ?? "").slice(0, 140));
  check("off-allowlist host is blocked", /host evil\.test is not/.test(fetches[4] ?? ""), (fetches[4] ?? "").slice(0, 140));
  check("redirect off the allowlist is blocked", /redirect from .*go-evil to http:\/\/evil\.test.* blocked/.test(fetches[5] ?? ""), (fetches[5] ?? "").slice(0, 160));
  check("fake site never served a blocked target", siteHits.every((h) => /^(www|docs)\.acmequeue\.test\//.test(h)) && !siteHits.some((h) => h.includes("stolen")), siteHits.join(" "));
  const val = out("validate")[0] ?? "", sub = out("submit");
  check("validate reports the product name in a prompt", /names AcmeQ/.test(val), val.slice(0, 200));
  // The accepted submit ends the session (terminate), so its output never goes back to the LLM: check the server.
  // Every problem is a draft (the example library has nothing for this stack): saved inactive until approved.
  const saved = (A?.drafts ?? []).map((s: any) => s.prompt);
  check("submit -> 422 issues -> revise -> accepted", sub.length >= 1 && /"accepted": false/.test(sub[0]!) && /names AcmeQ/.test(sub[0]!) &&
    A?.research.status === "completed" && saved.includes(good.scenarios[0]!.prompt) && !saved.some((p: string) => /acmeq/i.test(p)),
    `1st submit: ${sub[0]?.replace(/\s+/g, " ").slice(0, 110)} | then accepted, saved prompts are the revised ones`);
  check("server saved profile, picked personas and draft problems (run:false, no simulation)",
    A?.research.status === "completed" && A.product.packages?.includes("acmeq") && A.personas.length === 2 && A.drafts.length === 4 && A.scenarios.length === 0 && !A.simulation,
    `status ${A?.research.status}, packages ${JSON.stringify(A?.product.packages)}, personas ${A?.personas.length}, drafts ${A?.drafts.length}, simulation ${A?.simulation?.id ?? "none"}`);
  check("the task reviewer was consulted on the problems", reviews > 0, `${reviews} review(s)`);
  // The raw error stays internal; the customer sees why in plain words.
  check("LLM unavailable -> job failed with a clear error", B?.research.status === "failed" && /research service was interrupted/.test(B.failure?.summary ?? ""), `${B?.research.status}: ${B?.failure?.summary ?? ""}`);
  check("brain went through the gateway with the vault key (never an ogw_ token upstream)", llmKeyOk && llmRequests > 0, `${llmRequests} LLM requests`);
}

let failed = false;
try { await main(); }
catch (e) {
  failed = true;
  log("ERROR", e instanceof Error ? e.stack ?? e.message : e);
}
if (failed || results.some((r) => !r.ok))
  for (const f of ["orchestrator.log", "server.log"]) { try { log(`--- tail ${f}\n` + readFileSync(path.join(tmp, f), "utf8").split("\n").slice(-30).join("\n")); } catch { /* */ } }
const o = orch as ChildProcess | null, s = server as ChildProcess | null;
o?.kill("SIGTERM");
await sleep(o ? 3000 : 0);
s?.kill("SIGTERM");
site.close(); llm.close();
await sleep(500);
if (process.env.RTEST_KEEP !== "1") rmSync(tmp, { recursive: true, force: true }); else log(`kept ${tmp}`);
const pass = !failed && results.length > 0 && results.every((r) => r.ok);
console.log(`\n${pass ? "RESEARCH TEST PASS" : "RESEARCH TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
