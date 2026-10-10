#!/usr/bin/env python3
"""After a deploy: one short chat as the operator, in the operator's own workspace, answered within a time cap.

  smoke.py <app_id> [--url URL] [--session-file F] [--timeout S] [--json]   one check against the app as it runs now
  smoke.py --self-test                                                       offline, through the rehearsal fakes

Exit 0 pass, 1 fail, 3 needs a sign-in (no session on hand, or the one on hand was refused or has run out).

WHAT IT DOES, in the app's own API (the calls the browser makes; molds/mold_v1/codebase):
  1. GET  /api/ops/me/workspaces             the workspace list loads, and the signed-in person is a member of the
                                             operator's own workspace (application.json workspace.org.org_id)
  2. POST /eve/v1/session {message}          a new chat in THAT workspace (x-ops-org names it; the app refuses a
                                             workspace the caller is not a member of, it never falls back to another)
  3. GET  /eve/v1/session/<id>/stream        read until the turn ends; a complete, non-empty answer must arrive
                                             within --timeout (SMOKE_TIMEOUT_S, default 150s)
  4. DELETE /api/ops/chat-sessions?id=<id>   clean up: the check never adds the chat to the chat list (that row is
                                             the browser's to write), and this removes any row, transcript copy or
                                             share under that id. The message itself is tagged as the factory's.
The question needs no specialist ("What is 2 + 2?"), so a pass measures the deployment's own wiring: the web app,
the agent API behind it, the model credential and the database, not a subagent.

NEVER A CUSTOMER'S WORKSPACE. The only workspace ever named is the operator's own, from state. If the session on
hand is not a member of it the check stops before sending anything ("needs a sign-in": it is the wrong person's
session), and an app with one workspace only (no memberships listed: tenancy off) is asked without naming one.

WHOSE SESSION, in this order, never printed, never written:
  --session-file F             a JSON file with "token" (what the app's own sign-in answers)
  <MOLD>_SESSION_TOKEN         MOLD_V1_SESSION_TOKEN for mold_v1: a session the operator lent on purpose wins
  <private dir>/<app>.session.json   the one `mint.py <app> code` keeps (lib/services.py private_dir)
A session with less than a few minutes of life left (read from its own expiry) counts as none. lib/session.py is
not used: it mints harness sessions for local fixtures only and refuses any app that can serve a person.

FOR THE OTHER DEPLOY PATH. `check(app_id, url=..., timeout=...)` is the whole check as one call returning the
result dict (result: pass | fail | needs_sign_in, detail, seconds, ...). provision.py's Vercel path rolls every
project back when it says fail; a server release switch (vm_remote) calls the same function after switching and
switches back on fail. Standard library only.
"""
import base64, datetime, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import services  # noqa: E402
import legacy    # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
PROMPT = ("[factory post-deploy check: an automated message, safe to delete] "
          "What is 2 + 2? Reply with the number only.")
DEFAULT_TIMEOUT = int(os.environ.get("SMOKE_TIMEOUT_S") or 150)
MIN_LIFE = 300          # a session about to run out is no session: the check takes up to DEFAULT_TIMEOUT
ORG_HEADER = "x-ops-org"
UA = "factory-smoke"
TERMINAL = ("turn.completed", "session.completed", "session.waiting")
FAILED = ("turn.failed", "session.failed")


def _now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def session_var(mold_id): return f"{re.sub(r'[^A-Za-z0-9]', '_', mold_id or 'mold_v1').upper()}_SESSION_TOKEN"


def token_life(tok):
    """Seconds until the session's own `exp`, or None when it carries none we can read (not a JWT)."""
    try:
        p = tok.split(".")[1]; claims = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
        return int(claims["exp"]) - time.time()
    except Exception: return None


def session_for(app_id, mold_id, min_life=MIN_LIFE, session_file=None):
    """(token, where, None) or (None, None, why). The token is only ever handed to the HTTP calls below."""
    cands = []
    if session_file:
        try: d = json.load(open(session_file)); cands.append((str(d.get("token") or ""), f"the session file given", d.get("expires_at")))
        except (OSError, ValueError) as e: return None, None, f"the session file could not be read ({type(e).__name__})"
    var = session_var(mold_id)
    if os.environ.get(var, "").strip(): cands.append((os.environ[var].strip(), f"{var} (an operator's own session)", None))
    p = os.path.join(services.private_dir(), f"{app_id}.session.json")
    if os.path.isfile(p):
        try: d = json.load(open(p)); cands.append((str(d.get("token") or ""), "the operator's kept sign-in (mint.py code)", d.get("expires_at")))
        except (OSError, ValueError): pass
    why = "no signed-in session for this app is on hand"
    for tok, where, exp_at in cands:
        if not tok: continue
        life = token_life(tok)
        if life is None and exp_at: life = float(exp_at) - time.time()
        if life is not None and life < min_life:
            why = (f"the session from {where} has run out" if life <= 0 else f"the session from {where} has only {int(life)}s left")
            continue
        return tok, where, None
    return None, None, why


def operator_workspace(app):
    ws = app.get("workspace") or {}
    org = (legacy.get(ws, "org", {}) or {}).get("org_id") if isinstance(legacy.get(ws, "org", {}), dict) else None
    return (org or "").strip() or None


def app_url(infra):
    for k in ("vercel", "vm_remote"):
        u = (infra.get(k) or {}).get("production_url")
        if u: return u.rstrip("/")
    return None


def sign_in_how(app_id):
    return (f"Tell me which email address can sign in to {app_id} (your own) and say that I may send it a code. I then run "
            f"`python3 .claude/scripts/mint.py {app_id} code-request <email>`; a six-digit code arrives by email within a minute "
            f"and lasts ten minutes. Paste just the six digits here. The session it buys is kept in a private file on this "
            f"machine, never shown, and lasts a week.")


# ---- HTTP: the real app, or the rehearsal's `http` fake ------------------------------------------------------------

def _headers(tok, org):
    h = {"authorization": f"Bearer {tok}", "content-type": "application/json", "user-agent": UA}
    if org: h[ORG_HEADER] = org
    return h


def _request(method, url, tok, org, body=None, timeout=30):
    """(status, parsed JSON or None, one-line error). Status 0 = nothing answered."""
    h = _headers(tok, org)
    if services.REHEARSAL:
        st, doc = services.http_json(method, url, body, timeout=timeout, headers=h)
        return st, doc, ("" if st else str((doc or {}).get("error") or "no answer"))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace"); st = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace"); st = e.code
    except Exception as e:
        return 0, None, f"{type(e).__name__}: {str(e)[:160]}"
    try: doc = json.loads(raw) if raw.strip() else None
    except ValueError: doc = None
    return st, doc, "" if doc is not None else raw.strip()[:120]


def _events(url, tok, org, timeout):
    """The session's stream, one event dict at a time, until the caller stops or `timeout` passes."""
    if services.REHEARSAL:
        st, doc = services.http_json("GET", url, None, timeout=timeout, headers=_headers(tok, org))
        if st != 200: raise IOError(f"the stream answered {st or 'nothing'}")
        for ev in (doc.get("events") if isinstance(doc, dict) else doc) or []: yield ev
        return
    deadline = time.time() + timeout
    req = urllib.request.Request(url, headers=_headers(tok, org))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            if time.time() > deadline: return
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("data:"): line = line[5:].strip()
            if not line: continue
            try: ev = json.loads(line)
            except ValueError: continue
            if isinstance(ev, dict): yield ev


# ---- the check ---------------------------------------------------------------------------------------------------------

def _result(result, detail, t0, **kw):
    return dict({"result": result, "detail": detail, "at": _now(), "seconds": round(time.time() - t0, 1)}, **kw)


def workspaces(url, tok, org, timeout=30):
    """('ok'|'needs_sign_in'|'fail', why, org to name or None). Step 1, and the whole of a pre-deploy probe."""
    st, doc, err = _request("GET", f"{url}/api/ops/me/workspaces", tok, None, timeout=timeout)
    if st in (401, 403): return "needs_sign_in", f"the app refused the session ({st}): it has expired or was signed out", None
    if st != 200 or not isinstance(doc, dict):
        return "fail", f"the workspace list did not load (GET /api/ops/me/workspaces answered {st or 'nothing'}{': ' + err if err else ''})", None
    ms = doc.get("memberships")
    if not isinstance(ms, list): return "fail", "the workspace list loaded without a list of workspaces", None
    if not ms: return "ok", "workspace list loaded (one workspace: tenancy is off)", None
    if not org:
        return "needs_sign_in", ("application.json names no workspace.org.org_id, so the operator's own workspace is unknown "
                                 "and no other is ever used"), None
    mine = next((m for m in ms if m.get("orgId") == org), None)
    if not mine:
        return "needs_sign_in", (f"the session on hand is not a member of the operator's workspace {org} ({len(ms)} other "
                                 f"workspace(s) listed); nothing was sent, and no other workspace is used"), None
    return "ok", f"workspace list loaded ({len(ms)}); the operator's workspace {org} is there as {mine.get('role') or 'member'}", org


def check(app_id, app=None, infra=None, url=None, session_file=None, timeout=None, min_life=MIN_LIFE):
    """The whole post-deploy check. Never raises; the token is never in what it returns."""
    t0 = time.time(); timeout = timeout or DEFAULT_TIMEOUT
    if app is None or infra is None:
        adir = os.path.join(ROOT, "state", "application", app_id)
        app = json.load(open(os.path.join(adir, "application.json"))); infra = json.load(open(os.path.join(adir, "infrastructure.json")))
    url = (url or app_url(infra) or "").rstrip("/")
    if not url: return _result("fail", "the app has no production address in state, so there is nothing to open", t0)
    tok, where, why = session_for(app_id, app.get("mold_id"), min_life=min_life, session_file=session_file)
    if not tok: return _result("needs_sign_in", why, t0, url=url, how=sign_in_how(app_id))
    base = {"url": url, "session_from": where}
    state, why, org = workspaces(url, tok, operator_workspace(app))
    if state != "ok": return _result(state, why, t0, workspace_list=state, how=sign_in_how(app_id) if state == "needs_sign_in" else None, **base)
    base.update(workspace_list="pass", workspace=org)
    st, doc, err = _request("POST", f"{url}/eve/v1/session", tok, org, {"message": PROMPT}, timeout=60)
    if st in (401, 403) and not (doc or {}).get("error") == "workspace_refused":
        return _result("needs_sign_in", f"starting a chat was refused ({st}): the session has expired or was signed out", t0, how=sign_in_how(app_id), **base)
    sid = (doc or {}).get("sessionId") if st and st < 300 else None
    if not sid: return _result("fail", f"a new chat could not be started (POST /eve/v1/session answered {st or 'nothing'}"
                               f"{': ' + (err or json.dumps(doc)[:120]) if (err or doc) else ''})", t0, **base)
    answer, types, terminal, failed = "", {}, None, None
    left = max(5, timeout - (time.time() - t0))
    try:
        for ev in _events(f"{url}/eve/v1/session/{urllib.parse.quote(sid)}/stream", tok, org, left):
            t = ev.get("type") or "?"; types[t] = types.get(t, 0) + 1
            d = ev.get("data") or {}
            if t == "message.completed" and isinstance(d.get("message"), str): answer = d["message"]
            if t in FAILED: failed = json.dumps(d)[:200]; terminal = t; break
            if t in TERMINAL: terminal = t; break
            if time.time() - t0 > timeout: break
    except Exception as e:
        failed = f"the answer stream broke: {type(e).__name__}: {str(e)[:120]}"
    cleanup = _cleanup(url, tok, org, sid)
    base.update(cleanup=cleanup, events=sum(types.values()))
    if failed and not terminal: return _result("fail", failed, t0, **base)
    if failed: return _result("fail", f"the chat answered with an error ({terminal}): {failed}", t0, **base)
    if not terminal: return _result("fail", f"no complete answer within {timeout}s ({sum(types.values())} event(s) seen)", t0, **base)
    if not answer.strip(): return _result("fail", f"the chat ended ({terminal}) with no answer", t0, **base)
    right = re.search(r"\b4\b|four", answer, re.I) is not None
    return _result("pass", f"a new chat in the operator's workspace answered in {time.time() - t0:.0f}s: {answer.strip()[:40]!r}"
                   + ("" if right else " (it arrived; it did not say 4)"), t0, answer_ok=right, **base)


def _cleanup(url, tok, org, sid):
    st, doc, _ = _request("DELETE", f"{url}/api/ops/chat-sessions?id={urllib.parse.quote(sid)}", tok, org, timeout=30)
    if st == 200 and (doc or {}).get("ok"): return "removed (the chat was never added to the chat list; its message says it is the factory's check)"
    return f"not removed ({st or 'no answer'}); the chat's message says it is the factory's check, and it was never added to the chat list"


# ---- self-test -----------------------------------------------------------------------------------------------------

FAKE_APP = r'''#!/usr/bin/env python3
# the rehearsal's `http`: a stand-in for one deployed app, driven by $SMOKE_WORLD (JSON)
import json, os, sys
method, url = sys.argv[1], sys.argv[2]
w = json.load(open(os.environ["SMOKE_WORLD"])); h = json.loads(os.environ.get("FACTORY_HTTP_HEADERS") or "{}")
body = sys.stdin.read(); body = json.loads(body) if body.strip() else None
open(os.environ["SMOKE_WORLD"] + ".calls", "a").write(json.dumps({"m": method, "u": url, "org": h.get("x-ops-org"), "body": body}) + "\n")
def out(st, b): print(json.dumps({"status": st, "body": b})); sys.exit(0)
if h.get("authorization") != "Bearer " + w["token"]: out(401, {"error": "Unauthorized"})
path = url.split("://", 1)[1].split("/", 1)[1]
if path.startswith("api/ops/me/workspaces"): out(w.get("ws_status", 200), {"memberships": w.get("memberships", [])})
if path == "eve/v1/session" and method == "POST":
    if w.get("start_status"): out(w["start_status"], {"error": "boom"})
    out(200, {"sessionId": "ses_1"})
if path.endswith("/stream"): out(200, {"events": w.get("events", [])})
if path.startswith("api/ops/chat-sessions") and method == "DELETE": out(200, {"ok": True})
out(404, {"error": "not found"})
'''


def _jwt(exp):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'ES256'})}.{enc({'kind': 'email-session', 'exp': int(exp)})}.sig"


def self_test():
    import tempfile
    fails, n = [], [0]
    def ok(cond, what, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{what}{': ' + str(detail)[:300] if detail else ''}")
    good = [{"type": "turn.started"}, {"type": "message.delta"}, {"type": "message.completed", "data": {"message": "4"}}, {"type": "turn.completed"}]
    tok = _jwt(time.time() + 86400)
    app = {"mold_id": "mold_v1", "workspace": {"org": {"org_id": "org_own"}}}
    infra = {"vercel": {"production_url": "https://app-one.rehearsal.invalid"}}
    with tempfile.TemporaryDirectory() as d:
        reh = os.path.join(d, "reh"); b = os.path.join(reh, "bin"); priv = os.path.join(d, "private"); os.makedirs(b); os.makedirs(priv)
        open(os.path.join(b, "http"), "w").write(FAKE_APP.replace("#!/usr/bin/env python3", "#!" + sys.executable)); os.chmod(os.path.join(b, "http"), 0o755)
        world = os.path.join(d, "world.json")
        def world_is(**w):
            json.dump(dict({"token": tok, "memberships": [{"orgId": "customer_a", "role": "owner"}, {"orgId": "org_own", "role": "owner"}],
                            "events": good}, **w), open(world, "w"))
            if os.path.exists(world + ".calls"): os.remove(world + ".calls")
        def calls(): return [json.loads(l) for l in open(world + ".calls")] if os.path.exists(world + ".calls") else []
        old_env = dict(os.environ); old_reh = services.REHEARSAL
        for k in [k for k in os.environ if k.endswith("_SESSION_TOKEN")]: os.environ.pop(k)
        os.environ.update(FACTORY_REHEARSAL=reh, FACTORY_PRIVATE_DIR=priv, SMOKE_WORLD=world)
        services.REHEARSAL = reh; services._ACTIVE = False; services.activate()
        try:
            world_is()
            r = check("app_one", app, infra)
            ok(r["result"] == "needs_sign_in" and "no signed-in session" in r["detail"] and "code-request" in r["how"] and not calls(),
               "no session on hand: needs a sign-in, says how, and nothing is sent", r)
            sp = os.path.join(priv, "app_one.session.json")
            json.dump({"token": tok, "expires_at": int(time.time()) + 86400}, open(sp, "w"))
            r = check("app_one", app, infra)
            cs = calls()
            ok(r["result"] == "pass" and r["answer_ok"] and r["workspace_list"] == "pass", "the kept session: a chat answered, pass", r)
            ok(all(c["org"] in (None, "org_own") for c in cs) and any(c["m"] == "POST" and c["org"] == "org_own" for c in cs),
               "  ...the chat is started in the operator's own workspace and no other", cs)
            ok(any(c["m"] == "DELETE" for c in cs) and "removed" in r["cleanup"], "  ...and cleaned up afterwards", r.get("cleanup"))
            ok(PROMPT.startswith("[factory post-deploy check") and any((c.get("body") or {}).get("message") == PROMPT for c in cs), "  ...with a message tagged as the factory's")
            ok(tok not in json.dumps(r), "  ...and the token is nowhere in the result")
            world_is(events=[{"type": "turn.started"}, {"type": "turn.failed", "data": {"error": "model refused"}}])
            r = check("app_one", app, infra)
            ok(r["result"] == "fail" and "model refused" in r["detail"], "an answer that fails: fail", r)
            world_is(events=[{"type": "turn.started"}, {"type": "message.delta"}])
            r = check("app_one", app, infra, timeout=5)
            ok(r["result"] == "fail" and "no complete answer" in r["detail"], "no complete answer in time: fail", r)
            world_is(events=[{"type": "message.completed", "data": {"message": ""}}, {"type": "turn.completed"}])
            ok(check("app_one", app, infra)["result"] == "fail", "an empty answer: fail")
            world_is(start_status=500)
            r = check("app_one", app, infra)
            ok(r["result"] == "fail" and "could not be started" in r["detail"], "a chat that cannot start: fail", r)
            world_is(ws_status=500)
            r = check("app_one", app, infra)
            ok(r["result"] == "fail" and "workspace list did not load" in r["detail"], "the workspace list not loading: fail", r)
            world_is(memberships=[{"orgId": "customer_a", "role": "owner"}])
            r = check("app_one", app, infra)
            ok(r["result"] == "needs_sign_in" and "not a member" in r["detail"] and not any(c["m"] == "POST" for c in calls()),
               "a session outside the operator's workspace: nothing sent to any other workspace, needs a sign-in", r)
            world_is(memberships=[])
            r = check("app_one", app, infra)
            ok(r["result"] == "pass" and all(c["org"] is None for c in calls()), "one-workspace app (tenancy off): asked without naming one", r)
            world_is(token="another-token")
            r = check("app_one", app, infra)
            ok(r["result"] == "needs_sign_in" and "refused the session" in r["detail"], "a session the app refuses: needs a sign-in", r)
            world_is()
            json.dump({"token": _jwt(time.time() - 60)}, open(sp, "w"))
            r = check("app_one", app, infra)
            ok(r["result"] == "needs_sign_in" and "run out" in r["detail"] and not calls(), "an expired session counts as none", r)
            f = os.path.join(d, "lent.json"); json.dump({"token": tok}, open(f, "w"))
            r = check("app_one", app, infra, session_file=f)
            ok(r["result"] == "pass" and r["session_from"] == "the session file given", "--session-file is used when given", r)
            os.environ[session_var("mold_v1")] = tok
            ok(check("app_one", app, infra)["result"] == "pass", "an operator's own lent session (MOLD_V1_SESSION_TOKEN) is used")
            os.environ.pop(session_var("mold_v1"))
            ok(check("app_one", {"mold_id": "mold_v1"}, infra, session_file=f)["result"] == "needs_sign_in", "no operator workspace in state: never guesses one")
        finally:
            os.environ.clear(); os.environ.update(old_env); services.REHEARSAL = old_reh; services._ACTIVE = False
    if fails:
        print("smoke self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"smoke self-test: {n[0]} checks passed"); return 0


def main(a):
    if a[:1] == ["--self-test"]: return self_test()
    if not a or a[0].startswith("-"): print(__doc__); return 2
    services.script_start("smoke.py", a, action="smoke")
    opt = lambda k: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else None
    r = check(a[0], url=opt("--url"), session_file=opt("--session-file"), timeout=int(opt("--timeout") or 0) or None)
    if "--json" in a: print(json.dumps(r, indent=2))
    else:
        print(f"smoke {r['result']}: {r['detail']}")
        if r.get("how") and r["result"] == "needs_sign_in": print("  " + r["how"])
    return {"pass": 0, "needs_sign_in": 3}.get(r["result"], 1)


if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
