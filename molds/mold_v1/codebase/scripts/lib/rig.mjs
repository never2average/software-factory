/**
 * Shared pieces of the browser rig checks (scripts/rig-*.mjs): a SEAM proxy that ends every stream segment the way
 * production's ~120 s severance does (compressed), a reader of the server's own stream (the truth the page is checked
 * against), and a signed-in page. Nothing here runs in CI; see each rig script's header for the setup.
 */
import http from "node:http";

/** An unsigned Google-shaped id token the rig's app accepts (a work account: it carries `hd`). */
export function rigToken(email = "tester@example.com") {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ email, name: "Tester", hd: email.split("@")[1], exp: Math.floor(Date.now() / 1000) + 3600, iss: "https://accounts.google.com" })}.sig`;
}

/**
 * A proxy in front of `base` that ends every `GET /eve/v1/session/:id/stream` response cleanly, at a line boundary,
 * `seamMs` after the REQUEST (eve holds a stream's headers until its first event, so a silent stream must still be
 * cut). Every stream request is recorded: `{ at, sessionId, startIndex }`.
 */
export async function seamProxy(base, seamMs) {
  const upstream = new URL(base);
  const streams = [];
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: upstream.host };
    const m = req.method === "GET" ? /^\/eve\/v1\/session\/([^/?]+)\/stream(?:\?(.*))?$/.exec(req.url ?? "") : null;
    if (m) {
      const q = new URLSearchParams(m[2] ?? "");
      streams.push({ at: Date.now(), sessionId: decodeURIComponent(m[1]), startIndex: Number(q.get("startIndex") ?? 0) });
    }
    const isStream = Boolean(m) && seamMs > 0;
    let closed = false;
    let up;
    const cut = isStream
      ? setTimeout(() => {
          closed = true;
          if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
          res.end();
          up?.destroy();
        }, seamMs)
      : undefined;
    up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (r) => {
      if (closed) return;
      res.writeHead(r.statusCode ?? 502, r.headers);
      if (!isStream) return r.pipe(res);
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, streams, close: () => server.close() };
}

/**
 * Read a session's stream from `base` WITHOUT a seam, reconnecting at the cursor until `until(event)` — the server's
 * own record of what happened and when this process received it (`at`), to judge the page against.
 */
export function serverTail(base, sessionId, headers = {}, until = () => false) {
  const events = [];
  const ctrl = new AbortController();
  const done = (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${events.length}`, { headers, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const x = await reader.read();
          if (x.done) break;
          buf += dec.decode(x.value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              event = { type: "unparsed" };
            }
            events.push({ at: Date.now(), event });
            if (until(event)) {
              ctrl.abort();
              return;
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  })();
  return { events, stop: () => ctrl.abort(), done };
}

/** A signed-in page on `url`, recording telemetry posts and the session the first send created. */
export async function openChat(browser, url, token = rigToken()) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((t) => {
    if (!localStorage.getItem("workspace-google-token")) localStorage.setItem("workspace-google-token", t);
  }, token);
  const page = await ctx.newPage();
  const telemetry = [];
  const state = { sessionId: null };
  page.on("request", (r) => {
    if (r.url().includes("chat-telemetry")) telemetry.push({ at: Date.now(), body: r.postData() ?? "" });
  });
  page.on("response", async (r) => {
    if (r.request().method() !== "POST" || !/\/eve\/v1\/session$/.test(new URL(r.url()).pathname)) return;
    try {
      const body = await r.json();
      if (!state.sessionId && typeof body?.sessionId === "string") state.sessionId = body.sessionId;
    } catch {}
  });
  await page.goto(`${url}/`);
  const box = page.locator("textarea").first();
  await box.waitFor({ state: "visible", timeout: 180_000 });
  return { ctx, page, box, telemetry, state };
}

export function checker(name) {
  let failures = 0;
  return {
    check(what, ok, detail) {
      if (ok) console.log(`  ✓ ${what}`);
      else {
        failures++;
        console.error(`  ✗ ${what}${detail === undefined ? "" : `  — got ${JSON.stringify(detail)?.slice(0, 400)}`}`);
      }
    },
    finish() {
      if (failures) {
        console.error(`\n${name}: ${failures} check(s) failed`);
        process.exit(1);
      }
      console.log(`\n${name}: passed`);
    },
  };
}
