#!/usr/bin/env python3
"""Fake service CLIs for the rehearsal: vercel, ssh, gh, git, npm.

The harness copies this file to <rehearsal>/bin/shim.py and links each name to it, then puts <rehearsal>/bin first
on PATH. Each call is logged to <rehearsal>/calls.jsonl and answered plausibly. Nothing leaves the machine: secret
values are kept only as a 12-character hash, deployments get an address under .rehearsal.invalid (a name that can
never resolve), ssh never connects, gh and npm never publish. `git` is the real git (so a local repository works),
with every call logged; pushes go to a local bare repository the harness made.
"""
import hashlib, json, os, sys, datetime

BIN = os.path.dirname(os.path.abspath(__file__))
REH = os.path.dirname(BIN)
NAME = os.path.basename(sys.argv[0])
ARGS = sys.argv[1:]


def log(**extra):
    rec = {"t": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tool": NAME, "argv": ARGS,
           "parent": os.environ.get("REHEARSAL_PARENT", "agent")}
    rec.update(extra)
    with open(os.path.join(REH, "calls.jsonl"), "a") as f: f.write(json.dumps(rec) + "\n")


def opt(k):
    return ARGS[ARGS.index(k) + 1] if k in ARGS and ARGS.index(k) + 1 < len(ARGS) else None


def store_path(p): return os.path.join(REH, "vercel", "projects", p + ".json")


def store(p):
    sp = store_path(p)
    return json.load(open(sp)) if os.path.exists(sp) else {"env": {}, "deployments": [], "framework": None}


def save(p, d):
    os.makedirs(os.path.dirname(store_path(p)), exist_ok=True)
    json.dump(d, open(store_path(p), "w"), indent=2)


def projects():
    d = os.path.join(REH, "vercel", "projects")
    return sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json")) if os.path.isdir(d) else []


def vercel():
    cmd = ARGS[0] if ARGS else ""
    proj = opt("--project") or opt("--scope-project")
    if cmd == "whoami": log(); print("rehearsal-team"); return 0
    if cmd in ("ls", "list", "project", "projects"):
        log(); [print(p) for p in projects()]; return 0
    if cmd == "env":
        sub = ARGS[1] if len(ARGS) > 1 else "ls"
        if not proj: log(); print("Error: Your codebase isn't linked to a project on Vercel. Run `vercel link` to begin.", file=sys.stderr); return 1
        st = store(proj)
        if sub in ("ls", "list"):
            log(); print(f"> Environment Variables found for rehearsal-team/{proj}")
            for n in sorted(st["env"]): print(f"  {n:32} Encrypted   Production")
            return 0
        if sub == "add" and len(ARGS) > 2:
            value = sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else ""
            if not value: log(secret_written=False); print("Error: no value given", file=sys.stderr); return 1
            st["env"][ARGS[2]] = {"sha": hashlib.sha256(value.encode()).hexdigest()[:12]}
            save(proj, st); log(secret_written=True, name=ARGS[2]); print(f"Added Environment Variable {ARGS[2]} to Project {proj}"); return 0
        if sub in ("rm", "remove") and len(ARGS) > 2:
            st["env"].pop(ARGS[2], None); save(proj, st); log(); print(f"Removed Environment Variable {ARGS[2]}"); return 0
        if sub == "pull":
            log(); print("Error: rehearsal: values are never pulled to disk", file=sys.stderr); return 1
    if cmd == "deploy" or (cmd.startswith("--") and "--prod" in ARGS):
        if not proj: log(); print("Error: Your codebase isn't linked to a project on Vercel. Run `vercel link` to begin.", file=sys.stderr); return 1
        st = store(proj); fw = opt("--framework") or "nextjs"; n = len(st["deployments"]) + 1
        print(f"Vercel CLI 99.0.0 (rehearsal)\nDeploying rehearsal-team/{proj}\nBuilding: Running \"npm run build\"")
        if fw != "nextjs":
            print(f"Building: Detected framework preset: {fw}")
            print("Building: ✓ Compiled successfully\nBuilding: Build Completed in /vercel/output [41s]", flush=True)
            print('Error: No Output Directory named "public" found after the Build completed. Configure the Output Directory '
                  'in your Project Settings. Alternatively, configure vercel.json#outputDirectory.', file=sys.stderr)
            st["deployments"].append({"n": n, "state": "ERROR", "framework": fw}); save(proj, st); log(result="error"); return 1
        url = f"https://{proj}.rehearsal.invalid"
        print("Building: Detected Next.js version: 16.0.0\nBuilding: ✓ Compiled successfully")
        print(url)
        st["deployments"].append({"n": n, "state": "READY", "framework": fw, "url": url}); st["framework"] = fw
        save(proj, st); log(result="ready"); return 0
    if cmd in ("logs", "inspect"):
        log(); print("rehearsal: read the deploy log the factory wrote, state/application/<app_id>/deploy-log.txt"); return 0
    log(); print(f"rehearsal vercel: `{' '.join(ARGS)}` is not simulated", file=sys.stderr); return 1


def ssh():
    log(); host = next((a for a in ARGS if not a.startswith("-")), "the server")
    print(f"ssh: connect to host {host} port 22: Connection refused (rehearsal: no server is reachable)", file=sys.stderr); return 255


def gh():
    log()
    if ARGS[:2] == ["auth", "status"]: print("github.com\n  ✓ Logged in to github.com account rehearsal-user (keyring)"); return 0
    print(f"rehearsal gh: `{' '.join(ARGS)}` was logged; nothing was sent to GitHub"); return 0


def npm():
    log()
    if ARGS[:1] == ["whoami"]: print("npm error code ENEEDAUTH", file=sys.stderr); return 1
    if ARGS[:1] == ["publish"]: print("npm error code ENEEDAUTH (rehearsal: nothing is published)", file=sys.stderr); return 1
    print(f"rehearsal npm: `{' '.join(ARGS)}` is not simulated", file=sys.stderr); return 1


def git():
    force = "push" in ARGS and any(a in ("-f", "--force", "--force-with-lease") or a.startswith("--force") or a.startswith("+") for a in ARGS)
    log(force_push=force) if "push" in ARGS or "reset" in ARGS else None
    real = open(os.path.join(REH, "real_git")).read().strip()
    os.execv(real, [real] + ARGS)


if __name__ == "__main__":
    sys.exit({"vercel": vercel, "ssh": ssh, "gh": gh, "npm": npm, "git": git}.get(NAME, lambda: (log(), 1)[1])())
