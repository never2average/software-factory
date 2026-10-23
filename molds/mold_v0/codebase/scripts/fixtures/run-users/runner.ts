// mold_v0-078: a second runner on the same host, in a process of its own (as two runner processes, or two test runs,
// share a machine): claims one run of the kinds it is given over HTTP and carries it out with the harness's defaults.
//   RU_BASE  the API   RU_KINDS  pack/kind,...   RU_PACK_DIR  the fixture pack's directory   (APP_WORKER_TOKEN)
import { httpRunnerClient, runWorkspaceHarness } from "../../../src/run-harness.js";
import { ENV } from "../../../src/env-names.js";

const client = httpRunnerClient(process.env.RU_BASE!, ENV.APP_WORKER_TOKEN!, `ru-second-${process.pid}`);
const claim = await client.claim((process.env.RU_KINDS ?? "").split(",").filter(Boolean));
if (!claim) { console.log(JSON.stringify({ claimed: false })); process.exit(2); }
const view = await runWorkspaceHarness(client, claim, { egress: "off", packDir: () => process.env.RU_PACK_DIR!,
  ...(process.env.RU_RUN_AS ? { runAs: { uid: Number(process.env.RU_RUN_AS), gid: Number(process.env.RU_RUN_AS) } } : {}) });
console.log(JSON.stringify({ claimed: true, run: claim.run.id, status: view?.status ?? null, error: view?.error ?? null }));
process.exit(0);
