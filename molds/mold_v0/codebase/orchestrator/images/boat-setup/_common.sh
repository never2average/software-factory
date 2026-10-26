# Shared helpers for boat-setup/<harness>.sh. Sourced, not executed.
#
# These scripts run INSIDE a fresh boat.dev VM (Ubuntu 24.04, default user `user` with passwordless sudo,
# Node 24 via nvm in /home/user/.nvm). They install one pinned harness SYSTEM-WIDE (/usr/local, /opt), so the
# unprivileged `agent` user the worker creates per session can run it, and so the install is captured by a
# named snapshot (boat snapshots capture changes under /usr, /opt, /etc, /root, /srv and /home/user).
#
# Nothing here writes API keys, config files, rules files or MCP servers: the snapshot must stay neutral.
set -euo pipefail

log() { printf '[app-setup] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "need root or sudo"
  SUDO="sudo"
fi

# Find a Node >= 22 (nvm's newest first, then PATH) and make sure /usr/local/bin/node is >= 22, because npm-installed
# CLIs start with `#!/usr/bin/env node` and the agent user runs them under `env -i` with a minimal PATH.
ensure_node() {
  local cand="" d
  for d in $(ls -d /home/*/.nvm/versions/node/v*/bin /root/.nvm/versions/node/v*/bin 2>/dev/null | sort -V -r); do
    [ -x "$d/node" ] && { cand="$d"; break; }
  done
  [ -n "$cand" ] || cand="$(dirname "$(command -v node 2>/dev/null || echo /nonexistent/node)")"
  [ -x "$cand/node" ] || die "no node found (expected nvm node on boat VMs)"
  local major; major="$("$cand/node" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node $("$cand/node" --version) at $cand is < 22"
  NODE_DIR="$cand"
  # Boat VMs ship /usr/local/bin/node as a SYMLINK into /home/user/.nvm (seen 2026-10-10). /home/user is 0750, so for
  # every other user (the worker's `agent`, `nobody` in verify) node resolves to /usr/bin/node v20 instead, which
  # breaks pi and makes cline warn. Replace the symlink with a real, world-executable copy.
  local real; real="$(readlink -f /usr/local/bin/node 2>/dev/null || true)"
  case "$real" in /home/*|/root/*)
    log "replacing /usr/local/bin/node (symlink to $real, unreadable for other users) with a copy"
    $SUDO cp --remove-destination "$real" /usr/local/bin/node && $SUDO chmod 0755 /usr/local/bin/node ;;
  esac
  local sys_major=0
  [ -x /usr/local/bin/node ] && sys_major="$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$sys_major" -lt 22 ]; then
    log "installing node $("$cand/node" --version) to /usr/local/bin/node (was: ${sys_major:-none})"
    $SUDO install -m 0755 "$cand/node" /usr/local/bin/node
  fi
  export PATH="/usr/local/bin:$NODE_DIR:$PATH"
}

# npm_pin <package> <version>: install a pinned npm package globally into /usr/local (bins in /usr/local/bin).
# --force replaces a preinstalled bin of the same name (boat ships some harnesses preinstalled).
# Newer npm skips a package's install scripts unless they are approved (allowScripts), and some harnesses fetch their
# native binary there (claude-code: install.cjs): so the pinned package's own install / postinstall run explicitly
# afterwards (`npm run` is not subject to that), only for the package we pinned, never for its dependencies.
npm_pin() {
  local pkg="$1" ver="$2"; shift 2
  ensure_node
  log "npm install -g $pkg@$ver -> /usr/local"
  $SUDO env "PATH=$PATH" npm install -g --prefix /usr/local --no-fund --no-audit --force "$@" "$pkg@$ver" >&2
  local dir="/usr/local/lib/node_modules/$pkg"
  # A caller that passed --ignore-scripts (pi) wants none run.
  case " $* " in *" --ignore-scripts "*) return 0;; esac
  if [ -f "$dir/package.json" ]; then
    for script in install postinstall; do
      if node -e 'process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)' "$dir/package.json" "$script" 2>/dev/null; then
        log "running $pkg's $script script"
        $SUDO env "PATH=$PATH" npm run --prefix "$dir" --no-fund --no-audit "$script" >&2 || die "$pkg $script script failed"
      fi
    done
  fi
}

# download_tarball <url> <dest-dir> [sha512]: download a release tarball over https into a fresh dir.
download_tarball() {
  local url="$1" dest="$2" sha="${3:-}" tmp; tmp="$(mktemp -d)"
  log "downloading $url"
  curl -fsSL -o "$tmp/pkg.tgz" "$url"
  if [ -n "$sha" ]; then echo "$sha  $tmp/pkg.tgz" | sha512sum -c - >&2; fi
  $SUDO rm -rf "$dest"; $SUDO mkdir -p "$dest"
  $SUDO tar -xzf "$tmp/pkg.tgz" -C "$dest" "${@:4}"
  rm -rf "$tmp"
}

linux_arch() {
  case "$(uname -m)" in x86_64|amd64) echo x64;; aarch64|arm64) echo arm64;; *) die "unsupported arch $(uname -m)";; esac
}

# verify <harness> <bin> <version>: run `<bin> --version` the way the worker will (as an unprivileged user, env -i,
# minimal PATH), check the pinned version, and record a manifest at /etc/app/harnesses/<harness>.json.
verify() {
  local harness="$1" bin="$2" ver="$3" out all path
  path="$(PATH=/usr/local/bin:/usr/bin:/bin command -v "$bin")" || die "$bin not on /usr/local/bin:/usr/bin:/bin"
  # Some CLIs print a warning before the version (codex: "WARNING: ... could not create PATH aliases" with HOME=/tmp),
  # so the version is looked for in every line, and the line that has it is recorded.
  all="$($SUDO -u nobody env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin "$bin" --version 2>&1)" \
    || die "$bin --version failed as nobody: $(printf %s "$all" | head -n 3)"
  out="$(printf '%s\n' "$all" | grep -F -m 1 -- "$ver")" \
    || die "$bin reports '$(printf '%s\n' "$all" | grep -v -i '^warning' | head -n 1)', expected $ver (another $bin earlier on PATH?)"
  $SUDO mkdir -p /etc/app/harnesses
  printf '{"harness":"%s","bin":"%s","path":"%s","version":"%s","reported":"%s","installed_at":"%s"}\n' \
    "$harness" "$bin" "$path" "$ver" "${out//\"/\'}" "$(date -u +%FT%TZ)" | $SUDO tee "/etc/app/harnesses/$harness.json" >/dev/null
  log "OK $harness: $path -> $out"
}

# Leave nothing session-specific in the snapshot.
cleanup() {
  $SUDO npm cache clean --force >/dev/null 2>&1 || true
  rm -rf "$HOME/.npm/_cacache" "$HOME/.cache" 2>/dev/null || true
  $SUDO rm -rf /root/.npm/_cacache /root/.cache 2>/dev/null || true
}
