"""PDF content-type detection and page text access. pdfplumber/pypdf are imported lazily so every other
finlib module (and --self-test) runs without them."""
import re

def sniff(path):
    """File kind from magic bytes, not the extension: pdf | zip-office (xlsx/pptx/docx) | html | text | unknown."""
    with open(path, "rb") as f: head = f.read(1024)
    if head.startswith(b"%PDF"): return "pdf"
    if head.startswith(b"PK\x03\x04"): return "zip-office"
    low = head.lstrip().lower()
    if low.startswith(b"<!doctype html") or low.startswith(b"<html"): return "html"
    try: head.decode("utf-8"); return "text"
    except UnicodeDecodeError: return "unknown"

def classify_text_layer(chars_per_page):
    """'text' | 'scanned' | 'mixed' from the number of extractable characters on each page.
    A page with < 40 characters is an image page. scanned: >= 90% image pages; text: <= 10%."""
    if not chars_per_page: return "scanned"
    img = sum(1 for c in chars_per_page if c < 40) / len(chars_per_page)
    return "scanned" if img >= 0.9 else "text" if img <= 0.1 else "mixed"

def page_texts(path, first=None, last=None):
    """[(pdf_page_index_1_based, text)] using pdfplumber."""
    import pdfplumber
    out = []
    with pdfplumber.open(path) as pdf:
        for i, p in enumerate(pdf.pages, 1):
            if first and i < first: continue
            if last and i > last: break
            out.append((i, p.extract_text() or ""))
    return out

def find_pages(texts, patterns):
    """{pattern: [page, ...]} for case-insensitive regex patterns over [(page, text)]."""
    return {p: [n for n, t in texts if re.search(p, t, re.I)] for p in patterns}

def outline(path):
    """[(level, title, pdf_page_1_based)] from the PDF bookmarks, [] when the file has none."""
    from pypdf import PdfReader
    r = PdfReader(path); out = []
    def walk(items, lvl):
        for it in items:
            if isinstance(it, list): walk(it, lvl + 1)
            else:
                try: out.append((lvl, str(it.title).strip(), r.get_destination_page_number(it) + 1))
                except Exception: pass
    try: walk(r.outline, 1)
    except Exception: return []
    return out

def _self_test():
    import os, tempfile
    d = tempfile.mkdtemp()
    for name, data, want in [("a", b"%PDF-1.7\n", "pdf"), ("b", b"PK\x03\x04xx", "zip-office"), ("c", b"  <!DOCTYPE html><html>", "html"),
                             ("d", "plain ₹ text".encode(), "text"), ("e", b"\xff\xfe\x00\x81\x82", "unknown")]:
        p = os.path.join(d, name); open(p, "wb").write(data); assert sniff(p) == want, (name, sniff(p))
    assert classify_text_layer([0, 3, 10]) == "scanned" and classify_text_layer([900, 1200, 800]) == "text"
    assert classify_text_layer([900, 0, 800, 5]) == "mixed" and classify_text_layer([]) == "scanned"
    assert find_pages([(1, "Statement of Standalone Financial Results"), (2, "Notes")], [r"standalone .* results"]) == {r"standalone .* results": [1]}
    return 10
