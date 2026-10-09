import { disableTool } from "eve/tools";
import { VISION_ENABLED } from "#lib/feature-flags.js";
import { readImageTool } from "#lib/vision-tools.js";

/**
 * Removed entirely when ENABLE_VISION=false, or when no vision model is named
 * (CLOUDFLARE_MODEL_VISION=off) — the model never sees it, rather than seeing it
 * and being refused at call time. A deployment on an account without a vision
 * model must not advertise one. See lib/feature-flags and lib/model.
 */
export default VISION_ENABLED ? readImageTool : disableTool();
