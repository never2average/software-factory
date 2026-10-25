"""An application's own profile settings (mold_v0-090): application.json `profile`, written into its build copy.

A mold whose build reads a profile FILE (molds/<mold>/branding/rules.json `profile`; mold_v0's profile.json, which
scripts/gen-packs.mjs checks and compiles into src/profile.generated.ts) may let an app set some of that file's fields
from its own state. Which ones the mold names in the same rules (`profile.app_settable`); this module knows how to check
each one the factory can check. Today (mold_v0):

  limits                     src/rate-limits.ts: the platform's ceilings, e.g. limits.runs.budget_usd_max
  email                      src/email.ts (mold_v0-101): {"notifications": [groups], "provider": resend|none, "pitch": text},
                             the groups the shell knows (its NOTIFICATION_GROUPS); pitch: the welcome email's sentence
  email_from_address         the default sender's address (src/profile.ts; the sender's NAME is the brand's)
  member_keys                true or false (mold_v0-099): false turns per-member API keys off; clients sign in
                             (refused when the mold's rules name its /mcp sign-ins and the codebase has none:
                             profile.member_keys_off, mold_v0-116)
  legal                      {"company_name", "contact_email", "effective_date" (YYYY-MM-DD), and optionally
                             "jurisdiction", "terms_url", "privacy_url" (https://)} (mold_v0-109, the shell's src/legal.ts):
                             the app's Terms and Privacy pages (/terms, /privacy) and the links to them; absent, the app
                             has no legal pages. intake asks a new app for the company's legal name and contact address
  mcp_instructions           plain text up to 4000 characters (mold_v0-119; the shell's mold_v0-105): what the MCP server
                             tells an AI client about the app, over a host pack's and the packs' pack.json mcp.instructions.
                             From the brief: a `## MCP instructions` section (its text, paragraphs kept) or a
                             `mcp_instructions = <text>` line in `## Profile`
  landing                    the app's landing page at / (mold_v0-094; the shell's src/landing.ts, mold_v0-091 and its
                             pick-and-place sections): an object of plain text, true/false, numbers and lists, over the
                             pack's pack.json landing. The factory checks it as TEXT (landing_problems: plain text on one
                             line, links on this site, https:// or mailto:, sizes); its shape is the shell's, checked again
                             by the build (scripts/gen-packs.mjs with src/landing.ts), so the factory follows the shell's
                             sections as they change. From the brief: `landing.<key>.<key> = <text>` lines in ## Profile,
                             or a ## Landing section holding the whole block as one ```json fenced block
  source_offer.upstreams     {"<pack id>": "licensor_owned"} (mold_v0-099): the app's packs whose pinned upstream is
                             the app licensor's own project, which the build then does not offer. Only this part of
                             source_offer: its `app` part stays the factory's (defaults.source_offer, packs.py), and
                             each writer keeps the other's part

An entry of app_settable may be a dotted path (`source_offer.upstreams`): the app then sets that part of the field only.
Email defaults (mold_v0-101; rules `profile.email_defaults`): an app that sets neither email field, and whose host pack's
own profile does not either, still gets them in its build copy, so a declarative or zero-pack app is not left with the
shell's placeholder sender and no notifications:
  email_from_address   <app_id>@<the machine's notify_domain> (state/factory.local.json defaults.notify_domain, the
                       domain the operator verified for sending); no notify_domain, no default (intake asks)
  email.notifications  the rules' list (mold_v0: access_requests), plus due_dates when one of the app's packs declares a
                       record area with due dates (pack.json record_areas[].due), which the shell emails only when listed
A host pack that brings its own (the first product's host.profile) keeps them: the factory writes nothing over it.

Everything else in the profile is someone else's:

  name and the brand's words   the brand (surface.branding; branding.py set) writes them
  host_packs                   packs.py writes it from application.packs and mold.json packs.host_packs
  source_offer.app             the factory's defaults.source_offer (packs.py)
  billing, entitlements        money and plans: not settable from state (a ticket of their own)
  anything else                not settable from state; the shell's own default or a host pack's profile applies

Never a secret: every value this module accepts is a positive number under a name the shell already knows, true or
false, or the word licensor_owned under one of the app's own pack ids.

Where a value comes from: the brief (intake reads `limits.<section>.<name> = <number>`, `member_keys = false` and
`source_offer.upstreams.<pack id> = licensor_owned` and `legal.<field> = <text>` lines in a `## Profile` or `## Budgets` section, and
the landing page's `landing.<path> = <text>` lines or `## Landing` JSON block; docs/INTAKE.md;
the legal block may also be an answer to intake's `legal` question), recorded in application.json `profile`, written by branding.py prepare and
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

# ---- email (mold_v0-101) -------------------------------------------------------------------------------------------
ADDRESS = re.compile(r'[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+')   # the shell's (src/email.ts ADDRESS)
EMAIL_KEYS = ("provider", "notifications", "pitch")
PROVIDERS = ("resend", "none")      # the shell's test transport is never a deploy's

def email_groups(codebase):
    """The notification groups the shell knows (src/email.ts NOTIFICATION_GROUPS), or None."""
    try: src = open(os.path.join(codebase, "src", "email.ts")).read()
    except OSError: return None
    m = re.search(r"^export const NOTIFICATION_GROUPS = \{(.*?)^\}", src, re.S | re.M)
    out = re.findall(r"^\s*([a-z_]+):\s*\[", m.group(1), re.M) if m else []
    return out or None

def address_problem(v, at="email_from_address"):
    if not isinstance(v, str) or len(v) > 254 or not ADDRESS.fullmatch(v):
        return f"{at} must be one email address like hello@yourcompany.com (got {json.dumps(v)[:60]})"
    return None

def _email_problems(v, groups, at="email"):
    if not isinstance(v, dict) or not v: return [f"{at} must be an object: {{\"notifications\": [groups]}} (and optionally \"provider\")"]
    errs = []
    for k in v:
        if k not in EMAIL_KEYS: errs.append(f"{at}.{k} is not an email setting (known: {', '.join(EMAIL_KEYS)})")
    if "provider" in v and v["provider"] not in PROVIDERS: errs.append(f"{at}.provider must be {' or '.join(PROVIDERS)} (got {json.dumps(v['provider'])[:40]})")
    if "pitch" in v and (not isinstance(v["pitch"], str) or not v["pitch"].strip() or len(v["pitch"]) > 400 or re.search(r"[\x00-\x1f\x7f<>]", v["pitch"])):
        errs.append(f"{at}.pitch: plain text on one line, up to 400 characters, no < or >")
    if "notifications" in v:
        n = v["notifications"]
        if not isinstance(n, list) or len(set(map(str, n))) != len(n) or not all(isinstance(g, str) for g in n):
            errs.append(f"{at}.notifications must be a list of groups, each once")
        else:
            bad = [g for g in n if g not in groups]
            if bad: errs.append(f"{at}.notifications: {', '.join(bad)[:120]} {'is not a group' if len(bad) == 1 else 'are not groups'} (known: {', '.join(groups)})")
    return errs

# ---- the MCP server's instructions (mold_v0-119) -------------------------------------------------------------------
# The shell's rule (scripts/gen-packs.mjs profile mcp_instructions): text, not blank, at most 4000 characters, no control
# character but a tab or a line break, no zero-width, direction or invisible tag character.
MAX_INSTRUCTIONS = 4000
INSTRUCTIONS_BAD = re.compile("[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\U000e0000-\U000e007f\ufe00-\ufe0f\U000e0100-\U000e01ef]")

def instructions_problem(v, at="mcp_instructions"):
    if not isinstance(v, str) or not v.strip(): return f"{at} must be text: what the MCP server tells an AI client about the app"
    if len(v) > MAX_INSTRUCTIONS: return f"{at}: at most {MAX_INSTRUCTIONS} characters (got {len(v)})"
    if INSTRUCTIONS_BAD.search(v): return f"{at}: plain text only (line breaks are fine; no control, zero-width or direction characters)"
    return None
# ---- the landing page (mold_v0-094) --------------------------------------------------------------------------------
# A TEXT check (the ticket's "text validator"): what the factory can say about any landing block whatever its sections,
# so a brief is refused at intake for text the page could not show. The block's shape (which sections, which fields, how
# many of each) is the shell's (src/landing.ts landingProblems, mold_v0-091 and mold_v0-122's pick-and-place sections),
# checked again when the build runs scripts/gen-packs.mjs: a shape the shell refuses fails the build copy, never a deploy.
LANDING_MAX_BYTES = 64 * 1024
LANDING_MAX_TEXT = 1200            # the shell's longest text (an FAQ answer)
LANDING_MAX_LIST = 50
LANDING_MAX_DEPTH = 6
LANDING_KEY = re.compile(r"[a-z][a-z0-9_]{0,40}")
# The shell's (src/landing.ts NOT_PLAIN): C0 and C1 controls (line breaks included), zero-width, bidirectional and tag
# characters, variation selectors.
LANDING_NOT_PLAIN = re.compile("[\x00-\x1f\x7f-\x9f\xad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb"
                               "\U000e0000-\U000e007f\ufe00-\ufe0f\U000e0100-\U000e01ef]")

def href_problem(h):
    """The shell's rule for a link (src/landing.ts hrefProblem): a path of this site, an https:// or a mailto: address."""
    if not isinstance(h, str) or not h: return "an address is required"
    if len(h) > 500: return "at most 500 characters"
    if not re.fullmatch(r"[!-~]+", h) or re.search(r"[\"'<>\\`]", h): return "an address is printable ASCII with no spaces, quotes, angle brackets or backslashes"
    if h.startswith("/"):
        return "a path of this site has no //, /./, /../ or encoded / and \\ (they can lead to another site)" if re.search(r"//|/\.\.?(/|$|[?#])|%2f|%5c", h, re.I) else None
    if re.match(r"https://", h, re.I):
        from urllib.parse import urlsplit
        try: u = urlsplit(h)
        except ValueError: return "not a valid https:// address"
        return None if u.scheme.lower() == "https" and u.hostname and not u.username and not u.password else "an https:// address with a host and no user name or password"
    if re.fullmatch(r"mailto:[^@/?#]+@[^@/?#]+(\?[^#]*)?", h, re.I): return None
    return "a path of this site (/install), an https:// address or a mailto: address"

def landing_problems(v, at="landing"):
    """Sentences: what is wrong with a landing block as text ([] when nothing). Never its shape (the shell's)."""
    if not isinstance(v, dict) or not v: return [f"{at} must be an object of the landing page's sections (molds/mold_v0/codebase/src/landing.ts)"]
    errs = []
    if len(json.dumps(v, ensure_ascii=False).encode()) > LANDING_MAX_BYTES: return [f"{at} is larger than {LANDING_MAX_BYTES // 1024} KB"]
    def walk(x, path, depth, key):
        if len(errs) >= 20: return
        if depth > LANDING_MAX_DEPTH: errs.append(f"{path}: nested deeper than {LANDING_MAX_DEPTH} levels"); return
        if isinstance(x, dict):
            for k, y in x.items():
                if k == "$comment": continue
                if not isinstance(k, str) or not LANDING_KEY.fullmatch(k): errs.append(f"{path}: {str(k)[:40]!r} is not a field name (lowercase letters, digits and _)"); continue
                walk(y, f"{path}.{k}", depth + 1, k)
        elif isinstance(x, list):
            if len(x) > LANDING_MAX_LIST: errs.append(f"{path}: at most {LANDING_MAX_LIST} items"); return
            for i, y in enumerate(x): walk(y, f"{path}[{i}]", depth + 1, key)
        elif isinstance(x, bool): pass
        elif isinstance(x, (int, float)):
            if x != x or x in (float("inf"), float("-inf")): errs.append(f"{path}: a number")
        elif isinstance(x, str):
            if key == "href":
                e = href_problem(x)
                if e: errs.append(f"{path}: {e}")
            elif not x.strip(): errs.append(f"{path}: text is required")
            elif len(x) > LANDING_MAX_TEXT: errs.append(f"{path}: at most {LANDING_MAX_TEXT} characters")
            elif LANDING_NOT_PLAIN.search(x): errs.append(f"{path}: plain text on one line: no line breaks, control or invisible characters")
        else: errs.append(f"{path}: text, true or false, a number, a list or an object (got {type(x).__name__})")
    walk(v, at, 0, None)
    return errs

# ---- the legal pages (mold_v0-109) ---------------------------------------------------------------------------------
# The shell's rules (molds/mold_v0/codebase/src/legal.ts legalProblems), checked here so a brief or an answer is refused
# at intake, before a build: plain text on one line, one address, a date that exists, own pages on https:// only.
LEGAL_KEYS = ("company_name", "contact_email", "effective_date", "jurisdiction", "terms_url", "privacy_url")
LEGAL_REQUIRED = ("company_name", "contact_email", "effective_date")
NOT_PLAIN = re.compile("[\x00-\x1f\x7f-\x9f\xad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb<>{}\\[\\]"
                       "\U000e0000-\U000e007f\ufe00-\ufe0f\U000e0100-\U000e01ef]")
LEGAL_ADDRESS = re.compile(r"[^\s@<>,;\"'`\\/?#%&:]+@[^\s@<>,;\"'`\\/?#%&:]+\.[^\s@<>,;\"'`\\/?#%&:]+")

def _legal_text(v, n):
    if not isinstance(v, str) or not v.strip(): return "text is required"
    if len(v) > n: return f"at most {n} characters"
    if NOT_PLAIN.search(v): return "plain text on one line: no line breaks, control or invisible characters, angle brackets, braces or square brackets"
    return None

def _legal_url(v):
    if not isinstance(v, str) or not v or len(v) > 500 or not re.fullmatch(r"https://[!-~]+", v, re.I) or re.search(r"[\"'<>\\`]", v):
        return "an https:// address (printable, no spaces, quotes, angle brackets or backslashes)"
    from urllib.parse import urlsplit
    try: u = urlsplit(v)
    except ValueError: return "not a valid https:// address"
    return None if u.hostname and not u.username and not u.password else "an https:// address with a host and no user name or password"

def legal_problems(v, at="legal"):
    """Sentences: what is wrong with a `legal` block ([] when it is right). The shell's own check runs again at build."""
    import datetime
    if not isinstance(v, dict): return [f"{at} must be an object: company_name, contact_email, effective_date (and optionally jurisdiction, terms_url, privacy_url)"]
    errs = [f"{at}.{k} is not a legal field (known: {', '.join(LEGAL_KEYS)})" for k in v if k not in LEGAL_KEYS]
    errs += [f"{at}.{k} is required" for k in LEGAL_REQUIRED if k not in v]
    for k, n in (("company_name", 160), ("jurisdiction", 120)):
        if k in v and _legal_text(v[k], n): errs.append(f"{at}.{k}: {_legal_text(v[k], n)}")
    if "contact_email" in v and not (isinstance(v["contact_email"], str) and len(v["contact_email"]) <= 254 and LEGAL_ADDRESS.fullmatch(v["contact_email"])):
        errs.append(f"{at}.contact_email must be one email address like legal@yourcompany.com (got {json.dumps(v['contact_email'])[:60]})")
    if "effective_date" in v:
        d = v["effective_date"]
        try: ok = isinstance(d, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) and datetime.date.fromisoformat(d).isoformat() == d
        except ValueError: ok = False
        if not ok: errs.append(f"{at}.effective_date must be a date that exists, written YYYY-MM-DD (got {json.dumps(d)[:30]})")
    for k in ("terms_url", "privacy_url"):
        if k in v and _legal_url(v[k]): errs.append(f"{at}.{k}: {_legal_url(v[k])}")
    return errs

def legal_from_answer(a):
    """An answer to intake's legal question -> ({company_name, contact_email} or None, problem or None). "later" (or
    none, skip, blank): (None, None). The address is the last one in the answer; the name is what comes before it."""
    if isinstance(a, dict):
        e = legal_problems(a)
        return (None, "; ".join(e)) if e else ({k: a[k] for k in LEGAL_KEYS if k in a}, None)
    t = str(a or "").strip()
    if t.lower() in ("later", "none", "skip", ""): return None, None
    m = list(re.finditer(r"[^\s,;<>()\"']+@[^\s,;<>()\"']+", t))
    if not m: return None, f"no email address in {t[:80]!r}: write the company's legal name, then the address, like Acme Ltd, legal@acme.com"
    name = re.sub(r"[\s,;:(<\-]+$", "", t[:m[-1].start()]).strip()
    rest = t[m[-1].end():].strip(" >)")
    got = {"company_name": name, "contact_email": m[-1].group(0)}
    if rest: return None, f"nothing may follow the address in {t[:80]!r}: write the company's legal name, then the address"
    e = [x for x in legal_problems({**got, "effective_date": "2000-01-01"})]
    return (None, "; ".join(e)) if e else (got, None)

def _pack_json(pid, root, build_dir=None):
    """A pack's shell pack.json: the build copy's, else packs/<pid>/files/packs/<pid>/pack.json; {} when unreadable."""
    for p in ([os.path.join(build_dir, "packs", pid, "pack.json")] if build_dir else []) + [os.path.join(root, "packs", pid, "files", "packs", pid, "pack.json")]:
        if os.path.isfile(p):
            try: return _load(p)
            except (OSError, ValueError): return {}
    return {}

def _host_profile(app, root, build_dir=None):
    """The profile the app's host pack brings (pack.json host.profile; only a pack the mold lets be one), or {}."""
    mold_id = app.get("mold_id")
    try: allowed = ((_load(os.path.join(root, "molds", str(mold_id), "mold.json")).get("packs") or {}).get("host_packs") or [])
    except (OSError, ValueError): allowed = []
    out = {}
    for pid in app.get("packs") or []:
        if pid in allowed and isinstance(pid, str): out.update(((_pack_json(pid, root, build_dir).get("host") or {}).get("profile")) or {})
    return out

def notify_domain(root):
    """The domain this machine's operator verified for sending (defaults.notify_domain), or None."""
    from factory_local import load_factory
    d = str((load_factory(os.path.join(root, "state")).get("defaults") or {}).get("notify_domain") or "").strip().lower()
    return d if re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}", d) and d not in ("example.com", "example.org", "example.net") else None

def email_defaults(app, root, build_dir=None):
    """{field: value} the factory writes for an app that sets neither email field itself (see the module's doc). {} for a
    mold with no `email_defaults` rule, and for each field a host pack's profile brings."""
    s = spec(app.get("mold_id"), root); d = (s or {}).get("email_defaults")
    if not d: return {}
    prof, host, out = app.get("profile") or {}, _host_profile(app, root, build_dir), {}
    if "email_from_address" not in prof and "email_from_address" not in host:
        dom, aid = notify_domain(root), str(app.get("app_id") or "")
        if dom and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", aid):
            addr = str(d.get("from") or "{app_id}@{notify_domain}").replace("{app_id}", aid).replace("{notify_domain}", dom)
            if not address_problem(addr): out["email_from_address"] = addr
    if "email" not in prof and "email" not in host:
        groups = list(d.get("notifications") or [])
        if "due_dates" not in groups and any(isinstance(a, dict) and a.get("due") for pid in app.get("packs") or [] if isinstance(pid, str)
                                             for a in (_pack_json(pid, root, build_dir).get("record_areas") or [])):
            groups.append("due_dates")
        out["email"] = {"notifications": groups}
    return out

def effective(app, root, build_dir=None):
    """The settable fields the build copy carries: the app's own over the email defaults."""
    return {**email_defaults(app, root, build_dir), **(app.get("profile") or {})}

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

def member_keys_off_problems(s, mold_id, root):
    """member_keys: false (mold_v0-116) leaves signing in as the only way an AI client reaches /mcp. Refused when the
    mold's rules (profile.member_keys_off.mcp_sign_in_any) name the files of its /mcp sign-ins and the codebase has none
    of them. A mold whose rules name none is not judged here. Whether the deployed sign-in works is provision.py's check."""
    need = ((s or {}).get("member_keys_off") or {}).get("mcp_sign_in_any")
    if not isinstance(need, list) or not need: return []
    cb = os.path.join(root, "molds", str(mold_id), "codebase")
    if any(isinstance(f, str) and os.path.isfile(os.path.join(cb, f)) for f in need): return []
    return [f"profile.member_keys false would leave AI clients no way into /mcp: member API keys off, and molds/{mold_id}/codebase has no "
            f"sign-in for /mcp ({' or '.join(str(f) for f in need)}). Leave member_keys out (keys on), or give the mold a sign-in for /mcp first"]

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
            elif v is False: errs += member_keys_off_problems(s, mold_id, root)
        elif k == "limits":
            keys = limit_keys(os.path.join(root, "molds", mold_id, "codebase"))
            if keys is None: errs.append(f"profile.limits: the limit names could not be read from molds/{mold_id}/codebase/scripts/gen-packs.mjs (LIMIT_KEYS)")
            else: errs += ["profile." + e for e in _limits_problems(v, keys, maxes={k_: v_ for k_, v_ in (s.get("app_limits_max") or {}).items() if not k_.startswith("$")})]
        elif k == "email":
            groups = email_groups(os.path.join(root, "molds", mold_id, "codebase"))
            if groups is None: errs.append(f"profile.email: the notification groups could not be read from molds/{mold_id}/codebase/src/email.ts (NOTIFICATION_GROUPS)")
            else: errs += ["profile." + e for e in _email_problems(v, groups)]
        elif k == "email_from_address":
            e = address_problem(v)
            if e: errs.append("profile." + e)
        elif k == "legal": errs += legal_problems(v, "profile.legal")
        elif k == "mcp_instructions":
            e = instructions_problem(v, "profile.mcp_instructions")
            if e: errs.append(e)
        elif k == "landing": errs += landing_problems(v, "profile.landing")
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
EMAIL_LINE = re.compile(r"^\s*(?:[-*]\s+)?`?(email_from_address|email\.notifications|email\.provider|email\.pitch)`?[ \t]*(?:=|:)[ \t]*([^\n]*?)[ \t]*$", re.M | re.I)
# The legal pages (mold_v0-109): `legal.company_name = Acme Ltd`, `legal.contact_email = legal@acme.com`,
# `legal.jurisdiction = England and Wales`, `legal.effective_date = 2026-10-23`, `legal.terms_url = https://...`.
LEGAL_LINE = re.compile(r"^\s*(?:[-*]\s+)?`?legal\.([a-z_]+)`?[ \t]*(?:=|:)[ \t]*([^\n]*?)[ \t]*$", re.M | re.I)
# The MCP server's instructions (mold_v0-119): `mcp_instructions = <text>` in ## Profile, or a `## MCP instructions`
# section whose whole text is them (paragraphs kept).
INSTRUCTIONS_LINE = re.compile(r"^\s*(?:[-*]\s+)?`?mcp_instructions`?[ \t]*(?:=|:)[ \t]*([^\n]*?)[ \t]*$", re.M | re.I)
INSTRUCTIONS_SECTION = re.compile(r"^##[ \t]+MCP[ \t]+instructions[ \t]*:?[ \t]*$", re.I | re.M)
# The landing page (mold_v0-094): `landing.hero.headline = <text>` (any path of field names; `true`/`false` are kept as
# true/false), or the whole block as JSON in a ```json fence under `## Landing`.
LANDING_LINE = re.compile(r"^\s*(?:[-*]\s+)?`?landing((?:\.[a-z][a-z0-9_]{0,40}){1,6})`?[ \t]*(?:=|:)[ \t]*([^\n]*?)[ \t]*$", re.M)
LANDING_SECTION = re.compile(r"^##[ \t]+Landing(?:[ \t]+page)?[ \t]*:?[ \t]*$", re.I | re.M)
LANDING_FENCE = re.compile(r"^[ \t]*```[ \t]*json[ \t]*\n(.*?)^[ \t]*```[ \t]*$", re.S | re.M | re.I)
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
    `## Budgets` section; `limits.plans.<plan>.<section>.<name> = <number>` for one plan; `mcp_instructions = <text>`, or
    a `## MCP instructions` section (mold_v0-119); `email_from_address = <address>`,
    `email.notifications = <group>, <group>` (or `none`) and `email.provider = resend|none` (mold_v0-101); `member_keys =
    false` (or true) and `source_offer.upstreams.<pack id> = licensor_owned` (mold_v0-099); `legal.<field> = <text>`
    (mold_v0-109: company_name, contact_email, jurisdiction, effective_date, terms_url, privacy_url). A setting written twice with two
    values, a value that is not a positive number, and (in `## Profile`) any other field is a problem; a `limits.` setting
    outside those sections is ignored and said."""
    prof, errs, notes, seen = {}, [], [], {}
    raw_text, text = text, _clean(text); spans = []
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
        # The email settings (mold_v0-101): `email_from_address = hello@yourcompany.com`, `email.notifications = a, b`
        # (or `none`), `email.provider = resend|none`. Checked with the rest by problems().
        for m in EMAIL_LINE.finditer(body):
            key, raw = m.group(1).lower(), m.group(2).strip().strip("`").strip()
            if key in seen and seen[key] != raw: errs.append(f"{head}: {key} is set twice ({seen[key]} and {raw}); keep one"); continue
            seen[key] = raw
            if key == "email_from_address": prof["email_from_address"] = raw
            elif key == "email.notifications":
                prof.setdefault("email", {})["notifications"] = [] if raw.lower() in ("none", "off", "") else [g.strip().strip("`") for g in raw.split(",") if g.strip()]
            elif key == "email.pitch": prof.setdefault("email", {})["pitch"] = raw
            else: prof.setdefault("email", {})["provider"] = raw.lower()
        for m in INSTRUCTIONS_LINE.finditer(body):
            raw = m.group(1).strip().strip("`").strip()
            if "mcp_instructions" in seen and seen["mcp_instructions"] != raw: errs.append(f"{head}: mcp_instructions is set twice; keep one"); continue
            seen["mcp_instructions"] = raw
            prof["mcp_instructions"] = raw
        for m in LANDING_LINE.finditer(body):
            path, raw = m.group(1).lstrip(".").split("."), m.group(2).strip().strip("`").strip()
            name = "landing." + ".".join(path)
            if name in seen and seen[name] != raw: errs.append(f"{head}: {name} is set twice ({seen[name]} and {raw}); keep one"); continue
            seen[name] = raw
            d, bad = prof.setdefault("landing", {}), False
            for part in path[:-1]:
                if not isinstance(d.setdefault(part, {}), dict): bad = True; break
                d = d[part]
            if bad or isinstance(d.get(path[-1]), dict): errs.append(f"{head}: {name} is both a field and a group of fields; keep one"); continue
            d[path[-1]] = {"true": True, "false": False}.get(raw, raw)
        for m in LEGAL_LINE.finditer(body):
            key, raw = m.group(1).lower(), m.group(2).strip().strip("`").strip()
            name = f"legal.{key}"
            if name in seen and seen[name] != raw: errs.append(f"{head}: {name} is set twice ({seen[name]} and {raw}); keep one"); continue
            seen[name] = raw
            prof.setdefault("legal", {})[key] = raw
    for m in INSTRUCTIONS_SECTION.finditer(text):
        nxt = HEADING.search(text, m.end())
        raw = "\n".join(l.rstrip() for l in text[m.end():nxt.start() if nxt else len(text)].strip("\n").splitlines()).strip()
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        if not raw: errs.append(f"{m.group(0).strip()}: the section is empty; write what the MCP server should tell AI clients about the app, or remove it"); continue
        if "mcp_instructions" in prof: errs.append(f"{m.group(0).strip()}: the MCP instructions are given twice (here and as mcp_instructions in ## Profile, or in two sections); keep one"); continue
        prof["mcp_instructions"] = raw
    # The landing page as one JSON block (mold_v0-094): read from the brief with its fences kept (_clean blanks code),
    # HTML comments and struck-through text still left out.
    keep = re.sub(r"<!--.*?(?:-->|\Z)", lambda m: re.sub(r"[^\n]", " ", m.group(0)), raw_text, flags=re.S)
    for m in LANDING_SECTION.finditer(keep):
        nxt = HEADING.search(keep, m.end())
        body = keep[m.end():nxt.start() if nxt else len(keep)]
        f = LANDING_FENCE.search(body)
        if not f: errs.append(f"{m.group(0).strip()}: write the landing block as JSON in one ```json fenced block (or use landing.<field> = <text> lines in ## Profile)"); continue
        try: block = json.loads(f.group(1))
        except ValueError as x: errs.append(f"{m.group(0).strip()}: the JSON block does not read ({str(x)[:120]})"); continue
        if "landing" in prof: errs.append(f"{m.group(0).strip()}: the landing page is given twice (here and as landing. lines in ## Profile, or in two sections); keep one"); continue
        prof["landing"] = block
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

# Settings that name the app's packs: gen-packs refuses them until the packs are in the build copy, so branding.py
# prepare (which runs before packs.py apply) leaves them out and packs.py apply writes them.
NEEDS_PACKS = ("source_offer.upstreams",)

def write(build_dir, app, root, packs_applied=True):
    """Write the app's `profile` into build_dir's profile file over the mold's own (each settable field: the app's value,
    else the mold's, else absent). Raises ValueError with the problems when the profile is wrong (nothing written).
    packs_applied=False (branding.py prepare, before packs.py apply): the NEEDS_PACKS settings are left out.
    -> whether the file changed. A mold that takes no app profile: nothing (and an app profile is a problem)."""
    mold_id = app.get("mold_id"); prof = app.get("profile")
    errs = problems(prof, mold_id, root, packs=app.get("packs") if isinstance(app.get("packs"), list) else None)
    if errs: raise ValueError("; ".join(errs))
    s = spec(mold_id, root)
    if s is None: return False
    eff = effective(app, root, build_dir)
    base_p = os.path.join(root, "molds", mold_id, "codebase", s["file"])
    base = _load(base_p) if os.path.isfile(base_p) else {}
    p = os.path.join(build_dir, s["file"])
    doc = _load(p) if os.path.isfile(p) else {}
    before = json.dumps(doc, sort_keys=True)
    # The shell merges a host pack's own profile under this file at the top level (scripts/gen-packs.mjs), so an app's
    # field would drop the host pack's whole field (its stricter limits too): refused rather than silently replaced.
    for hp in doc.get("host_packs") or []:
        hpp = os.path.join(build_dir, "packs", str(hp), "pack.json")
        try: hprof = ((_load(hpp).get("host") or {}).get("profile") or {}) if os.path.isfile(hpp) else {}
        except (OSError, ValueError): hprof = {}
        both = sorted(k for k in prof or {} if k in hprof)
        if both: raise ValueError(f"host pack {hp} brings its own {', '.join(both)} in its profile, which the app's would replace whole; set them in one place")
        for k in hprof:      # a default never goes over what a host pack brings (mold_v0-101)
            if k not in (prof or {}): eff.pop(k, None)
    for k in s["app_settable"]:
        mine = _get(eff, k)
        if not packs_applied and k in NEEDS_PACKS: mine = _NONE
        _put(doc, k, mine if mine is not _NONE else _get(base, k))
    if json.dumps(doc, sort_keys=True) == before: return False
    if os.path.lexists(p): os.remove(p)                 # never write through a hard link into the mold
    with open(p, "w") as fh: fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return True

# Fields the shell compiles into modules of their own, never the profile modules (scripts/gen-packs.mjs): the module and
# what shows the app's value reached it. legal (mold_v0-109): the checked block itself. landing (mold_v0-094): the page
# the build writes is the pack's block with the app's over it, converted to sections, so only that it wrote one.
COMPILED_ELSEWHERE = {
    "legal": ("src/legal.generated.ts", lambda src, v: f'"company_name": {json.dumps(v.get("company_name"), ensure_ascii=False)}' in src if isinstance(v, dict) else False),
    "landing": ("web/src/config/landing.generated.ts", lambda src, v: "export const landing: LandingBlock | null = null;" not in src
                and all(json.dumps(t, ensure_ascii=False) in src for t in _texts(v)[:50])),
}

def _texts(v):
    """Every text of a block, in order (the app's own words the build's page must carry)."""
    if isinstance(v, dict): return [t for k, x in v.items() if k != "$comment" for t in _texts(x)]
    if isinstance(v, list): return [t for x in v for t in _texts(x)]
    return [v] if isinstance(v, str) else []

def check(build_dir, app, root):
    """Sentences: where build_dir does not carry the app's profile (the file, and the server's generated module)."""
    s = spec(app.get("mold_id"), root)
    if s is None: return []
    prof = effective(app, root, build_dir)
    bad = []
    p = os.path.join(build_dir, s["file"])
    have = _load(p) if os.path.isfile(p) else {}
    bp = os.path.join(root, "molds", app["mold_id"], "codebase", s["file"])
    base = _load(bp) if os.path.isfile(bp) else {}
    for k in s["app_settable"]:
        if _get(prof, k) is _NONE and _get(have, k) != _get(base, k): bad.append(f"{s['file']} carries a {k} the app does not set (left from an earlier build; rebuild the copy)")
    own = app.get("profile") or {}
    if not prof: return bad
    gen = os.path.join(build_dir, "src", "profile.generated.ts")
    m = re.search(r"GENERATED_PROFILE = (\{.*?\n\}) as const;", open(gen).read(), re.S) if os.path.isfile(gen) else None
    try: compiled = json.loads(m.group(1)) if m else None
    except ValueError: compiled = None
    for k in s["app_settable"]:
        v = _get(prof, k)
        if v is _NONE: continue
        what = f"the app's profile.{k}" if _get(own, k) is not _NONE else f"the factory's email default {k}"
        if _get(have, k) != v: bad.append(f"{s['file']} does not carry {what} ({describe(_nest(k, v))})")
        if k in COMPILED_ELSEWHERE:
            mod, carried = COMPILED_ELSEWHERE[k]
            try: src = open(os.path.join(build_dir, mod)).read()
            except OSError: src = None
            if src is None or not carried(src, v): bad.append(f"{mod} does not carry {what} (the generator was not re-run)")
        elif compiled is None or _get(compiled, k) != v: bad.append(f"src/profile.generated.ts does not carry {what} (the generator was not re-run)")
    return bad

def _nest(path, v):
    for part in reversed(path.split(".")): v = {part: v}
    return v
