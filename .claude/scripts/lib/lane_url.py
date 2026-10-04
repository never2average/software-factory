#!/usr/bin/env python3
"""The deployed address of an application, per deploy target: one reading, for the factory's own scripts.

  lane_url.py <app_id>             the URL alone
  lane_url.py <app_id> --harness   the browser harness arguments: `--url <url>`

Exit 0 with the answer on stdout, or exit 1 with one sentence on stderr.

  target vercel     infrastructure.vercel.production_url.
  target vm_remote  infrastructure.vm_remote.production_url, and only when it is https://<vm_remote.domain> and
                    infrastructure.deployed_at is recorded: both are written by provision.py --deploy-remote after
                    the deployed app answered its health checks, so a URL someone typed is never read as this
                    app (factory.py validate refuses that state too; the reader does not trust the validator alone).
  target vm         no URL.

WHO USES IT. lanes.py for the {url} placeholder, and mint.py / mint_report.py / mint_handoff.py / agent_cli.py for
"where does this application live" (target_url below). The lane CHECKS do not: since mold_v1-154 each lane decides
what it grades in its own folder (molds/<mold>/testing/<lane>/lane-url.py, functional/tenant-isolation.py), under
the same rule, and lanes.py no longer points their calls here. The vm_remote self-test holds the three readings
to one answer over the same set of states.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

def target_url(infra):
    """The deployed URL the lanes grade, or "" when this application has none."""
    infra = infra or {}; t = infra.get("target")
    if t == "vm_remote":
        vr = infra.get("vm_remote") or {}
        url = (vr.get("production_url") or "").strip().rstrip("/")
        if url and vr.get("domain") and url == f"https://{vr['domain']}" and infra.get("deployed_at"): return url
        return ""
    return ((infra.get("vercel") or {}).get("production_url") or "").strip().rstrip("/")

def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    app_id, harness = a[0], "--harness" in a[1:]
    try: infra = json.load(open(os.path.join(ROOT, "state/application", app_id, "infrastructure.json")))
    except Exception:
        print(f"{app_id}: state/application/{app_id}/infrastructure.json is missing or unreadable, so there is no application to measure.", file=sys.stderr); return 1
    url = target_url(infra)
    if not url:
        how = ("python3 .claude/scripts/provision.py %s --deploy-remote" if infra.get("target") == "vm_remote" else "python3 .claude/scripts/provision.py %s --deploy") % app_id
        print(f"{app_id}: this application has no deployed address yet, and this check grades the running app. Deploy it first: {how}", file=sys.stderr); return 1
    print(f"--url {url}" if harness else url); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
