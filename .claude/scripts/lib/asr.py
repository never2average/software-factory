#!/usr/bin/env python3
"""The speech-to-text model behind an app's microphone button (dictation), chosen per app by its developer.

  python3 .claude/scripts/lib/asr.py --self-test

application.json may carry an `asr` block: { "enabled": true|false, "model": "<id>", "language": "<xx>"|null }.
Absent (or a key absent), the mold's own default applies: its deployment profile's `asr` (profiles/*.json, merged in
file order, the app's packs' profiles included). The allow-list is MODELS below: speech-to-text models on Cloudflare
Workers AI that the mold's dictation can call (its lib/dictation-models.ts) and price per audio minute (its
lib/inference-pricing.ts). The prices here are for the intake question and the reports; the app's own usage page
prices from its own table.

HOW THE CHOICE REACHES THE APP: the same way the chat's per-role models do (CLOUDFLARE_MODEL_<ROLE>): environment
values written on every deploy, so the running app cannot disagree with its state:

  ASR_MODEL     the model id
  ASR_LANGUAGE  the two-letter code, or "auto" for none (the model detects it)
  ASR_ENABLED   "true" / "false"

provision.py writes them to the Vercel projects; lib/vm_remote.py config_pairs() puts them in the server's env file.
A mold that does not read them yet (no ASR_MODEL in its lib/dictation-models.ts) gets none, and an app whose choice
differs from that mold's profile is REFUSED (problems(), env_pairs()): the deploy would run another model than state
says. Fail closed, with the fix in the message.

Standard library only.
"""
import glob, json, os, re, sys

# Read on 2026-10-12. Price: USD per audio minute, as each model's page states it ("Unit Pricing"); the pricing page
# (https://developers.cloudflare.com/workers-ai/platform/pricing/) rounds the Whisper ones to $0.0005 and gives the
# neurons: 46.63 (turbo), 41.14 (whisper), 472.73 (nova-3 over HTTP) at $0.011 per 1,000 neurons.
MODELS = {
    "@cf/openai/whisper-large-v3-turbo": {
        "label": "Whisper large v3 turbo (OpenAI)", "usd_per_min": 0.000513, "languages": "any",
        "note": "today's default; any language, or detects it",
        "source": "https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/"},
    "@cf/openai/whisper": {
        "label": "Whisper (OpenAI, the older model)", "usd_per_min": 0.000453, "languages": [],
        "note": "a little cheaper; always detects the language (takes none)",
        "source": "https://developers.cloudflare.com/workers-ai/models/whisper/"},
    "@cf/deepgram/nova-3": {
        "label": "Nova-3 (Deepgram)", "usd_per_min": 0.0052, "languages": ["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"],
        "note": "about 10x the price; formatted text; en, es, fr, de, hi, ru, pt, ja, it, nl",
        "source": "https://developers.cloudflare.com/workers-ai/models/nova-3/ (HTTP price; the WebSocket one is not used)"},
}
DEFAULT_MODEL = "@cf/openai/whisper-large-v3-turbo"
LANGUAGE = re.compile(r"^[a-z]{2}$")
MOLD_READS = "lib/dictation-models.ts"      # a mold that has this, naming ASR_MODEL, takes the choice from env
ENV_NAMES = ("ASR_MODEL", "ASR_LANGUAGE", "ASR_ENABLED")
# Words a brief may use for a model, beside its full id.
ALIASES = {"whisper-large-v3-turbo": "@cf/openai/whisper-large-v3-turbo", "whisper large v3 turbo": "@cf/openai/whisper-large-v3-turbo",
           "whisper turbo": "@cf/openai/whisper-large-v3-turbo", "turbo": "@cf/openai/whisper-large-v3-turbo",
           "whisper": "@cf/openai/whisper", "nova-3": "@cf/deepgram/nova-3", "nova 3": "@cf/deepgram/nova-3",
           "nova3": "@cf/deepgram/nova-3", "deepgram": "@cf/deepgram/nova-3", "deepgram nova-3": "@cf/deepgram/nova-3"}
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def price_text(model):
    m = MODELS[model]
    return f"${m['usd_per_min']:.6f}".rstrip("0") + " per audio minute"


def options():
    """The intake question's options, cheapest first is NOT the order: today's default first, then the rest."""
    return [DEFAULT_MODEL] + [k for k in MODELS if k != DEFAULT_MODEL]


def question_text():
    lines = "; ".join(f"{k} = {MODELS[k]['label']}, {price_text(k)} ({MODELS[k]['note']})" for k in options())
    return ("Speech model for the microphone button (people speak, and the words land in the message box to edit and send). "
            f"Optional; the default is today's model. Choices: {lines}.")


def normalize(name):
    """A model id or a brief's word for one -> the id, or None when it is not on the list."""
    if not isinstance(name, str): return None
    n = name.strip().strip("`\"'.,;").lower()
    if n in MODELS: return n
    return ALIASES.get(n)


def language_problem(model, language):
    """Why this model cannot take this language, or None."""
    if language is None: return None
    if not isinstance(language, str) or not LANGUAGE.match(language):
        return f"asr.language must be a two-letter ISO 639-1 code (for example \"en\") or null, not {language!r}"
    langs = MODELS.get(model, {}).get("languages", "any")
    if langs == "any": return None
    if not langs: return f"{model} takes no language (it always detects it); set asr.language to null"
    if language not in langs: return f"{model} does not transcribe {language!r}; it takes {', '.join(langs)}, or null"
    return None


def profile_asr(codebase, packs=(), root=ROOT):
    """The `asr` a build of this codebase would have before any env: its profiles/*.json, plus the packs' profiles,
    merged in file order (as scripts/gen-deployment-profile.mjs does). {} when there is no profile."""
    files = {os.path.basename(f): f for f in glob.glob(os.path.join(codebase, "profiles", "*.json"))}
    for p in packs or ():
        for f in glob.glob(os.path.join(root, "packs", str(p), "files", "profiles", "*.json")): files.setdefault(os.path.basename(f), f)
    out = {}
    for name in sorted(files):
        try: a = json.load(open(files[name])).get("asr")
        except (OSError, ValueError, AttributeError): continue
        if isinstance(a, dict): out.update({k: v for k, v in a.items() if not k.startswith("$")})
    return out


def mold_reads_env(codebase):
    """Does this codebase take ASR_MODEL / ASR_LANGUAGE / ASR_ENABLED from its environment?"""
    p = os.path.join(codebase, MOLD_READS)
    try: return "ASR_MODEL" in open(p).read()
    except OSError: return False


def mold_lists(codebase, model):
    """Does this codebase's own model table name this model (so it can call it)?"""
    try: return json.dumps(model) in open(os.path.join(codebase, MOLD_READS)).read()
    except OSError: return False


def choice(app, codebase, root=ROOT):
    """The app's effective choice: its `asr` block over the build's profile (mold + packs). -> dict with enabled, model,
    language, and `chosen` (the keys the app itself set)."""
    base = profile_asr(codebase, app.get("packs") or (), root)
    mine = app.get("asr") if isinstance(app.get("asr"), dict) else {}
    out = {"enabled": base.get("enabled", True), "model": base.get("model", DEFAULT_MODEL), "language": base.get("language")}
    for k in ("enabled", "model", "language"):
        if k in mine: out[k] = mine[k]
    out["chosen"] = sorted(k for k in ("enabled", "model", "language") if k in mine)
    out["profile"] = {k: base.get(k) for k in ("enabled", "model", "language")}
    return out


def problems(app_id, app, codebase, root=ROOT):
    """What factory.py validate says about the speech-model choice, beyond the schema's enum."""
    if not isinstance(app, dict) or not isinstance(app.get("asr"), dict): return []
    c = choice(app, codebase, root); errs = []
    where = f"{app_id}/application.json"
    if c["model"] not in MODELS:
        return [f"{where}: asr.model {c['model']!r} is not on the speech-model list ({', '.join(options())})"]
    why = language_problem(c["model"], c["language"])
    if why: errs.append(f"{where}: {why}")
    if not os.path.isdir(codebase): return errs
    if mold_reads_env(codebase):
        if not mold_lists(codebase, c["model"]):
            errs.append(f"{where}: asr.model {c['model']} is not one the mold's dictation can call ({MOLD_READS}); "
                        f"refresh the mold, or choose {DEFAULT_MODEL}")
    else:
        differs = [k for k in c["chosen"] if c[k] != c["profile"].get(k)]
        if differs:
            errs.append(f"{where}: asr {', '.join(differs)} differs from the mold's own ({', '.join(f'{k}={c['profile'].get(k)!r}' for k in differs)}), "
                        f"but this mold cannot take a per-app speech model yet (no ASR_MODEL in {MOLD_READS}), so the app would run "
                        f"the mold's. Refresh the mold to one that reads ASR_MODEL, or set asr back to the mold's values.")
    return errs


def env_pairs(app, codebase, root=ROOT):
    """{name: value} to write into the app's environment on every deploy. {} for a mold that does not read them. Exits
    (fails closed) when the app's choice cannot be carried: see problems()."""
    errs = problems(app.get("app_id", "this app"), app, codebase, root)
    if errs: sys.exit("speech model: " + "; ".join(errs))
    if not mold_reads_env(codebase): return {}
    c = choice(app, codebase, root)
    return {"ASR_MODEL": c["model"], "ASR_LANGUAGE": c["language"] or "auto", "ASR_ENABLED": "true" if c["enabled"] else "false"}


def describe(app, codebase, root=ROOT):
    """One plain line for a plan or a report."""
    c = choice(app, codebase, root)
    if not c["enabled"]: return "dictation off"
    m = c["model"]; p = price_text(m) if m in MODELS else "unpriced"
    return f"{m} ({p}), language {c['language'] or 'detected'}" + ("" if c["chosen"] else " (the mold's default)")


# ------------------------------------------------------------------------------------------------- self-test
def self_test():
    import tempfile
    n = [0]
    def ok(c, what, detail=""):
        assert c, f"{what}: {detail}" if detail else what
        n[0] += 1; print(f"  ok   {what}")
    ok(DEFAULT_MODEL in MODELS and options()[0] == DEFAULT_MODEL and len(options()) == 3, "the default is on the list, offered first")
    ok(all(isinstance(m["usd_per_min"], float) and m["source"].startswith("https://developers.cloudflare.com/workers-ai/models/") for m in MODELS.values()),
       "every model has a price per audio minute and its source")
    ok(price_text("@cf/openai/whisper-large-v3-turbo") == "$0.000513 per audio minute" and price_text("@cf/deepgram/nova-3") == "$0.0052 per audio minute", "prices read plainly")
    ok(all(k in question_text() for k in MODELS) and "$0.000513" in question_text() and "Optional" in question_text(), "the question offers every model with its price")
    ok(normalize("Nova-3") == "@cf/deepgram/nova-3" and normalize("@cf/openai/whisper") == "@cf/openai/whisper" and normalize("turbo.") == DEFAULT_MODEL and normalize("gpt-4o-transcribe") is None,
       "brief words map to ids; an unknown one maps to nothing")
    ok(language_problem("@cf/openai/whisper", "en") and language_problem("@cf/deepgram/nova-3", "ta") and language_problem(DEFAULT_MODEL, "English")
       and language_problem(DEFAULT_MODEL, "ta") is None and language_problem("@cf/openai/whisper", None) is None and language_problem("@cf/deepgram/nova-3", "hi") is None,
       "language rules: none for the older Whisper, nova-3's ten, any two-letter code for turbo")
    with tempfile.TemporaryDirectory() as t:
        def mold(name, reads):
            d = os.path.join(t, name); os.makedirs(os.path.join(d, "profiles")); os.makedirs(os.path.join(d, "lib"))
            json.dump({"asr": {"$comment": "x", "enabled": True, "provider": "cloudflare", "model": DEFAULT_MODEL, "language": None}}, open(os.path.join(d, "profiles", "00-default.json"), "w"))
            if reads: open(os.path.join(d, MOLD_READS), "w").write('const M = {"@cf/openai/whisper-large-v3-turbo": 1, "@cf/openai/whisper": 1, "@cf/deepgram/nova-3": 1}; env.ASR_MODEL')
            return d
        old, new = mold("old", False), mold("new", True)
        os.makedirs(os.path.join(t, "packs", "p1", "files", "profiles"))
        json.dump({"asr": {"language": "en"}}, open(os.path.join(t, "packs", "p1", "files", "profiles", "50-pack-p1.json"), "w"))
        ok(profile_asr(old) == {"enabled": True, "provider": "cloudflare", "model": DEFAULT_MODEL, "language": None}, "the profile's asr, comments dropped")
        ok(profile_asr(old, ["p1"], root=t)["language"] == "en", "a pack's profile is merged in file order")
        ok(not mold_reads_env(old) and mold_reads_env(new), "a mold that reads ASR_MODEL is told apart from one that does not")
        A = lambda **asr: {"app_id": "a1", **({"asr": asr} if asr is not None else {})}
        ok(problems("a1", {"app_id": "a1"}, old) == [] and env_pairs({"app_id": "a1"}, old) == {}, "no asr block, old mold: nothing to check, nothing written")
        ok(env_pairs({"app_id": "a1"}, new) == {"ASR_MODEL": DEFAULT_MODEL, "ASR_LANGUAGE": "auto", "ASR_ENABLED": "true"}, "no asr block, new mold: the profile's choice, written so env mirrors state")
        same = A(enabled=True, model=DEFAULT_MODEL, language=None)
        ok(problems("a1", same, old) == [] and env_pairs(same, old) == {}, "today's model set explicitly on an old mold: allowed (it is what the mold runs)")
        nova = A(model="@cf/deepgram/nova-3", language="hi")
        e = problems("a1", nova, old)
        ok(len(e) == 1 and "cannot take a per-app speech model yet" in e[0] and "model" in e[0] and "language" in e[0], "another model on an old mold: refused, with the fix", e)
        try: env_pairs(nova, old); ok(False, "env_pairs must exit")
        except SystemExit as x: ok("speech model:" in str(x) and "Refresh the mold" in str(x), "...and the deploy step fails closed with the same words")
        ok(env_pairs(nova, new) == {"ASR_MODEL": "@cf/deepgram/nova-3", "ASR_LANGUAGE": "hi", "ASR_ENABLED": "true"}, "a new mold: the choice becomes ASR_MODEL / ASR_LANGUAGE / ASR_ENABLED")
        ok(env_pairs(A(enabled=False), new)["ASR_ENABLED"] == "false", "turned off: ASR_ENABLED=false")
        ok(problems("a1", A(model="@cf/openai/whisper", language="en"), new) == ["a1/application.json: @cf/openai/whisper takes no language (it always detects it); set asr.language to null"],
           "a language the model cannot take: refused")
        ok("not on the speech-model list" in problems("a1", A(model="@cf/x/y"), new)[0], "a model off the list: refused")
        open(os.path.join(new, MOLD_READS), "w").write('const M = {"@cf/openai/whisper-large-v3-turbo": 1}; env.ASR_MODEL')
        ok("not one the mold's dictation can call" in problems("a1", nova, new)[0], "a model the mold's own table lacks: refused")
        ok(describe(nova, old).startswith("@cf/deepgram/nova-3 ($0.0052 per audio minute), language hi") and describe({"app_id": "a"}, old).endswith("(the mold's default)"), "a plain line for plans and reports")
    print(f"asr: {n[0]} checks passed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    sys.exit(__doc__)
