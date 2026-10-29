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
  vercel     HERE, from the app's build copy, with the web project's production environment read for the length of the
             run and handed to the child through an allow-list (PULLED_ENV, mold_v1-237): the app role's DATABASE_URL and
             the file store's settings the mold's lib/storage reads (docs/STORAGE.md): BLOB_READ_WRITE_TOKEN on Vercel
             Blob (STORAGE_DRIVER unset, the default), STORAGE_DRIVER and STORAGE_S3_* on s3. So a script's data-room
             writes (onboard-self's People/<you>/, new-customer's context.md) reach the live store. On the filesystem
             driver the files are on a disk the factory cannot reach: nothing of the store is passed, and the output says
             so. Nothing else of the project's environment, nor of this machine's beyond BASE_ENV, reaches the script;
             every secret value is masked in --dry-run, removed from what the script prints and kept out of the log and
             the JSON result.
  Both add NODE_ENV=production and WORKSPACE_OPS_URL=<the app's address> (not secrets). `npm run operator:*` reads
  .env.local, which neither place has, so the script's own `node ...` line is run without its --env-file flag.

MOLD_V0 ON VERCEL (mold_v0-173). A single-service app (lib/single_service.py) runs its operator scripts the Vercel way
too, from its build copy (build/<app_id>/, or the mold's codebase when the app has no packs, brand or profile), with
DATABASE_URL read from its API project's (<project>-api) production environment for the run only; nothing of a file
store (its scripts write none), and the deployment's non-secret settings a script reads to answer as the app would
(V0_SETTINGS: APP_RUN_SANDBOX), shown as they are. Its package lines run TypeScript through tsx
(`node --import=tsx scripts/operator/<file>.ts`).

READ-ONLY SCRIPTS. A script whose first line is `// READ-ONLY. <what it reads>` (mold_v0's operator:vault-status) still
asks for the yes, since it reads a live app's database; the dry run and the request for the yes say it is read-only and
what it reads, so the person knows what they are agreeing to.

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
AUDIT = "audit:"     # the mold's read-only audit:* scripts: same path, same secrecy, no yes needed (they write nothing)
NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SCRIPT_FILE = re.compile(r"^scripts/operator/[A-Za-z0-9._-]+\.(?:mjs|js|mts|ts)$")
AUDIT_FILE = re.compile(r"^scripts/audit-[a-z0-9-]+\.mjs$")   # the read-only audits (audit:* scripts)
SHELL_BITS = re.compile(r"[;&|<>`$\\]")
SECRET_FLAG = re.compile(r"(?i)(pass(word|wd)?|secret|token|api[-_]?key|credential|private[-_]?key|^--key$)")
MARK = "OPERATOR "
CRONS_FOR_TEST = False   # the self-test has no mold on disk: the module's own cron list stands in
TIMEOUT = int(os.environ.get("OPERATOR_TIMEOUT_S") or 1800)
OWN_FLAGS = ("--operator", "--dry-run", "--yes")

# What a Vercel run hands the script (mold_v1-237). An allow-list, never the whole environment: of the project's
# production environment, the database address and the settings the selected file-store driver reads (the mold's
# lib/storage/settings.ts and docs/STORAGE.md); of this machine's, only what node needs to start. The filesystem
# driver is absent on purpose: its files live on the disk of the machine that serves the app.
DB_VAR = "DATABASE_URL"
STORAGE_VARS = {"vercel-blob": ("BLOB_READ_WRITE_TOKEN",),
                "s3": ("STORAGE_DRIVER", "STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET", "STORAGE_S3_REGION",
                       "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY", "STORAGE_S3_ADDRESSING")}
PULLED_ENV = (DB_VAR,) + tuple(dict.fromkeys(v for vs in STORAGE_VARS.values() for v in vs))
SHOWN_VALUES = ("STORAGE_DRIVER", "STORAGE_S3_REGION", "STORAGE_S3_ADDRESSING")   # not secrets: printed as they are
V0_SETTINGS = ("APP_RUN_SANDBOX",)   # mold_v0: settings a script reads, not secrets: passed and printed as they are
READ_ONLY_LINE = re.compile(r"^//\s*READ-ONLY\.\s*(.*)$")
BASE_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR")


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
    prefix = AUDIT if name.startswith(AUDIT) else PREFIX
    bare = name[len(prefix):] if name.startswith(prefix) else name
    if not NAME.match(bare): raise Usage(f"{name!r} is not the name of an operator script (lower-case letters, digits and hyphens).")
    rest = [x for j, x in enumerate(head[1:], 1) if j not in (i, i + 1)]
    stray = [x for x in rest if x not in OWN_FLAGS]
    if stray:
        raise Usage(f"{' '.join(stray)}: provision.py does not take this with --operator. The script's own arguments go after `--`, "
                    f"for example: --operator {bare} -- {' '.join(stray)}")
    return {"key": prefix + bare, "args": args, "dry": "--dry-run" in rest, "yes": "--yes" in rest}


# ---- the allow-list ----------------------------------------------------------------------------------------------
def allowed(package_json):
    """{"operator:<name>": its command line} from a package.json; {} when there is none to read."""
    try: scripts = json.load(open(package_json)).get("scripts") or {}
    except (OSError, ValueError): return {}
    return {k: v for k, v in scripts.items() if isinstance(k, str) and k.startswith((PREFIX, AUDIT)) and isinstance(v, str)}


def node_argv(cmdline):
    """(argv, None) for a package script that is exactly `node [node flags] scripts/operator/<file>`, without its
    --env-file flag (neither target has .env.local); (None, why) for anything else, which is never run."""
    if SHELL_BITS.search(cmdline or ""): return None, "it is not a plain `node <script>` line (it chains or redirects commands)"
    try: toks = shlex.split(cmdline or "")
    except ValueError: return None, "its command line could not be read"
    if not toks or toks[0] != "node": return None, "it does not start the script with node"
    if not (SCRIPT_FILE.match(toks[-1]) or AUDIT_FILE.match(toks[-1])):
        return None, "it does not end in one script under scripts/operator/ (or a read-only scripts/audit-*.mjs)"
    flags = toks[1:-1]
    if any(not f.startswith("-") for f in flags): return None, "it passes more than one file to node"
    return ["node", *[f for f in flags if not f.startswith(("--env-file=", "--env-file-if-exists="))], toks[-1]], None


def read_only_note(build, script_file):
    """The script's own word that it only reads: its first line `// READ-ONLY. <what it reads>` -> that sentence (cut at
    the first full stop), or None. Wording only: a read-only script still needs the yes."""
    try:
        with open(os.path.join(build, script_file), encoding="utf-8") as f: first = f.readline().strip()
    except (OSError, UnicodeDecodeError): return None
    m = READ_ONLY_LINE.match(first)
    if not m: return None
    said = m.group(1).split(". ")[0].strip().rstrip(".:")
    return said or "it writes nothing"


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


# ---- the environment of a Vercel run (mold_v1-237) ---------------------------------------------------------------------
def storage_driver(vals):
    """The file-store driver the project's production environment selects, as lib/storage/settings.ts reads it."""
    raw = (vals.get("STORAGE_DRIVER") or "").strip()
    return "vercel-blob" if raw == "" else "filesystem" if raw == "fs" else raw


def storage_env(vals):
    """({name: value} of the file store's settings to hand the script, the sentence to print about the store)."""
    drv = storage_driver(vals)
    if drv == "filesystem":
        return {}, ("its file store is the filesystem driver (STORAGE_DRIVER=filesystem): the files live on the disk of the machine "
                    "that serves the app, which the factory cannot reach, so file writes are not possible from the factory. Nothing of the "
                    "store is passed: the database rows are written, and the data-room files (onboard-self's People/<you>/, new-customer's "
                    "context.md) are skipped or fail. (On Vercel that disk is not kept between requests either; the app's own file store "
                    "needs Vercel Blob or s3.)")
    if drv not in STORAGE_VARS:
        return {"STORAGE_DRIVER": vals["STORAGE_DRIVER"]}, (f"its STORAGE_DRIVER is {vals['STORAGE_DRIVER']!r}, which is not a driver (vercel-blob, "
                f"filesystem or s3): the script reports the store as misconfigured and writes no file. Fix the setting on the project first.")
    env = {k: vals[k] for k in STORAGE_VARS[drv] if vals.get(k) and vals[k] != "[SENSITIVE]"}
    if drv == "vercel-blob" and not env:
        return {}, ("its production environment has no BLOB_READ_WRITE_TOKEN (the Vercel Blob store's token) the factory can read: it is "
                    "missing, or marked Sensitive, which Vercel never hands back. So the script finds no file store: the database rows "
                    "are written, the data-room files are skipped or fail.")
    names = " ".join(f"{k}={v}" if k in SHOWN_VALUES else f"{k}=<hidden>" for k, v in env.items())
    return env, f"its file store is {drv}: the script gets {names} from the same production environment, so its data-room files are written."


def child_env(vals, url, base=None, v0=None):
    """The whole environment a Vercel run's child gets: BASE_ENV from this machine, the allow-listed values of the project.
    A mold_v0 run (v0) gets no file store, and the deployment's V0_SETTINGS it has."""
    base = os.environ if base is None else base
    env = {k: base[k] for k in BASE_ENV if base.get(k)}
    env[DB_VAR] = vals[DB_VAR]
    if v0 is not None:
        env.update({k: vals[k] for k in V0_SETTINGS if vals.get(k) and vals[k] != "[SENSITIVE]"})
        env.update(NODE_ENV="production", WORKSPACE_OPS_URL=url)
        set_ = [f"{k}={env[k]}" for k in V0_SETTINGS if k in env]
        return env, ("it gets the app role's DATABASE_URL from the API project's production environment" +
                     (f", and {', '.join(set_)} from the same environment" if set_ else f" (the project sets no {', '.join(V0_SETTINGS)}: the script reads the default)")
                     + "; no file store (its scripts write no files).")
    store, said = storage_env(vals)
    env.update(store); env.update(NODE_ENV="production", WORKSPACE_OPS_URL=url)
    return env, said


def _secret_values(passed):
    """Every value handed to the script that is a secret (all of the project's but the driver's name and plain options)."""
    return [v for k, v in passed.items() if k in PULLED_ENV and k not in SHOWN_VALUES and k not in V0_SETTINGS]


def shown_env(names, proj):
    """The variables of a Vercel run as they are printed: names, never values."""
    why = {DB_VAR: f"the app role's address, read from the production environment of Vercel project {proj} for this run only",
           "BLOB_READ_WRITE_TOKEN": "the Vercel Blob store's token, from the same environment"}
    return " ".join(f"{k}=<hidden: {why[k]}>" if k in why else f"{k}=<hidden>" for k in names)


# ---- on the server (vm_remote): run by `vm_remote.py operator-run`, as root ------------------------------------------
def server_run(env_file, user, home, app_dir, url, req, run=None, say=print):
    """ON THE SERVER, as root: the operator script `req["script"]` with `req["args"]`, inside the serving release, as
    the web app's user with the web service's env file as its environment. Prints the script's output with every value
    of that file removed, then one `OPERATOR {"exit_code": n}` (or {"error": why}) line. Returns the exit code."""
    import pwd
    sys.path.insert(0, HERE); import vm_remote as V
    def out(doc, rc): say(MARK + json.dumps(doc)); return rc
    key = str((req or {}).get("script") or ""); args = (req or {}).get("args") or []
    pre = AUDIT if key.startswith(AUDIT) else PREFIX
    if not key.startswith(pre) or not NAME.match(key[len(pre):]) or not all(isinstance(x, str) for x in args):
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


def main_for(app_id, a, app, infra, ds=None, P=None, runner=None, pull_env=None, say=print, v0=None):
    """`provision.py <app_id> --operator ...`. Returns the exit code (0, 1, 2 or 3); never prints a secret.
    v0 (mold_v0-173, lib/single_service.py): {"build": its build copy, "env_project": its API project} for a single-service
    app on Vercel; None for mold_v1's."""
    try: o = parse(a)
    except Usage as e: say(f"{app_id}: {e} Nothing was run."); return 2
    target = infra.get("target"); key, args = o["key"], o["args"]; shown_args = mask_args(args)
    url = ((infra.get(target) or {}) if target in ("vercel", "vm_remote") else {}).get("production_url")
    if v0 is not None and target != "vercel":
        say(f"{app_id}: --operator runs a single-service app's scripts on Vercel only; this one's target is {target!r}. Nothing was run."); return 2
    if target not in ("vercel", "vm_remote"):
        say(f"{app_id}: --operator runs against an app that serves traffic (Vercel, or its own server); this one's target is {target!r}. Nothing was run."); return 2
    if not url or (target == "vm_remote" and not infra.get("deployed_at")):
        say(f"{app_id}: the app is not deployed yet, so it has no database to run {key} against. Nothing was contacted."); return 1
    build = v0["build"] if v0 is not None else _build_dir(app_id, app, target)
    allow = allowed(os.path.join(build, "package.json"))
    if not allow:
        say(f"{app_id}: there is no package.json with operator scripts under {os.path.relpath(build, ROOT)}/ (the app's build copy). "
            f"A deploy makes it. Nothing was contacted."); return 1
    if key not in allow:
        say(f"{app_id}: {key} is not one of this app's operator scripts. They are: {', '.join(sorted(k[len(PREFIX):] if k.startswith(PREFIX) else k for k in allow))}. Nothing was run."); return 2
    argv, why = node_argv(allow[key])
    if why: say(f"{app_id}: {key} is not run: {why}. Nothing was run."); return 2
    detail = {"script": key, "target": target, "args": shown_args, "dry_run": o["dry"]}
    read_only = key.startswith(AUDIT)
    says_ro = None if read_only else read_only_note(build, argv[-1])   # wording only: it still needs the yes
    if says_ro:
        detail["read_only"] = says_ro
        say(f"{app_id}: {key} is READ-ONLY: {says_ro}. It still runs only with a yes, since it reads the live app's database.")
    rerun = (f"python3 .claude/scripts/provision.py {app_id} --operator {key if read_only else key[len(PREFIX):]}"
             + ("" if read_only else " --yes") + f" -- {shlex.join(shown_args)}").rstrip(" -")
    if target == "vercel":
        if P is not None: P._refuse_live_or_shared_project(app_id, infra)
        proj = v0["env_project"] if v0 is not None else (infra.get("vercel") or {}).get("project")
        names = (DB_VAR,) + (V0_SETTINGS if v0 is not None else ("BLOB_READ_WRITE_TOKEN",))
        shown = (shown_env((DB_VAR,) if v0 is not None else names, proj)
                 + "".join(f" {k}=<as the project sets it, if it does>" for k in (V0_SETTINGS if v0 is not None else ()))
                 + f" NODE_ENV=production WORKSPACE_OPS_URL={shlex.quote(url)} " + shlex.join(argv + shown_args))
        say(f"{app_id}: {key} on Vercel, run here from {os.path.relpath(build, ROOT)}/ (the app's build copy):")
        say(f"    $ cd {shlex.quote(os.path.relpath(build, ROOT))}")
        say(f"    $ {shown}")
        if v0 is not None:
            say(f"    with nothing else of the project's environment (no file store: its scripts write no files), and of this machine's "
                f"only {', '.join(BASE_ENV[:3])} and the like. The database address is the app role's, from {proj}'s production environment.")
        else:
            say(f"    with nothing else of the project's environment, and of this machine's only {', '.join(BASE_ENV[:3])} and the like. "
                f"The file store's settings follow the project's STORAGE_DRIVER: BLOB_READ_WRITE_TOKEN on Vercel Blob (unset, the default); "
                f"STORAGE_DRIVER and STORAGE_S3_* (hidden) on s3; none on filesystem, whose files are on a disk the factory cannot reach, "
                f"so a run there writes the database rows only and says so.")
        detail["command"] = shown; detail["env"] = list(names) + ["NODE_ENV", "WORKSPACE_OPS_URL"]
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
    if not o["yes"] and not read_only:
        if says_ro:
            how = (f"{key} is read-only ({says_ro}), but it connects to the live app {app_id}'s database with the app's own login. "
                   f"Say yes in the chat if it should run with the arguments shown; the agent then runs: {rerun}")
            AR.need("approval", f"yes to run the read-only {key} on {app_id}", how)
            AR.note(summary=f"{app_id}: {key} is read-only, and still needs a yes before it reads the live app's database; nothing was run", next=how)
            say(f"{app_id}: {key} reads a live app's database, so it needs a yes first. Nothing was run. With the yes: {rerun}"); return 3
        how = (f"Running {key} writes to the live app {app_id} (its database{', on its own server' if target == 'vm_remote' else ''}). "
               f"Say yes in the chat if it should run with the arguments shown; the agent then runs: {rerun}")
        AR.need("approval", f"yes to run {key} on {app_id}", how)
        AR.note(summary=f"{app_id}: {key} needs a yes before it writes to the live app; nothing was run", next=how)
        say(f"{app_id}: {key} writes to a live app, so it needs a yes first. Nothing was run. With the yes: {rerun}"); return 3
    if target == "vercel": rc = _run_vercel(app_id, app, infra, ds or {}, build, argv, args, url, key, runner, pull_env, say, v0=v0)
    else: rc = _run_remote(app_id, app, infra, ds or {}, build, argv, args, url, key, runner, pull_env, say)
    detail["exit_code"] = rc if isinstance(rc, int) else None
    ok = rc == 0
    AR.note(summary=f"{app_id}: {key} on {target} " + ("finished" if ok else "failed") + (f" (exit {rc})" if not ok and isinstance(rc, int) else ""))
    return 0 if ok else 1


def _run_vercel(app_id, app, infra, ds, build, argv, args, url, key, runner, pull_env, say, v0=None):
    if pull_env is None:
        if SCRIPTS not in sys.path: sys.path.insert(0, SCRIPTS)
        import clone
        pull_env = clone.pull_env
    proj = v0["env_project"] if v0 is not None else infra["vercel"]["project"]
    pulled = pull_env(proj, build) or {}
    keep = (DB_VAR,) + V0_SETTINGS if v0 is not None else PULLED_ENV
    vals = {k: pulled[k] for k in keep if isinstance(pulled.get(k), str)}   # the allow-list: nothing else is kept
    del pulled
    for v in _secret_values(vals): AR.forbid(v)
    db = vals.get(DB_VAR)
    if not db or db == "[SENSITIVE]":
        say(f"{app_id}: the database address could not be read from the project's production environment. Nothing was run."); return 1
    env, said = child_env(vals, url, v0=v0)
    hide = hider(_secret_values(env))
    AR.NOTES["details"].setdefault("operator", {})["env"] = sorted(k for k in env if k not in BASE_ENV)
    say(f"{app_id}: {said}")
    say(f"    $ " + " ".join(f"{k}={env[k]}" if k in SHOWN_VALUES or k in V0_SETTINGS or k in ("NODE_ENV", "WORKSPACE_OPS_URL") else f"{k}=<hidden>"
                           for k in env if k not in BASE_ENV) + " " + shlex.join(argv + mask_args(args)))
    try:
        r = (runner or subprocess.run)(argv + list(args), cwd=build, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        say(f"{app_id}: {key} did not finish within {TIMEOUT}s and was stopped; what it wrote before that is kept."); return 1
    except (OSError, subprocess.SubprocessError) as e:
        say(f"{app_id}: {key} could not be started ({type(e).__name__}). Nothing was run."); return 1
    for text in (r.stdout, r.stderr):
        for l in hide(text).splitlines(): say(l)
    say(f"{app_id}: {key} exited {r.returncode}. " + ("The database address was never printed." if v0 is not None
        else "The database address and the file store's credentials were never printed."))
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
    # 0. read-only audit:* scripts take the same path: their own key, their own file pattern, nothing else
    pa = parse(["app1", "--operator", "audit:session-owners"])
    ok("an audit:* name keeps its own prefix", pa["key"] == "audit:session-owners" and not pa["yes"], pa)
    ok("audit:* scripts are on the allow-list beside operator:*", True)
    ok("a scripts/audit-*.mjs line is accepted", node_argv("node --experimental-strip-types scripts/audit-session-owners.mjs")[1] is None)
    ok("a non-audit file under an audit name is refused", node_argv("node scripts/other/x.mjs")[1] is not None)
    ok("an audit name cannot smuggle a path", parse.__defaults__ is None and not NAME.match("../x"))
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
        def go(argv, inf=infra, pull_=None, run_=None, **kw):
            AR.reset(); buf = io.StringIO()
            rc = main_for("app1", ["app1"] + argv, app, inf, runner=run_ or fake_run, pull_env=pull_ or pull, say=lambda s: buf.write(s + "\n"), **kw)
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
            # 4b. mold_v1-237: the file store's settings come from the same production environment, through an
            # allow-list: the child gets them and nothing else of the project's (or of this machine's) environment.
            BLOB = "vercel_blob_rw_StoreId123_S3cr3tBlobT0ken"
            NOT_FOR_IT = {"CLOUDFLARE_API_TOKEN": "cf_NotForTheScript_123", "RESEND_API_KEY": "re_NotForTheScript_456",
                          "VERCEL_OIDC_TOKEN": "oidc_NotForTheScript_789", "AUTH_SECRET": "auth_NotForTheScript_0"}
            FULL = {"DATABASE_URL": DB, "BLOB_READ_WRITE_TOKEN": BLOB, **NOT_FOR_IT}
            def pull_with(vals):
                def p_(proj, cwd): pulls.append((proj, cwd)); return dict(vals)
                return p_
            def echo_run(argv, **kw):     # a script that prints its whole environment
                runs_.append((argv, kw))
                return subprocess.CompletedProcess(argv, 0, "".join(f"{k}={v}\n" for k, v in sorted((kw.get("env") or {}).items())), "")
            basics = set(globals().get("BASE_ENV") or ())
            os.environ["SF_SELFTEST_FACTORY_ONLY"] = "factorySideOnlyValue99"
            try:
                pulls.clear(); runs_.clear()
                rc, out = go(["--operator", "onboard-self" if "operator:onboard-self" in al else "new-org", "--dry-run", "--", "--org", "acme"], pull_=pull_with(FULL))
                ok("operator vercel 237: --dry-run names the storage credential, masked, and pulls nothing",
                   rc == 0 and not pulls and "BLOB_READ_WRITE_TOKEN=<hidden" in out and BLOB not in out and "filesystem" in out
                   and "BLOB_READ_WRITE_TOKEN" in (AR.NOTES["details"]["operator"].get("env") or []), out)
                rc, out = go(["--operator", "new-org", "--yes", "--", "--name", "Acme"], pull_=pull_with(FULL), run_=echo_run)
                env_ = runs_[-1][1]["env"] if runs_ else {}
                ok("operator vercel 237: the run gets BLOB_READ_WRITE_TOKEN from the project's production environment",
                   rc == 0 and env_.get("BLOB_READ_WRITE_TOKEN") == BLOB and env_.get("DATABASE_URL") == DB, (rc, sorted(env_)))
                ok("operator vercel 237: the env passed is the allow-list only (no other project value, nothing of this machine's beyond the basics)",
                   set(env_) - basics == {"DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "NODE_ENV", "WORKSPACE_OPS_URL"}
                   and not any(k in env_ for k in NOT_FOR_IT) and "SF_SELFTEST_FACTORY_ONLY" not in env_, sorted(env_))
                ok("operator vercel 237: the storage credential is never printed, even when the script echoes it",
                   BLOB not in out and "BLOB_READ_WRITE_TOKEN=[hidden]" in out and "BLOB_READ_WRITE_TOKEN=<hidden" in out, out)
                # the --json log and result: run through run_json exactly as provision.py --json does
                saved_env = {k: os.environ.pop(k) for k in ("FACTORY_RUN_LOG", "FACTORY_RUN_RECORD", "FACTORY_RUNS_DIR") if k in os.environ}
                jbuf = io.StringIO()
                try:
                    import contextlib
                    with contextlib.redirect_stdout(jbuf):
                        AR.run_json(lambda a_: main_for("app1", a_, app, infra, runner=echo_run, pull_env=pull_with(FULL),
                                                        say=lambda s: os.write(1, (s + "\n").encode())),
                                    ["app1", "--operator", "new-org", "--yes", "--", "--name", "Acme"], t, "app1", "operator")
                finally: os.environ.update(saved_env)
                try: jdoc = json.loads(jbuf.getvalue())
                except ValueError: jdoc = {}
                jlog = open(jdoc["log"]).read() if jdoc.get("log") and os.path.exists(jdoc["log"]) else ""
                ok("operator vercel 237: --json: the storage credential is in neither the result nor the run's log",
                   jdoc.get("status") == "done" and "BLOB_READ_WRITE_TOKEN" in jlog and BLOB not in jlog and BLOB not in jbuf.getvalue()
                   and "Sup3rS3cretPw" not in jlog, (jbuf.getvalue()[-600:], jlog[-600:]))
                # mutation: with the token left out of what is masked, the leak shows (so the checks above can fail)
                real_sv = globals().get("_secret_values"); AR._FORBIDDEN.clear()
                globals()["_secret_values"] = lambda passed: [passed.get("DATABASE_URL")]
                try: rc, out = go(["--operator", "new-org", "--yes"], pull_=pull_with(FULL), run_=echo_run)
                finally:
                    if real_sv: globals()["_secret_values"] = real_sv
                    else: globals().pop("_secret_values", None)
                ok("operator vercel 237 (mutation): unmasked, the echoed token would be printed: the masking is what hides it", BLOB in out, out)
                AR._FORBIDDEN.clear()
                # filesystem: nothing of the file store is passed, and the output says why no file is written
                rc, out = go(["--operator", "new-org", "--yes"], run_=echo_run,
                             pull_=pull_with({"DATABASE_URL": DB, "STORAGE_DRIVER": "filesystem", "STORAGE_FS_ROOT": "/srv/files",
                                              "STORAGE_SIGNING_SECRET": "sig_" + "x" * 32, "BLOB_READ_WRITE_TOKEN": BLOB}))
                env_ = runs_[-1][1]["env"] if runs_ else {}
                ok("operator vercel 237: a filesystem file store: no storage setting passed, and the output says file writes are not possible from the factory and why",
                   rc == 0 and not any(k.startswith(("STORAGE_", "BLOB_")) for k in env_) and "file writes are not possible from the factory" in out
                   and "disk" in out and "sig_xxxx" not in out and BLOB not in out, (sorted(env_), out))
                # s3: the bucket's settings, its secret hidden; a stale blob token is not passed
                S3SECRET = "s3SecretAccessKey_ABCDEFGH123"
                rc, out = go(["--operator", "new-org", "--yes"], run_=echo_run,
                             pull_=pull_with({"DATABASE_URL": DB, "STORAGE_DRIVER": "s3", "STORAGE_S3_ENDPOINT": "https://ams3.digitaloceanspaces.com",
                                              "STORAGE_S3_BUCKET": "files-bucket-x", "STORAGE_S3_REGION": "ams3", "STORAGE_S3_ACCESS_KEY_ID": "AKIDEXAMPLE12345",
                                              "STORAGE_S3_SECRET_ACCESS_KEY": S3SECRET, "BLOB_READ_WRITE_TOKEN": BLOB, **NOT_FOR_IT}))
                env_ = runs_[-1][1]["env"] if runs_ else {}
                ok("operator vercel 237: an s3 file store: STORAGE_DRIVER and the bucket's settings only, the secret key never printed",
                   rc == 0 and env_.get("STORAGE_DRIVER") == "s3" and env_.get("STORAGE_S3_SECRET_ACCESS_KEY") == S3SECRET and "BLOB_READ_WRITE_TOKEN" not in env_
                   and set(env_) - basics == {"DATABASE_URL", "NODE_ENV", "WORKSPACE_OPS_URL", "STORAGE_DRIVER", "STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET",
                                              "STORAGE_S3_REGION", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"}
                   and S3SECRET not in out and "AKIDEXAMPLE12345" not in out, (sorted(env_), out))
                # Vercel Blob without a token: said, and the run goes on (the rows are written)
                rc, out = go(["--operator", "new-org", "--yes"], run_=echo_run, pull_=pull_with({"DATABASE_URL": DB}))
                ok("operator vercel 237: no BLOB_READ_WRITE_TOKEN in the project: said plainly, the database part still runs",
                   rc == 0 and "no BLOB_READ_WRITE_TOKEN" in out, out)
            finally:
                os.environ.pop("SF_SELFTEST_FACTORY_ONLY", None); AR._FORBIDDEN.clear()
            # 4c. mold_v0-173: a single-service app on Vercel (lib/single_service.py hands over with v0): its build copy, the
            # API project's DATABASE_URL and APP_RUN_SANDBOX only (no file store), a tsx line, and a READ-ONLY script's wording.
            b0 = os.path.join(t, "build", "v0app"); os.makedirs(os.path.join(b0, "scripts", "operator"))
            json.dump({"scripts": {"operator:vault-status": "node --env-file-if-exists=.env --import=tsx scripts/operator/vault-status.ts",
                                   "operator:other": "node --import=tsx scripts/operator/other.ts"}}, open(os.path.join(b0, "package.json"), "w"))
            open(os.path.join(b0, "scripts", "operator", "vault-status.ts"), "w").write("// READ-ONLY. Which keys the app's key vault holds: never a value. More.\nconsole.log(1);\n")
            open(os.path.join(b0, "scripts", "operator", "other.ts"), "w").write("// writes things\n")
            V0 = {"build": b0, "env_project": "app-one-api"}
            ok("operator v0: a tsx package line is a plain node line", node_argv("node --env-file-if-exists=.env --import=tsx scripts/operator/vault-status.ts")[0]
               == ["node", "--import=tsx", "scripts/operator/vault-status.ts"])
            ok("operator v0: the READ-ONLY first line is read (wording only)", read_only_note(b0, "scripts/operator/vault-status.ts") == "Which keys the app's key vault holds: never a value"
               and read_only_note(b0, "scripts/operator/other.ts") is None and read_only_note(b0, "scripts/operator/none.ts") is None)
            V0FULL = {"DATABASE_URL": DB, "BLOB_READ_WRITE_TOKEN": BLOB, "APP_RUN_SANDBOX": "auto", **NOT_FOR_IT}
            pulls.clear(); runs_.clear()
            rc, out = go(["--operator", "vault-status", "--dry-run", "--", "--json"], pull_=pull_with(V0FULL), v0=V0)
            ok("operator v0: --dry-run says READ-ONLY, names the API project and the tsx line, pulls and runs nothing",
               rc == 0 and not pulls and not runs_ and "READ-ONLY: Which keys" in out and "app-one-api" in out and "node --import=tsx scripts/operator/vault-status.ts --json" in out
               and "BLOB_READ_WRITE_TOKEN" not in out and "build/v0app" in out and AR.NOTES["details"]["operator"]["read_only"].startswith("Which keys"), out)
            rc, out = go(["--operator", "vault-status", "--", "--json"], pull_=pull_with(V0FULL), v0=V0)
            ok("operator v0: a read-only script still needs the yes (exit 3), and the request says it is read-only",
               rc == 3 and not pulls and not runs_ and "read-only" in AR.NOTES["needs"][0]["how"] and "read-only" in AR.NOTES["needs"][0]["name"]
               and "--operator vault-status --yes -- --json" in AR.NOTES["needs"][0]["how"], (out, AR.NOTES["needs"]))
            rc, out = go(["--operator", "other"], pull_=pull_with(V0FULL), v0=V0)
            ok("operator v0: a script without the READ-ONLY line asks for the yes as a write", rc == 3 and "writes to the live app" in AR.NOTES["needs"][0]["how"], out)
            rc, out = go(["--operator", "vault-status", "--yes", "--", "--json"], pull_=pull_with(V0FULL), run_=echo_run, v0=V0)
            env_ = runs_[-1][1]["env"] if runs_ else {}
            ok("operator v0: --yes pulls the API project's environment and hands over DATABASE_URL and APP_RUN_SANDBOX only (no file store, nothing else)",
               rc == 0 and pulls[-1] == ("app-one-api", b0) and runs_[-1][1]["cwd"] == b0
               and runs_[-1][0] == ["node", "--import=tsx", "scripts/operator/vault-status.ts", "--json"]
               and set(env_) - basics == {"DATABASE_URL", "APP_RUN_SANDBOX", "NODE_ENV", "WORKSPACE_OPS_URL"} and env_["DATABASE_URL"] == DB, (sorted(env_), out))
            ok("operator v0: the database address is never printed (even echoed); APP_RUN_SANDBOX is shown as it is",
               "Sup3rS3cretPw" not in out and BLOB not in out and "DATABASE_URL=[hidden]" in out and "APP_RUN_SANDBOX=auto" in out and "address was never printed" in out, out)
            rc, out = go(["--operator", "vault-status", "--yes"], pull_=pull_with({"DATABASE_URL": DB}), run_=echo_run, v0=V0)
            ok("operator v0: no APP_RUN_SANDBOX on the project: said, the script reads the default", rc == 0 and "APP_RUN_SANDBOX" not in runs_[-1][1]["env"] and "reads the default" in out, out)
            rc, out = go(["--operator", "vault-status", "--yes"], inf={"target": "compose_remote", "compose_remote": {"production_url": "https://x.example.com"}}, v0=V0)
            ok("operator v0: a single-service app off Vercel is refused, exit 2", rc == 2 and "Vercel only" in out, out)
            AR._FORBIDDEN.clear()
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
