#!/usr/bin/env python3
"""Provision: validated application state -> running deployment.

  provision.py <app_id> [--check] [--deploy] [--set-secret NAME] [--verify-db]

--check (default): verify every secret named in infrastructure.json exists in the
  secret store (Vercel env for vercel_env; infra/vm/apps/<app_id>/.env for vm_env_file),
  regenerate the app's local artifact, print what is missing. Never deploys.
--deploy: run the deploy for the target. Refuses if any secret is missing.
--verify-db: stand up this app's LOCAL database (private docker network, no host port) and run
  the whole mold chain against it — push, migrate, RLS + app_rw bootstrap, task-workflow — then
  prove the resulting URL is app_rw/NOBYPASSRLS/policied/encrypted. Touches nothing remote.

ONE COMMITTED DEPLOY TARGET: vercel. `target: vm` is a LOCAL VERIFICATION target — it generates
the app's datastore artifact and runs the lanes against it; it does not serve the application.
See infra/vm/README.md for why (three deployables, four crons and a Vercel-injected OIDC identity
the mold cannot get off Vercel without a fork, which HARD RULE 1 forbids).

DATABASE: the free path is Neon on the Vercel Marketplace. Supabase's free tier is exhausted;
Neon's is not, and an unattached Neon resource already sits on this team, so app #2 costs nothing.
`self_hosted` means a Postgres on a PRIVATE docker network with no host port — never a public one.
"""
import json, os, re, sys, subprocess, datetime, shutil, tempfile, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state"); TODAY = datetime.date.today().isoformat()
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
def sh(cmd, cwd=None, check=True):
    r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode: sys.exit(f"$ {cmd}\n{r.stdout}{r.stderr}")
    return r.stdout

def vercel_env_names(cwd, project):
    out = sh(f"vercel env ls production --project {project} 2>/dev/null", cwd=cwd, check=False)
    return {l.split()[0] for l in out.splitlines() if l.strip() and l.split()[0].isupper()}

GENERATED = {  # app-internal secrets the factory may mint itself (never external credentials)
  "CRON_SECRET": "openssl rand -hex 32",
  "OPS_SECRETS_KEY": "openssl rand -hex 32",
}
REDACTED = "[SENSITIVE]"   # what `vercel env pull` writes for a write-only variable
def _env_api(project, path, method, body, cwd):
    """Vercel API call with the body on stdin, so secret values never reach argv or a file."""
    return subprocess.run(["vercel", "api", path, "-X", method, "--input", "-", "--raw"], cwd=cwd,
                          input=json.dumps(body), capture_output=True, text=True)

def _env_entries(project, cwd):
    r = subprocess.run(f"vercel api /v9/projects/{project}/env --raw", shell=True, cwd=cwd, capture_output=True, text=True)
    try: return json.loads(r.stdout).get("envs", [])
    except Exception: return []

def _set_env(name, value, cwd, project=None):
    """Create or replace a production value, as `encrypted`.

    Two platform behaviours force this shape. A variable the CLI's `env add` creates is `sensitive`:
    write-only, so `env pull` returns the literal [SENSITIVE] and any later copy of it is garbage.
    And PATCHing a sensitive entry succeeds while changing nothing, which once left DATABASE_URL and
    TASK_WORKFLOW_SERVICE_URL pointing at the wrong place through an entire deploy. Encrypted entries
    can be read back, so a later run can verify them."""
    if value is None or value == "" or value == REDACTED:
        sys.exit(f"refusing to write {name} on {project}: value is empty or redacted")
    project = project or load(os.path.join(cwd, ".vercel/project.json"))["projectId"]
    subprocess.run(f"vercel env rm {name} production --project {project} --yes", shell=True, cwd=cwd, capture_output=True, text=True)   # API DELETE refuses without a confirmation flag
    r = _env_api(project, f"/v10/projects/{project}/env", "POST", {"key": name, "value": value, "type": "encrypted", "target": ["production"]}, cwd)
    if '"error"' in r.stdout or r.returncode: sys.exit(f"could not set {name} on {project}: {(r.stdout + r.stderr).strip()[-200:]}")
    got = [e for e in _env_entries(project, cwd) if e.get("key") == name and "production" in (e.get("target") or [])]
    if not got: sys.exit(f"could not set {name} on {project}: it is absent on readback")
    if any(e.get("type") == "sensitive" for e in got):
        sys.exit(f"could not set {name} on {project}: stored as `sensitive`, so it can never be read back. "
                 "Turn off Team Settings -> Environment Variables -> Sensitive Environment Variables, then rerun.")

def _add_env(name, value, cwd, project):
    """Set only when absent (mints and derived defaults)."""
    if name in vercel_env_names(cwd, project): return
    _set_env(name, value, cwd, project=project)

# The env var whose presence means "this app already has a database".
# This used to be the literal "SUPABASE_URL" for every app — a name that appears NOWHERE in the mold
# codebase (grep over ts/tsx/mjs/js finds nothing), yet intake wrote it into secrets_derived and
# main() blocked the deploy on it. A non-Supabase app could therefore never satisfy the gate and
# could never deploy. The sentinel is now whatever that provider actually injects.
DB_SENTINEL = {"supabase": "SUPABASE_URL", "neon": "DATABASE_URL_UNPOOLED",
               "rds": "DATABASE_URL", "self_hosted": "POSTGRES_ADMIN_URL"}
ADMIN_KEYS = ("SUPABASE_POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "POSTGRES_ADMIN_URL", "DATABASE_URL")

def admin_url(vals):
    """The URL that owns the schema, whichever provider named it.

    DATABASE_URL is deliberately last: after bootstrap_database it is app_rw, which owns no table and
    cannot run DDL. Two copies of this chain used to be hardcoded (run_migrations, deploy_vercel) and
    both knew only Supabase's name for it."""
    return next((vals[k] for k in ADMIN_KEYS if vals.get(k)), "")

def _link_dir(project, mold_dir):
    """A throwaway directory linked to `project`, for CLI commands that act on 'the current project'.
    The mold directory is shared by every agent and is linked to a DIFFERENT app; relinking it would
    point another step at the wrong project, and `vercel integration add` has no --project flag."""
    meta = _project_meta(project, mold_dir)
    if not meta.get("id"): return None
    d = tempfile.mkdtemp(prefix="vercel-link-"); os.makedirs(os.path.join(d, ".vercel"))
    json.dump({"projectId": meta["id"], "orgId": meta.get("accountId"), "projectName": project},
              open(os.path.join(d, ".vercel/project.json"), "w"))
    return d

def ensure_projects(proj, mold_dir):
    """Create this app's three Vercel projects before anything writes to them.

    deploy_vercel's first act is _set_env(..., project=f'{proj}-api'), and the API answers 404 for a
    project that does not exist — so a first deploy of a NEW app could never start. The two projects
    that exist today were created by other means, which is why nobody had hit this."""
    for p in (proj, f"{proj}-api", f"{proj}-workflow"):
        if _project_meta(p, mold_dir).get("id"): continue
        r = subprocess.run(f"vercel project add {p}", shell=True, cwd=mold_dir, capture_output=True, text=True)
        if not _project_meta(p, mold_dir).get("id"):
            sys.exit(f"could not create the Vercel project {p}: " + (r.stdout + r.stderr).strip()[-200:])
        print(f"  created Vercel project {p}")

def _neon_spares(mold_dir):
    """Every Neon resource on this team that is available and attached to no project."""
    r = subprocess.run("vercel integration list --all --json", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: res = json.loads(r.stdout[r.stdout.index("{"):]).get("resources", [])
    except Exception: res = []
    return [x["name"] for x in res if x.get("product") == "Neon" and x.get("status") == "available" and not x.get("projects")]

def _db_stat(mold_dir, proj, key="DATABASE_URL_UNPOOLED"):
    """{tables, policies, size} of the database a project's env points at, or None."""
    vals = pull_env(mold_dir, proj)
    url = vals.get(key) or vals.get("DATABASE_URL")
    if not url: return None
    r = _node_lib(os.path.join(ROOT, ".claude/scripts/lib/db-tables.mjs"), {"DB_URL": url}, mold_dir)
    try: return json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
    except Exception: return None

def adopt_or_create_neon(app_id, mold_dir, infra, proj):
    """A free Postgres for this app, with no checkout page.

    Vercel keeps a Marketplace resource on its plan whether or not a project uses it, so the cheapest
    database is one the team already owns and nothing is attached to. Adopt that first; only ask the
    Marketplace for a new one when there is none. This is the whole reason a second app is free:
    Supabase's free tier is exhausted, Neon's is not.

    UNATTACHED IS NOT EMPTY. The first spare on this team held 15 MB and 54 tables of an older copy of
    this very schema; pushing onto it made drizzle-kit ask an interactive rename question and abort.
    `scope: fresh` means fresh, so an adopted database is connected, INSPECTED, and disconnected again
    unless it is empty. The factory never writes over data it did not create."""
    for name in _neon_spares(mold_dir):
        print(f"trying the free Neon database '{name}' (attached to no project) ...")
        c = subprocess.run(f"vercel integration-resource connect {name} {proj} -e production -e preview -e development --yes",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
        if c.returncode:
            print("  could not connect it: " + (c.stdout + c.stderr).strip().splitlines()[-1][:160]); continue
        st = _db_stat(mold_dir, proj)
        if st and st.get("tables") == 0:
            print(f"  adopted {name}: empty database, free plan, no checkout")
            infra.setdefault("datastores", {})["neon_resource"] = name
            return
        print(f"  {name} already holds {(st or {}).get('tables','?')} table(s) ({(st or {}).get('size','?')}) — "
              f"not overwriting it; disconnecting and asking for a new one")
        subprocess.run(f"vercel integration-resource disconnect {name} {proj} --yes", shell=True, cwd=mold_dir, capture_output=True, text=True)
    print(f"provisioning a fresh Neon database '{app_id}' via Vercel Marketplace (Free plan) ...")
    urls = os.path.expanduser("~/.factory-open-urls"); open(urls, "w").close()   # the xdg-open shim (infra/vm/provision.sh) records links a CLI tried to open
    res_name = app_id.replace("_", "-")                                          # resource names are dns-ish
    d = _link_dir(proj, mold_dir)
    try:
        r = subprocess.run(f"vercel integration add neon -n {res_name} --no-claim --no-env-pull -e production -e preview -e development"
                           + (f" --cwd {d}" if d else ""), shell=True, cwd=mold_dir, capture_output=True, text=True)
    finally:
        if d: shutil.rmtree(d, ignore_errors=True)
    out = r.stdout + r.stderr; link_ = next((l.strip() for l in open(urls) if l.strip()), None)
    if "Additional setup required" in out or link_:
        sys.exit("ONE-TIME STEP: open this link in a browser, accept the Neon FREE plan for this project, then run the same command again:\n  "
                 + (link_ or f"https://vercel.com/{infra['vercel']['team']}/~/integrations/checkout/neon?productSlug=neon&defaultResourceName={res_name}&source=cli&projectSlug={proj}"))
    if r.returncode:
        msg = [l for l in out.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
        sys.exit("neon provisioning failed: " + " | ".join(msg[-3:]))
    print("  " + next((l for l in out.splitlines() if "provisioned" in l), "provisioned").strip()[:160])
    # `integration add` connects to the project linked in its cwd; make the attachment explicit either way
    subprocess.run(f"vercel integration-resource connect {res_name} {proj} -e production -e preview -e development --yes",
                   shell=True, cwd=mold_dir, capture_output=True, text=True)
    st = _db_stat(mold_dir, proj)
    if not st: sys.exit(f"Neon resource {res_name} was created but {proj} has no DATABASE_URL_UNPOOLED; connect it in the dashboard and rerun.")
    if st.get("tables"): sys.exit(f"the new Neon database is not empty ({st['tables']} tables) — refusing to write over it")
    infra.setdefault("datastores", {})["neon_resource"] = res_name

def _blob_store(name, mold_dir):
    """The team's Blob store of this name, with the projects it is connected to, or None."""
    r = subprocess.run("vercel api /v1/storage/stores --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: st = json.loads(r.stdout).get("stores", [])
    except Exception: st = []
    return next((x for x in st if x.get("type") == "blob" and x.get("name") == name), None)

def _connect_store(store_id, project_id, mold_dir):
    """Attach an existing store to a project, which is what injects its token into that project's env.
    Same endpoint the CLI's own create path uses (connectResourceToProject in the Vercel CLI)."""
    return subprocess.run(["vercel", "api", f"/v1/storage/stores/{store_id}/connections", "-X", "POST", "--input", "-", "--raw"],
                          cwd=mold_dir, capture_output=True, text=True,
                          input=json.dumps({"envVarEnvironments": ["production", "preview", "development"],
                                            "projectId": project_id, "type": "integration"}))

def _cli_err(out):
    """The line a human needs out of a CLI transcript: its `Error:` line, else the last thing it said."""
    return next((l.strip() for l in out.splitlines() if l.strip().startswith("Error")),
                (out.strip().splitlines() or ["the CLI reported nothing"])[-1].strip())

def ensure_blob_store(app_id, mold_dir, infra, proj):
    """A private Blob store CONNECTED TO THIS APP'S PROJECT — the connection is what injects
    BLOB_READ_WRITE_TOKEN, and nothing else in the factory can supply that name.

    `vercel blob create-store` attaches the new store to the project linked in its WORKING DIRECTORY.
    This ran in the mold directory, which is linked to a different app, so the store was created
    attached to nothing, the app's project never received BLOB_READ_WRITE_TOKEN, and --deploy refused
    for ever on a derived secret that no command could produce — the same dead end as the phantom
    SUPABASE_URL gate, one function away from the fix Neon already uses. So: run it in a throwaway link
    dir of THIS app's project, and never leave the run unverified.

    Re-running is idempotent: a second create answers `A blob store named "x" already exists. (409)`
    and still EXITS 0, so the returncode says nothing — the store is looked up by name and connected."""
    name = app_id.replace("_", "-")
    print(f"creating Vercel Blob store '{name}' and connecting it to {proj} ...")
    meta = _project_meta(proj, mold_dir)
    if not meta.get("id"): sys.exit(f"the Vercel project {proj} does not exist yet; rerun --check")
    d = _link_dir(proj, mold_dir)
    try:
        r = subprocess.run(f"vercel blob create-store {name} --access private -e production -e preview -e development --yes --cwd {d}",
                           shell=True, cwd=mold_dir, capture_output=True, text=True)
        out = r.stdout + r.stderr
    finally:
        shutil.rmtree(d, ignore_errors=True)   # `create-store` pulls env into its cwd; it must not be the mold
    if "already exists" in out:
        st = _blob_store(name, mold_dir)
        if not st: sys.exit(f"a Blob store named {name} exists on this team but could not be read back; delete it in the dashboard and rerun")
        # `projectId` is the project; `id` on a connection entry is the connection's own id, not the project's
        if any(c.get("projectId") == meta["id"] for c in (st.get("projectsMetadata") or [])):
            print(f"  {name} was already connected to {proj}")
        else:
            c = _connect_store(st["id"], meta["id"], mold_dir)
            bad = '"error"' in c.stdout or c.returncode
            print("  " + (_cli_err(c.stdout + c.stderr)[:160] if bad else f"connected the existing store {name} to {proj}"))
    elif "Success" in out: print("  " + next((l.strip() for l in out.splitlines() if "created" in l.lower()), "created")[:160])
    else: print("  " + _cli_err(out)[:160])                    # neither created nor pre-existing
    infra.setdefault("datastores", {})["blob_store"] = name
    if "BLOB_READ_WRITE_TOKEN" not in vercel_env_names(mold_dir, proj):
        st = _blob_store(name, mold_dir)
        if not st:
            sys.exit(f"could not create the Blob store {name}: {_cli_err(out)[:200]}\n"
                     f"Fix that and rerun: python3 .claude/scripts/provision.py {app_id} --check")
        sys.exit(f"the Blob store {name} exists but {proj} still has no BLOB_READ_WRITE_TOKEN. Run this one command, then rerun:\n"
                 f"  vercel api /v1/storage/stores/{(st or {}).get('id','<store id>')}/connections -X POST --raw "
                 f"""--input - <<< '{{"envVarEnvironments":["production","preview","development"],"projectId":"{meta['id']}","type":"integration"}}'""")
    print(f"  BLOB_READ_WRITE_TOKEN injected into {proj}")

def provision_datastores(app_id, ds, mold_dir, present, infra, proj):
    """Fresh datastores via Vercel Marketplace, inside the app's own project. Returns names now present."""
    pg, blob = ds.get("postgres", {}), ds.get("blob", {})
    prov = pg.get("provider", "supabase")
    if pg.get("scope") == "fresh" and prov == "neon" and DB_SENTINEL["neon"] not in present:
        adopt_or_create_neon(app_id, mold_dir, infra, proj)
    elif pg.get("scope") == "fresh" and prov not in ("supabase", "neon"):
        sys.exit(f"datastores.postgres.provider={prov!r} has no provisioner for target=vercel. "
                 f'Set it to "neon" (free) in state/application/{app_id}/datastores.json and rerun.')
    if pg.get("scope") == "fresh" and prov == "supabase" and DB_SENTINEL["supabase"] not in present:
        print(f"provisioning fresh Supabase project '{app_id}' via Vercel Marketplace ...")
        urls = os.path.expanduser("~/.factory-open-urls"); open(urls, "w").close()   # the xdg-open shim (infra/vm/provision.sh) records links a CLI tried to open
        r = subprocess.run(f"vercel integration add supabase -n {app_id} --prefix SUPABASE_ --no-claim --no-env-pull -e production -e preview -e development", shell=True, cwd=mold_dir, capture_output=True, text=True)
        out = r.stdout + r.stderr; link_ = next((l.strip() for l in open(urls) if l.strip()), None)
        if "Additional setup required" in out or link_:
            sys.exit("ONE-TIME STEP: open this link in a browser, accept the Supabase plan for this project, then run the same command again:\n  " + (link_ or f"https://vercel.com/{infra['vercel']['team']}/~/integrations/checkout/supabase?productSlug=supabase&defaultResourceName={app_id}&source=cli&projectSlug={infra['vercel']['project']}"))
        if r.returncode:
            msg = [l for l in out.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
            sys.exit("supabase provisioning failed: " + " | ".join(msg[-3:]))
        print("  " + (out.strip().splitlines() or ["ok"])[-1])
        infra.setdefault("datastores", {})["supabase_resource"] = app_id
    if blob.get("provider") == "vercel_blob" and "BLOB_READ_WRITE_TOKEN" not in present:
        ensure_blob_store(app_id, mold_dir, infra, proj)
    present = vercel_env_names(mold_dir, proj)
    for name, cmd in GENERATED.items():
        if name not in present:
            _add_env(name, subprocess.check_output(cmd, shell=True, text=True).strip(), mold_dir, proj); print(f"generated {name}")
    if "AUTH_JWT_PRIVATE_KEY" not in present:
        js = ("const{generateKeyPairSync}=require('crypto');const{publicKey:a,privateKey:b}=generateKeyPairSync('ec',{namedCurve:'P-256'});"
              "console.log(Buffer.from(b.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log(Buffer.from(a.export({type:'spki',format:'pem'})).toString('base64'))")
        priv, pub = subprocess.check_output(["node", "-e", js], text=True).split()
        _add_env("AUTH_JWT_PRIVATE_KEY", priv, mold_dir, proj); _add_env("AUTH_JWT_PUBLIC_KEY", pub, mold_dir, proj); print("generated AUTH_JWT key pair")
    present = vercel_env_names(mold_dir, proj)
    if "DATABASE_URL" not in present and "SUPABASE_POSTGRES_URL" in present:
        # DATABASE_URL is the app's canonical name for the pooled Postgres URL the integration injected
        tmp = os.path.join(mold_dir, ".env.provision")
        subprocess.run(f"vercel env pull --yes --environment=production --project {proj} {tmp}", shell=True, cwd=mold_dir, capture_output=True)
        val = next((l.split("=",1)[1].strip().strip('"') for l in open(tmp) if l.startswith("SUPABASE_POSTGRES_URL=")), "")
        os.remove(tmp)
        if val: _add_env("DATABASE_URL", val, mold_dir, proj); print("derived DATABASE_URL from SUPABASE_POSTGRES_URL")
    return vercel_env_names(mold_dir, proj)

DEPLOY_TIME = ["TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "NEXT_PUBLIC_EVE_API_URL", "MODEL_PROVIDER"]
API_ENV = ["AUTH_JWT_PUBLIC_KEY", "BLOB_READ_WRITE_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CRON_SECRET", "DATABASE_URL", "OPS_MULTI_TENANT",
           "MODEL_PROVIDER", "OPS_SECRETS_KEY", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "EXA_API_KEY", "BROWSERBASE_API_KEY",
           "ENABLE_WEB_SEARCH", "ENABLE_BROWSER", "GOOGLE_CLIENT_ID"]
WORKFLOW_ENV = ["DATABASE_URL", "TASK_WORKFLOW_SERVICE_TOKEN"]

def pull_env(mold_dir, project):
    tmp = os.path.join(mold_dir, f".env.provision.{project}")
    subprocess.run(f"vercel env pull --yes --environment=production --project {project} {tmp}", shell=True, cwd=mold_dir, capture_output=True)
    vals, unreadable = {}, []
    for l in open(tmp):
        if "=" in l and not l.startswith("#"):
            k, v = l.split("=", 1); k, v = k.strip(), v.strip().strip('"')
            if v == REDACTED: unreadable.append(k); continue    # Sensitive: unreadable, never a value
            vals[k] = v
    os.remove(tmp)
    if not vals: sys.exit(f"could not pull the production environment of {project}")
    if unreadable: print(f"  {project}: {len(unreadable)} sensitive var(s) unreadable: {', '.join(sorted(unreadable))}")
    return vals


def set_framework(project, framework, mold_dir):
    """The eve API and the task-workflow service need different presets (eve / nextjs); auto-detection
    picks Next.js for both and then rejects the eve build output. Verified through the API, whose value
    is the slug (`nextjs`), not the console's display name (`Next.js`)."""
    subprocess.run(f"vercel api /v9/projects/{project} -X PATCH -F framework={framework} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    r = subprocess.run(f"vercel api /v9/projects/{project} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: got = json.loads(r.stdout).get("framework")
    except Exception: got = None
    if got != framework: sys.exit(f"could not set framework={framework} on {project} (reads {got!r})")

def _project_meta(project, mold_dir):
    r = subprocess.run(f"vercel api /v9/projects/{project} --raw", shell=True, cwd=mold_dir, capture_output=True, text=True)
    try: return json.loads(r.stdout)
    except Exception: return {}

def git_link(project, mold_dir):
    """Which git provider, if any, auto-deploys this project. None when nothing does."""
    return (_project_meta(project, mold_dir).get("link") or {}).get("type")

GIT_LINK_MSG = ("{project} is still connected to git ({link}); every push would deploy the factory repo over this app. "
                "Disconnect it (Settings -> Git -> Disconnect) and rerun.")

def disconnect_git(project, mold_dir):
    """A project the CLI creates from inside a git checkout is auto-connected to that repo.
    The mold lives inside the factory repo, so claudecode-web-api/-workflow were linked to
    never2average/software-factory and every push started a PRODUCTION build of the factory
    root: `eve: command not found` (eve preset) / `No Next.js version detected` (nextjs preset).
    14 ERROR production deployments each, and the workflow build overwrites the build cache the
    next CLI deploy restores. Only provision.py may create deployments for a stamped app.

    `vercel git disconnect` acts on the project linked in its working directory, so it runs in a
    throwaway link dir: the mold directory is shared by every agent and must never be relinked."""
    meta = _project_meta(project, mold_dir)
    if not (meta.get("link") or {}).get("type"): return
    d = tempfile.mkdtemp(prefix="vercel-unlink-")
    try:
        os.makedirs(os.path.join(d, ".vercel"))
        json.dump({"projectId": meta.get("id"), "orgId": meta.get("accountId"), "projectName": project},
                  open(os.path.join(d, ".vercel/project.json"), "w"))
        subprocess.run(f"vercel git disconnect --cwd {d}", shell=True, cwd=mold_dir,
                       input="y\n", capture_output=True, text=True)   # the CLI confirms interactively
    finally:
        shutil.rmtree(d, ignore_errors=True)
    link = git_link(project, mold_dir)
    if link: sys.exit(GIT_LINK_MSG.format(project=project, link=link))
    print(f"  {project}: git integration disconnected")

def deploy(cfg, mold_dir):
    """Production deploy from the mold dir; returns the deployment URL. The CLI prints progress on stderr and the URL on stdout, but a build error arrives as JSON, so never trust the last line blindly."""
    r = subprocess.run(f"vercel deploy --prod --yes --local-config {cfg}", shell=True, cwd=mold_dir, capture_output=True, text=True)
    urls = re.findall(r"https://[a-z0-9.-]+\.vercel\.app", r.stdout + r.stderr)
    if r.returncode or not urls: sys.exit(f"deploy with {cfg} failed:\n" + (r.stdout + r.stderr).strip()[-1500:])
    return urls[-1]

def sync_env(names, vals, project, mold_dir):
    have = vercel_env_names(mold_dir, project); n = 0
    # with pull_env dropping [SENSITIVE], vals.get(k) is None for anything unreadable at the source
    blocked = [k for k in names if k not in have and not vals.get(k)]
    if any(k in ("DATABASE_URL", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL") for k in blocked):
        sys.exit(f"{project}: cannot set {', '.join(blocked)} — unreadable (Sensitive) on the source. Recreate as Encrypted and rerun.")
    for k in names:
        if k in have or not vals.get(k): continue
        _set_env(k, vals[k], mold_dir, project=project); n += 1
    blocked = [k for k in blocked if k not in ("EXA_API_KEY", "BROWSERBASE_API_KEY", "GOOGLE_CLIENT_ID")]   # optional
    print(f"  {project}: synced {n} env var(s)" + (f"; unreadable at the source, set once by hand: {', '.join(blocked)}" if blocked else ""))

def _node_lib(script, env, mold_dir):
    """Run one of .claude/scripts/lib/*.mjs against the mold's node_modules WITHOUT putting a file
    inside the mold (HARD RULE 1): ESM resolves a bare import from the script's own directory
    upward, so a temp directory holding a node_modules symlink is enough."""
    d = tempfile.mkdtemp(prefix="factory-lib-")
    try:
        os.symlink(os.path.join(mold_dir, "node_modules"), os.path.join(d, "node_modules"))
        p = os.path.join(d, os.path.basename(script)); shutil.copy(script, p)
        return subprocess.run(["node", p], cwd=d, env=dict(os.environ, **env), capture_output=True, text=True)
    finally: shutil.rmtree(d, ignore_errors=True)

def _verify_app_rw(mold_dir, url):
    """Prove the URL that is ABOUT to become DATABASE_URL really is the restricted role.

    Until now provision.py trusted the mold's own self-test and then deployed a URL it had never
    opened. That is how the live app came to report `role postgres — WARNING: BYPASSRLS, row-level
    security is NOT enforced`. The URL travels in the environment, never in argv: /proc/<pid>/cmdline
    is world-readable."""
    r = _node_lib(os.path.join(ROOT, ".claude/scripts/lib/verify-apprw.mjs"), {"APP_RW_URL": url}, mold_dir)
    line = (r.stdout.strip().splitlines() or [""])[-1]
    if line: print("  app_rw check: " + line)
    if r.returncode: sys.exit("refusing to deploy this DATABASE_URL: " + ((r.stderr.strip().splitlines() or ["verification failed"])[-1])[:300])

def _retarget(app_url, runtime_url):
    """Put the app_rw URL back on the host:port that actually answers, and force TLS.

    .bootstrap-supabase.mjs:206 does `appUrl.port = "6543"` unconditionally — Supavisor's port and
    nobody else's. It is right for Supabase and wrong for Neon, RDS and any self-hosted server, so
    the script writes an unreachable DATABASE_URL and then dies on its own connection test, AFTER
    doing 100% of the security work. Forking the mold is forbidden and bending every provider onto
    port 6543 means publishing a Postgres port, so instead take host:port back from the URL that
    already works. Provider-independent: one seam unblocks neon, rds and self_hosted at once."""
    a, b = urllib.parse.urlsplit(app_url), urllib.parse.urlsplit(runtime_url)
    q = dict(urllib.parse.parse_qsl(a.query)); q["sslmode"] = "require"
    userinfo = a.netloc.rsplit("@", 1)[0] if "@" in a.netloc else ""
    host = b.netloc.rsplit("@", 1)[-1]
    return urllib.parse.urlunsplit((a.scheme, f"{userinfo}@{host}" if userinfo else host, a.path, urllib.parse.urlencode(q), a.fragment))

def bootstrap_database(mold_dir, admin, projects, provider="supabase", runtime_url=""):
    """A fresh Postgres needs what Drizzle does not model: row-level security and the app_rw
    login role (NOBYPASSRLS). The mold ships .bootstrap-supabase.mjs for exactly this; it reads
    .env.supabase, verifies the schema, applies RLS, creates app_rw and writes the app_rw
    connection string into .env.local. Without it the app runs as a BYPASSRLS superuser and the
    task-workflow migration fails on the missing role. Idempotent: re-running rotates the password.

    EVERY provider runs this same script. The tempting alternative for Neon, .setup-app-role.mjs,
    creates the role and grants DML and applies ZERO policies — `grep -n 'ROW LEVEL SECURITY|CREATE
    POLICY' .setup-app-role.mjs` returns nothing — so app #2 would ship with a correctly-restricted
    role guarding an empty policy set: every log line green, no tenant isolation at all.

    Returns the app_rw URL, which becomes DATABASE_URL on every project."""
    envsup = os.path.join(mold_dir, ".env.supabase"); envloc = os.path.join(mold_dir, ".env.local")
    saved = open(envloc).read() if os.path.exists(envloc) else None
    # Reuse the existing app_rw password when one is already deployed. The bootstrap rotates on every
    # run, and a rotation invalidates every deployment built against the old value until it is rebuilt.
    env = dict(os.environ)
    cur = pull_env(mold_dir, projects[0]).get("DATABASE_URL", "")
    m0 = re.match(r"postgres(?:ql)?://app_rw[^:]*:([^@]+)@", cur)
    if m0: env["APP_RW_PASSWORD"] = urllib.parse.unquote(m0.group(1)); print("  reusing the deployed app_rw password (no rotation)")
    try:
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={admin}\n")
        os.chmod(envsup, 0o600)
        r = subprocess.run("node .bootstrap-supabase.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
        raw = r.stdout + r.stderr
        out = [l for l in raw.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
        for l in out:
            if l.startswith(("✓", "✗", "app_rw", "policies", "tables app_rw")): print("  " + l[:150])
        m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(envloc).read(), re.M) if os.path.exists(envloc) else None
        # THE SEAM. The script PERSISTS the app_rw URL before it self-tests — its own comment says
        # "PERSIST BEFORE VERIFYING", because the generated password exists nowhere else. Its self-test
        # then connects to the port it just forced to 6543, so on any provider but Supabase it can only
        # fail there, after every piece of real work has already succeeded. Treat that one shape as a
        # success and re-verify independently below; anything else still exits exactly as before.
        did_work = bool(m) and "DATABASE_URL now points at" in raw
        if r.returncode and not did_work: sys.exit("database bootstrap failed:\n" + "\n".join(out[-12:]))
        if not m: sys.exit("bootstrap did not write an app_rw DATABASE_URL into .env.local")
        app_url = m.group(1)
        if provider != "supabase":
            # Supabase is the one provider that genuinely fronts a different port for runtime pooling.
            app_url = _retarget(app_url, runtime_url or admin)
            if r.returncode: print(f"  bootstrap's own test hit the hardcoded port 6543; retargeted to the {provider} endpoint")
        _verify_app_rw(mold_dir, app_url)
        for pr_ in projects: _set_env("DATABASE_URL", app_url, mold_dir, project=pr_)
        print(f"  DATABASE_URL now points at app_rw on {len(projects)} project(s)")
        return app_url
    finally:
        if os.path.exists(envsup): os.remove(envsup)
        if saved is None:
            if os.path.exists(envloc): os.remove(envloc)
        else:
            open(envloc, "w").write(saved)      # the mold snapshot's own .env.local is restored

def push_schema(mold_dir, url):
    """`drizzle-kit push` FIRST, then the journal. The mold's own bootstrap says so ("ORDER MATTERS")
    and provision.py had it backwards: it ran migrate-production.mjs first and kept `push` only as a
    failure fallback inside bootstrap_database. On a truly empty database that fallback is a dead end —
    the journal is two tables behind schema.ts, so the bootstrap reports `Schema INCOMPLETE — 2 of 56
    tables missing: login_codes, inbox_items`, and the fallback push then dies with `Interactive
    prompts require a TTY terminal`. Provider-independent: it strands a fresh Neon branch exactly as
    it strands a fresh Supabase project."""
    r = subprocess.run("npx drizzle-kit push --force", shell=True, cwd=mold_dir,
                       env=dict(os.environ, DATABASE_URL=url), capture_output=True, text=True)
    raw = r.stdout + r.stderr
    msg = [l for l in raw.strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  schema push: " + (msg[-1][:160] if msg else "ok"))
    # drizzle-kit exits 0 after this one, so returncode alone reads a dead push as a success and the
    # bootstrap then reports `Schema INCOMPLETE`. It only happens on a database that already holds a
    # different version of the schema, which `scope: fresh` is supposed to have ruled out.
    if "Interactive prompts require a TTY" in raw:
        sys.exit("drizzle-kit push needs an interactive rename decision, which means this database is NOT empty. "
                 "A `scope: fresh` app must get an empty database; point datastores.postgres at a new one and rerun.")
    if r.returncode: sys.exit("drizzle-kit push failed:\n" + "\n".join(msg[-12:]))

def run_migrations(mold_dir, vals):
    url = admin_url(vals)
    if not url or not re.match(r"^postgres(?:ql)?://", url):
        sys.exit("no usable admin database URL: none of " + "/".join(ADMIN_KEYS) + " is set, or it is stored "
                 "Sensitive (unreadable). Recreate it as Encrypted, then rerun.")
    # both names: migrate-production.mjs falls back through a chain, and a stale unpooled value in the
    # ambient environment would otherwise decide which database is migrated.
    env = dict(os.environ, DATABASE_URL=url, DATABASE_URL_UNPOOLED=url)
    r = subprocess.run("node scripts/migrate-production.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
    msg = [l for l in (r.stdout + r.stderr).strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  migrations:\n    " + "\n    ".join(msg[-6:] or ["ok"]))   # a Node crash must never read as its version banner
    if r.returncode: sys.exit("migration failed:\n" + "\n".join(msg[-12:]))

def bring_up_schema(mold_dir, ds, proj, projects):
    """Empty database -> a schema, a migration journal, RLS, app_rw, and a DATABASE_URL proven to be
    all four. Separated from deploy_vercel so it can be run — and audited — on its own with
    `--verify-db`, without building or deploying anything.

    Order is push, migrate, bootstrap, task-workflow. That is what the mold itself says ("ORDER
    MATTERS: push the schema first, then this") and the reverse of what provision.py used to do."""
    vals = pull_env(mold_dir, proj)
    url = admin_url(vals)
    # Neon injects the POOLED endpoint as DATABASE_URL and the direct one as DATABASE_URL_UNPOOLED.
    # Migrations belong on the direct endpoint; the runtime belongs on the pooled one, because the mold
    # opens 10 agent + 5 ops backends per serverless instance and the pool size cannot be capped from
    # the URL (`?max=3` still opened 10). RLS survives transaction pooling: withOrgRls sets app.org_id
    # through set_config(..., true), which is transaction-LOCAL, and both clients run prepare:false —
    # verify-apprw.mjs asserts that round trip on the exact URL about to be deployed.
    runtime = vals.get("DATABASE_URL") or url
    print("pushing the schema, then the migration journal"); push_schema(mold_dir, url); run_migrations(mold_dir, vals)
    print("bootstrapping row-level security and the app_rw role")
    bootstrap_database(mold_dir, url, projects,
                       provider=ds.get("postgres", {}).get("provider", "supabase"), runtime_url=runtime)
    # .migrate-task-workflow-service.mjs reads its admin URL from .env.supabase, never from the environment.
    # Write it transiently (gitignored inside the mold) and remove it whatever happens.
    envsup = os.path.join(mold_dir, ".env.supabase")
    try:
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={url}\n")
        os.chmod(envsup, 0o600)
        r = subprocess.run("npm run db:migrate:task-workflows", shell=True, cwd=mold_dir, capture_output=True, text=True)   # admin url: it grants to app_rw
    finally:
        if os.path.exists(envsup): os.remove(envsup)
    msg = [l for l in (r.stdout + r.stderr).strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  task-workflow migrations: " + (msg[-1][:160] if msg else "ok"))
    if r.returncode: sys.exit("task-workflow migration failed:\n" + "\n".join(msg[-12:]))
    return vals

def deploy_vercel(app_id, app, infra, ds, mold_dir):
    """Mirror of the mold's Makefile `deploy` target: migrate, workflow service (services/task-workflow, Next.js),
    Eve API (vercel build with experimental frameworks + --prebuilt), web dashboard, then health verification."""
    proj = infra["vercel"]["project"]; team = infra["vercel"].get("team", ""); scope = f"--scope {team}" if team else ""
    shared = ds.get("postgres", {}).get("scope") == "shared_with_live"
    have = vercel_env_names(mold_dir, proj)
    cfg = {"MODEL_PROVIDER": app["model"]["provider"], "ENABLE_WEB_SEARCH": str(app["capabilities"]["web_search"]).lower(), "ENABLE_BROWSER": str(app["capabilities"]["browser"]).lower(),
           "OPS_MULTI_TENANT": infra.get("runtime_env", {}).get("OPS_MULTI_TENANT", "1")}
    for k, v in cfg.items(): _set_env(k, v, mold_dir, project=proj)
    for k, v in cfg.items(): _set_env(k, v, mold_dir, project=f"{proj}-api")   # build-time flags of the eve bundle: the API must agree with the web door
    def run(cmd, env=None, label=""):
        r = subprocess.run(cmd, shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
        urls = re.findall(r"https://[a-z0-9.-]+\.vercel\.app", r.stdout + r.stderr)
        if r.returncode: sys.exit(f"{label or cmd} failed:\n" + (r.stdout + r.stderr).strip()[-1500:])
        return urls[-1] if urls else ""
    if not shared:
        if "TASK_WORKFLOW_SERVICE_TOKEN" not in have:
            _add_env("TASK_WORKFLOW_SERVICE_TOKEN", subprocess.check_output("openssl rand -hex 32", shell=True, text=True).strip(), mold_dir, proj); print("minted TASK_WORKFLOW_SERVICE_TOKEN")
        vals = bring_up_schema(mold_dir, ds, proj, [proj, f"{proj}-api", f"{proj}-workflow"])
        # workflow service: its own Next.js app under services/task-workflow
        print("deploying workflow service (services/task-workflow)"); sync_env(WORKFLOW_ENV, vals, f"{proj}-workflow", mold_dir); set_framework(f"{proj}-workflow", "nextjs", mold_dir)
        wf_url = run(f"vercel deploy services/task-workflow --prod --yes --project {proj}-workflow {scope}", label="workflow deploy")
        disconnect_git(f"{proj}-workflow", mold_dir)
        infra["vercel"]["workflow_url"] = wf_url; print(f"  {wf_url}")
        _set_env("TASK_WORKFLOW_SERVICE_URL", wf_url, mold_dir, project=proj)
        vals = pull_env(mold_dir, proj)
        # eve api: build here with the experimental framework, ship prebuilt
        print("deploying eve api (vercel build --prebuilt)"); sync_env(API_ENV, vals, f"{proj}-api", mold_dir); set_framework(f"{proj}-api", "eve", mold_dir)
        _set_env("TASK_WORKFLOW_SERVICE_URL", wf_url, mold_dir, project=f"{proj}-api")
        subprocess.run("rm -rf .eve/sandbox-cache/template-locks/vercel .vercel/output", shell=True, cwd=mold_dir)
        env = dict(os.environ, VERCEL_USE_EXPERIMENTAL_FRAMEWORKS="1")
        run(f"vercel build --prod --yes --project {proj}-api {scope} --local-config vercel.eve.json", env=env, label="eve api build")
        api_url = run(f"vercel deploy --prebuilt --prod --yes --project {proj}-api {scope}", label="eve api deploy")
        disconnect_git(f"{proj}-api", mold_dir)
        infra["vercel"]["api_url"] = api_url; print(f"  {api_url}")
        _set_env("NEXT_PUBLIC_EVE_API_URL", api_url, mold_dir, project=proj)
        cfg_main = "vercel.json"
    else:
        v = load(os.path.join(mold_dir, "vercel.json")); v.pop("crons", None)
        cfg_main = "vercel.nocron.json"; save(os.path.join(mold_dir, cfg_main), v); infra["vercel"]["crons"] = "stripped (shared_with_live)"
    # The eve API defaults WEB_ORIGIN to the live app (agent/channels/eve.ts, agent/lib/run-tools.ts).
    # Point it at this app's own front door; the value is only known once the web app has a URL, so a
    # first deploy sets it from the project alias and later deploys correct it.
    web_origin = infra["vercel"].get("production_url") or f"https://{proj}.vercel.app"
    for p_ in (proj, f"{proj}-api"): _set_env("WEB_ORIGIN", web_origin, mold_dir, project=p_)
    print("deploying web app")
    # the eve prebuilt output and the build-time env `vercel build` wrote are the api's, not the web app's
    subprocess.run("rm -rf .vercel/output .vercel/static-build .vercel/.env.production.local", shell=True, cwd=mold_dir)
    url = run(f"vercel deploy . --prod --yes --project {proj} {scope} --local-config {cfg_main}", label="web deploy")
    disconnect_git(proj, mold_dir)
    infra["vercel"]["production_url"] = url; print(f"  {url}")
    if url != web_origin:
        for p_ in (proj, f"{proj}-api"): _set_env("WEB_ORIGIN", url, mold_dir, project=p_)
        print(f"  WEB_ORIGIN corrected to {url} (takes effect on the next deploy)")
    # verify-production, as the Makefile does
    checks = [("workflow", f"{infra['vercel'].get('workflow_url','')}/api/health"), ("api", f"{infra['vercel'].get('api_url','')}/eve/v1/health"), ("web", f"{url}/api/ops/health")]
    health = {}
    for name, u in checks:
        if not u.startswith("http"): continue
        r = subprocess.run(f"curl --silent --show-error --max-time 20 -o /dev/null -w '%{{http_code}}' {u}", shell=True, capture_output=True, text=True)
        health[name] = r.stdout.strip(); print(f"  health {name}: {health[name]} {u}")
    infra["vercel"]["health"] = health
    if any(v != "200" for v in health.values()): print("WARNING: a health check is not 200; see infrastructure.json vercel.health")

ARTIFACT_HEADER = """# GENERATED by .claude/scripts/provision.py from state/application/{app_id}/*.json.
# REGENERATED ON EVERY RUN (--check and --verify-db alike) — edit this file and your edit is gone.
# The one sanctioned hand-edit seam is docker-compose.override.yml, which is never generated. Compose
# merges it AUTOMATICALLY ONLY when you run compose from this directory, so that is how the factory
# runs it too (`localpg.up` shells out to `docker compose up -d` with cwd here): an override written
# beside this file governs the database `--verify-db` brings up, not just manual runs. An explicit
# `docker compose -f <this file>` silently drops the override — do not use that form.
#
# WHAT THIS IS: {app_id}'s LOCAL database, for the five testing lanes and for schema rehearsals on
# this box. WHAT IT IS NOT: a deployment of the application. mold_v1 is three deployables plus four
# cron schedules plus a Vercel-injected OIDC identity that durable-workflow auto-resume needs, and
# giving the VM a non-Vercel identity means editing the mold, which HARD RULE 1 forbids. The one
# committed deploy target is vercel — see infra/vm/README.md.
#
# NO HOST PORT, EVER. Postgres listens on {port} INSIDE the container, on the private network
# {net}, which is also what makes .bootstrap-supabase.mjs's hardcoded port 6543 a no-op.
# This droplet has no firewall (ufw inactive, iptables -P INPUT ACCEPT); a published port here is on
# the public internet within minutes.
"""

def generate_local_artifact(app_id, mold_dir, secrets, ds, infra):
    """infra/vm/apps/<app_id>/ is pure generated output, rewritten from state on EVERY run.

    It used to be written only `if not os.path.exists(...)`, so from the first write onward the factory
    stopped describing the app: a hand-edited compose survived a re-run byte-identical, and — worse —
    the frozen build context meant a BRANDED app silently rebuilt the unbranded mold. Nothing is
    conditional here now; drift is impossible by construction."""
    sys.path.insert(0, os.path.join(ROOT, ".claude/scripts/lib")); import localpg
    d = localpg.appdir(app_id)          # creates the directory AND its .gitignore, in that order
    pg = ds.get("postgres", {})
    hdr = ARTIFACT_HEADER.format(app_id=app_id, port=localpg.PORT, net=localpg.net(app_id))
    open(os.path.join(d, "docker-compose.yml"), "w").write(hdr + f"""
name: {localpg.net(app_id)}
services:
  db:
    image: {localpg.IMAGE}
    container_name: {localpg.cont(app_id)}
    command: ["-c","port={localpg.PORT}","-c","ssl=on","-c","ssl_cert_file=/certs/server.crt","-c","ssl_key_file=/certs/server.key","-c","password_encryption=scram-sha-256","-c","max_connections=200"]
    environment:
      POSTGRES_DB: {localpg.dbname(app_id)}
      POSTGRES_PASSWORD_FILE: /run/secrets/pg-admin
    secrets: [pg-admin]
    volumes:
      - {localpg.vol(app_id)}:/var/lib/postgresql/data
      - ./pg:/certs:ro
    networks:
      default: {{aliases: [db]}}
    restart: unless-stopped
    healthcheck:
      test: ["CMD","pg_isready","-p","{localpg.PORT}","-U","postgres"]
      interval: 5s
      timeout: 3s
      retries: 30
secrets:
  pg-admin:
    file: ./.pg-admin
volumes:
  {localpg.vol(app_id)}:
    name: {localpg.vol(app_id)}      # pin it: compose would otherwise prefix the project name and
                                     # `localpg.py up` and `docker compose up` would use two different data dirs
networks:
  default:
    name: {localpg.net(app_id)}
""")
    open(os.path.join(d, ".env.example"), "w").write(
        f"# secret NAMES only — values are generated or read from your terminal, never typed into this file\n"
        f"# provider: {pg.get('provider','?')}   scope: {pg.get('scope','?')}   deploy target: {infra.get('target','?')}\n"
        + "".join(f"{s}=\n" for s in secrets))
    localpg.ensure_local_secrets(app_id)   # .pg-admin + pg/server.{crt,key}: the compose file's own inputs,
                                           # without which `docker compose up` fails on a bind-mount that
                                           # does not exist. The artifact is runnable the moment it exists.
    open(os.path.join(d, "README.md"), "w").write(f"""<!-- GENERATED; see infra/vm/README.md -->
# {app_id} — local database artifact

    python3 .claude/scripts/provision.py {app_id} --verify-db   # up, full mold chain, app_rw proof
    (cd infra/vm/apps/{app_id} && docker compose up -d)         # the database alone, nothing else
    python3 .claude/scripts/lib/localpg.py down {app_id}

Provider `{pg.get('provider','?')}`. No host port: `docker port {localpg.cont(app_id)}` is empty by
design. Hand edits go in `docker-compose.override.yml` here, and both commands above honour it —
`docker compose -f <file>` from elsewhere would silently ignore it, so run compose from this directory.
`.pg-admin` (Postgres superuser password) and `pg/server.key` (TLS private key) are ignored by this
directory's .gitignore and by the root one; never commit them.
""")
    return d

def _vm_env(app_id, pairs):
    """Write values into the app's own gitignored env file, 0600. This is the vm_env_file secret store:
    the same contract as Vercel env, on a box the factory owns. Values never enter state or the repo."""
    f = os.path.join(ROOT, "infra/vm/apps", app_id, ".env"); os.makedirs(os.path.dirname(f), exist_ok=True)
    keep = [l for l in (open(f).read().splitlines() if os.path.exists(f) else []) if l.split("=")[0] not in pairs]
    old = os.umask(0o077)
    try: open(f, "w").write("\n".join(keep + [f"{k}={v}" for k, v in pairs.items()]) + "\n")
    finally: os.umask(old)
    os.chmod(f, 0o600)

def verify_db(app_id, mold_dir, ds):
    """Stand up the app's LOCAL Postgres and run the whole mold chain against it, then prove the URL.

    This is what `target: vm` buys: a real database the lanes can run against, on a private network,
    with no credential of the user's involved anywhere."""
    sys.path.insert(0, os.path.join(ROOT, ".claude/scripts/lib")); import localpg
    localpg.up(app_id); adm = localpg.url(app_id)
    envloc = os.path.join(mold_dir, ".env.local"); saved = open(envloc).read() if os.path.exists(envloc) else None
    envsup = os.path.join(mold_dir, ".env.supabase")
    try:
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={adm}\n")
        os.chmod(envsup, 0o600)
        for label, cmd, env in [("schema push", "npx drizzle-kit push --force", {"DATABASE_URL": adm}),
                                ("migration journal", "node scripts/migrate-production.mjs", {"DATABASE_URL": adm, "DATABASE_URL_UNPOOLED": adm}),
                                ("rls + app_rw", "node .bootstrap-supabase.mjs", {}),
                                ("task-workflow", "npm run db:migrate:task-workflows", {})]:
            r = localpg.run(app_id, cmd, mold_dir, env)
            msg = [l for l in (r.stdout + r.stderr).splitlines() if l.strip() and not l.lstrip().startswith("at ") and not l.startswith("npm notice")]
            print(f"  {label}: " + (msg[-1][:150] if msg else "ok"))
            if r.returncode: sys.exit(f"{label} failed:\n" + "\n".join(msg[-12:]))
        m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(envloc).read(), re.M)
        if not m: sys.exit("bootstrap did not write an app_rw DATABASE_URL into .env.local")
        r = localpg.run(app_id, "node /factory-lib/verify-apprw.mjs", mold_dir, {"APP_RW_URL": m.group(1)},
                        # node resolves a bare import from the script's directory UPWARD, so /node_modules
                        # serves /factory-lib without a nested mount into a read-only one
                        extra=["-v", f"{os.path.join(ROOT, '.claude/scripts/lib')}:/factory-lib:ro",
                               "-v", f"{os.path.join(mold_dir, 'node_modules')}:/node_modules:ro"])
        print("  app_rw check: " + (r.stdout.strip().splitlines() or [r.stderr.strip()[-200:]])[-1])
        if r.returncode: sys.exit("app_rw verification failed")
        _vm_env(app_id, {"POSTGRES_ADMIN_URL": adm, "DATABASE_URL": m.group(1)})
        print(f"verified: {app_id}'s local database is ready (no host port; `docker port {localpg.cont(app_id)}` is empty)")
        print(f"  DATABASE_URL and POSTGRES_ADMIN_URL written to infra/vm/apps/{app_id}/.env — 0600, and ignored by\n"
              f"  both infra/vm/apps/{app_id}/.gitignore and the root .gitignore, as are .pg-admin and pg/server.key")
    finally:
        if os.path.exists(envsup): os.remove(envsup)
        if saved is None:
            if os.path.exists(envloc): os.remove(envloc)
        else: open(envloc, "w").write(saved)

def set_secret(app_id, name, infra, mold_dir):
    """Prompt for one credential and write it where this app's secrets live.
    The value is read from the terminal, never passed on a command line and never stored here.

    `infra["vercel"]` used to be read unconditionally, so this — the ONE command a non-technical
    operator is ever told to run — died with KeyError: 'vercel' on any app that is not on Vercel."""
    import getpass
    value = getpass.getpass(f"{name} (input hidden): ").strip()
    if not value: sys.exit("nothing entered")
    if infra.get("target") == "vercel":
        proj = infra["vercel"]["project"]; projects = [proj, f"{proj}-api", f"{proj}-workflow"]
        for p in projects: _set_env(name, value, mold_dir, project=p)
        where = f"{len(projects)} project(s)"
    else:
        f = os.path.join(ROOT, "infra/vm/apps", app_id, ".env")
        os.makedirs(os.path.dirname(f), exist_ok=True)
        lines = [l for l in (open(f).read().splitlines() if os.path.exists(f) else []) if not l.startswith(f"{name}=")]
        old = os.umask(0o077)
        try: open(f, "w").write("\n".join(lines + [f"{name}={value}"]) + "\n")
        finally: os.umask(old)
        os.chmod(f, 0o600); where = os.path.relpath(f, ROOT)
    print(f"{name} set on {where}.")

def main(a):
    if not a: sys.exit(__doc__)
    app_id = a[0]; deploy = "--deploy" in a
    adir = os.path.join(ST, "application", app_id)
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    if deploy and app.get("surface", {}).get("branding"):
        # Build from a branded copy of the mold. branding.py refuses if any rule stopped matching,
        # so a half-branded app can never ship; the snapshot itself is never edited.
        r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/branding.py"), app_id, "prepare"], capture_output=True, text=True)
        print((r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")
        if r.returncode: sys.exit("branding failed; not deploying")
        mold_dir = os.path.join(ROOT, "build", app_id)
    secrets = infra.get("secrets", []); target = infra["target"]; store = infra.get("secret_store")
    ds = load(os.path.join(adir, "datastores.json")); prov = ds.get("postgres", {}).get("provider", "supabase")
    print(f"{app_id}: target={target} store={store} postgres={prov} secrets={len(secrets)}")
    if "--set-secret" in a:
        return set_secret(app_id, a[a.index("--set-secret") + 1], infra, mold_dir)
    # NO POSTGRES PORT IS EVER OPENED TO THE INTERNET. That refusal is code, not a comment.
    # A self_hosted database here lives on a private docker network with no host port, which a Vercel
    # function cannot reach. Making it reachable would mean `hostssl ... 0.0.0.0/0` — the team is on
    # Vercel Pro, which has no static egress IP, so there is no narrower rule — with sslmode=require
    # and no server authentication (verify-full needs `ssl:{ca}` in agent/lib/db/index.ts, a mold edit
    # HARD RULE 1 forbids), on a droplet with ufw inactive and ~1100 SSH credential attempts a day.
    if prov == "self_hosted" and target == "vercel":
        sys.exit(f'{app_id}: postgres.provider "self_hosted" is a LOCAL database on this box (private docker '
                 f'network, no host port) and a Vercel deployment cannot reach it — and this factory never opens '
                 f'a Postgres port to the internet. Set "provider": "neon" in state/application/{app_id}/'
                 f'datastores.json (Neon\'s free tier is available) and rerun. To use it locally: '
                 f'python3 .claude/scripts/provision.py {app_id} --verify-db')
    if target == "vercel":
        proj = infra["vercel"]["project"]
        ensure_projects(proj, mold_dir)         # before ANY env or resource is written to them
        present = vercel_env_names(mold_dir, proj)
        present = provision_datastores(app_id, ds, mold_dir, present, infra, proj)
        save(os.path.join(adir, "infrastructure.json"), infra)
        # report a reconnected project before anyone deploys: a git-sourced build of the factory repo
        # overwrites this app's production deployment and its build cache.
        for p_ in (proj, f"{proj}-api", f"{proj}-workflow"):
            link = git_link(p_, mold_dir)
            if link: sys.exit(GIT_LINK_MSG.format(project=p_, link=link))
        if "--verify-db" in a:
            # the database half of --deploy, on its own: no build, no deployment, no service touched
            bring_up_schema(mold_dir, ds, proj, [proj, f"{proj}-api", f"{proj}-workflow"])
            return print(f"{app_id}: database ready and verified on {prov}")
    else:
        # EVERY vm run regenerates the artifact, --verify-db included. --verify-db used to return before
        # this line, so the compose file and README could be missing while state still named them, and —
        # worse — the run that creates .pg-admin and pg/server.key was the one run that never wrote the
        # .gitignore protecting them. (localpg.appdir now writes it first, and the root .gitignore
        # carries the same rules; this ordering means the artifact simply cannot lag the database.)
        d = generate_local_artifact(app_id, mold_dir, secrets, ds, infra)
        if "--verify-db" in a: return verify_db(app_id, mold_dir, ds)
        envf = os.path.join(d, ".env"); present = set()
        if os.path.exists(envf):
            present = {l.split("=")[0].strip() for l in open(envf) if "=" in l and not l.startswith("#") and l.split("=",1)[1].strip()}
        print(f"local artifact regenerated: {os.path.relpath(d, ROOT)}/ (docker-compose.yml, .env.example, README.md)")
        print(f"target=vm VERIFIES, it does not deploy — run: python3 .claude/scripts/provision.py {app_id} --verify-db")
    user_s = infra.get("secrets_user", secrets); derived_s = infra.get("secrets_derived", [])
    missing_user = [x for x in user_s if x not in present]
    # No copy-from-live path: Vercel marks these `sensitive` (write-only), so a pull of the source
    # project returns [SENSITIVE] and copying it would write that literal string as the credential.
    missing_derived = [x for x in derived_s if x not in present and x not in DEPLOY_TIME]
    print(f"secrets present: {len([x for x in secrets if x in present])}/{len(secrets)}")
    if missing_user:
        print("Set these once (the value is read from your terminal, never stored here or shown in chat):")
        for m in missing_user: print(f"  python3 .claude/scripts/provision.py {app_id} --set-secret {m}")
    if missing_derived:
        print("provisioner still has to create:"); [print(f"  {m}") for m in missing_derived]
    pending_deploy = [x for x in DEPLOY_TIME if x not in present]
    if pending_deploy: print(f"set during --deploy: {', '.join(pending_deploy)}")
    if not deploy:
        print("check only; re-run with --deploy once nothing is missing"); sys.exit(1 if (missing_user or missing_derived) else 0)
    if missing_user or missing_derived: sys.exit("refusing to deploy with missing secrets")
    if target != "vercel":
        # No half-working second target. The vm branch used to `docker compose up -d --build` a
        # single `web` container and then call it deployed: no database, no eve API, no task-workflow
        # service, no crons, no health check — one fifth of the application, recorded as `stamped`.
        sys.exit(f"{app_id}: target 'vm' is a LOCAL VERIFICATION target, not a deploy target (see infra/vm/README.md). "
                 f"Run `python3 .claude/scripts/provision.py {app_id} --verify-db` to bring its database up and prove "
                 f"the schema, or set infrastructure.target to \"vercel\" to deploy the application.")
    app["status"] = "stamping"; save(os.path.join(adir, "application.json"), app)
    deploy_vercel(app_id, app, infra, ds, mold_dir)
    infra["deployed_at"] = TODAY; save(os.path.join(adir, "infrastructure.json"), infra)
    app["status"] = "stamped"; save(os.path.join(adir, "application.json"), app)
    print(f"deployed: {infra.get('vercel',infra.get('vm',{})).get('production_url')}")
if __name__ == "__main__": main(sys.argv[1:])
