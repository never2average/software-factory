# .agents

The factory's agent assets for every coding agent. `docs/AGENT_INTEGRATION.md` says which agent reads what.

- `skills/` and `agents/` are the one real copy. `.claude/skills`, `.claude/agents` and `.kiro/skills` are symbolic links to them, so edit here; there is nothing to sync.
- `scripts/`, `workflows/` and `sandboxes/` are still mirrored from `.claude/` by `.agents/scripts/sync.sh`: edit under `.claude/` and run the sync.

The Resend and Cloudflare connectors are enabled for this repository in `.claude/settings.json` (project scope, not a user install). Both plugins ship `.codex-plugin/` and `.cursor-plugin/` manifests of their own, so a non-Claude runtime installs the same two from the same sources: `resend` from the official Anthropic marketplace and `cloudflare` from `github.com/cloudflare/skills`.
