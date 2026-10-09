import { defineDynamic } from "eve/tools";
import {
  browserActTool,
  browserCloseTool,
  browserGotoTool,
  browserLoginTool,
  browserOpenTool,
  browserReadTool,
  browserScreenshotTool,
  browserWaitTool,
} from "#lib/browser-tools.js";
import { BROWSER_ENABLED } from "#lib/feature-flags.js";

/**
 * The browser subagent's eight tools, present only when ENABLE_BROWSER is on.
 *
 * These used to be eight static files each exporting `disableTool()` when the
 * flag was off. That sentinel is only for opting out of one of eve's own
 * built-in tool slots (`agent`, `bash`, `web_search`, ...); on an authored tool
 * the Vercel-target build resolves the agent graph and refuses it —
 * `"browser_act" is not a framework tool` — so a deployment with the browser
 * off could not build at all. A dynamic resolver is what eve provides for a
 * tool set that exists conditionally: a map names each tool by its key, so the
 * model sees exactly the same `browser_*` names as before, and `null` means no
 * tools. With none resolved the subagent has nothing to call, and the
 * orchestrator's tool list never advertises a browser it cannot drive — the
 * same outcome the static gate was reaching for.
 */
const BROWSER_TOOLS = {
  browser_open: browserOpenTool,
  browser_goto: browserGotoTool,
  browser_read: browserReadTool,
  browser_screenshot: browserScreenshotTool,
  browser_wait: browserWaitTool,
  browser_act: browserActTool,
  browser_login: browserLoginTool,
  browser_close: browserCloseTool,
};

export default defineDynamic({
  events: {
    "session.started": async () => (BROWSER_ENABLED ? BROWSER_TOOLS : null),
  },
});
