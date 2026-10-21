/**
 * test:warm-previews — the preview suite's global setup compiles the sign-in routes without running them
 * (mold_v1-292).
 *
 * tests/warm-previews.ts compiles the hub's status route and the app's availability route before the first spec.
 * The availability route, when it runs, asks the hub for its status and remembers the answer for a minute
 * (lib/google-sign-in-mode.ts). A warm-up that sent it a GET therefore stored an answer: if the status route was still
 * slower than the app's 4 s ask, that answer was "direct", the very thing tests/google-hub.spec.ts then failed on.
 *
 * Here the real global setup runs against a stub server that records every request. Every route the setup names is
 * reached (so it is compiled), and only by OPTIONS: Next answers OPTIONS itself, so no route's own code runs. A GET,
 * HEAD (Next answers HEAD by running GET) or POST to any of them fails this script.
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUTES = ["/api/auth/google-hub/status", "/api/auth/google/availability", "/auth/google-hub", "/api/auth/google-hub/callback"];
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failed++;
};

const seen = [];
const server = createServer((req, res) => {
  seen.push({ method: req.method ?? "", path: new URL(req.url ?? "/", "http://stub").pathname });
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>stub</title>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// A root with one empty preview page, so the setup runs its whole path (pages, routes, the app's page).
const root = mkdtempSync(join(tmpdir(), "warm-previews-"));
try {
  mkdirSync(join(root, "app", "preview", "stub"), { recursive: true });
  writeFileSync(join(root, "app", "preview", "stub", "page.tsx"), "export default function Page() { return null; }\n");
  writeFileSync(join(root, "playwright.config.ts"), "export default {};\n");
  const { default: warmPreviews } = await import("../tests/warm-previews.ts");
  await warmPreviews({ configFile: join(root, "playwright.config.ts"), projects: [{ use: { baseURL } }] });

  check("the preview page was opened", seen.some((r) => r.path === "/preview/stub"));
  for (const at of ROUTES) {
    const methods = seen.filter((r) => r.path === at).map((r) => r.method);
    check(`${at} was compiled (reached at least once)`, methods.length > 0, "never requested");
    check(`${at} was reached only by OPTIONS, so none of its code ran`, methods.length > 0 && methods.every((m) => m === "OPTIONS"), methods.join(", "));
  }
  check("the app's page was opened", seen.some((r) => r.path === "/" && r.method === "GET"));
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`test:warm-previews: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("test:warm-previews: all checks passed");
