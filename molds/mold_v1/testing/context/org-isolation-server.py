#!/usr/bin/env python3
"""org-isolation-server.py <app_id> [--script PATH] | --self-test — test:org-isolation, run ON a vm_remote server.

The context lane's `test:org-isolation` must connect AS the application (its app_rw DATABASE_URL): as postgres it
cannot see a leak at all, because postgres has BYPASSRLS. For a Vercel or vm application lanes.py reads that URL by
name from the app's secret store and runs the test here. A vm_remote application's DATABASE_URL lives in the env
file on its own server and never leaves it, and its database listens on that server's loopback only, so from here
the row could only ever be `skipped`, and the lane could never be `pass` for any vm_remote application.

So the test goes to the URL instead of the URL coming here, exactly as the deploy's own isolation proof does
(`provision.py <app> --verify-rls`, lib/vm_remote.py `host-chain --measure-only`): over SSH, as the account the
deploy uses, a short Python program on the server reads DATABASE_URL from the app's env file
(/etc/software-factory/<app>/env), and runs node in the app's own directory (its node_modules) with the URL in the
child's ENVIRONMENT only, never in an argv (/proc/<pid>/cmdline is world-readable). The test itself is THIS lane's
copy (`--script`, default scripts/test-org-isolation.mjs under the cwd, which lanes.py makes the app's lane copy), sent
on stdin, so the same file grades a vm_remote app as grades a Vercel one. What comes back is the test's own output
with the URL, its password and anything URL-shaped redacted, on the server and again here, and the test's exit
status. The test is non-destructive: its probe rows live under throwaway workspaces and are removed in a finally.

Exit: the test's own status (0 every assertion held); 2 this is not a vm_remote application or its state cannot say
where the server is; 3 the server's env file has no DATABASE_URL yet (deploy it first); 255 SSH could not connect.
"""
import json, os, re, shlex, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(HERE))))
sys.path.insert(0, os.path.join(ROOT, ".claude", "scripts", "lib"))

# Runs on the SERVER (python3 -c). Arguments: the app's directory, its env file, the node binary. The test arrives on
# stdin. Parses the env file the way lib/vm_remote.py env_parse does. Holds the URL only in this process and the
# child's environment; redacts it, and its password, from everything it prints.
REMOTE = r'''
import os, re, subprocess, sys
app_dir, env_file, node = sys.argv[1], sys.argv[2], sys.argv[3]
vals = {}
try:
    text = open(env_file).read()
except OSError as e:
    print("org-isolation-server: cannot read the app's env file on the server (%s)" % e.strerror); sys.exit(3)
for line in text.splitlines():
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line: continue
    k, v = line.split("=", 1); k = k.strip(); v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] == '"': v = v[1:-1]
    vals[k] = v
url = vals.get("DATABASE_URL", "")
if not url:
    print("org-isolation-server: the app's env file on the server has no DATABASE_URL yet"); sys.exit(3)
src = sys.stdin.read()
try:
    r = subprocess.run([node, "--input-type=module", "-"], input=src, cwd=app_dir, capture_output=True, text=True,
                       timeout=540, env=dict(os.environ, DATABASE_URL=url))
    out, code = (r.stdout or "") + (r.stderr or ""), r.returncode
except subprocess.TimeoutExpired:
    out, code = "org-isolation-server: the test did not finish within 540 s on the server and was stopped", 124
m = re.match(r"^[a-z][a-z0-9+.-]*://[^:/@]*:([^@]*)@", url, re.I)
for s in sorted({url} | ({m.group(1)} if m and m.group(1) else set()), key=len, reverse=True):
    out = out.replace(s, "[redacted]")
out = re.sub(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@\"']*:[^\s/@\"']*@", r"\1***:***@", out)
sys.stdout.write(out); sys.exit(code)
'''

def remote_argv(S, node="node"):
    """The one SSH command: no value in it, only the program above and three paths from state."""
    import vm_remote
    cmd = f"{S['sudo']}python3 -c {shlex.quote(REMOTE)} {shlex.quote(S['app_dir'])} {shlex.quote(S['env_file'])} {shlex.quote(node)}"
    return vm_remote.ssh_argv(S, cmd)

def settings_for(app_id):
    d = os.path.join(ROOT, "state", "application", app_id)
    try:
        docs = {n: json.load(open(os.path.join(d, f"{n}.json"))) for n in ("application", "infrastructure", "datastores")}
    except OSError as e:
        print(f"org-isolation-server: no state for {app_id} ({e.strerror})"); return None
    if (docs["infrastructure"].get("target")) != "vm_remote":
        print(f"org-isolation-server: {app_id} is not a vm_remote application (target {docs['infrastructure'].get('target')!r}); "
              f"the context lane runs test:org-isolation for it directly"); return None
    import vm_remote
    S = vm_remote.settings(app_id, docs["application"], docs["infrastructure"], docs["datastores"])
    if not (S.get("ssh_host") or S.get("host")):
        print(f"org-isolation-server: {app_id}'s state names no server yet: python3 .claude/scripts/provision.py {app_id} --deploy-remote"); return None
    return S

def main(a):
    if not a or a[0] in ("-h", "--help"): sys.exit(__doc__)
    if a[0] == "--self-test": return self_test()
    app_id = a[0]
    script = a[a.index("--script") + 1] if "--script" in a and a.index("--script") + 1 < len(a) else "scripts/test-org-isolation.mjs"
    if not os.path.isfile(script):
        print(f"org-isolation-server: {os.path.abspath(script)} does not exist; refresh the mold from source per its MOLD.md"); return 2
    S = settings_for(app_id)
    if S is None: return 2
    import vm_remote
    try:
        r = subprocess.run(remote_argv(S), input=open(script).read(), capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        print("org-isolation-server: no answer from the server within 600 s"); return 124
    out = vm_remote.redact((r.stdout or "") + (r.stderr or ""))
    sys.stdout.write(out if out.endswith("\n") or not out else out + "\n")
    print(f"org-isolation-server: ran on {S['host_shown']} as {S['user']} in {S['app_dir']}, exit {r.returncode}")
    return r.returncode

# ---------------------------------------------------------------------------------------------------------------------
def self_test():
    """Offline: the server-side program, run here against a fake env file and a fake node, and the SSH command."""
    ok = fail = 0
    def check(name, cond, detail=""):
        nonlocal ok, fail
        ok += bool(cond); fail += not cond
        print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f"  {detail}"))
    URL = "postgresql://app_rw:s3cr3t-Pa55@127.0.0.1:5432/hfc?sslmode=require"
    with tempfile.TemporaryDirectory() as t:
        node = os.path.join(t, "fake-node")
        # A "node" that proves what it was given: the URL only in its environment, the test on stdin, its cwd; and that
        # leaks the URL on purpose, so the redaction is what is being tested. Exit status from the test's text.
        with open(node, "w") as f:
            f.write("#!/usr/bin/env python3\nimport os, sys\nsrc = sys.stdin.read()\n"
                    "print('argv', ' '.join(sys.argv[1:])); print('cwd', os.getcwd()); print('env', os.environ.get('DATABASE_URL'))\n"
                    "print('stdin', src.strip()); print('password alone', os.environ['DATABASE_URL'].split(':')[2].split('@')[0])\n"
                    "sys.exit(1 if 'FAILS' in src else 0)\n")
        os.chmod(node, 0o755)
        envf = os.path.join(t, "env")
        def run(env_text, script):
            if env_text is None:
                if os.path.exists(envf): os.remove(envf)
            else:
                open(envf, "w").write(env_text)
            return subprocess.run([sys.executable, "-c", REMOTE, t, envf, node], input=script, capture_output=True, text=True, timeout=60)
        r = run(f'# the app\nOTHER=1\nDATABASE_URL="{URL}"\n', "console.log('isolation ok')")
        check("the test's exit status comes back (0)", r.returncode == 0, r.stdout + r.stderr)
        check("the test arrives on stdin, run as an ES module from stdin", "stdin console.log('isolation ok')" in r.stdout and "argv --input-type=module -" in r.stdout, r.stdout)
        check("it runs in the app's own directory (its node_modules)", f"cwd {os.path.realpath(t)}" in r.stdout or f"cwd {t}" in r.stdout, r.stdout)
        check("the URL reached the test, through its environment", "env [redacted]" in r.stdout, r.stdout)
        check("neither the URL nor its password is ever printed", "s3cr3t-Pa55" not in r.stdout + r.stderr and URL not in r.stdout, r.stdout)
        r = run(f"DATABASE_URL={URL}\n", "FAILS")
        check("a failing test fails the row (exit 1 comes back)", r.returncode == 1, r.returncode)
        r = run("OTHER=1\n", "x")
        check("no DATABASE_URL in the env file: exit 3, said so", r.returncode == 3 and "no DATABASE_URL" in r.stdout, r.stdout)
        r = run(None, "x")
        check("no env file at all: exit 3, said so", r.returncode == 3 and "cannot read" in r.stdout, r.stdout)
    import vm_remote
    S = {"app_id": "x", "host": "203.0.113.9", "ssh_host": "", "host_shown": "203.0.113.9", "user": "root", "sudo": "", "port": 22,
         "key_ref": "sf_x", "app_dir": "/opt/software-factory/x/app", "env_file": "/etc/software-factory/x/env"}
    argv = remote_argv(S)
    exact = f"python3 -c {shlex.quote(REMOTE)} /opt/software-factory/x/app /etc/software-factory/x/env node"
    check("the SSH command is the program and three paths from state, nothing else (no value can be in it)",
          argv[0] == "ssh" and argv[-1] == exact and "BatchMode=yes" in argv, argv[-1][-120:])
    S2 = dict(S, user="deploy", sudo="sudo ")
    check("a non-root SSH account reads the root-only env file through sudo", remote_argv(S2)[-1].startswith("sudo python3 -c "), remote_argv(S2)[-1][:40])
    check("refuses an application that is not vm_remote", settings_for("onfinance_hfc") is None if os.path.isdir(os.path.join(ROOT, "state/application/onfinance_hfc")) else True)
    print(f"org-isolation-server self-test: {ok}/{ok + fail} cases passed")
    return 1 if fail else 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
