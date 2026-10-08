#!/usr/bin/env python3
"""app_usage.py <app_id> [--days 30] [--json]   |   --all [--days 30] [--json]   |   --self-test

Rough usage analytics and in-app ticket counts, read from each deployed application's OWN database.

  <app_id>    writes reports/usage/<app_id>.json; prints a short summary, or the report itself with --json
  --all       every application in state/application whose status is not `retired`; one failing app never stops
              the others (each runs in its own process, 90 s each). With --json prints a JSON list of the reports.
  --days N    the window: the last N calendar days in UTC, today included (default 30, at most 365)

STRICTLY READ-ONLY. The query runs as the application's own role (app_rw, the DATABASE_URL the app itself uses),
refused outright if that role is a superuser or bypasses row-level security, inside READ ONLY transactions, one
workspace at a time with set_config('app.org_id', ...), so row-level security decides what is visible exactly as it
does for the app. Workspaces come from the app's `orgs` table (control plane: readable before a workspace is chosen),
or, if that cannot be read, from state (application.json workspace.org and seed/orgs/*.json).

  vercel      the production DATABASE_URL is pulled by name (clone.pull_env, never printed or written) and the query
              runs here with node and the `postgres` package from build/<app_id>, as mint_report.running_app does.
  vm_remote   over SSH (lib/vm_remote.py settings + ssh_argv). THIS FILE is sent on stdin to `python3 -` on the
              server, which reads the API service's env file /etc/software-factory/<app>/api.env as root and runs
              node from the app's directory AS THE API'S USER with DATABASE_URL alone in its environment. Only the
              counts come back; any value of that file is scrubbed from whatever is printed.

by_agent: one row per workspace for the main agent (chat_turn_usage: turns) and one per specialist (automation_runs of
type workflow, named by the app's workflows.name: runs). by_user: one row per signed-in person per workspace, named by
the app's people_roster name, else `Member N` numbered by when they joined (org_members); never an address. A
person's workflow runs are those whose run_key session (<workflow>:<session>:<turn>) has that person as its owner in
agent_session_owners (a child session inherits its parent's owner). Both: sorted by turns/runs or chat turns,
descending, at most 50 rows; each row names its workspace.

Only counts leave the database: email addresses are held in the query process's memory to count distinct people
and never printed. Field meanings (and how ticket statuses are folded) are in FIELD_NOTES and TICKET_FOLD below; a
field that cannot be measured is null and named in `not_measured`, never a guess. 0 is a measured zero.
"""
import base64, concurrent.futures, datetime as dt, glob, json, os, re, signal, subprocess, sys

HERE_FILE = os.path.abspath(globals().get("__file__") or "app_usage.py")   # no __file__ when sent to `python3 -` on a server
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE_FILE)))
S_DIR = os.path.join(ROOT, ".claude", "scripts")
OUT_DIR = os.path.join(ROOT, "reports", "usage")
TIMEOUT = 90                       # seconds per app, everything included
DEFAULT_DAYS, MAX_DAYS = 30, 365
PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# The app's ticket statuses (agent/lib/customer-schema.ts ticketStatusSchema), folded into three. `done` is exactly
# the app's own closed set (agent/lib/system-of-record.ts CLOSED_TICKET_STATUSES); anything not closed is open to the
# app, so a status outside this table counts as open too, and is named.
TICKET_FOLD = {
    "Open": "open", "Needs Triage": "open", "Reopened": "open",
    "In Progress": "in_progress", "Blocked": "in_progress", "Waiting on Customer": "in_progress",
    "Waiting on Eng": "in_progress", "Waiting on Vendor": "in_progress", "Mitigated": "in_progress", "Monitoring": "in_progress",
    "Resolved": "done", "Closed": "done", "Won't Fix": "done",
}
TICKET_NOTE = ("tickets: the app's own in-app tickets table, every ticket as it stands now (not only those opened in the window). "
               "Statuses folded: open = Open, Needs Triage, Reopened; in_progress = In Progress, Blocked, Waiting on Customer, "
               "Waiting on Eng, Waiting on Vendor, Mitigated, Monitoring; done = Resolved, Closed, Won't Fix (the app's own closed set)")
SCOPE_NOTES = [
    "input_tokens, output_tokens, cost_usd: chat turns only (chat_turn_usage); workflow (subagent) tokens are not in them, workflow money is workflow_cost_usd",
    "cost_usd: not stored by the app; estimated from the turns' tokens at the app's own price table (lib/inference-pricing.ts), the same way its usage page does",
    "workflow_runs: automation_runs rows of type workflow (subagent runs) started in the window; schedules, system crons, connector syncs and browser runs are not counted",
]
ROW_CAP = 50
NUM = ("people_active", "chats", "chat_turns", "input_tokens", "output_tokens", "cost_usd", "workflow_runs", "workflow_cost_usd")

# ---------------------------------------------------------------------------------------------------------
# the query: node + the app's own `postgres` package, as the app's own role. Prints ONE JSON line of counts.
# ---------------------------------------------------------------------------------------------------------
QUERY_JS = r"""
import pg from 'postgres';
import { pathToFileURL } from 'node:url';
setTimeout(() => { console.log(JSON.stringify({ error: 'the database did not answer within 75 seconds' })); process.exit(3); }, 75000).unref();
const A = JSON.parse(process.env.SF_USAGE_ARGS);
const sql = pg(process.env.DATABASE_URL, { max: 1, connect_timeout: 20, idle_timeout: 5, prepare: false, onnotice: () => {} });
const why = (e) => String((e && e.code ? e.code + ' ' : '') + ((e && e.message) || e)).slice(0, 200);
const ro = (org, fn) => sql.begin('read only', async (t) => {
  await t`select set_config('statement_timeout', '20000', true)`;
  if (org !== null) await t`select set_config('app.org_id', ${org}, true)`;
  return fn(t);
});
let price = null;
try { price = (await import(pathToFileURL(process.cwd() + '/lib/inference-pricing.ts').href)).estimateCostUsd; } catch (e) { price = null; }
const out = { pricing: typeof price === 'function', workspaces: [], daily_people: {} };
try {
  const [r] = await ro(null, (t) => t`select current_user as role, r.rolsuper as su, r.rolbypassrls as bypass from pg_roles r where r.rolname = current_user`);
  out.role = r.role;
  if (r.su || r.bypass) {
    console.log(JSON.stringify({ error: `refused: the app's connection role ${r.role} bypasses row-level security, so it is not the app role; nothing was read` }));
    await sql.end(); process.exit(0);
  }
  let listed = null;
  try { listed = await ro(null, (t) => t`select org_id, name from orgs order by org_id`); } catch (e) { out.orgs_error = why(e); }
  const orgs = new Map();
  if (listed && listed.length) { for (const o of listed) orgs.set(o.org_id, o.name); out.orgs_from = 'orgs table'; }
  else { for (const o of A.orgs) orgs.set(o.org_id, o.name || o.org_id); out.orgs_from = 'state'; }
  out.state_orgs_missing = listed && listed.length ? A.orgs.map((o) => o.org_id).filter((id) => !orgs.has(id)) : [];
  const all = new Set(); const perDay = {};
  for (const [org, name] of orgs) {
    const w = { org_id: org, name, errors: {} };
    const q = async (field, fn) => { try { return await ro(org, fn); } catch (e) { w.errors[field] = why(e); return null; } };
    const since = A.since;
    const byModel = await q('chat', (t) => t`select model, count(*)::int as turns, coalesce(sum(input_tokens),0)::text as inp,
        coalesce(sum(output_tokens),0)::text as outp, coalesce(sum(cache_read_tokens),0)::text as cr, coalesce(sum(cache_write_tokens),0)::text as cw
        from chat_turn_usage where org_id = ${org} and started_at >= ${since}::timestamptz group by model`);
    const chats = await q('chat', (t) => t`select count(distinct eve_session_id)::int as n from chat_turn_usage where org_id = ${org} and started_at >= ${since}::timestamptz`);
    const days = await q('chat', (t) => t`select to_char(started_at at time zone 'UTC', 'YYYY-MM-DD') as d, lower(actor_email) as e, count(*)::int as n
        from chat_turn_usage where org_id = ${org} and started_at >= ${since}::timestamptz group by 1, 2`);
    if (byModel && chats && days) {
      w.chat_turns = 0; w.input_tokens = 0; w.output_tokens = 0; w.cost_usd = 0; w.unpriced_turns = 0;
      for (const g of byModel) {
        const tk = { inputTokens: Number(g.inp), outputTokens: Number(g.outp), cacheReadTokens: Number(g.cr), cacheWriteTokens: Number(g.cw) };
        w.chat_turns += g.turns; w.input_tokens += tk.inputTokens; w.output_tokens += tk.outputTokens;
        const c = price ? price(g.model, tk) : null;
        if (c === null || c === undefined) w.unpriced_turns += g.turns; else w.cost_usd += c;
      }
      w.chats = chats[0].n;
      const people = new Set(); w.daily = {}; w.turns_no_person = 0;
      for (const r of days) {
        const d = (w.daily[r.d] ||= { turns: 0, people: 0 }); d.turns += r.n;
        if (!r.e) { w.turns_no_person += r.n; continue; }
        d.people += 1; people.add(r.e); all.add(r.e); (perDay[r.d] ||= new Set()).add(r.e);
      }
      w.people_active = people.size;
    }
    const wf = await q('workflow', (t) => t`select count(*)::int as runs, coalesce(sum(cost_usd),0)::float8 as cost,
        count(*) filter (where coalesce(cost_usd,0) = 0 and coalesce(input_tokens,0) + coalesce(output_tokens,0) > 0)::int as uncosted, coalesce(sum(input_tokens),0)::text as inp, coalesce(sum(output_tokens),0)::text as outp
        from automation_runs where org_id = ${org} and automation_type = 'workflow' and started_at >= ${since}::timestamptz`);
    if (wf) { w.workflow_runs = wf[0].runs; w.workflow_cost_usd = wf[0].cost; w.workflow_uncosted = wf[0].uncosted;
      w.workflow_input_tokens = Number(wf[0].inp); w.workflow_output_tokens = Number(wf[0].outp); }
    const tk = await q('tickets', (t) => t`select ticket_status as s, count(*)::int as n from tickets where org_id = ${org} group by 1`);
    if (tk) { w.tickets_by_status = {}; for (const r of tk) w.tickets_by_status[r.s] = r.n; }
    // ---- by agent and by user (aggregates only; emails stay in this process and are replaced by display names) ----
    w.berr = {};
    const b = async (field, fn) => { try { return await ro(org, fn); } catch (e) { w.berr[field] = why(e); return null; } };
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const lastChat = await b('main', (t) => t`select max(started_at) as last from chat_turn_usage where org_id = ${org} and started_at >= ${since}::timestamptz`);
    w.by_agent = [];
    if (byModel && chats && days && lastChat && w.chat_turns > 0) {
      w.by_agent.push({ agent: 'main agent', kind: 'main', turns: w.chat_turns, runs: null, input_tokens: w.input_tokens, output_tokens: w.output_tokens,
        cost_usd: w.unpriced_turns || !price ? null : w.cost_usd, unpriced_turns: w.unpriced_turns, last_active: iso(lastChat[0].last) });
    } else if (!(byModel && chats && days && lastChat)) w.berr.main ||= w.errors.chat || 'the chat usage table could not be read';
    const spec = await b('specialists', (t) => t`select coalesce(f.name, 'workflow ' || left(r.automation_id, 8)) as name, count(*)::int as runs,
        coalesce(sum(r.cost_usd),0)::float8 as cost, coalesce(sum(r.input_tokens),0)::text as inp, coalesce(sum(r.output_tokens),0)::text as outp,
        count(*) filter (where coalesce(r.cost_usd,0) = 0 and coalesce(r.input_tokens,0) + coalesce(r.output_tokens,0) > 0)::int as uncosted, max(r.started_at) as last
        from automation_runs r left join workflows f on f.id::text = r.automation_id and f.org_id = r.org_id
        where r.org_id = ${org} and r.automation_type = 'workflow' and r.started_at >= ${since}::timestamptz group by 1`);
    for (const r of spec || []) w.by_agent.push({ agent: r.name, kind: 'specialist', turns: null, runs: r.runs, input_tokens: Number(r.inp),
      output_tokens: Number(r.outp), cost_usd: r.cost, uncosted: r.uncosted, last_active: iso(r.last) });
    // per person: chat turns by model (to price them), chats, and the workflow runs their sessions started
    const uModel = await b('users', (t) => t`select lower(actor_email) as e, model, count(*)::int as turns, coalesce(sum(input_tokens),0)::text as inp,
        coalesce(sum(output_tokens),0)::text as outp, coalesce(sum(cache_read_tokens),0)::text as cr, coalesce(sum(cache_write_tokens),0)::text as cw, max(started_at) as last
        from chat_turn_usage where org_id = ${org} and started_at >= ${since}::timestamptz and actor_email is not null group by 1, 2`);
    const uChats = await b('users', (t) => t`select lower(actor_email) as e, count(distinct eve_session_id)::int as n
        from chat_turn_usage where org_id = ${org} and started_at >= ${since}::timestamptz and actor_email is not null group by 1`);
    // run_key = <workflow>:<child session>:<turn>; a child session's owner row carries its parent's (the person's) owner.
    const uRuns = await b('user_runs', (t) => t`select case when o.owner_kind = 'person' then lower(o.owner_email) end as e, count(*)::int as n, max(r.started_at) as last
        from automation_runs r left join agent_session_owners o on r.run_key like '%:%:%' and o.session_id = split_part(r.run_key, ':', 2) and o.org_id = r.org_id
        where r.org_id = ${org} and r.automation_type = 'workflow' and r.started_at >= ${since}::timestamptz group by 1`);
    const roster = await b('names', (t) => t`select lower(email) as e, name from people_roster where org_id = ${org}`);
    const members = await b('names', (t) => t`select lower(email) as e from org_members where org_id = ${org} order by created_at, lower(email)`);
    w.by_user = [];
    if (uModel && uChats) {
      const P = new Map();
      const get = (e) => P.get(e) || P.set(e, { chats: 0, chat_turns: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_turns: 0, workflow_runs: uRuns ? 0 : null, last: null }).get(e);
      const later = (a, c) => (!a || (c && new Date(c) > new Date(a)) ? c : a);
      for (const r of uModel) {
        const p = get(r.e); const tk = { inputTokens: Number(r.inp), outputTokens: Number(r.outp), cacheReadTokens: Number(r.cr), cacheWriteTokens: Number(r.cw) };
        p.chat_turns += r.turns; p.input_tokens += tk.inputTokens; p.output_tokens += tk.outputTokens; p.last = later(p.last, r.last);
        const c = price ? price(r.model, tk) : null;
        if (c === null || c === undefined) p.unpriced_turns += r.turns; else p.cost_usd += c;
      }
      for (const r of uChats) get(r.e).chats = r.n;
      w.user_runs_unattributed = 0;
      for (const r of uRuns || []) { if (!r.e) { w.user_runs_unattributed += r.n; continue; } const p = get(r.e); p.workflow_runs = r.n; p.last = later(p.last, r.last); }
      // display names: the roster's name; never an address. Without one: Member N, by when they joined the workspace.
      const named = new Map(); for (const r of roster || []) if (r.name && r.name.trim() && !r.name.includes('@')) named.set(r.e, r.name.trim());
      const order = (members || []).map((r) => r.e).filter((e) => !named.has(e));
      const guests = [...P.keys()].filter((e) => !named.has(e) && !order.includes(e)).sort();
      const num = new Map([...order, ...guests].map((e, i) => [e, i + 1]));
      for (const [e, p] of P) w.by_user.push({ user: named.get(e) || `Member ${num.get(e)}`, unnamed: !named.has(e), chats: p.chats, chat_turns: p.chat_turns,
        input_tokens: p.input_tokens, output_tokens: p.output_tokens, cost_usd: p.unpriced_turns || !price ? null : p.cost_usd, unpriced_turns: p.unpriced_turns,
        workflow_runs: p.workflow_runs, last_active: iso(p.last) });
    }
    out.workspaces.push(w);
  }
  out.people_active = all.size;
  for (const [d, s] of Object.entries(perDay)) out.daily_people[d] = s.size;
} catch (e) { out.error = 'the database could not be read: ' + why(e); }
console.log(JSON.stringify(out));
await sql.end({ timeout: 5 });
"""

# ---------------------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------------------
def load(p): return json.load(open(p))
def now_iso(): return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

def window(days, today=None):
    """The last `days` calendar days in UTC, today included: (dates, since-ISO)."""
    today = today or dt.datetime.now(dt.timezone.utc).date()
    dates = [(today - dt.timedelta(days=days - 1 - i)).isoformat() for i in range(days)]
    return dates, dates[0] + "T00:00:00+00:00"

URL_CRED = re.compile(r"([a-z][a-z0-9+.-]*://)[^/\s@]+@", re.I)
def scrub(text, secrets_=()):
    """Remove every given value (longest first) and any user:password@ out of a line before it is shown anywhere."""
    text = URL_CRED.sub(r"\1[redacted]@", str(text or ""))
    for v in sorted((s for s in secrets_ if s and len(s) >= 8), key=len, reverse=True): text = text.replace(v, "[redacted]")
    return text

def url_secrets(url):
    """The URL and its password, for scrub()."""
    out = [url] if url else []
    m = re.match(r"^[a-z][a-z0-9+.-]*://[^:/@]*:([^@]*)@", url or "", re.I)
    if m and m.group(1): out.append(m.group(1))
    return out

def state_orgs(adir):
    """Workspaces named in state: the brief's own workspace and seed/orgs/*.json. [{org_id, name}]"""
    seen = {}
    try:
        org = ((load(os.path.join(adir, "application.json")).get("workspace") or {}).get("org") or {})
        if org.get("org_id"): seen[org["org_id"]] = org.get("name") or org["org_id"]
    except (OSError, ValueError): pass
    for p in sorted(glob.glob(os.path.join(adir, "seed", "orgs", "*.json"))):
        try: d = load(p)
        except (OSError, ValueError): continue
        oid = d.get("org_id") if isinstance(d, dict) else None
        if oid: seen.setdefault(oid, d.get("name") or oid)
    return [{"org_id": k, "name": v} for k, v in seen.items()]

def apps_to_run(state_dir):
    """Every application in state whose status is not retired (the template directory has no application.json)."""
    out = []
    for adir in sorted(glob.glob(os.path.join(state_dir, "*"))):
        p = os.path.join(adir, "application.json")
        if not os.path.isfile(p): continue
        try: st = load(p).get("status")
        except (OSError, ValueError): st = None
        if st != "retired": out.append(os.path.basename(adir))
    return out

# ---------------------------------------------------------------------------------------------------------
# the report: raw counts in, the contract out
# ---------------------------------------------------------------------------------------------------------
def fold_tickets(by_status):
    t = {"open": 0, "in_progress": 0, "done": 0, "total": 0}; unknown = {}
    for s, n in (by_status or {}).items():
        k = TICKET_FOLD.get(s)
        if k is None: k = "open"; unknown[s] = unknown.get(s, 0) + n
        t[k] += n; t["total"] += n
    return t, unknown

def empty_fields():
    return {**{k: None for k in NUM}, "tickets": {"open": None, "in_progress": None, "done": None, "total": None}}

def error_report(app_id, days, target, why):
    return {"app_id": app_id, "generated_at": now_iso(), "days": days, "target": target, "totals": empty_fields(),
            "workspaces": [], "daily": [], "by_agent": [], "by_user": [], "not_measured": [f"every field: {why}"], "error": why}

def _usd(v): return None if v is None else round(float(v), 4)

def breakdowns(raw_workspaces):
    """by_agent and by_user across workspaces: rows named by agent or by display name (never an address), each with its
    workspace, sorted by turns (runs for a specialist) or chat turns, descending, at most ROW_CAP each. -> (agents, users, notes)"""
    agents, users, nm = [], [], []
    BERR = {"main": "by_agent main agent", "specialists": "by_agent specialists", "users": "by_user",
            "user_runs": "by_user workflow_runs", "names": "by_user names"}
    for w in raw_workspaces:
        ws, org = w.get("name") or w.get("org_id"), w.get("org_id")
        for field, msg in sorted((w.get("berr") or {}).items()):
            if field == "user_runs": continue          # said once below, and only where someone's row carries the null
            nm.append(f"{BERR.get(field, field)} ({org}): could not be read: {msg}" + (" (everyone without a name in a readable record is shown as Member N)" if field == "names" else ""))
        for a in w.get("by_agent") or []:
            row = {"agent": a.get("agent"), "kind": a.get("kind"), "workspace": ws, "turns": a.get("turns"), "runs": a.get("runs"),
                   "input_tokens": a.get("input_tokens"), "output_tokens": a.get("output_tokens"), "cost_usd": _usd(a.get("cost_usd")), "last_active": a.get("last_active")}
            if a.get("kind") == "main" and row["cost_usd"] is None:
                nm.append(f"by_agent main agent cost_usd ({org}): " + (f"{a.get('unpriced_turns')} turn(s) on a model the app's price table does not price" if a.get("unpriced_turns") else "the app's price table could not be loaded"))
            if a.get("kind") == "specialist" and a.get("uncosted"):
                if not float(a.get("cost_usd") or 0):
                    row["cost_usd"] = None
                    nm.append(f"by_agent {a.get('agent')} cost_usd ({org}): {a['uncosted']} of {a.get('runs')} run(s) used the model and none recorded a cost")
                else:
                    nm.append(f"by_agent {a.get('agent')} cost_usd ({org}): {a['uncosted']} of {a.get('runs')} run(s) used the model but recorded no cost; the figure is the recorded cost only")
            agents.append(row)
        unnamed = 0
        for u in w.get("by_user") or []:
            unnamed += bool(u.get("unnamed"))
            if u.get("cost_usd") is None:
                nm.append(f"by_user {u.get('user')} cost_usd ({org}): " + (f"{u.get('unpriced_turns')} turn(s) on a model the app's price table does not price" if u.get("unpriced_turns") else "the app's price table could not be loaded"))
            users.append({"user": u.get("user"), "workspace": ws, "chats": u.get("chats"), "chat_turns": u.get("chat_turns"), "input_tokens": u.get("input_tokens"),
                          "output_tokens": u.get("output_tokens"), "cost_usd": _usd(u.get("cost_usd")), "workflow_runs": u.get("workflow_runs"), "last_active": u.get("last_active")})
        if unnamed: nm.append(f"by_user ({org}): {unnamed} person(s) have no display name in the app's people records and are shown as Member N, numbered by when they joined the workspace")
        if w.get("user_runs_unattributed"):
            nm.append(f"by_user workflow_runs ({org}): {w['user_runs_unattributed']} workflow run(s) could not be traced to a signed-in person (no session owner recorded, or started by a service) and are in no one's count")
        if w.get("by_user") and "user_runs" in (w.get("berr") or {}):
            nm.append(f"by_user workflow_runs ({org}): null, because the session owners table that ties a run to the person who started it could not be read ({w['berr']['user_runs']})")
    def order(rows, n):
        """n(row) descending; ties by most recently active, then by name. Stable sorts, last key first."""
        rows.sort(key=lambda r: str(r.get("agent") or r.get("user")))
        rows.sort(key=lambda r: r.get("last_active") or "", reverse=True)
        rows.sort(key=lambda r: n(r) if n(r) is not None else -1, reverse=True)
    order(agents, lambda r: r["turns"] if r["turns"] is not None else r["runs"])
    order(users, lambda r: r["chat_turns"])
    for name, rows in (("by_agent", agents), ("by_user", users)):
        if len(rows) > ROW_CAP: nm.append(f"{name}: {len(rows)} rows; only the first {ROW_CAP} are shown")
    if agents or users:
        nm.append("by_agent: turns is the main agent's measure (chat turns) and runs a specialist's (workflow runs); the other is null, not applicable. Specialist names are the app's workflow names")
        nm.append("by_user: people who sent a chat turn or started a workflow run in the window, named from the app's people roster; email addresses are never shown")
    return agents[:ROW_CAP], users[:ROW_CAP], nm

def assemble(app_id, days, target, raw, dates, generated_at=None):
    """The raw counts the query printed -> the report the plugin reads."""
    if raw.get("error"): return error_report(app_id, days, target, raw["error"])
    nm, ws = [], []
    pricing = bool(raw.get("pricing"))
    for w in raw.get("workspaces") or []:
        e = w.get("errors") or {}
        f = empty_fields()
        f.update({"org_id": w.get("org_id"), "name": w.get("name")})
        if "chat" not in e:
            for k in ("people_active", "chats", "chat_turns", "input_tokens", "output_tokens"): f[k] = int(w.get(k) or 0)
            f["cost_usd"] = round(float(w.get("cost_usd") or 0), 4) if pricing and not w.get("unpriced_turns") else None
        if "workflow" not in e:
            f["workflow_runs"] = int(w.get("workflow_runs") or 0)
            # A run that used tokens but recorded $0 is not a free run: the app opens every row at 0 and adds the
            # provider's cost only when the provider reports one (agent/lib/workflow-usage.ts), and Workers AI does not.
            # Runs with no tokens and $0 made no model call, so their $0 is real.
            none_costed = int(w.get("workflow_uncosted") or 0) > 0 and not float(w.get("workflow_cost_usd") or 0)
            f["workflow_cost_usd"] = None if none_costed else round(float(w.get("workflow_cost_usd") or 0), 4)
        if "tickets" not in e:
            f["tickets"], unknown = fold_tickets(w.get("tickets_by_status"))
            if unknown: nm.append(f"tickets ({w.get('org_id')}): " + ", ".join(f"{n} with status '{s}'" for s, n in sorted(unknown.items())) + " are not one of the app's statuses and are counted as open")
        for field, msg in sorted(e.items()):
            what = {"chat": "people_active, chats, chat_turns, input_tokens, output_tokens, cost_usd", "workflow": "workflow_runs, workflow_cost_usd", "tickets": "tickets"}.get(field, field)
            nm.append(f"{what} ({w.get('org_id')}): the table could not be read: {msg}")
        if "chat" not in e and f["cost_usd"] is None:
            nm.append(f"cost_usd ({w.get('org_id')}): " + (f"{w.get('unpriced_turns')} chat turn(s) ran on a model the app's price table does not price (or recorded none), so no total is given" if pricing else "the app's price table (lib/inference-pricing.ts) could not be loaded"))
        if "chat" not in e and w.get("turns_no_person"):
            nm.append(f"people_active ({w.get('org_id')}): {w['turns_no_person']} chat turn(s) recorded no signed-in person and are not attributed to anyone")
        if "workflow" not in e and w.get("workflow_uncosted"):
            tok = f"; they used {int(w.get('workflow_input_tokens') or 0):,} input and {int(w.get('workflow_output_tokens') or 0):,} output tokens (the run table records no model, so they are not priced here)"
            if f["workflow_cost_usd"] is None:
                nm.append(f"workflow_cost_usd ({w.get('org_id')}): {w['workflow_uncosted']} of {f['workflow_runs']} workflow run(s) used the model and none recorded a cost (the app adds a cost only when the model provider reports one, and it did not){tok}")
            else:
                nm.append(f"workflow_cost_usd ({w.get('org_id')}): {w['workflow_uncosted']} of {f['workflow_runs']} workflow run(s) used the model but recorded no cost; the figure is the recorded cost only{tok}")
        f["_daily"] = w.get("daily") if "chat" not in e else None
        ws.append(f)
    if not ws: nm.append("workspaces: the app's database lists no workspace and state names none")
    if raw.get("orgs_error"): nm.append(f"workspaces: the orgs table could not be read ({raw['orgs_error']}); the workspaces named in state were used")
    if raw.get("state_orgs_missing"): nm.append("workspaces: named in state but not in the app's database, so not counted: " + ", ".join(raw["state_orgs_missing"]))
    tot = empty_fields()
    for k in NUM:
        vals = [w[k] for w in ws]
        if k == "people_active": tot[k] = int(raw.get("people_active") or 0) if all(v is not None for v in vals) else None
        elif all(v is not None for v in vals): tot[k] = round(sum(vals), 4) if k.endswith("_usd") else sum(vals)
    if all(w["tickets"]["total"] is not None for w in ws):
        tot["tickets"] = {k: sum(w["tickets"][k] for w in ws) for k in ("open", "in_progress", "done", "total")}
    chat_ok = all(w["_daily"] is not None for w in ws)
    dp = raw.get("daily_people") or {}
    daily = [{"date": d, "chat_turns": sum((w["_daily"].get(d) or {}).get("turns", 0) for w in ws) if chat_ok else None,
              "people_active": int(dp.get(d, 0)) if chat_ok else None} for d in dates]
    for w in ws: w.pop("_daily")
    by_agent, by_user, bnm = breakdowns(raw.get("workspaces") or [])
    nm = [TICKET_NOTE] + SCOPE_NOTES + nm + bnm
    return {"app_id": app_id, "generated_at": generated_at or now_iso(), "days": days, "target": target, "totals": tot,
            "workspaces": [{"org_id": w.pop("org_id"), "name": w.pop("name"), **w} for w in ws], "daily": daily,
            "by_agent": by_agent, "by_user": by_user, "not_measured": nm}

# ---------------------------------------------------------------------------------------------------------
# running the query
# ---------------------------------------------------------------------------------------------------------
def parse_last_json(stdout):
    for line in reversed((stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try: return json.loads(line)
            except ValueError: continue
    return None

def run_node(cwd, env, secrets_, timeout=80, run=subprocess.run, user_kw=None):
    """Run QUERY_JS in `cwd` (where the app's `postgres` package is). Returns the raw dict; on failure {"error"}."""
    try:
        r = run(["node", "--input-type=module", "--disable-warning=ExperimentalWarning", "-e", QUERY_JS], cwd=cwd, env=env,
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, **(user_kw or {}))
    except subprocess.TimeoutExpired: return {"error": f"the query did not finish within {timeout} seconds"}
    except OSError as e: return {"error": f"node could not be started ({type(e).__name__})"}
    doc = parse_last_json(r.stdout)
    if doc is None:
        tail = " / ".join(l for l in scrub((r.stderr or "") + "\n" + (r.stdout or ""), secrets_).splitlines() if l.strip())[-300:]
        return {"error": "the query did not finish: " + (tail or f"exit {r.returncode}, nothing printed")}
    return json.loads(scrub(json.dumps(doc), secrets_))

def query_vercel(app_id, infra, args):
    sys.path.insert(0, S_DIR); import clone
    build = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(os.path.join(build, "node_modules", "postgres")):
        return {"error": f"build/{app_id} with its node_modules is not on this machine, so there is nothing to run the query with"}
    project = (infra.get("vercel") or {}).get("project")
    if not project: return {"error": "state names no Vercel project for this app"}
    try: url = clone.pull_env(project, build).get("DATABASE_URL")
    except SystemExit: url = None
    except Exception as e: return {"error": f"the production settings could not be pulled from Vercel ({type(e).__name__})"}
    if not url: return {"error": f"the Vercel project {project} has no DATABASE_URL in production"}
    env = {"PATH": os.environ.get("PATH", PATH), "HOME": os.environ.get("HOME", "/root"), "DATABASE_URL": url, "SF_USAGE_ARGS": json.dumps(args)}
    return run_node(build, env, url_secrets(url))

def remote_argv(app_id, app, infra, ds, args):
    """The one SSH command for a vm_remote app. Nothing secret is on it: the env file is read on the server."""
    sys.path.insert(0, os.path.join(S_DIR, "lib")); import vm_remote
    S = vm_remote.settings(app_id, app, infra, ds)
    spec = {"env_file": S["env_files"]["api"], "user": vm_remote.SERVICE_USERS["api"], "home": vm_remote.SERVICE_HOMES["api"],
            "app_dir": S["app_dir"], "args": args}
    b64 = base64.b64encode(json.dumps(spec).encode()).decode()
    return S, vm_remote.ssh_argv(S, f"{S['sudo']}python3 - remote {b64}")

def query_vm_remote(app_id, app, infra, ds, args, run=subprocess.run, have_key=os.path.isfile):
    S, argv = remote_argv(app_id, app, infra, ds, args)
    if not S["host"]: return {"error": "state has no server address for this app"}
    if not S["key_ref"] or not have_key(os.path.join(os.path.expanduser("~"), ".ssh", S["key_ref"])):
        return {"error": f"there is no SSH key named {S['key_ref'] or '(none)'} on this machine"}
    try: r = run(argv, input=open(HERE_FILE).read(), capture_output=True, text=True, timeout=TIMEOUT - 5)
    except subprocess.TimeoutExpired: return {"error": f"the server did not answer within {TIMEOUT - 5} seconds"}
    doc = parse_last_json(r.stdout)
    if doc is None:
        tail = scrub(((r.stderr or r.stdout or "").strip().splitlines() or [f"exit {r.returncode}"])[-1])[:300]
        return {"error": "the query on the server did not finish: " + tail}
    return doc

def remote_main(b64):
    """ON THE SERVER, as root: read the API service's env file, run the query as the API's user. Prints one JSON line."""
    import pwd
    spec = json.loads(base64.b64decode(b64))
    vals = {}
    try:
        for line in open(spec["env_file"]).read().splitlines():
            if not line.strip() or line.lstrip().startswith("#") or "=" not in line: continue
            k, v = line.split("=", 1); v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": v = v[1:-1]
            vals[k.strip()] = v
    except OSError as e:
        print(json.dumps({"error": f"the API service's env file could not be read on the server ({type(e).__name__})"})); return 0
    if not vals.get("DATABASE_URL"):
        print(json.dumps({"error": "the API service's env file has no DATABASE_URL"})); return 0
    try: pw = pwd.getpwnam(spec["user"])
    except KeyError: print(json.dumps({"error": f"the server has no user {spec['user']}"})); return 0
    kw = dict(user=pw.pw_uid, group=pw.pw_gid, extra_groups=os.getgrouplist(spec["user"], pw.pw_gid)) if os.getuid() == 0 else {}
    env = {"PATH": PATH, "HOME": spec["home"], "LANG": "C.UTF-8", "NODE_ENV": "production", "DATABASE_URL": vals["DATABASE_URL"],
           "SF_USAGE_ARGS": json.dumps(spec["args"])}
    if vals.get("DATABASE_SSL"): env["DATABASE_SSL"] = vals["DATABASE_SSL"]
    doc = run_node(spec["app_dir"], env, list(vals.values()) + url_secrets(vals["DATABASE_URL"]), timeout=78, user_kw=kw)
    print(scrub(json.dumps(doc), list(vals.values()))); return 0

# ---------------------------------------------------------------------------------------------------------
# one app, all apps
# ---------------------------------------------------------------------------------------------------------
class TimeUp(Exception): pass

def collect(app_id, days):
    adir = os.path.join(ROOT, "state", "application", app_id)
    if not os.path.isfile(os.path.join(adir, "application.json")):
        return error_report(app_id, days, None, f"there is no application {app_id} in state")
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    ds = load(os.path.join(adir, "datastores.json")) if os.path.isfile(os.path.join(adir, "datastores.json")) else {}
    target = infra.get("target")
    if not infra.get("deployed_at"): return error_report(app_id, days, target, "the app is not deployed, so it has no database to read")
    dates, since = window(days)
    args = {"orgs": state_orgs(adir), "since": since, "days": days}
    def on_alarm(*_): raise TimeUp()
    old = signal.signal(signal.SIGALRM, on_alarm); signal.alarm(TIMEOUT - 5)
    try:
        if target == "vercel": raw = query_vercel(app_id, infra, args)
        elif target == "vm_remote": raw = query_vm_remote(app_id, app, infra, ds, args)
        else: raw = {"error": f"the deploy target {target!r} is not one this script reads (vercel, vm_remote)"}
    except TimeUp: raw = {"error": f"the app did not answer within {TIMEOUT} seconds"}
    finally: signal.alarm(0); signal.signal(signal.SIGALRM, old)
    return assemble(app_id, days, target, raw, dates)

def write(rep):
    os.makedirs(OUT_DIR, exist_ok=True)
    p = os.path.join(OUT_DIR, rep["app_id"] + ".json")
    with open(p + ".tmp", "w") as f: json.dump(rep, f, indent=2)
    os.replace(p + ".tmp", p)
    return p

def summary(rep):
    if rep.get("error"): return f"{rep['app_id']}: not measured: {rep['error']}"
    t = rep["totals"]; tk = t["tickets"]
    def v(x, money=False): return "not measured" if x is None else (f"${x:,.2f}" if money else f"{x:,}")
    return (f"{rep['app_id']} ({rep['target']}, last {rep['days']} days, {len(rep['workspaces'])} workspace(s)): "
            f"{v(t['people_active'])} people, {v(t['chats'])} chats, {v(t['chat_turns'])} turns, "
            f"{v(t['input_tokens'])} in / {v(t['output_tokens'])} out tokens, chat {v(t['cost_usd'], True)}; "
            f"{v(t['workflow_runs'])} workflow runs costing {v(t['workflow_cost_usd'], True)}; tickets {v(tk['open'])} open, "
            f"{v(tk['in_progress'])} in progress, {v(tk['done'])} done, {v(tk['total'])} total")

def one_in_child(app_id, days):
    """--all: each app in its own process, so a hang or crash in one never stops the others."""
    try:
        r = subprocess.run([sys.executable, HERE_FILE, app_id, "--days", str(days), "--json"],
                           capture_output=True, text=True, timeout=TIMEOUT)
        doc = parse_last_json_block(r.stdout)
        if doc: return doc
        why = f"the run stopped without a report (exit {r.returncode})"
    except subprocess.TimeoutExpired: why = f"the app did not answer within {TIMEOUT} seconds"
    rep = error_report(app_id, days, None, why); write(rep); return rep

def parse_last_json_block(stdout):
    try: return json.loads(stdout)
    except ValueError: return None

def days_arg(a):
    if "--days" not in a: return DEFAULT_DAYS
    i = a.index("--days")
    try: d = int(a[i + 1])
    except (IndexError, ValueError): sys.exit("--days needs a whole number of days")
    if not 1 <= d <= MAX_DAYS: sys.exit(f"--days must be between 1 and {MAX_DAYS}")
    return d

def main(a):
    if a[:1] == ["remote"]: return remote_main(a[1])
    if "--self-test" in a: return self_test()
    days = days_arg(a)
    if "--all" in a:
        apps = apps_to_run(os.path.join(ROOT, "state", "application"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex: reps = list(ex.map(lambda x: one_in_child(x, days), apps))
        print(json.dumps(reps, indent=2) if "--json" in a else "\n".join(summary(r) for r in reps)); return 0
    pos = [x for i, x in enumerate(a) if not x.startswith("--") and not (i and a[i - 1] == "--days")]
    if not pos: sys.exit(__doc__)
    rep = collect(pos[0], days); p = write(rep)
    print(json.dumps(rep, indent=2) if "--json" in a else summary(rep) + f"\n  written to {os.path.relpath(p, ROOT)}")
    return 0

# ---------------------------------------------------------------------------------------------------------
# self-test: fixtures only, connects to nothing
# ---------------------------------------------------------------------------------------------------------
FIX = os.path.join(S_DIR, "fixtures", "app_usage")

def self_test():
    n = 0
    def ok(c, msg):
        nonlocal n
        assert c, msg
        n += 1
    raw = load(os.path.join(FIX, "raw-two-workspaces.json"))
    dates, since = window(3, dt.date(2026, 10, 8))
    ok(dates == ["2026-10-06", "2026-10-07", "2026-10-08"] and since == "2026-10-06T00:00:00+00:00", "window")
    rep = assemble("demo", 3, "vercel", raw, dates, generated_at="2026-10-08T00:00:00+00:00")
    want = load(os.path.join(FIX, "expected-two-workspaces.json"))
    ok(rep == want, "assembled report differs from the fixture:\n" + json.dumps(rep, indent=2))
    # contract shape
    keys = {"app_id", "generated_at", "days", "target", "totals", "workspaces", "daily", "not_measured"}
    ok(keys <= set(rep) and "error" not in rep, "top-level keys")
    tkeys = set(NUM) | {"tickets"}
    ok(set(rep["totals"]) == tkeys and all(set(w) == tkeys | {"org_id", "name"} for w in rep["workspaces"]), "field sets")
    ok(set(rep["totals"]["tickets"]) == {"open", "in_progress", "done", "total"}, "ticket keys")
    ok([d["date"] for d in rep["daily"]] == dates, "daily covers the window")
    # people are a union, not a sum: alice is in both workspaces
    ok(rep["totals"]["people_active"] == 2 and sum(w["people_active"] for w in rep["workspaces"]) == 3, "people union")
    # folding: every status of the app lands somewhere, the closed set is done, unknown is open and named
    ok(set(TICKET_FOLD) == set(load(os.path.join(FIX, "app-ticket-statuses.json"))), "TICKET_FOLD covers exactly the app's statuses")
    t, unk = fold_tickets({"Open": 2, "Waiting on Eng": 1, "Won't Fix": 1, "Parked": 3})
    ok(t == {"open": 5, "in_progress": 1, "done": 1, "total": 7} and unk == {"Parked": 3}, "fold")
    ok(any("'Parked'" in x for x in assemble("d", 3, "vercel", {"pricing": True, "workspaces": [{"org_id": "a", "name": "A", "errors": {}, "tickets_by_status": {"Parked": 1}}]}, dates)["not_measured"]), "unknown status named")
    # a table that cannot be read is null and named, never 0; the totals that depend on it are null too
    bad = json.loads(json.dumps(raw)); bad["workspaces"][1]["errors"] = {"workflow": "42P01 relation \"automation_runs\" does not exist"}
    r2 = assemble("demo", 3, "vercel", bad, dates)
    ok(r2["workspaces"][1]["workflow_runs"] is None and r2["totals"]["workflow_runs"] is None and r2["totals"]["chat_turns"] is not None, "unreadable -> null")
    ok(any(x.startswith("workflow_runs, workflow_cost_usd (beta)") for x in r2["not_measured"]), "unreadable named")
    # workflow runs that recorded no cost at all: null and named, never $0
    nc = json.loads(json.dumps(raw)); nc["workspaces"][0].update(workflow_uncosted=3, workflow_cost_usd=0, workflow_input_tokens=5000, workflow_output_tokens=70)
    r4 = assemble("demo", 3, "vercel", nc, dates)
    ok(r4["workspaces"][0]["workflow_cost_usd"] is None and r4["totals"]["workflow_cost_usd"] is None and r4["workspaces"][1]["workflow_cost_usd"] == 0.0, "uncosted -> null")
    ok(any("3 of 3 workflow run(s) used the model and none" in x and "5,000 input" in x for x in r4["not_measured"]), "uncosted named with tokens")
    # no price table -> cost null, named
    r3 = assemble("demo", 3, "vercel", dict(raw, pricing=False), dates)
    ok(r3["totals"]["cost_usd"] is None and r3["workspaces"][0]["cost_usd"] is None and any("could not be loaded" in x for x in r3["not_measured"]), "no pricing")
    # an error report keeps the shape with nulls, never zeros
    e = assemble("demo", 3, "vm_remote", {"error": "refused: role x bypasses row-level security"}, dates)
    ok(e["error"].startswith("refused") and e["totals"]["chat_turns"] is None and e["totals"]["tickets"]["total"] is None and e["workspaces"] == [] and e["daily"] == [], "error report")
    # scrubbing: the URL, its password and any env value never survive
    u = "postgres://app_rw:s3cretPassw0rd@db.example.com:5432/app?sslmode=require"
    s = scrub(f"connect failed for {u} using s3cretPassw0rd and tok_ABCDEFGHIJ", url_secrets(u) + ["tok_ABCDEFGHIJ"])
    ok("s3cret" not in s and "tok_ABC" not in s and "app_rw" not in s, "scrub: " + s)
    ok(scrub("x postgres://u:p@h/db y") == "x postgres://[redacted]@h/db y", "scrub url without list")
    # which apps --all runs: not retired, not the template
    ok(apps_to_run(os.path.join(FIX, "state")) == ["live_one", "reverted_one"], "apps_to_run")
    ok(state_orgs(os.path.join(FIX, "state", "live_one")) == [{"org_id": "alpha", "name": "Alpha"}, {"org_id": "beta", "name": "Beta Co"}], "state_orgs")
    # the SSH command: the API's env file, the API's user, nothing secret, this file on stdin
    sys.path.insert(0, os.path.join(S_DIR, "lib")); import vm_remote
    st = os.path.join(S_DIR, "fixtures", "vm_remote", "vm_remote_fixture")
    docs = {k: load(os.path.join(st, f"{k}.json")) for k in ("application", "infrastructure", "datastores")}
    S, argv = remote_argv("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"], {"orgs": [], "since": since, "days": 3})
    spec = json.loads(base64.b64decode(argv[-1].split()[-1]))
    ok(argv[0] == "ssh" and "python3 - remote" in argv[-1] and spec["env_file"].endswith("/vm_remote_fixture/api.env") and spec["user"] == vm_remote.SERVICE_USERS["api"], "remote argv")
    ok(not any(k in json.dumps(spec) for k in ("DATABASE_URL", "PASSWORD", "postgres://")), "no secret on the SSH line")
    seen = {}
    def fake_ssh(argv_, **kw):
        seen.update(kw); return subprocess.CompletedProcess(argv_, 0, "noise\n" + json.dumps({"pricing": True, "workspaces": []}) + "\n", "")
    got = query_vm_remote("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"], {}, run=fake_ssh, have_key=lambda p: True)
    ok(got == {"pricing": True, "workspaces": []} and "QUERY_JS" in seen["input"] and seen["timeout"] < TIMEOUT, "remote stdin")
    ok(query_vm_remote("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"], {}, run=fake_ssh, have_key=lambda p: False)["error"].startswith("there is no SSH key"), "missing key")
    # the remote half: env file read, node run as the given user with DATABASE_URL only, output scrubbed
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        ef = os.path.join(d, "api.env")
        open(ef, "w").write('DATABASE_URL="postgres://app_rw:pw_9876543210@127.0.0.1/app"\nOTHER_SECRET=zzzzzzzzzzzzzzzz\n')
        calls = []
        def fake_node(argv_, **kw):
            calls.append(kw); return subprocess.CompletedProcess(argv_, 1, "", "error: pw_9876543210 zzzzzzzzzzzzzzzz failed")
        global run_node
        real = run_node
        def patched(cwd, env, secrets_, timeout=80, run=None, user_kw=None): return real(cwd, env, secrets_, timeout, fake_node, {})
        run_node = patched
        import io, contextlib, pwd
        buf = io.StringIO()
        me = pwd.getpwuid(os.getuid()).pw_name
        try:
            with contextlib.redirect_stdout(buf):
                remote_main(base64.b64encode(json.dumps({"env_file": ef, "user": me, "home": d, "app_dir": d, "args": {}}).encode()).decode())
        finally: run_node = real
        o = buf.getvalue()
        ok("pw_98765" not in o and "zzzzzzzz" not in o and "error" in json.loads(o), "remote output scrubbed: " + o)
        ok(set(calls[0]["env"]) == {"PATH", "HOME", "LANG", "NODE_ENV", "DATABASE_URL", "SF_USAGE_ARGS"}, "only DATABASE_URL passes to node")
    # the query itself: read-only transactions, RLS per workspace, refuses a bypass role, prints no address
    ok(QUERY_JS.count("sql.begin('read only'") == 1 and "set_config('app.org_id'" in QUERY_JS and "rolbypassrls" in QUERY_JS, "query is read-only and scoped")
    ok(not re.search(r"\b(insert|update|delete|truncate|alter|drop|create)\b", QUERY_JS, re.I), "query writes nothing")
    ok("actor_email" in QUERY_JS and not re.search(r"out\.[a-z_]+ = .*\.e\b", QUERY_JS), "emails stay in the query process")
    # ---- by_agent / by_user (assembled from the fixture's raw rows) ----
    akeys = {"agent", "kind", "workspace", "turns", "runs", "input_tokens", "output_tokens", "cost_usd", "last_active"}
    ukeys = {"user", "workspace", "chats", "chat_turns", "input_tokens", "output_tokens", "cost_usd", "workflow_runs", "last_active"}
    ok(all(set(r) == akeys for r in rep["by_agent"]) and all(set(r) == ukeys for r in rep["by_user"]), "row field sets")
    ok([(r["agent"], r["workspace"]) for r in rep["by_agent"]] == [("main agent", "Alpha"), ("research", "Alpha"), ("main agent", "Beta Co"), ("lodr-filings", "Alpha")], "by_agent order")
    ok(next(r for r in rep["by_agent"] if r["agent"] == "lodr-filings")["cost_usd"] is None, "specialist with tokens and no recorded cost -> null")
    ok(all((r["turns"] is None) == (r["kind"] == "specialist") and (r["runs"] is None) == (r["kind"] == "main") for r in rep["by_agent"]), "turns for main, runs for specialists")
    ok([r["user"] for r in rep["by_user"]] == ["Alice Rao", "Member 1", "Alice Rao"] and [r["chat_turns"] for r in rep["by_user"]] == [3, 1, 1], "by_user order and the unnamed person")
    ok(rep["by_user"][2]["workflow_runs"] is None and sum("by_user workflow_runs (beta)" in x for x in rep["not_measured"]) == 1 and any("by_user workflow_runs (beta): null" in x and "42P01" in x for x in rep["not_measured"]), "unattributable runs -> null, named")
    ok(any("shown as Member N" in x for x in rep["not_measured"]) and any("could not be traced" in x for x in rep["not_measured"]), "unnamed and unattributed named")
    big = json.loads(json.dumps(raw)); big["workspaces"][0]["by_user"] = [dict(raw["workspaces"][0]["by_user"][0], user=f"P{i}", chat_turns=i) for i in range(60)]
    rb = assemble("demo", 3, "vercel", big, dates)
    ok(len(rb["by_user"]) == ROW_CAP and rb["by_user"][0]["chat_turns"] == 59 and any("only the first 50" in x for x in rb["not_measured"]), "cap at 50, highest first")
    ok(e["by_agent"] == [] and e["by_user"] == [], "error report carries empty arrays")
    # ---- the real query against a stand-in `postgres` (fixtures/app_usage/fake-app): naming, no addresses, read-only ----
    fake = os.path.join(FIX, "fake-app")
    rr = run_node(fake, {"PATH": os.environ.get("PATH", PATH), "HOME": "/tmp", "DATABASE_URL": "postgres://u:p@h/db",
                         "SF_USAGE_ARGS": json.dumps({"orgs": [], "since": "2026-10-06T00:00:00+00:00", "days": 3})}, [])
    ok("error" not in rr and not rr["workspaces"][0]["errors"] and not rr["workspaces"][0]["berr"], "fake query ran: " + json.dumps(rr)[:400])
    fr = assemble("fake", 3, "vercel", rr, dates)
    ok("@" not in json.dumps(fr["by_user"]) and "@" not in json.dumps(rr), "no email address leaves the query, not even one stored as a name")
    ok([(r["user"], r["chat_turns"], r["workflow_runs"], r["cost_usd"]) for r in fr["by_user"]] == [("Neha Shah", 3, 0, 2.1), ("Member 1", 2, 2, 0.98), ("Member 2", 1, 0, 0.12)], "names, stable Member N, runs and cost per person")
    ok([(r["agent"], r["turns"], r["runs"], r["cost_usd"]) for r in fr["by_agent"]] == [("main agent", 6, None, 3.2), ("research", None, 2, None)], "main agent and specialist rows")
    ok(fr["totals"]["people_active"] == 3 and fr["totals"]["tickets"]["open"] == 1, "existing fields unchanged by the breakdowns")
    print(f"app_usage: {n} checks passed"); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
