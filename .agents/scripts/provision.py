#!/usr/bin/env python3
"""Provision: validated application state -> running deployment.

  provision.py <app_id> [--check] [--deploy]

--check (default): verify every secret named in infrastructure.json exists in the
  secret store (Vercel env for vercel_env; infra/vm/apps/<app_id>/.env for vm_env_file),
  make sure the target scaffolding exists, print what is missing. Never deploys.
--deploy: run the deploy for the target. Refuses if any secret is missing.
"""
import json, os, re, sys, subprocess, datetime, shutil, urllib.parse
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
def _add_env(name, value, cwd, project):
    subprocess.run(f"vercel env add {name} production --project {project}", shell=True, cwd=cwd, input=value, capture_output=True, text=True)
def _set_env(name, value, cwd, project=None):
    """Idempotent: replace whatever production value exists. Used for derived, non-secret config such as service URLs.
    Goes through the REST API so it never relinks the mold dir (other steps may be pulling env there concurrently)."""
    project = project or load(os.path.join(cwd, ".vercel/project.json"))["projectId"]
    r = subprocess.run(f"vercel api /v9/projects/{project}/env --raw", shell=True, cwd=cwd, capture_output=True, text=True)
    try: envs = json.loads(r.stdout).get("envs", [])
    except Exception: envs = []
    hit = next((e for e in envs if e["key"] == name and "production" in (e.get("target") or [])), None)
    body = json.dumps({"key": name, "value": value, "type": "plain", "target": ["production"]})
    if hit: subprocess.run(["vercel", "api", f"/v9/projects/{project}/env/{hit['id']}", "-X", "PATCH", "--input", "-", "--raw"], cwd=cwd, input=json.dumps({"value": value, "type": "plain"}), capture_output=True, text=True)
    else: subprocess.run(["vercel", "api", f"/v10/projects/{project}/env", "-X", "POST", "--input", "-", "--raw"], cwd=cwd, input=body, capture_output=True, text=True)

def provision_datastores(app_id, ds, mold_dir, present, infra, proj):
    """Fresh datastores via Vercel Marketplace, inside the app's own project. Returns names now present."""
    pg, blob = ds.get("postgres", {}), ds.get("blob", {})
    if pg.get("scope") == "fresh" and pg.get("provider") == "supabase" and "SUPABASE_URL" not in present:
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
        print(f"creating Vercel Blob store '{app_id}' ...")
        r = subprocess.run(f"vercel blob create-store {app_id.replace("_","-")} --access private --yes", shell=True, cwd=mold_dir, capture_output=True, text=True)
        if r.returncode and "already" not in (r.stdout + r.stderr): print("  " + (r.stdout + r.stderr).strip().splitlines()[-1])
        infra.setdefault("datastores", {})["blob_store"] = app_id
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
API_ENV = ["AUTH_JWT_PUBLIC_KEY", "BLOB_READ_WRITE_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CRON_SECRET", "DATABASE_URL",
           "MODEL_PROVIDER", "OPS_SECRETS_KEY", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "EXA_API_KEY", "BROWSERBASE_API_KEY",
           "ENABLE_WEB_SEARCH", "ENABLE_BROWSER", "GOOGLE_CLIENT_ID"]
WORKFLOW_ENV = ["DATABASE_URL", "TASK_WORKFLOW_SERVICE_TOKEN"]

def pull_env(mold_dir, project):
    tmp = os.path.join(mold_dir, f".env.provision.{project}")
    subprocess.run(f"vercel env pull --yes --environment=production --project {project} {tmp}", shell=True, cwd=mold_dir, capture_output=True)
    vals = {}
    for l in open(tmp):
        if "=" in l and not l.startswith("#"):
            k, v = l.split("=", 1); vals[k.strip()] = v.strip().strip('"')
    os.remove(tmp)
    if not vals: sys.exit(f"could not pull the production environment of {project}")
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

def deploy(cfg, mold_dir):
    """Production deploy from the mold dir; returns the deployment URL. The CLI prints progress on stderr and the URL on stdout, but a build error arrives as JSON, so never trust the last line blindly."""
    r = subprocess.run(f"vercel deploy --prod --yes --local-config {cfg}", shell=True, cwd=mold_dir, capture_output=True, text=True)
    urls = re.findall(r"https://[a-z0-9.-]+\.vercel\.app", r.stdout + r.stderr)
    if r.returncode or not urls: sys.exit(f"deploy with {cfg} failed:\n" + (r.stdout + r.stderr).strip()[-1500:])
    return urls[-1]

def sync_env(names, vals, project, mold_dir):
    have = vercel_env_names(mold_dir, project); n = 0
    for k in names:
        if k in vals and vals[k] and k not in have: _add_env(k, vals[k], mold_dir, project); n += 1
    print(f"  {project}: synced {n} env var(s)")

def bootstrap_database(mold_dir, admin_url, projects):
    """A fresh Postgres needs what Drizzle does not model: row-level security and the app_rw
    login role (NOBYPASSRLS). The mold ships .bootstrap-supabase.mjs for exactly this; it reads
    .env.supabase, verifies the schema, applies RLS, creates app_rw and writes the app_rw
    connection string into .env.local. Without it the app runs as a BYPASSRLS superuser and the
    task-workflow migration fails on the missing role. Idempotent: re-running rotates the password.
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
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={admin_url}\n")
        os.chmod(envsup, 0o600)
        r = subprocess.run("node .bootstrap-supabase.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
        if r.returncode and "Schema INCOMPLETE" in (r.stdout + r.stderr):
            print("  schema incomplete; drizzle-kit push then bootstrap again")
            pr = subprocess.run("npx drizzle-kit push --force", shell=True, cwd=mold_dir, env=dict(os.environ, DATABASE_URL=admin_url), capture_output=True, text=True)
            if pr.returncode: sys.exit("drizzle-kit push failed:\n" + (pr.stdout + pr.stderr).strip()[-1200:])
            r = subprocess.run("node .bootstrap-supabase.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
        out = [l for l in (r.stdout + r.stderr).splitlines() if l.strip() and not l.lstrip().startswith("at ")]
        for l in out:
            if l.startswith(("✓", "✗", "app_rw", "policies", "tables app_rw")): print("  " + l[:150])
        if r.returncode: sys.exit("database bootstrap failed:\n" + "\n".join(out[-12:]))
        m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(envloc).read(), re.M) if os.path.exists(envloc) else None
        if not m: sys.exit("bootstrap did not write an app_rw DATABASE_URL into .env.local")
        app_url = m.group(1)
        for pr_ in projects: _set_env("DATABASE_URL", app_url, mold_dir, project=pr_)
        print(f"  DATABASE_URL now points at app_rw on {len(projects)} project(s)")
        return app_url
    finally:
        if os.path.exists(envsup): os.remove(envsup)
        if saved is None:
            if os.path.exists(envloc): os.remove(envloc)
        else:
            open(envloc, "w").write(saved)      # the mold snapshot's own .env.local is restored

def run_migrations(mold_dir, vals):
    url = vals.get("SUPABASE_POSTGRES_URL_NON_POOLING") or vals.get("DATABASE_URL")
    if not url: sys.exit("no database url to migrate")
    env = dict(os.environ, DATABASE_URL=url)
    r = subprocess.run("node scripts/migrate-production.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
    msg = [l for l in (r.stdout + r.stderr).strip().splitlines() if l.strip() and not l.lstrip().startswith("at ")]
    print("  migrations: " + (msg[-1][:160] if msg else "ok"))
    if r.returncode: sys.exit("migration failed:\n" + "\n".join(msg[-12:]))

def deploy_vercel(app_id, app, infra, ds, mold_dir):
    """Mirror of the mold's Makefile `deploy` target: migrate, workflow service (services/task-workflow, Next.js),
    Eve API (vercel build with experimental frameworks + --prebuilt), web dashboard, then health verification."""
    proj = infra["vercel"]["project"]; team = infra["vercel"].get("team", ""); scope = f"--scope {team}" if team else ""
    shared = ds.get("postgres", {}).get("scope") == "shared_with_live"
    have = vercel_env_names(mold_dir, proj)
    cfg = {"MODEL_PROVIDER": app["model"]["provider"], "ENABLE_WEB_SEARCH": str(app["capabilities"]["web_search"]).lower(), "ENABLE_BROWSER": str(app["capabilities"]["browser"]).lower(),
           "OPS_MULTI_TENANT": infra.get("runtime_env", {}).get("OPS_MULTI_TENANT", "1")}
    for k, v in cfg.items(): _set_env(k, v, mold_dir, project=proj)
    def run(cmd, env=None, label=""):
        r = subprocess.run(cmd, shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
        urls = re.findall(r"https://[a-z0-9.-]+\.vercel\.app", r.stdout + r.stderr)
        if r.returncode: sys.exit(f"{label or cmd} failed:\n" + (r.stdout + r.stderr).strip()[-1500:])
        return urls[-1] if urls else ""
    if not shared:
        if "TASK_WORKFLOW_SERVICE_TOKEN" not in have:
            _add_env("TASK_WORKFLOW_SERVICE_TOKEN", subprocess.check_output("openssl rand -hex 32", shell=True, text=True).strip(), mold_dir, proj); print("minted TASK_WORKFLOW_SERVICE_TOKEN")
        vals = pull_env(mold_dir, proj)
        print("running migrations on the fresh database"); run_migrations(mold_dir, vals)
        url = vals.get("SUPABASE_POSTGRES_URL_NON_POOLING") or vals.get("DATABASE_URL")
        print("bootstrapping row-level security and the app_rw role")
        bootstrap_database(mold_dir, url, [proj, f"{proj}-api", f"{proj}-workflow"])
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
        # workflow service: its own Next.js app under services/task-workflow
        print("deploying workflow service (services/task-workflow)"); sync_env(WORKFLOW_ENV, vals, f"{proj}-workflow", mold_dir); set_framework(f"{proj}-workflow", "nextjs", mold_dir)
        wf_url = run(f"vercel deploy services/task-workflow --prod --yes --project {proj}-workflow {scope}", label="workflow deploy")
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
        infra["vercel"]["api_url"] = api_url; print(f"  {api_url}")
        _set_env("NEXT_PUBLIC_EVE_API_URL", api_url, mold_dir, project=proj)
        cfg_main = "vercel.json"
    else:
        v = load(os.path.join(mold_dir, "vercel.json")); v.pop("crons", None)
        cfg_main = "vercel.nocron.json"; save(os.path.join(mold_dir, cfg_main), v); infra["vercel"]["crons"] = "stripped (shared_with_live)"
    print("deploying web app")
    url = run(f"vercel deploy . --prod --yes --project {proj} {scope} --local-config {cfg_main}", label="web deploy")
    infra["vercel"]["production_url"] = url; print(f"  {url}")
    # verify-production, as the Makefile does
    checks = [("workflow", f"{infra['vercel'].get('workflow_url','')}/api/health"), ("api", f"{infra['vercel'].get('api_url','')}/eve/v1/health"), ("web", f"{url}/api/ops/health")]
    health = {}
    for name, u in checks:
        if not u.startswith("http"): continue
        r = subprocess.run(f"curl --silent --show-error --max-time 20 -o /dev/null -w '%{{http_code}}' {u}", shell=True, capture_output=True, text=True)
        health[name] = r.stdout.strip(); print(f"  health {name}: {health[name]} {u}")
    infra["vercel"]["health"] = health
    if any(v != "200" for v in health.values()): print("WARNING: a health check is not 200; see infrastructure.json vercel.health")

def ensure_vm_scaffold(app_id, mold_dir, secrets):
    d = os.path.join(ROOT, "infra/vm/apps", app_id); os.makedirs(d, exist_ok=True)
    df = os.path.join(d, "Dockerfile")
    if not os.path.exists(df):
        open(df, "w").write("""FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "run", "start"]
""")
    cf = os.path.join(d, "docker-compose.yml")
    if not os.path.exists(cf):
        open(cf, "w").write(f"""services:
  web:
    build:
      context: {os.path.relpath(mold_dir, d)}
      dockerfile: {os.path.relpath(df, mold_dir)}
    env_file: .env
    ports: ["3000:3000"]
    restart: unless-stopped
""")
    ex = os.path.join(d, ".env.example")
    open(ex, "w").write("".join(f"{s}=\n" for s in secrets))
    gi = os.path.join(d, ".gitignore")
    if not os.path.exists(gi): open(gi, "w").write(".env\n")
    return d

def main(a):
    if not a: sys.exit(__doc__)
    app_id = a[0]; deploy = "--deploy" in a
    adir = os.path.join(ST, "application", app_id)
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    secrets = infra.get("secrets", []); target = infra["target"]; store = infra.get("secret_store")
    print(f"{app_id}: target={target} store={store} secrets={len(secrets)}")
    if target == "vercel":
        proj = infra["vercel"]["project"]
        present = vercel_env_names(mold_dir, proj)
        present = provision_datastores(app_id, load(os.path.join(adir, "datastores.json")), mold_dir, present, infra, proj)
        save(os.path.join(adir, "infrastructure.json"), infra)
    else:
        d = ensure_vm_scaffold(app_id, mold_dir, secrets)
        envf = os.path.join(d, ".env"); present = set()
        if os.path.exists(envf):
            present = {l.split("=")[0].strip() for l in open(envf) if "=" in l and not l.startswith("#") and l.split("=",1)[1].strip()}
        print(f"vm scaffold: {os.path.relpath(d, ROOT)}/ (Dockerfile, docker-compose.yml, .env.example)")
    user_s = infra.get("secrets_user", secrets); derived_s = infra.get("secrets_derived", [])
    missing_user = [x for x in user_s if x not in present]
    src = load(os.path.join(ST, "factory.json")).get("defaults", {}).get("secret_source_project")
    if missing_user and target == "vercel" and src and src != infra["vercel"]["project"]:
        # Same team, same accounts: external credentials already exist on the source project. Copy by name, never print.
        vals = pull_env(mold_dir, src)
        copied = []
        for k in missing_user:
            if vals.get(k): _add_env(k, vals[k], mold_dir, proj); copied.append(k)
        if copied: print(f"copied from {src}: {', '.join(copied)}")
        present = vercel_env_names(mold_dir, proj); missing_user = [x for x in user_s if x not in present]
    missing_derived = [x for x in derived_s if x not in present and x not in DEPLOY_TIME]
    print(f"secrets present: {len([x for x in secrets if x in present])}/{len(secrets)}")
    if missing_user:
        print("YOU must set these (vercel env add NAME production, in the mold dir):")
        for m in missing_user: print(f"  {m}")
    if missing_derived:
        print("provisioner still has to create:"); [print(f"  {m}") for m in missing_derived]
    pending_deploy = [x for x in DEPLOY_TIME if x not in present]
    if pending_deploy: print(f"set during --deploy: {', '.join(pending_deploy)}")
    if not deploy:
        print("check only; re-run with --deploy once nothing is missing"); sys.exit(1 if (missing_user or missing_derived) else 0)
    if missing_user or missing_derived: sys.exit("refusing to deploy with missing secrets")
    app["status"] = "stamping"; save(os.path.join(adir, "application.json"), app)
    ds = load(os.path.join(adir, "datastores.json"))
    if target == "vercel":
        deploy_vercel(app_id, app, infra, ds, mold_dir)
    else:
        d = os.path.join(ROOT, "infra/vm/apps", app_id)
        out = sh("docker compose up -d --build 2>&1 | tail -3", cwd=d)
        infra["vm"]["production_url"] = f"http://{infra['vm'].get('host','localhost')}:3000"; print(out)
    infra["deployed_at"] = TODAY; save(os.path.join(adir, "infrastructure.json"), infra)
    app["status"] = "stamped"; save(os.path.join(adir, "application.json"), app)
    print(f"deployed: {infra.get('vercel',infra.get('vm',{})).get('production_url')}")
if __name__ == "__main__": main(sys.argv[1:])
