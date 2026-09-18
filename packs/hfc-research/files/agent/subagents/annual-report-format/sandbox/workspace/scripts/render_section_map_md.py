#!/usr/bin/env python3
"""map.json -> the content of Customers/{customer_id}/filings/lodr/{fy}_annual-report-map.md.

The map is validated first (validate_section_map.py's rules); an invalid map is not rendered. The markdown ends with
the map itself in a fenced JSON block, so next year (or the next request) the map is read back with --extract instead
of being rebuilt:
  render_section_map_md.py --extract /workspace/in/FY26_annual-report-map.md > /workspace/out/map.json

stdout is JSON: {"dataroom_path", "markdown", "warnings"}; --out also writes the markdown to a file.
"""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C
import section_map as SM
import validate_section_map as V

BEGIN, END = "<!-- section-map-json:begin -->", "<!-- section-map-json:end -->"


def _cell(v):
    return "" if v is None else str(v).replace("|", "\\|").replace("\n", " ")


def _pages(a, b):
    return _cell(a) if b in (None, a) else f"{_cell(a)}-{_cell(b)}"


def render(m, table=None):
    table = table or SM.load_table()
    titles = {e["key"]: e["title"] for e in table["sections"]}
    def title_of(key):
        e = SM.entry_for_key(table, key)
        t = titles.get(e["key"], key) if e else key
        return f"{t} ({key.split('_')[0]})" if e and e.get("contextual") else t

    L = [f"# Annual report map: {m['customer_id']} {m['fy']}", ""]
    L += [f"- Source file: `{m.get('source_file') or 'not recorded'}`",
          f"- Pages in the PDF: {m['page_count']}",
          f"- Text layer: {m.get('content_type') or 'not checked'}"
          + (f" (image pages: {_ranges(m['image_pages'])})" if m.get("image_pages") else ""),
          f"- Built from: {m.get('method_summary') or 'not recorded'}", ""]
    L += ["Printed page = the number printed on the page. PDF page = the page's position in the file, counting from 1. "
          "They differ; every figure extracted from this report cites both.", ""]
    L += ["## Printed page to PDF page", ""]
    if m.get("offsets"):
        L += ["| Numbering | Printed pages | PDF pages sampled | Rule |", "|---|---|---|---|"]
        for s in m["offsets"]:
            rule = (f"PDF page = printed page {'+' if s['offset'] >= 0 else '-'} {abs(s['offset'])}" if s.get("pages_per_pdf_page") == 1
                    else f"double-page spreads: PDF page = (printed page {'-' if s['b'] >= 0 else '+'} {abs(s['b'])}) / 2, rounded down")
            if s.get("single_sample"):
                rule += " (one sample only)"
            L.append(f"| {s['style']} | {_cell(s.get('first_printed'))}-{_cell(s.get('last_printed'))} | {s['from_pdf_page']}-{s['to_pdf_page']} | {rule} |")
    else:
        L.append("No offset could be established; PDF pages below were read directly.")
    for x in m.get("offset_inconsistencies") or []:
        L.append(f"- Note: {x}")
    L += ["", "## Sections", "", "| Section | Title as printed | Printed page | PDF page | Found by | Confidence |", "|---|---|---|---|---|---|"]
    located = [s for s in m["sections"] if s.get("pdf_page")]
    for s in located:
        indent = "- " if s.get("level") == "sub" else ""
        L.append(f"| {indent}{title_of(s['key'])} | {_cell(s.get('title_as_printed'))} | {_pages(s.get('printed_page'), s.get('end_printed_page'))} | "
                 f"{_pages(s.get('pdf_page'), s.get('end_pdf_page'))} | {_cell(s.get('method')).replace('_', ' ')} | {s['confidence']} |")
    missing = [s for s in m["sections"] if not s.get("pdf_page")]
    L += ["", "## Not located", ""]
    L += [f"- {title_of(s['key'])}: {'; '.join(s.get('notes') or ['no note'])}" for s in missing] or ["Every section in the index was located."]
    noted = [s for s in located if s.get("notes") or s.get("candidates")]
    if noted:
        L += ["", "## Notes on located sections", ""]
        for s in noted:
            extra = f" Other candidate PDF pages: {s['candidates']}." if s.get("candidates") else ""
            L.append(f"- {title_of(s['key'])}: {'; '.join(s.get('notes') or [])}{extra}")
    lay = m.get("layout") or {}
    if lay:
        L += ["", "## Layout", ""]
        L += [f"- Statement order: {_cell(lay.get('statement_order')).replace('_', ' ')}",
              f"- Statutory reports before corporate information: {_cell(lay.get('statutory_reports_first'))}",
              f"- Notice of AGM inside the report: {_cell(lay.get('notice_of_agm_inside'))}",
              f"- BRSR inside the report: {_cell(lay.get('brsr_inside'))}"]
        if lay.get("report_style"):
            L.append(f"- Report style: {lay['report_style'].replace('_', ' ')}")
        L += [f"- {n}" for n in lay.get("notes") or []]
    if m.get("layout_memories"):
        L += ["", "## Worth remembering next year", ""] + [f"- {x}" for x in m["layout_memories"]]
    if m.get("other_entries"):
        L += ["", "## Other contents entries", "", "| Title | Printed page | PDF page |", "|---|---|---|"]
        L += [f"| {_cell(o.get('title'))} | {_cell(o.get('printed_page'))} | {_cell(o.get('pdf_page'))} |" for o in m["other_entries"]]
    L += ["", "## Machine-readable map", "", "Read back with `python3 /workspace/scripts/render_section_map_md.py --extract <this file>`.", "",
          BEGIN, "```json", json.dumps(m, ensure_ascii=False, indent=1), "```", END, ""]
    return "\n".join(L)


def _ranges(pages):
    out = []
    for p in sorted(set(pages)):
        if out and p == out[-1][1] + 1:
            out[-1][1] = p
        else:
            out.append([p, p])
    return ", ".join(str(a) if a == b else f"{a}-{b}" for a, b in out)


def extract(markdown):
    m = re.search(re.escape(BEGIN) + r"\s*```json\s*(.*?)\s*```\s*" + re.escape(END), markdown, re.S)
    if not m:
        return None, "no machine-readable map block in the file (it was not written by this script); rebuild the map"
    try:
        return json.loads(m.group(1)), None
    except json.JSONDecodeError as x:
        return None, f"the map block is not valid JSON ({x.msg}); rebuild the map"


def dataroom_path(m):
    return f"Customers/{m['customer_id']}/filings/lodr/{m['fy']}_annual-report-map.md"


def _cases():
    def good_render_and_round_trip():
        m = V._good_map()
        m["image_pages"] = [1, 2, 3, 120]
        m["layout_memories"] = ["RBI disclosures are Note 52, after the related-party note"]
        md = render(m)
        assert md.startswith("# Annual report map: example-housing-finance FY26")
        assert "| roman | i-ii | 3-4 | PDF page = printed page + 2 |" in md, md[:1500]
        assert "| arabic | 1-342 | 9-350 | PDF page = printed page + 8 |" in md
        assert "| Board's / Directors' Report | Board's Report | 30-61 | 38-69 | contents | unconfirmed |" in md
        assert "| - Balance sheet (standalone) | Balance Sheet | 164 | 172 | contents | unconfirmed |" in md
        assert "- RBI HFC Directions disclosures: not located" in md and "image pages: 1-3, 120" in md
        assert "RBI disclosures are Note 52" in md and "| Chairman's Message | 4 | 12 |" in md
        back, err = extract(md)
        assert err is None and back == m
        assert dataroom_path(m) == "Customers/example-housing-finance/filings/lodr/FY26_annual-report-map.md"

    def spreads_rule_text():
        m = V._good_map()
        m["offsets"] = [{"style": "arabic", "pages_per_pdf_page": 2, "b": -2, "offset": None, "from_pdf_page": 2, "to_pdf_page": 40,
                         "first_printed": "2", "last_printed": "79", "samples": 4, "single_sample": False}]
        assert "double-page spreads: PDF page = (printed page + 2) / 2, rounded down" in render(m)

    def pipes_escaped():
        m = V._good_map()
        m["sections"][0]["title_as_printed"] = "Corporate | Information"
        assert "Corporate \\| Information" in render(m)

    def extract_failures():
        assert extract("# A map typed by hand\n")[0] is None
        assert "not valid JSON" in extract(f"{BEGIN}\n```json\n{{oops\n```\n{END}")[1]

    return [("render and read back", good_render_and_round_trip), ("spread offsets are explained", spreads_rule_text),
            ("table cells are escaped", pipes_escaped), ("extract failures are reported", extract_failures)]


def main():
    ap = argparse.ArgumentParser(description="Render a validated map.json as the {fy}_annual-report-map.md file, or read the map back out of one.",
                                 epilog="Example: render_section_map_md.py /workspace/out/map.json --out /workspace/out/FY26_annual-report-map.md")
    ap.add_argument("map", nargs="?", help="map.json, or - for stdin")
    ap.add_argument("--out", help="write the markdown here as well")
    ap.add_argument("--extract", metavar="MAP_MD", help="read the map back out of a rendered .md file and print it as JSON")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if args.extract:
        if not os.path.exists(args.extract):
            C.die(f"no such file: {args.extract}")
        m, err = extract(open(args.extract, encoding="utf-8").read())
        if err:
            C.die(err, C.EXIT_CHECK_FAILED)
        C.emit(m); return
    if not args.map:
        C.die("give map.json, or --extract <map.md>")
    m = C.read_json_arg(args.map)
    errors, warnings = V.validate(m)
    if errors:
        C.die("the map is not valid, so it is not rendered: " + "; ".join(errors), C.EXIT_CHECK_FAILED)
    md = render(m)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(md)
    C.emit({"dataroom_path": dataroom_path(m), "markdown_file": args.out, "markdown": md, "warnings": warnings})


if __name__ == "__main__":
    main()
