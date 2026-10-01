#!/usr/bin/env python3
"""agent_cli.py <app_id> status | build | publish [--version X.Y.Z] [--dry-run]   |   --self-test

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
"""
import datetime, hashlib, json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# What a built package may contain. Anything else means the mold's builder changed and someone should look
# before it goes to a public registry.
ALLOWED = [re.compile(p) for p in (
    r"^package\.json$", r"^README\.md$", r"^dm\.md$", r"^deployment\.generated\.mjs$",
    # fde-*.mjs: the file names the mold's own setup/ package ships (upstream fde-agent), not factory vocabulary.
    r"^fde-[a-z-]+\.mjs$", r"^skills/[a-z][a-z0-9-]*/[A-Za-z0-9_./-]+$",
)]
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

def load(p): return json.load(open(p))

def docs(app_id):
    d = os.path.join(ROOT, "state", "application", app_id)
    if not os.path.isdir(d): sys.exit(f"{app_id}: no state/application/{app_id}/")
    app = load(os.path.join(d, "application.json")); infra_p = os.path.join(d, "infrastructure.json"); infra = load(infra_p)
    cli = infra.get("agent_cli")
    if not cli: sys.exit(f"{app_id}: infrastructure.json has no \"agent_cli\" (package, access); nothing to build")
    return app, infra, infra_p, cli

def origin_of(infra):
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

def build(app_id, version=None):
    app, infra, _, cli = docs(app_id)
    if app.get("status") == "reverted": sys.exit(f"{app_id} is reverted (a test lane failed); its package is not built until the lanes pass")
    src = os.path.join(ROOT, "build", app_id)
    if not os.path.exists(os.path.join(src, "scripts", "build-agent-cli.mjs")):
        sys.exit(f"build/{app_id}/ has no scripts/build-agent-cli.mjs. Rebuild it from the current mold: "
                 f"python3 .claude/scripts/branding.py apply {app_id} && python3 .claude/scripts/packs.py apply {app_id}")
    version = version or next_version(registry_latest(cli))
    if not SEMVER.match(version): sys.exit(f"--version {version!r} is not X.Y.Z")
    out = os.path.join(ROOT, "build", app_id + ".agent-cli")
    if os.path.isdir(out): shutil.rmtree(out)
    r = subprocess.run(["node", "scripts/build-agent-cli.mjs", "--name", cli["package"], "--version", version,
                        "--origin", origin_of(infra), "--out", out], cwd=src, capture_output=True, text=True)
    if r.returncode: print((r.stdout + r.stderr).strip(), file=sys.stderr); sys.exit("the mold's builder refused; nothing was published")
    p = subprocess.run(["npm", "pack", "--json", "--pack-destination", out], cwd=out, capture_output=True, text=True)
    if p.returncode: print(p.stderr.strip(), file=sys.stderr); sys.exit("npm pack failed")
    info = json.loads(p.stdout)[0]; files = sorted(f["path"] for f in info["files"])
    bad = disallowed(files)
    if bad: sys.exit("the package contains files the factory does not expect in a public package: " + ", ".join(bad))
    tgz = os.path.join(out, info["filename"]); sha = hashlib.sha256(open(tgz, "rb").read()).hexdigest()
    print(f"{cli['package']}@{version} for {origin_of(infra)}: {len(files)} files, {info['size']} bytes packed, sha256 {sha[:16]}…")
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
    if rc: os.unlink(rc)
    return 0

def publish(app_id, version=None, dry=False):
    app, infra, infra_p, cli = docs(app_id)
    env, rc, who = auth(cli)
    try:
        if not who and not dry:
            sys.exit(f"this machine is not signed in to npm, so nothing was built or published. Either run `npm login` here "
                     f"(it prints a link to open) or put a publish token in the environment under the name {cli.get('token_ref', 'NPM_TOKEN')}.")
        b = build(app_id, version)
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
    ok = ["package.json", "README.md", "dm.md", "deployment.generated.mjs", "fde-cli.mjs", "fde-install-skill.mjs", "skills/research-workspace-setup/SKILL.md"]
    assert disallowed(ok) == []
    assert disallowed(ok + [".env", "schemas/kpi-spec.md", "skills/../x", ".npmrc"]) == [".env", "schemas/kpi-spec.md", "skills/../x", ".npmrc"]
    assert ".env" in disallowed([".env"]) and "agent/subagents/x/schemas/kpi-spec.md" in disallowed(["agent/subagents/x/schemas/kpi-spec.md"])
    rc = npmrc_lines("https://registry.npmjs.org/", "NPM_TOKEN")
    assert "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n" in rc and "npm_" not in rc
    print("agent_cli: 8 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    if len(a) < 2 or a[1] not in ("status", "build", "publish"): sys.exit(__doc__)
    version = a[a.index("--version") + 1] if "--version" in a and a.index("--version") + 1 < len(a) else None
    if a[1] == "status": return status(a[0])
    if a[1] == "build": build(a[0], version); return 0
    return publish(a[0], version, "--dry-run" in a)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
