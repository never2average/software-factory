// Workaround for an eve 0.20 <-> Vercel Build Output incompatibility.
//
// eve emits its dynamic API routes (session/:id, /stream, callbacks) and its
// `/(.*) -> /__server` catch-all AFTER the `{handle:"filesystem"}` marker, and
// the current Vercel platform drops them — only the exact static routes survive,
// so `/eve/v1/session/:id` edge-404s and real conversations break.
//
// `__server.func` is the full eve server (it serves every route). We prepend
// catch-alls to it BEFORE the filesystem phase so all eve traffic reaches the
// server that actually works, exactly like it does locally.
import { readFileSync, writeFileSync } from "node:fs";

const path = ".vercel/output/config.json";
const cfg = JSON.parse(readFileSync(path, "utf8"));
const routes = Array.isArray(cfg.routes) ? cfg.routes : [];

const prepend = [
  { src: "/eve/(.*)", dest: "/__server" },
  { src: "/.well-known/workflow/(.*)", dest: "/__server" },
];

// Avoid double-patching on re-runs.
const already = routes.some(
  (r) => r && r.src === "/eve/(.*)" && r.dest === "/__server",
);
if (!already) {
  cfg.routes = [...prepend, ...routes];
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  console.log("[patch-eve-routes] prepended __server catch-alls before filesystem");
} else {
  console.log("[patch-eve-routes] already patched, skipping");
}
