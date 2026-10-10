#!/usr/bin/env python3
"""Rehearsal stand-ins for provision.py's release self-test (--self-test): vercel, curl, http and gh, one file.

The self-test links each name to this file in <FACTORY_REHEARSAL>/bin (lib/services.py puts that first on PATH). The
whole outside world is <FACTORY_REHEARSAL>/world.json:

  projects   {name: {id, auto, prod, env: {NAME: 1}, deps: [{uid, created, state, fault}]}}   Vercel, as far as the
             deploy, the rollback and the promote go. A rollback sets auto false (as Vercel does); a promote sets it
             back. A deployment is put in front of traffic by itself only while auto is true.
  fault      {project: "build" | "health" | "chat"}   the NEXT deployment of that project fails its build, answers
             health 500, or fails every chat turn. Used once.
  ci         "green" | "red" | "pending"              the mold source's CI for any commit (gh api)
  token, memberships                                  the fake app's one session and the operator's workspaces
Every call is appended to world.json.calls. Nothing leaves the machine.
"""
import json, os, re, sys, time

REH = os.environ["FACTORY_REHEARSAL"]
W = os.path.join(REH, "world.json")
NAME = os.path.basename(sys.argv[0]); A = sys.argv[1:]


def load(): return json.load(open(W)) if os.path.exists(W) else {}
def save(w): json.dump(w, open(W, "w"), indent=1)
def log(**kw): open(W + ".calls", "a").write(json.dumps(dict({"tool": NAME, "argv": A}, **kw)) + "\n")
def opt(k): return A[A.index(k) + 1] if k in A and A.index(k) + 1 < len(A) else None
def proj_by_id(w, pid): return next((n for n, p in w["projects"].items() if p["id"] == pid or n == pid), None)


def meta(n, p):
    prod = next((d for d in p["deps"] if d["uid"] == p.get("prod")), None)
    return {"id": p["id"], "name": n, "autoAssignCustomDomains": p.get("auto", True), "link": None,
            "targets": {"production": {"id": prod["uid"], "createdAt": prod["created"], "readyState": prod["state"]}} if prod else {}}


def vercel():
    w = load(); w.setdefault("projects", {}); cmd = A[0] if A else ""
    log()
    if cmd == "api":
        path, method = A[1], (opt("-X") or "GET")
        m = re.match(r"^/v\d+/projects/([^/?]+)$", path)
        if m:
            n = proj_by_id(w, m.group(1))
            if not n: print('{"error": {"code": "not_found", "message": "Project not found"}}'); return 1
            print(json.dumps(meta(n, w["projects"][n]))); return 0
        m = re.match(r"^/v\d+/projects/([^/?]+)/env$", path)
        if m:
            n = proj_by_id(w, m.group(1))
            if method == "POST":
                body = json.loads(sys.stdin.read() or "{}"); w["projects"][n]["env"][body["key"]] = 1; save(w)
                print(json.dumps({"created": {"key": body["key"]}})); return 0
            print(json.dumps({"envs": [{"key": k, "type": "encrypted", "target": ["production"]} for k in w["projects"][n]["env"]]})); return 0
        m = re.match(r"^/v6/deployments\?projectId=([^&]+)", path)
        if m:
            p = w["projects"][proj_by_id(w, m.group(1))]
            print(json.dumps({"deployments": [{"uid": d["uid"], "created": d["created"], "state": d["state"], "target": "production"}
                                              for d in sorted(p["deps"], key=lambda d: -d["created"])]})); return 0
        m = re.match(r"^/v\d+/projects/([^/]+)/(rollback|promote)/([^/?]+)$", path)
        if m and method == "POST":
            n = proj_by_id(w, m.group(1)); p = w["projects"][n]
            if not any(d["uid"] == m.group(3) and d["state"] == "READY" for d in p["deps"]):
                print('{"error": {"message": "deployment not found"}}'); return 1
            p["prod"] = m.group(3); p["auto"] = m.group(2) == "promote"; save(w); return 0
        if path.startswith("/v1/storage/stores"): print('{"stores": []}'); return 0
        print("{}"); return 0
    if cmd == "env":
        p = w["projects"].get(opt("--project") or "")
        if A[1:2] == ["ls"]:
            for k in sorted((p or {}).get("env", {})): print(f"{k:40} Encrypted   Production   1d ago")
            return 0
        if A[1:2] == ["rm"] and p: p["env"].pop(A[2], None); save(w)
        return 0
    if cmd == "project" and A[1:2] == ["add"]:
        w["projects"].setdefault(A[2], {"id": "prj_" + A[2], "auto": True, "prod": None, "env": {}, "deps": []}); save(w)
        print(f"Success! Project {A[2]} added"); return 0
    if cmd == "integration": print('{"resources": []}'); return 0
    if cmd == "deploy":
        n = opt("--project"); p = w["projects"][n]
        fault = (w.get("fault") or {}).pop(n, None); save(w)
        uid = f"dpl_{n}_{len(p['deps']) + 1}"
        print(f"Deploying {n}\nProduction: https://{n}-{len(p['deps']) + 1}.rehearsal.invalid")
        if fault == "build":
            p["deps"].append({"uid": uid, "created": time.time() * 1000, "state": "ERROR"}); save(w)
            print("Error: the build failed (rehearsal)", file=sys.stderr); return 1
        p["deps"].append({"uid": uid, "created": time.time() * 1000, "state": "READY", "fault": fault})
        if p.get("auto", True): p["prod"] = uid
        save(w); print(f"Aliased: https://{n}.rehearsal.invalid"); return 0
    return 0


def app(method, url, headers, body):
    m = re.match(r"^https://([a-z0-9-]+)\.rehearsal\.invalid(/[^?#]*)?", url or "")
    if not m: return None
    w = load(); n, path = m.group(1), (m.group(2) or "/")
    p = w.get("projects", {}).get(n)
    prod = next((d for d in (p or {}).get("deps", []) if d["uid"] == (p or {}).get("prod")), None)
    if not prod: return 404, {"error": "DEPLOYMENT_NOT_FOUND"}
    if path in ("/api/health", "/eve/v1/health", "/api/ops/health"):
        if prod.get("fault") == "health": return 500, {"ok": False, "error": "rehearsal: this deployment is broken"}
        return 200, ({"ok": True, "db": {"ok": True, "detail": "SELECT 1 ok · role app_rw (RLS enforced)"}} if path == "/api/ops/health" else {"ok": True})
    if headers.get("authorization") != "Bearer " + str(w.get("token")): return 401, {"error": "Unauthorized"}
    if path == "/api/ops/me/workspaces": return 200, {"memberships": w.get("memberships", [])}
    if path == "/eve/v1/session" and method == "POST": return 200, {"sessionId": "ses_" + str(int(time.time() * 1000))}
    if path.endswith("/stream"):
        broken = any(next((d for d in w["projects"].get(x, {}).get("deps", []) if d["uid"] == w["projects"].get(x, {}).get("prod")), {}).get("fault") == "chat"
                     for x in (n, n + "-api"))
        if broken: return 200, {"events": [{"type": "turn.started"}, {"type": "turn.failed", "data": {"error": "rehearsal: the model is not wired"}}]}
        return 200, {"events": [{"type": "turn.started"}, {"type": "message.completed", "data": {"message": "4"}}, {"type": "turn.completed"}]}
    if path == "/api/ops/chat-sessions" and method == "DELETE": return 200, {"ok": True}
    return 404, {"error": "not found"}


def curl():
    url = next((a for a in A if a.startswith("http")), ""); fmt = opt("-w")
    r = app("GET", url, {}, None); log(url=url)
    if r is None: print(f"curl: (6) Could not resolve host", file=sys.stderr); return 6
    sys.stdout.write(json.dumps(r[1]) + (fmt or "").replace("\\n", "\n").replace("%{http_code}", str(r[0]))); return 0


def http():
    method, url = A[0], A[1]
    h = json.loads(os.environ.get("FACTORY_HTTP_HEADERS") or "{}")
    raw = sys.stdin.read(); body = json.loads(raw) if raw.strip() else None
    r = app(method, url, h, body); log(method=method, url=url, org=h.get("x-ops-org"))
    if r is None: print(json.dumps({"status": 0, "body": {"error": "could not resolve host (rehearsal)"}})); return 1
    print(json.dumps({"status": r[0], "body": r[1]})); return 0


CI = "jobs:\n  verify:\n    runs-on: x\n  build:\n    runs-on: x\n"


def gh():
    import base64
    w = load(); ci = w.get("ci", "green"); path = A[-1]; log()
    if "/actions/runs" in path:
        st, con = ("in_progress", None) if ci == "pending" else ("completed", "failure" if ci == "red" else "success")
        sha = re.search(r"head_sha=([0-9a-f]+)", path).group(1)
        print(json.dumps({"workflow_runs": [{"id": 1, "path": ".github/workflows/ci.yml", "head_sha": sha, "status": st, "conclusion": con,
                                             "check_suite_id": 5, "event": "push"}]})); return 0
    if "/check-runs" in path:
        bad = {"red": ("completed", "failure"), "pending": ("in_progress", None)}.get(ci, ("completed", "success"))
        print(json.dumps({"check_runs": [{"name": "verify", "status": "completed", "conclusion": "success", "check_suite": {"id": 5}},
                                         {"name": "build", "status": bad[0], "conclusion": bad[1], "check_suite": {"id": 5}}]})); return 0
    if "/contents/" in path: print(json.dumps({"content": base64.b64encode(CI.encode()).decode()})); return 0
    return 1


if __name__ == "__main__":
    sys.exit({"vercel": vercel, "curl": curl, "http": http, "gh": gh}.get(NAME, lambda: (log(), 1)[1])())
