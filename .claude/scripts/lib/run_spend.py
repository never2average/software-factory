#!/usr/bin/env python3
"""What a mold_v0 application's runs have cost, read from its own database (mold_v0-185). READ-ONLY.

  run_spend.py <app_id> [--days 30] [--json]   one app's spend now: today, this month, the last run, each account's
                                               allowance used/limit and each kind's month budget (prints; writes nothing)
  run_spend.py --self-test                     offline: the SQL, the parsing, the figures, the masking (a stand-in psql)

Used by app_usage.py (its report for a mold_v0 app, and its --spend heartbeat). Standard library only.

WHAT IS READ. mold_v0 has no chat-turn table: an account's model spend is its runs' (and, in a build whose host pack has
them, its agent sessions'). Per the mold's own rules (src/run-spend.ts RUN_USD, src/session-engine.ts orgMonthSpendUsd,
src/run-limits.ts, src/billing.ts orgBudget, src/rate-limits.ts limitsFor):
  a run's cost      GREATEST(runs.cost_usd, the sum of its gateway_usage rows): recorded at completion, or the gateway's
                    live total while it runs. A run lands in the UTC day and month it was queued (created_at).
  month spend       the account's runs (and sessions) queued this UTC month; the allowance check adds its runs queued in
                    an earlier month that are still queued or running (liveEarlierRunSpendUsd).
  allowance         organizations.budget_override_usd when an admin set one ("override"); else the live Stripe plan's
                    (not readable here: "not measured"); else APP_ORG_MONTHLY_BUDGET_USD of the deployment ("default",
                    0 when unset: no runs).
  kind budget       per workspace and kind: min(the kind's month_budget_usd as frozen in its runs' spec, the platform's
                    kind_month_budget_usd: APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD, else the app's profile limits.runs,
                    else 200); spent = this month's runs of the kind plus its earlier runs still live (kindMonthSpendUsd).

HOW. One connection with psql (the PostgreSQL client, here on the factory machine), the app's own DATABASE_URL handed
to it as libpq's PG* variables in its environment only (never on a command line, never written, never printed), and one
transaction: BEGIN TRANSACTION READ ONLY, `SHOW transaction_read_only` must say on, the workspace list (ids and names
only) read as the login, then SET LOCAL ROLE to the mold's tenant role (app_tenant_<10 hex>, NOBYPASSRLS: refused when
it is a superuser or bypasses row-level security) and, per workspace, set_config('app.org_id', <id>, true): every figure
is read under row-level security exactly as the app's tenant work reads it. Then ROLLBACK. Only counts, money and times
leave the database: no run's data, no names of people, no addresses. Every line psql prints is scrubbed of the URL and
its password before it is parsed or shown.

  vercel (single service)  the API project's production env (vercel.projects.api) is pulled by name into a private
                           temporary folder (0700) and removed at once; of it, DATABASE_URL is passed to psql and three
                           non-secret settings are read (APP_ORG_MONTHLY_BUDGET_USD, APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD,
                           and whether STRIPE_SECRET_KEY is set at all, never its value).
  anything else            not measured, and said why.
"""
import datetime as dt, json, os, re, shutil, subprocess, sys, tempfile, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "software-factory")
PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PSQL_TIMEOUT = 45
WARN_PCT = 80                     # the board's amber, as the database check's
PLATFORM_KIND_MONTH = 200         # src/rate-limits.ts DEFAULTS.runs.kind_month_budget_usd
SETTINGS = ("APP_ORG_MONTHLY_BUDGET_USD", "APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD")   # numbers, not secrets
NUMBER = re.compile(r"^\d{1,9}(\.\d{1,6})?$")

# ---------------------------------------------------------------------------------------------------------------------
# the SQL: one READ ONLY transaction; every statement prints one JSON line
# ---------------------------------------------------------------------------------------------------------------------
TENANT_ROLES = ("SELECT t.rolname FROM pg_roles t WHERE t.rolname IN ('app_tenant_' || substr(md5(current_database()), 1, 10), "
                "'octillion_tenant_' || substr(md5(current_database()), 1, 10)) ORDER BY t.rolname LIMIT 1")
MONTH = "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')"
TODAY = "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')"
PREV = "((date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC')"
RUN_USD = "GREATEST(r.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.run_id = r.id), 0))"
ORG = "NULLIF(current_setting('app.org_id', true), '')::int"

# One workspace, as the tenant role with app.org_id set (the generator below runs it once per workspace).
WS_SQL = f"""WITH me AS (SELECT {ORG} AS org),
r AS (SELECT r.pack, r.kind, r.status, r.error_kind, r.created_at, r.started_at, r.ended_at, r.heartbeat_at, r.spec->>'month_budget_usd' AS kmb, ({RUN_USD})::float8 AS usd, r.cost_usd::float8 AS rec
        FROM runs r, me WHERE r.org_id = me.org AND (r.created_at >= least(:'since'::timestamptz, {PREV}) OR r.status IN ('queued', 'running'))),
k AS (SELECT pack, kind, count(*) FILTER (WHERE created_at >= {MONTH})::int AS runs,
             coalesce(sum(usd) FILTER (WHERE created_at >= {MONTH} OR status IN ('queued', 'running')), 0)::float8 AS usd,
             min(kmb) FILTER (WHERE kmb ~ '^[0-9]+(\\.[0-9]+)?$') AS kmb
        FROM r GROUP BY 1, 2),
w AS (SELECT pack, kind, count(*)::int AS runs, coalesce(sum(usd), 0)::float8 AS usd, coalesce(sum(rec), 0)::float8 AS rec, max(created_at) AS last FROM r WHERE created_at >= :'since'::timestamptz GROUP BY 1, 2),
d AS (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*)::int AS runs, coalesce(sum(usd), 0)::float8 AS usd, coalesce(sum(rec), 0)::float8 AS rec FROM r WHERE created_at >= :'since'::timestamptz GROUP BY 1),
l AS (SELECT r.pack, r.kind, r.status, r.error_kind, ({RUN_USD})::float8 AS usd, r.cost_usd::float8 AS rec, r.created_at, r.ended_at FROM runs r, me WHERE r.org_id = me.org ORDER BY r.created_at DESC LIMIT 1)
SELECT json_build_object('k', 'ws', 'org', (SELECT org FROM me), 'role', current_user::text,
  'role_bypasses', (SELECT p.rolsuper OR p.rolbypassrls FROM pg_roles p WHERE p.rolname = current_user),
  'read_only', current_setting('transaction_read_only'),
  'month_usd', (SELECT coalesce(sum(usd), 0)::float8 FROM r WHERE created_at >= {MONTH}),
  'month_rec_usd', (SELECT coalesce(sum(rec), 0)::float8 FROM r WHERE created_at >= {MONTH}),
  'month_runs', (SELECT count(*)::int FROM r WHERE created_at >= {MONTH}),
  'month_output_missing', (SELECT count(*)::int FROM r WHERE created_at >= {MONTH} AND status = 'failed' AND error_kind = 'output_missing'),
  'prev_usd', (SELECT coalesce(sum(usd), 0)::float8 FROM r WHERE created_at >= {PREV} AND created_at < {MONTH}),
  'prev_rec_usd', (SELECT coalesce(sum(rec), 0)::float8 FROM r WHERE created_at >= {PREV} AND created_at < {MONTH}),
  'prev_runs', (SELECT count(*)::int FROM r WHERE created_at >= {PREV} AND created_at < {MONTH}),
  'today_usd', (SELECT coalesce(sum(usd), 0)::float8 FROM r WHERE created_at >= {TODAY}),
  'today_runs', (SELECT count(*)::int FROM r WHERE created_at >= {TODAY}),
  'in_flight', (SELECT count(*)::int FROM r WHERE status IN ('queued', 'running')),
  'live_earlier_usd', (SELECT coalesce(sum(usd), 0)::float8 FROM r WHERE created_at < {MONTH} AND status IN ('queued', 'running')),
  'last_activity', (SELECT max(greatest(created_at, started_at, ended_at, heartbeat_at)) FROM r),
  'last_run', (SELECT json_build_object('pack', pack, 'kind', kind, 'status', status, 'error_kind', error_kind, 'usd', usd, 'rec', rec, 'created_at', created_at, 'ended_at', ended_at) FROM l),
  'kinds', (SELECT coalesce(json_agg(json_build_object('pack', pack, 'kind', kind, 'runs', runs, 'usd', usd, 'kmb', kmb) ORDER BY pack, kind), '[]'::json) FROM k),
  'window', (SELECT coalesce(json_agg(json_build_object('pack', pack, 'kind', kind, 'runs', runs, 'usd', usd, 'rec', rec, 'last', last) ORDER BY usd DESC, pack, kind), '[]'::json) FROM w),
  'daily', (SELECT coalesce(json_agg(json_build_object('d', d, 'runs', runs, 'usd', usd, 'rec', rec) ORDER BY d), '[]'::json) FROM d),
  'account', (SELECT json_build_object('override_usd', o.budget_override_usd::float8, 'has_billing_customer', o.stripe_customer_id IS NOT NULL) FROM organizations o, me WHERE o.id = me.org)
)::text"""

# A host pack's sessions (agent_sessions), counted in the month figure as the mold does; run only where the table has
# the two columns and the tenant role may read it.
SESS_SQL = f"""SELECT json_build_object('k', 'sess', 'org', {ORG},
  'month_usd', coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))) FILTER (WHERE s.queued_at >= {MONTH}), 0)::float8,
  'today_usd', coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))) FILTER (WHERE s.queued_at >= {TODAY}), 0)::float8,
  'prev_usd', coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))) FILTER (WHERE s.queued_at >= {PREV} AND s.queued_at < {MONTH}), 0)::float8,
  'month_sessions', count(*) FILTER (WHERE s.queued_at >= {MONTH})::int, 'last_activity', max(s.queued_at))::text
  FROM agent_sessions s WHERE s.org_id = {ORG} AND s.queued_at >= least(:'since'::timestamptz, {PREV})"""

# The generator (as the login, read only): the role switch first, then per workspace its setting and its statements.
# \\gexec runs each cell it returns as a statement, in order, in this same transaction.
GEN_SQL = f"""WITH t AS ({TENANT_ROLES}),
o AS (SELECT id FROM organizations ORDER BY id),
sess AS (SELECT to_regclass('public.agent_sessions') IS NOT NULL
           AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_sessions' AND column_name IN ('cost_usd', 'queued_at', 'org_id')) = 3
           AND has_table_privilege((SELECT rolname FROM t), to_regclass('public.agent_sessions')::oid, 'SELECT') AS ok)
SELECT s FROM (
  SELECT 0 AS id, 0 AS ord, format('SET LOCAL ROLE %I', (SELECT rolname FROM t)) AS s
  UNION ALL SELECT o.id, 1, format('SELECT set_config(%L, %L, true), set_config(%L, %L, true)', 'app.org_id', o.id::text, 'octillion.org_id', o.id::text) FROM o
  UNION ALL SELECT o.id, 2, :'ws_sql' FROM o
  UNION ALL SELECT o.id, 3, :'sess_sql' FROM o, sess WHERE sess.ok
) x ORDER BY id, ord"""

def script(since):
    """The whole psql script. `since` is an ISO time checked here (it becomes a psql variable, quoted by psql)."""
    if not re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\+00:00|Z)$", since): raise ValueError("since must be an ISO UTC time")
    def var(name, text):
        if "\n\\" in text or text.count("'") % 2: raise ValueError(name)   # nothing that could end the \set early
        return f"\\set {name} '" + text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'\n"
    return ("\\set ON_ERROR_STOP 1\n" + f"\\set since '{since}'\n" + var("ws_sql", WS_SQL.replace(":'since'", "'" + since + "'")) +
            var("sess_sql", SESS_SQL.replace(":'since'", "'" + since + "'")) +
            "BEGIN TRANSACTION READ ONLY;\n"
            "SELECT set_config('statement_timeout', '20000', true);\n"
            "SELECT json_build_object('k', 'tx', 'read_only', current_setting('transaction_read_only'))::text;\n"
            f"SELECT json_build_object('k', 'tenant', 'role', t.rolname, 'bypasses', t.rolsuper OR t.rolbypassrls)::text FROM pg_roles t WHERE t.rolname = ({TENANT_ROLES});\n"
            "SELECT json_build_object('k', 'orgs', 'orgs', coalesce(json_agg(json_build_object('id', o.id, 'name', o.name) ORDER BY o.id), '[]'::json))::text FROM organizations o;\n"
            + GEN_SQL.replace("\n", " ") + " \\gexec\n"
            "ROLLBACK;\n")

WRITES = re.compile(r"\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|merge|vacuum|call|do)\b", re.I)

# ---------------------------------------------------------------------------------------------------------------------
# the connection: DATABASE_URL -> libpq variables, psql's output scrubbed
# ---------------------------------------------------------------------------------------------------------------------
URL_CRED = re.compile(r"([a-z][a-z0-9+.-]*://)[^/\s@]+@", re.I)
LIBPQ_PARAMS = {"sslmode": "PGSSLMODE", "channel_binding": "PGCHANNELBINDING", "options": "PGOPTIONS", "sslrootcert": "PGSSLROOTCERT",
                "target_session_attrs": "PGTARGETSESSIONATTRS", "connect_timeout": "PGCONNECT_TIMEOUT", "application_name": "PGAPPNAME"}

def secrets_of(url):
    out = [url] if url else []
    try:
        p = urllib.parse.urlsplit(url)
        if p.password: out += [p.password, urllib.parse.unquote(p.password)]
    except ValueError: pass
    return [s for s in out if s and len(s) >= 6]

def scrub(text, secrets_=()):
    text = URL_CRED.sub(r"\1[redacted]@", str(text or ""))
    for v in sorted(set(secrets_), key=len, reverse=True): text = text.replace(v, "[redacted]")
    return text

def pg_env(url):
    """libpq's own variables for psql's environment (the address never goes on a command line). Raises ValueError."""
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("postgres", "postgresql") or not p.hostname: raise ValueError("DATABASE_URL is not a postgres:// address")
    env = {"PGHOST": p.hostname, "PGDATABASE": urllib.parse.unquote(p.path.lstrip("/")) or "postgres", "PGCONNECT_TIMEOUT": "15",
           "PGAPPNAME": "factory run_spend (read-only)"}
    if p.port: env["PGPORT"] = str(p.port)
    if p.username: env["PGUSER"] = urllib.parse.unquote(p.username)
    if p.password: env["PGPASSWORD"] = urllib.parse.unquote(p.password)
    for k, vals in urllib.parse.parse_qs(p.query).items():
        if k in LIBPQ_PARAMS and vals and k != "application_name": env[LIBPQ_PARAMS[k]] = vals[-1]
    env.setdefault("PGSSLMODE", "require" if p.hostname not in ("localhost", "127.0.0.1") else "prefer")
    return env

def psql_bin():
    return shutil.which("psql", path=os.environ.get("PATH", PATH))

def run_psql(url, since, run=subprocess.run, psql=None):
    """-> the raw dict the database answered, or {"error"}. Never raises; nothing secret in what it returns."""
    sec = secrets_of(url)
    psql = psql or psql_bin()
    if not psql: return {"error": "psql (the PostgreSQL client) is not installed on this machine (apt install postgresql-client)"}
    try: env = pg_env(url)
    except ValueError as e: return {"error": str(e)}
    env.update({"PATH": os.environ.get("PATH", PATH), "HOME": os.environ.get("HOME", "/root"), "PGTZ": "UTC", "LANG": "C.UTF-8"})
    try:
        r = run([psql, "-X", "-q", "-A", "-t", "-f", "-"], input=script(since), env=env, capture_output=True, text=True, timeout=PSQL_TIMEOUT)
    except subprocess.TimeoutExpired: return {"error": f"the database did not answer within {PSQL_TIMEOUT} seconds"}
    except OSError as e: return {"error": f"psql could not be started ({type(e).__name__})"}
    out, err = scrub(r.stdout, sec), scrub(r.stderr, sec)
    if r.returncode != 0:
        why = " / ".join(l.strip() for l in err.splitlines() if l.strip())[-300:] or f"exit {r.returncode}"
        return {"error": "the database could not be read: " + why}
    return parse_lines(out)

def parse_lines(out):
    """psql's JSON lines -> {"tx", "tenant", "orgs", "ws": {org: {...}}, "sess": {org: {...}}}. Other lines are ignored."""
    raw = {"ws": {}, "sess": {}}
    for line in (out or "").splitlines():
        line = line.strip()
        if not line.startswith("{"): continue
        try: d = json.loads(line)
        except ValueError: continue
        k = d.pop("k", None)
        if k in ("ws", "sess"): raw[k][str(d.get("org"))] = d
        elif k in ("tx", "tenant", "orgs"): raw[k] = d
    return raw

# ---------------------------------------------------------------------------------------------------------------------
# the figures
# ---------------------------------------------------------------------------------------------------------------------
def _usd(v): return None if v is None else round(float(v), 4)
def num_setting(v):
    v = (v or "").strip()
    return float(v) if NUMBER.match(v) else None

def level(used, limit):
    """ok / warn (at WARN_PCT) / limit (used >= limit); none: no allowance (0: no runs); None when not measured."""
    if used is None or limit is None: return None
    if limit <= 0: return "none"
    return "limit" if used >= limit else "warn" if used >= WARN_PCT / 100 * limit else "ok"

BASIS = ("a run's cost is the larger of its recorded cost (runs.cost_usd) and its gateway usage, as the mold's own allowance check counts it "
         "(src/run-spend.ts RUN_USD); month_recorded_usd is the recorded cost alone, which audit:run-events shows")

def assemble(app_id, raw, settings, profile_limits=None, now=None):
    """The raw answer -> the spend report (the heartbeat's per-app entry). A figure that cannot be measured is None and
    named in not_measured; 0 is a measured zero."""
    now = now or dt.datetime.now(dt.timezone.utc)
    month = now.strftime("%Y-%m"); nm = []
    prev = (now.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
    base = {"app_id": app_id, "measured_at": now.isoformat(timespec="seconds"), "month": month, "source": "runs", "today_usd": None, "month_usd": None,
            "month_recorded_usd": None, "prev_month": prev, "prev_month_usd": None, "today_runs": None, "month_runs": None, "month_output_missing_runs": None, "in_flight": None, "last_run": None, "last_activity": None, "accounts": [], "kinds": [], "basis": BASIS, "not_measured": nm}
    if raw.get("error"): return dict(base, error=raw["error"], not_measured=[f"every figure: {raw['error']}"])
    if (raw.get("tx") or {}).get("read_only") != "on":
        why = "refused: the transaction did not report read only, so nothing it read is used"
        return dict(base, error=why, not_measured=[f"every figure: {why}"])
    ten = raw.get("tenant")
    if not ten: return dict(base, error="the mold's tenant role (app_tenant_<hash>) is not in this database, so row-level security cannot be applied; nothing was read",
                            not_measured=["every figure: no tenant role"])
    if ten.get("bypasses"): return dict(base, error=f"refused: the tenant role {ten.get('role')} bypasses row-level security; nothing was used", not_measured=["every figure: refused"])
    orgs = (raw.get("orgs") or {}).get("orgs") or []
    stripe = bool(settings.get("stripe")); fallback = num_setting(settings.get("APP_ORG_MONTHLY_BUDGET_USD"))
    if fallback is None and settings.get("APP_ORG_MONTHLY_BUDGET_USD") in (None, ""): fallback = 0.0
    plat_kind = num_setting(settings.get("APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD")) or (profile_limits or {}).get("kind_month_budget_usd") or PLATFORM_KIND_MONTH
    tot = {"today_usd": 0.0, "month_usd": 0.0, "month_recorded_usd": 0.0, "prev_month_usd": 0.0, "today_runs": 0, "month_runs": 0, "month_output_missing_runs": 0, "in_flight": 0}
    complete = True; last = None; lastact = None
    for o in orgs:
        oid = str(o.get("id")); w = raw["ws"].get(oid); name = o.get("name") or oid
        if not w:
            complete = False; nm.append(f"{name}: its runs were not read (the query stopped before this workspace)"); continue
        if w.get("role") != ten.get("role") or w.get("role_bypasses") or w.get("read_only") != "on" or str(w.get("org")) != oid:
            complete = False; nm.append(f"{name}: refused: not read as the tenant role in a read-only transaction scoped to this workspace"); continue
        s = raw["sess"].get(oid) or {}
        month_usd = float(w.get("month_usd") or 0) + float(s.get("month_usd") or 0)
        today_usd = float(w.get("today_usd") or 0) + float(s.get("today_usd") or 0)
        prev_usd = float(w.get("prev_usd") or 0) + float(s.get("prev_usd") or 0)
        rec_usd = float(w.get("month_rec_usd") or 0) + float(s.get("month_usd") or 0)
        for k, v in (("today_usd", today_usd), ("month_usd", month_usd), ("month_recorded_usd", rec_usd), ("prev_month_usd", prev_usd), ("today_runs", w.get("today_runs") or 0), ("month_runs", w.get("month_runs") or 0), ("month_output_missing_runs", w.get("month_output_missing") or 0), ("in_flight", w.get("in_flight") or 0)):
            tot[k] += v
        lr = w.get("last_run")
        if lr and (last is None or str(lr.get("created_at")) > str(last.get("created_at"))): last = dict(lr, workspace=name)
        for t in (w.get("last_activity"), s.get("last_activity")):
            if t and (lastact is None or str(t) > lastact): lastact = str(t)
        a = w.get("account") or {}
        if a.get("override_usd") is not None: limit, src = float(a["override_usd"]), "override"
        elif stripe and a.get("has_billing_customer"): limit, src = None, "plan"
        else: limit, src = fallback, "default"
        used = month_usd + float(w.get("live_earlier_usd") or 0)
        acc = {"workspace": name, "org_id": o.get("id"), "used_usd": _usd(used), "limit_usd": _usd(limit), "source": src,
               "pct": None if limit is None or limit <= 0 else round(100 * used / limit, 1), "level": level(used, limit),
               "prev_month": {"month": prev, "used_usd": _usd(prev_usd), "runs": w.get("prev_runs"), "level": level(prev_usd, limit)}}
        if limit is None: nm.append(f"{name} allowance: set by its billing plan, which is not readable from here (the app's Billing page shows it)")
        base["accounts"].append(acc)
        for k in w.get("kinds") or []:
            if not k.get("runs") and not float(k.get("usd") or 0): continue   # no run of it this month, none still live
            kmb = num_setting(k.get("kmb")); lim = min(kmb, plat_kind) if kmb is not None else plat_kind
            base["kinds"].append({"workspace": name, "pack": k.get("pack"), "kind": k.get("kind"), "month_runs": k.get("runs"), "used_usd": _usd(k.get("usd")),
                                  "limit_usd": _usd(lim), "pct": round(100 * float(k.get("usd") or 0) / lim, 1) if lim else None, "level": level(float(k.get("usd") or 0), lim)})
        base.setdefault("_window", []).append((name, w))
    if (profile_limits or {}).get("_plans"): nm.append("kind month budgets: the profile sets per-plan limits, and a workspace's plan is not readable here; the profile's own limit is used")
    if stripe: nm.append("allowances: an account without an admin-set allowance takes its billing plan's, which is read from Stripe and not here")
    if not orgs: nm.append("workspaces: the app's database lists none")
    if complete:
        base.update({k: (_usd(v) if k.endswith("_usd") else v) for k, v in tot.items()})
    base["last_run"] = None if not last else {"workspace": last["workspace"], "kind": f"{last.get('pack')}/{last.get('kind')}", "status": last.get("status"), "error_kind": last.get("error_kind"),
                                              "cost_usd": _usd(last.get("usd")), "recorded_cost_usd": _usd(last.get("rec")), "at": last.get("ended_at") or last.get("created_at"), "queued_at": last.get("created_at")}
    base["last_activity"] = lastact
    base["accounts"].sort(key=lambda a: (-(a["pct"] or 0), a["workspace"]))
    base["kinds"].sort(key=lambda k: (-(k["used_usd"] or 0), k["workspace"], k["pack"] or "", k["kind"] or ""))
    return base

def warnings(rep):
    """One plain line per account at WARN_PCT of its allowance or over (and each kind's month budget at its limit)."""
    out = []
    for a in rep.get("accounts") or []:
        if a["level"] in ("warn", "limit"):
            out.append({"workspace": a["workspace"], "level": a["level"], "pct": a["pct"],
                        "text": f"{rep['app_id']}: the {a['workspace']} account has {'used all of' if a['level'] == 'limit' else 'used ' + format(a['pct'], 'g') + '% of'} "
                                f"its ${a['limit_usd']:,.2f} allowance for {rep['month']} (${a['used_usd']:,.2f} spent)" + (": no run can start until it is raised or the month ends" if a["level"] == "limit" else "")})
    for k in rep.get("kinds") or []:
        if k["level"] == "limit":
            out.append({"workspace": k["workspace"], "level": "limit", "pct": k["pct"], "kind": f"{k['pack']}/{k['kind']}",
                        "text": f"{rep['app_id']}: {k['pack']}/{k['kind']} runs have used the {k['workspace']} workspace's ${k['limit_usd']:,.2f} for {rep['month']} (${k['used_usd']:,.2f} spent)"})
    return out

# ---------------------------------------------------------------------------------------------------------------------
# where the address comes from
# ---------------------------------------------------------------------------------------------------------------------
def pull_vercel(project, run=subprocess.run):
    """The production env of `project`, read into a private temporary folder that is removed at once.
    -> (DATABASE_URL or None, {non-secret settings}, why-not or None)."""
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    d = tempfile.mkdtemp(prefix="spend-", dir=CACHE)
    try:
        os.chmod(d, 0o700); f = os.path.join(d, "env")
        try:
            r = run(["vercel", "env", "pull", "--yes", "--environment=production", "--project", project, f], cwd=d, capture_output=True, text=True, timeout=60)
        except (subprocess.TimeoutExpired, OSError) as e: return None, {}, f"the production settings of {project} could not be pulled from Vercel ({type(e).__name__})"
        vals = {}
        if os.path.exists(f):
            for line in open(f):
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1); vals[k.strip()] = v.strip().strip('"')
        if not vals: return None, {}, f"the production settings of {project} could not be pulled from Vercel (exit {r.returncode}; is this machine signed in to Vercel?)"
        url = vals.get("DATABASE_URL")
        settings = {k: vals.get(k, "") for k in SETTINGS}
        settings["stripe"] = bool(vals.get("STRIPE_SECRET_KEY"))   # set at all (a [SENSITIVE] marker counts); never its value
        if not url or url == "[SENSITIVE]": return None, settings, f"the Vercel project {project} has no readable DATABASE_URL in production"
        return url, settings, None
    finally:
        shutil.rmtree(d, ignore_errors=True)

def target_of(app, infra):
    """('vercel', api project) for a single-service mold_v0 app on Vercel; else (None, why)."""
    if app.get("mold_id") != "mold_v0": return None, "the run-spend reader is for mold_v0 apps (runs table)"
    if not infra.get("deployed_at"): return None, "the app is not deployed, so it has no database to read"
    if infra.get("target") == "vercel":
        api = ((infra.get("vercel") or {}).get("projects") or {}).get("api")
        return ("vercel", api) if api else (None, "state names no API project (vercel.projects.api) for this app")
    return None, f"the deploy target {infra.get('target')!r} is not one the run-spend reader reads yet (vercel)"

def profile_limits(app):
    lim = (((app.get("profile") or {}).get("limits") or {}).get("runs") or {})
    out = {"kind_month_budget_usd": lim.get("kind_month_budget_usd")} if isinstance(lim.get("kind_month_budget_usd"), (int, float)) and lim["kind_month_budget_usd"] > 0 else {}
    if ((app.get("profile") or {}).get("limits") or {}).get("plans"): out["_plans"] = True
    return out

def measure(app_id, since, state_dir=None, pull=pull_vercel, psql_run=run_psql, now=None):
    """One app: the report and the raw answer's per-workspace window rows (for app_usage's usage report)."""
    adir = os.path.join(state_dir or os.path.join(ROOT, "state", "application"), app_id)
    try:
        app = json.load(open(os.path.join(adir, "application.json"))); infra = json.load(open(os.path.join(adir, "infrastructure.json")))
    except (OSError, ValueError): return assemble(app_id, {"error": f"there is no application {app_id} in state"}, {}, now=now)
    kind, where = target_of(app, infra)
    if not kind: return assemble(app_id, {"error": where}, {}, now=now)
    url, settings, why = pull(where)
    if not url: return assemble(app_id, {"error": why}, settings, now=now)
    raw = psql_run(url, since)
    url = None   # noqa: F841 — not kept past the query
    return assemble(app_id, raw, settings, profile_limits(app), now=now)

def month_start(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    return now.strftime("%Y-%m-01T00:00:00+00:00")

# ---------------------------------------------------------------------------------------------------------------------
# self-test: no database, no Vercel
# ---------------------------------------------------------------------------------------------------------------------
FIX = os.path.join(os.path.dirname(HERE), "fixtures", "run_spend")

def self_test():
    n = 0
    def ok(c, msg):
        nonlocal n
        assert c, msg
        n += 1
    s = script("2026-10-02T00:00:00+00:00")
    ok(s.count("BEGIN TRANSACTION READ ONLY") == 1 and s.rstrip().endswith("ROLLBACK;") and "SET LOCAL ROLE %I" in s and "set_config(%L, %L, true)" in s, "one read-only transaction, the tenant role, per-workspace setting, rolled back")
    ok(not WRITES.search(re.sub(r"'[^']*'", "''", WS_SQL + SESS_SQL + GEN_SQL)), "the SQL writes nothing: " + str(WRITES.findall(WS_SQL + SESS_SQL + GEN_SQL)))
    ok("transaction_read_only" in s and "rolbypassrls" in s and "app.org_id" in s, "read-only and row-level security are checked")
    ok("email" not in (WS_SQL + SESS_SQL).lower() and "requested_by" not in WS_SQL and "r.id" not in WS_SQL.replace("g.run_id = r.id", ""), "no person and no run id leaves the database")
    try: script("2026-10-02'; drop"); ok(False, "a bad since is refused")
    except ValueError: ok(True, "")
    # the address goes to psql as libpq variables, never on its command line, and is scrubbed from what psql says
    u = "postgresql://app_login:S3cr3t%2Fpw-123@ep-x-pooler.example.neon.tech:5432/neondb?sslmode=require&channel_binding=require"
    e = pg_env(u)
    ok(e["PGPASSWORD"] == "S3cr3t/pw-123" and e["PGUSER"] == "app_login" and e["PGHOST"] == "ep-x-pooler.example.neon.tech" and e["PGDATABASE"] == "neondb"
       and e["PGSSLMODE"] == "require" and e["PGCHANNELBINDING"] == "require" and e["PGPORT"] == "5432", "pg_env: " + json.dumps({k: v for k, v in e.items() if k != "PGPASSWORD"}))
    seen = {}
    def fake(argv, **kw):
        seen.update(kw, argv=argv)
        return subprocess.CompletedProcess(argv, 0, open(os.path.join(FIX, "psql-example_app.out")).read(), "")
    raw = run_psql(u, "2026-10-02T00:00:00+00:00", run=fake, psql="/usr/bin/psql")
    ok(not any("S3cr3t" in a or "postgres" in a for a in seen["argv"]) and seen["env"]["PGPASSWORD"] == "S3cr3t/pw-123" and "DATABASE_URL" not in seen["env"] and seen["input"].startswith("\\set ON_ERROR_STOP 1"),
       "psql: address in its environment only, script on stdin")
    ok(set(raw["ws"]) == {"1", "3"} and raw["tenant"]["role"] == "app_tenant_0123456789", "parsed: " + json.dumps(raw)[:300])
    def failing(argv, **kw): return subprocess.CompletedProcess(argv, 2, "", f"psql: error: connection to server at \"h\" failed: FATAL: password authentication failed for user \"app_login\" ({u}) S3cr3t/pw-123")
    bad = run_psql(u, "2026-10-02T00:00:00+00:00", run=failing, psql="/usr/bin/psql")
    ok("S3cr3t" not in json.dumps(bad) and "password authentication failed" in bad["error"] and "[redacted]" in bad["error"], "error scrubbed: " + bad["error"])
    # the figures, from the stand-in answer (the shape of a live answer: a customer account with a $250 override, a test workspace with $50 that ran out)
    now = dt.datetime(2026, 10, 31, 7, 30, tzinfo=dt.timezone.utc)   # the day the lane-check account ran out
    rep = assemble("example_app", raw, {"APP_ORG_MONTHLY_BUDGET_USD": "", "APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD": "", "stripe": False}, {"kind_month_budget_usd": 500}, now=now)
    want = json.load(open(os.path.join(FIX, "expected-example_app.json")))
    rep.pop("_window", None)
    ok(rep == want, "assembled report differs from the fixture:\n" + json.dumps(rep, indent=2))
    # mold_v0-188: a run that failed with a required output missing is counted, its cost in the month as any run's
    om = json.loads(json.dumps(raw)); om["ws"]["3"]["month_output_missing"] = 1; om["ws"]["3"]["last_run"].update(kind="report_audit_findings", error_kind="output_missing")
    r4 = assemble("example_app", om, {"APP_ORG_MONTHLY_BUDGET_USD": "", "APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD": "", "stripe": False}, {"kind_month_budget_usd": 500}, now=now)
    ok(r4["month_output_missing_runs"] == 1 and r4["last_run"]["error_kind"] == "output_missing" and r4["month_usd"] == rep["month_usd"], "output_missing: counted, its cost in the month")
    ok("failed (output missing)" in summary_line(r4) and "1 run(s) this month failed with a required output missing" in summary_line(r4) and "output missing" not in summary_line(rep), "output_missing: said in the summary")
    lane = next(a for a in rep["accounts"] if a["workspace"] == "Lane check")
    ok(lane["level"] == "limit" and lane["limit_usd"] == 50 and lane["used_usd"] >= 50, "the lane-check account at its limit")
    w = warnings(rep)
    ok(any(x["level"] == "limit" and "Lane check" in x["text"] and "$50.00" in x["text"] for x in w), "a warning at the limit: " + json.dumps(w))
    # not measured is never $0: an unread workspace makes the totals null; a refused role makes everything null
    part = json.loads(json.dumps(raw)); part["ws"].pop("3")
    r2 = assemble("example_app", part, {}, now=now)
    ok(r2["month_usd"] is None and r2["today_usd"] is None and any("were not read" in x for x in r2["not_measured"]), "partial -> null")
    byp = json.loads(json.dumps(raw)); byp["tenant"]["bypasses"] = True
    ok(assemble("example_app", byp, {}, now=now)["error"].startswith("refused"), "bypass role refused")
    rw = json.loads(json.dumps(raw)); rw["tx"]["read_only"] = "off"
    ok(assemble("example_app", rw, {}, now=now)["month_usd"] is None, "not read only -> nothing used")
    wrong = json.loads(json.dumps(raw)); wrong["ws"]["1"]["role"] = "neondb_owner"
    r3 = assemble("example_app", wrong, {}, now=now)
    ok(r3["month_usd"] is None and any("refused" in x for x in r3["not_measured"]), "a workspace not read as the tenant role is not used")
    pl = json.loads(json.dumps(raw)); pl["ws"]["1"]["account"] = {"override_usd": None, "has_billing_customer": True}
    st = assemble("example_app", pl, {"stripe": True}, now=now)
    ok(any(a["source"] == "plan" and a["limit_usd"] is None and a["level"] is None for a in st["accounts"]) and any("Stripe" in x for x in st["not_measured"]), "a plan allowance is not measured, never $0")
    ok(level(40, 50) == "warn" and level(39.9, 50) == "ok" and level(50, 50) == "limit" and level(1, 0) == "none" and level(None, 5) is None, "levels")
    ok(next(a for a in assemble("example_app", pl, {"stripe": False, "APP_ORG_MONTHLY_BUDGET_USD": "75"}, now=now)["accounts"] if a["workspace"] == "Customer A")["limit_usd"] == 75, "no override, no billing: the deployment's default allowance")
    ok(next(a for a in assemble("example_app", pl, {}, now=now)["accounts"] if a["workspace"] == "Customer A")["level"] == "none", "no allowance at all: none (no runs), not ok")
    ok(rep["month_recorded_usd"] == 49.9143 and rep["month_usd"] == 50.0089 and rep["today_usd"] == 41.1539 and rep["last_run"]["cost_usd"] == 2.2866, "the recorded cost (audit:run-events) beside the allowance's figure")
    ok([k["kind"] for k in rep["kinds"]][:2] == ["probe_cicd_env", "refresh_soc"] and all(k["limit_usd"] == 500 for k in rep["kinds"]), "kinds: the profile's 500 under the kind's own 500")
    e2 = assemble("example_app", {"error": "x"}, {}, now=now)
    ok(e2["month_usd"] is None and e2["accounts"] == [] and e2["error"] == "x", "error report")
    # where the address comes from: the API project; anything else is said
    ok(target_of({"mold_id": "mold_v0"}, {"deployed_at": "x", "target": "vercel", "vercel": {"projects": {"api": "m-api", "web": "m"}}}) == ("vercel", "m-api"), "api project")
    ok(target_of({"mold_id": "mold_v1"}, {})[0] is None and target_of({"mold_id": "mold_v0"}, {"deployed_at": "x", "target": "compose_remote"})[0] is None, "other targets said")
    calls = []
    def fake_vercel(argv, **kw):
        calls.append((argv, kw)); open(argv[-1], "w").write('DATABASE_URL="postgres://u:pw_abcdefgh@h/db"\nAPP_ORG_MONTHLY_BUDGET_USD="0"\nSTRIPE_SECRET_KEY="[SENSITIVE]"\nOTHER="zzz"\n')
        return subprocess.CompletedProcess(argv, 0, "", "")
    url, sets, why = pull_vercel("m-api", run=fake_vercel)
    ok(url == "postgres://u:pw_abcdefgh@h/db" and sets == {"APP_ORG_MONTHLY_BUDGET_USD": "0", "APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD": "", "stripe": True} and why is None, "pull: url and three settings only")
    ok(not os.path.exists(calls[0][1]["cwd"]) and calls[0][0][:3] == ["vercel", "env", "pull"] and "--project" in calls[0][0], "the pulled file and its folder are gone")
    print(f"run_spend: {n} checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    pos = [x for i, x in enumerate(a) if not x.startswith("--") and not (i and a[i - 1] == "--days")]
    if not pos: sys.exit(__doc__)
    days = int(a[a.index("--days") + 1]) if "--days" in a else 30
    since = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=days - 1)).isoformat() + "T00:00:00+00:00"
    rep = measure(pos[0], since); rep.pop("_window", None); rep["warnings"] = warnings(rep)
    print(json.dumps(rep, indent=2) if "--json" in a else summary_line(rep)); return 0 if not rep.get("error") else 1

def money(v): return "not measured" if v is None else f"${v:,.2f}"

def summary_line(rep):
    if rep.get("error"): return f"{rep['app_id']}: not measured: {rep['error']}"
    lr = rep.get("last_run")
    L = [f"{rep['app_id']}: {money(rep['today_usd'])} today ({rep['today_runs']} runs) · {money(rep['month_usd'])} in {rep['month']} ({rep['month_runs']} runs) · {rep['in_flight']} in flight"]
    if lr: L.append(f"  last run: {lr['kind']} in {lr['workspace']}, {lr['status']}{' (' + lr['error_kind'].replace('_', ' ') + ')' if lr.get('status') == 'failed' and lr.get('error_kind') == 'output_missing' else ''}, {money(lr['cost_usd'])}, {lr['at']}")
    if rep.get("month_output_missing_runs"): L.append(f"  {rep['month_output_missing_runs']} run(s) this month failed with a required output missing (counted in the spend above)")
    for x in rep["accounts"]:
        L.append(f"  account {x['workspace']}: {money(x['used_usd'])} of {money(x['limit_usd'])} ({x['source']}{', ' + format(x['pct'], 'g') + '%' if x['pct'] is not None else ''}) {x['level'] or ''}")
    for k in rep["kinds"][:8]:
        L.append(f"  kind {k['pack']}/{k['kind']} in {k['workspace']}: {money(k['used_usd'])} of {money(k['limit_usd'])} this month ({k['month_runs']} runs)")
    for x in rep["not_measured"]: L.append(f"  not measured: {x}")
    return "\n".join(L)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
