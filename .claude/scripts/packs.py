#!/usr/bin/env python3
"""packs.py list | show <pack_id> | check <pack_id> | apply <app_id> | verify <app_id> | --self-test

A pack is what makes an application more than its mold WITHOUT forking the mold: a directory tree under
packs/<pack_id>/files/ that mirrors the mold's codebase root and only ADDS files (subagents, a root-instructions
section, shared sandbox helpers). An application names its packs in application.json ("packs": ["hfc-research"]).

  list             every pack with its subagents
  show <pack>      the manifest and the files it adds
  check <pack>     the pack on its own: manifest valid, only allowed paths, every subagent declared
  apply <app>      copy the app's packs into build/<app_id>/ (created from the mold if it is not there yet),
                   then run the mold's own generators there; refuses if a pack file would REPLACE a mold file.
                   The same step gives the copy the starter library state asks for (library.py): with
                   library.install "all" the mold's account-delivery library is named in the copy's profile before
                   the profile is generated, with "none" it is left out and a stale copy is removed. An app with no
                   packs that asks for the library gets a build copy for that alone.
  verify <app>     the mold's own subagent checks inside build/<app_id>/
  lane-copy <app>  the two copies the test lanes grade, both rebuilt from scratch and unbranded:
                     build/<app_id>.lane/          mold + packs (the app's code AND its profile's words)
                     build/<app_id>.lane-default/  mold + packs WITHOUT the packs' profiles/: the default profile,
                                                   which is what the mold's own offline tests are written against
                   The first follows library.install as apply does; the second never carries the library, because
                   it must stay the mold's default profile.

Molds stay general-purpose checkpoints: nothing here ever writes under molds/. A mold supports packs when its
codebase discovers subagents (scripts/gen-subagent-meta.mjs writes agent/lib/subagent-registry.generated.ts);
applying a pack to a mold that does not is refused, with the reason.

PER-MOLD RULES (mold_v0-024). The paths above, the support test and the generators are mold_v1's, and they stay the
rules for every mold whose molds/<mold_id>/mold.json has no `packs` block (mold_v1 has no mold.json at all). A mold
that declares a `packs` block gets its own: `pack_id` (the id pattern), `allowed` (path patterns relative to the
codebase root; `{pack}` is the pack's own id, so a pack can only add files under its own name), `required` (files
every pack must add), `manifest_required` (pack.json fields), `supports` (a file and the text it must contain),
`generators` (run in the build copy after the files are copied), `verify` (the copy's own checks) and `prune` (the
directory whose per-pack folders an earlier apply may have left behind for a pack the app no longer names). A pack's
pack.json may name its mold (`"mold_id"`), and is then refused for an app on another one.
  check <pack> [--mold <mold_id>]   the rules of that mold (default: the pack's own mold_id, else mold_v1's)
"""
import json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PACKS = os.path.join(ROOT, "packs")
PACK_ID = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
# Where a pack may add files, relative to the codebase root. Anything else is refused: a pack that could write
# anywhere is a fork with extra steps.
ALLOWED = [re.compile(p) for p in (
    r"^agent/subagents/[a-z][a-z0-9-]*/.+",
    r"^agent/instructions/\d{2}-pack-[a-z0-9-]+\.(md|ts)$",
    r"^scripts/subagent-shared/[a-z][a-z0-9_-]*/.+",
    r"^docs/packs/[A-Za-z0-9_.-]+\.md$",
    r"^profiles/\d{2}-pack-[a-z0-9-]+\.json$",
    r"^library/[a-z][a-z0-9-]*/.+",   # the pack's own starter library (workflows, recipes, starter apps); its profile must name it in library.sources
    r"^agent-kit/(kit\.json|skills/[a-z][a-z0-9-]*/.+)$",   # what the app's own agent CLI package installs into a coding agent; PUBLIC, so never operator material   # the pack's deployment profile: wording, data-room shape, agent briefing
)]
SKIP = ("__pycache__", ".pyc", ".DS_Store")

def load(p): return json.load(open(p))

RULE_KEYS = {"$comment", "pack_id", "allowed", "required", "manifest_required", "supports", "generators", "verify", "prune"}
def rules_for(mold_id):
    """The `packs` block of molds/<mold_id>/mold.json, checked, or None: the mold_v1 rules above (every mold without one)."""
    p = os.path.join(ROOT, "molds", str(mold_id or ""), "mold.json")
    if not mold_id or not os.path.isfile(p): return None
    try: block = load(p).get("packs")
    except (ValueError, AttributeError): sys.exit(f"molds/{mold_id}/mold.json is not valid JSON")
    if block is None: return None
    bad = [] if isinstance(block, dict) else ["it is not an object"]
    if not bad:
        bad += [f"unknown field {k}" for k in block if k not in RULE_KEYS]
        for k in ("pack_id", "allowed", "supports", "generators"):
            if not block.get(k): bad.append(f"{k} is missing")
        for pat in block.get("allowed") or []:
            if not (isinstance(pat, str) and pat.startswith("^") and pat.endswith("$") and "{pack}" in pat):
                bad.append(f"allowed pattern {pat!r} must be anchored (^...$) and name {{pack}}, so a pack adds files under its own id only")
        sup = block.get("supports") or {}
        if not (isinstance(sup, dict) and sup.get("file") and sup.get("contains")): bad.append("supports needs file and contains")
        for k in ("generators", "verify"):
            if any(not (isinstance(c, list) and c and all(isinstance(x, str) for x in c)) for c in block.get(k) or []): bad.append(f"{k} must be a list of commands (lists of words)")
    if bad: sys.exit(f"molds/{mold_id}/mold.json packs: " + "; ".join(bad))
    return dict(block, mold_id=mold_id)

def _allowed(rules, pack_id):
    return [re.compile(p.replace("{pack}", re.escape(pack_id))) for p in rules["allowed"]]

def _check_by_rules(pack_id, files, manifest, rules):
    """check_pack for a mold that declares its own rules (mold.json packs)."""
    errs = []
    if not re.fullmatch(rules["pack_id"], pack_id):
        return [f"pack id '{pack_id}' does not fit {rules['mold_id']}'s pack ids ({rules['pack_id']})"]
    if manifest.get("pack_id") != pack_id: errs.append(f"{pack_id}/pack.json: pack_id is {manifest.get('pack_id')!r}")
    if manifest.get("mold_id") not in (None, rules["mold_id"]):
        errs.append(f"{pack_id}/pack.json says it is for {manifest.get('mold_id')}, not {rules['mold_id']}")
    for k in rules.get("manifest_required") or []:
        if not manifest.get(k): errs.append(f"{pack_id}/pack.json: '{k}' is missing or empty")
    if not files: errs.append(f"{pack_id}: packs/{pack_id}/files/ is empty")
    allowed = _allowed(rules, pack_id)
    shown = ", ".join(p.replace("{pack}", pack_id).strip("^$") for p in rules["allowed"])
    for f in files:
        parts = f.replace(os.sep, "/").split("/")
        if not (os.path.isabs(f) or ".." in parts or any(not x for x in parts)) and any(x.startswith(".") or x == "node_modules" for x in parts):
            # the shell's own checks (gen-packs) skip hidden and node_modules folders, so a pack may not ship any
            errs.append(f"{pack_id}: {f} is in a hidden or node_modules folder, which the mold's own pack checks do not read; a pack may not add one")
        elif os.path.isabs(f) or ".." in parts or any(not x for x in parts) or not any(a.fullmatch(f) for a in allowed):
            errs.append(f"{pack_id}: {f} is outside what a pack may add under {rules['mold_id']} ({shown})")
        elif os.path.islink(os.path.join(PACKS, pack_id, "files", f)):
            errs.append(f"{pack_id}: {f} is a link; a pack adds real files only")
    base = os.path.join(PACKS, pack_id, "files")
    for d, dn, _ in os.walk(base):
        for x in dn:
            if os.path.islink(os.path.join(d, x)): errs.append(f"{pack_id}: {os.path.relpath(os.path.join(d, x), base)}/ is a linked folder; a pack adds real files only")
    for r in rules.get("required") or []:
        want = r.replace("{pack}", pack_id)
        if want not in files: errs.append(f"{pack_id}: files/{want} is missing (every {rules['mold_id']} pack adds it)")
    return errs

def pack_files(pack_id):
    base = os.path.join(PACKS, pack_id, "files"); out = []
    for d, _, fs in os.walk(base):
        for f in fs:
            p = os.path.relpath(os.path.join(d, f), base)
            if not any(s in p for s in SKIP): out.append(p)
    return sorted(out)

def check_pack(pack_id, files=None, manifest=None, rules=None):
    """-> list of problems with the pack on its own. rules: a mold's own (rules_for); None is mold_v1's."""
    errs = []
    if rules is not None and not re.fullmatch(r"[a-z][a-z0-9_-]{1,40}", pack_id):
        return [f"pack id '{pack_id}' must be lowercase letters, digits, hyphens and underscores"]
    if rules is None and not PACK_ID.match(pack_id): return [f"pack id '{pack_id}' must be lowercase letters, digits and hyphens"]
    pdir = os.path.join(PACKS, pack_id)
    if manifest is None:
        mp = os.path.join(pdir, "pack.json")
        if not os.path.exists(mp): return [f"{pack_id}: no packs/{pack_id}/pack.json"]
        try: manifest = load(mp)
        except json.JSONDecodeError as x: return [f"{pack_id}/pack.json is not valid JSON: {x.msg}"]
    if files is None: files = pack_files(pack_id)
    if rules is not None: return _check_by_rules(pack_id, files, manifest, rules)
    if manifest.get("pack_id") != pack_id: errs.append(f"{pack_id}/pack.json: pack_id is {manifest.get('pack_id')!r}")
    for k in ("name", "description", "subagents"):
        if not manifest.get(k): errs.append(f"{pack_id}/pack.json: '{k}' is missing or empty")
    if not files: errs.append(f"{pack_id}: packs/{pack_id}/files/ is empty")
    for f in files:
        if not any(a.match(f) for a in ALLOWED):
            errs.append(f"{pack_id}: {f} is outside what a pack may add (agent/subagents/<key>/, "
                        f"agent/instructions/NN-pack-<name>.md, scripts/subagent-shared/<family>/, profiles/NN-pack-<name>.json, agent-kit/skills/<name>/, docs/packs/)")
    have = {f.split("/")[2] for f in files if f.startswith("agent/subagents/") and f.endswith("/agent.ts") and f.count("/") == 3}
    want = set(manifest.get("subagents") or [])
    for k in sorted(want - have): errs.append(f"{pack_id}: pack.json names subagent '{k}' but files/agent/subagents/{k}/agent.ts is not there")
    for k in sorted(have - want): errs.append(f"{pack_id}: files/ adds subagent '{k}' that pack.json does not name")
    return errs

def app_docs(app_id):
    f = os.path.join(ROOT, "state", "application", app_id, "application.json")
    if not os.path.exists(f): sys.exit(f"{app_id}: no state/application/{app_id}/application.json")
    return load(f)

def supports_packs(codebase, rules=None):
    if rules is not None:
        g = os.path.join(codebase, rules["supports"]["file"])
        return os.path.isfile(g) and rules["supports"]["contains"] in open(g).read()
    g = os.path.join(codebase, "scripts", "gen-subagent-meta.mjs")
    return os.path.exists(g) and "subagent-registry.generated" in open(g).read()

def conflicts(files, codebase):
    return [f for f in files if os.path.lexists(os.path.join(codebase, f))]

PACK_PROFILE = re.compile(r"^profiles/")
GENERATED_PROFILE = ("lib/deployment-profile.generated.ts", "agent/lib/deployment-profile.generated.ts", "agent/lib/workflow-library.generated.ts")

def _library():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path: sys.path.insert(0, here)
    import library
    return library

def apply(app_id, lane=False, default_profile=False, build=None):
    """lane=True builds build/<app_id>.lane/ instead: the mold plus the packs and NO brand, always from scratch.
    The test lanes run the mold's source checks there. Those checks grade source hygiene (one of them refuses any
    customer's name in code every customer sees), and the brand overlay writes the product name into that code on
    purpose — so grading the branded copy fails an application whose product is named after its operator. The
    brand has its own check (branding.py check); the deployed copy stays build/<app_id>/.

    default_profile=True (with lane) builds build/<app_id>.lane-default/: the same, minus every file a pack adds
    under profiles/. The mold's offline unit and contract tests (npm run test:*) are written against the DEFAULT
    profile — scripts/test-deployment-profile.mjs says so in as many words, and upstream CI runs them on nothing
    else — so a pack that relabels the vocabulary or declares its own record fields fails them by design: the
    wording "deployment's profile" becomes "workspace's profile", a pinned 38-column workbook gains the pack's
    field, a tool's result speaks `companyId` where the test reads `customerId` (onfinance_hfc, mold_v1-146/147).
    Those rows measured the pack's profile against the mold's fixtures, not the product. This copy still carries
    the pack's CODE, so those tests also run over its subagents and helpers; the profile's own words are graded
    where they mean something (the pack-mode vocabulary gate, the rendered and live checks). The generated
    profile here must come out byte-identical to the mold's, or the copy is not the default and the build stops."""
    app = app_docs(app_id); packs = app.get("packs") or []
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    rules = rules_for(app["mold_id"])
    if rules is not None: return _apply_by_rules(app_id, app, packs, mold_dir, rules, lane, default_profile, build)
    # build=<dir>: an existing copy of the mold somewhere else (repo.py assembles an app's repository in a scratch
    # directory, never under build/); the packs go into it exactly as they go into a deploy's copy.
    build = build or os.path.join(ROOT, "build", app_id + ((".lane-default" if default_profile else ".lane") if lane else ""))
    if lane and os.path.isdir(build): shutil.rmtree(build)
    # The starter library state asks for (library.py): "all" names the mold's account-delivery library in this copy's
    # profile, "none" leaves it out. The default-profile lane copy never carries it.
    library = _library(); wants_library = library.install(app) == "all" and not default_profile
    if not packs and not wants_library:
        note = ""
        if not lane and os.path.isdir(build) and library.apply(build, app, mold_dir).endswith("removed)"): note = "; the starter library it no longer asks for was taken out of its build copy"
        print(f"{app_id}: no packs; nothing to apply{note}"); return 0
    errs = [e for p in packs for e in check_pack(p)]
    if packs and not supports_packs(mold_dir):
        errs.append(f"{app['mold_id']} does not discover subagents (its scripts/gen-subagent-meta.mjs writes no "
                    f"agent/lib/subagent-registry.generated.ts), so a pack's subagents would exist and be registered nowhere. "
                    f"Refresh the mold from an upstream that has subagent packs (docs/SUBAGENT_PACKS.md).")
    seen = {}
    for p in packs:
        for f in (pack_files(p) if not check_pack(p) else []):
            if f in seen: errs.append(f"{f} is added by both {seen[f]} and {p}")
            seen.setdefault(f, p)
        # against the MOLD, not the build copy: a re-apply must not mistake its own earlier files for the mold's
        for f in conflicts([x for x, o in seen.items() if o == p], mold_dir):
            errs.append(f"{p}: {f} already exists in {app['mold_id']}; a pack only adds files, it never replaces one")
    if errs:
        for e in errs: print(e, file=sys.stderr)
        sys.exit(f"{len(errs)} problem(s); nothing was copied")
    if not os.path.isdir(build):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import branding
        branding.build_copy(os.path.basename(build), mold_dir)
        print(f"build copy created: {os.path.relpath(build, ROOT)}/ (from {app['mold_id']})")
    if default_profile: seen = {f: p for f, p in seen.items() if not PACK_PROFILE.match(f)}
    for f, p in sorted(seen.items()):
        dest = os.path.join(build, f); os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(os.path.join(PACKS, p, "files", f), dest)
    # Before the generators below: the profile generator must read the library's profile file, and the workflow
    # library is compiled from the same profiles (always, so a pack's own profile is honoured too).
    lib_note = library.apply(build, app, mold_dir, default_profile, regenerate=False)
    cmds = [["node", "scripts/sync-subagent-shared.mjs"], ["node", "scripts/gen-subagent-meta.mjs"]] if packs else []
    if os.path.exists(os.path.join(build, library.PROFILE_AWARE)) and os.path.exists(os.path.join(build, library.GENERATORS[0])): cmds.append(["node", library.GENERATORS[0]])
    if os.path.exists(os.path.join(build, "scripts", "gen-deployment-profile.mjs")): cmds.append(["node", "scripts/gen-deployment-profile.mjs"])
    elif any(f.startswith("profiles/") for f in seen): sys.exit(f"{app['mold_id']} has no deployment profile (scripts/gen-deployment-profile.mjs), so a pack's profile would change nothing. Refresh the mold.")
    for cmd in cmds:
        r = subprocess.run(cmd, cwd=build, capture_output=True, text=True)
        if r.returncode:
            print((r.stdout + r.stderr).strip(), file=sys.stderr); sys.exit(f"{' '.join(cmd)} failed in {os.path.relpath(build, ROOT)}/")
    if default_profile:
        drift = [g for g in GENERATED_PROFILE if os.path.exists(os.path.join(mold_dir, g)) and
                 (not os.path.exists(os.path.join(build, g)) or open(os.path.join(build, g), "rb").read() != open(os.path.join(mold_dir, g), "rb").read())]
        if drift: sys.exit(f"{os.path.relpath(build, ROOT)}/ was built without the packs' profiles, yet {', '.join(drift)} differs from "
                           f"{app['mold_id']}'s: a pack changed the deployment profile some other way, so this copy is not the default profile "
                           f"and the mold's own tests cannot be graded in it.")
    if not packs: print(f"no packs; {os.path.relpath(build, ROOT)}/ is the mold with its {lib_note}; the profile and the starter library regenerated"); return 0
    print(f"packs applied to {os.path.relpath(build, ROOT)}/: {', '.join(packs)} ({len(seen)} file(s)"
          + ("; its profiles/ left out, so it reads in the default profile" if default_profile else "")
          + f"); shared helpers synced, subagent registry regenerated; {lib_note}")
    return 0

def _apply_by_rules(app_id, app, packs, mold_dir, rules, lane=False, default_profile=False, build=None):
    """apply() for a mold that declares its own pack rules (mold.json packs; mold_v0). The same contract: only adds
    files, never replaces one, refuses before copying anything. A mold with no deployment profiles has no default-profile
    copy to tell apart, so build/<app_id>.lane-default/ is the same as build/<app_id>.lane/ (the packs' code)."""
    build = build or os.path.join(ROOT, "build", app_id + ((".lane-default" if default_profile else ".lane") if lane else ""))
    if lane and os.path.isdir(build): shutil.rmtree(build)
    if not packs:
        gone = _prune(build, mold_dir, rules, []) if not lane and os.path.isdir(build) else []
        if gone: _generate(build, rules)
        print(f"{app_id}: no packs; nothing to apply" + (f"; {', '.join(gone)} (no longer named) taken out of its build copy and the registry regenerated" if gone else "")); return 0
    errs = [e for p in packs for e in check_pack(p, rules=rules)]
    if not supports_packs(mold_dir, rules):
        errs.append(f"{app['mold_id']} does not discover packs ({rules['supports']['file']} with {rules['supports']['contains']!r} is not in its codebase), "
                    f"so a pack's files would be registered nowhere.")
    seen = {}
    for p in packs:
        for f in (pack_files(p) if not check_pack(p, rules=rules) else []):
            if f in seen: errs.append(f"{f} is added by both {seen[f]} and {p}")
            seen.setdefault(f, p)
        for f in conflicts([x for x, o in seen.items() if o == p], mold_dir):
            errs.append(f"{p}: {f} already exists in {app['mold_id']}; a pack only adds files, it never replaces one")
    if errs:
        for e in errs: print(e, file=sys.stderr)
        sys.exit(f"{len(errs)} problem(s); nothing was copied")
    if not os.path.isdir(build):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import branding
        branding.build_copy(os.path.basename(build), mold_dir, root=os.path.dirname(os.path.dirname(build)))
        print(f"build copy created: {os.path.relpath(build, ROOT)}/ (from {app['mold_id']})")
    inside = os.path.realpath(build) + os.sep
    for f, p in sorted(seen.items()):     # every destination checked BEFORE anything is removed or written
        up = os.path.dirname(os.path.join(build, f))
        while not os.path.lexists(up): up = os.path.dirname(up)
        if not (os.path.realpath(up) + os.sep).startswith(inside):    # a link in the build copy would carry the file out of it
            sys.exit(f"{p}: {f} would be written outside {os.path.relpath(build, ROOT)}/ (through a link in the build copy); nothing was removed or copied")
    gone = _prune(build, mold_dir, rules, packs)
    d = rules.get("prune")
    for p in packs if d else []:        # a named pack's folder is rewritten whole, so a file it dropped does not linger
        own = os.path.join(build, d, p)
        if os.path.isdir(own) and not os.path.islink(own) and not os.path.lexists(os.path.join(mold_dir, d, p)): shutil.rmtree(own)
    for f, p in sorted(seen.items()):
        dest = os.path.join(build, f)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.lexists(dest): os.remove(dest)          # never write through a hard link
        shutil.copyfile(os.path.join(PACKS, p, "files", f), dest)
    _generate(build, rules)
    print(f"packs applied to {os.path.relpath(build, ROOT)}/: {', '.join(packs)} ({len(seen)} file(s)"
          + (f"; {', '.join(gone)} no longer named, taken out" if gone else "")
          + f"); {', '.join(' '.join(c) for c in rules['generators'])} regenerated the registry")
    return 0

def _prune(build, mold_dir, rules, packs):
    """Per-pack folders under rules['prune'] in the build copy that are neither the mold's nor a pack the app names:
    what an earlier apply left for a pack since dropped. Removed, so the registry never lists it. -> the removed paths."""
    d = rules.get("prune")
    if not d: return []
    here, gone = os.path.join(build, d), []
    if os.path.lexists(here) and not os.path.realpath(here).startswith(os.path.realpath(build) + os.sep):
        sys.exit(f"{os.path.relpath(here, ROOT)} is a link out of the build copy; nothing was removed or copied")
    for x in sorted(os.listdir(here)) if os.path.isdir(here) else []:
        if x in packs or os.path.lexists(os.path.join(mold_dir, d, x)): continue
        p = os.path.join(here, x)
        if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p)
        else: os.remove(p)
        gone.append(f"{d}/{x}")
    return gone

def _generate(build, rules):
    for cmd in rules["generators"]:
        r = subprocess.run(cmd, cwd=build, capture_output=True, text=True)
        if r.returncode:
            out = (r.stdout + r.stderr).strip()
            print(out, file=sys.stderr)
            hint = (" Its node_modules are missing: install them in the mold's codebase (npm ci there), which the build copy links."
                    if "npm ci" in out or "Cannot find" in out else "")
            sys.exit(f"{' '.join(cmd)} failed in {os.path.relpath(build, ROOT)}/.{hint}")

def lane_copies(app_id):
    """Both copies the lanes grade: build/<app_id>.lane/ (mold + packs) and build/<app_id>.lane-default/ (mold + packs,
    default profile). See apply()."""
    return apply(app_id, lane=True) or apply(app_id, lane=True, default_profile=True)

def verify(app_id):
    build = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(build): sys.exit(f"no build copy at build/{app_id}; run: python3 .claude/scripts/packs.py apply {app_id}")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1"); bad = 0
    rules = rules_for(app_docs(app_id).get("mold_id"))
    if rules is not None:
        for cmd in rules.get("verify") or []:
            r = subprocess.run(cmd, cwd=build, env=env); bad += 1 if r.returncode else 0
        return 1 if bad else 0
    for cmd in (["node", "scripts/sync-subagent-shared.mjs", "--check"], [sys.executable, "scripts/check-subagents.py"]):
        r = subprocess.run(cmd, cwd=build, env=env); bad += 1 if r.returncode else 0
    bad += model_surface(build, env)
    return 1 if bad else 0

def model_surface(build, env, run=subprocess.run):
    """Render what the agent's model reads in this build copy (the mold's scripts/lib/model-surface.mjs, ~10 s), so
    a profile whose words collide (two labels turning into one tool parameter name, 2026-10-16 compliance_os) fails
    HERE, before a deploy, instead of inside the deploy's eve build. 0 when it renders or the mold has no renderer."""
    script = os.path.join(build, "scripts", "lib", "model-surface.mjs")
    if not os.path.exists(script): return 0
    r = run(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, "--no-results"],
            cwd=build, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode == 0: print("model surface: renders (no word collision in what the agent reads)"); return 0
    err = r.stderr or ""
    clash = re.findall(r'agent vocabulary: "[^"$]+" would read "[^"$]+", which is already a parameter here', err)
    print("FAIL model surface: " + (clash[0] + ". Two labels in the profile map to one tool parameter name: rename one "
          "of them (or drop a redundant grouping)." if clash else "it did not render: " + (err.strip().splitlines() or ["(no output)"])[-1][:300]))
    return 1

def self_test():
    m = {"pack_id": "demo-pack", "name": "Demo", "description": "d", "subagents": ["alpha"]}
    ok = ["agent/subagents/alpha/agent.ts", "agent/subagents/alpha/skills/x/SKILL.md", "agent/instructions/50-pack-demo-pack.md",
          "scripts/subagent-shared/doclib/targets.json", "docs/packs/demo-pack.md"]
    assert check_pack("demo-pack", ok, m) == [], check_pack("demo-pack", ok, m)
    assert any("outside" in e for e in check_pack("demo-pack", ok + ["agent/instructions.md"], m))
    assert any("outside" in e for e in check_pack("demo-pack", ok + ["app/page.tsx"], m))
    assert any("outside" in e for e in check_pack("demo-pack", ok + ["agent/instructions/pack.md"], m))
    assert any("does not name" in e for e in check_pack("demo-pack", ok + ["agent/subagents/beta/agent.ts"], m))
    assert any("is not there" in e for e in check_pack("demo-pack", ok, dict(m, subagents=["alpha", "gamma"])))
    assert check_pack("Bad_Id", ok, m) and check_pack("demo-pack", [], m)
    import tempfile, types, io, contextlib
    with tempfile.TemporaryDirectory() as d:
        assert model_surface(d, {}) == 0  # a mold without the renderer is not checked
        os.makedirs(os.path.join(d, "scripts", "lib")); open(os.path.join(d, "scripts", "lib", "model-surface.mjs"), "w").close()
        clash = 'Error: agent vocabulary: "implementationId" would read "complianceFrameworkId", which is already a parameter here\n'
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert model_surface(d, {}, run=lambda *x, **k: types.SimpleNamespace(returncode=1, stderr=clash)) == 1
            assert model_surface(d, {}, run=lambda *x, **k: types.SimpleNamespace(returncode=0, stderr="")) == 0
        assert '"implementationId" would read "complianceFrameworkId"' in out.getvalue(), out.getvalue()
    n = 10 + rules_self_test()
    print(f"packs: {n} checks passed ({n - 10} of them: per-mold pack rules, mold_v0-024)"); return 0

def rules_self_test():
    """Per-mold rules (mold.json packs): mold_v1 keeps the constants above; mold_v0's rules confine a pack to its own id;
    apply, prune and lane copies in a stand-in mold under a temp factory root (nothing under the real build/ or state/)."""
    import tempfile
    global ROOT, PACKS
    n = [0]
    def ok(c, what):
        n[0] += 1
        if not c: raise AssertionError(what)
    ok(rules_for("mold_v1") is None and rules_for(None) is None, "mold_v1 (no mold.json) keeps the built-in rules, byte for byte")
    R = rules_for("mold_v0")
    ok(R and R["mold_id"] == "mold_v0" and R["generators"] == [["node", "scripts/gen-packs.mjs"]] and supports_packs(os.path.join(ROOT, "molds", "mold_v0", "codebase"), R),
       "mold_v0's rules load from its mold.json, and its codebase passes their support test (scripts/gen-packs.mjs)")
    m = {"pack_id": "notes", "name": "Notes", "description": "d", "mold_id": "mold_v0"}
    good = ["packs/notes/pack.json", "packs/notes/index.ts", "packs/notes/migrations/0001_notes.sql"]
    ok(check_pack("notes", good, m, R) == [], check_pack("notes", good, m, R))
    for bad, why in ((["packs/other/index.ts"], "another pack's directory"), (["src/server.ts"], "a shell file"), (["packs/notes_x/a.ts"], "a pack whose id starts with its own"),
                     (["packs/notes/../server.ts"], "a path that climbs out"), (["web/src/app/app/page.tsx"], "a console page of the shell"), (["packs/notes"], "the directory itself, no file")):
        ok(any("outside what a pack may add" in e for e in check_pack("notes", good + bad, m, R)), f"refused: {why}")
    ok(any("pack.json is missing" in e for e in check_pack("notes", good[1:], m, R)), "a pack must add its own pack.json")
    ok(any("says it is for mold_v1" in e for e in check_pack("notes", good, dict(m, mold_id="mold_v1"), R)), "a pack made for another mold is refused")
    ok(check_pack("my-notes", ["packs/my-notes/pack.json"], dict(m, pack_id="my-notes"), R) and check_pack("x", ["packs/x/pack.json"], dict(m, pack_id="x"), R),
       "mold_v0's own id rule (the shell's table prefix): no hyphens, at least two characters")
    ok(any("'description' is missing" in e for e in check_pack("notes", good, dict(m, description=""), R)), "pack.json's required fields")
    ok(check_pack("notes", good, dict(m, subagents=[]), None) and check_pack("demo-pack", ["agent/subagents/alpha/agent.ts"], {"pack_id": "demo-pack", "name": "D", "description": "d", "subagents": ["alpha"]}, None) == [],
       "with no rules (mold_v1) the built-in paths still apply, and a mold_v0 layout is refused there")
    keep = ROOT, PACKS
    with tempfile.TemporaryDirectory() as t:
        try:
            ROOT, PACKS = t, os.path.join(t, "packs")
            mold = os.path.join(t, "molds", "mold_t"); cb = os.path.join(mold, "codebase")
            os.makedirs(os.path.join(cb, "scripts")); os.makedirs(os.path.join(cb, "packs")); os.makedirs(os.path.join(cb, "node_modules", "x"))
            open(os.path.join(cb, "node_modules", "x", "i.js"), "w").write("1\n")
            open(os.path.join(cb, "packs", "README.md"), "w").write("packs live here\n"); open(os.path.join(cb, ".env"), "w").write("SECRET=standin\n")
            open(os.path.join(cb, "scripts", "gen-packs.mjs"), "w").write(
                "// stand-in: writes src/packs.generated.ts from the pack directories\nimport { readdirSync, mkdirSync, writeFileSync } from 'node:fs';\n"
                "mkdirSync('src', { recursive: true });\nconst ids = readdirSync('packs', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();\n"
                "if (process.argv.includes('--check')) process.exit(0);\nwriteFileSync('src/packs.generated.ts', JSON.stringify(ids) + '\\n');\n")
            man = load(os.path.join(keep[0], "molds", "mold_v0", "mold.json"))
            json.dump({"mold_id": "mold_t", "packs": man["packs"], "build_copy": man["build_copy"]}, open(os.path.join(mold, "mold.json"), "w"))
            for pid in ("notes", "tasks"):
                f = os.path.join(t, "packs", pid, "files", "packs", pid); os.makedirs(f)
                json.dump({"pack_id": pid, "name": pid, "description": "d", "mold_id": "mold_t"}, open(os.path.join(t, "packs", pid, "pack.json"), "w"))
                open(os.path.join(f, "pack.json"), "w").write("{}\n"); open(os.path.join(f, "index.ts"), "w").write("export default {};\n")
            def app(packs):
                d = os.path.join(t, "state", "application", "zz"); os.makedirs(d, exist_ok=True)
                json.dump({"app_id": "zz", "mold_id": "mold_t", "status": "planned", "packs": packs}, open(os.path.join(d, "application.json"), "w"))
            import io, contextlib
            def quiet(fn, *a, **k):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    try: return fn(*a, **k)
                    except SystemExit as e: return e.code
            b = os.path.join(t, "build", "zz"); reg = lambda d=b: open(os.path.join(d, "src", "packs.generated.ts")).read().strip()
            app(["notes", "tasks"]); ok(quiet(apply, "zz") == 0 and reg() == '["notes","tasks"]' and os.path.isfile(os.path.join(b, "packs", "notes", "index.ts")),
                                         "apply: the packs' files under packs/<id>/, then the mold's generator")
            ok(not os.path.exists(os.path.join(b, ".env")) and os.path.samefile(os.path.join(b, "node_modules", "x", "i.js"), os.path.join(cb, "node_modules", "x", "i.js")),
               "the build copy leaves out what mold.json build_copy excludes (.env) and links the mold's node_modules")
            app(["notes"]); ok(quiet(apply, "zz") == 0 and reg() == '["notes"]' and not os.path.exists(os.path.join(b, "packs", "tasks")),
                               "a pack the app no longer names is pruned from the build copy and the registry")
            app([]); ok(quiet(apply, "zz") == 0 and reg() == "[]" and os.listdir(os.path.join(b, "packs")) == ["README.md"], "no packs: the last one pruned, the mold's own file kept")
            app(["notes"]); quiet(apply, "zz"); open(os.path.join(b, "packs", "notes", "stale.ts"), "w").write("dropped\n")
            ok(quiet(apply, "zz") == 0 and not os.path.exists(os.path.join(b, "packs", "notes", "stale.ts")), "a file a still-named pack dropped does not linger in the build copy")
            for hid in (".impl/x.ts", "node_modules/pg/index.js"):
                ok(any("hidden or node_modules" in e for e in check_pack("notes", good + ["packs/notes/" + hid], m, R)), f"refused: {hid} (the shell's own checks skip it)")
            open(os.path.join(t, "packs", "notes", "files", "packs", "README.md"), "w").write("mine\n")
            app(["notes"]); before = sorted(os.listdir(os.path.join(b, "packs")))
            ok(quiet(apply, "zz") and sorted(os.listdir(os.path.join(b, "packs"))) == before, "a pack file outside its own id: refused, nothing copied")
            os.remove(os.path.join(t, "packs", "notes", "files", "packs", "README.md"))
            os.makedirs(os.path.join(cb, "packs", "notes")); open(os.path.join(cb, "packs", "notes", "index.ts"), "w").write("// the mold's\n")
            ok(quiet(apply, "zz") and open(os.path.join(cb, "packs", "notes", "index.ts")).read() == "// the mold's\n", "a pack file that would replace a mold file: refused")
            shutil.rmtree(os.path.join(cb, "packs", "notes"))
            shutil.rmtree(os.path.join(b, "packs")); os.symlink(os.path.join(t, "elsewhere"), os.path.join(b, "packs")); os.makedirs(os.path.join(t, "elsewhere", "keep"))
            ok(quiet(apply, "zz") and os.listdir(os.path.join(t, "elsewhere")) == ["keep"], "a link in the build copy cannot carry a pack's files out of it, nor prune outside it")
            os.remove(os.path.join(b, "packs")); shutil.rmtree(b)
            ok(quiet(lane_copies, "zz") == 0 and reg(os.path.join(t, "build", "zz.lane")) == '["notes"]' and reg(os.path.join(t, "build", "zz.lane-default")) == '["notes"]',
               "lane-copy: both lane copies carry the packs (a mold with no deployment profiles has no other default)")
            ok(sorted(os.listdir(os.path.join(cb, "packs"))) == ["README.md"] and sorted(os.listdir(cb)) == [".env", "node_modules", "packs", "scripts"],
               "the mold itself is never written")
        finally:
            ROOT, PACKS = keep
    return n[0]

def _own_rules(pack_id):
    """The rules of the mold a pack names in its pack.json (mold_id), else mold_v1's."""
    mp = os.path.join(PACKS, pack_id, "pack.json")
    try: mold = load(mp).get("mold_id") if PACK_ID.match(pack_id) or re.fullmatch(r"[a-z][a-z0-9_-]{1,40}", pack_id) else None
    except (OSError, ValueError, AttributeError): mold = None
    return rules_for(mold) if isinstance(mold, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,40}", mold) else None

def main(a):
    if "--self-test" in a: return self_test()
    if not a: sys.exit(__doc__)
    if a[0] == "list":
        for p in sorted(os.listdir(PACKS)) if os.path.isdir(PACKS) else []:
            mp = os.path.join(PACKS, p, "pack.json")
            if os.path.exists(mp): m = load(mp); print(f"{p:24} {m.get('name','')}: {', '.join(m.get('subagents', []))}")
        return 0
    if a[0] == "check" and len(a) == 4 and a[2] == "--mold":
        errs = check_pack(a[1], rules=rules_for(a[3])); [print(e) for e in errs]; print("ok" if not errs else f"{len(errs)} problem(s)"); return 1 if errs else 0
    if len(a) != 2: sys.exit(__doc__)
    if a[0] == "show":
        print(json.dumps(load(os.path.join(PACKS, a[1], "pack.json")), indent=2)); [print("  +", f) for f in pack_files(a[1])]; return 0
    if a[0] == "check":
        errs = check_pack(a[1], rules=_own_rules(a[1])); [print(e) for e in errs]; print("ok" if not errs else f"{len(errs)} problem(s)"); return 1 if errs else 0
    if a[0] == "apply": return apply(a[1])
    if a[0] == "lane-copy": return lane_copies(a[1])
    if a[0] == "verify": return verify(a[1])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
