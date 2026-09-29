#!/usr/bin/env python3
"""Provision: validated application state -> running deployment.

  provision.py <app_id> [--check] [--deploy] [--set-secret NAME] [--verify-db] [--verify-rls]
  provision.py --self-test   offline checks of the deadlines, deploy watch and VM-headroom logic

--check (default): READ-ONLY. On target=vercel it creates NOTHING remote: it reads which of the three
  projects exist (GET /v9/projects), which secret names are set on <proj> (`vercel env ls`), which spare
  Neon resources and Blob store the team has (list calls), whether a project is still git-linked, and
  prints (a) what is missing, (b) the secrets the operator must set, and (c) exactly what a deploy WILL
  create. No project, database, Blob store, scratch project or env var is created, deleted or written
  (mold_v1-041: it used to call ensure_projects and provision_datastores before counting a secret, so a
  "check" built real, billable, team-visible resources). Exit 0 = ready for --deploy, 1 = the operator
  still has to set a secret. On target=vm it regenerates infra/vm/apps/<app_id>/ (local files only).
--set-secret NAME: type one credential at a hidden prompt; written encrypted to all three projects.
  On a vercel app whose projects do not exist yet, it CREATES them first (three empty, free projects
  with no deployment — the value needs somewhere to live) and says so before it does.
--deploy: prints the plan — EVERYTHING the run creates, writes or rotates, in the order it happens: the
  projects, the database resource, the Blob store, the minted env, the build-time env writes, the
  TASK_WORKFLOW_SERVICE_TOKEN mint, the schema bring-up with its app_rw password rotation, the three
  production deployments with their framework PATCHes and URL env writes, and the state files
  (mold_v1-056: it used to name the first four only) — then, if every operator-set secret is present,
  does them. If one is missing it refuses BEFORE creating anything and lists the --set-secret commands.
  --check prints the same list as `a deploy will create:`. Resource creation lives here and in
  --verify-db only; the check never creates.
--verify-db: stand up this app's LOCAL database (private docker network, no host port) and run
  the whole mold chain against it — push, migrate, RLS + app_rw bootstrap, task-workflow — then
  cover every org-scoped table and PROVE the resulting URL cannot read another workspace's rows.
  Touches nothing remote. Rotates the app_rw password, so it is not a read-only check.
--verify-rls: prove tenant isolation on whatever this app is running RIGHT NOW, and record the
  result in datastores.postgres.rls_verified. Repairs coverage first (add --no-repair to only
  measure). No build, no deploy, no password rotation. Run it after any restore or migration.

NOTHING WAITS FOREVER, AND A BUSY VM IS WAITED OUT (mold_v1-106, -109). Every vercel call has a deadline
and runs in its own process group, killed whole on timeout or on an interrupt. Each `vercel deploy` is
watched on the API: a deployment stuck in QUEUED/INITIALIZING (PROVISION_DEPLOY_STALL_S, 600) or past
PROVISION_DEPLOY_TIMEOUT_S (2400) is CANCELLED on Vercel and the run fails saying how long it waited.
--deploy first waits (PROVISION_HEADROOM_WAIT_S, 900) for load <= PROVISION_MAX_LOAD (CPU count) and
MemAvailable >= PROVISION_MIN_FREE_MB (3072), naming the busiest processes, and refuses before touching
anything if the box stays busy. The eve build runs under `nice` with a V8 heap ceiling and, if the kernel
kills it for memory (exit 137), waits and retries once. SIGTERM/SIGHUP unwind into the revert record, which
says which services this run actually replaced and which still serve their previous deployment.

TENANT ISOLATION IS A GATE, NOT A LABEL. datastores.postgres.rls says what the application asked
for: "fail_closed" and "on" are enforced — the deploy stops and the app is recorded `reverted`
rather than `stamped` if a workspace can read another workspace's rows — while "off" is measured
and recorded but never enforced. DATABASE_URL is written in exactly one place, after the proof.

ONE COMMITTED DEPLOY TARGET: vercel. `target: vm` is a LOCAL VERIFICATION target — it generates
the app's datastore artifact and runs the lanes against it; it does not serve the application.
See infra/vm/README.md for why (three deployables, four crons and a Vercel-injected OIDC identity
the mold cannot get off Vercel without a fork, which HARD RULE 1 forbids). A vm app therefore ENDS at
--verify-db, and --deploy says so immediately; it requires postgres.provider self_hosted, because the
only artifact this lane builds is that local database and the artifact must match the state.

DATABASE: the free path is Neon on the Vercel Marketplace. Supabase's free tier is exhausted;
Neon's is not, and an unattached Neon resource already sits on this team, so app #2 costs nothing.
`self_hosted` means a Postgres on a PRIVATE docker network with no host port — never a public one.
"""
import json, os, re, sys, subprocess, datetime, shutil, tempfile, urllib.parse, time, signal
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state")
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
def sh(cmd, cwd=None, check=True):
    r = vrun(cmd, shell=True, cwd=cwd)
    if check and r.returncode: sys.exit(f"$ {cmd}\n{r.stdout}{r.stderr}")
    return r.stdout

# ---- every external call has a deadline (mold_v1-106) ------------------------------------------------
# A `vercel deploy` whose deployment sat at UNKNOWN on Vercel made the CLI wait 2h14m (2026-09-23), with
# application.json parked at `stamping` until the process was force-killed. subprocess.run(timeout=) alone
# does not fix that: it kills the SHELL, and `communicate()` then waits on pipes the node grandchild still
# holds open. So every call runs in its own process group, and a timeout (or an interrupt of provision.py
# itself) kills the whole group. Limits are seconds and overridable by environment for a slow day.
VERCEL_CALL_TIMEOUT_S = int(os.environ.get("PROVISION_VERCEL_CALL_TIMEOUT_S") or 300)   # api / env / project calls
DEPLOY_TIMEOUT_S = int(os.environ.get("PROVISION_DEPLOY_TIMEOUT_S") or 2400)           # one `vercel deploy`, end to end
DEPLOY_STALL_S = int(os.environ.get("PROVISION_DEPLOY_STALL_S") or 600)                # QUEUED/INITIALIZING/UNKNOWN unchanged this long = stuck
DEPLOY_POLL_S = float(os.environ.get("PROVISION_DEPLOY_POLL_S") or 20)
BUILD_TIMEOUT_S = int(os.environ.get("PROVISION_BUILD_TIMEOUT_S") or 2400)             # the local eve build
SHIPPED = []   # (deployable, url) replaced in production by THIS run, in order: what an interrupted deploy really changed

def _fmt_s(s):
    m, s = divmod(int(s), 60)
    return f"{m}m{s:02d}s" if m else f"{s}s"

def _kill_tree(p):
    try: os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError): pass

def _label(cmd):
    s = cmd if isinstance(cmd, str) else " ".join(map(str, cmd))
    return re.sub(r"://[^@\s/]+@", "://***@", s)[:160]

def vrun(cmd, shell=None, cwd=None, env=None, input=None, capture_output=True, text=True, timeout=None, what=None):
    """subprocess.run with a deadline that holds: own process group, the whole group killed on timeout or
    on any interrupt of this process. A timeout is a clear SystemExit naming the call and the elapsed time."""
    shell = isinstance(cmd, str) if shell is None else shell
    timeout = VERCEL_CALL_TIMEOUT_S if timeout is None else timeout
    t0 = time.monotonic()
    pipe = subprocess.PIPE if capture_output else None
    p = subprocess.Popen(cmd, shell=shell, cwd=cwd, env=env, text=text, start_new_session=True,
                         stdin=subprocess.PIPE if input is not None else None, stdout=pipe, stderr=pipe)
    try:
        out, err = p.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(p)
        try: p.communicate(timeout=10)
        except Exception: pass
        sys.exit(f"{what or _label(cmd)} did not finish: timed out after {_fmt_s(time.monotonic() - t0)} "
                 f"(limit {_fmt_s(timeout)}) and was killed. Nothing after it ran.")
    except BaseException:
        _kill_tree(p); raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)

def _deployment_state(host, cwd):
    """(readyState, id) of one deployment, read from the API; (None, None) when the read itself fails."""
    try:
        r = vrun(f"vercel api /v13/deployments/{host} --raw", cwd=cwd, timeout=60)
        d = json.loads(r.stdout or "{}")
        return (d.get("readyState") or d.get("status")), d.get("id")
    except (SystemExit, ValueError):
        return None, None

def _cancel_deployment(ref, cwd):
    """Cancel a deployment that will not finish, so it cannot go live later behind a `reverted` record."""
    dep_id = ref if str(ref).startswith("dpl_") else _deployment_state(ref, cwd)[1]
    if not dep_id: return f"Could not look up {ref} to cancel it; cancel it by hand in the Vercel dashboard (Deployments -> ... -> Cancel)."
    try: r = vrun(f"vercel api /v12/deployments/{dep_id}/cancel -X PATCH --raw", cwd=cwd, timeout=60)
    except SystemExit as e: return f"Cancelling {dep_id} did not answer ({e}); cancel it by hand in the Vercel dashboard."
    if r.returncode or '"error"' in (r.stdout or ""):
        return f"Cancelling {dep_id} was refused: {(r.stdout + r.stderr).strip()[-200:]}"
    return f"Cancelled {dep_id} on Vercel, so it cannot go live later."

WAITING_STATES = (None, "UNKNOWN", "QUEUED", "INITIALIZING")
class _DeployStopped(SystemExit):
    """The watcher's own verdict (already killed and cancelled), as distinct from a SIGTERM's SystemExit."""
def vercel_deploy(cmd, cwd, label, env=None, timeout=None, stall=None, poll=None, quiet=False):
    """One `vercel deploy`, watched: the deployment it creates is polled on the API, a deployment that sits
    in a waiting state for `stall` seconds or runs past `timeout` is cancelled and the CLI killed, and an
    ERROR/CANCELED one ends the wait at once. Returns the CLI's output (stdout+stderr) on success."""
    timeout = timeout or DEPLOY_TIMEOUT_S; stall = stall or DEPLOY_STALL_S; poll = poll or DEPLOY_POLL_S
    t0 = time.monotonic()
    log = tempfile.TemporaryFile(mode="w+")
    p = subprocess.Popen(cmd, shell=True, cwd=cwd, env=env, text=True, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    host = dep_id = state = None; since = last_note = t0
    def output():
        log.seek(0); return log.read()
    def stop(why, cancel=True):
        _kill_tree(p)
        note = _cancel_deployment(dep_id or host, cwd) if cancel and (dep_id or host) else ""
        return _DeployStopped(f"{label} failed after {_fmt_s(time.monotonic() - t0)}: {why}. {note}\n" + output().strip()[-1500:])
    try:
        while True:
            try:
                p.wait(timeout=poll); break
            except subprocess.TimeoutExpired: pass
            now = time.monotonic()
            if not host:
                m = re.search(r"https://([a-z0-9.-]+\.vercel\.app)", output())   # the CLI prints the new deployment's URL first
                if m: host = m.group(1)
            if host:
                st, did = _deployment_state(host, cwd)
                dep_id = did or dep_id
                if st and st != state: state, since = st, now
                if state in ("ERROR", "CANCELED"): raise stop(f"Vercel reports the deployment {host} as {state}", cancel=False)
            # Stuck = the API itself reports a waiting state that has not moved, or the CLI never named a
            # deployment at all (given twice as long: an upload of the prebuilt eve output is slow). A host
            # whose state cannot be READ is not evidence of anything and is bounded by `timeout` alone.
            if host and state in WAITING_STATES and state is not None and now - since > stall:
                raise stop(f"the deployment {host} sat at {state} for {_fmt_s(now - since)} without moving (limit {_fmt_s(stall)})")
            if not host and now - t0 > 2 * stall:
                raise stop(f"the CLI named no deployment (not created yet) in {_fmt_s(now - t0)} (limit {_fmt_s(2 * stall)})")
            if now - t0 > timeout:
                raise stop(f"no result within {_fmt_s(timeout)} (deployment {host or 'not created'}, last state {state or 'UNKNOWN'})")
            if not quiet and now - last_note >= 60:
                print(f"  {label}: {_fmt_s(now - t0)} elapsed, deployment {state or 'not reported yet'}", flush=True); last_note = now
    except _DeployStopped:
        raise
    except BaseException:
        # Ctrl-C / SIGTERM (a SystemExit from _on_signal) of provision.py mid-deploy: do not leave a --prod deployment running that could
        # go live after the app is recorded reverted.
        _kill_tree(p)
        if dep_id or host: print("  " + _cancel_deployment(dep_id or host, cwd), flush=True)
        raise
    out = output()
    if p.returncode: raise SystemExit(f"{label} failed after {_fmt_s(time.monotonic() - t0)}:\n" + out.strip()[-1500:])
    return out

# ---- a busy VM is waited out, not crashed into (mold_v1-109) ------------------------------------------
# `npm run build:eve` (vercel build of the eve API, the one build that runs HERE) was SIGKILLed by the
# kernel (exit 137) at load 5.8 with 2GB free, three agents building on the same 4-vCPU box. So: before a
# deploy starts, and again before that build, wait (bounded, with progress naming what is using the box)
# for the load and available memory to come under thresholds; run the build under `nice` with a V8 heap
# ceiling; and treat exit 137 as the machine's fault, not the app's: wait again and retry once.
HEADROOM_LOAD = float(os.environ.get("PROVISION_MAX_LOAD") or (os.cpu_count() or 4))
HEADROOM_MEM_MB = int(os.environ.get("PROVISION_MIN_FREE_MB") or 3072)
HEADROOM_WAIT_S = int(os.environ.get("PROVISION_HEADROOM_WAIT_S") or 900)

def _machine():
    """(1-minute load, MemAvailable in MB)."""
    load1 = os.getloadavg()[0]
    avail = 0
    try:
        for l in open("/proc/meminfo"):
            if l.startswith("MemAvailable:"): avail = int(l.split()[1]) // 1024; break
    except OSError: pass
    return load1, avail

def _busiest(n=3):
    """The top memory users, for the progress line. Command lines are shortened and scrubbed: another
    process's argv can carry a connection string, and this line is printed."""
    try:
        out = subprocess.run(["ps", "-eo", "rss=,args=", "--sort=-rss"], capture_output=True, text=True, timeout=10).stdout
    except Exception: return "unknown"
    rows = []
    for l in out.splitlines()[:n]:
        rss, _, args = l.strip().partition(" ")
        args = re.sub(r"://[^@\s/]+@", "://***@", args)
        args = re.sub(r"[A-Za-z0-9_\-+/=]{32,}", "…", args)[:70]
        rows.append(f"{args} ({int(rss) // 1024}MB)")
    return "; ".join(rows) or "unknown"

def wait_for_headroom(label, deadline_s=None, probe=_machine, sleep=time.sleep, every=30):
    """Block until load <= HEADROOM_LOAD and available memory >= HEADROOM_MEM_MB, or the deadline passes.
    Returns (ok, 'load X, Y MB available'). Prints a line every `every` seconds while it waits."""
    deadline_s = HEADROOM_WAIT_S if deadline_s is None else deadline_s
    waited = 0
    while True:
        load1, avail = probe()
        now = f"load {load1:.1f} (limit {HEADROOM_LOAD:g}), {avail}MB available (need {HEADROOM_MEM_MB}MB)"
        if load1 <= HEADROOM_LOAD and avail >= HEADROOM_MEM_MB: return True, now
        if waited >= deadline_s: return False, now
        if waited % max(every, 1) == 0:
            print(f"  waiting for the VM before {label}: {now}; {_fmt_s(waited)} of {_fmt_s(deadline_s)}. "
                  f"Busiest: {_busiest()}", flush=True)
        step = min(every, max(deadline_s - waited, 1)); sleep(step); waited += step

def _node_options(avail_mb, current=""):
    """A V8 old-space ceiling sized to what is free: half of it, clamped to 2-4GB, unless one is already set."""
    if "max-old-space-size" in (current or ""): return current
    mb = max(2048, min(4096, avail_mb // 2))
    return f"{current} --max-old-space-size={mb}".strip()

def _oom_killed(r):
    text = (r.stdout or "") + (r.stderr or "")
    return r.returncode in (137, -9) or (r.returncode != 0 and bool(re.search(r"\bKilled\b|exit(?:ed with| code)? 137|SIGKILL", text)))

def heavy_build(cmd, cwd, label, env=None, wait=wait_for_headroom, runner=None, timeout=None):
    """Run a build that can exhaust this VM: after waiting for headroom, under `nice`, with a heap ceiling,
    retried once after another wait if the kernel killed it for memory. Returns the CompletedProcess."""
    runner = runner or (lambda c, e: vrun(c, shell=True, cwd=cwd, env=e, timeout=timeout or BUILD_TIMEOUT_S, what=label))
    for attempt in (1, 2):
        ok, now = wait(label)
        if not ok: print(f"  WARNING: building anyway, the VM is still busy after the wait ({now})", flush=True)
        e = dict(env if env is not None else os.environ)
        e["NODE_OPTIONS"] = _node_options(_machine()[1], e.get("NODE_OPTIONS", ""))
        r = runner(f"nice -n 10 {cmd}", e)
        if not r.returncode or not _oom_killed(r): return r
        load1, avail = _machine()
        msg = (f"{label} was killed by the kernel for lack of memory (exit {r.returncode}) at load {load1:.1f} with "
               f"{avail}MB available: other work on this VM, not a defect of the application")
        if attempt == 1: print(f"  {msg}; waiting for headroom and retrying once", flush=True)
        else: r.stderr = (r.stderr or "") + f"\n{msg}, twice. Run the deploy again when the VM is quieter."
    return r

def vercel_env_names(cwd, project):
    out = sh(f"NO_COLOR=1 FORCE_COLOR=0 vercel env ls production --project {project} 2>/dev/null", cwd=cwd, check=False)
    # Strip ANSI anyway: under FORCE_COLOR the CLI wraps each name in bold codes, whose trailing 'm' made
    # isupper() false for EVERY name, so a project with all its secrets set read as "0 present" (2026-09-19).
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    return {l.split()[0] for l in out.splitlines() if l.strip() and l.split()[0].isupper()}

GENERATED = {  # app-internal secrets the factory may mint itself (never external credentials)
  "CRON_SECRET": "openssl rand -hex 32",
  "OPS_SECRETS_KEY": "openssl rand -hex 32",
}
REDACTED = "[SENSITIVE]"   # what `vercel env pull` writes for a write-only variable
def _env_api(project, path, method, body, cwd):
    """Vercel API call with the body on stdin, so secret values never reach argv or a file."""
    return vrun(["vercel", "api", path, "-X", method, "--input", "-", "--raw"], cwd=cwd,
                          input=json.dumps(body), capture_output=True, text=True)

def _env_entries(project, cwd):
    r = vrun(f"vercel api /v9/projects/{project}/env --raw", shell=True, cwd=cwd, capture_output=True, text=True)
    try: return json.loads(r.stdout).get("envs", [])
    except Exception: return []

def _set_env(name, value, cwd, project=None):
    """Create or replace a production value, as `encrypted`.

    Two platform behaviours force this shape. A variable the CLI's `env add` creates is `sensitive`:
    write-only, so `env pull` returns the literal [SENSITIVE] and any later copy of it is garbage.
    And PATCHing a sensitive entry succeeds while changing nothing, which once left DATABASE_URL and
    TASK_WORKFLOW_SERVICE_URL pointing at the wrong place through an entire deploy. Encrypted entries
    can be read back, so a later run can verify them."""
    if value is None or value == "" or value == REDACTED:
        sys.exit(f"refusing to write {name} on {project}: value is empty or redacted")
    project = project or load(os.path.join(cwd, ".vercel/project.json"))["projectId"]
    vrun(f"vercel env rm {name} production --project {project} --yes", shell=True, cwd=cwd, capture_output=True, text=True)   # API DELETE refuses without a confirmation flag
    r = _env_api(project, f"/v10/projects/{project}/env", "POST", {"key": name, "value": value, "type": "encrypted", "target": ["production"]}, cwd)
    if '"error"' in r.stdout or r.returncode: sys.exit(f"could not set {name} on {project}: {(r.stdout + r.stderr).strip()[-200:]}")
    got = [e for e in _env_entries(project, cwd) if e.get("key") == name and "production" in (e.get("target") or [])]
    if not got: sys.exit(f"could not set {name} on {project}: it is absent on readback")
    if any(e.get("type") == "sensitive" for e in got):
        sys.exit(f"could not set {name} on {project}: stored as `sensitive`, so it can never be read back. "
                 "Turn off Team Settings -> Environment Variables -> Sensitive Environment Variables, then rerun.")

def _add_env(name, value, cwd, project):
    """Set only when absent (mints and derived defaults)."""
    if name in vercel_env_names(cwd, project): return
    _set_env(name, value, cwd, project=project)

# The env var whose presence means "this app already has a database".
# This used to be the literal "SUPABASE_URL" for every app — a name that appears NOWHERE in the mold
# codebase (grep over ts/tsx/mjs/js finds nothing), yet intake wrote it into secrets_derived and
# main() blocked the deploy on it. A non-Supabase app could therefore never satisfy the gate and
# could never deploy. The sentinel is now whatever that provider actually injects.
DB_SENTINEL = {"supabase": "SUPABASE_URL", "neon": "DATABASE_URL_UNPOOLED",
               "rds": "DATABASE_URL", "self_hosted": "POSTGRES_ADMIN_URL"}
# THE ADMIN URL IS THE ONE THE APP'S STATE NAMES, AND NO OTHER. This used to be a chain that preferred
# Supabase's name over Neon's over self-hosted's; a project migrating providers keeps the old provider's
# variables around, and the chain then did every deploy's schema push, bootstrap and coverage on the
# RETIRED database while the isolation proof ran against the new, empty one — four times, on
# 2026-09-13, each failing "password authentication failed" for a role that never existed there.
# main() narrows this to datastores.postgres.admin_url_ref (or the provider's own name) before any
# writer runs; an absent value fails closed as "no usable admin database URL" rather than borrowing.
PROVIDER_ADMIN = {"supabase": "SUPABASE_POSTGRES_URL_NON_POOLING", "neon": "DATABASE_URL_UNPOOLED", "self_hosted": "POSTGRES_ADMIN_URL", "rds": "POSTGRES_ADMIN_URL"}
ADMIN_KEYS = tuple(PROVIDER_ADMIN.values())   # narrowed to ONE name in main(); this default only serves callers that never reach main()

def admin_url(vals):
    """The URL that owns the schema, whichever provider named it.

    DATABASE_URL is deliberately last: after bootstrap_database it is app_rw, which owns no table and
    cannot run DDL. Two copies of this chain used to be hardcoded (run_migrations, deploy_vercel) and
    both knew only Supabase's name for it."""
    return next((vals[k] for k in ADMIN_KEYS if vals.get(k)), "")

def _link_dir(project, mold_dir):
    """A throwaway directory linked to `project`, for CLI commands that act on 'the current project'.
    The mold directory is shared by every agent and is linked to a DIFFERENT app; relinking it would
    point another step at the wrong project, and `vercel integration add` has no --project flag."""
    meta = _project_meta(project, mold_dir)
    if not meta.get("id"): return None
    d = tempfile.mkdtemp(prefix="vercel-link-"); os.makedirs(os.path.join(d, ".vercel"))
    json.dump({"projectId": meta["id"], "orgId": meta.get("accountId"), "projectName": project},
              open(os.path.join(d, ".vercel/project.json"), "w"))
    return d

def ensure_projects(proj, mold_dir):
    """Create this app's three Vercel projects before anything writes to them.

    deploy_vercel's first act is _set_env(..., project=f'{proj}-api'), and the API answers 404 for a
    project that does not exist — so a first deploy of a NEW app could never start. The two projects
    that exist today were created by other means, which is why nobody had hit this."""
    for p in (proj, f"{proj}-api", f"{proj}-workflow"):
        if _project_meta(p, mold_dir).get("id"): continue
        r = vrun(f"vercel project add {p}", shell=True, cwd=mold_dir, capture_output=True, text=True)
        if not _project_meta(p, mold_dir).get("id"):
            sys.exit(f"could not create the Vercel project {p}: " + (r.stdout + r.stderr).strip()[-200:])
        print(f"  created Vercel project {p}")
        # `project add` runs inside the factory checkout and the CLI may auto-connect the new project to
        # that repo; every push would then build the factory root as this app. Unlink it in the same
        # breath it was created, not after the first deploy.
        disconnect_git(p, mold_dir)

def _neon_spares(mold_dir):
    """Every Neon resource on this team that is available and attached to no project."""
    r = vrun("vercel integration list --all --json", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: res = json.loads(r.stdout[r.stdout.index("{"):]).get("resources", [])
    except Exception: res = []
    return [x["name"] for x in res if x.get("product") == "Neon" and x.get("status") == "available" and not x.get("projects")]

def _db_stat(mold_dir, proj, key="DATABASE_URL_UNPOOLED", environment="production"):
    """{tables, policies, size} of the database a project's env points at, or None."""
    vals = pull_env(mold_dir, proj, environment=environment, required=False)
    url = vals.get(key) or vals.get("DATABASE_URL")
    if not url: return None
    r = _node_lib(os.path.join(ROOT, ".claude/scripts/lib/db-tables.mjs"), {"DB_URL": url}, mold_dir)
    try: return json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
    except Exception: return None

def _scratch_project(mold_dir):
    """A throwaway Vercel project with no deployment, no domain and no traffic, whose only job is to
    hold a candidate database's connection string long enough to LOOK at it. Returns its name or None."""
    name = f"sf-neon-inspect-{os.urandom(4).hex()}"
    r = vrun(f"vercel project add {name}", shell=True, cwd=mold_dir, capture_output=True, text=True)
    if _project_meta(name, mold_dir).get("id"): return name
    print("  could not create a temporary inspection project: " + _cli_err(r.stdout + r.stderr)[:160]); return None

SCRATCH_RE = re.compile(r"^sf-neon-inspect-[0-9a-f]{8}$")   # exactly what _scratch_project mints, nothing else
SCRATCH_STALE_S = 30 * 60   # a probe takes seconds; anything this old is a leak, not a run in flight
def _project_gone(project, mold_dir):
    """True ONLY when Vercel says the project does not exist. A lookup that fails for any other reason
    (no network, an expired token -> `Not authorized (403)`, a rate limit) returns False, so the caller
    treats "unknown" as "still there" and says so, rather than reading a blind spot as a deletion."""
    r = vrun(f"vercel api /v9/projects/{project} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    if r.returncode == 0:
        try:
            if json.loads(r.stdout).get("id"): return False
        except Exception: pass
    # The 404 form only. A bare "not found" also matches `/bin/sh: vercel: not found` (no CLI on PATH)
    # and `command not found`, and the measured result of those was True — "deleted" read off a shell
    # error. Vercel's own answer is `Error: Project not found. (404)`; unknown stays "still there".
    return "not found. (404)" in (r.stdout + r.stderr).lower()

def _rm_scratch_project(name, mold_dir):
    """Remove it — and SAY SO if it survives. A leftover inspection project is a leftover database URL.

    Vercel CLI 59.11.7 offers no unattended `project rm`: `--yes` is "unknown or unexpected option",
    `--non-interactive` still prints the `Are you sure? (y/N)` prompt and waits, and piping `yes` into
    it re-asks the question forever on a non-tty. The REST call is refused too unless it is told the
    confirmation was deliberate — `--dangerously-skip-permissions` is Vercel's name for that flag on
    `vercel api`, and it is the ONE deletion that works from a subprocess (measured: a project created
    and deleted this way is gone from `vercel project ls` in the same run). Deleted by name, then by id
    if the name lookup and the delete disagree. Returns True only on a confirmed 404 afterwards: a
    lookup that merely FAILED is not a deletion, and the operator gets the dashboard note instead."""
    for ref in (name, _project_meta(name, mold_dir).get("id") or name):
        vrun(f"vercel api /v9/projects/{ref} -X DELETE --raw --dangerously-skip-permissions",
                       shell=True, cwd=mold_dir, capture_output=True, text=True)
        if _project_gone(name, mold_dir): return True
    print(f"  NOTE: the temporary inspection project {name} could not be confirmed deleted. Check the Vercel "
          f"dashboard (Projects -> {name} -> Settings -> Delete); it holds a database URL and nothing else.")
    return False

def _sweep_scratch_projects(mold_dir):
    """Delete STALE sf-neon-inspect-* projects on the team BEFORE creating another.

    A probe that dies between `project add` and `_rm_scratch_project` (Ctrl-C, OOM, a CLI that could
    not delete — mold_v1-042) leaves a project holding a database URL. Each run pays that debt first,
    so a leak lasts one run, not forever. Only names this file mints (SCRATCH_RE) are touched, and
    only ones older than SCRATCH_STALE_S: this factory fans provisioning out to parallel agents, and a
    sweep that took every match would delete a concurrent run's project mid-probe — with a Neon
    resource still connected to it, and that run then buying a fresh database it did not need. A
    project whose age cannot be read is left alone for the same reason: unknown is not stale."""
    r = vrun('vercel api "/v9/projects?search=sf-neon-inspect-&limit=100" --raw',
                       shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: projects = json.loads(r.stdout).get("projects", [])
    except Exception: projects = []
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    for p in projects:
        n, created = p.get("name", ""), p.get("createdAt")
        if not SCRATCH_RE.match(n) or not isinstance(created, (int, float)): continue
        age = (now_ms - created) / 1000
        if age < SCRATCH_STALE_S:
            print(f"  leaving the inspection project {n} alone: {int(age)}s old, another run may still be using it"); continue
        print(f"  removing the leftover inspection project {n} from an earlier run ({int(age // 60)} min old)")
        _rm_scratch_project(n, mold_dir)

def _neon_probe(name, mold_dir):
    """Is this Neon resource EMPTY? Answered with the app's own project connected to NOTHING.

    Vercel publishes no connection string for a resource attached to no project — `vercel
    integration-resource inspect <name>` returns status, plan and a dashboard link and no credential —
    so the only way to see inside a candidate is to connect it somewhere. It must not be somewhere that
    matters. This connects it to a project created for the purpose, on `development` ONLY (never any
    production environment, and never the app's), reads the table count, disconnects, and deletes the
    project whatever happens. Returns (stat or None, reason)."""
    scratch = _scratch_project(mold_dir)
    if not scratch: return None, "no temporary project to inspect it in"
    try:
        c = vrun(f"vercel integration-resource connect {name} {scratch} -e development --yes",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
        if c.returncode: return None, _cli_err(c.stdout + c.stderr)[:160]
        try:
            st = _db_stat(mold_dir, scratch, environment="development")
            return st, ("" if st else "connecting it injected no database URL")
        finally:
            vrun(f"vercel integration-resource disconnect {name} {scratch} --yes",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
    finally:
        _rm_scratch_project(scratch, mold_dir)

def adopt_or_create_neon(app_id, mold_dir, infra, proj):
    """A free Postgres for this app, with no checkout page.

    Vercel keeps a Marketplace resource on its plan whether or not a project uses it, so the cheapest
    database is one the team already owns and nothing is attached to. Adopt that first; only ask the
    Marketplace for a new one when there is none. This is the whole reason a second app is free:
    Supabase's free tier is exhausted, Neon's is not.

    UNATTACHED IS NOT EMPTY. The first spare on this team held 15 MB and 54 tables of an older copy of
    this very schema; pushing onto it made drizzle-kit ask an interactive rename question and abort.
    `scope: fresh` means fresh, so a candidate is INSPECTED before it is adopted.

    INSPECT FIRST, CONNECT SECOND. That inspection used to run on the app's OWN project: connect with
    -e production -e preview -e development, pull the env, count the tables, disconnect if it turned
    out to hold data. Between those two steps a DATABASE_URL for a stranger's database sat in the
    production environment of a project that may already be serving traffic, and any build started in
    that window — a redeploy, a cron, another agent — would have picked it up. Worse, every failure
    after the connect (the CLI dies, the table read fails, the run is interrupted, the "not empty"
    exit on the create path) left the resource attached. The app's project is now connected to exactly
    one thing: a database already proven empty. Everything before that happens in a project created
    for the inspection and deleted after it."""
    def clear_stale_db_env():
        """Vercel refuses to connect a Marketplace database over an existing DATABASE_URL — and this
        function only runs when no Neon is attached, so any DATABASE_URL here is a leftover of a database
        this app no longer uses (the replica's was the Supabase-era superuser URL, task mold_v1-026). The
        deploy rewrites DATABASE_URL after the isolation proof anyway; clearing it first is the only way
        the connect can succeed. Measured 2026-09-13: both an adoption and a fresh provision were refused
        with "env var DATABASE_URL already exists on project", and the fall-through then provisioned a
        second resource with the same name."""
        for key in ("DATABASE_URL", "DATABASE_URL_UNPOOLED"):
            for env_ in ("production", "preview", "development"):
                vrun(f"vercel env rm {key} {env_} --project {proj} --yes", shell=True, cwd=mold_dir,
                               capture_output=True, text=True)
        print(f"  cleared the stale DATABASE_URL on {proj} (a leftover of a database this app no longer uses)")

    def attach(name):
        """Connect a database already PROVEN empty to the app's project, and confirm what landed.
        Anything unexpected disconnects again: the failure path leaves nothing attached."""
        clear_stale_db_env()
        c = vrun(f"vercel integration-resource connect {name} {proj} -e production -e preview -e development --yes",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
        if c.returncode:
            err = _cli_err(c.stdout + c.stderr)
            print("  could not connect it: " + err[:160])
            if "already exists on project" in err:
                # The project, not the resource, is what refused. Provisioning another resource would
                # be refused the same way and leave a duplicate behind (it did, once).
                sys.exit(f"{proj} still refuses a database connection ({err[:120]}). Nothing was provisioned. "
                         f"Remove the conflicting variable in the Vercel dashboard (Settings -> Environment "
                         f"Variables on {proj}) and rerun: python3 .claude/scripts/provision.py {app_id} --deploy")
            return False
        st = _db_stat(mold_dir, proj)
        if st and st.get("tables") == 0:
            infra.setdefault("datastores", {})["neon_resource"] = name; return True
        print(f"  {name} is not usable on {proj} after connecting "
              f"({(st or {}).get('tables', 'no database URL was injected')}); disconnecting it again")
        vrun(f"vercel integration-resource disconnect {name} {proj} --yes",
                       shell=True, cwd=mold_dir, capture_output=True, text=True)
        return False

    _sweep_scratch_projects(mold_dir)
    for name in _neon_spares(mold_dir):
        print(f"inspecting the free Neon database '{name}' (attached to no project) ...")
        st, why = _neon_probe(name, mold_dir)
        if st is None:
            print(f"  could not read it: {why} — leaving it alone ({proj} was not connected to it)"); continue
        if st.get("tables"):
            print(f"  {name} already holds {st['tables']} table(s) ({st.get('size','?')}) — not overwriting it; "
                  f"{proj} was never connected to it"); continue
        print(f"  {name} is empty; connecting it to {proj}")
        if attach(name):
            print(f"  adopted {name}: empty database, free plan, no checkout"); return
    print(f"provisioning a fresh Neon database '{app_id}' via Vercel Marketplace (Free plan) ...")
    urls = os.path.expanduser("~/.factory-open-urls"); open(urls, "w").close()   # the xdg-open shim (infra/vm/provision.sh) records links a CLI tried to open
    res_name = app_id.replace("_", "-")                                          # resource names are dns-ish
    # Created INTO the inspection project, not into the app's. `integration add` connects the new
    # resource to the project linked in its cwd, and a resource the Marketplace hands back is not
    # automatically empty either (a re-used name, a restored branch) — it gets the same read as a spare.
    scratch = _scratch_project(mold_dir)
    if not scratch:
        sys.exit(f"could not create a temporary Vercel project to provision {res_name} into, so nothing was "
                 f"provisioned and {proj} was not touched.\n  Run: python3 .claude/scripts/provision.py {app_id} --check")
    d = _link_dir(scratch, mold_dir)
    try:
        if not d: sys.exit(f"the temporary project {scratch} could not be linked; nothing was provisioned.")
        r = vrun(f"vercel integration add neon -n {res_name} --no-claim --no-env-pull -e development --cwd {d}",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
        out = r.stdout + r.stderr; link_ = next((l.strip() for l in open(urls) if l.strip()), None)
        if "Additional setup required" in out or link_:
            sys.exit("ONE-TIME STEP: open this link in a browser, accept the Neon FREE plan for this project, then run the same command again:\n  "
                     + (link_ or f"https://vercel.com/{infra['vercel']['team']}/~/integrations/checkout/neon?productSlug=neon&defaultResourceName={res_name}&source=cli&projectSlug={proj}"))
        if r.returncode:
            msg = [l for l in out.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
            sys.exit("neon provisioning failed: " + " | ".join(msg[-3:]))
        print("  " + next((l for l in out.splitlines() if "provisioned" in l), "provisioned").strip()[:160])
        vrun(f"vercel integration-resource connect {res_name} {scratch} -e development --yes",
                       shell=True, cwd=mold_dir, capture_output=True, text=True)   # explicit: `add` connects via its cwd
        st = _db_stat(mold_dir, scratch, environment="development")
        vrun(f"vercel integration-resource disconnect {res_name} {scratch} --yes",
                       shell=True, cwd=mold_dir, capture_output=True, text=True)
    finally:
        if d: shutil.rmtree(d, ignore_errors=True)
        _rm_scratch_project(scratch, mold_dir)
    if not st:
        sys.exit(f"the new Neon resource {res_name} produced no database URL, so nothing could check whether it is "
                 f"empty and it was NOT connected to {proj}. Connect it in the Vercel dashboard "
                 f"(Storage -> {res_name} -> Connect Project -> {proj}) and rerun: "
                 f"python3 .claude/scripts/provision.py {app_id} --check")
    if st.get("tables"):
        sys.exit(f"the new Neon database {res_name} is not empty ({st['tables']} tables) — refusing to write over "
                 f"it. Nothing was connected to {proj}. Delete that resource in the Vercel dashboard "
                 f"(Storage -> {res_name} -> Delete) and rerun: python3 .claude/scripts/provision.py {app_id} --check")
    if not attach(res_name):
        sys.exit(f"{res_name} is empty but could not be connected to {proj}. Connect it in the Vercel dashboard "
                 f"(Storage -> {res_name} -> Connect Project -> {proj}) and rerun.")
    print(f"  provisioned {res_name}: empty database, free plan, connected to {proj}")

def _blob_store(name, mold_dir):
    """The team's Blob store of this name, with the projects it is connected to, or None."""
    r = vrun("vercel api /v1/storage/stores --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: st = json.loads(r.stdout).get("stores", [])
    except Exception: st = []
    return next((x for x in st if x.get("type") == "blob" and x.get("name") == name), None)

def _connect_store(store_id, project_id, mold_dir):
    """Attach an existing store to a project, which is what injects its token into that project's env.
    Same endpoint the CLI's own create path uses (connectResourceToProject in the Vercel CLI)."""
    return vrun(["vercel", "api", f"/v1/storage/stores/{store_id}/connections", "-X", "POST", "--input", "-", "--raw"],
                          cwd=mold_dir, capture_output=True, text=True,
                          input=json.dumps({"envVarEnvironments": ["production", "preview", "development"],
                                            "projectId": project_id, "type": "integration"}))

def _cli_err(out):
    """The line a human needs out of a CLI transcript: its `Error:` line, else the last thing it said."""
    return next((l.strip() for l in out.splitlines() if l.strip().startswith("Error")),
                (out.strip().splitlines() or ["the CLI reported nothing"])[-1].strip())

def ensure_blob_store(app_id, mold_dir, infra, proj):
    """A private Blob store CONNECTED TO THIS APP'S PROJECT — the connection is what injects
    BLOB_READ_WRITE_TOKEN, and nothing else in the factory can supply that name.

    `vercel blob create-store` attaches the new store to the project linked in its WORKING DIRECTORY.
    This ran in the mold directory, which is linked to a different app, so the store was created
    attached to nothing, the app's project never received BLOB_READ_WRITE_TOKEN, and --deploy refused
    for ever on a derived secret that no command could produce — the same dead end as the phantom
    SUPABASE_URL gate, one function away from the fix Neon already uses. So: run it in a throwaway link
    dir of THIS app's project, and never leave the run unverified.

    Re-running is idempotent: a second create answers `A blob store named "x" already exists. (409)`
    and still EXITS 0, so the returncode says nothing — the store is looked up by name and connected."""
    name = app_id.replace("_", "-")
    print(f"creating Vercel Blob store '{name}' and connecting it to {proj} ...")
    meta = _project_meta(proj, mold_dir)
    if not meta.get("id"): sys.exit(f"the Vercel project {proj} does not exist yet; rerun --check")
    d = _link_dir(proj, mold_dir)
    try:
        r = vrun(f"vercel blob create-store {name} --access private -e production -e preview -e development --yes --cwd {d}",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
        out = r.stdout + r.stderr
    finally:
        shutil.rmtree(d, ignore_errors=True)   # `create-store` pulls env into its cwd; it must not be the mold
    if "already exists" in out:
        st = _blob_store(name, mold_dir)
        if not st: sys.exit(f"a Blob store named {name} exists on this team but could not be read back; delete it in the dashboard and rerun")
        # `projectId` is the project; `id` on a connection entry is the connection's own id, not the project's
        if any(c.get("projectId") == meta["id"] for c in (st.get("projectsMetadata") or [])):
            print(f"  {name} was already connected to {proj}")
        else:
            c = _connect_store(st["id"], meta["id"], mold_dir)
            bad = '"error"' in c.stdout or c.returncode
            print("  " + (_cli_err(c.stdout + c.stderr)[:160] if bad else f"connected the existing store {name} to {proj}"))
    elif "Success" in out: print("  " + next((l.strip() for l in out.splitlines() if "created" in l.lower()), "created")[:160])
    else: print("  " + _cli_err(out)[:160])                    # neither created nor pre-existing
    infra.setdefault("datastores", {})["blob_store"] = name
    if "BLOB_READ_WRITE_TOKEN" not in vercel_env_names(mold_dir, proj):
        st = _blob_store(name, mold_dir)
        if not st:
            sys.exit(f"could not create the Blob store {name}: {_cli_err(out)[:200]}\n"
                     f"Fix that and rerun: python3 .claude/scripts/provision.py {app_id} --check")
        sys.exit(f"the Blob store {name} exists but {proj} still has no BLOB_READ_WRITE_TOKEN. Run this one command, then rerun:\n"
                 f"  vercel api /v1/storage/stores/{(st or {}).get('id','<store id>')}/connections -X POST --raw "
                 f"""--input - <<< '{{"envVarEnvironments":["production","preview","development"],"projectId":"{meta['id']}","type":"integration"}}'""")
    print(f"  BLOB_READ_WRITE_TOKEN injected into {proj}")

def mint_jwt_pair():
    """The app's ES256 sign-in key pair (lib/auth-session.ts), as (private, public): base64 of PKCS8 / SPKI PEM.
    ONE generator for both stores: provision_datastores writes it to the Vercel env, verify_db to
    infra/vm/apps/<app_id>/.env, so lib/session.py can sign a session for a vm app the same way it does
    for a vercel one (mold_v1-040). Never printed; the values go straight to the store."""
    js = ("const{generateKeyPairSync}=require('crypto');const{publicKey:a,privateKey:b}=generateKeyPairSync('ec',{namedCurve:'P-256'});"
          "console.log(Buffer.from(b.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log(Buffer.from(a.export({type:'spki',format:'pem'})).toString('base64'))")
    priv, pub = subprocess.check_output(["node", "-e", js], text=True).split()
    return priv, pub

def mint_vapid_pair():
    """The app's Web Push (VAPID) key pair, as (public, private): base64url of the 65-byte uncompressed P-256
    point and of the 32-byte private scalar, the shapes agent/lib/web-push.ts reads. Minted ONCE per app and
    kept: a new pair orphans every device already subscribed. Never printed; the values go straight to the store."""
    js = ("const{createECDH}=require('crypto');const e=createECDH('prime256v1');e.generateKeys();"
          "console.log(e.getPublicKey().toString('base64url'));console.log(e.getPrivateKey().toString('base64url'))")
    pub, priv = subprocess.check_output(["node", "-e", js], text=True).split()
    return pub, priv

def owner_email(app_id):
    """The first workspace owner's email in the app's state: the contact push services may use (VAPID_SUBJECT)."""
    try: app = json.load(open(os.path.join(ROOT, "state/application", app_id, "application.json")))
    except Exception: return None
    stack = [app]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            if x.get("role") == "owner" and "@" in str(x.get("email", "")): return x["email"]
            stack.extend(x.values())
        elif isinstance(x, list): stack.extend(x)
    return None

def stable_url(project, url):
    """The project's public production address for a deployment URL.

    `vercel deploy --prod` names the one-off deployment (https://<project>-<hash>-<team>.vercel.app), which
    Vercel Deployment Protection keeps behind a login. Everything the factory records or wires between the
    apps (NEXT_PUBLIC_EVE_API_URL, TASK_WORKFLOW_SERVICE_URL, WEB_ORIGIN, production_url, the health probes)
    must use the public alias https://<project>.vercel.app instead: on 2026-09-29 the one-off addresses were
    recorded and the web app's calls to the agent and workflow service got the login page (HTML), so its
    health read 503 and chats could not reach the agent."""
    # Vercel shortens the project name inside a deployment URL (onfinance-hfc-api -> onfinance-hfc-h0kj2jowi-…),
    # so match any *.vercel.app address that is not the alias itself; a custom domain is left alone.
    if isinstance(url, str) and re.match(r"^https://[a-z0-9-]+\.vercel\.app/?$", url.strip()) and url.strip().rstrip("/") != f"https://{project}.vercel.app":
        return f"https://{project}.vercel.app"
    return url

def provision_datastores(app_id, ds, mold_dir, present, infra, proj):
    """Fresh datastores via Vercel Marketplace, inside the app's own project. Returns names now present."""
    pg, blob = ds.get("postgres", {}), ds.get("blob", {})
    prov = pg.get("provider", "supabase")
    if pg.get("scope") == "fresh" and prov == "neon" and DB_SENTINEL["neon"] not in present:
        adopt_or_create_neon(app_id, mold_dir, infra, proj)
    elif pg.get("scope") == "fresh" and prov not in ("supabase", "neon"):
        sys.exit(f"datastores.postgres.provider={prov!r} has no provisioner for target=vercel. "
                 f'Set it to "neon" (free) in state/application/{app_id}/datastores.json and rerun.')
    if pg.get("scope") == "fresh" and prov == "supabase" and DB_SENTINEL["supabase"] not in present:
        print(f"provisioning fresh Supabase project '{app_id}' via Vercel Marketplace ...")
        urls = os.path.expanduser("~/.factory-open-urls"); open(urls, "w").close()   # the xdg-open shim (infra/vm/provision.sh) records links a CLI tried to open
        r = vrun(f"vercel integration add supabase -n {app_id} --prefix SUPABASE_ --no-claim --no-env-pull -e production -e preview -e development", shell=True, cwd=mold_dir, capture_output=True, text=True)
        out = r.stdout + r.stderr; link_ = next((l.strip() for l in open(urls) if l.strip()), None)
        if "Additional setup required" in out or link_:
            sys.exit("ONE-TIME STEP: open this link in a browser, accept the Supabase plan for this project, then run the same command again:\n  " + (link_ or f"https://vercel.com/{infra['vercel']['team']}/~/integrations/checkout/supabase?productSlug=supabase&defaultResourceName={app_id}&source=cli&projectSlug={infra['vercel']['project']}"))
        if r.returncode:
            msg = [l for l in out.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
            sys.exit("supabase provisioning failed: " + " | ".join(msg[-3:]))
        print("  " + (out.strip().splitlines() or ["ok"])[-1])
        infra.setdefault("datastores", {})["supabase_resource"] = app_id
    if blob.get("provider") == "vercel_blob" and "BLOB_READ_WRITE_TOKEN" not in present:
        ensure_blob_store(app_id, mold_dir, infra, proj)
    present = vercel_env_names(mold_dir, proj)
    for name, cmd in GENERATED.items():
        if name not in present:
            _add_env(name, subprocess.check_output(cmd, shell=True, text=True).strip(), mold_dir, proj); print(f"generated {name}")
    # The pair must be READABLE on the main project: the api project verifies sessions with the public half
    # and gets it by copy at every deploy. A write-only (Sensitive) pair cannot be copied, so the api kept
    # whatever it held — and on 2026-09-14 that was a key the web's sessions were not signed with: every
    # /eve/v1 call as a signed-in person answered 401 while /api/ops/* worked. An unreadable pair is
    # re-minted as encrypted entries (that signs everyone out once; sessions last seven days anyway).
    readable = pull_env(mold_dir, proj, required=False)
    if "AUTH_JWT_PRIVATE_KEY" not in present or not readable.get("AUTH_JWT_PRIVATE_KEY") or not readable.get("AUTH_JWT_PUBLIC_KEY"):
        priv, pub = mint_jwt_pair()
        _set_env("AUTH_JWT_PRIVATE_KEY", priv, mold_dir, project=proj); _set_env("AUTH_JWT_PUBLIC_KEY", pub, mold_dir, project=proj)
        print("generated AUTH_JWT key pair" + ("" if "AUTH_JWT_PRIVATE_KEY" not in present else " (the previous pair was write-only, so it could never reach the api project; every session signed with it is now invalid)"))
    # Web Push keys, only for a mold that sends push (fde-agent #63): minted once, never rotated here.
    if os.path.exists(os.path.join(mold_dir, "agent/lib/web-push.ts")) and not {"VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"} <= present:
        pub, priv = mint_vapid_pair()
        _set_env("VAPID_PUBLIC_KEY", pub, mold_dir, project=proj); _set_env("VAPID_PRIVATE_KEY", priv, mold_dir, project=proj)
        print("generated VAPID key pair (desktop notifications)")
    if os.path.exists(os.path.join(mold_dir, "agent/lib/web-push.ts")) and "VAPID_SUBJECT" not in present and owner_email(app_id):
        _set_env("VAPID_SUBJECT", "mailto:" + owner_email(app_id), mold_dir, project=proj); print("set VAPID_SUBJECT to the workspace owner's contact")
    present = vercel_env_names(mold_dir, proj)
    if "POSTGRES_ADMIN_URL" not in present and "SUPABASE_POSTGRES_URL" in present:
        # NOT DATABASE_URL. This line used to copy SUPABASE_POSTGRES_URL — the pooled URL whose user is
        # `postgres.<ref>`, a BYPASSRLS superuser — into DATABASE_URL, and nothing ever replaced it: three
        # exits sit between here and bootstrap_database (a git-linked project, `--check`, missing secrets),
        # so a run could legitimately leave a SUPERUSER connection string as the app's runtime credential
        # on all three projects and stop. That is precisely how the live app came to report
        # `role postgres — WARNING: BYPASSRLS, row-level security is NOT enforced`.
        # DATABASE_URL is now written in exactly ONE place — bring_up_schema, after the isolation gate
        # passes — so a project that has never been bootstrapped has no DATABASE_URL at all. That fails
        # closed (the app cannot reach the database) instead of failing open (it reaches it as root).
        tmp = os.path.join(mold_dir, ".env.provision")
        vrun(f"vercel env pull --yes --environment=production --project {proj} {tmp}", shell=True, cwd=mold_dir, capture_output=True)
        val = next((l.split("=",1)[1].strip().strip('"') for l in open(tmp) if l.startswith("SUPABASE_POSTGRES_URL=")), "")
        os.remove(tmp)
        if val: _add_env("POSTGRES_ADMIN_URL", val, mold_dir, proj); print("derived POSTGRES_ADMIN_URL (admin only; DATABASE_URL is written by the RLS gate)")
    return vercel_env_names(mold_dir, proj)

# Set during --deploy, so `--check` must not report them missing. DATABASE_URL belongs here now that
# nothing else may write it: bring_up_schema mints it from the app_rw bootstrap once the gate passes.
DEPLOY_TIME = ["TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "NEXT_PUBLIC_EVE_API_URL", "MODEL_PROVIDER", "DATABASE_URL"]
# Everything the eve API process (agent/lib/model.ts runs there) may read, for BOTH inference providers.
# The gateway names were absent (mold_v1-051): MODEL_PROVIDER=gateway hands a bare model id to the AI SDK,
# whose gateway provider (@ai-sdk/gateway 4.0.12, dist/index.js:2656) authenticates with AI_GATEWAY_API_KEY,
# and model.ts:114-115 reads GATEWAY_MODEL_ORCHESTRATOR / GATEWAY_MODEL_SPECIALIST (default
# anthropic/claude-sonnet-5) and agentReasoning() GATEWAY_REASONING_EFFORT. Without the key here a gateway
# app passed --check and ran without a credential. intake.py reads this list to refuse a provider whose
# secret is not forwarded; sync_env reports a missing name only when THIS app declares it.
API_ENV = ["AUTH_JWT_PUBLIC_KEY", "BLOB_READ_WRITE_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "AI_GATEWAY_API_KEY",
           "GATEWAY_MODEL_ORCHESTRATOR", "GATEWAY_MODEL_SPECIALIST", "GATEWAY_REASONING_EFFORT", "CRON_SECRET", "DATABASE_URL", "OPS_MULTI_TENANT",
           "MODEL_PROVIDER", "OPS_SECRETS_KEY", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "EXA_API_KEY", "BROWSERBASE_API_KEY",
           "ENABLE_WEB_SEARCH", "ENABLE_BROWSER", "GOOGLE_CLIENT_ID", "CLOUDFLARE_MODEL_ORCHESTRATOR", "CLOUDFLARE_MODEL_SPECIALIST",
           "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]
# Absent means "feature off" or "the mold's default", never a broken deploy.
OPTIONAL_ENV = ("EXA_API_KEY", "BROWSERBASE_API_KEY", "GATEWAY_MODEL_ORCHESTRATOR", "GATEWAY_MODEL_SPECIALIST", "GATEWAY_REASONING_EFFORT",
                "CLOUDFLARE_MODEL_ORCHESTRATOR", "CLOUDFLARE_MODEL_SPECIALIST",
                "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT")
WORKFLOW_ENV = ["DATABASE_URL"]   # TASK_WORKFLOW_SERVICE_TOKEN is minted onto both projects directly, never copied

def vercel_plan(app_id, app, infra, ds, mold_dir, proj, mode="deploy"):
    """What EXISTS for this app on Vercel and EVERYTHING a writer would create, write or rotate, in the
    order it happens. Built from GET and list calls only — this is the whole of what --check may do
    remotely — and --deploy / --verify-db print it before doing any of it. `mode` names the writer whose
    steps are listed: "deploy" (also what --check reports, as `a deploy will create:`) or "verify-db".

    mold_v1-056: this used to stop after the minted env, while the same --deploy went on to write four
    build-time flags to two projects, mint TASK_WORKFLOW_SERVICE_TOKEN, rotate the app_rw password, PATCH
    two projects' framework, create three production deployments and write four URL/env values — none of
    it announced. Every step below is read off deploy_vercel / bring_up_schema / provision_datastores in
    their own order; nothing here calls them."""
    projects = {p: bool(_project_meta(p, mold_dir).get("id")) for p in (proj, f"{proj}-api", f"{proj}-workflow")}
    present = vercel_env_names(mold_dir, proj) if projects[proj] else set()
    pg, blob = ds.get("postgres", {}), ds.get("blob", {}); prov = pg.get("provider", "supabase")
    shared = pg.get("scope") == "shared_with_live"; api, wf = f"{proj}-api", f"{proj}-workflow"
    create = []
    if mode == "deploy" and app.get("surface", {}).get("branding"):
        create.append(f"build/{app_id}/: a branded copy of the mold to build from (local files only; the snapshot is never edited)")
    missing = [p for p, ok in projects.items() if not ok]
    if missing: create.append(f"Vercel project(s) {', '.join(missing)} — empty, free, no deployment, git integration disconnected (also created by --set-secret, which needs them)")
    if pg.get("scope") == "fresh" and prov in DB_SENTINEL and DB_SENTINEL[prov] not in present:
        if prov == "neon":
            spares = _neon_spares(mold_dir)
            create.append(f"a Neon database: clear the stale DATABASE_URL on the project, then adopt one of the team's {len(spares)} unattached resource(s) ({', '.join(spares) or 'none'}) "
                          f"if it is empty, else provision a fresh '{app_id.replace('_', '-')}' on the Marketplace free plan; each candidate is "
                          f"inspected through a temporary sf-neon-inspect-* project, created and deleted in the same run")
        elif prov == "supabase": create.append(f"a Supabase project '{app_id}' on the Marketplace")
        else: create.append(f"nothing for postgres.provider={prov!r}: it has no provisioner on target=vercel and the deploy will refuse")
    if blob.get("provider") == "vercel_blob" and "BLOB_READ_WRITE_TOKEN" not in present:
        name = app_id.replace("_", "-")
        create.append(f"connect the team's existing Blob store '{name}' to {proj}" if _blob_store(name, mold_dir)
                      else f"a private Blob store '{name}', connected to {proj}")
    minted = [n for n in (*GENERATED, "AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY") if n not in present]
    if minted: create.append(f"env on {proj}: {', '.join(minted)} (minted locally; never an external credential)")
    if prov == "supabase" and "POSTGRES_ADMIN_URL" not in present:
        create.append(f"env on {proj}: POSTGRES_ADMIN_URL (copied from SUPABASE_POSTGRES_URL; admin only)")
    if mode == "deploy":
        cfg = {"MODEL_PROVIDER": app.get("model", {}).get("provider", "?"),
               "ENABLE_WEB_SEARCH": str(app.get("capabilities", {}).get("web_search", "?")).lower(),
               "ENABLE_BROWSER": str(app.get("capabilities", {}).get("browser", "?")).lower(),
               "OPS_MULTI_TENANT": infra.get("runtime_env", {}).get("OPS_MULTI_TENANT", "1")}
        create.append(f"env on {proj} and {api}, rewritten on every deploy: " + ", ".join(f"{k}={v}" for k, v in cfg.items())
                      + "; PLATFORM_NOTIFY_FROM's display name set to this app's product name on all three projects")
        if not shared:
            create.append(f"env on {proj} and {proj}-workflow: TASK_WORKFLOW_SERVICE_TOKEN (minted fresh on every deploy, one value on both ends)")
    if mode == "verify-db" or not shared:
        # bootstrap_database reuses the password ONLY when the DATABASE_URL already deployed on the main
        # project is app_rw's own (it matches postgres://app_rw...); any other value there — an admin URL, a
        # stranger's — is ignored and the password rotates. The check reads names, never values, so it
        # cannot tell those apart: the safe statement is the rotation, with the one condition that averts it.
        rot = ("ROTATES the app_rw password unless the DATABASE_URL already on the project is app_rw's own (then it is "
               "reused; --check reads names, not values, so it cannot tell) — a rotation stops every build made against the older one"
               if "DATABASE_URL" in present
               else "ROTATES the app_rw password: every build made against an older one stops connecting")
        create.append(f"the database: schema push, migration journal, RLS + app_rw bootstrap ({rot}), task-workflow "
                      f"migration, the RLS coverage pass, then the isolation proof; ONLY after the proof passes, env "
                      f"DATABASE_URL (app_rw) on {proj}, {api}, {wf}")
    if mode == "deploy":
        if not shared:
            create.append(f"{wf}: env {', '.join(WORKFLOW_ENV)} copied from {proj}; framework PATCHed to nextjs; a PRODUCTION "
                          f"deployment of services/task-workflow; git disconnected if the deploy re-linked it; then env "
                          f"TASK_WORKFLOW_SERVICE_URL on {proj}")
            create.append(f"{api}: every API_ENV name {proj} holds copied over ({', '.join(API_ENV)}); framework PATCHed to eve; "
                          f"env TASK_WORKFLOW_SERVICE_URL; a PRODUCTION build and deployment of the eve API; git disconnected "
                          f"if the deploy re-linked it; then env NEXT_PUBLIC_EVE_API_URL on {proj}")
        else:
            # deploy_vercel writes this file into the directory it BUILDS from, which for a branded app is
            # build/<app_id>/ (main() swaps mold_dir after this plan is printed), so name that directory here
            # rather than the snapshot the run never touches.
            bdir = f"build/{app_id}" if app.get("surface", {}).get("branding") else os.path.relpath(mold_dir, ROOT)
            create.append(f"{bdir}/vercel.nocron.json: vercel.json with its crons stripped "
                          f"(shared_with_live: the crons stay with the live app); no schema, no app_rw, no isolation proof")
        origin = infra.get("vercel", {}).get("production_url") or f"https://{proj}.vercel.app"
        create.append(f"env WEB_ORIGIN={origin} on {proj} and {api}; a PRODUCTION deployment of the web app on {proj}; git "
                      f"disconnected if the deploy re-linked it; WEB_ORIGIN rewritten on both if the deployment's URL differs")
        create.append(f"then reads only (three health endpoints), and state: state/application/{app_id}/application.json status "
                      f"stamping -> stamped (or reverted, with the reason), infrastructure.json (the three URLs, deployed_at), "
                      f"datastores.json postgres.rls_verified")
    elif mode == "verify-db":
        create.append(f"state: state/application/{app_id}/datastores.json postgres.rls_verified — nothing is built or deployed, "
                      f"and the RUNNING app keeps the DATABASE_URL of its last build")
    links = {p: git_link(p, mold_dir) for p, ok in projects.items() if ok}
    return {"projects": projects, "present": present, "create": create, "git_links": {p: l for p, l in links.items() if l}}

def print_plan(plan, heading):
    for p, ok in plan["projects"].items(): print(f"  project {p}: {'exists' if ok else 'does not exist'}")
    if not plan["create"]: return print("  nothing remote left to create")
    print(heading)
    for c in plan["create"]: print(f"  - {c}")

def pull_env(mold_dir, project, environment="production", required=True):
    """This app's env values. `required=False` returns {} instead of exiting: the candidate-database
    inspection reads a throwaway project that may legitimately hold nothing, and an exit there would
    skip the cleanup that removes it."""
    tmp = os.path.join(mold_dir, f".env.provision.{project}")
    vrun(f"vercel env pull --yes --environment={environment} --project {project} {tmp}", shell=True, cwd=mold_dir, capture_output=True)
    vals, unreadable = {}, []
    for l in (open(tmp) if os.path.exists(tmp) else []):
        if "=" in l and not l.startswith("#"):
            k, v = l.split("=", 1); k, v = k.strip(), v.strip().strip('"')
            if v == REDACTED: unreadable.append(k); continue    # Sensitive: unreadable, never a value
            vals[k] = v
    if os.path.exists(tmp): os.remove(tmp)
    if not vals and not required: return {}
    if not vals: sys.exit(f"could not pull the {environment} environment of {project}")
    if unreadable: print(f"  {project}: {len(unreadable)} sensitive var(s) unreadable: {', '.join(sorted(unreadable))}")
    return vals


def set_framework(project, framework, mold_dir):
    """The eve API and the task-workflow service need different presets (eve / nextjs); auto-detection
    picks Next.js for both and then rejects the eve build output. Verified through the API, whose value
    is the slug (`nextjs`), not the console's display name (`Next.js`)."""
    vrun(f"vercel api /v9/projects/{project} -X PATCH -F framework={framework} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    r = vrun(f"vercel api /v9/projects/{project} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: got = json.loads(r.stdout).get("framework")
    except Exception: got = None
    if got != framework: sys.exit(f"could not set framework={framework} on {project} (reads {got!r})")

def _project_meta(project, mold_dir):
    r = vrun(f"vercel api /v9/projects/{project} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: return json.loads(r.stdout)
    except Exception: return {}

def git_link(project, mold_dir):
    """Which git provider, if any, auto-deploys this project. None when nothing does."""
    return (_project_meta(project, mold_dir).get("link") or {}).get("type")

GIT_LINK_MSG = ("{project} is still connected to git ({link}); every push would deploy the factory repo over this app. "
                "Disconnect it (Settings -> Git -> Disconnect) and rerun.")

def disconnect_git(project, mold_dir):
    """A project the CLI creates from inside a git checkout is auto-connected to that repo.
    The mold lives inside the factory repo, so claudecode-web-api/-workflow were linked to
    never2average/software-factory and every push started a PRODUCTION build of the factory
    root: `eve: command not found` (eve preset) / `No Next.js version detected` (nextjs preset).
    14 ERROR production deployments each, and the workflow build overwrites the build cache the
    next CLI deploy restores. Only provision.py may create deployments for a stamped app.

    `vercel git disconnect` acts on the project linked in its working directory, so it runs in a
    throwaway link dir: the mold directory is shared by every agent and must never be relinked."""
    meta = _project_meta(project, mold_dir)
    if not (meta.get("link") or {}).get("type"): return
    d = tempfile.mkdtemp(prefix="vercel-unlink-")
    try:
        os.makedirs(os.path.join(d, ".vercel"))
        json.dump({"projectId": meta.get("id"), "orgId": meta.get("accountId"), "projectName": project},
                  open(os.path.join(d, ".vercel/project.json"), "w"))
        vrun(f"vercel git disconnect --cwd {d}", shell=True, cwd=mold_dir,
                       input="y\n", capture_output=True, text=True)   # the CLI confirms interactively
    finally:
        shutil.rmtree(d, ignore_errors=True)
    link = git_link(project, mold_dir)
    if link: sys.exit(GIT_LINK_MSG.format(project=project, link=link))
    print(f"  {project}: git integration disconnected")

def sync_env(names, vals, project, mold_dir, declared=None):
    """Copy `names` from the main project's values onto `project`. `declared` (infrastructure.secrets)
    limits the "set once by hand" report to names THIS app uses: API_ENV carries both providers'
    credentials, and the other provider's name is unused, not unreadable."""
    have = vercel_env_names(mold_dir, project); n = 0
    # with pull_env dropping [SENSITIVE], vals.get(k) is None for anything unreadable at the source
    blocked = [k for k in names if k not in have and not vals.get(k)]
    if any(k in ("DATABASE_URL", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL") for k in blocked):
        sys.exit(f"{project}: cannot set {', '.join(blocked)} — unreadable (Sensitive) on the source. Recreate as Encrypted and rerun.")
    for k in names:
        if k in have or not vals.get(k): continue
        _set_env(k, vals[k], mold_dir, project=project); n += 1
    blocked = [k for k in blocked if k not in OPTIONAL_ENV and (declared is None or k in declared)]
    print(f"  {project}: synced {n} env var(s)" + (f"; unreadable at the source, set once by hand: {', '.join(blocked)}" if blocked else ""))

def _node_lib(script, env, mold_dir):
    """Run one of .claude/scripts/lib/*.mjs against the mold's node_modules WITHOUT putting a file
    inside the mold (HARD RULE 1): ESM resolves a bare import from the script's own directory
    upward, so a temp directory holding a node_modules symlink is enough.

    EVERY .mjs in lib/ is copied, not just the one being run: verify-apprw.mjs and rls-cover.mjs share
    lib/rls-policy.mjs (the pass that executes each policy instead of reading it), and a relative import
    resolves beside the script. The vm runner mounts the whole directory for the same reason."""
    d = tempfile.mkdtemp(prefix="factory-lib-")
    try:
        # abspath: a relative mold_dir would make this symlink dangle, and a dangling node_modules is
        # ERR_MODULE_NOT_FOUND — a Node stack trace where a diagnosis belongs.
        os.symlink(os.path.join(os.path.abspath(mold_dir), "node_modules"), os.path.join(d, "node_modules"))
        src = os.path.dirname(os.path.abspath(script))
        for f in os.listdir(src):
            if f.endswith(".mjs"): shutil.copy(os.path.join(src, f), os.path.join(d, f))
        return subprocess.run(["node", os.path.join(d, os.path.basename(script))], cwd=d,
                              env=dict(os.environ, **env), capture_output=True, text=True)
    finally: shutil.rmtree(d, ignore_errors=True)

def rls_mode(ds):
    """What the application ASKED for, in datastores.postgres.rls.

    `fail_closed` and `on` are GATES: the coverage pass runs, the isolation probe runs, and a failure
    stops the deploy. `off` is an application saying it does not want tenant isolation — the role and
    the wire are still measured and recorded, but nothing is enforced and nothing is applied. The
    factory still points DATABASE_URL at the NOBYPASSRLS app role in every mode: which role the app
    runs as is not the application's choice to make."""
    return ds.get("postgres", {}).get("rls", "fail_closed")

def _lib_runner(mold_dir):
    """How to run .claude/scripts/lib/*.mjs against the MANAGED backend: on this box, against the
    mold's node_modules, with the secret in the environment."""
    return lambda script, env: _node_lib(os.path.join(ROOT, ".claude/scripts/lib", script), env, mold_dir)

NODE_NOISE = re.compile(r"^(at\s|node:internal|Node\.js v|\^+$|\}\)?;?$|\)+;?$|throw |Emitted \'error\'|"
                        r"Run \'docker .*--help\'|See \'docker .*--help\'|\[Symbol|\s*$)")

def _node_err(r, fallback="no output"):
    """One human sentence out of a Node (or docker) process — never its version banner.

    verify-apprw.mjs and rls-cover.mjs each print ONE line and exit 3 when they could not run at all,
    but anything that kills the process outside their own try/catch — a docker network that is gone, an
    ESM resolution failure, an OOM — still arrives as a stack trace, and its LAST line is always
    `Node.js v24.20.0`. Taking the last line is how "refusing to deploy this DATABASE_URL: Node.js
    v24.20.0" became a permanent revert reason in application.json. run_migrations and the vm chain
    already filter this; the RLS gate was the one place that did not."""
    keep = [l.strip() for l in (r.stderr or "").splitlines() if l.strip() and not NODE_NOISE.match(l.strip())]
    if not keep: keep = [l.strip() for l in (r.stdout or "").splitlines() if l.strip() and not l.strip().startswith("{")]
    return (" / ".join(keep[-3:]))[:300] or fallback

def _unprovable(r, hint, what):
    """The proof did not RUN. That is not the same fact as "isolation is broken", and the operator gets
    the difference plus the one command that fixes it — never a stack trace (HARD RULE 4)."""
    # The scripts say "<x> could not be measured — <reason>" themselves; keep the reason, drop the echo.
    det = re.sub(r"^[a-z\- ]+could not be measured (—|--) ", "", _node_err(r))
    return (f"{what} could not be measured, so nothing was proven: {det}.\n"
            f"  Nothing was changed. Run: {hint}")

def _rls_cover(run, admin, mode, hint):
    """Close the coverage gap the mold's hardcoded 13-name SCOPED list leaves behind — factory-side,
    because molds/*/codebase is immutable (HARD RULE 1).

    Runs AFTER the mold's own bootstrap and AFTER the task-workflow migration, on BOTH backends, so a
    table either of them creates is covered too. `rls-cover.mjs` reads the org-scoped table set from the
    catalog rather than from a list — a list is how 37 of 52 tables came to have no policy at all."""
    if mode == "off": return None
    r = run("rls-cover.mjs", {"ADMIN_URL": admin, "RLS_MODE": mode})
    line = (r.stdout.strip().splitlines() or [""])[-1]
    if line.startswith("{"): print("  rls coverage: " + line[:260])
    # exit 3 = could not connect, exit 2 = pointed at the wrong role, and any non-zero exit with no
    # JSON line means the pass never reached its own verdict. None of those is evidence of anything.
    if r.returncode and (r.returncode != 1 or not line.startswith("{")):
        sys.exit(_unprovable(r, hint, "row-level security coverage"))
    if r.returncode:
        sys.exit("row-level security coverage failed, so tenant isolation cannot be claimed: " + _node_err(r))
    try: return json.loads(line)
    except Exception: return None

def _verify_app_rw(run, url, mode, backend, source, hint):
    """PROVE, on the exact string that is about to become DATABASE_URL, that another workspace's rows
    are unreachable — then return the evidence so state can record it.

    provision.py used to trust the mold's own self-test and deploy a URL it had never opened: that is
    how the live app came to report `role postgres — WARNING: BYPASSRLS, row-level security is NOT
    enforced`. The first gate that replaced it asked only `count(pg_policies) > 0`, which passes on a
    database where 37 of 52 org-scoped tables have no policy — a gate that certifies the broken state.
    verify-apprw.mjs now ends by reading, and writing, across a workspace boundary and failing.

    The URL travels in the environment, never in argv: /proc/<pid>/cmdline is world-readable. Nothing
    printed here contains a credential — only role names, flags and counts."""
    # A POOLED endpoint can lag a password rotation: the bootstrap tests app_rw on the direct host,
    # this proof is the first connection through the pooler seconds later, and the mold's own bootstrap
    # retries exactly that lag for Supavisor. Retry that ONE error class, bounded, on the exact URL that
    # will be deployed; anything else fails at once. (The 2026-09-13 "password authentication failed"
    # was NOT lag — it was ADMIN_KEYS bootstrapping the retired Supabase database, see above — and the
    # retry correctly did not save it: six attempts, same refusal.)
    for attempt in range(7):
        r = run("verify-apprw.mjs", {"APP_RW_URL": url, "RLS_MODE": mode})
        lagging = r.returncode and re.search(r"password authentication failed|28P01", r.stdout + r.stderr)
        if not lagging or attempt == 6: break
        print(f"  the pooled endpoint has not accepted the rotated password yet; retrying in 12s ({attempt + 1}/6)")
        time.sleep(12)
    line = (r.stdout.strip().splitlines() or [""])[-1]
    if line.startswith("{"): print("  isolation proof: " + line[:400])
    if r.returncode and (r.returncode != 1 or not line.startswith("{")):
        sys.exit(_unprovable(r, hint, "tenant isolation"))
    if r.returncode:
        sys.exit("refusing to deploy this DATABASE_URL: " + _node_err(r, "verification failed"))
    try: out = json.loads(line)
    except Exception: sys.exit("the isolation proof printed nothing readable; refusing to deploy")
    # Everything the gate can now see goes into the record. `protected/unprotected` alone would let
    # state read "52/52, unprotected []" over a database with a `USING (true)` policy beside every
    # org_isolation, which is the exact shape of the defect this file exists to stop — and
    # `open_policies` alone would still read clean over a policy that says org_id and means `OR true`,
    # so what each policy DID when it was executed is recorded too.
    return {"at": NOW, "backend": backend, "mode": mode, "source": source, "role": out.get("role"),
            "superuser": out.get("superuser"), "bypassrls": out.get("bypassrls"),
            "org_scoped_tables": out.get("tables_org_scoped"), "protected": out.get("protected"),
            "unprotected": out.get("unprotected") or [], "open_policies": out.get("open_policies") or [],
            "leaking_policies": out.get("leaking_policies") or [], "policies_executed": out.get("policies_executed"),
            "policies_unverified": out.get("policies_unverified") or [], "unmeasured": out.get("unmeasured") or [],
            "probe_table": out.get("probe_table"), "probe_tables": out.get("probe_tables"),
            "probe_skipped": out.get("probe_skipped") or [],
            "foreign_rows_readable": out.get("foreign_rows"), "leaking_tables": out.get("leaking_tables") or [],
            "cross_org_write": out.get("cross_org_write"), "cross_org_writable": out.get("cross_org_writable") or [],
            "unset_org_rows": out.get("unset_org_rows"), "open_with_no_org": out.get("open_with_no_org") or []}

def record_rls(adir, ds, ev):
    """datastores.postgres.rls stops being a claim the moment this is written beside it.

    `factory.py validate` refuses `rls: fail_closed` (or `on`) on an app that says it is deployed
    without a matching evidence block, so the field can no longer be a string nothing tested."""
    if not ev: return
    # REPLACE, never merge: rls_verified is one measurement of one database at one instant, and a
    # running_app verdict carried over from an older block would be a verdict about an older build. So
    # every block carries its own — a caller that measured nothing in front of traffic writes the safe
    # token, not nothing: `unmeasured` fails validate, absence also fails validate, and neither can be
    # mistaken for the affirmative (datastores.schema.json: rls_verified.running_app).
    if ev.get("running_app") not in RLS_TOKENS:
        ev["running_app"], ev["running_app_detail"] = "unmeasured", "nothing read the app in front of traffic in this step"
    ds.setdefault("postgres", {})["rls_verified"] = ev
    save(os.path.join(adir, "datastores.json"), ds)
    # .get, not [] — a `not verified:` record (scope=shared_with_live) carries no counts, and a
    # KeyError here is not a SystemExit, so main()'s revert handler would not have fired: the deploy
    # died mid-flight and left the app recorded as `stamping`, which factory.py validate does not audit.
    if str(ev.get("source", "")).startswith("not verified"):
        print(f"  recorded datastores.postgres.rls_verified: NOT verified — {ev.get('source')[:160]}")
    else:
        print(f"  recorded datastores.postgres.rls_verified ({ev.get('mode')} on {ev.get('backend')}, "
              f"{ev.get('protected')}/{ev.get('org_scoped_tables')} org-scoped tables protected, "
              f"{len(ev.get('open_policies') or [])} open policy/policies, "
              f"{ev.get('policies_executed')} policy/policies executed, "
              f"{ev.get('probe_tables')} table(s) probed across the workspace boundary)")

def record_running_app(adir, ds, running):
    """Put the reading of the PROCESS IN FRONT OF TRAFFIC into the evidence, not just on the screen.

    --deploy measures this at the end of deploy_vercel and used to only RETURN it: record_rls had
    already written rls_verified several minutes earlier (before the build existed to read), so a
    successful deploy left `running_app` absent from state. factory.py validate reads that field, so
    every deployed app answered "nothing read the app in front of traffic — run --verify-rls", and
    --verify-rls then re-measured the very reading the deploy had already taken and thrown away: an
    instruction loop for the operator who cannot read their way out of it (HARD RULE 4). The deploy
    measured it; the deploy records it.

    Recorded for every outcome, `not_enforced` and `unmeasured` included — main() reverts the app on
    those, and the reason it reverted is exactly what the next person needs to see in state.
    `running` is the (token, detail) pair from _rls_from_doc: the token is the verdict factory.py
    compares, the detail is the sentence the operator reads."""
    ev = ds.get("postgres", {}).get("rls_verified")
    if not ev: return                       # rls_verified is written before this on every path that reaches it
    ev["running_app"], ev["running_app_detail"] = running
    save(os.path.join(adir, "datastores.json"), ds)

def _retarget(app_url, runtime_url):
    """Put the app_rw URL back on the host:port that actually answers, and force TLS.

    .bootstrap-supabase.mjs:206 does `appUrl.port = "6543"` unconditionally — Supavisor's port and
    nobody else's. It is right for Supabase and wrong for Neon, RDS and any self-hosted server, so
    the script writes an unreachable DATABASE_URL and then dies on its own connection test, AFTER
    doing 100% of the security work. Forking the mold is forbidden and bending every provider onto
    port 6543 means publishing a Postgres port, so instead take host:port back from the URL that
    already works. Provider-independent: one seam unblocks neon, rds and self_hosted at once."""
    a, b = urllib.parse.urlsplit(app_url), urllib.parse.urlsplit(runtime_url)
    q = dict(urllib.parse.parse_qsl(a.query)); q["sslmode"] = "require"
    userinfo = a.netloc.rsplit("@", 1)[0] if "@" in a.netloc else ""
    host = b.netloc.rsplit("@", 1)[-1]
    return urllib.parse.urlunsplit((a.scheme, f"{userinfo}@{host}" if userinfo else host, a.path, urllib.parse.urlencode(q), a.fragment))

def _seed_env_local(envloc):
    """.bootstrap-supabase.mjs READS .env.local (readFileSync, line 219) before it writes the app_rw URL into
    it, and the mold snapshot ships without one (gitignored, excluded by MOLD.md), so on a fresh checkout
    both lanes died with `ENOENT: open '.env.local'` after the RLS work had already been done. An empty,
    0600 file is enough; the caller's `finally` removes it again when there was none before."""
    if os.path.exists(envloc): return
    old = os.umask(0o077)
    try: open(envloc, "w").close()
    finally: os.umask(old)

def bootstrap_database(mold_dir, admin, projects, provider="supabase", runtime_url=""):
    """A fresh Postgres needs what Drizzle does not model: row-level security and the app_rw
    login role (NOBYPASSRLS). The mold ships .bootstrap-supabase.mjs for exactly this; it reads
    .env.supabase, verifies the schema, applies RLS, creates app_rw and writes the app_rw
    connection string into .env.local. Without it the app runs as a BYPASSRLS superuser and the
    task-workflow migration fails on the missing role. Idempotent: re-running rotates the password.

    EVERY provider runs this same script. The tempting alternative for Neon, .setup-app-role.mjs,
    creates the role and grants DML and applies ZERO policies — `grep -n 'ROW LEVEL SECURITY|CREATE
    POLICY' .setup-app-role.mjs` returns nothing — so app #2 would ship with a correctly-restricted
    role guarding an empty policy set: every log line green, no tenant isolation at all.

    Returns the app_rw URL. It is NOT written anywhere here: the coverage pass and the isolation
    proof run first, in bring_up_schema, and only then does DATABASE_URL get set. Writing it here meant
    the credential was live on three projects before anything had checked what it could reach, and the
    task-workflow migration — which creates three more org-scoped tables — had not even run yet."""
    envsup = os.path.join(mold_dir, ".env.supabase"); envloc = os.path.join(mold_dir, ".env.local")
    saved = open(envloc).read() if os.path.exists(envloc) else None
    # Reuse the existing app_rw password when one is already deployed. The bootstrap rotates on every
    # run, and a rotation invalidates every deployment built against the old value until it is rebuilt.
    env = dict(os.environ)
    cur = pull_env(mold_dir, projects[0]).get("DATABASE_URL", "")
    m0 = re.match(r"postgres(?:ql)?://app_rw[^:]*:([^@]+)@", cur)
    if m0: env["APP_RW_PASSWORD"] = urllib.parse.unquote(m0.group(1)); print("  reusing the deployed app_rw password (no rotation)")
    try:
        # Seeded INSIDE the try, after pull_env: that call sys.exits when the production env cannot be
        # pulled, and a seed placed before it was never removed on that exit (the finally below is what
        # removes it), leaving a stray .env.local in build/<app_id>/ or in the mold snapshot. verify_db
        # seeds at the same point for the same reason.
        _seed_env_local(envloc)
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={admin}\n")
        os.chmod(envsup, 0o600)
        r = subprocess.run("node .bootstrap-supabase.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
        raw = r.stdout + r.stderr
        out = [l for l in raw.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
        for l in out:
            if l.startswith(("✓", "✗", "app_rw", "policies", "tables app_rw")): print("  " + l[:150])
        m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(envloc).read(), re.M) if os.path.exists(envloc) else None
        # THE SEAM. The script PERSISTS the app_rw URL before it self-tests — its own comment says
        # "PERSIST BEFORE VERIFYING", because the generated password exists nowhere else. Its self-test
        # then connects to the port it just forced to 6543, so on any provider but Supabase it can only
        # fail there, after every piece of real work has already succeeded. Treat that one shape as a
        # success and re-verify independently below; anything else still exits exactly as before.
        did_work = bool(m) and "DATABASE_URL now points at" in raw
        if r.returncode and not did_work: sys.exit("database bootstrap failed:\n" + "\n".join(out[-12:]))
        if not m: sys.exit("bootstrap did not write an app_rw DATABASE_URL into .env.local")
        app_url = m.group(1)
        if provider != "supabase":
            # Supabase is the one provider that genuinely fronts a different port for runtime pooling.
            app_url = _retarget(app_url, runtime_url or admin)
            if r.returncode: print(f"  bootstrap's own test hit the hardcoded port 6543; retargeted to the {provider} endpoint")
        return app_url
    finally:
        if os.path.exists(envsup): os.remove(envsup)
        if saved is None:
            if os.path.exists(envloc): os.remove(envloc)
        else:
            open(envloc, "w").write(saved)      # the mold snapshot's own .env.local is restored

def push_schema(mold_dir, url):
    """`drizzle-kit push` FIRST, then the journal. The mold's own bootstrap says so ("ORDER MATTERS")
    and provision.py had it backwards: it ran migrate-production.mjs first and kept `push` only as a
    failure fallback inside bootstrap_database. On a truly empty database that fallback is a dead end —
    the journal is two tables behind schema.ts, so the bootstrap reports `Schema INCOMPLETE — 2 of 56
    tables missing: login_codes, inbox_items`, and the fallback push then dies with `Interactive
    prompts require a TTY terminal`. Provider-independent: it strands a fresh Neon branch exactly as
    it strands a fresh Supabase project."""
    r = subprocess.run("npx drizzle-kit push --force", shell=True, cwd=mold_dir,
                       env=dict(os.environ, DATABASE_URL=url), capture_output=True, text=True)
    raw = r.stdout + r.stderr
    msg = [l for l in raw.strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  schema push: " + (msg[-1][:160] if msg else "ok"))
    # drizzle-kit exits 0 after this one, so returncode alone reads a dead push as a success and the
    # bootstrap then reports `Schema INCOMPLETE`. It only happens on a database that already holds a
    # different version of the schema, which `scope: fresh` is supposed to have ruled out.
    if "Interactive prompts require a TTY" in raw:
        sys.exit("drizzle-kit push needs an interactive rename decision, which means this database is NOT empty. "
                 "A `scope: fresh` app must get an empty database; point datastores.postgres at a new one and rerun.")
    if r.returncode: sys.exit("drizzle-kit push failed:\n" + "\n".join(msg[-12:]))

def run_migrations(mold_dir, vals):
    url = admin_url(vals)
    if not url or not re.match(r"^postgres(?:ql)?://", url):
        sys.exit("no usable admin database URL: none of " + "/".join(ADMIN_KEYS) + " is set, or it is stored "
                 "Sensitive (unreadable). Recreate it as Encrypted, then rerun.")
    # both names: migrate-production.mjs falls back through a chain, and a stale unpooled value in the
    # ambient environment would otherwise decide which database is migrated.
    env = dict(os.environ, DATABASE_URL=url, DATABASE_URL_UNPOOLED=url)
    r = subprocess.run("node scripts/migrate-production.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
    msg = [l for l in (r.stdout + r.stderr).strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  migrations:\n    " + "\n    ".join(msg[-6:] or ["ok"]))   # a Node crash must never read as its version banner
    if r.returncode: sys.exit("migration failed:\n" + "\n".join(msg[-12:]))

def bring_up_schema(app_id, mold_dir, ds, proj, projects):
    """Empty database -> a schema, a migration journal, RLS, app_rw, and a DATABASE_URL proven to be
    all four. Separated from deploy_vercel so it can be run — and audited — on its own with
    `--verify-db`, without building or deploying anything.

    Order is push, migrate, bootstrap, task-workflow, COVER, PROVE, publish. The first four are what
    the mold itself says ("ORDER MATTERS: push the schema first, then this") and the reverse of what
    provision.py used to do; the last three are the factory's, and they are why `rls: fail_closed` is
    now a measurement. Returns (env values, evidence)."""
    vals = pull_env(mold_dir, proj)
    url = admin_url(vals)
    # Neon injects the POOLED endpoint as DATABASE_URL and the direct one as DATABASE_URL_UNPOOLED.
    # Migrations belong on the direct endpoint; the runtime belongs on the pooled one, because the mold
    # opens 10 agent + 5 ops backends per serverless instance and the pool size cannot be capped from
    # the URL (`?max=3` still opened 10). RLS survives transaction pooling: withOrgRls sets app.org_id
    # through set_config(..., true), which is transaction-LOCAL, and both clients run prepare:false —
    # verify-apprw.mjs asserts that round trip on the exact URL about to be deployed.
    runtime = vals.get("DATABASE_URL") or url
    print("pushing the schema, then the migration journal"); push_schema(mold_dir, url); run_migrations(mold_dir, vals)
    print("bootstrapping row-level security and the app_rw role")
    app_url = bootstrap_database(mold_dir, url, projects,
                                 provider=ds.get("postgres", {}).get("provider", "supabase"), runtime_url=runtime)
    # .migrate-task-workflow-service.mjs reads its admin URL from .env.supabase, never from the environment.
    # Write it transiently (gitignored inside the mold) and remove it whatever happens.
    envsup = os.path.join(mold_dir, ".env.supabase")
    try:
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={url}\n")
        os.chmod(envsup, 0o600)
        r = subprocess.run("npm run db:migrate:task-workflows", shell=True, cwd=mold_dir, capture_output=True, text=True)   # admin url: it grants to app_rw
    finally:
        if os.path.exists(envsup): os.remove(envsup)
    msg = [l for l in (r.stdout + r.stderr).strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  task-workflow migrations: " + (msg[-1][:160] if msg else "ok"))
    if r.returncode: sys.exit("task-workflow migration failed:\n" + "\n".join(msg[-12:]))
    # AFTER the migration, not before: db:migrate:task-workflows creates three more org-scoped tables,
    # and the mold policies them from its own fixed list. Cover, then prove, then — and only then —
    # publish the credential.
    mode = rls_mode(ds); run = _lib_runner(mold_dir)
    hint = f"python3 .claude/scripts/provision.py {app_id} --check"
    _rls_cover(run, url, mode, hint)
    ev = _verify_app_rw(run, app_url, mode, ds.get("postgres", {}).get("provider", "supabase"),
                        "provision.py bring_up_schema", hint)
    for pr_ in projects: _set_env("DATABASE_URL", app_url, mold_dir, project=pr_)
    print(f"  DATABASE_URL now points at app_rw on {len(projects)} project(s)")
    vals["DATABASE_URL"] = app_url        # sync_env must never push the PRE-bootstrap admin URL onward
    return vals, ev

def deploy_vercel(app_id, app, infra, ds, mold_dir, adir):
    """Mirror of the mold's Makefile `deploy` target: migrate, workflow service (services/task-workflow, Next.js),
    Eve API (vercel build with experimental frameworks + --prebuilt), web dashboard, then health verification."""
    proj = infra["vercel"]["project"]; team = infra["vercel"].get("team", ""); scope = f"--scope {team}" if team else ""
    shared = ds.get("postgres", {}).get("scope") == "shared_with_live"
    have = vercel_env_names(mold_dir, proj)
    cfg = {"MODEL_PROVIDER": app["model"]["provider"], "ENABLE_WEB_SEARCH": str(app["capabilities"]["web_search"]).lower(), "ENABLE_BROWSER": str(app["capabilities"]["browser"]).lower(),
           "OPS_MULTI_TENANT": infra.get("runtime_env", {}).get("OPS_MULTI_TENANT", "1")}
    # Per-role models (application.model.roles). Written on every deploy like the flags above, so the running app
    # can never disagree with its state; the mold falls back to CLOUDFLARE_MODEL, then its default, for a role
    # the application does not name.
    if app["model"].get("provider") == "cloudflare":
        for role, env_name in (("orchestrator", "CLOUDFLARE_MODEL_ORCHESTRATOR"), ("specialist", "CLOUDFLARE_MODEL_SPECIALIST")):
            v = (app["model"].get("roles") or {}).get(role)
            if v: cfg[env_name] = v
    for k, v in cfg.items(): _set_env(k, v, mold_dir, project=proj)
    for k, v in cfg.items(): _set_env(k, v, mold_dir, project=f"{proj}-api")   # build-time flags of the eve bundle: the API must agree with the web door
    # The sender's display name is this app's brand, re-derived on every deploy so it cannot drift from
    # the product name the overlay writes into the email text (the operator only ever supplies the address).
    cur = pull_env(mold_dir, proj).get("PLATFORM_NOTIFY_FROM", "")
    if cur and cur != REDACTED:
        want = brand_sender(app, cur)
        if want != cur:
            for p_ in (proj, f"{proj}-api", f"{proj}-workflow"): _set_env("PLATFORM_NOTIFY_FROM", want, mold_dir, project=p_)
            print(f"  PLATFORM_NOTIFY_FROM display name set from this app's branding: {want.split(' <')[0]}")
    SHIPPED.clear()
    def run(cmd, env=None, label="", kind="deploy"):
        # deploy: watched on the API, cancelled if stuck, bounded end to end (vercel_deploy).
        # build: the local eve build, waited for, niced, heap-capped and retried once on an OOM kill (heavy_build).
        if kind == "deploy":
            out = vercel_deploy(cmd, mold_dir, label or cmd, env=env)
        else:
            r = heavy_build(cmd, mold_dir, label or cmd, env=env)
            out = (r.stdout or "") + (r.stderr or "")
            if r.returncode: sys.exit(f"{label or cmd} failed:\n" + out.strip()[-1500:])
        urls = re.findall(r"https://[a-z0-9.-]+\.vercel\.app", out)
        return urls[-1] if urls else ""
    if not shared:
        # Minted on EVERY deploy and written to both ends at once. It used to be minted only when the main
        # project had no copy, then copied to the workflow project by reading the main project's value back;
        # a write-only (sensitive) copy read back as [SENSITIVE], the copy was refused, and the two projects
        # ran with different tokens: every builder request answered 401 Unauthorized while /api/ops/* worked,
        # and the signed-in lanes measured "the workflow builder did not render" (2026-09-14). Both projects
        # are deployed in this same run, so a fresh value has no window in which one end is stale.
        _wf_tok = subprocess.check_output("openssl rand -hex 32", shell=True, text=True).strip()
        for p_ in (proj, f"{proj}-workflow"): _set_env("TASK_WORKFLOW_SERVICE_TOKEN", _wf_tok, mold_dir, project=p_)
        del _wf_tok; print("minted TASK_WORKFLOW_SERVICE_TOKEN (same value on the web and workflow projects)")
        vals, ev = bring_up_schema(app_id, mold_dir, ds, proj, [proj, f"{proj}-api", f"{proj}-workflow"])
        record_rls(adir, ds, ev)
        # workflow service: its own Next.js app under services/task-workflow
        print("deploying workflow service (services/task-workflow)"); sync_env(WORKFLOW_ENV, vals, f"{proj}-workflow", mold_dir); set_framework(f"{proj}-workflow", "nextjs", mold_dir)
        wf_url = stable_url(f"{proj}-workflow", run(f"vercel deploy services/task-workflow --prod --yes --project {proj}-workflow {scope}", label="workflow deploy"))
        SHIPPED.append(("workflow", wf_url))
        disconnect_git(f"{proj}-workflow", mold_dir)
        infra["vercel"]["workflow_url"] = wf_url; print(f"  {wf_url}")
        _set_env("TASK_WORKFLOW_SERVICE_URL", wf_url, mold_dir, project=proj)
        vals = pull_env(mold_dir, proj)
        # eve api: build here with the experimental framework, ship prebuilt
        print("deploying eve api (vercel build --prebuilt)"); sync_env(API_ENV, vals, f"{proj}-api", mold_dir, declared=infra.get("secrets")); set_framework(f"{proj}-api", "eve", mold_dir)
        # sync_env copies only names the api does not hold yet; the public key is the one value that must
        # MATCH the main project's, not merely exist, so it is written every deploy.
        if vals.get("AUTH_JWT_PUBLIC_KEY"): _set_env("AUTH_JWT_PUBLIC_KEY", vals["AUTH_JWT_PUBLIC_KEY"], mold_dir, project=f"{proj}-api"); print(f"  {proj}-api: AUTH_JWT_PUBLIC_KEY set to the main project's current public key")
        _set_env("TASK_WORKFLOW_SERVICE_URL", wf_url, mold_dir, project=f"{proj}-api")
        subprocess.run("rm -rf .eve/sandbox-cache/template-locks/vercel .vercel/output", shell=True, cwd=mold_dir)
        env = dict(os.environ, VERCEL_USE_EXPERIMENTAL_FRAMEWORKS="1")
        run(f"vercel build --prod --yes --project {proj}-api {scope} --local-config vercel.eve.json", env=env, label="eve api build", kind="build")
        api_url = stable_url(f"{proj}-api", run(f"vercel deploy --prebuilt --prod --yes --project {proj}-api {scope}", label="eve api deploy"))
        SHIPPED.append(("api", api_url))
        disconnect_git(f"{proj}-api", mold_dir)
        infra["vercel"]["api_url"] = api_url; print(f"  {api_url}")
        _set_env("NEXT_PUBLIC_EVE_API_URL", api_url, mold_dir, project=proj)
        cfg_main = "vercel.json"
    else:
        # bring_up_schema — and with it the app_rw bootstrap, the coverage pass and the isolation proof —
        # is inside `if not shared`. main() refuses shared_with_live for a multi_org app for exactly that
        # reason; a single_org app on a shared database gets an honest record instead of a silent claim.
        record_rls(adir, ds, {"at": NOW, "backend": ds.get("postgres", {}).get("provider", "supabase"),
                              "mode": rls_mode(ds), "source": "not verified: scope=shared_with_live, the database "
                              "belongs to another application and this deploy neither bootstraps nor gates it"})
        v = load(os.path.join(mold_dir, "vercel.json")); v.pop("crons", None)
        cfg_main = "vercel.nocron.json"; save(os.path.join(mold_dir, cfg_main), v); infra["vercel"]["crons"] = "stripped (shared_with_live)"
    # The eve API defaults WEB_ORIGIN to the live app (agent/channels/eve.ts, agent/lib/run-tools.ts).
    # Point it at this app's own front door; the value is only known once the web app has a URL, so a
    # first deploy sets it from the project alias and later deploys correct it.
    web_origin = infra["vercel"].get("production_url") or f"https://{proj}.vercel.app"
    for p_ in (proj, f"{proj}-api"): _set_env("WEB_ORIGIN", web_origin, mold_dir, project=p_)
    print("deploying web app")
    # the eve prebuilt output and the build-time env `vercel build` wrote are the api's, not the web app's
    subprocess.run("rm -rf .vercel/output .vercel/static-build .vercel/.env.production.local", shell=True, cwd=mold_dir)
    url = stable_url(proj, run(f"vercel deploy . --prod --yes --project {proj} {scope} --local-config {cfg_main}", label="web deploy"))
    SHIPPED.append(("web", url))
    disconnect_git(proj, mold_dir)
    # An app with its own domain (domain.py attach/switch) keeps it as its front door: `vercel deploy` always
    # answers with the project's *.vercel.app address, and recording that would send WEB_ORIGIN, emailed links
    # and the app's agent package back to the old address on every deploy.
    dom = infra["vercel"].get("custom_domain")
    if dom and (infra["vercel"].get("production_url") or "") == f"https://{dom}": url = f"https://{dom}"
    infra["vercel"]["production_url"] = url; print(f"  {url}")
    if url != web_origin:
        for p_ in (proj, f"{proj}-api"): _set_env("WEB_ORIGIN", url, mold_dir, project=p_)
        print(f"  WEB_ORIGIN corrected to {url} (takes effect on the next deploy)")
    # verify-production, as the Makefile does
    checks = [("workflow", f"{infra['vercel'].get('workflow_url','')}/api/health"), ("api", f"{infra['vercel'].get('api_url','')}/eve/v1/health"), ("web", f"{url}/api/ops/health")]
    health = {}; running = ("unmeasured", "the web app was not health-checked")
    for name, u in checks:
        if not u.startswith("http"): continue
        code, doc, why = _read_health(u)
        health[name] = code or "no answer"; print(f"  health {name}: {health[name]} {u}")
        # READ THE BODY, NOT THE STATUS CODE — and only a body that IS this app's health document.
        # The mold's checkDb returns the BYPASSRLS warning as a `detail` string with ok:true, so the
        # aggregate ok, and the HTTP status, are unaffected: the endpoint answers 200 while announcing
        # that row-level security is not enforced. The status code is structurally incapable of carrying
        # this, which is why a lane report once printed `health.db | pass` next to the warning. The
        # converse matters just as much: a 404/401/500 carries no warning either, and reading that as
        # "no warning" is how an app whose deploy failed could be recorded as isolated.
        if name == "web": running = _rls_from_doc(code, doc, why)
    infra["vercel"]["health"] = health
    if any(v != "200" for v in health.values()): print("WARNING: a health check is not 200; see infrastructure.json vercel.health")
    record_running_app(adir, ds, running)
    print(f"  row-level security, as reported by the app now serving traffic: {running[0]} ({running[1][:160]})")
    return running

ARTIFACT_HEADER = """# GENERATED by .claude/scripts/provision.py from state/application/{app_id}/*.json.
# REGENERATED ON EVERY RUN (--check and --verify-db alike) — edit this file and your edit is gone.
# The one sanctioned hand-edit seam is docker-compose.override.yml, which is never generated. Compose
# merges it AUTOMATICALLY ONLY when you run compose from this directory, so that is how the factory
# runs it too (`localpg.up` shells out to `docker compose up -d` with cwd here): an override written
# beside this file governs the database `--verify-db` brings up, not just manual runs. An explicit
# `docker compose -f <this file>` silently drops the override — do not use that form.
#
# WHAT THIS IS: {app_id}'s LOCAL database, for the five testing lanes and for schema rehearsals on
# this box. WHAT IT IS NOT: a deployment of the application. mold_v1 is three deployables plus four
# cron schedules plus a Vercel-injected OIDC identity that durable-workflow auto-resume needs, and
# giving the VM a non-Vercel identity means editing the mold, which HARD RULE 1 forbids. The one
# committed deploy target is vercel — see infra/vm/README.md.
#
# NO HOST PORT, EVER. Postgres listens on {port} INSIDE the container, on the private network
# {net}, which is also what makes .bootstrap-supabase.mjs's hardcoded port 6543 a no-op.
# This droplet has no firewall (ufw inactive, iptables -P INPUT ACCEPT); a published port here is on
# the public internet within minutes.
"""

GENERATED_FILES = ("docker-compose.yml", ".env.example", "README.md")
def generate_local_artifact(app_id, mold_dir, secrets, ds, infra):
    """Rewrite THESE THREE FILES from state on every run: docker-compose.yml, .env.example, README.md.

    They used to be written only `if not os.path.exists(...)`, so from the first write onward the factory
    stopped describing the app: a hand-edited compose survived a re-run byte-identical, and — worse —
    the frozen build context meant a BRANDED app silently rebuilt the unbranded mold. Nothing about
    those three is conditional now; drift is impossible by construction.

    WHAT IS NOT GENERATED, AND MUST NEVER BE. `.pg-admin` (the cluster superuser password) and
    `pg/server.{crt,key}` also live in this directory, and they are NOT derivable from state: Postgres
    stores the password inside the data directory at initdb time, so that file is the only copy of the
    credential that opens the volume. Calling the whole directory "pure generated output" is what made
    it look safe to clear or recreate — and losing .pg-admin used to be SILENT: ensure_local_secrets
    minted a fresh password, this function reported success, and the running database then refused every
    connection. localpg._pw now refuses to mint a second password over an existing volume, and the
    self-signed TLS pair is regenerated as a pair (it is derivable, so losing it costs nothing)."""
    sys.path.insert(0, os.path.join(ROOT, ".claude/scripts/lib")); import localpg
    pg = ds.get("postgres", {})
    if pg.get("provider") != "self_hosted":
        # This artifact IS a self_hosted database. Writing one for an app whose state names a managed
        # provider would describe a database the application does not have. main() gates this too; the
        # refusal lives here as well because the artifact and the state are one fact.
        sys.exit(f'{app_id}: refusing to generate a local Postgres artifact for an app whose '
                 f'datastores.postgres.provider is "{pg.get("provider")}". Set it to "self_hosted" to verify '
                 f'locally, or set infrastructure.target to "vercel" to run it on {pg.get("provider")}.')
    d = localpg.appdir(app_id)          # creates the directory AND its .gitignore, in that order
    hdr = ARTIFACT_HEADER.format(app_id=app_id, port=localpg.PORT, net=localpg.net(app_id))
    open(os.path.join(d, "docker-compose.yml"), "w").write(hdr + f"""
name: {localpg.net(app_id)}
services:
  db:
    image: {localpg.IMAGE}
    container_name: {localpg.cont(app_id)}
    command: ["-c","port={localpg.PORT}","-c","ssl=on","-c","hba_file=/certs/pg_hba.conf","-c","ssl_cert_file=/certs/server.crt","-c","ssl_key_file=/certs/server.key","-c","password_encryption=scram-sha-256","-c","max_connections=200"]
    environment:
      POSTGRES_DB: {localpg.dbname(app_id)}
      POSTGRES_PASSWORD_FILE: /run/secrets/pg-admin
    secrets: [pg-admin]
    volumes:
      - {localpg.vol(app_id)}:/var/lib/postgresql/data
      - ./pg:/certs:ro
    networks:
      default: {{aliases: [db]}}
    restart: unless-stopped
    healthcheck:
      test: ["CMD","pg_isready","-p","{localpg.PORT}","-U","postgres"]
      interval: 5s
      timeout: 3s
      retries: 30
secrets:
  pg-admin:
    file: ./.pg-admin
volumes:
  {localpg.vol(app_id)}:
    name: {localpg.vol(app_id)}      # pin it: compose would otherwise prefix the project name and
                                     # `localpg.py up` and `docker compose up` would use two different data dirs
networks:
  default:
    name: {localpg.net(app_id)}
""")
    open(os.path.join(d, ".env.example"), "w").write(
        f"# secret NAMES only — values are generated or read from your terminal, never typed into this file\n"
        f"# provider: {pg.get('provider','?')}   scope: {pg.get('scope','?')}   deploy target: {infra.get('target','?')}\n"
        + "".join(f"{s}=\n" for s in secrets))
    localpg.ensure_local_secrets(app_id)   # .pg-admin + pg/server.{crt,key}: the compose file's own inputs,
                                           # without which `docker compose up` fails on a bind-mount that
                                           # does not exist. The artifact is runnable the moment it exists.
    open(os.path.join(d, "README.md"), "w").write(f"""<!-- GENERATED; see infra/vm/README.md -->
# {app_id} — local database artifact

    python3 .claude/scripts/provision.py {app_id} --verify-db   # up, full mold chain, app_rw proof
    (cd infra/vm/apps/{app_id} && docker compose up -d)         # the database alone, nothing else
    python3 .claude/scripts/lib/localpg.py down {app_id}

Provider `{pg.get('provider','?')}`. No host port: `docker port {localpg.cont(app_id)}` is empty by
design. Hand edits go in `docker-compose.override.yml` here, and both commands above honour it —
`docker compose -f <file>` from elsewhere would silently ignore it, so run compose from this directory.
GENERATED, REWRITTEN ON EVERY RUN: docker-compose.yml, .env.example, README.md. Edit those and the
edit is gone. NOT generated and NOT derivable from state: `.pg-admin` (this cluster's superuser
password) and `pg/server.key` (TLS private key) — both ignored by this directory's .gitignore and by
the root one, never committed, and never rewritten by a regeneration. `.pg-admin` is the ONLY copy of
the password baked into volume {localpg.vol(app_id)}: lose it and nothing can open that volume again, so provisioning
refuses rather than quietly mint a second one. Rebuild from scratch with
`python3 .claude/scripts/lib/localpg.py down {app_id}` (deletes the data) then `--verify-db`.
""")
    return d

def _vm_env(app_id, pairs):
    """Write values into the app's own gitignored env file, 0600. This is the vm_env_file secret store:
    the same contract as Vercel env, on a box the factory owns. Values never enter state or the repo."""
    f = os.path.join(ROOT, "infra/vm/apps", app_id, ".env"); os.makedirs(os.path.dirname(f), exist_ok=True)
    keep = [l for l in (open(f).read().splitlines() if os.path.exists(f) else []) if l.split("=")[0] not in pairs]
    old = os.umask(0o077)
    try: open(f, "w").write("\n".join(keep + [f"{k}={v}" for k, v in pairs.items()]) + "\n")
    finally: os.umask(old)
    os.chmod(f, 0o600)

def _vm_runner(app_id, mold_dir):
    """How to run .claude/scripts/lib/*.mjs against the SELF_HOSTED backend: inside node:24 on the app's
    private docker network, with the mold's node_modules mounted read-only beside the script. Node
    resolves a bare import from the script's own directory upward, so /node_modules serves /factory-lib
    without writing anything into the mold (HARD RULE 1). Same scripts, same checks, both backends."""
    sys.path.insert(0, os.path.join(ROOT, ".claude/scripts/lib")); import localpg
    return lambda script, env: localpg.run(app_id, f"node /factory-lib/{script}", mold_dir, env,
        extra=["-v", f"{os.path.join(ROOT, '.claude/scripts/lib')}:/factory-lib:ro",
               "-v", f"{os.path.join(mold_dir, 'node_modules')}:/node_modules:ro"])

def verify_db(app_id, mold_dir, ds, adir, infra):
    """Stand up the app's LOCAL Postgres and run the whole mold chain against it, then prove the URL.

    This is what `target: vm` buys: a real database the lanes can run against, on a private network,
    with no credential of the user's involved anywhere."""
    sys.path.insert(0, os.path.join(ROOT, ".claude/scripts/lib")); import localpg
    prov = ds.get("postgres", {}).get("provider")
    if prov != "self_hosted":
        # --verify-db brings up a local container and writes ITS url as this app's DATABASE_URL. Doing
        # that for an app whose state names a managed provider hands the app a database its own state
        # does not describe, and records an isolation proof measured on the wrong backend.
        sys.exit(f'{app_id}: --verify-db verifies a LOCAL database, but datastores.postgres.provider is '
                 f'"{prov}". Nothing was started. Set it to "self_hosted" to verify locally, or run this app '
                 f'on {prov} with infrastructure.target "vercel".')
    localpg.up(app_id); adm = localpg.url(app_id)
    envloc = os.path.join(mold_dir, ".env.local"); saved = open(envloc).read() if os.path.exists(envloc) else None
    envsup = os.path.join(mold_dir, ".env.supabase")
    try:
        _seed_env_local(envloc)
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={adm}\n")
        os.chmod(envsup, 0o600)
        for label, cmd, env in [("schema push", "npx drizzle-kit push --force", {"DATABASE_URL": adm}),
                                ("migration journal", "node scripts/migrate-production.mjs", {"DATABASE_URL": adm, "DATABASE_URL_UNPOOLED": adm}),
                                ("rls + app_rw", "node .bootstrap-supabase.mjs", {}),
                                ("task-workflow", "npm run db:migrate:task-workflows", {})]:
            r = localpg.run(app_id, cmd, mold_dir, env)
            msg = [l for l in (r.stdout + r.stderr).splitlines() if l.strip() and not l.lstrip().startswith("at ") and not l.startswith("npm notice")]
            print(f"  {label}: " + (msg[-1][:150] if msg else "ok"))
            if r.returncode: sys.exit(f"{label} failed:\n" + "\n".join(msg[-12:]))
        m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(envloc).read(), re.M)
        if not m: sys.exit("bootstrap did not write an app_rw DATABASE_URL into .env.local")
        # Same two scripts as the managed lane, in the same order, after the same four steps.
        mode = rls_mode(ds); run = _vm_runner(app_id, mold_dir)
        hint = f"python3 .claude/scripts/provision.py {app_id} --verify-db"
        _rls_cover(run, adm, mode, hint)
        ev = _verify_app_rw(run, m.group(1), mode, "self_hosted", "provision.py --verify-db", hint)
        # The same reading the vercel lane takes: a vm app serves nothing, so this records `unmeasured`
        # with the reason — the honest verdict, and the one the schema and validate expect to find here.
        ev["running_app"], ev["running_app_detail"] = _health_rls(infra)
        record_rls(adir, ds, ev)
        _vm_env(app_id, {"POSTGRES_ADMIN_URL": adm, "DATABASE_URL": m.group(1)})
        envf = os.path.join(ROOT, "infra/vm/apps", app_id, ".env")
        have = {l.split("=", 1)[0] for l in open(envf) if "=" in l and l.split("=", 1)[1].strip()}
        halves = {"AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY"} & have
        if len(halves) < 2:
            # The same pair the vercel lane mints (provision_datastores), kept across re-runs like .pg-admin:
            # a re-mint would orphan every session the lanes signed with the old key. It is what lets
            # lib/session.py sign in as this app's own FDE on this box (mold_v1-040). Kept only as a PAIR:
            # a file holding one half (a partial write, a hand edit) gets BOTH re-minted, because a private
            # key without its public half signs sessions the mold can never verify, and keeping it would
            # print "key pair" for a file that has none.
            priv, pub = mint_jwt_pair()
            _vm_env(app_id, {"AUTH_JWT_PRIVATE_KEY": priv, "AUTH_JWT_PUBLIC_KEY": pub})
            print("generated AUTH_JWT key pair" + (f" (re-minted both: only {halves.pop()} was present)" if halves else ""))
        print(f"verified: {app_id}'s local database is ready (no host port; `docker port {localpg.cont(app_id)}` is empty)")
        print(f"  DATABASE_URL, POSTGRES_ADMIN_URL and the AUTH_JWT key pair written to infra/vm/apps/{app_id}/.env — 0600, and ignored by\n"
              f"  both infra/vm/apps/{app_id}/.gitignore and the root .gitignore, as are .pg-admin and pg/server.key")
    finally:
        if os.path.exists(envsup): os.remove(envsup)
        if saved is None:
            if os.path.exists(envloc): os.remove(envloc)
        else: open(envloc, "w").write(saved)

VM_NOT_A_DEPLOY_TARGET = (
  '{app_id}: target "vm" is a LOCAL VERIFICATION target, not a deploy target (infra/vm/README.md: mold_v1 is\n'
  'three deployables, four cron schedules and a Vercel-injected OIDC identity that durable-workflow resume\n'
  'needs — giving the VM a non-Vercel identity means editing the mold, which is forbidden). Nothing on this\n'
  'box can deploy it, and nothing in this factory creates the Vercel-only secrets a deploy would need, so\n'
  'there is no list of missing things to work through here.\n'
  '  To verify this app on this box:  python3 .claude/scripts/provision.py {app_id} --verify-db\n'
  '  To put it in front of users:     set "target": "vercel" in state/application/{app_id}/infrastructure.json,\n'
  '                                   then: python3 .claude/scripts/provision.py {app_id} --check')

VM_PRODUCED = ("POSTGRES_ADMIN_URL", "DATABASE_URL", "AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY")   # all the vm lane creates (--verify-db)
VM_STATUSES = ("planned", "reverted", "retired")        # the only statuses a vm app can hold (factory.py:VM_STATUSES)

def vm_report(app_id, d, infra, ds):
    """How a `target: vm` run ends: with ONE next command that exists.

    The vercel tail below this is the wrong report for a vm app. It counts every derived secret as
    something "the provisioner still has to create" — but the provisioner that creates them
    (provision_datastores) only runs for target=vercel, so on a vm app that line names work nobody can
    do, and then points at --deploy, which vm has no answer for. This says what the vm lane actually
    produces, what it cannot, and stops."""
    envf = os.path.join(d, ".env")
    present = {l.split("=")[0].strip() for l in (open(envf) if os.path.exists(envf) else [])
               if "=" in l and not l.startswith("#") and l.split("=", 1)[1].strip()}
    names = infra.get("secrets", [])
    print(f"secrets present in {os.path.relpath(envf, ROOT)}: {len([x for x in names if x in present])}/{len(names)}")
    missing_user = [x for x in infra.get("secrets_user", names) if x not in present]
    if missing_user:
        ask_nicely_for(app_id, missing_user)
    pending = [x for x in VM_PRODUCED if x not in present]
    if pending: print(f"--verify-db writes: {', '.join(pending)}")
    orphan = [x for x in infra.get("secrets_derived", []) if x not in present and x not in VM_PRODUCED]
    if orphan:
        print(f"not produced on this target: {', '.join(orphan)}")
        print("  those are minted by the vercel deploy path, which target=vm never runs. The local database "
              "does not need them, and nothing here is waiting on them.")
    ev = ds.get("postgres", {}).get("rls_verified")
    unproven = rls_mode(ds) != "off" and (not ev or str(ev.get("source", "")).startswith("not verified"))
    if pending or unproven:
        print(f"Next: python3 .claude/scripts/provision.py {app_id} --verify-db"
              "   (brings the local database up and proves tenant isolation on it)")
    else:
        print(f"tenant isolation last proven {ev['at']} on {ev['backend']} "
              f"({ev.get('protected')}/{ev.get('org_scoped_tables')} org-scoped tables protected)")
        print(f"This app is fully verified on this box, and target=vm ends here — it does not serve traffic, so its "
              f"status stays planned (factory.py validate refuses a deployed status on a vm app). "
              f"To put it in front of users, set \"target\": \"vercel\" in "
              f"state/application/{app_id}/infrastructure.json and rerun --check.")
    sys.exit(1 if (missing_user or pending) else 0)

# WHERE EACH OPERATOR CREDENTIAL COMES FROM, derived from what the mold does with it — printed at the
# moment the operator is asked, because the hard part of `--set-secret` was never the command; it was
# the browser tab. `permission` is the LEAST the value needs: the token only ever reaches
# accounts/<id>/ai/v1 (agent/lib/model.ts), and the sign-in code is one POST to api.resend.com/emails
# with PLATFORM_NOTIFY_FROM as the sender verbatim (lib/platform-notify.ts). `shape` is checked before
# the value is written, so a pasted-in-the-wrong-box mistake fails here in a sentence, not in a deploy.
GUIDE = {
  "CLOUDFLARE_ACCOUNT_ID": {
    "what": "your Cloudflare account id (an identifier, not a secret)",
    "where": "dash.cloudflare.com -> Workers & Pages -> the right-hand column shows 'Account ID' with a copy button",
    "why": "GLM 5.2 runs on Workers AI under this account; the app calls api.cloudflare.com/client/v4/accounts/<this>/ai/v1",
    "shape": (r"^[0-9a-f]{32}$", "32 hex characters"),
  },
  "CLOUDFLARE_API_TOKEN": {
    "what": "a Cloudflare API token that may run Workers AI",
    "where": "dash.cloudflare.com -> My Profile (top right) -> API Tokens -> Create Token -> 'Workers AI' template "
             "(or Custom with permission Account / Workers AI / Read) -> Continue -> Create Token -> copy it once",
    "why": "this is the model. Without it the app has no inference at all. Workers AI Read is the ONLY permission it needs; do not grant more",
    "shape": (r"^[A-Za-z0-9_\-]{30,}$", "a single token, 30+ characters, no spaces"),
  },
  "RESEND_API_KEY": {
    "what": "a Resend API key with sending permission",
    "where": "resend.com -> API Keys -> Create API Key -> permission 'Sending access' -> copy it once",
    "why": "sign-in is a six-digit code sent by email, with NO fallback by design: without this key nobody can log in, including you",
    "shape": (r"^re_[A-Za-z0-9_\-]{10,}$", "starts with re_"),
  },
  "PLATFORM_NOTIFY_FROM": {
    "what": "the address the sign-in emails come FROM",
    "where": "resend.com -> Domains -> Add Domain -> add the DNS records it shows at your registrar -> wait for 'Verified'. "
             "Then give ONLY the address at that domain, e.g. signin@yourdomain.com — the display name is this app's own "
             "brand and is filled in for you",
    "why": "Resend rejects a sender whose domain it has not verified, so every login code would bounce",
    "shape": (r"^(?:[^<>@]*[^<>@\s]\s*<)?[^<>@\s]+@[^<>@\s]+\.[A-Za-z]{2,}>?$", "an email address, optionally as Name <address>"),   # the display name may contain spaces: brand_sender writes "OnFinance AI <…>"
  },
  "GOOGLE_CLIENT_ID": {
    "what": "the Google client id for the 'Continue with Google' button (an identifier, public by construction — it ships in the browser bundle)",
    "where": "open console.cloud.google.com/apis/credentials and sign in with the Google account that owns the app's login -> "
             "at the top, pick the project the app belongs to (if you see only one, that is it) -> "
             "under 'OAuth 2.0 Client IDs', click the entry of type 'Web application' -> "
             "in 'Authorised JavaScript origins' click 'Add URI' and paste this app's web address, e.g. https://<project>.vercel.app, with no slash at the end -> "
             "scroll to 'Authorised redirect URIs', click 'Add URI' and paste the very same address again -> "
             "click Save at the bottom (Google can take up to five minutes to apply it) -> "
             "copy the 'Client ID' shown at the top right; it ends in .apps.googleusercontent.com",
    "why": "Google sign-in is the product's front door; without the id the page shows 'Google sign-in is not configured'. The two Google-side entries are not optional: "
           "One Tap needs the origin listed and the button's redirect needs the redirect URI listed; Google refuses with origin_mismatch / redirect_uri_mismatch otherwise. "
           "This one value is written under both names the app reads (GOOGLE_CLIENT_ID for the server, NEXT_PUBLIC_GOOGLE_CLIENT_ID for the browser; the latter is baked in at build, so a --deploy follows)",
    "shape": (r"^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$", "a Google web client id ending in .apps.googleusercontent.com"),
  },
  "NEXT_PUBLIC_GOOGLE_CLIENT_ID": {
    "what": "the same Google OAuth client id, under the name the browser bundle reads",
    "where": "set GOOGLE_CLIENT_ID instead; the factory writes this name from it",
    "why": "one value, two names; setting them separately is how they drift",
    "shape": (r"^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$", "a Google web client id ending in .apps.googleusercontent.com"),
  },
  "AI_GATEWAY_API_KEY": {
    "what": "a Vercel AI Gateway key",
    "where": "vercel.com -> your team -> AI Gateway -> API Keys -> Create",
    "why": "the model for a vercel_ai_gateway app is served through this key instead of Cloudflare",
    "shape": (r"^\S{20,}$", "a single key, no spaces"),
  },
  "EXA_API_KEY": {"what": "an Exa search key", "where": "dashboard.exa.ai -> API Keys", "why": "web search is on for this app", "shape": (r"^\S{16,}$", "a single key")},
  "BROWSERBASE_API_KEY": {"what": "a Browserbase key", "where": "browserbase.com -> Settings -> API Keys", "why": "the browser is on for this app", "shape": (r"^\S{16,}$", "a single key")},
}

def brand_sender(app, value):
    """PLATFORM_NOTIFY_FROM with THIS app's product name as the display name, whatever was typed.

    The name a person sees on a sign-in email is a brand, and the brand belongs to the application
    (surface.branding.product_name, copied from its product at stamp time) — the same value the
    branding overlay writes into the email text itself. It is never typed by hand, so an app stamped
    from a different product cannot be sent out under another product's name. The operator supplies
    only the address; a display name they typed is replaced, not kept."""
    m = re.fullmatch(r"\s*(?:[^<>]*<)?\s*([^<>\s]+@[^<>\s]+)\s*>?\s*", value or "")
    if not m: return value
    name = ((app.get("surface") or {}).get("branding") or {}).get("product_name") or \
           ((app.get("workspace") or {}).get("org") or {}).get("name") or ""
    name = re.sub(r'[<>"\r\n]', "", name).strip()
    return f"{name} <{m.group(1)}>" if name else m.group(1)

def explain(name):
    """A friendly walk-through, printed before the hidden prompt, for someone who does not work in terminals
    or dashboards every day: what the thing is, why the app needs it, then the clicks as numbered steps
    (GUIDE['where'] is written as 'A -> B -> C'; each arrow becomes one step)."""
    g = GUIDE.get(name)
    if not g: return
    steps = [x.strip() for x in g["where"].split("->") if x.strip()]
    print(f"\nHi! One thing is needed before this app can run: {g['what']}.")
    print(f"Why it matters: {g['why']}.")
    if len(steps) > 1:
        print("Here is how to get it, one click at a time:")
        for i, st in enumerate(steps, 1): print(f"  {i}. {st}")
    else:
        print(f"Where to find it: {steps[0] if steps else g['where']}")
    print("When you have it, paste it at the prompt below. The screen stays blank while you paste; that is on purpose,")
    print("so the value is never shown, saved here, or sent to chat. Then press Enter. Take your time.\n")

def ask_nicely_for(app_id, missing):
    """The one message a non-technical operator sees when secrets are missing. Names what is needed in plain
    words, one command per item, and promises what happens next."""
    # One client id feeds both Google names, so the browser-side name is not a separate thing to fetch.
    if "GOOGLE_CLIENT_ID" in missing: missing = [m for m in missing if m != "NEXT_PUBLIC_GOOGLE_CLIENT_ID"]
    n = len(missing)
    print(f"\nAlmost there. {n} thing{'s' if n != 1 else ''} still need{'s' if n == 1 else ''} to come from you, "
          "because only you can log in to those accounts:")
    for m in missing:
        g = GUIDE.get(m, {})
        print(f"  - {m}: {g.get('what', 'a credential')}")
    print("Run each line below, one at a time. Each one explains where to find the value and then asks you to paste it "
          "(hidden, never stored here or shown in chat):")
    for m in missing: print(f"  python3 .claude/scripts/provision.py {app_id} --set-secret {m}")
    print("After the last one, run the check again and it will say Ready.")

def check_shape(name, value):
    g = GUIDE.get(name)
    if not g: return
    pat, human = g["shape"]
    if not re.fullmatch(pat, value):
        sys.exit(f"{name}: that does not look like {human}, so it was not written. Nothing was stored. "
                 f"Check the value against 'where' above and rerun.")

def set_secret(app_id, name, infra, mold_dir):
    """Prompt for one credential and write it where this app's secrets live.
    The value is read from the terminal, never passed on a command line and never stored here.

    `infra["vercel"]` used to be read unconditionally, so this — the ONE command a non-technical
    operator is ever told to run — died with KeyError: 'vercel' on any app that is not on Vercel."""
    import getpass
    declared = list(infra.get("secrets_user") or []) + list(infra.get("secrets") or [])
    if name not in declared and name not in GUIDE:
        # The operator pasted the VALUE where the NAME goes (2026-09-19). Say so; never echo it back, never store it.
        ask = [n for n in (infra.get("secrets_user") or []) if n in GUIDE]
        sys.exit("That does not look like the NAME of a credential; it looks like the value itself. The name goes on the "
                 "command line and the value is asked for afterwards. Names this app needs: " + ", ".join(ask) +
                 f".\nExample: python3 .claude/scripts/provision.py {app_id} --set-secret {ask[0] if ask else 'NAME'}")
    explain(name)
    if sys.stdin.isatty():
        value = getpass.getpass(f"{name} (input hidden): ").strip()
    else:
        # No terminal to hide typing in (the `!` shortcut inside a chat, a pipe, a script). getpass used to die
        # here with a traceback. A piped value is accepted; with nothing piped, point at the web form instead.
        value = sys.stdin.readline().strip()
        if not value:
            where = (f"https://vercel.com/{infra['vercel']['team']}/{infra['vercel']['project']}/settings/environment-variables"
                     if infra.get("target") == "vercel" else "a terminal on the machine (not the chat)")
            sys.exit(f"\nThis window cannot hide what you type, so nothing was asked and nothing was saved.\n"
                     f"Enter {name} in the web form instead: {where}\n"
                     f"  Key: {name}   Value: (paste)   Environment: Production   Sensitive: OFF   then Save.")
    if not value: sys.exit("nothing entered")
    if name == "PLATFORM_NOTIFY_FROM":
        app = load(os.path.join(ST, "application", app_id, "application.json"))
        value = brand_sender(app, value)
        print(f"  display name taken from this app's branding: {value.split(' <')[0] if ' <' in value else '(none)'}")
    check_shape(name, value)
    names = [name]
    if name in ("GOOGLE_CLIENT_ID", "NEXT_PUBLIC_GOOGLE_CLIENT_ID"):
        names = ["GOOGLE_CLIENT_ID", "NEXT_PUBLIC_GOOGLE_CLIENT_ID"]   # one client id, both names the app reads
        print("  written under both names the app reads (server and browser); NEXT_PUBLIC_ is baked in at build, so run --deploy after")
    if infra.get("target") == "vercel":
        proj = infra["vercel"]["project"]; projects = [proj, f"{proj}-api", f"{proj}-workflow"]
        absent = [p for p in projects if not _project_meta(p, mold_dir).get("id")]
        if absent:
            # The value needs somewhere to live and the API answers 404 for a project that does not exist.
            # --check never creates these (mold_v1-041); this writer does, and says so first.
            print(f"creating the Vercel project(s) {', '.join(absent)} to hold {name} (empty, free, no deployment) ...")
            ensure_projects(proj, mold_dir)
        for n_ in names:
            for p in projects: _set_env(n_, value, mold_dir, project=p)
        where = f"{len(projects)} project(s)"
    else:
        f = os.path.join(ROOT, "infra/vm/apps", app_id, ".env")
        os.makedirs(os.path.dirname(f), exist_ok=True)
        lines = [l for l in (open(f).read().splitlines() if os.path.exists(f) else []) if not l.startswith(f"{name}=")]
        old = os.umask(0o077)
        try: open(f, "w").write("\n".join(lines + [f"{name}={value}"]) + "\n")
        finally: os.umask(old)
        os.chmod(f, 0o600); where = os.path.relpath(f, ROOT)
    print(f"{name} set on {where}.")
    if name in ("GOOGLE_CLIENT_ID", "NEXT_PUBLIC_GOOGLE_CLIENT_ID"):
        # The client id's numeric prefix IS the Google Cloud project number, so the app's Google project is
        # recorded from the value itself: an identifier, public by construction, never a secret. Every app
        # carries its own, so two apps in this factory may sit in two different Google projects.
        ip = os.path.join(ST, "application", app_id, "infrastructure.json"); doc = load(ip)
        doc["google"] = {"project_number": value.split("-", 1)[0], "client_id": value, "set_at": NOW}
        save(ip, doc)
        print(f"  this app's Google project is number {doc['google']['project_number']} (recorded in infrastructure.google; other apps may use other projects)")

HEALTH_PATH = "/api/ops/health"
# The mold's ONE affirmative health sentence, and the only thing that may score `enforced` below.
RLS_ENFORCED_DETAIL = re.compile(r"role\s+(\S+)\s+\(RLS enforced\)")
RLS_TOKENS = ("enforced", "not_enforced", "unmeasured")   # datastores.schema.json: rls_verified.running_app
def _read_health(url):
    """(http status, parsed JSON body or None, one-line reason it is not readable). Read-only."""
    r = subprocess.run(f"curl --silent --show-error --max-time 20 -w '\\n%{{http_code}}' {url}",
                       shell=True, capture_output=True, text=True)
    body, _, code = r.stdout.rpartition("\n"); code = code.strip()
    if r.returncode or not code:
        return "", None, "nothing answered: " + (((r.stderr or "").strip().splitlines() or ["no response"])[-1])[:120]
    try: doc = json.loads(body)
    except Exception: doc = None
    if not isinstance(doc, dict):
        return code, None, f"HTTP {code}, and the body is not a health document ({body.strip()[:60]!r})"
    return code, doc, ""

def _rls_from_doc(code, doc, why):
    """What the app IN FRONT OF TRAFFIC says about row-level security — or `unmeasured`, never an
    affirmative it did not earn.

    THIS VALUE IS RECORDED as datastores.postgres.rls_verified.running_app and printed to the operator,
    and it is the only reading that covers the process actually serving requests. It used to be a regex
    for a warning string over whatever came back, so a 404 DEPLOYMENT_NOT_FOUND page, a 401 Vercel
    protection wall and a 500 crash — none of which contain the word BYPASSRLS — all scored as the
    affirmative "no BYPASSRLS warning on /api/ops/health". An endpoint is unreadable exactly when a
    deploy has gone wrong, which is exactly when that reading was consulted.

    READ THE BODY, NOT THE STATUS CODE, and only THIS body: the mold's checkDb reports the warning as
    `db.detail` with ok:true, so the endpoint answers 200 while announcing that RLS is off. A response
    that carries no db check is not this app's health endpoint and proves nothing about it.

    RETURNS (token, detail). The token is one of RLS_TOKENS — the enum datastores.schema.json fixes for
    rls_verified.running_app — and it is the ONLY thing anyone compares: provision.py's two gates
    (verify_rls, and the --deploy gate before status becomes `stamped`) and factory.py:_rls_claim all
    test `== "enforced"`. The detail is the db.detail sentence or the reason nothing could be read,
    recorded beside it as running_app_detail and printed, never parsed. The old shape was one string
    ("enforced — ...") that both files prefix-matched, so a rewording on either side changed verdicts."""
    if doc is None: return "unmeasured", why
    db = doc.get("db") if isinstance(doc.get("db"), dict) else {}
    det = db.get("detail")
    if not isinstance(det, str) or not det:
        return "unmeasured", f"HTTP {code} answered, but the body carries no db check — this is not {HEALTH_PATH}"
    if re.search(r"BYPASSRLS|row-level security is NOT enforced", det, re.I): return "not_enforced", det[:180]
    if not db.get("ok"): return "unmeasured", f"the app could not reach its database — {det[:160]}"
    # POSITIVE MATCH, NOT ABSENCE — the same mistake one level in. Scoring "enforced" because the
    # warning is missing means every db.detail this factory does not recognise is read as good news:
    # an older build, a forked health route, a `detail` that only says "SELECT 1 ok" all earned the
    # affirmative while nothing had reported a role at all. The mold emits exactly one affirmative
    # sentence (app/api/ops/health/route.ts:94, `SELECT 1 ok · role ${role} (RLS enforced)`) and it is
    # printed ONLY when pg_roles.rolbypassrls came back false for the role the serving process is
    # connected as. Match that, or record that nothing was measured.
    if not RLS_ENFORCED_DETAIL.search(det):
        return "unmeasured", (f"HTTP {code} answered and the db check reads {det[:110]!r}, which is not this "
                              f"mold's `role <name> (RLS enforced)` sentence, so it names no role and settles nothing")
    return "enforced", det[:180]

def _rls_from_health(origin):
    return _rls_from_doc(*_read_health(origin.rstrip("/") + HEALTH_PATH))

VM_NO_PROCESS = ("target vm serves nothing: no web, API or workflow process is ever started on this lane, so no "
                 "process holds DATABASE_URL in front of traffic; the lane ends at --verify-db and the app stays planned")
def _health_rls(infra):
    if infra.get("target") == "vm":
        # Never read vm.production_url. Nothing on this lane starts the application (infra/vm/README.md),
        # so a URL sitting in that field was typed in, and whatever answers it is not a process this
        # factory deployed — reading `enforced` off it would grade a stranger's endpoint as this app's.
        # The safe value is the constant one: unmeasured, with the reason (mold_v1-047).
        return "unmeasured", VM_NO_PROCESS
    u = (infra.get("vercel") or {}).get("production_url") or ""
    if not u.startswith("http"): return "unmeasured", "this app has no production URL yet"
    return _rls_from_health(u)

def verify_rls(app_id, app, infra, ds, adir, mold_dir, repair=True):
    """Prove tenant isolation on an app that is ALREADY deployed, and record the result.

    Self-discovering, because the operator is not technical (HARD RULE 4): the admin URL and the app
    URL come from wherever this app's secrets live — Vercel production env for a vercel app, the app's
    own 0600 `.env` for a vm one — and nothing is ever asked for on the command line. Neither URL is
    printed. On failure it prints ONE instruction.

    `repair` runs the coverage pass first, which is what makes this safe to run after a clone restore
    or after any migration: pg_restore --clean drops every policy, and a migration adds tables that
    inherit app_rw's DML grant with no policy at all."""
    mode = rls_mode(ds); prov = ds.get("postgres", {}).get("provider", "supabase")
    if ds.get("postgres", {}).get("scope") == "shared_with_live" and repair:
        # scope shared_with_live means this app borrows the LIVE database. Measuring it is fine; applying
        # DDL to it from here is not, whatever the app declares.
        repair = False; print("  scope is shared_with_live: measuring only, no coverage pass (that database belongs to another application)")
    if mode == "off":
        return print(f'{app_id}: datastores.postgres.rls is "off" — this application did not ask for tenant '
                     f"isolation, so there is nothing to prove. Set it to \"fail_closed\" to turn the gate on.")
    if infra.get("target") == "vercel":
        proj = infra["vercel"]["project"]; vals = pull_env(mold_dir, proj)
        adm, appurl, run = admin_url(vals), vals.get("DATABASE_URL", ""), _lib_runner(mold_dir)
        hint = f"python3 .claude/scripts/provision.py {app_id} --check"
        if not appurl:
            sys.exit(f"{app_id}: {proj} has no readable DATABASE_URL, so there is nothing to prove yet.\n"
                     f"  Run: python3 .claude/scripts/provision.py {app_id} --verify-db")
        if repair and not adm:
            sys.exit(f"{app_id}: no admin database URL on {proj} (none of {'/'.join(ADMIN_KEYS)}), so the coverage "
                     f"pass cannot run.\n  Run: {hint}")
    else:
        envf = os.path.join(ROOT, "infra/vm/apps", app_id, ".env")
        vals = {l.split("=", 1)[0].strip(): l.split("=", 1)[1].strip() for l in (open(envf).read().splitlines() if os.path.exists(envf) else []) if "=" in l and not l.startswith("#")}
        adm, appurl, run = vals.get("POSTGRES_ADMIN_URL", ""), vals.get("DATABASE_URL", ""), _vm_runner(app_id, mold_dir)
        hint = f"python3 .claude/scripts/provision.py {app_id} --verify-db"
        if not appurl:
            sys.exit(f"{app_id}: this app's local database has not been brought up yet.\n  Run: {hint}")
        # Same guard as the vercel branch: an .env holding DATABASE_URL but no POSTGRES_ADMIN_URL (an
        # older artifact, a hand-edited file) otherwise reached rls-cover.mjs with ADMIN_URL= and died
        # on "ADMIN_URL is not set" — true, and useless to the person reading it.
        if repair and not adm:
            sys.exit(f"{app_id}: infra/vm/apps/{app_id}/.env has no POSTGRES_ADMIN_URL, so the coverage pass "
                     f"cannot run.\n  Run: {hint}")
    if repair: _rls_cover(run, adm, mode, hint)
    ev = _verify_app_rw(run, appurl, mode, prov, "provision.py --verify-rls", hint)
    # What the RUNNING app uses is a different fact from what the stored credential proves: a Vercel env
    # change only takes effect on the NEXT build. Read the app's own health endpoint and say which of the
    # two this evidence covers — `--verify-db` printed that caveat and this command printed none, so
    # `--verify-rls` -> `factory.py validate` could end green while the live process still ran as postgres.
    ev["running_app"], ev["running_app_detail"] = _health_rls(infra)
    record_rls(adir, ds, ev)
    print(f"{app_id}: tenant isolation PROVEN on the stored DATABASE_URL — {ev['protected']}/{ev['org_scoped_tables']} "
          f"org-scoped tables enabled+forced+scoped, {len(ev['open_policies'])} policy/policies that do not scope by "
          f"org_id, {ev['policies_executed']} policy/policies executed with {len(ev['leaking_policies'])} handing over "
          f"another workspace's rows, {ev['foreign_rows_readable']} foreign row(s) readable as {ev['role']} across "
          f"{ev['probe_tables']} probed table(s), cross-workspace write refused with {ev['cross_org_write']}")
    if infra.get("target") == "vm":
        # THE VM LANE ENDS HERE, and says so instead of pointing at --deploy (which refuses a vm app). The
        # stored credential is proven; a serving process is not, because none exists on this lane — that
        # is recorded as `unmeasured` above, and factory.py validate refuses any deployed status on a vm
        # app, so this app's status stays `planned` and nothing here is left for a later command.
        return print(f"  no serving process was measured — {VM_NO_PROCESS}. This app's status stays planned.")
    if ev["running_app"] == "not_enforced":
        sys.exit(f"{app_id}: but the app SERVING TRAFFIC still says row-level security is not enforced "
                 f'("{ev["running_app_detail"][:160]}"). A Vercel env change only reaches the app on its next build.\n'
                 f"  Run: python3 .claude/scripts/provision.py {app_id} --deploy")
    if ev["running_app"] != "enforced":
        # `unmeasured` is not a pass. The stored credential is proven; the process in front of traffic is
        # not, and it is recorded that way rather than as the affirmative this used to print.
        sys.exit(f"{app_id}: the stored DATABASE_URL is proven, but NOTHING could be read from the app serving "
                 f"traffic, so what that process runs as is unknown and has been recorded unmeasured "
                 f'("{ev["running_app_detail"][:160]}").\n'
                 f"  Run: python3 .claude/scripts/provision.py {app_id} --deploy")
    print(f"  the running app reports: enforced ({ev['running_app_detail']})")

def _revert(adir, app, reason, note=""):
    """A deploy that could not prove isolation is not a deploy. Record it as reverted, with the reason,
    instead of leaving the app in `stamping` or — as before — writing `stamped` regardless. `note` (what
    this run actually replaced in production) is kept whole, after the truncated reason."""
    app["status"] = "reverted"
    app["revert"] = {"reason": (reason[:400] + (" " + note if note else "")).strip(), "lane": "functional", "at": NOW}
    save(os.path.join(adir, "application.json"), app)
    print(f"  status set to reverted: {reason[:200]}")

LIVE_PROJECTS = ("fde-agent", "fde-agent-api", "fde-task-workflow")   # read-only by the factory's founding rule

def _refuse_live_or_shared_project(app_id, infra):
    """Two refusals that every Vercel writer must pass, --set-secret first of all.

    The live projects are read-only to this factory (AGENTS.md); until today nothing in provision.py
    checked the name, so an infrastructure.json pointing vercel.project at fde-agent would have been
    written to. And --set-secret returned before the "others already deploy to this project" check,
    so a value could land in another app's environment namespace. Both found by the round-4 critic."""
    proj = (infra.get("vercel") or {}).get("project", "")
    mine = {proj, f"{proj}-api", f"{proj}-workflow"}
    if mine & set(LIVE_PROJECTS) or proj in LIVE_PROJECTS:
        sys.exit(f"{app_id}: vercel.project is {proj!r}, one of the LIVE projects this factory never writes to "
                 f"({', '.join(LIVE_PROJECTS)}). Give the app its own project name in state/application/{app_id}/"
                 f"infrastructure.json and rerun. Nothing was written.")
    others = []
    for o in sorted(os.listdir(os.path.join(ST, "application"))):
        if o in (app_id, "app_id"): continue
        f = os.path.join(ST, "application", o, "infrastructure.json")
        try:
            op = (load(f).get("vercel") or {}).get("project", "")
            ost = load(os.path.join(ST, "application", o, "application.json")).get("status")
        except Exception: continue
        if ost in ("retired", "dropped"): continue   # it deploys nothing, so it shares nothing (claudecode_web_internal)
        if op and op == proj: others.append(o)
    if others:
        sys.exit(f"{app_id}: {', '.join(others)} already deploy to the Vercel project {proj}. One project is one "
                 f"environment namespace and one app_rw password, so writing this app's secrets or resources there "
                 f"would land in that app's environment. Give this app its own project in state/application/{app_id}/"
                 f"infrastructure.json (vercel.project) and rerun. Nothing was written.")

FAKE_VERCEL = r'''#!/bin/sh
# a stand-in for the vercel CLI, driven by FAKE_MODE; writes what it was asked to cancel to $FAKE_DIR/cancelled
case "$1 $2" in
  "deploy "*|"deploy")
    case "$FAKE_MODE" in
      nourl) sleep 30 ;;
      ready) echo "Production: https://fake-abc123.vercel.app [1s]"; sleep 1; echo "Aliased: https://fake.vercel.app"; exit 0 ;;
      *) echo "Production: https://fake-abc123.vercel.app [1s]"; sleep 30 ;;
    esac ;;
  "api /v13/deployments/"*)
    case "$FAKE_MODE" in
      error) echo '{"id":"dpl_fake","readyState":"ERROR"}' ;;
      building) echo '{"id":"dpl_fake","readyState":"BUILDING"}' ;;
      unreadable) echo 'Error: not authorized' >&2; exit 1 ;;
      ready) echo '{"id":"dpl_fake","readyState":"BUILDING"}' ;;
      *) echo '{"id":"dpl_fake","readyState":"QUEUED"}' ;;
    esac ;;
  "api /v12/deployments/"*) echo "$2" >> "$FAKE_DIR/cancelled"; echo '{}' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
'''

def self_test():
    """Offline checks of the deadline, deploy-watch and headroom logic. No network, no state, no Vercel."""
    fails, n = [], [0]
    def check(name, cond, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{name}{': ' + str(detail) if detail else ''}")
    # 1. a call past its deadline is killed with its whole process group and says how long it ran
    t0 = time.monotonic()
    try: vrun("sh -c 'sleep 30 & sleep 30'", timeout=1); check("vrun timeout", False, "no exit")
    except SystemExit as e: check("vrun timeout names the elapsed time", "timed out after" in str(e) and "limit 1s" in str(e), e)
    check("vrun timeout does not wait on a grandchild's pipe", time.monotonic() - t0 < 6, f"{time.monotonic() - t0:.1f}s")
    r = vrun("echo hi; exit 3")
    check("vrun passes output and exit code through", r.stdout.strip() == "hi" and r.returncode == 3, r)
    check("vrun scrubs credentials from the label", "***@" in _label("psql postgres://u:pw@h/db") and "pw" not in _label("psql postgres://u:pw@h/db"))
    # 2. `vercel deploy` watched against a fake CLI
    d = tempfile.mkdtemp(prefix="provision-selftest-")
    try:
        fake = os.path.join(d, "vercel"); open(fake, "w").write(FAKE_VERCEL); os.chmod(fake, 0o755)
        def deploy(mode, **kw):
            env = dict(os.environ, PATH=f"{d}:{os.environ['PATH']}", FAKE_MODE=mode, FAKE_DIR=d)
            try: os.remove(os.path.join(d, "cancelled"))
            except FileNotFoundError: pass
            old = os.environ.copy(); os.environ.update(env)   # the watcher's own `vercel api` polls find the fake too
            try: return vercel_deploy("vercel deploy --prod --yes", d, f"{mode} deploy", env=env, quiet=True, **kw), None
            except SystemExit as e: return None, str(e)
            finally: os.environ.clear(); os.environ.update(old)
        cancelled = lambda: open(os.path.join(d, "cancelled")).read() if os.path.exists(os.path.join(d, "cancelled")) else ""
        t0 = time.monotonic(); out, err = deploy("stuck", stall=1.5, poll=0.3, timeout=20)
        check("a deployment stuck in QUEUED is given up on", err and "sat at QUEUED" in err, err)
        check("  ...within the stall limit, not the CLI's forever", time.monotonic() - t0 < 10, f"{time.monotonic() - t0:.1f}s")
        check("  ...and cancelled on Vercel", "dpl_fake" in cancelled() and "Cancelled dpl_fake" in (err or ""), cancelled())
        out, err = deploy("ready", stall=5, poll=0.3, timeout=20)
        check("a deployment that finishes returns its output", out and "fake.vercel.app" in out and not err, err)
        check("  ...and is not cancelled", not cancelled())
        out, err = deploy("error", stall=5, poll=0.3, timeout=20)
        check("an ERROR deployment ends the wait at once", err and "as ERROR" in err, err)
        check("  ...without a cancel", not cancelled())
        out, err = deploy("nourl", stall=0.5, poll=0.3, timeout=20)
        check("a deploy that never creates a deployment is given up on", err and "(not created yet)" in err, err)
        out, err = deploy("unreadable", stall=0.5, poll=0.3, timeout=2)
        check("a state the API cannot report is bounded by the timeout, not called stuck", err and "no result within 2s" in err and "last state UNKNOWN" in err, err)
        prev = signal.signal(signal.SIGALRM, _on_signal); signal.setitimer(signal.ITIMER_REAL, 1.0)
        t0 = time.monotonic(); out, err = deploy("stuck", stall=60, poll=0.3, timeout=60)
        signal.signal(signal.SIGALRM, prev)
        check("a signal mid-deploy stops the watch at once", err and "SIGALRM" in err and time.monotonic() - t0 < 5, err)
        check("  ...and cancels the deployment it started", "dpl_fake" in cancelled(), cancelled())
        out, err = deploy("building", stall=1, poll=0.3, timeout=2)
        check("BUILDING is bounded by the overall timeout, not the stall", err and "no result within 2s" in err and "BUILDING" in err, err)
        check("  ...and cancelled", "dpl_fake" in cancelled())
    finally:
        shutil.rmtree(d, ignore_errors=True)
    # 3. headroom: waits with progress, gives up at the deadline, never sleeps for real here
    seq = iter([(9.0, 500), (6.0, 4000), (1.0, 5000)]); slept = []
    ok, now = wait_for_headroom("x", deadline_s=600, probe=lambda: next(seq), sleep=slept.append, every=30)
    check("headroom waits until load and memory are both under the limits", ok and len(slept) == 2 and "load 1.0" in now, (ok, slept, now))
    slept = []
    ok, now = wait_for_headroom("x", deadline_s=90, probe=lambda: (12.0, 100), sleep=slept.append, every=30)
    check("headroom gives up at its deadline", not ok and sum(slept) == 90, (ok, slept))
    check("heap ceiling is half of what is free, clamped to 2-4GB",
          (_node_options(6000), _node_options(1000), _node_options(20000)) ==
          ("--max-old-space-size=3000", "--max-old-space-size=2048", "--max-old-space-size=4096"))
    check("an existing heap ceiling is kept", _node_options(6000, "--max-old-space-size=1234") == "--max-old-space-size=1234")
    # 4. the heavy build: nice, NODE_OPTIONS, one retry on an OOM kill only
    CP = subprocess.CompletedProcess
    for codes, want_calls, want_rc in (([137, 0], 2, 0), ([137, 137], 2, 137), ([1, 0], 1, 1), ([0], 1, 0)):
        calls, it = [], iter(codes)
        def runner(c, e): calls.append((c, e.get("NODE_OPTIONS", ""))); return CP(c, next(it), "", "")
        r = heavy_build("vercel build", "/", "eve api build", env={}, wait=lambda l: (True, "quiet"), runner=runner)
        check(f"heavy build exits {codes}: {want_calls} call(s), rc {want_rc}", len(calls) == want_calls and r.returncode == want_rc, (calls, r.returncode))
        check(f"  ...under nice with a heap ceiling", all(c.startswith("nice -n 10 vercel build") and "max-old-space-size" in o for c, o in calls), calls)
    check("an OOM reported only in the output counts", _oom_killed(CP("x", 1, 'Error: Command "npm run build:eve" exited with 137', "")))
    check("an ordinary failure does not", not _oom_killed(CP("x", 1, "Type error: foo", "")))
    # 5. the record a stopped deploy leaves
    SHIPPED.clear()
    check("nothing shipped says the old deployment still serves", "still serving" in shipped_note())
    SHIPPED.append(("workflow", "https://w.vercel.app"))
    check("a partial deploy names what it replaced and what it did not", "Replaced in production before it stopped: workflow" in shipped_note() and "api, web" in shipped_note(), shipped_note())
    d = tempfile.mkdtemp(prefix="provision-selftest-")
    try:
        app = {"status": "stamping"}
        _revert(d, app, "x" * 1000, shipped_note())
        got = load(os.path.join(d, "application.json"))
        check("revert keeps the whole note after a long reason", got["status"] == "reverted" and got["revert"]["reason"].endswith(shipped_note()), got)
    finally:
        shutil.rmtree(d, ignore_errors=True); SHIPPED.clear()
    # 6. SIGTERM becomes a SystemExit the revert handler catches
    prev = signal.signal(signal.SIGTERM, _on_signal)
    try:
        os.kill(os.getpid(), signal.SIGTERM); time.sleep(1); check("SIGTERM unwinds", False, "no exception")
    except SystemExit as e: check("SIGTERM unwinds as SystemExit naming the signal", "SIGTERM" in str(e), e)
    finally: signal.signal(signal.SIGTERM, prev)
    if fails:
        sys.exit("self-test FAILED:\n  " + "\n  ".join(fails))
    print(f"self-test ok: {n[0]} checks (deadlines, deploy watch, headroom, OOM retry, honest revert, signals)")

def shipped_note():
    """What a stopped deploy really changed in production (mold_v1-106/109). A deploy that died in the eve
    build replaced nothing the web app serves, and the record should say so rather than read as an outage."""
    done = [n for n, _ in SHIPPED]
    rest = [n for n in ("workflow", "api", "web") if n not in done]
    if not done:
        return "Nothing was replaced in production: the previous deployment of every service is still serving."
    return (f"Replaced in production before it stopped: {', '.join(done)}. "
            + (f"Still serving their previous deployment: {', '.join(rest)}." if rest else ""))

def _on_signal(signum, _frame):
    # SIGTERM (a `kill`, a timeout wrapper, systemd) and SIGHUP (a closed terminal) used to end the process
    # without unwinding, so the handler below never ran and the app stayed `stamping` (mold_v1-106). As a
    # SystemExit they land in that handler like any other stop. SIGKILL cannot be caught by anything.
    raise SystemExit(f"the deploy was stopped by {signal.Signals(signum).name} before it finished")

def main(a):
    if a and a[0] == "--self-test": return self_test()
    if not a or a[0].startswith("-"): sys.exit(__doc__)   # `--help`, or a flag where the app id goes
    app_id = a[0]; deploy = "--deploy" in a
    adir = os.path.join(ST, "application", app_id)
    if not os.path.isfile(os.path.join(adir, "application.json")):
        sys.exit(f"{app_id}: no such application (state/application/{app_id}/application.json does not exist). "
                 f"Registered: {', '.join(sorted(os.listdir(os.path.join(ST, 'application'))) or ['none'])}. "
                 f"Stamp one first: python3 .claude/scripts/intake.py briefs/{app_id}.md --app {app_id}")
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")   # a branded build dir replaces this after the plan is printed
    secrets = infra.get("secrets", []); target = infra["target"]; store = infra.get("secret_store")
    ds = load(os.path.join(adir, "datastores.json")); prov = ds.get("postgres", {}).get("provider", "supabase")
    global ADMIN_KEYS
    ADMIN_KEYS = (ds.get("postgres", {}).get("admin_url_ref") or PROVIDER_ADMIN.get(prov, "POSTGRES_ADMIN_URL"),)
    print(f"{app_id}: target={target} store={store} postgres={prov} secrets={len(secrets)}")
    if target == "vm" and not deploy and app.get("status") not in VM_STATUSES:
        # The same refusal factory.py validate makes (_vm_status), at the writer: a vm app never serves
        # traffic, and this lane never writes a status that says it does, so one that says so was set
        # by hand. It sits BEFORE every writer — --set-secret, --verify-rls, --check, --verify-db — because
        # each of them would record something beside a status the record cannot support (--verify-rls used
        # to run and write rls_verified under a `stamped` vm app). --deploy keeps its own refusal below.
        sys.exit(f"{app_id}: status is {app.get('status')!r} but target is \"vm\", which never serves traffic and "
                 f"never reaches that status. Set \"status\": \"planned\" in state/application/{app_id}/"
                 f"application.json and rerun, or set \"target\": \"vercel\" to deploy it for real.")
    if target == "vercel":
        _refuse_live_or_shared_project(app_id, infra)   # ahead of --set-secret: it writes env into the project
    if "--set-secret" in a:
        return set_secret(app_id, a[a.index("--set-secret") + 1], infra, mold_dir)
    if "--verify-rls" in a:
        # The gate on its own, against whatever is deployed right now. Nothing is built, nothing is
        # deployed, no password is rotated — `--verify-db` rotates app_rw, this does not.
        return verify_rls(app_id, app, infra, ds, adir, mold_dir, repair="--no-repair" not in a)
    # NO POSTGRES PORT IS EVER OPENED TO THE INTERNET. That refusal is code, not a comment.
    # A self_hosted database here lives on a private docker network with no host port, which a Vercel
    # function cannot reach. Making it reachable would mean `hostssl ... 0.0.0.0/0` — the team is on
    # Vercel Pro, which has no static egress IP, so there is no narrower rule — with sslmode=require
    # and no server authentication (verify-full needs `ssl:{ca}` in agent/lib/db/index.ts, a mold edit
    # HARD RULE 1 forbids), on a droplet with ufw inactive and ~1100 SSH credential attempts a day.
    if prov == "self_hosted" and target == "vercel":
        sys.exit(f'{app_id}: postgres.provider "self_hosted" is a LOCAL database on this box (private docker '
                 f'network, no host port) and a Vercel deployment cannot reach it — and this factory never opens '
                 f'a Postgres port to the internet. Set "provider": "neon" in state/application/{app_id}/'
                 f'datastores.json (Neon\'s free tier is available) and rerun. To use it locally: '
                 f'python3 .claude/scripts/provision.py {app_id} --verify-db')
    if target != "vercel" and prov != "self_hosted":
        # THE ARTIFACT MUST MATCH THE STATE. target=vm builds exactly one thing — a local postgres:17 on
        # a private docker network — and --verify-db then brings that container up and writes ITS url as
        # this app's DATABASE_URL. Neither function ever read postgres.provider, so an app whose state
        # says `neon` got a self_hosted database anyway: an .env.example headed `provider: neon` above a
        # postgres:17 compose file, a DATABASE_URL pointing at a container instead of at Neon, and an
        # rls_verified block stamped `backend: neon` from a measurement taken on the wrong database
        # (factory.py validate compares those two, which is how it would surface much later).
        sys.exit(f'{app_id}: target "vm" builds one artifact — a local Postgres on a private docker network — '
                 f'but datastores.postgres.provider is "{prov}", so there is nothing here to generate for it '
                 f'and nothing was written.\n'
                 f'  To verify this app locally: set "provider": "self_hosted" in state/application/{app_id}/datastores.json\n'
                 f'  To run it on {prov}:        set "target": "vercel" in state/application/{app_id}/infrastructure.json')
    pg = ds.get("postgres", {})
    if pg.get("scope") == "shared_with_live" and pg.get("tenancy") == "multi_org":
        # The `shared` branch of deploy_vercel skips bring_up_schema entirely — no app_rw, no coverage
        # pass, no isolation proof — and then records the app as stamped. A multi-tenant application on
        # a database this deploy neither bootstraps nor gates cannot honestly claim isolation.
        sys.exit(f'{app_id}: datastores.postgres pairs scope "shared_with_live" with tenancy "multi_org". '
                 f"That deploy borrows another application's database, so it never creates app_rw and never "
                 f"proves tenant isolation, yet multi_org means the app serves more than one workspace. Set "
                 f'"scope": "fresh" in state/application/{app_id}/datastores.json (the app gets its own '
                 f'database) or "tenancy": "single_org" if it really serves one workspace.')
    if target == "vercel":
        proj = infra["vercel"]["project"]
        others = []
        for other in sorted(os.listdir(os.path.join(ST, "application"))):
            if other in (app_id, "app_id"): continue
            f = os.path.join(ST, "application", other, "infrastructure.json")
            g = os.path.join(ST, "application", other, "application.json")
            if not (os.path.exists(f) and os.path.exists(g)): continue
            if load(g).get("status") in ("retired", "reverted", "planned"): continue
            if load(f).get("vercel", {}).get("project") == proj: others.append(other)
        if others:
            # One Vercel project is ONE env namespace and app_rw is a CLUSTER-GLOBAL role, so provisioning
            # the second app rewrites the first app's DATABASE_URL and rotates the password out from under
            # its running build. intake.py already refuses this shape for self_hosted; there is no reason
            # it is safe here. (claudecode_web_internal and claudecode_web_replica were both configured
            # onto claudecode-web; internal is retired, which is why only one of them is live.)
            sys.exit(f"{app_id}: {', '.join(others)} already deploy to the Vercel project {proj}. One project is one "
                     f"environment namespace and one app_rw password, so provisioning this app would rewrite that "
                     f"app's DATABASE_URL and rotate its database password. Give this app its own project in "
                     f"state/application/{app_id}/infrastructure.json (vercel.project) and rerun.")
        # A CHECK IS READ-ONLY (mold_v1-041). Everything below up to `writer` is GETs and list calls; the
        # plan says what a writer would create, and only --deploy / --verify-db go on to create it.
        writer = deploy or "--verify-db" in a
        plan = vercel_plan(app_id, app, infra, ds, mold_dir, proj, "verify-db" if "--verify-db" in a else "deploy")
        print_plan(plan, "about to create:" if writer else "a deploy will create:")
        present = plan["present"]
        # report a reconnected project before anyone deploys: a git-sourced build of the factory repo
        # overwrites this app's production deployment and its build cache.
        for p_, link in plan["git_links"].items(): sys.exit(GIT_LINK_MSG.format(project=p_, link=link))
        if deploy and app.get("surface", {}).get("branding"):
            # Build from a branded copy of the mold. branding.py refuses if any rule stopped matching, so a
            # half-branded app can never ship; the snapshot itself is never edited. AFTER the plan, which
            # names build/<app_id>/ as its first step: nothing is written before the plan is printed.
            r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/branding.py"), app_id, "prepare"], capture_output=True, text=True)
            print((r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")
            if r.returncode: sys.exit("branding failed; not deploying")
            mold_dir = os.path.join(ROOT, "build", app_id)
        if deploy and app.get("packs"):
            # The application's own code (subagent packs) goes into the same build copy, after the brand. The mold
            # is a general-purpose checkpoint and is never edited or forked for an application (packs.py).
            r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/packs.py"), "apply", app_id], capture_output=True, text=True)
            print((r.stdout + r.stderr).strip())
            if r.returncode: sys.exit("packs failed; not deploying")
            r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/packs.py"), "verify", app_id], capture_output=True, text=True)
            print("\n".join((r.stdout + r.stderr).strip().splitlines()[-3:]))
            if r.returncode: sys.exit("a pack's subagents do not pass the mold's own checks; not deploying")
            mold_dir = os.path.join(ROOT, "build", app_id)
        if writer:
            # Refuse BEFORE creating, for BOTH writers: a database and a Blob store bought for an app the
            # operator has not finished configuring is exactly the "check created things" shape, one flag
            # over — and --verify-db used to skip this gate, so it could buy resources --deploy would have
            # refused to (found by the round-4 critic).
            missing_user = [x for x in infra.get("secrets_user", secrets) if x not in present]
            if missing_user:
                verb = "--deploy" if deploy else "--verify-db"
                ask_nicely_for(app_id, missing_user)
                sys.exit(f"refusing {verb}: {len(missing_user)} secret(s) above are not set, so NOTHING was created. "
                         f"Set them, then rerun: python3 .claude/scripts/provision.py {app_id} {verb}")
            if deploy:
                # A deploy on a saturated VM is an OOM waiting to happen (mold_v1-109). Wait for room first,
                # bounded; if it never comes, stop HERE, before anything is created or the status moves.
                ok, now = wait_for_headroom("the deploy")
                if not ok:
                    sys.exit(f"refusing --deploy: the VM stayed busy for {_fmt_s(HEADROOM_WAIT_S)} ({now}). Busiest: "
                             f"{_busiest()}. NOTHING was created and {app_id}'s status is unchanged; the running "
                             f"app is untouched. Rerun when that work has finished: python3 .claude/scripts/provision.py {app_id} --deploy")
                print(f"  VM headroom ok: {now}")
            ensure_projects(proj, mold_dir)         # before ANY env or resource is written to them
            present = provision_datastores(app_id, ds, mold_dir, present, infra, proj)
            save(os.path.join(adir, "infrastructure.json"), infra)
        if "--verify-db" in a:
            # the database half of --deploy, on its own: no build, no deployment, no service touched
            _, ev = bring_up_schema(app_id, mold_dir, ds, proj, [proj, f"{proj}-api", f"{proj}-workflow"])
            ev["running_app"], ev["running_app_detail"] = _health_rls(infra)   # what the CURRENT build says, read now
            record_rls(adir, ds, ev)
            print(f"{app_id}: database ready and verified on {prov}")
            return print("  the RUNNING app still uses the DATABASE_URL of its last build; Vercel env changes take "
                         "effect on the NEXT one. Re-run with --deploy to put this credential in front of traffic.")
    else:
        # THE VM LANE TERMINATES HERE. This exit used to sit at the very END of main(), two lines behind
        # `refusing to deploy with missing secrets` — so it was unreachable dead code: the names a vm app
        # is missing (BLOB_READ_WRITE_TOKEN, CRON_SECRET, OPS_SECRETS_KEY, AUTH_JWT_PRIVATE_KEY,
        # AUTH_JWT_PUBLIC_KEY and the provider's own) are minted by provision_datastores, which runs
        # ONLY on the vercel branch. --check ended by saying "run --deploy", --deploy answered "refusing
        # to deploy with missing secrets", and no command in this factory could ever produce them: a
        # closed loop with no terminating step, for the one operator who cannot read their way out of it.
        if deploy: sys.exit(VM_NOT_A_DEPLOY_TARGET.format(app_id=app_id))
        # EVERY vm run regenerates the artifact, --verify-db included. --verify-db used to return before
        # this line, so the compose file and README could be missing while state still named them, and —
        # worse — the run that creates .pg-admin and pg/server.key was the one run that never wrote the
        # .gitignore protecting them. (localpg.appdir now writes it first, and the root .gitignore
        # carries the same rules; this ordering means the artifact simply cannot lag the database.)
        d = generate_local_artifact(app_id, mold_dir, secrets, ds, infra)
        if "--verify-db" in a: return verify_db(app_id, mold_dir, ds, adir, infra)
        print(f"local artifact regenerated: {os.path.relpath(d, ROOT)}/ ({', '.join(GENERATED_FILES)})")
        return vm_report(app_id, d, infra, ds)
    user_s = infra.get("secrets_user", secrets); derived_s = infra.get("secrets_derived", [])
    missing_user = [x for x in user_s if x not in present]
    # No copy-from-live path: Vercel marks these `sensitive` (write-only), so a pull of the source
    # project returns [SENSITIVE] and copying it would write that literal string as the credential.
    missing_derived = [x for x in derived_s if x not in present and x not in DEPLOY_TIME]
    print(f"secrets present: {len([x for x in secrets if x in present])}/{len(secrets)}")
    g = infra.get("google")
    if g: print(f"Google project for 'Continue with Google': number {g['project_number']} (this app's own; each app may use a different one)")
    if missing_user:
        ask_nicely_for(app_id, missing_user)
    if missing_derived:
        # Not the plan above (that is `a deploy will create:`, every step in order); this is the shorter list of
        # derived secret NAMES the deploy mints, kept apart so the two lines cannot be read as one.
        print(("secrets a deploy will mint (not yours to set): " if not deploy else "the provisioner did not produce: ") + ", ".join(missing_derived))
    pending_deploy = [x for x in DEPLOY_TIME if x not in present]
    if pending_deploy: print(f"set during --deploy: {', '.join(pending_deploy)}")
    ev = ds.get("postgres", {}).get("rls_verified")
    if rls_mode(ds) != "off" and (not ev or str(ev.get("source", "")).startswith("not verified")):
        # `--check` regenerates the artifact and counts secrets and never once looked at the database.
        # An app can therefore sit here for weeks claiming fail_closed with nothing having measured it.
        print(f'datastores.postgres.rls says "{rls_mode(ds)}" but nothing has measured it yet.')
        print(f"  python3 .claude/scripts/provision.py {app_id} --verify-rls")
    elif ev: print(f"tenant isolation last proven {ev['at']} on {ev['backend']} ({ev.get('protected')}/{ev.get('org_scoped_tables')} org-scoped tables protected)")
    if not deploy:
        # Exit 1 only for something the OPERATOR must do; derived names are the deploy's job and were
        # listed above as what it will create.
        print("check only, read-only: nothing was created. " + (f"Set the secret(s) above, then run:" if missing_user else "Ready:")
              + f" python3 .claude/scripts/provision.py {app_id} --deploy")
        sys.exit(1 if missing_user else 0)
    if missing_user or missing_derived: sys.exit("refusing to deploy with missing secrets")
    for sig in (signal.SIGTERM, signal.SIGHUP): signal.signal(sig, _on_signal)
    app["status"] = "stamping"; save(os.path.join(adir, "application.json"), app)
    try:
        running = deploy_vercel(app_id, app, infra, ds, mold_dir, adir)
    except BaseException as e:
        # "deployed" and "isolated" are the same state or the app is not deployed. Every exit inside
        # deploy_vercel — the coverage pass, the isolation proof, a failed build — lands here, so the
        # app can never be left recorded as shipped after a gate said no.
        #
        # BaseException, not SystemExit: an unexpected fault (a KeyError in a record helper, a Ctrl-C,
        # an OOM) is not a SystemExit, so it used to fly straight past this handler and leave the app
        # parked in `stamping` — a status factory.py validate's DEPLOYED tuple does not audit, i.e. a
        # half-deployed app that no gate ever looks at again. An unknown failure is the LEAST safe
        # moment to skip the revert. The exception is re-raised untouched, so the traceback (and the
        # exit code) still reach the operator.
        for sig in (signal.SIGTERM, signal.SIGHUP): signal.signal(sig, signal.SIG_IGN)   # the record below must land
        save(os.path.join(adir, "infrastructure.json"), infra)
        note = shipped_note()
        if isinstance(e, SystemExit): _revert(adir, app, str(e) if e.code else "deploy stopped", note)
        elif isinstance(e, KeyboardInterrupt): _revert(adir, app, "the deploy was interrupted before it finished", note)
        else: _revert(adir, app, f"the deploy stopped on an unexpected {type(e).__name__}: {str(e)[:200]}. "
                                 f"Nothing about this app is proven; re-run: python3 .claude/scripts/provision.py {app_id} --deploy", note)
        raise
    # An INSTANT, not a day (infrastructure.schema.json: deployed_at), and the SAME instant as the
    # rls_verified.at this run wrote: NOW is taken once per process, so the proof, the running_app reading
    # and the deploy are one record of one run. factory.py orders rls_verified.at against this exactly —
    # a clock read here, minutes after the proof, would make every successful deploy read as stale, and a
    # bare date is a schema error there.
    infra["deployed_at"] = NOW
    save(os.path.join(adir, "infrastructure.json"), infra)
    verdict, detail = running
    if rls_mode(ds) != "off" and verdict != "enforced":
        # The stored DATABASE_URL passing the gate is not the same fact as the RUNNING app using it:
        # a Vercel env change only takes effect on the next build, and this is the only reading that
        # covers the process actually serving traffic. `unmeasured` lands here too — an app whose health
        # endpoint cannot be read has not been shown to be anything, and "not shown" is not "fine".
        if verdict == "not_enforced":
            _revert(adir, app, f"the deployed app reports row-level security is not enforced: {detail}")
            sys.exit(f"{app_id}: the app deployed, but its own health endpoint says row-level security is NOT enforced "
                     f'("{detail}") while datastores.postgres.rls claims "{rls_mode(ds)}". The build in front of traffic '
                     f"is still using an older DATABASE_URL.\n  Run: python3 .claude/scripts/provision.py {app_id} --deploy")
        _revert(adir, app, f"nothing could be read from the deployed app, so the process serving traffic is "
                           f"unproven: {detail}")
        sys.exit(f"{app_id}: the deploy finished, but its own health endpoint could not be read "
                 f'("{detail}"), so nothing shows which database role the running app uses while '
                 f'datastores.postgres.rls claims "{rls_mode(ds)}".\n'
                 f"  Open {infra.get('vercel', {}).get('production_url', 'the app URL')}{HEALTH_PATH} in a browser. If it asks "
                 f"for a login, turn off Vercel Deployment Protection for this project, then run: "
                 f"python3 .claude/scripts/provision.py {app_id} --deploy")
    # A deploy that reached three healthy endpoints supersedes the revert a failed one recorded; leaving
    # that block beside status "stamped" is the self-contradictory state a critic caught once already.
    app.pop("revert", None)
    # What is now in front of traffic: mint.py compares this with the mold's snapshot to know a redeploy is due.
    shipped = next(((m.get("source") or {}).get("commit") for m in load(os.path.join(ROOT, "state", "factory.json")).get("molds", []) if m.get("mold_id") == app.get("mold_id")), None)
    if shipped: app["mold_commit"] = shipped
    app["status"] = "stamped"; save(os.path.join(adir, "application.json"), app)
    print(f"deployed: {infra.get('vercel',infra.get('vm',{})).get('production_url')}")
if __name__ == "__main__": main(sys.argv[1:])
