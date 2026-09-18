#!/usr/bin/env python3
"""Work out what each column of a results table is, from its header.

    python3 /workspace/scripts/parse_results_columns.py --input header.json [--filing-period "Q2 FY26"]
    echo '{"header_rows": [[...], [...], [...]]}' | python3 /workspace/scripts/parse_results_columns.py

Input (one of):
  {"header_rows": [[cell, ...], ...]}   the header rows as extracted cells, top row first; a header split over
                                        2-3 rows is normal. null/"" cells under a spanning cell are forward-filled
                                        from the left, but only in rows that hold span words (quarter / half year /
                                        nine months / year ended, standalone / consolidated).
  {"header_lines": ["...", "..."]}      the header as plain text lines, when no cell grid could be extracted. Dates
                                        are allotted to the span phrases only when exactly one allotment is valid.
Optional in either: "filing_period": "Q2 FY26".

Output per column: period, kind (quarter | cumulative | year), role (discrete_quarter, previous_quarter,
year_ago_quarter, cumulative_current, cumulative_year_ago, full_year_current, full_year_previous, other_period,
label, unparsed), discrete_quarter (true only for kind = quarter), audit_status, restated, basis.
status: ok | ambiguous | no_discrete_quarter_column. Ambiguity is reported with the reason, never resolved by picking.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, itertools, json, re
from finlib import periods

_SPAN = re.compile(r"quarter|months|half[- ]?year|year|period|stand-?\s?alone|consolidated", re.I)
_DATE_NUM = r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"
_DATE_DMY = r"\d{1,2}(?:st|nd|rd|th)?[\s-]+[A-Za-z]{3,9}[,\s-]+\d{2,4}"
_DATE_MDY = r"[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}"
_DATE = re.compile(f"{_DATE_NUM}|{_DATE_DMY}|{_DATE_MDY}")
_YTD = re.compile(r"year[- ]to[- ]date|\bytd\b|period ended|cumulative", re.I)
_KIND_PHRASE = re.compile(r"quarter\s+ended|(?:three|3)\s+months\s+ended|half[- ]?year\s+ended|(?:six|6)\s+months\s+ended|"
                          r"(?:nine|9)\s+months\s+ended|year[- ]to[- ]date[^0-9]{0,60}?ended|year\s+ended", re.I)
_MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()


def _fix_date(text):
    """'30-Sep-25' / '30 Sep 25' -> '30 Sep 2025' so finlib.periods can read it."""
    def rep(m):
        mon = m.group(2)[:3].lower()
        if mon not in _MONTHS: return m.group(0)
        y = int(m.group(3)); y += 2000 if y < 100 else 0
        return f"{m.group(1)} {m.group(2)} {y}"
    return re.sub(r"(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[,\s-]+(\d{2,4})(?!\d)", rep, text)


def read_period(label):
    """periods.normalise plus the 'year to date ... ended <date>' wording of the SEBI format."""
    t = _fix_date(" ".join(str(label or "").split()))
    if _YTD.search(t) and not re.search(r"quarter|months", t, re.I):
        d = _DATE.search(t)
        if d:
            for word in ("Quarter", "Half year", "Nine months", "Year"):
                p = periods.normalise(f"{word} ended {d.group(0)}")
                if p and (word != "Quarter" or p["quarter"] == 1):
                    if word == "Quarter":   # YTD through Q1 is the quarter itself, but it is labelled cumulative in the table
                        return dict(p, kind="cumulative", period=p["period"])
                    return p
            return None
    return periods.normalise(t)


def audit_status(text):
    t = text.lower()
    if re.search(r"un-?\s?audited", t): return "unaudited"
    if re.search(r"\baudited", t): return "audited"
    if re.search(r"\breviewed|limited review", t): return "reviewed"
    return None


def _basis(text):
    s, c = re.search(r"stand-?\s?alone", text, re.I), re.search(r"consolidated", text, re.I)
    return "conflict" if s and c else "standalone" if s else "consolidated" if c else None


def columns_from_rows(rows):
    width = max((len(r) for r in rows), default=0)
    grid = [[("" if c is None else " ".join(str(c).split())) for c in r] + [""] * (width - len(r)) for r in rows]
    for r in grid:
        if any(_SPAN.search(c) for c in r) and not all(_DATE.search(c) for c in r if c):
            last = ""
            for i, c in enumerate(r):
                if c: last = c if _SPAN.search(c) else ""
                elif last: r[i] = last
    return [" ".join(x for x in (grid[r][i] for r in range(len(grid))) if x) for i in range(width)]


def columns_from_lines(lines):
    """-> (headers, problems). Allots the dates to the span phrases; only a unique valid allotment is accepted."""
    text = _fix_date(" ".join(" ".join(lines).split()))
    kinds = [m.group(0) for m in _KIND_PHRASE.finditer(text)]
    dates = [m.group(0) for m in _DATE.finditer(text)]
    if not kinds or not dates:
        return [], [f"header_lines: found {len(kinds)} span phrases and {len(dates)} dates; cannot build columns"]
    if len(kinds) == len(dates):
        heads = [f"{k} {d}" for k, d in zip(kinds, dates)]
    elif len(kinds) > len(dates):
        return [], [f"header_lines: {len(kinds)} span phrases but only {len(dates)} dates"]
    else:
        n, m, valid = len(dates), len(kinds), []
        for cuts in itertools.combinations(range(1, n), m - 1):
            bounds = [0] + list(cuts) + [n]
            groups = [dates[bounds[i]:bounds[i + 1]] for i in range(m)]
            ok = all(len(set(g)) == len(g) and all(read_period(f"{kinds[i]} {d}") for d in g) for i, g in enumerate(groups))
            if ok: valid.append(groups)
        if len(valid) != 1:
            return [], [f"header_lines: {len(valid)} valid ways to allot {n} dates to {m} span phrases; give header_rows (cells) instead"]
        heads = [f"{kinds[i]} {d}" for i, g in enumerate(valid[0]) for d in g]
    marks = re.findall(r"\(?\s*(un-?\s?audited|audited|reviewed)\s*\)?", text, re.I)
    problems = []
    if len(marks) == len(heads): heads = [f"{h} ({mk})" for h, mk in zip(heads, marks)]
    elif marks: problems.append(f"header_lines: {len(marks)} audited/unaudited markers for {len(heads)} columns; audit_status left empty")
    if _basis(text): problems.append("header_lines: standalone/consolidated words present; basis per column cannot be read from lines, give header_rows")
    return heads, problems


def assign(headers, filing_period=None, extra_problems=None):
    cols, problems = [], list(extra_problems or [])
    for i, h in enumerate(headers):
        p = read_period(h)
        has_date = bool(_DATE.search(_fix_date(h)))
        c = {"index": i, "header": h, "basis": _basis(h), "period": p["period"] if p else None, "kind": p["kind"] if p else None,
             "role": None, "discrete_quarter": bool(p and p["kind"] == "quarter"), "audit_status": audit_status(h),
             "restated": bool(re.search(r"re-?\s?stated|recast|re-?\s?classified|revised", h, re.I)), "_p": p}
        if not p:
            c["role"] = "unparsed" if (has_date or _KIND_PHRASE.search(h)) else "label"
            if c["role"] == "unparsed": problems.append(f"column {i}: header {h!r} has a date or period word but does not parse to a fiscal period")
        if c["basis"] == "conflict":
            problems.append(f"column {i}: header names both standalone and consolidated"); c["basis"] = None
        cols.append(c)
    data = [c for c in cols if c["_p"]]
    source = "given"
    fp = periods.normalise(filing_period) if filing_period else None
    if filing_period and (not fp or fp["kind"] != "quarter"):
        problems.append(f"filing_period {filing_period!r} is not a quarter label such as 'Q2 FY26'"); fp = None
    if not fp:
        qs = [c["_p"] for c in data if c["_p"]["kind"] == "quarter"]
        if qs:
            fp = max(qs, key=lambda p: (p["fy"], p["quarter"])); source = "inferred_latest_quarter_column"
        elif data:
            latest = max((c["_p"] for c in data), key=lambda p: (p["fy"], p["quarter"]))
            fp = periods.normalise(f"Q{latest['quarter']} FY{latest['fy']:02d}"); source = "inferred_from_cumulative_columns"
    by_basis = {}
    if fp:
        q, fy = fp["quarter"], fp["fy"]
        prev = periods.normalise(periods.previous_quarter(fp["period"]))
        for c in data:
            p = c["_p"]
            if p["kind"] == "quarter":
                role = ("discrete_quarter" if (p["quarter"], p["fy"]) == (q, fy) else
                        "previous_quarter" if (p["quarter"], p["fy"]) == (prev["quarter"], prev["fy"]) else
                        "year_ago_quarter" if (p["quarter"], p["fy"]) == (q, (fy - 1) % 100) else "other_period")
            elif p["kind"] == "cumulative":
                role = ("cumulative_current" if (p["quarter"], p["fy"]) == (q, fy) else
                        "cumulative_year_ago" if (p["quarter"], p["fy"]) == (q, (fy - 1) % 100) else "other_period")
            else:
                role = "full_year_current" if p["fy"] == fy and q == 4 else "full_year_previous" if p["fy"] == (fy - 1) % 100 else "other_period"
            c["role"] = role
            if role == "other_period": problems.append(f"column {c['index']}: {p['period']} is not a period a {fp['period']} filing normally shows")
            by_basis.setdefault(c["basis"] or "unspecified", {}).setdefault(role, []).append(c["index"])
    status = "ok"
    for b, roles in by_basis.items():
        for role, idx in roles.items():
            if len(idx) > 1 and role != "other_period":
                status = "ambiguous"
                rest = [i for i in idx if cols[i]["restated"]]
                problems.append(f"basis {b}: columns {idx} both read as {role}" + (f"; column(s) {rest} are marked restated - report both, do not choose" if rest else
                                "; if the table puts standalone and consolidated side by side, include the row that says so in header_rows"))
    if any(c["role"] == "unparsed" for c in cols): status = "ambiguous"
    if not data:
        status = "ambiguous"; problems.append("no column header parsed to a fiscal period")
    elif status == "ok" and not any("discrete_quarter" in r for r in by_basis.values()):
        status = "no_discrete_quarter_column"
        problems.append("no column for the discrete quarter: the table gives only cumulative / full-year figures. Hand over the cumulative "
                        "columns flagged discrete_quarter = false; never relabel one as the quarter.")
    for c in cols: del c["_p"]
    flat = {b: {r: (i[0] if len(i) == 1 else i) for r, i in roles.items()} for b, roles in by_basis.items()}
    return {"status": status, "filing_period": fp["period"] if fp else None, "filing_period_source": source if fp else None,
            "columns": cols, "by_basis": flat, "problems": problems}


def parse(doc, filing_period=None):
    if not isinstance(doc, dict):
        raise ValueError("input must be a JSON object")
    filing_period = filing_period or doc.get("filing_period")
    rows, lines = doc.get("header_rows"), doc.get("header_lines")
    if rows is not None and not (isinstance(rows, list) and rows and all(isinstance(r, list) for r in rows)):
        raise ValueError("header_rows must be a non-empty list of rows, each a list of cells")
    if lines is not None and not (isinstance(lines, list) and all(isinstance(x, str) for x in lines)):
        raise ValueError("header_lines must be a list of strings")
    if doc.get("header_rows"):
        return assign(columns_from_rows(doc["header_rows"]), filing_period)
    if doc.get("header_lines"):
        heads, problems = columns_from_lines(doc["header_lines"])
        if not heads:
            return {"status": "ambiguous", "filing_period": None, "filing_period_source": None, "columns": [], "by_basis": {}, "problems": problems}
        return assign(heads, filing_period, problems)
    raise ValueError('input needs "header_rows" (list of cell rows) or "header_lines" (list of text lines)')


def _self_test():
    n = 0
    # 1 three-row header with spanning cells (the usual Q2 layout)
    r = parse({"header_rows": [
        ["Sr. No.", "Particulars", "Quarter ended", None, None, "Half year ended", None, "Year ended"],
        [None, None, "30.09.2025", "30.06.2025", "30.09.2024", "30.09.2025", "30.09.2024", "31.03.2025"],
        [None, None, "(Unaudited)", "(Unaudited)", "(Unaudited)", "(Unaudited)", "(Unaudited)", "(Audited)"]]})
    assert r["status"] == "ok" and r["filing_period"] == "Q2 FY26" and r["filing_period_source"] == "inferred_latest_quarter_column", r["problems"]
    assert r["by_basis"]["unspecified"] == {"discrete_quarter": 2, "previous_quarter": 3, "year_ago_quarter": 4, "cumulative_current": 5,
                                            "cumulative_year_ago": 6, "full_year_previous": 7}, r["by_basis"]; n += 2
    assert [c["role"] for c in r["columns"][:2]] == ["label", "label"] and r["columns"][7]["audit_status"] == "audited"; n += 1
    assert [c["discrete_quarter"] for c in r["columns"]] == [False, False, True, True, True, False, False, False]; n += 1   # a cumulative column is never the quarter
    # 2 SEBI-format wording, single header row, Q3
    r = parse({"header_rows": [["Particulars", "3 months ended 31/12/2025", "Preceding 3 months ended 30/09/2025",
                                "Corresponding 3 months ended in the previous year 31/12/2024", "Year to date figures for current period ended 31/12/2025",
                                "Year to date figures for the previous year ended 31/12/2024", "Previous year ended 31/03/2025"]]})
    assert r["status"] == "ok" and r["by_basis"]["unspecified"] == {"discrete_quarter": 1, "previous_quarter": 2, "year_ago_quarter": 3,
                                                                    "cumulative_current": 4, "cumulative_year_ago": 5, "full_year_previous": 6}, r; n += 1
    assert r["columns"][4]["period"] == "9M FY26" and r["columns"][4]["kind"] == "cumulative"; n += 1
    # 3 Q4 filing: quarter columns plus two year columns; month-name dates
    r = parse({"header_rows": [["Particulars", "Quarter ended", "", "", "Year ended", ""],
                               ["", "March 31, 2026", "December 31, 2025", "March 31, 2025", "March 31, 2026", "March 31, 2025"],
                               ["", "Audited (refer note 3)", "Unaudited", "Audited (refer note 3)", "Audited", "Audited"]]})
    assert r["by_basis"]["unspecified"] == {"discrete_quarter": 1, "previous_quarter": 2, "year_ago_quarter": 3, "full_year_current": 4, "full_year_previous": 5}, r; n += 1
    # 4 standalone and consolidated side by side: roles are resolved inside each basis
    r = parse({"header_rows": [["Particulars", "Standalone", None, None, "Consolidated", None, None],
                               ["", "Quarter ended", None, "Year ended", "Quarter ended", None, "Year ended"],
                               ["", "30-Jun-25", "30-Jun-24", "31-Mar-25", "30-Jun-25", "30-Jun-24", "31-Mar-25"]]})
    assert r["status"] == "ok" and r["by_basis"]["standalone"]["discrete_quarter"] == 1 and r["by_basis"]["consolidated"]["discrete_quarter"] == 4, r; n += 1
    assert "previous_quarter" not in r["by_basis"]["standalone"] and r["by_basis"]["standalone"]["year_ago_quarter"] == 2; n += 1
    # 5 same side-by-side table WITHOUT the basis row -> two discrete-quarter columns -> ambiguous, not picked
    r = parse({"header_rows": [["", "Quarter ended", None, "Quarter ended", None], ["", "30.06.2025", "30.06.2024", "30.06.2025", "30.06.2024"]]})
    assert r["status"] == "ambiguous" and r["by_basis"]["unspecified"]["discrete_quarter"] == [1, 3]; n += 1
    # 6 restated comparative beside the as-reported one
    r = parse({"header_rows": [["", "Quarter ended 30.09.2025", "Quarter ended 30.09.2024", "Quarter ended 30.09.2024 (Restated)"]]})
    assert r["status"] == "ambiguous" and r["columns"][3]["restated"] and any("restated" in p for p in r["problems"]); n += 1
    # 7 debt-listed half-yearly history: no discrete quarter at all
    r = parse({"header_rows": [["Particulars", "Half year ended", None, "Year ended"], ["", "30.09.2021", "30.09.2020", "31.03.2021"]]})
    assert r["status"] == "no_discrete_quarter_column" and r["filing_period"] == "Q2 FY22" and r["filing_period_source"] == "inferred_from_cumulative_columns"; n += 1
    assert not any(c["discrete_quarter"] for c in r["columns"]); n += 1
    # 8 a header that says 'Half year ended' over a June date does not parse -> reported
    r = parse({"header_rows": [["", "Half year ended 30.06.2025", "Quarter ended 30.06.2025"]]})
    assert r["status"] == "ambiguous" and r["columns"][1]["role"] == "unparsed"; n += 1
    # 9 text lines only: 6 dates over 3 span phrases has exactly one valid allotment
    r = parse({"header_lines": ["Particulars Quarter ended Half year ended Year ended",
                                "30.09.2025 30.06.2025 30.09.2024 30.09.2025 30.09.2024 31.03.2025",
                                "Unaudited Unaudited Unaudited Unaudited Unaudited Audited"]})
    assert r["status"] == "ok" and [c["role"] for c in r["columns"]] == ["discrete_quarter", "previous_quarter", "year_ago_quarter", "cumulative_current",
                                                                         "cumulative_year_ago", "full_year_previous"], r; n += 1
    assert r["columns"][5]["audit_status"] == "audited"; n += 1
    # 10 Q4 text lines: 'quarter ended' and 'year ended' both accept 31 March; a date may not repeat inside a span, which leaves one allotment
    r = parse({"header_lines": ["Quarter ended Year ended", "31.03.2026 31.12.2025 31.03.2025 31.03.2026 31.03.2025"]})
    assert r["status"] == "ok" and [c["role"] for c in r["columns"]] == ["discrete_quarter", "previous_quarter", "year_ago_quarter",
                                                                         "full_year_current", "full_year_previous"], r; n += 1
    # ... and a header where more than one allotment is valid is reported, not chosen
    r2 = parse({"header_lines": ["Quarter ended Year ended", "31.03.2026 31.03.2025 31.03.2024"]})
    assert r2["status"] == "ambiguous" and "valid ways" in r2["problems"][0], r2; n += 1
    # 11 the given filing period wins over inference and flags a stale column
    r = parse({"header_rows": [["", "Quarter ended 30.06.2025", "Quarter ended 31.03.2025"]]}, "Q2 FY26")
    assert r["filing_period_source"] == "given" and r["status"] == "no_discrete_quarter_column" and r["columns"][1]["role"] == "previous_quarter"; n += 1
    for junk in ([], {"header_rows": 5}, {"header_rows": ["Quarter ended"]}, {"header_lines": "Quarter ended"}, {}):
        try: parse(junk)
        except ValueError: n += 1
        else: raise AssertionError(f"accepted {junk!r}")
    assert read_period("Year to date figures for current period ended 30.09.2025")["period"] == "H1 FY26" and read_period("Particulars") is None; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Identify discrete-quarter, previous-quarter, year-ago, cumulative and full-year columns from a results table header.")
    ap.add_argument("--input", help="JSON file with header_rows or header_lines; default stdin")
    ap.add_argument("--filing-period", help="e.g. 'Q2 FY26' (from the results heading); inferred from the columns when absent")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL parse_results_columns: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "parse_results_columns", "cases": n})); return 0
    try:
        raw = open(a.input, encoding="utf-8").read() if a.input else sys.stdin.read()
        out = parse(json.loads(raw), a.filing_period)
    except (OSError, ValueError) as x:
        print(f"bad input: {x}", file=sys.stderr); return 2
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
