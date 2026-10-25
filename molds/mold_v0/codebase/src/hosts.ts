/**
 * Registers the build's host packs (mold_v0-039; src/host.ts) from the generated list (scripts/gen-packs.mjs writes
 * src/hosts.generated.ts). A process's entry module imports this file first (src/http.ts, src/stdio.ts, api/index.ts,
 * the scripts that need the product), so every host pack is registered before anything is served; nothing else in the
 * shell imports it, so a pack's code is never part of a shell module's own imports. Zero packs: nothing registers.
 */
import { registerHosts, type HostDefinition } from "./host.js";
import * as generated from "./hosts.generated.js";

// Their pack.json engine.config (mold_v0-137), which a build writes only when a host pack declares one.
const { HOSTS, HOST_ENGINE_CONFIG } = generated as typeof generated & { HOST_ENGINE_CONFIG?: Readonly<Record<string, unknown>> };
registerHosts(HOSTS as readonly HostDefinition[], HOST_ENGINE_CONFIG ?? {});
