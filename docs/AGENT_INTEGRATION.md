# Running the factory from your coding agent

The factory has one set of instructions, [`AGENTS.md`](../AGENTS.md), and one set of skills, `.agents/skills/<name>/SKILL.md`. The factory supports terminal (CLI) coding agents: the ones you run in a terminal and can run unattended. This page says, for each of the 20 most-used ones, what it reads, how it is allowed to run the factory's scripts, how to run it unattended, how the person types a secret, and what can't work.

Facts were checked on **2026-10-09** against each tool's own documentation (sources at the end). "U" means unverified: no source confirmed it, so nothing in the repository relies on it. "Tested" means it was run on the factory machine on that date.

## Files in this repository, and who they are for

| File | For | What it does |
|---|---|---|
| `AGENTS.md` | almost every agent | the instructions: start here, the request-to-skill map, the script protocol, secrets, what needs a yes |
| `AGENTS.local.md` | every agent, when present | this machine's and operator's own rules; git-ignored, never committed |
| `CLAUDE.md` | Claude Code | imports `AGENTS.md` and `AGENTS.local.md`, plus Claude-specific notes |
| `.gemini/settings.json` | Gemini CLI | `context.fileName: ["AGENTS.md"]` (Gemini reads only `GEMINI.md` otherwise), and `tools.allowed` for the read-only factory commands |
| `.aider.conf.yml` | Aider | `read: AGENTS.md` |
| `.agents/skills/` | the real skills folder | read natively by most agents |
| `.claude/skills`, `.claude/agents` | Claude Code, Cline, others | symbolic links to `.agents/skills` and `.agents/agents` |
| `.kiro/skills` | Kiro | symbolic link to `.agents/skills` |
| `.claude/settings.json` | Claude Code | allow and ask rules for the factory's commands |
| `.codex/rules/factory.rules` | Codex CLI | `prefix_rule` allow and prompt rules |
| `.cursor/cli.json` | Cursor CLI | `Shell(...)` allow rules |
| `.qwen/settings.json` | Qwen Code | allow and ask rules |
| `.devin/config.json` | Devin CLI | `Exec(...)` allow and ask rules |
| `opencode.json`, `kilo.jsonc` | OpenCode, Kilo CLI | `permission.bash` ask rules |

Deliberately **not** added: `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `AGENT.md`, `.github/copilot-instructions.md` and `GEMINI.md`. Every agent that reads them already reads `AGENTS.md`, and Zed uses only the *first* instruction file it finds from a list in which all of those come before `AGENTS.md`; adding any one would make Zed ignore `AGENTS.md`. A `GEMINI.md` would also be read (and its import expanded) by Copilot CLI and Antigravity, giving them a second copy.

Symbolic links need `core.symlinks` on Windows checkouts; the factory runs on Linux.

## The agents

Columns:

- **Reads:** the instruction file it loads from this repository.
- **Skills:** whether it loads `.agents/skills` (directly or through a link).
- **Permissions in the repo:** the project-level file this repository ships, or why there is none.
- **Headless:** the unattended command, with its JSON output flag.
- **Secrets:** how the person types a key. The rule for every agent is the same: the person runs `python3 .claude/scripts/provision.py <app_id> --set-secret NAME` in a **separate terminal** on the factory machine (a second SSH session). The column notes the few tools with a private in-session shell, and the ones whose in-session shell must not be used because its output enters the conversation.
- **Can't:** what does not work.

| # | Agent | Reads | Skills | Permissions in the repo | Headless | Secrets | Can't |
|---|---|---|---|---|---|---|---|
| 1 | Claude Code | `CLAUDE.md` → `@AGENTS.md` (AGENTS.md alone only when no CLAUDE.md exists, v2.1.277+) | Yes, via `.claude/skills` link (it does not read `.agents/skills` itself). **Tested** 2.1.295: 11 skills, 5 subagents | `.claude/settings.json` allow + ask (deny → ask → allow). Project allow rules are ignored until the folder is trusted (**tested**) | `claude -p "<prompt>" --output-format json --max-turns N --max-budget-usd X`. Not `--bare` (skips CLAUDE.md and skills) | `!` output enters context: separate terminal | — |
| 2 | Codex CLI | `AGENTS.md`, root down to the working directory | Yes, `.agents/skills` natively | `.codex/rules/factory.rules`, read only when the project is trusted. Rules are fixed prefixes, so per-app commands can't be listed | `codex exec "<prompt>" --json --sandbox workspace-write`; no turn cap, wrap in `timeout` | `!` output is recorded as a user message: separate terminal | — |
| 3 | GitHub Copilot CLI | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` merged, with `@` imports (so it sees AGENTS.md twice) | Yes | None: approvals are per-user (`~/.copilot/permissions-config.json`, allow only) or flags. `.github/copilot/settings.json` exists, contents U | `copilot -p "<prompt>" --output-format json --allow-tool='shell(python3:*)' --no-ask-user` | A lone `$` hands over a real shell; that its output stays out of context is U | Needs a Copilot plan |
| 4 | Cursor CLI (`agent`) | `AGENTS.md` (root and nested), root `CLAUDE.md` | Yes | `.cursor/cli.json` allow (`Shell(python3:<args>*)`). No ask level, so nothing risky is listed; args-glob matching beyond the docs' example is U | `agent -p "<prompt>" --output-format json --force --trust`; no cap, wrap in `timeout` | Shell mode has a 30 s limit and no interactive input: separate terminal | — |
| 5 | Gemini CLI | `AGENTS.md` via `.gemini/settings.json` | Yes, `.agents/skills` | `.gemini/settings.json` `tools.allowed` (legacy, prefix match) for the fixed read-only commands. Project policy files don't work (issue #18186); headless "ask" = deny | `gemini -p "<prompt>" -o json`; cap `model.maxSessionTurns` (exit 53) | `!` output enters context: separate terminal | Headless per-app commands (`mint.py <app> --json`) are denied unless `--approval-mode=yolo` or a user policy (below). Whether the folder must be trusted first is U |
| 6 | OpenCode | `AGENTS.md` (CLAUDE.md only as fallback); `@` not followed | Yes | `opencode.json` `permission.bash` ask rules (last match wins). `--auto` approves asks | `opencode run "<prompt>" --format json --auto` | `!` output enters context: separate terminal | Under `--auto` the ask rules don't stop a deploy: don't use `--auto` outside a throwaway copy |
| 7 | Google Antigravity (`agy`) | `AGENTS.md` (**tested** `agy` 1.2.12: read it, named `factory.py doctor` as the first command) | Yes: **tested**, listed all 11 skills (`.agents/skills` is in the binary) | None in the repo: permissions are user-level (`~/.gemini/antigravity-cli/settings.json`). Unallowed tools are soft-denied headless (run continues, exit 0) | `agy -p "<prompt>" --output-format json --print-timeout 15m` | `!` behaviour U: separate terminal | — |
| 8 | Pi | `AGENTS.md`, `CLAUDE.md` | Yes | None: Pi does not ask before tool calls (only folder trust and tool lists); run it in a sandbox | `pi -p "<prompt>"` / `pi --mode json` | **`!!` runs a command without sending output to the model** | No ask-before-deploy gate except AGENTS.md itself |
| 9 | Cline | `AGENTS.md` | Yes, via `.claude/skills` link (it doesn't read `.agents/skills`) | None possible: no user-editable command list | `cline --json -t <seconds> "<task>"`; **auto-approves by default** | No user shell: separate terminal | No per-command gate |
| 10 | Devin CLI (ex-Windsurf) | `AGENTS.md` (Desktop: any directory) | Yes | `.devin/config.json` `Exec(...)` allow + ask; anything unmatched prompts | `devin -p "<prompt>"`; no JSON output, no cap | `!` bash mode, context U: separate terminal | Desktop has no headless mode |
| 11 | Kilo Code (`kilo` CLI) | `AGENTS.md` | Yes | `kilo.jsonc` `permission.bash` ask rules (same as OpenCode) | `kilo run --auto --format json "<task>"`; without `--auto` asks are rejected | Shell ignores stdin and output enters context: separate terminal | Same `--auto` caveat as OpenCode |
| 12 | Amp | `AGENTS.md` (`@` followed) | Yes | None: gating is a code plugin (`.amp/plugins/`); none shipped | `amp -x "<prompt>" --stream-json` | **`$$` keeps output out of context** (from a news post, U in the manual) | Doesn't ask before tools by default |
| 13 | Factory Droid | `AGENTS.md` | Yes | None shipped: research disagrees on the project file (`.factory/settings.json` vs `settings.local.json`), U | `droid exec "<prompt>" --auto high -o json` | `!` bash mode, context U: separate terminal | Paid plan |
| 14 | Warp (`oz`) | `AGENTS.md` | Yes | None: profiles live in the user's `settings.toml` | `oz agent run --prompt "<prompt>"`; JSON U | `!` passes keystrokes through; context U | — |
| 15 | Goose | `AGENTS.md` (`@` inlined) | Yes; also reads `.agents/agents` | None possible: permissions are per tool, not per command | `goose run -t "<prompt>" --no-session --output-format json --max-turns N` | No shell mode: separate terminal | No per-command gate; default mode `auto` |
| 16 | Qwen Code | `AGENTS.md` (+ `QWEN.md`) | Yes | `.qwen/settings.json` allow (fixed prefixes) + ask. Whether `*` matches mid-pattern is U, so allows never rely on it | `qwen -p "<prompt>" --output-format json --max-session-turns N --max-wall-time 10m` | `!` output enters context: separate terminal | Free OAuth tier ended 2026-04-15: needs an API key |
| 17 | OpenHands | `AGENTS.md` (root) | Yes | None: no per-command list; **headless always approves** | `openhands --headless -t "<task>" --json` | None documented: separate terminal | No gate when headless |
| 18 | JetBrains Junie CLI | `AGENTS.md` | Yes | None in the repo: allowlist is user-level (`~/.junie/allowlist.json`) | `junie "<task>" --output-format json` | `!`, context U: separate terminal | Junie scans `.agents/` for subagents; whether it mistakes `.agents/README.md` for one is U |
| 19 | AWS Kiro CLI | `AGENTS.md` (+ `.kiro/steering`) | Via `.kiro/skills` link (`.agents/skills` not documented) | None in the repo: `permissions.yaml` lives under `~/.kiro/` | `kiro-cli chat --no-interactive --trust-all-tools --output-format stream-json --v3 "<prompt>"` | `!` gets a full terminal; context U for the current CLI | Paid plan for API-key sign-in; headless "ask" = deny |
| 20 | Augment (Auggie) | `AGENTS.md`, `CLAUDE.md` | Yes | None shipped: `.augment/settings.json` `toolPermissions` exists, but the docs' shell tool name differs between examples (`terminal` vs `launch-process`), U | `auggie --print "<task>" --output-format json --max-turns N` | None documented: separate terminal | Paid plan |
| — | Aider (dormant since 2025-08) | `AGENTS.md` via `.aider.conf.yml` | No | None: it asks per shell command | `aider --message "<task>"`; `--yes-always` answers **no** to running shell commands | `/run` the command and answer **No** to adding output | Can't run the scripts unattended |

Left out: editor-only and cloud-only agents (Zed's agent, Copilot in VS Code and its cloud agent, Google Jules): the factory supports terminal (CLI) agents only. Also left out: Roo Code (shut down 2026-05), Continue (read-only repo), TRAE (no headless CLI), Replit Agent (hosted, not run against a repository).

## Permission rules: what they say

Every file above follows the same split as `AGENTS.md` ("What needs an explicit yes"):

- **Allowed without asking:** `factory.py doctor|status|tasks|next|validate` and `mint.py list` everywhere. In `.claude/settings.json` also `mint.py <app> …` (except the asks below), `provision.py <app> --json|status|--capacity|--dry-run`, `lanes.py <app> --list|--dry-run|status`, `repo.py <app> status`, `mold.py check|fetch`, the read-only `packs.py`, `branding.py`, `domain.py`, `agent_cli.py`, `library.py`, `clone.py plan`, `app_usage.py` and `mint_report.py` commands.
- **Ask first:** `mint.py <app> run|reuse-keys|code-request|code`, `provision.py <app> --deploy*|--set-secret|--verify-db|--verify-rls|--apply|--tunnel-remote`, `repo.py publish|push|unlink|auto-push`, `domain.py attach|switch`, `agent_cli.py publish`, `library.py --apply`, `clone.py run|snapshot|configure`, `workspace.py`, `mold.py refresh`, `git push --force|-f|+refspec`, `npm publish`, `gh repo create|delete`, `vercel` production deploys and removals.
- Where a tool only matches a fixed command prefix (Codex, Gemini, Devin, Cursor), per-app commands can't be expressed (the app id comes second), so only the fixed ones are listed and `AGENTS.md` carries the rest.
- An ask rule that a tool can't match does nothing, so ask rules may use inner wildcards; an allow rule that over-matches would be unsafe, so allow rules never rely on unverified matching.
- `provision.py <app> --deploy-remote --dry-run` and `repo.py <app> publish --dry-run` match an ask rule too, so they ask even though they change nothing.

### User-level rules for agents that can't take them from the repository

Put these in your own home folder if you use these agents headless. They are examples in each tool's documented format; adjust the paths.

Gemini CLI, `~/.gemini/policies/factory.toml` (headless "ask" means deny, so per-app reads need an allow; the higher-priority rule keeps the steps that deploy or email someone behind a question; `argsPattern` is a regular expression over the command's arguments, so try it on a throwaway copy first):

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = "python3 .claude/scripts/mint.py"
decision = "allow"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = "python3 .claude/scripts/mint.py"
argsPattern = "mint\\.py \\S+ (run|reuse-keys|code-request|code)\\b"
decision = "ask_user"
priority = 200
```

Kiro CLI, `~/.kiro/settings/permissions.yaml`:

```yaml
rules:
  - capability: shell
    match: ["python3 .claude/scripts/factory.py *", "python3 .claude/scripts/mint.py list*"]
    effect: allow
```

Junie CLI, `~/.junie/allowlist.json`: `{"rules":{"executables":[{"prefix":"python3 .claude/scripts/factory.py","action":"allow"}]}}`.

Antigravity: `permissions.allow` entries such as `"command(python3 .claude/scripts/factory.py)"` in `~/.gemini/antigravity-cli/settings.json`.

## Secrets, for every agent

No in-session shortcut is safe in every tool, so the factory relies on one path that is:

1. The agent names the missing key and gives the person the exact line: `python3 .claude/scripts/provision.py <app_id> --set-secret NAME`.
2. The person runs it **in a second terminal** on the factory machine. It asks at a hidden prompt, sends the value straight to Vercel or the server, and prints only the name.
3. The person tells the agent it is done; the agent re-runs the check.

Private in-session shells, as conveniences only: Amp `$$`, Pi `!!`, Aider `/run` answering **No** to "Add output to the chat?", and (U) Copilot CLI's lone `$`. Never Claude Code, Codex, Gemini, Qwen, OpenCode or Kilo `!`: their output enters the conversation.

## Verified on the factory machine (2026-10-09)

- **Claude Code 2.1.295:** skills and subagents load through the `.claude/skills` and `.claude/agents` links (all 11 skills and 5 subagents listed). Inner-wildcard ask rules (`Bash(x * y*)`) override a matching allow. Project allow rules are ignored in a folder that has not been trusted. In a fresh shallow clone, `claude -p` read `AGENTS.md` and named `factory.py doctor` as the first command.
- **Antigravity `agy` 1.2.12:** read `AGENTS.md` and listed all 11 skills.
- No other agent's CLI was installed; their rows come from documentation only. The benchmark harness (`benchmarks/`) has adapters for several of them; a result there is the test.

## Sources (all checked 2026-10-09)

Survey and usage: JetBrains Developer Ecosystem Survey 2026 (https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/); Amplifying.ai index, snapshot 2026-10-05 (https://s.amplifying.ai/research/state-of-coding-agents); npm, GitHub and VS Code Marketplace counts pulled 2026-10-09.

- Claude Code: https://code.claude.com/docs/en/memory, /skills, /permissions, /headless, /interactive-mode
- Codex: https://learn.chatgpt.com/docs/agent-configuration/agents-md, /build-skills, /agent-configuration/rules.md, /non-interactive-mode.md
- Copilot: https://docs.github.com/en/copilot/reference/custom-instructions-support, https://docs.github.com/en/copilot/concepts/agents/about-agent-skills, https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically, https://code.visualstudio.com/docs/agents/run/approvals
- Cursor: https://cursor.com/docs/rules.md, /skills.md, /cli/reference/permissions.md, /cli/headless.md
- Gemini CLI: https://geminicli.com/docs/cli/gemini-md.md, /reference/policy-engine.md, /cli/headless.md
- OpenCode: https://opencode.ai/docs/rules/, /permissions/
- Antigravity: https://antigravity.google/docs/rules?tab=ide, /docs/cli/headless, /docs/cli/install/
- Pi: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/ (cli.md, skills.md, usage.md)
- Cline: https://docs.cline.bot/features/cline-rules, /features/auto-approve.md, /cli/cli-reference.md
- Devin: https://docs.devin.ai/cli/extensibility/rules.md, /cli/reference/permissions.md
- Kilo: https://kilo.ai/docs/customize/agents-md, https://kilo.ai/docs/cli
- Amp: https://ampcode.com/docs/customize/agents-md, /customize/skills, /cli/streaming-json, https://ampcode.com/news/through-the-agent-into-the-shell
- Droid: https://docs.factory.com/cli/configuration/agents-md, /cli/droid-exec/overview
- Warp: https://docs.warp.dev/knowledge-and-collaboration/rules, https://docs.warp.dev/_llms-txt/warp-agent-cli.txt
- Goose: https://goose-docs.ai/docs/guides/context-engineering/using-goosehints, /guides/managing-tools/goose-permissions
- Qwen Code: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- OpenHands: https://docs.openhands.dev/overview/skills, /openhands/usage/cli/headless
- Junie: https://junie.jetbrains.com/docs/guidelines-and-memory.html, /action-allowlist-junie-cli.html, /junie-headless.html
- Kiro: https://kiro.dev/docs/steering/, /docs/permissions/, /docs/cli/headless/
- Jules: https://jules.google/docs, https://developers.google.com/jules/api
- Augment: https://docs.augmentcode.com/cli/rules, /cli/permissions
- Zed: https://zed.dev/docs/ai/instructions.md
- Aider: https://aider.chat/docs/scripting.html; `--yes-always` behaviour from source (aider/io.py, aider/coders/base_coder.py)
