#!/usr/bin/env python3
"""workspace.py <app_id> <org-seed.json> [customers.json]

Create or update ONE workspace on a deployed application and fill it: the workspace row, its members, the
recipe catalog and workflow library, one "on delegation" row per declared subagent (the mold's own
provisionWorkspace, so a pack's subagents are included), the people roster, and its companies.

An application's state describes one workspace; a multi-workspace deployment gets its others here, from
state/application/<app_id>/seed/orgs/<org_id>.json:
  { "org_id", "name", "google_hosted_domain", "owner", "members": [{ "email", "role", "name" }] }
The companies file is the mold's customerStoreSchema ({ "customers": [...] }).

Everything is written through the app role (DATABASE_URL, app_rw) inside the workspace's own scope, so RLS is
in force for every row: a write that would land in another workspace is refused by the database, not by this
script. It runs the application's own modules from build/<app_id>/. The connection string is read from the
project's production environment for the length of the run and is never printed or stored.
"""
import json, os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
def main(a):
    if len(a) < 2: sys.exit(__doc__)
    app_id, seed = a[0], os.path.abspath(a[1]); cust = os.path.abspath(a[2]) if len(a) > 2 else ""
    build = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(os.path.join(build, "agent")): sys.exit(f"no build copy at build/{app_id}; run: python3 .claude/scripts/packs.py apply {app_id}")
    infra = json.load(open(os.path.join(ROOT, "state", "application", app_id, "infrastructure.json")))
    if infra.get("target") != "vercel" or not (infra.get("vercel") or {}).get("production_url"): sys.exit(f"{app_id} is not deployed; deploy it first")
    s = json.load(open(seed))
    s.setdefault("members", [])
    for k in ("org_id", "name", "owner"):
        if not s.get(k): sys.exit(f"{os.path.relpath(seed, ROOT)}: '{k}' is missing")
    if any("password" in m for m in s["members"]): sys.exit("the seed carries a password field; this app has no passwords. Remove it.")
    import clone
    env = clone.pull_env(infra["vercel"]["project"], build)
    url = env.get("DATABASE_URL")
    if not url or url == "[SENSITIVE]": sys.exit("DATABASE_URL could not be read from the project's production environment")
    r = subprocess.run(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
                        os.path.join(ROOT, ".claude/scripts/lib/workspace_seed.mjs"), seed] + ([cust] if cust else []),
                       cwd=build, env=dict(os.environ, DATABASE_URL=url, NODE_ENV="production"), capture_output=True, text=True)
    line = (r.stdout.strip().splitlines() or [""])[-1]
    try: out = json.loads(line)
    except ValueError: print((r.stdout + r.stderr).replace(url, "[redacted]")[-1500:], file=sys.stderr); sys.exit("the workspace seed did not finish")
    print(json.dumps(out, indent=2)); sys.exit(r.returncode)
if __name__ == "__main__": main(sys.argv[1:])
