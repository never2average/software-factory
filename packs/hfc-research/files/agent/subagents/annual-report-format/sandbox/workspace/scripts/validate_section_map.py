#!/usr/bin/env python3
"""Validate a section map (map.json) before it is rendered, written to the data room or relied on for extraction.

Schema: ../schemas/section-map.schema.json. Rules a schema cannot express:
  - fy is a financial year; every required section is present, found or explicitly not_found with a note saying why;
  - no section key appears twice;
  - every page lies inside the document; a section does not end before it starts;
  - report sections run in ascending order and do not overlap; printed page numbers ascend with the PDF pages
    unless the offsets show that numbering restarts;
  - a note-level section lies inside its parent's page range;
  - every (printed_page, pdf_page) pair agrees with the map's own offset segments;
  - offset segments are in order and do not overlap.
Exit 0 when there are no errors (warnings allowed), 1 otherwise.
"""
import argparse, copy, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C
import page_offset as PO
import section_map as SM


def validate(m, table=None):
    from finlib import schema
    table = table or SM.load_table()
    m, key_problems = schema.normalise_row(m)       # a map stored under the key's older name reads as the new key
    errors = [f"schema: {p}" for p in key_problems + schema.validate(m, C.load_schema("section-map.schema.json"))]
    warnings = []
    if not isinstance(m, dict) or not isinstance(m.get("sections"), list):
        return errors or ["not a section map"], warnings
    if isinstance(m.get("fy"), str) and C.fy_label(m["fy"]) != m["fy"]:
        errors.append(f"fy {m['fy']!r} is not a financial year written as FY26")
    n = m.get("page_count") if isinstance(m.get("page_count"), int) else None
    secs = [s for s in m["sections"] if isinstance(s, dict) and isinstance(s.get("key"), str)]
    keys = [s["key"] for s in secs]
    for k in sorted({k for k in keys if keys.count(k) > 1}):
        errors.append(f"section {k} appears {keys.count(k)} times")
    by = {s["key"]: s for s in secs}
    for k in SM.required_keys(table):
        if k not in by:
            errors.append(f"required section {k} is missing: list it as not_found with a note if the report does not have it")
    segments = m.get("offsets") if isinstance(m.get("offsets"), list) else []
    for i, s in enumerate(segments):
        if isinstance(s, dict) and isinstance(s.get("from_pdf_page"), int) and isinstance(s.get("to_pdf_page"), int):
            if s["from_pdf_page"] > s["to_pdf_page"]:
                errors.append(f"offsets[{i}]: from_pdf_page {s['from_pdf_page']} is after to_pdf_page {s['to_pdf_page']}")
            if i and isinstance(segments[i - 1], dict) and isinstance(segments[i - 1].get("to_pdf_page"), int) and s["from_pdf_page"] <= segments[i - 1]["to_pdf_page"]:
                errors.append(f"offsets[{i}] starts at pdf page {s['from_pdf_page']}, inside the previous segment")
            if n and s["to_pdf_page"] > n:
                errors.append(f"offsets[{i}] runs to pdf page {s['to_pdf_page']}, beyond the page count {n}")
    restart = any("restart" in str(x) for x in m.get("offset_inconsistencies") or [])
    if not segments and any(s.get("pdf_page") for s in secs):
        warnings.append("the map has no offsets, so printed and PDF pages cannot be cross-checked")

    for s in secs:
        k, p, e = s["key"], s.get("pdf_page"), s.get("end_pdf_page")
        conf = s.get("confidence")
        if conf == "not_found":
            if not s.get("notes"):
                errors.append(f"{k}: not_found needs a note saying where it was looked for")
            continue
        if not isinstance(p, int):
            if conf == "found":
                errors.append(f"{k}: confidence is found but there is no pdf_page")
            else:
                warnings.append(f"{k}: unconfirmed and without a pdf_page; find the page or mark it not_found")
            continue
        if n and p > n:
            errors.append(f"{k}: pdf_page {p} is beyond the page count {n}")
        if isinstance(e, int):
            if e < p:
                errors.append(f"{k}: ends on pdf page {e}, before it starts on {p}")
            if n and e > n:
                errors.append(f"{k}: end_pdf_page {e} is beyond the page count {n}")
        if conf == "found" and not s.get("title_as_printed"):
            warnings.append(f"{k}: found, but title_as_printed is empty; record the heading as the report prints it")
        if conf == "unconfirmed":
            warnings.append(f"{k}: start page unconfirmed; open pdf page {p} and check the heading before extracting")
        if s.get("printed_page") is None:
            warnings.append(f"{k}: no printed page recorded (acceptable only when the page carries no number)")
        elif segments:
            msg = PO.check_pair(segments, s["printed_page"], p, n)
            if msg:
                errors.append(f"{k}: {msg}")
        img = set(m.get("image_pages") or [])
        if p in img:
            warnings.append(f"{k}: starts on an image page; its text cannot be extracted, report it as scanned")
        entry = SM.entry_for_key(table, k)
        if s.get("level") == "sub":
            parent = by.get(s.get("parent") or "")
            if s.get("parent") and parent is None:
                errors.append(f"{k}: parent {s['parent']} is not in the map")
            elif parent and isinstance(parent.get("pdf_page"), int):
                lo, hi = parent["pdf_page"], parent.get("end_pdf_page") or n or 10 ** 6
                if not lo <= p <= hi:
                    errors.append(f"{k}: pdf page {p} lies outside its parent {parent['key']} (pdf pages {lo}-{hi})")
        if entry and entry.get("contextual") and s.get("basis") not in ("standalone", "consolidated"):
            errors.append(f"{k}: basis must say standalone or consolidated")

    tops = sorted((s for s in secs if s.get("level") == "top" and isinstance(s.get("pdf_page"), int)), key=lambda s: s["pdf_page"])
    for a, b in zip(tops, tops[1:]):
        if isinstance(a.get("end_pdf_page"), int):
            if a["end_pdf_page"] > b["pdf_page"] or (a["end_pdf_page"] == b["pdf_page"] and a["pdf_page"] == b["pdf_page"]):
                # the auditor's report sits inside the financial statements in most reports: that nesting is expected
                if not _nested_ok(a, b):
                    errors.append(f"{a['key']} (pdf pages {a['pdf_page']}-{a['end_pdf_page']}) overlaps {b['key']} (starts {b['pdf_page']})")
            elif a["end_pdf_page"] == b["pdf_page"]:
                warnings.append(f"{a['key']} ends on the page where {b['key']} starts (pdf page {b['pdf_page']}); fine if the section starts mid-page")
        pa, pb = C.parse_page_label(a.get("printed_page")), C.parse_page_label(b.get("printed_page"))
        if pa and pb and pa["style"] == pb["style"] == "arabic" and pb["value"] < pa["value"]:
            (warnings if restart else errors).append(
                f"printed pages go backwards: {a['key']} is printed page {a['printed_page']}, the later {b['key']} is {b['printed_page']}"
                + (" (numbering restarts, per the offsets)" if restart else ""))
    return errors, warnings


def _nested_ok(a, b):
    pair = {a["key"], b["key"]}
    # MD&A, the corporate governance report and BRSR are annexures to the Board's Report in some reports
    if a["key"] == "directors_report" and b["key"] in ("mdna", "corporate_governance_report", "brsr") \
            and isinstance(a.get("end_pdf_page"), int) and (b.get("end_pdf_page") or b["pdf_page"]) <= a["end_pdf_page"]:
        return True
    for basis in SM.BASES:
        if pair == {f"{basis}_auditors_report", f"{basis}_financial_statements"}:
            return True
    return False


def _good_map():
    table = SM.load_table()
    seg = PO.compute_segments([[3, "i"], [4, "ii"], [9, "1"], [10, "2"], [200, "192"], [350, "342"]], 360)
    entries = SM.parse_toc_lines(SM.TOC_SINGLE, table)["entries"]
    return SM.build_map(entries, "contents", table, seg["segments"], seg["inconsistencies"], 360,
                        {"primary_context_entity": "example-housing-finance", "fy": "FY26", "source_file": "FY26_annual-report.pdf",
                         "content_type": "text", "method_summary": "contents"})


def _cases():
    def sec(m, key):
        return next(s for s in m["sections"] if s["key"] == key)

    def good():
        errors, warnings = validate(_good_map())
        assert errors == [], errors
        assert any("unconfirmed" in w for w in warnings)

    def expect(mutate, word):
        m = copy.deepcopy(_good_map()); mutate(m)
        errors, _ = validate(m)
        assert any(word in e for e in errors), (word, errors)

    def page_rules():
        expect(lambda m: sec(m, "mdna").update(pdf_page=999), "beyond the page count")
        expect(lambda m: sec(m, "mdna").update(end_pdf_page=5), "before it starts")
        expect(lambda m: sec(m, "mdna").update(pdf_page=71), "maps to pdf page 70")
        expect(lambda m: sec(m, "directors_report").update(end_pdf_page=75), "overlaps mdna")
        expect(lambda m: sec(m, "standalone_balance_sheet").update(pdf_page=20, printed_page="12"), "outside its parent")

    def presence_rules():
        expect(lambda m: m["sections"].remove(sec(m, "brsr")), "required section brsr is missing")
        expect(lambda m: m["sections"].append(copy.deepcopy(sec(m, "mdna"))), "appears 2 times")
        expect(lambda m: sec(m, "rbi_hfc_disclosures").update(notes=[]), "needs a note")
        expect(lambda m: sec(m, "mdna").update(confidence="found", pdf_page=None), "schema")
        expect(lambda m: m.update(fy="2025-26"), "schema")
        expect(lambda m: sec(m, "standalone_auditors_report").update(basis=None), "basis must say")

    def ascending_and_restart():
        def backwards(m):
            sec(m, "mdna").update(printed_page="20")
            m["offsets"] = []
        expect(backwards, "printed pages go backwards")
        m = copy.deepcopy(_good_map()); backwards(m)
        m["offset_inconsistencies"] = ["offset changes between pdf pages 60 and 70: printed numbering restarts (a separately paginated part)"]
        errors, warnings = validate(m)
        assert not any("backwards" in e for e in errors) and any("backwards" in w for w in warnings)

    def offsets_rules():
        expect(lambda m: m["offsets"][1].update(from_pdf_page=3), "inside the previous segment")
        expect(lambda m: m["offsets"][1].update(to_pdf_page=900), "beyond the page count")

    def nesting_is_fine():
        m = _good_map()
        assert sec(m, "standalone_auditors_report")["pdf_page"] == sec(m, "standalone_financial_statements")["pdf_page"]
        assert sec(m, "standalone_auditors_report")["end_pdf_page"] == 171          # ends where the balance sheet starts
        assert sec(m, "aoc_1")["parent"] is None                                    # printed after the statements in this report
        assert validate(m)[0] == []

    def mdna_as_an_annexure_to_the_boards_report():
        m = _good_map()
        sec(m, "directors_report").update(end_pdf_page=85)                 # Board's Report runs 38-85 and contains the MD&A (70-85)
        assert validate(m)[0] == [], validate(m)[0]
        sec(m, "directors_report").update(end_pdf_page=80)                 # ...but a partial overlap is still an error
        assert any("overlaps mdna" in e for e in validate(m)[0])

    def image_pages_warn():
        m = _good_map(); m["image_pages"] = [sec(m, "mdna")["pdf_page"]]
        assert any("image page" in w for w in validate(m)[1])

    def garbage():
        assert validate({"sections": "x"})[0] and validate([])[0]

    return [("a good map passes", good), ("page rules", page_rules), ("presence, duplicates, basis", presence_rules),
            ("ascending printed pages unless numbering restarts", ascending_and_restart), ("offset segment rules", offsets_rules),
            ("auditor's report nested in the statements", nesting_is_fine), ("MD&A nested in the Board's Report", mdna_as_an_annexure_to_the_boards_report), ("image pages warn", image_pages_warn), ("garbage input", garbage)]


def main():
    ap = argparse.ArgumentParser(description="Validate a section map: schema plus page, order, overlap, presence and offset rules.",
                                 epilog="Example: validate_section_map.py /workspace/out/map.json")
    ap.add_argument("map", nargs="?", help="map.json, or - for stdin")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.map:
        C.die("give map.json, or - for stdin")
    m = C.read_json_arg(args.map)
    errors, warnings = validate(m)
    secs = m.get("sections", []) if isinstance(m, dict) and isinstance(m.get("sections"), list) else []
    C.emit({"valid": not errors, "errors": errors, "warnings": warnings,
            "summary": {c: sorted(s["key"] for s in secs if isinstance(s, dict) and s.get("confidence") == c) for c in ("found", "unconfirmed", "not_found")}})
    if errors:
        C.die(f"{len(errors)} error(s): the map is not written to the data room until they are fixed", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
