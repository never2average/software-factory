#!/usr/bin/env bash
# boat.dev setup: install Google Antigravity CLI (agy) (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Not preinstalled on boat VMs (see https://docs.boat.dev/machines). Same tarball the official installer (https://antigravity.google/cli/install.sh) downloads, pinned by build id + sha512.
# Usage (inside the VM):  bash antigravity.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-1.3.4}}"

# The installer resolves a "latest" manifest; we pin the build. Update AGY_BUILD and the sha512s together
# from https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_<amd64|arm64>.json
AGY_BUILD="${AGY_BUILD:-1.3.4-5524158944247808}"
case "$(linux_arch)" in
  x64)   P="linux-x64/cli_linux_x64.tar.gz";   SHA="${AGY_SHA512_AMD64:-dbdacfc5a1d9874fbbea3a21026d3990b4728e2e3487fd0316dc53cae9a3091023f969425828f3e2e0fadda43cea07dd978ea96f4ca7c202adf2201f419c56dd}";;
  arm64) P="linux-arm/cli_linux_arm64.tar.gz"; SHA="${AGY_SHA512_ARM64:-24a1d463319701f4943b2d4932cb86ca34d60d2e9fedcd9018ca31809773d719f272512068911632db175d7233088551033bcecc0a2a56b1bcfa041269687eaf}";;
esac
case "$AGY_BUILD" in "$VERSION"-*) ;; *) die "AGY_BUILD $AGY_BUILD does not match version $VERSION";; esac
download_tarball "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_BUILD}/${P}" "/opt/agy/${AGY_BUILD}" "$SHA"
$SUDO ln -sfn "/opt/agy/${AGY_BUILD}/antigravity" /usr/local/bin/agy

verify antigravity agy "$VERSION"
cleanup
