#!/usr/bin/env python3
"""mint.py — one application, from a description to a tested, live product. The whole line, in order.

  mint.py new <app_id> --brief briefs/<app_id>.md [--mold mold_v1]   start one (the brief is a page of plain words)
  mint.py <app_id>                 where it stands: every station, and THE ONE thing that happens next
  mint.py <app_id> run             do every station that needs nobody, in order; stop at the first that needs
                                   the operator (and say exactly what is needed) or at the first that fails
  mint.py <app_id> reuse-keys <other_app_id>   copy the operator's own service keys from an app that already
                                   runs (in memory, never printed), so a second app never asks for them again
  mint.py <app_id> code-request <email>        email that person a one-time sign-in code (only when they said so).
                                   It LOOKS first: the app emails a code only to an address that belongs to one of
                                   its workspaces or holds an invite, and answers the same either way. An address in
                                   none is told so, with the next step, and nothing is sent (lib/membership.py)
  mint.py <app_id> run --only workspaces       write the application's own workspace (application.json workspace) to
                                   the deployed app now, with the operator as its owner; safe to repeat. `run` does
                                   this by itself right after the first deploy; this is that one step alone, for when
                                   another station (a redeploy that wants a sign-in) stands in front of it
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
  workspaces the application's OWN workspace (application.json workspace.org) is on the deployed app, with the operator
             (state/factory.local.json defaults.operator_email) as its owner: written right after the first deploy,
             because an app with no workspace can email nobody a sign-in code (mold_v1-245). Then every seed under
             state/application/<app_id>/seed/orgs/, applied as it is now written. On Vercel through workspace.py; for
             an app on a server of its own, on that server, with the application's surface (the default agent profile,
             per-subagent configs, workflow definitions and scripts) after it (provision.py --workspace-remote)
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
import membership # who the deployed app will email a sign-in code to, read from its own database (mold_v1-245)
import agent_result as AR, runs, services   # --json results, background runs, the rehearsal switch and call log
PRIVATE = services.private_dir()   # FACTORY_PRIVATE_DIR, else ~/.cache/software-factory

def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
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
        return DONE, f"{url} (deployed {i['deployed_at'][:16]}){google_note(app, i)}"
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
        return (TODO, f"{why}; redeploy once the cause is fixed") if session(app) else (OPERATOR, f"{why}; {signin}{code_first(app, a)}")
    if was and now and was != now:
        return (TODO, f"the mold moved ({was[:7]} -> {now[:7]}); redeploy to pick it up") if session(app) else (OPERATOR, f"the mold moved ({was[:7]} -> {now[:7]}); {signin}{code_first(app, a)}")
    if (v.get("smoke") or {}).get("result") == "needs_sign_in" and session(app):
        return TODO, SMOKE_PENDING
    note = " (its chat check waits for a sign-in)" if (v.get("smoke") or {}).get("result") == "needs_sign_in" else ""
    return DONE, f"{url} (deployed {i['deployed_at'][:16]}){note}{google_note(app, i)}"

def google_note(app, i):
    """Said on the deploy line when the last check found Google sign-in not working (provision.py records it after
    every deploy and --smoke; mold_v1-242). It never blocks a station: emailed codes still sign people in."""
    c = ((i or {}).get("google_sign_in") or {}).get("check") or {}
    if c.get("result") != "not_working": return ""
    return f"; Google sign-in is NOT WORKING there (emailed codes work); the steps: python3 .claude/scripts/provision.py {app} --google-signin"
SMOKE_PENDING = "deployed; now that a sign-in is on hand, run the post-deploy chat check"

# ---- the workspaces station (mold_v1-245) ---------------------------------------------------------------------
# A deployed app with no workspace can email nobody a sign-in code: it answers "on its way" to every address and sends
# only to a member. So the application's OWN workspace is written right after the first deploy, owned by the operator.
OWN = "application.json#workspace"     # the key the own workspace is recorded under in seed/orgs/.applied.json (vm_remote.STATE_SEED)

def operator_email(): return membership.operator_email(ROOT)
def look(app, emails): return membership.read(app, emails, ROOT)    # the deployed app's own database, read-only
def seen_path(app): return os.path.join(PRIVATE, f"{app}.workspaces.json")
def seen(app): return load(seen_path(app)) if os.path.exists(seen_path(app)) else {}
def applied(app): return load(applied_path(app)) if os.path.exists(applied_path(app)) else {}
def record_applied(app, key, digest):
    done = applied(app); done[key] = digest
    os.makedirs(os.path.dirname(applied_path(app)), exist_ok=True); json.dump(done, open(applied_path(app), "w"), indent=2)

def own_org(a): return ((((a or {}).get("workspace") or {}).get("org") or {}).get("org_id") or "").strip()

def own_seed(app, a):
    """A Vercel application's own workspace as a workspace.py seed: application.json workspace (its id, name, people,
    roster, administrators), OWNED BY THE OPERATOR; an owner state names keeps the owner's role beside them. It carries
    the guard "no_other_workspace": a database that already holds workspaces, and not this one, is never given a new one.
    (seed, "") or (None, why): why is "operator" when this machine does not know the operator's address."""
    import vm_remote
    ws = a.get("workspace") or {}; org = dict(ws.get("org") or {}); op = operator_email()
    if not op: return None, "operator"
    org.setdefault("name", org.get("org_id"))
    try: seed = vm_remote.state_seed(dict(a, workspace=dict(ws, org=org)), operator=op)
    except vm_remote.Stop as e: return None, str(e)
    if seed["owner"] != op:
        if not any(m["email"] == seed["owner"] for m in seed["members"]): seed["members"].append({"email": seed["owner"], "role": "owner"})
        seed["owner"] = op
    seed["guard"] = "no_other_workspace"
    return seed, ""

def own_customers(app, org): return os.path.join(adir(app), "seed", "orgs", org, "customers.json")
def own_digest(app, seed):
    h = hashlib.sha256(json.dumps(seed, sort_keys=True).encode()); c = own_customers(app, seed["org_id"])
    if os.path.exists(c): h.update(open(c, "rb").read())
    return h.hexdigest()

def standing(app, a, i):
    """Where a Vercel application's workspaces stand, by LOOKING: {"org", "operator", "seed", "why", "items", "error"}.
    items: [{"key", "org", "digest", "emails", "path", "ok", "role"}], the own workspace first, then each seed file.
    An item is ok when it was applied as it is now written (seed/orgs/.applied.json), or when the deployed app is SEEN to
    hold it: the workspace exists, has an owner, and every person the seed names is a member (kept, as seen, in a private
    file outside the repository, so the next look costs nothing). One read of the app's database answers for all of them."""
    org = own_org(a); op = operator_email(); done = applied(app); cache = seen(app); items = []
    seed, why = own_seed(app, a) if org else (None, "none")
    if org:
        items.append({"key": OWN, "org": org, "digest": own_digest(app, seed) if seed else "seen:" + org, "path": None,
                      "emails": [seed["owner"]] + [m["email"] for m in seed["members"]] if seed else []})
    for p in seeds(app):
        try: d = load(p)
        except ValueError: d = {}
        items.append({"key": os.path.basename(p), "org": d.get("org_id") or os.path.basename(p)[:-5], "digest": seed_digest(p), "path": p,
                      "emails": [str(e).strip().lower() for e in [d.get("owner")] + [m.get("email") for m in d.get("members") or [] if isinstance(m, dict)] if e]})
    for it in items: it["ok"] = it["digest"] in (done.get(it["key"]), cache.get(it["key"])); it["role"] = cache.get(it["key"] + "#role")
    # A seed file that describes the app's own workspace, applied as written, IS the own workspace.
    if items and org and not items[0]["ok"] and any(x["ok"] and x["org"] == org for x in items[1:]): items[0]["ok"] = True
    out = {"org": org, "operator": op, "seed": seed, "why": why, "items": items, "error": ""}
    unsure = [it for it in items if not it["ok"]]
    if not unsure or not (i.get("deployed_at") and lane_url.target_url(i)): return out
    emails = list(dict.fromkeys([e for it in unsure for e in it["emails"]] + ([op] if op else [])))
    raw = look(app, emails)
    if raw.get("error") or not isinstance(raw.get("orgs"), list): out["error"] = str(raw.get("error") or "nothing was read")[:160]; return out
    there = {o["org_id"]: o for o in raw["orgs"]}; fresh = False
    for it in unsure:
        o = there.get(it["org"])
        if not o or o.get("error") or not o.get("owners"): continue
        role = dict(zip(emails, [p.get("member") for p in o.get("people") or []]))
        if all(role.get(e) for e in it["emails"]):
            it["ok"] = True; cache[it["key"]] = it["digest"]; fresh = True
            if it["key"] == OWN and op: it["role"] = cache[OWN + "#role"] = role.get(op) or "none"
    if fresh:
        try:
            os.makedirs(PRIVATE, mode=0o700, exist_ok=True); json.dump(cache, open(seen_path(app), "w"), indent=1)
        except OSError: pass
    return out

def own_words(st):
    org, op, role = st["org"], st["operator"], (st["items"][0].get("role") if st["items"] else None)
    if not op: return f"workspace {org} (on the app already, with an owner)"
    if role in (None, "owner"): return f"workspace {org}, owner {op}"
    return f"workspace {org} (on the app already; its owner is someone else, and {op} is {'not a member' if role == 'none' else 'a ' + role + ' there'})"

NO_OPERATOR = ("the application's own workspace needs an owner, and this machine does not know the operator's email address: ask them which "
               "address they sign in with and put it in state/factory.local.json as defaults.operator_email")

def st_workspaces(app, a, i):
    ss = seeds(app)
    done = applied(app)
    if i.get("target") == "vm_remote":
        # A server of its own (mold_v1-152): the brief's own workspace is written ON the server: provision.py <app>
        # --workspace-remote. Its owner is the one state names, else the operator (mold_v1-245).
        import vm_remote
        try: own = vm_remote.state_seed_digest(a, adir(app)); who = vm_remote.state_seed(a)
        except vm_remote.Stop as e: return (FAILED, str(e)[:220]) if operator_email() or not own_org(a) else (OPERATOR, NO_OPERATOR)
        stale = (["the application's own workspace"] if done.get(vm_remote.STATE_SEED) != own else []) + [os.path.basename(s)[:-5] for s in ss if done.get(os.path.basename(s)) != seed_digest(s)]
        # mold_v1-163: the same command writes the application's surface after its own workspace (the Vercel path's
        # clone.py configure), and records it under its own key. An app whose state has no surface asks for none.
        surf = vm_remote.surface_digest(a)
        if surf and done.get(vm_remote.SURFACE_KEY) != surf: stale.append("the application's surface (agent profile, subagent configs, workflow definitions and scripts)")
        if stale: return TODO, f"write to the server's database: {', '.join(stale)}"
        return DONE, f"workspace {who['org_id']}, owner {who['owner']}; {len(ss) + 1} workspace(s) as written" + (", and the application's surface" if surf else "")
    if i.get("target") != "vercel" or not own_org(a):
        if not ss: return NA, "no extra workspace is described under seed/orgs/"
        stale = [os.path.basename(s)[:-5] for s in ss if done.get(os.path.basename(s)) != seed_digest(s)]
        return (TODO, f"apply: {', '.join(stale)}") if stale else (DONE, f"{len(ss)} workspace(s) as written")
    org, op = own_org(a), operator_email()
    if not (i.get("deployed_at") and lane_url.target_url(i)):
        return TODO, f"right after the first deploy: the application's own workspace {org}" + (f", owner {op}" if op else "")
    st = standing(app, a, i); own = st["items"][0]
    stale = [x["key"][:-5] for x in st["items"][1:] if not x["ok"]]
    if not own["ok"]:
        if not st["seed"]: return (OPERATOR, NO_OPERATOR) if st["why"] == "operator" else (FAILED, st["why"][:220])
        return TODO, (f"create the application's own workspace {org}, owner {op}" + (f" (the app's database could not be looked at: {st['error']})" if st["error"] else "")
                      + (f"; then apply: {', '.join(stale)}" if stale else ""))
    if stale: return TODO, f"apply: {', '.join(stale)}" + (f" (the app's database could not be looked at: {st['error']})" if st["error"] else "")
    return DONE, own_words(st) + (f"; {len(ss)} seed(s) under seed/orgs/ as written" if ss else "")

CODE_FIRST = {}
def code_first(app, a):
    """For a line that asks the operator for a sign-in code: "" when their address can be emailed one (or that could not
    be seen), else the step that comes first. The app emails a code only to a member of one of its workspaces."""
    if app in CODE_FIRST: return CODE_FIRST[app]
    out = ""
    try:
        op = operator_email()
        known = OWN in applied(app) or seen(app).get(OWN + "#role") in ("owner", "admin", "engineer", "member")
        if op and not known and membership.check(app, op, look).get("can") is False:
            out = f". FIRST: {op} belongs to no workspace on {app}, so the app would email it no code: mint.py {app} run --only workspaces"
    except Exception: pass
    CODE_FIRST[app] = out
    return out

def st_tests(app, a, i):
    t = a.get("testing") or {}; dep = i.get("deployed_at") or ""
    if any((t.get(l) or {}).get("status") == "fail" for l in t): return FAILED, "a lane failed; its report is named in application.json testing"
    ran = [(t.get(l) or {}).get("run_at") or "" for l in ("functional", "context", "load", "accessibility", "responsiveness")]
    if not all(ran) or min(ran) < dep: return TODO, "run the five lanes against this deploy"
    unsigned = [l for l in ("functional", "accessibility", "responsiveness") if (t.get(l) or {}).get("status") == "skipped"]
    if unsigned and not session(app):
        return OPERATOR, (f"nothing failed, but the signed-in checks in {', '.join(unsigned)} were skipped. They need a one-time code "
                          f"from someone who can sign in: mint.py {app} code-request <email>, then mint.py {app} code <digits> <email>{code_first(app, a)}")
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
        # ...and a workspace that is on the deployed app stays there through a redeploy: it is shown as it is, so a
        # pending redeploy never hides whether anyone can be emailed a sign-in code (mold_v1-245).
        if blocked and name not in ("package", "address") and st != NA and not (name == "workspaces" and st == DONE): st, why = "later", ""
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
    g = google_line(app)
    if g: print("  " + g)
    print("\n" + (f"finished: nothing is left to do." if not nxt else
                  f"next: {nxt[0]} — {'this one needs the operator. ' if nxt[1] == OPERATOR else ''}{nxt[2]}" + ("" if nxt[1] != TODO else f"\n      python3 .claude/scripts/mint.py {app} run")))
    return rows

def google_line(app):
    """What the last check said about "Continue with Google" (lib/google_signin.py), or "" before any check."""
    try:
        sys.path.insert(0, os.path.join(S, "lib")); import google_signin
        return google_signin.recorded_line(docs(app)[1])
    except Exception: return ""

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
        # The application's own workspace first (the operator as its owner), then each seed file. Only what the look
        # did not find: a rerun writes nothing.
        st = standing(app, a, i) if i.get("target") == "vercel" else {"items": [{"key": os.path.basename(p), "path": p, "digest": seed_digest(p), "ok": applied(app).get(os.path.basename(p)) == seed_digest(p)} for p in seeds(app)]}
        for it in st["items"]:
            if it["ok"]: continue
            if it["key"] == OWN:
                if not write_own(app, st["seed"]): return False
                continue
            c = it["path"][:-5] + "/customers.json"
            if not write_workspace(app, it["path"], c if os.path.exists(c) else None): return False
            record_applied(app, it["key"], it["digest"])
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

def write_workspace(app, seed_path, customers=None):
    """One workspace onto the deployed Vercel app: workspace.py (the app role, row-level security in force). In a
    rehearsal the fake app's database is a file (lib/membership.py), so nothing is reached."""
    if services.REHEARSAL: membership.rehearsal_write(app, dict({"members": []}, **load(seed_path))); return True
    return py(os.path.join(S, "workspace.py"), app, seed_path, *([customers] if customers else [])).returncode == 0

def write_own(app, seed):
    """Write the application's own workspace and record it as applied. The seed is state plus the operator's address:
    it is handed to workspace.py as a private file outside the repository, removed afterwards."""
    if not seed: print(f"{app}: {NO_OPERATOR}"); return False
    import tempfile
    os.makedirs(PRIVATE, mode=0o700, exist_ok=True); fd, tmp = tempfile.mkstemp(prefix=f"{app}.own-workspace.", suffix=".json", dir=PRIVATE)
    try:
        os.write(fd, json.dumps(seed).encode()); os.close(fd)
        c = own_customers(app, seed["org_id"])
        if not write_workspace(app, tmp, c if os.path.exists(c) else None):
            print(f"{app}: the application's own workspace {seed['org_id']} was NOT written. If the lines above name other_workspaces, the app's database already "
                  f"holds those and not {seed['org_id']}: say which id is right before anything is written (application.json workspace.org.org_id).")
            return False
    finally:
        if os.path.exists(tmp): os.remove(tmp)
    record_applied(app, OWN, own_digest(app, seed)); CODE_FIRST.pop(app, None)
    print(f"done: workspace {seed['org_id']}, owner {seed['owner']}")
    return True

def workspace(app):
    """`mint.py <app> run --only workspaces`: the workspaces station's first half, by itself (when a later need, such as a redeploy
    that wants a sign-in, stands in front of the station). Writes what state says now; every write is an upsert."""
    a, i = docs(app)
    if not a or not i: sys.exit(f"{app} has no state yet: python3 .claude/scripts/mint.py {app}")
    if not (i.get("deployed_at") and lane_url.target_url(i)): print(f"{app} is not deployed yet, so it has no database to write a workspace to. It is written right after the first deploy."); return 2
    if i.get("target") == "vm_remote": return py(os.path.join(S, "provision.py"), app, "--workspace-remote").returncode
    if i.get("target") != "vercel" or not own_org(a): print(f"{app}: application.json names no workspace of its own (workspace.org.org_id), so there is nothing to write."); return 2
    seed, why = own_seed(app, a)
    if not seed and why == "operator": print(f"{app}: {NO_OPERATOR}"); return AR.EXIT["needs_human"]
    if not seed: print(f"{app}: {why}"); return 1
    return 0 if write_own(app, seed) else 1

def run(app):
    RAN.clear(); CODE_FIRST.clear()
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
    if "GOOGLE_CLIENT_ID" in names: google_hub_from(app, other)
    return 0

def google_hub_from(app, other):
    """After reuse-keys copied the Google client id: Google only signs people in at an address written by hand on that
    client's page, and the new app's address is not on it. So the app the keys came from, when its own Google sign-in
    works, becomes the new app's sign-in hub (lib/google_signin.py; the mold's lib/google-hub.ts). STATE only: the new
    app takes it up at its first deploy, the other one at ITS next deploy, and nothing here deploys either."""
    sys.path.insert(0, os.path.join(S, "lib")); import google_signin
    _, i = docs(app); _, oi = docs(other)
    i.setdefault("google_sign_in", {})["keys_from"] = other
    seen = google_signin.check(other, oi)
    google_signin.record(oi, seen)
    if seen["result"] != "direct":
        save(os.path.join(adir(app), "infrastructure.json"), i); save(os.path.join(adir(other), "infrastructure.json"), oi)
        print(f"note: 'Continue with Google' will not work at the new app's address until Google is told about it, and {other} cannot do the Google part for it "
              f"({google_signin.line(seen)}). Emailed codes work at once. After the first deploy, the deploy's summary gives the steps; or: "
              f"python3 .claude/scripts/provision.py {app} --google-signin")
        return
    ok, said = google_signin.set_hub(app, i, other, oi, app=docs(app)[0])
    save(os.path.join(adir(app), "infrastructure.json"), i); save(os.path.join(adir(other), "infrastructure.json"), oi)
    print("Google sign-in: " + ("" if ok else "the sign-in hub was NOT set: ") + said[0])
    for l in said[1:]: print("  " + l)
    if ok: print(f"  Until then, and always: emailed codes work at once. To add the address in Google Cloud Console instead: python3 .claude/scripts/provision.py {app} --google-signin")

def origin(app):
    u = lane_url.target_url(docs(app)[1] or {})
    if not u: sys.exit(f"{app} is not deployed yet")
    # mold_v1-239: an email address and a sign-in code go only to an address Vercel files under this app's web project
    # (an app on its own server is not asked). The address in state was once another account's compliance-os.vercel.app.
    import vercel_addr
    mine, why = vercel_addr.guard_app(docs(app)[1] or {}, u, roles=("",))
    if not mine: sys.exit(f"{app}: {why}")
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

def code_request(app, email, check=None):
    """Ask the app to email `email` a sign-in code, ONLY after looking whether it will (mold_v1-245). The app answers
    the same "on its way" to every address and emails only a member or an invited one, so its answer says nothing:
    an address seen in no workspace is told so and nothing is sent; one that could not be looked up is told the code
    was requested and arrives only if it is a member. "On its way" is said only of an address seen to be one."""
    url = origin(app)
    m = (check or membership.check)(app, email, look)
    send, words = membership.said(app, email, m)
    if not send: print(words); return 1
    post(url + "/api/auth/email/request", {"email": email}); print(words); return 0

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
    workspace_self_test()          # first: the checks below leave `survey` and `show` replaced
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
        assert st_workspaces("x", ws, {"target": "vm_remote"}) == (DONE, "workspace acme, owner o@acme.test; 1 workspace(s) as written")
        ws["workspace"]["members"].append({"email": "new@acme.test", "role": "member"})
        assert st_workspaces("x", ws, {"target": "vm_remote"})[0] == TODO          # state changed: the server no longer matches it
        assert st_workspaces("x", {"app_id": "x"}, {"target": "vercel"}) == (NA, "no extra workspace is described under seed/orgs/")   # a state that names no workspace of its own
        # mold_v1-163: a state with a surface is not done until the surface, as it is now written, is on the server too
        ap = os.path.join(tmp, "x", "seed", "orgs", ".applied.json")
        ws["surface"] = {"primary_context": {"instructions": {"persona_name": "Ava", "subagents": [{"agent_key": "research"}]}}, "custom_workflow_builder": {"definitions": [], "scripts": []}}
        json.dump({vm_remote.STATE_SEED: vm_remote.state_seed_digest(ws, os.path.join(tmp, "x"))}, open(ap, "w"))
        st, why = st_workspaces("x", ws, {"target": "vm_remote"})
        assert st == TODO and "the application's surface" in why and "own workspace" not in why, (st, why)
        json.dump({vm_remote.STATE_SEED: vm_remote.state_seed_digest(ws, os.path.join(tmp, "x")), vm_remote.SURFACE_KEY: vm_remote.surface_digest(ws)}, open(ap, "w"))
        assert st_workspaces("x", ws, {"target": "vm_remote"}) == (DONE, "workspace acme, owner o@acme.test; 1 workspace(s) as written, and the application's surface")
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
    # mold_v1-242: reuse-keys makes the app the keys came from the new app's sign-in hub, when that app's own Google
    # sign-in works; in state only (nothing here can deploy), and it says which deploys make it real.
    import tempfile, io, contextlib
    sys.path.insert(0, os.path.join(S, "lib")); import google_signin as G
    assert 'if "GOOGLE_CLIENT_ID" in names: google_hub_from(app, other)' in inspect.getsource(reuse_keys)
    assert not re.search(r"--deploy|provision\.py\"\)|subprocess|py\(", inspect.getsource(google_hub_from).split('"""')[2].replace("python3 .claude/scripts/provision.py", ""))
    real_adir, real_check, real_reh = adir, G.check, G.services.REHEARSAL
    with tempfile.TemporaryDirectory() as t:
        try:
            globals()["adir"] = lambda app: os.path.join(t, app)
            G.services.REHEARSAL = t          # so set_hub asks Google nothing here; the reading below is the scripted one
            cid = {"client_id": "123456789012-" + "a" * 32 + ".apps.googleusercontent.com", "project_number": "123456789012"}
            def put(app, infra, name=None):
                os.makedirs(adir(app), exist_ok=True); save(os.path.join(adir(app), "infrastructure.json"), infra)
                save(os.path.join(adir(app), "application.json"), {"app_id": app, "surface": {"branding": {"product_name": name or app}}})
            def said(fn, *a):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf): fn(*a)
                return buf.getvalue()
            reading = {"result": "direct"}
            G.check = lambda app_id, infra, **k: dict(reading, detail="scripted", address="https://old-app.example", at="t", next=[])
            put("old", {"target": "vercel", "vercel": {"production_url": "https://old-app.example", "project": "old"}, "google": cid})
            put("fresh", {"target": "vercel", "vercel": {"project": "fresh"}, "google": cid}, "Fresh App")
            out = said(google_hub_from, "fresh", "old")
            fi, oi = docs("fresh")[1], docs("old")[1]
            assert fi["google_sign_in"]["hub"]["origin"] == "https://old-app.example" and fi["google_sign_in"]["hub"]["app_id"] == "old" and fi["google_sign_in"]["keys_from"] == "old", fi
            assert oi["google_sign_in"]["check"]["result"] == "direct" and not oi["google_sign_in"].get("answers_for"), oi
            assert "will sign in with Google through old" in out and "After its first deploy" in out and "emailed codes work at once" in out, out
            put("moved", {"target": "vercel", "vercel": {"production_url": "https://new-app.example", "project": "moved"}, "google": cid}, "New App")
            out = said(google_hub_from, "moved", "old")
            oi = docs("old")[1]
            assert [(e["origin"], e["name"], e["app_id"]) for e in oi["google_sign_in"]["answers_for"]] == [("https://new-app.example", "New App", "moved")], oi
            assert "takes effect when each app is next deployed" in out and "old has people using it, so it is deployed only when you say so" in out, out
            reading["result"] = "not_working"
            put("alone", {"target": "vercel", "vercel": {"project": "alone"}, "google": cid})
            out = said(google_hub_from, "alone", "old")
            ai = docs("alone")[1]
            assert "hub" not in ai["google_sign_in"] and ai["google_sign_in"]["keys_from"] == "old" and "will not work at the new app's address" in out and "--google-signin" in out, (ai, out)
            assert google_note("x", {"google_sign_in": {"check": {"result": "not_working"}}}).startswith("; Google sign-in is NOT WORKING") and google_note("x", {"google_sign_in": {"check": {"result": "hub"}}}) == "" and google_note("x", {}) == ""
        finally:
            globals()["adir"] = real_adir; G.check = real_check; G.services.REHEARSAL = real_reh
    print("mint: 74 checks passed"); return 0

def workspace_self_test():
    """mold_v1-245. A freshly deployed app had no workspace, so it emailed nobody a code, while code-request said one
    was on its way. Every check here fails on the code before the fix: the station said "not needed", and
    code-request asked the app whatever the address."""
    import tempfile, io, contextlib
    G = globals(); real = {k: G[k] for k in ("adir", "PRIVATE", "operator_email", "look", "py", "origin", "post", "quiet", "repository_line")}; real_reh = services.REHEARSAL
    def said(fn, *a):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf): rc = fn(*a)
        return rc, buf.getvalue()
    with tempfile.TemporaryDirectory() as t:
        try:
            services.REHEARSAL = None
            db, ran, posted, op = {}, [], [], ["op@factory.test"]     # db: the fake app's database, {workspace: {address: role}}
            def fake_look(app, emails):
                if db.get("#down"): return {"error": "the database did not answer"}
                return {"orgs": [{"org_id": o, "owners": sum(1 for r in people.values() if r == "owner"), "people": [{"member": people.get(e), "invite": False} for e in emails]}
                                 for o, people in sorted(db.items())]}
            class Rc:
                returncode = 0
            def forget(*paths): [os.remove(x) for x in paths if os.path.exists(x)]
            def fake_py(*a, **k):                                      # workspace.py: what lib/workspace_seed.mjs writes
                ran.append(a)
                if a[0].endswith("workspace.py"):
                    seed = load(a[2]); ran[-1] = ("workspace.py", a[1], seed)
                    db.setdefault(seed["org_id"], {}).update({m["email"]: m["role"] for m in seed["members"]}); db[seed["org_id"]][seed["owner"]] = "owner"
                return Rc()
            G.update(adir=lambda app: os.path.join(t, "state", app), PRIVATE=os.path.join(t, "private"), operator_email=lambda: op[0], look=fake_look, py=fake_py,
                     origin=lambda app: "https://fresh.example", post=lambda url, body: posted.append((url, body)) or {"ok": True})
            a = {"app_id": "fresh", "mold_id": "m", "status": "stamped", "workspace": {"org": {"org_id": "acme", "name": "Acme"}, "members": []}}
            i = {"target": "vercel", "vercel": {"project": "fresh"}}
            def put():
                os.makedirs(adir("fresh"), exist_ok=True); save(os.path.join(adir("fresh"), "application.json"), a); save(os.path.join(adir("fresh"), "infrastructure.json"), i)
            put()
            # 1. before the deploy there is nothing to write to; right after the first one, the station is work to do
            assert st_workspaces("fresh", a, i) == (TODO, "right after the first deploy: the application's own workspace acme, owner op@factory.test")
            i.update(deployed_at="2026-10-13T00:00:00+00:00"); i["vercel"]["production_url"] = "https://fresh.example"; put()
            assert st_workspaces("fresh", a, i) == (TODO, "create the application's own workspace acme, owner op@factory.test"), st_workspaces("fresh", a, i)
            assert code_first("fresh", a).endswith("FIRST: op@factory.test belongs to no workspace on fresh, so the app would email it no code: mint.py fresh run --only workspaces")
            # 2. a first deploy creates the workspace and its owner: one workspace.py run, the operator as owner
            rc, out = said(do, "fresh", "workspaces")
            assert rc is True and len(ran) == 1 and ran[0][:2] == ("workspace.py", "fresh"), ran
            seed = ran[0][2]
            assert (seed["org_id"], seed["name"], seed["owner"], seed["guard"]) == ("acme", "Acme", "op@factory.test", "no_other_workspace"), seed
            assert db == {"acme": {"op@factory.test": "owner"}} and "done: workspace acme, owner op@factory.test" in out, (db, out)
            assert not [f for f in os.listdir(PRIVATE) if "own-workspace" in f]                 # the seed handed to workspace.py is not left behind
            assert st_workspaces("fresh", a, i) == (DONE, "workspace acme, owner op@factory.test")
            assert applied("fresh") == {OWN: own_digest("fresh", own_seed("fresh", a)[0])} and code_first("fresh", a) == ""
            # 3. a rerun is a no-op: nothing is written again, by the record...
            ran.clear(); assert do("fresh", "workspaces") is True and ran == [], ran
            # ...and without the record, by LOOKING at the app (a workspace made by hand is found, not written again)
            os.remove(applied_path("fresh"))
            assert st_workspaces("fresh", a, i) == (DONE, "workspace acme, owner op@factory.test") and do("fresh", "workspaces") is True and ran == [], ran
            assert seen("fresh")[OWN + "#role"] == "owner"
            db["#down"] = True                                         # what was seen is kept privately: the next look costs nothing
            assert st_workspaces("fresh", a, i)[0] == DONE
            os.remove(seen_path("fresh"))
            st, why = st_workspaces("fresh", a, i)
            assert st == TODO and "could not be looked at: the database did not answer" in why, (st, why)   # unseen is never called done
            del db["#down"]
            # an owner state names keeps the owner's role, beside the operator; state changed, so it is written again
            a["workspace"]["members"] = [{"email": "Owner@Acme.test", "role": "owner"}, {"email": "ana@acme.test", "role": "admin"}]; put()
            assert st_workspaces("fresh", a, i)[0] == TODO
            said(do, "fresh", "workspaces")
            assert db["acme"] == {"op@factory.test": "owner", "owner@acme.test": "owner", "ana@acme.test": "admin"}, db
            assert st_workspaces("fresh", a, i) == (DONE, "workspace acme, owner op@factory.test")
            # a workspace that is there under another owner is seen, never rewritten, and said as it is
            forget(applied_path("fresh"), seen_path("fresh")); db["acme"]["op@factory.test"] = "admin"; ran.clear()
            st, why = st_workspaces("fresh", a, i)
            assert st == DONE and "its owner is someone else, and op@factory.test is a admin there" in why and ran == [], (st, why)
            # 4. the operator's address unknown: nothing is written, and it is the one thing asked for (exit 3)
            forget(seen_path("fresh")); db.clear(); op[0] = ""
            assert st_workspaces("fresh", a, i) == (OPERATOR, NO_OPERATOR)
            rc, out = said(workspace, "fresh"); assert rc == 3 and "defaults.operator_email" in out and ran == [], (rc, out)
            rc, out = said(do, "fresh", "workspaces"); assert rc is False and ran == []
            G["repository_line"] = lambda app: "repository: none"; real_status = runs.status; runs.status = lambda *x, **k: AR.result(True, "done", "", "", [], "", {"record": None})
            try:
                r = survey_result("fresh", [("deploy", DONE, ""), ("workspaces", OPERATOR, NO_OPERATOR)])
            finally: runs.status = real_status
            assert AR.exit_code(r) == 3 and r["needs"][0]["name"] == "the operator's email address" and "defaults.operator_email" in r["needs"][0]["how"], r
            op[0] = "op@factory.test"
            # `mint.py <app> run --only workspaces`: the same write by itself, and it refuses an app with no database yet
            rc, out = said(workspace, "fresh"); assert rc == 0 and db["acme"]["op@factory.test"] == "owner" and "done: workspace acme" in out, out
            # a seed file beside it: applied once, recorded, then left alone
            os.makedirs(os.path.join(adir("fresh"), "seed", "orgs"), exist_ok=True)
            save(os.path.join(adir("fresh"), "seed", "orgs", "second.json"), {"org_id": "second", "name": "Second", "owner": "cy@second.test", "members": [{"email": "di@second.test", "role": "member"}]})
            assert st_workspaces("fresh", a, i) == (TODO, "apply: second")
            ran.clear(); assert do("fresh", "workspaces") is True and [r[2]["org_id"] for r in ran] == ["second"], ran
            assert st_workspaces("fresh", a, i) == (DONE, "workspace acme, owner op@factory.test; 1 seed(s) under seed/orgs/ as written")
            ran.clear(); assert do("fresh", "workspaces") is True and ran == []
            # 5. code-request for an address in no workspace: NOTHING is sent, and it says why and what to do
            rc, out = said(code_request, "fresh", "stranger@example.com")
            assert rc == 1 and posted == [] and out.startswith("stranger@example.com belongs to no workspace on fresh, so the app will not email it a code. Nothing was sent."), (rc, posted, out)
            assert "invites stranger@example.com from inside the app" in out and "on its way" not in out, out
            keep = dict(db); db.clear()                                # the 2026-10-13 case: a deployed app with no workspace at all
            rc, out = said(code_request, "fresh", "op@factory.test")
            assert rc == 1 and posted == [] and "fresh has no workspace at all yet" in out and "python3 .claude/scripts/mint.py fresh run --only workspaces" in out and "on its way" not in out, out
            db.update(keep)
            # 6. a member gets the request, once, and only then is a code said to be on its way
            rc, out = said(code_request, "fresh", "op@factory.test")
            assert rc == 0 and posted == [("https://fresh.example/api/auth/email/request", {"email": "op@factory.test"})] and "a six-digit code is on its way to op@factory.test (a member of acme)" in out, (posted, out)
            # 7. membership could not be looked up: the code is requested, and never promised
            posted.clear(); db["#down"] = True
            rc, out = said(code_request, "fresh", "op@factory.test")
            assert rc == 0 and len(posted) == 1 and "on its way" not in out and "a code was requested for op@factory.test" in out and "could not be checked (the database did not answer)" in out \
                   and "only if op@factory.test is one" in out, out
            del db["#down"]
            # the lines that ask the operator for a code say what comes first, by the same look
            CODE_FIRST.clear(); forget(applied_path("fresh"), seen_path("fresh")); db.clear()
            i.update(deployed_at="2026-10-13T00:00:00+00:00"); a["testing"] = {l: {"status": "skipped" if l == "functional" else "pass", "run_at": "2026-10-14T00:00:00+00:00"} for l in ("functional", "context", "load", "accessibility", "responsiveness")}
            st, why = st_tests("fresh", a, i)
            assert st == OPERATOR and "FIRST: op@factory.test belongs to no workspace on fresh" in why, why
            assert "FIRST: fresh has no workspace yet" in needs_for("fresh", "tests", why)[0]["how"]
            # a redeploy that is due does not hide a workspace that is on the app; one not yet written still waits its turn
            real_st = dict(STATIONS); rows = lambda: {n: st for n, st, _ in survey("fresh")}
            try:
                STATIONS[:] = [("deploy", lambda *x: (TODO, "the mold moved")), ("workspaces", lambda *x: (DONE, "workspace acme, owner op@factory.test")), ("tests", lambda *x: (DONE, ""))]
                assert rows() == {"deploy": TODO, "workspaces": DONE, "tests": "later"}, rows()
                STATIONS[1] = ("workspaces", lambda *x: (TODO, "create"))
                assert rows() == {"deploy": TODO, "workspaces": "later", "tests": "later"}, rows()
            finally: STATIONS[:] = list(real_st.items())
            # the docs name the command, and the page for the next person never carries the owner's address
            assert "mint.py <app_id> run --only workspaces" in __doc__ and "LOOKS first" in __doc__
            import mint_handoff
            assert mint_handoff.no_address("workspace acme, owner op@factory.test") == "workspace acme, owner (the operator)"
        finally:
            G.update(real); services.REHEARSAL = real_reh; CODE_FIRST.clear()

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
                 f"a private file, never shown. " + membership.sign_in_note(app, lambda x, e: membership.check(x, e, look), operator_email())}]
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
    if name == "workspaces":
        return [{"kind": "approval", "name": "the operator's email address", "how":
                 f"{app}'s own workspace needs an owner who can sign in. Ask the operator which email address they sign in with, then put it in "
                 f"state/factory.local.json as defaults.operator_email (it is this machine's own file, never committed) and run: python3 .claude/scripts/mint.py {app} run"}]
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
    if a[1] == "run" and "--only" in a: return None      # one station alone: plain words (main)
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
    if a[1] == "run" and "--only" in a:
        # One station alone. It is spelled as a `run` so every tool's "ask before mint.py <app> run" rule covers it.
        if a[2:] != ["--only", "workspaces"]: print("--only takes one station, and the only one that runs alone is: workspaces", file=sys.stderr); return 2
        return workspace(app)
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
