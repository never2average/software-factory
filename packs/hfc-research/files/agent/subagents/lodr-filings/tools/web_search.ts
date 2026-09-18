import { disableTool } from "eve/tools";
import { webSearchTool } from "#lib/tools.js";
import { WEB_SEARCH_ENABLED } from "#lib/feature-flags.js";

/**
 * Gated per-subagent as well as at the root. web_search is declared in FOUR
 * places — agent/tools plus three subagents — and gating only the root left
 * research, app-author and customer-context with full web access while the
 * flag read as "off". A capability flag that covers some of the callers is
 * worse than none: it reports a guarantee it does not provide.
 */
export default WEB_SEARCH_ENABLED ? webSearchTool : disableTool();
