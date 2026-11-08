"""mold_v0's capability flags (mold_v0-219), as the factory reads them.

The one registry is the mold's own `molds/mold_v0/codebase/src/features.json` (the shell's src/features.ts and its
build, scripts/gen-packs.mjs, read the same file). Each flag:

  setting    application.json profile.features {"<id>": true|false} (the app spec's top-level `features`; a brief's
             `features.<id> = true|false` lines in ## Profile), else its legacy key (profile.audit.data, .platform, .sign;
             profile.onprem_runners; for developer_surface the spec's `kind`), else the registry's default
  requested  what asks for it: a pack's declaration (credentials, email, due dates or clocks, private-network kinds,
             developer_surface, checks, encrypted fields, record page layouts), a build without the session engine, or always
  on         requested and the setting not false

`effective()` gives every flag's state for an app (`factory.py spec check` and `spec apps` report them; the factory
board shows the short names of those that are on); `problems()` the sentences that keep a features block from being
right (unknown flags, a legacy key saying the opposite, a flag another needs, a pack declaration the flag would break).
Standard library only.
"""
import json, os, re

REGISTRY_FILE = os.path.join("molds", "mold_v0", "codebase", "src", "features.json")
ENGINE_TABLES = ("products", "scenarios", "simulations", "agent_sessions")   # the shell's src/host-tables.ts sessionEngine

def registry(root):
    """[flag specs] in registry order, or [] when the mold has none."""
    p = os.path.join(root, REGISTRY_FILE)
    if not os.path.isfile(p): return []
    with open(p) as fh: return list(json.load(fh).get("flags") or [])

def ids(root): return [f["id"] for f in registry(root)]

def pack_doc(pid, root, build_dir=None):
    """A pack's pack.json (the build copy's when given, else packs/<id>/files/packs/<id>/pack.json), or {}."""
    for base in ([os.path.join(build_dir, "packs", pid, "pack.json")] if build_dir else []) + [os.path.join(root, "packs", pid, "files", "packs", pid, "pack.json")]:
        if os.path.isfile(base):
            try:
                with open(base) as fh: d = json.load(fh)
                return d if isinstance(d, dict) else {}
            except ValueError: return {}
    return {}

def _legacy(profile, path):
    v = profile
    for k in path.split("."): v = v.get(k) if isinstance(v, dict) else None
    return v if isinstance(v, bool) else None

def setting(flag, profile, kind=None):
    """(value, where): the flag as the app's state sets it."""
    feats = (profile or {}).get("features") if isinstance((profile or {}).get("features"), dict) else {}
    if isinstance(feats.get(flag["id"]), bool): return feats[flag["id"]], "features"
    if flag.get("legacy"):
        v = _legacy(profile or {}, flag["legacy"])
        if v is not None: return v, f"profile.{flag['legacy']}"
    if flag["id"] == "developer_surface" and kind is not None: return kind == "embedded", "kind"
    return bool(flag.get("default")), "default"

def _areas(docs): return [a for d in docs for a in (d.get("record_areas") or []) if isinstance(a, dict)]
def _kinds(docs): return [k for d in docs for k in (d.get("job_kinds") or []) + (d.get("agent_job_kinds") or []) if isinstance(k, dict)]

def requested(flag, docs, settings_on=None, kind=None):
    """Whether something in the app asks for the capability (its packs' pack.json docs)."""
    by = flag.get("requested_by")
    if by == "always": return True
    # mold_v0-271: the staff Records group (a pack's console.admin_records; the app's profile says it in its own console) lists the recipes page
    if by == "recipes": return any("recipes" in [x if isinstance(x, str) else (x or {}).get("id") for x in (((d.get("console") or {}).get("admin_records") or {}).get("show") or [])] for d in docs)
    # mold_v0-282: a shared area declares a repository or a database field (the shell's src/features.ts and gen-packs say the same)
    if by == "resources": return any(a.get("scope") == "platform" and any(isinstance(f, dict) and f.get("type") in ("repository", "database") for f in a.get("fields") or []) for a in _areas(docs))
    if by == "credentials": return any(d.get("credentials") for d in docs)
    if by == "email": return any(isinstance(d.get("email"), dict) and ((d["email"].get("sender") or {}).get("allow") is True or d["email"].get("intake")) for d in docs)
    if by == "clocks": return any(a.get("scope") == "workspace" and a.get("clocks") for a in _areas(docs))
    if by == "alerts": return any(a.get("due") for a in _areas(docs)) or bool((settings_on or {}).get("record_clocks"))
    if by == "private_network": return any(k.get("private_network") is True for k in _kinds(docs))
    if by == "developer_surface": return kind == "embedded" or any(d.get("developer_surface") is not None for d in docs)
    if by == "checks": return any(d.get("checks") for d in docs)
    if by == "encrypted": return any(isinstance(f, dict) and f.get("encrypted") is True for a in _areas(docs) for f in a.get("fields") or [])
    if by == "documents": return any(isinstance(f, dict) and (f.get("type") == "file" or f.get("preview") == "document") for a in _areas(docs) for f in a.get("fields") or [])
    if by == "layouts": return (any(isinstance(a.get("detail"), dict) or a.get("key_from_title") is True or any(isinstance(f, dict) and (f.get("copyable") is True or f.get("display") == "chips") for f in a.get("fields") or []) for a in _areas(docs))
                                or any(isinstance(c, dict) for d in docs for t in (d.get("tabs") or []) if isinstance(t, dict) for c in (t.get("columns") or [])))
    # mold_v0-260 (the shell's src/features.ts gapAsks and gen-packs say the same)
    tabs = [t for d in docs for t in (d.get("tabs") or []) if isinstance(t, dict)]
    if by == "record_inputs": return any(k.get("input_from_record") for k in _kinds(docs))
    if by == "wide_lists": return any(len(a.get("list_columns") or []) > 8 for a in _areas(docs)) or any(len(t.get("columns") or []) > 8 for t in tabs)
    if by == "record_rules": return (any(a.get("on_save") or any(isinstance(f, dict) and f.get("where") for f in a.get("fields") or []) for a in _areas(docs))
                                     or any(isinstance(f, dict) and f.get("where") for k in _kinds(docs) for f in k.get("args") or []))
    if by == "credential_sets": return any(isinstance(c, dict) and (c.get("entries") or c.get("bound_to") == "tenant") for d in docs for c in d.get("credentials") or [])
    if by == "home_cards": return any(t.get("kind") == "overview" and "setup" in (t.get("include") or []) and (len(t.get("sparklines") or []) > 4 or any(x in ("recent_runs", "attention") for x in t.get("rail") or [])) for t in tabs)
    if by == "no_engine":
        owned = {t for d in docs for t in (((d.get("host") or {}).get("schema") or {}).get("tables") or [])}
        return not all(t in owned for t in ENGINE_TABLES)
    return False

def effective(profile, docs, root, kind=None):
    """[{id, short, label, setting, from, requested, on}] in registry order."""
    out, on = [], {}
    rc = next((f for f in registry(root) if f["id"] == "record_clocks"), None)   # scheduled_alerts reads it (clock steps)
    if rc: on["record_clocks"] = setting(rc, profile, kind)[0] and requested(rc, docs, on, kind)
    for f in registry(root):
        v, where = setting(f, profile, kind)
        # mold_v0-271: the profile's own console.admin_records asks for recipes as a pack's does
        own = [{"console": profile.get("console")}] if f.get("requested_by") == "recipes" and isinstance(profile, dict) and isinstance(profile.get("console"), dict) else []
        r = requested(f, docs + own, on, kind)
        on[f["id"]] = v and r
        out.append({"id": f["id"], "short": f["short"], "label": f["label"], "setting": v, "from": where, "requested": r, "on": v and r})
    return out

def words(states):
    """"email, clocks, alerts, audit.data, runners" (the short names of what is on), or "none"."""
    return ", ".join(s["short"] for s in states if s["on"]) or "none"

def block_problems(v, root, at="features"):
    """The features block's own shape: {"<known id>": true|false}."""
    if not isinstance(v, dict) or not v: return [f"{at} must be an object of flags, {{\"<flag>\": true|false}} (flags: {', '.join(ids(root))})"]
    known, errs = ids(root), []
    for k, x in v.items():
        # mold_v0-283: the private catalogs' flag went with the upstream catalogs (the shell's gen-packs says the same)
        if k == "private_catalogs" and k not in known: errs.append(f"{at}.private_catalogs was removed with upstream catalogs (mold_v0-283): shared lists are staff-kept platform records (New, Edit, Import); take the flag out")
        elif k not in known: errs.append(f"{at}.{k} is not a flag (flags: {', '.join(known)})")
        elif not isinstance(x, bool): errs.append(f"{at}.{k} must be true or false (got {json.dumps(x)[:40]})")
    return errs

def problems(profile, docs, root, kind=None, at="profile.features"):
    """Sentences: what keeps the app's flags from being right (its features block, its legacy keys, its packs)."""
    profile = profile or {}
    feats = profile.get("features")
    errs = block_problems(feats, root, at) if feats is not None else []
    if errs: return errs
    feats = feats or {}
    states = {s["id"]: s for s in effective(profile, docs, root, kind)}
    for f in registry(root):
        i = f["id"]
        if i in feats and f.get("legacy"):
            lv = _legacy(profile, f["legacy"])
            if lv is not None and lv != feats[i]:
                errs.append(f"{at}.{i} is {json.dumps(feats[i])} but profile.{f['legacy']} says {json.dumps(lv)}: say it once (features.{i})")
        if i == "developer_surface" and i in feats and kind is not None and feats[i] != (kind == "embedded"):
            errs.append(f"{at}.developer_surface is {json.dumps(feats[i])} but kind is {kind}: kind is the switch (embedded with a developer_surface block turns it on); leave the flag out or make it agree")
        st = states[i]
        if st["on"]:
            for need in f.get("requires") or []:
                if not states[need]["on"]: errs.append(f"{at}: {i} is on, which needs {need} on too ({f['label']} needs the {states[need]['label'].lower()})")
            any_ = f.get("requires_any") or []
            if any_ and not any(states[n]["on"] for n in any_):
                errs.append(f"{at}: {i} is on, which needs one of {', '.join(any_)} on ({f['label']} signs the audit trails; with none on there is nothing to sign)")
    if not states.get("encrypted_fields", {}).get("setting", True) and states.get("encrypted_fields", {}).get("requested"):
        errs.append(f"{at}.encrypted_fields is false but a pack declares an encrypted field: turning it off would store those values in the clear, so it is refused (take encrypted: true off the field first)")
    # a metric, chart or tab that counts by a clock with the clocks off (gen-packs refuses the same, mold_v0-229)
    rc = states.get("record_clocks")
    if rc and not rc["on"] and rc["requested"]:
        for d in docs:
            if re.search(r'"clock"\s*:', json.dumps([d.get("metrics") or [], d.get("charts") or [], d.get("tabs") or []])):
                errs.append(f"{at}.record_clocks is false but pack {d.get('id', '?')} has a metric, chart or tab that counts by a clock: take it out, or leave the clocks on")
    # mold_v0-260: what these flags check is never quietly dropped (gen-packs refuses the same)
    for i, what in (("wide_lists", "a list with more than 8 columns"), ("record_rules", "a reference field's where or an area's on_save"), ("credential_sets", "a credential with entries or bound to a tenant"), ("overview_cards", "a home tab's fifth number or its recent_runs or attention card"),
                    ("record_resources", "a repository or database field")):   # mold_v0-282
        st = states.get(i)
        if st and not st["setting"] and st["requested"]:
            errs.append(f"{at}.{i} is off but a pack declares {what}: turn it on (features.{i} = true) or take the declaration out")
    if "customer_key_vault" in states and not states["customer_key_vault"]["setting"]:
        need = sorted({f"{d.get('id', '?')}.{c}" for d in docs for k in (d.get("job_kinds") or []) + (d.get("agent_job_kinds") or []) if isinstance(k, dict)
                       for c in (k.get("credentials") or []) if isinstance(c, str)
                       and not any(isinstance(x, dict) and x.get("name") == c and x.get("optional") for x in d.get("credentials") or [])})
        if need: errs.append(f"{at}.customer_key_vault is false but job kinds need the workspace credentials {', '.join(need[:5])}: nobody could give them (make them optional, or leave the flag on)")
    return errs

def self_test(root):
    flags = registry(root); checks = []
    def ok(c, what): checks.append(what); assert c, what
    ok(len(flags) == 27 and len(set(ids(root))) == 27, "the registry names 27 flags, each once")
    ok(all(f.get("short") and f.get("about") and f.get("off") and isinstance(f.get("default"), bool) for f in flags), "every flag has a short name, words for on and off, and a default")
    audit_app_like = [{"id": "m", "credentials": [{"name": "t"}], "email": {"sender": {"allow": True}}, "record_areas": [
        {"name": "a", "scope": "workspace", "due": {"field": "d"}, "fields": []}, {"name": "b", "scope": "workspace", "clocks": [{"name": "c"}], "fields": []}],
        "job_kinds": [{"name": "k", "private_network": True, "credentials": ["t"]}]}]
    prof = {"audit": {"data": True, "platform": False}, "onprem_runners": True}
    ok(words(effective(prof, audit_app_like, root)) == "vault, email, alerts, clocks, audit.data, runners, health", "legacy keys and pack signals give the effective flags")
    ok(words(effective({}, [], root)) == "health", "zero packs and no profile: only health history (no engine)")
    ok("agent" not in words(effective({}, [], root)) and "agent" in words(effective({"features": {"agent_harness": True}}, [], root)), "the workspace agent: off by default, on when the profile says (mold_v0-243)")
    laid_out = [{"id": "m", "record_areas": [{"name": "builds", "scope": "workspace", "fields": [{"name": "status"}], "detail": {"tabs": [{"label": "Overview", "sections": []}]}}]}]
    copy_only = [{"id": "m", "record_areas": [{"name": "builds", "scope": "workspace", "fields": [{"name": "commit", "copyable": True}]}]}]
    ok("pages" not in words(effective({}, laid_out, root)) and "pages" in words(effective({"features": {"record_pages": True}}, laid_out, root))
       and "pages" in words(effective({"features": {"record_pages": True}}, copy_only, root)) and "pages" not in words(effective({"features": {"record_pages": True}}, [], root)),
       "record page layouts: off by default; on when the profile says and an area declares a layout or a copyable field (mold_v0-253)")
    ok("panel" not in words(effective({}, [], root)) and "panel" in words(effective({"features": {"side_panel_forms": True}}, [], root)),
       "forms in a side panel: off by default, on when the profile says (mold_v0-256)")
    # mold_v0-260
    gaps = [{"id": "m", "job_kinds": [{"name": "k", "args": [{"name": "a"}], "input_from_record": {"a": "x"}}],
             "record_areas": [{"name": "w", "scope": "workspace", "list_columns": list("abcdefghi"), "on_save": [{"check": "c", "message": "no"}], "fields": [{"name": "r", "type": "reference", "to": "t", "where": {"field": "s", "equals": "on"}}]}],
             "credentials": [{"name": "hosts", "bound_to": "tenant", "area": "t", "entries": {"label": "Host"}}],
             "tabs": [{"id": "home", "kind": "overview", "include": ["setup"], "rail": ["recent_runs", "attention"], "sparklines": list("abcde")}]}]
    all_on = {"features": {i: True for i in ("record_run_inputs", "wide_lists", "record_rules", "credential_sets", "overview_cards", "run_analytics", "filters_in_address", "usage_tool")}}
    ok(all(x not in words(effective({}, gaps, root)).split(", ") for x in ("inputs", "wide", "rules", "credsets", "overview", "analytics", "filters", "usage"))
       and all(x in words(effective(all_on, gaps, root)).split(", ") for x in ("inputs", "wide", "rules", "credsets", "overview", "analytics", "filters", "usage")),
       "mold_v0-260's eight flags (private_catalogs went with mold_v0-283): off by default; on when the profile says and (for five of them) a pack declares what asks for it")
    ok(not any("wide" in w for w in words(effective(all_on, [], root)).split(", ")), "wide lists: on only when a list asks for it")
    ok(len([e for e in problems({}, gaps, root) if "is off but a pack declares" in e]) == 4 and not [e for e in problems(all_on, gaps, root) if "is off but" in e],
       "a wide list, a record rule and a credential set are refused while their flag is off (mold_v0-260)")
    related_col = [{"id": "m", "record_areas": [{"name": "builds", "scope": "workspace", "fields": [{"name": "project"}]}],
                    "tabs": [{"id": "projects", "kind": "area", "area": "projects", "columns": ["owner", {"related": {"area": "builds"}, "show": "count"}]}]}]
    ok("pages" in words(effective({"features": {"record_pages": True}}, related_col, root)), "a tab column computed from related records asks for record pages (mold_v0-256)")
    ok("teams" not in words(effective({}, [], root)) and "teams" in words(effective({"features": {"teams": True}}, [], root)),
       "teams and record visibility: off by default, on when the profile says (mold_v0-259)")
    ok(words(effective({"features": {"record_clocks": False}}, audit_app_like, root)).find("clocks") < 0, "a flag false turns a requested capability off")
    ok(problems({"features": {"audit.data": False}, "audit": {"data": True}}, [], root) != [], "a features flag and its legacy key that disagree are refused")
    ok(any("needs one of" in e for e in problems({"features": {"audit.sign": True}}, [], root)), "audit.sign needs audit.data or audit.platform")
    ok(any("needs audit.platform" in e for e in problems({}, [{"developer_surface": {}}], root)), "a developer surface needs the platform audit trail")
    ok(problems({"features": {"audit.platform": True}}, [{"developer_surface": {}}], root) == [], "a developer surface with the platform trail is right")
    ok(any("in the clear" in e for e in problems({"features": {"encrypted_fields": False}}, [{"record_areas": [{"scope": "workspace", "fields": [{"name": "x", "encrypted": True}]}]}], root)), "encrypted_fields off with an encrypted field is refused")
    ok(any("nobody could give" in e for e in problems({"features": {"customer_key_vault": False}}, audit_app_like, root)), "the key vault off while a kind needs a credential is refused")
    ok(any("not a flag" in e for e in problems({"features": {"nope": True}}, [], root)), "an unknown flag is refused")
    ok(any("removed with upstream catalogs" in e for e in problems({"features": {"private_catalogs": True}}, [], root)), "the private catalogs' flag is refused in plain words (mold_v0-283)")
    ok(any("kind is the switch" in e for e in problems({"features": {"developer_surface": True, "audit.platform": True}}, [], root, kind="tool")), "developer_surface true on a tool app is refused (kind is the switch)")
    # mold_v0-271: workspace recipes, asked for by the staff Records group listing them (a pack's, or the profile's own console), needing the agent
    listed = [{"id": "m", "console": {"admin_records": {"show": [{"id": "recipes", "label": "Recipes"}, "molds"]}}}]
    ok("recipes" not in words(effective({"features": {"agent_harness": True}}, [], root)) and "recipes" in words(effective({"features": {"agent_harness": True}}, listed, root))
       and "recipes" in words(effective({"features": {"agent_harness": True}, "console": {"admin_records": {"show": ["recipes"]}}}, [], root)),
       "workspace recipes: on when the staff Records group lists them, a pack's or the profile's (mold_v0-271)")
    ok(any("needs agent_harness" in e for e in problems({}, listed, root)) and not problems({"features": {"agent_harness": True}}, listed, root), "workspace recipes need the workspace agent")
    ok(not requested(next(f for f in flags if f["id"] == "health_history"), [{"host": {"schema": {"tables": list(ENGINE_TABLES)}}}]), "a host pack with the session engine does not ask for health history")
    # mold_v0-282: record resources, asked for by a shared area's repository or database field; off by default, refused off
    owning = [{"id": "m", "record_areas": [{"name": "molds", "scope": "platform", "fields": [{"name": "repo", "type": "repository"}, {"name": "db", "type": "database", "provider": "neon"}]}]}]
    ok("resources" not in words(effective({}, owning, root)) and "resources" in words(effective({"features": {"record_resources": True}}, owning, root))
       and "resources" not in words(effective({"features": {"record_resources": True}}, [], root)),
       "record resources: off by default; on when the profile says and a shared area declares a repository or database field (mold_v0-282)")
    ok(any("record_resources is off but a pack declares a repository or database field" in e for e in problems({}, owning, root)) and not problems({"features": {"record_resources": True}}, owning, root),
       "a repository or database field is refused while record_resources is off (mold_v0-282)")
    return checks
