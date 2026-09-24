/**
 * THE OFFLINE HALF OF "ONE WORKSPACE CANNOT REACH ANOTHER'S RECORD BY ID".
 *
 * The database half (scripts/test-cross-workspace-reads-db.mjs, in CI's isolation job) proves each by-id reader and
 * writer returns nothing to another workspace under the fail-closed policy. What it cannot see is the WIRING, and
 * the wiring is where the leak lived: every one of those functions takes the caller's workspace as an optional last
 * argument, and a tool that forgets to pass it gets the old "find it wherever it lives" contract back without a
 * type error. So this holds, with no database and no secret:
 *
 *   1. a failed query's error is a plain sentence: never the statement, never a bound value, never the driver's
 *      `detail` — at the database layer (agent/lib/db/query-errors.ts) and again at the tool boundary
 *      (modelFacing), because a tool's thrown error is handed to the model verbatim and drawn in the chat;
 *   2. every model tool that reads or writes a record by id passes the CALLER's workspace (orgForSession), and no
 *      model tool takes its workspace from a customer id;
 *   3. check:tenancy FAILS on each shape of the bug — the optional-chained guard, the guard that admits a row it
 *      could not see, a tool resolving its workspace from a model-supplied id — and passes once it is gone.
 *
 *   npm run test:cross-workspace
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    // stderr directly: the error-text sections silence console.error around the server-side log line.
    process.stderr.write(`  ✗ ${what}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
  }
};
const SECRET = "Confidential Holdings covenant-breach 4417";
/** A driver failure the way drizzle hands it on: statement + params in the message, the pg error as `cause`. */
const drizzleFailure = (code) => {
  const pg = Object.assign(new Error(`new row violates row-level security policy for table "customers"`), {
    code,
    detail: `Failing row contains (acme, ${SECRET}).`,
    table_name: "customers",
    constraint_name: code === "23505" ? "customers_pkey" : undefined,
  });
  return Object.assign(new Error(`Failed query: insert into "customers" ("customer_id", "customer_name") values ($1, $2)\nparams: acme,${SECRET}`), { cause: pg });
};
const everything = (e) => `${e?.message} ${String(e)} ${JSON.stringify(e)} ${JSON.stringify(e?.cause ?? null)}`;

/* ---- 1. errors ---------------------------------------------------------- */

console.log("\n1. A database error reaches nobody with its values");
const quiet = console.error;
console.error = () => {}; // the server-side log line is expected; it is asserted below instead
try {
  const { PgPreparedQuery } = await import("drizzle-orm/pg-core");
  const { installQueryErrorRedaction, redactQueryError } = await import("../agent/lib/db/query-errors.ts");
  check("the redaction installs on this drizzle (a drizzle upgrade that moves queryWithCache fails here)", installQueryErrorRedaction() === true);
  let thrown = null;
  const logged = [];
  console.error = (line) => logged.push(String(line));
  try {
    await PgPreparedQuery.prototype.queryWithCache.call({}, `insert into "customers" values ($1, $2)`, ["acme", SECRET], async () => {
      throw drizzleFailure("42501").cause;
    });
  } catch (e) {
    thrown = e;
  }
  console.error = () => {};
  check("a query that fails in drizzle throws", thrown !== null);
  check("…a plain sentence, with none of the values", thrown && !everything(thrown).includes(SECRET), everything(thrown).slice(0, 300));
  check("…and not the statement", thrown && !/Failed query|insert into|params:/i.test(thrown.message), thrown?.message);
  check("…with the SQLSTATE kept on the error and its cause (lib/pg-error.ts branches on it)", thrown?.code === "42501" && thrown?.cause?.code === "42501");
  check("…and the driver's `detail` dropped", thrown && thrown.cause?.detail === undefined);
  check(
    "the server-side log names the SQLSTATE, table and statement, not the values",
    logged.length === 1 && /code=42501/.test(logged[0]) && /insert into/.test(logged[0]) && !logged[0].includes(SECRET),
    logged,
  );
  const unique = redactQueryError(drizzleFailure("23505"));
  check("a duplicate reads as a duplicate, without the row", /already exists/.test(unique.message) && !everything(unique).includes(SECRET), unique.message);

  const { modelFacing } = await import("../agent/lib/model-facing/tools/model-facing.ts");
  const { defineTool } = await import("eve/tools");
  const { z } = await import("zod");
  const tool = modelFacing(
    "cross_workspace_probe",
    defineTool({
      description: "probe",
      inputSchema: z.object({}),
      async execute() {
        throw drizzleFailure("42501");
      },
    }),
  );
  let toolError = null;
  try {
    await tool.execute({}, {});
  } catch (e) {
    toolError = e;
  }
  check("a tool whose query failed throws a sentence, not the query (the model and the chat see this text)", toolError && !everything(toolError).includes(SECRET) && !/Failed query/.test(toolError.message), toolError?.message);
  const plain = modelFacing(
    "cross_workspace_probe_plain",
    defineTool({
      description: "probe",
      inputSchema: z.object({}),
      async execute() {
        throw new Error("Unknown customer: acme");
      },
    }),
  );
  let plainError = null;
  try {
    await plain.execute({}, {});
  } catch (e) {
    plainError = e;
  }
  check("…while a tool's own sentence passes through untouched", plainError?.message === "Unknown customer: acme", plainError?.message);
} finally {
  console.error = quiet;
}

/* ---- 2. wiring ---------------------------------------------------------- */

console.log("\n2. Every by-id tool passes the caller's workspace");
/** The text of every call to `name(` in `src`, balanced over parentheses. */
const callsOf = (src, name) => {
  const out = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  for (const m of src.matchAll(re)) {
    // skip the declaration itself
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 0;
    let i = m.index + name.length;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
};
const BY_ID = [
  "getCustomer", "upsertCustomer", "recordInteraction", "recordInteractions", "reassignOwner", "createTicket",
  "setTicketStatus", "resolveFollowUp", "listFollowUps", "matchCustomerByEmail", "listCustomers", "renderAccountReport",
  "renderDataroomSummary", "buildCustomerWorkbookSpecs", "buildDomainWorkbookSpec", "runEmailIntake", "ingestSource",
];
const TOOL_FILES = ["agent/lib/tools.ts", "agent/lib/artifact-render-tools.ts", "agent/lib/sync-tools.ts", "agent/lib/signoff-tools.ts"];
const WORKSPACE = /orgForSession\(ctx|\borg(?:Id)?\b/;
let calls = 0;
for (const file of TOOL_FILES) {
  const src = readFileSync(file, "utf8");
  for (const name of BY_ID) {
    for (const call of callsOf(src, name)) {
      calls++;
      check(`${file}: ${call.replace(/\s+/g, " ").slice(0, 90)}`, WORKSPACE.test(call), "passes no workspace");
    }
  }
  check(`${file}: no workspace taken from a customer id`, !/\borgForCustomer\(/.test(src));
}
check(`(${calls} by-id calls found — the list is not empty)`, calls >= 15, calls);
// The one place the fallback may live: a system path with no caller. It must be the fallback, never the answer.
const sor = readFileSync("agent/lib/system-of-record.ts", "utf8");
{
  // The no-caller fallback finds the OWNER per workspace (acrossOrgDbs), never through orgForCustomer — which reads
  // on the bare handle and, fail-closed, answers the default workspace for every id — and only when NO workspace was
  // given: an empty one is refused, not widened.
  const fn = sor.slice(sor.indexOf("async function scopeFor"), sor.indexOf("\n}\n", sor.indexOf("async function scopeFor")));
  check("system-of-record: nothing calls orgForCustomer", callsOf(sor, "orgForCustomer").length === 0);
  check("system-of-record: the fallback resolves the owner across workspaces, each in its own scope", /acrossOrgDbs\(/.test(fn) && /customersTable\.customerId, customerId/.test(fn), fn);
  check("system-of-record: …only when no workspace was given at all", /if \(orgId\) return orgId;/.test(fn) && /if \(orgId !== undefined\) throw/.test(fn), fn);
}
check("system-of-record: getCustomer reads in the caller's scope, not across all", /return await dbGetCustomer\(db, id, orgId\)/.test(sor));

/* ---- 2b. service sessions name their workspace ------------------------- */

console.log("\n2b. A service-started turn carries the workspace it acts for");
{
  const scope = await import("../agent/lib/service-scope.ts").catch((e) => ({ missing: String(e) }));
  check("agent/lib/service-scope.ts exists", !scope.missing, scope.missing);
  if (!scope.missing) {
    const app = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };
    // The front-end's production token as vercelOidc hands it over (the full token matrix, through the real verifier,
    // is scripts/test-service-scope-oidc.mjs).
    const FE = "owner:f20170061g-3183s-projects:project:fde-agent:environment:production";
    const vercel = { authenticator: "oidc", issuer: "https://oidc.vercel.com/f20170061g-3183s-projects", principalId: `https://oidc.vercel.com/f20170061g-3183s-projects:${FE}`, principalType: "service", subject: FE, attributes: { environment: "production" } };
    const agentPreview = { ...vercel, subject: "owner:f20170061g-3183s-projects:project:fde-agent-api:environment:preview", attributes: { environment: "preview" } };
    const google = { authenticator: "oidc", issuer: "https://accounts.google.com", principalId: "a@b.test", principalType: "user", attributes: { email: "a@b.test", workspace_scope: "org-a" } };
    const emailed = { authenticator: "jwt-ecdsa", issuer: "delivered", principalId: "a@b.test", principalType: "service", attributes: { email: "a@b.test", workspace_scope: "org-a" } };
    check("the schedule's app principal names the rule's workspace", scope.serviceScopeOf(scope.withServiceScope(app, "org-a")) === "org-a");
    const headers = new Headers({ [scope.SERVICE_SCOPE_HEADER]: "org-b" });
    check("the front-end's service token names the header's workspace", scope.serviceScopeOf(scope.sessionAuthForRequest(vercel, headers)) === "org-b");
    check("a person's Google token never names one — not by attribute", scope.serviceScopeOf(google) === undefined);
    check("…and the attribute is stripped at the door, header or not", !("workspace_scope" in scope.sessionAuthForRequest(google, headers).attributes));
    check("an emailed-code session token (jwt-ecdsa, principalType service) is not a service principal", scope.serviceScopeOf(emailed) === undefined && !("workspace_scope" in scope.sessionAuthForRequest(emailed, headers).attributes));
    check("the agent project's own PREVIEW token cannot name one", scope.serviceScopeOf(scope.sessionAuthForRequest(agentPreview, headers)) === undefined);
    check("a service call with no header names nothing (and a forged attribute is dropped)", scope.serviceScopeOf(scope.sessionAuthForRequest({ ...vercel, attributes: { workspace_scope: "org-z" } }, new Headers())) === undefined);
  }
  const dynamic = readFileSync("agent/schedules/dynamic.ts", "utf8");
  check("agent/schedules/dynamic.ts: a rule's turn starts with the rule's workspace", /auth:\s*withServiceScope\(appAuth,\s*claim\.orgId\)/.test(dynamic));
  const eve = readFileSync("agent/channels/eve.ts", "utf8");
  check("agent/channels/eve.ts: inbound messages go through sessionAuthForRequest", /onMessage:[^\n]*sessionAuthForRequest\(eve\.caller,\s*eve\.request\.headers\)/.test(eve));
  const rc = readFileSync("agent/instructions/runtime-context.ts", "utf8");
  check("runtime-context records a service session's scope, so its specialists inherit it", /recordSessionScope\([^)]*\{\s*service:/.test(rc));
  const delegate = readFileSync("lib/workflow-delegate.ts", "utf8");
  check("lib/workflow-delegate.ts sends the workspace header when it starts a step", /\[SERVICE_SCOPE_HEADER\]:\s*orgId/.test(delegate));
  const callers = execFileSync("grep", ["-rln", "makeDelegate(", "lib", "app", "--include=*.ts"], { encoding: "utf8" }).trim().split("\n").filter((f) => f !== "lib/workflow-delegate.ts");
  let delegateCalls = 0;
  for (const file of callers) {
    for (const call of callsOf(readFileSync(file, "utf8"), "makeDelegate")) {
      delegateCalls++;
      // makeDelegate(bearer, timeout, signal, context, orgId): the fifth argument names the workspace.
      const args = call.slice("makeDelegate(".length, -1);
      let depth = 0;
      let commas = 0;
      for (const ch of args) {
        if ("({[".includes(ch)) depth++;
        else if (")}]".includes(ch)) depth--;
        else if (ch === "," && depth === 0) commas++;
      }
      check(`${file}: ${call.replace(/\s+/g, " ").slice(0, 80)} names a workspace`, commas >= 4 && /org(Id)?\b|\.orgId|fireOrg/.test(args.split(",").slice(4).join(",")), call);
    }
  }
  check(`(${delegateCalls} makeDelegate calls found)`, delegateCalls >= 7, delegateCalls);
}

/* ---- 2c. errors: real causes survive, and 42501 is neutral -------------- */

console.log("\n2c. A non-database error keeps its cause; 42501 does not confirm the id exists elsewhere");
{
  const saved = console.error;
  console.error = () => {};
  try {
    const qe = await import("../agent/lib/db/query-errors.ts");
    const { modelFacing } = await import("../agent/lib/model-facing/tools/model-facing.ts");
    const { defineTool } = await import("eve/tools");
    const { z } = await import("zod");
    for (const code of ["EPERM", "EPIPE", "EBUSY"]) {
      const original = Object.assign(new Error(`${code}: operation failed, open '/tmp/dataroom/x.md'`), { code });
      const tool = modelFacing(`cross_workspace_probe_${code.toLowerCase()}`, defineTool({ description: "probe", inputSchema: z.object({}), async execute() { throw original; } }));
      let got = null;
      try {
        await tool.execute({}, {});
      } catch (e) {
        got = e;
      }
      check(`a tool's ${code} (not a database error) reaches the model as itself`, got === original, got?.message);
    }
    const pipe = Object.assign(new Error('Failed query: select * from "customers" where "customer_id" = $1\nparams: acme-secret'), { cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) });
    const redactedPipe = qe.redactQueryError(pipe, 'select * from "customers" where "customer_id" = $1');
    check("a dropped connection under drizzle keeps its code and says so, without the params", redactedPipe.code === "EPIPE" && /EPIPE/.test(redactedPipe.message) && /reached/.test(redactedPipe.message) && !redactedPipe.message.includes("acme-secret"), redactedPipe.message);
    check("SQLSTATE: 42501 / 23505 / P0001 / XX000 are; EPERM / EPIPE / EBUSY are not", typeof qe.isSqlState === "function" && ["42501", "23505", "P0001", "XX000"].every(qe.isSqlState) && !["EPERM", "EPIPE", "EBUSY"].some(qe.isSqlState));
    const rls = (sql) => qe.redactQueryError(Object.assign(new Error(`Failed query: ${sql}\nparams: x`), { cause: Object.assign(new Error("row-level security"), { code: "42501" }) }), sql);
    const readRls = rls('select * from "customers" where "customer_id" = $1');
    const writeRls = rls('insert into "customers" ("customer_id") values ($1)');
    check("a refused READ says it can't be read from here, and does not claim nothing was written", /can't be read from this workspace/.test(readRls.message) && !/written/.test(readRls.message), readRls.message);
    check("a refused WRITE says it can't be changed from here and nothing was written", /can't be changed from this workspace/.test(writeRls.message) && /nothing was written/.test(writeRls.message), writeRls.message);
    check("neither says the record is 'not in this workspace' (that confirms the id exists elsewhere)", ![readRls, writeRls].some((e) => /not in this workspace/.test(e.message)));
    const src = readFileSync("agent/lib/db/query-errors.ts", "utf8");
    const referenced = [...src.matchAll(/scripts\/[\w.-]+\.mjs/g)].map((m) => m[0]);
    check("query-errors.ts names only test files that exist", referenced.length > 0 && referenced.every((f) => { try { readFileSync(f); return true; } catch { return false; } }), referenced);
  } finally {
    console.error = saved;
  }
}

/* ---- 3. the ratchet ----------------------------------------------------- */

console.log("\n3. check:tenancy fails on each shape of the bug");
const PROBES = [
  [
    "agent/lib/__xws_probe_optional__.ts",
    `export function probe(row: { orgId?: string } | undefined, orgId: string) {\n  if (row?.orgId && row.orgId !== orgId) return null;\n  return row;\n}\n`,
    "the optional-chained guard (getCustomer's)",
  ],
  [
    "lib/__xws_probe_admits__.ts",
    `export function probe(row: { orgId: string } | undefined, orgId: string) {\n  return row ? row.orgId === orgId : true;\n}\n`,
    "the guard that admits a row it could not see (customerInOrg's)",
  ],
  [
    "agent/lib/__xws_probe_tool__.ts",
    `import { orgForCustomer } from "./org-context.ts";\nimport { modelFacing } from "./model-facing/tools/model-facing.ts";\nexport const probe = modelFacing("probe", { execute: async ({ customerId }: { customerId: string }) => orgForCustomer(customerId) });\n`,
    "a model tool taking its workspace from a customer id (get_signoff_status's)",
  ],
];
for (const [file, body, what] of PROBES) {
  writeFileSync(file, body);
  let failed = false;
  let out = "";
  try {
    execFileSync("node", ["scripts/check-tenancy.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    failed = true;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  } finally {
    rmSync(file, { force: true });
  }
  check(`fails on ${what}, and names the file`, failed && out.includes(file), out.slice(0, 300));
}
let clean = true;
try {
  execFileSync("node", ["scripts/check-tenancy.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch {
  clean = false;
}
check("…and passes again once the probes are gone", clean);

console.log(failures === 0 ? "\ntest-cross-workspace: all assertions passed" : `\ntest-cross-workspace: ${failures} FAILED`);
assert.equal(failures, 0, `${failures} cross-workspace assertion(s) failed`);
