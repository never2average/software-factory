import { disableTool } from "eve/tools";
import { listCyclesTool } from "#lib/todo-tools.js";
import { WORK_PERIODS } from "#lib/work-periods.js";

/**
 * Not registered when the deployment profile turns work periods off (`work_periods.mode: "off"`): the model never
 * sees it, rather than seeing it and being refused at call time. See agent/lib/work-periods.ts.
 */
export default WORK_PERIODS.enabled ? listCyclesTool : disableTool();
