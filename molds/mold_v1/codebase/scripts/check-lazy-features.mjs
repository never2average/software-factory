#!/usr/bin/env node
/**
 * THE HEAVY LIBRARIES LOAD ON FIRST USE, AND STILL WORK WHEN THEY DO.
 *
 * Opening the app used to download shiki, katex, mermaid, recharts and the whole Ops Center before the person did
 * anything. They are now fetched when a rendered message actually contains a code fence, math, a diagram or a chart,
 * and when a PDF, a workbook or the data room is opened. Moving an import behind `import()` fails quietly in both
 * directions: a stray static import puts a library back into every page load, and a lazy one that never arrives
 * leaves a message that renders as raw source. So this checks both, over a PRODUCTION build (`npm run build` first;
 * CI's Build step leaves one in .next/):
 *
 *   1. THE BUILD: no chunk the chat page loads first (.next/diagnostics/route-bundle-stats.json) carries a heavy
 *      library or a lazily loaded part of the app, recognised by a string only it contains. (Module IDENTITY, from
 *      source maps, is check:bundle-budget's; this is the cheap pass that also runs without a second build.)
 *   2. RENDERED: `next start`, Chromium, the ops API faked, a signed-in person with a cached chat:
 *        - a plain chat, opened and read: none of the heavy libraries is downloaded;
 *        - each renderer arrives and works: a code fence is highlighted, a mermaid fence is a diagram, `$$…$$` is
 *          typeset (with katex's stylesheet), CJK emphasis is parsed, a dashboard draws its chart and its mermaid
 *          chart; fences nested in a list or a blockquote load their plugins too; a reply that gains a fence while
 *          it streams is highlighted;
 *        - a plugin that arrives late (katex held back 5 s) does not redraw a diagram already on screen;
 *        - an attached PDF paints a page, an agent-published .xlsx opens as a table, the data room opens on its
 *          workbook, the Ops Center opens, the control panel renders (its placeholder holds its place: the composer
 *          does not move when it lands);
 *        - a chunk that cannot be fetched (the data room, the Ops Center, a chart, the control panel) shows a card
 *          with Retry and leaves the chat working; once the network is back, Retry loads it.
 *
 *   npm run check:lazy-features                 both passes (needs Chromium: npx playwright install chromium)
 *   npm run check:lazy-features -- --no-render  the build only
 *   npm run check:lazy-features -- --dir <d>    a built checkout other than this one
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import http from "node:http";
import { MOCKS } from "./lib/rendered-text.mjs";
import { freePort, waitForNextStart } from "./lib/own-listener.mjs";
import { until } from "./lib/wait.mjs";
import { FOLDER } from "../agent/lib/dataroom-folders.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const DIR = argAfter("--dir") ?? ROOT;
const NO_RENDER = process.argv.includes("--no-render");
const require = createRequire(join(ROOT, "package.json"));

/** A string each library's code contains and nothing else in the app does (found from the source maps, then checked
 *  below to still match some chunk of this build, so a signature that stops matching fails instead of passing). */
export const HEAVY = {
  shiki: ["Must invoke loadWasm first", "No grammar provided for"],
  katex: ["KaTeX parse error"],
  mermaid: ["Syntax error in text"],
  recharts: ["recharts-wrapper"],
  "pdf.js": ["Setting up fake worker"],
  SheetJS: ["SheetJS"],
  motion: ["invalid-easing-type", "onMeasureDragConstraints"],
  "@dnd-kit": ["registerDroppable", "droppableRects"],
  "remark-cjk-friendly": ["expected `attentionMarkers` to be populated"],
};
/** Parts of the app that load when opened; they may be downloaded on use, never in the first load. */
export const LAZY_APP = {
  "the control panel": ["Plan mode on — agent plans before acting"],
  "the Ops Center": ["aside[aria-label='Details']"],
  "the workflows panel": ["Cancelled from the workflow editor"],
};
const matching = (table, text) => Object.entries(table).filter(([, sigs]) => sigs.some((s) => text.includes(s))).map(([k]) => k);
const heavyIn = (text) => matching(HEAVY, text);
const lazyAppIn = (text) => matching(LAZY_APP, text);

const failures = [];
const passes = [];
const check = (name, ok, detail = "") => (ok ? passes : failures).push(ok ? name : `${name}${detail ? `: ${detail}` : ""}`);

/* --------------------------------------------------------------------------------------------- 1. the build */

const statsFile = join(DIR, ".next/diagnostics/route-bundle-stats.json");
if (!existsSync(statsFile)) {
  console.error(`${statsFile} is missing: run \`npm run build\` first.`);
  process.exit(1);
}
const chat = JSON.parse(readFileSync(statsFile, "utf8")).find((r) => r.route === "/");
const firstLoad = chat.firstLoadChunkPaths.map((p) => join(DIR, p));
for (const file of firstLoad) {
  const text = readFileSync(file, "utf8");
  const libs = [...heavyIn(text), ...lazyAppIn(text)];
  check(`first load carries no heavy library or lazy panel (${file.split("/").pop()})`, libs.length === 0, `carries ${libs.join(", ")}`);
}
// The signatures must still find their libraries, or the check above passes by recognising nothing.
const allChunks = readdirSync(join(DIR, ".next/static/chunks")).filter((f) => f.endsWith(".js"));
const found = new Set(allChunks.flatMap((f) => { const t = readFileSync(join(DIR, ".next/static/chunks", f), "utf8"); return [...heavyIn(t), ...lazyAppIn(t)]; }));
// motion is no longer used anywhere (the shimmer is CSS), so it is only ever looked for in the first load.
const NOT_IN_THE_BUILD = new Set(["motion"]);
for (const lib of [...Object.keys(HEAVY), ...Object.keys(LAZY_APP)].filter((l) => !NOT_IN_THE_BUILD.has(l))) check(`the build still contains ${lib} (as a lazy chunk)`, found.has(lib), "its signature matched no chunk: update HEAVY / LAZY_APP");

/* ----------------------------------------------------------------------------------------------- 2. rendered */

/** A one-page PDF that says "LAZY PDF OK". Offsets are computed, so the xref is exact. */
function tinyPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 40 100 Td (LAZY PDF OK) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function tinyXlsx() {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Lender", "Yield"], ["LAZY XLSX OK", "9.1%"]]), "Rates");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}


const EMAIL = "reviewer@example.com";
const ORG = "o1";
const at = () => new Date(Date.now() - 60_000).toISOString();
/** A finished conversation, one [question, reply] per turn, as eve's stream records it. */
function transcript(turns) {
  const m = { at: at() };
  const ev = [{ type: "session.started", data: { runtime: {} }, meta: m }];
  turns.forEach(([q, reply], i) => {
    const seq = i + 1;
    const turnId = `turn_${seq}`;
    ev.push(
      { type: "turn.started", data: { sequence: seq, turnId }, meta: m },
      { type: "message.received", data: { sequence: seq, turnId, message: q, parts: [{ type: "text", text: q }] }, meta: m },
      { type: "step.started", data: { sequence: seq, turnId, stepIndex: 0 }, meta: m },
      { type: "message.completed", data: { sequence: seq, turnId, stepIndex: 0, finishReason: "stop", message: reply }, meta: m },
      { type: "step.completed", data: { sequence: seq, turnId, stepIndex: 0, finishReason: "stop", usage: {} }, meta: m },
      { type: "turn.completed", data: { sequence: seq, turnId }, meta: m },
    );
  });
  ev.push({ type: "session.waiting", data: { wait: "next-user-message", continuationToken: "ct_1" }, meta: m });
  return ev;
}

const { composeAttachmentMessage } = await import(join(ROOT, "lib/chat-attachments.ts"));
const CHART_SPEC = JSON.stringify({ title: "Coverage", blocks: [{ type: "chart", variant: "bar", title: "Disbursements", xLabels: ["Q1", "Q2", "Q3"], series: [{ name: "Disbursed", data: [3, 5, 4] }] }] });
const DASH_MERMAID = JSON.stringify({ title: "Process", blocks: [{ type: "chart", variant: "mermaid", title: "Review flow", mermaid: "flowchart LR\n  Filing --> Review --> Note" }] });
const MERMAID = "```mermaid\nflowchart LR\n  Filing --> Review --> Note\n```";
const DIAGRAM = "css:svg[aria-roledescription]";
const HIGHLIGHTED = "css:[data-streamdown='code-block'] span[style*='--shiki'], pre span[style*='color']";
const STREAMED_REPLY = ["Here is the function you asked for:\n\n", "```python\ndef yield_on(book):\n    return book.interest / book.average\n```\n\n", "STREAM-END"];

/** Chunk hooks: decide per chunk (by its content) to hold it back or fail it. */
const holdBack = (sig, ms) => async (route) => {
  const resp = await route.fetch();
  const body = await resp.text();
  if (body.includes(sig)) await new Promise((r) => setTimeout(r, ms));
  return route.fulfill({ response: resp, body });
};
const failWhile = (state, sig) => async (route) => {
  if (state.block && !sig) return route.abort("internetdisconnected");
  const resp = await route.fetch();
  const body = await resp.text();
  if (state.block && body.includes(sig)) return route.abort("internetdisconnected");
  return route.fulfill({ response: resp, body });
};

/**
 * One scenario per behaviour. `turns` is the cached chat (opened from the sidebar), `steps` drives the page after it
 * is open and returns nothing (it calls `check`), `loads` is what must be downloaded (and nothing else heavy, unless
 * `anyLoads`).
 */
const SCENARIOS = [
  { name: "a plain chat", turns: [["Show me", "Net interest income rose **14%**.\n\n- Disbursements grew 18%.\n\nPLAIN-REPLY-OK"]], expect: "text:PLAIN-REPLY-OK", loads: [] },
  { name: "a code fence", turns: [["Show me", "Here it is:\n\n```python\ndef yield_on(book):\n    return book.interest / book.average\n```\n\nCODE-REPLY"]], expect: HIGHLIGHTED, loads: ["shiki"] },
  { name: "a mermaid diagram", turns: [["Show me", MERMAID]], expect: DIAGRAM, loads: ["mermaid"] },
  {
    name: "fences nested in a list and a blockquote",
    turns: [["Show me", "Steps:\n\n1. First step\n\n    ```mermaid\n    flowchart LR\n      A --> B\n    ```\n\n2. Second\n\n> ```python\n> def f(x):\n>     return x\n> ```\n\nNESTED-END"]],
    expect: DIAGRAM,
    also: [HIGHLIGHTED],
    loads: ["mermaid", "shiki"],
  },
  {
    name: "math",
    turns: [["Show me", "The spread is $$\\frac{a}{b} + c$$ over the book."]],
    expect: "css:.katex",
    loads: ["katex"],
    // katex's stylesheet arrived too: it hides the MathML copy, which otherwise prints every formula twice.
    verify: ["katex's stylesheet is applied", () => getComputedStyle(document.querySelector(".katex-mathml")).position === "absolute"],
  },
  {
    name: "CJK emphasis",
    turns: [["Show me", "決算は**「増益」**でした。CJK-END"]],
    expect: "text:CJK-END",
    loads: ["remark-cjk-friendly"],
    // Without remark-cjk-friendly, CommonMark leaves `**「増益」**でした` as literal asterisks.
    verify: ["the emphasis is parsed", () => [...document.querySelectorAll("strong, [data-streamdown='strong']")].some((e) => e.textContent.includes("「増益」"))],
  },
  {
    name: "a diagram already drawn survives math arriving late",
    turns: [["Draw it", `${MERMAID}\n\nDIAG-END`], ["And the spread?", "The spread is $$\\frac{a}{b}$$ here. MATH-END"]],
    expect: DIAGRAM,
    chunks: () => holdBack("KaTeX parse error", 5000),
    loads: ["mermaid", "katex"],
    steps: async ({ page, locate }) => {
      const node = await page.evaluateHandle(() => document.querySelector("svg[aria-roledescription]"));
      await locate("css:.katex").waitFor({ timeout: 25_000 });
      await page.waitForTimeout(1500);
      check("…the same diagram node is still attached after katex lands", await node.evaluate((n) => n.isConnected));
    },
  },
  {
    name: "the highlighter fails to load: the code stays readable",
    turns: [["Show me", "```python\nprint(1)\n```\n\nCODEFAIL-END"]],
    expect: "text:CODEFAIL-END",
    anyLoads: true,
    chunks: (state) => ((state.block = true), failWhile(state, HEAVY.shiki[0])),
    steps: async ({ page }) => {
      await page.waitForTimeout(3000);
      check("…the code is on screen as plain text", await page.evaluate(() => document.body.innerText.includes("print(1)")));
      check("…the chat keeps working", (await page.locator("textarea").count()) > 0);
    },
  },
  { name: "a chart", turns: [["Show me", CHART_SPEC]], expect: "css:.recharts-wrapper svg", loads: ["recharts"] },
  { name: "a mermaid chart in a dashboard", turns: [["Show me", DASH_MERMAID]], expect: DIAGRAM, loads: ["mermaid", "recharts"] },
  {
    name: "an attached PDF",
    turns: [[composeAttachmentMessage("Read this filing", [{ name: "filing.pdf", path: `${FOLDER.accounts}/acme/filing.pdf` }]), "Read it."]],
    click: "css:[data-testid=attachment-preview-chip]",
    expect: "css:canvas",
    loads: ["pdf.js"],
  },
  { name: "an agent-published workbook", turns: [["Show me", "The model: [rate model](/files/rate-model.xlsx)"]], click: "text:rate model", expect: "text:LAZY XLSX OK", loads: ["SheetJS"] },
  {
    name: "a reply that gains a fence while it streams",
    turns: [["Earlier", "An earlier answer. EARLIER-END"]],
    expect: "text:EARLIER-END",
    loads: ["shiki"],
    steps: async ({ page, locate }) => {
      await page.locator("textarea").first().fill("Write the function");
      await page.keyboard.press("Enter");
      await locate("text:Here is the function you asked for").waitFor();
      await locate("text:STREAM-END").waitFor({ timeout: 20_000 });
      await locate(HIGHLIGHTED).waitFor({ timeout: 20_000 }).then(
        () => check("…the fence that arrived mid-stream is highlighted", true),
        () => check("…the fence that arrived mid-stream is highlighted", false, "no highlighted span"),
      );
    },
  },
  {
    name: "the control panel (its placeholder holds its place)",
    turns: [["Show me", "Plain. CP-END"]],
    expect: "text:CP-END",
    chunks: () => holdBack(LAZY_APP["the control panel"][0], 3000),
    loads: [],
    anyLoads: true,
    steps: async ({ page, locate }) => {
      const box = () => page.locator("textarea").first().boundingBox();
      await locate("css:[data-testid=cockpit-loading]").waitFor({ timeout: 5000 }).then(
        () => check("…a placeholder fills the rail while it loads", true),
        () => check("…a placeholder fills the rail while it loads", false, "no placeholder"),
      );
      const before = await box();
      await locate("text:Live context appears here").waitFor({ timeout: 20_000 });
      const after = await box();
      check("…the composer does not move when it lands", before && after && before.x === after.x && before.width === after.width, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    },
  },
  {
    name: "the Ops Center opens",
    turns: [["Show me", "Plain. OPS-END"]],
    expect: "text:OPS-END",
    anyLoads: true,
    steps: async ({ page, locate }) => {
      await page.getByRole("button", { name: "Workflows" }).first().click();
      await locate("text:Specialist subagents the orchestrator delegates to").waitFor().then(
        () => check("…its workflows panel renders", true),
        () => check("…its workflows panel renders", false),
      );
    },
  },
  {
    name: "the data room fails to load, then loads on Retry",
    turns: [["Show me", "Plain. DR-END"]],
    expect: "text:DR-END",
    anyLoads: true,
    chunks: (state) => failWhile(state, null),
    steps: async ({ page, locate, state }) => {
      state.block = true;
      await page.getByRole("button", { name: "Dataroom" }).first().click();
      await chunkFailedThenRetry({ page, locate, state, what: "the data room", expect: "text:Master.xlsx" });
    },
  },
  {
    name: "the Ops Center fails to load, then loads on Retry",
    turns: [["Show me", "Plain. OPSF-END"]],
    expect: "text:OPSF-END",
    anyLoads: true,
    chunks: (state) => failWhile(state, null),
    steps: async ({ page, locate, state }) => {
      state.block = true;
      await page.getByRole("button", { name: "Workflows" }).first().click();
      await chunkFailedThenRetry({ page, locate, state, what: "the Ops Center", expect: "text:Specialist subagents the orchestrator delegates to" });
    },
  },
  {
    name: "a chart fails to load, then loads on Retry",
    turns: [["Show me", CHART_SPEC]],
    expect: "css:[data-testid=lazy-load-failed]",
    anyLoads: true,
    chunks: (state) => ((state.block = true), failWhile(state, "recharts-wrapper")),
    steps: ({ page, locate, state }) => chunkFailedThenRetry({ page, locate, state, what: "the chart", expect: "css:.recharts-wrapper svg" }),
  },
  {
    name: "the control panel fails to load, then loads on Retry",
    turns: [["Show me", "Plain. CPF-END"]],
    expect: "text:CPF-END",
    anyLoads: true,
    chunks: (state) => ((state.block = true), failWhile(state, LAZY_APP["the control panel"][0])),
    steps: ({ page, locate, state }) => chunkFailedThenRetry({ page, locate, state, what: "the control panel", expect: "text:Live context appears here" }),
  },
];

/** A chunk is failing: a card with Retry, the chat still there; network back + Retry: the thing renders. */
async function chunkFailedThenRetry({ page, locate, state, what, expect }) {
  const card = locate("css:[data-testid=lazy-load-failed]");
  await card.waitFor({ timeout: 10_000 }).then(
    () => check(`…${what}: a "couldn't load" card with Retry`, true),
    () => check(`…${what}: a "couldn't load" card with Retry`, false, "no card"),
  );
  check(`…${what}: the chat keeps working (the composer is still there)`, (await page.locator("textarea").count()) > 0);
  check(`…${what}: not the app's error screen`, !/This page couldn.t load|This page hit an error/.test(await page.evaluate(() => document.body.innerText)));
  state.block = false;
  if (await card.count()) await card.getByRole("button", { name: /retry/i }).click().catch(() => {});
  await locate(expect).waitFor({ timeout: 10_000 }).then(
    () => check(`…${what}: Retry loads it once the network is back`, true),
    () => check(`…${what}: Retry loads it once the network is back`, false, "still not rendered"),
  );
}

/** The agent's stream for a message sent in the "streams" scenario: text first, then a fence, a second apart. */
function streamingEvents() {
  const m = () => ({ at: new Date().toISOString() });
  const d = (type, data) => ({ type, data: { sequence: 2, turnId: "turn_2", ...data }, meta: m() });
  let soFar = "";
  const appended = STREAMED_REPLY.map((delta) => { soFar += delta; return d("message.appended", { stepIndex: 0, messageDelta: delta, messageSoFar: soFar }); });
  return [
    [0, d("turn.started", {})],
    [0, d("message.received", { message: "Write the function", parts: [{ type: "text", text: "Write the function" }] })],
    [0, d("step.started", { stepIndex: 0 })],
    [300, appended[0]],
    [1500, appended[1]],
    [800, appended[2]],
    [300, d("message.completed", { stepIndex: 0, finishReason: "stop", message: soFar })],
    [0, d("step.completed", { stepIndex: 0, finishReason: "stop", usage: {} })],
    [0, d("turn.completed", {})],
    [0, { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "ct_2" }, meta: m() }],
  ];
}

async function render() {
  let chromium;
  try { ({ chromium } = require("@playwright/test")); } catch { throw new Error("@playwright/test is not installed (npm ci)"); }
  const port = await freePort();
  const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, detached: true });
  // Its own process group: `next start` runs the server as a child, and killing only the parent can leave it behind.
  const stop = (sig) => { try { process.kill(-server.pid, sig); } catch { /* already gone */ } };
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  // A front door: the agent's stream for a new message is written a piece at a time (Playwright's route can only
  // answer whole), everything else goes to `next start`.
  const front = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(u.pathname)) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let t = 0;
      for (const [delay, ev] of streamingEvents()) { t += delay; setTimeout(() => res.write(`${JSON.stringify(ev)}\n`), t); }
      setTimeout(() => res.end(), t + 50);
      return;
    }
    const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { try { res.writeHead(502).end(); } catch { /* closed */ } });
    req.pipe(up);
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  const frontPort = front.address().port;
  const base = `http://127.0.0.1:${frontPort}`;
  let browser;
  try {
    await waitForNextStart({ server, port, log: () => log });
    try { browser = await chromium.launch(); } catch (e) {
      throw new Error(`Chromium is not installed for Playwright; run \`npx playwright install chromium\`. ${String(e.message ?? e).split("\n")[0]}`);
    }
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none" })}.${b64({ email: EMAIL, name: "Reviewer", kind: "email-session", exp: Math.floor(Date.now() / 1000) + 7200 })}.x`;
    const pdf = tinyPdf();
    const xlsx = tinyXlsx();

    const run = async (sc) => {
      const title = `Lazy check: ${sc.name}`;
      const chat = { id: "chat-1", clientKey: "new-lazy-1", title, preview: sc.name, messageCount: sc.turns.length * 2, customers: [], session: { sessionId: "sess_1", continuationToken: "ct_1", streamIndex: 2 + sc.turns.length * 6 }, events: transcript(sc.turns), updatedAt: Date.now() };
      const mocks = {
        // The ops API as the rendered-text pass answers it (every list a page reads, in its real shape) …
        ...MOCKS(),
        // … and this person's one chat.
        "/api/ops/chat-sessions": { items: [{ id: chat.id, clientKey: chat.clientKey, title, preview: chat.preview, messageCount: chat.messageCount, eveSessionId: "sess_1", continuationToken: "ct_1", updatedAt: chat.updatedAt }] },
        "/api/ops/artifact-link": { url: "/files/rate-model.xlsx", proxyUrl: "/api/artifact-proxy?f=rate-model.xlsx" },
      };
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(({ token: t, key, value }) => {
        localStorage.setItem("workspace-google-token", t);
        localStorage.setItem("workspace-active-org", "o1");
        if (!sessionStorage.getItem("seeded")) { localStorage.setItem(key, value); sessionStorage.setItem("seeded", "1"); }
      }, { token, key: `workspace-chats:${EMAIL}:${ORG}`, value: JSON.stringify([chat]) });
      await ctx.route(/\/(api|eve)\//, async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.pathname === "/api/dataroom" && u.searchParams.get("as") === "bytes") return route.fulfill({ status: 200, contentType: "application/pdf", body: pdf });
        if (u.pathname === "/api/artifact-proxy") return route.fulfill({ status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: xlsx });
        if (/^\/eve\/v1\/session\/[^/]+\/stream$/.test(u.pathname)) return route.continue(); // the front door streams it
        if (req.method() === "POST" && /^\/eve\/v1\/session(\/[^/]+)?$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionId: "sess_1", continuationToken: "ct_1" }) });
        if (u.pathname.startsWith("/eve/")) return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "" });
        if (u.pathname === "/api/ops/chat-snapshots" || u.pathname === "/api/ops/chat-replay") return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
        const body = mocks[u.pathname] ?? { items: [], ok: true };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
      });
      const state = { block: false };
      const hook = sc.chunks?.(state);
      if (hook) await ctx.route(/\/_next\/static\/chunks\/.*\.js/, hook);
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      const loaded = new Set();
      const pending = [];
      page.on("response", (r) => {
        if (r.request().resourceType() !== "script" && !r.url().endsWith(".js")) return;
        pending.push(r.text().then((t) => heavyIn(t).forEach((l) => loaded.add(l))).catch(() => {}));
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e?.message ?? e).split("\n")[0]));
      const locate = (m) => (m.startsWith("css:") ? page.locator(m.slice(4)) : page.getByText(m.slice(5), { exact: false })).filter({ visible: true }).first();
      try {
        await page.goto(base + "/", { waitUntil: "load" });
        await page.locator("textarea").first().waitFor();
        await page.getByText(title).first().click();
        await locate("text:" + sc.turns[0][0].split("\n")[0].slice(0, 16)).waitFor().catch(() => {});
        if (sc.click) await locate(sc.click).click();
        await locate(sc.expect).waitFor();
        for (const more of sc.also ?? []) await locate(more).waitFor();
        check(`${sc.name}: renders`, true);
        // A plugin arrives after the text it formats: give it time rather than read the first paint.
        if (sc.verify) check(`${sc.name}: ${sc.verify[0]}`, await page.waitForFunction(sc.verify[1], null, { timeout: 15_000 }).then(() => true, () => false));
        if (sc.steps) await sc.steps({ page, locate, state, ctx });
        // What this scenario must download is waited FOR (it arrives when the browser gets to it, which on a busy
        // runner can be later than any fixed pause); a miss is reported by the checks below. What it must NOT
        // download can only be watched for, so that window stays, and opens after the expected ones are in.
        await until("its libraries to be downloaded", () => (sc.loads ?? []).every((l) => loaded.has(l)), { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500); // anything a render would still fetch
        await Promise.all(pending);
        for (const lib of sc.loads ?? []) check(`${sc.name}: loads ${lib} on use`, loaded.has(lib));
        if (!sc.anyLoads) {
          const unexpected = [...loaded].filter((l) => !(sc.loads ?? []).includes(l));
          check(`${sc.name}: downloads no other heavy library`, unexpected.length === 0, `downloaded ${unexpected.join(", ")}`);
        }
        check(`${sc.name}: no page error`, errors.length === 0, errors.join(" | "));
      } catch (e) {
        if (process.env.LAZY_SHOTS) await page.screenshot({ path: join(process.env.LAZY_SHOTS, `${sc.name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
        check(`${sc.name}: renders`, false, `${String(e.message ?? e).split("\n")[0]}${errors.length ? ` (page errors: ${errors.join(" | ")})` : ""}`);
      } finally {
        await ctx.close();
      }
    };
    const only = argAfter("--only");
    for (const sc of SCENARIOS) if (!only || sc.name.includes(only)) await run(sc);

    // The data room is its own chunk now (a lazy panel in chat-shell): it still opens on its workbook preview.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { localStorage.setItem("workspace-google-token", t); localStorage.setItem("workspace-active-org", "o1"); }, token);
    await ctx.route(/\/(api|eve)\//, (route) => {
      const u = new URL(route.request().url());
      const body = MOCKS()[u.pathname] ?? { items: [], ok: true };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/?dataroom=customers`, { waitUntil: "load" });
      await page.getByText("Master.xlsx").filter({ visible: true }).first().waitFor({ timeout: 20_000 });
      await page.getByText("Acme Housing").filter({ visible: true }).first().waitFor({ timeout: 20_000 });
      check("the data room opens on its Master.xlsx preview", true);
    } catch (e) {
      if (process.env.LAZY_SHOTS) await page.screenshot({ path: join(process.env.LAZY_SHOTS, "dataroom.png") }).catch(() => {});
      check("the data room opens on its Master.xlsx preview", false, String(e.message ?? e).split("\n")[0]);
    } finally {
      await ctx.close();
    }
  } finally {
    await browser?.close();
    front.close();
    stop("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    stop("SIGKILL");
  }
}

if (!NO_RENDER) {
  try {
    await render();
  } catch (e) {
    failures.push(`rendered pass could not run: ${e.message}`);
  }
}

console.log(`check:lazy-features: ${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nA heavy library or panel belongs behind a lazy panel (components/lazy-panel.tsx) or `import()` at the place it is used; see components/ai-elements/streamdown-plugins.ts.");
  process.exit(1);
}
