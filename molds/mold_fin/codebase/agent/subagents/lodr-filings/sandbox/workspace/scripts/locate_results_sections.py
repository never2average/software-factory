#!/usr/bin/env python3
"""Find where each part of a Reg 33 / Reg 52 results filing sits: page ranges, basis, unit, and the image pages.

    python3 /workspace/scripts/locate_results_sections.py /workspace/in/results.pdf
    python3 /workspace/scripts/locate_results_sections.py --pages-json pages.json     ([{"page": 1, "text": "..."}, ...])

Sections: covering_letter, auditor_report, results, assets_liabilities, cash_flow, segment, notes, reg52_4_ratios,
security_cover, deviation_statement, related_party - each with basis (standalone | consolidated | both | unspecified)
and where the basis came from (heading | inherited | none).

How it decides (reference/results_section_headings.json holds the regexes):
- A heading counts only near the start of a line. Statement headings (results, assets and liabilities, cash flow,
  segment) count only on a page dense with numbers, because the auditor's report and the covering letter quote the
  statement titles in prose.
- The Reg 52(4) section needs the citation AND at least three ratio labels on the same page; a bare citation is
  listed under reg52_4_mentions.
- A section runs until the next heading. A repeated heading of the same section and basis on the next page is a
  continuation, not a new section.
- The unit of a section is read with finlib.units from the unit lines inside that section only. No unit line, or two
  different units, gives unit = null with unit_status saying which. It is never carried over from another section.
- Image pages are listed. A section that is expected but not found is reported as missing, with a warning when
  image pages exist, because it may sit on one of them.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re
from finlib import units, periods, pdfdoc

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(HERE, "reference", "results_section_headings.json")
IMAGE_PAGE_CHARS = 40
_NUM = re.compile(r"(?<![\w.])\(?-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\)?(?![\w])|(?<![\w.])\(?-?\d+\.\d{1,2}\)?(?![\w.])")
STATEMENTS = ("results", "assets_liabilities", "cash_flow", "segment")


def load_table(path=TABLE_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def numeric_tokens(text):
    return len(_NUM.findall(text or ""))


def _basis(text):
    s, c = re.search(r"stand-?\s?alone", text, re.I), re.search(r"consolidated", text, re.I)
    return "both" if s and c else "standalone" if s else "consolidated" if c else None


def locate(pages, table=None):
    """pages: [(page_no, text)] -> report dict."""
    table = table or load_table()
    min_num, min_ratio = table["min_numeric_tokens"], table["min_ratio_labels"]
    letter_re, unit_re = re.compile(table["letter_cues"], re.I), re.compile(table["unit_line"], re.I)
    ratio_res = [re.compile(x, re.I) for x in table["ratio_labels"]]
    info, flat = {}, []   # flat: (page, line_idx, line)
    for pno, text in pages:
        text = (text or "").replace("’", "'").replace("‘", "'")
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        info[pno] = {"chars": len(text.strip()), "scanned": len(text.strip()) < IMAGE_PAGE_CHARS, "numeric": numeric_tokens(text),
                     "letter": len(set(m.group(0).lower() for m in letter_re.finditer(text))) >= 2,
                     "ratio_labels": sum(1 for r in ratio_res if r.search(text))}
        flat += [(pno, i, l) for i, l in enumerate(lines)]
    scanned = [p for p, _ in pages if info[p]["scanned"]]
    hits, mentions = [], []
    for k, (pno, li, line) in enumerate(flat):
        nxt = [flat[j][2] for j in range(k + 1, min(k + 9, len(flat))) if flat[j][0] == pno]
        joined = line + " " + (nxt[0] if nxt else "")
        for h in table["headings"]:
            m = re.search(h["regex"], line, re.I)
            if not m:
                m = re.search(h["regex"], joined, re.I)
                if m and m.start() >= len(line):
                    m = None   # the match belongs to the next line; it will be seen there
            if not m or m.start() > h["max_offset"]:
                continue
            sec = h["section"]
            if h["needs_numbers"] and info[pno]["numeric"] < min_num:
                continue
            if sec in ("auditor_report", "reg52_4_ratios", "security_cover", "deviation_statement", "related_party") and info[pno]["letter"]:
                if sec == "reg52_4_ratios": mentions.append(pno)
                continue
            if sec == "reg52_4_ratios" and info[pno]["ratio_labels"] < min_ratio:
                mentions.append(pno); continue
            if sec == "notes" and len(line) > 80:
                continue
            window = " ".join([line] + nxt[: (8 if sec == "auditor_report" else 2)])
            hits.append({"section": sec, "page": pno, "line": li, "flat": k, "heading": joined[:200] if len(line) < 60 else line[:200],
                         "basis": _basis(window) if sec != "reg52_4_ratios" else None, "window": window})
            break
    # merge continuations and same-page duplicates
    merged = []
    for h in hits:
        prev = merged[-1] if merged else None
        if prev and prev["section"] == h["section"] and (h["basis"] in (None, prev["basis"])) and h["page"] - prev["last_heading_page"] <= 1:
            prev["last_heading_page"] = h["page"]; continue
        h["last_heading_page"] = h["page"]; merged.append(h)
    sections, current_basis = [], None
    first_page = pages[0][0] if pages else None
    last_page = pages[-1][0] if pages else None
    for i, h in enumerate(merged):
        nxt = merged[i + 1] if i + 1 < len(merged) else None
        end_flat = nxt["flat"] if nxt else len(flat)
        end_page = last_page if not nxt else (nxt["page"] - 1 if nxt["line"] <= 2 and nxt["page"] > h["page"] else nxt["page"])
        end_page = max(end_page, h["last_heading_page"])
        if h["basis"]:
            basis, src = h["basis"], "heading"
            if h["section"] in ("results", "auditor_report"): current_basis = h["basis"]
        elif current_basis and h["section"] in ("assets_liabilities", "cash_flow", "segment", "notes"):
            basis, src = current_basis, "inherited"
        else:
            basis, src = "unspecified", "none"
        found, evidence = [], []
        for pno, li, line in flat[h["flat"]:end_flat]:
            if unit_re.search(line):
                u = units.detect_unit(line)
                evidence.append({"page": pno, "line": line[:160], "unit": u})
                if u and u not in found: found.append(u)
                if u is None and "ambiguous" not in found: found.append("ambiguous")
        if len(found) == 1 and found[0] != "ambiguous": unit, ustatus = found[0], "ok"
        elif not found: unit, ustatus = None, "not_found"
        else: unit, ustatus = None, "conflicting"
        pg = [p for p, _ in pages if h["page"] <= p <= end_page]
        sec = {"section": h["section"], "basis": basis, "basis_source": src, "first_page": h["page"], "last_page": end_page,
               "pages": pg, "heading": h["heading"], "unit": unit, "unit_status": ustatus, "unit_evidence": evidence[:4],
               "scanned_pages_inside": [p for p in pg if info[p]["scanned"]]}
        if h["section"] == "results":
            per = periods.normalise(h["window"]); sec["period"] = per["period"] if per else None
        sections.append(sec)
    # covering letter / front matter: pages before the first heading
    first_heading_page = merged[0]["page"] if merged else (last_page + 1 if last_page is not None else None)
    front = [p for p, _ in pages if p < first_heading_page or (merged and p == first_heading_page and merged[0]["line"] > 2 and info[p]["letter"])]
    letter_pages = [p for p in front if info[p]["letter"]]
    if letter_pages:
        sections.insert(0, {"section": "covering_letter", "basis": None, "basis_source": "none", "first_page": letter_pages[0], "last_page": letter_pages[-1],
                            "pages": letter_pages, "heading": None, "unit": None, "unit_status": "not_applicable", "unit_evidence": [], "scanned_pages_inside": []})
    unassigned = [p for p in front if p not in letter_pages]
    res = [s for s in sections if s["section"] == "results"]
    filing_period = next((s["period"] for s in res if s.get("period")), None)
    bases = sorted({s["basis"] for s in res})
    report = {"page_count": len(pages), "text_layer": pdfdoc.classify_text_layer([info[p]["chars"] for p, _ in pages]),
              "scanned_pages": scanned, "filing_period": filing_period, "results_bases": bases,
              "single_basis_filing": bool(res) and not any(b in ("consolidated", "both") for b in bases),
              "sections": sections, "unassigned_front_pages": unassigned, "reg52_4_mentions": sorted(set(mentions)), "warnings": []}
    w = report["warnings"]
    if not res:
        w.append("no results statement found on a text page" + ("; the filing has image pages, it may be a scan" if scanned else ""))
    if filing_period:
        q = periods.normalise(filing_period)["quarter"]
        have = {s["section"] for s in sections}
        expected = ["assets_liabilities", "cash_flow"] if q in (2, 4) else []
        report["missing_expected"] = [x for x in expected if x not in have]
        report["absent_as_expected"] = [x for x in ("assets_liabilities", "cash_flow") if x not in have and q in (1, 3)]
        if report["missing_expected"]:
            w.append(f"{', '.join(report['missing_expected'])} expected in a {filing_period} filing (half-year and year-end) but not found"
                     + ("; check image pages " + str(scanned) if scanned else ""))
    else:
        w.append("filing period could not be read from a results heading; read it from the page and pass it on explicitly")
    if report["single_basis_filing"] and any(s["basis"] == "unspecified" for s in res):
        w.append("results heading names neither standalone nor consolidated and no consolidated statement was found: a single-basis filing. "
                 "Label it standalone only after confirming the company has no subsidiaries/consolidation in this filing, and say so.")
    for s in sections:
        if s["section"] in STATEMENTS and s["unit_status"] != "ok":
            w.append(f"{s['section']} ({s['basis']}) p.{s['first_page']}: unit {s['unit_status']}; read the unit from the page header before converting")
    if scanned:
        w.append(f"pages {scanned} are images; nothing on them was read")
    return report


# ---- synthetic pages for the self-test -------------------------------------------------------------------------
def _table_page(title, unit_line, rows=18, extra=""):
    body = "\n".join(f"{i} Line item {i} 1,23,4{i:02d}.50 1,10,2{i:02d}.25 98,7{i:02d}.10 2,33,6{i:02d}.75" for i in range(1, rows + 1))
    return f"Example Housing Finance Ltd\n{title}\n{unit_line}\nParticulars Quarter ended Half year ended Year ended\n{body}\n{extra}"

_LETTER = ("To, BSE Limited, Phiroze Jeejeebhoy Towers. Scrip Code: 500000\nDear Sir/Madam,\nSub: Outcome of Board Meeting\n"
           "Pursuant to Regulation 33 and Regulation 52(4) of the SEBI (LODR) Regulations, 2015 we enclose the Statement of Unaudited\n"
           "Standalone and Consolidated Financial Results for the quarter and half year ended September 30, 2025 along with the\n"
           "Limited Review Report thereon.\nYours faithfully")
_AUDIT_S = ("Independent Auditor's Review Report on the Quarterly and Year to Date Unaudited\nStandalone Financial Results of the Company\n"
            "To the Board of Directors of Example Housing Finance Ltd\nWe have reviewed the accompanying\n"
            "Statement of Unaudited Standalone Financial Results of Example Housing Finance Ltd for the quarter ended September 30, 2025")
_AUDIT_C = _AUDIT_S.replace("Standalone", "Consolidated")
_NOTES = ("Notes:\n1. The above results were reviewed by the Audit Committee.\n2. Disclosure pursuant to RBI Master Direction on Transfer of Loan Exposures.\n"
          "3. The disclosures under Regulation 52(4) are given in Annexure A.")
_RATIOS = ("Annexure A\nDisclosure pursuant to Regulation 52(4) of the SEBI (LODR) Regulations, 2015\nDebt-Equity Ratio 5.10\nNet worth (Rs. in Lakhs) 4,50,000.00\n"
           "Net profit after tax 21,000.00\nTotal debts to total assets 0.82\nGross Stage 3 1.10%\nCapital adequacy ratio 24.5%")


def _self_test():
    n = 0
    T = "Statement of Unaudited Standalone Financial Results for the quarter and half year ended September 30, 2025"
    # 1 classic order: letter, auditor S, results S, SAL S, CF S, notes, auditor C, results C ..., ratios; one image page
    pages = [(1, _LETTER), (2, _AUDIT_S), (3, ""), (4, _table_page(T, "(Rs. in Lakhs)")),
             (5, _table_page("Statement of Assets and Liabilities", "(Rs. in Lakhs)")), (6, _table_page("Statement of Cash Flows", "(Rs. in Lakhs)")),
             (7, _NOTES), (8, _AUDIT_C), (9, _table_page(T.replace("Standalone", "Consolidated"), "(Rs. in Crore)")),
             (10, _table_page("Consolidated Statement of Assets and Liabilities", "(Rs. in Crore)")), (11, _RATIOS)]
    r = locate(pages)
    got = [(s["section"], s["basis"], s["first_page"], s["last_page"]) for s in r["sections"]]
    want = [("covering_letter", None, 1, 1), ("auditor_report", "standalone", 2, 3), ("results", "standalone", 4, 4),
            ("assets_liabilities", "standalone", 5, 5), ("cash_flow", "standalone", 6, 6), ("notes", "standalone", 7, 7),
            ("auditor_report", "consolidated", 8, 8), ("results", "consolidated", 9, 9), ("assets_liabilities", "consolidated", 10, 10),
            ("reg52_4_ratios", "unspecified", 11, 11)]
    assert got == want, got; n += 1
    assert r["filing_period"] == "Q2 FY26" and r["scanned_pages"] == [3] and r["text_layer"] == "text"; n += 1   # 1 image page in 11 is still 'text', but it is listed
    by = {(s["section"], s["basis"]): s for s in r["sections"]}
    assert by[("results", "standalone")]["unit"] == "lakh" and by[("results", "consolidated")]["unit"] == "crore"; n += 1   # mixed units per basis
    assert by[("assets_liabilities", "standalone")]["basis_source"] == "inherited"; n += 1
    assert by[("auditor_report", "standalone")]["scanned_pages_inside"] == [3]; n += 1
    assert r["reg52_4_mentions"] == [1, 7] and r["missing_expected"] == [] and not r["single_basis_filing"]; n += 1
    # 2 the auditor's report quoting the statement title is NOT a results section (no numbers on that page)
    assert not any(s["section"] == "results" and s["first_page"] == 2 for s in r["sections"]); n += 1
    # 3 reverse order (consolidated first, auditor's reports after), Q1: no SAL / cash flow expected; notes on the results page
    T1 = "Statement of Consolidated Unaudited Financial Results for the quarter ended June 30, 2025"
    pages = [(1, _LETTER), (2, _table_page(T1, "(₹ in crore)", extra=_NOTES)), (3, _table_page(T1.replace("Consolidated", "Standalone"), "(₹ in crore)")),
             (4, _NOTES), (5, _AUDIT_C), (6, _AUDIT_S)]
    r = locate(pages)
    got = [(s["section"], s["basis"], s["first_page"], s["last_page"]) for s in r["sections"]]
    assert got == [("covering_letter", None, 1, 1), ("results", "consolidated", 2, 2), ("notes", "consolidated", 2, 2), ("results", "standalone", 3, 3),
                   ("notes", "standalone", 4, 4), ("auditor_report", "consolidated", 5, 5), ("auditor_report", "standalone", 6, 6)], got; n += 1
    assert r["filing_period"] == "Q1 FY26" and r["absent_as_expected"] == ["assets_liabilities", "cash_flow"] and r["missing_expected"] == []; n += 1
    # 4 single-basis debt-listed filing, results run over two pages with the title repeated, conflicting unit lines
    T2 = "Statement of Audited Financial Results for the quarter and year ended March 31, 2026"
    pages = [(1, _table_page(T2, "(Rs. in Lakhs)")), (2, _table_page(T2 + " (continued)", "(Rs. in Millions)")), (3, _NOTES)]
    r = locate(pages)
    res = [s for s in r["sections"] if s["section"] == "results"]
    assert len(res) == 1 and res[0]["pages"] == [1, 2] and res[0]["basis"] == "unspecified" and r["single_basis_filing"]; n += 1
    assert res[0]["unit"] is None and res[0]["unit_status"] == "conflicting"; n += 1
    assert r["filing_period"] == "Q4 FY26" and r["missing_expected"] == ["assets_liabilities", "cash_flow"]; n += 1
    assert any("single-basis" in w for w in r["warnings"]); n += 1
    # 5 fully scanned file: no sections, says so, never an empty success
    r = locate([(1, ""), (2, "  "), (3, "12")])
    assert r["sections"] == [] and r["text_layer"] == "scanned" and r["scanned_pages"] == [1, 2, 3] and any("scan" in w for w in r["warnings"]); n += 1
    # 6 side-by-side standalone and consolidated in one table; unit line missing
    r = locate([(1, _table_page("Statement of Standalone and Consolidated Unaudited Financial Results for the quarter ended December 31, 2025", ""))])
    assert r["sections"][0]["basis"] == "both" and r["sections"][0]["unit_status"] == "not_found" and r["filing_period"] == "Q3 FY26"; n += 1
    # 7 heading split over two lines
    r = locate([(1, _table_page("Statement of Unaudited Standalone Financial\nResults for the quarter and nine months ended December 31, 2025", "(Rs. in Lakhs)"))])
    assert r["sections"][0]["section"] == "results" and r["sections"][0]["basis"] == "standalone" and r["filing_period"] == "Q3 FY26", r["sections"]; n += 1
    assert numeric_tokens("1,23,456.78 (1,234.50) 12.5 2025 30.09.2025 3") == 3; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Locate the sections of a Reg 33 / Reg 52 results filing: page ranges, basis, unit, image pages.")
    ap.add_argument("pdf", nargs="?"); ap.add_argument("--pages-json", help='JSON file: [{"page": 1, "text": "..."}, ...] instead of a PDF')
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL locate_results_sections: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "locate_results_sections", "cases": n})); return 0
    if a.pages_json:
        try:
            with open(a.pages_json, encoding="utf-8") as f:
                pages = [(int(p["page"]), p.get("text") or "") for p in json.load(f)]
        except (OSError, ValueError, KeyError, TypeError) as x:
            print(f"cannot read --pages-json: {x}", file=sys.stderr); return 2
    elif a.pdf:
        if not os.path.isfile(a.pdf):
            print(f"no such file: {a.pdf}", file=sys.stderr); return 2
        if pdfdoc.sniff(a.pdf) != "pdf":
            print(f"{a.pdf} is not a PDF (run detect_content_type.py on it)", file=sys.stderr); return 2
        try:
            pages = pdfdoc.page_texts(a.pdf)
        except ImportError:
            print("pdfplumber is not installed in this sandbox", file=sys.stderr); return 3
    else:
        print("give a PDF path, --pages-json or --self-test", file=sys.stderr); return 2
    report = locate(pages)
    report["file"] = a.pdf or a.pages_json
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
