/**
 * The OpenAPI 3.1 document of an embedded app's developer API (mold_v0-193), generated from the build's pack contract:
 * each record area's own paths and typed schemas (fields, enums, references, lifecycle states; a shared area read only,
 * an area fed by a repository read only, an operation a pack withholds left out), the job kinds and their runs, client
 * sessions, allowed origins, webhook endpoints and deliveries, inbound sources, and the declared events as OpenAPI 3.1
 * `webhooks`. Served at /openapi.json (src/developer-api.ts) and read by the SDK generator (scripts/gen-sdks.ts): every
 * operation carries `x-sdk` {group, method} so the SDKs name it the same in each language.
 * Checks (mold_v0-196) join here when they land: they are record areas of role check today, and listed as such.
 */
import { declaredChecks } from "./checks.js";
import { checkBuckets, inputKind } from "./check-spec.js";
import { API_VERSIONS, EVENT_CATALOG, TEST_EVENT, type EventName } from "./developer-config.js";
import { currentApiVersion, developerSurface } from "./developer-surface.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { NS } from "./namespace.js";
import { optionValues } from "./pack-api.js";
import { PROFILE } from "./profile.js";
import { isReadOnlyArea, recordAreas, type RecordArea } from "./record-areas.js";
import { jobKinds } from "./runs.js";

type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
export const pascal = (s: string) => s.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

/** A field's JSON Schema (as the record store checks it). */
function fieldSchema(f: RecordArea["fields"][number]): Schema {
  const one = (): Schema => {
    switch (f.type) {
      case "number": return { type: "number", ...(f.min !== undefined ? { minimum: f.min } : {}), ...(f.max !== undefined ? { maximum: f.max } : {}) };
      case "boolean": return { type: "boolean" };
      case "date": return { type: "string", format: "date" };
      case "json": return {};
      case "enum": return { type: "string", enum: optionValues(f) };
      case "person": return { type: "string", description: "A person of the workspace, by their sign-in id." };
      case "reference": return { type: "string", description: `The key of a ${f.to} record.`, "x-reference": f.to };
      case "file": return { type: "object", required: ["path"], properties: { path: { type: "string" }, name: { type: "string" }, sha256: { type: "string" }, size: { type: "integer" } } };
      case "link": return { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
      default: return { type: "string", ...(f.max_length ? { maxLength: f.max_length } : {}) };
    }
  };
  const s = f.multiple ? { type: "array", items: one() } : one();
  // mold_v0-194: an encrypted field reads as "[encrypted]" (sent back, or left out, it keeps its value); its value only
  // through POST /v1/records/{area}/{key}/reveal.
  if (f.encrypted) return { anyOf: [s, { type: "string", const: "[encrypted]" }], title: f.label, "x-encrypted": true,
    description: `${f.help ? `${f.help} ` : ""}Encrypted: every read shows "[encrypted]"; reveal returns the value to the roles allowed.` };
  return { ...s, title: f.label, ...(f.help ? { description: f.help } : {}) };
}

const problem = { description: "An error (application/problem+json).", content: { "application/problem+json": { schema: ref("Problem") } } };
const json = (schema: Schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = (schema: Schema, required = true) => ({ required, content: { "application/json": { schema } } });
const P = {
  version: { $ref: "#/components/parameters/ApiVersion" }, idem: { $ref: "#/components/parameters/IdempotencyKey" },
  actor: { $ref: "#/components/parameters/Actor" }, scope: { $ref: "#/components/parameters/Scope" },
  limit: { $ref: "#/components/parameters/Limit" }, after: { $ref: "#/components/parameters/After" },
};
const pathParam = (name: string, description: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });

interface Op { method: string; summary: string; group: string; sdk: string; scope: string; write?: boolean; params?: unknown[]; body?: unknown; ok: unknown; status?: string; security?: unknown[] }
function operation(o: Op) {
  const params = [P.version, ...(o.write ? [P.idem] : []), P.actor, P.scope, ...(o.params ?? [])];
  return {
    operationId: `${o.group.replace(/\./g, "_")}_${o.sdk}`, summary: o.summary, tags: [o.group.split(".")[0]], "x-sdk": { group: o.group, method: o.sdk },
    "x-scope": o.scope, parameters: params, ...(o.body ? { requestBody: o.body } : {}),
    responses: { [o.status ?? "200"]: o.ok, default: problem }, ...(o.security ? { security: o.security } : {}),
  };
}

/** The document, for the API at `serverUrl`. */
export function openApiDocument(serverUrl: string): Schema {
  const cfg = developerSurface();
  if (!cfg) throw new Error("this build has no developer surface");
  const schemas: Record<string, Schema> = {};
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (p: string, method: string, op: unknown) => { (paths[p] ??= {})[method] = op; };

  schemas.Problem = { type: "object", required: ["type", "title", "status", "code"], properties: {
    type: { type: "string", description: "A URI reference naming the problem (/problems/<code>)." }, title: { type: "string" }, status: { type: "integer" },
    detail: { type: "string" }, code: { type: "string", description: "Stable and machine-readable: not_found, forbidden, invalid_request, rate_limited, idempotency_key_reused, ..." },
    request_id: { type: "string" }, retry_after: { type: "integer" } } };
  schemas.Area = { type: "object", properties: { name: { type: "string" }, label: { type: "string" }, scope: { type: "string", enum: ["workspace", "platform"] },
    role: { type: "string", enum: ["source", "check", "asset"] }, fields: { type: "array", items: { type: "object" } }, lifecycle: { type: ["object", "null"] } } };
  add("/v1/areas", "get", operation({ method: "get", summary: "The record areas: fields, lifecycles, permissions.", group: "areas", sdk: "list", scope: "read",
    ok: json({ type: "object", required: ["data"], properties: { data: { type: "array", items: ref("Area") } } }) }));

  // ---------- record areas ----------
  const areas = recordAreas();
  for (const a of areas) {
    const N = pascal(a.name);
    const ws = a.scope === "workspace";
    const writable = ws && !isReadOnlyArea(a);
    const props = Object.fromEntries(a.fields.map((f) => [f.name, fieldSchema(f)]));
    const required = a.fields.filter((f) => f.required && f.name !== a.lifecycle?.field).map((f) => f.name);
    schemas[`${N}Data`] = { type: "object", title: `${a.label}: fields`, properties: props, additionalProperties: false };
    schemas[`${N}Input`] = { type: "object", title: `${a.label}: fields to write`, properties: Object.fromEntries(Object.entries(props).filter(([k]) => k !== a.lifecycle?.field)),
      ...(required.length ? { required } : {}), additionalProperties: false };
    schemas[`${N}Record`] = { type: "object", title: a.label, ...(a.description ? { description: a.description } : {}), required: ["area", "key", "title", "data", "updated_at"],
      properties: { area: { const: a.name }, key: { type: "string" }, title: { type: ["string", "null"] }, data: ref(`${N}Data`), version: { type: ["string", "null"] },
        updated_at: { type: "string", format: "date-time" }, misfits: { type: "array", items: { type: "string" } } } };
    schemas[`${N}Page`] = { type: "object", required: ["data", "next"], properties: { data: { type: "array", items: ref(`${N}Record`) }, next: { type: ["string", "null"] } } };
    const group = `records.${a.name}`;
    const base = `/v1/records/${a.name}`, one = `${base}/{key}`;
    const keyP = pathParam("key", `The ${a.label} record's key.`);
    const readScope = `read:${a.name}`, writeScope = `write:${a.name}`;
    if (!areaOpWithheld(a.name, "list"))
      add(base, "get", operation({ method: "get", summary: `A page of ${a.label} records.`, group, sdk: "list", scope: readScope, params: [P.limit, P.after,
        { name: "sort", in: "query", schema: { type: "string" }, description: "A field (or key, title, updated_at); -field for descending." },
        { name: "filter", in: "query", schema: { type: "string" }, description: "JSON: {field: value} or {field: {op: value}}, op one of eq, ne, in, lt, lte, gt, gte, contains, prefix, exists." }],
        ok: json(ref(`${N}Page`)) }));
    if (!areaOpWithheld(a.name, "get"))
      add(one, "get", operation({ method: "get", summary: `One ${a.label} record and the records it links to.`, group, sdk: "get", scope: readScope, params: [keyP],
        ok: json({ type: "object", required: ["data"], properties: { data: ref(`${N}Record`), links: { type: "array", items: { type: "object" } } } }) }));
    if (writable && !areaOpWithheld(a.name, "create"))
      add(base, "post", operation({ method: "post", summary: `Create a ${a.label} record.`, group, sdk: "create", scope: writeScope, write: true, status: "201",
        body: body({ type: "object", required: ["key", "data"], properties: { key: { type: "string" }, title: { type: ["string", "null"] }, data: ref(`${N}Input`) } }),
        ok: json({ type: "object", required: ["data"], properties: { data: ref(`${N}Record`) } }, "Created") }));
    if (writable && !areaOpWithheld(a.name, "update"))
      add(one, "put", operation({ method: "put", summary: `Replace a ${a.label} record's title and fields (its state is kept).`, group, sdk: "update", scope: writeScope, write: true, params: [keyP],
        body: body({ type: "object", required: ["data"], properties: { title: { type: ["string", "null"] }, data: ref(`${N}Input`) } }),
        ok: json({ type: "object", required: ["data"], properties: { data: ref(`${N}Record`) } }) }));
    if (writable && a.lifecycle && !areaOpWithheld(a.name, "move")) {
      const states = optionValues(a.fields.find((f) => f.name === a.lifecycle!.field) ?? {});
      add(`${one}/move`, "post", operation({ method: "post", summary: `Move a ${a.label} record along its lifecycle.`, group, sdk: "move", scope: writeScope, write: true, params: [keyP],
        body: body({ type: "object", required: ["to"], properties: { to: { type: "string", enum: states } } }),
        ok: json({ type: "object", required: ["data"], properties: { data: ref(`${N}Record`) } }) }));
    }
    if (writable && !areaOpWithheld(a.name, "delete"))
      add(one, "delete", operation({ method: "delete", summary: `Delete a ${a.label} record.`, group, sdk: "delete", scope: writeScope, write: true, params: [keyP], status: "204", ok: { description: "Deleted" } }));
  }
  if (areas.some((a) => a.scope === "workspace" && !isReadOnlyArea(a)))
    add("/v1/batch", "post", operation({ method: "post", summary: "Several writes to one pack's areas as one transaction: all of them, or none.", group: "records", sdk: "batch", scope: "write", write: true,
      body: body({ type: "object", required: ["operations"], properties: { operations: { type: "array", minItems: 1, maxItems: 1000, items: { type: "object", required: ["op", "area", "key"],
        properties: { op: { type: "string", enum: ["put", "create", "update", "move", "delete"] }, area: { type: "string" }, key: { type: "string" }, title: { type: ["string", "null"] }, data: { type: "object" }, to: { type: "string" } } } } } }),
      ok: json({ type: "object", required: ["data"], properties: { data: { type: "array", items: { type: "object" } } } }) }));

  // ---------- declarative checks (mold_v0-196, src/checks.ts) ----------
  for (const c of declaredChecks()) {
    const props = Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, t]) => {
      const { type } = inputKind(t);
      return [k, type === "date" ? { type: "string", format: "date" } : type === "datetime" ? { type: "string", format: "date-time" } : { type }];
    }));
    const required = Object.entries(c.inputs ?? {}).filter(([, t]) => !inputKind(t).optional).map(([k]) => k);
    add(`/v1/checks/${c.name}`, "post", operation({ method: "post", summary: c.label ?? c.description ?? `Check ${c.name}: yes or no.`, group: "checks", sdk: c.name, scope: `checks:${c.name}`,
      body: body({ type: "object", properties: props, ...(required.length ? { required } : {}), additionalProperties: false }),
      ok: json({ type: "object", required: ["data"], properties: { data: { type: "object", required: ["check", "allowed", "reason", "record_refs"], properties: {
        check: { type: "string" }, allowed: { type: "boolean" }, reason: { type: "string" },
        record_refs: { type: "array", items: { type: "object", properties: { area: { type: "string" }, key: { type: "string" } } } }, explanation: { type: "object" } } } } }) }));
  }

  // ---------- runs ----------
  const kinds = jobKinds();
  if (kinds.length) {
    schemas.Run = { type: "object", required: ["id", "kind", "status"], properties: {
      id: { type: "string" }, pack: { type: "string" }, kind: { type: "string" }, status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
      attempt: { type: "integer" }, max_attempts: { type: "integer" }, scope: { type: "object" }, targets: { type: "object" }, cost_usd: { type: "number" }, budget_usd: { type: "number" },
      error_kind: { type: ["string", "null"] }, error: { type: ["string", "null"] }, cancel_requested: { type: "boolean" },
      created_at: { type: "string", format: "date-time" }, started_at: { type: ["string", "null"], format: "date-time" }, ended_at: { type: ["string", "null"], format: "date-time" } } };
    const kindNames = [...new Set(kinds.map((k) => k.name))];
    const one = { type: "object", required: ["data"], properties: { data: ref("Run") } };
    add("/v1/runs", "get", operation({ method: "get", summary: "The workspace's runs, newest first.", group: "runs", sdk: "list", scope: "read", params: [P.limit, P.after,
      { name: "kind", in: "query", schema: { type: "string", enum: kindNames } }, { name: "status", in: "query", schema: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] } }],
      ok: json({ type: "object", required: ["data", "next"], properties: { data: { type: "array", items: ref("Run") }, next: { type: ["string", "null"] } } }) }));
    add("/v1/runs", "post", operation({ method: "post", summary: "Start a run of a job kind.", group: "runs", sdk: "start", scope: "run", write: true, status: "201",
      body: body({ type: "object", required: ["kind"], properties: { kind: { type: "string", enum: kindNames }, scope: { type: "object" }, targets: { type: "object" }, approval: { type: "string" } } }),
      ok: json(one, "Queued") }));
    const idP = pathParam("id", "The run's id (run_...).");
    add("/v1/runs/{id}", "get", operation({ method: "get", summary: "One run.", group: "runs", sdk: "get", scope: "read", params: [idP], ok: json(one) }));
    add("/v1/runs/{id}/cancel", "post", operation({ method: "post", summary: "Cancel a run.", group: "runs", sdk: "cancel", scope: "run", write: true, params: [idP], ok: json(one) }));
    add("/v1/runs/{id}/results", "get", operation({ method: "get", summary: "A run's results: each check, the asset and source it is about, its status.", group: "runs", sdk: "results", scope: "read", params: [idP],
      ok: json({ type: "object", required: ["data"], properties: { data: { type: "array", items: { type: "object" } } } }) }));
  }

  // ---------- client sessions and origins ----------
  schemas.ClientSession = { type: "object", required: ["id", "token", "subject", "scopes", "expires_at"], properties: {
    id: { type: "string" }, token: { type: "string", description: "cs_...: give it to the browser or phone app; shown once." }, subject: { type: "string" },
    scopes: { type: "array", items: { type: "string" } }, expires_at: { type: "string", format: "date-time" } } };
  add("/v1/client_sessions", "post", operation({ method: "post", summary: "Mint a short-lived client session for one of your signed-in users.", group: "client_sessions", sdk: "create", scope: "sessions", write: true, status: "201",
    body: body({ type: "object", required: ["subject"], properties: { subject: { type: "string", description: "Your user's id." }, scopes: { type: "array", items: { type: "string" } },
      ttl_seconds: { type: "integer", minimum: 60, maximum: cfg.client_sessions.ttl_seconds } } }), ok: json({ type: "object", required: ["data"], properties: { data: ref("ClientSession") } }, "Created") }));
  add("/v1/client_sessions/{id}", "delete", operation({ method: "delete", summary: "Revoke a client session.", group: "client_sessions", sdk: "revoke", scope: "sessions", write: true,
    params: [pathParam("id", "The session's id (cses_...).")], status: "204", ok: { description: "Revoked" } }));
  const origins = json({ type: "object", required: ["data"], properties: { data: { type: "array", items: { type: "string" } }, app: { type: "array", items: { type: "string" } } } });
  add("/v1/allowed_origins", "get", operation({ method: "get", summary: "The browser origins your client sessions may call from (yours, and the app's).", group: "allowed_origins", sdk: "list", scope: "sessions", ok: origins }));
  add("/v1/allowed_origins", "post", operation({ method: "post", summary: "Allow a browser origin.", group: "allowed_origins", sdk: "add", scope: "sessions", write: true,
    body: body({ type: "object", required: ["origin"], properties: { origin: { type: "string", examples: ["https://app.example.com"] } } }), ok: origins }));
  add("/v1/allowed_origins", "delete", operation({ method: "delete", summary: "Remove a browser origin.", group: "allowed_origins", sdk: "remove", scope: "sessions", write: true,
    params: [{ name: "origin", in: "query", required: true, schema: { type: "string" } }], ok: origins }));

  // ---------- webhooks out ----------
  const declared = cfg.events.map((e) => e.name);
  schemas.WebhookEndpoint = { type: "object", required: ["id", "url", "events", "status"], properties: {
    id: { type: "string" }, url: { type: "string", format: "uri" }, description: { type: ["string", "null"] }, events: { type: "array", items: { type: "string", enum: declared } },
    status: { type: "string", enum: ["enabled", "disabled"] }, disabled_reason: { type: ["string", "null"] }, failure_streak: { type: "integer" },
    secret: { type: "string", description: "whsec_...: answered when the endpoint is made or its secret rotated, and by the audited reveal." },
    secret_rotated_at: { type: ["string", "null"] }, secret_revealed_at: { type: ["string", "null"] }, secret_reveals: { type: "integer" },
    created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } } };
  schemas.WebhookDelivery = { type: "object", required: ["id", "endpoint_id", "event_type", "status", "attempts"], properties: {
    id: { type: "string", description: "The message's webhook-id." }, endpoint_id: { type: "string" }, event_type: { type: "string" },
    status: { type: "string", enum: ["pending", "succeeded", "failed"] }, attempts: { type: "integer" },
    attempt_log: { type: "array", items: { type: "object", properties: { at: { type: "string" }, status: { type: ["integer", "null"] }, ms: { type: "integer" }, error: { type: "string" } } } },
    next_attempt_at: { type: ["string", "null"] }, last_status: { type: ["integer", "null"] }, last_error: { type: ["string", "null"] },
    created_at: { type: "string" }, delivered_at: { type: ["string", "null"] }, payload: ref("EventEnvelope") } };
  schemas.EventEnvelope = { type: "object", required: ["type", "timestamp", "data"], properties: { type: { type: "string" }, timestamp: { type: "string", format: "date-time" }, data: { type: "object" } } };
  const ep = json({ type: "object", required: ["data"], properties: { data: ref("WebhookEndpoint") } });
  const dl = json({ type: "object", required: ["data"], properties: { data: ref("WebhookDelivery") } });
  const epId = pathParam("id", "The endpoint's id (we_...).");
  add("/v1/webhook_endpoints", "get", operation({ method: "get", summary: "The workspace's webhook endpoints.", group: "webhook_endpoints", sdk: "list", scope: "webhooks",
    ok: json({ type: "object", required: ["data"], properties: { data: { type: "array", items: ref("WebhookEndpoint") } } }) }));
  add("/v1/webhook_endpoints", "post", operation({ method: "post", summary: "Add a webhook endpoint (answers its signing secret once).", group: "webhook_endpoints", sdk: "create", scope: "webhooks", write: true, status: "201",
    body: body({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string", enum: declared } }, description: { type: "string" } } }), ok: ep }));
  add("/v1/webhook_endpoints/{id}", "get", operation({ method: "get", summary: "One webhook endpoint.", group: "webhook_endpoints", sdk: "get", scope: "webhooks", params: [epId], ok: ep }));
  add("/v1/webhook_endpoints/{id}", "patch", operation({ method: "patch", summary: "Change an endpoint's address, events or description, or disable or enable it.", group: "webhook_endpoints", sdk: "update", scope: "webhooks", write: true, params: [epId],
    body: body({ type: "object", properties: { url: { type: "string" }, events: { type: "array", items: { type: "string", enum: declared } }, description: { type: "string" }, status: { type: "string", enum: ["enabled", "disabled"] } } }), ok: ep }));
  add("/v1/webhook_endpoints/{id}", "delete", operation({ method: "delete", summary: "Remove a webhook endpoint.", group: "webhook_endpoints", sdk: "delete", scope: "webhooks", write: true, params: [epId], status: "204", ok: { description: "Removed" } }));
  add("/v1/webhook_endpoints/{id}/rotate_secret", "post", operation({ method: "post", summary: "A new signing secret (answered once); the old one signs beside it for grace_hours.", group: "webhook_endpoints", sdk: "rotate_secret", scope: "webhooks", write: true, params: [epId],
    body: body({ type: "object", properties: { grace_hours: { type: "integer", minimum: 0, maximum: 168 } } }, false), ok: ep }));
  add("/v1/webhook_endpoints/{id}/secret", "get", operation({ method: "get", summary: "Read the signing secret again (recorded: when, by whom).", group: "webhook_endpoints", sdk: "reveal_secret", scope: "webhooks", params: [epId],
    ok: json({ type: "object", required: ["data"], properties: { data: { type: "object", required: ["secret"], properties: { secret: { type: "string" } } } } }) }));
  add("/v1/webhook_endpoints/{id}/test", "post", operation({ method: "post", summary: `Send a test ping (${TEST_EVENT}) now.`, group: "webhook_endpoints", sdk: "test", scope: "webhooks", write: true, params: [epId], ok: dl }));
  add("/v1/webhook_endpoints/{id}/deliveries", "get", operation({ method: "get", summary: "The endpoint's delivery log, newest first.", group: "webhook_endpoints", sdk: "deliveries", scope: "webhooks",
    params: [epId, P.limit, P.after, { name: "status", in: "query", schema: { type: "string", enum: ["pending", "succeeded", "failed"] } }],
    ok: json({ type: "object", required: ["data", "next"], properties: { data: { type: "array", items: ref("WebhookDelivery") }, next: { type: ["string", "null"] } } }) }));
  const dId = pathParam("id", "The delivery's id (msg_...).");
  add("/v1/webhook_deliveries/{id}", "get", operation({ method: "get", summary: "One delivery and its attempts.", group: "webhook_deliveries", sdk: "get", scope: "webhooks", params: [dId], ok: dl }));
  add("/v1/webhook_deliveries/{id}/retry", "post", operation({ method: "post", summary: "Send a delivery again now.", group: "webhook_deliveries", sdk: "retry", scope: "webhooks", write: true, params: [dId], ok: dl }));

  // ---------- webhooks in ----------
  if (cfg.webhooks_in?.length) {
    const receivers = cfg.webhooks_in.map((r) => r.name);
    schemas.InboundSource = { type: "object", required: ["id", "receiver", "path"], properties: { id: { type: "string" }, receiver: { type: "string", enum: receivers },
      description: { type: ["string", "null"] }, path: { type: "string" }, secret: { type: "string", description: "whsec_...: answered once, when the source is added." },
      created_at: { type: "string" }, last_received_at: { type: ["string", "null"] }, received: { type: "integer" } } };
    add("/v1/inbound_sources", "get", operation({ method: "get", summary: "The workspace's inbound sources.", group: "inbound_sources", sdk: "list", scope: "webhooks",
      ok: json({ type: "object", required: ["data"], properties: { data: { type: "array", items: ref("InboundSource") } } }) }));
    add("/v1/inbound_sources", "post", operation({ method: "post", summary: "Add an inbound source for a receiver (answers its address and signing secret once).", group: "inbound_sources", sdk: "create", scope: "webhooks", write: true, status: "201",
      body: body({ type: "object", required: ["receiver"], properties: { receiver: { type: "string", enum: receivers }, description: { type: "string" } } }),
      ok: json({ type: "object", required: ["data"], properties: { data: ref("InboundSource") } }, "Created") }));
    add("/v1/inbound_sources/{id}", "delete", operation({ method: "delete", summary: "Remove an inbound source.", group: "inbound_sources", sdk: "delete", scope: "webhooks", write: true,
      params: [pathParam("id", "The source's id (src_...).")], status: "204", ok: { description: "Removed" } }));
    paths["/v1/inbound/{id}"] = { post: {
      operationId: "inbound_receive", summary: "Receive a signed payload (Standard Webhooks) into the source's receiver area.", tags: ["inbound"], security: [],
      parameters: [pathParam("id", "The source's id (src_...)."), ...["webhook-id", "webhook-timestamp", "webhook-signature"].map((n) => ({ name: n, in: "header", required: true, schema: { type: "string" } }))],
      requestBody: body({ type: "object" }),
      responses: { 200: json({ type: "object", properties: { written: { type: "integer" }, area: { type: "string" }, keys: { type: "array", items: { type: "string" } }, replayed: { type: "boolean" } } }), default: problem } } };
  }

  // ---------- the events, as OpenAPI 3.1 webhooks ----------
  const webhooks: Record<string, unknown> = {};
  for (const e of [...cfg.events, { name: TEST_EVENT, description: "A test ping you asked for." }]) {
    const record = (EVENT_CATALOG as Record<string, { record: boolean }>)[e.name]?.record === true;
    const data: Schema = record
      ? { type: "object", required: ["area", "key"], properties: { area: { type: "string", ...("areas" in e && e.areas?.length ? { enum: e.areas } : {}) }, key: { type: "string" }, title: { type: ["string", "null"] },
          data: { type: "object" }, updated_at: { type: "string" }, sealed: { type: "boolean" }, from: {}, to: {}, actor: { type: ["string", "null"] } } }
      : e.name === "clock.overdue" ? { type: "object", required: ["area", "key", "clock", "due_at"], properties: { area: { type: "string" }, key: { type: "string" },
          clock: { type: "string" }, due_at: { type: ["string", "null"], format: "date-time" } } }
      : e.name === "run.finished" ? { type: "object", required: ["run"], properties: { run: kinds.length ? ref("Run") : { type: "object" } } }
      : ("payload" in e && e.payload ? e.payload as Schema : { type: "object" });
    webhooks[e.name] = { post: {
      summary: e.description, description: (EVENT_CATALOG as Record<string, { about: string }>)[e.name as EventName]?.about ?? e.description,
      parameters: ["webhook-id", "webhook-timestamp", "webhook-signature"].map((n) => ({ name: n, in: "header", required: true, schema: { type: "string" } })),
      requestBody: body({ type: "object", required: ["type", "timestamp", "data"], properties: { type: { const: e.name }, timestamp: { type: "string", format: "date-time" }, data } }),
      responses: { 200: { description: "Any 2xx within 15 seconds: received. Anything else is retried with backoff." } } } };
  }

  return {
    openapi: "3.1.0",
    info: { title: `${PROFILE.name} API`, version: currentApiVersion(), description: `${PROFILE.short_description}\n\nAuthenticate with a key (sk_...) from your server, or a client session (cs_...) from a browser or phone. Dated versions: send API-Version.`,
      "x-api-versions": [...API_VERSIONS] },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    "x-sdk": { npm: `${NS.replace(/_/g, "-")}-api`, python: `${NS.replace(/-/g, "_")}_api`, languages: cfg.sdk_languages,
      // A check that buckets (mold_v0-226): the SDKs carry the same bucket function (scripts/lib/sdk-gen.ts).
      ...(declaredChecks().some(checkBuckets) ? { bucketing: true } : {}) },
    paths,
    webhooks,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A key (sk_...) on a server; a client session (cs_...) in a browser or phone." } },
      parameters: {
        ApiVersion: { name: "API-Version", in: "header", required: false, schema: { type: "string", enum: [...API_VERSIONS] }, description: "The dated version to answer as (default: the key's)." },
        IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 1, maxLength: 255 }, description: "The same key and request within 24 hours answers the first answer again." },
        Actor: { name: "X-Actor", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9._:@+-]{1,128}$" }, description: "Your signed-in user this call is for (keys only): recorded as the actor." },
        Scope: { name: "X-Scope", in: "header", required: false, schema: { type: "string" }, description: "Narrow this request to these scopes (space-separated), each one the credential holds." },
        Limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        After: { name: "after", in: "query", required: false, schema: { type: "string" }, description: "The previous page's next." },
      },
      schemas,
    },
  };
}
