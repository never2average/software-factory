#!/usr/bin/env python3
"""uptime.py check [--json] [--quiet] | status [--json] | preview-alert [down|still_down|recovered] [--app ID]
         | install [--user] [--dry-run] | uninstall [--user] | set-email-key | send-test-email --yes | --self-test

Uptime monitoring with alerts for every deployed factory app, run every minute on THE FACTORY MACHINE (never on an
app server: `install` refuses there).

check          probes every non-retired app's health pages (the same ones the factory board loads: web
               /api/ops/health, api /eve/v1/health, and on Vercel the workflow service's /api/health), each with a
               10 s timeout and one retry. A page is up when it answers 2xx and does not say {"ok": false}.
               Writes .runs/uptime/state.json (git-ignored): per app its status, since when, the last error.
               An app is DOWN after 2 consecutive failing checks (one blip alerts nobody). Alerts: once when it goes
               down, again every 30 minutes while it stays down, once when it recovers (with how long it was down).
status         prints the last state; with --json the file itself. Also the timer's state.
preview-alert  prints the exact email an alert would send, built from the current state or a made-up outage of the
               app named. Sends nothing.
install        writes a systemd timer (system units as root, else user units) that runs `check --quiet` every
               minute, enables and starts it. Idempotent: unchanged files are left alone. `uninstall` removes it.
set-email-key  for the operator, in their own terminal: asks for a Resend key with sending access (hidden while
               typed) and keeps it in ~/.config/software-factory/uptime.env (0600). Never in the repository.
send-test-email --yes   sends one clearly-marked test email to the operator. Only when they asked for one.

Alert channels:
  board   always: the factory board reads .runs/uptime/state.json and shows a red banner while any app is down.
  email   to defaults.operator_email (state/factory.local.json, lib/factory_local.py) through Resend, when this
          machine has a key of its own: FACTORY_UPTIME_RESEND_API_KEY in the environment, or RESEND_API_KEY in
          ~/.config/software-factory/uptime.env. The sender is UPTIME_EMAIL_FROM there, else
          "Software factory <alerts@<defaults.notify_domain>>" (the domain the apps already send sign-in codes from).
          An app's own key is never borrowed. A send that fails is retried on the next check.
  log     every alert is appended to .runs/uptime/alerts.jsonl.

Alert text carries the app id, its address, the time, and what each page answered in plain words: an HTTP status
and reason, a timeout, a refused connection; never a response body, a header or a key.

THE GAP, and monitoring from outside: this runs ON the factory machine. If that machine is off, out of disk, or off
the internet, nothing checks anything and nothing is sent; the board banner turns amber ("the monitor last ran N min
ago") only once someone opens the board. It also sees apps from one network only. Recommended free outside checks
(none set up by this script; each needs the operator's own say-so):
  1. A scheduled GitHub Actions workflow in the factory's public repository that curls the public health pages every
     5-15 minutes and fails (GitHub emails the repository's owner on a failed scheduled run). Free on a public repo, no
     new account. Trade-offs: the schedule is best-effort (runs are often 5-20 min late, skipped under load, and turned
     off after 60 days with no commits), the alert is a generic "workflow failed" email, and the health addresses
     become visible in a public file, so use a private variable for the list.
  2. A free uptime service (UptimeRobot free tier: 50 monitors, 5-minute checks, email alerts; Better Stack and
     Healthchecks.io have similar free tiers). Most reliable and gives a status page, but it is one new account for
     the operator to create and own.
  3. A dead-man's switch for THIS monitor: Healthchecks.io's free tier pinged by each run of the timer emails when the
     pings stop, which covers the factory machine itself being down. Also one new account.
"""
import argparse, base64, concurrent.futures, fcntl, getpass, http.client, http.server, json, os, re, shutil, socket
import ssl, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "lib"))
from factory_local import load_factory  # noqa: E402

STATE_DIR = os.environ.get("UPTIME_STATE_DIR") or os.path.join(ROOT, ".runs", "uptime")
EMAIL_ENV = os.path.expanduser("~/.config/software-factory/uptime.env")
UNIT = "factory-uptime"
TIMEOUT_S = 10
RETRY_PAUSE_S = 2
DOWN_AFTER = 2                      # consecutive failing checks
REPEAT_EVERY = timedelta(minutes=30)
KEEP_ALERTS = 50                    # in state.json; alerts.jsonl keeps all

PAGE_WORDS = {"web": "the website", "api": "the assistant service", "workflow": "the background-task service"}


# ---- what to check: the board's healthChecks() (plugins/factory-board/hooks/board.ts) --------------------------------

def health_checks(application, infrastructure):
    if application.get("status") == "retired":
        return []
    target = str(infrastructure.get("target") or "")
    vercel = infrastructure.get("vercel") or {}
    remote = infrastructure.get("vm_remote") or {}
    web = remote.get("production_url") if target == "vm_remote" else vercel.get("production_url")
    out = []
    if web:
        out.append({"name": "web", "url": f"{web.rstrip('/')}/api/ops/health"})
    if target == "vm_remote" and web:
        out.append({"name": "api", "url": f"{web.rstrip('/')}/eve/v1/health"})
    if target != "vm_remote" and vercel.get("api_url"):
        out.append({"name": "api", "url": f"{vercel['api_url'].rstrip('/')}/eve/v1/health"})
    if target != "vm_remote" and vercel.get("workflow_url"):
        out.append({"name": "workflow", "url": f"{vercel['workflow_url'].rstrip('/')}/api/health"})
    return out


def targets(state_dir=None):
    """[{app_id, address, checks}] for every app in state/application that is not retired and has a health page."""
    state_dir = state_dir or os.path.join(ROOT, "state")
    base = os.path.join(state_dir, "application")
    out = []
    for app_id in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        d = os.path.join(base, app_id)
        if app_id == "app_id" or not os.path.isdir(d):
            continue
        try:
            application = json.load(open(os.path.join(d, "application.json")))
            infrastructure = json.load(open(os.path.join(d, "infrastructure.json")))
        except (OSError, ValueError):
            continue        # an app folder without its state files is not an app yet
        checks = health_checks(application, infrastructure)
        if not checks:
            continue
        target = infrastructure.get("target")
        address = ((infrastructure.get("vm_remote") if target == "vm_remote" else infrastructure.get("vercel")) or {}).get("production_url")
        out.append({"app_id": app_id, "address": address or checks[0]["url"], "target": target, "checks": checks})
    return out


# ---- probing ------------------------------------------------------------------------------------------------------

SECRETISH = [
    (re.compile(r"(?i)\b(re|sk|pk|ghp|gho|xox[abp])_[A-Za-z0-9_\-]{8,}"), "[hidden]"),
    (re.compile(r"(?i)(bearer|token|key|password|secret)[=: ]+\S+"), r"\1=[hidden]"),
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://[hidden]@"),
    (re.compile(r"\b[A-Za-z0-9+/_\-]{40,}\b"), "[hidden]"),
]


def scrub(text):
    text = str(text)
    for rx, sub in SECRETISH:
        text = rx.sub(sub, text)
    return text[:200]


def _plain_error(err, timeout_s):
    """What a page 'answered' when it answered nothing, in words a non-engineer reads."""
    reason = getattr(err, "reason", err)
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
        return f"nothing: it did not answer within {timeout_s:g} seconds"
    if isinstance(reason, ConnectionRefusedError) or "refused" in str(reason).lower():
        return "nothing: the server refused the connection (the app is probably not running)"
    if isinstance(reason, socket.gaierror) or "name or service not known" in str(reason).lower():
        return "nothing: its web address could not be found (a DNS problem)"
    if isinstance(reason, ssl.SSLError) or "certificate" in str(reason).lower():
        return "a security-certificate problem, so browsers would refuse it too"
    if isinstance(reason, (ConnectionResetError, http.client.RemoteDisconnected)) or "reset" in str(reason).lower():
        return "nothing: the connection was cut off before it answered"
    return "nothing: " + scrub(reason)


def probe_once(url, timeout_s=TIMEOUT_S):
    """{"ok", "status", "answer", "ms"}. Never raises. The body is read only to see {"ok": false}; it is never kept."""
    started = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": "software-factory-uptime/1", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            code, reason, body = r.status, r.reason, r.read(65536)
    except urllib.error.HTTPError as e:
        code, reason, body = e.code, e.reason, b""
    except Exception as e:          # noqa: BLE001 — every failure is an answer, never a crash of the monitor
        return {"ok": False, "status": None, "answer": _plain_error(e, timeout_s), "ms": int((time.monotonic() - started) * 1000)}
    ms = int((time.monotonic() - started) * 1000)
    if not 200 <= code < 300:
        what = "an error page" if code >= 500 else "an unexpected answer"
        return {"ok": False, "status": code, "answer": f"{what} (HTTP {code} {scrub(reason or '')})".replace(" )", ")"), "ms": ms}
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        data = None
    if isinstance(data, dict) and data.get("ok") is False:
        parts = [k for k, v in data.items() if isinstance(v, dict) and v.get("ok") is False]
        return {"ok": False, "status": code, "ms": ms,
                "answer": "it is running but reports a problem" + (f" with: {', '.join(scrub(p) for p in parts[:5])}" if parts else "")}
    return {"ok": True, "status": code, "answer": f"OK (HTTP {code})", "ms": ms}


def probe(url, timeout_s=TIMEOUT_S, retry_pause_s=RETRY_PAUSE_S):
    """One retry: a page is failing only when both tries fail."""
    first = probe_once(url, timeout_s)
    if first["ok"]:
        return first
    time.sleep(retry_pause_s)
    second = probe_once(url, timeout_s)
    second["tries"] = 2
    return second


def probe_all(apps, timeout_s=TIMEOUT_S, retry_pause_s=RETRY_PAUSE_S):
    """{app_id: [check + result]}; every page in parallel, so a full run takes about one timeout, not their sum."""
    jobs = [(a["app_id"], c) for a in apps for c in a["checks"]]
    out = {a["app_id"]: [] for a in apps}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(16, len(jobs)))) as pool:
        futures = {pool.submit(probe, c["url"], timeout_s, retry_pause_s): (app, c) for app, c in jobs}
        for f, (app, c) in futures.items():
            out[app].append({**c, **f.result()})
    return out


# ---- the state machine --------------------------------------------------------------------------------------------

def iso(t):
    return t.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso(s):
    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def step(prev, results, now):
    """(new app state, alert kind or None) from the app's previous state and this run's page results."""
    prev = dict(prev or {})
    failing = [r for r in results if not r["ok"]]
    s = {
        "status": prev.get("status", "unknown"),
        "since": prev.get("since"),
        "consecutive_failures": prev.get("consecutive_failures", 0),
        "down_since": prev.get("down_since"),
        "last_alert_at": prev.get("last_alert_at"),
        "last_outage": prev.get("last_outage"),
        "email_pending": prev.get("email_pending"),
        "last_checked": iso(now),
        "checks": [{k: r.get(k) for k in ("name", "url", "ok", "status", "answer", "ms")} for r in results],
        "last_error": "; ".join(f"{r['name']}: {r['answer']}" for r in failing) or prev.get("last_error"),
    }
    alert = None
    if failing:
        s["consecutive_failures"] += 1
        if s["consecutive_failures"] == 1:
            s["down_since"] = iso(now)                        # since the first failing check
        if s["status"] != "down" and s["consecutive_failures"] >= DOWN_AFTER:
            s["status"], s["since"], s["last_alert_at"], alert = "down", s["down_since"], iso(now), "down"
        elif s["status"] == "down":
            last = parse_iso(s["last_alert_at"])
            if last is None or now - last >= REPEAT_EVERY:
                s["last_alert_at"], alert = iso(now), "still_down"
        elif s["status"] != "down":
            s["status"] = "failing"                            # one failing check: watched, not alerted
            s["since"] = s["since"] or iso(now)
    else:
        if s["status"] == "down":
            began = parse_iso(s["down_since"]) or now
            s["last_outage"] = {"from": s["down_since"], "to": iso(now), "minutes": round((now - began).total_seconds() / 60)}
            alert = "recovered"
            s["last_alert_at"] = iso(now)
        if s["status"] in ("down", "unknown"):
            s["since"] = iso(now)
        s["status"], s["consecutive_failures"], s["down_since"] = "up", 0, None
        s["since"] = s["since"] or iso(now)
    return s, alert


# ---- the alert text -----------------------------------------------------------------------------------------------

def duration(minutes):
    minutes = max(0, int(round(minutes)))
    if minutes < 1:
        return "less than a minute"
    d, rem = divmod(minutes, 1440)
    h, m = divmod(rem, 60)
    parts = [f"{d} day{'s' * (d != 1)}" if d else "", f"{h} hour{'s' * (h != 1)}" if h else "",
             f"{m} minute{'s' * (m != 1)}" if m and not d else ""]
    return " ".join(p for p in parts if p)


def when(s):
    t = parse_iso(s)
    if not t:
        return "an unknown time"
    t = t.astimezone(timezone.utc)
    return f"{t.day} {t:%b %Y}, {t:%H:%M} UTC"


def message(kind, app, s, now, everything_failing=False):
    """{"subject", "text"}: the alert in plain words. Only state the monitor itself wrote goes in; no secrets exist there."""
    address = app.get("address") or "(no address recorded)"
    began = parse_iso(s.get("down_since") or (s.get("last_outage") or {}).get("from")) or now
    so_far = duration((now - began).total_seconds() / 60)
    pages = []
    for c in s.get("checks") or []:
        label = PAGE_WORDS.get(c["name"], c["name"])
        pages.append(f"  - {label} ({c['url']}): {c['answer']}")
    footer = ("This message comes from the factory's uptime monitor, which checks every app once a minute from the "
              "factory machine. It does not change anything in the app.")
    if kind == "recovered":
        o = s.get("last_outage") or {}
        subject = f"Back up: {app['app_id']} (it was down {duration(o.get('minutes', 0))})"
        text = "\n".join([
            "Hello,", "",
            f"Good news: {app['app_id']} is answering again.", "",
            f"App:          {app['app_id']}",
            f"Address:      {address}",
            f"Down from:    {when(o.get('from'))}",
            f"Back up at:   {when(o.get('to'))}",
            f"Down for:     {duration(o.get('minutes', 0))}", "",
            "What it answers now:", *pages, "",
            "There is nothing you need to do. The factory will look into why it went down.", "",
            footer,
        ])
    else:
        first = kind == "down"
        subject = (f"Down: {app['app_id']} is not answering (since {when(s.get('down_since')).split(', ')[-1]})" if first
                   else f"Still down: {app['app_id']} (for {so_far} now)")
        lines = [
            "Hello,", "",
            (f"One of the factory's apps has stopped answering: {app['app_id']}." if first
             else f"{app['app_id']} is still not answering."), "",
            f"App:          {app['app_id']}",
            f"Address:      {address}",
            f"Down since:   {when(s.get('down_since'))} ({so_far} so far)", "",
            "What it answered:", *pages, "",
        ]
        if everything_failing:
            lines += ["Every app is failing at the same moment, so the problem may be the factory machine's own internet "
                      "connection rather than the apps.", ""]
        lines += [
            "The factory is looking at it. You do not need to do anything right now. You will get another email every "
            "30 minutes while it stays down, and one when it is back up, with how long it was down.", "",
            footer,
        ]
        text = "\n".join(lines)
    return {"subject": subject, "text": text}


# ---- email (Resend, with this machine's own key only) ---------------------------------------------------------------

def _read_env_file(path):
    out = {}
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def email_config(state_dir=None, env_file=EMAIL_ENV):
    """{"configured": bool, "why": str, "to", "from", "key"}. The key never leaves this dict (not in state, not in logs)."""
    defaults = load_factory(state_dir or os.path.join(ROOT, "state")).get("defaults") or {}
    to = str(defaults.get("operator_email") or "").strip()
    domain = str(defaults.get("notify_domain") or "").strip()
    filed = _read_env_file(env_file)
    key = os.environ.get("FACTORY_UPTIME_RESEND_API_KEY") or filed.get("RESEND_API_KEY") or ""
    sender = os.environ.get("UPTIME_EMAIL_FROM") or filed.get("UPTIME_EMAIL_FROM") or (f"Software factory <alerts@{domain}>" if domain else "")
    why = ""
    if not to or to.endswith("@example.com") or "@" not in to:
        why = "no operator email address on this machine (defaults.operator_email in state/factory.local.json)"
    elif not key:
        why = ("this machine has no email-sending key of its own yet (the operator can add one with "
               "`python3 .claude/scripts/uptime.py set-email-key`)")
    elif not sender or sender.endswith("@example.com>") or sender.endswith("@example.com"):
        why = "no sender address (defaults.notify_domain in state/factory.local.json, or UPTIME_EMAIL_FROM)"
    return {"configured": not why, "why": why, "to": to, "from": sender, "key": key}


def send_resend(cfg, msg, idempotency_key, timeout_s=15, endpoint="https://api.resend.com/emails"):
    """(ok, plain error). One POST; the Idempotency-Key keeps a retried alert from arriving twice."""
    body = json.dumps({"from": cfg["from"], "to": [cfg["to"]], "subject": msg["subject"], "text": msg["text"]}).encode()
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key[:256], "User-Agent": "software-factory-uptime/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            return 200 <= r.status < 300, ""
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8", "replace")).get("message", "")
        except Exception:  # noqa: BLE001
            detail = ""
        return False, scrub(f"the email service answered HTTP {e.code}: {detail}".rstrip(": "))
    except Exception as e:  # noqa: BLE001
        return False, scrub(f"could not reach the email service: {getattr(e, 'reason', e)}")


# ---- one run ------------------------------------------------------------------------------------------------------

def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".state.")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def load_state(state_dir=STATE_DIR):
    try:
        return json.load(open(os.path.join(state_dir, "state.json")))
    except (OSError, ValueError):
        return {}


def run_check(apps, now, state_dir=STATE_DIR, send=None, cfg=None, timeout_s=TIMEOUT_S, retry_pause_s=RETRY_PAUSE_S,
              results=None):
    """Probe, step every app, deliver alerts, write state.json. `send(cfg, msg, key) -> (ok, err)`; `results` skips
    probing (tests). Returns the new state."""
    cfg = cfg if cfg is not None else email_config()
    send = send or send_resend
    prev = load_state(state_dir)
    results = results if results is not None else probe_all(apps, timeout_s, retry_pause_s)
    every_failing = len(apps) > 1 and all(not r["ok"] for rs in results.values() for r in rs)
    new_apps, alerts = {}, list(prev.get("alerts") or [])
    log = os.path.join(state_dir, "alerts.jsonl")
    for app in apps:
        s, kind = step((prev.get("apps") or {}).get(app["app_id"]), results.get(app["app_id"], []), now)
        s["address"] = app["address"]
        if kind:
            msg = message(kind, app, s, now, every_failing)
            idem = f"uptime-{app['app_id']}-{kind}-{s.get('down_since') or (s.get('last_outage') or {}).get('from')}-{iso(now)}"
            s["email_pending"] = {"kind": kind, "subject": msg["subject"], "text": msg["text"], "idempotency_key": idem, "at": iso(now)}
            alerts.append({"at": iso(now), "app_id": app["app_id"], "kind": kind, "subject": msg["subject"]})
            os.makedirs(state_dir, exist_ok=True)
            with open(log, "a") as f:
                f.write(json.dumps({"at": iso(now), "app_id": app["app_id"], "kind": kind, **msg}) + "\n")
        pending = s.get("email_pending")
        if pending:
            if not cfg.get("configured"):
                s["email"] = {"sent": False, "why": cfg.get("why")}
                s["email_pending"] = None           # the board carries it; there is nothing to retry until a key exists
            else:
                ok, err = send(cfg, {"subject": pending["subject"], "text": pending["text"]}, pending["idempotency_key"])
                s["email"] = {"sent": ok, "at": iso(now), "kind": pending["kind"], **({} if ok else {"why": err})}
                s["email_pending"] = None if ok else pending        # retried on the next check
                if alerts and alerts[-1]["app_id"] == app["app_id"] and alerts[-1]["kind"] == pending["kind"]:
                    alerts[-1]["emailed"] = ok
        elif (prev.get("apps") or {}).get(app["app_id"], {}).get("email"):
            s["email"] = prev["apps"][app["app_id"]]["email"]
        new_apps[app["app_id"]] = s
    state = {
        "checked_at": iso(now),
        "every_minutes": 1,
        "down": sorted(a for a, s in new_apps.items() if s["status"] == "down"),
        "apps": new_apps,
        "email": {k: cfg.get(k) for k in ("configured", "why")} | {"to_set": bool(cfg.get("to"))},
        "alerts": alerts[-KEEP_ALERTS:],
        "gap": "This monitor runs on the factory machine, so it cannot report the factory machine itself being down.",
    }
    _write_json(os.path.join(state_dir, "state.json"), state)
    return state


def cmd_check(args):
    os.makedirs(STATE_DIR, exist_ok=True)
    lock = open(os.path.join(STATE_DIR, ".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if not args.quiet:
            print("another check is still running; skipped")
        return 0
    apps = targets()
    state = run_check(apps, datetime.now(timezone.utc))
    if args.json:
        print(json.dumps(state, indent=2))
    elif not args.quiet:
        print_state(state)
    return 0


def print_state(state):
    if not state:
        print("no check has run yet: python3 .claude/scripts/uptime.py check")
        return
    print(f"checked {state.get('checked_at')}")
    for app_id, s in sorted((state.get("apps") or {}).items()):
        mark = {"up": "up  ", "down": "DOWN", "failing": "fail"}.get(s["status"], s["status"])
        extra = f" since {s.get('since')}" if s.get("since") else ""
        print(f"  {mark} {app_id}{extra}  {s.get('address') or ''}")
        for c in s.get("checks") or []:
            print(f"         {c['name']:<9}{c['answer']}  ({c.get('ms')} ms)")
        if s["status"] != "up" and s.get("last_error"):
            print(f"         last error: {s['last_error']}")
    e = state.get("email") or {}
    print(f"email alerts: {'on' if e.get('configured') else 'off: ' + str(e.get('why'))}")
    print("board alerts: on (red banner on the factory board while any app is down)")


# ---- the timer ------------------------------------------------------------------------------------------------------

def unit_files(python=sys.executable, script=os.path.abspath(__file__), root=ROOT, user=False):
    service = "\n".join([
        "[Unit]",
        "Description=Software factory uptime check of every deployed app",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=oneshot",
        f"WorkingDirectory={root}",
        f"ExecStart={python} {script} check --quiet",
        "TimeoutStartSec=120",
        "Nice=10",
        "",
    ])
    timer = "\n".join([
        "[Unit]",
        "Description=Run the software factory uptime check every minute",
        "",
        "[Timer]",
        "OnCalendar=*-*-* *:*:00",
        "AccuracySec=5s",
        "Persistent=false",
        f"Unit={UNIT}.service",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ])
    return {f"{UNIT}.service": service, f"{UNIT}.timer": timer}


def unit_dir(user):
    return os.path.expanduser("~/.config/systemd/user") if user else "/etc/systemd/system"


def on_app_server(state_dir=None):
    """Why this machine is not the factory machine, or ''. The timer belongs on the factory machine only."""
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        return "this copy of the scripts is not the factory's repository (no .git here): an app server's bundle?"
    if not targets(state_dir):
        return "no deployed apps in state/application here"
    try:
        mine = set(subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5).stdout.split())
    except Exception:  # noqa: BLE001
        mine = set()
    base = os.path.join(state_dir or os.path.join(ROOT, "state"), "application")
    for app_id in os.listdir(base):
        try:
            host = (json.load(open(os.path.join(base, app_id, "infrastructure.json"))).get("vm_remote") or {}).get("host")
        except (OSError, ValueError):
            continue
        if host and host in mine:
            return f"this machine is {app_id}'s app server"
    return ""


def install(user, dry_run=False, run=subprocess.run, directory=None, guard=True):
    """Writes the units only when they differ, then reloads and enables. Running it twice changes nothing."""
    if guard and (why := on_app_server()):
        print(f"refusing to install: {why}. The uptime timer runs on the factory machine only.")
        return 2
    directory = directory or unit_dir(user)
    ctl = ["systemctl"] + (["--user"] if user else [])
    changed = []
    for name, text in unit_files(user=user).items():
        path = os.path.join(directory, name)
        current = open(path).read() if os.path.exists(path) else None
        if current != text:
            changed.append(name)
            if not dry_run:
                os.makedirs(directory, exist_ok=True)
                with open(path, "w") as f:
                    f.write(text)
    print(f"{'would write' if dry_run else 'wrote'}: {', '.join(changed)}" if changed else f"unit files already current in {directory}")
    if dry_run:
        for name, text in unit_files(user=user).items():
            print(f"--- {os.path.join(directory, name)}\n{text}")
        return 0
    if changed:
        run(ctl + ["daemon-reload"], check=False)
    r = run(ctl + ["enable", "--now", f"{UNIT}.timer"], check=False, capture_output=True, text=True)
    if getattr(r, "returncode", 0) != 0:
        print(f"systemctl enable failed: {(getattr(r, 'stderr', '') or '').strip()}")
        return 1
    if user:
        print("note: a user timer runs while you are logged in unless lingering is on: `loginctl enable-linger $USER`")
    print(f"{UNIT}.timer enabled: the check runs every minute")
    return 0


def uninstall(user, run=subprocess.run, directory=None):
    directory = directory or unit_dir(user)
    ctl = ["systemctl"] + (["--user"] if user else [])
    run(ctl + ["disable", "--now", f"{UNIT}.timer"], check=False, capture_output=True, text=True)
    removed = []
    for name in unit_files(user=user):
        p = os.path.join(directory, name)
        if os.path.exists(p):
            os.remove(p)
            removed.append(name)
    if removed:
        run(ctl + ["daemon-reload"], check=False)
    print(f"removed: {', '.join(removed)}" if removed else "nothing installed")
    return 0


def timer_status(user=None):
    user = (os.geteuid() != 0) if user is None else user
    ctl = ["systemctl"] + (["--user"] if user else [])
    try:
        active = subprocess.run(ctl + ["is-active", f"{UNIT}.timer"], capture_output=True, text=True, timeout=10).stdout.strip()
        show = subprocess.run(ctl + ["show", f"{UNIT}.service", "-p", "ExecMainExitTimestamp", "-p", "ExecMainStatus",
                                     "-p", "Result"], capture_output=True, text=True, timeout=10).stdout.strip()
        nxt = subprocess.run(ctl + ["show", f"{UNIT}.timer", "-p", "NextElapseUSecRealtime"], capture_output=True,
                             text=True, timeout=10).stdout.strip()
    except Exception as e:  # noqa: BLE001
        return f"timer: unknown ({e})"
    return f"timer: {active or 'not installed'}; {' '.join(show.split())}; {nxt}"


# ---- commands -----------------------------------------------------------------------------------------------------

def cmd_preview(args):
    state = load_state()
    apps = {a["app_id"]: a for a in targets()}
    app_id = args.app or (state.get("down") or [None])[0] or next(iter(apps), None)
    if not app_id or app_id not in apps:
        print(f"no such monitored app: {app_id}")
        return 1
    app, now = apps[app_id], datetime.now(timezone.utc)
    s = (state.get("apps") or {}).get(app_id)
    if not s or s.get("status") != "down":       # a made-up outage, so the text can be seen while everything is up
        began = now - timedelta(minutes=35 if args.kind != "down" else 2)
        fake = [{"name": c["name"], "url": c["url"], "ok": False, "status": None,
                 "answer": f"nothing: it did not answer within {TIMEOUT_S} seconds"} for c in app["checks"]]
        s = {"down_since": iso(began), "checks": fake}
        if args.kind == "recovered":
            s = {"checks": [{"name": c["name"], "url": c["url"], "ok": True, "answer": "OK (HTTP 200)"} for c in app["checks"]],
                 "last_outage": {"from": iso(began), "to": iso(now), "minutes": 35}}
    msg = message(args.kind, app, s, now)
    cfg = email_config()
    print(f"To:      {'the operator (defaults.operator_email)' if cfg['to'] else '(no operator email set)'}")
    print(f"From:    {cfg['from'] or '(no sender set)'}")
    print(f"Subject: {msg['subject']}\n")
    print(msg["text"])
    print(f"\n[preview only: nothing was sent. Email alerts are {'on' if cfg['configured'] else 'off: ' + cfg['why']}]")
    return 0


def cmd_set_email_key(_args):
    if not sys.stdin.isatty():
        print("run this in your own terminal: the key is typed, hidden, never piped or pasted into a chat")
        return 3
    print("Paste a Resend API key with 'Sending access' (resend.com -> API Keys -> Create API Key). It stays hidden.")
    key = getpass.getpass("key: ").strip()
    if not re.match(r"^re_[A-Za-z0-9_\-]{10,}$", key):
        print("that does not look like a Resend key (they start with re_); nothing was saved")
        return 1
    os.makedirs(os.path.dirname(EMAIL_ENV), mode=0o700, exist_ok=True)
    keep = {k: v for k, v in _read_env_file(EMAIL_ENV).items() if k != "RESEND_API_KEY"}
    fd = os.open(EMAIL_ENV, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        for k, v in {**keep, "RESEND_API_KEY": key}.items():
            f.write(f"{k}={v}\n")
    os.chmod(EMAIL_ENV, 0o600)
    print(f"saved in {EMAIL_ENV} (only this machine's account can read it). Email alerts are on from the next check.")
    return 0


def cmd_send_test(args):
    if not args.yes:
        print("this sends one real email to the operator; rerun with --yes only when they asked for a test")
        return 2
    cfg = email_config()
    if not cfg["configured"]:
        print(f"email alerts are off: {cfg['why']}")
        return 1
    now = datetime.now(timezone.utc)
    msg = {"subject": "Test: the factory's uptime alerts reach you",
           "text": "Hello,\n\nThis is a test from the factory's uptime monitor. Nothing is wrong: every app is being "
                   "checked once a minute, and if one stops answering you will get an email like this one.\n"}
    ok, err = send_resend(cfg, msg, f"uptime-test-{iso(now)}")
    print("sent" if ok else f"not sent: {err}")
    return 0 if ok else 1


# ---- self-test: a fake app on a local port, a fake clock, a fake mailbox -------------------------------------------------

def self_test():
    fails = []

    def check(name, cond, detail=""):
        print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))
        if not cond:
            fails.append(name)

    mode = {"web": "ok", "api": "ok", "count": 0}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            mode["count"] += 1
            which = "api" if self.path.startswith("/eve/") else "web"
            m = mode[which]
            if m == "hang":
                time.sleep(1.5)
                m = "ok"
            if m == "flaky":                       # fails once, then answers: the retry absorbs it
                mode[which] = "ok"
                m = "502"
            if m == "notok":
                body, code = json.dumps({"ok": False, "db": {"ok": False, "detail": "password=hunter2"}}).encode(), 200
            elif m == "502":
                body, code = b"<html>bad gateway</html>", 502
            else:
                body, code = json.dumps({"ok": True}).encode(), 200
            try:
                self.send_response(code)
            except (BrokenPipeError, ConnectionResetError):
                return
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass                                # the probe gave up first (the timeout case)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with tempfile.TemporaryDirectory() as d:
        # state: one self-hosted app (web + api) pointing at the fake server, one retired app, one with no address
        st = os.path.join(d, "state")
        for app_id, appj, infra in (
            ("demo_vm", {"status": "stamped"}, {"target": "vm_remote", "vm_remote": {"production_url": base}}),
            ("old", {"status": "retired"}, {"target": "vercel", "vercel": {"production_url": base}}),
            ("nourl", {"status": "stamped"}, {"target": "vercel", "vercel": {}}),
        ):
            os.makedirs(os.path.join(st, "application", app_id))
            json.dump(appj, open(os.path.join(st, "application", app_id, "application.json"), "w"))
            json.dump(infra, open(os.path.join(st, "application", app_id, "infrastructure.json"), "w"))
        apps = targets(st)
        check("targets: retired and address-less apps are skipped", [a["app_id"] for a in apps] == ["demo_vm"], apps)
        check("targets: a self-hosted app has web and api pages",
              [c["url"] for c in apps[0]["checks"]] == [f"{base}/api/ops/health", f"{base}/eve/v1/health"], apps)
        check("the board's Vercel page set", [c["name"] for c in health_checks({}, {"target": "vercel", "vercel": {
            "production_url": "https://a.example.test", "api_url": "https://b.example.test", "workflow_url": "https://c.example.test"}})]
              == ["web", "api", "workflow"])

        # probing: ok, an error page, a timeout, {"ok": false} with a secret in its detail, a blip absorbed by the retry
        r = probe(f"{base}/api/ops/health", 1, 0)
        check("a 200 page is up", r["ok"] and r["status"] == 200, r)
        mode["web"] = "502"
        r = probe(f"{base}/api/ops/health", 1, 0)
        check("a 502 page is failing, in words", not r["ok"] and r["answer"] == "an error page (HTTP 502 Bad Gateway)" and r.get("tries") == 2, r)
        mode["web"] = "hang"
        r = probe(f"{base}/api/ops/health", 0.5, 0)
        check("no answer within the timeout is failing", not r["ok"] and "did not answer within 0.5 seconds" in r["answer"], r)
        mode["web"] = "notok"
        r = probe(f"{base}/api/ops/health", 1, 0)
        check('{"ok": false} is failing and names the part, never its detail',
              not r["ok"] and r["answer"] == "it is running but reports a problem with: db" and "hunter2" not in json.dumps(r), r)
        mode["web"] = "flaky"
        r = probe(f"{base}/api/ops/health", 1, 0)
        check("one retry: a single failed try is not a failure", r["ok"], r)
        closed = socket.socket(); closed.bind(("127.0.0.1", 0)); port = closed.getsockname()[1]; closed.close()
        r = probe(f"http://127.0.0.1:{port}/api/ops/health", 1, 0)
        check("a refused connection says the app is probably not running", not r["ok"] and "refused" in r["answer"], r)
        mode["web"] = "ok"

        # the state machine over a fake clock, with a fake mailbox and a fake key in the config
        sd = os.path.join(d, "runs")
        sent = []
        secret_key = "re_FAKEKEY_selftest_0123456789"
        cfg = {"configured": True, "why": "", "to": "operator@example.test", "from": "Factory <alerts@example.test>", "key": secret_key}
        outbox_ok = {"v": True}

        def send(c, msg, idem):
            sent.append({**msg, "idem": idem})
            return (True, "") if outbox_ok["v"] else (False, "could not reach the email service: timed out")

        t0 = datetime(2026, 10, 9, 10, 0, tzinfo=timezone.utc)
        minute = lambda n: t0 + timedelta(minutes=n)
        go = lambda n: run_check(apps, minute(n), sd, send, cfg, 1, 0)

        s = go(0)
        check("first check: up, nothing sent", s["apps"]["demo_vm"]["status"] == "up" and not sent, s["apps"]["demo_vm"])
        mode["web"] = "502"
        s = go(1)
        check("one failing check: watched, not down, no alert", s["apps"]["demo_vm"]["status"] == "failing" and not sent and s["down"] == [], s["apps"]["demo_vm"])
        s = go(2)
        a = s["apps"]["demo_vm"]
        check("two failing checks in a row: down, one alert", a["status"] == "down" and len(sent) == 1 and s["down"] == ["demo_vm"], (a, sent))
        check("down since the FIRST failing check", a["down_since"] == iso(minute(1)) and a["since"] == iso(minute(1)), a)
        check("the down alert says which app, which address, since when, what it answered",
              sent[0]["subject"] == "Down: demo_vm is not answering (since 10:01 UTC)"
              and f"Address:      {base}" in sent[0]["text"] and "Down since:   9 Oct 2026, 10:01 UTC (1 minute so far)" in sent[0]["text"]
              and f"the website ({base}/api/ops/health): an error page (HTTP 502 Bad Gateway)" in sent[0]["text"]
              and "The factory is looking at it." in sent[0]["text"], sent[0])
        for n in range(3, 32):
            go(n)
        check("no repeat before 30 minutes", len(sent) == 1, [m["subject"] for m in sent])
        go(32)
        check("a repeat at 30 minutes, saying for how long", len(sent) == 2 and sent[1]["subject"] == "Still down: demo_vm (for 31 minutes now)", [m["subject"] for m in sent])
        for n in range(33, 62):
            go(n)
        check("the next repeat waits another 30 minutes", len(sent) == 2, [m["subject"] for m in sent])
        go(62)
        check("and comes at 60", len(sent) == 3, [m["subject"] for m in sent])
        outbox_ok["v"] = False                      # the email service is unreachable for one run
        mode["web"] = "ok"
        s = go(66)
        a = s["apps"]["demo_vm"]
        check("recovery: up again with the outage's length", a["status"] == "up" and a["last_outage"]["minutes"] == 65, a)
        check("a failed send is kept and the board state says so", a["email_pending"] and a["email"]["sent"] is False, a.get("email"))
        outbox_ok["v"] = True
        s = go(67)
        rec = [m for m in sent if m["subject"].startswith("Back up")]
        check("the recovery email is retried on the next check with the same idempotency key",
              len(rec) == 2 and rec[0]["idem"] == rec[1]["idem"] and s["apps"]["demo_vm"]["email"]["sent"] is True and not s["apps"]["demo_vm"]["email_pending"], rec)
        check("the recovery email gives the duration", rec[-1]["subject"] == "Back up: demo_vm (it was down 1 hour 5 minutes)"
              and "Down for:     1 hour 5 minutes" in rec[-1]["text"], rec[-1])
        go(68)
        check("no more emails once it is up", len([m for m in sent if m["subject"].startswith("Back up")]) == 2)

        # no secrets anywhere the monitor writes or sends
        mode["web"] = "notok"
        go(69); go(70)
        everything = json.dumps(sent) + open(os.path.join(sd, "state.json")).read() + open(os.path.join(sd, "alerts.jsonl")).read()
        check("no key, no response detail in emails, state or the log", secret_key not in everything and "hunter2" not in everything)
        check("scrub hides keys, bearer tokens and URL passwords",
              "[hidden]" in scrub("Bearer abc.def") and "re_ABCDEFGHIJKL" not in scrub("key re_ABCDEFGHIJKL")
              and "pw" not in scrub("postgres://u:pw@h/db"))
        mode["web"] = "ok"

        # email off (no key): the board still carries the alert, nothing is attempted
        sd2 = os.path.join(d, "runs2"); sent.clear()
        off = {"configured": False, "why": "this machine has no email-sending key of its own yet", "to": "", "from": "", "key": ""}
        mode["web"] = "502"
        run_check(apps, minute(0), sd2, send, off, 1, 0)
        s = run_check(apps, minute(1), sd2, send, off, 1, 0)
        check("without a key: down is in state for the board, the reason is recorded, nothing is sent",
              s["down"] == ["demo_vm"] and s["email"]["configured"] is False and not sent
              and s["apps"]["demo_vm"]["email"]["why"].startswith("this machine has no") and s["alerts"][-1]["kind"] == "down")
        mode["web"] = "ok"

        # the everything-failing hint (two apps both failing at once)
        two = apps + [{**apps[0], "app_id": "demo_b"}]
        res = {a["app_id"]: [{"name": "web", "url": "u", "ok": False, "answer": "nothing"}] for a in two}
        sd3 = os.path.join(d, "runs3"); sent.clear()
        run_check(two, minute(0), sd3, send, cfg, results=res)
        run_check(two, minute(1), sd3, send, cfg, results=res)
        check("every app failing at once says it may be this machine's connection",
              len(sent) == 2 and all("factory machine's own internet" in m["text"] for m in sent))

        # email config: the placeholder operator address is not an address; a key from the env file is read
        st2 = os.path.join(d, "cfg"); os.makedirs(st2)
        json.dump({"defaults": {"operator_email": "operator@example.com", "notify_domain": "example.test"}}, open(os.path.join(st2, "factory.json"), "w"))
        was = os.environ.pop("FACTORY_LOCAL", None)
        try:
            envf = os.path.join(d, "uptime.env")
            c = email_config(st2, envf)
            check("placeholder operator email: email off, and why", not c["configured"] and "operator email" in c["why"], c["why"])
            json.dump({"defaults": {"operator_email": "op@example.test"}}, open(os.path.join(st2, "factory.local.json"), "w"))
            c = email_config(st2, envf)
            check("no key on this machine: email off, and how to add one", not c["configured"] and "set-email-key" in c["why"], c["why"])
            open(envf, "w").write(f"RESEND_API_KEY={secret_key}\n")
            c = email_config(st2, envf)
            check("a key in the machine's own file turns email on, sender from notify_domain",
                  c["configured"] and c["from"] == "Software factory <alerts@example.test>", {k: v for k, v in c.items() if k != "key"})
        finally:
            if was is not None:
                os.environ["FACTORY_LOCAL"] = was

        # install / uninstall into a temp unit directory with a recording systemctl: idempotent
        calls = []

        class R:
            returncode, stdout, stderr = 0, "", ""

        rec_run = lambda argv, **k: calls.append(argv) or R()
        ud = os.path.join(d, "units")
        install(False, run=rec_run, directory=ud, guard=False)
        check("install writes a service and a every-minute timer, reloads, enables",
              sorted(os.listdir(ud)) == [f"{UNIT}.service", f"{UNIT}.timer"] and ["systemctl", "daemon-reload"] in calls
              and ["systemctl", "enable", "--now", f"{UNIT}.timer"] in calls
              and "OnCalendar=*-*-* *:*:00" in open(os.path.join(ud, f"{UNIT}.timer")).read()
              and " check --quiet" in open(os.path.join(ud, f"{UNIT}.service")).read(), calls)
        calls.clear()
        install(False, run=rec_run, directory=ud, guard=False)
        check("install twice: no file rewritten, no reload", ["systemctl", "daemon-reload"] not in calls, calls)
        uninstall(False, run=rec_run, directory=ud)
        check("uninstall removes both units", os.listdir(ud) == [])
    srv.shutdown()
    print(f"uptime self-test: {'ok' if not fails else f'{len(fails)} failed'}")
    return 1 if fails else 0


def main():
    if "--self-test" in sys.argv[1:]:
        return self_test()
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check"); c.add_argument("--json", action="store_true"); c.add_argument("--quiet", action="store_true")
    s = sub.add_parser("status"); s.add_argument("--json", action="store_true")
    pv = sub.add_parser("preview-alert"); pv.add_argument("kind", nargs="?", default="down", choices=["down", "still_down", "recovered"]); pv.add_argument("--app")
    i = sub.add_parser("install"); i.add_argument("--user", action="store_true"); i.add_argument("--dry-run", action="store_true")
    u = sub.add_parser("uninstall"); u.add_argument("--user", action="store_true")
    sub.add_parser("set-email-key")
    t = sub.add_parser("send-test-email"); t.add_argument("--yes", action="store_true")
    args = p.parse_args()
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "status":
        state = load_state()
        if args.json:
            print(json.dumps(state, indent=2))
        else:
            print_state(state)
            print(timer_status())
            print("gap: this runs on the factory machine, so it cannot report the factory machine itself being down")
        return 0
    if args.cmd == "preview-alert":
        return cmd_preview(args)
    if args.cmd == "install":
        return install(args.user or os.geteuid() != 0, args.dry_run)
    if args.cmd == "uninstall":
        return uninstall(args.user or os.geteuid() != 0)
    if args.cmd == "set-email-key":
        return cmd_set_email_key(args)
    if args.cmd == "send-test-email":
        return cmd_send_test(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
