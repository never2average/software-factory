// The fixture pack of scripts/onprem-runners-test.ts (mold_v0-036), shared with the runner it starts
// (scripts/fixtures/onprem-runner-fixture.ts): the runner reports the kinds its image has, and is handed only those.
import path from "node:path";
import { definePack, defineTool, z } from "../../src/pack-api.js";

export const ONPREM_KINDS = [
  { name: "probe", label: "Private probe", runner: "workspace-harness", entry: "ok.mjs", lease_seconds: 15, private_network: true, egress: ["api.allowed.example"] },
  { name: "probe_slow", runner: "workspace-harness", entry: "slow.mjs", lease_seconds: 15, max_attempts: 2, private_network: true },
  { name: "plain", runner: "workspace-harness", entry: "ok.mjs", lease_seconds: 15 },
];

export function onpremFixturePack() {
  const definition = definePack({
    id: "fixture_onprem",
    recordAreas: [
      { name: "run_sources", label: "Sources", role: "source", scope: "platform", fields: [{ name: "body", label: "Body" }] },
      { name: "run_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "run_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    jobKinds: ONPREM_KINDS as never,
    tools: [
      defineTool({ name: "op_start_run", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind, targets }, { runs: r }) => r.start(kind, { targets }) }),
    ],
  });
  return { manifest: { id: "fixture_onprem", name: "Fixture on premises", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(import.meta.dirname, "runs") }, definition };
}
