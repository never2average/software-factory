// The on-premises runner (src/onprem-runner.ts) as scripts/onprem-runners-test.ts starts it: the real program, with the
// test's fixture pack as its image's packs (a real image has the build's own). Exit code: the runner's.
import { setPacksForTest } from "../../src/packs.js";
import { runnerSettings, startRunner } from "../../src/onprem-runner.js";
import { onpremFixturePack } from "./onprem-pack.js";

setPacksForTest([onpremFixturePack()] as never);
const h = startRunner(runnerSettings());
process.on("SIGTERM", () => void h.stop());
h.done.then((code) => process.exit(code), (e) => { console.error(`runner: failed: ${(e as Error).message}`); process.exit(1); });
