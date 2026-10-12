/**
 * Registers this process's reader of notes to running specialists (agent/lib/steering.ts) where the eve patch looks for
 * it (harness/steering-notes.js). Imported for its effect by agent/agent.ts, so every process that runs a step of this
 * app has it. The database and the main thread's workspace are resolved per read, never at import.
 */
import { agentGateDb } from "./session-owners.ts";
import { inheritedScope } from "./session-scope.ts";
import { registerSteeringReader } from "./steering.ts";

registerSteeringReader({ db: agentGateDb, scopeOf: (parent) => inheritedScope(parent) });
