import { disableTool } from "eve/tools";
import { webSearchTool } from "#lib/tools.js";
import { WEB_SEARCH_ENABLED } from "#lib/feature-flags.js";

/**
 * Removed entirely when ENABLE_WEB_SEARCH=false — the model never sees it,
 * rather than seeing it and being refused at call time. See lib/feature-flags.
 */
export default WEB_SEARCH_ENABLED ? webSearchTool : disableTool();
