#!/usr/bin/env python3
"""Validate rows for Companies/{company_id}/filings/annual-report-data.jsonl BEFORE dataroom_append_jsonl.

Schema: ../schemas/annual-report-data-row.schema.json. Rules a schema cannot express:
  - fy (and report_fy) parse as financial years; a figure's fy is not later than the report it came from;
  - basis is labelled and agrees with the section (standalone statements are standalone);
  - amounts are in Rs crore: a row that carries original_unit must equal original_value converted by the analysts'
    rule (lakh / 100, million / 10, billion * 100); a normalised amount label must be in crore, EPS in rupees;
  - printed_page and pdf_page are both present and, with --map, agree with the section map's offsets and page count;
  - duplicates are flagged, inside the file and against --existing (what is already in the data room);
  - no restructured-book line item is present (the analysts exclude them);
  - a figure that differs from the same figure in another year's report is flagged as a restatement to call out.
Exit 0 when there are no errors (warnings allowed), 1 otherwise. A failing file is reported, never appended.
"""
import argparse, os, re, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C
import page_offset as PO

BASIS_OF_SECTION = {"standalone_financial_statements": "standalone", "consolidated_financial_statements": "consolidated"}


def _key(o, with_report=True):
    k = (o.get("primary_context_entity"), o.get("fy"), o.get("section"), o.get("statement"), o.get("basis"),
         C.clean(o.get("label")).lower(), o.get("dimension"))
    return k + ((o.get("report_fy"),) if with_report else ())


def _fy_num(fy):
    return int(fy[2:]) if isinstance(fy, str) and re.fullmatch(r"FY\d{2}", fy) else None


def validate_rows(rows, problems=None, existing=None, section_map=None):
    """rows/existing: [(line_no, object)]. -> (errors, warnings)."""
    from finlib import schema, units
    row_schema = C.load_schema("annual-report-data-row.schema.json")
    labels = C.load_reference("statement-labels.json")
    kinds = {e["normalised"]: e["value_kind"] for e in labels["labels"]}
    restructured = labels["restructured_patterns"]
    errors, warnings = list(problems or []), []
    # rows stored under the key's older name read as the new key; both keys disagreeing is an error
    normed = []
    for n, o in rows:
        o, kp = schema.normalise_row(o); normed.append((n, o)); errors += [f"line {n}: {p}" for p in kp]
    rows = normed
    if existing: existing = [(n, schema.normalise_row(o)[0]) for n, o in existing]
    if not rows and not errors:
        errors.append("no rows: an empty file is never appended; if nothing could be extracted, say why instead")
    seen, companies = {}, set()
    for n, o in rows:
        where = f"line {n}"
        bad = schema.validate(o, row_schema)
        errors += [f"{where}: schema: {p}" for p in bad]
        for f in ("printed_page", "pdf_page"):
            if o.get(f) in (None, ""):
                errors.append(f"{where}: {f} is missing; every figure carries both its printed page and its PDF page")
        for f in ("fy", "report_fy"):
            if isinstance(o.get(f), str) and C.fy_label(o[f]) != o[f]:
                errors.append(f"{where}: {f} {o[f]!r} does not parse as a financial year written FY26")
        a, b = _fy_num(o.get("fy")), _fy_num(o.get("report_fy"))
        if a is not None and b is not None and a > b:
            errors.append(f"{where}: fy {o['fy']} is later than the report it was read from ({o['report_fy']})")
        if o.get("restated") and a is not None and b is not None and a == b:
            warnings.append(f"{where}: restated is set on a current-year figure; restatement applies to comparatives")
        if o.get("basis") not in ("standalone", "consolidated"):
            errors.append(f"{where}: basis is not labelled (standalone or consolidated)")
        want = BASIS_OF_SECTION.get(o.get("section"))
        if want and o.get("basis") in ("standalone", "consolidated") and o["basis"] != want:
            errors.append(f"{where}: section {o['section']} cannot carry basis {o['basis']}")
        text = f"{o.get('label') or ''} {o.get('normalised_label') or ''} {o.get('dimension') or ''}"
        if any(re.search(p, C.clean(text), re.I) for p in restructured):
            errors.append(f"{where}: {o.get('label')!r} is a restructured-book item; the analysts exclude these, remove the row "
                          "(mention in the reply that the report has the disclosure)")
        unit, kind = o.get("unit"), kinds.get(o.get("normalised_label"))
        if kind == "amount" and unit != "crore":
            errors.append(f"{where}: {o.get('normalised_label')} is an amount and must be in crore, not {unit!r}")
        if kind == "per_share" and unit != "rupees":
            errors.append(f"{where}: {o.get('normalised_label')} is per share and must be in rupees, not {unit!r}")
        v = o.get("value")
        if o.get("original_unit") in units.FACTOR_TO_CRORE and isinstance(o.get("original_value"), (int, float)) and isinstance(v, (int, float)) \
                and not isinstance(v, bool):
            expect = units.to_crore(o["original_value"], o["original_unit"])
            if abs(expect - v) > max(1e-6, abs(expect) * 1e-9):
                errors.append(f"{where}: value {v} is not {o['original_value']} {o['original_unit']} in crore (expected {round(expect, 6)})")
        if unit == "crore" and isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) >= 2000000 and "original_unit" not in o:
            warnings.append(f"{where}: {v} crore is implausibly large for a housing finance company; was the filing unit converted?")
        if unit == "percent" and isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) > 1000:
            warnings.append(f"{where}: {v} percent looks wrong")
        if o.get("normalised_label") is None:
            warnings.append(f"{where}: {o.get('label')!r} has no normalised label (kept as printed)")
        if isinstance(o.get(schema.ROW_KEY), str):
            companies.add(o[schema.ROW_KEY])
        k = _key(o)
        if k in seen:
            same = seen[k][1].get("value") == v
            errors.append(f"{where}: duplicate of line {seen[k][0]} ({o.get('label')!r}, {o.get('fy')}, {o.get('basis')})"
                          + ("" if same else f" with a different value ({seen[k][1].get('value')} vs {v})")
                          + "; if the rows differ by stage, bucket or party, set dimension")
        else:
            seen[k] = (n, o)
        if section_map:
            pc = section_map.get("page_count")
            if isinstance(o.get("pdf_page"), int) and isinstance(pc, int) and o["pdf_page"] > pc:
                errors.append(f"{where}: pdf_page {o['pdf_page']} is beyond the report's {pc} pages")
            if section_map.get("offsets") and o.get("printed_page") not in (None, "unnumbered") and isinstance(o.get("pdf_page"), int):
                spread = any(s.get("pages_per_pdf_page") == 2 for s in section_map["offsets"])
                msg = PO.check_pair(section_map["offsets"], o["printed_page"], o["pdf_page"], pc)
                if msg and not spread:
                    errors.append(f"{where}: {msg}")
    if len(companies) > 1:
        warnings.append(f"rows for more than one company in one file: {sorted(companies)}")

    if existing:
        old = {}
        for n, o in existing:
            old.setdefault(_key(o, with_report=False), []).append(o)
        for n, o in rows:
            for e in old.get(_key(o, with_report=False), []):
                if e.get("report_fy") == o.get("report_fy"):
                    errors.append(f"line {n}: already in the data room ({o.get('label')!r}, {o.get('fy')}, report {o.get('report_fy')})"
                                  + ("" if e.get("value") == o.get("value") else f" with value {e.get('value')} against {o.get('value')} here")
                                  + "; do not append it again")
                elif e.get("value") != o.get("value") and not o.get("restated"):
                    warnings.append(f"line {n}: {o.get('label')!r} {o.get('fy')} is {o.get('value')} in the {o.get('report_fy')} report but "
                                    f"{e.get('value')} in the {e.get('report_fy')} report: a restated or regrouped comparative. Set restated and call it out")
    return errors, warnings


def _row(**kw):
    base = {"primary_context_entity": "example-housing-finance", "fy": "FY26", "report_fy": "FY26", "section": "standalone_financial_statements",
            "statement": "balance_sheet", "label": "Loans", "normalised_label": "loan_book", "value": 12345.678, "unit": "crore",
            "original_value": 1234567.8, "original_unit": "lakh", "basis": "standalone", "printed_page": "164", "pdf_page": 172}
    base.update(kw)
    return {k: v for k, v in base.items() if v != "__drop__"}


def _cases():
    def check(rows, word=None, existing=None, section_map=None, warn=None):
        errors, warnings = validate_rows(list(enumerate(rows, 1)), None, list(enumerate(existing or [], 1)) or None, section_map)
        if word is None and warn is None:
            assert errors == [], errors
        if word:
            assert any(word in e for e in errors), (word, errors)
        if warn:
            assert any(warn in w for w in warnings), (warn, warnings)
        return errors, warnings

    def good():
        check([_row(), _row(fy="FY25", value=10111.213, original_value=1011121.3, restated=True),
               _row(section="rbi_hfc_disclosures", statement="note", label="CRAR", normalised_label="crar", value=21.4, unit="percent",
                    original_value="__drop__", original_unit="__drop__", printed_page="247", pdf_page=255),
               _row(section="transfer_of_loan_exposures", statement="note", label="Loans transferred through assignment", normalised_label=None,
                    value=None, note="stated as Nil for the year", original_value="__drop__", original_unit="__drop__")])

    def units_rules():
        check([_row(unit="lakh")], "schema")                                       # unit enum has no lakh
        check([_row(original_value="__drop__", original_unit="__drop__", unit="percent")], "must be in crore")
        check([_row(value=1234567.8)], "is not 1234567.8 lakh in crore")           # not converted
        check([_row(label="Basic EPS", normalised_label="eps_basic", value=27.45, original_value="__drop__", original_unit="__drop__")], "must be in rupees")
        check([_row(value=3000000.0, original_value="__drop__", original_unit="__drop__")], warn="implausibly large")

    def pages_and_basis():
        check([_row(printed_page="__drop__")], "printed_page is missing")
        check([_row(pdf_page=0)], "schema")
        check([_row(basis="consolidated")], "cannot carry basis consolidated")
        check([_row(basis="__drop__")], "basis is not labelled")
        check([_row(printed_page="unnumbered")])

    def years():
        check([_row(fy="2025-26")], "schema")
        check([_row(fy="FY27")], "later than the report")
        check([_row(restated=True)], warn="restatement applies to comparatives")

    def duplicates_and_dimension():
        check([_row(), _row()], "duplicate of line 1")
        check([_row(), _row(value=1.0, original_value=100.0)], "with a different value")
        check([_row(section="ind_as_109_notes", statement="staging", label="Gross carrying amount", normalised_label="gross_carrying_amount", dimension=d,
                    original_value="__drop__", original_unit="__drop__") for d in ("stage_1", "stage_2", "stage_3")])

    def restructured():
        check([_row(label="Restructured loans under Resolution Framework 2.0", normalised_label=None)], "restructured-book item")
        check([_row(section="ind_as_109_notes", label="Gross carrying amount", normalised_label="gross_carrying_amount", dimension="restructured book")], "restructured-book item")

    def against_the_data_room():
        check([_row()], "already in the data room", existing=[_row()])
        check([_row(fy="FY25", value=10111.213, original_value=1011121.3)], warn="restated or regrouped comparative",
              existing=[_row(fy="FY25", report_fy="FY25", value=10100.0, original_value=1010000.0)])

    def against_the_map():
        m = {"page_count": 360, "offsets": PO.compute_segments([[9, "1"], [10, "2"], [350, "342"]], 360)["segments"]}
        check([_row()], section_map=m)
        check([_row(pdf_page=173)], "maps to pdf page 172", section_map=m)
        check([_row(pdf_page=400, printed_page="392")], "beyond the report's 360 pages", section_map=m)

    def older_key():
        from finlib import schema
        OLD = schema.LEGACY_ROW_KEYS[0]
        as_old = lambda r: {(OLD if k == schema.ROW_KEY else k): v for k, v in r.items()}
        check([as_old(_row()), _row(fy="FY25", value=10111.213, original_value=1011121.3, restated=True)])       # old and new rows mixed
        check([as_old(_row())], "already in the data room", existing=[_row()])
        check([_row()], "already in the data room", existing=[as_old(_row())])
        check([_row(**{OLD: "example-housing-finance"})])                                                     # both keys, same value
        check([_row(**{OLD: "another-hfc"})], "disagree")                                                     # both keys, different values

    def files():
        from finlib import schema
        d = tempfile.mkdtemp(); p = os.path.join(d, "annual-report-data.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            f.write('{"primary_context_entity": "example-housing-finance"\n[1,2]\n\n')
        rows, problems = schema.read_jsonl(p)
        errors, _ = validate_rows(rows, problems)
        assert any("line 1: not JSON" in e for e in errors) and any("line 2: not a JSON object" in e for e in errors)
        assert validate_rows([], [])[0] == ["no rows: an empty file is never appended; if nothing could be extracted, say why instead"]

    return [("good rows, including a nil disclosure", good), ("amounts in crore, EPS in rupees", units_rules), ("pages and basis", pages_and_basis),
            ("financial years", years), ("duplicates and dimension", duplicates_and_dimension), ("restructured-book items rejected", restructured),
            ("against what the data room already holds", against_the_data_room), ("against the section map", against_the_map),
            ("rows under the key's older name, and mixed rows", older_key), ("broken lines and empty files", files)]


def main():
    ap = argparse.ArgumentParser(description="Validate annual-report-data.jsonl rows (schema plus domain rules) before they are appended.",
                                 epilog="Example: validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json --existing /workspace/in/annual-report-data.jsonl")
    ap.add_argument("jsonl", nargs="?", help="the NEW rows to append, one JSON object per line")
    ap.add_argument("--existing", help="the annual-report-data.jsonl already in the data room (fetched to the sandbox); checks duplicates and restatements")
    ap.add_argument("--map", help="the report's map.json; checks pages against its offsets and page count")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.jsonl:
        C.die("give the jsonl file of new rows")
    from finlib import schema
    for path in (args.jsonl, args.existing):
        if path and not os.path.exists(path):
            C.die(f"no such file: {path}")
    rows, problems = schema.read_jsonl(args.jsonl)
    existing = schema.read_jsonl(args.existing)[0] if args.existing else None
    section_map = C.read_json_arg(args.map) if args.map else None
    errors, warnings = validate_rows(rows, problems, existing, section_map)
    C.emit({"valid": not errors, "rows": len(rows), "errors": errors, "warnings": warnings})
    if errors:
        C.die(f"{len(errors)} error(s): nothing is appended to annual-report-data.jsonl until they are fixed", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
