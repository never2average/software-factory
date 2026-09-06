#!/usr/bin/env python3
"""Factory CLI. No dependencies beyond the stdlib.

  factory.py status                      products, stage, open/done task counts per mold
  factory.py tasks [mold] [--all]        open tasks (default: todo/in_progress/blocked), priority order
  factory.py next [mold]                 the highest-priority unblocked todo task
  factory.py add <mold> "<title>" --type build [--pri 2] [--owner fable] [--lane x] [--dep id ...]
  factory.py set <task_id> <field> <value>   e.g. set mold_v1-001 status done
  factory.py close <task_id> "<evidence>"    marks done and appends evidence; bumps product stage if advances_stage
  factory.py validate                    every state/*.json[l] file checks its required fields + enums
"""
import json, sys, os, datetime, re
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state")
TODAY = datetime.date.today().isoformat()
def load(p):
    with open(p) as f: return json.load(f)
def tasks_path(m): return os.path.join(ST, "tasks", f"{m}.jsonl")
def molds(): return [m["mold_id"] for m in load(os.path.join(ST,"factory.json"))["molds"]]
def read_tasks(m):
    p = tasks_path(m)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
def write_tasks(m, ts):
    with open(tasks_path(m), "w") as f:
        for t in ts: f.write(json.dumps(t)+"\n")
def all_tasks(): return {t["task_id"]: t for m in molds() for t in read_tasks(m)}
def blocked_by(t, idx):
    return [d for d in t.get("depends_on", []) if idx.get(d, {}).get("status") != "done"]
def products(): return load(os.path.join(ST,"products.json"))
def cmd_status(a):
    ps = {p["mold_id"]: p for p in products()["products"]}
    print(f"{'mold':9} {'product':26} {'stage':14} {'todo':>4} {'wip':>4} {'done':>4}")
    for m in molds():
        ts = read_tasks(m); c = lambda s: sum(1 for t in ts if t["status"]==s)
        p = ps.get(m, {})
        print(f"{m:9} {p.get('product_id','-'):26} {p.get('stage','-'):14} {c('todo'):>4} {c('in_progress'):>4} {c('done'):>4}")
def cmd_tasks(a):
    ms = [a[0]] if a and not a[0].startswith("--") else molds()
    show_all = "--all" in a; idx = all_tasks()
    for m in ms:
        for t in sorted(read_tasks(m), key=lambda t:(t["priority"], t["task_id"])):
            if not show_all and t["status"] in ("done","dropped"): continue
            b = blocked_by(t, idx); flag = f" [blocked by {','.join(b)}]" if b and t["status"]=="todo" else ""
            print(f"{t['task_id']:13} P{t['priority']} {t['status']:11} {t['owner']:6} {t['type']:10} {t['title']}{flag}")
def cmd_next(a):
    ms = [a[0]] if a else molds(); idx = all_tasks()
    for m in ms:
        c = [t for t in read_tasks(m) if t["status"]=="todo" and not blocked_by(t, idx)]
        if c:
            t = min(c, key=lambda t:(t["priority"], t["task_id"]))
            print(f"{t['task_id']}  {t['title']}"); 
            for x in t.get("acceptance", []): print(f"    accept: {x}")
        else: print(f"{m}: nothing unblocked")
def cmd_add(a):
    m, title = a[0], a[1]; opts = a[2:]
    def opt(k, d=None):
        return opts[opts.index(k)+1] if k in opts else d
    ts = read_tasks(m); n = max([int(t["task_id"].split("-")[1]) for t in ts] + [0]) + 1
    pid = next(p["product_id"] for p in products()["products"] if p["mold_id"]==m)
    t = {"task_id": f"{m}-{n:03d}", "mold_id": m, "product_id": pid, "title": title, "type": opt("--type","build"),
         "status":"todo","priority": int(opt("--pri",2)), "owner": opt("--owner","fable"), "created": TODAY, "updated": TODAY}
    if opt("--lane"): t["lane"] = opt("--lane")
    deps = [opts[i+1] for i,x in enumerate(opts) if x=="--dep"]
    if deps: t["depends_on"] = deps
    ts.append(t); write_tasks(m, ts); print(t["task_id"])
def _find(tid):
    m = tid.rsplit("-",1)[0]; ts = read_tasks(m)
    for t in ts:
        if t["task_id"]==tid: return m, ts, t
    sys.exit(f"no task {tid}")
def cmd_set(a):
    tid, k, v = a[0], a[1], a[2]; m, ts, t = _find(tid)
    t[k] = int(v) if k=="priority" else v; t["updated"] = TODAY; write_tasks(m, ts); print(f"{tid}.{k} = {v}")
def cmd_close(a):
    tid = a[0]; ev = a[1] if len(a)>1 else None; m, ts, t = _find(tid)
    t["status"]="done"; t["updated"]=TODAY
    if ev: t.setdefault("evidence", []).append(ev)
    write_tasks(m, ts); print(f"{tid} done")
    if t.get("advances_stage"):
        P = products(); order = ["defined","stamped","lanes_passing","deployed","released"]
        for p in P["products"]:
            if p["mold_id"]==m and order.index(t["advances_stage"]) > order.index(p["stage"]):
                remaining = [x for x in ts if x.get("advances_stage")==t["advances_stage"] and x["status"]!="done"]
                if not remaining:
                    p["stage"]=t["advances_stage"]; json.dump(P, open(os.path.join(ST,"products.json"),"w"), indent=2)
                    print(f"{p['product_id']} -> {p['stage']}")
                else: print(f"stage {t['advances_stage']} waits on {', '.join(x['task_id'] for x in remaining)}")
def _check(obj, schema, where):
    errs = []
    for r in schema.get("required", []):
        if r not in obj: errs.append(f"{where}: missing {r}")
    for k, v in obj.items():
        ps = schema.get("properties", {}).get(k)
        if not ps: continue
        if "enum" in ps and v not in ps["enum"]: errs.append(f"{where}.{k}: {v!r} not in {ps['enum']}")
        if "pattern" in ps and isinstance(v,str) and not re.match(ps["pattern"], v): errs.append(f"{where}.{k}: {v!r} fails pattern")
        if ps.get("type")=="array" and "enum" in ps.get("items",{}):
            for x in v:
                if x not in ps["items"]["enum"]: errs.append(f"{where}.{k}: {x!r} not in enum")
    return errs
def cmd_validate(a):
    errs = []
    errs += _check(load(os.path.join(ST,"factory.json")), load(os.path.join(ST,"factory.schema.json")), "factory.json")
    ps = load(os.path.join(ST,"products.schema.json"))["properties"]["products"]["items"]
    for p in products()["products"]: errs += _check(p, ps, f"products.json[{p.get('product_id')}]")
    tsch = load(os.path.join(ST,"tasks.schema.json")); idx = all_tasks()
    for m in molds():
        for t in read_tasks(m):
            errs += _check(t, tsch, t.get("task_id","?"))
            for d in t.get("depends_on", []):
                if d not in idx: errs.append(f"{t['task_id']}: depends on unknown {d}")
    appdir = os.path.join(ST,"application")
    for app in os.listdir(appdir):
        if app=="app_id": continue
        for name in ["application","infrastructure","datastores","datainfra"]:
            f = os.path.join(appdir, app, f"{name}.json")
            if os.path.exists(f): errs += _check(load(f), load(os.path.join(appdir,"app_id",f"{name}.schema.json")), f"{app}/{name}.json")
            else: errs.append(f"{app}: missing {name}.json")
    for e in errs: print(e)
    print("ok" if not errs else f"{len(errs)} problem(s)"); sys.exit(1 if errs else 0)
if __name__ == "__main__":
    cmds = {"status":cmd_status,"tasks":cmd_tasks,"next":cmd_next,"add":cmd_add,"set":cmd_set,"close":cmd_close,"validate":cmd_validate}
    if len(sys.argv)<2 or sys.argv[1] not in cmds: sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2:])
