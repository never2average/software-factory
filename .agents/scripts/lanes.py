#!/usr/bin/env python3
"""Run the five testing lanes against an application and record what actually happened.

  lanes.py <app_id>                        THE RUN OF RECORD: every lane, in the contract's order
                                           (functional, context, load, accessibility, responsiveness),
                                           stopping at the FIRST lane that fails. A failing lane reverts the
                                           application, so no later lane runs at all: the suite is a gate,
                                           not a survey. Every lane the stop skipped is written back as
                                           `pending` (its earlier verdict and report dropped), so the one
                                           machine-readable place the gate reads never says `pass` for a lane
                                           this run did not measure. The stop is also named on stdout, in the
                                           failing lane's report, and in `revert.reason`.
  lanes.py <app_id> --lane functional      only the named lane(s); repeatable. A single lane can revert the
                                           app on its own, but it is not the ordered run: the lanes before
                                           it were not re-measured. Lanes left `pending` by an earlier stop
                                           stay `pending` until an ordered run measures them, and every
                                           `revert.reason` this runner writes re-derives that list from
                                           state, so a partial re-run cannot quietly drop it.
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

Where a check runs (its `cwd`): an application with packs is graded in two unbranded copies that packs.py
lane-copy rebuilds every run. `codebase` is build/<app_id>.lane/ (mold + packs, the app's own profile): what this
app ships, so its subagent, vocabulary, rendered-page and live checks go there. `default_profile` is
build/<app_id>.lane-default/ (mold + packs' code, the DEFAULT profile): the mold's own offline tests, which are
written against that profile and would otherwise fail on any pack that relabels a word (mold_v1-146/147). Without
packs both are the mold's codebase.

`pass` is never printed next to a command that did not execute — that is the exact failure
functional/tenant-isolation.py was written to stop, and it is why `skipped` is the fallback rather
than `pass`. `known_defect` is an annotation, never a mute: a check tagged with a known mold defect still fails
its lane and still reverts the app; the flag only links the task id and stops a duplicate being filed. Untag it
when the task is done, or a new failure of the same check is filed under a fixed defect (mold_v1-019 on
2026-09-30). This runner is the ONLY writer of `testing.<lane>`; the only status it may write is
`reverted`. Promotion stays with the operator.

Reports are EVIDENCE, so they are write-once. Each is named `<app_id>-<date>T<hhmmss>Z.md` for the UTC
second the lane started, is created O_EXCL (a name that already exists is never reopened — the run takes
the next free `-2`, `-3`), and is left read-only. `testing.<lane>.report` and, after a fail, `revert.reason`
cite that path, so re-running the same lane for the same app on the same day cannot swap out the evidence
behind a revert record that is still standing; it writes its own file beside it.
"""
import datetime, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory   # _check for lane.json; `add` is SHELLED OUT, never re-implemented (it allocates task ids)
TODAY = datetime.date.today().isoformat()
LANES = ["functional", "context", "load", "accessibility", "responsiveness"]   # the contract's order
DEFAULT_ORDER = {n: (i + 1) * 10 for i, n in enumerate(LANES)}
CWDS = ("codebase", "default_profile", "testing", "root")

def stamps():
    """Per LANE, not per process. Two lanes of one ordered run finish at different times, and the report
    filename is cut from this, so a lane re-run seconds later can never land on the name it wrote last time."""
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.isoformat(timespec="seconds"), t.strftime("%Y-%m-%dT%H%M%SZ")

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

def clear_stale_revert(adir, app_id, ordered):
    """An ORDERED run that failed nothing is exactly the evidence a lane-filed revert was waiting for.

    Until now only a deploy cleared `reverted`, so an application whose cause was fixed and then re-proven
    by a full passing run still read `reverted` in the one machine-readable place the gate consults — while
    the deployment in front of traffic was fine. That is the self-contradictory record HARD RULE 8 exists to
    prevent, and it bit onfinance_hfc on 2026-09-23: a responsiveness lane failed on a VM busy with someone
    else's browsers, the re-run passed 6/6, and the record still said reverted.

    Narrow on purpose:
      * only an ordered run (a single `--lane` re-run does not re-measure the lanes before it);
      * only a revert a LANE filed (`revert.lane`) — a deploy-filed revert, e.g. row-level security not
        enforced on the running app, is not answered by a green lane and must stand until a deploy clears it;
      * only when no lane is `fail` and none was left `pending` by an earlier stop.
    Returns a sentence for stdout, or None when nothing was cleared."""
    app = load(os.path.join(adir, "application.json"))
    if app.get("status") != "reverted": return None
    rev = app.get("revert") or {}
    if not rev.get("lane") or not ordered: return None
    t = app.get("testing") or {}
    if any(v.get("status") in ("fail", "pending") for v in t.values()): return None
    app.pop("revert", None); app["status"] = "stamped"
    save(os.path.join(adir, "application.json"), app)
    return (f"{app_id}: status reverted -> stamped. The standing revert was filed by the {rev['lane']} lane "
            f"({rev.get('at', '')[:16]}) and this ordered run re-measured every lane with nothing failing, "
            f"which is the evidence it was waiting for.\n")

def reserve_report(rdir, app_id, stamp):
    """Claim a report path that cannot already hold someone's evidence, and return an open fd for it.

    Two safeguards rather than one, because a report path is quoted by a standing `revert.reason` and the
    convenient behaviour (reopen `<app_id>-<date>.md` with "w") silently rewrites the record's evidence
    while the record still says `reverted` (HARD RULE 8 — take the safe one):
      * the name carries the UTC second the lane started, not just the date, so a same-day re-run differs;
      * O_EXCL, so even an identical name is never reopened for writing — the run takes the next suffix.
    O_EXCL is the guarantee: it is enforced by the kernel for every user, root included. The 0444 mode is
    only a second, weaker fence — it stops an ordinary editor or a careless `>` for a non-root operator, and
    root ignores it, so it is never relied on. A run killed mid-lane leaves an empty reserved report; the
    next run takes `-2` rather than reusing it, which is the intended trade: a stub saying a run started
    beats a file that quietly became a different run."""
    for n in range(1, 100):
        p = os.path.join(rdir, f"{app_id}-{stamp}" + ("" if n == 1 else f"-{n}") + ".md")
        try: return os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444), p
        except FileExistsError: continue
    die(f"{os.path.relpath(rdir, ROOT)} already holds 99 reports for {app_id} stamped {stamp}, which should "
        f"be impossible. Nothing was overwritten and nothing ran. Move that folder aside and run the lane again.")

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
    if "env" in p: return None if (ctx.get("_env") or os.environ).get(p["env"]) else e   # presence BY NAME; the value is never read
    if "path" in p: return None if os.path.exists(os.path.join(ROOT, subst(p["path"], ctx))) else e
    if "cmd" in p:
        r = subprocess.run(subst(p["cmd"], ctx), shell=True, cwd=ROOT, capture_output=True, text=True)
        return None if r.returncode == 0 else e
    return e

def app_secret_values(docs, names, app_id):
    """The application's OWN secrets, by name, from where its state says they live — never from a file
    someone copied by hand, never printed. vercel_env: the project's production env, pulled the way
    provision.py pulls it (a Sensitive variable comes back redacted and counts as absent).
    vm_env_file: infra/vm/apps/<app>/.env, the file --verify-db writes."""
    infra = docs.get("infrastructure") or {}; store = infra.get("secret_store"); vals = {}
    if store == "vm_env_file":
        f = os.path.join(ROOT, "infra/vm/apps", app_id, ".env")
        if os.path.isfile(f):
            for l in open(f):
                if "=" in l and not l.startswith("#"): k, v = l.split("=", 1); vals[k.strip()] = v.strip().strip('"')
    elif store == "vercel_env" and (infra.get("vercel") or {}).get("project"):
        import provision
        vals = provision.pull_env(os.path.join(ROOT, "molds", docs["application"]["mold_id"], "codebase"),
                                  infra["vercel"]["project"], required=False)
    return {n: vals[n] for n in names if vals.get(n) and vals[n] != "[SENSITIVE]"}

def run_check(c, docs, ctx):
    res = {"name": c["name"], "defect": c.get("known_defect"), "why": c.get("why", ""),
           "emits": c.get("emits"), "cmd": subst(c["run"], ctx), "out": ""}
    env = dict(os.environ)
    if c.get("app_env"):
        got = app_secret_values(docs, c["app_env"], ctx["app_id"])
        missing = [n for n in c["app_env"] if n not in got]
        if missing:
            return dict(res, status="skipped", reason=f"this app's {', '.join(missing)} could not be read from its secret "
                        f"store ({(docs.get('infrastructure') or {}).get('secret_store')}); the check must connect as the "
                        f"application itself. Deploy it first: python3 .claude/scripts/provision.py {ctx['app_id']} --deploy "
                        f"(a vm app: --verify-db).")
        env.update(got); res["app_env"] = list(got)      # names only, for the report
    ctx = dict(ctx, _env=env)
    for p in c.get("requires", []):
        e = unmet(p, docs, ctx)
        if e: return dict(res, status="skipped", reason=e)
    cwd = {"codebase": ctx["codebase"], "default_profile": ctx["default_codebase"], "testing": ctx["testing"],
           "root": ROOT}[c.get("cwd", "codebase")]
    t = c.get("timeout_s", 600)
    try:
        r = subprocess.run(res["cmd"], shell=True, cwd=cwd, capture_output=True, text=True, timeout=t, env=env)
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
    if bad: return dict(res, status="fail", reason="; ".join(bad), out=out)
    # `skip_on`: the check ran, but its own output says a surface it names was declared off (not opened).
    # The safe verdict is `skipped` — a lane with a skipped check is never `pass` — and never `pass` with
    # one product surface unmeasured. Judged AFTER the fail rules, so a measured failure is never hidden by
    # a declared-off row beside it. The rows it did measure stay in the report (`out` is kept).
    for sk in exp.get("skip_on", []):
        if re.search(sk["stdout"], out, re.S): return dict(res, status="skipped", reason=subst(sk["else"], ctx), out=out)
    return dict(res, status="pass", reason=f"exit {code}", out=out)

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
    # vercel.production_url ONLY. The vm lane never starts a web process and the schema refuses vm.production_url
    # (mold_v1-053), so a vm app gets "" here and every URL check reports "not deployed" instead of grading a
    # server this factory did not deploy; the old fallback read a field that could no longer validate (mold_v1-057).
    url = ((infra.get("vercel") or {}).get("production_url") or "").rstrip("/")
    mold = os.path.join(ROOT, "molds", mold_id)
    app = docs.get("application") or {}
    # An application with packs has code the mold does not: its checks run in its own build copy
    # (build/<app_id>/, made by packs.py apply), never in the general-purpose mold.
    # The UNBRANDED copy (packs.py lane-copy): source checks grade the mold plus the packs; the brand overlay
    # writes the product name into shared code on purpose and has its own check (branding.py check).
    codebase = os.path.join(ROOT, "build", app_id + ".lane") if app.get("packs") else os.path.join(mold, "codebase")
    # cwd "default_profile": where the mold's OWN offline tests run. They are written against the default deployment
    # profile (upstream CI runs them on nothing else), so a pack's profile — relabelled vocabulary, its own record
    # fields — fails them by design, measuring the pack's words against the mold's fixtures rather than the product
    # (mold_v1-146/147). build/<app_id>.lane-default/ is the mold plus the packs' CODE with the default profile
    # (packs.py lane-copy); an app without packs has no other profile, so it is the mold itself. Checks that grade
    # what THIS app ships — its subagents, its words, its rendered pages, its live URL — keep cwd "codebase".
    default_codebase = os.path.join(ROOT, "build", app_id + ".lane-default") if app.get("packs") else os.path.join(mold, "codebase")
    # What the page <title> must carry: the app's own brand, else the mold's default name.
    rules = os.path.join(mold, "branding", "rules.json")
    default_name = json.load(open(rules)).get("product_name_default", "") if os.path.exists(rules) else ""
    product_name = ((app.get("surface") or {}).get("branding") or {}).get("product_name") or default_name
    return {"app_id": app_id, "root": ROOT, "mold": mold, "codebase": codebase, "default_codebase": default_codebase,
            "product_name": re.escape(product_name),
            "testing": os.path.join(mold, "testing"), "lane": lane, "date": TODAY, "url": url, "report": report}

def report_text(lane, app_id, mold_id, commit, spec, status, results, ctx, unmet_lane, not_run,
                run_at, stamp, cmdline, dry=False):
    n = lambda s: sum(1 for r in results if r["status"] == s)
    head = f"{n('pass')} of {len(results)} checks passed" if results else "no harness"
    if n("fail"): head += f", {n('fail')} failed"
    if n("skipped"): head += f", {n('skipped')} skipped"
    L = [f"# {lane.capitalize()} lane — {app_id} ({stamp})" + (" — DRY RUN" if dry else ""), "",
         f"Mold: {mold_id} (commit {commit}).",
         f"Run at {run_at}. Lane status: **{status}** ({head}).",
         f"Command: `{cmdline}`",
         f"This file: `{os.path.relpath(ctx['report'], ROOT)}` — written once, then left read-only. The runner "
         f"creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file "
         f"beside this one rather than editing it. If the bytes here ever change, something other than "
         f"lanes.py changed them."]
    if dry:
        L += ["", "**DRY RUN — nothing here was recorded.** No `testing." + lane + "` was written to "
              f"`state/application/{app_id}/application.json`, no task was filed, and the application was not "
              "reverted whatever this report says. It lives under `reports/dry/` so it can never be mistaken "
              "for, or overwrite, the report a recorded run points at."]
    if spec and spec.get("summary"): L += ["", spec["summary"]]
    if not_run: L += ["", f"**The run stopped here.** {', '.join(not_run)} did not run: this lane "
                          f"failed, which reverts {app_id}, and the suite is a gate. "
                          f"`testing.{{{', '.join(not_run)}}}` was therefore reset to `pending` in "
                          f"`state/application/{app_id}/application.json` — an earlier run's verdict for a "
                          "lane this run never reached is not a result, and must not read as one."]
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
    # A check skipped by a precondition has no output; one skipped on its own output (skip_on) measured
    # rows, and those are printed — the report shows what was measured and the verdict stays `skipped`.
    rows = [r for r in results if r["emits"] == "markdown_table" and (r["status"] != "skipped" or r["out"])]
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

def pending_lanes(app):
    """Lanes whose recorded status is `pending` — intake.py's seed for "never measured", and what the stop
    below writes back over a lane it skipped. Re-derived from state at every write, so the fact that some
    lane is unmeasured survives any later single-lane re-run that rewrites `revert.reason`."""
    return [l for l in LANES if ((app.get("testing") or {}).get(l) or {}).get("status") == "pending"]

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
    if docs["application"].get("packs") and "--list" not in sys.argv:
        # Rebuilt every run, so the lane never grades a stale copy of a pack. Two copies: build/<app_id>.lane/
        # (mold + packs, cwd "codebase") and build/<app_id>.lane-default/ (the same, default profile, cwd
        # "default_profile") — see context().
        r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/packs.py"), "lane-copy", app_id], capture_output=True, text=True)
        if r.returncode: die(f"{app_id} has packs and its lane copies could not be built: {(r.stdout + r.stderr).strip()[-400:]} Nothing ran.")
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
                          *(["dry"] if dry else []), f"{app_id}-{TODAY}T<hhmmss>Z.md"))   # pattern: --list writes nothing
            u = [e for e in (unmet(p, docs, ctx) for p in s.get("requires", [])) if e]
            # A check with app_env is judged with the same environment the run would give it, so --list and
            # the run can never disagree about whether a precondition holds.
            u += [e for c in s.get("checks", []) for e in
                  (unmet(p, docs, dict(ctx, _env={**os.environ, **app_secret_values(docs, c.get("app_env", []), app_id)})
                         if c.get("app_env") else ctx) for p in c.get("requires", [])) if e]
            print(f"{l:16} {'yes':8} {len(s.get('checks', [])):>6}  " + ("; ".join(dict.fromkeys(u))[:160] if u else "all met"))
        return 0

    verdicts, first_fail = {}, None
    ordered = not want   # the whole-suite run of record; --lane makes it a partial re-measure
    cmdline = "python3 .claude/scripts/lanes.py " + " ".join([app_id] + opts)
    for i, lane in enumerate(todo):
        spec = specs[lane]
        run_at, stamp = stamps()
        rdir = os.path.join(ROOT, "molds", mold_id, "testing", lane, "reports", *(["dry"] if dry else []))
        os.makedirs(rdir, exist_ok=True)
        # The name is claimed BEFORE the checks run, so {report} in a check resolves to the file that will
        # hold this run and to no other run's file.
        fd, rpath = reserve_report(rdir, app_id, stamp)
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
        with os.fdopen(fd, "w") as fh:
            fh.write(report_text(lane, app_id, mold_id, commit, spec, status, results, ctx, unmet_lane,
                                 not_run, run_at, stamp, cmdline, dry))
        os.chmod(rpath, 0o444)   # evidence, not scratch. A fence for a non-root operator only; root ignores
                                 # the mode, which is why O_EXCL above — not this line — is the guarantee.
        rel = os.path.relpath(rpath, ROOT)
        print(f"{lane:16} {status:8} {sum(1 for r in results if r['status']=='pass')}/{len(results)} passed  {rel}")
        if not dry:
            app = load(os.path.join(adir, "application.json"))
            app.setdefault("testing", {})[lane] = {"status": status, "run_at": run_at, "report": rel}
            if status == "fail":
                tid = file_task(mold_id, lane, app_id, fails, dry)
                app["status"] = "reverted"
                # A lane the stop skipped must NOT keep an earlier run's `pass` in the only machine-readable
                # place the product gate ("all five lanes pass") reads (HARD RULE 8: the safe value exists,
                # so take it). `pending` is already in application.schema.json's enum and is exactly what
                # intake.py seeds for "not measured", so this needs no schema change and no other file. The
                # stale `report` goes with it: it describes a different run and would resolve to a green one.
                for l in not_run: app["testing"][l] = {"status": "pending", "run_at": run_at}
                # The report path here is write-once (see reserve_report), so this reason keeps naming the
                # run it was written for.
                stale = (f" The run stopped here: {', '.join(not_run)} did not run, so testing."
                         f"{{{', '.join(not_run)}}} was reset to `pending` rather than left showing an "
                         f"earlier run's verdict." if not_run else "")
                # Re-derived from state on every revert write, not carried over as prose: a later single-lane
                # re-run rewrites this reason, and it must still say which lanes nothing has measured.
                pend = pending_lanes(app)
                unmeasured = (f" Unmeasured lanes right now (`pending`): {', '.join(pend)}. {app_id} is not "
                              f"gate-green until `python3 .claude/scripts/lanes.py {app_id}` runs all five in "
                              f"order and none fails." if pend else "")
                app["revert"] = {"lane": lane, "at": run_at,
                                 "reason": f"{lane} lane failed on {len(fails)} check(s): "
                                           f"{', '.join(r['name'] for r in fails)}; report {rel}; "
                                           f"{'tasks' if ',' in tid else 'task'} {tid}." + stale + unmeasured}
                first_fail = (lane, fails, rel, tid, not_run)
            save(os.path.join(adir, "application.json"), app)
            docs["application"] = app
        if status == "fail" and not dry: break
    print()
    pend = [] if dry else pending_lanes(docs["application"])
    unmeasured = (f" {len(pend)} lane(s) stand unmeasured (`pending`): {', '.join(pend)}. Run "
                  f"`python3 .claude/scripts/lanes.py {app_id}` to measure all five in order." if pend else "")
    if first_fail:
        lane, fails, rel, tid, not_run = first_fail
        rest = (f" The run stopped here: {', '.join(not_run)} did not run, so their results were reset to "
                f"`pending` rather than left standing." if not_run else " Nothing else ran.")
        print(f"{lane} failed ({len(fails)} of {len(verdicts[lane][1])} checks). Report: {rel}. "
              f"{app_id} is now reverted; {'tasks' if ',' in tid else 'task'} {tid} cover{'' if ',' in tid else 's'} it.{rest}{unmeasured}")
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
    which = ("all five lanes in order (" + ", ".join(todo) + ")") if ordered else ", ".join(todo)
    print(f"{len(verdicts)} lane(s) finished for {app_id} — {which}: {c('pass')} passed, {c('skipped')} skipped. "
          f"Nothing failed, so {app_id} was not reverted." + tail + unmeasured)
    print(clear_stale_revert(adir, app_id, ordered) or "", end="")
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
