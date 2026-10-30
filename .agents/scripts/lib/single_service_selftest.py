#!/usr/bin/env python3
"""Offline checks of lib/single_service.py (mold_v0-028). Nothing is contacted: every SSH command, DNS answer and
health read goes to a stand-in, and every file is written in a temp directory. Run it as
`python3 .claude/scripts/lib/single_service_selftest.py`, or through `single_service.py --self-test` and
`provision.py --self-test`."""
import json, os, re, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import single_service as SS, vm_remote as VR

ROOT = SS.ROOT
COMPOSE = """name: shop
x-logging: &logging
  driver: json-file
services:
  postgres:
    image: docker.io/postgres:17
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?run bootstrap.sh}
  backup:
    image: docker.io/postgres:17
    command:
      - |
        echo $${BACKUP_KEEP} ${BACKUP_KEEP:-10}
  extra:
    image: x
    profiles: ["opt-in"]
    ports:
      - "9000:9000"
  app:
    build: { context: .., dockerfile: Dockerfile }
    environment:
      PUBLIC_URL: ${PUBLIC_URL:?set it}
      APP_VAULT_KEY: ${APP_VAULT_KEY:?run bootstrap.sh}
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@postgres:5432/app
      PAY_SECRET_KEY: ${PAY_SECRET_KEY:-}
      FEATURE: ${FEATURE:-on}
    expose: ["3333"]
  caddy:
    image: docker.io/caddy:2
    environment:
      DOMAIN: ${DOMAIN:-localhost}
    ports:
      - "${HTTP_PORT:-80}:80"
"""
BOOT = """#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
touch .env
grep -q '^POSTGRES_PASSWORD=keep-me' .env && { echo "a value reached the mint" >&2; exit 9; }
put() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }
put POSTGRES_PASSWORD "pw$RANDOM$RANDOM"
put APP_VAULT_KEY "$(head -c 32 /dev/urandom | base64 | tr -d '\\n')"
put DOMAIN "${DOMAIN:-localhost}"
put PUBLIC_URL "${PUBLIC_URL:-https://${DOMAIN:-localhost}}"
echo "ready"
"""
DOCKERFILE = "FROM node:22-slim\nCOPY package.json package-lock.json ./\nCOPY --from=web /x ./y\nCOPY src ./src\nHEALTHCHECK CMD true\nUSER node\n"
# mold_v0-020: the web console as a service of its own, built from the codebase root with a Dockerfile of its own.
CONSOLE_SERVICE = """  web:
    build:
      context: ..
      dockerfile: web/Dockerfile
      args:
        SHOP_API_URL: http://app:3333
        NEXT_PUBLIC_PAY_KEY: ${PAY_PUBLISHABLE_KEY:-}
    depends_on:
      app: { condition: service_healthy }
    environment:
      SHOP_API_URL: http://app:3333
      PAY_SECRET_KEY: ${PAY_SECRET_KEY:-}
    expose: ["3400"]
"""
CONSOLE_DOCKERFILE = "FROM node:22-slim AS build\nCOPY web/package.json web/package-lock.json ./\nCOPY web ./\nRUN true\nFROM node:22-slim\nCOPY --from=build /a ./\nUSER node\nHEALTHCHECK CMD true\n"

def fixture_mold(t, lockfile=True, console=False):
    """A one-service mold in a temp factory root: mold.json, a compose file, a Dockerfile, the mold's bootstrap. With
    console=True the stack also builds its web console (mold_v0-020): service `web` from web/Dockerfile; without it the
    mold names no console (mold.json compose.console removed), the shape before mold_v0-020."""
    cb = os.path.join(t, "molds", "mold_vx", "codebase")
    os.makedirs(os.path.join(cb, "deploy")); os.makedirs(os.path.join(cb, "src"))
    open(os.path.join(cb, "deploy", "docker-compose.prod.yml"), "w").write(COMPOSE.replace("  caddy:\n", CONSOLE_SERVICE + "  caddy:\n") if console else COMPOSE)
    if console:
        os.makedirs(os.path.join(cb, "web"), exist_ok=True); open(os.path.join(cb, "web", "Dockerfile"), "w").write(CONSOLE_DOCKERFILE)
        open(os.path.join(cb, "web", "package.json"), "w").write("{}\n"); open(os.path.join(cb, "web", "package-lock.json"), "w").write("{}\n")
    open(os.path.join(cb, "deploy", "bootstrap.sh"), "w").write(BOOT)
    open(os.path.join(cb, "Dockerfile"), "w").write(DOCKERFILE)
    open(os.path.join(cb, "package.json"), "w").write("{}\n")
    if lockfile: open(os.path.join(cb, "package-lock.json"), "w").write("{}\n")
    man = json.load(open(os.path.join(ROOT, "molds", "mold_v0", "mold.json"))); man["mold_id"] = "mold_vx"
    man.pop("source", None)    # mold_v0 is in-tree (mold_v0-040); this fixture stands for a mold with a source of its own
    if console: man["compose"]["console"] = {"service": "web", "pages": ["/admin", "/app"], "operator_env": {"PAY_PUBLISHABLE_KEY": "required", "PAY_SECRET_KEY": "required"}}
    else: man["compose"].pop("console", None)
    # A console that requires its sign-in keys (mold_v0 itself made them optional in mold_v0-004): the rehearsals below
    # check that a required key stops a deploy for the operator.
    man["vercel"]["projects"]["web"]["operator_env"] = {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": "required", "CLERK_SECRET_KEY": "required"}
    json.dump(man, open(os.path.join(t, "molds", "mold_vx", "mold.json"), "w"))
    os.makedirs(os.path.join(t, "state"))
    json.dump({"molds": [{"mold_id": "mold_vx", "source": {"commit": "c" * 40}}]}, open(os.path.join(t, "state", "factory.json"), "w"))
    return cb

def fixture_console(cb):
    """The console beside the fixture mold: a Next.js config that reads ONE variable for the API's address, its lockfile,
    and the API's own vercel.json and .vercelignore at the root."""
    os.makedirs(os.path.join(cb, "web"), exist_ok=True)
    open(os.path.join(cb, "web", "next.config.ts"), "w").write("const API = (process.env.SHOP_API_URL ?? 'http://127.0.0.1:3333').replace(/\\/$/, '');\nexport default { async rewrites() { return { fallback: [{ source: '/:path*', destination: `${API}/:path*` }] }; } };\n")
    open(os.path.join(cb, "web", "package.json"), "w").write('{"scripts": {"build": "next build"}}\n')
    open(os.path.join(cb, "web", "package-lock.json"), "w").write("{}\n")
    open(os.path.join(cb, "web", "vercel.json"), "w").write('{"framework": "nextjs"}\n')
    open(os.path.join(cb, "vercel.json"), "w").write('{"functions": {"api/index.ts": {}}, "crons": [{"path": "/api/cron/x", "schedule": "*/5 * * * *"}]}\n')
    open(os.path.join(cb, ".vercelignore"), "w").write("node_modules\nweb\n")

class Runner:
    """Stands in for every SSH and rsync call: records the argv and stdin, answers per step id."""
    def __init__(self, answers): self.answers, self.calls = answers, []
    def __call__(self, step, stdin=None):
        self.calls.append((step["id"], list(step["argv"] or []), stdin))
        rc, out = self.answers.get(step["id"], (0, ""))
        return subprocess.CompletedProcess(step["argv"], rc, out, "")

GOOD_FACTS = ("OS_ID=ubuntu\nOS_VERSION=24.04\nARCH=x86_64\nKVM=absent\nMEM_KB=8000000\nVCPU=4\nDISK_FREE_KB=90000000\nSUDO=ok\nDOCKER=present\n"
              "SYSTEMD=yes\nPROXY=none\nCOMPOSE=present\nWEB_LISTENERS=0\nWEB_HOLDER=none\n")
HEALTHY = "APP_STATE=healthy\nAPP_UID=1000\nPUBLISHED=caddy\nSERVING=20261020T000000Z\nDISK_PERCENT=31\n"

def rehearsal(ok):
    """The two-project Vercel deploy end to end through provision.py, as subprocesses in a throwaway factory, in a
    REHEARSAL (FACTORY_REHEARSAL, lib/services.py): `vercel`, `curl` and `gh` are fixtures/release/fake.py and any other
    outside name refuses. A dry run, the check, a first deploy, a console and then an API that fail their health (both
    projects back), a LIVE project, and the lanes' MCP address. Nothing real is called."""
    scripts = os.path.dirname(HERE); fake = os.path.join(scripts, "fixtures", "release", "fake.py")
    t = tempfile.mkdtemp(prefix="single-rehearsal-")
    try:
        shutil.copytree(scripts, os.path.join(t, ".claude", "scripts"), ignore=shutil.ignore_patterns("__pycache__"))
        cb = fixture_mold(t); fixture_console(cb)
        os.makedirs(os.path.join(cb, "node_modules", "pg")); open(os.path.join(cb, "node_modules", "pg", "package.json"), "w").write("{}")
        shutil.copytree(os.path.join(ROOT, "state", "application", "app_id"), os.path.join(t, "state", "application", "app_id"))
        f = json.load(open(os.path.join(t, "state", "factory.json"))); f["molds"][0].update(status="wip"); f["applications"] = ["zz_shop", "zz_live"]
        json.dump(f, open(os.path.join(t, "state", "factory.json"), "w"))
        def mkapp(app_id, base):
            docs = SS.shape_state(app_id, "mold_vx", "vercel", {"product_id": "zz_product"}, {"source": {"commit": "c" * 40}}, {"vercel_project": base, "platform_admins": "ops@example.com"}, {},
                                  f"briefs/{app_id}.md", {"vercel_team": "t"}, root=t)
            d = os.path.join(t, "state", "application", app_id); os.makedirs(d)
            for nm, doc in zip(("application", "infrastructure", "datastores", "datainfra"), docs): json.dump(doc, open(os.path.join(d, nm + ".json"), "w"), indent=2)
            return d
        a = mkapp("zz_shop", "zz-shop"); mkapp("zz_live", "zz-live")
        local = os.path.join(t, "local.json"); json.dump({"mold_sources": {"mold_vx": "https://github.com/acme/base.git"}, "live_projects": {"live api": "zz-live-api"}}, open(local, "w"))
        reh = os.path.join(t, ".reh"); b = os.path.join(reh, "bin"); priv = os.path.join(t, ".private"); os.makedirs(b); os.makedirs(priv)
        shutil.copy(fake, os.path.join(b, "fake.py")); os.chmod(os.path.join(b, "fake.py"), 0o755)
        for nm in ("vercel", "curl", "gh"): os.symlink("fake.py", os.path.join(b, nm))
        W = os.path.join(reh, "world.json")
        def world(**kw):
            w = json.load(open(W)) if os.path.exists(W) else {"projects": {}}
            w.update(kw); json.dump(w, open(W, "w")); return w
        # an earlier run connected the app's own database to its api project (the Neon path itself is checked above, against stand-ins)
        world(ci="green", projects={"zz-shop-api": {"id": "prj_zz-shop-api", "auto": True, "prod": None, "env": {"DATABASE_URL": "standin-database-address"}, "deps": []}})
        env = {k: v for k, v in os.environ.items() if not k.startswith("FACTORY_")}
        env.update(FACTORY_REHEARSAL=reh, FACTORY_PRIVATE_DIR=priv, FACTORY_LOCAL=local, PROVISION_MIN_FREE_MB="0", PROVISION_MAX_LOAD="100000",
                   PROVISION_HEADROOM_WAIT_S="0", PROVISION_ROLLBACK_POLL_S="0.05", PROVISION_ROLLBACK_WAIT_S="5", PROVISION_DEPLOY_POLL_S="0.2",
                   PROVISION_ADDRESS_WAIT_S="3", PROVISION_ADDRESS_POLL_S="0.1", PYTHONDONTWRITEBYTECODE="1")
        P = os.path.join(t, ".claude", "scripts", "provision.py")
        def go(*args):
            r = subprocess.run([sys.executable, P, *args], cwd=t, env=env, capture_output=True, text=True, timeout=300)
            return r.returncode, r.stdout + r.stderr
        W_ = lambda: json.load(open(W)); calls = lambda: open(W + ".calls").read() if os.path.exists(W + ".calls") else ""
        st = lambda: json.load(open(os.path.join(a, "application.json"))); inf = lambda: json.load(open(os.path.join(a, "infrastructure.json")))
        prod = lambda: {n: p.get("prod") for n, p in W_()["projects"].items()}
        api_u, web_u = "https://zz-shop-api.rehearsal.invalid", "https://zz-shop.rehearsal.invalid"
        code, out = go("zz_shop", "--deploy", "--dry-run")
        ok(code == 0 and "zz-shop-api" in out and "SHOP_API_URL" in out and "BOTH projects" in out and set(W_()["projects"]) == {"zz-shop-api"} and "project add" not in calls(),
           f"rehearsal: --deploy --dry-run shows both projects, the API-address variable and the rollback, and creates nothing: {out[-400:]}")
        code, out = go("zz_shop", "--json")
        ok(code == 3 and '"needs_human"' in out and "CLERK_SECRET_KEY" in out and "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" in out and set(W_()["projects"]) == {"zz-shop-api"},
           f"rehearsal: the check stops for the console's two sign-in keys, creating nothing: {out[-400:]}")
        # mold_v0-037 (2): --deploy without them stops for a person (exit 3, the keys in `needs`) before any project is made; not reverted
        before_calls = calls(); code, out = go("zz_shop", "--deploy", "--json")
        try: d_ = json.loads(out[out.index("{"):])
        except ValueError: d_ = {}
        ok(code == 3 and d_.get("status") == "needs_human" and {n_.get("name") for n_ in d_.get("needs") or []} >= {"CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"}
           and set(W_()["projects"]) == {"zz-shop-api"} and "\"add\"" not in calls()[len(before_calls):] and "\"deploy\"" not in calls()[len(before_calls):] and st().get("status") != "reverted" and "revert" not in st(),
           f"rehearsal: --deploy without the console's sign-in keys: needs_human, exit 3, nothing created, not reverted: {code} {d_.get('status')} {sorted(W_()['projects'])} {calls()[len(before_calls):][-300:]} {st().get('status')}")
        # what --set-secret leaves behind (it is checked against stand-ins below): the console project, created empty, holding both keys
        clerk = {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": "pk_standin", "CLERK_SECRET_KEY": "sk_standin"}
        w0 = W_(); w0["projects"]["zz-shop"] = {"id": "prj_zz-shop", "auto": True, "prod": None, "env": dict(clerk), "deps": []}
        w0["projects"]["zz-shop-api"]["env"]["CLERK_SECRET_KEY"] = "sk_standin"; json.dump(w0, open(W, "w"))
        code, out = go("zz_shop")
        ok(code == 0 and "Ready" in out and set(W_()["projects"]) == {"zz-shop-api", "zz-shop"}, f"rehearsal: with both keys set the check is read-only and ready: {out[-400:]}")
        w0 = W_(); w0["projects"]["zz-shop"]["env"]["DATABASE_URL"] = "standin-old-database"; json.dump(w0, open(W, "w"))
        code, out = go("zz_shop", "--deploy")
        ok(code != 0 and "not a console project" in out and "DATABASE_URL" in out and "deploy" not in calls(),
           f"rehearsal: a console project holding the API's names (the one-project shape) is refused before any deploy: {out[-300:]}")
        w0 = W_(); w0["projects"]["zz-shop"]["env"].pop("DATABASE_URL"); json.dump(w0, open(W, "w"))
        st_ = st(); st_["status"] = "stamped"; json.dump(st_, open(os.path.join(a, "application.json"), "w"), indent=2)
        code, out = go("zz_shop", "--deploy")
        w = W_(); v = inf().get("vercel") or {}
        ok(code == 0 and st()["status"] == "stamped" and v.get("projects") == {"api": "zz-shop-api", "web": "zz-shop"} and v.get("api_url") == api_u and v.get("production_url") == web_u
           and (v.get("health") or {}).get("pages") == {"/admin": "307", "/app": "307"} and inf().get("deployed_at"), f"rehearsal: a first deploy serves both projects: {out[-700:]} {v}")
        ok(w["projects"]["zz-shop"]["env"] == dict(clerk, SHOP_API_URL=api_u) and w["projects"]["zz-shop"].get("framework") == "nextjs"
           and w["projects"]["zz-shop-api"]["env"].get("PUBLIC_URL") == api_u and "APP_VAULT_KEY" in w["projects"]["zz-shop-api"]["env"],
           f"rehearsal: the console holds the API's address and nothing else; the API its database, keys and own address: {sorted(w['projects']['zz-shop']['env'])}")
        lines = [json.loads(l) for l in calls().splitlines()]
        dep = [x["argv"][x["argv"].index("--project") + 1] for x in lines if x.get("tool") == "vercel" and x["argv"][:1] == ["deploy"]]
        adds = [" ".join(x["argv"]) for x in lines if x.get("tool") == "vercel" and x["argv"][:2] == ["project", "add"]]
        ok(dep.index("zz-shop") > 0 and set(dep[:dep.index("zz-shop")]) == {"zz-shop-api"} and dep[dep.index("zz-shop") + 1:] == ["zz-shop-api"] and adds == [],
           f"rehearsal: the API deploys first, then the console, into the project --set-secret made, then the API once more with the console's address: {dep} {adds}")
        ok(w["projects"]["zz-shop-api"]["env"].get("APP_CONSOLE_URL") == web_u and w["projects"]["zz-shop-api"]["env"].get("APP_PROXY_HOPS") == "1"
           and "APP_CONSOLE_URL" not in w["projects"]["zz-shop"]["env"] and w["projects"]["zz-shop-api"]["env"].get("APP_PLATFORM_ADMINS") == "ops@example.com"
           and "APP_PLATFORM_ADMINS" not in w["projects"]["zz-shop"]["env"] and "OCTILLION_PLATFORM_ADMINS" not in w["projects"]["zz-shop-api"]["env"],
           f"rehearsal: the API holds the console's address (its emails link to the console), its one proxy and the app's platform administrator (the new name only, on a new app); the console holds none (mold_v0-084): {sorted(w['projects']['zz-shop-api']['env'])}")
        r = subprocess.run([sys.executable, os.path.join(t, ".claude", "scripts", "lib", "single_service.py"), "lane-key-path", "zz_shop"], cwd=t, env=env, capture_output=True, text=True)
        ok(r.returncode == 1 and api_u in r.stderr and web_u not in r.stderr, f"rehearsal: the lanes' MCP check is for the API's address: {r.stderr.strip()[-200:]}")
        good = prod()
        world(fault={"zz-shop": "health"}); code, out = go("zz_shop", "--deploy")
        rb = inf()["vercel"].get("rollback") or {}
        ok(code == 1 and prod() == good and st()["status"] == "reverted" and rb.get("result") == "rolled back" and rb.get("health") == {"web": "200", "api": "200"} and "does not reach the API" in out,
           f"rehearsal: a console that fails its health puts BOTH projects back on what served before: {out[-500:]} {rb}")
        n_web = len(W_()["projects"]["zz-shop"]["deps"])
        world(fault={"zz-shop-api": "health"}); code, out = go("zz_shop", "--deploy")
        ok(code == 1 and prod() == good and len(W_()["projects"]["zz-shop"]["deps"]) == n_web and "/healthz answered HTTP 500" in out,
           f"rehearsal: an API that fails its health: back on what served before, and the console is never deployed: {out[-400:]}")
        code, out = go("zz_shop", "--deploy")
        ok(code == 0 and st()["status"] == "stamped" and all(prod()[n] != good[n] for n in good), f"rehearsal: the next good deploy is promoted past the rollback on both projects: {out[-400:]}")
        before = calls()
        code, out = go("zz_live", "--deploy")
        new = calls()[len(before):]
        ok(code == 1 and "LIVE" in out and "zz-live" not in new, f"rehearsal: an app whose API project would be a LIVE one is refused before Vercel hears its name: {out[-300:]}")
    except BaseException as e_: ok(False, f"rehearsal: crashed: {type(e_).__name__}: {e_}"[:400])
    finally:
        shutil.rmtree(t, ignore_errors=True)

def run():
    n, fails = [0], []
    def ok(cond, what):
        n[0] += 1
        if not cond: fails.append(what)
    # --- 1. which molds are single-service, and what the snapshot's own files say -------------------------------
    ok(SS.manifest("mold_v0") is not None and SS.manifest("mold_v1") is None, "mold_v0 declares the single-service shape; mold_v1 does not")
    P = SS.parse_compose(COMPOSE)
    ok(P["name"] == "shop" and set(P["services"]) == {"postgres", "backup", "extra", "app", "caddy"}, f"compose services and default name: {P['name']} {sorted(P['services'])}")
    names = {r[0] for r in P["refs"]}
    ok("BACKUP_KEEP" in names and sum(1 for r in P["refs"] if r[0] == "BACKUP_KEEP") == 1, "$${...} is compose's escape, not a reference")
    ok(P["services"]["app"]["required_reads"] == ["PUBLIC_URL", "APP_VAULT_KEY"], f"names the app reads whole and requires: {P['services']['app']['required_reads']}")
    ok(SS.bootstrap_names(BOOT) == ["APP_VAULT_KEY", "DOMAIN", "POSTGRES_PASSWORD", "PUBLIC_URL"], "the names a bootstrap script puts")
    ok(SS.dockerfile_sources(DOCKERFILE) == ["package.json", "package-lock.json", "src"], f"build-context sources: {SS.dockerfile_sources(DOCKERFILE)}")
    real = SS.compose_facts(SS.codebase("mold_v0"), SS.manifest("mold_v0"))
    ok(real["service"] and real["default_project"] and real["port"] and real["healthcheck"], "mold_v0's snapshot: one built API service, a default project, a port, a HEALTHCHECK")
    # mold_v0-020: the console is the stack's second built service, its own image, behind Caddy, holding no secret at build
    RK = real.get("console") or {}
    ok(RK.get("service") == "console" and RK.get("dockerfile") == "web/Dockerfile" and RK.get("present") and RK.get("healthcheck") and RK.get("port")
       and RK.get("pages") == ["/admin", "/app"] and SS.built_services(real) == [real["service"], "console"],
       f"mold_v0's stack builds its web console as a service of its own (web/Dockerfile, a HEALTHCHECK, a port, read after a deploy): {RK}")
    ok("console" not in real["publishers"], f"the console publishes no port (Caddy alone does): {real['publishers']}")
    # mold_v0-004: the console's Clerk keys are optional (the built-in sign-in by default); the required-key path is
    # rehearsed with the fixture's own required names below.
    ok(RK.get("required") == [] and RK.get("optional") == ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] and SS.secret_names(real, "compose_remote")[0] == []
       and {"CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"} <= set(SS.secret_names(real, "compose_remote")[2]), f"on its own server the console's Clerk keys are optional: {SS.secret_names(real, 'compose_remote')}")
    ctext = open(os.path.join(SS.codebase("mold_v0"), real["file"])).read(); args = []
    for blk in re.findall(r"(?m)^      args:\n((?:        .+\n)+)", ctext): args += re.findall(r"^\s+([A-Z0-9_]+):\s*(.*)$", blk, re.M)
    ok(args and all(not SS.CRED.search(re.sub(r"PUBLISHABLE_KEY", "", v)) for _, v in args) and all("PASSWORD" not in v and "SECRET" not in v and "VAULT" not in v for _, v in args),
       f"no build argument in mold_v0's compose file carries a secret (Next.js writes build arguments into the image): {args}")
    cblock = (re.search(r"(?ms)^  console:\n(.*?)(?=^  [a-z])", ctext) or [None, ""])[1]
    ok(re.search(r"(?m)^    networks: \[edge\]$", cblock) and "DATABASE_URL" not in cblock and "VAULT" not in cblock and "TOKEN" not in cblock and "\n    ports:" not in cblock,
       "the console is on the edge network only (Caddy and the API, never the database), holds no database URL, vault key or token, and publishes nothing")
    wdf = open(os.path.join(SS.codebase("mold_v0"), "web", "Dockerfile")).read()
    ok(re.search(r"(?m)^USER node$", wdf) and "CLERK_SECRET_KEY" not in re.sub(r"(?m)^#.*$", "", wdf) and "--from=web" not in open(os.path.join(SS.codebase("mold_v0"), "Dockerfile")).read(),
       "the console's image runs as node, never sees the sign-in secret at build, and the API's image no longer copies a static export that is never built")
    caddy = open(os.path.join(SS.codebase("mold_v0"), "deploy", "Caddyfile")).read()
    api_paths = (re.search(r"(?m)^\s*@api path (.+)$", caddy) or [None, ""])[1].split()
    ok({"/mcp", "/mcp/*", "/api/*", "/gw/*", "/.well-known/*"} <= set(api_paths) and "/healthz" not in api_paths and "name console" in caddy and "name api" in caddy,
       f"Caddy sends the API's own paths (MCP, /api, the gateway's streams) to the API and everything else, /healthz included, through the console: {api_paths}")
    ok(not [x for x in real["required"] if x not in real["config"] and x not in real["minted"]], "every name mold_v0's compose file requires is written from state or minted by its bootstrap")
    ok(real["publishers"] == ["caddy"] or len(real["publishers"]) == 1, f"one service publishes ports in mold_v0's stack: {real['publishers']}")
    t = tempfile.mkdtemp(prefix="single-selftest-"); home_was = os.environ.get("HOME"); priv_was = os.environ.get("FACTORY_PRIVATE_DIR")
    try:
        cb = fixture_mold(t); man = SS.manifest("mold_vx", t); F = SS.compose_facts(cb, man)
        ok(F["service"] == "app" and F["port"] == "3333" and F["publishers"] == ["caddy"], f"fixture facts: {F['service']} {F['port']} {F['publishers']} (a profile-gated service is not a publisher)")
        ok(F["required"] == ["APP_VAULT_KEY", "POSTGRES_PASSWORD", "PUBLIC_URL"] and F["optional_secrets"] == ["PAY_SECRET_KEY"], f"required {F['required']} optional secrets {F['optional_secrets']}")
        u, d, o = SS.secret_names(F, "compose_remote"); ok(u == [] and d == ["APP_VAULT_KEY", "POSTGRES_PASSWORD"] and o == ["PAY_SECRET_KEY"], f"compose_remote names: {u} {d} {o}")
        u, d, o = SS.secret_names(F, "vercel"); ok(u == [] and d == ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"], f"vercel names: nothing typed by hand, the database provisioned: {u} {d}")
        # --- 2. preflight: a missing build input, a name nobody provides, a project that is not the app's own --------
        app = {"app_id": "zz_shop", "mold_id": "mold_vx", "status": "planned"}
        infra = {"target": "compose_remote", "secrets_user": [], "compose_remote": {"host": "203.0.113.7", "domain": "shop.example.org", "ssh_key_ref": "sf_zz_shop",
                 "compose": {"project": "sf-zz-shop", "file": F["file"]}}}
        S = SS.settings("zz_shop", app, infra, t)
        ok(SS.preflight(cb, F, S) == [], f"a complete fixture passes preflight: {SS.preflight(cb, F, S)}")
        ok(any("shop" in p and "never" in p for p in SS.preflight(cb, F, dict(S, project="shop"))), "the compose file's own project name is refused")
        ok(SS.preflight(cb, F, dict(S, project="other")), "a project that is not sf-<app> is refused")
        os.remove(os.path.join(cb, "package-lock.json"))
        ok(SS.missing_build_inputs(cb, F) == ["package-lock.json"] and SS.preflight(cb, F, S), "a file the image build copies but the snapshot lacks stops the deploy before contact")
        open(os.path.join(cb, "package-lock.json"), "w").write("{}\n")
        ok(SS.preflight(cb, dict(F, minted=[]), S), "a required name neither state nor the bootstrap provides is refused")
        ok(SS.missing_build_inputs(SS.codebase("mold_v0"), real) == [],
           f"mold_v0's snapshot has every file its image build copies (web/package-lock.json, committed upstream for mold_v0-029): {SS.missing_build_inputs(SS.codebase('mold_v0'), real)}")
        # --- 3. state: intake's shape validates for both targets; validate's rules refuse what they must -------------
        sys.path.insert(0, os.path.dirname(HERE)); import factory
        prod = {"product_id": "mcp_product_shell"}; mold = {"source": {"commit": "c" * 40}}
        for target in SS.TARGETS:
            docs = SS.shape_state("zz_shape", "mold_v0", target, prod, mold, {"domain": "shape.example.org", "vercel_project": "zz-shape", "platform_admins": "Ops@example.com, *@example.org"}, {}, "briefs/zz_shape.md")
            ok(docs[0].get("platform_admins") == ["ops@example.com", "*@example.org"], f"intake's answer reaches application.platform_admins ({target}): {docs[0].get('platform_admins')}")
            d = os.path.join(t, "apps", "zz_shape"); os.makedirs(d, exist_ok=True)
            for nm, doc in zip(("application", "infrastructure", "datastores", "datainfra"), docs): json.dump(doc, open(os.path.join(d, nm + ".json"), "w"))
            errs, _ = factory._app_errors("zz_shape", d)
            ok(errs == [], f"intake's shape for target {target} validates: {errs[:3]}")
        a0, i0, d0, _ = SS.shape_state("zz_shape", "mold_v0", "compose_remote", prod, mold, {"domain": "shape.example.org"}, {}, "b")
        ok(i0["compose_remote"]["compose"]["project"] == "sf-zz-shape" and i0["secrets_user"] == []
           and {"CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"} <= set(i0["secrets_optional"]) and i0["compose_remote"]["compose"].get("console") == "console"
           and d0["postgres"]["exposure"] == "compose_network", f"compose_remote state: own project, no operator value (the console's Clerk keys optional, mold_v0-004), database on the compose network: {i0['secrets_user']}")
        docs = {"application": a0, "infrastructure": i0, "datastores": d0}
        bad = lambda f: SS.problems("zz_shape", f(json.loads(json.dumps(docs))))
        def proj(x): x["infrastructure"]["compose_remote"]["compose"]["project"] = "another-stack"; return x
        def url(x): x["infrastructure"]["compose_remote"]["production_url"] = "https://shape.example.org"; return x
        def m1(x): x["application"]["mold_id"] = "mold_v1"; return x
        def tgt(x): x["infrastructure"]["target"] = "vm_remote"; return x
        ok(SS.problems("zz_shape", docs) == [], "the shape itself has no problems")
        ok(bad(proj), "a compose project that is not sf-<app> is refused by validate")
        ok(any("deployed_at" in e for e in bad(url)), "production_url without deployed_at is refused")
        ok(any("not" in e and "single_service" in e for e in bad(m1)), "compose_remote on a mold that is not single-service is refused")
        ok(bad(tgt), "a single-service app on vm_remote is refused")
        # --- 4. the host: what disqualifies it ----------------------------------------------------------------------
        facts = VR.parse_kv(GOOD_FACTS)
        ok(SS.qualify(facts, S) == [], f"a fit server (Docker present, no KVM) qualifies: {SS.qualify(facts, S)}")
        ok(SS.qualify(dict(facts, WEB_LISTENERS="2", WEB_HOLDER="sf-zz-shop"), S) == [], "web ports held by this app's own project are fine (a redeploy)")
        why = SS.qualify(dict(facts, WEB_LISTENERS="4", WEB_HOLDER="another-stack"), S)
        ok(why and "another-stack" in why[0] and "never stops" in why[0], "web ports held by another compose project (a live copy) refuse the server")
        ok(SS.qualify(dict(facts, WEB_LISTENERS="1", WEB_HOLDER="none"), S), "web ports held outside Docker refuse the server")
        ok(SS.qualify(dict(facts, MEM_KB="2000000"), S) and SS.qualify(dict(facts, PROXY="nginx"), S), "too little memory, or another web server, refuse it")
        ok(SS.qualify({k: v for k, v in facts.items() if k != "WEB_HOLDER"}, S), "an unread fact refuses it")
        # --- 5. the health verdict ---------------------------------------------------------------------------------
        kv = VR.parse_kv(HEALTHY); pub = ("200", {"ok": True}, "")
        ok(SS.health_verdict(F, kv, pub) == [], "healthy, not root, only caddy publishing, public 200 ok")
        ok(SS.health_verdict(F, dict(kv, APP_UID="0"), pub), "an app running as root fails health")
        ok(SS.health_verdict(F, dict(kv, PUBLISHED="caddy,postgres"), pub), "a database publishing a port fails health")
        ok(SS.health_verdict(F, kv, ("502", None, "bad gateway")) and SS.health_verdict(F, kv, ("200", {"ok": False}, "")), "a 502, or ok false, fails health")
        ok(SS.health_verdict(F, dict(kv, APP_STATE="unhealthy"), pub), "an unhealthy container fails health")
        # --- 6. the generated scripts: always the app's own project, they parse ---------------------------------------
        B = SS.bundle(S, F)
        for f in ("up.sh", "health.sh"):
            ok("-p sf-zz-shop" in B[f][0] and "-p shop" not in B[f][0], f"{f} names the app's own compose project and never the file's default")
        ok("SF_REMOTE_DEPLOY" in B["up.sh"][0] and "ROLLED_BACK=" in B["up.sh"][0], "up.sh refuses without the deploy's marker and switches back on failure")
        out = os.path.join(t, "bundle"); SS.write_bundle(S, F, out)
        ok(SS.rehearse(out) == [], f"the bundle rehearses clean: {SS.rehearse(out)}")
        ok(os.path.isfile(os.path.join(out, ".claude", "scripts", "lib", "single_service.py")) and not os.path.exists(os.path.join(out, ".claude", "scripts", "lib", "single_service_selftest.py")),
           "the bundle carries the server-side tool and never this test")
        ok("-p sf-zz-shop" in " ".join(SS.lane_key_argv(S, F, man)), "the lane key runs in the app's own project")
        # --- 7. a whole deploy against stand-ins ----------------------------------------------------------------------
        os.environ["HOME"] = os.path.join(t, "home"); os.makedirs(os.path.join(t, "home", ".ssh"))
        open(os.path.join(t, "home", ".ssh", "sf_zz_shop"), "w").write("stand-in\n")
        R = Runner({"qualify": (0, GOOD_FACTS), "names": (0, "POSTGRES_PASSWORD\n"), "up": (0, "UP=ok\nSERVING=20261020T000000Z\n"), "health": (0, HEALTHY)})
        said = []; reads = []
        res = SS.deploy(S, F, cb, runner=R, secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"], read_public=lambda u: reads.append(u) or ("200", {"ok": True}, ""),
                        say=said.append, release="20261020T000000Z", wait=lambda s: None)
        ids = [c[0] for c in R.calls]
        ok(ids == ["qualify", "bundle", "packages", "firewall", "names", "release-dir", "source", "up", "health", "keep"] or ids == ["qualify", "bundle", "packages", "firewall", "names", "release-dir", "source", "env", "up", "health", "keep"],
           f"the deploy's steps, in order: {ids}")
        env = next(c for c in R.calls if c[0] == "env")
        ok(env[2] == "DOMAIN=shop.example.org\nPUBLIC_URL=https://shop.example.org\nAPP_CONSOLE_URL=https://shop.example.org\nAPP_PROXY_HOPS=1\n",
           f"the env step gets state's settings on stdin, the console's address (one address serves both on a server: emails link to it) and the one proxy (the stack's Caddy) among them (mold_v0-084): {env[2]!r}")
        ok(all("-p sf-zz-shop" not in " ".join(c[1]) or "shop " not in " ".join(c[1]) for c in R.calls), "no step names the default project")
        # platform administrators on a server of its own: written to the env file from state; while none is recorded the
        # name is not sent (whatever the env file holds is kept); a first deploy with none at all stops for the operator
        ok(SS.config_pairs(dict(S, admins="ops@example.com,*@example.org"), F).get("APP_PLATFORM_ADMINS") == "ops@example.com,*@example.org"
           and "APP_PLATFORM_ADMINS" not in SS.config_pairs(S, F) and SS.settings("zz_shop", dict(app, platform_admins=["ops@example.com"]), infra, t)["admins"] == "ops@example.com",
           "compose_remote: the administrators reach the env file only when recorded")
        import agent_result as AR
        for deployed in (False, True):
            AR.reset(); said = []; i_c = dict(infra, **({"deployed_at": "2026-10-20T00:00:00+00:00"} if deployed else {}))
            SS.check("zz_shop", app, i_c, os.path.join(t, "no-such-app"), say=said.append, root=t)
            txt = "\n".join(said)
            ok((SS.ADMIN_MARK in txt and [n_["name"] for n_ in AR.NOTES["needs"]] == ["platform administrator address"]) if not deployed
               else (SS.ADMIN_MARK not in txt and not AR.NOTES["needs"] and "keeps whatever APP_PLATFORM_ADMINS holds" in txt),
               f"compose_remote check with no administrator recorded: {'kept and said (deployed before)' if deployed else 'asked for (never deployed)'}: {[l for l in said if 'administrator' in l]}")
        AR.reset()
        ok(reads == ["https://shop.example.org/healthz"] and res["health"]["public"] == "200" and res["release"] == "20261020T000000Z", f"the public health read: {reads}")
        # mold_v0-024: an app with packs or a brand sends build/<app_id>/ (made afresh just before contact), never the codebase
        src_step = next(st for st in SS.plan(S, F, SS.source_for("zz_shop", {"mold_id": "mold_vx", "packs": ["shop_notes"]}, t)) if st["id"] == "source")
        mf_src = open(os.path.join(HERE, "single_service.py")).read()
        ok(any(os.path.join(t, "build", "zz_shop") + "/" in str(x) for x in src_step["argv"])
           and mf_src.index("src = build_source(app_id, app, root, say=say)") < mf_src.index("res = deploy(S, F, src, say=say)")
           and mf_src.index("_ready_to_contact(S, app_id)\n        src = build_source") > 0,
           f"compose_remote: a packed app's source step sends its build copy, built after the contact check and before the deploy: {src_step['argv'][-3:]}")
        # an operator value travels on stdin only
        R2 = Runner(dict(R.answers)); S2 = dict(S, secrets_user=["PAY_SECRET_KEY"])
        SS.deploy(S2, F, cb, runner=R2, secrets_for=lambda m: {"PAY_SECRET_KEY": "sk-standin-123456"}, resolver=lambda d: ["203.0.113.7"],
                  read_public=lambda u: ("200", {"ok": True}, ""), say=said.append, release="20261020T000001Z", wait=lambda s: None)
        ok(not any("sk-standin-123456" in " ".join(c[1]) for c in R2.calls) and "PAY_SECRET_KEY=sk-standin-123456" in next(c[2] for c in R2.calls if c[0] == "env")
           and not any("sk-standin-123456" in s for s in said), "an operator's value goes on the env step's stdin only, never in an argv or a printed line")
        # failures: a server that is not fit, DNS elsewhere, an up that switched back, a public 502
        def stop(**kw):
            try:
                SS.deploy(S, F, cb, **dict(dict(runner=Runner(dict(R.answers)), secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"],
                          read_public=lambda u: ("200", {"ok": True}, ""), say=lambda s: None, release="20261020T000002Z", wait=lambda s: None), **kw))
                return ""
            except SS.Stop as e: return str(e)
        ok("cannot run the stack" in stop(runner=Runner({"qualify": (0, GOOD_FACTS.replace("WEB_LISTENERS=0", "WEB_LISTENERS=4").replace("WEB_HOLDER=none", "WEB_HOLDER=another-stack"))})),
           "a server whose web ports another stack holds stops the deploy at qualify")
        ok("points at" in stop(resolver=lambda d: ["198.51.100.9"]), "a domain pointing elsewhere stops the deploy before anything is installed")
        ok("switched back by itself" in stop(runner=Runner(dict(R.answers, up=(1, "UP=failed\nROLLED_BACK=20261019T000000Z\n")))), "an up that failed and switched back says so")
        ok("THE SITE IS DOWN" in stop(runner=Runner(dict(R.answers, up=(1, "UP=failed\nROLLBACK_FAILED=20261019T000000Z\n")))), "an up whose switch back failed says the site is down")
        waits = []
        ok("does not serve" in stop(read_public=lambda u: ("502", None, "bad gateway"), wait=waits.append) and waits, "a public 502 (after waiting for the certificate) stops with the rollback command")
        # --- 7a. the web console as a service of the stack (mold_v0-020) -------------------------------------------------
        try:
            tc = os.path.join(t, "with-console"); cbc = fixture_mold(tc, console=True); manc = SS.manifest("mold_vx", tc); FC = SS.compose_facts(cbc, manc)
            KC = FC["console"]
            ok(FC["service"] == "app" and KC["service"] == "web" and KC["dockerfile"] == "web/Dockerfile" and KC["port"] == "3400" and KC["healthcheck"]
               and SS.built_services(FC) == ["app", "web"] and FC["publishers"] == ["caddy"], f"a stack with a console: the API is still the service, the console is the second built one: {FC['service']} {KC}")
            ok(SS.parse_compose(open(os.path.join(cbc, FC["file"])).read())["services"]["app"]["dockerfile"] == "Dockerfile", "an inline build's Dockerfile is read")
            ok({"web/Dockerfile", "web/package.json", "web/package-lock.json", "web"} <= set(FC["dockerfile_sources"]), f"the console's build inputs are checked before contact too: {FC['dockerfile_sources']}")
            os.remove(os.path.join(cbc, "web", "Dockerfile"))
            FC2 = SS.compose_facts(cbc, manc); SC0 = dict(SS.settings("zz_shop", app, dict(infra, secrets_user=["PAY_PUBLISHABLE_KEY", "PAY_SECRET_KEY"]), tc))
            ok(any("web/Dockerfile" in p_ for p_ in SS.preflight(cbc, FC2, SC0)), f"a console Dockerfile the snapshot lacks stops the deploy before contact: {SS.preflight(cbc, FC2, SC0)}")
            open(os.path.join(cbc, "web", "Dockerfile"), "w").write(CONSOLE_DOCKERFILE)
            u, d, o = SS.secret_names(FC, "compose_remote")
            ok(u == ["PAY_PUBLISHABLE_KEY", "PAY_SECRET_KEY"] and "PAY_SECRET_KEY" not in o, f"the console's sign-in names are the operator's to give on its own server: {u} {o}")
            ok(SS.preflight(cbc, FC, SC0) == [], f"state listing them passes preflight: {SS.preflight(cbc, FC, SC0)}")
            why = SS.preflight(cbc, FC, dict(SC0, secrets_user=[]))
            ok(why and "PAY_PUBLISHABLE_KEY" in why[0] and "secrets_user" in why[0], f"state that does not list them is refused before contact, saying what to add: {why}")
            ok(SS.preflight(cb, F, S) == [], "a mold with no console asks for no sign-in names (the shape before mold_v0-020)")
            try: SS.compose_facts(cbc, dict(manc, compose=dict(manc["compose"], console={"service": "nope"}))); bad_c = ""
            except SS.Stop as e_: bad_c = str(e_)
            ok("nope" in bad_c, f"a console mold.json names but the compose file does not build is refused: {bad_c}")
            # the generated scripts: both services built one at a time, both judged on the server
            BC = SS.bundle(SC0, FC)
            ok("for s in app web; do" in BC["up.sh"][0] and BC["up.sh"][0].count("if upw; then") == 3 and "&& fresh" in BC["up.sh"][0],
               "up.sh builds the API, then the console, one at a time, then brings the stack up and refreshes stale mounted files (every path)")
            ok("CONSOLE_STATE=" in BC["health.sh"][0] and "dc ps -q web" in BC["health.sh"][0] and "APP_STATE=" in BC["health.sh"][0], "health.sh reads the console's container as it reads the API's")
            ok("APP_STATE" not in "".join(l for l in B["health.sh"][0].splitlines() if "CONSOLE" in l) and "CONSOLE_STATE" not in B["health.sh"][0], "a stack without a console reads no console")
            outc = os.path.join(t, "bundle-console"); SS.write_bundle(SC0, FC, outc); ok(SS.rehearse(outc) == [], f"the console bundle rehearses clean: {SS.rehearse(outc)}")
            HC = HEALTHY + "CONSOLE_STATE=healthy\nCONSOLE_UID=1000\n"; kvc = VR.parse_kv(HC)
            pages_ok = {"/admin": ("307", ""), "/app": ("307", "")}
            ok(SS.health_verdict(FC, kvc, pub, pages_ok) == [], f"both containers healthy, not root; /healthz through the console; pages redirect to sign-in: {SS.health_verdict(FC, kvc, pub, pages_ok)}")
            ok(any("web container runs as root" in x for x in SS.health_verdict(FC, dict(kvc, CONSOLE_UID="0"), pub, pages_ok)), "a console running as root fails health")
            ok(any("web container is unhealthy" in x for x in SS.health_verdict(FC, dict(kvc, CONSOLE_STATE="unhealthy"), pub, pages_ok)), "an unhealthy console fails health")
            ok(any("web container is absent" in x for x in SS.health_verdict(FC, {k: v for k, v in kvc.items() if not k.startswith("CONSOLE")}, pub, pages_ok)), "a console that is not there fails health")
            ok(any("/admin answered HTTP 500" in x for x in SS.health_verdict(FC, kvc, pub, dict(pages_ok, **{"/admin": ("500", "")}))), "a console page answering 500 fails health")
            ok(any("/app answered nothing" in x for x in SS.health_verdict(FC, kvc, pub, dict(pages_ok, **{"/app": ("", "nothing answered")}))), "a console page answering nothing fails health")
            ok(any("console does not reach the API" in x for x in SS.health_verdict(FC, kvc, ("502", None, "bad gateway"), pages_ok)), "/healthz failing through the console says the console does not reach the API")
            ok(any("web container runs as root" in x for x in SS.health_verdict(FC, dict(kvc, CONSOLE_UID="0"), pub, pages_ok)) and not SS.health_verdict(F, kv, pub), "the console's checks apply only to a stack with a console")
            # a whole deploy: the pages are read from outside, without following a redirect, and recorded
            os.makedirs(os.path.join(tc, "home", ".ssh"), exist_ok=True)
            RC = Runner(dict(R.answers, health=(0, HC))); seen_pages = []
            resc = SS.deploy(SC0, FC, cbc, runner=RC, secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"], read_public=lambda u: ("200", {"ok": True}, ""),
                             read_page=lambda u: seen_pages.append(u) or ("307", ""), say=lambda s_: None, release="20261020T000020Z", wait=lambda s_: None)
            ok(seen_pages == ["https://shop.example.org/admin", "https://shop.example.org/app"] and resc["health"]["pages"] == {"/admin": "307", "/app": "307"}
               and resc["health"]["console"] == "healthy" and resc["health"]["console_uid"] == "1000", f"the deploy reads the console's pages and records them: {seen_pages} {resc['health']}")
            RC2 = Runner(dict(R.answers, health=(0, HC), back=(0, "ROLLED_BACK=20261019T000000Z\nSERVING=20261019T000000Z\n")))
            try:
                SS.deploy(SC0, FC, cbc, runner=RC2, secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"], read_public=lambda u: ("200", {"ok": True}, ""),
                          read_page=lambda u: ("502", "") if u.endswith("/admin") else ("307", ""), say=lambda s_: None, release="20261020T000021Z", wait=lambda s_: None); msg = ""
            except SS.Stop as e_: msg = str(e_)
            ok("/admin answered HTTP 502" in msg and "switched back by itself" in msg and [c[0] for c in RC2.calls][-1] == "back",
               f"a console page that fails: the server goes back to the release before, by itself: {msg[:200]}")
            # the record fits the schema (validate's own reading)
            ix = {"target": "compose_remote", "compose_remote": {"health": resc["health"]}}
            sch = json.load(open(os.path.join(ROOT, "state", "application", "app_id", "infrastructure.schema.json")))["properties"]["compose_remote"]["properties"]["health"]["properties"]
            ok(set(resc["health"]) <= set(sch), f"every health field the deploy writes is in the schema: {sorted(set(resc['health']) - set(sch))}")
        except BaseException as e_: ok(False, f"the console as a service: crashed: {type(e_).__name__}: {e_}"[:400])
        # --- 7b. row-level security on the deployed database (mold_v0-051) ---------------------------------------------
        real_spec = SS.rls_spec(SS.codebase("mold_v0"), SS.manifest("mold_v0"))
        ok(real_spec and real_spec["script"] == "check:rls" and real_spec["mode"] == "fail_closed", f"mold_v0 declares the product's own RLS check, and its package.json has it: {real_spec}")
        ok(SS.rls_spec(cb, man) is None and F.get("rls") is None, "a codebase without that script asks for no RLS check (the fixture)")
        ok(SS.shape_state("zz_rls", "mold_v0", "compose_remote", {"product_id": "p"}, {"source": {"commit": "c" * 40}}, {}, {}, "briefs/zz_rls.md")[2]["postgres"]["rls"] == "fail_closed"
           and SS.shape_state("zz_rls", "mold_vx", "compose_remote", {"product_id": "p"}, {"source": {"commit": "c" * 40}}, {}, {}, "briefs/zz_rls.md", root=t)[2]["postgres"]["rls"] == "off",
           "intake writes postgres.rls 'fail_closed' for mold_v0 (its check exists), 'off' for a mold without one")
        cbx = os.path.join(t, "rls-cb"); os.makedirs(cbx); json.dump({"scripts": {"check:rls": "tsx scripts/check-rls.ts"}}, open(os.path.join(cbx, "package.json"), "w"))
        spec = SS.rls_spec(cbx, man); FR = dict(F, rls=spec)
        steps = {st["id"]: st for st in SS.plan(S, FR, cb)}
        ok("rls" in steps and "-p sf-zz-shop" in " ".join(steps["rls"]["argv"]) and "run --rm -T --no-deps" in " ".join(steps["rls"]["argv"]) and "npm run --silent check:rls" in " ".join(steps["rls"]["argv"])
           and "rls" not in {st["id"] for st in SS.plan(S, F, cb)}, "the plan runs the RLS check in a one-off container of the app's own project, only when the mold declares it")
        PASS = "RLS CHECK PASS (postgres): every tenant table has row-level security; live probe 58 checks, nothing crossed"
        ok(not SS.rls_passed(0, PASS.replace("(postgres)", "(pglite)"), spec) and SS.rls_passed(0, PASS, spec),
           "a PASS from the product's embedded fallback (pglite: no DATABASE_URL reached it) never counts at a deploy")
        R5 = Runner(dict(R.answers, rls=(0, ".env not found\n" + PASS + "\n")))
        res5 = SS.deploy(S, FR, cb, runner=R5, secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"], read_public=lambda u: ("200", {"ok": True}, ""),
                         say=lambda s_: None, release="20261020T000005Z", wait=lambda s_: None)
        ids5 = [c[0] for c in R5.calls]
        ok(res5["rls"]["passed"] and res5["rls"]["said"] == PASS and ids5.index("rls") > ids5.index("health") and "back" not in ids5, f"compose: the RLS check runs after health and passes: {ids5}")
        for what, ans in (("a failing check", (1, "RLS CHECK FAIL (postgres):\n  products: A reads B's product by id\n")), ("a check that printed no PASS", (0, "")),
                          ("a check that could not run", (127, "npm: not found"))):
            R6 = Runner(dict(R.answers, rls=ans, back=(0, "ROLLED_BACK=20261019T000000Z\nSERVING=20261019T000000Z\n")))
            try:
                SS.deploy(S, FR, cb, runner=R6, secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"], read_public=lambda u: ("200", {"ok": True}, ""),
                          say=lambda s_: None, release="20261020T000006Z", wait=lambda s_: None); msg = ""
            except SS.Stop as e: msg = str(e); ok(getattr(e, "rls", None) and not e.rls["passed"], f"compose: {what}: the failed verdict travels with the stop, so it is recorded")
            ok("row-level security check failed" in msg and "switched back by itself" in msg and [c[0] for c in R6.calls][-1] == "back",
               f"compose: {what} is a failed health check: the server goes back to the release before ({msg[:200]})")
        # --- 7c. the upstream catalogs' index after a deploy (mold_v0-128): said and recorded, never a failed deploy ------
        real_cat = SS.catalogs_spec(SS.codebase("mold_v0"), SS.manifest("mold_v0"))
        ok(real_cat and real_cat["script"] == "catalogs:index", f"mold_v0 declares the catalogs' index, and its package.json has it: {real_cat}")
        ok(SS.catalogs_spec(cb, man) is None and F.get("catalogs") is None, "a codebase without that script asks for no catalogs index (the fixture)")
        json.dump({"scripts": {"check:rls": "tsx scripts/check-rls.ts", "catalogs:index": "tsx scripts/catalogs-index.ts"}}, open(os.path.join(cbx, "package.json"), "w"))
        cspec = SS.catalogs_spec(cbx, {"catalogs": {"script": "catalogs:index", "said": "CATALOGS INDEX:"}}); FCAT = dict(FR, catalogs=cspec)
        csteps = [st["id"] for st in SS.plan(S, FCAT, cb)]
        ok("catalogs" in csteps and csteps.index("catalogs") > csteps.index("rls") and "npm run --silent catalogs:index" in " ".join({st["id"]: st for st in SS.plan(S, FCAT, cb)}["catalogs"]["argv"])
           and "catalogs" not in [st["id"] for st in SS.plan(S, FR, cb)], f"the plan indexes the catalogs after the RLS check, in a one-off container, only when declared: {csteps}")
        CSAID = "CATALOGS INDEX: maxwell_catalogs indexed (regulators 12, controls 340); rows now: controls 340, regulators 12"
        for what, ans, want in (("an index that ran", (0, "  maxwell/maxwell_catalogs: indexed\n" + CSAID + "\n"), CSAID), ("an index that failed", (1, "boom: the database is unreachable"), "boom: the database is unreachable")):
            R7 = Runner(dict(R.answers, rls=(0, PASS + "\n"), catalogs=ans))
            res7 = SS.deploy(S, FCAT, cb, runner=R7, secrets_for=lambda m: {}, resolver=lambda d: ["203.0.113.7"], read_public=lambda u: ("200", {"ok": True}, ""),
                             say=lambda s_: None, release="20261020T000007Z", wait=lambda s_: None)
            ids7 = [c[0] for c in R7.calls]
            ok(res7["catalogs"] == {"exit": ans[0], "said": want} and ids7.index("catalogs") > ids7.index("rls") and "back" not in ids7,
               f"compose: {what}: said and returned, never a failed deploy: {res7.get('catalogs')} {ids7}")
        adc = os.path.join(t, "cat-app"); os.makedirs(adc); json.dump({"target": "compose_remote"}, open(os.path.join(adc, "infrastructure.json"), "w"))
        SS.record_catalogs(adc, CSAID, 0, "by provision.py --deploy-remote")
        ci = json.load(open(os.path.join(adc, "infrastructure.json")))["catalog_index"]
        ok(ci["said"] == CSAID and ci["exit"] == 0 and "+00:00" in ci["at"], f"the index's summary lands in infrastructure.json catalog_index: {ci}")
        class PVC:
            def pull_env(self, cb_, proj, required=False, environment="production"): return {"DATABASE_URL": "postgres://u:p@db.invalid/x"}
        bdir = os.path.join(t, "cat-build"); os.makedirs(os.path.join(bdir, "node_modules", ".bin")); open(os.path.join(bdir, "node_modules", ".bin", "tsx"), "w").close()
        ran = []
        rc, said = SS.catalogs_vercel(PVC(), cbx, bdir, "zz-shop-api", cspec, run=lambda d, u, sp, timeout=0: ran.append((d, u, sp["script"])) or (0, "x\n" + CSAID))
        ok(rc == 0 and said == CSAID and ran == [(bdir, "postgres://u:p@db.invalid/x", "catalogs:index")], f"vercel: the index runs from the build copy against the api project's database: {ran} {said}")
        rc, said = SS.catalogs_vercel(PVC(), cbx, bdir, "zz-shop-api", cspec, run=lambda *a, **k: (_ for _ in ()).throw(OSError("no npm")))
        ok(rc is None and said.startswith("not run"), f"vercel: an index that cannot run is said, never raised: {said}")
        adr = os.path.join(t, "rls-app"); os.makedirs(adr); json.dump({"postgres": {"provider": "self_hosted", "rls": "fail_closed"}}, open(os.path.join(adr, "datastores.json"), "w"))
        ev = SS.record_rls(adr, spec, True, PASS, "by provision.py --deploy-remote", "enforced", "ran in a one-off container.")
        stored = json.load(open(os.path.join(adr, "datastores.json")))["postgres"]["rls_verified"]
        ok(stored == ev and ev["mode"] == "fail_closed" and ev["backend"] == "self_hosted" and ev["source"].startswith(SS.RLS_SOURCE) and ev["running_app"] == "enforced" and "+00:00" in ev["at"],
           f"the evidence lands in datastores.postgres.rls_verified: {ev}")
        ev = SS.record_rls(adr, spec, False, "RLS CHECK FAIL", "by provision.py --verify-rls", "enforced", "x")
        ok(ev["mode"] == "off" and ev["running_app"] == "not_enforced" and "FAILED" in ev["source"], "a failed check is recorded as such, never with the asked-for mode")
        class PV:
            def __init__(self, env): self.env = env
            def pull_env(self, cb_, proj, required=False, environment="production"): return dict(self.env)
        seen = []
        def run_ok(cb_, url_, spec_): seen.append(url_); return 0, PASS
        pv = SS.rls_vercel(PV({"DATABASE_URL": "postgres://u:p@db.invalid/x"}), cbx, "zz-shop-api", spec, {"ok": True, "rls_probe": "not run"}, run_ok)
        ok(pv[0] and pv[2] == "unmeasured" and "not run" in pv[3] and seen == ["postgres://u:p@db.invalid/x"] and "postgres://" not in pv[1] + pv[3],
           f"vercel: the check runs against the api project's database; the function's probe 'not run' is recorded unmeasured, never enforced: {pv}")
        ok(SS.rls_vercel(PV({"DATABASE_URL": "postgres://u:p@db.invalid/x"}), cbx, "a", spec, {"rls_probe": "ok"}, run_ok)[2] == "enforced", "  ...the function's own probe 'ok': enforced")
        bad = SS.rls_vercel(PV({"DATABASE_URL": "postgres://u:p@db.invalid/x"}), cbx, "a", spec, {"rls_probe": "failed"}, run_ok)
        ok(not bad[0] and bad[2] == "not_enforced", "  ...the function's own probe 'failed': not passed, whatever the check said")
        ok(not SS.rls_vercel(PV({"DATABASE_URL": "x"}), cbx, "a", spec, {}, lambda c_, u_, s_: (1, "RLS CHECK FAIL (postgres): x"))[0], "  ...a failing check: not passed")
        try: SS.rls_vercel(PV({}), cbx, "a", spec, {}, run_ok); ok(False, "no database address refuses")
        except SS.Stop as e: ok("could not be read back" in str(e), "  ...no DATABASE_URL to read back: refused, never passed")
        ok(SS.rls_tools_missing(cbx, spec) and SS.rls_tools_missing(cbx, None) is None, "vercel: the check needs the mold's dependencies on this machine, and says how to install them")
        # --- 8. on the server: the env file is merged, minted by the mold's own script, values never leave it ----------
        ef = os.path.join(t, "etc", "env"); os.makedirs(os.path.dirname(ef)); VR.env_write(ef, {"POSTGRES_PASSWORD": "keep-me"})
        lines = []
        rc = SS.server_env(ef, os.path.join(cb, "deploy", "bootstrap.sh"), "DOMAIN=shop.example.org\nPUBLIC_URL=https://shop.example.org\n", say=lines.append)
        vals = VR.env_read(ef)
        ok(rc == 0 and vals["POSTGRES_PASSWORD"] == "keep-me" and len(vals.get("APP_VAULT_KEY", "")) >= 40 and vals["DOMAIN"] == "shop.example.org",
           f"server env: kept the existing value, minted the missing one with the mold's own script, wrote state's settings ({rc}, {sorted(vals)})")
        ok(oct(os.stat(ef).st_mode & 0o777) == "0o600" and "keep-me" not in " ".join(lines) and vals["APP_VAULT_KEY"] not in " ".join(lines), "the env file is mode 600 and no value is printed")
        again = []; SS.server_env(ef, os.path.join(cb, "deploy", "bootstrap.sh"), "", say=again.append)
        ok(VR.env_read(ef) == vals and "nothing" in again[-1], "a second run mints nothing and changes nothing")
        # mold_v0-045: a server's env file from before then holds the old names: each value is carried to its new name once,
        # before anything is minted, so the bootstrap mints nothing over a key the server holds (the new name would win).
        NEWp, LEGp = F["aliases"]
        ef2 = os.path.join(t, "etc2", "env"); os.makedirs(os.path.dirname(ef2)); VR.env_write(ef2, {"POSTGRES_PASSWORD": "keep-me", LEGp + "VAULT_KEY": "old-key-" + "k" * 36, LEGp + "AUTOSCALE": "off", NEWp + "PROXY_HOPS": "1", LEGp + "PROXY_HOPS": "2"})
        l2 = []
        rc2 = SS.server_env(ef2, os.path.join(cb, "deploy", "bootstrap.sh"), "DOMAIN=shop.example.org\n", say=l2.append, aliases=F["aliases"])
        v2 = VR.env_read(ef2)
        ok(rc2 == 0 and v2[NEWp + "VAULT_KEY"] == "old-key-" + "k" * 36 and v2[NEWp + "AUTOSCALE"] == "off" and v2[NEWp + "PROXY_HOPS"] == "1" and v2[LEGp + "VAULT_KEY"] == "old-key-" + "k" * 36
           and "old-key" not in " ".join(l2) and any("carried" in x for x in l2),
           f"server env with the old names: each value carried to its new name (the vault key kept, an operator's setting kept), a new name already set left alone, the old lines kept, no value printed: {l2}")
        snap = VR.env_read(ef2); SS.server_env(ef2, os.path.join(cb, "deploy", "bootstrap.sh"), "", say=lambda s_: None, aliases=F["aliases"])
        ok(VR.env_read(ef2) == snap, "a second run carries and mints nothing")
        ef3 = os.path.join(t, "etc3", "env"); os.makedirs(os.path.dirname(ef3)); VR.env_write(ef3, {LEGp + "VAULT_KEY": "old-key-" + "k" * 36})
        SS.server_env(ef3, os.path.join(cb, "deploy", "bootstrap.sh"), "", say=lambda s_: None)
        ok(VR.env_read(ef3).get(NEWp + "VAULT_KEY") not in (None, "old-key-" + "k" * 36), "(without the aliases a new key would be minted beside the old one: why the deploy passes them)")
        env_step = next(st for st in SS.plan(S, F, cb) if st["id"] == "env")
        ok(f"--alias {LEGp}={NEWp}" in " ".join(env_step["argv"]), f"the deploy's env step passes the mold's aliases to the server: {env_step['argv'][-1][-160:]}")
        mv = SS.mint_values(cb, F, ["APP_VAULT_KEY", "CRON_SECRET"])
        ok(set(mv) == {"APP_VAULT_KEY", "CRON_SECRET"} and len(mv["CRON_SECRET"]) == 64, "Vercel's values: minted by the mold's own script, CRON_SECRET beside them")
        # --- 9. set-secret: declared names only, no $ sign, the value on stdin ----------------------------------------
        class P:   # the parts of provision.py set_secret_remote reaches
            @staticmethod
            def explain(n): pass
        R3 = Runner({}); S3 = dict(S, secrets_optional=["PAY_SECRET_KEY"])
        SS.set_secret_remote("zz_shop", S3, "PAY_SECRET_KEY", P, runner=R3, value="sk-standin-abcdef", say=lambda s: None)
        ok(R3.calls[0][2] == "PAY_SECRET_KEY=sk-standin-abcdef\n" and "sk-standin-abcdef" not in " ".join(R3.calls[0][1]), "set-secret sends NAME=value on stdin, never in the command")
        R4 = Runner({}); S4 = dict(S, secrets_optional=[F["aliases"][1] + "JOURNEY_SECRET"])
        SS.set_secret_remote("zz_shop", S4, F["aliases"][1] + "JOURNEY_SECRET", P, runner=R4, value="js-standin-1234", say=lambda s: None)
        ok(R4.calls[0][2] == f"{F['aliases'][1]}JOURNEY_SECRET=js-standin-1234\n{F['aliases'][0]}JOURNEY_SECRET=js-standin-1234\n",
           f"set-secret on an old name writes its new spelling too (the deploy carried the old value there, and the app reads it first): {R4.calls[0][2]!r}")
        for name, val, what in (("NOT_DECLARED", "x1234", "an undeclared name"), ("PAY_SECRET_KEY", "a$b1234", "a $ sign")):
            try: SS.set_secret_remote("zz_shop", S3, name, P, runner=Runner({}), value=val, say=lambda s: None); ok(False, f"set-secret refuses {what}")
            except SS.Stop: ok(True, "")
        # --- 9b. Vercel: TWO projects (mold_v0-029): refusals, scope, names, the database, deploy order, health, rollbacks --
        fixture_console(cb)
        class FakeP:
            """provision.py's Vercel helpers over a dict of projects, recorded; nothing is contacted."""
            def __init__(self, refuse=None, projects=(), env=None, health=None, before=None, base_choice=None):
                self.calls = []; self.refuse = refuse; self._db_stat = "REAL"; self.base_choice = base_choice
                self.projects = {p: {"env": {}, "framework": None} for p in projects}
                for p, names in (env or {}).items(): self.projects.setdefault(p, {"env": {}, "framework": None})["env"].update({n: "standin" for n in names})
                self.health = health or {}; self.before = before or {}; self.ndeploy = {}; self.rolled = False; self.sticky = False
            def _rec(self, *a): self.calls.append(a)
            def _refuse_live_or_shared_project(self, app_id, infra):
                self._rec("refuse", infra["vercel"]["project"])
                if self.refuse: raise SystemExit(self.refuse)
            def _project_meta(self, proj, cb): return {"id": "prj_" + proj, "framework": self.projects[proj]["framework"]} if proj in self.projects else {}
            def choose_project_base(self, app_id, base, infra, cb): self._rec("choose", base); return self.base_choice or (base, "")
            def vrun(self, cmd, **k):
                self._rec("vrun", cmd); m = re.match(r"vercel project add (\S+)", cmd)
                if m: self.projects.setdefault(m.group(1), {"env": {}, "framework": None})
                return subprocess.CompletedProcess(cmd, 0, "", "")
            def disconnect_git(self, proj, cb): self._rec("disconnect", proj)
            def set_framework(self, proj, fw, cb): self._rec("framework", proj, fw); self.projects[proj]["framework"] = fw
            def vercel_env_names(self, cb, proj): return set((self.projects.get(proj) or {"env": {}})["env"])
            def ask_nicely_for(self, *a): self._rec("ask", a)
            def adopt_or_create_neon(self, app_id, cb, infra, proj):
                self._rec("neon", proj, self._db_stat != "REAL"); self.projects[proj]["env"]["DATABASE_URL"] = "standin"; infra.setdefault("datastores", {})["neon_resource"] = "zz-db"
            def _set_env(self, n, v, cb, project=None): self._rec("set_env", project, n); self.projects[project]["env"][n] = v
            def _link_dir(self, proj, cb):
                d = tempfile.mkdtemp(dir=t); os.makedirs(os.path.join(d, ".vercel")); open(os.path.join(d, ".vercel", "project.json"), "w").write(json.dumps({"projectName": proj})); return d
            def production_of(self, proj, cb):
                cur = self.before.get(proj) if not self.ndeploy.get(proj) else f"dpl_{proj}_{self.ndeploy[proj]}"
                return {"project": proj, "project_id": "prj_" + proj, "id": cur, "created": 1}
            def vercel_deploy(self, cmd, cwd, label):
                proj = re.search(r"--project (\S+)", cmd).group(1); self.ndeploy[proj] = self.ndeploy.get(proj, 0) + 1
                self._rec("deploy", proj, os.path.relpath(cwd, t), cmd); return f"Production: https://{proj}-x.vercel.app"
            def promote_new(self, before, cb, roles): self._rec("promote", roles)
            def _deployed_address(self, proj, out, cb, infra): return f"https://{proj}.vercel.app"
            def pull_env(self, cb, proj, required=False, environment="production"): return dict((self.projects.get(proj) or {"env": {}})["env"])
            def _read_health(self, url):   # a fault lives in this run's deployment: once rolled back it serves again, unless sticky
                self._rec("health", url)
                code = next((c for k, c in self.health.items() if url.startswith(k)), "200") if (not self.rolled or self.sticky) else "200"
                return (code, {"ok": code == "200"}, "")
            def _point_production(self, rec, dep, cb, how): self._rec("point", rec["project"], dep, how); self.rolled = True; return True, "ok"
            def _vapi(self, path, cb, method="GET", timeout=60):   # only asked when _project_meta found nothing: Vercel's not-found
                self._rec("vapi", path)
                return (1, {}, "Error: not signed in") if getattr(self, "unreadable", False) else (1, {"error": {"code": "not_found", "message": "Project not found"}}, "Project not found")
            def explain(self, n): pass
            def trusted_stdin(self): return False
            def stop_for_human(self, msg): raise SystemExit(3)
        pages = lambda codes: (lambda url: (next((c for k, c in codes.items() if url.endswith(k)), "307"), ""))
        try:
            va = {"app_id": "zz_shop", "mold_id": "mold_vx", "status": "planned", "platform_admins": ["ops@example.com", "*@example.org"]}
            vi = {"target": "vercel", "secret_store": "vercel_env", "secrets_user": [], "secrets_derived": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"],
                  "secrets_optional": ["PAY_SECRET_KEY", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"], "vercel": {"team": "team-x", "project": "zz-shop"}}
            vdir = os.path.join(t, "vapp"); os.makedirs(vdir)
            cp = lambda x: json.loads(json.dumps(x))
            K = SS.console_facts(cb, man)
            ok(K["api_env"] == "SHOP_API_URL" and K["lockfile"] and SS.console_preflight(K) == [], f"the console's API-address variable is read from its next.config: {K}")
            for args in (["zz_shop", "--set-secret", "PAY_SECRET_KEY"], ["zz_shop", "--deploy"], ["zz_shop"], ["zz_shop", "--lane-key", "--yes"]):
                fp = FakeP(refuse="zz_shop: vercel.project is a LIVE project. Nothing was written.")
                rc = SS.main_for("zz_shop", args, dict(va), cp(vi), {}, vdir, fp, say=lambda s: None, root=t)
                ok(rc == 1 and fp.calls and all(c[0] == "refuse" for c in fp.calls),
                   f"{' '.join(args[1:]) or 'check'}: a LIVE or another app's project is refused before anything reads or writes it: {fp.calls[:3]}")
            # another app holds this app's API project name (<base>-api) as its own base: refused, whatever provision.py's base check says
            od = os.path.join(t, "state", "application", "zz_other"); os.makedirs(od)
            json.dump({"vercel": {"project": "zz-shop-api"}}, open(os.path.join(od, "infrastructure.json"), "w")); json.dump({"status": "stamped"}, open(os.path.join(od, "application.json"), "w"))
            fp = FakeP(); said = []
            rc = SS.main_for("zz_shop", ["zz_shop", "--deploy"], dict(va), cp(vi), {}, vdir, fp, say=said.append, root=t)
            ok(rc == 1 and "zz_other" in " ".join(said) and "zz-shop-api" in " ".join(said) and [c[0] for c in fp.calls] == ["refuse"],
               f"a project name another app holds (its base is this app's <base>-api) is refused before anything else: {said[-1:]} {fp.calls}")
            shutil.rmtree(od)
            bad_rec = cp(vi); bad_rec["vercel"]["projects"] = {"api": "someone-api", "web": "zz-shop"}
            try: SS.refuse_project("zz_shop", bad_rec, FakeP(), t); ok(False, "vercel.projects that the base does not give is refused")
            except SS.Stop: ok(True, "")
            # set-secret: each name onto the project(s) that read it, created under the team scope when absent
            ok(SS.project_for(F, K, "PAY_SECRET_KEY") == ["api"] and SS.project_for(F, K, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") == ["web"]
               and SS.project_for(F, dict(K, optional=K["optional"] + ["PAY_SECRET_KEY"]), "PAY_SECRET_KEY") == ["api", "web"] and SS.project_for(F, K, "DATABASE_URL") == ["api"],
               "each name goes to the project that reads it: the API's keys to the api project, the console's sign-in keys to the console, both when both read it")
            fp = FakeP()
            SS.set_secret_vercel("zz_shop", va, cp(vi), "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", fp, root=t, value="pk_standin_xyz")
            ok(("vrun", "vercel project add zz-shop --scope team-x") in fp.calls and ("set_env", "zz-shop", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") in fp.calls
               and not any(c[0] == "set_env" and c[1] == "zz-shop-api" for c in fp.calls), f"a console sign-in key lands on the console only, made under the team scope: {fp.calls}")
            fp = FakeP(); SS.set_secret_vercel("zz_shop", va, cp(vi), "PAY_SECRET_KEY", fp, root=t, value="sk-standin-xyz")
            ok(("set_env", "zz-shop-api", "PAY_SECRET_KEY") in fp.calls and not any(c[0] == "set_env" and c[1] == "zz-shop" for c in fp.calls), f"an API key lands on the api project only: {fp.calls}")
            for nm in ("DATABASE_URL", "NOT_READ"):
                try: SS.set_secret_vercel("zz_shop", va, cp(vi), nm, FakeP(), root=t, value="x1234"); ok(False, f"{nm} is refused by --set-secret")
                except SS.Stop: ok(True, "")
            # the two projects: created under the team scope, unhooked from git, the console's preset set; a taken base suffixed and recorded
            fp = FakeP(); inf = cp(vi)
            names = SS.ensure_projects("zz_shop", inf, cb, K, fp, say=lambda s: None, root=t)
            ok(names == {"api": "zz-shop-api", "web": "zz-shop"} and ("vrun", "vercel project add zz-shop-api --scope team-x") in fp.calls
               and ("vrun", "vercel project add zz-shop --scope team-x") in fp.calls and ("disconnect", "zz-shop-api") in fp.calls and ("disconnect", "zz-shop") in fp.calls
               and ("framework", "zz-shop", "nextjs") in fp.calls and not any(c[0] == "framework" and c[1] == "zz-shop-api" for c in fp.calls)
               and inf["vercel"]["projects"] == names, f"both projects made under the team scope, unhooked from git, the console a Next.js project: {fp.calls}")
            fp = FakeP(base_choice=("zz-shop-team", "zz-shop.vercel.app is someone else's, so the projects are named zz-shop-team, zz-shop-team-api, zz-shop-team-workflow")); inf = cp(vi); said = []
            names = SS.ensure_projects("zz_shop", inf, cb, K, fp, say=said.append, root=t)
            ok(names == {"api": "zz-shop-team-api", "web": "zz-shop-team"} and inf["vercel"]["project"] == "zz-shop-team" and inf["vercel"]["name_history"][0]["from"] == "zz-shop"
               and not any(c[0] == "vrun" and c[1].endswith(("add zz-shop --scope team-x", "add zz-shop-api --scope team-x")) for c in fp.calls) and "zz-shop-team-api" in said[0],
               f"a base taken on vercel.app: both projects take the free base provision.py chooses, recorded, and said: {said} {fp.calls}")
            fp = FakeP(projects=["zz-shop-api"]); SS.ensure_projects("zz_shop", cp(vi), cb, K, fp, say=lambda s: None, root=t)
            ok(not any(c[0] == "choose" for c in fp.calls) and ("vrun", "vercel project add zz-shop --scope team-x") in fp.calls, "with one project already there, the base is kept and only the other is made")
            # mold_v0-037 (1): --set-secret, when it is the first thing to create a project, goes through the same free-base choice
            sd = os.path.join(t, "ssapp"); os.makedirs(sd, exist_ok=True)
            fp = FakeP(base_choice=("zz-shop-team", "zz-shop.vercel.app is someone else's, so the projects are named zz-shop-team, zz-shop-team-api, zz-shop-team-workflow")); inf = cp(vi)
            SS.set_secret_vercel("zz_shop", va, inf, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", fp, root=t, value="pk_standin_xyz", adir=sd, say=lambda s_: None)
            saved = json.load(open(os.path.join(sd, "infrastructure.json")))
            ok(("choose", "zz-shop") in fp.calls and ("vrun", "vercel project add zz-shop-team --scope team-x") in fp.calls
               and not any(c[0] == "vrun" and c[1].startswith("vercel project add zz-shop ") for c in fp.calls)
               and fp.calls.index(("choose", "zz-shop")) < fp.calls.index(("vrun", "vercel project add zz-shop-team --scope team-x"))
               and ("set_env", "zz-shop-team", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") in fp.calls
               and saved["vercel"]["project"] == "zz-shop-team" and saved["vercel"]["name_history"][0]["from"] == "zz-shop"
               and saved["vercel"]["projects"] == {"api": "zz-shop-team-api", "web": "zz-shop-team"},
               f"--set-secret creating the first project takes the free base provision.py chooses, recorded before anything is made: {fp.calls}")
            fp = FakeP(base_choice=(None, "no free name: zz-shop: taken")); inf = cp(vi)
            try: SS.set_secret_vercel("zz_shop", va, inf, "PAY_SECRET_KEY", fp, root=t, value="sk-standin-xyz", adir=sd, say=lambda s_: None); ok(False, "--set-secret with no free base is refused")
            except SS.Stop as e_: ok("refusing to create" in str(e_) and not any(c[0] in ("vrun", "set_env") for c in fp.calls), f"--set-secret with no free base is refused, nothing created or stored: {fp.calls}")
            fp = FakeP(projects=["zz-shop"], base_choice=("zz-shop-team", "taken")); inf = cp(vi)
            SS.set_secret_vercel("zz_shop", va, inf, "PAY_SECRET_KEY", fp, root=t, value="sk-standin-xyz", adir=sd, say=lambda s_: None)
            ok(not any(c[0] == "choose" for c in fp.calls) and ("set_env", "zz-shop-api", "PAY_SECRET_KEY") in fp.calls, "--set-secret next to an existing project keeps the base")
            # mold_v0-037 (2): --deploy without the console's required sign-in keys stops for a person BEFORE any project is made or renamed
            vneed = cp(vi); vneed["secrets_user"] = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]
            vneed["secrets_optional"] = ["PAY_SECRET_KEY"]
            nd = os.path.join(t, "needapp"); os.makedirs(nd, exist_ok=True); a_need = dict(va); said = []
            fp = FakeP(base_choice=("zz-shop-team", "taken"))
            rc = SS.main_for("zz_shop", ["zz_shop", "--deploy"], a_need, vneed, {}, nd, fp, say=said.append, root=t)
            asked = [c for c in fp.calls if c[0] == "ask"]
            ok(rc == 1 and asked and set(asked[0][1][1]) == {"CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"}
               and not any(c[0] in ("choose", "vrun", "set_env", "deploy", "neon") for c in fp.calls) and vneed["vercel"]["project"] == "zz-shop"
               and a_need.get("status") == "planned" and "revert" not in a_need and not os.path.exists(os.path.join(nd, "application.json")),
               f"--deploy without the required sign-in keys asks for them before any project is made or renamed, and is not reverted: {said[-1:]} {fp.calls}")
            fp = FakeP(projects=["zz-shop-api", "zz-shop"], env={"zz-shop": ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]})
            rc = SS.main_for("zz_shop", ["zz_shop", "--deploy"], dict(va), cp(vneed), {}, nd, fp, say=lambda s_: None, root=t)
            asked = [c for c in fp.calls if c[0] == "ask"]
            ok(rc == 1 and asked and asked[0][1][1] == ["CLERK_SECRET_KEY"] and not any(c[0] in ("vrun", "deploy") for c in fp.calls),
               f"with the projects there, only the names they do not hold are asked for: {asked}")
            fp = FakeP(); fp.unreadable = True; said = []; a_un = dict(va)
            rc = SS.main_for("zz_shop", ["zz_shop", "--deploy"], a_un, cp(vneed), {}, nd, fp, say=said.append, root=t)
            ok(rc == 1 and not any(c[0] in ("ask", "vrun", "choose") for c in fp.calls) and "could not be read from Vercel" in " ".join(said),
               f"a Vercel that cannot be read (not signed in) is never taken for empty projects: no keys asked for, nothing made: {said[-1:]} {fp.calls}")
            # a cancelled --set-secret (no value read) leaves the name choice unrecorded and nothing made
            cd = os.path.join(t, "cancelapp"); os.makedirs(cd, exist_ok=True)
            fp = FakeP(base_choice=("zz-shop-team", "taken"))
            try: SS.set_secret_vercel("zz_shop", va, cp(vi), "PAY_SECRET_KEY", fp, root=t, adir=cd, say=lambda s_: None); ok(False, "a piped --set-secret stops")
            except (SystemExit, SS.Stop): ok(not os.path.exists(os.path.join(cd, "infrastructure.json")) and not any(c[0] in ("vrun", "set_env") for c in fp.calls),
                                             f"a --set-secret with no value records no new name and makes nothing: {fp.calls}")
        except BaseException as e_: ok(False, f"the Vercel projects: refusals, scope and names: crashed: {type(e_).__name__}: {e_}"[:300])
        # the database: provisioned on the api project when absent (provision.py's Neon path, emptiness read with the mold's own client), never rewritten
        try:
            os.makedirs(os.path.join(cb, "node_modules", "pg")); open(os.path.join(cb, "node_modules", "pg", "package.json"), "w").write("{}")
            fp = FakeP(env={"zz-shop-api": ["APP_VAULT_KEY", "CRON_SECRET", "PUBLIC_URL"]}); inf = cp(vi)
            ok(SS.ensure_database("zz_shop", inf, cb, "zz-shop-api", fp.vercel_env_names(cb, "zz-shop-api"), fp, say=lambda s: None) and ("neon", "zz-shop-api", True) in fp.calls
               and fp._db_stat == "REAL" and not any(c[0] == "set_env" and c[2] == "DATABASE_URL" for c in fp.calls),
               f"no DATABASE_URL: the app's own Neon database, its emptiness read with the mold's client, the reader put back, DATABASE_URL never written here: {fp.calls}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL"]})
            ok(not SS.ensure_database("zz_shop", inf, cb, "zz-shop-api", {"DATABASE_URL"}, fp) and not any(c[0] == "neon" for c in fp.calls), "a DATABASE_URL already there is kept (written once)")
        except BaseException as e_: ok(False, f"the database: provisioned when absent (provision.py's Neon: crashed: {type(e_).__name__}: {e_}"[:300])

        # whole two-project deploys against FakeP
        try:
            api_u, web_u = "https://zz-shop-api.vercel.app", "https://zz-shop.vercel.app"
            def vdeploy(fp, read=pages({}), inf=None):
                a_ = dict(va); i_ = inf or cp(vi); err = ""
                try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s: None, root=t, read_page=read)
                except SS.Stop as e: err = str(e)
                return a_, i_, err
            fp = FakeP(projects=["zz-shop-api", "zz-shop"])
            a_, i_, err = vdeploy(fp)
            deploys = [c for c in fp.calls if c[0] == "deploy"]; v_ = i_["vercel"]
            ok(not err and [d[1] for d in deploys] == ["zz-shop-api", "zz-shop-api", "zz-shop", "zz-shop-api"] and deploys[0][2] == os.path.join("build", "zz_shop")
               and deploys[2][2] == os.path.join("build", "zz_shop", "web") and deploys[3][2] == os.path.join("build", "zz_shop") and all("--scope team-x" in d[3] for d in deploys),
               f"the API first (twice on a first deploy: it learns its own address), then the console from its own directory, then the API once more (it learns the console's address), all under the team scope: {err[:200]} {deploys}")
            # mold_v0-084: the API's emails link to the console. Its address is written on the API project after the console's
            # deploy (read back from Vercel), BEFORE the API's last deploy, which is health-checked; the proxy hops before the first.
            ae = fp.projects["zz-shop-api"]["env"]
            at = [i for i, c in enumerate(fp.calls) if c[0] == "deploy"]     # where each deploy is in the call list
            ok(ae.get("APP_CONSOLE_URL") == web_u and ae.get("APP_PROXY_HOPS") == "1"
               and fp.calls.index(("set_env", "zz-shop-api", "APP_PROXY_HOPS")) < at[0]
               and at[2] < fp.calls.index(("set_env", "zz-shop-api", "APP_CONSOLE_URL")) < at[3]
               and [c for c in fp.calls if c[0] == "health"][-1] == ("health", api_u + "/healthz"),
               f"a first deploy: the console's address set on the API after the console's deploy and before the API's last, which is health-checked; one proxy: {ae} {fp.calls[-6:]}")
            ok(SS.api_settings(man) == {"APP_PROXY_HOPS": "1"} and SS.api_settings(man, "https://c.example/") == {"APP_CONSOLE_URL": "https://c.example", "APP_PROXY_HOPS": "1"}
               and SS.api_settings({"vercel": {"projects": {"api": {"env": {"bad name": "x", "X_Y": "a\nb", "Z": 3, "$comment": "c"}}}}}) == {},
               "the mold's api settings: {console_url} only once known, no line breaks, no odd names, no comments")
            # A later deploy: the API already holds the console's address (the one this deploy reads back): no extra deploy.
            fp2 = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before={"zz-shop-api": "dpl_api_old", "zz-shop": "dpl_web_old"})
            fp2.projects["zz-shop-api"]["env"].update({"PUBLIC_URL": api_u, "APP_CONSOLE_URL": web_u, "APP_PROXY_HOPS": "1"})
            _, i2, err2 = vdeploy(fp2, inf=dict(cp(vi), vercel=dict(cp(vi)["vercel"], production_url=web_u)))
            ok(not err2 and [c[1] for c in fp2.calls if c[0] == "deploy"] == ["zz-shop-api", "zz-shop"]
               and not any(c[0] == "set_env" and c[1] == "zz-shop-api" and c[2] in ("APP_CONSOLE_URL", "APP_PROXY_HOPS") for c in fp2.calls),
               f"a later deploy with the console's address already on the API: one deploy each, nothing rewritten: {err2[:200]} {[c for c in fp2.calls if c[0] in ('deploy', 'set_env')]}")
            # The console's address moved (a new domain): written, and the API deployed once more.
            fp3 = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"])
            fp3.projects["zz-shop-api"]["env"].update({"PUBLIC_URL": api_u, "APP_CONSOLE_URL": "https://old-console.example", "APP_PROXY_HOPS": "1"})
            _, i3, err3 = vdeploy(fp3, inf=dict(cp(vi), vercel=dict(cp(vi)["vercel"], production_url="https://old-console.example")))
            ok(not err3 and [c[1] for c in fp3.calls if c[0] == "deploy"] == ["zz-shop-api", "zz-shop", "zz-shop-api"] and fp3.projects["zz-shop-api"]["env"]["APP_CONSOLE_URL"] == web_u,
               f"a console at a new address: the API is told and deployed once more: {err3[:200]} {[c[1] for c in fp3.calls if c[0] == 'deploy']}")
            # A console on its own domain (domain.py switch made it the front door): emails link to the domain, not *.vercel.app,
            # and the recorded production address stays the domain; no extra deploy when the API already holds it.
            fp5 = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"])
            fp5.projects["zz-shop-api"]["env"].update({"PUBLIC_URL": api_u, "APP_CONSOLE_URL": "https://shop.example.org", "APP_PROXY_HOPS": "1"})
            fp5._front_door = lambda infra, url, cb: "https://shop.example.org" if (infra.get("vercel") or {}).get("production_url") == "https://shop.example.org" else url
            _, i5, err5 = vdeploy(fp5, inf=dict(cp(vi), vercel=dict(cp(vi)["vercel"], custom_domain="shop.example.org", production_url="https://shop.example.org")))
            ok(not err5 and [c[1] for c in fp5.calls if c[0] == "deploy"] == ["zz-shop-api", "zz-shop"] and fp5.projects["zz-shop-api"]["env"]["APP_CONSOLE_URL"] == "https://shop.example.org"
               and i5["vercel"]["production_url"] == "https://shop.example.org",
               f"a console on its own domain: emails keep linking to it, it stays the production address, no extra deploy: {err5[:200]} {[c[1] for c in fp5.calls if c[0] == 'deploy']} {i5['vercel'].get('production_url')}")
            # mold_v0-118: on its own domain the API is told where AI clients connect (APP_MCP_URL), before its first deploy,
            # with no extra deploy; an app without a domain (or one attached but not switched to) gets nothing new.
            a5 = [i for i, c in enumerate(fp5.calls) if c[0] == "deploy"]
            ok(fp5.projects["zz-shop-api"]["env"].get("APP_MCP_URL") == "https://shop.example.org" and fp5.calls.index(("set_env", "zz-shop-api", "APP_MCP_URL")) < a5[0]
               and "APP_MCP_URL" not in fp5.projects["zz-shop"]["env"] and "APP_MCP_URL" not in ae and "APP_MCP_URL" not in fp3.projects["zz-shop-api"]["env"],
               f"the app's own domain is the MCP address on the API project only, before its deploy; none without a domain: {fp5.projects['zz-shop-api']['env'].get('APP_MCP_URL')}")
            ok(SS.own_domain_url("https://shop.example.org/", "Shop.Example.org") == "https://shop.example.org" and SS.own_domain_url("https://zz-shop.vercel.app", "shop.example.org") is None
               and SS.own_domain_url("https://shop.example.org", None) is None and SS.own_domain_url(None, "shop.example.org") is None
               and SS.own_domain_url("https://x.example\nY=1", "x.example\nY=1") is None
               and SS.api_settings(man, "https://shop.example.org", None, "shop.example.org").get("APP_MCP_URL") == "https://shop.example.org"
               and "APP_MCP_URL" not in SS.api_settings(man, "https://zz-shop.vercel.app", None, "shop.example.org") and "APP_MCP_URL" not in SS.api_settings(man, "https://c.example")
               and SS.with_held_spellings(SS.api_settings(man, "https://shop.example.org", None, "shop.example.org"), {"OCTILLION_CONSOLE_URL"}, ("APP_", "OCTILLION_")).get("OCTILLION_MCP_URL") is None,
               "{own_domain}: only the domain the console is on, lowercased; never an attached domain not switched to, a bad name, or an old spelling the project does not hold")
            # A failed read of the API's settings (names there, no values) is not taken for stale: nothing written, no extra deploy.
            fp6 = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET", "PUBLIC_URL", "APP_CONSOLE_URL", "APP_PROXY_HOPS"]}, projects=["zz-shop"])
            fp6.pull_env = lambda cb, proj, required=False, environment="production": {}
            _, i6, err6 = vdeploy(fp6, inf=dict(cp(vi), vercel=dict(cp(vi)["vercel"], production_url=web_u)))
            ok(not any(c[0] == "set_env" and c[1] == "zz-shop-api" and c[2] in ("APP_CONSOLE_URL", "APP_PROXY_HOPS") for c in fp6.calls)
               and [c[1] for c in fp6.calls if c[0] == "deploy"].count("zz-shop-api") <= 2,
               f"a failed read of the API's settings writes nothing and adds no deploy: {err6[:200]} {[c for c in fp6.calls if c[0] in ('deploy', 'set_env')]}")
            # The API failing its health after it learns the console's address: both projects back on what served before.
            fp4 = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before={"zz-shop-api": "dpl_api_old", "zz-shop": "dpl_web_old"})
            fp4.projects["zz-shop-api"]["env"].update({"PUBLIC_URL": api_u})
            real = fp4._read_health; n_api = []
            def late_fail(url, real=real, n_api=n_api):
                if url.startswith(api_u): n_api.append(url)
                return ("500", {"ok": False}, "") if url.startswith(api_u) and len(n_api) == 2 and not fp4.rolled else real(url)
            fp4._read_health = late_fail
            _, i4, err4 = vdeploy(fp4)
            ok(("point", "zz-shop-api", "dpl_api_old", "rollback") in fp4.calls and ("point", "zz-shop", "dpl_web_old", "rollback") in fp4.calls and "console's address" in err4,
               f"the API's last deploy failing its health rolls both projects back: {err4[:200]}")
            ok(fp.calls.index(("set_env", "zz-shop", "SHOP_API_URL")) < fp.calls.index(deploys[2]) and fp.projects["zz-shop"]["env"] == {"SHOP_API_URL": api_u},
               f"the console gets the API's address before its deploy, and nothing else: {fp.projects['zz-shop']['env']}")
            ok("DATABASE_URL" in fp.projects["zz-shop-api"]["env"] and {"APP_VAULT_KEY", "CRON_SECRET"} <= set(fp.projects["zz-shop-api"]["env"]) and fp.projects["zz-shop-api"]["env"]["PUBLIC_URL"] == api_u,
               "the API alone gets the database, the minted keys and PUBLIC_URL (its own address)")
            ok(v_["projects"] == {"api": "zz-shop-api", "web": "zz-shop"} and v_["api_url"] == api_u and v_["production_url"] == web_u
               and v_["health"] == {"api": "200", "web": "200", "pages": {"/admin": "307", "/app": "307"}} and i_.get("deployed_at") and a_["status"] == "stamped"
               and v_["release"]["before"] == {"api": None, "web": None}, f"state: both names, both addresses (production is the console), both healths: {v_}")
            vd = {"app_id": "zz_shop", "mold_id": "mold_vx"}
            ok(SS.problems("zz_shop", {"application": vd, "infrastructure": i_, "datastores": {"postgres": {"provider": "neon"}}}) == [], "the recorded state passes validate's rules")
            ok(SS.mcp_address(i_) == api_u and SS.address(i_) == web_u, "the MCP check targets the API; people open the console")
            # Platform administrators (application.json platform_admins): who may open the admin console. Recorded: written on
            # the API before its first deploy. None recorded and none on the project: the check and the deploy stop for the
            # operator (needs_human) before anything is made. None recorded but the project holds one (set by hand before the
            # factory owned it): kept, never removed, and the check says so.
            ok(ae.get("APP_PLATFORM_ADMINS") == "ops@example.com,*@example.org" and fp.calls.index(("set_env", "zz-shop-api", "APP_PLATFORM_ADMINS")) < at[0]
               and "APP_PLATFORM_ADMINS" not in fp.projects["zz-shop"]["env"] and "OCTILLION_PLATFORM_ADMINS" not in ae,
               f"recorded administrators are written on the API project (never the console), under the new name only on a new app, before its first deploy: {ae.get('APP_PLATFORM_ADMINS')}")
            ok(SS.api_settings(man, None, "a@example.com") == {"APP_PROXY_HOPS": "1", "APP_PLATFORM_ADMINS": "a@example.com"} and SS.api_settings(man, None, "") == {"APP_PROXY_HOPS": "1"}
               and SS.admin_entries("A@Example.com, *@Example.org,, a@example.com, nope") == (["a@example.com", "*@example.org"], ["nope"]) and SS.admins_of({}) == "",
               "the administrators: written only when recorded, lowercased, once each, and anything that is not an address or *@domain refused")
            import agent_result as AR
            noadm = {k: v for k, v in va.items() if k != "platform_admins"}
            AR.reset(); fpn = FakeP(projects=["zz-shop-api", "zz-shop"], env={"zz-shop-api": ["DATABASE_URL"]}); said = []
            rc = SS.vercel_check("zz_shop", noadm, cp(vi), fpn, say=said.append, root=t)
            ok(rc == 1 and any(SS.ADMIN_MARK in l for l in said) and [n_["name"] for n_ in AR.NOTES["needs"]] == ["platform administrator address"]
               and AR.NOTES["needs"][0]["kind"] == "approval" and "answers.json" in AR.NOTES["needs"][0]["how"] and not any(c[0] == "set_env" for c in fpn.calls),
               f"the check with no administrator anywhere: not ready, the address asked for in plain words (needs_human through provision.py): {said[-2:]} {AR.NOTES['needs']}")
            AR.reset(); fpn = FakeP(projects=["zz-shop-api", "zz-shop"]); err = ""
            try: SS.vercel_deploy("zz_shop", dict(noadm), cp(vi), vdir, fpn, say=lambda s: None, root=t, read_page=pages({}))
            except SS.NeedsHuman as e: err = str(e)
            ok(SS.ADMIN_MARK in err and [n_["name"] for n_ in AR.NOTES["needs"]] == ["platform administrator address"]
               and not any(c[0] in ("vrun", "set_env", "deploy", "neon", "choose") for c in fpn.calls),
               f"the deploy with no administrator anywhere stops for the operator before anything is created or deployed: {err[:200]} {fpn.calls[:4]}")
            AR.reset(); a_n = dict(noadm)
            rc = SS.main_for("zz_shop", ["zz_shop", "--deploy"], a_n, cp(vi), {}, vdir, FakeP(projects=["zz-shop-api", "zz-shop"]), say=lambda s: None, root=t)
            ok(rc == 1 and AR.NOTES["needs"] and a_n.get("status") == "planned" and "revert" not in a_n,
               "provision.py --deploy without an administrator: exit 1 with a need noted (provision.py makes it exit 3, needs_human), never reverted")
            for held in ("OCTILLION_PLATFORM_ADMINS", "APP_PLATFORM_ADMINS"):
                AR.reset(); fpk = FakeP(projects=["zz-shop-api", "zz-shop"], env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET", held]}); said = []
                rc = SS.vercel_check("zz_shop", noadm, cp(vi), fpk, say=said.append, root=t)
                ok(rc == 0 and not AR.NOTES["needs"] and any(f"already holds {held}" in l and "kept" in l for l in said),
                   f"the check with no administrator in state but {held} on the API project: ready, and it says the variable is kept: {[l for l in said if 'administrator' in l]}")
                a_k = dict(noadm); i_k = cp(vi); err = ""
                try: SS.vercel_deploy("zz_shop", a_k, i_k, vdir, fpk, say=lambda s: None, root=t, read_page=pages({}))
                except SS.Stop as e: err = str(e)
                ok(not err and fpk.projects["zz-shop-api"]["env"].get(held) == "standin" and not any(c[0] == "set_env" and "PLATFORM_ADMINS" in str(c[2]) for c in fpk.calls)
                   and not any(c[0] == "rm_env" for c in fpk.calls),
                   f"the deploy keeps {held} the project already holds when state records none (never removed, never rewritten): {err[:200]}")
            # an app whose API project holds the old spelling (set by hand before the factory owned it): both names, one value
            fpb = FakeP(projects=["zz-shop-api", "zz-shop"], env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET", "OCTILLION_PLATFORM_ADMINS"]}); err = ""
            try: SS.vercel_deploy("zz_shop", dict(va), cp(vi), vdir, fpb, say=lambda s: None, root=t, read_page=pages({}))
            except SS.Stop as e: err = str(e)
            ok(not err and {n_: fpb.projects["zz-shop-api"]["env"].get(n_) for n_ in ("OCTILLION_PLATFORM_ADMINS", "APP_PLATFORM_ADMINS")}
               == {"OCTILLION_PLATFORM_ADMINS": "ops@example.com,*@example.org", "APP_PLATFORM_ADMINS": "ops@example.com,*@example.org"},
               f"recorded administrators on a project that holds the old spelling: both get state's list, so neither goes stale: {err[:200]}")
            AR.reset()
            # mold_v0-116: an app on Clerk. Live today: only CLERK_SECRET_KEY on the API, so the API could not find Clerk's
            # sign-in server; with member keys off nothing let an AI client in; and Clerk let no client register itself.
            import base64 as b64_
            cm_fails = SS.clerk_mcp.self_test()
            ok(cm_fails == [], f"lib/clerk_mcp.py: publishable keys, the provider rule, what the API will know, Clerk's registration reading: {cm_fails}")
            ok(SS.clerk_mcp.clerk_spec(man).get("publishable") == {"api": "CLERK_PUBLISHABLE_KEY", "web": "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"},
               "mold.json mcp_sign_in names the API's and the console's publishable-key names")
            chost = "clerk.zz-shop.example.test"; cpk = "pk_live_" + b64_.b64encode((chost + "$").encode()).decode()
            meta_url = f"https://{chost}/.well-known/oauth-authorization-server"
            reg_off = lambda u: (200, {"issuer": f"https://{chost}"}, "") if u == meta_url else (None, None, "unexpected " + u)
            reg_on = lambda u: (200, {"issuer": f"https://{chost}", "registration_endpoint": f"https://{chost}/oauth/register"}, "") if u == meta_url else (None, None, "unexpected " + u)
            def clerk_fp(api_extra=None, web_pk=cpk):
                f_ = FakeP(projects=["zz-shop-api", "zz-shop"], env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]})
                f_.projects["zz-shop-api"]["env"].update(dict({"CLERK_SECRET_KEY": "sk_live_standin"}, **(api_extra or {})))
                f_.projects["zz-shop"]["env"]["CLERK_SECRET_KEY"] = "sk_live_standin"
                if web_pk: f_.projects["zz-shop"]["env"]["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] = web_pk
                return f_
            koff = dict(va, profile={"member_keys": False})
            cbrun = lambda cmd, **k: (os.makedirs(os.path.join(t, "build", "zz_shop", "web"), exist_ok=True), subprocess.CompletedProcess(cmd, 0, "", ""))[1]   # build/<app>/ stand-in (a profile builds a copy)
            AR.reset(); said = []
            rc = SS.vercel_check("zz_shop", koff, cp(vi), clerk_fp(), say=said.append, root=t, read_json=reg_off)
            nd_ = AR.NOTES["needs"]; txt = "\n".join(said)
            ok(rc == 1 and [(n_["kind"], n_["name"]) for n_ in nd_] == [("approval", "Clerk dynamic client registration")]
               and all(w in nd_[0]["how"] for w in ("dashboard.clerk.com", "Configure", "OAuth applications", "Settings", "Dynamic client registration", "Client ID Metadata Documents"))
               and "copies the console's NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" in txt and cpk not in txt and cpk not in json.dumps(nd_),
               f"check, keys off, Clerk letting no client register: not ready, the Clerk dashboard steps asked for (exit 3 through provision.py), the key never said: {said[-3:]} {nd_}")
            AR.reset(); said = []
            rc = SS.vercel_check("zz_shop", dict(va), cp(vi), clerk_fp(), say=said.append, root=t, read_json=reg_off)
            ok(rc == 0 and not AR.NOTES["needs"] and any("WARNING" in l and "member API keys still let" in l for l in said) and any("Dynamic client registration" in l for l in said),
               f"check, keys on, registration off: ready, with a warning and the same steps: {[l for l in said if 'Clerk' in l][:2]}")
            AR.reset(); said = []
            rc = SS.vercel_check("zz_shop", koff, cp(vi), clerk_fp(), say=said.append, root=t, read_json=reg_on)
            ok(rc == 0 and not AR.NOTES["needs"] and any("dynamic client registration on" in l for l in said), f"check, keys off, registration on: ready: {said[-2:]}")
            AR.reset(); said = []
            rc = SS.vercel_check("zz_shop", koff, cp(vi), clerk_fp(), say=said.append, root=t, read_json=lambda u: (None, None, "URLError: timed out"))
            ok(rc == 0 and not AR.NOTES["needs"] and any("could not be read" in l for l in said), "check: Clerk not answering is said and never read as off")
            AR.reset(); said = []
            rc = SS.vercel_check("zz_shop", koff, cp(vi), clerk_fp(web_pk=None), say=said.append, root=t, read_json=reg_on)
            ok(rc == 1 and [(n_["kind"], n_["name"]) for n_ in AR.NOTES["needs"]] == [("secret", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")] and "--set-secret NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" in AR.NOTES["needs"][0]["how"],
               f"check, keys off, no publishable key anywhere: the console's key asked for at the hidden prompt: {AR.NOTES['needs']}")
            AR.reset(); said = []
            rc = SS.vercel_check("zz_shop", koff, cp(vi), clerk_fp(api_extra={"AUTH_PROVIDER": "builtin"}), say=said.append, root=t, read_json=lambda u: ok(False, "a built-in app never asks Clerk") or (None, None, ""))
            ok(rc == 0 and not AR.NOTES["needs"] and any("built-in sign-in" in l for l in said), "check: AUTH_PROVIDER=builtin keeps Clerk out of it")
            # the deploy: the console's key copied onto the API before its first deploy; a proxy address kept; the end says Clerk's setting
            AR.reset(); fpc = clerk_fp(); said = []; err = ""
            try: SS.vercel_deploy("zz_shop", dict(koff), cp(vi), vdir, fpc, say=said.append, root=t, read_page=pages({}), build_run=cbrun, read_json=reg_off)
            except SS.Stop as e: err = str(e)
            sets = [c for c in fpc.calls if c[0] == "set_env" and c[2] == "CLERK_PUBLISHABLE_KEY"]; first = [i_ for i_, c in enumerate(fpc.calls) if c[0] == "deploy"]
            ok(not err and sets == [("set_env", "zz-shop-api", "CLERK_PUBLISHABLE_KEY")] and fpc.projects["zz-shop-api"]["env"]["CLERK_PUBLISHABLE_KEY"] == cpk
               and fpc.calls.index(sets[0]) < first[0] and "CLERK_PUBLISHABLE_KEY" not in fpc.projects["zz-shop"]["env"]
               and "CLERK_FRONTEND_API_URL" not in fpc.projects["zz-shop-api"]["env"] and cpk not in "\n".join(said)
               and any("NOTE" in l and chost in l for l in said) and any("OAuth applications" in l for l in said),
               f"deploy: the console's publishable key written on the API (once, before its first deploy, never said), and Clerk's setting said at the end: {err[:200]} {said[-4:]}")
            fpc2 = clerk_fp(api_extra={"CLERK_PUBLISHABLE_KEY": cpk}); err = ""
            try: SS.vercel_deploy("zz_shop", dict(koff), cp(vi), vdir, fpc2, say=lambda s_: None, root=t, read_page=pages({}), build_run=cbrun, read_json=reg_on)
            except SS.Stop as e: err = str(e)
            ok(not err and not any(c[0] == "set_env" and c[2] == "CLERK_PUBLISHABLE_KEY" for c in fpc2.calls), "deploy: the same key already on the API is not written again")
            fpc3 = clerk_fp(api_extra={"CLERK_FRONTEND_API_URL": "https://auth.zz-shop.example.test"}); err = ""
            try: SS.vercel_deploy("zz_shop", dict(koff), cp(vi), vdir, fpc3, say=lambda s_: None, root=t, read_page=pages({}), build_run=cbrun, read_json=lambda u: (200, {"client_id_metadata_document_supported": True}, ""))
            except SS.Stop as e: err = str(e)
            ok(not err and fpc3.projects["zz-shop-api"]["env"]["CLERK_FRONTEND_API_URL"] == "https://auth.zz-shop.example.test"
               and not any(c[0] == "set_env" and c[2] == "CLERK_FRONTEND_API_URL" for c in fpc3.calls), "deploy: an operator's Clerk proxy address on the API is kept, never written")
            fpb2 = clerk_fp(api_extra={"AUTH_PROVIDER": "builtin"}); err = ""
            try: SS.vercel_deploy("zz_shop", dict(koff), cp(vi), vdir, fpb2, say=lambda s_: None, root=t, read_page=pages({}), build_run=cbrun, read_json=lambda u: (None, None, "x"))
            except SS.Stop as e: err = str(e)
            ok(not err and not any(c[0] == "set_env" and "CLERK" in c[2] for c in fpb2.calls), "deploy: an app switched to the built-in sign-in gets no Clerk key on its API")
            AR.reset(); fpn2 = clerk_fp(web_pk=None); err = ""; a_nk = dict(koff)
            try: SS.vercel_deploy("zz_shop", a_nk, cp(vi), vdir, fpn2, say=lambda s_: None, root=t, read_page=pages({}), build_run=cbrun, read_json=reg_on)
            except SS.NeedsHuman as e: err = str(e)
            ok("member API keys are off" in err and [n_["name"] for n_ in AR.NOTES["needs"]] == ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]
               and not any(c[0] == "deploy" for c in fpn2.calls) and a_nk.get("status") == "planned",
               f"deploy, keys off, no publishable key anywhere: stops for the key before anything deploys, not reverted: {err[:200]}")
            AR.reset(); fpn3 = clerk_fp(web_pk=None); err = ""
            try: SS.vercel_deploy("zz_shop", dict(va), cp(vi), vdir, fpn3, say=lambda s_: None, root=t, read_page=pages({}), build_run=cbrun, read_json=reg_on)
            except SS.Stop as e: err = str(e)
            ok(not err and any(c[0] == "deploy" for c in fpn3.calls), f"deploy, keys on, no publishable key: deploys (keys still let clients in): {err[:200]}")
            AR.reset()
            # mold_v0-045: env names APP_*, the old prefix still read. An app deployed before then (its state and its projects
            # hold the old names) deploys unchanged: nothing is minted under the new name beside an old one (it would win: a new
            # vault key and nothing decrypts), a state name in the old spelling is minted from the bootstrap's new one.
            NEW, LEG = man["env_names"]["prefix"], man["env_names"]["legacy_prefix"]
            ok(F["aliases"] == (NEW, LEG) and SS.other_spelling(NEW + "VAULT_KEY", F["aliases"]) == LEG + "VAULT_KEY" and SS.other_spelling(LEG + "X", F["aliases"]) == NEW + "X"
               and SS.other_spelling("CRON_SECRET", F["aliases"]) is None and SS.env_aliases({"env_names": {"prefix": "APP_", "legacy_prefix": "APP_"}}) is None
               and SS.env_aliases({}) is None and SS.has_value(NEW + "K", {LEG + "K"}, F["aliases"]) and not SS.has_value(NEW + "K", {LEG + "K"}, None),
               f"mold.json env_names: the prefix and the old one; a name and its other spelling: {F['aliases']}")
            leg = dict(cp(vi), secrets_derived=["DATABASE_URL", LEG + "VAULT_KEY", "CRON_SECRET"])
            fpl = FakeP(env={"zz-shop-api": ["DATABASE_URL", LEG + "VAULT_KEY", "CRON_SECRET", "PUBLIC_URL"]}, projects=["zz-shop"])
            _, _, errl = vdeploy(fpl, inf=cp(leg))
            ok(not errl and not any(c[0] == "set_env" and c[2] in (NEW + "VAULT_KEY", LEG + "VAULT_KEY") for c in fpl.calls),
               f"an app deployed before mold_v0-045 (old names in its state and project): its vault key is never minted again, under either name: {errl[:200]} {[c for c in fpl.calls if c[0] == 'set_env']}")
            fpn = FakeP(env={"zz-shop-api": ["DATABASE_URL", LEG + "VAULT_KEY", "CRON_SECRET", "PUBLIC_URL"]}, projects=["zz-shop"])
            _, _, errn = vdeploy(fpn)    # this app's state names the NEW spelling, but its project holds the key under the old one
            ok(not errn and not any(c[0] == "set_env" and c[2] == NEW + "VAULT_KEY" for c in fpn.calls),
               f"state in the new spelling, the key held under the old one: not minted under the new name (it would shadow the old key): {[c for c in fpn.calls if c[0] == 'set_env']}")
            fpm = FakeP(projects=["zz-shop-api", "zz-shop"])
            _, _, errm = vdeploy(fpm, inf=cp(leg))
            env_m = fpm.projects["zz-shop-api"]["env"]
            ok(not errm and len(env_m.get(LEG + "VAULT_KEY", "")) >= 40 and NEW + "VAULT_KEY" not in env_m and len(env_m.get("CRON_SECRET", "")) == 64,
               f"a first deploy of a state that names the old spelling (minted before mold_v0-045): the bootstrap's key, under the state's name only: {sorted(env_m)}")
            fpc = FakeP(env={"zz-shop-api": ["DATABASE_URL", LEG + "VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"])
            fpc.projects["zz-shop-api"]["env"].update({"PUBLIC_URL": api_u, LEG + "CONSOLE_URL": "https://old-console.example", LEG + "PROXY_HOPS": "1"})
            _, _, errc = vdeploy(fpc, inf=cp(leg))
            ec = fpc.projects["zz-shop-api"]["env"]
            ok(not errc and ec[NEW + "CONSOLE_URL"] == web_u and ec[LEG + "CONSOLE_URL"] == web_u and ec[NEW + "PROXY_HOPS"] == "1",
               f"an app deployed before mold_v0-045: the console's address goes under the new name and the old one it holds (a rolled-back release reads that): {ec}")
            ok(SS.with_held_spellings({NEW + "X": "1"}, {LEG + "X"}, F["aliases"]) == {NEW + "X": "1", LEG + "X": "1"} and SS.with_held_spellings({NEW + "X": "1"}, set(), F["aliases"]) == {NEW + "X": "1"},
               "with_held_spellings: the other spelling only where it is held")
            mvl = SS.mint_values(cb, F, [LEG + "VAULT_KEY"])
            ok(list(mvl) == [LEG + "VAULT_KEY"] and len(mvl[LEG + "VAULT_KEY"]) >= 40, "mint_values: a state name in the old spelling gets the bootstrap's value for the new one")
            ok(SS.project_for(F, K, LEG + "VAULT_KEY") == ["api"] and SS.project_for(F, K, NEW + "VAULT_KEY") == ["api"] and SS.project_for(F, K, "NOT_A_NAME") == [],
               "--set-secret: the old spelling of an API name goes to the API project, like the new one")
            fps = FakeP(env={"zz-shop-api": [LEG + "VAULT_KEY", NEW + "VAULT_KEY"]}, projects=["zz-shop"])
            SS.set_secret_vercel("zz_shop", va, dict(cp(vi), secrets_derived=["DATABASE_URL", LEG + "VAULT_KEY", "CRON_SECRET"]), LEG + "VAULT_KEY", fps, root=t, value="k" * 44, say=lambda s_: None)
            ok(fps.projects["zz-shop-api"]["env"][LEG + "VAULT_KEY"] == "k" * 44 and fps.projects["zz-shop-api"]["env"][NEW + "VAULT_KEY"] == "k" * 44,
               f"--set-secret on an old name the project also holds under the new one: both get the value, so neither shadows it: {[c for c in fps.calls if c[0] == 'set_env']}")
            fpo = FakeP(projects=["zz-shop-api", "zz-shop"])
            SS.set_secret_vercel("zz_shop", va, cp(leg), NEW + "VAULT_KEY", fpo, root=t, value="k" * 44, say=lambda s_: None)
            ok(fpo.projects["zz-shop-api"]["env"].get(NEW + "VAULT_KEY") == "k" * 44 and fpo.projects["zz-shop-api"]["env"].get(LEG + "VAULT_KEY") == "k" * 44,
               "--set-secret with the new spelling (as the console now names it) on an app whose state names the old one: both get the value, neither shadows")
            try: SS.set_secret_vercel("zz_shop", va, cp(leg), "NOT_A_NAME", FakeP(projects=["zz-shop-api", "zz-shop"]), root=t, value="k" * 44, say=lambda s_: None); ok(False, "an undeclared name is refused")
            except SS.Stop as e_: ok("not a name this app reads" in str(e_), "--set-secret still refuses a name the app does not read")
            nc = "const API = (process.env.APP_API_URL ?? legacyEnv('APP_API_URL') ?? 'http://127.0.0.1:3333');"
            ok(SS.API_ENV.findall(nc) == ["APP_API_URL"] and SS.API_ENV.findall("process.env.X_URL ?? 'http://a'") == ["X_URL"]
               and SS.console_facts(SS.codebase("mold_v0"), SS.manifest("mold_v0"))["api_env"] == NEW + "API_URL",
               "the console's API-address variable with its old spelling as a fallback between: the new name (mold_v0's own next.config)")
            # the console fails its health: BOTH projects back on what served before
            before = {"zz-shop-api": "dpl_api_old", "zz-shop": "dpl_web_old"}
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before, health={web_u: "502"})
            a_, i_, err = vdeploy(fp)
            ok(("point", "zz-shop", "dpl_web_old", "rollback") in fp.calls and ("point", "zz-shop-api", "dpl_api_old", "rollback") in fp.calls
               and i_["vercel"]["rollback"]["result"] == "rolled back" and "does not reach the API" in err and "Both projects" in err,
               f"a console that does not reach the API: both projects back on the deployments before: {err[:200]} {i_['vercel'].get('rollback')}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before)
            a_, i_, err = vdeploy(fp, read=pages({"/app": "500"}))
            ok(("point", "zz-shop-api", "dpl_api_old", "rollback") in fp.calls and "/app answered HTTP 500" in err, f"a console page answering 500 rolls both back: {err[:200]}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before, health={api_u: "500"})
            a_, i_, err = vdeploy(fp)
            ok(not any(c[0] == "deploy" and c[1] == "zz-shop" for c in fp.calls) and ("point", "zz-shop-api", "dpl_api_old", "rollback") in fp.calls
               and i_["vercel"]["rollback"]["projects"]["web"].startswith("already serving"), f"an API that fails its health: the console is never deployed, the API goes back: {err[:200]}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before)
            a_, i_, err = vdeploy(fp, read=lambda u: ("", "no answer"))
            ok(i_["vercel"]["rollback"]["result"] == "rolled back" and "answered nothing" in err, "pages that answer nothing roll both back")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before)
            fp.promote_new = lambda before_, cb_, roles: (_ for _ in ()).throw(SystemExit("zz-shop: the new deployment could not be put in front of traffic"))
            a_, i_, err = vdeploy(fp)
            ok("could not be put in front" in err and ("point", "zz-shop-api", "dpl_api_old", "rollback") in fp.calls, f"a deploy step that stops part-way rolls back too: {err[:160]}")
            # mold_v0-024: an app with packs or a brand ships build/<app_id>/ made AFRESH by branding.py and packs.py, never the
            # codebase rsynced over it (which would drop its packs) and never a copy an earlier run left (a dropped pack, an older codebase)
            bdir = os.path.join(t, "build", "zz_shop"); built = []
            def brun(cmd, **k):
                built.append([os.path.basename(cmd[1])] + cmd[2:]); os.makedirs(os.path.join(bdir, "web"), exist_ok=True)
                open(os.path.join(bdir, "MADE_BY_" + os.path.basename(cmd[1]).split(".")[0] + "_" + cmd[2]), "w").write("x")
                return subprocess.CompletedProcess(cmd, 0, f"{cmd[2]} ok\n", "")
            os.makedirs(os.path.join(bdir, "packs", "dropped_pack"), exist_ok=True)
            a_ = dict(va, packs=["shop_notes"], surface={"branding": {"product_name": "Shop"}}); i_ = cp(vi); fp = FakeP(projects=["zz-shop-api", "zz-shop"]); err = ""
            try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s: None, root=t, read_page=pages({}), build_run=brun)
            except SS.Stop as e: err = str(e)
            deploys = [c for c in fp.calls if c[0] == "deploy"]
            ok(not err and built == [["branding.py", "zz_shop", "prepare"], ["packs.py", "apply", "zz_shop"], ["packs.py", "verify", "zz_shop"]]
               and not os.path.exists(os.path.join(bdir, "packs", "dropped_pack")) and not os.path.exists(os.path.join(bdir, "vercel.json"))
               and os.path.exists(os.path.join(bdir, "MADE_BY_packs_apply")) and deploys and deploys[0][2] == os.path.join("build", "zz_shop"),
               f"packs and a brand: the brand, then the packs and their checks, into a fresh build/<app_id>/ that is deployed as made (the codebase is not copied over it, the old copy is gone): {err[:200]} {built}")
            ok(SS.source_for("zz_shop", a_, t) == bdir and SS.source_for("zz_shop", dict(va), t) == SS.codebase("mold_vx", t)
               and SS.uses_build({"packs": ["p"]}) and SS.uses_build({"surface": {"branding": {"product_name": "x"}}}) and not SS.uses_build({"surface": {}}),
               "source_for: build/<app_id>/ with packs or a brand, the codebase with neither")
            built.clear(); fp = FakeP(projects=["zz-shop-api", "zz-shop"]); err = ""
            try: SS.vercel_deploy("zz_shop", dict(va, packs=["shop_notes"]), cp(vi), vdir, fp, say=lambda s: None, root=t, read_page=pages({}),
                                  build_run=lambda cmd, **k: built.append(cmd) or subprocess.CompletedProcess(cmd, 1, "", "pack shop_notes: src/x.ts is outside what a pack may add"))
            except SS.NotBuilt as e: err = str(e)
            ok("outside what a pack may add" in err and "nothing was created" in err and len(built) == 1 and not any(c[0] in ("deploy", "set_env", "framework", "neon") for c in fp.calls),
               f"a pack that does not apply stops the deploy before anything is created (NotBuilt, not reverted): {err[:200]} {fp.calls[:4]}")
            vd2 = os.path.join(t, "vapp2"); os.makedirs(vd2, exist_ok=True); json.dump(dict(va, packs=["shop_notes"]), open(os.path.join(vd2, "application.json"), "w"))
            real_bs = SS.build_source
            SS.build_source = lambda *x, **k: (_ for _ in ()).throw(SS.NotBuilt("zz_shop: the packs could not be applied, so nothing was created or deployed: stand-in"))
            try: rc = SS.main_for("zz_shop", ["zz_shop", "--deploy"], dict(va, packs=["shop_notes"]), cp(vi), {}, vd2, FakeP(projects=["zz-shop-api", "zz-shop"]), say=lambda s: None, root=t)
            finally: SS.build_source = real_bs
            ok(rc == 1 and json.load(open(os.path.join(vd2, "application.json"))).get("status") == "planned", "provision.py: a build copy that cannot be made exits 1 and leaves the app as it was (not reverted)")
            # mold_v0-090: an app whose only own thing is its profile settings is built too (packs.py apply writes them, then verify)
            built.clear(); prof_app = dict(va, profile={"limits": {"runs": {"budget_usd_max": 40}}})
            ok(SS.uses_build(prof_app) and SS.source_for("zz_shop", prof_app, t) == bdir and SS.build_source("zz_shop", prof_app, t, say=lambda s: None, run=brun) == bdir
               and built == [["packs.py", "apply", "zz_shop"], ["packs.py", "verify", "zz_shop"]],
               f"profile settings and nothing else: build/<app_id>/ from packs.py apply and verify (never the bare codebase, which would drop them): {built}")
            ran_none = []
            ok(SS.build_source("zz_shop", dict(va), t, run=lambda *x, **k: ran_none.append(x)) == SS.codebase("mold_vx", t) and not ran_none,
               "an app with neither packs nor a brand: the codebase itself, nothing run")
            try: SS.build_source("zz_shop", dict(va, packs=["shop_notes"]), t); ok(False, "a temp root without a stand-in runner")
            except SS.NotBuilt as e: ok("stand-in runner" in str(e), "build_source never runs the real branding.py and packs.py for a temp factory root")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], health={web_u: "500"})
            a_, i_, err = vdeploy(fp)
            ok(i_["vercel"]["rollback"]["result"] == "nothing to roll back to" and not any(c[0] == "point" for c in fp.calls), "a first deploy that fails says there was nothing to go back to")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before, health={web_u: "500"})
            fp._point_production = lambda rec, dep, cb_, how: (False, "Vercel refused the rollback")
            a_, i_, err = vdeploy(fp)
            ok(i_["vercel"]["rollback"]["result"] == "rollback FAILED" and "SITE MAY BE DOWN" in err, f"a rollback that fails says the site may be down: {err[-120:]}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before={"zz-shop-api": "dpl_api_old"})
            a_, i_, err = vdeploy(fp)
            ok(not err and ("promote", ["api"]) in fp.calls and not ("promote", ["web"]) in fp.calls, f"a project with an earlier deployment is promoted past an earlier rollback: {err[:120]}")
            # mold_v0-037 (4): after a rollback health is read again; "rolled back" only when it answered 200 ok
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before, health={web_u: "502"})
            a_, i_, err = vdeploy(fp); rb = i_["vercel"]["rollback"]
            last_point = max(i for i, c in enumerate(fp.calls) if c[0] == "point")
            ok(rb["result"] == "rolled back" and rb["health"] == {"web": "200", "api": "200"}
               and {("health", web_u + "/healthz"), ("health", api_u + "/healthz")} <= set(fp.calls[last_point:]),
               f"a rollback re-reads both healths after it and records them: {rb}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before, health={web_u: "502"}); fp.sticky = True
            a_, i_, err = vdeploy(fp); rb = i_["vercel"]["rollback"]
            ok(rb["result"] == "rolled back, but health is not all 200" and rb["health"]["web"] == "502" and "not all 200" in err,
               f"a rollback whose health still fails records what it measured, never 'rolled back': {rb} {err[-160:]}")
            # mold_v0-051: with the mold's RLS check declared, the deploy runs it against the api project's database after its health
            pj = os.path.join(cb, "package.json"); pj_was = open(pj).read()
            json.dump({"scripts": {"check:rls": "tsx scripts/check-rls.ts"}}, open(pj, "w"))
            os.makedirs(os.path.join(cb, "node_modules", ".bin"), exist_ok=True); open(os.path.join(cb, "node_modules", ".bin", "tsx"), "w").write("")
            json.dump({"postgres": {"provider": "neon", "rls": "fail_closed"}}, open(os.path.join(vdir, "datastores.json"), "w"))
            try:
                ran = []
                def rls_ok(cb_, url_, spec_): ran.append(url_); return 0, "RLS CHECK PASS (postgres): every tenant table has row-level security; live probe 58 checks, nothing crossed"
                fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before)
                a_ = dict(va); i_ = cp(vi); err = ""
                try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s_: None, root=t, read_page=pages({}), rls_run=rls_ok)
                except SS.Stop as e_: err = str(e_)
                ev = json.load(open(os.path.join(vdir, "datastores.json")))["postgres"].get("rls_verified") or {}
                ok(not err and ran == ["standin"] and ev.get("mode") == "fail_closed" and ev.get("backend") == "neon" and ev.get("running_app") == "unmeasured"
                   and "--deploy" in ev.get("source", ""), f"vercel: the RLS check ran against the api project's database and the evidence is recorded: {err[:200]} {ev}")
                fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before)
                a_ = dict(va); i_ = cp(vi); err = ""
                try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s_: None, root=t, read_page=pages({}), rls_run=lambda c_, u_, s_: (1, "RLS CHECK FAIL (postgres):\n  x: A reads B"))
                except SS.Stop as e_: err = str(e_)
                deps = [c[1] for c in fp.calls if c[0] == "deploy"]
                evf = json.load(open(os.path.join(vdir, "datastores.json")))["postgres"].get("rls_verified") or {}
                ok(evf.get("mode") == "off" and evf.get("running_app") == "not_enforced" and "FAILED" in evf.get("source", ""),
                   f"vercel: a failing RLS check replaces the earlier pass in state (never left standing): {evf}")
                ok("row-level security check failed" in err and "zz-shop" not in deps and i_["vercel"]["rollback"]["result"].startswith("rolled back") and i_["vercel"]["rollback"]["projects"],
                   f"vercel: a failing RLS check is a failed health check: the api goes back, the console is never deployed: {err[-200:]} {deps}")
                os.remove(os.path.join(cb, "node_modules", ".bin", "tsx")); fp = FakeP(env={"zz-shop-api": ["DATABASE_URL"]}, projects=["zz-shop"])
                a_ = dict(va); i_ = cp(vi); err = ""
                try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s_: None, root=t, read_page=pages({}), rls_run=rls_ok)
                except SS.Stop as e_: err = str(e_)
                ok("npm --prefix" in err and not any(c[0] in ("deploy", "vrun") for c in fp.calls), f"vercel: without the mold's dependencies here the deploy refuses before anything is made: {err[:200]}")
            finally:
                open(pj, "w").write(pj_was); os.remove(os.path.join(vdir, "datastores.json"))
            # mold_v0-037 (5): an unexpected error half-way rolls both back, reverts, re-raises; the link temp directories are removed
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before)
            links = []; real_link = fp._link_dir
            def link_rec(proj, cb_, real_link=real_link): d_ = real_link(proj, cb_); links.append(d_); return d_
            fp._link_dir = link_rec
            def boom(proj, out, cb_, infra_):
                if proj == "zz-shop": raise RuntimeError("a bug half-way")
                return f"https://{proj}.vercel.app"
            fp._deployed_address = boom
            a_ = dict(va); i_ = cp(vi); raised = None; i_["vercel"].update(api_url=api_u, production_url=web_u)   # what the last good deploy recorded
            try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s_: None, root=t, read_page=pages({}))
            except RuntimeError as e_: raised = e_
            except SS.Stop as e_: raised = e_
            saved_app = json.load(open(os.path.join(vdir, "application.json")))
            ok(isinstance(raised, RuntimeError) and ("point", "zz-shop", "dpl_web_old", "rollback") in fp.calls and ("point", "zz-shop-api", "dpl_api_old", "rollback") in fp.calls
               and i_["vercel"]["rollback"]["result"] == "rolled back" and "RuntimeError" in i_["vercel"]["rollback"]["why"]
               and a_["status"] == "reverted" and saved_app["status"] == "reverted" and "RuntimeError" in saved_app["revert"]["reason"],
               f"an unexpected error half-way: both projects back, the app reverted, the error re-raised: {raised!r} {i_['vercel'].get('rollback')} {a_.get('revert')}")
            ok(len(links) == 2 and not any(os.path.exists(d_) for d_ in links), f"the link temp directories are removed: {links}")
            ok(i_["vercel"]["rollback"]["health"] == {"web": "200", "api": "200"}, f"...health read after it on the addresses the last deploy recorded: {i_['vercel']['rollback']}")
            a_ = dict(va); i_ = cp(vi); fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before); fp._deployed_address = boom
            try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s_: None, root=t, read_page=pages({}))
            except RuntimeError: pass
            ok(i_["vercel"]["rollback"]["health"]["web"] == "no address recorded" and i_["vercel"]["rollback"]["result"] == "rolled back, but health is not all 200",
               f"a console whose address was never recorded is not claimed healthy after a rollback: {i_['vercel']['rollback']}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"]); links = []; real_link = fp._link_dir
            fp._link_dir = lambda proj, cb_, real_link=real_link: links.append(real_link(proj, cb_)) or links[-1]
            a_, i_, err = vdeploy(fp)
            ok(not err and len(links) == 2 and not any(os.path.exists(d_) for d_ in links), f"a good deploy leaves no link temp directory behind: {err[:120]} {links}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"]); fp._link_dir = lambda proj, cb_: None
            a_, i_, err = vdeploy(fp)
            ok("could not be read back" in err and not any(c[0] == "deploy" for c in fp.calls), f"a project that cannot be linked stops before any deploy: {err[:160]}")
            # review: one project with nothing to go back to is never "rolled back"
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before={"zz-shop": "dpl_web_old"}, health={web_u: "502"})
            a_, i_, err = vdeploy(fp); rb = i_["vercel"]["rollback"]
            ok(rb["result"].startswith("partly rolled back") and "api" in rb["result"] and "still serves this run's deployment" in err,
               f"a rollback where the API had nothing to go back to says partly: {rb} {err[-160:]}")
            # review: the rollback itself raising is recorded, never escapes, and the app is still reverted
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before, health={web_u: "502"})
            fp._point_production = lambda rec, dep, cb_, how: (_ for _ in ()).throw(RuntimeError("vercel api crashed"))
            a_, i_, err = vdeploy(fp); rb = i_["vercel"]["rollback"]
            ok(rb["result"] == "rollback FAILED" and "RuntimeError" in rb["projects"]["web"] and "SITE MAY BE DOWN" in err, f"an error inside the rollback is recorded as a failed rollback: {rb}")
            fp = FakeP(env={"zz-shop-api": ["DATABASE_URL", "APP_VAULT_KEY", "CRON_SECRET"]}, projects=["zz-shop"], before=before); fp._deployed_address = boom
            fp._point_production = lambda rec, dep, cb_, how: (_ for _ in ()).throw(KeyboardInterrupt())
            a_ = dict(va); i_ = cp(vi); raised = None
            try: SS.vercel_deploy("zz_shop", a_, i_, vdir, fp, say=lambda s_: None, root=t, read_page=pages({}))
            except RuntimeError as e_: raised = e_
            saved_inf = json.load(open(os.path.join(vdir, "infrastructure.json")))
            ok(isinstance(raised, RuntimeError) and a_["status"] == "reverted" and saved_inf["vercel"]["rollback"]["result"] == "rollback FAILED" and "SITE MAY BE DOWN" in a_["revert"]["reason"],
               f"an unexpected error, then a Ctrl-C inside the rollback: recorded, reverted, the first error re-raised: {raised!r} {saved_inf['vercel'].get('rollback')}")
            # the console's sign-in keys required by the mold: the deploy asks for them before anything is deployed
            man_r = cp(man); man_r["vercel"]["projects"]["web"]["operator_env"] = {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": "required"}
            K_r = SS.console_facts(cb, man_r)
            u_, d_, o_ = SS.secret_names(F, "vercel", K_r)
            ok(u_ == ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] and "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" not in o_, f"a sign-in key the console requires is the operator's to set: {u_} {o_}")
        except BaseException as e_: ok(False, f"whole two-project deploys: crashed: {type(e_).__name__}: {e_}"[:300])

        # compose_remote: a release that comes up but fails health is switched back by the deploy itself
        try:
            Rb = Runner(dict(R.answers, health=(0, HEALTHY.replace("APP_UID=1000", "APP_UID=0")), back=(0, "ROLLED_BACK=20261019T000000Z\nSERVING=20261019T000000Z\n")))
            e = stop(runner=Rb)
            ok("back" in [c[0] for c in Rb.calls] and "switched back by itself" in e, f"a release that fails its health check is switched back automatically: {e[:160]}")
            Rn = Runner(dict(R.answers, health=(0, HEALTHY.replace("APP_UID=1000", "APP_UID=0")), back=(0, "NOTHING=no earlier release\n")))
            ok("no earlier release" in stop(runner=Rn), "...and says so when there is none")
        except BaseException as e_: ok(False, f"compose_remote: a release that comes up but fails health i: crashed: {type(e_).__name__}: {e_}"[:300])

        # packages.sh: an existing Docker is never replaced
        try:
            stubs = os.path.join(t, "stubs"); os.makedirs(stubs); log = os.path.join(t, "apt.log")
            def stub(name, body): open(os.path.join(stubs, name), "w").write("#!/bin/sh\n" + body + "\n"); os.chmod(os.path.join(stubs, name), 0o755)
            def docker_case(have_docker, compose_ok, pkg):
                for f in os.listdir(stubs): os.remove(os.path.join(stubs, f))
                open(log, "w").close()
                stub("apt-get", f'echo "$@" >> {log}')
                stub("dpkg", f'[ "$2" = "{pkg}" ]')
                if have_docker: stub("docker", "exit 0" if compose_ok else '[ "$1" = compose ] && exit 1; exit 0')
                env = {"PATH": stubs + ":/usr/bin:/bin" if have_docker else stubs + ":/nonexistent"}
                bash = shutil.which("bash")
                r = subprocess.run([bash, "-c", "command() { if [ \"$1\" = -v ] && [ \"$2\" = docker ]; then [ -x " + os.path.join(stubs, "docker") + " ]; return; fi; builtin command \"$@\"; }\n" + SS.DOCKER_LINES],
                                   env=env, capture_output=True, text=True)
                return r.returncode, open(log).read()
            rc, apt = docker_case(False, False, "")
            ok(rc == 0 and "docker.io docker-compose-v2" in apt, f"no Docker: docker.io and its compose plugin are installed ({apt.strip()})")
            rc, apt = docker_case(True, True, "docker-ce")
            ok(rc == 0 and apt.strip() == "", f"Docker with compose: nothing is installed ({apt.strip()})")
            rc, apt = docker_case(True, False, "docker-ce")
            ok(rc == 0 and "docker-compose-plugin" in apt and "docker.io" not in apt, f"docker-ce without compose: only its compose plugin, never docker.io ({apt.strip()})")
            rc, apt = docker_case(True, False, "none")
            ok(rc == 4 and "docker.io" not in apt, f"an unknown Docker without compose: refused, nothing installed ({rc}, {apt.strip()})")
        except BaseException as e_: ok(False, f"packages.sh: an existing Docker is never replaced: crashed: {type(e_).__name__}: {e_}"[:300])

        # up.sh: `previous` stays truthful through an automatic switch back, and --back with nowhere to go changes nothing
        try:
            inst = os.path.join(t, "inst"); os.makedirs(os.path.join(inst, "releases"))
            for rel in ("20261001T000000Z", "20261002T000000Z", "20261003T000000Z"): os.makedirs(os.path.join(inst, "releases", rel))
            os.symlink("releases/20261002T000000Z", os.path.join(inst, "current")); open(os.path.join(inst, "previous"), "w").write("20261001T000000Z\n")
            SU = dict(S, install=inst, current=os.path.join(inst, "current"), env_file=os.path.join(inst, "env"))
            up = os.path.join(t, "up.sh"); open(up, "w").write(SS.up_sh(SU))
            def upr(*args, docker_ok=True):
                for f in os.listdir(stubs): os.remove(os.path.join(stubs, f))
                stub("docker", "exit 0" if docker_ok is True else f'grep -q "{docker_ok}" {inst}/current/MARK 2>/dev/null && exit 0; exit 1')
                r = subprocess.run(["bash", up, *args], env={"PATH": stubs + ":/usr/bin:/bin", "SF_REMOTE_DEPLOY": SU["app_id"]}, capture_output=True, text=True)
                cur = os.path.basename(os.readlink(os.path.join(inst, "current"))); prev = open(os.path.join(inst, "previous")).read().strip() if os.path.exists(os.path.join(inst, "previous")) else ""
                return r.returncode, VR.parse_kv(r.stdout), cur, prev
            open(os.path.join(inst, "releases", "20261002T000000Z", "MARK"), "w").write("good\n")
            rc, kv, cur, prev = upr("20261003T000000Z", docker_ok="good")
            ok(rc == 1 and kv.get("ROLLED_BACK") == "20261002T000000Z" and cur == "20261002T000000Z" and prev == "20261001T000000Z",
               f"a release that does not come up: back to the one serving, and `previous` still names the one before it, not the failed one ({kv}, {cur}, {prev})")
            rc, kv, cur, prev = upr("20261003T000000Z")
            ok(rc == 0 and cur == "20261003T000000Z" and prev == "20261002T000000Z", f"a good release: previous is the one it replaced ({cur}, {prev})")
            rc, kv, cur, prev = upr("--back", "--drop")
            ok(rc == 0 and cur == "20261002T000000Z" and prev == "20261001T000000Z", f"the deploy's own switch back restores previous to what it said before ({cur}, {prev})")
            os.remove(os.path.join(inst, "previous"))
            rc, kv, cur, prev = upr("--back")
            ok(rc == 0 and kv.get("NOTHING") and cur == "20261002T000000Z", f"--back with nowhere to go says so and changes nothing ({kv})")
            # with a console (mold_v0-020): each image built on its own, the API's first, before the stack comes up
            try:
                FCu = SS.compose_facts(fixture_mold(os.path.join(t, "upc"), console=True), SS.manifest("mold_vx", os.path.join(t, "upc")))
                upc = os.path.join(t, "upc.sh"); open(upc, "w").write(SS.up_sh(SU, FCu)); dlog = os.path.join(t, "docker.log")
                for f in os.listdir(stubs): os.remove(os.path.join(stubs, f))
                def upc_run(services, mounted=""):
                    # services: what the release's compose file has; mounted: what a running caddy holds of the file `current` mounts
                    if os.path.exists(dlog): os.remove(dlog)
                    for f in os.listdir(stubs): os.remove(os.path.join(stubs, f))
                    cur_file = os.path.join(inst, "current", "Caddyfile"); open(cur_file, "w").write("new routes\n")
                    held = os.path.join(t, "held"); os.makedirs(held, exist_ok=True); open(os.path.join(held, "Caddyfile"), "w").write(mounted or "new routes\n")
                    stub("docker", f'echo "$*" >> {dlog}\ncase "$*" in\n *"config --services"*) printf "{services}";;\n *"ps -q"*) echo cid1;;\n'
                                   f' "inspect -f {{{{range"*) echo "{inst}/current/Caddyfile|/etc/caddy/Caddyfile";;\n "inspect -f {{{{index"*) echo caddy;;\n'
                                   f' "cp cid1:"*) tar -C {held} -cf - Caddyfile;;\nesac\nexit 0')
                    r = subprocess.run(["bash", upc, "20261003T000000Z"], env={"PATH": stubs + ":/usr/bin:/bin", "SF_REMOTE_DEPLOY": SU["app_id"]}, capture_output=True, text=True)
                    calls_ = [" ".join(l.split()[l.split().index("compose") + 7:]) if l.startswith("compose") else l for l in open(dlog).read().splitlines()]
                    return r, [c_.split(" --")[0] for c_ in calls_ if c_.startswith(("build", "up"))]
                r, calls_ = upc_run("app\\nweb\\n")
                ok(r.returncode == 0 and calls_ == ["build app", "build web", "up -d"], f"up.sh with a console: build app, build web, then up: {calls_} {r.stderr[-200:]}")
                r, calls_ = upc_run("app\\n")
                ok(r.returncode == 0 and calls_ == ["build app", "up -d"], f"a release from before the console (a rollback) builds only what its compose file has: {calls_} {r.stderr[-200:]}")
                r, calls_ = upc_run("app\\nweb\\n", mounted="old routes\n")
                ok(r.returncode == 0 and calls_[-1].startswith("up -d") and any("force-recreate" in l and l.rstrip().endswith("caddy") for l in open(dlog).read().splitlines()),
                   f"a container still holding the older release's mounted Caddyfile is recreated on the new one: {open(dlog).read()[-300:]}")
                r, calls_ = upc_run("app\\nweb\\n")
                ok("force-recreate" not in open(dlog).read(), "a container holding the current file is left running")
            except BaseException as e_: ok(False, f"up.sh with a console: crashed: {type(e_).__name__}: {e_}"[:300])
            R4 = Runner({"rollback": (0, "NOTHING=no earlier release to go back to (serving x); nothing was changed\nSERVING=x\n")}); said4 = []
            SS.rollback_remote("zz_shop", S, F, runner=R4, say=said4.append)
            ok(said4 and "nothing was changed" in said4[-1], f"--rollback-remote with nowhere to go says so: {said4}")
        except BaseException as e_: ok(False, f"up.sh: `previous` stays truthful through an automatic swit: crashed: {type(e_).__name__}: {e_}"[:300])

        # private files: 0700 directory and 0600 file even when they already exist wider
        try:
            pd = os.path.join(t, "priv"); os.makedirs(pd, mode=0o755); os.chmod(pd, 0o755); pf = os.path.join(pd, "k"); open(pf, "w").write("old"); os.chmod(pf, 0o644)
            SS.write_private(pf, "https://shop.example.org/mcp/key\n")
            ok(oct(os.stat(pd).st_mode & 0o777) == "0o700" and oct(os.stat(pf).st_mode & 0o777) == "0o600", "the lane key's directory and file are made private even when they existed")
        except BaseException as e_: ok(False, f"private files: 0700 directory and 0600 file even when they: crashed: {type(e_).__name__}: {e_}"[:300])
        # the console project's preflight: what the snapshot must have, read from its own files
        try:
            K0 = SS.console_facts(cb, man)
            ok(any("package-lock.json" in p for p in SS.console_preflight(dict(K0, lockfile=False))), "a console without its committed lockfile is refused before anything is created")
            ok(any("exactly one variable" in p for p in SS.console_preflight(dict(K0, api_env="", api_env_found=["A_URL", "B_URL"]))), "a next.config with two API-address variables is refused")
            ok(any("exactly one variable" in p and "none" in p for p in SS.console_preflight(dict(K0, api_env="", api_env_found=[]))), "a next.config with no API-address variable is refused")
            ok(SS.console_preflight(dict(K0, present=False)) and "not in the mold" in SS.console_preflight(dict(K0, present=False))[0], "no console directory is refused")
            realK = SS.console_facts(SS.codebase("mold_v0"), SS.manifest("mold_v0"))
            ok(SS.console_preflight(realK) == [] and realK["api_env"] and realK["framework"] == "nextjs", f"mold_v0's console at the pinned commit: one API-address variable, lockfile committed: {realK}")
            ok({r: SS.vercel_spec(SS.manifest("mold_v0"), r).get("suffix") for r in SS.ORDER} == SS.SUFFIX, "mold.json's project suffixes are the ones the code (and provision.py's refusal) use")
            ok(set(realK["optional"]) | set(realK["required"]) <= {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"} and "DATABASE_URL" not in realK["optional"] + realK["required"],
               "the console's own names are its sign-in keys only, never the database")
        except BaseException as e_: ok(False, f"the console project's preflight: crashed: {type(e_).__name__}: {e_}"[:300])
        # --- 9b. mold_v0-173: --operator on Vercel (the read-only operator:vault-status), and the check's key vault line ----
        try:
            import operator_run as OR_
            calls_ = []
            real_mf = OR_.main_for
            OR_.main_for = lambda *a_, **k_: (calls_.append((a_, k_)), 0)[1]
            try:
                fp = FakeP()
                rc = SS.main_for("zz_shop", ["zz_shop", "--operator", "vault-status", "--dry-run", "--", "--deploy", "--json"], dict(va), cp(vi), {}, vdir, fp, say=lambda s: None, root=t)
                v0 = calls_[-1][1].get("v0") if calls_ else {}
                ok(rc == 0 and len(calls_) == 1 and v0.get("env_project") == "zz-shop-api" and v0.get("build") == SS.source_for("zz_shop", va, t)
                   and [c[0] for c in fp.calls] == ["refuse"],
                   f"--operator on Vercel goes to lib/operator_run.py with the API project's env and the build copy, after the project refusal, before any deploy (even with --deploy after --): {calls_} {fp.calls}")
                calls_.clear(); fp = FakeP(refuse="zz_shop: vercel.project is a LIVE project. Nothing was written.")
                rc = SS.main_for("zz_shop", ["zz_shop", "--operator", "vault-status", "--yes"], dict(va), cp(vi), {}, vdir, fp, say=lambda s: None, root=t)
                ok(rc == 1 and not calls_, "--operator on a LIVE or another app's project is refused before the script is looked at")
                rec = cp(vi); rec["vercel"]["projects"] = {"api": "zz-shop-api", "web": "zz-shop"}
                SS.main_for("zz_shop", ["zz_shop", "--operator", "vault-status"], dict(va), rec, {}, vdir, FakeP(), say=lambda s: None, root=t)
                ok(calls_ and calls_[-1][1]["v0"]["env_project"] == "zz-shop-api", "the recorded api project is the one read")
            finally:
                OR_.main_for = real_mf
            said = []
            rc = SS.main_for("zz_shop", ["zz_shop", "--operator", "vault-status", "--yes"], dict(va), dict(cp(vi), target="compose_remote"), {}, vdir, FakeP(), say=said.append, root=t)
            ok(rc == 2 and "Vercel only" in " ".join(said), f"--operator on a compose_remote app says it runs on Vercel only, exit 2: {said}")
            pk = os.path.join(t, "packs", "vs_fixture", "files", "packs", "vs_fixture"); os.makedirs(pk, exist_ok=True)
            json.dump({"id": "vs_fixture", "job_kinds": [{"name": "scan", "providers": ["anthropic", "google"], "operator_credentials": ["login"]},
                                                        {"name": "audit", "providers": ["anthropic"]}, {"name": "tally", "workspace": True}]}, open(os.path.join(pk, "pack.json"), "w"))
            app_p = dict(va, packs=["vs_fixture", "vs_absent"])
            rn = SS.run_needs("zz_shop", app_p, "vercel", root=t)
            ok(rn["kinds"] == 3 and rn["needs"] == {"anthropic": ["vs_fixture.scan", "vs_fixture.audit"], "google": ["vs_fixture.scan"], "pack_credentials": ["vs_fixture.scan"]}
               and rn["boat"] and rn["unread"] == ["vs_absent"] and rn["store"] == ["vs_fixture.tally"], f"run_needs reads the packs' job kinds: providers, operator credentials, boat on Vercel: {rn}")
            said = []; SS.say_run_needs("zz_shop", app_p, "vercel", say=said.append, root=t)
            ok(len(said) == 1 and "anthropic (2 kinds; or a Vertex AI service-account key: Claude then runs on Vertex AI)" in said[0] and "boat (the runs' sandboxes on Vercel)" in said[0]
               and "object_storage (the workspace store of 1 kind, unless the server sets R2_*)" in said[0]
               and "python3 .claude/scripts/provision.py zz_shop --operator vault-status --dry-run" in said[0] and "vs_absent" in said[0],
               f"the check's one line: what the run kinds need and the exact command: {said}")
            said = []; SS.say_run_needs("zz_shop", app_p, "compose_remote", say=said.append, root=t)
            ok(len(said) == 1 and "boat" not in said[0] and "--operator" not in said[0] and "Key vault" in said[0], f"on its own server: no boat assumed, the Key vault page: {said}")
            said = []; SS.say_run_needs("zz_shop", dict(va, packs=[]), "vercel", say=said.append, root=t)
            ok(said == [], "an app without packs: no line")
            fp = FakeP(projects=["zz-shop-api", "zz-shop"]); said = []
            SS.vercel_check("zz_shop", app_p, cp(vi), fp, say=said.append, root=t)
            ok(any("--operator vault-status --dry-run" in l for l in said), f"provision.py <app> (the check) carries the line for a mold_v0 app on Vercel: {said[-6:]}")
        except BaseException as e_: ok(False, f"--operator vault-status (mold_v0-173): crashed: {type(e_).__name__}: {e_}"[:400])
        # --- 10. mint's stations ----------------------------------------------------------------------------------------
        os.environ["FACTORY_PRIVATE_DIR"] = os.path.join(t, "private")
        a = {"app_id": "zz_shop", "mold_id": "mold_vx", "status": "planned", "mold_commit": "c" * 40}
        i = {"target": "compose_remote", "compose_remote": {"domain": "shop.example.org"}}
        for st in ("workspaces", "package"):
            ok(SS.station(st, "zz_shop", a, i, t)[0] == SS.NA, f"{st} is not needed, with its reason")
        ok(SS.station("packs", "zz_shop", a, i, t) is None and SS.station("brand", "zz_shop", a, i, t) is None,
           "packs and brand keep mint's own readings: the mold has pack rules and brand rules (mold_v0-024)")
        ok(SS.station("brief", "zz_shop", None, None, t) is None and SS.station("keys", "zz_shop", a, i, t) is None, "brief, state and keys keep their own readings")
        ok(SS.station("deploy", "zz_shop", a, i, t)[0] == SS.TODO, "not deployed: the deploy is next, and needs no sign-in")
        dep = dict(i, deployed_at="2026-10-20T00:00:00+00:00", compose_remote={"domain": "shop.example.org", "production_url": "https://shop.example.org"})
        ok(SS.station("deploy", "zz_shop", dict(a, status="stamped"), dep, t)[0] == SS.DONE, "deployed on the pinned commit: done")
        ok(SS.station("deploy", "zz_shop", dict(a, status="stamped", mold_commit="d" * 40), dep, t)[0] == SS.TODO, "the mold moved: a redeploy is next")
        ran = {l: {"status": "pass", "run_at": "2026-10-20T01:00:00+00:00"} for l in SS.LANES}
        ok(SS.station("tests", "zz_shop", dict(a, testing=ran), dep, t)[0] == SS.OPERATOR, "lanes ran without the MCP check's organisation: the operator's yes is asked")
        os.makedirs(os.path.join(t, "private")); open(SS.lane_key_path("zz_shop"), "w").write("https://shop.example.org/mcp/key_standin\n")
        ok(SS.station("tests", "zz_shop", dict(a, testing=ran), dep, t)[0] == SS.DONE, "lanes ran with the lane key: done")
        ok(not SS.lane_key_ok("zz_shop", "https://elsewhere.example.org"), "a lane key for another address grades nothing")
        ok(SS.station("tests", "zz_shop", dict(a, testing=dict(ran, context={"status": "fail", "run_at": "x"})), dep, t)[0] == SS.FAILED, "a failed lane fails the station")
        ok(SS.station("address", "zz_shop", dict(a, status="stamped"), dep, t) == (SS.DONE, "https://shop.example.org"), "the address is the deployed domain")
        vdep = {"target": "vercel", "deployed_at": "2026-10-20T00:00:00+00:00", "vercel": {"project": "zz-shop", "production_url": "https://zz-shop.vercel.app", "api_url": "https://zz-shop-api.vercel.app"}}
        ok(SS.station("tests", "zz_shop", dict(a, status="stamped", testing=ran), vdep, t)[0] == SS.OPERATOR, "on Vercel the lane key must be for the API's address, not the console's")
        open(SS.lane_key_path("zz_shop"), "w").write("https://zz-shop-api.vercel.app/mcp/key_standin\n")
        ok(SS.station("tests", "zz_shop", dict(a, status="stamped", testing=ran), vdep, t)[0] == SS.DONE, "...and with the API's lane key the tests are done")
        ok("two Vercel projects" in SS.station("deploy", "zz_shop", a, {"target": "vercel", "vercel": {"project": "zz-shop"}}, t)[1], "the deploy station says it deploys two projects")
    finally:
        if home_was is not None: os.environ["HOME"] = home_was
        if priv_was is None: os.environ.pop("FACTORY_PRIVATE_DIR", None)
        else: os.environ["FACTORY_PRIVATE_DIR"] = priv_was
        shutil.rmtree(t, ignore_errors=True)
    rehearsal(ok)
    if fails:
        print("single_service self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"single_service: {n[0]} checks passed (offline: stand-in server, DNS, health and Vercel; the two-project deploy rehearsed through provision.py; nothing contacted)")
    return 0

if __name__ == "__main__": sys.exit(run())
