#!/usr/bin/env python3
"""app_spec.py: one JSON file that describes an application completely, checked against its mold's own schema.

  app_spec.py generate [--check]        write schemas/<mold_id>.app.schema.json for every mold that has spec rules
                                        (mold_v0, mold_v1) from the molds and the factory's own schemas; --check writes
                                        nothing and exits 1 when a file on disk is not what generation gives (stale)
  app_spec.py check <spec.json> [--json]
                                        is the spec complete for its mold? Every problem in plain words: "missing: ...",
                                        "not supported: ...", "wrong value: ...". Exit 0 complete, 1 not yet, 2 could
                                        not check (no such file, not JSON, no mold_id, a mold with no schema)
  app_spec.py brief <spec.json> --app <app_id>
                                        print the brief the spec turns into (what `mint.py new --spec` writes)
  app_spec.py apps [--json] [--from <checkout>]
                                        read every application's state (and its packs) as a spec and check it against its
                                        mold's schema: what each live app still lacks. Read-only; never changes an app
  app_spec.py --self-test

`factory.py spec check|generate|apps` runs the same; `factory.py validate` fails when a generated schema is stale; `mint.py
new <app_id> --spec <file>` mints from a spec (it writes the brief the spec says, then follows the brief path exactly).

The schemas are GENERATED (never hand-edited): every rule comes from a file the mold or the factory already has, so a change
there that is not regenerated fails `factory.py validate`:
  mold_v0: molds/mold_v0/mold.json (targets, pack id, what it does not need), molds/mold_v0/branding/rules.json (profile
           fields an app may set, budget ceilings), molds/mold_v0/codebase/packs/pack.schema.json (embedded whole: a pack
           inline), codebase scripts/gen-packs.mjs LIMIT_KEYS and src/email.ts NOTIFICATION_GROUPS
  mold_v1: molds/mold_v1/branding/rules.json, packs.py (pack id), intake.py (inference providers)
  both:    state/application/app_id/{application,infrastructure}.schema.json (addresses, colours, domains, capabilities,
           dictation)
"""
import shutil, ast, copy, hashlib, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
ROOT = os.path.dirname(os.path.dirname(HERE))
import spec_schema

URL = "https://raw.githubusercontent.com/never2average/software-factory/main/schemas/{mold}.app.schema.json"
MOLDS = ("mold_v0", "mold_v1")
GEN = ".claude/scripts/app_spec.py generate"
APP_ID = "^[a-z][a-z0-9_]{2,40}$"   # mint.py new
SCHEMA_DIR = "schemas"

def load(p):
    with open(p) as fh: return json.load(fh)
def dumps(o): return json.dumps(o, indent=2, ensure_ascii=False) + "\n"
def rel(p, root): return os.path.relpath(p, root)

def D(text, md=None, **kw):
    """description + markdownDescription (VS Code shows the second on hover)."""
    return dict(description=text, markdownDescription=md or text, **kw)

# ---- sources ---------------------------------------------------------------------------------------------------------
def sources(mold, root):
    s = ["state/application/app_id/application.schema.json", "state/application/app_id/infrastructure.schema.json", ".claude/scripts/app_spec.py"]
    if mold == "mold_v0":
        s += ["molds/mold_v0/mold.json", "molds/mold_v0/branding/rules.json", "molds/mold_v0/codebase/packs/pack.schema.json",
              "molds/mold_v0/codebase/scripts/gen-packs.mjs", "molds/mold_v0/codebase/src/email.ts", "molds/mold_v0/codebase/src/developer-config.ts",
              "molds/mold_v0/codebase/src/features.json"]
    else:
        s += ["molds/mold_v1/branding/rules.json", ".claude/scripts/packs.py", ".claude/scripts/intake.py"]
    return s

def _sha(p):
    with open(p, "rb") as fh: return hashlib.sha256(fh.read()).hexdigest()

def _intake_providers(root):
    """INFERENCE_SECRETS in intake.py, read without importing it: {provider: [secret names]}."""
    tree = ast.parse(open(os.path.join(root, ".claude", "scripts", "intake.py")).read())
    for n in tree.body:
        if isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "INFERENCE_SECRETS" for t in n.targets):
            return ast.literal_eval(n.value)
    raise SystemExit("intake.py has no INFERENCE_SECRETS: the mold_v1 spec schema cannot say which inference providers exist")

def _packs_py_pack_id(root):
    src = open(os.path.join(root, ".claude", "scripts", "packs.py")).read()
    m = re.search(r'^PACK_ID = re\.compile\(r"(.+?)"\)', src, re.M)
    if not m: raise SystemExit("packs.py has no PACK_ID: the mold_v1 spec schema cannot say what a pack id looks like")
    return m.group(1)

# ---- shared blocks ---------------------------------------------------------------------------------------------------
def _common(mold, root):
    A = load(os.path.join(root, "state", "application", "app_id", "application.schema.json"))
    I = load(os.path.join(root, "state", "application", "app_id", "infrastructure.schema.json"))
    ap = A["properties"]
    email = dict(ap["workspace"]["properties"]["members"]["items"]["properties"]["email"])
    admin = dict(ap["platform_admins"]["items"])
    colour_pat = ap["surface"]["properties"]["branding"]["properties"]["brand_color"]["pattern"]
    domain = dict(I["properties"]["compose_remote"]["properties"]["domain"]); domain.pop("description", None)
    defs = {
      "email": dict(email, **D("An email address (not a secret: it is kept in the app's state).",
                               "An email address. Not a secret: it is kept in the app's state and said in the chat."), **{"x-hint": "one address like someone@example.com"}),
      "admin_entry": dict(admin, **D("A platform administrator: an email address, or *@domain for everyone at that domain (lower case).",
                                      "A platform administrator: `someone@example.com`, or `*@example.com` for everyone at that company (lower case). "
                                      "From `state/application/app_id/application.schema.json` `platform_admins`."), **{"x-hint": "an address or *@domain, lower case"}),
      "domain": dict(domain, **D("A host name people open, lower case, e.g. app.example.com.",
                                 "A host name people open, lower case: `app.example.com`. Its DNS record is one line the factory prints "
                                 "(`domain.py <app> attach <domain>`)."), **{"x-hint": "a lower-case host name like app.example.com"}),
      "audit": {
        "type": "object", "additionalProperties": False, "title": "Audit trails (mold_v0-197)",
        **D("Two audit trails, each on or off on its own (both default false). Separate from usage metering, which always stays on. "
            "mold_v0 writes it to the app's profile.audit (mold_v0-197, src/audit-trail.ts; entries kept 400 days unless profile.audit.retention_days says otherwise).",
            "Two audit trails, **each on or off on its own** (both default `false`).\n\n"
            "- `data`: every read, change, reveal and export of a workspace's records, visible to that workspace's admins.\n"
            "- `platform`: every API and MCP request and every sign-in, with the key, the actor and the scope, plus staff actions on accounts.\n\n"
            "Separate from **usage metering**, which always stays on. An `embedded` app needs `platform: true`.\n\n"
            "_mold_v0 writes it to the app's `profile.audit` (mold_v0-197, `src/audit-trail.ts`); entries are kept 400 days unless `profile.audit.retention_days` says otherwise._"),
        "properties": {
          "data": {"type": "boolean", "default": False, "title": "Data audit trail",
                   **D("Every read, change, reveal and export of a workspace's records, visible to that workspace's admins.",
                       "**Data audit trail**: every read, change, reveal and export of a workspace's records, shown to that workspace's admins. Default `false`.")},
          "platform": {"type": "boolean", "default": False, "title": "Platform audit trail",
                       **D("Every API/MCP request and sign-in, with key, actor and scope, plus staff actions on accounts. Required (true) for kind embedded.",
                           "**Platform audit trail**: every API and MCP request and every sign-in, with the key, the actor and the scope, plus "
                           "platform staff's actions on accounts. Default `false`; **must be `true` when `kind` is `embedded`**.")},
          "sign": {"type": "boolean", "default": False, "title": "Chain and sign",
                   **D("Signed checkpoints of the hash-chained trails (mold_v0-195): hourly Ed25519 signatures over Merkle roots, verifiable offline with the app's public key. Needs APP_LEDGER_SIGNING_KEY in the app's environment.",
                       "**Chain and sign** (mold_v0-195): every trail entry is hash-chained in the database; with `sign: true` a scheduled job also "
                       "signs checkpoints (an Ed25519 signature over the Merkle root of each window of entries, hourly when there are new ones), "
                       "verifiable by the workspace's owners and offline with the public key at `/.well-known/ledger-keys.json`. "
                       "Default `false`. The key, `APP_LEDGER_SIGNING_KEY`, is set in the app's environment by name (never in the database). "
                       "mold_v1: recorded with the spec only.")}}},
      "developer_surface": {
        "type": "object", "additionalProperties": False, "required": ["events", "sdk_languages", "client_sessions"],
        "title": "Developer surface (mold_v0-193)",
        **D("What a host application's developers build against when this app is embedded in it: the events it emits to webhooks, the SDK "
            "languages generated, the client sessions the host's backend mints, and optional inbound webhook receivers. mold_v0 builds it "
            "(the REST API at /v1, /openapi.json, keys, client sessions, webhooks out and in, the SDKs): mint new --spec writes it into the "
            "app's first inline pack as pack.json developer_surface. mold_v1: recorded with the spec only. Required when kind is embedded.",
            "What a **host application's developers** build against when this app is embedded in their product.\n\n"
            "- `events`: what the app sends to the host's webhooks (mold_v0: `record.created`, `record.updated`, `record.state_changed`, "
            "`record.deleted`, `run.finished`, `clock.overdue`; a record event may name `areas`).\n- `sdk_languages`: the SDKs generated (mold_v0: "
            "`typescript`, `python`).\n- `client_sessions`: short-lived sessions the host's own backend mints for its signed-in users.\n"
            "- `webhooks_in` (optional): receivers that write a signed payload into a workspace record area.\n- `api_version` (optional): the dated version.\n\n"
            "**mold_v0** implements it (mold_v0-193): `mint.py new --spec` writes it into the app's first inline pack. Required when `kind` is `embedded`."),
        "properties": {
          "events": {"type": "array", "minItems": 1, "maxItems": 100, "title": "Events the embedded app emits",
                     **D("Each event the embedded app emits to its host page and to the host's webhook: a dotted lower-case name and what it means.",
                         "Each event the embedded app emits (to the host page, and to the host's webhook): `name` like `record.created`, "
                         "`description` in one sentence, and optionally `payload`, a JSON Schema of its data."),
                     "items": {"type": "object", "additionalProperties": False, "required": ["name", "description"], "properties": {
                         "name": {"type": "string", "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,3}$", "x-hint": "dotted lower case, like record.created",
                                  **D("The event's name: dotted lower case, e.g. record.created, run.finished.")},
                         "description": {"type": "string", "minLength": 1, "maxLength": 300, **D("What the event means, in one sentence.")},
                         "payload": {"type": "object", **D("Optional: a JSON Schema of the event's data (draft 2020-12).")}}}},
          "sdk_languages": {"type": "array", "minItems": 1, "uniqueItems": True, "title": "SDK languages",
                            **D("The languages the app's client SDK ships in.", "The languages the client SDK ships in, e.g. `[\"typescript\", \"python\"]`."),
                            "items": {"type": "string", "enum": ["typescript", "python", "go", "java", "kotlin", "swift", "ruby", "csharp", "php"]}},
          "client_sessions": {"type": "object", "additionalProperties": False, "required": ["ttl_seconds", "allowed_origins"], "title": "Client sessions",
                              **D("Short-lived sessions the host application's backend mints for its own signed-in users, so they use the embedded app without "
                                  "a second sign-in.",
                                  "Short-lived sessions the **host's backend** mints for its own signed-in users (no second sign-in). "
                                  "`ttl_seconds`: how long one lasts; `allowed_origins`: the host pages (https) that may embed the app; `scopes`: what a session may do."),
                              "properties": {
                                  "ttl_seconds": {"type": "integer", "minimum": 60, "maximum": 86400, "default": 3600, **D("How long one session lasts, in seconds (60 to 86400).")},
                                  "allowed_origins": {"type": "array", "minItems": 1, "uniqueItems": True,
                                                      **D("The host pages allowed to embed the app: https origins like https://app.example.com."),
                                                      "items": {"type": "string", "pattern": "^https://[a-z0-9.-]+(:[0-9]{2,5})?$", "x-hint": "an https origin like https://app.example.com"}},
                                  "scopes": {"type": "array", "uniqueItems": True, "maxItems": 50,
                                             **D("What a client session may do: read, write, run or checks (ask the app's yes/no checks), each maybe narrowed "
                                                 "to one area, job kind or check (read:<area>, checks:<check>). Absent: read and write. A session never holds "
                                                 "more than the key that mints it."),
                                             "items": {"type": "string", "pattern": "^(read|write|run|checks)(:[a-z][a-z0-9_]{0,63})?$",
                                                       "x-hint": "read, write, run or checks, or one narrowed like read:<area> or checks:<check>"}}}},
          "webhooks_in": {"type": "array", "maxItems": 20, "title": "Inbound webhook receivers",
                          **D("Optional: receivers that write a verified (Standard Webhooks) payload into one of the app's workspace record areas.",
                              "Optional: each receiver writes a signed payload (or each item of a list in it) into a workspace record area: `name`, `area`, "
                              "`key` / `title` / `fields` as JSON Pointers (`/id`), `items` (a pointer to a list), `types` (payload types it takes)."),
                          "items": {"type": "object", "additionalProperties": False, "required": ["name", "area", "key", "fields"], "properties": {
                              "name": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$", **D("The receiver's name.")},
                              "description": {"type": "string", "maxLength": 300, **D("What it receives.")},
                              "area": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$", **D("The workspace record area it writes.")},
                              "items": {"type": "string", "pattern": "^(/([^~/]|~[01])*)*$", **D("A JSON Pointer to a list: each item is one record.")},
                              "key": {"type": "string", "pattern": "^(/([^~/]|~[01])*)*$", **D("A JSON Pointer to the record's key.")},
                              "title": {"type": "string", "pattern": "^(/([^~/]|~[01])*)*$", **D("A JSON Pointer to the record's title.")},
                              "fields": {"type": "object", "additionalProperties": {"type": "string", "pattern": "^(/([^~/]|~[01])*)*$"}, **D("Each field of the area, from a JSON Pointer.")},
                              "types": {"type": "array", "items": {"type": "string"}, **D("Only payloads whose type is one of these are written.")}}}},
          "api_version": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", **D("Optional: the dated API version new keys are pinned to (mold_v0: one of its API_VERSIONS).")}}},
    }
    product = {
      "type": "object", "additionalProperties": False, "required": ["name", "colour", "logo"], "title": "The product people see",
      **D("The brand: name, colour and logo are required (an app never ships under the mold's default name), tagline and domain optional.",
          "The brand people see. **name, colour and logo are required**: every new app is branded before its first deploy, never shipped under the "
          "mold's default name. `branding.py` derives the rest (palette, icon, sign-in mark) from these three."),
      "properties": {
        "name": {"type": "string", "pattern": "^[^.<>\"\\r\\n]{1,60}$", "x-hint": "1 to 60 characters, no full stop, < > or quotes",
                 **D("The product's name, as people see it (also its product id, lower-cased).", "The product's name, e.g. `Acme Desk`. A brief's `Product name:` line; "
                     "names the product in `state/products.json` (created when new).")},
        "colour": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$", "x-hint": "a #RRGGBB colour like #1F6F5C",
                   **D("The brand colour, #RRGGBB.", "The brand colour, `#RRGGBB` (e.g. `#1F6F5C`). The palette, icon and legible foreground are derived from it.")},
        "logo": {"type": "string", "pattern": "^(?!/)(?!.*\\.\\.)[A-Za-z0-9._/-]+\\.(png|svg|jpg|jpeg|webp)$", "x-hint": "a path in this repository like brands/acme/logo.svg",
                 **D("The logo file, a path from the factory's root (usually brands/<name>/logo.svg or .png). It must be on this machine.",
                     "The logo file, a path from the factory's root: `brands/<name>/logo.svg` (or .png). `factory.py spec check` says when it is not on this machine.")},
        "tagline": {"type": "string", "minLength": 1, "maxLength": 140, "pattern": "^[^<>\"\\r\\n]+$", **D("One line under the name (optional).")},
        "domain": {"$ref": "#/$defs/domain", **D("The app's own web address (optional; a server of its own needs one).",
                                                 "The app's own web address, e.g. `app.example.com`. Optional on Vercel; **required on a server of its own**.")},
      }}
    return defs, product

def NS(reason):
    """A setting this mold does not have: refused by editors too (`not: {}`), with the reason on hover and as the error."""
    return {"not": {}, "x-not-supported": reason, "description": f"Not supported: {reason}.", "markdownDescription": f"**Not supported**: {reason}.",
            "errorMessage": f"Not supported: {reason}."}

def _rule(text, cond, then):
    return {"x-rule": text, "if": cond, "then": then}

def _embedded_rules():
    emb = {"properties": {"kind": {"const": "embedded"}}, "required": ["kind"]}
    return [
      _rule("an embedded app is built into another product, so its developers need the developer surface and every request must be audited",
            emb, {"required": ["developer_surface", "audit"], "properties": {"audit": {"required": ["platform"], "properties": {"platform": {"const": True}}}}}),
      _rule("the developer surface is for kind embedded only", {"not": emb}, {"properties": {"developer_surface": NS("it is for an app of kind embedded only (set \"kind\": \"embedded\", or leave it out)")}}),
    ]

def _base(mold, root, title, desc_md):
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": URL.format(mold=mold), "title": title,
            **D(f"A complete description of one {mold} application, as one file. Check it with python3 .claude/scripts/factory.py spec check <file>; "
                f"mint it with python3 .claude/scripts/mint.py new <app_id> --spec <file>. Generated by {GEN}: never edit by hand.", desc_md),
            "x-generated": {"by": GEN, "edit": "never by hand: change the sources, then regenerate",
                            "sources": [p for p in sources(mold, root) if p != ".claude/scripts/app_spec.py"]},
            "type": "object", "additionalProperties": False}

def _head_props(mold):
    return {
      "$schema": {"type": "string", **D("The schema this file follows (VS Code reads it for hovers and completion).",
                                        f"The schema this file follows. Use `{URL.format(mold=mold)}`.")},
      "$comment": {"type": "string", **D("A note for people; ignored.")},
      "app_id": {"type": "string", "pattern": APP_ID, "x-hint": "3 to 41 lower-case letters, digits and underscores, starting with a letter",
                 **D("The application's id: lower-case letters, digits and underscores (its folder under state/application/).",
                     "The application's id, e.g. `acme_desk`: lower-case letters, digits and underscores. Its state lives in `state/application/<app_id>/`.")},
      "mold_id": {"const": mold, **D(f"The mold this app is made from: {mold}.", f"The mold this app is made from. This schema is **{mold}**'s.")},
      "kind": {"type": "string", "enum": ["tool", "embedded"], "default": "tool",
               **D("tool (default): people open the app itself. embedded: the app runs inside another product, which needs a developer surface and the platform audit trail.",
                   "- `tool` (default): people open the app itself.\n- `embedded`: the app runs **inside another product**; it then needs `developer_surface` "
                   "and `audit.platform: true`.")},
      "audit": {"$ref": "#/$defs/audit"},
    }

# ---- the capability flags (mold_v0-219) -------------------------------------------------------------------------------
def _features_schema(root):
    """The spec's top-level `features`: one boolean per flag of the mold's registry (codebase/src/features.json), with its docs."""
    sys.path.insert(0, os.path.join(HERE, "lib")); import features as F
    props = {}
    for f in F.registry(root):
        legacy = f" Legacy key: profile.{f['legacy']} (still read; it and this flag must agree)." if f.get("legacy") else ""
        needs = (f" Needs {' and '.join(f['requires'])} on." if f.get("requires") else "") + (f" Needs one of {', '.join(f['requires_any'])} on." if f.get("requires_any") else "")
        props[f["id"]] = {"type": "boolean", "default": f["default"], "title": f"{f['label']} ({f['since']})",
                          **D(f"{f['about']} Asked for when {f['requested_words']}. Default {str(f['default']).lower()}. Off: {f['off']}{needs}{legacy}",
                              f"**{f['label']}** ({f['since']}; board name `{f['short']}`). {f['about']}\n\n"
                              f"- **Asked for** when {f['requested_words']}.\n- **Default** `{str(f['default']).lower()}`.\n- **Off**: {f['off']}\n"
                              + (f"- **Needs** {needs.strip()}\n" if needs else "") + (f"- {legacy.strip()}\n" if legacy else "")
                              + f"\nBrief line: `features.{f['id']} = {str(not f['default']).lower()}` in `## Profile`.")}
    return {"type": "object", "additionalProperties": False, "minProperties": 1, "title": "Capability flags (mold_v0-219)",
            **D("One on/off flag per optional capability of mold_v0 (codebase/src/features.json). A capability is on when something asks for it "
                "(a pack's declaration; the audit toggles always) and its flag is not false. Written to profile.features; brief lines features.<flag> = true|false.",
                "One **on/off flag per optional capability** (`molds/mold_v0/codebase/src/features.json`). A capability is **on** when something asks for it "
                "(a pack's declaration; the audit toggles always) **and** its flag is not `false`. Leave a flag out for its default.\n\n"
                "Written to the app's `profile.features`; in a brief, `features.<flag> = true|false` lines in `## Profile`. "
                "`factory.py spec check` says the effective flags."),
            "properties": props}

def _features_rules():
    on = lambda i: {"properties": {"features": {"properties": {i: {"const": True}}, "required": [i]}}, "required": ["features"]}
    off = lambda i: {"properties": {"features": {"properties": {i: {"const": False}}, "required": [i]}}, "required": ["features"]}
    return [
      _rule("chain and sign signs the audit trails, so one of them must be on", on("audit.sign"),
            {"anyOf": [on("audit.data"), on("audit.platform"), {"properties": {"audit": {"anyOf": [{"properties": {"data": {"const": True}}, "required": ["data"]},
                                                                                          {"properties": {"platform": {"const": True}}, "required": ["platform"]}]}}, "required": ["audit"]}]}),
      _rule("kind is the developer surface's switch: the flag may not turn it on for a tool", on("developer_surface"),
            {"properties": {"kind": {"const": "embedded"}}, "required": ["kind"]}),
      _rule("kind embedded is a developer surface: the flag may not turn it off", {"allOf": [off("developer_surface"), {"properties": {"kind": {"const": "embedded"}}, "required": ["kind"]}]},
            {"not": {}}),
    ]

# ---- mold_v0 ---------------------------------------------------------------------------------------------------------
def _embed_pack(schema):
    s = copy.deepcopy(schema); defs = s.pop("$defs", {})
    for k in ("$id", "$schema"): s.pop(k, None)
    def fix(o):
        if isinstance(o, dict):
            if isinstance(o.get("$ref"), str):
                r = o["$ref"]
                o["$ref"] = "#/$defs/pack" if r == "#" else r.replace("#/$defs/", "#/$defs/pack__", 1)
            for v in o.values(): fix(v)
        elif isinstance(o, list):
            for v in o: fix(v)
    fix(s); fix(defs)
    s.setdefault("markdownDescription", s.get("description", ""))
    return s, {f"pack__{k}": v for k, v in defs.items()}

def _limits_schema(keys, maxes):
    def section(sec, names, top):
        props = {}
        for n in names:
            p = {"type": "number" if "usd" in n else "integer", "exclusiveMinimum": 0}
            mx = maxes.get(f"{sec}.{n}")
            if mx is not None: p["maximum"] = mx
            what = "US$" if "usd" in n else "a whole number"
            p.update(D(f"limits.{sec}.{n} ({what}" + (f", at most {mx:g}: the factory's ceiling, molds/mold_v0/branding/rules.json" if mx is not None else "") + ")."))
            props[n] = p
        return {"type": "object", "additionalProperties": False, "minProperties": 1, "properties": props,
                **D(f"The {sec} limits (the shell's scripts/gen-packs.mjs LIMIT_KEYS).")}
    props = {sec: section(sec, names, True) for sec, names in keys.items()}
    props["plans"] = {"type": "object", **D("A plan's own limits, by plan name: the same sections as above."),
                      "propertyNames": {"pattern": "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$"},
                      "additionalProperties": {"type": "object", "additionalProperties": False,
                                               "properties": {sec: section(sec, names, False) for sec, names in keys.items()}}}
    return props

def schema_v0(root):
    import app_profile
    M = load(os.path.join(root, "molds", "mold_v0", "mold.json"))
    R = load(os.path.join(root, "molds", "mold_v0", "branding", "rules.json"))["profile"]
    cb = os.path.join(root, "molds", "mold_v0", "codebase")
    P = load(os.path.join(cb, "packs", "pack.schema.json"))
    keys = app_profile.limit_keys(cb) or {}
    groups = app_profile.email_groups(cb) or []
    maxes = {k: v for k, v in (R.get("app_limits_max") or {}).items() if not k.startswith("$")}
    defs, product = _common("mold_v0", root)
    pack, pdefs = _embed_pack(P)
    defs["pack"] = pack; defs.update(pdefs)
    pid = M["packs"]["pack_id"]; nn = M.get("not_needed") or {}
    defs["pack_ref"] = {
      "title": "One pack", **D("A pack the app adds to the mold: its id (packs/<id>/ on this machine), {\"id\", \"path\"} to a pack.json file, or {\"id\", \"pack\"} with the pack.json inline.",
         "A pack (the app's own records, jobs, tabs, words: config only, no fork). Three forms:\n\n"
         "- `\"acme\"`: the pack already on this machine, `packs/acme/files/packs/acme/pack.json`.\n"
         "- `{\"id\": \"acme\", \"path\": \"specs/acme.pack.json\"}`: a pack.json file.\n"
         "- `{\"id\": \"acme\", \"pack\": { ... }}`: the pack.json **inline**, checked against the mold's own `packs/pack.schema.json` (embedded here)."),
      "oneOf": [
        {"type": "string", "pattern": pid, "x-hint": "a mold_v0 pack id: lower-case letters, digits and underscores"},
        {"type": "object", "additionalProperties": False, "required": ["id", "path"], "properties": {
            "id": {"type": "string", "pattern": pid, **D("The pack's id (also its table prefix).")},
            "path": {"type": "string", "pattern": "^(?!/)(?!.*\\.\\.)[A-Za-z0-9._/-]+\\.json$", **D("A pack.json file, as a path from the factory's root.")}}},
        {"type": "object", "additionalProperties": False, "required": ["id", "pack"], "properties": {
            "id": {"type": "string", "pattern": pid, **D("The pack's id: the same as pack.id.")},
            "pack": {"$ref": "#/$defs/pack", "allOf": [{"properties": {"job_kinds": {"items": _rule(
                "an agent job kind runs an agent fetched from its own repository at a pinned commit",
                {"properties": {"runner": {"const": "agent-workspace"}}, "required": ["runner"]},
                {"required": ["agent"], "properties": {"agent": {"required": ["repository", "commit"]}}})}}}]}}}]}
    profile_props = {}
    settable = [k for k in R["app_settable"] if k != "limits"]
    for k in settable:
        top = k.split(".")[0]
        if k == "email":
            profile_props[k] = {"type": "object", "additionalProperties": False, "minProperties": 1, **D("Which emails go out, and how (src/email.ts)."), "properties": {
                "notifications": {"type": "array", "uniqueItems": True, "items": {"type": "string", "enum": groups},
                                  **D("The notification groups that are on: " + ", ".join(groups) + ".")},
                "provider": {"type": "string", "enum": list(app_profile.PROVIDERS), **D("resend sends; none sends nothing.")},
                "pitch": {"type": "string", "maxLength": 400, "pattern": "^[^\\u0000-\\u001f\\u007f<>]+$", **D("The welcome email's sentence (one line, up to 400 characters).")}}}
        elif k == "email_from_address":
            profile_props[k] = {"$ref": "#/$defs/email", **D("The emails' sender address, on a domain you verified for sending. Absent: <app_id>@<this machine's notify domain>.")}
        elif k == "member_keys":
            profile_props[k] = {"type": "boolean", **D("false: no per-member API keys; AI clients connect by signing in.")}
        elif k == "onprem_runners":
            profile_props[k] = {"type": "boolean", "default": False, "title": "On-premises runners (mold_v0-205)",
                                **D("true: the app's workspaces may install an on-premises runner inside their own network for the kinds that need it "
                                    "(a pack's job kind with private_network: true); false (the default): no runner routes, pages, tabs or enrolment, and every run is hosted.",
                                    "**On-premises runners**, off unless `true` (mold_v0-205, the shell's `src/onprem-runners.ts`).\n\n"
                                    "- `true`: a workspace's owners add a runner on **Credentials** and install it inside their network; the runs of a kind "
                                    "with `private_network: true` then go to it when the workspace chooses so.\n"
                                    "- `false` or absent: `/api/runners` and `/api/runner` answer not found, no console page, admin tab or guide page for runners "
                                    "appears, enrolment is refused and every run is hosted.\n\nBrief line: `onprem_runners = true` in `## Profile`.")}
        elif k == "source_offer.upstreams":
            profile_props["source_offer"] = {"type": "object", "additionalProperties": False, "required": ["upstreams"], **D("Only its upstreams part is the app's."), "properties": {
                "upstreams": {"type": "object", "minProperties": 1, "propertyNames": {"pattern": pid}, "additionalProperties": {"const": "licensor_owned"},
                              **D("{\"<pack id>\": \"licensor_owned\"} for each of the app's packs whose upstream is the licensor's own project (the build then does not offer its source).")}}}
        elif k == "legal":
            profile_props[k] = {"type": "object", "additionalProperties": False, "required": list(app_profile.LEGAL_REQUIRED),
                                **D("The company behind the app's /terms and /privacy pages. Absent: no legal pages."), "properties": {
                "company_name": {"type": "string", "minLength": 1, "maxLength": 200, **D("The company's legal name.")},
                "contact_email": {"$ref": "#/$defs/email", **D("Where people write about terms and privacy.")},
                "effective_date": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "x-hint": "a date like 2026-11-01", **D("YYYY-MM-DD.")},
                "jurisdiction": {"type": "string", "minLength": 1, "maxLength": 200, **D("Optional: the governing law.")},
                "terms_url": {"type": "string", "pattern": "^https://", **D("Optional: your own Terms page instead (https://).")},
                "privacy_url": {"type": "string", "pattern": "^https://", **D("Optional: your own Privacy page instead (https://).")}}}
        elif k == "mcp_instructions":
            profile_props[k] = {"type": "string", "minLength": 1, "maxLength": app_profile.MAX_INSTRUCTIONS,
                                **D("What the MCP server tells an AI client about the app: plain text, up to 4000 characters.")}
        elif k == "landing":
            profile_props[k] = {"type": "object", **D("The landing page at / (the shell's src/landing.ts sections): plain text, true/false, numbers and lists. The build checks its sections.")}
        else:
            profile_props[top] = {**D(f"{k}: a profile field this mold lets an app set (molds/mold_v0/branding/rules.json); the factory checks it.")}
    profile_props["limits"] = NS("say limits in the spec's top-level `budgets` block, which is written to profile.limits")
    profile_props["audit"] = NS("say the audit trails in the spec's top-level `audit` block, which is written to profile.audit (mold_v0-197)")
    profile_props["features"] = NS("say the capability flags in the spec's top-level `features` block, which is written to profile.features (mold_v0-219)")
    defs["features"] = _features_schema(root)
    run_keys = {
      "type": "object", "additionalProperties": False, "title": "Keys the runs need (names, never values)",
      **D("Where the keys the pack's job runs need will come from. Names only: the values go into the app's Key vault (its /admin Key vault page) or the server's environment, never here.",
          "Where the keys the packs' **job runs** need come from. **Never a value here**: the operator puts each key in the app's **Key vault** (`/admin` → Key vault), "
          "or in the server's environment.\n\n- `model`: `anthropic` (an Anthropic API key) or `vertex` (a Vertex AI service-account key: Claude then runs on Vertex AI).\n"
          "- `sandbox`: `boat` (boat.dev runs the sandboxes on Vercel).\n- `object_storage`: where workspace snapshots go: `vault` (the Key vault's Object storage), "
          "`r2_env` (R2_* on the server) or `storage_dir` (APP_STORAGE_DIR, a server of its own).\n\n"
          "Whether each is set: `provision.py <app> --operator vault-status --dry-run`."),
      "properties": {
        "model": {"type": "string", "enum": ["anthropic", "vertex"], **D("anthropic: an Anthropic API key in the Key vault. vertex: a Vertex AI service-account key; Claude then runs on Vertex AI.")},
        "sandbox": {"type": "string", "enum": ["boat"], **D("boat: the boat.dev key for the runs' sandboxes (needed on Vercel when a pack has job kinds).")},
        "object_storage": {"type": "string", "enum": ["vault", "r2_env", "storage_dir"],
                           **D("Where workspace snapshots of agent runs go: vault (the Key vault's Object storage), r2_env (R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY on the server), storage_dir (APP_STORAGE_DIR on a server of its own).")}}}
    s = _base("mold_v0", root, "mold_v0 application spec",
              "A complete description of one **mold_v0** application (an MCP product: workspaces, keys, an MCP connector, an admin console, and the packs' records and runs).\n\n"
              "- Check: `python3 .claude/scripts/factory.py spec check <file>`\n- Mint: `python3 .claude/scripts/mint.py new <app_id> --spec <file>`\n\n"
              f"_Generated by `{GEN}`; never edit by hand._")
    has_kinds = {"properties": {"pack": {"required": ["job_kinds"], "properties": {"job_kinds": {"minItems": 1}}}}, "required": ["pack"]}
    agent_kind = {"properties": {"pack": {"required": ["job_kinds"], "properties": {"job_kinds": {"contains": {"properties": {"runner": {"const": "agent-workspace"}}, "required": ["runner"]}}}}}, "required": ["pack"]}
    ws_kind = {"properties": {"pack": {"required": ["job_kinds"], "properties": {"job_kinds": {"contains": {"properties": {"workspace": {"const": True}}, "required": ["workspace"]}}}}}, "required": ["pack"]}
    pk = lambda c: {"properties": {"packs": {"contains": c}}, "required": ["packs"]}
    s.update({
      "required": ["app_id", "mold_id", "product", "deploy", "workspace", "packs"],
      "properties": {
        **_head_props("mold_v0"),
        "product": product,
        "deploy": {"type": "object", "additionalProperties": False, "required": ["target"], "title": "Where it runs",
                   **D("Where the app runs: " + ", ".join(M["targets"]) + " (molds/mold_v0/mold.json targets).",
                       "Where the app runs (`molds/mold_v0/mold.json` `targets`):\n\n- `vercel`: two Vercel projects, the API and the web console.\n"
                       "- `compose_remote`: a server of its own (Docker Compose behind its own Caddy); needs `product.domain`."),
                   "properties": {"target": {"type": "string", "enum": M["targets"], **D("vercel or compose_remote.")}}},
        "workspace": {"type": "object", "additionalProperties": False, "required": ["platform_admins"], "title": "Who runs it",
                      **D("Who runs the app. mold_v0 needs at least one platform administrator; its companies are made in its own admin console.",
                          "Who runs the app. **`platform_admins` is required**: without one, everyone (the operator too) is told the app is invite-only.\n\n"
                          f"`name`, `owner`, `members` are not supported on mold_v0: {nn.get('workspaces', '')}."),
                      "properties": {
                        "platform_admins": {"type": "array", "minItems": 1, "uniqueItems": True, "items": {"$ref": "#/$defs/admin_entry"},
                                            **D("Who may open the admin console: addresses, or *@domain. A brief's Admins: line.")},
                        **{k: NS(nn.get("workspaces", "mold_v0 makes no workspace from state")) for k in ("name", "owner", "members")}}},
        "budgets": {"type": "object", "additionalProperties": False, "minProperties": 1, "title": "Spending and rate limits",
                    **D("The app's limits over the shell's defaults (written to profile.limits): runs.budget_usd_max is the most one run may spend (US$), "
                        "runs.kind_month_budget_usd the most one job kind may spend per company per month. Each is capped by the factory's ceiling.",
                        "The app's limits over the shell's defaults, written to `profile.limits` (a brief's `## Budgets`).\n\n"
                        "- `runs.budget_usd_max`: the most **one run** may spend, US$ (shell default 25).\n"
                        "- `runs.kind_month_budget_usd`: the most **one job kind per company per month**, US$ (default 200).\n\n"
                        "Each is capped by the factory's ceiling (`molds/mold_v0/branding/rules.json` `app_limits_max`). "
                        "**Required when a pack has job kinds**, and must cover each kind's own `budget_usd` / `month_budget_usd`."),
                    "properties": _limits_schema(keys, maxes)},
        "profile": {"type": "object", "additionalProperties": False, "minProperties": 1, "title": "Profile settings",
                    **D("The app's own profile settings over the mold's defaults: " + ", ".join(settable) + " (molds/mold_v0/branding/rules.json app_settable). Limits go in budgets.",
                        "The app's own settings over the mold's defaults (`molds/mold_v0/branding/rules.json` `app_settable`): " + ", ".join(f"`{x}`" for x in settable)
                        + ". Limits go in `budgets`. Never a brand word, billing, entitlements or a secret."),
                    "properties": profile_props},
        "packs": {"type": "array", "uniqueItems": True, "items": {"$ref": "#/$defs/pack_ref"}, "title": "The app's packs",
                  **D("The app's packs: what makes it more than the mold (records, jobs, tabs, words), config only. [] for the mold as it comes.",
                      "The app's packs (config only, never a fork): ids, paths, or a pack.json inline. `[]`: the mold as it comes.")},
        "run_keys": run_keys,
        "developer_surface": {"$ref": "#/$defs/developer_surface"},
        "features": {"$ref": "#/$defs/features"},
      },
      "allOf": _embedded_rules() + _features_rules() + [
        _rule("a pack has job kinds, so the app needs its run budgets and the keys its runs use", pk(has_kinds),
              {"required": ["budgets", "run_keys"], "properties": {"budgets": {"required": ["runs"], "properties": {"runs": {"required": ["budget_usd_max", "kind_month_budget_usd"]}}}}}),
        _rule("a pack has agent job kinds, which call a model and keep a workspace between runs", pk(agent_kind),
              {"required": ["run_keys"], "properties": {"run_keys": {"required": ["model", "object_storage"]}}}),
        _rule("a pack has job kinds that keep a workspace between runs", pk(ws_kind),
              {"required": ["run_keys"], "properties": {"run_keys": {"required": ["object_storage"]}}}),
        _rule("job runs on Vercel run in boat.dev sandboxes",
              {"allOf": [pk(has_kinds), {"properties": {"deploy": {"properties": {"target": {"const": "vercel"}}, "required": ["target"]}}, "required": ["deploy"]}]},
              {"required": ["run_keys"], "properties": {"run_keys": {"required": ["sandbox"]}}}),
        _rule("an app on a server of its own is reached at its own domain",
              {"properties": {"deploy": {"properties": {"target": {"const": "compose_remote"}}, "required": ["target"]}}, "required": ["deploy"]},
              {"properties": {"product": {"required": ["domain"]}}}),
      ],
      "$defs": defs})
    return s

# ---- mold_v1 ---------------------------------------------------------------------------------------------------------
def schema_v1(root):
    A = load(os.path.join(root, "state", "application", "app_id", "application.schema.json"))
    I = load(os.path.join(root, "state", "application", "app_id", "infrastructure.schema.json"))
    R = load(os.path.join(root, "molds", "mold_v1", "branding", "rules.json"))
    provs = _intake_providers(root); pid = _packs_py_pack_id(root)
    defs, product = _common("mold_v1", root)
    targets = [t for t in I["properties"]["target"]["enum"] if t != "compose_remote"]
    caps = copy.deepcopy(A["properties"]["capabilities"]); caps["additionalProperties"] = False
    caps.update(D("Build and run toggles: web search, the browser subagent, several workspaces (application.schema.json capabilities).",
                  "Toggles the mold recognises (from `application.schema.json` `capabilities`): `web_search`, `browser`, `multi_tenant` (false: one workspace). All default true."))
    asr = A["properties"]["asr"]["properties"]["model"]
    s = _base("mold_v1", root, "mold_v1 application spec",
              "A complete description of one **mold_v1** application (a chat workspace with specialist subagents and a data room).\n\n"
              "- Check: `python3 .claude/scripts/factory.py spec check <file>`\n- Mint: `python3 .claude/scripts/mint.py new <app_id> --spec <file>`\n\n"
              f"_Generated by `{GEN}`; never edit by hand._")
    ns = "mold_v1 takes no profile settings from an app (molds/mold_v1/branding/rules.json names none)"
    s.update({
      "required": ["app_id", "mold_id", "product", "deploy", "workspace", "packs"],
      "properties": {
        **_head_props("mold_v1"),
        "product": product,
        "deploy": {"type": "object", "additionalProperties": False, "required": ["target"], "title": "Where it runs",
                   **D("Where the app runs: vercel, vm (a database check on this machine only) or vm_remote (a server of its own; needs server and product.domain).",
                       "- `vercel`: the factory's Vercel team.\n- `vm`: verifies a database on this machine only (serves nothing).\n"
                       "- `vm_remote`: a server of its own over SSH; needs `server` and `product.domain`."),
                   "properties": {"target": {"type": "string", "enum": targets, **D("vercel, vm or vm_remote.")},
                                  "server": {"type": "string", "pattern": "^[0-9a-z][0-9a-z.-]*[0-9a-z]$", **D("vm_remote only: the server's address (IP or host name).")}}},
        "workspace": {"type": "object", "additionalProperties": False, "required": ["name", "owner"], "title": "The app's first workspace",
                      **D("The app's own first workspace, written right after the first deploy: its name, its owner and the people in it.",
                          "The app's **first workspace**, written right after the first deploy (mint's workspaces station): `name`, `owner` (who signs in first), "
                          "`members`, and optionally `platform_admins`."),
                      "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 80, "pattern": "^[^.\"\\r\\n]+$", **D("The workspace's display name (a brief's Workspace: line).")},
                        "owner": {"$ref": "#/$defs/email", **D("The workspace owner's email (a brief's Owner: line).")},
                        "members": {"type": "array", "uniqueItems": True, "items": {"$ref": "#/$defs/email"}, **D("Other people in the workspace (a brief's Members: line).")},
                        "platform_admins": {"type": "array", "uniqueItems": True, "items": {"$ref": "#/$defs/admin_entry"}, **D("Optional: who may create workspaces.")}}},
        "capabilities": caps,
        "inference": {"type": "object", "additionalProperties": False, "required": ["provider"], **D("Which provider serves the agent: " + ", ".join(sorted(provs)) + "."),
                      "properties": {"provider": {"type": "string", "enum": sorted(provs),
                                                  **D("; ".join(f"{p}: needs {', '.join(n)}" for p, n in sorted(provs.items())) + " (names; the operator sets the values with provision.py --set-secret).")}}},
        "library": {"type": "string", "enum": ["none", "all"], "default": "none", **D("all: new workspaces get the starter library of workflows and recipes; none (default): they do not.")},
        "dictation": {"type": "object", "additionalProperties": False, **D("The microphone button's speech-to-text model."),
                      "properties": {"model": asr, "enabled": {"type": "boolean", **D("false: no microphone button.")}}},
        "packs": {"type": "array", "uniqueItems": True, "title": "The app's packs",
                  **D("The app's packs (packs/<id>/ on this machine: subagents, an instructions section, shared helpers). [] for the mold as it comes."),
                  "items": {"oneOf": [{"type": "string", "pattern": pid, "x-hint": "a mold_v1 pack id: lower-case letters, digits and hyphens"},
                                      {"type": "object", "additionalProperties": False, "required": ["id", "path"], "properties": {
                                          "id": {"type": "string", "pattern": pid}, "path": {"type": "string", "pattern": "^(?!/)(?!.*\\.\\.)[A-Za-z0-9._/-]+$",
                                                                                           **D("The pack's directory (with its pack.json), from the factory's root.")}}}]}},
        "budgets": NS(ns), "profile": NS(ns),
        "run_keys": NS("mold_v1 has no job runs: its keys are the inference provider's (inference.provider)"),
        "developer_surface": {"$ref": "#/$defs/developer_surface"},
      },
      "allOf": _embedded_rules() + [
        _rule("an app on a server of its own is reached at its own domain, on a server the factory can reach",
              {"properties": {"deploy": {"properties": {"target": {"const": "vm_remote"}}, "required": ["target"]}}, "required": ["deploy"]},
              {"properties": {"product": {"required": ["domain"]}, "deploy": {"required": ["server"]}}}),
        _rule("deploy.server is for target vm_remote only",
              {"properties": {"deploy": {"properties": {"target": {"enum": [t for t in targets if t != "vm_remote"]}}, "required": ["target"]}}, "required": ["deploy"]},
              {"properties": {"deploy": {"properties": {"server": NS("only an app on a server of its own (vm_remote) names a server")}}}}),
      ],
      "$defs": defs})
    _ = R  # read for the source hash: product_name_default is refused by branding.py's own check at mint time
    return s

BUILD = {"mold_v0": schema_v0, "mold_v1": schema_v1}

def generated(root=ROOT):
    return {m: dumps(BUILD[m](root)) for m in MOLDS}

def schema_path(mold, root=ROOT): return os.path.join(root, SCHEMA_DIR, f"{mold}.app.schema.json")

def stale(root=ROOT):
    """Sentences, one per schema that is not what generation gives now ([] when all are current)."""
    out = []
    for m in MOLDS:
        try: want = dumps(BUILD[m](root))
        except (OSError, KeyError, ValueError, SystemExit) as e:
            out.append(f"schemas/{m}.app.schema.json could not be generated ({e}): python3 {GEN}"); continue
        p = schema_path(m, root)
        have = open(p, encoding="utf-8").read() if os.path.exists(p) else None
        if have != want:
            out.append(f"schemas/{m}.app.schema.json is {'missing' if have is None else 'stale (a mold or a factory schema changed)'}: python3 {GEN}")
    return out

def cmd_generate(a, root=ROOT):
    if "--check" in a:
        s = stale(root)
        for x in s: print(x)
        print("app-spec schemas current" if not s else f"{len(s)} stale"); return 1 if s else 0
    os.makedirs(os.path.join(root, SCHEMA_DIR), exist_ok=True)
    for m, text in generated(root).items():
        p = schema_path(m, root); old = open(p, encoding="utf-8").read() if os.path.exists(p) else None
        if old != text:
            with open(p, "w", encoding="utf-8") as fh: fh.write(text)
        print(f"{rel(p, root)}: {'unchanged' if old == text else 'written'} ({len(text) // 1024} KB)")
    return 0

# ---- checking a spec -------------------------------------------------------------------------------------------------
def _pack_file(pid, root):
    return os.path.join(root, "packs", pid, "files", "packs", pid, "pack.json")

def resolve_packs(spec, root):
    """A copy of the spec with every mold_v0 pack given by id or path loaded inline ({"id", "pack"}), plus problems and,
    per index, where each came from."""
    spec = copy.deepcopy(spec); probs, origin = [], {}
    if spec.get("mold_id") != "mold_v0" or not isinstance(spec.get("packs"), list): return spec, probs, origin
    for i, p in enumerate(spec["packs"]):
        pid, path = (p, None) if isinstance(p, str) else ((p.get("id"), p.get("path")) if isinstance(p, dict) and "pack" not in p else (None, None))
        if pid is None and path is None: continue
        f = os.path.join(root, path) if path else _pack_file(pid, root)
        if not os.path.isfile(f):
            probs.append(("missing", f"packs[{i}]", f"packs[{i}]: pack {pid!r} is not on this machine (looked for {rel(f, root)})")); continue
        try: doc = load(f)
        except ValueError as e:
            probs.append(("wrong value", f"packs[{i}]", f"packs[{i}]: {rel(f, root)} is not valid JSON ({e})")); continue
        spec["packs"][i] = {"id": pid, "pack": doc}; origin[i] = rel(f, root)
    return spec, probs, origin

def problems(spec, root=ROOT, schema=None):
    """[(kind, path, sentence)]: everything that keeps the spec from being complete for its mold."""
    mold = spec.get("mold_id")
    schema = schema or load(schema_path(mold, root))
    full, out, origin = resolve_packs(spec, root)
    out += spec_schema.check(schema, full)
    # what the schema cannot say: files on this machine, sums across the pack and the budgets, the factory's profile check
    logo = (spec.get("product") or {}).get("logo")
    if isinstance(logo, str) and not os.path.isfile(os.path.join(root, logo)):
        out.append(("missing", "product.logo", f"product.logo: the file {logo} is not on this machine (put the logo there, or name the file that is)"))
    packs = [p for p in full.get("packs") or [] if isinstance(p, dict) and isinstance(p.get("pack"), dict)]
    ids = [p if isinstance(p, str) else (p or {}).get("id") for p in spec.get("packs") or []] if isinstance(spec.get("packs"), list) else []
    if mold == "mold_v0":
        sys.path.insert(0, os.path.join(HERE, "lib"))
        import brief_pack, app_profile
        runs = ((spec.get("budgets") or {}).get("runs") or {}) if isinstance(spec.get("budgets"), dict) else {}
        per_run, per_month = runs.get("budget_usd_max", 25), runs.get("kind_month_budget_usd", 200)
        for i, p in enumerate(full.get("packs") or []):
            if not (isinstance(p, dict) and isinstance(p.get("pack"), dict)): continue
            doc = p["pack"]
            if p.get("id") and doc.get("id") and p["id"] != doc["id"]:
                out.append(("wrong value", f"packs[{i}].id", f"packs[{i}].id is {p['id']!r} but its pack.json says id {doc['id']!r}: they must be the same"))
            # the build's cross-checks as intake drafts packs (lib/brief_pack.py): for a pack written inline in the spec. A pack
            # already on disk was checked by packs.py check and the shell's own gen-packs, which know every form it may use.
            for e in (brief_pack.cross_errors(doc) if i not in origin else []): out.append(("wrong value", f"packs[{i}]", f"packs[{i}] ({p.get('id')}): {e}"))
            for k in doc.get("job_kinds") or []:
                if not isinstance(k, dict): continue
                b, mb = k.get("budget_usd", 5), k.get("month_budget_usd")
                if isinstance(b, (int, float)) and isinstance(per_run, (int, float)) and b > per_run:
                    out.append(("missing", "budgets.runs.budget_usd_max", f"budgets.runs.budget_usd_max is {per_run:g} but job kind {p.get('id')}.{k.get('name')} may spend US${b:g} a run: raise the budget to at least {b:g}"))
                if isinstance(mb, (int, float)) and isinstance(per_month, (int, float)) and mb > per_month:
                    out.append(("missing", "budgets.runs.kind_month_budget_usd", f"budgets.runs.kind_month_budget_usd is {per_month:g} but job kind {p.get('id')}.{k.get('name')} may spend US${mb:g} a month: raise it to at least {mb:g}"))
        out += _developer_problems(spec, full, root)
        out += [("wrong value", "features", e) for e in _features_problems(spec, full, root)]
        prof = {k: v for k, v in (spec.get("profile") or {}).items() if k != "limits"} if isinstance(spec.get("profile"), dict) else {}
        if prof and not any(x[1].startswith("profile") for x in out):   # the factory's own profile check (lib/app_profile.py), the one validate and the build run; budgets are the schema's
            for e in app_profile.problems(prof, mold, root, packs=[x for x in ids if isinstance(x, str)]):
                out.append(("wrong value", e.split(" ")[0].rstrip(":"), e))
    elif mold == "mold_v1":
        for i, p in enumerate(spec.get("packs") or []):
            pid = p if isinstance(p, str) else (p or {}).get("id") if isinstance(p, dict) else None
            d = os.path.join(root, p["path"]) if isinstance(p, dict) and p.get("path") else os.path.join(root, "packs", str(pid))
            if pid and not os.path.isfile(os.path.join(d, "pack.json")):
                out.append(("missing", f"packs[{i}]", f"packs[{i}]: pack {pid!r} is not on this machine (looked for {rel(os.path.join(d, 'pack.json'), root)})"))
    # one line per missing thing: the reasons it is needed joined
    seen, uniq, at = set(), [], {}
    for e in out:
        if e[2] in seen: continue
        seen.add(e[2])
        m = re.fullmatch(r"(.+?) is missing(?:: [^(]*)? \(because (.+)\)", e[2])
        if e[0] == "missing" and m and (e[0], e[1]) in at:
            i = at[(e[0], e[1])]; k, p, msg = uniq[i]
            uniq[i] = (k, p, msg[:-1] + "; and because " + m.group(2) + ")"); continue
        if e[0] == "missing" and m: at[(e[0], e[1])] = len(uniq)
        uniq.append(e)
    return uniq

def _spec_profile(spec):
    """The profile the spec writes (its top-level audit and features folded in, as the brief path does)."""
    prof = dict(spec.get("profile") or {}) if isinstance(spec.get("profile"), dict) else {}
    if isinstance(spec.get("audit"), dict): prof["audit"] = {k: v for k, v in spec["audit"].items() if isinstance(v, bool)}
    if isinstance(spec.get("features"), dict): prof["features"] = dict(spec["features"])
    return prof

def _pack_docs(full):
    return [p["pack"] for p in full.get("packs") or [] if isinstance(p, dict) and isinstance(p.get("pack"), dict)]

def effective_features(spec, root=ROOT):
    """mold_v0: every capability flag's state for the spec (lib/features.py effective), else []."""
    if spec.get("mold_id") != "mold_v0": return []
    sys.path.insert(0, os.path.join(HERE, "lib")); import features as F
    full, _, _ = resolve_packs(spec, root)
    # the flags are the factory's mold's (ROOT); the packs are where the spec's app lives (root: --from)
    return F.effective(_spec_profile(spec), _pack_docs(full), ROOT if F.registry(ROOT) else root, kind=spec.get("kind", "tool"))

def _features_problems(spec, full, root):
    sys.path.insert(0, os.path.join(HERE, "lib")); import features as F
    if isinstance(spec.get("features"), dict) and F.block_problems(spec["features"], root): return []   # the schema said it
    errs = F.problems(_spec_profile(spec), _pack_docs(full), root, kind=spec.get("kind", "tool"), at="features")
    # what the schema rules already say, said once
    return [e for e in errs if "kind is the switch" not in e and "needs one of" not in e and not (spec.get("kind") == "embedded" and "needs audit.platform" in e)]

def _read_spec(path):
    if not os.path.isfile(path): return None, f"There is no file at {path}."
    try: spec = load(path)
    except ValueError as e: return None, f"{path} is not valid JSON ({e}). Fix that line first."
    if not isinstance(spec, dict): return None, f"{path} must hold one JSON object (the app spec)."
    m = spec.get("mold_id")
    if m not in MOLDS: return None, f"{path}: mold_id is {json.dumps(m)}; a spec names one of the molds that have a spec schema: {', '.join(MOLDS)}."
    return spec, None

def cmd_check(a, root=ROOT):
    as_json = "--json" in a; a = [x for x in a if x != "--json"]
    if not a: print(__doc__, file=sys.stderr); return 2
    import agent_result as AR
    spec, err = _read_spec(os.path.abspath(a[0]))
    if err:
        if as_json: AR.emit(AR.result(False, "failed", err, "", [], "", {})); return 2
        print(err, file=sys.stderr); return 2
    sp = schema_path(spec["mold_id"], root)
    if not os.path.isfile(sp):
        msg = f"schemas/{spec['mold_id']}.app.schema.json is not there: python3 {GEN}"
        if as_json: AR.emit(AR.result(False, "failed", msg, f"python3 {GEN}", [], "", {})); return 2
        print(msg, file=sys.stderr); return 2
    probs = problems(spec, root)
    s = stale(root)
    notes = [f"note: {x}" for x in s]
    summary = (f"{a[0]}: complete for {spec['mold_id']}" if not probs else f"{a[0]}: {len(probs)} thing(s) keep it from being complete for {spec['mold_id']}")
    if as_json:
        res = AR.result(not probs, "done" if not probs else "failed", summary, "" if probs else f"python3 .claude/scripts/mint.py new {spec.get('app_id', '<app_id>')} --spec {a[0]}",
                        [], "", {"problems": [{"kind": k, "path": p, "message": m} for k, p, m in probs], "notes": notes,
                                 "features": effective_features(spec, root)})
        AR.emit(res); return 0 if not probs else 1
    print(summary)
    flags = effective_features(spec, root)
    if flags:
        sys.path.insert(0, os.path.join(HERE, "lib")); import features as F
        print(f"  flags: {F.words(flags)}")
    for k, p, m in probs: print(f"  {k}: {m}")
    for n in notes: print("  " + n)
    if not probs: print(f"next: python3 .claude/scripts/mint.py new {spec.get('app_id', '<app_id>')} --spec {a[0]}")
    return 0 if not probs else 1

# ---- spec -> brief (mint.py new --spec) ------------------------------------------------------------------------------
TARGET_WORDS = {"vercel": "It runs on Vercel.", "compose_remote": "It runs on its own server.", "vm": "It runs on the vm.", "vm_remote": "It runs on vm_remote."}

def _profile_lines(spec):
    """(## Profile lines, extra sections) saying the spec's budgets and profile the way a brief does (lib/app_profile.py from_brief)."""
    lines, extra = [], []
    def walk(prefix, d):
        for k, v in d.items():
            if isinstance(v, dict): walk(f"{prefix}.{k}", v)
            else: lines.append(f"{prefix}.{k} = {v:g}" if isinstance(v, float) else f"{prefix}.{k} = {v}")
    if spec.get("budgets"): walk("limits", spec["budgets"])
    # The audit trails (mold_v0-197): the spec's top-level audit, written to profile.audit (only a trail that is on).
    for k, v in (spec.get("audit") or {}).items():
        if v is True: lines.append(f"audit.{k} = true")
    # The capability flags (mold_v0-219): the spec's top-level features, each said as it is (true or false).
    for k, v in (spec.get("features") or {}).items():
        if isinstance(v, bool): lines.append(f"features.{k} = {'true' if v else 'false'}")
    prof = spec.get("profile") or {}
    for k, v in prof.items():
        if k == "member_keys": lines.append(f"member_keys = {'true' if v else 'false'}")
        elif k == "onprem_runners": lines.append(f"onprem_runners = {'true' if v else 'false'}")
        elif k == "email_from_address": lines.append(f"email_from_address = {v}")
        elif k == "email":
            for kk, vv in v.items(): lines.append(f"email.{kk} = {', '.join(vv) if isinstance(vv, list) else vv}" if vv != [] else f"email.{kk} = none")
        elif k == "source_offer":
            for pid, val in (v.get("upstreams") or {}).items(): lines.append(f"source_offer.upstreams.{pid} = {val}")
        elif k == "legal":
            for kk, vv in v.items(): lines.append(f"legal.{kk} = {vv}")
        elif k == "mcp_instructions": extra.append("## MCP instructions\n\n" + v.strip() + "\n")
        elif k == "landing": extra.append("## Landing\n\n```json\n" + json.dumps(v, indent=2, ensure_ascii=False) + "\n```\n")
    return lines, extra

def to_brief(spec, app_id):
    """-> (brief text, problems). The brief says exactly what the spec says, in the lines intake.py reads; it is then read
    back with intake.py's own parser, and any difference is a problem (nothing is written)."""
    p, w, mold = spec.get("product") or {}, spec.get("workspace") or {}, spec["mold_id"]
    ids = [x if isinstance(x, str) else x.get("id") for x in spec.get("packs") or []]
    L = [f"# {p.get('name', app_id)}", "", f"Mold: {mold}", TARGET_WORDS[(spec.get("deploy") or {})["target"]]]
    if (spec.get("deploy") or {}).get("server"): L.append(f"Server address: {spec['deploy']['server']}")
    L += [f"Product name: {p['name']}", f"Brand: {p['name']}", f"Brand colour: {p['colour']}", f"Logo: {p['logo']}"]
    if p.get("tagline"): L.append(f"Tagline: {p['tagline']}")
    if p.get("domain"): L.append(f"Domain: {p['domain']}")
    if ids: L.append(f"Packs: {', '.join(ids)}")
    if w.get("name"): L.append(f"Workspace: {w['name']}")
    if w.get("owner"): L.append(f"Owner: {w['owner']}")
    if w.get("members"): L.append(f"Members: {', '.join(w['members'])}")
    if w.get("platform_admins"): L.append(f"Admins: {', '.join(w['platform_admins'])}")
    caps = spec.get("capabilities") or {}
    if caps.get("web_search") is False: L.append("No web search.")
    if caps.get("browser") is False: L.append("No browser.")
    if caps.get("multi_tenant") is False: L.append("Single workspace.")
    inf = (spec.get("inference") or {}).get("provider")
    if inf: L.append({"vercel_ai_gateway": "Inference through the AI Gateway.", "cloudflare_workers_ai": "Inference on Workers AI."}.get(inf, ""))
    if spec.get("library"): L.append(f"Workflows: {spec['library']}")
    dic = spec.get("dictation") or {}
    if dic.get("model"): L.append(f"Speech model: {dic['model']}")
    if dic.get("enabled") is False: L.append("Dictation: off")
    L += ["", f"Minted from an app spec (briefs/{app_id}.spec.json, kind {spec.get('kind', 'tool')}); the spec is the source, this page is generated from it."]
    plines, extra = _profile_lines(spec)
    if plines: L += ["", "## Profile", *plines]
    for e in extra: L += ["", e.rstrip("\n")]
    text = "\n".join(L) + "\n"
    return text, _read_back(spec, text, ids)

def _read_back(spec, text, ids):
    sys.path.insert(0, HERE)
    import intake, brief_pack, app_profile
    h = intake.parse_brief(brief_pack.prose(text) if brief_pack.has_sections(text) else text)
    p, w = spec.get("product") or {}, spec.get("workspace") or {}
    want = {"mold_id": spec["mold_id"], "product_name": p.get("name"), "brand_name": p.get("name"), "brand_color": p.get("colour"),
            "brand_logo": p.get("logo"), "brand_tagline": p.get("tagline"), "custom_domain": p.get("domain"), "packs": ids or None,
            "workspace_name": w.get("name"), "operator_email": (w.get("owner") or "").lower() or None, "members": [m.lower() for m in w.get("members") or []] or None,
            "platform_admins": w.get("platform_admins") or None,
            "deploy_target": {"compose_remote": "vm_remote"}.get(spec["deploy"]["target"], spec["deploy"]["target"]),
            "inference_provider": (spec.get("inference") or {}).get("provider"), "library": spec.get("library"),
            "asr_model": (spec.get("dictation") or {}).get("model")}
    for k in ("web_search", "browser", "multi_tenant"):
        if (spec.get("capabilities") or {}).get(k) is False: want[k] = False
    out = []
    for k, v in want.items():
        if v is not None and h.get(k) != v:
            out.append(("not supported", k, f"the brief path would read {k} as {json.dumps(h.get(k))}, not {json.dumps(v)}: say it another way in the spec (nothing was written)"))
    # mold_v0-230: the generated brief is all setting lines; a sentence of it that reads as prose with a setting's words in it
    # would be a question at mint time, so it is refused here instead.
    for k, ph in sorted((h.get("prose_hints") or {}).items()):
        out.append(("not supported", k, f"the generated brief has a sentence intake would ask about ({ph['said'][:80]!r} reads as {k}): say it another way in the spec (nothing was written)"))
    prof = dict(spec.get("profile") or {});
    if spec.get("budgets"): prof["limits"] = spec["budgets"]
    on = {k: True for k, v in (spec.get("audit") or {}).items() if v is True}
    if on: prof["audit"] = on
    if spec.get("features"): prof["features"] = dict(spec["features"])
    got = h.get("profile") or {}
    if json.loads(json.dumps(prof)) != json.loads(json.dumps(got)) and (prof or got):
        out.append(("not supported", "profile", f"the brief's profile lines read back as {json.dumps(got)[:200]}, not the spec's {json.dumps(prof)[:200]} (nothing was written)"))
    return out

def _developer_catalog(root):
    """mold_v0's developer surface (codebase src/developer-config.ts, read without running it): (event names, SDK languages, API versions)."""
    t = open(os.path.join(root, "molds", "mold_v0", "codebase", "src", "developer-config.ts")).read()
    cat = re.search(r"EVENT_CATALOG = \{(.*?)\n\} as const", t, re.S).group(1)
    events = re.findall(r'^\s*"([a-z_]+\.[a-z_]+)":', cat, re.M)
    langs = re.findall(r'"([a-z]+)"', re.search(r"SDK_LANGUAGES = \[(.*?)\]", t).group(1))
    versions = re.findall(r'"([0-9-]+)"', re.search(r"API_VERSIONS = \[(.*?)\]", t).group(1))
    return events, langs, versions

def _developer_problems(spec, full, root):
    """mold_v0: the developer surface against what the mold builds (its events, SDK languages, versions) and where it goes (an inline pack)."""
    ds = spec.get("developer_surface")
    if spec.get("kind") != "embedded" or not isinstance(ds, dict): return []
    out = []
    events, langs, versions = _developer_catalog(root)
    for i, e in enumerate(ds.get("events") or []):
        if isinstance(e, dict) and e.get("name") not in events:
            out.append(("wrong value", f"developer_surface.events[{i}].name", f"developer_surface.events[{i}].name: {e.get('name')!r} is not an event mold_v0 emits ({', '.join(events)})"))
    for l in ds.get("sdk_languages") or []:
        if l not in langs: out.append(("not supported", "developer_surface.sdk_languages", f"developer_surface.sdk_languages: mold_v0 generates {', '.join(langs)}, not {l}"))
    if ds.get("api_version") is not None and ds["api_version"] not in versions:
        out.append(("wrong value", "developer_surface.api_version", f"developer_surface.api_version: one of {', '.join(versions)}"))
    inline = [p for p in full.get("packs") or [] if isinstance(p, dict) and isinstance(p.get("pack"), dict)]
    if not inline:
        out.append(("missing", "packs", "packs: an embedded app's developer surface is written into its pack, so give at least one pack inline ({\"id\", \"pack\"})"))
    else:
        areas = {a.get("name"): a for p in inline for a in (p["pack"].get("record_areas") or []) if isinstance(a, dict)}
        for i, r in enumerate(ds.get("webhooks_in") or []):
            a = areas.get((r or {}).get("area"))
            if not a or a.get("scope") != "workspace":
                out.append(("wrong value", f"developer_surface.webhooks_in[{i}].area", f"developer_surface.webhooks_in[{i}].area: {(r or {}).get('area')!r} is not a workspace record area of the app's inline packs"))
        # A client session's narrowed scopes (mold_v0-224) name what the inline packs declare: an area, a job kind, a check.
        checks = {c.get("name") for p in inline for c in (p["pack"].get("checks") or []) if isinstance(c, dict)}
        kinds = {k.get("name") for p in inline for k in (p["pack"].get("job_kinds") or []) + (p["pack"].get("agent_job_kinds") or []) if isinstance(k, dict)}
        for s in ((ds.get("client_sessions") or {}).get("scopes") or []):
            base, _, target = str(s).partition(":")
            if not target: continue
            if base == "checks" and target not in checks:
                out.append(("wrong value", "developer_surface.client_sessions.scopes", f"developer_surface.client_sessions.scopes: {s}: {target} is not a check of the app's inline packs ({', '.join(sorted(checks)) or 'none'})"))
            elif base in ("read", "write") and target not in areas:
                out.append(("wrong value", "developer_surface.client_sessions.scopes", f"developer_surface.client_sessions.scopes: {s}: {target} is not a record area of the app's inline packs"))
            elif base == "run" and target not in kinds:
                out.append(("wrong value", "developer_surface.client_sessions.scopes", f"developer_surface.client_sessions.scopes: {s}: {target} is not a job kind of the app's inline packs"))
        own = [p["id"] for p in inline if "developer_surface" in p["pack"]]
        if own: out.append(("wrong value", "developer_surface", f"developer_surface: pack {own[0]} declares its own too: say it once (in the spec)"))
    return out

def _tree(d):
    """{relative path: bytes} of every file under d (no __pycache__ or .pyc)."""
    out = {}
    for base, dirs, files in os.walk(d):
        dirs[:] = sorted(x for x in dirs if x != "__pycache__")
        for n in files:
            if not n.endswith(".pyc"): out[os.path.relpath(os.path.join(base, n), d)] = open(os.path.join(base, n), "rb").read()
    return out

def place_path_packs(spec, root):
    """mold_v1 (mold_v0-223): a pack the spec gives by path (a directory with its pack.json, e.g. examples/<mold>/<app>/pack)
    copied to packs/<id>/, where the brief path and packs.py read it. Never overwrites a different pack. -> [sentences]."""
    out = []
    for p in spec.get("packs") or []:
        if not (isinstance(p, dict) and p.get("path") and p.get("id")): continue
        src, dst = os.path.join(root, p["path"]), os.path.join(root, "packs", p["id"])
        if os.path.normpath(src) == os.path.normpath(dst): continue
        if not os.path.isfile(os.path.join(src, "pack.json")):
            out.append(f"{p['path']} has no pack.json. Nothing was written."); continue
        if os.path.isdir(dst):
            if _tree(src) != _tree(dst): out.append(f"packs/{p['id']}/ already exists and differs from {p['path']}: point the spec at it by id, or use another id. Nothing was written.")
            continue
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return out

def write_inline_packs(spec, root):
    """mold_v0: each inline pack (or one given by a path outside packs/) written to packs/<id>/ where the brief path reads it.
    Never overwrites a different pack.json. mold_v1: each pack given by path copied to packs/<id>/ (place_path_packs).
    -> [sentences] (problems)."""
    if spec.get("mold_id") == "mold_v1": return place_path_packs(spec, root)
    if spec.get("mold_id") != "mold_v0": return []
    full, probs, origin = resolve_packs(spec, root)
    if probs: return [m for _, _, m in probs]
    out = []
    # An embedded app's developer surface (mold_v0-193) goes into its first inline pack: the build reads it from pack.json.
    ds = spec.get("developer_surface") if spec.get("kind") == "embedded" else None
    for p in full.get("packs") or []:
        if ds and isinstance(p, dict) and isinstance(p.get("pack"), dict):
            p["pack"] = {**p["pack"], "developer_surface": copy.deepcopy(ds)}; break
    for i, p in enumerate(full.get("packs") or []):
        if not isinstance(p, dict) or "pack" not in p: continue
        pid = p["id"]; f = _pack_file(pid, root); man = os.path.join(root, "packs", pid, "pack.json")
        text = dumps(p["pack"])
        if os.path.isfile(f):
            if json.loads(open(f).read()) != p["pack"]:
                out.append(f"packs/{pid}/files/packs/{pid}/pack.json already exists and differs from the spec's pack {pid!r}: point the spec at it by id, or use another id. Nothing was written.")
            continue
        os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, "w") as fh: fh.write(text)
        if not os.path.isfile(man):
            with open(man, "w") as fh:
                fh.write(dumps({"pack_id": pid, "mold_id": "mold_v0", "name": p["pack"].get("name", pid),
                                "description": p["pack"].get("description") or f"{pid}: written from the app spec of {spec.get('app_id')}",
                                "spec": {"app_id": spec.get("app_id"), "from": origin.get(i, "inline")}}))
    return out

# ---- the live apps, read as specs ------------------------------------------------------------------------------------
def spec_from_state(app_id, root):
    adir = os.path.join(root, "state", "application", app_id)
    rd = lambda n: load(os.path.join(adir, n)) if os.path.isfile(os.path.join(adir, n)) else {}
    a, i = rd("application.json"), rd("infrastructure.json")
    mold = a.get("mold_id"); b = (a.get("surface") or {}).get("branding") or {}
    prod = {k: v for k, v in (("name", b.get("product_name")), ("colour", b.get("brand_color")), ("logo", b.get("logo")), ("tagline", b.get("tagline"))) if v}
    dom = (i.get("vercel") or {}).get("custom_domain") or (i.get("compose_remote") or {}).get("domain") or (i.get("vm_remote") or {}).get("domain")
    if dom: prod["domain"] = dom
    spec = {"app_id": app_id, "mold_id": mold, "product": prod, "deploy": {"target": i.get("target")}, "packs": list(a.get("packs") or [])}
    if mold == "mold_v0":
        spec["workspace"] = {"platform_admins": a["platform_admins"]} if a.get("platform_admins") else {}
        prof = dict(a.get("profile") or {})
        if prof.get("limits"): spec["budgets"] = prof.pop("limits")
        # profile.audit (mold_v0-197) is the spec's top-level audit; its retention days stay the state's own.
        if isinstance(prof.get("audit"), dict):
            au = prof.pop("audit"); spec["audit"] = {k: au[k] for k in ("data", "platform", "sign") if isinstance(au.get(k), bool)}
        # profile.features (mold_v0-219) is the spec's top-level features.
        if isinstance(prof.get("features"), dict): spec["features"] = prof.pop("features")
        if prof: spec["profile"] = prof
    else:
        ws = a.get("workspace") or {}; org = ws.get("org") or {}; me = ws.get("operator_self") or {}
        spec["workspace"] = {k: v for k, v in (("name", org.get("display_name") or org.get("name")), ("owner", me.get("email")),
                                                 ("members", [m["email"] for m in ws.get("members") or [] if m.get("email") and m.get("email") != me.get("email")]),
                                                 ("platform_admins", ws.get("platform_admins"))) if v}
        if a.get("capabilities"): spec["capabilities"] = {k: v for k, v in a["capabilities"].items() if k in ("web_search", "browser", "multi_tenant")}
        if (i.get("inference") or {}).get("provider"): spec["inference"] = {"provider": i["inference"]["provider"]}
        lib = (((a.get("surface") or {}).get("custom_workflow_builder") or {}).get("library") or {}).get("install")
        if lib in ("none", "all"): spec["library"] = lib
        if (a.get("asr") or {}).get("model"): spec["dictation"] = {"model": a["asr"]["model"]}
        if i.get("target") == "vm_remote" and (i.get("vm_remote") or {}).get("host"): spec["deploy"]["server"] = i["vm_remote"]["host"]
    return spec, a.get("status")

def cmd_apps(a, root=ROOT):
    as_json = "--json" in a; src = a[a.index("--from") + 1] if "--from" in a else root
    sdir = os.path.join(src, "state", "application")
    rows = []
    for app in sorted(x for x in os.listdir(sdir) if x != "app_id" and os.path.isdir(os.path.join(sdir, x))):
        spec, status = spec_from_state(app, src)
        if status == "retired": rows.append({"app": app, "mold": spec.get("mold_id"), "status": status, "complete": None, "gaps": ["retired: not checked"]}); continue
        if spec.get("mold_id") not in MOLDS: rows.append({"app": app, "mold": spec.get("mold_id"), "status": status, "complete": None, "gaps": ["no spec schema for this mold"]}); continue
        gaps = [m for _, _, m in problems(spec, src, load(schema_path(spec["mold_id"], root)))]
        if spec["mold_id"] == "mold_v0": gaps.append("kind and run_keys are not recorded in an app's state yet (the spec carries them; read as the defaults: tool)")
        row = {"app": app, "mold": spec["mold_id"], "status": status, "complete": not [g for g in gaps if not g.startswith("kind and run_keys")], "gaps": gaps}
        flags = effective_features(spec, src)
        if flags:
            sys.path.insert(0, os.path.join(HERE, "lib")); import features as F
            row["features"] = {f["id"]: f["on"] for f in flags}; row["flags"] = F.words(flags)
        rows.append(row)
    if as_json: print(json.dumps({"apps": rows}, indent=2)); return 0
    for r in rows:
        print(f"{r['app']} ({r['mold']}, {r['status']}): {'complete' if r['complete'] else 'not complete' if r['complete'] is False else 'not checked'}")
        if r.get("flags"): print(f"  flags: {r['flags']}")
        for g in r["gaps"]: print(f"  - {g}")
    print("read-only: no application was changed")
    return 0

# ---- self-test -------------------------------------------------------------------------------------------------------
def self_test():
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    ok(not stale(), "the generated schemas on disk are current (factory.py validate fails when they are not)")
    for m in MOLDS:
        ex = os.path.join(ROOT, SCHEMA_DIR, "examples", f"{m}.example.app.json")
        spec = load(ex); probs = problems(spec)
        ok(probs == [], f"schemas/examples/{m}.example.app.json is complete ({probs[:3]})")
        txt = json.dumps(spec)
        ok(not re.search(r"@(?!(?:[a-z0-9-]+\.)*example\.com\b)[a-z0-9-]+\.[a-z]", txt), f"{m} example: every address is at example.com")
        b, bp = to_brief(spec, spec["app_id"]); ok(bp == [], f"{m} example: its brief reads back as the spec ({bp[:2]})")
        e = copy.deepcopy(spec); e["kind"] = "embedded"
        msgs = [x[2] for x in problems(e)]
        ok(any("developer_surface is missing" in x for x in msgs) and any("audit" in x for x in msgs), f"{m}: kind embedded without a developer surface and the platform audit trail is refused")
        e["developer_surface"] = {"events": [{"name": "record.created", "description": "A record was created."}], "sdk_languages": ["typescript"],
                                  "client_sessions": {"ttl_seconds": 600, "allowed_origins": ["https://app.example.com"]}}
        e["audit"] = {"data": False, "platform": True}
        ok(problems(e) == [], f"{m}: kind embedded with the developer surface and audit.platform true is complete")
        if m == "mold_v0":
            x = copy.deepcopy(e); x["developer_surface"]["events"] = [{"name": "record.exploded", "description": "x"}]; x["developer_surface"]["sdk_languages"] = ["go"]
            msgs = [y[2] for y in problems(x)]
            ok(any("record.exploded" in y for y in msgs) and any("not go" in y for y in msgs), "mold_v0: an event it does not emit and an SDK it does not generate are refused")
            x = copy.deepcopy(e); x["packs"] = []
            ok(any("give at least one pack inline" in y[2] for y in problems(x)), "mold_v0: an embedded app's developer surface needs an inline pack to go into")
            # mold_v0-224: client sessions may hold checks (all, or one named check); never a scope a session cannot hold.
            x = copy.deepcopy(e); x["developer_surface"]["client_sessions"]["scopes"] = ["read", "checks"]
            ok(problems(x) == [], f"mold_v0: client sessions holding read and checks are complete ({problems(x)[:2]})")
            x["developer_surface"]["client_sessions"]["scopes"] = ["checks:no_such_check"]
            ok(any("no_such_check is not a check" in y[2] for y in problems(x)), "mold_v0: a session scope checks:<name> names a check of the app's inline packs")
            x["developer_surface"]["client_sessions"]["scopes"] = ["sessions"]
            ok(problems(x) != [], "mold_v0: a client session never holds sessions (nor webhooks)")
        e["audit"]["platform"] = False
        ok(any("audit.platform" in x[2] for x in problems(e)), f"{m}: kind embedded with audit.platform false is refused")
        if m == "mold_v0":   # mold_v0-197: the top-level audit becomes the brief's audit lines, read back into profile.audit
            import app_profile as _ap
            lines, _ = _profile_lines({"audit": {"data": True, "platform": False}})
            ok("audit.data = true" in lines and not any("platform" in l for l in lines)
               and (_ap.from_brief("## Profile\n" + "\n".join(lines) + "\n")[0] or {}).get("audit") == {"data": True}, f"{m}: audit.data true is written to profile.audit through the brief")
            lines, _ = _profile_lines({"profile": {"onprem_runners": True}})   # mold_v0-205
            ok(lines == ["onprem_runners = true"] and (_ap.from_brief("## Profile\n" + "\n".join(lines) + "\n")[0] or {}).get("onprem_runners") is True
               and _ap.from_brief("## Profile\nonprem_runners = false\n")[0] == {"onprem_runners": False}, f"{m}: onprem_runners is written to the profile through the brief")
            lines, _ = _profile_lines({"audit": {"data": True, "sign": True}})   # mold_v0-195: chain and sign
            ok("audit.sign = true" in lines and (_ap.from_brief("## Profile\n" + "\n".join(lines) + "\n")[0] or {}).get("audit") == {"data": True, "sign": True},
               f"{m}: audit.sign true is written to profile.audit through the brief")
        if m == "mold_v0":   # mold_v0-219: the capability flags
            import features as _F
            x = copy.deepcopy(spec); x["features"] = {"company_email": False, "audit.data": True}
            ok(problems(x) == [] and to_brief(x, x["app_id"])[1] == [], f"{m}: a features block is complete and reads back through the brief")
            lines, _ = _profile_lines(x)
            ok("features.company_email = false" in lines and "features.audit.data = true" in lines, f"{m}: features become features.<flag> lines")
            x["features"] = {"audit.sign": True}; x["audit"] = {"data": False, "platform": False}
            ok(any("one of them must be on" in y[2] or "audit" in y[1] for y in problems(x)), f"{m}: audit.sign without a trail is refused")
            x["features"] = {"developer_surface": True}
            ok(problems(x) != [], f"{m}: developer_surface true on a tool is refused (kind is the switch)")
            x["features"] = {"nope": True}
            ok(any(y[0] == "not supported" for y in problems(x)), f"{m}: an unknown flag is not supported")
            ok(_F.words(effective_features({**spec, "features": {"health_history": False}})) != _F.words(effective_features(spec)), f"{m}: the effective flags follow the features block")
            ok(_F.self_test(ROOT) != [], f"{m}: lib/features.py self-test")
        t = copy.deepcopy(spec); t["developer_surface"] = e["developer_surface"]
        ok(any("not supported" == x[0] and "developer_surface" in x[1] for x in problems(t)), f"{m}: a developer surface on a tool is not supported")
        t = copy.deepcopy(spec); t["colour_typo"] = 1; del t["product"]["colour"]
        msgs = problems(t)
        ok(any(x[0] == "missing" and x[1] == "product.colour" for x in msgs) and any(x[0] == "not supported" and x[1] == "colour_typo" for x in msgs),
           f"{m}: a missing colour and an unknown key are named in plain words")
    v0 = load(os.path.join(ROOT, SCHEMA_DIR, "examples", "mold_v0.example.app.json"))
    t = copy.deepcopy(v0); del t["run_keys"]; del t["budgets"]
    msgs = [x[2] for x in problems(t)]
    ok(any("run_keys is missing" in x for x in msgs) and any("budgets is missing" in x for x in msgs), "mold_v0: agent job kinds without budgets and run keys are refused")
    t = copy.deepcopy(v0); del t["run_keys"]["model"]
    ok(any(x[1] == "run_keys.model" for x in problems(t)), "mold_v0: agent job kinds need the model key (anthropic or vertex)")
    t = copy.deepcopy(v0); t["deploy"]["target"] = "compose_remote"; t["product"].pop("domain", None)
    ok(any(x[1] == "product.domain" for x in problems(t)), "mold_v0: a server of its own needs a domain")
    t = copy.deepcopy(v0); del t["packs"][0]["pack"]["job_kinds"][0]["agent"]["commit"]
    ok(any("commit" in x[2] for x in problems(t)), "mold_v0: an agent job kind without a pinned commit is refused")
    t = copy.deepcopy(v0); t["budgets"]["runs"]["budget_usd_max"] = 1
    ok(any("raise the budget" in x[2] for x in problems(t)), "mold_v0: a run budget below a job kind's own is refused")
    t = copy.deepcopy(v0); t["budgets"]["runs"]["budget_usd_max"] = 100000
    ok(any("at most" in x[2] for x in problems(t)), "mold_v0: a budget above the factory's ceiling is refused")
    t = copy.deepcopy(v0); t["workspace"]["owner"] = "owner@example.com"
    ok(any(x[0] == "not supported" and "workspace.owner" in x[1] for x in problems(t)), "mold_v0: a workspace owner is not supported (companies are made in the app)")
    t = copy.deepcopy(v0); t["packs"] = ["nope_not_here"]
    ok(any("not on this machine" in x[2] for x in problems(t)), "mold_v0: a pack named by id that is not on this machine is said")
    v1 = load(os.path.join(ROOT, SCHEMA_DIR, "examples", "mold_v1.example.app.json"))
    import tempfile as _tf
    with _tf.TemporaryDirectory() as r_:   # mold_v0-223: a mold_v1 pack given by path is placed in packs/<id>/ by mint new --spec
        os.makedirs(os.path.join(r_, "ex", "pack", "files", "agent", "instructions"))
        open(os.path.join(r_, "ex", "pack", "pack.json"), "w").write('{"pack_id": "zz-pack"}')
        open(os.path.join(r_, "ex", "pack", "files", "agent", "instructions", "50-pack-zz-pack.md"), "w").write("x")
        s_ = {"mold_id": "mold_v1", "packs": [{"id": "zz-pack", "path": "ex/pack"}]}
        ok(write_inline_packs(s_, r_) == [] and os.path.isfile(os.path.join(r_, "packs", "zz-pack", "files", "agent", "instructions", "50-pack-zz-pack.md"))
           and write_inline_packs(s_, r_) == [], "mold_v1: a pack given by path is copied to packs/<id>/ (and again is a no-op)")
        open(os.path.join(r_, "ex", "pack", "pack.json"), "w").write('{"pack_id": "zz-pack", "changed": true}')
        ok(any("differs" in x for x in write_inline_packs(s_, r_)), "mold_v1: a different pack already in packs/<id>/ is never overwritten")
    t = copy.deepcopy(v1); t["budgets"] = {"runs": {"budget_usd_max": 5}}
    ok(any(x[0] == "not supported" and x[1] == "budgets" for x in problems(t)), "mold_v1: budgets are not supported, with the reason")
    t = copy.deepcopy(v1); t["deploy"] = {"target": "vm_remote"}
    ok({"product.domain", "deploy.server"} <= {x[1] for x in problems(t)}, "mold_v1: vm_remote needs a server and a domain")
    # a stale schema is caught
    import tempfile, shutil
    with tempfile.TemporaryDirectory() as t_:
        for d in ("state/application/app_id", "molds/mold_v0/branding", "molds/mold_v0/codebase/packs", "molds/mold_v0/codebase/scripts",
                  "molds/mold_v0/codebase/src", "molds/mold_v1/branding", ".claude/scripts", SCHEMA_DIR):
            os.makedirs(os.path.join(t_, d), exist_ok=True)
        for m in MOLDS:
            for f in sources(m, ROOT): shutil.copy(os.path.join(ROOT, f), os.path.join(t_, f))
            shutil.copy(schema_path(m), schema_path(m, t_))
        ok(stale(t_) == [], "a copy of the sources gives the same schemas")
        with open(os.path.join(t_, "molds/mold_v0/mold.json")) as fh: mj = json.load(fh)
        mj["targets"].append("elsewhere")
        with open(os.path.join(t_, "molds/mold_v0/mold.json"), "w") as fh: json.dump(mj, fh)
        ok(len(stale(t_)) == 1 and "mold_v0" in stale(t_)[0], "a mold change that is not regenerated is reported stale")
    print(f"app_spec: {len(checks)} checks passed")
    return 0

def main(a):
    if not a: print(__doc__, file=sys.stderr); return 2
    if a[0] == "--self-test": return self_test()
    if a[0] == "generate": return cmd_generate(a[1:])
    if a[0] == "check": return cmd_check(a[1:])
    if a[0] == "apps": return cmd_apps(a[1:])
    if a[0] == "brief" and len(a) >= 2:
        spec, err = _read_spec(os.path.abspath(a[1]))
        if err: print(err, file=sys.stderr); return 2
        app = a[a.index("--app") + 1] if "--app" in a else spec.get("app_id")
        text, probs = to_brief(spec, app); print(text, end="")
        for _, _, m in probs: print(f"problem: {m}", file=sys.stderr)
        return 1 if probs else 0
    print(__doc__, file=sys.stderr); return 2

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
