#!/usr/bin/env python3
"""buildfit: size a heavy build to the machine it runs on, now (mold_v1-232).

A build (npm ci, the eve build, next build, the task-workflow service's build) used to start the same way on every
machine and every time: four static workers and as much heap as V8 liked. On a busy or a small machine the kernel then
killed it for lack of memory (the factory's own 4 vCPU / 7.8 GB machine, 2026-10-11: `next build` in the isolation CI
job, `next dev` at 3.2-3.7 GB; a live server builds a release while it serves). So before each heavy step this file
measures what the step can have at that moment and sizes the step to it, slower if it must:

  measure   MemAvailable, MemTotal, swap, the CPUs this process may run on (nproc), the 1-minute load, and every
            cgroup limit above this process (memory.max minus memory.current, cpu.max), so a build inside a container,
            a systemd unit with MemoryMax or a CI runner sees its own limit, not the host's
  plan      the budget is what is available minus HEADROOM for a release that serves beside the build (or less, when
            nothing serves); against the step's own measured need (STEPS) it picks:
              roomy   the step's usual settings, workers and native threads limited to the idle CPUs and the budget
              tight   one worker, two native threads at most, a heap sized to the budget: slower, and it fits
              short   not even the step's floor fits: wait, then a temporary swap file, then fail clearly
            and the environment that carries the sizing (ENV_NAMES): NODE_OPTIONS --max-old-space-size, BUILD_CPUS and
            BUILD_MEMORY_MIB (the mold's next.config reads both: Next's worker count and Turbopack's memory target),
            RAYON_NUM_THREADS and TOKIO_WORKER_THREADS (the native pools of rolldown, which eve builds with, and of
            Turbopack), UV_THREADPOOL_SIZE, and npm's socket count
  run       one step after another (never two at once: the caller runs them in order), at a low CPU and IO priority
            (a transient systemd scope with CPUWeight, IOWeight and MemoryHigh when this process may make one and is
            not already inside a limit it would escape; else nice and ionice) so the serving app stays responsive,
            and with the kernel told to pick the build first if memory runs out anyway (oom_score_adj 500).
            Memory short: wait for it (bounded, saying what is using it), then, only on a machine with NO swap at all
            and room on its disk, a temporary swap file for this step alone (said in the log, removed after). Killed
            by the kernel anyway: once more, tight. Killed again, or short even after all that: exit CAPACITY_RC with
            one BUILD_SHORT line naming the measured numbers, which the factory turns into the request for a bigger
            server (lib/vm_capacity.py, `provision.py <app> --capacity`). The step itself never switches anything, so
            the release that serves keeps serving.

  buildfit.py plan [--step S] [--serving]          what the step would get here, now (JSON); changes nothing
  buildfit.py run --step S [--serving] [--label L] [--no-swap] [--wait S] -- <command ...>
                                                   the step, sized, waited for, retried once tight; exit as the command,
                                                   or CAPACITY_RC when the machine is too small or too busy for it
  buildfit.py --self-test                          offline: the sizing for 2/4/8 GB, 1-4 CPUs, busy and idle; the wait,
                                                   the swap file, the retry and the clear failure, with stand-ins (the
                                                   checks are vm_release_selftest.py's `buildfit` section, which
                                                   vm_remote.py --self-test runs too)

Standard library only. The server's tool (vm_remote.py build-run) imports this file from the deploy's bundle.
"""
import json, math, os, re, shlex, shutil, subprocess, sys, time

CAPACITY_RC = 75                    # EX_TEMPFAIL: the machine, not the app. build.sh passes it on; the factory reads it
# Each step's need, measured on the factory machine (4 vCPU, 7.8 GB, no swap) on 2026-10-11, building the
# onfinance_hfc_vm build copy at mold 1260acd, each step alone in a cgroup limited to 3 GB and 2 CPUs (the highest
# anonymous memory, sampled every 0.5 s; the page cache is left out, the kernel reclaims it):
#                     as it was (no sizing)     sized, tight                     where the memory goes
#   npm ci (app)      1.5 GB    51 s            -                                npm and the install scripts
#   eve build         2.5 GB    67-93 s         2.0 GB, 92 s, heap 1280 MB       eve's JS (heap-bound) + rolldown (native)
#   next build (web)  2.4 GB   219-292 s        2.3 GB, 238 s, heap 1280 MB,     Turbopack compiles in the main process
#                                               1 worker                         (2.2 GB native: no setting bounds it),
#                                                                                then the type check (1.4 GB) beside it
#   next build (wf)   1.1-1.3 GB  63-70 s       1.3 GB, 65 s                     webpack
# So a cap on the heap lowers eve by half a gigabyte; the web build's floor is Turbopack's own; workers and threads
# matter on few CPUs more than for memory. Below a step's floor only waiting or swap lets it finish.
# need_mb   the budget at which the step runs with its usual settings (its measured peak, rounded up)
# floor_mb  the smallest budget it finished in, tight (one worker, one or two native threads, the heap below)
# heap_mb   the smallest V8 old-space ceiling the step finished with (eve at 1024 MB: "JavaScript heap out of memory")
# worker_mb what one more Next static-generation worker adds (0: the step has none)
STEPS = {
    "npm-ci":   {"what": "the dependency install (npm ci)",                "need_mb": 1600, "floor_mb": 1000, "heap_mb": 768,  "worker_mb": 0},
    "eve":      {"what": "the agent API's build (eve build)",              "need_mb": 2600, "floor_mb": 2100, "heap_mb": 1280, "worker_mb": 0},
    "web":      {"what": "the web app's build (next build)",               "need_mb": 2500, "floor_mb": 2300, "heap_mb": 1280, "worker_mb": 150},
    "workflow": {"what": "the task-workflow service's build (next build)", "need_mb": 1400, "floor_mb": 1350, "heap_mb": 1024, "worker_mb": 150},
    "generic":  {"what": "the build",                                      "need_mb": 2600, "floor_mb": 2300, "heap_mb": 1280, "worker_mb": 150},
}
HEAP_MAX_MB = 4096                  # V8's default on a 64-bit machine is about this; more only slows the GC down
# Kept free beyond the build: for a release that serves beside it (its chats and sandboxes may grow while the build
# runs), else for the machine itself. The larger of a floor and a share of the machine's memory.
HEADROOM_SERVING = (512, 0.06)
HEADROOM_IDLE = (256, 0.03)
WAIT_S = 600                        # how long a short step waits for memory before the swap file or the failure
POLL_S = 15
SWAP_PATH = "/var/tmp/sf-build.swap"
SWAP_MIN_MB, SWAP_MAX_MB = 1024, 4096
SWAP_DISK_SPARE_MB = 4096           # a swap file is made only with this much disk left over beside it
# The names the sizing travels in. env-run (vm_remote.py) passes these through from its own environment.
ENV_NAMES = ("NODE_OPTIONS", "BUILD_CPUS", "BUILD_MEMORY_MIB", "RAYON_NUM_THREADS", "TOKIO_WORKER_THREADS",
             "UV_THREADPOOL_SIZE", "npm_config_maxsockets")

# ---------------------------------------------------------------------------------------------------------
# measure
# ---------------------------------------------------------------------------------------------------------
def _read(path):
    try:
        with open(path) as f: return f.read()
    except OSError: return None

def _meminfo(text):
    out = {}
    for l in (text or "").splitlines():
        k, _, v = l.partition(":")
        if v.strip().split()[:1] and v.strip().split()[0].isdigit(): out[k.strip()] = int(v.split()[0]) // 1024
    return out

def cgroup_limits(read=_read, proc_cgroup="/proc/self/cgroup", root="/sys/fs/cgroup"):
    """(room_mb, limit_mb, cpus) of the tightest cgroup (v2) above this process, each None when nothing limits it.
    room is memory.max (or memory.high) less what that level holds that cannot be reclaimed (memory.current less its
    page cache, memory.stat `file`: an earlier step's files in the same cgroup are not memory the next one lacks),
    at the level where that is smallest."""
    rel = None
    for l in (read(proc_cgroup) or "").splitlines():
        if l.startswith("0::"): rel = l[3:].strip()
    if rel is None: return None, None, None
    room = limit = cpus = None
    parts = [p for p in rel.split("/") if p]
    for i in range(len(parts), -1, -1):
        d = os.path.join(root, *parts[:i]) if i else root
        cur = (read(os.path.join(d, "memory.current")) or "").strip()
        cache = re.search(r"^file (\d+)", read(os.path.join(d, "memory.stat")) or "", re.M)
        held = max(0, int(cur) - (int(cache.group(1)) if cache else 0)) if cur.isdigit() else None
        for name in ("memory.max", "memory.high"):
            m = (read(os.path.join(d, name)) or "").strip()
            if m.isdigit() and held is not None:
                r = max(0, int(m) - held) // 1048576
                if room is None or r < room: room = r
                if limit is None or int(m) // 1048576 < limit: limit = int(m) // 1048576
        q = (read(os.path.join(d, "cpu.max")) or "").split()
        if len(q) == 2 and q[0].isdigit() and q[1].isdigit() and int(q[1]):
            c = max(1, math.ceil(int(q[0]) / int(q[1])))
            if cpus is None or c < cpus: cpus = c
    return room, limit, cpus

def oom_kills(read=_read):
    m = re.search(r"^oom_kill (\d+)", read("/proc/vmstat") or "", re.M)
    return int(m.group(1)) if m else None

def measure(read=_read, load=None, affinity=None, host_cpus=None, statvfs=os.statvfs):
    """What the machine has for a build right now. Every reading that this OS does not give is None."""
    mi = _meminfo(read("/proc/meminfo"))
    room, limit, cg_cpus = cgroup_limits(read)
    try: aff = len(affinity() if affinity else os.sched_getaffinity(0))
    except (AttributeError, OSError): aff = os.cpu_count() or 1
    try: load1 = load() if load else os.getloadavg()[0]
    except OSError: load1 = 0.0
    try: v = statvfs(os.path.dirname(SWAP_PATH)); disk = v.f_bavail * v.f_frsize // 1048576
    except OSError: disk = None
    return {"mem_total_mb": mi.get("MemTotal"), "mem_avail_mb": mi.get("MemAvailable"), "swap_total_mb": mi.get("SwapTotal"),
            "swap_free_mb": mi.get("SwapFree"), "cg_room_mb": room, "cg_limit_mb": limit, "cpus": min(aff, cg_cpus or aff),
            "host_cpus": host_cpus or os.cpu_count() or aff, "load1": round(load1, 2), "disk_free_mb": disk}

# ---------------------------------------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------------------------------------
def headroom_mb(facts, serving):
    floor, share = HEADROOM_SERVING if serving else HEADROOM_IDLE
    total = facts.get("cg_limit_mb") or facts.get("mem_total_mb") or 0
    return max(floor, int(total * share))

def budget_mb(facts, serving, swap=False):
    """Memory the step may use: what is available, capped by the tightest cgroup's room, minus the headroom; with
    swap=True, half the free swap on top (slow, but not a kill). None when this OS gave no memory reading."""
    avail = facts.get("mem_avail_mb")
    if avail is None: return None
    if facts.get("cg_room_mb") is not None: avail = min(avail, facts["cg_room_mb"])
    return avail - headroom_mb(facts, serving) + ((facts.get("swap_free_mb") or 0) // 2 if swap else 0)

def idle_cpus(facts):
    """CPUs nobody else is using: this process's CPUs, less the host's load beyond what the other CPUs can hold."""
    cpus = max(1, facts.get("cpus") or 1); host = max(cpus, facts.get("host_cpus") or cpus)
    busy_here = max(0.0, (facts.get("load1") or 0.0) - (host - cpus))
    return max(1, min(cpus, int(cpus - busy_here + 0.5)))

def plan(step, facts, serving=False, tight=False, heap_mb=None):
    """{mode, budget_mb, heap_mb, workers, threads, nice, ionice, cpu_weight, memory_high_mb, env, why}. Pure."""
    p = STEPS.get(step) or STEPS["generic"]
    budget, with_swap = budget_mb(facts, serving), budget_mb(facts, serving, swap=True)
    cpus = max(1, facts.get("cpus") or 1); idle = idle_cpus(facts)
    busy = idle < cpus or (facts.get("load1") or 0) >= 0.75 * max(1, facts.get("host_cpus") or cpus)
    if budget is None:                                       # no memory reading (macOS): the step's need, one worker
        mode, budget = "tight", p["need_mb"]
    elif budget >= p["need_mb"] and not tight: mode = "roomy"
    elif budget >= p["floor_mb"]: mode = "tight"
    elif with_swap >= p["floor_mb"]: mode, budget = "tight", with_swap      # only with the swap: tight, and slow
    else: mode = "short"
    if mode == "roomy":
        spare = budget - p["need_mb"]
        by_mem = 1 + (spare // p["worker_mb"] if p["worker_mb"] else cpus)
        workers = max(1, min(idle, by_mem, max(1, cpus - 1) if cpus > 2 else cpus))
        threads = max(min(2, cpus), idle)     # a busy CPU only slows a native pool; a starved one stalls it
        heap = max(p["heap_mb"], min(HEAP_MAX_MB, budget // 2))
    else:
        workers, threads = 1, max(1, min(2, idle))
        heap = max(p["heap_mb"], min(HEAP_MAX_MB, (budget * 3) // 5))
    if heap_mb: heap = max(heap, min(HEAP_MAX_MB, heap_mb))
    low = serving or busy or mode != "roomy"
    env = {"NODE_OPTIONS": f"--max-old-space-size={heap}", "BUILD_CPUS": str(workers), "BUILD_MEMORY_MIB": str(max(256, budget)),
           "RAYON_NUM_THREADS": str(threads), "TOKIO_WORKER_THREADS": str(threads), "UV_THREADPOOL_SIZE": str(max(2, min(4, threads))),
           "npm_config_maxsockets": "4" if mode != "roomy" else "8"}
    why = (f"{facts.get('mem_avail_mb')} MB available" + (f" ({facts['cg_room_mb']} MB left under this cgroup's limit)" if facts.get("cg_room_mb") is not None else "")
           + f", {headroom_mb(facts, serving)} MB kept for {'the release serving beside it' if serving else 'the machine'}, "
           f"{cpus} CPU{'s' if cpus != 1 else ''} ({idle} idle, load {facts.get('load1')}); {p['what']} needs {p['need_mb']} MB as usual, {p['floor_mb']} MB at the least")
    return {"step": step, "mode": mode, "budget_mb": budget, "heap_mb": heap, "workers": workers, "threads": threads,
            "nice": 19 if low else 10, "ionice": "idle" if low else "best-effort", "cpu_weight": 20 if low else 50,
            "io_weight": 20 if low else 50, "env": env, "why": why,
            # The scope's soft limit: above it the kernel takes back the build's page cache before anyone else's. Never
            # under the step's need, or a step that needs it would be throttled to a crawl instead of finishing.
            "memory_high_mb": max(budget, p["need_mb"] + p["need_mb"] // 10)}

def plan_line(pl):
    return (f"buildfit: {pl['step']} {pl['mode']}: budget {pl['budget_mb']} MB, heap {pl['heap_mb']} MB, {pl['workers']} worker(s), "
            f"{pl['threads']} native thread(s), nice {pl['nice']}, io {pl['ionice']} ({pl['why']})")

def short_line(step, facts, serving, pl=None, killed=False):
    """The one machine-readable line a capacity failure prints (the factory parses it: vm_remote.build_short)."""
    p = STEPS.get(step) or STEPS["generic"]
    kv = {"step": step, "need_mb": p["need_mb"], "floor_mb": p["floor_mb"], "budget_mb": budget_mb(facts, serving),
          "avail_mb": facts.get("mem_avail_mb"), "total_mb": facts.get("mem_total_mb"), "cg_limit_mb": facts.get("cg_limit_mb"),
          "swap_mb": facts.get("swap_total_mb"), "cpus": facts.get("cpus"), "load1": facts.get("load1"), "killed": int(bool(killed))}
    return "BUILD_SHORT " + " ".join(f"{k}={'none' if v is None else v}" for k, v in kv.items())

def parse_short(text):
    """The BUILD_SHORT line's numbers, or None."""
    m = re.search(r"^BUILD_SHORT (.*)$", text or "", re.M)
    if not m: return None
    out = {}
    for kv in m.group(1).split():
        k, _, v = kv.partition("=")
        out[k] = None if v == "none" else (float(v) if re.fullmatch(r"-?\d+\.\d+", v) else int(v) if re.fullmatch(r"-?\d+", v) else v)
    return out

def short_words(s):
    """BUILD_SHORT numbers in one plain sentence."""
    p = STEPS.get(s.get("step")) or STEPS["generic"]
    lim = f", inside a limit of {s['cg_limit_mb']} MB" if s.get("cg_limit_mb") else ""
    how = "was killed for lack of memory twice, the second time at its smallest settings" if s.get("killed") else "could not start: not even its smallest settings fit"
    return (f"{p['what'][0].upper() + p['what'][1:]} {how}. Measured: {s.get('avail_mb')} MB of memory available of {s.get('total_mb')} MB{lim}, "
            f"{s.get('swap_mb') or 0} MB swap, {s.get('cpus')} CPUs at load {s.get('load1')}; it needs {s.get('need_mb')} MB as usual and {s.get('floor_mb')} MB at the least "
            f"(it had {s.get('budget_mb')} MB after the headroom kept for what serves).")

# ---------------------------------------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------------------------------------
def confined(facts):
    """Already inside a memory or CPU limit (a container, a CI runner, a unit with MemoryMax): a new systemd scope would
    be made outside it and escape it, so priority is set with nice and ionice instead."""
    return facts.get("cg_limit_mb") is not None or (facts.get("cpus") or 0) < (facts.get("host_cpus") or 0)

def wrap(argv, pl, facts, which=shutil.which, euid=None):
    """argv run at the plan's priority: a transient systemd scope (root, systemd, not confined), else nice + ionice."""
    euid = os.geteuid() if euid is None and hasattr(os, "geteuid") else (euid or 0)
    io = (["ionice", "-c", "3"] if pl["ionice"] == "idle" else ["ionice", "-c", "2", "-n", "7"]) if which("ionice") else []
    if euid == 0 and which("systemd-run") and os.path.isdir("/run/systemd/system") and not confined(facts):
        return ["systemd-run", "--quiet", "--scope", "--collect", "-p", f"CPUWeight={pl['cpu_weight']}", "-p", f"IOWeight={pl['io_weight']}",
                "-p", f"MemoryHigh={pl['memory_high_mb']}M", f"--nice={pl['nice']}", "--", *io, *argv]
    return (["nice", "-n", str(pl["nice"])] if which("nice") else []) + io + list(argv)

def sized_env(base, pl):
    """base + the plan's sizing. NODE_OPTIONS keeps what base had, with this heap ceiling instead of any other."""
    e = dict(base)
    for k, v in pl["env"].items():
        if k == "NODE_OPTIONS":
            rest = re.sub(r"--max[-_]old[-_]space[-_]size=\S+", "", e.get(k, "")).split()
            e[k] = " ".join(rest + [v])
        else: e[k] = v
    return e

HEAP_OOM = re.compile(r"JavaScript heap out of memory|Reached heap limit|Allocation failed - JavaScript heap")
def killed(rc, tail, kills_before, kills_after):
    """'kernel' (the OOM killer), 'heap' (V8's own ceiling), or None."""
    if HEAP_OOM.search(tail or ""): return "heap"
    if rc in (137, -9) or (rc and kills_before is not None and kills_after is not None and kills_after > kills_before): return "kernel"
    if rc and re.search(r"\bKilled\b|SIGKILL|exit(?:ed with| code)? 137", tail or ""): return "kernel"
    return None

# The build's processes are the kernel's first choice when memory runs out (the default is 0; the serving app keeps
# it): a killed build is retried, a killed web app or agent is an outage.
OOM_SCORE_ADJ = 500
def _first_to_go():
    try:
        with open("/proc/self/oom_score_adj", "w") as f: f.write(str(OOM_SCORE_ADJ))
    except OSError: pass

def stream(argv, env, cwd=None, out=sys.stdout):
    """Run argv; its output goes on to `out` as it comes, and the last 200 lines are kept to read for a kill."""
    p = subprocess.Popen(argv, env=env, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                         preexec_fn=_first_to_go if os.path.exists("/proc/self/oom_score_adj") else None)
    tail = []
    for line in p.stdout:
        out.write(line); out.flush(); tail.append(line)
        if len(tail) > 200: del tail[:100]
    return p.wait(), "".join(tail)

def swap_on(mb, run=subprocess.run, path=SWAP_PATH, say=print):
    """A temporary swap file of `mb` MB. True when it is on."""
    cmds = [["fallocate", "-l", f"{mb}M", path], ["chmod", "600", path], ["mkswap", path], ["swapon", path]]
    for c in cmds:
        r = run(c, capture_output=True, text=True)
        if r.returncode:
            say(f"buildfit: the temporary swap file could not be made ({' '.join(c[:1])}: {(r.stderr or '').strip()[:120]}); going on without it")
            run(["swapoff", path], capture_output=True, text=True); run(["rm", "-f", path], capture_output=True, text=True)
            return False
    say(f"buildfit: this machine has NO swap and too little memory for the step, so a temporary {mb} MB swap file ({path}) is on "
        "for this step only; it is turned off and deleted when the step ends")
    return True

def swap_off(run=subprocess.run, path=SWAP_PATH, say=print):
    r = run(["swapoff", path], capture_output=True, text=True)
    run(["rm", "-f", path], capture_output=True, text=True)
    if r.returncode: say(f"buildfit: the temporary swap file {path} could not be turned off ({(r.stderr or '').strip()[:120]}); remove it by hand")
    else: say(f"buildfit: the temporary swap file {path} is off and deleted")

def swap_mb_for(step, facts, serving):
    """The swap file a short step gets, or 0: only on a machine with no swap at all, as root, with disk to spare."""
    if facts.get("swap_total_mb") or (hasattr(os, "geteuid") and os.geteuid() != 0): return 0
    b = budget_mb(facts, serving)
    if b is None: return 0
    want = (STEPS.get(step) or STEPS["generic"])["need_mb"] - b
    mb = max(SWAP_MIN_MB, min(SWAP_MAX_MB, int(math.ceil(max(want, 0) * 2 / 1024.0)) * 1024))
    disk = facts.get("disk_free_mb")
    return mb if disk is not None and disk >= mb + SWAP_DISK_SPARE_MB else 0

def busiest(n=3):
    try: out = subprocess.run(["ps", "-eo", "rss=,args="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError): return "unknown"
    rows = sorted((l.strip().partition(" ") for l in out.splitlines() if l.strip()), key=lambda r: -int(r[0]) if r[0].isdigit() else 0)
    clean = lambda a: re.sub(r"[A-Za-z0-9_\-+/=]{32,}", "...", re.sub(r"://[^@\s/]+@", "://***@", a))[:60]
    return "; ".join(f"{clean(a)} ({int(r) // 1024} MB)" for r, _, a in rows[:n] if r.isdigit()) or "unknown"

def run(step, argv, serving=False, label=None, wait_s=WAIT_S, allow_swap=True, env=None, cwd=None,
        probe=measure, runner=stream, sleep=time.sleep, kills=oom_kills, swap=(swap_on, swap_off), wrapper=wrap, say=print, poll_s=POLL_S):
    """Run one heavy step sized to the machine. Returns its exit code, or CAPACITY_RC after a BUILD_SHORT line."""
    label = label or step
    base = dict(os.environ if env is None else env)
    swapped = False
    try:
        tight, heap = False, None
        for attempt in (1, 2):
            facts = probe(); pl = plan(step, facts, serving, tight, heap); waited = 0
            # Waiting helps only when other work holds the memory: if the whole machine (or the cgroup's limit) less the
            # headroom is under the step's floor, nothing that leaves will make room, so it goes straight on.
            whole = (facts.get("cg_limit_mb") or facts.get("mem_total_mb") or 0) - headroom_mb(facts, serving)
            if pl["mode"] == "short" and whole < (STEPS.get(step) or STEPS["generic"])["floor_mb"]:
                say(f"buildfit: {label}: this machine holds {whole} MB at most beside what it keeps back, under the step's floor; waiting would not help")
                waited = wait_s
            while pl["mode"] == "short" and waited < wait_s:
                if waited % max(60, poll_s) == 0:
                    say(f"buildfit: waiting for memory before {label}: {pl['why']}; {waited}s of {wait_s}s. Using the most now: {busiest()}")
                step_s = min(poll_s, wait_s - waited); sleep(step_s); waited += step_s
                facts = probe(); pl = plan(step, facts, serving, tight, heap)
            if pl["mode"] == "short" and allow_swap and not swapped:
                mb = swap_mb_for(step, facts, serving)
                if mb and swap[0](mb, say=say):
                    swapped = True; facts = probe(); pl = plan(step, facts, serving, tight, heap)
            if pl["mode"] == "short":
                say(f"buildfit: {label} cannot run on this machine now: {pl['why']}. Nothing was changed.")
                say(short_line(step, facts, serving)); return CAPACITY_RC
            say(plan_line(pl) + (" [second try, tight]" if attempt == 2 else ""))
            before = kills(); t0 = time.monotonic()
            rc, tail = runner(wrapper(argv, pl, facts), sized_env(base, pl), cwd)
            how = killed(rc, tail, before, kills())
            if not how:
                say(f"buildfit: {label} {'finished' if rc == 0 else f'failed (exit {rc}, not for lack of memory)'} in {int(time.monotonic() - t0)}s")
                return rc
            if attempt == 2:
                say(f"buildfit: {label} was killed for lack of memory again ({how}), at its smallest settings. Nothing was changed.")
                say(short_line(step, probe(), serving, killed=True)); return CAPACITY_RC
            if how == "heap":     # V8's own ceiling was too low for this step: more heap, inside the budget
                heap = min(HEAP_MAX_MB, max(pl["heap_mb"] + 512, (pl["heap_mb"] * 3) // 2))
                say(f"buildfit: {label} ran out of its {pl['heap_mb']} MB heap (exit {rc}); once more with {heap} MB")
            else:
                tight = True
                say(f"buildfit: {label} was killed by the kernel for lack of memory (exit {rc}): other work on this machine, not a fault "
                    "of the app. Once more, tight: one worker, two native threads, after waiting for memory")
        return 1
    finally:
        if swapped: swap[1](say=say)

def fit_workers(per_job_mb, most=8, facts=None):
    """How many light jobs (a self-test's subprocesses) to run at once here: idle CPUs and memory both allow it."""
    facts = facts or measure()
    b = budget_mb(facts, False)
    by_mem = most if b is None else max(1, b // max(1, per_job_mb))
    return max(1, min(most, idle_cpus(facts), by_mem))

# ---------------------------------------------------------------------------------------------------------
def cli(a):
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0 if a else 2
    if a[0] == "--self-test":       # the checks live with vm_remote's (vm_release_selftest.py, section buildfit)
        import vm_release_selftest
        return vm_release_selftest.buildfit_alone()
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    head = a[:a.index("--")] if "--" in a else a
    step = opt("--step", "generic")
    if step not in STEPS: print(f"buildfit: no step {step!r} (one of {', '.join(STEPS)})", file=sys.stderr); return 2
    serving = "--serving" in head
    if a[0] == "plan":
        f = measure(); print(json.dumps({"facts": f, "plan": plan(step, f, serving)}, indent=2)); return 0
    if a[0] == "run" and "--" in a and a[a.index("--") + 1:]:
        return run(step, a[a.index("--") + 1:], serving=serving, label=opt("--label"), wait_s=int(opt("--wait", str(WAIT_S))),
                   allow_swap="--no-swap" not in head)
    print(__doc__, file=sys.stderr); return 2

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(cli(sys.argv[1:]))
