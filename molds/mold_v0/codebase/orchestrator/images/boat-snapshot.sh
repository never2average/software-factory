#!/usr/bin/env bash
# Bake one boat.dev named snapshot per enabled harness (or the ones named), from harnesses/registry.json.
#
#   BOAT_API_KEY=boat_... orchestrator/images/boat-snapshot.sh               # all enabled harnesses
#   BOAT_API_KEY=boat_... orchestrator/images/boat-snapshot.sh cursor amp    # only these
#   DRY_RUN=1 orchestrator/images/boat-snapshot.sh                            # print the plan only
#
# Per harness, over the REST API (https://docs.boat.dev/api/v1, curl + node only):
#   1. POST /sandboxes {type, ttlSeconds, noEnv:true}         fresh VM, no account env/secrets  (Idempotency-Key)
#   2. GET  /sandboxes/{id} until ready|idle|running
#   3. PUT  /sandboxes/{id}/files  boat-setup/_common.sh + boat-setup/<harness>.sh  -> /tmp/octi-setup/
#   4. POST /sandboxes/{id}/commands  bash /tmp/octi-setup/<harness>.sh <version>   (sync, <= 600s)
#   5. remove /tmp/octi-setup, then POST /named-snapshots {sandboxId, name: image.boat_snapshot}
#   6. GET  /named-snapshots/{name} until status ready (or failed)
#   7. DELETE /sandboxes/{id}  (X-Ascii-Confirm-Delete)  - the named snapshot survives deleting its source
# Re-saving an existing name replaces it only once the new save is ready, so a failed re-bake never breaks
# the snapshot workers are deploying from. No API keys are passed into the VM; nothing secret is captured.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${REGISTRY:-$HERE/../../harnesses/registry.json}"
API="${BOAT_API_URL:-https://boat.dev/api/v1}"
SIZE="${BOAT_SANDBOX_SIZE:-default}"
[ -n "${DRY_RUN:-}" ] || [ -n "${BOAT_API_KEY:-}" ] || { echo "BOAT_API_KEY is required" >&2; exit 1; }

# json <expr> : evaluate a JS expression against stdin JSON (`j`), print the result.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=s?JSON.parse(s):null;const v=eval(process.argv[1]);process.stdout.write(v==null?"":typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

boat() { # boat <METHOD> <path> [json-body] [extra curl args...]
  local m="$1" p="$2" body="${3:-}"; shift 3 2>/dev/null || shift $#
  local args=(-sS -X "$m" -H "Authorization: Bearer $BOAT_API_KEY" -H "Accept: application/json" "$@")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" --data-binary "$body")
  curl --fail-with-body "${args[@]}" "$API$p"
}

mapfile -t ROWS < <(node -e '
  const reg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const seen = new Set();
  for (const a of reg.agents) if (a.enabled && !seen.has(a.harness)) {
    seen.add(a.harness);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(a.image.boat_snapshot)) { console.error(`bad snapshot name ${a.image.boat_snapshot}`); process.exit(1); }
    console.log([a.harness, a.harness_version, a.image.boat_snapshot].join("\t"));
  }' "$REGISTRY")

bake() {
  local harness="$1" version="$2" name="$3" setup="$HERE/boat-setup/$1.sh" id="" st res
  [ -f "$setup" ] || { echo "no $setup" >&2; return 1; }
  echo "==> $harness $version -> boat snapshot '$name'"
  if [ -n "${DRY_RUN:-}" ]; then echo "    would run boat-setup/$harness.sh $version in a fresh $SIZE VM and save '$name'"; return 0; fi

  res="$(boat POST /sandboxes "{\"type\":\"$SIZE\",\"ttlSeconds\":3600,\"noEnv\":true}" -H "Idempotency-Key: octi-bake-$name-$(date +%s)")"
  id="$(printf '%s' "$res" | json 'j.sandbox?.id ?? j.id')"
  [ -n "$id" ] || { echo "create failed: $res" >&2; return 1; }
  # Always delete the build VM, whatever happens below.
  # (The RETURN trap clears itself so it fires once, when bake returns.)
  trap "trap - RETURN; echo '    deleting sandbox $id'; boat DELETE /sandboxes/$id '' -H 'X-Ascii-Confirm-Delete: $id' >/dev/null 2>&1 || true" RETURN
  echo "    sandbox $id"
  for _ in $(seq 1 100); do
    st="$(boat GET "/sandboxes/$id" | json 'j.sandbox?.state ?? j.state')"
    case "$st" in ready|idle|running) break;; error|cancelled) echo "sandbox $st" >&2; return 1;; esac
    sleep 3
  done

  for f in _common.sh "$harness.sh"; do
    boat PUT "/sandboxes/$id/files" "$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({path:"/tmp/octi-setup/"+process.argv[2],content:fs.readFileSync(process.argv[1],"utf8")}))' "$HERE/boat-setup/$f" "$f")" >/dev/null
  done
  res="$(boat POST "/sandboxes/$id/commands" "{\"command\":\"bash /tmp/octi-setup/$harness.sh '$version' && rm -rf /tmp/octi-setup\",\"timeoutSeconds\":590}" -m 700)"
  echo "$res" | json '(j.stderr||"").split("\n").filter(l=>l.includes("[octillion-setup]")).join("\n")' | sed 's/^/    /'
  [ "$(echo "$res" | json 'String(j.exitCode)')" = "0" ] || { echo "setup failed: $(echo "$res" | json 'j.stderr?.slice(-2000)')" >&2; return 1; }

  boat POST /named-snapshots "{\"sandboxId\":\"$id\",\"name\":\"$name\"}" >/dev/null
  for _ in $(seq 1 200); do
    res="$(boat GET "/named-snapshots/$name")"
    st="$(echo "$res" | json 'j.snapshot?.status ?? j.status')"
    case "$st" in ready) echo "    snapshot $name ready ($(echo "$res" | json 'j.snapshot?.snapshotId ?? j.snapshotId'))"; return 0;;
                  failed) echo "snapshot failed: $(echo "$res" | json 'j.snapshot?.error ?? j.error')" >&2; return 1;; esac
    sleep 6
  done
  echo "snapshot $name still saving after 20 min" >&2; return 1
}

WANT=("$@"); fail=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r harness version name <<<"$row"
  if [ "${#WANT[@]}" -gt 0 ] && [[ ! " ${WANT[*]} " == *" $harness "* ]]; then continue; fi
  bake "$harness" "$version" "$name" || { echo "!! $harness failed" >&2; fail=1; }
done
exit $fail
