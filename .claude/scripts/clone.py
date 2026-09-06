#!/usr/bin/env python3
"""Clone: replicate a live mold_v1 deployment into a stamped application and regression-diff the two.

  clone.py <app_id> plan                 what the steps below would do, no secrets touched
  clone.py <app_id> extract              live surface -> application.json + datainfra.json (read-only on live)
  clone.py <app_id> snapshot [--apply]   pg_dump live -> restore into the app's fresh database; copy the blob tree
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
LIVE = {"web": "fde-agent", "api": "fde-agent-api", "workflow": "fde-task-workflow"}   # the reference deployment; never deployed to
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")

def link(project, cwd): subprocess.run(f"vercel link --yes --project {project} >/dev/null 2>&1", shell=True, cwd=cwd, check=True)
def pull_env(project, cwd, back_to):
    """Production env of `project` as a dict. Relinks the mold dir to `back_to` afterwards."""
    link(project, cwd); tmp = os.path.join(cwd, f".env.clone.{project}")
    try:
        subprocess.run(f"vercel env pull --yes --environment=production {tmp}", shell=True, cwd=cwd, capture_output=True, check=True)
        vals = {}
        for l in open(tmp):
            if "=" in l and not l.startswith("#"): k, v = l.split("=", 1); vals[k.strip()] = v.strip().strip('"')
        return vals
    finally:
        if os.path.exists(tmp): os.remove(tmp)
        link(back_to, cwd)
def pg_url(vals): return vals.get("SUPABASE_POSTGRES_URL_NON_POOLING") or vals.get("DATABASE_URL") or ""

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
    if step == "plan":
        print(f"{app_id}: org={org} project={proj} live={LIVE['web']} prefix={prefix} scope={ds['postgres'].get('scope')}")
        print("  extract   SELECT surface tables on live -> application.surface, datainfra.{platforms,deployments,pipelines,agents}")
        print(f"  snapshot  pg_dump --schema=public live -> pg_restore into {proj}; blob list+copy under {prefix} (needs --apply)")
        print(f"  configure surface.mjs apply against {proj} (upserts org, members, admins, roster, profile, configs, definitions, scripts)")
        print(f"  regress   counts + keyed diff of surface tables + blob tree, {proj} vs live -> molds/{app['mold_id']}/testing/context/reports/")
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
        if not any(m["email"] == w["fde_self"]["email"] for m in w["members"]): w["members"].insert(0, {"email": w["fde_self"]["email"], "role": "owner"})
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
        print(f"pg_restore into {proj} (--clean --if-exists) ...")
        r = subprocess.run(["pg_restore", "--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", dst, dump], capture_output=True, text=True)
        shutil.rmtree(os.path.dirname(dump))
        if r.returncode and "errors ignored on restore" not in r.stderr: sys.exit(r.stderr[-2000:])
        print("  restored" + (" (some statements ignored, normal for --clean on a fresh db)" if r.returncode else ""))
        ds["postgres"]["snapshot"] = {"source": "live_fde_agent", "ref": LIVE["web"], "taken_at": NOW, "method": "pg_dump"}
        if tok:
            b = node("blobcopy", benv, mold, extra=["--apply"]); print(f"  copied {b['files']} blobs under {prefix}")
            ds["blob"]["snapshot"] = {"source": "live_fde_agent", "ref": LIVE["web"], "taken_at": NOW}
        else: ds["blob"]["snapshot"] = {"source": "none"}
        save(os.path.join(adir, "datastores.json"), ds); print("datastores.json updated"); return

    if step == "configure":
        if clone and ds["postgres"].get("snapshot", {}).get("source") == "live_fde_agent":
            print("configure skipped: this app is a clone and its database is a snapshot of live; the surface already matches. Configure is for apps stamped from a brief."); return
        mine = pull_env(proj, mold, proj); dst = pg_url(mine)
        if not dst: sys.exit("no database url for the app; run provision.py first")
        out = node("apply", dict(base, DATABASE_URL=dst), mold, stdin=json.dumps({"workspace": app["workspace"], "surface": app["surface"]}))
        bad = {k: v for k, v in out.items() if isinstance(v, str) and v.startswith("ERR")}
        print("applied: " + ", ".join(f"{k}={v}" for k, v in out.items()))
        if bad: sys.exit(1)
        infra["configured_at"] = NOW; save(os.path.join(adir, "infrastructure.json"), infra)
        return

    if step == "regress":
        live = pull_env(LIVE["web"], mold, proj); mine = pull_env(proj, mold, proj); tok = live_blob_token(mold, proj, prefix)
        rep = node("diff", dict(base, DATABASE_URL=pg_url(mine), LIVE_DATABASE_URL=pg_url(live), BLOB_READ_WRITE_TOKEN=mine.get("BLOB_READ_WRITE_TOKEN", "") if tok else "", LIVE_BLOB_READ_WRITE_TOKEN=tok or ""), mold)
        rdir = os.path.join(ROOT, "molds", app["mold_id"], "testing", "context", "reports"); os.makedirs(rdir, exist_ok=True)
        rpath = os.path.join(rdir, f"{app_id}-regression-{NOW[:10]}.md"); status = "pass" if rep["ok"] else "fail"
        L = [f"# {app_id} vs live ({LIVE['web']}) — {status}", "", f"run_at: {NOW}  org: {org}  prefix: {prefix}", "", "## Tables (row counts)", "", "| table | clone | live | |", "|---|---|---|---|"]
        for t, r in sorted(rep["tables"].items()): L.append(f"| {t} | {r['clone']} | {r['live']} | {'volatile' if r['volatile'] else ('ok' if r['same'] else 'DIFF')} |")
        L += ["", "## Surface rows", ""]
        for t, r in rep["surface"].items():
            if "skipped" in r: L.append(f"- {t}: skipped ({r['skipped']})"); continue
            n = len(r["only_clone"]) + len(r["only_live"]) + len(r["changed"])
            L.append(f"- {t}: clone={r['clone']} live={r['live']} " + ("ok" if not n else f"DIFF only_clone={r['only_clone'][:10]} only_live={r['only_live'][:10]} changed={[c['key']+':'+','.join(c['cols']) for c in r['changed'][:10]]}"))
        L += ["", "## Blob tree (files, bytes per top-level folder)", "", (f"prefix '{rep['blob']['prefix']}': " + ("same" if rep["blob"]["same"] else "DIFF") + f" clone={rep['blob']['clone']} live={rep['blob']['live']}") if rep["blob"] else "skipped: no live token accepted by the blob store"]
        open(rpath, "w").write("\n".join(L) + "\n")
        clone["regression"] = {"status": status, "run_at": NOW, "report": os.path.relpath(rpath, ROOT)}
        app["testing"]["context"] = {"status": status, "run_at": NOW, "report": os.path.relpath(rpath, ROOT)}
        if status == "fail": app["status"] = "reverted"; app["revert"] = {"reason": "regression against live failed", "lane": "context", "at": NOW}
        save(os.path.join(adir, "application.json"), app)
        print(f"{status}: {os.path.relpath(rpath, ROOT)}"); sys.exit(0 if rep["ok"] else 1)
    if step == "blobls":
        tok = live_blob_token(mold, proj, ""); sub = next((x for x in a[2:] if not x.startswith("--")), "")
        if not tok: return
        r = subprocess.run(["node", os.path.join(ROOT, ".claude/scripts/lib/surface.mjs"), "blobtree"], cwd=mold, env=dict(base, BLOB_READ_WRITE_TOKEN=tok, BLOB_PREFIX=sub), capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip()); return
    if step == "run":
        me = [sys.executable, os.path.abspath(__file__), app_id]; prov = [sys.executable, os.path.join(ROOT, ".claude/scripts/provision.py"), app_id]
        steps = [("extract the live surface", me + ["extract"]), ("create datastores and copy secrets", prov), ("deploy", prov + ["--deploy"]),
                 ("copy the live data", me + ["snapshot", "--apply"]), ("apply the surface", me + ["configure"]), ("compare with live", me + ["regress"])]
        for i, (label, cmd) in enumerate(steps, 1):
            print(f"\n[{i}/{len(steps)}] {label}"); r = subprocess.run(cmd)
            if r.returncode: sys.exit(f"stopped at step {i} ({label}). Fix what it printed above and run `clone.py {app_id} run` again; finished steps are safe to repeat.")
        print(f"\n{app_id} is a running clone of live; see the report path above."); return
    sys.exit(__doc__)
if __name__ == "__main__": main(sys.argv[1:])
