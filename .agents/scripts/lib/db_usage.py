#!/usr/bin/env python3
"""How much of its database plan each app has used, read from the provider, and a warning before a limit is hit.

  db_usage.py <app_id> [--json]                          one app's report (prints it; writes nothing)
  db_usage.py --all [--write] [--file-tickets] [--json]  every app that is not retired
       --write          keeps each report in reports/db-usage/<app>.json (git-ignored), which the factory board reads
       --file-tickets   files one factory ticket per app and limit at WARN_AT (80%) or over, unless one is still open
  db_usage.py --self-test                                offline, against recorded answers (no network, no key)

WHY. On 2026-10-19 an app's Neon free-plan database reached its usage limit (Postgres 53000, insufficient_resources)
with no warning; the board only said "1 down". This reads the usage the provider itself reports, against the limits its
plan states, so the board can warn at 80% and name the limit and the upgrade step.

WHERE THE NUMBERS COME FROM (nothing here is ever a guessed number; what no source reports is "not measured"):
  Neon or Supabase through the Vercel Marketplace (datastores.json postgres.provider "neon"/"supabase", and the resource
      name provision.py recorded in infrastructure.json datastores.neon_resource / supabase_resource):
        GET /v1/storage/stores/<id>   (through `vercel api`, this machine's own Vercel sign-in; no key of ours)
          billingPlan            the plan in effect (scope: installation, so one plan covers every database of that
                                 provider on the team) and its stated details, e.g. "Compute time: 100 CU-hours per
                                 project", "Storage: 1 GB per project". A paid plan states prices instead: no fixed limit.
          billingDataV2.usage    what the provider reported for this resource this billing period (Neon: "Compute",
                                 in hours). Supabase reports none.
          usageQuotaExceeded     the provider's own "a limit is reached" flag.
        GET /v1/integrations/integration/<slug>/products/<slug>/plans   the plans on offer, for the upgrade step.
      Measured on 2026-10-20: Neon reports compute only; storage and data transfer are not in Vercel's answer.
  Neon's own API, when this machine has a Neon API key: GET https://console.neon.tech/api/v2/projects/<project id>
        (the project id is the store's externalResourceId) gives compute_time_seconds, synthetic_storage_size and
        data_transfer_bytes for the current period, which also measures storage. The key is referenced BY NAME only:
        datastores.json postgres.usage_key_ref (default NEON_API_KEY), read from this process's environment or from
        ~/.config/software-factory/db-usage.env (NAME=value, mode 0600, written by the operator). The value is sent
        to Neon in one header and is never printed, logged or written anywhere.
  A self-hosted database (provider self_hosted, on the app's own server): not measured here; its disk is the server's,
        checked by `provision.py <app> --capacity`.

Compute: Vercel labels Neon's figure "hours" and the free plan's limit "CU-hours"; Neon bills compute in CU-hours, so
the two are compared and the report says so in the limit's note.

Exit: 0 done (warnings included), 2 bad input. Standard library only.
"""
import argparse, contextlib, fcntl, io, json, os, re, subprocess, sys, tempfile, urllib.error, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
STATE = os.path.join(ROOT, "state")
REPORTS = os.path.join(ROOT, "reports", "db-usage")
KEY_FILE = os.path.expanduser("~/.config/software-factory/db-usage.env")
NEON_API = "https://console.neon.tech/api/v2"
WARN_AT = 0.80
CALL_TIMEOUT_S = 60
PROVIDER_WORDS = {"neon": "Neon", "supabase": "Supabase"}
RESOURCE_KEY = {"neon": "neon_resource", "supabase": "supabase_resource"}
# Plan details that are not a limit on one database's use (a team-wide count, the largest size on offer).
NOT_USAGE_LIMITS = ("maximum projects", "sizes up to")
# A plan limit's label -> the usage item that measures it (first word, lower case).
USAGE_FOR = {"compute": "compute", "storage": "storage", "data": "data transfer", "written": "written data"}
SAME_UNITS = {("hours", "cu-hours"), ("cu-hours", "cu-hours"), ("hours", "hours"), ("gb", "gb")}


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---- the provider's answers (each source is a function, so --self-test replaces them) ---------------------------------

def _json_after_brace(text):
    try:
        return json.loads(text[text.index("{"):])
    except ValueError:
        return None


def vercel_api(path, team=None):
    """One read through `vercel api` with this machine's Vercel sign-in. None when it fails; its output is never shown."""
    cmd = ["vercel", "api", path, "--raw"] + (["--scope", team] if team else [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=CALL_TIMEOUT_S, cwd=tempfile.gettempdir())
    except (OSError, subprocess.TimeoutExpired):
        return None
    return _json_after_brace(r.stdout or "") if r.returncode == 0 else None


def vercel_resources(team=None):
    """Every Marketplace resource on the team: [{id, name, product, status, ...}], or None when it cannot be read."""
    cmd = ["vercel", "integration", "list", "--all", "--json"] + (["--scope", team] if team else [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=CALL_TIMEOUT_S, cwd=tempfile.gettempdir())
    except (OSError, subprocess.TimeoutExpired):
        return None
    data = _json_after_brace(r.stdout or "")
    return data.get("resources") if isinstance(data, dict) else None


def key_by_name(name, env=None, key_file=KEY_FILE):
    """The value of the credential NAMED `name`: the environment first, then the operator's 0600 file. Never printed."""
    env = os.environ if env is None else env
    if env.get(name):
        return env[name]
    try:
        with open(key_file) as f:
            for line in f:
                k, _, v = line.strip().partition("=")
                if k.strip() == name and v.strip():
                    return v.strip().strip('"')
    except OSError:
        pass
    return None


def neon_project(project_id, key):
    """(project dict, None) or (None, why) from Neon's API. The key goes in one header; an error names only a status."""
    req = urllib.request.Request(f"{NEON_API}/projects/{project_id}",
                                 headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=CALL_TIMEOUT_S) as r:
            return (json.loads(r.read().decode("utf-8", "replace")).get("project") or {}), None
    except urllib.error.HTTPError as e:
        return None, f"Neon's API answered HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — a failed read is a reason, never a crash
        return None, f"Neon's API could not be reached ({type(e).__name__})"


# ---- reading the answers --------------------------------------------------------------------------------------------

AMOUNT = re.compile(r"^\s*([0-9][0-9.,]*)\s*([A-Za-z][A-Za-z\-]*)")


def parse_amount(text):
    """'100 CU-hours per project' -> (100.0, 'CU-hours'); a price ('$0.35 per GB-month') or no number -> None."""
    m = AMOUNT.match(str(text or ""))
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "")), m.group(2)
    except ValueError:
        return None


def plan_limits(plan):
    """The numeric per-database limits a plan states: [{name, limit, unit, text}]."""
    out = []
    for d in (plan or {}).get("details") or []:
        label, value = str(d.get("label") or ""), str(d.get("value") or "")
        if not label or label.lower() in NOT_USAGE_LIMITS:
            continue
        amt = parse_amount(value)
        if amt:
            out.append({"name": label, "limit": amt[0], "unit": amt[1], "text": value})
    return out


def _usage_items(store):
    v2 = ((store.get("billingDataV2") or {}).get("usage") or {})
    items = v2.get("items")
    if items is None:
        items = (store.get("billingData") or {}).get("usage")
    period = {"start": v2.get("periodStart") or (store.get("billingData") or {}).get("periodStart"),
              "end": v2.get("periodEnd") or (store.get("billingData") or {}).get("periodEnd")}
    return [{"name": str(i.get("name") or ""), "value": i.get("periodValue"), "unit": str(i.get("units") or "")}
            for i in (items or []) if isinstance(i.get("periodValue"), (int, float))], period


def _neon_usage(project):
    """Neon API project -> usage items in the plan's units. Only fields Neon sent; nothing filled in."""
    out = []
    if isinstance(project.get("compute_time_seconds"), (int, float)):
        out.append({"name": "Compute", "value": project["compute_time_seconds"] / 3600, "unit": "CU-hours", "source": "neon"})
    if isinstance(project.get("synthetic_storage_size"), (int, float)):
        out.append({"name": "Storage", "value": project["synthetic_storage_size"] / 1e9, "unit": "GB", "source": "neon"})
    if isinstance(project.get("data_transfer_bytes"), (int, float)):
        out.append({"name": "Data transfer", "value": project["data_transfer_bytes"] / 1e9, "unit": "GB", "source": "neon"})
    return out


def _match(limit, items):
    word = limit["name"].lower().split()[0]
    want = USAGE_FOR.get(word, word)
    for i in items:
        if i["name"].lower().startswith(want):
            return i
    return None


def next_plan(plans, current_id):
    """The plan after the current one in the provider's own order, or None."""
    ids = [p.get("id") for p in plans or []]
    if current_id in ids and ids.index(current_id) + 1 < len(ids):
        return plans[ids.index(current_id) + 1]
    return None


def upgrade_step(provider, plan, nxt):
    word = PROVIDER_WORDS.get(provider, provider)
    if not nxt:
        return f"Move to a bigger {word} plan in Vercel (Integrations → {word}). A paid plan needs the operator's yes."
    paid = " (paid)" if nxt.get("paymentMethodRequired") else ""
    return (f"Change the {word} plan from {plan.get('name', '?')} to {nxt.get('name', '?')}{paid} in Vercel "
            f"(Integrations → {word} → change plan). The plan covers every {word} database on the team. "
            f"Spending needs the operator's yes.")


def assess(app_id, provider, resource, store, plans, neon=None, neon_why=None):
    """The report for one Marketplace database from the provider's answers. Pure: the self-test drives it directly."""
    plan = store.get("billingPlan") or {}
    items, period = _usage_items(store)
    if neon:
        items = _neon_usage(neon) + [i for i in items if not any(n["name"] == i["name"] for n in _neon_usage(neon))]
    limits, not_measured = [], []
    stated = plan_limits(plan)
    word = PROVIDER_WORDS.get(provider, provider)
    if not stated:
        not_measured.append(f"the {word} {plan.get('name') or '?'} plan states no fixed usage limit"
                            + (" (billed per use)" if plan.get("paymentMethodRequired") else ""))
    for lim in stated:
        got = _match(lim, items)
        if not got:
            not_measured.append(f"{lim['name']} ({lim['text']}): the provider reports no figure for it"
                                + ("" if neon or provider != "neon" else "; a Neon API key would measure it"))
            continue
        units = (got["unit"].lower(), lim["unit"].lower())
        if units not in SAME_UNITS:
            not_measured.append(f"{lim['name']}: used is in {got['unit']}, the limit in {lim['unit']}; not compared")
            continue
        used = got["value"]
        row = {"name": lim["name"], "limit": lim["limit"], "unit": lim["unit"], "used": round(used, 3),
               "pct": round(100 * used / lim["limit"], 1) if lim["limit"] else None, "source": got.get("source", "vercel")}
        if units[0] != units[1]:
            row["note"] = f"the provider reports {got['unit']}; the plan's limit is in {lim['unit']}"
        limits.append(row)
    if neon_why:
        not_measured.append(neon_why)
    nxt = next_plan(plans, plan.get("id"))
    step = upgrade_step(provider, plan, nxt)
    exceeded = store.get("usageQuotaExceeded") if isinstance(store.get("usageQuotaExceeded"), bool) else None
    plan_words = f"{word} {plan.get('name') or '?'} plan"
    warnings = []
    if exceeded:
        warnings.append({"limit": "usage quota", "pct": None, "level": "limit",
                         "text": f"{app_id}: the {plan_words} says a usage limit is REACHED; the database refuses work. {step}"})
    for lim in limits:
        if lim["pct"] is not None and lim["pct"] >= WARN_AT * 100:
            level = "limit" if lim["pct"] >= 100 else "warn"
            warnings.append({"limit": lim["name"], "pct": lim["pct"], "level": level,
                             "text": (f"{app_id}: database at {lim['pct']:g}% of the {plan_words}'s {lim['name'].lower()} limit "
                                      f"({lim['used']:g} of {lim['limit']:g} {lim['unit']}). {step}")})
    return {
        "app_id": app_id, "generated_at": now_iso(), "provider": provider, "resource": resource, "via": "vercel_integration",
        "plan": {"id": plan.get("id"), "name": plan.get("name"), "paid": bool(plan.get("paymentMethodRequired"))} if plan else None,
        "period": period, "quota_exceeded": exceeded, "limits": limits,
        "usage": [{"name": i["name"], "value": round(i["value"], 3), "unit": i["unit"]} for i in items],
        "not_measured": not_measured, "warnings": warnings, "upgrade": step if warnings else "",
    }


def _blank(app_id, provider, why, resource=None):
    return {"app_id": app_id, "generated_at": now_iso(), "provider": provider, "resource": resource, "via": None, "plan": None,
            "period": None, "quota_exceeded": None, "limits": [], "usage": [], "not_measured": [why], "warnings": [], "upgrade": ""}


# ---- one app ----------------------------------------------------------------------------------------------------------

def _load(path):
    with open(path) as f:
        return json.load(f)


class Sources:
    """The calls that leave this machine. --self-test swaps in recorded answers."""
    api = staticmethod(vercel_api)
    resources = staticmethod(vercel_resources)
    neon = staticmethod(neon_project)
    key = staticmethod(key_by_name)


def measure(app_id, state_dir=STATE, src=Sources, cache=None):
    """The usage report for one app; never raises for a provider that cannot be read (that is 'not measured')."""
    cache = {} if cache is None else cache
    d = os.path.join(state_dir, "application", app_id)
    try:
        application = _load(os.path.join(d, "application.json"))
        infra = _load(os.path.join(d, "infrastructure.json"))
    except (OSError, ValueError):
        return _blank(app_id, None, "no application.json / infrastructure.json for this app")
    try:
        ds = _load(os.path.join(d, "datastores.json"))
    except (OSError, ValueError):
        ds = {}
    pg = ds.get("postgres") or {}
    provider = str(pg.get("provider") or "")
    if application.get("status") == "retired":
        return _blank(app_id, provider or None, "retired: not measured")
    if provider == "self_hosted" or infra.get("target") == "vm_remote":
        return _blank(app_id, provider or None, "the database runs on the app's own server: not measured here "
                      f"(its disk is the server's: python3 .claude/scripts/provision.py {app_id} --capacity)")
    if provider not in RESOURCE_KEY:
        return _blank(app_id, provider or None, f"no usage source for the provider {provider or '(none recorded)'}")
    resource = (infra.get("datastores") or {}).get(RESOURCE_KEY[provider])
    if not resource:
        return _blank(app_id, provider, f"no {PROVIDER_WORDS[provider]} resource recorded in infrastructure.json "
                      f"(datastores.{RESOURCE_KEY[provider]})")
    team = (infra.get("vercel") or {}).get("team") or None
    if ("resources", team) not in cache:
        cache[("resources", team)] = src.resources(team)
    listed = cache[("resources", team)]
    if listed is None:
        return _blank(app_id, provider, "Vercel's list of databases could not be read (is this machine signed in to Vercel?)", resource)
    match = [r for r in listed if r.get("name") == resource and str(r.get("product", "")).lower() == provider]
    if not match:
        return _blank(app_id, provider, f"the {PROVIDER_WORDS[provider]} resource '{resource}' is not on the Vercel team", resource)
    got = src.api(f"/v1/storage/stores/{match[0]['id']}", team)
    store = (got or {}).get("store") if isinstance(got, dict) else None
    if not store:
        return _blank(app_id, provider, f"Vercel did not answer for the resource '{resource}'", resource)
    slug = ((store.get("product") or {}).get("slug")) or provider
    if ("plans", slug, team) not in cache:
        p = src.api(f"/v1/integrations/integration/{slug}/products/{slug}/plans", team)
        cache[("plans", slug, team)] = (p or {}).get("plans") or [] if isinstance(p, dict) else []
    neon, neon_why = None, None
    if provider == "neon":
        key_name = str(pg.get("usage_key_ref") or "NEON_API_KEY")
        key = src.key(key_name)
        if key and store.get("externalResourceId"):
            neon, neon_why = src.neon(store["externalResourceId"], key)
            if neon_why:
                neon_why = f"{neon_why} for {key_name}; storage and data transfer not measured"
    return assess(app_id, provider, resource, store, cache[("plans", slug, team)], neon, neon_why)


def app_ids(state_dir=STATE):
    base = os.path.join(state_dir, "application")
    out = []
    for a in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        if a == "app_id" or not os.path.isfile(os.path.join(base, a, "application.json")):
            continue
        try:
            if _load(os.path.join(base, a, "application.json")).get("status") == "retired":
                continue
        except (OSError, ValueError):
            continue
        out.append(a)
    return out


# ---- a ticket at the threshold -----------------------------------------------------------------------------------------

TITLE_LEAD = "Database usage: {app} "


def ticket_title(w, app_id):
    if w["pct"] is None:
        return f"Database usage: {app_id} reached its plan's usage limit; upgrade the plan"
    return f"Database usage: {app_id} at {w['pct']:g}% of its plan's {w['limit'].lower()} limit; upgrade before it stops"


def file_tickets(report, state_dir=STATE, factory_py=None):
    """One open ticket per app and limit: filed through factory.py add (its own record shape and numbering), skipped while
    an open ticket for the same app and limit exists. Returns the ids filed."""
    if not report.get("warnings"):
        return []
    app_id = report["app_id"]
    try:
        application = _load(os.path.join(state_dir, "application", app_id, "application.json"))
    except (OSError, ValueError):
        return []
    mold = application.get("mold_id")
    if not mold:
        return []
    sys.path.insert(0, os.path.dirname(HERE))
    import factory  # noqa: E402 — the factory CLI's own add, pointed at this state directory
    factory.ST = state_dir
    # Two board sessions can run this at once: one at a time reads the open tickets and adds, so none is filed twice.
    lock_dir = os.path.join(os.path.dirname(os.path.abspath(state_dir)), ".runs")
    os.makedirs(lock_dir, exist_ok=True)
    with open(os.path.join(lock_dir, "db-usage.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _file_locked(report, application, mold, factory)


def _file_locked(report, application, mold, factory):
    app_id = report["app_id"]
    lead = TITLE_LEAD.format(app=app_id)
    open_titles = [t.get("title", "") for t in factory.read_tasks(mold) if t.get("status") in ("todo", "in_progress", "blocked")]
    filed = []
    for w in report["warnings"]:
        limit_word = "usage limit" if w["pct"] is None else w["limit"].lower()
        if any(t.startswith(lead) and limit_word in t for t in open_titles):
            continue
        args = [mold, ticket_title(w, app_id), "--type", "infra", "--pri", "1" if w["level"] == "limit" else "2",
                "--accept", "The plan is upgraded (operator's yes) or the usage is brought under 80%",
                "--accept", w["text"]]
        product = application.get("product_id")
        if product and any(p.get("product_id") == product and p.get("mold_id") == mold
                           for p in factory.products().get("products", [])):
            args += ["--product", product]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                factory.cmd_add(args)
        except (SystemExit, IndexError, KeyError, OSError, ValueError) as e:
            print(f"could not file a ticket for {app_id} on {mold}: {e}", file=sys.stderr)
            continue
        filed.append(out.getvalue().strip())
        open_titles.append(args[1])
    return filed


# ---- CLI -----------------------------------------------------------------------------------------------------------------

def line(report):
    lim = [f"{x['name'].lower()} {x['used']:g}/{x['limit']:g} {x['unit']} ({x['pct']:g}%)" for x in report["limits"]]
    plan = report.get("plan") or {}
    head = f"{report['app_id']}: " + (f"{PROVIDER_WORDS.get(report['provider'], report['provider'])} {plan.get('name')}" if plan else
                                      str(report.get("provider") or "no database"))
    parts = [head] + lim + [f"not measured: {x}" for x in report["not_measured"]]
    return " · ".join(parts)


def main(argv):
    ap = argparse.ArgumentParser(description="Database plan usage per app (read from the provider).")
    ap.add_argument("app", nargs="?")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--file-tickets", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    if not a.all and not a.app:
        ap.print_usage(sys.stderr)
        return 2
    if a.app and not os.path.isdir(os.path.join(STATE, "application", a.app)):
        print(f"no app {a.app} in state/application", file=sys.stderr)
        return 2
    cache, reports, filed = {}, [], []
    for app_id in (app_ids() if a.all else [a.app]):
        r = measure(app_id, cache=cache)
        reports.append(r)
        if a.write:
            os.makedirs(REPORTS, exist_ok=True)
            with open(os.path.join(REPORTS, f"{app_id}.json"), "w") as f:
                json.dump(r, f, indent=2)
        if a.file_tickets:
            filed += file_tickets(r)
    if a.json:
        print(json.dumps({"reports": reports, "tickets_filed": filed}, indent=2))
    else:
        for r in reports:
            print(line(r))
            for w in r["warnings"]:
                print(f"  WARNING {w['text']}")
        for t in filed:
            print(f"filed {t}")
    return 0


# ---- self-test (offline) ---------------------------------------------------------------------------------------------------

# The shapes Vercel answered on 2026-10-20 (ids and names replaced), trimmed to the fields read.
FREE_PLAN = {"id": "free_v3", "name": "Free", "scope": "installation", "paymentMethodRequired": False,
             "details": [{"label": "Storage", "value": "1 GB per project"}, {"label": "Maximum projects", "value": "100"},
                         {"label": "Sizes up to", "value": "2 CU, 8 GB RAM"},
                         {"label": "Compute time", "value": "100 CU-hours per project"}]}
LAUNCH_PLAN = {"id": "launch_v3", "name": "Launch", "scope": "installation", "paymentMethodRequired": True,
               "details": [{"label": "Storage", "value": "$0.35 per GB-month"}, {"label": "Maximum projects", "value": "100"},
                           {"label": "Sizes up to", "value": "16 CU, 64 GB RAM"},
                           {"label": "Compute time", "value": "$0.106 per CU-hour"}]}
PLANS = [FREE_PLAN, LAUNCH_PLAN, {"id": "scale_v3", "name": "Scale", "paymentMethodRequired": True, "details": []}]


def _store(plan, compute_hours=None, exceeded=False, product="neon"):
    usage = {"periodStart": "2026-10-01T00:00:00Z", "periodEnd": "2026-11-01T00:00:00Z",
             "items": [] if compute_hours is None else [{"name": "Compute", "type": "total", "units": "hours",
                                                         "dayValue": 1.0, "periodValue": compute_hours}]}
    return {"id": "store_a", "name": "demo-db", "usageQuotaExceeded": exceeded, "externalResourceId": "proj-a",
            "product": {"slug": product, "name": PROVIDER_WORDS[product]}, "billingPlan": plan,
            "billingDataV2": {"usage": usage}}


def self_test():
    fails = []

    def check(name, cond):
        print(("ok   " if cond else "FAIL ") + name)
        if not cond:
            fails.append(name)

    check("a stated limit is read with its unit", parse_amount("100 CU-hours per project") == (100.0, "CU-hours"))
    check("a price is not a limit", parse_amount("$0.35 per GB-month") is None)
    check("the free plan's per-database limits, not the team count or the size on offer",
          [x["name"] for x in plan_limits(FREE_PLAN)] == ["Storage", "Compute time"])
    check("a paid plan states no fixed limit", plan_limits(LAUNCH_PLAN) == [])

    r = assess("demo", "neon", "demo-db", _store(FREE_PLAN, 85.25), PLANS)
    check("compute is compared with the free plan's limit", [(x["name"], x["used"], x["limit"], x["pct"]) for x in r["limits"]]
          == [("Compute time", 85.25, 100.0, 85.2)])
    check("the hours / CU-hours comparison says so", "CU-hours" in r["limits"][0].get("note", ""))
    check("storage is not measured without a Neon key, and says how to measure it",
          any(x.startswith("Storage (1 GB per project)") and "Neon API key" in x for x in r["not_measured"]))
    check("85% warns, naming the limit and the upgrade step",
          len(r["warnings"]) == 1 and r["warnings"][0]["level"] == "warn"
          and "compute time limit (85.25 of 100 CU-hours)" in r["warnings"][0]["text"]
          and "from Free to Launch (paid)" in r["warnings"][0]["text"])
    r79 = assess("demo", "neon", "demo-db", _store(FREE_PLAN, 79.9), PLANS)
    check("79.9% does not warn", r79["warnings"] == [] and r79["upgrade"] == "")
    r100 = assess("demo", "neon", "demo-db", _store(FREE_PLAN, 100.0), PLANS)
    check("100% is a limit-level warning", r100["warnings"][0]["level"] == "limit")
    rx = assess("demo", "neon", "demo-db", _store(FREE_PLAN, None, exceeded=True), PLANS)
    check("the provider's own 'quota exceeded' flag warns even with no figure",
          rx["quota_exceeded"] is True and rx["warnings"][0]["pct"] is None and "REACHED" in rx["warnings"][0]["text"])
    check("with no figure, compute is not measured (never 0)",
          rx["limits"] == [] and any(x.startswith("Compute time") for x in rx["not_measured"]))
    rl = assess("demo", "neon", "demo-db", _store(LAUNCH_PLAN, 4.08), PLANS)
    check("a paid plan: usage shown, no limit, no warning",
          rl["limits"] == [] and rl["warnings"] == [] and rl["usage"] == [{"name": "Compute", "value": 4.08, "unit": "hours"}]
          and any("billed per use" in x for x in rl["not_measured"]))
    rn = assess("demo", "neon", "demo-db", _store(FREE_PLAN, 10.0), PLANS,
                neon={"compute_time_seconds": 90 * 3600, "synthetic_storage_size": 950_000_000, "data_transfer_bytes": 1})
    check("Neon's own API measures storage and its compute wins over Vercel's",
          [(x["name"], x["pct"], x["source"]) for x in rn["limits"]] == [("Storage", 95.0, "neon"), ("Compute time", 90.0, "neon")]
          and len(rn["warnings"]) == 2)
    rs = assess("demo", "supabase", "demo-sb", _store({"id": "free", "name": "Supabase Free Plan", "details": []}, product="supabase"),
                [{"id": "free"}, {"id": "pro", "name": "Supabase Pro Plan", "paymentMethodRequired": True}])
    check("Supabase reports no usage: not measured, no number",
          rs["limits"] == [] and rs["usage"] == [] and rs["warnings"] == [] and rs["not_measured"])

    # measure(): state on disk, every outside call recorded; the key is used by name and never appears in the report
    with tempfile.TemporaryDirectory() as tmp:
        st = os.path.join(tmp, "state")
        os.makedirs(os.path.join(st, "tasks"))

        def app(name, provider, infra, status="stamped"):
            d = os.path.join(st, "application", name)
            os.makedirs(d)
            json.dump({"mold_id": "mold_x", "status": status, "product_id": "px"}, open(os.path.join(d, "application.json"), "w"))
            json.dump(infra, open(os.path.join(d, "infrastructure.json"), "w"))
            json.dump({"postgres": {"provider": provider, "usage_key_ref": "DEMO_NEON_KEY"}}, open(os.path.join(d, "datastores.json"), "w"))

        app("hot", "neon", {"target": "vercel", "vercel": {"team": "t"}, "datastores": {"neon_resource": "hot-db"}})
        app("own", "self_hosted", {"target": "vm_remote"})
        app("none", "neon", {"target": "vercel", "vercel": {}})
        app("old", "neon", {"target": "vercel"}, status="retired")
        json.dump({"products": [{"product_id": "px", "mold_id": "mold_x", "stage": "deployed", "app_ids": ["hot"]}]},
                  open(os.path.join(st, "products.json"), "w"))
        json.dump({"molds": [{"mold_id": "mold_x"}]}, open(os.path.join(st, "factory.json"), "w"))
        open(os.path.join(st, "tasks", "mold_x.jsonl"), "w").write(
            json.dumps({"task_id": "mold_x-007", "mold_id": "mold_x", "title": "older", "type": "build", "status": "done",
                        "priority": 2, "owner": "fable"}) + "\n")
        calls, secret = [], "sk-not-a-real-key-0123456789"

        class Fake(Sources):
            @staticmethod
            def resources(team):
                calls.append(("list", team))
                return [{"id": "store_hot", "name": "hot-db", "product": "Neon"}]

            @staticmethod
            def api(path, team):
                calls.append(("api", path))
                if path == "/v1/storage/stores/store_hot":
                    return {"store": _store(FREE_PLAN, 82.0)}
                if path.endswith("/plans"):
                    return {"plans": PLANS}
                return None

            @staticmethod
            def key(name):
                calls.append(("key", name))
                return secret if name == "DEMO_NEON_KEY" else None

            @staticmethod
            def neon(project_id, key):
                calls.append(("neon", project_id, key == secret))
                return None, "Neon's API answered HTTP 401"

        check("the app list skips retired apps and the template", app_ids(st) == ["hot", "none", "own"])
        hot = measure("hot", st, Fake)
        check("a Vercel-integrated Neon app is measured from its store", hot["limits"][0]["pct"] == 82.0 and hot["warnings"])
        check("the Neon key is looked up by the name in datastores.json and passed only to Neon's call",
              ("key", "DEMO_NEON_KEY") in calls and ("neon", "proj-a", True) in calls)
        check("a refused Neon key is a reason, naming the key's NAME, never its value",
              any("HTTP 401 for DEMO_NEON_KEY" in x for x in hot["not_measured"]) and secret not in json.dumps(hot))
        check("the team scope is used", ("list", "t") in calls)
        check("a self-hosted database is not measured here, with where to look",
              "--capacity" in measure("own", st, Fake)["not_measured"][0])
        app("cloud", "rds", {"target": "vercel"})
        check("a provider with no usage source is not measured, by name",
              measure("cloud", st, Fake)["not_measured"] == ["no usage source for the provider rds"])
        check("an app with no recorded resource says so", "datastores.neon_resource" in measure("none", st, Fake)["not_measured"][0])

        class Down(Fake):
            @staticmethod
            def resources(team):
                return None
        check("Vercel unreadable: not measured, no number", measure("hot", st, Down, cache={})["limits"] == [])

        filed = file_tickets(hot, st)
        tasks = [json.loads(x) for x in open(os.path.join(st, "tasks", "mold_x.jsonl")) if x.strip()]
        check("a warning files one ticket, through factory.py add's own numbering",
              filed == ["mold_x-008"] and tasks[-1]["title"].startswith("Database usage: hot at 82% ")
              and tasks[-1]["type"] == "infra" and tasks[-1]["product_id"] == "px" and tasks[-1]["status"] == "todo")
        check("while it is open, the next run files nothing", file_tickets(hot, st) == [])
        check("a report without warnings files nothing", file_tickets(measure("own", st, Fake), st) == [])

        kf = os.path.join(tmp, "db-usage.env")
        open(kf, "w").write("OTHER=x\nDEMO_NEON_KEY=from-file\n")
        check("a key is read by name from the environment first, then the operator's file",
              key_by_name("DEMO_NEON_KEY", {"DEMO_NEON_KEY": "from-env"}, kf) == "from-env"
              and key_by_name("DEMO_NEON_KEY", {}, kf) == "from-file" and key_by_name("MISSING", {}, kf) is None)
    print(f"\n{len(fails)} failed" if fails else "\nall passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
