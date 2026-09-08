#!/usr/bin/env python3
"""The functional lane's tenant-isolation rows. One command, two rows, one exit code.

  python3 molds/mold_v1/testing/functional/tenant-isolation.py <app_id> [--report]

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
                   process actually serving traffic.

An app whose datastores.postgres.rls is "off" gets `skipped`, not `pass`.
"""
import json, os, subprocess, sys, urllib.request
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../.."))

def main(a):
    if not a: sys.exit(__doc__)
    app_id = a[0]; adir = os.path.join(ROOT, "state/application", app_id)
    ds = json.load(open(os.path.join(adir, "datastores.json")))
    infra = json.load(open(os.path.join(adir, "infrastructure.json")))
    want = ds.get("postgres", {}).get("rls", "off")
    rows, ok = [], True
    if want == "off":
        rows.append(("rls.isolation", "skipped", 'datastores.postgres.rls is "off": this app did not ask for tenant isolation'))
    else:
        r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/provision.py"), app_id, "--verify-rls", "--no-repair"],
                           capture_output=True, text=True)
        line = next((l for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith("isolation proof:")), "")
        detail = line.split("isolation proof:", 1)[-1].strip() or (r.stdout + r.stderr).strip().splitlines()[-1][:300]
        rows.append(("rls.isolation", "pass" if r.returncode == 0 else "fail", detail[:400]))
        ok &= r.returncode == 0
    url = (infra.get("vercel", {}).get("production_url") or "").rstrip("/")
    if not url:
        rows.append(("rls.health", "skipped", "no production_url in infrastructure.json"))
    else:
        try:
            body = urllib.request.urlopen(f"{url}/api/ops/health", timeout=25).read().decode()[:4000]
        except Exception as e:
            body = getattr(e, "file", None) and e.read().decode()[:4000] or f"unreachable: {e}"
        db = ""
        try: db = json.dumps(json.loads(body).get("db", {}))[:300]
        except Exception: db = body[:300]
        leak = "BYPASSRLS" in db or "NOT enforced" in db
        rows.append(("rls.health", "fail" if leak else "pass", db))
        ok &= not leak
    w = max(len(x[0]) for x in rows)
    print("| check | result | detail |"); print("|---|---|---|")
    for n, s, d in rows: print(f"| {n.ljust(w)} | {s} | {d.replace('|', '/')} |")
    sys.exit(0 if ok else 1)

if __name__ == "__main__": main(sys.argv[1:])
