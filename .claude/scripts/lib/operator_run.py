#!/usr/bin/env python3
"""The mold's own operator scripts, run against a deployed application (mold_v1-230).

  provision.py <app_id> --operator <script> [--dry-run] [--yes] [--json] -- <the script's own arguments>
  operator_run.py --self-test        offline: argument parsing, the allow-list, masking, both targets (fake ssh, fake runner)

<script> is one of the build's own `operator:*` package scripts, with or without the `operator:` prefix
(`new-org`, `operator:onboard-self`, `new-customer`, ...). Nothing else runs: the list is read from the package.json
of the app's build copy (build/<app_id>/, or the mold when the app has no brand, packs or library), and an app on
its own server checks the same name again against the package.json of the release that serves there.

WHERE IT RUNS
  vm_remote  ON THE SERVER, as root, which starts the script AS THE WEB APP'S USER inside the serving release
             (<install>/current), with the web service's own env file (web.env) as its environment: the app role's
             DATABASE_URL, row-level security in force, never the admin URL. The way --library-cleanup does it. The
             script's arguments travel on stdin, never on a command line, and every value of the env file is removed
             from what it prints before that leaves the server.
  vercel     HERE, from the app's build copy, with the app role's DATABASE_URL read from the web project's production
             environment for the length of the run, handed to the child in its environment and never printed.
             Only DATABASE_URL: a script's data-room writes (onboard-self's People/<you>/, new-customer's context.md)
             find no file store here and are skipped or fail; the database rows are written.
  Both add NODE_ENV=production and WORKSPACE_OPS_URL=<the app's address> (not secrets). `npm run operator:*` reads
  .env.local, which neither place has, so the script's own `node ...` line is run without its --env-file flag.

A YES FIRST. --dry-run prints the exact command (secrets masked: the database address, the env file's values, and any
argument after a flag named like a password, secret, token or key) and runs nothing. Without --dry-run the script
writes to a live application, so it runs only with --yes, which an agent passes only after the person said yes;
without it: exit 3, `needs` asks for that yes, nothing contacted.

Exit codes (lib/agent_result.py): 0 the script finished with 0 (or a dry run), 1 it failed or could not reach the app,
2 bad input (not an operator script of this build, a malformed command line), 3 a yes is needed.
Standard library only.
"""
import json, os, re, shlex, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
if HERE not in sys.path: sys.path.insert(0, HERE)
import agent_result as AR  # noqa: E402

PREFIX = "operator:"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SCRIPT_FILE = re.compile(r"^scripts/operator/[A-Za-z0-9._-]+\.(?:mjs|js|mts|ts)$")
SHELL_BITS = re.compile(r"[;&|<>`$\\]")
SECRET_FLAG = re.compile(r"(?i)(pass(word|wd)?|secret|token|api[-_]?key|credential|private[-_]?key|^--key$)")
MARK = "OPERATOR "
CRONS_FOR_TEST = False   # the self-test has no mold on disk: the module's own cron list stands in
TIMEOUT = int(os.environ.get("OPERATOR_TIMEOUT_S") or 1800)
OWN_FLAGS = ("--operator", "--dry-run", "--yes")


class Usage(Exception):
    """Bad input: exit 2, nothing contacted."""


# ---- the command line --------------------------------------------------------------------------------------------
def split(a):
    """(head, tail): what is provision.py's, and the script's own arguments after the first `--`."""
    if "--" in a:
        i = a.index("--"); return list(a[:i]), list(a[i + 1:])
    return list(a), []


def parse(a):
    """provision.py's argv (app id first, --json already taken out of the head) -> {"key", "args", "dry", "yes"}."""
    head, args = split(a)
    i = head.index("--operator")
    name = head[i + 1] if i + 1 < len(head) else ""
    if not name or name.startswith("-"):
        raise Usage("--operator needs the name of one of the app's operator scripts after it, for example: --operator new-org -- --name \"Acme\" --id acme --owner you@example.com")
    bare = name[len(PREFIX):] if name.startswith(PREFIX) else name
    if not NAME.match(bare): raise Usage(f"{name!r} is not the name of an operator script (lower-case letters, digits and hyphens).")
    rest = [x for j, x in enumerate(head[1:], 1) if j not in (i, i + 1)]
    stray = [x for x in rest if x not in OWN_FLAGS]
    if stray:
        raise Usage(f"{' '.join(stray)}: provision.py does not take this with --operator. The script's own arguments go after `--`, "
                    f"for example: --operator {bare} -- {' '.join(stray)}")
    return {"key": PREFIX + bare, "args": args, "dry": "--dry-run" in rest, "yes": "--yes" in rest}


# ---- the allow-list ----------------------------------------------------------------------------------------------
def allowed(package_json):
    """{"operator:<name>": its command line} from a package.json; {} when there is none to read."""
    try: scripts = json.load(open(package_json)).get("scripts") or {}
    except (OSError, ValueError): return {}
    return {k: v for k, v in scripts.items() if isinstance(k, str) and k.startswith(PREFIX) and isinstance(v, str)}


def node_argv(cmdline):
    """(argv, None) for a package script that is exactly `node [node flags] scripts/operator/<file>`, without its
    --env-file flag (neither target has .env.local); (None, why) for anything else, which is never run."""
    if SHELL_BITS.search(cmdline or ""): return None, "it is not a plain `node <script>` line (it chains or redirects commands)"
    try: toks = shlex.split(cmdline or "")
    except ValueError: return None, "its command line could not be read"
    if not toks or toks[0] != "node": return None, "it does not start the script with node"
    if not SCRIPT_FILE.match(toks[-1]): return None, "it does not end in one script under scripts/operator/"
    flags = toks[1:-1]
    if any(not f.startswith("-") for f in flags): return None, "it passes more than one file to node"
    return ["node", *[f for f in flags if not f.startswith(("--env-file=", "--env-file-if-exists="))], toks[-1]], None


# ---- masking ---------------------------------------------------------------------------------------------------------
def mask_args(args):
    """The script's arguments as they may be shown: a value after a flag named like a secret is ***, and so is a
    `--flag=value` of that kind; a credential inside a URL or a bearer token is scrubbed (lib/agent_result.py)."""
    out, hide_next = [], False
    for t in args:
        if hide_next: out.append("***"); hide_next = False; continue
        if t.startswith("-") and "=" in t and SECRET_FLAG.search(t.split("=", 1)[0]): out.append(t.split("=", 1)[0] + "=***"); continue
        if t.startswith("-") and SECRET_FLAG.search(t): out.append(t); hide_next = True; continue
        out.append(AR.scrub(t))
    return out


def hider(values):
    """text -> text with every value (longest first, 8+ characters) and every URL credential removed."""
    vals = sorted({v for v in values if isinstance(v, str) and len(v) >= 8}, key=len, reverse=True)
    def hide(text):
        text = text or ""
        for v in vals: text = text.replace(v, "[hidden]")
        return AR.scrub(text)
    return hide


# ---- on the server (vm_remote): run by `vm_remote.py operator-run`, as root ------------------------------------------
def server_run(env_file, user, home, app_dir, url, req, run=None, say=print):
    """ON THE SERVER, as root: the operator script `req["script"]` with `req["args"]`, inside the serving release, as
    the web app's user with the web service's env file as its environment. Prints the script's output with every value
    of that file removed, then one `OPERATOR {"exit_code": n}` (or {"error": why}) line. Returns the exit code."""
    import pwd
    sys.path.insert(0, HERE); import vm_remote as V
    def out(doc, rc): say(MARK + json.dumps(doc)); return rc
    key = str((req or {}).get("script") or ""); args = (req or {}).get("args") or []
    if not key.startswith(PREFIX) or not NAME.match(key[len(PREFIX):]) or not all(isinstance(x, str) for x in args):
        return out({"error": "what arrived on stdin is not one operator script and its arguments; nothing was run"}, 2)
    try: pw = pwd.getpwnam(user)
    except KeyError: return out({"error": f"this server has no user {user} yet: it was deployed before each service got a user of its own. Deploy once, then run this again. Nothing was run."}, 1)
    vals = V.env_read(env_file)
    if not vals.get("DATABASE_URL"): return out({"error": "the web app's env file has no DATABASE_URL yet (the deploy writes it), so there is no database to write to. Nothing was run."}, 1)
    app_dir = V._served(app_dir)
    cmdline = allowed(os.path.join(app_dir, "package.json")).get(key)
    if not cmdline: return out({"error": f"the release serving on this server has no package script {key} (it was built before the script existed, or it is not an operator script). Nothing was run."}, 2)
    argv, why = node_argv(cmdline)
    if why: return out({"error": f"{key} is not run: {why}. Nothing was run."}, 2)
    hide = hider(vals.values())
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": home, "LANG": "C.UTF-8", **vals,
           "NODE_ENV": "production", **({"WORKSPACE_OPS_URL": url} if url else {})}
    def as_user(argv_):
        kw = dict(user=pw.pw_uid, group=pw.pw_gid, extra_groups=os.getgrouplist(user, pw.pw_gid)) if os.getuid() == 0 else {}
        return subprocess.run(argv_, cwd=app_dir, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=TIMEOUT, **kw)
    try: r = (run or as_user)(argv + list(args))
    except subprocess.TimeoutExpired: return out({"error": f"{key} did not finish within {TIMEOUT}s and was stopped; what it wrote before that is kept"}, 1)
    except (OSError, subprocess.SubprocessError) as e: return out({"error": f"{key} could not be started ({type(e).__name__})"}, 1)
    for text in (r.stdout, r.stderr):
        for l in hide(text).splitlines():
            if not l.startswith(MARK): say(l)
    return out({"exit_code": r.returncode}, 0 if r.returncode == 0 else 1)


def server_cli(a, stdin=None):
    """`vm_remote.py operator-run --file F --user U --home H --app-dir D [--url U]`, the request as JSON on stdin."""
    opt = lambda k: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else None
    try: req = json.loads((stdin or sys.stdin).read())
    except ValueError: req = None
    return server_run(opt("--file"), opt("--user"), opt("--home"), opt("--app-dir"), opt("--url"), req)


def remote_argv(V, S, shown=False):
    """The one remote command: nothing of the script's, and nothing secret, is on it (the request is on stdin)."""
    cmd = V.guarded(S, f"python3 {S['tool']} operator-run --file {S['env_files']['web']} --user {V.SERVICE_USERS['web']} "
                       f"--home {V.SERVICE_HOMES['web']} --app-dir {S['app_dir']} --url {shlex.quote(S['url'])}")
    return V.ssh_argv(S, cmd, shown)


# ---- the factory side ------------------------------------------------------------------------------------------------
def _build_dir(app_id, app, target):
    if target == "vm_remote":
        sys.path.insert(0, HERE); import vm_remote as V
        return V.source_for(app_id, app)
    if SCRIPTS not in sys.path: sys.path.insert(0, SCRIPTS)
    import library
    return library.build_dir_for(app_id, app)


def main_for(app_id, a, app, infra, ds=None, P=None, runner=None, pull_env=None, say=print):
    """`provision.py <app_id> --operator ...`. Returns the exit code (0, 1, 2 or 3); never prints a secret."""
    try: o = parse(a)
    except Usage as e: say(f"{app_id}: {e} Nothing was run."); return 2
    target = infra.get("target"); key, args = o["key"], o["args"]; shown_args = mask_args(args)
    url = ((infra.get(target) or {}) if target in ("vercel", "vm_remote") else {}).get("production_url")
    if target not in ("vercel", "vm_remote"):
        say(f"{app_id}: --operator runs against an app that serves traffic (Vercel, or its own server); this one's target is {target!r}. Nothing was run."); return 2
    if not url or (target == "vm_remote" and not infra.get("deployed_at")):
        say(f"{app_id}: the app is not deployed yet, so it has no database to run {key} against. Nothing was contacted."); return 1
    build = _build_dir(app_id, app, target)
    allow = allowed(os.path.join(build, "package.json"))
    if not allow:
        say(f"{app_id}: there is no package.json with operator scripts under {os.path.relpath(build, ROOT)}/ (the app's build copy). "
            f"A deploy makes it. Nothing was contacted."); return 1
    if key not in allow:
        say(f"{app_id}: {key} is not one of this app's operator scripts. They are: {', '.join(sorted(k[len(PREFIX):] for k in allow))}. Nothing was run."); return 2
    argv, why = node_argv(allow[key])
    if why: say(f"{app_id}: {key} is not run: {why}. Nothing was run."); return 2
    detail = {"script": key, "target": target, "args": shown_args, "dry_run": o["dry"]}
    rerun = f"python3 .claude/scripts/provision.py {app_id} --operator {key[len(PREFIX):]} --yes -- {shlex.join(shown_args)}".rstrip(" -")
    if target == "vercel":
        if P is not None: P._refuse_live_or_shared_project(app_id, infra)
        proj = (infra.get("vercel") or {}).get("project")
        shown = (f"DATABASE_URL=<hidden: the app role's address, read from the production environment of Vercel project {proj} for this run only> "
                 f"NODE_ENV=production WORKSPACE_OPS_URL={shlex.quote(url)} " + shlex.join(argv + shown_args))
        say(f"{app_id}: {key} on Vercel, run here from {os.path.relpath(build, ROOT)}/ (the app's build copy):")
        say(f"    $ cd {shlex.quote(os.path.relpath(build, ROOT))}")
        say(f"    $ {shown}")
        detail["command"] = shown
    else:
        sys.path.insert(0, HERE); import vm_remote as V
        S = V.settings(app_id, app, infra, ds or {})
        req_shown = json.dumps({"script": key, "args": shown_args})
        say(f"{app_id}: {key} on its own server ({S['host_shown']}), as the web app's user {V.SERVICE_USERS['web']} in {S['app_dir']}:")
        say(f"    1. send this version of the factory's server scripts (nothing in it runs by itself):")
        say(f"    $ " + V.shown_cmd(S, V.rsync_argv(S, "<a fresh bundle>", S["factory_dir"], shown=True)))
        say(f"    2. run the script there; its arguments go on stdin, never on a command line:")
        say(f"    $ " + V.shown_cmd(S, remote_argv(V, S, shown=True)) + f" <<< {shlex.quote(req_shown)}")
        say(f"    which runs, as {V.SERVICE_USERS['web']} with the values of {S['env_files']['web']} (hidden), NODE_ENV=production and WORKSPACE_OPS_URL={S['url']}:")
        say(f"    $ " + shlex.join(argv + shown_args))
        detail["command"] = shlex.join(argv + shown_args); detail["remote"] = V.shown_cmd(S, remote_argv(V, S, shown=True))
    AR.detail("operator", detail)
    if o["dry"]:
        say("DRY RUN: nothing was run and nothing was contacted.")
        AR.note(summary=f"{app_id}: dry run of {key} on {target}; nothing was run", next=f"Only once the person said yes to running it: {rerun}"); return 0
    if not o["yes"]:
        how = (f"Running {key} writes to the live app {app_id} (its database{', on its own server' if target == 'vm_remote' else ''}). "
               f"Say yes in the chat if it should run with the arguments shown; the agent then runs: {rerun}")
        AR.need("approval", f"yes to run {key} on {app_id}", how)
        AR.note(summary=f"{app_id}: {key} needs a yes before it writes to the live app; nothing was run", next=how)
        say(f"{app_id}: {key} writes to a live app, so it needs a yes first. Nothing was run. With the yes: {rerun}"); return 3
    rc = (_run_vercel if target == "vercel" else _run_remote)(app_id, app, infra, ds or {}, build, argv, args, url, key, runner, pull_env, say)
    detail["exit_code"] = rc if isinstance(rc, int) else None
    ok = rc == 0
    AR.note(summary=f"{app_id}: {key} on {target} " + ("finished" if ok else "failed") + (f" (exit {rc})" if not ok and isinstance(rc, int) else ""))
    return 0 if ok else 1


def _run_vercel(app_id, app, infra, ds, build, argv, args, url, key, runner, pull_env, say):
    if pull_env is None:
        if SCRIPTS not in sys.path: sys.path.insert(0, SCRIPTS)
        import clone
        pull_env = clone.pull_env
    db = (pull_env(infra["vercel"]["project"], build) or {}).get("DATABASE_URL")
    if not db or db == "[SENSITIVE]":
        say(f"{app_id}: the database address could not be read from the project's production environment. Nothing was run."); return 1
    AR.forbid(db); hide = hider([db])
    env = dict(os.environ, DATABASE_URL=db, NODE_ENV="production", WORKSPACE_OPS_URL=url)
    try:
        r = (runner or subprocess.run)(argv + list(args), cwd=build, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        say(f"{app_id}: {key} did not finish within {TIMEOUT}s and was stopped; what it wrote before that is kept."); return 1
    except (OSError, subprocess.SubprocessError) as e:
        say(f"{app_id}: {key} could not be started ({type(e).__name__}). Nothing was run."); return 1
    for text in (r.stdout, r.stderr):
        for l in hide(text).splitlines(): say(l)
    say(f"{app_id}: {key} exited {r.returncode}. The database address was never printed.")
    return r.returncode


def _run_remote(app_id, app, infra, ds, build, argv, args, url, key, runner, pull_env, say):
    sys.path.insert(0, HERE); import vm_remote as V
    S = V.settings(app_id, app, infra, ds)
    runner = runner or V.real_runner
    if not S["host"]: say(f"{app_id}: the server address is not in state yet. Nothing was contacted."); return 1
    if not os.path.isfile(V.key_path(S)): say(f"{app_id}: there is no SSH key named {S['key_ref']} on this VM ({V.key_shown(S)}). Nothing was contacted."); return 1
    try:
        # The server runs the factory's own copy of this step: send this version first, built exactly as the deploy and
        # --library-cleanup build it (the same settings and the mold's crons), since it replaces the server's factory folder.
        crons = list(V.CRONS) if CRONS_FOR_TEST else V.read_crons(os.path.join(ROOT, "molds", app["mold_id"], "codebase"))
        bdir = tempfile.mkdtemp(prefix="sf-operator-")
        try:
            V.write_bundle(S, crons, bdir)
            r = runner({"id": "bundle", "argv": V.rsync_argv(S, bdir, S["factory_dir"]), "timeout": 300})
        finally: shutil.rmtree(bdir, ignore_errors=True)
        if r.returncode:
            say(f"{app_id}: could not reach the server to send the factory's scripts: " + V.redact(((r.stderr or "").strip().splitlines() or ["no answer"])[-1])[:300] + ". Nothing was run.")
            return 1
        r = runner({"id": "operator", "argv": remote_argv(V, S), "timeout": TIMEOUT + 60}, json.dumps({"script": key, "args": list(args)}))
    except V.Stop as e:
        say(f"{app_id}: {e}"); return 1
    doc = None
    for l in V.redact(r.stdout or "").splitlines():
        if l.startswith(MARK + "{"):
            try: doc = json.loads(l[len(MARK):])
            except ValueError: pass
        else: say(l)
    if doc is None:
        tail = V.redact(((r.stderr or r.stdout or "").strip().splitlines() or ["no reason was printed"])[-1])[:300]
        say(f"{app_id}: {key} did not report back from the server: {tail}. Whether it wrote anything is not known; look before running it again.")
        return 1
    if doc.get("error"): say(f"{app_id}: {str(doc['error'])[:600]}"); return 1
    say(f"{app_id}: {key} exited {doc.get('exit_code')} on the server. The env file's values never left it.")
    return doc.get("exit_code") if isinstance(doc.get("exit_code"), int) else 1


# ---- self-test ---------------------------------------------------------------------------------------------------------
FAKE_SSH = r'''#!/bin/sh
# a stand-in ssh: drops the options, runs the remote command HERE with the server's paths mapped to a temp tree
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift
echo "$*" >> "$FAKE_SSH_LOG"
cmd=$(printf '%s' "$*" | sed -e "s#$FAKE_FROM_FACTORY#$FAKE_TO_FACTORY#g" -e "s#$FAKE_FROM_ETC#$FAKE_TO_ETC#g" -e "s#$FAKE_FROM_INSTALL#$FAKE_TO_INSTALL#g" -e "s#--user [a-z]*#--user $FAKE_USER#")
exec sh -c "$cmd"
'''
FAKE_SCRIPT = r'''// a stand-in operator script: says what it was given, then exits with the code it was asked for
const a = process.argv.slice(2);
console.log("args " + JSON.stringify(a));
console.log("db " + (process.env.DATABASE_URL || "none"));
console.log("ops " + (process.env.WORKSPACE_OPS_URL || "none") + " env " + process.env.NODE_ENV);
const i = a.indexOf("--exit"); process.exit(i >= 0 ? Number(a[i + 1]) : 0);
'''


def self_test(check=None):
    import io, pwd
    sys.path.insert(0, HERE); import vm_remote as V
    fails, n = [], [0]
    def ok(name, cond, detail=""):
        if check: return check(name, cond, detail)
        n[0] += 1
        if not cond: fails.append(f"{name}{': ' + str(detail)[:400] if detail else ''}")
    # 1. parsing: the script's own arguments are after `--` and are never read as provision.py's
    p = parse(["app1", "--operator", "new-org", "--", "--name", "Acme Co", "--json", "--dry-run", "--yes"])
    ok("operator: parse: name without the prefix, args after -- kept whole (even --json, --dry-run, --yes)",
       p == {"key": "operator:new-org", "args": ["--name", "Acme Co", "--json", "--dry-run", "--yes"], "dry": False, "yes": False}, p)
    p = parse(["app1", "--dry-run", "--operator", "operator:onboard-self", "--yes"])
    ok("operator: parse: the operator: prefix, --dry-run and --yes before --", p["key"] == "operator:onboard-self" and p["dry"] and p["yes"] and p["args"] == [], p)
    for bad, why in ((["app1", "--operator"], "needs the name"), (["app1", "--operator", "--dry-run"], "needs the name"),
                     (["app1", "--operator", "New_Org"], "is not the name"), (["app1", "--operator", "x;rm"], "is not the name"),
                     (["app1", "--operator", "new-org", "--name", "x"], "after `--`")):
        try: parse(bad); ok(f"operator: parse refuses {bad[1:]}", False, "accepted")
        except Usage as e: ok(f"operator: parse refuses {bad[1:]} ({why})", why in str(e), str(e))
    # 2. the allow-list and the node line
    t = tempfile.mkdtemp(prefix="operator-selftest-")
    try:
        pkg = os.path.join(t, "package.json")
        json.dump({"scripts": {"build": "next build", "operator:new-org": "node --experimental-strip-types --env-file=.env.local scripts/operator/new-org.mjs",
                               "operator:heavy": "node --max-old-space-size=8192 --env-file-if-exists=.env.local scripts/operator/heavy.mjs",
                               "operator:evil": "node scripts/operator/x.mjs && curl http://x", "operator:npx": "npx something",
                               "operator:two": "node scripts/operator/a.mjs scripts/operator/b.mjs", "operator:out": "node ../escape.mjs"}}, open(pkg, "w"))
        al = allowed(pkg)
        ok("operator: allow-list is the operator:* scripts only", "build" not in al and "operator:new-org" in al and len(al) == 6, sorted(al))
        ok("operator: allow-list of a missing package.json is empty", allowed(os.path.join(t, "nope.json")) == {})
        ok("operator: the node line loses --env-file, keeps node's other flags",
           node_argv(al["operator:new-org"])[0] == ["node", "--experimental-strip-types", "scripts/operator/new-org.mjs"]
           and node_argv(al["operator:heavy"])[0] == ["node", "--max-old-space-size=8192", "scripts/operator/heavy.mjs"])
        for k in ("operator:evil", "operator:npx", "operator:two", "operator:out"):
            ok(f"operator: {k} ({al[k]}) is never run", node_argv(al[k])[0] is None, node_argv(al[k]))
        # 3. masking
        m = mask_args(["--email", "me@example.com", "--password", "hunter2hunter2", "--api-key=sk_live_abcdefgh", "--token", "t0k",
                       "--url", "postgres://app_rw:pw123456@db/x", "--name", "Acme"])
        ok("operator: masking hides values after secret-named flags and URL credentials, keeps the rest",
           m == ["--email", "me@example.com", "--password", "***", "--api-key=***", "--token", "***", "--url", "postgres://***:***@db/x", "--name", "Acme"], m)
        ok("operator: the hider removes every listed value and URL credentials", hider(["s3cr3tvalue"])("a s3cr3tvalue b postgres://u:p@h/d") == "a [hidden] b postgres://***:***@h/d")
        # 4. Vercel: a fake pull_env and a fake runner
        build = os.path.join(t, "build", "app1"); os.makedirs(os.path.join(build, "scripts", "operator"))
        shutil.copy(pkg, os.path.join(build, "package.json"))
        app = {"app_id": "app1", "mold_id": "m1", "packs": ["p"]}
        infra = {"target": "vercel", "vercel": {"project": "app-one", "production_url": "https://app-one.example.com"}}
        DB = "postgresql://app_rw:Sup3rS3cretPw@db.example.com/app?sslmode=require"
        pulls, runs_ = [], []
        def pull(proj, cwd): pulls.append((proj, cwd)); return {"DATABASE_URL": DB}
        def fake_run(argv, **kw):
            runs_.append((argv, kw))
            return subprocess.CompletedProcess(argv, int(argv[argv.index("--exit") + 1]) if "--exit" in argv else 0, f"wrote org; db {DB}\n", "")
        global _build_dir, CRONS_FOR_TEST
        real_build_dir = _build_dir; CRONS_FOR_TEST = True
        _build_dir = lambda app_id, app_, target: build
        def go(argv, inf=infra, **kw):
            AR.reset(); buf = io.StringIO()
            rc = main_for("app1", ["app1"] + argv, app, inf, runner=fake_run, pull_env=pull, say=lambda s: buf.write(s + "\n"), **kw)
            return rc, buf.getvalue()
        try:
            pulls.clear(); runs_.clear()
            rc, out = go(["--operator", "new-org", "--dry-run", "--", "--name", "Acme", "--password", "hunter2hunter2"])
            ok("operator vercel: --dry-run prints the exact command, masked, and runs nothing (no env pulled, nothing started)",
               rc == 0 and not pulls and not runs_ and "node --experimental-strip-types scripts/operator/new-org.mjs --name Acme --password '***'" in out
               and "DATABASE_URL=<hidden" in out and "hunter2" not in out and "DRY RUN" in out, out)
            rc, out = go(["--operator", "new-org", "--", "--name", "Acme"])
            ok("operator vercel: without --yes: exit 3, needs an approval, nothing pulled or run",
               rc == 3 and not pulls and not runs_ and AR.NOTES["needs"] and AR.NOTES["needs"][0]["kind"] == "approval" and "--yes" in AR.NOTES["needs"][0]["how"], (out, AR.NOTES["needs"]))
            rc, out = go(["--operator", "new-org", "--yes", "--", "--name", "Acme", "--exit", "0"])
            ok("operator vercel: --yes runs the node line from the build copy with the pulled DATABASE_URL in its environment only",
               rc == 0 and pulls == [("app-one", build)] and runs_ and runs_[-1][0] == ["node", "--experimental-strip-types", "scripts/operator/new-org.mjs", "--name", "Acme", "--exit", "0"]
               and runs_[-1][1]["cwd"] == build and runs_[-1][1]["env"]["DATABASE_URL"] == DB and runs_[-1][1]["env"]["NODE_ENV"] == "production"
               and runs_[-1][1]["env"]["WORKSPACE_OPS_URL"] == "https://app-one.example.com" and DB not in " ".join(runs_[-1][0]), (rc, out))
            ok("operator vercel: the database address is never printed, even when the script echoes it", "Sup3rS3cretPw" not in out and "[hidden]" in out, out)
            rc, out = go(["--operator", "new-org", "--yes", "--", "--exit", "4"])
            ok("operator vercel: a script that fails is exit 1", rc == 1 and AR.NOTES["details"]["operator"]["exit_code"] == 4, (rc, out))
            n0 = len(runs_)
            rc, out = go(["--operator", "build", "--yes"])
            ok("operator vercel: a package script that is not operator:* is refused, exit 2, nothing run", rc == 2 and len(runs_) == n0 and "new-org" in out, out)
            rc, out = go(["--operator", "evil", "--yes"])
            ok("operator vercel: an operator script that is not a plain node line is refused, exit 2", rc == 2 and len(runs_) == n0, out)
            rc, out = go(["--operator", "new-org", "--yes"], inf={"target": "vercel", "vercel": {"project": "app-one"}})
            ok("operator vercel: an app not deployed is refused before anything is contacted", rc == 1 and "$ " not in out and len(runs_) == n0 and "not deployed" in out, out)
            rc, out = go(["--operator", "new-org", "--yes"], inf={"target": "vm"})
            ok("operator: a target that serves nothing is refused, exit 2", rc == 2, out)
            # 5. vm_remote: a fake runner first (what is sent, and how), then a fake ssh that runs the server side for real
            vinfra = {"target": "vm_remote", "deployed_at": "2026-10-12T00:00:00+00:00",
                      "vm_remote": {"host": "203.0.113.7", "domain": "app.example.com", "production_url": "https://app.example.com", "ssh_key_ref": "sf_selftest_key"}}
            S = V.settings("app1", app, vinfra, {})
            steps = []
            def fake_remote(step, stdin_text=None):
                steps.append((step, stdin_text))
                if step["id"] == "bundle": return subprocess.CompletedProcess(step["argv"], 0, "", "")
                return subprocess.CompletedProcess(step["argv"], 0, "org written\n" + MARK + json.dumps({"exit_code": 0}) + "\n", "")
            def vgo(argv, runner=fake_remote, key_present=True):
                AR.reset(); buf = io.StringIO()
                real_kp = V.key_path
                V.key_path = (lambda S_: __file__) if key_present else (lambda S_: os.path.join(t, "no-key"))
                try: rc = main_for("app1", ["app1"] + argv, app, vinfra, runner=runner, say=lambda s: buf.write(s + "\n"))
                finally: V.key_path = real_kp
                return rc, buf.getvalue()
            rc, out = vgo(["--operator", "onboard-self", "--dry-run", "--", "--org", "acme", "--email", "me@example.com", "--token", "abc12345"])
            ok("operator vm_remote: onboard-self is not in this build's list: exit 2", rc == 2 and not steps, out)
            rc, out = vgo(["--operator", "new-org", "--dry-run", "--", "--name", "Acme Co", "--token", "abc12345"])
            ok("operator vm_remote: --dry-run prints the bundle, the ssh command and the node line, masked; connects to nothing",
               rc == 0 and not steps and "rsync" in out and "ssh" in out and "operator-run" in out and "~/.ssh/sf_selftest_key" in out
               and "node --experimental-strip-types scripts/operator/new-org.mjs --name 'Acme Co' --token '***'" in out and "abc12345" not in out
               and f"--user {V.SERVICE_USERS['web']}" in out and S["app_dir"] in out and S["env_files"]["web"] in out, out)
            rc, out = vgo(["--operator", "new-org", "--", "--name", "Acme"])
            ok("operator vm_remote: without --yes: exit 3, an approval needed, nothing contacted", rc == 3 and not steps and AR.NOTES["needs"][0]["kind"] == "approval", out)
            rc, out = vgo(["--operator", "new-org", "--yes", "--", "--name", "Acme Co", "--token", "abc12345"])
            st = steps[-1] if steps else ({}, None)
            ok("operator vm_remote: --yes sends the bundle, then one ssh command with the arguments on stdin, never on its command line",
               rc == 0 and [s[0]["id"] for s in steps] == ["bundle", "operator"] and json.loads(st[1]) == {"script": "operator:new-org", "args": ["--name", "Acme Co", "--token", "abc12345"]}
               and "Acme" not in " ".join(st[0]["argv"]) and "abc12345" not in " ".join(st[0]["argv"]) and "operator-run" in st[0]["argv"][-1]
               and f"--user {V.SERVICE_USERS['web']}" in st[0]["argv"][-1] and "--app-dir " + S["app_dir"] in st[0]["argv"][-1] and "abc12345" not in out, (out, st))
            steps.clear()
            rc, out = vgo(["--operator", "new-org", "--yes"], key_present=False)
            ok("operator vm_remote: no SSH key on this VM: exit 1, nothing contacted", rc == 1 and not steps, out)
            rc, out = vgo(["--operator", "new-org", "--yes"], runner=lambda step, stdin_text=None: subprocess.CompletedProcess(step["argv"], 0 if step["id"] == "bundle" else 255, "", "Connection reset"))
            ok("operator vm_remote: no report from the server: exit 1, says it is not known what was written", rc == 1 and "not known" in out, out)
            # the server side for real, through a fake ssh that maps the server's paths into this temp tree
            if shutil.which("node"):
                bin_ = os.path.join(t, "bin"); os.makedirs(bin_)
                open(os.path.join(bin_, "ssh"), "w").write(FAKE_SSH); os.chmod(os.path.join(bin_, "ssh"), 0o755)
                open(os.path.join(bin_, "rsync"), "w").write("#!/bin/sh\nexit 0\n"); os.chmod(os.path.join(bin_, "rsync"), 0o755)
                srv = os.path.join(t, "srv"); rel = os.path.join(srv, "install", "releases", "r1"); os.makedirs(os.path.join(rel, "scripts", "operator"))
                os.symlink(rel, os.path.join(srv, "install", "current"))
                json.dump({"scripts": {"operator:new-org": "node --env-file=.env.local scripts/operator/new-org.mjs"}}, open(os.path.join(rel, "package.json"), "w"))
                open(os.path.join(rel, "scripts", "operator", "new-org.mjs"), "w").write(FAKE_SCRIPT)
                etc = os.path.join(srv, "etc"); os.makedirs(etc)
                SDB = "postgresql://app_rw:ServerOnlyPw99@127.0.0.1:5432/app1"
                envf = os.path.join(etc, os.path.basename(S["env_files"]["web"]))
                open(envf, "w").write(f"DATABASE_URL={SDB}\nOTHER_SECRET=zzzzzzzzzzzz\n"); os.chmod(envf, 0o600)
                for p_ in (srv, os.path.join(srv, "install"), rel, os.path.join(rel, "scripts"), os.path.join(rel, "scripts", "operator")): os.chmod(p_, 0o755)
                for f_ in (os.path.join(rel, "package.json"), os.path.join(rel, "scripts", "operator", "new-org.mjs")): os.chmod(f_, 0o644)
                me = pwd.getpwuid(os.getuid()).pw_name
                sshlog = os.path.join(t, "ssh.log")
                old = dict(os.environ)
                os.environ.update(PATH=bin_ + os.pathsep + os.environ.get("PATH", ""), FAKE_SSH_LOG=sshlog, FAKE_USER=me,
                                  FAKE_FROM_FACTORY=S["factory_dir"] + "/.claude/scripts", FAKE_TO_FACTORY=SCRIPTS,
                                  FAKE_FROM_ETC=os.path.dirname(S["env_files"]["web"]), FAKE_TO_ETC=etc,
                                  FAKE_FROM_INSTALL=S["install"], FAKE_TO_INSTALL=os.path.join(srv, "install"))
                try:
                    rc, out = vgo(["--operator", "new-org", "--yes", "--", "--name", "Acme Co", "--exit", "0"], runner=V.real_runner)
                finally:
                    os.environ.clear(); os.environ.update(old)
                ok("operator vm_remote (fake ssh, server side for real): the script runs in the serving release with web.env and the app's address, args intact",
                   rc == 0 and 'args ["--name","Acme Co","--exit","0"]' in out and "ops https://app.example.com env production" in out, out)
                ok("  ...the env file's values never come back (the address is [hidden])", "ServerOnlyPw99" not in out and "db [hidden]" in out, out)
                ok("  ...and the ssh command line carries no argument of the script", "Acme" not in open(sshlog).read(), open(sshlog).read())
                os.environ.update(PATH=bin_ + os.pathsep + os.environ.get("PATH", ""), FAKE_SSH_LOG=sshlog, FAKE_USER=me,
                                  FAKE_FROM_FACTORY=S["factory_dir"] + "/.claude/scripts", FAKE_TO_FACTORY=SCRIPTS,
                                  FAKE_FROM_ETC=os.path.dirname(S["env_files"]["web"]), FAKE_TO_ETC=etc,
                                  FAKE_FROM_INSTALL=S["install"], FAKE_TO_INSTALL=os.path.join(srv, "install"))
                try:
                    rc, out = vgo(["--operator", "new-org", "--yes", "--", "--exit", "5"], runner=V.real_runner)
                    rc2, out2 = (lambda b: (server_run(envf, me, t, os.path.join(srv, "install", "current"), "", {"script": "operator:onboard-self", "args": []}, say=lambda s: b.append(s)), b))([])
                finally:
                    os.environ.clear(); os.environ.update(old)
                ok("operator vm_remote (fake ssh): a failing script on the server is exit 1", rc == 1 and "exited 5" in out, out)
                ok("operator server side: a script the serving release does not have is refused there, exit 2", rc2 == 2 and "no package script operator:onboard-self" in " ".join(out2), out2)
            else:
                ok("operator vm_remote (fake ssh): node is on this machine for the server-side run", False, "no node")
        finally:
            _build_dir = real_build_dir; CRONS_FOR_TEST = False
    finally:
        shutil.rmtree(t, ignore_errors=True)
    if check: return 0
    if fails:
        print("operator_run self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"operator_run self-test: {n[0]} checks passed"); return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    print(__doc__); sys.exit(2)
