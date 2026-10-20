// Vercel entry: the whole server as one function (vercel.json rewrites every path here). Background loops (autoscaler,
// archive) only run under `npm start`; this is for previews of the landing page, /admin, /app and /mcp.
// OpenTelemetry loads first so http, express, pg and fetch are instrumented (it is a no-op without an OTLP endpoint).
import { otelFlush } from "../src/otel.js";
import { createApp } from "../src/http.js";
import { keepAlive } from "../src/telemetry.js";

const app = createApp();
// Export each request's spans before Vercel freezes the function.
export default function handler(req: Parameters<typeof app>[0], res: Parameters<typeof app>[1]) {
  // waitUntil is registered while the request is live; it resolves once the response is sent and the spans exported.
  keepAlive(new Promise((done) => res.on("finish", done)).then(() => otelFlush()));
  return app(req, res);
}
