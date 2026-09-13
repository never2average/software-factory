# .agents

Runtime-neutral copies of the Claude Code assets in `.claude/`. Same skills, agents, workflows and scripts, kept in sync by `.agents/scripts/sync.sh`; edit under `.claude/` and run the sync. Other agent runtimes (Codex, GLM-based operators inside a stamped app) read from here.

The Resend and Cloudflare connectors are enabled for this repository in `.claude/settings.json` (project scope, not a user install). Both plugins ship `.codex-plugin/` and `.cursor-plugin/` manifests of their own, so a non-Claude runtime installs the same two from the same sources: `resend` from the official Anthropic marketplace and `cloudflare` from `github.com/cloudflare/skills`.
