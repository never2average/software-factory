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
            Memory short: wait for it (bounded, saying what is using it), then the machine's own swap, and when the
            step's need is still above the memory and swap there is, a temporary swap file for this step alone on a
            disk with room (said in the log, removed after). Killed by the kernel anyway: once more, tight. Killed
            again, or short even after all that: exit CAPACITY_RC with one BUILD_SHORT line naming the measured
            numbers, which the factory turns into the request for a bigger server (lib/vm_capacity.py,
            `provision.py <app> --capacity`). The step itself never switches anything, so the release that serves
            keeps serving.
  honest    (mold_v1-247) a step has finished only when it left what it is for (`produces`: the eve build's
            .vercel/output/config.json) and the kernel killed none of its processes. A build tool can exit 0 after
            the kernel killed its child (compliance_os, 2026-10-13: the child at 4.87 GB, "finished in 1208s", an
            empty output uploaded), so each run is watched (Watch): the scope's memory.events, the kernel log for the
            step's own processes, and the product. A kill or a missing product is a failure that says so ("killed
            for lack of memory at N MB"), shows the last lines of the build's own output (secrets hidden) and keeps
            the whole of it in a file; a kill then takes the retry above.
  the app   the eve build's need grows with the app: profile() scales it with the subagents in the build copy
            (PER_SUBAGENT_MB), and after every build that finished the peak that was measured is kept
            (~/.cache/software-factory/build-peaks.json) and used the next time instead of the estimate.
  one       one heavy build at a time on a machine (machine_lock: a flock under ~/.cache/software-factory/): a second
            app's build waits, saying whose build it waits for, and is sized only once it holds the lock.

  buildfit.py plan [--step S] [--serving] [--dir BUILD_COPY] [--who APP]
                                                   what the step would get here, now (JSON); changes nothing
  buildfit.py run --step S [--serving] [--label L] [--no-swap] [--wait S] [--who APP] [--produces PATH ...] [--out FILE]
               -- <command ...>                    the step, sized, waited for, retried once tight; exit as the command,
                                                   1 when it left no product, or CAPACITY_RC when the machine is too
                                                   small or too busy for it
  buildfit.py --self-test                          offline: the sizing for 2/4/8 GB, 1-4 CPUs, busy and idle; the wait,
                                                   the swap file, the retry and the clear failure, with stand-ins (the
                                                   checks are vm_release_selftest.py's `buildfit` section, which
                                                   vm_remote.py --self-test runs too)

Standard library only. The server's tool (vm_remote.py build-run) imports this file from the deploy's bundle.
"""
import contextlib, json, math, os, re, shlex, shutil, subprocess, sys, threading, time

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
# The eve build bundles every subagent, and its memory grows with them (mold_v1-247). Measured on the factory machine,
# counting the directories under agent/subagents that hold an agent.ts:
#   14 subagents (the base's 10 + a pack of 4)    2.5 GB resident (the table above), finishes with a 1280 MB heap
#   27 subagents (a pack of 23)                   5.06 GB (anonymous + swapped, 2026-10-13 19:44, the eve process alone);
#                                                 killed by the kernel at 4.87 GB on the machine without swap (19:38);
#                                                 out of heap at 2568, 2598 and 2656 MB, finishes at 3852 MB
# so about 190 MB of memory and 200 MB of heap for each subagent beyond 14. An estimate for an app never built here;
# once an app has been built, its own measured peak (PEAKS_PATH) is used instead.
BASE_SUBAGENTS, PER_SUBAGENT_MB, PER_SUBAGENT_HEAP_MB = 14, 190, 200
PEAK_MARGIN = 1.10                  # a measured peak plus this is the app's need the next time
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "software-factory")
PEAKS_PATH = os.path.join(CACHE_DIR, "build-peaks.json")
LOCK_PATH = os.path.join(CACHE_DIR, "heavy-build.lock")
LOCK_WAIT_S = 3600                  # how long a build queues behind another app's before it gives up, saying so
LOCK_ENV = "SF_HEAVY_BUILD_LOCK"    # set for the build's own processes: a build-run inside a build does not queue behind itself
TAIL_LINES = 60                     # of the build's own output, shown when it fails
HEAP_MAX_MB = 4096                  # V8's default on a 64-bit machine is about this; more only slows the GC down
# Kept free beyond the build: for a release that serves beside it (its chats and sandboxes may grow while the build
# runs), else for the machine itself. The larger of a floor and a share of the machine's memory.
HEADROOM_SERVING = (512, 0.06)
HEADROOM_IDLE = (256, 0.03)
WAIT_S = 600                        # how long a short step waits for memory before the swap file or the failure
POLL_S = 15
SWAP_PATH = "/var/tmp/sf-build.swap"
SWAP_MIN_MB, SWAP_MAX_MB = 1024, 8192
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
# the app: what THIS app's step needs (mold_v1-247)
# ---------------------------------------------------------------------------------------------------------
def subagents(app_dir):
    """How many subagents the build copy at app_dir holds (agent/subagents/<name>/agent.ts), or None when it has none."""
    d = os.path.join(app_dir or "", "agent", "subagents")
    try: n = sum(1 for e in os.listdir(d) if os.path.isfile(os.path.join(d, e, "agent.ts")))
    except OSError: return None
    return n or None

def read_peaks(path=None):
    try:
        with open(path or PEAKS_PATH) as f: d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError): return {}

def record_peak(path, who, step, **fields):
    """Keep what this app's step was measured at (None removes a field). Never fails the build: a cache."""
    path = path or PEAKS_PATH
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        d = read_peaks(path); rec = dict(d.get(f"{who}:{step}") or {})
        for k, v in fields.items():
            if v is None: rec.pop(k, None)
            else: rec[k] = v
        d[f"{who}:{step}"] = rec
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f: json.dump(d, f, indent=2, sort_keys=True); f.write("\n")
        os.replace(tmp, path)
    except OSError: pass

def _up(mb, to=50): return int(math.ceil(mb / float(to)) * to)

def profile(step, app_dir=None, who=None, peaks=None, count=subagents):
    """STEPS[step] for this app: the eve build's need, floor and heap scaled with the subagents in app_dir, then, when
    this app's step has been built on this machine before, the peak measured then (plus PEAK_MARGIN) instead of the
    estimate. A kill since the last build that finished (at_least_mb) only ever raises it. `basis` says which, in words."""
    base = STEPS.get(step) or STEPS["generic"]
    p = dict(base, step=step, subagents=None, measured_mb=None, basis="as usual")
    gap = base["need_mb"] - base["floor_mb"]
    n = count(app_dir) if step == "eve" and app_dir else None
    if n:
        extra = max(0, n - BASE_SUBAGENTS)
        p.update(subagents=n, need_mb=base["need_mb"] + PER_SUBAGENT_MB * extra, floor_mb=base["floor_mb"] + PER_SUBAGENT_MB * extra,
                 heap_mb=base["heap_mb"] + PER_SUBAGENT_HEAP_MB * extra, basis=f"estimated for this app's {n} subagents")
    rec = (peaks or {}).get(f"{who}:{step}") if who else None
    if isinstance(rec, dict):
        grown = PER_SUBAGENT_MB * max(0, (n or 0) - (rec.get("subagents") or n or 0)) if step == "eve" else 0
        m = rec.get("peak_mb")
        if isinstance(m, (int, float)) and m > 0:
            # never under the step's own floor: a build that found everything cached says little about the next one
            need = max(base["floor_mb"], _up((m + grown) * PEAK_MARGIN))
            p.update(need_mb=need, floor_mb=max(base["floor_mb"], need - gap), measured_mb=int(m),
                     basis=f"since this app's last build here peaked at {int(m)} MB" + (f", plus {grown} MB for the subagents added since" if grown else ""))
        k = rec.get("at_least_mb")
        if isinstance(k, (int, float)) and _up((k + grown) * 1.05) > p["need_mb"]:
            need = _up((k + grown) * 1.05)
            p.update(need_mb=need, floor_mb=max(base["floor_mb"], need - gap), basis=f"since this app's last build here was killed at {int(k)} MB")
        h = rec.get("heap_min_mb")
        if isinstance(h, (int, float)): p["heap_mb"] = max(p["heap_mb"], int(h))
    return p

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

def plan(step, facts, serving=False, tight=False, heap_mb=None, prof=None):
    """{mode, budget_mb, heap_mb, workers, threads, nice, ionice, cpu_weight, memory_high_mb, swap_mb, env, why}. Pure.
    `prof` is the app's own profile of the step (profile()); without one, the step's usual numbers."""
    p = prof or STEPS.get(step) or STEPS["generic"]
    budget, with_swap = budget_mb(facts, serving), budget_mb(facts, serving, swap=True)
    ram = budget
    cpus = max(1, facts.get("cpus") or 1); idle = idle_cpus(facts)
    busy = idle < cpus or (facts.get("load1") or 0) >= 0.75 * max(1, facts.get("host_cpus") or cpus)
    if budget is None:                                       # no memory reading (macOS): the step's need, one worker
        mode, budget = "tight", p["need_mb"]
    elif budget >= p["need_mb"] and not tight: mode = "roomy"
    elif budget >= p["floor_mb"]:
        # Above the floor, under the need: tight, and whatever swap the machine has is counted up to the need, so a
        # step that grows past its floor is slowed by the swap instead of killed (mold_v1-247).
        mode, budget = "tight", max(budget, min(with_swap, p["need_mb"]))
    elif with_swap >= p["floor_mb"]: mode, budget = "tight", with_swap      # only with the swap: tight, and slow
    else: mode = "short"
    swap_mb = max(0, budget - ram) if ram is not None and mode != "short" else 0
    if mode == "roomy":
        spare = budget - p["need_mb"]
        by_mem = 1 + (spare // p["worker_mb"] if p["worker_mb"] else cpus)
        workers = max(1, min(idle, by_mem, max(1, cpus - 1) if cpus > 2 else cpus))
        threads = max(min(2, cpus), idle)     # a busy CPU only slows a native pool; a starved one stalls it
        heap = max(p["heap_mb"], min(HEAP_MAX_MB, budget // 2))
    else:
        workers, threads = 1, max(1, min(2, idle))
        heap = max(p["heap_mb"], min(HEAP_MAX_MB, (budget * 3) // 5))
    if heap_mb: heap = max(heap, min(max(HEAP_MAX_MB, p["heap_mb"]), heap_mb))
    low = serving or busy or mode != "roomy"
    env = {"NODE_OPTIONS": f"--max-old-space-size={heap}", "BUILD_CPUS": str(workers), "BUILD_MEMORY_MIB": str(max(256, budget)),
           "RAYON_NUM_THREADS": str(threads), "TOKIO_WORKER_THREADS": str(threads), "UV_THREADPOOL_SIZE": str(max(2, min(4, threads))),
           "npm_config_maxsockets": "4" if mode != "roomy" else "8"}
    why = (f"{facts.get('mem_avail_mb')} MB available" + (f" ({facts['cg_room_mb']} MB left under this cgroup's limit)" if facts.get("cg_room_mb") is not None else "")
           + f", {headroom_mb(facts, serving)} MB kept for {'the release serving beside it' if serving else 'the machine'}, "
           f"{cpus} CPU{'s' if cpus != 1 else ''} ({idle} idle, load {facts.get('load1')}); {p['what']} needs {p['need_mb']} MB {p.get('basis') or 'as usual'}, {p['floor_mb']} MB at the least")
    return {"step": step, "mode": mode, "budget_mb": budget, "heap_mb": heap, "workers": workers, "threads": threads, "swap_mb": swap_mb,
            "nice": 19 if low else 10, "ionice": "idle" if low else "best-effort", "cpu_weight": 20 if low else 50,
            "io_weight": 20 if low else 50, "env": env, "why": why,
            # The scope's soft limit: above it the kernel takes back the build's page cache before anyone else's. Never
            # under the step's need, or a step that needs it would be throttled to a crawl instead of finishing.
            "memory_high_mb": max(budget, p["need_mb"] + p["need_mb"] // 10)}

def plan_line(pl):
    swap = f" ({pl['swap_mb']} MB of it swap: slower, not killed)" if pl.get("swap_mb") else ""
    return (f"buildfit: {pl['step']} {pl['mode']}: budget {pl['budget_mb']} MB{swap}, heap {pl['heap_mb']} MB, {pl['workers']} worker(s), "
            f"{pl['threads']} native thread(s), nice {pl['nice']}, io {pl['ionice']} ({pl['why']})")

def most_mb(facts, serving, swap_file_mb=0):
    """The most this machine could ever give a step: all of its memory (or its cgroup's limit) less the headroom, plus
    half of its swap and of a temporary swap file it has the disk for. Under a step's floor, no waiting helps."""
    whole = (facts.get("cg_limit_mb") or facts.get("mem_total_mb") or 0) - headroom_mb(facts, serving)
    return whole + ((facts.get("swap_total_mb") or 0) + swap_file_mb) // 2

def short_line(step, facts, serving, pl=None, killed=False, prof=None, at_mb=None):
    """The one machine-readable line a capacity failure prints (the factory parses it: vm_remote.build_short). The
    need and the floor are the app's own (prof); `killed` goes last."""
    p = prof or STEPS.get(step) or STEPS["generic"]
    kv = {"step": step, "need_mb": p["need_mb"], "floor_mb": p["floor_mb"], "budget_mb": budget_mb(facts, serving),
          "avail_mb": facts.get("mem_avail_mb"), "total_mb": facts.get("mem_total_mb"), "cg_limit_mb": facts.get("cg_limit_mb"),
          "swap_mb": facts.get("swap_total_mb"), "cpus": facts.get("cpus"), "load1": facts.get("load1"),
          "most_mb": most_mb(facts, serving, swap_file_mb(facts)), "subagents": p.get("subagents"), "measured_mb": p.get("measured_mb"),
          "killed_at_mb": at_mb, "killed": int(bool(killed))}
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
    at = f" (the last time at {s['killed_at_mb']} MB)" if s.get("killed_at_mb") else ""
    how = f"was killed for lack of memory twice{at}, the second time at its smallest settings" if s.get("killed") else "could not start: not even its smallest settings fit"
    app = ("as usual" if not (s.get("subagents") or s.get("measured_mb")) else "for this app (" + ", ".join(x for x in (
        f"{s['subagents']} subagents" if s.get("subagents") else "", f"its last build here peaked at {s['measured_mb']} MB" if s.get("measured_mb") else "") if x) + ")")
    most = (f" The most this machine can give it, with all of its memory and swap, is {s['most_mb']} MB: under what it needs, so waiting will not help."
            if s.get("most_mb") is not None and s.get("floor_mb") is not None and s["most_mb"] < s["floor_mb"] else "")
    return (f"{p['what'][0].upper() + p['what'][1:]} {how}. Measured: {s.get('avail_mb')} MB of memory available of {s.get('total_mb')} MB{lim}, "
            f"{s.get('swap_mb') or 0} MB swap, {s.get('cpus')} CPUs at load {s.get('load1')}; it needs {s.get('need_mb')} MB {app} and {s.get('floor_mb')} MB at the least "
            f"(it had {s.get('budget_mb')} MB after the headroom kept for what serves).{most}")

def too_small(s):
    """BUILD_SHORT numbers: True when the machine, not its load, is the limit (all it has is under the step's floor)."""
    return bool(s) and s.get("most_mb") is not None and s.get("floor_mb") is not None and s["most_mb"] < s["floor_mb"]

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
        named = [f"--unit={pl['unit']}"] if pl.get("unit") else []      # named, so the watcher finds its cgroup (mold_v1-247)
        return ["systemd-run", "--quiet", "--scope", "--collect", *named, "-p", f"CPUWeight={pl['cpu_weight']}", "-p", f"IOWeight={pl['io_weight']}",
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

def stream(argv, env, cwd=None, out=None, keep=None, hide=None):
    """Run argv; its output goes on to `out` as it comes, and the last 200 lines are kept to read for a kill. `keep` is
    a file the whole output is added to as well (secrets hidden by `hide`)."""
    out = out or sys.stdout
    p = subprocess.Popen(argv, env=env, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                         preexec_fn=_first_to_go if os.path.exists("/proc/self/oom_score_adj") else None)
    tail = []; kept = _open_private(keep) if keep else None
    try:
        for line in p.stdout:
            out.write(line); out.flush(); tail.append(line)
            if kept: kept.write((hide or redact)(line))
            if len(tail) > 200: del tail[:100]
    finally:
        if kept: kept.close()
    return p.wait(), "".join(tail)
stream.keeps = True      # run() hands it the file; any other runner's returned output is written by run() itself

def _open_private(path):
    """Append to a file only its owner may read (a build's output can name what its environment holds)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a", errors="replace")

# Secrets a build's output may carry, hidden before a line of it is shown or kept: credentials in a URL, a bearer
# token, the value of anything named like a secret, and any long opaque token (as busiest() does for command lines).
REDACT = [(re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@\"']*:[^\s/@\"']*@"), r"\1***:***@"),
          (re.compile(r"(?i)\b(bearer\s+)[^\s\"']+"), r"\1***"),
          (re.compile(r"(?i)\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|DATABASE_URL)[A-Z0-9_]*\s*[=:]\s*)(\"?)[^\s\"']{4,}"), r"\1\2***"),
          (re.compile(r"\b(?=[A-Za-z0-9_\-+=]*\d)(?=[A-Za-z0-9_\-+=]*[A-Za-z])[A-Za-z0-9_\-+=]{40,}"), "***")]
def redact(text):
    for rx, to in REDACT: text = rx.sub(to, text or "")
    return text

def show_tail(label, tail, say, hide=redact, kept=None, n=TAIL_LINES):
    """The last n lines of the build's own output, into the log, secrets hidden (mold_v1-247)."""
    lines = [l for l in (tail or "").splitlines() if l.strip()][-n:]
    if not lines:
        say(f"buildfit: {label} printed nothing" + (f" (its whole output: {kept})" if kept else "")); return
    say(f"buildfit: the last {len(lines)} lines {label} printed" + (f" (the whole of it: {kept})" if kept else "") + ":")
    for l in lines: say("  | " + hide(re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", l))[:400])

# ---- what happened to the step's processes (mold_v1-247) ----
def _dmesg():
    try: return subprocess.run(["dmesg"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError): return ""

def _boot_s():
    try: return time.clock_gettime(time.CLOCK_BOOTTIME)       # the clock the kernel log's stamps are in
    except (AttributeError, OSError): return None

OOM_HEAD = re.compile(r"^\[\s*(\d+\.\d+)\]\s+oom-kill:.*?task_memcg=([^,\s]*).*?pid=(\d+)", re.M)
OOM_KILL = re.compile(r"^\[\s*(\d+\.\d+)\]\s+(?:Memory cgroup out of memory|Out of memory): Killed process (\d+) \((.*?)\)[^\n]*?anon-rss:(\d+)kB", re.M)
def oom_victims(text, since_s, pids=(), unit=None):
    """The kernel log's OOM kills since `since_s` (seconds since boot) of one of `pids` or of a process in `unit`'s
    scope: [{pid, name, anon_mb}]. Another build's or another app's kill is not this step's."""
    scope = {m.group(3): m.group(2) for m in OOM_HEAD.finditer(text or "") if float(m.group(1)) >= since_s}
    out, pids = [], {str(p) for p in pids}
    for m in OOM_KILL.finditer(text or ""):
        if float(m.group(1)) < since_s: continue
        pid = m.group(2)
        if pid in pids or (unit and scope.get(pid, "").endswith("/" + unit + ".scope")):
            out.append({"pid": int(pid), "name": m.group(3), "anon_mb": int(m.group(4)) // 1024})
    return out

def _descendants(root_pid, proc="/proc"):
    kids = {}
    try: names = os.listdir(proc)
    except OSError: return []
    for n in names:
        if not n.isdigit(): continue
        st = _read(os.path.join(proc, n, "stat"))
        if not st: continue
        f = st.rsplit(")", 1)[-1].split()
        if len(f) > 1 and f[1].isdigit(): kids.setdefault(int(f[1]), []).append(int(n))
    out, todo = [], [root_pid]
    while todo:
        for k in kids.get(todo.pop(), ()): out.append(k); todo.append(k)
    return out

class Watch:
    """Watch one run of a step: the most memory its processes held (anonymous + swapped; the page cache is left out,
    the kernel reclaims it) and whether the kernel killed any of them. With a named systemd scope (`unit`) that is the
    scope's own cgroup (memory.stat, memory.swap.current, memory.events' oom_kill); without one, this process's
    descendants. stop() also reads the kernel log for a kill of one of the processes seen, or in the scope: a build
    tool can exit 0 after its child was killed. Returns {peak_mb, oom_kills, killed: [{pid, name, anon_mb}]}."""
    def __init__(self, unit=None, every=1.0, root="/sys/fs/cgroup", proc="/proc", dmesg=_dmesg, pid=None):
        self.unit, self.every, self.root, self.proc, self.dmesg = unit, every, root, proc, dmesg
        self.pid = pid or os.getpid(); self.pids = set(); self.peak = 0; self.kills = 0; self.dir = None
        self.since = _boot_s(); self._stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True); self.thread.start()
    def _scope(self):
        if self.dir or not self.unit: return self.dir
        for d in (os.path.join(self.root, "system.slice", self.unit + ".scope"), os.path.join(self.root, self.unit + ".scope")):
            if os.path.isdir(d): self.dir = d; break
        return self.dir
    def sample(self):
        d = self._scope()
        if d:
            anon = re.search(r"^anon (\d+)", _read(os.path.join(d, "memory.stat")) or "", re.M)
            swapped = (_read(os.path.join(d, "memory.swap.current")) or "").strip()
            mb = ((int(anon.group(1)) if anon else 0) + (int(swapped) if swapped.isdigit() else 0)) // 1048576
            k = re.search(r"^oom_kill (\d+)", _read(os.path.join(d, "memory.events")) or "", re.M)
            if k: self.kills = max(self.kills, int(k.group(1)))
            self.pids.update(int(x) for x in (_read(os.path.join(d, "cgroup.procs")) or "").split() if x.isdigit())
        else:
            kb = 0
            for p in _descendants(self.pid, self.proc):
                self.pids.add(p)
                st = _read(os.path.join(self.proc, str(p), "status")) or ""
                kb += sum(int(m.group(1)) for m in re.finditer(r"^(?:RssAnon|VmSwap):\s+(\d+) kB", st, re.M))
            mb = kb // 1024
        self.peak = max(self.peak, mb)
    def _loop(self):
        while not self._stop.is_set():
            try: self.sample()
            except Exception: pass                      # a watcher never fails the build it watches
            self._stop.wait(self.every)
    def stop(self):
        self._stop.set(); self.thread.join(timeout=5)
        try: self.sample()                              # a scope that is still there keeps its count until it is collected
        except Exception: pass
        killed = []
        if self.since is not None and (self.pids or self.unit):
            try: killed = oom_victims(self.dmesg(), self.since - 2, self.pids, self.unit)
            except Exception: killed = []
        return {"peak_mb": self.peak or None, "oom_kills": self.kills, "killed": killed}

class NoWatch:
    def __init__(self, unit=None): pass
    def stop(self): return {"peak_mb": None, "oom_kills": 0, "killed": []}

def missing_products(produces, cwd, since):
    """Those of `produces` (paths, relative to cwd) the step did not leave: absent, or older than the step's start."""
    out = []
    for f in produces or ():
        try: fresh = os.path.getmtime(os.path.join(cwd or ".", f)) >= since - 2
        except OSError: fresh = False
        if not fresh: out.append(f)
    return out

# ---- one heavy build at a time on this machine (mold_v1-247) ----
def _since(sec):
    sec = int(max(0, sec)); return f"{sec // 60} min" if sec >= 120 else f"{sec}s"

@contextlib.contextmanager
def machine_lock(who, say=print, sleep=time.sleep, path=None, wait_s=LOCK_WAIT_S, poll_s=5, now=time.time):
    """Hold the machine's heavy-build lock (a flock: it goes with its process, so a build that died holds nothing).
    Another app's build holding it: wait, saying whose, up to wait_s. Yields None when held, else the holder's name."""
    try: import fcntl
    except ImportError:
        yield None; return
    path = path or LOCK_PATH
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True); f = open(path, "a+")
    except OSError:
        yield None; return                              # no place for a lock (a read-only home): the build still runs
    waited, got, other = 0, False, "another app"
    try:
        while True:
            try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); got = True; break
            except OSError: pass
            try: held = json.loads(_read(path) or "{}")
            except ValueError: held = {}
            other = str(held.get("who") or "another app")
            if waited >= wait_s: break
            if waited % 60 == 0:
                age = f", started {_since(now() - held['since'])} ago" if isinstance(held.get("since"), (int, float)) else ""
                say(f"buildfit: waiting for {other}'s build to finish before {who}'s (pid {held.get('pid', '?')}{age}): one heavy build at a time "
                    f"on this machine; {waited}s of {wait_s}s")
            sleep(poll_s); waited += poll_s
        if got:
            f.seek(0); f.truncate(); f.write(json.dumps({"who": who, "pid": os.getpid(), "since": int(now())})); f.flush()
            if waited: say(f"buildfit: {other}'s build is done after {_since(waited)}; {who}'s goes on, measured now")
        yield None if got else other
    finally:
        if got:
            try: f.seek(0); f.truncate(); f.flush(); fcntl.flock(f, fcntl.LOCK_UN)
            except OSError: pass
        f.close()

def swap_on(mb, run=subprocess.run, path=SWAP_PATH, say=print):
    """A temporary swap file of `mb` MB. True when it is on."""
    cmds = [["fallocate", "-l", f"{mb}M", path], ["chmod", "600", path], ["mkswap", path], ["swapon", path]]
    for c in cmds:
        r = run(c, capture_output=True, text=True)
        if r.returncode:
            say(f"buildfit: the temporary swap file could not be made ({' '.join(c[:1])}: {(r.stderr or '').strip()[:120]}); going on without it")
            run(["swapoff", path], capture_output=True, text=True); run(["rm", "-f", path], capture_output=True, text=True)
            return False
    say(f"buildfit: the step needs more than this machine's free memory and swap, so a temporary {mb} MB swap file ({path}) is on "
        "for this step only; it is turned off and deleted when the step ends")
    return True

def swap_off(run=subprocess.run, path=SWAP_PATH, say=print):
    r = run(["swapoff", path], capture_output=True, text=True)
    run(["rm", "-f", path], capture_output=True, text=True)
    if r.returncode: say(f"buildfit: the temporary swap file {path} could not be turned off ({(r.stderr or '').strip()[:120]}); remove it by hand")
    else: say(f"buildfit: the temporary swap file {path} is off and deleted")

def swap_file_mb(facts, euid=None):
    """The largest temporary swap file this machine could be given: 0 unless root, with the disk to spare."""
    euid = os.geteuid() if euid is None and hasattr(os, "geteuid") else (euid or 0)
    disk = facts.get("disk_free_mb")
    if euid != 0 or disk is None: return 0
    return max(0, min(SWAP_MAX_MB, (int(disk - SWAP_DISK_SPARE_MB) // 1024) * 1024))

def swap_mb_for(step, facts, serving, prof=None, euid=None):
    """The temporary swap file a step gets, or 0. Its need is set against the memory free now plus half the swap the
    machine already has (which is used first); what is still missing is made up, twice over (half of swap counts),
    as root, with disk to spare. So a machine with swap that is too small or used up gets one too (mold_v1-247)."""
    b = budget_mb(facts, serving, swap=True)
    if b is None: return 0
    want = (prof or STEPS.get(step) or STEPS["generic"])["need_mb"] - b
    if want <= 0: return 0
    mb = max(SWAP_MIN_MB, min(SWAP_MAX_MB, int(math.ceil(want * 2 / 1024.0)) * 1024))
    return mb if swap_file_mb(facts, euid) >= mb else 0

def busiest(n=3):
    try: out = subprocess.run(["ps", "-eo", "rss=,args="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError): return "unknown"
    rows = sorted((l.strip().partition(" ") for l in out.splitlines() if l.strip()), key=lambda r: -int(r[0]) if r[0].isdigit() else 0)
    clean = lambda a: re.sub(r"[A-Za-z0-9_\-+/=]{32,}", "...", re.sub(r"://[^@\s/]+@", "://***@", a))[:60]
    return "; ".join(f"{clean(a)} ({int(r) // 1024} MB)" for r, _, a in rows[:n] if r.isdigit()) or "unknown"

def run(step, argv, serving=False, label=None, wait_s=WAIT_S, allow_swap=True, env=None, cwd=None,
        probe=measure, runner=stream, sleep=time.sleep, kills=oom_kills, swap=(swap_on, swap_off), wrapper=wrap, say=print, poll_s=POLL_S,
        produces=(), who=None, out_file=None, hide=redact, watch=Watch, lock=machine_lock, peaks=None, prof=None, count=subagents):
    """Run one heavy step sized to the machine and to the app. Returns its exit code; 1 when it exited 0 without leaving
    `produces`; CAPACITY_RC after a BUILD_SHORT line. One at a time on the machine (`lock`), watched for a kill of any
    of its processes (`watch`), its measured peak kept for the app's next build (`peaks`: a path, None for the
    machine's own file, False for none). `who` names the app: in the lock's waiting line and as the peak's key."""
    label = label or step; who = who or label
    base = dict(os.environ if env is None else env)
    if not lock or base.get(LOCK_ENV):
        return _run(step, argv, serving, label, wait_s, allow_swap, base, cwd, probe, runner, sleep, kills, swap, wrapper, say, poll_s,
                    produces, who, out_file, hide, watch, peaks, prof, count)
    with lock(who, say=say, sleep=sleep) as other:
        if other:
            say(f"buildfit: {label} was not started: {other}'s build still holds this machine after {_since(LOCK_WAIT_S)}. Nothing was changed. "
                "Run it again when that build is done.")
            return 1
        base[LOCK_ENV] = "held"
        return _run(step, argv, serving, label, wait_s, allow_swap, base, cwd, probe, runner, sleep, kills, swap, wrapper, say, poll_s,
                    produces, who, out_file, hide, watch, peaks, prof, count)

def _run(step, argv, serving, label, wait_s, allow_swap, base, cwd, probe, runner, sleep, kills, swap, wrapper, say, poll_s,
         produces, who, out_file, hide, watch, peaks, prof, count):
    swapped = False
    p = prof or profile(step, cwd, who, read_peaks(peaks) if peaks is not False else {}, count)
    top = 0                                                  # the most memory any try of this run held
    def keep(**fields):
        if peaks is not False: record_peak(peaks, who, step, subagents=p.get("subagents"), at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields)
    try:
        tight, heap, heap_failed = False, None, False
        for attempt in (1, 2):
            facts = probe(); pl = plan(step, facts, serving, tight, heap, p); waited = 0
            # Waiting helps only when other work holds the memory: if the whole machine (or the cgroup's limit) less the
            # headroom is under the step's floor, nothing that leaves will make room, so it goes straight on (to the
            # swap file, or to the capacity exit).
            whole = (facts.get("cg_limit_mb") or facts.get("mem_total_mb") or 0) - headroom_mb(facts, serving)
            if pl["mode"] == "short" and whole < p["floor_mb"]:
                say(f"buildfit: {label}: this machine holds {whole} MB at most beside what it keeps back, under the step's floor of {p['floor_mb']} MB; "
                    "waiting would not help")
                waited = wait_s
            while pl["mode"] == "short" and waited < wait_s:
                if waited % max(60, poll_s) == 0:
                    say(f"buildfit: waiting for memory before {label}: {pl['why']}; {waited}s of {wait_s}s. Using the most now: {busiest()}")
                step_s = min(poll_s, wait_s - waited); sleep(step_s); waited += step_s
                facts = probe(); pl = plan(step, facts, serving, tight, heap, p)
            # Swap whenever the step's need is above the memory free (mold_v1-247): the machine's own first (the plan
            # counts it), then a temporary file for what is still missing.
            if allow_swap and not swapped:
                mb = swap_mb_for(step, facts, serving, p)
                if mb and swap[0](mb, say=say):
                    swapped = True; facts = probe(); pl = plan(step, facts, serving, tight, heap, p)
            if pl["mode"] == "short":
                say(f"buildfit: {label} cannot run on this machine now: {pl['why']}. Nothing was changed.")
                say(short_line(step, facts, serving, prof=p)); return CAPACITY_RC
            say(plan_line(pl) + (" [second try, tight]" if attempt == 2 else ""))
            pl["unit"] = f"sf-build-{os.getpid()}-{int(time.time())}-{attempt}"
            wrapped = wrapper(argv, pl, facts)
            before = kills(); t0 = time.monotonic(); started = time.time()
            if out_file:
                with _open_private(out_file) as f: f.write(f"==== {label}, try {attempt}: {hide(plan_line(pl))}\n")
            eye = (watch or NoWatch)(pl["unit"] if wrapped[:1] == ["systemd-run"] else None)
            try:
                rc, tail = runner(wrapped, sized_env(base, pl), cwd, keep=out_file, hide=hide) if getattr(runner, "keeps", False) else runner(wrapped, sized_env(base, pl), cwd)
            finally: seen = eye.stop()
            if out_file and not getattr(runner, "keeps", False):
                with _open_private(out_file) as f: f.write(hide(tail or "")); f.write("\n")
            took = int(time.monotonic() - t0); after = kills()
            top = max(top, seen.get("peak_mb") or 0)
            missing = missing_products(produces, cwd, started) if rc == 0 else []
            how = killed(rc, tail, before, after)
            child = bool(seen.get("oom_kills") or seen.get("killed"))      # a process of the step's, whatever the parent's exit
            rose = before is not None and after is not None and after > before
            if not how and (child or (missing and rose)): how = "kernel"
            if not how and rc == 0 and not missing:
                at = f", {seen['peak_mb']} MB at its most" if seen.get("peak_mb") else ""
                say(f"buildfit: {label} finished in {took}s{at}")
                if top: keep(peak_mb=top, at_least_mb=None, mode=pl["mode"], seconds=took, **({"heap_min_mb": pl["heap_mb"]} if heap_failed else {}))
                return 0
            if not how:
                if rc == 0:      # exit 0 and nothing to show for it: never "finished" (mold_v1-247)
                    say(f"buildfit: {label} FAILED: it exited 0 after {took}s but did not leave {', '.join(missing)}, which is what it is for. "
                        "No sign in the kernel's log that it was killed for memory, so it is not run again.")
                else: say(f"buildfit: {label} failed (exit {rc}, not for lack of memory) in {took}s")
                show_tail(label, tail, say, hide, out_file)
                return rc or 1
            if how == "kernel":
                victim = max(seen.get("killed") or [{}], key=lambda v: v.get("anon_mb") or 0)
                at_mb = max(victim.get("anon_mb") or 0, seen.get("peak_mb") or 0) or None
                top = max(top, at_mb or 0)
                what = (f"the kernel killed one of its processes ({victim['name']}, pid {victim['pid']})" if victim.get("pid") else
                        "the kernel killed one of its processes" if child else "the kernel killed it")
                why = (f"{what} for lack of memory" + (f" at {at_mb} MB" if at_mb else "") + f" after {took}s"
                       + (f"; the build's own exit was {rc}" + (f" and it left no {', '.join(missing)}" if missing else "") if child or rc == 0 else f" (exit {rc})"))
                if at_mb: keep(at_least_mb=at_mb)
            else: at_mb = None
            show_tail(label, tail, say, hide, out_file)
            if attempt == 2:
                say(f"buildfit: {label} was killed for lack of memory again ({how}" + (f", at {at_mb} MB" if at_mb else "") + "), at its smallest settings. Nothing was changed.")
                say(short_line(step, probe(), serving, killed=True, prof=p, at_mb=at_mb)); return CAPACITY_RC
            if how == "heap":     # V8's own ceiling was too low for this step: more heap, inside the budget
                # The ceiling is the step's whole budget (RAM + swap it may use) less 1 GB for native memory, not the
                # step's recorded heap: a pack that grew past that heap (2026-10-15, compliance_os at 5080 MB) used to be
                # retried at the very heap it had just run out of.
                cap = max(HEAP_MAX_MB, p["heap_mb"], (pl.get("budget_mb") or 0) - 1024)
                heap = min(cap, max(pl["heap_mb"] + 512, (pl["heap_mb"] * 3) // 2)); heap_failed = True
                say(f"buildfit: {label} ran out of its {pl['heap_mb']} MB heap (exit {rc}); once more with {heap} MB")
            else:
                tight = True
                if at_mb and _up(at_mb * 1.05) > p["need_mb"]:        # it needs more than was thought: sized to that now
                    gap = p["need_mb"] - p["floor_mb"]; need = _up(at_mb * 1.05)
                    p = dict(p, need_mb=need, floor_mb=max(p["floor_mb"], need - gap), basis=f"since it was just killed at {at_mb} MB")
                say(f"buildfit: {label} FAILED: {why}: this machine's memory, not a fault of the app. Once more, tight: one worker, "
                    "two native threads, after waiting for memory, with swap for what is missing")
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
        f = measure(); pr = profile(step, opt("--dir", os.getcwd()), opt("--who"), read_peaks())
        print(json.dumps({"facts": f, "profile": pr, "plan": plan(step, f, serving, prof=pr)}, indent=2)); return 0
    if a[0] == "run" and "--" in a and a[a.index("--") + 1:]:
        produces = [head[i + 1] for i, x in enumerate(head) if x == "--produces" and i + 1 < len(head)]
        return run(step, a[a.index("--") + 1:], serving=serving, label=opt("--label"), wait_s=int(opt("--wait", str(WAIT_S))),
                   allow_swap="--no-swap" not in head, produces=produces, who=opt("--who"), out_file=opt("--out"), cwd=os.getcwd())
    print(__doc__, file=sys.stderr); return 2

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(cli(sys.argv[1:]))
