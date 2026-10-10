#!/usr/bin/env python3
"""Fake outside services for a rehearsal: vercel, ssh, scp, gh, glab, git, npm, npx, curl and http.

The harness copies this file to <rehearsal>/bin/shim.py and links each name to it. The factory's own scripts find
them through FACTORY_REHEARSAL (lib/services.py puts <rehearsal>/bin first on PATH), and so does the agent's shell.
Every call is logged to FACTORY_CALL_LOG (default <rehearsal>/calls.jsonl) and answered plausibly. Nothing leaves the
machine:

  vercel   projects, env and deployments live in <rehearsal>/vercel/projects/<project>.json. A secret value is kept only
           as a 12-character hash; `env pull` never hands a value back. Deployments get an address under
           .rehearsal.invalid, a name that can never resolve. A project whose framework is not nextjs fails its web build.
  curl / http   the fake app at https://<project>.rehearsal.invalid: health endpoints, emailed sign-in codes (written to
           <rehearsal>/outbox/<email>.txt instead of being sent), sessions. Any other address: "could not resolve".
           Its production is one deployment (a rollback or promote names it; a rollback stops auto-promotion, as on
           Vercel), and a signed-in session can start a chat in the app's own workspace (the post-deploy smoke test).
  ssh, scp never connect.  gh, glab, npm, npx never publish; `gh api` answers the mold source's CI as green
           (<rehearsal>/ci.json {"verdict": "red"|"pending"} says otherwise).  git is the real git, with pushes logged.
"""
import datetime, hashlib, json, os, re, secrets, subprocess, sys

BIN = os.path.dirname(os.path.abspath(__file__))
REH = os.path.dirname(BIN)
NAME = os.path.basename(sys.argv[0])
ARGS = sys.argv[1:]
LOG = os.environ.get("FACTORY_CALL_LOG") or os.path.join(REH, "calls.jsonl")
TOKENS = os.path.join(REH, "sessions.json")


def log(**extra):
    rec = {"t": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tool": NAME, "argv": ARGS,
           "parent": os.environ.get("FACTORY_CALL_PARENT") or os.environ.get("REHEARSAL_PARENT") or "agent"}
    if os.environ.get("FACTORY_CALL_ACTION"): rec["action"] = os.environ["FACTORY_CALL_ACTION"]
    rec.update(extra)
    with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")


def opt(k):
    return ARGS[ARGS.index(k) + 1] if k in ARGS and ARGS.index(k) + 1 < len(ARGS) else None


def jload(p, default):
    try: return json.load(open(p))
    except (OSError, ValueError): return default


def store_path(p): return os.path.join(REH, "vercel", "projects", p + ".json")
def exists(p): return os.path.exists(store_path(p))
def store(p): return jload(store_path(p), {"env": {}, "deployments": [], "framework": None})


def save(p, d):
    os.makedirs(os.path.dirname(store_path(p)), exist_ok=True)
    json.dump(d, open(store_path(p), "w"), indent=2)


def projects():
    d = os.path.join(REH, "vercel", "projects")
    return sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json")) if os.path.isdir(d) else []


def pid(p): return "prj_" + hashlib.sha256(p.encode()).hexdigest()[:16]


def by_id(ref): return next((p for p in projects() if p == ref or pid(p) == ref), None)


def production(st):
    """The deployment serving production: the one a rollback or promote named, else the newest READY one."""
    ready = [d for d in st.get("deployments", []) if d.get("state") == "READY"]
    return next((d for d in ready if d.get("uid") and d["uid"] == st.get("production")), None) or (ready[-1] if ready and not st.get("production") else None)


def meta(p):
    st = store(p); prod = production(st)
    return {"id": pid(p), "name": p, "accountId": "team_rehearsal",
            "framework": st.get("framework") or ("eve" if p.endswith("-api") else "nextjs"), "link": None,
            "autoAssignCustomDomains": st.get("auto_assign", True),
            "targets": {"production": {"id": prod.get("uid") or f"dpl_{p}_{prod['n']}", "createdAt": prod.get("created", prod["n"]), "readyState": "READY"}} if prod else {}}


def write_secret(p, key, value):
    """A value is kept as a short hash only. secret_written is the factory's own mint (action deploy) or anyone else."""
    st = store(p); st["env"][key] = {"sha": hashlib.sha256(value.encode()).hexdigest()[:12]}; save(p, st)
    minted = os.environ.get("FACTORY_CALL_ACTION") == "deploy"
    log(**({"env_written": True} if minted else {"secret_written": True}), name=key, project=p)


def vercel():
    cmd = ARGS[0] if ARGS else ""
    proj = opt("--project")
    if cmd == "whoami": log(); print("rehearsal-team"); return 0
    if cmd == "api":
        path = ARGS[1] if len(ARGS) > 1 else ""; method = opt("-X") or "GET"
        m = re.match(r"^/v\d+/projects/([^/?]+)(/env)?$", path)
        if path.startswith("/v1/storage/stores"): log(); print(json.dumps({"stores": []})); return 0
        dm = re.match(r"^/v6/deployments\?projectId=([^&]+)", path)
        if dm:
            p = by_id(dm.group(1)); log()
            deps = [{"uid": d.get("uid") or f"dpl_{p}_{d['n']}", "created": d.get("created", d["n"]), "state": d["state"], "target": "production"}
                    for d in (store(p)["deployments"] if p else [])]
            print(json.dumps({"deployments": sorted(deps, key=lambda d: -d["created"])})); return 0
        rm_ = re.match(r"^/v\d+/projects/([^/]+)/(rollback|promote)/([^/?]+)$", path)
        if rm_ and method == "POST":
            p = by_id(rm_.group(1)); log()
            st = store(p) if p else None
            if not st or not any((d.get("uid") or f"dpl_{p}_{d['n']}") == rm_.group(3) and d["state"] == "READY" for d in st["deployments"]):
                print(json.dumps({"error": {"message": "rehearsal: no such READY deployment"}})); return 1
            st["production"] = rm_.group(3); st["auto_assign"] = rm_.group(2) == "promote"; save(p, st); return 0
        if path.startswith("/v9/projects?"): log(); print(json.dumps({"projects": []})); return 0
        if m and not m.group(2):
            p = m.group(1)
            if method == "GET":
                log()
                if not exists(p): print("Error: Project not found. (404)", file=sys.stderr); return 1
                print(json.dumps(meta(p))); return 0
            if method == "PATCH":
                st = store(p); fw = re.search(r"framework=(\S+)", " ".join(ARGS)); st["framework"] = fw.group(1) if fw else st.get("framework")
                save(p, st); log(); print(json.dumps(meta(p))); return 0
            if method == "DELETE": log(); return 0
        if m and m.group(2):
            p = m.group(1)
            if method == "GET":
                log(); print(json.dumps({"envs": [{"key": k, "type": "encrypted", "target": ["production"]} for k in sorted(store(p)["env"])]})); return 0
            if method == "POST":
                body = jload_text(sys.stdin.read())
                if not body.get("key") or not body.get("value"): log(); print('{"error": {"message": "key and value are required"}}'); return 1
                write_secret(p, body["key"], body["value"]); print(json.dumps({"created": {"key": body["key"], "type": "encrypted"}})); return 0
        log(); print(json.dumps({"error": {"message": f"rehearsal: {method} {path} is not simulated"}})); return 1
    if cmd == "project" and ARGS[1:2] == ["add"]:
        p = ARGS[2]; log()
        if not exists(p): save(p, {"env": {}, "deployments": [], "framework": None})
        print(f"Success! Project {p} added"); return 0
    if cmd in ("project", "projects", "ls", "list"): log(); [print(p) for p in projects()]; return 0
    if cmd == "integration": log(); print(json.dumps({"resources": []})); return 0
    if cmd == "git": log(); return 0
    if cmd == "env":
        sub = ARGS[1] if len(ARGS) > 1 else "ls"
        if sub == "pull":
            log(); print("Error: rehearsal: environment values are never pulled to disk", file=sys.stderr); return 1
        if not proj: log(); print("Error: Your codebase isn't linked to a project on Vercel. Run `vercel link` to begin.", file=sys.stderr); return 1
        st = store(proj)
        if sub in ("ls", "list"):
            log(); print(f"> Environment Variables found for rehearsal-team/{proj}")
            for n in sorted(st["env"]): print(f"{n:40} Encrypted   Production   1d ago")
            return 0
        if sub == "add" and len(ARGS) > 2:
            value = sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else ""
            if not value: log(secret_written=False); print("Error: no value given", file=sys.stderr); return 1
            write_secret(proj, ARGS[2], value); print(f"Added Environment Variable {ARGS[2]} to Project {proj}"); return 0
        if sub in ("rm", "remove") and len(ARGS) > 2:
            st["env"].pop(ARGS[2], None); save(proj, st); log(); print(f"Removed Environment Variable {ARGS[2]}"); return 0
    if cmd in ("deploy", "build") or (cmd.startswith("--") and "--prod" in ARGS):
        if not proj: log(); print("Error: Your codebase isn't linked to a project on Vercel. Run `vercel link` to begin.", file=sys.stderr); return 1
        if cmd == "build": log(); print("Build Completed in .vercel/output (rehearsal)"); return 0
        st = store(proj); fw = st.get("framework") or ("eve" if proj.endswith("-api") else "nextjs"); n = len(st["deployments"]) + 1
        print(f"Vercel CLI 50.4.1\nDeploying rehearsal-team/{proj}\nFramework Preset: {fw} (Project Settings -> Build and Deployment)")
        if fw not in ("nextjs", "eve"):
            print('Building: Running "npm run build"\nBuilding: Compiled successfully', flush=True)
            print('Error: No Output Directory named "public" found after the Build completed. Configure the Output Directory '
                  'in your Project Settings. Alternatively, configure vercel.json#outputDirectory.', file=sys.stderr)
            st["deployments"].append({"n": n, "state": "ERROR", "framework": fw}); save(proj, st); log(result="error"); return 1
        url = f"https://{proj}.rehearsal.invalid"
        print("Building: Compiled successfully\nProduction: " + url)
        uid = f"dpl_{proj}_{n}"
        st["deployments"].append({"n": n, "uid": uid, "created": int(datetime.datetime.now().timestamp() * 1000) + n, "state": "READY", "framework": fw, "url": url})
        if st.get("auto_assign", True): st["production"] = uid
        save(proj, st); log(result="ready"); return 0
    if cmd in ("logs", "inspect"):
        log(); print("rehearsal: the factory keeps each deploy's log; see `python3 .claude/scripts/provision.py <app_id> status`"); return 0
    log(); print(f"rehearsal vercel: `{' '.join(ARGS)}` is not simulated", file=sys.stderr); return 1


def jload_text(s):
    try: return json.loads(s or "{}")
    except ValueError: return {}


# ---- the fake app ---------------------------------------------------------------------------------------------------

def app(method, url, body, token):
    """(status, json body) for one request to the fake deployment."""
    m = re.match(r"^https://([a-z0-9-]+)\.rehearsal\.invalid(/[^?#]*)?", url or "")
    if not m: return None
    p, path = m.group(1), (m.group(2) or "/").rstrip("/") or "/"
    live = production(store(p)) if exists(p) else None
    if not live: return 404, {"error": "DEPLOYMENT_NOT_FOUND"}
    if path in ("/api/health", "/eve/v1/health"): return 200, {"ok": True}
    if path == "/api/ops/health": return 200, {"ok": True, "db": {"ok": True, "detail": "SELECT 1 ok · role app_rw (RLS enforced)"}}
    if path == "/": return 200, {"page": "home"}
    if path == "/api/auth/email/request" and method == "POST":
        email = (body or {}).get("email", "")
        if "@" not in email: return 400, {"error": "that is not an email address"}
        os.makedirs(os.path.join(REH, "outbox"), exist_ok=True)
        code = f"{secrets.randbelow(10 ** 6):06d}"
        open(os.path.join(REH, "outbox", f"{p}--{email}.txt"), "w").write(code + "\n")
        return 200, {"ok": True}
    if path == "/api/auth/email/verify" and method == "POST":
        email, code = (body or {}).get("email", ""), str((body or {}).get("code", ""))
        f = os.path.join(REH, "outbox", f"{p}--{email}.txt")
        if not os.path.exists(f) or open(f).read().strip() != code: return 400, {"error": "that code is not right or has expired"}
        os.remove(f); tok = "rehearsal-session-" + secrets.token_hex(12)
        t = jload(TOKENS, {}); t[tok] = {"project": p, "email": email}; json.dump(t, open(TOKENS, "w"))
        return 200, {"token": tok, "email": email, "expiresIn": 7 * 86400}
    if path == "/api/ops/me":
        return (200, {"email": jload(TOKENS, {})[token]["email"]}) if token in jload(TOKENS, {}) else (401, {"error": "sign in first"})
    # the operator's chat (provision.py's post-deploy smoke test, lib/smoke.py): a session of THIS app, its own workspace
    t = jload(TOKENS, {}).get(token)
    if path in ("/api/ops/me/workspaces", "/eve/v1/session", "/api/ops/chat-sessions") or path.endswith("/stream"):
        if not t or t.get("project") != p: return 401, {"error": "Unauthorized"}
    if path == "/api/ops/me/workspaces": return 200, {"memberships": [{"orgId": own_org(p), "role": "owner"}] if own_org(p) else []}
    if path == "/eve/v1/session" and method == "POST": return 200, {"sessionId": "ses_" + secrets.token_hex(6)}
    if path.startswith("/eve/v1/session/") and path.endswith("/stream"):
        return 200, {"events": [{"type": "turn.started"}, {"type": "message.completed", "data": {"message": "4"}}, {"type": "turn.completed"}]}
    if path == "/api/ops/chat-sessions" and method == "DELETE": return 200, {"ok": True}
    return 404, {"error": "not found"}


def own_org(p):
    """The workspace the app's state names as the operator's own (the fake app's one seeded workspace)."""
    root = os.path.dirname(REH)
    for d in sorted(os.listdir(os.path.join(root, "state", "application"))) if os.path.isdir(os.path.join(root, "state", "application")) else []:
        i = jload(os.path.join(root, "state", "application", d, "infrastructure.json"), {})
        if (i.get("vercel") or {}).get("project") == p:
            return ((jload(os.path.join(root, "state", "application", d, "application.json"), {}).get("workspace") or {}).get("org") or {}).get("org_id")
    return None


def curl():
    method, data, headers, fmt, url, i = "GET", None, {}, None, None, 0
    while i < len(ARGS):
        a = ARGS[i]
        if a in ("-X", "--request"): method = ARGS[i + 1]; i += 2; continue
        if a in ("-d", "--data", "--data-raw"): data = ARGS[i + 1]; method = "POST" if method == "GET" else method; i += 2; continue
        if a in ("-H", "--header"): k, _, v = ARGS[i + 1].partition(":"); headers[k.strip().lower()] = v.strip(); i += 2; continue
        if a in ("-w", "--write-out"): fmt = ARGS[i + 1]; i += 2; continue
        if a in ("--max-time", "-m", "-o", "--output", "-u"): i += 2; continue
        if not a.startswith("-"): url = a
        i += 1
    token = (headers.get("authorization") or "").replace("Bearer ", "")
    r = app(method, url, jload_text(data) if data else None, token)
    log(method=method, url=url)
    if r is None:
        host = re.sub(r"^https?://([^/]+).*", r"\1", url or "")
        print(f"curl: (6) Could not resolve host: {host} (rehearsal: nothing outside the rehearsal is reachable)", file=sys.stderr); return 6
    code, body = r
    sys.stdout.write(json.dumps(body))
    if fmt: sys.stdout.write(fmt.replace("\\n", "\n").replace("%{http_code}", str(code)))
    return 0


def http():
    method, url = (ARGS + ["GET", ""])[:2]
    body = jload_text(sys.stdin.read()) if not sys.stdin.isatty() else None
    hdr = jload_text(os.environ.get("FACTORY_HTTP_HEADERS") or "{}")
    r = app(method, url, body, (hdr.get("authorization") or "").replace("Bearer ", "") or None)
    path = re.sub(r"^https?://[^/]+", "", url or "")
    log(method=method, url=url, **({"action": "code-request"} if path == "/api/auth/email/request" else {"action": "code"} if path == "/api/auth/email/verify" else {}))
    if r is None: print(json.dumps({"status": 0, "body": {"error": "could not resolve host (rehearsal)"}})); return 1
    print(json.dumps({"status": r[0], "body": r[1]})); return 0


def ssh():
    log(); host = next((a for a in ARGS if not a.startswith("-")), "the server")
    print(f"ssh: connect to host {host} port 22: Connection refused (rehearsal: no server is reachable)", file=sys.stderr); return 255


def gh():
    log()
    if ARGS[:2] == ["auth", "status"]: print("github.com\n  Logged in to github.com account rehearsal-user (keyring)"); return 0
    if ARGS[:1] == ["api"]:
        # the mold source's CI (lib/deploy_gate.py): every commit passed, unless <rehearsal>/ci.json says otherwise
        path = ARGS[-1]; verdict = jload(os.path.join(REH, "ci.json"), {}).get("verdict", "green")
        st, con = ("in_progress", None) if verdict == "pending" else ("completed", "failure" if verdict == "red" else "success")
        m = re.search(r"head_sha=([0-9a-f]+)", path)
        if m:
            print(json.dumps({"workflow_runs": [{"id": 1, "path": ".github/workflows/ci.yml", "head_sha": m.group(1), "status": st,
                                                 "conclusion": con, "check_suite_id": 1, "event": "push"}]})); return 0
        if path.endswith("/check-runs?per_page=100") or "/check-runs" in path:
            print(json.dumps({"check_runs": [{"name": "verify", "status": st, "conclusion": con, "check_suite": {"id": 1}}]})); return 0
        if "/contents/" in path: print("gh: Not Found (HTTP 404)", file=sys.stderr); return 1
    print(f"rehearsal {NAME}: `{' '.join(ARGS)}` was logged; nothing was sent"); return 0


def npm():
    log()
    if ARGS[:1] == ["whoami"]: print("npm error code ENEEDAUTH", file=sys.stderr); return 1
    if ARGS[:1] == ["publish"]: print("npm error code ENEEDAUTH (rehearsal: nothing is published)", file=sys.stderr); return 1
    print(f"rehearsal {NAME}: `{' '.join(ARGS)}` is not simulated", file=sys.stderr); return 1


def git():
    force = "push" in ARGS and any(a in ("-f", "--force", "--force-with-lease") or a.startswith("--force") or a.startswith("+") for a in ARGS)
    log(force_push=force) if "push" in ARGS or "reset" in ARGS else None
    real = open(os.path.join(REH, "real_git")).read().strip()
    os.execv(real, [real] + ARGS)


if __name__ == "__main__":
    sys.exit({"vercel": vercel, "ssh": ssh, "scp": ssh, "gh": gh, "glab": gh, "npm": npm, "npx": npm, "git": git, "curl": curl,
              "http": http}.get(NAME, lambda: (log(), 1)[1])())
