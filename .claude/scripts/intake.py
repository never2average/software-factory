#!/usr/bin/env python3
"""Intake: brief -> four application state files, asking only what the schemas cannot resolve.

  intake.py <brief.md> --app <app_id> [--mold mold_v1] [--answers answers.json] [--ask]

Without --ask (the subagent path) it never prompts: it drafts what it can, writes
state/application/<app_id>/questions.json for anything unresolved, and exits 2.
The intake subagent asks the user, writes answers.json, re-runs with --answers.
With --ask it prompts on the terminal (sol path). Exit 0 = state complete and valid.

The brief drives the six service-surface blocks in application.json (docs/STATE.md).
Anything the brief does not say gets the mold's own default, never a guess.
"""
import json, os, re, sys, datetime, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state"); TODAY = datetime.date.today().isoformat()
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
EMAIL = r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}"

def parse_brief(text):
    """Deterministic hints from the brief. Interpretation beyond this is the intake subagent's job."""
    t = text.lower(); h = {}
    vm = bool(re.search(r"\b(vm|droplet|self.?host|on.prem|single machine)\b", t))
    # "vercel" anywhere used to pick the deploy target, so "inference through the Vercel AI Gateway" moved
    # an app that asked for the vm onto Vercel (and paired it with a self_hosted database provision.py
    # then refused). Only a vercel that is not the gateway's own name counts — and the name comes in
    # several spellings ("Vercel AI Gateway", "Vercel's AI Gateway", "vercel-ai-gateway", "Vercel gateway").
    # The possessive lives INSIDE the lookahead: as an optional group before it, "vercel's ai gateway"
    # backtracked out of the 's and matched a bare "vercel" that the lookahead could no longer see.
    vercel = bool(re.search(r"\bvercel\b(?!(?:['\u2019]s)?[\s-]+(?:ai[\s-]+)?gateway\b)", t))
    if vm and vercel:
        # A brief that names BOTH is a question, not an answer. The last rule to run used to win, so
        # intake wrote target=vercel for a brief that asked for the vm. deploy_target stays pending.
        h["deploy_target_conflict"] = True
    elif vm: h["deploy_target"] = "vm"
    elif vercel: h["deploy_target"] = "vercel"
    if re.search(r"\bai[\s-]+gateway\b|\bvercel(?:['\u2019]s)?[\s-]+gateway\b", t): h["inference_provider"] = "vercel_ai_gateway"
    elif re.search(r"\bworkers\s+ai\b|\bcloudflare\b", t): h["inference_provider"] = "cloudflare_workers_ai"
    if re.search(r"\bno (web )?search\b|without (web )?search|disable (web )?search", t): h["web_search"] = False
    if re.search(r"\bno browser\b|without (a )?browser|disable (the )?browser|no outbound", t): h["browser"] = False
    if re.search(r"single.?tenant|single workspace|one workspace", t): h["multi_tenant"] = False
    if re.search(r"\bneon\b", t): h["postgres_provider"] = "neon"
    elif re.search(r"\bsupabase\b|\bmanaged postgres\b", t): h["postgres_provider"] = "supabase"
    elif re.search(r"self.?host[a-z]*\s+(?:the\s+)?(?:postgres|database|db)|(?:postgres|database|db)\s+on\s+(?:the\s+)?(?:vm|droplet|box)|local (?:postgres|database)", t): h["postgres_provider"] = "self_hosted"
    if re.search(r"fresh (database|db)|own (database|db)|new (database|db)", t): h["postgres_scope"] = "fresh"
    if re.search(r"\b(?:no|not|never|without)\b[^.\n]{0,30}\bshared?\b", t): h["postgres_scope"] = "fresh"
    elif re.search(r"\bshared? (?:database|db)\b|\bshare[a-z]* the live (?:database|db|data)\b", t): h["postgres_scope"] = "shared_with_live"
    m = re.search(r"\bcustomer:\s*([a-z0-9_-]+)", t)
    if m: h["customer_id"] = m.group(1)
    m = re.search(r"domain[:\s]+([a-z0-9.-]+\.[a-z]{2,})", t)
    if m: h["custom_domain"] = m.group(1)
    m = re.search(r"\bmold[_ ]?v?([123])\b", t)
    if m: h["mold_id"] = f"mold_v{m.group(1)}"
    m = re.search(r"\b(?:workspace|org(?:anisation|anization)?):\s*\"?([^\n\".]+?)\"?\s*(?:\.|\n|$)", text, re.I)
    if m: h["workspace_name"] = m.group(1).strip()
    m = re.search(r"\b(?:fde|owner|operator):\s*(" + EMAIL + ")", t)
    if m: h["fde_email"] = m.group(1)
    m = re.search(r"\b(?:members?|team):\s*((?:" + EMAIL + r"[,\s]*)+)", t)
    if m: h["members"] = re.findall(EMAIL, m.group(1))
    m = re.search(r"(?:accounts?|customers?) are called ([a-z]+)|call (?:accounts|customers) ([a-z]+)", t)
    if m:
        n = m.group(1) or m.group(2)   # singular: companies -> company, patients -> patient, classes -> class
        h["account_noun"] = n[:-3] + "y" if n.endswith("ies") else n[:-2] if n.endswith("sses") else n.rstrip("s")
    m = re.search(r"(?:clone|replica|copy) of (?:the )?live(?: fde.agent)?(?:\s+at\s+(https?://\S+|[a-z0-9.-]+\.[a-z]{2,}))?", t)
    if m: h["clone_of"] = {"kind": "live_deployment", "ref": (m.group(1) or "fde-agent").rstrip(".,)")}
    m = re.search(r"primary context[:\s]+([^\n.]+)", t)
    if m: h["corpus"] = [x.strip() for x in re.split(r",|\band\b", m.group(1)) if x.strip()]
    m = re.search(r"multiplayer(?: context)?[:\s]+([^\n.]+)", t)
    if m: h["processes"] = [x.strip() for x in re.split(r",|\band\b", m.group(1)) if x.strip()]
    m = re.search(r"\bproduct:\s*([a-z0-9_-]+)", t)
    if m: h["product_id"] = m.group(1)
    m = re.search(r"\bpacks?:\s*([a-z0-9, -]+)", t)   # "packs: hfc-research, other-pack"
    if m: h["packs"] = [x.strip() for x in m.group(1).split(",") if x.strip()]
    if re.search(r"\bno branding\b|\bunbranded\b|\bmold branding\b", t): h["no_branding"] = True
    m = re.search(r"\bbrand colou?r:\s*(#[0-9a-fA-F]{3,6})", text, re.I)
    if m: h["brand_color"] = m.group(1)
    # The short way to brand an app from the brief: `brand: Acme Ops`, `logo: brands/acme/logo.png`, `tagline: …`
    m = re.search(r"^\s*brand(?: name)?:\s*([^\n]+?)\s*$", text, re.I | re.M)
    if m and not re.fullmatch(r"#[0-9a-fA-F]{3,6}", m.group(1)): h["brand_name"] = m.group(1).strip()
    m = re.search(r"^\s*logo:\s*(\S+)", text, re.I | re.M)
    if m: h["brand_logo"] = m.group(1).strip()
    m = re.search(r"^\s*tagline:\s*([^\n]+?)\s*$", text, re.I | re.M)
    if m: h["brand_tagline"] = m.group(1).strip()
    m = re.search(r"(?:workflows?)[:\s]+(all|none|library)", t)
    if m: h["library"] = "all" if m.group(1) in ("all", "library") else "none"
    return h

def slug(s): return re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")

# What the mold reads for each inference provider (agent/lib/model.ts). The cloudflare branch reads
# CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (model.ts:35-36) and nothing else; the gateway branch
# reads NO Cloudflare name — it hands a bare model id to the AI SDK, whose gateway provider
# (@ai-sdk/gateway 4.0.12) authenticates with AI_GATEWAY_API_KEY and otherwise falls back to the OIDC
# token Vercel injects into its own functions. Nothing in this factory measures whether OIDC is on
# for a project, so the key is required on every target instead of trusted to appear at request time.
# Every name here goes into secrets_user, and provision.py blocks the deploy on each of them, so an
# app must never name a secret its provider does not read.
INFERENCE_SECRETS = {"cloudflare_workers_ai": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
                     "vercel_ai_gateway": ["AI_GATEWAY_API_KEY"]}
# What each provider SERVES, read from agent/lib/model.ts — (MODEL_PROVIDER value, model id, context window):
#   cloudflare: CLOUDFLARE_MODEL, default "@cf/zai-org/glm-5.2", window CLOUDFLARE_CONTEXT_WINDOW default 262144;
#   gateway:    GATEWAY_MODEL_ORCHESTRATOR / GATEWAY_MODEL_SPECIALIST, both default "anthropic/claude-sonnet-5"
#               (the free-tier-safe defaults; Opus is refused there), and NO window: modelContextWindowTokens()
#               returns undefined in gateway mode and eve looks it up, so none is recorded.
# application.model used to be the factory default for every app, so a gateway app recorded the Cloudflare
# model id while its runtime served Claude (mold_v1-051). The factory default `inference_model` is a
# Cloudflare id and only ever overrides the cloudflare row.
INFERENCE_MODEL = {"cloudflare_workers_ai": ("cloudflare", "@cf/zai-org/glm-5.2", 262144),
                   "vercel_ai_gateway": ("gateway", "anthropic/claude-sonnet-5", None)}
def unforwarded(target, provider):
    """Names in INFERENCE_SECRETS[provider] that the target's deploy never hands to the process running
    agent/lib/model.ts. On Vercel that process is the `<project>-api` deployment, and the ONLY list
    provision.py syncs onto it is API_ENV (deploy_vercel -> sync_env(API_ENV, ...)); `--check` counts a
    secret present on the main project alone. A name missing from API_ENV therefore passes the gate and
    still never reaches the runtime, which then either fails or falls back to whatever the SDK finds —
    an unmeasured default. The list is READ from provision.py, not copied here, so this refusal lifts by
    itself the day provision.py forwards the name. target=vm starts no process at all (provision.py:
    "target vm serves nothing"), so there is nothing to forward and nothing to refuse."""
    if target != "vm":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import provision                     # stdlib-only module, no side effects at import
        return [n for n in INFERENCE_SECRETS.get(provider, []) if n not in provision.API_ENV]
    return []

def answered(c, h, d, key):
    """An answer given for an earlier question (answers.json, --ask) beats the brief, which beats the default."""
    return c.get("resolved", {}).get(key) or h.get(key) or d.get(key)

# The mold's data room, as corpus kinds. Keys are phrases a brief might use; values are (kind, dm.md path, sync).
CORPUS = {
  "customer_agreements":   ("customer agreement|contract|msa|sow",           "Customers/{customer_id}/agreements/",                       "manual_entry"),
  "customer_context":      ("customer context|account context|account brief", "Customers/{customer_id}/context.md",                        "manual_entry"),
  "customer_personas":     ("persona|user archetype",                         "Customers/{customer_id}/personas.jsonl",                     "manual_entry"),
  "customer_interactions": ("interaction|meeting note|call note|email thread","Customers/{customer_id}/interactions.jsonl",                 "meeting_notes"),
  "product_offerings":     ("product offering|offering|catalog|solution",     "Solutions/{platform_version_id}/",                          "manual_entry"),
  "platform_design":       ("platform design|design decision|architecture",   "Platform/{platform_version_id}/design_decisions/",           "github"),
  "rollout_case_studies":  ("rollout|case stud|go.live|deployment stor",      "Deployments/{customer_id}/{platform_version_id}/",           "manual_entry"),
  "implementation_history":("implementation|migration histor",                "Implementation/{customer_id}/migrations/{migration_id}/context.md", "manual_entry"),
  "tickets":               ("ticket|issue|incident record",                   "Tickets/{ticket_folder}/{customer_id}/",                     "manual_entry"),
  "people_context":        ("people|roster context|who is who",               "People/{person_id}/context.md",                             "manual_entry"),
}
DEFAULT_CORPUS = ["customer_agreements","customer_context","customer_personas","customer_interactions","product_offerings","platform_design","rollout_case_studies","implementation_history","tickets","people_context"]
# Shared processes and the mold features that implement them.
PROCESSES = {
  "sprint_planning":      ("sprint|cycle|planning",            [("cycles","/api/ops/cycles"),("todos","/api/ops/todos"),("workflow_definition","task")]),
  "onboarding":           ("onboard",                          [("recipe","onboard-self"),("recipe","import-roster"),("recipe","connect-sources"),("recipe","seed-workflows"),("recipe","onboard-customer"),("workflow_script","onboard-account"),("workflow_script","assign-account")]),
  "escalation_handling":  ("escalat|on.call|paging",           [("roster_escalations","people_roster.escalations"),("workflow_script","route-incident"),("ticket_folder","bug")]),
  "incident_postmortem":  ("postmortem|post-mortem|rca",       [("workflow_script","incident-postmortem")]),
  "go_live":              ("go.live|launch|readiness",         [("workflow_script","go-live-sprint"),("workflow_script","infra-sizing"),("workflow_script","infosec-checklist")]),
  "account_review":       ("qbr|account review|business review",[("workflow_script","qbr-prep")]),
  "renewal":              ("renewal|churn",                    [("workflow_script","renewal-risk")]),
  "data_migration":       ("data migration|migration plan",    [("workflow_script","data-migration-plan")]),
  "solution_engineering": ("solution engineering|scoping",     [("workflow_script","solution-engineering")]),
  "integration_wiring":   ("integration|wiring|connector",     [("workflow_script","integration-wiring")]),
  "eval_triage":          ("eval|regression triage",           [("workflow_script","eval-regression-triage")]),
}
DEFAULT_PROCESSES = ["sprint_planning","onboarding","escalation_handling","incident_postmortem","go_live","account_review"]
def match(phrases, table):
    """Brief phrases -> known keys, or ('custom', phrase) when nothing in the mold matches."""
    out = []
    for ph in phrases:
        hit = next((k for k, v in table.items() if re.search(v[0], ph.lower())), None)
        out.append((hit, ph) if hit else ("custom", ph))
    return out

QUESTIONS = [
 # id, state path, prompt, options or None, resolver(defaults, hints, ctx) -> value or None
 ("deploy_target", "infrastructure.target", "Where should this application run?", ["vercel","vm"],
   lambda d,h,c: None if h.get("deploy_target_conflict") else h.get("deploy_target") or d.get("deploy_target")),
 # the hint was ignored here — alone among the sixteen questions — so a brief could never land on a
 # provider and intake silently stamped the factory default. self_hosted is LOCAL-ONLY (no host port),
 # so it forces target=vm; provision.py refuses to pair it with a Vercel deployment.
 ("postgres_provider", "datastores.postgres.provider", "Which Postgres provider?", ["neon","supabase","rds","self_hosted"],
   lambda d,h,c: h.get("postgres_provider") or d.get("postgres_provider")),
 ("postgres_ref", "datastores.postgres.url_ref", "Name of the secret holding the Postgres URL (e.g. DATABASE_URL). Name only, never the value.", None,
   lambda d,h,c: "DATABASE_URL"),
 ("postgres_scope", "datastores.postgres.scope", "Fresh database for this app, or shared with the live fde-agent data?", ["fresh","shared_with_live"],
   lambda d,h,c: h.get("postgres_scope") or d.get("postgres_scope", "fresh")),
 ("blob_provider", "datastores.blob.provider", "Which blob store for the data room?", ["vercel_blob","s3","gcs","azure_blob"],
   lambda d,h,c: d.get("blob_provider")),
 ("inference_provider", "infrastructure.inference.provider", "Which inference provider serves the agent?", ["cloudflare_workers_ai","vercel_ai_gateway"],
   lambda d,h,c: h.get("inference_provider") or d.get("inference_provider")),
 # the first name the provider reads: CLOUDFLARE_ACCOUNT_ID on Workers AI, AI_GATEWAY_API_KEY on the gateway
 ("inference_account", "infrastructure.inference.account_ref", "Name of the secret holding the inference account id (e.g. CLOUDFLARE_ACCOUNT_ID).", None,
   lambda d,h,c: (INFERENCE_SECRETS.get(answered(c, h, d, "inference_provider")) or [None])[0]),
 ("secret_store", "infrastructure.secret_store", "Where do secret values live?", ["vercel_env","vm_env_file"],
   lambda d,h,c: "vm_env_file" if answered(c, h, d, "deploy_target")=="vm" else d.get("secret_store")),
 ("web_search", "application.capabilities.web_search", "Enable web search (Exa) in the agent?", ["true","false"],
   lambda d,h,c: h.get("web_search", True)),
 ("browser", "application.capabilities.browser", "Enable the browser subagent?", ["true","false"],
   lambda d,h,c: h.get("browser", True)),
 ("multi_tenant", "application.capabilities.multi_tenant", "Multi-workspace (OPS_MULTI_TENANT)?", ["true","false"],
   lambda d,h,c: h.get("multi_tenant", True)),
 ("customer_id", "application.customer_id", "Customer id this app is for (blank if internal).", None,
   lambda d,h,c: h.get("customer_id", "")),
 ("custom_domain", "infrastructure.vercel.custom_domain", "Custom domain (blank for the default *.vercel.app).", None,
   lambda d,h,c: h.get("custom_domain", "")),
 ("vercel_project", "infrastructure.vercel.project", "Vercel project name for this app (one project per app).", None,
   lambda d,h,c: c["existing_project"] or (c["product"].get("vercel_project", c["app_id"]) if c["first_app"] else f"{c['product'].get('vercel_project', c['product']['product_id'])}-{slug(c['suffix'])}")),
 ("workspace_name", "application.surface.primary_context.workspace.name", "Workspace (org) display name.", None,
   lambda d,h,c: h.get("workspace_name") or d.get("workspace_name")),
 ("fde_email", "application.surface.multiplayer_context.fde_self.email", "Email of the FDE who owns this workspace (must match the identity domain the mold accepts).", None,
   lambda d,h,c: h.get("fde_email") or d.get("fde_email")),
 ("library", "application.surface.custom_workflow_builder.library.install", "Install the mold's default workflow library?", ["all","none"],
   lambda d,h,c: h.get("library", "all")),
]

def coerce(v):
    if isinstance(v, str) and v.lower() in ("true","false"): return v.lower()=="true"
    return v

def pick_product(mold_id, hints, existing=None):
    """A mold can carry several products — the same codebase under different brands. A brief names one
    with `product: <id>`; otherwise a re-run keeps the app's own, and a mold with exactly one product
    needs no answer at all."""
    prods = [p for p in load(os.path.join(ST, "products.json"))["products"] if p["mold_id"] == mold_id]
    if not prods: sys.exit(f"no product is defined for {mold_id} in state/products.json")
    want = hints.get("product_id") or (existing or {}).get("application", {}).get("product_id")
    if want:
        hit = next((p for p in prods if p["product_id"] == want), None)
        if hit: return hit
        if hints.get("product_id"): sys.exit(f"no product {want!r} on {mold_id}; have: " + ", ".join(p["product_id"] for p in prods))
    if len(prods) > 1:
        sys.exit(f"{mold_id} carries {len(prods)} products (" + ", ".join(p["product_id"] for p in prods) +
                 "); say which one in the brief, e.g. `product: " + prods[0]["product_id"] + "`")
    return prods[0]

def build_state(app_id, mold_id, ans, hints, factory, brief_path, existing):
    d = factory.get("defaults", {}); mold = next(m for m in factory["molds"] if m["mold_id"]==mold_id)
    prod = pick_product(mold_id, hints, existing)
    org_id = slug(ans["workspace_name"]); fde = ans["fde_email"]
    # Secrets the app needs, by name. "user" = only the user can supply; "derived" = provision.py creates/sets them.
    # The inference half follows the provider (INFERENCE_SECRETS): this used to be a literal Cloudflare
    # list for every app, so a gateway app named two secrets it never reads and could not deploy.
    if ans["inference_provider"] not in INFERENCE_SECRETS:
        sys.exit(f"inference_provider must be one of {', '.join(INFERENCE_SECRETS)}, not {ans['inference_provider']!r}")
    user_secrets = [*INFERENCE_SECRETS[ans["inference_provider"]], "RESEND_API_KEY", "PLATFORM_NOTIFY_FROM"]
    model_provider, model_id, window = INFERENCE_MODEL[ans["inference_provider"]]
    if model_provider == "cloudflare": model_id = d.get("inference_model") or model_id
    if ans["web_search"]: user_secrets.append("EXA_API_KEY")
    if ans["browser"]: user_secrets.append("BROWSERBASE_API_KEY")
    # Provider-dependent, because provision.py blocks the deploy on every name in this list. It used to
    # be a literal Supabase list for every app, including SUPABASE_URL — a name that appears NOWHERE in
    # the mold codebase, so a non-Supabase app named a secret nothing could ever supply and could never
    # deploy. PROVIDER_SECRETS holds what each provider actually injects.
    PROVIDER_SECRETS = {"supabase": ["SUPABASE_URL", "SUPABASE_POSTGRES_URL_NON_POOLING"],
                        "neon": ["DATABASE_URL_UNPOOLED"],           # scripts/migrate-production.mjs:28 already reads it
                        "rds": [], "self_hosted": ["POSTGRES_ADMIN_URL"]}
    derived_secrets = ["DATABASE_URL", *PROVIDER_SECRETS.get(ans["postgres_provider"], []), "BLOB_READ_WRITE_TOKEN", "CRON_SECRET", "OPS_SECRETS_KEY",
                       "AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY", "MODEL_PROVIDER", "TASK_WORKFLOW_SERVICE_TOKEN", "TASK_WORKFLOW_SERVICE_URL", "NEXT_PUBLIC_EVE_API_URL"]
    # Google sign-in is the product's front door (lib/ops-auth.ts accepts a Google ID token or the
    # emailed-code session; the sign-in page renders the Google button first). It was "optional" here
    # and the first deployed app greeted its operator with "Google sign-in is not configured
    # (NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset)". Required from 2026-09-13; one --set-secret writes both.
    optional_secrets = []
    user_secrets = user_secrets + [n for n in ("GOOGLE_CLIENT_ID", "NEXT_PUBLIC_GOOGLE_CLIENT_ID") if n not in user_secrets]
    top_level = ["Customers","Platform","Deployments","Solutions","Implementation","Tickets","People","Uploads"]
    members = [{"email": fde, "role": "owner"}] + [{"email": e, "role": "member"} for e in hints.get("members", []) if e != fde]
    corpus = []
    for kind, phrase in (match(hints["corpus"], CORPUS) if hints.get("corpus") else [(k, None) for k in DEFAULT_CORPUS]):
        if kind == "custom": corpus.append({"kind": "custom", "dataroom_path": "Uploads/", "description": phrase, "sync": "manual_entry", "required": True})
        else: corpus.append({"kind": kind, "dataroom_path": CORPUS[kind][1], "sync": CORPUS[kind][2], "required": True, **({"description": phrase} if phrase else {})})
    processes = []
    for name, phrase in (match(hints["processes"], PROCESSES) if hints.get("processes") else [(k, None) for k in DEFAULT_PROCESSES]):
        if name == "custom": processes.append({"name": "custom", "label": phrase, "enabled": True, "implemented_by": []})
        else: processes.append({"name": name, "enabled": True, "implemented_by": [{"kind": k, "ref": r} for k, r in PROCESSES[name][1]], **({"label": phrase} if phrase else {})})
    workspace = {
      "org": {"org_id": org_id, "name": ans["workspace_name"], "display_name": ans["workspace_name"], "blob_prefix": f"orgs/{org_id}"},
      "fde_self": {"email": fde, "name": fde.split("@")[0].replace(".", " ").title(), "title": "Forward-Deployed Engineer", "skills": [], "capacity_target_accounts": 8},
      "members": members, "platform_admins": [fde], "roster": [{"email": fde}], "customers": []}
    surface = {
      "dm.md": {"enabled": True, "top_level": top_level, "system_of_record": "postgres"},
      "browser": {"enabled": ans["browser"], "local": False, "default_on_for_agent": ans["browser"]},
      "web_search": {"enabled": ans["web_search"], "default_on_for_agent": ans["web_search"]},
      "primary_context": {
        "corpus": corpus,
        "instructions": {"default_mode": "build", "model": model_id, "subagents": []},
        "memory": {"scopes": ["team", "customer", "person"], "sensitivity_ceiling": "internal"},
        "entity_vocabulary": {"account_noun": hints.get("account_noun", "customer")}},
      "multiplayer_context": {
        "processes": processes,
        "escalation": {"path": "roster_escalations", "incident_workflow": "route-incident", "ticket_folders": ["bug","onboarding","feat"]},
        "collaboration": {"chat_threads": True, "presence": True, "comments": True, "inbox": True}},
      "custom_workflow_builder": {"library": {"install": ans["library"]}, "scripts": [], "definitions": []},
    }
    # The product's identity is COPIED into the app, not referenced: an application must be readable
    # on its own, and editing a product's brand later must not change an app that already exists.
    brand = {} if hints.get("no_branding") else dict(prod.get("brand") or {})
    if brand or any(hints.get(k) for k in ("brand_name", "brand_color", "brand_logo", "brand_tagline")):
        # The brief's brand lines override the product's brand; everything not named is derived.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from branding import normalize
        brand = normalize(brand, hints.get("brand_name"), hints.get("brand_color"), hints.get("brand_logo"), hints.get("brand_tagline"))
        surface["branding"] = brand

    # Packs: the application's own code, added to the mold's build copy without forking it (packs.py). The brief
    # names them ("packs: hfc-research") or the product carries them. A pack may also say what it means for the
    # application's STATE (pack.json "state"): its corpus, the workspace instructions and the subagents it adds —
    # so a packed app's state is reproducible from the brief, not patched by hand after intake.
    packs = hints.get("packs") or list(prod.get("packs") or []); pack_model_roles = None
    for pid in packs:
        mp = os.path.join(ROOT, "packs", pid, "pack.json")
        if not os.path.exists(mp): sys.exit(f"the brief names pack '{pid}' but packs/{pid}/pack.json does not exist")
        pm = load(mp); st = pm.get("state") or {}
        if st.get("corpus"): surface["primary_context"]["corpus"] = st["corpus"]
        ins = surface["primary_context"]["instructions"]
        for k in ("workspace", "persona_name", "tone"):
            if st.get(k): ins[k] = st[k]
        ins["subagents"] += [{"agent_key": k, "paused": False} for k in pm.get("subagents", [])]
        if st.get("model_roles"): pack_model_roles = dict(st["model_roles"])

    if hints.get("account_noun") and hints["account_noun"] != "customer":
        surface["primary_context"]["entity_vocabulary"]["note"] = "mold_v1 cannot rename accounts; recorded for the parity audit"
    app = {"$schema":"../app_id/application.schema.json","app_id":app_id,"mold_id":mold_id,"mold_commit":mold.get("source",{}).get("commit",""),
      "status":"planned","brief":os.path.relpath(brief_path, ROOT),"product_id":prod["product_id"],
      "model":{"provider":model_provider,"model":model_id,**({"context_window":window} if window else {})},
      "capabilities":{"web_search":ans["web_search"],"browser":ans["browser"],"multi_tenant":ans["multi_tenant"]},
      "service_surface":[s["name"] for s in factory["service_surface"] if not s.get("optional") or ans.get(s["name"], True)],
      "workspace": workspace, "surface": surface,
      "testing":{l:{"status":"pending"} for l in ["load","context","functional","accessibility","responsiveness"]}}
    if ans.get("customer_id"): app["customer_id"] = ans["customer_id"]
    if packs: app["packs"] = packs
    if pack_model_roles and model_provider == "cloudflare": app["model"]["roles"] = pack_model_roles
    if hints.get("clone_of"): app["clone_of"] = dict(hints["clone_of"], snapshot_date=TODAY, regression={"status": "pending"})
    ex_app = existing.get("application", {})  # re-running intake never resets progress already made
    if ex_app.get("clone_of", {}).get("extracted_at"):  # the surface came from a live deployment; the brief cannot know better
        brand = surface.get("branding")
        app["workspace"], app["surface"] = ex_app["workspace"], dict(ex_app["surface"])
        if brand: app["surface"]["branding"] = brand
        else: app["surface"].pop("branding", None)
        app["clone_of"] = ex_app["clone_of"]                      # keep extracted_at, live_counts, live_evidence, the regression result
    # The workspace tile inside the app is a runtime value on the orgs row, not a build-time one, so
    # seed it from the same mark the build uses — but never over one the source deployment already has.
    # CSP allows data: images (proxy.ts img-src).
    icon = brand.get("icon_svg")
    if icon and not app["workspace"]["org"].get("logo_url"):
        import base64
        app["workspace"]["org"]["logo_url"] = "data:image/svg+xml;base64," + base64.b64encode(icon.encode()).decode()
    for k in ("status", "testing", "revert"):
        if ex_app.get(k): app[k] = ex_app[k]
    if "clone_of" in ex_app and "clone_of" not in app: app["clone_of"] = ex_app["clone_of"]
    infra = {"$schema":"../app_id/infrastructure.schema.json","target":ans["deploy_target"],"secret_store":ans["secret_store"],
      "inference":{"provider":ans["inference_provider"],"account_ref":ans["inference_account"]},
      "sandbox":{"provider":d.get("sandbox_provider","vercel_sandbox"),"prewarm":False},
      "secrets":sorted(set(user_secrets + derived_secrets)), "secrets_user":user_secrets, "secrets_derived":derived_secrets, "secrets_optional":optional_secrets,
      "runtime_env":{"OPS_MULTI_TENANT":"1" if ans["multi_tenant"] else "0","ENABLE_WEB_SEARCH":str(ans["web_search"]).lower(),"ENABLE_BROWSER":str(ans["browser"]).lower(),
                     "MODEL_PROVIDER":app["model"]["provider"]}}
    if ans["deploy_target"]=="vercel":
        infra["vercel"]={"team":d.get("vercel_team","your-vercel-team"),"project":ans["vercel_project"],
          "functions":{"api":"vercel.api.json","eve":"vercel.eve.json"}}
        if ans.get("custom_domain"): infra["vercel"]["custom_domain"]=ans["custom_domain"]
    else:
        infra["vm"]=dict(d.get("vm",{})); infra["vm"]["compose"]=f"infra/vm/apps/{app_id}/docker-compose.yml"
    ex_inf = existing.get("infrastructure", {})
    for k in ("datastores", "deployed_at", "configured_at"):
        if k in ex_inf: infra[k] = ex_inf[k]
    for k in ("production_url", "workflow_url", "api_url", "crons", "health"):   # `health` is the deploy's own verdict; dropping it left state unable to say whether the app came up
        if k in ex_inf.get("vercel", {}) and "vercel" in infra: infra["vercel"][k] = ex_inf["vercel"][k]
    ds = {"$schema":"../app_id/datastores.schema.json",
      # rls follows TENANCY, it is not a constant. This line used to write "fail_closed" into every app
      # regardless of provider, scope or tenancy — a claim nothing measured, beside an app that ran as a
      # BYPASSRLS superuser. It is now the application's ASK, and provision.py refuses to finish a deploy
      # that cannot prove it: multi-workspace apps must fail closed, a single-workspace app still gets
      # enforced policies but they stay permissive when no workspace is in scope, so the control-plane
      # and cron paths that never set app.org_id keep working. The proof itself lands in
      # datastores.postgres.rls_verified, written only by a live measurement.
      "postgres":{"provider":ans["postgres_provider"],"orm":"drizzle","migrations_dir":"drizzle/",
                  "rls":"fail_closed" if ans["multi_tenant"] else "on",
                  "tenancy":"multi_org" if ans["multi_tenant"] else "single_org","url_ref":ans["postgres_ref"],"scope":ans["postgres_scope"],
                  "sslmode":"require"},
      "blob":{"provider":ans["blob_provider"],"root_prefix":f"orgs/{org_id}","token_ref":"BLOB_READ_WRITE_TOKEN"},
      "cache":{"provider":"none"},"memory":{"backend":"postgres"}}
    if ans["postgres_provider"] == "self_hosted":
        # A per-app CLUSTER, never a database on a shared one: `app_rw` is a cluster-global role whose
        # name is hardcoded across the mold, so a second app on the same cluster silently rotates the
        # first app's password. Reachable only from the app's own docker network — no host port.
        ds["postgres"].update({"network": f"sf-{app_id.replace('_','-')}", "host": "db", "port": 6543,
                               "database": re.sub(r"[^a-z0-9]", "", app_id.lower()), "admin_url_ref": "POSTGRES_ADMIN_URL",
                               "exposure": "private_docker_network"})
    if ans["postgres_provider"] == "neon":
        ds["postgres"]["admin_url_ref"] = "DATABASE_URL_UNPOOLED"     # migrations on the direct endpoint, runtime on the pooled one
        ds["postgres"]["pooling"] = "transaction"
    if hints.get("clone_of"):
        ds["postgres"]["snapshot"] = {"source": "live_fde_agent", "ref": hints["clone_of"]["ref"], "method": "pg_dump"}
        ds["blob"]["snapshot"] = {"source": "live_fde_agent", "ref": hints["clone_of"]["ref"]}
    ex_ds = existing.get("datastores", {})
    for k in ("snapshot",):
        for s in ("postgres", "blob"):
            if k in ex_ds.get(s, {}) and k not in ds[s]: ds[s][k] = ex_ds[s][k]
    if "store" in ex_ds.get("blob", {}): ds["blob"]["store"] = ex_ds["blob"]["store"]
    di = {"$schema":"../app_id/datainfra.schema.json",
      "dataroom":{"spec":f"molds/{mold_id}/codebase/dm.md","top_level":top_level,"system_of_record":"postgres",
                  "backend":"vercel-blob" if ans["blob_provider"]=="vercel_blob" else "local","blob_prefix":f"orgs/{org_id}","platform_version_ids":["v1"],
                  "seed":{"source":"live_snapshot" if hints.get("clone_of") else "none"}},
      "platforms":[],"deployments":[],"syncs":[{"source":"manual_entry"}],"pipelines":[],"agents":[],"connectors":[]}
    if ex_app.get("clone_of", {}).get("extracted_at"):    # what clone.py extract read from the live deployment
        ex_di = existing.get("datainfra", {})
        for k in ("platforms", "deployments", "pipelines", "agents", "dataroom"):
            if ex_di.get(k): di[k] = ex_di[k]
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
    existing = {n: load(os.path.join(outdir, f"{n}.json")) for n in ("application","infrastructure","datastores","datainfra") if os.path.exists(os.path.join(outdir, f"{n}.json"))}
    prod = pick_product(mold_id, hints, existing)
    ctx = {"app_id": app_id, "product": prod, "first_app": not [x for x in prod.get("app_ids", []) if x != app_id],
           "suffix": app_id[len(prod["product_id"])+1:] if app_id.startswith(prod["product_id"]+"_") else app_id,
           "existing_project": existing.get("infrastructure", {}).get("vercel", {}).get("project")}
    resolved, pending = {}, []; ctx["resolved"] = resolved   # later questions may depend on earlier answers
    if not hints.get("workspace_name") and not d.get("workspace_name"): hints["workspace_name"] = None
    answers = load(opt("--answers")) if opt("--answers") else {}
    qfile = os.path.join(outdir, "questions.json")
    if os.path.exists(qfile) and not answers:
        prev = load(qfile).get("answers", {}); answers.update(prev)
    for qid, path, prompt, options, resolve in QUESTIONS:
        if qid in answers: resolved[qid] = coerce(answers[qid]); continue
        v = resolve(d, hints, ctx)
        # factory defaults are only trusted once confirmed; until then they become suggested answers
        if v is not None and (d.get("confirmed") or qid not in ("deploy_target","postgres_provider","blob_provider","inference_provider","secret_store")):
            resolved[qid] = coerce(v); continue
        q = {"id":qid,"path":path,"question":prompt,"options":options,"suggested":v}
        if qid == "deploy_target" and hints.get("deploy_target_conflict"): q["why"] = "the brief names both the vm and Vercel"
        pending.append(q)
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
            print(f"  - {q['id']}: {q['question']}" + (f"  options={q['options']}" if q["options"] else "") + (f"  suggested={q['suggested']}" if q["suggested"] not in (None,"") else "") + (f"  ({q['why']})" if q.get("why") else ""))
        sys.exit(2)
    # everything resolved: write state, confirm defaults, register app
    gap = unforwarded(resolved["deploy_target"], resolved["inference_provider"])
    if gap:
        if not existing and not os.listdir(outdir): os.rmdir(outdir)   # nothing was written; leave no empty app behind
        sys.exit(f"{app_id}: inference provider {resolved['inference_provider']} needs {', '.join(gap)} at run time, but "
                 f"provision.py does not forward that name to the api project on target={resolved['deploy_target']} "
                 f"(API_ENV in .claude/scripts/provision.py), so a deploy would pass --check and still run without it. "
                 f"Nothing was written. Either add {', '.join(gap)} to API_ENV in .claude/scripts/provision.py and rerun, "
                 f"or say `inference via cloudflare workers ai` in the brief.")
    app, infra, ds, di = build_state(app_id, mold_id, resolved, hints, factory, brief_path, existing)
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
        if p["product_id"]==app["product_id"] and app_id not in p.setdefault("app_ids", []): p["app_ids"].append(app_id)
    save(os.path.join(ST,"products.json"), P)
    r = subprocess.run([sys.executable, os.path.join(ROOT,".claude/scripts/factory.py"), "validate"], capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode: sys.exit(r.returncode)
    print(f"state written: state/application/{app_id}/  (target={infra['target']}, project={infra.get('vercel',{}).get('project','vm')}, org={app['workspace']['org']['org_id']}, corpus={len(app['surface']['primary_context']['corpus'])}, processes={len(app['surface']['multiplayer_context']['processes'])}, secrets to provide: {len(infra['secrets'])})")
if __name__ == "__main__": main(sys.argv[1:])
