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
pack.json may name its mold (`"mold_id"`), and is then refused for an app on another one. `declarative` (mold_v0-124):
an app pack that is not one of the mold's `host_packs` is config only: it may add only `files` (mold_v0: its pack.json)
and its `manifest` may name none of `refused_keys` (entry, migrations, runner: code); each refusal names the
declaration to write instead. A host pack keeps its code.
  check <pack> [--mold <mold_id>]   the rules of that mold (default: the pack's own mold_id, else mold_v1's)

DEPLOY FACTS (mold_v0-050). A mold whose rules name `deploy_facts` (a file at the codebase root: mold_v0's
deploy-facts.json) gets, in the deploy copy build/<app_id>/ (never a lane copy) and BEFORE its generators run, what the
factory knows from the app's state about where it is deployed: the target, the Vercel team and projects or the server
(provider, address, domain, compose project), the database and object store providers, the secret store and every
secret NAME (deploy_facts below). Never a value: the mold's generator refuses anything that is not a name, a place or a
provider. The mold renders them into its data-flow and residency statement (DATA-MAP.md).
The same step writes the source offer the operator chose for this machine's deployments (state/factory.json
defaults.source_offer, usually set in state/factory.local.json: {"app": "licensor_exception"} when the factory's
LICENSE-EXCEPTION.md permission covers the operator, or {"app": {"url", "license"}}) into the copy's profile.json, where
the mold reads it; absent, nothing is written and the build says nothing about its own source.
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

RULE_KEYS = {"$comment", "pack_id", "allowed", "required", "manifest_required", "supports", "generators", "verify", "prune", "host_packs", "deploy_facts", "declarative"}
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
        dec = block.get("declarative")
        if dec is not None:
            if not (isinstance(dec, dict) and set(dec) <= {"$comment", "files", "manifest", "refused_keys"} and dec.get("files")
                    and all(isinstance(p, str) and p.startswith("^") and p.endswith("$") and "{pack}" in p for p in dec["files"])
                    and isinstance(dec.get("manifest"), str) and "{pack}" in dec["manifest"]
                    and all(isinstance(k, str) for k in dec.get("refused_keys") or [])):
                bad.append("declarative must be {files: [anchored patterns naming {pack}], manifest: the pack's own pack.json path with {pack}, refused_keys: [pack.json keys]}")
        if "deploy_facts" in block and not (isinstance(block["deploy_facts"], str) and re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*\.json", block["deploy_facts"])):
            bad.append("deploy_facts must be a .json file name at the codebase root")
    if bad: sys.exit(f"molds/{mold_id}/mold.json packs: " + "; ".join(bad))
    return dict(block, mold_id=mold_id)

def deploy_facts(app_id, root=None):
    """What the factory knows from state/application/<app_id>/ about where the app is deployed, as the mold's
    deploy-facts.json: names, places and providers only (never a value, never a *_ref's secret). None when the app's
    target is not one a single-service mold deploys to (vercel, compose_remote)."""
    adir = os.path.join(root or ROOT, "state", "application", app_id)
    rd = lambda n: (load(os.path.join(adir, n)) if os.path.isfile(os.path.join(adir, n)) else {}) or {}
    infra, ds = rd("infrastructure.json"), rd("datastores.json")
    target = infra.get("target")
    if target not in ("vercel", "compose_remote"): return None
    host_url = lambda u: u if isinstance(u, str) and re.fullmatch(r"https://[a-z0-9.-]+/?", u) else None
    clean = lambda d: {k: v for k, v in d.items() if v not in (None, "", [], {})}
    facts = {"$comment": "Written by the factory (.claude/scripts/packs.py deploy_facts) from the app's state: names, places and providers only, never a value. Read by scripts/gen-packs.mjs.",
             "app_id": app_id, "target": target, "source": f"state/application/{app_id}/infrastructure.json and datastores.json"}
    if target == "vercel":
        v = infra.get("vercel") or {}; pr = v.get("projects") or {}
        facts["vercel"] = clean({"team": v.get("team"), "api_project": pr.get("api"), "web_project": pr.get("web"),
                                 "production_url": host_url(v.get("custom_domain") and f"https://{v['custom_domain']}" or v.get("production_url")), "api_url": host_url(v.get("api_url"))})
    else:
        cr = infra.get("compose_remote") or {}
        facts["server"] = clean({"provider": cr.get("provider"), "host": cr.get("host"), "domain": cr.get("domain"), "compose_project": (cr.get("compose") or {}).get("project")})
    pg = ds.get("postgres") or {}
    facts["database"] = clean({"provider": pg.get("provider") or "unknown", "exposure": pg.get("exposure"), "resource": (infra.get("datastores") or {}).get("neon_resource")})
    facts["object_store"] = {"provider": (ds.get("blob") or {}).get("provider") or "none"}
    facts["secret_store"] = infra.get("secret_store") or "unknown"
    names = lambda xs: sorted({x for x in xs or [] if isinstance(x, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,62}", x)})
    req = names(infra.get("secrets"))
    facts["secrets"] = {"required": req, "optional": [x for x in names(infra.get("secrets_optional")) if x not in req]}
    return facts

def _write_json(p, doc):
    """Write doc to p when it differs; never through a hard link into the mold. -> whether it changed."""
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if os.path.isfile(p) and not os.path.islink(p) and open(p).read() == text: return False
    if os.path.lexists(p): os.remove(p)
    with open(p, "w") as fh: fh.write(text)
    return True

def _deploy_facts(build, app_id, rules):
    """mold_v0-050: the deploy facts (rules deploy_facts) and the operator's source offer (factory defaults.source_offer,
    into profile.json) written into a DEPLOY copy before its generators run. -> whether either file changed."""
    name = rules.get("deploy_facts")
    if not name or not os.path.isdir(build): return False
    changed = False
    p = os.path.join(build, name)
    facts = deploy_facts(app_id)
    if facts is None:
        if os.path.lexists(p): os.remove(p); changed = True
    else: changed |= _write_json(p, facts)
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    from factory_local import load_factory
    offer = ((load_factory(os.path.join(ROOT, "state")) or {}).get("defaults") or {}).get("source_offer")
    pp = os.path.join(build, "profile.json")
    doc = load(pp) if os.path.isfile(pp) else {}
    # The operator's offer is source_offer's every part but `upstreams`, which is the app's own (application.json profile,
    # mold_v0-099; lib/app_profile.py writes it): kept as it is here, as app_profile keeps this part.
    cur = doc.get("source_offer") if isinstance(doc.get("source_offer"), dict) else {}
    want = {k: v for k, v in (offer or {}).items() if k != "upstreams"}
    if "upstreams" in cur: want["upstreams"] = cur["upstreams"]
    if (doc.get("source_offer") or None) != (want or None):
        if want: doc["source_offer"] = want
        else: doc.pop("source_offer", None)
        changed |= _write_json(pp, doc)
    return changed

def _allowed(rules, pack_id):
    return [re.compile(p.replace("{pack}", re.escape(pack_id))) for p in rules["allowed"]]

def _declaration_for(f):
    """What a non-host app pack says in its pack.json instead of file f (mold_v0-124; the mold's gen-packs says the same)."""
    if re.search(r"\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|sh)$", f, re.I):
        return ("code: rows from the workspace's files or an upstream are repositories.<name>.map in pack.json (fields with value paths, "
                "list items a[0] and a[], only, matches, max_length, any; where; retires; only_latest), runs are job_kinds, the MCP tools are generated (mcp)")
    if re.search(r"\.md$", f, re.I): return "the customer guide's pages are pack.json guide.markdown (one page per ## heading)"
    if re.search(r"\.sql$", f, re.I): return "rows live in the shell's tables: declare record_areas in pack.json"
    return "everything an app pack says is in its pack.json"

def _declarative_problems(pack_id, files, rules):
    """mold_v0-124: an app pack that is not one of the mold's host packs is config only: its pack.json and nothing else,
    and no pack.json key that names code (rules['declarative']). A host pack keeps its code."""
    dec = rules.get("declarative")
    if not dec or pack_id in (rules.get("host_packs") or []): return []
    keep = [re.compile(p.replace("{pack}", re.escape(pack_id))) for p in dec["files"]]
    hosts = ", ".join(rules.get("host_packs") or []) or "none"
    head = f"an app pack on {rules['mold_id']} is config only: its pack.json alone (only a host pack, {hosts}, carries code or other files)"
    errs = [f"{pack_id}: {f}: {head}. Say it in pack.json instead: {_declaration_for(f)} (molds/{rules['mold_id']}/MOLD.md \"Declared row maps\")"
            for f in files if any(a.fullmatch(f) for a in _allowed(rules, pack_id)) and not any(k.fullmatch(f) for k in keep)]
    mp = os.path.join(PACKS, pack_id, "files", dec["manifest"].replace("{pack}", pack_id))
    try: inner = load(mp) if os.path.isfile(mp) else {}
    except ValueError: return errs + [f"{pack_id}: {dec['manifest'].replace('{pack}', pack_id)} is not valid JSON"]
    for k in dec.get("refused_keys") or []:
        if isinstance(inner, dict) and k in inner:
            errs.append(f"{pack_id}: {dec['manifest'].replace('{pack}', pack_id)} names `{k}`, which points at code: {head}. Take `{k}` out and declare what it did (MOLD.md \"Declared row maps\")")
    return errs

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
    return errs + _declarative_problems(pack_id, files, rules)

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
        if not lane: _app_profile(None, app_id, app)   # refused before a copy is made
        if not lane and app.get("profile") and not os.path.isdir(build):
            # an app whose only own thing is its profile settings (mold_v0-090) still deploys from a copy of its own
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import branding
            branding.build_copy(os.path.basename(build), mold_dir, root=os.path.dirname(os.path.dirname(build)))
            print(f"build copy created: {os.path.relpath(build, ROOT)}/ (from {app['mold_id']}, for the app's profile settings)")
        gone = _prune(build, mold_dir, rules, []) if not lane and os.path.isdir(build) else []
        if not lane and os.path.isdir(build) and _host_packs(build, rules, []): gone.append("profile.json host_packs")
        facts = not lane and _deploy_facts(build, app_id, rules)
        prof = not lane and os.path.isdir(build) and _app_profile(build, app_id, app)
        if gone or facts or prof: _generate(build, rules)
        print(f"{app_id}: no packs; nothing to apply" + (f"; {', '.join(gone)} (no longer named) taken out of its build copy and the registry regenerated" if gone else "")
              + ("; the deploy facts and source offer written into its build copy and the generators run" if facts else "")
              + (f"; the app's profile settings ({_profile_said(app)}) written into its build copy and the generators run" if prof else "")); return 0
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
    if not lane:
        try: _app_profile(None, app_id, app)
        except SystemExit as e: errs.append(str(e.code))
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
    for p in packs if d else []:        # a named pack's folders are rewritten whole, so a file it dropped does not linger
        for base in [d, *HOST_DIRS]:      # a host pack's console and orchestrator folders too (mold_v0-039)
            own = os.path.join(build, base, p)
            if os.path.isdir(own) and not os.path.islink(own) and not os.path.lexists(os.path.join(mold_dir, base, p)): shutil.rmtree(own)
    for f, p in sorted(seen.items()):
        dest = os.path.join(build, f)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.lexists(dest): os.remove(dest)          # never write through a hard link
        shutil.copyfile(os.path.join(PACKS, p, "files", f), dest)
    _host_packs(build, rules, packs)
    if not lane: _deploy_facts(build, app_id, rules); _app_profile(build, app_id, app)
    _generate(build, rules)
    print(f"packs applied to {os.path.relpath(build, ROOT)}/: {', '.join(packs)} ({len(seen)} file(s)"
          + (f"; {', '.join(gone)} no longer named, taken out" if gone else "")
          + (f"; the app's profile settings: {_profile_said(app)}" if app.get("profile") and not lane else "")
          + (f"; the factory's email defaults: {_defaults_said(app, build)}" if not lane and _defaults_said(app, build) else "")
          + f"); {', '.join(' '.join(c) for c in rules['generators'])} regenerated the registry")
    return 0

def _app_profile(build, app_id, app):
    """mold_v0-090: the app's own profile settings (application.json `profile`; lib/app_profile.py) written into a DEPLOY
    copy's profile.json over the mold's own, before its generators run (which check them again). build None: only check.
    A lane copy keeps the mold's defaults, as it keeps no deploy facts. -> whether the file changed."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    import app_profile
    try:
        if build is None:
            errs = app_profile.problems(app.get("profile"), app.get("mold_id"), ROOT, packs=app.get("packs") if isinstance(app.get("packs"), list) else None)
            if errs: raise ValueError("; ".join(errs))
            return False
        return app_profile.write(build, app, ROOT)
    except ValueError as e: sys.exit(f"{app_id}: the app's profile settings were refused; nothing was written: {e}")

def _defaults_said(app, build):
    """mold_v0-101: the email settings the factory wrote for the app (lib/app_profile.py email_defaults), in words; "" for none."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    import app_profile
    d = app_profile.email_defaults(app, ROOT, build)
    return app_profile.describe(d) if d else ""

def _profile_said(app):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    import app_profile
    return app_profile.describe(app.get("profile"))

# A host pack's console and orchestrator folders (mold_v0-039), pruned like rules['prune'] when the mold has one.
HOST_DIRS = ("web/src/packs", "orchestrator/packs")

def _prune(build, mold_dir, rules, packs):
    """Per-pack folders under rules['prune'] (and a host pack's console and orchestrator folders) in the build copy that
    are neither the mold's nor a pack the app names: what an earlier apply left for a pack since dropped. Removed, so the
    registry never lists it. -> the removed paths."""
    d = rules.get("prune")
    if not d: return []
    gone = []
    for base in (d, *HOST_DIRS):
        here = os.path.join(build, base)
        if os.path.lexists(here) and not os.path.realpath(here).startswith(os.path.realpath(build) + os.sep):
            sys.exit(f"{os.path.relpath(here, ROOT)} is a link out of the build copy; nothing was removed or copied")
        for x in sorted(os.listdir(here)) if os.path.isdir(here) else []:
            if x in packs or os.path.lexists(os.path.join(mold_dir, base, x)): continue
            p = os.path.join(here, x)
            if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p)
            else: os.remove(p)
            gone.append(f"{base}/{x}")
    return gone

def _host_packs(build, rules, packs):
    """mold_v0-039: the packs this mold lets be host packs (mold.json packs.host_packs: the product's own surface, with
    the shell's services) that the app names, written into the build copy's profile.json as `host_packs`, which the
    mold's generator reads. Every other pack stays an ordinary pack, held to the strict import rules."""
    allowed = rules.get("host_packs") or []
    if not allowed: return False
    p = os.path.join(build, "profile.json")
    doc = load(p) if os.path.isfile(p) else {}
    want = [x for x in packs if x in allowed]
    if doc.get("host_packs") == (want or None): return False
    if want: doc["host_packs"] = want
    else: doc.pop("host_packs", None)
    if os.path.lexists(p): os.remove(p)          # never write through a hard link into the mold
    with open(p, "w") as fh: fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return True

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
    app = app_docs(app_id); rules = rules_for(app.get("mold_id"))
    if rules is not None:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
        import app_profile
        for e in app_profile.check(build, app, ROOT): print("FAIL profile: " + e); bad += 1   # mold_v0-090
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
    ok(R and R["mold_id"] == "mold_v0" and R["generators"][0] == ["node", "scripts/gen-packs.mjs"] and supports_packs(os.path.join(ROOT, "molds", "mold_v0", "codebase"), R),
       "mold_v0's rules load from its mold.json, and its codebase passes their support test (scripts/gen-packs.mjs)")
    m = {"pack_id": "notes", "name": "Notes", "description": "d", "mold_id": "mold_v0"}
    good = ["packs/notes/pack.json"]
    ok(check_pack("notes", good, m, R) == [], check_pack("notes", good, m, R))
    # mold_v0-124: an app pack that is not a host pack is its pack.json alone; each refusal names the declaration instead.
    for f, hint in (("packs/notes/index.ts", "repositories.<name>.map"), ("packs/notes/lib/rows.mjs", "repositories.<name>.map"), ("packs/notes/migrations/0001_notes.sql", "declare record_areas"),
                    ("packs/notes/guide/intro.md", "guide.markdown"), ("packs/notes/data.csv", "everything an app pack says is in its pack.json")):
        e = check_pack("notes", good + [f], m, R)
        ok(len(e) == 1 and "config only" in e[0] and hint in e[0] and f in e[0], f"refused in a non-host pack, naming {hint}: {f} ({e})")
    code = good + ["packs/notes/index.ts", "packs/notes/migrations/0001_notes.sql"]
    ok(check_pack("notes", code, m, {k: v for k, v in R.items() if k != "declarative"}) == [], "a mold with no declarative rule keeps code packs")
    host = ["packs/octillion/pack.json", "packs/octillion/host.ts", "web/src/packs/octillion/index.ts", "orchestrator/packs/octillion/main.ts"]
    ok(check_pack("octillion", host, dict(m, pack_id="octillion"), R) == [], "a host pack (mold.json host_packs) keeps its code")
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
                "if (process.argv.includes('--check')) process.exit(0);\nwriteFileSync('src/packs.generated.ts', JSON.stringify(ids) + '\\n');\n"
                "const LIMIT_KEYS = {\n  runs: [\"budget_usd_max\", \"kind_month_budget_usd\"],\n};\n")
            os.makedirs(os.path.join(mold, "branding")); json.dump({"profile": {"file": "profile.json", "app_settable": ["limits", "member_keys", "source_offer.upstreams"]}}, open(os.path.join(mold, "branding", "rules.json"), "w"))
            man = load(os.path.join(keep[0], "molds", "mold_v0", "mold.json"))
            # mold_v0's rules with its registry generator only (the stand-in codebase has no tsx for the others)
            json.dump({"mold_id": "mold_t", "packs": dict(man["packs"], generators=man["packs"]["generators"][:1], verify=man["packs"]["verify"][:1]), "build_copy": man["build_copy"]}, open(os.path.join(mold, "mold.json"), "w"))
            for pid in ("notes", "tasks"):
                f = os.path.join(t, "packs", pid, "files", "packs", pid); os.makedirs(f)
                json.dump({"pack_id": pid, "name": pid, "description": "d", "mold_id": "mold_t"}, open(os.path.join(t, "packs", pid, "pack.json"), "w"))
                open(os.path.join(f, "pack.json"), "w").write("{}\n")
            def app(packs):
                d = os.path.join(t, "state", "application", "zz"); os.makedirs(d, exist_ok=True)
                json.dump({"app_id": "zz", "mold_id": "mold_t", "status": "planned", "packs": packs}, open(os.path.join(d, "application.json"), "w"))
            import io, contextlib
            def quiet(fn, *a, **k):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    try: return fn(*a, **k)
                    except SystemExit as e: return e.code
            b = os.path.join(t, "build", "zz"); reg = lambda d=b: open(os.path.join(d, "src", "packs.generated.ts")).read().strip()
            app(["notes", "tasks"]); ok(quiet(apply, "zz") == 0 and reg() == '["notes","tasks"]' and os.path.isfile(os.path.join(b, "packs", "notes", "pack.json")),
                                         "apply: the packs' files under packs/<id>/, then the mold's generator")
            ok(not os.path.exists(os.path.join(b, ".env")) and os.path.samefile(os.path.join(b, "node_modules", "x", "i.js"), os.path.join(cb, "node_modules", "x", "i.js")),
               "the build copy leaves out what mold.json build_copy excludes (.env) and links the mold's node_modules")
            app(["notes"]); ok(quiet(apply, "zz") == 0 and reg() == '["notes"]' and not os.path.exists(os.path.join(b, "packs", "tasks")),
                               "a pack the app no longer names is pruned from the build copy and the registry")
            # mold_v0-050: the deploy facts (names, places, providers) and the operator's source offer, in the deploy copy only
            sd = os.path.join(t, "state", "application", "zz")
            json.dump({"target": "vercel", "secret_store": "vercel_env", "secrets": ["APP_VAULT_KEY", "DATABASE_URL"], "secrets_optional": ["R2_ACCESS_KEY_ID", "DATABASE_URL", "not a name"],
                       "vercel": {"team": "acme", "project": "zz", "projects": {"api": "zz-api", "web": "zz"}, "production_url": "https://zz.vercel.app", "api_url": "https://zz-api.vercel.app/x?y=1"},
                       "datastores": {"neon_resource": "zz"}}, open(os.path.join(sd, "infrastructure.json"), "w"))
            json.dump({"postgres": {"provider": "neon", "exposure": "managed_provider", "url_ref": "DATABASE_URL", "admin_url_ref": "DATABASE_URL_UNPOOLED"}, "blob": {"provider": "none"}}, open(os.path.join(sd, "datastores.json"), "w"))
            json.dump({"defaults": {"source_offer": {"app": "licensor_exception"}}}, open(os.path.join(t, "state", "factory.json"), "w"))
            ok(quiet(apply, "zz") == 0, "apply with deploy facts")
            f = load(os.path.join(b, "deploy-facts.json"))
            ok(f["target"] == "vercel" and f["vercel"] == {"team": "acme", "api_project": "zz-api", "web_project": "zz", "production_url": "https://zz.vercel.app"}
               and f["database"] == {"provider": "neon", "exposure": "managed_provider", "resource": "zz"} and f["object_store"] == {"provider": "none"}
               and f["secrets"] == {"required": ["APP_VAULT_KEY", "DATABASE_URL"], "optional": ["R2_ACCESS_KEY_ID"]} and f["secret_store"] == "vercel_env",
               f"the deploy facts from state: names, places and providers (an address with a path or query left out, a non-name dropped): {f}")
            ok(load(os.path.join(b, "profile.json")).get("source_offer") == {"app": "licensor_exception"}, "the operator's source offer (factory defaults) in the copy's profile.json")
            json.dump({}, open(os.path.join(t, "state", "factory.json"), "w"))
            ok(quiet(apply, "zz") == 0 and "source_offer" not in load(os.path.join(b, "profile.json")), "no default: no source_offer in the copy")
            ok(quiet(lane_copies, "zz") == 0 and not any(os.path.exists(os.path.join(t, "build", x, "deploy-facts.json")) for x in ("zz.lane", "zz.lane-default")), "never in a lane copy")
            # mold_v0-090: the app's own profile settings (application.json `profile`) in the deploy copy's profile.json
            ad = os.path.join(t, "state", "application", "zz", "application.json"); lim = {"runs": {"budget_usd_max": 40, "kind_month_budget_usd": 500}}
            def prof_app(profile, packs=("notes",)):
                d_ = load(ad); d_["packs"] = list(packs); d_.pop("profile", None)
                if profile is not None: d_["profile"] = profile
                json.dump(d_, open(ad, "w"))
            pj = lambda d=b: load(os.path.join(d, "profile.json")) if os.path.isfile(os.path.join(d, "profile.json")) else {}
            prof_app({"limits": lim}); ok(quiet(apply, "zz") == 0 and pj().get("limits") == lim, f"the app's limits in the deploy copy's profile.json: {pj()}")
            ok(quiet(lane_copies, "zz") == 0 and not any("limits" in pj(os.path.join(t, "build", x)) for x in ("zz.lane", "zz.lane-default")), "never in a lane copy (the mold's defaults are graded there)")
            prof_app(None); ok(quiet(apply, "zz") == 0 and "limits" not in pj(), "a setting taken out of state is taken out of the copy (back to the mold's own)")
            # mold_v0-099: member_keys, and source_offer.upstreams (the app's part) beside the operator's source_offer.app
            json.dump({"defaults": {"source_offer": {"app": "licensor_exception"}}}, open(os.path.join(t, "state", "factory.json"), "w"))
            own = {"member_keys": False, "source_offer": {"upstreams": {"notes": "licensor_owned"}}}
            prof_app(own); ok(quiet(apply, "zz") == 0 and pj().get("member_keys") is False and pj().get("source_offer") == {"app": "licensor_exception", "upstreams": {"notes": "licensor_owned"}},
                              f"the app's member_keys and source_offer.upstreams, with the operator's source_offer.app kept: {pj()}")
            ok(quiet(apply, "zz") == 0 and pj().get("source_offer") == {"app": "licensor_exception", "upstreams": {"notes": "licensor_owned"}}, "applied again: the same (each writer keeps the other's part)")
            prof_app(None); ok(quiet(apply, "zz") == 0 and "member_keys" not in pj() and pj().get("source_offer") == {"app": "licensor_exception"}, f"taken out of state: back to the operator's offer alone: {pj()}")
            json.dump({}, open(os.path.join(t, "state", "factory.json"), "w"))
            prof_app(own); ok(quiet(apply, "zz") == 0 and pj().get("source_offer") == {"upstreams": {"notes": "licensor_owned"}}, "no operator default: the app's part alone")
            prof_app(None); ok(quiet(apply, "zz") == 0 and "source_offer" not in pj(), "and gone with it")
            for bad, why in (({"host_packs": ["notes"]}, "host_packs"), ({"source_offer": {"app": "licensor_exception"}}, "source_offer"), ({"limits": {"runs": {"budget_usd_max": "40"}}}, "positive number"),
                             ({"limits": {"runs": {"live_per_workspace": 3}}}, "is not a limit"), ({"limits": {"runs": {"budget_usd_max": True}}}, "positive number"), ({"email_from_address": "a@b.c"}, "not settable"),
                             ({"member_keys": "false"}, "true or false"), ({"source_offer": {"upstreams": {"tasks": "licensor_owned"}}}, "a pack the app does not have"),
                             ({"source_offer": {"upstreams": {"notes": "yes"}}}, "a value other than licensor_owned")):
                prof_app(bad); open(os.path.join(b, "packs", "notes", "marker"), "w").write("x")
                ok(quiet(apply, "zz") not in (0, None) and os.path.exists(os.path.join(b, "packs", "notes", "marker")) and "limits" not in pj(),
                   f"refused before anything is copied (the pack's folder not rewritten, no limits written): a profile with {why}")
                os.remove(os.path.join(b, "packs", "notes", "marker"))
            shutil.rmtree(b); prof_app({"limits": lim}, packs=())
            ok(quiet(apply, "zz") == 0 and pj().get("limits") == lim and os.path.isfile(os.path.join(b, "src", "packs.generated.ts")),
               "an app with profile settings and no packs still gets a deploy copy carrying them, its generator run")
            prof_app(None)
            infra = load(os.path.join(sd, "infrastructure.json")); infra["target"] = "vm"; json.dump(infra, open(os.path.join(sd, "infrastructure.json"), "w"))
            ok(quiet(apply, "zz") == 0 and not os.path.exists(os.path.join(b, "deploy-facts.json")), "a target the mold does not deploy to: no facts (a stale file removed)")
            for x in ("zz.lane", "zz.lane-default"): shutil.rmtree(os.path.join(t, "build", x))
            app([]); ok(quiet(apply, "zz") == 0 and reg() == "[]" and os.listdir(os.path.join(b, "packs")) == ["README.md"], "no packs: the last one pruned, the mold's own file kept")
            app(["notes"]); quiet(apply, "zz"); open(os.path.join(b, "packs", "notes", "stale.ts"), "w").write("dropped\n")
            ok(quiet(apply, "zz") == 0 and not os.path.exists(os.path.join(b, "packs", "notes", "stale.ts")), "a file a still-named pack dropped does not linger in the build copy")
            for base in HOST_DIRS:            # a host pack's console and orchestrator folders (mold_v0-039) the same way
                os.makedirs(os.path.join(b, base, "notes"), exist_ok=True); open(os.path.join(b, base, "notes", "stale.ts"), "w").write("dropped\n")
                os.makedirs(os.path.join(b, base, "gone"), exist_ok=True)
            ok(quiet(apply, "zz") == 0 and not any(os.path.exists(os.path.join(b, base, x)) for base in HOST_DIRS for x in ("notes/stale.ts", "gone")),
               "a host pack's console and orchestrator folders: rewritten whole while named, pruned once not")
            for hid in (".impl/x.ts", "node_modules/pg/index.js"):
                ok(any("hidden or node_modules" in e for e in check_pack("notes", good + ["packs/notes/" + hid], m, R)), f"refused: {hid} (the shell's own checks skip it)")
            inner = os.path.join(t, "packs", "notes", "files", "packs", "notes")
            app(["notes"]); before = sorted(os.listdir(os.path.join(b, "packs", "notes")))
            open(os.path.join(inner, "pack.json"), "w").write('{"entry": "index.ts"}\n')
            ok(quiet(apply, "zz") and any("names `entry`, which points at code" in e for e in check_pack("notes", rules=rules_for("mold_t"))) and sorted(os.listdir(os.path.join(b, "packs", "notes"))) == before,
               "a non-host pack whose pack.json names entry: refused, nothing copied")
            open(os.path.join(inner, "pack.json"), "w").write("{}\n"); open(os.path.join(inner, "index.ts"), "w").write("export default {};\n")
            ok(quiet(apply, "zz") and any("config only" in e for e in check_pack("notes", rules=rules_for("mold_t"))), "a non-host pack carrying code: refused")
            os.remove(os.path.join(inner, "index.ts"))
            open(os.path.join(t, "packs", "notes", "files", "packs", "README.md"), "w").write("mine\n")
            app(["notes"]); before = sorted(os.listdir(os.path.join(b, "packs")))
            ok(quiet(apply, "zz") and sorted(os.listdir(os.path.join(b, "packs"))) == before, "a pack file outside its own id: refused, nothing copied")
            os.remove(os.path.join(t, "packs", "notes", "files", "packs", "README.md"))
            os.makedirs(os.path.join(cb, "packs", "notes")); open(os.path.join(cb, "packs", "notes", "pack.json"), "w").write("// the mold's\n")
            ok(quiet(apply, "zz") and open(os.path.join(cb, "packs", "notes", "pack.json")).read() == "// the mold's\n", "a pack file that would replace a mold file: refused")
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
