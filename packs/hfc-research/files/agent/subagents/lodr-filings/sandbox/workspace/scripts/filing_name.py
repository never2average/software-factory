#!/usr/bin/env python3
"""Canonical data-room path for a LODR filing, and the reverse (parse a path back into its parts).

    Companies/{company_id}/filings/lodr/{YYYY-MM-DD}_{tag}_{short-name}.{ext}

Built paths start with Companies/ (the folder the agent's tools show); parse_path also accepts the stored
folder name, which older log rows carry.
The row key is finlib.schema.ROW_KEY (primary_context_entity): the company's company_id.

The tag contains underscores and the short name contains only [a-z0-9-], so a path parses back unambiguously.
This module is also imported by validate_filing_log.py and classify_filing.py (TAGS is the single tag list).
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, datetime, json, re, unicodedata
from finlib import periods, schema

TAGS = ["reg33_results", "reg52_results", "reg30_event", "reg51_event", "reg31_shareholding", "reg23_rpt",
        "reg32_deviation", "reg54_security_cover", "reg55_rating", "reg57_payment", "reg27_cg",
        "reg24a_secretarial", "reg29_notice", "reg34_annual_report", "other"]
RESULTS_TAGS = ("reg33_results", "reg52_results")
EXTS = ["pdf", "md", "xml", "xlsx", "html"]
MAX_SLUG = 60
EARLIEST = datetime.date(2015, 1, 1)   # nothing filed under the 2015 Regulations can be dated before 2015

# Words that carry no information in a short name: every filing is "pursuant to regulation N of SEBI LODR".
STOPWORDS = {"a", "an", "the", "of", "for", "and", "to", "in", "on", "under", "with", "by", "pursuant", "regulation",
             "regulations", "reg", "sebi", "lodr", "listing", "obligations", "disclosure", "disclosures", "requirements",
             "2015", "read", "sub", "subject", "ref", "reference", "dear", "sir", "madam", "intimation", "submission"}

ROW_KEY = schema.ROW_KEY
FOLDERS = schema.COMPANY_FOLDERS
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
PATH_RE = re.compile(
    r"^(?P<folder>" + "|".join(FOLDERS) + r")/(?P<company_id>[a-z0-9][a-z0-9_-]*)/filings/lodr/"
    r"(?P<filed_on>\d{4}-\d{2}-\d{2})_(?P<tag>" + "|".join(TAGS) + r")_(?P<short_name>[a-z0-9]+(?:-[a-z0-9]+)*)"
    r"\.(?P<ext>" + "|".join(EXTS) + r")$")


def parse_date(text, today=None):
    """'2025-10-24' -> date. Raises ValueError with a plain reason: wrong format, impossible date, in the future,
    or before the Regulations existed."""
    if not isinstance(text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise ValueError(f"filed_on {text!r} is not YYYY-MM-DD")
    try:
        d = datetime.date.fromisoformat(text)
    except ValueError:
        raise ValueError(f"filed_on {text!r} is not a real calendar date")
    today = today or datetime.date.today()
    if d > today:
        raise ValueError(f"filed_on {text} is in the future (today is {today.isoformat()})")
    if d < EARLIEST:
        raise ValueError(f"filed_on {text} is before {EARLIEST.isoformat()}; the LODR Regulations are from 2015")
    return d


def slugify(title, max_len=MAX_SLUG):
    """Lower-case ASCII words joined by '-', stopwords dropped, cut at a word boundary to max_len.
    Returns '' when nothing usable is left (the caller rejects that; it is never replaced by a made-up name)."""
    t = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode("ascii").lower()
    t = t.replace("&", " and ")
    # "Regulation 30", "Reg. 52(4)", "Regulations 30 and 33": the numbers live in the tag, not in the short name
    t = re.sub(r"\breg(?:ulation)?s?\.?\s*\d{1,3}[a-z]?(?:\s*\(\w{1,3}\))*(?:\s*(?:,|and|&|/|read with)\s*\d{1,3}[a-z]?(?:\s*\(\w{1,3}\))*)*", " ", t)
    words = [w for w in re.split(r"[^a-z0-9]+", t) if w]
    kept = [w for w in words if w not in STOPWORDS] or []
    out = ""
    for w in kept:
        nxt = w if not out else out + "-" + w
        if len(nxt) > max_len:
            break
        out = nxt
    return out


def period_slug(period):
    """'Q2 FY26' -> 'q2-fy26' ; 'H1 FY26' -> 'h1-fy26' ; 'FY26' -> 'fy26'. ValueError when it does not parse."""
    p = periods.normalise(period)
    if not p:
        raise ValueError(f"period {period!r} does not parse (expected e.g. 'Q2 FY26', 'H1 FY26', 'FY26')")
    return p["period"].lower().replace(" ", "-")


def build(company_id, filed_on, tag, title, ext, period=None, today=None):
    """-> dict(path, file_name, short_name, ...). Raises ValueError listing every problem."""
    problems = []
    if not isinstance(company_id, str) or not SLUG_RE.match(company_id or ""):
        problems.append(f"company_id {company_id!r} is not a slug ([a-z0-9][a-z0-9_-]*)")
    try:
        parse_date(filed_on, today)
    except ValueError as x:
        problems.append(str(x))
    if tag not in TAGS:
        problems.append(f"tag {tag!r} is not one of {TAGS}")
    ext = (ext or "").lower().lstrip(".")
    if ext not in EXTS:
        problems.append(f"ext {ext!r} is not one of {EXTS}")
    pslug = ""
    if period:
        try:
            pslug = period_slug(period)
        except ValueError as x:
            problems.append(str(x))
    elif tag in RESULTS_TAGS:
        problems.append(f"period is required for {tag} (the short name starts with it, e.g. q2-fy26-...)")
    slug = slugify(title)
    if pslug:
        # do not repeat the period when the title already says it ("Q2 FY26 results")
        rest = [w for w in slug.split("-") if w and w not in pslug.split("-")]
        slug = slugify(" ".join([pslug.replace("-", " ")] + rest)) if rest else pslug
        if not slug.startswith(pslug):
            slug = pslug
    if not slug:
        problems.append(f"title {title!r} leaves no usable words for the short name")
    if problems:
        raise ValueError("; ".join(problems))
    file_name = f"{filed_on}_{tag}_{slug}.{ext}"
    return {"path": f"{FOLDERS[0]}/{company_id}/filings/lodr/{file_name}", "file_name": file_name,
            ROW_KEY: company_id, "filed_on": filed_on, "tag": tag, "short_name": slug, "ext": ext}


def parse_path(path):
    """-> dict of the parts, or None when the path is not canonical."""
    m = PATH_RE.match(path or "")
    return m.groupdict() if m else None


def _self_test():
    today = datetime.date(2026, 9, 18)
    n = 0
    r = build("example-housing-finance", "2025-10-24", "reg33_results",
              "Outcome of Board Meeting - Unaudited Financial Results for the quarter ended September 30, 2025",
              "pdf", period="Q2 FY26", today=today)
    assert r["path"] == ("Companies/example-housing-finance/filings/lodr/"
                         "2025-10-24_reg33_results_q2-fy26-outcome-board-meeting-unaudited-financial-results.pdf"), r["path"]
    assert parse_path(r["path"])["tag"] == "reg33_results" and parse_path(r["path"])["filed_on"] == "2025-10-24"; n += 2
    # the period is not repeated when the title already carries it
    r = build("example-housing-finance", "2025-10-24", "reg33_results", "Q2 FY26 results", "PDF", period="Q2FY26", today=today)
    assert r["file_name"] == "2025-10-24_reg33_results_q2-fy26-results.pdf", r; n += 1
    # stopwords, punctuation, non-ASCII, ampersand
    assert slugify("Intimation under Regulation 30 of SEBI (LODR) Regulations, 2015 – Credit Rating Upgrade") == "credit-rating-upgrade"
    assert slugify("Change in KMP & Auditor’s résumé") == "change-kmp-auditors-resume"; n += 2
    # cut at a word boundary, never mid-word
    s = slugify("alpha " * 30)
    assert len(s) <= MAX_SLUG and not s.endswith("-") and set(s.split("-")) == {"alpha"}; n += 1
    # text-only capture is a .md
    r = build("example-hfc", "2026-05-02", "reg30_event", "Credit rating reaffirmed", "md", today=today)
    assert r["path"].endswith("2026-05-02_reg30_event_credit-rating-reaffirmed.md"); n += 1
    bad = [
        dict(filed_on="2025-02-30", tag="reg30_event", title="x y", ext="pdf"),          # impossible date
        dict(filed_on="24-10-2025", tag="reg30_event", title="rating", ext="pdf"),       # wrong format
        dict(filed_on="2026-12-01", tag="reg30_event", title="rating", ext="pdf"),       # future
        dict(filed_on="2009-05-01", tag="reg30_event", title="rating", ext="pdf"),       # before the Regulations
        dict(filed_on="2025-10-24", tag="reg33", title="results", ext="pdf"),            # unknown tag
        dict(filed_on="2025-10-24", tag="reg30_event", title="rating", ext="docx"),      # unknown ext
        dict(filed_on="2025-10-24", tag="reg30_event", title="Regulation 30 of SEBI LODR", ext="pdf"),  # only stopwords
        dict(filed_on="2025-10-24", tag="reg33_results", title="results", ext="pdf"),    # results need a period
        dict(filed_on="2025-10-24", tag="reg33_results", title="results", ext="pdf", period="H2 FY26"),  # unparseable period
    ]
    for kw in bad:
        try:
            build("example-hfc", today=today, **kw)
        except ValueError:
            n += 1
        else:
            raise AssertionError(f"accepted {kw}")
    try:
        build("Example HFC", "2025-10-24", "reg30_event", "rating", "pdf", today=today)
    except ValueError:
        n += 1
    else:
        raise AssertionError("accepted a company_id that is not a slug")
    assert parse_path("Companies/example-hfc/filings/lodr/results.pdf") is None
    assert parse_path("Companies/example-hfc/filings/lodr/2025-10-24_reg33_results_Q2.pdf") is None; n += 2
    # a stored-folder path from an older log row parses to the same parts
    old = parse_path(FOLDERS[1] + r["path"][len(FOLDERS[0]):])
    assert old and old["company_id"] == "example-hfc" and old["folder"] == FOLDERS[1]; n += 1
    assert parse_path("Other/example-hfc/filings/lodr/2026-05-02_reg30_event_x.md") is None; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Build (or parse) the canonical data-room path of a LODR filing.")
    ap.add_argument("--company-id", dest="company_id", help="the company's id")
    ap.add_argument("--customer-id", dest="company_id", help=argparse.SUPPRESS)   # older name of --company-id, still accepted
    ap.add_argument("--filed-on", help="exchange timestamp date, YYYY-MM-DD")
    ap.add_argument("--tag", help="one of: " + ", ".join(TAGS)); ap.add_argument("--title", help="the filing's subject line")
    ap.add_argument("--ext", help="one of: " + ", ".join(EXTS))
    ap.add_argument("--period", help="e.g. 'Q2 FY26'; required for results tags, becomes the start of the short name")
    ap.add_argument("--parse", metavar="PATH", help="parse a data-room path back into its parts instead of building one")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD); for tests")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL filing_name: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "filing_name", "cases": n})); return 0
    if a.parse:
        parts = parse_path(a.parse)
        if not parts:
            print(f"not a canonical LODR filing path: {a.parse}", file=sys.stderr); return 2
        print(json.dumps(parts)); return 0
    missing = [k for k in ("company_id", "filed_on", "tag", "title", "ext") if not getattr(a, k)]
    if missing:
        print("missing: " + ", ".join("--" + m.replace("_", "-") for m in missing), file=sys.stderr); return 2
    try:
        today = datetime.date.fromisoformat(a.today) if a.today else None
        print(json.dumps(build(a.company_id, a.filed_on, a.tag, a.title, a.ext, a.period, today)))
    except ValueError as x:
        print(str(x), file=sys.stderr); return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
