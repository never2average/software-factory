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
    """One row per product. A mold can carry several (same codebase, different brand), and they share
    that mold's backlog, so the task counts repeat across its products."""
    print(f"{'mold':9} {'product':26} {'stage':14} {'apps':>4} {'todo':>4} {'wip':>4} {'done':>4}")
    for m in molds():
        ts = read_tasks(m); c = lambda s: sum(1 for t in ts if t["status"] == s)
        ps = [p for p in products()["products"] if p["mold_id"] == m] or [{}]
        for p in ps:
            print(f"{m:9} {p.get('product_id','-'):26} {p.get('stage','-'):14} "
                  f"{len(p.get('app_ids', [])):>4} {c('todo'):>4} {c('in_progress'):>4} {c('done'):>4}")

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
TYPES = {"string": str, "boolean": bool, "integer": int, "number": (int, float), "array": list, "object": dict}
def _check(obj, schema, where):
    """Recursive subset of JSON Schema: type, required, properties, additionalProperties, items, enum, const, pattern."""
    errs = []
    t = schema.get("type"); ts = [x for x in (t if isinstance(t, list) else [t]) if x in TYPES] if t else []
    if ts:
        ok = any(isinstance(obj, TYPES[x]) and not (x in ("integer", "number") and isinstance(obj, bool)) for x in ts) or ("null" in (t if isinstance(t, list) else [t]) and obj is None)
        if not ok: return [f"{where}: expected {'/'.join(map(str, t if isinstance(t, list) else [t]))}, got {type(obj).__name__}"]
    if "enum" in schema and obj not in schema["enum"]: errs.append(f"{where}: {obj!r} not in {schema['enum']}")
    if "const" in schema and obj != schema["const"]: errs.append(f"{where}: {obj!r} != {schema['const']!r}")
    if "pattern" in schema and isinstance(obj, str) and not re.match(schema["pattern"], obj): errs.append(f"{where}: {obj!r} fails pattern")
    if isinstance(obj, dict):
        for r in schema.get("required", []):
            if r not in obj: errs.append(f"{where}: missing {r}")
        props = schema.get("properties", {})
        for k, v in obj.items():
            if k == "$schema": continue
            if k in props: errs += _check(v, props[k], f"{where}.{k}")
            elif schema.get("additionalProperties") is False: errs.append(f"{where}.{k}: not allowed")
            elif isinstance(schema.get("additionalProperties"), dict): errs += _check(v, schema["additionalProperties"], f"{where}.{k}")
    if isinstance(obj, list) and isinstance(schema.get("items"), dict):
        for i, x in enumerate(obj): errs += _check(x, schema["items"], f"{where}[{i}]")
    return errs
# An app that says it is deployed is making its claims in the present tense.
DEPLOYED = ("stamped", "testing", "serviceable")
def _rls_claim(app_id, docs):
    """`"rls": "fail_closed"` used to be a string literal that nothing in the factory ever read: intake
    stamped it into every app regardless of provider, scope or tenancy, validate checked it against a
    JSON-schema enum, and the deployed app meanwhile reported `role postgres — WARNING: BYPASSRLS`.
    A value that cannot be false is not a claim, it is decoration.

    So an app that says it is deployed must carry the evidence beside the claim. The evidence is
    written only by a live measurement (provision.py --verify-db / --verify-rls / --deploy, clone.py),
    never by hand, and this compares the two: same mode, a non-superuser non-BYPASSRLS role, zero
    unprotected org-scoped tables, zero foreign rows readable, and a cross-workspace write that
    Postgres refused with 42501. `rls: off` asks for nothing and is asked nothing."""
    ds = docs.get("datastores") or {}; st = (docs.get("application") or {}).get("status")
    pg = ds.get("postgres", {}); want = pg.get("rls"); ev = pg.get("rls_verified") or {}
    if want in (None, "off") or st not in DEPLOYED: return []
    w = f"{app_id}/datastores.json: postgres.rls is {want!r}"
    fix = f"Run: python3 .claude/scripts/provision.py {app_id} --verify-rls"
    if not ev or str(ev.get("source", "")).startswith("not verified"):
        return [f"{w} on a {st} app but nothing has measured it" + (f" ({ev.get('source')})" if ev else "") + f". {fix}"]
    out = []
    if ev.get("mode") != want: out.append(f"{w} but the evidence records mode {ev.get('mode')!r}. {fix}")
    if ev.get("bypassrls") is not False or ev.get("superuser") is not False:
        out.append(f"{w} but it was measured as role {ev.get('role')!r} with superuser={ev.get('superuser')} "
                   f"bypassrls={ev.get('bypassrls')} — either one ignores every policy. {fix}")
    if ev.get("unprotected"): out.append(f"{w} but {len(ev['unprotected'])} of {ev.get('org_scoped_tables')} org-scoped "
                                         f"tables had no enforced policy: {', '.join(ev['unprotected'][:6])}. {fix}")
    if ev.get("foreign_rows_readable"): out.append(f"{w} but {ev['foreign_rows_readable']} row(s) of another workspace "
                                                   f"were readable from {ev.get('probe_table')}. {fix}")
    if ev.get("cross_org_write") != "42501": out.append(f"{w} but a cross-workspace INSERT was not refused by RLS "
                                                        f"(got {ev.get('cross_org_write')!r}, expected 42501). {fix}")
    if want == "fail_closed" and ev.get("unset_org_rows"): out.append(f"{w} but with no workspace in scope "
        f"{ev.get('probe_table')} still returned {ev['unset_org_rows']} row(s) — that is failing OPEN. {fix}")
    return out

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
        docs = {}
        for name in ["application","infrastructure","datastores","datainfra"]:
            f = os.path.join(appdir, app, f"{name}.json")
            if os.path.exists(f):
                docs[name] = load(f); errs += _check(docs[name], load(os.path.join(appdir,"app_id",f"{name}.schema.json")), f"{app}/{name}.json")
            else: errs.append(f"{app}: missing {name}.json")
        errs += _rls_claim(app, docs)
    for e in errs: print(e)
    print("ok" if not errs else f"{len(errs)} problem(s)"); sys.exit(1 if errs else 0)
if __name__ == "__main__":
    cmds = {"status":cmd_status,"tasks":cmd_tasks,"next":cmd_next,"add":cmd_add,"set":cmd_set,"close":cmd_close,"validate":cmd_validate}
    if len(sys.argv)<2 or sys.argv[1] not in cmds: sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2:])
