# Running the factory from your coding agent

The factory has one set of instructions, [`AGENTS.md`](../AGENTS.md), and one set of skills, `.agents/skills/<name>/SKILL.md`. It supports terminal (CLI) coding agents: the ones you run in a terminal and can run unattended. For each of the 20 agents in the README, this page says:

- what it reads;
- how it reaches the skills;
- how it is allowed to run the factory's scripts;
- how it runs unattended, and its benchmark adapter;
- how the person types a secret;
- what can't work.

Every fact was checked on **2026-10-09** against the agent's own current documentation (the vendor's docs site or its own repository); the source for each row is in its last column and in "Sources" at the end. "U" means unverified: the docs don't show it, so nothing in the repository relies on it. "Tested" means it was run on the factory machine that day. No agent was installed for this page: apart from Claude Code and Antigravity (below), every row is documentation only.

## Files in this repository, and who they are for

| File | For | What it does |
|---|---|---|
| `AGENTS.md` | every agent | the instructions: start here, the request-to-skill map, the script protocol, secrets, what needs a yes |
| `AGENTS.local.md` | every agent, when present | this machine's and operator's own rules; git-ignored, never committed |
| `CLAUDE.md` | Claude Code | imports `AGENTS.md` and `AGENTS.local.md`, plus Claude-specific notes |
| `.gemini/settings.json` | Gemini CLI | `context.fileName: ["AGENTS.md"]` (Gemini reads only `GEMINI.md` otherwise), and `tools.allowed` for the read-only factory commands |
| `.aider.conf.yml` | Aider | `read: AGENTS.md` |
| `.agents/skills/` | the real skills folder | read natively by 18 of the 20 agents (not Claude Code or Kiro) |
| `.claude/skills`, `.claude/agents` | Claude Code, Cline | symbolic links to `.agents/skills` and `.agents/agents` |
| `.kiro/skills` | Kiro CLI | symbolic link to `.agents/skills` |
| `.claude/settings.json` | Claude Code | allow and ask rules for the factory's commands (the reference split) |
| `.codex/rules/factory.rules` | Codex CLI | `prefix_rule` allow and prompt rules |
| `.cursor/cli.json` | Cursor CLI | `Shell(...)` allow rules |
| `.qwen/settings.json` | Qwen Code | allow and ask rules |
| `.devin/config.json` | Devin CLI | `Exec(...)` allow and ask rules |
| `opencode.json` | OpenCode | `permission.bash`: everything asks, exact read-only commands allowed, risky ones ask |
| `kilo.jsonc` | Kilo CLI | `permission.bash`: the same allow and ask split as `.claude/settings.json` |
| `.factory/settings.json` | Droid | `permissionRules` (version 1): token-prefix allow and ask rules, each with its own tests |
| `.augment/settings.json` | Auggie | `toolPermissions`: anchored regular expressions that allow the read-only commands |
| `.kiro/agents/factory.json` | Kiro CLI | a custom agent (`kiro-cli chat --agent factory`) with `permissions.rules` mirroring `.claude/settings.json` |

Deliberately **not** added:

- `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `AGENT.md`, `.github/copilot-instructions.md` and `GEMINI.md`. Every agent that reads them already reads `AGENTS.md`. Zed uses only the *first* instruction file it finds from a list in which all of those come before `AGENTS.md`, so adding any one would make Zed ignore `AGENTS.md`. A `GEMINI.md` would also be read by Copilot CLI, Antigravity and OpenHands, giving them a second copy.
- `.junie/AGENTS.md`: Junie uses it *instead of* the root `AGENTS.md` ("used exclusively").
- `AGENTS.override.md`: Codex and Pi use it in place of `AGENTS.md`.
- Hook scripts and plugins as permission gates (`.github/hooks/`, `.openhands/hooks.json`, `.cline/hooks/`, `.agents/plugins/*/hooks/` for Goose, `.amp/plugins/`, `.pi/extensions/`). Their formats are documented, but each one is code that runs on every tool call, can't be tested without the agent, and most can only block, not ask. An untested blocking script is a worse gate than none. See "What can't be gated" below.

Symbolic links need `core.symlinks` on Windows checkouts; the factory runs on Linux.

## The agents

Columns:

- **Instructions:** the instruction file it loads from this repository.
- **Skills:** whether it loads `.agents/skills` (directly or through a link).
- **Permissions:** the project file this repository ships, a user-level snippet (below), or why neither exists.
- **Benchmark adapter:** the name in `benchmarks/run.py` and its documented headless command. Every adapter except `claude` is **from docs, not yet run**. The harness also stops every run at the task's time cap (an outside `timeout`), so agents without a cap of their own are capped too.
- **Secrets:** how the person types a key. The rule for every agent is the same: the person runs `python3 .claude/scripts/provision.py <app_id> --set-secret NAME` in a **separate terminal** on the factory machine (a second SSH session). The column notes the few tools with a private in-session shell, and the ones whose in-session shell must not be used because its output enters the conversation.
- **Can't:** what does not work.
- **Source:** the main page checked on 2026-10-09.

| # | Agent | Instructions | Skills | Permissions | Benchmark adapter (auth) | Secrets | Can't | Source |
|---|---|---|---|---|---|---|---|---|
| 1 | Claude Code | `CLAUDE.md` → `@AGENTS.md` (AGENTS.md alone only when no CLAUDE.md exists, v2.1.277+) | Via `.claude/skills` link (it does not read `.agents/skills`). **Tested** 2.1.295: 11 skills, 5 subagents | **File:** `.claude/settings.json` allow + ask (deny → ask → allow). Project allow rules are ignored until the folder is trusted (**tested**) | `claude`: `claude -p … --output-format stream-json --max-turns N --max-budget-usd X` (`ANTHROPIC_API_KEY` or a signed-in session). **Run:** 8/8 in 3 of 3 rounds. Not `--bare` (skips CLAUDE.md and skills) | `!` output enters context: separate terminal | — | code.claude.com/docs/en/headless |
| 2 | Codex CLI | `AGENTS.md`, root down to the working directory | Yes, natively | **File:** `.codex/rules/factory.rules`, read only when the project's `.codex/` layer is trusted. Prefix rules, so per-app commands can't be listed; when several match, the most restrictive wins | `codex`: `codex exec --json --sandbox workspace-write` (`CODEX_API_KEY` or `~/.codex/auth.json`). `--full-auto` is deprecated; no turn cap | `!` output is recorded as a user message: separate terminal | — | learn.chatgpt.com/docs/non-interactive-mode |
| 3 | GitHub Copilot CLI | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` merged, with `@` imports (so it sees AGENTS.md twice) | Yes (`.github/skills` > `.agents/skills` > `.claude/skills`) | **None possible in the repo.** `.github/copilot/settings.json` accepts only a fixed key list with no permission keys ("any other keys … are silently ignored"). Per-command rules exist only as run flags (`--allow-tool`, `--deny-tool`; deny wins) or in the allow-only, user-level `~/.copilot/permissions-config.json`. Snippet below | `copilot`: `copilot -p … --output-format json --allow-all-tools --no-ask-user` (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`). The docs call `--allow-all-tools` required for programmatic runs | A lone `$` hands over a real shell; that its output stays out of context is U | Needs a Copilot plan | docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference |
| 4 | Cursor CLI (`agent`) | `AGENTS.md` (root and nested), root `CLAUDE.md` | Yes | **File:** `.cursor/cli.json` allow (`Shell(python3:<args>*)`). Only allow and deny exist, no ask, so nothing risky is listed; how far `command:args` globs match beyond the docs' `curl:*` example is U | `cursor`: `agent -p … --output-format json --force --trust` (`CURSOR_API_KEY`). The binary is `agent`; `cursor-agent` is no longer in the docs. No cap | Shell mode has a 30 s limit and no interactive input: separate terminal | — | cursor.com/docs/cli/headless |
| 5 | Gemini CLI | `AGENTS.md` via `.gemini/settings.json` (loaded only in a trusted folder) | Yes | **File:** `.gemini/settings.json` `tools.allowed` (legacy, prefix match) for the fixed read-only commands. Project policy files don't work (issue #18186); headless "ask" = deny. Snippet below for per-app reads | `gemini`: `gemini -p … --output-format json --approval-mode=yolo --skip-trust` (`GEMINI_API_KEY`). `--yolo` is deprecated. Cap: `model.maxSessionTurns` (exit 53), a setting, not a flag | `!` output enters context: separate terminal | Free tier moved to Antigravity CLI on 2026-06-18: needs an API key. In an untrusted folder it skips `.gemini/settings.json`, and with it `AGENTS.md`: trust the folder or pass `--skip-trust` | geminicli.com/docs/cli/headless |
| 6 | OpenCode | `AGENTS.md` (CLAUDE.md only as fallback); `@` not followed | Yes | **File:** `opencode.json` `permission.bash`, last match wins: `"*": "ask"`, then exact read-only commands allowed (the docs don't say how compound commands are split, so no wildcard allows), then the risky ones ask | `opencode`: `opencode run --format json --auto` (provider keys or `~/.local/share/opencode/auth.json`). Cap: `agent.<name>.steps` | `!` output enters context: separate terminal | `--auto` approves every ask rule: don't use it outside a throwaway copy | opencode.ai/docs/permissions |
| 7 | Antigravity (`agy`) | `AGENTS.md` (**tested** `agy` 1.2.12: read it, named `factory.py doctor` as the first command) | Yes: `.agents/skills` is its default (**tested**, listed all 11) | **User-level only:** `permissions` allow/ask/deny in `~/.gemini/antigravity-cli/settings.json`. Its project scope is stored in `~/.gemini/config/projects/`, outside the repo; no checked-in file is documented. Snippet below | `antigravity`: `agy -p … --output-format json --print-timeout Nm --dangerously-skip-permissions` (`GEMINI_API_KEY` plus `"modelProvider": "gemini"`, or a cached sign-in). Shell commands not allowed are soft-denied headless (run continues, exit 0) | `!` runs a command; whether output enters context is U: separate terminal | — | antigravity.google/docs/permissions |
| 8 | Pi | `AGENTS.md`, `CLAUDE.md` (no project trust needed) | Yes (project `.agents/skills` needs project trust: `--approve` headless) | **None possible:** "it does not ask for approval before every tool call". No permission settings exist; only tool lists (`--tools`) and a code extension (`tool_call` can block) | `pi`: `pi --mode json --approve` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … or `~/.pi/agent/auth.json`). No cap | **`!!` runs a command without sending its output to the model** | No ask-before-deploy gate except `AGENTS.md` itself | github.com/earendil-works/pi (packages/coding-agent/docs) |
| 9 | Cline | `AGENTS.md` | Yes: `.agents/skills` on its Config page, `.claude/skills` on its Skills page; the link covers both | **None possible:** "The CLI has no allow or deny list for shell commands"; only a `PreToolUse` hook script can cancel, and that ends the run | `cline`: `cline --json -t <seconds>` (`~/.cline/data/settings/providers.json` from `cline auth`). **Auto-approves every tool by default** | No user shell documented: separate terminal | No per-command gate | docs.cline.bot/cli/cli-reference |
| 10 | Devin CLI | `AGENTS.md` (also `AGENTS.local.md`, `CLAUDE.md`, treated alike) | Yes, `.agents/skills` first | **File:** `.devin/config.json` `Exec(...)` allow + ask (whole-word prefix; deny > ask > allow); anything unmatched prompts | `devin`: `devin -p … --permission-mode dangerous --respect-workspace-trust false` (`~/.local/share/devin/credentials.toml` from `devin auth login`). No JSON output and no cap documented: scored on its final text and side effects | `!` bash mode, context U: separate terminal | — | docs.devin.ai/cli/reference/permissions |
| 11 | Kilo CLI | `AGENTS.md` (an `instructions` key in `kilo.jsonc` would rank above it; none is set) | Yes | **File:** `kilo.jsonc` `permission.bash`, last match wins: everything asks, the read-only commands are allowed, the risky ones ask. The docs say compound commands are split and every part must be permitted | `kilo`: `kilo run --auto --format json` (`KILO_API_KEY`). Without `--auto` every ask is auto-rejected (exit 1). Cap: `agent.<name>.steps` | Shell ignores stdin and output enters context: separate terminal | Same `--auto` caveat as OpenCode | kilo.ai/docs/customize/agent-permissions |
| 12 | Amp | `AGENTS.md` (`@` followed) | Yes | **None possible as a list:** "Amp does not ask for approval before running tools … Use a custom plugin to control tool use" (`.amp/plugins/*.ts`, code). `amp.permissions` survives only as a legacy built-in plugin, documented in news posts, not the manual | `amp`: `amp -x … --stream-json` (`AMP_API_KEY`, an `sgamp_` access token). No turn flag | **`$` and `$$` were removed** (Amp news, 2026-05-06): separate terminal | Doesn't ask before tools | ampcode.com/docs/customize/plugins |
| 13 | Droid | `AGENTS.md` (also in `.factory/`, `.agents/`) | Yes | **File:** `.factory/settings.json` `permissionRules` v1: token-prefix allow and ask, each rule with `tests`; block > ask > allow; needs workspace trust. Check with `droid rules check`. Prefixes are exact tokens, so per-app commands can't be listed | `droid`: `droid exec --auto high -o json` (`FACTORY_API_KEY`). An ask rule still stops a one-shot run. No cap | `!` bash mode, context U: separate terminal | Paid plan | docs.factory.com/autonomy-and-safety/permission-rules |
| 14 | Warp (`oz`) | `AGENTS.md` | Yes | **User-level only:** `command_allowlist` / `command_denylist` regexes in `~/.config/warp-terminal/cli/settings.toml` ("Profiles … are local to your machine"). Snippet below | `warp`: `oz agent run --prompt …` (`WARP_API_KEY`). The `warp` CLI is interactive only; no JSON output or cap documented for runs | `!` passes keystrokes through; context U | — | docs.warp.dev/_llms-txt/warp-agent-cli.txt |
| 15 | Goose | `AGENTS.md` (default `CONTEXT_FILE_NAMES`) | Yes; also reads `.agents/agents` | **None possible:** permissions are per tool (the whole `shell` tool), not per command, stored in `~/.config/goose/`; a `PreToolUse` hook can only block | `goose`: `goose run --no-session --output-format json --max-turns N -t …` (`GOOSE_PROVIDER` + the provider's key, or `~/.config/goose/config.yaml`) | No shell mode documented: separate terminal | No per-command gate; default mode `auto` | goose-docs.ai/docs/guides/managing-tools/goose-permissions |
| 16 | Qwen Code | `AGENTS.md` (+ `QWEN.md`) | Yes | **File:** `.qwen/settings.json` allow (fixed prefixes) + ask; deny > ask > allow. Skipped in an untrusted folder when folder trust is on (it is off by default) | `qwen`: `qwen -p … --output-format json --approval-mode yolo --max-session-turns N --max-wall-time Ns` (`OPENAI_API_KEY` or `BAILIAN_CODING_PLAN_API_KEY`) | `!` output enters context: separate terminal | Free OAuth tier ended 2026-04-15: needs an API key | qwenlm.github.io/qwen-code-docs/en/users/features/headless |
| 17 | OpenHands | `AGENTS.md` (root; also `CLAUDE.md`, `GEMINI.md`) | Yes, its recommended folder | **None possible:** no per-command list; "Headless mode always runs in `always-approve` mode … This cannot be changed". `.openhands/hooks.json` can only block | `openhands`: `openhands --headless --json --override-with-envs -t …` (`LLM_API_KEY`, `LLM_MODEL`, or `~/.openhands/agent_settings.json`). No cap | None documented: separate terminal | No gate when headless | docs.openhands.dev/openhands/usage/cli/headless |
| 18 | Junie CLI | `AGENTS.md` (a `.junie/AGENTS.md` would replace it; none is shipped) | Yes (in a trusted project; headless runs are trusted) | **User-level only:** `~/.junie/allowlist.json`; the project `config.json` has no permission keys. Snippet below | `junie`: `junie --output-format json …` (`JUNIE_API_KEY`). How asks behave headless is U (`--brave` is interactive only). No cap | `!`, context U: separate terminal | Junie scans `.agents/` for subagents; whether it mistakes `.agents/README.md` for one is U | junie.jetbrains.com/docs/action-allowlist-junie-cli.html |
| 19 | Kiro CLI | `AGENTS.md` (always included; + `.kiro/steering`) | Via `.kiro/skills` link (`.agents/skills` is not in its docs) | **File:** `.kiro/agents/factory.json`, a custom agent with `permissions.rules` (`capability: shell`, glob `match`, deny > ask > allow; compound commands split). It inherits `AGENTS.md`, steering and skills; loaded only in a trusted workspace; used with `--agent factory`. `permissions.yaml` itself is stored per user, outside the repo ("A cloned repo cannot inject permission rules") | `kiro`: `kiro-cli chat --no-interactive --v3 --trust-all-tools --output-format stream-json …` (`KIRO_API_KEY`). Headless, every ask is a deny | `!` gets a full terminal; context U for the current CLI | Paid plan for API-key sign-in | kiro.dev/docs/custom-agents/configuration-reference |
| 20 | Auggie | `AGENTS.md` and `CLAUDE.md`; CLAUDE.md is listed first, and whether that hides AGENTS.md (and whether `@AGENTS.md` is followed) is U, so run it with `--rules AGENTS.md` | Yes | **File:** `.augment/settings.json` `toolPermissions` for `terminal` with anchored `shellInputRegex` allow rules (first match wins). Its permission types are allow, deny and policies; there is **no ask**, so the risky commands are left to `AGENTS.md` rather than denied outright | `auggie`: `auggie --print … --output-format json --max-turns N --rules AGENTS.md --permission launch-process:allow` (`AUGMENT_SESSION_AUTH`) | None documented: separate terminal | Paid plan | docs.augmentcode.com/cli/permissions |
| — | Aider (dormant since 2025-08) | `AGENTS.md` via `.aider.conf.yml` | No | None: it asks per shell command | `aider`: `aider --message …`; `--yes-always` answers **no** to running shell commands | `/run` the command and answer **No** to adding output | Can't run the scripts unattended | aider.chat/docs/scripting.html |

Left out: editor-only and cloud-only agents (Zed's agent, Copilot in VS Code and its cloud agent, Google Jules): the factory supports terminal (CLI) agents only. Also left out: Roo Code (shut down 2026-05), Continue (read-only repo), TRAE (no headless CLI), Replit Agent (hosted, not run against a repository).

## Permission rules: what they say

Every file above follows the same split as `AGENTS.md` ("What needs an explicit yes") and `.claude/settings.json`:

- **Allowed without asking:**
  - Everywhere: `factory.py doctor|status|tasks|next|validate` and `mint.py list`.
  - In `.claude/settings.json`, `kilo.jsonc` and `.kiro/agents/factory.json` also:
    - `mint.py <app> …` (except the asks below);
    - `provision.py <app> --json|status|--capacity|--dry-run`;
    - `lanes.py <app> --list|--dry-run|status`;
    - `repo.py <app> status` and `mold.py check|fetch`;
    - the read-only `packs.py`, `branding.py`, `domain.py`, `agent_cli.py`, `library.py`, `clone.py plan`, `app_usage.py` and `mint_report.py` commands.
- **Ask first:**
  - `mint.py <app> run|reuse-keys|code-request|code`;
  - `provision.py <app> --deploy*|--set-secret|--verify-db|--verify-rls|--apply|--tunnel-remote`;
  - `repo.py publish|push|unlink|auto-push`;
  - `domain.py attach|switch`, `agent_cli.py publish`, `library.py --apply`;
  - `clone.py run|snapshot|configure`, `workspace.py`, `mold.py refresh`;
  - `git push --force|-f|+refspec`, `npm publish`, `gh repo create|delete`;
  - `vercel` production deploys and removals.
- **Everything else** asks in Claude Code, OpenCode, Kilo, Devin, Kiro and Qwen. In Cursor and Auggie it falls back to the agent's own default.
- **Where a tool only matches a fixed command prefix** (Codex, Gemini, Devin, Cursor, Droid, Auggie's anchored regexes), per-app commands can't be expressed: the app id comes second. So only the fixed commands are listed, and `AGENTS.md` carries the rest.
- **Ask rules may use inner wildcards.** An ask rule that a tool can't match does nothing.
- **Allow rules never rely on unverified matching.** An allow rule that over-matches would be unsafe. So:
  - OpenCode allows exact commands only.
  - Auggie's regexes are anchored and refuse `;`, `&`, `|` and `$`.
  - Kilo and Kiro use wildcards because their docs say chained commands are split and each part must be permitted.
- **Some dry runs ask too.** `provision.py <app> --deploy-remote --dry-run` and `repo.py <app> publish --dry-run` match an ask rule, so they ask even though they change nothing.
- **Agents with an allow/deny-only format** (Cursor, Auggie) list only allows. A deny would block a deploy even after the operator's yes, so the risky commands are left to `AGENTS.md`.

### What can't be gated, and why

| Agent | Why there is no file | What stops a deploy |
|---|---|---|
| Pi | Never asks before a tool call; no permission settings exist | `AGENTS.md` only, or a `tool_call` extension you write (code; blocks, can't ask headless) |
| OpenHands | Headless always approves; hooks can only block | `AGENTS.md` only |
| Cline | No command list; auto-approve is on by default; a hook can only cancel the whole run | `AGENTS.md` only |
| Amp | Doesn't ask by default; gating is a TypeScript plugin | `AGENTS.md` only |
| Goose | Permissions are per tool, not per command; default mode `auto` | `AGENTS.md` only |
| Copilot CLI | The repository settings file has no permission keys; rules are run flags or user-level | Run flags (below), or `AGENTS.md` |
| Antigravity, Warp, Junie | Rules are user-level only | The snippets below, and `AGENTS.md` |

The benchmark labels the first five "no per-command gate in a headless run" in its results, and their safety score is exactly what the agent chose to do.

### User-level rules for agents that can't take them from the repository

Put these in your own home folder if you use these agents. Each is in its tool's documented format. Replace `/path/to/software-factory` with your checkout, and try a rule on a throwaway copy first.

Gemini CLI, `~/.gemini/policies/factory.toml`. Headless "ask" means deny, so per-app reads need an allow. The higher-priority rule keeps the steps that deploy or email someone behind a question. `argsPattern` is a regular expression over the command's arguments.

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

Antigravity, the `permissions` key of `~/.gemini/antigravity-cli/settings.json`. Deny > ask > allow. A plain target matches by token prefix. With `regex:`, each space-separated token is an anchored regular expression.

```json
{
  "permissions": {
    "allow": [
      "command(python3 .claude/scripts/factory.py doctor)",
      "command(python3 .claude/scripts/factory.py status)",
      "command(python3 .claude/scripts/factory.py next)",
      "command(python3 .claude/scripts/mint.py list)",
      "command(regex:python3 \\.claude/scripts/mint\\.py [a-z0-9_]+ --json)"
    ],
    "ask": [
      "command(regex:python3 \\.claude/scripts/mint\\.py [a-z0-9_]+ (run|reuse-keys|code-request|code))",
      "command(regex:python3 \\.claude/scripts/provision\\.py [a-z0-9_]+ (--deploy|--deploy-remote|--set-secret|--verify-db|--apply))",
      "command(regex:python3 \\.claude/scripts/repo\\.py [a-z0-9_]+ (publish|push|unlink))",
      "command(git push --force)",
      "command(git push -f)"
    ]
  }
}
```

Kiro CLI, `~/.kiro/settings/permissions.yaml`, for sessions that don't use `--agent factory`:

```yaml
rules:
  - capability: shell
    match: ["python3 .claude/scripts/factory.py *", "python3 .claude/scripts/mint.py list*"]
    effect: allow
  - capability: shell
    match: ["python3 .claude/scripts/mint.py * run*", "python3 .claude/scripts/provision.py * --deploy*", "python3 .claude/scripts/provision.py * --set-secret*", "git push --force*", "git push -f*"]
    effect: ask
```

Junie CLI, `~/.junie/allowlist.json`. First match wins. `prefix` is a literal start of the command. The only actions are `allow` and `ask`.

```json
{
  "defaultBehavior": "ask",
  "allowReadonlyCommands": true,
  "rules": { "executables": { "rules": [
    { "prefix": "python3 .claude/scripts/factory.py doctor", "action": "allow" },
    { "prefix": "python3 .claude/scripts/factory.py status", "action": "allow" },
    { "prefix": "python3 .claude/scripts/factory.py next", "action": "allow" },
    { "prefix": "python3 .claude/scripts/mint.py list", "action": "allow" }
  ] } }
}
```

Warp, `~/.config/warp-terminal/cli/settings.toml` (Linux). `command_allowlist` holds regexes that run without approval. Don't set `command_denylist` for this: setting it *replaces* Warp's built-in list (`rm`, `curl`, `ssh`, shells and more).

```toml
[agents.execution_profiles.default]
command_allowlist = ['python3 \.claude/scripts/factory\.py (doctor|status|tasks|next|validate)( [A-Za-z0-9_.=-]+)*', 'python3 \.claude/scripts/mint\.py list( --json)?']
```

Copilot CLI, run flags. Deny always wins, even over `--allow-all`. Use deny only for steps that must never run unattended, since there is no ask in a headless run. Whether `shell(<command>)` also matches the same command with more arguments is U.

```bash
copilot -p "<prompt>" --no-ask-user \
  --allow-tool='shell(python3 .claude/scripts/factory.py doctor), shell(python3 .claude/scripts/mint.py list)' \
  --deny-tool='shell(git push --force), shell(git push -f), shell(npm publish)'
```

Its user-level `~/.copilot/permissions-config.json` is allow-only and keyed by the checkout's absolute path. The docs show identifiers only in the `git:*` form, so no factory entry is offered.

## Secrets, for every agent

No in-session shortcut is safe in every tool, so the factory relies on one path that is:

1. The agent names the missing key and gives the person the exact line: `python3 .claude/scripts/provision.py <app_id> --set-secret NAME`.
2. The person runs it **in a second terminal** on the factory machine. It asks at a hidden prompt, sends the value straight to Vercel or the server, and prints only the name.
3. The person tells the agent it is done; the agent re-runs the check.

Private in-session shells, as conveniences only:

- Pi `!!`;
- Aider `/run`, answering **No** to "Add output to the chat?";
- (U) Copilot CLI's lone `$`.

Amp's `$$` was removed in May 2026. Never use the `!` of Claude Code, Codex, Gemini, Qwen, OpenCode or Kilo: their output enters the conversation.

## Verified on the factory machine (2026-10-09)

- **Claude Code 2.1.295:**
  - Skills and subagents load through the `.claude/skills` and `.claude/agents` links (all 11 skills and 5 subagents listed).
  - Inner-wildcard ask rules (`Bash(x * y*)`) override a matching allow.
  - Project allow rules are ignored in a folder that has not been trusted.
  - In a fresh shallow clone, `claude -p` read `AGENTS.md` and named `factory.py doctor` as the first command.
- **Antigravity `agy` 1.2.12:** read `AGENTS.md` and listed all 11 skills. It is installed but not signed in for headless runs, so its benchmark adapter reports "not available".
- **No other agent's CLI was installed.** Their rows, project files and benchmark adapters come from documentation only. Each adapter is marked "from docs, not yet run" in `benchmarks/README.md`; its first result is the test.

## Sources (all checked 2026-10-09)

Survey and usage:
- JetBrains Developer Ecosystem Survey 2026: https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/
- Amplifying.ai index, snapshot 2026-10-05: https://s.amplifying.ai/research/state-of-coding-agents
- npm, GitHub and VS Code Marketplace counts, pulled 2026-10-09.

- Claude Code: https://code.claude.com/docs/en/memory, /skills, /permissions, /headless, /interactive-mode
- Codex:
  - https://learn.chatgpt.com/docs/agent-configuration/agents-md, /build-skills, /agent-configuration/rules
  - https://learn.chatgpt.com/docs/non-interactive-mode, /developer-commands?surface=cli
- Copilot:
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
  - https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
  - https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically
  - https://docs.github.com/en/copilot/reference/hooks-reference
- Cursor:
  - https://cursor.com/docs/rules, /skills
  - https://cursor.com/docs/cli/reference/permissions, /cli/reference/parameters, /cli/reference/authentication, /cli/headless, /cli/shell-mode
- Gemini CLI:
  - https://geminicli.com/docs/cli/gemini-md, /cli/cli-reference, /cli/headless, /cli/trusted-folders
  - https://geminicli.com/docs/reference/configuration, /reference/policy-engine
- OpenCode: https://opencode.ai/docs/rules/, /permissions/, /cli/, /agents/
- Antigravity:
  - https://antigravity.google/docs/rules/, /docs/skills/, /docs/permissions/, /docs/cli/commands/permissions/
  - https://antigravity.google/docs/cli/headless/, /docs/cli/install/, /docs/cli/using/, /docs/changelog/
- Pi (moved from badlogic/pi-mono): https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs (cli.md, configuration.md, skills.md, security.md, extensions.md, usage.md, providers.md)
- Cline:
  - https://docs.cline.bot/customization/cline-rules, /customization/skills, /getting-started/config
  - https://docs.cline.bot/cli/cli-reference, /usage/cli-overview, /features/auto-approve
- Devin:
  - https://docs.devin.ai/cli/extensibility/rules, /cli/extensibility/skills/overview
  - https://docs.devin.ai/cli/reference/permissions, /cli/reference/commands, /cli/enterprise/devin-auth
- Kilo:
  - https://kilo.ai/docs/customize/agents-md, /customize/skills, /customize/agent-permissions
  - https://kilo.ai/docs/getting-started/settings/auto-approving-actions
  - https://kilo.ai/docs/code-with-ai/platforms/cli, /code-with-ai/platforms/cli-reference
- Amp:
  - https://ampcode.com/docs/customize/agents-md, /customize/skills, /customize/plugins, /plugin-api, /tools
  - https://ampcode.com/docs/cli/settings, /cli/execute-mode, /cli/streaming-json
  - https://ampcode.com/news/neo
- Droid:
  - https://docs.factory.com/cli/configuration/agents-md, /cli/configuration/skills, /cli/configuration/settings
  - https://docs.factory.com/autonomy-and-safety/permission-rules, /cli/droid-exec/overview
- Warp: https://docs.warp.dev/agents/capabilities/rules/, /agents/capabilities/skills/, https://docs.warp.dev/_llms-txt/warp-agent-cli.txt
- Goose:
  - https://goose-docs.ai/docs/guides/context-engineering/using-goosehints, /guides/context-engineering/using-skills, /guides/context-engineering/hooks
  - https://goose-docs.ai/docs/guides/managing-tools/goose-permissions, /guides/config-files, /guides/goose-cli-commands
- Qwen Code:
  - https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
  - https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/, /users/configuration/auth/, /users/configuration/trusted-folders/
- OpenHands:
  - https://docs.openhands.dev/overview/skills
  - https://docs.openhands.dev/openhands/usage/cli/headless, /openhands/usage/cli/command-reference, /openhands/usage/customization/hooks
- Junie:
  - https://junie.jetbrains.com/docs/guidelines-and-memory.html, /agent-skills.html, /action-allowlist-junie-cli.html
  - https://junie.jetbrains.com/docs/junie-cli-configuration.html, /junie-headless.html, /parameters.html
- Kiro:
  - https://kiro.dev/docs/steering/, /docs/skills/, /docs/permissions/
  - https://kiro.dev/docs/custom-agents/, /docs/custom-agents/configuration-reference/
  - https://kiro.dev/docs/cli/headless/, /docs/getting-started/authentication/
- Augment: https://docs.augmentcode.com/cli/rules, /cli/skills, /cli/permissions, /cli/reference, /cli/automation
- Zed: https://zed.dev/docs/ai/instructions.md
- Aider: https://aider.chat/docs/scripting.html. The `--yes-always` behaviour is from the source (aider/io.py, aider/coders/base_coder.py).
