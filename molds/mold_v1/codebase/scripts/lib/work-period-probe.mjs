#!/usr/bin/env node
/**
 * What THIS checkout's deployment profile makes of work periods, as one JSON document on stdout: the settings, the
 * words a person reads, the views, the coding agent's tools, and what each ops route answers a signed-in caller.
 * No database, no network. scripts/test-work-periods.mjs runs it in a copy of the checkout per profile
 * (scripts/lib/profile-copy.mjs): a build-time setting can only be observed in a build that has it.
 */
import { generateKeyPairSync } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

for (const name of ["DATABASE_URL", "POSTGRES_URL", "TASK_WORKFLOW_SERVICE_URL", "TASK_WORKFLOW_SERVICE_TOKEN", "BLOB_READ_WRITE_TOKEN"]) delete process.env[name];
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { WORK_PERIODS } = await import(root("agent/lib/work-periods.ts"));
const ui = await import(root("lib/work-periods-ui.ts"));
const { W } = await import(root("lib/ui-words.ts"));
const { DEPLOYMENT_PROFILE } = await import(root("lib/deployment-profile.generated.ts"));
const tools = await import(root("setup/workspace-tools.mjs"));
const { fill } = await import(root("agent/lib/agent-vocabulary.ts"));
const { NextRequest } = await import("next/server");
const { mintSessionToken } = await import(root("lib/auth-session.ts"));
const bearer = `Bearer ${await mintSessionToken("reader@onfinance.in")}`;

const strings = Object.fromEntries(Object.entries(ui.periodUi()).map(([k, v]) => [k, typeof v === "function" ? (k === "leadTitle" ? v("lead@example.com") : k === "progressLabel" ? [v(1, 1), v(2, 5)] : [v(1), v(3)]) : v]));

const folders = Object.fromEntries(["accounts", "platform", "deliveries", "solutions", "projects", "tickets", "people", "uploads"].map((id) => [id, id]));
const ctx = { api: async () => ({}), folders, workPeriods: { mode: WORK_PERIODS.mode, label: WORK_PERIODS.label, itemLabel: WORK_PERIODS.itemLabel } };
const offered = tools.availableTools(tools.createTools(ctx), ctx);
const mcp = Object.fromEntries(
  offered.filter((t) => /^(sprint_list|sprint_create|task_list|task_create|task_update)$/.test(t.name)).map((t) => [t.name, { description: t.description, cycleId: t.inputSchema?.properties?.cycleId ?? null }]),
);
const instructions = tools.serverInstructions({ productName: "X", opsUrl: "https://x.example.com", signInHint: "h", workPeriods: ctx.workPeriods });

const H = "http://periods.test";
const ID = "11111111-1111-4111-8111-111111111111";
const call = async (file, method, url, { body, context } = {}) => {
  const handlers = await import(root(file));
  const request = new NextRequest(url, { method, headers: { authorization: bearer, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handlers[method](request, context);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json };
};
const params = { params: Promise.resolve({ id: ID }) };
const routes = {
  "GET /api/ops/cycles": await call("app/api/ops/cycles/route.ts", "GET", `${H}/api/ops/cycles`),
  "POST /api/ops/cycles": await call("app/api/ops/cycles/route.ts", "POST", `${H}/api/ops/cycles`, { body: { name: "P1" } }),
  "PATCH /api/ops/cycles/:id": await call("app/api/ops/cycles/[id]/route.ts", "PATCH", `${H}/api/ops/cycles/${ID}`, { body: { name: "P2" }, context: params }),
  "PATCH /api/ops/cycles/:id lead": await call("app/api/ops/cycles/[id]/route.ts", "PATCH", `${H}/api/ops/cycles/${ID}`, { body: { lead: "lead@example.com" }, context: params }),
  "DELETE /api/ops/cycles/:id": await call("app/api/ops/cycles/[id]/route.ts", "DELETE", `${H}/api/ops/cycles/${ID}`, { context: params }),
  "POST /api/ops/cycles/:id/rollover": await call("app/api/ops/cycles/[id]/rollover/route.ts", "POST", `${H}/api/ops/cycles/${ID}/rollover`, { body: {}, context: params }),
  "GET /api/ops/cycles/:id/goals": await call("app/api/ops/cycles/[id]/goals/route.ts", "GET", `${H}/api/ops/cycles/${ID}/goals`, { context: params }),
  "PUT /api/ops/cycles/:id/goals": await call("app/api/ops/cycles/[id]/goals/route.ts", "PUT", `${H}/api/ops/cycles/${ID}/goals`, { body: { goal: "x" }, context: params }),
  "POST /api/ops/todos with cycleId": await call("app/api/ops/todos/route.ts", "POST", `${H}/api/ops/todos`, { body: { title: "t", cycleId: ID } }),
  "POST /api/ops/todos without": await call("app/api/ops/todos/route.ts", "POST", `${H}/api/ops/todos`, { body: { title: "t" } }),
  "PATCH /api/ops/todos/:id with cycleId": await call("app/api/ops/todos/[id]/route.ts", "PATCH", `${H}/api/ops/todos/${ID}`, { body: { cycleId: ID }, context: params }),
  "GET /api/ops/activity?entity=cycle": await call("app/api/ops/activity/route.ts", "GET", `${H}/api/ops/activity?entity=cycle&id=${ID}`),
  "GET /api/ops/activity?entity=task": await call("app/api/ops/activity/route.ts", "GET", `${H}/api/ops/activity?entity=task&id=${ID}`),
  "GET /api/ops/comments?entity=cycle": await call("app/api/ops/comments/route.ts", "GET", `${H}/api/ops/comments?entity=cycle&id=${ID}`),
};
const server = await import(root("lib/work-periods-server.ts"));

console.log(JSON.stringify({
  profile: DEPLOYMENT_PROFILE.work_periods,
  settings: WORK_PERIODS,
  words: { period: W.period, periods: W.periods, Period: W.Period, Periods: W.Periods, periodList: W.periodList, periodLists: W.periodLists, periodItem: W.periodItem, periodItems: W.periodItems },
  filled: fill("{period} {periods} {Period} {Periods} {period_item} {period_items} {Period_item} {Period_items}"),
  views: ui.todoViews(),
  resolved: { period: ui.resolveTodoView(ui.PERIOD_VIEW), tasks: ui.resolveTodoView("tasks"), none: ui.resolveTodoView(undefined) },
  strings,
  mcp,
  mcpNames: offered.map((t) => t.name),
  instructions,
  routes,
  serviceHeaders: server.periodHeaders(),
  withoutPeriod: server.withoutPeriod({ items: [{ id: "t", cycleId: ID, title: "x" }] }),
}));
process.exit(0);
