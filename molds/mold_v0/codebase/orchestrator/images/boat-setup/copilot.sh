#!/usr/bin/env bash
# boat.dev setup: install GitHub Copilot CLI (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Not preinstalled on boat VMs (see https://docs.boat.dev/machines).
# Usage (inside the VM):  bash copilot.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-1.0.95}}"

npm_pin "@github/copilot" "$VERSION"

verify copilot copilot "$VERSION"
cleanup
