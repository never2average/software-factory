/**
 * Ops observability: OpenTelemetry traces and metrics for the server, exported over OTLP to New Relic (or any OTLP
 * backend: change the endpoint and header). Loaded before anything else (`tsx --import ./src/otel.ts src/http.ts`) so
 * http, express, pg and fetch are instrumented; runTool adds a span per MCP tool call (src/server.ts).
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local runs and the smoke test export nothing.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net        (EU accounts: https://otlp.eu01.nr-data.net)
 *   OTEL_EXPORTER_OTLP_HEADERS=api-key=<New Relic ingest license key>
 *   OTEL_SERVICE_NAME=<namespace> (src/namespace.ts)             (default), OTEL_DEPLOYMENT_ENV=production
 * Never put API keys, tokens or tool arguments in span attributes: org slug, tool name, status and timings only.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NS } from "./namespace.js";

/** Export pending spans and metrics now (serverless: before the function is frozen). A no-op when OTel is off. */
export let otelFlush: () => Promise<void> = async () => {};

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true") {
  // Deprecated connector URLs carry a key in the path (/mcp/oct_...) and the gateway carries session tokens: never record those paths.
  const redact = (path: string) => path.replace(/\/mcp\/oct_[^/?]+/, "/mcp/:key").replace(/\/api\/journeys\/nudges\/[^/?]+/, "/api/journeys/nudges/:secret").replace(/\?.*$/, "");
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? NS,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "2.0.0",
      "deployment.environment.name": process.env.OTEL_DEPLOYMENT_ENV ?? process.env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 60_000 })],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === "/healthz",
        // The span name and url attributes come from the request: rewrite the key out of them.
        requestHook: (span, req) => {
          const url = "url" in req && typeof req.url === "string" ? req.url : undefined;
          if (url && /\/mcp\/oct_|\/api\/journeys\/nudges\/./.test(url)) {
            // Every attribute that can carry the path, old and stable semantic conventions alike.
            const host = "headers" in req ? String((req.headers as Record<string, unknown>).host ?? "") : "";
            for (const k of ["url.path", "http.target"]) span.setAttribute(k, redact(url));
            for (const k of ["http.url", "url.full"]) span.setAttribute(k, `${host ? `//${host}` : ""}${redact(url)}`);
          }
        },
        headersToSpanAttributes: { server: { requestHeaders: ["user-agent"] } },
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }), // statement text only, never bound values
      new UndiciInstrumentation(), // fetch: Clerk, Stripe, PostHog, model providers through the gateway
    ],
  });
  sdk.start();
  otelFlush = async () => {
    const { trace, metrics } = await import("@opentelemetry/api");
    const tp = trace.getTracerProvider() as { forceFlush?: () => Promise<void> };
    const mp = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
    await Promise.all([tp.forceFlush?.(), mp.forceFlush?.()]);
  };
  const stop = () => void sdk.shutdown().catch(() => {});
  process.once("SIGTERM", stop);
  process.once("beforeExit", stop);
  console.error(`otel: exporting traces and metrics to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
}
