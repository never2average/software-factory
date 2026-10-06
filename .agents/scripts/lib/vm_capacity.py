#!/usr/bin/env python3
"""vm_capacity: is this app's own server big enough? (mold_v1-195)

The operator's decision (2026-10-06): keep the self-hosted deployment scalable by default, and when the server is
having issues or reaching its limits, ask them for a bigger one. So every limit is derived from the server itself
(the mold's sandbox guard at every start, Postgres' memory settings at every deploy), a resize needs only a
redeploy, and this check says when one is due:

  provision.py <app_id> --capacity [--hours 24] [--no-task] [--dry-run]

READ-ONLY ON THE SERVER: one SSH command that reads, as root, what the server already records:
  - the agent API's journal: the sandbox guard's own lines (agent/lib/sandbox-guard.ts: time in line for a sandbox,
    calls answered "Waiting for a free sandbox", watchdog hangs, boots that did not start, waits for memory) and
    when the API was stopped and started (a deploy);
  - the kernel's journal: processes killed for lack of memory;
  - sysstat's history (sadf, every 10 minutes): load, CPU and memory pressure, available memory, swap, CPU steal;
  - each session sandbox's own logs: guest kernels that logged "scheduling while atomic" (a starved vCPU);
  - now: CPUs, memory, swap, disk, pressure.
Windows the factory itself filled on purpose are left out: each deploy (the API stopped until it started again) and
each load check `--sandbox-load` recorded in state (vm_remote.load_checks).

Every threshold is in THRESHOLDS below, and nowhere else. The verdict is the worst level any signal reaches:
  ok                    nothing near a limit
  watch                 something is close; nothing to ask yet
  needs a bigger box    the operator is asked, in plain steps (AGENTS.md, "Asking the operator for something"),
                        for one named plan with its monthly price; a factory task is filed, or the open one refreshed
                        (never a second one). --no-task leaves the tasks alone.
Exit 0 for ok and watch, 1 for needs a bigger box, 2 when the server could not be read.

  vm_capacity.py --self-test     offline: judge, plan choice, request text and task filing on recorded data
"""
import datetime, json, os, re, shlex, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
if HERE not in sys.path: sys.path.insert(0, HERE)
import vm_remote as V

OK, WATCH, BIGGER = "ok", "watch", "needs a bigger box"
LEVELS = (OK, WATCH, BIGGER)

# ---- THE THRESHOLDS, in one place ---------------------------------------------------------------------------------
# key: (what it is, in words; higher or lower is worse; watch from; bigger box from; which resource it points at)
# Resources: "cpu" (more vCPUs: more sandboxes at once), "contention" (vCPUs starved under nested KVM: dedicated
# CPUs), "memory", "disk". Counts are PER DAY (a window longer than 24 h is averaged), outside the windows left out.
# "Bigger box" means people lose minutes again and again, or the server is about to run out of something: each hang
# costs a call about a minute (SANDBOX_STALL_S) and a lost command, each boot retry about a minute. The guest kernel
# warning is a share of sandboxes and never more than "watch": on the first server about 1 in 10 sandboxes logged it
# with and without the running cap (2026-10-06), and alone it did not stop work; the hangs and retries it can lead to
# are judged on their own.
THRESHOLDS = {
    "wait_p90_s":        ("time a call waited in line for a free sandbox, 90th percentile, seconds", ">=", 30, 120, "cpu"),
    "saturated_pct":     ("share of the time some call was waiting for a free sandbox, %", ">=", 2, 8, "cpu"),
    "no_free":           ("calls answered 'Waiting for a free sandbox' (nothing ran), per day", ">=", 1, 3, "cpu"),
    "load_per_cpu_p95":  ("15-minute load per CPU, 95th percentile", ">=", 1.0, 1.5, "cpu"),
    "cpu_psi_p95":       ("time work waited for a CPU (5-minute pressure), 95th percentile, %", ">=", 25, 50, "cpu"),
    "hangs":             ("commands whose sandbox stopped responding (the guard's watchdog), per day", ">=", 1, 3, "contention"),
    "boot_retries":      ("sandboxes that did not start in time and were started again, per day", ">=", 1, 5, "contention"),
    "gave_up":           ("steps told that no sandbox started at all, per day", ">=", 1, 1, "contention"),
    "kernel_warn_pct":   ("sandboxes whose guest kernel logged 'scheduling while atomic', % of those used", ">=", 5, None, "contention"),
    "steal_p95":         ("CPU time taken by other customers of the same physical machine, 95th percentile, %", ">=", 10, 25, "contention"),
    "mem_avail_min_pct": ("memory available at the lowest point, % of the server's", "<=", 15, 8, "memory"),
    "swap_used_max_pct": ("swap in use at the highest point, %", ">=", 25, 50, "memory"),
    "oom_kills":         ("processes the kernel killed for lack of memory, per day", ">=", 1, 1, "memory"),
    "mem_waits":         ("sandboxes that waited for memory before booting, per day", ">=", 1, 5, "memory"),
    "mem_short":         ("sandboxes booted while memory was still short, per day", ">=", 1, 3, "memory"),
    "mem_psi_p95":       ("time work stalled on memory (5-minute pressure), 95th percentile, %", ">=", 5, 15, "memory"),
    "disk_used_pct":     ("disk in use now, %", ">=", 80, 90, "disk"),
}
# Time in line is judged only once there is enough of it to be a pattern, not one unlucky minute; the guest kernel
# warning only over enough sandboxes to be a share.
MIN_WAITS = 5
MIN_VMS = 10
DEFAULT_HOURS, MAX_HOURS = 24, 168
# Around a deploy: its first steps (packages, Postgres restart) run before the API stops, and the guard settles after.
DEPLOY_PAD_BEFORE_S, DEPLOY_PAD_AFTER_S = 600, 300
LOAD_CHECKS_KEPT = 20

# ---- DigitalOcean plans (list prices per month, USD, as of 2026-10-06; the resize screen shows the price before
# anything is confirmed). (slug, family as the console names it, kind, vCPUs, memory GB, disk GB, $/month, dedicated)
DO_PLANS = (
    ("s-4vcpu-8gb", "Basic", "Regular", 4, 8, 160, 48, False),
    ("s-8vcpu-16gb", "Basic", "Regular", 8, 16, 320, 96, False),
    ("c-4", "CPU-Optimized", "", 4, 8, 50, 84, True),
    ("c2-4vcpu-8gb", "CPU-Optimized", "", 4, 8, 100, 94, True),
    ("c-8", "CPU-Optimized", "", 8, 16, 100, 168, True),
    ("c2-8vcpu-16gb", "CPU-Optimized", "", 8, 16, 200, 188, True),
    ("c-16", "CPU-Optimized", "", 16, 32, 200, 336, True),
    ("c2-16vcpu-32gb", "CPU-Optimized", "", 16, 32, 400, 376, True),
    ("c-32", "CPU-Optimized", "", 32, 64, 400, 672, True),
    ("c2-32vcpu-64gb", "CPU-Optimized", "", 32, 64, 800, 752, True),
    ("g-4vcpu-16gb", "General Purpose", "", 4, 16, 50, 126, True),
    ("gd-4vcpu-16gb", "General Purpose", "", 4, 16, 100, 136, True),
    ("g-8vcpu-32gb", "General Purpose", "", 8, 32, 100, 252, True),
    ("gd-8vcpu-32gb", "General Purpose", "", 8, 32, 200, 272, True),
    ("g-16vcpu-64gb", "General Purpose", "", 16, 64, 200, 504, True),
    ("gd-16vcpu-64gb", "General Purpose", "", 16, 64, 400, 544, True),
)
PLAN_KEYS = ("slug", "family", "kind", "vcpu", "mem_gb", "disk_gb", "price", "dedicated")
def plans(): return [dict(zip(PLAN_KEYS, p)) for p in DO_PLANS]
def plan_label(p): return f"{p['family']} {p['vcpu']} vCPUs / {p['mem_gb']} GB memory / {p['disk_gb']} GB disk (${p['price']} a month)"

# ---------------------------------------------------------------------------------------------------------
# the read (one SSH command, read-only)
# ---------------------------------------------------------------------------------------------------------
def probe_sh(S, since):
    """READ-ONLY, as root on the server: KEY=VALUE facts, then one record per line: `S` sysstat rows (sadf -d -U),
    `J` the agent API's sandbox and start/stop lines, `K` kernel out-of-memory kills, `V` one per session sandbox."""
    return V.fill(r"""set -u
since=@SINCE@
iso="$(date -u -d "@$since" '+%Y-%m-%d %H:%M:%S UTC')"
kv() { awk -v k="$1" '$1 == k":" {print $2}' /proc/meminfo; }
echo "NOW=$(date +%s)"
echo "VCPU=$(nproc)"
echo "MEM_KB=$(kv MemTotal)"
echo "MEM_AVAILABLE_KB=$(kv MemAvailable)"
echo "SWAP_TOTAL_KB=$(kv SwapTotal)"
echo "SWAP_FREE_KB=$(kv SwapFree)"
echo "LOADAVG=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "DISK_USED_PCT=$(df -P @HOME@ 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
echo "DISK_TOTAL_KB=$(df -Pk @HOME@ 2>/dev/null | awk 'NR==2 {print $2}')"
echo "HOSTNAME=$(hostname)"
for r in cpu memory io; do
  [ -r "/proc/pressure/$r" ] && echo "PSI_$(echo "$r" | tr a-z A-Z)=$(sed -n 's/^some //p' "/proc/pressure/$r")"
done
if command -v sadf >/dev/null 2>&1; then echo "SYSSTAT=yes"; else echo "SYSSTAT=no"; fi
# sysstat keeps one file per day of the month (saDD, the server's local date); rows older than the window are dropped here.
days=""; t=$since; end=$(date +%s)
while [ "$t" -le "$end" ]; do days="$days $(date -d "@$t" +%d)"; t=$((t + 86400)); done
days="$days $(date +%d)"
if command -v sadf >/dev/null 2>&1; then
  for dd in $(printf '%s\n' $days | awk '!seen[$0]++'); do
    f="/var/log/sysstat/sa$dd"; [ -r "$f" ] || continue
    for o in "-q" "-q CPU" "-q MEM" "-r" "-S" "-u"; do
      sadf -d -U "$f" -- $o 2>/dev/null | awk -v s="$since" -F';' '/^#/ {print "S " $0; next} $3 >= s {print "S " $0}'
    done
  done
fi
journalctl -u @UNIT@-api.service --since "$iso" --no-pager -o short-unix 2>/dev/null \
  | grep -E '\[sandbox\] |systemd\[1\]: (Stopping|Started) @UNIT@-api\.service' | tail -n 50000 | sed 's/^/J /'
journalctl -k --since "$iso" --no-pager -o short-unix 2>/dev/null | grep -iE 'Out of memory: Killed|oom-kill' | tail -n 500 | sed 's/^/K /'
for d in @HOME@/.microsandbox/sandboxes/eve-sbx-ses-*; do
  f="$d/logs/runtime.log"; [ -f "$f" ] || continue
  m="$(stat -c %Y "$f")"; [ "$m" -ge "$since" ] || continue
  w=0; grep -q 'BUG: scheduling while atomic' "$d/logs/kernel.log" 2>/dev/null && w=1
  echo "V $m $w"
done
""", SINCE=str(int(since)), UNIT=S["unit"], HOME=V.SERVICE_HOME)

def probe_argv(S, since, shown=False):
    return V.ssh_argv(S, f"{S['sudo']}bash -c {shlex.quote(probe_sh(S, since))}", shown)

def parse(text):
    """{facts, sar: {activity: [row dicts]}, journal: [(ts, line)], oom: [(ts, line)], vms: [(mtime, warned)]}."""
    out = {"facts": {}, "sar": {}, "journal": [], "oom": [], "vms": []}
    header = None
    for line in (text or "").splitlines():
        if line.startswith("S "):
            row = line[2:]
            if row.startswith("# "):
                header = row[2:].split(";"); continue
            if not header: continue
            vals = row.split(";")
            if len(vals) != len(header): continue
            key = _activity(header)
            if not key: continue
            d = {}
            for k, v in zip(header, vals):
                try: d[k] = float(v)
                except ValueError: d[k] = v
            out["sar"].setdefault(key, []).append(d)
        elif line.startswith("J ") or line.startswith("K "):
            parts = line[2:].split(" ", 1)
            try: ts = float(parts[0])
            except (ValueError, IndexError): continue
            (out["journal"] if line[0] == "J" else out["oom"]).append((ts, parts[1] if len(parts) > 1 else ""))
        elif line.startswith("V "):
            p = line.split()
            if len(p) == 3 and p[1].isdigit(): out["vms"].append((int(p[1]), p[2] == "1"))
        else:
            m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line.strip())
            if m: out["facts"][m.group(1)] = m.group(2).strip()
    return out

def _activity(header):
    h = set(header)
    if "ldavg-15" in h: return "load"
    if "%scpu-300" in h: return "cpu_psi"
    if "%smem-300" in h: return "mem_psi"
    if "kbavail" in h: return "mem"
    if "%swpused" in h: return "swap"
    if "%steal" in h: return "cpu"
    return None

# ---------------------------------------------------------------------------------------------------------
# windows left out
# ---------------------------------------------------------------------------------------------------------
def _ts(s):
    try: return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError: return None

def deploy_windows(journal, unit, now):
    """(from, to) for each time the agent API was stopped until it started again: a deploy (or a restart)."""
    out, stop = [], None
    for ts, line in journal:
        if f"Stopping {unit}-api.service" in line and stop is None: stop = ts
        elif f"Started {unit}-api.service" in line:
            if stop is not None: out.append((stop - DEPLOY_PAD_BEFORE_S, ts + DEPLOY_PAD_AFTER_S))
            stop = None
    if stop is not None: out.append((stop - DEPLOY_PAD_BEFORE_S, now))
    return out

def load_check_windows(infra, wait_s=180):
    out = []
    for w in ((infra.get("vm_remote") or {}).get("load_checks") or []):
        a, b = _ts(w.get("from")), _ts(w.get("to"))
        if a and b: out.append((a, b + wait_s + 60))
    return out

def _inside(ts, windows): return any(a <= ts <= b for a, b in windows)
def _overlaps(a, b, windows): return any(x < b and a < y for x, y in windows)
def _merged_seconds(spans):
    total, end = 0.0, None
    for a, b in sorted(spans):
        if end is None or a > end: total += b - a; end = b
        elif b > end: total += b - end; end = b
    return total

# ---------------------------------------------------------------------------------------------------------
# the judge (pure)
# ---------------------------------------------------------------------------------------------------------
RX = {
    "wait": re.compile(r"\[sandbox\] waiting for a free sandbox \(.*\): (\d+) of (\d+) running on this host \((\d+) CPUs.*?; (\d+) waiting"),
    "free": re.compile(r"\[sandbox\] a sandbox came free \(.*\) after ([\d.]+) s"),
    "timeout": re.compile(r"\[sandbox\] no sandbox came free within ([\d.]+) s"),
    "full": re.compile(r"\[sandbox\] no free sandbox \("),
    "hang": re.compile(r"\[sandbox\] a sandbox stopped responding"),
    "retry": re.compile(r"\[sandbox\] a sandbox did not start within"),
    "gave_up": re.compile(r"No sandbox started within"),
    "mem_wait": re.compile(r"\[sandbox\] waiting for memory"),
    "mem_short": re.compile(r"\[sandbox\] still short of memory"),
    "boot_wait": re.compile(r"\[sandbox\] waiting for a sandbox \(.*\): (\d+) already starting, at most (\d+) at once"),
}

def _pct(values, q):
    v = sorted(values)
    if not v: return None
    i = min(len(v) - 1, max(0, int(round(q / 100 * (len(v) - 1)))))
    return v[i]

def measure(data, since, now, excluded):
    """The numbers THRESHOLDS judges, from what the server returned, outside `excluded`."""
    f = data["facts"]
    def num(k):
        try: return float(f.get(k) or "")
        except ValueError: return None
    vcpu = int(num("VCPU") or 0) or None; mem_kb = num("MEM_KB")
    m = {k: None for k in THRESHOLDS}
    waits, spans, counts = [], [], dict.fromkeys(("no_free", "hangs", "boot_retries", "gave_up", "mem_waits", "mem_short", "boot_waits", "queued"), 0)
    cap = cap_cpus = None; deepest = 0
    for ts, line in data["journal"]:
        if _inside(ts, excluded) or "[sandbox]" not in line and "No sandbox started" not in line: continue
        if (r := RX["wait"].search(line)):
            counts["queued"] += 1; cap, cap_cpus = int(r.group(2)), int(r.group(3)); deepest = max(deepest, int(r.group(4)))
        elif (r := RX["free"].search(line)):
            w = float(r.group(1)); waits.append(w); spans.append((ts - w, ts))
        elif (r := RX["timeout"].search(line)):
            w = float(r.group(1)); waits.append(w); spans.append((ts - w, ts)); counts["no_free"] += 1
        elif RX["full"].search(line): counts["no_free"] += 1
        elif RX["hang"].search(line): counts["hangs"] += 1
        elif RX["retry"].search(line): counts["boot_retries"] += 1
        elif RX["mem_wait"].search(line): counts["mem_waits"] += 1
        elif RX["mem_short"].search(line): counts["mem_short"] += 1
        elif RX["boot_wait"].search(line): counts["boot_waits"] += 1
        if RX["gave_up"].search(line): counts["gave_up"] += 1
    window = max(1.0, (now - since) - _merged_seconds([(max(a, since), min(b, now)) for a, b in excluded if b > since and a < now]))
    if len(waits) >= MIN_WAITS:
        m["wait_p90_s"] = round(_pct(waits, 90), 1)
        m["saturated_pct"] = round(100 * _merged_seconds(spans) / window, 1)
    days = max(1.0, window / 86400)
    per_day = lambda n: round(n / days, 1) if days > 1 else n
    for k in ("no_free", "hangs", "boot_retries", "gave_up", "mem_waits", "mem_short"): m[k] = per_day(counts[k])
    m["oom_kills"] = per_day(sum(1 for ts, line in data["oom"] if not _inside(ts, excluded) and "Killed process" in line))
    used = [w for t, w in data["vms"] if not _inside(t, excluded)]
    if len(used) >= MIN_VMS: m["kernel_warn_pct"] = round(100 * sum(used) / len(used), 1)
    def rows(key):
        out = []
        for r in data["sar"].get(key, []):
            t = r.get("timestamp"); iv = r.get("interval") or 600
            if isinstance(t, float) and since <= t <= now + 60 and not _overlaps(t - iv, t, excluded): out.append(r)
        return out
    if vcpu:
        load = [r["ldavg-15"] / vcpu for r in rows("load") if isinstance(r.get("ldavg-15"), float)]
        if load: m["load_per_cpu_p95"] = round(_pct(load, 95), 2)
    psi = [r["%scpu-300"] for r in rows("cpu_psi") if isinstance(r.get("%scpu-300"), float)]
    if psi: m["cpu_psi_p95"] = round(_pct(psi, 95), 1)
    psi = [r["%smem-300"] for r in rows("mem_psi") if isinstance(r.get("%smem-300"), float)]
    if psi: m["mem_psi_p95"] = round(_pct(psi, 95), 1)
    steal = [r["%steal"] for r in rows("cpu") if isinstance(r.get("%steal"), float) and r.get("CPU") in (-1.0, "-1", "all")]
    if steal: m["steal_p95"] = round(_pct(steal, 95), 1)
    if mem_kb:
        avail = [100 * r["kbavail"] / mem_kb for r in rows("mem") if isinstance(r.get("kbavail"), float)]
        now_avail = num("MEM_AVAILABLE_KB")
        if now_avail is not None: avail.append(100 * now_avail / mem_kb)
        if avail: m["mem_avail_min_pct"] = round(min(avail), 1)
    swap_total = num("SWAP_TOTAL_KB") or 0
    if swap_total > 0:
        used = [r["%swpused"] for r in rows("swap") if isinstance(r.get("%swpused"), float)]
        used.append(100 * (swap_total - (num("SWAP_FREE_KB") or 0)) / swap_total)
        m["swap_used_max_pct"] = round(max(used), 1)
    if num("DISK_USED_PCT") is not None: m["disk_used_pct"] = int(num("DISK_USED_PCT"))
    extra = {"waits": len(waits), "queued": counts["queued"], "boot_waits": counts["boot_waits"], "deepest_queue": deepest,
             "wait_max_s": round(max(waits), 1) if waits else None, "cap": cap, "cap_cpus": cap_cpus,
             "sandboxes_started": len(used), "kernel_warned": sum(used),
             "sar_rows": len(rows("load")), "window_h": round(window / 3600, 1)}
    return m, extra

def level_of(key, value):
    if value is None: return OK
    _, d, watch, bigger, _ = THRESHOLDS[key]
    worse = (lambda x, t: t is not None and (x >= t if d == ">=" else x <= t))
    return BIGGER if worse(value, bigger) else WATCH if worse(value, watch) else OK

def judge(m):
    """(verdict, [(key, value, level)], resources short). Pure."""
    rows = [(k, m.get(k), level_of(k, m.get(k))) for k in THRESHOLDS]
    verdict = max((lv for _, _, lv in rows), key=LEVELS.index, default=OK)
    short = sorted({THRESHOLDS[k][4] for k, _, lv in rows if lv == BIGGER})
    return verdict, rows, short

# ---------------------------------------------------------------------------------------------------------
# which plan, and what it gives
# ---------------------------------------------------------------------------------------------------------
def box_of(facts):
    def i(k):
        try: return int(float(facts.get(k) or ""))
        except ValueError: return None
    mem_kb, disk_kb = i("MEM_KB") or i("BOX_MEM_KB"), i("DISK_TOTAL_KB") or i("BOX_DISK_KB")
    b = {"vcpu": i("VCPU") or i("BOX_VCPU"), "mem_mb": mem_kb // 1024 if mem_kb else None,
         "disk_gb": round(disk_kb / 1048576) if disk_kb else None, "hostname": facts.get("HOSTNAME") or facts.get("BOX_HOSTNAME") or ""}
    b["plan"] = current_plan(b)
    return b

def current_plan(box):
    """The DigitalOcean plan this size matches, or None. The droplet's default name carries its slug; else by size."""
    ps = plans()
    for p in ps:
        if box.get("hostname") and re.search(rf"(^|-){re.escape(p['slug'])}(-|$)", box["hostname"]): return p
    if not (box.get("vcpu") and box.get("mem_mb")): return None
    fit = [p for p in ps if p["vcpu"] == box["vcpu"] and 0.85 <= box["mem_mb"] / 1024 / p["mem_gb"] <= 1.1
           and (not box.get("disk_gb") or 0.85 <= box["disk_gb"] / p["disk_gb"] <= 1.1)]
    return min(fit, key=lambda p: p["price"]) if fit else None

def choose(box, short):
    """(plan, resizable, cheaper plan that needs a new server or None). The cheapest plan with what is short doubled
    and nothing else smaller; dedicated CPUs when guests are starved (contention). DigitalOcean resizes a server only
    to a plan whose disk is at least its current disk, so the plan asked for is the cheapest one reachable that way;
    when none is, the cheapest at all comes back with resizable False (a new server and a move)."""
    cur = box.get("plan")
    vcpu, mem = box.get("vcpu") or 4, (cur["mem_gb"] if cur else round((box.get("mem_mb") or 8192) / 1024))
    disk = cur["disk_gb"] if cur else (box.get("disk_gb") or 0)
    dedicated = "contention" in short
    need_cpu = vcpu * 2 if ("cpu" in short or (dedicated and cur and cur["dedicated"])) else vcpu
    need_mem = mem * 2 if "memory" in short else mem
    need_disk = int(disk * 1.5) if "disk" in short else 0
    pick = [p for p in plans() if p["vcpu"] >= need_cpu and p["mem_gb"] >= need_mem and p["disk_gb"] >= need_disk
            and (p["dedicated"] or not dedicated) and (not cur or p["slug"] != cur["slug"]) and (not cur or p["price"] > cur["price"] or p["vcpu"] > cur["vcpu"])]
    if not pick: return None, False, None
    cheapest = min(pick, key=lambda p: (p["price"], -p["disk_gb"]))
    reach = [p for p in pick if p["disk_gb"] >= disk]
    if not reach: return cheapest, False, None
    best = min(reach, key=lambda p: (p["price"], -p["disk_gb"]))
    return best, True, (cheapest if cheapest["price"] < best["price"] else None)

def limits_for(app, S, vcpu, mem_gb, runner=subprocess.run):
    """What the mold's own guard would allow on a server of this size (scripts/sandbox-limits.mjs), else None."""
    script = os.path.join(ROOT, "molds", str(app.get("mold_id") or ""), "codebase", "scripts", "sandbox-limits.mjs")
    if not os.path.isfile(script): return None
    env = dict(os.environ, SANDBOX_CPUS=str(S["sandbox"].get("cpus", 2)), SANDBOX_MEMORY_MIB=str(S["sandbox"].get("memory_mib", 1024)))
    env.pop("SANDBOX_MAX_RUNNING", None)
    try:
        r = runner(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, "--cpus", str(vcpu),
                    "--memory-mib", str(int(mem_gb * 1024 * 0.97))], capture_output=True, text=True, timeout=60, env=env)
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else None
    except (OSError, ValueError, subprocess.TimeoutExpired, IndexError): return None

def cap_for(app, S, vcpu, mem_gb, runner=subprocess.run):
    got = limits_for(app, S, vcpu, mem_gb, runner)
    if got and isinstance(got.get("maxRunning"), int): return got["maxRunning"]
    return max(1, vcpu // max(1, int(S["sandbox"].get("cpus", 2))))     # the CPU rule alone (a mold without the script)

# ---------------------------------------------------------------------------------------------------------
# what the operator reads
# ---------------------------------------------------------------------------------------------------------
WHY = {
    "cpu": "people are waiting in line for the agent's work areas (sandboxes) because the server runs only {cap} at a time",
    "contention": "the server's processors are shared and overloaded, so agent work areas (sandboxes) freeze and have to be restarted",
    "memory": "the server is running out of memory",
    "disk": "the server's disk is nearly full",
}

def why_sentence(short, cap):
    parts = [WHY[r].format(cap=cap or "a few") for r in ("cpu", "contention", "memory", "disk") if r in short]
    if not parts: return ""
    s = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return s[0].upper() + s[1:] + "."

def request_text(S, box, plan, resizable, short, cap_now, cap_new):
    cur = box.get("plan")
    name = box.get("hostname") or "the app's server"
    now_price = f" (today it is ${cur['price']} a month)" if cur else ""
    why = why_sentence(short, cap_now)
    if not resizable:
        return (f"I need your go-ahead to move the app to a bigger server, because {why[0].lower() + why[1:]}\n\n"
                f"The size that fits is {plan_label(plan)}{now_price}. DigitalOcean cannot simply resize this server to it, because that "
                f"plan's disk ({plan['disk_gb']} GB) is smaller than this server's ({cur['disk_gb'] if cur else box.get('disk_gb')} GB), so it "
                f"means a new server and moving the app and its data across. That is a longer job I would plan with you first.\n\n"
                f"If you would like that, write this in the chat:\n\n```\nplan a move\n```\n\n"
                f"Nothing changes until you say so; the app keeps running as it is meanwhile.")
    option = "Disk, CPU and RAM" if "disk" in short else "CPU and RAM only"
    keep = ("This option makes the disk bigger for good, so the server cannot go back to a smaller size later."
            if option.startswith("Disk") else "\"CPU and RAM only\" keeps the disk as it is, so the server can go back to the smaller size later if you want.")
    gain = f" It runs {cap_new} sandboxes at once instead of {cap_now}." if cap_new and cap_now and cap_new != cap_now else ""
    return "\n".join([
        f"I need you to move the app's server to a bigger size on DigitalOcean. {why}",
        "",
        f"The size: {plan_label(plan)}{now_price}.{gain}",
        "It takes about 10 minutes, and the app is offline for about 5 of them, so pick a quiet moment.",
        "",
        "1. Open https://cloud.digitalocean.com/droplets and sign in.",
        f"2. Click the server named `{name}` (its address is {S['host']}).",
        "3. At the top right, click the switch that says \"ON\", then click \"Turn off\" to confirm. Wait until the switch says \"OFF\" (about a minute).",
        "4. In the menu on the left, click \"Resize\".",
        f"5. Choose \"{option}\".",
        f"6. Under the plans, click \"{plan['family']}\"" + (f", then \"{plan['kind']}\"" if plan["kind"] else "") +
        f", then click the box that shows {plan['vcpu']} CPUs, {plan['mem_gb']} GB memory, {plan['disk_gb']} GB disk and ${plan['price']}/mo.",
        "7. Click the \"Resize Droplet\" button at the bottom and wait until it finishes (a few minutes).",
        "8. Click the switch at the top right again so it says \"ON\".",
        "9. Write this in the chat:",
        "",
        "```",
        "resized",
        "```",
        "",
        f"What happens next: the factory redeploys the app (python3 .claude/scripts/provision.py {S['app_id']} --deploy-remote, about "
        f"15 minutes; the app is offline again for part of it). It reads the new size by itself and sets every limit from it; nothing is edited by hand.",
        f"Nothing on the server is erased: the files, the database and every chat stay. {keep} DigitalOcean bills the new price from the resize on.",
    ])

# ---------------------------------------------------------------------------------------------------------
# the factory task: one per app, filed once and refreshed after
# ---------------------------------------------------------------------------------------------------------
def task_marker(app_id): return f"[capacity:{app_id}]"

def open_capacity_task(mold_id, app_id, tasks_dir=None):
    p = os.path.join(tasks_dir or os.path.join(ROOT, "state", "tasks"), f"{mold_id}.jsonl")
    if not os.path.isfile(p): return None
    for line in open(p):
        if not line.strip(): continue
        t = json.loads(line)
        if t.get("status") in ("todo", "in_progress", "blocked") and (t.get("detail") or "").startswith(task_marker(app_id)): return t
    return None

def file_task(app, title, detail, run=None, tasks_dir=None, say=print):
    """factory.py add (the first time) or factory.py set (every time after) on the one open capacity task."""
    run = run or (lambda *a: subprocess.run([sys.executable, os.path.join(SCRIPTS, "factory.py"), *a], capture_output=True, text=True, cwd=ROOT))
    mold, app_id = app["mold_id"], app["app_id"]
    t = open_capacity_task(mold, app_id, tasks_dir)
    if t:
        tid = t["task_id"]; verb = "refreshed"
    else:
        r = run("add", mold, title, "--type", "infra", "--pri", "2", "--owner", "fable")
        tid = (r.stdout or "").strip().splitlines()[-1] if r.returncode == 0 and (r.stdout or "").strip() else None
        if not tid: say(f"  the factory task could not be filed: {(r.stderr or r.stdout or '').strip()[-200:]}"); return None
        verb = "filed"
    for k, v in (("title", title), ("detail", detail)):
        r = run("set", tid, k, v)
        if r.returncode: say(f"  the factory task {tid} could not be updated: {(r.stderr or r.stdout or '').strip()[-200:]}"); return None
    say(f"  factory task {verb}: {tid}")
    return tid

# ---------------------------------------------------------------------------------------------------------
# the command
# ---------------------------------------------------------------------------------------------------------
def _fmt(v):
    if v is None: return "-"
    return f"{v:g}" if isinstance(v, float) else str(v)

def report(S, app, infra, data, since, now, run_task=None, tasks_dir=None, limits_runner=subprocess.run, file=True, say=print):
    """Print the verdict (and the request when it is due). Returns (verdict, request text or None, task id or None)."""
    unit = S["unit"]
    windows = deploy_windows(data["journal"], unit, now) + load_check_windows(infra)
    m, extra = measure(data, since, now, windows)
    verdict, rows, short = judge(m)
    box = box_of(data["facts"])
    cur = box["plan"]
    cap_now = extra["cap"] or cap_for(app, S, box["vcpu"] or 4, (cur or {}).get("mem_gb") or round((box["mem_mb"] or 8192) / 1024), limits_runner)
    stamp = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    say(f"{S['app_id']} capacity, {stamp(since)} to {stamp(now)}, server {S['host']}")
    say(f"  box: {box['vcpu']} CPUs, {round((box['mem_mb'] or 0) / 1024, 1)} GiB memory, {box['disk_gb']} GiB disk"
        + (f" = DigitalOcean {plan_label(cur)}" if cur else " (plan not recognised)") + f"; sandboxes at once: {cap_now}")
    say(f"  left out: {len(deploy_windows(data['journal'], unit, now))} deploy/restart window(s), {len(load_check_windows(infra))} recorded load check(s); "
        f"judged {extra['window_h']} h; {extra['sar_rows']} sysstat sample(s)"
        + ("" if data["facts"].get("SYSSTAT") == "yes" else " (sysstat is not installed: history is missing, only now is judged)"))
    say(f"  sandbox line: {extra['queued']} call(s) waited for a free sandbox (longest {_fmt(extra['wait_max_s'])} s, up to "
        f"{extra['deepest_queue']} in line at once), {extra['boot_waits']} waited for a boot slot, {extra['sandboxes_started']} sandbox VM(s) used "
        f"({extra['kernel_warned']} with a guest kernel warning)")
    for k, v, lv in rows:
        what, d, w, b, _ = THRESHOLDS[k]
        say(f"  {lv.upper() if lv != OK else 'ok':18} {_fmt(v):>7}  {what} (watch {d} {w:g}" + (f", bigger box {d} {b:g})" if b is not None else ", never more than watch)"))
    if extra["waits"] < MIN_WAITS:
        say(f"  (time in line is judged from {MIN_WAITS} waits up; there were {extra['waits']})")
    say(f"verdict: {verdict.upper()}")
    if verdict != BIGGER:
        t = open_capacity_task(app["mold_id"], S["app_id"], tasks_dir)
        if t: say(f"  an open capacity task is still on file: {t['task_id']} (close it once the bigger server is deployed)")
        return verdict, None, None
    plan, resizable, cheaper = choose(box, short)
    if not plan:
        say("  no larger DigitalOcean plan in the factory's list fits; this needs a different kind of server. File it by hand.")
        return verdict, None, None
    cap_new = cap_for(app, S, plan["vcpu"], plan["mem_gb"], limits_runner)
    text = request_text(S, box, plan, resizable, short, cap_now, cap_new)
    say("\n--- the request for the operator ---\n" + text + "\n---")
    tid = None
    if file:
        signals = "; ".join(f"{k}={_fmt(v)}" for k, v, lv in rows if lv != OK)
        title = (f"Capacity: {S['app_id']} needs a bigger server: {plan['family']} {plan['vcpu']}/{plan['mem_gb']} "
                 f"${plan['price']}/mo{' (a new server: not reachable by resize)' if not resizable else ''}")
        detail = (f"{task_marker(S['app_id'])} {stamp(now)}: provision.py {S['app_id']} --capacity says NEEDS A BIGGER BOX "
                  f"({', '.join(short)}). Box {box['vcpu']} CPUs/{box['mem_mb']} MiB" + (f" ({cur['slug']}, ${cur['price']}/mo)" if cur else "") +
                  f", {cap_now} sandbox(es) at once. Signals: {signals}. Ask: {plan['slug']} ({plan_label(plan)}), {cap_new} at once. "
                  + (f"A cheaper fit, {cheaper['slug']} ({plan_label(cheaper)}), needs a new server (its disk is smaller than this one's). " if cheaper else "") + f"After the operator resizes: provision.py {S['app_id']} --deploy-remote, then --capacity again; close this with that output.")
        tid = file_task({"mold_id": app["mold_id"], "app_id": S["app_id"]}, title, detail, run=run_task, tasks_dir=tasks_dir, say=say)
    return verdict, text, tid

def capacity_remote(S, app, infra, a, runner=None, clock=time.time, say=print):
    """`provision.py <app> --capacity [--hours N] [--no-task] [--dry-run]`."""
    runner = runner or V.real_runner
    hours = V._opt(a, "--hours", str(DEFAULT_HOURS))
    if not hours.isdigit() or not 1 <= int(hours) <= MAX_HOURS:
        raise V.Stop(f"--hours must be a whole number from 1 to {MAX_HOURS}, not {hours!r}. Nothing was contacted.")
    now = clock(); since = int(now - int(hours) * 3600)
    if "--dry-run" in a:
        say(f"DRY RUN for {S['app_id']}: nothing below was run and nothing was contacted.")
        say("    $ " + V.shown_cmd(S, V.ssh_argv(S, f"{S['sudo']}bash -c <read, for the last {hours} h: the sandbox guard's lines, deploys, "
                                                  f"out-of-memory kills, sysstat history, each sandbox's guest kernel log, CPUs, memory, swap, disk>", shown=True)))
        return 0
    if not S["host"]: raise V.Stop(f"{S['app_id']}: the server address is not in state yet, so there is nothing to look at. Nothing was contacted.")
    if not os.path.isfile(V.key_path(S)): raise V.Stop(f"{S['app_id']}: there is no SSH key named {S['key_ref']} on this VM ({V.key_shown(S)}). Nothing was contacted.")
    r = runner({"id": "capacity", "argv": probe_argv(S, since), "timeout": 300})
    if r.returncode or not (r.stdout or "").strip():
        say(f"{S['app_id']}: the server could not be read: " + V.redact(((r.stderr or "").strip().splitlines() or ["no answer"])[-1])[:300]); return 2
    data = parse(r.stdout)
    try: now = float(data["facts"].get("NOW") or now)
    except ValueError: pass
    verdict, _, _ = report(S, app, infra, data, since, now, file="--no-task" not in a, say=say)
    return 1 if verdict == BIGGER else 0

def record_load_check(infra, started, finished):
    """Append one --sandbox-load window to vm_remote.load_checks (the last LOAD_CHECKS_KEPT)."""
    iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat(timespec="seconds")
    vr = infra.setdefault("vm_remote", {})
    vr["load_checks"] = ((vr.get("load_checks") or []) + [{"from": iso(started), "to": iso(finished)}])[-LOAD_CHECKS_KEPT:]
    return vr["load_checks"]

if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]:
        import vm_capacity_selftest
        sys.exit(vm_capacity_selftest.run())
    sys.exit(__doc__)
