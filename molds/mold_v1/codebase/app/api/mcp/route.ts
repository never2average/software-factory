import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { FOLDER, fillFolders } from "@/agent/lib/dataroom-folders";
import { WORK_PERIODS } from "@/agent/lib/work-periods";
import { DEPLOYMENT_PROFILE, PRODUCT_NAME } from "@/lib/deployment-profile.generated";
import { handleMcpRequest, type McpDeps } from "@/lib/mcp-server";
import { toolChoices } from "@/lib/ops-domain-fields";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { areaView, describeMoves, describeStructure, type RecordAreaId } from "@/agent/lib/record-areas";
import { manyPerAccount } from "@/agent/lib/implementation-ids";

/** This deployment's definition of a task, for the task tools: only when its profile redefines one. */
function taskTools(): McpDeps["tasks"] {
  const v = areaView("tasks");
  if (!v.redefined || !v.lifecycle) return undefined;
  return {
    noun: v.noun,
    nouns: v.nouns,
    stateField: v.lifecycle.field,
    states: v.lifecycle.states.filter((s) => !s.retired).map((s) => ({ value: s.value, label: s.label })),
    priorities: v.options("priority").map((o) => ({ value: o.value, label: o.label })),
    // An enforced lifecycle (agent/lib/record-lifecycle.ts) with a move that needs a comment: task_update takes `reason`.
    ...(v.lifecycle.enforce !== "off" && (v.area.lifecycle?.transitions ?? []).some((t) => t.requires_comment) ? { takesComment: true } : {}),
    // The lifecycle as its moves (from each state, what it may go to and what each needs), for task_update's text.
    ...((v.area.lifecycle?.transitions ?? []).length ? { moves: describeMoves("tasks").map((l) => l.trim()).join("\n") } : {}),
    ownFields: v.ownFields.filter((f) => !f.hidden && !f.computed).map((f) => ({ key: f.key, label: f.label ?? f.key, type: f.type, required: f.required, ...(f.help ? { help: f.help } : {}), ...(f.options ? { options: f.options.filter((o) => !o.retired).map((o) => ({ value: o.value, label: o.label ?? o.value })) } : {}), ...(f.many ? { many: true } : {}) })),
  };
}

/** What a record of each area IS here (records.areas in the record-area form), for that area's tools. Undefined by default. */
function areaStructure(): McpDeps["structure"] {
  const ids: RecordAreaId[] = ["tasks", "periods", "deployments", "implementations"];
  const said = Object.fromEntries(ids.flatMap((id) => {
    const line = describeStructure(id, undefined, DEPLOYMENT_PROFILE.vocabulary.account.singular);
    return line ? [[id, line]] : [];
  }));
  return Object.keys(said).length ? said : undefined;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * /api/mcp — this deployment's own MCP server (Streamable HTTP, stateless).
 *
 * All of it is lib/mcp-server.ts; this file only supplies the real
 * dependencies. Authentication is the Ops API's own `verifyOpsAuth` — the same
 * bearer the web app sends — and every tool call goes back through the Ops API
 * as the caller. See docs/MCP.md.
 *
 * proxy.ts does not gate this path (its gate covers /api/ops/*): the handler
 * authenticates every request itself, including `initialize`, and each tool
 * call then crosses the proxy gate on its way to the Ops API.
 */
const deps: McpDeps = {
  productName: PRODUCT_NAME,
  verifyAuth: (authorization) => verifyOpsAuth(authorization),
  // dm.md is traced into the function by next.config.ts (outputFileTracingIncludes). It names each domain by a
  // placeholder; a caller reads the folder THIS deployment stores it under, which is what a tool's path takes.
  readSpec: async () => fillFolders(await readFile(join(process.cwd(), "dm.md"), "utf8")),
  folders: FOLDER,
  // The fields this deployment's profile adds to the two record areas and to the account record: the write tools'
  // `custom` input names them.
  customFields: {
    deployments: DEPLOYMENT_PROFILE.domains.deployments.custom_fields,
    implementations: DEPLOYMENT_PROFILE.domains.implementations.custom_fields,
    account: DEPLOYMENT_PROFILE.account_fields.custom_fields,
  },
  // What a period is for this deployment (its profile's work_periods): the period tools follow the mode and the words.
  workPeriods: { mode: WORK_PERIODS.mode, label: WORK_PERIODS.label, itemLabel: WORK_PERIODS.itemLabel },
  // The values the record write tools' choice fields take (stage, risk, environment, health): the schema's enums.
  choices: toolChoices(),
  // What a task is here, when the profile redefines it (records.areas.tasks): the task tools' states, priorities, own fields.
  tasks: taskTools(),
  // What each area IS here, when the profile defines it in the record-area form: appended to that area's tools.
  structure: areaStructure(),
  // An account may hold several implementation records (records.areas.implementations per_account "many"): the
  // implementation tools name each by its own id.
  ...(manyPerAccount() ? { manyImplementations: true } : {}),
  webOrigin: process.env.WEB_ORIGIN?.trim() || null,
  internalOrigin: process.env.MCP_INTERNAL_ORIGIN?.trim() || null,
};

const handle = (request: NextRequest) => handleMcpRequest(request, deps);

export { handle as GET, handle as POST, handle as DELETE };
