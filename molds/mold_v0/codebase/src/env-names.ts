/**
 * The shell's environment variable names: APP_ for every name, the old prefix still read as a fallback (mold_v0-045).
 * The code is orchestrator/core/env-names.ts (the orchestrator and the run sandbox runner carry it); this is its name
 * for the server's own modules.
 */
export { appEnv, currentEnvName, ENV, ENV_PREFIX, envLog, exposeLegacyNames, isShellEnvName, LEGACY_ENV_PREFIX, legacyEnvName, persistedKey, readEnv } from "../orchestrator/core/env-names.js";
