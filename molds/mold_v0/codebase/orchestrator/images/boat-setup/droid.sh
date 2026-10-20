#!/usr/bin/env bash
# boat.dev setup: install Factory droid (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Not preinstalled on boat VMs (see https://docs.boat.dev/machines). Same binary as https://app.factory.ai/cli, via the official npm package `droid`.
# Usage (inside the VM):  bash droid.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.238.0}}"

npm_pin "droid" "$VERSION"

verify droid droid "$VERSION"
cleanup
