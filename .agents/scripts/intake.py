#!/usr/bin/env python3
"""Intake: brief -> four application state files, asking only what the schemas cannot resolve.

  intake.py <brief.md> --app <app_id> [--mold mold_v1] [--answers answers.json] [--ask]

Without --ask (the subagent path) it never prompts: it drafts what it can, writes
state/application/<app_id>/questions.json for anything unresolved, and exits 2.
The intake subagent asks the user, writes answers.json, re-runs with --answers.
With --ask it prompts on the terminal (sol path). Exit 0 = state complete and valid.
"""
import json, os, re, sys, datetime, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state"); TODAY = datetime.date.today().isoformat()
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")

def parse_brief(text):
    """Deterministic hints from the brief. Interpretation beyond this is the intake subagent's job."""
    t = text.lower(); h = {}
    if re.search(r"\b(vm|droplet|self.?host|on.prem|single machine)\b", t): h["deploy_target"] = "vm"
    if "vercel" in t: h["deploy_target"] = "vercel"
    if re.search(r"\bno (web )?search\b|without (web )?search|disable (web )?search", t): h["web_search"] = False
    if re.search(r"\bno browser\b|without (a )?browser|disable (the )?browser|no outbound", t): h["browser"] = False
    m = re.search(r"customer[:\s]+([a-z0-9_-]+)", t)
    if m: h["customer_id"] = m.group(1)
    m = re.search(r"domain[:\s]+([a-z0-9.-]+\.[a-z]{2,})", t)
    if m: h["custom_domain"] = m.group(1)
    m = re.search(r"\bmold[_ ]?v?([123])\b", t)
    if m: h["mold_id"] = f"mold_v{m.group(1)}"
    return h

QUESTIONS = [
 # id, state path, prompt, options or None, resolver(defaults, hints) -> value or None
 ("deploy_target", "infrastructure.target", "Where should this application run?", ["vercel","vm"],
   lambda d,h: h.get("deploy_target") or d.get("deploy_target")),
 ("postgres_provider", "datastores.postgres.provider", "Which Postgres provider?", ["supabase","neon","rds","self_hosted"],
   lambda d,h: d.get("postgres_provider")),
 ("postgres_ref", "datastores.postgres.url_ref", "Name of the secret holding the Postgres URL (e.g. DATABASE_URL). Name only, never the value.", None,
   lambda d,h: "DATABASE_URL"),
 ("postgres_scope", "datastores.postgres.tenancy", "Fresh database for this app, or shared with the live fde-agent data?", ["fresh","shared_with_live"],
   lambda d,h: None),
 ("blob_provider", "datastores.blob.provider", "Which blob store for the data room?", ["vercel_blob","s3","gcs","azure_blob"],
   lambda d,h: d.get("blob_provider")),
 ("inference_provider", "infrastructure.inference.provider", "Which inference provider serves GLM 5.2?", ["cloudflare_workers_ai","vercel_ai_gateway"],
   lambda d,h: d.get("inference_provider")),
 ("inference_account", "infrastructure.inference.account_ref", "Name of the secret holding the inference account id (e.g. CLOUDFLARE_ACCOUNT_ID).", None,
   lambda d,h: "CLOUDFLARE_ACCOUNT_ID" if (h.get("inference_provider") or d.get("inference_provider"))=="cloudflare_workers_ai" else None),
 ("secret_store", "infrastructure.secret_store", "Where do secret values live?", ["vercel_env","vm_env_file"],
   lambda d,h: "vm_env_file" if (h.get("deploy_target") or d.get("deploy_target"))=="vm" else d.get("secret_store")),
 ("web_search", "application.capabilities.web_search", "Enable web search (Exa) in the agent?", ["true","false"],
   lambda d,h: h.get("web_search", True)),
 ("browser", "application.capabilities.browser", "Enable the browser subagent?", ["true","false"],
   lambda d,h: h.get("browser", True)),
 ("customer_id", "application.customer_id", "Customer id this app is for (blank if internal).", None,
   lambda d,h: h.get("customer_id", "")),
 ("custom_domain", "infrastructure.vercel.custom_domain", "Custom domain (blank for the default *.vercel.app).", None,
   lambda d,h: h.get("custom_domain", "")),
]

def coerce(v):
    if isinstance(v, str) and v.lower() in ("true","false"): return v.lower()=="true"
    return v

def build_state(app_id, mold_id, ans, factory, brief_path):
    d = factory.get("defaults", {}); mold = next(m for m in factory["molds"] if m["mold_id"]==mold_id)
    prod = next(p for p in load(os.path.join(ST,"products.json"))["products"] if p["mold_id"]==mold_id)
    env_names = []
    f = os.path.join(ROOT, "infra/vercel/env-names.fde-agent.txt")
    if os.path.exists(f): env_names = [l.strip() for l in open(f) if l.strip()]
    app = {"$schema":"../app_id/application.schema.json","app_id":app_id,"mold_id":mold_id,"mold_commit":mold.get("source",{}).get("commit",""),
      "status":"planned","brief":os.path.relpath(brief_path, ROOT),"product_id":prod["product_id"],
      "model":{"provider":"cloudflare" if ans["inference_provider"]=="cloudflare_workers_ai" else "gateway","model":d.get("inference_model","@cf/zai-org/glm-5.2"),"context_window":262144},
      "capabilities":{"web_search":ans["web_search"],"browser":ans["browser"]},
      "service_surface":[s["name"] for s in factory["service_surface"] if not s.get("optional") or ans.get(s["name"], True)],
      "testing":{l:{"status":"pending"} for l in ["load","context","functional","accessibility","responsiveness"]}}
    if ans.get("customer_id"): app["customer_id"] = ans["customer_id"]
    infra = {"$schema":"../app_id/infrastructure.schema.json","target":ans["deploy_target"],"secret_store":ans["secret_store"],
      "inference":{"provider":ans["inference_provider"],"account_ref":ans["inference_account"]},
      "sandbox":{"provider":d.get("sandbox_provider","vercel_sandbox"),"prewarm":False},
      "secrets":sorted(set(env_names + [ans["postgres_ref"], ans["inference_account"], "CLOUDFLARE_API_TOKEN", "BLOB_READ_WRITE_TOKEN"]))}
    if ans["deploy_target"]=="vercel":
        infra["vercel"]={"team":"f20170061g-3183s-projects","project":prod.get("vercel_project", app_id),
          "functions":{"api":"vercel.api.json","eve":"vercel.eve.json"}}
        if ans.get("custom_domain"): infra["vercel"]["custom_domain"]=ans["custom_domain"]
    else:
        infra["vm"]=dict(d.get("vm",{})); infra["vm"]["compose"]=f"infra/vm/apps/{app_id}/docker-compose.yml"
    ds = {"$schema":"../app_id/datastores.schema.json",
      "postgres":{"provider":ans["postgres_provider"],"orm":"drizzle","migrations_dir":"drizzle/","rls":"fail_closed","tenancy":"multi_org","url_ref":ans["postgres_ref"],"scope":ans["postgres_scope"]},
      "blob":{"provider":ans["blob_provider"],"root_prefix":app_id,"token_ref":"BLOB_READ_WRITE_TOKEN"},
      "cache":{"provider":"none"},"memory":{"backend":"postgres"}}
    di = {"$schema":"../app_id/datainfra.schema.json",
      "dataroom":{"spec":f"molds/{mold_id}/codebase/dm.md","top_level":["Customers","Platform","Deployments","Solutions","Implementation","Tickets","People"],"system_of_record":"postgres"},
      "syncs":[{"source":"manual_entry"}],"pipelines":[],"agents":[],"connectors":[]}
    return app, infra, ds, di

def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    brief_path = os.path.abspath(a[0]); opts = a[1:]
    def opt(k, d=None): return opts[opts.index(k)+1] if k in opts else d
    app_id = opt("--app") or re.sub(r"[^a-z0-9_]+","_", os.path.basename(brief_path).split(".")[0].lower())
    text = open(brief_path).read(); hints = parse_brief(text)
    factory = load(os.path.join(ST,"factory.json")); d = factory.get("defaults", {})
    mold_id = opt("--mold") or hints.get("mold_id") or "mold_v1"
    outdir = os.path.join(ST, "application", app_id); os.makedirs(outdir, exist_ok=True)
    answers = load(opt("--answers")) if opt("--answers") else {}
    qfile = os.path.join(outdir, "questions.json")
    if os.path.exists(qfile) and not answers:
        prev = load(qfile).get("answers", {}); answers.update(prev)
    resolved, pending = {}, []
    for qid, path, prompt, options, resolve in QUESTIONS:
        if qid in answers: resolved[qid] = coerce(answers[qid]); continue
        v = resolve(d, hints)
        # factory defaults are only trusted once confirmed; until then they become suggested answers
        if v is not None and (d.get("confirmed") or qid not in ("deploy_target","postgres_provider","blob_provider","inference_provider","secret_store")):
            resolved[qid] = coerce(v); continue
        pending.append({"id":qid,"path":path,"question":prompt,"options":options,"suggested":v})
    if "--ask" in opts and pending:
        for q in pending:
            hint = f" [{'/'.join(q['options'])}]" if q["options"] else ""
            sug = f" (default: {q['suggested']})" if q["suggested"] not in (None,"") else ""
            v = input(f"{q['question']}{hint}{sug}: ").strip() or q["suggested"]
            resolved[q["id"]] = coerce(v if v is not None else "")
        pending = []
    if pending:
        save(qfile, {"app_id":app_id,"mold_id":mold_id,"brief":os.path.relpath(brief_path, ROOT),"hints":hints,
                     "answers":{k:v for k,v in resolved.items()},"pending":pending,"generated":TODAY})
        print(f"{len(pending)} question(s) pending -> {os.path.relpath(qfile, ROOT)}")
        for q in pending:
            print(f"  - {q['id']}: {q['question']}" + (f"  options={q['options']}" if q["options"] else "") + (f"  suggested={q['suggested']}" if q["suggested"] not in (None,"") else ""))
        sys.exit(2)
    # everything resolved: write state, confirm defaults, register app
    app, infra, ds, di = build_state(app_id, mold_id, resolved, factory, brief_path)
    for name, obj in [("application",app),("infrastructure",infra),("datastores",ds),("datainfra",di)]:
        save(os.path.join(outdir, f"{name}.json"), obj)
    if os.path.exists(qfile): os.remove(qfile)
    save(os.path.join(outdir, "answers.json"), resolved)
    if not d.get("confirmed"):
        for k in ("deploy_target","postgres_provider","blob_provider","inference_provider","secret_store"): d[k] = resolved[k]
        d["confirmed"] = True; factory["defaults"] = d
    if app_id not in factory.setdefault("applications", []): factory["applications"].append(app_id)
    save(os.path.join(ST,"factory.json"), factory)
    P = load(os.path.join(ST,"products.json"))
    for p in P["products"]:
        if p["mold_id"]==mold_id and app_id not in p.setdefault("app_ids", []): p["app_ids"].append(app_id)
    save(os.path.join(ST,"products.json"), P)
    r = subprocess.run([sys.executable, os.path.join(ROOT,".claude/scripts/factory.py"), "validate"], capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode: sys.exit(r.returncode)
    print(f"state written: state/application/{app_id}/  (target={infra['target']}, secrets to provide: {len(infra['secrets'])})")
if __name__ == "__main__": main(sys.argv[1:])
