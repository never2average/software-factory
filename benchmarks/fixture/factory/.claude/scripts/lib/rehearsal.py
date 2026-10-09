"""Shared helpers for the REHEARSAL copy of the factory (benchmarks/fixture).

Nothing here talks to a real service. The fake Vercel, server and GitHub live in the rehearsal directory of
this factory copy ($REHEARSAL_DIR, default .rehearsal/ at the root; git-ignored, and never scored as a change): a call log, a secret store that keeps only a short hash
of each value, and the shims under bin/. Every script logs its own invocation so the benchmark can score what the
agent actually did.
"""
import datetime, hashlib, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
REH = os.environ.get("REHEARSAL_DIR") or os.path.join(ROOT, ".rehearsal")
S = os.path.join(ROOT, ".claude", "scripts")


def now():
    fixed = os.environ.get("REHEARSAL_NOW")
    return fixed or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(p):
    with open(p) as f:
        return json.load(f)


def save(p, d):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")


def adir(app):
    return os.path.join(ROOT, "state", "application", app)


def docs(app):
    out = []
    for n in ("application", "infrastructure"):
        p = os.path.join(adir(app), n + ".json")
        out.append(load(p) if os.path.exists(p) else None)
    return out


def log_call(tool, argv, **extra):
    """One line per invocation: which tool, its arguments, and who called it (the agent, or another script)."""
    os.makedirs(REH, exist_ok=True)
    rec = {"t": now(), "tool": tool, "argv": list(argv), "parent": os.environ.get("REHEARSAL_PARENT", "agent")}
    rec.update(extra)
    with open(os.path.join(REH, "calls.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")


def child_env(parent):
    e = dict(os.environ)
    e["REHEARSAL_PARENT"] = parent
    e["REHEARSAL_DIR"] = REH
    return e


def shim(name):
    """The fake service CLI. Scripts never look a service CLI up on PATH, so a real one can never be reached."""
    return os.path.join(REH, "bin", name)


# ---- the fake secret store: names and a short hash, never a value --------------------------------------------

def _store_path(project):
    return os.path.join(REH, "vercel", "projects", project + ".json")


def store(project):
    p = _store_path(project)
    return load(p) if os.path.exists(p) else {"env": {}, "deployments": [], "framework": None}


def save_store(project, d):
    save(_store_path(project), d)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)
