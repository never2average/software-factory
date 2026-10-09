#!/usr/bin/env python3
"""Clone: replicate a live mold_v1 deployment into a stamped application and regression-diff the two.

  clone.py <app_id> plan                 what the steps below would do, no secrets touched
  clone.py <app_id> extract              live surface -> application.json + datainfra.json (read-only on live)
  clone.py <app_id> snapshot [--apply]   pg_dump live -> restore into the app's fresh database; copy the blob tree
  clone.py <app_id> rls                  re-cover and re-PROVE tenant isolation after the restore (never optional)
  clone.py <app_id> configure            apply application.surface to the app's database (after deploy + migrations)
  clone.py <app_id> regress              diff app vs live (tables, surface rows, blob tree) -> report + clone_of.regression
  clone.py <app_id> blobls               top-level folder counts of the live data room (whole store), to check the prefix
  clone.py <app_id> run                  all of the above in order, plus provision check + deploy, stopping at the first failure

Secrets: every step pulls env values from Vercel at run time into a temp file inside the mold
dir, uses them for that one command and deletes the file. Nothing is written to state or git.
The live project is only ever read (env pull, SELECT, pg_dump, blob list). Run from a human
terminal: the agent runtime is not allowed to handle secret values.
"""
import json, os, sys, subprocess, datetime, shutil, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state"); NOW = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
STAMP = datetime.datetime.fromisoformat(NOW).strftime("%Y-%m-%dT%H%M%SZ")   # the same second as run_at, cut for a filename
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lanes import reserve_report   # ONE implementation of "a report path nobody can reopen", shared with the lanes
from factory import _ts, TS_FORM   # ONE reading of an ISO-8601 instant, shared with validate (lanes.py imports factory the same way)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from factory_local import live_projects
import legacy
# The reference deployment, only ever read and never deployed to. Its project names are this machine's own
# (state/factory.local.json -> live_projects), never the repository's.
LIVE = live_projects()
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")

def pull_env(project, cwd, _back_to=None):
    """Production env of `project` as a dict. Names the project explicitly and never relinks the mold dir:
    other agents share that directory, and a relink mid-run can point another step at the wrong project."""
    tmp = os.path.join(cwd, f".env.clone.{project}")
    try:
        subprocess.run(f"vercel env pull --yes --environment=production --project {project} {tmp}", shell=True, cwd=cwd, capture_output=True, check=True)
        vals = {}
        for l in open(tmp):
            if "=" in l and not l.startswith("#"): k, v = l.split("=", 1); vals[k.strip()] = v.strip().strip('"')
        if not vals: sys.exit(f"could not pull the production environment of {project}")
        return vals
    finally:
        if os.path.exists(tmp): os.remove(tmp)
# The ADMIN url, in provider order. DATABASE_URL is last on purpose: after the app_rw bootstrap it is
# a NOBYPASSRLS role that owns nothing, so pg_restore and pg_dump need one of the others. This is the
# migration/restore credential ONLY — `configure` deliberately uses DATABASE_URL, because surface
# writes are application writes and must go through RLS. Same chain as provision.py's admin_url().
def pg_url(vals): return next((vals[k] for k in ("SUPABASE_POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "POSTGRES_ADMIN_URL", "DATABASE_URL") if vals.get(k)), "")

def live_blob_token(mold, proj, prefix):
    """The live blob store belongs to one of the three live projects; find a token that can list it. None = skip blob work."""
    for name in (LIVE["web"], LIVE["api"], LIVE["workflow"]):
        tok = pull_env(name, mold, proj).get("BLOB_READ_WRITE_TOKEN", "")
        if not tok: continue
        r = subprocess.run(["node", os.path.join(ROOT, ".claude/scripts/lib/surface.mjs"), "blobcheck"], cwd=mold, env=dict(os.environ, MOLD_DIR=mold, BLOB_READ_WRITE_TOKEN=tok, BLOB_PREFIX=prefix), capture_output=True, text=True)
        try:
            if json.loads(r.stdout).get("ok"): print(f"live blob store reachable through {name}"); return tok
        except Exception: pass
    print("no live project has a token the blob store accepts; the clone keeps its own empty data room and blob checks are skipped")
    return None

def write_report(rdir, app_id, text):
    """Land the regression report where nothing can rewrite it, and return its path.

    The report is evidence: `testing.context.report`, `clone_of.regression.report` and a standing
    `revert.reason` all point at it. The convenient write (a date-only name reopened with "w") let a
    same-day re-clone silently replace the file a `reverted` record still cites. So it lands exactly the
    way lanes.py lands a lane report — reserve_report: the UTC second in the name, O_EXCL so even an
    identical name takes the next suffix, 0444 afterwards. Name: <app_id>-regression-<stamp>[-n].md."""
    os.makedirs(rdir, exist_ok=True)
    fd, rpath = reserve_report(rdir, f"{app_id}-regression", STAMP)
    with os.fdopen(fd, "w") as fh: fh.write(text)
    os.chmod(rpath, 0o444)   # a fence for a non-root operator; O_EXCL above is the guarantee (see lanes.py)
    return rpath

def isolation_findings(app_id, pg):
    """Why the tenant-isolation evidence in `pg` (datastores.postgres) does NOT support a passing context lane; [] means it does.

    A row-count diff cannot see a wiped policy set, so `regress` used to report `pass` on a clone with no
    tenant isolation at all; the isolation evidence is part of the verdict. This function is the whole
    verdict on that evidence, kept apart from main() so it can be exercised with constructed blocks and
    without a database. It mirrors factory.py's _rls_claim for the fields both read, and stays STRICTER
    where a clone is concerned: a clone's whole point is to stand in front of traffic as a replica of live."""
    want = pg.get("rls"); ev = pg.get("rls_verified") or {}
    # `off` is an explicit, schema-validated declaration (datastores.schema.json enum) that asks for no isolation
    # and is asked nothing, same as factory.py. ABSENT is not `off`: the schema does not require postgres.rls,
    # so a clone whose datastores.json never said what it asks for used to read as `off` here and skip this
    # whole verdict — running_app included — and pass the context lane with nothing measured. An absent
    # declaration is UNMEASURED and one instruction (mold_v1-052); what the serving process reported is still
    # read below, because a definitive `not_enforced` from /api/ops/health is a finding whatever was declared.
    # `off` asks for nothing from the STORED credential, but a definitive `not_enforced` read off the serving
    # process is a fact about a replica of live whatever it declared: it is reported, never discarded. Anything
    # short of definitive (`unmeasured`, absent) is what `off` opted out of, so only that one token survives.
    if want == "off": return [f for f in _running_app_findings(app_id, ev) if ev.get("running_app") == "not_enforced"]
    if want is None:
        iso = [f"datastores.json declares no postgres.rls at all, so nothing says what this replica asks for and nothing measured it — set postgres.rls to \"fail_closed\" (or \"on\") in state/application/{app_id}/datastores.json, then run `python3 .claude/scripts/clone.py {app_id} rls`"]
        return iso + (_running_app_findings(app_id, ev) if ev else [])
    if not ev or str(ev.get("source", "")).startswith("not verified"): return [f"declares rls {want} but nothing has measured it"]
    iso = []
    # Instants, not strings. "2026-09-09T01:00:00+09:00" sorts AFTER "2026-09-08T18:00:00+00:00" as text and is the
    # EARLIER instant, so the raw comparison let a proof taken before a restore stand as a proof about the restored
    # database whenever the two writers used different offsets. _ts is factory.py's reading; an unparseable stamp
    # is a finding, not a skipped comparison (a comparison that cannot run is not one that passed).
    at = str(ev.get("at") or ""); atd = _ts(at); snap = str((pg.get("snapshot") or {}).get("taken_at") or ""); sd = _ts(snap) if snap else None
    if not atd: iso.append(f"the proof carries no orderable `at` ({at[:60]!r}), so nothing can tell whether it predates the restore — run `clone.py {app_id} rls`")
    elif snap and not sd: iso.append(f"postgres.snapshot.taken_at is {snap[:60]!r}, not {TS_FORM}, so nothing can tell whether the restore came after the proof")
    elif sd and atd < sd: iso.append(f"the proof ({at}) predates the restore ({snap}) — run `clone.py {app_id} rls`")
    if ev.get("mode") != want: iso.append(f"declares {want}, measured {ev.get('mode')}")
    if ev.get("unprotected"): iso.append(f"{len(ev['unprotected'])} of {ev.get('org_scoped_tables')} org-scoped tables unprotected")
    # A restore can leave a policy in place and still leave it OPEN: judged by what the
    # policies did when they were executed, not by how many exist.
    if ev.get("open_policies"): iso.append(f"{len(ev['open_policies'])} permissive policy/policies do not scope by org_id ({', '.join(ev['open_policies'][:4])})")
    if ev.get("leaking_policies"): iso.append(f"{len(ev['leaking_policies'])} policy/policies handed over another workspace's rows when executed ({', '.join(ev['leaking_policies'][:3])})")
    if ev.get("unmeasured"): iso.append(f"{len(ev['unmeasured'])} org-scoped table(s) were never measured ({', '.join(ev['unmeasured'][:4])})")
    if ev.get("foreign_rows_readable"): iso.append(f"{ev['foreign_rows_readable']} foreign row(s) readable")
    if ev.get("cross_org_write") != "42501": iso.append(f"cross-workspace INSERT not refused ({ev.get('cross_org_write')})")
    if want == "fail_closed" and ev.get("unset_org_rows"): iso.append(f"{ev['unset_org_rows']} row(s) visible with no workspace in scope")
    # THE PROCESS IN FRONT OF TRAFFIC. Every field above is about the stored credential; a Vercel env change
    # only reaches the app on its next build, so the serving process can still hold a BYPASSRLS url while the
    # stored one passes every probe. provision.py reads /api/ops/health and records the verdict as one of three
    # tokens (datastores.schema.json: rls_verified.running_app); this verdict used to read every field but that
    # one, so a replica whose own record said its serving build ignores every policy still passed the context
    # lane. Equality against the single affirmative token is the whole test. `not_enforced` is a definitive
    # reading and only a new build clears it. `unmeasured`, absent, or any spelling outside the enum reads as a
    # FAIL, not a pass: nothing measured the serving process, and unmeasured is not measured-good — the
    # convenient reading ("absent, so nothing to fail") is exactly how the old verdict passed this replica.
    return iso + _running_app_findings(app_id, ev)

def _running_app_findings(app_id, ev):
    """The running_app verdict alone (isolation_findings says why it exists); split out so an absent declaration
    still reads what the serving process reported instead of skipping it with the rest."""
    ra = ev.get("running_app"); rd = str(ev.get("running_app_detail") or "").strip()[:160]; rd = f" ({rd})" if rd else ""
    if ra == "not_enforced": return [f"the app SERVING TRAFFIC reports row-level security is not enforced on /api/ops/health{rd} — only a new build replaces the credential it holds: run `python3 .claude/scripts/provision.py {app_id} --deploy`"]
    if ra != "enforced": return [f"nothing usable was read from the app SERVING TRAFFIC (rls_verified.running_app is {ra!r}){rd} — the process answering requests is not known to be enforcing it: run `python3 .claude/scripts/provision.py {app_id} --verify-rls`"]
    return []

def node(cmd, env, cwd, stdin=None, extra=()):
    r = subprocess.run(["node", os.path.join(ROOT, ".claude/scripts/lib/surface.mjs"), cmd, *extra], cwd=cwd, env=env, input=stdin, capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr.strip() or f"surface.mjs {cmd} failed")
    return json.loads(r.stdout)

def main(a):
    if len(a) < 2: sys.exit(__doc__)
    app_id, step = a[0], a[1]; apply_it = "--apply" in a
    adir = os.path.join(ST, "application", app_id)
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    ds = load(os.path.join(adir, "datastores.json")); di = load(os.path.join(adir, "datainfra.json"))
    mold = os.path.join(ROOT, "molds", app["mold_id"], "codebase"); proj = infra.get("vercel", {}).get("project")
    org = app["workspace"]["org"]["org_id"]; prefix = ""   # whole store: the mold keeps the data room under dataroom/ and org subtrees under dataroom/orgs/<org>/
    clone = app.get("clone_of")
    if step != "configure" and not clone: sys.exit(f"{app_id} has no clone_of; only `configure` applies to a non-clone app")
    if step != "configure" and not all(LIVE.get(k) for k in ("web", "api", "workflow")):
        sys.exit("This machine does not name the live deployment to clone. Put its three Vercel project names in "
                 "state/factory.local.json under \"live_projects\" ({\"web\": ..., \"api\": ..., \"workflow\": ...}), then run this again.")
    if step == "plan":
        print(f"{app_id}: org={org} project={proj} live={LIVE['web']} prefix={prefix} scope={ds['postgres'].get('scope')}")
        print("  extract   SELECT surface tables on live -> application.surface, datainfra.{platforms,deployments,pipelines,agents}")
        print(f"  snapshot  pg_dump --schema=public live -> pg_restore into {proj}; blob list+copy under {prefix} (needs --apply)")
        print(f"  configure surface.mjs apply against {proj} (upserts org, members, admins, roster, profile, configs, definitions, scripts)")
        print(f"  regress   counts + keyed diff of surface tables + blob tree, {proj} vs live -> molds/{app['mold_id']}/testing/context/reports/{app_id}-regression-<utc second>.md")
        if ds["postgres"].get("scope") != "fresh": print("  WARNING: snapshot/configure refuse unless datastores.postgres.scope is fresh")
        return
    if step in ("snapshot", "configure") and ds["postgres"].get("scope") != "fresh": sys.exit("refusing: datastores.postgres.scope must be fresh (never write to the live database)")
    if not proj: sys.exit("no Vercel project in infrastructure.json")
    base = dict(os.environ, MOLD_DIR=mold, ORG_ID=org, BLOB_PREFIX=prefix)

    if step == "extract":
        live = pull_env(LIVE["web"], mold, proj); url = pg_url(live); tok = live_blob_token(mold, proj, prefix) or ""
        xenv = dict(base, DATABASE_URL=url, BLOB_READ_WRITE_TOKEN=tok, STATE_JSON=os.path.join(adir, "application.json"))
        out = node("extract", xenv, mold)
        if not any(out["counts"].values()):
            others = [o for o in out["orgs"] if o["org_id"] != org]
            print(f"live has no rows for org '{org}'. orgs on live: " + (", ".join(f"{o['org_id']} ({o['name']}, {o['status']}, {o['members']} members)" for o in out["orgs"]) or "none"))
            if len(others) == 1:
                org = others[0]["org_id"]; print(f"adopting the only live org: {org}")
                app["workspace"]["org"]["org_id"] = org; app["workspace"]["org"]["blob_prefix"] = f"orgs/{org}"
                di["dataroom"]["blob_prefix"] = f"orgs/{org}"; ds["blob"]["root_prefix"] = f"orgs/{org}"; save(os.path.join(adir, "datastores.json"), ds); save(os.path.join(adir, "application.json"), app)
                out = node("extract", dict(xenv, ORG_ID=org, BLOB_PREFIX=f"orgs/{org}"), mold)
            else:
                sys.exit("set application.surface.primary_context.workspace.org_id to one of them and re-run")
        s = app["surface"]; x = out["surface"]; w = app["workspace"]; xw = out["workspace"]
        w["org"].update(xw["org"]); w.update({k: v for k, v in xw.items() if k != "org" and v})
        me = legacy.get(w, "operator_self", {})["email"]   # or its pre-rename spelling, where this machine names one (lib/legacy.py)
        if not any(m["email"] == me for m in w["members"]): w["members"].insert(0, {"email": me, "role": "owner"})
        pc = s["primary_context"]; xp = x["primary_context"]
        pc["corpus"] = xp.get("corpus", pc["corpus"])
        if xp.get("corpus_files", {}).get("error"): print("blob listing failed on live (" + xp["corpus_files"]["error"] + "); corpus file counts skipped")
        elif xp.get("corpus_files"): pc["corpus_files"] = xp["corpus_files"]
        pc["instructions"].update(xp["instructions"]); pc["memory"].update({k: v for k, v in xp["memory"].items() if v not in ([], None)})
        mc = s["multiplayer_context"]; xm = x["multiplayer_context"]
        mc["processes"] = xm.get("processes", mc["processes"]); mc["escalation"].update({k: v for k, v in xm["escalation"].items() if v}); clone["live_evidence"] = xm["evidence"]
        gaps = [(p["name"], [i["ref"] for i in p["implemented_by"] if not i.get("present")]) for p in mc["processes"]]; gaps = [g for g in gaps if g[1]]
        if gaps: print("processes with features missing on live: " + "; ".join(f"{n}: {', '.join(r)}" for n, r in gaps))
        s["custom_workflow_builder"].update(x["custom_workflow_builder"])
        for k in ("platforms", "deployments", "pipelines", "agents"): di[k] = out["datainfra"][k]
        di["dataroom"]["seed"] = {"source": "live_snapshot"}
        clone["extracted_at"] = NOW; clone["live_counts"] = out["counts"]
        save(os.path.join(adir, "application.json"), app); save(os.path.join(adir, "datainfra.json"), di)
        print(f"extracted from {LIVE['web']} org={org}: " + ", ".join(f"{t}={n}" for t, n in out["counts"].items() if n))
        r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/factory.py"), "validate"], capture_output=True, text=True); print(r.stdout.strip())
        sys.exit(r.returncode)

    if step == "snapshot":
        live = pull_env(LIVE["web"], mold, proj); mine = pull_env(proj, mold, proj)
        src, dst = pg_url(live), pg_url(mine)
        if not src or not dst: sys.exit("missing a database url (live or app); run provision.py first")
        dump = os.path.join(tempfile.mkdtemp(prefix="clone-"), "live.dump")
        print("pg_dump live (schema public, no owners/privileges) ...")
        subprocess.run(["pg_dump", "--format=custom", "--schema=public", "--no-owner", "--no-privileges", "--file", dump, src], check=True)
        print(f"  {os.path.getsize(dump)//1024} KB")
        tok = live_blob_token(mold, proj, prefix)
        benv = dict(base, LIVE_BLOB_READ_WRITE_TOKEN=tok or "", BLOB_READ_WRITE_TOKEN=mine.get("BLOB_READ_WRITE_TOKEN", ""))
        if not apply_it:
            if tok: b = node("blobcopy", benv, mold); print(f"blob under {prefix}: {b['files']} files, {b['bytes']//1024} KB")
            print("dry run; re-run with --apply to restore into the app database and copy the blobs"); shutil.rmtree(os.path.dirname(dump)); return
        # DATA ONLY, into the schema the deploy already built. `--clean --if-exists` emitted
        # `DROP SCHEMA IF EXISTS public; CREATE SCHEMA public;` ahead of everything else, which took the
        # RLS policies, the relrowsecurity/relforcerowsecurity flags, every grant to app_rw and the whole
        # pg_default_acl with it — measured: policies 2 -> 0, relforcerowsecurity t -> f,
        # has_table_privilege('app_rw', 'customers', 'SELECT') t -> f, exit code 0, and `regress` then
        # reported pass because it compares row counts and never looks at pg_policies. The clone was a
        # replica of live with tenant isolation silently removed.
        # --disable-triggers emits ALTER TABLE ... DISABLE TRIGGER ALL, which touches the FK (system)
        # triggers and needs a SUPERUSER. Supabase's admin is one; Neon's owner is not, and the first
        # Neon restore printed fifteen "permission denied: RI_ConstraintTrigger is a system trigger"
        # errors while every COPY succeeded with the triggers on (nine foreign keys, no cycles, dump
        # order satisfied them) — and then exited 1 with a message blaming a missing schema. Only a
        # superuser gets the flag; everyone else restores with the triggers on, and a real FK violation
        # is reported as what it is.
        su = subprocess.run(["psql", "-Atc", "select rolsuper from pg_roles where rolname = current_user", dst],
                            capture_output=True, text=True).stdout.strip() == "t"
        print(f"pg_restore into {proj} (--data-only, into the schema the deploy already created"
              f"{', triggers disabled' if su else ', triggers on: the admin is not a superuser'}) ...")
        r = subprocess.run(["pg_restore", "--data-only", *(["--disable-triggers"] if su else []), "--no-owner",
                            "--no-privileges", "--dbname", dst, dump], capture_output=True, text=True)
        shutil.rmtree(os.path.dirname(dump))
        # pg_restore prints "errors ignored on restore: N" for ANY non-zero error count, so that phrase
        # alone cannot mean success. A data-only load has no --clean noise to forgive; a row that is
        # already there is the one benign case.
        errs = [l for l in r.stderr.splitlines() if "error:" in l.lower()]
        fatal = [l for l in errs if "already exists" not in l and "duplicate key" not in l]
        if fatal:
            fk = [l for l in fatal if "violates foreign key" in l]
            sys.exit("pg_restore reported errors:\n" + "\n".join(fatal[:15]) + "\n\n" +
                     ("Rows arrived before the rows they reference; the dump's table order did not satisfy a foreign key "
                      "and this admin role cannot disable the constraint triggers. The database now holds a PARTIAL copy."
                      if fk else "These are not the benign 'already exists' / 'duplicate key' errors of a re-run; read them "
                      "before rerunning `snapshot --apply`."))
        print(f"  restored ({len(errs)} ignorable error(s))" if errs else "  restored")
        # Rows in connector_secrets / browser_credentials are sealed with the SOURCE app's OPS_SECRETS_KEY
        # (agent/lib/secret-crypto.ts). The clone mints its own key and Vercel will not reveal live's, so
        # those rows can never be decrypted here. Clearing them is the honest outcome: the clone shows no
        # connectors rather than connectors that fail at use.
        sealed = node("clear-sealed", dict(base, DATABASE_URL=dst), mold)
        print("  cleared rows sealed with the source key: " + ", ".join(f"{k}={v}" for k, v in sealed.items()))
        ds["postgres"]["snapshot"] = {"source": "live_source_agent", "ref": LIVE["web"], "taken_at": NOW, "method": "pg_dump", "cleared_sealed_rows": sealed}
        if tok:
            b = node("blobcopy", benv, mold, extra=["--apply"]); print(f"  copied {b['files']} blobs under {prefix}")
            ds["blob"]["snapshot"] = {"source": "live_source_agent", "ref": LIVE["web"], "taken_at": NOW}
        else: ds["blob"]["snapshot"] = {"source": "none"}
        save(os.path.join(adir, "datastores.json"), ds); print("datastores.json updated")
        # A restore is a schema event: it can add rows to tables whose policies were built for a
        # different database, and any future change of restore strategy could touch DDL again. Re-cover
        # and re-prove immediately, before `configure` writes anything through the app role.
        return main([app_id, "rls"])

    if step == "rls":
        # One implementation, in provision.py, so the clone and the deploy can never disagree about what
        # "isolated" means. It re-applies coverage (a restore or a migration can leave a table with the
        # app_rw DML grant and no policy) and then proves a cross-workspace read and write are refused.
        r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/provision.py"), app_id, "--verify-rls"])
        if r.returncode: sys.exit(f"{app_id}: tenant isolation could not be proven after the restore; not continuing.")
        return

    if step == "configure":
        if clone and ds["postgres"].get("snapshot", {}).get("source") in legacy.spellings("live_source_agent"):
            print("configure skipped: this app is a clone and its database is a snapshot of live; the surface already matches. Configure is for apps stamped from a brief."); return
        mine = pull_env(proj, mold, proj)
        # The APP role, not the admin one. Surface writes are ordinary application writes and must go
        # through RLS like every other write; running them as the BYPASSRLS admin proves nothing about
        # whether the app can actually do them, and hides a missing policy until a user hits it.
        dst = mine.get("DATABASE_URL") or pg_url(mine)
        if not dst: sys.exit(f"no database url for the app; run `python3 .claude/scripts/provision.py {app_id} --deploy` first")
        ws = dict(app["workspace"]); me = legacy.get(ws, "operator_self")
        old = legacy.has_old(ws, "operator_self")
        if old: ws.pop(old)
        if me: ws["operator_self"] = me   # surface.mjs reads workspace.operator_self only
        out = node("apply", dict(base, DATABASE_URL=dst), mold, stdin=json.dumps({"workspace": ws, "surface": app["surface"]}))
        bad = {k: v for k, v in out.items() if isinstance(v, str) and v.startswith("ERR")}
        print("applied: " + ", ".join(f"{k}={v}" for k, v in out.items()))
        if bad: sys.exit(1)
        infra["configured_at"] = NOW; save(os.path.join(adir, "infrastructure.json"), infra)
        return

    if step == "regress":
        live = pull_env(LIVE["web"], mold, proj); mine = pull_env(proj, mold, proj); tok = live_blob_token(mold, proj, prefix)
        rep = node("diff", dict(base, DATABASE_URL=pg_url(mine), LIVE_DATABASE_URL=pg_url(live), BLOB_READ_WRITE_TOKEN=mine.get("BLOB_READ_WRITE_TOKEN", "") if tok else "", LIVE_BLOB_READ_WRITE_TOKEN=tok or ""), mold)
        rdir = os.path.join(ROOT, "molds", app["mold_id"], "testing", "context", "reports")
        # The isolation evidence is part of the verdict (isolation_findings above says why and what it reads).
        ds = load(os.path.join(adir, "datastores.json")); pg = ds.get("postgres", {})
        want = pg.get("rls"); ev = pg.get("rls_verified") or {}   # None prints as ABSENT below, never as `off`
        iso = isolation_findings(app_id, pg)
        status = "pass" if (rep["ok"] and not iso) else "fail"
        L = [f"# {app_id} vs live ({LIVE['web']}) — {status}", "", f"run_at: {NOW}  org: {org}  prefix: {prefix}", "", "## Tables (row counts)", "", "| table | clone | live | |", "|---|---|---|---|"]
        for t, r in sorted(rep["tables"].items()): L.append(f"| {t} | {r['clone']} | {r['live']} | {'volatile' if r['volatile'] else ('ok' if r['same'] else 'DIFF')} |")
        L += ["", "## Surface rows", ""]
        for t, r in rep["surface"].items():
            if "skipped" in r: L.append(f"- {t}: skipped ({r['skipped']})"); continue
            n = len(r["only_clone"]) + len(r["only_live"]) + len(r["changed"])
            L.append(f"- {t}: clone={r['clone']} live={r['live']} " + ("ok" if not n else f"DIFF only_clone={r['only_clone'][:10]} only_live={r['only_live'][:10]} changed={[c['key']+':'+','.join(c['cols']) for c in r['changed'][:10]]}"))
        L += ["", "## Tenant isolation", "",
              (f"- declared: `{want}`" if want else "- declared: ABSENT (datastores.json has no postgres.rls)") + (f" · measured `{ev.get('mode')}` on {ev.get('backend')} at {ev.get('at')} ({ev.get('source')})" if ev else " · NO evidence"),
              f"- role `{ev.get('role')}` superuser={ev.get('superuser')} bypassrls={ev.get('bypassrls')}" if ev.get("role") else "- role: not measured",
              f"- org-scoped tables enabled+forced+policied: {ev.get('protected')}/{ev.get('org_scoped_tables')}" + (f" · unprotected: {', '.join(ev['unprotected'][:10])}" if ev.get("unprotected") else ""),
              f"- cross-workspace read across {ev.get('probe_tables')} probed table(s): {ev.get('foreign_rows_readable')} row(s) · write refused with `{ev.get('cross_org_write')}`" if ev.get("probe_table") else "- cross-workspace probe: not run",
              f"- policies executed one at a time: {ev.get('policies_executed')}" + (f" · **leaking**: {', '.join(ev['leaking_policies'][:6])}" if ev.get("leaking_policies") else " · none handed over another workspace's rows"),
              f"- app in front of traffic (/api/ops/health): `{ev.get('running_app') or 'not read'}`" + (f" · {str(ev.get('running_app_detail'))[:160]}" if ev.get("running_app_detail") else ""),
              ("- **FAIL**: " + "; ".join(iso)) if iso else "- ok"]
        L += ["", "## Blob tree (files, bytes per top-level folder)", "", (f"prefix '{rep['blob']['prefix']}': " + ("same" if rep["blob"]["same"] else "DIFF") + f" clone={rep['blob']['clone']} live={rep['blob']['live']}") if rep["blob"] else "skipped: no live token accepted by the blob store"]
        rpath = write_report(rdir, app_id, "\n".join(L) + "\n")
        if iso: print("tenant isolation: " + "; ".join(iso))
        clone["regression"] = {"status": status, "run_at": NOW, "report": os.path.relpath(rpath, ROOT)}
        app["testing"]["context"] = {"status": status, "run_at": NOW, "report": os.path.relpath(rpath, ROOT)}
        if status == "fail":
            app["status"] = "reverted"
            app["revert"] = {"reason": ("tenant isolation: " + "; ".join(iso)) if iso else "regression against live failed",
                             "lane": "functional" if iso else "context", "at": NOW}
        save(os.path.join(adir, "application.json"), app)
        print(f"{status}: {os.path.relpath(rpath, ROOT)}"); sys.exit(0 if status == "pass" else 1)
    if step == "blobls":
        tok = live_blob_token(mold, proj, ""); sub = next((x for x in a[2:] if not x.startswith("--")), "")
        if not tok: return
        r = subprocess.run(["node", os.path.join(ROOT, ".claude/scripts/lib/surface.mjs"), "blobtree"], cwd=mold, env=dict(base, BLOB_READ_WRITE_TOKEN=tok, BLOB_PREFIX=sub), capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip()); return
    if step == "run":
        me = [sys.executable, os.path.abspath(__file__), app_id]; prov = [sys.executable, os.path.join(ROOT, ".claude/scripts/provision.py"), app_id]
        steps = [("extract the live surface", me + ["extract"]), ("create datastores and copy secrets", prov), ("deploy", prov + ["--deploy"]),
                 ("copy the live data", me + ["snapshot", "--apply"]), ("prove tenant isolation after the restore", me + ["rls"]),
                 ("apply the surface", me + ["configure"]), ("compare with live", me + ["regress"])]
        for i, (label, cmd) in enumerate(steps, 1):
            print(f"\n[{i}/{len(steps)}] {label}"); r = subprocess.run(cmd)
            if r.returncode: sys.exit(f"stopped at step {i} ({label}). Fix what it printed above and run `clone.py {app_id} run` again; finished steps are safe to repeat.")
        print(f"\n{app_id} is a running clone of live; see the report path above."); return
    sys.exit(__doc__)
if __name__ == "__main__": main(sys.argv[1:])
