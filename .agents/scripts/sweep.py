#!/usr/bin/env python3
"""sweep.py — keep the factory moving: one read-only plan of what is waiting, and a guarded clean-up.

  sweep.py plan [--json] [--tmp-root DIR ...] [--no-gh]
        Computes, without changing anything:
          prs       every open pull request (gh pr list): mergeable, draft, checks, the ticket it names, the database
                    migrations it ADDS under a migration folder and whether their numbers clash with main's highest or
                    with another open pull request's
          tickets   which todo tickets can start now: every depends_on done (strict phase order), not gated (a ticket
                    `gate`, an id in sweep.gated_ids, an owner in sweep.gated_owners), within sweep.max_builders in all
                    and sweep.builders_per_train per train (the ticket's `train`, else sweep.trains, else its mold)
          deploys   apps whose last deploy is behind their mold (mint.py's own deploy station decides "the mold moved"),
                    split into auto (sweep.auto_deploy), parity (sweep.parity_deploy: only once parity is proven) and
                    needs a yes; a change that adds or edits a database migration (live data) always needs a yes
          hygiene   wait loops (`until|while ... pgrep`) older than sweep.stale_wait_hours, dev/test servers left
                    running under a tmp root, free disk against sweep.disk_free_min_gb, and the scratch folders under
                    each tmp root with whether a process uses them and whether they are finished. With PIDs. It never
                    stops or removes anything.
  sweep.py clean --dry-run [--scratch] [--tmp-root DIR ...] [--json]
        What clean would do: stop the stale wait loops and leftover servers the plan lists (by PID), and remove the
        finished scratch folders under the tmp roots when free disk is below the threshold (or with --scratch).
  sweep.py clean --apply [--yes] [--scratch] [--tmp-root DIR ...] [--json]
        Does it. Stopping processes and deleting folders needs a yes (AGENTS.md "What needs an explicit yes"), so
        without --yes it does nothing and exits 3 (needs_human) with the list. --yes may be given when the operator
        said yes to this clean-up, or has a standing instruction that the sweep may clean (written in AGENTS.local.md).
        Before each step it looks again: a PID that is now a different process is skipped, and a folder a process
        has started to use is kept. A folder outside the tmp roots is never removed.
  sweep.py --self-test        offline, with stand-ins for gh, ps, git and df

Merging, deploying and starting builders stay the agent's job (judgment and the operator's rules: the `sweep` skill).
This script plans and checks.

Settings: state/factory.json "sweep", with state/factory.local.json's "sweep" merged over it (the machine's own app
ids for auto_deploy and parity_deploy belong there); every key is optional and DEFAULTS below fill the rest.
Ticket fields it reads beyond the schema's usual ones: `train` (a name) and `gate` (a kind such as "dated_decision" or
"operator_action", or {"kind": ..., "until": "YYYY-MM-DD", "why": ...}).

Exit codes (AGENTS.md "Script protocol"): 0 done, 1 failed, 2 could not run, 3 a human is needed. With --json one
result ({"ok","status","summary","next","needs","log","details"}; lib/agent_result.py). Standard library only.
"""
import datetime, fnmatch, glob, json, os, re, shutil, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "lib"))
import agent_result as AR   # the one --json result shape

DEFAULTS = {
    "max_builders": 3,                 # builders (in_progress tickets) at once, over every mold
    "builders_per_train": 1,           # per train: one builder works a train's tickets in order
    "trains": {},                      # name -> {"ids": [...], "prefixes": [...], "molds": [...], "types": [...]}
    "molds": [],                       # molds whose tickets are swept; [] = every mold whose status is active or wip
    "gated_ids": [],                   # tickets that never start from a sweep
    "gated_kinds": ["dated_decision", "operator_action", "live_data_migration"],
    "gated_owners": ["sol"],           # the operator's own tickets (state/factory.json operator.human_role)
    "auto_deploy": [],                 # apps whose mold-moved redeploys are pre-approved (no migration in the change)
    "parity_deploy": [],               # apps redeployed only once a parity check proved the change (and no migration)
    "migration_dirs": ["molds/*/codebase/sql/migrations"],
    "stale_wait_hours": 3,
    "server_max_hours": 12,
    "scratch_idle_hours": 24,
    "disk_free_min_gb": 20,
    "tmp_roots": ["~/.claude/jobs/*/tmp"],
    "base_branch": "main",
    "server_patterns": [r"\bnext(-server)? (dev|start)\b", r"\bnext-server\b", r"\bvite\b", r"\b(npm|pnpm|yarn|bun) (run )?(dev|start|preview)\b",
                        r"\bnode\b.*\b(server|dev)\b", r"\bhttp\.server\b", r"\buvicorn\b", r"\bplaywright\b",
                        r"\bpostgres\b.*\s-D\s", r"\btsx\b.*\b(watch|server)\b", r"\bwrangler dev\b"],
}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash"}
WAIT_RX = re.compile(r"\b(until|while)\b.*\bpgrep\b", re.S)
MIG_RX = re.compile(r"^(\d+)[_-]")
GATED_STATUSES_RUNNING = ("in_progress",)


# ---- stand-in points (the self-test replaces these) ---------------------------------------------------------------

def _run(cmd, cwd=None, timeout=120):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, "", str(e)


def _procs():
    """Every process: {pid, ppid, etimes (seconds running), args, cwd}."""
    rc, out, _ = RUN(["ps", "-eo", "pid=,ppid=,etimes=,args="])
    if rc: return []
    res = []
    for line in out.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 3 or not parts[0].isdigit(): continue
        pid, ppid, et = int(parts[0]), int(parts[1]), int(parts[2]) if parts[2].isdigit() else 0
        try: cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError: cwd = ""
        res.append({"pid": pid, "ppid": ppid, "etimes": et, "args": parts[3] if len(parts) > 3 else "", "cwd": cwd})
    return res


def _disk(path):
    u = shutil.disk_usage(path); return u.total, u.free


def _kill(pid, sig): os.kill(pid, sig)


RUN, PROCS, DISK, KILL, NOW, MYPID = _run, _procs, _disk, _kill, time.time, os.getpid
DEPLOY_STATION = None   # (app, application, infrastructure) -> (status, sentence); None = mint.py's own st_deploy


# ---- settings and state -------------------------------------------------------------------------------------------

def load_json(p):
    with open(p) as f: return json.load(f)


def settings(root):
    """state/factory.json with this machine's state/factory.local.json merged over it (lib/factory_local.py), so the
    app ids in auto_deploy / parity_deploy can stay in the git-ignored local file."""
    from factory_local import load_factory
    fj = load_factory(os.path.join(root, "state"))
    cfg = dict(DEFAULTS); cfg.update(fj.get("sweep") or {})
    return fj, cfg


def read_tasks(root, mold):
    p = os.path.join(root, "state", "tasks", f"{mold}.jsonl")
    if not os.path.exists(p): return []
    return [json.loads(l) for l in open(p) if l.strip()]


def task_num(tid):
    m = re.search(r"-(\d+)$", tid or ""); return int(m.group(1)) if m else 0


# ---- pull requests ------------------------------------------------------------------------------------------------

def is_migration(path, cfg):
    d, b = os.path.dirname(path), os.path.basename(path)
    if not MIG_RX.match(b): return None
    for pat in cfg["migration_dirs"]:
        if fnmatch.fnmatch(d, pat.rstrip("/")): return d
    return None


def main_migrations(root, cfg):
    """{migration dir: {number: [file, ...]}} on the base branch (origin/<base>, else <base>, else the files on disk)."""
    files = None
    for ref in (f"origin/{cfg['base_branch']}", cfg["base_branch"]):
        rc, out, _ = RUN(["git", "-C", root, "ls-tree", "-r", "--name-only", ref])
        if rc == 0: files = out.splitlines(); break
    if files is None:
        files = []
        for pat in cfg["migration_dirs"]:
            for d in glob.glob(os.path.join(root, pat)):
                files += [os.path.relpath(os.path.join(d, f), root) for f in os.listdir(d)]
    res = {}
    for f in files:
        d = is_migration(f, cfg)
        if d: res.setdefault(d, {}).setdefault(int(MIG_RX.match(os.path.basename(f)).group(1)), []).append(f)
    return res


def pr_added_files(root, number):
    rc, out, err = RUN(["gh", "api", "--paginate", f"repos/{{owner}}/{{repo}}/pulls/{number}/files",
                        "--jq", '.[] | select(.status=="added") | .filename'], cwd=root)
    return ([l.strip() for l in out.splitlines() if l.strip()], None) if rc == 0 else (None, (err or out).strip()[:200])


def checks_state(rollup):
    if not rollup: return "none"
    st = set()
    for c in rollup:
        concl = (c.get("conclusion") or "").upper(); state = (c.get("state") or "").upper(); status = (c.get("status") or "").upper()
        if concl in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE") or state in ("FAILURE", "ERROR"): st.add("failing")
        elif (status and status != "COMPLETED") or state in ("PENDING", "EXPECTED"): st.add("pending")
        else: st.add("green")
    return "failing" if "failing" in st else "pending" if "pending" in st else "green"


def plan_prs(root, cfg):
    rc, out, err = RUN(["gh", "pr", "list", "--state", "open", "--limit", "100", "--json",
                        "number,title,headRefName,mergeable,isDraft,statusCheckRollup,url"], cwd=root)
    if rc: return {"error": f"gh pr list did not answer: {(err or out).strip()[:200]}", "items": []}
    try: items = json.loads(out or "[]")
    except ValueError: return {"error": "gh pr list printed something that is not JSON", "items": []}
    main = main_migrations(root, cfg)
    res = []
    for p in items:
        added, aerr = pr_added_files(root, p["number"])
        migs = []
        for f in added or []:
            d = is_migration(f, cfg)
            if d: migs.append({"dir": d, "number": int(MIG_RX.match(os.path.basename(f)).group(1)), "file": f})
        tid = re.search(r"\b([a-z0-9_]+-\d{3})\b", f"{p.get('headRefName', '')} {p.get('title', '')}")
        res.append({"number": p["number"], "title": p.get("title", ""), "branch": p.get("headRefName", ""), "url": p.get("url", ""),
                    "mergeable": p.get("mergeable", "UNKNOWN"), "draft": bool(p.get("isDraft")),
                    "checks": checks_state(p.get("statusCheckRollup")), "ticket": tid.group(1) if tid else None,
                    "migrations": migs, "files_error": aerr, "clashes": []})
    # clashes: with main (a number main already has, or not above main's highest), and with every other open PR
    for r in res:
        for m in r["migrations"]:
            have = main.get(m["dir"], {}); top = max(have) if have else 0
            if m["number"] in have: r["clashes"].append(f"{m['file']}: number {m['number']} already on {cfg['base_branch']} ({', '.join(have[m['number']])})")
            elif m["number"] <= top: r["clashes"].append(f"{m['file']}: number {m['number']} is not above {cfg['base_branch']}'s highest ({top}) in {m['dir']}")
            for o in res:
                if o is r: continue
                for om in o["migrations"]:
                    if om["dir"] == m["dir"] and om["number"] == m["number"]:
                        r["clashes"].append(f"{m['file']}: number {m['number']} is also added by PR #{o['number']} ({om['file']})")
    for r in res:
        b = []
        if r["draft"]: b.append("draft")
        if r["mergeable"] != "MERGEABLE": b.append(f"mergeable is {r['mergeable']}")
        if r["checks"] in ("failing", "pending"): b.append(f"checks {r['checks']}")
        if r["files_error"]: b.append(f"its files could not be read ({r['files_error']}), so migrations are unchecked")
        if r["clashes"]: b.append("migration number clash")
        r["blockers"] = b; r["merge_ready"] = not b
    return {"error": None, "items": res, "main_highest": {d: max(n) for d, n in main.items() if n}}


# ---- tickets ------------------------------------------------------------------------------------------------------

def train_of(t, cfg):
    if t.get("train"): return str(t["train"])
    for name, rule in (cfg.get("trains") or {}).items():
        if t["task_id"] in (rule.get("ids") or []): return name
        if any(t["task_id"].startswith(p) for p in rule.get("prefixes") or []): return name
        if rule.get("molds") and t.get("mold_id") not in rule["molds"]: continue
        if rule.get("types") and t.get("type") not in rule["types"]: continue
        if rule.get("molds") or rule.get("types"): return name
    return t.get("mold_id") or "default"


def gate_of(t, cfg, today):
    if t["task_id"] in cfg["gated_ids"]: return "listed in sweep.gated_ids"
    g = t.get("gate")
    if g:
        kind = g if isinstance(g, str) else (g.get("kind") or "gate")
        if kind in cfg["gated_kinds"] or kind not in DEFAULTS["gated_kinds"]:
            why = "" if isinstance(g, str) else (f", until {g['until']}" if g.get("until") else "") + (f": {g['why']}" if g.get("why") else "")
            return f"gate {kind}{why}"
    if t.get("owner") in cfg["gated_owners"]: return f"owner {t['owner']} (an operator action)"
    return None


def plan_tickets(root, cfg, fj):
    molds = cfg["molds"] or [m["mold_id"] for m in fj.get("molds", []) if m.get("status") in ("active", "wip")]
    allt = {}
    for m in [x["mold_id"] for x in fj.get("molds", [])]:
        for t in read_tasks(root, m): allt[t["task_id"]] = t
    today = datetime.date.today().isoformat()
    sweep = [t for t in allt.values() if t.get("mold_id") in molds]
    running = sorted((t for t in allt.values() if t.get("status") in GATED_STATUSES_RUNNING), key=lambda t: t["task_id"])
    per_train = {}
    for t in running: per_train[train_of(t, cfg)] = per_train.get(train_of(t, cfg), 0) + 1
    ready, gated, blocked = [], [], []
    for t in sorted((t for t in sweep if t.get("status") == "todo"), key=lambda t: (t.get("priority", 3), t["mold_id"], task_num(t["task_id"]))):
        waits = [d for d in t.get("depends_on", []) if allt.get(d, {}).get("status") != "done"]
        if waits:
            dead = [d for d in waits if allt.get(d, {}).get("status") in ("dropped", None)]
            blocked.append({"task_id": t["task_id"], "waits_on": waits, "dropped_or_unknown": dead}); continue
        g = gate_of(t, cfg, today)
        if g: gated.append({"task_id": t["task_id"], "title": t["title"], "why": g}); continue
        ready.append(t)
    start, waiting = [], []
    slots = max(0, cfg["max_builders"] - len(running))
    for t in ready:
        tr = train_of(t, cfg); row = {"task_id": t["task_id"], "title": t["title"], "train": tr, "priority": t.get("priority"),
                                       "mold_id": t["mold_id"], "product_id": t.get("product_id")}
        if per_train.get(tr, 0) >= cfg["builders_per_train"]: waiting.append(dict(row, why=f"train {tr} is full")); continue
        if len(start) >= slots: waiting.append(dict(row, why=f"max_builders {cfg['max_builders']} reached")); continue
        start.append(row); per_train[tr] = per_train.get(tr, 0) + 1
    return {"molds": molds, "running": [{"task_id": t["task_id"], "title": t["title"], "train": train_of(t, cfg), "updated": t.get("updated")} for t in running],
            "start": start, "ready_waiting": waiting, "gated": gated, "blocked": [b for b in blocked if b["dropped_or_unknown"]],
            "blocked_count": len(blocked)}


# ---- deploys ------------------------------------------------------------------------------------------------------

def _mint():
    sys.path.insert(0, HERE)
    import mint
    return mint


def deploy_station(app, a, i):
    if DEPLOY_STATION: return DEPLOY_STATION(app, a, i)
    m = _mint()
    m.CODE_FIRST[app] = ""     # never look up workspace membership over the network from a plan
    return m.st_deploy(app, a, i)


def mold_now(root, mold_id):
    if root == ROOT:
        try: return _mint().mold_commit(mold_id)
        except Exception: pass
    for m in load_json(os.path.join(root, "state", "factory.json")).get("molds", []):
        if m.get("mold_id") == mold_id: return (m.get("source") or {}).get("commit")


def migration_change(root, cfg, mold_id, was, now):
    """True / False when this repository holds both commits (an in-tree mold), else None (cannot tell: needs a yes)."""
    try:
        import intree
        I = intree.info(mold_id, root)
    except Exception: I = None
    if not I or not was or not now: return None, "the mold's history is not in this repository, so a migration cannot be ruled out"
    fork = (I.get("forked_from") or {}).get("commit")
    base = I.get("since") if fork and was == fork else was
    paths = [f"molds/{mold_id}/codebase"]   # every changed file under the codebase, then kept only when it is a migration
    rc, out, err = RUN(["git", "-C", root, "diff", "--name-only", f"{base}..{now}", "--", *paths])
    if rc: return None, f"git diff {base[:7]}..{now[:7]} did not answer ({(err or '').strip()[:120]}); fetch more history"
    ch = [l for l in out.splitlines() if l.strip() and is_migration(l.strip(), cfg)]
    return bool(ch), (f"changes migrations: {', '.join(ch[:5])}" if ch else "no migration in the change")


def plan_deploys(root, cfg):
    adir = os.path.join(root, "state", "application")
    out = {"auto": [], "parity": [], "needs_yes": [], "needs_operator": [], "not_behind": [], "errors": []}
    if not os.path.isdir(adir): return out
    for app in sorted(os.listdir(adir)):
        if app == "app_id" or not os.path.isdir(os.path.join(adir, app)): continue
        try:
            a = load_json(os.path.join(adir, app, "application.json")); i = load_json(os.path.join(adir, app, "infrastructure.json"))
        except (OSError, ValueError) as e:
            out["errors"].append({"app": app, "why": f"state unreadable: {e}"}); continue
        try: status, said = deploy_station(app, a, i)
        except Exception as e:
            out["errors"].append({"app": app, "why": f"mint.py's deploy station raised {type(e).__name__}: {e}"}); continue
        if "the mold moved" not in str(said):
            out["not_behind"].append({"app": app, "station": status, "said": said}); continue
        was, now = a.get("mold_commit"), mold_now(root, a.get("mold_id"))
        mig, why = migration_change(root, cfg, a.get("mold_id"), was, now)
        row = {"app": app, "mold_id": a.get("mold_id"), "from": (was or "")[:12], "to": (now or "")[:12], "said": said,
               "migration": mig, "migration_note": why, "command": f"python3 .claude/scripts/provision.py {app} --deploy --background"}
        if status in ("needs you", "needs_human"): out["needs_operator"].append(dict(row, why="mint.py says the operator is needed first"))
        elif mig is not False: out["needs_yes"].append(dict(row, why="live-data migration" if mig else "a migration cannot be ruled out"))
        elif app in cfg["auto_deploy"]: out["auto"].append(dict(row, why="pre-approved in sweep.auto_deploy"))
        elif app in cfg["parity_deploy"]: out["parity"].append(dict(row, why="sweep.parity_deploy: deploy only after the parity check proves the change"))
        else: out["needs_yes"].append(dict(row, why="a live app not in sweep.auto_deploy or sweep.parity_deploy"))
    return out


# ---- hygiene ------------------------------------------------------------------------------------------------------

def tmp_roots(cfg, extra):
    roots = []
    for pat in list(extra or []) or cfg["tmp_roots"]:
        for d in glob.glob(os.path.expanduser(pat)):
            if os.path.isdir(d): roots.append(os.path.realpath(d))
    return sorted(set(roots))


def protected(procs):
    """This process and every ancestor: never a candidate."""
    by = {p["pid"]: p for p in procs}; me = MYPID(); keep = set()
    while me and me not in keep:
        keep.add(me); me = by.get(me, {}).get("ppid")
    return keep


def first_word(args):
    w = (args.split() or [""])[0]
    return os.path.basename(w).lstrip("-")


def under(path, root):
    return bool(path) and (path == root or path.startswith(root.rstrip("/") + "/"))


def plan_hygiene(root, cfg, extra_roots=None):
    procs = PROCS(); keep = protected(procs); roots = tmp_roots(cfg, extra_roots); now = NOW()
    waits, servers = [], []
    srx = [re.compile(r) for r in cfg["server_patterns"]]
    for p in procs:
        if p["pid"] in keep or "sweep.py" in p["args"]: continue
        fw = first_word(p["args"])
        if fw in SHELLS and WAIT_RX.search(p["args"]) and p["etimes"] >= cfg["stale_wait_hours"] * 3600:
            waits.append({"pid": p["pid"], "hours": round(p["etimes"] / 3600, 1), "args": p["args"][:300]}); continue
        if fw in SHELLS or fw in ("pgrep", "grep", "ps"): continue
        if not any(r.search(p["args"]) for r in srx): continue
        where = next((r for r in roots if under(p["cwd"], r) or r + "/" in p["args"]), None)
        if not where: continue
        orphan = p["ppid"] == 1; old = p["etimes"] >= cfg["server_max_hours"] * 3600
        if orphan or old:
            servers.append({"pid": p["pid"], "hours": round(p["etimes"] / 3600, 1), "cwd": p["cwd"], "args": p["args"][:300],
                            "why": "orphaned (its parent is gone)" if orphan else f"running over {cfg['server_max_hours']} h"})
    # disk: the factory's filesystem and every tmp root's
    disks, seen = [], set()
    for d in [root] + roots:
        try: dev = os.stat(d).st_dev
        except OSError: continue
        if dev in seen: continue
        seen.add(dev); total, free = DISK(d)
        disks.append({"path": d, "free_gb": round(free / 1e9, 1), "total_gb": round(total / 1e9, 1), "low": free / 1e9 < cfg["disk_free_min_gb"]})
    scratch = []
    for r in roots:
        for name in sorted(os.listdir(r)):
            d = os.path.join(r, name)
            if os.path.islink(d) or not os.path.isdir(d): continue
            scratch.append(scratch_state(d, procs, cfg, now))
    return {"tmp_roots": roots, "stale_waits": waits, "stale_servers": servers, "disk": disks,
            "disk_low": any(x["low"] for x in disks), "scratch": scratch}


def users_of(d, procs):
    return [p["pid"] for p in procs if under(p["cwd"], d) or (d + "/") in p["args"] or p["args"].endswith(d) or (" " + d + " ") in p["args"]]


def scratch_state(d, procs, cfg, now):
    users = users_of(d, procs)
    marks = [d] + [os.path.join(d, n) for n in (os.listdir(d) if os.path.isdir(d) else [])] + \
            [os.path.join(d, ".git", n) for n in ("index", "HEAD", "FETCH_HEAD", os.path.join("logs", "HEAD"))]
    last = max((os.lstat(m).st_mtime for m in marks if os.path.lexists(m)), default=0)
    idle_h = round((now - last) / 3600, 1)
    why = None
    if users: why = f"in use by PID {', '.join(map(str, users[:5]))}"
    elif idle_h < cfg["scratch_idle_hours"]: why = f"touched {idle_h} h ago (under {cfg['scratch_idle_hours']} h)"
    elif os.path.isdir(os.path.join(d, ".git")):
        rc, out, _ = RUN(["git", "-C", d, "status", "--porcelain"])
        if rc: why = "git status did not answer"
        elif out.strip(): why = "uncommitted changes"
        else:
            rc, out, _ = RUN(["git", "-C", d, "log", "--branches", "--not", "--remotes", "--oneline", "-1"])
            if rc: why = "could not tell whether every commit is pushed"
            elif out.strip(): why = "commits not pushed"
    return {"path": d, "idle_hours": idle_h, "in_use_by": users, "finished": why is None, "kept_because": why}


# ---- plan ---------------------------------------------------------------------------------------------------------

def plan(root=ROOT, extra_roots=None, use_gh=True):
    fj, cfg = settings(root)
    P = {"settings": cfg,
         "prs": plan_prs(root, cfg) if use_gh else {"error": "skipped (--no-gh)", "items": []},
         "tickets": plan_tickets(root, cfg, fj),
         "deploys": plan_deploys(root, cfg),
         "hygiene": plan_hygiene(root, cfg, extra_roots)}
    return P


def plain(P):
    L = []; pr = P["prs"]; tk = P["tickets"]; dp = P["deploys"]; hy = P["hygiene"]
    L.append("Pull requests" + (f" ({pr['error']})" if pr.get("error") else ""))
    for r in pr["items"]:
        L.append(f"  #{r['number']} {r['title'][:70]}  [{r['ticket'] or 'no ticket'}]  " +
                 ("READY to merge" if r["merge_ready"] else "waiting: " + "; ".join(r["blockers"])))
        for c in r["clashes"]: L.append(f"      clash: {c}")
    if not pr["items"]: L.append("  none open")
    L.append(f"Tickets ({len(tk['running'])} builder(s) running, max {P['settings']['max_builders']})")
    for t in tk["start"]: L.append(f"  start {t['task_id']}  [{t['train']}]  {t['title'][:80]}")
    for t in tk["ready_waiting"]: L.append(f"  ready, waiting ({t['why']}): {t['task_id']}")
    for t in tk["gated"]: L.append(f"  gated ({t['why']}): {t['task_id']}")
    for t in tk["blocked"]: L.append(f"  stuck: {t['task_id']} waits on dropped/unknown {', '.join(t['dropped_or_unknown'])}")
    if not (tk["start"] or tk["ready_waiting"]): L.append("  nothing ready to start")
    L.append("Deploys (apps behind their mold)")
    for k, label in (("auto", "deploy (pre-approved)"), ("parity", "deploy after parity is proven"), ("needs_yes", "needs a yes"), ("needs_operator", "needs the operator")):
        for r in dp[k]: L.append(f"  {label}: {r['app']} {r['from'][:7]} -> {r['to'][:7]} ({r['why']}; {r['migration_note']})")
    for e in dp["errors"]: L.append(f"  could not read {e['app']}: {e['why']}")
    if not any(dp[k] for k in ("auto", "parity", "needs_yes", "needs_operator")): L.append("  every deployed app is on its mold")
    L.append("Hygiene")
    for w in hy["stale_waits"]: L.append(f"  stale wait loop PID {w['pid']} ({w['hours']} h): {w['args'][:120]}")
    for s in hy["stale_servers"]: L.append(f"  leftover server PID {s['pid']} ({s['why']}): {s['args'][:120]}")
    for d in hy["disk"]: L.append(f"  disk {d['path']}: {d['free_gb']} GB free" + (" LOW" if d["low"] else ""))
    fin = [s for s in hy["scratch"] if s["finished"]]
    L.append(f"  scratch: {len(hy['scratch'])} folder(s) under {len(hy['tmp_roots'])} tmp root(s), {len(fin)} finished")
    return "\n".join(L)


def summary(P):
    pr = P["prs"]["items"]; tk = P["tickets"]; dp = P["deploys"]; hy = P["hygiene"]
    return (f"{sum(r['merge_ready'] for r in pr)} of {len(pr)} PR(s) ready to merge; {len(tk['start'])} ticket(s) to start; "
            f"{len(dp['auto']) + len(dp['parity'])} deploy(s) allowed, {len(dp['needs_yes']) + len(dp['needs_operator'])} waiting on a person; "
            f"{len(hy['stale_waits']) + len(hy['stale_servers'])} stale process(es); disk {'LOW' if hy['disk_low'] else 'ok'}")


# ---- clean --------------------------------------------------------------------------------------------------------

def clean_targets(H, scratch):
    kills = [dict(w, kind="wait loop") for w in H["stale_waits"]] + [dict(s, kind="server") for s in H["stale_servers"]]
    rms = [s for s in H["scratch"] if s["finished"]] if (scratch or H["disk_low"]) else []
    return kills, rms


def clean(root, apply, yes, scratch, extra_roots):
    _, cfg = settings(root)
    H = plan_hygiene(root, cfg, extra_roots)
    kills, rms = clean_targets(H, scratch)
    items = [f"stop PID {k['pid']} ({k['kind']}, {k['hours']} h): {k['args'][:100]}" for k in kills] + [f"remove {r['path']} (idle {r['idle_hours']} h)" for r in rms]
    det = {"stop": kills, "remove": [r["path"] for r in rms], "disk_low": H["disk_low"]}
    if not items: return AR.result(True, "done", "Nothing to clean.", "", [], "", det)
    if not apply: return AR.result(True, "done", f"Would do {len(items)} thing(s) (dry run): " + "; ".join(items), "sweep.py clean --apply --yes, once the operator said yes", [], "", det)
    if not yes:
        how = ("Stopping these processes and deleting these folders needs a yes: " + "; ".join(items) +
               ". Reply yes (or keep a standing instruction in AGENTS.local.md that the sweep may clean), then run sweep.py clean --apply --yes.")
        return AR.result(False, "needs_human", f"{len(items)} clean-up step(s) wait for a yes.", "ask the operator", [{"kind": "approval", "name": "sweep clean", "how": how}], "", det)
    done, skipped = [], []
    now_procs = {p["pid"]: p for p in PROCS()}
    for k in kills:
        p = now_procs.get(k["pid"])
        if not p or p["args"][:300] != k["args"] or p["etimes"] + 5 < k["hours"] * 3600 - 360:
            skipped.append(f"PID {k['pid']}: no longer the same process"); continue
        try: KILL(k["pid"], signal.SIGTERM); done.append(f"stopped PID {k['pid']}")
        except OSError as e: skipped.append(f"PID {k['pid']}: {e}")
    roots = H["tmp_roots"]; procs = PROCS()
    for r in rms:
        d = os.path.realpath(r["path"])
        if os.path.islink(r["path"]) or not any(under(d, rt) and d != rt for rt in roots):
            skipped.append(f"{r['path']}: not inside a tmp root"); continue
        users = users_of(d, procs)
        if users: skipped.append(f"{r['path']}: now in use by PID {users[0]}"); continue
        try: shutil.rmtree(d); done.append(f"removed {r['path']}")
        except OSError as e: skipped.append(f"{r['path']}: {e}")
    det.update({"done": done, "skipped": skipped})
    return AR.result(True, "done", f"{len(done)} done, {len(skipped)} skipped." + (" Skipped: " + "; ".join(skipped) if skipped else ""), "", [], "", det)


# ---- command line -------------------------------------------------------------------------------------------------

def opts(argv, name):
    out, i = [], 0
    while i < len(argv):
        if argv[i] == name and i + 1 < len(argv): out.append(argv[i + 1]); i += 2
        else: i += 1
    return out


def main(argv):
    if argv[:1] == ["--self-test"]: return self_test()
    as_json = "--json" in argv; argv = [a for a in argv if a != "--json"]
    roots = opts(argv, "--tmp-root")
    def out(res, text=None):
        if as_json: return AR.emit(res)
        print(text if text is not None else res["summary"])
        for n in res["needs"]: print(f"needs: {n['how']}")
        return AR.exit_code(res)
    if not argv or argv[0] not in ("plan", "clean"):
        print(__doc__); return 2
    if not os.path.exists(os.path.join(ROOT, "state", "factory.json")):
        out(AR.result(False, "failed", "state/factory.json is missing; run from the factory repository.", "", [], "", {})); return 2
    if argv[0] == "plan":
        P = plan(ROOT, roots, use_gh="--no-gh" not in argv)
        nxt = "merge the ready PRs, deploy what is allowed, start the listed tickets, then sweep.py clean --dry-run (the sweep skill)"
        return out(AR.result(True, "done", summary(P), nxt, [], "", P), plain(P) + "\n\n" + summary(P))
    apply, dry = "--apply" in argv, "--dry-run" in argv
    if apply == dry:
        print("clean needs exactly one of --dry-run or --apply"); return 2
    res = clean(ROOT, apply, "--yes" in argv, "--scratch" in argv, roots)
    det = res["details"]
    text = res["summary"] + "".join(f"\n  {x}" for x in det.get("done", []) + det.get("skipped", []))
    return out(res, text)


# ---- self-test ----------------------------------------------------------------------------------------------------

def self_test():
    import tempfile
    global RUN, PROCS, DISK, KILL, NOW, MYPID, DEPLOY_STATION
    saved = (RUN, PROCS, DISK, KILL, NOW, MYPID, DEPLOY_STATION)
    fails = []
    def ok(cond, what):
        print(("ok    " if cond else "FAIL  ") + what)
        if not cond: fails.append(what)
    t = tempfile.mkdtemp(prefix="sweep-selftest-")
    saved_local = os.environ.get("FACTORY_LOCAL"); os.environ["FACTORY_LOCAL"] = os.path.join(t, "no-local.json")   # never this machine's file
    try:
        R = os.path.join(t, "repo"); os.makedirs(os.path.join(R, "state", "tasks")); os.makedirs(os.path.join(R, "state", "application"))
        mig = os.path.join(R, "molds", "mold_a", "codebase", "sql", "migrations"); os.makedirs(mig)
        for n in ("0001_init.sql", "0002_users.sql", "0003_keys.sql"): open(os.path.join(mig, n), "w").write("--\n")
        fj = {"molds": [{"mold_id": "mold_a", "status": "active", "source": {"commit": "c" * 40}},
                        {"mold_id": "mold_b", "status": "coming_soon"}],
              "sweep": {"max_builders": 2, "trains": {"docs": {"types": ["docs"]}}, "gated_ids": ["mold_a-009"]}}
        json.dump(fj, open(os.path.join(R, "state", "factory.json"), "w"))
        T = lambda i, **k: dict({"task_id": f"mold_a-{i:03d}", "mold_id": "mold_a", "title": f"t{i}", "type": "build", "status": "todo", "priority": 2, "owner": "fable"}, **k)
        tasks = [T(1, status="done"), T(2, status="in_progress"),
                 T(3, depends_on=["mold_a-001"]),                        # ready, but the mold_a train is full (002 runs)
                 T(4, depends_on=["mold_a-002"]),                        # waits on the running 002: strict phase order
                 T(5, type="docs", priority=3),                          # ready on its own train (docs)
                 T(6, type="docs", priority=1),                          # same train, higher priority: starts before 005
                 T(7, gate={"kind": "dated_decision", "until": "2099-01-01", "why": "operator decides"}),
                 T(8, owner="sol"), T(9),                                # operator action; listed in gated_ids
                 T(10, train="ops", depends_on=["mold_a-011"]), T(11, status="dropped"),
                 T(12, train="ops")]
        open(os.path.join(R, "state", "tasks", "mold_a.jsonl"), "w").write("".join(json.dumps(x) + "\n" for x in tasks))
        open(os.path.join(R, "state", "tasks", "mold_b.jsonl"), "w").write(json.dumps(dict(T(1), task_id="mold_b-001", mold_id="mold_b")) + "\n")

        # --- migration clash detection (gh and git stand-ins) ---
        files = {1: ["molds/mold_a/codebase/sql/migrations/0004_a.sql", "README.md"],
                 2: ["molds/mold_a/codebase/sql/migrations/0004_b.sql"],
                 3: ["molds/mold_a/codebase/sql/migrations/0003_dupe.sql"],
                 4: ["molds/mold_a/codebase/sql/migrations/0005_ok.sql", "molds/mold_a/codebase/sql/seed/0001_x.sql"],
                 5: ["docs/x.md"]}
        prs = [{"number": n, "title": f"mold_a-00{n}: change {n}", "headRefName": f"b{n}", "mergeable": "MERGEABLE", "isDraft": False,
                "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}]} for n in files]
        prs[4]["mergeable"] = "CONFLICTING"
        def fake_run(cmd, cwd=None, timeout=120):
            if cmd[:3] == ["gh", "pr", "list"]: return 0, json.dumps(prs), ""
            if cmd[:2] == ["gh", "api"]:
                n = int(re.search(r"pulls/(\d+)/files", cmd[3]).group(1)); return 0, "\n".join(files[n]) + "\n", ""
            if cmd[:1] == ["git"]: return 128, "", "not a git repository"
            return 127, "", "no stand-in"
        RUN = fake_run; PROCS = lambda: []; DISK = lambda p: (100e9, 50e9); NOW = time.time; MYPID = lambda: 1000
        _, cfg = settings(R)
        P = plan_prs(R, cfg); by = {r["number"]: r for r in P["items"]}
        ok(P["main_highest"] == {"molds/mold_a/codebase/sql/migrations": 3}, "main's highest migration read from disk when git cannot answer")
        ok(any("also added by PR #2" in c for c in by[1]["clashes"]) and any("also added by PR #1" in c for c in by[2]["clashes"]), "two open PRs adding 0004 clash with each other")
        ok(any("already on main" in c for c in by[3]["clashes"]), "a PR adding 0003 clashes with main's 0003")
        ok(by[4]["clashes"] == [] and by[4]["merge_ready"] and [m["number"] for m in by[4]["migrations"]] == [5], "0005 is clean; a numbered file outside migrations is not a migration")
        ok(not by[5]["merge_ready"] and "mergeable is CONFLICTING" in by[5]["blockers"], "a conflicting PR is not ready")
        ok(by[1]["ticket"] == "mold_a-001" and not by[1]["merge_ready"], "the ticket is read from the title; a clashing PR is not ready")
        ok(checks_state([{"status": "IN_PROGRESS"}]) == "pending" and checks_state([{"state": "FAILURE"}]) == "failing" and checks_state([]) == "none", "check rollups read")

        # --- ready tickets: depends_on, gates, trains, max builders ---
        fj2, cfg = settings(R)
        K = plan_tickets(R, cfg, fj2)
        st = [x["task_id"] for x in K["start"]]; wt = {x["task_id"]: x["why"] for x in K["ready_waiting"]}; gt = {x["task_id"]: x["why"] for x in K["gated"]}
        ok(st == ["mold_a-006"], f"max_builders 2 with one running leaves one slot; the higher-priority docs ticket takes it ({st})")
        ok("mold_a-003" in wt and "train mold_a is full" in wt["mold_a-003"], "a ready ticket on a busy train waits")
        ok("mold_a-005" in wt and "mold_a-012" in wt, f"ready tickets beyond the limits wait ({wt})")
        ok("mold_a-004" not in st + list(wt) and K["blocked_count"] >= 2, "a ticket whose dependency is still running does not start")
        ok("dated_decision" in gt.get("mold_a-007", "") and "operator action" in gt.get("mold_a-008", "") and "gated_ids" in gt.get("mold_a-009", ""), f"gates: dated decision, operator owner, listed id ({gt})")
        ok([b["task_id"] for b in K["blocked"]] == ["mold_a-010"], "a ticket waiting on a dropped one is reported as stuck")
        ok(all(not x.startswith("mold_b") for x in st + list(wt)), "a coming_soon mold's tickets are not swept")
        json.dump(dict(fj, sweep=dict(fj["sweep"], max_builders=1)), open(os.path.join(R, "state", "factory.json"), "w"))
        fj3, cfg3 = settings(R); K3 = plan_tickets(R, cfg3, fj3)
        ok(K3["start"] == [] and all("max_builders" in x["why"] or "full" in x["why"] for x in K3["ready_waiting"]), "max_builders 1 with one running starts nothing")
        json.dump(fj, open(os.path.join(R, "state", "factory.json"), "w"))

        # --- deploys: mint's station decides; migrations and lists split them ---
        for app, extra in (("app_auto", {}), ("app_par", {}), ("app_other", {}), ("app_cur", {"mold_commit": "c" * 40})):
            os.makedirs(os.path.join(R, "state", "application", app))
            json.dump(dict({"mold_id": "mold_a", "mold_commit": "a" * 40}, **extra), open(os.path.join(R, "state", "application", app, "application.json"), "w"))
            json.dump({"target": "vercel"}, open(os.path.join(R, "state", "application", app, "infrastructure.json"), "w"))
        DEPLOY_STATION = lambda app, a, i: ("done", "deployed") if a["mold_commit"] == "c" * 40 else ("next", "the mold moved (aaaaaaa -> ccccccc); redeploy")
        _, cfg = settings(R); cfg.update(auto_deploy=["app_auto"], parity_deploy=["app_par"])
        D = plan_deploys(R, cfg)
        ok([r["app"] for r in D["needs_yes"]] == ["app_auto", "app_other", "app_par"] and [r["app"] for r in D["not_behind"]] == ["app_cur"],
           "when a migration cannot be ruled out, every behind app needs a yes, pre-approved or not")
        import types
        fake_intree = types.SimpleNamespace(info=lambda m, r: {"since": "s" * 40, "forked_from": {}})
        sys.modules["intree"] = fake_intree
        RUN = lambda cmd, cwd=None, timeout=120: (0, "molds/mold_a/codebase/web/page.ts\n", "") if cmd[:1] == ["git"] else fake_run(cmd, cwd)
        D = plan_deploys(R, cfg)
        ok([r["app"] for r in D["auto"]] == ["app_auto"] and [r["app"] for r in D["parity"]] == ["app_par"] and [r["app"] for r in D["needs_yes"]] == ["app_other"],
           "no migration in the change: auto, parity and needs-a-yes split by sweep.auto_deploy / parity_deploy")
        RUN = lambda cmd, cwd=None, timeout=120: (0, "molds/mold_a/codebase/sql/migrations/0004_x.sql\n", "") if cmd[:1] == ["git"] else fake_run(cmd, cwd)
        D = plan_deploys(R, cfg)
        ok(D["auto"] == [] and len(D["needs_yes"]) == 3 and all(r["migration"] for r in D["needs_yes"]), "a live-data migration always needs a yes, even for a pre-approved app")
        del sys.modules["intree"]; RUN = fake_run

        # --- hygiene: stale wait loops, never itself, never a plain shell ---
        tmp = os.path.join(t, "jobs", "j1", "tmp"); os.makedirs(tmp)
        for n in ("busy", "done_git", "fresh", "dirty"): os.makedirs(os.path.join(tmp, n, ".git") if n in ("done_git", "dirty") else os.path.join(tmp, n))
        old = time.time() - 48 * 3600
        for n in ("busy", "done_git", "dirty"):
            for dp, dn, fn in os.walk(os.path.join(tmp, n)): os.utime(dp, (old, old))
        _, cfg = settings(R); cfg["tmp_roots"] = [tmp]
        H_ = 3600
        PS = [{"pid": 1, "ppid": 0, "etimes": 99 * H_, "args": "/sbin/init", "cwd": "/"},
              {"pid": 900, "ppid": 1, "etimes": 20 * H_, "args": "bash -c until ! pgrep -f 'lanes.py app'; do sleep 60; done; echo ok", "cwd": "/"},   # its own agent shell: an ancestor
              {"pid": 1000, "ppid": 900, "etimes": 20 * H_, "args": "python3 .claude/scripts/sweep.py plan", "cwd": R},
              {"pid": 1101, "ppid": 1, "etimes": 10 * H_, "args": "bash -c while pgrep -f provision.py >/dev/null; do sleep 30; done", "cwd": "/"},
              {"pid": 1102, "ppid": 1, "etimes": 1 * H_, "args": "bash -c until pgrep node; do sleep 5; done", "cwd": "/"},          # young
              {"pid": 1103, "ppid": 1, "etimes": 30 * H_, "args": "bash", "cwd": "/root"},                                            # idle shell
              {"pid": 1104, "ppid": 1, "etimes": 30 * H_, "args": "bash -c pgrep -f next", "cwd": "/"},                              # no loop
              {"pid": 1105, "ppid": 1, "etimes": 30 * H_, "args": "pgrep -f until while", "cwd": "/"},                               # pgrep itself
              {"pid": 1106, "ppid": 1, "etimes": 30 * H_, "args": "vim notes-about-until-pgrep-while.txt", "cwd": "/"},
              {"pid": 1201, "ppid": 1, "etimes": 2 * H_, "args": "node node_modules/.bin/next dev -p 3100", "cwd": os.path.join(tmp, "busy")},   # orphaned server
              {"pid": 1202, "ppid": 1500, "etimes": 2 * H_, "args": "npm run dev", "cwd": os.path.join(tmp, "fresh")},                   # a live builder's
              {"pid": 1203, "ppid": 1, "etimes": 50 * H_, "args": "node server.js", "cwd": "/srv/app"}]                                   # outside tmp roots
        PROCS = lambda: [dict(p) for p in PS]; MYPID = lambda: 1000; DISK = lambda p: (100e9, 10e9)
        def git_dirty(cmd, cwd=None, timeout=120):
            if cmd[:1] == ["git"] and cmd[-1] == "--porcelain": return 0, (" M x\n" if cmd[2].endswith("dirty") else ""), ""
            if cmd[:1] == ["git"] and "--branches" in cmd: return 0, "", ""
            return fake_run(cmd, cwd)
        RUN = git_dirty
        H = plan_hygiene(R, cfg)
        ok([w["pid"] for w in H["stale_waits"]] == [1101], f"only the old wait loop is stale; never itself or its parent, a young loop, a plain shell, pgrep or an editor ({[w['pid'] for w in H['stale_waits']]})")
        ok([s["pid"] for s in H["stale_servers"]] == [1201], f"only the orphaned server under a tmp root is listed ({[s['pid'] for s in H['stale_servers']]})")
        ok(H["disk_low"], "10 GB free is below the 20 GB threshold")
        sc = {os.path.basename(s["path"]): s for s in H["scratch"]}
        ok(not sc["busy"]["finished"] and "in use" in sc["busy"]["kept_because"], "a folder a process works in is never finished")
        ok(sc["done_git"]["finished"] and not sc["fresh"]["finished"] and sc["dirty"]["kept_because"] == "uncommitted changes", "finished = idle, unused, committed and pushed")

        # --- clean: dry run changes nothing; --apply needs --yes; in-use folders are kept ---
        killed = []; KILL = lambda pid, sig: killed.append(pid)
        open(os.path.join(R, "state", "factory.json"), "w").write(json.dumps(dict(fj, sweep=dict(fj["sweep"], tmp_roots=[tmp]))))
        r = clean(R, False, False, False, None)
        ok(r["status"] == "done" and killed == [] and all(os.path.isdir(os.path.join(tmp, n)) for n in sc), "--dry-run stops nothing and removes nothing")
        r = clean(R, True, False, False, None)
        ok(r["status"] == "needs_human" and AR.exit_code(r) == 3 and r["needs"][0]["kind"] == "approval" and killed == [] and os.path.isdir(os.path.join(tmp, "done_git")),
           "--apply without --yes exits 3 needs_human and does nothing")
        PS.append({"pid": 1300, "ppid": 1, "etimes": 5, "args": "bash", "cwd": os.path.join(tmp, "done_git")})   # a process starts using it between plan and apply
        real_plan = plan_hygiene
        def plan_then_use(root, cfg, extra=None):
            h = real_plan(root, cfg, extra); h["scratch"] = [dict(s, finished=True) if s["path"].endswith("done_git") else s for s in h["scratch"]]; return h
        globals()["plan_hygiene"] = plan_then_use
        r = clean(R, True, True, False, None)
        globals()["plan_hygiene"] = real_plan
        ok(sorted(killed) == [1101, 1201], f"--apply --yes stops the stale loop and the orphaned server by PID ({killed})")
        ok(os.path.isdir(os.path.join(tmp, "done_git")) and any("now in use" in s for s in r["details"]["skipped"]), "a folder a process started using is kept")
        PS.pop(); killed.clear()
        PS[3]["args"] = "bash -c something else"   # PID 1101 became a different process
        H2 = {"stale_waits": [{"pid": 1101, "hours": 10.0, "args": "bash -c while pgrep -f provision.py >/dev/null; do sleep 30; done"}],
              "stale_servers": [], "scratch": [], "disk_low": False, "tmp_roots": [tmp], "disk": []}
        globals()["plan_hygiene"] = lambda *a: H2
        r = clean(R, True, True, False, None)
        globals()["plan_hygiene"] = real_plan
        ok(killed == [] and any("no longer the same process" in s for s in r["details"]["skipped"]), "a reused PID is never stopped")
        r = clean(R, True, True, False, None)
        ok(not os.path.isdir(os.path.join(tmp, "done_git")) and os.path.isdir(os.path.join(tmp, "busy")) and os.path.isdir(os.path.join(tmp, "dirty")),
           "a finished folder is removed when disk is low; busy and dirty ones stay")
        out_ = os.path.join(t, "outside"); os.makedirs(out_)
        globals()["plan_hygiene"] = lambda *a: dict(H2, stale_waits=[], scratch=[{"path": out_, "finished": True, "idle_hours": 99}], disk_low=True)
        r = clean(R, True, True, False, None)
        globals()["plan_hygiene"] = real_plan
        ok(os.path.isdir(out_) and any("not inside a tmp root" in s for s in r["details"]["skipped"]), "a folder outside every tmp root is never removed")
    finally:
        RUN, PROCS, DISK, KILL, NOW, MYPID, DEPLOY_STATION = saved
        if saved_local is None: os.environ.pop("FACTORY_LOCAL", None)
        else: os.environ["FACTORY_LOCAL"] = saved_local
        shutil.rmtree(t, ignore_errors=True)
    print(f"\n{'all passed' if not fails else str(len(fails)) + ' failed'}")
    return 1 if fails else 0


if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
