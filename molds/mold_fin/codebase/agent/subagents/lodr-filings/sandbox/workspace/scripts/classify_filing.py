#!/usr/bin/env python3
"""Classify a LODR filing under exactly one regulation tag, from its covering letter or its subject line.

    python3 /workspace/scripts/classify_filing.py --pdf /workspace/in/filing.pdf [--pages 2] [--listing equity|debt]
    python3 /workspace/scripts/classify_filing.py --subject "Outcome of Board Meeting - Financial Results ..." --listing equity
    python3 /workspace/scripts/classify_filing.py --text-file first_pages.txt        (or text on stdin)

Output: tag, confidence (matched | ambiguous | none), the evidence (every regulation citation and subject cue that
matched, with the matched text), also_covers (tags absorbed into the chosen one) and notes. `ambiguous` and `none`
return tag = null: the script reports, it does not guess. The rules, in order:

  1. The letter's own regulation citations win over subject-line cues ("trust the letter").
  2. A number followed by the name of another SEBI regulation set (insider trading, takeovers, ...) is not a LODR citation.
  3. A prior intimation of a board meeting (Reg 29/50 cited, intimation wording, no outcome wording) is reg29_notice
     even though it mentions the results the meeting will consider.
  4. A newspaper publication (Reg 47 or 52(8) cited, newspaper wording, no outcome wording) is `other`.
  5. A results tag with results wording absorbs what travels with results: the Reg 30/51 carrier, the statement of
     deviation (Reg 32 / 52(7)), the security cover certificate (Reg 54), the half-yearly RPT disclosure (Reg 23(9)).
  6. Reg 33 and Reg 52 both cited: the entity has listed equity, so reg33_results (reg52 goes to also_covers),
     unless --listing debt was given, which contradicts the letter and is reported as ambiguous.
  7. Reg 30/51 are carriers: cited together with exactly one specific regulation whose wording is also present, the
     specific one wins. Without the wording it is ambiguous.
  8. Anything still plural is ambiguous. No citation and no cue is none.

The tables live in reference/filing_tag_patterns.json.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re
from finlib import pdfdoc
from filing_name import TAGS

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(HERE, "reference", "filing_tag_patterns.json")

_HEAD = re.compile(r"\breg(?:ulation|n)?s?\.?\s*(?:no\.?\s*)?(?=\d)", re.I)
_TOKEN = re.compile(r"(\d{1,3})(?!\d)([A-Za-z](?![A-Za-z]))?((?:\s*\(\s*[0-9A-Za-z]{1,3}\s*\))*)")
_SEP = re.compile(r"\s*(?:,|;|and|&|/|read (?:together )?with|r/w)\s*(?:reg(?:ulation|n)?s?\.?\s*)?(?=\d)", re.I)


def load_table(path=TABLE_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean(text):
    t = (text or "").replace("’", "'").replace("‘", "'").replace("–", "-").replace("—", "-").replace(" ", " ")
    return " ".join(t.split())


def parse_citations(text, table):
    """Every 'Regulation N[(x)]' in the text -> [{regulation, subclause, match, tag|None, note}]."""
    out, foreign = [], table["foreign_regulation_context"]
    for h in _HEAD.finditer(text):
        pos, group = h.end(), []
        while True:
            m = _TOKEN.match(text, pos)
            if not m:
                break
            num, letter, sub = m.group(1), (m.group(2) or "").upper(), re.sub(r"\s+", "", m.group(3) or "")
            if not letter and num == "24" and sub.upper().startswith("(A)"):
                letter, sub = "A", sub[3:]
            group.append({"regulation": num + letter, "subclause": sub.lower(), "match": clean(text[h.start():m.end()]) if not group else m.group(0).strip()})
            pos = m.end()
            s = _SEP.match(text, pos)
            if not s:
                break
            pos = s.end()
        tail = text[pos:pos + foreign["window_chars"]]
        # the LODR name in the tail protects against a later mention of another regulation set in the same sentence
        lodr_at = re.search(r"listing obligations|\blodr\b|listing regulations", tail, re.I)
        other_at = re.search(foreign["regex"], tail, re.I)
        is_foreign = bool(other_at) and not (lodr_at and lodr_at.start() < other_at.start())
        for c in group:
            c["tag"], c["note"] = None, None
            if is_foreign:
                c["note"] = "cited under another SEBI regulation set, not LODR: '" + other_at.group(0) + "'"
            else:
                c["tag"], c["note"] = _map_regulation(c["regulation"], c["subclause"], table)
            out.append(c)
    return out


def _map_regulation(reg, sub, table):
    for o in table["subclause_overrides"]:
        if o["regulation"] == reg and re.search(o["subclause_regex"], sub, re.I):
            return o["tag"], o["why"]
    if reg in table["regulation_to_tag"]:
        return table["regulation_to_tag"][reg], None
    base = re.sub(r"[A-Z]$", "", reg)
    if base in table["known_other_regulations"]:
        return "other", "Reg " + reg + " is commonly: " + table["known_other_regulations"][base]
    return "other", "Reg " + reg + " is not in the tag table"


def find_cues(text, table):
    hits = []
    for c in table["subject_cues"] + table["other_cues"]:
        m = re.search(c["regex"], text, re.I)
        if m:
            hits.append({"id": c["id"], "tag": c.get("tag", "other" if c["id"].startswith("other.") else None),
                         "tag_group": c.get("tag_group"), "match": m.group(0)[:160]})
    return hits


def classify(text, listing=None, table=None):
    table = table or load_table()
    t = clean(text)
    cites, cues = parse_citations(t, table), find_cues(t, table)
    notes, also = [], []
    res_tags, carriers, bundle = table["results_tags"], table["carrier_tags"], table["results_bundle_tags"]
    group_pairs = {"results": res_tags, "event": carriers}
    cue_ids = {c["id"] for c in cues}
    has = lambda prefix: any(i.startswith(prefix) for i in cue_ids)
    carries_doc = any(i in cue_ids for i in table["carries_document_cues"])
    cited = []
    for c in cites:
        if c["tag"] and c["tag"] != "other" and c["tag"] not in cited:
            cited.append(c["tag"])
    cited_other = [c for c in cites if c["tag"] == "other"]
    for c in cites:
        if c["tag"] is None:
            notes.append(f"Regulation {c['regulation']}{c['subclause']}: {c['note']}")

    def cue_tags():
        out = []
        for c in cues:
            if c["tag"] and c["tag"] != "other":
                cand = [c["tag"]]
            elif c["tag_group"]:
                pair = group_pairs[c["tag_group"]]
                in_cited = [x for x in pair if x in cited]
                cand = in_cited or ([pair[0]] if listing == "equity" else [pair[1]] if listing == "debt" else list(pair))
            else:
                cand = []
            out += [x for x in cand if x not in out]
        return out

    def result(tag, confidence, basis, candidates):
        return {"tag": tag, "confidence": confidence, "basis": basis, "candidates": candidates, "also_covers": also,
                "listing": listing, "evidence": {"citations": cites, "cues": cues}, "notes": notes}

    # rule 4: newspaper publication
    paper = [c for c in cues if c["id"] == "other.newspaper"]
    if paper:
        need = table["other_cues"][0]["requires_regulation"]
        cited_keys = {c["regulation"] + c["subclause"] for c in cites} | {c["regulation"] for c in cites}
        if any(k in cited_keys for k in need):
            if carries_doc:
                notes.append("newspaper-publication wording and outcome/review-report wording are both present")
                return result(None, "ambiguous", "citation_and_cue", ["other"] + [x for x in cited if x in res_tags])
            notes.append("other: " + table["other_cues"][0]["what"])
            return result("other", "matched", "citation_and_cue", ["other"])

    # rule 2: the letter cites only another SEBI regulation set (takeovers, insider trading, ...): not a LODR tag
    foreign_only = [c for c in cites if c["tag"] is None]
    if foreign_only and not cited and not cited_other:
        notes.append("other: the letter cites only a non-LODR regulation set; say which in the log row's title and summary")
        return result("other", "matched", "citation", ["other"])

    ctags = cue_tags()
    # rule 3: prior intimation of a board meeting
    if "reg29.prior_intimation" in cue_ids and ("reg29_notice" in cited or not cited):
        if carries_doc or "event.outcome_generic" in cue_ids:
            notes.append("both prior-intimation and outcome wording are present")
            return result(None, "ambiguous", "citation_and_cue" if cited else "subject_cue_only",
                          ["reg29_notice"] + [x for x in (cited or ctags) if x != "reg29_notice"])
        dropped = [x for x in (cited or ctags) if x != "reg29_notice"]
        if dropped:
            notes.append("prior intimation of a board meeting: it mentions " + ", ".join(dropped) + " business but does not carry it")
        return result("reg29_notice", "matched", "citation_and_cue" if "reg29_notice" in cited else "subject_cue_only", ["reg29_notice"])

    basis = "citation" if cited else "subject_cue_only"
    cand = list(cited) if cited else list(ctags)
    if cited:
        uncited = [x for x in ctags if x not in cited]
        if uncited:
            notes.append("wording also suggests " + ", ".join(uncited) + ", which the letter does not cite; the letter's citation is kept")
        if any(x in ctags for x in cited):
            basis = "citation_and_cue"
    if not cand:
        if cited_other:
            notes += ["other: " + c["note"] for c in cited_other]
            return result("other", "matched", "citation", ["other"])
        return result(None, "none", "nothing_matched", [])

    # rule 6: Reg 33 and Reg 52 together
    if all(x in cand for x in res_tags):
        if cited and listing == "debt":
            notes.append("the letter cites Regulation 33, which applies to listed equity, but --listing debt was given; check the company record")
            return result(None, "ambiguous", basis, cand)
        if cited:
            cand.remove("reg52_results"); also.append("reg52_results")
            notes.append("Reg 33 and Reg 52 both cited: equity-listed entity with listed debt; the Reg 52(4) line items are appended to the Reg 33 results")
    # rule 5: results bundle
    res_in = [x for x in cand if x in res_tags]
    if res_in and has("results."):
        for x in list(cand):
            if x in bundle or x in carriers:
                cand.remove(x); also.append(x)
    # both carriers cited
    if all(x in cand for x in carriers) and cited:
        if listing == "debt":
            notes.append("the letter cites Regulation 30, which applies to listed equity, but --listing debt was given; check the company record")
            return result(None, "ambiguous", basis, cand)
        cand.remove("reg51_event"); also.append("reg51_event")
    # rule 7: carriers give way to one specific regulation whose wording is present
    specific = [x for x in cand if x not in carriers]
    if specific and len(specific) < len(cand):
        if len(specific) == 1 and specific[0] in ctags:
            for x in [y for y in cand if y in carriers]:
                cand.remove(x); also.append(x)
        elif not cited:
            # cue-only: a specific cue (e.g. credit rating review) beside a generic event cue
            for x in [y for y in cand if y in carriers]:
                cand.remove(x)
    if len(cand) == 1:
        if cited_other:
            notes += ["also cited: " + c["note"] for c in cited_other]
        if basis == "subject_cue_only":
            notes.append("no regulation citation found; tag rests on the subject wording only. Check the covering letter if there is one.")
        return result(cand[0], "matched", basis, cand)
    if not cited and listing is None and (set(cand) == set(res_tags) or set(cand) == set(carriers)):
        notes.append("the wording fits both the equity (Chapter IV) and the debt (Chapter V) tag; pass --listing from the company record")
    return result(None, "ambiguous", basis, cand)


def _self_test():
    table = load_table(); n = 0
    for c in table["subject_cues"] + table["other_cues"]:
        re.compile(c["regex"]); assert c.get("tag") in TAGS or c.get("tag_group") in ("results", "event") or c["id"].startswith("other."), c
    assert set(table["regulation_to_tag"].values()) <= set(TAGS); n += 2

    def chk(text, tag, conf, listing=None, also=None, cand=None):
        r = classify(text, listing, table)
        assert (r["tag"], r["confidence"]) == (tag, conf), (text[:70], r["tag"], r["confidence"], r["candidates"], r["notes"])
        if also is not None: assert sorted(r["also_covers"]) == sorted(also), (text[:70], r["also_covers"])
        if cand is not None: assert sorted(r["candidates"]) == sorted(cand), (text[:70], r["candidates"])
        return r
    L = "of the SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015"
    # 1 outcome letter citing 30 and 33 -> results, carrier absorbed
    chk(f"Sub: Outcome of Board Meeting held on October 24, 2025. Pursuant to Regulation 30 and 33 {L}, the Board approved the "
        "Unaudited Standalone and Consolidated Financial Results for the quarter and half year ended September 30, 2025 "
        "along with the Limited Review Report.", "reg33_results", "matched", also=["reg30_event"]); n += 1
    # 2 equity + listed debt: 30, 33, 52, 52(4), 52(7), 54 -> reg33, everything else absorbed
    r = chk(f"Pursuant to Regulations 30, 33, 52 and 54 {L} we enclose the audited financial results for the year ended March 31, 2026, "
            "the disclosures under Regulation 52(4), the statement of deviation under Regulation 52(7) and the security cover certificate.",
            "reg33_results", "matched", also=["reg30_event", "reg52_results", "reg32_deviation", "reg54_security_cover"]); n += 1
    assert any(c["regulation"] == "52" and c["subclause"] == "(7)" and c["tag"] == "reg32_deviation" for c in r["evidence"]["citations"]); n += 1
    # 3 debt-listed results
    chk(f"Outcome of the Board Meeting: pursuant to Regulation 51 read with Regulation 52 {L}, unaudited financial results for the "
        "quarter ended December 31, 2025", "reg52_results", "matched", listing="debt", also=["reg51_event"]); n += 1
    # 4 letter says 33 but the record says debt-listed -> reported, not guessed
    chk(f"Pursuant to Regulation 33 and Regulation 52 {L}: financial results for the quarter ended June 30, 2025", None, "ambiguous", listing="debt"); n += 1
    # 5 prior intimation that mentions results
    chk(f"Intimation of Board Meeting pursuant to Regulation 29 {L} to consider the unaudited financial results for the quarter ended "
        "September 30, 2025", "reg29_notice", "matched"); n += 1
    chk(f"Prior intimation of Board Meeting under Regulation 50 {L} to consider issuance of non-convertible debentures", "reg29_notice", "matched"); n += 1
    # 6 subject line only, no citation: results wording cannot choose the chapter without the listing
    chk("Unaudited Financial Results for the quarter ended June 30, 2025", None, "ambiguous", cand=["reg33_results", "reg52_results"]); n += 1
    chk("Unaudited Financial Results for the quarter ended June 30, 2025", "reg52_results", "matched", listing="debt"); n += 1
    # 7 rating: the letter's citation wins over the wording
    r = chk(f"Pursuant to Regulation 30 {L}, we inform that ICRA has reaffirmed the credit rating of the Company's NCDs with a stable outlook.",
            "reg30_event", "matched"); n += 1
    assert any("does not cite" in x for x in r["notes"]); n += 1
    chk(f"Pursuant to Regulation 51 and Regulation 55 {L}: credit rating reviewed and reaffirmed by CRISIL", "reg55_rating", "matched", also=["reg51_event"]); n += 1
    # 8 carrier plus a specific regulation WITHOUT its wording -> ambiguous
    chk(f"Pursuant to Regulation 30 and Regulation 31 {L}, please find enclosed the disclosure.", None, "ambiguous", cand=["reg30_event", "reg31_shareholding"]); n += 1
    # 9 two specific regulations -> ambiguous
    chk(f"Pursuant to Regulation 27 and Regulation 31 {L} we enclose the corporate governance report and the shareholding pattern", None, "ambiguous"); n += 1
    # 10 others
    chk(f"Shareholding Pattern under Regulation 31(1)(b) {L} for the quarter ended September 30, 2025", "reg31_shareholding", "matched"); n += 1
    chk(f"Disclosure of Related Party Transactions under Regulation 23(9) {L} for the half year ended March 31, 2026", "reg23_rpt", "matched"); n += 1
    chk(f"Annual Secretarial Compliance Report under Regulation 24(A) {L}", "reg24a_secretarial", "matched"); n += 1
    chk(f"Annual Secretarial Compliance Report under Regulation 24A {L}", "reg24a_secretarial", "matched"); n += 1
    chk(f"Intimation under Regulation 57(1) {L}: payment of interest and principal on NCDs", "reg57_payment", "matched"); n += 1
    chk(f"Annual Report for the Financial Year 2025-26 under Regulation 34(1) {L}", "reg34_annual_report", "matched"); n += 1
    chk(f"Statement of deviation or variation under Regulation 32 {L}", "reg32_deviation", "matched"); n += 1
    chk(f"Statement under Regulation 52(7) and 52(7A) {L}: utilisation of issue proceeds", "reg32_deviation", "matched"); n += 1
    # 11 newspaper publication cites 47 and 33 but is not the results filing
    chk(f"Newspaper Publication of Financial Results pursuant to Regulation 47 read with Regulation 33 {L} for the quarter ended June 30, 2025", "other", "matched"); n += 1
    # 12 another regulation set: not LODR
    r = chk("Disclosure under Regulation 29(2) of SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011", "other", "matched"); n += 1
    assert "not LODR" in r["notes"][0]; n += 1
    chk("Closure of trading window under Regulation 9 of SEBI (Prohibition of Insider Trading) Regulations, 2015", "other", "matched"); n += 1
    # 13 only an unmapped LODR regulation
    r = chk(f"Voting results of the Annual General Meeting under Regulation 44 {L}", "other", "matched"); n += 1
    assert "voting results" in r["notes"][0]; n += 1
    # 14 'Regulations, 2015' is never read as Regulation 2015; nothing at all -> none
    assert parse_citations(clean("as per the Regulations 2015 and Regulations, 2015"), table) == []; n += 1
    chk("Dear Sir, please find enclosed the document for your records.", None, "none"); n += 1
    # 15 cue-only event with listing
    chk("Allotment of Non-Convertible Debentures on private placement basis", "reg51_event", "matched", listing="debt"); n += 1
    chk("Schedule of Analyst / Institutional Investor Meet", "reg30_event", "matched", listing="equity"); n += 1
    # 16 line-wrapped letter text (whitespace collapsed before matching)
    chk("Pursuant to Regulation\n33 of the SEBI (LODR) Regulations, 2015, we enclose the Audited Financial\nResults for the quarter and year\nended March 31, 2026",
        "reg33_results", "matched"); n += 1
    # 17 the skill's reference table names every cue id (checked only where the repo layout is present)
    md = os.path.join(HERE, "..", "..", "..", "skills", "classify-a-filing", "references", "tag-regex-table.md")
    if os.path.isfile(md):
        doc = open(md, encoding="utf-8").read()
        missing = [c["id"] for c in table["subject_cues"] + table["other_cues"] if c["id"] not in doc]
        assert not missing, f"cue ids not documented in tag-regex-table.md: {missing}"; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Classify a LODR filing under one regulation tag from its covering letter or subject line.")
    ap.add_argument("--pdf", help="read the first pages of this PDF"); ap.add_argument("--pages", type=int, default=2, help="how many leading pages to read (default 2)")
    ap.add_argument("--text-file", help="text of the first pages; '-' or nothing reads stdin")
    ap.add_argument("--subject", help="the exchange announcement's subject line")
    ap.add_argument("--listing", choices=["equity", "debt"], help="from the company record: equity-listed (Chapter IV) or debt-listed (Chapter V)")
    ap.add_argument("--print-table", action="store_true", help="print the regex/regulation table and exit")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL classify_filing: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "classify_filing", "cases": n})); return 0
    if a.print_table:
        print(json.dumps(load_table(), indent=2, ensure_ascii=False)); return 0
    parts, scanned = [], None
    if a.subject:
        parts.append(a.subject)
    if a.pdf:
        if not os.path.isfile(a.pdf):
            print(f"no such file: {a.pdf}", file=sys.stderr); return 2
        try:
            texts = pdfdoc.page_texts(a.pdf, 1, a.pages)
        except ImportError:
            print("pdfplumber is not installed in this sandbox", file=sys.stderr); return 3
        scanned = [p for p, t in texts if len(t.strip()) < 40]
        parts += [t for _, t in texts]
    if a.text_file and a.text_file != "-":
        with open(a.text_file, encoding="utf-8") as f:
            parts.append(f.read())
    elif not a.pdf and not a.subject or a.text_file == "-":
        parts.append(sys.stdin.read())
    text = "\n".join(parts)
    if not text.strip():
        msg = "no text to classify"
        if scanned:
            msg += f": pages {scanned} of the PDF are images; classify from the exchange's subject line with --subject"
        print(msg, file=sys.stderr); return 2
    out = classify(text, a.listing)
    if scanned:
        out["scanned_pages"] = scanned
        out["notes"].append(f"pages {scanned} are images and were not read")
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
