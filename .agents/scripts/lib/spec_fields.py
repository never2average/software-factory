#!/usr/bin/env python3
"""The app spec's `kind`, `run_keys` and `developer_surface`, as an app's state records them (mold_v0-228).

  python3 .claude/scripts/lib/spec_fields.py --self-test

An app spec (schemas/<mold>.app.schema.json) says what kind of app it is, where the keys its runs need come from, and
(for an embedded app) the developer surface its host's developers build against. `mint.py new --spec` says each in the
brief it writes, intake reads them from that brief into application.json, and `factory.py spec apps` reads them back:

  application.json key   brief                                                       spec
  kind                   a line `Kind: tool` or `Kind: embedded`                     kind
  run_keys               a line `Run keys: model = anthropic, sandbox = boat,        run_keys (mold_v0 only)
                         object_storage = vault` (names of places, never a value)
  developer_surface      a `## Developer surface` section holding the block as one   developer_surface (kind embedded)
                         ```json fenced block

All three are optional in state: an app without them reads as kind tool with no run keys and no developer surface, as
every app minted before mold_v0-228 does. The brief is where they are set, so a brief that stops saying one takes it out
of state at the next intake (never carried forward). `problems()` is what factory.py validate says of them; the shape of
a developer surface is the spec schema's own ($defs/developer_surface), checked with lib/spec_schema.py.

Standard library only.
"""
import json, os, re, sys

KINDS = ("tool", "embedded")
# sandbox: whose key the runs' sandboxes use, in the app's Key vault (boat.dev's, or Freestyle's: mold_v0-274; freestyle
# also makes Freestyle the app's sandbox provider, profile run_sandbox, lib/app_profile.py effective).
RUN_KEYS = {"model": ("anthropic", "vertex"), "sandbox": ("boat", "freestyle"), "object_storage": ("vault", "r2_env", "storage_dir")}
RUN_KEYS_MOLDS = ("mold_v0",)          # mold_v1 has no job runs: its keys are the inference provider's
KEYS = ("kind", "run_keys", "developer_surface")

KIND_LINE = re.compile(r"^[ \t]*(?:[-*][ \t]+)?kind[ \t]*:[ \t]*`?([^`\n]*?)`?[ \t]*\.?[ \t]*$", re.I | re.M)
RUN_KEYS_LINE = re.compile(r"^[ \t]*(?:[-*][ \t]+)?run[ \t]+keys[ \t]*:[ \t]*([^\n]*?)[ \t]*\.?[ \t]*$", re.I | re.M)
DEV_SECTION = re.compile(r"^##[ \t]+Developer[ \t]+surface[ \t]*:?[ \t]*$", re.I | re.M)
HEADING = re.compile(r"^#{1,3}[ \t]", re.M)
FENCE = re.compile(r"^[ \t]*```[ \t]*json[ \t]*\n(.*?)^[ \t]*```[ \t]*$", re.S | re.M | re.I)

def _clean(text):
    """HTML comments and struck-through text blanked (same length): a setting hidden in them is never applied."""
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
    text = re.sub(r"<!--.*?(?:-->|\Z)", blank, text, flags=re.S)
    return re.sub(r"~~.*?~~", blank, text, flags=re.S)

def _no_fences(text):
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
    return re.sub(r"^[ \t]*(```|~~~).*?(?:^[ \t]*\1[^\n]*$|\Z)", blank, text, flags=re.S | re.M)

def parse_kind(value):
    """-> (kind or None, problem or None) for the value of a `Kind:` line."""
    v = value.strip().lower()
    return (v, None) if v in KINDS else (None, f"Kind: {value.strip()!r} is not a kind of app (tool or embedded)")

def parse_run_keys(value):
    """-> (run_keys or None, problems) for the value of a `Run keys:` line: `name = value` pairs split by commas."""
    out, errs = {}, []
    for part in [x.strip() for x in re.split(r"[,;]", value) if x.strip()]:
        m = re.fullmatch(r"([a-z][a-z _]*?)[ \t]*(?:=|:|[ \t])[ \t]*`?([a-z0-9_]+)`?", part, re.I)
        if not m: errs.append(f"Run keys: {part!r} is not `<name> = <value>`"); continue
        k, v = re.sub(r"[ \t]+", "_", m.group(1).strip().lower()), m.group(2).lower()
        if k not in RUN_KEYS: errs.append(f"Run keys: {k} is not a run key ({', '.join(RUN_KEYS)})"); continue
        if v not in RUN_KEYS[k]: errs.append(f"Run keys: {k} is {v!r}, not one of {', '.join(RUN_KEYS[k])}"); continue
        if k in out and out[k] != v: errs.append(f"Run keys: {k} is given twice ({out[k]} and {v}); keep one"); continue
        out[k] = v
    if not out and not errs: errs.append("Run keys: the line names none (model, sandbox, object_storage)")
    return (out or None), errs

def from_brief(text):
    """-> ({kind?, run_keys?, developer_surface?}, problems) from a brief's lines and its ## Developer surface section."""
    text = _clean(text); flat = _no_fences(text); got, errs = {}, []
    kinds = [m.group(1) for m in KIND_LINE.finditer(flat)]
    for v in kinds:
        k, e = parse_kind(v)
        if e: errs.append(e)
        elif "kind" in got and got["kind"] != k: errs.append(f"Kind: the brief says both {got['kind']} and {k}; keep one")
        elif k: got["kind"] = k
    for m in RUN_KEYS_LINE.finditer(flat):
        rk, e = parse_run_keys(m.group(1)); errs += e
        if rk:
            for k, v in rk.items():
                if got.get("run_keys", {}).get(k, v) != v: errs.append(f"Run keys: {k} is given twice; keep one")
                got.setdefault("run_keys", {})[k] = v
    for m in DEV_SECTION.finditer(flat):
        nxt = HEADING.search(flat, m.end())
        body = text[m.end():nxt.start() if nxt else len(text)]
        f = FENCE.search(body)
        if not f: errs.append(f"{m.group(0).strip()}: write the developer surface as JSON in one ```json fenced block"); continue
        try: block = json.loads(f.group(1))
        except ValueError as x: errs.append(f"{m.group(0).strip()}: the JSON block does not read ({str(x)[:120]})"); continue
        if not isinstance(block, dict): errs.append(f"{m.group(0).strip()}: the JSON block must be one object"); continue
        if "developer_surface" in got: errs.append(f"{m.group(0).strip()}: the developer surface is given twice; keep one"); continue
        got["developer_surface"] = block
    return got, errs

def brief_lines(spec):
    """-> (setting lines, extra sections): the spec's kind, run_keys and developer_surface said as a brief says them."""
    lines, extra = [], []
    if spec.get("kind") in KINDS: lines.append(f"Kind: {spec['kind']}")
    rk = spec.get("run_keys")
    if isinstance(rk, dict) and rk: lines.append("Run keys: " + ", ".join(f"{k} = {v}" for k, v in rk.items()))
    if isinstance(spec.get("developer_surface"), dict):
        extra.append("## Developer surface\n\n```json\n" + json.dumps(spec["developer_surface"], indent=2, ensure_ascii=False) + "\n```\n")
    return lines, extra

def from_hints(hints, mold_id):
    """-> ({key: value} to write into application.json, problems) from intake's hints (parse_brief)."""
    errs = list(hints.get("spec_fields_problems") or [])
    got = {k: hints[k] for k in KEYS if hints.get(k) is not None}
    if "run_keys" in got and mold_id not in RUN_KEYS_MOLDS:
        errs.append(f"Run keys: {mold_id} has no job runs, so it takes no run keys (its keys are the inference provider's)")
    if "developer_surface" in got and got.get("kind") != "embedded":
        errs.append("## Developer surface: a developer surface is for an app of kind embedded only (add `Kind: embedded`, or take the section out)")
    if got.get("kind") == "embedded" and "developer_surface" not in got:
        errs.append("Kind: embedded needs the ## Developer surface section (its events, SDK languages and client sessions)")
    return got, errs

def apply(app, hints, mold_id):
    """Write the brief's kind, run_keys and developer_surface into the application document (and take out what the brief
    no longer says). -> problems (nothing should be written when there are any)."""
    got, errs = from_hints(hints, mold_id)
    if errs: return errs
    for k in KEYS:
        if k in got: app[k] = got[k]
        else: app.pop(k, None)
    return []

def to_spec(app):
    """{kind?, run_keys?, developer_surface?}: what an app's state says of them, for factory.py spec apps."""
    return {k: app[k] for k in KEYS if app.get(k) is not None}

def _surface_schema(mold_id, root):
    p = os.path.join(root, "schemas", f"{mold_id}.app.schema.json")
    if not os.path.isfile(p): return None
    with open(p) as fh: s = json.load(fh)
    return {"$defs": s.get("$defs") or {}, "$ref": "#/$defs/developer_surface"} if "developer_surface" in (s.get("$defs") or {}) else None

def problems(app, mold_id, root):
    """Sentences: what keeps an application document's kind, run_keys and developer_surface from being right."""
    errs = []
    kind = app.get("kind")
    if "kind" in app and kind not in KINDS: errs.append(f"kind is {json.dumps(kind)}: tool or embedded")
    rk = app.get("run_keys")
    if "run_keys" in app:
        if mold_id not in RUN_KEYS_MOLDS: errs.append(f"run_keys: {mold_id} has no job runs (its keys are the inference provider's): take run_keys out")
        elif not isinstance(rk, dict) or not rk: errs.append("run_keys must be an object of run keys (model, sandbox, object_storage)")
        else:
            for k, v in rk.items():
                if k not in RUN_KEYS: errs.append(f"run_keys.{k} is not a run key ({', '.join(RUN_KEYS)})")
                elif v not in RUN_KEYS[k]: errs.append(f"run_keys.{k} is {json.dumps(v)}: one of {', '.join(RUN_KEYS[k])}")
            # mold_v0-274: the sandbox's key and the provider the profile names say the same place.
            ps = (app.get("profile") or {}).get("run_sandbox") if isinstance(app.get("profile"), dict) else None
            if rk.get("sandbox") in RUN_KEYS["sandbox"] and ps in ("boat", "freestyle", "docker") and ps != rk["sandbox"]:
                errs.append(f"run_keys.sandbox is {rk['sandbox']} but profile.run_sandbox is {ps}: the runs' sandboxes come from one provider; make them agree")
    ds = app.get("developer_surface")
    if "developer_surface" in app:
        if kind != "embedded": errs.append("developer_surface is for an app of kind embedded only: set kind to embedded, or take it out")
        if not isinstance(ds, dict): errs.append("developer_surface must be an object (the app spec's developer_surface)")
        else:
            sch = _surface_schema(mold_id, root)
            if sch:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                import spec_schema
                for _, p, m in spec_schema.check(sch, ds): errs.append(f"developer_surface: {m}")
    elif kind == "embedded": errs.append("kind is embedded but there is no developer_surface: an embedded app records what its host's developers build against")
    return errs

def self_test():
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    ds = {"events": [{"name": "record.created", "description": "A record was created."}], "sdk_languages": ["typescript"],
          "client_sessions": {"ttl_seconds": 600, "allowed_origins": ["https://app.example.com"]}}
    spec = {"kind": "embedded", "run_keys": {"model": "anthropic", "sandbox": "boat", "object_storage": "vault"}, "developer_surface": ds}
    lines, extra = brief_lines(spec)
    got, errs = from_brief("# X\n\n" + "\n".join(lines) + "\n\n" + "\n".join(extra))
    ok(errs == [] and got == spec, f"kind, run keys and the developer surface read back from the brief lines they are said in ({errs[:2]})")
    ok(from_brief("Run keys: model anthropic, object storage = r2_env\n")[0] == {"run_keys": {"model": "anthropic", "object_storage": "r2_env"}},
       "run keys read as `name value` or `name = value`, object storage spelled with a space or an underscore")
    ok(from_brief("Kind: gadget\n")[1] and from_brief("Run keys: model = gpt\n")[1] and from_brief("Run keys: colour = blue\n")[1],
       "an unknown kind, run key or run key value is a problem, never a guess")
    ok(from_brief("Kind: tool\nKind: embedded\n")[1], "two kinds is a problem")
    ok(from_brief("<!-- Kind: embedded -->\n~~Run keys: model = vertex~~\n")[0] == {}, "a setting in a comment or struck through is not applied")
    ok(from_brief("## Developer surface\n\nno json here\n")[1], "a developer surface section without its JSON block is a problem")
    ok(from_brief("Minted from an app spec (briefs/x.spec.json, kind tool).\nThe kind: of app we want.\n")[0] == {}, "kind in prose sets nothing")
    app = {"packs": []}
    ok(apply(app, got, "mold_v0") == [] and to_spec(app) == spec, "intake writes all three into application.json, and spec apps reads them back")
    ok(apply(app, {"kind": "tool"}, "mold_v0") == [] and app.get("kind") == "tool" and "run_keys" not in app and "developer_surface" not in app,
       "a brief that stops saying one takes it out of state")
    ok(apply({}, {"run_keys": {"model": "anthropic"}}, "mold_v1"), "mold_v1 takes no run keys")
    ok(apply({}, {"developer_surface": ds}, "mold_v0") and apply({}, {"kind": "embedded"}, "mold_v0"), "a developer surface needs kind embedded, and kind embedded needs one")
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    ok(problems({}, "mold_v0", root) == [] and problems({"app_id": "x"}, "mold_v1", root) == [], "an app without them (every app before mold_v0-228) is valid")
    ok(problems(spec, "mold_v0", root) == [], f"an embedded mold_v0 app with run keys and a developer surface is valid ({problems(spec, 'mold_v0', root)[:2]})")
    bad = {"kind": "embedded", "run_keys": {"model": "gpt"}, "developer_surface": {"events": []}}
    msgs = problems(bad, "mold_v0", root)
    ok(any("run_keys.model" in m for m in msgs) and any(m.startswith("developer_surface:") for m in msgs), f"a wrong run key value and a malformed developer surface are said ({msgs[:3]})")
    ok(any("embedded" in m for m in problems({"developer_surface": ds}, "mold_v0", root)), "a developer surface on a tool is refused")
    ok(any("no job runs" in m for m in problems({"run_keys": {"model": "anthropic"}}, "mold_v1", root)), "run keys on mold_v1 are refused")
    ok(from_brief("Run keys: sandbox = freestyle\n")[0] == {"run_keys": {"sandbox": "freestyle"}} and problems({"run_keys": {"sandbox": "freestyle"}}, "mold_v0", root) == [],
       "mold_v0-274: the runs' sandbox key may be Freestyle's")
    ok(any("make them agree" in m for m in problems({"run_keys": {"sandbox": "freestyle"}, "profile": {"run_sandbox": "boat"}}, "mold_v0", root)),
       "mold_v0-274: a sandbox key and a profile provider that disagree are said")
    print(f"spec_fields: {len(checks)} checks passed")
    return 0

if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    print(__doc__); sys.exit(2)
