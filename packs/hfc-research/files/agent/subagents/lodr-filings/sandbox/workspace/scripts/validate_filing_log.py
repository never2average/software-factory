#!/usr/bin/env python3
"""Validate filing-log.jsonl rows BEFORE they are appended to the data room.

    python3 /workspace/scripts/validate_filing_log.py /workspace/out/new-rows.jsonl [--existing /workspace/in/filing-log.jsonl]

Checks each row against schemas/filing-log-row.schema.json and the rules a schema cannot express:
- filed_on is a real date, not in the future, not before 2015; logged_at is not before filed_on
- path is the canonical pattern (Companies/, or the stored folder name older rows carry), and the company id, date and tag inside
  it agree with the row
- period parses with finlib.periods; it is required (with basis) for reg33_results / reg52_results, and for those
  the short name in the path starts with the period slug
- source_url is present for every fetched file (source bse / nse / company_ir / parent_company); a row with no
  source must not claim a URL-less fetch: source is required when source_url is absent (data_room)
- a .md capture must have a source_url (the text was taken from somewhere)
- duplicates: the same path twice, or the same (filed_on, tag, period, normalised title) under two paths, inside the
  file or against --existing. A duplicate is an error: the document is already filed.
- summary is at most two sentences
Exit 0 when valid, 1 when not. JSON report on stdout either way.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, datetime, json, re, tempfile
from finlib import periods, schema
import filing_name

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "..", "schemas", "filing-log-row.schema.json")
FETCHED = ("bse", "nse", "company_ir", "parent_company")


def _norm_title(t):
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def _sentences(text):
    t = re.sub(r"(\d)\.(\d)", r"\1_\2", text or "")                       # 12.5 is not a sentence end
    t = re.sub(r"\b(Rs|No|Reg|Ltd|Pvt|Cr|St|vs|approx|i\.e|e\.g)\.", r"\1_", t, flags=re.I)
    return len([s for s in re.split(r"[.!?]+(?:\s+|$)", t) if s.strip()])


def check_row(o, today):
    e = []
    try:
        d = filing_name.parse_date(o.get("filed_on"), today)
    except ValueError as x:
        e.append(str(x)); d = None
    parts = filing_name.parse_path(o.get("path") or "")
    if isinstance(o.get("path"), str) and not parts:
        e.append(f"path {o['path']!r} is not canonical: Companies/{{company_id}}/filings/lodr/{{YYYY-MM-DD}}_{{tag}}_{{short-name}}.{{ext}} (build it with filing_name.py)")
    if parts:
        for k, pk in ((filing_name.ROW_KEY, "company_id"), ("filed_on", "filed_on"), ("tag", "tag")):
            if o.get(k) is not None and parts[pk] != o.get(k):
                e.append(f"path says {pk} = {parts[pk]!r} but the row says {k} = {o.get(k)!r}")
    per = o.get("period")
    if per:
        p = periods.normalise(per)
        if not p:
            e.append(f"period {per!r} does not parse")
        elif p["period"] != per:
            e.append(f"period {per!r} is not in canonical form; write {p['period']!r}")
        elif parts and o.get("tag") in filing_name.RESULTS_TAGS and not parts["short_name"].startswith(filing_name.period_slug(per)):
            e.append(f"results path short name {parts['short_name']!r} does not start with the period slug {filing_name.period_slug(per)!r}")
        if p and d and p["kind"] == "quarter":
            # a quarter's results cannot be filed before the quarter has ended
            end_month = {1: 6, 2: 9, 3: 12, 4: 3}[p["quarter"]]
            end_year = 2000 + p["fy"] - (0 if p["quarter"] == 4 else 1)
            if (d.year, d.month) <= (end_year, end_month) and o.get("tag") in filing_name.RESULTS_TAGS:
                e.append(f"filed_on {o['filed_on']} is not after the end of {per}; results cannot be filed before the period ends")
    if o.get("source") in FETCHED and not o.get("source_url"):
        e.append(f"source is {o['source']!r} (a fetched file) but source_url is missing")
    if not o.get("source_url") and not o.get("source"):
        e.append("no source_url and no source: say where the file came from (source = data_room when it was already there)")
    if parts and parts["ext"] == "md" and not o.get("source_url"):
        e.append("a .md text capture must carry the source_url it was taken from")
    if isinstance(o.get("summary"), str) and _sentences(o["summary"]) > 2:
        e.append(f"summary has {_sentences(o['summary'])} sentences; two at most")
    la = o.get("logged_at")
    if isinstance(la, str) and d and la[:10] < o["filed_on"]:
        e.append(f"logged_at {la} is before filed_on {o['filed_on']}")
    if isinstance(la, str) and la[:10] > today.isoformat():
        e.append(f"logged_at {la} is in the future")
    if o.get("tag") in (o.get("also_covers") or []):
        e.append("also_covers repeats the row's own tag")
    return e


def validate(path, existing=None, today=None):
    today = today or datetime.date.today()
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        sch = json.load(f)
    rows, errors = schema.validate_jsonl(path, sch)
    warnings, seen_path, seen_doc = [], {}, {}
    if existing:
        old, old_problems = schema.read_jsonl(existing)
        warnings += [f"existing log {p}" for p in old_problems]
        for n, o in old:
            seen_path.setdefault(o.get("path"), f"existing line {n}")
            seen_doc.setdefault((o.get(schema.ROW_KEY), o.get("filed_on"), o.get("tag"), o.get("period"), _norm_title(o.get("title"))), f"existing line {n}")
    for n, o in rows:
        errors += [f"line {n}: {m}" for m in check_row(o, today)]
        key = (o.get(schema.ROW_KEY), o.get("filed_on"), o.get("tag"), o.get("period"), _norm_title(o.get("title")))
        if o.get("path") in seen_path:
            errors.append(f"line {n}: duplicate path, already at {seen_path[o.get('path')]}: {o.get('path')}")
        elif key in seen_doc:
            errors.append(f"line {n}: same filing (date, tag, period, title) already logged at {seen_doc[key]} under another path")
        seen_path.setdefault(o.get("path"), f"line {n}"); seen_doc.setdefault(key, f"line {n}")
    if not rows and not errors:
        errors.append("no rows")
    return {"file": path, "rows": len(rows), "valid": not errors, "errors": errors, "warnings": warnings}


def _self_test():
    today = datetime.date(2026, 9, 18); n = 0
    good = {schema.ROW_KEY: "example-housing-finance", "filed_on": "2025-10-24", "tag": "reg33_results", "period": "Q2 FY26", "basis": "both",
            "title": "Outcome of Board Meeting - Unaudited Financial Results for the quarter ended September 30, 2025",
            "path": "Companies/example-housing-finance/filings/lodr/2025-10-24_reg33_results_q2-fy26-outcome-board-meeting-unaudited-financial-results.pdf",
            "source_url": "https://www.example-exchange.invalid/announcements/abc.pdf", "source": "bse", "also_covers": ["reg30_event", "reg52_results"], "content": "mixed",
            "summary": "Standalone and consolidated results for Q2 FY26 with limited review reports. Reg 52(4) ratios appended at p.11.", "logged_at": "2025-10-25T04:30:00Z"}
    event = {schema.ROW_KEY: "example-housing-finance", "filed_on": "2026-05-02", "tag": "reg30_event", "title": "Credit rating reaffirmed",
             "path": "Companies/example-housing-finance/filings/lodr/2026-05-02_reg30_event_credit-rating-reaffirmed.md", "source_url": "https://www.example-exchange.invalid/x",
             "source": "nse", "summary": "Rating reaffirmed at the same level with a stable outlook.", "logged_at": "2026-05-03T10:00:00+05:30"}
    d = tempfile.mkdtemp()

    def run(rows, existing=None):
        p = os.path.join(d, "new.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            f.write("\n".join(r if isinstance(r, str) else json.dumps(r) for r in rows) + "\n")
        ex = None
        if existing:
            ex = os.path.join(d, "old.jsonl")
            with open(ex, "w", encoding="utf-8") as f:
                f.write("\n".join(json.dumps(r) for r in existing) + "\n")
        return validate(p, ex, today)
    r = run([good, event]); assert r["valid"] and r["rows"] == 2, r["errors"]; n += 1
    # an older row filed under the stored folder name is still canonical
    r = run([{**good, "path": filing_name.FOLDERS[1] + good["path"][len(filing_name.FOLDERS[0]):]}]); assert r["valid"], r["errors"]; n += 1

    def bad(change, expect, base=good, drop=()):
        row = {k: v for k, v in {**base, **change}.items() if k not in drop}
        r = run([row]); assert not r["valid"] and any(expect in x for x in r["errors"]), (expect, r["errors"]); return 1
    n += bad({"filed_on": "2025-02-30"}, "not a real calendar date")
    n += bad({"filed_on": "2027-01-01"}, "in the future")
    n += bad({"tag": "reg33"}, "is not one of")
    n += bad({"tag": "reg52_results"}, "path says tag = 'reg33_results'")
    n += bad({"filed_on": "2025-10-25"}, "path says filed_on")
    n += bad({schema.ROW_KEY: "another-hfc"}, "path says company_id")
    # rows stored under the key's older name: read as the new key; both keys disagreeing is an error
    OLD = schema.LEGACY_ROW_KEYS[0]
    old_row = {(OLD if k == schema.ROW_KEY else k): v for k, v in good.items()}
    r = run([old_row]); assert r["valid"], r["errors"]; n += 1
    r = run([old_row], existing=[good]); assert any("duplicate path" in x for x in r["errors"]), r["errors"]; n += 1
    second_path = {**good, "path": good["path"].replace("outcome-board-meeting-unaudited-financial-results", "results")}
    r = run([second_path], existing=[old_row])
    assert any("same filing" in x for x in r["errors"]), r["errors"]; n += 1
    r = run([{**good, OLD: good[schema.ROW_KEY]}]); assert r["valid"], r["errors"]; n += 1
    r = run([{**good, OLD: "another-hfc"}]); assert not r["valid"] and any("disagree" in x for x in r["errors"]), r["errors"]; n += 1
    r = run([{**old_row, OLD: "another-hfc"}]); assert not r["valid"] and any("path says company_id" in x for x in r["errors"]), r["errors"]; n += 1
    n += bad({"path": "Companies/example-housing-finance/filings/lodr/results q2.pdf"}, "does not match")
    n += bad({}, "missing required 'period'", drop=("period",))
    n += bad({}, "missing required 'basis'", drop=("basis",))
    n += bad({"period": "Q2FY26"}, "does not match")                       # schema pattern: canonical form only
    n += bad({"period": "Q3 FY26"}, "does not start with the period slug")
    n += bad({"filed_on": "2025-09-15", "path": good["path"].replace("2025-10-24", "2025-09-15")}, "results cannot be filed before the period ends")
    n += bad({}, "source_url is missing", drop=("source_url",))
    n += bad({"source_url": "www.example.invalid/x"}, "does not match")
    n += bad({}, "say where the file came from", base=event, drop=("source_url", "source"))
    n += bad({"source": "data_room"}, ".md text capture must carry the source_url", base=event, drop=("source_url",))
    n += bad({"summary": "One. Two. Three."}, "two at most")
    n += bad({"logged_at": "2025-10-01T00:00:00Z"}, "before filed_on")
    n += bad({"also_covers": ["reg33_results"]}, "repeats the row's own tag")
    n += bad({"verdict": "positive"}, "unexpected field 'verdict'")
    # a summary with decimals and 'Rs.' is still two sentences
    r = run([{**good, "summary": "PAT of Rs. 131.0 crore for the quarter. GNPA 1.10% per Reg. 52(4) annexure."}]); assert r["valid"], r["errors"]; n += 1
    # duplicates: inside the file, against the existing log, and the same document under a second path
    r = run([good, good]); assert any("duplicate path" in x for x in r["errors"]); n += 1
    r = run([good], existing=[good]); assert any("duplicate path, already at existing line 1" in x for x in r["errors"]); n += 1
    again = {**good, "path": good["path"].replace("outcome-board-meeting-unaudited-financial-results", "results")}
    r = run([again], existing=[good]); assert any("same filing" in x for x in r["errors"]); n += 1
    # a data-room file that was only read needs no URL
    r = run([{k: v for k, v in {**good, "source": "data_room"}.items() if k != "source_url"}]); assert r["valid"], r["errors"]; n += 1
    # broken JSON line and empty file are reported, not crashed on
    r = run(["{not json"]); assert not r["valid"] and "not JSON" in r["errors"][0]; n += 1
    r = run([""]); assert not r["valid"] and r["errors"] == ["no rows"]; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Validate filing-log.jsonl rows (schema + domain rules + duplicates) before appending them.")
    ap.add_argument("file", nargs="?", help="JSONL with the rows to append (or a whole filing-log.jsonl)")
    ap.add_argument("--existing", help="the current filing-log.jsonl fetched from the data room, to catch re-filing")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD)"); ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL validate_filing_log: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "validate_filing_log", "cases": n})); return 0
    if not a.file or not os.path.isfile(a.file):
        print(f"no such file: {a.file}", file=sys.stderr); return 2
    if a.existing and not os.path.isfile(a.existing):
        print(f"no such file: {a.existing}", file=sys.stderr); return 2
    try:
        today = datetime.date.fromisoformat(a.today) if a.today else None
    except ValueError:
        print(f"--today {a.today!r} is not YYYY-MM-DD", file=sys.stderr); return 2
    rep = validate(a.file, a.existing, today)
    print(json.dumps(rep, ensure_ascii=False))
    if not rep["valid"]:
        print(f"filing log INVALID: {len(rep['errors'])} problem(s); nothing may be appended until they are fixed", file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
