"""The factory's one door to the outside world, and the switches that send it to fakes instead.

  FACTORY_REHEARSAL=<dir>   a REHEARSAL: every outside call goes to the fakes in <dir>/bin (vercel, ssh, scp, gh, glab,
                            npm, npx, curl, and `http` for the scripts' own HTTP calls). Any of those names with no fake
                            there gets a stub that refuses, so a real service can never be reached by accident. The
                            steps of a deploy that run the mold's own build and database chain against a provider
                            (provision_datastores, the schema bring-up and the three builds) are answered by the
                            stand-ins at the bottom of this file, through the same fakes; everything else in each
                            script (its checks, refusals, plans, state writes, locks and results) runs as it ships.
  FACTORY_CALL_LOG=<path>   one JSON line per script invocation and per outbound action: script, arguments, the action
                            (deploy, set-secret, code-request, publish, ...) and who called it. Never a value: a secret
                            is logged as its name and whether it was written.
  FACTORY_PRIVATE_DIR=<dir> where sign-in sessions are kept (default ~/.cache/software-factory).
  FACTORY_LOCAL=<path>      read in place of state/factory.local.json (lib/factory_local.py).

With none of them set, nothing here changes what a script does. Standard library only.
"""
import datetime, json, os, re, secrets as _secrets, stat, subprocess, sys

REHEARSAL = os.environ.get("FACTORY_REHEARSAL") or None
CALL_LOG = os.environ.get("FACTORY_CALL_LOG") or None
OUTSIDE = ("vercel", "ssh", "scp", "gh", "glab", "npm", "npx", "curl", "http", "wg", "dig")
NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,80}$")


def private_dir():
    return os.environ.get("FACTORY_PRIVATE_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "software-factory")


def bin_dir(): return os.path.join(REHEARSAL, "bin") if REHEARSAL else None


_ACTIVE = False
def activate():
    """In a rehearsal: the fakes first on PATH (for this process and every child), refusing stubs for the rest."""
    global _ACTIVE
    if not REHEARSAL or _ACTIVE: return
    b = bin_dir(); os.makedirs(b, exist_ok=True)
    for n in OUTSIDE:
        p = os.path.join(b, n)
        if not os.path.lexists(p):
            with open(p, "w") as f:
                f.write("#!/bin/sh\necho \"rehearsal: $(basename \"$0\") is not simulated here; nothing was sent\" >&2\nexit 1\n")
            os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    path = os.environ.get("PATH", "")
    if not path.startswith(b + os.pathsep): os.environ["PATH"] = b + os.pathsep + path
    _ACTIVE = True


def _redact_argv(argv):
    out, after_secret = [], False
    for a in argv:
        a = str(a)
        if after_secret and not NAME.match(a): a = "<not a secret name: hidden>"
        after_secret = a == "--set-secret"
        out.append(a)
    return out


def log_call(tool, argv, **extra):
    """One line in FACTORY_CALL_LOG, if it is set. `argv` never carries a value (see _redact_argv)."""
    if not CALL_LOG: return
    rec = {"t": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tool": tool,
           "argv": _redact_argv(argv), "parent": os.environ.get("FACTORY_CALL_PARENT") or "agent"}
    if os.environ.get("FACTORY_CALL_ACTION") and "action" not in extra: rec["action"] = os.environ["FACTORY_CALL_ACTION"]
    rec.update(extra)
    try:
        os.makedirs(os.path.dirname(os.path.abspath(CALL_LOG)), exist_ok=True)
        with open(CALL_LOG, "a") as f: f.write(json.dumps(rec) + "\n")
    except OSError: pass


def script_start(tool, argv, action=None):
    """First line of a script's main: log the invocation, then mark every child as called by this script."""
    if REHEARSAL: activate()
    if not CALL_LOG: return
    log_call(tool, argv, **({"action": action} if action else {}))
    os.environ["FACTORY_CALL_PARENT"] = tool
    if action: os.environ["FACTORY_CALL_ACTION"] = action


def http_json(method, url, body=None, timeout=20):
    """A rehearsal's HTTP: (status, parsed body) from the `http` fake. Only called when REHEARSAL is set."""
    activate()
    r = subprocess.run([os.path.join(bin_dir(), "http"), method, url], input=json.dumps(body) if body is not None else "",
                       capture_output=True, text=True, timeout=timeout)
    try: d = json.loads(r.stdout or "{}")
    except ValueError: d = {}
    if r.returncode and not d: return 0, {"error": (r.stderr or "no answer").strip()[-200:]}
    return int(d.get("status") or 0), d.get("body")


# ---- the deploy's stand-ins (only in a rehearsal) --------------------------------------------------------------
# The real steps run the mold's own node scripts against a cloud database and build three deployables. A rehearsal
# has neither, so these answer for them, through the same vercel and curl fakes, writing exactly the state the real
# steps write (the derived env names, rls_verified, the three URLs, vercel.health) so every reader downstream
# (factory.py validate, mint.py, lanes.py) judges it as it would a real deploy.

def _fake_value(name): return "rehearsal-" + _secrets.token_hex(16)


def rehearsal_provision_datastores(P, app_id, ds, mold_dir, present, infra, proj):
    pg = ds.get("postgres", {}); prov = pg.get("provider", "supabase")
    want = [n for n in (P.DB_SENTINEL.get(prov), "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", *P.GENERATED, "AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY")
            if n and n not in present]
    for n in want:
        P._add_env(n, _fake_value(n), mold_dir, proj); print(f"  {proj}: {n} written")
    return set(present) | set(want)


def rehearsal_rls_evidence(ds, now):
    """What the fake database's isolation proof measures: every org-scoped table protected, nothing readable across."""
    pg = ds.get("postgres", {})
    return {"at": now, "backend": pg.get("provider", "supabase"), "mode": P_rls_mode(ds), "source": "provision.py --deploy",
            "role": "app_rw", "superuser": False, "bypassrls": False, "org_scoped_tables": 12, "protected": 12, "unprotected": [],
            "open_policies": [], "leaking_policies": [], "policies_executed": 12, "policies_unverified": [], "unmeasured": [],
            "probe_table": "documents", "probe_tables": 12, "probe_skipped": [], "foreign_rows_readable": 0,
            "cross_org_write": "42501", "unset_org_rows": 0}


def P_rls_mode(ds):
    r = (ds.get("postgres") or {}).get("rls") or "off"
    return r


def rehearsal_deploy_vercel(P, app_id, app, infra, ds, mold_dir, adir):
    """The three production deployments, in the real order (workflow, api, web), each through the vercel fake, then
    the three health reads through the curl fake. A deployment the fake refuses stops the deploy exactly as a real
    failed build does (SystemExit with the CLI's output), so main() records the revert."""
    proj = infra["vercel"]["project"]
    if ds.get("postgres", {}).get("scope") != "shared_with_live":
        P.record_rls(adir, ds, rehearsal_rls_evidence(ds, P.NOW))
    P.SHIPPED.clear()
    steps = [("workflow", f"{proj}-workflow", "workflow_url", ["services/task-workflow"]), ("api", f"{proj}-api", "api_url", ["--prebuilt"]),
             ("web", proj, "production_url", ["."])]
    for name, project, key, extra in steps:
        print(f"deploying {name} ({project})")
        r = P.vrun(["vercel", "deploy", *extra, "--prod", "--yes", "--project", project], cwd=mold_dir, timeout=120)
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode: sys.exit(f"{name} deploy failed:\n" + out.strip()[-1500:])
        urls = re.findall(r"https://[a-z0-9.-]+", out)
        url = urls[-1] if urls else ""
        P.SHIPPED.append((name, url)); infra["vercel"][key] = url; print(f"  {url}")
    url = infra["vercel"]["production_url"]
    checks = [("workflow", f"{infra['vercel'].get('workflow_url', '')}/api/health"), ("api", f"{infra['vercel'].get('api_url', '')}/eve/v1/health"),
              ("web", f"{url}/api/ops/health")]
    health = {}; running = ("unmeasured", "the web app was not health-checked")
    for name, u in checks:
        code, doc, why = P._read_health(u)
        health[name] = code or "no answer"; print(f"  health {name}: {health[name]} {u}")
        if name == "web": running = P._rls_from_doc(code, doc, why)
    infra["vercel"]["health"] = health
    P.record_running_app(adir, ds, running)
    print(f"  row-level security, as reported by the app now serving traffic: {running[0]} ({running[1][:160]})")
    return running


def self_test():
    import tempfile
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    ok(_redact_argv(["app", "--set-secret", "RESEND_API_KEY"]) == ["app", "--set-secret", "RESEND_API_KEY"], "a secret NAME is logged as it is")
    ok(_redact_argv(["app", "--set-secret", "re_abc123value"]) == ["app", "--set-secret", "<not a secret name: hidden>"], "a value typed where the name goes is never logged")
    ok(private_dir().endswith(os.path.join(".cache", "software-factory")) or os.environ.get("FACTORY_PRIVATE_DIR"), "the private directory defaults to ~/.cache/software-factory")
    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "calls.jsonl"); reh = os.path.join(d, "reh"); os.makedirs(os.path.join(reh, "bin"))
        open(os.path.join(reh, "bin", "http"), "w").write("#!/bin/sh\necho '{\"status\": 200, \"body\": {\"ok\": true}}'\n")
        os.chmod(os.path.join(reh, "bin", "http"), 0o755)
        here = os.path.dirname(os.path.abspath(__file__))
        child = os.path.join(d, "child.py"); parent = os.path.join(d, "parent.py")
        open(child, "w").write(f"import sys; sys.path.insert(0, {here!r}); import services as S; S.log_call('y.py', [])\n")
        open(parent, "w").write(f"import sys, os, subprocess; sys.path.insert(0, {here!r}); import services as S\n"
                                "S.script_start('x.py', ['app', '--deploy'], action='deploy')\n"
                                "print(S.http_json('GET', 'https://a.rehearsal.invalid/'))\n"
                                "r = subprocess.run(['vercel', 'whoami'], capture_output=True, text=True); print(r.returncode, r.stderr.strip())\n"
                                f"subprocess.run([sys.executable, {child!r}])\n")
        env = dict(os.environ, FACTORY_REHEARSAL=reh, FACTORY_CALL_LOG=log); env.pop("FACTORY_CALL_PARENT", None); env.pop("FACTORY_CALL_ACTION", None)
        r = subprocess.run([sys.executable, parent], env=env, capture_output=True, text=True)
        ok("(200, {'ok': True})" in r.stdout, ("a rehearsal's HTTP goes to the http fake", r.stdout, r.stderr))
        ok("1 rehearsal: vercel is not simulated" in r.stdout, "an outside CLI with no fake gets a refusing stub, never the real one")
        lines = [json.loads(l) for l in open(log)]
        ok(lines[0]["tool"] == "x.py" and lines[0]["parent"] == "agent" and lines[0]["action"] == "deploy", "the invocation is logged, with its action, as the agent's")
        ok(lines[1]["tool"] == "y.py" and lines[1]["parent"] == "x.py" and lines[1]["action"] == "deploy", "a child is logged as called by the script")
        env2 = {k: v for k, v in os.environ.items() if not k.startswith("FACTORY_")}
        r = subprocess.run([sys.executable, "-c", "import sys, os; sys.path.insert(0, %r); import services as S; S.script_start('x.py', []); print(S.REHEARSAL, S.CALL_LOG, os.environ.get('FACTORY_CALL_PARENT'))"
                            % os.path.dirname(os.path.abspath(__file__))], env=env2, capture_output=True, text=True)
        ok(r.stdout.strip() == "None None None", "with nothing set, nothing changes and nothing is logged")
    print(f"services: {len(checks)} checks passed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    print(__doc__)
