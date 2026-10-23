"""An application's own profile settings (mold_v0-090): application.json `profile`, written into its build copy.

A mold whose build reads a profile FILE (molds/<mold>/branding/rules.json `profile`; mold_v0's profile.json, which
scripts/gen-packs.mjs checks and compiles into src/profile.generated.ts) may let an app set some of that file's fields
from its own state. Which ones the mold names in the same rules (`profile.app_settable`); this module knows how to check
each one the factory can check. Today (mold_v0):

  limits                     src/rate-limits.ts: the platform's ceilings, e.g. limits.runs.budget_usd_max
  member_keys                true or false (mold_v0-099): false turns per-member API keys off; clients sign in
  source_offer.upstreams     {"<pack id>": "licensor_owned"} (mold_v0-099): the app's packs whose pinned upstream is
                             the app licensor's own project, which the build then does not offer. Only this part of
                             source_offer: its `app` part stays the factory's (defaults.source_offer, packs.py), and
                             each writer keeps the other's part

An entry of app_settable may be a dotted path (`source_offer.upstreams`): the app then sets that part of the field only.
Everything else in the profile is someone else's:

  name and the brand's words   the brand (surface.branding; branding.py set) writes them
  host_packs                   packs.py writes it from application.packs and mold.json packs.host_packs
  source_offer.app             the factory's defaults.source_offer (packs.py)
  billing, entitlements        money and plans: not settable from state (a ticket of their own)
  anything else                not settable from state; the shell's own default or a host pack's profile applies

Never a secret: every value this module accepts is a positive number under a name the shell already knows, true or
false, or the word licensor_owned under one of the app's own pack ids.

Where a value comes from: the brief (intake reads `limits.<section>.<name> = <number>`, `member_keys = false` and
`source_offer.upstreams.<pack id> = licensor_owned` lines in a `## Profile` or `## Budgets` section; docs/INTAKE.md), recorded in application.json `profile`, written by branding.py prepare and
packs.py apply into build/<app_id>/profile.json over the mold's own profile.json (the app wins over the mold default; a
field the app does not set is put back to the mold's, so a setting taken out of the brief does not linger in a build),
then the mold's generator checks it again and compiles it. A deploy rebuilds the copy, so a change takes effect at the
next deploy. The server's environment (OCTILLION_LIMIT_*) still wins over the profile: the operator's own knob.
"""
import json, os, re

# What the factory refuses outright, and why (a sentence a person can act on).
RESERVED = {
    "name": "the brand writes it (application.surface.branding; branding.py <app> set --name)",
    "console_title": "the brand writes it (branding.py)", "email_sender_name": "the brand writes it (branding.py)",
    "mcp_server_name": "the brand writes it (branding.py)", "short_description": "the brand's tagline writes it (branding.py)",
    "console_description": "the brand's description writes it (branding.py)", "slug": "the brand writes it (branding.py)",
    "tagline": "the brand writes it (branding.py)", "description": "the brand writes it (branding.py)",
    "host_packs": "packs.py writes it from application.packs and the mold's host_packs list; an app never names its own host packs",
    "source_offer": "the factory's defaults.source_offer writes its app part (packs.py); an app sets only source_offer.upstreams",
    "billing": "money settings are not settable from an app's state",
    "entitlements": "what each plan unlocks is not settable from an app's state",
    "$comment": "the factory writes the file's comment",
}
PLAN_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}")   # the shell's (scripts/gen-packs.mjs PLAN_NAME)
MAX_NUMBER = 1e12                                              # a typo guard; the shell's own check is "positive"
# Each limit is at most its ceiling (molds/<mold>/branding/rules.json profile.app_limits_max, "<section>.<name>": number,
# the same for a plan's own): a brief or a hand edit cannot raise a spending ceiling past what the factory allows without
# a reviewed change to that file. A limit that counts things (not a US$ amount) is a whole number.

def _load(p):
    with open(p) as fh: return json.load(fh)

def spec(mold_id, root):
    """The mold's profile rules (molds/<mold>/branding/rules.json `profile`) when it lets an app set fields, else None."""
    p = os.path.join(root, "molds", str(mold_id or ""), "branding", "rules.json")
    if not (isinstance(mold_id, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,40}", mold_id) and os.path.isfile(p)): return None
    try: s = _load(p).get("profile") or None
    except (OSError, ValueError): return None
    return s if s and s.get("app_settable") and s.get("file") else None

def limit_keys(codebase):
    """{section: [names]} the shell knows (scripts/gen-packs.mjs LIMIT_KEYS: the list the build itself checks), or None."""
    try: src = open(os.path.join(codebase, "scripts", "gen-packs.mjs")).read()
    except OSError: return None
    m = re.search(r"^const LIMIT_KEYS = \{(.*?)^\};", src, re.S | re.M)
    if not m: return None
    out = {s: re.findall(r'"([a-z_]+)"', body) for s, body in re.findall(r"^\s*([a-z_]+):\s*\[(.*?)\]", m.group(1), re.S | re.M)}
    return out if out and all(out.values()) else None

def _limits_problems(v, keys, at="limits", plans=True, maxes=None):
    if not isinstance(v, dict): return [f"{at} must be an object of sections ({', '.join(keys)}{', plans' if plans else ''})"]
    errs = []
    for section, body in v.items():
        here = f"{at}.{section}"
        if section == "plans" and plans:
            if not isinstance(body, dict) or not body: errs.append(f"{here} must be an object of plan name -> limits"); continue
            for name, p in body.items():
                if not isinstance(name, str) or not PLAN_NAME.fullmatch(name) or name == "__proto__": errs.append(f"{here}: {str(name)[:60]!r} is not a plan name"); continue
                errs += _limits_problems(p, keys, f"{here}.{name}", plans=False, maxes=maxes)
            continue
        if section not in keys: errs.append(f"{here} is not a section of limits (known: {', '.join(keys)}{', plans' if plans else ''})"); continue
        if not isinstance(body, dict) or not body: errs.append(f"{here} must be an object of limit -> number"); continue
        for k, n in body.items():
            if k not in keys[section]: errs.append(f"{here}.{k} is not a limit (known: {', '.join(keys[section])})")
            elif isinstance(n, bool) or not isinstance(n, (int, float)) or n != n or not (0 < n <= MAX_NUMBER):
                errs.append(f"{here}.{k} must be a positive number (got {json.dumps(n)[:40]})")
            elif "usd" not in k and n != int(n): errs.append(f"{here}.{k} counts things, so it must be a whole number (got {n})")
            elif (maxes or {}).get(f"{section}.{k}") is not None and n > maxes[f"{section}.{k}"]:
                errs.append(f"{here}.{k} {n:g} is above the factory's ceiling for it ({maxes[f'{section}.{k}']:g}, molds/<mold>/branding/rules.json "
                            f"profile.app_limits_max): raising that ceiling is a reviewed change to the factory, never a brief or state edit")
    return errs

PACK = re.compile(r"[a-z][a-z0-9_-]{1,40}")                     # application.schema.json packs[] items
OWNED = "licensor_owned"

def _parts(settable):
    """{field: [sub-fields] or None (the whole field)} from app_settable's entries ("limits", "source_offer.upstreams")."""
    out = {}
    for e in settable:
        top, _, sub = str(e).partition(".")
        if sub: out.setdefault(top, []); out[top] is not None and out[top].append(sub)
        else: out[top] = None
    return out

def _upstreams_problems(v, packs):
    if not isinstance(v, dict) or not v: return ['profile.source_offer.upstreams must be an object {"<pack id>": "licensor_owned"}']
    errs = []
    for pid, how in v.items():
        if not isinstance(pid, str) or not PACK.fullmatch(pid): errs.append(f"profile.source_offer.upstreams: {str(pid)[:60]!r} is not a pack id"); continue
        if how != OWNED: errs.append(f"profile.source_offer.upstreams.{pid} must be \"{OWNED}\" (got {json.dumps(how)[:40]})")
        elif packs is not None and pid not in packs: errs.append(f"profile.source_offer.upstreams.{pid}: the app has no pack {pid} (application.json packs)")
    return errs

def problems(profile, mold_id, root, packs=None):
    """Sentences: what is wrong with an app's `profile` for its mold ([] when it is right, or absent). `packs`: the app's
    pack ids (application.json packs), when known, for source_offer.upstreams."""
    if profile is None: return []
    if not isinstance(profile, dict): return ["profile must be an object of profile fields"]
    if not profile: return ["profile is empty: leave it out instead"]
    s = spec(mold_id, root)
    if s is None: return [f"profile: {mold_id} takes no profile settings from an app's state (its branding rules name none)"]
    errs, settable = [], list(s["app_settable"])
    parts = _parts(settable)
    for k, v in profile.items():
        if parts.get(k):      # only some parts of this field are the app's (source_offer.upstreams)
            if not isinstance(v, dict) or not v: errs.append(f"profile.{k} must be an object of {', '.join(parts[k])}"); continue
            for sub, sv in v.items():
                if sub not in parts[k]: errs.append(f"profile.{k}.{sub} cannot be set by the app: {RESERVED.get(k, 'not settable from an app state')}")
                elif f"{k}.{sub}" == "source_offer.upstreams": errs += _upstreams_problems(sv, packs)
                else: errs.append(f"profile.{k}.{sub}: the factory has no check for this field yet, so it is refused")
        elif k in RESERVED: errs.append(f"profile.{k} cannot be set by the app: {RESERVED[k]}")
        elif k not in settable: errs.append(f"profile.{k} is not settable from an app's state (settable: {', '.join(settable)})")
        elif k == "member_keys":
            if not isinstance(v, bool): errs.append(f"profile.member_keys must be true or false (got {json.dumps(v)[:40]})")
        elif k == "limits":
            keys = limit_keys(os.path.join(root, "molds", mold_id, "codebase"))
            if keys is None: errs.append(f"profile.limits: the limit names could not be read from molds/{mold_id}/codebase/scripts/gen-packs.mjs (LIMIT_KEYS)")
            else: errs += ["profile." + e for e in _limits_problems(v, keys, maxes={k_: v_ for k_, v_ in (s.get("app_limits_max") or {}).items() if not k_.startswith("$")})]
        else: errs.append(f"profile.{k}: the factory has no check for this field yet, so it is refused")
    return errs

def flat(profile, at=""):
    """[("limits.runs.budget_usd_max", 40), ...] in a stable order, for messages."""
    out = []
    for k in sorted((profile or {}).keys(), key=str):
        v = profile[k]; p = f"{at}.{k}" if at else str(k)
        out += flat(v, p) if isinstance(v, dict) else [(p, v)]
    return out

def describe(profile):
    return ", ".join(f"{p} {('%g' % v) if isinstance(v, (int, float)) and not isinstance(v, bool) else json.dumps(v)}" for p, v in flat(profile)) or "none"

# ---- the brief -----------------------------------------------------------------------------------------------------
SECTION = re.compile(r"^##[ \t]+(profile|budgets?)[ \t]*(?:\([^)\n]*\))?[ \t]*$", re.I | re.M)   # the heading alone, or with a note in brackets
HEADING = re.compile(r"^#{1,3}\s", re.M)
MENTION = re.compile(r"(?<![\w.])limits((?:\.[A-Za-z0-9_-]+)+)")
# The number ends the clause: end of line, `,` `;` or `.` before a space or the end, or a bracket after a space. Anything
# else after it ("4 0", "4e9", "40k", "40 million", "40%", "400 but chose 40") makes the setting unreadable: refused.
ASSIGN = re.compile(r"`?[ \t]*(?:=|:)[ \t]*`?[ \t]*(?:US[ \t]?)?\$?[ \t]*([0-9]+(?:\.[0-9]+)?)`?(?=[ \t]*$|[,;.](?:\s|$)|[ \t]+\()", re.M)
OTHER = re.compile(r"^\s*(?:[-*]\s+)?`?([a-z_$][a-z0-9_]*)((?:\.[A-Za-z0-9_-]+)*)`?\s*(?:=|:)", re.M)
# The word settings (mold_v0-099): `member_keys = false`, `source_offer.upstreams.<pack id> = licensor_owned`. The word
# ends the clause as a number does above.
WORDSET = re.compile(r"(?<![\w.])(member_keys|source_offer\.upstreams\.([A-Za-z0-9_-]+))(?![\w.-])")
WORD = re.compile(r"`?[ \t]*(?:=|:)[ \t]*`?[ \t]*([A-Za-z_]+)`?(?=[ \t]*$|[,;.](?:\s|$)|[ \t]+\()", re.M)

def _clean(text):
    """The brief as a reader sees it: HTML comments, fenced code and struck-through text blanked (same length, so offsets
    hold); a setting hidden in any of them is never applied."""
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
    text = re.sub(r"<!--.*?(?:-->|\Z)", blank, text, flags=re.S)
    text = re.sub(r"^[ \t]*(```|~~~).*?(?:^[ \t]*\1[^\n]*$|\Z)", blank, text, flags=re.S | re.M)
    return re.sub(r"~~.*?~~", blank, text, flags=re.S)

def _sections(text):
    """[(heading, start, end)] of every `## Profile` / `## Budgets` section's body (to the next heading of level 1 to 3)."""
    out = []
    for m in SECTION.finditer(text):
        nxt = HEADING.search(text, m.end())
        out.append((m.group(0).strip(), m.end(), nxt.start() if nxt else len(text)))
    return out

def from_brief(text):
    """-> (profile or None, problems, notes). Reads `limits.<section>.<name> = <number>` (or `:`) in a `## Profile` or
    `## Budgets` section; `limits.plans.<plan>.<section>.<name> = <number>` for one plan; `member_keys = false` (or true)
    and `source_offer.upstreams.<pack id> = licensor_owned` (mold_v0-099). A setting written twice with two
    values, a value that is not a positive number, and (in `## Profile`) any other field is a problem; a `limits.` setting
    outside those sections is ignored and said."""
    prof, errs, notes, seen = {}, [], [], {}
    text = _clean(text); spans = []
    for head, start, end in _sections(text):
        body = text[start:end]; spans.append((start, end))
        for m in MENTION.finditer(body):
            path = m.group(1).lstrip(".").split(".")
            a = ASSIGN.match(body, m.end())
            name = "limits." + ".".join(path)
            if not a: errs.append(f"{head}: {name} has no value I can read; write it as `{name} = <a positive number>`"); continue
            n = float(a.group(1)); n = int(n) if n.is_integer() else n
            if len(path) not in (2, 4) or (len(path) == 4 and path[0] != "plans") or (len(path) == 2 and path[0] == "plans"):
                errs.append(f"{head}: {name} is not a limit (limits.<section>.<name>, or limits.plans.<plan>.<section>.<name>)"); continue
            if name in seen and seen[name] != n: errs.append(f"{head}: {name} is set twice ({seen[name]} and {n}); keep one"); continue
            seen[name] = n
            d = prof.setdefault("limits", {})
            for part in path[:-1]: d = d.setdefault(part, {})
            d[path[-1]] = n
        for m in WORDSET.finditer(body):
            name, w = m.group(1), WORD.match(body, m.end())
            if name == "member_keys":
                val = {"true": True, "false": False}.get(w.group(1).lower()) if w else None
                if val is None: errs.append(f"{head}: member_keys has no value I can read; write it as `member_keys = false` (or true)"); continue
                path = ["member_keys"]
            else:
                if not w or w.group(1) != OWNED: errs.append(f"{head}: {name} has no value I can read; write it as `{name} = {OWNED}`"); continue
                val, path = OWNED, ["source_offer", "upstreams", m.group(2)]
            if name in seen and seen[name] != val: errs.append(f"{head}: {name} is set twice ({json.dumps(seen[name])} and {json.dumps(val)}); keep one"); continue
            seen[name] = val
            d = prof
            for part in path[:-1]: d = d.setdefault(part, {})
            d[path[-1]] = val
        for m in OTHER.finditer(body):      # a reserved field written as a setting: said, never silently dropped
            if m.group(1) == "source_offer" and m.group(2).startswith(".upstreams."): continue   # the app's part, read above
            if m.group(1) in RESERVED: errs.append(f"{head}: {m.group(1)}{m.group(2)} cannot be set by the app: {RESERVED[m.group(1)]}")
    for m in MENTION.finditer(text):
        if not any(a <= m.start() < b for a, b in spans) and re.match(r"`?[ \t]*[=:]", text[m.end():]):
            notes.append(f"limits{m.group(1)} outside a ## Profile or ## Budgets section: ignored")
    for m in WORDSET.finditer(text):
        if not any(a <= m.start() < b for a, b in spans) and re.match(r"`?[ \t]*[=:]", text[m.end():]):
            notes.append(f"{m.group(1)} outside a ## Profile or ## Budgets section: ignored")
    return (prof or None), errs, notes

# ---- the build copy ------------------------------------------------------------------------------------------------
_NONE = object()
def _get(d, path):
    """The value at a dotted path of app_settable ("limits", "source_offer.upstreams") in d, else _NONE."""
    for part in path.split("."):
        if not isinstance(d, dict) or part not in d: return _NONE
        d = d[part]
    return d

def _put(doc, path, v):
    """Set (or, with _NONE, remove) the value at a dotted path, keeping the rest of its field; an emptied field goes."""
    *outer, last = path.split(".")
    at, chain = doc, []
    for part in outer:
        if not isinstance(at.get(part), dict):
            if v is _NONE: return
            at[part] = {}
        chain.append((at, part)); at = at[part]
    if v is _NONE: at.pop(last, None)
    else: at[last] = v
    for parent, part in reversed(chain):
        if parent[part] == {}: parent.pop(part)

def write(build_dir, app, root):
    """Write the app's `profile` into build_dir's profile file over the mold's own (each settable field: the app's value,
    else the mold's, else absent). Raises ValueError with the problems when the profile is wrong (nothing written).
    -> whether the file changed. A mold that takes no app profile: nothing (and an app profile is a problem)."""
    mold_id = app.get("mold_id"); prof = app.get("profile")
    errs = problems(prof, mold_id, root, packs=app.get("packs") if isinstance(app.get("packs"), list) else None)
    if errs: raise ValueError("; ".join(errs))
    s = spec(mold_id, root)
    if s is None: return False
    base_p = os.path.join(root, "molds", mold_id, "codebase", s["file"])
    base = _load(base_p) if os.path.isfile(base_p) else {}
    p = os.path.join(build_dir, s["file"])
    doc = _load(p) if os.path.isfile(p) else {}
    before = json.dumps(doc, sort_keys=True)
    # The shell merges a host pack's own profile under this file at the top level (scripts/gen-packs.mjs), so an app's
    # field would drop the host pack's whole field (its stricter limits too): refused rather than silently replaced.
    for hp in doc.get("host_packs") or [] if prof else []:
        hpp = os.path.join(build_dir, "packs", str(hp), "pack.json")
        try: hprof = ((_load(hpp).get("host") or {}).get("profile") or {}) if os.path.isfile(hpp) else {}
        except (OSError, ValueError): hprof = {}
        both = sorted(k for k in prof if k in hprof)
        if both: raise ValueError(f"host pack {hp} brings its own {', '.join(both)} in its profile, which the app's would replace whole; set them in one place")
    for k in s["app_settable"]:
        mine, theirs = _get(prof, k), _get(base, k)
        _put(doc, k, mine if mine is not _NONE else theirs)
    if json.dumps(doc, sort_keys=True) == before: return False
    if os.path.lexists(p): os.remove(p)                 # never write through a hard link into the mold
    with open(p, "w") as fh: fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return True

def check(build_dir, app, root):
    """Sentences: where build_dir does not carry the app's profile (the file, and the server's generated module)."""
    s = spec(app.get("mold_id"), root); prof = app.get("profile") or {}
    if s is None: return []
    bad = []
    p = os.path.join(build_dir, s["file"])
    have = _load(p) if os.path.isfile(p) else {}
    bp = os.path.join(root, "molds", app["mold_id"], "codebase", s["file"])
    base = _load(bp) if os.path.isfile(bp) else {}
    for k in s["app_settable"]:
        if _get(prof, k) is _NONE and _get(have, k) != _get(base, k): bad.append(f"{s['file']} carries a {k} the app does not set (left from an earlier build; rebuild the copy)")
    if not prof: return bad
    gen = os.path.join(build_dir, "src", "profile.generated.ts")
    m = re.search(r"GENERATED_PROFILE = (\{.*?\n\}) as const;", open(gen).read(), re.S) if os.path.isfile(gen) else None
    try: compiled = json.loads(m.group(1)) if m else None
    except ValueError: compiled = None
    for k in s["app_settable"]:
        v = _get(prof, k)
        if v is _NONE: continue
        if _get(have, k) != v: bad.append(f"{s['file']} does not carry the app's profile.{k} ({describe(_nest(k, v))})")
        if compiled is None or _get(compiled, k) != v: bad.append(f"src/profile.generated.ts does not carry the app's profile.{k} (the generator was not re-run)")
    return bad

def _nest(path, v):
    for part in reversed(path.split(".")): v = {part: v}
    return v
