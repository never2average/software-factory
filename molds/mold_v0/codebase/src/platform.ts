/**
 * Where a task's user-facing code runs, so results can be split by platform ("Firebase wins mobile tasks, not web
 * ones"). Stored on scenarios and library tasks; derived from the starter template, else the language, else the text.
 * sql/schema.sql backfills existing rows with the same rules (PLATFORM_SQL); keep the two in step.
 */
export const PLATFORMS = ["web", "mobile", "backend", "desktop", "cli", "data", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Starter workspace (orchestrator/workspaces/<template>) -> platform. */
export const TEMPLATE_PLATFORM: Record<string, Platform> = {
  "nextjs-ts": "web", django: "web",
  "react-native": "mobile", flutter: "mobile",
  "express-ts": "backend", fastapi: "backend", "go-http": "backend", "java-spring": "backend", "rust-axum": "backend", "node-ts": "backend",
  "cpp-cmake": "other",
};

const MOBILE = /\b(flutter|react native|react-native|expo|swiftui|jetpack compose|android app|ios app|mobile app|iphone|app store|play store)\b/i;
const DESKTOP = /\b(electron|tauri|desktop app)\b/i;
const WEB = /\b(next\.?js|react|vue|svelte|angular|frontend|front-end|browser|web app|pwa|single-page)\b/i;
const CLI = /\b(cli|command-line|command line tool)\b/i;
const DATA = /\b(notebook|pandas|spark|etl|data pipeline|airflow|dbt)\b/i;
const BACKEND = /\b(express|fastapi|flask|spring boot|rails|laravel|nestjs|koa|gin|axum|actix|rest api|graphql api|microservice|backend service|api service)\b/i;
const SERVER_LANGS = /^(python|go|golang|rust|java|ruby|php|c#|elixir|typescript|javascript|kotlin \(server\))$/i;

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}

/** The platform a task targets: explicit template first, then language, then what the tags and prompt describe. */
export function platformOf(t: { template?: string | null; language?: string | null; tags?: string[] | null; prompt?: string | null }): Platform {
  if (t.template && TEMPLATE_PLATFORM[t.template]) return TEMPLATE_PLATFORM[t.template];
  if (/^(dart|swift|objective-c|kotlin)$/i.test(t.language ?? "")) return "mobile";
  const text = `${(t.tags ?? []).join(" ")} ${t.prompt ?? ""}`;
  if (MOBILE.test(text)) return "mobile";
  if (DESKTOP.test(text)) return "desktop";
  if (WEB.test(text)) return "web";
  if (CLI.test(text)) return "cli";
  if (DATA.test(text)) return "data";
  if (BACKEND.test(text)) return "backend";
  if (SERVER_LANGS.test(t.language ?? "")) return "backend";
  return "other";
}
