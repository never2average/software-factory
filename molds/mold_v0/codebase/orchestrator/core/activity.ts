/**
 * Idle tracking for on-demand orchestrators: the claim and research loops call markBusy() whenever they hold or
 * claim work. After APP_ORCH_IDLE_MINUTES (default 10; 0 = never) without any, the orchestrator sends itself
 * SIGTERM: the normal graceful path kills nothing (it is idle), leaves the fleet (the server then marks its sandbox
 * `draining` and the autoscaler deletes it) and exits 0, which systemd (Restart=on-failure) does not restart.
 */
import { env, num } from "./config.js";
import { log } from "./util.js";

let lastBusy = Date.now();
let busySources = 0;

export function markBusy() { lastBusy = Date.now(); }
export function holdBusy() { busySources++; markBusy(); return () => { busySources = Math.max(0, busySources - 1); markBusy(); }; }
export const idleMs = () => (busySources > 0 ? 0 : Date.now() - lastBusy);
export const IDLE_MINUTES = num(env.APP_ORCH_IDLE_MINUTES, 10);

let watcher: NodeJS.Timeout | null = null;
export function startIdleWatcher(minutes = IDLE_MINUTES, onIdle: () => void = () => process.kill(process.pid, "SIGTERM")) {
  if (!(minutes > 0) || watcher) return;
  watcher = setInterval(() => {
    if (idleMs() >= minutes * 60_000) {
      log(`idle for ${minutes} min with no claimable work: draining and exiting (on-demand orchestrator)`);
      if (watcher) clearInterval(watcher);
      watcher = null;
      onIdle();
    }
  }, Math.min(30_000, Math.max(1000, minutes * 60_000 / 10)));
  watcher.unref();
}
