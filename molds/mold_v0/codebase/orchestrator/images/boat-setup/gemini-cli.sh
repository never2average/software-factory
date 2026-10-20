#!/usr/bin/env bash
# boat.dev setup: install Gemini CLI (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Not preinstalled on boat VMs (see https://docs.boat.dev/machines).
# Usage (inside the VM):  bash gemini-cli.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.63.0}}"

npm_pin "@google/gemini-cli" "$VERSION"

verify gemini-cli gemini "$VERSION"
cleanup
