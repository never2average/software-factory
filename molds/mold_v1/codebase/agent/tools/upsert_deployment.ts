import { disableTool } from "eve/tools";
import { upsertDeploymentTool } from "#lib/record-area-tools.js";

/**
 * Registered only when the deployment's definition of the area turns it on (`records.areas.deployments.agent.tools.write`;
 * agent/lib/record-area-tools.ts): otherwise the model never sees it.
 */
export default upsertDeploymentTool ?? disableTool();
