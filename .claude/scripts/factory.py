#!/usr/bin/env python3
"""Factory CLI. No dependencies beyond the stdlib.

  factory.py status                      products, stage, open/done task counts per mold
  factory.py tasks [mold] [--all]        open tasks (default: todo/in_progress/blocked), priority order
  factory.py next [mold]                 the highest-priority unblocked todo task
  factory.py add <mold> "<title>" --type build [--pri 2] [--owner fable] [--lane x] [--dep id ...]
  factory.py set <task_id> <field> <value>   e.g. set mold_v1-001 status done
  factory.py close <task_id> "<evidence>"    marks done and appends evidence; bumps product stage if advances_stage
  factory.py validate                    every state/*.json[l] file and every molds/*/testing/*/lane.json
                                         checks its required fields + enums
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
def _check(obj, schema, where, root=None):
    """Recursive subset of JSON Schema: type, required, properties, additionalProperties, items, enum, const,
    pattern, and $ref when the whole document is passed as `root` (lane.schema.json names one $def twice, and
    factory.schema.json refs its mold $def — an unresolved $ref used to mean that subtree went UNCHECKED,
    which is the same permissive default as grading an unmeasured row `pass`)."""
    errs = []
    if root is not None and isinstance(schema, dict) and "$ref" in schema:
        n = root
        try:
            for k in schema["$ref"].split("/")[1:]: n = n[k]
        except (KeyError, TypeError, IndexError):
            return [f"{where}: schema $ref {schema['$ref']!r} does not resolve"]
        return _check(obj, n, where, root)
    t = schema.get("type"); ts = [x for x in (t if isinstance(t, list) else [t]) if x in TYPES] if t else []
    if ts:
        ok = any(isinstance(obj, TYPES[x]) and not (x in ("integer", "number") and isinstance(obj, bool)) for x in ts) or ("null" in (t if isinstance(t, list) else [t]) and obj is None)
        if not ok: return [f"{where}: expected {'/'.join(map(str, t if isinstance(t, list) else [t]))}, got {type(obj).__name__}"]
    if "enum" in schema and obj not in schema["enum"]: errs.append(f"{where}: {obj!r} not in {schema['enum']}")
    if "const" in schema and obj != schema["const"]: errs.append(f"{where}: {obj!r} != {schema['const']!r}")
    if "pattern" in schema and isinstance(obj, str) and not re.match(schema["pattern"], obj):
        # A timestamp's pattern is the offset rule _ts enforces; say that, not "fails pattern" (HARD RULE 4).
        errs.append(f"{where}: {obj!r} is not {TS_FORM}" if schema.get("format") == "date-time" else f"{where}: {obj!r} fails pattern")
    if isinstance(obj, dict):
        for r in schema.get("required", []):
            if r not in obj: errs.append(f"{where}: missing {r}")
        props = schema.get("properties", {})
        for k, v in obj.items():
            if k == "$schema": continue
            if k in props: errs += _check(v, props[k], f"{where}.{k}", root)
            elif schema.get("additionalProperties") is False: errs.append(f"{where}.{k}: not allowed")
            elif isinstance(schema.get("additionalProperties"), dict): errs += _check(v, schema["additionalProperties"], f"{where}.{k}", root)
    if isinstance(obj, list) and isinstance(schema.get("items"), dict):
        for i, x in enumerate(obj): errs += _check(x, schema["items"], f"{where}[{i}]", root)
    return errs
TS_FORM = "a date-time with an explicit UTC offset (e.g. 2026-09-09T14:03:27+00:00)"
def _ts(s):
    """RFC 3339 date-time WITH offset -> an aware datetime, or None if it cannot be ordered.

    These used to be compared as raw strings, which is only correct while every writer uses the same
    offset: "2026-09-09T01:00:00+09:00" sorts AFTER "2026-09-08T18:00:00+00:00" as text and is the
    EARLIER instant. Unparseable returns None and is reported by the caller, never silently skipped —
    a comparison that cannot run is not a comparison that passed.

    NO OFFSET IS NOT UTC. This used to read "2026-09-06T00:00:00" as midnight UTC "because every
    timestamp this factory writes is UTC" — but a value this factory wrote carries its offset (NOW is
    timezone-aware), so an offset-less one was written by something else, and guessing its zone is
    a guess of up to 14 hours in either direction on a comparison that decides whether a proof
    predates a deploy. The schema pattern already refused it for deployed_at; the reader now refuses
    it for every timestamp it orders, so the two agree (mold_v1-048). A bare date parses as a naive
    midnight and is refused by the same rule."""
    try: d = datetime.datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    except ValueError: return None
    return d if d.tzinfo else None
# An app that says it is deployed is making its claims in the present tense.
DEPLOYED = ("stamped", "testing", "serviceable")
# The only statuses a vm app can honestly hold. `stamping` and every DEPLOYED status are written by
# provision.py --deploy alone, which refuses a vm app before it writes anything (VM_NOT_A_DEPLOY_TARGET).
VM_STATUSES = ("planned", "reverted", "retired")
def _vm_status(app_id, docs):
    """A `target: vm` app never serves traffic, so it can never be in a status that says it does.

    The vm lane is LOCAL VERIFICATION (provision.py's header, infra/vm/README.md): --verify-db brings up
    a private Postgres, runs the mold's schema chain and proves app_rw cannot read another workspace,
    and the lane ENDS there — no web build, no API, no workflow service is ever started, so no process
    holds DATABASE_URL in front of anyone. Nothing in this factory advances a vm app past `planned`
    (intake writes planned, lanes.py writes only reverted, --deploy refuses vm before it touches status).

    So a vm app in a DEPLOYED status got there by hand, and the honest reading is not "audit its
    evidence" — every evidence field it could carry is about a database, and the one field the gate
    needs, running_app, is about a serving process that does not exist. --verify-db records it
    `unmeasured` by construction, _rls_claim fails `unmeasured` on every DEPLOYED status, and the
    instruction it prints (--verify-rls) re-records `unmeasured`: a red line no command could clear
    (mold_v1-047). The two alternatives were both refused: exempting vm apps from the running_app
    gate is a permissive default, and calling the app_rw isolation proof "the health reading" would
    grade a credential as a process. The status itself is the error, and this says so in one sentence."""
    st = (docs.get("application") or {}).get("status")
    if (docs.get("infrastructure") or {}).get("target") != "vm" or st in VM_STATUSES or st is None: return []
    return [f"{app_id}/application.json: status is {st!r} but infrastructure.target is 'vm', which never serves "
            f"traffic (provision.py --deploy refuses it, so nothing in this factory writes that status for a vm "
            f"app) — set status back to 'planned' in state/application/{app_id}/application.json, or set target "
            f"to 'vercel' and run: python3 .claude/scripts/provision.py {app_id} --deploy"]
def _vm_url(app_id, docs):
    """infrastructure.vm.production_url is REFUSED, not merely dropped from the schema (mold_v1-053).

    Nothing writes it: --deploy refuses a vm app before it starts anything (VM_NO_PROCESS), so a URL in
    that field was typed in and names a server this factory did not deploy. Nothing this factory trusts
    reads it either — _health_rls returns `unmeasured` by construction — but lanes.py still takes it as
    the lane URL when vercel has none, so a stranger's endpoint could be graded as this app. Removing the
    key from the schema alone let it validate silently while the vm object was open; the object is now closed
    (additionalProperties false) AND this names it, and _target_objects closes the other door — the same URL
    typed under `vercel` on a vm app, which lanes.py read first."""
    vm = (docs.get("infrastructure") or {}).get("vm") or {}
    if "production_url" not in vm: return []
    return [f"{app_id}/infrastructure.json: vm.production_url is set, but nothing on the vm lane starts a web process "
            f"(provision.py --deploy refuses target vm), so that URL names a server this factory did not deploy — "
            f"delete the vm.production_url line from state/application/{app_id}/infrastructure.json"]
# The object each target owns; the other must be absent (lane-url.py reads vercel.production_url whatever the target;
# nothing reads vm.production_url any more, so a URL typed under `vercel` on a vm app is the only door left, and this closes it).
TARGET_OBJECT = {"vercel": "vercel", "vm": "vm"}
def _target_objects(app_id, docs):
    """A target=vm app must carry no `vercel` object, a target=vercel app no `vm` object (mold_v1-053).

    _vm_url refuses vm.production_url by name, but nothing tied the `vercel` object to target=vercel: a vm
    app with `"vercel": {"production_url": "http://127.0.0.1:3123"}` validated ok, and the lanes' lane-url.py
    prints vercel.production_url whenever it is set (nothing reads vm.production_url, which the schema
    forbids), so that app was graded against whatever server was typed there — the exact bypass the name-only refusal claimed to close. The schema cannot say
    "vercel only when target is vercel" (this validator has no if/then), so the rule is here, and it is
    the whole object, not just the URL keys: workflow_url, api_url and project all feed provision.py's
    vercel path, and a vm app has no vercel path. The lanes group's dry run wanted a local URL for a vm
    app; the honest home for that is a named field the schema documents and lanes.py reads on purpose,
    never a key that a different target's deploy is supposed to write."""
    infra = docs.get("infrastructure") or {}; target = infra.get("target")
    if target not in TARGET_OBJECT: return []           # an unknown target is already a schema enum error
    other = next(o for t, o in TARGET_OBJECT.items() if t != target)
    if other not in infra: return []
    keys = ", ".join(sorted(infra[other])) if isinstance(infra[other], dict) and infra[other] else "empty"
    if target == "vm":
        return [f"{app_id}/infrastructure.json: target is 'vm' but a vercel object is present ({keys}), and lanes.py grades "
                f"vercel.production_url as this app's URL while nothing on the vm lane deploys one, so whatever server is typed "
                f"there would be graded as this app — delete the whole \"vercel\" object from "
                f"state/application/{app_id}/infrastructure.json, or set target to 'vercel' and run: "
                f"python3 .claude/scripts/provision.py {app_id} --deploy"]
    return [f"{app_id}/infrastructure.json: target is 'vercel' but a vm object is present ({keys}); the vm object describes the "
            f"local-verification host of a vm app, which this app is not, so nothing here reads it and a host typed there is a "
            f"dead claim — delete the whole \"vm\" object from state/application/{app_id}/infrastructure.json, or set target "
            f"to 'vm' if this app is meant for local verification only"]
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
    # A vm app in a DEPLOYED status is reported by _vm_status as exactly that — the status is the error.
    # Every line below would add an instruction (--verify-rls, --deploy) that the vm lane cannot act on,
    # so it says nothing here; this is not an exemption, the app already failed validate one line up.
    if (docs.get("infrastructure") or {}).get("target") == "vm": return []
    w = f"{app_id}/datastores.json: postgres.rls is {want!r}"
    fix = f"Run: python3 .claude/scripts/provision.py {app_id} --verify-rls"
    # --deploy is the ONLY thing that replaces the build in front of traffic.
    redeploy = f"Run: python3 .claude/scripts/provision.py {app_id} --deploy"
    if not ev or str(ev.get("source", "")).startswith("not verified"):
        return [f"{w} on a {st} app but nothing has measured it" + (f" ({ev.get('source')})" if ev else "") + f". {fix}"]
    out = []
    if ev.get("mode") != want: out.append(f"{w} but the evidence records mode {ev.get('mode')!r}. {fix}")
    # A proof against the local self_hosted database is not a proof about a Neon one. provision.py
    # itself tells operators to switch provider when a Vercel deploy cannot reach a private network,
    # and the proof written before that switch would otherwise stand as evidence for the new backend.
    if ev.get("backend") and pg.get("provider") and ev["backend"] != pg["provider"]:
        out.append(f"{w} but the evidence was measured on backend {ev['backend']!r} while postgres.provider is now "
                   f"{pg['provider']!r} — that proof is about a different database. {fix}")
    if ev.get("bypassrls") is not False or ev.get("superuser") is not False:
        out.append(f"{w} but it was measured as role {ev.get('role')!r} with superuser={ev.get('superuser')} "
                   f"bypassrls={ev.get('bypassrls')} — either one ignores every policy. {fix}")
    if ev.get("open_policies"): out.append(f"{w} but {len(ev['open_policies'])} permissive policy/policies do not scope "
        f"by org_id, and Postgres OR's them, so each reopens its whole table: {', '.join(ev['open_policies'][:6])}. {fix}")
    if ev.get("leaking_policies"): out.append(f"{w} but {len(ev['leaking_policies'])} permissive policy/policies were "
        f"EXECUTED and handed over another workspace's rows: {', '.join(ev['leaking_policies'][:4])}. {fix}")
    if ev.get("unmeasured"): out.append(f"{w} but {len(ev['unmeasured'])} org-scoped table(s) were never measured at all: "
        f"{', '.join(ev['unmeasured'][:6])} — an unmeasured table is not an isolated one. {fix}")
    if ev.get("policies_unverified"): out.append(f"{w} but {len(ev['policies_unverified'])} policy/policies could not be "
        f"executed, so nothing measured what they do: {', '.join(ev['policies_unverified'][:4])}. {fix}")
    if ev.get("unprotected"): out.append(f"{w} but {len(ev['unprotected'])} of {ev.get('org_scoped_tables')} org-scoped "
                                         f"tables had no enforced policy: {', '.join(ev['unprotected'][:6])}. {fix}")
    if ev.get("foreign_rows_readable"): out.append(f"{w} but {ev['foreign_rows_readable']} row(s) of another workspace "
                                                   f"were readable from {ev.get('probe_table')}. {fix}")
    if ev.get("cross_org_write") != "42501": out.append(f"{w} but a cross-workspace INSERT was not refused by RLS "
                                                        f"(got {ev.get('cross_org_write')!r}, expected 42501). {fix}")
    if want == "fail_closed" and ev.get("unset_org_rows"): out.append(f"{w} but with no workspace in scope "
        f"{ev.get('probe_table')} still returned {ev['unset_org_rows']} row(s) — that is failing OPEN. {fix}")
    # The stored DATABASE_URL passing the gate and the PROCESS IN FRONT OF TRAFFIC using it are two
    # different facts: a Vercel env change only reaches the app on its next build. provision.py reads
    # /api/ops/health and records the verdict here; validate used to read every other field of the
    # evidence and not this one, so an app whose own record said the live build is not enforcing RLS
    # validated green forever after.
    #
    # AN ENUM, NOT A SENTENCE. running_app was free text and this function prefix-matched the sentence
    # provision.py happened to write ("enforced — ...", "NOT enforced — ...", "UNMEASURED: ..."), so the
    # two files could drift silently: a rewording on the writer's side turned into a validate failure
    # here, and a rewording here into a green light for whatever the writer emitted. The schema
    # (datastores.schema.json: rls_verified.running_app) now fixes the three tokens and their meaning;
    # the sentence lives in running_app_detail and is printed, never parsed. Equality against the one
    # affirmative token is the whole test: `unmeasured` fails because unmeasured is not measured-good,
    # and anything outside the enum is a schema error _check already reported, so it fails too.
    ra = ev.get("running_app"); rd = str(ev.get("running_app_detail") or "").strip()
    rd = f" ({rd[:160]})" if rd else ""
    if ra is None or ra == "":
        out.append(f"{w} and the stored credential was measured, but nothing read the app in front of traffic "
                   f"(rls_verified.running_app is absent) — the running build may still hold an older "
                   f"DATABASE_URL. {fix}")
    elif ra == "not_enforced":
        # A definitive reading of the wrong DATABASE_URL; only a new build replaces it (provision.py says the same).
        out.append(f"{w} but the app SERVING TRAFFIC reports that row-level security is not enforced on "
                   f"/api/ops/health{rd} — the process answering requests holds a credential that ignores every "
                   f"policy. {redeploy}")
    elif ra != "enforced":
        # `unmeasured`, or a spelling the schema rejects. Re-reading the endpoint is the cheaper first step:
        # --verify-rls re-measures and, if it still cannot read it, prints provision.py's own next
        # instruction with the reason (no production URL / deployment protection).
        out.append(f"{w} but nothing usable was read from the app SERVING TRAFFIC (rls_verified.running_app is "
                   f"{ra!r}){rd} — the process answering requests is not known to be enforcing it. {fix}")
    # Evidence is a photograph of one database at one instant, and two ordinary events invalidate it
    # without changing a single field of it: a deploy (the build, and the DATABASE_URL it holds, changed
    # after the measurement) and a snapshot restore (pg_restore --clean drops every policy — clone.py
    # makes the same comparison before it will call a replica isolated).
    at = str(ev.get("at") or ""); atd = _ts(at)
    dep = str((docs.get("infrastructure") or {}).get("deployed_at") or "")
    snap = str((pg.get("snapshot") or {}).get("taken_at") or "")
    if not at:
        out.append(f"{w} but the evidence carries no `at`, so nothing can tell whether it predates the deploy "
                   f"that replaced the database it measured. {fix}")
    elif not atd:
        # _ts refuses a naive time (no offset) as well as garbage. The schema pattern on rls_verified.at
        # now refuses the same spellings (mold_v1-053); this stays so the reader never trusts the schema alone.
        out.append(f"{w} but datastores.postgres.rls_verified.at is {at[:60]!r}, which is not {TS_FORM}, so "
                   f"nothing can order this proof against the deploy or the restore that would invalidate it. {fix}")
    # Only --deploy records a deploy date, and only the vercel lane reaches --deploy; a vm app never gets
    # this far (it returned above, and _vm_status already refused its status).
    if atd and not dep:
        # An app in this state was deployed by something, and an undated deploy cannot be compared: the
        # convenient reading is "then it is not stale", which is how evidence from 2020 passed. --deploy
        # stamps deployed_at, so this instruction resolves it.
        out.append(f"{w} but infrastructure.json records no deployed_at, so nothing can tell whether this proof "
                   f"predates the build serving traffic. {redeploy}")
    elif atd and not _ts(dep):
        # A bare date or an offset-less time is refused here as well as by the schema pattern (mold_v1-048):
        # _ts used to read "2026-09-06T00:00:00" as midnight UTC and pass it, so the reader's guarantee was
        # narrower than the schema's — a state file that skipped the schema check validated on a guess.
        out.append(f"{w} but infrastructure.deployed_at is {dep[:60]!r}, which is not {TS_FORM}, so nothing can "
                   f"order this proof against the deploy to the hour it happened. {redeploy}")
    # Both are instants now (infrastructure.schema.json: deployed_at is a date-time, written from the same
    # UTC clock as rls_verified.at), so this is the exact comparison. It used to be by calendar day, and
    # a redeploy hours after a measurement read fresh; a measurement even one second before the deploy
    # is about the build that was replaced.
    elif atd and atd < _ts(dep):
        out.append(f"{w} but the evidence was measured {at} and this app was deployed {dep} — that proof is about "
                   f"the build before the one serving traffic. {fix}")
    if atd and snap:
        sd = _ts(snap)
        if not sd:
            out.append(f"{w} but datastores.postgres.snapshot.taken_at is {snap[:60]!r}, which is not {TS_FORM}, so "
                       f"nothing can tell whether the restore came after the proof. {fix}")
        elif atd < sd:
            out.append(f"{w} but the evidence was measured {at} and the database was restored from a snapshot taken "
                       f"{snap} — a restore drops every policy the proof measured. {fix}")
    return out

LANE_FIX = "Fix that file, then re-run: python3 .claude/scripts/factory.py validate"
def _lane_specs():
    """Every molds/<mold>/testing/<lane>/lane.json against that mold's lane.schema.json.

    lanes.py validates the declaration too, but only for the five lanes it knows and only at the moment
    someone runs them, exiting 2 — so a lane.json in the wrong folder, a sixth lane folder, or a typo'd
    key sat in the repo looking healthy until a run stopped dead on it. Same _check as every other
    schema in the factory: the schema uses $ref, which is why _check learned to resolve one."""
    errs = []; md = os.path.join(ROOT, "molds")
    for mold in sorted(os.listdir(md) if os.path.isdir(md) else []):
        tdir = os.path.join(md, mold, "testing")
        if not os.path.isdir(tdir): continue
        # A mold may carry its own lane.schema.json; mold_v1's is the fallback, exactly as lanes.py picks it.
        sp = next((x for x in (os.path.join(tdir, "lane.schema.json"),
                               os.path.join(md, "mold_v1", "testing", "lane.schema.json")) if os.path.exists(x)), None)
        for lane in sorted(os.listdir(tdir)):
            f = os.path.join(tdir, lane, "lane.json")
            if not os.path.isfile(f): continue            # no lane.json is legal: that lane is `skipped`, never `pass`
            rel = os.path.relpath(f, ROOT)
            try: spec = load(f)
            except Exception as x: errs.append(f"{rel}: not valid JSON ({x}). {LANE_FIX}"); continue
            if not sp:
                errs.append(f"{rel}: there is no molds/{mold}/testing/lane.schema.json (nor the mold_v1 fallback) "
                            f"to check it against, so nothing knows what this lane declares. Restore that schema, "
                            f"then re-run: python3 .claude/scripts/factory.py validate"); continue
            sch = load(sp); se = _check(spec, sch, rel, sch)
            # One instruction after the machine detail, never a bare type error on its own (HARD RULE 4).
            if se: errs += se + [f"{rel} does not match {os.path.relpath(sp, ROOT)}; the {len(se)} line(s) above "
                                 f"name the key. {LANE_FIX}"]
            if spec.get("lane") != lane:
                errs.append(f"{rel}: declares lane {spec.get('lane')!r} but sits in the {lane}/ folder — lanes.py "
                            f"reads the folder, so this declaration would never run. {LANE_FIX}")
            names = [c.get("name") for c in spec.get("checks", []) if isinstance(c, dict)]
            dup = sorted({str(n) for n in names if names.count(n) > 1})
            if dup: errs.append(f"{rel}: two checks are both named {', '.join(dup)} — one report row would hide "
                                f"the other's result. {LANE_FIX}")
    return errs

def _operator_identity(app_id, docs):
    """workspace.operator_self names who the app was stamped for. Its pre-rename spelling, fde_self, is still
    accepted for one release, so the schema requires neither and this requires exactly one of the two."""
    ws = (docs.get("application") or {}).get("workspace")
    if not isinstance(ws, dict): return []
    have = [k for k in ("operator_self", "fde_self") if k in ws]
    if not have: return [f"{app_id}/application.json.workspace: missing operator_self"]
    if len(have) == 2: return [f"{app_id}/application.json.workspace: carries both operator_self and its legacy name fde_self; keep operator_self only"]
    return []
def _agent_keys(app_id, docs):
    """Which subagents exist differs per application (its mold plus its packs), so the schema only checks the
    key's shape. A key is real only if the app's mold, or one of its packs, has agent/subagents/<key>/agent.ts;
    and every pack the app names must exist."""
    app = docs.get("application") or {}
    mold = app.get("mold_id"); base = os.path.join(ROOT, "molds", str(mold), "codebase", "agent", "subagents")
    subs = (((app.get("surface") or {}).get("primary_context") or {}).get("instructions") or {}).get("subagents") or []
    errs = []; packs = app.get("packs") or []
    for p in packs:
        if not os.path.exists(os.path.join(ROOT, "packs", str(p), "pack.json")):
            errs.append(f"{app_id}/application.json: pack '{p}' does not exist (no packs/{p}/pack.json)")
    def has(k):
        return os.path.exists(os.path.join(base, k, "agent.ts")) or any(
            os.path.exists(os.path.join(ROOT, "packs", str(p), "files", "agent", "subagents", k, "agent.ts")) for p in packs)
    for s in subs:
        k = s.get("agent_key") if isinstance(s, dict) else None
        if k and not has(k):
            errs.append(f"{app_id}/application.json: subagent '{k}' exists neither in {mold} nor in this application's packs "
                        f"({', '.join(packs) or 'none'}), so its instructions would reach nothing")
    return errs
def cmd_validate(a):
    errs = []
    fs = load(os.path.join(ST,"factory.schema.json")); fj = load(os.path.join(ST,"factory.json"))
    errs += _check(fj, fs, "factory.json", fs)
    if any(not isinstance(m, dict) or "mold_id" not in m for m in fj.get("molds", [])):
        # Every audit below walks the mold list. A mold entry with no mold_id used to reach it and raise
        # a KeyError mid-run: a traceback instead of a finding (HARD RULE 4). Report and stop here.
        for e in errs: print(e)
        sys.exit(f"{len(errs)} problem(s). Fix state/factory.json first: every entry under \"molds\" needs a "
                 f"\"mold_id\" before the rest of the factory can be checked.")
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
        errs += _vm_status(app, docs) + _vm_url(app, docs) + _target_objects(app, docs) + _rls_claim(app, docs) + _agent_keys(app, docs) + _operator_identity(app, docs)
    errs += _lane_specs()
    for e in errs: print(e)
    print("ok" if not errs else f"{len(errs)} problem(s)"); sys.exit(1 if errs else 0)
if __name__ == "__main__":
    cmds = {"status":cmd_status,"tasks":cmd_tasks,"next":cmd_next,"add":cmd_add,"set":cmd_set,"close":cmd_close,"validate":cmd_validate}
    if len(sys.argv)<2 or sys.argv[1] not in cmds: sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2:])
