# CLAUDE.md

@AGENTS.md

@AGENTS.local.md

Claude Code notes (everything else is in AGENTS.md; `AGENTS.local.md` is imported when the machine has one):

- Skills load from `.claude/skills`, a link to `.agents/skills`. Subagents (`intake`, `provisioner`, `lane-tester`, `mold-engineer`, `product-packager`) load from `.claude/agents`, a link to `.agents/agents`. Edit them under `.agents/`.
- `/factory` opens the factory board (the `factory-board` plugin, turned on in `.claude/settings.json`): products, apps, tickets and usage.
- `.claude/settings.json` allows the read-only and dry-run factory commands and asks before deploys, `--set-secret`, repository publish and push, force-push, publishing, cleanups with `--apply`, and domain switches. Project allow rules apply only after the folder is trusted (run `claude` here once and accept). Don't widen them with `--dangerously-skip-permissions` outside a throwaway copy.
- `!` commands put their output into this conversation, so the operator types secrets in a separate terminal, never through `!`.
