#!/usr/bin/env python3
"""Run the five testing lanes against an application and record what actually happened.

  lanes.py <app_id>                        every lane, in order, stopping at the first fail
  lanes.py <app_id> --lane functional      only the named lane(s); repeatable
  lanes.py <app_id> --dry-run              run everything; write NO state, file NO task. Its reports go to
                                           <lane>/reports/dry/ and say DRY RUN, so the evidence archive can
                                           never hold a verdict that state never recorded.
  lanes.py <app_id> --list                 per lane: harness or not, how many checks, which preconditions are unmet

Exit 0 every lane passed or was skipped · 1 a lane failed, and (outside --dry-run) the application is now
`reverted` with a task filed · 2 the runner could not run at all (unknown app, missing state, a malformed
or misnamed lane.json).

A lane declares itself in `molds/<mold_id>/testing/<lane>/lane.json` against `lane.schema.json`, so a new
CHECK, harness or precondition in a future mold never edits this file. A sixth LANE does: `testing` in
application.schema.json has one key per lane, so a result for a lane it does not know has nowhere legal to
live. A lane folder outside the five is therefore announced on stdout, never silently ignored. The rollup is deliberately unfakeable, in this order:

  no lane.json | "checks": [] | a lane-level precondition unmet  -> skipped
  any check failed                                               -> fail
  every check RAN and passed                                     -> pass
  otherwise (>=1 check skipped by a precondition)                -> skipped

`pass` is never printed next to a command that did not execute — that is the exact failure
functional/tenant-isolation.py was written to stop, and it is why `skipped` is the fallback rather
than `pass`. `known_defect` is an annotation, never a mute: the three known mold defects still fail
the functional lane and still revert the app; the flag only links their task ids and stops a duplicate
being filed. This runner is the ONLY writer of `testing.<lane>`; the only status it may write is
`reverted`. Promotion stays with the operator.
"""
import datetime, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory   # _check for lane.json; `add` is SHELLED OUT, never re-implemented (it allocates task ids)
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
TODAY = datetime.date.today().isoformat()
LANES = ["functional", "context", "load", "accessibility", "responsiveness"]   # the contract's order
DEFAULT_ORDER = {n: (i + 1) * 10 for i, n in enumerate(LANES)}
CWDS = ("codebase", "testing", "root")

def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
def die(msg): print(msg); sys.exit(2)

# Nothing captured from a check reaches a report unredacted. A harness may legitimately print a URL
# it was handed; the runner still refuses to be the thing that writes a credential into git.
SECRETS = [(re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@\"']*:[^\s/@\"']*@"), r"\1***:***@"),
           (re.compile(r"(?i)\b(postgres(?:ql)?://)[^\s\"']*@"), r"\1***@"),
           (re.compile(r"(?i)\b(bearer\s+)[^\s\"']+"), r"\1***"),
           (re.compile(r"(?i)([?&](?:token|api[_-]?key|access_token|secret)=)[^&\s\"']+"), r"\1***")]
def redact(s):
    for rx, rep in SECRETS: s = rx.sub(rep, s or "")
    return s

def subst(s, ctx):
    for k, v in ctx.items(): s = s.replace("{" + k + "}", str(v))
    return s

def state_get(docs, path):
    doc, _, rest = path.partition(".")
    cur = docs.get(doc)
    for k in [x for x in rest.split(".") if x]:
        if not isinstance(cur, dict): return None
        cur = cur.get(k)
    return cur

def unmet(p, docs, ctx):
    """None when the precondition holds, otherwise its `else` sentence — which is what the report prints
    under 'what would make them run', so it must name a command the operator can actually type."""
    e = subst(p.get("else", "no reason given"), ctx)
    if "state" in p:
        v = state_get(docs, p["state"])
        if "must" in p: ok = v not in (None, "", [], {}) if p["must"] == "nonempty" else v == p["must"]
        elif "must_not" in p: ok = v != p["must_not"]
        else: ok = v is not None
        return None if ok else e
    if "env" in p: return None if os.environ.get(p["env"]) else e   # presence BY NAME; the value is never read
    if "path" in p: return None if os.path.exists(os.path.join(ROOT, subst(p["path"], ctx))) else e
    if "cmd" in p:
        r = subprocess.run(subst(p["cmd"], ctx), shell=True, cwd=ROOT, capture_output=True, text=True)
        return None if r.returncode == 0 else e
    return e

def run_check(c, docs, ctx):
    res = {"name": c["name"], "defect": c.get("known_defect"), "why": c.get("why", ""),
           "emits": c.get("emits"), "cmd": subst(c["run"], ctx), "out": ""}
    for p in c.get("requires", []):
        e = unmet(p, docs, ctx)
        if e: return dict(res, status="skipped", reason=e)
    cwd = {"codebase": ctx["codebase"], "testing": ctx["testing"], "root": ROOT}[c.get("cwd", "codebase")]
    t = c.get("timeout_s", 600)
    try:
        r = subprocess.run(res["cmd"], shell=True, cwd=cwd, capture_output=True, text=True, timeout=t)
        out, code = redact((r.stdout or "") + (r.stderr or "")), r.returncode
    except subprocess.TimeoutExpired as x:
        got = lambda b: b.decode(errors="replace") if isinstance(b, bytes) else (b or "")
        return dict(res, status="fail", reason=f"timed out after {t}s", out=redact(got(x.stdout) + got(x.stderr)))
    except Exception as x:
        return dict(res, status="fail", reason=f"could not launch `{res['cmd']}`: {x}")
    exp = c.get("expect") or {}; want = exp.get("exit", 0); bad = []
    if code != want: bad.append(f"exit {code}, expected {want}")
    for rx in exp.get("stdout", []):
        if not re.search(rx, out, re.S): bad.append(f"output never matched /{rx}/")
    for rx in exp.get("stdout_not", []):
        if re.search(rx, out, re.S): bad.append(f"output matched the forbidden /{rx}/")
    return dict(res, status="fail" if bad else "pass", reason="; ".join(bad) or f"exit {code}", out=out)

def _deref(s, root):
    """factory._check has no $ref, and lane.schema.json needs one (a precondition appears twice)."""
    if isinstance(s, dict):
        if "$ref" in s:
            n = root
            for k in s["$ref"].lstrip("#/").split("/"): n = n[k]
            return _deref(n, root)
        return {k: _deref(v, root) for k, v in s.items()}
    return [_deref(x, root) for x in s] if isinstance(s, list) else s

def read_spec(lane, mold_id):
    """None = this lane has no harness. Anything present but wrong is a runner error (exit 2), because a
    result for a lane the application schema cannot record has nowhere legal to live."""
    d = os.path.join(ROOT, "molds", mold_id, "testing", lane)
    f = os.path.join(d, "lane.json")
    if not os.path.exists(f): return None
    try: spec = load(f)
    except Exception as x: die(f"{os.path.relpath(f, ROOT)} is not valid JSON: {x}")
    sp = next((p for p in (os.path.join(ROOT, "molds", mold_id, "testing", "lane.schema.json"),
                           os.path.join(ROOT, "molds/mold_v1/testing/lane.schema.json")) if os.path.exists(p)), None)
    if sp:
        sch = load(sp); errs = factory._check(spec, _deref(sch, sch), os.path.relpath(f, ROOT))
        if errs: die("\n".join(errs) + f"\n{os.path.relpath(f, ROOT)} does not match lane.schema.json. Nothing ran.")
    if spec.get("lane") != lane:
        die(f"{os.path.relpath(f, ROOT)} declares lane {spec.get('lane')!r} but sits in the {lane}/ folder. Nothing ran.")
    names = [c["name"] for c in spec.get("checks", [])]
    if len(set(names)) != len(names): die(f"{os.path.relpath(f, ROOT)}: duplicate check names. Nothing ran.")
    return spec

def context(app_id, lane, mold_id, docs, report):
    infra = docs.get("infrastructure") or {}
    url = ((infra.get("vercel") or {}).get("production_url") or (infra.get("vm") or {}).get("production_url") or "").rstrip("/")
    mold = os.path.join(ROOT, "molds", mold_id)
    return {"app_id": app_id, "root": ROOT, "mold": mold, "codebase": os.path.join(mold, "codebase"),
            "testing": os.path.join(mold, "testing"), "lane": lane, "date": TODAY, "url": url, "report": report}

def report_text(lane, app_id, mold_id, commit, spec, status, results, ctx, unmet_lane, not_run, dry=False):
    n = lambda s: sum(1 for r in results if r["status"] == s)
    head = f"{n('pass')} of {len(results)} checks passed" if results else "no harness"
    if n("fail"): head += f", {n('fail')} failed"
    if n("skipped"): head += f", {n('skipped')} skipped"
    L = [f"# {lane.capitalize()} lane — {app_id} ({TODAY})" + (" — DRY RUN" if dry else ""), "",
         f"Mold: {mold_id} (commit {commit}).",
         f"Run at {NOW}. Lane status: **{status}** ({head}).",
         f"Command: `python3 .claude/scripts/lanes.py {app_id} --lane {lane}" + (" --dry-run`" if dry else "`")]
    if dry:
        L += ["", "**DRY RUN — nothing here was recorded.** No `testing." + lane + "` was written to "
              f"`state/application/{app_id}/application.json`, no task was filed, and the application was not "
              "reverted whatever this report says. It lives under `reports/dry/` so it can never be mistaken "
              "for, or overwrite, the report a recorded run points at."]
    if spec and spec.get("summary"): L += ["", spec["summary"]]
    if not_run: L += ["", f"Not run in this run (the lane order stopped here): {', '.join(not_run)}. "
                          "Their recorded results are whatever a previous run left."]
    if unmet_lane:
        L += ["", "## The whole lane was skipped", ""] + [f"- {e}" for e in unmet_lane]
    if not spec:
        L += ["", "## No harness", "",
              f"There is no `molds/{mold_id}/testing/{lane}/lane.json`, so this lane declares no checks and "
              f"is recorded `skipped` — never `pass`. This report is the artefact proving the lane was "
              f"considered. See `molds/{mold_id}/testing/{lane}/README.md` for what it is meant to cover."]
    elif not results and not unmet_lane:
        L += ["", "## No harness", "", f"`lane.json` is present but declares no checks, so the lane is `skipped`."]
    if results:
        L += ["", "## Checks", "", "| check | status | reason | output tail |", "|---|---|---|---|"]
        for r in results:
            tail = " ".join((r["out"] or "").split())[-140:]
            d = f" (known defect {r['defect']})" if r["defect"] else ""
            L.append(f"| `{r['name']}` | {r['status']}{d} | {r['reason'].replace('|', '/')[:220]} | {tail.replace('|', '/')} |")
    fails = [r for r in results if r["status"] == "fail"]
    if fails:
        L += ["", "## Failures", ""]
        for r in fails:
            L.append(f"### `{r['name']}` — {r['reason']}" + (f" — known pre-existing mold defect, task **{r['defect']}**" if r["defect"] else ""))
            if r["why"]: L.append(f"{r['why']}")
            L += ["", f"`{r['cmd']}`", "", "```", "\n".join((r["out"] or "(no output)").splitlines()[-40:])[-4000:], "```", ""]
        if any(r["defect"] for r in fails):
            L += ["Rows marked with a task id are defects of the mold snapshot itself, not of this application. "
                  "Fixing them needs a mold refresh from source per `MOLD.md`; they are reported here rather than "
                  "muted, and they still fail the lane.", ""]
    rows = [r for r in results if r["emits"] == "markdown_table" and r["status"] != "skipped"]
    if rows:
        L += ["", "## Measured rows", ""]
        for r in rows: L += [f"### `{r['name']}`", "", (r["out"] or "").strip(), ""]
    sk = [r for r in results if r["status"] == "skipped"]
    if sk or unmet_lane:
        L += ["", "## Skipped, and what would make them run", ""]
        L += [f"- `{r['name']}` — {r['reason']}" for r in sk] + [f"- (whole lane) {e}" for e in unmet_lane]
        L += ["", "A skipped check is why this lane cannot report `pass`: nothing measured it."]
    L += ["", "## Not covered by this lane", ""]
    nc = (spec or {}).get("not_covered") or []
    L += [f"- {x}" for x in nc] or [f"- See `molds/{mold_id}/testing/{lane}/README.md`."]
    return "\n".join(L) + "\n"

def open_tasks(mold_id): return [t for t in factory.read_tasks(mold_id) if t["status"] not in ("done", "dropped")]

def file_task(mold_id, lane, app_id, fails, dry):
    """Returns the task id(s) to name in revert.reason. Every failing check already carrying a known_defect
    means the backlog covers this: name those and file nothing."""
    defects = sorted({r["defect"] for r in fails if r["defect"]})
    if fails and len(defects) and all(r["defect"] for r in fails): return ", ".join(defects)
    for t in open_tasks(mold_id):
        if t.get("lane") == lane and app_id in t.get("title", ""): return t["task_id"]
    names = ", ".join(r["name"] for r in fails)
    title = f"Lane fail: {lane} on {app_id} — {len(fails)} check(s): {names}"
    if dry: return "(dry run: no task filed)"
    r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/factory.py"), "add", mold_id, title,
                        "--type", "test", "--pri", "1", "--lane", lane, "--owner", "fable"], capture_output=True, text=True)
    if r.returncode or not r.stdout.strip():
        # `add` attributes to the mold's FIRST product and raises StopIteration for a mold with none.
        print(f"could not file the task automatically: {(r.stderr or '').strip().splitlines()[-1:] or ['no output']}")
        print(f'  file it by hand: python3 .claude/scripts/factory.py add {mold_id} "{title}" --type test --pri 1 --lane {lane}')
        return "none (filing failed; see above)"
    return r.stdout.strip()

def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    app_id = a[0]; opts = a[1:]
    dry = "--dry-run" in opts; listing = "--list" in opts
    want = [opts[i + 1] for i, x in enumerate(opts) if x == "--lane" and i + 1 < len(opts)]
    for l in want:
        if l not in LANES: die(f"{l!r} is not one of the five lanes ({', '.join(LANES)}). Nothing ran.")
    adir = os.path.join(ST, "application", app_id)
    if not os.path.isdir(adir): die(f"no application {app_id} in state/application. Nothing ran.")
    docs = {}
    for name in ("application", "infrastructure", "datastores", "datainfra"):
        p = os.path.join(adir, f"{name}.json")
        if not os.path.exists(p): die(f"{app_id}/{name}.json is missing, so preconditions cannot be judged. Nothing ran.")
        docs[name] = load(p)
    mold_id = docs["application"].get("mold_id") or die(f"{app_id}/application.json has no mold_id. Nothing ran.")
    commit = docs["application"].get("mold_commit") or next((m.get("source", {}).get("commit", "?") for m in
             load(os.path.join(ST, "factory.json"))["molds"] if m["mold_id"] == mold_id), "?")
    specs = {l: read_spec(l, mold_id) for l in LANES}
    tdir = os.path.join(ROOT, "molds", mold_id, "testing")
    extra = sorted(d for d in (os.listdir(tdir) if os.path.isdir(tdir) else [])
                   if d not in LANES and os.path.exists(os.path.join(tdir, d, "lane.json")))
    if extra:   # silently never running a declared lane would be the same lie as calling it `pass`
        print(f"note: molds/{mold_id}/testing/ also declares {', '.join(extra)}, which this runner did not run: "
              f"application.json has one `testing` key per lane and knows only {', '.join(LANES)}. Add the lane to "
              f"state/application/app_id/application.schema.json and to LANES in this file before it can be recorded.")
    order = sorted(LANES, key=lambda l: ((specs[l] or {}).get("order", DEFAULT_ORDER[l]), l))
    todo = [l for l in order if not want or l in want]

    if listing:
        print(f"{'lane':16} {'harness':8} {'checks':>6}  preconditions")
        for l in todo:
            s = specs[l]
            if not s: print(f"{l:16} {'no':8} {0:>6}  no lane.json — this lane is skipped, never passed"); continue
            ctx = context(app_id, l, mold_id, docs, os.path.join(ROOT, "molds", mold_id, "testing", l, "reports",
                          *(["dry"] if dry else []), f"{app_id}-{TODAY}.md"))
            u = [e for e in (unmet(p, docs, ctx) for p in s.get("requires", [])) if e]
            u += [e for c in s.get("checks", []) for e in (unmet(p, docs, ctx) for p in c.get("requires", [])) if e]
            print(f"{l:16} {'yes':8} {len(s.get('checks', [])):>6}  " + ("; ".join(dict.fromkeys(u))[:160] if u else "all met"))
        return 0

    verdicts, first_fail = {}, None
    for i, lane in enumerate(todo):
        spec = specs[lane]
        rdir = os.path.join(ROOT, "molds", mold_id, "testing", lane, "reports", *(["dry"] if dry else []))
        os.makedirs(rdir, exist_ok=True)
        rpath = os.path.join(rdir, f"{app_id}-{TODAY}.md")
        ctx = context(app_id, lane, mold_id, docs, rpath)
        unmet_lane = [e for e in (unmet(p, docs, ctx) for p in (spec or {}).get("requires", [])) if e]
        results = [] if (not spec or unmet_lane) else [run_check(c, docs, ctx) for c in spec.get("checks", [])]
        fails = [r for r in results if r["status"] == "fail"]
        if not results: status = "skipped"
        elif fails: status = "fail"
        elif all(r["status"] == "pass" for r in results): status = "pass"
        else: status = "skipped"   # a check that did not run can never add up to `pass`
        verdicts[lane] = (status, results, rpath)
        not_run = todo[i + 1:] if status == "fail" and not dry else []
        # The report is on disk BEFORE the state write, so `testing.<lane>.report` always resolves.
        open(rpath, "w").write(report_text(lane, app_id, mold_id, commit, spec, status, results, ctx, unmet_lane, not_run, dry))
        rel = os.path.relpath(rpath, ROOT)
        print(f"{lane:16} {status:8} {sum(1 for r in results if r['status']=='pass')}/{len(results)} passed  {rel}")
        if not dry:
            app = load(os.path.join(adir, "application.json"))
            app.setdefault("testing", {})[lane] = {"status": status, "run_at": NOW, "report": rel}
            if status == "fail":
                tid = file_task(mold_id, lane, app_id, fails, dry)
                app["status"] = "reverted"
                app["revert"] = {"lane": lane, "at": NOW,
                                 "reason": f"{lane} lane failed on {len(fails)} check(s): "
                                           f"{', '.join(r['name'] for r in fails)}; report {rel}; "
                                           f"{'tasks' if ',' in tid else 'task'} {tid}"}
                first_fail = (lane, fails, rel, tid, not_run)
            save(os.path.join(adir, "application.json"), app)
            docs["application"] = app
        if status == "fail" and not dry: break
    print()
    if first_fail:
        lane, fails, rel, tid, not_run = first_fail
        rest = f" {', '.join(not_run)} did not run." if not_run else " Nothing else ran."
        print(f"{lane} failed ({len(fails)} of {len(verdicts[lane][1])} checks). Report: {rel}. "
              f"{app_id} is now reverted; {'tasks' if ',' in tid else 'task'} {tid} cover{'' if ',' in tid else 's'} it.{rest}")
        return 1
    c = lambda st: sum(1 for v in verdicts.values() if v[0] == st)
    tail = (" A skipped lane has no harness yet, or could not measure everything it declares — which is why it is "
            "not called a pass.")
    if dry:
        f = [l for l in todo if verdicts.get(l, ("",))[0] == "fail"]
        print(f"Dry run of {len(verdicts)} lane(s) for {app_id}: {c('pass')} passed, {c('fail')} failed, {c('skipped')} skipped. "
              + (f"A real run would stop at {f[0]} and mark {app_id} reverted. " if f else "")
              + "No state was written and no task was filed." + tail)
        return 1 if f else 0
    print(f"{len(verdicts)} lane(s) finished for {app_id}: {c('pass')} passed, {c('skipped')} skipped. "
          f"Nothing failed, so {app_id} was not reverted." + tail)
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
