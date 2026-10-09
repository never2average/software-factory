#!/usr/bin/env python3
"""agent_cli.py <app_id> status | build | publish [--version X.Y.Z] [--dry-run] [--email-sign-in-only]   |   --self-test

Every stamped application publishes its OWN variant of the mold's agent CLI (the package a coding agent installs
to reach the app: its address baked in, its brand, its pack's agent-kit skills, its data-room description).
state/application/<app_id>/infrastructure.json "agent_cli" names the package; this script builds and publishes it.

  status    what the state names, what the registry has, who this machine is signed in to npm as
  build     build/<app_id>/ -> build/<app_id>.agent-cli/ with the mold's own builder (its safety gate runs),
            then the factory's file allowlist; prints the file list and the tarball hash. Publishes nothing.
  publish   build, then `npm publish`. Signs in with the token NAMED by agent_cli.token_ref if this machine's
            environment has it, otherwise with the npm sign-in already on this machine (`npm login`).
            Records version, time, hash and mold commit under agent_cli.published.

The token's VALUE is never read into this script's output, never written to a file and never put on a command
line: npm expands ${NAME} from the environment itself. A public package carries no credentials and no operator
material (a pack's agent-kit/ is the only pack content that ships; see packs.py ALLOWED).

GOOGLE SIGN-IN. The mold's source holds no Google client; its builder writes the application's own installed-app
("Desktop app") client into the package from AGENT_CLI_GOOGLE_CLIENT_ID / _SECRET in the build's environment. This
script supplies them from the application's private settings, by NAME: WORKSPACE_OAUTH_CLIENT_ID and
WORKSPACE_OAUTH_CLIENT_SECRET (infrastructure.google.cli_client_id_ref / cli_client_secret_ref name others), looked
for in this machine's environment, then where the application keeps its secrets (its Vercel project's production
environment, or the master env file on its own server). The values go only into the builder's environment: never
printed, never on a command line, never written anywhere but a 0600 file that is deleted at once (`vercel env
pull`). Not found: it stops with exit 3 and names what to set where. `build --email-sign-in-only` builds a package
without Google sign-in instead.
"""
import datetime, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# What a built package may contain. Anything else means the mold's builder changed and someone should look
# before it goes to a public registry.
ALLOWED = [re.compile(p) for p in (
    r"^package\.json$", r"^README\.md$", r"^dm\.md$", r"^deployment\.generated\.mjs$",
    # <prefix>-<name>.mjs at the top level: the modules the mold's own setup/ package ships (its CLI, login, tools,
    # skill installer), named by the mold's source, not by the factory.
    r"^[a-z][a-z0-9]*-[a-z-]+\.mjs$", r"^skills/[a-z][a-z0-9-]*/[A-Za-z0-9_./-]+$",
)]
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
# The application's settings that hold its Google installed-app client (the names the mold's server and builder read),
# and the builder variables they are handed over as.
GOOGLE_REFS = {"cli_client_id_ref": "WORKSPACE_OAUTH_CLIENT_ID", "cli_client_secret_ref": "WORKSPACE_OAUTH_CLIENT_SECRET"}
GOOGLE_BUILD = {"cli_client_id_ref": "AGENT_CLI_GOOGLE_CLIENT_ID", "cli_client_secret_ref": "AGENT_CLI_GOOGLE_CLIENT_SECRET"}
REDACTED = "[SENSITIVE]"   # what `vercel env pull` writes for a write-only variable
NEEDS_HUMAN = 3

def load(p): return json.load(open(p))

def docs(app_id):
    d = os.path.join(ROOT, "state", "application", app_id)
    if not os.path.isdir(d): sys.exit(f"{app_id}: no state/application/{app_id}/")
    app = load(os.path.join(d, "application.json")); infra_p = os.path.join(d, "infrastructure.json"); infra = load(infra_p)
    cli = infra.get("agent_cli")
    if not cli: sys.exit(f"{app_id}: infrastructure.json has no \"agent_cli\" (package, access); nothing to build")
    return app, infra, infra_p, cli

def origin_of(infra):
    """The address baked into the package: where the application lives, per deploy target. A server of its own
    (vm_remote) answers at vm_remote.production_url, once a deploy recorded it."""
    if infra.get("target") == "vm_remote":
        vr = infra.get("vm_remote") or {}; o = (vr.get("production_url") or "").strip()
        if not (o and vr.get("domain") and o.rstrip("/") == f"https://{vr['domain']}" and infra.get("deployed_at")):
            sys.exit("the application has no public address yet (infrastructure.vm_remote.production_url); deploy it first: provision.py <app_id> --deploy-remote")
        return o.rstrip("/")
    o = (infra.get("vercel") or {}).get("production_url") or (infra.get("vm") or {}).get("public_url")
    if not o: sys.exit("the application has no public address yet (infrastructure.vercel.production_url); deploy it first")
    return o.rstrip("/")

def next_version(latest):
    """The patch after what the registry has; 0.1.0 for a package that has never been published."""
    if not latest: return "0.1.0"
    m = SEMVER.match(latest)
    if not m: raise ValueError(f"registry version {latest!r} is not X.Y.Z; pass --version")
    return f"{m[1]}.{m[2]}.{int(m[3]) + 1}"

def disallowed(files): return [f for f in files if ".." in f or not any(a.match(f) for a in ALLOWED)]

def npmrc_lines(registry, token_name):
    """An npmrc that names the token, never holds it: npm replaces ${NAME} from the environment."""
    host = re.sub(r"^https?:", "", registry.rstrip("/") + "/")
    return f"registry={registry}\n{host}:_authToken=${{{token_name}}}\n"

def registry_latest(cli):
    r = subprocess.run(["npm", "view", cli["package"], "version", "--registry", cli.get("registry", "https://registry.npmjs.org/")],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None

def mold_commit(app):
    for m in load(os.path.join(ROOT, "state", "factory.json")).get("molds", []):
        if m.get("mold_id") == app["mold_id"]: return (m.get("source") or {}).get("commit")

def google_names(infra):
    """{role: the NAME of the setting} for the application's Google installed-app client."""
    g = infra.get("google") or {}
    return {role: (g.get(role) or default).strip() for role, default in GOOGLE_REFS.items()}

def parse_env(text, names):
    """{name: value} for `names` only, from dotenv text. A write-only value Vercel will not hand back is left out."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m or m[1] not in names: continue
        v = m[2].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": v = v[1:-1]
        if v and v != REDACTED: out[m[1]] = v
    return out

def private_dir():
    d = os.environ.get("CLAUDE_JOB_DIR"); d = os.path.join(d, "tmp") if d else None
    if d: os.makedirs(d, exist_ok=True)
    return tempfile.mkdtemp(prefix="agent-cli-env-", dir=d)

def from_vercel(app_id, infra, names):
    """The names' values from the application's Vercel project (production), via a 0600 file deleted at once."""
    v = infra.get("vercel") or {}
    if not v.get("project"): return {}, None
    where = f"its Vercel project {v['project']} (production)"
    d = private_dir(); f = os.path.join(d, ".env.pull")
    try:
        a = ["vercel", "env", "pull", f, "--yes", "--environment=production", "--project", v["project"]] + (["--scope", v["team"]] if v.get("team") else [])
        cwd = os.path.join(ROOT, "build", app_id); cwd = cwd if os.path.isdir(cwd) else ROOT
        try: subprocess.run(a, cwd=cwd, capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.TimeoutExpired): return {}, where
        if not os.path.exists(f): return {}, where
        os.chmod(f, 0o600)
        return parse_env(open(f).read(), names), where
    finally: shutil.rmtree(d, ignore_errors=True)

def from_server(app_id, app, infra, names):
    """The names' values from the master env file on the application's own server, over SSH; only those lines."""
    if infra.get("target") != "vm_remote": return {}, None
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")); import vm_remote
    ds_p = os.path.join(ROOT, "state", "application", app_id, "datastores.json")
    S = vm_remote.settings(app_id, app, infra, load(ds_p) if os.path.exists(ds_p) else {})
    where = f"the env file on its server ({S['env_file']})"
    if not (S.get("host_shown") and S.get("key_ref")): return {}, where
    pat = "|".join(re.escape(n) for n in sorted(names))
    remote = f"{S['sudo']}grep -E '^(export )?({pat})=' {shlex.quote(S['env_file'])} || true"
    try: r = subprocess.run(vm_remote.ssh_argv(S, remote), capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired): return {}, where
    return (parse_env(r.stdout, names) if r.returncode == 0 else {}), where

def google_client(app_id, app, infra, environ=None, sources=None):
    """-> (builder env {AGENT_CLI_GOOGLE_*: value}, missing [names], places [str]). Values are never printed."""
    names = google_names(infra); want = set(names.values()); environ = os.environ if environ is None else environ
    got = {n: environ[n].strip() for n in want if (environ.get(n) or "").strip()}; places = ["this machine's environment"]
    for src in (sources if sources is not None else (lambda: from_vercel(app_id, infra, want - set(got)), lambda: from_server(app_id, app, infra, want - set(got)))):
        if want <= set(got): break
        vals, where = src()
        if where: places.append(where)
        for k, v in vals.items(): got.setdefault(k, v)
    env = {GOOGLE_BUILD[role]: got[n] for role, n in names.items() if n in got}
    return env, [n for n in names.values() if n not in got], places

def build(app_id, version=None, email_only=False):
    app, infra, _, cli = docs(app_id)
    if app.get("status") == "reverted": sys.exit(f"{app_id} is reverted (a test lane failed); its package is not built until the lanes pass")
    src = os.path.join(ROOT, "build", app_id)
    if not os.path.exists(os.path.join(src, "scripts", "build-agent-cli.mjs")):
        sys.exit(f"build/{app_id}/ has no scripts/build-agent-cli.mjs. Rebuild it from the current mold: "
                 f"python3 .claude/scripts/branding.py apply {app_id} && python3 .claude/scripts/packs.py apply {app_id}")
    version = version or next_version(registry_latest(cli))
    if not SEMVER.match(version): sys.exit(f"--version {version!r} is not X.Y.Z")
    # Never inherited from this shell: the builder gets exactly the client found for THIS application, or none.
    env = {k: v for k, v in os.environ.items() if k not in set(GOOGLE_BUILD.values()) | set(GOOGLE_REFS.values()) | {"AGENT_CLI_EMAIL_SIGN_IN_ONLY"}}
    flags = []
    if email_only: flags.append("--email-sign-in-only")
    else:
        google, missing, places = google_client(app_id, app, infra)
        if missing:
            print(f"{app_id}: the package needs the application's Google sign-in client, and {' and '.join(missing)} "
                  f"{'is' if len(missing) == 1 else 'are'} not set. Looked in: {'; '.join(places)}.\n"
                  f"Set {'it' if len(missing) == 1 else 'them'} where the application keeps its secrets (the Google Cloud console, "
                  f"APIs & Services > Credentials, the \"Desktop app\" OAuth client of the project the application signs in with), "
                  f"or build without Google sign-in: agent_cli.py {app_id} build --email-sign-in-only", file=sys.stderr)
            sys.exit(NEEDS_HUMAN)
        env.update(google)
    out = os.path.join(ROOT, "build", app_id + ".agent-cli")
    if os.path.isdir(out): shutil.rmtree(out)
    r = subprocess.run(["node", "scripts/build-agent-cli.mjs", "--name", cli["package"], "--version", version,
                        "--origin", origin_of(infra), "--out", out, *flags], cwd=src, capture_output=True, text=True, env=env)
    if r.returncode:
        said = r.stdout + r.stderr
        for v in env.get(GOOGLE_BUILD["cli_client_secret_ref"]), env.get(GOOGLE_BUILD["cli_client_id_ref"]):
            if v: said = said.replace(v, "<hidden>")
        print(said.strip(), file=sys.stderr); sys.exit("the mold's builder refused; nothing was published")
    p = subprocess.run(["npm", "pack", "--json", "--pack-destination", out], cwd=out, capture_output=True, text=True)
    if p.returncode: print(p.stderr.strip(), file=sys.stderr); sys.exit("npm pack failed")
    info = json.loads(p.stdout)[0]; files = sorted(f["path"] for f in info["files"])
    bad = disallowed(files)
    if bad: sys.exit("the package contains files the factory does not expect in a public package: " + ", ".join(bad))
    tgz = os.path.join(out, info["filename"]); sha = hashlib.sha256(open(tgz, "rb").read()).hexdigest()
    print(f"{cli['package']}@{version} for {origin_of(infra)}: {len(files)} files, {info['size']} bytes packed, sha256 {sha[:16]}…")
    print(f"  sign-in: {'emailed code only (built without Google)' if email_only else 'Google (the application client, from its settings) and emailed code'}")
    for f in files: print("  ", f)
    return dict(version=version, sha256=sha, tgz=tgz, out=out)

def signed_in(cli, env, npmrc=None):
    a = ["npm", "whoami", "--registry", cli.get("registry", "https://registry.npmjs.org/")] + (["--userconfig", npmrc] if npmrc else [])
    r = subprocess.run(a, capture_output=True, text=True, env=env)
    return r.stdout.strip() if r.returncode == 0 else None

def auth(cli):
    """-> (env, npmrc path or None, who). Token by NAME if the environment has it, else this machine's npm sign-in."""
    name = cli.get("token_ref", "NPM_TOKEN"); env = dict(os.environ)
    if env.get(name):
        d = os.environ.get("CLAUDE_JOB_DIR"); d = os.path.join(d, "tmp") if d else tempfile.mkdtemp()
        rc = os.path.join(d, f".npmrc.{os.getpid()}")
        fd = os.open(rc, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, npmrc_lines(cli.get("registry", "https://registry.npmjs.org/"), name).encode()); os.close(fd)
        return env, rc, signed_in(cli, env, rc)
    return env, None, signed_in(cli, env)

def status(app_id):
    _, infra, _, cli = docs(app_id); env, rc, who = auth(cli)
    print(f"package    {cli['package']} ({cli['access']})")
    print(f"address    {origin_of(infra)}")
    print(f"registry   {registry_latest(cli) or 'never published'}")
    print(f"recorded   {json.dumps(cli.get('published')) if cli.get('published') else 'nothing recorded'}")
    print(f"npm        {'signed in as ' + who if who else 'not signed in on this machine (no ' + cli.get('token_ref', 'NPM_TOKEN') + ' in the environment, no npm login)'}")
    app = load(os.path.join(ROOT, "state", "application", app_id, "application.json"))
    _, missing, places = google_client(app_id, app, infra)
    names = list(google_names(infra).values())
    print(f"google     {'client found (' + ', '.join(names) + ')' if not missing else 'missing ' + ', '.join(missing) + ' (looked in: ' + '; '.join(places) + ')'}")
    if rc: os.unlink(rc)
    return 0

def publish(app_id, version=None, dry=False, email_only=False):
    app, infra, infra_p, cli = docs(app_id)
    env, rc, who = auth(cli)
    try:
        if not who and not dry:
            sys.exit(f"this machine is not signed in to npm, so nothing was built or published. Either run `npm login` here "
                     f"(it prints a link to open) or put a publish token in the environment under the name {cli.get('token_ref', 'NPM_TOKEN')}.")
        b = build(app_id, version, email_only)
        a = ["npm", "publish", b["tgz"], "--access", cli["access"], "--registry", cli.get("registry", "https://registry.npmjs.org/")]
        if rc: a += ["--userconfig", rc]
        if dry: a.append("--dry-run")
        r = subprocess.run(a, cwd=b["out"], env=env)   # npm's own output (it may print a link to approve) goes straight to the terminal
        if r.returncode: sys.exit("npm publish did not succeed; nothing was recorded")
        if dry: print("dry run: nothing was published or recorded"); return 0
        cli["published"] = dict(version=b["version"], at=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                sha256=b["sha256"], mold_commit=mold_commit(app), origin=origin_of(infra))
        json.dump(infra, open(infra_p, "w"), indent=2); open(infra_p, "a").write("\n")
        print(f"published {cli['package']}@{b['version']} as {who}; recorded in state/application/{app_id}/infrastructure.json")
        return 0
    finally:
        if rc and os.path.exists(rc): os.unlink(rc)

def self_test():
    assert next_version(None) == "0.1.0" and next_version("0.1.0") == "0.1.1" and next_version("1.9.41") == "1.9.42"
    try: next_version("1.0.0-beta"); raise AssertionError("a prerelease must be refused")
    except ValueError: pass
    ok = ["package.json", "README.md", "dm.md", "deployment.generated.mjs", "agent-cli.mjs", "agent-install-skill.mjs", "skills/research-workspace-setup/SKILL.md"]
    assert disallowed(ok) == []
    assert disallowed(["cli.mjs", "Agent-cli.mjs", "lib/agent-cli.mjs"]) == ["cli.mjs", "Agent-cli.mjs", "lib/agent-cli.mjs"]
    assert disallowed(ok + [".env", "schemas/kpi-spec.md", "skills/../x", ".npmrc"]) == [".env", "schemas/kpi-spec.md", "skills/../x", ".npmrc"]
    assert ".env" in disallowed([".env"]) and "agent/subagents/x/schemas/kpi-spec.md" in disallowed(["agent/subagents/x/schemas/kpi-spec.md"])
    rc = npmrc_lines("https://registry.npmjs.org/", "NPM_TOKEN")
    assert "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n" in rc and "npm_" not in rc
    vr = {"target": "vm_remote", "deployed_at": "2026-10-04T00:00:00+00:00", "vm_remote": {"domain": "app.example.com", "production_url": "https://app.example.com/"}}
    assert origin_of(vr) == "https://app.example.com" and origin_of({"target": "vercel", "vercel": {"production_url": "https://x.vercel.app/"}}) == "https://x.vercel.app"
    for bad in (dict(vr, deployed_at=None), dict(vr, vm_remote={"domain": "app.example.com"}), dict(vr, vm_remote={"domain": "app.example.com", "production_url": "https://elsewhere.example.com"})):
        try: origin_of(bad); raise AssertionError("an address no deploy recorded must not be baked into a package")
        except SystemExit: pass
    # Google sign-in: names, sources and hand-over, with no machine and no value outside this test.
    fake_id, fake_secret = "1-" + "a" * 24 + ".apps.googleusercontent.com", "s" * 28
    assert google_names({}) == {"cli_client_id_ref": "WORKSPACE_OAUTH_CLIENT_ID", "cli_client_secret_ref": "WORKSPACE_OAUTH_CLIENT_SECRET"}
    assert google_names({"google": {"cli_client_secret_ref": "MY_SECRET"}})["cli_client_secret_ref"] == "MY_SECRET"
    assert parse_env('A=1\nWORKSPACE_OAUTH_CLIENT_ID="x"\nexport WORKSPACE_OAUTH_CLIENT_SECRET=[SENSITIVE]\n# B=2', {"WORKSPACE_OAUTH_CLIENT_ID", "WORKSPACE_OAUTH_CLIENT_SECRET", "B"}) == {"WORKSPACE_OAUTH_CLIENT_ID": "x"}
    both = {"WORKSPACE_OAUTH_CLIENT_ID": fake_id, "WORKSPACE_OAUTH_CLIENT_SECRET": fake_secret}
    env, missing, _ = google_client("x", {}, {}, environ=both, sources=[lambda: (_ for _ in ()).throw(AssertionError("found here; no remote read"))])
    assert env == {"AGENT_CLI_GOOGLE_CLIENT_ID": fake_id, "AGENT_CLI_GOOGLE_CLIENT_SECRET": fake_secret} and missing == []
    env, missing, places = google_client("x", {}, {}, environ={"WORKSPACE_OAUTH_CLIENT_ID": fake_id}, sources=[lambda: ({"WORKSPACE_OAUTH_CLIENT_SECRET": fake_secret}, "its Vercel project p (production)")])
    assert env["AGENT_CLI_GOOGLE_CLIENT_SECRET"] == fake_secret and missing == [] and places[-1] == "its Vercel project p (production)"
    env, missing, places = google_client("x", {}, {}, environ={}, sources=[lambda: ({}, "its Vercel project p (production)"), lambda: ({}, None)])
    assert env == {} and missing == ["WORKSPACE_OAUTH_CLIENT_ID", "WORKSPACE_OAUTH_CLIENT_SECRET"] and len(places) == 2
    assert from_server("x", {}, {"target": "vercel"}, {"A"}) == ({}, None) and from_vercel("x", {"target": "vm_remote"}, {"A"}) == ({}, None)
    print("agent_cli: 20 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    if len(a) < 2 or a[1] not in ("status", "build", "publish"): sys.exit(__doc__)
    version = a[a.index("--version") + 1] if "--version" in a and a.index("--version") + 1 < len(a) else None
    if a[1] == "status": return status(a[0])
    if a[1] == "build": build(a[0], version, "--email-sign-in-only" in a); return 0
    return publish(a[0], version, "--dry-run" in a, "--email-sign-in-only" in a)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
