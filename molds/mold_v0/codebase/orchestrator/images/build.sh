#!/usr/bin/env bash
# Build and tag one Docker image per enabled harness in harnesses/registry.json.
#
#   orchestrator/images/build.sh                 # every enabled harness
#   orchestrator/images/build.sh codex cursor    # only these harnesses (must be enabled)
#   DRY_RUN=1 orchestrator/images/build.sh       # print the docker commands only
#   PLATFORM=linux/amd64 orchestrator/images/build.sh
#
# Several registry agents can share a harness (e.g. claude-code/opus and claude-code/sonnet). They share
# one image, so we build each distinct (harness, harness_version, image.docker) once.
# Images are only built and tagged locally. This script never pushes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${REGISTRY:-$HERE/../../harnesses/registry.json}"
[ -f "$REGISTRY" ] || { echo "registry not found: $REGISTRY" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required to read $REGISTRY" >&2; exit 1; }

# One line per image: "<harness>\t<harness_version>\t<docker tag>". Fails loudly on conflicting
# versions or tags for the same harness, which would mean the registry is inconsistent.
mapfile -t ROWS < <(node -e '
  const reg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const seen = new Map();
  for (const a of reg.agents) {
    if (!a.enabled) continue;
    const row = [a.harness, a.harness_version, a.image && a.image.docker, a.cli || a.harness];
    if (!row[2]) { console.error(`agent ${a.id}: no image.docker`); process.exit(1); }
    const prev = seen.get(a.harness);
    if (prev && prev.join("\t") !== row.join("\t")) {
      console.error(`harness ${a.harness}: agents disagree on version/image (${prev} vs ${row})`); process.exit(1);
    }
    seen.set(a.harness, row);
  }
  for (const r of seen.values()) console.log(r.join("\t"));
' "$REGISTRY")

WANT=("$@")
built=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r harness version tag cli <<<"$row"
  # The tag must be exactly what the fleet planner reads from the registry.
  [ "$tag" = "octillion/agent-$harness:$version" ] || echo "warning: $harness tag $tag is not octillion/agent-$harness:$version" >&2
  if [ "${#WANT[@]}" -gt 0 ] && [[ ! " ${WANT[*]} " == *" $harness "* ]]; then continue; fi
  df="$HERE/Dockerfile.$harness"
  [ -f "$df" ] || { echo "missing $df for enabled harness $harness" >&2; exit 1; }
  cmd=(docker build -f "$df" --build-arg "HARNESS_VERSION=$version" -t "$tag"
       --label "dev.app.harness=$harness" --label "dev.app.harness_version=$version")
  [ -n "${PLATFORM:-}" ] && cmd+=(--platform "$PLATFORM")
  cmd+=("$HERE")
  echo "==> $harness $version -> $tag"
  if [ -n "${DRY_RUN:-}" ]; then printf '%q ' "${cmd[@]}"; echo; continue; fi
  "${cmd[@]}"
  # Smoke test, the way the fleet uses the image: start a warm pod (CMD sleep infinity), exec the CLI as
  # `agent`, check the version, remove the pod.
  if [ -z "${NO_SMOKE:-}" ]; then
    cid="$(docker run -d --rm "$tag")"
    got="$(docker exec -u agent "$cid" "$cli" --version 2>&1 | head -n 1)" || { docker rm -f "$cid" >/dev/null; echo "smoke test failed: $got" >&2; exit 1; }
    docker rm -f "$cid" >/dev/null
    echo "    docker exec -u agent $cli --version -> $got"
    case "$got" in *"$version"*) ;; *) echo "warning: $harness reports '$got', expected $version" >&2;; esac
  fi
  built=$((built + 1))
done

for w in "${WANT[@]}"; do
  printf '%s\n' "${ROWS[@]}" | cut -f1 | grep -qx -- "$w" || echo "warning: '$w' is not an enabled harness in the registry" >&2
done
echo "done: $built image(s) built"
