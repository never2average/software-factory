#!/usr/bin/env python3
"""Org #1 of a mold_v1 application: the settings the mold's lib/default-org.ts reads, written on every deploy.

  org_one.py --self-test      offline: where each value comes from, and that nothing is written for a mold without it

WHAT ORG #1 IS. The workspace the operator's own people land in, the backfill target, and the fail-safe while tenancy
is not live. The mold used to hard-code one company's id and hosted domain; it now reads them per deployment:

  DEFAULT_ORG_ID              org #1's workspace id (org_id columns, row-level security, the data room's orgs/<id>/)
  DEFAULT_ORG_DOMAIN          org #1's Google Workspace hosted domain (its people resolve to org #1, not a new workspace)
  WORKSPACE_OPERATOR_COMPANY  the employer the mold's operator:* scripts record for the person running them

and falls back to neutral placeholders when they are unset. An application whose data was written under an id must be
given that id on every deploy, or its people and files are stranded under the old one; so these are written from state
on every deploy, like the ENABLE_* flags, never left to whatever the project last held.

WHERE THE VALUES COME FROM, first answer wins, each name on its own:
  1. the application's infrastructure.json runtime_env, by the mold's name (an app with an org #1 of its own);
  2. this machine's state/factory.local.json "org_one": {"id": .., "domain": .., "company": ..} (never committed: it
     names the operator's organisation; state/factory.local.example.json shows the shape).
A name with no value anywhere is not written, and the mold's placeholder applies.

Only for a mold that reads them (its lib/default-org.ts names DEFAULT_ORG_ID): for any other mold, nothing.
Standard library only.
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
from factory_local import load_factory, ROOT_STATE  # noqa: E402

MOLD_READS = os.path.join("lib", "default-org.ts")
# {the mold's name: the key under factory.local.json "org_one"}
NAMES = {"DEFAULT_ORG_ID": "id", "DEFAULT_ORG_DOMAIN": "domain", "WORKSPACE_OPERATOR_COMPANY": "company"}
# The names the agent API reads too (the operator tooling's company is read only by the operator scripts, which run
# with the web door's environment).
API_NAMES = ("DEFAULT_ORG_ID", "DEFAULT_ORG_DOMAIN")


def mold_reads(codebase):
    """True when this mold's code reads org #1 from the environment."""
    try: return "DEFAULT_ORG_ID" in open(os.path.join(codebase, MOLD_READS)).read()
    except OSError: return False


def env_pairs(infra, codebase, state_dir=None):
    """{name: value} for the app's web door (and, by API_NAMES, its agent API) on every deploy. {} for a mold that does
    not read them; a name is absent when nothing names a value for it (an env value cannot be empty)."""
    if not mold_reads(codebase): return {}
    local = (load_factory(state_dir or ROOT_STATE).get("org_one") or {})
    local = local if isinstance(local, dict) else {}
    rt = (infra or {}).get("runtime_env") or {}
    out = {}
    for name, key in NAMES.items():
        v = rt.get(name)
        if not (isinstance(v, str) and v.strip()): v = local.get(key)
        if isinstance(v, str) and v.strip(): out[name] = v.strip()
    return out


def api_pairs(pairs):
    """The part of env_pairs the agent API project gets."""
    return {k: v for k, v in pairs.items() if k in API_NAMES}


def self_test(check=None):
    import json, tempfile
    fails = []
    def ok(name, cond, detail=""):
        if check: return check(name, cond, detail)
        print(("ok   " if cond else "FAIL ") + name + ("" if cond or not detail else f"  {detail}"))
        if not cond: fails.append(name)
    with tempfile.TemporaryDirectory() as d:
        state = os.path.join(d, "state"); mold = os.path.join(d, "mold"); old = os.path.join(d, "old")
        for p in (state, os.path.join(mold, "lib"), os.path.join(old, "lib")): os.makedirs(p)
        open(os.path.join(mold, MOLD_READS), "w").write('export const DEFAULT_ORG: string = process.env.DEFAULT_ORG_ID?.trim() || BUILT_IN_ORG;\n')
        open(os.path.join(old, "lib", "org-context.ts"), "w").write('export const DEFAULT_ORG = "org-example";\n')
        json.dump({"molds": []}, open(os.path.join(state, "factory.json"), "w"))
        saved = os.environ.pop("FACTORY_LOCAL", None)
        try:
            ok("org_one: nothing named anywhere, nothing written (the mold's placeholder applies)", env_pairs({}, mold, state) == {})
            json.dump({"org_one": {"id": "org-example", "domain": "example.com", "company": "Example Co"}}, open(os.path.join(state, "factory.local.json"), "w"))
            got = env_pairs({}, mold, state)
            ok("org_one: this machine's factory.local.json org_one names all three",
               got == {"DEFAULT_ORG_ID": "org-example", "DEFAULT_ORG_DOMAIN": "example.com", "WORKSPACE_OPERATOR_COMPANY": "Example Co"}, got)
            ok("  ...the agent API gets the id and the domain, not the operator tooling's company",
               api_pairs(got) == {"DEFAULT_ORG_ID": "org-example", "DEFAULT_ORG_DOMAIN": "example.com"}, api_pairs(got))
            got = env_pairs({"runtime_env": {"DEFAULT_ORG_ID": " org-other ", "DEFAULT_ORG_DOMAIN": ""}}, mold, state)
            ok("  ...an app's own runtime_env wins, name by name (trimmed; an empty one does not count)",
               got == {"DEFAULT_ORG_ID": "org-other", "DEFAULT_ORG_DOMAIN": "example.com", "WORKSPACE_OPERATOR_COMPANY": "Example Co"}, got)
            ok("  ...and a mold that does not read them gets nothing", env_pairs({}, old, state) == {} and env_pairs({}, os.path.join(d, "none"), state) == {})
            json.dump({"org_one": "org-example"}, open(os.path.join(state, "factory.local.json"), "w"))
            ok("  ...an org_one that is not an object names nothing", env_pairs({}, mold, state) == {})
        finally:
            if saved is not None: os.environ["FACTORY_LOCAL"] = saved
    return 1 if fails else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]: sys.exit(self_test())
    print(__doc__); sys.exit(2)
