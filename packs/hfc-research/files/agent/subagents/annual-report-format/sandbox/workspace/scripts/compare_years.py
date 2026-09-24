#!/usr/bin/env python3
"""Compare the same section on the same basis across two financial years, from annual-report-data.jsonl rows.

For each line (section, statement, basis, normalised label or the company's label, dimension):
  current            the figure for --fy read from the --fy report
  comparative        the figure for --prior printed as the comparative in the --fy report
  first_reported     the figure for --prior as the --prior report printed it
  change             current - comparative (same report, same presentation); falls back to first_reported, and says so
  restated           comparative differs from first_reported by more than --tolerance, or the row is marked restated
Lines present in one year only are listed as presentation changes (new_lines, dropped_lines), not given a change.
Standalone is never compared with consolidated. Percent rows change in percentage points, not percent.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C


def _line_key(o):
    return (o.get("section"), o.get("statement"), o.get("basis"), o.get("normalised_label") or C.clean(o.get("label")).lower(), o.get("dimension"))


def compare(rows, fy, prior, basis=None, section=None, tolerance=0.005):
    from finlib import numbers
    problems = []
    if C.fy_label(fy) != fy or C.fy_label(prior) != prior:
        return None, [f"--fy and --prior must be written like FY26 (got {fy!r}, {prior!r})"]
    if int(prior[2:]) >= int(fy[2:]) and not (fy == "FY00"):
        return None, [f"--prior {prior} is not earlier than --fy {fy}"]
    lines = {}
    for o in rows:
        if basis and o.get("basis") != basis:
            continue
        if section and o.get("section") != section:
            continue
        if o.get("fy") not in (fy, prior) or not isinstance(o.get("value"), (int, float)) or isinstance(o.get("value"), bool):
            continue
        rep = o.get("report_fy") or o.get("fy")
        slot = ("current" if o["fy"] == fy and rep == fy else "comparative" if o["fy"] == prior and rep == fy
                else "first_reported" if o["fy"] == prior and rep == prior else None)
        if slot is None:
            continue
        line = lines.setdefault(_line_key(o), {"labels": {}, "unit": o.get("unit"), "flag": False})
        if slot in line:
            problems.append(f"two {slot} values for {_line_key(o)}; run validate_ar_data.py, the file has duplicates"); continue
        line[slot] = o
        line["labels"][rep] = o.get("label")
        line["flag"] = line["flag"] or bool(o.get("restated"))
        if o.get("unit") != line["unit"]:
            problems.append(f"{_line_key(o)} is in {line['unit']} in one year and {o.get('unit')} in the other; not compared")
            line["unit_clash"] = True
    out, new_lines, dropped, restated, relabelled = [], [], [], [], []
    for key, line in sorted(lines.items(), key=lambda kv: tuple(str(x) for x in kv[0])):
        if line.get("unit_clash"):
            continue
        cur, comp, first = (line.get(k) for k in ("current", "comparative", "first_reported"))
        val = lambda o: None if o is None else o["value"]
        base_row, base_name = (comp, "comparative") if comp is not None else (first, "first_reported")
        rec = {"section": key[0], "statement": key[1], "basis": key[2], "line": key[3], "dimension": key[4], "unit": line["unit"],
               "label_by_report": line["labels"], "current": val(cur), "comparative": val(comp), "first_reported": val(first),
               "change": None, "change_pct": None, "change_basis": None, "restated": False, "restatement_difference": None,
               "pages": {k: {"printed_page": o.get("printed_page"), "pdf_page": o.get("pdf_page")} for k, o in
                         (("current", cur), ("comparative", comp), ("first_reported", first)) if o is not None}}
        if cur is not None and base_row is not None:
            rec["change"] = round(cur["value"] - base_row["value"], 6)
            rec["change_basis"] = base_name
            if line["unit"] != "percent":
                d = numbers.pct_diff(base_row["value"], cur["value"])
                rec["change_pct"] = None if d is None else round(d if cur["value"] >= base_row["value"] else -d, 4)
        if comp is not None and first is not None:
            diff = round(comp["value"] - first["value"], 6)
            if abs(diff) > tolerance:
                rec["restated"], rec["restatement_difference"] = True, diff
        if line["flag"]:
            rec["restated"] = True
        if rec["restated"]:
            restated.append(key[3] if key[4] is None else f"{key[3]} [{key[4]}]")
        if cur is not None and base_row is None:
            new_lines.append(key[3])
        if cur is None and (comp is not None or first is not None):
            dropped.append(key[3])
        labels = {C.clean(v).lower() for v in line["labels"].values() if v}
        if len(labels) > 1:
            relabelled.append({"line": key[3], "labels": line["labels"]})
        out.append(rec)
    return {"fy": fy, "prior": prior, "basis_filter": basis, "section_filter": section, "lines": out,
            "restated_lines": restated, "new_lines": new_lines, "dropped_lines": dropped, "relabelled_lines": relabelled,
            "say": "Call out every restated line, every new or dropped line (a change in presentation) and any change in accounting "
                   "policy the notes describe. Do not compute a change for a line that exists in one year only."}, problems


def _cases():
    def r(fy, report, label, norm, value, **kw):
        o = {"primary_context_entity": "example-housing-finance", "fy": fy, "report_fy": report, "section": "standalone_financial_statements",
             "statement": "balance_sheet", "basis": "standalone", "label": label, "normalised_label": norm, "value": value, "unit": "crore",
             "printed_page": "164", "pdf_page": 172}
        o.update(kw); return o
    ROWS = [r("FY26", "FY26", "Loans", "loan_book", 12345.68), r("FY25", "FY26", "Loans", "loan_book", 10111.21),
            r("FY25", "FY25", "Loans (at amortised cost)", "loan_book", 10100.00),
            r("FY26", "FY26", "Investments", "investments", 800.0), r("FY25", "FY26", "Investments", "investments", 640.0), r("FY25", "FY25", "Investments", "investments", 640.0),
            r("FY26", "FY26", "Right-of-use assets", "right_of_use_assets", 45.0),
            r("FY25", "FY25", "Goodwill", "goodwill", 3.0),
            r("FY26", "FY26", "Loans", "loan_book", 12900.0, basis="consolidated", section="consolidated_financial_statements"),
            r("FY26", "FY26", "CRAR", "crar", 21.4, unit="percent", section="rbi_hfc_disclosures", statement="note"),
            r("FY25", "FY26", "CRAR", "crar", 23.1, unit="percent", section="rbi_hfc_disclosures", statement="note")]

    def main_case():
        res, problems = compare(ROWS, "FY26", "FY25", basis="standalone")
        assert problems == []
        by = {(l["line"], l["section"]): l for l in res["lines"]}
        loan = by[("loan_book", "standalone_financial_statements")]
        assert loan["change"] == 2234.47 and loan["change_basis"] == "comparative" and loan["change_pct"] == 22.0989
        assert loan["restated"] is True and loan["restatement_difference"] == 11.21
        assert by[("investments", "standalone_financial_statements")]["restated"] is False
        assert by[("investments", "standalone_financial_statements")]["change_pct"] == 25.0
        assert res["restated_lines"] == ["loan_book"] and res["new_lines"] == ["right_of_use_assets"] and res["dropped_lines"] == ["goodwill"]
        assert res["relabelled_lines"][0]["line"] == "loan_book"
        crar = by[("crar", "rbi_hfc_disclosures")]
        assert crar["change"] == -1.7 and crar["change_pct"] is None                      # percentage points, never a percent of a percent
        assert not any(l["basis"] == "consolidated" for l in res["lines"])

    def falls_back_to_first_reported():
        res, _ = compare([ROWS[0], ROWS[2]], "FY26", "FY25")
        assert res["lines"][0]["change_basis"] == "first_reported" and res["lines"][0]["change"] == 2245.68

    def decrease_is_negative():
        res, _ = compare([r("FY26", "FY26", "Deposits", "deposits", 80.0), r("FY25", "FY26", "Deposits", "deposits", 100.0)], "FY26", "FY25")
        assert res["lines"][0]["change_pct"] == -20.0

    def problems_reported():
        res, problems = compare(ROWS + [ROWS[0]], "FY26", "FY25")
        assert any("duplicates" in p for p in problems)
        assert compare(ROWS, "FY25", "FY26")[0] is None and compare(ROWS, "2026", "FY25")[0] is None
        res, problems = compare([r("FY26", "FY26", "X", "x", 1.0), r("FY25", "FY26", "X", "x", 1.0, unit="percent")], "FY26", "FY25")
        assert res["lines"] == [] and any("not compared" in p for p in problems)

    return [("restated comparative, new and dropped lines, percent rows", main_case), ("falls back to the prior report", falls_back_to_first_reported),
            ("a decrease is negative", decrease_is_negative), ("duplicates, bad years, unit clash", problems_reported)]


def main():
    ap = argparse.ArgumentParser(description="Compare one section on one basis across two years; flags restated comparatives and presentation changes.",
                                 epilog="Example: compare_years.py /workspace/in/annual-report-data.jsonl --fy FY26 --prior FY25 --basis standalone --section standalone_financial_statements")
    ap.add_argument("jsonl", nargs="*", help="one or more annual-report-data.jsonl files")
    ap.add_argument("--fy", help="the later year, e.g. FY26")
    ap.add_argument("--prior", help="the earlier year, e.g. FY25")
    ap.add_argument("--basis", choices=["standalone", "consolidated"], default="standalone", help="default standalone, as the analysts use")
    ap.add_argument("--section", help="limit to one section key")
    ap.add_argument("--tolerance", type=float, default=0.005, help="difference (in the row's unit) above which a comparative counts as restated")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.jsonl or not args.fy or not args.prior:
        C.die("give the jsonl file(s), --fy and --prior")
    from finlib import schema
    rows, problems = [], []
    for path in args.jsonl:
        if not os.path.exists(path):
            C.die(f"no such file: {path}")
        got, bad = schema.read_jsonl(path)
        rows += [o for _, o in got]; problems += [f"{path}: {b}" for b in bad]
    res, more = compare(rows, args.fy, args.prior, args.basis, args.section, args.tolerance)
    if res is None:
        C.die("; ".join(more))
    res["problems"] = problems + more
    C.emit(res)
    if not res["lines"]:
        C.die(f"no {args.basis} rows for {args.fy} or {args.prior}: extract both years first; nothing was compared", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
