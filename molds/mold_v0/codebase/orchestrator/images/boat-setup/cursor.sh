#!/usr/bin/env bash
# boat.dev setup: install Cursor CLI (cursor-agent) (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Boat preinstalls this harness, but at whatever version the image ships; we pin our own copy over it. Same tarball the official installer (https://cursor.com/install) downloads, pinned by build id.
# Usage (inside the VM):  bash cursor.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-2026.10.01-e373342}}"

ARCH="$(linux_arch)"
download_tarball "https://downloads.cursor.com/lab/${VERSION}/linux/${ARCH}/agent-cli-package.tar.gz" \
  "/opt/cursor-agent/${VERSION}" "" --strip-components=1
$SUDO ln -sfn "/opt/cursor-agent/${VERSION}/cursor-agent" /usr/local/bin/cursor-agent
$SUDO ln -sfn "/opt/cursor-agent/${VERSION}/cursor-agent" /usr/local/bin/agent

verify cursor cursor-agent "$VERSION"
cleanup
