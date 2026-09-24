#!/usr/bin/env python3
"""Statement rows -> the company's label, a normalised label, and values in Rs crore.

Input (file or - for stdin):
  {"primary_context_entity": "example-housing-finance", "report_fy": "FY26", "section": "standalone_financial_statements",
   "statement": "balance_sheet",            balance_sheet | profit_and_loss | cash_flow | changes_in_equity | loans_note | borrowings_note
   "basis": "standalone",                   standalone | consolidated   (required: never assumed)
   "unit_header": "(Rs. in Lakhs)",         the unit line printed above the table; or give "unit": "lakh" outright
   "columns": [{"fy": "FY26"}, {"fy": "FY25", "restated": true}],
   "printed_page": "164", "pdf_page": 172,  defaults for every row; a row may carry its own (stitched tables do)
   "rows": [{"label": "Loans", "note_ref": "7", "values": ["12,34,567.80", "10,11,121.30"]}, ...]}
  Rows from stitch_tables.py ({"cells": [...], "pdf_page": ...}) are accepted as they are.

Labels come from ../references/statement-labels.json. An unknown label is kept as printed and listed; a label that
matches two entries is kept as printed and listed as ambiguous; a restructured-book row is left out and listed.
Numbers go through finlib.numbers (Indian grouping, brackets for negatives, '-' and 'Nil' as blank) and
finlib.units (lakh / 100, million / 10, billion * 100). Earnings per share are never converted.
A unit that cannot be read from the header is an error: the script does not guess one.
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C

STATEMENTS = ["balance_sheet", "profit_and_loss", "cash_flow", "changes_in_equity", "loans_note", "borrowings_note"]
_ENUM = re.compile(r"^\s*(\(?([a-z]|[ivx]{1,4}|\d{1,2})\)|([a-z]|[ivx]{1,4}|\d{1,2})[.)])\s+", re.I)


def clean_label(label):
    """'(a) Loans' -> 'loans'; 'I. ASSETS' -> 'assets'; keeps qualifiers such as '(other than debt securities)'."""
    t = C.clean(label)
    for _ in range(2):
        t = _ENUM.sub("", t)
    t = re.sub(r"\s*[:*#^]+$", "", t)
    return t.lower().strip()


def _search(patterns, text):
    return any(re.search(p, text, re.I) for p in patterns)


def match_label(label, statement, side, table):
    """-> (normalised|None, status) where status is matched | unknown | ambiguous | restructured."""
    t = clean_label(label)
    if not t:
        return None, "unknown"
    if _search(table["restructured_patterns"], t):
        return None, "restructured"
    hits = []
    for e in table["labels"]:
        if statement not in e["statements"]:
            continue
        if statement == "balance_sheet" and e.get("side") and side:
            ok = e["side"] == side or (e["side"] == "equity" and side == "liabilities")
            if not ok:
                continue
        if _search(e["patterns"], t) and e["normalised"] not in [h["normalised"] for h in hits]:
            hits.append(e)
    if len(hits) == 1:
        return hits[0]["normalised"], "matched"
    if not hits:
        return None, "unknown"
    return None, "ambiguous:" + ",".join(h["normalised"] for h in hits)


def _side_of(label, table):
    t = clean_label(label)
    for side, pats in table["side_headers"].items():
        if _search(pats, t):
            return side
    return None


def normalise(doc, table=None):
    from finlib import numbers, units, periods, schema
    table = table or C.load_reference("statement-labels.json")
    problems = []
    statement, basis = doc.get("statement"), doc.get("basis")
    if statement not in STATEMENTS:
        problems.append(f"statement must be one of {STATEMENTS}, got {statement!r}")
    if basis not in ("standalone", "consolidated"):
        problems.append("basis must be 'standalone' or 'consolidated'; read it from the statement's title, it is never assumed")
    unit = doc.get("unit") or units.detect_unit(doc.get("unit_header") or "")
    if unit not in units.FACTOR_TO_CRORE:
        problems.append(f"unit not readable from header {doc.get('unit_header')!r}: give the unit line printed above the table "
                        "(one unit only), or pass \"unit\" as crore|lakh|million|billion|thousand|rupee")
    columns = doc.get("columns") or []
    col_fy = []
    for i, c in enumerate(columns):
        fy = C.fy_label((c or {}).get("fy") or (c or {}).get("label") or "")
        if not fy:
            problems.append(f"columns[{i}]: {c!r} does not name a financial year (FY26, or 'As at March 31, 2026' with \"label\")")
            col_fy.append(None)
        else:
            col_fy.append(fy)
    if not columns:
        problems.append("columns is required: one entry per value column, each naming its financial year")
    if problems:
        return None, problems

    kinds = {e["normalised"]: e["value_kind"] for e in table["labels"]}
    side, out_rows, unknown, ambiguous, unparseable, excluded, data_rows = None, [], [], [], [], [], []
    for n, r in enumerate(doc.get("rows") or []):
        if "cells" in r:
            label, values = r["cells"][0], r["cells"][1:]
            if len(values) == len(columns) + 1:                    # a note-reference column sits between label and values
                r = dict(r, note_ref=values[0]); values = values[1:]
        else:
            label, values = r.get("label"), r.get("values") or []
        new_side = _side_of(label, table) if statement == "balance_sheet" else None
        if new_side:
            side = new_side
        if len(values) != len(columns):
            problems.append(f"row {n} ({label!r}): {len(values)} values for {len(columns)} columns"); continue
        norm, status = match_label(label, statement, side, table)
        if status == "restructured":
            excluded.append(C.clean(label)); continue
        heading = all(numbers.is_blank(v) for v in values)
        if heading and not status == "restructured":
            norm, status = None, "heading"            # a label-only row is a sub-heading, whatever its words match
        if status == "unknown" and not new_side:
            unknown.append(C.clean(label))
        if status.startswith("ambiguous"):
            ambiguous.append({"label": C.clean(label), "candidates": status.split(":", 1)[1].split(",")})
        per_share = kinds.get(norm) == "per_share"
        cells = []
        for v, fy, col in zip(values, col_fy, columns):
            parsed = numbers.parse_number(v)
            if parsed is None and not numbers.is_blank(v):
                unparseable.append({"row": n, "label": C.clean(label), "fy": fy, "as_printed": v})
            value = None if parsed is None else (parsed if per_share else round(units.to_crore(parsed, unit), 6))
            cells.append({"fy": fy, "as_printed": v, "value": value, "unit": "rupees" if per_share else "crore",
                          "blank": numbers.is_blank(v), "restated": bool(col.get("restated"))})
        row = {"label": C.clean(label), "normalised_label": norm, "match": status, "side": side if statement == "balance_sheet" else None,
               "note_ref": r.get("note_ref"), "heading_row": heading, "values": cells,
               "printed_page": r.get("printed_page") or doc.get("printed_page"), "pdf_page": r.get("pdf_page") or doc.get("pdf_page")}
        out_rows.append(row)
        if heading:
            continue
        for c in cells:
            if c["value"] is None:
                continue
            d = {schema.ROW_KEY: schema.row_entity(doc), "fy": c["fy"], "report_fy": doc.get("report_fy"), "section": doc.get("section"),
                 "statement": statement, "label": row["label"], "normalised_label": norm, "value": c["value"], "unit": c["unit"],
                 "basis": basis, "printed_page": None if row["printed_page"] is None else str(row["printed_page"]), "pdf_page": row["pdf_page"]}
            if not per_share and unit != "crore":
                d["original_value"], d["original_unit"] = numbers.parse_number(c["as_printed"]), unit
            if c["restated"]:
                d["restated"] = True
            if row["note_ref"]:
                d["note_ref"] = str(row["note_ref"])
            data_rows.append(d)

    derived = {}
    for name, spec in table.get("derived", {}).items():
        if spec["statement"] != statement:
            continue
        for fy in [f for f in dict.fromkeys(col_fy) if f]:
            parts = {}
            for row in out_rows:
                if row["normalised_label"] in spec["sum_of"]:
                    v = next((c["value"] for c in row["values"] if c["fy"] == fy), None)
                    if v is not None:
                        parts[row["normalised_label"]] = parts.get(row["normalised_label"], 0) + v
            if parts:
                derived.setdefault(name, []).append({"fy": fy, "value": round(sum(parts.values()), 6), "unit": "crore",
                                                     "components_present": parts,
                                                     "components_absent": [k for k in spec["sum_of"] if k not in parts],
                                                     "say": "derived: the sum of the components present; a component not on the balance sheet was not added as zero by assumption, it is absent"})
    return {"statement": statement, "basis": basis, "filing_unit": unit, "reported_unit": "crore", "columns": col_fy,
            "rows": out_rows, "derived": derived, "unknown_labels": unknown, "ambiguous_labels": ambiguous,
            "unparseable_values": unparseable, "excluded_restructured": excluded, "data_rows": data_rows}, problems


def _cases():
    table = C.load_reference("statement-labels.json")
    BS = {"primary_context_entity": "example-housing-finance", "report_fy": "FY26", "section": "standalone_financial_statements",
          "statement": "balance_sheet", "basis": "standalone", "unit_header": "(₹ in Lakhs)", "printed_page": "164", "pdf_page": 172,
          "columns": [{"label": "As at March 31, 2026"}, {"label": "As at March 31, 2025", "restated": True}],
          "rows": [{"label": "ASSETS", "values": ["", ""]}, {"label": "Financial assets", "values": ["", ""]},
                   {"label": "(a) Cash and cash equivalents", "note_ref": "3", "values": ["45,678.90", "39,000.00"]},
                   {"label": "(c) Derivative financial instruments", "values": ["1,200.00", "-"]},
                   {"label": "(e) Loans", "note_ref": "7", "values": ["12,34,567.80", "10,11,121.30"]},
                   {"label": "LIABILITIES AND EQUITY", "values": ["", ""]},
                   {"label": "(a) Derivative financial instruments", "values": ["300.00", "250.00"]},
                   {"label": "(c) Debt securities", "values": ["3,00,000.00", "2,50,000.00"]},
                   {"label": "(d) Borrowings (other than debt securities)", "values": ["6,00,000.00", "5,00,000.00"]},
                   {"label": "(f) Subordinated liabilities", "values": ["50,000.00", "50,000.00"]},
                   {"label": "Equity share capital", "values": ["9,000.00", "9,000.00"]},
                   {"label": "Green initiative reserve", "values": ["12.00", "abc"]},
                   {"label": "Restructured loans (OTR 2.0)", "values": ["700.00", "900.00"]}]}

    def balance_sheet():
        r, problems = normalise(BS, table)
        assert problems == [], problems
        by = {x["label"]: x for x in r["rows"]}
        assert by["Financial assets"]["match"] == "heading" and by["Financial assets"]["normalised_label"] is None
        assert by["(e) Loans"]["normalised_label"] == "loan_book" and by["(e) Loans"]["values"][0]["value"] == 12345.678
        assert by["(c) Derivative financial instruments"]["normalised_label"] == "derivative_financial_instruments_assets"
        assert by["(a) Derivative financial instruments"]["normalised_label"] == "derivative_financial_instruments_liabilities"
        assert by["(c) Derivative financial instruments"]["values"][1] == {"fy": "FY25", "as_printed": "-", "value": None, "unit": "crore", "blank": True, "restated": True}
        assert by["Equity share capital"]["normalised_label"] == "equity_share_capital"           # no EQUITY heading row: still matched
        assert r["unknown_labels"] == ["Green initiative reserve"], r["unknown_labels"]
        assert r["unparseable_values"] == [{"row": 11, "label": "Green initiative reserve", "fy": "FY25", "as_printed": "abc"}]
        assert r["excluded_restructured"] == ["Restructured loans (OTR 2.0)"]
        assert all("estructured" not in d["label"] for d in r["data_rows"])
        b = r["derived"]["borrowings"][0]
        assert b["fy"] == "FY26" and b["value"] == 9500.0 and b["components_absent"] == ["deposits"], b
        loan = [d for d in r["data_rows"] if d["normalised_label"] == "loan_book"]
        assert loan[0]["original_value"] == 1234567.8 and loan[0]["original_unit"] == "lakh" and loan[0]["note_ref"] == "7"
        assert loan[1]["restated"] is True and loan[1]["fy"] == "FY25" and loan[1]["printed_page"] == "164"

    def data_rows_validate():
        from finlib import schema
        r, _ = normalise(BS, table)
        s = C.load_schema("annual-report-data-row.schema.json")
        bad = [p for d in r["data_rows"] for p in schema.validate(d, s)]
        assert bad == [], bad[:3]
        # an input under the key's older name writes rows under the new key
        OLD = schema.LEGACY_ROW_KEYS[0]
        r, _ = normalise({(OLD if k == schema.ROW_KEY else k): v for k, v in BS.items()}, table)
        assert r["data_rows"] and all(d[schema.ROW_KEY] == "example-housing-finance" and OLD not in d for d in r["data_rows"])

    def profit_and_loss_eps_not_converted():
        doc = {"statement": "profit_and_loss", "basis": "standalone", "unit": "million", "columns": [{"fy": "FY26"}],
               "rows": [{"label": "Interest income", "values": ["15,000.0"]}, {"label": "Impairment on financial instruments", "values": ["(120.5)"]},
                        {"label": "Profit for the year", "values": ["2,500.0"]}, {"label": "(1) Basic (₹)", "values": ["27.45"]},
                        {"label": "Net gain on derecognition of financial instruments under amortised cost category", "values": ["310.0"]}]}
        r, problems = normalise(doc, table)
        assert problems == []
        got = {x["normalised_label"]: x["values"][0] for x in r["rows"]}
        assert got["interest_income"]["value"] == 1500.0 and got["impairment_on_financial_instruments"]["value"] == -12.05
        assert got["eps_basic"]["value"] == 27.45 and got["eps_basic"]["unit"] == "rupees"
        assert got["profit_after_tax"]["value"] == 250.0 and "net_gain_on_derecognition_amortised_cost" in got

    def stitched_rows_with_note_column():
        doc = {"statement": "borrowings_note", "basis": "standalone", "unit_header": "Rs. in crore", "columns": [{"fy": "FY26"}, {"fy": "FY25"}],
               "rows": [{"cells": ["Term loans from banks", "14", "4,000.00", "3,500.00"], "pdf_page": 213, "printed_page": "205"},
                        {"cells": ["Refinance from National Housing Bank", "14", "1,250.50", "1,100.00"], "pdf_page": 214, "printed_page": "206"},
                        {"cells": ["Commercial paper", "13", "Nil", "200.00"], "pdf_page": 214}]}
        r, problems = normalise(doc, table)
        assert problems == [], problems
        assert [x["normalised_label"] for x in r["rows"]] == ["term_loans_from_banks", "refinance_from_nhb", "commercial_paper"]
        assert r["rows"][1]["pdf_page"] == 214 and r["rows"][1]["note_ref"] == "14"
        assert "original_unit" not in r["data_rows"][0] and len(r["data_rows"]) == 5

    def refuses_to_guess():
        for patch, word in (({"unit_header": "(Rs. in lakhs, except per share data in crore)"}, "unit not readable"),
                            ({"unit_header": "Particulars"}, "unit not readable"), ({"basis": None}, "basis must be"),
                            ({"columns": [{"fy": "Current year"}]}, "does not name a financial year"), ({"statement": "p&l"}, "statement must be")):
            r, problems = normalise(dict(BS, **patch), table)
            assert r is None and any(word in p for p in problems), (patch, problems)
        r, problems = normalise(dict(BS, rows=[{"label": "Loans", "values": ["1"]}]), table)
        assert any("1 values for 2 columns" in p for p in problems)

    def label_cleaning():
        assert clean_label("(a) Loans") == "loans" and clean_label("I. ASSETS") == "assets" and clean_label("(ii) Other receivables *") == "other receivables"
        assert match_label("Loans to employees", "balance_sheet", "assets", table) == (None, "unknown")
        assert match_label("Deposits", "balance_sheet", "assets", table) == (None, "unknown")     # a liability label on the assets side
        assert match_label("Deposits", "balance_sheet", "liabilities", table)[0] == "deposits"

    return [("balance sheet in lakhs with sides, blanks, unknowns, restructured", balance_sheet),
            ("data rows validate against the row schema", data_rows_validate),
            ("P&L in millions; EPS not converted", profit_and_loss_eps_not_converted),
            ("stitched rows with a note column", stitched_rows_with_note_column), ("refuses to guess unit, basis, year", refuses_to_guess),
            ("label cleaning and side scoping", label_cleaning)]


def main():
    ap = argparse.ArgumentParser(description="Normalise statement rows: labels via statement-labels.json, values to Rs crore via finlib.",
                                 epilog="Example: normalise_statement.py /workspace/out/standalone-balance-sheet.rows.json > /workspace/out/standalone-balance-sheet.norm.json")
    ap.add_argument("rows", nargs="?", help="JSON document described in --help of this script's docstring, or - for stdin")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.rows:
        C.die("give the rows JSON file, or - for stdin")
    doc = C.read_json_arg(args.rows)
    if not isinstance(doc, dict):
        C.die("input must be a JSON object")
    result, problems = normalise(doc)
    if result is None:
        C.die("; ".join(problems))
    result["problems"] = problems
    C.emit(result)
    if problems:
        C.die("; ".join(problems), C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
