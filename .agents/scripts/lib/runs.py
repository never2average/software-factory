"""Locks, background runs and their status, one per application and step (deploy, lanes).

  lock      <runs>/<app_id>/<step>.lock, held with flock for as long as the run lives. A second start gets exit 4 and
            who holds it (pid, since when, the command) plus the status command. The kernel drops the lock the moment
            its holder dies, so a lock left by a dead process is free: the next start takes it over and says so.
  record    <runs>/<app_id>/<step>/<stamp>-<pid>.json: the command, pid, start time, log path and, at the end, the
            result (the same JSON shape every --json run prints; lib/agent_result.py). Every locked run writes one,
            in the foreground too, so `status` can always say how the last run went.
  status    the latest record: still running (pid alive and the lock held) -> progress (elapsed, the log's last
            lines); finished -> its own result; gone without a result -> failed, and why.

<runs> is <root>/.runs (git-ignored), or FACTORY_RUNS_DIR. Standard library only.
"""
import fcntl, glob, json, os, socket, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent_result as AR

STEP_WORDS = {"deploy": "deploy", "lanes": "lane run"}


def _dir(root, app): return os.path.join(AR.runs_dir(root), app)


def lock_path(root, app, step): return os.path.join(_dir(root, app), f"{step}.lock")


def alive(pid):
    try: os.kill(int(pid), 0); return True
    except (ProcessLookupError, ValueError, TypeError): return False
    except PermissionError: return True


def holder(root, app, step):
    try: return json.load(open(lock_path(root, app, step)))
    except (OSError, ValueError): return {}


class Lock:
    """flock on <runs>/<app>/<step>.lock. acquire() -> True, or False with self.held_by = the holder's record."""
    def __init__(self, root, app, step):
        self.root, self.app, self.step = root, app, step
        self.path = lock_path(root, app, step); self.fd = None; self.held_by = {}; self.took_over = None

    def acquire(self, argv=None, pid=None):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        inherited = os.environ.get("FACTORY_LOCK_FD")
        if inherited and os.environ.get("FACTORY_LOCK_PATH") == self.path:
            # A background child: its parent took the lock and handed the descriptor over (pass_fds).
            self.fd = int(inherited); os.set_inheritable(self.fd, False)
            os.environ.pop("FACTORY_LOCK_FD", None); os.environ.pop("FACTORY_LOCK_PATH", None)
            self.write(argv, pid or os.getpid()); return True
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd); self.held_by = holder(self.root, self.app, self.step) or {"pid": None}; return False
        os.set_inheritable(fd, False)
        before = holder(self.root, self.app, self.step)
        if before.get("pid") and before.get("pid") != os.getpid():
            # The kernel released it, so its holder is gone (or never finished cleanly): taken over, and said so.
            self.took_over = before
        self.fd = fd; self.write(argv, pid or os.getpid()); return True

    def write(self, argv=None, pid=None):
        rec = {"pid": pid or os.getpid(), "since": AR.now(), "argv": list(argv or sys.argv), "host": socket.gethostname()}
        os.ftruncate(self.fd, 0); os.lseek(self.fd, 0, 0); os.write(self.fd, (json.dumps(rec) + "\n").encode())

    def release(self):
        if self.fd is None: return
        try:
            os.ftruncate(self.fd, 0); fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd); self.fd = None

    def is_held(self):
        """True when some process holds the lock right now (a test lock that is immediately released)."""
        if not os.path.exists(self.path): return False
        fd = os.open(self.path, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB); fcntl.flock(fd, fcntl.LOCK_UN); return False
        except BlockingIOError: return True
        finally: os.close(fd)


def status_cmd(script, app, step):
    return f"python3 .claude/scripts/{script} {app} status --json"


def locked_result(script, app, step, held):
    since = held.get("since") or "an unknown time"
    who = f"process {held.get('pid')}" if held.get("pid") else "another process"
    cmd = " ".join(held.get("argv") or [])[:200]
    return AR.result(False, "running", f"A {STEP_WORDS.get(step, step)} of {app} is already running ({who} on "
                     f"{held.get('host') or 'this machine'}, since {since}); nothing new was started.",
                     status_cmd(script, app, step), [], "", {"holder": held, "command": cmd, "lock": step})


def new_record(root, app, step, argv, log, pid=None, background=False):
    d = os.path.join(_dir(root, app), step); os.makedirs(d, exist_ok=True)
    base = os.path.splitext(os.path.basename(log))[0] if log and os.path.dirname(log) == d else time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"
    path = os.path.join(d, base + ".json")
    AR._atomic_json(path, {"app": app, "step": step, "argv": list(argv), "pid": pid or os.getpid(), "started_at": AR.now(),
                           "log": log, "background": background, "status": "running"})
    return path


def finish_record(path, code, res=None):
    """A run that ended without printing a JSON result (no --json) still leaves its exit code and status."""
    try: r = json.load(open(path))
    except (OSError, ValueError): return
    if r.get("result"): return
    st = "done" if code == 0 else "needs_human" if code == AR.EXIT["needs_human"] else "failed"
    r.update({"exit_code": code, "finished_at": AR.now(), "status": st})
    if res: r["result"] = res
    AR._atomic_json(path, r)


def latest(root, app, step):
    recs = sorted(glob.glob(os.path.join(_dir(root, app), step, "*.json")), key=os.path.getmtime)
    for p in reversed(recs):
        try: return p, json.load(open(p))
        except (OSError, ValueError): continue
    return None, None


def status(root, script, app, step, start_cmd):
    """The latest run's progress or result, as an agent_result result (not printed)."""
    path, r = latest(root, app, step)
    word = STEP_WORDS.get(step, step)
    if not r:
        return AR.result(True, "done", f"No {word} of {app} has been recorded on this machine yet.", start_cmd, [], "",
                         {"record": None})
    meta = {"record": path, "started_at": r.get("started_at"), "pid": r.get("pid"), "background": r.get("background"),
            "command": " ".join(r.get("argv") or [])}
    if r.get("result"):
        res = dict(r["result"]); res["details"] = dict(res.get("details") or {}, run=dict(meta, finished_at=r.get("finished_at")))
        res["log"] = res.get("log") or r.get("log") or ""
        return res
    lk = Lock(root, app, step)
    if r.get("status") == "running" and alive(r.get("pid")) and lk.is_held():
        try:
            from datetime import datetime
            el = int(time.time() - datetime.fromisoformat(r["started_at"]).timestamp())
        except Exception: el = None
        last = AR.tail(r.get("log") or "", 5)
        return AR.result(True, "running", f"The {word} of {app} is still running" + (f" ({el // 60}m{el % 60:02d}s so far)" if el is not None else "")
                         + (f"; last line: {last[-1][:160]}" if last else "") + ".",
                         f"Wait a minute, then: {status_cmd(script, app, step)}", [], r.get("log") or "",
                         dict(meta, elapsed_s=el, last_lines=last))
    if r.get("status") in ("done", "failed", "needs_human"):
        st = r["status"]
        nxt = "" if st == "done" else (f"Find the cause first ({'the log: ' + r['log'] if r.get('log') else 'it was printed where it ran'}"
                                        f"{'; and state/application/' + app + '/application.json revert.reason' if step == 'deploy' else ''}), "
                                        f"tell the operator, and only then run it again: {start_cmd}")
        return AR.result(st == "done", st, f"The last {word} of {app} finished: {st.replace('_', ' ')} (exit {r.get('exit_code')}).",
                         nxt, [], r.get("log") or "", dict(meta, exit_code=r.get("exit_code"),
                         last_lines=AR.tail(r.get("log") or "", 8)))
    return AR.result(False, "failed", f"The {word} of {app} started {r.get('started_at')} stopped without finishing: process "
                     f"{r.get('pid')} is gone and left no result.", f"Read the log, then start it again: {start_cmd}",
                     [], r.get("log") or "", dict(meta, last_lines=AR.tail(r.get("log") or "", 12)))


def start_background(root, script, app, step, child_argv, start_cmd):
    """Take the lock, start `script child_argv --json` detached with the lock handed over, return a running result
    (and exit code). The child writes its result into the record when it ends."""
    lk = Lock(root, app, step)
    if not lk.acquire(argv=[script] + list(child_argv)):
        res = locked_result(script, app, step, lk.held_by); return res, AR.LOCKED
    try:
        log = AR.new_log(root, app, step)
        rec = new_record(root, app, step, [script] + list(child_argv), log, background=True)
        env = dict(os.environ, FACTORY_RUN_RECORD=rec, FACTORY_RUN_LOG=log, FACTORY_LOCK_FD=str(lk.fd), FACTORY_LOCK_PATH=lk.path)
        os.set_inheritable(lk.fd, True)
        with open(log, "a") as out:
            p = subprocess.Popen([sys.executable, os.path.join(root, ".claude", "scripts", script), *child_argv, "--json"],
                                 cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True, pass_fds=(lk.fd,))
        r = json.load(open(rec)); r["pid"] = p.pid; AR._atomic_json(rec, r)
        lk.write([script] + list(child_argv), p.pid)
    finally:
        os.close(lk.fd); lk.fd = None          # the child holds it now
    took = f" (took over a stale lock left by process {lk.took_over.get('pid')}, which is gone)" if lk.took_over else ""
    res = AR.result(True, "running", f"The {STEP_WORDS.get(step, step)} of {app} started in the background (process {p.pid}){took}. "
                    f"It keeps running if this window closes.", f"Check on it in a minute: {status_cmd(script, app, step)}",
                    [], log, {"record": rec, "pid": p.pid, "status_command": status_cmd(script, app, step), "start_command": start_cmd})
    return res, 0


class Held:
    """A foreground run under the lock: `with Held(root, app, step, script) as h: if h.locked: ...`.
    Writes a record so `status` reports the foreground run too."""
    def __init__(self, root, app, step, script, argv, log=None):
        self.root, self.app, self.step, self.script, self.argv, self.log = root, app, step, script, argv, log
        self.lock = Lock(root, app, step); self.locked = False; self.record = None
    def __enter__(self):
        if not self.lock.acquire(argv=[self.script] + list(self.argv)):
            self.locked = True; return self
        if self.lock.took_over:
            print(f"note: took over the {self.step} lock of {self.app} from process {self.lock.took_over.get('pid')}, which is gone", file=sys.stderr)
        rec = os.environ.get("FACTORY_RUN_RECORD")
        if rec and os.path.exists(rec): self.record = rec
        else:
            self.record = new_record(self.root, self.app, self.step, [self.script] + list(self.argv), self.log or "")
            os.environ["FACTORY_RUN_RECORD"] = self.record
        return self
    def __exit__(self, *exc):
        if not self.locked: self.lock.release()
        return False


def self_test():
    import tempfile
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    here = os.path.dirname(os.path.abspath(__file__))
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, ".claude", "scripts"))
        open(os.path.join(root, ".claude", "scripts", "slow.py"), "w").write(
            f"import sys, os, time; sys.path.insert(0, {here!r}); import runs, agent_result as A\n"
            "root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n"
            "a = [x for x in sys.argv[1:] if x != '--json']\n"
            "def main(argv):\n"
            "    with runs.Held(root, 'app1', 'lanes', 'slow.py', argv) as h:\n"
            "        if h.locked: print('LOCKED'); return 4\n"
            "        print('working'); time.sleep(float(argv[0])); A.note(summary='slept'); return 0\n"
            "sys.exit(A.run_json(main, a, root=root, app='app1', step='lanes'))\n")
        os.environ.pop("FACTORY_RUN_RECORD", None); os.environ.pop("FACTORY_RUN_LOG", None)
        res, code = start_background(root, "slow.py", "app1", "lanes", ["1.5"], "python3 slow.py app1")
        ok(code == 0 and res["status"] == "running" and "status --json" in res["next"], "a background start returns at once: running, exit 0, the status command")
        res2, code2 = start_background(root, "slow.py", "app1", "lanes", ["1"], "python3 slow.py app1")
        ok(code2 == 4 and res2["status"] == "running" and res2["details"]["holder"]["pid"] == res["details"]["pid"], "a second start: exit 4, naming the holder's pid")
        st = status(root, "slow.py", "app1", "lanes", "start")
        ok(st["status"] == "running" and st["details"]["pid"] == res["details"]["pid"], "status while it runs: running, with its pid")
        for _ in range(100):
            time.sleep(0.1)
            if not alive(res["details"]["pid"]): break
        time.sleep(0.2)
        st = status(root, "slow.py", "app1", "lanes", "start")
        ok(st["status"] == "done" and st["summary"] == "slept" and st["details"]["run"]["background"] is True, "status after it ends: the run's own result")
        # a stale lock: a holder record naming a dead pid, and no flock held
        json.dump({"pid": 999999, "since": "2026-01-01T00:00:00+00:00", "argv": ["x"]}, open(lock_path(root, "app1", "deploy"), "w"))
        lk = Lock(root, "app1", "deploy")
        ok(lk.acquire(["y"]) and lk.took_over and lk.took_over["pid"] == 999999, "a lock whose holder is gone is taken over, and it says whose")
        lk2 = Lock(root, "app1", "deploy")
        ok(not lk2.acquire(["z"]) and lk2.held_by["pid"] == os.getpid(), "while held, a second acquire fails and reads the holder")
        lk.release(); ok(Lock(root, "app1", "deploy").acquire(["z"]), "released: free again")
        # a run that died without a result
        rec = new_record(root, "app2", "deploy", ["provision.py"], "", pid=999998)
        st = status(root, "provision.py", "app2", "deploy", "start")
        ok(st["status"] == "failed" and "gone" in st["summary"], "a recorded run whose process is gone without a result: failed, and why")
        st = status(root, "provision.py", "app3", "deploy", "start-it")
        ok(st["status"] == "done" and st["next"] == "start-it", "nothing recorded yet: says so, next is the start command")
    print(f"runs: {len(checks)} checks passed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    print(__doc__)
