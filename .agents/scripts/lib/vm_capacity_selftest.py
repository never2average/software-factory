#!/usr/bin/env python3
"""Offline self-test of lib/vm_capacity.py (mold_v1-195), and of the parts of vm_remote.py that make every limit follow
the server's size (Postgres' settings, the box record). Run it as:

  python3 .claude/scripts/lib/vm_capacity.py --self-test      (also run by vm_remote.py --self-test)

Nothing here contacts a server or changes this machine: the server's answer is a recorded fixture (a real read of the
first self-hosted server, fixtures/vm_capacity/), the SSH runner and the factory task CLI are stand-ins, and files are
written only under a temp directory that is removed afterwards.
"""
import contextlib, io, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
for p in (HERE, SCRIPTS):
    if p not in sys.path: sys.path.insert(0, p)
import vm_remote as V
import vm_capacity as C

FIX = os.path.join(SCRIPTS, "fixtures", "vm_capacity", "probe-2026-10-06.txt")
CP = subprocess.CompletedProcess

def _S():
    docs = {n: json.load(open(os.path.join(V.FIXTURE, f"{n}.json"))) for n in ("application", "infrastructure", "datastores")}
    docs["infrastructure"]["vm_remote"].update(host="203.0.113.9", domain="app.example.test")
    S = V.settings("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"])
    return S, docs["application"], docs["infrastructure"]

def _limits(cap):
    """A stand-in for `node scripts/sandbox-limits.mjs --cpus N ...`: the mold's rule, CPUs / 2."""
    def run(argv, **k):
        cpus = int(argv[argv.index("--cpus") + 1])
        return CP(argv, 0, json.dumps({"maxRunning": cap if cap else cpus // 2}) + "\n", "")
    return run

def _quiet(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): r = fn(*a, say=lambda s: buf.write(s + "\n"), **k)
    return r, buf.getvalue()

def _data(facts=None, journal=(), oom=(), vms=(), sar=None):
    f = {"NOW": "1000000", "VCPU": "4", "MEM_KB": "8131776", "MEM_AVAILABLE_KB": "6000000", "SWAP_TOTAL_KB": "0", "SWAP_FREE_KB": "0",
         "DISK_USED_PCT": "40", "DISK_TOTAL_KB": "161421296", "HOSTNAME": "ubuntu-s-4vcpu-8gb-nyc1", "SYSSTAT": "yes"}
    f.update(facts or {})
    return {"facts": f, "sar": sar or {}, "journal": list(journal), "oom": list(oom), "vms": list(vms)}

def _queue(now, n, wait_s, step=600):
    """`n` calls that each waited `wait_s` seconds in line, spread over the day before `now`."""
    out = []
    for i in range(n):
        t = now - 80000 + i * step
        out.append((t - wait_s, f"node[1]: [sandbox] waiting for a free sandbox (…k): 2 of 2 running on this host (4 CPUs, 2 per sandbox); 3 waiting"))
        out.append((t, f"node[1]: [sandbox] a sandbox came free (…k) after {wait_s:.1f} s"))
    return out

def checks(check, tmp):
    S, app, infra = _S()
    # ---- the thresholds are one table, and coherent ----
    for k, (what, d, w, b, res) in C.THRESHOLDS.items():
        check(f"threshold {k} reads in words, says which way is worse and which resource it points at",
              what and d in (">=", "<=") and res in ("cpu", "contention", "memory", "disk") and isinstance(w, (int, float)))
        if b is not None:
            check(f"threshold {k}: 'bigger box' is past 'watch'", (b >= w) if d == ">=" else (b <= w), (w, b))
    check("the guest kernel warning alone never asks for a bigger box", C.THRESHOLDS["kernel_warn_pct"][3] is None)
    check("every plan in the table has a price and a disk", all(p["price"] > 0 and p["disk_gb"] > 0 for p in C.plans()))
    check("the price table is dated and its source named", re.fullmatch(r"\d{4}-\d{2}-\d{2}", C.PRICES_CHECKED) and C.PRICES_SOURCE.startswith("https://"))
    check("every price reaches the operator as 'about'", "about $" in C.plan_label(C.plans()[0]))
    fake = {"droplets": {"basic": {"regular": [{"slug": p["slug"], "cpus": p["vcpu"], "memory": p["mem_gb"], "disk": {"boot": p["disk_gb"]},
                                                "price": {"monthly": p["price"] + (16 if p["slug"] == "s-8vcpu-16gb" else 0)}} for p in C.plans()]}}}
    said = []
    check("--check-prices names a row whose price moved", C.check_prices(fetch=lambda url: fake, say=said.append) == 1
          and any("DIFFERS s-8vcpu-16gb" in l for l in said), said)

    # ---- the read is read-only and well-formed ----
    sh = C.probe_sh(S, 999000)
    r = subprocess.run(["bash", "-n"], input=sh, capture_output=True, text=True)
    check("the capacity probe is valid bash", r.returncode == 0, r.stderr)
    stripped = sh.replace(">/dev/null", "").replace("2>&1", "").replace(">=", "")
    check("the capacity probe writes nowhere (no redirection to a file)", ">" not in stripped, [l for l in stripped.splitlines() if ">" in l][:3])
    check("...and changes nothing (no stop, restart, rm, kill, install, sed -i)",
          not re.search(r"\b(systemctl (stop|start|restart)|rm |kill |pkill|apt-get|sed -i|msb (remove|stop))", sh))
    check("...and reads the guard's own lines, the deploys, OOM kills, sysstat history and each sandbox's kernel log",
          all(x in sh for x in ("\\[sandbox\\] ", "(Stopping|Started)", "Out of memory", "sadf -d -U", "BUG: scheduling while atomic", "/proc/pressure")))

    # ---- the real server, 2026-10-06: parsed and judged ----
    data = C.parse(open(FIX).read())
    now = float(data["facts"]["NOW"]); since = now - 86400
    check("the recorded read parses: facts, six sysstat activities, journal lines, sandboxes",
          data["facts"].get("VCPU") == "4" and set(data["sar"]) == {"load", "cpu_psi", "mem_psi", "mem", "swap", "cpu"}
          and len(data["journal"]) > 1000 and len(data["vms"]) > 100, (data["facts"], sorted(data["sar"]), len(data["journal"]), len(data["vms"])))
    unit = "sf-onfinance-hfc-vm"
    dw = C.deploy_windows(data["journal"], unit, now)
    check("each deploy (the API stopped until it started again) becomes a window left out", len(dw) == 6 and all(b > a for a, b in dw), dw)
    m, extra = C.measure(data, since, now, dw)
    verdict, rows, short = C.judge(m)
    check("the first server's day judges WATCH, not a bigger box (load checks filled the sandbox line; nothing was refused)",
          verdict == C.WATCH and short == [], (verdict, short, m))
    check("  ...time in line p90 90.1 s over 269 waits, longest 138.9 s, 11 in line at once",
          m["wait_p90_s"] == 90.1 and extra["queued"] == 269 and extra["wait_max_s"] == 138.9 and extra["deepest_queue"] == 11, (m["wait_p90_s"], extra))
    check("  ...one watchdog hang, three boot retries, no 'Waiting for a free sandbox' answer", (m["hangs"], m["boot_retries"], m["no_free"]) == (1, 3, 0), m)
    check("  ...11.2% of 160 sandboxes logged the guest kernel warning", m["kernel_warn_pct"] == 11.2 and extra["sandboxes_started"] == 160, (m["kernel_warn_pct"], extra))
    check("  ...memory never below 73% available, no swap, no OOM kill, disk 55%",
          m["mem_avail_min_pct"] == 73.6 and m["swap_used_max_pct"] is None and m["oom_kills"] == 0 and m["disk_used_pct"] == 55, m)
    check("  ...load and CPU pressure low (p95 0.49 per CPU, 2.2%), steal 2.3%", (m["load_per_cpu_p95"], m["cpu_psi_p95"], m["steal_p95"]) == (0.49, 2.2, 2.3), m)
    box = C.box_of(data["facts"])
    check("the box is recognised as DigitalOcean Basic 4/8 ($48) by its name", box["plan"] and box["plan"]["slug"] == "s-4vcpu-8gb" and box["vcpu"] == 4, box)
    check("...and by its size alone when renamed", (C.current_plan(dict(box, hostname="hfc")) or {}).get("slug") == "s-4vcpu-8gb")
    S2 = dict(S, unit=unit)
    (verdict2, text, tid), out = _quiet(C.report, S2, app, infra, data, since, now, run_task=lambda *a: (_ for _ in ()).throw(AssertionError("no task on watch")),
                                        tasks_dir=tmp, limits_runner=_limits(2))
    check("the report on that day prints WATCH, the box and its 2 sandboxes, and asks the operator nothing",
          verdict2 == C.WATCH and text is None and tid is None and "verdict: WATCH" in out and "sandboxes at once: 2" in out
          and "Basic 4 vCPUs / 8 GB memory / 160 GB disk (about $48 a month)" in out, out[-1500:])

    # ---- windows left out ----
    now = 1_000_000.0; since = now - 86400
    hang = (now - 5000, "node[1]: [sandbox] a sandbox stopped responding (…k): no answer for 60 s during a command; stopping it")
    j = [(now - 6000, f"systemd[1]: Stopping {S['unit']}-api.service..."), hang, (now - 4000, f"systemd[1]: Started {S['unit']}-api.service.")] + [hang] * 0
    m, _ = C.measure(_data(journal=j), since, now, C.deploy_windows(j, S["unit"], now))
    check("a hang during a deploy is not counted", m["hangs"] == 0, m)
    m, _ = C.measure(_data(journal=[hang]), since, now, [])
    check("...the same hang outside one is", m["hangs"] == 1, m)
    inf = json.loads(json.dumps(infra))
    for i in range(25): C.record_load_check(inf, now - 3000 - i, now - 2000 - i)
    check("a load check's window is recorded in state, the last 20 kept", len(inf["vm_remote"]["load_checks"]) == 20)
    lw = C.load_check_windows({"vm_remote": {"load_checks": [{"from": "1970-01-12T13:00:00+00:00", "to": "1970-01-12T13:10:00+00:00"}]}})
    q = _queue(now, 10, 200.0)
    inside = [(lw[0][0] + 30 + i, l) for i, (_, l) in enumerate(q)]
    m, _ = C.measure(_data(journal=inside), since, now, lw)
    check("calls that queued during a recorded load check are not counted", m["wait_p90_s"] is None and m["no_free"] == 0, m)
    import factory as F
    schema = json.load(open(os.path.join(ROOT, "state", "application", "app_id", "infrastructure.schema.json")))
    vr_schema = schema["properties"]["vm_remote"]
    errs = F._check(inf["vm_remote"], vr_schema, "vm_remote", schema)
    check("the recorded windows validate against the schema", not errs, errs)

    # ---- a server short of sandboxes: one plan, its price, the clicks, one task ----
    d = _data(journal=_queue(now, 40, 150.0, step=1800))
    m, extra = C.measure(d, since, now, [])
    v, rows, short = C.judge(m)
    check("forty calls a day waiting 150 s each: needs a bigger box, for CPUs", v == C.BIGGER and short == ["cpu"], (v, short, m))
    plan, resizable, cheaper = C.choose(C.box_of(d["facts"]), short)
    check("...Basic 8 vCPUs / 16 GB at $96 a month, reachable by a resize", plan["slug"] == "s-8vcpu-16gb" and plan["price"] == 96 and resizable and cheaper is None, plan)
    calls, tasks = [], os.path.join(tmp, "tasks"); os.makedirs(tasks, exist_ok=True)
    tfile = os.path.join(tasks, f"{app['mold_id']}.jsonl")
    open(tfile, "w").write(json.dumps({"task_id": f"{app['mold_id']}-007", "status": "todo", "title": "something else"}) + "\n")
    def fake_factory(*a):
        calls.append(a)
        if a[0] == "add":
            open(tfile, "a").write(json.dumps({"task_id": f"{app['mold_id']}-008", "status": "todo", "title": a[2], "detail": ""}) + "\n")
            return CP(a, 0, f"{app['mold_id']}-008\n", "")
        if a[0] == "set":
            rows_ = [json.loads(l) for l in open(tfile) if l.strip()]
            for t in rows_:
                if t["task_id"] == a[1]: t[a[2]] = a[3]
            open(tfile, "w").write("".join(json.dumps(t) + "\n" for t in rows_))
            return CP(a, 0, "", "")
        return CP(a, 1, "", "unexpected")
    (v, text, tid), out = _quiet(C.report, S, app, infra, d, since, now, run_task=fake_factory, tasks_dir=tasks, limits_runner=_limits(None))
    check("the report asks the operator, and files one task", v == C.BIGGER and text and tid == f"{app['mold_id']}-008"
          and [c[0] for c in calls] == ["add", "set", "set"], (v, tid, calls))
    check("  ...the request names the plan, its monthly price, today's price and what it gives",
          "Basic 8 vCPUs / 16 GB memory / 320 GB disk (about $96 a month)" in text and "today it is $48 a month" in text
          and "The Resize page shows the exact price before you confirm" in text
          and "runs 4 sandboxes at once instead of 2" in text, text)
    check("  ...says why in one sentence, then numbered clicks from the web address, one action each",
          "waiting in line" in text and "1. Open https://cloud.digitalocean.com/droplets" in text
          and all(f"\n{i}. " in text for i in range(2, 10)) and "\"Resize\"" in text and "\"CPU and RAM only\"" in text, text)
    check("  ...names the server by its name and address", "`ubuntu-s-4vcpu-8gb-nyc1`" in text and S["host"] in text)
    check("  ...puts what they paste on its own line in a code block, says how long and what happens next, and why it is safe",
          "```\nresized\n```" in text and "about 10 minutes" in text and "redeploys" in text and "--deploy-remote" in text
          and "Nothing on the server is erased" in text, text)
    check("  ...without engineer words the operator would not know", not re.search(r"\b(env|devtools|localStorage|origin|vCPU contention|nproc|SANDBOX_)\b", text), text)
    calls.clear()
    (v, text, tid), out = _quiet(C.report, S, app, infra, d, since, now, run_task=fake_factory, tasks_dir=tasks, limits_runner=_limits(None))
    check("a second run refreshes the same task instead of filing another", tid == f"{app['mold_id']}-008" and [c[0] for c in calls] == ["set", "set"]
          and "refreshed" in out, (calls, out[-300:]))
    t = C.open_capacity_task(app["mold_id"], S["app_id"], tasks)
    check("  ...the task carries the marker, the signals, the plan and the next step", t and t["detail"].startswith(f"[capacity:{S['app_id']}]")
          and "s-8vcpu-16gb" in t["detail"] and "--deploy-remote" in t["detail"] and t["title"].startswith(f"Capacity: {S['app_id']} needs a bigger server"), t)
    (v, text, tid), out = _quiet(C.report, S, app, infra, _data(), since, now, run_task=fake_factory, tasks_dir=tasks, limits_runner=_limits(None))
    check("a quiet day says ok and points at the capacity task still open", v == C.OK and tid is None and "-008" in out, out[-300:])
    calls.clear()
    (v, text, tid), out = _quiet(C.report, S, app, infra, d, since, now, run_task=fake_factory, tasks_dir=tasks, limits_runner=_limits(None), file=False)
    check("--no-task prints the request and leaves the tasks alone", v == C.BIGGER and text and not calls)

    # ---- which plan for which shortage ----
    b48 = C.box_of(_data()["facts"])
    pick = lambda short, box=b48: C.choose(box, short)
    p, ok, cheaper = pick(["contention"])
    check("guests starved on shared CPUs: dedicated CPUs reachable by a resize (CPU-Optimized 8/16, 200 GB, $188)",
          p["slug"] == "c2-8vcpu-16gb" and ok and p["dedicated"], p)
    check("  ...and the cheaper dedicated plan with a smaller disk is named in the task, not asked for (CPU-Optimized 4/8 about $84, 50 GB disk)",
          cheaper and cheaper["slug"] == "c-4" and cheaper["price"] == 84, cheaper)
    p, ok, _ = pick(["memory"])
    check("short of memory: Basic 8/16 ($96)", p["slug"] == "s-8vcpu-16gb" and ok, p)
    p, ok, _ = pick(["disk"])
    check("short of disk: a plan with half again the disk", p["disk_gb"] >= 240 and ok, p)
    d_disk = _data(facts={"DISK_USED_PCT": "93"})
    (v, text, _), _o = _quiet(C.report, S, app, infra, d_disk, since, now, run_task=fake_factory, tasks_dir=tasks, limits_runner=_limits(None), file=False)
    check("  ...and the request chooses \"Disk, CPU and RAM\" and says it cannot be undone", v == C.BIGGER and "\"Disk, CPU and RAM\"" in text and "for good" in text, text)
    big = {"vcpu": 4, "mem_mb": 7941, "disk_gb": 900, "hostname": "box", "plan": None}
    p, ok, _ = pick(["cpu"], big)
    check("a server whose disk no larger plan matches: the plan comes back as a new server, not a resize", p and not ok, p)
    text = C.request_text(S, big, p, ok, ["cpu"], 2, 4)
    check("  ...and the request asks for a go-ahead to plan a move, changing nothing meanwhile", "plan a move" in text and "Nothing changes until you say so" in text, text)
    p, ok, _ = pick(["cpu"], {"vcpu": 8, "mem_mb": 15990, "disk_gb": 309, "hostname": "", "plan": C.current_plan({"vcpu": 8, "mem_mb": 15990, "disk_gb": 309, "hostname": ""})})
    check("from Basic 8/16, more CPUs: 16 vCPUs on a plan with at least its 320 GB disk", p["vcpu"] >= 16 and p["disk_gb"] >= 320 and ok, p)

    # ---- the command: dry run, bad hours, an unreadable server ----
    r, out = _quiet(C.capacity_remote, S, app, infra, ["--capacity", "--dry-run"], runner=lambda *a: (_ for _ in ()).throw(AssertionError("contacted")))
    check("--capacity --dry-run prints the one SSH read and contacts nothing", r == 0 and "nothing was contacted" in out and "ssh " in out, out)
    try: C.capacity_remote(S, app, infra, ["--capacity", "--hours", "0"]); bad = False
    except V.Stop as e: bad = "--hours" in str(e)
    check("--hours outside 1..168 is refused before anything is contacted", bad)
    keyed = dict(S, key_ref="vm_capacity_selftest_key")
    real_key = V.key_path
    try:
        V.key_path = lambda S_: FIX                 # any file that exists: the stand-in runner never uses it
        r, out = _quiet(C.capacity_remote, keyed, app, infra, ["--capacity", "--no-task"], runner=lambda st, *_: CP(st["argv"], 255, "", "ssh: connect to host 203.0.113.9 port 22: Connection timed out"))
        check("an unreadable server is exit 2 with the reason, and no verdict", r == 2 and "could not be read" in out and "verdict" not in out, out)
        r, out = _quiet(C.capacity_remote, dict(keyed, unit=unit), app, infra, ["--capacity", "--no-task"], runner=lambda st, *_: CP(st["argv"], 0, open(FIX).read(), ""),
                        clock=lambda: float(C.parse(open(FIX).read())["facts"]["NOW"]))
        check("the recorded read through the command: exit 0 (watch)", r == 0 and "verdict: WATCH" in out, out[-600:])
    finally:
        V.key_path = real_key

    # ---- vm_remote: Postgres sized from the server, the box recorded ----
    conf = os.path.join(tmp, "size.conf")
    for kb, cpus in ((8131776, 4), (16373760, 8), (32767000, 16), (2000000, 1)):
        r = subprocess.run(["bash", "-c", V.pg_sizing_sh(conf, mem_kb_cmd=f"echo {kb}", cpus_cmd=f"echo {cpus}")], capture_output=True, text=True)
        got = dict(l.split(" = ") for l in open(conf).read().splitlines() if l and not l.startswith("#"))
        check(f"postgres.sh sizes Postgres for {cpus} CPUs / {kb // 1024} MiB exactly as pg_sizing says", r.returncode == 0 and got == V.pg_sizing(kb // 1024, cpus), (got, r.stderr))
    check("an 8 GB server gets shared_buffers 496MB, a 16 GB one 999MB (it grows with the server)",
          V.pg_sizing(7941, 4)["shared_buffers"] == "496MB" and V.pg_sizing(15990, 8)["shared_buffers"] == "999MB")
    pg = V.postgres_sh(S)
    check("postgres.sh writes the size file before it restarts Postgres", "software-factory-size.conf" in pg and pg.index("software-factory-size.conf") < pg.index("systemctl restart postgresql"))
    hs = V.health_sh(S, V.read_crons(S["mold_src"]))
    check("health.sh reads the box and asks the mold's own script for its limits, as the agent's user", "BOX_VCPU=" in hs and "sandbox-limits.mjs" in hs and "--user sfapp" in hs)
    facts = {"BOX_VCPU": "4", "BOX_MEM_KB": "8131776", "BOX_DISK_KB": "161421296", "BOX_HOSTNAME": "ubuntu-s-4vcpu-8gb-nyc1",
             "SANDBOX_LIMITS": json.dumps({"hostCpus": 4, "hostMemoryMiB": 7941, "maxRunning": 2, "maxRunningFrom": "host", "maxStarting": 2, "memoryHeadroomMiB": 512, "hostReservedMiB": 2048}),
             "PG_SHARED_BUFFERS": "496MB", "PG_WORK_MEM": "7MB"}
    b = V.box_record(facts)
    check("the deploy records the box it saw: size, plan, sandbox limits and where the cap came from, Postgres",
          b == {"vcpu": 4, "mem_mb": 7941, "disk_gb": 154, "hostname": "ubuntu-s-4vcpu-8gb-nyc1", "plan": "s-4vcpu-8gb", "sandbox_max_running": 2,
                "sandbox_boot_slots": 2, "sandbox_memory_headroom_mib": 512, "host_reserved_mib": 2048, "sandbox_max_running_from": "host",
                "pg_shared_buffers": "496MB", "pg_work_mem": "7MB"}, b)
    vr = json.loads(json.dumps(infra["vm_remote"])); vr["health"] = {"box": b}
    errs = F._check(vr, vr_schema, "vm_remote", schema)
    check("  ...and it validates against the schema", not errs, errs)
    check("a mold without the script still records the size", V.box_record(dict(facts, SANDBOX_LIMITS="absent")).get("vcpu") == 4 and "sandbox_max_running" not in V.box_record(dict(facts, SANDBOX_LIMITS="absent")))
    check("an older health read (no box lines) records no box", V.box_record({"KVM": "present"}) is None)

def run():
    fails, n = [], [0]
    def check(name, cond, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{name}{': ' + str(detail)[:600] if detail != '' else ''}")
    tmp = tempfile.mkdtemp(prefix="vm-capacity-selftest-")
    try: checks(check, tmp)
    finally: shutil.rmtree(tmp, ignore_errors=True)
    if fails:
        print("vm_capacity self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"vm_capacity self-test ok: {n[0]} checks (thresholds, a read-only probe, the first server's recorded day judged, deploy and "
          f"load-check windows left out, plan choice per shortage, the operator's request, one factory task filed then refreshed, "
          f"Postgres sized from the server, the box record); offline, nothing contacted")
    return 0

if __name__ == "__main__": sys.exit(run())
