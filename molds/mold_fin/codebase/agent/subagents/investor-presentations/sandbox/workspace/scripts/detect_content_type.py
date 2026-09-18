#!/usr/bin/env python3
"""What is this file, and can it be read as text?

  python3 /workspace/scripts/detect_content_type.py /workspace/in/deck.pdf

Reports: kind (pdf | pptx | other), the text layer (text | scanned | mixed), the slide/page count, the pages that are
images only, and whether the pages look like slides (landscape) or a document (portrait, e.g. a transcript).
The kind comes from the file's bytes, never from its extension. A .pptx is inspected with the standard library
(it is a zip of XML); a PDF needs pdfplumber, which is imported only when a real PDF is read.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, io, re, zipfile
from finlib import pdfdoc
from iplib import emit, fail

IMAGE_PAGE_CHARS = 40  # same threshold finlib.pdfdoc.classify_text_layer uses


def office_kind(names):
    """pptx | xlsx | docx | zip from the member names of an office zip."""
    s = set(names)
    if "ppt/presentation.xml" in s: return "pptx"
    if "xl/workbook.xml" in s: return "xlsx"
    if "word/document.xml" in s: return "docx"
    return "zip"


def pptx_slide_stats(zf):
    """[(slide_file_number, chars_of_text, picture_count)] for every ppt/slides/slideN.xml, by file number.
    File number is NOT always presentation order; slide_index.py (python-pptx) gives the true order."""
    out = []
    for name in zf.namelist():
        m = re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name)
        if not m:
            continue
        xml = zf.read(name).decode("utf-8", "replace")
        text = "".join(re.findall(r"<a:t(?:\s[^>]*)?>([^<]*)</a:t>", xml))
        out.append((int(m.group(1)), len(text.strip()), len(re.findall(r"<p:pic[\s>]", xml))))
    return sorted(out)


def summarise(kind, chars_per_page, extra=None):
    image_pages = [i for i, c in enumerate(chars_per_page, 1) if c < IMAGE_PAGE_CHARS]
    layer = pdfdoc.classify_text_layer(chars_per_page)
    out = {"kind": kind, "text_layer": layer, "slide_count": len(chars_per_page), "image_only_slides": image_pages,
           "chars_per_slide": chars_per_page}
    if extra: out.update(extra)
    out["advice"] = advice(kind, layer, image_pages, out.get("looks_like"))
    return out


def advice(kind, layer, image_pages, looks_like):
    if kind == "other":
        return "Not a PDF or PPTX. Do not extract from it; report what the file is."
    if layer == "scanned":
        return ("No usable text layer. Do not type numbers from the image into ip-metrics.jsonl as exact. "
                "Report that the deck is scanned and look for a text version (exchange filing vs company IR page).")
    if layer == "mixed":
        return (f"Slides {image_pages} have little or no text (section dividers, charts or pasted images). Figures on them fall under the "
                "chart-only-figures skill; everything else reads normally.")
    if looks_like == "document":
        return "Text layer present, portrait pages: this reads like a transcript or a letter, not a deck."
    return "Text layer present. Run slide_index.py next."


def inspect_pdf(path):
    import pdfplumber  # lazy: only when a real PDF is read
    chars, landscape = [], 0
    with pdfplumber.open(path) as pdf:
        for p in pdf.pages:
            chars.append(len((p.extract_text() or "").strip()))
            if p.width and p.height and p.width > p.height: landscape += 1
    n = len(chars)
    looks = None if n == 0 else "slides" if landscape / n >= 0.6 else "document" if landscape / n <= 0.2 else "mixed_orientation"
    return summarise("pdf", chars, {"landscape_pages": landscape, "looks_like": looks})


def inspect_pptx(path_or_bytes):
    with zipfile.ZipFile(path_or_bytes) as zf:
        k = office_kind(zf.namelist())
        if k != "pptx":
            return {"kind": "other", "detail": k, "text_layer": None, "slide_count": None, "image_only_slides": [],
                    "advice": advice("other", None, [], None)}
        stats = pptx_slide_stats(zf)
    out = summarise("pptx", [c for _, c, _ in stats], {"looks_like": "slides", "pictures_per_slide": [p for _, _, p in stats],
                    "note": "slide numbers here follow the slide file numbers; slide_index.py reports presentation order"})
    return out


def inspect(path):
    if not os.path.isfile(path):
        fail(f"no such file: {path}")
    sniffed = pdfdoc.sniff(path)
    if sniffed == "pdf":
        try:
            out = inspect_pdf(path)
        except ImportError:
            fail("pdfplumber is not installed in this sandbox; cannot read the PDF's text layer", 3)
        except Exception as x:  # encrypted or damaged
            fail(f"could not open the PDF ({type(x).__name__}: {x}); report the file as unreadable", 4)
    elif sniffed == "zip-office":
        try:
            out = inspect_pptx(path)
        except zipfile.BadZipFile:
            fail("the file starts like an office document but is not a readable zip; report it as damaged", 4)
    else:
        out = {"kind": "other", "detail": sniffed, "text_layer": None, "slide_count": None, "image_only_slides": [],
               "advice": advice("other", None, [], None)}
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    out["file"] = path
    out["extension_matches"] = (ext == out["kind"]) if out["kind"] in ("pdf", "pptx") else None
    return out


def _fake_pptx(slides):
    """In-memory .pptx-shaped zip. slides: list of (text, n_pictures)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("ppt/presentation.xml", "<p:presentation/>")
        for i, (text, pics) in enumerate(slides, 1):
            body = "".join(f"<a:p><a:r><a:t>{t}</a:t></a:r></a:p>" for t in text.split("|") if t)
            zf.writestr(f"ppt/slides/slide{i}.xml", f"<p:sld><p:cSld>{body}{'<p:pic><p:blipFill/></p:pic>' * pics}</p:cSld></p:sld>")
    buf.seek(0)
    return buf


def _self_test():
    import tempfile
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})

    long = "Example Housing Finance Ltd|Key highlights for Q2 FY26|AUM Rs 12,345 crore, disbursements Rs 1,050 crore"
    r = inspect_pptx(_fake_pptx([(long, 0), (long, 1), (long, 0)]))
    ok("pptx: text deck", r["kind"] == "pptx" and r["text_layer"] == "text" and r["slide_count"] == 3 and r["image_only_slides"] == [], r)
    r = inspect_pptx(_fake_pptx([(long, 0), ("", 1), (long, 0), ("12", 2)]))
    ok("pptx: picture slides -> mixed, listed", r["text_layer"] == "mixed" and r["image_only_slides"] == [2, 4] and r["pictures_per_slide"] == [0, 1, 0, 2], r)
    r = inspect_pptx(_fake_pptx([("", 1)] * 10))
    ok("pptx: all pictures -> scanned, advice says do not type numbers", r["text_layer"] == "scanned" and "scanned" in r["advice"], r)
    r = inspect_pptx(_fake_pptx([(long, 0)] * 12 + [("", 1)]))
    ok("pptx: one image slide in 13 is still 'text' (<=10%) but the slide is listed", r["text_layer"] == "text" and r["image_only_slides"] == [13], r)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf: zf.writestr("xl/workbook.xml", "<workbook/>")
    buf.seek(0)
    r = inspect_pptx(buf)
    ok("xlsx is 'other', not pptx", r["kind"] == "other" and r["detail"] == "xlsx", r)
    ok("office_kind: docx / bare zip", office_kind(["word/document.xml"]) == "docx" and office_kind(["a.txt"]) == "zip")

    r = summarise("pdf", [900, 1200, 15, 800, 0, 700, 650, 900, 1000, 1100], {"looks_like": "slides"})
    ok("pdf summary: mixed with image pages 3 and 5", r["text_layer"] == "mixed" and r["image_only_slides"] == [3, 5], r)
    r = summarise("pdf", [2500] * 18, {"looks_like": "document"})
    ok("pdf summary: portrait text -> transcript hint", "transcript" in r["advice"], r)
    r = summarise("pdf", [], {"looks_like": None})
    ok("pdf summary: zero pages -> scanned/unusable", r["text_layer"] == "scanned" and r["slide_count"] == 0, r)

    d = tempfile.mkdtemp()
    p = os.path.join(d, "deck.pdf")
    with open(p, "wb") as f: f.write(b"<html><body>Access denied</body></html>")
    r = inspect(p)
    ok("an HTML error page saved as .pdf is 'other' and the extension mismatch is not hidden", r["kind"] == "other" and r["detail"] == "html" and r["extension_matches"] is None, r)
    p2 = os.path.join(d, "deck.pdf.pptx")
    with open(p2, "wb") as f: f.write(_fake_pptx([(long, 0)]).read())
    r = inspect(p2)
    ok("real pptx read from disk by magic bytes", r["kind"] == "pptx" and r["extension_matches"] is True, r)
    return checks


def main():
    ap = argparse.ArgumentParser(description="Detect what a deck/transcript file is: pdf/pptx/other, text vs scanned vs mixed, slide count.")
    ap.add_argument("file", nargs="?", help="path to the file in the sandbox")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files, no pdfplumber) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "detect_content_type.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    if not a.file:
        fail("give a file path, or --self-test")
    emit(inspect(a.file))


if __name__ == "__main__":
    main()
