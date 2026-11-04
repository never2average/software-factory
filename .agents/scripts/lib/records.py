"""mold_v0's record contract (mold_v0-222; docs/RECORDS.md), as the factory reads it.

Every record area of a mold_v0 app has a contract: where its rows come from (provenance), who may do each action
(read, create, update, move, delete, reveal, export, import) and its list's primary action (or why it has none). A pack
may declare it (pack.json record_areas[].contract, the mold's src/pack-api.ts RecordContractSchema); this module derives
it from the rest of the declaration exactly as the shell behaves, so

  resolve(docs)   gives each area's contract: the declared one when there is one, else the derived one
  check(docs)     the problems that keep an app's records from being complete:
                    - a declared contract that says something the build does not do (each action, the primary action,
                      the provenance), in plain words with what the build gives and why
                    - an area that declares none where the derivation cannot decide: nothing in the declaration
                      writes its rows (say provenance, e.g. run), or its list tab gets no primary action and no reason

What is derived (the shell's own rules, each named where it lives in molds/mold_v0/codebase):
  read      permissions.read, else every role (src/record-areas.ts allowedRoles); none when the pack withholds both its
            list and get tools (src/mcp-withheld.ts)
  export    as read (the console's Export CSV pages through the list routes; export_<area> needs read); none when
            the list or export tool is withheld
  create, update, move, delete
            a workspace area: permissions, else member, billing, owner; delete as update, or the owner alone on an area
            with a lifecycle; never viewer. None for an area read from workspace files or an API, for a write tool
            the pack withholds (exclude, include, admin_only), for move without a lifecycle, for update, move and
            delete on an append-only area. A shared area: {staff: library} (create, update) and {staff: delete}
            (src/record-routes.ts _console form; the admin tools) unless read only or withheld; move none
  reveal    a workspace area with encrypted fields: each field's reveal_roles, else the update roles (joined); none
            without one, or when the reveal tool is withheld
  import    a shared area: {staff: library} where staff may create and update (src/record-import.ts); a workspace
            area: none (the shell has no import for a workspace's own records yet)
  provenance
            repository (the area's repository); staff (a shared area staff may write; a workspace area whose write
            tool is admin_only); people (a workspace area its people may create, update or move); intake (the pack's
            email.intake.area). run is never derived: the pack's own code may declare it (a pack with an entry)
  primary action
            every list that shows the area (mold_v0-237): each area tab of the pack whose own area it is (tab.area, or
            the first of tab.areas): its action, or action: false with its reason, else the shell's default
            (src/metric-spec.ts tabAction: create_record for a workspace area of the shell's tables its people may add
            to; none otherwise); and its Settings tab (settings: {group}) or, when no tab shows it, its Records page
            (/app/records/<name>): the area's own action: false with its action_reason, else the same default
            (src/metric-spec.ts areaListAction), else none for what the area is (shared, a repository's, its create
            withheld). A declared primary_action speaks for every one of them.
Standard library only.
"""
import json

ROLES = ("viewer", "member", "billing", "owner")
WRITE_ROLES = ("member", "billing", "owner")
ACTIONS = ("read", "create", "update", "move", "delete", "reveal", "export", "import")
PROVENANCES = ("staff", "people", "repository", "intake", "run")
PRIMARY = ("create_record", "start_run", "link")
READ_ONLY_KINDS = ("workspace_files", "http_api")
SETTINGS_GROUPS = {"access": "Access", "connections": "Connections", "automation": "Automation", "data_trust": "Data & trust"}


def _roles(rs):
    """Roles in the platform's order, each once."""
    rs = [r for r in rs or [] if r in ROLES]
    return [r for r in ROLES if r in rs]

def none(reason): return {"none": reason}
def is_none(g): return isinstance(g, dict) and "none" in g
def _same(a, b):
    """Whether two grants say the same: the same roles (any order), the same staff permission, or both none."""
    if isinstance(a, list) and isinstance(b, list): return set(a) == set(b)
    if is_none(a) and is_none(b): return True
    return isinstance(a, dict) and isinstance(b, dict) and "staff" in a and a.get("staff") == b.get("staff")

def words(g):
    """A grant in words: "member, billing, owner", "staff with library", "none (why)"."""
    if isinstance(g, list): return ", ".join(g) or "nobody"
    if isinstance(g, dict) and "staff" in g: return f"staff with {g['staff']}"
    if is_none(g): return f"none ({g['none']})"
    return json.dumps(g)[:80]


class _Pack:
    def __init__(self, doc):
        self.doc = doc
        self.id = doc.get("id") or "pack"
        mcp = doc.get("mcp") if isinstance(doc.get("mcp"), dict) else {}
        self.prefix = mcp.get("prefix") or self.id
        self.include = set(mcp["include"]) if isinstance(mcp.get("include"), list) else None
        self.exclude = set(mcp.get("exclude") or [])
        self.admin_only = set(mcp.get("admin_only") or [])
        self.repos = {k: (v or {}).get("kind") for k, v in (doc.get("repositories") or {}).items() if isinstance(v, dict)}
        intake = ((doc.get("email") or {}).get("intake") or {}) if isinstance(doc.get("email"), dict) else {}
        self.intake = intake.get("area") if isinstance(intake, dict) else None
        self.tabs = [t for t in doc.get("tabs") or [] if isinstance(t, dict)]
        self.code = isinstance(doc.get("entry"), str)

    def tool(self, op, area): return f"{self.prefix}_{op}_{area}"
    def withheld(self, op, area):
        """The generated tool is off its door (src/mcp-catalog.ts: exclude, or left out of include)."""
        n = self.tool(op, area)
        return n in self.exclude or (self.include is not None and n not in self.include)
    def off_workspace(self, op, area):
        """Withheld from a workspace's door: excluded, or moved to the admin MCP (admin_only)."""
        return self.withheld(op, area) or self.tool(op, area) in self.admin_only


def _derive(p, a):
    """(contract, why): the area's contract as the build gives it, and the reasons behind each 'none'."""
    name, shared = a.get("name"), a.get("scope") == "platform"
    kind = p.repos.get(a.get("repository")) if a.get("repository") else None
    read_only = kind in READ_ONLY_KINDS
    perms = a.get("permissions") if isinstance(a.get("permissions"), dict) else {}
    lifecycle, append_only = isinstance(a.get("lifecycle"), dict), a.get("append_only") is True
    encrypted = [f for f in a.get("fields") or [] if isinstance(f, dict) and f.get("encrypted") is True]
    src = f"its rows come from repository {a.get('repository')} ({kind}), read only"
    g = {}
    read_roles = _roles(perms.get("read") or ROLES)
    g["read"] = none("the pack withholds its list and get tools (mcp)") if p.off_workspace("list", name) and p.off_workspace("get", name) else read_roles
    g["export"] = (none("the pack withholds its list or export tool (mcp)") if p.off_workspace("list", name) or p.off_workspace("export", name)
                   else g["read"])
    if shared:
        def staff(op, perm):
            if read_only: return none(src)
            if p.withheld(op, name): return none(f"the pack withholds its {op} tool (mcp), and with it the staff route")
            return {"staff": perm}
        g["create"], g["update"], g["delete"] = staff("admin_create", "library"), staff("admin_update", "library"), staff("admin_delete", "delete")
        g["move"] = none("a shared area has no lifecycle")
        g["reveal"] = none("a shared area has no encrypted field")
        g["import"] = none(src) if read_only else (none("staff may not both create and update it (a tool is withheld)") if is_none(g["create"]) or is_none(g["update"]) else {"staff": "library"})
        return g
    update_roles = _roles(perms.get("update") or WRITE_ROLES)
    def write(op, roles):
        if read_only: return none(src)
        if op in ("update", "move") and append_only: return none("append-only: a record is never changed")
        if op == "move" and not lifecycle: return none("no lifecycle: a record has no state to move")
        if p.off_workspace(op, name): return none(f"the pack withholds its {op} tool from a workspace (mcp{' admin_only' if p.tool(op, name) in p.admin_only else ''})")
        return [r for r in _roles(roles) if r != "viewer"]
    g["create"] = write("create", perms.get("create") or WRITE_ROLES)
    g["update"] = write("update", perms.get("update") or WRITE_ROLES)
    g["move"] = write("move", perms.get("move") or WRITE_ROLES)
    ops = ["create", "update"] + (["move"] if lifecycle else [])
    if read_only: g["delete"] = none(src)
    elif append_only: g["delete"] = none("append-only: a record is never deleted")
    elif all(p.off_workspace(o, name) for o in ops): g["delete"] = none("the pack withholds every write of it from a workspace (mcp), its delete with them")
    else: g["delete"] = [r for r in _roles(perms.get("delete") or (["owner"] if lifecycle else update_roles)) if r != "viewer"]
    if not encrypted: g["reveal"] = none("no encrypted field")
    elif p.off_workspace("reveal", name): g["reveal"] = none("the pack withholds its reveal tool (mcp)")
    else: g["reveal"] = _roles([r for f in encrypted for r in (f.get("reveal_roles") or update_roles)])
    g["import"] = none("the shell has no import for a workspace's own records (staff import shared areas only)")
    return g

def _provenance(p, a, g):
    """(certain, possible): what the declaration says writes the area's rows, and what else may (run, by the pack's code)."""
    shared, name = a.get("scope") == "platform", a.get("name")
    kind = p.repos.get(a.get("repository")) if a.get("repository") else None
    out = []
    if shared and (isinstance(g["create"], dict) and "staff" in g["create"] or isinstance(g["update"], dict) and "staff" in g["update"]): out.append("staff")
    if not shared and kind not in READ_ONLY_KINDS and any(p.tool(op, name) in p.admin_only for op in ("create", "update", "move")): out.append("staff")
    if not shared and any(isinstance(g[k], list) and g[k] for k in ("create", "update", "move")): out.append("people")
    if a.get("repository"): out.append("repository")
    if not shared and p.intake == name: out.append("intake")
    possible = list(out) + (["run"] if not shared and kind not in READ_ONLY_KINDS and p.code else [])
    return [x for x in PROVENANCES if x in out], [x for x in PROVENANCES if x in possible]

def _own_tabs(p, name):
    """Every area tab of the pack whose own area it is (tab.area, or the first of tab.areas), in order."""
    out = []
    for t in p.tabs:
        if t.get("kind") != "area": continue
        own = t.get("area") or ((t.get("areas") or [{}])[0] or {}).get("area")
        if own == name: out.append(t)
    return out

def _own_tab(p, name):
    ts = _own_tabs(p, name)
    return ts[0] if ts else None

def _default(a, g):
    """The shell's own create action for a list of the area, or {"none": why} (src/metric-spec.ts createDefault)."""
    name = a.get("name")
    if a.get("scope") != "workspace": return none(f"{name} is shared by every workspace (read-only to them)")
    if a.get("repository"): return none(f"{name} is read from repository {a['repository']}, not added by hand")
    if not isinstance(g["create"], list) or not g["create"]: return none(f"{name}'s create tool is not offered to a workspace")
    return "create_record"

def _primaries(p, a, g):
    """[(value, where, declared)] for every list that shows the area (mold_v0-237): the primary action ("create_record"
    ...) or {"none": reason}; where the list is drawn; declared: True when the pack chose it (an action, or action: false
    with a reason) or the area's own list has none for what the area is, False when a tab takes the shell's default."""
    name, label = a.get("name"), a.get("label") or a.get("name")
    out = []
    for t in _own_tabs(p, name):
        where, act = f"tab {t.get('id')}", t.get("action")
        if act is False: out.append((none(t.get("reason") or "declared none"), where, True))
        elif isinstance(act, dict): out.append((act.get("kind"), where, True))
        else:
            d = _default(a, g)
            out.append((d, where, False))
    if isinstance(a.get("settings"), dict):
        grp = SETTINGS_GROUPS.get(a["settings"].get("group"), a["settings"].get("group"))
        where = f"Settings › {grp} › {a['settings'].get('label') or label}"
    elif not out: where = f"/app/records/{name}"
    else: return out
    # Its own list (src/metric-spec.ts areaListAction): action: false and its reason, else the shell's default; a list
    # nobody in a workspace may add to says why by what the area is.
    if a.get("action") is False: out.append((none(a.get("action_reason") or "declared none"), where, True))
    else: out.append((_default(a, g), where, True))
    return out

def _primary(p, a, g):
    """(value, where, declared) of the area's first list (see _primaries)."""
    return _primaries(p, a, g)[0]

def _pwords(v): return v if isinstance(v, str) else words(v)
def _same_primary(a, b): return (is_none(a) and is_none(b)) or (isinstance(a, str) and a == b)


def _area_facts(a):
    fields = [f for f in a.get("fields") or [] if isinstance(f, dict)]
    return {
        "fields": [f"{f.get('name')}:{f.get('type', 'text')}{'[]' if f.get('multiple') else ''}{' encrypted' if f.get('encrypted') else ''}"
                   f"{' searchable' if f.get('searchable') else ''}{' preview' if f.get('preview') else ''}" for f in fields],
        "list_columns": a.get("list_columns") or [f.get("name") for f in fields[:4]],
        "clocks": [c.get("name") for c in a.get("clocks") or [] if isinstance(c, dict)],
        "due": (a.get("due") or {}).get("field") if isinstance(a.get("due"), dict) else None,
        "append_only": a.get("append_only") is True, "chain": a.get("chain") is True,
        "documents": [f.get("name") for f in fields if f.get("type") == "file" or f.get("preview") == "document"],
        "settings": a.get("settings") if isinstance(a.get("settings"), dict) else None,
    }

def _tab_facts(p, name):
    t = _own_tab(p, name)
    if not t: return None
    return {"tab": t.get("id"), "views": t.get("views") or ["table"], "columns": t.get("columns"), "sparklines": t.get("sparklines")}

def resolve(docs):
    """[{pack, area, label, scope, role, declared, contract, derived, primary_where, list, facts, problems}] for every area."""
    out = []
    for d in docs:
        if not isinstance(d, dict): continue
        p = _Pack(d)
        for a in d.get("record_areas") or []:
            if not isinstance(a, dict) or not a.get("name"): continue
            g = _derive(p, a)
            certain, possible = _provenance(p, a, g)
            lists = _primaries(p, a, g)
            prim, where, chosen = lists[0]
            derived = {"provenance": certain, "actions": g, "primary_action": prim}
            declared = a.get("contract") if isinstance(a.get("contract"), dict) else None
            out.append({"pack": p.id, "area": a["name"], "label": a.get("label"), "scope": a.get("scope"), "role": a.get("role"),
                        "declared": declared is not None, "contract": declared or derived, "derived": derived,
                        "possible_provenance": possible, "primary_chosen": chosen, "primary_where": where,
                        "primary_lists": [{"where": w, "action": v, "chosen": c} for v, w, c in lists],
                        "list": _tab_facts(p, a["name"]), "facts": _area_facts(a)})
    return out

def area_problems(r):
    """Sentences for one resolved area (see check)."""
    at, errs = f"{r['pack']}.{r['area']}", []
    d, c = r["derived"], r["contract"]
    if not r["declared"]:
        if not d["provenance"]:
            errs.append(f"{at}: nothing in its declaration writes its rows (no repository, no write a workspace or staff may make, no email intake): "
                        "declare contract.provenance (run, when the pack's own code writes them) or open a way in")
        for x in r["primary_lists"]:
            if is_none(x["action"]) and not x["chosen"]:
                errs.append(f"{at}: {x['where']} shows it with no primary action and no reason ({x['action']['none']}): "
                            "declare the tab's action, or action: false with its reason (or contract.primary_action {\"none\": \"<why>\"})")
        return errs
    prov = c.get("provenance") if isinstance(c.get("provenance"), list) else []
    for x in d["provenance"]:
        if x not in prov: errs.append(f"{at}: contract.provenance leaves out {x}, which the build gives it ({', '.join(d['provenance'])})")
    for x in prov:
        if x in PROVENANCES and x not in r["possible_provenance"]:
            why = {"run": "only a pack with its own code (entry) writes a workspace area of the shell's tables in a run",
                   "repository": "the area names no repository", "intake": "the pack's email.intake.area is another area",
                   "people": "no create, update or move is offered to a workspace", "staff": "staff have no write on it"}[x]
            errs.append(f"{at}: contract.provenance names {x}, which the build does not give it ({why})")
    acts = c.get("actions") if isinstance(c.get("actions"), dict) else {}
    for k in ACTIONS:
        if k not in acts: errs.append(f"{at}: contract.actions.{k} is missing (the build gives: {words(d['actions'][k])})"); continue
        if not _same(acts[k], d["actions"][k]):
            errs.append(f"{at}: contract.actions.{k} says {words(acts[k])} but the build gives {words(d['actions'][k])}")
    # The primary action speaks for every list that shows the area (mold_v0-237): each tab, its Settings tab, its Records page.
    pa = c.get("primary_action")
    if pa is None:
        errs.append(f"{at}: contract.primary_action is missing (the build gives: "
                    + "; ".join(f"{_pwords(x['action'])} at {x['where']}" for x in r["primary_lists"]) + ")")
    else:
        for x in r["primary_lists"]:
            if not _same_primary(pa, x["action"]):
                errs.append(f"{at}: contract.primary_action says {_pwords(pa)} but {x['where']} gives {_pwords(x['action'])}")
    return errs

def check(docs):
    """[(path, sentence)]: every area's problems (resolve + area_problems), with the path of its pack and area."""
    out = []
    for r in resolve(docs):
        for e in area_problems(r): out.append((f"packs.{r['pack']}.record_areas.{r['area']}.contract", e))
    return out

def line(r):
    """One area's contract on one line (factory.py spec check --records)."""
    c = r["contract"]; a = c.get("actions") or {}
    pa = c.get("primary_action"); pa = pa if isinstance(pa, str) else ("none" if is_none(pa) else "?")
    lists = r.get("primary_lists") or [{"where": r["primary_where"], "action": c.get("primary_action")}]
    if r["declared"] or all(_same_primary(x["action"], lists[0]["action"]) for x in lists):
        prim = f"primary {pa} at {', '.join(x['where'] for x in lists)}"
    else:
        prim = "primary " + "; ".join(f"{x['action'] if isinstance(x['action'], str) else 'none'} at {x['where']}" for x in lists)
    acts = "; ".join(f"{k} {words(a.get(k)).split(' (')[0]}" for k in ACTIONS if k in a)
    f = r["facts"]
    extra = [x for x in (f"clocks {', '.join(f['clocks'])}" if f["clocks"] else "", "append-only" + (" chained" if f["chain"] else "") if f["append_only"] else "",
                         f"documents {', '.join(f['documents'])}" if f["documents"] else "", f"settings {f['settings'].get('group')}" if f["settings"] else "") if x]
    return (f"{r['pack']}.{r['area']} ({r['scope']}, {'declared' if r['declared'] else 'derived'}): from {', '.join(c.get('provenance') or []) or 'nothing'}; "
            f"{prim}; {acts}" + (f"; {'; '.join(extra)}" if extra else ""))


def self_test():
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    ws = {"name": "jobs", "label": "Jobs", "role": "check", "scope": "workspace", "fields": [{"name": "state", "label": "State", "type": "enum", "options": ["open", "done"]},
          {"name": "ref", "label": "Ref", "encrypted": True, "reveal_roles": ["owner"]}],
          "lifecycle": {"field": "state", "initial": "open", "transitions": [{"from": "*", "to": "done"}]}}
    sh = {"name": "kinds", "label": "Kinds", "role": "source", "scope": "platform", "fields": [{"name": "x", "label": "X"}]}
    feed = {"name": "feed", "label": "Feed", "role": "source", "scope": "workspace", "repository": "files", "fields": [{"name": "x", "label": "X"}]}
    pack = {"id": "acme", "record_areas": [ws, sh, feed], "repositories": {"files": {"kind": "workspace_files"}},
            "tabs": [{"id": "jobs", "kind": "area", "area": "jobs"}, {"id": "feed", "kind": "area", "area": "feed"}]}
    rs = {r["area"]: r for r in resolve([pack])}
    j = rs["jobs"]["derived"]
    ok(j["actions"]["read"] == list(ROLES) and j["actions"]["export"] == list(ROLES), "read and export default to every role")
    ok(j["actions"]["create"] == list(WRITE_ROLES) and j["actions"]["delete"] == ["owner"], "writes default to member, billing, owner; delete to the owner on a lifecycle")
    ok(j["actions"]["reveal"] == ["owner"] and is_none(j["actions"]["import"]), "reveal is the fields' reveal_roles; a workspace area has no import")
    ok(j["provenance"] == ["people"] and j["primary_action"] == "create_record", "a workspace area of the shell's tables: people, create_record by default")
    k = rs["kinds"]["derived"]
    ok(k["actions"]["create"] == {"staff": "library"} and k["actions"]["import"] == {"staff": "library"} and k["actions"]["delete"] == {"staff": "delete"}, "a shared area: staff write and import it")
    ok(k["provenance"] == ["staff"] and is_none(k["primary_action"]), "a shared area: staff provenance; its Records page has no primary action")
    ok(rs["kinds"]["primary_where"] == "/app/records/kinds" and rs["kinds"]["primary_lists"][0]["chosen"], "a shared area's Records page: none, for what the area is")
    f = rs["feed"]["derived"]
    ok(is_none(f["actions"]["create"]) and f["provenance"] == ["repository"], "a workspace-files area is read only, from its repository")
    errs = [e for _, e in check([pack])]
    ok(any("feed: tab feed shows it with no primary action and no reason" in e for e in errs), "a list tab with no primary action and no reason is a problem")
    ok(not any("jobs" in e for e in errs) and not any("kinds" in e for e in errs), "derived contracts need nothing more")
    pack["tabs"][1].update({"action": False, "reason": "rows come from the workspace's files"})
    ok(not check([pack]), "action: false with a reason completes it")
    # a declared contract is held to the build
    ws["contract"] = {"provenance": ["people"], "primary_action": "create_record", "actions": dict(j["actions"])}
    ok(not check([pack]), "a declared contract equal to the derived one passes (reasons may differ)")
    ws["contract"]["actions"] = {**j["actions"], "import": ["owner"], "delete": ["member", "owner"]}
    errs = [e for _, e in check([pack])]
    ok(any("actions.import says owner but the build gives none" in e for e in errs) and any("actions.delete says member, owner" in e for e in errs), "a contract saying more than the build is refused")
    ws["contract"] = {"provenance": ["people", "run", "intake"], "primary_action": {"none": "x"}, "actions": {k: v for k, v in j["actions"].items() if k != "move"}}
    errs = [e for _, e in check([pack])]
    ok(any("names run" in e for e in errs) and any("names intake" in e for e in errs), "provenance the build does not give is refused")
    ok(any("actions.move is missing" in e for e in errs) and any("primary_action says none" in e for e in errs), "every action and the primary action are declared")
    pack["entry"] = "src/index.ts"; pack["email"] = {"intake": {"area": "jobs"}}
    ws["contract"] = {"provenance": ["people", "intake", "run"], "primary_action": "create_record", "actions": dict(j["actions"])}
    ok(not [e for _, e in check([pack]) if "jobs" in e], "run with the pack's code, intake with its email intake")
    pack["mcp"] = {"exclude": ["acme_create_jobs", "acme_update_jobs", "acme_move_jobs"]}
    d = {r["area"]: r for r in resolve([pack])}["jobs"]["derived"]
    ok(is_none(d["actions"]["create"]) and is_none(d["actions"]["delete"]) and "people" not in d["provenance"], "withheld writes take their deletes and the people's provenance with them")
    del ws["contract"]; pack["mcp"] = {}; pack.pop("email"); pack.pop("entry")
    ws["settings"] = {"group": "automation"}
    pack["tabs"] = pack["tabs"][1:]
    st = {r["area"]: r for r in resolve([pack])}["jobs"]
    ok("Settings › Automation" in st["primary_where"], "a Settings area's list is its Settings tab")
    ok(st["derived"]["primary_action"] == "create_record", "a Settings tab adds a record by default (mold_v0-237)")
    ws["action"], ws["action_reason"] = False, "rows come from the pack's runs"
    st = {r["area"]: r for r in resolve([pack])}["jobs"]
    ok(is_none(st["derived"]["primary_action"]) and st["derived"]["primary_action"]["none"] == "rows come from the pack's runs" and not check([pack]),
       "action: false with its action_reason: none, said")
    del ws["settings"], ws["action"], ws["action_reason"]
    # every tab that lists the area (mold_v0-237)
    pack["tabs"] = [{"id": "jobs", "kind": "area", "area": "jobs"}, {"id": "jobs-board", "kind": "area", "area": "jobs", "action": {"kind": "start_run", "job_kind": "x"}}]
    rj = {r["area"]: r for r in resolve([pack])}["jobs"]
    ok([x["where"] for x in rj["primary_lists"]] == ["tab jobs", "tab jobs-board"], "each tab whose own area it is is one of its lists")
    ws["contract"] = {"provenance": ["people"], "primary_action": "create_record", "actions": dict(j["actions"])}
    errs = [e for _, e in check([pack])]
    ok(any("primary_action says create_record but tab jobs-board gives start_run" in e for e in errs), "a declared primary action is held to every tab, not just the first")
    pack["tabs"][1]["action"] = {"kind": "create_record", "area": "jobs"}
    ok(not check([pack]), "every tab agreeing passes")
    pack["tabs"] = []
    ok({r["area"]: r for r in resolve([pack])}["jobs"]["primary_where"] == "/app/records/jobs" and not check([pack]),
       "no tab: its Records page adds a record, as the contract says")
    del ws["contract"]
    return checks


if __name__ == "__main__":
    print(f"records: {len(self_test())} checks passed")
