"""A temp copy of the factory for a self-test that runs intake.py (or another script) end to end (mold_v0-244).

The copy holds only what the repository tracks, so a self-test reads the same on a fresh clone as on the factory
machine: the scripts, the tracked state files (factory.json, the schemas, products.example.json) and the empty app
template (state/application/app_id/), with the molds and schemas linked read-only. This machine's own files
(state/products.json, state/factory.local.json, the backlog under state/tasks/, the leak check's lists, every real
app under state/application/) are never copied: a self-test that leaned on them passed here and failed everywhere
else, and nobody saw it (intake.py --self-test and lib/brief_pack_selftest.py on main before mold_v0-244).

`FACTORY_LOCAL` for the scripts the self-test runs is the file `tree()` returns: the same neutral values on every
machine (a verified sending domain, mold_v0-101), never this machine's.
"""
import json, os, shutil, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
ST = os.path.join(ROOT, "state")
# This machine's own, git-ignored (.gitignore, mold_v0-198): never part of a self-test's tree.
MACHINE_OWN = ("products.json", "factory.local.json", "leak-denylist.txt", "leak-allowlist.txt")
LOCAL = {"defaults": {"notify_domain": "mail.example.test"}}


def tree(prefix, local=None):
    """Make the temp tree. Returns (T, local_file): the tree's root, and the FACTORY_LOCAL file to run its scripts
    with. The caller removes T (shutil.rmtree) when done."""
    T = tempfile.mkdtemp(prefix=prefix)
    shutil.copytree(os.path.join(ROOT, ".claude", "scripts"), os.path.join(T, ".claude", "scripts"),
                    ignore=shutil.ignore_patterns("__pycache__", "fixtures"))
    os.makedirs(os.path.join(T, "state", "application")); os.makedirs(os.path.join(T, "briefs"))
    for f in os.listdir(ST):
        if os.path.isfile(os.path.join(ST, f)) and f not in MACHINE_OWN: shutil.copy(os.path.join(ST, f), os.path.join(T, "state", f))
    # The repository's factory.json names no workspace (mold_v0-198: it lives in factory.local.json), so the copy
    # gets a neutral one: the self-tests' cases are not about that question.
    fj = os.path.join(T, "state", "factory.json"); f = json.load(open(fj)); f.setdefault("defaults", {}).setdefault("workspace_name", "Acme")
    json.dump(f, open(fj, "w"), indent=2)
    shutil.copytree(os.path.join(ST, "application", "app_id"), os.path.join(T, "state", "application", "app_id"))
    os.symlink(os.path.join(ROOT, "molds"), os.path.join(T, "molds"))
    # factory.py validate also checks the generated app schemas against the molds (app_spec.py stale): linked read-only
    if os.path.isdir(os.path.join(ROOT, "schemas")): os.symlink(os.path.join(ROOT, "schemas"), os.path.join(T, "schemas"))
    lf = os.path.join(T, "factory-local.json"); json.dump(LOCAL if local is None else local, open(lf, "w"), indent=2)
    return T, lf
