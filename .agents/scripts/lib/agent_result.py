"""One result shape for every factory script an agent runs with --json.

    {"ok": bool, "status": "done|failed|needs_human|running",
     "summary": "<one sentence>", "next": "<the one next step, as a request or a command>",
     "needs": [{"kind": "secret|code|dns|approval|login", "name": "...", "how": "<plain instruction for the person>"}],
     "log": "<path to the full log>", "details": {...}}

Exit codes, the same in every script: 0 done (and a background run that started), 1 failed, 2 could not run at all
(bad input or missing state; status "failed"), 3 a human is needed, 4 already running (another run holds the lock for
this application and step).

With --json, everything a script would have printed (and everything its subprocesses print) goes to the log file,
not to stdout, so stdout carries exactly one JSON document. A secret value never reaches a field or the log: a script
that holds one calls forbid(value) first, and emit() and the log scrub replace any forbidden value with <hidden>.

Scripts use it in three lines:

    as_json, argv = agent_result.wants_json(argv)
    if as_json: return agent_result.run_json(main, argv, root=ROOT, app=app_id, step="deploy", finish=my_finish)
    ...and inside main(): agent_result.need(...), agent_result.note(...), agent_result.detail(...)

Standard library only.
"""
import datetime, io, json, os, re, sys, traceback

EXIT = {"done": 0, "failed": 1, "needs_human": 3, "running": 0}
LOCKED = 4
KINDS = ("secret", "code", "dns", "approval", "login")
STATUSES = ("done", "failed", "needs_human", "running")

# What a script collected while it ran (reset by run_json); read by the script's own `finish`.
NOTES = {"needs": [], "details": {}, "summary": None, "next": None, "status": None, "exit_message": None}
_FORBIDDEN = set()
_CRED = [(re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@\"']*:[^\s/@\"']*@"), r"\1***:***@"),
         (re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1***"),
         (re.compile(r"(?i)([?&](?:token|api[_-]?key|access_token|secret|code)=)[^&\s\"']+"), r"\1***")]


def reset():
    NOTES.update({"needs": [], "details": {}, "summary": None, "next": None, "status": None, "exit_message": None})


def forbid(value):
    """A value that must never appear in a result field or a log (a secret the script is holding)."""
    if isinstance(value, str) and len(value.strip()) >= 4: _FORBIDDEN.add(value.strip())


def scrub(s):
    if not isinstance(s, str): return s
    for v in sorted(_FORBIDDEN, key=len, reverse=True): s = s.replace(v, "<hidden>")
    for rx, rep in _CRED: s = rx.sub(rep, s)
    return s


def _scrub_all(x):
    if isinstance(x, str): return scrub(x)
    if isinstance(x, list): return [_scrub_all(v) for v in x]
    if isinstance(x, dict): return {k: _scrub_all(v) for k, v in x.items()}
    return x


def need(kind, name, how):
    """Something only a person can give. `how` is a plain instruction for that person, never a value."""
    if kind not in KINDS: raise ValueError(f"need kind {kind!r} is not one of {KINDS}")
    if not any(n["kind"] == kind and n["name"] == name for n in NOTES["needs"]):
        NOTES["needs"].append({"kind": kind, "name": name, "how": how})


def note(summary=None, next=None, status=None):
    if summary is not None: NOTES["summary"] = summary
    if next is not None: NOTES["next"] = next
    if status is not None: NOTES["status"] = status


def detail(key, value): NOTES["details"][key] = value


def secret_how(app_id, name, script=".claude/scripts/provision.py"):
    """The one way a person hands over a secret: themselves, in a separate terminal, at a hidden prompt."""
    return (f"Open a separate terminal on the factory machine (not this chat) and run: python3 {script} {app_id} --set-secret {name} "
            f"- it explains where to find the value, then asks for it at a hidden prompt. The value never appears on screen, "
            f"in the chat or in any file here. Then tell me it is done.")


def result(ok, status, summary, next="", needs=None, log="", details=None):
    if status not in STATUSES: raise ValueError(f"status {status!r} is not one of {STATUSES}")
    return {"ok": bool(ok), "status": status, "summary": summary or "", "next": next or "", "needs": list(needs or []),
            "log": log or "", "details": dict(details or {})}


def exit_code(res, locked=False):
    return LOCKED if locked else EXIT[res["status"]]


def emit(res, stream=None, locked=False):
    """Print the result as one JSON document; write it into the run record when this process is a recorded run.
    Returns the exit code."""
    res = _scrub_all(res)
    code = exit_code(res, locked)
    rec = os.environ.get("FACTORY_RUN_RECORD")
    if rec and os.path.exists(rec) and not locked:
        try:
            r = json.load(open(rec))
            r.update({"result": res, "exit_code": code, "finished_at": now(), "status": res["status"]})
            _atomic_json(rec, r)
        except (OSError, ValueError): pass
    (stream or sys.stdout).write(json.dumps(res, indent=2) + "\n"); (stream or sys.stdout).flush()
    return code


def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _atomic_json(path, obj):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f: json.dump(obj, f, indent=2); f.write("\n")
    os.replace(tmp, path)


def wants_json(argv):
    """(True, argv without --json) when --json is among the arguments."""
    return ("--json" in argv), [a for a in argv if a != "--json"]


def runs_dir(root):
    """Where run records, logs and locks live: <root>/.runs (git-ignored), or FACTORY_RUNS_DIR."""
    return os.environ.get("FACTORY_RUNS_DIR") or os.path.join(root, ".runs")


def new_log(root, app, step):
    """A fresh log path for one run, or the one a background parent already opened for this process."""
    if os.environ.get("FACTORY_RUN_LOG"): return os.environ["FACTORY_RUN_LOG"]
    d = os.path.join(runs_dir(root), app or "_factory", step)
    os.makedirs(d, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for n in range(1, 1000):
        p = os.path.join(d, f"{stamp}-{os.getpid()}" + ("" if n == 1 else f"-{n}") + ".log")
        try: os.close(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)); return p
        except FileExistsError: continue
    return os.path.join(d, f"{stamp}-{os.getpid()}.log")


class Capture:
    """Send fd 1 and fd 2 (this process's prints AND its subprocesses') to a log file until exit."""
    def __init__(self, path): self.path = path
    def __enter__(self):
        sys.stdout.flush(); sys.stderr.flush()
        self.saved = (os.dup(1), os.dup(2))
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.dup2(fd, 1); os.dup2(fd, 2); os.close(fd)
        # line by line, so the log reads in the order things happened, a child's output included
        self.lb = [getattr(s, "line_buffering", None) for s in (sys.stdout, sys.stderr)]
        for s in (sys.stdout, sys.stderr):
            try: s.reconfigure(line_buffering=True)
            except Exception: pass
        return self
    def __exit__(self, *exc):
        try: sys.stdout.flush(); sys.stderr.flush()
        except Exception: pass
        for st, lb in zip((sys.stdout, sys.stderr), self.lb):
            try: st.reconfigure(line_buffering=bool(lb))
            except Exception: pass
        os.dup2(self.saved[0], 1); os.dup2(self.saved[1], 2)
        os.close(self.saved[0]); os.close(self.saved[1])
        if _FORBIDDEN and os.path.exists(self.path):     # belt and braces: a value a subprocess echoed is scrubbed too
            try:
                s = open(self.path, errors="replace").read(); t = scrub(s)
                if t != s: open(self.path, "w").write(t)
            except OSError: pass
        return False


def tail(path, n=12):
    try: lines = [l.rstrip() for l in open(path, errors="replace").read().splitlines() if l.strip()]
    except OSError: return []
    return [scrub(l) for l in lines[-n:]]


def last_line(path):
    t = tail(path, 1)
    return t[0] if t else ""


def run_json(main_fn, argv, root, app, step, finish=None):
    """Run main_fn(argv) with its output in a log, then print one result. `finish(code, log, notes)` builds the
    result from the exit code and what main_fn noted; the default reads the notes and the log's last line."""
    reset(); log = new_log(root, app, step); code = 0
    with Capture(log):
        try:
            rc = main_fn(argv)
            code = rc if isinstance(rc, int) else 0
        except SystemExit as e:
            if isinstance(e.code, int) or e.code is None: code = e.code or 0
            else:
                print(e.code, file=sys.stderr); code = 1; NOTES["exit_message"] = scrub(str(e.code))
        except KeyboardInterrupt:
            print("interrupted", file=sys.stderr); code = 1
        except Exception:
            traceback.print_exc(); code = 1
    res = (finish or default_finish)(code, log, NOTES)
    res["log"] = log
    rc = emit(res)
    return 2 if code == 2 and res["status"] == "failed" else rc     # 2 keeps meaning "could not run at all"


CMD = re.compile(r"(python3 \.claude/scripts/\S+\.py [^\n]*?)(?:\s*$|\s{2,}|\)|\.\s)", re.M)
def command_in(text):
    """The first factory command a message names (its instruction), or ''."""
    m = CMD.search(text or "")
    return m.group(1).strip().rstrip(".") if m else ""


def default_finish(code, log, notes):
    needs = notes["needs"]; msg = notes.get("exit_message") or ""
    status = notes["status"] or ("needs_human" if needs or code == EXIT["needs_human"] else "done" if code == 0 else "failed")
    first = next((l.strip() for l in msg.splitlines() if l.strip()), "")
    summary = notes["summary"] or (first if code else "") or last_line(log) or ("finished" if code == 0 else f"stopped with exit code {code}")
    nxt = notes["next"] or (needs[0]["how"] if needs else "") or (command_in(msg) if code else "")
    return result(status == "done", status, summary, nxt, needs, log, dict(notes["details"], exit_code=code))


def self_test():
    import tempfile, subprocess
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    r = result(True, "done", "s", "n", [], "l", {"a": 1})
    ok(set(r) == {"ok", "status", "summary", "next", "needs", "log", "details"}, "the shape has exactly the seven keys")
    ok([exit_code(result(False, s, "")) for s in ("done", "failed", "needs_human", "running")] == [0, 1, 3, 0] and exit_code(r, locked=True) == 4, "exit codes 0/1/3/0 and 4 for a lock")
    try: result(True, "maybe", ""); ok(False, "unknown status refused")
    except ValueError: ok(True, "an unknown status is refused")
    reset(); forbid("re_SECRET_VALUE_123")
    out = io.StringIO(); emit(result(False, "failed", "got re_SECRET_VALUE_123 back", "postgres://u:p@h/db"), out)
    ok("re_SECRET_VALUE_123" not in out.getvalue() and "<hidden>" in out.getvalue() and "u:p@" not in out.getvalue(), "a forbidden value and a URL password never reach a field")
    _FORBIDDEN.clear()
    ok(wants_json(["x", "--json", "run"]) == (True, ["x", "run"]) and wants_json(["x"]) == (False, ["x"]), "--json is found and removed")
    with tempfile.TemporaryDirectory() as d:
        os.environ.pop("FACTORY_RUN_LOG", None); os.environ.pop("FACTORY_RUN_RECORD", None)
        # run_json prints to the real fd 1, so each case runs in a child process whose stdout is a pipe
        code = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {os.path.dirname(os.path.abspath(__file__))!r}); import agent_result as A, subprocess\n"
                               "def m(a):\n    print('line one'); subprocess.run(['echo','from a child']); A.need('secret','X_KEY','run it yourself'); return 1\n"
                               f"sys.exit(A.run_json(m, [], root={d!r}, app='app1', step='check'))"], capture_output=True, text=True)
        doc = json.loads(code.stdout)
        ok(code.returncode == 3 and doc["status"] == "needs_human" and doc["needs"][0]["name"] == "X_KEY", "a need makes needs_human, exit 3")
        ok(code.stdout.lstrip().startswith("{") and code.stdout.rstrip().endswith("}") and "from a child" in open(doc["log"]).read() and "line one" in open(doc["log"]).read(), "prints and a child's output go to the log; stdout is one JSON document")
        lg = open(doc["log"]).read()
        ok(lg.index("line one") < lg.index("from a child"), "the log is in the order things happened")
        ok(doc["log"].startswith(os.path.join(d, ".runs", "app1", "check")), "the log is under .runs/<app>/<step>/")
        code = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {os.path.dirname(os.path.abspath(__file__))!r}); import agent_result as A\n"
                               "def m(a): sys.exit('it broke here')\n"
                               f"sys.exit(A.run_json(m, [], root={d!r}, app='app1', step='check'))"], capture_output=True, text=True)
        doc = json.loads(code.stdout)
        ok(code.returncode == 1 and doc["status"] == "failed" and doc["summary"] == "it broke here" and doc["ok"] is False, "sys.exit(message) is failed, exit 1, the message is the summary")
    ok(command_in("refusing: x is missing.\n  Run: python3 .claude/scripts/provision.py a --deploy") == "python3 .claude/scripts/provision.py a --deploy", "the command a failure message names becomes next")
    print(f"agent_result: {len(checks)} checks passed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    print(__doc__)
