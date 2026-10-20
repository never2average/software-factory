#!/usr/bin/env bash
# boat.dev setup: install Amp CLI (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Not preinstalled on boat VMs (see https://docs.boat.dev/machines). npm name is @ampcode/cli (@sourcegraph/amp is the old name).
# Usage (inside the VM):  bash amp.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.0.1791619249-g722a12}}"

npm_pin "@ampcode/cli" "$VERSION"

verify amp amp "$VERSION"
cleanup
