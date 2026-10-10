#!/usr/bin/env python3
"""mint.py — one application, from a description to a tested, live product. The whole line, in order.

  mint.py new <app_id> --brief briefs/<app_id>.md [--mold mold_v1]   start one (the brief is a page of plain words)
  mint.py <app_id>                 where it stands: every station, and THE ONE thing that happens next
  mint.py <app_id> run             do every station that needs nobody, in order; stop at the first that needs
                                   the operator (and say exactly what is needed) or at the first that fails
  mint.py <app_id> reuse-keys <other_app_id>   copy the operator's own service keys from an app that already
                                   runs (in memory, never printed), so a second app never asks for them again
  mint.py <app_id> code-request <email>        email that person a one-time sign-in code (only when they said so)
  mint.py <app_id> code <six digits> <email>   trade the code for a 7-day session kept in a private file, so the
                                   signed-in checks are measured and not skipped
  mint.py <app_id> report          what it took: time and money, each figure measured or plainly "not measured"
  mint.py <app_id> handoff         reports/mint/<app_id>.handoff.html: one page for the next person or agent
                                   (publish it as an Artifact; its link is kept in infrastructure.json handoff_url)
  mint.py list                     every application and its next step
  mint.py --self-test

FOR AN AGENT. `mint.py <app_id> --json`, `mint.py <app_id> run --json` and `mint.py list --json` print one result
({"ok","status","summary","next","needs","log","details"}; lib/agent_result.py), with every station in details. Exit 0
nothing blocks you (done, or the next station is work you can run), 1 a station failed, 3 a person is needed: `needs`
says exactly what (a key at the hidden prompt, a sign-in code, a DNS record, an npm sign-in) and how they give it.
`mint.py <app_id> run --background [--json]` starts the run detached (a deploy and the lanes take most of an hour);
`mint.py <app_id> --json` then reports it under details.background_run until it ends.

The stations. Each knows whether it is done by LOOKING (state, the registry, the live app), never by remembering,
so `run` can be repeated at any time and picks up where things stand:

  brief      briefs/<app_id>.md exists
  state      the four state files are written and valid; nothing in questions.json is unanswered
  packs      every pack the application names checks clean
  brand      a name, a colour and a logo are set (or the mold's default look is accepted)
  keys       every credential the deploy needs is present BY NAME          <- the operator, once per operator
  deploy     the three services answer, on the current mold snapshot
  workspaces every seed under state/application/<app_id>/seed/orgs/ is applied as it is now written; for an app on a
             server of its own, the brief's own workspace too, and then the application's surface (the default agent
             profile, per-subagent configs, workflow definitions and scripts), written on that server
             (provision.py --workspace-remote)
  tests      the five lanes ran after the last deploy, none failed, signed-in checks measured  <- a code from the operator
  package    the application's own agent package is published at the app's address (vercel.production_url, or
             vm_remote.production_url for a server of its own)                                <- the operator's npm sign-in
  address    the application's own domain serves it (only if one is named)                  <- one DNS record

This file only ORDERS the work. Each station is the script that already owns it (intake.py, packs.py, branding.py,
provision.py, workspace.py, lanes.py, agent_cli.py, domain.py); their rules and refusals are unchanged.
"""
import sys as _sys_fl, os as _os_fl
_sys_fl.path.insert(0, _os_fl.path.join(_os_fl.path.dirname(_os_fl.path.abspath(__file__)), "lib"))
from factory_local import load_factory
import hashlib, json, os, re, subprocess, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = os.path.join(ROOT, ".claude", "scripts")
DONE, TODO, OPERATOR, FAILED, NA = "done", "next", "needs you", "failed", "not needed"

sys.path.insert(0, os.path.join(S, "lib"))
import lane_url   # target_url(infra): where the application lives, per deploy target (vercel, or a server of its own)
import agent_result as AR, runs, services   # --json results, background runs, the rehearsal switch and call log
PRIVATE = services.private_dir()   # FACTORY_PRIVATE_DIR, else ~/.cache/software-factory

def load(p): return json.load(open(p))
def adir(app): return os.path.join(ROOT, "state", "application", app)
def py(*a, **k): return subprocess.run([sys.executable, *a], cwd=ROOT, text=True, **k)
def quiet(*a, env=None): return py(*a, capture_output=True, env=env)
def clean(s): return re.sub(r"\x1b\[[0-9;]*m", "", s or "")

def docs(app):
    d = adir(app); out = {}
    for n in ("application", "infrastructure"):
        p = os.path.join(d, n + ".json"); out[n] = load(p) if os.path.exists(p) else None
    return out["application"], out["infrastructure"]

def mold_commit(mold_id):
    for m in load(os.path.join(ROOT, "state", "factory.json")).get("molds", []):
        if m.get("mold_id") == mold_id: return (m.get("source") or {}).get("commit")

def seeds(app):
    d = os.path.join(adir(app), "seed", "orgs")
    return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".json") and not f.startswith(".")) if os.path.isdir(d) else []

def seed_digest(path):
    h = hashlib.sha256(open(path, "rb").read()); c = path[:-5] + "/customers.json"
    if os.path.exists(c): h.update(open(c, "rb").read())
    return h.hexdigest()

def applied_path(app): return os.path.join(adir(app), "seed", "orgs", ".applied.json")
def session_path(app): return os.path.join(PRIVATE, f"{app}.session.json")

def session(app):
    """The operator's own sign-in for this app, if one was traded for a code and has an hour left. Never printed."""
    p = session_path(app)
    if not os.path.exists(p): return None
    s = load(p)
    return s if s.get("expires_at", 0) - time.time() > 3600 else None

# ---- the stations: each returns (status, one plain sentence) -------------------------------------------------

def st_brief(app, a, i):
    p = os.path.join(ROOT, "briefs", app + ".md")
    return (DONE, f"briefs/{app}.md") if os.path.exists(p) or a else (OPERATOR, f"write a page describing the product into briefs/{app}.md, then: mint.py new {app} --brief briefs/{app}.md")

def st_state(app, a, i):
    q = os.path.join(adir(app), "questions.json")
    if os.path.exists(q) and load(q): return OPERATOR, f"{len(load(q))} question(s) the brief does not answer are in state/application/{app}/questions.json (the intake subagent asks them)"
    if not a or not i: return TODO, "turn the brief into the four state files"
    r = quiet(os.path.join(S, "factory.py"), "validate")
    return (DONE, "four state files, valid") if r.returncode == 0 else (FAILED, clean(r.stdout + r.stderr).strip().splitlines()[-1][:200])

def st_packs(app, a, i):
    packs = a.get("packs") or []
    if not packs: return NA, "this application is the mold as it comes (no pack of its own)"
    bad = [p for p in packs if quiet(os.path.join(S, "packs.py"), "check", p).returncode]
    return (FAILED, f"pack(s) {', '.join(bad)} do not check clean: python3 .claude/scripts/packs.py check {bad[0]}") if bad else (DONE, ", ".join(packs))

def st_brand(app, a, i):
    b = (a.get("surface") or {}).get("branding") or {}
    return (DONE, f"{b['product_name']}, {b.get('brand_color', 'default colour')}") if b.get("product_name") else (NA, "the mold's own look (set one with branding.py <app> set --name … --color … --logo …)")

MISSING_KEYS = {}   # app -> the key names st_keys found missing (for --json's needs)
def st_keys(app, a, i):
    if i.get("target") == "vm_remote":
        # Its own server (mold_v1-075): the check is offline, and what is left is the server, the domain and the key
        # name. The values themselves are asked for at a hidden prompt during the deploy and stored on the server.
        r = quiet(os.path.join(S, "provision.py"), app, "--check"); out = clean(r.stdout + r.stderr)
        todo = [l.strip()[2:] for l in out.splitlines() if l.startswith("  - ")]
        if r.returncode == 0: return DONE, "server, domain and key name are in place; your own values are asked for during the deploy"
        return OPERATOR, ("; ".join(todo) or (out.strip().splitlines() or ["the check could not run"])[-1])[:420]
    if i.get("target") != "vercel": return NA, "a vm application's keys live in its own environment file"
    r = quiet(os.path.join(S, "provision.py"), app, "--check"); out = clean(r.stdout + r.stderr)
    if r.returncode == 0: return DONE, (re.search(r"secrets present: \S+", out) or [""])[0] or "all present"
    missing = list(dict.fromkeys(re.findall(r"--set-secret (\S+)", out)))
    MISSING_KEYS[app] = missing
    if not missing: return FAILED, out.strip().splitlines()[-1][:220]
    return OPERATOR, f"{len(missing)} key(s) not set yet: {', '.join(missing)}. If another of your apps already runs: mint.py {app} reuse-keys <that_app>"

def st_deploy(app, a, i):
    v = i.get("vercel") or {}; url = v.get("production_url")
    if i.get("target") == "vm_remote":
        url = (i.get("vm_remote") or {}).get("production_url")
        if a.get("status") == "reverted" or not url or not i.get("deployed_at"):
            # It asks for values at a hidden prompt, so it is the operator's to run, at their own terminal.
            return OPERATOR, f"deploy to its own server, at your terminal: python3 .claude/scripts/provision.py {app} --deploy-remote (see every step first with --dry-run)"
        now = mold_commit(a["mold_id"]); was = a.get("mold_commit")
        if was and now and was != now: return OPERATOR, f"the mold moved ({was[:7]} -> {now[:7]}); redeploy at your terminal: python3 .claude/scripts/provision.py {app} --deploy-remote"
        return DONE, f"{url} (deployed {i['deployed_at'][:16]})"
    if i.get("target") != "vercel": return NA, "vm target: see the VM tasks"
    if (not url or not i.get("deployed_at")) and a.get("status") == "reverted" and (a.get("revert") or {}).get("reason"):
        # The first deploy stopped and recorded why (provision.py _revert). Running it again unchanged would stop the same way.
        why = " ".join(str(a["revert"]["reason"]).split())
        return FAILED, f"the first deploy stopped: {why[:300]} (state/application/{app}/application.json revert.reason; the whole log: python3 .claude/scripts/provision.py {app} status)"
    if not url or not i.get("deployed_at"): return TODO, "first deploy"
    now = mold_commit(a["mold_id"]); was = a.get("mold_commit")
    # A redeploy opens the app as the operator afterwards (provision.py's smoke test) and refuses to start without a
    # sign-in on hand, so with none it is the operator's step: the same one-time code the tests station asks for.
    signin = (f"a redeploy checks the app by opening it as you afterwards, so it needs your sign-in first: "
              f"mint.py {app} code-request <email>, then mint.py {app} code <digits> <email>")
    if a.get("status") == "reverted":
        why = "rolled back" if "rolled back" in str((a.get("revert") or {}).get("reason", "")) else "a test lane failed"
        return (TODO, f"{why}; redeploy once the cause is fixed") if session(app) else (OPERATOR, f"{why}; {signin}")
    if was and now and was != now:
        return (TODO, f"the mold moved ({was[:7]} -> {now[:7]}); redeploy to pick it up") if session(app) else (OPERATOR, f"the mold moved ({was[:7]} -> {now[:7]}); {signin}")
    if (v.get("smoke") or {}).get("result") == "needs_sign_in" and session(app):
        return TODO, SMOKE_PENDING
    note = " (its chat check waits for a sign-in)" if (v.get("smoke") or {}).get("result") == "needs_sign_in" else ""
    return DONE, f"{url} (deployed {i['deployed_at'][:16]}){note}"
SMOKE_PENDING = "deployed; now that a sign-in is on hand, run the post-deploy chat check"

def st_workspaces(app, a, i):
    ss = seeds(app)
    done = load(applied_path(app)) if os.path.exists(applied_path(app)) else {}
    if i.get("target") == "vm_remote":
        # A server of its own (mold_v1-152): the brief's own workspace is written by this station too (the Vercel path
        # has clone.py configure for it), ON the server: provision.py <app> --workspace-remote.
        import vm_remote
        try: own = vm_remote.state_seed_digest(a, adir(app))
        except vm_remote.Stop as e: return FAILED, str(e)[:220]
        stale = (["the application's own workspace"] if done.get(vm_remote.STATE_SEED) != own else []) + [os.path.basename(s)[:-5] for s in ss if done.get(os.path.basename(s)) != seed_digest(s)]
        # mold_v1-163: the same command writes the application's surface after its own workspace (the Vercel path's
        # clone.py configure), and records it under its own key. An app whose state has no surface asks for none.
        surf = vm_remote.surface_digest(a)
        if surf and done.get(vm_remote.SURFACE_KEY) != surf: stale.append("the application's surface (agent profile, subagent configs, workflow definitions and scripts)")
        return (TODO, f"write to the server's database: {', '.join(stale)}") if stale else (DONE, f"{len(ss) + 1} workspace(s) as written" + (", and the application's surface" if surf else ""))
    if not ss: return NA, "no extra workspace is described under seed/orgs/"
    stale = [os.path.basename(s)[:-5] for s in ss if done.get(os.path.basename(s)) != seed_digest(s)]
    return (TODO, f"apply: {', '.join(stale)}") if stale else (DONE, f"{len(ss)} workspace(s) as written")

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

def st_package(app, a, i):
    cli = i.get("agent_cli")
    if not cli: return NA, "no agent package is named (infrastructure.json agent_cli)"
    pub = cli.get("published") or {}; url = lane_url.target_url(i)
    if not url: return "later", f"{cli['package']}, once the app has an address to bake in"
    if pub.get("version") and pub.get("mold_commit") == a.get("mold_commit") and pub.get("origin", url) == url: return DONE, f"{cli['package']}@{pub['version']}"
    who = subprocess.run(["npm", "whoami"], capture_output=True, text=True)
    if who.returncode and not os.environ.get(cli.get("token_ref", "NPM_TOKEN")):
        return OPERATOR, f"{cli['package']} builds, but this machine is not signed in to npm. The operator runs `npm login` here once (it prints a link to open)"
    return TODO, f"publish {cli['package']}"

def st_address(app, a, i):
    v = i.get("vercel") or {}; d = v.get("custom_domain")
    if i.get("target") == "vm_remote":
        vr = i.get("vm_remote") or {}
        return (DONE, vr["production_url"]) if vr.get("production_url") else (NA, f"its own domain, {vr.get('domain') or 'not named yet'}, once deployed")
    if not d: return NA, f"it lives at {v.get('production_url') or 'its Vercel address'} (name one with domain.py {app} attach <domain>)"
    if v.get("production_url") == f"https://{d}": return DONE, f"https://{d}"
    ok = quiet(os.path.join(S, "domain.py"), app, "verify").returncode == 0
    return (TODO, f"{d} serves the app: switch the front door to it") if ok else (OPERATOR, f"{d} does not point here yet: its owner creates the one DNS record (domain.py {app} attach {d} prints it)")

STATIONS = [("brief", st_brief), ("state", st_state), ("packs", st_packs), ("brand", st_brand), ("keys", st_keys), ("deploy", st_deploy),
            ("workspaces", st_workspaces), ("tests", st_tests), ("package", st_package), ("address", st_address)]

def survey(app):
    a, i = docs(app); rows = []; blocked = False
    for name, fn in STATIONS:
        if (a is None or i is None) and name not in ("brief", "state"): rows.append((name, "later", "")); continue
        try: st, why = fn(app, a, i)
        except Exception as e: st, why = FAILED, f"could not be read: {e}"
        # Everything after a station that is not finished is "later", except the optional ends (package, address),
        # which only wait for the deploy: an npm sign-in must not hold up testing, and the reverse.
        if blocked and name not in ("package", "address") and st != NA: st, why = "later", ""
        if st in (TODO, OPERATOR, FAILED) and name not in ("package", "address"): blocked = True
        rows.append((name, st, why))
    return rows

def show(app, rows=None):
    rows = rows or survey(app); mark = {DONE: "✓", NA: "–", TODO: "→", OPERATOR: "?", FAILED: "✗", "later": " "}
    print(f"{app}")
    for n, st, why in rows: print(f"  {mark[st]} {n:11} {st:10} {why}")
    nxt = next(((n, st, why) for n, st, why in rows if st in (TODO, OPERATOR, FAILED)), None)
    # Not a station: it never blocks, never runs by itself, and is only ever made when the operator asks (repo.py).
    print("  " + repository_line(app))
    print("\n" + (f"finished: nothing is left to do." if not nxt else
                  f"next: {nxt[0]} — {'this one needs the operator. ' if nxt[1] == OPERATOR else ''}{nxt[2]}" + ("" if nxt[1] != TODO else f"\n      python3 .claude/scripts/mint.py {app} run")))
    return rows

def repository_line(app):
    try:
        sys.path.insert(0, S); import repo
        return repo.status_line(docs(app)[1], app)
    except Exception as e: return f"repository: could not be read ({e})"

def repo_auto(app, reason):
    """After a recorded lane run: one commit to the app's repository, ONLY if one is recorded and its auto_push is true."""
    if ((docs(app)[1] or {}).get("repository") or {}).get("auto_push") is True: py(os.path.join(S, "repo.py"), app, "auto", "--reason", reason)

# ---- doing a station ------------------------------------------------------------------------------------------

def do(app, name):
    a, i = docs(app); env = dict(os.environ)
    if name == "state":
        brief = (a or {}).get("brief") if isinstance((a or {}).get("brief"), str) and os.path.exists(os.path.join(ROOT, str((a or {}).get("brief")))) else f"briefs/{app}.md"
        args = [os.path.join(S, "intake.py"), brief, "--app", app]; ans = os.path.join(adir(app), "answers.json")
        if os.path.exists(ans): args += ["--answers", ans]
        return py(*args).returncode in (0,)
    if name == "deploy" and (i or {}).get("target") == "vercel" and st_deploy(app, a, i)[1] == SMOKE_PENDING:
        return py(os.path.join(S, "provision.py"), app, "--smoke").returncode == 0
    if name == "deploy":
        rc = py(os.path.join(S, "provision.py"), app, "--deploy").returncode
        # 3 after a FIRST deploy: deployed and healthy, and only the chat check waits for a sign-in, which the tests
        # station asks for anyway; the deploy station then runs `--smoke` once a session is on hand.
        a2, i2 = docs(app)
        return rc == 0 or (rc == 3 and a2.get("status") == "stamped" and ((i2.get("vercel") or {}).get("smoke") or {}).get("result") == "needs_sign_in")
    if name == "workspaces" and i.get("target") == "vm_remote":
        # One command writes the application's own workspace and every seed, on the server, and records what it applied.
        return py(os.path.join(S, "provision.py"), app, "--workspace-remote").returncode == 0
    if name == "workspaces":
        done = load(applied_path(app)) if os.path.exists(applied_path(app)) else {}
        for s in seeds(app):
            if done.get(os.path.basename(s)) == seed_digest(s): continue
            c = s[:-5] + "/customers.json"
            if py(os.path.join(S, "workspace.py"), app, s, *([c] if os.path.exists(c) else [])).returncode: return False
            done[os.path.basename(s)] = seed_digest(s); json.dump(done, open(applied_path(app), "w"), indent=2)
        return True
    if name == "tests":
        s = session(app)
        if s: env[re.sub(r"[^A-Za-z0-9]", "_", a["mold_id"]).upper() + "_SESSION_TOKEN"] = s["token"]
        py(os.path.join(S, "lanes.py"), app, env=env)
        repo_auto(app, "a lane run")
        return (docs(app)[0].get("status") != "reverted")
    if name == "package": return py(os.path.join(S, "agent_cli.py"), app, "publish").returncode == 0
    if name == "address": return py(os.path.join(S, "domain.py"), app, "switch").returncode == 0
    return False

def run(app):
    RAN.clear()
    for _ in range(12):
        rows = survey(app); nxt = next(((n, st) for n, st, _ in rows if st in (TODO, OPERATOR, FAILED)), None)
        if not nxt or nxt[1] != TODO: break
        print(f"\n=== {nxt[0]} ===", flush=True)
        t0 = time.time(); ok = do(app, nxt[0]); RAN.append({"station": nxt[0], "ok": bool(ok), "seconds": round(time.time() - t0)})
        # One line per station actually run: what `mint.py <app> report` reads to say where the time went.
        with open(os.path.join(adir(app), "mint-log.jsonl"), "a") as f:
            f.write(json.dumps({"station": nxt[0], "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0)), "seconds": round(time.time() - t0), "ok": bool(ok)}) + "\n")
        if not ok: print(f"\n{nxt[0]} did not finish; stopping here.\n"); break
    rows = show(app)
    LAST_ROWS[app] = rows
    nxt = next((st for _, st, _ in rows if st in (TODO, OPERATOR, FAILED)), None)
    # 3 = it stopped where only a person can go on (lib/agent_result.py); 1 = a station failed or did not finish.
    return 0 if not nxt else AR.EXIT["needs_human"] if nxt == OPERATOR else 1
RAN, LAST_ROWS = [], {}

# ---- the operator's side, without a value ever reaching the chat or the repo ------------------------------------

def reuse_keys(app, other):
    a, i = docs(app); oa, oi = docs(other)
    if not i or not oi: sys.exit("both applications need their state written first")
    sys.path.insert(0, S); import clone
    vals = clone.pull_env(oi["vercel"]["project"], ROOT)
    # The operator's OWN accounts, the same for every app they run. Never the per-app ones (databases, signing keys,
    # the sender address): those are made fresh for each application by the deploy.
    names = [n for n in (i.get("secrets_user") or []) if n not in ("PLATFORM_NOTIFY_FROM",) and vals.get(n) and vals[n] != "[SENSITIVE]"]
    if not names: sys.exit(f"{other} holds none of the keys {app} needs")
    for n in names:
        r = subprocess.run([sys.executable, os.path.join(S, "provision.py"), app, "--set-secret", n], input=vals[n] + "\n", text=True, cwd=ROOT, capture_output=True,
                           env=dict(os.environ, FACTORY_SECRET_FROM_STDIN="1"))   # the one trusted caller of a piped value
        print(f"  {n}: {'copied' if r.returncode == 0 else 'NOT copied: ' + clean(r.stderr).strip()[-160:].replace(vals[n], '<value>')}")
    # The sender is this app's own, but it is not a secret and needs nobody: <Product> <project@the operator's verified domain>.
    dom = load_factory(os.path.join(ROOT, "state")).get("defaults", {}).get("notify_domain")
    if dom and "PLATFORM_NOTIFY_FROM" in (i.get("secrets_user") or []):
        name = ((a.get("surface") or {}).get("branding") or {}).get("product_name") or a["app_id"]
        sender = f"{name} <{i['vercel']['project']}@{dom}>"
        r = subprocess.run([sys.executable, os.path.join(S, "provision.py"), app, "--set-secret", "PLATFORM_NOTIFY_FROM"], input=sender + "\n", text=True, cwd=ROOT, capture_output=True,
                           env=dict(os.environ, FACTORY_SECRET_FROM_STDIN="1"))
        print(f"  PLATFORM_NOTIFY_FROM: {sender if r.returncode == 0 else 'NOT set: ' + clean(r.stderr).strip()[-160:]}"); names.append("PLATFORM_NOTIFY_FROM")
    left = [n for n in (i.get("secrets_user") or []) if n not in names]
    if left: print(f"still this app's own to set: {', '.join(left)}")
    print("note: 'Continue with Google' works on the new address only after it is added to that Google client's Authorised JavaScript origins; emailed codes work at once.")
    return 0

def origin(app):
    u = lane_url.target_url(docs(app)[1] or {})
    if not u: sys.exit(f"{app} is not deployed yet")
    return u

def post(url, body):
    if services.REHEARSAL:
        code, doc = services.http_json("POST", url, body)
        if 200 <= code < 300 and isinstance(doc, dict): return doc
        sys.exit((doc or {}).get("error") if isinstance(doc, dict) and (doc or {}).get("error") else f"refused ({code})")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    try: return json.load(urllib.request.urlopen(req, timeout=20))
    except urllib.error.HTTPError as e:
        try: sys.exit(json.load(e).get("error") or f"refused ({e.code})")
        except ValueError: sys.exit(f"refused ({e.code})")

def code_request(app, email):
    post(origin(app) + "/api/auth/email/request", {"email": email}); print(f"a six-digit code is on its way to {email}; it lasts ten minutes"); return 0

def code(app, digits, email):
    r = post(origin(app) + "/api/auth/email/verify", {"email": email, "code": digits})
    os.makedirs(PRIVATE, mode=0o700, exist_ok=True)
    fd = os.open(session_path(app), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, json.dumps({"token": r["token"], "email": r["email"], "expires_at": int(time.time()) + int(r["expiresIn"])}).encode()); os.close(fd)
    print(f"signed in as {r['email']} for {r['expiresIn'] // 86400} days; kept in a private file outside the repository, never printed"); return 0

def new(app, brief, mold):
    if not re.match(r"^[a-z][a-z0-9_]{2,40}$", app): sys.exit("an app id is lowercase letters, digits and underscores")
    if os.path.isdir(adir(app)): sys.exit(f"{app} already exists: python3 .claude/scripts/mint.py {app}")
    if not os.path.exists(os.path.join(ROOT, brief)): sys.exit(f"no brief at {brief}")
    r = py(os.path.join(S, "intake.py"), brief, "--app", app, "--mold", mold)
    if r.returncode == 0: finish_new(app, open(os.path.join(ROOT, brief)).read())
    show(app); return 0 if r.returncode in (0, 2) else 1

def finish_new(app, brief_text):
    """What a newcomer should not have to ask for: the brand from the product's name, and the app's own agent
    package under the operator's npm organisation (factory.json defaults.agent_cli_scope)."""
    a, i = docs(app); d = load_factory(os.path.join(ROOT, "state")).get("defaults", {})
    m = re.search(r"^\s*product name:\s*\"?([^\n\".]+?)\"?\s*(?:\.|$)", brief_text, re.I | re.M)
    if m and not ((a.get("surface") or {}).get("branding") or {}).get("product_name"):
        args = ["--name", m.group(1).strip()]
        c = re.search(r"^\s*(?:brand )?colou?r:\s*(#[0-9a-fA-F]{6})", brief_text, re.I | re.M); l = re.search(r"^\s*logo:\s*(\S+)", brief_text, re.I | re.M)
        if c: args += ["--color", c.group(1)]
        if l and os.path.exists(os.path.join(ROOT, l.group(1))): args += ["--logo", l.group(1)]
        py(os.path.join(S, "branding.py"), app, "set", *args, capture_output=True)
    a, i = docs(app)
    if not i.get("agent_cli") and d.get("agent_cli_scope") and (i.get("vercel") or {}).get("project"):
        i["agent_cli"] = {"package": f"{d['agent_cli_scope']}/{i['vercel']['project']}", "access": "public", "registry": "https://registry.npmjs.org/", "token_ref": "NPM_TOKEN"}
        json.dump(i, open(os.path.join(adir(app), "infrastructure.json"), "w"), indent=2); open(os.path.join(adir(app), "infrastructure.json"), "a").write("\n")

def self_test():
    assert clean("\x1b[32mok\x1b[0m") == "ok"
    assert [n for n, _ in STATIONS] == ["brief", "state", "packs", "brand", "keys", "deploy", "workspaces", "tests", "package", "address"]
    assert re.findall(r"--set-secret (\S+)", "  python3 x.py app --set-secret EXA_API_KEY\n  … --set-secret RESEND_API_KEY") == ["EXA_API_KEY", "RESEND_API_KEY"]
    # where an application lives, per target: what the package, report and handoff stations and the sign-in code read
    vr = {"target": "vm_remote", "deployed_at": "2026-10-04T00:00:00+00:00", "vm_remote": {"domain": "app.example.com", "production_url": "https://app.example.com"},
          "agent_cli": {"package": "@x/y", "published": {"version": "0.1.0", "mold_commit": "c", "origin": "https://app.example.com"}}}
    assert lane_url.target_url(vr) == "https://app.example.com" and lane_url.target_url({"target": "vercel", "vercel": {"production_url": "https://x.vercel.app"}}) == "https://x.vercel.app"
    assert st_package("x", {"mold_commit": "c"}, vr) == (DONE, "@x/y@0.1.0"), st_package("x", {"mold_commit": "c"}, vr)
    undeployed = dict(vr, vm_remote={"domain": "app.example.com"}); undeployed.pop("deployed_at")
    assert st_package("x", {"mold_commit": "c"}, undeployed)[0] == "later"
    assert st_package("x", {"mold_commit": "c"}, {"target": "vercel", "vercel": {"production_url": "https://x.vercel.app"}, "agent_cli": dict(vr["agent_cli"], published={"version": "0.1.0", "mold_commit": "c"})}) == (DONE, "@x/y@0.1.0")
    import vm_remote
    ws = {"app_id": "x", "workspace": {"org": {"org_id": "acme", "name": "Acme"}, "operator_self": {"email": "o@acme.test"}, "members": [{"email": "o@acme.test", "role": "owner"}]}}
    import tempfile, shutil
    real_adir = globals()["adir"]; tmp = tempfile.mkdtemp(prefix="mint-selftest-")
    try:
        globals()["adir"] = lambda app: os.path.join(tmp, app)
        os.makedirs(os.path.join(tmp, "x", "seed", "orgs"))
        st, why = st_workspaces("x", ws, {"target": "vm_remote"})
        assert st == TODO and "the application's own workspace" in why, (st, why)
        json.dump({vm_remote.STATE_SEED: vm_remote.state_seed_digest(ws, os.path.join(tmp, "x"))}, open(os.path.join(tmp, "x", "seed", "orgs", ".applied.json"), "w"))
        assert st_workspaces("x", ws, {"target": "vm_remote"}) == (DONE, "1 workspace(s) as written")
        ws["workspace"]["members"].append({"email": "new@acme.test", "role": "member"})
        assert st_workspaces("x", ws, {"target": "vm_remote"})[0] == TODO          # state changed: the server no longer matches it
        assert st_workspaces("x", ws, {"target": "vercel"}) == (NA, "no extra workspace is described under seed/orgs/")
        # mold_v1-163: a state with a surface is not done until the surface, as it is now written, is on the server too
        ap = os.path.join(tmp, "x", "seed", "orgs", ".applied.json")
        ws["surface"] = {"primary_context": {"instructions": {"persona_name": "Ava", "subagents": [{"agent_key": "research"}]}}, "custom_workflow_builder": {"definitions": [], "scripts": []}}
        json.dump({vm_remote.STATE_SEED: vm_remote.state_seed_digest(ws, os.path.join(tmp, "x"))}, open(ap, "w"))
        st, why = st_workspaces("x", ws, {"target": "vm_remote"})
        assert st == TODO and "the application's surface" in why and "own workspace" not in why, (st, why)
        json.dump({vm_remote.STATE_SEED: vm_remote.state_seed_digest(ws, os.path.join(tmp, "x")), vm_remote.SURFACE_KEY: vm_remote.surface_digest(ws)}, open(ap, "w"))
        assert st_workspaces("x", ws, {"target": "vm_remote"}) == (DONE, "1 workspace(s) as written, and the application's surface")
        ws["surface"]["primary_context"]["instructions"]["persona_name"] = "Bo"
        assert st_workspaces("x", ws, {"target": "vm_remote"})[0] == TODO          # the surface changed in state: written again
    finally:
        globals()["adir"] = real_adir; shutil.rmtree(tmp, ignore_errors=True)
    # the repository is one printed line, never a station, and nothing is pushed unless state says auto_push is true
    import repo
    assert repo.status_line({}, "x") == "repository: none (ask for one: repo.py x publish --provider github|gitlab --dry-run)"
    assert "auto-push off" in repo.status_line({"repository": {"url": "https://github.com/a/b", "last_commit": "c" * 40}}, "x")
    real_docs, real_py, ran = globals()["docs"], globals()["py"], []
    try:
        globals()["py"] = lambda *a, **k: ran.append(a)
        for rec, n in ((None, 0), ({"auto_push": False}, 0), ({"url": "u"}, 0), ({"auto_push": True}, 1)):
            globals()["docs"] = lambda app, rec=rec: ({}, {"repository": rec} if rec is not None else {})
            ran.clear(); repo_auto("x", "a lane run"); assert len(ran) == n, (rec, ran)
    finally:
        globals()["docs"], globals()["py"] = real_docs, real_py
    # --json: the survey as one result, the needs a person gets, and the exit codes (lib/agent_result.py)
    real_runs = runs.status
    try:
        runs.status = lambda *a, **k: AR.result(True, "done", "", "", [], "", {"record": None})
        globals()["repository_line"] = lambda app: "repository: none"
        rows = [("brief", DONE, ""), ("keys", OPERATOR, "2 key(s) not set yet: A_KEY, B_KEY"), ("deploy", "later", "")]
        MISSING_KEYS["x"] = ["A_KEY", "B_KEY"]
        r = survey_result("x", rows)
        assert set(r) == {"ok", "status", "summary", "next", "needs", "log", "details"} and r["status"] == "needs_human" and AR.exit_code(r) == 3
        assert [n["name"] for n in r["needs"]] == ["A_KEY", "B_KEY"] and all(n["kind"] == "secret" and "separate terminal" in n["how"] and "--set-secret" in n["how"] for n in r["needs"])
        r = survey_result("x", [("tests", OPERATOR, "signed-in checks were skipped")])
        assert r["needs"][0]["kind"] == "code" and "only after you say so" in r["needs"][0]["how"]
        r = survey_result("x", [("deploy", TODO, "first deploy")])
        assert r["status"] == "done" and AR.exit_code(r) == 0 and r["next"].startswith("Ask the operator for a plain yes")
        r = survey_result("x", [("deploy", FAILED, "the first deploy stopped: x. Run: python3 .claude/scripts/provision.py x --deploy")])
        assert r["status"] == "failed" and AR.exit_code(r) == 1 and r["next"] == "python3 .claude/scripts/provision.py x --deploy"
        r = survey_result("x", [("brief", DONE, ""), ("package", NA, "")])
        assert r["status"] == "done" and r["ok"] and r["summary"].startswith("x is finished")
        # `run` exits 3 when it stops where only a person can go on
        globals()["survey"] = lambda app: [("keys", OPERATOR, "1 key(s) not set yet: A_KEY")]; globals()["show"] = lambda app, rows=None: survey(app)
        assert run("x") == 3
        globals()["survey"] = lambda app: [("deploy", FAILED, "x")]
        assert run("x") == 1
    finally:
        runs.status = real_runs
    # the sessions live where FACTORY_PRIVATE_DIR says (a rehearsal never touches the operator's own)
    import subprocess as sp
    out = sp.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {S!r}); import mint; print(mint.session_path('a'))"], env=dict(os.environ, FACTORY_PRIVATE_DIR="/tmp/sf-private-x"),
                 capture_output=True, text=True).stdout.strip()
    assert out == "/tmp/sf-private-x/a.session.json", out
    # reuse-keys is the one trusted caller of a piped value, and says so with FACTORY_SECRET_FROM_STDIN=1
    import inspect
    assert inspect.getsource(reuse_keys).count('FACTORY_SECRET_FROM_STDIN="1"') == 2
    print("mint: 31 checks passed"); return 0

# ---- --json: the survey as one result (lib/agent_result.py) ---------------------------------------------------------
def needs_for(app, name, why):
    """What a person must give at an OPERATOR station, as `needs` entries with plain instructions."""
    if name == "keys":
        return [{"kind": "secret", "name": k, "how": AR.secret_how(app, k)} for k in MISSING_KEYS.get(app) or []] or \
               [{"kind": "approval", "name": "server, domain and key name", "how": why}]
    if name == "tests":
        return [{"kind": "code", "name": "one-time sign-in code", "how":
                 f"Tell me which email address can sign in to {app} and say that I may send it a code. I then run "
                 f"`python3 .claude/scripts/mint.py {app} code-request <email>` (only after you say so); a six-digit code arrives "
                 f"by email within a minute and lasts ten minutes. Paste just the six digits here; the session it buys is kept in "
                 f"a private file, never shown."}]
    if name == "package":
        return [{"kind": "login", "name": "npm sign-in", "how": "The operator runs `npm login` once in a separate terminal on this machine; it prints a link to open and confirm."}]
    if name == "address":
        return [{"kind": "dns", "name": "DNS record", "how": f"The domain's owner adds one DNS record at their domain registrar; `python3 .claude/scripts/domain.py {app} status` prints it exactly. {why}"}]
    if name == "deploy" and "needs your sign-in" in (why or ""):
        return needs_for(app, "tests", why)
    if name == "deploy":
        return [{"kind": "approval", "name": "deploy at the operator's terminal", "how": f"The operator runs it themselves, in a separate terminal (it asks for values at a hidden prompt): python3 .claude/scripts/provision.py {app} --deploy-remote"}]
    if name == "state":
        return [{"kind": "approval", "name": "intake questions", "how": f"Answer the questions in state/application/{app}/questions.json, one at a time; I write the answers to answers.json and run the state station again. {why}"}]
    if name == "brief":
        return [{"kind": "approval", "name": "brief", "how": why}]
    return [{"kind": "approval", "name": name, "how": why}]

def survey_result(app, rows, ran=None):
    stations = [{"name": n, "status": st, "why": why} for n, st, why in rows]
    nxt = next(((n, st, why) for n, st, why in rows if st in (TODO, OPERATOR, FAILED)), None)
    details = {"app": app, "stations": stations, "repository": repository_line(app)}
    if ran is not None: details["ran"] = ran
    bg = runs.status(ROOT, "mint.py", app, "mint", f"python3 .claude/scripts/mint.py {app} run --background --json")
    if bg["details"].get("record"): details["background_run"] = {k: bg[k] for k in ("status", "summary", "next", "log")}
    if not nxt:
        return AR.result(True, "done", f"{app} is finished: every station is done or not needed.", "", [], "", details)
    n, st, why = nxt
    if st == OPERATOR:
        needs = needs_for(app, n, why)
        return AR.result(False, "needs_human", f"{app} stops at {n}: {why}", needs[0]["how"], needs, "", details)
    if st == FAILED:
        return AR.result(False, "failed", f"{app}: the {n} station failed: {why}", AR.command_in(why) or f"Read why, fix the cause, then: python3 .claude/scripts/mint.py {app} run --json", [], "", details)
    ask = n == "deploy"
    return AR.result(True, "done", f"{app}: next is {n} ({why}); it needs nobody" + (" but a yes to deploy" if ask else "") + ".",
                     ("Ask the operator for a plain yes to deploy (unless they already asked for it), then: " if ask else "")
                     + f"python3 .claude/scripts/mint.py {app} run --background --json", [], "", details)

def main_json(a):
    if a[0] == "list":
        apps = []
        for app in sorted(d for d in os.listdir(os.path.join(ROOT, "state", "application")) if d != "app_id" and os.path.isdir(adir(d))):
            nxt = next(((n, st, why) for n, st, why in survey(app) if st in (TODO, OPERATOR, FAILED)), None)
            apps.append({"app": app, "next_station": nxt[0] if nxt else None, "status": nxt[1] if nxt else "finished", "why": nxt[2] if nxt else ""})
        return AR.emit(AR.result(True, "done", f"{len(apps)} application(s): " + ", ".join(f"{x['app']} ({x['next_station'] + ': ' + x['status'] if x['next_station'] else 'finished'})" for x in apps),
                                 "", [], "", {"apps": apps}))
    app = a[0]
    if not os.path.isdir(adir(app)) and not os.path.exists(os.path.join(ROOT, "briefs", app + ".md")):
        return AR.emit(AR.result(False, "failed", f"There is no application {app} (no state/application/{app}/ and no briefs/{app}.md).",
                                 f"python3 .claude/scripts/mint.py new {app} --brief briefs/{app}.md", [], "", {}))
    if len(a) == 1 or a[1] == "status": return AR.emit(survey_result(app, survey(app)))
    if a[1] == "run":
        if "--background" in a:
            res, rc = runs.start_background(ROOT, "mint.py", app, "mint", [app, "run"], f"python3 .claude/scripts/mint.py {app} run --background --json")
            if rc == 0: res["next"] = f"Check on it every minute or so: python3 .claude/scripts/mint.py {app} --json (details.background_run)"
            return AR.emit(res, locked=rc == AR.LOCKED)
        def go(_):
            with runs.Held(ROOT, app, "mint", "mint.py", [app, "run"]) as h:
                if h.locked: HELD_BY[app] = h.lock.held_by; return AR.LOCKED
                return run(app)
        def finish(rc, log, notes):
            if rc == AR.LOCKED: return runs.locked_result("mint.py", app, "mint", HELD_BY.get(app, {}))
            return survey_result(app, LAST_ROWS.get(app) or survey(app), list(RAN))
        return AR.run_json(go, [], root=ROOT, app=app, step="mint", finish=finish)
    return None
HELD_BY = {}

def main(a):
    if "--self-test" in a: return self_test()
    if a: services.script_start("mint.py", [x for x in a if x != "--json"], action=(a[1] if len(a) > 1 and not a[1].startswith("-") else "status") if a[0] not in ("new", "list") else a[0])
    as_json, a = AR.wants_json(a)
    if as_json and a and a[0] != "new":
        r = main_json(a)
        if r is not None: return r
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
    if len(a) == 1 or a[1] == "status": show(app); return 0
    if a[1] == "run" and "--background" in a:
        res, rc = runs.start_background(ROOT, "mint.py", app, "mint", [app, "run"], f"python3 .claude/scripts/mint.py {app} run --background")
        print(res["summary"] + f"\nnext: python3 .claude/scripts/mint.py {app}"); return rc
    if a[1] == "run": return run(app)
    if a[1] == "report": return py(os.path.join(S, "mint_report.py"), app, *a[2:]).returncode
    if a[1] == "handoff":
        py(os.path.join(S, "mint_report.py"), app, capture_output=True)   # the page quotes the report, so refresh it first
        return py(os.path.join(S, "mint_handoff.py"), app).returncode
    if a[1] == "reuse-keys" and len(a) == 3: return reuse_keys(app, a[2])
    if a[1] == "code-request" and len(a) == 3: return code_request(app, a[2])
    if a[1] == "code" and len(a) == 4: return code(app, a[2], a[3])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
