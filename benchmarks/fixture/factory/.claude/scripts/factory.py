#!/usr/bin/env python3
"""Factory CLI (rehearsal copy). No dependencies beyond the stdlib.

  factory.py status                      products, stage, open/done task counts per mold
  factory.py tasks [mold] [--all]        open tasks (default: todo/in_progress/blocked), priority order
  factory.py next [mold]                 the highest-priority unblocked todo task
  factory.py add <mold> "<title>" --type build [--pri 2] [--owner fable] [--dep id ...] [--accept "<criterion>" ...]
  factory.py set <task_id> <field> <value>   e.g. set mold_v1-001 status done
  factory.py close <task_id> "<evidence>"    marks done and appends evidence
  factory.py validate                    every application's four state files check their required fields
"""
import datetime, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from rehearsal import ROOT, load, log_call

ST = os.path.join(ROOT, "state")
TODAY = datetime.date.today().isoformat()
STATUSES = ["todo", "in_progress", "blocked", "done", "dropped"]


def tasks_path(m): return os.path.join(ST, "tasks", f"{m}.jsonl")
def molds(): return [m["mold_id"] for m in load(os.path.join(ST, "factory.json"))["molds"]]


def read_tasks(m):
    p = tasks_path(m)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []


def write_tasks(m, ts):
    with open(tasks_path(m), "w") as f:
        for t in ts: f.write(json.dumps(t) + "\n")


def all_tasks(): return {t["task_id"]: t for m in molds() for t in read_tasks(m)}
def blocked_by(t, idx): return [d for d in t.get("depends_on", []) if idx.get(d, {}).get("status") != "done"]


def cmd_status(a):
    for p in load(os.path.join(ST, "products.json"))["products"]:
        ts = read_tasks(p["mold_id"])
        done = sum(t["status"] == "done" for t in ts)
        print(f"{p['product_id']:12} {p['mold_id']:8} stage={p['stage']:14} open={len(ts) - done} done={done}")


def cmd_tasks(a):
    ms = [a[0]] if a and not a[0].startswith("--") else molds(); idx = all_tasks()
    for m in ms:
        for t in sorted(read_tasks(m), key=lambda t: (t["priority"], t["task_id"])):
            if "--all" not in a and t["status"] in ("done", "dropped"): continue
            b = blocked_by(t, idx); flag = f" [blocked by {','.join(b)}]" if b and t["status"] == "todo" else ""
            print(f"{t['task_id']:13} P{t['priority']} {t['status']:11} {t['owner']:6} {t['type']:10} {t['title']}{flag}")


def cmd_next(a):
    ms = [a[0]] if a else molds(); idx = all_tasks()
    for m in ms:
        c = [t for t in read_tasks(m) if t["status"] == "todo" and not blocked_by(t, idx)]
        if c:
            t = min(c, key=lambda t: (t["priority"], t["task_id"]))
            print(f"{t['task_id']}  {t['title']}")
            for x in t.get("acceptance", []): print(f"    accept: {x}")
        else:
            print(f"{m}: nothing unblocked")


def cmd_add(a):
    m, title, opts = a[0], a[1], a[2:]
    def opt(k, d=None): return opts[opts.index(k) + 1] if k in opts else d
    ts = read_tasks(m); n = max([int(t["task_id"].split("-")[1]) for t in ts] + [0]) + 1
    t = {"task_id": f"{m}-{n:03d}", "mold_id": m, "title": title, "type": opt("--type", "build"), "status": "todo",
         "priority": int(opt("--pri", 2)), "owner": opt("--owner", "fable"), "created": TODAY, "updated": TODAY,
         "depends_on": [opts[i + 1] for i, x in enumerate(opts) if x == "--dep"],
         "acceptance": [opts[i + 1] for i, x in enumerate(opts) if x == "--accept"]}
    ts.append(t); write_tasks(m, ts); print(f"added {t['task_id']}")


def find(tid):
    m = tid.rsplit("-", 1)[0]; ts = read_tasks(m)
    for t in ts:
        if t["task_id"] == tid: return m, ts, t
    sys.exit(f"no task {tid}")


def cmd_set(a):
    m, ts, t = find(a[0]); field, value = a[1], a[2]
    if field == "status" and value not in STATUSES: sys.exit(f"status must be one of {STATUSES}")
    t[field] = int(value) if field == "priority" else value; t["updated"] = TODAY
    write_tasks(m, ts); print(f"{a[0]} {field}={value}")


def cmd_close(a):
    m, ts, t = find(a[0])
    if len(a) < 2 or not a[1].strip(): sys.exit("close needs evidence: a commit, a report path or a URL")
    t["status"] = "done"; t.setdefault("evidence", []).append(a[1]); t["updated"] = TODAY
    write_tasks(m, ts); print(f"{a[0]} done")


REQUIRED = {"application": ["app_id", "mold_id", "status"], "infrastructure": ["target"],
            "datastores": ["postgres"], "datainfra": ["blob"]}


def cmd_validate(a):
    bad = 0; d = os.path.join(ST, "application")
    for app in sorted(os.listdir(d)):
        if app == "app_id" or not os.path.isdir(os.path.join(d, app)): continue
        for n, req in REQUIRED.items():
            p = os.path.join(d, app, n + ".json")
            if not os.path.exists(p): print(f"✗ {app}/{n}.json missing"); bad += 1; continue
            try: doc = load(p)
            except ValueError as e: print(f"✗ {app}/{n}.json is not JSON: {e}"); bad += 1; continue
            miss = [k for k in req if k not in doc]
            if miss: print(f"✗ {app}/{n}.json missing {', '.join(miss)}"); bad += 1
            text = json.dumps(doc)
            if re.search(r'"(?:re|sk|rk)[-_][A-Za-z0-9_-]{12,}"', text):
                print(f"✗ {app}/{n}.json looks like it holds a secret value; state holds *_ref names only"); bad += 1
    print("valid" if not bad else f"{bad} problem(s)")
    return 1 if bad else 0


def main(a):
    log_call("factory.py", a)
    if not a: sys.exit(__doc__)
    cmds = {"status": cmd_status, "tasks": cmd_tasks, "next": cmd_next, "add": cmd_add, "set": cmd_set,
            "close": cmd_close, "validate": cmd_validate}
    if a[0] not in cmds: sys.exit(__doc__)
    return cmds[a[0]](a[1:]) or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
