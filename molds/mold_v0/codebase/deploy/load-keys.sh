#!/usr/bin/env bash
# Load provider credentials into the Octillion key vault (AES-256-GCM in Postgres).
#
#   ./load-keys.sh                 interactive: hidden prompt per provider, Enter skips
#   ./load-keys.sh --from-env      non-interactive: reads BOAT_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, ... from the env
#   ./load-keys.sh --list          show what the vault holds (hints only)
#
# Options: --project NAME (compose project, default octillion), --label NAME (default main),
#          --no-verify (skip the provider check), --force (store even if verification fails).
#
# Keys never touch argv, shell history, the terminal or logs: they are read silently and piped over stdin into
# `scripts/keyvault.ts set` inside the running server container, which encrypts them with OCTILLION_VAULT_KEY.
# Verification calls each provider's read-only "list models" (or boat's /limits) endpoint, passing the key as a
# header via stdin (curl -H @-), so it is not visible in the process list either.
set -euo pipefail

PROJECT=octillion LABEL=main MODE=interactive VERIFY=1 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from-env) MODE=env ;;
    --list) MODE=list ;;
    --project) PROJECT="$2"; shift ;;
    --label) LABEL="$2"; shift ;;
    --no-verify) VERIFY=0 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# provider | env var | what it unlocks
PROVIDERS="
boat|BOAT_API_KEY|sandboxes for worker agents (create the key with: boat api-key create octillion --preset ci)
anthropic|ANTHROPIC_API_KEY|Claude Code, OpenCode, Pi, Cline, Kilo, and the orchestrator itself
openai|OPENAI_API_KEY|Codex
google|GEMINI_API_KEY|Gemini CLI, Antigravity (paused agents)
github_copilot|COPILOT_GITHUB_TOKEN|Copilot CLI (paused)
cursor|CURSOR_API_KEY|Cursor CLI (paused)
amp|AMP_API_KEY|Amp (paused)
factory|FACTORY_API_KEY|Droid (paused)
dashscope|DASHSCOPE_API_KEY|Qwen Code (paused)
exa|EXA_API_KEY|web search for onboarding research (competitors with evidence; server only)
libraries_io|LIBRARIES_IO_API_KEY|PyPI/Go/Maven package search for research (optional; server only)
"

vault() { docker compose -p "$PROJECT" exec -T octillion node --import tsx scripts/keyvault.ts "$@"; }

if ! docker compose -p "$PROJECT" ps --status running --services 2>/dev/null | grep -qx octillion; then
  echo "The '$PROJECT' stack is not running. Start it first: docker compose -f docker-compose.prod.yml --env-file .env up -d --wait" >&2
  exit 1
fi

if [ "$MODE" = list ]; then vault list; exit 0; fi

# verify PROVIDER  (key on stdin) -> 0 ok, 1 rejected, 2 not checkable
verify() {
  local provider=$1 key code
  key=$(cat)
  case "$provider" in
    anthropic) code=$(printf 'x-api-key: %s\nanthropic-version: 2023-06-01\n' "$key" | curl -s -o /dev/null -w '%{http_code}' -m 20 -H @- https://api.anthropic.com/v1/models) ;;
    openai)    code=$(printf 'Authorization: Bearer %s\n' "$key" | curl -s -o /dev/null -w '%{http_code}' -m 20 -H @- https://api.openai.com/v1/models) ;;
    google)    code=$(printf 'x-goog-api-key: %s\n' "$key" | curl -s -o /dev/null -w '%{http_code}' -m 20 -H @- https://generativelanguage.googleapis.com/v1beta/models) ;;
    boat)
      code=$(printf 'Authorization: Bearer %s\n' "$key" | curl -s -o /dev/null -w '%{http_code}' -m 20 -H @- https://boat.dev/api/v1/me)
      # /me only proves the key can read the account. Creating sandboxes needs a key made with `--preset ci`;
      # otherwise the orchestrator gets 403 api_key_action_forbidden on POST /sandboxes.
      [ "$code" = 200 ] && echo "    note: account access OK; make sure this key was created with --preset ci (sandbox create)" >&2 ;;
    *) return 2 ;;
  esac
  [ "$code" = 200 ] && return 0
  echo "    provider answered HTTP $code" >&2
  return 1
}

store() {
  local provider=$1 key=$2 status=0
  if [ "$VERIFY" = 1 ]; then
    printf %s "$key" | verify "$provider" || status=$?
    case $status in
      0) echo "    verified with $provider" ;;
      2) echo "    (no automatic check for $provider)" ;;
      1) if [ "$FORCE" = 1 ]; then echo "    storing anyway (--force)";
         elif [ "$MODE" = interactive ]; then
           read -r -p "    $provider rejected the key. Store it anyway? [y/N] " yn </dev/tty; [ "$yn" = y ] || { echo "    skipped"; return 0; }
         else echo "    skipped (use --force to store unverified keys)"; return 0; fi ;;
    esac
  fi
  printf %s "$key" | vault set "$provider" --label "$LABEL" | sed 's/^/    /'
}

echo "Loading keys into the '$PROJECT' key vault (label: $LABEL)."
while IFS='|' read -r provider var what; do
  [ -n "$provider" ] || continue
  if [ "$MODE" = env ]; then
    key="${!var:-}"
    [ -n "$key" ] || continue
    echo "- $provider (from \$$var)"
  else
    echo "- $provider: $what"
    read -r -s -p "  paste $var (Enter to skip): " key </dev/tty; echo
    [ -n "$key" ] || { echo "    skipped"; continue; }
  fi
  store "$provider" "$key"
  key=""
done <<< "$PROVIDERS"

# Anthropic through Google Cloud Vertex AI (optional): the gateway rewrites Claude calls to Vertex and signs in
# with a service-account key (roles/aiplatform.user; Claude models enabled in Model Garden).
#   interactive: answer the prompts;  --from-env: VERTEX_PROJECT_ID, VERTEX_REGION (default global), VERTEX_SA_FILE
if [ "$MODE" = env ]; then
  project="${VERTEX_PROJECT_ID:-}" region="${VERTEX_REGION:-global}" safile="${VERTEX_SA_FILE:-}"
else
  echo "- vertex: route Anthropic (Claude) through Google Cloud Vertex AI"
  read -r -p "  GCP project id (Enter to skip): " project </dev/tty
  region=global safile=""
  if [ -n "$project" ]; then
    read -r -p "  Vertex location [global]: " r </dev/tty; region="${r:-global}"
    read -r -p "  path to the service-account JSON key: " safile </dev/tty
  fi
fi
if [ -n "${project:-}" ]; then
  [ -r "$safile" ] || { echo "    cannot read service-account key at '$safile'" >&2; exit 1; }
  docker compose -p "$PROJECT" exec -T octillion node --import tsx scripts/keyvault.ts set anthropic --label vertex < "$safile" | sed 's/^/    /'
  docker compose -p "$PROJECT" exec -T octillion node --import tsx scripts/keyvault.ts provider anthropic --backend vertex \
    --vertex-project "$project" --vertex-region "$region" >/dev/null && echo "    anthropic now routes through Vertex AI ($project, $region)"
fi

echo
echo "Vault now holds (hints only):"
vault list
