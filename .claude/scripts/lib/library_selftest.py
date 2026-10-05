#!/usr/bin/env python3
"""The offline checks behind `library.py --self-test` (and, for the server side, part of `provision.py --self-test-remote`).

  choice     what state asks for: "none" by default, "all", and "listed" refused with what to write instead
  profile    the opt-in file: copied for "all", absent for "none", a stale copy removed, a second run changes nothing;
             the mold's own generators then build exactly the account-delivery library, or exactly the mold's own files
  stamp      the steps that build build/<app_id>/ (packs.py apply, branding.py prepare) and the two lane copies
             (build/<app_id>.lane/ follows state; build/<app_id>.lane-default/ stays the mold's default profile)
  cleanup    the rules around the mold's operator:library-cleanup: a dry run first, --apply only when the running code
             matches state, the report in plain words, no database address anywhere; for an app on Vercel and for an
             app on its own server (the server step run for real with node against a stand-in for the mold's script)

NOTHING HERE TOUCHES A SERVER, A DATABASE OR THE REAL build/ AND state/. The stamp checks run in a temp tree that holds
a COPY of the mold; the real mold, packs and state are only read. The cleanup checks use stand-ins for the remote
runner, for `vercel env pull` and for the mold's script.
"""
import hashlib, json, os, pwd, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
for p in (HERE, SCRIPTS):
    if p not in sys.path: sys.path.insert(0, p)

MOLD = os.path.join(ROOT, "molds", "mold_v1", "codebase")
DB_URL = "postgresql://app_rw:Zk3-app-rw-PASSWORD-77@db.example.com:5432/app?sslmode=require"
CP = subprocess.CompletedProcess

def _digest(d):
    h = hashlib.sha256()
    for r, ds, fs in sorted(os.walk(d)):
        ds[:] = [x for x in ds if x != "node_modules"]
        for f in sorted(fs):
            p = os.path.join(r, f)
            if os.path.isfile(p): h.update(os.path.relpath(p, d).encode()); h.update(open(p, "rb").read())
    return h.hexdigest()

def _app(install=None, packs=None, brand=False, app_id="x"):
    app = {"app_id": app_id, "mold_id": "mold_v1", "surface": {"custom_workflow_builder": ({"library": {"install": install}} if install else {})}}
    if packs: app["packs"] = packs
    if brand: app["surface"]["branding"] = {"product_name": "Acme Ops", "brand_color": "#1F6F5C", "tagline": "Work, in one place."}
    return app

def _quiet(fn, *a, **k):
    """(result, printed) with stdout captured; a sys.exit comes back as its message."""
    import contextlib, io
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out): r = fn(*a, **k)
    except SystemExit as e: r = e
    return r, out.getvalue()

# ------------------------------------------------------------------------------------------------ choice
def choice(check, L):
    check("choice: an application that says nothing gets no starter library", L.install({"surface": {}}) == "none" and L.install({}) == "none" and L.install(_app()) == "none")
    check("choice: none and all are read as written", L.install(_app("none")) == "none" and L.install(_app("all")) == "all")
    r, _ = _quiet(L.install, _app("listed"))
    check("choice: 'listed' is refused, and the message says what to write instead", isinstance(r, SystemExit) and '"all"' in str(r) and '"none"' in str(r) and "scripts" in str(r), r)
    check("choice: factory.py validate says the same, and says nothing about none or all", L.problems("x", _app("all")) == [] and L.problems("x", _app("none")) == [] and L.problems("x", _app()) == []
          and len(L.problems("x", _app("listed"))) == 1 and "x/application.json" in L.problems("x", _app("listed"))[0])
    import factory as F
    sch = json.load(open(os.path.join(ROOT, "state/application/app_id/application.schema.json")))
    lib = sch["properties"]["surface"]["properties"]["custom_workflow_builder"]["properties"]["library"]["properties"]["install"]
    check("choice: the schema's default is none, and it offers none and all only", lib["default"] == "none" and sorted(lib["enum"]) == ["all", "none"], lib)
    import intake as I
    hint = lambda text: I.parse_brief(text).get("library") if hasattr(I, "parse_brief") else None
    if hasattr(I, "parse_brief"):
        check("choice: a brief that says nothing about workflows leaves the default (none) in force", hint("A research workspace for Acme on vercel.") is None)
        check("choice: 'workflows: all' and 'workflows: none' still work", hint("x\nworkflows: all\n") == "all" and hint("x\nworkflows: none\n") == "none" and hint("workflows: library") == "all" and hint("workflows none") == "none" and hint("workflow all") == "all")
        check("choice: a brief that only mentions a workflow library in passing does not ask for one", hint("The team keeps a workflow library of its own in Notion.") is None)
        check("choice: plain words ask for the original product's library", all(hint(t) == "all" for t in ("Give it the starter library.", "with the account-delivery library", "It needs the original product's workflow library.", "use the built-in library")))
        check("choice: plain words decline it", all(hint(t) == "none" for t in ("no starter library", "without the workflow library", "No built-in library, please.", "starter library: none", "We do not want the starter library.", "We don't need the built-in library.", "It has no workflow library.")))
    q = [x for x in I.QUESTIONS if x[0] == "library"][0]
    check("choice: intake's own default is none", q[4]({}, {}, {}) == "none" and q[4]({}, {"library": "all"}, {}) == "all")

# ------------------------------------------------------------------------------------------------ profile
def _mold_copy(dst):
    os.makedirs(dst, exist_ok=True)
    subprocess.run(["rsync", "-a", "--exclude", "node_modules", "--exclude", ".next", "--exclude", ".eve", MOLD + "/", dst + "/"], check=True)
    return dst

def profile(check, L, tmp):
    if not os.path.isfile(os.path.join(MOLD, L.PROFILE_SRC)) or not shutil.which("node") or not shutil.which("rsync"): return False
    b = _mold_copy(os.path.join(tmp, "profile-build")); dst = os.path.join(b, L.PROFILE_DST)
    gen = lambda d=b: {g: open(os.path.join(d, g), "rb").read() for g in (L.GENERATED, "lib/deployment-profile.generated.ts", "agent/lib/deployment-profile.generated.ts")}
    mold_gen = gen(MOLD)
    check("profile: the mold itself names no library (its default profile is empty)", L.built_sources(MOLD) == [] and not os.path.exists(os.path.join(MOLD, L.PROFILE_DST)), L.built_sources(MOLD))
    line = L.apply(b, _app("none"), MOLD)
    check("profile: none leaves the opt-in file out and regenerates nothing", not os.path.exists(dst) and gen() == mold_gen and "none" in line, line)
    line = L.apply(b, _app("all"), MOLD)
    check("profile: all copies the mold's library/account-delivery/profile.json to profiles/40-library-account-delivery.json, byte for byte",
          os.path.isfile(dst) and open(dst, "rb").read() == open(os.path.join(MOLD, L.PROFILE_SRC), "rb").read() and "account-delivery" in line, line)
    wl = open(os.path.join(b, L.GENERATED)).read(); prof = open(os.path.join(b, "lib/deployment-profile.generated.ts")).read()
    check("profile:   ...and the mold's own generators then build that library: 13 workflows and 5 recipes", L.built_sources(b) == ["account-delivery"] and "13 workflows, 5 recipes" in wl and '"name": "onboard-account"' in wl and '"slug": "onboard-self"' in wl, wl[:300])
    check("profile:   ...and the generated deployment profile names it (the profile generator ran AFTER the copy)", '"account-delivery": "library/account-delivery"' in prof)
    before = _digest(b); stamp = os.stat(os.path.join(b, L.GENERATED)).st_mtime_ns
    line2 = L.apply(b, _app("all"), MOLD)
    check("profile: a second run changes nothing and regenerates nothing", _digest(b) == before and os.stat(os.path.join(b, L.GENERATED)).st_mtime_ns == stamp and L.sync(b, "all", MOLD) == "kept" and line2 == line)
    line = L.apply(b, _app("none"), MOLD)
    check("profile: back to none removes the stale copy and the build is the mold's again, byte for byte", not os.path.exists(dst) and gen() == mold_gen and "removed" in line and L.sync(b, "none", MOLD) == "absent", line)
    L.sync(b, "all", MOLD)
    check("profile: the default-profile copy never carries it, whatever state says", L.sync(b, "all", MOLD, default_profile=True) == "removed" and not os.path.exists(dst))
    open(dst, "w").write("{}")
    check("profile: a copy that differs from the mold's is replaced", L.sync(b, "all", MOLD) == "updated" and open(dst, "rb").read() == open(os.path.join(MOLD, L.PROFILE_SRC), "rb").read())
    old = os.path.join(tmp, "old-mold"); os.makedirs(os.path.join(old, "scripts"))
    check("profile: a mold from before the library moved is left alone", L.sync(old, "all", old) == "builtin" and "nothing to opt into" in L.apply(old, _app("all"), old) and os.listdir(old) == ["scripts"])
    gone = os.path.join(tmp, "no-lib"); os.makedirs(os.path.join(gone, "scripts", "lib")); open(os.path.join(gone, L.PROFILE_AWARE), "w").close()
    r, _ = _quiet(L.sync, gone, "all", gone)
    check("profile: all on a mold that has no account-delivery library is refused in a sentence", isinstance(r, SystemExit) and "is not in the mold" in str(r), r)
    return True

# ------------------------------------------------------------------------------------------------ stamp
def stamp(check, L, tmp):
    """packs.py apply, the lane copies and branding.py prepare, in a temp tree: a copy of the mold, the real packs read-only."""
    import packs, branding
    if not os.path.isfile(os.path.join(MOLD, L.PROFILE_SRC)) or not shutil.which("node") or not shutil.which("rsync"): return False
    fx = os.path.join(tmp, "stamp"); mold = _mold_copy(os.path.join(fx, "molds", "mold_v1", "codebase"))
    os.makedirs(os.path.join(mold, "node_modules"), exist_ok=True)          # build_copy hard-links it; empty is enough for the generators
    shutil.copytree(os.path.join(ROOT, "molds", "mold_v1", "branding"), os.path.join(fx, "molds", "mold_v1", "branding"))
    os.symlink(os.path.join(ROOT, "packs"), os.path.join(fx, "packs"))
    pack = next((p for p in sorted(os.listdir(os.path.join(ROOT, "packs"))) if os.path.isfile(os.path.join(ROOT, "packs", p, "pack.json")) and not packs.check_pack(p)), None)
    def state(app_id, **kw):
        d = os.path.join(fx, "state", "application", app_id); os.makedirs(d, exist_ok=True)
        app = _app(app_id=app_id, **kw); json.dump(app, open(os.path.join(d, "application.json"), "w")); return app
    B = lambda name: os.path.join(fx, "build", name)
    has = lambda name: os.path.isfile(os.path.join(B(name), L.PROFILE_DST))
    same_as_mold = lambda name: all(open(os.path.join(B(name), g), "rb").read() == open(os.path.join(mold, g), "rb").read() for g in packs.GENERATED_PROFILE)
    saved = (packs.ROOT, packs.PACKS, branding.ROOT, branding.ST, L.ROOT); mold_before = _digest(mold)
    packs.ROOT = branding.ROOT = L.ROOT = fx; packs.PACKS = os.path.join(fx, "packs"); branding.ST = os.path.join(fx, "state")
    try:
        # an app with no packs
        state("plain_none", install="none")
        r, out = _quiet(packs.apply, "plain_none")
        check("stamp: an app with no packs and no library needs no build copy", r == 0 and "nothing to apply" in out and not os.path.exists(B("plain_none")), out)
        state("plain_all", install="all")
        r, out = _quiet(packs.apply, "plain_all")
        check("stamp: an app with no packs that asks for the library gets a build copy for it, with the library built in", r == 0 and has("plain_all") and L.built_sources(B("plain_all")) == ["account-delivery"]
              and '"account-delivery": "library/account-delivery"' in open(os.path.join(B("plain_all"), "lib/deployment-profile.generated.ts")).read(), out)
        before = _digest(B("plain_all")); r, out = _quiet(packs.apply, "plain_all")
        check("stamp:   ...and applying again changes nothing", r == 0 and _digest(B("plain_all")) == before, out)
        check("stamp:   ...a deploy builds that app from its copy, not from the mold", L.build_dir_for("plain_all", _app("all", app_id="plain_all")) == B("plain_all") and L.build_dir_for("plain_none", _app("none", app_id="plain_none")) == mold)
        state("plain_all", install="none"); r, out = _quiet(packs.apply, "plain_all")
        check("stamp: when state goes back to none, the stale opt-in is taken out of the build copy and it is the mold's again", r == 0 and not has("plain_all") and same_as_mold("plain_all") and "taken out" in out, out)
        state("plain_all", install="all"); r, out = _quiet(packs.lane_copies, "plain_all")
        check("stamp: its lane copy carries the library; it has no default-profile copy, because that is the mold itself", r == 0 and has("plain_all.lane") and L.built_sources(B("plain_all.lane")) == ["account-delivery"] and not os.path.exists(B("plain_all.lane-default")), out)
        state("listed", install="listed"); r, out = _quiet(packs.apply, "listed")
        check("stamp: 'listed' stops the build with what to write instead", isinstance(r, SystemExit) and "no longer exists" in str(r) and not os.path.exists(B("listed")), r)
        # an app with a pack
        if pack:
            state("pk_all", install="all", packs=[pack]); state("pk_none", install="none", packs=[pack])
            r, out = _quiet(packs.apply, "pk_all")
            check("stamp: packs.py apply names the library in an app's build copy before the profile is generated", r == 0 and has("pk_all") and L.built_sources(B("pk_all")) == ["account-delivery"]
                  and '"account-delivery": "library/account-delivery"' in open(os.path.join(B("pk_all"), "lib/deployment-profile.generated.ts")).read() and "starter library: account-delivery" in out, out)
            before = _digest(B("pk_all")); r, out = _quiet(packs.apply, "pk_all")
            check("stamp:   ...a second apply changes nothing", r == 0 and _digest(B("pk_all")) == before, out)
            r, out = _quiet(packs.apply, "pk_none")
            check("stamp: with none the pack is applied and no library is named", r == 0 and not has("pk_none") and L.built_sources(B("pk_none")) == [] and "starter library: none" in out, out)
            state("pk_all", install="none", packs=[pack]); r, out = _quiet(packs.apply, "pk_all")
            check("stamp: all -> none on an existing build copy removes the stale opt-in and rebuilds without the library", r == 0 and not has("pk_all") and L.built_sources(B("pk_all")) == [], out)
            state("pk_all", install="all", packs=[pack]); r, out = _quiet(packs.lane_copies, "pk_all")
            check("stamp: the lane copy follows state (all: the library is in it)", r == 0 and has("pk_all.lane") and L.built_sources(B("pk_all.lane")) == ["account-delivery"], out)
            check("stamp:   ...and the default-profile lane copy stays the mold's default profile: no opt-in file, generated files byte-identical to the mold's",
                  not has("pk_all.lane-default") and same_as_mold("pk_all.lane-default") and L.built_sources(B("pk_all.lane-default")) == [], out)
            r, out = _quiet(packs.lane_copies, "pk_none")
            check("stamp: with none neither lane copy carries the library", r == 0 and not has("pk_none.lane") and not has("pk_none.lane-default") and L.built_sources(B("pk_none.lane")) == [] and same_as_mold("pk_none.lane-default"), out)
        # a branded app: branding.py prepare builds the copy first
        app = state("brand_all", install="all", brand=True)
        r, out = _quiet(branding.prepare, "brand_all", app, mold)
        prof = open(os.path.join(B("brand_all"), "lib/deployment-profile.generated.ts")).read() if os.path.isdir(B("brand_all")) else ""
        check("stamp: branding.py prepare names the library before the overlay regenerates the profile, so the profile carries the brand AND the library",
              r == B("brand_all") and has("brand_all") and L.built_sources(B("brand_all")) == ["account-delivery"] and '"name": "Acme Ops"' in prof and '"account-delivery": "library/account-delivery"' in prof, (r, out))
        app = state("brand_none", install="none", brand=True)
        r, out = _quiet(branding.prepare, "brand_none", app, mold)
        check("stamp: a branded app with none gets the brand and no library", r == B("brand_none") and not has("brand_none") and L.built_sources(B("brand_none")) == []
              and open(os.path.join(B("brand_none"), L.GENERATED), "rb").read() == open(os.path.join(mold, L.GENERATED), "rb").read(), (r, out))
        check("stamp: nothing was written into the mold", _digest(mold) == mold_before)
    finally:
        packs.ROOT, packs.PACKS, branding.ROOT, branding.ST, L.ROOT = saved
    return bool(pack)

# ------------------------------------------------------------------------------------------------ cleanup
def _report(library=(), applied=False, removed=None):
    return {"applied": applied, "library": list(library), "excluded": [], "workspaces": [
        {"workspace": "acme", "removable": [{"table": "workflows", "id": "w1", "name": "qbr-prep", "origin": 'workflow of the "account-delivery" library, which this build\'s profile does not name'},
                                            {"table": "recipes", "id": "r1", "name": "onboard-self", "origin": 'recipe of the "account-delivery" library, which this build\'s profile does not name'}],
         "kept": [{"table": "workflows", "id": "w2", "name": "route-incident", "origin": 'workflow of the "account-delivery" library, which this build\'s profile does not name', "why": ["ran: 3 workflow run(s)", "edited: has operator instructions"]}],
         "removed": removed},
        {"workspace": "beta", "removable": [], "kept": [], "removed": None}]}

def cleanup_rules(check, L):
    calls = []
    def runner(first, second=None):
        def run(argv):
            calls.append(list(argv)); doc = second if "--apply" in argv and second is not None else first
            return doc if isinstance(doc, CP) else CP(argv, 0, "some notice on stdout first\n" + json.dumps(doc, indent=2) + "\n", "")
        return run
    calls.clear(); rep, err = L.run_cleanup(runner(_report()), "none")
    check("cleanup: without --apply it runs the mold's script once, as a dry run, and asks for JSON", err is None and len(calls) == 1 and calls[0][-2:] == [L.CLEANUP_SCRIPT, "--json"] and "--apply" not in calls[0] and calls[0][0] == "node", calls)
    check("cleanup:   ...and reads the report even with other lines before it", rep and len(rep["workspaces"]) == 2)
    calls.clear(); rep, err = L.run_cleanup(runner(_report()), "none", org="acme")
    check("cleanup: --org is handed on as written", err is None and calls[0][-2:] == ["--org", "acme"], calls)
    calls.clear(); rep, err = L.run_cleanup(runner(_report()), "none", org="acme; rm -rf /")
    check("cleanup: something that is not a workspace id is refused before anything runs", rep is None and "not a workspace id" in err and calls == [])
    calls.clear(); rep, err = L.run_cleanup(runner(_report(), _report(applied=True, removed={"workflows": 1, "recipes": 1})), "none", do_apply=True)
    check("cleanup: --apply is a dry run FIRST and then the removal", err is None and len(calls) == 2 and "--apply" not in calls[0] and calls[1][-1] == "--apply" and rep["applied"] is True, calls)
    calls.clear(); rep, err = L.run_cleanup(runner(_report(library=["account-delivery"])), "none", do_apply=True)
    check("cleanup: code built WITH the library while state says none is refused, and nothing is removed", rep is None and "Deploy the app first" in err and "Nothing was changed" in err and len(calls) == 1, err)
    calls.clear(); rep, err = L.run_cleanup(runner(_report()), "all", do_apply=True)
    check("cleanup: code built WITHOUT the library while state says all is refused too (its workflows would be listed as leftovers)", rep is None and "Deploy the app first" in err and len(calls) == 1, err)
    calls.clear(); nothing = {"applied": False, "library": [], "excluded": [], "workspaces": [{"workspace": "beta", "removable": [], "kept": [], "removed": None}]}
    rep, err = L.run_cleanup(runner(nothing), "none", do_apply=True)
    check("cleanup: --apply with nothing removable never runs the removal", err is None and len(calls) == 1)
    calls.clear(); rep, err = L.run_cleanup(runner(CP([], 1, "", "x No such workspace: nope\n")), "none", org="nope")
    check("cleanup: a failure of the mold's script comes back as one sentence", rep is None and "did not finish" in err and "No such workspace: nope" in err, err)
    said = []; L.render("acme_app", _report(), False, said.append); text = "\n".join(said)
    check("cleanup: the dry run says so, per workspace, what would be removed and what is kept and why",
          "DRY RUN. Nothing was changed." in said[0] and "Workspace acme:" in text and "would be removed (2)" in text and 'workflow "qbr-prep"' in text and 'recipe "onboard-self"' in text
          and 'kept (1), and why:' in text and 'workflow "route-incident"' in text and "ran: 3 workflow run(s); edited: has operator instructions" in text and "Workspace beta:\n    nothing left over" in text, text)
    check("cleanup:   ...and ends with the exact command that removes them", said[-1].strip().endswith("python3 .claude/scripts/provision.py acme_app --library-cleanup --apply") and "2 row(s)" in said[-1], said[-1])
    said = []; L.render("acme_app", _report(applied=True, removed={"workflows": 1, "recipes": 1}), True, said.append); text = "\n".join(said)
    check("cleanup: after --apply it says what was removed, in counts, and offers no further command", "REMOVED" in said[0] and "removed (2)" in text and "done: 1 workflow(s) and 1 recipe(s) removed" in text and "--apply" not in text, text)
    said = []; L.render("acme_app", {"applied": False, "library": [], "excluded": [], "workspaces": []}, False, said.append)
    check("cleanup: an app with no workspace yet is told so", "no workspace" in "\n".join(said))

def cleanup_local(check, L, tmp):
    """An app on Vercel: from the build copy, with DATABASE_URL from a stand-in for `vercel env pull`."""
    fx = os.path.join(tmp, "local"); build = os.path.join(fx, "build", "acme_app"); os.makedirs(os.path.join(build, "scripts", "operator")); os.makedirs(os.path.join(build, "agent", "lib"))
    script = os.path.join(build, L.CLEANUP_SCRIPT)
    gen = lambda src: open(os.path.join(build, L.GENERATED), "w").write(f"export const LIBRARY_SOURCES: readonly string[] = {json.dumps(src)};\n")
    app = _app("none", brand=True, app_id="acme_app"); infra = {"target": "vercel", "vercel": {"project": "acme-app", "production_url": "https://acme.example"}}
    pulls = []; runs = []
    def pull(project, cwd): pulls.append((project, cwd)); return {"DATABASE_URL": DB_URL, "OTHER": "x"}
    def fake(doc, leak=False):
        def run(argv, cwd=None, env=None, **kw):
            runs.append({"argv": list(argv), "cwd": cwd, "url": (env or {}).get("DATABASE_URL")})
            if leak: return CP(argv, 1, "", f"Error: connect ECONNREFUSED {DB_URL}\n")
            return CP(argv, 0, json.dumps(doc, indent=2), "")
        return run
    saved = L.ROOT; L.ROOT = fx
    try:
        said = []; rc = L.cleanup_local("acme_app", app, {"target": "vercel", "vercel": {"project": "acme-app"}}, ["acme_app", "--library-cleanup"], pull_env=pull, runner=fake(_report()), say=said.append)
        check("cleanup (vercel): an app that is not deployed is told so, and nothing is read", rc == 1 and "not deployed" in said[0] and pulls == [] and runs == [])
        said = []; rc = L.cleanup_local("acme_app", app, infra, ["acme_app", "--library-cleanup"], pull_env=pull, runner=fake(_report()), say=said.append)
        check("cleanup (vercel): a build copy from before the cleanup existed is refused, with the deploy command, before the environment is read", rc == 1 and "--deploy" in said[0] and "Nothing was contacted" in said[0] and pulls == [])
        open(script, "w").close(); gen(["account-delivery"])
        said = []; rc = L.cleanup_local("acme_app", app, infra, ["acme_app", "--library-cleanup", "--apply"], pull_env=pull, runner=fake(_report()), say=said.append)
        check("cleanup (vercel): a build copy built WITH the library while state says none is refused before the environment is read", rc == 1 and "Deploy the app first" in said[0] and pulls == [] and runs == [], said)
        gen([])
        said = []; rc = L.cleanup_local("acme_app", app, infra, ["acme_app", "--library-cleanup"], pull_env=pull, runner=fake(_report()), say=said.append); text = "\n".join(said)
        check("cleanup (vercel): the dry run reads DATABASE_URL from the project's production environment and runs the mold's script in the build copy",
              rc == 0 and pulls == [("acme-app", build)] and len(runs) == 1 and runs[0]["cwd"] == build and runs[0]["url"] == DB_URL and "--apply" not in runs[0]["argv"] and "would be removed (2)" in text, text)
        check("cleanup (vercel):   ...the database address is in the child's environment only: not on its command line, not in what is printed", all(DB_URL not in " ".join(r["argv"]) for r in runs) and DB_URL not in text and "PASSWORD" not in text)
        runs.clear(); said = []
        rc = L.cleanup_local("acme_app", app, infra, ["acme_app", "--library-cleanup", "--apply", "--org", "acme"], pull_env=pull, runner=fake(_report(applied=True, removed={"workflows": 1, "recipes": 1})), say=said.append)
        check("cleanup (vercel): --apply --org runs the dry run, then the removal, for that workspace", rc == 0 and len(runs) == 2 and runs[1]["argv"][-3:] == ["--org", "acme", "--apply"] and "REMOVED" in said[0], runs)
        runs.clear(); said = []
        rc = L.cleanup_local("acme_app", app, infra, ["acme_app", "--library-cleanup"], pull_env=pull, runner=fake(None, leak=True), say=said.append)
        check("cleanup (vercel): an error that quotes the database address is shown without it", rc == 1 and "did not finish" in said[0] and DB_URL not in said[0] and "PASSWORD" not in said[0] and "ECONNREFUSED" in said[0], said)
        said = []; rc = L.cleanup_local("acme_app", app, infra, ["acme_app", "--library-cleanup"], pull_env=lambda p, c: {"DATABASE_URL": "[SENSITIVE]"}, runner=fake(_report()), say=said.append)
        check("cleanup (vercel): a database address that cannot be read stops it in a sentence", rc == 1 and "could not be read" in said[0])
    finally: L.ROOT = saved

# What the mold's scripts/operator/library-cleanup.mjs does, as far as the factory can see it: the flags it takes, the
# JSON it prints, what --apply changes. Backed by a JSON file instead of Postgres.
FAKE_CLEANUP = r'''import { readFileSync, writeFileSync } from "node:fs";
const has = (f) => process.argv.includes("--" + f);
const flag = (f) => { const i = process.argv.indexOf("--" + f); return i !== -1 ? (process.argv[i + 1] ?? "") : ""; };
if (!process.env.DATABASE_URL) { console.error("x No DATABASE_URL"); process.exit(1); }
if (process.env.FAKE_LEAK) { console.error("Error: cannot reach " + process.env.DATABASE_URL); process.exit(1); }
const db = JSON.parse(readFileSync(process.env.FAKE_DB, "utf8"));
const only = flag("org"); const apply = has("apply");
if (only && !db.workspaces[only]) { console.error("x No such workspace: " + only); process.exit(1); }
const report = [];
for (const [id, w] of Object.entries(db.workspaces).sort()) {
  if (only && id !== only) continue;
  const removable = w.rows.filter((r) => !r.touched).map((r) => ({ table: r.table, id: r.id, name: r.name, origin: "left by an earlier build" }));
  const kept = w.rows.filter((r) => r.touched).map((r) => ({ table: r.table, id: r.id, name: r.name, origin: "left by an earlier build", why: [r.touched] }));
  let removed = null;
  if (apply) { removed = { workflows: removable.filter((r) => r.table === "workflows").length, recipes: removable.filter((r) => r.table === "recipes").length }; w.rows = w.rows.filter((r) => r.touched); }
  report.push({ workspace: id, removable, kept, removed });
}
db.runs = [...(db.runs ?? []), { argv: process.argv.slice(2), user: process.getuid(), cwd: process.cwd(), node_env: process.env.NODE_ENV ?? null, extra: Object.keys(process.env).filter((k) => k.startsWith("SF_TEST_")) }];
writeFileSync(process.env.FAKE_DB, JSON.stringify(db));
if (has("json")) console.log(JSON.stringify({ applied: apply, library: db.library, excluded: [], workspaces: report }, null, 2));
'''

def remote(check, tmp):
    """An app on its own server. Called inside vm_remote_selftest's Offline guard too: no socket, no ssh, no rsync."""
    import vm_remote as V
    import library as L
    node = shutil.which("node"); me = pwd.getpwuid(os.getuid()).pw_name
    appd = os.path.join(tmp, "lib-server", "app"); os.makedirs(os.path.join(appd, "scripts", "operator")); dbf = os.path.join(tmp, "lib-server", "db.json")
    envf = os.path.join(tmp, "lib-server", "web.env")
    rows = lambda: {"library": [], "workspaces": {"acme": {"rows": [{"table": "workflows", "id": "w1", "name": "qbr-prep"}, {"table": "recipes", "id": "r1", "name": "onboard-self"},
                                                                    {"table": "workflows", "id": "w2", "name": "route-incident", "touched": "ran: 3 workflow run(s)"}]},
                                                  "beta": {"rows": []}}}
    def reset(**kw): json.dump(dict(rows(), **kw), open(dbf, "w"))
    def call(expect, env=None, **kw):
        said = []; V.env_write(envf, dict({"DATABASE_URL": DB_URL, "FAKE_DB": dbf, "WEB_ORIGIN": "https://app.example.com"}, **(env or {})))
        rc = V.library_cleanup(envf, me, tmp, appd, expect, say=said.append, **kw)
        doc = json.loads(said[-1][len("LIBRARY "):]) if said and said[-1].startswith("LIBRARY {") else None
        return rc, doc, said
    reset(); rc, doc, said = call("none")
    check("cleanup (server): an app deployed before the cleanup existed is told to deploy once, and nothing runs", rc == 1 and doc and "deployed before this cleanup existed" in doc["error"] and "runs" not in json.load(open(dbf)), said)
    V.env_write(envf, {"WEB_ORIGIN": "https://app.example.com"}); said = []
    check("cleanup (server): without a DATABASE_URL in the web app's env file there is no database to look at", V.library_cleanup(envf, me, tmp, appd, "none", say=said.append) == 1 and "no DATABASE_URL" in said[0], said)
    said = []
    check("cleanup (server): a server with no user for the web app yet is told to deploy once", V.library_cleanup(envf, "no-such-user-xyz", tmp, appd, "none", say=said.append) == 1 and "no user no-such-user-xyz" in said[0], said)
    src = open(V.__file__).read(); body = src[src.index("def library_cleanup("):src.index("def library_cleanup_argv(")]
    check("cleanup (server): the child gets the web service's env file and nothing else of the server's (no master file, no admin URL), as the web app's user",
          "env_read(env_file)" in body and "POSTGRES_ADMIN_URL" not in body and "os.environ" not in body and "user=pw.pw_uid, group=pw.pw_gid" in body)
    if node and subprocess.run([node, "-e", "process.exit(process.features.typescript ? 0 : 1)"], capture_output=True).returncode == 0:
        open(os.path.join(appd, L.CLEANUP_SCRIPT), "w").write(FAKE_CLEANUP); open(os.path.join(appd, "package.json"), "w").write('{"type": "module"}\n')
        reset(); rc, doc, said = call("none"); db = json.load(open(dbf))
        check("cleanup (server, run with node): the dry run runs the app's own script once, in the built app, and changes nothing",
              rc == 0 and len(db["runs"]) == 1 and db["runs"][0]["argv"] == ["--json"] and db["runs"][0]["cwd"] == os.path.realpath(appd) and db["runs"][0]["node_env"] == "production" and len(db["workspaces"]["acme"]["rows"]) == 3, (said, db.get("runs")))
        check("cleanup (server, run with node):   ...and prints one LIBRARY line: per workspace, what would go and what stays", len(said) == 1 and doc["applied"] is False and [w["workspace"] for w in doc["workspaces"]] == ["acme", "beta"]
              and [r["name"] for r in doc["workspaces"][0]["removable"]] == ["qbr-prep", "onboard-self"] and doc["workspaces"][0]["kept"][0]["why"] == ["ran: 3 workflow run(s)"], said)
        os.environ["SF_TEST_FROM_THIS_PROCESS"] = "1"
        try: reset(); call("none"); db = json.load(open(dbf))
        finally: del os.environ["SF_TEST_FROM_THIS_PROCESS"]
        check("cleanup (server, run with node):   ...the child's environment is the env file's, not this process's", db["runs"][0]["extra"] == [])
        reset(); rc, doc, said = call("none", apply=True); db = json.load(open(dbf))
        check("cleanup (server, run with node): --apply is the dry run, then the removal: untouched rows go, the one somebody ran stays",
              rc == 0 and [r["argv"] for r in db["runs"]] == [["--json"], ["--json", "--apply"]] and doc["applied"] is True and doc["workspaces"][0]["removed"] == {"workflows": 1, "recipes": 1}
              and [r["name"] for r in db["workspaces"]["acme"]["rows"]] == ["route-incident"], (said, db))
        rc, doc, said = call("none", apply=True); db = json.load(open(dbf))
        check("cleanup (server, run with node): a second --apply finds nothing to remove and removes nothing", rc == 0 and db["runs"][-1]["argv"] == ["--json"] and doc["workspaces"][0]["removable"] == [] and len(db["workspaces"]["acme"]["rows"]) == 1, said)
        reset(); rc, doc, said = call("none", org="beta"); db = json.load(open(dbf))
        check("cleanup (server, run with node): --org looks at that workspace only", rc == 0 and db["runs"][0]["argv"] == ["--json", "--org", "beta"] and [w["workspace"] for w in doc["workspaces"]] == ["beta"], said)
        reset(); rc, doc, said = call("none", org="nope")
        check("cleanup (server, run with node): a workspace that is not there is an error in a sentence", rc == 1 and "No such workspace: nope" in doc["error"], said)
        reset(library=["account-delivery"]); rc, doc, said = call("none", apply=True); db = json.load(open(dbf))
        check("cleanup (server, run with node): running code built WITH the library while state says none: refused after the dry run, nothing removed",
              rc == 1 and "Deploy the app first" in doc["error"] and len(db["runs"]) == 1 and len(db["workspaces"]["acme"]["rows"]) == 3, said)
        reset(); rc, doc, said = call("none", env={"FAKE_LEAK": "1", "AUTH_JWT_PRIVATE_KEY": "PRIVATE-KEY-" + "k" * 30})
        check("cleanup (server, run with node): an error that quotes the database address is shown without it", rc == 1 and "did not finish" in doc["error"] and DB_URL not in said[-1] and "PASSWORD" not in said[-1] and "cannot reach" in doc["error"], said)

    # ---- the factory side, against a stand-in for the remote runner
    import vm_remote_selftest as B
    import vm_users_selftest as U
    d, docs = U._deployed(tmp, "lib-remote", lambda x: x["application"]["surface"]["custom_workflow_builder"].update(library={"install": "none"}))
    S = V.settings("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"]); crons = list(V.CRONS); WEB = V.SERVICE_USERS["web"]
    argv = V.library_cleanup_argv(S, "none", shown=True); rem = argv[-1]
    check("cleanup (remote): one SSH command: the cleanup, as the web app's user, with the web service's own env file, in the built app",
          argv[0] == "ssh" and rem == f"env {V.GUARD_VAR}=vm_remote_fixture python3 {S['tool']} library-cleanup --file {S['env_files']['web']} --user {WEB} --home {V.SERVICE_HOMES['web']} --app-dir {S['app_dir']} --expect none", rem)
    check("cleanup (remote):   ...never the master env file, the admin URL, or any value on the command line", f"--file {S['env_file']} " not in rem and "POSTGRES_ADMIN_URL" not in rem and "postgres" not in rem and "DATABASE_URL" not in rem)
    check("cleanup (remote):   ...--apply and --org are passed through, the workspace id quoted for the shell", V.library_cleanup_argv(S, "all", org="acme", apply=True)[-1].endswith("--expect all --org acme --apply"))
    copies = [rel for _, rel in V.bundle_copies()]
    check("cleanup (remote): library.py is one of the scripts every bundle carries to the server", ".claude/scripts/library.py" in copies)
    class Remote:
        def __init__(self, doc=None, raw=None, rc=0): self.calls = []; self.doc = doc; self.raw = raw; self.rc = rc; self.argv = None
        def __call__(self, step, stdin=None):
            self.calls.append(step["id"])
            if step["id"] == "bundle": return B.CP(step["argv"], 0, "", "")
            self.argv = step["argv"]
            return B.CP(step["argv"], self.rc, self.raw if self.raw is not None else "LIBRARY " + json.dumps(self.doc) + "\n", "")
    real_key = V.key_path
    V.key_path = lambda S_: os.path.join(tmp, "lib-key-that-exists"); open(os.path.join(tmp, "lib-key-that-exists"), "w").close()
    try:
        said = []; r = Remote(_report())
        rc = V.library_cleanup_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], ["vm_remote_fixture", "--library-cleanup"], crons, runner=r, say=said.append); text = "\n".join(said)
        check("cleanup (remote): the dry run sends the factory's scripts, then runs the one command, and says what would go and what stays", rc == 0 and r.calls == ["bundle", "library-cleanup"] and "--apply" not in r.argv[-1] and "--expect none" in r.argv[-1]
              and "DRY RUN. Nothing was changed." in said[0] and "would be removed (2)" in text and "kept (1), and why:" in text and "LIBRARY {" not in text, text)
        check("cleanup (remote):   ...ends with the command that removes them, and says the database address never left the server",
              "provision.py vm_remote_fixture --library-cleanup --apply" in text and said[-1].strip() == "The database address never left the server.", said[-2:])
        said = []; r = Remote(_report(applied=True, removed={"workflows": 1, "recipes": 1}))
        rc = V.library_cleanup_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], ["vm_remote_fixture", "--library-cleanup", "--apply", "--org", "acme"], crons, runner=r, say=said.append)
        check("cleanup (remote): --apply --org reaches the server and the removal is reported in counts", rc == 0 and r.argv[-1].endswith("--expect none --org acme --apply") and "REMOVED" in said[0] and "done: 1 workflow(s) and 1 recipe(s) removed" in "\n".join(said), said)
        said = []; r = Remote({"error": "the code this app runs was built WITH the account-delivery library, but its state says it uses none. Deploy the app first. Nothing was changed."}, rc=1)
        rc = V.library_cleanup_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], ["vm_remote_fixture", "--library-cleanup", "--apply"], crons, runner=r, say=said.append)
        check("cleanup (remote): what the server refused is said in its own sentence", rc == 1 and "Deploy the app first" in said[0] and len(said) == 1, said)
        said = []; r = Remote(raw="", rc=255)
        rc = V.library_cleanup_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], ["vm_remote_fixture", "--library-cleanup"], crons, runner=r, say=said.append)
        check("cleanup (remote): a server that answers nothing is a failure that says nothing was changed", rc == 1 and "did not finish on the server" in said[0] and "Nothing was changed." in said[0], said)
        r = Remote(_report())
        out, _ = B.quiet(V.library_cleanup_remote, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], ["vm_remote_fixture", "--library-cleanup", "--org", "a b;c"], crons, runner=r)
        check("cleanup (remote): something that is not a workspace id is refused before the server is contacted", isinstance(out, V.Stop) and "not a workspace id" in str(out) and r.calls == [], out)
        fresh = B.fixture_docs(); r = Remote(_report())
        out, _ = B.quiet(V.library_cleanup_remote, "vm_remote_fixture", S, fresh["application"], fresh["infrastructure"], ["vm_remote_fixture", "--library-cleanup"], crons, runner=r)
        check("cleanup (remote): an app that is not deployed is refused before the server is contacted", isinstance(out, V.Stop) and "Nothing was contacted" in str(out) and r.calls == [], out)
    finally: V.key_path = real_key
    # ---- an app that asks for the library and has no brand and no packs ships its own build copy
    check("stamp (remote): an app with no brand and no packs that asks for the library ships from its build copy; one that does not, from the mold",
          V.source_for("x", {"mold_id": "mold_v1", "surface": {"custom_workflow_builder": {"library": {"install": "all"}}}}).endswith(os.path.join("build", "x"))
          and V.source_for("x", {"mold_id": "mold_v1", "surface": {"custom_workflow_builder": {"library": {"install": "none"}}}}).endswith(os.path.join("molds", "mold_v1", "codebase")))

def run(L):
    n = [0]; fails = []
    def check(name, cond, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{name}{': ' + str(detail)[:600] if detail != '' else ''}")
    tmp = tempfile.mkdtemp(prefix="library-selftest-")
    real = (_digest(os.path.join(ROOT, "state")), _digest(os.path.join(ROOT, "packs")))
    ran = []
    try:
        choice(check, L)
        if profile(check, L, tmp): ran.append("the opt-in built with the mold's own generators")
        got = stamp(check, L, tmp)
        if got is not False: ran.append("packs.py apply, both lane copies and branding.py prepare in a temp copy of the mold" + ("" if got else " (no pack here to try it with)"))
        cleanup_rules(check, L)
        cleanup_local(check, L, tmp)
        remote(check, tmp); ran.append("the server step run with node against a stand-in for the mold's cleanup script")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    check("the real state/ and packs/ are byte-identical after the self-test", (_digest(os.path.join(ROOT, "state")), _digest(os.path.join(ROOT, "packs"))) == real)
    check("nothing was left under the real build/", not any(x.startswith(("plain_", "pk_", "brand_", "listed")) for x in (os.listdir(os.path.join(ROOT, "build")) if os.path.isdir(os.path.join(ROOT, "build")) else [])))
    if fails: print("library self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"library: {n[0]} checks passed (the choice in state, the opt-in file and its absence, idempotency, the build and lane copies, "
          f"the cleanup's dry run and --apply for an app on Vercel and on its own server; offline, stand-ins only)")
    print("  also run here: " + ("; ".join(ran) if ran else "nothing optional (needs node, rsync and the mold's library/)"))
    return 0
