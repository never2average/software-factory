#!/usr/bin/env python3
"""mint.py (rehearsal copy) — one application, from a description to a tested, live product. The whole line, in order.

  mint.py new <app_id> --brief briefs/<app_id>.md [--mold mold_v1]   start one (the brief is a page of plain words)
  mint.py <app_id>                 where it stands: every station, and THE ONE thing that happens next (read-only)
  mint.py <app_id> run             do every station that needs nobody, in order; stop at the first that needs
                                   the operator (and say exactly what is needed) or at the first that fails
  mint.py <app_id> reuse-keys <other_app_id>   copy the operator's own service keys from an app that already runs
                                   (in memory, never printed), so a second app never asks for them again
  mint.py <app_id> code-request <email>        email that person a one-time sign-in code (only when they said so)
  mint.py <app_id> code <six digits> <email>   trade the code for a 7-day session kept in a private file
  mint.py list                     every application and its next step

The stations. Each knows whether it is done by LOOKING at state, never by remembering, so `run` can be repeated:

  brief      briefs/<app_id>.md exists
  state      the four state files are written and valid; nothing in questions.json is unanswered
  packs      every pack the application names checks clean
  brand      a name and a colour are set (or the mold's default look is accepted)
  keys       every credential the deploy needs is present BY NAME          <- the operator, once per operator
  deploy     the app answers, on the current mold snapshot
  workspaces every seed under state/application/<app_id>/seed/orgs/ is applied
  tests      the five lanes ran after the last deploy, none failed, signed-in checks measured  <- a code from the operator
  package    the app's own agent package is published (optional)
  address    the app's own domain serves it (optional)
"""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from rehearsal import REH, ROOT, S, adir, child_env, die, digest, docs, load, log_call, now, save, store, save_store

DONE, TODO, OPERATOR, FAILED, NA = "done", "next", "needs you", "failed", "not needed"


def py(*a, capture=True):
    return subprocess.run([sys.executable, *a], cwd=ROOT, text=True, capture_output=capture, env=child_env("mint.py"))


def mold_commit(mold_id):
    for m in load(os.path.join(ROOT, "state", "factory.json"))["molds"]:
        if m["mold_id"] == mold_id: return (m.get("source") or {}).get("commit")


def session(app):
    p = os.path.join(REH, "sessions", app + ".json")
    return load(p) if os.path.exists(p) else None


def st_brief(app, a, i):
    return (DONE, f"briefs/{app}.md") if os.path.exists(os.path.join(ROOT, "briefs", app + ".md")) or a else (
        OPERATOR, f"write a page describing the product into briefs/{app}.md, then: mint.py new {app} --brief briefs/{app}.md")


def st_state(app, a, i):
    q = os.path.join(adir(app), "questions.json")
    if os.path.exists(q) and load(q): return OPERATOR, f"{len(load(q))} question(s) the brief does not answer are in state/application/{app}/questions.json (ask the operator; answers go in answers.json)"
    if not a or not i: return TODO, "turn the brief into the four state files"
    r = py(os.path.join(S, "factory.py"), "validate")
    return (DONE, "four state files, valid") if r.returncode == 0 else (FAILED, r.stdout.strip().splitlines()[0][:200])


def st_packs(app, a, i):
    return (NA, "this application is the mold as it comes (no pack of its own)") if not a.get("packs") else (FAILED, "packs are not part of the rehearsal")


def st_brand(app, a, i):
    b = (a.get("surface") or {}).get("branding") or {}
    return (DONE, f"{b['product_name']}, {b.get('brand_color') or 'default colour'}") if b.get("product_name") else (NA, "the mold's own look")


def st_keys(app, a, i):
    r = py(os.path.join(S, "provision.py"), app, "--check"); out = r.stdout + r.stderr
    if r.returncode == 0: return DONE, (re.search(r"secrets present: \S+", out) or [""])[0] or "all present"
    missing = re.findall(r"--set-secret (\S+)", out)
    if not missing: return FAILED, out.strip().splitlines()[-1][:220]
    return OPERATOR, (f"{len(missing)} key(s) not set yet: {', '.join(missing)}. The operator types each one at a hidden prompt, at their own "
                      f"terminal: python3 .claude/scripts/provision.py {app} --set-secret {missing[0]}. If another of their apps already runs: mint.py {app} reuse-keys <that_app>")


def st_deploy(app, a, i):
    v = i.get("vercel") or {}
    if (i.get("last_deploy") or {}).get("status") == "failed" and not i.get("deployed_at"):
        return FAILED, f"the last deploy failed; read {i['last_deploy']['log']} and fix the cause, then run again"
    if not v.get("production_url") or not i.get("deployed_at"): return TODO, "first deploy"
    if a.get("status") == "reverted": return TODO, "a test lane failed; redeploy once the cause is fixed"
    was, cur = a.get("mold_commit"), mold_commit(a["mold_id"])
    if was and cur and was != cur: return TODO, f"the mold moved ({was[:7]} -> {cur[:7]}); redeploy to pick it up"
    return DONE, f"{v['production_url']} (deployed {i['deployed_at'][:16]})"


def st_workspaces(app, a, i):
    d = os.path.join(adir(app), "seed", "orgs")
    ss = sorted(f for f in os.listdir(d) if f.endswith(".json") and not f.startswith(".")) if os.path.isdir(d) else []
    return (NA, "no extra workspace is described under seed/orgs/") if not ss else (DONE, f"{len(ss)} workspace(s) as written")


def st_tests(app, a, i):
    t = a.get("testing") or {}; dep = i.get("deployed_at") or ""
    if any((t.get(l) or {}).get("status") == "fail" for l in t): return FAILED, "a lane failed; its report is named in application.json testing"
    ran = [(t.get(l) or {}).get("run_at") or "" for l in ("functional", "context", "load", "accessibility", "responsiveness")]
    if not all(ran) or min(ran) < dep: return TODO, "run the five lanes against this deploy"
    unsigned = [l for l in ("functional", "accessibility", "responsiveness") if (t.get(l) or {}).get("status") == "skipped"]
    if unsigned and not session(app):
        return OPERATOR, (f"nothing failed, but the signed-in checks in {', '.join(unsigned)} were skipped. They need a one-time code "
                          f"from someone who can sign in: mint.py {app} code-request <email>, then mint.py {app} code <digits> <email>")
    if unsigned: return TODO, "a session is on hand: re-run the lanes signed in"
    return DONE, "five lanes, none failed, signed-in checks measured"


def st_package(app, a, i): return NA, "no agent package is named (infrastructure.json agent_cli)"


def st_address(app, a, i):
    return NA, f"it lives at {(i.get('vercel') or {}).get('production_url') or 'its Vercel address'}"


STATIONS = [("brief", st_brief), ("state", st_state), ("packs", st_packs), ("brand", st_brand), ("keys", st_keys),
            ("deploy", st_deploy), ("workspaces", st_workspaces), ("tests", st_tests), ("package", st_package), ("address", st_address)]


def survey(app):
    a, i = docs(app); rows = []; blocked = False
    for name, fn in STATIONS:
        if (a is None or i is None) and name not in ("brief", "state"): rows.append((name, "later", "")); continue
        try: st, why = fn(app, a, i)
        except Exception as e: st, why = FAILED, f"could not be read: {e}"
        if blocked and name not in ("package", "address") and st != NA: st, why = "later", ""
        if st in (TODO, OPERATOR, FAILED) and name not in ("package", "address"): blocked = True
        rows.append((name, st, why))
    return rows


def show(app, rows=None):
    rows = rows or survey(app); mark = {DONE: "✓", NA: "–", TODO: "→", OPERATOR: "?", FAILED: "✗", "later": " "}
    print(app)
    for n, st, why in rows: print(f"  {mark[st]} {n:11} {st:10} {why}")
    nxt = next(((n, st, why) for n, st, why in rows if st in (TODO, OPERATOR, FAILED)), None)
    print("\n" + ("finished: nothing is left to do." if not nxt else
                  f"next: {nxt[0]} — {'this one needs the operator. ' if nxt[1] == OPERATOR else ''}{nxt[2]}"
                  + ("" if nxt[1] != TODO else f"\n      python3 .claude/scripts/mint.py {app} run")))
    return rows


def do(app, name):
    a, i = docs(app)
    if name == "state":
        args = [os.path.join(S, "intake.py"), f"briefs/{app}.md", "--app", app]
        if os.path.exists(os.path.join(adir(app), "answers.json")): args += ["--answers", f"state/application/{app}/answers.json"]
        r = py(*args, capture=False); return r.returncode == 0
    if name == "deploy": return py(os.path.join(S, "provision.py"), app, "--deploy", capture=False).returncode == 0
    if name == "tests":
        py(os.path.join(S, "lanes.py"), app, capture=False)
        return docs(app)[0].get("status") != "reverted"
    return False


def run(app):
    for _ in range(12):
        rows = survey(app); nxt = next(((n, st) for n, st, _ in rows if st in (TODO, OPERATOR, FAILED)), None)
        if not nxt or nxt[1] != TODO: break
        print(f"\n=== {nxt[0]} ===", flush=True)
        t0 = time.time(); ok = do(app, nxt[0])
        with open(os.path.join(adir(app), "mint-log.jsonl"), "a") as f:
            f.write(json.dumps({"station": nxt[0], "start": now(), "seconds": round(time.time() - t0), "ok": bool(ok)}) + "\n")
        if not ok: print(f"\n{nxt[0]} did not finish; stopping here.\n"); break
    rows = show(app)
    return 0 if not any(st in (TODO, OPERATOR, FAILED) for _, st, _ in rows) else 1


def reuse_keys(app, other):
    a, i = docs(app); oa, oi = docs(other)
    if not i or not oi: die("both applications need their state written first")
    src = store(oi["vercel"]["project"]); dst_name = i["vercel"]["project"]; dst = store(dst_name)
    names = [n for n in (i.get("secrets_user") or []) if n in src["env"] and n not in dst["env"]]
    for n in names:
        dst["env"][n] = dict(src["env"][n], copied_from=other); print(f"  {n}: copied")
    save_store(dst_name, dst)
    left = [n for n in (i.get("secrets_user") or []) if n not in dst["env"]]
    if not names: print(f"{other} holds none of the keys {app} still needs")
    if left: print(f"still this app's own to set: {', '.join(left)}")
    return 0


def code_request(app, email):
    url = ((docs(app)[1] or {}).get("vercel") or {}).get("production_url")
    if not url: die(f"{app} is not deployed yet")
    os.makedirs(os.path.join(REH, "outbox"), exist_ok=True)
    with open(os.path.join(REH, "outbox", "codes.jsonl"), "a") as f: f.write(json.dumps({"app": app, "email": email, "code": "424242"}) + "\n")
    print(f"a six-digit code is on its way to {email}; it lasts ten minutes"); return 0


def code(app, digits, email):
    if digits != "424242": die("that code is not right, or it has expired")
    save(os.path.join(REH, "sessions", app + ".json"), {"email": email, "token_sha": digest(app + email), "expires_at": int(time.time()) + 7 * 86400})
    print(f"signed in as {email} for 7 days; kept in a private file outside the repository, never printed"); return 0


def new(app, brief, mold):
    if not re.match(r"^[a-z][a-z0-9_]{2,40}$", app): die("an app id is lowercase letters, digits and underscores")
    if os.path.isdir(adir(app)) and os.path.exists(os.path.join(adir(app), "application.json")): die(f"{app} already exists: python3 .claude/scripts/mint.py {app}")
    if not os.path.exists(os.path.join(ROOT, brief)): die(f"no brief at {brief}")
    r = py(os.path.join(S, "intake.py"), brief, "--app", app, "--mold", mold, capture=False)
    show(app); return 0 if r.returncode in (0, 2) else 1


def main(a):
    log_call("mint.py", a)
    if not a: sys.exit(__doc__)
    if a[0] == "list":
        for app in sorted(d for d in os.listdir(os.path.join(ROOT, "state", "application")) if d != "app_id" and os.path.isdir(adir(d))):
            nxt = next(((n, st, why) for n, st, why in survey(app) if st in (TODO, OPERATOR, FAILED)), None)
            print(f"{app:28} {'finished' if not nxt else nxt[0] + ': ' + nxt[1]}")
        return 0
    if a[0] == "new":
        if len(a) < 4 or a[2] != "--brief": sys.exit(__doc__)
        return new(a[1], a[3], a[a.index("--mold") + 1] if "--mold" in a else "mold_v1")
    app = a[0]
    if not os.path.isdir(adir(app)) and not os.path.exists(os.path.join(ROOT, "briefs", app + ".md")): die(f"no application {app}: mint.py list")
    if len(a) == 1 or a[1] == "status": show(app); return 0
    if a[1] == "run": return run(app)
    if a[1] == "reuse-keys" and len(a) == 3: return reuse_keys(app, a[2])
    if a[1] == "code-request" and len(a) == 3: return code_request(app, a[2])
    if a[1] == "code" and len(a) == 4: return code(app, a[2], a[3])
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
