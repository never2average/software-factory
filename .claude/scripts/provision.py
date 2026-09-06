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

def ensure_vm_scaffold(app_id, mold_dir, secrets):
    d = os.path.join(ROOT, "infra/vm/apps", app_id); os.makedirs(d, exist_ok=True)
    df = os.path.join(d, "Dockerfile")
    if not os.path.exists(df):
        open(df, "w").write("""FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:22-bookworm-slim
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
    else:
        d = ensure_vm_scaffold(app_id, mold_dir, secrets)
        envf = os.path.join(d, ".env"); present = set()
        if os.path.exists(envf):
            present = {l.split("=")[0].strip() for l in open(envf) if "=" in l and not l.startswith("#") and l.split("=",1)[1].strip()}
        print(f"vm scaffold: {os.path.relpath(d, ROOT)}/ (Dockerfile, docker-compose.yml, .env.example)")
    missing = [s for s in secrets if s not in present]
    print(f"secrets present: {len(secrets)-len(missing)}/{len(secrets)}")
    if missing:
        print("missing (set these by name in the store, values never go in the repo):")
        for m in missing: print(f"  {m}")
    if not deploy:
        print("check only; re-run with --deploy once nothing is missing"); sys.exit(1 if missing else 0)
    if missing: sys.exit("refusing to deploy with missing secrets")
    app["status"] = "stamping"; save(os.path.join(adir, "application.json"), app)
    if target == "vercel":
        url = sh("vercel deploy --prod --yes 2>/dev/null | tail -1", cwd=mold_dir).strip()
        infra.setdefault("vercel", {})["production_url"] = url
        for cfg, suffix in (("vercel.api.json", "api"), ("vercel.eve.json", "workflow")):
            p = f"{proj}-{suffix}"
            sh(f"vercel link --yes --project {p} >/dev/null 2>&1", cwd=mold_dir)
            sh(f"vercel deploy --prod --yes --local-config {cfg} 2>/dev/null | tail -1", cwd=mold_dir)
        sh(f"vercel link --yes --project {proj} >/dev/null 2>&1", cwd=mold_dir)
    else:
        d = os.path.join(ROOT, "infra/vm/apps", app_id)
        out = sh("docker compose up -d --build 2>&1 | tail -3", cwd=d)
        infra["vm"]["production_url"] = f"http://{infra['vm'].get('host','localhost')}:3000"; print(out)
    infra["deployed_at"] = TODAY; save(os.path.join(adir, "infrastructure.json"), infra)
    app["status"] = "stamped"; save(os.path.join(adir, "application.json"), app)
    print(f"deployed: {infra.get('vercel',infra.get('vm',{})).get('production_url')}")
if __name__ == "__main__": main(sys.argv[1:])
