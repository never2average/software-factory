#!/usr/bin/env python3
"""A mold_v0 brief -> a draft pack.json (mold_v0-062). Deterministic: no model call, no network, standard library only.

A new mold_v0 app is a brief + a generated pack.json + a brand ("pick and place"). The brief format is documented in
docs/INTAKE.md ("mold_v0: the brief's pack sections"); in short, these `## ` sections of the brief declare the pack:

  ## Records       ### <area>: <Label>, then bullets: role, scope, field ..., lifecycle, transition ..., who can ...
  ## Metrics       - <name>: <Label> | count <area> | where <field> in a, b | group by <field> | per week of created last 8
  ## Charts        - <name>: <Title> | bar | <metric>, <metric> | ordinal
  ## Tabs          - <id>: <Label> | area <area> | views table, board | charts a, b | icon shield | group Audit
  ## Jobs          ### <kind>: <Label>, then bullets: repository, commit, command, arg ..., validate, write back, ...
  ## Credentials   - <name>: <Label> | asset <area> | env NAME | help ...
  ## Schedules     - <name>: <Label> | <job kind> | 0 3 * * * | over <area>
  ## Onboarding    - <id>: <Label> | record <area>
  ## Words         - run: audit
  ## MCP           - prefix: vd, - exclude: <tool>, - admin only: <tool>, - rename <tool>: <name>, - describe <tool>: <text>  (pack.json `mcp`)

Whatever the brief leaves open becomes a question (the intake questions mechanism: an id, a plain question, options and
a suggested answer), never a silent guess. Defaults that change nothing about who may see or do what (a label from a
name, the first state as the initial one, a credential's variable name) follow documented rules and are listed in the
result's `defaults`, which intake prints and records.

Everything from the brief is DATA: names are checked against the shell's own patterns before they are used anywhere
(a pack id becomes a directory name only after it matched ^[a-z][a-z0-9_]{1,30}$), text is JSON-encoded, commands are
argument lists (never a shell line), and the draft is validated against molds/mold_v0/codebase/packs/pack.schema.json
plus the cross-checks the shell's build makes (validate()).
"""
import hashlib, json, os, re, shlex, shutil, subprocess, tempfile

SECTIONS = {"records": "records", "record areas": "records", "tabs": "tabs", "metrics": "metrics", "charts": "charts",
            "jobs": "jobs", "audits": "jobs", "audits / jobs": "jobs", "jobs / audits": "jobs", "job kinds": "jobs",
            "credentials": "credentials", "schedules": "schedules", "onboarding": "onboarding", "words": "words", "mcp": "mcp"}
# Sections whose absence is a question. MCP and Words are not: the MCP server is the platform's own (mold_v0-060), and
# without words the shell's own are used.
ASKED = ("records", "jobs", "credentials", "schedules", "tabs", "charts", "onboarding")
NAME = re.compile(r"[a-z][a-z0-9_]{1,62}")
PACK_ID = re.compile(r"[a-z][a-z0-9_]{1,30}")
TAB_ID = re.compile(r"[a-z][a-z0-9-]{0,40}")
ARG_NAME = re.compile(r"[a-z][a-z0-9_]{0,39}")
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]{1,62}")
WORD = re.compile(r"[a-z][a-z_]{1,30}")
OPTION = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.:/()&-]{0,79}")
ROLES = ("viewer", "member", "billing", "owner")
ACTIONS = ("read", "create", "update", "move", "delete")
FIELD_TYPES = ("text", "number", "date", "boolean", "json", "link", "enum", "person", "reference", "file")
PLAIN_TYPES = ("text", "number", "date", "boolean", "person", "link", "file", "json")   # what a type question offers
CHART_TYPES = ("bar", "stacked_bar", "line", "area", "number", "table")
TAB_KINDS = ("overview", "area", "runs", "reports", "credentials", "usage", "schedules", "notices", "setup", "billing", "profile", "page")
TAB_ICONS = ("dashboard", "chartBar", "chartLine", "trendingUp", "gauge", "health", "kanban", "inbox", "building", "route", "rocket", "book",
             "plug", "user", "teams", "page", "post", "settings", "clock", "calendar", "search", "check", "circleCheck", "warning", "alertCircle",
             "shield", "lock", "notification", "billing", "account", "code", "product", "workspace", "forms", "play", "refresh", "media", "adjustments")
RESERVED_ENV = re.compile(r"(PATH|HOME|LANG|LC_[A-Z_]+|RUN_[A-Z0-9_]*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_OPTIONS|NPM_CONFIG_[A-Z0-9_]*|LD_[A-Z0-9_]*)")
GATEWAY = re.compile(r"gateway\.(token|url|([a-z][a-z0-9_-]{1,40})\.base_url)")
COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
REPO = re.compile(r"https://[A-Za-z0-9.-]+(:443)?/[A-Za-z0-9._~/-]+")
HOST = re.compile(r"(\*\.)?(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+")
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f  ‪-‮⁦-⁩]")   # control and bidirectional characters
OPS = (("is not empty", "not_empty"), ("is empty", "empty"), ("not in", "not_in"), ("!=", "ne"), ("<=", "lte"), (">=", "gte"),
       ("=", "eq"), ("<", "lt"), (">", "gt"), (" in ", "in"))
POINT = re.compile(r"state:[A-Za-z0-9][A-Za-z0-9 _.:/()&-]{0,79}|[a-z][a-z0-9_]{1,62}")
GENERATOR = "intake.py (mold_v0-062)"


class BriefError(Exception):
    """The brief cannot be read: every problem, each with its line number."""
    def __init__(self, problems): super().__init__("\n".join(problems)); self.problems = problems


# ---- the brief's sections --------------------------------------------------------------------------------------
def _heading(line):
    m = re.match(r"^##\s+(.+?)\s*:?\s*$", line)
    return SECTIONS.get(re.sub(r"\s+", " ", m.group(1).strip().lower())) if m and not line.startswith("###") else None

def split(text):
    """{section: [(line number, line)]} for the pack sections, and the problems with their layout."""
    out, cur, problems = {}, None, []
    for n, line in enumerate(text.splitlines(), 1):
        if line.startswith("## ") or line.startswith("# ") or line.rstrip() in ("#", "##"):
            name = _heading(line)
            if name and name in out: problems.append(f"line {n}: a second `## {line[3:].strip()}` section; put everything for it in one")
            cur = name
            if name: out.setdefault(name, [])
            continue
        if cur: out[cur].append((n, line))
    return out, problems

def has_sections(text):
    return bool(split(text)[0])

def prose(text):
    """The brief with its pack sections blanked (line numbers kept), for the prose hints (intake.parse_brief): a field
    labelled "Vercel project" or a help text naming a domain must never move where the app runs."""
    lines, cur = text.splitlines(), None
    for i, line in enumerate(lines):
        if line.startswith("## ") or line.startswith("# "):
            cur = _heading(line)
            if cur: lines[i] = ""
            continue
        if cur: lines[i] = ""
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


# ---- small parsers -----------------------------------------------------------------------------------------------
def _pipes(s):
    return [p.replace("\\|", "|").strip() for p in re.split(r"(?<!\\)\|", s)]

def _list(s):
    return [x.strip() for x in s.split(",") if x.strip()]

def _num(s):
    try: return int(s) if re.fullmatch(r"-?[0-9]+", s) else float(s) if re.fullmatch(r"-?[0-9]+\.[0-9]+", s) else None
    except ValueError: return None

def _label(name):
    return name.replace("_", " ").replace("-", " ").strip().capitalize()

def _roles(s, err, what, write=False):
    rs = _list(s.lower())
    bad = [r for r in rs if r not in ROLES]
    if bad: err(f"{what}: {', '.join(bad)} is not an account role (viewer, member, billing, owner)")
    if write and "viewer" in rs: err(f"{what}: a viewer is read-only on this platform; a brief cannot let a viewer write")
    return sorted(set(r for r in rs if r in ROLES), key=ROLES.index)

def _duration(s):
    """'1200', '20 minutes', '2 hours' -> seconds, or None."""
    m = re.fullmatch(r"([0-9]+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?", s.strip().lower())
    if not m: return None
    unit = (m.group(2) or "s")[0]
    return int(m.group(1)) * {"s": 1, "m": 60, "h": 3600}[unit]


class _Ctx:
    def __init__(self): self.problems, self.lines, self.defaults = [], {}, []
    def err(self, n, msg): self.problems.append(f"line {n}: {msg}")


def _field(body, n, c, kind="field"):
    """'severity: Severity | enum low, high | required' -> a typed field (shared by record fields and job args)."""
    parts = _pipes(body)
    m = re.match(r"^(\S+?)\s*(?::\s*(.*))?$", parts[0])
    if not m: c.err(n, f"a {kind} needs a name: `- {kind} <name>: <Label> | <type>`"); return None, {}
    name = m.group(1); label = (m.group(2) or "").strip()
    pat = ARG_NAME if kind == "arg" else NAME
    if not pat.fullmatch(name): c.err(n, f"{kind} name {name!r}: lowercase letters, digits and _ ({pat.pattern})"); return None, {}
    f = {"name": name, "label": label or _label(name)}
    if not label: c.defaults.append(f"line {n}: {kind} {name} is labelled {f['label']!r} (from its name)")
    extra = {}
    for part in parts[1:]:
        if not part: continue
        w = part.split(None, 1); head = w[0].lower(); arg = w[1].strip() if len(w) > 1 else ""
        if head in FIELD_TYPES:
            if "type" in f: c.err(n, f"{kind} {name} has two types"); continue
            f["type"] = head
            if head == "text" and arg:
                mm = re.fullmatch(r"max\s+([0-9]+)", arg)
                if mm: f["max_length"] = int(mm.group(1))
                else: c.err(n, f"text takes `max <characters>`, not {arg!r}")
            elif head == "number" and arg:
                mm = re.fullmatch(r"(-?[0-9]+(?:\.[0-9]+)?)\s*\.\.\s*(-?[0-9]+(?:\.[0-9]+)?)", arg)
                if mm: f["min"], f["max"] = _num(mm.group(1)), _num(mm.group(2))
                else:
                    for k, v in re.findall(r"\b(min|max)\s+(-?[0-9]+(?:\.[0-9]+)?)", arg): f[k] = _num(v)
                    if not re.fullmatch(r"((min|max)\s+-?[0-9]+(\.[0-9]+)?\s*)+", arg): c.err(n, f"number takes `A..B` or `min A max B`, not {arg!r}")
            elif head == "enum":
                opts, seen = [], set()
                for o in _list(arg):
                    v, _, lab = o.partition("=")
                    v, lab = v.strip(), lab.strip()
                    if not OPTION.fullmatch(v): c.err(n, f"enum option {v!r}: letters, digits, spaces and _ . : / ( ) & - (at most 80), starting with a letter or digit"); continue
                    if v in seen: c.err(n, f"enum option {v!r} is listed twice"); continue
                    seen.add(v); opts.append({"value": v, "label": lab} if lab else v)
                if not opts: c.err(n, f"an enum lists its options: `enum low, medium, high` (or `open=Open, wont_fix=Won't fix`)")
                elif any(isinstance(o, dict) for o in opts): f["options"] = [o if isinstance(o, dict) else {"value": o} for o in opts]
                else: f["options"] = opts
            elif head == "reference":
                if not NAME.fullmatch(arg): c.err(n, f"reference names the area it points at: `reference <area>`, not {arg!r}")
                else: f["to"] = arg
            elif arg: c.err(n, f"{head} takes nothing after it (got {arg!r})")
        elif head == "required" and not arg: f["required"] = True
        elif head == "optional" and not arg: pass
        elif head in ("multiple", "many") and not arg: f["multiple"] = True
        elif head == "help": f["help"] = arg
        elif kind == "arg" and head in ("from", "pattern", "default"): extra[head] = arg
        else: c.err(n, f"{kind} {name}: unknown setting {part!r} (a type, required, multiple, help <text>" + (", from, pattern, default" if kind == "arg" else "") + ")")
    return f, extra


# ---- sections -----------------------------------------------------------------------------------------------------
def _items(lines, c, section):
    """### blocks: [(n, name, label, [(n, key, value)])]."""
    out = []
    for n, line in lines:
        s = line.strip()
        if not s or s.startswith("<!--"): continue
        if s.startswith("### "):
            m = re.match(r"^###\s+(\S+?)\s*(?::\s*(.*))?$", s)
            if not m or not NAME.fullmatch(m.group(1)):
                c.err(n, f"`### <name>: <Label>`, with a name of lowercase letters, digits and _ ({NAME.pattern})"); out.append((n, None, None, [])); continue
            out.append((n, m.group(1), (m.group(2) or "").strip(), []))
        elif s.startswith("- ") or s.startswith("* "):
            if not out: c.err(n, f"start each entry of ## {section} with `### <name>: <Label>`"); continue
            body = s[2:].strip()
            k, sep, v = body.partition(":")
            out[-1][3].append((n, k.strip().lower(), v.strip(), body))
        else: c.err(n, f"in ## {section}, write `### <name>: <Label>` or a `- ` bullet (got {s[:60]!r})")
    return out

def _bullets(lines, c, section):
    out = []
    for n, line in lines:
        s = line.strip()
        if not s or s.startswith("<!--"): continue
        if s.startswith("- ") or s.startswith("* "): out.append((n, s[2:].strip()))
        else: c.err(n, f"in ## {section}, each entry is one `- ` bullet (got {s[:60]!r})")
    return out

def _head(body, n, c, pattern=NAME, what="name"):
    """'name: Label | a | b' -> (name, label, [a, b])."""
    parts = _pipes(body)
    m = re.match(r"^(\S+?)\s*(?::\s*(.*))?$", parts[0])
    if not m or not pattern.fullmatch(m.group(1)):
        c.err(n, f"start with the {what} ({pattern.pattern}), then `: <Label>`: got {parts[0][:60]!r}"); return None, None, []
    return m.group(1), (m.group(2) or "").strip(), parts[1:]


def parse_records(lines, c):
    areas = []
    for n, name, label, kvs in _items(lines, c, "Records"):
        if not name: continue
        a = {"name": name, "label": label or _label(name)}; c.lines[("area", name)] = n
        if not label: c.defaults.append(f"line {n}: area {name} is labelled {a['label']!r} (from its name)")
        fields, trans, perms, lc = [], [], {}, {}
        for ln, k, v, body in kvs:
            if k.startswith("field ") or body.startswith("field "):
                f, _ = _field(body[6:].strip(), ln, c)
                if f: fields.append(f); c.lines[("field", name, f["name"])] = ln
            elif k == "role":
                if v.lower() in ("source", "check", "asset"): a["role"] = v.lower()
                else: c.err(ln, f"role is source, check or asset (got {v!r})")
            elif k == "scope":
                sv = {"shared": "platform", "platform": "platform", "workspace": "workspace", "per workspace": "workspace"}.get(v.lower())
                if sv: a["scope"] = sv
                else: c.err(ln, f"scope is workspace (each workspace's own) or platform (one shared list), not {v!r}")
            elif k == "description": a["description"] = v
            elif k == "columns": a["list_columns"] = _list(v)
            elif k == "sealed":
                if v.lower() in ("yes", "true"): a["sealed"] = True
                elif v.lower() in ("no", "false"): a["sealed"] = False
                else: c.err(ln, "sealed is yes or no")
            elif k == "lifecycle": lc["field"] = v; lc["line"] = ln
            elif k == "initial": lc["initial"] = v
            elif k == "transition":
                parts = _pipes(v); m = re.match(r"^(.*?)\s*->\s*(.+)$", parts[0])
                if not m: c.err(ln, "a transition is `<from>, <from> -> <to> | <Label> | roles owner` (from may be *)"); continue
                frm = m.group(1).strip()
                t = {"from": "*" if frm in ("*", "any") else _list(frm), "to": m.group(2).strip()}
                for p in parts[1:]:
                    w = p.split(None, 1)
                    if w and w[0].lower() in ("roles", "by") and len(w) > 1: t["roles"] = _roles(w[1], lambda m_: c.err(ln, m_), "a transition's roles", write=True)
                    elif p: t["label"] = p
                trans.append(t)
            elif k == "due":
                parts = _pipes(v); m = re.fullmatch(r"([a-z][a-z0-9_]{1,62})(?:\s+within\s+([0-9]+)\s*days?)?", parts[0])
                if not m: c.err(ln, "due is `<date field> within <N> days | notify owner, billing`"); continue
                d = {"field": m.group(1)}
                if m.group(2): d["within_days"] = int(m.group(2))
                for p in parts[1:]:
                    w = p.split(None, 1)
                    if w and w[0].lower() == "notify" and len(w) > 1: d["notify"] = _roles(w[1], lambda m_: c.err(ln, m_), "due notify")
                    elif p: c.err(ln, f"due: unknown setting {p!r} (notify <roles>)")
                a["due"] = d
            elif re.fullmatch(r"who can (read|create|update|move|delete)", k):
                act = k.split()[-1]
                perms[act] = _roles(v, lambda m_: c.err(ln, m_), f"who can {act}", write=act != "read")
                if not perms[act]: c.err(ln, f"who can {act}: name at least one role")
            else: c.err(ln, f"area {name}: unknown line {k!r} (role, scope, description, field, columns, lifecycle, initial, transition, due, sealed, who can read|create|update|move|delete)")
        a["fields"] = fields
        for i, f in enumerate(fields):
            if f["name"] in [g["name"] for g in fields[:i]]: c.err(c.lines[("field", name, f["name"])], f"area {name}: field {f['name']} is declared twice")
            if f["name"] in ("created", "updated"): c.err(c.lines[("field", name, f["name"])], f"area {name}: a field named {f['name']} hides the record's own {f['name']} time; name it otherwise")
        if not fields: c.err(n, f"area {name} declares no field: add `- field <name>: <Label> | <type>`")
        if perms: a["permissions"] = {k: perms[k] for k in ACTIONS if k in perms}
        if lc or trans:
            if not lc.get("field"): c.err(n, f"area {name} has transitions but no `- lifecycle: <enum field>`")
            a["_lifecycle"] = dict(lc, transitions=trans)
        areas.append(a)
    return areas


def parse_jobs(lines, c):
    kinds = []
    for n, name, label, kvs in _items(lines, c, "Jobs"):
        if not name: continue
        k = {"name": name, "label": label or _label(name)}; agent = {}; args = []; c.lines[("job", name)] = n
        if not label: c.defaults.append(f"line {n}: job {name} is labelled {k['label']!r} (from its name)")
        for ln, key, v, body in kvs:
            def argv(s, what):
                try: out = shlex.split(s, posix=True)
                except ValueError as x: c.err(ln, f"{what}: {x}"); return None
                if not out: c.err(ln, f"{what} is empty"); return None
                return out
            if key.startswith("arg ") or body.startswith("arg "):
                f, extra = _field(body[4:].strip(), ln, c, kind="arg")
                if f: args.append((f, extra))
            elif key.startswith("env "):
                nm = body[4:].split(":", 1)[0].strip()
                if not ENV_NAME.fullmatch(nm): c.err(ln, f"env name {nm!r}: CAPITALS, digits and _"); continue
                if RESERVED_ENV.fullmatch(nm): c.err(ln, f"{nm} is set by the shell for every run (PATH, HOME, RUN_*, proxy and loader settings)"); continue
                agent.setdefault("env", {})[nm] = v
            elif key == "runner":
                if v == "workspace-harness": c.err(ln, "a workspace-harness job runs a program of the pack's own code; intake writes declarative packs: use `runner: agent-workspace` with a repository and commit, or write the program in the pack by hand")
                elif v != "agent-workspace": c.err(ln, f"runner is agent-workspace (got {v!r})")
                else: k["runner"] = v
            elif key == "description": k["description"] = v
            elif key == "repository":
                if v.startswith("file:"): c.err(ln, "a brief names an https:// repository (a file:/// mirror is a runner's own setting)")
                elif not REPO.fullmatch(v) or len(v) > 300: c.err(ln, f"repository is an https:// address with no user, query or fragment (got {v[:80]!r})")
                else: agent["repository"] = v
            elif key in ("commit", "pin"):
                if not COMMIT.fullmatch(v): c.err(ln, f"commit is the full commit id (40 or 64 lowercase hex characters): never a branch, a tag or a short id (got {v[:80]!r})")
                else: agent["commit"] = v
            elif key == "command":
                a_ = argv(v, "command")
                if a_: agent["command"] = a_
            elif key == "setup":
                a_ = argv(v, "setup")
                if a_: agent["setup"] = {"command": a_}
            elif key in ("validate", "validator"):
                a_ = argv(v, "validate")
                if a_: agent["validate"] = {"command": a_}
            elif key in ("write back", "write-back", "write_back"): agent["write_back"] = _list(v)
            elif key == "results": agent["results"] = v
            elif key == "record": agent["record"] = _list(v)
            elif key == "strip": agent["strip"] = _list(v)
            elif key == "credentials": k["credentials"] = _list(v)
            elif key == "egress":
                hosts = _list(v.lower())
                for h in hosts:
                    if not HOST.fullmatch(h): c.err(ln, f"egress host {h!r}: a host name such as api.example.com or *.example.com")
                k["egress"] = hosts
            elif key == "providers": k["providers"] = _list(v.lower())
            elif key in ("timeout", "token lifetime"):
                s = _duration(v)
                if s is None: c.err(ln, f"{key} is a number of seconds, minutes or hours (got {v!r})")
                elif key == "timeout": agent["timeout_seconds"] = s
                else: k["token_lifetime_seconds"] = s
            elif key in ("budget", "month budget"):
                x = _num(v.lstrip("$").replace(" usd", "").strip())
                if x is None: c.err(ln, f"{key} is a number of US dollars (got {v!r})")
                else: k["budget_usd" if key == "budget" else "month_budget_usd"] = x
            elif key in ("concurrency", "attempts"):
                if not re.fullmatch(r"[0-9]{1,6}", v): c.err(ln, f"{key} is a whole number (got {v!r})")
                else: k["concurrency_per_workspace" if key == "concurrency" else "max_attempts"] = int(v)
            elif key == "on unresolved":
                if v not in ("reject", "drop", "downgrade"): c.err(ln, "on unresolved is reject, drop or downgrade")
                else: k["unresolved_references"] = v
            else: c.err(ln, f"job {name}: unknown line {key!r} (description, runner, repository, commit, command, setup, validate, write back, results, record, strip, arg, env, credentials, egress, providers, timeout, token lifetime, budget, month budget, concurrency, attempts, on unresolved)")
        if args:
            k["args"] = [f for f, _ in args]
            for f, extra in args:
                spec = {"from": extra.get("from") or f"scope.{f['name']}"}
                if not extra.get("from"): c.defaults.append(f"line {c.lines[('job', name)]}: job {name}'s argument {f['name']} comes from the run's scope.{f['name']}")
                for x in ("pattern", "default"):
                    if x in extra: spec[x] = extra[x]
                agent.setdefault("args", {})[f["name"]] = spec
        k["_agent"] = agent
        kinds.append(k)
    return kinds


def parse_metrics(lines, c):
    out = []
    for n, body in _bullets(lines, c, "Metrics"):
        name, label, parts = _head(body, n, c)
        if not name: continue
        m = {"name": name, "label": label or _label(name)}; c.lines[("metric", name)] = n
        if not parts: c.err(n, f"metric {name}: say what it measures: `| count <area>` (or sum, average, rate, duration)"); continue
        mm = re.fullmatch(r"(count|sum|average|rate|duration)\s+([a-z][a-z0-9_]{1,62})(?:\.((?:detail\.)?[a-z][a-z0-9_]{0,62}))?", parts[0].strip())
        if not mm: c.err(n, f"metric {name}: `count <area>`, `sum <area>.<field>`, `average <area>.<field>`, `rate <area>` or `duration <area>` (got {parts[0]!r})"); continue
        if mm.group(1) != "count": m["measure"] = mm.group(1)
        m["over"] = mm.group(2)
        if mm.group(3): m["field"] = mm.group(3)
        for p in parts[1:]:
            low = p.lower()
            if low.startswith("where ") or low.startswith("matching "):
                conds = _conds(p.split(None, 1)[1], n, c)
                if low.startswith("where "): m["where"] = conds
                else: m["rate"] = {"where": conds}
            elif low.startswith("group by due "):
                g = re.fullmatch(r"group by due\s+([a-z][a-z0-9_]{1,62})(?:\s+soon\s+([0-9]+))?", p)
                if not g: c.err(n, "`group by due <date field> soon <days>`"); continue
                m["group_by"] = {"due": g.group(1), **({"soon_days": int(g.group(2))} if g.group(2) else {})}
            elif low.startswith("group by "): m["group_by"] = p[9:].strip()
            elif low.startswith("per "):
                g = re.fullmatch(r"per\s+(day|week|month)\s+of\s+(\S+(?:\s\S+)*?)(?:\s+last\s+([0-9]+))?", p)
                if not g or not POINT.fullmatch(g.group(2)): c.err(n, "`per day|week|month of <date field, created, updated or state:<state>> last <N>`"); continue
                m["by_time"] = {"at": g.group(2), "every": g.group(1), **({"last": int(g.group(3))} if g.group(3) else {})}
            elif low.startswith("from "):
                g = re.fullmatch(r"from\s+(.+?)\s+to\s+(.+?)(?:\s+as\s+(average|median|p90|max))?(?:\s+in\s+(days|hours))?", p)
                if not g or not POINT.fullmatch(g.group(1)) or not POINT.fullmatch(g.group(2)): c.err(n, "`from <point> to <point> as median in days` (a point: a date field, created, updated, started, ended or state:<state>)"); continue
                m["duration"] = {"from": g.group(1), "to": g.group(2), **({"stat": g.group(3)} if g.group(3) else {}), **({"unit": g.group(4)} if g.group(4) else {})}
            elif low.startswith("limit "):
                if not re.fullmatch(r"[0-9]{1,6}", p[6:].strip()): c.err(n, "limit is a whole number"); continue
                m["limit"] = int(p[6:].strip())
            elif low.startswith("unit "): m["unit"] = p[5:].strip()
            elif low.startswith("roles "): m["roles"] = _roles(p[6:], lambda x: c.err(n, x), "metric roles")
            elif low.startswith("description "): m["description"] = p[12:].strip()
            else: c.err(n, f"metric {name}: unknown part {p!r} (where, matching, group by, per, from, limit, unit, roles, description)")
        out.append(m)
    return out

def _conds(s, n, c):
    out = []
    for part in re.split(r"\s+and\s+", s.strip()):
        for word, op in OPS:
            w = word.strip()
            mm = re.fullmatch(rf"((?:detail\.)?[a-z][a-z0-9_]{{0,62}})\s*{re.escape(w)}\s*(.*)", part.strip()) if w not in ("in",) else \
                 re.fullmatch(r"((?:detail\.)?[a-z][a-z0-9_]{0,62})\s+in\s+(.*)", part.strip())
            if not mm: continue
            fld, val = mm.group(1), mm.group(2).strip()
            cond = {"field": fld, "op": op}
            if op in ("empty", "not_empty"):
                if val: c.err(n, f"{word.strip()} takes no value")
            elif op in ("in", "not_in"): cond["value"] = [_value(v) for v in _list(val)]
            else: cond["value"] = _value(val)
            out.append(cond); break
        else: c.err(n, f"condition {part!r}: `<field> = <value>`, `!=`, `<`, `<=`, `>`, `>=`, `in a, b`, `not in a, b`, `is empty`, `is not empty`")
    return out

def _value(v):
    v = v.strip()
    if v in ("true", "false"): return v == "true"
    x = _num(v)
    return v if x is None else x


def parse_charts(lines, c):
    out = []
    for n, body in _bullets(lines, c, "Charts"):
        name, title, parts = _head(body, n, c)
        if not name: continue
        if len(parts) < 2: c.err(n, f"chart {name}: `- {name}: <Title> | <type> | <metric>, <metric>`"); continue
        ch = {"name": name, "title": title or _label(name), "type": parts[0].strip().lower(), "metrics": _list(parts[1])}
        c.lines[("chart", name)] = n
        for p in parts[2:]:
            if p.lower() in ("ordinal", "categorical"): ch["palette"] = p.lower()
            elif p.lower().startswith("description "): ch["description"] = p[12:].strip()
            elif p: c.err(n, f"chart {name}: unknown part {p!r} (ordinal, categorical, description <text>)")
        out.append(ch)
    return out


def parse_tabs(lines, c):
    out = []
    for n, body in _bullets(lines, c, "Tabs"):
        tid, label, parts = _head(body, n, c, TAB_ID, "tab id")
        if not tid: continue
        if not parts: c.err(n, f"tab {tid}: say its kind: `| area <area>`, `| overview`, `| runs`, ..."); continue
        w = parts[0].split(None, 1)
        if not w: c.err(n, f"tab {tid}: say its kind right after the label: `| area <area>`, `| overview`, `| runs`, ..."); continue
        kind = w[0].lower()
        if kind not in TAB_KINDS: c.err(n, f"tab {tid}: kind is one of {', '.join(TAB_KINDS)} (got {kind!r})"); continue
        t = {"id": tid, "kind": kind}; c.lines[("tab", tid)] = n
        if label: t["label"] = label
        if kind in ("area", "page"):
            if len(w) < 2: c.err(n, f"tab {tid}: `{kind} <{'area' if kind == 'area' else 'page id'}>`"); continue
            t["area" if kind == "area" else "page"] = w[1].strip()
        elif len(w) > 1: c.err(n, f"tab {tid}: {kind} takes nothing after it")
        for p in parts[1:]:
            ww = p.split(None, 1); k = ww[0].lower() if ww else ""; v = ww[1].strip() if len(ww) > 1 else ""
            if k == "icon": t["icon"] = v
            elif k == "group": t["group"] = v
            elif k == "views": t["views"] = _list(v.lower())
            elif k == "charts": t["charts"] = _list(v)
            elif k == "roles": t["roles"] = _roles(v, lambda x: c.err(n, x), "tab roles")
            elif k == "description": t["description"] = v
            elif p.lower().startswith("board by "): t["board_by"] = p[9:].strip()
            elif p.lower().startswith("timeline by "): t["timeline_by"] = p[12:].strip()
            elif p: c.err(n, f"tab {tid}: unknown part {p!r} (icon, group, views, charts, roles, description, board by, timeline by)")
        out.append(t)
    return out


def parse_credentials(lines, c):
    out = []
    for n, body in _bullets(lines, c, "Credentials"):
        name, label, parts = _head(body, n, c)
        if not name: continue
        cr = {"name": name, "label": label or _label(name)}; c.lines[("credential", name)] = n
        for p in parts:
            w = p.split(None, 1); k = w[0].lower() if w else ""; v = w[1].strip() if len(w) > 1 else ""
            if k == "workspace" and not v: cr["bound_to"] = "workspace"
            elif k == "asset": cr["bound_to"] = "asset"; cr["area"] = v
            elif k == "environment":
                # an environment binding names the asset area whose records have the environments: `environment <area> [prod, staging]`
                mm = re.fullmatch(r"([a-z][a-z0-9_]{1,62})(?:\s+(.+))?", v)
                if not mm: c.err(n, f"credential {name}: `environment <asset area> [prod, staging]`"); continue
                cr["bound_to"] = "environment"; cr["area"] = mm.group(1)
                if mm.group(2): cr["environments"] = _list(mm.group(2))
            elif k == "env":
                if not ENV_NAME.fullmatch(v): c.err(n, f"credential {name}: env {v!r} is not a variable name (CAPITALS, digits, _)")
                elif RESERVED_ENV.fullmatch(v): c.err(n, f"credential {name}: {v} is set by the shell for every run")
                else: cr["deliver_as"] = {"env": v}
            elif k == "file":
                if not re.fullmatch(r"[a-z0-9_][a-z0-9_.-]{0,99}", v) or v in (".", ".."): c.err(n, f"credential {name}: file {v!r} is a plain file name (lowercase, digits, _ . -)")
                else: cr["deliver_as"] = {"file": v}
            elif k == "help": cr["help"] = v
            elif p: c.err(n, f"credential {name}: unknown part {p!r} (workspace, asset <area>, environment [names], env <NAME>, file <name>, help <text>)")
        if "deliver_as" not in cr and RESERVED_ENV.fullmatch(name.upper()):
            c.err(n, f"credential {name}: its default variable {name.upper()} is one the shell sets for every run; add `| env <ANOTHER_NAME>`")
        elif "deliver_as" not in cr:
            cr["deliver_as"] = {"env": name.upper()}
            c.defaults.append(f"line {n}: credential {name} reaches a run as the variable {name.upper()} (from its name)")
        out.append(cr)
    return out


def parse_schedules(lines, c):
    out = []
    for n, body in _bullets(lines, c, "Schedules"):
        name, label, parts = _head(body, n, c)
        if not name: continue
        if len(parts) < 2: c.err(n, f"schedule {name}: `- {name}: <Label> | <job> | <cron, five fields, UTC>`"); continue
        s = {"name": name}
        if label: s["label"] = label
        s["job_kind"] = parts[0].strip(); s["cron"] = re.sub(r"\s+", " ", parts[1].strip())
        if len(s["cron"].split(" ")) != 5 or not re.fullmatch(r"[0-9*/,\- A-Za-z]+", s["cron"]): c.err(n, f"schedule {name}: the cron expression has five fields (minute hour day month weekday, UTC), got {s['cron']!r}")
        else:
            mi = s["cron"].split(" ")[0]
            every = re.fullmatch(r"\*(?:/([0-9]+))?", mi)
            if every and int(every.group(1) or 1) < 5: c.err(n, f"schedule {name}: at most every 5 minutes")
        for p in parts[2:]:
            w = p.split(None, 1); k = w[0].lower() if w else ""; v = w[1].strip() if len(w) > 1 else ""
            if k == "over":
                mm = re.fullmatch(r"([a-z][a-z0-9_]{1,62})(?:\s+keys\s+(.+))?", v)
                if not mm: c.err(n, "`over <asset area> [keys a, b]`"); continue
                s["assets"] = {"area": mm.group(1), **({"keys": _list(mm.group(2))} if mm.group(2) else {})}
            elif k == "environment": s["environment"] = v
            elif k in ("off", "disabled") and not v: s["enabled"] = False
            elif p: c.err(n, f"schedule {name}: unknown part {p!r} (over <area>, environment <name>, off)")
        c.lines[("schedule", name)] = n
        out.append(s)
    return out


def parse_onboarding(lines, c):
    out = []
    for n, body in _bullets(lines, c, "Onboarding"):
        sid, label, parts = _head(body, n, c, what="step id")
        if not sid: continue
        if not parts: c.err(n, f"step {sid}: say when it is done: `| record <area>`, `| run <job>`, `| credential <name>`, `| connected`, `| first call`, `| workspace`, `| tool <name>`"); continue
        w = parts[0].split(None, 1)
        if not w: c.err(n, f"step {sid}: say when it is done right after the label: `| record <area>`, `| run <job>`, `| connected`, ..."); continue
        k = w[0].lower(); v = w[1].strip() if len(w) > 1 else ""
        if k in ("workspace", "connected") and not v: done = k
        elif parts[0].lower() == "first call": done = "first_call"
        elif k in ("record", "run", "credential", "tool") and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", v): done = f"{k}:{v}"
        else: c.err(n, f"step {sid}: done when is workspace, connected, first call, or record|run|credential|tool <name> (got {parts[0]!r})"); continue
        st = {"id": sid, "label": label or _label(sid), "done_when": done}
        for p in parts[1:]:
            if p.lower().startswith("help "): st["help"] = p[5:].strip()
            # mold_v0-119: the words a person types to their AI client for this step (pack.json onboarding[].prompt,
            # mold_v0-105: the generated get_started tool and the console's checklist offer them).
            elif p.lower().startswith("prompt "):
                v = p[7:].strip().strip('"').strip()
                if not v or len(v) > 200 or PROMPT_BAD.search(v): c.err(n, f"step {sid}: prompt is one line of plain text, at most 200 characters, no < > or ` and no control, zero-width or direction characters")
                elif "prompt" in st: c.err(n, f"step {sid}: prompt is given twice")
                else: st["prompt"] = v
            elif p: c.err(n, f"step {sid}: unknown part {p!r} (help <text>, prompt <words to type>)")
        c.lines[("step", sid)] = n
        out.append(st)
    return out


def parse_words(lines, c):
    out = {}
    for n, body in _bullets(lines, c, "Words"):
        k, _, v = body.partition(":")
        k, v = k.strip(), v.strip()
        if not WORD.fullmatch(k) or not v: c.err(n, "a word is `- <shell word>: <your word>`, e.g. `- run: audit`"); continue
        out[k] = v
    return out


TOOL = re.compile(r"[a-z][a-z0-9_]{0,63}")
DESCRIBE_BAD = re.compile(r"[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]")
# The shell's rules (src/pack-api.ts OnboardingStepSchema prompt, McpSettingsSchema instructions).
PROMPT_BAD = re.compile(r"[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>`]")
INSTRUCTIONS_BAD = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")
MAX_INSTRUCTIONS = 4000

def parse_mcp(lines, c):
    """pack.json `mcp` (mold_v0-060, McpSettingsSchema): prefix, include, exclude, admin only, rename <tool>: <name>,
    describe <tool>: <text>, instructions: <text> (mold_v0-119: what the MCP server tells an AI client about the app,
    mold_v0-105; each `- instructions:` bullet is one paragraph, in order). Tool names are the generated ones
    (src/mcp-catalog.ts), with or without the prefix."""
    out = {}
    for n, body in _bullets(lines, c, "MCP"):
        k, _, v = body.partition(":"); k = re.sub(r"\s+", " ", k.strip().lower()); v = v.strip()
        c.lines[("mcp", k)] = n
        if k == "prefix":
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,30}", v): c.err(n, f"prefix is 1-31 lowercase letters, digits or _, starting with a letter (got {v!r})")
            else: out["prefix"] = v
        elif k in ("include", "exclude", "admin only", "admin_only"):
            names = _list(v); key = "admin_only" if k.startswith("admin") else k
            for x in names:
                if not TOOL.fullmatch(x): c.err(n, f"{k}: {x!r} is not a tool name (lowercase letters, digits and _, at most 64)")
            if key in out: c.err(n, f"{k} is given twice; list every tool on one line")
            out[key] = names
        elif k.startswith("rename ") or k.startswith("describe "):
            what, tool = k.split(" ", 1); tool = tool.strip()
            if not TOOL.fullmatch(tool): c.err(n, f"{what}: {tool!r} is not a tool name"); continue
            if what == "rename":
                if not TOOL.fullmatch(v): c.err(n, f"rename {tool}: {v!r} is not a tool name (lowercase letters, digits and _, starting with a letter, at most 64)"); continue
            elif not v or len(v) > 1000 or DESCRIBE_BAD.search(v): c.err(n, f"describe {tool}: one paragraph of plain text, at most 1000 characters, no < or > and no control, zero-width or direction characters"); continue
            d = out.setdefault(what, {})
            if tool in d: c.err(n, f"{what} {tool} is given twice")
            d[tool] = v
        elif k == "instructions":
            if not v or INSTRUCTIONS_BAD.search(v): c.err(n, "instructions: plain text (no control, zero-width or direction characters); one `- instructions:` bullet per paragraph"); continue
            joined = f"{out['instructions']}\n\n{v}" if "instructions" in out else v
            if len(joined) > MAX_INSTRUCTIONS: c.err(n, f"instructions: at most {MAX_INSTRUCTIONS} characters in all (the paragraphs so far and this one make {len(joined)})"); continue
            out["instructions"] = joined
        else: c.err(n, f"unknown MCP setting {k!r} (prefix, include, exclude, admin only, rename <tool>: <new name>, describe <tool>: <text>, instructions: <text>)")
    return out


def mcp_tools(p):
    """The tools src/mcp-catalog.ts generates for a pack made from a brief: [(generated name, door, takes a workspace arg)].
    Repositories, reports and code tools are never in a brief's pack, so they are not generated here."""
    prefix = (p.get("mcp") or {}).get("prefix") or p.get("id") or ""
    words = p.get("words") or {}
    def token(x, d):
        import unicodedata
        return re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", unicodedata.normalize("NFKD", str(x).lower()))) or d
    plural = lambda w: w + "es" if re.search(r"(s|x|z|ch|sh)$", w) else w[:-1] + "ies" if re.search(r"[^aeiou]y$", w) else w + "s"
    n = lambda verb, thing=None: f"{prefix}_{verb}" + (f"_{thing}" if thing else "")
    out = []
    for a in p.get("record_areas") or []:
        out += [(n("list", a["name"]), "workspace"), (n("get", a["name"]), "workspace")]
        if a.get("scope") != "platform":
            out += [(n("create", a["name"]), "workspace"), (n("update", a["name"]), "workspace")]
            if a.get("lifecycle"): out.append((n("move", a["name"]), "workspace"))
    if p.get("metrics"): out.append((n("get", "metrics"), "workspace"))
    kinds = p.get("job_kinds") or []
    for k in kinds: out.append((n("start", k["name"]), "workspace"))
    if kinds:
        run_tok = token(words.get("run", "run"), "run"); runs_tok = token(words.get("runs") or plural(run_tok), "runs")
        out += [(n(f"{run_tok}_status"), "workspace"), (n("list", runs_tok), "workspace"), (n("get", f"{run_tok}_results"), "workspace"), (n("cancel", run_tok), "workspace")]
    for a in p.get("record_areas") or []:
        if a.get("scope") == "platform":
            out += [(n(f"admin_{v}", a["name"]), "admin") for v in ("list", "get", "create", "update", "delete")]
    return out


def apply_mcp(pack, mcp, defaults, line=None):
    """Put the brief's `## MCP` block into pack.json, naming each tool as the generator does: a name written without the
    prefix (`list_audit_findings`) is the generated `<prefix>_list_audit_findings` when that tool exists, and said."""
    if not mcp: return pack
    m = json.loads(json.dumps(mcp)); pack["mcp"] = m
    gen = {t for t, _ in mcp_tools(pack)}; prefix = m.get("prefix") or pack.get("id")
    def fix(x):
        if x not in gen and f"{prefix}_{x}" in gen:
            defaults.append(f"mcp: {x} is the generated tool {prefix}_{x}"); return f"{prefix}_{x}"
        return x
    for k in ("include", "exclude", "admin_only"):
        if k in m: m[k] = [fix(x) for x in m[k]]
    for k in ("rename", "describe"):
        if k in m: m[k] = {fix(x): v for x, v in m[k].items()}
    return pack


def mcp_errors(p):
    """src/mcp-catalog.ts generateCatalog's checks on a pack's `mcp` block, for one pack."""
    m = p.get("mcp")
    if not isinstance(m, dict): return []
    errs = []; E = lambda x: errs.append(f"mcp: {x}")
    tools = mcp_tools(p); gen = {t for t, _ in tools}; door = dict(tools)
    for key in ("include", "exclude", "admin_only"):
        for x in m.get(key) or []:
            if x not in gen: E(f"{key} names {x}, which is not one of this pack's generated tools ({', '.join(sorted(gen)) or 'none'})")
    for key in ("rename", "describe"):
        for x in (m.get(key) or {}):
            if x not in gen: E(f"{key} names {x}, which is not one of this pack's generated tools ({', '.join(sorted(gen)) or 'none'})")
    inc = set(m["include"]) if "include" in m else None; exc = set(m.get("exclude") or []); adm = set(m.get("admin_only") or [])
    seen = {}
    assets = any(a.get("role") == "asset" for a in p.get("record_areas") or [])
    for k in p.get("job_kinds") or []:
        if assets and any(a.get("name") == "target_asset" for a in k.get("args") or []): E(f"job kind {k['name']} has an argument named target_asset, which its start tool uses for the target")
        envc = [c for c in p.get("credentials") or [] if c.get("name") in (k.get("credentials") or []) and c.get("bound_to") == "environment"]
        if envc and any(a.get("name") == "target_environment" for a in k.get("args") or []): E(f"job kind {k['name']} has an argument named target_environment, which its start tool uses for the target")
    for t, d in tools:
        if (inc is not None and t not in inc) or t in exc: continue
        server = d
        if t in adm:
            if d == "admin": E(f"admin_only names {t}, which is on the admin MCP already"); continue
            server = "admin"
        name = (m.get("rename") or {}).get(t, t)
        if len(name) > 64 or not TOOL.fullmatch(name): E(f"tool {name} is longer than 64 characters (MCP clients refuse it): set a shorter prefix, or rename it")
        if (server, name) in seen: E(f"tool {name} ({t}) clashes with {seen[(server, name)]} on the {server} MCP: rename it or set prefix")
        else: seen[(server, name)] = t
    return errs


def parse(text):
    """The brief's pack sections -> {section: parsed} (a missing section is absent), defaults applied, line map.
    Raises BriefError with every problem, each with its line number."""
    secs, problems = split(text)
    c = _Ctx(); c.problems += problems
    for lines in secs.values():
        for n, line in lines:
            if CTRL.search(line): c.err(n, "a control or text-direction character; write plain text")
    fn = {"records": parse_records, "jobs": parse_jobs, "metrics": parse_metrics, "charts": parse_charts, "tabs": parse_tabs,
          "credentials": parse_credentials, "schedules": parse_schedules, "onboarding": parse_onboarding, "words": parse_words, "mcp": parse_mcp}
    spec = {}
    for k, v in secs.items():
        try: spec[k] = fn[k](v, c)
        except Exception as x:   # a parser bug must still name the section and its line, never end in a traceback
            c.err(v[0][0] if v else 0, f"## {k} could not be read ({type(x).__name__}: {x}); simplify the lines of this section")
    for kind, what in (("area", "records"), ("job", "jobs"), ("metric", "metrics"), ("chart", "charts"), ("tab", "tabs"),
                       ("credential", "credentials"), ("schedule", "schedules"), ("step", "onboarding")):
        items = spec.get(what) or []
        key = "id" if kind in ("tab", "step") else "name"
        seen = set()
        for it in items:
            if it[key] in seen: c.err(c.lines.get((kind, it[key]), 0), f"{kind} {it[key]} is declared twice")
            seen.add(it[key])
    if c.problems: raise BriefError(sorted(set(c.problems), key=lambda p: (int(re.match(r"line ([0-9]+)", p).group(1)) if re.match(r"line ([0-9]+)", p) else 0, p)))
    return spec, c


# ---- questions and the draft ---------------------------------------------------------------------------------------
def _q(qid, path, question, options, suggested, why=None):
    q = {"id": qid, "path": path, "question": question, "options": options, "suggested": suggested}
    if why: q["why"] = why
    return q

SECTION_Q = {
  "records":     ("The brief has no ## Records section, so this app keeps no records of its own (no findings, applications, tasks...). Is that right? "
                  "To add some, write a ## Records section (docs/INTAKE.md) and run intake again.", ["none"], "none"),
  "jobs":        ("The brief has no ## Jobs section, so this app runs no jobs (audits, scans, simulations). Is that right? "
                  "To add some, write a ## Jobs section and run intake again.", ["none"], "none"),
  "credentials": ("The brief has no ## Credentials section, so workspaces are asked for no keys or tokens. Is that right? "
                  "To ask for some, write a ## Credentials section and run intake again.", ["none"], "none"),
  "schedules":   ("The brief has no ## Schedules section, so nothing runs on a timer. Is that right? "
                  "To schedule jobs, write a ## Schedules section and run intake again.", ["none"], "none"),
  "tabs":        ("The brief has no ## Tabs section. Make the sidebar from what the pack declares (an overview of the charts, one tab per record area, "
                  "runs and reports when there are jobs, then usage, billing and profile), or keep the shell's own sidebar?", ["generated", "none"], "generated"),
  "charts":      ("The brief has no ## Charts section. Draw a simple overview (how many records each area holds, and each lifecycle's records by state), "
                  "or no charts?", ["generated", "none"], "generated"),
  "onboarding":  ("The brief has no ## Onboarding section. Make a setup checklist from what the pack declares (connect an MCP client, add a first record "
                  "of each private area, set each credential, run each job once), or none?", ["generated", "none"], "generated"),
}


def draft(spec, c, answers, ctx):
    """-> (pack.json dict, pending questions, resolved pack answers, defaults applied). ctx: pack_id, name, description."""
    pending, used = [], {}
    def ans(qid):
        if qid not in answers: return None
        v = answers[qid]
        if not isinstance(v, str) or CTRL.search(v) or "\n" in v or "\r" in v or len(v) > 500:
            raise BriefError([f"answer {qid}: one plain line of text (at most 500 characters, no line breaks or control characters)"])
        used[qid] = v.strip(); return v.strip()
    defaults = list(c.defaults) + ["version 0.1.0"]
    pack = {"$schema": "../pack.schema.json", "id": ctx["pack_id"], "name": ctx["name"], "version": "0.1.0", "description": ctx["description"]}
    choice = {}
    for s in ASKED:
        if s in spec: continue
        if s == "charts" and "metrics" in spec: choice[s] = "metrics_only"; continue
        text, opts, sug = SECTION_Q[s]
        a = ans(f"pack.{s}")
        if a is None: pending.append(_q(f"pack.{s}", f"pack.json {s}", text, opts, sug, "the brief has no such section"))
        elif a not in opts: raise BriefError([f"answer pack.{s}={a!r}: one of {', '.join(opts)}"])
        else: choice[s] = a
    if spec.get("words"): pack["words"] = spec["words"]

    # record areas
    areas = []
    for a in spec.get("records") or []:
        a = json.loads(json.dumps(a)); n = c.lines[("area", a["name"])]
        lc = a.pop("_lifecycle", None)
        if "role" not in a:
            v = ans(f"pack.records.{a['name']}.role")
            if v is None:
                sug = "check" if (lc or a.get("due")) else "source" if a.get("scope") == "platform" else "check"
                pending.append(_q(f"pack.records.{a['name']}.role", f"pack.json record_areas[{a['name']}].role",
                    f"What kind of records are {a['label']} (brief line {n})? check = something checked again and again (findings, controls, tasks); "
                    f"asset = something a workspace owns and keeps private (its applications, products), sealed with its own key; "
                    f"source = where requirements come from (regulations, a catalog), shared and read-only.", ["check", "asset", "source"], sug, "the brief does not give its role"))
            elif v not in ("check", "asset", "source"): raise BriefError([f"answer pack.records.{a['name']}.role={v!r}: check, asset or source"])
            else: a["role"] = v
        if "scope" not in a:
            if a.get("role") == "asset":
                a["scope"] = "workspace"; defaults.append(f"line {n}: area {a['name']} is an asset, so it is each workspace's own (the platform allows no shared asset area)")
            else:
                v = ans(f"pack.records.{a['name']}.scope")
                if v is None:
                    pending.append(_q(f"pack.records.{a['name']}.scope", f"pack.json record_areas[{a['name']}].scope",
                        f"Does each workspace keep its own {a['label']} (workspace), or is it one shared list that every workspace reads and only your staff edit (platform)? (brief line {n})",
                        ["workspace", "platform"], "workspace", "the brief does not say whose records they are"))
                elif v not in ("workspace", "platform"): raise BriefError([f"answer pack.records.{a['name']}.scope={v!r}: workspace or platform"])
                else: a["scope"] = v
        if not a.get("permissions"): defaults.append(f"line {n}: area {a['name']} has the platform's permissions (every role reads; members, billing and owners write{'; owners delete' if lc else ''})")
        elif a.get("scope") == "workspace":
            for act in ACTIONS:
                if act not in a["permissions"]: defaults.append(f"line {n}: area {a['name']}: who can {act} is the platform's default")
        for f in a["fields"]:
            if "type" not in f:
                qid = f"pack.records.{a['name']}.fields.{f['name']}.type"; v = ans(qid)
                if v is None:
                    pending.append(_q(qid, f"pack.json record_areas[{a['name']}].fields[{f['name']}].type",
                        f"What does the field {f['label']} of {a['label']} hold (brief line {c.lines[('field', a['name'], f['name'])]})? "
                        f"text, number, date, boolean (yes/no), person (someone who signs in), link, file, or json. For a list of choices or a pointer to another area, "
                        f"write `enum a, b, c` or `reference <area>` in the brief instead.", list(PLAIN_TYPES), "text", "the brief does not give its type"))
                elif v not in PLAIN_TYPES: raise BriefError([f"answer {qid}={v!r}: one of {', '.join(PLAIN_TYPES)} (an enum or a reference is written in the brief)"])
                else: f["type"] = v
        if lc:
            l = {"field": lc["field"]}
            enum = next((f for f in a["fields"] if f["name"] == lc["field"]), None)
            states = [o if isinstance(o, str) else o["value"] for o in (enum or {}).get("options") or []]
            if lc.get("initial"): l["initial"] = lc["initial"]
            elif states:
                l["initial"] = states[0]; defaults.append(f"line {lc.get('line', n)}: area {a['name']} starts each record in {states[0]!r} (the first option of {lc['field']})")
            trans = lc["transitions"]
            if not trans:
                qid = f"pack.records.{a['name']}.transitions"; v = ans(qid)
                if v is None:
                    pending.append(_q(qid, f"pack.json record_areas[{a['name']}].lifecycle.transitions",
                        f"{a['label']} has a lifecycle ({lc['field']}) but the brief lists no transitions. free = a record may move from any state to any other, "
                        f"by whoever may edit it; none = no lifecycle (the field is then an ordinary choice).", ["free", "none"], "free", "the brief lists no `- transition:` line"))
                elif v == "free": trans = [{"from": "*", "to": s} for s in states]
                elif v == "none": l = None
                else: raise BriefError([f"answer {qid}={v!r}: free or none"])
            if l is not None:
                l["transitions"] = trans
                a["lifecycle"] = l
        areas.append(a)
    if areas: pack["record_areas"] = areas

    # job kinds
    kinds = []
    for k in spec.get("jobs") or []:
        k = json.loads(json.dumps(k)); agent = k.pop("_agent"); n = c.lines[("job", k["name"])]
        if "runner" not in k: k["runner"] = "agent-workspace"; defaults.append(f"line {n}: job {k['name']} runs on the built-in agent-workspace runner (the only runner a declarative pack has)")
        for f in k.get("args") or []:
            if "type" not in f:
                qid = f"pack.jobs.{k['name']}.args.{f['name']}.type"; v = ans(qid)
                if v is None:
                    pending.append(_q(qid, f"pack.json job_kinds[{k['name']}].args[{f['name']}].type", f"What does the argument {f['label']} of {k['label']} hold (brief line {n})? "
                        f"For a record of an area, write `reference <area>` in the brief instead.", list(PLAIN_TYPES), "text", "the brief does not give its type"))
                elif v not in PLAIN_TYPES: raise BriefError([f"answer {qid}={v!r}: one of {', '.join(PLAIN_TYPES)}"])
                else: f["type"] = v
        # A commit is answered FOR a repository: a recorded commit never pins another repository the brief names later.
        repo = agent.get("repository") or (answers.get(f"pack.jobs.{k['name']}.repository") or "").strip() or None
        cq = f"pack.jobs.{k['name']}.commit"
        if "commit" not in agent and cq in answers and answers.get(f"{cq}_repository") not in (None, repo):
            answers = {x: y for x, y in answers.items() if x not in (cq, f"{cq}_repository")}
            stale = True
        else: stale = False
        for key, text, why in (("repository", f"Which repository holds the agent that runs {k['label']} (brief line {n})? An https:// address, e.g. https://github.com/<owner>/<repo>.git", "the brief names no repository"),
                               ("commit", f"Which commit of {repo or 'that repository'} should {k['label']} run? The full 40-character commit id (never a branch or tag: the run is pinned).",
                                "the repository changed since this commit was given" if stale else "the brief names no commit"),
                               ("command", f"Which command starts the agent for {k['label']}? Written as you would type it, e.g. node audit.mjs --app {{app}} (an argument list; no shell).", "the brief gives no command"),
                               ("validate", f"Which command checks {k['label']}'s output before it is kept? e.g. node validate.mjs", "the brief gives no validate command"),
                               ("write_back", f"Which folders of the checkout are the workspace {k['label']} keeps between runs? e.g. findings", "the brief gives no write back")):
            if key in agent: continue
            qid = f"pack.jobs.{k['name']}.{key}"; v = ans(qid)
            if v is None:
                pending.append(_q(qid, f"pack.json job_kinds[{k['name']}].agent.{key}", text, None, None, why)); continue
            # The answer is ONE value of the asked key: parsed by the same rules as a brief line, and only that key is taken.
            sub = _Ctx()
            got = parse_jobs([(1, f"### {k['name']}: x"), (2, f"- {key.replace('_', ' ')}: {v}")], sub)
            if sub.problems: raise BriefError([f"answer {qid}: {p_.split(': ', 1)[1]}" for p_ in sub.problems])
            if key not in got[0]["_agent"]: raise BriefError([f"answer {qid}: not a {key.replace('_', ' ')}"])
            agent[key] = got[0]["_agent"][key]
            if key == "commit" and repo: used[f"{cq}_repository"] = repo
        k["agent"] = agent
        kinds.append(k)
    if kinds: pack["job_kinds"] = kinds
    if spec.get("credentials"):
        creds = []
        for cr in json.loads(json.dumps(spec["credentials"])):
            if "bound_to" not in cr:
                qid = f"pack.credentials.{cr['name']}.bound_to"; v = ans(qid)
                assets = [a["name"] for a in areas if a.get("role") == "asset"]
                if v is None:
                    pending.append(_q(qid, f"pack.json credentials[{cr['name']}].bound_to",
                        f"Is {cr['label']} one value for the whole workspace, or one per {' / '.join(assets) or 'asset'} record (each application its own token)? (brief line {c.lines[('credential', cr['name'])]})",
                        ["workspace"] + [f"asset {x}" for x in assets], "workspace", "the brief does not say what the credential belongs to"))
                elif v == "workspace": cr["bound_to"] = "workspace"
                elif v.startswith("asset ") and v[6:] in assets: cr["bound_to"] = "asset"; cr["area"] = v[6:]
                else: raise BriefError([f"answer {qid}={v!r}: workspace or asset <one of {', '.join(assets) or 'no asset area'}>"])
            creds.append({k_: cr[k_] for k_ in ("name", "label", "help", "bound_to", "area", "environments", "deliver_as") if k_ in cr})
        pack["credentials"] = creds
    if spec.get("schedules"): pack["schedules"] = spec["schedules"]

    # metrics and charts
    metrics, charts = list(spec.get("metrics") or []), list(spec.get("charts") or [])
    if choice.get("charts") == "generated":
        for a in areas[:4]:
            metrics.append({"name": f"{a['name'][:56]}_total", "label": a["label"][:80], "over": a["name"]})
        if metrics:
            charts.append({"name": "headline", "title": "At a glance", "type": "number", "metrics": [m["name"] for m in metrics[:4]]})
        for a in areas:
            l = a.get("lifecycle")
            if not l: continue
            mn = f"{a['name'][:50]}_by_{l['field']}"[:63]
            metrics.append({"name": mn, "label": f"{a['label']} by {l['field'].replace('_', ' ')}"[:80], "over": a["name"], "group_by": l["field"]})
            charts.append({"name": f"{a['name'][:53]}_states"[:63], "title": f"{a['label']} by state"[:120], "type": "bar", "metrics": [mn]})
        defaults.append("charts: generated (a count per area, the first four as tiles; each lifecycle area by state)")
    elif choice.get("charts") == "metrics_only" and metrics:
        # The brief has metrics and no charts: each metric in the chart its shape takes (tiles for single values, a bar for
        # groups, a line for a series). Said, never silent.
        singles = [m for m in metrics if not m.get("group_by") and not m.get("by_time")]
        for i in range(0, len(singles), 4): charts.append({"name": f"tiles_{i // 4 + 1}", "title": "At a glance", "type": "number", "metrics": [m["name"] for m in singles[i:i + 4]]})
        for m in metrics:
            if m.get("by_time"): charts.append({"name": f"{m['name'][:56]}_chart", "title": m["label"], "type": "line" if not m.get("group_by") else "stacked_bar", "metrics": [m["name"]]})
            elif m.get("group_by"): charts.append({"name": f"{m['name'][:56]}_chart", "title": m["label"], "type": "bar", "metrics": [m["name"]]})
        defaults.append("charts: one per metric, by its shape (the brief has ## Metrics and no ## Charts)")
    if metrics: pack["metrics"] = metrics
    if charts: pack["charts"] = charts

    # tabs
    tabs = list(spec.get("tabs") or [])
    if choice.get("tabs") == "generated":
        group = ctx["name"][:40]
        if charts: tabs.append({"id": "overview", "kind": "overview", "label": "Overview", "icon": "dashboard", "group": group, "charts": [x["name"] for x in charts[:12]]})
        for a in areas:
            t = {"id": re.sub(r"_", "-", a["name"])[:41], "kind": "area", "area": a["name"], "group": group,
                 "icon": {"asset": "building", "source": "book"}.get(a.get("role"), "kanban")}
            if a.get("lifecycle"): t["views"] = ["table", "board", "detail"]
            if t["id"] in [x["id"] for x in tabs]: t["id"] = (t["id"][:33] + "-records")
            tabs.append(t)
        if kinds:
            tabs += [{"id": "runs", "kind": "runs", "icon": "play", "group": group}, {"id": "reports", "kind": "reports", "group": group}]
        ws = "Workspace"
        if spec.get("credentials"): tabs.append({"id": "credentials", "kind": "credentials", "group": ws})
        if kinds: tabs.append({"id": "schedules", "kind": "schedules", "group": ws})
        if any(a.get("due") for a in areas): tabs.append({"id": "notices", "kind": "notices", "group": ws})
        tabs += [{"id": "usage", "kind": "usage", "group": ws}, {"id": "billing", "kind": "billing", "group": ws, "roles": ["owner", "billing"]},
                 {"id": "profile", "kind": "profile", "group": ws}]
        defaults.append("tabs: generated from the declarations")
    if tabs: pack["tabs"] = tabs

    # onboarding
    steps = list(spec.get("onboarding") or [])
    if choice.get("onboarding") == "generated":
        steps.append({"id": "connect", "label": "Connect an MCP client", "done_when": "connected"})
        for a in areas:
            if a.get("scope") == "workspace" and a.get("role") == "asset":
                steps.append({"id": f"first_{a['name']}"[:63], "label": f"Add a first record to {a['label']}"[:120], "done_when": f"record:{a['name']}"})
        for cr in pack.get("credentials") or []:
            steps.append({"id": f"set_{cr['name']}"[:63], "label": f"Set {cr['label']}"[:120], "done_when": f"credential:{cr['name']}"})
        for k in kinds:
            steps.append({"id": f"run_{k['name']}"[:63], "label": f"Run {k['label']} once"[:120], "done_when": f"run:{k['name']}"})
        steps = steps[:30]
        defaults.append("onboarding: generated from the declarations")
    if steps: pack["onboarding"] = steps
    checks = [a["name"] for a in areas if a.get("role") == "check"]
    if kinds and checks:
        pack["run_results"] = {"check": checks[:20]}
        defaults.append(f"run_results: a run's results name a check of {', '.join(checks[:20])}")
    return pack, pending, used, defaults


# ---- validation: the JSON Schema (the subset pack.schema.json uses) and the build's own cross-checks -----------------
def _js_pattern(p):
    """A JSON Schema (ECMA-262) pattern as a Python one: `$` is the end of the string (never before a final newline)."""
    out, i, cls = [], 0, False
    while i < len(p):
        ch = p[i]
        if ch == "\\": out.append(p[i:i + 2]); i += 2; continue
        if ch == "[": cls = True
        elif ch == "]": cls = False
        elif ch == "$" and not cls: out.append(r"\Z"); i += 1; continue
        out.append(ch); i += 1
    return re.compile("".join(out), re.ASCII)

_PAT = {}
def _type_ok(t, v):
    return {"object": isinstance(v, dict), "array": isinstance(v, list), "string": isinstance(v, str), "boolean": isinstance(v, bool),
            "integer": isinstance(v, int) and not isinstance(v, bool) or isinstance(v, float) and v.is_integer(),
            "number": isinstance(v, (int, float)) and not isinstance(v, bool), "null": v is None}[t]

def schema_errors(s, v, path="pack.json"):
    """Every way `v` fails `s`: type, enum, const, pattern, min/maxLength, min/maxItems, minimum/maximum/exclusiveMinimum,
    properties, required, additionalProperties, propertyNames, items, anyOf, oneOf, not. Nothing else is used."""
    if s is True or s == {}: return []
    if s is False: return [f"{path}: not allowed"]
    errs = []
    if "not" in s and not schema_errors(s["not"], v, path): return [f"{path}: {s.get('description') or 'not allowed'}"]
    if "type" in s and not _type_ok(s["type"], v): return [f"{path}: expected {s['type']}"]
    if "const" in s and v != s["const"]: return [f"{path}: must be {json.dumps(s['const'])}"]
    if "enum" in s and v not in s["enum"]: return [f"{path}: one of {', '.join(map(str, s['enum']))}"]
    if isinstance(v, str):
        if "minLength" in s and len(v) < s["minLength"]: errs.append(f"{path}: at least {s['minLength']} characters")
        if "maxLength" in s and len(v) > s["maxLength"]: errs.append(f"{path}: at most {s['maxLength']} characters")
        if "pattern" in s:
            r = _PAT.get(s["pattern"]) or _PAT.setdefault(s["pattern"], _js_pattern(s["pattern"]))
            if not r.search(v): errs.append(f"{path}: {v[:60]!r} does not match {s['pattern']}")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]: errs.append(f"{path}: at least {s['minimum']}")
        if "maximum" in s and v > s["maximum"]: errs.append(f"{path}: at most {s['maximum']}")
        if "exclusiveMinimum" in s and v <= s["exclusiveMinimum"]: errs.append(f"{path}: above {s['exclusiveMinimum']}")
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]: errs.append(f"{path}: at least {s['minItems']} item(s)")
        if "maxItems" in s and len(v) > s["maxItems"]: errs.append(f"{path}: at most {s['maxItems']} items")
        if isinstance(s.get("items"), dict):
            for i, x in enumerate(v): errs += schema_errors(s["items"], x, f"{path}[{i}]")
    if isinstance(v, dict):
        props = s.get("properties") or {}
        for r in s.get("required") or []:
            if r not in v: errs.append(f"{path}: {r} is required")
        for k, x in v.items():
            if k in props: errs += schema_errors(props[k], x, f"{path}.{k}")
            elif "additionalProperties" in s: errs += schema_errors(s["additionalProperties"], x, f"{path}.{k}") if s["additionalProperties"] is not False else [f"{path}: unknown key {k}"]
            if "propertyNames" in s: errs += [e.replace(f"{path}.{k}", f"{path} key {k}") for e in schema_errors(s["propertyNames"], k, f"{path}.{k}")]
    # Of the alternatives, report the one the value meant: not one whose discriminator (a `const`) it does not carry.
    best = lambda alts: min(alts, key=lambda e: (any(x.startswith(f"{path}.") and ": must be " in x and x.count(".") == path.count(".") + 1 for x in e), len(e)))
    if "anyOf" in s:
        alts = [schema_errors(a, v, path) for a in s["anyOf"]]
        if all(alts): errs.append(f"{path}: fits none of its {len(alts)} forms ({best(alts)[0]})" if len(alts) > 1 else alts[0][0])
    if "oneOf" in s:
        alts = [schema_errors(a, v, path) for a in s["oneOf"]]
        ok = [a for a in alts if not a]
        if len(ok) != 1: errs += (best(alts) if not ok else [f"{path}: fits {len(ok)} of its forms; exactly one is allowed"])
    return errs


def cross_errors(p):
    """The build's own cross-checks (src/pack-api.ts validatePack, the RecordArea/Field/Tab/Metric refinements and
    src/metric-spec.ts) that a pack made from a brief can trip, so a draft that passes here does not fail at gen-packs."""
    errs = []; E = errs.append
    areas = {a.get("name"): a for a in p.get("record_areas") or []}
    def fields(a): return {f.get("name"): f for f in a.get("fields") or []}
    for a in p.get("record_areas") or []:
        w = f"record area {a.get('name')}"; fs = fields(a)
        if a.get("name") == "areas": E(f"{w}: the name areas is reserved")
        if a.get("role") == "asset" and a.get("scope") == "platform": E(f"{w}: an asset area holds a workspace's private data: workspace scope only")
        if a.get("sealed") and a.get("scope") == "platform": E(f"{w}: a shared (platform) area cannot be sealed")
        if a.get("sealed") is False and a.get("role") == "asset": E(f"{w}: an asset area is always sealed")
        if a.get("due") and (a.get("sealed") or a.get("role") == "asset"): E(f"{w}: a sealed area cannot have due dates")
        if a.get("due") and not (a.get("role") == "check" and a.get("scope") == "workspace"): E(f"{w}: due is for a check area of workspace scope")
        if a.get("due") and not (fs.get(a["due"].get("field")) or {}).get("type") == "date": E(f"{w}: due names {a['due'].get('field')}, which is not one of its date fields")
        for c_ in a.get("list_columns") or []:
            if c_ not in fs: E(f"{w}: column {c_} is not one of its fields")
        for act, rs in (a.get("permissions") or {}).items():
            if a.get("scope") == "platform" and act != "read": E(f"{w}: a shared (platform) area is written by platform staff only: declare who can read alone")
            if act != "read" and "viewer" in rs: E(f"{w}: viewer is read-only in the platform: a declaration cannot let a viewer {act}")
        for f in a.get("fields") or []:
            fw = f"{w} field {f.get('name')}"; t = f.get("type")
            if t == "enum" and not f.get("options"): E(f"{fw}: an enum field lists its options")
            if t != "enum" and f.get("options"): E(f"{fw}: options are for an enum field only")
            if t == "reference" and not f.get("to"): E(f"{fw}: a reference names the area it refers to")
            if t == "reference" and f.get("to") and f["to"] not in areas: E(f"{fw}: refers to {f['to']}, which this pack does not declare")
            if t == "reference" and f.get("to") in areas and a.get("scope") == "platform" and areas[f["to"]].get("scope") != "platform":
                E(f"{fw}: a shared area may refer only to shared areas")
            if t != "reference" and f.get("to"): E(f"{fw}: to is for a reference field only")
            if f.get("multiple") and t not in ("enum", "person", "reference", "file"): E(f"{fw}: multiple is for enum, person, reference and file fields")
            if ("min" in f or "max" in f) and t != "number": E(f"{fw}: min and max are for a number field")
            if "min" in f and "max" in f and f["min"] > f["max"]: E(f"{fw}: min is above max")
            if "max_length" in f and t != "text": E(f"{fw}: max_length is for a text field")
        lc = a.get("lifecycle")
        if lc:
            if a.get("scope") != "workspace": E(f"{w}: a lifecycle is for a workspace's own records")
            f = fs.get(lc.get("field"))
            if not f or f.get("type") != "enum" or f.get("multiple"): E(f"{w}: lifecycle field {lc.get('field')} must be one of its single-choice enum fields")
            else:
                states = {o if isinstance(o, str) else o.get("value") for o in f.get("options") or []}
                if lc.get("initial") not in states: E(f"{w}: initial {lc.get('initial')} is not one of {lc['field']}'s options")
                for t in lc.get("transitions") or []:
                    for s_ in ([] if t.get("from") == "*" else t.get("from") or []):
                        if s_ not in states: E(f"{w}: transition from {s_}, which is not one of {lc['field']}'s options")
                    if t.get("to") not in states: E(f"{w}: transition to {t.get('to')}, which is not one of {lc['field']}'s options")
    kinds = {k.get("name"): k for k in p.get("job_kinds") or []}
    creds = {c_.get("name"): c_ for c_ in p.get("credentials") or []}
    for k in p.get("job_kinds") or []:
        w = f"job kind {k.get('name')}"; ag = k.get("agent") or {}
        args = [x.get("name") for x in k.get("args") or []]
        if len(set(args)) != len(args): E(f"{w}: an argument is declared twice")
        for f in k.get("args") or []:
            if f.get("type") == "reference" and f.get("to") not in areas: E(f"{w} argument {f.get('name')}: refers to {f.get('to')}, which this pack does not declare")
        for x in k.get("credentials") or []:
            if x not in creds: E(f"{w}: names credential {x}, which this pack does not declare")
        if ag.get("timeout_seconds", 3600) > k.get("token_lifetime_seconds", 3600): E(f"{w}: the agent's timeout is longer than its token lifetime (the run's deadline)")
        declared = set((ag.get("args") or {}).keys())
        for i, part in enumerate(ag.get("command") or []):
            for ph in re.findall(r"\{([^{}]*)\}", part):
                if ph not in declared: E(f"{w}: command {{{ph}}} is not a declared argument (`- arg {ph}: ...`)")
                if i == 0: E(f"{w}: the program (the command's first word) takes no placeholder")
        for what in ("setup", "validate"):
            for part in (ag.get(what) or {}).get("command") or []:
                if re.search(r"\{[^{}]*\}", part): E(f"{w}: the {what} command takes no placeholders: it runs the same for every run")
        for nm, v in (ag.get("env") or {}).items():
            for ph in re.findall(r"\{([^{}]*)\}", v):
                g = GATEWAY.fullmatch(ph)
                if not g and ph not in declared: E(f"{w}: env {nm} {{{ph}}} is neither a declared argument nor a gateway value")
                if g and not k.get("providers"): E(f"{w}: env {nm} {{{ph}}} needs a gateway provider (providers)")
                if g and g.group(2) and g.group(2) not in (k.get("providers") or []): E(f"{w}: env {nm}: {g.group(2)} is not one of its providers")
        wb = ag.get("write_back") or []
        for x in wb:
            if x.startswith("/") or "\\" in x or any(s in ("", ".", "..") for s in x.split("/")) or re.search(r"[*?\[\]{}]", x): E(f"{w}: write back {x!r} is a plain relative path inside the checkout")
            for y in wb:
                if x != y and y.startswith(x + "/"): E(f"{w}: write back {y} is inside {x}")
        if len(set(wb)) != len(wb): E(f"{w}: a write back path is listed twice")
        for x in (ag.get("strip") or []) + (ag.get("record") or []) + ([ag["results"]] if ag.get("results") else []):
            if x.startswith("/") or "\\" in x or any(s_ in ("", ".", "..") for s_ in x.split("/")) or re.search(r"[\x00-\x1f\[\]{}]", x): E(f"{w}: {x!r} is a relative path inside the checkout (no .., no leading /, no [ ] {{ }})")
        if ag.get("results") and re.search(r"[*?]", ag["results"]): E(f"{w}: results is a plain path (no glob characters)")
        for an, spec in (ag.get("args") or {}).items():
            if "pattern" in spec:
                try: re.compile(spec["pattern"])
                except re.error: E(f"{w}: argument {an}'s pattern is not a regular expression")
    for c_ in p.get("credentials") or []:
        w = f"credential {c_.get('name')}"
        if (c_.get("bound_to") == "workspace") != ("area" not in c_): E(f"{w}: area names the asset area for an asset or environment binding (and only then)")
        if "area" in c_ and (areas.get(c_.get("area")) or {}).get("role") != "asset": E(f"{w}: bound to {c_.get('area')}, which is not one of this pack's asset areas")
        if c_.get("environments") is not None and c_.get("bound_to") != "environment": E(f"{w}: environments is for an environment binding only")
        if RESERVED_ENV.fullmatch(str((c_.get("deliver_as") or {}).get("env") or "")): E(f"{w}: {c_['deliver_as']['env']} is a variable the shell sets for every run")
    seen = {}
    for c_ in p.get("credentials") or []:
        d = json.dumps(c_.get("deliver_as"), sort_keys=True)
        if d in seen: E(f"credentials {seen[d]} and {c_.get('name')} both deliver to {d}")
        seen[d] = c_.get("name")
    for s in p.get("schedules") or []:
        if s.get("job_kind") not in kinds: E(f"schedule {s.get('name')}: names job kind {s.get('job_kind')}, which this pack does not declare")
        a = (s.get("assets") or {}).get("area")
        if a and (areas.get(a) or {}).get("role") != "asset": E(f"schedule {s.get('name')}: runs over {a}, which is not one of this pack's asset areas")
    for st in p.get("onboarding") or []:
        what, _, arg = (st.get("done_when") or "").partition(":")
        if what == "run" and arg not in kinds: E(f"onboarding step {st.get('id')}: names job kind {arg}, which this pack does not declare")
        if what == "credential" and arg not in creds: E(f"onboarding step {st.get('id')}: names credential {arg}, which this pack does not declare")
        if what == "record" and arg not in areas: E(f"onboarding step {st.get('id')}: names record area {arg}, which this pack does not declare")
        elif what == "record" and areas[arg].get("scope") != "workspace": E(f"onboarding step {st.get('id')}: record:{arg} must name a workspace area")
    for x in (p.get("run_results") or {}).get("check") or []:
        if (areas.get(x) or {}).get("role") != "check": E(f"run_results.check names {x}, which is not one of this pack's check areas")
    metrics = {m.get("name"): m for m in p.get("metrics") or []}
    RUNS = {"run_results": {"status": {"type": "enum", "options": ["pass", "fail", "error", "not_applicable", "unknown"]}, "check": {"type": "reference"},
                            "asset": {"type": "reference"}, "source": {"type": "reference"}, "check_area": {"type": "text"}, "created": {"type": "time"}},
            "runs": {"status": {"type": "enum", "options": ["queued", "running", "succeeded", "failed", "cancelled"]}, "kind": {"type": "text"},
                     "error_kind": {"type": "enum", "options": ["infrastructure", "run", "validation", "timeout", "cancelled"]},
                     "cost_usd": {"type": "number"}, "created": {"type": "time"}, "started": {"type": "time"}, "ended": {"type": "time"}}}
    def column(over, name):
        """src/metric-spec.ts columnOf: -> a column {type, options?, multiple?} or a reason (a string)."""
        name = str(name)
        if over in RUNS:
            if over == "run_results" and name.startswith("detail."): return {"type": "text"}
            return RUNS[over].get(name) or f"{over} has no column {name} (it has {', '.join(RUNS[over])}{', detail.<word>' if over == 'run_results' else ''})"
        a = areas.get(over)
        if not a: return f"{over} is not an area of this pack"
        if name in ("created", "updated"): return {"type": "time"}
        if name.startswith("detail."): return f"detail.<word> is for run_results; area {over} has fields"
        f = fields(a).get(name)
        if not f: return f"area {over} has no field {name}"
        t = f.get("type"); mult = bool(f.get("multiple")) or t == "link"
        if t == "enum": return {"type": "enum", "options": [o if isinstance(o, str) else o.get("value") for o in f.get("options") or []], "multiple": mult}
        if t == "date": return {"type": "time"}
        if t in ("number", "boolean", "person", "text"): return {"type": t, "multiple": mult}
        if t in ("reference", "link"): return {"type": "reference", "multiple": mult}
        return f"field {name} of area {over} is {t}: a metric reads text, enum, number, date, boolean, person and reference fields"
    def point(over, pt):
        """src/metric-spec.ts pointOf."""
        pt = str(pt)
        if pt.startswith("state:"):
            a = areas.get(over); v = pt[6:]
            if not a: return f"state:<value> is for a record area with a lifecycle; {over} has none"
            lc = a.get("lifecycle")
            if not lc: return f"area {over} has no lifecycle, so it has no state times ({pt})"
            col = column(over, lc.get("field"))
            if isinstance(col, str) or v not in (col.get("options") or []): return f"{pt}: {v} is not a state of area {over}"
            if a.get("scope") != "workspace": return f"{pt}: a shared area's records have no states"
            return {"type": "time"}
        col = column(over, pt)
        if isinstance(col, str): return col
        return col if col["type"] == "time" else f"{pt} is not a date or a time"
    for m in p.get("metrics") or []:
        w = f"metric {m.get('name')}"; over = m.get("over"); meas = m.get("measure", "count")
        if m.get("name") == "metrics": E(f"{w}: the name metrics is reserved")
        if over not in areas and over not in RUNS: E(f"{w}: over {over}, which is neither a record area of this pack nor run_results or runs"); continue
        for key, ms in (("field", ("sum", "average")), ("rate", ("rate",)), ("duration", ("duration",))):
            if meas in ms and key not in m: E(f"{w}: a {meas} metric names its {key}")
            if key in m and meas not in ms: E(f"{w}: {key} is for a {' or '.join(ms)} metric")
        if m.get("field"):
            col = column(over, m["field"])
            if isinstance(col, str): E(f"{w}: the {meas} of {m['field']}: {col}")
            elif col["type"] != "number": E(f"{w}: a {meas} reads a number field; {m['field']} is {col['type']}")
        for cd in (m.get("where") or []) + ((m.get("rate") or {}).get("where") or []):
            col = column(over, cd.get("field"))
            if isinstance(col, str): E(f"{w}: where: {col}"); continue
            op = cd.get("op"); vals = cd.get("value") if isinstance(cd.get("value"), list) else [cd.get("value")] if "value" in cd else []
            if op in ("lt", "lte", "gt", "gte"):
                if col["type"] not in ("number", "time"): E(f"{w}: {op} compares numbers or dates; {cd['field']} is {col['type']}")
                elif col["type"] == "number" and not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals): E(f"{w}: {cd['field']} is a number: compare it with a number")
                elif col["type"] == "time" and not all(isinstance(v, str) for v in vals): E(f"{w}: {cd['field']} is a date: compare it with a date, today or now")
                continue
            if op in ("empty", "not_empty"): continue
            if col["type"] in ("time", "number"): E(f"{w}: {cd['field']} is a {'date' if col['type'] == 'time' else 'number'}: use <, <=, > or >="); continue
            if col.get("multiple") and op in ("ne", "not_in"): E(f"{w}: {cd['field']} holds a list: use = or in, is empty or is not empty")
            if col["type"] == "boolean" and any(not isinstance(v, bool) for v in vals): E(f"{w}: {cd['field']} is true or false")
            if col["type"] != "boolean" and any(not isinstance(v, str) for v in vals): E(f"{w}: {cd['field']} is compared with words")
            if col["type"] == "enum":
                for v in vals:
                    if v not in col["options"]: E(f"{w}: {v} is not one of {cd['field']}'s options ({', '.join(map(str, col['options']))})")
        if m.get("duration"):
            for end in (m["duration"].get("from"), m["duration"].get("to")):
                pt = point(over, end)
                if isinstance(pt, str): E(f"{w}: duration: {pt}")
        bt = m.get("by_time") or {}
        if bt:
            pt = point(over, bt.get("at"))
            if isinstance(pt, str): E(f"{w}: per {bt.get('every')} of: {pt}")
            if bt.get("last") and bt["last"] > {"day": 400, "week": 260, "month": 120}.get(bt.get("every"), 400): E(f"{w}: per {bt.get('every')} last {bt['last']} is too long")
        g = m.get("group_by")
        if isinstance(g, dict):
            if bt: E(f"{w}: a series groups by a field, not by due dates")
            pt = point(over, g.get("due"))
            if isinstance(pt, str) or g.get("due") in ("created", "updated"): E(f"{w}: group by due {g.get('due')}: not a date field of {over}")
        elif g is not None:
            col = column(over, g)
            if isinstance(col, str): E(f"{w}: group by: {col}")
            elif col.get("multiple"): E(f"{w}: group by {g} holds a list: group by a single-valued field")
            elif col["type"] in ("time", "number"): E(f"{w}: group by {g}: group by a word field (use per day/week/month for dates)")
            elif bt and not ((col["type"] == "enum" and len(col.get("options") or []) <= 8) or col["type"] == "boolean" or g in ("status", "kind")):
                E(f"{w}: a series grouped by {g} could have many groups: group a series by an enum of at most 8 options, a true/false field, a status or a kind")
    def shape(m): return "series_by_group" if m.get("by_time") and m.get("group_by") else "series" if m.get("by_time") else "groups" if m.get("group_by") else "single"
    for ch in p.get("charts") or []:
        w = f"chart {ch.get('name')}"; ms = [metrics.get(x) for x in ch.get("metrics") or []]
        if ch.get("type") in ("donut", "pie"): E(f"{w}: {ch['type']} charts are not offered: show part-to-whole as a stacked_bar and close values as a bar"); continue
        if ch.get("type") not in CHART_TYPES: E(f"{w}: type is one of {', '.join(CHART_TYPES)}")
        for x, m in zip(ch.get("metrics") or [], ms):
            if not m: E(f"{w}: shows metric {x}, which this pack does not declare")
        if not all(ms): continue
        t = ch.get("type"); sh = [shape(m) for m in ms]
        if t == "number" and (any(s != "single" for s in sh) or len(ms) > 4): E(f"{w}: a number chart shows 1 to 4 single values (no group by, no per)")
        if t == "bar" and (len(ms) != 1 or sh[0] not in ("groups", "series")): E(f"{w}: a bar chart shows one metric by group or by time (a group over time: stacked_bar)")
        tk = lambda m: json.dumps({k_: (m.get("by_time") or {}).get(k_) for k_ in ("every", "last")})
        if t in ("line", "area") and not ((1 <= len(ms) <= 4 and all(s == "series" for s in sh) and len({tk(m) for m in ms}) == 1) or (len(ms) == 1 and sh[0] == "series_by_group")):
            E(f"{w}: a {t} chart shows 1 to 4 metrics over the same time buckets, or one per day/week/month and grouped")
        if t == "stacked_bar" and not ((len(ms) == 1 and sh[0] == "series_by_group") or (2 <= len(ms) <= 6 and len({json.dumps(m.get("group_by")) for m in ms}) == 1 and all(m.get("group_by") for m in ms))):
            E(f"{w}: a stacked bar shows one metric grouped per day/week/month, or 2 to 6 metrics with the same group by")
        if t == "table" and len({(sh_, json.dumps(m.get("group_by")), tk(m)) for sh_, m in zip(sh, ms)}) != 1: E(f"{w}: a table's metrics share their grouping")
        if t == "stacked_bar" and any(m.get("measure", "count") not in ("count", "sum") for m in ms): E(f"{w}: stacked parts are counts or sums")
        if ch.get("palette") == "ordinal":
            g = ms[0].get("group_by"); f = column(ms[0].get("over"), g) if isinstance(g, str) else None
            if not f or f.get("type") != "enum": E(f"{w}: an ordinal palette colours the ordered options of one metric's enum group by")
            elif len(f.get("options") or []) > 5: E(f"{w}: an ordinal palette has 5 steps; {g} has {len(f['options'])} options")
    charts = {ch.get("name") for ch in p.get("charts") or []}
    has_due = any(a.get("due") for a in areas.values())
    tids, labels = set(), {}
    for t in p.get("tabs") or []:
        w = f"tab {t.get('id')}"; k = t.get("kind")
        if t.get("id") in tids: E(f"{w} is declared twice")
        tids.add(t.get("id"))
        lab = (t.get("label") or ((areas.get(t.get("area")) or {}).get("label") if k == "area" else None) or k or "").strip().lower()
        if (t.get("group"), lab) in labels: E(f"{w}: the sidebar already has \"{lab}\" in {t.get('group') or 'its group'} (tab {labels[(t.get('group'), lab)]})")
        labels.setdefault((t.get("group"), lab), t.get("id"))
        if k == "area" and t.get("timeline_by") and t.get("area") in areas:
            pt = point(t["area"], t["timeline_by"])
            if isinstance(pt, str): E(f"{w}: timeline by: {pt}")
        if k == "area" and t.get("area") not in areas: E(f"{w}: shows area {t.get('area')}, which this pack does not declare")
        if k != "area":
            for x in ("area", "views", "board_by", "timeline_by"):
                if x in t: E(f"{w}: {x} is for an area tab")
        if k == "overview" and not t.get("charts"): E(f"{w}: an overview tab lists its charts")
        if t.get("charts") and k not in ("overview", "area"): E(f"{w}: charts are for an overview or an area tab")
        for x in t.get("charts") or []:
            if x not in charts: E(f"{w}: shows chart {x}, which this pack does not declare")
        if k == "page" and not t.get("page"): E(f"{w}: a page tab names one of the pack's pages")
        if k == "page" and not any(pg.get("id") == t.get("page") for pg in p.get("pages") or []): E(f"{w}: the pack has no page {t.get('page')}")
        if t.get("views") and len(set(t["views"])) != len(t["views"]): E(f"{w}: a view is listed twice")
        if t.get("board_by") and "board" not in (t.get("views") or []): E(f"{w}: board by is for a tab with the board view")
        if t.get("timeline_by") and "timeline" not in (t.get("views") or []): E(f"{w}: timeline by is for a tab with the timeline view")
        if k == "area" and t.get("area") in areas and "board" in (t.get("views") or []):
            a = areas[t["area"]]; by = t.get("board_by") or (a.get("lifecycle") or {}).get("field")
            f = fields(a).get(by)
            if not by: E(f"{w}: a board needs board by (an enum field) when {a['name']} has no lifecycle")
            elif not f or f.get("type") != "enum" or f.get("multiple"): E(f"{w}: board by {by} must be a single-choice enum field of {a['name']}")
        if k in ("runs", "reports", "schedules") and not kinds: E(f"{w}: the pack has no job kind, so there are no runs to show")
        if k == "credentials" and not creds: E(f"{w}: the pack declares no credential")
        if k == "notices" and not has_due: E(f"{w}: the pack has no due dates, so it has no notices")
        if k == "area" and t.get("area") in areas:
            rd = set((areas[t["area"]].get("permissions") or {}).get("read") or ROLES)
            if t.get("roles") and not rd & set(t["roles"]): E(f"{w}: no role may read what it shows")
    errs += mcp_errors(p)
    return errs


def node_check(pack, codebase):
    """The codebase's own check (src/pack-manifest.ts checkPackJson, zod), when this machine has its dependencies
    installed: -> (ran, problems). Nothing is installed or downloaded: without node_modules it does not run."""
    tsx = os.path.join(codebase, "node_modules", ".bin", "tsx")
    if not (os.path.isfile(tsx) and shutil.which("node")): return False, []
    d = tempfile.mkdtemp(prefix="brief-pack-")
    try:
        pj = os.path.join(d, "pack.json"); json.dump(pack, open(pj, "w"))
        script = os.path.join(d, "check.mts")
        open(script, "w").write(
            "import { readFileSync } from 'node:fs';\n"
            f"import {{ checkPackJson, compileDeclarations }} from {json.dumps(os.path.join(os.path.realpath(codebase), 'src', 'pack-manifest.ts'))};\n"
            "const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));\n"
            "try { checkPackJson(j); compileDeclarations(j); console.log(JSON.stringify({ ok: true })); }\n"
            "catch (e) { console.log(JSON.stringify({ problems: e.problems ?? [String(e.message ?? e)] })); }\n")
        r = subprocess.run([tsx, script, pj], cwd=codebase, capture_output=True, text=True, timeout=120)
        try: out = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError): return False, []
        return True, list(out.get("problems") or [])
    except (OSError, subprocess.SubprocessError): return False, []
    finally: shutil.rmtree(d, ignore_errors=True)


def validate(pack, schema, codebase=None):
    """-> (problems, how) : the schema, the cross-checks, and the codebase's own zod check when it can run."""
    problems = schema_errors(schema, pack) + cross_errors(pack)
    how = ["pack.schema.json (Python, the subset it uses)", "the build's cross-checks (Python)"]
    if codebase and not problems:
        ran, more = node_check(pack, codebase)
        if ran: how.append("src/pack-manifest.ts checkPackJson (node)"); problems += more
        else: how.append("not the codebase's own zod check: its node_modules are not installed here")
    return problems, how


def mcp_reserved(schema):
    m = (schema.get("properties") or {}).get("mcp")
    return isinstance(m, dict) and "not" in m


def dumps(o):
    return json.dumps(o, indent=2, ensure_ascii=False) + "\n"

def sha(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()
