#!/usr/bin/env bash
# Mirror .claude assets into .agents (one-way). Run from repo root.
set -e
for d in skills agents workflows scripts sandboxes; do
  rsync -a --delete --exclude sync.sh --exclude README.md .claude/$d/ .agents/$d/
done
echo synced
