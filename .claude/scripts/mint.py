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
  mint.py list                     every application and its next step
  mint.py --self-test

The stations. Each knows whether it is done by LOOKING (state, the registry, the live app), never by remembering,
so `run` can be repeated at any time and picks up where things stand:

  brief      briefs/<app_id>.md exists
  state      the four state files are written and valid; nothing in questions.json is unanswered
  packs      every pack the application names checks clean
  brand      a name, a colour and a logo are set (or the mold's default look is accepted)
  keys       every credential the deploy needs is present BY NAME          <- the operator, once per operator
  deploy     the three services answer, on the current mold snapshot
  workspaces every seed under state/application/<app_id>/seed/orgs/ is applied as it is now written
  tests      the five lanes ran after the last deploy, none failed, signed-in checks measured  <- a code from the operator
  package    the application's own agent package is published at the app's address          <- the operator's npm sign-in
  address    the application's own domain serves it (only if one is named)                  <- one DNS record

This file only ORDERS the work. Each station is the script that already owns it (intake.py, packs.py, branding.py,
provision.py, workspace.py, lanes.py, agent_cli.py, domain.py); their rules and refusals are unchanged.
"""
import hashlib, json, os, re, subprocess, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = os.path.join(ROOT, ".claude", "scripts")
PRIVATE = os.path.join(os.path.expanduser("~"), ".cache", "software-factory")   # outside the repo, mode 700
DONE, TODO, OPERATOR, FAILED, NA = "done", "next", "needs you", "failed", "not needed"

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

def st_keys(app, a, i):
    if i.get("target") != "vercel": return NA, "a vm application's keys live in its own environment file"
    r = quiet(os.path.join(S, "provision.py"), app, "--check"); out = clean(r.stdout + r.stderr)
    if r.returncode == 0: return DONE, (re.search(r"secrets present: \S+", out) or [""])[0] or "all present"
    missing = re.findall(r"--set-secret (\S+)", out)
    if not missing: return FAILED, out.strip().splitlines()[-1][:220]
    return OPERATOR, f"{len(missing)} key(s) not set yet: {', '.join(missing)}. If another of your apps already runs: mint.py {app} reuse-keys <that_app>"

def st_deploy(app, a, i):
    v = i.get("vercel") or {}; url = v.get("production_url")
    if i.get("target") != "vercel": return NA, "vm target: see the VM tasks"
    if not url or not i.get("deployed_at"): return TODO, "first deploy"
    now = mold_commit(a["mold_id"]); was = a.get("mold_commit")
    if a.get("status") == "reverted": return TODO, "a test lane failed; redeploy once the cause is fixed"
    if was and now and was != now: return TODO, f"the mold moved ({was[:7]} -> {now[:7]}); redeploy to pick it up"
    return DONE, f"{url} (deployed {i['deployed_at'][:16]})"

def st_workspaces(app, a, i):
    ss = seeds(app)
    if not ss: return NA, "no extra workspace is described under seed/orgs/"
    done = load(applied_path(app)) if os.path.exists(applied_path(app)) else {}
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
    pub = cli.get("published") or {}; url = (i.get("vercel") or {}).get("production_url")
    if not url: return "later", f"{cli['package']}, once the app has an address to bake in"
    if pub.get("version") and pub.get("mold_commit") == a.get("mold_commit") and pub.get("origin", url) == url: return DONE, f"{cli['package']}@{pub['version']}"
    who = subprocess.run(["npm", "whoami"], capture_output=True, text=True)
    if who.returncode and not os.environ.get(cli.get("token_ref", "NPM_TOKEN")):
        return OPERATOR, f"{cli['package']} builds, but this machine is not signed in to npm. The operator runs `npm login` here once (it prints a link to open)"
    return TODO, f"publish {cli['package']}"

def st_address(app, a, i):
    v = i.get("vercel") or {}; d = v.get("custom_domain")
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
    print("\n" + (f"finished: nothing is left to do." if not nxt else
                  f"next: {nxt[0]} — {'this one needs the operator. ' if nxt[1] == OPERATOR else ''}{nxt[2]}" + ("" if nxt[1] != TODO else f"\n      python3 .claude/scripts/mint.py {app} run")))
    return rows

# ---- doing a station ------------------------------------------------------------------------------------------

def do(app, name):
    a, i = docs(app); env = dict(os.environ)
    if name == "state":
        brief = (a or {}).get("brief") if isinstance((a or {}).get("brief"), str) and os.path.exists(os.path.join(ROOT, str((a or {}).get("brief")))) else f"briefs/{app}.md"
        args = [os.path.join(S, "intake.py"), brief, "--app", app]; ans = os.path.join(adir(app), "answers.json")
        if os.path.exists(ans): args += ["--answers", ans]
        return py(*args).returncode in (0,)
    if name == "deploy": return py(os.path.join(S, "provision.py"), app, "--deploy").returncode == 0
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
        return (docs(app)[0].get("status") != "reverted")
    if name == "package": return py(os.path.join(S, "agent_cli.py"), app, "publish").returncode == 0
    if name == "address": return py(os.path.join(S, "domain.py"), app, "switch").returncode == 0
    return False

def run(app):
    for _ in range(12):
        rows = survey(app); nxt = next(((n, st) for n, st, _ in rows if st in (TODO, OPERATOR, FAILED)), None)
        if not nxt or nxt[1] != TODO: break
        print(f"\n=== {nxt[0]} ===", flush=True)
        t0 = time.time(); ok = do(app, nxt[0])
        # One line per station actually run: what `mint.py <app> report` reads to say where the time went.
        with open(os.path.join(adir(app), "mint-log.jsonl"), "a") as f:
            f.write(json.dumps({"station": nxt[0], "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0)), "seconds": round(time.time() - t0), "ok": bool(ok)}) + "\n")
        if not ok: print(f"\n{nxt[0]} did not finish; stopping here.\n"); break
    rows = show(app)
    return 0 if not any(st in (TODO, OPERATOR, FAILED) for _, st, _ in rows) else 1

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
        r = subprocess.run([sys.executable, os.path.join(S, "provision.py"), app, "--set-secret", n], input=vals[n] + "\n", text=True, cwd=ROOT, capture_output=True)
        print(f"  {n}: {'copied' if r.returncode == 0 else 'NOT copied: ' + clean(r.stderr).strip()[-160:].replace(vals[n], '<value>')}")
    # The sender is this app's own, but it is not a secret and needs nobody: <Product> <project@the operator's verified domain>.
    dom = load(os.path.join(ROOT, "state", "factory.json")).get("defaults", {}).get("notify_domain")
    if dom and "PLATFORM_NOTIFY_FROM" in (i.get("secrets_user") or []):
        name = ((a.get("surface") or {}).get("branding") or {}).get("product_name") or a["app_id"]
        sender = f"{name} <{i['vercel']['project']}@{dom}>"
        r = subprocess.run([sys.executable, os.path.join(S, "provision.py"), app, "--set-secret", "PLATFORM_NOTIFY_FROM"], input=sender + "\n", text=True, cwd=ROOT, capture_output=True)
        print(f"  PLATFORM_NOTIFY_FROM: {sender if r.returncode == 0 else 'NOT set: ' + clean(r.stderr).strip()[-160:]}"); names.append("PLATFORM_NOTIFY_FROM")
    left = [n for n in (i.get("secrets_user") or []) if n not in names]
    if left: print(f"still this app's own to set: {', '.join(left)}")
    print("note: 'Continue with Google' works on the new address only after it is added to that Google client's Authorised JavaScript origins; emailed codes work at once.")
    return 0

def origin(app):
    u = ((docs(app)[1] or {}).get("vercel") or {}).get("production_url")
    if not u: sys.exit(f"{app} is not deployed yet")
    return u

def post(url, body):
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
    a, i = docs(app); d = load(os.path.join(ROOT, "state", "factory.json")).get("defaults", {})
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
    print("mint: 3 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
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
    if a[1] == "run": return run(app)
    if a[1] == "report": return py(os.path.join(S, "mint_report.py"), app, *a[2:]).returncode
    if a[1] == "reuse-keys" and len(a) == 3: return reuse_keys(app, a[2])
    if a[1] == "code-request" and len(a) == 3: return code_request(app, a[2])
    if a[1] == "code" and len(a) == 4: return code(app, a[2], a[3])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
