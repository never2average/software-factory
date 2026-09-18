#!/usr/bin/env python3
"""Turn the extracted rows of a results table into normalised line items in Rs crore, each with its page.

    python3 /workspace/scripts/extract_results_lines.py --input table.json > extract.json

Input JSON:
  {
    "customer_id": "example-housing-finance", "source_path": "Customers/.../filings/lodr/....pdf",
    "tag": "reg33_results", "filing_period": "Q2 FY26",
    "basis": "standalone", "bases_in_filing": "both",
    "unit": "lakh",                      the unit read from THIS table's header (locate_results_sections.py)
    "page": 4,                           page of the table; a row may carry its own: {"page": 5, "cells": [...]}
    "columns": [...],                    the "columns" array from parse_results_columns.py (all columns of the table)
    "rows": [["1", "Interest income", "12,345.67", ...], ...]      body rows as extracted, same width as the header
  }
When the table puts standalone and consolidated side by side, only the columns whose basis equals "basis" are taken.

Output: {"extract": <document for results-extract.schema.json, without disclosures>, "unmatched_rows": [...],
"misaligned_rows": [...], "excluded_rows": [...], "problems": [...]}. Add the notes disclosures to extract.disclosures,
then run validate_results_extract.py on it.

Never guesses: a label that matches no synonym is listed under unmatched_rows; a cell that is not a number is kept as
raw with status "unparseable"; a row whose width differs from the header is not read at all (its values could be
shifted into the wrong period); an item matched by two rows is kept twice and flagged duplicate.
Values are parsed with finlib.numbers and converted with finlib.units. Per-share rows (EPS) are not converted.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, datetime, json, re
from finlib import numbers, units

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(HERE, "reference", "results_line_synonyms.json")
_SERIAL_CELL = re.compile(r"^\(?\s*(\d{1,2}|[ivxlIVXL]{1,5}|[a-zA-Z])\s*\)?[.)]?$")
_SERIAL_PREFIX = re.compile(r"^\(?\s*(\d{1,2}|[ivxIVX]{1,4}|[a-zA-Z])\s*[.)]\s+|^\(\s*(\d{1,2}|[ivxIVX]{1,4}|[a-zA-Z])\s*\)\s*")
DATA_ROLES = {"discrete_quarter", "previous_quarter", "year_ago_quarter", "cumulative_current", "cumulative_year_ago",
              "full_year_current", "full_year_previous", "other_period"}


def load_table(path=TABLE_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean_label(cells):
    parts = [" ".join(str(c).split()) for c in cells if c is not None and str(c).strip()]
    parts = [p for p in parts if not _SERIAL_CELL.match(p)]
    label = " ".join(parts)
    label = _SERIAL_PREFIX.sub("", label).strip()
    return label.replace("’", "'")


def match_item(label, context, table):
    """-> synonym entry or None. Own label first; then '<context> > <label>' for entries that define context_regex."""
    low = label.lower()
    for e in table["items"]:
        if re.search(e["regex"], low, re.I) and not (e.get("exclude") and re.search(e["exclude"], low, re.I)):
            return e
    if context:
        joined = f"{context.lower()} > {low}"
        for e in table["items"]:
            if e.get("context_regex") and re.search(e["context_regex"], joined, re.I):
                return e
    return None


def extract(doc, table=None, now=None):
    table = table or load_table()
    problems = []
    if not isinstance(doc, dict):
        raise ValueError("input must be a JSON object")
    if not isinstance(doc.get("rows"), list) or not isinstance(doc.get("columns"), list) or not all(isinstance(c, dict) and "index" in c for c in doc["columns"]):
        raise ValueError("rows must be a list and columns must be the 'columns' array from parse_results_columns.py (columns is empty or malformed)")
    unit = doc.get("unit")
    if unit not in units.FACTOR_TO_CRORE:
        raise ValueError(f"unit {unit!r} is missing or unknown; read it from the table header (expected one of {sorted(units.FACTOR_TO_CRORE)})")
    basis = doc.get("basis")
    if basis not in ("standalone", "consolidated"):
        raise ValueError("basis must be 'standalone' or 'consolidated'")
    all_cols = doc.get("columns") or []
    if not all_cols:
        raise ValueError("columns is empty; run parse_results_columns.py on the header first")
    if any(c.get("role") == "unparsed" for c in all_cols):
        raise ValueError("a column header is unparsed; resolve it (parse_results_columns.py reported it) before extracting values")
    width = len(all_cols)
    data_cols = [c for c in all_cols if c.get("role") in DATA_ROLES and (c.get("basis") in (None, basis))]
    if not data_cols:
        raise ValueError(f"no data columns for basis {basis!r}")
    seen_periods = {}
    for c in data_cols:
        if c["period"] in seen_periods:
            raise ValueError(f"columns {seen_periods[c['period']]} and {c['index']} both carry {c['period']} for basis {basis}; "
                             "resolve it (restated vs as reported) and pass only the column to use")
        seen_periods[c["period"]] = c["index"]
    label_idx = [c["index"] for c in all_cols if c.get("role") == "label"]
    if not label_idx:
        raise ValueError("no label column (role 'label') in columns")
    items, unmatched, misaligned, excluded, context, seen = [], [], [], [], "", {}
    for rn, row in enumerate(doc.get("rows") or []):
        page = doc.get("page")
        if isinstance(row, dict):
            page, row = row.get("page", page), row.get("cells") or []
        if len(row) != width:
            misaligned.append({"row": rn, "cells": len(row), "expected": width, "first_cell": str(row[0])[:60] if row else ""}); continue
        label = clean_label([row[i] for i in label_idx])
        cells = [row[c["index"]] for c in data_cols]
        if not label:
            continue
        if all(c is None or not str(c).strip() for c in cells):
            context = label; continue            # a header row such as "Revenue from operations" or "Tax expense"
        if re.search(table["excluded_label_regex"], label, re.I):
            excluded.append({"row": rn, "label": label, "why": "restructured-book details are excluded by the analysts' rulebook"}); continue
        e = match_item(label, context, table)
        if not e:
            unmatched.append({"row": rn, "label": label, "context": context or None, "page": page}); continue
        if e.get("group") in ("total", "profit", "tax_total"):
            context = ""                         # a total closes the block its header opened
        if not isinstance(page, int) or page < 1:
            raise ValueError(f"row {rn} ({label!r}) has no page; give 'page' at the top level or on the row")
        values = []
        for c, raw in zip(data_cols, cells):
            raw_s = None if raw is None else " ".join(str(raw).split())
            if numbers.is_blank(raw_s):
                values.append({"period": c["period"], "column_index": c["index"], "value": None, "raw": raw_s, "status": "blank"}); continue
            v = numbers.parse_number(raw_s)
            if v is None or "%" in raw_s:
                values.append({"period": c["period"], "column_index": c["index"], "value": None, "raw": raw_s, "status": "unparseable"})
                problems.append(f"row {rn} {label!r} {c['period']}: {raw_s!r} is not a number"); continue
            out = v if e.get("per_share") else round(units.to_crore(v, unit), 6)
            values.append({"period": c["period"], "column_index": c["index"], "value": out, "raw": raw_s, "status": "ok"})
        item = {"item": e["item"], "label_reported": label, "page": page, "values": values}
        if e.get("per_share"): item["per_share"] = True
        if e["item"] in seen:
            item["duplicate"] = True; items[seen[e["item"]]]["duplicate"] = True
            problems.append(f"item {e['item']} matched twice: {items[seen[e['item']]]['label_reported']!r} and {label!r}; both kept, neither chosen")
        else:
            seen[e["item"]] = len(items)
        items.append(item)
    if misaligned:
        problems.append(f"{len(misaligned)} row(s) have a different width from the header and were not read; re-extract those rows")
    dq = [c for c in data_cols if c["role"] == "discrete_quarter"]
    keep = ("index", "header", "period", "kind", "role", "discrete_quarter", "audit_status", "restated", "basis")
    extract_doc = {
        "customer_id": doc.get("customer_id"), "source_path": doc.get("source_path"), "tag": doc.get("tag"),
        "filing_period": doc.get("filing_period"), "basis": basis, "bases_in_filing": doc.get("bases_in_filing"),
        "unit_reported": unit, "unit": "crore", "discrete_quarter_status": "present" if dq else "absent",
        "columns": [{k: c[k] for k in keep if k in c} for c in data_cols], "line_items": items,
        "disclosures": [], "not_found": [],
        "extracted_at": (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if doc.get("basis_note"): extract_doc["basis_note"] = doc["basis_note"]
    wanted = ["total_income", "interest_income", "finance_costs", "impairment_on_financial_instruments", "employee_benefits_expense",
              "other_expenses", "total_expenses", "profit_before_tax", "profit_after_tax"]
    extract_doc["not_found"] = [w for w in wanted if w not in seen]
    return {"extract": extract_doc, "unmatched_rows": unmatched, "misaligned_rows": misaligned, "excluded_rows": excluded, "problems": problems}


# ---- synthetic table for the self-test (Example Housing Finance Ltd, Rs lakh) ------------------------------------
def _example_doc():
    import parse_results_columns as prc
    cols = prc.parse({"header_rows": [["Sr. No.", "Particulars", "Quarter ended", None, None, "Half year ended", None, "Year ended"],
                                      [None, None, "30.09.2025", "30.06.2025", "30.09.2024", "30.09.2025", "30.09.2024", "31.03.2025"]]})["columns"]
    rows = [
        ["1", "Revenue from operations", "", "", "", "", "", ""],
        ["", "(a) Interest income", "52,340.10", "50,110.40", "44,800.00", "1,02,450.50", "87,900.25", "1,85,300.75"],
        ["", "(b) Fees and commission income", "1,210.00", "1,150.00", "980.00", "2,360.00", "1,900.00", "4,100.00"],
        ["", "(c) Net gain on derecognition of financial instruments under amortised cost category", "2,450.90", "2,100.60", "1,700.00", "4,551.50", "3,300.00", "7,200.00"],
        ["", "Total revenue from operations", "56,001.00", "53,361.00", "47,480.00", "1,09,362.00", "93,100.25", "1,96,600.75"],
        ["2", "Other income", "99.00", "39.00", "20.00", "138.00", "60.00", "199.25"],
        ["3", "Total income (1+2)", "56,100.00", "53,400.00", "47,500.00", "1,09,500.00", "93,160.25", "1,96,800.00"],
        ["4", "Expenses", "", "", "", "", "", ""],
        ["", "(a) Finance costs", "30,200.00", "29,100.00", "26,000.00", "59,300.00", "51,000.00", "1,07,000.00"],
        ["", "(b) Impairment on financial instruments", "1,300.00", "(250.00)", "900.00", "1,050.00", "1,800.00", "3,900.00"],
        ["", "(c) Employee benefits expense", "4,100.00", "3,950.00", "3,500.00", "8,050.00", "6,900.00", "14,500.00"],
        ["", "(d) Depreciation, amortisation and impairment", "400.00", "390.00", "350.00", "790.00", "690.00", "1,450.00"],
        ["", "(e) Other expenses", "2,600.00", "2,510.00", "2,250.00", "5,110.00", "4,400.00", "9,350.00"],
        ["", "Total expenses", "38,600.00", "35,700.00", "33,000.00", "74,300.00", "64,790.00", "1,36,200.00"],
        ["5", "Profit before tax (3-4)", "17,500.00", "17,700.00", "14,500.00", "35,200.00", "28,370.25", "60,600.00"],
        ["6", "Tax expense", "", "", "", "", "", ""],
        ["", "Current tax", "4,000.00", "4,100.00", "3,400.00", "8,100.00", "6,700.00", "14,300.00"],
        ["", "Deferred tax", "400.00", "350.00", "250.00", "750.00", "470.25", "950.00"],
        ["", "Total tax expense", "4,400.00", "4,450.00", "3,650.00", "8,850.00", "7,170.25", "15,250.00"],
        ["7", "Profit for the period / year (5-6)", "13,100.00", "13,250.00", "10,850.00", "26,350.00", "21,200.00", "45,350.00"],
        ["8", "Other comprehensive income (net of tax)", "(12.00)", "5.00", "-", "(7.00)", "3.00", "NA"],
        ["9", "Total comprehensive income", "13,088.00", "13,255.00", "10,850.00", "26,343.00", "21,203.00", "see note"],
        ["10", "Paid-up equity share capital (face value Rs. 10 each)", "8,000.00", "8,000.00", "8,000.00", "8,000.00", "8,000.00", "8,000.00"],
        ["11", "Earnings per equity share (not annualised)", "", "", "", "", "", ""],
        ["", "Basic (Rs.)", "16.38", "16.56", "13.56", "32.94", "26.50", "56.69"],
        ["", "Diluted (Rs.)", "16.30", "16.48", "13.50", "32.78", "26.40", "56.40"],
        ["", "Restructured loans outstanding", "120.00", "130.00", "150.00", "120.00", "150.00", "140.00"],
        ["", "Gain on sale of office premises", "5.00", "-", "-", "5.00", "-", "-"],
        ["12", "A row the extractor split badly", "1.00", "2.00"],
    ]
    return {"customer_id": "example-housing-finance", "tag": "reg33_results", "filing_period": "Q2 FY26", "basis": "standalone", "bases_in_filing": "both",
            "source_path": "Customers/example-housing-finance/filings/lodr/2025-10-24_reg33_results_q2-fy26-financial-results.pdf",
            "unit": "lakh", "page": 4, "columns": cols, "rows": rows}


def _self_test():
    n = 0
    out = extract(_example_doc())
    x = out["extract"]; li = {i["item"]: i for i in x["line_items"]}
    val = lambda item, period: next(v for v in li[item]["values"] if v["period"] == period)
    assert val("interest_income", "Q2 FY26")["value"] == 523.401 and val("interest_income", "H1 FY26")["value"] == 1024.505; n += 1   # lakh -> crore, Indian grouping
    assert val("impairment_on_financial_instruments", "Q1 FY26")["value"] == -2.5; n += 1                                            # brackets are negative
    assert val("eps_basic", "Q2 FY26")["value"] == 16.38 and li["eps_basic"]["per_share"] and val("eps_diluted", "FY25")["value"] == 56.4; n += 1   # per-share not converted, matched by context
    assert val("current_tax", "Q2 FY26")["value"] == 40.0 and val("total_tax_expense", "Q2 FY26")["value"] == 44.0; n += 1
    assert val("other_comprehensive_income", "Q2 FY25")["status"] == "blank" and val("other_comprehensive_income", "FY25")["status"] == "blank"; n += 1
    v = val("total_comprehensive_income", "FY25"); assert v["status"] == "unparseable" and v["value"] is None and v["raw"] == "see note"; n += 1
    assert li["net_gain_on_derecognition"]["label_reported"].startswith("Net gain on derecognition") and li["profit_after_tax"]["page"] == 4; n += 1
    assert [u["label"] for u in out["unmatched_rows"]] == ["Gain on sale of office premises"]; n += 1            # not forced into an item
    assert [e["label"] for e in out["excluded_rows"]] == ["Restructured loans outstanding"]; n += 1                # rulebook exclusion
    assert len(out["misaligned_rows"]) == 1 and out["misaligned_rows"][0]["cells"] == 4; n += 1                    # shifted row is not read
    assert x["discrete_quarter_status"] == "present" and x["not_found"] == [] and x["unit"] == "crore" and x["unit_reported"] == "lakh"; n += 1
    assert [c["discrete_quarter"] for c in x["columns"]] == [True, True, True, False, False, False]; n += 1
    # side-by-side table: only the requested basis is taken; units in millions
    import parse_results_columns as prc
    cols = prc.parse({"header_rows": [["Particulars", "Standalone", None, "Consolidated", None], ["", "Quarter ended 30.06.2025", "Quarter ended 30.06.2024",
                                                                                                  "Quarter ended 30.06.2025", "Quarter ended 30.06.2024"]]})["columns"]
    d = {"basis": "standalone", "unit": "million", "page": 2, "columns": cols,
         "rows": [["Total income", "5,610.0", "4,750.0", "5,900.0", "5,000.0"], ["Profit after tax", "1,310.0", "1,085.0", "1,400.0", "1,150.0"],
                  ["Net profit after tax", "1,310.0", "1,085.0", "1,400.0", "1,150.0"]]}
    o = extract(d); ti = o["extract"]["line_items"][0]
    assert [v["value"] for v in ti["values"]] == [561.0, 475.0] and [v["column_index"] for v in ti["values"]] == [1, 2]; n += 1
    assert all(i.get("duplicate") for i in o["extract"]["line_items"] if i["item"] == "profit_after_tax") and any("matched twice" in p for p in o["problems"]); n += 1
    # refusals
    for bad, why in [({**d, "unit": None}, "unit"), ({**d, "basis": "both"}, "basis"), ({**d, "columns": []}, "columns"), ({**d, "page": None}, "page"),
                     ({**d, "columns": [dict(c, basis=None) for c in cols]}, "both carry")]:
        try:
            extract(bad)
        except ValueError as x_:
            assert why in str(x_), (why, str(x_)); n += 1
        else:
            raise AssertionError(f"accepted input with bad {why}")
    t = load_table()
    assert match_item("Profit before exceptional items and tax", "", t)["item"] == "profit_before_exceptional_items_and_tax"
    assert match_item("Profit/(Loss) before tax", "", t)["item"] == "profit_before_tax" and match_item("Total other comprehensive income", "", t)["item"] == "other_comprehensive_income"
    assert match_item("Net profit after tax attributable to owners of the company", "", t)["item"] == "pat_attributable_to_owners"
    assert match_item("Basic and diluted (Rs.)", "Earnings per share", t)["item"] == "eps_basic_and_diluted" and match_item("Others", "Expenses", t) is None
    assert match_item("Others", "Revenue from operations", t)["item"] == "other_operating_income" and clean_label(["(ii)", "b) Finance costs"]) == "Finance costs"; n += 5
    md = os.path.join(HERE, "..", "..", "..", "skills", "results-filing-layouts", "references", "line-item-synonyms.md")
    if os.path.isfile(md):
        doc = open(md, encoding="utf-8").read()
        missing = [e["item"] for e in t["items"] if e["item"] not in doc]
        assert not missing, f"items not documented in line-item-synonyms.md: {missing}"; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Normalise extracted results-table rows into line items in Rs crore, each with its page.")
    ap.add_argument("--input", help="JSON file (see the module docstring); default stdin")
    ap.add_argument("--print-table", action="store_true", help="print the label synonym table and exit")
    ap.add_argument("--example", action="store_true", help="print a worked synthetic input and exit")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL extract_results_lines: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "extract_results_lines", "cases": n})); return 0
    if a.print_table:
        print(json.dumps(load_table(), indent=2, ensure_ascii=False)); return 0
    if a.example:
        print(json.dumps(_example_doc(), indent=1, ensure_ascii=False)); return 0
    try:
        raw = open(a.input, encoding="utf-8").read() if a.input else sys.stdin.read()
        out = extract(json.loads(raw))
    except (OSError, ValueError) as x:
        print(f"cannot extract: {x}", file=sys.stderr); return 2
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
