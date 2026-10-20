/**
 * The harnesses that have an install script for boat sandboxes: the file names of orchestrator/images/boat-setup/*.sh
 * (without _common.sh). A worker whose preinstalled CLI is not the pinned version installs the pin with that script;
 * a harness without one runs only if boat's preinstalled CLI already matches. A constant rather than a directory read
 * so it works on Vercel, which does not ship orchestrator/images; the smoke test asserts it matches the directory.
 */
export const BOAT_SETUP_HARNESSES: readonly string[] = [
  "amp", "antigravity", "claude-code", "cline", "codex", "copilot", "cursor", "droid", "gemini-cli", "kilo", "opencode", "pi", "qwen-code",
];
