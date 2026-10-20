#!/usr/bin/env bash
# boat.dev setup: install Pi coding agent (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Boat preinstalls this harness, but at whatever version the image ships; we pin our own copy over it. Package is @earendil-works/pi-coding-agent (the @mariozechner name is deprecated).
# Usage (inside the VM):  bash pi.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-1.1.0}}"

# --ignore-scripts as in the official npm instructions.
npm_pin "@earendil-works/pi-coding-agent" "$VERSION" --ignore-scripts

verify pi pi "$VERSION"
cleanup
