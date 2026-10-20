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

def fixture_mold(t, lockfile=True):
    """A one-service mold in a temp factory root: mold.json, a compose file, a Dockerfile, the mold's bootstrap."""
    cb = os.path.join(t, "molds", "mold_vx", "codebase")
    os.makedirs(os.path.join(cb, "deploy")); os.makedirs(os.path.join(cb, "src"))
    open(os.path.join(cb, "deploy", "docker-compose.prod.yml"), "w").write(COMPOSE)
    open(os.path.join(cb, "deploy", "bootstrap.sh"), "w").write(BOOT)
    open(os.path.join(cb, "Dockerfile"), "w").write(DOCKERFILE)
    open(os.path.join(cb, "package.json"), "w").write("{}\n")
    if lockfile: open(os.path.join(cb, "package-lock.json"), "w").write("{}\n")
    man = json.load(open(os.path.join(ROOT, "molds", "mold_v0", "mold.json"))); man["mold_id"] = "mold_vx"
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
            docs = SS.shape_state(app_id, "mold_vx", "vercel", {"product_id": "zz_product"}, {"source": {"commit": "c" * 40}}, {"vercel_project": base}, {},
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
        code, out = go("zz_shop")
        ok(code == 0 and "Ready" in out and "not created yet" in out and set(W_()["projects"]) == {"zz-shop-api"}, f"rehearsal: the check is read-only and ready: {out[-400:]}")
        code, out = go("zz_shop", "--deploy")
        w = W_(); v = inf().get("vercel") or {}
        ok(code == 0 and st()["status"] == "stamped" and v.get("projects") == {"api": "zz-shop-api", "web": "zz-shop"} and v.get("api_url") == api_u and v.get("production_url") == web_u
           and (v.get("health") or {}).get("pages") == {"/admin": "307", "/app": "307"} and inf().get("deployed_at"), f"rehearsal: a first deploy serves both projects: {out[-700:]} {v}")
        ok(w["projects"]["zz-shop"]["env"] == {"SHOP_API_URL": api_u} and w["projects"]["zz-shop"].get("framework") == "nextjs"
           and w["projects"]["zz-shop-api"]["env"].get("PUBLIC_URL") == api_u and "APP_VAULT_KEY" in w["projects"]["zz-shop-api"]["env"],
           f"rehearsal: the console holds the API's address and nothing else; the API its database, keys and own address: {sorted(w['projects']['zz-shop']['env'])}")
        lines = [json.loads(l) for l in calls().splitlines()]
        dep = [x["argv"][x["argv"].index("--project") + 1] for x in lines if x.get("tool") == "vercel" and x["argv"][:1] == ["deploy"]]
        adds = [" ".join(x["argv"]) for x in lines if x.get("tool") == "vercel" and x["argv"][:2] == ["project", "add"]]
        ok(dep[-1] == "zz-shop" and set(dep[:-1]) == {"zz-shop-api"} and adds == ["project add zz-shop --scope t"], f"rehearsal: the API deploys first, the console last; the console project made under the team scope: {dep} {adds}")
        r = subprocess.run([sys.executable, os.path.join(t, ".claude", "scripts", "lib", "single_service.py"), "lane-key-path", "zz_shop"], cwd=t, env=env, capture_output=True, text=True)
        ok(r.returncode == 1 and api_u in r.stderr and web_u not in r.stderr, f"rehearsal: the lanes' MCP check is for the API's address: {r.stderr.strip()[-200:]}")
        good = prod()
        world(fault={"zz-shop": "health"}); code, out = go("zz_shop", "--deploy")
        rb = inf()["vercel"].get("rollback") or {}
        ok(code == 1 and prod() == good and st()["status"] == "reverted" and rb.get("result") == "rolled back" and "does not reach the API" in out,
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
    ok(real["service"] and real["default_project"] and real["port"] and real["healthcheck"], "mold_v0's snapshot: one built service, a default project, a port, a HEALTHCHECK")
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
            docs = SS.shape_state("zz_shape", "mold_v0", target, prod, mold, {"domain": "shape.example.org", "vercel_project": "zz-shape"}, {}, "briefs/zz_shape.md")
            d = os.path.join(t, "apps", "zz_shape"); os.makedirs(d, exist_ok=True)
            for nm, doc in zip(("application", "infrastructure", "datastores", "datainfra"), docs): json.dump(doc, open(os.path.join(d, nm + ".json"), "w"))
            errs, _ = factory._app_errors("zz_shape", d)
            ok(errs == [], f"intake's shape for target {target} validates: {errs[:3]}")
        a0, i0, d0, _ = SS.shape_state("zz_shape", "mold_v0", "compose_remote", prod, mold, {"domain": "shape.example.org"}, {}, "b")
        ok(i0["compose_remote"]["compose"]["project"] == "sf-zz-shape" and i0["secrets_user"] == [] and d0["postgres"]["exposure"] == "compose_network", "compose_remote state: own project, no operator values, database on the compose network")
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
        ok(env[2] == "DOMAIN=shop.example.org\nPUBLIC_URL=https://shop.example.org\n", f"the env step gets state's settings on stdin: {env[2]!r}")
        ok(all("-p sf-zz-shop" not in " ".join(c[1]) or "shop " not in " ".join(c[1]) for c in R.calls), "no step names the default project")
        ok(reads == ["https://shop.example.org/healthz"] and res["health"]["public"] == "200" and res["release"] == "20261020T000000Z", f"the public health read: {reads}")
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
        mv = SS.mint_values(cb, F, ["APP_VAULT_KEY", "CRON_SECRET"])
        ok(set(mv) == {"APP_VAULT_KEY", "CRON_SECRET"} and len(mv["CRON_SECRET"]) == 64, "Vercel's values: minted by the mold's own script, CRON_SECRET beside them")
        # --- 9. set-secret: declared names only, no $ sign, the value on stdin ----------------------------------------
        class P:   # the parts of provision.py set_secret_remote reaches
            @staticmethod
            def explain(n): pass
        R3 = Runner({}); S3 = dict(S, secrets_optional=["PAY_SECRET_KEY"])
        SS.set_secret_remote("zz_shop", S3, "PAY_SECRET_KEY", P, runner=R3, value="sk-standin-abcdef", say=lambda s: None)
        ok(R3.calls[0][2] == "PAY_SECRET_KEY=sk-standin-abcdef\n" and "sk-standin-abcdef" not in " ".join(R3.calls[0][1]), "set-secret sends NAME=value on stdin, never in the command")
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
                self.health = health or {}; self.before = before or {}; self.ndeploy = {}
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
            def _read_health(self, url):
                code = next((c for k, c in self.health.items() if url.startswith(k)), "200"); return (code, {"ok": code == "200"}, "")
            def _point_production(self, rec, dep, cb, how): self._rec("point", rec["project"], dep, how); return True, "ok"
            def explain(self, n): pass
            def trusted_stdin(self): return False
            def stop_for_human(self, msg): raise SystemExit(3)
        pages = lambda codes: (lambda url: (next((c for k, c in codes.items() if url.endswith(k)), "307"), ""))
        try:
            va = {"app_id": "zz_shop", "mold_id": "mold_vx", "status": "planned"}
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
            ok(not err and [d[1] for d in deploys] == ["zz-shop-api", "zz-shop-api", "zz-shop"] and deploys[0][2] == os.path.join("build", "zz_shop")
               and deploys[-1][2] == os.path.join("build", "zz_shop", "web") and all("--scope team-x" in d[3] for d in deploys),
               f"the API first (twice on a first deploy: it learns its own address), then the console from its own directory, all under the team scope: {err[:200]} {deploys}")
            ok(fp.calls.index(("set_env", "zz-shop", "SHOP_API_URL")) < fp.calls.index(deploys[-1]) and fp.projects["zz-shop"]["env"] == {"SHOP_API_URL": api_u},
               f"the console gets the API's address before its deploy, and nothing else: {fp.projects['zz-shop']['env']}")
            ok("DATABASE_URL" in fp.projects["zz-shop-api"]["env"] and {"APP_VAULT_KEY", "CRON_SECRET"} <= set(fp.projects["zz-shop-api"]["env"]) and fp.projects["zz-shop-api"]["env"]["PUBLIC_URL"] == api_u,
               "the API alone gets the database, the minted keys and PUBLIC_URL (its own address)")
            ok(v_["projects"] == {"api": "zz-shop-api", "web": "zz-shop"} and v_["api_url"] == api_u and v_["production_url"] == web_u
               and v_["health"] == {"api": "200", "web": "200", "pages": {"/admin": "307", "/app": "307"}} and i_.get("deployed_at") and a_["status"] == "stamped"
               and v_["release"]["before"] == {"api": None, "web": None}, f"state: both names, both addresses (production is the console), both healths: {v_}")
            vd = {"app_id": "zz_shop", "mold_id": "mold_vx"}
            ok(SS.problems("zz_shop", {"application": vd, "infrastructure": i_, "datastores": {"postgres": {"provider": "neon"}}}) == [], "the recorded state passes validate's rules")
            ok(SS.mcp_address(i_) == api_u and SS.address(i_) == web_u, "the MCP check targets the API; people open the console")
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
        # --- 10. mint's stations ----------------------------------------------------------------------------------------
        os.environ["FACTORY_PRIVATE_DIR"] = os.path.join(t, "private")
        a = {"app_id": "zz_shop", "mold_id": "mold_vx", "status": "planned", "mold_commit": "c" * 40}
        i = {"target": "compose_remote", "compose_remote": {"domain": "shop.example.org"}}
        for st in ("packs", "brand", "workspaces", "package"):
            ok(SS.station(st, "zz_shop", a, i, t)[0] == SS.NA, f"{st} is not needed, with its reason")
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
