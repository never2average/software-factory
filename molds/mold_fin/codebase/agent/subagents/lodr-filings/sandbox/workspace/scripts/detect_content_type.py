#!/usr/bin/env python3
"""What is this file, and can its text be read?

    python3 /workspace/scripts/detect_content_type.py <file>

Prints: kind (pdf | xlsx | pptx | docx | zip-office | xbrl-xml | xml | html | markdown | text | unknown, from the
file's bytes, never the extension), and for a PDF the page count, text layer (text | scanned | mixed), the image
pages, and what that means for extraction. An HTML file saved with a .pdf name is the usual sign that the exchange
returned an error page instead of the document.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, zipfile
from finlib import pdfdoc

IMAGE_PAGE_CHARS = 40   # same threshold as finlib.pdfdoc.classify_text_layer

ADVICE = {
    "text": "Text layer present on every page; extract normally.",
    "scanned": "Image scan: no text can be extracted. Do not return an empty table. Look for the XBRL or text version "
               "on the exchange, or the company's investor-relations copy (skill scanned-and-image-pdfs); if neither "
               "exists, report the file as a scan.",
    "mixed": "Some pages are images (often the signed auditor's report or the covering letter). Extract the text pages, "
             "list the image pages in the reply, and never treat a missing section as 'not disclosed' when it may sit "
             "on an image page.",
}


def office_kind(path):
    """xlsx | pptx | docx | zip-office from the names inside the zip container."""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except zipfile.BadZipFile:
        return "zip-office"
    for prefix, kind in (("xl/", "xlsx"), ("ppt/", "pptx"), ("word/", "docx")):
        if any(n.startswith(prefix) for n in names):
            return kind
    return "zip-office"


def text_kind(path):
    """xbrl-xml | xml | markdown | text for a file that decodes as text."""
    with open(path, "rb") as f:
        head = f.read(4096).decode("utf-8", "ignore").lstrip("﻿").lstrip()
    low = head.lower()
    if low.startswith("<?xml") or low.startswith("<xbrl") or low.startswith("<xbrli:"):
        return "xbrl-xml" if ("xbrl" in low) else "xml"
    if path.lower().endswith(".md") or low.startswith("# ") or low.startswith("source:") or low.startswith("source_url:"):
        return "markdown"
    return "text"


def summarise_pdf(chars_per_page):
    """Pure function over the character counts, so it is testable without a PDF."""
    layer = pdfdoc.classify_text_layer(chars_per_page)
    image_pages = [i for i, c in enumerate(chars_per_page, 1) if c < IMAGE_PAGE_CHARS]
    return {"page_count": len(chars_per_page), "text_layer": layer, "image_pages": image_pages,
            "text_pages": len(chars_per_page) - len(image_pages), "chars_per_page": chars_per_page,
            "advice": ADVICE[layer]}


def detect(path):
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    kind = pdfdoc.sniff(path)
    out = {"file": path, "extension": ext, "size_bytes": os.path.getsize(path)}
    if kind == "zip-office":
        kind = office_kind(path)
    elif kind == "text":
        kind = text_kind(path)
    out["kind"] = kind
    expected = {"pdf": "pdf", "xlsx": "xlsx", "pptx": "pptx", "docx": "docx", "xml": "xbrl-xml", "html": "html", "htm": "html", "md": "markdown"}
    if ext in expected and expected[ext] != kind and not (ext == "xml" and kind == "xml"):
        out["extension_mismatch"] = (f"named .{ext} but the bytes are {kind}"
                                     + ("; an HTML body under a .pdf name is usually an error or login page, not the filing" if kind == "html" and ext == "pdf" else ""))
    if kind == "pdf":
        try:
            texts = pdfdoc.page_texts(path)
        except ImportError:
            raise RuntimeError("pdfplumber is not installed in this sandbox; the sandbox bootstrap should have installed it")
        except Exception as x:   # encrypted or damaged PDF: reported, not guessed around
            out.update({"page_count": None, "text_layer": None, "unreadable": f"{type(x).__name__}: {x}"})
            return out
        out.update(summarise_pdf([len(t.strip()) for _, t in texts]))
    return out


def _self_test():
    import tempfile
    n = 0
    s = summarise_pdf([1800, 2100, 0, 12, 1500, 1700, 900, 800, 1200, 950])
    assert s["text_layer"] == "mixed" and s["image_pages"] == [3, 4] and s["page_count"] == 10 and s["text_pages"] == 8; n += 1
    assert summarise_pdf([0, 0, 5, 0])["text_layer"] == "scanned" and "empty table" in summarise_pdf([0])["advice"]; n += 1
    assert summarise_pdf([900] * 12)["text_layer"] == "text" and summarise_pdf([900] * 12)["image_pages"] == []; n += 1
    # 1 image page in 12 (8%) still classifies as text, but the page is listed so it is not lost
    s = summarise_pdf([900] * 11 + [0]); assert s["text_layer"] == "text" and s["image_pages"] == [12]; n += 1
    assert summarise_pdf([])["text_layer"] == "scanned" and summarise_pdf([])["page_count"] == 0; n += 1
    d = tempfile.mkdtemp()

    def put(name, data):
        p = os.path.join(d, name)
        with open(p, "wb") as f:
            f.write(data)
        return p
    # an exchange error page saved as .pdf
    r = detect(put("results.pdf", b"<!DOCTYPE html><html><body>Access Denied</body></html>"))
    assert r["kind"] == "html" and "error or login page" in r["extension_mismatch"]; n += 1
    r = detect(put("results.xml", b'<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"></xbrli:xbrl>'))
    assert r["kind"] == "xbrl-xml" and "extension_mismatch" not in r; n += 1
    r = detect(put("note.md", "source_url: https://example.invalid/x\n\n# Text of the filing\n".encode()))
    assert r["kind"] == "markdown"; n += 1
    p = os.path.join(d, "sheet.xlsx")
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("xl/workbook.xml", "<x/>")
    assert detect(p)["kind"] == "xlsx"; n += 1
    p = os.path.join(d, "deck.pdf")
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("ppt/presentation.xml", "<x/>")
    r = detect(p); assert r["kind"] == "pptx" and "extension_mismatch" in r; n += 1
    assert detect(put("blob.bin", b"\xff\xfe\x00\x81\x82\x00\x00"))["kind"] == "unknown"; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Detect a file's real kind and, for a PDF, whether it is text, scanned or mixed.")
    ap.add_argument("file", nargs="?"); ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL detect_content_type: {x!r}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "detect_content_type", "cases": n})); return 0
    if not a.file:
        print("give a file path (or --self-test)", file=sys.stderr); return 2
    if not os.path.isfile(a.file):
        print(f"no such file: {a.file}", file=sys.stderr); return 2
    try:
        print(json.dumps(detect(a.file), ensure_ascii=False))
    except RuntimeError as x:
        print(str(x), file=sys.stderr); return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
