#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 VM as a software-factory runtime. Idempotent.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git tmux jq build-essential rsync unzip
# node 24 (NodeSource; matches molds/mold_v1 engines and the Vercel project)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" != "24" ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
# docker engine + compose plugin
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
# headless: CLIs that try to open a browser (Vercel Marketplace checkout) record the URL instead, so scripts can show it to a person
cat > /usr/local/bin/xdg-open <<'XDG'
#!/bin/sh
echo "$1" >> "$HOME/.factory-open-urls"
echo "OPEN THIS IN A BROWSER: $1" >&2
exit 0
XDG
chmod +x /usr/local/bin/xdg-open
# global CLIs
npm install -g --silent vercel@latest playwright@latest
# playwright browsers + system deps (chromium only; enough for all five lanes)
npx --yes playwright install --with-deps chromium
echo "node $(node -v) npm $(npm -v) docker $(docker --version | cut -d, -f1) vercel $(vercel --version | head -1)"
