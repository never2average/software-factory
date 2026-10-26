/**
 * The namespace this deployment's sandboxes are named under on the sandbox provider (boat) and on a Docker host's run
 * containers: the first part of every name it gives ("<ns>-orch-…", "<ns>-w-<orchestrator>-<agent>", "<ns>-run-…",
 * "<ns>-orch-img-…", "<ns>-img-build"), so that two deployments sharing one account never touch each other's: each one
 * lists, counts and reaps only what is named with its own. APP_BOAT_NAMESPACE when set, else "app" on a server and
 * "appv" on Vercel (the preview), at most 8 lower-case letters and digits.
 *
 * Until mold_v0-156 the defaults were the first product's short name ("octi" on a server, "octv" on Vercel). A
 * deployment that leaves APP_BOAT_NAMESPACE unset still has, for a while after its update, sandboxes and snapshots
 * named under its old default (orchestrators launched before it and their workers, a run sandbox mid-run, the last
 * snapshot image): LEGACY_BOAT_NAMESPACE is that old default, and everything that lists, counts or reaps its own
 * (src/autoscaler.ts, src/compute.ts, src/run-sandboxes.ts, deploy/boat-orchestrators.ts) takes those as its own too,
 * so none is leaked or counted as another deployment's. Nothing new is named under it. A deployment that sets
 * APP_BOAT_NAMESPACE has no old default (its names did not change). Goes with a later cleanup, once no deployment has
 * sandboxes under the old defaults (orchestrators are recycled on every deploy and live at most 30 days).
 *
 * No imports but the env names: the orchestrator, the run sandboxes' scaler and the server read it alike.
 */
import { ENV } from "./env-names.js";

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8);
const onVercel = () => !!process.env.VERCEL;

/** The namespace when APP_BOAT_NAMESPACE is unset. */
export const defaultBoatNamespace = () => (onVercel() ? "appv" : "app");
/** This deployment's namespace: APP_BOAT_NAMESPACE, else the default. Read when called (tests set the env first). */
export const boatNamespace = () => clean(ENV.APP_BOAT_NAMESPACE ?? "") || defaultBoatNamespace();
/** The default before mold_v0-156, for a deployment that leaves APP_BOAT_NAMESPACE unset; null when it is set. */
export const legacyBoatNamespace = (): string | null => (clean(ENV.APP_BOAT_NAMESPACE ?? "") ? null : onVercel() ? "octv" : "octi");
/** Every namespace whose names are this deployment's: its own, then its old default (until a later cleanup). */
export const boatNamespaces = (): string[] => { const l = legacyBoatNamespace(); return l ? [boatNamespace(), l] : [boatNamespace()]; };
