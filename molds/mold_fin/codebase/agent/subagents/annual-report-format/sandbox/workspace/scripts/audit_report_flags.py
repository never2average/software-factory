#!/usr/bin/env python3
"""First pass over an independent auditor's report: which opinion headings it carries, and which CARO clauses need reading.

This script does not decide that a remark is adverse. It sorts the text so the agent reads the right paragraphs:
  opinion       unmodified | qualified | adverse | disclaimer | undetermined   (from the report's own headings)
  headings      key audit matters, emphasis of matter, material uncertainty related to going concern, other matter
  caro_clauses  each numbered clause with 'read_this' (a trigger word without a plain negation, or an 'except' /
                'however' / 'other than') or 'clean_wording' ("has not defaulted", "no fraud ... noticed")
  ifc           unmodified | flagged | undetermined   (internal financial controls opinion)
Every flag carries the sentence that caused it, to be quoted with its page. Anything 'undetermined' is read by eye.

Input: a text file of the auditor's report pages (or - for stdin). Give standalone and consolidated reports separately.
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C

OPINION_HEADINGS = [("qualified", r"^(basis for )?qualified opinion$"), ("adverse", r"^(basis for )?adverse opinion$"),
                    ("disclaimer", r"^(basis for )?disclaimer of opinion$"), ("unmodified", r"^(basis for )?opinion$")]
HEADINGS = {"key_audit_matters": r"^key audit matters?$", "emphasis_of_matter": r"^emphasis of matters?( paragraphs?)?$",
            "material_uncertainty_going_concern": r"^material uncertainty relat(ed|ing) to going concern$",
            "other_matter": r"^other matters?( paragraphs?)?$"}
TRIGGERS = [r"\bfrauds?\b", r"\bdefault(s|ed)?\b", r"\bdelay(s|ed)?\b", r"not (been )?(regularly )?deposited", r"\barrears\b", r"\bdisputes?d?\b",
            r"\bcash loss(es)?\b", r"material uncertainty", r"\bunspent\b", r"whistle[- ]?blower", r"short[- ]term basis.{0,80}long[- ]term",
            r"\bqualifications?\b|\badverse remarks?\b", r"\bdiscrepanc(y|ies)\b", r"not in agreement", r"wilful defaulter", r"\bresign(ed|ation)\b",
            r"\bprejudicial\b", r"\boverdue\b", r"(unrecorded|undisclosed) income", r"\bbenami\b", r"material weakness(es)?"]
NEGATORS = r"\b(no|not|nil|none|neither|nor|without)\b|does not arise|not applicable"
HEDGES = r"\bexcept\b|\bhowever\b|\bother than\b|\bsubject to\b|\bsave (as|for)\b|\bas (given|stated|detailed|mentioned) (below|in the table)"
_CLAUSE = re.compile(r"^\s*\(?((?:x{0,2})(?:ix|iv|v?i{1,3}|v|x))\)\s*(?:\(([a-z])\))?\s*", re.I)


def _lines(text):
    return [C.clean(l) for l in (text or "").splitlines() if C.clean(l)]


def _heading(line):
    return re.sub(r"^[\d.()a-z]{0,4}\s*", "", line.lower()) if re.match(r"^\(?[\da-z]{1,2}[.)]\s", line.lower()) else line.lower()


def opinion_of(text):
    found = {}
    for l in _lines(text):
        if len(l) > 60:
            continue
        for kind, pat in OPINION_HEADINGS:
            if re.match(pat, _heading(l).rstrip(":")):
                found.setdefault(kind, l)
    modified = [k for k in ("adverse", "disclaimer", "qualified") if k in found]
    if len(modified) == 1:
        return modified[0], found
    if len(modified) > 1:
        return "undetermined", found
    return ("unmodified" if "unmodified" in found else "undetermined"), found


def headings_of(text):
    out = {k: False for k in HEADINGS}
    for l in _lines(text):
        if len(l) <= 70:
            for k, pat in HEADINGS.items():
                if re.match(pat, _heading(l).rstrip(":")):
                    out[k] = True
    return out


def _sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.;])\s+(?=[A-Z(])", C.clean(text)) if s.strip()]


def judge(text):
    """-> ('read_this'|'clean_wording'|'no_trigger', [sentences])"""
    reasons = []
    for s in _sentences(text):
        hedge = re.search(HEDGES, s, re.I)
        trig = [p for p in TRIGGERS if re.search(p, s, re.I)]
        if hedge or (trig and not re.search(NEGATORS, s, re.I)):
            reasons.append(s)
    if reasons:
        return "read_this", reasons
    if any(re.search(p, text, re.I) for p in TRIGGERS):
        return "clean_wording", []
    return "no_trigger", []


def caro_clauses(text):
    clauses, cur = [], None
    for l in _lines(text):
        m = _CLAUSE.match(l)
        n = C.roman_to_int(m.group(1)) if m else None
        if m and n and 1 <= n <= 21 and (cur is None or n >= cur["number"]):
            if cur is None or n != cur["number"] or (m.group(2) or "") != cur["sub"]:
                cur = {"number": n, "clause": f"({m.group(1).lower()})" + (f"({m.group(2).lower()})" if m.group(2) else ""),
                       "sub": m.group(2) or "", "text": l[m.end():]}
                clauses.append(cur); continue
        if cur is not None:
            cur["text"] += " " + l
    out = []
    for c in clauses:
        flag, why = judge(c["text"])
        out.append({"clause": c["clause"], "flag": flag, "sentences": why, "text": c["text"][:600]})
    return out


def ifc_of(text):
    t = C.clean(text).lower()
    if "internal financial control" not in t:
        return "undetermined"
    if re.search(r"material weakness|qualified opinion|adverse opinion|disclaimer of opinion", t):
        return "flagged"
    if re.search(r"adequate internal financial controls", t) and re.search(r"operating effectively", t):
        return "unmodified"
    return "undetermined"


def analyse(text, basis=None):
    if len(C.clean(text)) < 200:
        return None, "fewer than 200 characters of text: if these pages are scanned say so (detect_content_type.py), do not report a clean audit opinion from an empty extract"
    opinion, evidence = opinion_of(text)
    clauses = caro_clauses(text)
    return {"basis": basis, "opinion": opinion, "opinion_headings_found": evidence, "headings": headings_of(text),
            "ifc": ifc_of(text), "caro_clauses_found": len(clauses),
            "caro_read_these": [c for c in clauses if c["flag"] == "read_this"],
            "caro_clean_wording": [c["clause"] for c in clauses if c["flag"] != "read_this"],
            "say": "Quote each read_this sentence with its printed and PDF page and state what it says; a flag is a reading list, not a finding. "
                   "Where opinion or ifc is undetermined, read the opinion paragraph and report its wording."}, None


CLEAN = """Independent Auditor's Report
To the Members of Example Housing Finance Ltd
Report on the Audit of the Standalone Financial Statements
Opinion
We have audited the accompanying standalone financial statements of Example Housing Finance Ltd which comprise the balance sheet as at March 31, 2026.
In our opinion the aforesaid standalone financial statements give a true and fair view in conformity with the Indian Accounting Standards.
Basis for Opinion
We conducted our audit in accordance with the Standards on Auditing.
Key Audit Matters
Impairment of loans - expected credit loss. The Company recognises expected credit losses on its loan portfolio using staging and management overlays.
Annexure A to the Independent Auditor's Report
(i) (a) The Company has maintained proper records showing full particulars of property, plant and equipment.
(ii) The Company does not hold any inventory. Accordingly, clause 3(ii) is not applicable.
(vii) (a) The Company is generally regular in depositing undisputed statutory dues. No undisputed amounts were in arrears as at March 31, 2026 for a period of more than six months.
(vii) (b) There are no statutory dues which have not been deposited on account of any dispute, except as given below: Income tax, Rs. 1.20 crore, assessment year 2021-22, Commissioner (Appeals).
(ix) (a) The Company has not defaulted in repayment of loans or borrowings to any lender.
(xi) (a) No fraud by the Company and no material fraud on the Company has been noticed or reported during the year, other than 3 instances of fraud by borrowers aggregating Rs. 0.85 crore reported to the regulator.
(xvii) The Company has not incurred cash losses in the financial year and in the immediately preceding financial year.
Annexure B
Report on the Internal Financial Controls with reference to financial statements
In our opinion, the Company has, in all material respects, adequate internal financial controls with reference to financial statements and such controls were operating effectively as at March 31, 2026.
"""


def _cases():
    def clean_report():
        r, err = analyse(CLEAN, "standalone")
        assert err is None and r["opinion"] == "unmodified" and r["ifc"] == "unmodified", r
        assert r["headings"] == {"key_audit_matters": True, "emphasis_of_matter": False, "material_uncertainty_going_concern": False, "other_matter": False}
        flagged = [c["clause"] for c in r["caro_read_these"]]
        assert flagged == ["(vii)(b)", "(xi)(a)"], flagged                     # 'except as given below' and 'other than 3 instances'
        assert "(ix)(a)" in r["caro_clean_wording"] and "(xvii)" in r["caro_clean_wording"]
        assert r["caro_clauses_found"] == 7

    def qualified_report():
        text = CLEAN.replace("\nOpinion\n", "\nQualified Opinion\n").replace("Basis for Opinion", "Basis for Qualified Opinion") \
                    .replace("Key Audit Matters\n", "Emphasis of Matter\nWe draw attention to Note 48.\nMaterial Uncertainty Related to Going Concern\nx\nKey Audit Matters\n")
        r, _ = analyse(text)
        assert r["opinion"] == "qualified" and r["headings"]["emphasis_of_matter"] and r["headings"]["material_uncertainty_going_concern"]

    def default_is_flagged():
        flag, why = judge("The Company has defaulted in repayment of interest to a debenture holder; the delay was 12 days.")
        assert flag == "read_this" and len(why) == 1
        assert judge("The Company has not defaulted in repayment of loans.")[0] == "clean_wording"
        assert judge("The Company has maintained proper records.")[0] == "no_trigger"

    def ifc_flag_and_undetermined():
        assert ifc_of("Report on the internal financial controls. A material weakness has been identified in the loan origination process.") == "flagged"
        assert ifc_of("Internal financial controls were tested.") == "undetermined" and ifc_of("nothing here") == "undetermined"

    def conflicting_headings_and_empty_text():
        r, _ = analyse(CLEAN + "\nAdverse Opinion\n" + "\nQualified Opinion\n")
        assert r["opinion"] == "undetermined"
        r, err = analyse("   \n")
        assert r is None and "scanned" in err
        r, _ = analyse("x " * 200)
        assert r["opinion"] == "undetermined" and r["caro_clauses_found"] == 0

    return [("unmodified report with two CARO clauses to read", clean_report), ("qualified opinion, emphasis of matter, going concern", qualified_report),
            ("plain negation is clean wording, a default is flagged", default_is_flagged), ("IFC opinion", ifc_flag_and_undetermined),
            ("conflicting headings and empty text", conflicting_headings_and_empty_text)]


def main():
    ap = argparse.ArgumentParser(description="Sort an auditor's report into opinion headings and the CARO clauses that need reading. A reading list, not a verdict.",
                                 epilog="Example: audit_report_flags.py /workspace/out/standalone-auditors-report.txt --basis standalone")
    ap.add_argument("text", nargs="?", help="text file of the auditor's report pages, or - for stdin")
    ap.add_argument("--basis", choices=["standalone", "consolidated"], help="which auditor's report this is")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.text:
        C.die("give the text file, or - for stdin")
    if args.text != "-" and not os.path.exists(args.text):
        C.die(f"no such file: {args.text}")
    text = sys.stdin.read() if args.text == "-" else open(args.text, encoding="utf-8", errors="replace").read()
    result, err = analyse(text, args.basis)
    if err:
        C.die(err, C.EXIT_CHECK_FAILED)
    C.emit(result)


if __name__ == "__main__":
    main()
