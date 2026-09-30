#!/usr/bin/env python3
"""pack-vocabulary.py <app_id> — what THIS application's model reads, in its own words (context lane).

The mold's offline tests run on the DEFAULT profile (lane cwd `default_profile`), because they pin its words and
fields. That leaves the application's own profile to be graded somewhere it means something. For an application
with packs, that is the mold's own gate in pack mode, once per pack:

    npm run check:agent-vocabulary -- --pack packs/<pack_id> [--allow packs/<pack_id>/vocabulary-allow.json]

which renders the pack applied to this checkout under the pack's own profile (system prompts, the per-turn
briefing, every tool's name, description and parameters, every subagent's prompt, skills and sandbox files, the
results of real offline tool calls) and fails on any base word the model would read. An allow-list is the pack's
own, and every entry in it must say why. The gate builds its copies under the system temp dir; nothing is written
into the checkout.

An application WITHOUT packs ships the default profile, so its model-facing surface is the mold's: the gate's
ordinary mode proves the default surface is byte-identical to the mold's snapshot and that a relabelling profile
leaks no base word.

Run from the checkout to grade (lanes.py runs it with cwd `codebase`). Prints one line per run and exits non-zero
if any failed. A mold without the gate is a skip, said as such (`vocabulary: not measured`), never a pass.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

def main(a):
    if len(a) != 1 or a[0].startswith("-"): sys.exit(__doc__)
    app_id = a[0]
    app = json.load(open(os.path.join(ROOT, "state", "application", app_id, "application.json")))
    pkg = json.load(open("package.json")) if os.path.exists("package.json") else {}
    if "check:agent-vocabulary" not in (pkg.get("scripts") or {}):
        print(f"vocabulary: not measured — {os.getcwd()} has no `check:agent-vocabulary` script; refresh the mold from source per its MOLD.md.")
        return 0
    runs = []
    for p in app.get("packs") or []:
        pdir = os.path.join(ROOT, "packs", p)
        args = ["--pack", pdir]
        allow = os.path.join(pdir, "vocabulary-allow.json")
        if os.path.exists(allow): args += ["--allow", allow]
        runs.append((f"pack {p}", args))
    if not runs: runs.append(("default profile (no packs)", []))
    bad = 0
    for label, args in runs:
        r = subprocess.run(["npm", "run", "--silent", "check:agent-vocabulary", "--", *args], capture_output=True, text=True)
        out = (r.stdout + r.stderr).strip()
        print(out)
        print(f"vocabulary {label}: {'pass' if r.returncode == 0 else 'fail (exit %d)' % r.returncode}")
        bad += 1 if r.returncode else 0
    return 1 if bad else 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
