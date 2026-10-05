#!/usr/bin/env python3
"""library.py <app_id> show | apply | cleanup [--apply] [--org <id>]   |   --self-test

The starter library of an application: the workflows and onboarding recipes every NEW workspace is given.

A mold carries no library of its own (mold_v1 since fde-agent #111). The one the original product shipped, 13
workflows and 5 recipes for a team that delivers a platform to accounts, sits in the mold as
library/account-delivery/, and a build gets it only by naming it in its deployment profile. An application says
which it wants in state (application.json, surface.custom_workflow_builder.library.install):

  "none"  (the default)   no starter library: a new workspace starts with no workflows and no recipes of the mold's
  "all"                   the account-delivery library

  show      what state says and what the build copy under build/<app_id>/ was built with
  apply     put state's choice into build/<app_id>/ and regenerate (packs.py apply and branding.py prepare do this
            themselves; this is the same step on its own)
  cleanup   the same as `provision.py <app_id> --library-cleanup [--apply] [--org <id>]`: per workspace, the rows an
            earlier build left behind that this app does not use: what would be removed, what is kept and why.
            A DRY RUN unless --apply is given. Only rows nobody edited, ran or built on are ever removed.

HOW "all" REACHES A BUILD. sync() copies the mold's library/account-delivery/profile.json to
profiles/40-library-account-delivery.json in the build copy ("none" leaves it out and removes a stale copy), and
apply() then runs the mold's own two generators that read it (scripts/build-workflow-library.mjs, then
scripts/gen-deployment-profile.mjs). The copy the lanes grade against the DEFAULT profile
(build/<app_id>.lane-default/) never gets it: it must stay the mold's default profile.

"listed" (a hand-picked subset by name) has no equivalent upstream and is refused, with what to write instead.
"""
import json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE_ID = "account-delivery"
PROFILE_SRC = f"library/{SOURCE_ID}/profile.json"
PROFILE_DST = f"profiles/40-library-{SOURCE_ID}.json"
GENERATED = "agent/lib/workflow-library.generated.ts"
PROFILE_AWARE = "scripts/lib/profile-library.mjs"          # a mold that has this reads its library from the profile
GENERATORS = ("scripts/build-workflow-library.mjs", "scripts/gen-deployment-profile.mjs")   # in the order npm run build:generated runs them
CLEANUP_SCRIPT = "scripts/operator/library-cleanup.mjs"
ORG_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
LISTED = ('surface.custom_workflow_builder.library.install is "listed", which no longer exists: the library is all or nothing. '
          'Write "all" for the whole account-delivery library (13 workflows, 5 recipes), or "none" and put the workflows '
          "you want under surface.custom_workflow_builder.scripts.")

def load(p): return json.load(open(p))

# ------------------------------------------------------------------------------------------- what state asks for
def install(app):
    """ "all" or "none" for an application document. Absent means "none": the mold's own default. """
    lib = (((app.get("surface") or {}).get("custom_workflow_builder") or {}).get("library") or {})
    v = lib.get("install", "none") if isinstance(lib, dict) else "none"
    if v == "listed": sys.exit(f"{app.get('app_id', 'this application')}: {LISTED}")
    return "all" if v == "all" else "none"

def problems(app_id, app):
    """What factory.py validate says about the library choice, beyond the schema."""
    lib = (((app.get("surface") or {}).get("custom_workflow_builder") or {}).get("library") or {}) if isinstance(app, dict) else {}
    if isinstance(lib, dict) and lib.get("install") == "listed": return [f"{app_id}/application.json: {LISTED}"]
    return []

# ------------------------------------------------------------------------------------------- the build copy
def built_sources(build):
    """The library ids a build copy's generated module was built from, or None when it cannot be read."""
    p = os.path.join(build, GENERATED)
    if not os.path.isfile(p): return None
    m = re.search(r"LIBRARY_SOURCES[^=\n]*=\s*(\[[^\]]*\])", open(p).read())
    try: return list(json.loads(m.group(1))) if m else None
    except ValueError: return None

def sync(build, want, mold_dir, default_profile=False):
    """Make build/profiles/ say what state says. -> "builtin" (a mold from before the library moved: nothing to do),
    "added", "updated", "kept", "removed" or "absent". Never writes outside `build`."""
    if not os.path.exists(os.path.join(mold_dir, PROFILE_AWARE)): return "builtin"
    dst = os.path.join(build, PROFILE_DST); src = os.path.join(mold_dir, PROFILE_SRC)
    if want != "all" or default_profile:
        if os.path.lexists(dst): os.remove(dst); return "removed"
        return "absent"
    if not os.path.isfile(src):
        sys.exit(f'state asks for the starter library (library.install "all"), but {os.path.relpath(src, ROOT)} is not in the mold. '
                 f'Refresh the mold, or set "install": "none".')
    body = open(src, "rb").read(); had = os.path.isfile(dst)
    if had and open(dst, "rb").read() == body: return "kept"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f: f.write(body)
    return "updated" if had else "added"

def generate(build):
    for g in GENERATORS:
        if not os.path.exists(os.path.join(build, g)): continue
        r = subprocess.run(["node", g], cwd=build, capture_output=True, text=True)
        if r.returncode:
            print((r.stdout + r.stderr).strip(), file=sys.stderr); sys.exit(f"node {g} failed in {build}")

def apply(build, app, mold_dir, default_profile=False, regenerate=True):
    """sync(), then the generators when the build no longer says what its profiles say. -> one plain line.
    Safe to repeat: a second run changes nothing and runs nothing."""
    want = install(app); did = sync(build, want, mold_dir, default_profile)
    if did == "builtin": return "this mold still carries its starter library in base code; nothing to opt into"
    on = want == "all" and not default_profile
    have = built_sources(build)
    stale = did in ("added", "updated", "removed") or have is None or ((SOURCE_ID in have) != on)
    if regenerate and stale: generate(build)
    if on: return "starter library: account-delivery (named in " + PROFILE_DST + ")"
    return "starter library: none" + (" (a stale opt-in was removed)" if did == "removed" else "")

def build_dir_for(app_id, app):
    """Where a deploy builds this app from: its own copy when it has a brand, packs or the library, else the mold."""
    if (app.get("surface") or {}).get("branding") or app.get("packs") or install(app) == "all": return os.path.join(ROOT, "build", app_id)
    return os.path.join(ROOT, "molds", app["mold_id"], "codebase")

# ------------------------------------------------------------------------------------------- the cleanup
NODE = ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning"]

def parse_report(stdout):
    """The JSON document `library-cleanup.mjs --json` prints, wherever it starts in stdout. None if it is not there."""
    text = stdout or ""
    for i in [m.start() for m in re.finditer(r"(?m)^\{", text)]:
        try: doc = json.loads(text[i:])
        except ValueError: continue
        if isinstance(doc, dict) and isinstance(doc.get("workspaces"), list): return doc
    return None

def mismatch(report, expect):
    """Why this build must not be used to clean up, or None. The cleanup decides what is a leftover from the library
    the CODE was built with, so code that disagrees with state would remove the wrong rows."""
    have = SOURCE_ID in (report.get("library") or [])
    if expect == "none" and have:
        return ("the code this app runs was built WITH the account-delivery library, but its state says it uses none. "
                "Deploy the app first, so the running code matches state; then run this again. Nothing was changed.")
    if expect == "all" and not have:
        return ("the code this app runs was built WITHOUT the account-delivery library, but its state says it uses it, so its "
                "workflows would be listed as leftovers. Deploy the app first, so the running code matches state; then run this again. Nothing was changed.")
    return None

def run_cleanup(run, expect, org=None, do_apply=False):
    """The mold's own operator:library-cleanup, through `run(argv) -> CompletedProcess` (which supplies the working
    directory and the environment). Always a dry run first; --apply only after that dry run showed the code and the
    state agree. -> (report | None, error | None)."""
    if org and not ORG_ID.match(org): return None, f"'{org}' is not a workspace id (letters, digits, dots, hyphens and underscores)."
    base = NODE + [CLEANUP_SCRIPT, "--json"] + (["--org", org] if org else [])
    def once(extra):
        try: r = run(base + extra)
        except (OSError, subprocess.SubprocessError) as e: return None, f"the cleanup could not be run ({type(e).__name__})"
        doc = parse_report(r.stdout)
        if r.returncode or doc is None:
            tail = " / ".join(l.strip() for l in ((r.stdout or "") + "\n" + (r.stderr or "")).splitlines() if l.strip())[-400:]
            return None, "the cleanup did not finish: " + (tail or "it printed nothing")
        return doc, None
    doc, err = once([])
    if err: return None, err
    why = mismatch(doc, expect)
    if why: return None, why
    if do_apply and any(w.get("removable") for w in doc["workspaces"]): return once(["--apply"])
    return doc, None

def _thing(r): return ("recipe" if r.get("table") == "recipes" else "workflow") + f' "{r.get("name")}"'

def render(app_id, report, applied, say=print, org=None):
    """The report in plain words: per workspace, what goes and what stays, and why."""
    ws = report.get("workspaces") or []; excl = report.get("excluded") or []
    lib = "the account-delivery starter library" if SOURCE_ID in (report.get("library") or []) else "no starter library"
    say(f"{app_id}: " + ("REMOVED what is listed below as removed." if applied else "DRY RUN. Nothing was changed."))
    say(f"  This app is built with {lib}" + (f", and without the specialist(s) {', '.join(excl)}" if excl else "") + ". "
        "A leftover is a workflow or recipe an earlier version of the app put into a workspace that this version does not use.")
    if not ws: say("  There is no workspace in this app's database yet, so there is nothing to look at."); return
    total = 0
    for w in sorted(ws, key=lambda x: str(x.get("workspace"))):
        rem = w.get("removable") or []; kept = w.get("kept") or []; total += len(rem)
        say(f"  Workspace {w.get('workspace')}:")
        if not rem and not kept: say("    nothing left over"); continue
        if rem:
            say(f"    {'removed' if applied else 'would be removed'} ({len(rem)}): nobody ever edited them, ran them or built anything on them")
            for r in rem: say(f"      - {_thing(r)}: {r.get('origin')}")
        else: say("    nothing to remove")
        if kept:
            say(f"    kept ({len(kept)}), and why:")
            for r in kept: say(f"      - {_thing(r)}: {r.get('origin')}; kept because: {'; '.join(r.get('why') or ['somebody used it'])}")
        gone = w.get("removed")
        if applied and isinstance(gone, dict): say(f"    done: {gone.get('workflows', 0)} workflow(s) and {gone.get('recipes', 0)} recipe(s) removed")
    if not applied and total:
        say(f"  Nothing was changed. To remove the {total} row(s) listed as removable: python3 .claude/scripts/provision.py {app_id} --library-cleanup"
            + (f" --org {org}" if org else "") + " --apply")
    elif not applied: say("  There is nothing to remove.")

def cleanup_args(a):
    """(--org value or None, --apply?) from a command line."""
    org = a[a.index("--org") + 1] if "--org" in a and a.index("--org") + 1 < len(a) else None
    if "--org" in a and (not org or org.startswith("-")): sys.exit("--org needs a workspace id after it")
    return org, "--apply" in a

def cleanup_local(app_id, app, infra, a, pull_env=None, runner=None, say=print):
    """`provision.py <app> --library-cleanup` for an application on Vercel: the mold's cleanup, run from the app's own
    build copy with the app role's DATABASE_URL (row-level security in force). The URL is read from the project's
    production environment for the length of the run, handed to the child in its environment, and never printed."""
    org, do_apply = cleanup_args(a); expect = install(app)
    if infra.get("target") != "vercel" or not (infra.get("vercel") or {}).get("production_url"):
        say(f"{app_id}: this app is not deployed, so it has no database to look at. Nothing was contacted."); return 1
    build = build_dir_for(app_id, app)
    if not os.path.isfile(os.path.join(build, CLEANUP_SCRIPT)):
        say(f"{app_id}: the app's code under {os.path.relpath(build, ROOT)}/ was built before this cleanup existed (or is not there). "
            f"Deploy the app first, which rebuilds it: python3 .claude/scripts/provision.py {app_id} --deploy. Nothing was contacted."); return 1
    have = built_sources(build)
    if have is not None:
        why = mismatch({"library": have}, expect)
        if why: say(f"{app_id}: {why.replace('Nothing was changed.', 'Nothing was contacted.')}"); return 1
    if pull_env is None:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import clone
        pull_env = clone.pull_env
    url = (pull_env(infra["vercel"]["project"], build) or {}).get("DATABASE_URL")
    if not url or url == "[SENSITIVE]":
        say(f"{app_id}: the database address could not be read from the project's production environment. Nothing was changed."); return 1
    hide = lambda s: re.sub(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@\"']*:[^\s/@\"']*@", r"\1***:***@", (s or "").replace(url, "[redacted]"))
    def run(argv):
        r = (runner or subprocess.run)(argv, cwd=build, env=dict(os.environ, DATABASE_URL=url, NODE_ENV="production"), capture_output=True, text=True, timeout=900)
        return subprocess.CompletedProcess(argv, r.returncode, hide(r.stdout), hide(r.stderr))
    report, err = run_cleanup(run, expect, org, do_apply)
    if err: say(f"{app_id}: {hide(err)}"); return 1
    render(app_id, report, bool(report.get("applied")), say, org); return 0

# ------------------------------------------------------------------------------------------- command line
def _docs(app_id):
    d = os.path.join(ROOT, "state", "application", app_id)
    if not os.path.isfile(os.path.join(d, "application.json")): sys.exit(f"{app_id}: no state/application/{app_id}/application.json")
    return load(os.path.join(d, "application.json")), load(os.path.join(d, "infrastructure.json"))

def main(a):
    if "--self-test" in a:
        here = os.path.dirname(os.path.abspath(__file__)); sys.path[:0] = [here, os.path.join(here, "lib")]
        import library, library_selftest          # the one copy of this module every other script imports, not __main__
        return library_selftest.run(library)
    if len(a) < 2: sys.exit(__doc__)
    app_id, verb = a[0], a[1]; app, infra = _docs(app_id); want = install(app)
    build = os.path.join(ROOT, "build", app_id); mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    if verb == "show":
        have = built_sources(build) if os.path.isdir(build) else None
        print(f'{app_id}: state says library.install "{want}" (' + ("the account-delivery library: 13 workflows, 5 recipes" if want == "all" else "no starter library") + ")")
        print(f"  build/{app_id}/: " + ("no build copy yet" if not os.path.isdir(build) else "cannot tell what it was built with" if have is None
                                       else "built with " + (", ".join(have) if have else "no library")))
        return 0
    if verb == "apply":
        if not os.path.isdir(build): sys.exit(f"no build copy at build/{app_id}; run: python3 .claude/scripts/packs.py apply {app_id}")
        print(f"{app_id}: {apply(build, app, mold_dir)}"); return 0
    if verb == "cleanup":
        return subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/provision.py"), app_id, "--library-cleanup", *a[2:]]).returncode
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
