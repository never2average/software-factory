#!/usr/bin/env python3
"""What is this file, and can its pages be read as text?

  kind        pdf | zip-office | html | text | unknown      (from the file's first bytes, not its extension)
  text_layer  text | scanned | mixed                        (PDF only; a page with < 40 characters is an image page)
  image_pages every image page, and the same pages as ranges, so a scanned auditor's report inside a text PDF
              shows up as one range that can be laid against the section map

A scanned or mixed result is a finding to report, never a reason to return an empty extract.
pdfplumber is imported only when a real PDF is opened.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C

IMAGE_PAGE_MAX_CHARS = 40       # same threshold as finlib.pdfdoc.classify_text_layer


def ranges(pages):
    """[3,4,5,9] -> [[3,5],[9,9]]"""
    out = []
    for p in sorted(set(pages)):
        if out and p == out[-1][1] + 1:
            out[-1][1] = p
        else:
            out.append([p, p])
    return out


def summarise(chars_per_page, first_page=1, sections=None):
    """chars_per_page: characters extracted from each page, in order, starting at pdf page first_page.
    sections (optional): [{'key', 'pdf_page', 'end_pdf_page'}] from the section map -> which sections are affected."""
    from finlib import pdfdoc
    image_pages = [first_page + i for i, c in enumerate(chars_per_page) if c < IMAGE_PAGE_MAX_CHARS]
    layer = pdfdoc.classify_text_layer(chars_per_page)
    out = {"text_layer": layer, "pages_examined": len(chars_per_page), "first_page_examined": first_page,
           "image_page_count": len(image_pages), "image_pages": image_pages, "image_page_ranges": ranges(image_pages)}
    if sections:
        hit = []
        img = set(image_pages)
        for s in sections:
            a, b = s.get("pdf_page"), s.get("end_pdf_page") or s.get("pdf_page")
            if not a:
                continue
            pages = [p for p in range(a, b + 1) if p in img]
            if pages:
                hit.append({"key": s["key"], "image_pages": len(pages), "section_pages": b - a + 1,
                            "fully_scanned": len(pages) == b - a + 1})
        out["sections_affected"] = hit
    if layer == "scanned":
        out["report"] = "The pages are scanned images: no text can be extracted. Say so; do not return an empty extract."
    elif layer == "mixed" or image_pages:
        out["report"] = ("Some pages are images. Lay image_page_ranges against the section map: a section that falls in "
                         "them is reported as scanned, the rest is extracted as usual.")
    else:
        out["report"] = None
    return out


def detect(path, first=None, last=None, sections=None):
    from finlib import pdfdoc
    kind = pdfdoc.sniff(path)
    out = {"file": os.path.basename(path), "kind": kind, "size_bytes": os.path.getsize(path)}
    if kind != "pdf":
        out.update({"text_layer": None, "page_count": None,
                    "report": f"Not a PDF ({kind}). Annual reports are expected as PDF; say what the file is instead of extracting."})
        return out
    import pdfplumber                                   # lazy: only for a real PDF
    chars = []
    with pdfplumber.open(path) as pdf:
        n = len(pdf.pages)
        a, b = max(first or 1, 1), min(last or n, n)
        if a > b:
            C.die(f"--first {a} is after --last {b} (the file has {n} pages)")
        for i in range(a, b + 1):
            try:
                chars.append(len(pdf.pages[i - 1].chars))
            except Exception as x:
                print(f"pdf page {i}: could not be read ({x}); counted as an image page", file=sys.stderr)
                chars.append(0)
    out["page_count"] = n
    out.update(summarise(chars, a, sections))
    return out


def _cases():
    def all_text():
        r = summarise([900, 1200, 40, 5000])
        assert r["text_layer"] == "text" and r["image_pages"] == [] and r["report"] is None, r

    def all_scanned():
        r = summarise([0, 3, 0, 12, 0, 0, 0, 0, 0, 0])
        assert r["text_layer"] == "scanned" and r["image_page_ranges"] == [[1, 10]] and "do not return an empty extract" in r["report"]

    def scanned_auditors_report_inside_text_pdf():
        chars = [1500] * 60
        for p in range(41, 53):                 # pdf pages 41-52 are scanned
            chars[p - 1] = 0
        sections = [{"key": "directors_report", "pdf_page": 10, "end_pdf_page": 40},
                    {"key": "standalone_auditors_report", "pdf_page": 41, "end_pdf_page": 52},
                    {"key": "standalone_financial_statements", "pdf_page": 41, "end_pdf_page": 60},
                    {"key": "brsr", "pdf_page": None, "end_pdf_page": None}]
        r = summarise(chars, 1, sections)
        assert r["text_layer"] == "mixed" and r["image_page_ranges"] == [[41, 52]], r
        hit = {h["key"]: h for h in r["sections_affected"]}
        assert hit["standalone_auditors_report"]["fully_scanned"] is True
        assert hit["standalone_financial_statements"] == {"key": "standalone_financial_statements", "image_pages": 12, "section_pages": 20, "fully_scanned": False}
        assert "directors_report" not in hit

    def few_image_pages_in_text_pdf():
        chars = [1500] * 100
        chars[0] = 0; chars[1] = 10                                # cover and inside cover
        r = summarise(chars)
        assert r["text_layer"] == "text" and r["image_pages"] == [1, 2] and r["report"] is not None

    def window():
        r = summarise([0, 0, 900], first_page=150)
        assert r["image_pages"] == [150, 151] and r["first_page_examined"] == 150

    def empty_and_ranges():
        assert summarise([])["text_layer"] == "scanned"
        assert ranges([9, 3, 4, 5, 5]) == [[3, 5], [9, 9]] and ranges([]) == []

    def non_pdf():
        import tempfile
        d = tempfile.mkdtemp(); p = os.path.join(d, "report.pdf")
        with open(p, "wb") as f:
            f.write(b"<!DOCTYPE html><html><body>Access denied</body></html>")
        r = detect(p)
        assert r["kind"] == "html" and r["text_layer"] is None and "Not a PDF" in r["report"], r

    def pdf_path_with_a_stub_reader():
        import tempfile, types
        class Page:
            def __init__(self, n): self.chars = [0] * n
        class Doc:
            pages = [Page(0), Page(1500), Page(1500), Page(3), Page(2000)] + [Page(900)] * 45
            def __enter__(self): return self
            def __exit__(self, *a): return False
        stub = types.ModuleType("pdfplumber"); stub.open = lambda path: Doc()
        saved = sys.modules.get("pdfplumber"); sys.modules["pdfplumber"] = stub
        try:
            d = tempfile.mkdtemp(); p = os.path.join(d, "FY26_annual-report.pdf")
            with open(p, "wb") as f:
                f.write(b"%PDF-1.7\n")
            r = detect(p)
            w = detect(p, first=4, last=5)
        finally:
            if saved is None: del sys.modules["pdfplumber"]
            else: sys.modules["pdfplumber"] = saved
        assert r["kind"] == "pdf" and r["page_count"] == 50 and r["text_layer"] == "text" and r["image_pages"] == [1, 4], r
        assert w["pages_examined"] == 2 and w["image_pages"] == [4] and w["text_layer"] == "mixed"

    return [("PDF path with a stub reader", pdf_path_with_a_stub_reader), ("text PDF", all_text), ("fully scanned PDF", all_scanned),
            ("scanned auditor's report inside a text PDF", scanned_auditors_report_inside_text_pdf),
            ("image covers do not make a report mixed", few_image_pages_in_text_pdf), ("page window", window),
            ("empty input and ranges", empty_and_ranges), ("an HTML error page saved as .pdf", non_pdf)]


def main():
    ap = argparse.ArgumentParser(description="Report a file's kind, page count and whether its pages are text, scanned or mixed.",
                                 epilog="Example: detect_content_type.py /workspace/in/FY26_annual-report.pdf --map /workspace/out/map.json")
    ap.add_argument("file", nargs="?", help="the file to examine")
    ap.add_argument("--first", type=int, help="first pdf page to examine (default 1)")
    ap.add_argument("--last", type=int, help="last pdf page to examine (default: the last page)")
    ap.add_argument("--map", help="section map JSON; adds which sections fall on image pages")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.file:
        C.die("give a file")
    if not os.path.exists(args.file):
        C.die(f"no such file: {args.file}")
    sections = C.read_json_arg(args.map).get("sections") if args.map else None
    try:
        C.emit(detect(args.file, args.first, args.last, sections))
    except ImportError as x:
        C.die(f"{x}; the sandbox installs pdfplumber at start-up, see /tmp/eve-doc-libs.log")


if __name__ == "__main__":
    main()
