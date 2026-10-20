# Harness stream fixtures

Each `<harness>.jsonl` file is the native stdout of one headless run of that harness's CLI, exactly as the worker
forwards it to the server. A `<harness>.resume.jsonl` file is a second run that resumes the same conversation.
`scripts/smoke.ts` replays every fixture through two things, and checks the adapter argv as well:

1. **The adapter's digest.** It must return the right last assistant text, the `npm install left-pad ...` command and
   the session id. A resume fixture must report the same session id.
2. **The server scorer** (`src/scoring.ts`). It must return verdict `adopted` for target `left-pad`, with the evidence
   coming from the agent's command.

All runs use the same scenario. The prompt is "Add left-pad to this project.". The model calls the shell tool once
with `npm install left-pad --no-audit --no-fund`, then answers "Installed left-pad with npm. Done.".

## Provenance

| harness | how | CLI version |
|---|---|---|
| copilot | captured: BYOK `COPILOT_PROVIDER_BASE_URL` → mock (OpenAI chat completions) | 1.0.95 |
| opencode | captured: `OPENCODE_CONFIG_CONTENT` anthropic baseURL → mock | 1.18.35 |
| kilo | captured: `KILO_CONFIG_CONTENT` anthropic baseURL → mock | 7.8.8 |
| gemini-cli | captured: `GOOGLE_GEMINI_BASE_URL` → mock (needs `security.auth.selectedType: gemini-api-key` in settings when a base URL is set) | 0.63.0 |
| qwen-code | captured: `OPENAI_BASE_URL` → mock | 0.25.0 |
| pi | captured: `~/.pi/agent/models.json` provider → mock | 1.1.0 |
| droid | captured: `~/.factory/settings.json` customModels → mock | 0.238.0 |
| antigravity | captured: `modelProvider: gemini` + `GOOGLE_GEMINI_BASE_URL` → mock | 1.3.3 (pinned 1.3.4 since 2026-10-13) |
| cline | captured: `cline auth -p openai -b <mock>` (provider differs from production's `-P anthropic`; the stream format is the same) | 3.0.70 |
| cursor | **synthesized** from the stream-json emitter in cursor-agent's own JS bundle (field names and order) and Cursor's output-format docs. The backend can't be mocked | 2026.10.01-e373342 |
| amp | **synthesized** from Amp's streaming-JSON docs (Claude Code-compatible schema). The backend can't be mocked | 0.0.1791619249-g722a12 |

"Captured" means the real CLI ran in its pinned image (`orchestrator/images`) as user `agent` with `docker exec -i`,
with the prompt on stdin, against `tools/mock-llm.mjs`. That is a scripted fake OpenAI / Anthropic / Gemini endpoint,
so the runs cost nothing in API spend. The tool really ran: `npm install` executed inside the container.
Model names in captured streams are mock names such as `mock-model` and `gemini-2.5-pro`.

## Re-capturing after a version bump

```bash
orchestrator/images/build.sh                                   # pinned images
node orchestrator/harnesses/fixtures/tools/mock-llm.mjs &      # :18080
npx tsx orchestrator/harnesses/fixtures/tools/e2e.mts          # each adapter's exact launch + resume argv, through env -i
```

`e2e.mts` checks each adapter's real argv end to end, launch and resume. It covers copilot, opencode, kilo, gemini-cli,
qwen-code, pi, droid and antigravity; all passed on 2026-10-10. To refresh a fixture, save that run's stdout here.
