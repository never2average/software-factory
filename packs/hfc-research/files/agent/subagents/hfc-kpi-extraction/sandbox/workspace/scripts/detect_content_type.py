#!/usr/bin/env python3
"""What is this file, and can its numbers be read as text?

  python3 /workspace/scripts/detect_content_type.py /workspace/in/q2fy26-results.pdf
  python3 /workspace/scripts/detect_content_type.py /workspace/in/q2fy26-ip.pptx --find "assets under management" "transferred through assignment"
  python3 /workspace/scripts/detect_content_type.py --self-test

Output: kind (pdf | xlsx | pptx | docx | html | text | unknown) from the file's magic bytes and, for Office files, the parts inside
the zip (never from the extension alone; a mismatch with the extension is reported); page_count (PDF pages, PPTX slides, XLSX sheets);
for PDFs text_layer = text | scanned | mixed with the list of image-only pages, and per --find pattern the pages that mention it.

  text     read tables with pdfplumber
  mixed    the image-only pages cannot be read: a value that sits on one of them is not_found (or needs_review if the analyst
           supplies it); say which pages in the summary
  scanned  no text layer at all. There is no OCR in the sandbox: stop and report the filing as unreadable rather than guess.
An HTML file where a PDF was expected is usually an error page saved by the fetcher: report it to the orchestrator.
Exit 0 = detected; 1 = file missing/unreadable or a PDF whose pages cannot be inspected; 2 = bad usage.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re, tempfile, zipfile
from finlib import pdfdoc

_EXT_KIND = {".pdf": "pdf", ".xlsx": "xlsx", ".xlsm": "xlsx", ".pptx": "pptx", ".docx": "docx", ".html": "html", ".htm": "html", ".txt": "text", ".csv": "text", ".md": "text"}
IMAGE_PAGE_CHARS = 40   # same threshold as finlib.pdfdoc.classify_text_layer


def office_kind(path):
    """-> (kind, count, problem) by looking at the part names inside the zip."""
    try:
        with zipfile.ZipFile(path) as z: names = z.namelist()
    except zipfile.BadZipFile:
        return "unknown", None, "starts like a zip but cannot be opened as one (truncated download?)"
    slides = [n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
    sheets = [n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)]
    if slides or "ppt/presentation.xml" in names: return "pptx", len(slides), None
    if sheets or "xl/workbook.xml" in names: return "xlsx", len(sheets), None
    if "word/document.xml" in names: return "docx", None, None
    return "unknown", None, "a zip file that is not an Office document"


def pdf_chars_per_page(path):
    """[chars] per page. pdfplumber first, pypdf second; both imported lazily. Raises RuntimeError when neither is available."""
    try:
        import pdfplumber
        with pdfplumber.open(path) as pdf: return [len((p.extract_text() or "").strip()) for p in pdf.pages], "pdfplumber"
    except ImportError: pass
    try:
        from pypdf import PdfReader
        return [len((p.extract_text() or "").strip()) for p in PdfReader(path).pages], "pypdf"
    except ImportError:
        raise RuntimeError("neither pdfplumber nor pypdf can be imported; the sandbox installs both, so report this as a sandbox fault")


def describe(path, chars=None, find=None, texts=None):
    """chars / texts can be injected (the self-test does) so that no PDF library is needed."""
    out = {"path": path, "kind": None, "extension": os.path.splitext(path)[1].lower() or None, "extension_matches": None, "size_bytes": None,
           "page_count": None, "page_unit": None, "text_layer": None, "image_pages": None, "problems": [], "advice": None}
    if not os.path.isfile(path): out["problems"].append("no such file"); return out
    out["size_bytes"] = os.path.getsize(path)
    if out["size_bytes"] == 0: out["kind"] = "unknown"; out["problems"].append("the file is empty"); return out
    kind = pdfdoc.sniff(path)
    if kind == "zip-office":
        kind, count, problem = office_kind(path)
        out["page_count"], out["page_unit"] = count, {"pptx": "slides", "xlsx": "sheets"}.get(kind)
        if problem: out["problems"].append(problem)
    out["kind"] = kind
    want = _EXT_KIND.get(out["extension"])
    out["extension_matches"] = None if want is None else want == kind
    if want and want != kind: out["problems"].append(f"the extension says {want} but the content is {kind}")
    if kind == "html": out["advice"] = "HTML where a filing was expected is usually a saved error or login page; ask the orchestrator to have the filing fetched again"
    if kind == "pptx": out["advice"] = "read slides with python-pptx; cite 'slide N'. Numbers inside pictures/charts are not text: a value read off a chart is needs_review"
    if kind == "xlsx": out["advice"] = "read with openpyxl (data_only=True); cite the sheet name and cell as page_or_slide"
    if kind != "pdf": return out
    out["page_unit"] = "pages"
    if chars is None:
        try: chars, out["reader"] = pdf_chars_per_page(path)
        except RuntimeError as x: out["problems"].append(str(x)); return out
        except Exception as x: out["problems"].append(f"the PDF cannot be opened ({type(x).__name__}: {x}); it may be encrypted or damaged"); return out
    out["page_count"] = len(chars)
    out["text_layer"] = pdfdoc.classify_text_layer(chars)
    out["image_pages"] = [i for i, c in enumerate(chars, 1) if c < IMAGE_PAGE_CHARS]
    out["advice"] = {"text": "text PDF: read tables with pdfplumber and cite the PDF page number",
                     "mixed": f"pages {out['image_pages']} are images: values on them cannot be read; everything else reads normally",
                     "scanned": "scanned PDF with no text layer and no OCR in the sandbox: stop and report the filing as unreadable; do not type numbers from memory"}[out["text_layer"]]
    if find:
        if texts is None: texts = pdfdoc.page_texts(path)
        out["found_on_pages"] = pdfdoc.find_pages(texts, find)
    return out


def _self_test():
    fails = []
    def eq(name, got, want):
        if got != want: fails.append(f"{name}: got {got!r}, want {want!r}")
    d = tempfile.mkdtemp()
    def mk(name, data):
        p = os.path.join(d, name)
        with open(p, "wb") as f: f.write(data)
        return p
    def mkzip(name, parts):
        p = os.path.join(d, name)
        with zipfile.ZipFile(p, "w") as z:
            for n in parts: z.writestr(n, "<x/>")
        return p
    pdf = mk("results.pdf", b"%PDF-1.7\n%synthetic\n")
    r = describe(pdf, chars=[1800, 2400, 2100, 1500])
    eq("text pdf", (r["kind"], r["text_layer"], r["page_count"], r["image_pages"], r["problems"]), ("pdf", "text", 4, [], []))
    r = describe(pdf, chars=[0, 12, 0, 3, 0, 0, 0, 0, 0, 0])
    eq("scanned pdf", (r["text_layer"], len(r["image_pages"]), "stop and report" in r["advice"]), ("scanned", 10, True))
    r = describe(pdf, chars=[1800, 0, 2100, 5, 1900, 2200])
    eq("mixed pdf", (r["text_layer"], r["image_pages"]), ("mixed", [2, 4]))
    r = describe(pdf, chars=[500, 600], find=[r"transferred through assignment", r"assets under management"],
                 texts=[(1, "Statement of standalone results"), (2, "Details of loans transferred through assignment")])
    eq("find pages", r["found_on_pages"], {r"transferred through assignment": [2], r"assets under management": []})
    r = describe(mkzip("ip.pptx", ["[Content_Types].xml", "ppt/presentation.xml", "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/slides/_rels/slide1.xml.rels"]))
    eq("pptx", (r["kind"], r["page_count"], r["page_unit"], r["extension_matches"]), ("pptx", 3, "slides", True))
    r = describe(mkzip("data.xlsx", ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]))
    eq("xlsx", (r["kind"], r["page_count"], r["page_unit"]), ("xlsx", 2, "sheets"))
    r = describe(mkzip("note.docx", ["word/document.xml"])); eq("docx", r["kind"], "docx")
    r = describe(mkzip("bundle.zip", ["a.txt"])); eq("plain zip", (r["kind"], bool(r["problems"])), ("unknown", True))
    r = describe(mk("broken.xlsx", b"PK\x03\x04garbage")); eq("truncated office file", (r["kind"], len(r["problems"])), ("unknown", 2))
    r = describe(mk("results-q2.pdf", b"<!DOCTYPE html><html><body>Access denied</body></html>"))
    eq("html saved as pdf", (r["kind"], r["extension_matches"], "fetched again" in r["advice"]), ("html", False, True))
    r = describe(mkzip("deck.pdf", ["ppt/presentation.xml", "ppt/slides/slide1.xml"])); eq("pptx named .pdf", (r["kind"], r["extension_matches"]), ("pptx", False))
    r = describe(mk("notes.txt", "AUM ₹ 10,000 crore".encode())); eq("text", (r["kind"], r["page_count"]), ("text", None))
    r = describe(mk("blob.bin", b"\xff\xfe\x00\x81\x82")); eq("unknown", r["kind"], "unknown")
    r = describe(mk("empty.pdf", b"")); eq("empty file", (r["kind"], r["problems"]), ("unknown", ["the file is empty"]))
    r = describe(os.path.join(d, "missing.pdf")); eq("missing file", r["problems"], ["no such file"])
    return fails, 15


def main():
    ap = argparse.ArgumentParser(description="Detect a filing's real content type (pdf/xlsx/pptx/docx/html/text), page or slide count, and for PDFs whether the pages are text, scanned or mixed.")
    ap.add_argument("file", nargs="?", help="path of the file inside the sandbox")
    ap.add_argument("--find", nargs="+", metavar="REGEX", help="for a PDF: also report the pages whose text matches each case-insensitive regex")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "detect_content_type", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1)); return 1 if fails else 0
    if not a.file: ap.print_help(sys.stderr); return 2
    for rx in a.find or []:
        try: re.compile(rx)
        except re.error as x: print(f"--find {rx!r} is not a valid regex: {x}", file=sys.stderr); return 2
    r = describe(a.file, find=a.find)
    print(json.dumps(r, ensure_ascii=False, indent=1))
    fatal = [p for p in r["problems"] if not p.startswith("the extension says")]
    if fatal: print("; ".join(fatal), file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
