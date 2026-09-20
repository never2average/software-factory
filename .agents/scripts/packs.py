#!/usr/bin/env python3
"""packs.py list | show <pack_id> | check <pack_id> | apply <app_id> | verify <app_id> | --self-test

A pack is what makes an application more than its mold WITHOUT forking the mold: a directory tree under
packs/<pack_id>/files/ that mirrors the mold's codebase root and only ADDS files (subagents, a root-instructions
section, shared sandbox helpers). An application names its packs in application.json ("packs": ["hfc-research"]).

  list             every pack with its subagents
  show <pack>      the manifest and the files it adds
  check <pack>     the pack on its own: manifest valid, only allowed paths, every subagent declared
  apply <app>      copy the app's packs into build/<app_id>/ (created from the mold if it is not there yet),
                   then run the mold's own generators there; refuses if a pack file would REPLACE a mold file
  verify <app>     the mold's own subagent checks inside build/<app_id>/
  lane-copy <app>  build/<app_id>.lane/: mold + packs, no brand, rebuilt from scratch (what the test lanes grade)

Molds stay general-purpose checkpoints: nothing here ever writes under molds/. A mold supports packs when its
codebase discovers subagents (scripts/gen-subagent-meta.mjs writes agent/lib/subagent-registry.generated.ts);
applying a pack to a mold that does not is refused, with the reason.
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
    r"^agent-kit/(kit\.json|skills/[a-z][a-z0-9-]*/.+)$",   # what the app's own agent CLI package installs into a coding agent; PUBLIC, so never operator material   # the pack's deployment profile: wording, data-room shape, agent briefing
)]
SKIP = ("__pycache__", ".pyc", ".DS_Store")

def load(p): return json.load(open(p))

def pack_files(pack_id):
    base = os.path.join(PACKS, pack_id, "files"); out = []
    for d, _, fs in os.walk(base):
        for f in fs:
            p = os.path.relpath(os.path.join(d, f), base)
            if not any(s in p for s in SKIP): out.append(p)
    return sorted(out)

def check_pack(pack_id, files=None, manifest=None):
    """-> list of problems with the pack on its own."""
    errs = []
    if not PACK_ID.match(pack_id): return [f"pack id '{pack_id}' must be lowercase letters, digits and hyphens"]
    pdir = os.path.join(PACKS, pack_id)
    if manifest is None:
        mp = os.path.join(pdir, "pack.json")
        if not os.path.exists(mp): return [f"{pack_id}: no packs/{pack_id}/pack.json"]
        try: manifest = load(mp)
        except json.JSONDecodeError as x: return [f"{pack_id}/pack.json is not valid JSON: {x.msg}"]
    if files is None: files = pack_files(pack_id)
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

def supports_packs(codebase):
    g = os.path.join(codebase, "scripts", "gen-subagent-meta.mjs")
    return os.path.exists(g) and "subagent-registry.generated" in open(g).read()

def conflicts(files, codebase):
    return [f for f in files if os.path.lexists(os.path.join(codebase, f))]

def apply(app_id, lane=False):
    """lane=True builds build/<app_id>.lane/ instead: the mold plus the packs and NO brand, always from scratch.
    The test lanes run the mold's source checks there. Those checks grade source hygiene (one of them refuses any
    customer's name in code every customer sees), and the brand overlay writes the product name into that code on
    purpose — so grading the branded copy fails an application whose product is named after its operator. The
    brand has its own check (branding.py check); the deployed copy stays build/<app_id>/."""
    app = app_docs(app_id); packs = app.get("packs") or []
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    build = os.path.join(ROOT, "build", app_id + (".lane" if lane else ""))
    if lane and os.path.isdir(build): shutil.rmtree(build)
    if not packs: print(f"{app_id}: no packs; nothing to apply"); return 0
    errs = [e for p in packs for e in check_pack(p)]
    if not supports_packs(mold_dir):
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
    for f, p in sorted(seen.items()):
        dest = os.path.join(build, f); os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(os.path.join(PACKS, p, "files", f), dest)
    cmds = [["node", "scripts/sync-subagent-shared.mjs"], ["node", "scripts/gen-subagent-meta.mjs"]]
    if os.path.exists(os.path.join(build, "scripts", "gen-deployment-profile.mjs")): cmds.append(["node", "scripts/gen-deployment-profile.mjs"])
    elif any(f.startswith("profiles/") for f in seen): sys.exit(f"{app['mold_id']} has no deployment profile (scripts/gen-deployment-profile.mjs), so a pack's profile would change nothing. Refresh the mold.")
    for cmd in cmds:
        r = subprocess.run(cmd, cwd=build, capture_output=True, text=True)
        if r.returncode:
            print((r.stdout + r.stderr).strip(), file=sys.stderr); sys.exit(f"{' '.join(cmd)} failed in {os.path.relpath(build, ROOT)}/")
    print(f"packs applied to {os.path.relpath(build, ROOT)}/: {', '.join(packs)} ({len(seen)} file(s)); shared helpers synced, subagent registry regenerated")
    return 0

def verify(app_id):
    build = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(build): sys.exit(f"no build copy at build/{app_id}; run: python3 .claude/scripts/packs.py apply {app_id}")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1"); bad = 0
    for cmd in (["node", "scripts/sync-subagent-shared.mjs", "--check"], [sys.executable, "scripts/check-subagents.py"]):
        r = subprocess.run(cmd, cwd=build, env=env); bad += 1 if r.returncode else 0
    return 1 if bad else 0

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
    print("packs: 8 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    if not a: sys.exit(__doc__)
    if a[0] == "list":
        for p in sorted(os.listdir(PACKS)) if os.path.isdir(PACKS) else []:
            mp = os.path.join(PACKS, p, "pack.json")
            if os.path.exists(mp): m = load(mp); print(f"{p:24} {m.get('name','')}: {', '.join(m.get('subagents', []))}")
        return 0
    if len(a) != 2: sys.exit(__doc__)
    if a[0] == "show":
        print(json.dumps(load(os.path.join(PACKS, a[1], "pack.json")), indent=2)); [print("  +", f) for f in pack_files(a[1])]; return 0
    if a[0] == "check":
        errs = check_pack(a[1]); [print(e) for e in errs]; print("ok" if not errs else f"{len(errs)} problem(s)"); return 1 if errs else 0
    if a[0] == "apply": return apply(a[1])
    if a[0] == "lane-copy": return apply(a[1], lane=True)
    if a[0] == "verify": return verify(a[1])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
