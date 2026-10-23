/**
 * Imported first by src/hosts.generated.ts when the build has a host pack (scripts/gen-packs.mjs), so it runs before any
 * host pack's module: a host pack written before mold_v0-045 may read the shell's environment names under their old
 * spelling, so every APP_ name is also set under that spelling, to the same value (src/env-names.ts
 * exposeLegacyNames). A build with no host pack never imports this file.
 */
import { exposeLegacyNames } from "./env-names.js";

exposeLegacyNames(process.env);
