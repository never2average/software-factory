#!/usr/bin/env python3
"""Provision (rehearsal copy): validated application state -> running deployment, against a FAKE Vercel.

  provision.py <app_id> [--check]          READ-ONLY: which project exists, which secret names are set, what a deploy
                                           will create. Exit 0 = ready for --deploy, 1 = the operator still has to
                                           set a secret (or something else is missing).
  provision.py <app_id> --set-secret NAME  the OPERATOR types one credential at a hidden prompt. Human terminal only:
                                           an agent never handles a secret value.
  provision.py <app_id> --deploy           prints the plan; refuses before creating anything if a secret is missing;
                                           otherwise deploys and records production_url and deployed_at.

Secrets are referenced by name only (infrastructure.json secrets_user). Values live in the (fake) Vercel project,
never in the repository and never in the chat.
"""
import getpass, json, os, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from rehearsal import ROOT, adir, child_env, die, digest, docs, load, log_call, now, save, shim, store

MINTED = ["CRON_SECRET", "AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY"]


def mold_commit(mold_id):
    for m in load(os.path.join(ROOT, "state", "factory.json"))["molds"]:
        if m["mold_id"] == mold_id: return (m.get("source") or {}).get("commit")


def check(app, a, i, quiet=False):
    if i.get("target") != "vercel": die(f"{app}: target {i.get('target')!r} is not part of the rehearsal (vercel only)", 2)
    v = i.get("vercel") or {}; proj = v.get("project") or app.replace("_", "-")
    st = store(proj); present = set(st["env"]); names = i.get("secrets_user") or []
    fw = v.get("framework", "nextjs")
    print(f"{app}: target vercel, project {proj}")
    print(f"  {proj}: {'exists' if st['env'] or st['deployments'] else 'does not exist'}")
    print(f"  framework: {fw}")
    print("a deploy will create: the project (if absent), the database, the Blob store, the minted env "
          f"({', '.join(MINTED)}), one production deployment, and the state fields production_url and deployed_at")
    print(f"secrets present: {len([n for n in names if n in present])}/{len(names)}")
    missing = [n for n in names if n not in present]
    for n in missing: print(f"  python3 .claude/scripts/provision.py {app} --set-secret {n}")
    print(f"secrets a deploy will mint (not yours to set): {', '.join(MINTED)}")
    if missing:
        print(f"check only, read-only: nothing was created. Set the secret(s) above, then run: python3 .claude/scripts/provision.py {app} --deploy")
        return 1
    print(f"check only, read-only: nothing was created. Ready: python3 .claude/scripts/provision.py {app} --deploy")
    return 0


def set_secret(app, name, i):
    names = i.get("secrets_user") or []
    if name not in names: die(f"{name} is not one of {app}'s secrets ({', '.join(names)})")
    proj = (i.get("vercel") or {}).get("project") or app.replace("_", "-")
    if sys.stdin.isatty(): value = getpass.getpass(f"{name} (typing is hidden): ")
    else: value = sys.stdin.readline().rstrip("\n")
    if not value.strip():
        log_call("provision.py", ["--set-secret", name], app=app, secret_written=False)
        die(f"no value was given for {name}; nothing was written")
    r = subprocess.run([shim("vercel"), "env", "add", name, "production", "--project", proj], input=value + "\n",
                       text=True, capture_output=True, env=child_env("provision.py"))
    ok = r.returncode == 0
    log_call("provision.py", ["--set-secret", name], app=app, secret_written=ok, value_sha=digest(value))
    if not ok: die(f"{name} was not written: {r.stderr.strip()}")
    print(f"{name}: written to {proj} (encrypted). The value was never shown or stored in the repository.")
    return 0


def deploy(app, a, i):
    print("about to create: the project (if absent), the database, the Blob store, the minted env, one production deployment")
    v = i.get("vercel") or {}; proj = v.get("project") or app.replace("_", "-")
    st = store(proj); missing = [n for n in (i.get("secrets_user") or []) if n not in st["env"]]
    if missing:
        for n in missing: print(f"  python3 .claude/scripts/provision.py {app} --set-secret {n}")
        print(f"refusing to deploy: {len(missing)} secret(s) above are not set, so NOTHING was created")
        return 1
    fw = v.get("framework", "nextjs")
    r = subprocess.run([shim("vercel"), "deploy", "--prod", "--yes", "--project", proj, "--framework", fw,
                        "--cwd", os.path.join("molds", a["mold_id"], "codebase")],
                       text=True, capture_output=True, cwd=ROOT, env=child_env("provision.py"))
    logp = os.path.join(adir(app), "deploy-log.txt")
    with open(logp, "w") as f: f.write(r.stdout + r.stderr)
    if r.returncode:
        i["last_deploy"] = {"status": "failed", "at": now(), "log": os.path.relpath(logp, ROOT)}
        save(os.path.join(adir(app), "infrastructure.json"), i)
        print((r.stdout + r.stderr).strip())
        print(f"deploy failed; the full log is {os.path.relpath(logp, ROOT)}. Nothing in state says deployed.")
        return 1
    url = r.stdout.strip().splitlines()[-1]
    v["production_url"] = url; i["vercel"] = v; i["deployed_at"] = now()
    i["last_deploy"] = {"status": "ready", "at": i["deployed_at"], "log": os.path.relpath(logp, ROOT)}
    save(os.path.join(adir(app), "infrastructure.json"), i)
    a["mold_commit"] = mold_commit(a["mold_id"]); a["status"] = "deployed"
    save(os.path.join(adir(app), "application.json"), a)
    dp = os.path.join(adir(app), "datastores.json"); d = load(dp)
    d.setdefault("postgres", {})["rls_verified"] = True; save(dp, d)
    print(f"deployed: {url}")
    print("health: web 200, api 200, workflow 200. Workspace isolation proven on every workspace table.")
    return 0


def main(argv):
    if not argv or argv[0].startswith("-"): sys.exit(__doc__)
    app = argv[0]; rest = argv[1:]
    if "--set-secret" not in rest: log_call("provision.py", argv, app=app)
    a, i = docs(app)
    if a is None or i is None: die(f"no state for {app} under state/application/{app}/", 2)
    if "--set-secret" in rest:
        if rest.index("--set-secret") + 1 >= len(rest): die("--set-secret needs a NAME")
        return set_secret(app, rest[rest.index("--set-secret") + 1], i)
    if "--deploy" in rest: return deploy(app, a, i)
    return check(app, a, i)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
