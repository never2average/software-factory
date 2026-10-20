#!/usr/bin/env bash
# boat.dev setup: install OpenAI Codex CLI (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Boat preinstalls this harness, but at whatever version the image ships; we pin our own copy over it.
# Usage (inside the VM):  bash codex.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.162.1}}"

npm_pin "@openai/codex" "$VERSION"

verify codex codex "$VERSION"
cleanup
