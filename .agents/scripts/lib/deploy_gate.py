#!/usr/bin/env python3
"""Only deploy what passed: the mold commit an application is built from must have a green CI run on the mold's source.

  deploy_gate.py <mold_id> [--commit SHA] [--json]   the verdict for the pinned commit (or SHA). READ-ONLY: one or
                                                     three GitHub API reads through `gh`. Exit 0 green, 1 not green.
  deploy_gate.py --self-test                         offline: a stand-in `gh` answers (lib/services.py rehearsal)

WHAT IS CHECKED. The commit is state/factory.json molds[<mold_id>].source.commit: the one mold.py pinned and the one
every build is made from (branding.py and packs.py copy the snapshot taken at that commit). The source repository is
this machine's own (state/factory.local.json -> mold_sources, read through lib/factory_local.py), never a tracked file.
For EXACTLY that commit (GitHub's head_sha filter, never "the latest run on main"):
  1. the run of .github/workflows/ci.yml (a push run first, else the newest) must be completed with conclusion success;
  2. every job that ci.yml defines AT THAT COMMIT (read through the contents API at that ref; the local snapshot's copy
     when GitHub cannot be asked for it) must have reported a check run in that run's check suite, completed, and
     success (skipped and neutral count as passed, as GitHub's own required checks treat them). A matrix job counts
     once per combination, so `eve-runtime ${{ matrix.shard }}/2` with shard [1, 2] is two checks.
  3. a check run in that suite that is not in the list (a job added under another name) must not have failed either.
The source's branch protection would be the other place "required" could come from; on this plan GitHub answers 403
for it, so the workflow file is the list.

VERDICTS: green, red (a check failed or the run ended badly), pending (still running or queued, or a job has not
reported yet), missing (no run of ci.yml for the commit), unverifiable (no commit pinned, no GitHub source on this
machine, or GitHub could not be asked). Anything but green refuses the deploy with one plain message naming the
check, unless the operator chose to deploy anyway: --allow-unverified-mold "<reason>" — the reason, the verdict and
the time are written to infrastructure.json deploy_gate.override, and the deploy says so loudly.

Every verdict, green included, is recorded in infrastructure.json deploy_gate (at, mold_id, commit, verdict, detail).

AN IN-TREE MOLD (lib/intree.py; today mold_v0, authored in THIS repository since its fork point, mold_v0-040) has no
source of its own to ask. Its gate reads THIS repository instead, for the commit being deployed:
  0. the commit is HEAD of the checkout the deploy runs from, and molds/<mold_id>/codebase on disk must be exactly that
     commit: no tracked change, no untracked file, no ignored file the deploy would carry (anything ignored that is
     not in mold.json's source_excludes). Otherwise: unverifiable, naming the paths. No git, no HEAD: unverifiable;
  1. the repository is this checkout's `origin` (a GitHub address), never a tracked value;
  2. with mold.json "source": {"ci": {"workflow": ".github/workflows/<file>.yml"}} (ticket mold_v0-001 adds it): the
     same three rules as above, for that workflow of this repository at that commit;
  3. until a workflow is named: EVERY check run and commit status GitHub has for that commit of this repository must
     have completed and passed, and there must be at least one (none at all: missing). None of those runs is the
     shell's own test yet, so a green here says "this repository's checks passed for this commit", nothing more, and
     the verdict says exactly that.
GitHub not answering, a check that failed, one still running, or none: refused as for any mold, with the same
--allow-unverified-mold "<reason>" way round. Nothing is green without a positive reading.
Standard library only.
"""
import base64, datetime, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import factory_local  # noqa: E402
import intree  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
STATE = os.path.join(ROOT, "state")
WORKFLOW = ".github/workflows/ci.yml"
PASSED = ("success", "skipped", "neutral")
FLAG = "--allow-unverified-mold"


def _now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def mold_commit(mold_id, state_dir=STATE):
    for m in factory_local.load_factory(state_dir).get("molds") or []:
        if m.get("mold_id") == mold_id: return ((m.get("source") or {}).get("commit") or "").strip() or None
    return None


def gh_api(host, path, timeout=60):
    """(returncode, parsed JSON or None, one-line error). Through `gh`, which in a rehearsal is the fake (services.py)."""
    cmd = ["gh", "api"] + (["--hostname", host] if host and host != "github.com" else []) + [path]
    try: r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError: return 127, None, "the `gh` command is not installed on this machine"
    except subprocess.TimeoutExpired: return 124, None, f"GitHub did not answer within {timeout}s"
    try: doc = json.loads(r.stdout) if r.stdout.strip() else None
    except ValueError: doc = None
    err = ((r.stderr or "").strip().splitlines() or [""])[-1][:200]
    return r.returncode, doc, err


# ---- what ci.yml requires ------------------------------------------------------------------------------------------

def required_checks(ci_text):
    """[(job_id, [check names])] from a workflow file, without a YAML library: the jobs are the two-space keys under
    `jobs:`; a job's check is named by its `name:` (with ${{ matrix.<k> }} expanded over a one-line list) or its id."""
    lines = ci_text.splitlines(); out = []; i = 0
    while i < len(lines) and not re.match(r"^jobs:\s*$", lines[i]): i += 1
    jobs = []
    for j in range(i + 1, len(lines)):
        if re.match(r"^\S", lines[j]): break
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", lines[j])
        if m: jobs.append((m.group(1), j))
    for n, (jid, start) in enumerate(jobs):
        end = jobs[n + 1][1] if n + 1 < len(jobs) else len(lines)
        block = lines[start + 1:end]
        name = next((re.sub(r"^\s*name:\s*", "", l).strip().strip("'\"") for l in block if re.match(r"^    name:\s*\S", l)), None)
        matrix = {}
        for l in block:
            mm = re.match(r"^\s{6,}([A-Za-z0-9_-]+):\s*\[(.*)\]\s*$", l)
            if mm and any(re.match(r"^\s+matrix:\s*$", b) for b in block):
                matrix[mm.group(1)] = [v.strip().strip("'\"") for v in mm.group(2).split(",") if v.strip()]
        names = [name or jid]
        for k, vals in matrix.items():
            if name and re.search(r"\$\{\{\s*matrix\.%s\s*\}\}" % re.escape(k), name):
                names = [re.sub(r"\$\{\{\s*matrix\.%s\s*\}\}" % re.escape(k), v, x) for x in names for v in vals]
        if matrix and not name:   # GitHub names an unnamed matrix job "<id> (<v1>, <v2>)"
            combos = [[]]
            for vals in matrix.values(): combos = [c + [v] for c in combos for v in vals]
            names = [f"{jid} ({', '.join(c)})" for c in combos]
        out.append((jid, names))
    return out


def _ci_text(host, repo, sha, workflow, local_copy, gh):
    rc, doc, _ = gh(host, f"repos/{repo}/contents/{workflow}?ref={sha}")
    if rc == 0 and isinstance(doc, dict) and doc.get("content"):
        try: return base64.b64decode(doc["content"]).decode(), "GitHub, at the commit"
        except Exception: pass
    if local_copy and os.path.isfile(local_copy): return open(local_copy).read(), "the local copy"
    return None, None


# ---- the verdict -----------------------------------------------------------------------------------------------------

def _verdict(state, mold_id, sha, message, **extra):
    return dict({"ok": state == "green", "state": state, "mold_id": mold_id, "commit": sha, "message": message}, **extra)


def check(mold_id, commit=None, state_dir=STATE, gh=gh_api):
    """The verdict for one mold commit. Never raises; never writes."""
    root = os.path.dirname(os.path.abspath(state_dir))
    try: I = intree.info(mold_id, root)
    except intree.Unreadable as e: return _verdict("unverifiable", mold_id, commit, str(e))
    if I is not None: return check_in_tree(mold_id, I, root, commit=commit, gh=gh)
    sha = commit or mold_commit(mold_id, state_dir)
    if not sha:
        return _verdict("unverifiable", mold_id, None, f"state/factory.json names no source commit for {mold_id}, so there is "
                        f"nothing to check CI for. Pin one: python3 .claude/scripts/mold.py refresh {mold_id}")
    short = sha[:7]
    url = factory_local.mold_source(mold_id, state_dir); slug = factory_local.repo_slug(url)
    if not slug or slug.count("/") < 2:
        return _verdict("unverifiable", mold_id, sha, f"this machine names no GitHub source for {mold_id} (state/factory.local.json "
                        f"mold_sources), so whether commit {short} passed its checks cannot be asked.")
    host, repo = slug.split("/", 1)
    return _judge_workflow(host, repo, sha, mold_id, f"{mold_id}'s", f"{mold_id}'s source", WORKFLOW,
                           os.path.join(root, "molds", mold_id, "codebase", WORKFLOW), gh,
                           "Push that commit to the source, or wait for its run to start, then deploy again.")


def _judge_workflow(host, repo, sha, mold_id, whose, where_from, workflow, local_copy, gh, missing_how):
    """One workflow's run for exactly `sha`, and every job that workflow defines at that commit. -> verdict."""
    short = sha[:7]; wname = os.path.basename(workflow)
    rc, doc, err = gh(host, f"repos/{repo}/actions/runs?head_sha={sha}&per_page=100")
    if rc != 0 or not isinstance(doc, dict):
        return _verdict("unverifiable", mold_id, sha, f"GitHub could not be asked about commit {short} of {where_from}: "
                        f"{err or 'no answer'}. Check this machine's sign-in with `gh auth status`.")
    runs = [r for r in doc.get("workflow_runs") or [] if (r.get("path") or "").split("@")[0] == workflow and r.get("head_sha", sha) == sha]
    if not runs:
        return _verdict("missing", mold_id, sha, f"{whose} checks ({wname}) have not run for commit {short}: there is no result to "
                        f"trust yet. {missing_how}")
    runs.sort(key=lambda r: (r.get("event") == "push", r.get("run_attempt") or 0, r.get("created_at") or "", r.get("id") or 0), reverse=True)
    run = runs[0]
    rc, cdoc, err = gh(host, f"repos/{repo}/commits/{sha}/check-runs?per_page=100")
    checks = [c for c in ((cdoc or {}).get("check_runs") or []) if rc == 0]
    suite = run.get("check_suite_id")
    if suite: checks = [c for c in checks if (c.get("check_suite") or {}).get("id") in (None, suite)]
    seen = {c.get("name"): c for c in sorted(checks, key=lambda c: c.get("started_at") or "")}
    text, where = _ci_text(host, repo, sha, workflow, local_copy, gh)
    required = [x for _, names in required_checks(text) for x in names] if text else []
    running, failed, absent = [], [], []
    for n in required:
        c = seen.get(n)
        if not c: absent.append(n)
        elif c.get("status") != "completed": running.append(n)
        elif (c.get("conclusion") or "") not in PASSED: failed.append(f"{n} ({c.get('conclusion')})")
    for n, c in seen.items():
        if n in required: continue
        if c.get("status") != "completed": running.append(n)
        elif (c.get("conclusion") or "") not in PASSED: failed.append(f"{n} ({c.get('conclusion')})")
    summary = {"run_id": run.get("id"), "run_status": run.get("status"), "run_conclusion": run.get("conclusion"), "event": run.get("event"),
               "required": required, "required_from": where, "reported": len(seen)}
    if failed:
        return _verdict("red", mold_id, sha, f"{mold_id}'s checks failed for commit {short}: {', '.join(failed[:4])}"
                        + (f" and {len(failed) - 4} more" if len(failed) > 4 else "") + ". That commit is not deployed.", failed=failed, **summary)
    if run.get("status") != "completed" or running:
        names = running or absent
        return _verdict("pending", mold_id, sha, f"{mold_id}'s checks are still running for commit {short}"
                        + (f" ({', '.join(names[:4])}{' and more' if len(names) > 4 else ''})" if names else "")
                        + ". Wait for them to finish, then deploy again.", running=running, **summary)
    if run.get("conclusion") != "success":
        return _verdict("red", mold_id, sha, f"{mold_id}'s CI run for commit {short} ended {run.get('conclusion') or 'without a result'}, "
                        f"not success. That commit is not deployed.", **summary)
    if absent:
        return _verdict("red", mold_id, sha, f"{mold_id}'s CI run for commit {short} finished, but {', '.join(absent[:4])} never reported, "
                        f"and {wname} at that commit requires {'them' if len(absent) > 1 else 'it'}. That commit is not deployed.", absent=absent, **summary)
    if not required and not seen:
        return _verdict("unverifiable", mold_id, sha, f"the CI run for commit {short} reports no checks and {wname} could not be read, "
                        f"so nothing says which checks passed.", **summary)
    return _verdict("green", mold_id, sha, f"{mold_id} commit {short}: CI passed ({len(required) or len(seen)} checks"
                    + (f", the list read from {wname} in {where}" if where else "") + ").", **summary)


def check_in_tree(mold_id, I, root, commit=None, gh=gh_api):
    """The verdict for an in-tree mold (lib/intree.py): THIS repository's checks for the commit being deployed (HEAD),
    with the codebase on disk exactly that commit. Never raises; never writes; fails closed at every step."""
    head = intree.head(root)
    sha = commit or head
    if not sha:
        return _verdict("unverifiable", mold_id, None, f"{mold_id} is authored in this repository (in-tree), but git cannot name the commit "
                        f"this checkout is at, so which checks to read cannot be told.", source="factory")
    short = sha[:7]
    if not commit or commit == head:
        try: man = json.load(open(os.path.join(root, "molds", mold_id, "mold.json")))
        except (OSError, ValueError): man = {}
        excl = ((man.get("compose") or {}).get("source_excludes") or [])
        dirty = intree.uncommitted(mold_id, root, excl)
        if dirty is None:
            return _verdict("unverifiable", mold_id, sha, f"git could not list changes under molds/{mold_id}/codebase, so whether what "
                            f"would be deployed is commit {short} cannot be told.", source="factory")
        if dirty:
            return _verdict("unverifiable", mold_id, sha, f"molds/{mold_id}/codebase is not exactly commit {short}: {len(dirty)} uncommitted "
                            f"change(s) ({', '.join(d[3:] for d in dirty[:4])}{' and more' if len(dirty) > 4 else ''}), and checks of a commit "
                            f"say nothing about files that are not in it. Commit them (and let this repository's checks run), or remove "
                            f"them, then deploy again.", source="factory", uncommitted=dirty[:40])
    slug = intree.slug(root)
    if not slug or slug.count("/") < 2:
        return _verdict("unverifiable", mold_id, sha, f"{mold_id} is authored in this repository, but this checkout has no GitHub `origin`, "
                        f"so whether commit {short} passed this repository's checks cannot be asked.", source="factory")
    host, repo = slug.split("/", 1)
    workflow = (I.get("ci") or {}).get("workflow")
    if workflow:
        v = _judge_workflow(host, repo, sha, mold_id, "this repository's", "this repository", workflow, os.path.join(root, workflow), gh,
                            "Push that commit, or wait for its run to start, then deploy again.")
        v["source"] = "factory"; v["reads"] = f"this repository's {workflow} at commit {short}"
        return v
    reads = (f"every check GitHub reports for commit {short} of this repository (no workflow of the in-tree shell is named in "
             f"molds/{mold_id}/mold.json yet, ticket mold_v0-001, so none of them is the shell's own test)")
    runs, page, total = [], 1, None
    while True:                                  # every page: a failed check on page two must never go unread
        rc, cdoc, err = gh(host, f"repos/{repo}/commits/{sha}/check-runs?per_page=100&page={page}")
        if rc != 0 or not isinstance(cdoc, dict):
            return _verdict("unverifiable", mold_id, sha, f"GitHub could not be asked about commit {short} of this repository: {err or 'no answer'}. "
                            f"Check this machine's sign-in with `gh auth status`.", source="factory", reads=reads)
        got = cdoc.get("check_runs") or []; runs += got; total = cdoc.get("total_count")
        if not isinstance(total, int) or len(runs) >= total or not got or page >= 10: break
        page += 1
    if isinstance(total, int) and len(runs) < total:
        return _verdict("unverifiable", mold_id, sha, f"GitHub reports {total} checks for commit {short} of this repository but only "
                        f"{len(runs)} could be read, so whether the rest passed cannot be told.", source="factory", reads=reads)
    rc, sdoc, err = gh(host, f"repos/{repo}/commits/{sha}/status")
    if rc != 0 or not isinstance(sdoc, dict):
        return _verdict("unverifiable", mold_id, sha, f"GitHub could not be asked about the statuses of commit {short} of this repository: "
                        f"{err or 'no answer'}.", source="factory", reads=reads)
    items = [(c.get("name") or "?", c.get("status"), c.get("conclusion")) for c in runs]
    statuses = sdoc.get("statuses") or []
    for st in statuses:                          # the commit status API: success, pending, failure, error
        state = st.get("state")
        items.append((st.get("context") or "?", "completed" if state in ("success", "failure", "error") else "in_progress", state))
    if isinstance(sdoc.get("total_count"), int) and sdoc["total_count"] > len(statuses) and sdoc.get("state") != "success":
        # more statuses than one answer holds: GitHub's combined state stands for the ones not listed
        items.append(("combined status", "completed" if sdoc.get("state") in ("failure", "error") else "in_progress", sdoc.get("state")))
    failed = [f"{n} ({c})" for n, s_, c in items if s_ == "completed" and (c or "") not in PASSED]
    running = [n for n, s_, c in items if s_ != "completed"]
    extra = {"source": "factory", "reads": reads, "reported": len(items)}
    if not items:
        return _verdict("missing", mold_id, sha, f"this repository has no checks for commit {short}: no workflow has run on it, so nothing "
                        f"says it passed. Until the in-tree shell's own workflow exists (mold_v0-001), a {mold_id} deploy needs "
                        f"{FLAG} \"<reason>\".", **extra)
    if failed:
        return _verdict("red", mold_id, sha, f"this repository's checks failed for commit {short}: {', '.join(failed[:4])}"
                        + (f" and {len(failed) - 4} more" if len(failed) > 4 else "") + ". That commit is not deployed.", failed=failed, **extra)
    if running:
        return _verdict("pending", mold_id, sha, f"this repository's checks are still running for commit {short} ({', '.join(running[:4])}"
                        f"{' and more' if len(running) > 4 else ''}). Wait for them to finish, then deploy again.", running=running, **extra)
    return _verdict("green", mold_id, sha, f"{mold_id} (in-tree) at commit {short} of this repository: its {len(items)} check(s) passed "
                    f"(read: {reads}).", **extra)


def override_reason(argv):
    """The operator's reason after --allow-unverified-mold, or None when the flag is absent. A flag with no reason is
    refused by `require` (an empty override is how "verified" quietly stops meaning anything)."""
    if FLAG not in argv: return None
    i = argv.index(FLAG)
    r = argv[i + 1] if i + 1 < len(argv) else ""
    return "" if r.startswith("--") else r.strip()


def require(app_id, app, infra, adir, argv, state_dir=STATE, gh=gh_api, save=None, say=print):
    """THE ONE GATE CALL, before any deploy (Vercel or vm_remote). Records the verdict in infrastructure.json
    deploy_gate and returns it when it is green or explicitly overridden; otherwise raises SystemExit with one plain
    message (nothing has been deployed at that point)."""
    reason = override_reason(argv)
    if reason == "":
        raise SystemExit(f"{FLAG} needs a reason in quotes after it, for the record, e.g. "
                         f"{FLAG} \"hotfix for a sign-in outage; CI is down\". Nothing was deployed.")
    v = check(app.get("mold_id"), state_dir=state_dir, gh=gh)
    rec = {"at": _now(), "mold_id": v["mold_id"], "commit": v["commit"], "verdict": v["state"], "detail": v["message"][:400]}
    if not v["ok"] and reason:
        rec["override"] = {"reason": reason[:400], "at": rec["at"]}
    infra["deploy_gate"] = rec
    if save: save(os.path.join(adir, "infrastructure.json"), infra)
    else:
        with open(os.path.join(adir, "infrastructure.json"), "w") as f: json.dump(infra, f, indent=2); f.write("\n")
    if v["ok"]:
        say(f"  mold checks: {v['message']}"); return v
    if reason:
        say(f"  mold checks NOT verified ({v['state']}): {v['message']}\n  deploying anyway because the operator said so: "
            f"\"{reason[:200]}\" (recorded in state/application/{app_id}/infrastructure.json deploy_gate.override)")
        return v
    raise SystemExit(f"{app_id}: not deploying. {v['message']}\n"
                     f"  Nothing was deployed; what is running now keeps running.\n"
                     f"  To deploy this commit anyway, with the reason kept in state: python3 .claude/scripts/provision.py "
                     f"{app_id} {'--deploy-remote' if '--deploy-remote' in argv else '--deploy'} {FLAG} \"<why>\"")


# ---- self-test ---------------------------------------------------------------------------------------------------------

CI_SAMPLE = """name: CI
on:
  push:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Install
        run: npm ci
  eve-runtime:
    name: eve-runtime ${{ matrix.shard }}/2
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
    steps:
      - run: echo
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo
"""
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys, base64
a = sys.argv[1:]; w = json.load(open(os.environ["GATE_WORLD"]))
path = [x for x in a if not x.startswith("-") and x not in ("api",)][-1]
open(os.environ["GATE_WORLD"] + ".calls", "a").write(" ".join(a) + "\n")
if w.get("down"): print("gh: HTTP 502", file=sys.stderr); sys.exit(1)
if "/actions/runs" in path: print(json.dumps({"workflow_runs": w.get("runs", [])})); sys.exit(0)
if "/check-runs" in path: print(json.dumps({"check_runs": w.get("checks", [])})); sys.exit(0)
if path.endswith("/status"): print(json.dumps({"statuses": w.get("statuses", []), "state": w.get("combined", "pending")})); sys.exit(0)
if "/contents/" in path:
    if w.get("ci"): print(json.dumps({"content": base64.b64encode(w["ci"].encode()).decode()})); sys.exit(0)
    print("gh: Not Found (HTTP 404)", file=sys.stderr); sys.exit(1)
sys.exit(1)
'''


def self_test():
    import shutil, subprocess, tempfile
    import services
    fails, n = [], [0]
    def ok(cond, what, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{what}{': ' + str(detail)[:300] if detail else ''}")
    got = required_checks(CI_SAMPLE)
    ok(got == [("verify", ["verify"]), ("eve-runtime", ["eve-runtime 1/2", "eve-runtime 2/2"]), ("build", ["build"])],
       "ci.yml: jobs by id, a named matrix job once per combination", got)
    ok(required_checks("jobs:\n  t:\n    strategy:\n      matrix:\n        node: [20, 24]\n") == [("t", ["t (20)", "t (24)"])],
       "  ...an unnamed matrix job as GitHub names it")
    real = os.path.join(ROOT, "molds", "mold_v1", "codebase", WORKFLOW)
    if os.path.isfile(real):
        names = [x for _, ns in required_checks(open(real).read()) for x in ns]
        ok(len(names) >= 2 and len(set(names)) == len(names), "the mold's own ci.yml parses into distinct check names", names)
    sha = "a" * 40; other = "b" * 40
    with tempfile.TemporaryDirectory() as d:
        st = os.path.join(d, "state"); os.makedirs(st)
        json.dump({"molds": [{"mold_id": "m1", "source": {"commit": sha}}, {"mold_id": "m2"}]}, open(os.path.join(st, "factory.json"), "w"))
        local = os.path.join(d, "local.json")
        json.dump({"mold_sources": {"m1": "https://github.com/acme/base.git", "m2": "https://github.com/acme/base.git"}}, open(local, "w"))
        reh = os.path.join(d, "reh"); b = os.path.join(reh, "bin"); os.makedirs(b)
        open(os.path.join(b, "gh"), "w").write(FAKE_GH.replace("#!/usr/bin/env python3", "#!" + sys.executable)); os.chmod(os.path.join(b, "gh"), 0o755)
        world = os.path.join(d, "world.json")
        old_env = dict(os.environ); old_reh = services.REHEARSAL
        os.environ.update(FACTORY_LOCAL=local, GATE_WORLD=world, FACTORY_REHEARSAL=reh)
        services.REHEARSAL = reh; services._ACTIVE = False; services.activate()   # the fake `gh` first on PATH; any other outside name refuses
        try:
            def world_is(**w): json.dump(dict({"ci": CI_SAMPLE}, **w), open(world, "w"))
            def run(status="completed", conclusion="success", sid=7, event="push", head=sha):
                return {"id": 1, "path": WORKFLOW, "head_sha": head, "status": status, "conclusion": conclusion, "check_suite_id": sid, "event": event}
            def cr(name, status="completed", conclusion="success", sid=7):
                return {"name": name, "status": status, "conclusion": conclusion, "check_suite": {"id": sid}}
            all_green = [cr("verify"), cr("eve-runtime 1/2"), cr("eve-runtime 2/2"), cr("build")]
            world_is(runs=[run()], checks=all_green)
            v = check("m1", state_dir=st)
            ok(v["state"] == "green" and v["ok"] and "4 checks" in v["message"], "every job of ci.yml passed: green", v)
            calls = open(world + ".calls").read()
            ok(f"head_sha={sha}" in calls and f"commits/{sha}/check-runs" in calls and f"ref={sha}" in calls,
               "  ...asked for EXACTLY the pinned commit (runs, check runs and ci.yml at that ref)", calls)
            ok("acme/base" in calls and "--hostname" not in calls, "  ...of the source named on this machine")
            world_is(runs=[run(conclusion="failure")], checks=[cr("verify"), cr("eve-runtime 1/2"), cr("eve-runtime 2/2", conclusion="failure"), cr("build")])
            v = check("m1", state_dir=st)
            ok(v["state"] == "red" and "eve-runtime 2/2 (failure)" in v["message"], "a failed check: red, and the message names it", v)
            world_is(runs=[run(status="in_progress", conclusion=None)], checks=[cr("verify"), cr("eve-runtime 1/2", status="in_progress", conclusion=None)])
            v = check("m1", state_dir=st)
            ok(v["state"] == "pending" and "still running" in v["message"] and "eve-runtime 1/2" in v["message"], "a run still going: pending, naming what runs", v)
            world_is(runs=[run(status="queued", conclusion=None)], checks=[])
            ok(check("m1", state_dir=st)["state"] == "pending", "  ...queued with nothing reported yet: pending")
            world_is(runs=[run()], checks=[cr("verify"), cr("eve-runtime 1/2"), cr("build")])
            v = check("m1", state_dir=st)
            ok(v["state"] == "red" and "eve-runtime 2/2 never reported" in v["message"], "a finished run missing a required job: red, named", v)
            world_is(runs=[run()], checks=all_green + [cr("verify", conclusion="failure", sid=99)])
            ok(check("m1", state_dir=st)["state"] == "green", "a failed check of ANOTHER suite (a PR run of the same commit) is not this run's")
            world_is(runs=[run(head=other)], checks=all_green)
            ok(check("m1", state_dir=st)["state"] == "missing", "a run of another commit never stands in for this one")
            world_is(runs=[], checks=[])
            v = check("m1", state_dir=st)
            ok(v["state"] == "missing" and "have not run" in v["message"], "no run for the commit: missing", v)
            world_is(down=True)
            ok(check("m1", state_dir=st)["state"] == "unverifiable", "GitHub not answering: unverifiable, never green")
            ok(check("m2", state_dir=st)["state"] == "unverifiable", "no pinned commit: unverifiable")
            json.dump({}, open(local, "w"))
            ok("mold_sources" in check("m1", state_dir=st)["message"], "no source on this machine: unverifiable, and says where it is named")
            json.dump({"mold_sources": {"m1": "https://github.com/acme/base.git"}}, open(local, "w"))
            # require(): the refusal, the override with its reason, and the record
            adir = os.path.join(d, "app"); os.makedirs(adir)
            app = {"mold_id": "m1"}; infra = {"target": "vercel"}; said = []
            world_is(runs=[run(conclusion="failure")], checks=[cr("verify", conclusion="failure")])
            try: require("app1", app, infra, adir, ["app1", "--deploy"], state_dir=st, say=said.append); ok(False, "red CI refuses the deploy")
            except SystemExit as e:
                ok("not deploying" in str(e) and "verify (failure)" in str(e) and FLAG in str(e), "red CI refuses the deploy, naming the check and the way round", e)
            rec = json.load(open(os.path.join(adir, "infrastructure.json")))["deploy_gate"]
            ok(rec["verdict"] == "red" and rec["commit"] == sha and "override" not in rec, "  ...and the refusal is recorded", rec)
            world_is(runs=[run(status="in_progress", conclusion=None)], checks=[cr("verify", status="in_progress", conclusion=None)])
            try: require("app1", app, infra, adir, ["app1", "--deploy-remote"], state_dir=st, say=said.append); ok(False, "pending CI refuses")
            except SystemExit as e: ok("still running" in str(e) and "--deploy-remote" in str(e), "pending CI refuses the deploy (vm_remote wording too)", e)
            try: require("app1", app, infra, adir, ["app1", "--deploy", FLAG], state_dir=st, say=said.append); ok(False, "an override needs a reason")
            except SystemExit as e: ok("needs a reason" in str(e), "an override with no reason is refused", e)
            v = require("app1", app, infra, adir, ["app1", "--deploy", FLAG, "CI outage; hotfix"], state_dir=st, say=said.append)
            rec = json.load(open(os.path.join(adir, "infrastructure.json")))["deploy_gate"]
            ok(v["state"] == "pending" and rec["override"]["reason"] == "CI outage; hotfix" and "deploying anyway" in said[-1],
               "an override with a reason goes on, recorded in state and said aloud", (rec, said[-1:]))
            world_is(runs=[run()], checks=all_green)
            v = require("app1", app, infra, adir, ["app1", "--deploy"], state_dir=st, say=said.append)
            rec = json.load(open(os.path.join(adir, "infrastructure.json")))["deploy_gate"]
            ok(v["ok"] and rec["verdict"] == "green" and "override" not in rec, "green: goes on, recorded, no stale override kept", rec)
            # ---- mold_v0-040: an IN-TREE mold reads THIS repository's checks for the commit being deployed ----
            fr = os.path.join(d, "factory"); fst = os.path.join(fr, "state"); fcb = os.path.join(fr, "molds", "m0", "codebase")
            os.makedirs(fst); os.makedirs(os.path.join(fcb, "src"))
            open(os.path.join(fcb, "src", "a.ts"), "w").write("a\n"); open(os.path.join(fcb, ".gitignore"), "w").write("node_modules/\ndist/\n.env\n")
            json.dump({"molds": [{"mold_id": "m0", "source": {"commit": other}}, {"mold_id": "m1", "source": {"commit": sha}}]}, open(os.path.join(fst, "factory.json"), "w"))
            mj = {"mold_id": "m0", "source": {"in_tree": True, "since": "x", "ci": {"workflow": None}}, "compose": {"source_excludes": ["node_modules", ".env"]}}
            json.dump(mj, open(os.path.join(fr, "molds", "m0", "mold.json"), "w"))
            json.dump({"mold_sources": {"m0": "https://github.com/acme/base.git", "m1": "https://github.com/acme/base.git"}}, open(local, "w"))
            def g(*argv):
                r = subprocess.run(["git", "-C", fr, "-c", "user.name=t", "-c", "user.email=t@example.com", *argv], capture_output=True, text=True)
                assert r.returncode == 0, (argv, r.stderr); return r.stdout.strip()
            g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "fork"); head = g("rev-parse", "HEAD")
            open(world + ".calls", "w").close()
            world_is(checks=[cr("factory self-tests"), cr("lint", conclusion="skipped")], statuses=[], combined="pending")
            v = check("m0", state_dir=fst)
            ok(v["state"] == "unverifiable" and "origin" in v["message"] and v.get("source") == "factory" and "/check-runs" not in open(world + ".calls").read(),
               "in-tree: a checkout with no GitHub origin: unverifiable (never the mold's old source instead)", v)
            g("remote", "add", "origin", "https://github.com/acme/factory.git"); open(world + ".calls", "w").close()
            v = check("m0", state_dir=fst); calls = open(world + ".calls").read()
            ok(v["state"] == "green" and v["commit"] == head and "every check GitHub reports" in v["message"] and "mold_v0-001" in v["message"],
               "in-tree: this repository's checks for HEAD all passed: green, and the verdict says what it read", v)
            ok(v["state"] == "green" and f"repos/acme/factory/commits/{head}/check-runs" in calls and f"repos/acme/factory/commits/{head}/status" in calls and "acme/base" not in calls,
               "  ...with an origin: that repository, that commit, check runs and statuses", calls)
            world_is(checks=[], statuses=[], combined="pending")
            v = check("m0", state_dir=fst)
            ok(v["state"] == "missing" and FLAG in v["message"] and "mold_v0-001" in v["message"], "in-tree: no checks at all for the commit: missing, never green", v)
            world_is(checks=[cr("factory self-tests"), cr("lint", conclusion="failure")])
            ok(check("m0", state_dir=fst)["state"] == "red", "in-tree: one failed check: red")
            world_is(checks=[cr("factory self-tests")], statuses=[{"context": "ext", "state": "failure"}])
            ok(check("m0", state_dir=fst)["state"] == "red", "in-tree: a failed commit status: red")
            world_is(checks=[cr("factory self-tests")], statuses=[{"context": "ext", "state": "pending"}])
            ok(check("m0", state_dir=fst)["state"] == "pending", "in-tree: a status still pending: pending")
            world_is(checks=[cr("factory self-tests", status="in_progress", conclusion=None)])
            ok(check("m0", state_dir=fst)["state"] == "pending", "in-tree: a check still running: pending")
            world_is(down=True)
            ok(check("m0", state_dir=fst)["state"] == "unverifiable", "in-tree: GitHub not answering: unverifiable, never green")
            world_is(checks=[cr("factory self-tests")])
            open(os.path.join(fcb, "src", "a.ts"), "w").write("edited, not committed\n"); open(world + ".calls", "w").close()
            v = check("m0", state_dir=fst)
            ok(v["state"] == "unverifiable" and "src/a.ts" in v["message"] and "/check-runs" not in open(world + ".calls").read(),
               "in-tree: an uncommitted edit under the codebase: unverifiable, naming it (the checks of HEAD say nothing about it)", v)
            g("checkout", "--", "molds/m0/codebase/src/a.ts")
            os.makedirs(os.path.join(fcb, "dist")); open(os.path.join(fcb, "dist", "x.js"), "w").write("built\n")
            v = check("m0", state_dir=fst)
            ok(v["state"] == "unverifiable" and "dist" in v["message"], "in-tree: an ignored file the deploy would carry (not in source_excludes): unverifiable", v)
            shutil.rmtree(os.path.join(fcb, "dist")); os.makedirs(os.path.join(fcb, "node_modules", "p")); open(os.path.join(fcb, "node_modules", "p", "i.js"), "w").write("1\n")
            open(os.path.join(fcb, ".env"), "w").write("X=1\n")
            ok(check("m0", state_dir=fst)["state"] == "green", "in-tree: installed node_modules and a local .env (source_excludes) do not count")
            open(os.path.join(fcb, "new.ts"), "w").write("n\n")
            ok(check("m0", state_dir=fst)["state"] == "unverifiable", "in-tree: an untracked new file: unverifiable"); os.remove(os.path.join(fcb, "new.ts"))
            mj["source"]["ci"]["workflow"] = ".github/workflows/shell.yml"; json.dump(mj, open(os.path.join(fr, "molds", "m0", "mold.json"), "w"))
            g("add", "-A"); g("commit", "-qm", "name the shell's workflow"); head = g("rev-parse", "HEAD")
            def frun(**k): return dict(run(head=head, **k), path=".github/workflows/shell.yml")
            world_is(runs=[frun()], checks=all_green)
            v = check("m0", state_dir=fst)
            ok(v["state"] == "green" and v["commit"] == head and "shell.yml" in v["message"] and "shell.yml" in v.get("reads", ""), "in-tree with its workflow named: that workflow's run and jobs at HEAD: green", v)
            world_is(runs=[dict(run(head=head), path=WORKFLOW)], checks=all_green)
            ok(check("m0", state_dir=fst)["state"] == "missing", "  ...a run of another workflow never stands in for it")
            world_is(runs=[frun()], checks=[cr("verify"), cr("eve-runtime 1/2"), cr("build")])
            ok(check("m0", state_dir=fst)["state"] == "red", "  ...a job of the named workflow that never reported: red")
            # require(): an in-tree green deploys, recorded with the commit of THIS repository
            world_is(runs=[frun()], checks=all_green); adir0 = os.path.join(d, "app0"); os.makedirs(adir0); infra0 = {}
            v = require("app0", {"mold_id": "m0"}, infra0, adir0, ["app0", "--deploy-remote"], state_dir=fst, say=said.append)
            rec = json.load(open(os.path.join(adir0, "infrastructure.json")))["deploy_gate"]
            ok(v["ok"] and rec["verdict"] == "green" and rec["commit"] == head and "override" not in rec, "in-tree: require() goes on, recording this repository's commit", rec)
            mj["source"]["ci"]["workflow"] = None; json.dump(mj, open(os.path.join(fr, "molds", "m0", "mold.json"), "w")); g("add", "-A"); g("commit", "-qm", "unname")
            world_is(checks=[], statuses=[])
            try: require("app0", {"mold_id": "m0"}, infra0, adir0, ["app0", "--deploy"], state_dir=fst, say=said.append); ok(False, "in-tree missing refuses")
            except SystemExit as e: ok("not deploying" in str(e) and "no checks" in str(e), "in-tree: no checks: the deploy is refused", e)
            v = require("app0", {"mold_id": "m0"}, infra0, adir0, ["app0", "--deploy", FLAG, "no shell CI yet"], state_dir=fst, say=said.append)
            ok(v["state"] == "missing" and json.load(open(os.path.join(adir0, "infrastructure.json")))["deploy_gate"]["override"]["reason"] == "no shell CI yet",
               "in-tree: --allow-unverified-mold still works, recorded")
            # the in-tree flag in state/factory.json alone; an unreadable mold.json; a sourced mold beside it
            json.dump({"mold_id": "m0"}, open(os.path.join(fr, "molds", "m0", "mold.json"), "w"))
            fj = json.load(open(os.path.join(fst, "factory.json"))); fj["molds"][0]["source"]["in_tree"] = True; json.dump(fj, open(os.path.join(fst, "factory.json"), "w"))
            g("add", "-A"); g("commit", "-qm", "flag in factory.json only"); world_is(checks=[cr("factory self-tests")])
            ok(check("m0", state_dir=fst).get("source") == "factory", "in-tree: state/factory.json alone saying in_tree is enough")
            open(os.path.join(fr, "molds", "m0", "mold.json"), "w").write("{ broken")
            ok(check("m0", state_dir=fst)["state"] == "unverifiable", "an unreadable mold.json: unverifiable, never read as a sourced mold")
            world_is(runs=[run()], checks=all_green); open(world + ".calls", "w").close()
            v = check("m1", state_dir=fst)
            ok(v["state"] == "green" and "acme/base" in open(world + ".calls").read() and v.get("source") is None, "a sourced mold beside it still reads its own source's ci.yml", v)
        finally:
            os.environ.clear(); os.environ.update(old_env); services.REHEARSAL = old_reh; services._ACTIVE = False
    if fails:
        print("deploy_gate self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"deploy_gate self-test: {n[0]} checks passed"); return 0


def main(a):
    if a[:1] == ["--self-test"]: return self_test()
    if not a or a[0].startswith("-"): print(__doc__); return 2
    commit = a[a.index("--commit") + 1] if "--commit" in a and a.index("--commit") + 1 < len(a) else None
    v = check(a[0], commit=commit)
    if "--json" in a: print(json.dumps(v, indent=2))
    else: print(f"{v['state']}: {v['message']}")
    return 0 if v["ok"] else 1


if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
