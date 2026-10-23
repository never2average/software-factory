#!/usr/bin/env python3
"""Intake: brief -> four application state files, asking only what the schemas cannot resolve.

  intake.py <brief.md> --app <app_id> [--mold mold_v1] [--answers answers.json] [--ask]
  intake.py --self-test [app_id]   re-run on a temp copy of a deployed app; nothing it did not write is dropped

A mold_v0 brief with pack sections (## Records, ## Tabs, ## Metrics, ## Charts, ## Jobs, ## Credentials, ## Schedules,
## Onboarding, ## Words, ## MCP; docs/INTAKE.md "mold_v0: the brief's pack sections") also gets a draft declarative pack,
packs/<pack_id>/ (lib/brief_pack.py): validated against the mold's pack.schema.json and the build's cross-checks, then
`packs.py check <pack> --mold mold_v0`. What the sections leave open joins questions.json; a pack.json a person edited
is never overwritten (keep / replace is asked).

Without --ask (the subagent path) it never prompts: it drafts what it can, writes
state/application/<app_id>/questions.json for anything unresolved, and exits 2.
The intake subagent asks the user, writes answers.json, re-runs with --answers.
With --ask it prompts on the terminal (sol path). Exit 0 = state complete and valid.

The brief drives the six service-surface blocks in application.json (docs/STATE.md).
Anything the brief does not say gets the mold's own default, never a guess.
"""
import sys as _sys_fl, os as _os_fl
_sys_fl.path.insert(0, _os_fl.path.join(_os_fl.path.dirname(_os_fl.path.abspath(__file__)), "lib"))
from factory_local import load_factory, live_projects
import legacy
import asr
import single_service   # a mold that ships as one service with its own compose stack (mold_v0-028)
import json, os, re, shutil, sys, datetime, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state"); TODAY = datetime.date.today().isoformat()
def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
EMAIL = r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}"

def parse_brief(text):
    """Deterministic hints from the brief. Interpretation beyond this is the intake subagent's job."""
    t = text.lower(); h = {}
    m = re.search(r"^\s*product name:\s*\"?([^\n\".]+?)\"?\s*(?:\.|$)", text, re.I | re.M)
    if m: h["product_name"] = m.group(1).strip()
    vm = bool(re.search(r"\b(vm|droplet|self.?host|on.prem|single machine)\b", t))
    # "vercel" anywhere used to pick the deploy target, so "inference through the Vercel AI Gateway" moved
    # an app that asked for the vm onto Vercel (and paired it with a self_hosted database provision.py
    # then refused). Only a vercel that is not the gateway's own name counts — and the name comes in
    # several spellings ("Vercel AI Gateway", "Vercel's AI Gateway", "vercel-ai-gateway", "Vercel gateway").
    # The possessive lives INSIDE the lookahead: as an optional group before it, "vercel's ai gateway"
    # backtracked out of the 's and matched a bare "vercel" that the lookahead could no longer see.
    vercel = bool(re.search(r"\bvercel\b(?!(?:['\u2019]s)?[\s-]+(?:ai[\s-]+)?gateway\b)", t))
    # A server of the customer's own that SERVES the app (mold_v1-075), as opposed to `vm`, which only verifies a
    # database on this box. Named explicitly, so the older vm words keep meaning what they meant.
    remote = bool(re.search(r"\bvm_remote\b|\b(?:remote|own|dedicated|customer(?:['\u2019]s)?) (?:server|machine)\b", t))
    if remote and not vercel:
        h["deploy_target"] = "vm_remote"; vm = False
        m = re.search(r"\bserver(?: address)?:\s*([0-9a-z][0-9a-z.-]*[0-9a-z])", t)
        if m: h["remote_host"] = m.group(1)
    elif remote: h["deploy_target_conflict"] = True
    if h.get("deploy_target") == "vm_remote" or h.get("deploy_target_conflict"): pass
    elif vm and vercel:
        # A brief that names BOTH is a question, not an answer. The last rule to run used to win, so
        # intake wrote target=vercel for a brief that asked for the vm. deploy_target stays pending.
        h["deploy_target_conflict"] = True
    elif vm: h["deploy_target"] = "vm"
    elif vercel: h["deploy_target"] = "vercel"
    if re.search(r"\bai[\s-]+gateway\b|\bvercel(?:['\u2019]s)?[\s-]+gateway\b", t): h["inference_provider"] = "vercel_ai_gateway"
    elif re.search(r"\bworkers\s+ai\b|\bcloudflare\b", t): h["inference_provider"] = "cloudflare_workers_ai"
    if re.search(r"\bno (web )?search\b|without (web )?search|disable (web )?search|\b(web )?search(ing)?:? (is )?off\b", t): h["web_search"] = False
    if re.search(r"\bno browser\b|without (a )?browser|disable (the )?browser|no outbound|\bbrowser( use)?:? (is )?off\b", t): h["browser"] = False
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
    # The mold comes from a line of its own ("Mold: mold_v0"), never from a mention in prose ("unlike mold_v1, ..."); a
    # mold that is not registered in state/factory.json is refused in main(), never guessed.
    m = re.search(r"^\s*mold:\s*([a-z][a-z0-9_]*)\s*\.?\s*$", t, re.M)
    if m: h["mold_id"] = m.group(1)
    # Only a line that STARTS with the label: "Multi-organization: no, one workspace" once named a workspace "no, one workspace".
    m = re.search(r"^\s*(?:workspace|org(?:anisation|anization)?)(?: name)?:\s*\"?([^\n\".]+?)\"?\s*(?:\.|\n|$)", text, re.I | re.M)
    if m: h["workspace_name"] = m.group(1).strip()
    # ...or the label's pre-rename spelling, where this machine names one (lib/legacy.py), so older briefs keep stamping.
    m = re.search(r"\b(?:" + "|".join(map(re.escape, ("owner",) + legacy.spellings("operator"))) + r"):\s*(" + EMAIL + ")", t)
    if m: h["operator_email"] = m.group(1)
    # Who may open a mold_v0 app's admin console (application.json platform_admins): a line of its own,
    # "Admins: you@example.com, *@example.com". Only addresses and *@domain entries are taken.
    m = re.search(r"^\s*(?:platform )?admin(?:istrator)?s?:\s*([^\n]+)$", t, re.M)
    if m:
        got = single_service.admin_entries([x for x in re.split(r"[,\s]+", m.group(1)) if "@" in x])[0]
        if got: h["platform_admins"] = got
    m = re.search(r"\b(?:members?|team):\s*((?:" + EMAIL + r"[,\s]*)+)", t)
    if m: h["members"] = re.findall(EMAIL, m.group(1))
    m = re.search(r"(?:accounts?|customers?) are called ([a-z]+)|call (?:accounts|customers) ([a-z]+)", t)
    if m:
        n = m.group(1) or m.group(2)   # singular: companies -> company, patients -> patient, classes -> class
        h["account_noun"] = n[:-3] + "y" if n.endswith("ies") else n[:-2] if n.endswith("sses") else n.rstrip("s")
    web = live_projects().get("web") or "live"   # the live deployment's web project, this machine's own name for it
    m = re.search(r"(?:clone|replica|copy) of (?:the )?live(?: " + "[ -]".join(map(re.escape, re.split(r"[-\s]+", web.lower()))) + r")?(?:\s+at\s+(https?://\S+|[a-z0-9.-]+\.[a-z]{2,}))?", t)
    if m: h["clone_of"] = {"kind": "live_deployment", "ref": (m.group(1) or web).rstrip(".,)")}
    m = re.search(r"primary context[:\s]+([^\n.]+)", t)
    if m: h["corpus"] = [x.strip() for x in re.split(r",|\band\b", m.group(1)) if x.strip()]
    m = re.search(r"multiplayer(?: context)?[:\s]+([^\n.]+)", t)
    if m: h["processes"] = [x.strip() for x in re.split(r",|\band\b", m.group(1)) if x.strip()]
    m = re.search(r"\bproduct:\s*([a-z0-9_-]+)", t)
    if m: h["product_id"] = m.group(1)
    m = re.search(r"\bpacks?:\s*([a-z0-9_, -]+)", t)   # "packs: hfc-research, other-pack" (mold_v0 ids may have underscores)
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
    # The starter library a new workspace is given. The mold carries none of its own; the original product's (13
    # workflows and 5 onboarding recipes for a team that delivers a platform to accounts) is the mold's
    # library/account-delivery/, and an app gets it only by asking: "workflows: all" (or "library"), or in plain
    # words, "with the starter library", "the account-delivery library", "the original workflow library".
    # "workflows: none", "no starter library" or silence mean none.
    # Written as a setting first ("workflows: all", "workflows none", "starter library: none"), then in plain words,
    # refusals before requests so that "no starter library" is never read as asking for one.
    m = re.search(r"\bworkflows?\s*:\s*(all|none|library)\b", t) or re.search(r"\bworkflows?\s+(all|none)\b", t) or re.search(r"\blibrar(?:y|ies)\s*:\s*(all|none)\b", t)
    if m: h["library"] = "all" if m.group(1) in ("all", "library") else "none"
    elif re.search(r"\b(?:no|without(?: the| a| any)?) (?:starter |built-?in |default |original |workflow |account[- ]delivery )+librar", t) \
         or re.search(r"(?:\bnot|n't|\bnever) (?:want|need|install|include|use|ship|have)\b[^.\n]{0,40}\blibrar", t): h["library"] = "none"
    elif re.search(r"\b(?:starter|built-?in|default|original|account[- ]delivery)(?: product'?s?)?(?: workflow)? librar", t): h["library"] = "all"
    # The speech model behind the microphone button (lib/asr.py): "speech model: nova-3", "dictation model:
    # @cf/openai/whisper", "speech language: hi", "no dictation" / "dictation: off". A model off the list is a
    # question (with why), never a guess.
    m = re.search(r"^\s*(?:speech|dictation|asr|speech[- ]to[- ]text|microphone)(?: model)?:\s*([^\n]+?)\s*$", text, re.I | re.M)
    if m and not re.fullmatch(r"(?:on|off|none|no|yes)", m.group(1).strip().lower()):
        mid = asr.normalize(m.group(1))
        if mid: h["asr_model"] = mid
        else: h["asr_model_unknown"] = m.group(1).strip()
    m = re.search(r"^\s*(?:speech|dictation) language:\s*([a-z]{2}|auto|detect)\b", t, re.M)
    if m: h["asr_language"] = None if m.group(1) in ("auto", "detect") else m.group(1)
    if re.search(r"\bno (?:dictation|microphone|speech[- ]to[- ]text)\b|\bwithout (?:dictation|a microphone|the microphone)\b|^\s*(?:dictation|microphone):\s*(?:off|none|no)\b", t, re.M):
        h["asr_enabled"] = False
    # The app's own profile settings (mold_v0-090; lib/app_profile.py): `limits.<section>.<name> = <number>` lines in a
    # `## Profile` or `## Budgets` section. Problems are refused in build_single, never guessed around.
    import app_profile
    prof, perrs, pnotes = app_profile.from_brief(text)
    if prof: h["profile"] = prof
    if perrs: h["profile_problems"] = perrs
    if pnotes: h["profile_notes"] = pnotes
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
    if target not in ("vm", "vm_remote"):      # vm_remote: every declared name goes into the master env file; web and agent get it from there
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
# What the account-delivery starter library provides. A process is implemented by these only in an app that asked
# for the library (library.install "all"); with "none" they are not in any workspace, so state does not claim them.
LIBRARY_REFS = {"recipe": {"onboard-self","import-roster","connect-sources","seed-workflows","onboard-customer"},
                "workflow_script": {"assign-account","data-migration-plan","eval-regression-triage","go-live-sprint","incident-postmortem","infosec-checklist",
                                    "infra-sizing","integration-wiring","onboard-account","qbr-prep","renewal-risk","route-incident","solution-engineering"}}
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
 ("deploy_target", "infrastructure.target", "Where should this application run?", ["vercel","vm","vm_remote"],
   lambda d,h,c: None if h.get("deploy_target_conflict") else h.get("deploy_target") or d.get("deploy_target")),
 # the hint was ignored here — alone among the sixteen questions — so a brief could never land on a
 # provider and intake silently stamped the factory default. self_hosted is LOCAL-ONLY (no host port),
 # so it forces target=vm; provision.py refuses to pair it with a Vercel deployment.
 ("postgres_provider", "datastores.postgres.provider", "Which Postgres provider?", ["neon","supabase","rds","self_hosted"],
   lambda d,h,c: "self_hosted" if answered(c, h, d, "deploy_target")=="vm_remote" else h.get("postgres_provider") or d.get("postgres_provider")),
 ("postgres_ref", "datastores.postgres.url_ref", "Name of the secret holding the Postgres URL (e.g. DATABASE_URL). Name only, never the value.", None,
   lambda d,h,c: "DATABASE_URL"),
 ("postgres_scope", "datastores.postgres.scope", "Fresh database for this app, or shared with the live source deployment's data?", ["fresh","shared_with_live"],
   lambda d,h,c: h.get("postgres_scope") or d.get("postgres_scope", "fresh")),
 ("blob_provider", "datastores.blob.provider", "Which blob store for the data room?", ["vercel_blob","s3","gcs","azure_blob","fs"],
   lambda d,h,c: "fs" if answered(c, h, d, "deploy_target")=="vm_remote" else d.get("blob_provider")),
 ("inference_provider", "infrastructure.inference.provider", "Which inference provider serves the agent?", ["cloudflare_workers_ai","vercel_ai_gateway"],
   lambda d,h,c: h.get("inference_provider") or d.get("inference_provider")),
 # the first name the provider reads: CLOUDFLARE_ACCOUNT_ID on Workers AI, AI_GATEWAY_API_KEY on the gateway
 ("inference_account", "infrastructure.inference.account_ref", "Name of the secret holding the inference account id (e.g. CLOUDFLARE_ACCOUNT_ID).", None,
   lambda d,h,c: (INFERENCE_SECRETS.get(answered(c, h, d, "inference_provider")) or [None])[0]),
 ("secret_store", "infrastructure.secret_store", "Where do secret values live?", ["vercel_env","vm_env_file","vm_remote_env_file"],
   lambda d,h,c: {"vm": "vm_env_file", "vm_remote": "vm_remote_env_file"}.get(answered(c, h, d, "deploy_target")) or d.get("secret_store")),
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
 ("operator_email", "application.workspace.operator_self.email", "Email of the operator who owns this workspace (must match the identity domain the mold accepts).", None,
   lambda d,h,c: h.get("operator_email") or legacy.get(d, "operator_email")),   # or its pre-rename spelling (lib/legacy.py)
 ("library", "application.surface.custom_workflow_builder.library.install", "Give new workspaces the original product's starter library (13 workflows and 5 onboarding recipes for account delivery)? none = no starter library.", ["none","all"],
   lambda d,h,c: h.get("library", "none")),
 # OPTIONAL: never pending (a brief, the app's state, or today's model resolve it), but offered: --ask prompts for it
 # with the default, and the intake subagent includes it in its batch (questions.json "optional", or the line printed
 # on success). A model the brief names that is not on the list is asked, with why.
 ("asr_model", "application.asr.model", asr.question_text(), asr.options(),
   lambda d,h,c: None if h.get("asr_model_unknown") else h.get("asr_model") or c.get("existing_asr", {}).get("model") or asr.DEFAULT_MODEL),
]
# Offered, never required: asked on the terminal (--ask) and by the intake subagent, with the resolved value as default.
OPTIONAL = {"asr_model"}

def qid_value_ok(q, v):
    return not q.get("options") or v in q["options"]

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
    if hints.get("product_name"):
        # A brief that names its own product ("Product name: Rooftop Desk") IS a new product: nobody minting an
        # application should have to know the factory's product ids, or borrow another brand's. It takes the mold's
        # base product's gates (the first product, which carries no pack and no brand of its own).
        pid = re.sub(r"[^a-z0-9]+", "_", hints["product_name"].lower()).strip("_")
        hit = next((p for p in prods if p["product_id"] == pid), None)
        if hit: return hit
        base = prods[0]; P = load(os.path.join(ST, "products.json"))
        new = {"product_id": pid, "mold_id": mold_id, "name": hints["product_name"], "tagline": hints.get("tagline", ""), "stage": "defined",
               "target_model": base.get("target_model"), "gates": base.get("gates"), "app_ids": [],
               "deploy_targets": [hints.get("target", "vercel")], "vercel_project": pid.replace("_", "-"), "packs": hints.get("packs") or []}
        P["products"].append({k: v for k, v in new.items() if v not in (None, "")}); save(os.path.join(ST, "products.json"), P)
        print(f"new product {pid!r} ({hints['product_name']}) on {mold_id}, with the gates of {base['product_id']}")
        return P["products"][-1]
    if len(prods) > 1:
        # No product named and no product name given: the mold as it comes, under its base product.
        return prods[0]
    return prods[0]

# ---- a re-run keeps what other writers recorded (mold_v1-081) ------------------------------------------
# Intake owns the fields it derives from the brief and answers. Everything else in an app's state was
# written by something that MEASURED or DID it — provision.py (rls_verified, deployed_at, health, google,
# mold_commit), agent_cli.py, domain.py, mint handoff — and a re-run used to rebuild the four files from
# scratch and drop whatever it had no line for (on onfinance_hfc: the whole rls_verified proof, the Google
# client, the agent CLI package, handoff_url). So every key the old file has and the new one lacks is carried
# forward, recursively, EXCEPT the paths intake decides by leaving out: those below disappear on purpose
# when the brief or answers change (a vm app has no `vercel` block, a single-pack brief drops a pack, a neon
# app has no self-hosted network). Lists are values, not merged.
OWNED_BY_OMISSION = {
  "application": {"customer_id", "packs", "clone_of", "surface.branding", "surface.primary_context.entity_vocabulary.note"},
  "infrastructure": {"vercel", "vm", "vm_remote"},
  "datastores": {"postgres.network", "postgres.host", "postgres.port", "postgres.database", "postgres.exposure",
                 "postgres.admin_url_ref", "postgres.pooling", "postgres.rls_verified"},
  "datainfra": set(),
}
def carry_forward(new, old, owned, path=""):
    """Copy into `new` every key of `old` it lacks (recursing into dicts both have), except `owned` paths."""
    for k, v in old.items():
        p = f"{path}.{k}" if path else k
        if p in owned: continue
        if k not in new: new[k] = v
        elif isinstance(new[k], dict) and isinstance(v, dict): carry_forward(new[k], v, owned, p)
    return new

def keep_measured(app, infra, ds, existing):
    """The carry-forward, plus the three fields intake writes but a later writer knows better."""
    ex_app, ex_inf, ex_ds = (existing.get(n, {}) for n in ("application", "infrastructure", "datastores"))
    # workspace.operator_self under a pre-rename spelling (lib/legacy.py): migrate it, never carry both.
    ex_ws = ex_app.get("workspace") or {}
    old = legacy.has_old(ex_ws, "operator_self")
    if old:
        ex_ws = dict(ex_ws); was = ex_ws.pop(old); ex_ws.setdefault("operator_self", was)
        ex_app = dict(ex_app, workspace=ex_ws)
    # A clone keeps the workspace it extracted from the live deployment WHOLE (build_state), old spelling included, and
    # the carry-forward below then added operator_self beside it: both keys, which validate refuses. Migrate it there too.
    nw = app.get("workspace") or {}; old = legacy.has_old(nw, "operator_self")
    if old:
        nw = dict(nw); was = nw.pop(old); nw.setdefault("operator_self", was); app["workspace"] = nw
    # mold_commit is what is IN FRONT OF TRAFFIC once provision.py deployed it; mint.py compares it with the
    # snapshot to know a redeploy is due, so resetting it to the snapshot's commit would hide a pending deploy.
    if ex_app.get("mold_commit") and ex_app.get("status") not in (None, "planned"): app["mold_commit"] = ex_app["mold_commit"]
    # The brief never names a model; intake only fills the factory default. An operator's later choice (roles,
    # a newer model) is kept while the provider is the same, and reset only when the provider itself changed.
    if (ex_app.get("model") or {}).get("provider") == app["model"]["provider"]: app["model"] = ex_app["model"]
    # rls_verified is a measurement OF A DATABASE: kept only while the provider it measured is still the one.
    rv = (ex_ds.get("postgres") or {}).get("rls_verified")
    if rv and rv.get("backend") == ds["postgres"]["provider"]: ds["postgres"]["rls_verified"] = rv
    for name, new, old in (("application", app, ex_app), ("infrastructure", infra, ex_inf), ("datastores", ds, ex_ds)):
        carry_forward(new, old, OWNED_BY_OMISSION[name])
    # a target switch drops the other target's block, but the SAME target keeps its whole block's history
    for t in ("vercel", "vm", "vm_remote"):
        if t in infra and isinstance(ex_inf.get(t), dict): carry_forward(infra[t], ex_inf[t], set())
    return app, infra, ds

def build_state(app_id, mold_id, ans, hints, factory, brief_path, existing):
    d = factory.get("defaults", {}); mold = next(m for m in factory["molds"] if m["mold_id"]==mold_id)
    if hints.get("profile") or hints.get("profile_problems"):   # mold_v0-090: a mold that takes no profile settings says so
        import app_profile
        perrs = list(hints.get("profile_problems") or []) + app_profile.problems(hints.get("profile"), mold_id, ROOT)
        if perrs: sys.exit(f"{app_id}: the brief's profile settings were refused, so nothing was written:\n  " + "\n  ".join(perrs))
    prod = pick_product(mold_id, hints, existing)
    org_id = slug(ans["workspace_name"]); owner = ans["operator_email"]
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
    members = [{"email": owner, "role": "owner"}] + [{"email": e, "role": "member"} for e in hints.get("members", []) if e != owner]
    corpus = []
    for kind, phrase in (match(hints["corpus"], CORPUS) if hints.get("corpus") else [(k, None) for k in DEFAULT_CORPUS]):
        if kind == "custom": corpus.append({"kind": "custom", "dataroom_path": "Uploads/", "description": phrase, "sync": "manual_entry", "required": True})
        else: corpus.append({"kind": kind, "dataroom_path": CORPUS[kind][1], "sync": CORPUS[kind][2], "required": True, **({"description": phrase} if phrase else {})})
    processes = []
    for name, phrase in (match(hints["processes"], PROCESSES) if hints.get("processes") else [(k, None) for k in DEFAULT_PROCESSES]):
        if name == "custom": processes.append({"name": "custom", "label": phrase, "enabled": True, "implemented_by": []})
        else: processes.append({"name": name, "enabled": True, "implemented_by": [{"kind": k, "ref": r} for k, r in PROCESSES[name][1] if ans["library"] == "all" or r not in LIBRARY_REFS.get(k, ())], **({"label": phrase} if phrase else {})})
    workspace = {
      "org": {"org_id": org_id, "name": ans["workspace_name"], "display_name": ans["workspace_name"], "blob_prefix": f"orgs/{org_id}"},
      "operator_self": {"email": owner, "name": owner.split("@")[0].replace(".", " ").title(), "title": "Workspace owner", "skills": [], "capacity_target_accounts": 8},
      "members": members, "platform_admins": [owner], "roster": [{"email": owner}], "customers": []}
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
        "escalation": {"path": "roster_escalations", **({"incident_workflow": "route-incident"} if ans["library"] == "all" else {}), "ticket_folders": ["bug","onboarding","feat"]},
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
    # The speech model (lib/asr.py): the answer, with the brief's language and on/off over the app's own earlier choice.
    ex_asr = (existing.get("application") or {}).get("asr") or {}
    app["asr"] = {"enabled": hints.get("asr_enabled", ex_asr.get("enabled", True)), "model": asr.normalize(ans["asr_model"]) or ans["asr_model"],
                  "language": hints["asr_language"] if "asr_language" in hints else ex_asr.get("language")}
    if app["asr"]["model"] not in asr.MODELS: sys.exit(f"asr_model {app['asr']['model']!r} is not on the speech-model list: {', '.join(asr.options())}")
    why = asr.language_problem(app["asr"]["model"], app["asr"]["language"])
    if why: sys.exit(f"{app_id}: {why}. Nothing was written.")
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
    elif ans["deploy_target"]=="vm":
        infra["vm"]=dict(d.get("vm",{})); infra["vm"]["compose"]=f"infra/vm/apps/{app_id}/docker-compose.yml"
    ex_inf = existing.get("infrastructure", {})
    for k in ("datastores", "deployed_at", "configured_at", "deploy_gate"):
        if k in ex_inf: infra[k] = ex_inf[k]
    # `health`, `smoke` and `rollback` are the deploy's own verdicts and `release` what a rollback returns to; dropping them
    # left state unable to say whether the app came up, or what to put back.
    for k in ("production_url", "workflow_url", "api_url", "crons", "health", "release", "rollback", "smoke"):
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
        ds["postgres"]["snapshot"] = {"source": "live_source_agent", "ref": hints["clone_of"]["ref"], "method": "pg_dump"}
        ds["blob"]["snapshot"] = {"source": "live_source_agent", "ref": hints["clone_of"]["ref"]}
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
    if ans["deploy_target"]=="vm_remote":
        # One function owns the vm_remote shape (lib/vm_remote.py), so intake, the fixture and the validator agree.
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")); import vm_remote
        vm_remote.shape_state(app_id, infra, ds, di, host=hints.get("remote_host"), domain=hints.get("custom_domain"))
    if existing:
        app, infra, ds = keep_measured(app, infra, ds, existing)
        carry_forward(di, existing.get("datainfra", {}), OWNED_BY_OMISSION["datainfra"])
    return app, infra, ds, di

def self_test_single(n, fails):
    """mold_v0-028: a single-service mold's intake, in a temp copy of the factory (scripts and state copied, molds
    linked read-only): where it runs is asked unless the brief says; state validates; a re-run keeps what a deploy wrote;
    a switch of target drops the other target's object. The real state/ is never written."""
    import shutil, tempfile
    h = parse_brief("Mold: mold_v0\nIt runs on its own server.\nDomain: shop.example.org\n")
    n += 1
    if (h.get("mold_id"), h.get("deploy_target"), h.get("custom_domain")) != ("mold_v0", "vm_remote", "shop.example.org"):
        fails.append(f"a mold_v0 brief's hints: {h}")
    T = tempfile.mkdtemp(prefix="intake-single-")
    try:
        shutil.copytree(os.path.dirname(os.path.abspath(__file__)), os.path.join(T, ".claude", "scripts"), ignore=shutil.ignore_patterns("__pycache__", "fixtures"))
        os.makedirs(os.path.join(T, "state", "application")); os.makedirs(os.path.join(T, "briefs"))
        for f in os.listdir(ST):
            if os.path.isfile(os.path.join(ST, f)): shutil.copy(os.path.join(ST, f), os.path.join(T, "state", f))
        shutil.copytree(os.path.join(ST, "tasks"), os.path.join(T, "state", "tasks"))
        shutil.copytree(os.path.join(ST, "application", "app_id"), os.path.join(T, "state", "application", "app_id"))
        os.symlink(os.path.join(ROOT, "molds"), os.path.join(T, "molds"))
        I = os.path.join(T, ".claude", "scripts", "intake.py"); A = os.path.join(T, "state", "application")
        # This machine's own values, the same on every machine: a verified sending domain (mold_v0-101: without one the
        # emails' sender is asked).
        mail_local = os.path.join(T, "mail-local.json"); save(mail_local, {"defaults": {"notify_domain": "mail.example.test"}})
        def go(app, brief, answers=None, env=None, admins=True, legal=True):
            # every brief here names its platform administrator (mold_v0's admin console) unless the case is about that
            if admins and "admins:" not in brief.lower(): brief += "Admins: ops@example.com\n"
            # and answers the legal question (mold_v0-109) with "later" unless the case is about that
            if legal and "legal." not in brief and "legal" not in (answers or {}): answers = {**(answers or {}), "legal": "later"}
            b = os.path.join(T, "briefs", app + ".md"); open(b, "w").write(brief)
            if answers is not None: save(os.path.join(T, "ans.json"), answers)
            return subprocess.run([sys.executable, I, b, "--app", app, *(["--answers", os.path.join(T, "ans.json")] if answers is not None else [])],
                                  cwd=T, capture_output=True, text=True, env=env or dict(os.environ, FACTORY_LOCAL=mail_local))
        def docs(app): return {k: load(os.path.join(A, app, k + ".json")) for k in ("application", "infrastructure", "datastores", "datainfra")}
        r = go("zz_one", "Mold: mold_v0\nIt runs on its own server.\nDomain: shop.example.org\n"); n += 1
        if r.returncode: fails.append(f"a mold_v0 brief for its own server did not stamp: {(r.stdout + r.stderr).strip()[-300:]}")
        else:
            d = docs("zz_one"); i = d["infrastructure"]; n += 1
            if (i["target"], i["compose_remote"]["compose"]["project"], i["compose_remote"].get("domain"), i["secrets_user"], d["datastores"]["postgres"]["exposure"]) != \
               ("compose_remote", "sf-zz-one", "shop.example.org", [], "compose_network") \
               or not {"CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"} <= set(i.get("secrets_optional") or []):   # the console's Clerk keys: optional since mold_v0-004 (built-in sign-in by default)
                fails.append(f"mold_v0 state for its own server: {i['target']} {i.get('compose_remote')} {d['datastores']['postgres']}")
            n += 1
            if "model" in d["application"] or "workspace" in d["application"] or "inference" in i: fails.append("mold_v1's model, workspace or inference was written into a mold_v0 app")
            # what a deploy writes survives a re-run
            d["application"]["status"] = "stamped"; d["application"]["testing"]["context"] = {"status": "pass", "run_at": "2026-10-20T00:00:00+00:00"}
            i.update(deployed_at="2026-10-20T00:00:00+00:00"); i["compose_remote"].update(host="203.0.113.7", production_url="https://shop.example.org", release="20261020T000000Z", health={"app": "healthy", "public": "200"})
            n += 1   # mold_v0-051: the product has row-level security; its deploy proves it (lib/single_service.py record_rls)
            if d["datastores"]["postgres"].get("rls") != "fail_closed": fails.append(f"a mold_v0 app asks for the product's row-level security: rls {d['datastores']['postgres'].get('rls')!r}")
            d["datastores"]["postgres"]["rls_verified"] = {"at": "2026-10-20T00:01:00+00:00", "backend": "self_hosted", "mode": "fail_closed", "running_app": "enforced",
                                                          "source": "check:rls (npm run check:rls, the product's own), by provision.py --deploy-remote", "running_app_detail": "x"}
            for k, v in d.items(): save(os.path.join(A, "zz_one", k + ".json"), v)
            r = go("zz_one", "Mold: mold_v0\nIt runs on its own server.\nDomain: shop.example.org\n"); d2 = docs("zz_one"); n += 1
            if r.returncode or d2 != d: fails.append(f"a same-brief re-run of a deployed mold_v0 app changed its state: {(r.stdout + r.stderr).strip()[-200:]}")
            r = go("zz_one", "Mold: mold_v0\nDomain: shop.example.org\n", {"deploy_target": "vercel"}); d3 = docs("zz_one"); n += 1
            if r.returncode or d3["infrastructure"]["target"] != "vercel" or "compose_remote" in d3["infrastructure"] or d3["infrastructure"]["secrets_user"] != [] or not {"CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"} <= set(d3["infrastructure"]["secrets_optional"]) or "DATABASE_URL" not in d3["infrastructure"]["secrets_derived"] \
               or d3["datastores"]["postgres"]["provider"] != "neon":
                fails.append(f"switching a mold_v0 app to Vercel: {(r.stdout + r.stderr).strip()[-200:]} {d3['infrastructure'].get('target')}")
        # review fixes (PR #17): the mold only from its own line and only a registered one; a Vercel project that is taken
        n += 1
        if parse_brief("Unlike mold_v1, this product is small.\n").get("mold_id") or parse_brief("Mold: mold_v0\n").get("mold_id") != "mold_v0":
            fails.append("the mold must come from a `Mold:` line only, never from a mention in prose")
        r = go("zz_bad", "Mold: mold_v9\nIt runs on its own server.\n"); n += 1
        if r.returncode == 0 or "not registered" not in r.stdout + r.stderr or os.path.exists(os.path.join(A, "zz_bad", "application.json")):
            fails.append(f"a brief naming an unregistered mold must be refused with nothing written: rc={r.returncode}")
        shutil.copytree(os.path.join(A, "zz_one"), os.path.join(A, "zz_other"))   # zz_one is on Vercel by now: a whole, valid app
        for nm, f in (("application", lambda d: d.update(app_id="zz_other")), ("infrastructure", lambda d: d["vercel"].update(project="zz-four", projects={"api": "zz-four-api", "web": "zz-four"}))):
            d_ = load(os.path.join(A, "zz_other", nm + ".json")); f(d_); save(os.path.join(A, "zz_other", nm + ".json"), d_)
        r = go("zz_four", "Mold: mold_v0\n", {"deploy_target": "vercel"}); n += 1
        got = (load(os.path.join(A, "zz_four", "infrastructure.json")).get("vercel") or {}).get("project") if r.returncode == 0 else None
        if got != "zz-four-2" or "zz-four-2" not in r.stdout:
            fails.append(f"a default Vercel project another app holds must be suffixed and said: {got} {(r.stdout + r.stderr).strip()[-200:]}")
        r = go("zz_five", "Mold: mold_v0\n", {"deploy_target": "vercel", "vercel_project": "zz-four"}); n += 1
        if r.returncode == 0 or "zz_other" not in r.stdout + r.stderr:
            fails.append(f"an answered Vercel project another app holds must be refused: rc={r.returncode}")
        shutil.rmtree(os.path.join(A, "zz_five"), ignore_errors=True)   # the refused run above leaves its (empty) folder
        d_ = load(os.path.join(A, "zz_other", "infrastructure.json")); d_["vercel"].update(project="zz-six-api", projects={"api": "zz-six-api-api", "web": "zz-six-api"})
        save(os.path.join(A, "zz_other", "infrastructure.json"), d_)
        r = go("zz_six", "Mold: mold_v0\n", {"deploy_target": "vercel"}); n += 1
        got = (load(os.path.join(A, "zz_six", "infrastructure.json")).get("vercel") or {}) if r.returncode == 0 else {}
        if got.get("project") != "zz-six-2" or got.get("projects") != {"api": "zz-six-2-api", "web": "zz-six-2"} or "zz-six-api" not in r.stdout:
            fails.append(f"a default base whose API project (<name>-api) another app holds must be suffixed, both names recorded: {got} {(r.stdout + r.stderr).strip()[-200:]}")
        shutil.rmtree(os.path.join(A, "zz_other"), ignore_errors=True)
        # mold_v0-037: provision.py's LIVE refusal reads <base>-workflow too, so a base whose -workflow name is LIVE is taken
        loc = os.path.join(T, "local.json"); save(loc, {"live_projects": {"workflow": "zz-seven-workflow"}, "defaults": {"notify_domain": "mail.example.test"}})
        lenv = dict(os.environ, FACTORY_LOCAL=loc)
        r = go("zz_seven", "Mold: mold_v0\n", {"deploy_target": "vercel"}, env=lenv); n += 1
        got = (load(os.path.join(A, "zz_seven", "infrastructure.json")).get("vercel") or {}) if r.returncode == 0 else {}
        if got.get("project") != "zz-seven-2" or "zz-seven-workflow" not in r.stdout:
            fails.append(f"a default base whose <base>-workflow is a LIVE project must be suffixed and said: {got} {(r.stdout + r.stderr).strip()[-200:]}")
        r = go("zz_eight", "Mold: mold_v0\n", {"deploy_target": "vercel", "vercel_project": "zz-seven"}, env=lenv); n += 1
        if r.returncode == 0 or "LIVE" not in r.stdout + r.stderr:
            fails.append(f"an answered base whose <base>-workflow is a LIVE project must be refused: rc={r.returncode} {(r.stdout + r.stderr).strip()[-200:]}")
        shutil.rmtree(os.path.join(A, "zz_eight"), ignore_errors=True)
        # mold_v0-024: the brief's brand and packs reach a mold_v0 app's state, as a mold_v1 app's do
        r = go("zz_brand", "Mold: mold_v0\nIt runs on its own server.\nDomain: brand.example.org\nBrand: Acme Ops\nBrand colour: #1F6F5C\n"); n += 1
        b_ = (docs("zz_brand")["application"].get("surface") or {}).get("branding") or {} if not r.returncode else {}
        if r.returncode or b_.get("product_name") != "Acme Ops" or b_.get("brand_color") != "#1F6F5C" or not b_.get("icon_svg"):
            fails.append(f"a mold_v0 brief's brand lines must reach surface.branding: {(r.stdout + r.stderr).strip()[-300:]} {b_}")
        # mold_v0-090: the brief's profile settings (## Budgets / ## Profile) reach application.profile, exactly
        base = "Mold: mold_v0\nIt runs on its own server.\nDomain: lim.example.org\n"
        bud = base + "\n## Budgets (operator, 2026-10-22)\nPer run US$40. The profile raises the ceilings: limits.runs.budget_usd_max = 40, limits.runs.kind_month_budget_usd = 500 (defaults $25 and $200).\n\n## Data\nOther prose.\n"
        r = go("zz_lim", bud); n += 1
        p_ = docs("zz_lim")["application"].get("profile") if not r.returncode else None
        if r.returncode or p_ != {"limits": {"runs": {"budget_usd_max": 40, "kind_month_budget_usd": 500}}} or "limits.runs.budget_usd_max 40" not in r.stdout:
            fails.append(f"a mold_v0 brief's ## Budgets limits must reach application.profile and be said: {(r.stdout + r.stderr).strip()[-300:]} {p_}")
        r = go("zz_lim", base + "\nThe old ceiling was limits.runs.budget_usd_max = 90, in prose.\n"); n += 1
        if r.returncode or "profile" in docs("zz_lim")["application"] or "outside a ## Profile or ## Budgets section: ignored" not in r.stdout:
            fails.append(f"a setting taken out of the brief is taken out of state (never carried forward), and one outside the sections is ignored and said: {(r.stdout + r.stderr).strip()[-300:]}")
        for bad, why in (("## Profile\nhost_packs: maxwell\n", "host_packs cannot be set"), ("## Profile\nlimits.runs.budget_usd_max = 1,000\n", "no value I can read"),
                         ("## Budgets\nlimits.runs.budget_usd = 40\n", "is not a limit"), ("## Profile\nlimits.runs.budget_usd_max = 40\nlimits.runs.budget_usd_max = 400\n", "set twice"),
                         ("## Profile\nbilling.enabled: true\n", "cannot be set by the app"), ("## Budgets\nWe weighed limits.runs.budget_usd_max = 400 but chose 40.\n", "no value I can read"),
                         ("## Budgets\nlimits.runs.budget_usd_max = 40k\n", "no value I can read"), ("## Budgets\nlimits.runs.budget_usd_max = 4000\n", "ceiling")):
            r = go("zz_limbad", base + bad); n += 1
            if r.returncode == 0 or why not in r.stdout + r.stderr or os.path.exists(os.path.join(A, "zz_limbad", "application.json")):
                fails.append(f"a brief profile setting with {why!r} must be refused, nothing written: rc={r.returncode} {(r.stdout + r.stderr).strip()[-300:]}")
            shutil.rmtree(os.path.join(A, "zz_limbad"), ignore_errors=True)
        r = go("zz_lim", base + "\n## Budgets\n<!-- limits.runs.budget_usd_max = 150 -->\n~~limits.runs.kind_month_budget_usd = 900~~\n```\nlimits.runs.live_per_workspace = 90\n```\n"); n += 1
        if r.returncode or "profile" in docs("zz_lim")["application"]:
            fails.append(f"settings a reader of the brief cannot see (an HTML comment, struck through, a code block) are never applied: {(r.stdout + r.stderr).strip()[-200:]}")
        r = go("zz_lim", bud); d_ = docs("zz_lim")["application"]; d_["profile"]["limits"]["runs"]["budget_usd_max"] = 4000
        save(os.path.join(A, "zz_lim", "application.json"), d_); r = go("zz_lim", bud); n += 1
        if r.returncode or docs("zz_lim")["application"]["profile"]["limits"]["runs"]["budget_usd_max"] != 40:
            fails.append("a hand-raised limit in state must be put back to the brief's on the next intake run")
        os.makedirs(os.path.join(T, "packs", "notes_pack")); save(os.path.join(T, "packs", "notes_pack", "pack.json"), {"pack_id": "notes_pack", "mold_id": "mold_v0", "name": "N", "description": "d"})
        r = go("zz_packed", "Mold: mold_v0\nIt runs on its own server.\nDomain: packed.example.org\nPacks: notes_pack\n"); n += 1
        if r.returncode or docs("zz_packed")["application"].get("packs") != ["notes_pack"]:
            fails.append(f"a mold_v0 brief's packs line (an id with an underscore) must reach application.packs: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_nopack", "Mold: mold_v0\nIt runs on its own server.\nPacks: not_there\n"); n += 1
        if r.returncode == 0 or "not_there" not in (r.stdout + r.stderr) or os.path.exists(os.path.join(A, "zz_nopack", "application.json")):
            fails.append(f"a mold_v0 brief naming a pack that does not exist must be refused, nothing written: rc={r.returncode}")
        # mold_v0-101: the emails' sender. With a notify_domain nothing is asked (the factory's default); without one it is
        # asked, an answer reaches application.profile and answers.json (and factory.py validate accepts it), "later" leaves
        # it unset, an answer that is not an address is asked again, and the brief's own ## Profile line needs no question.
        nolocal = dict(os.environ, FACTORY_LOCAL=os.path.join(T, "none.json"))
        srv = "Mold: mold_v0\nIt runs on its own server.\nDomain: mail.example.org\n"
        r = go("zz_mail", srv, env=nolocal); n += 1
        q = load(os.path.join(A, "zz_mail", "questions.json")) if os.path.exists(os.path.join(A, "zz_mail", "questions.json")) else {}
        if r.returncode != 2 or [x["id"] for x in q.get("pending", [])] != ["email_from_address"]:
            fails.append(f"with no notify_domain the emails' sender must be asked: rc={r.returncode} {q.get('pending')} {(r.stdout + r.stderr).strip()[-200:]}")
        r = go("zz_mail", srv, {"email_from_address": "not an address"}, env=nolocal); n += 1
        if r.returncode != 2 or "is not an address" not in r.stdout: fails.append(f"an answer that is not an address must be asked again: rc={r.returncode}")
        r = go("zz_mail", srv, {"email_from_address": "hello@mail.example.org"}, env=nolocal); n += 1
        if r.returncode or (docs("zz_mail")["application"].get("profile") or {}).get("email_from_address") != "hello@mail.example.org" \
                or load(os.path.join(A, "zz_mail", "answers.json")).get("email_from_address") != "hello@mail.example.org":
            fails.append(f"an answered sender must reach application.profile and answers.json: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_mail", srv, env=nolocal); n += 1
        if r.returncode or (docs("zz_mail")["application"].get("profile") or {}).get("email_from_address") != "hello@mail.example.org":
            fails.append(f"a re-run keeps the answered sender: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_mail2", srv, {"email_from_address": "later"}, env=nolocal); n += 1
        if r.returncode or "profile" in docs("zz_mail2")["application"]: fails.append(f"later leaves the sender unset: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_mail3", srv + "\n## Profile\nemail_from_address = team@brand.example.org\nemail.notifications = access_requests, usage\n", env=nolocal); n += 1
        if r.returncode or docs("zz_mail3")["application"].get("profile") != {"email_from_address": "team@brand.example.org", "email": {"notifications": ["access_requests", "usage"]}}:
            fails.append(f"the brief's ## Profile sender and notifications reach state with no question: {(r.stdout + r.stderr).strip()[-300:]}")
        # the platform administrators: from the brief's Admins line, asked when it has none, refused when not an address
        n += 1
        if parse_brief("Mold: mold_v0\nAdmins: Ops@Example.com, *@example.org and nobody\n").get("platform_admins") != ["ops@example.com", "*@example.org"]:
            fails.append(f"a brief's Admins line must give its addresses and *@domain entries: {parse_brief('Admins: Ops@Example.com, *@example.org').get('platform_admins')}")
        if docs("zz_one")["application"].get("platform_admins") != ["ops@example.com"]:
            fails.append(f"the brief's administrator must reach application.platform_admins: {docs('zz_one')['application'].get('platform_admins')}")
        loc2 = os.path.join(T, "local-op.json"); save(loc2, {"defaults": {"operator_email": "op@example.com", "notify_domain": "mail.example.test"}})
        r = go("zz_adm", "Mold: mold_v0\nIt runs on its own server.\nDomain: adm.example.org\n", admins=False, env=dict(os.environ, FACTORY_LOCAL=loc2)); n += 1
        q = load(os.path.join(A, "zz_adm", "questions.json")) if os.path.exists(os.path.join(A, "zz_adm", "questions.json")) else {}
        if r.returncode != 2 or [x["id"] for x in q.get("pending", [])] != ["platform_admins"] or q["pending"][0].get("suggested") != "op@example.com" \
                or os.path.exists(os.path.join(A, "zz_adm", "application.json")):
            fails.append(f"a mold_v0 brief naming no administrator must ask exactly that (the operator's address suggested), nothing written: rc={r.returncode} {q.get('pending')}")
        r = go("zz_adm", "Mold: mold_v0\nIt runs on its own server.\nDomain: adm.example.org\n", {"platform_admins": "Boss@Example.com, *@example.org"}, admins=False); n += 1
        if r.returncode or docs("zz_adm")["application"].get("platform_admins") != ["boss@example.com", "*@example.org"] \
                or load(os.path.join(A, "zz_adm", "answers.json")).get("platform_admins") != ["boss@example.com", "*@example.org"] or "platform administrators: boss@example.com" not in r.stdout:
            fails.append(f"an answered administrator list must reach state and answers.json, and be said: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_admbad", "Mold: mold_v0\nIt runs on its own server.\n", {"platform_admins": "boss@example.com, not-an-address"}, admins=False); n += 1
        if r.returncode == 0 or "not-an-address" not in r.stdout + r.stderr or os.path.exists(os.path.join(A, "zz_admbad", "application.json")):
            fails.append(f"an administrator that is not an address must be refused, nothing written: rc={r.returncode} {(r.stdout + r.stderr).strip()[-200:]}")
        shutil.rmtree(os.path.join(A, "zz_admbad"), ignore_errors=True)
        # an app deployed before the question existed: not asked again here (provision.py's check reads its target by name)
        d_ = docs("zz_brand"); d_["application"].pop("platform_admins", None); d_["infrastructure"]["deployed_at"] = "2026-10-20T00:00:00+00:00"
        for k, v in d_.items(): save(os.path.join(A, "zz_brand", k + ".json"), v)
        ans_ = load(os.path.join(A, "zz_brand", "answers.json")); ans_.pop("platform_admins", None); save(os.path.join(A, "zz_brand", "answers.json"), ans_)
        r = go("zz_brand", "Mold: mold_v0\nIt runs on its own server.\nDomain: brand.example.org\nBrand: Acme Ops\nBrand colour: #1F6F5C\n", admins=False); n += 1
        if r.returncode or "platform_admins" in docs("zz_brand")["application"] or "platform_admins" in load(os.path.join(A, "zz_brand", "answers.json")):
            fails.append(f"a deployed app with no administrator recorded is not stopped by intake, and nothing is invented: {(r.stdout + r.stderr).strip()[-300:]}")
        # the legal pages (mold_v0-109): asked of a new app whose brief names no company; "later" leaves it without them;
        # an answer becomes application.profile.legal with today's date, kept on a re-run; the brief's ## Profile lines
        # need no question; an answer that cannot be read is asked again; a deployed app is never stopped for it.
        lg = "Mold: mold_v0\nIt runs on its own server.\nDomain: legal.example.org\n"
        r = go("zz_legal", lg, legal=False); n += 1
        q = load(os.path.join(A, "zz_legal", "questions.json")) if os.path.exists(os.path.join(A, "zz_legal", "questions.json")) else {}
        if r.returncode != 2 or [x["id"] for x in q.get("pending", [])] != ["legal"] or q["pending"][0].get("suggested") != "later" or os.path.exists(os.path.join(A, "zz_legal", "application.json")):
            fails.append(f"a new mold_v0 app whose brief names no company must be asked exactly the legal question, nothing written: rc={r.returncode} {q.get('pending')}")
        r = go("zz_legal", lg, {"legal": "Acme Widgets"}, legal=False); n += 1
        if r.returncode != 2 or "no email address" not in r.stdout: fails.append(f"a legal answer with no address must be asked again, with why: rc={r.returncode} {r.stdout[-300:]}")
        r = go("zz_legal", lg, {"legal": "Acme Widgets, Inc., Legal@Acme.example"}, legal=False); n += 1
        want = {"company_name": "Acme Widgets, Inc.", "contact_email": "Legal@Acme.example", "effective_date": TODAY}
        if r.returncode or (docs("zz_legal")["application"].get("profile") or {}).get("legal") != want or load(os.path.join(A, "zz_legal", "answers.json")).get("legal") != want \
                or "legal pages: /terms and /privacy for Acme Widgets, Inc." not in r.stdout:
            fails.append(f"an answered company must reach application.profile.legal with today's date and answers.json, and be said: {(r.stdout + r.stderr).strip()[-300:]}")
        a_ = load(os.path.join(A, "zz_legal", "answers.json")); a_["legal"]["effective_date"] = "2026-01-02"; save(os.path.join(A, "zz_legal", "answers.json"), a_)
        r = go("zz_legal", lg, legal=False); n += 1
        if r.returncode or (docs("zz_legal")["application"].get("profile") or {}).get("legal", {}).get("effective_date") != "2026-01-02":
            fails.append(f"a re-run keeps the answered company and its date: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_legal2", lg, {"legal": "later"}, legal=False); n += 1
        if r.returncode or "legal" in (docs("zz_legal2")["application"].get("profile") or {}) or "no legal pages" not in r.stdout:
            fails.append(f"later leaves the app without legal pages, and says so: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_legal3", lg + "\n## Profile\nlegal.company_name = Brand Ltd\nlegal.contact_email = privacy@brand.example.org\nlegal.jurisdiction = England and Wales\n", legal=False); n += 1
        if r.returncode or docs("zz_legal3")["application"].get("profile", {}).get("legal") != {"company_name": "Brand Ltd", "contact_email": "privacy@brand.example.org", "jurisdiction": "England and Wales", "effective_date": TODAY}:
            fails.append(f"the brief's ## Profile legal lines reach state with no question, dated today: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_legal4", lg + "\n## Profile\nlegal.company_name = Brand Ltd\nlegal.contact_email = privacy@brand.example.org\nlegal.terms_url = http://brand.example.org/terms\n", legal=False); n += 1
        if r.returncode == 0 or "legal.terms_url" not in r.stdout + r.stderr or os.path.exists(os.path.join(A, "zz_legal4", "application.json")):
            fails.append(f"a brief's own terms page that is not https:// is refused, nothing written: rc={r.returncode} {(r.stdout + r.stderr).strip()[-200:]}")
        d_ = docs("zz_legal2"); d_["infrastructure"]["deployed_at"] = "2026-10-20T00:00:00+00:00"
        for k, v in d_.items(): save(os.path.join(A, "zz_legal2", k + ".json"), v)
        ans_ = load(os.path.join(A, "zz_legal2", "answers.json")); ans_.pop("legal", None); save(os.path.join(A, "zz_legal2", "answers.json"), ans_)
        r = go("zz_legal2", lg, legal=False); n += 1
        if r.returncode or "legal" in (docs("zz_legal2")["application"].get("profile") or {}):
            fails.append(f"a deployed app whose brief names no company is not stopped by intake, and nothing is invented: {(r.stdout + r.stderr).strip()[-300:]}")
        r = go("zz_two", "Mold: mold_v0\nA product for a team.\n"); n += 1
        q = load(os.path.join(A, "zz_two", "questions.json")) if os.path.exists(os.path.join(A, "zz_two", "questions.json")) else {}
        if r.returncode != 2 or [x["id"] for x in q.get("pending", [])] != ["deploy_target"]:
            fails.append(f"a mold_v0 brief that does not say where it runs must ask exactly that: rc={r.returncode} {q.get('pending')}")
    finally:
        shutil.rmtree(T, ignore_errors=True)
    return n, fails

def self_test(app_id="onfinance_hfc"):
    """Re-run intake on a COPY of a deployed app's state, in a temp tree, and prove nothing a deploy or a
    verify wrote is dropped. The real state/ is read, never written: the run happens under a temp ROOT
    (scripts and state copied; packs, molds and briefs linked read-only) and state/ is hashed around it."""
    import hashlib, shutil, tempfile
    def digest(d):
        h = hashlib.sha256()
        for r, _, fs in sorted(os.walk(d)):
            for f in sorted(fs): h.update(f.encode()); h.update(open(os.path.join(r, f), "rb").read())
        return h.hexdigest()
    def paths(o, p=""):
        if isinstance(o, dict):
            for k, v in o.items(): yield from paths(v, f"{p}.{k}" if p else k)
        else: yield p, o
    real = digest(ST); fails, n = [], 0
    # The speech-model hints and question (pure): brief words, the list with prices, today's model as the default.
    H = lambda txt: {k: v for k, v in parse_brief(txt).items() if k.startswith("asr")}
    pure = [(H("Speech model: nova-3\nspeech language: hi\n"), {"asr_model": "@cf/deepgram/nova-3", "asr_language": "hi"}),
            (H("Dictation model: @cf/openai/whisper\n"), {"asr_model": "@cf/openai/whisper"}),
            (H("speech model: gpt-4o-transcribe\n"), {"asr_model_unknown": "gpt-4o-transcribe"}),
            (H("No dictation, please.\n"), {"asr_enabled": False}),
            (H("A research desk for analysts.\n"), {})]
    for got, want in pure:
        n += 1
        if got != want: fails.append(f"brief hints for the speech model: {got} != {want}")
    q = next(x for x in QUESTIONS if x[0] == "asr_model"); n += 1
    if q[1] != "application.asr.model" or q[3][0] != asr.DEFAULT_MODEL or set(q[3]) != set(asr.MODELS) or "$0.000513 per audio minute" not in q[2] or "asr_model" not in OPTIONAL:
        fails.append(f"the asr_model question is not the optional list with prices and today's default first: {q[:4]}")
    n += 1
    if q[4]({}, {}, {}) != asr.DEFAULT_MODEL or q[4]({}, {"asr_model_unknown": "x"}, {}) is not None or q[4]({}, {}, {"existing_asr": {"model": "@cf/openai/whisper"}}) != "@cf/openai/whisper":
        fails.append("asr_model resolves: default today's model; an unknown brief model is asked; the app's own earlier choice is kept")
    n, _ = self_test_single(n, fails)
    import brief_pack_selftest   # mold_v0-062: a brief's pack sections -> packs/<id>/ (lib/brief_pack_selftest.py)
    n, _ = brief_pack_selftest.run(n, fails)
    if fails: sys.exit("intake self-test FAILED:\n  " + "\n  ".join(fails))
    src = os.path.join(ST, "application", app_id)
    if not os.path.exists(os.path.join(src, "answers.json")): sys.exit(f"self-test needs a deployed app with answers.json; {app_id} has none "
                                                                      f"(the {n} checks before it passed, the mold_v0 ones among them)")
    T = tempfile.mkdtemp(prefix="intake-selftest-")
    try:
        shutil.copytree(os.path.dirname(os.path.abspath(__file__)), os.path.join(T, ".claude", "scripts"))
        shutil.copytree(ST, os.path.join(T, "state"))
        for d in ("packs", "molds", "briefs"): os.symlink(os.path.join(ROOT, d), os.path.join(T, d))
        tapp = os.path.join(T, "state", "application", app_id)
        before = {nm: load(os.path.join(src, f"{nm}.json")) for nm in ("application", "infrastructure", "datastores", "datainfra")}
        brief = before["application"]["brief"]
        def rerun(answers):
            save(os.path.join(T, "answers.in.json"), answers)
            return subprocess.run([sys.executable, os.path.join(T, ".claude/scripts/intake.py"), os.path.join(T, brief), "--app", app_id,
                                   "--answers", os.path.join(T, "answers.in.json")], cwd=T, capture_output=True, text=True)
        answers = load(os.path.join(src, "answers.json"))
        r = rerun(answers); n += 1
        if r.returncode: fails.append(f"re-run exited {r.returncode}: {(r.stdout + r.stderr).strip()[-400:]}")
        for nm, old in before.items():
            new = load(os.path.join(tapp, f"{nm}.json"))
            old_ws = legacy.old_name("operator_self")
            renamed = lambda p: p.replace(f"workspace.{old_ws}", "workspace.operator_self", 1) if old_ws else p   # migrated on purpose
            lost = [p for p, _ in paths(old) if renamed(p) not in dict(paths(new))]
            n += 1
            if lost: fails.append(f"{nm}: a same-answers re-run dropped {len(lost)} field(s): {', '.join(lost[:8])}")
        after = {nm: load(os.path.join(tapp, f"{nm}.json")) for nm in ("application", "datastores")}
        n += 1
        if after["datastores"]["postgres"].get("rls_verified") != before["datastores"]["postgres"].get("rls_verified"):
            fails.append("datastores.postgres.rls_verified changed on a same-answers re-run")
        n += 1
        if after["application"].get("mold_commit") != before["application"].get("mold_commit"):
            fails.append(f"mold_commit (what is deployed) changed: {before['application'].get('mold_commit')} -> {after['application'].get('mold_commit')}")
        n += 1
        lib_of = lambda a: a["surface"]["custom_workflow_builder"].get("library")
        if lib_of(after["application"]) != lib_of(before["application"]):
            fails.append(f"the starter library set in state ({lib_of(before['application'])}) was changed by a same-answers re-run to {lib_of(after['application'])}")
        n += 1
        if after["application"]["model"] != before["application"]["model"]:
            fails.append("the operator's model choice was reset by a re-run that did not change the provider")
        n += 1
        want_asr = before["application"].get("asr") or {"enabled": True, "model": asr.DEFAULT_MODEL, "language": None}
        if after["application"].get("asr") != want_asr:
            fails.append(f"the speech model choice {want_asr} became {after['application'].get('asr')} on a same-answers re-run")
        # The developer picks another speech model: it is written; a mold that cannot carry it is refused by validate.
        for nm in before: save(os.path.join(tapp, f"{nm}.json"), before[nm])
        r = rerun(dict(answers, asr_model="nova-3")); n += 1
        got = load(os.path.join(tapp, "application.json")).get("asr") or {}
        mold_src = os.path.join(ROOT, "molds", before["application"]["mold_id"], "codebase")
        if got.get("model") != "@cf/deepgram/nova-3": fails.append(f"answer asr_model=nova-3 was not written as @cf/deepgram/nova-3: {got}")
        elif asr.mold_reads_env(mold_src) and r.returncode: fails.append(f"asr_model=nova-3 on a mold that reads ASR_MODEL was refused: {(r.stdout + r.stderr).strip()[-300:]}")
        elif not asr.mold_reads_env(mold_src) and (r.returncode == 0 or "cannot take a per-app speech model yet" not in r.stdout + r.stderr):
            fails.append(f"asr_model=nova-3 on a mold that cannot carry it was not refused by validate: rc={r.returncode} {(r.stdout + r.stderr).strip()[-300:]}")
        # a real change of database provider must NOT keep the old database's isolation proof
        for nm in before: save(os.path.join(tapp, f"{nm}.json"), before[nm])
        # A real switch: a provider that is neither the one in state nor the recorded answer (a recorded answer that only
        # repeats itself does not override state; see main()).
        now_prov = before["datastores"]["postgres"].get("provider")
        other = next(p for p in ("supabase", "neon", "rds") if p not in (now_prov, answers.get("postgres_provider")))
        switch = dict(answers, postgres_provider=other)
        if answers.get("deploy_target") == "vm_remote":
            # On vm_remote the database is ALWAYS the server's own Postgres (lib/vm_remote.py shape_state), so a provider
            # answer alone is not a switch (mold_v1-231): same host, same database, and its proof rightly stays. Assert
            # exactly that, then make the real switch a vm_remote app can make: off the server, onto a managed provider.
            r = rerun(switch); n += 1
            if r.returncode: fails.append(f"vm_remote re-run with postgres_provider={other} exited {r.returncode}: {(r.stdout + r.stderr).strip()[-400:]}")
            pg = load(os.path.join(tapp, "datastores.json")).get("postgres", {})
            if pg.get("provider") != "self_hosted": fails.append(f"a vm_remote app took postgres provider {pg.get('provider')} (its database is the server's own)")
            elif pg.get("rls_verified") != before["datastores"]["postgres"].get("rls_verified"):
                fails.append("a vm_remote re-run that kept the same database changed its rls_verified")
            if load(os.path.join(tapp, "answers.json")).get("postgres_provider") != "self_hosted":
                fails.append(f"a vm_remote re-run recorded postgres_provider={other}, which its state does not carry")
            for nm in before: save(os.path.join(tapp, f"{nm}.json"), before[nm])
            save(os.path.join(tapp, "answers.json"), answers)
            switch.update(deploy_target="vercel", blob_provider="vercel_blob", secret_store="vercel_env")
        # The re-run may exit 1 here, AFTER writing state: validate then (rightly) asks for a fresh --verify-rls.
        r = rerun(switch); n += 1
        ds2 = load(os.path.join(tapp, "datastores.json"))
        if ds2.get("postgres", {}).get("provider") != other:
            fails.append(f"the provider switch to {other} was not written (provider {ds2.get('postgres', {}).get('provider')}): "
                         f"{(r.stdout + r.stderr).strip()[-400:]}")
        if "rls_verified" in ds2.get("postgres", {}): fails.append(f"switching postgres to {other} kept the old database's rls_verified")
        n += 1
        if other != "neon" and "pooling" in ds2["postgres"]: fails.append("switching away from neon kept postgres.pooling")
    finally:
        shutil.rmtree(T, ignore_errors=True)
    n += 1
    if digest(ST) != real: fails.append("the REAL state/ changed during the self-test")
    if fails: sys.exit("intake self-test FAILED:\n  " + "\n  ".join(fails))
    print(f"intake: {n} checks passed (re-run on a temp copy of {app_id}; real state untouched)")

# ---- a single-service mold (molds/<mold_id>/mold.json; today mold_v0, mold_v0-028) ----------------------------
# Its state uses the same four schemas, with only the fields that shape needs (lib/single_service.py shape_state). Most
# of the questions above are mold_v1's (inference, web search, the browser, the data room, the starter library, the
# speech model) and have no subject here, so they are not asked. Where it runs is asked unless the brief says.
def _single_target(h, c):
    if h.get("deploy_target_conflict"): return None
    t = {"vm_remote": "compose_remote", "vm": "compose_remote", "vercel": "vercel"}.get(h.get("deploy_target"))
    return t or c.get("existing_target")
SINGLE_QUESTIONS = [
 ("deploy_target", "infrastructure.target", "Where should this application run: on a server of its own (the product's own Docker Compose "
  "stack, with HTTPS from its own Caddy) or on Vercel (two projects: the API, and the web console)?", ["compose_remote", "vercel"], lambda d, h, c: _single_target(h, c)),
 ("domain", "infrastructure.compose_remote.domain", "The web address people will open, e.g. app.example.com (blank: name it later with "
  "provision.py <app> --set-remote domain=<name>).", None, lambda d, h, c: h.get("custom_domain") or c.get("existing_domain") or ""),
 ("vercel_project", "infrastructure.vercel.project", "Vercel project name for this app (target vercel only): its two projects are <name>-api (the API) and <name> (the web console).", None,
  lambda d, h, c: c.get("existing_project") or slug(c["app_id"])),
 # Who may open the admin console besides a company account's members. Without one nobody can reach /admin (the app
 # answers "invite-only"). An app deployed before this question existed and lacking it is not asked again here:
 # provision.py's check reads whether its target already holds the variable (by name) and asks only if not.
 ("platform_admins", "application.platform_admins", "Which email address(es) may run this app's admin console? An address such as "
  "you@example.com, or *@example.com for everyone at that company; separate several with commas. (Not a secret: it is kept in the app's state.)", None,
  lambda d, h, c: h.get("platform_admins") or c.get("existing_admins") or ([] if c.get("deployed") else None)),
]

LATER = ("later", "none", "skip", "")
def sender_question(app_id, mold_id, hints, existing, answers):
    """The sender question (mold_v0-101), or None when the sender is known: the brief's ## Profile, an answer (this run's,
    or an earlier one in answers.json), or the factory's default on this machine's notify_domain."""
    import app_profile
    s = app_profile.spec(mold_id, ROOT)
    if not s or not s.get("email_defaults") or "email_from_address" not in s.get("app_settable", []): return None
    if (hints.get("profile") or {}).get("email_from_address"): return None
    if app_profile.notify_domain(ROOT): return None
    a = answers.get("email_from_address")
    if a is not None and (str(a).strip().lower() in LATER or not app_profile.address_problem(str(a).strip())): return None
    return {"id": "email_from_address", "path": "application.profile.email_from_address", "options": None, "suggested": "later",
            "question": "Which email address should this app send from (sign-in codes, invitations, answers to access requests)? It must be on a "
                        "domain your email provider (Resend) has verified, for example hello@yourcompany.com. Answer later to leave it for now: "
                        "the app then sends nothing until it is set.",
            "why": "this machine has no verified sending domain (defaults.notify_domain in state/factory.local.json) and the brief names no sender"
                   + (f"; {a!r} is not an address" if a is not None else "")}

def legal_question(app_id, mold_id, hints, existing, answers, deployed):
    """The legal pages' question (mold_v0-109), or None when it is answered: the brief's ## Profile legal.* lines, an
    answer (this run's or an earlier one in answers.json; "later" is one), or a deployed app (never stopped here: its
    pages are turned on by adding the lines to its brief). An answer that cannot be read is asked again, with why."""
    import app_profile
    s = app_profile.spec(mold_id, ROOT)
    if not s or "legal" not in s.get("app_settable", []): return None
    if (hints.get("profile") or {}).get("legal"): return None
    why = None
    if answers.get("legal") is not None:
        _, why = app_profile.legal_from_answer(answers["legal"])
        if not why: return None
    elif deployed: return None
    return {"id": "legal", "path": "application.profile.legal", "options": None, "suggested": "later",
            "question": "Which company offers this app, for its Terms of use and Privacy notice pages? Write the company's legal name, then an "
                        "email address people can write to about the terms and their data, for example: Acme Ltd, legal@acme.com. Answer later "
                        "to leave the app without these pages for now (they can be added before launch).",
            "why": "the app's Terms and Privacy pages name the company behind it, and the brief names none (## Profile: legal.company_name, legal.contact_email)"
                   + (f"; {why}" if why else "")}

def _legal_settings(app_id, ans, hints, existing):
    """mold_v0-109: the app's `legal` from the brief (## Profile legal.* lines) or from the answer, with its effective
    date: the brief's, else the date it was first recorded for this company and address (kept on re-runs), else today.
    The answer is put back into `ans` as the block it became (answers.json keeps the date). Exits on one it cannot read."""
    import app_profile
    ex = (((existing.get("application") or {}).get("profile") or {}).get("legal") or {})
    same = lambda d: ex.get("effective_date") if (ex.get("company_name"), ex.get("contact_email")) == (d.get("company_name"), d.get("contact_email")) else None
    b = (hints.get("profile") or {}).get("legal")
    if b:
        if isinstance(b, dict) and "effective_date" not in b: b["effective_date"] = same(b) or TODAY
        return
    if ans.get("legal") is None: return
    got, why = app_profile.legal_from_answer(ans["legal"])
    if why: sys.exit(f"{app_id}: legal: {why}. Nothing was written.")
    if not got: ans["legal"] = "later"; return
    got.setdefault("effective_date", same(got) or TODAY)
    ans["legal"] = got

def build_single(app_id, mold_id, ans, hints, factory, brief_path, existing):
    """The four documents of a single-service app, with what a deploy, a lane run or the operator recorded kept."""
    mold = next(m for m in factory["molds"] if m["mold_id"] == mold_id)
    prod = pick_product(mold_id, hints, existing)
    app, infra, ds, di = single_service.shape_state(app_id, mold_id, ans["deploy_target"], prod, mold, ans, hints,
                                                    os.path.relpath(brief_path, ROOT), factory.get("defaults", {}), ROOT)
    # Packs and the brand, from the brief or the product, as for mold_v1 (mold_v0-024): only where the mold takes them
    # (mold.json not_needed says why not), so a brief cannot hand a mold an overlay it has no rules for.
    nn = (single_service.manifest(mold_id, ROOT) or {}).get("not_needed") or {}
    packs = hints.get("packs") or list(prod.get("packs") or [])
    if packs and "packs" in nn: sys.exit(f"{app_id}: the brief names packs ({', '.join(packs)}), but {mold_id} takes none: {nn['packs']}. Nothing was written.")
    for pid in packs:
        if not os.path.exists(os.path.join(ROOT, "packs", pid, "pack.json")): sys.exit(f"the brief names pack '{pid}' but packs/{pid}/pack.json does not exist")
    if packs: app["packs"] = packs
    brand = {} if hints.get("no_branding") else dict(prod.get("brand") or {})
    if (brand or any(hints.get(k) for k in ("brand_name", "brand_color", "brand_logo", "brand_tagline"))) and "brand" not in nn \
            and os.path.isfile(os.path.join(ROOT, "molds", mold_id, "branding", "rules.json")):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from branding import normalize, name_problem
        app["surface"] = {"branding": normalize(brand, hints.get("brand_name"), hints.get("brand_color"), hints.get("brand_logo"), hints.get("brand_tagline"))}
        why = name_problem(app["surface"]["branding"]["product_name"], mold_id)
        if why: sys.exit(f"{app_id}: {why}. Nothing was written.")
    # The app's own profile settings (mold_v0-090): the brief's `## Profile` / `## Budgets` settings, exactly. The brief is
    # where they are set, so a setting taken out of the brief is taken out of state too (never carried forward).
    import app_profile
    _legal_settings(app_id, ans, hints, existing)
    for note in hints.get("profile_notes") or []: print("note: " + note)
    perrs = list(hints.get("profile_problems") or []) + app_profile.problems(hints.get("profile"), mold_id, ROOT)
    if perrs: sys.exit(f"{app_id}: the brief's profile settings were refused, so nothing was written:\n  " + "\n  ".join(perrs))
    if hints.get("profile"):
        app["profile"] = hints["profile"]
        print(f"profile settings from the brief: {app_profile.describe(app['profile'])} (over {mold_id}'s defaults; in effect from the next deploy)")
    # The sender someone answered (mold_v0-101), when the brief names none: kept in the profile, and in answers.json, which
    # factory.py validate reads beside the brief.
    sender = str(ans.get("email_from_address") or "").strip()
    if sender and sender.lower() not in LATER and not (hints.get("profile") or {}).get("email_from_address"):
        if app_profile.address_problem(sender): sys.exit(f"{app_id}: {app_profile.address_problem(sender)}. Nothing was written.")
        app.setdefault("profile", {})["email_from_address"] = sender
        print(f"the emails' sender: {sender} (answered; in effect from the next deploy)")
    # The legal pages (mold_v0-109): the company someone answered, when the brief names none.
    if isinstance(ans.get("legal"), dict) and not (hints.get("profile") or {}).get("legal"):
        app.setdefault("profile", {})["legal"] = ans["legal"]
        print(f"legal pages: /terms and /privacy for {ans['legal']['company_name']} <{ans['legal']['contact_email']}> (answered; in effect from the next deploy)")
    elif not (app.get("profile") or {}).get("legal") and "legal" in ((app_profile.spec(mold_id, ROOT) or {}).get("app_settable") or []):
        print("note: no legal pages: the app has no Terms or Privacy page until its brief's ## Profile names the company "
              "(legal.company_name = ..., legal.contact_email = ...) or the legal question is answered")
    ex_app, ex_inf, ex_ds, ex_di = (existing.get(n, {}) for n in ("application", "infrastructure", "datastores", "datainfra"))
    for k in ("status", "testing", "revert"):
        if ex_app.get(k): app[k] = ex_app[k]
    if ex_app.get("mold_commit") and ex_app.get("status") not in (None, "planned"): app["mold_commit"] = ex_app["mold_commit"]
    other = {"vercel", "vm", "vm_remote", "compose_remote"} - {infra["target"]}
    carry_forward(app, ex_app, {"customer_id", "packs", "surface", "workspace", "model", "asr", "capabilities", "profile"})
    carry_forward(infra, ex_inf, other | {"inference", "runtime_env"})
    t = infra["target"]
    if isinstance(ex_inf.get(t), dict): carry_forward(infra[t], ex_inf[t], set())
    if ex_ds.get("postgres", {}).get("provider") == ds["postgres"]["provider"]: carry_forward(ds, ex_ds, set())
    carry_forward(di, ex_di, set())
    return app, infra, ds, di

def taken_projects(app_id):
    """{project name: why it is not this app's to take}: the live projects, and every project another app deploys to
    (a mold_v1 app's three: <p>, <p>-api, <p>-workflow; a single-service app's two, also recorded in vercel.projects)."""
    out = {p: "one of the LIVE projects this factory never writes to" for p in live_projects().values()}
    adir = os.path.join(ST, "application")
    for o in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
        if o in (app_id, "app_id"): continue
        try: v = load(os.path.join(adir, o, "infrastructure.json")).get("vercel") or {}
        except (OSError, ValueError): continue
        p = v.get("project")
        for x in ((p, f"{p}-api", f"{p}-workflow") if p else ()) + tuple(x for x in (v.get("projects") or {}).values() if isinstance(x, str)):
            out.setdefault(x, f"already {o}'s project")
    return out

# ---- a mold_v0 brief's pack sections -> packs/<pack_id>/ (mold_v0-062) -------------------------------------------
# A new mold_v0 app is a brief + a generated pack.json + a brand. The brief's `## Records`, `## Tabs`, `## Metrics`,
# `## Charts`, `## Jobs`, `## Credentials`, `## Schedules`, `## Onboarding`, `## Words` and `## MCP` sections (format:
# docs/INTAKE.md "mold_v0: the brief's pack sections"; parser: lib/brief_pack.py) become a declarative pack:
#   packs/<pack_id>/pack.json                         the factory's manifest (packs.py), with what intake recorded
#   packs/<pack_id>/files/packs/<pack_id>/pack.json   the shell's pack.json, valid against packs/pack.schema.json
# What the brief leaves open is a question in questions.json, never a guess. A pack.json someone edited after intake
# wrote it (its sha256 is not the one intake recorded) is never overwritten: intake asks keep or replace, and keeps a
# draft of the brief's version beside it. A pack intake did not make (no `intake` record) is never touched.
def _pack_brand_known(hints, mold_id, existing):
    """Read-only: does the app already have a brand (the brief, the product it will get, or its own state)?"""
    if hints.get("brand_name") or hints.get("no_branding"): return True
    if (((existing.get("application") or {}).get("surface") or {}).get("branding") or {}).get("product_name"): return True
    prods = [p for p in load(os.path.join(ST, "products.json"))["products"] if p["mold_id"] == mold_id]
    want = hints.get("product_id") or (existing.get("application") or {}).get("product_id") or \
           (re.sub(r"[^a-z0-9]+", "_", hints["product_name"].lower()).strip("_") if hints.get("product_name") else None)
    p = next((x for x in prods if x["product_id"] == want), None)   # only a product the brief or the app names: never a default product's brand
    return bool((p or {}).get("brand"))

def pack_plan(app_id, mold_id, hints, text, brief_path, answers, existing):
    """The draft pack from the brief: {pack_id, pack, pending, used, defaults, ...}. Exits 2 on a brief it cannot read."""
    import brief_pack as BP
    nn = (single_service.manifest(mold_id, ROOT) or {}).get("not_needed") or {}
    if "packs" in nn: sys.exit(f"{app_id}: the brief declares a pack, but {mold_id} takes none: {nn['packs']}. Nothing was written.")
    raw = [m.group(1) for m in re.finditer(r"^\s*packs?:\s*(.*?)\s*$", BP.prose(text), re.I | re.M)]
    named = [x.strip() for r_ in raw for x in r_.split(",") if x.strip()]
    for x in named:
        if not BP.PACK_ID.fullmatch(x):   # the whole value, never a prefix a looser pattern read
            sys.exit(f"{app_id}: `Pack: {x}` cannot be a pack id ({BP.PACK_ID.pattern}: it is also the pack's table prefix). Nothing was written.")
    if len(named) > 1: sys.exit(f"{app_id}: the brief declares a pack and names {len(named)} packs ({', '.join(named)}); name the one it declares with `Pack: <id>`. Nothing was written.")
    pid = named[0] if named else app_id
    if not BP.PACK_ID.fullmatch(pid):   # checked BEFORE it is ever part of a path
        sys.exit(f"{app_id}: {pid!r} cannot be a pack id ({BP.PACK_ID.pattern}: it is also the pack's table prefix); add a line `Pack: <id>` to the brief. Nothing was written.")
    pdir = os.path.join(ROOT, "packs", pid); man_p = os.path.join(pdir, "pack.json")
    man = load(man_p) if os.path.isfile(man_p) else None
    if man is None and os.path.isdir(pdir) and os.listdir(pdir):
        sys.exit(f"{app_id}: packs/{pid}/ already holds files and no manifest, so it is not intake's to fill. Name this brief's pack with another "
                 f"`Pack: <id>` line, or move packs/{pid}/ away. Nothing was written.")
    if man is not None and not isinstance(man.get("intake"), dict):
        sys.exit(f"{app_id}: packs/{pid}/ is a pack made by hand (intake did not write it), so intake will not touch it. Name the pack this brief "
                 f"declares with another `Pack: <id>` line, or take the pack sections out of the brief to use packs/{pid} as it is. Nothing was written.")
    rec = (man or {}).get("intake") or {}
    if man is not None and rec.get("app_id") != app_id:
        sys.exit(f"{app_id}: packs/{pid}/ was made by intake for {rec.get('app_id') or 'no recorded app'}; give this app's pack its own `Pack: <id>`. Nothing was written.")
    eff = dict(rec.get("answers") or {}); eff.update({k: v for k, v in answers.items() if k.startswith("pack.")})
    try: spec, c = BP.parse(text)
    except BP.BriefError as x:
        print(f"{os.path.relpath(brief_path, ROOT)}: the brief's pack sections cannot be read (format: docs/INTAKE.md, \"mold_v0: the brief's pack sections\"). Nothing was written.")
        for p in x.problems: print(f"  {p}")
        sys.exit(2)
    name = (hints.get("product_name") or hints.get("brand_name") or pid.replace("_", " ").title())[:80]
    ctx = {"pack_id": pid, "name": name, "description": f"{name}: a declarative pack made by intake from {os.path.relpath(brief_path, ROOT)} (mold_v0-062)."[:1000]}
    try: pack, pending, used, defaults = BP.draft(spec, c, eff, ctx)
    except BP.BriefError as x:
        print(f"{app_id}: an answer does not fit. Nothing was written."); [print(f"  {p}") for p in x.problems]; sys.exit(2)
    schema = load(os.path.join(ROOT, "molds", mold_id, "codebase", "packs", "pack.schema.json"))
    mcp = spec.get("mcp")
    if mcp and not BP.mcp_reserved(schema): BP.apply_mcp(pack, mcp, defaults)   # pack.json `mcp` (mold_v0-060, 068)
    return {"BP": BP, "pack_id": pid, "dir": pdir, "manifest": man, "record": rec, "pack": pack, "pending": pending, "used": used, "defaults": defaults,
            "spec": spec, "c": c, "schema": schema, "name": name, "description": ctx["description"], "mcp": mcp, "answers": eff}

def _brief_line(problem, pack, c):
    """The brief line a validation problem comes from, when it can be told."""
    m = re.match(r"pack\.json\.(record_areas|job_kinds|metrics|charts|tabs|credentials|schedules|onboarding)\[(\d+)\]", problem)
    kind = {"record_areas": "area", "job_kinds": "job", "metrics": "metric", "charts": "chart", "tabs": "tab", "credentials": "credential", "schedules": "schedule", "onboarding": "step"}
    if m:
        it = (pack.get(m.group(1)) or [{}])[int(m.group(2))] if int(m.group(2)) < len(pack.get(m.group(1)) or []) else {}
        return c.lines.get((kind[m.group(1)], it.get("id") or it.get("name")))
    m = re.match(r"(record area|job kind|metric|chart|tab|credential|schedule|onboarding step) (\S+)", problem)
    if m: return c.lines.get(({"record area": "area", "job kind": "job", "onboarding step": "step"}.get(m.group(1), m.group(1)), m.group(2)))
    return None

def write_pack(app_id, mold_id, plan, brief_path, text, answers):
    """Validate the draft and write packs/<pack_id>/ (only what changed), then `packs.py check`. -> pack_id, or a pending
    question (the edit guard). Exits 1 when the draft fails validation or the check, with nothing written."""
    BP, pid, pack, c = plan["BP"], plan["pack_id"], plan["pack"], plan["c"]
    problems, how = BP.validate(pack, plan["schema"], os.path.join(ROOT, "molds", mold_id, "codebase"))
    if problems:
        print(f"{app_id}: the pack drafted from the brief does not pass its checks ({'; '.join(how)}). Nothing was written.")
        for p in problems:
            n = _brief_line(p, pack, c); print(f"  {p}" + (f"  (brief line {n})" if n else ""))
        sys.exit(1)
    shell_dir = os.path.join(plan["dir"], "files", "packs", pid); shell_p = os.path.join(shell_dir, "pack.json")
    new = BP.dumps(pack).encode(); rec = plan["record"]
    cur = open(shell_p, "rb").read() if os.path.isfile(shell_p) else None
    write, kept = True, rec.get("kept_sha256")
    if cur is not None and cur != new:
        h = BP.sha(cur)
        if h != rec.get("pack_json_sha256"):
            # Someone edited the pack.json intake wrote (or intake's record of it is gone): never overwritten without a yes.
            qid = f"pack.overwrite.{h[:12]}"; a = answers.get(qid)
            if a == "replace": kept = None
            elif a == "keep" or h == kept: write, kept = False, h
            else:
                return {"id": qid, "path": f"packs/{pid}/files/packs/{pid}/pack.json", "question":
                        f"packs/{pid}/files/packs/{pid}/pack.json was changed by hand after intake wrote it, and the brief now says something else. "
                        f"keep = keep the hand-edited file as it is (the brief's version is saved beside it as packs/{pid}/pack.draft.json to compare); "
                        f"replace = overwrite the hand edits with the brief's version.", "options": ["keep", "replace"], "suggested": "keep",
                        "why": "the file's contents are not what intake last wrote"}
    draft_p = os.path.join(plan["dir"], "pack.draft.json"); man_p = os.path.join(plan["dir"], "pack.json")
    # What is there now, so a pack that `packs.py check` then refuses leaves packs/ exactly as it was.
    made_dir = not os.path.isdir(plan["dir"])
    before = {f: (open(f, "rb").read() if os.path.isfile(f) else None) for f in (shell_p, draft_p, man_p)}
    def undo():
        for f, b in before.items():
            if b is None and os.path.isfile(f): os.remove(f)
            elif b is not None and open(f, "rb").read() != b: open(f, "wb").write(b)
        if made_dir: shutil.rmtree(plan["dir"], ignore_errors=True)
    os.makedirs(shell_dir, exist_ok=True)
    if write:
        if cur != new: open(shell_p, "wb").write(new)
        if os.path.exists(draft_p): os.remove(draft_p)
        written = BP.sha(new)
    else:
        if not os.path.isfile(draft_p) or open(draft_p, "rb").read() != new: open(draft_p, "wb").write(new)
        written = rec.get("pack_json_sha256")
        try: p2, _ = BP.validate(load(shell_p), plan["schema"])
        except ValueError as x: p2 = [f"it is not valid JSON ({x})"]
        print(f"note: packs/{pid}/files/packs/{pid}/pack.json was edited by hand and is kept as it is; the brief's version is packs/{pid}/pack.draft.json"
              + (f". The edited file does not pass the checks: {'; '.join(p2[:5])}" if p2 else ""))
    man = dict(plan["manifest"] or {})
    man.update({"pack_id": pid, "mold_id": mold_id})
    man.setdefault("name", plan["name"]); man.setdefault("description", plan["description"])
    intake = {"generated_by": BP.GENERATOR, "app_id": app_id, "brief": os.path.relpath(brief_path, ROOT), "brief_sha256": BP.sha(text),
              "pack_json_sha256": written, "answers": dict(sorted(plan["used"].items())), "defaults": plan["defaults"], "checked_with": how}
    if kept: intake["kept_sha256"] = kept
    if plan["mcp"] and "mcp" not in pack:
        intake["mcp"] = plan["mcp"]
        print(f"note: {mold_id} reserves pack.json `mcp` until mold_v0-060, so the brief's ## MCP lines are kept in packs/{pid}/pack.json (intake.mcp), not in the shell's pack.json")
    man["intake"] = intake
    mtext = BP.dumps(man).encode()
    if not os.path.isfile(os.path.join(plan["dir"], "pack.json")) or open(os.path.join(plan["dir"], "pack.json"), "rb").read() != mtext:
        open(os.path.join(plan["dir"], "pack.json"), "wb").write(mtext)
    r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude", "scripts", "packs.py"), "check", pid, "--mold", mold_id], capture_output=True, text=True)
    if r.returncode:
        undo()
        sys.exit(f"{app_id}: packs.py check {pid} --mold {mold_id} refused the pack, so nothing was written: {(r.stdout + r.stderr).strip()[-600:]}")
    counts = ", ".join(f"{len(pack.get(k) or [])} {w}" for k, w in (("record_areas", "areas"), ("job_kinds", "jobs"), ("metrics", "metrics"), ("charts", "charts"),
                                                                    ("tabs", "tabs"), ("credentials", "credentials"), ("schedules", "schedules"), ("onboarding", "steps")))
    print(f"pack: packs/{pid}/ ({counts}); {'written' if write and cur != new else 'unchanged' if write else 'kept as edited'}; checked with {', '.join(how)}; packs.py check clean")
    for d_ in plan["defaults"]: print(f"  default: {d_}")
    return pid


def main_single(app_id, mold_id, hints, factory, brief_path, outdir, existing, answers_path, ask, text=None):
    d = factory.get("defaults", {})
    ex_inf = existing.get("infrastructure", {})
    ctx = {"app_id": app_id, "existing_target": ex_inf.get("target") if ex_inf.get("target") in single_service.TARGETS else None,
           "existing_domain": (ex_inf.get("compose_remote") or {}).get("domain") or (ex_inf.get("vercel") or {}).get("custom_domain"),
           "existing_project": (ex_inf.get("vercel") or {}).get("project"),
           "existing_admins": single_service.admin_entries((existing.get("application") or {}).get("platform_admins") or [])[0],
           "deployed": bool(ex_inf.get("deployed_at"))}
    answers = load(answers_path) if answers_path else {}
    qfile = os.path.join(outdir, "questions.json")
    if os.path.exists(qfile) and not answers: answers.update(load(qfile).get("answers", {}))
    resolved, pending = {}, []
    man = single_service.manifest(mold_id, ROOT) or {}
    asks_admins = bool(single_service.admin_env_names(man) or single_service.admin_env_names(man, "compose_remote"))
    if "platform_admins" in answers:   # an address or *@domain each; a wrong one is refused, never dropped quietly
        got, bad = single_service.admin_entries(answers["platform_admins"])
        if bad: sys.exit(f"{app_id}: platform_admins: {', '.join(bad)} is not an email address or *@domain. Nothing was written.")
        if got: answers["platform_admins"] = got
        else: answers.pop("platform_admins")
    for qid, path, prompt, options, resolve in SINGLE_QUESTIONS:
        if qid == "platform_admins" and not asks_admins: continue
        if qid in answers: resolved[qid] = coerce(answers[qid]); continue
        v = resolve(d, hints, ctx)
        if v is not None: resolved[qid] = v; continue
        q = {"id": qid, "path": path, "question": prompt, "options": options,
             "suggested": "compose_remote" if qid == "deploy_target" else (str(d.get("operator_email") or "").strip().lower() or None) if qid == "platform_admins" else None}
        if qid == "deploy_target" and hints.get("deploy_target_conflict"): q["why"] = "the brief names both a server of its own and Vercel"
        pending.append(q)
    # The emails' sender (mold_v0-101; lib/app_profile.py email_defaults): the factory makes it <app_id>@<notify_domain>;
    # on a machine with no notify_domain, and with none in the brief or the app's state, it is asked, never guessed.
    prev = os.path.join(outdir, "answers.json")      # an earlier answer stays until the brief names a sender or it is answered again
    if "email_from_address" not in answers and os.path.isfile(prev) and load(prev).get("email_from_address"): answers["email_from_address"] = load(prev)["email_from_address"]
    q = sender_question(app_id, mold_id, hints, existing, answers)
    if q: pending.append(q)
    elif "email_from_address" in answers: resolved["email_from_address"] = str(answers["email_from_address"]).strip()
    # The legal pages (mold_v0-109): the company behind the app, asked of a new app whose brief names none; "later" leaves
    # it without Terms and Privacy pages. An earlier answer (answers.json) stands.
    if "legal" not in answers and os.path.isfile(prev) and load(prev).get("legal") is not None: answers["legal"] = load(prev)["legal"]
    q = legal_question(app_id, mold_id, hints, existing, answers, ctx["deployed"])
    if q: pending.append(q)
    elif answers.get("legal") is not None and not (hints.get("profile") or {}).get("legal"): resolved["legal"] = answers["legal"]
    # The brief's pack sections (mold_v0-062): their open points join the same questions; the brand is asked with them.
    pk, extra = None, {}
    with_pack = text is not None and __import__("brief_pack").has_sections(text)
    def plan_pack():
        nonlocal pk, extra
        if not with_pack: return []
        pk = pack_plan(app_id, mold_id, hints, text, brief_path, answers, existing)
        qs = list(pk["pending"]); extra = dict(pk["used"])
        known = (((existing.get("application") or {}).get("surface") or {}).get("branding") or {}).get("product_name")
        if "brand_name" in answers: hints["brand_name"] = extra["brand_name"] = str(answers["brand_name"]).strip()
        elif not hints.get("brand_name") and not hints.get("no_branding") and known:
            hints["brand_name"] = known   # the brand the app already has: a re-run never drops it back to the mold's default
        elif not _pack_brand_known(hints, mold_id, existing):
            qs.append({"id": "brand_name", "path": "application.surface.branding.product_name", "question":
                       "What is the app called, as its users will see it (the console's title, the MCP server's name, the emails' sender)? "
                       "The colour and logo can be set later with branding.py.", "options": None, "suggested": pk["name"],
                       "why": "a mold_v0 app is a brief, a pack and a brand; the brief names no brand"})
        return qs
    pending += plan_pack()
    def ask_all(qs):
        for q in qs:
            try: v = input(f"{q['question']} [{'/'.join(q['options'] or [])}] (default: {q['suggested']}): ").strip() or q["suggested"]
            except EOFError: sys.exit("no answer (the input closed); nothing was written.")
            if v in (None, ""): sys.exit(f"{q['id']} needs an answer; nothing was written.")
            if q["options"] and v not in q["options"]: sys.exit(f"{v!r} is not one of {', '.join(q['options'])}; nothing was written.")
            if q["id"] == "platform_admins":
                v, bad = single_service.admin_entries(v)
                if bad or not v: sys.exit(f"{', '.join(bad) or 'nothing'} is not an email address or *@domain; nothing was written.")
            if q["id"].startswith("pack.") or q["id"] == "brand_name": answers[q["id"]] = v
            else: resolved[q["id"]] = v
    rounds = 0
    while ask and pending and rounds < 10:   # a pack answer can open the next question (a job's repository, then its commit)
        ask_all(pending); rounds += 1
        pending = plan_pack()
    def stop(qs):
        save(qfile, {"app_id": app_id, "mold_id": mold_id, "brief": os.path.relpath(brief_path, ROOT), "hints": hints,
                     "answers": {**resolved, **extra}, "pending": qs, "optional": [], "generated": TODAY})
        print(f"{len(qs)} question(s) pending -> {os.path.relpath(qfile, ROOT)}")
        for q in qs: print(f"  - {q['id']}: {q['question']}" + (f"  options={q['options']}" if q["options"] else "") + (f"  suggested={q['suggested']}" if q["suggested"] else "") + (f"  ({q['why']})" if q.get("why") else ""))
        sys.exit(2)
    if pending: stop(pending)
    if pk:
        got = write_pack(app_id, mold_id, pk, brief_path, text, answers)
        if isinstance(got, dict):
            if ask:
                ask_all([got]); got = write_pack(app_id, mold_id, pk, brief_path, text, answers)
            if isinstance(got, dict): stop([got])
        hints["packs"] = [got]
    if resolved["deploy_target"] == "vercel":
        # One project is one environment namespace: never a LIVE project, never one another app deploys to (provision.py
        # refuses both at deploy time too). The app has TWO, <name>-api and <name> (mold_v0-029): a base whose either name
        # is taken is suffixed when intake chose it, and said; a name someone answered is refused.
        taken = taken_projects(app_id); want = resolved.get("vercel_project") or slug(app_id)
        # provision.py's LIVE refusal also reads <base>-workflow (mold_v1's third name), so a base whose -workflow name is
        # a LIVE project would be refused at every deploy: intake treats it as taken too.
        live = set(live_projects().values())
        hit = lambda b: (next(((n, taken[n]) for n in (b, f"{b}-api") if n in taken), None)
                         or ((f"{b}-workflow", "one of the LIVE projects this factory never writes to (provision.py refuses any base whose "
                              "-workflow name is one)") if f"{b}-workflow" in live else None))
        if hit(want):
            name, why = hit(want)
            if "vercel_project" in answers:
                sys.exit(f"{app_id}: the Vercel project {name!r} is {why}. Answer another vercel_project. Nothing was written.")
            n = 2
            while hit(f"{want}-{n}"): n += 1
            print(f"note: the Vercel project name {name!r} is {why}, so this app's projects are {want}-{n}-api and {want}-{n} (answer vercel_project to choose another)")
            resolved["vercel_project"] = f"{want}-{n}"
    if resolved["deploy_target"] not in single_service.TARGETS:
        sys.exit(f"{app_id}: {mold_id} runs on {' or '.join(single_service.TARGETS)}, not {resolved['deploy_target']!r}. Nothing was written.")
    app, infra, ds, di = build_single(app_id, mold_id, resolved, hints, factory, brief_path, existing)
    for name, obj in (("application", app), ("infrastructure", infra), ("datastores", ds), ("datainfra", di)):
        save(os.path.join(outdir, f"{name}.json"), obj)
    if os.path.exists(qfile): os.remove(qfile)
    if not resolved.get("platform_admins"): resolved.pop("platform_admins", None)   # none recorded: asked again, never answered "nobody"
    save(os.path.join(outdir, "answers.json"), {**resolved, **extra})
    raw = load(os.path.join(ST, "factory.json"))     # the repository's file, never the merged view (see main)
    if app_id not in raw.setdefault("applications", []): raw["applications"].append(app_id); save(os.path.join(ST, "factory.json"), raw)
    P = load(os.path.join(ST, "products.json"))
    for p in P["products"]:
        if p["product_id"] == app["product_id"] and app_id not in p.setdefault("app_ids", []): p["app_ids"].append(app_id)
    save(os.path.join(ST, "products.json"), P)
    r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/scripts/factory.py"), "validate"], capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode: sys.exit(r.returncode)
    t = infra["target"]; where = infra.get(t) or {}
    print(f"state written: state/application/{app_id}/  (mold={mold_id}, target={t}, " +
          (f"compose project={where['compose']['project']}, domain={where.get('domain') or 'not named yet'}" if t == "compose_remote" else f"projects={', '.join((where.get('projects') or {}).values()) or where.get('project')}") +
          f", values you set: {', '.join(infra['secrets_user']) or 'none'}, minted at the deploy: {len(infra['secrets_derived'])}" +
          (f", platform administrators: {', '.join(app.get('platform_admins') or []) or 'none recorded (provision.py checks the target)'}" if asks_admins else "") + ")")

def main(a):
    if a and a[0] == "--self-test": return self_test(*a[1:2])
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    brief_path = os.path.abspath(a[0]); opts = a[1:]
    def opt(k, d=None): return opts[opts.index(k)+1] if k in opts else d
    app_id = opt("--app") or re.sub(r"[^a-z0-9_]+","_", os.path.basename(brief_path).split(".")[0].lower())
    text = open(brief_path).read(); hints = parse_brief(text)
    import brief_pack
    if brief_pack.has_sections(text):   # the mold comes from the prose, never from a line inside a pack section
        hints["mold_id"] = parse_brief(brief_pack.prose(text)).get("mold_id")
        if not hints["mold_id"]: hints.pop("mold_id")
    factory = load_factory(ST); d = factory.get("defaults", {})
    mold_id = opt("--mold") or hints.get("mold_id") or "mold_v1"
    known = [m.get("mold_id") for m in factory.get("molds", [])]
    if mold_id not in known:
        sys.exit(f"{app_id}: mold {mold_id!r} is not registered in state/factory.json (registered: {', '.join(known)}). "
                 f"Fix the brief's `Mold:` line or --mold. Nothing was written.")
    outdir = os.path.join(ST, "application", app_id); os.makedirs(outdir, exist_ok=True)
    existing = {n: load(os.path.join(outdir, f"{n}.json")) for n in ("application","infrastructure","datastores","datainfra") if os.path.exists(os.path.join(outdir, f"{n}.json"))}
    if single_service.manifest(mold_id, ROOT):
        if brief_pack.has_sections(text):
            # The pack sections are data for the pack, never prose hints: a field labelled "Vercel project" or a help text
            # naming a domain must not move where the app runs (mold_v0-062).
            hints = parse_brief(brief_pack.prose(text)); hints["mold_id"] = mold_id
        try: return main_single(app_id, mold_id, hints, factory, brief_path, outdir, existing, opt("--answers"), "--ask" in opts, text=text)
        except BaseException:
            # A refusal (or a failure) writes nothing: leave no empty app folder behind (factory.py validate counts it as an app missing its files).
            if not existing and os.path.isdir(outdir) and not os.listdir(outdir): os.rmdir(outdir)
            raise
    prod = pick_product(mold_id, hints, existing)
    ctx = {"app_id": app_id, "product": prod, "first_app": not [x for x in prod.get("app_ids", []) if x != app_id],
           "suffix": app_id[len(prod["product_id"])+1:] if app_id.startswith(prod["product_id"]+"_") else app_id,
           "existing_project": existing.get("infrastructure", {}).get("vercel", {}).get("project"),
           "existing_asr": (existing.get("application") or {}).get("asr") or {}}
    resolved, pending = {}, []; ctx["resolved"] = resolved   # later questions may depend on earlier answers
    if not hints.get("workspace_name") and not d.get("workspace_name"): hints["workspace_name"] = None
    answers = load(opt("--answers")) if opt("--answers") else {}
    qfile = os.path.join(outdir, "questions.json")
    if os.path.exists(qfile) and not answers:
        prev = load(qfile).get("answers", {}); answers.update(prev)
    # a pre-rename answer id (lib/legacy.py); answers.json is rewritten under the new id below
    old = legacy.has_old(answers, "operator_email")
    if old: answers.setdefault("operator_email", answers.pop(old))
    for qid, path, prompt, options, resolve in QUESTIONS:
        if qid in answers: resolved[qid] = coerce(answers[qid]); continue
        v = resolve(d, hints, ctx)
        # factory defaults are only trusted once confirmed; until then they become suggested answers
        if v is not None and (d.get("confirmed") or qid not in ("deploy_target","postgres_provider","blob_provider","inference_provider","secret_store")):
            resolved[qid] = coerce(v); continue
        q = {"id":qid,"path":path,"question":prompt,"options":options,"suggested":v}
        if qid == "deploy_target" and hints.get("deploy_target_conflict"): q["why"] = "the brief names both the vm and Vercel"
        if qid == "asr_model" and hints.get("asr_model_unknown"):
            q["why"] = f"the brief names speech model {hints['asr_model_unknown']!r}, which is not on the list"; q["suggested"] = asr.DEFAULT_MODEL
        pending.append(q)
    # The starter library is a choice people also make in state, by hand (the default went from all to none, and live
    # apps were set to none there). A re-run that only repeats the answer RECORDED at the last intake must not undo
    # that: state wins over a recorded answer that nobody gave again. A new answer, or a brief that says, still decides.
    ex_lib = ((((existing.get("application") or {}).get("surface") or {}).get("custom_workflow_builder") or {}).get("library") or {}).get("install")
    recorded = os.path.join(outdir, "answers.json")
    if ex_lib in ("all", "none") and "library" not in hints and os.path.exists(recorded) and load(recorded).get("library") == resolved.get("library") != ex_lib:
        resolved["library"] = ex_lib
    # The same for the database provider: an app moved to another provider after it was stamped (by hand, as provision.py
    # advises when a deploy cannot reach a private network) keeps its state's provider and the isolation proof measured
    # on it, when a re-run only repeats the answer recorded before the move. A new answer, or a brief that says, decides.
    ex_prov = ((existing.get("datastores") or {}).get("postgres") or {}).get("provider")
    if ex_prov and "postgres_provider" not in hints and os.path.exists(recorded) and load(recorded).get("postgres_provider") == resolved.get("postgres_provider") != ex_prov:
        resolved["postgres_provider"] = ex_prov
    # Optional questions resolved only by their default (not by an answer, the brief or the app's state) are offered.
    offered = [{"id": qid, "path": path, "question": prompt, "options": options, "suggested": resolved.get(qid)}
               for qid, path, prompt, options, _ in QUESTIONS if qid in OPTIONAL and qid in resolved and qid not in answers
               and not hints.get(qid) and not (qid == "asr_model" and ctx["existing_asr"].get("model"))]
    if "--ask" in opts:
        for q in offered:
            v = input(f"{q['question']} [{'/'.join(q['options'])}] (default: {q['suggested']}): ").strip()
            if v:
                if q["id"] == "asr_model": v = asr.normalize(v) or v     # "nova-3", "turbo", ... as well as the full id
                if qid_value_ok(q, v): resolved[q["id"]] = v
                else: sys.exit(f"{v!r} is not one of {', '.join(q['options'])}; nothing was written. Run it again and pick one, or press Enter for the default.")
        offered = []
    if "--ask" in opts and pending:
        for q in pending:
            hint = f" [{'/'.join(q['options'])}]" if q["options"] else ""
            sug = f" (default: {q['suggested']})" if q["suggested"] not in (None,"") else ""
            v = input(f"{q['question']}{hint}{sug}: ").strip() or q["suggested"]
            resolved[q["id"]] = coerce(v if v is not None else "")
        pending = []
    if pending:
        save(qfile, {"app_id":app_id,"mold_id":mold_id,"brief":os.path.relpath(brief_path, ROOT),"hints":hints,
                     "answers":{k:v for k,v in resolved.items()},"pending":pending,"optional":offered,"generated":TODAY})
        print(f"{len(pending)} question(s) pending -> {os.path.relpath(qfile, ROOT)}")
        for q in pending:
            print(f"  - {q['id']}: {q['question']}" + (f"  options={q['options']}" if q["options"] else "") + (f"  suggested={q['suggested']}" if q["suggested"] not in (None,"") else "") + (f"  ({q['why']})" if q.get("why") else ""))
        sys.exit(2)
    # vm_remote decides its own database, files and secret store (lib/vm_remote.py shape_state): whatever was answered,
    # the state holds self_hosted / fs / vm_remote_env_file. Record THAT, never an answer the state does not carry: a
    # recorded supabase beside a self_hosted state made a later real switch to supabase look like a repeat (mold_v1-231).
    if resolved.get("deploy_target") == "vm_remote":
        for qid, forced in (("postgres_provider", "self_hosted"), ("blob_provider", "fs"), ("secret_store", "vm_remote_env_file")):
            if resolved.get(qid) != forced:
                print(f"note: {qid}={resolved.get(qid)} does not apply on vm_remote (the server's own); recorded as {forced}")
                resolved[qid] = forced
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
    # Written back to the REPOSITORY's factory.json, never the merged view: `factory` carries this machine's own values
    # from state/factory.local.json (the operator's email, the mold's source, live project names), and saving it whole
    # copied them into a committed file.
    raw = load(os.path.join(ST, "factory.json")); rd = raw.setdefault("defaults", {})
    if not d.get("confirmed"):
        for k in ("deploy_target","postgres_provider","blob_provider","inference_provider","secret_store"): rd[k] = resolved[k]
        rd["confirmed"] = True
    if app_id not in raw.setdefault("applications", []): raw["applications"].append(app_id)
    save(os.path.join(ST,"factory.json"), raw)
    P = load(os.path.join(ST,"products.json"))
    for p in P["products"]:
        if p["product_id"]==app["product_id"] and app_id not in p.setdefault("app_ids", []): p["app_ids"].append(app_id)
    save(os.path.join(ST,"products.json"), P)
    r = subprocess.run([sys.executable, os.path.join(ROOT,".claude/scripts/factory.py"), "validate"], capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode: sys.exit(r.returncode)
    print(f"state written: state/application/{app_id}/  (target={infra['target']}, project={infra.get('vercel',{}).get('project','vm')}, org={app['workspace']['org']['org_id']}, corpus={len(app['surface']['primary_context']['corpus'])}, processes={len(app['surface']['multiplayer_context']['processes'])}, secrets to provide: {len(infra['secrets'])})")
    for q in offered:
        print(f"optional, left at its default: {q['id']} = {q['suggested']} ({q['question']}) To change it: put \"{q['id']}\" in answers.json and rerun with --answers.")
if __name__ == "__main__": main(sys.argv[1:])
