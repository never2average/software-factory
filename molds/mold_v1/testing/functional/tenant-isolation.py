#!/usr/bin/env python3
"""The functional lane's tenant-isolation rows. One command, two rows, one exit code.

  python3 molds/mold_v1/testing/functional/tenant-isolation.py <app_id>
  python3 molds/mold_v1/testing/functional/tenant-isolation.py <app_id> --deployed   exit 0 when the app has a deployed
                                                                                      address to read (the `rls` check's
                                                                                      precondition), else exit 1; prints nothing
  python3 molds/mold_v1/testing/functional/tenant-isolation.py --self-test           the rls.health row against a stand-in
                                                                                      server on loopback; touches no app

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
  rls.health     — the DEPLOYED app's health body must SAY row-level security is enforced: HTTP 200, the app's own
                   health document, and its "role <name> (RLS enforced)" sentence. An app that does not answer, any
                   other status, a body that is not JSON or carries no database check is `fail` with the reason,
                   never `pass` (mold_v1-159: the row used to fail only on a body that said BYPASSRLS, so an
                   UNREACHABLE app read `pass`). An app with no deployed address yet is `skipped`. The stored DATABASE_URL
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
import contextlib, io, json, os, re, subprocess, sys, tempfile, threading, urllib.error, urllib.request
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

# The mold's ONE affirmative sentence (app/api/ops/health/route.ts: `SELECT 1 ok · role ${role} (RLS enforced)`), printed
# only when the role the serving process is connected as has rolbypassrls = false. provision.py's RLS_ENFORCED_DETAIL is
# the same pattern; this lane folder keeps its own copy so it stays self-contained.
ENFORCED = re.compile(r"role\s+(\S+)\s+\(RLS enforced\)")
NOT_ENFORCED = re.compile(r"BYPASSRLS|NOT enforced", re.I)
HEALTH = "/api/ops/health"

def health_row(url, opener=None):
    """("rls.health", pass|fail, detail) from the health body of the app at `url`.

    `pass` is EARNED, by one thing only: HTTP 200, a JSON health document, a database check that is ok, and the mold's own
    "role <name> (RLS enforced)" sentence in db.detail. Every other outcome is `fail` with one plain reason (mold_v1-159).
    This row used to fail only on a body that said BYPASSRLS, so an app that did not answer at all, a 500, a 404 page from
    whatever else holds the address and a sign-in wall all read `pass`: an endpoint is unreadable exactly when a deploy
    has gone wrong, which is exactly when this row is consulted. A body that says row-level security is not enforced is
    reported as that whatever the status code was."""
    at = f"{url}{HEALTH}"
    try:
        r = (opener or urllib.request.urlopen)(at, timeout=25)
        code, raw = getattr(r, "status", None), r.read()
    except urllib.error.HTTPError as e:
        code = e.code
        try: raw = e.read()
        except Exception: raw = b""
    except Exception as e:
        why = str(getattr(e, "reason", "") or e).strip() or type(e).__name__
        return ("rls.health", "fail", f"{at} did not answer ({why[:160]}), so nothing says whether the running app enforces row-level security")
    body = (raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw or ""))[:4000]
    try: doc = json.loads(body)
    except Exception: doc = None
    db = doc.get("db") if isinstance(doc, dict) and isinstance(doc.get("db"), dict) else None
    det = db.get("detail") if db else None
    det = det if isinstance(det, str) and det.strip() else None
    shown = json.dumps(db)[:300] if db else ""
    if det and NOT_ENFORCED.search(det): return ("rls.health", "fail", shown)
    if code != 200:
        return ("rls.health", "fail", f"{at} answered HTTP {code}, not 200, so the running app's health was not read" + (f"; its body said {shown}" if shown else ""))
    if not isinstance(doc, dict):
        start = " ".join(body.split())[:60]
        return ("rls.health", "fail", f"{at} answered 200 but the body is not the app's health document (it is not JSON; it starts {start!r}), so something else is answering at this address")
    if not det:
        return ("rls.health", "fail", f"{at} answered 200 but its body carries no database check (no db.detail), so it says nothing about row-level security")
    if not db.get("ok"):
        return ("rls.health", "fail", f"the running app could not reach its database, so row-level security was not read: {shown}")
    if not ENFORCED.search(det):
        return ("rls.health", "fail", f"the database check reads {det[:120]!r}, which is not the app's own \"role <name> (RLS enforced)\" sentence, so it names no role and settles nothing")
    return ("rls.health", "pass", shown)

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

def self_test(row=None):
    """The rls.health row against a stand-in HTTP server on loopback (and a closed port); nothing else is contacted.
    `row` is the function graded (default: this file's health_row), so the same cases can be replayed on another version."""
    import http.server, socket
    row = row or health_row
    ok_doc = {"ok": True, "db": {"ok": True, "detail": "SELECT 1 ok · role app_rw (RLS enforced)"}}
    bad_doc = {"ok": True, "db": {"ok": True, "detail": "SELECT 1 ok · role postgres — WARNING: BYPASSRLS, row-level security is NOT enforced (point DATABASE_URL at app_rw)"}}
    J = "application/json"
    pages = {"/enforced": (200, J, json.dumps(ok_doc)), "/bypass": (200, J, json.dumps(bad_doc)),
             "/crash": (500, "text/plain", "Internal Server Error"), "/crash-json": (500, J, json.dumps(ok_doc)),
             "/down": (503, J, json.dumps({"ok": False, "db": {"ok": False, "detail": "connect ECONNREFUSED"}})),
             "/down-bypass": (503, J, json.dumps(bad_doc)), "/wall": (401, "text/html", "<html>Authentication Required</html>"),
             "/html": (200, "text/html", "<!doctype html><html><body>Welcome to nginx</body></html>"),
             "/empty": (200, J, ""), "/list": (200, J, "[1, 2]"), "/nodb": (200, J, json.dumps({"ok": True})),
             "/nodetail": (200, J, json.dumps({"ok": True, "db": {"ok": True}})),
             "/dbdown": (200, J, json.dumps({"ok": False, "db": {"ok": False, "detail": "connect ECONNREFUSED 127.0.0.1:5432"}})),
             "/vague": (200, J, json.dumps({"ok": True, "db": {"ok": True, "detail": "SELECT 1 ok"}}))}
    seen = []
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path); prefix = self.path[:-len(HEALTH)] if self.path.endswith(HEALTH) else None
            code, ctype, body = pages.get(prefix, (404, "text/plain", "not found"))
            self.send_response(code); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body.encode()))); self.end_headers()
            self.wfile.write(body.encode())
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); base = f"http://127.0.0.1:{srv.server_address[1]}"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    s = socket.socket(); s.bind(("127.0.0.1", 0)); closed = f"http://127.0.0.1:{s.getsockname()[1]}"; s.close()   # nothing listens here
    fails, n = [], [0]
    def check(name, cond, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{name}: {str(detail)[:300]}")
    def want(name, target, result, *says):
        r = row(target)
        check(name, r[0] == "rls.health" and r[1] == result and all(x in r[2] for x in says), r)
    tmp = tempfile.mkdtemp(prefix="tenant-isolation-selftest-")
    global ROOT
    real_root = ROOT
    try:
        want("200 with the app's own enforced sentence is pass", base + "/enforced", "pass", "RLS enforced")
        want("200 that says row-level security is not enforced is fail, quoting the body", base + "/bypass", "fail", "BYPASSRLS")
        want("500 is fail", base + "/crash", "fail", "HTTP 500")
        want("500 is fail even when its body carries the enforced sentence", base + "/crash-json", "fail", "HTTP 500")
        want("503 with the database down is fail", base + "/down", "fail", "HTTP 503")
        want("a non-200 whose body says not enforced is reported as not enforced", base + "/down-bypass", "fail", "BYPASSRLS")
        want("a sign-in wall (401) is fail", base + "/wall", "fail", "HTTP 401")
        want("404 (nothing of this app at the address) is fail", base + "/nowhere", "fail", "HTTP 404")
        want("connection refused is fail, with a plain reason", closed, "fail", "did not answer")
        want("200 with an HTML body is fail", base + "/html", "fail", "not JSON")
        want("200 with an empty body is fail", base + "/empty", "fail", "not JSON")
        want("200 with JSON that is not a document is fail", base + "/list", "fail", "not the app's health document")
        want("200 with no db block is fail", base + "/nodb", "fail", "no database check")
        want("200 with a db block and no detail is fail", base + "/nodetail", "fail", "no database check")
        want("200 whose database check failed is fail", base + "/dbdown", "fail", "could not reach its database")
        want("200 whose detail names no role is fail (a pass is earned, not assumed)", base + "/vague", "fail", "settles nothing")
        check("every case asked the health path and nothing else", seen and all(p.endswith(HEALTH) for p in seen), seen)
        # main(): the row in the table and the exit code, on fixture state (rls "off", so no database is involved)
        ROOT = tmp
        def app(name, url):
            d = os.path.join(tmp, "state/application", name); os.makedirs(d)
            json.dump({"target": "vercel", "vercel": {"project": "x", **({"production_url": url} if url else {})}}, open(os.path.join(d, "infrastructure.json"), "w"))
            json.dump({"postgres": {"rls": "off"}}, open(os.path.join(d, "datastores.json"), "w"))
        def run(name):
            buf = io.StringIO(); code = 0
            with contextlib.redirect_stdout(buf):
                try: main([name])
                except SystemExit as e: code = e.code
            return code, buf.getvalue()
        if row is health_row:
            app("none", ""); app("up", base + "/enforced"); app("gone", closed); app("crash", base + "/crash")
            before = len(seen); code, out = run("none")
            check("no production_url yet is `skipped`, asks nothing, and does not fail the check", code == 0 and "| rls.health    | skipped | no production_url" in out and len(seen) == before, (code, out))
            code, out = run("up"); check("main: an enforced app's row is pass and the exit is 0", code == 0 and "| rls.health    | pass |" in out, (code, out))
            code, out = run("gone"); check("main: an unreachable app's row is fail and the exit is 1", code == 1 and "| rls.health    | fail |" in out and "did not answer" in out, (code, out))
            code, out = run("crash"); check("main: a 500's row is fail and the exit is 1", code == 1 and "| rls.health    | fail |" in out, (code, out))
    finally:
        ROOT = real_root; srv.shutdown(); srv.server_close()
        import shutil; shutil.rmtree(tmp, ignore_errors=True)
    if fails:
        print("tenant-isolation self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"tenant-isolation self-test ok: {n[0]} checks (the rls.health row against a stand-in server on loopback: enforced, not enforced, "
          f"500, 503, 401, 404, connection refused, HTML, empty, no database check, no role named; no address yet is skipped)"); return 0

if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    main(sys.argv[1:])
