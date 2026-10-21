import { disableTool } from "eve/tools";
import { getRecordWorkflowTool } from "#lib/record-workflow-tools.js";

/**
 * Registered only when a record area's lifecycle runs a workflow (agent/lib/record-workflow-tools.ts): otherwise the
 * model never sees it.
 */
export default getRecordWorkflowTool ?? disableTool();
