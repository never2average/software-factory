/**
 * TIME TO CONTINUATION — after a delegated specialist's question is answered, how long until the orchestrator's
 * follow-on is on screen? A rig check, in a real browser, against the real agent under `eve dev`.
 *
 * The defect (onfinance_hfc, 2026-09-28): the answer went through, the specialist worked, the parent got its
 * `subagent-result` and carried on — and the chat showed none of it until a reattach 80 s, once 279 s, later. The
 * parent's stream is silent while the child works; the reader took each quiet seam for a failure and gave up.
 * scripts/test-subagent-handback.mjs holds the mechanism offline; this measures the whole thing on screen.
 *
 * What it does: sends a message, waits for the specialist's question, answers it (by clicking the option, or by
 * typing it — RIG_ANSWER=click|type|both), then samples the page until the orchestrator's continuation is visible.
 * The moment the specialist's result reached the orchestrator is read from the fake model (`GET /__log`: the first
 * root completion after the answer), so the number is the hand-back latency alone, not the specialist's work.
 * It passes when that latency is under RIG_MAX_MS (default 5000), the reader never filed `attach-failed` while the
 * specialist worked, and the status line named the specialist rather than reading as a stall.
 *
 * Every stream response is severed on a SEAM (default 4 s) by a small proxy this script puts in front of the app —
 * the ~120 s severance production applies to every segment, compressed — so a specialist that works for longer than
 * a few seams exercises exactly the silence the defect lived in.
 *
 * SETUP (what the PR was measured with):
 *   node scripts/fake-model-server.mjs --port 8797 --script delegate-parks --subagent research --child-work-ms 30000 &
 *   MODEL_PROVIDER=cloudflare CLOUDFLARE_BASE_URL=http://127.0.0.1:8797/v1 CLOUDFLARE_ACCOUNT_ID=t CLOUDFLARE_API_TOKEN=t \
 *   CLOUDFLARE_MODEL_ORCHESTRATOR=@cf/t/o CLOUDFLARE_MODEL_SPECIALIST=@cf/t/s CLOUDFLARE_MODEL_VISION=@cf/t/v \
 *   DATABASE_URL=… AUTH_JWT_PUBLIC_KEY=… npm run dev:eve -- --no-ui --port 2110 &
 *   NEXT_PUBLIC_EVE_API_URL=http://127.0.0.1:2110 npm run build && npx next start --port 3010 &
 *   (in front of both: anything that serves the app and routes /eve/v1/* to the agent — the rig used a proxy that
 *    sends a NON-loopback Host to eve, so the agent's own session guard (#66) decides with the real token.)
 *
 * RUN:
 *   RIG_BASE=http://127.0.0.1:3110 RIG_FAKE_MODEL=http://127.0.0.1:8797 [RIG_TOKEN=<session token>] \
 *     node scripts/rig-subagent-handback.mjs
 *
 * Without RIG_BASE it says SKIPPED and exits 0.
 */
import http from "node:http";
import { chromium } from "playwright";

const BASE = process.env.RIG_BASE;
const FAKE = process.env.RIG_FAKE_MODEL;
if (!BASE || !FAKE) {
  console.log("rig-subagent-handback: SKIPPED — needs RIG_BASE (the app, /eve/v1 routed to eve dev) and RIG_FAKE_MODEL. See the header.");
  process.exit(0);
}
const MAX_MS = Number(process.env.RIG_MAX_MS ?? 5_000);
const SEAM_MS = Number(process.env.RIG_SEAM_MS ?? 4_000);
const MODES = process.env.RIG_ANSWER === "both" ? ["click", "type"] : [process.env.RIG_ANSWER ?? "click"];
const QUESTION = process.env.RIG_QUESTION ?? "Which fiscal year";
const OPTION = process.env.RIG_OPTION ?? "FY26";
const CONTINUATION = process.env.RIG_CONTINUATION ?? "PARENT-DONE";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN =
  process.env.RIG_TOKEN ??
  `${b64({ alg: "none" })}.${b64({ email: "tester@example.com", name: "Tester", exp: Math.floor(Date.now() / 1000) + 3600, iss: "https://accounts.google.com" })}.sig`;

/* ─── the seam: every stream segment ends cleanly after SEAM_MS, as production's ~120 s does ─────────────────── */
const upstream = new URL(BASE);
const seam = http.createServer((req, res) => {
  const headers = { ...req.headers, host: upstream.host };
  const isStream = req.method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream/.test(req.url ?? "") && SEAM_MS > 0;
  let closed = false;
  let up;
  // The clock starts at the REQUEST, not at the response: eve holds a stream's headers until its first event, so a
  // silent stream — the specialist working — would otherwise never be cut. An empty 200 that ends is exactly what a
  // silent segment looks like when the platform ends it.
  const cut = isStream
    ? setTimeout(() => {
        closed = true;
        if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        res.end();
        up?.destroy();
      }, SEAM_MS)
    : undefined;
  up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (r) => {
    if (closed) return;
    res.writeHead(r.statusCode ?? 502, r.headers);
    if (isStream) {
      let buf = "";
      r.on("data", (c) => {
        if (closed) return;
        buf += c;
        const i = buf.lastIndexOf("\n");
        if (i >= 0) {
          res.write(buf.slice(0, i + 1));
          buf = buf.slice(i + 1);
        }
      });
      r.on("end", () => {
        clearTimeout(cut);
        if (!closed) res.end(buf);
      });
      return;
    }
    r.pipe(res);
  });
  up.on("error", () => {
    clearTimeout(cut);
    if (closed) return;
    try {
      res.writeHead(502).end();
    } catch {
      res.end();
    }
  });
  req.pipe(up);
  res.on("close", () => {
    clearTimeout(cut);
    up.destroy();
  });
});
await new Promise((resolve) => seam.listen(0, "127.0.0.1", resolve));
const SEAMED = `http://127.0.0.1:${seam.address().port}`;

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `  — got ${JSON.stringify(detail)}`}`);
  }
};

const browser = await chromium.launch();
try {
  for (const mode of MODES) {
    console.log(`\nanswer by ${mode}:`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript((t) => {
      if (!localStorage.getItem("workspace-google-token")) localStorage.setItem("workspace-google-token", t);
    }, TOKEN);
    const page = await ctx.newPage();
    const telemetry = [];
    let opens = 0;
    page.on("request", (r) => {
      if (r.url().includes("chat-telemetry")) telemetry.push({ at: Date.now(), body: r.postData() ?? "" });
      if (/\/eve\/v1\/session\/[^/]+\/stream/.test(r.url())) opens++;
      if (process.env.RIG_DEBUG && (r.url().includes("chat-telemetry") || r.url().includes("/eve/v1/"))) {
        console.log(`    ${new Date().toISOString().slice(11, 23)} ${r.method()} ${r.url().replace(SEAMED, "").slice(0, 90)} ${(r.postData() ?? "").slice(0, 140)}`);
      }
    });
    await page.goto(`${SEAMED}/`);
    const box = page.locator("textarea").first();
    await box.waitFor({ state: "visible", timeout: 180_000 });
    await box.fill(`Please delegate the specialist work (${mode}, ${Date.now()}).`);
    await box.press("Enter");
    await page.getByText(QUESTION, { exact: false }).first().waitFor({ state: "visible", timeout: 180_000 });
    await page.waitForTimeout(1_000);
    if (mode === "click") await page.getByRole("button", { name: new RegExp(OPTION) }).first().click();
    else {
      await box.fill(OPTION);
      await box.press("Enter");
    }
    const answeredAt = Date.now();
    let visibleAt = 0;
    let namedWhileWorking = false;
    for (let i = 0; i < 1_200 && !visibleAt; i++) {
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes(CONTINUATION)) visibleAt = Date.now();
      if (/specialist is working — the main thread continues/.test(text)) namedWhileWorking = true;
      if (!visibleAt) await page.waitForTimeout(250);
    }
    const log = await (await fetch(`${FAKE}/__log`)).json();
    const handedBack = log.find((d) => !d.child && d.at > answeredAt && d.decision?.text);
    const latency = visibleAt && handedBack ? visibleAt - handedBack.at : Number.POSITIVE_INFINITY;
    const failed = telemetry.filter((t) => t.at > answeredAt && t.at < (visibleAt || Date.now()) && t.body.includes('"attach-failed"'));
    console.log(
      `  specialist worked ${handedBack ? ((handedBack.at - answeredAt) / 1000).toFixed(1) : "?"} s · continuation on screen ${
        Number.isFinite(latency) ? (latency / 1000).toFixed(1) : "never"
      } s after it reached the orchestrator · ${opens} stream opens`,
    );
    check("the specialist's result reached the orchestrator (server side)", Boolean(handedBack));
    check(`the orchestrator's continuation is on screen within ${MAX_MS} ms of that`, latency < MAX_MS, latency);
    check("the reader never gave up while the specialist worked (no attach-failed)", failed.length === 0, failed.map((f) => f.body.slice(0, 160)));
    if (handedBack && handedBack.at - answeredAt > 3 * SEAM_MS) {
      check("while it worked, the status line named the specialist", namedWhileWorking);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  seam.close();
}
if (failures) {
  console.error(`\nrig-subagent-handback: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nrig-subagent-handback: passed");
