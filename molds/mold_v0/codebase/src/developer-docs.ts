/**
 * The customer guide's Developers pages of an embedded app (mold_v0-193): written by scripts/gen-packs.mjs from the
 * build's developer surface (pack.json `developer_surface`), its record areas and job kinds, into the packs' guide
 * (web/src/config/pack-guides.generated.ts PACK_GUIDE pages, group "Developers"), so /app/docs and the docs answers'
 * corpus carry them. Markdown only, under the guide's rules (src/pack-guide.ts pageProblems): links are paths of this
 * site; anything with angle brackets is code.
 *
 * No imports: scripts/gen-packs.mjs loads this file directly (node's type stripping).
 */

export const DEVELOPER_GROUP = "Developers";

interface Cfg {
  events: { name: string; description: string; areas?: string[] }[];
  sdk_languages: string[];
  client_sessions: { ttl_seconds: number; allowed_origins: string[]; scopes?: string[] };
  webhooks_in?: { name: string; description?: string; area: string; items?: string; key: string; title?: string; fields: Record<string, string>; types?: string[] }[];
  api_version?: string;
}
interface Area { name: string; label?: string; scope: string; fields: { name: string; type?: string; required?: boolean }[]; lifecycle?: { field: string; initial: string } | null }
interface Kind { name: string; label?: string }

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

/** The pages, in reading order. `version` is the API version a key made today is pinned to. */
export function developerGuidePages(cfg: Cfg, areas: Area[], kinds: Kind[], version: string): { title: string; slug: string; group: string; body: string }[] {
  const ws = areas.filter((a) => a.scope === "workspace");
  const first = ws[0] ?? areas[0];
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const page = (title: string, body: string) => ({ title, slug: slug(title), group: DEVELOPER_GROUP, body });
  const out = [];

  out.push(page("API overview", [
    "Your own servers reach your workspace's data through a REST API under `/v1`, described as an OpenAPI 3.1 document at [/openapi.json](/openapi.json). The typed SDKs are generated from that document.",
    "## Keys",
    "Your workspace's owners make API keys (signed in to the console: `/api/developer/keys`). A key is shown **once**: only its first characters (its prefix, like `sk_ab12cd`) are kept to tell keys apart. Each key holds **scopes**:",
    [
      "- `read`: list and read records and runs",
      "- `write`: create, change, move and delete records",
      "- `run`: start and cancel runs",
      "- `sessions`: mint client sessions for your signed-in users and manage the browser origins they may call from",
      "- `webhooks`: manage webhook endpoints and inbound sources",
      "- `checks`: ask the app's yes/no questions (`POST /v1/checks/<name>`)",
    ].join("\n"),
    "`read`, `write`, `run` and `checks` may be narrowed to one area, kind or question, like `read:<area>`, `run:<kind>` or `checks:<name>`. An **integration key** holds exactly one scope: give one to each importer or tool so it can do that one thing. A key may expire; **rotate** it to get a new one while the old one keeps working for a grace period (a day unless you choose otherwise).",
    "Send the key in a header from your server, never from a browser or a phone app:",
    fence("http", "Authorization: Bearer sk_..."),
    "## Acting for your signed-in user",
    "When your backend calls on behalf of one of its own signed-in users, name them with `X-Actor`: the call is recorded as theirs (in the platform audit trail and in the events your webhooks receive).",
    "## Narrowing a request",
    "`X-Scope` (a space-separated list) narrows one request to fewer scopes than the key holds: a scope the key does not hold is refused.",
    "## Versions",
    `The API is versioned by date. A key is pinned to the version current when it was made (today ${code(version)}); \`API-Version\` on a request overrides it, and every answer says which version served it.`,
    "## Writes are idempotent",
    "Send `Idempotency-Key` (any unique string, up to 255 characters) with a write: the same key with the same request returns the first answer again (with `Idempotent-Replayed: true`), for 24 hours. The same key with another request is refused. The SDKs send one with every write.",
    "## Errors",
    "Every error is `application/problem+json`: `type`, `title`, `status`, `detail`, a stable `code` (like `not_found`, `forbidden`, `invalid_request`, `rate_limited`, `idempotency_key_reused`) and the `request_id` to quote to support.",
    "## Pages",
    "Lists answer `{data, next}`: pass `next` back as `after` for the next page, until it is null. `limit` is 1 to 200.",
    "## Rate limits",
    "Each key, and each workspace, has a number of requests a minute. Over it the answer is 429 with `Retry-After`.",
  ].join("\n\n")));

  const areaLines = areas.map((a) => `- ${code(a.name)}${a.label ? ` (${a.label})` : ""}: ${a.scope === "workspace" ? "your workspace's own records" : "shared records, read only"}${a.lifecycle ? `; moves along its lifecycle (${code(a.lifecycle.field)}, starting at ${code(a.lifecycle.initial)})` : ""}`).join("\n");
  out.push(page("Records and runs API", [
    "Each record area has its own address under `/v1/records/<area>`: list (with `filter`, `sort`, `limit`, `after`), create, read, replace, move (when the area has a lifecycle) and delete. `/v1/batch` applies several writes as one transaction: all of them, or none.",
    areaLines || "This app declares no record area.",
    kinds.length ? `Runs: \`POST /v1/runs\` with a \`kind\` (${kinds.map((k) => code(k.name)).join(", ")}), then \`GET /v1/runs/<id>\`, its results, or cancel it. A webhook's \`run.finished\` tells you when it ends.` : "",
    first ? fence("bash", `curl -s "$API/v1/records/${first.name}?limit=10" \\\n  -H "Authorization: Bearer $KEY"`) : "",
  ].filter(Boolean).join("\n\n")));

  const ttl = cfg.client_sessions.ttl_seconds;
  out.push(page("Client sessions", [
    "A browser or a phone app never holds a key. Your backend mints a **client session** for one of its signed-in users with a key that holds `sessions`, and hands the token to the client:",
    fence("bash", `curl -s -X POST "$API/v1/client_sessions" \\\n  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\\n  -d '{"subject": "user-123", "scopes": ["read"], "ttl_seconds": 900}'`),
    `It answers \`{id, token, expires_at, scopes}\`. The token (\`cs_...\`) lives at most ${ttl} seconds and holds at most ${(cfg.client_sessions.scopes ?? ["read", "write"]).map(code).join(", ")} (never more than the key that minted it). Revoke one early with \`DELETE /v1/client_sessions/<id>\`.`,
    (cfg.client_sessions.scopes ?? []).some((x) => x === "checks" || x.startsWith("checks:"))
      ? "A session holding `checks` (or `checks:<name>`, one question) asks the app's yes/no questions from the page itself (`POST /v1/checks/<name>`), never more than the key that minted it holds."
      : "",
    "A page calls the API from the origins allowed for your workspace: these for every workspace, and those your owners add (`/v1/allowed_origins`). A request from any other origin, or a key sent from a browser, is refused.",
    cfg.client_sessions.allowed_origins.map((o) => `- ${o}`).join("\n"),
  ].filter(Boolean).join("\n\n")));

  const ev = cfg.events.map((e) => `- ${code(e.name)}: ${e.description}${e.areas?.length ? ` (areas ${e.areas.map(code).join(", ")})` : ""}`).join("\n");
  out.push(page("Webhooks", [
    "Add an endpoint (`POST /v1/webhook_endpoints` with its `url` and the `events` it takes, or all of them) and your server receives each event as a signed POST, following the Standard Webhooks specification. The answer holds the endpoint's signing secret (`whsec_...`) once; reading it again is recorded, and you can rotate it (the old secret keeps signing beside the new one for a day).",
    "## Events",
    ev,
    "`webhook.test` is sent when you ask for a test ping (`POST /v1/webhook_endpoints/<id>/test`).",
    "## Verifying",
    "Each request carries `webhook-id`, `webhook-timestamp` and `webhook-signature`. Verify it with a Standard Webhooks library before trusting it:",
    fence("ts", "import { Webhook } from 'standardwebhooks';\nconst event = new Webhook(secret).verify(rawBody, headers);"),
    "## Retries",
    "Answer with a 2xx within 15 seconds. Anything else is retried with backoff (after 5 seconds, 5 minutes, 30 minutes, 2, 5, 10 and 10 hours). Every attempt is in the endpoint's delivery log (`GET /v1/webhook_endpoints/<id>/deliveries`), and a delivery can be sent again. An endpoint that keeps failing is disabled; enable it again when it is fixed.",
  ].join("\n\n")));

  if (cfg.webhooks_in?.length) {
    out.push(page("Webhooks in", [
      "Other systems can send events into your workspace. Add a source for one of the receivers below (`POST /v1/inbound_sources` with its `receiver`): it answers the address to give the sender and its signing secret. Each payload must be signed as Standard Webhooks signs it; a verified one is written into the receiver's area (the same `webhook-id` twice is written once).",
      cfg.webhooks_in.map((r) => `- ${code(r.name)}${r.description ? `: ${r.description}` : ""}. Writes ${code(r.area)} records${r.items ? `, one per item of ${code(r.items)}` : ""}, keyed by ${code(r.key)}${r.title ? `, titled by ${code(r.title)}` : ""}; fields ${Object.entries(r.fields).map(([f, p]) => `${code(f)} from ${code(p)}`).join(", ")}.`).join("\n"),
    ].join("\n\n")));
  }

  const langs = cfg.sdk_languages;
  out.push(page("SDKs", [
    `Typed SDKs are generated from the API's description for ${langs.map((l) => (l === "typescript" ? "JavaScript and TypeScript" : "Python")).join(" and ")}. Each sends your key, retries a write safely with its idempotency key, and turns errors into exceptions carrying the problem's \`code\`.`,
    langs.includes("typescript") && first ? fence("ts", `import { Client } from './sdk';\nconst api = new Client({ baseUrl: process.env.API!, token: process.env.KEY! });\nconst page = await api.records.${first.name}.list({ limit: 10 });`) : "",
    langs.includes("python") && first ? fence("python", `from sdk import Client\napi = Client(base_url=API, token=KEY)\npage = api.records.${first.name}.list(limit=10)`) : "",
  ].filter(Boolean).join("\n\n")));
  return out;
}
