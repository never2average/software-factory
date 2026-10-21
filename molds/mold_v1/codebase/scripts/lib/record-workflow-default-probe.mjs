#!/usr/bin/env node
/**
 * What THIS checkout's profile offers of a record's workflow surfaces (scripts/test-record-workflow-surfaces.mjs runs it
 * in the checkout, whose default profile binds no workflow): which of the three tools are registered, whether the record
 * tools take `evidence`, and what the ops route answers. Prints one JSON line. Run with --conditions=react-server.
 */
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
const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const t = await import(root("agent/lib/record-workflow-tools.ts"));
const a = await import(root("agent/lib/record-area-tools.ts"));
const d = await import(root("agent/lib/todo-tools.ts"));
const r = await import(root("lib/record-workflow-routes.ts"));
const { NextRequest } = await import("next/server");
const res = await r.getRecordWorkflow(new NextRequest("http://x.test/api/ops/record-workflow?area=deployments&id=1"));
console.log(JSON.stringify({
  tools: [t.getRecordWorkflowTool, t.reassignStepTool, t.extendStepTool].map((x) => x === null),
  evidence: [a.upsertAreaTool("deployments").inputSchema.shape.evidence, d.upsertTodoTool.inputSchema?.shape?.evidence].map((x) => x === undefined),
  route: res.status,
  areas: r.workflowAreas(),
}));
process.exit(0);
