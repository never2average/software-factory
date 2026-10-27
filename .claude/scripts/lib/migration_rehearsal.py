#!/usr/bin/env python3
"""A migration rehearsal on a temporary copy of an app's LIVE database (mold_v0-142).

  provision.py <app_id> --rehearse-migrations --dry-run          the plan: what would be copied, run and deleted; contacts nothing
  provision.py <app_id> --rehearse-migrations [--yes] [--json]   do it (exit 3 without --yes: it asks for the yes first)
               [--codebase DIR]                                  run another copy of the code than build/<app_id>/ made afresh
  migration_rehearsal.py --self-test                              offline: a stand-in Neon API and a stand-in runner

WHY. A release whose migrations touch tables with live rows (mold_v0-142: the shell's 0025 adopts the account context and
memory tables a host pack made) is proven on throwaway databases by the mold's own tests. This proves it on the app's own
data, without touching it: the migrations the next deploy would apply are applied to a COPY, measured from that copy
(the codebase's `npm run db:rehearse`, src/migration-rehearsal.ts: what was pending, what ran and what was adopted
with nothing run, every relation whose definition changed, the adopted tables' rows and catalog rows before and after,
every table's row count, check:rls on the result), and the copy is deleted.

THE COPY.
  neon        a Neon branch of the project's default branch (copy-on-write: instant, the live branch is only read), with
              its own compute endpoint, named sf-rehearse-<app>-<UTC time>; deleted at the end whatever happened, and any
              sf-rehearse-<app>-* branch older than two hours (a run that died) is deleted before a new one is made. The
              project is the app's Vercel Marketplace resource (infrastructure.json datastores.neon_resource -> the
              store's externalResourceId, read with this machine's Vercel sign-in). Neon's API needs a Neon API key,
              referenced BY NAME (datastores.json postgres.usage_key_ref, default NEON_API_KEY, as db_usage.py reads
              it: this process's environment, else ~/.config/software-factory/db-usage.env, mode 0600). The branch's
              address comes from Neon's API for the branch's own database owner; it is handed to the rehearsal in its
              environment only, and never printed, logged or written.
  others      not built: a self-hosted, Supabase or RDS database has no copy-on-write branch here. It says so (exit 2)
              and names what to do instead; it never runs a rehearsal on the live database.

THE CODE. What the next deploy would ship: build/<app_id>/ made afresh (lib/single_service.py build_source: the brand,
the packs and their checks), under the app's deploy lock (one long step per app). --codebase runs another copy.

WHAT IT CHANGES. Nothing of the app: no deploy, no write to the live database (the branch is the only thing written),
nothing in the app's state. It creates one Neon branch and deletes it (Neon counts its compute time). The report is
kept in reports/migration-rehearsal/<app_id>-<time>.json (git-ignored). Exit 0: the rehearsal passed and the copy is
gone; 1: it failed (the report says why) or the copy could not be deleted (it names it); 2: it could not run; 3: a
person is needed (the key, or the yes).
"""
import datetime, json, os, re, subprocess, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agent_result as AR   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
NEON_API = "https://console.neon.tech/api/v2"
BRANCH_PREFIX = "sf-rehearse-"
STALE_S = 2 * 3600
READY_S = 300
REHEARSAL_S = 1800
KEY_NAME = re.compile(r"^NEON_[A-Z0-9_]+$")


def now(): return datetime.datetime.now(datetime.timezone.utc)
def stamp(t=None): return (t or now()).strftime("%Y%m%d%H%M%S")
def branch_name(app_id, t=None): return f"{BRANCH_PREFIX}{re.sub(r'[^a-z0-9-]', '-', app_id.lower())}-{stamp(t)}"


# ---- the calls that leave this machine (the self-test replaces them) ---------------------------------------------------

class Neon:
    """Neon's API with one key; the key goes in one header and never anywhere else."""
    def __init__(self, key, http=None):
        self.key = key; self.http = http or self._http
        AR.forbid(key)

    def _http(self, method, path, body=None):
        req = urllib.request.Request(f"{NEON_API}{path}", method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.key}", "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode("utf-8", "replace") or "{}")
        except urllib.error.HTTPError as e:
            try: doc = json.loads(e.read().decode("utf-8", "replace") or "{}")
            except ValueError: doc = {}
            return e.code, doc
        except Exception as e:  # noqa: BLE001 -- an unreachable API is a reason, never a crash
            return 0, {"message": type(e).__name__}

    def call(self, method, path, body=None, ok=(200, 201, 202, 204)):
        st, doc = self.http(method, path, body)
        if st not in ok: raise Failed(f"Neon's API answered {method} {path.split('?')[0]} with HTTP {st or 'no answer'}"
                                      f"{': ' + AR.scrub(str(doc.get('message')))[:200] if isinstance(doc, dict) and doc.get('message') else ''}")
        return doc


class Failed(Exception): pass
class NeedsHuman(Exception): pass


class Sources:
    """Everything here that reads the world: Vercel (the Neon project behind the resource), keys, the clock, processes."""
    @staticmethod
    def project_id(infra):
        import db_usage
        team = (infra.get("vercel") or {}).get("team") or None
        resource = (infra.get("datastores") or {}).get("neon_resource")
        if not resource: return None, "no Neon resource recorded in infrastructure.json (datastores.neon_resource)"
        listed = db_usage.vercel_resources(team)
        if listed is None: return None, "Vercel's list of databases could not be read (is this machine signed in to Vercel?)"
        match = [r for r in listed if r.get("name") == resource and str(r.get("product", "")).lower() == "neon"]
        if not match: return None, f"the Neon resource '{resource}' is not on the Vercel team"
        got = db_usage.vercel_api(f"/v1/storage/stores/{match[0]['id']}", team)
        store = (got or {}).get("store") if isinstance(got, dict) else None
        pid = (store or {}).get("externalResourceId")
        return (pid, None) if pid else (None, f"Vercel did not name the Neon project behind '{resource}'")

    @staticmethod
    def key(name):
        import db_usage
        return db_usage.key_by_name(name)

    neon = Neon
    sleep = staticmethod(time.sleep)
    clock = staticmethod(now)

    @staticmethod
    def run(cmd, cwd, env, timeout):
        return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)

    @staticmethod
    def build(app_id, app, say):
        import single_service
        return single_service.build_source(app_id, app, say=say)


# ---- the copy --------------------------------------------------------------------------------------------------------

def default_branch(api, project):
    branches = api.call("GET", f"/projects/{project}/branches").get("branches") or []
    main = [b for b in branches if b.get("default") or b.get("primary")]
    if not main: raise Failed("the Neon project has no default branch to copy")
    return main[0], branches


def remove_stale(api, project, app_id, branches, clock, say):
    """sf-rehearse-<app>-* branches older than two hours: a run that died before its own cleanup. Only exactly those."""
    pat = re.compile(rf"^{re.escape(BRANCH_PREFIX)}{re.escape(re.sub(r'[^a-z0-9-]', '-', app_id.lower()))}-(\d{{14}})$")
    gone = []
    for b in branches:
        m = pat.match(str(b.get("name") or ""))
        if not m: continue
        made = datetime.datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=datetime.timezone.utc)
        if (clock() - made).total_seconds() < STALE_S: continue
        api.call("DELETE", f"/projects/{project}/branches/{b['id']}", ok=(200, 202, 204, 404))
        gone.append(b["name"]); say(f"  removed a rehearsal copy left by an earlier run: {b['name']}")
    return gone


def make_copy(api, project, parent, name, say):
    """A branch of `parent` with its own read-write endpoint: its id (the caller deletes it, whatever happens next)."""
    doc = api.call("POST", f"/projects/{project}/branches", {"branch": {"parent_id": parent["id"], "name": name}, "endpoints": [{"type": "read_write"}]})
    bid = (doc.get("branch") or {}).get("id")
    if not bid: raise Failed("Neon made no branch (its answer named none)")
    say(f"  copy: Neon branch {name} of {parent.get('name') or 'the default branch'} (copy-on-write; the live branch is only read)")
    return bid


def copy_address(api, project, bid, name, src):
    """Once the branch is ready: its one database's owner's direct address (a secret: never printed)."""
    deadline = time.monotonic() + READY_S
    while True:
        b = api.call("GET", f"/projects/{project}/branches/{bid}").get("branch") or {}
        ops = api.call("GET", f"/projects/{project}/operations?branch_id={bid}").get("operations") or []
        if b.get("current_state") == "ready" and all(o.get("status") in ("finished", "skipped", "cancelled") for o in ops): break
        if any(o.get("status") == "failed" for o in ops): raise Failed(f"Neon could not finish the branch {name} (an operation failed)")
        if time.monotonic() > deadline: raise Failed(f"the branch {name} was not ready after {READY_S}s")
        src.sleep(3)
    dbs = api.call("GET", f"/projects/{project}/branches/{bid}/databases").get("databases") or []
    if len(dbs) != 1: raise Failed(f"the copy has {len(dbs)} databases; the rehearsal needs to know which one the app uses (one expected)")
    db = dbs[0]
    uri = api.call("GET", f"/projects/{project}/connection_uri?branch_id={bid}&database_name={db['name']}&role_name={db['owner_name']}&pooled=false").get("uri")
    if not uri: raise Failed("Neon gave no address for the copy")
    AR.forbid(uri)
    return uri


def drop_copy(api, project, bid, name, say):
    try:
        api.call("DELETE", f"/projects/{project}/branches/{bid}", ok=(200, 202, 204, 404))
        say(f"  copy deleted: {name}"); return True
    except Failed as e:
        say(f"  THE COPY WAS NOT DELETED ({AR.scrub(str(e))}): delete the Neon branch {name} in the Neon console (Branches)"); return False


# ---- the rehearsal itself ---------------------------------------------------------------------------------------------

def rehearse(codebase, uri, src):
    """`npm run db:rehearse -- --json` of the codebase, against the copy only: its report (dict)."""
    tsx = os.path.join(codebase, "node_modules", ".bin", "tsx")
    script = os.path.join(codebase, "scripts", "migration-rehearsal.ts")
    if not os.path.exists(script): raise Failed(f"{codebase} has no scripts/migration-rehearsal.ts: this mold has no rehearsal (mold_v0-142 added it to mold_v0)")
    if not os.path.exists(tsx): raise Failed(f"{codebase} has no node_modules/.bin/tsx: install the mold's dependencies first")
    keep = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "USER")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env.update(DATABASE_URL=uri, APP_MIGRATE_ON_BOOT="off", NODE_ENV="production")
    try: r = src.run([tsx, script, "--json"], codebase, env, REHEARSAL_S)
    except subprocess.TimeoutExpired: raise Failed(f"the rehearsal did not finish in {REHEARSAL_S}s")
    out = AR.scrub((r.stdout or "").replace(uri, "<database>"))
    try: doc = json.loads(out[out.index("{"):])
    except ValueError: raise Failed(f"the rehearsal printed no report (exit {r.returncode}): {AR.scrub((r.stderr or '').replace(uri, '<database>'))[-400:]}")
    doc["exit"] = r.returncode
    return doc


def summary_lines(doc):
    L = [f"pending before: {', '.join(doc.get('pending') or []) or 'none'}", f"applied: {', '.join(doc.get('applied') or []) or 'none'}"]
    d = doc.get("ddl") or {}
    L.append(f"DDL: created {', '.join(d.get('created') or []) or 'nothing'}; changed {', '.join(d.get('changed') or []) or 'nothing'}; dropped {', '.join(d.get('dropped') or []) or 'nothing'}")
    for t in doc.get("adopted_tables") or []:
        L.append(f"{t['table']}: rows {t['rows_before']} -> {t['rows_after']}" + (f", {'identical' if t['rows_identical'] else 'CHANGED'}, catalog "
                 f"{'unchanged (no DDL)' if t['catalog_unchanged'] else 'REWRITTEN'}" if t.get("rows_before") is not None else "") + f", shape {t['shape']}")
    ch = doc.get("rows_changed") or []
    L.append("row counts: " + (", ".join(f"{t['table']} {t['before']} -> {t['after']}" for t in ch) if ch else f"unchanged in all {doc.get('tables_checked')} tables"))
    r = doc.get("rls") or {}
    L.append(f"check:rls: {'pass' if r.get('pass') else 'FAIL: ' + '; '.join(r.get('problems') or [])}" + (f" ({r.get('probe_checks')} probe checks)" if r.get("pass") else ""))
    return L


# ---- provision.py <app> --rehearse-migrations ----------------------------------------------------------------------------

def plan_lines(app_id, provider, key_name, codebase):
    return [f"{app_id}: --rehearse-migrations would, in this order (nothing is created by this dry run):",
            f"  1. take {app_id}'s deploy lock (one long step per app)",
            f"  2. the code: {codebase or f'build/{app_id}/ made afresh (the brand, the packs and their checks), as the next deploy ships it'}",
            f"  3. find the Neon project behind the app's Vercel resource and read it with the key named {key_name}",
            f"  4. delete any {BRANCH_PREFIX}{app_id}-* branch older than two hours (a rehearsal that died)",
            f"  5. make a Neon branch {BRANCH_PREFIX}{app_id}-<time> of the default branch with its own compute (copy-on-write: the live database is only read)",
            "  6. run the code's `npm run db:rehearse -- --json` against that branch only: pending migrations applied there, measured before and after",
            "  7. delete the branch, whatever happened, and say so",
            f"  8. keep the report in reports/migration-rehearsal/{app_id}-<time>.json; nothing of the app's state or its live database is written"] \
        if provider == "neon" else [f"{app_id}: its database provider is {provider or '(none recorded)'}: only a Neon database can be copied for a rehearsal here (a branch)."]


def main_for(app_id, a, app, infra, ds, adir, src=Sources, say=print, root=None):
    root = root or ROOT
    want_json = "--json" in a
    out_say = (lambda s: print(s, file=sys.stderr)) if want_json else say
    pg = (ds or {}).get("postgres") or {}
    provider = str(pg.get("provider") or "")
    key_name = str(pg.get("usage_key_ref") or "NEON_API_KEY")
    codebase = os.path.abspath(a[a.index("--codebase") + 1]) if "--codebase" in a and a.index("--codebase") + 1 < len(a) else None

    def finish(ok, status, summary, next_="", details=None, code=None):
        """Print the outcome (one JSON result with --json); exit `code`, else the status's own (2: it could not run)."""
        # Through provision.py --json (lib/agent_result.py run_json) the result is built from these notes.
        AR.note(summary=AR.scrub(summary), next=next_ or None, status=status)
        for k, v in (details or {}).items(): AR.detail(k, v)
        if want_json: AR.emit(AR.result(ok, status, summary, next_, AR.NOTES["needs"], "", details or {}))
        else:
            say(summary)
            if next_: say(f"Next: {next_}")
        return AR.EXIT[status] if code is None else code

    if "--dry-run" in a:
        for l in plan_lines(app_id, provider, key_name, codebase): out_say(l)
        return finish(True, "done", f"{app_id}: dry run, nothing contacted or created.")
    if provider != "neon":
        return finish(False, "failed", f"{app_id}: its database is {provider or 'not recorded'}; a rehearsal copy is built only for Neon (a branch). "
                      "For another provider, restore a recent backup into a scratch database and run the codebase's `npm run db:rehearse` against it; "
                      "never against the live database.", code=2)
    if not KEY_NAME.match(key_name):
        return finish(False, "failed", f"{app_id}: datastores.json postgres.usage_key_ref '{key_name[:40]}' is not a Neon key name (NEON_...).", code=2)
    key = src.key(key_name)
    if not key:
        AR.need("secret", key_name, f"A Neon API key, so the factory can make (and then delete) a temporary copy of {app_id}'s database. "
                f"Open https://console.neon.tech, pick the organization that holds {app_id}'s database (for a database made through Vercel "
                f"it is named after the Vercel team), then Settings, API keys, Create new API key. Then, in a separate terminal on the "
                f"factory machine (never in this chat), add the line {key_name}=<the key> to ~/.config/software-factory/db-usage.env "
                f"and run chmod 600 on that file. The key is only ever sent to Neon, and db_usage.py reads the same line to measure storage.")
        return finish(False, "needs_human", f"{app_id}: needs a Neon API key ({key_name}) to make the copy; nothing was created.")
    if "--yes" not in a:
        AR.need("approval", "rehearse-migrations", f"A yes to make a temporary copy (a Neon branch) of {app_id}'s live database, apply the next "
                f"release's migrations to the copy only, and delete it. The live database is only read; Neon counts a few minutes of compute.")
        return finish(False, "needs_human", f"{app_id}: a rehearsal on a copy of the live database needs a yes first; nothing was created.",
                      f"python3 .claude/scripts/provision.py {app_id} --rehearse-migrations --yes")
    import runs
    lock = runs.Lock(root, app_id, "deploy")
    if not lock.acquire():
        return finish(False, "failed", f"{app_id}: another long step holds its lock ({lock.held_by.get('argv') and ' '.join(lock.held_by['argv'])[:120]}); nothing was started.")
    api, project, bid, name, deleted, report = None, None, None, None, None, None
    try:
        cb = codebase or src.build(app_id, app, out_say)
        out_say(f"  code: {os.path.relpath(cb, root) if cb.startswith(root + os.sep) else cb}")
        project, why = src.project_id(infra)
        if not project: raise Failed(why)
        api = src.neon(key)
        parent, branches = default_branch(api, project)
        remove_stale(api, project, app_id, branches, src.clock, out_say)
        name = branch_name(app_id, src.clock())
        bid = make_copy(api, project, parent, name, out_say)
        uri = copy_address(api, project, bid, name, src)
        report = rehearse(cb, uri, src)
    except Failed as e:
        report = report or {"status": "error", "error": AR.scrub(str(e))}
    except Exception as e:  # noqa: BLE001 -- the copy is deleted whatever went wrong
        report = report or {"status": "error", "error": AR.scrub(f"{type(e).__name__}: {e}")}
    finally:
        if api and bid: deleted = drop_copy(api, project, bid, name, out_say)
        lock.release()
    report = dict(report or {}, app=app_id, copy={"provider": "neon", "branch": name, "deleted": deleted}, at=AR.now())
    os.makedirs(os.path.join(root, "reports", "migration-rehearsal"), exist_ok=True)
    rpath = os.path.join(root, "reports", "migration-rehearsal", f"{app_id}-{stamp()}.json")
    with open(rpath, "w") as f: f.write(json.dumps(AR._scrub_all(report), indent=2) + "\n")
    rel = os.path.relpath(rpath, root)
    if report.get("status") == "error":
        return finish(False, "failed", f"{app_id}: the rehearsal could not run: {report['error']}" + ("" if deleted in (True, None) else f"; the copy {name} was NOT deleted"),
                      details={"report": rel}, code=1 if deleted is False else 2)
    for l in summary_lines(report): out_say("  " + l)
    ok = report.get("status") == "ok" and deleted is True
    said = (f"{app_id}: rehearsal {'PASSED' if report.get('status') == 'ok' else 'FAILED'} on a copy of the live database"
            + ("" if report.get("status") == "ok" else f" ({'; '.join(report.get('problems') or [])[:400]})")
            + ("; the copy is deleted" if deleted else f"; the copy {name} was NOT deleted: delete it in the Neon console") + f" (report: {rel})")
    return finish(ok, "done" if ok else "failed", said, details={"report": rel, "applied": report.get("applied"), "ddl": report.get("ddl"),
                  "adopted_tables": report.get("adopted_tables"), "rls_pass": (report.get("rls") or {}).get("pass")})


# ---- self-test: a stand-in Neon API and a stand-in runner, nothing contacted -------------------------------------------

def self_test():
    import tempfile, shutil
    checks = []
    def check(what, ok, got=None): checks.append((what, bool(ok), got))
    t0 = datetime.datetime(2026, 10, 26, 12, 0, 0, tzinfo=datetime.timezone.utc)
    SECRET_URI = "postgresql://owner:s3cr3t-pa55@ep-copy.neon.test/neondb?sslmode=require"

    class FakeNeon:
        def __init__(self, fail_delete=False, fail_ops=False, dbs=1):
            self.calls, self.branches, self.fail_delete, self.fail_ops, self.dbs = [], [
                {"id": "br-main", "name": "main", "default": True},
                {"id": "br-old", "name": "sf-rehearse-octillion-20261026080000"},
                {"id": "br-new", "name": "sf-rehearse-octillion-20261026115500"},
                {"id": "br-other", "name": "sf-rehearse-other-20261026080000"}], fail_delete, fail_ops, dbs
        def __call__(self, key):
            fake = self
            class Api(Neon):
                def __init__(s): Neon.__init__(s, key, http=fake.http)
            return Api()
        def http(self, method, path, body=None):
            self.calls.append((method, path.split("?")[0], body))
            if method == "GET" and path.endswith("/branches"): return 200, {"branches": self.branches}
            if method == "POST" and path.endswith("/branches"): return 201, {"branch": {"id": "br-copy", "name": body["branch"]["name"]}, "endpoints": [{"id": "ep-copy"}]}
            if method == "GET" and "/branches/br-copy/databases" in path: return 200, {"databases": [{"name": "neondb", "owner_name": "neondb_owner"}] * self.dbs}
            if method == "GET" and path.endswith("/branches/br-copy"): return 200, {"branch": {"id": "br-copy", "current_state": "ready"}}
            if method == "GET" and "/operations" in path: return 200, {"operations": [{"status": "failed" if self.fail_ops else "finished"}]}
            if method == "GET" and "/connection_uri" in path: return 200, {"uri": SECRET_URI}
            if method == "DELETE": return (500, {"message": "nope"}) if self.fail_delete and "br-copy" in path else (200, {})
            return 404, {"message": "unknown"}

    def world(report=None, exit_=0, key="neon-key-123456", **kw):
        fake = FakeNeon(**kw)
        class S(Sources):
            ran = []
            @staticmethod
            def project_id(infra): return "proj-1", None
            @staticmethod
            def key(name): return key
            neon = fake
            @staticmethod
            def sleep(s): pass
            @staticmethod
            def clock(): return t0
            @staticmethod
            def run(cmd, cwd, env, timeout):
                S.ran.append((cmd, cwd, env))
                class R: pass
                r = R(); r.returncode = exit_; r.stderr = ""
                r.stdout = "noise before\n" + json.dumps(report if report is not None else {"status": "ok", "problems": [], "pending": ["0025_account_context_memory"],
                    "applied": ["0025_account_context_memory (adopted)"], "ddl": {"created": ["table schema_adoptions"], "changed": [], "dropped": []},
                    "adopted_tables": [{"table": "account_context", "rows_before": 3, "rows_after": 3, "rows_identical": True, "catalog_unchanged": True, "shape": "as_migration_gives"}],
                    "rows_changed": [], "tables_checked": 70, "rls": {"pass": True, "problems": [], "probe_checks": 40}, "echo": env.get("DATABASE_URL")})
                return r
            @staticmethod
            def build(app_id, app, say): raise AssertionError("--codebase was given: nothing is built")
        return fake, S

    tmp = tempfile.mkdtemp(prefix="rehearse-selftest-")
    try:
        cb = os.path.join(tmp, "cb"); os.makedirs(os.path.join(cb, "node_modules", ".bin")); os.makedirs(os.path.join(cb, "scripts"))
        open(os.path.join(cb, "node_modules", ".bin", "tsx"), "w").close(); open(os.path.join(cb, "scripts", "migration-rehearsal.ts"), "w").close()
        neon_ds = {"postgres": {"provider": "neon"}}
        base = ["--rehearse-migrations", "--codebase", cb]
        out = []
        say = out.append
        # 1. dry run: the plan, nothing contacted
        fake, S = world()
        code = main_for("octillion", base + ["--dry-run"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("--dry-run: exit 0, the plan printed, Neon never called", code == 0 and not fake.calls and any("would, in this order" in l for l in out), out[-3:])
        # 2. no yes: exit 3, an approval asked for, nothing made
        AR.reset(); out.clear(); fake, S = world()
        code = main_for("octillion", base, {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("without --yes: exit 3, a yes asked for, nothing contacted", code == 3 and not fake.calls and AR.NOTES["needs"][0]["kind"] == "approval", AR.NOTES["needs"])
        # 3. no key: exit 3, the key asked for by name, never a value
        AR.reset(); out.clear(); fake, S = world(key=None)
        code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("no Neon key: exit 3 naming NEON_API_KEY, nothing contacted", code == 3 and AR.NOTES["needs"][0]["name"] == "NEON_API_KEY" and not fake.calls, AR.NOTES["needs"])
        # 4. another provider: refused, nothing run
        AR.reset(); out.clear(); fake, S = world()
        code = main_for("x", base + ["--yes"], {}, {}, {"postgres": {"provider": "self_hosted"}}, tmp, src=S, say=say, root=tmp)
        check("a self-hosted database: exit 2, never a rehearsal on the live database", code == 2 and not S.ran and not fake.calls, out[-1:])
        # 5. the run: stale branch removed (only this app's, only old), copy made, rehearsal against the copy, copy deleted
        AR.reset(); out.clear(); fake, S = world()
        code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        dels = [p for m, p, _ in fake.calls if m == "DELETE"]
        check("a passing rehearsal: exit 0", code == 0, out[-2:])
        check("only this app's rehearsal branches older than two hours are removed before", dels[:-1] == ["/projects/proj-1/branches/br-old"], dels)
        check("the copy is a branch of the default branch, with its own endpoint, named for the app and time",
              any(m == "POST" and b["branch"] == {"parent_id": "br-main", "name": "sf-rehearse-octillion-20261026120000"} and b["endpoints"] == [{"type": "read_write"}] for m, p, b in fake.calls if b), fake.calls)
        check("the copy is deleted at the end", dels[-1] == "/projects/proj-1/branches/br-copy", dels)
        cmd, cwd, env = S.ran[0]
        check("the rehearsal runs the codebase's own script against the copy only, in a clean environment",
              cmd[-1] == "--json" and cwd == cb and env["DATABASE_URL"] == SECRET_URI and env["APP_MIGRATE_ON_BOOT"] == "off" and "NEON_API_KEY" not in env, (cmd, sorted(env)))
        rep = sorted(os.listdir(os.path.join(tmp, "reports", "migration-rehearsal")))
        text = open(os.path.join(tmp, "reports", "migration-rehearsal", rep[-1])).read()
        check("the report is kept, and holds neither the copy's address nor the key", "s3cr3t" not in text and "neon-key-123456" not in text
              and json.loads(text)["copy"] == {"provider": "neon", "branch": "sf-rehearse-octillion-20261026120000", "deleted": True}, text[:300])
        check("nothing printed holds the address or the key", not any("s3cr3t" in l or "neon-key-123456" in l for l in out), [l for l in out if "s3cr3t" in l])
        check("the summary says what was adopted, the DDL, the rows and check:rls", any("adopted" in l for l in out) and any("account_context: rows 3 -> 3, identical, catalog unchanged" in l for l in out)
              and any("check:rls: pass" in l for l in out), out)
        # 6. a failing rehearsal: exit 1, the copy still deleted
        AR.reset(); out.clear(); fake, S = world(report={"status": "failed", "problems": ["account_context: DDL reached it"], "pending": [], "applied": [], "ddl": {}, "adopted_tables": [], "rows_changed": [], "tables_checked": 1, "rls": {"pass": True}}, exit_=1)
        code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("a failing rehearsal: exit 1 naming why, and the copy deleted all the same", code == 1 and "DDL reached it" in out[-1] and [p for m, p, _ in fake.calls if m == "DELETE"][-1].endswith("br-copy"), out[-1:])
        # 7. Neon fails to finish the branch: the copy is still deleted
        AR.reset(); out.clear(); fake, S = world(fail_ops=True)
        code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("a branch Neon could not finish: exit 2, and it is deleted", code == 2 and [p for m, p, _ in fake.calls if m == "DELETE"][-1].endswith("br-copy") and not S.ran, out[-2:])
        # 8. the copy cannot be deleted: said loudly, exit 1
        AR.reset(); out.clear(); fake, S = world(fail_delete=True)
        code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("a copy that could not be deleted: exit 1, named, with where to delete it", code == 1 and any("NOT DELETED" in l for l in out) and "NOT deleted" in out[-1], out[-2:])
        # 9. the lock: another long step of the app holds it
        import runs
        held = runs.Lock(tmp, "octillion", "deploy"); held.acquire(["provision.py", "octillion", "--deploy"])
        try:
            AR.reset(); out.clear(); fake, S = world()
            code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
            check("another long step of the app holds its lock: nothing started", code == 1 and not fake.calls, out[-1:])
        finally: held.release()
        # 10. two databases on the copy: refused (which one the app uses is not guessed)
        AR.reset(); out.clear(); fake, S = world(dbs=2)
        code = main_for("octillion", base + ["--yes"], {}, {}, neon_ds, tmp, src=S, say=say, root=tmp)
        check("a copy with two databases: refused, not guessed, and deleted", code == 2 and not S.ran and [p for m, p, _ in fake.calls if m == "DELETE"][-1].endswith("br-copy"), out[-1:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    bad = [c for c in checks if not c[1]]
    for what, ok, got in checks: print(f"  {'ok  ' if ok else 'FAIL'} {what}" + ("" if ok else f": {got!r}"[:600]))
    print(f"migration_rehearsal self-test: {len(checks) - len(bad)}/{len(checks)} passed")
    return 1 if bad else 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    print(__doc__); sys.exit(2)
