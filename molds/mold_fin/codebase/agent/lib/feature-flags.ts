/**
 * Deploy-time capability flags.
 *
 * Some capabilities should be removable per deployment: a customer whose
 * security review forbids outbound browsing, an environment with no Exa key, a
 * demo where the agent must not reach the open internet. This is the switch.
 *
 * HOW IT WORKS. eve auto-discovers `agent/tools/<slug>.ts` and registers the
 * default export. Exporting `disableTool()` instead marks that slug disabled,
 * and — per eve's own docs — "the model never sees it". That is the important
 * property: a tool the model cannot see is not a tool it can be talked into
 * calling, which is not true of a tool that merely refuses at execute() time.
 * The refusal approach also burns context describing a capability that isn't
 * there.
 *
 * DEFAULT ON. An unset variable keeps every capability, so an existing deploy
 * that never sets these behaves exactly as before. Only an explicit "false"
 * (or "0"/"off") turns something off — fail-open is right here because the
 * failure mode is a missing capability, not an open door. Contrast the cron
 * guards, which fail CLOSED, because there the failure mode is an
 * unauthenticated endpoint.
 *
 *   ENABLE_WEB_SEARCH=false   removes web_search
 *   ENABLE_BROWSER=false      removes the browser subagent's 8 tools
 *
 * Set them in Vercel per environment. Because eve normalises tool definitions
 * when the bundle is built, these are read at BUILD time — flipping one needs a
 * rebuild and redeploy, not just an env change. That is the trade for the model
 * never seeing the tool.
 */

/** An explicit falsey string turns a capability off; anything else leaves it on. */
function enabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Web search (Exa) — outbound queries to the open internet. */
export const WEB_SEARCH_ENABLED = enabled("ENABLE_WEB_SEARCH");

/** The browser runtime — a real browser session at a third-party provider. */
export const BROWSER_ENABLED = enabled("ENABLE_BROWSER");
