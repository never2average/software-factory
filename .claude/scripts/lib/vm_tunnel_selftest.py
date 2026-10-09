#!/usr/bin/env python3
"""Offline checks for three additions to the vm_remote target, run as part of `vm_remote.py --self-test`:

  push    desktop-notification keys minted on the server and given only to the service that reads each
  prune   the nightly sandbox prune (mold_v1-153), on a fixture directory tree with a stand-in `msb`
  tunnel  the private administration tunnel (mold_v1-156) and its lockout guard

NOTHING HERE TOUCHES A SERVER OR CHANGES THIS MACHINE. The server's tunnel script is really executed, but against
stand-in `ufw`, `systemctl`, `systemd-run`, `wg`, `ip` and `apt-get` commands in a temp directory, with a temp
directory where /etc/wireguard would be; the factory-side sequence runs against a model of the server.
"""
import datetime, json, os, re, shutil, stat, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
import vm_remote as V
import vm_tunnel as W
import factory as F
import provision as P
import lane_url
import vm_remote_selftest as B

CP = subprocess.CompletedProcess
MOLD = os.path.join(ROOT, "molds", "mold_v1", "codebase")
SCH = lambda: B.load(os.path.join(ROOT, "state/application/app_id/infrastructure.schema.json"))
VAPID_PUB, VAPID_PRIV = "PUSHPUB-" + "p" * 79, "PUSHPRIV-" + B.SECRET

# ---- A: desktop notifications ------------------------------------------------------------------------------------
def push(check, tmp):
    S = B._settings()
    check("push: an app whose mold can send notifications and whose state names an operator gets them", S["push"] is True and V.push_subject(S) == "mailto:operator@example.com")
    S0 = B._settings(lambda d: d["application"]["workspace"].update(operator_self={"email": ""}))
    check("push:   ...and one with no operator email does not (the push services need somebody to contact)", S0["push"] is False and V.push_subject(S0) == "")
    S1 = B._settings(lambda d: d["application"].update(mold_id="mold_without_push"))
    check("push:   ...nor one whose mold has no agent/lib/web-push.ts", S1["push"] is False)
    mint = lambda S_: next(s for s in V.plan(S_, MOLD) if s["id"] == "env-mint")["argv"][-1]
    check("push: the env-mint step carries the subject (the operator's email, not a secret) and no key", mint(S).endswith("--push-subject mailto:operator@example.com") and "VAPID" not in mint(S), mint(S))
    check("push:   ...and nothing extra for an app without notifications", "--push-subject" not in mint(S0))
    f = os.path.join(tmp, "etc", "push", "env"); calls = []
    def vp(): calls.append(1); return VAPID_PUB, VAPID_PRIV
    jp = lambda: ("PRIVKEYBASE64", "PUBKEYBASE64")
    made = V.env_mint(f, jwt_pair=jp, push_subject="mailto:operator@example.com", vapid_pair=vp)
    check("push: env-mint mints the pair on the machine that keeps it, with the subject", set(V.PUSH) <= set(made) and V.env_read(f)["VAPID_PUBLIC_KEY"] == VAPID_PUB
          and V.env_read(f)["VAPID_SUBJECT"] == "mailto:operator@example.com" and stat.S_IMODE(os.stat(f).st_mode) == 0o600, made)
    kept = dict(V.env_read(f))
    check("push:   ...a second run mints nothing and keeps the pair (a new one would orphan every subscribed browser)",
          V.env_mint(f, jwt_pair=jp, push_subject="mailto:operator@example.com", vapid_pair=vp) == [] and V.env_read(f) == kept and len(calls) == 1)
    check("push:   ...a changed operator email changes the subject only", V.env_mint(f, jwt_pair=jp, push_subject="mailto:new@example.com", vapid_pair=vp) == ["VAPID_SUBJECT"]
          and V.env_read(f)["VAPID_PRIVATE_KEY"] == VAPID_PRIV and len(calls) == 1)
    half = dict(V.env_read(f)); half.pop("VAPID_PRIVATE_KEY"); V.env_write(f, half)
    check("push:   ...half a pair is re-minted as a pair", V.env_mint(f, jwt_pair=jp, push_subject="mailto:new@example.com", vapid_pair=vp) == list(V.PUSH_PAIR)[::-1] and len(calls) == 2)
    check("push:   ...without a subject no push name is minted (an app without notifications)", not (set(V.env_mint(os.path.join(tmp, "etc", "push0", "env"), jwt_pair=jp, vapid_pair=vp)) & set(V.PUSH)))
    out, _ = B.quiet(V.env_mint, f, jp, "mailto:x@y.z; rm -rf /", vp)
    check("push:   ...and a subject that is not an email address is refused", isinstance(out, SystemExit) and "nothing was minted" in str(out), out)
    if shutil.which("node"):
        import base64
        pub, priv = V._vapid_pair(); pad = lambda s: s + "=" * (-len(s) % 4)
        check("push: the real minter returns the shapes agent/lib/web-push.ts accepts (65-byte point, 32-byte scalar, base64url)",
              len(base64.urlsafe_b64decode(pad(pub))) == 65 and len(base64.urlsafe_b64decode(pad(priv))) == 32)
        f2 = os.path.join(tmp, "etc", "push-cli", "env")
        r = subprocess.run([sys.executable, os.path.join(HERE, "vm_remote.py"), "env-mint", "--file", f2, "--push-subject", "mailto:operator@example.com"], capture_output=True, text=True)
        vals = V.env_read(f2)
        check("push: the env-mint command prints the NAMES it minted and no value", r.returncode == 0 and "VAPID_PRIVATE_KEY" in r.stdout and vals.get("VAPID_PRIVATE_KEY")
              and not any(v in r.stdout + r.stderr for k, v in vals.items() if k != "VAPID_SUBJECT"), r.stdout + r.stderr)
    spec = V.service_env_spec(S); master = dict(B._master_values(S), VAPID_PUBLIC_KEY=VAPID_PUB, VAPID_PRIVATE_KEY=VAPID_PRIV, VAPID_SUBJECT="mailto:operator@example.com")
    v = V.split_values(master, spec)
    check("push: the web app's file gets the public key only (it serves it and answers the subscribe route)", v["web"].get("VAPID_PUBLIC_KEY") == VAPID_PUB
          and "VAPID_PRIVATE_KEY" not in v["web"] and "VAPID_SUBJECT" not in v["web"] and VAPID_PRIV not in json.dumps(v["web"]), sorted(k for k in v["web"] if "VAPID" in k))
    check("push:   ...the agent's file gets all three (it sends)", all(v["api"].get(k) == master[k] for k in V.PUSH))
    check("push:   ...the task-workflow service and the cron calls get none", not any(k in v[s] for s in ("workflow", "cron") for k in V.PUSH))
    bad = json.loads(json.dumps(spec)); bad["web"]["drop"] = [n for n in bad["web"]["drop"] if n != "VAPID_PRIVATE_KEY"]
    d = os.path.join(tmp, "etc", "push-split"); mf = os.path.join(d, "env"); V.env_write(mf, master)
    out, printed = B.quiet(V.env_split, mf, d, bad)
    check("push:   ...a spec that would hand the web app the private key is refused and nothing is written", isinstance(out, SystemExit) and "notification private key" in str(out)
          and not os.path.exists(os.path.join(d, "web.env")) and VAPID_PRIV not in printed, out)
    if not V.mold_gaps(MOLD):
        web_src = B._source_text(MOLD, ("app", "lib", "services/task-workflow/lib", "services/task-workflow/app"))
        agent_src = B._source_text(MOLD, ("agent",))
        check("push: in the snapshot, the web app reads VAPID_PUBLIC_KEY and never the private key or the subject", re.search(r"\bVAPID_PUBLIC_KEY\b", web_src) is not None
              and not re.search(r"process\.env\.VAPID_(PRIVATE_KEY|SUBJECT)\b", web_src))
        check("push:   ...and the agent reads all three", all(re.search(r"\b" + k + r"\b", agent_src) for k in V.PUSH))
    crons = list(V.CRONS); h = V.health_sh(S, crons)
    check("push: the health step reads NAMES from the two running processes, never a value", all(k in h for k in ("WEB_PUSH_PUBLIC=", "WEB_PUSH_PRIVATE=", "API_PUSH=")) and "grep -q \"^$2=\"" in h)
    ok = V.parse_kv(B.fx("health-ok.txt"))
    for label, kw, needle in (("a web app that holds the notification private key", {"WEB_PUSH_PRIVATE": "yes"}, "only the agent"),
                              ("a web app without the public key", {"WEB_PUSH_PUBLIC": "no"}, "desktop notifications are off"),
                              ("an agent with only part of the three", {"API_PUSH": "partial"}, "only some")):
        hv, bad_ = V.health_verdict(S, dict(ok, **kw), crons)
        check(f"push: health refuses {label}", any(needle in x for x in bad_), bad_)
    hv, bad_ = V.health_verdict(S0, dict(ok, WEB_PUSH_PUBLIC="no", API_PUSH="no"), crons)
    check("push:   ...and says nothing about an app that has no notifications", bad_ == [] and "push" not in hv, bad_)
    lines = []; V.print_plan(S, V.plan(S, MOLD), V.bundle(S, crons), crons, [], out=lines.append); text = "\n".join(lines)
    check("push: the dry run names the pair as minted on the server and shows no key", "desktop notifications" in text and "VAPID_PRIVATE_KEY" in text and "--push-subject mailto:operator@example.com" in text)

# ---- C: sandbox pruning (mold_v1-153) ---------------------------------------------------------------------------
NOW = datetime.datetime(2026, 10, 4, 12, 0, tzinfo=datetime.timezone.utc).timestamp()
DAY = 86400
SES = lambda tag: next(r["name"] for r in B.load(os.path.join(B.FX, "sandbox-store", "msb-list.json")) if tag in r["name"])
SNAP = lambda tag: next(r["name"] for r in B.load(os.path.join(B.FX, "sandbox-store", "msb-snapshot-list.json"))["snapshots"] if tag in r.get("name", ""))
ORPHAN = "eve-sbx-tpl-tmp-1c33orphan0000000000000000000cc"

def _store(root):
    """A service user's home with a .microsandbox like the one measured on the first server, at fixed ages."""
    store = os.path.join(root, ".microsandbox")
    def make(kind, name, age_s, kb=64):
        d = os.path.join(store, kind, name); os.makedirs(d)
        f = os.path.join(d, "upper.ext4" if kind == "sandboxes" else "disk.img")
        with open(f, "wb") as fh: fh.write(b"x" * kb * 1024)
        for p in (f, d): os.utime(p, (NOW - age_s, NOW - age_s))
    make("sandboxes", SES("old"), 10 * DAY, 256); make("sandboxes", SES("new"), 1 * DAY); make("sandboxes", SES("run"), 30 * DAY)
    make("sandboxes", SES("live"), 30 * DAY); make("sandboxes", SES("crash"), 20 * DAY); make("sandboxes", SES("noage"), 0)
    shutil.rmtree(os.path.join(store, "sandboxes", SES("noage")))            # msb knows it; nothing on disk, no time in its row
    make("sandboxes", SES("odd"), 30 * DAY)
    make("sandboxes", SES("tmp-1a11old"), 3 * 3600); make("sandboxes", SES("tmp-1b22fresh"), 600); make("sandboxes", ORPHAN, 5 * 3600)
    make("sandboxes", "eve-sbx-ses-unlisted0000000000000000000000", 40 * DAY)   # a session directory msb has no record of
    make("snapshots", SNAP("old"), 10 * DAY, 128); make("snapshots", SNAP("new"), 1 * DAY); make("snapshots", SNAP("parent"), 30 * DAY)
    make("snapshots", SNAP("template"), 60 * DAY, 512)
    os.makedirs(os.path.join(store, "bin"))
    return store

def _msb(calls, fail=(), boxes=None, snaps=None):
    def msb(args):
        calls.append(list(args))
        if args[:1] == ["list"]: return CP(args, 0, boxes if boxes is not None else B.fx("sandbox-store/msb-list.json"), "")
        if args[:2] == ["snapshot", "list"]: return CP(args, 0, snaps if snaps is not None else B.fx("sandbox-store/msb-snapshot-list.json"), "")
        if any(x in args[-1] for x in fail): return CP(args, 1, "", "error: snapshot has indexed children; pass --force to remove")
        return CP(args, 0, "", "")
    return msb

def prune(check, tmp):
    home = os.path.join(tmp, "prune-home"); store = _store(home); said, calls = [], []
    quiet_procs = lambda: ["/usr/bin/node .output/server/index.mjs", f"msb supervisor --name {SES('live')}", f"msb supervisor --name {SES('run')} --vcpus 2"]
    tree_before = B.digest(store)
    rc = V.sandbox_prune(home, 7, dry_run=True, now=NOW, msb=_msb(calls), procs=quiet_procs, say=said.append); text = "\n".join(said)
    check("prune: the dry run asks msb for its two lists and removes nothing", rc == 0 and calls == [["list", "--format", "json"], ["snapshot", "list", "--format", "json"]] and B.digest(store) == tree_before, calls)
    would = sorted(re.search(r"(eve-sbx-[a-z0-9-]+)", l).group(1) for l in said if "would remove" in l)
    want = sorted([SES("old"), SES("crash"), SES("nodir"), SES("tmp-1a11old"), ORPHAN, SNAP("old"), SNAP("parent")])
    check("prune:   ...and lists exactly what it would remove: old stopped sessions, old state snapshots, old template-build leftovers", would == want, would)
    check("prune:   ...with the bytes each holds and the total", "MB)" in text and "DRY RUN (nothing is removed)" in text and "MB to free" in text and "untouched for 10.0 days" in text, text[-500:])
    said.clear(); calls.clear()
    rc = V.sandbox_prune(home, 7, now=NOW, msb=_msb(calls), procs=quiet_procs, say=said.append); text = "\n".join(said)
    removed = [c for c in calls if c[0] == "remove" or c[:2] == ["snapshot", "remove"]]
    check("prune: the real run removes them with msb's own commands, sandboxes before snapshots, never with --force",
          rc == 0 and [c[-1] for c in removed] == [SES("old"), SES("crash"), SES("nodir"), SES("tmp-1a11old"), SNAP("old"), SNAP("parent")]
          and not any("--force" in c or "-f" in c for c in calls) and [c[0] for c in removed].index("snapshot") == 4, removed)
    names = " ".join(" ".join(c) for c in removed)
    check("prune:   ...never a running sandbox, whatever its age", SES("run") not in names)
    check("prune:   ...never one a live process still names, even if msb calls it stopped", SES("live") not in names)
    check("prune:   ...never one in a state it does not know (paused)", SES("odd") not in names)
    check("prune:   ...never a session used inside the retention period", SES("new") not in names and SNAP("new") not in names)
    check("prune:   ...never one whose age cannot be read (no directory, no time in msb's row)", SES("noage") not in names)
    check("prune:   ...NEVER a template: not as a sandbox, not as a snapshot", "eve-sbx-tpl-9z99" not in names and os.path.isdir(os.path.join(store, "snapshots", SNAP("template"))))
    check("prune:   ...never something that is not eve's", "somebody-elses" not in names)
    check("prune:   ...a template-build leftover newer than an hour is left", SES("tmp-1b22fresh") not in names and os.path.isdir(os.path.join(store, "sandboxes", SES("tmp-1b22fresh"))))
    check("prune:   ...a template-build DIRECTORY msb has no record of is the one thing deleted directly", not os.path.exists(os.path.join(store, "sandboxes", ORPHAN)))
    check("prune:   ...a SESSION directory msb has no record of is not (only msb removes sessions)", os.path.isdir(os.path.join(store, "sandboxes", "eve-sbx-ses-unlisted0000000000000000000000")))
    check("prune:   ...and it says what it kept and what the store holds now", "kept:" in text and "templates" in text and "The sandbox store now holds" in text, said[-1])
    home2 = os.path.join(tmp, "prune-home2"); store2 = _store(home2); said, calls = [], []
    rc = V.sandbox_prune(home2, 7, now=NOW, msb=_msb(calls), procs=lambda: quiet_procs() + ["node scripts/sandbox-prewarm-serial.mjs --link-runtime"], say=said.append)
    check("prune: while a prewarm is running no template build is touched, listed or not", rc == 0 and not any("tpl-tmp" in " ".join(c) for c in calls)
          and os.path.isdir(os.path.join(store2, "sandboxes", ORPHAN)) and "a prewarm is running" in said[-1], said[-1])
    for label, kw in (("an answer that is not JSON", {"boxes": "error: database is locked"}), ("an answer that is not a list", {"boxes": '{"a": 1}'})):
        said, calls = [], []; before = B.digest(store2)
        rc = V.sandbox_prune(home2, 7, now=NOW, msb=_msb(calls, **kw), procs=quiet_procs, say=said.append)
        check(f"prune: {label} from `msb list` removes NOTHING and exits non-zero", rc == 1 and len(calls) == 1 and B.digest(store2) == before and "nothing was removed" in said[0], said)
    said, calls = [], []
    rc = V.sandbox_prune(home2, 7, now=NOW, msb=_msb(calls, snaps="garbage"), procs=quiet_procs, say=said.append)
    check("prune: an unreadable snapshot list means no snapshot is considered; sandboxes still are", rc == 0 and not any(c[:2] == ["snapshot", "remove"] for c in calls) and any(c[0] == "remove" for c in calls), calls)
    home3 = os.path.join(tmp, "prune-home3"); _store(home3); said, calls = [], []
    rc = V.sandbox_prune(home3, 7, now=NOW, msb=_msb(calls, fail=("parent",)), procs=quiet_procs, say=said.append)
    check("prune: a snapshot msb refuses (a sandbox was started from it) is LEFT and reported, and the run exits non-zero", rc == 1 and any("LEFT session snapshot" in l and "indexed children" in l for l in said), said[-3:])
    said, calls = [], []
    rc = V.sandbox_prune(home3, 0, now=NOW, msb=_msb(calls), procs=quiet_procs, say=said.append)
    check("prune: a retention of 0 days is refused before msb is even asked", rc == 2 and calls == [])
    said, calls = [], []; home4 = os.path.join(tmp, "prune-home4"); _store(home4)
    rc = V.sandbox_prune(home4, 30, now=NOW, msb=_msb(calls), procs=quiet_procs, say=said.append)
    check("prune: a longer retention keeps what a shorter one removes", SES("old") not in " ".join(" ".join(c) for c in calls) and SES("nodir") in " ".join(" ".join(c) for c in calls))
    # the command itself, as the timer runs it, against a stand-in msb executable
    home5 = os.path.join(tmp, "prune-home5"); store5 = _store(home5); fake = os.path.join(store5, "bin", "msb"); log = os.path.join(home5, "msb-calls.log")
    open(fake, "w").write(f"#!/bin/sh\necho \"$*\" >> {log}\ncase \"$1 $2\" in\n  'list --format') cat {B.FX}/sandbox-store/msb-list.json ;;\n  'snapshot list') cat {B.FX}/sandbox-store/msb-snapshot-list.json ;;\nesac\n")
    os.chmod(fake, 0o755)
    r = subprocess.run([sys.executable, os.path.join(HERE, "vm_remote.py"), "sandbox-prune", "--home", home5, "--retention-days", "7", "--dry-run"], capture_output=True, text=True)
    check("prune: `vm_remote.py sandbox-prune --dry-run` runs ~/.microsandbox/bin/msb, lists, and removes nothing", r.returncode == 0 and "DRY RUN" in r.stdout and "would remove" in r.stdout
          and open(log).read().split("\n")[:2] == ["list --format json", "snapshot list --format json"] and "remove" not in open(log).read().replace("would remove", ""), r.stdout + r.stderr)
    # units, health, state rules, the factory's command
    S = B._settings(); crons = list(V.CRONS); U = V.unit_files(S, crons)
    svc, tim = U[f"{S['unit']}-sandbox-prune.service"], U[f"{S['unit']}-sandbox-prune.timer"]
    check("prune: the unit runs the pruner as the service user with the state's retention, never as root", "User=sfapp" in svc and "User=root" not in svc and "Environment=HOME=/var/lib/sfapp" in svc
          and svc.count("ExecStart=") == 1 and "sandbox-prune --home /var/lib/sfapp --retention-days 7" in svc and "--dry-run" not in svc, svc)
    check("prune:   ...on a nightly timer that catches up after a reboot", "OnCalendar=*-*-* 03:17:00" in tim and "Persistent=true" in tim and f"Unit={S['unit']}-sandbox-prune.service" in tim)
    S30 = B._settings(lambda d: d["infrastructure"]["vm_remote"]["sandbox"].update(retention_days=30, disk_alarm_percent=70))
    check("prune:   ...and vm_remote.sandbox.retention_days changes it", "--retention-days 30" in V.unit_files(S30, crons)[f"{S['unit']}-sandbox-prune.service"] and S30["disk_alarm"] == 70 and S["retention_days"] == 7 and S["disk_alarm"] == 80)
    check("prune:   ...the units step turns the timer on, and does not run a prune during a deploy", f"systemctl enable --now {S['unit']}-sandbox-prune.timer" in V.units_sh(S, crons)
          and "sandbox-prune.service" not in V.units_sh(S, crons))
    if shutil.which("systemd-analyze"):
        d = os.path.join(tmp, "prune-units"); os.makedirs(d)
        for n in (f"{S['unit']}-sandbox-prune.service", f"{S['unit']}-sandbox-prune.timer"): open(os.path.join(d, n), "w").write(U[n])
        r = subprocess.run(["systemd-analyze", "verify", os.path.join(d, f"{S['unit']}-sandbox-prune.timer")], capture_output=True, text=True, env=dict(os.environ, SYSTEMD_UNIT_PATH=d + ":"))
        bad_lines = [l for l in (r.stdout + r.stderr).splitlines() if "sandbox-prune" in l and "sfapp" not in l and "is not executable" not in l and "does not exist" not in l]
        check("prune:   ...and systemd's own checker accepts the timer and its service", not bad_lines, bad_lines)
    ok = V.parse_kv(B.fx("health-ok.txt")); h = V.health_sh(S, crons)
    check("prune: the health step measures the disk and the sandbox store", "DISK_USED_PCT=" in h and "SANDBOX_STORE_KB=" in h and "/var/lib/sfapp/.microsandbox" in h and "PRUNE_TIMER=" in h)
    hv, bad = V.health_verdict(S, dict(ok, DISK_USED_PCT="83"), crons)
    check("prune: a disk past the alarm line (80%) is a WARNING, said as one, and does not fail the deploy", bad == [] and hv["disk_percent"] == 83
          and any("WARNING, not a failure" in w and "83%" in w and "--prune-sandboxes" in w for w in V.health_warnings(S, dict(ok, DISK_USED_PCT="83"))), V.health_warnings(S, dict(ok, DISK_USED_PCT="83")))
    check("prune:   ...below the line there is no warning; the line comes from state", V.health_warnings(S, ok) == [] and V.health_warnings(S30, dict(ok, DISK_USED_PCT="72")) != [])
    hv, bad = V.health_verdict(S, dict(ok, DISK_USED_PCT="96"), crons)
    check("prune:   ...at 95% it FAILS, saying how much the sandboxes hold", any("96% full" in x and "15.1 GB" in x for x in bad) and V.health_warnings(S, dict(ok, DISK_USED_PCT="96")) == [], bad)
    hv, bad = V.health_verdict(S, dict(ok, PRUNE_TIMER="disabled"), crons)
    check("prune:   ...and a prune timer that is not on fails it too", any("prune timer is not on" in x for x in bad), bad)
    check("prune:   ...the store's size is recorded with the health", hv["sandbox_store_mb"] == 15462)
    res = V.deploy(S, MOLD, crons, runner=lambda st, stdin=None: CP(st["argv"], 0, {"qualify": B.fx("qualify-ok.txt"), "env-names": "\n".join(V.operator_names(S)),
                   "db-chain": "EVIDENCE " + json.dumps({"protected": 58}), "health": B.fx("health-ok.txt").replace("DISK_USED_PCT=21", "DISK_USED_PCT=88")}.get(st["id"], "ok"), ""),
                   resolver=lambda d: ["203.0.113.10"], read_health=lambda u: ("200", B.HEALTH_DOC, ""), say=lambda *_: None, bundle_dir=os.path.join(tmp, "deploy-disk"), wait=lambda s: None)
    check("prune: a deploy on a server at 88% is accepted and carries the warning", res["problems"] == [] and len(res["warnings"]) == 1 and res["health"]["disk_percent"] == 88, res.get("warnings"))
    sch = SCH()
    for label, mut, needle in (("a retention of 0 days", lambda d: d["infrastructure"]["vm_remote"]["sandbox"].update(retention_days=0), "retention_days"),
                               ("a disk alarm at 99%", lambda d: d["infrastructure"]["vm_remote"]["sandbox"].update(disk_alarm_percent=99), "disk_alarm_percent")):
        d = B.fixture_docs(); mut(d)
        check(f"prune: validate refuses {label}", any(needle in x for x in F._vm_remote("vm_remote_fixture", d)), F._vm_remote("vm_remote_fixture", d))
    d = B.fixture_docs(); d["infrastructure"]["vm_remote"]["sandbox"].update(retention_days=14, disk_alarm_percent=75)
    check("prune:   ...and accepts both numbers when they are sensible", F._check(d["infrastructure"], sch, "x") + F._vm_remote("vm_remote_fixture", d) == [])
    said = []; rc = V.prune_remote(S, dry=True, say=said.append)
    check("prune: `--prune-sandboxes --dry-run` prints the one command and connects to nothing", rc == 0 and "runuser -u sfapp" in said[1] and said[1].rstrip().rstrip("'").endswith("--retention-days 7 --dry-run") and "root@203.0.113.10" in said[1], said)
    ran = []
    fake = lambda step: (ran.append(step["argv"][-1]), CP(step["argv"], 0, "  would remove session sandbox x (stopped, untouched for 9.0 days, 228 MB)\nDRY RUN (nothing is removed): 1 of 1 would be removed", ""))[1]
    orig = (os.path.isfile, V.key_path)
    try:
        V.key_path = lambda S_: __file__
        said = []; rc = V.prune_remote(S, runner=fake, say=said.append)
        check("prune: `--prune-sandboxes` only lists (the pruner's dry run), and says how to remove", rc == 0 and ran[-1].endswith("--dry-run") and "--prune-sandboxes --apply" in said[-1] and "would remove" in said[0], said)
        said = []; rc = V.prune_remote(S, apply=True, runner=fake, say=said.append)
        check("prune:   ...and `--apply` runs it for real, as the service user", rc == 0 and "--dry-run" not in ran[-1] and "runuser -u sfapp" in ran[-1], ran[-1])
    finally: V.key_path = orig[1]

# ---- B: the private administration tunnel (mold_v1-156) ---------------------------------------------------------
FPUB, SPUB = "F" * 43 + "=", "S" * 43 + "="
PRIVATE = "PRIVATE+" + "k" * 35 + "="        # what a stand-in `wg genkey` makes; it must surface nowhere
FACPUB_ADDR = "198.51.100.77"

def _on(d):
    T = dict(W.defaults("vm_remote_fixture"), enabled=True, factory_public_key=FPUB, server_public_key=SPUB, factory_public_address=FACPUB_ADDR, enabled_at="2026-10-04T12:00:00+00:00")
    d["infrastructure"]["vm_remote"].update(tunnel=T, ssh_host=T["server_address"])

class Server:
    """A model of the server for the factory-side sequence: what its firewall admits and whether its rollback is armed.
    It answers each remote step the way tunnel.sh does (those answers are checked against the real script below)."""
    def __init__(self, T, **faults):
        self.T = T; self.public = True; self.tunnel_rules = False; self.armed = False; self.wg = False; self.log = []; self.faults = faults; self.factory_up = False
    def reachable(self, door): return (self.wg and self.tunnel_rules and self.factory_up and not self.faults.get("udp_blocked")) if door == "tunnel" else self.public
    def report(self, door): return f"PUBLIC_SSH={'open' if self.public else 'closed'}\nROLLBACK={'armed' if self.armed else 'none'}\nVIA_TUNNEL={'yes' if door == 'tunnel' else 'no'}\n"
    def fire(self):
        if self.armed: self.public = True; self.armed = False; self.log.append("ROLLBACK-FIRED")
    def runner(self, step, stdin=None):
        argv = step["argv"]; target = next(a for a in argv if a.startswith("root@")) if argv[0] == "ssh" else argv[-1]
        door = "tunnel" if self.T["server_address"] in target else "public"
        self.log.append((step["id"], door, self.public, self.armed))
        if not self.reachable(door): return CP(argv, 255, "", f"ssh: connect to host {target}: Connection timed out")
        sid = step["id"]
        if sid == self.faults.get("fail"): return CP(argv, 1, "", "boom")
        if sid == "whoami": return CP(argv, 0, f"SF_CLIENT={self.T['factory_address'] if door == 'tunnel' else FACPUB_ADDR}\n", "")
        if sid in ("t-mkdir", "t-bundle"): return CP(argv, 0, "", "")
        if sid == "arm": self.armed = True; return CP(argv, 0, "ROLLBACK=armed\n", "")
        if sid == "up":
            if not self.armed: return CP(argv, 5, "", "refusing: the rollback timer is not running")
            self.wg = True; self.tunnel_rules = True; return CP(argv, 0, f"SERVER_PUBLIC_KEY={SPUB}\n" + self.report(door), "")
        if sid in ("login", "reach", "public-login"): return CP(argv, 0 if (door == "tunnel" or sid != "login") else 1, "WG=up\n" + self.report(door), "")
        if sid == "close":
            if door != "tunnel": return CP(argv, 7, "", "refusing: this command did not arrive over the tunnel")
            if not self.armed: return CP(argv, 5, "", "refusing: the rollback timer is not running")
            if self.faults.get("close_refused"): return CP(argv, 8, self.report(door), "another rule still lets every address reach SSH")
            self.public = False; return CP(argv, 0, self.report(door), "")
        if sid == "confirm":
            if self.faults.get("confirm_lost"): return CP(argv, 255, "", "ssh: connection reset")
            if door != "tunnel": return CP(argv, 7, "", "refusing")
            if self.public: return CP(argv, 9, "PUBLIC_SSH=open\n", "the rollback already re-opened public SSH")
            self.armed = False; return CP(argv, 0, "ROLLBACK=cancelled\n" + self.report(door), "")
        if sid == "open": self.public = True; self.armed = False; return CP(argv, 0, self.report(door), "")
        if sid == "down":
            if not self.public or door == "tunnel": return CP(argv, 7, "", "refusing")
            self.wg = False; self.tunnel_rules = False; return CP(argv, 0, "TUNNEL=off\n" + self.report(door), "")
        return CP(argv, 0, "", "")
    def probe(self, address, port):
        if self.faults.get("second_firewall") and address != self.T["server_address"]: return True
        return self.reachable("tunnel" if address == self.T["server_address"] else "public")

class Factory:
    """This machine, modelled: what is installed, and every command that would have changed it."""
    def __init__(self, server, wg=False, key=False, conf=None, unit=False, addrs="2: eth0    inet 198.51.100.77/24 brd 198.51.100.255 scope global eth0\n"):
        self.server = server; self.wg = wg; self.key = key; self.conf = conf; self.unit = unit; self.addrs = addrs; self.changed = []; self.calls = []
    def which(self, name): return "/usr/bin/wg" if (name == "wg" and self.wg) else None
    def local(self, step, stdin=None):
        sid = step["id"]; a = step["argv"]; self.calls.append((sid, list(a)))
        if sid == "f-have-key": return CP(a, 0 if self.key else 1, "", "")
        if sid == "f-have-unit": return CP(a, 0 if self.unit else 1, "", "")
        if sid == "f-have-conf": return CP(a, 0 if (self.conf is not None and self.conf == open(a[-2]).read()) else 1, "", "")
        if sid == "f-addrs": return CP(a, 0, self.addrs, "")
        if sid == "f-pub": return CP(a, 0, FPUB + "\n", "")
        self.changed.append(sid)
        if sid == "f-tools": self.wg = True
        elif sid == "f-key": self.key = True
        elif sid == "f-conf": self.conf = open(a[-2]).read()
        elif sid == "f-unit": self.unit = True; self.server.factory_up = True
        elif sid == "f-unit-off": self.unit = False; self.server.factory_up = False
        elif sid == "f-conf-off": self.conf = None
        return CP(a, 0, "", "")

def _stage(tmp, name, mut=None):
    d = os.path.join(tmp, name, "vm_remote_fixture"); shutil.copytree(V.FIXTURE, d)
    if mut:
        docs = {k: B.load(os.path.join(d, f"{k}.json")) for k in ("application", "infrastructure", "datastores", "datainfra")}; mut(docs)
        json.dump(docs["infrastructure"], open(os.path.join(d, "infrastructure.json"), "w"), indent=2)
    docs = {k: B.load(os.path.join(d, f"{k}.json")) for k in ("application", "infrastructure", "datastores")}
    return d, V.settings("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"])

def _go(tmp, name, mut=None, factory_apply=True, off=False, fac=None, **faults):
    d, S = _stage(tmp, name, mut); T = W.tunnel(S); srv = Server(T, **faults)
    if S["tunnel_on"]: srv.public = False; srv.wg = True; srv.tunnel_rules = True; srv.factory_up = True
    fac = fac(srv) if fac else Factory(srv); said = []; saves = []
    def save(T_, ssh_host): saves.append((dict(T_), ssh_host, len(srv.log))); W.write_state("vm_remote_fixture", d, T_, ssh_host)
    try: res = (W.turn_off if off else W.turn_on)(S, T, runner=srv.runner, local=fac.local, probe=srv.probe, save=save, say=said.append, factory_apply=factory_apply,
                                                  wait=lambda s: None, **({} if off else {"which": fac.which}))
    except V.Stop as e: res = e
    vr = B.load(os.path.join(d, "infrastructure.json"))["vm_remote"]
    return {"res": res, "srv": srv, "fac": fac, "said": "\n".join(said), "vr": vr, "dir": d, "S": S, "T": T, "saves": saves, "ids": [x[0] for x in srv.log if isinstance(x, tuple)]}

def _shims(d):
    """Stand-ins for the commands tunnel.sh runs, keeping their state in files under `d` and logging every call."""
    os.makedirs(os.path.join(d, "bin")); os.makedirs(os.path.join(d, "units")); open(os.path.join(d, "rules"), "w").write("ufw allow 22/tcp\nufw allow 443/tcp\nufw allow 80/tcp\n")
    sh = {
      "ufw": f"""#!/bin/sh
echo "ufw $*" >> {d}/calls
case "$1" in
  show) cat {d}/rules ;;
  status) echo "Status: active" ;;
  allow) grep -qxF "ufw $*" {d}/rules || echo "ufw $*" >> {d}/rules ;;
  delete) shift; grep -vxF "ufw $*" {d}/rules > {d}/rules.new || true; mv {d}/rules.new {d}/rules ;;
esac
""",
      "systemctl": f"""#!/bin/sh
echo "systemctl $*" >> {d}/calls
case "$1" in
  is-active) for u in "$@"; do last="$u"; done; [ -e "{d}/units/$last" ] ;;
  stop) shift; for u in "$@"; do rm -f "{d}/units/$u"; done ;;
  restart|enable) for u in "$@"; do last="$u"; done; [ "$1" = restart ] && touch "{d}/units/$last"; exit 0 ;;
  disable) for u in "$@"; do last="$u"; done; rm -f "{d}/units/$last" ;;
  *) exit 0 ;;
esac
""",
      "systemd-run": f"""#!/bin/sh
echo "systemd-run $*" >> {d}/calls
for a in "$@"; do case "$a" in --unit=*) touch "{d}/units/${{a#--unit=}}.timer" ;; esac; done
""",
      "wg": f"""#!/bin/sh
echo "wg $*" >> {d}/calls
case "$1" in genkey) echo "{PRIVATE}" ;; pubkey) cat >/dev/null; echo "{SPUB}" ;; *) exit 0 ;; esac
""",
      "ip": f"""#!/bin/sh
case "$*" in *"addr show"*) cat {d}/addrs ;; *) exit 0 ;; esac
""",
      "apt-get": f"#!/bin/sh\necho \"apt-get $*\" >> {d}/calls\n",
    }
    open(os.path.join(d, "addrs"), "w").write("1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0\n")
    for n, body in sh.items():
        p = os.path.join(d, "bin", n); open(p, "w").write(body); os.chmod(p, 0o755)
    open(os.path.join(d, "calls"), "w").close()

def tunnel(check, tmp):
    S = B._settings(); T = W.tunnel(S); import ipaddress
    # ---- names and addresses
    net = ipaddress.ip_network(T["network"])
    check("tunnel: the default is a private /30 of its own, both addresses usable, an interface name Linux accepts", net.prefixlen == 30 and net.is_private
          and {ipaddress.ip_address(T["factory_address"]), ipaddress.ip_address(T["server_address"])} == set(net.hosts()) and W.IFACE.match(T["interface"]) and len(T["interface"]) <= 15, T)
    check("tunnel:   ...inside a range the agent's sandbox is denied, so no sandbox can reach the factory through it", V._covered(T["factory_address"], V.DENY_REQUIRED) and V._covered(T["factory_address"], V.EGRESS_DENY))
    check("tunnel:   ...derived from the app id: the same every time, different for another app", W.defaults("vm_remote_fixture") == W.defaults("vm_remote_fixture")
          and W.defaults("a")["interface"] != W.defaults("b")["interface"] and W.defaults("a")["network"] != W.defaults("b")["network"])
    check("tunnel:   ...and state's own values win over the defaults", W.tunnel(B._settings(lambda d: d["infrastructure"]["vm_remote"].update(tunnel={"interface": "wgx", "listen_port": 51999})))["listen_port"] == 51999)
    # ---- generated files: no private key anywhere
    Tk = dict(T, factory_public_key=FPUB, server_public_key=SPUB, factory_public_address=FACPUB_ADDR)
    sc, fc, sh = W.server_conf(S, Tk), W.factory_conf(S, Tk), W.tunnel_sh(S, Tk)
    check("tunnel: neither generated conf has a PrivateKey line; each loads the key from the machine's own key file", "PrivateKey" not in sc + fc
          and all(f"PostUp = wg set %i private-key {W.WG_DIR}/%i.key" in c for c in (sc, fc)))
    check("tunnel:   ...the server's conf names the factory's PUBLIC key and admits only the factory's tunnel address", f"PublicKey = {FPUB}" in sc and f"AllowedIPs = {T['factory_address']}/32" in sc
          and f"ListenPort = {T['listen_port']}" in sc and f"Address = {T['server_address']}/30" in sc and SPUB not in sc)
    check("tunnel:   ...the factory's conf names the server's PUBLIC key, its public address and routes only the server's tunnel address", f"PublicKey = {SPUB}" in fc
          and f"Endpoint = 203.0.113.10:{T['listen_port']}" in fc and f"AllowedIPs = {T['server_address']}/32" in fc and "0.0.0.0/0" not in fc and "PersistentKeepalive" in fc)
    script = os.path.join(tmp, "tunnel-n.sh"); open(script, "w").write(sh)
    r = subprocess.run(["bash", "-n", script], capture_output=True, text=True)
    check("tunnel: the server's script parses (bash -n) and carries the guard marker", r.returncode == 0 and V.GUARD_VAR in sh and sh.startswith("#!/bin/bash"), r.stderr)
    check("tunnel:   ...it never edits sshd and never touches fail2ban", "sshd_config" not in sh and "fail2ban" not in sh.replace("fail2ban is not touched", "") and "ListenAddress" not in sh)
    block = lambda v: sh.split(f"\n  {v})\n", 1)[1].split("\n    ;;\n", 1)[0]
    check("tunnel:   ...`up` checks the rollback is armed BEFORE its first firewall change, and never deletes the public rule", block("up").index("timer_on ||") < block("up").index("$TUN_WG")
          and "delete allow 22/tcp" not in block("up") and "PUB_RULE" not in block("up"))
    check("tunnel:   ...`close` checks it arrived over the tunnel, then the rollback, then the tunnel rule, BEFORE deleting the public rule",
          block("close").index("via_tunnel ||") < block("close").index("timer_on ||") < block("close").index('has_rule "$TUN_SSH" ||') < block("close").index("ufw delete allow 22/tcp"))
    check("tunnel:   ...`confirm` is the only verb of the turn-on path that stops the timer, and only after the tunnel check", block("confirm").index("via_tunnel ||") < block("confirm").index('systemctl stop "$UNIT.timer"')
          and 'systemctl stop "$UNIT.timer"' not in block("up") + block("close") + block("hello"))
    check("tunnel:   ...the rollback is self-contained: a timer that runs `ufw allow 22/tcp`, needing no file of ours", "--on-active=600" in block("arm") and "/usr/sbin/ufw allow 22/tcp" in block("arm"))
    # ---- firewall rules
    Son = B._settings(_on)
    check("tunnel: off, the firewall rules are exactly what they were", V.ufw_rules(S) == ["ufw allow 22/tcp", "ufw allow 443/tcp", "ufw allow 80/tcp"])
    check("tunnel: on, SSH is admitted on the tunnel interface only and WireGuard from the factory's public address only; there is no public SSH rule",
          V.ufw_rules(Son) == sorted(["ufw allow 80/tcp", "ufw allow 443/tcp", f"ufw allow in on {T['interface']} to any port 22 proto tcp", f"ufw allow from {FACPUB_ADDR} to any port {T['listen_port']} proto udp"]), V.ufw_rules(Son))
    fw = V.firewall_sh(Son); fwp = os.path.join(tmp, "fw-tunnel.sh"); open(fwp, "w").write(fw)
    check("tunnel:   ...the deploy's firewall script keeps exactly those, refuses if the interface is missing, and still parses", "\n  ufw allow 22/tcp\n" not in fw and f"ip link show {T['interface']}" in fw
          and fw.index("ip link show") < fw.index("ufw --force reset") and subprocess.run(["bash", "-n", fwp]).returncode == 0)
    check("tunnel:   ...fail2ban's jail is the same with the tunnel on or off", V.fail2ban_jail(Son) == V.fail2ban_jail(S))
    check("tunnel:   ...and with it off the firewall script has no tunnel line at all", "ip link show" not in V.firewall_sh(S) and "\n  ufw allow 22/tcp\n" in V.firewall_sh(S))
    # ---- where SSH goes once it is on
    argv = V.ssh_argv(Son, "true")
    check("tunnel: on, SSH goes to the server's tunnel address and must meet the host key already known for the public one", f"root@{T['server_address']}" in argv and "HostKeyAlias=203.0.113.10" in argv, argv)
    check("tunnel:   ...off, the command line is what it always was", "HostKeyAlias" not in " ".join(V.ssh_argv(S, "true")) and "root@203.0.113.10" in V.ssh_argv(S, "true"))
    remote = [s for s in V.plan(Son, MOLD) if "argv" in s]
    check("tunnel:   ...every remote step of a deploy (qualify, the scripts, rsync, health) connects through the tunnel", all(f"root@{T['server_address']}" in " ".join(s["argv"]) and "root@203.0.113.10" not in " ".join(s["argv"]) for s in remote), [s["id"] for s in remote])
    check("tunnel:   ...so do --verify-rls and --prune-sandboxes", f"root@{T['server_address']}" in V.prune_argv(Son))
    check("tunnel:   ...the DNS check still compares the domain with the PUBLIC address", V.dns_problem(Son, lambda d: ["203.0.113.10"]) is None and V.dns_problem(Son, lambda d: [T["server_address"]]) is not None)
    d = B.fixture_docs(); _on(d); d["infrastructure"].update(deployed_at="2026-10-04T10:00:00+00:00"); d["infrastructure"]["vm_remote"]["production_url"] = "https://app.example.com"
    check("tunnel:   ...and the lanes still grade the domain, never the tunnel address", lane_url.target_url(d["infrastructure"]) == "https://app.example.com")
    lines = []; V.print_plan(Son, V.plan(Son, MOLD), V.bundle(Son, list(V.CRONS)), list(V.CRONS), [], out=lines.append); text = "\n".join(lines)
    check("tunnel:   ...the deploy's dry run says so, and its outside health step probes both doors", f"(SSH through {T['server_address']})" in text and f"203.0.113.10:22 (must NOT open" in text
          and f"{T['server_address']}:22 (must open" in text and f"{Son['url']}/api/ops/health" in text)
    # ---- health
    crons = list(V.CRONS); ok = dict(V.parse_kv(B.fx("health-ok.txt")), SSH_PUBLIC_RULE="closed", WG="up", WG_BOOT="enabled", SSH_TUNNEL_RULE="yes")
    hs = V.health_sh(Son, crons)
    check("tunnel: the server health step reads the public SSH rule, the interface, its boot unit and the tunnel rule", all(k in hs for k in ("SSH_PUBLIC_RULE=", "WG=", "WG_BOOT=", "SSH_TUNNEL_RULE=")) and "WG=" not in V.health_sh(S, crons))
    hv, bad = V.health_verdict(Son, ok, crons)
    check("tunnel:   ...a server with the tunnel properly on passes, and says so", bad == [] and hv["tunnel"] == "ok", bad)
    for label, kw, needle, verdict in (("a public SSH rule still in the firewall", {"SSH_PUBLIC_RULE": "open"}, "any address reach SSH", "public_ssh_open"), ("a tunnel interface that is down", {"WG": "down"}, "is not up", "down"),
                                       ("a tunnel that would not come back after a reboot", {"WG_BOOT": "disabled"}, "at boot", "down"), ("no rule admitting SSH on the tunnel", {"SSH_TUNNEL_RULE": "no"}, "no rule admitting SSH", "down")):
        hv, bad = V.health_verdict(Son, dict(ok, **kw), crons)
        check(f"tunnel:   ...health refuses {label}", any(needle in x for x in bad) and hv["tunnel"] == verdict, (hv, bad))
    hv, bad = V.health_verdict(S, V.parse_kv(B.fx("health-ok.txt")), crons)
    check("tunnel:   ...with the tunnel off an open public SSH rule is normal and nothing about the tunnel is judged", bad == [] and "tunnel" not in hv)
    doors = lambda pub, tun: V.ssh_door_problems(Son, lambda a, p: pub if a == "203.0.113.10" else tun)
    check("tunnel: the outside probe wants port 22 closed publicly and open on the tunnel", doors(False, True) == [] and "still answers on the server's public address" in doors(True, True)[0]
          and "does not answer on the tunnel address" in doors(False, False)[0] and V.ssh_door_problems(S, lambda a, p: True) == [])
    res = V.deploy(Son, MOLD, crons, runner=lambda st, stdin=None: CP(st["argv"], 0, {"qualify": B.fx("qualify-ok.txt"), "env-names": "\n".join(V.operator_names(Son)), "db-chain": "EVIDENCE " + json.dumps({"protected": 58}),
                   "health": "\n".join(f"{k}={v}" for k, v in ok.items())}.get(st["id"], "ok"), ""), resolver=lambda d: ["203.0.113.10"], read_health=lambda u: ("200", B.HEALTH_DOC, ""), say=lambda *_: None,
                   bundle_dir=os.path.join(tmp, "deploy-tunnel"), wait=lambda s: None, probe=lambda a, p: True)
    check("tunnel:   ...and a deploy whose outside probe finds public SSH answering is not accepted", any("still answers" in x for x in res["problems"]) and res["health"]["tunnel"] == "ok", res["problems"])
    # ---- the state rules
    sch = SCH()
    def errs(mut):
        d = B.fixture_docs(); _on(d); mut(d["infrastructure"]["vm_remote"]); return F._check(d["infrastructure"], sch, "x") + F._vm_remote("vm_remote_fixture", d)
    check("tunnel: state with the tunnel on, as a completed run leaves it, validates", errs(lambda vr: None) == [], errs(lambda vr: None))
    d = B.fixture_docs(); d["infrastructure"]["vm_remote"]["tunnel"] = dict(W.defaults("vm_remote_fixture"), factory_public_key=FPUB)
    check("tunnel:   ...and so does a tunnel that is recorded but not on (public keys known, SSH still public)", F._check(d["infrastructure"], sch, "x") + F._vm_remote("vm_remote_fixture", d) == [])
    for label, mut, needle in (
        ("enabled, but ssh_host is not the tunnel address (every deploy would knock on a closed door)", lambda vr: vr.pop("ssh_host"), "closed door"),
        ("enabled, with ssh_host pointing somewhere else", lambda vr: vr.update(ssh_host="10.9.9.9"), "closed door"),
        ("enabled without the server's public key", lambda vr: vr["tunnel"].pop("server_public_key"), "only a completed run writes"),
        ("enabled without the factory's public address", lambda vr: vr["tunnel"].pop("factory_public_address"), "only a completed run writes"),
        ("enabled together with ssh_allow_from", lambda vr: vr.update(ssh_allow_from="10.0.0.0/24"), "two ways of limiting SSH"),
        ("ssh_host on the tunnel address while the tunnel is off", lambda vr: vr["tunnel"].update(enabled=False), "state says is off"),
        ("a /24 as the tunnel network", lambda vr: vr["tunnel"].update(network="192.168.50.0/24"), "fails pattern"),
        ("a public network", lambda vr: vr["tunnel"].update(network="203.0.114.0/30", factory_address="203.0.114.1", server_address="203.0.114.2", ) or vr.update(ssh_host="203.0.114.2"), "PRIVATE /30 or /31"),
        ("a network that holds the server's public address", lambda vr: (vr.update(host="192.168.9.1"), vr["tunnel"].update(network="192.168.9.0/30", factory_address="192.168.9.1", server_address="192.168.9.2"), vr.update(ssh_host="192.168.9.2")), "holds the server's public address"),
        ("an address outside the network", lambda vr: vr["tunnel"].update(factory_address="192.168.200.200"), "not a usable address"),
        ("the /30's broadcast address", lambda vr: (vr["tunnel"].update(network="192.168.7.0/30", factory_address="192.168.7.1", server_address="192.168.7.3"), vr.update(ssh_host="192.168.7.3")), "not a usable address"),
        ("one address for both machines", lambda vr: (vr["tunnel"].update(factory_address=vr["tunnel"]["server_address"])), "each machine needs its own"),
        ("a network written with host bits", lambda vr: vr["tunnel"].update(network="192.168.7.1/30"), "not a network address"),
        ("a listen port that is not a port", lambda vr: vr["tunnel"].update(listen_port=70000), "listen_port"),
        ("a key that is not a WireGuard public key", lambda vr: vr["tunnel"].update(server_public_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc"), "fails pattern"),
        ("a private_key field", lambda vr: vr["tunnel"].update(private_key=PRIVATE), "not allowed"),
        ("a PEM block where a public key belongs", lambda vr: vr["tunnel"].update(factory_public_key="-----BEGIN PRIVATE KEY-----"), "fails pattern"),
        ("an interface name Linux would refuse", lambda vr: vr["tunnel"].update(interface="This-Is-Far-Too-Long-A-Name"), "fails pattern"),
        ("enabled written as a string", lambda vr: vr["tunnel"].update(enabled="yes"), "expected boolean")):
        e = errs(mut)
        check(f"tunnel: validate refuses {label}", any(needle in x for x in e), e)
    check("tunnel:   ...a /31 is accepted", errs(lambda vr: (vr["tunnel"].update(network="192.168.7.0/31", factory_address="192.168.7.0", server_address="192.168.7.1"), vr.update(ssh_host="192.168.7.1"))) == [])
    a, b = B.fixture_docs(), B.fixture_docs(); _on(a); _on(b)
    b["infrastructure"]["vm_remote"].update(host="203.0.113.99", domain="other.example.com")
    two = F._vm_remote_hosts({"a": a, "b": b})
    check("tunnel: two apps cannot share a tunnel interface or overlap a tunnel network on the one factory machine", any("interface" in x for x in two) and any("overlaps" in x for x in two), two)
    b["infrastructure"]["vm_remote"]["tunnel"].update(interface="sfwgother", network="192.168.250.0/30")
    check("tunnel:   ...and with their own they coexist", F._vm_remote_hosts({"a": a, "b": b}) == [])
    # ---- the dry run and the factory-side listing
    lines = []; W.print_plan(S, T, out=lines.append); text = "\n".join(lines)
    ids = [s["id"] for s in W.plan_on(S, W.shown(T))]
    check("tunnel: the dry run prints every step, local and remote, in the guard's order", ids == ["f-tools", "f-key", "f-pub", "whoami", "t-mkdir", "t-bundle", "arm", "up", "f-conf", "f-unit", "login", "close", "confirm", "probe"]
          and all(f"[{i:02d} {sid}]" in text for i, sid in enumerate(ids, 1)), ids)
    check("tunnel:   ...says twice that nothing was run or changed, and explains the guard", text.startswith("DRY RUN") and lines[-1].endswith("nothing on this machine was changed.") and "rollback is armed before any firewall change" in text)
    check("tunnel:   ...prints the whole server script and both confs, and no private key, PEM or key path's content", "tunnel/tunnel.sh" in text and f"tunnel/{T['interface']}.conf" in text and f"--- {W.conf_file(T)}" in text
          and "PrivateKey" not in text and "BEGIN" not in text and os.path.expanduser("~/.ssh") not in text)
    check("tunnel:   ...shows the close and confirm steps going to the TUNNEL address and the arm step to the public one", re.search(r"\[12 close\].*\n\s+\$ ssh .*root@" + re.escape(T["server_address"]), text) is not None
          and re.search(r"\[07 arm\].*\n\s+\$ ssh .*root@203\.0\.113\.10", text) is not None)
    check("tunnel:   ...every changing remote step carries the guard marker and sshd's own record of how the login arrived", all(f"{V.GUARD_VAR}=vm_remote_fixture" in s["argv"][-1] and 'SF_SSH_CONNECTION="$SSH_CONNECTION"' in s["argv"][-1]
          for s in W.plan_on(S, W.shown(T)) if s["id"] in ("arm", "up", "login", "close", "confirm")))
    check("tunnel:   ...no key ever rides a command line: the factory's key is made and read by redirection inside one shell", all(PRIVATE not in " ".join(s.get("argv", [])) for s in W.plan_on(S, Tk))
          and f"wg genkey > {W.key_file(T)}" in " ".join(next(s for s in W.plan_on(S, Tk) if s["id"] == "f-key")["argv"]) and f"wg pubkey < {W.key_file(T)}" in " ".join(next(s for s in W.plan_on(S, Tk) if s["id"] == "f-pub")["argv"]))
    lines = []; W.print_factory(S, T, out=lines.append); ftext = "\n".join(lines)
    check("tunnel: the factory-side listing names exactly one package, one key file, one conf and one unit", "wireguard-tools" in ftext and W.key_file(T) in ftext and W.conf_file(T) in ftext and W.unit(T) in ftext
          and "No firewall rule, no SSH setting and no other file on this machine is touched" in ftext and [s["id"] for s in W.factory_steps(S, T)] == ["f-tools", "f-key", "f-pub", "f-conf", "f-unit"])
    dd, Sd = _stage(tmp, "tunnel-dry"); before = B.digest(dd)
    rc, printed = B.quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--tunnel-remote", "--dry-run"], *(B.load(os.path.join(dd, f"{k}.json")) for k in ("application", "infrastructure", "datastores")), dd, P)
    check("tunnel: `--tunnel-remote --dry-run` prints that plan, exits 0, connects to nothing and writes nothing", rc == 0 and printed.strip() == text.strip() and B.digest(dd) == before, printed[:300])
    rc, printed = B.quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--tunnel-factory"], *(B.load(os.path.join(dd, f"{k}.json")) for k in ("application", "infrastructure", "datastores")), dd, P)
    check("tunnel: `--tunnel-factory` without --apply only prints, and says the flag that would do it", rc == 0 and "Nothing was changed" in printed and "--tunnel-factory --apply" in printed and B.digest(dd) == before, printed[-300:])
    rc, printed = B.quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--tunnel-remote", "--off", "--dry-run"], *(B.load(os.path.join(dd, f"{k}.json")) for k in ("application", "infrastructure", "datastores")), dd, P)
    check("tunnel: `--tunnel-remote --off --dry-run` prints the way back: public SSH re-opened first, proven, then the tunnel down", rc == 0 and [s["id"] for s in W.plan_off(S, T)] == ["reach", "open", "public-login", "down", "f-unit-off", "f-conf-off", "probe"]
          and "re-opened FIRST" in printed and B.digest(dd) == before, printed[:300])
    # ---- THE GUARD, factory side, against the model server
    g = _go(tmp, "g-ok")
    first_close = g["ids"].index("close")
    check("tunnel guard: a clean run ends with the tunnel on", not isinstance(g["res"], V.Stop) and g["srv"].public is False and g["srv"].armed is False, g["res"])
    check("tunnel guard:   the rollback is armed before the first firewall change", g["ids"].index("arm") < g["ids"].index("up") < first_close)
    check("tunnel guard:   the public rule is removed only AFTER a login over the tunnel succeeded in the same run", g["ids"].index("login") < first_close and all(pub for sid, door, pub, armed in g["srv"].log[:first_close + 1])
          and g["srv"].log[g["ids"].index("login")][1] == "tunnel")
    check("tunnel guard:   the close itself travels over the tunnel, with the rollback still armed", g["srv"].log[first_close][1] == "tunnel" and g["srv"].log[first_close][3] is True)
    check("tunnel guard:   the rollback is cancelled only by the confirmation, which comes after the close and over the tunnel", g["ids"].index("confirm") > first_close and g["srv"].log[g["ids"].index("confirm")][1:] == ("tunnel", False, True))
    check("tunnel guard:   everything before the login went to the public address", all(door == "public" for sid, door, _, _ in g["srv"].log[:g["ids"].index("login")]))
    check("tunnel guard:   state is switched to the tunnel only after the confirmation", [s for s in g["saves"] if s[1]] and all(s[2] > g["ids"].index("confirm") for s in g["saves"] if s[1])
          and all(s[0].get("enabled") is not True for s in g["saves"] if not s[1]))
    check("tunnel guard:   state then says: enabled, the public keys, and ssh_host = the server's tunnel address", g["vr"]["tunnel"]["enabled"] is True and g["vr"]["ssh_host"] == g["T"]["server_address"]
          and g["vr"]["tunnel"]["server_public_key"] == SPUB and g["vr"]["tunnel"]["factory_public_key"] == FPUB and g["vr"]["tunnel"]["factory_public_address"] == FACPUB_ADDR and g["vr"]["host"] == "203.0.113.10")
    e, _ = F._app_errors("vm_remote_fixture", g["dir"])
    check("tunnel guard:   ...and that state validates", e == [], e)
    stored = open(os.path.join(g["dir"], "infrastructure.json")).read()
    check("tunnel guard:   no private key is in state, in anything said, or on any command line", "private" not in json.dumps(g["vr"]["tunnel"]).lower() and PRIVATE not in stored + g["said"]
          and not any(PRIVATE in " ".join(a) for _, a in g["fac"].calls) and set(g["vr"]["tunnel"]) <= set(W.STATE_KEYS))
    check("tunnel guard:   this machine got exactly: the package, its key, one conf, one unit", g["fac"].changed == ["f-tools", "f-key", "f-conf", "f-unit"] and "PrivateKey" not in g["fac"].conf, g["fac"].changed)
    g = _go(tmp, "g-udp", udp_blocked=True)
    check("tunnel guard: when the tunnel login fails, the close is never sent and PUBLIC SSH STAYS OPEN, said plainly", isinstance(g["res"], V.Stop) and "close" not in g["ids"] and "confirm" not in g["ids"] and g["srv"].public is True
          and "PUBLIC SSH IS STILL OPEN" in str(g["res"]) and "was NOT removed" in str(g["res"]), g["res"])
    check("tunnel guard:   ...state still says SSH is on the public address", g["vr"]["tunnel"]["enabled"] is False and "ssh_host" not in g["vr"] and F._app_errors("vm_remote_fixture", g["dir"])[0] == [])
    g["srv"].fire()
    check("tunnel guard:   ...and the rollback, left armed, fires harmlessly", g["srv"].public is True)
    g = _go(tmp, "g-arm", fail="arm")
    check("tunnel guard: if the rollback cannot be armed, no firewall rule is changed", isinstance(g["res"], V.Stop) and "up" not in g["ids"] and g["srv"].tunnel_rules is False and g["srv"].public and "PUBLIC SSH IS STILL OPEN" in str(g["res"]))
    g = _go(tmp, "g-up", fail="up")
    check("tunnel guard: if the server's side fails, this machine's conf is not written and nothing is closed", isinstance(g["res"], V.Stop) and "f-conf" not in g["fac"].changed and "close" not in g["ids"] and g["srv"].public)
    g = _go(tmp, "g-close", close_refused=True)
    check("tunnel guard: if the server refuses the close, the confirmation is never sent, so the rollback stays armed", isinstance(g["res"], V.Stop) and "confirm" not in g["ids"] and g["srv"].armed and g["srv"].public
          and "enabled" in g["vr"]["tunnel"] and g["vr"]["tunnel"]["enabled"] is False and "ssh_host" not in g["vr"])
    g = _go(tmp, "g-confirm", confirm_lost=True)
    check("tunnel guard: if the confirmation is lost after the close, the rollback is NOT cancelled and state is NOT switched", isinstance(g["res"], V.Stop) and g["srv"].armed and g["srv"].public is False
          and "re-opens public SSH by itself within ten minutes" in str(g["res"]) and g["vr"]["tunnel"]["enabled"] is False and "ssh_host" not in g["vr"], g["res"])
    g["srv"].fire()
    check("tunnel guard:   ...and when the timer fires public SSH is open again: the factory, still on the public address, is not locked out", g["srv"].public is True and g["srv"].reachable("public"))
    g = _go(tmp, "g-noflag", factory_apply=False)
    check("tunnel guard: without --factory-apply and with nothing installed here, it stops BEFORE contacting the server or changing this machine", isinstance(g["res"], V.Stop) and g["ids"] == [] and g["fac"].changed == []
          and "--tunnel-remote --factory-apply" in str(g["res"]) and "wireguard-tools" in str(g["res"]) and "Nothing was contacted" in str(g["res"]) and "tunnel" not in g["vr"], g["res"])
    g = _go(tmp, "g-overlap", fac=lambda srv: Factory(srv, addrs=f"3: br0    inet {W.defaults('vm_remote_fixture')['factory_address']}/24 scope global br0\n"))
    check("tunnel guard: a network this machine already uses is refused before the server is contacted", isinstance(g["res"], V.Stop) and g["ids"] == [] and "already has the address" in str(g["res"]))
    g = _go(tmp, "g-allow", mut=lambda d: d["infrastructure"]["vm_remote"].update(ssh_allow_from="10.0.0.0/24", ssh_host="10.0.0.5"))
    check("tunnel guard: an app that limits SSH another way is refused before anything", isinstance(g["res"], V.Stop) and g["ids"] == [] and g["fac"].calls == [] and "ssh_allow_from" in str(g["res"]))
    g = _go(tmp, "g-second", second_firewall=True)
    check("tunnel guard: if port 22 still answers from outside afterwards, it says so (and the tunnel is recorded, because the server's own firewall is closed)", isinstance(g["res"], V.Stop) and "still answers" in str(g["res"]) and g["vr"]["tunnel"]["enabled"] is True)
    # ---- idempotency
    g2 = _go(tmp, "g-again", mut=_on, factory_apply=False, fac=lambda srv: Factory(srv, wg=True, key=True, unit=True, conf=W.factory_conf(B._settings(_on), W.tunnel(B._settings(_on)))))
    check("tunnel: a second run on a tunnel that is already on succeeds, changes nothing on this machine and needs no flag", not isinstance(g2["res"], V.Stop) and g2["fac"].changed == [] and g2["srv"].public is False and g2["srv"].armed is False, (g2["res"], g2["fac"].changed))
    check("tunnel:   ...every one of its steps travelled over the tunnel, and it re-armed the rollback before touching anything", all(door == "tunnel" for sid, door, _, _ in g2["srv"].log) and g2["ids"].index("arm") < g2["ids"].index("up"))
    check("tunnel:   ...the factory's public address, which a login over the tunnel cannot show, is kept from state", g2["vr"]["tunnel"]["factory_public_address"] == FACPUB_ADDR and g2["vr"]["ssh_host"] == g2["T"]["server_address"]
          and F._app_errors("vm_remote_fixture", g2["dir"])[0] == [])
    g3 = _go(tmp, "g-again-fail", mut=_on, factory_apply=False, confirm_lost=True, fac=lambda srv: Factory(srv, wg=True, key=True, unit=True, conf=W.factory_conf(B._settings(_on), W.tunnel(B._settings(_on)))))
    g3["srv"].fire()
    check("tunnel:   ...and a second run that fails half-way fails OPEN: the rollback re-opens public SSH", isinstance(g3["res"], V.Stop) and g3["srv"].public is True)
    # ---- --off
    full = lambda srv: Factory(srv, wg=True, key=True, unit=True, conf="x")
    o = _go(tmp, "off-ok", mut=_on, off=True, fac=full)
    check("tunnel off: public SSH is re-opened first, a public login is proven, and only then is the tunnel taken down", not isinstance(o["res"], V.Stop) and o["ids"] == ["reach", "open", "public-login", "down"]
          and [x[1] for x in o["srv"].log] == ["tunnel", "tunnel", "public", "public"] and o["srv"].public and not o["srv"].wg, o["ids"])
    check("tunnel off:   state loses ssh_host and says enabled false, after the public login and before the tunnel goes down", "ssh_host" not in o["vr"] and o["vr"]["tunnel"]["enabled"] is False and o["saves"][0][2] == 3
          and F._app_errors("vm_remote_fixture", o["dir"])[0] == [] and o["vr"]["tunnel"]["server_public_key"] == SPUB)
    check("tunnel off:   this machine's unit and conf are removed with the flag; the key file stays", o["fac"].changed == ["f-unit-off", "f-conf-off"] and o["fac"].key is True)
    o = _go(tmp, "off-noflag", mut=_on, off=True, factory_apply=False, fac=full)
    check("tunnel off:   ...and left alone without it, with the command that removes them", not isinstance(o["res"], V.Stop) and o["fac"].changed == [] and "--tunnel-factory --off --apply" in o["said"])
    o = _go(tmp, "off-blocked", mut=_on, off=True, fac=full, fail="public-login")
    check("tunnel off: if the public login fails, the tunnel stays up and state is unchanged", isinstance(o["res"], V.Stop) and "down" not in o["ids"] and o["srv"].wg and o["vr"]["tunnel"]["enabled"] is True
          and o["vr"]["ssh_host"] == o["T"]["server_address"] and "the tunnel was left up" in str(o["res"]), o["res"])
    d5, S5 = _stage(tmp, "off-dead", _on); srv = Server(W.tunnel(S5)); srv.public = False
    out, _ = B.quiet(W.turn_off, S5, W.tunnel(S5), runner=srv.runner, local=Factory(srv).local, probe=srv.probe, save=None, say=lambda *_: None, wait=lambda s: None)
    check("tunnel off: with the tunnel down and public SSH closed it changes nothing and points at the provider's console", isinstance(out, V.Stop) and "recovery console" in str(out) and [x[0] for x in srv.log] == ["reach", "reach"])
    srv = Server(W.tunnel(S5)); srv.public = True; said = []
    W.turn_off(S5, W.tunnel(S5), runner=srv.runner, local=Factory(srv).local, probe=srv.probe, save=lambda T_, h: None, say=said.append, wait=lambda s: None)
    check("tunnel off:   ...and after the break-glass command re-opened public SSH, --off works over the public address", [x[1] for x in srv.log] == ["tunnel", "public", "public", "public", "public"])
    # ---- writing state
    d6, S6 = _stage(tmp, "state-bad"); before = open(os.path.join(d6, "infrastructure.json")).read()
    out, _ = B.quiet(W.write_state, "vm_remote_fixture", d6, dict(W.tunnel(S6), enabled=True, factory_public_key=PRIVATE[:10]), "192.168.1.1")
    check("tunnel: state that would not validate is never written (judged on a copy, replaced in one step)", isinstance(out, V.Stop) and open(os.path.join(d6, "infrastructure.json")).read() == before and not os.path.exists(os.path.join(d6, "infrastructure.json.tunnel.tmp")))
    out, _ = B.quiet(W.preflight, "vm_remote_fixture", d6, dict(W.tunnel(S6), network="10.0.0.0/8"))
    check("tunnel:   ...and the end state is checked before anything is changed anywhere", isinstance(out, V.Stop) and "nothing was contacted" in str(out) and open(os.path.join(d6, "infrastructure.json")).read() == before)
    check("tunnel:   ...a good one passes that check and writes nothing", B.quiet(W.preflight, "vm_remote_fixture", d6, W.tunnel(S6))[0] is None and open(os.path.join(d6, "infrastructure.json")).read() == before)
    d7, S7 = _stage(tmp, "check-on", _on)
    rc, printed = B.quiet(V.check, "vm_remote_fixture", *(B.load(os.path.join(d7, f"{k}.json")) for k in ("application", "infrastructure", "datastores")), d7)
    check("tunnel: the offline check says whether the tunnel is on and where SSH goes", "administration tunnel: ON" in printed and W.tunnel(S7)["server_address"] in printed and "SSH on the private tunnel only" in printed, printed[-900:])
    rc, printed = B.quiet(V.check, "vm_remote_fixture", *(B.load(os.path.join(V.FIXTURE, f"{k}.json")) for k in ("application", "infrastructure", "datastores")), V.FIXTURE)
    check("tunnel:   ...and when it is off, how to see what turning it on would do", "administration tunnel: off" in printed and "--tunnel-remote --dry-run" in printed and "ports 22, 80, 443 only" in printed)
    # ---- THE GUARD, server side: the real script, run against stand-in commands
    sd = os.path.join(tmp, "srv"); _shims(sd); wgd = os.path.join(sd, "etc-wireguard"); rd = os.path.join(sd, "tunnel"); os.makedirs(rd)
    St = dict(S, install=sd)                                   # so the script looks for its conf under the temp directory
    real = W.tunnel_sh(St, Tk, wg_dir=wgd); sp = os.path.join(rd, "tunnel.sh"); open(sp, "w").write(real); open(os.path.join(rd, f"{T['interface']}.conf"), "w").write(W.server_conf(S, Tk))
    PUBLIC_CONN = f"{FACPUB_ADDR} 50000 203.0.113.10 22"; TUNNEL_CONN = f"{T['factory_address']} 50001 {T['server_address']} 22"; SPOOF = f"{FACPUB_ADDR} 50002 {T['server_address']} 22"
    t_ssh, t_wg = V.tunnel_rules(S, Tk); everything = []
    def sh_(verb, conn, guard="vm_remote_fixture"):
        env = {"PATH": os.path.join(sd, "bin") + ":/usr/bin:/bin", "SF_SSH_CONNECTION": conn, "HOME": sd}
        if guard: env[V.GUARD_VAR] = guard
        r = subprocess.run(["bash", sp, verb], env=env, capture_output=True, text=True); everything.append(r.stdout + r.stderr); return r
    rules = lambda: open(os.path.join(sd, "rules")).read().split("\n")
    calls = lambda: open(os.path.join(sd, "calls")).read()
    r = sh_("arm", PUBLIC_CONN, guard=None)
    check("tunnel script: it refuses to run at all without the deploy's marker", r.returncode == 3 and calls() == "")
    r = sh_("up", PUBLIC_CONN)
    check("tunnel script: `up` before `arm` is refused and changes no firewall rule", r.returncode == 5 and "ufw allow" not in calls() and "rollback timer is not running" in r.stderr, r.stderr)
    r = sh_("close", TUNNEL_CONN)
    check("tunnel script: `close` before `arm` is refused", r.returncode == 5 and "ufw delete" not in calls() and "ufw allow 22/tcp" in rules())
    r = sh_("arm", PUBLIC_CONN)
    check("tunnel script: `arm` starts a ten-minute timer whose whole job is `ufw allow 22/tcp`", r.returncode == 0 and "ROLLBACK=armed" in r.stdout and "--on-active=600" in calls() and any(l.startswith("systemd-run ") and l.endswith("/usr/sbin/ufw allow 22/tcp") for l in calls().splitlines()), calls())
    mark = len(calls()); r = sh_("up", PUBLIC_CONN)
    check("tunnel script: `up` makes the server's own key, brings the interface up now and at boot, and ADDS the two rules", r.returncode == 0 and f"SERVER_PUBLIC_KEY={SPUB}" in r.stdout and t_ssh in rules() and t_wg in rules()
          and f"systemctl enable wg-quick@{T['interface']}" in calls() and f"systemctl restart wg-quick@{T['interface']}" in calls(), r.stdout + r.stderr)
    check("tunnel script:   ...public SSH is untouched by it", "ufw allow 22/tcp" in rules() and "PUBLIC_SSH=open" in r.stdout and "ufw delete" not in calls()[mark:])
    kf = os.path.join(wgd, f"{T['interface']}.key")
    check("tunnel script:   ...the key file is root-only and its content was printed nowhere", stat.S_IMODE(os.stat(kf).st_mode) == 0o600 and open(kf).read().strip() == PRIVATE and PRIVATE not in "".join(everything)
          and stat.S_IMODE(os.stat(os.path.join(wgd, f"{T['interface']}.conf")).st_mode) == 0o600 and PRIVATE not in open(os.path.join(wgd, f"{T['interface']}.conf")).read())
    mark = len(calls()); r = sh_("up", PUBLIC_CONN)
    check("tunnel script: a second `up` adds no duplicate rule, keeps the key and does not restart a running interface", r.returncode == 0 and rules().count(t_ssh) == 1 and rules().count(t_wg) == 1 and open(kf).read().strip() == PRIVATE
          and "genkey" not in calls()[mark:] and "restart" not in calls()[mark:], calls()[mark:])
    r = sh_("hello", PUBLIC_CONN)
    check("tunnel script: `hello` over the public address answers but exits non-zero (it is not the tunnel)", r.returncode != 0 and "VIA_TUNNEL=no" in r.stdout)
    for label, conn in (("over the public address", PUBLIC_CONN), ("from the factory's public address to the tunnel address (not the tunnel peer)", SPOOF), ("with no record of how it arrived", "")):
        mark = len(calls()); r = sh_("close", conn)
        check(f"tunnel script: `close` {label} is refused and public SSH stays open", r.returncode == 7 and "ufw allow 22/tcp" in rules() and "ufw delete" not in calls()[mark:] and "public SSH stays open" in r.stderr, r.stderr)
    r = sh_("confirm", PUBLIC_CONN)
    check("tunnel script: `confirm` over the public address is refused and the rollback stays armed", r.returncode == 7 and os.path.exists(os.path.join(sd, "units", f"{W.rollback_unit(S)}.timer")))
    r = sh_("hello", TUNNEL_CONN)
    check("tunnel script: `hello` over the tunnel says so", r.returncode == 0 and "VIA_TUNNEL=yes" in r.stdout and "PUBLIC_SSH=open" in r.stdout and "ROLLBACK=armed" in r.stdout)
    r = sh_("close", TUNNEL_CONN)
    check("tunnel script: `close` over the tunnel, with the rollback armed, deletes the public SSH rule and nothing else", r.returncode == 0 and "PUBLIC_SSH=closed" in r.stdout and "ufw allow 22/tcp" not in rules()
          and all(x in rules() for x in ("ufw allow 80/tcp", "ufw allow 443/tcp", t_ssh, t_wg)) and os.path.exists(os.path.join(sd, "units", f"{W.rollback_unit(S)}.timer")), rules())
    check("tunnel script:   ...leaving exactly the rules every later deploy keeps", sorted(x for x in rules() if x) == V.ufw_rules(dict(S, tunnel=Tk, tunnel_on=True)), rules())
    check("tunnel script:   ...a second `close` is harmless", sh_("close", TUNNEL_CONN).returncode == 0 and "ufw allow 22/tcp" not in rules())
    r = sh_("down", PUBLIC_CONN)
    check("tunnel script: `down` while public SSH is closed is refused (it would lock everyone out)", r.returncode == 7 and t_ssh in rules())
    r = sh_("confirm", TUNNEL_CONN)
    check("tunnel script: `confirm` over the tunnel cancels the rollback", r.returncode == 0 and "ROLLBACK=cancelled" in r.stdout and not os.path.exists(os.path.join(sd, "units", f"{W.rollback_unit(S)}.timer")))
    sh_("arm", TUNNEL_CONN); subprocess.run([os.path.join(sd, "bin", "ufw"), "allow", "22/tcp"]); os.remove(os.path.join(sd, "units", f"{W.rollback_unit(S)}.timer"))     # the timer fired
    r = sh_("confirm", TUNNEL_CONN)
    check("tunnel script: after the rollback has fired, `confirm` says public SSH is open and does not pretend otherwise", r.returncode == 9 and "PUBLIC_SSH=open" in r.stdout)
    r = sh_("close", TUNNEL_CONN)
    check("tunnel script:   ...and `close` will not run again without a fresh `arm`", r.returncode == 5 and "ufw allow 22/tcp" in rules())
    subprocess.run([os.path.join(sd, "bin", "ufw"), "delete", "allow", "22/tcp"])
    r = sh_("open", TUNNEL_CONN)
    check("tunnel script: `open` puts the public rule back (the first step of --off, and what the break-glass command does)", r.returncode == 0 and "PUBLIC_SSH=open" in r.stdout and "ufw allow 22/tcp" in rules())
    r = sh_("down", TUNNEL_CONN)
    check("tunnel script: `down` sent over the tunnel is refused (it would cut its own session)", r.returncode == 7 and t_ssh in rules())
    r = sh_("down", PUBLIC_CONN)
    check("tunnel script: `down` over the public address removes the two tunnel rules, stops the interface, removes the conf, keeps the key and 22/80/443",
          r.returncode == 0 and "TUNNEL=off" in r.stdout and sorted(x for x in rules() if x) == ["ufw allow 22/tcp", "ufw allow 443/tcp", "ufw allow 80/tcp"] and f"systemctl disable --now wg-quick@{T['interface']}" in calls()
          and not os.path.exists(os.path.join(wgd, f"{T['interface']}.conf")) and os.path.exists(kf), rules())
    open(os.path.join(sd, "addrs"), "a").write(f"3: br0    inet {T['server_address']}/24 scope global br0\n"); sh_("arm", PUBLIC_CONN); mark = len(calls()); r = sh_("up", PUBLIC_CONN)
    check("tunnel script: a server that already uses the tunnel's network is refused before anything is installed or opened", r.returncode == 4 and "already has an address inside" in r.stderr and "ufw allow" not in calls()[mark:])
    check("tunnel script: in everything it printed, across every run, there is no private key", PRIVATE not in "".join(everything) and "sshd" not in calls() and "fail2ban" not in calls())
