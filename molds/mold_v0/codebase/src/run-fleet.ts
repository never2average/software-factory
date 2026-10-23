/**
 * The compose project's runner service (mold_v0-055; deploy/docker-compose.prod.yml `runner`): on a server of its own,
 * the run sandboxes are local containers, launched and torn down by this loop, the one process that holds the Docker
 * socket (the app does not). It ticks src/run-sandboxes.ts's RunScaler every APP_AUTOSCALE_TICK_SECONDS (15)
 * under the "runs" lease; when the sandbox provider's key is in the vault, it uses that provider instead, as the app's
 * autoscaler would (APP_RUN_SANDBOX=auto). It serves nothing and publishes no port.
 *
 *   npm run runner:fleet
 */
import { getDb } from "./db.js";
import { RunScaler } from "./run-sandboxes.js";
import { ENV } from "./env-names.js";

const tickMs = () => Math.max(1, Number(ENV.APP_AUTOSCALE_TICK_SECONDS ?? 15) || 15) * 1000;
const scaler = new RunScaler({ tickMs, log: (m) => console.error(`runner: ${m}`) });
await getDb();
let timer: NodeJS.Timeout | null = null, stopping = false, last = "";
const loop = async () => {
  try {
    const st = await scaler.tick();
    const line = JSON.stringify({ provider: st.provider, leader: st.leader, launched: st.launched?.length ?? 0, reaped: st.reaped?.length ?? 0, note: st.note ?? null, error: st.error ?? null });
    if (line !== last || st.launched?.length || st.reaped?.length) console.error(`runner: ${line}`);
    last = line;
  } catch (e) { console.error(`runner: tick failed: ${(e as Error).message}`); }
  if (!stopping) timer = setTimeout(loop, tickMs());
};
console.error("runner: run sandboxes (one per queued run) every", tickMs() / 1000, "s");
timer = setTimeout(loop, 1000);
const stop = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  console.error(`runner: ${sig}: stopping (run sandboxes keep running; the next leader tears them down when their runs end)`);
  await scaler.settle();
  await scaler.release();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
