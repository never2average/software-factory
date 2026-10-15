import { disableTool } from "eve/tools";
import { listImplementationsTool } from "#lib/record-area-tools.js";

/**
 * Registered only when the deployment's definition of the area turns it on (`records.areas.implementations.agent.tools.read`;
 * agent/lib/record-area-tools.ts): otherwise the model never sees it.
 */
export default listImplementationsTool ?? disableTool();
