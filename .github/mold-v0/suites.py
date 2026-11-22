#!/usr/bin/env python3
"""The mold_v0 shell's own test suites, split into shards for GitHub Actions (.github/workflows/mold-v0.yml).

  python3 .github/mold-v0/suites.py list [--shards N] [--json]   every suite, its shard and its expected seconds
  python3 .github/mold-v0/suites.py run --shard K/N [--out DIR]   run shard K of N in molds/mold_v0/codebase, one suite at a
                                                                  time; exit 1 when any suite failed (all are still run)
  python3 .github/mold-v0/suites.py run --only test:ledger,smoke  run the named suites (the same commands, locally)
  python3 .github/mold-v0/suites.py check                         every test:* script is run or skipped with a reason

WHAT RUNS. Every `test:*` script of the codebase's package.json (a new one is picked up by itself, at DEFAULT_SECONDS
until a measured time is written into SECONDS below), minus SKIP (each with its reason), plus EXTRA: the functional
lane's embedded-database runs of `smoke`, `check:rls` and `test:migrations` (exactly as
molds/mold_v0/testing/functional/lane.json runs them) and the test files no package.json script names yet. Every
suite gets a database of its own: the embedded one it starts itself (PGlite), never a DATABASE_URL from outside. The
race suites (`*-race`: concurrent transactions PGlite cannot hold) need a real Postgres: each gets a fresh database,
created and dropped here, on the server MOLD_V0_PG_URL names (CI: the tests job's postgres service; locally, any
throwaway server, e.g. `docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16`). Without MOLD_V0_PG_URL
they fail, saying so; they are never skipped.
Browser halves (`--browser`) are not run; the drawn checks that need only a headless Chromium (CHROME_BIN, or
Playwright's chromium-headless-shell) are: the workflow installs one and names it in CHROME_BIN. Run as root (the workflow uses sudo), the suites that need root (run users, the evaluator's
own user in nested-runs-review, the firewall, the offline tools) run their root halves, as on the factory machine.

SHARDS. Suites are dealt longest first onto the shard with the least expected time so far (deterministic: same
package.json and SECONDS, same shards). `run` prints each suite's measured seconds and writes them to DIR/times.json;
after a CI run, copy the new numbers into SECONDS to keep the shards even. Standard library only.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CODEBASE = os.path.join(ROOT, "molds", "mold_v0", "codebase")
SUITE_TIMEOUT = 25 * 60          # one suite; a shard job's own timeout is in the workflow
DEFAULT_SECONDS = 60

# Suites not run in CI, each with why. Empty today: every test:* script runs (browser halves are opt-in flags).
SKIP = {
}

# Runs that are not a plain `npm run <test:*>`: name -> (argv, extra env, env names to remove). {tmp} is a fresh
# directory per run, removed afterwards.
EXTRA = {
    "smoke": (["npm", "run", "--silent", "smoke"], {"PGLITE_DIR": "{tmp}"}, ["DATABASE_URL", "CLICKHOUSE_URL"]),
    "check:rls": (["npm", "run", "--silent", "check:rls"], {"PGLITE_DIR": "{tmp}"}, ["DATABASE_URL"]),
    "test:migrations": (["npm", "run", "--silent", "test:migrations"], {"DATABASE_URL": ""}, ["MIGRATIONS_PG_URL"]),
    # Concurrent transactions on a real Postgres: {pg} is a fresh database on MOLD_V0_PG_URL's server.
    "test:nested-runs-race": (["npm", "run", "--silent", "test:nested-runs-race"], {"DATABASE_URL": "{pg}"}, []),
    "test:run-charges-race": (["npm", "run", "--silent", "test:run-charges-race"], {"DATABASE_URL": "{pg}"}, []),
    "test:run-start-race": (["npm", "run", "--silent", "test:run-start-race"], {"DATABASE_URL": "{pg}"}, []),
    "file:chart-tones": (["node_modules/.bin/tsx", "--tsconfig", "web/tsconfig.json", "scripts/chart-tones-test.ts"], {}, []),
    "file:detail-action-keys": (["node_modules/.bin/tsx", "scripts/detail-action-keys-test.ts"], {}, []),
    "file:error-classes": (["node_modules/.bin/tsx", "scripts/error-classes-test.ts"], {}, []),
    "file:lane-seed-where": (["node_modules/.bin/tsx", "scripts/lane-seed-where-test.ts"], {}, []),
}

# Measured seconds per suite on GitHub's ubuntu-latest runners (the shards' times.json of a green run). A suite not
# listed counts DEFAULT_SECONDS.
SECONDS = {
    "check:rls": 3,
    "file:chart-tones": 1,
    "file:detail-action-keys": 1,
    "file:error-classes": 1,
    "file:lane-seed-where": 1,
    "smoke": 16,
    "test:access-pages": 6,
    "test:access-request": 22,
    "test:admin-engine": 4,
    "test:admin-sections": 4,
    "test:agent-dock": 4,
    "test:agent-harness": 55,
    "test:agent-icon": 4,
    "test:agent-runner": 33,
    "test:agent-steps": 36,
    "test:audit-key-scan": 10,
    "test:audit-trail": 18,
    "test:build-rehearsal": 70,
    "test:checks": 14,
    "test:clerk-azp": 1,
    "test:client-skill": 12,
    "test:company-email": 8,
    "test:connect-page": 7,
    "test:connected-apps": 8,
    "test:console-hide": 22,
    "test:console-sidebar": 95,
    "test:console-tabs": 103,
    "test:console-types": 40,
    "test:context-memory": 18,
    "test:credentials": 11,
    "test:data-api": 5,
    "test:data-repositories": 10,
    "test:declarative-packs": 198,
    "test:declared-recipes-no-store": 4,
    "test:developer-console": 7,
    "test:developer-e2e": 6,
    "test:developer-surface": 5,
    "test:email": 4,
    "test:encrypted-fields": 6,
    "test:engine-packs": 13,
    "test:entitlements": 7,
    "test:env-names": 16,
    "test:event-outbox": 14,
    "test:features": 34,
    "test:freestyle-sandbox": 31,
    "test:gateway-pricing": 5,
    "test:generic-gaps": 5,
    "test:get-started": 9,
    "test:github-app": 7,
    "test:health-tabs": 3,
    "test:host-config": 62,
    "test:install-docs": 4,
    "test:journeys-tips": 21,
    "test:landing": 64,
    "test:large-writeback": 13,
    "test:ledger": 12,
    "test:legal": 9,
    "test:limits": 27,
    "test:log-drain": 40,
    "test:mcp-domain": 11,
    "test:mcp-followups": 10,
    "test:mcp-oauth": 11,
    "test:mcp-prompts": 10,
    "test:mcp-tools": 7,
    "test:member-keys": 5,
    "test:merged-tabs": 4,
    "test:metrics": 33,
    "test:migrations": 72,
    "test:nested-runs": 37,
    "test:nested-runs-race": 24,
    "test:no-account": 6,
    "test:oauth-providers": 19,
    "test:object-storage": 7,
    "test:onboarding": 7,
    "test:onprem-runners": 16,
    "test:pack-guide": 63,
    "test:packs": 64,
    "test:platform-account": 6,
    "test:proxy-hops": 4,
    "test:recipes": 8,
    "test:record-areas": 11,
    "test:record-batch": 4,
    "test:record-clocks": 5,
    "test:build-lifecycle": 45,
    "test:app-nav": 45,
    "test:apps-ui": 45,
    "test:records-339": 40,
    "test:record-contract": 1,
    "test:record-contract-runtime": 4,
    "test:record-display": 16,
    "test:record-export": 9,
    "test:record-files": 6,
    "test:record-gaps": 4,
    "test:record-import": 4,
    "test:record-pages": 39,
    "test:record-panel": 1,
    "test:record-resources": 7,
    "test:record-runs": 6,
    "test:required-outputs": 1,
    "test:row-maps": 1,
    "test:run-approvals": 8,
    "test:run-charges": 5,
    "test:run-charges-race": 3,
    "test:run-credentials": 13,
    "test:run-events": 8,
    "test:run-firewall": 28,
    "test:run-page": 9,
    "test:run-refusal": 5,
    "test:run-results": 6,
    "test:run-sandboxes": 62,
    "test:run-spend": 5,
    "test:run-start-race": 2,
    "test:run-tools": 3,
    "test:run-tools-real": 37,
    "test:run-users": 19,
    "test:runs": 17,
    "test:schedules": 6,
    "test:self-improvement": 15,
    "test:setup-email": 4,
    "test:share-image": 4,
    "test:shared-records": 3,
    "test:sign-in": 11,
    "test:sign-in-check": 4,
    "test:source-offer": 24,
    "test:status-pages": 10,
    "test:teams": 26,
    "test:usage": 5,
    "test:vault-status": 5,
    "test:vocabulary": 6,
    "test:words": 2,
    "test:workspace-files": 10,
    "test:workspace-hook": 11,
    "test:workspace-storage": 6,
    "test:workspace-store": 11,
    "test:zero-pack": 6,
}

ALWAYS_REMOVED = ["DATABASE_URL", "PGLITE_DIR", "CLICKHOUSE_URL", "MIGRATIONS_PG_URL"]


def scripts():
    with open(os.path.join(CODEBASE, "package.json")) as f: return json.load(f).get("scripts") or {}


def suites():
    """{name: (argv, env, unset)} in a stable order."""
    s = scripts(); out = {}
    for name in sorted(s):
        if not name.startswith("test:") or name in SKIP: continue
        out[name] = EXTRA.get(name) or (["npm", "run", "--silent", name], {}, [])
    for name, spec in sorted(EXTRA.items()):
        if name.startswith("file:") or name in s: out[name] = spec
    return out


def shards(n):
    """[[names]] for n shards: longest first onto the lightest shard."""
    names = sorted(suites(), key=lambda x: (-SECONDS.get(x, DEFAULT_SECONDS), x))
    bins = [[0, i, []] for i in range(n)]
    for x in names:
        b = min(bins, key=lambda b: (b[0], b[1])); b[0] += SECONDS.get(x, DEFAULT_SECONDS); b[2].append(x)
    return [b[2] for b in bins]


def check():
    s = scripts(); problems = []
    for name in SKIP:
        if name not in s: problems.append(f"SKIP names {name}, which package.json no longer has")
    for name, (argv, _, _) in EXTRA.items():
        if not name.startswith("file:") and name not in s: problems.append(f"EXTRA names {name}, which package.json does not have")
        for a in argv:
            if a.startswith("scripts/") and not os.path.isfile(os.path.join(CODEBASE, a)): problems.append(f"EXTRA {name}: {a} is missing")
    for name in SECONDS:
        if name not in suites(): problems.append(f"SECONDS names {name}, which is not a suite any more")
    listed = set(re.findall(r"scripts/[\w./-]+\.ts", " ".join(s.values()))) | {a for v in EXTRA.values() for a in v[0]}
    for f in sorted(os.listdir(os.path.join(CODEBASE, "scripts"))):
        if re.search(r"-(test|race)\.ts$", f) and f"scripts/{f}" not in listed:
            problems.append(f"scripts/{f} is run by no package.json script and is not in EXTRA (add it to one of them)")
    for p in problems: print("  " + p)
    print(f"{len(suites())} suites, {len(SKIP)} skipped" + (f"; {len(problems)} problem(s)" if problems else "; ok"))
    return 1 if problems else 0


def _pg(sql, url):
    """Run one statement on MOLD_V0_PG_URL's server (psql); the error text, or None."""
    try:
        r = subprocess.run(["psql", url, "-v", "ON_ERROR_STOP=1", "-qc", sql], capture_output=True, text=True, timeout=60)
        return None if r.returncode == 0 else (r.stderr or r.stdout).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return str(e)


def _database(name):
    """A fresh database for a race suite: (url, drop) or (None, why)."""
    base = os.environ.get("MOLD_V0_PG_URL", "")
    if not base: return None, "MOLD_V0_PG_URL is not set: a race suite needs a throwaway Postgres server (see the top of this file)"
    db = "suite_" + re.sub(r"[^a-z0-9]", "_", name.lower()) + f"_{os.getpid()}"
    err = _pg(f'DROP DATABASE IF EXISTS "{db}"', base) or _pg(f'CREATE DATABASE "{db}"', base)
    if err: return None, f"could not create database {db}: {err}"
    m = re.match(r"^(postgres(?:ql)?://[^/?]+)(/[^?]*)?(\?.*)?$", base)
    if not m: return None, "MOLD_V0_PG_URL is not a postgres://user:password@host:port/database address"
    return m.group(1) + "/" + db + (m.group(3) or ""), lambda: _pg(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)', base)


def _kill(p):
    try: os.killpg(p.pid, 9)
    except OSError: pass


def run(names, out):
    os.makedirs(out, exist_ok=True)
    every = suites(); results = []; summary = os.environ.get("GITHUB_STEP_SUMMARY")
    for name in names:
        argv, env_add, unset = every[name]
        tmp = tempfile.mkdtemp(prefix="suite-")
        env = {k: v for k, v in os.environ.items() if k not in ALWAYS_REMOVED and k not in unset}
        env.update({k: v.replace("{tmp}", tmp) for k, v in env_add.items()})
        env.setdefault("CI", "true")
        drop = None; no_db = None
        if any("{pg}" in v for v in env_add.values()):
            url, drop = _database(name)
            if url: env.update({k: v.replace("{pg}", url) for k, v in env_add.items() if "{pg}" in v})
            else: no_db, drop = drop, None
        log = os.path.join(out, re.sub(r"[^A-Za-z0-9_.-]", "_", name) + ".log")
        print(f"::group::{name}", flush=True)
        t0 = time.time(); rc = None
        with open(log, "w") as f:
            try:
                if no_db: raise OSError(no_db)
                p = subprocess.Popen(argv, cwd=CODEBASE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     errors="replace", start_new_session=True)
                timer = threading.Timer(SUITE_TIMEOUT, lambda: _kill(p)); timer.start()
                for line in p.stdout: sys.stdout.write(line); f.write(line)
                rc = p.wait(); timer.cancel()
                if time.time() - t0 >= SUITE_TIMEOUT:
                    rc = None; f.write(f"\n[suites.py] timed out after {SUITE_TIMEOUT}s\n")
            except OSError as e:
                f.write(f"[suites.py] could not start: {e}\n"); rc = 127
        secs = round(time.time() - t0)
        shutil.rmtree(tmp, ignore_errors=True)
        if drop: drop()
        print("::endgroup::", flush=True)
        ok = rc == 0
        results.append({"suite": name, "ok": ok, "rc": rc, "seconds": secs})
        print(f"{'PASS' if ok else 'FAIL'} {name} ({secs}s{'' if rc is not None else ', timed out'})", flush=True)
        if not ok:
            tail = open(log, errors="replace").read().splitlines()[-60:]
            print(f"::error title=mold_v0 {name} failed::{name} exited {rc if rc is not None else 'timed out'}; the last lines of its log follow")
            print("\n".join(tail), flush=True)
    with open(os.path.join(out, "times.json"), "w") as f: json.dump({r["suite"]: r["seconds"] for r in results}, f, indent=1, sort_keys=True)
    failed = [r for r in results if not r["ok"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} suites passed in {sum(r['seconds'] for r in results)}s"
          + (": FAILED " + ", ".join(r["suite"] for r in failed) if failed else ""))
    if summary:
        with open(summary, "a") as f:
            f.write("| suite | result | seconds |\n|---|---|---|\n")
            for r in results: f.write(f"| `{r['suite']}` | {'pass' if r['ok'] else '**FAIL**'} | {r['seconds']} |\n")
    return 1 if failed else 0


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("list"); l.add_argument("--shards", type=int, default=1); l.add_argument("--json", action="store_true")
    r = sub.add_parser("run"); r.add_argument("--shard"); r.add_argument("--only"); r.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "mold-v0-suites"))
    sub.add_parser("check")
    a = ap.parse_args(argv)
    if a.cmd == "check": return check()
    if a.cmd == "list":
        sh = shards(a.shards)
        if a.json: print(json.dumps([{"shard": i + 1, "expected_seconds": sum(SECONDS.get(x, DEFAULT_SECONDS) for x in s), "suites": s} for i, s in enumerate(sh)], indent=1)); return 0
        for i, s in enumerate(sh):
            print(f"shard {i + 1}/{a.shards}: {len(s)} suites, ~{sum(SECONDS.get(x, DEFAULT_SECONDS) for x in s) // 60} min expected")
            for x in s: print(f"  {x}  {SECONDS.get(x, '?')}")
        return 0
    if a.only:
        names = [x.strip() for x in a.only.split(",") if x.strip()]
        unknown = [x for x in names if x not in suites()]
        if unknown: print(f"not a suite: {', '.join(unknown)} (see `suites.py list`)"); return 2
    elif a.shard and re.match(r"^\d+/\d+$", a.shard):
        k, n = map(int, a.shard.split("/"))
        if not 1 <= k <= n: print("--shard K/N needs 1 <= K <= N"); return 2
        names = shards(n)[k - 1]
    else:
        print("run needs --shard K/N or --only NAME[,NAME]"); return 2
    return run(names, a.out)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
