#!/usr/bin/env python3
"""Provision: validated application state -> running deployment.

  provision.py <app_id> [--check] [--deploy]

--check (default): verify every secret named in infrastructure.json exists in the
  secret store (Vercel env for vercel_env; infra/vm/apps/<app_id>/.env for vm_env_file),
  make sure the target scaffolding exists, print what is missing. Never deploys.
--deploy: run the deploy for the target. Refuses if any secret is missing.
"""
import json, os, sys, subprocess, datetime, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state"); TODAY = datetime.date.today().isoformat()
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
def sh(cmd, cwd=None, check=True):
    r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode: sys.exit(f"$ {cmd}\n{r.stdout}{r.stderr}")
    return r.stdout

def vercel_env_names(cwd):
    out = sh("vercel env ls production 2>/dev/null", cwd=cwd, check=False)
    return {l.split()[0] for l in out.splitlines() if l.strip() and l.split()[0].isupper()}

GENERATED = {  # app-internal secrets the factory may mint itself (never external credentials)
  "CRON_SECRET": "openssl rand -hex 32",
  "OPS_SECRETS_KEY": "openssl rand -hex 32",
}
def _add_env(name, value, cwd):
    subprocess.run(f"vercel env add {name} production", shell=True, cwd=cwd, input=value, capture_output=True, text=True)

def provision_datastores(app_id, ds, mold_dir, present, infra):
    """Fresh datastores via Vercel Marketplace, inside the app's own project. Returns names now present."""
    pg, blob = ds.get("postgres", {}), ds.get("blob", {})
    if pg.get("scope") == "fresh" and pg.get("provider") == "supabase" and "SUPABASE_URL" not in present:
        print(f"provisioning fresh Supabase project '{app_id}' via Vercel Marketplace ...")
        r = subprocess.run(f"vercel integration add supabase -n {app_id} --prefix SUPABASE_ --no-claim --no-env-pull -e production -e preview -e development", shell=True, cwd=mold_dir, capture_output=True, text=True)
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        print("  " + " | ".join(tail))
        if r.returncode: sys.exit("supabase provisioning failed; if it asks for a browser step run: vercel integration open supabase")
        infra.setdefault("datastores", {})["supabase_resource"] = app_id
    if blob.get("provider") == "vercel_blob" and "BLOB_READ_WRITE_TOKEN" not in present:
        print(f"creating Vercel Blob store '{app_id}' ...")
        r = subprocess.run(f"vercel blob create-store {app_id.replace("_","-")} --access private --yes", shell=True, cwd=mold_dir, capture_output=True, text=True)
        if r.returncode and "already" not in (r.stdout + r.stderr): print("  " + (r.stdout + r.stderr).strip().splitlines()[-1])
        infra.setdefault("datastores", {})["blob_store"] = app_id
    present = vercel_env_names(mold_dir)
    for name, cmd in GENERATED.items():
        if name not in present:
            _add_env(name, subprocess.check_output(cmd, shell=True, text=True).strip(), mold_dir); print(f"generated {name}")
    if "AUTH_JWT_PRIVATE_KEY" not in present:
        js = ("const{generateKeyPairSync}=require('crypto');const{publicKey:a,privateKey:b}=generateKeyPairSync('ec',{namedCurve:'P-256'});"
              "console.log(Buffer.from(b.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log(Buffer.from(a.export({type:'spki',format:'pem'})).toString('base64'))")
        priv, pub = subprocess.check_output(["node", "-e", js], text=True).split()
        _add_env("AUTH_JWT_PRIVATE_KEY", priv, mold_dir); _add_env("AUTH_JWT_PUBLIC_KEY", pub, mold_dir); print("generated AUTH_JWT key pair")
    present = vercel_env_names(mold_dir)
    if "DATABASE_URL" not in present and "SUPABASE_POSTGRES_URL" in present:
        # DATABASE_URL is the app's canonical name for the pooled Postgres URL the integration injected
        tmp = os.path.join(mold_dir, ".env.provision")
        subprocess.run(f"vercel env pull --environment=production {tmp}", shell=True, cwd=mold_dir, capture_output=True)
        val = next((l.split("=",1)[1].strip().strip('"') for l in open(tmp) if l.startswith("SUPABASE_POSTGRES_URL=")), "")
        os.remove(tmp)
        if val: _add_env("DATABASE_URL", val, mold_dir); print("derived DATABASE_URL from SUPABASE_POSTGRES_URL")
    return vercel_env_names(mold_dir)

DEPLOY_TIME = ["TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "NEXT_PUBLIC_EVE_API_URL", "MODEL_PROVIDER"]
API_ENV = ["AUTH_JWT_PUBLIC_KEY", "BLOB_READ_WRITE_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CRON_SECRET", "DATABASE_URL",
           "MODEL_PROVIDER", "OPS_SECRETS_KEY", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "EXA_API_KEY", "BROWSERBASE_API_KEY",
           "ENABLE_WEB_SEARCH", "ENABLE_BROWSER", "GOOGLE_CLIENT_ID"]
WORKFLOW_ENV = ["DATABASE_URL", "TASK_WORKFLOW_SERVICE_TOKEN"]

def pull_env(mold_dir):
    tmp = os.path.join(mold_dir, ".env.provision")
    subprocess.run(f"vercel env pull --yes --environment=production {tmp}", shell=True, cwd=mold_dir, capture_output=True)
    vals = {}
    for l in open(tmp):
        if "=" in l and not l.startswith("#"):
            k, v = l.split("=", 1); vals[k.strip()] = v.strip().strip('"')
    os.remove(tmp); return vals

def link(project, mold_dir): sh(f"vercel link --yes --project {project} >/dev/null 2>&1", cwd=mold_dir)

def sync_env(names, vals, project, mold_dir):
    link(project, mold_dir); have = vercel_env_names(mold_dir); n = 0
    for k in names:
        if k in vals and vals[k] and k not in have: _add_env(k, vals[k], mold_dir); n += 1
    print(f"  {project}: synced {n} env var(s)")

def run_migrations(mold_dir, vals):
    url = vals.get("SUPABASE_POSTGRES_URL_NON_POOLING") or vals.get("DATABASE_URL")
    if not url: sys.exit("no database url to migrate")
    env = dict(os.environ, DATABASE_URL=url)
    r = subprocess.run("node scripts/migrate-production.mjs", shell=True, cwd=mold_dir, env=env, capture_output=True, text=True)
    print("  migrations: " + ((r.stdout + r.stderr).strip().splitlines() or ["ok"])[-1])
    if r.returncode: sys.exit("migration failed")

def deploy_vercel(app_id, app, infra, ds, mold_dir):
    proj = infra["vercel"]["project"]; shared = ds.get("postgres", {}).get("scope") == "shared_with_live"
    link(proj, mold_dir); have = vercel_env_names(mold_dir)
    # config values (not secrets) derived from state
    cfg = {"MODEL_PROVIDER": app["model"]["provider"], "ENABLE_WEB_SEARCH": str(app["capabilities"]["web_search"]).lower(), "ENABLE_BROWSER": str(app["capabilities"]["browser"]).lower()}
    for k, v in cfg.items():
        if k not in have: _add_env(k, v, mold_dir)
    if not shared:
        if "TASK_WORKFLOW_SERVICE_TOKEN" not in have:
            _add_env("TASK_WORKFLOW_SERVICE_TOKEN", subprocess.check_output("openssl rand -hex 32", shell=True, text=True).strip(), mold_dir); print("minted TASK_WORKFLOW_SERVICE_TOKEN")
        vals = pull_env(mold_dir)
        print("running migrations on the fresh database"); run_migrations(mold_dir, vals)
        # workflow service
        print("deploying workflow service"); sync_env(WORKFLOW_ENV, vals, f"{proj}-workflow", mold_dir)
        wf_url = sh("vercel deploy --prod --yes --local-config vercel.eve.json 2>/dev/null | tail -1", cwd=mold_dir).strip()
        infra["vercel"]["workflow_url"] = wf_url; print(f"  {wf_url}")
        link(proj, mold_dir)
        if "TASK_WORKFLOW_SERVICE_URL" not in vercel_env_names(mold_dir): _add_env("TASK_WORKFLOW_SERVICE_URL", wf_url, mold_dir)
        vals = pull_env(mold_dir)
        # eve api
        print("deploying eve api"); sync_env(API_ENV, vals, f"{proj}-api", mold_dir)
        api_url = sh("vercel deploy --prod --yes --local-config vercel.api.json 2>/dev/null | tail -1", cwd=mold_dir).strip()
        infra["vercel"]["api_url"] = api_url; print(f"  {api_url}")
        link(proj, mold_dir)
        if "NEXT_PUBLIC_EVE_API_URL" not in vercel_env_names(mold_dir): _add_env("NEXT_PUBLIC_EVE_API_URL", api_url, mold_dir)
        cfg_main = "vercel.json"
    else:
        v = load(os.path.join(mold_dir, "vercel.json")); v.pop("crons", None)
        cfg_main = "vercel.nocron.json"; save(os.path.join(mold_dir, cfg_main), v); infra["vercel"]["crons"] = "stripped (shared_with_live)"
    print("deploying web app")
    url = sh(f"vercel deploy --prod --yes --local-config {cfg_main} 2>/dev/null | tail -1", cwd=mold_dir).strip()
    infra["vercel"]["production_url"] = url; print(f"  {url}")

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
        sh(f"vercel link --yes --project {proj} >/dev/null 2>&1", cwd=mold_dir)
        present = vercel_env_names(mold_dir)
        present = provision_datastores(app_id, load(os.path.join(adir, "datastores.json")), mold_dir, present, infra)
        save(os.path.join(adir, "infrastructure.json"), infra)
    else:
        d = ensure_vm_scaffold(app_id, mold_dir, secrets)
        envf = os.path.join(d, ".env"); present = set()
        if os.path.exists(envf):
            present = {l.split("=")[0].strip() for l in open(envf) if "=" in l and not l.startswith("#") and l.split("=",1)[1].strip()}
        print(f"vm scaffold: {os.path.relpath(d, ROOT)}/ (Dockerfile, docker-compose.yml, .env.example)")
    user_s = infra.get("secrets_user", secrets); derived_s = infra.get("secrets_derived", [])
    missing_user = [x for x in user_s if x not in present]
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
