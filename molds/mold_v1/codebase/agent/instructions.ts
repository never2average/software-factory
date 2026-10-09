/**
 * The root agent's always-on prompt, rendered once at eve build time from the deployment profile.
 *
 * It was agent/instructions.md: a customer-management persona every deployment read, whatever it was for.
 * agent/lib/root-instructions.ts now assembles it from a neutral core (agent/prompt-core.md) and the
 * base persona (agent/prompt-persona.md), which a profile drops with `persona.base: false` — a pack's
 * agent/instructions/50-pack-*.md then says who the agent is — and speaks it in the profile's words. Under the
 * default profile the markdown is the old instructions.md byte for byte.
 */
import { defineInstructions } from "eve/instructions";
import { renderRootInstructions } from "./lib/root-instructions.ts";

export default defineInstructions({ markdown: renderRootInstructions() });
