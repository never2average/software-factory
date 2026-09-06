import { disableTool } from "eve/tools";
import { browserCloseTool } from "#lib/browser-tools.js";
import { BROWSER_ENABLED } from "#lib/feature-flags.js";

/**
 * Removed when ENABLE_BROWSER=false. Gating each tool (rather than the
 * subagent) is what eve supports: with all eight gone the browser subagent has
 * nothing to call, and the orchestrator's own tool list never advertises a
 * browser it cannot drive.
 */
export default BROWSER_ENABLED ? browserCloseTool : disableTool();
