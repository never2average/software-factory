#!/usr/bin/env bash
# verify-instructions.sh <subagent-key> — the mold's always-on prompt rules (scripts/test-prompt-context.mjs) plus
# the workspace checker's naming rules, for ONE subagent's instructions.md in this pack. Exit 0 = ok.
set -u; k="$1"; d="$(dirname "$0")/files/agent/subagents/$k"; f="$d/instructions.md"; bad=0
w=$(wc -w < "$f"); [ "$w" -le 1350 ] || { echo "FAIL $k: $w words (limit 1350; the mold's hard limit is 1400)"; bad=1; }
[ "$(grep -c '<!-- organization-policy -->' "$f")" = 1 ] || { echo "FAIL $k: '<!-- organization-policy -->' must appear exactly once"; bad=1; }
[ "$(grep -c '<!-- stable-prompt-end -->' "$f")" = 1 ] || { echo "FAIL $k: '<!-- stable-prompt-end -->' must appear exactly once"; bad=1; }
[ "$(grep -v '^[[:space:]]*$' "$f" | tail -1)" = '<!-- stable-prompt-end -->' ] || { echo "FAIL $k: the file must END with '<!-- stable-prompt-end -->'"; bad=1; }
for s in "$d"/skills/*/; do n=$(basename "$s"); grep -q "\`$n\`" "$f" || { echo "FAIL $k: skill $n is not named in instructions.md"; bad=1; }; done
for p in "$d"/sandbox/workspace/scripts/*.py; do n=$(basename "$p"); grep -rq "$n" "$f" "$d"/skills/*/SKILL.md || { echo "FAIL $k: script $n is named nowhere"; bad=1; }; done
grep -q "kpi-spec.md" "$f" || { echo "FAIL $k: the rulebook (kpi-spec.md) is not referenced"; bad=1; }
grep -qi "validat" "$f" || { echo "FAIL $k: no validate-before-write rule"; bad=1; }
[ $bad = 0 ] && echo "ok $k: $w words"; exit $bad
