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
        u, d, o = SS.secret_names(F, "vercel"); ok(u == ["DATABASE_URL"] and d == ["APP_VAULT_KEY", "CRON_SECRET"], f"vercel names: {u} {d}")
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
        ok(SS.missing_build_inputs(SS.codebase("mold_v0"), real) == ["web/package-lock.json"],
           "mold_v0's snapshot lacks web/package-lock.json, which its Dockerfile copies (a finding for mold_v0-029: fixed in the mold's source)")
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
    finally:
        if home_was is not None: os.environ["HOME"] = home_was
        if priv_was is None: os.environ.pop("FACTORY_PRIVATE_DIR", None)
        else: os.environ["FACTORY_PRIVATE_DIR"] = priv_was
        shutil.rmtree(t, ignore_errors=True)
    if fails:
        print("single_service self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"single_service: {n[0]} checks passed (offline: stand-in server, DNS and health; nothing contacted)")
    return 0

if __name__ == "__main__": sys.exit(run())
