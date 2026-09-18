#!/usr/bin/env python3
"""Stitch one table that runs over consecutive pages into a single table, and say which pages were stitched.

Input (file or - for stdin):
  {"pages": [{"pdf_page": 212, "printed_page": "204", "header": ["Particulars", "As at March 31, 2026", "As at March 31, 2025"],
              "rows": [["Housing loans", "1,23,456.00", "1,00,234.00"], ...]},
             {"pdf_page": 213, "header": null, "rows": [...]}]}

Rules:
  - pages must be consecutive PDF pages, in order;
  - every row on every page must have the same number of columns as the first page's header: otherwise the
    script REFUSES (exit 1) rather than shift values under the wrong heading;
  - a later page's header is dropped when it repeats the first (ignoring case, spacing, '(contd.)' markers);
    a later page with no header continues the table; a DIFFERENT header means a different table: refused;
  - 'carried forward' / 'brought forward' rows are dropped and listed;
  - a label-only last row followed by a label-less first row on the next page is one row split by the page break:
    merged and listed.
Cell text is never altered; parsing numbers is normalise_statement.py's job.
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C

_CONTD = re.compile(r"\(?\s*\b(contd|cont'd|continued)\b\.?\s*\)?", re.I)
_CARRY = re.compile(r"\b(carried|brought)\s+(forward|over|down)\b|\b[cb]\s*/\s*[fd]\b", re.I)


def _norm_header(header):
    return [re.sub(r"[^a-z0-9]+", " ", _CONTD.sub("", C.clean(c)).lower()).strip() for c in header]


def _blank(cell):
    return C.clean(cell) == ""


class Refused(Exception):
    pass


def stitch(pages):
    if not isinstance(pages, list) or not pages:
        raise Refused("no pages given")
    for i, p in enumerate(pages):
        if not isinstance(p, dict) or isinstance(p.get("pdf_page"), bool) or not isinstance(p.get("pdf_page"), int):
            raise Refused(f"page {i}: pdf_page (integer) is required")
        if not isinstance(p.get("rows"), list):
            raise Refused(f"pdf page {p['pdf_page']}: rows (a list of lists) is required")
    nums = [p["pdf_page"] for p in pages]
    if nums != sorted(nums) or any(b - a != 1 for a, b in zip(nums, nums[1:])):
        raise Refused(f"pdf pages {nums} are not consecutive and in order; a table is only stitched across adjoining pages")
    header = pages[0].get("header")
    if not header:
        raise Refused(f"pdf page {nums[0]}: the first page must carry the table's header row")
    width = len(header)
    base = _norm_header(header)
    rows, dropped, merged, headers_dropped = [], [], [], []
    for p in pages:
        h = p.get("header")
        if h and p is not pages[0]:
            if len(h) != width:
                raise Refused(f"pdf page {p['pdf_page']}: header has {len(h)} columns, the first page has {width}")
            if _norm_header(h) != base:
                raise Refused(f"pdf page {p['pdf_page']}: header {h} differs from the first page's {header}; this is a different table")
            headers_dropped.append(p["pdf_page"])
        first_on_page = True
        for r_i, row in enumerate(p["rows"]):
            if not isinstance(row, list):
                raise Refused(f"pdf page {p['pdf_page']} row {r_i}: not a list")
            if len(row) != width:
                raise Refused(f"pdf page {p['pdf_page']} row {r_i} has {len(row)} columns, the header has {width}: {row}")
            if all(_blank(c) for c in row):
                continue
            label = C.clean(row[0])
            if _norm_header(row) == base:
                headers_dropped.append(p["pdf_page"]); continue            # header repeated inside the rows
            if _CARRY.search(label):
                dropped.append({"pdf_page": p["pdf_page"], "row": row, "why": "carried/brought forward subtotal"}); continue
            if _CONTD.search(label) and all(_blank(c) for c in row[1:]):
                dropped.append({"pdf_page": p["pdf_page"], "row": row, "why": "continuation marker"}); continue
            if (first_on_page and p is not pages[0] and rows and _blank(row[0]) and any(not _blank(c) for c in row[1:])
                    and all(_blank(c) for c in rows[-1]["cells"][1:]) and rows[-1]["pdf_page"] == p["pdf_page"] - 1):
                prev = rows[-1]
                prev["cells"] = [prev["cells"][0]] + row[1:]
                prev["pdf_pages"] = [prev["pdf_page"], p["pdf_page"]]
                merged.append({"label": prev["cells"][0], "pdf_pages": prev["pdf_pages"]})
                first_on_page = False
                continue
            first_on_page = False
            rows.append({"cells": list(row), "pdf_page": p["pdf_page"], "printed_page": p.get("printed_page")})
    return {"stitched": len(pages) > 1, "header": header, "columns": width,
            "pdf_pages": nums, "printed_pages": [p.get("printed_page") for p in pages],
            "rows": rows, "row_count": len(rows), "repeated_headers_dropped_on": sorted(set(headers_dropped)),
            "rows_dropped": dropped, "rows_merged_across_pages": merged,
            "say": (f"Table stitched from pdf pages {nums[0]}-{nums[-1]}." if len(pages) > 1 else f"Table on pdf page {nums[0]} only.")}


def _cases():
    H = ["Particulars", "As at March 31, 2026", "As at March 31, 2025"]

    def repeated_header():
        r = stitch([{"pdf_page": 212, "printed_page": "204", "header": H, "rows": [["Housing loans", "1,23,456.00", "1,00,234.00"], ["Total c/f", "1,23,456.00", "1,00,234.00"]]},
                    {"pdf_page": 213, "printed_page": "205", "header": ["Particulars (Contd.)", "As at  March 31, 2026", "As at March 31, 2025"],
                     "rows": [["Total b/f", "1,23,456.00", "1,00,234.00"], ["Non-housing loans", "23,456.00", "20,111.00"], ["Total", "1,46,912.00", "1,20,345.00"]]}])
        assert r["stitched"] and r["pdf_pages"] == [212, 213] and r["row_count"] == 3, r
        assert [x["cells"][0] for x in r["rows"]] == ["Housing loans", "Non-housing loans", "Total"]
        assert len(r["rows_dropped"]) == 2 and r["repeated_headers_dropped_on"] == [213]
        assert r["rows"][1]["pdf_page"] == 213 and r["rows"][1]["printed_page"] == "205"
        assert r["say"] == "Table stitched from pdf pages 212-213."

    def continuation_without_header():
        r = stitch([{"pdf_page": 10, "header": H, "rows": [["A", "1", "2"]]}, {"pdf_page": 11, "header": None, "rows": [["B", "3", "4"]]},
                    {"pdf_page": 12, "rows": [["", "", ""], ["C", "5", "6"]]}])
        assert r["row_count"] == 3 and r["pdf_pages"] == [10, 11, 12]

    def header_repeated_as_row():
        r = stitch([{"pdf_page": 10, "header": H, "rows": [["A", "1", "2"]]}, {"pdf_page": 11, "rows": [list(H), ["B", "3", "4"]]}])
        assert r["row_count"] == 2 and r["repeated_headers_dropped_on"] == [11]

    def split_row():
        r = stitch([{"pdf_page": 10, "header": H, "rows": [["A", "1", "2"], ["Loans to developers for residential projects", "", ""]]},
                    {"pdf_page": 11, "rows": [["", "7", "8"], ["C", "5", "6"]]}])
        assert r["row_count"] == 3 and r["rows"][1]["cells"] == ["Loans to developers for residential projects", "7", "8"], r["rows"]
        assert r["rows_merged_across_pages"] == [{"label": "Loans to developers for residential projects", "pdf_pages": [10, 11]}]

    def sub_heading_rows_are_not_merged_within_a_page():
        r = stitch([{"pdf_page": 10, "header": H, "rows": [["Secured", "", ""], ["", "7", "8"]]}])
        assert r["row_count"] == 2 and r["rows_merged_across_pages"] == [] and r["stitched"] is False

    def refuses(pages, word):
        try:
            stitch(pages)
        except Refused as x:
            assert word in str(x), str(x); return
        raise AssertionError("stitched something it should have refused")

    def refusals():
        refuses([{"pdf_page": 10, "header": H, "rows": [["A", "1", "2"]]}, {"pdf_page": 11, "rows": [["B", "3", "4", "5"]]}], "4 columns")
        refuses([{"pdf_page": 10, "header": H, "rows": []}, {"pdf_page": 12, "rows": []}], "not consecutive")
        refuses([{"pdf_page": 11, "header": H, "rows": []}, {"pdf_page": 10, "rows": []}], "not consecutive")
        refuses([{"pdf_page": 10, "header": H, "rows": []}, {"pdf_page": 11, "header": ["Particulars", "Stage 1", "Stage 2"], "rows": []}], "different table")
        refuses([{"pdf_page": 10, "rows": [["A", "1", "2"]]}], "header")
        refuses([], "no pages")
        refuses([{"pdf_page": "10", "header": H, "rows": []}], "pdf_page")

    return [("repeated header and c/f, b/f rows", repeated_header), ("continuation pages without a header", continuation_without_header),
            ("header repeated inside the rows", header_repeated_as_row), ("row split by the page break", split_row),
            ("sub-heading rows are left alone", sub_heading_rows_are_not_merged_within_a_page), ("refusals", refusals)]


def main():
    ap = argparse.ArgumentParser(description="Stitch a table that spans consecutive pages; refuses when column counts disagree.",
                                 epilog="Example: stitch_tables.py /workspace/out/loans-note-pages.json > /workspace/out/loans-note-table.json")
    ap.add_argument("pages", nargs="?", help='JSON {"pages": [...]} file, or - for stdin')
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.pages:
        C.die("give the pages JSON file, or - for stdin")
    data = C.read_json_arg(args.pages)
    pages = data.get("pages") if isinstance(data, dict) else data
    try:
        C.emit(stitch(pages))
    except Refused as x:
        C.emit({"stitched": False, "refused": str(x)})
        C.die(f"refused: {x}", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
