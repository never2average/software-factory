// A parity snapshot of one build: everything a person, an AI client or the console sees of it, recorded so two builds can
// be compared field by field (diff.mts). A harness of the lane world (testing/console/world.mts), started by parity.py:
//   python3 molds/mold_v0/testing/console/render.py <id> --codebase <lane copy> -- molds/mold_v0/testing/parity/snapshot.mts
//       --out <dir> [--no-shots] [--only mcp,generated,api,pages] [--context-fixture [--memory-search <tool>]]
// Everything runs on this machine, inside the lane world (an embedded throwaway database, the offline Clerk, the console
// served on 127.0.0.1); nothing deployed is contacted. What it writes under <dir>:
//   meta.json                 the build (lane copy, packs) and how long each part took (diff.mts reads only `packs`)
//   mcp/customer.json         the customer MCP server for the lane world's workspace, its owner, over an in-memory client:
//                             initialize (server info, capabilities, instructions), tools/list, prompts/list, prompts/get
//                             for every prompt over an argument matrix (none, each argument alone, all of them),
//                             resources/list, resource templates and resources/read of every resource (the widgets)
//   mcp/admin.json            the admin MCP server (platform staff, Owner role): the same; prompts/get is every skill's text
//   mcp/memory-search.json    with --context-fixture (mold_v0-142): the account context and memory rows seeded for the
//                             workspace and its owner (who the customer server then connects as), and the memory search
//                             tool's answers over them
//   generated/<path>          every *.generated.* file of the lane copy (mcp-tools, docs corpus, pack guides, landing, pack
//                             nav and routes, admin docs, ...), byte for byte
//   api/routes.json           every route the API mounts (method and path), read from a second createApp() that never listens
//   api/<route>.json          the answer to every GET without a path parameter under /api/{app,admin,auth,...} and a few
//                             public ones, as the workspace's owner (who is also platform staff), ids and times masked
//   pages/<page>.json         every console page of surface.mts: HTTP status, where it ended, title, text and links (masked)
//   shots/<sha256>.png        screenshots (390 and 1440 wide, light and dark colour scheme), stored once per content;
//                             pages/<page>.json names them
// Masking (mask.mts) replaces what changes from run to run (times, ports, minted ids and keys) with markers; it never
// drops a field.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { maskJson, maskText, stable, TEXT_MASK_SOURCES } from "./mask.mts";

type Cookie = { name: string; value: string; url: string };
type Page = { pack: string; path: string; label: string; signed_in: boolean; as?: string };
interface Ctx {
  origin: string; api: string; lane: string; pages: Page[]; packs: { id: string; name: string; kind: string }[];
  session: () => Promise<Cookie[]>; sessionAs: Record<string, () => Promise<Cookie[]>>; argv: string[];
}

export const WIDTHS = [390, 1440] as const;
export const SCHEMES = ["light", "dark"] as const;
/** A page taller than this is shot down to here: the top of a page is what a change shows in; a 30 000px PNG is noise. */
const MAX_SHOT_HEIGHT = 6000;
const API_PREFIXES = ["/api/app", "/api/admin", "/api/auth", "/api/packs", "/api/records", "/api/data", "/api/credentials",
  "/api/egress-hosts", "/api/onboarding", "/api/usage", "/api/keys", "/api/schedules", "/api/notices", "/api/metrics", "/api/runs", "/api/workspace-files"];
/** Public answers worth recording as well (no session). */
const PUBLIC_GETS = ["/healthz", "/api/auth/config", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"];
/** Never fetched: streams that do not end, and the run engine's own (a worker token, not a person). */
const SKIP_GET = /\/(stream|events|sse)(\/|$)|^\/api\/(worker|cron)\//;

/** A file name for a route or a page: readable and unique. */
export function fileFor(p: string): string {
  const s = p.replace(/^\/+/, "").replace(/[?#].*$/, (q) => "_" + q.slice(1)).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (s || "root").slice(0, 120);
}

const opt = (argv: string[], k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const write = (f: string, body: string | Buffer) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, body); };
const errText = (e: unknown) => maskText(String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 400));

export async function run(ctx: Ctx): Promise<number> {
  const out = path.resolve(opt(ctx.argv, "--out") ?? "");
  if (!opt(ctx.argv, "--out")) { console.error("snapshot: --out <dir> is required"); return 2; }
  const only = new Set((opt(ctx.argv, "--only") ?? "mcp,generated,api,pages").split(","));
  const shots = !ctx.argv.includes("--no-shots");
  mkdirSync(out, { recursive: true });
  const lane = ctx.lane;
  const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
  const timings: Record<string, number> = {};
  const timed = async <T,>(k: string, f: () => Promise<T>) => { const t = Date.now(); try { return await f(); } finally { timings[k] = Math.round((Date.now() - t) / 100) / 10; } };
  const token = async (c: () => Promise<Cookie[]>) => (await c()).find((x) => x.name === "__session")!.value;

  // Account context and memory rows for the lane workspace and its owner (mold_v0-142), the same in every build that has
  // the tables: the MCP instructions, the context pages and their API then show them, and memory searches are recorded.
  const fixture = ctx.argv.includes("--context-fixture") ? await seedContextFixture(lane, imp, await token(ctx.session)) : null;
  if (only.has("mcp")) await timed("mcp", () => snapMcp(out, lane, imp, fixture, opt(ctx.argv, "--memory-search") ?? "search_memory"));
  if (only.has("generated")) await timed("generated", async () => snapGenerated(out, lane));
  if (only.has("api")) await timed("api", () => snapApi(out, ctx, imp, token));
  if (only.has("pages")) await timed("pages", () => snapPages(out, ctx, shots));

  write(path.join(out, "meta.json"), stable({
    lane: path.basename(lane), packs: ctx.packs, parts: [...only], shots, widths: WIDTHS, schemes: SCHEMES, seconds: timings,
  }));
  console.log(`snapshot: ${out} (${Object.entries(timings).map(([k, v]) => `${k} ${v}s`).join(", ")})`);
  return 0;
}

// ---------- MCP ----------

type McpClient = {
  getServerVersion(): unknown; getServerCapabilities(): unknown; getInstructions(): string | undefined;
  listTools(): Promise<{ tools: any[] }>; listPrompts(): Promise<{ prompts: any[] }>; getPrompt(p: { name: string; arguments?: Record<string, string> }): Promise<unknown>;
  listResources(): Promise<{ resources: any[] }>; listResourceTemplates(): Promise<{ resourceTemplates: any[] }>; readResource(p: { uri: string }): Promise<unknown>;
  connect(t: unknown): Promise<void>; close(): Promise<void>;
};

/** The argument matrix of one prompt: none, each argument alone, every argument. Values are fixed words, so two builds
 * are asked the same thing. */
export function promptMatrix(args: { name: string }[]): Record<string, string>[] {
  const val = (n: string) => `parity-${n}`;
  const out: Record<string, string>[] = [{}];
  for (const a of args) out.push({ [a.name]: val(a.name) });
  if (args.length > 1) out.push(Object.fromEntries(args.map((a) => [a.name, val(a.name)])));
  return out;
}

async function describe(c: McpClient) {
  const settle = async <T,>(f: () => Promise<T>) => { try { return await f(); } catch (e) { return { error: errText(e) } as T; } };
  const tools = (await settle(() => c.listTools())) as { tools?: unknown[]; error?: string };
  const prompts = (await settle(() => c.listPrompts())) as { prompts?: { name: string; arguments?: { name: string }[] }[]; error?: string };
  const prompt_get: Record<string, { args: Record<string, string>; answer: unknown }[]> = {};
  for (const p of prompts.prompts ?? []) {
    prompt_get[p.name] = [];
    for (const args of promptMatrix(p.arguments ?? []))
      prompt_get[p.name]!.push({ args, answer: await settle(() => c.getPrompt({ name: p.name, arguments: args })) });
  }
  const resources = (await settle(() => c.listResources())) as { resources?: { uri: string }[]; error?: string };
  const templates = await settle(() => c.listResourceTemplates());
  const resource_read: Record<string, unknown> = {};
  for (const r of resources.resources ?? []) resource_read[r.uri] = await settle(() => c.readResource({ uri: r.uri }));
  return maskJson({
    initialize: { server: c.getServerVersion(), capabilities: c.getServerCapabilities(), instructions: c.getInstructions() ?? null },
    tools, prompts, prompt_get, resources, resource_templates: templates, resource_read,
  });
}

/**
 * --context-fixture (mold_v0-142): the lane workspace's company context, its owner's own and six memory items (company,
 * the owner's, two subjects), with fixed times, written straight into the tables (the same statements in any build that
 * has them). Returns the owner's user id, which the MCP part then connects as.
 */
async function seedContextFixture(lane: string, imp: (rel: string) => Promise<any>, session: string): Promise<{ userId: string }> {
  const userId = JSON.parse(Buffer.from(session.split(".")[1]!, "base64url").toString()).sub as string;
  const { getDb } = await imp("src/db.ts");
  const db = await getDb();
  const [org] = (await db.query("SELECT id FROM organizations WHERE slug = 'lane-workspace'")) as { id: number }[];
  if (!org) throw new Error("the lane world's workspace (lane-workspace) is not in the database");
  await db.query(`INSERT INTO account_context (org_id, about, audience, competitors, terms, notes_for_ai, updated_at, updated_by)
    VALUES ($1, 'Acme builds a job queue for Node teams.', 'Backend engineers at SaaS startups', '["BullMQ", "Inngest"]', 'A run is a job; a lane is a queue.', 'Keep it short.', '2026-10-01T09:00:00Z', 'customer:lane.owner@example.org')
    ON CONFLICT (org_id) DO NOTHING`, [org.id]);
  await db.query(`INSERT INTO user_context (org_id, user_id, title, focus_product, interests, answer_style, notes, updated_at)
    VALUES ($1, $2, 'Head of DevRel', 'acme-queue', 'why we lose to BullMQ', 'detailed', 'Prefers tables.', '2026-10-01T09:05:00Z') ON CONFLICT (org_id, user_id) DO NOTHING`, [org.id, userId]);
  const items: [string, string, string, string, string][] = [
    ["company", "", "fact", "Acme Queue 3 ships exactly-once delivery.", "2026-10-01T10:00:00Z"],
    ["company", "", "decision", "We stopped competing on price with BullMQ.", "2026-10-02T10:00:00Z"],
    ["company", "", "note", "The pricing page moves in November.", "2026-10-03T10:00:00Z"],
    ["user", userId, "preference", "Lead with the Python numbers.", "2026-10-04T10:00:00Z"],
    ["product", "acme-queue", "fact", "Docs moved to /v3 in October.", "2026-10-05T10:00:00Z"],
    ["product", "Acme Edge", "note", "Edge runtime support is pre-launch.", "2026-10-06T10:00:00Z"],
  ];
  if (!((await db.query("SELECT 1 FROM context_memories WHERE org_id = $1 LIMIT 1", [org.id])) as unknown[]).length)
    for (const [scope, subject, kind, body, at] of items)
      await db.query("INSERT INTO context_memories (org_id, scope, subject, kind, body, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [org.id, scope, subject, kind, body, scope === "user" ? `ai:${userId}` : "customer:lane.owner@example.org", at]);
  return { userId };
}

async function snapMcp(out: string, lane: string, imp: (rel: string) => Promise<any>, fixture: { userId: string } | null = null, memorySearch = "search_memory") {
  const req = createRequire(path.join(lane, "package.json"));
  const { Client } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { InMemoryTransport } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/inMemory.js")).href);
  const connect = async (server: { connect(t: unknown): Promise<void> }) => {
    const client = new Client({ name: "parity-snapshot", version: "1" }) as McpClient;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };
  const { getDb } = await imp("src/db.ts");
  const db = await getDb();
  // The lane world's workspace (world.mts: "Lane workspace", its owner), as /mcp would build its server for that person.
  const row = ((await db.query("SELECT id, slug, name FROM organizations WHERE slug = $1", ["lane-workspace"])) as { id: number; slug: string; name: string }[])[0];
  if (!row) throw new Error("the lane world's workspace (lane-workspace) is not in the database");
  // With the context fixture, as its owner signed in (their own context and memory are part of what they are told).
  const org = { orgId: row.id, slug: row.slug, name: row.name, role: "owner", ...(fixture ? { userId: fixture.userId } : {}) };
  // What /mcp appends to the instructions for this caller: the shell's account context and the host packs' own
  // (src/account-context.ts connectContext, mold_v0-142), else (a build from before) the host packs' context hooks.
  const ac = await imp("src/account-context.ts").catch(() => null) as { connectContext?: (o: unknown) => Promise<string> } | null;
  const { hosts } = await imp("src/host.ts");
  const context = ac?.connectContext ? await ac.connectContext(org)
    : (await Promise.all((hosts() as { mcp?: { context?: (o: unknown) => Promise<string> } }[]).map((h) => h.mcp?.context?.(org).catch(() => "") ?? ""))).join("");
  const { createServer } = await imp("src/server.ts");
  const customer = await connect(createServer(org, context));
  write(path.join(out, "mcp", "customer.json"), stable(await describe(customer)));
  // The memory search's answers over the fixture (its whole answer: text and structured content), when the server has it.
  if (fixture && ((await customer.listTools()).tools as { name: string }[]).some((t) => t.name === memorySearch)) {
    const calls: Record<string, unknown> = {};
    for (const args of [{}, { scope: "company" }, { scope: "me" }, { scope: "product" }, { query: "BullMQ price" }, { scope: "product", product: "acme-queue" }, { query: "nothing matches this" }])
      calls[JSON.stringify(args)] = maskJson(await (customer as unknown as { callTool(p: unknown): Promise<unknown> }).callTool({ name: memorySearch, arguments: args }));
    write(path.join(out, "mcp", "memory-search.json"), stable({ tool: memorySearch, calls }));
  }
  await customer.close();

  const { createAdminServer, adminSkillList } = await imp("src/admin-mcp.ts");
  const admin = await connect(createAdminServer({ actor: "lane.owner@example.org", role: "owner", userId: null }));
  const a = (await describe(admin)) as Record<string, unknown>;
  a.skills = maskJson(adminSkillList());
  write(path.join(out, "mcp", "admin.json"), stable(a));
  await admin.close();
}

// ---------- generated files ----------

/** Every *.generated.* file of the lane copy (node_modules, .next and the build's own outputs left out), sorted. */
export function generatedFiles(lane: string): string[] {
  const outv: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
      const p = path.join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.generated\./.test(e)) outv.push(path.relative(lane, p));
    }
  };
  walk(lane);
  return outv;
}

function snapGenerated(out: string, lane: string) {
  for (const f of generatedFiles(lane)) write(path.join(out, "generated", f), readFileSync(path.join(lane, f)));
}

// ---------- API ----------

/** Every route a fresh createApp() mounts: Router.use and Router.route recorded while it is built, then joined into
 * full paths. Express 5 keeps no mount path on its layers, so this is the only way to list them. */
async function apiRoutes(lane: string, imp: (rel: string) => Promise<any>): Promise<{ method: string; path: string }[]> {
  const req = createRequire(path.join(lane, "package.json"));
  const Router = req(req.resolve("router", { paths: [path.dirname(req.resolve("express"))] }));
  const P = Router.prototype as Record<string, any>;
  const mounts = new Map<object, { parent: object; at: string }[]>();
  const routes = new Map<object, { path: string; route: { methods: Record<string, boolean> } }[]>();
  const origUse = P.use, origRoute = P.route;
  P.use = function (this: object, ...a: unknown[]) {
    const at = typeof a[0] === "string" ? a[0] : Array.isArray(a[0]) ? String(a[0][0]) : "/";
    for (const h of a.flat()) if (typeof h === "function" && (h as { stack?: unknown }).stack) {
      const list = mounts.get(h) ?? []; list.push({ parent: this, at: at === "/" ? "" : at }); mounts.set(h, list);
    }
    return origUse.apply(this, a);
  };
  P.route = function (this: object, p: unknown) {
    const r = origRoute.call(this, p);
    const list = routes.get(this) ?? [];
    for (const one of Array.isArray(p) ? p : [p]) if (typeof one === "string") list.push({ path: one, route: r });
    routes.set(this, list);
    return r;
  };
  let app: { router: object };
  try { app = (await imp("src/http.ts")).createApp(); } finally { P.use = origUse; P.route = origRoute; }
  // An express app's own router is the root; any router mounted (possibly twice) contributes every prefix it is under.
  const prefixes = (r: object, seen = new Set<object>()): string[] => {
    if (r === app.router) return [""];
    if (seen.has(r)) return [];
    seen.add(r);
    return (mounts.get(r) ?? []).flatMap((m) => prefixes(m.parent, seen).map((p) => p + m.at));
  };
  const found = new Set<string>();
  for (const [r, list] of routes) for (const pre of prefixes(r)) for (const x of list) {
    for (const m of Object.keys(x.route.methods)) if (x.route.methods[m]) found.add(`${m.toUpperCase()} ${(pre + x.path).replace(/\/$/, "") || "/"}`);
  }
  return [...found].sort().map((s) => { const [method, p] = s.split(" "); return { method: method!, path: p! }; });
}

async function snapApi(out: string, ctx: Ctx, imp: (rel: string) => Promise<any>, token: (c: () => Promise<Cookie[]>) => Promise<string>) {
  const routes = await apiRoutes(ctx.lane, imp);
  write(path.join(out, "api", "routes.json"), stable(routes.map((r) => `${r.method} ${r.path}`)));
  const gets = routes.filter((r) => r.method === "GET" && !/[:*(]/.test(r.path) && API_PREFIXES.some((p) => r.path === p || r.path.startsWith(p + "/")) && !SKIP_GET.test(r.path)).map((r) => r.path);
  const fetchOne = async (p: string, auth: string | null) => {
    try {
      const r = await fetch(`${ctx.api}${p}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {}, redirect: "manual", signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* text: kept as it is (masked) */ }
      return { status: r.status, type: (r.headers.get("content-type") ?? "").split(";")[0], body: maskJson(body) };
    } catch (e) { return { status: 0, error: errText(e) }; }
  };
  for (const p of gets) write(path.join(out, "api", `${fileFor(p)}.json`), stable({ path: p, as: "owner", ...(await fetchOne(p, await token(ctx.session))) }));
  // The admin settings path the plan names, whatever it answers (today the settings are /api/admin/onboarding/compute).
  for (const p of ["/api/admin/settings"]) if (!gets.includes(p)) write(path.join(out, "api", `${fileFor(p)}.json`), stable({ path: p, as: "owner", ...(await fetchOne(p, await token(ctx.session))) }));
  for (const p of PUBLIC_GETS) write(path.join(out, "api", "public", `${fileFor(p)}.json`), stable({ path: p, as: "nobody", ...(await fetchOne(p, null)) }));
  console.log(`snapshot: api ${routes.length} routes, ${gets.length} GETs recorded`);
}

// ---------- pages ----------

/** The masks of mask.mts applied to the page's own text nodes, before its text is read and its screenshots taken: a time,
 * a port or a minted key then renders the same every run, and nothing is hidden (the marker shows where it was). */
async function maskDom(p: { evaluate<R, A>(f: (a: A) => R, a: A): Promise<R> }) {
  await p.evaluate((masks: readonly (readonly [string, string, string])[]) => {
    const res = masks.map(([src, flags, to]) => [new RegExp(src, flags), to] as const);
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const before = n.nodeValue ?? "";
      let after = before;
      for (const [re, to] of res) after = after.replace(re, to);
      if (after !== before) n.nodeValue = after;
    }
    // A leaf element whose text React split into several nodes (`{k.key_prefix}…`): masked as one text.
    for (const el of document.body.querySelectorAll("*")) {
      if (el.children.length || el.childNodes.length < 2) continue;
      const before = el.textContent ?? "";
      let after = before;
      for (const [re, to] of res) after = after.replace(re, to);
      if (after !== before) el.textContent = after;
    }
  }, TEXT_MASK_SOURCES).catch(() => { /* a page that navigated away: its text is read as it is */ });
}

async function snapPages(out: string, ctx: Ctx, shots: boolean) {
  const { playwright, contextFor, load } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "console", "browser.mjs")).href);
  const browser = await playwright().chromium.launch();
  const index: { file: string; path: string; pack: string }[] = [];
  try {
    for (const page of ctx.pages) {
      const file = fileFor(page.path + (page.as ? `#${page.as}` : ""));
      const rec: Record<string, unknown> = { pack: page.pack, path: page.path, label: page.label, signed_in: page.signed_in, ...(page.as ? { as: page.as } : {}) };
      const { context } = await contextFor(browser, ctx, page, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      try {
        const p = await context.newPage();
        const res = await load(p, ctx, page);
        Object.assign(rec, { ok: res.ok, ...(res.ok ? {} : { why: maskText(res.why) }) });
        // A page still saying "Loading…" (a busy machine) is given up to 15s more, as browser.mjs does for skeletons.
        await p.waitForFunction(() => ![...document.querySelectorAll("body *")].some((e) => e.children.length === 0 && /^\s*Loading(…|\.\.\.)?\s*$/.test(e.textContent ?? "") && (e as HTMLElement).offsetParent !== null),
          null, { timeout: 15000 }).catch(() => { rec.note = "still loading after 15s more (recorded as it stood)"; });
        // Then until its text stops changing (two reads 400ms apart agree; at most 8s): a tab or a row that renders after
        // its own data arrives is part of the page, and a busy machine must not leave it out of one snapshot.
        for (let i = 0, last = ""; i < 20; i++) {
          const now = await p.evaluate(() => document.body?.innerText ?? "").catch(() => "");
          if (i && now === last) break;
          last = now; await p.waitForTimeout(400);
        }
        await maskDom(p);
        const at = new URL(p.url());
        const facts = await p.evaluate(() => ({
          title: document.title,
          text: document.body?.innerText ?? "",
          links: [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.getAttribute("href") ?? "", text: (a as HTMLElement).innerText.replace(/\s+/g, " ").trim() })),
        })).catch((e: Error) => ({ title: "", text: `(could not read the page: ${e.message.split("\n")[0]})`, links: [] }));
        Object.assign(rec, {
          status: res.status ?? null, at: maskText(at.pathname + at.search), title: maskText(facts.title),
          text: maskText(facts.text).split("\n").map((l: string) => l.trimEnd()).filter((l: string, i: number, a: string[]) => l || (a[i - 1] ?? "") !== ""),
          links: facts.links.map((l: { href: string; text: string }) => ({ href: maskText(l.href.replace(ctx.origin, "")), text: maskText(l.text) })),
        });
        if (shots) {
          const taken: Record<string, string> = {};
          for (const width of [...WIDTHS].reverse()) {
            await p.setViewportSize({ width, height: width < 800 ? 844 : 900 });
            for (const scheme of SCHEMES) {
              await p.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
              await p.waitForTimeout(250);
              await maskDom(p);   // a re-render after the resize may have put a time back
              const h = await p.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
              const png: Buffer = await p.screenshot({ fullPage: true, animations: "disabled", caret: "hide", clip: { x: 0, y: 0, width, height: Math.min(Math.max(h, 1), MAX_SHOT_HEIGHT) } });
              const sha = createHash("sha256").update(png).digest("hex");
              const f = path.join(out, "shots", `${sha}.png`);
              if (!existsSync(f)) write(f, png);
              taken[`${width}-${scheme}`] = sha;
            }
          }
          rec.shots = taken;
        }
      } catch (e) {
        Object.assign(rec, { ok: false, why: errText(e) });
      } finally {
        await context.close();
      }
      write(path.join(out, "pages", `${file}.json`), stable(rec));
      index.push({ file, path: page.path, pack: page.pack });
    }
  } finally {
    await browser.close();
  }
  write(path.join(out, "pages", "_index.json"), stable(index));
  console.log(`snapshot: pages ${index.length}${shots ? `, ${existsSync(path.join(out, "shots")) ? readdirSync(path.join(out, "shots")).length : 0} distinct screenshots` : ""}`);
}
