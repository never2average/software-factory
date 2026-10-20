#!/usr/bin/env bash
# boat.dev setup: install Claude Code (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Boat preinstalls this harness, but at whatever version the image ships; we pin our own copy over it.
# Usage (inside the VM):  bash claude-code.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-2.1.296}}"

npm_pin "@anthropic-ai/claude-code" "$VERSION"

verify claude-code claude "$VERSION"
cleanup
