#!/usr/bin/env python3
"""The load lane's measured rows: task-workflow throughput and latency under concurrency.

  python3 molds/mold_v1/testing/load/stress.py <app_id> [--iterations N] [--concurrency N]
                                               [--attempts N] [--p95-ms N] [--tps N]

WHY THIS EXISTS. `lane.json` declared a check that runs THIS FILE, and this file did not exist, so
the only row the load lane could ever produce was `skipped` — and a lane with a skipped check can
never be `pass`, which made the product gate "all five lanes pass" unreachable by construction. The
declaration promised a harness; this is the harness.

WHAT IT MEASURES. The mold already ships the scenario: `tests/task-workflow-stress/
workflow.stress.spec.ts` drives `iterations` task lifecycles at `concurrency`, replays an
idempotency key, reads each transition journal, lists, and deletes everything it made. It is not
run here in miniature or re-implemented — it is run as the mold wrote it, against a task-workflow
service this script builds and starts from the mold snapshot, on a private Postgres this script
creates and destroys. What this file adds is everything the spec cannot do for itself: stand the
service up, decide the budgets, re-measure a timing row before it reverts an application, tell an
application defect apart from a problem with this machine, and refuse to grade a row it did not
measure.

THE ROWS AND THEIR BUDGETS (all eight start `unmeasured`; only an executed measurement moves one,
and any row still `unmeasured` at the end fails the lane — see BUDGETS below for each number and
the reasoning behind it).

SAFETY, and why each choice is the inconvenient one:
  * The database is a THROWAWAY, `<app_id>__loadlane`, never the app's own `<app_id>` database.
    The scenario creates and deletes hundreds of rows; pointing that at the database a stamped app
    verifies against would be one typo away from destroying it. It is brought up through
    .claude/scripts/lib/localpg.py, so it inherits that lane's rules — private docker network, no
    host port, TLS required — and it is dropped, volume and all, in the `finally` below.
  * NO PORT IS PUBLISHED, for the service either. The stress runner joins the SERVICE CONTAINER'S
    OWN network namespace (`--network container:<svc>`), so the spec's target really is a loopback
    address. That matters for more than exposure: the spec has its own `assertSafeTarget` guard
    that refuses to mutate any non-local host unless TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION=1.
    Reaching the service by a docker hostname would have meant setting that variable in the harness
    — i.e. teaching the lane to say yes to production — to run a purely local test. The guard is
    left armed and that variable is never set here.
  * Secret values (the app_rw URL, the generated service token) go to the containers through a
    0600 `--env-file` in a 0700 scratch directory, never on a `docker run` argv where `ps` can read
    them, and are never printed. The scratch tree is removed on every exit path.
  * The mold snapshot is never written to. Everything — schema push, RLS bootstrap, `npm ci`,
    `next build`, playwright's `test-results/` — happens in a copy under a temporary directory,
    with the mold's own `node_modules` bind-mounted READ-ONLY.

WHAT MAKES A ROW REAL. `emits: markdown_table` means the runner inlines this table verbatim, so the
table is the evidence and every number in it came out of a process that ran. A scenario that did
not execute prints `unmeasured`, not `pass`: the sibling responsiveness lane shipped exactly that
bug (a route that never rendered graded pass on zero violations) and it was caught only by
adversarial review. `lane.json` therefore also asserts `stdout_not: ["\\| unmeasured \\|"]`, so even
an exit code of 0 from this file cannot get an unmeasured row past the runner.

WHAT MAKES A FAILURE HONEST. A lane failure reverts the application, so a run that produced no
numbers must say WHICH of three different things happened, in one sentence, with no stack trace and
no call log (an operator here is not technical):
  * the service answered and the scenario's own assertions failed  -> an application defect;
  * the service stopped answering during the run                   -> an application defect;
  * the scenario could not reach a service that is still healthy   -> a problem with this machine.
The first cut of this harness printed "it did not execute" for all three, followed by a Playwright
call log, and it produced the third case about one run in eight all by itself — see BASE_URL.
"""
import argparse, contextlib, json, os, re, secrets, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
MOLD = os.path.join(ROOT, "molds/mold_v1/codebase")
sys.path.insert(0, os.path.join(ROOT, ".claude/scripts/lib"))
import localpg                      # the sanctioned private-Postgres lane; never re-implemented here
NODE = "node:24-bookworm-slim"
SVC_PORT = 3000

# THE ONE ADDRESS, WRITTEN ONCE. Everything that talks to the service — the readiness probe, the
# `service.health` row, and the spec itself — uses this exact string, because the first cut of this
# harness used two.
#
# It sent the spec to `http://localhost:3000` and probed health at `http://127.0.0.1:3000`. Inside
# node:24-bookworm-slim, /etc/hosts maps `localhost` to BOTH `::1` and `127.0.0.1` and the resolver
# returns ::1 first, while `next start -H 0.0.0.0` listens on IPv4 only. Node's own fetch survives
# that by Happy Eyeballs; Playwright's request transport does not, and died on
# `connect ECONNREFUSED ::1:3000` against a service that was demonstrably healthy 700 ms earlier —
# one run in eight, and the health row graded `pass` the whole time because it was asking a
# different address. A gate that reverts an application must not be a coin flip, and a health row
# that probes somewhere the scenario never goes is not evidence.
#
# The literal 127.0.0.1 removes the name-resolution step entirely. The spec's own assertSafeTarget
# accepts "127.0.0.1" exactly as it accepts "localhost", so the guard stays armed and
# TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION is still never set.
#
# Not "start the service dual-stack with -H ::" instead: binding :: FAILS OUTRIGHT wherever IPv6 is
# disabled in the container's network namespace, which would trade an intermittent failure for a
# permanent one. One IPv4 loopback literal, used by every client, has no such failure mode.
BASE_URL = f"http://127.0.0.1:{SVC_PORT}"

# ---------------------------------------------------------------------------------------------
# BUDGETS. Every number here is defended by a measurement or by the mold's own published baseline,
# because a budget nobody can justify is either decoration or a random revert.
#
# The comparison point is docs/TASK_WORKFLOW_STRESS.md, which records a 24-task / 8-worker run
# against the DEPLOYED service on 2026-08-01: 186 operations, 1.87 lifecycles/s, p50 346 ms,
# p95 1089 ms, p99 1992 ms, zero 5xx. This lane's configuration is strictly cheaper than that one —
# no internet hop, no serverless cold start, one Postgres on the same box — so it must beat those
# numbers, and a budget looser than production would let a locally-broken build pass.
#
# Calibration on this VM (4 vCPU, postgres:17 with TLS on a private docker network, service built
# with `next build --webpack`), on this harness: 18 runs through lanes.py plus one direct run on a
# cold page cache measured p95 between 288 and 710 ms (median about 322; the 710 and a 529 are the
# two outliers) at 4.35-6.85 lifecycles/s. Every one of the 19: zero responses >= 400, exactly 186
# operations, and not one connection failure.
BUDGETS = {
    # 1.4x the worst of the 19 calibration runs above (710 ms) and about 3x their median, and
    # still under the mold's published production p95 of 1089 ms — which this configuration, with
    # no internet hop and no cold start, must beat, so the lane can never pass something slower
    # than the deployment it is a model of. That is the ceiling; the floor of the headroom is the
    # observed spread, and it is deliberately not padded further: a single run above 1000 ms is
    # re-measured (the row takes the median of up to three attempts), so jitter costs a retry
    # rather than an application, while a lost index, a per-request connection or an N+1 — which
    # move the median, not one sample — still fails the lane immediately.
    "p95_ms": 1000,
    # The published production figure is 1.87 lifecycles/s over the public internet. 2.0 is just
    # above that and under half the worst local sample (4.35), so this row fires on a structural
    # collapse, not on a slow minute.
    "tps": 2.0,
    # Not a budget with headroom and not re-measured: a 5xx is a defect, never jitter. The spec
    # asserts this itself; the row exists so the report states it as a measured number.
    "http_errors": 0,
    # The scenario deletes every task it creates. Anything left behind is a leak, and it is counted
    # in the DATABASE rather than believed from the spec's `finally` block. Tasks and workflow
    # instances only: `deleteTask` deletes from `todos` (instances cascade), and the transition
    # journal has no foreign key and is append-only ON PURPOSE — engine.ts:339 "The activity feed is
    # append-only and OUTLIVES the row it describes". Grading those rows as residue would have made
    # a correct service fail, which is why the journal gets its own row measuring the opposite
    # thing: that every transition performed is still recorded.
    "residue": 0,
}

def log(*a): print(*a, file=sys.stderr, flush=True)
def _d(*a, **k): return subprocess.run(["docker", *a], capture_output=True, text=True, **k)

def expected_ops(n):
    """Operations the spec performs for `n` iterations — a transcription of runLifecycle().

    Per task: 1 create, one transition per stage (5 stages for every third task, else 3), one
    replay of the first transition, one events read, one delete. Plus one health probe and one
    list for the whole run. Used as a LOWER BOUND: a spec that grows keeps passing, a run that
    quietly did less work than it declared does not."""
    tr = sum((5 if i % 3 == 0 else 3) + 1 for i in range(n))
    return 1 + n + tr + n + 1 + n

def expected_events(n):
    """Transition-journal rows ONE run of the scenario must leave behind — one `create` event per
    task plus one per stage entered, and none for the replayed idempotency key (the spec asserts the
    replay produces no second event). See the residue row for why they survive the delete."""
    return sum(1 + (5 if i % 3 == 0 else 3) for i in range(n))

# Lines that are debugging furniture, not information: stack frames, Playwright's call log, and the
# source-code frames it prints around a failed assertion. Hard rule: an operator gets a sentence.
NOISE = re.compile(r"^(?:at\s|Call log|- |→|\.\.\.|\d+\s*\||\||[-=]{3,})")
FIRST_ERROR = re.compile(r"^\s*(?:[A-Za-z]*Error|AssertionError):\s*(.*\S)")
UNREACHABLE = re.compile(r"ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH"
                         r"|socket hang up|ETIMEDOUT|Timeout .* exceeded", re.I)

def tail(r, n=12):
    """Build-step output, with stack frames and call logs stripped. A failed `npm ci` or
    `next build` is diagnosed from the compiler's own words, not from a JS backtrace."""
    lines = [l for l in (r.stdout + r.stderr).splitlines() if l.strip() and not NOISE.match(l.strip())]
    return "\n".join(lines[-n:])

def first_error(out):
    """The scenario's own first error sentence, one line, no frames. Empty if it printed none."""
    for l in out.splitlines():
        m = FIRST_ERROR.match(l)
        if m: return re.sub(r"\s+", " ", m.group(1))[:220]
    return ""

class Stack:
    """Everything this run creates, and the one method that takes it all away again."""
    def __init__(self, app_id):
        self.app_id = app_id
        self.pg_id = f"{app_id}__loadlane"          # NOT the app's own database. See the module docstring.
        self.svc = "svc-" + re.sub(r"[^a-z0-9]", "-", self.pg_id.lower())
        self.work = tempfile.mkdtemp(prefix="mold_v1-load-")
        os.chmod(self.work, 0o700)                  # the app_rw URL lands in here; nobody else reads it
        self.app = os.path.join(self.work, "app")
        self.envfile = os.path.join(self.work, "env")
        self.up = False

    def down(self):
        _d("rm", "-f", self.svc)
        if self.up:
            with contextlib.redirect_stdout(sys.stderr):
                try: localpg.down(self.pg_id)       # container + volume + network
                except SystemExit: pass
        shutil.rmtree(self.work, ignore_errors=True)
        # localpg.appdir() creates infra/vm/apps/<id>/ and drops a generated password and a TLS
        # private key in it. This id is a throwaway, so the directory goes with it rather than
        # being left in the tree holding credentials for a database that no longer exists.
        shutil.rmtree(os.path.join(ROOT, "infra/vm/apps", self.pg_id), ignore_errors=True)

def copy_mold(dst):
    """The mold snapshot is immutable (AGENTS.md), and this run writes .env.local, .env.supabase,
    a service node_modules, a .next build and playwright's test-results. All of that goes in a copy;
    node_modules is bind-mounted read-only from the mold instead of being copied (1.1 GB)."""
    skip = shutil.ignore_patterns("node_modules", ".next", "test-results", ".git", "tsconfig.tsbuildinfo")
    shutil.copytree(MOLD, dst, ignore=skip, symlinks=True)

def dk(stack, cmd, cwd="/app", envfile=False, timeout=900):
    """One command in node:24 on the app's private network, mold copy at /app.

    Every step is bounded. Without a per-step timeout a hung `npm ci` would eat the runner's whole
    1800 s and be reported as "timed out after 1800s" with nothing said about which step hung."""
    args = ["run", "--rm", "--network", localpg.net(stack.pg_id),
            "-v", f"{stack.app}:/app", "-v", f"{MOLD}/node_modules:/app/node_modules:ro", "-w", cwd,
            "-e", "CI=1", "-e", "NEXT_TELEMETRY_DISABLED=1"]
    if envfile: args += ["--env-file", stack.envfile]
    try: return _d(*args, NODE, "sh", "-lc", cmd, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"gave up after {timeout}s")

def build_database(stack):
    """Empty Postgres -> the mold's real schema, its RLS policies, its app_rw role and the
    task-workflow tables, using the mold's OWN scripts in the mold's own documented order.

    Not a hand-written subset: the service reads todos, workflow_definitions, entity_activity,
    org_members, people_roster, customers and cycles, and it runs as app_rw with row-level security
    forced. Measuring throughput against a superuser on a policy-free schema would be measuring a
    database the deployed app never talks to."""
    with contextlib.redirect_stdout(sys.stderr):   # localpg narrates on stdout; stdout here is the table
        localpg.up(stack.pg_id); stack.up = True
        admin = localpg.url(stack.pg_id)                       # secret value: it goes to a file, never to stdout
    with open(os.path.join(stack.app, ".env.supabase"), "w") as f:
        f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={admin}\n")
    os.chmod(os.path.join(stack.app, ".env.supabase"), 0o600)
    steps = [("schema push", 'DATABASE_URL="$ADMIN_URL" npx drizzle-kit push --force'),
             ("rls + app_rw", "node .bootstrap-supabase.mjs"),
             ("task-workflow tables", "node .migrate-task-workflow-service.mjs")]
    open(stack.envfile, "w").write(f"ADMIN_URL={admin}\n"); os.chmod(stack.envfile, 0o600)
    for label, cmd in steps:
        r = dk(stack, cmd, envfile=True, timeout=600)
        log(f"  {label}: " + ("ok" if r.returncode == 0 else "FAILED"))
        if r.returncode: return None, f"{label} failed:\n{tail(r)}"
    m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(os.path.join(stack.app, ".env.local")).read(), re.M)
    if not m: return None, "the mold's bootstrap did not write an app_rw DATABASE_URL"
    return m.group(1), None

def start_service(stack, app_url):
    """`npm ci` + `next build` + `next start` for services/task-workflow, inside the copy.

    The service has its own package.json and is NOT covered by the mold's root node_modules (the
    `workflow` runtime it imports is absent there), so its dependencies are installed per run from
    its committed package-lock.json rather than vendored into the repo."""
    svc = "/app/services/task-workflow"
    for label, cmd, t in [("npm ci", "npm ci --no-audit --no-fund", 900), ("next build", "npm run build", 900)]:
        r = dk(stack, cmd, cwd=svc, timeout=t)
        log(f"  {label}: " + ("ok" if r.returncode == 0 else "FAILED"))
        if r.returncode: return f"{label} for services/task-workflow failed:\n{tail(r)}"
    token = secrets.token_urlsafe(24)               # per run, generated, never printed, never stored
    with open(stack.envfile, "w") as f:
        f.write(f"DATABASE_URL={app_url}\nTASK_WORKFLOW_SERVICE_TOKEN={token}\n"
                f"NODE_ENV=production\nPORT={SVC_PORT}\nHOSTNAME=0.0.0.0\n")
    os.chmod(stack.envfile, 0o600)
    _d("rm", "-f", stack.svc)
    # -H 0.0.0.0, and every client reaches it at BASE_URL (127.0.0.1). See the BASE_URL comment for
    # why this is one IPv4 literal rather than a dual-stack bind plus a hostname.
    r = _d("run", "-d", "--name", stack.svc, "--network", localpg.net(stack.pg_id),
           "-v", f"{stack.app}:/app", "-w", svc, "--env-file", stack.envfile,   # no -p: nothing is published
           NODE, "sh", "-lc", f"npx next start -p {SVC_PORT} -H 0.0.0.0")
    if r.returncode: return "could not start the task-workflow service:\n" + tail(r)
    return None

# Readiness: node's own fetch, from inside the service container. Cheap enough to poll.
READY_JS = ("fetch(process.argv[1]+'/api/health').then(r=>r.text().then(t=>{console.log(r.status,t)}))"
            ".catch(e=>{console.log('0',String(e.message||e).split('\\n')[0])})")
# Confirmation: the SPEC'S OWN CLIENT. @playwright/test's request context, the same baseURL string,
# from a container in the service's network namespace — i.e. the identical transport, address and
# network position the scenario will use. Node's fetch and Playwright's transport do not agree
# about loopback (see BASE_URL), so the row that says "the service is reachable" has to be measured
# with the client whose reachability it is claiming.
PW_JS = ("const {request}=require('@playwright/test');"
         "request.newContext({baseURL:process.argv[1]}).then(c=>c.get('/api/health')"
         ".then(r=>r.text().then(t=>{console.log(r.status(),t);return c.dispose()})))"
         ".catch(e=>{console.log('0',String(e.message||e).split('\\n')[0])})")

def _parse_health(out):
    if not out.startswith("200"): return None, (out or "no answer")[:180]
    try: b = json.loads(out.split(" ", 1)[1])
    except Exception: return None, f"200 but not JSON: {out[:180]}"
    if b.get("ok") is True and b.get("service") == "task-workflow": return b, ""
    return None, f"200 but not this mold's service: {out[:180]}"

def health(stack, tries=60):
    """(ok, detail) for the `service.health` row, and the same call re-used to tell an application
    that fell over apart from a machine that could not connect to a healthy one."""
    detail = "no answer"
    for _ in range(tries):
        r = _d("exec", stack.svc, "node", "-e", READY_JS, BASE_URL)
        b, why = _parse_health((r.stdout or "").strip())
        if b: break
        detail = why
        time.sleep(2)
    else:
        return False, f"{detail} — {BASE_URL}/api/health never answered 200"
    # Reachable by node's fetch is not the claim this row makes. Confirm with the spec's client.
    r = _d("run", "--rm", "--network", f"container:{stack.svc}",
           "-v", f"{MOLD}/node_modules:/app/node_modules:ro", "-w", "/app",
           NODE, "node", "-e", PW_JS, BASE_URL)
    b, why = _parse_health((r.stdout or "").strip())
    if not b:
        return False, (f"{BASE_URL}/api/health answers node's fetch but not the scenario's own HTTP "
                       f"client, which is what the stress run uses: {why}")
    return True, (f'200 ok=true service=task-workflow db.role={b.get("db", {}).get("role")} '
                  f'db.ms={b.get("db", {}).get("ms")} (probed at {BASE_URL} with the spec\'s own client)')

SUMMARY = re.compile(r"task-workflow stress summary: (\{.*\})")

def stress_once(stack, org, iters, conc):
    """Run the mold's spec once. Returns (summary_or_None, playwright_exit, first_error_sentence).

    The runner container joins the SERVICE's network namespace, so the spec's own non-local-target
    guard sees a genuine loopback address and TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION is never set."""
    with open(stack.envfile + ".run", "w") as f:
        f.write(f"TASK_WORKFLOW_STRESS_BASE_URL={BASE_URL}\n"
                f"TASK_WORKFLOW_SERVICE_TOKEN={open_token(stack)}\n"
                f"TASK_WORKFLOW_STRESS_ORG_ID={org}\nTASK_WORKFLOW_STRESS_ITERATIONS={iters}\n"
                f"TASK_WORKFLOW_STRESS_CONCURRENCY={conc}\n")
    os.chmod(stack.envfile + ".run", 0o600)
    r = _d("run", "--rm", "--network", f"container:{stack.svc}",
           "-v", f"{stack.app}:/app", "-v", f"{MOLD}/node_modules:/app/node_modules:ro", "-w", "/app",
           "-e", "CI=1", "--env-file", stack.envfile + ".run",
           NODE, "sh", "-lc", "npx playwright test --config=playwright.task-workflow.config.ts")
    out = r.stdout + r.stderr
    m = SUMMARY.search(out)
    try: s = json.loads(m.group(1)) if m else None
    except Exception: s = None
    return s, r.returncode, first_error(out)

def open_token(stack):
    for l in open(stack.envfile):
        if l.startswith("TASK_WORKFLOW_SERVICE_TOKEN="): return l.split("=", 1)[1].strip()
    return ""

def counts(stack, org):
    """What is in the DATABASE for this org right now — the spec's own cleanup runs in a `finally`
    that swallows its errors, so believing it would be believing the thing under test."""
    js = ("const p=require('postgres');const s=p(process.env.DATABASE_URL,{ssl:'require',prepare:false,max:1});"
          "const o=process.argv[1];"
          "s.begin(async q=>{await q`select set_config('app.org_id',${o},true)`;"
          "const a=await q`select count(*)::int n from todos where org_id=${o}`;"
          "const b=await q`select count(*)::int n from task_workflow_instances where org_id=${o}`;"
          "const c=await q`select count(*)::int n from task_workflow_transition_events where org_id=${o}`;"
          "console.log(JSON.stringify({todos:a[0].n,instances:b[0].n,events:c[0].n}));})"
          ".then(()=>s.end()).catch(e=>{console.log('ERR '+e.message);process.exit(1)})")
    r = _d("exec", "-w", "/app/services/task-workflow", stack.svc, "node", "-e", js, org)
    try: return json.loads((r.stdout or "").strip().splitlines()[-1]), None
    except Exception: return None, ((r.stdout or "") + (r.stderr or "")).strip()[-200:] or "no answer"

def table(rows):
    print("| row | result | budget | measured |")
    print("|---|---|---|---|")
    for n, s, b, d in rows: print(f"| {n} | {s} | {b} | {str(d).replace('|', '/')[:300]} |")

def representative(attempts):
    """The run of record among repeated timing attempts: the MEDIAN p95, and on an even count the
    worse of the two middles.

    Not the best. The first cut kept the lowest p95 of up to three runs, which is shopping for a
    greener number: one lucky run in three could carry a service that misses its budget typically.
    The median needs a majority of the attempts to be inside the budget, so a retry can still absorb
    a single jitter outlier — which is the only thing retries are for — without letting one good
    sample outvote two bad ones."""
    ordered = sorted(attempts, key=lambda s: s.get("latencyMs", {}).get("p95", 10 ** 9))
    return ordered[len(ordered) // 2]

def main(argv):
    p = argparse.ArgumentParser(add_help=True, description="mold_v1 load lane — task-workflow stress")
    p.add_argument("app_id")
    p.add_argument("--iterations", type=int, default=24)
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--attempts", type=int, default=3)
    p.add_argument("--p95-ms", type=int, default=BUDGETS["p95_ms"])
    p.add_argument("--tps", type=float, default=BUDGETS["tps"])
    a = p.parse_args(argv)
    # Only that they are positive. The SPEC owns the caps (1-200 iterations, 1-50 concurrency) and
    # enforces them itself; duplicating them here would let the two drift and would hide the case
    # this lane must handle honestly — a scenario that refuses to start measures nothing, and an
    # unmeasured row is a failure, not a pass.
    if a.iterations < 1 or a.concurrency < 1 or a.attempts < 1:
        sys.exit("--iterations, --concurrency and --attempts must all be 1 or more.")
    if not os.path.isdir(os.path.join(ROOT, "state/application", a.app_id)):
        sys.exit(f"no application {a.app_id} in state/application. Nothing ran.")

    # Every row starts unmeasured. Nothing but an executed measurement moves one, and any row still
    # unmeasured when the table is printed fails the lane. This is the whole anti-vacuous-pass design.
    rows = {k: ["unmeasured", b, "not measured: the step that produces this row did not run"]
            for k, b in [("service.health", "200, ok=true, service=task-workflow"),
                         ("stress.executed", f">= {expected_ops(a.iterations)} operations"),
                         ("stress.status", f"{BUDGETS['http_errors']} responses >= 400"),
                         ("stress.p95", f"p95 <= {a.p95_ms} ms"),
                         ("stress.throughput", f">= {a.tps} lifecycles/s"),
                         ("stress.invariants", "the spec's own assertions pass"),
                         ("stress.residue", f"{BUDGETS['residue']} tasks and {BUDGETS['residue']} workflow instances left"),
                         ("stress.journal", f"{expected_events(a.iterations)} transition events for the run of record")]}
    org = "org-loadlane-" + re.sub(r"[^a-z0-9]+", "-", a.app_id.lower())
    stack = Stack(a.app_id)
    samples, done, seen, fatal, rerun = [], [], [], None, None
    try:
        log(f"[load] scratch {stack.work}"); copy_mold(stack.app)
        try: app_url, err = build_database(stack)
        except SystemExit as x: app_url, err = None, f"the private Postgres could not be prepared: {x}"
        if err: fatal = err
        if not fatal:
            err = start_service(stack, app_url)
            if err: fatal = err
        if not fatal:
            ok, detail = health(stack)
            rows["service.health"] = ["pass" if ok else "fail", rows["service.health"][1], detail]
            if not ok: fatal = "the task-workflow service never became healthy: " + detail
        if not fatal:
            base, cerr = counts(stack, org)          # a fresh database; the journal row is a delta from here
            seen = [base] if base else []
            for i in range(a.attempts):
                s, code, err = stress_once(stack, org, a.iterations, a.concurrency)
                if not s:
                    # No summary means the scenario threw before it could print one. Three causes,
                    # three different verdicts, and the operator is told which — the first cut said
                    # "it did not execute" for all of them and attached a Playwright call log.
                    ok, why = health(stack, tries=3)
                    if not ok:
                        fatal = ("the task-workflow service stopped answering DURING the run — it did not "
                                 f"survive the load. That is an application defect: {why}")
                    elif UNREACHABLE.search(err):
                        # The service is healthy over the spec's own client, and the spec still could
                        # not connect: nothing about the application was measured. Retrying an attempt
                        # that measured nothing is not shopping for a verdict, so it is retried — but
                        # it can never become a `pass`, only an unmeasured row, which fails the lane.
                        if i + 1 < a.attempts:
                            log(f"  attempt {i + 1}: could not reach {BASE_URL} ({err}); the service is "
                                f"healthy, so this is the machine, not the app. Retrying.")
                            # Re-baseline: whatever this attempt managed to write before it lost the
                            # connection belongs to it, not to the attempt that becomes the run of
                            # record. (The residue row is absolute, so a genuine leak still fails.)
                            c, cerr = counts(stack, org)
                            if c and seen: seen[-1] = c
                            continue
                        fatal = (f"the stress run could not reach the task-workflow service at {BASE_URL} on "
                                 f"{a.attempts} attempt(s), and the service answered its health check every "
                                 f"time. Nothing about the application was measured, so no row can pass; this "
                                 f"is a problem with this machine, not with the application ({err}).")
                        rerun = True
                    else:
                        # It reached the service and the scenario's own assertions or an HTTP status
                        # stopped it. That is a measurement, and it is a failure of the application.
                        rows["stress.invariants"] = ["fail", rows["stress.invariants"][1],
                                                     err or f"playwright exit {code} with no error line"]
                        fatal = ("the stress scenario reached the service and failed one of the mold's own "
                                 f"workflow assertions. That is an application defect: {err}")
                    break
                lat = s.get("latencyMs", {})
                samples.append(f"attempt {i + 1}: ops={s.get('operations')} p50={lat.get('p50')}ms "
                               f"p95={lat.get('p95')}ms p99={lat.get('p99')}ms max={lat.get('max')}ms "
                               f"tps={s.get('taskLifecyclesPerSecond')} statuses={s.get('statusCounts')} "
                               f"playwright exit {code}")
                done.append(s)
                c, cerr = counts(stack, org)         # after every attempt, so the journal row is per-run
                if c: seen.append(c)
                # A failed assertion or a 5xx is a defect, never jitter: take THAT attempt as the
                # result and stop. Retrying it would be shopping for a greener run.
                if code != 0:
                    rows["stress.invariants"] = ["fail", rows["stress.invariants"][1],
                                                 err or f"playwright exit {code}"]
                    break
                # Re-measure ONLY a timing row that missed its budget, and only up to --attempts.
                if lat.get("p95", 10 ** 9) <= a.p95_ms and s.get("taskLifecyclesPerSecond", 0) >= a.tps: break
            if done:
                s = representative(done); lat = s.get("latencyMs", {})
                nth = done.index(s) + 1
                ops, exp = s.get("operations", 0), expected_ops(a.iterations)
                bad = sum(n for k, n in (s.get("statusCounts") or {}).items() if int(k) >= 400)
                rows["stress.executed"] = ["pass" if ops >= exp else "fail", rows["stress.executed"][1],
                                           f"{ops} operations at concurrency {a.concurrency} over {a.iterations} lifecycles"]
                rows["stress.status"] = ["pass" if bad == 0 else "fail", rows["stress.status"][1],
                                         f"{bad} of {ops}; statuses {s.get('statusCounts')}"]
                rows["stress.p95"] = ["pass" if lat.get("p95", 10 ** 9) <= a.p95_ms else "fail", rows["stress.p95"][1],
                                      f"median of {len(done)} (attempt {nth}): p95 {lat.get('p95')} ms "
                                      f"(p50 {lat.get('p50')}, p99 {lat.get('p99')}, max {lat.get('max')})"]
                rows["stress.throughput"] = ["pass" if s.get("taskLifecyclesPerSecond", 0) >= a.tps else "fail",
                                             rows["stress.throughput"][1],
                                             f"median of {len(done)} (attempt {nth}): "
                                             f"{s.get('taskLifecyclesPerSecond')} lifecycles/s in {s.get('elapsedMs')} ms"]
                if rows["stress.invariants"][0] == "unmeasured":
                    rows["stress.invariants"] = ["pass", rows["stress.invariants"][1],
                                                 "playwright exit 0: ordering, idempotency replay and terminal state held"]
                if len(seen) == len(done) + 1:
                    left, before = seen[-1], seen[nth - 1]
                    n = left["todos"] + left["instances"]
                    got, want = seen[nth]["events"] - before["events"], expected_events(a.iterations)
                    rows["stress.residue"] = ["pass" if n == 0 else "fail", rows["stress.residue"][1],
                                              f"todos={left['todos']} instances={left['instances']} after {len(done)} attempt(s)"]
                    rows["stress.journal"] = ["pass" if got == want else "fail", rows["stress.journal"][1],
                                              f"{got} written and retained by attempt {nth} "
                                              f"(append-only by design: engine.ts deletes the task, not its journal)"]
                else:
                    for k in ("stress.residue", "stress.journal"):
                        rows[k] = ["unmeasured", rows[k][1], f"could not count rows in the database: {cerr}"]
    finally:
        log("[load] tearing down"); stack.down()

    table([(k, v[0], v[1], v[2]) for k, v in rows.items()])
    if samples: print("\nSamples (every attempt, in order):\n\n" + "\n".join(f"- {s}" for s in samples))
    if fatal:
        print("\n" + fatal.splitlines()[0])   # one sentence for the report; the detail goes to stderr
        log("\n" + fatal)
    print()          # the runner inlines stdout+stderr together; keep the harness log off the last row
    bad = [k for k, v in rows.items() if v[0] != "pass"]
    if bad:
        log(f"\nload lane FAILED on: {', '.join(bad)}")
        log("Read the table above: an `unmeasured` row means that step never ran, which is a failure, "
            "not a pass." + ("\nNothing was measured and the service was healthy throughout, so this run "
                             "says nothing about the application. Run this one command again on this machine:"
                             if rerun else "\nRun this one command again on this machine to reproduce it:")
            + f"\n  python3 molds/mold_v1/testing/load/stress.py {a.app_id}")
    return 1 if bad else 0

if __name__ == "__main__":
    try: sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt: sys.exit(130)
