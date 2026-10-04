#!/usr/bin/env python3
"""The functional lane's tenant-isolation rows. One command, two rows, one exit code.

  python3 molds/mold_v1/testing/functional/tenant-isolation.py <app_id>
  python3 molds/mold_v1/testing/functional/tenant-isolation.py <app_id> --deployed   exit 0 when the app has a deployed
                                                                                      address to read (the `rls` check's
                                                                                      precondition), else exit 1; prints nothing

WHY THIS EXISTS. The lane report for claudecode_web_replica printed

  | health.db | pass | ok=true, 94-123 ms: "SELECT 1 ok · role postgres — WARNING: BYPASSRLS,
                                            row-level security is NOT enforced..."

`pass`, quoting the warning verbatim, because the row graded on `ok=true` — and the mold's health
check returns that warning as a `detail` string on a RESOLVED check, so neither the aggregate `ok`
nor the HTTP status moves. Meanwhile the lane README claimed the verify-apprw gate ran; no such row
existed in the executed run. A lane that can print `pass` next to "row-level security is NOT
enforced" is not measuring the thing it names.

So this emits two rows that cannot be satisfied by a status code:

  rls.isolation  — provision.py --verify-rls --no-repair: connect as the app role on the app's own
                   deployed DATABASE_URL, and show that every org-scoped table is enabled+forced+
                   policied, that a cross-workspace read returns nothing and that a cross-workspace
                   write is refused with SQLSTATE 42501. MEASURE ONLY: the lane never repairs.
  rls.health     — the DEPLOYED app's health body must not say BYPASSRLS. The stored DATABASE_URL
                   passing the gate is a different fact from the RUNNING build using it: a Vercel env
                   change only takes effect on the next build, so this row is the one that covers the
                   process actually serving traffic. WHICH ADDRESS depends on the deploy target
                   (deployed_url below): vercel.production_url for a Vercel app; for an app on a server
                   of its own (`target: vm_remote`) vm_remote.production_url, once a deploy recorded it
                   (mold_v1-154: this row used to read the vercel block only and so printed
                   "skipped: no production_url" for every vm_remote app, measuring nothing).

An app whose datastores.postgres.rls is "off" gets `skipped`, not `pass`. An app whose datastores.json
never declares postgres.rls at all gets `fail`: the schema does not require the key, so ABSENT used to
read as "off" here and skip the whole verdict with a detail line asserting a declaration that was never
made (mold_v1-052). Absent is unmeasured, and unmeasured is one instruction, never a silent skip.
"""
import json, os, subprocess, sys, urllib.request
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../.."))

def deployed_url(infra):
    """The address of the app in front of traffic, per deploy target; "" when it has none.
    vm_remote: vm_remote.production_url, only when it is https://<vm_remote.domain> and infrastructure.deployed_at is
    recorded (both written by provision.py --deploy-remote after the app answered; a typed URL is never read as this
    app). Every other target: vercel.production_url, as before (a `target: vm` app has none)."""
    infra = infra or {}
    if infra.get("target") == "vm_remote":
        vr = infra.get("vm_remote") or {}
        url = (vr.get("production_url") or "").strip().rstrip("/")
        return url if url and vr.get("domain") and url == f"https://{vr['domain']}" and infra.get("deployed_at") else ""
    return ((infra.get("vercel") or {}).get("production_url") or "").rstrip("/")

def health_row(url, opener=None):
    """("rls.health", pass|fail, detail) from the health body of the app at `url`."""
    try:
        body = (opener or urllib.request.urlopen)(f"{url}/api/ops/health", timeout=25).read().decode()[:4000]
    except Exception as e:
        body = getattr(e, "file", None) and e.read().decode()[:4000] or f"unreachable: {e}"
    db = ""
    try: db = json.dumps(json.loads(body).get("db", {}))[:300]
    except Exception: db = body[:300]
    leak = "BYPASSRLS" in db or "NOT enforced" in db
    return ("rls.health", "fail" if leak else "pass", db)

def main(a):
    if not a: sys.exit(__doc__)
    app_id = a[0]; adir = os.path.join(ROOT, "state/application", app_id)
    infra = json.load(open(os.path.join(adir, "infrastructure.json")))
    if "--deployed" in a[1:]: sys.exit(0 if deployed_url(infra) else 1)
    ds = json.load(open(os.path.join(adir, "datastores.json")))
    want = ds.get("postgres", {}).get("rls")   # no default: ABSENT is not "off" (see the docstring)
    rows, ok = [], True
    if want is None:
        # The safe value: nothing declared means nothing asked for, nothing measured, and no row may say otherwise.
        rows.append(("rls.isolation", "fail", f'datastores.postgres.rls is ABSENT: set it to "fail_closed" or "on" in state/application/{app_id}/datastores.json, then run python3 .claude/scripts/lanes.py {app_id} --lane functional'))
        ok = False
    elif want == "off":
        rows.append(("rls.isolation", "skipped", 'datastores.postgres.rls is "off": this app did not ask for tenant isolation'))
    else:
        r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/provision.py"), app_id, "--verify-rls", "--no-repair"],
                           capture_output=True, text=True)
        line = next((l for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith("isolation proof:")), "")
        detail = line.split("isolation proof:", 1)[-1].strip() or (r.stdout + r.stderr).strip().splitlines()[-1][:300]
        rows.append(("rls.isolation", "pass" if r.returncode == 0 else "fail", detail[:400]))
        ok &= r.returncode == 0
    url = deployed_url(infra)
    if not url:
        rows.append(("rls.health", "skipped", "no production_url in infrastructure.json"))
    else:
        row = health_row(url)
        rows.append(row)
        ok &= row[1] == "pass"
    w = max(len(x[0]) for x in rows)
    print("| check | result | detail |"); print("|---|---|---|")
    for n, s, d in rows: print(f"| {n.ljust(w)} | {s} | {d.replace('|', '/')} |")
    sys.exit(0 if ok else 1)

if __name__ == "__main__": main(sys.argv[1:])
