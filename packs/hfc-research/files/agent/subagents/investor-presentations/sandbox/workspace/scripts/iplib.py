#!/usr/bin/env python3
"""Helpers shared by the investor-presentations scripts (this subagent only; finlib is the mold-wide library).

  load_table(name)            the JSON reference tables in /workspace/references
  phrase_regex / find_phrases word-boundary, whitespace-flexible phrase matching
  find_periods(text)          every period token in a slide's text, normalised through finlib.periods
  find_units(text)            every unit a text names (finlib.units.detect_unit returns None on more than one)
  find_numbers(text)          number tokens with their own suffix (%, bps, x, Cr, mn, bn, lakh) and currency
  parse_range(text)           '18% to 20%', '18-20%', '30 to 40 bps', 'Rs 500 crore' -> low/high/unit
  emit / fail                 the script contract: JSON on stdout, problems on stderr with a non-zero exit

Standard library only. Run `python3 /workspace/scripts/iplib.py --self-test`.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re
from finlib import numbers, units, periods

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCES = os.path.join(HERE, "..", "references")
SCHEMAS = os.path.join(HERE, "..", "schemas")

# Where the skills keep a mirror of each table (repo layout only; in the sandbox skills live elsewhere).
MIRRORS = {
    "metric-synonyms.json": "operational-metrics",
    "section-keywords.json": "deck-layout-variants",
    "guidance-topics.json": "concall-guidance-tracking",
}


def emit(obj):
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def fail(message, code=2):
    sys.stderr.write(str(message).rstrip() + "\n")
    sys.exit(code)


def load_table(name):
    path = os.path.join(REFERENCES, name)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_schema(name):
    with open(os.path.join(SCHEMAS, name), encoding="utf-8") as f:
        return json.load(f)


def mirror_drift():
    """[(table, problem)] for every skill mirror that exists and differs from the sandbox copy.
    Outside the repo layout the mirrors are not visible and nothing is reported."""
    out = []
    skills = os.path.join(HERE, "..", "..", "..", "skills")
    for table, skill in MIRRORS.items():
        mirror = os.path.join(skills, skill, "references", table)
        if not os.path.exists(mirror):
            continue
        with open(mirror, "rb") as a, open(os.path.join(REFERENCES, table), "rb") as b:
            if a.read() != b.read():
                out.append((table, f"skills/{skill}/references/{table} differs from sandbox/workspace/references/{table}"))
    return out


# ---------------------------------------------------------------- phrases

def phrase_regex(phrase):
    """Case-insensitive regex for a phrase: word boundaries, any whitespace/hyphen run between words,
    '&' and 'and' interchangeable."""
    words = re.split(r"[\s]+", phrase.strip().lower())
    parts = []
    for w in words:
        if w in ("&", "and"):
            parts.append(r"(?:&|and)")
        else:
            parts.append(re.escape(w).replace(r"\-", r"[\s\-‐-―]?"))
    body = r"\s+".join(parts)
    return re.compile(r"(?<![A-Za-z0-9])" + body + r"(?![A-Za-z0-9])", re.I)


_RX_CACHE = {}


def find_phrases(text, phrases):
    """The phrases (as given) that occur in text, longest first, each once."""
    hits = []
    for p in sorted(set(phrases), key=lambda s: (-len(s), s)):
        rx = _RX_CACHE.get(p)
        if rx is None:
            rx = _RX_CACHE[p] = phrase_regex(p)
        if rx.search(text or ""):
            hits.append(p)
    return hits


# ---------------------------------------------------------------- periods

_MON = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_FY = r"fy\s*['’]?\s*(?:20)?\d{2}(?:\s*[-/–]\s*(?:20)?\d{2})?"
_PERIOD_PATTERNS = [
    ("fiscal", re.compile(r"(?<![A-Za-z0-9])(?:q\s*[1-4]|[1-4]\s*q|h\s*[12]|[12]\s*h|9\s*m|6\s*m|12\s*m)\s*[-'’ ]?\s*" + _FY + r"(?![0-9])", re.I)),
    ("fiscal", re.compile(r"(?<![A-Za-z0-9])" + _FY + r"(?![0-9])", re.I)),
    ("trailing", re.compile(r"(?<![A-Za-z0-9])(?:ttm|ltm|trailing\s+(?:twelve|12)\s+months|last\s+(?:twelve|12)\s+months|rolling\s+12\s+months)(?![A-Za-z0-9])", re.I)),
    ("ended", re.compile(r"(?:quarter|three\s+months|3\s+months|half[- ]year|six\s+months|6\s+months|nine\s+months|9\s+months|year|twelve\s+months|12\s+months)\s+end(?:ed|ing)\s+(?:on\s+)?(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+" + _MON + r",?\s+\d{4}|" + _MON + r"\s+\d{1,2},?\s+\d{4})", re.I)),
    ("as_at", re.compile(r"(?:as\s+(?:on|at|of)\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+" + _MON + r",?\s+\d{4}|" + _MON + r"\s+\d{1,2},?\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})", re.I)),
    ("as_at", re.compile(r"(?<![A-Za-z0-9])" + _MON + r"\s*[-'’ ]\s*(?:20)?\d{2}(?![0-9])", re.I)),
]
_MONTHNUM = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_QEND = {6: 1, 9: 2, 12: 3, 3: 4}


def _as_at(label):
    """Quarter whose END a balance-sheet date names: 'Sep-25', '30 September 2025', '30.09.2025' -> 'Q2 FY26'. None otherwise."""
    t = label.lower()
    m = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", t)
    if m:
        mo, y = int(m.group(2)), int(m.group(3))
    else:
        m = re.search(r"([a-z]{3})[a-z]*\.?\s*(?:\d{1,2},?\s+)?[-'’ ]?\s*(\d{4}|\d{2})(?!\d)", t)
        if not m or m.group(1) not in _MONTHNUM:
            return None
        mo, y = _MONTHNUM[m.group(1)], int(m.group(2))
        y += 2000 if y < 100 else 0
    if mo not in _QEND:
        return None
    return f"Q{_QEND[mo]} FY{periods.fy_of(y, mo):02d}"


def find_periods(text):
    """[{label, period, kind, start, end}] in reading order, overlapping matches resolved in favour of the earlier,
    more specific pattern. kind: quarter | cumulative | year | as_at | trailing | unparsed."""
    taken, out = [], []
    for kind, rx in _PERIOD_PATTERNS:
        for m in rx.finditer(text or ""):
            s, e = m.span()
            if any(s < te and e > ts for ts, te in taken):
                continue
            label = " ".join(m.group(0).split())
            if kind == "trailing":
                rec = {"label": label, "period": None, "kind": "trailing"}
            elif kind == "as_at":
                p = _as_at(label)
                rec = {"label": label, "period": p, "kind": "as_at" if p else "unparsed"}
            else:
                n = periods.normalise(label)
                rec = {"label": label, "period": n["period"] if n else None, "kind": n["kind"] if n else "unparsed"}
            rec["start"], rec["end"] = s, e
            taken.append((s, e))
            out.append(rec)
    out.sort(key=lambda r: r["start"])
    return out


def mask_spans(text, spans, fill=" "):
    chars = list(text)
    for s, e in spans:
        for i in range(s, e):
            chars[i] = fill
    return "".join(chars)


# ---------------------------------------------------------------- units and numbers

_UNIT_WORDS = [
    ("crore", r"\bcrores?\b|\bcr\.?(?![a-z])|\bcrs\.?(?![a-z])"),
    ("lakh", r"\blakhs?\b|\blacs?\b"),
    ("million", r"\bmillions?\b|\bmn\.?(?![a-z])|\bmio\b"),
    ("billion", r"\bbillions?\b|\bbn\.?(?![a-z])"),
    ("thousand", r"\bthousands?\b|'000"),
]


def find_units(text):
    t = (text or "").lower()
    return [u for u, p in _UNIT_WORDS if re.search(p, t)]


_USD = re.compile(r"(?:us\s*\$|usd|\$)", re.I)
_NUM = re.compile(
    r"(?P<cur>(?<![A-Za-z])(?:US\s*\$|USD|\$|₹|Rs\.?|INR)\s*)?"
    r"(?P<num>\(\s*\d[\d,]*(?:\.\d+)?\s*\)|[-−]?\d[\d,]*(?:\.\d+)?)"
    r"(?P<suf>\s*(?:%|bps|bp|basis\s+points|x(?![a-z])|crores?|crs?\.?(?![a-z])|lakhs?|lacs?|mn\.?(?![a-z])|millions?|bn\.?(?![a-z])|billions?|k(?![a-z])))?",
    re.I)
_SUFFIX_UNIT = [(r"%", "percent"), (r"bps|bp|basis", "bps"), (r"x", "multiple"), (r"cr", "crore"), (r"la", "lakh"),
                (r"mn|mi", "million"), (r"bn|bi", "billion"), (r"k", "thousand")]


def find_numbers(text):
    """[{raw, value, suffix_unit, usd, start, end}]. A token that finlib cannot parse has value None (reported, not guessed)."""
    out = []
    for m in _NUM.finditer(text or ""):
        s = m.start("num")
        if s > 0 and (text[s - 1].isalpha() or text[s - 1] in "._/"):
            continue  # part of a word or code such as 'Q2', 'RF2.0', 'Tier1'
        raw = m.group("num")
        suf = (m.group("suf") or "").strip().lower()
        su = None
        for pat, u in _SUFFIX_UNIT:
            if suf and re.match(pat, suf):
                su = u
                break
        out.append({"raw": (m.group(0)).strip(), "value": numbers.parse_number(raw), "suffix_unit": su,
                    "usd": bool(m.group("cur") and _USD.search(m.group("cur"))), "start": m.start(), "end": m.end()})
    return out


_RANGE = re.compile(
    r"(?P<a>\d[\d,]*(?:\.\d+)?)\s*(?P<ua>%|bps|basis\s+points|x(?![a-z])|crores?|cr\.?(?![a-z]))?\s*(?:to|[-–—]|and)\s*"
    r"(?P<b>\d[\d,]*(?:\.\d+)?)\s*(?P<ub>%|percent|per\s+cent|bps|basis\s+points|x(?![a-z])|crores?|cr\.?(?![a-z])|branches|locations)", re.I)
_SINGLE = re.compile(r"(?P<a>\d[\d,]*(?:\.\d+)?)\s*(?P<ua>%|percent|per\s+cent|bps|basis\s+points|x(?![a-z])|crores?|cr\.?(?![a-z])|branches|locations)", re.I)


def _unit_of(word):
    w = (word or "").lower()
    if w.startswith("%") or w.startswith("per"): return "percent"
    if w.startswith("bps") or w.startswith("basis"): return "bps"
    if w.startswith("x"): return "multiple"
    if w.startswith("cr"): return "crore"
    if w.startswith("branch") or w.startswith("location"): return "count"
    return None


def parse_range(text):
    """Guided figures in a sentence -> {'low','high','unit','matches'}.
    Exactly one range or single figure -> low/high filled. None or more than one -> low/high None and 'matches' lists
    what was seen, so the caller reports 'several figures' instead of choosing one."""
    t = mask_spans(text or "", [(p["start"], p["end"]) for p in find_periods(text or "")])
    found, spans = [], []
    for m in _RANGE.finditer(t):
        ua, ub = _unit_of(m.group("ua")), _unit_of(m.group("ub"))
        if ua and ub and ua != ub:
            continue
        a, b = numbers.parse_number(m.group("a")), numbers.parse_number(m.group("b"))
        if a is None or b is None:
            continue
        found.append({"low": min(a, b), "high": max(a, b), "unit": ub, "text": m.group(0).strip()})
        spans.append(m.span())
    for m in _SINGLE.finditer(t):
        if any(m.start() < e and m.end() > s for s, e in spans):
            continue
        a = numbers.parse_number(m.group("a"))
        if a is None:
            continue
        found.append({"low": a, "high": a, "unit": _unit_of(m.group("ua")), "text": m.group(0).strip()})
    if len(found) == 1:
        f = found[0]
        return {"low": f["low"], "high": f["high"], "unit": f["unit"], "matches": [f["text"]]}
    return {"low": None, "high": None, "unit": None, "matches": [f["text"] for f in found]}


def norm_period(p):
    n = periods.normalise(p)
    return n["period"] if n else None


# ---------------------------------------------------------------- self-test

def _self_test():
    checks = []

    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond and detail is not None else {})})

    for t in MIRRORS:
        tbl = load_table(t)
        ok(f"table {t} loads with a version", isinstance(tbl, dict) and tbl.get("version") == 1)
    ok("skill mirrors of the tables have not drifted", mirror_drift() == [], mirror_drift())

    ok("phrase: hyphen/space variants", find_phrases("Our On Roll employees", ["on-roll employees"]) == ["on-roll employees"] and
       find_phrases("co-lending book", ["co-lending book"]) == ["co-lending book"])
    ok("phrase: word boundary", find_phrases("Overlap of sources", ["lap"]) == [] and find_phrases("LAP: 18%", ["lap"]) == ["lap"])
    ok("phrase: & equals and", find_phrases("Yields & Cost", ["yields and cost"]) == ["yields and cost"])
    ok("phrase: multi-space / newline", find_phrases("Assets under\n  Management", ["assets under management"]) == ["assets under management"])

    ps = find_periods("Q2 FY26 vs Q1FY26 and Q2'FY25; H1 FY26, 9MFY25, FY25, TTM; as on 30 September 2025; Mar-25; Sep'25")
    got = [(p["period"], p["kind"]) for p in ps]
    want = [("Q2 FY26", "quarter"), ("Q1 FY26", "quarter"), ("Q2 FY25", "quarter"), ("H1 FY26", "cumulative"), ("9M FY25", "cumulative"),
            ("FY25", "year"), (None, "trailing"), ("Q2 FY26", "as_at"), ("Q4 FY25", "as_at"), ("Q2 FY26", "as_at")]
    ok("periods: fiscal, cumulative, trailing, as-at dates", got == want, got)
    ps = find_periods("Quarter ended 30.09.2025 | Half year ended September 30, 2025 | FY2024-25")
    ok("periods: 'ended' forms", [p["period"] for p in ps] == ["Q2 FY26", "H1 FY26", "FY25"], [p["period"] for p in ps])
    ps = find_periods("H2 FY26 and Oct-25")
    ok("periods: H2 and a non-quarter-end month stay unparsed", [(p["period"], p["kind"]) for p in ps] == [(None, "unparsed"), (None, "unparsed")], ps)
    ok("periods: none in plain text", find_periods("Branches 215 Employees 3,410") == [])

    ok("units: several named", find_units("Rs crore (US$ mn)") == ["crore", "million"] and units.detect_unit("Rs crore (US$ mn)") is None)
    ok("units: 'Cr' and 'bn'", find_units("AUM ₹ 12,345 Cr") == ["crore"] and find_units("INR 123 bn") == ["billion"])
    ok("units: 'credit' is not crore, 'mnc' is not million", find_units("credit cost of mnc clients") == [])

    ns = find_numbers("AUM ₹ 12,345 Cr up 18.2% YoY; spread 310 bps; D/E 3.2x; (1,234.5); US$ 1.5 bn; Q2 FY26")
    got = [(n["value"], n["suffix_unit"], n["usd"]) for n in ns]
    want = [(12345.0, "crore", False), (18.2, "percent", False), (310.0, "bps", False), (3.2, "multiple", False), (-1234.5, None, False),
            (1.5, "billion", True)]
    ok("numbers: suffix units, brackets, USD; digits inside 'Q2 FY26' skipped", got == want, got)

    ns = find_numbers("Top lenders 61% and borrowers 12")
    ok("numbers: the 'rs' ending a word is not a currency mark", [n["raw"] for n in ns] == ["61%", "12"], [n["raw"] for n in ns])
    ok("range: '18% to 20%'", parse_range("AUM growth of 18% to 20% for FY26") == {"low": 18.0, "high": 20.0, "unit": "percent", "matches": ["18% to 20%"]},
       parse_range("AUM growth of 18% to 20% for FY26"))
    ok("range: '3.2-3.4%'", (lambda r: (r["low"], r["high"], r["unit"]))(parse_range("spreads in the 3.2-3.4% band")) == (3.2, 3.4, "percent"))
    ok("range: '30 to 40 bps'", (lambda r: (r["low"], r["high"], r["unit"]))(parse_range("credit cost of 30 to 40 basis points")) == (30.0, 40.0, "bps"))
    ok("range: single figure", (lambda r: (r["low"], r["high"], r["unit"]))(parse_range("around 25 branches this year")) == (25.0, 25.0, "count"))
    r = parse_range("growth of 20% with credit cost of 30 bps")
    ok("range: two figures -> not chosen", r["low"] is None and len(r["matches"]) == 2, r)
    ok("range: none", parse_range("we remain confident on growth")["matches"] == [])
    ok("range: period digits are not figures", parse_range("by Q4 FY26 we expect 20% growth")["low"] == 20.0)
    ok("norm_period", norm_period("Q2FY26") == "Q2 FY26" and norm_period("soon") is None)
    return checks


def main():
    ap = argparse.ArgumentParser(description="Shared helpers for the investor-presentations scripts. Only --self-test and --periods are runnable.")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 (all pass) or 1")
    ap.add_argument("--periods", metavar="TEXT", help="print the period tokens found in TEXT")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "iplib.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    if a.periods is not None:
        emit([{k: v for k, v in p.items() if k not in ("start", "end")} for p in find_periods(a.periods)])
        return
    ap.print_help(sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
